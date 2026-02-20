/**
 * PnL Indexer - Main Entry Point
 *
 * This is the main application that:
 * 1. Connects to Hyperliquid via WebSocket + REST API (hybrid mode)
 * 2. Discovers new traders automatically from market trades
 * 3. Auto-subscribes discovered traders
 * 4. Calculates and stores PnL snapshots
 * 5. Serves data via REST API
 *
 * Data Flow:
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  Discovery Stream ──▶ Discovery Queue ──▶ Auto-Subscribe Job           │
 * │                                                │                        │
 * │                                                ▼                        │
 * │  Hybrid Stream (WS + Polling) ──▶ PnL Calculator ──▶ TimescaleDB       │
 * │                                                                         │
 * │  API Server ◀────────────────────────────────────────────────────────── │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import { Subject, Subscription, EMPTY } from 'rxjs';
import { takeUntil, catchError, tap, filter, bufferTime, mergeMap } from 'rxjs/operators';
import type { Worker } from 'bullmq';

import { createServer, startServer, stopServer } from './api/server.js';
import { createBackfillWorker } from './jobs/backfill.js';
import { startAutoSubscribeJob, processDiscoveryQueue } from './jobs/auto-subscribe.js';
import {
  createSnapshot,
  parsePositionFromApi,
  parseTradeFromApi,
  applyTrade,
  updatePositions,
} from './pnl/calculator.js';
import type { SnapshotData } from './pnl/types.js';
import { toDecimal } from './utils/decimal.js';
import { db } from './storage/db/client.js';
import { snapshotsRepo, tradersRepo } from './storage/db/repositories/index.js';
import { cache } from './storage/cache/redis.js';
import { config } from './utils/config.js';
import { logger } from './utils/logger.js';

// Hybrid mode imports
import {
  getHybridDataStream,
  closeHybridDataStream,
  type HybridEvent,
} from './streams/sources/hybrid.stream.js';
import {
  getTraderDiscoveryStream,
  stopTraderDiscovery,
} from './streams/sources/trader-discovery.stream.js';
import { closeHyperliquidWebSocket } from './hyperliquid/websocket.js';
import type { HyperliquidClearinghouseState } from './hyperliquid/types.js';
import type { WebSocketFill } from './hyperliquid/websocket.js';

// Shared state management
import {
  getTraderState,
  setTraderState,
  initializeTraderState,
} from './state/trader-state.js';

// Legacy polling imports (fallback mode)
import { createMainPipeline } from './streams/index.js';

let shutdown$ = new Subject<void>();
let pipelineSubscription: Subscription | null = null;
let backfillWorker: Worker | null = null;
let autoSubscribeInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Process a fill event from WebSocket
 */
function processHybridFill(address: string, fill: WebSocketFill): SnapshotData | null {
  let state = getTraderState(address);
  if (!state) {
    return null;
  }

  const trade = parseTradeFromApi(
    fill.coin,
    fill.side,
    fill.sz,
    fill.px,
    fill.closedPnl,
    fill.fee,
    fill.time,
    fill.tid
  );

  state = applyTrade(state, trade);
  setTraderState(address, state);

  return createSnapshot(state);
}

/**
 * Process a snapshot event from polling
 */
function processHybridSnapshot(
  address: string,
  clearinghouse: HyperliquidClearinghouseState
): SnapshotData | null {
  let state = getTraderState(address);
  if (!state) {
    return null;
  }

  const positions = clearinghouse.assetPositions.map((ap) => {
    const pos = ap.position;
    return parsePositionFromApi(
      pos.coin,
      pos.szi,
      pos.entryPx,
      pos.unrealizedPnl,
      pos.leverage.value,
      pos.liquidationPx,
      pos.marginUsed
    );
  });

  state = updatePositions(state, positions);
  setTraderState(address, state);

  const accountValue = toDecimal(clearinghouse.marginSummary.accountValue);
  return createSnapshot(state, accountValue);
}

/**
 * Save snapshots to database
 */
async function saveSnapshots(snapshots: SnapshotData[]): Promise<void> {
  if (snapshots.length === 0) return;

  const inserts = snapshots.map((s) => ({
    traderId: s.traderId,
    timestamp: s.timestamp,
    realizedPnl: s.realizedPnl,
    unrealizedPnl: s.unrealizedPnl,
    totalPnl: s.totalPnl,
    fundingPnl: s.fundingPnl,
    tradingPnl: s.tradingPnl,
    openPositions: s.openPositions,
    totalVolume: s.totalVolume,
    accountValue: s.accountValue,
  }));

  await snapshotsRepo.insertMany(inserts);
}


/**
 * Bootstrap the application in HYBRID MODE
 * - WebSocket for real-time fills
 * - Polling for position snapshots (every 5 min)
 * - Auto-discovery of new traders
 * - Auto-subscribe job
 */
async function bootstrapHybridMode(): Promise<void> {
  logger.info('Starting in HYBRID MODE (WebSocket + Polling)');

  // Initialize the hybrid data stream
  const hybridStream = getHybridDataStream();
  hybridStream.connect();

  // Wait for WebSocket connection
  await new Promise<void>((resolve) => {
    const checkConnection = setInterval(() => {
      // Give it a moment to connect
      setTimeout(() => {
        clearInterval(checkConnection);
        resolve();
      }, 2000);
    }, 100);
  });

  logger.info('WebSocket connected');

  // Load existing traders and subscribe them
  const existingTraders = await tradersRepo.getActive();
  for (const trader of existingTraders) {
    initializeTraderState(trader.id, trader.address);
    hybridStream.subscribeTrader(trader.address);
  }
  logger.info({ count: existingTraders.length }, 'Subscribed existing traders to hybrid stream');

  // Process hybrid events and save to database
  pipelineSubscription = hybridStream.stream$
    .pipe(
      tap((event) => {
        logger.debug(
          { type: event.type, address: event.address.slice(0, 10) + '...' },
          'Received hybrid event'
        );
      }),
      // Process events and generate snapshots
      mergeMap(async (event: HybridEvent) => {
        let snapshot: SnapshotData | null = null;

        // Ensure trader state exists
        const trader = await tradersRepo.findByAddress(event.address);
        if (!trader) {
          return null;
        }
        initializeTraderState(trader.id, event.address);

        if (event.type === 'fill') {
          snapshot = processHybridFill(event.address, event.data as WebSocketFill);
        } else if (event.type === 'snapshot') {
          snapshot = processHybridSnapshot(
            event.address,
            event.data as HyperliquidClearinghouseState
          );
        }

        return snapshot;
      }),
      filter((snapshot): snapshot is SnapshotData => snapshot !== null),
      // Buffer and batch write
      bufferTime(30000), // Buffer for 30 seconds
      filter((batch) => batch.length > 0),
      mergeMap(async (batch) => {
        try {
          await saveSnapshots(batch);
          logger.info({ count: batch.length }, 'Saved PnL snapshots (hybrid mode)');
        } catch (err) {
          logger.error({ error: (err as Error).message }, 'Failed to save snapshots');
        }
      }),
      takeUntil(shutdown$),
      catchError((err) => {
        logger.error({ error: (err as Error).message }, 'Hybrid pipeline error');
        return EMPTY;
      })
    )
    .subscribe();

  logger.info('Hybrid data pipeline started');

  // Start trader discovery
  const discoveryStream = getTraderDiscoveryStream();
  await discoveryStream.start();
  logger.info('Trader discovery started');

  // Start auto-subscribe job (processes discovery queue every 60 seconds)
  autoSubscribeInterval = startAutoSubscribeJob(60000);
  logger.info('Auto-subscribe job started');

  // Process discovery queue immediately
  await processDiscoveryQueue();
}

/**
 * Bootstrap the application in LEGACY MODE (polling only)
 * Used when USE_HYBRID_MODE=false
 */
async function bootstrapLegacyMode(): Promise<void> {
  logger.info('Starting in LEGACY MODE (Polling only)');

  // Initialize existing traders
  const traders = await tradersRepo.getActive();
  for (const trader of traders) {
    initializeTraderState(trader.id, trader.address);
  }
  logger.info({ count: traders.length }, 'Initialized existing traders');

  // Create the polling-based pipeline
  const getActiveTraders = () => tradersRepo.getActiveAddresses();

  const pipeline$ = createMainPipeline(getActiveTraders, saveSnapshots, shutdown$);

  pipelineSubscription = pipeline$.subscribe({
    error: (err) => logger.error({ error: err.message }, 'Pipeline error'),
    complete: () => logger.info('Pipeline completed'),
  });

  logger.info('Data pipeline started (legacy polling mode)');
}

/**
 * Main bootstrap function
 */
async function bootstrap(): Promise<void> {
  logger.info('Starting PnL Indexer...');
  logger.info({
    mode: config.USE_HYBRID_MODE ? 'HYBRID' : 'LEGACY',
    pollInterval: config.POLL_INTERVAL_MS,
  }, 'Configuration');

  // Connect to database
  const dbConnected = await db.checkConnection();
  if (!dbConnected) {
    throw new Error('Failed to connect to database');
  }
  logger.info('Database connected');

  // Connect to Redis
  await cache.connect();
  logger.info('Redis connected');

  // Reset shutdown signal
  shutdown$ = new Subject<void>();

  // Choose mode based on configuration
  if (config.USE_HYBRID_MODE) {
    await bootstrapHybridMode();
  } else {
    await bootstrapLegacyMode();
  }

  // Start backfill worker (shared between modes)
  backfillWorker = createBackfillWorker();
  logger.info('Backfill worker started');

  // Start API server
  const app = await createServer();
  await startServer(app);

  // Graceful shutdown handler
  const gracefulShutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    // Signal all streams to stop
    shutdown$.next();
    shutdown$.complete();

    // Wait for in-flight operations
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Cleanup subscriptions
    if (pipelineSubscription) {
      pipelineSubscription.unsubscribe();
    }

    // Stop auto-subscribe job
    if (autoSubscribeInterval) {
      clearInterval(autoSubscribeInterval);
    }

    // Stop discovery
    stopTraderDiscovery();

    // Close hybrid stream and WebSocket
    closeHybridDataStream();
    closeHyperliquidWebSocket();

    // Stop backfill worker
    if (backfillWorker) {
      await backfillWorker.close();
    }

    // Stop API server
    await stopServer(app);

    // Close database and cache connections
    await db.closePool();
    await cache.close();

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

// Start the application
bootstrap().catch((error) => {
  logger.error({ error: error.message }, 'Failed to start application');
  process.exit(1);
});
