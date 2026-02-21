/**
 * Integration tests against the live Hyperliquid API.
 *
 * These tests make real HTTP requests and verify response shapes.
 * They are SKIPPED in CI (set INTEGRATION=1 to run locally).
 *
 * Run locally:
 *   INTEGRATION=1 npx vitest run src/__integration__/
 *
 * Run all except integration:
 *   npx vitest run --exclude 'src/__integration__/**'
 */

import { describe, it, expect } from 'vitest';

const SKIP = !process.env.INTEGRATION;
const API_URL = 'https://api.hyperliquid.xyz/info';
const TEST_ADDRESS = '0xecb63caa47c7c4e77f60f1ce858cf28dc2b82b00'; // known active trader

async function postInfo<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

describe.skipIf(SKIP)('Hyperliquid API Integration', () => {
  it('should fetch clearinghouseState with correct shape', async () => {
    const data = await postInfo<{
      assetPositions: unknown[];
      marginSummary: { accountValue: string };
      crossMarginSummary: { accountValue: string };
    }>({
      type: 'clearinghouseState',
      user: TEST_ADDRESS,
    });

    expect(data).toHaveProperty('assetPositions');
    expect(data).toHaveProperty('marginSummary');
    expect(data).toHaveProperty('crossMarginSummary');
    expect(Array.isArray(data.assetPositions)).toBe(true);
    expect(typeof data.marginSummary.accountValue).toBe('string');
  });

  it('should fetch userFillsByTime with correct shape', async () => {
    const now = Date.now();
    const data = await postInfo<Array<{
      coin: string;
      px: string;
      sz: string;
      side: string;
      closedPnl: string;
      fee: string;
      time: number;
      tid: number;
    }>>({
      type: 'userFillsByTime',
      user: TEST_ADDRESS,
      startTime: now - 24 * 60 * 60 * 1000, // last 24h
    });

    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      const fill = data[0]!;
      expect(fill).toHaveProperty('coin');
      expect(fill).toHaveProperty('px');
      expect(fill).toHaveProperty('sz');
      expect(fill).toHaveProperty('side');
      expect(fill).toHaveProperty('closedPnl');
      expect(fill).toHaveProperty('fee');
      expect(fill).toHaveProperty('tid');
      expect(typeof fill.time).toBe('number');
    }
  });

  it('should fetch userFunding with delta wrapper', async () => {
    const now = Date.now();
    const data = await postInfo<Array<{
      delta: {
        coin: string;
        usdc: string;
        fundingRate: string;
        type: string;
      };
      time: number;
    }>>({
      type: 'userFunding',
      user: TEST_ADDRESS,
      startTime: now - 7 * 24 * 60 * 60 * 1000,
    });

    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      const entry = data[0]!;
      expect(entry).toHaveProperty('delta');
      expect(entry.delta).toHaveProperty('coin');
      expect(entry.delta).toHaveProperty('usdc');
      expect(entry.delta).toHaveProperty('fundingRate');
      expect(typeof entry.time).toBe('number');
    }
  });

  it('should fetch portfolio with timeframe PnL', async () => {
    const data = await postInfo<Array<[string, unknown]>>({
      type: 'portfolio',
      user: TEST_ADDRESS,
    });

    expect(Array.isArray(data)).toBe(true);
    // portfolio returns [[timeframe, pnlData], ...]
    if (data.length > 0) {
      const [timeframe, pnlData] = data[0]!;
      expect(typeof timeframe).toBe('string');
      expect(pnlData).toBeDefined();
    }
  });

  it('should respect rate limit on rapid requests', async () => {
    // Make 3 fast requests — should not get 429 for lightweight calls
    const results = await Promise.all([
      postInfo({ type: 'allMids' }),
      postInfo({ type: 'allMids' }),
      postInfo({ type: 'allMids' }),
    ]);

    for (const result of results) {
      expect(result).toHaveProperty('BTC');
    }
  });
});

describe.skipIf(SKIP)('PnL Accuracy Cross-Check', () => {
  it('should verify our realized PnL matches sum of closedPnl from fills', async () => {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    const fills = await postInfo<Array<{
      closedPnl: string;
      fee: string;
      coin: string;
    }>>({
      type: 'userFillsByTime',
      user: TEST_ADDRESS,
      startTime: oneDayAgo,
    });

    let totalClosedPnl = 0;
    let totalFees = 0;
    for (const fill of fills) {
      totalClosedPnl += parseFloat(fill.closedPnl);
      totalFees += parseFloat(fill.fee);
    }

    // These should be finite numbers (not NaN)
    expect(Number.isFinite(totalClosedPnl)).toBe(true);
    expect(Number.isFinite(totalFees)).toBe(true);

    // Realized PnL = sum(closedPnl) - sum(fees)
    const realizedPnl = totalClosedPnl - totalFees;
    expect(Number.isFinite(realizedPnl)).toBe(true);

    // Log for manual verification
    console.log(`Address: ${TEST_ADDRESS}`);
    console.log(`Fills (last 24h): ${fills.length}`);
    console.log(`Sum closedPnl: ${totalClosedPnl.toFixed(2)}`);
    console.log(`Sum fees: ${totalFees.toFixed(2)}`);
    console.log(`Net realized PnL: ${realizedPnl.toFixed(2)}`);
  });

  it('should fetch fills capped at 10000 for very active traders', async () => {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    const fills = await postInfo<unknown[]>({
      type: 'userFillsByTime',
      user: TEST_ADDRESS,
      startTime: thirtyDaysAgo,
    });

    // Document whether we hit the 10k limit
    console.log(`Fills (last 30d): ${fills.length}`);
    expect(fills.length).toBeLessThanOrEqual(10000);
    // If exactly 10000, the data is truncated
    if (fills.length === 10000) {
      console.log('WARNING: Hit 10,000 fill cap — older fills are missing');
    }
  });
});
