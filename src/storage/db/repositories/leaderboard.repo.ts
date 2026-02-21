import { firstValueFrom, forkJoin, from, of, timer } from 'rxjs';
import { map, catchError, mergeMap, toArray } from 'rxjs/operators';

import { fetchPortfolio } from '../../../hyperliquid/client.js';
import type { HyperliquidPortfolio } from '../../../hyperliquid/types.js';
import { logger } from '../../../utils/logger.js';
import { query } from '../client.js';

export interface LeaderboardRow {
  rank: number;
  address: string;
  trader_id: number;
  total_pnl: string;
  realized_pnl: string;
  unrealized_pnl: string;
  volume: string;
  trade_count: number;
  tracking_since: string | null;
  data_source: 'calculated' | 'hyperliquid_portfolio';
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

/**
 * Get time-bounded leaderboard from our calculated snapshots
 * Uses DELTA calculation: (latest PnL) - (earliest PnL in timeframe)
 * Use for: 1d, 7d, 30d rankings
 */
export async function getLeaderboard(
  timeframe: '1d' | '7d' | '30d',
  metric: 'total_pnl' | 'realized_pnl' | 'volume',
  limit: number = 50
): Promise<LeaderboardRow[]> {
  const days = timeframe === '1d' ? 1 : timeframe === '7d' ? 7 : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const orderColumn = metric === 'volume' ? 'delta_volume' : `delta_${metric}`;

  // Delta PnL: latest - earliest in timeframe
  // Excludes zero-PnL snapshots (backfill initialization artifacts)
  // Volume: MAX in timeframe (immune to restart-resets)
  // Trade count: from trades table
  const result = await query<LeaderboardRow>(
    `WITH valid_snapshots AS (
      SELECT * FROM pnl_snapshots
      WHERE timestamp >= $1
        AND NOT (total_pnl = 0 AND realized_pnl = 0 AND unrealized_pnl = 0)
    ),
    earliest_snapshots AS (
      SELECT DISTINCT ON (trader_id)
        trader_id,
        total_pnl as start_total_pnl,
        realized_pnl as start_realized_pnl,
        unrealized_pnl as start_unrealized_pnl
      FROM valid_snapshots
      ORDER BY trader_id, timestamp ASC
    ),
    latest_snapshots AS (
      SELECT DISTINCT ON (trader_id)
        trader_id,
        total_pnl as end_total_pnl,
        realized_pnl as end_realized_pnl,
        unrealized_pnl as end_unrealized_pnl
      FROM valid_snapshots
      ORDER BY trader_id, timestamp DESC
    ),
    max_volume AS (
      SELECT trader_id, MAX(total_volume) as peak_volume
      FROM valid_snapshots
      GROUP BY trader_id
    ),
    trade_counts AS (
      SELECT trader_id, COUNT(*)::int as trade_count
      FROM trades
      WHERE timestamp >= $1
      GROUP BY trader_id
    ),
    delta_pnl AS (
      SELECT 
        ls.trader_id,
        (ls.end_total_pnl::numeric - COALESCE(es.start_total_pnl::numeric, 0)) as delta_total_pnl,
        (ls.end_realized_pnl::numeric - COALESCE(es.start_realized_pnl::numeric, 0)) as delta_realized_pnl,
        (ls.end_unrealized_pnl::numeric - COALESCE(es.start_unrealized_pnl::numeric, 0)) as delta_unrealized_pnl,
        COALESCE(mv.peak_volume, 0) as delta_volume
      FROM latest_snapshots ls
      LEFT JOIN earliest_snapshots es ON es.trader_id = ls.trader_id
      LEFT JOIN max_volume mv ON mv.trader_id = ls.trader_id
    )
    SELECT 
      ROW_NUMBER() OVER (ORDER BY dp.${orderColumn} DESC) as rank,
      t.address,
      t.id as trader_id,
      dp.delta_total_pnl::text as total_pnl,
      dp.delta_realized_pnl::text as realized_pnl,
      dp.delta_unrealized_pnl::text as unrealized_pnl,
      dp.delta_volume::text as volume,
      COALESCE(tc.trade_count, 0)::int as trade_count,
      t.first_seen_at as tracking_since,
      'calculated' as data_source
    FROM delta_pnl dp
    JOIN traders t ON t.id = dp.trader_id
    LEFT JOIN trade_counts tc ON tc.trader_id = dp.trader_id
    ORDER BY dp.${orderColumn} DESC
    LIMIT $2`,
    [since, limit]
  );

  return result.rows;
}

/**
 * Get all-time leaderboard using Hyperliquid's portfolio endpoint
 * This is the AUTHORITATIVE all-time PnL directly from Hyperliquid
 */
export async function getAllTimeLeaderboard(
  limit: number = 50
): Promise<AllTimeLeaderboardRow[]> {
  // Get all tracked traders
  const tradersResult = await query<{
    id: number;
    address: string;
    first_seen_at: string;
  }>('SELECT id, address, first_seen_at FROM traders WHERE is_active = true');

  if (tradersResult.rows.length === 0) {
    return [];
  }

  // Fetch portfolio data for each trader (batched to respect rate limits)
  const portfolioData: Array<{
    trader_id: number;
    address: string;
    tracking_since: string;
    portfolio: HyperliquidPortfolio | null;
  }> = [];

  const traders = tradersResult.rows;

  // Fetch portfolios using forkJoin for parallel batch processing
  const results = await firstValueFrom(
    from(traders).pipe(
      mergeMap(
        (trader) => fetchPortfolio(trader.address).pipe(
          map(portfolio => ({
            trader_id: trader.id,
            address: trader.address,
            tracking_since: trader.first_seen_at,
            portfolio: portfolio as HyperliquidPortfolio | null,
          })),
          catchError(err => {
            logger.warn(
              { address: trader.address, error: (err as Error).message },
              'Failed to fetch portfolio for leaderboard'
            );
            return of({
              trader_id: trader.id,
              address: trader.address,
              tracking_since: trader.first_seen_at,
              portfolio: null as HyperliquidPortfolio | null,
            });
          })
        ),
        10 // concurrency limit: 10 parallel fetches
      ),
      toArray()
    )
  );

  portfolioData.push(...results);

  // Extract PnL from portfolio data and rank
  const leaderboardData = portfolioData
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

  return leaderboardData;
}

/**
 * Get a specific trader's rank (uses delta calculation)
 */
export async function getTraderRank(
  traderId: number,
  timeframe: '1d' | '7d' | '30d' | 'all',
  metric: 'total_pnl' | 'realized_pnl' | 'volume'
): Promise<number | null> {
  if (timeframe === 'all') {
    // For all-time, we need to fetch all portfolios and calculate rank
    const leaderboard = await getAllTimeLeaderboard(1000);
    const entry = leaderboard.find((e) => e.trader_id === traderId);
    return entry?.rank ?? null;
  }

  const days = timeframe === '1d' ? 1 : timeframe === '7d' ? 7 : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const orderColumn = metric === 'volume' ? 'delta_volume' : `delta_${metric}`;

  const result = await query<{ rank: number }>(
    `WITH earliest_snapshots AS (
      SELECT DISTINCT ON (trader_id)
        trader_id,
        total_pnl as start_total_pnl,
        realized_pnl as start_realized_pnl,
        total_volume as start_volume
      FROM pnl_snapshots
      WHERE timestamp >= $1
      ORDER BY trader_id, timestamp ASC
    ),
    latest_snapshots AS (
      SELECT DISTINCT ON (trader_id)
        trader_id,
        total_pnl as end_total_pnl,
        realized_pnl as end_realized_pnl,
        total_volume as end_volume
      FROM pnl_snapshots
      WHERE timestamp >= $1
      ORDER BY trader_id, timestamp DESC
    ),
    delta_pnl AS (
      SELECT 
        ls.trader_id,
        (ls.end_total_pnl::numeric - COALESCE(es.start_total_pnl::numeric, 0)) as delta_total_pnl,
        (ls.end_realized_pnl::numeric - COALESCE(es.start_realized_pnl::numeric, 0)) as delta_realized_pnl,
        (ls.end_volume::numeric - COALESCE(es.start_volume::numeric, 0)) as delta_volume
      FROM latest_snapshots ls
      LEFT JOIN earliest_snapshots es ON es.trader_id = ls.trader_id
    ),
    ranked AS (
      SELECT 
        trader_id,
        ROW_NUMBER() OVER (ORDER BY ${orderColumn} DESC) as rank
      FROM delta_pnl
    )
    SELECT rank FROM ranked WHERE trader_id = $2`,
    [since, traderId]
  );

  return result.rows[0]?.rank ?? null;
}

export const leaderboardRepo = {
  get: getLeaderboard,
  getAllTime: getAllTimeLeaderboard,
  getTraderRank,
};
