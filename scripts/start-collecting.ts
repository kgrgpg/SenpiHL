#!/usr/bin/env tsx
/**
 * Start Data Collection Script
 * 
 * This script:
 * 1. Connects to infrastructure (DB, Redis, WebSocket)
 * 2. Subscribes to a list of traders
 * 3. Starts collecting real-time data
 * 
 * Usage:
 *   npx tsx scripts/start-collecting.ts
 *   npx tsx scripts/start-collecting.ts --traders 0x123,0x456
 */

import { getHybridDataStream, closeHybridDataStream } from '../src/streams/sources/hybrid.stream.js';
import { getHyperliquidWebSocket } from '../src/hyperliquid/websocket.js';
import { logger } from '../src/utils/logger.js';

// Sample trader addresses from Hyperliquid leaderboard
const DEFAULT_TRADERS = [
  '0x20c2d95a3dfdca9e9ad12794d5fa6fad99da44f5', // The one we verified earlier
];

async function main() {
  console.log('\n🚀 Starting PnL Data Collection\n');
  console.log('='.repeat(60));

  // Parse command line args
  const args = process.argv.slice(2);
  const tradersArg = args.find(a => a.startsWith('--traders='));
  const traders = tradersArg 
    ? tradersArg.split('=')[1]!.split(',')
    : DEFAULT_TRADERS;

  console.log(`\n📋 Traders to track: ${traders.length}`);
  traders.forEach((t, i) => console.log(`   ${i + 1}. ${t}`));

  // Get the hybrid stream
  const hybridStream = getHybridDataStream();
  const ws = getHyperliquidWebSocket();

  // Connect WebSocket
  console.log('\n🔌 Connecting to Hyperliquid WebSocket...');
  ws.connect();

  // Wait for connection
  await new Promise<void>((resolve) => {
    const sub = ws.state$.subscribe((state) => {
      if (state === 'connected') {
        console.log('✅ WebSocket connected!\n');
        sub.unsubscribe();
        resolve();
      } else if (state === 'reconnecting') {
        console.log('⏳ Reconnecting...');
      }
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      console.log('⚠️  WebSocket connection timeout, continuing anyway...');
      sub.unsubscribe();
      resolve();
    }, 10000);
  });

  // Subscribe to traders
  console.log('📡 Subscribing to traders...\n');
  for (const address of traders) {
    hybridStream.subscribeTrader(address);
    console.log(`   ✅ Subscribed: ${address.slice(0, 10)}...${address.slice(-6)}`);
  }

  console.log(`\n📊 Active subscriptions: ${hybridStream.traderCount}`);
  console.log('='.repeat(60));

  // Listen to events
  console.log('\n🎧 Listening for events (Ctrl+C to stop)...\n');

  let fillCount = 0;
  let snapshotCount = 0;

  hybridStream.stream$.subscribe({
    next: (event) => {
      if (event.type === 'fill') {
        fillCount++;
        const fill = event.data as { coin: string; side: string; sz: string; px: string };
        console.log(
          `📈 [FILL] ${event.address.slice(0, 10)}... | ` +
          `${fill.coin} ${fill.side === 'B' ? 'BUY' : 'SELL'} ${fill.sz} @ ${fill.px}`
        );
      } else if (event.type === 'snapshot') {
        snapshotCount++;
        const snapshot = event.data as { 
          marginSummary: { accountValue: string };
          assetPositions: unknown[];
        };
        console.log(
          `📸 [SNAPSHOT] ${event.address.slice(0, 10)}... | ` +
          `Account: $${parseFloat(snapshot.marginSummary.accountValue).toFixed(2)} | ` +
          `Positions: ${snapshot.assetPositions.length}`
        );
      }
    },
    error: (err) => {
      console.error('❌ Stream error:', err.message);
    },
  });

  // Status updates every 30 seconds
  setInterval(() => {
    console.log(
      `\n📊 Status: ${fillCount} fills, ${snapshotCount} snapshots | ` +
      `${hybridStream.traderCount} traders tracked\n`
    );
  }, 30000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Shutting down...');
    console.log(`   Total fills received: ${fillCount}`);
    console.log(`   Total snapshots: ${snapshotCount}`);
    closeHybridDataStream();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
