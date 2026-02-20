import { Subject, Subscription } from 'rxjs';
import type { Worker } from 'bullmq';

import { createServer, startServer, stopServer } from './api/server.js';
import { createBackfillWorker } from './jobs/backfill.js';
import type { SnapshotData } from './pnl/types.js';
import { db } from './storage/db/client.js';
import { snapshotsRepo, tradersRepo } from './storage/db/repositories/index.js';
import { cache } from './storage/cache/redis.js';
import { createMainPipeline, initializeTraderState } from './streams/index.js';
import { logger } from './utils/logger.js';

let shutdown$ = new Subject<void>();
let pipelineSubscription: Subscription | null = null;
let backfillWorker: Worker | null = null;

async function saveSnapshots(snapshots: SnapshotData[]): Promise<void> {
  const inserts = snapshots.map(s => ({
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

async function getActiveTraders(): Promise<string[]> {
  return tradersRepo.getActiveAddresses();
}

async function initializeExistingTraders(): Promise<void> {
  const traders = await tradersRepo.getActive();
  for (const trader of traders) {
    initializeTraderState(trader.id, trader.address);
  }
  logger.info({ count: traders.length }, 'Initialized existing traders');
}

async function bootstrap(): Promise<void> {
  logger.info('Starting PnL Indexer...');

  const dbConnected = await db.checkConnection();
  if (!dbConnected) {
    throw new Error('Failed to connect to database');
  }
  logger.info('Database connected');

  await cache.connect();
  logger.info('Redis connected');

  await initializeExistingTraders();

  shutdown$ = new Subject<void>();

  const pipeline$ = createMainPipeline(getActiveTraders, saveSnapshots, shutdown$);

  pipelineSubscription = pipeline$.subscribe({
    error: err => logger.error({ error: err.message }, 'Pipeline error'),
    complete: () => logger.info('Pipeline completed'),
  });

  logger.info('Data pipeline started');

  backfillWorker = createBackfillWorker();
  logger.info('Backfill worker started');

  const app = await createServer();
  await startServer(app);

  const gracefulShutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    shutdown$.next();
    shutdown$.complete();

    await new Promise(resolve => setTimeout(resolve, 5000));

    if (pipelineSubscription) {
      pipelineSubscription.unsubscribe();
    }

    if (backfillWorker) {
      await backfillWorker.close();
    }

    await stopServer(app);
    await db.closePool();
    await cache.close();

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

bootstrap().catch(error => {
  logger.error({ error: error.message }, 'Failed to start application');
  process.exit(1);
});
