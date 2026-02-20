#!/usr/bin/env tsx
/**
 * Test WebSocket Connection
 * 
 * Standalone script to test Hyperliquid WebSocket - no database required.
 * 
 * Usage:
 *   npx tsx scripts/test-websocket.ts [address]
 */

import WebSocket from 'ws';

const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const DEFAULT_ADDRESS = '0x20c2d95a3dfdca9e9ad12794d5fa6fad99da44f5';

async function main() {
  const address = process.argv[2] || DEFAULT_ADDRESS;
  
  console.log('\n🔌 Connecting to Hyperliquid WebSocket...');
  console.log(`   URL: ${WS_URL}`);
  console.log(`   Trader: ${address}\n`);

  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('✅ Connected!\n');

    // Subscribe to user fills
    const subscription = {
      method: 'subscribe',
      subscription: {
        type: 'userFills',
        user: address,
      },
    };

    console.log('📡 Subscribing to userFills...');
    ws.send(JSON.stringify(subscription));

    // Also subscribe to user events
    const eventsSubscription = {
      method: 'subscribe',
      subscription: {
        type: 'userEvents',
        user: address,
      },
    };

    console.log('📡 Subscribing to userEvents...');
    ws.send(JSON.stringify(eventsSubscription));

    console.log('\n🎧 Listening for events (Ctrl+C to stop)...\n');
    console.log('='.repeat(60));
  });

  ws.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.channel === 'subscriptionResponse') {
        console.log(`✅ Subscription confirmed: ${message.data?.subscription?.type}`);
      } else if (message.channel === 'userFills') {
        const fills = message.data?.fills || [];
        for (const fill of fills) {
          const side = fill.side === 'B' ? 'BUY' : 'SELL';
          console.log(
            `📈 [FILL] ${fill.coin} ${side} ${fill.sz} @ ${fill.px} | ` +
            `PnL: $${parseFloat(fill.closedPnl || '0').toFixed(2)} | ` +
            `Fee: $${parseFloat(fill.fee || '0').toFixed(4)}`
          );
        }
      } else if (message.channel === 'userEvents') {
        console.log(`📬 [EVENT] Type: ${message.data?.type || 'unknown'}`);
        if (message.data?.fills) {
          for (const fill of message.data.fills) {
            console.log(`   └─ Fill: ${fill.coin} ${fill.side === 'B' ? 'BUY' : 'SELL'} ${fill.sz}`);
          }
        }
      } else if (message.channel === 'error') {
        console.error('❌ Error:', message.data);
      } else {
        console.log(`📨 [${message.channel || 'unknown'}]`, JSON.stringify(message.data).slice(0, 100));
      }
    } catch (err) {
      console.error('Parse error:', (err as Error).message);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`\n🔌 Disconnected: ${code} - ${reason.toString()}`);
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
  });

  // Keep alive with ping every 30s
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Closing connection...');
    clearInterval(pingInterval);
    ws.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
