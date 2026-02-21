import type { Decimal } from '../../../utils/decimal.js';
import { formatDecimal } from '../../../utils/decimal.js';
import { query } from '../client.js';

export interface SnapshotRow {
  trader_id: number;
  timestamp: Date;
  realized_pnl: string;
  unrealized_pnl: string;
  total_pnl: string;
  funding_pnl: string;
  trading_pnl: string;
  open_positions: number;
  total_volume: string;
  account_value: string | null;
}

export interface SnapshotInsert {
  traderId: number;
  timestamp: Date;
  realizedPnl: Decimal;
  unrealizedPnl: Decimal;
  totalPnl: Decimal;
  fundingPnl: Decimal;
  tradingPnl: Decimal;
  openPositions: number;
  totalVolume: Decimal;
  accountValue: Decimal | null;
}

export async function insertSnapshot(snapshot: SnapshotInsert): Promise<void> {
  await query(
    `INSERT INTO pnl_snapshots (
      trader_id, timestamp, realized_pnl, unrealized_pnl, total_pnl,
      funding_pnl, trading_pnl, open_positions, total_volume, account_value
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (trader_id, timestamp) DO UPDATE SET
      realized_pnl = EXCLUDED.realized_pnl,
      unrealized_pnl = EXCLUDED.unrealized_pnl,
      total_pnl = EXCLUDED.total_pnl,
      funding_pnl = EXCLUDED.funding_pnl,
      trading_pnl = EXCLUDED.trading_pnl,
      open_positions = EXCLUDED.open_positions,
      total_volume = EXCLUDED.total_volume,
      account_value = EXCLUDED.account_value`,
    [
      snapshot.traderId,
      snapshot.timestamp,
      formatDecimal(snapshot.realizedPnl),
      formatDecimal(snapshot.unrealizedPnl),
      formatDecimal(snapshot.totalPnl),
      formatDecimal(snapshot.fundingPnl),
      formatDecimal(snapshot.tradingPnl),
      snapshot.openPositions,
      formatDecimal(snapshot.totalVolume),
      snapshot.accountValue ? formatDecimal(snapshot.accountValue) : null,
    ]
  );
}

export async function insertSnapshots(snapshots: SnapshotInsert[]): Promise<void> {
  if (snapshots.length === 0) return;

  const values: unknown[] = [];
  const placeholders: string[] = [];

  snapshots.forEach((snapshot, index) => {
    const offset = index * 10;
    placeholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`
    );
    values.push(
      snapshot.traderId,
      snapshot.timestamp,
      formatDecimal(snapshot.realizedPnl),
      formatDecimal(snapshot.unrealizedPnl),
      formatDecimal(snapshot.totalPnl),
      formatDecimal(snapshot.fundingPnl),
      formatDecimal(snapshot.tradingPnl),
      snapshot.openPositions,
      formatDecimal(snapshot.totalVolume),
      snapshot.accountValue ? formatDecimal(snapshot.accountValue) : null
    );
  });

  await query(
    `INSERT INTO pnl_snapshots (
      trader_id, timestamp, realized_pnl, unrealized_pnl, total_pnl,
      funding_pnl, trading_pnl, open_positions, total_volume, account_value
    ) VALUES ${placeholders.join(', ')}
    ON CONFLICT (trader_id, timestamp) DO UPDATE SET
      realized_pnl = EXCLUDED.realized_pnl,
      unrealized_pnl = EXCLUDED.unrealized_pnl,
      total_pnl = EXCLUDED.total_pnl,
      funding_pnl = EXCLUDED.funding_pnl,
      trading_pnl = EXCLUDED.trading_pnl,
      open_positions = EXCLUDED.open_positions,
      total_volume = EXCLUDED.total_volume,
      account_value = EXCLUDED.account_value`,
    values
  );
}

export async function getSnapshotsForTrader(
  traderId: number,
  from: Date,
  to: Date,
  granularity: 'raw' | 'hourly' | 'daily' = 'raw'
): Promise<SnapshotRow[]> {
  let tableName = 'pnl_snapshots';
  if (granularity === 'hourly') {
    tableName = 'pnl_hourly';
  } else if (granularity === 'daily') {
    tableName = 'pnl_daily';
  }

  const timestampColumn = granularity === 'raw' ? 'timestamp' : 'bucket';

  const result = await query<SnapshotRow>(
    `SELECT 
      trader_id,
      ${timestampColumn} as timestamp,
      realized_pnl,
      unrealized_pnl,
      total_pnl,
      funding_pnl,
      trading_pnl,
      ${granularity === 'raw' ? 'open_positions' : 'positions as open_positions'},
      ${granularity === 'raw' ? 'total_volume' : 'volume as total_volume'},
      ${granularity === 'raw' ? 'account_value' : 'NULL as account_value'}
    FROM ${tableName}
    WHERE trader_id = $1 AND ${timestampColumn} >= $2 AND ${timestampColumn} <= $3
    ORDER BY ${timestampColumn} ASC`,
    [traderId, from, to]
  );

  return result.rows;
}

export async function getLatestSnapshot(traderId: number): Promise<SnapshotRow | null> {
  const result = await query<SnapshotRow>(
    `SELECT * FROM pnl_snapshots
     WHERE trader_id = $1
     ORDER BY timestamp DESC
     LIMIT 1`,
    [traderId]
  );
  return result.rows[0] ?? null;
}

export async function getPnLSummary(
  traderId: number,
  from: Date,
  to: Date
): Promise<{ peakPnl: string; troughPnl: string; totalRealized: string } | null> {
  const result = await query<{ peak_pnl: string; trough_pnl: string; total_realized: string }>(
    `SELECT 
      MAX(total_pnl) as peak_pnl,
      MIN(total_pnl) as trough_pnl,
      (SELECT realized_pnl FROM pnl_snapshots 
       WHERE trader_id = $1 ORDER BY timestamp DESC LIMIT 1) as total_realized
    FROM pnl_snapshots
    WHERE trader_id = $1 AND timestamp >= $2 AND timestamp <= $3`,
    [traderId, from, to]
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    peakPnl: row.peak_pnl,
    troughPnl: row.trough_pnl,
    totalRealized: row.total_realized,
  };
}

export async function getSnapshotCount(traderId: number, from: Date, to: Date): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text as count FROM pnl_snapshots
     WHERE trader_id = $1 AND timestamp >= $2 AND timestamp <= $3`,
    [traderId, from, to]
  );
  return parseInt(result.rows[0]?.count ?? '0');
}

export const snapshotsRepo = {
  insert: insertSnapshot,
  insertMany: insertSnapshots,
  getForTrader: getSnapshotsForTrader,
  getLatest: getLatestSnapshot,
  getSummary: getPnLSummary,
  getCount: getSnapshotCount,
};
