import type { Decimal } from '../../../utils/decimal.js';
import { formatDecimal } from '../../../utils/decimal.js';
import { query } from '../client.js';

export interface TradeInsert {
  traderId: number;
  coin: string;
  side: 'B' | 'A';
  size: Decimal;
  price: Decimal;
  closedPnl: Decimal;
  fee: Decimal;
  timestamp: Date;
  txHash?: string;
  oid?: number;
  tid: number;
}

export async function insertTrade(trade: TradeInsert): Promise<void> {
  await query(
    `INSERT INTO trades (trader_id, coin, side, size, price, closed_pnl, fee, timestamp, tx_hash, oid, tid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT DO NOTHING`,
    [
      trade.traderId,
      trade.coin,
      trade.side,
      formatDecimal(trade.size),
      formatDecimal(trade.price),
      formatDecimal(trade.closedPnl),
      formatDecimal(trade.fee),
      trade.timestamp,
      trade.txHash ?? null,
      trade.oid ?? null,
      trade.tid,
    ]
  );
}

export async function insertTrades(trades: TradeInsert[]): Promise<void> {
  if (trades.length === 0) return;

  const values: unknown[] = [];
  const placeholders: string[] = [];

  for (let i = 0; i < trades.length; i++) {
    const offset = i * 11;
    const t = trades[i]!;
    placeholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11})`
    );
    values.push(
      t.traderId, t.coin, t.side,
      formatDecimal(t.size), formatDecimal(t.price),
      formatDecimal(t.closedPnl), formatDecimal(t.fee),
      t.timestamp, t.txHash ?? null, t.oid ?? null, t.tid
    );
  }

  await query(
    `INSERT INTO trades (trader_id, coin, side, size, price, closed_pnl, fee, timestamp, tx_hash, oid, tid)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT DO NOTHING`,
    values
  );
}

export async function getTradesForTrader(
  traderId: number,
  from: Date,
  to: Date
): Promise<Array<{
  coin: string;
  side: string;
  size: string;
  price: string;
  closed_pnl: string;
  fee: string;
  timestamp: Date;
  tid: number;
}>> {
  const result = await query<{
    coin: string;
    side: string;
    size: string;
    price: string;
    closed_pnl: string;
    fee: string;
    timestamp: Date;
    tid: number;
  }>(
    `SELECT coin, side, size, price, closed_pnl, fee, timestamp, tid
     FROM trades
     WHERE trader_id = $1 AND timestamp >= $2 AND timestamp <= $3
     ORDER BY timestamp ASC`,
    [traderId, from, to]
  );
  return result.rows;
}

export async function getTradeCount(traderId: number, from: Date, to: Date): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM trades WHERE trader_id = $1 AND timestamp >= $2 AND timestamp <= $3`,
    [traderId, from, to]
  );
  return parseInt(result.rows[0]?.count ?? '0');
}

export async function getRealizedPnlSummary(traderId: number, from: Date, to: Date): Promise<{
  realized_pnl: string;
  total_fees: string;
  trade_count: number;
  total_volume: string;
}> {
  const result = await query<{
    realized_pnl: string;
    total_fees: string;
    trade_count: string;
    total_volume: string;
  }>(
    `SELECT 
      COALESCE(SUM(closed_pnl), 0)::text as realized_pnl,
      COALESCE(SUM(fee), 0)::text as total_fees,
      COUNT(*)::text as trade_count,
      COALESCE(SUM(size * price), 0)::text as total_volume
     FROM trades
     WHERE trader_id = $1 AND timestamp >= $2 AND timestamp <= $3`,
    [traderId, from, to]
  );
  const row = result.rows[0]!;
  return {
    realized_pnl: row.realized_pnl,
    total_fees: row.total_fees,
    trade_count: parseInt(row.trade_count),
    total_volume: row.total_volume,
  };
}

export const tradesRepo = {
  insert: insertTrade,
  insertMany: insertTrades,
  getForTrader: getTradesForTrader,
  getCount: getTradeCount,
  getRealizedPnlSummary,
};
