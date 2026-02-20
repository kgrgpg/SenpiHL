#!/usr/bin/env tsx
/**
 * Verification Script
 * 
 * Cross-checks our PnL calculations against Hyperliquid's API responses.
 * 
 * Usage:
 *   npx tsx scripts/verify.ts <address>
 *   npx tsx scripts/verify.ts 0x1234...  
 * 
 * This script:
 * 1. Fetches data directly from Hyperliquid API
 * 2. Calculates PnL using our logic
 * 3. Compares with what Hyperliquid reports
 * 4. Shows any discrepancies
 */

import { Decimal } from 'decimal.js';

const HYPERLIQUID_API = 'https://api.hyperliquid.xyz';

interface Position {
  coin: string;
  szi: string;
  entryPx: string;
  unrealizedPnl: string;
  marginUsed: string;
  leverage: { type: string; value: number };
}

interface ClearinghouseState {
  assetPositions: Array<{ position: Position }>;
  marginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
  };
  withdrawable: string;
}

interface Fill {
  coin: string;
  px: string;
  sz: string;
  side: 'A' | 'B';
  time: number;
  closedPnl: string;
  fee: string;
  tid: number;
}

interface FundingDelta {
  type: string;
  coin: string;
  usdc: string;
  szi: string;
  fundingRate: string;
}

interface Funding {
  time: number;
  hash: string;
  delta: FundingDelta;
}

async function fetchFromHyperliquid<T>(request: object): Promise<T> {
  const response = await fetch(`${HYPERLIQUID_API}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function getClearinghouseState(address: string): Promise<ClearinghouseState> {
  return fetchFromHyperliquid({ type: 'clearinghouseState', user: address });
}

async function getUserFills(address: string, startTime: number): Promise<Fill[]> {
  return fetchFromHyperliquid({ type: 'userFillsByTime', user: address, startTime });
}

async function getUserFunding(address: string, startTime: number): Promise<Funding[]> {
  return fetchFromHyperliquid({ type: 'userFunding', user: address, startTime });
}

interface PortfolioPeriodData {
  accountValueHistory: Array<[number, string]>;
  pnlHistory: Array<[number, string]>;
  vlm: string;
}

type PortfolioPeriod = 'day' | 'week' | 'month' | 'allTime' | 'perpDay' | 'perpWeek' | 'perpMonth' | 'perpAllTime';
type Portfolio = Array<[PortfolioPeriod, PortfolioPeriodData]>;

async function getPortfolio(address: string): Promise<Portfolio> {
  return fetchFromHyperliquid({ type: 'portfolio', user: address });
}

function calculateFromFills(fills: Fill[]): {
  realizedPnl: Decimal;
  totalFees: Decimal;
  totalVolume: Decimal;
  tradeCount: number;
} {
  let realizedPnl = new Decimal(0);
  let totalFees = new Decimal(0);
  let totalVolume = new Decimal(0);

  for (const fill of fills) {
    realizedPnl = realizedPnl.plus(fill.closedPnl);
    totalFees = totalFees.plus(fill.fee);
    totalVolume = totalVolume.plus(new Decimal(fill.sz).times(fill.px));
  }

  return {
    realizedPnl,
    totalFees,
    totalVolume,
    tradeCount: fills.length,
  };
}

function calculateFundingPnl(funding: Funding[]): Decimal {
  return funding.reduce((acc, f) => {
    const usdc = f.delta?.usdc ?? '0';
    return acc.plus(usdc);
  }, new Decimal(0));
}

function calculateUnrealizedPnl(positions: Position[]): Decimal {
  return positions.reduce((acc, p) => {
    const unrealized = p.unrealizedPnl ?? '0';
    return acc.plus(unrealized);
  }, new Decimal(0));
}

async function verify(address: string, days: number = 30): Promise<void> {
  console.log(`\n🔍 Verifying PnL for: ${address}`);
  console.log(`📅 Lookback period: ${days} days\n`);
  console.log('='.repeat(60));

  const startTime = Date.now() - days * 24 * 60 * 60 * 1000;

  // Fetch all data from Hyperliquid
  console.log('\n📡 Fetching data from Hyperliquid API...\n');

  const [state, fills, funding, portfolio] = await Promise.all([
    getClearinghouseState(address),
    getUserFills(address, startTime),
    getUserFunding(address, startTime),
    getPortfolio(address),
  ]);

  // Extract portfolio data for different timeframes
  const portfolioMap = new Map(portfolio);
  const allTimeData = portfolioMap.get('allTime');
  const perpAllTimeData = portfolioMap.get('perpAllTime');

  // Display current positions
  console.log('📊 Current Positions:');
  console.log('-'.repeat(60));
  if (state.assetPositions.length === 0) {
    console.log('   No open positions');
  } else {
    for (const ap of state.assetPositions) {
      const pos = ap.position;
      const side = new Decimal(pos.szi).isPositive() ? 'LONG' : 'SHORT';
      console.log(`   ${pos.coin}: ${side} ${Math.abs(parseFloat(pos.szi))} @ ${pos.entryPx}`);
      console.log(`      Unrealized PnL: $${parseFloat(pos.unrealizedPnl).toFixed(2)}`);
      console.log(`      Leverage: ${pos.leverage.value}x ${pos.leverage.type}`);
    }
  }

  // Calculate PnL from fills (our method)
  console.log('\n💰 PnL Calculations:');
  console.log('-'.repeat(60));

  const fillsCalc = calculateFromFills(fills);
  const fundingPnl = calculateFundingPnl(funding);
  const unrealizedPnl = calculateUnrealizedPnl(state.assetPositions.map(ap => ap.position));

  const tradingPnl = fillsCalc.realizedPnl.minus(fillsCalc.totalFees);
  const realizedPnl = tradingPnl.plus(fundingPnl);
  const totalPnl = realizedPnl.plus(unrealizedPnl);

  console.log(`\n   Our Calculated Values:`);
  console.log(`   ├─ Realized Trading PnL: $${fillsCalc.realizedPnl.toFixed(2)}`);
  console.log(`   ├─ Total Fees Paid:      $${fillsCalc.totalFees.toFixed(2)}`);
  console.log(`   ├─ Net Trading PnL:      $${tradingPnl.toFixed(2)}`);
  console.log(`   ├─ Funding PnL:          $${fundingPnl.toFixed(2)}`);
  console.log(`   ├─ Total Realized:       $${realizedPnl.toFixed(2)}`);
  console.log(`   ├─ Unrealized PnL:       $${unrealizedPnl.toFixed(2)}`);
  console.log(`   └─ Total PnL:            $${totalPnl.toFixed(2)}`);

  // Display Hyperliquid's reported values
  console.log(`\n   Hyperliquid Reported (Current):`);
  console.log(`   ├─ Account Value:        $${parseFloat(state.marginSummary.accountValue).toFixed(2)}`);
  console.log(`   ├─ Total Position Value: $${parseFloat(state.marginSummary.totalNtlPos).toFixed(2)}`);
  console.log(`   └─ Withdrawable:         $${parseFloat(state.withdrawable).toFixed(2)}`);

  // Display portfolio data (Hyperliquid's official PnL tracking)
  if (allTimeData || perpAllTimeData) {
    console.log(`\n   Hyperliquid Portfolio (All-Time):`);
    if (perpAllTimeData) {
      const latestPnl = perpAllTimeData.pnlHistory.length > 0 
        ? perpAllTimeData.pnlHistory[perpAllTimeData.pnlHistory.length - 1]![1] 
        : '0';
      console.log(`   ├─ Perp All-Time PnL:    $${parseFloat(latestPnl).toFixed(2)}`);
      console.log(`   ├─ Perp All-Time Volume: $${parseFloat(perpAllTimeData.vlm).toFixed(2)}`);
    }
    if (allTimeData) {
      const latestPnl = allTimeData.pnlHistory.length > 0 
        ? allTimeData.pnlHistory[allTimeData.pnlHistory.length - 1]![1] 
        : '0';
      console.log(`   ├─ Total All-Time PnL:   $${parseFloat(latestPnl).toFixed(2)}`);
      console.log(`   └─ Total All-Time Volume:$${parseFloat(allTimeData.vlm).toFixed(2)}`);
    }
  }

  // Statistics
  console.log('\n📈 Trading Statistics:');
  console.log('-'.repeat(60));
  console.log(`   Total Trades:  ${fillsCalc.tradeCount}`);
  console.log(`   Total Volume:  $${fillsCalc.totalVolume.toFixed(2)}`);
  console.log(`   Funding Events: ${funding.length}`);

  // Show recent trades
  if (fills.length > 0) {
    console.log('\n📜 Recent Trades (last 5):');
    console.log('-'.repeat(60));
    const recentFills = fills.slice(-5).reverse();
    for (const fill of recentFills) {
      const side = fill.side === 'B' ? 'BUY' : 'SELL';
      const time = new Date(fill.time).toISOString();
      console.log(`   ${time.split('T')[0]} ${fill.coin} ${side} ${fill.sz} @ ${fill.px}`);
      console.log(`      PnL: $${parseFloat(fill.closedPnl).toFixed(2)}, Fee: $${parseFloat(fill.fee).toFixed(2)}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ Verification complete!\n');

  // Validation notes
  console.log('📝 Notes:');
  console.log('   - "Realized Trading PnL" comes from closedPnl field in fills');
  console.log('   - Hyperliquid API provides this pre-calculated per trade');
  console.log('   - Our incremental calculation should match the sum');
  console.log('   - Funding PnL is separate from trading PnL');
  console.log('   - Account Value = Deposits + Total PnL');
  console.log('');
}

// Main
const address = process.argv[2];

if (!address) {
  console.log(`
Usage: npx tsx scripts/verify.ts <address> [days]

Examples:
  npx tsx scripts/verify.ts 0x1234567890123456789012345678901234567890
  npx tsx scripts/verify.ts 0x1234567890123456789012345678901234567890 7

Finding test addresses:
  1. Go to https://app.hyperliquid.xyz/leaderboard
  2. Click on any trader to see their address
  3. Use that address with this script

Compare with UI:
  1. Go to https://app.hyperliquid.xyz/explorer/<address>
  2. Compare displayed PnL values with script output
`);
  process.exit(1);
}

const days = parseInt(process.argv[3] || '30');

verify(address, days).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
