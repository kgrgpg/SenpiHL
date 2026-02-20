/**
 * Auto-Subscribe Job
 *
 * Processes the trader discovery queue and automatically subscribes to new traders.
 * Runs periodically to pick up traders discovered via market trade watching.
 *
 * Uses RxJS patterns throughout for consistency with the rest of the codebase.
 *
 * Configuration:
 * - MAX_SUBSCRIPTIONS_PER_RUN: Limit how many to subscribe at once
 * - MIN_PRIORITY: Only process traders above this priority
 */

import { Observable, from, of, EMPTY, timer } from 'rxjs';
import {
  mergeMap,
  map,
  catchError,
  tap,
  reduce,
  concatMap,
  filter,
  delay,
} from 'rxjs/operators';

import { query } from '../storage/db/client.js';
import { hyperliquidClient } from '../hyperliquid/client.js';
import { logger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import { getHybridDataStream } from '../streams/sources/hybrid.stream.js';
import { initializeTraderState } from '../state/trader-state.js';
import { scheduleBackfill } from './backfill.js';

const MAX_SUBSCRIPTIONS_PER_RUN = 10;
const MIN_PRIORITY = 0;
const AUTO_BACKFILL_DAYS = 7; // Shorter backfill for auto-discovered traders

interface QueuedTrader {
  id: number;
  address: string;
  source: string;
  priority: number;
  notes: string | null;
}

interface ProcessStats {
  processed: number;
  subscribed: number;
  skipped: number;
}

/**
 * Fetch pending traders from the queue (returns Observable)
 */
function fetchPendingTraders$(): Observable<QueuedTrader[]> {
  return from(
    query<QueuedTrader>(
      `SELECT id, address, source, priority, notes
       FROM trader_discovery_queue
       WHERE processed_at IS NULL
         AND priority >= $1
       ORDER BY priority DESC, discovered_at ASC
       LIMIT $2`,
      [MIN_PRIORITY, MAX_SUBSCRIPTIONS_PER_RUN]
    )
  ).pipe(map((result) => result.rows));
}

/**
 * Mark a queue item as processed (returns Observable)
 */
function markProcessed$(id: number, result: string): Observable<void> {
  return from(
    query(
      `UPDATE trader_discovery_queue
       SET processed_at = NOW(), notes = COALESCE(notes, '') || ' [Result: ' || $2 || ']'
       WHERE id = $1`,
      [id, result]
    )
  ).pipe(map(() => void 0));
}

/**
 * Check if trader already exists (returns Observable)
 */
function traderExists$(address: string): Observable<boolean> {
  return from(
    query('SELECT id FROM traders WHERE address = $1', [address.toLowerCase()])
  ).pipe(map((result) => result.rows.length > 0));
}

/**
 * Subscribe a trader (returns Observable)
 */
function subscribeTrader$(trader: QueuedTrader): Observable<void> {
  return from(
    query<{ id: number }>(
      `INSERT INTO traders (address, discovery_source, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (address) DO UPDATE SET is_active = true
       RETURNING id`,
      [trader.address.toLowerCase(), trader.source]
    )
  ).pipe(
    mergeMap((result) => {
      const traderId = result.rows[0]?.id;
      if (!traderId) {
        logger.warn({ address: trader.address }, 'Failed to get trader ID after insert');
        return of(void 0);
      }

      // Initialize trader state
      initializeTraderState(traderId, trader.address.toLowerCase());

      // Subscribe to hybrid stream if in hybrid mode
      if (config.USE_HYBRID_MODE) {
        const hybridStream = getHybridDataStream();
        hybridStream.subscribeTrader(trader.address.toLowerCase());
      }

      // Schedule backfill for historical data (7 days for auto-discovered)
      return from(scheduleBackfill(trader.address.toLowerCase(), AUTO_BACKFILL_DAYS)).pipe(
        tap((job) =>
          logger.info(
            { address: trader.address, jobId: job.id, days: AUTO_BACKFILL_DAYS },
            'Backfill scheduled for auto-discovered trader'
          )
        ),
        map(() => void 0),
        catchError((err) => {
          logger.error(
            { error: (err as Error).message, address: trader.address },
            'Failed to schedule backfill'
          );
          return of(void 0);
        })
      );
    })
  );
}

/**
 * Process a single trader from the queue (returns Observable with stats)
 */
function processTrader$(trader: QueuedTrader): Observable<ProcessStats> {
  // Validate address
  if (!hyperliquidClient.isValidAddress(trader.address)) {
    logger.warn({ address: trader.address }, 'Invalid address in queue, skipping');
    return markProcessed$(trader.id, 'invalid_address').pipe(
      map(() => ({ processed: 1, subscribed: 0, skipped: 1 }))
    );
  }

  // Check if already subscribed
  return traderExists$(trader.address).pipe(
    mergeMap((exists) => {
      if (exists) {
        logger.debug({ address: trader.address }, 'Trader already subscribed');
        return markProcessed$(trader.id, 'already_subscribed').pipe(
          map(() => ({ processed: 1, subscribed: 0, skipped: 1 }))
        );
      }

      // Subscribe the trader
      return subscribeTrader$(trader).pipe(
        mergeMap(() => markProcessed$(trader.id, 'subscribed')),
        tap(() =>
          logger.info(
            { address: trader.address.slice(0, 10) + '...', source: trader.source },
            'Auto-subscribed discovered trader'
          )
        ),
        map(() => ({ processed: 1, subscribed: 1, skipped: 0 }))
      );
    }),
    catchError((err) => {
      logger.error(
        { error: (err as Error).message, address: trader.address },
        'Failed to process discovered trader'
      );
      return of({ processed: 1, subscribed: 0, skipped: 1 });
    })
  );
}

/**
 * Process the discovery queue (RxJS Observable-based)
 * This is the main entry point - returns an Observable
 */
export function processDiscoveryQueue$(): Observable<ProcessStats> {
  return fetchPendingTraders$().pipe(
    mergeMap((traders) => {
      if (traders.length === 0) {
        logger.debug('No traders in discovery queue');
        return of({ processed: 0, subscribed: 0, skipped: 0 });
      }

      logger.info({ count: traders.length }, 'Processing discovery queue');

      // Process traders sequentially with delay between each
      return from(traders).pipe(
        concatMap((trader) =>
          processTrader$(trader).pipe(
            delay(500) // Small delay between subscriptions
          )
        ),
        // Aggregate stats
        reduce(
          (acc, stats) => ({
            processed: acc.processed + stats.processed,
            subscribed: acc.subscribed + stats.subscribed,
            skipped: acc.skipped + stats.skipped,
          }),
          { processed: 0, subscribed: 0, skipped: 0 }
        )
      );
    }),
    catchError((err) => {
      logger.error({ error: (err as Error).message }, 'Failed to process discovery queue');
      return of({ processed: 0, subscribed: 0, skipped: 0 });
    })
  );
}

/**
 * Process the discovery queue (Promise-based wrapper for backwards compatibility)
 * @deprecated Use processDiscoveryQueue$() for reactive code
 */
export async function processDiscoveryQueue(): Promise<ProcessStats> {
  const { firstValueFrom } = await import('rxjs');
  return firstValueFrom(processDiscoveryQueue$());
}

/**
 * Get queue statistics (returns Observable)
 */
export function getQueueStats$(): Observable<{
  pending: number;
  processedToday: number;
  totalDiscovered: number;
}> {
  return from(
    Promise.all([
      query<{ count: string }>(
        'SELECT COUNT(*) as count FROM trader_discovery_queue WHERE processed_at IS NULL'
      ),
      query<{ count: string }>(
        `SELECT COUNT(*) as count FROM trader_discovery_queue 
         WHERE processed_at >= NOW() - INTERVAL '24 hours'`
      ),
      query<{ count: string }>('SELECT COUNT(*) as count FROM trader_discovery_queue'),
    ])
  ).pipe(
    map(([pending, processedToday, total]) => ({
      pending: parseInt(pending.rows[0]?.count || '0'),
      processedToday: parseInt(processedToday.rows[0]?.count || '0'),
      totalDiscovered: parseInt(total.rows[0]?.count || '0'),
    }))
  );
}

/**
 * Get queue statistics (Promise-based wrapper)
 * @deprecated Use getQueueStats$() for reactive code
 */
export async function getQueueStats(): Promise<{
  pending: number;
  processedToday: number;
  totalDiscovered: number;
}> {
  const { firstValueFrom } = await import('rxjs');
  return firstValueFrom(getQueueStats$());
}

/**
 * Start periodic processing of the discovery queue
 * @deprecated The main index.ts now uses RxJS interval directly
 */
export function startAutoSubscribeJob(intervalMs: number = 60000): ReturnType<typeof setInterval> {
  logger.info({ intervalMs }, 'Starting auto-subscribe job (legacy setInterval)');

  // Run immediately
  processDiscoveryQueue().catch((err) => {
    logger.error({ error: err.message }, 'Auto-subscribe job failed');
  });

  // Then run periodically
  return setInterval(() => {
    processDiscoveryQueue().catch((err) => {
      logger.error({ error: err.message }, 'Auto-subscribe job failed');
    });
  }, intervalMs);
}
