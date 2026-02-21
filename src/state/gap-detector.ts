/**
 * Data Gap Detector
 *
 * Detects and records gaps in snapshot coverage for each trader.
 *
 * On startup:
 *   - For each tracked trader, checks if there's a gap between their last
 *     snapshot and now (i.e., the node was down).
 *   - Records the gap in the `data_gaps` table.
 *
 * At runtime:
 *   - Called after each snapshot poll cycle to check for failed/skipped traders.
 *   - On successful snapshot, closes any open gap for that trader.
 *
 * This data is exposed in API responses so consumers know exactly
 * which time periods have incomplete data.
 */

import { from, EMPTY } from 'rxjs';
import { mergeMap, catchError, toArray, tap } from 'rxjs/operators';

import { query } from '../storage/db/client.js';
import { logger } from '../utils/logger.js';

const EXPECTED_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const GAP_THRESHOLD_MS = EXPECTED_SNAPSHOT_INTERVAL_MS * 2; // 10 min = gap

export interface DetectedGap {
  traderId: number;
  address: string;
  gapStart: Date;
  gapEnd: Date;
  gapType: 'snapshots';
  durationMinutes: number;
}

/**
 * Run on startup: detect gaps from the time each trader's last snapshot
 * was taken until now. If the gap exceeds the threshold, record it.
 */
export async function detectStartupGaps(): Promise<DetectedGap[]> {
  const now = new Date();

  const result = await query<{
    trader_id: number;
    address: string;
    last_ts: Date;
  }>(
    `SELECT
       ps.trader_id,
       t.address,
       MAX(ps.timestamp) as last_ts
     FROM pnl_snapshots ps
     JOIN traders t ON t.id = ps.trader_id
     WHERE t.is_active = true
     GROUP BY ps.trader_id, t.address`
  );

  const gaps: DetectedGap[] = [];

  for (const row of result.rows) {
    const lastSnapshot = new Date(row.last_ts);
    const gapMs = now.getTime() - lastSnapshot.getTime();

    if (gapMs > GAP_THRESHOLD_MS) {
      gaps.push({
        traderId: row.trader_id,
        address: row.address,
        gapStart: lastSnapshot,
        gapEnd: now,
        gapType: 'snapshots',
        durationMinutes: Math.round(gapMs / 60_000),
      });
    }
  }

  if (gaps.length > 0) {
    // Persist gaps to DB
    await from(gaps).pipe(
      mergeMap((gap) =>
        from(query(
          `INSERT INTO data_gaps (trader_id, gap_start, gap_end, gap_type)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [gap.traderId, gap.gapStart, gap.gapEnd, gap.gapType]
        )).pipe(
          catchError((err) => {
            logger.warn({ err: (err as Error).message, traderId: gap.traderId },
              'Failed to insert data gap');
            return EMPTY;
          })
        ),
        10
      ),
      toArray()
    ).toPromise();

    logger.warn(
      { count: gaps.length, avgMinutes: Math.round(gaps.reduce((s, g) => s + g.durationMinutes, 0) / gaps.length) },
      'Detected snapshot gaps on startup (node was down)'
    );
  } else {
    logger.info('No snapshot gaps detected on startup');
  }

  return gaps;
}

/**
 * Close an open gap for a trader (called after successful snapshot).
 */
export async function resolveGaps(traderId: number): Promise<void> {
  await query(
    `UPDATE data_gaps SET resolved_at = NOW()
     WHERE trader_id = $1 AND resolved_at IS NULL`,
    [traderId]
  );
}

/**
 * Record a new gap for a trader (called when snapshot fails at runtime).
 */
export async function recordGap(traderId: number, gapStart: Date, gapEnd: Date): Promise<void> {
  await query(
    `INSERT INTO data_gaps (trader_id, gap_start, gap_end, gap_type)
     VALUES ($1, $2, $3, 'snapshots')`,
    [traderId, gapStart, gapEnd]
  );
}

/**
 * Get unresolved gaps for a trader within a time range.
 */
export async function getGapsForTrader(
  traderId: number,
  from: Date,
  to: Date
): Promise<Array<{ gap_start: string; gap_end: string; gap_type: string }>> {
  const result = await query<{ gap_start: string; gap_end: string; gap_type: string }>(
    `SELECT gap_start, gap_end, gap_type FROM data_gaps
     WHERE trader_id = $1 AND gap_start <= $3 AND gap_end >= $2
     ORDER BY gap_start`,
    [traderId, from, to]
  );
  return result.rows;
}

/**
 * Get gap summary for the status endpoint.
 */
export async function getGapStats(): Promise<{
  totalUnresolved: number;
  tradersWithGaps: number;
  oldestGap: string | null;
}> {
  const result = await query<{
    total: string;
    traders: string;
    oldest: string | null;
  }>(
    `SELECT
       COUNT(*)::text as total,
       COUNT(DISTINCT trader_id)::text as traders,
       MIN(gap_start)::text as oldest
     FROM data_gaps
     WHERE resolved_at IS NULL`
  );
  const row = result.rows[0]!;
  return {
    totalUnresolved: parseInt(row.total),
    tradersWithGaps: parseInt(row.traders),
    oldestGap: row.oldest,
  };
}
