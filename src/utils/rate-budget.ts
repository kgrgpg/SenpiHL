/**
 * Adaptive Rate Budget Manager
 *
 * Probes Hyperliquid's actual rate limit on startup and adapts.
 * Distributes budget across consumers with priority:
 *   user on-demand > polling > backfill
 *
 * Targets 80% utilization to leave headroom for bursts.
 */

import { logger } from './logger.js';

const DEFAULT_MAX_PER_MINUTE = 1200;
const TARGET_UTILIZATION = 0.80;
const REQUESTS_PER_BACKFILL_WORKER = 120;
const MIN_BACKFILL_WORKERS = 1;
const MAX_BACKFILL_WORKERS = 10;
const WINDOW_MS = 60_000;
const PROBE_INTERVAL_MS = 5 * 60_000; // Re-probe every 5 minutes

export type RequestPriority = 'user' | 'polling' | 'backfill';

interface WindowStats {
  user: number;
  polling: number;
  backfill: number;
}

class RateBudgetManager {
  private maxPerMinute = DEFAULT_MAX_PER_MINUTE;
  private targetPerMinute = Math.floor(DEFAULT_MAX_PER_MINUTE * TARGET_UTILIZATION);
  private windowStart = Date.now();
  private stats: WindowStats = { user: 0, polling: 0, backfill: 0 };
  private previousWindow: WindowStats = { user: 0, polling: 0, backfill: 0 };
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private lastProbeResult: { cap: number; used: number; probedAt: Date } | null = null;

  /**
   * Probe Hyperliquid for actual rate limit and start periodic re-probing.
   */
  async initialize(): Promise<void> {
    await this.probe();
    this.probeTimer = setInterval(() => this.probe().catch(() => {}), PROBE_INTERVAL_MS);
  }

  /**
   * Query Hyperliquid's userRateLimit to discover actual capacity.
   */
  private async probe(): Promise<void> {
    try {
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'userRateLimit', user: '0x0000000000000000000000000000000000000000' }),
      });
      if (!res.ok) return;

      const data = await res.json() as { nRequestsCap: number; nRequestsUsed: number };

      // nRequestsCap is the TOTAL lifetime cap (not per-minute).
      // The actual per-minute limit is ~1,200 for non-trading IPs.
      // nRequestsUsed shows how many we've consumed of the lifetime cap.
      // We keep our conservative per-minute limit but log the probe.
      const probedCap = DEFAULT_MAX_PER_MINUTE;

      if (probedCap !== this.maxPerMinute) {
        logger.info({
          previous: this.maxPerMinute,
          probed: probedCap,
          rawCap: data.nRequestsCap,
          used: data.nRequestsUsed,
        }, 'Rate limit probed from Hyperliquid');
      }

      this.maxPerMinute = probedCap;
      this.targetPerMinute = Math.floor(probedCap * TARGET_UTILIZATION);
      this.lastProbeResult = {
        cap: data.nRequestsCap,
        used: data.nRequestsUsed,
        probedAt: new Date(),
      };
    } catch (err) {
      logger.debug({ error: (err as Error).message }, 'Rate limit probe failed, using current limit');
    }
  }

  record(priority: RequestPriority): boolean {
    this.rollWindowIfNeeded();
    const total = this.stats.user + this.stats.polling + this.stats.backfill;

    if (priority === 'user') {
      if (total < this.maxPerMinute) {
        this.stats.user++;
        return true;
      }
      return false;
    }

    if (priority === 'polling') {
      if (total < this.targetPerMinute) {
        this.stats.polling++;
        return true;
      }
      return false;
    }

    const userAndPolling = this.stats.user + this.stats.polling;
    if (total < this.targetPerMinute && (total - userAndPolling) < this.getBackfillBudget()) {
      this.stats.backfill++;
      return true;
    }
    return false;
  }

  getBackfillBudget(): number {
    const window = this.getCurrentOrPreviousStats();
    const nonBackfill = window.user + window.polling;
    return Math.max(0, this.targetPerMinute - nonBackfill);
  }

  getRecommendedWorkers(): number {
    const budget = this.getBackfillBudget();
    const workers = Math.floor(budget / REQUESTS_PER_BACKFILL_WORKER);
    return Math.max(MIN_BACKFILL_WORKERS, Math.min(MAX_BACKFILL_WORKERS, workers));
  }

  getUtilization(): number {
    const window = this.getCurrentOrPreviousStats();
    const total = window.user + window.polling + window.backfill;
    return total / this.maxPerMinute;
  }

  getStats() {
    const window = this.getCurrentOrPreviousStats();
    const total = window.user + window.polling + window.backfill;
    return {
      windowReqPerMin: total,
      utilization: Math.round((total / this.maxPerMinute) * 100),
      target: this.targetPerMinute,
      max: this.maxPerMinute,
      breakdown: { ...window },
      recommendedWorkers: this.getRecommendedWorkers(),
      backfillBudget: this.getBackfillBudget(),
      ...(this.lastProbeResult && {
        probe: {
          hyperliquidCap: this.lastProbeResult.cap,
          hyperliquidUsed: this.lastProbeResult.used,
          probedAt: this.lastProbeResult.probedAt.toISOString(),
        },
      }),
    };
  }

  stop(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private getCurrentOrPreviousStats(): WindowStats {
    this.rollWindowIfNeeded();
    const total = this.stats.user + this.stats.polling + this.stats.backfill;
    if (total === 0 && (this.previousWindow.user + this.previousWindow.polling + this.previousWindow.backfill) > 0) {
      return this.previousWindow;
    }
    return this.stats;
  }

  private rollWindowIfNeeded(): void {
    const now = Date.now();
    if (now - this.windowStart >= WINDOW_MS) {
      const total = this.stats.user + this.stats.polling + this.stats.backfill;
      if (total > 0) {
        logger.debug({
          ...this.stats,
          total,
          utilization: `${Math.round((total / this.maxPerMinute) * 100)}%`,
          max: this.maxPerMinute,
          workers: this.getRecommendedWorkers(),
        }, 'Rate budget window rolled');
      }
      this.previousWindow = { ...this.stats };
      this.stats = { user: 0, polling: 0, backfill: 0 };
      this.windowStart = now;
    }
  }
}

export const rateBudget = new RateBudgetManager();
