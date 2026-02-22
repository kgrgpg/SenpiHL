#!/usr/bin/env tsx
/**
 * 1-Day PnL Verification Script
 *
 * Compares PnL deltas stored in our DB over the last 24h with
 * Hyperliquid's official perpDay portfolio data for every tracked trader.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/verify-1d.ts
 *   DATABASE_URL=postgres://... npx tsx scripts/verify-1d.ts --threshold 5
 *
 * Requires the app to have been collecting snapshots for at least 24h.
 */

import pg from 'pg';
import { Decimal } from 'decimal.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL env var is required');
  process.exit(1);
}

const HYPERLIQUID_API = 'https://api.hyperliquid.xyz';
const THRESHOLD_PCT = parseFloat(
  process.argv.find((a) => a.startsWith('--threshold'))
    ? process.argv[process.argv.indexOf('--threshold') + 1] ?? '5'
    : '5'
);

interface PortfolioPeriodData {
  accountValueHistory: Array<[number, string]>;
  pnlHistory: Array<[number, string]>;
  vlm: string;
}

type PortfolioPeriod =
  | 'day'
  | 'week'
  | 'month'
  | 'allTime'
  | 'perpDay'
  | 'perpWeek'
  | 'perpMonth'
  | 'perpAllTime';

type Portfolio = Array<[PortfolioPeriod, PortfolioPeriodData]>;

async function fetchPortfolio(address: string): Promise<Portfolio> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${HYPERLIQUID_API}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'portfolio', user: address }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`API ${res.status} for ${address}`);
    return res.json() as Promise<Portfolio>;
  } finally {
    clearTimeout(timeout);
  }
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface TraderRow {
  id: number;
  address: string;
}

interface SnapshotEdge {
  total_pnl: string;
  realized_pnl: string;
  unrealized_pnl: string;
  funding_pnl: string;
  timestamp: Date;
}

interface VerificationResult {
  address: string;
  ourDelta: Decimal;
  hlDayPnl: Decimal | null;
  diffAbs: Decimal | null;
  diffPct: number | null;
  status: 'MATCH' | 'MISMATCH' | 'NO_HL_DATA' | 'NO_DB_DATA';
  snapshotCount: number;
  oldestSnapshot: Date | null;
  newestSnapshot: Date | null;
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });

  try {
    const tradersResult = await pool.query<TraderRow>(
      'SELECT id, address FROM traders WHERE is_active = true ORDER BY id'
    );
    const traders = tradersResult.rows;
    console.log(`\nFound ${traders.length} active traders in DB\n`);
    console.log('='.repeat(90));

    if (traders.length === 0) {
      console.log('No active traders. Ensure the app has been running and traders are subscribed.');
      return;
    }

    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const results: VerificationResult[] = [];

    for (let i = 0; i < traders.length; i++) {
      const trader = traders[i]!;
      if (i % 50 === 0) {
        process.stdout.write(`  Processing trader ${i + 1}/${traders.length}...\r`);
      }
      const countResult = await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text as count FROM pnl_snapshots WHERE trader_id = $1 AND timestamp >= $2',
        [trader.id, dayAgo]
      );
      const snapshotCount = parseInt(countResult.rows[0]?.count ?? '0');

      const oldestResult = await pool.query<SnapshotEdge>(
        `SELECT total_pnl, realized_pnl, unrealized_pnl, funding_pnl, timestamp
         FROM pnl_snapshots WHERE trader_id = $1 AND timestamp >= $2
         ORDER BY timestamp ASC LIMIT 1`,
        [trader.id, dayAgo]
      );

      const newestResult = await pool.query<SnapshotEdge>(
        `SELECT total_pnl, realized_pnl, unrealized_pnl, funding_pnl, timestamp
         FROM pnl_snapshots WHERE trader_id = $1
         ORDER BY timestamp DESC LIMIT 1`,
        [trader.id]
      );

      const oldest = oldestResult.rows[0];
      const newest = newestResult.rows[0];

      if (!oldest || !newest || snapshotCount < 2) {
        results.push({
          address: trader.address,
          ourDelta: new Decimal(0),
          hlDayPnl: null,
          diffAbs: null,
          diffPct: null,
          status: 'NO_DB_DATA',
          snapshotCount,
          oldestSnapshot: oldest?.timestamp ?? null,
          newestSnapshot: newest?.timestamp ?? null,
        });
        continue;
      }

      const ourDelta = new Decimal(newest.total_pnl).minus(oldest.total_pnl);

      let hlDayPnl: Decimal | null = null;
      try {
        const portfolio = await fetchPortfolio(trader.address);
        const portfolioMap = new Map(portfolio);
        const perpDay = portfolioMap.get('perpDay');
        if (perpDay && perpDay.pnlHistory.length > 0) {
          const last = perpDay.pnlHistory[perpDay.pnlHistory.length - 1]!;
          hlDayPnl = new Decimal(last[1]);
        }
      } catch (err) {
        console.warn(`  Warning: failed to fetch portfolio for ${trader.address}: ${(err as Error).message}`);
      }

      await sleep(200);

      if (hlDayPnl === null) {
        results.push({
          address: trader.address,
          ourDelta,
          hlDayPnl: null,
          diffAbs: null,
          diffPct: null,
          status: 'NO_HL_DATA',
          snapshotCount,
          oldestSnapshot: oldest.timestamp,
          newestSnapshot: newest.timestamp,
        });
        continue;
      }

      const diffAbs = ourDelta.minus(hlDayPnl).abs();
      const hlAbs = hlDayPnl.abs();
      const diffPct = hlAbs.isZero() ? (diffAbs.isZero() ? 0 : 100) : diffAbs.div(hlAbs).times(100).toNumber();
      const status = diffPct <= THRESHOLD_PCT ? 'MATCH' : 'MISMATCH';

      results.push({
        address: trader.address,
        ourDelta,
        hlDayPnl,
        diffAbs,
        diffPct,
        status,
        snapshotCount,
        oldestSnapshot: oldest.timestamp,
        newestSnapshot: newest.timestamp,
      });
    }

    // Print results
    console.log('\n  VERIFICATION RESULTS');
    console.log('='.repeat(90));
    console.log(
      padRight('Address', 44) +
        padRight('Our Delta', 14) +
        padRight('HL perpDay', 14) +
        padRight('Diff%', 8) +
        padRight('Snaps', 7) +
        'Status'
    );
    console.log('-'.repeat(90));

    let matches = 0;
    let mismatches = 0;
    let noData = 0;

    for (const r of results) {
      const addr = r.address.slice(0, 6) + '...' + r.address.slice(-4);
      const ourStr = r.ourDelta.toFixed(2);
      const hlStr = r.hlDayPnl !== null ? r.hlDayPnl.toFixed(2) : 'N/A';
      const pctStr = r.diffPct !== null ? r.diffPct.toFixed(1) + '%' : 'N/A';
      const statusIcon =
        r.status === 'MATCH' ? 'OK' : r.status === 'MISMATCH' ? 'MISMATCH' : r.status;

      console.log(
        padRight(addr, 44) +
          padRight('$' + ourStr, 14) +
          padRight('$' + hlStr, 14) +
          padRight(pctStr, 8) +
          padRight(String(r.snapshotCount), 7) +
          statusIcon
      );

      if (r.status === 'MATCH') matches++;
      else if (r.status === 'MISMATCH') mismatches++;
      else noData++;
    }

    console.log('-'.repeat(90));
    console.log(
      `\nSummary: ${matches} matched, ${mismatches} mismatched, ${noData} no data (threshold: ${THRESHOLD_PCT}%)`
    );
    console.log(`Total traders: ${results.length}`);

    if (mismatches > 0) {
      console.log('\nMISMATCHED DETAILS:');
      console.log('-'.repeat(60));
      for (const r of results.filter((r) => r.status === 'MISMATCH')) {
        console.log(`  ${r.address}`);
        console.log(`    Our 24h delta:  $${r.ourDelta.toFixed(4)}`);
        console.log(`    HL perpDay:     $${r.hlDayPnl?.toFixed(4)}`);
        console.log(`    Abs diff:       $${r.diffAbs?.toFixed(4)}`);
        console.log(`    Rel diff:       ${r.diffPct?.toFixed(2)}%`);
        console.log(`    Snapshots:      ${r.snapshotCount}`);
        console.log(`    Oldest:         ${r.oldestSnapshot?.toISOString()}`);
        console.log(`    Newest:         ${r.newestSnapshot?.toISOString()}`);
        console.log();
      }
    }

    console.log();
  } finally {
    await pool.end();
  }
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
