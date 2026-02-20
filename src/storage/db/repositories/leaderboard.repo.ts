import { query } from '../client.js';

export interface LeaderboardRow {
  rank: number;
  address: string;
  trader_id: number;
  total_pnl: string;
  realized_pnl: string;
  volume: string;
  trade_count: number;
}

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
      ls.volume,
      COALESCE(tc.trade_count, 0)::int as trade_count
    FROM latest_snapshots ls
    JOIN traders t ON t.id = ls.trader_id
    LEFT JOIN trade_counts tc ON tc.trader_id = ls.trader_id
    ORDER BY ls.${orderColumn} DESC
    LIMIT $2`,
    [since, limit]
  );

  return result.rows;
}

export async function getTraderRank(
  traderId: number,
  timeframe: '1d' | '7d' | '30d',
  metric: 'total_pnl' | 'realized_pnl' | 'volume'
): Promise<number | null> {
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

export const leaderboardRepo = {
  get: getLeaderboard,
  getTraderRank,
};
