/**
 * Adaptive Rate Budget Manager
 *
 * Distributes Hyperliquid API request budget across consumers
 * with priority: user on-demand > polling > backfill.
 *
 * Targets 80% utilization (960 out of 1200 req/min) to leave
 * headroom for bursts while maximizing backfill throughput.
 */

import { logger } from './logger.js';

const MAX_PER_MINUTE = 1200;
const TARGET_UTILIZATION = 0.80;
const TARGET_PER_MINUTE = Math.floor(MAX_PER_MINUTE * TARGET_UTILIZATION); // 960
const REQUESTS_PER_BACKFILL_WORKER = 120; // ~2 req/chunk, 1s delay, 60 chunks/min
const MIN_BACKFILL_WORKERS = 1;
const MAX_BACKFILL_WORKERS = 10;
const WINDOW_MS = 60_000;

export type RequestPriority = 'user' | 'polling' | 'backfill';

interface WindowStats {
  user: number;
  polling: number;
  backfill: number;
}

class RateBudgetManager {
  private windowStart = Date.now();
  private stats: WindowStats = { user: 0, polling: 0, backfill: 0 };
  private previousWindow: WindowStats = { user: 0, polling: 0, backfill: 0 };

  /**
   * Record a request. Returns true if within budget, false if should throttle.
   */
  record(priority: RequestPriority): boolean {
    this.rollWindowIfNeeded();
    const total = this.stats.user + this.stats.polling + this.stats.backfill;

    if (priority === 'user') {
      // Users always get through (up to hard limit)
      if (total < MAX_PER_MINUTE) {
        this.stats.user++;
        return true;
      }
      return false;
    }

    if (priority === 'polling') {
      // Polling gets through up to target
      if (total < TARGET_PER_MINUTE) {
        this.stats.polling++;
        return true;
      }
      return false;
    }

    // Backfill: fill remaining budget up to target
    const userAndPolling = this.stats.user + this.stats.polling;
    if (total < TARGET_PER_MINUTE && (total - userAndPolling) < this.getBackfillBudget()) {
      this.stats.backfill++;
      return true;
    }
    return false;
  }

  /**
   * How many backfill req/min are available to hit the 80% target.
   */
  getBackfillBudget(): number {
    const window = this.getCurrentOrPreviousStats();
    const nonBackfill = window.user + window.polling;
    return Math.max(0, TARGET_PER_MINUTE - nonBackfill);
  }

  /**
   * Recommended number of concurrent backfill workers.
   */
  getRecommendedWorkers(): number {
    const budget = this.getBackfillBudget();
    const workers = Math.floor(budget / REQUESTS_PER_BACKFILL_WORKER);
    return Math.max(MIN_BACKFILL_WORKERS, Math.min(MAX_BACKFILL_WORKERS, workers));
  }

  /**
   * Current window utilization percentage.
   */
  getUtilization(): number {
    const window = this.getCurrentOrPreviousStats();
    const total = window.user + window.polling + window.backfill;
    return total / MAX_PER_MINUTE;
  }

  /**
   * Get stats for monitoring/dashboard.
   */
  getStats() {
    const window = this.getCurrentOrPreviousStats();
    const total = window.user + window.polling + window.backfill;
    return {
      windowReqPerMin: total,
      utilization: Math.round((total / MAX_PER_MINUTE) * 100),
      target: TARGET_PER_MINUTE,
      max: MAX_PER_MINUTE,
      breakdown: { ...window },
      recommendedWorkers: this.getRecommendedWorkers(),
      backfillBudget: this.getBackfillBudget(),
    };
  }

  private getCurrentOrPreviousStats(): WindowStats {
    this.rollWindowIfNeeded();
    const total = this.stats.user + this.stats.polling + this.stats.backfill;
    // If current window is young (<10s), use previous for better estimate
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
          utilization: `${Math.round((total / MAX_PER_MINUTE) * 100)}%`,
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
