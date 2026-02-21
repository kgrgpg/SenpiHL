/**
 * Weight-Based Rate Budget Manager
 *
 * Hyperliquid rate limits are WEIGHT-based, not request-count.
 * Budget: 1,200 weight per minute per IP.
 *
 * Endpoint weights (from official docs):
 *   clearinghouseState: 2
 *   allMids: 2
 *   userFillsByTime: 20 (+ 1 per 20 items returned)
 *   userFunding: 20 (+ 1 per 20 items returned)
 *   portfolio: 20
 *   recentTrades: 20 (+ 1 per 20 items returned)
 *   userRole: 60
 *
 * Distributes budget with priority: user > polling > backfill.
 * Targets 80% utilization (960 weight/min).
 */

import { logger } from './logger.js';

const MAX_WEIGHT_PER_MINUTE = 1200;
const TARGET_UTILIZATION = 0.80;
const TARGET_WEIGHT = Math.floor(MAX_WEIGHT_PER_MINUTE * TARGET_UTILIZATION); // 960
const WEIGHT_PER_BACKFILL_CHUNK = 40; // fills(20) + funding(20) per day-chunk
const MIN_BACKFILL_WORKERS = 1;
const MAX_BACKFILL_WORKERS = 5;
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
   * Record weight consumed. Returns true if within budget.
   * Non-user priorities are throttled when over target.
   */
  record(priority: RequestPriority, weight: number = 20): boolean {
    this.rollWindowIfNeeded();
    const total = this.stats.user + this.stats.polling + this.stats.backfill;

    if (priority === 'user') {
      if (total + weight <= MAX_WEIGHT_PER_MINUTE) {
        this.stats.user += weight;
        return true;
      }
      return false;
    }

    if (priority === 'polling') {
      if (total + weight <= TARGET_WEIGHT) {
        this.stats.polling += weight;
        return true;
      }
      return false;
    }

    // Backfill: fills remaining budget up to target
    if (total + weight <= TARGET_WEIGHT) {
      this.stats.backfill += weight;
      return true;
    }
    return false;
  }

  getBackfillBudget(): number {
    const window = this.getCurrentOrPreviousStats();
    const nonBackfill = window.user + window.polling;
    return Math.max(0, TARGET_WEIGHT - nonBackfill);
  }

  getRecommendedWorkers(): number {
    const budget = this.getBackfillBudget();
    const workers = Math.floor(budget / WEIGHT_PER_BACKFILL_CHUNK);
    return Math.max(MIN_BACKFILL_WORKERS, Math.min(MAX_BACKFILL_WORKERS, workers));
  }

  getStats() {
    const window = this.getCurrentOrPreviousStats();
    const total = window.user + window.polling + window.backfill;
    return {
      weightPerMin: total,
      utilization: Math.round((total / MAX_WEIGHT_PER_MINUTE) * 100),
      target: TARGET_WEIGHT,
      max: MAX_WEIGHT_PER_MINUTE,
      breakdown: { ...window },
      recommendedWorkers: this.getRecommendedWorkers(),
      backfillBudget: this.getBackfillBudget(),
      unit: 'weight',
    };
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
          utilization: `${Math.round((total / MAX_WEIGHT_PER_MINUTE) * 100)}%`,
        }, 'Rate budget window (weight)');
      }
      this.previousWindow = { ...this.stats };
      this.stats = { user: 0, polling: 0, backfill: 0 };
      this.windowStart = now;
    }
  }
}

export const rateBudget = new RateBudgetManager();
