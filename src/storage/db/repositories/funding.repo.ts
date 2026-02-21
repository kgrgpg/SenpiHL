import type { Decimal } from '../../../utils/decimal.js';
import { formatDecimal } from '../../../utils/decimal.js';
import { query } from '../client.js';

export interface FundingInsert {
  traderId: number;
  coin: string;
  fundingRate: Decimal;
  payment: Decimal;
  positionSize: Decimal;
  timestamp: Date;
}

export async function insertFunding(funding: FundingInsert): Promise<void> {
  await query(
    `INSERT INTO funding_payments (trader_id, coin, funding_rate, payment, position_size, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [
      funding.traderId,
      funding.coin,
      formatDecimal(funding.fundingRate),
      formatDecimal(funding.payment),
      formatDecimal(funding.positionSize),
      funding.timestamp,
    ]
  );
}

export async function insertFundingBatch(payments: FundingInsert[]): Promise<void> {
  if (payments.length === 0) return;

  const values: unknown[] = [];
  const placeholders: string[] = [];

  for (let i = 0; i < payments.length; i++) {
    const offset = i * 6;
    const f = payments[i]!;
    placeholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`
    );
    values.push(
      f.traderId, f.coin,
      formatDecimal(f.fundingRate), formatDecimal(f.payment),
      formatDecimal(f.positionSize), f.timestamp
    );
  }

  await query(
    `INSERT INTO funding_payments (trader_id, coin, funding_rate, payment, position_size, timestamp)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT DO NOTHING`,
    values
  );
}

export async function getFundingForTrader(
  traderId: number,
  from: Date,
  to: Date
): Promise<Array<{
  coin: string;
  funding_rate: string;
  payment: string;
  position_size: string;
  timestamp: Date;
}>> {
  const result = await query<{
    coin: string;
    funding_rate: string;
    payment: string;
    position_size: string;
    timestamp: Date;
  }>(
    `SELECT coin, funding_rate, payment, position_size, timestamp
     FROM funding_payments
     WHERE trader_id = $1 AND timestamp >= $2 AND timestamp <= $3
     ORDER BY timestamp ASC`,
    [traderId, from, to]
  );
  return result.rows;
}

export async function getFundingPnl(traderId: number, from: Date, to: Date): Promise<string> {
  const result = await query<{ funding_pnl: string }>(
    `SELECT COALESCE(SUM(payment), 0)::text as funding_pnl
     FROM funding_payments
     WHERE trader_id = $1 AND timestamp >= $2 AND timestamp <= $3`,
    [traderId, from, to]
  );
  return result.rows[0]?.funding_pnl ?? '0';
}

export const fundingRepo = {
  insert: insertFunding,
  insertMany: insertFundingBatch,
  getForTrader: getFundingForTrader,
  getFundingPnl,
};
