#!/usr/bin/env tsx
/**
 * Test Trader Discovery via REST API
 * 
 * Polls recentTrades endpoint to discover trader addresses.
 * The recentTrades endpoint includes both buyer and seller addresses!
 * 
 * Usage:
 *   npx tsx scripts/test-discovery.ts
 */

const API_URL = 'https://api.hyperliquid.xyz/info';
const COINS_TO_WATCH = ['ETH', 'BTC', 'SOL', 'ARB', 'DOGE', 'WIF'];

interface RecentTrade {
  coin: string;
  side: string;
  px: string;
  sz: string;
  time: number;
  hash: string;
  tid: number;
  users: string[];
}

const discoveredAddresses = new Set<string>();
let tradeCount = 0;

async function fetchRecentTrades(coin: string): Promise<RecentTrade[]> {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'recentTrades', coin }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json() as Promise<RecentTrade[]>;
}

async function discoverTraders() {
  console.log('\n🔍 Polling recentTrades for trader addresses...\n');

  for (const coin of COINS_TO_WATCH) {
    try {
      const trades = await fetchRecentTrades(coin);
      let newInCoin = 0;

      for (const trade of trades) {
        tradeCount++;
        if (trade.users) {
          for (const address of trade.users) {
            if (!discoveredAddresses.has(address.toLowerCase())) {
              discoveredAddresses.add(address.toLowerCase());
              newInCoin++;
              console.log(
                `🆕 NEW: ${address.slice(0, 10)}...${address.slice(-6)} | ` +
                `${coin} ${trade.side === 'B' ? 'BUY' : 'SELL'} ${trade.sz} @ ${trade.px}`
              );
            }
          }
        }
      }

      if (newInCoin > 0) {
        console.log(`   └─ Found ${newInCoin} new traders in ${coin}\n`);
      }

      // Small delay between coins
      await new Promise((r) => setTimeout(r, 100));
    } catch (err) {
      console.error(`❌ Error fetching ${coin}:`, (err as Error).message);
    }
  }
}

async function main() {
  console.log('\n🔍 Trader Discovery Test (REST API)\n');
  console.log('='.repeat(60));
  console.log(`Polling markets: ${COINS_TO_WATCH.join(', ')}`);
  console.log('Discovering trader addresses from recentTrades...\n');

  // Initial discovery
  await discoverTraders();
  printStats();

  console.log('\n📡 Polling every 30 seconds (Ctrl+C to stop)...\n');

  // Periodic polling
  const interval = setInterval(async () => {
    await discoverTraders();
    printStats();
  }, 30000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Stopping discovery...');
    clearInterval(interval);
    printStats();
    process.exit(0);
  });
}

function printStats() {
  console.log('\n' + '='.repeat(60));
  console.log(`📊 Stats: ${discoveredAddresses.size} unique traders from ${tradeCount} trades`);
  console.log(`📈 At this rate, polling 8 coins every 5 min = ~${Math.round(discoveredAddresses.size * 12 * 24)} traders/day`);
  console.log('='.repeat(60) + '\n');
}

main().catch(console.error);
