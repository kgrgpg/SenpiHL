/**
 * Auto-Subscribe Job
 * 
 * Processes the trader discovery queue and automatically subscribes to new traders.
 * Runs periodically to pick up traders discovered via market trade watching.
 * 
 * Configuration:
 * - MAX_SUBSCRIPTIONS_PER_RUN: Limit how many to subscribe at once
 * - MIN_PRIORITY: Only process traders above this priority
 * - AUTO_BACKFILL_DAYS: How many days to backfill for new traders
 */

import { query } from '../storage/db/client.js';
import { hyperliquidClient } from '../hyperliquid/client.js';
import { logger } from '../utils/logger.js';

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

/**
 * Process the discovery queue and subscribe to new traders
 */
export async function processDiscoveryQueue(): Promise<{
  processed: number;
  subscribed: number;
  skipped: number;
}> {
  const stats = { processed: 0, subscribed: 0, skipped: 0 };

  try {
    // Get pending traders from queue
    const result = await query<QueuedTrader>(
      `SELECT id, address, source, priority, notes
       FROM trader_discovery_queue
       WHERE processed_at IS NULL
         AND priority >= $1
       ORDER BY priority DESC, discovered_at ASC
       LIMIT $2`,
      [MIN_PRIORITY, MAX_SUBSCRIPTIONS_PER_RUN]
    );

    if (result.rows.length === 0) {
      logger.debug('No traders in discovery queue');
      return stats;
    }

    logger.info({ count: result.rows.length }, 'Processing discovery queue');

    for (const trader of result.rows) {
      stats.processed++;

      try {
        // Check if address is valid
        if (!hyperliquidClient.isValidAddress(trader.address)) {
          logger.warn({ address: trader.address }, 'Invalid address in queue, skipping');
          await markProcessed(trader.id, 'invalid_address');
          stats.skipped++;
          continue;
        }

        // Check if already subscribed
        const existing = await query(
          'SELECT id FROM traders WHERE address = $1',
          [trader.address.toLowerCase()]
        );

        if (existing.rows.length > 0) {
          logger.debug({ address: trader.address }, 'Trader already subscribed');
          await markProcessed(trader.id, 'already_subscribed');
          stats.skipped++;
          continue;
        }

        // Subscribe the trader
        await subscribeTrader(trader);
        await markProcessed(trader.id, 'subscribed');
        stats.subscribed++;

        logger.info(
          { address: trader.address.slice(0, 10) + '...', source: trader.source },
          'Auto-subscribed discovered trader'
        );

        // Small delay between subscriptions
        await sleep(500);
      } catch (err) {
        logger.error(
          { error: (err as Error).message, address: trader.address },
          'Failed to process discovered trader'
        );
        stats.skipped++;
      }
    }

    logger.info(stats, 'Discovery queue processing complete');
    return stats;
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'Failed to process discovery queue');
    throw err;
  }
}

/**
 * Subscribe a trader from the discovery queue
 */
async function subscribeTrader(trader: QueuedTrader): Promise<void> {
  // Insert into traders table
  await query(
    `INSERT INTO traders (address, discovery_source, is_active)
     VALUES ($1, $2, true)
     ON CONFLICT (address) DO UPDATE SET is_active = true`,
    [trader.address.toLowerCase(), trader.source]
  );

  // The main data pipeline will pick up this trader on next poll cycle
  // For now, we just ensure they're in the database
}

/**
 * Mark a queue item as processed
 */
async function markProcessed(id: number, result: string): Promise<void> {
  await query(
    `UPDATE trader_discovery_queue
     SET processed_at = NOW(), notes = COALESCE(notes, '') || ' [Result: ' || $2 || ']'
     WHERE id = $1`,
    [id, result]
  );
}

/**
 * Get queue statistics
 */
export async function getQueueStats(): Promise<{
  pending: number;
  processedToday: number;
  totalDiscovered: number;
}> {
  const pending = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM trader_discovery_queue WHERE processed_at IS NULL'
  );

  const processedToday = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM trader_discovery_queue 
     WHERE processed_at >= NOW() - INTERVAL '24 hours'`
  );

  const total = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM trader_discovery_queue'
  );

  return {
    pending: parseInt(pending.rows[0]?.count || '0'),
    processedToday: parseInt(processedToday.rows[0]?.count || '0'),
    totalDiscovered: parseInt(total.rows[0]?.count || '0'),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start periodic processing of the discovery queue
 */
export function startAutoSubscribeJob(intervalMs: number = 60000): ReturnType<typeof setInterval> {
  logger.info({ intervalMs }, 'Starting auto-subscribe job');

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
