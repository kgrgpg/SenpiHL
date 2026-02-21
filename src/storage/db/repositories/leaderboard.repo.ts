import { firstValueFrom, from, of } from 'rxjs';
import { map, catchError, mergeMap, toArray } from 'rxjs/operators';

import { fetchPortfolio } from '../../../hyperliquid/client.js';
import type { HyperliquidPortfolio, PortfolioPeriod } from '../../../hyperliquid/types.js';
import { logger } from '../../../utils/logger.js';
import { query } from '../client.js';

export interface LeaderboardRow {
  rank: number;
  address: string;
  trader_id: number;
  total_pnl: string;
  trade_count: number;
  tracking_since: string | null;
  data_source: 'hyperliquid_portfolio' | 'snapshot_delta';
  timeframe_coverage: 'full' | 'partial';
}

export interface AllTimeLeaderboardRow {
  rank: number;
  address: string;
  trader_id: number;
  all_time_pnl: string;
  all_time_volume: string;
  perp_pnl: string;
  perp_volume: string;
  tracking_since: string | null;
  data_source: 'hyperliquid_portfolio';
}

const PORTFOLIO_PERIOD_MAP: Record<string, PortfolioPeriod> = {
  '1d': 'perpDay',
  '7d': 'perpWeek',
  '30d': 'perpMonth',
};

/**
 * Two-phase leaderboard:
 * 1. Get rough candidate set from snapshot deltas (fast, from DB)
 * 2. Fetch authoritative PnL from portfolio API for the top candidates
 * 3. Re-rank by the authoritative figure
 *
 * This gives us accurate numbers without fetching portfolio for 1000+ traders.
 */
export async function getLeaderboard(
  timeframe: '1d' | '7d' | '30d',
  _metric: 'total_pnl' | 'realized_pnl' | 'volume',
  limit: number = 50
): Promise<LeaderboardRow[]> {
  const days = timeframe === '1d' ? 1 : timeframe === '7d' ? 7 : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const portfolioPeriod = PORTFOLIO_PERIOD_MAP[timeframe]!;

  // Phase 1: get a broad candidate set from snapshots (2x limit to account for re-ranking)
  const candidateLimit = Math.min(limit * 2, 200);
  const candidates = await query<{
    trader_id: number;
    address: string;
    first_seen_at: string;
    delta_pnl: string;
  }>(
    `WITH valid_snapshots AS (
      SELECT * FROM pnl_snapshots
      WHERE timestamp >= $1
        AND NOT (total_pnl = 0 AND realized_pnl = 0 AND unrealized_pnl = 0)
    ),
    earliest AS (
      SELECT DISTINCT ON (trader_id) trader_id, total_pnl as start_pnl
      FROM valid_snapshots ORDER BY trader_id, timestamp ASC
    ),
    latest AS (
      SELECT DISTINCT ON (trader_id) trader_id, total_pnl as end_pnl
      FROM valid_snapshots ORDER BY trader_id, timestamp DESC
    ),
    delta AS (
      SELECT l.trader_id,
        (l.end_pnl::numeric - COALESCE(e.start_pnl::numeric, 0)) as delta_pnl
      FROM latest l LEFT JOIN earliest e ON e.trader_id = l.trader_id
    )
    SELECT d.trader_id, t.address, t.first_seen_at,
      d.delta_pnl::text as delta_pnl
    FROM delta d
    JOIN traders t ON t.id = d.trader_id
    ORDER BY d.delta_pnl DESC
    LIMIT $2`,
    [since, candidateLimit]
  );

  if (candidates.rows.length === 0) return [];

  // Phase 2: fetch authoritative portfolio PnL for candidates
  const results = await firstValueFrom(
    from(candidates.rows).pipe(
      mergeMap(
        (trader) => fetchPortfolio(trader.address).pipe(
          map((portfolio) => {
            const portfolioMap = new Map(portfolio as HyperliquidPortfolio);
            const periodData = portfolioMap.get(portfolioPeriod);
            const pnlHistory = periodData?.pnlHistory ?? [];
            const totalPnl = pnlHistory.length > 0
              ? pnlHistory[pnlHistory.length - 1]![1]
              : null;

            const trackingSince = new Date(trader.first_seen_at);
            const timeframeStart = since;
            const hasFull = trackingSince <= timeframeStart;

            return {
              trader_id: trader.trader_id,
              address: trader.address,
              tracking_since: trader.first_seen_at,
              total_pnl: totalPnl,
              timeframe_coverage: hasFull ? 'full' as const : 'partial' as const,
              data_source: 'hyperliquid_portfolio' as const,
            };
          }),
          catchError((err) => {
            logger.debug({ address: trader.address, error: (err as Error).message },
              'Portfolio fetch failed, using snapshot delta');
            return of({
              trader_id: trader.trader_id,
              address: trader.address,
              tracking_since: trader.first_seen_at,
              total_pnl: trader.delta_pnl,
              timeframe_coverage: 'partial' as const,
              data_source: 'snapshot_delta' as const,
            });
          })
        ),
        5 // concurrency: 5 parallel portfolio fetches
      ),
      toArray()
    )
  );

  // Get trade counts from DB
  const tradeCountResult = await query<{ trader_id: number; cnt: string }>(
    `SELECT trader_id, COUNT(*)::text as cnt FROM trades
     WHERE timestamp >= $1 GROUP BY trader_id`,
    [since]
  );
  const tradeCounts = new Map(tradeCountResult.rows.map(r => [r.trader_id, parseInt(r.cnt)]));

  // Phase 3: rank by authoritative PnL
  return results
    .filter((r) => r.total_pnl !== null)
    .sort((a, b) => parseFloat(b.total_pnl!) - parseFloat(a.total_pnl!))
    .slice(0, limit)
    .map((entry, index) => ({
      rank: index + 1,
      address: entry.address,
      trader_id: entry.trader_id,
      total_pnl: entry.total_pnl!,
      trade_count: tradeCounts.get(entry.trader_id) ?? 0,
      tracking_since: entry.tracking_since,
      data_source: entry.data_source,
      timeframe_coverage: entry.timeframe_coverage,
    }));
}

/**
 * All-time leaderboard using Hyperliquid's portfolio endpoint (authoritative).
 * Fetches portfolio for top candidates from DB.
 */
export async function getAllTimeLeaderboard(
  limit: number = 50
): Promise<AllTimeLeaderboardRow[]> {
  // Get candidates: traders with highest snapshot PnL as rough ranking
  const candidateLimit = Math.min(limit * 2, 200);
  const candidates = await query<{
    id: number;
    address: string;
    first_seen_at: string;
  }>(
    `SELECT DISTINCT ON (t.id) t.id, t.address, t.first_seen_at
     FROM traders t
     JOIN pnl_snapshots ps ON ps.trader_id = t.id
     WHERE t.is_active = true
     ORDER BY t.id, ps.total_pnl DESC
     LIMIT $1`,
    [candidateLimit]
  );

  if (candidates.rows.length === 0) return [];

  const results = await firstValueFrom(
    from(candidates.rows).pipe(
      mergeMap(
        (trader) => fetchPortfolio(trader.address).pipe(
          map(portfolio => ({
            trader_id: trader.id,
            address: trader.address,
            tracking_since: trader.first_seen_at,
            portfolio: portfolio as HyperliquidPortfolio | null,
          })),
          catchError(err => {
            logger.warn({ address: trader.address, error: (err as Error).message },
              'Failed to fetch portfolio for leaderboard');
            return of({
              trader_id: trader.id,
              address: trader.address,
              tracking_since: trader.first_seen_at,
              portfolio: null as HyperliquidPortfolio | null,
            });
          })
        ),
        5
      ),
      toArray()
    )
  );

  return results
    .filter((p) => p.portfolio !== null)
    .map((p) => {
      const portfolioMap = new Map(p.portfolio!);
      const allTime = portfolioMap.get('allTime');
      const perpAllTime = portfolioMap.get('perpAllTime');

      const allTimePnl = allTime?.pnlHistory?.length
        ? allTime.pnlHistory[allTime.pnlHistory.length - 1]![1]
        : '0';
      const perpPnl = perpAllTime?.pnlHistory?.length
        ? perpAllTime.pnlHistory[perpAllTime.pnlHistory.length - 1]![1]
        : '0';

      return {
        trader_id: p.trader_id,
        address: p.address,
        tracking_since: p.tracking_since,
        all_time_pnl: allTimePnl,
        all_time_volume: allTime?.vlm || '0',
        perp_pnl: perpPnl,
        perp_volume: perpAllTime?.vlm || '0',
      };
    })
    .sort((a, b) => parseFloat(b.all_time_pnl) - parseFloat(a.all_time_pnl))
    .slice(0, limit)
    .map((entry, index) => ({
      rank: index + 1,
      ...entry,
      data_source: 'hyperliquid_portfolio' as const,
    }));
}

/**
 * Get a specific trader's rank
 */
export async function getTraderRank(
  traderId: number,
  timeframe: '1d' | '7d' | '30d' | 'all',
  metric: 'total_pnl' | 'realized_pnl' | 'volume'
): Promise<number | null> {
  if (timeframe === 'all') {
    const leaderboard = await getAllTimeLeaderboard(200);
    const entry = leaderboard.find((e) => e.trader_id === traderId);
    return entry?.rank ?? null;
  }

  const leaderboard = await getLeaderboard(timeframe, metric, 200);
  const entry = leaderboard.find((e) => e.trader_id === traderId);
  return entry?.rank ?? null;
}

export const leaderboardRepo = {
  get: getLeaderboard,
  getAllTime: getAllTimeLeaderboard,
  getTraderRank,
};
