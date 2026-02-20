import { firstValueFrom } from 'rxjs';

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
 * Use for: 1d, 7d, 30d rankings
 */
export async function getLeaderboard(
  timeframe: '1d' | '7d' | '30d',
  metric: 'total_pnl' | 'realized_pnl' | 'volume',
  limit: number = 50
): Promise<LeaderboardRow[]> {
  const days = timeframe === '1d' ? 1 : timeframe === '7d' ? 7 : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const orderColumn = metric === 'volume' ? 'volume' : metric;

  const result = await query<LeaderboardRow>(
    `WITH latest_snapshots AS (
      SELECT DISTINCT ON (trader_id)
        trader_id,
        total_pnl,
        realized_pnl,
        unrealized_pnl,
        total_volume as volume
      FROM pnl_snapshots
      WHERE timestamp >= $1
      ORDER BY trader_id, timestamp DESC
    ),
    trade_counts AS (
      SELECT trader_id, COUNT(*) as trade_count
      FROM trades
      WHERE timestamp >= $1
      GROUP BY trader_id
    )
    SELECT 
      ROW_NUMBER() OVER (ORDER BY ls.${orderColumn} DESC) as rank,
      t.address,
      t.id as trader_id,
      ls.total_pnl,
      ls.realized_pnl,
      ls.unrealized_pnl,
      ls.volume,
      COALESCE(tc.trade_count, 0)::int as trade_count,
      t.first_seen_at as tracking_since,
      'calculated' as data_source
    FROM latest_snapshots ls
    JOIN traders t ON t.id = ls.trader_id
    LEFT JOIN trade_counts tc ON tc.trader_id = ls.trader_id
    ORDER BY ls.${orderColumn} DESC
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

  const BATCH_SIZE = 10;
  const traders = tradersResult.rows;

  for (let i = 0; i < traders.length; i += BATCH_SIZE) {
    const batch = traders.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async (trader) => {
        try {
          const portfolio = await firstValueFrom(fetchPortfolio(trader.address));
          return {
            trader_id: trader.id,
            address: trader.address,
            tracking_since: trader.first_seen_at,
            portfolio,
          };
        } catch (err) {
          logger.warn(
            { address: trader.address, error: (err as Error).message },
            'Failed to fetch portfolio for leaderboard'
          );
          return {
            trader_id: trader.id,
            address: trader.address,
            tracking_since: trader.first_seen_at,
            portfolio: null,
          };
        }
      })
    );

    portfolioData.push(...batchResults);

    // Small delay between batches
    if (i + BATCH_SIZE < traders.length) {
      await sleep(100);
    }
  }

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
 * Get a specific trader's rank
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

  const orderColumn = metric === 'volume' ? 'volume' : metric;

  const result = await query<{ rank: number }>(
    `WITH latest_snapshots AS (
      SELECT DISTINCT ON (trader_id)
        trader_id,
        total_pnl,
        realized_pnl,
        total_volume as volume
      FROM pnl_snapshots
      WHERE timestamp >= $1
      ORDER BY trader_id, timestamp DESC
    ),
    ranked AS (
      SELECT 
        trader_id,
        ROW_NUMBER() OVER (ORDER BY ${orderColumn} DESC) as rank
      FROM latest_snapshots
    )
    SELECT rank FROM ranked WHERE trader_id = $2`,
    [since, traderId]
  );

  return result.rows[0]?.rank ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const leaderboardRepo = {
  get: getLeaderboard,
  getAllTime: getAllTimeLeaderboard,
  getTraderRank,
};
