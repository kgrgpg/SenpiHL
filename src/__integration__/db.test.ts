/**
 * Database Integration Tests
 *
 * Tests the repository layer against a real TimescaleDB instance.
 * Requires a running database (via docker compose up -d timescaledb).
 * Gated behind INTEGRATION=1 (excluded from normal test runs).
 *
 * Run:
 *   INTEGRATION=1 npx vitest run src/__integration__/db.test.ts
 *
 * These tests use a dedicated test schema (pnl_test_<pid>) to avoid
 * interfering with development data, and clean up after themselves.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const SKIP = !process.env.INTEGRATION;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:password@localhost:5432/pnl_indexer';

const TEST_SCHEMA = `pnl_test_${process.pid}`;
let pool: pg.Pool;

async function exec(sql: string, params?: unknown[]): Promise<pg.QueryResult> {
  return pool.query(sql, params);
}

async function setupTestSchema(): Promise<void> {
  await exec(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
  await exec(`SET search_path TO ${TEST_SCHEMA}, public`);

  await exec(`
    CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.traders (
      id SERIAL PRIMARY KEY,
      address VARCHAR(42) UNIQUE NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_active BOOLEAN DEFAULT TRUE
    )
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.trades (
      id BIGSERIAL,
      trader_id INTEGER NOT NULL REFERENCES ${TEST_SCHEMA}.traders(id),
      coin VARCHAR(20) NOT NULL,
      side VARCHAR(1) NOT NULL,
      size NUMERIC(20,8) NOT NULL,
      price NUMERIC(20,8) NOT NULL,
      closed_pnl NUMERIC(20,8),
      fee NUMERIC(20,8),
      timestamp TIMESTAMPTZ NOT NULL,
      tx_hash VARCHAR(66),
      oid BIGINT,
      tid BIGINT NOT NULL,
      PRIMARY KEY (id, timestamp)
    )
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.funding_payments (
      id BIGSERIAL,
      trader_id INTEGER NOT NULL REFERENCES ${TEST_SCHEMA}.traders(id),
      coin VARCHAR(20) NOT NULL,
      funding_rate NUMERIC(20,12) NOT NULL,
      payment NUMERIC(20,8) NOT NULL,
      position_size NUMERIC(20,8) NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (id, timestamp)
    )
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.pnl_snapshots (
      trader_id INTEGER NOT NULL REFERENCES ${TEST_SCHEMA}.traders(id),
      timestamp TIMESTAMPTZ NOT NULL,
      realized_pnl NUMERIC(20,8) NOT NULL,
      unrealized_pnl NUMERIC(20,8) NOT NULL,
      total_pnl NUMERIC(20,8) NOT NULL,
      funding_pnl NUMERIC(20,8) NOT NULL,
      trading_pnl NUMERIC(20,8) NOT NULL,
      open_positions INTEGER NOT NULL,
      total_volume NUMERIC(20,8) NOT NULL,
      account_value NUMERIC(20,8),
      PRIMARY KEY (trader_id, timestamp)
    )
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.data_gaps (
      id SERIAL PRIMARY KEY,
      trader_id INTEGER NOT NULL REFERENCES ${TEST_SCHEMA}.traders(id),
      gap_start TIMESTAMPTZ NOT NULL,
      gap_end TIMESTAMPTZ NOT NULL,
      gap_type VARCHAR(50) NOT NULL DEFAULT 'snapshots',
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `);
}

async function teardownTestSchema(): Promise<void> {
  await exec(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
}

describe.skipIf(SKIP)('Database Integration Tests', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
    await setupTestSchema();
  });

  afterAll(async () => {
    await teardownTestSchema();
    await pool.end();
  });

  describe('traders table', () => {
    it('should insert and retrieve a trader', async () => {
      const address = '0xaabbccdd00112233445566778899aabbccddeeff';
      const result = await exec(
        `INSERT INTO ${TEST_SCHEMA}.traders (address) VALUES ($1) RETURNING *`,
        [address]
      );
      expect(result.rows[0].address).toBe(address);
      expect(result.rows[0].is_active).toBe(true);
      expect(result.rows[0].id).toBeGreaterThan(0);

      const fetched = await exec(
        `SELECT * FROM ${TEST_SCHEMA}.traders WHERE address = $1`,
        [address]
      );
      expect(fetched.rows).toHaveLength(1);
      expect(fetched.rows[0].address).toBe(address);
    });

    it('should enforce unique address constraint', async () => {
      const address = '0x1111111111111111111111111111111111111111';
      await exec(
        `INSERT INTO ${TEST_SCHEMA}.traders (address) VALUES ($1)`,
        [address]
      );
      await expect(
        exec(`INSERT INTO ${TEST_SCHEMA}.traders (address) VALUES ($1)`, [address])
      ).rejects.toThrow(/unique/i);
    });

    it('should update is_active flag', async () => {
      const res = await exec(
        `INSERT INTO ${TEST_SCHEMA}.traders (address) VALUES ($1) RETURNING id`,
        ['0x2222222222222222222222222222222222222222']
      );
      const id = res.rows[0].id;

      await exec(
        `UPDATE ${TEST_SCHEMA}.traders SET is_active = false WHERE id = $1`,
        [id]
      );

      const fetched = await exec(
        `SELECT is_active FROM ${TEST_SCHEMA}.traders WHERE id = $1`,
        [id]
      );
      expect(fetched.rows[0].is_active).toBe(false);
    });
  });

  describe('pnl_snapshots table', () => {
    let traderId: number;

    beforeAll(async () => {
      const res = await exec(
        `INSERT INTO ${TEST_SCHEMA}.traders (address) VALUES ($1) RETURNING id`,
        ['0xsnap000000000000000000000000000000000001']
      );
      traderId = res.rows[0].id;
    });

    it('should insert and retrieve snapshots', async () => {
      const now = new Date();
      await exec(
        `INSERT INTO ${TEST_SCHEMA}.pnl_snapshots
         (trader_id, timestamp, realized_pnl, unrealized_pnl, total_pnl,
          funding_pnl, trading_pnl, open_positions, total_volume, account_value)
         VALUES ($1, $2, 100, 50, 150, 10, 90, 2, 50000, 10000)`,
        [traderId, now]
      );

      const result = await exec(
        `SELECT * FROM ${TEST_SCHEMA}.pnl_snapshots WHERE trader_id = $1`,
        [traderId]
      );

      expect(result.rows).toHaveLength(1);
      expect(parseFloat(result.rows[0].total_pnl)).toBe(150);
      expect(result.rows[0].open_positions).toBe(2);
    });

    it('should upsert on conflict (same trader_id + timestamp)', async () => {
      const ts = new Date('2026-01-15T12:00:00Z');

      await exec(
        `INSERT INTO ${TEST_SCHEMA}.pnl_snapshots
         (trader_id, timestamp, realized_pnl, unrealized_pnl, total_pnl,
          funding_pnl, trading_pnl, open_positions, total_volume)
         VALUES ($1, $2, 100, 50, 150, 10, 90, 2, 50000)
         ON CONFLICT (trader_id, timestamp) DO UPDATE SET
           total_pnl = EXCLUDED.total_pnl`,
        [traderId, ts]
      );

      await exec(
        `INSERT INTO ${TEST_SCHEMA}.pnl_snapshots
         (trader_id, timestamp, realized_pnl, unrealized_pnl, total_pnl,
          funding_pnl, trading_pnl, open_positions, total_volume)
         VALUES ($1, $2, 200, 100, 300, 20, 180, 3, 80000)
         ON CONFLICT (trader_id, timestamp) DO UPDATE SET
           total_pnl = EXCLUDED.total_pnl`,
        [traderId, ts]
      );

      const result = await exec(
        `SELECT total_pnl FROM ${TEST_SCHEMA}.pnl_snapshots
         WHERE trader_id = $1 AND timestamp = $2`,
        [traderId, ts]
      );
      expect(result.rows).toHaveLength(1);
      expect(parseFloat(result.rows[0].total_pnl)).toBe(300);
    });

    it('should query snapshots within a time range', async () => {
      const base = new Date('2026-02-01T00:00:00Z');
      for (let i = 0; i < 5; i++) {
        const ts = new Date(base.getTime() + i * 60000);
        await exec(
          `INSERT INTO ${TEST_SCHEMA}.pnl_snapshots
           (trader_id, timestamp, realized_pnl, unrealized_pnl, total_pnl,
            funding_pnl, trading_pnl, open_positions, total_volume)
           VALUES ($1, $2, $3, 0, $3, 0, $3, 1, 1000)
           ON CONFLICT (trader_id, timestamp) DO NOTHING`,
          [traderId, ts, (i + 1) * 100]
        );
      }

      const from = new Date('2026-02-01T00:01:00Z');
      const to = new Date('2026-02-01T00:03:00Z');
      const result = await exec(
        `SELECT * FROM ${TEST_SCHEMA}.pnl_snapshots
         WHERE trader_id = $1 AND timestamp >= $2 AND timestamp <= $3
         ORDER BY timestamp ASC`,
        [traderId, from, to]
      );

      expect(result.rows.length).toBe(3);
      expect(parseFloat(result.rows[0].total_pnl)).toBe(200);
      expect(parseFloat(result.rows[2].total_pnl)).toBe(400);
    });
  });

  describe('trades table', () => {
    let traderId: number;

    beforeAll(async () => {
      const res = await exec(
        `INSERT INTO ${TEST_SCHEMA}.traders (address) VALUES ($1) RETURNING id`,
        ['0xtrade0000000000000000000000000000000001']
      );
      traderId = res.rows[0].id;
    });

    it('should insert and retrieve trades', async () => {
      const ts = new Date();
      await exec(
        `INSERT INTO ${TEST_SCHEMA}.trades
         (trader_id, coin, side, size, price, closed_pnl, fee, timestamp, tid)
         VALUES ($1, 'BTC', 'B', 1.5, 50000, 0, 5, $2, 12345)`,
        [traderId, ts]
      );

      const result = await exec(
        `SELECT * FROM ${TEST_SCHEMA}.trades WHERE trader_id = $1`,
        [traderId]
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].coin).toBe('BTC');
      expect(parseFloat(result.rows[0].size)).toBe(1.5);
      expect(result.rows[0].tid).toBe('12345');
    });

    it('should compute realized PnL from trades via SUM', async () => {
      const base = new Date('2026-03-01T00:00:00Z');

      await exec(
        `INSERT INTO ${TEST_SCHEMA}.trades
         (trader_id, coin, side, size, price, closed_pnl, fee, timestamp, tid)
         VALUES
           ($1, 'ETH', 'B', 10, 3000, 0, 3, $2, 1001),
           ($1, 'ETH', 'A', 10, 3200, 2000, 3.2, $3, 1002),
           ($1, 'BTC', 'A', 0.5, 60000, -500, 6, $4, 1003)`,
        [
          traderId,
          new Date(base.getTime()),
          new Date(base.getTime() + 60000),
          new Date(base.getTime() + 120000),
        ]
      );

      const result = await exec(
        `SELECT
           COALESCE(SUM(closed_pnl), 0)::text as realized_pnl,
           COALESCE(SUM(fee), 0)::text as total_fees,
           COUNT(*)::int as trade_count
         FROM ${TEST_SCHEMA}.trades
         WHERE trader_id = $1 AND timestamp >= $2 AND timestamp <= $3`,
        [traderId, base, new Date(base.getTime() + 200000)]
      );

      expect(parseFloat(result.rows[0].realized_pnl)).toBe(1500);
      expect(parseFloat(result.rows[0].total_fees)).toBeCloseTo(12.2, 1);
      expect(result.rows[0].trade_count).toBe(3);
    });
  });

  describe('funding_payments table', () => {
    let traderId: number;

    beforeAll(async () => {
      const res = await exec(
        `INSERT INTO ${TEST_SCHEMA}.traders (address) VALUES ($1) RETURNING id`,
        ['0xfund00000000000000000000000000000000001']
      );
      traderId = res.rows[0].id;
    });

    it('should insert and sum funding payments', async () => {
      const base = new Date('2026-04-01T00:00:00Z');

      await exec(
        `INSERT INTO ${TEST_SCHEMA}.funding_payments
         (trader_id, coin, funding_rate, payment, position_size, timestamp)
         VALUES
           ($1, 'BTC', 0.0001, 25.5, 1, $2),
           ($1, 'BTC', -0.00005, -12.75, 1, $3),
           ($1, 'ETH', 0.0002, 60, 10, $4)`,
        [
          traderId,
          new Date(base.getTime()),
          new Date(base.getTime() + 3600000),
          new Date(base.getTime() + 7200000),
        ]
      );

      const result = await exec(
        `SELECT COALESCE(SUM(payment), 0)::numeric as funding_pnl
         FROM ${TEST_SCHEMA}.funding_payments
         WHERE trader_id = $1`,
        [traderId]
      );

      expect(parseFloat(result.rows[0].funding_pnl)).toBeCloseTo(72.75, 2);
    });
  });

  describe('data_gaps table', () => {
    let traderId: number;

    beforeAll(async () => {
      const res = await exec(
        `INSERT INTO ${TEST_SCHEMA}.traders (address) VALUES ($1) RETURNING id`,
        ['0xgaps00000000000000000000000000000000001']
      );
      traderId = res.rows[0].id;
    });

    it('should insert and query unresolved gaps', async () => {
      await exec(
        `INSERT INTO ${TEST_SCHEMA}.data_gaps (trader_id, gap_start, gap_end, gap_type)
         VALUES ($1, '2026-02-20 10:00:00Z', '2026-02-20 10:30:00Z', 'snapshots')`,
        [traderId]
      );

      const result = await exec(
        `SELECT * FROM ${TEST_SCHEMA}.data_gaps
         WHERE trader_id = $1 AND resolved_at IS NULL`,
        [traderId]
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].gap_type).toBe('snapshots');
    });

    it('should mark gaps as resolved', async () => {
      await exec(
        `UPDATE ${TEST_SCHEMA}.data_gaps
         SET resolved_at = NOW()
         WHERE trader_id = $1 AND resolved_at IS NULL`,
        [traderId]
      );

      const result = await exec(
        `SELECT * FROM ${TEST_SCHEMA}.data_gaps
         WHERE trader_id = $1 AND resolved_at IS NULL`,
        [traderId]
      );
      expect(result.rows).toHaveLength(0);
    });
  });
});
