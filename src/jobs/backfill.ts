import { Queue, Worker, Job } from 'bullmq';
import { firstValueFrom, from, concat } from 'rxjs';
import { mergeMap, tap, toArray } from 'rxjs/operators';

import { fetchUserFills, fetchUserFunding } from '../hyperliquid/client.js';
import { parseTradeFromApi, parseFundingFromApi, applyTrade, applyFunding, createInitialState, createSnapshot } from '../pnl/calculator.js';
import type { PnLStateData } from '../pnl/types.js';
import { cache } from '../storage/cache/redis.js';
import { tradersRepo, snapshotsRepo } from '../storage/db/repositories/index.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

interface BackfillJobData {
  traderId: number;
  address: string;
  startTime: number;
  endTime: number;
}

interface BackfillProgress {
  fills: number;
  funding: number;
  snapshots: number;
}

const QUEUE_NAME = 'backfill';
const DAY_MS = 24 * 60 * 60 * 1000;

export const backfillQueue = new Queue<BackfillJobData>(QUEUE_NAME, {
  connection: {
    host: new URL(config.REDIS_URL).hostname,
    port: parseInt(new URL(config.REDIS_URL).port || '6379'),
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

async function processBackfillJob(job: Job<BackfillJobData>): Promise<void> {
  const { traderId, address, startTime, endTime } = job.data;

  logger.info(
    { traderId, address, startTime: new Date(startTime), endTime: new Date(endTime) },
    'Starting backfill job'
  );

  let state = createInitialState(traderId, address);
  const progress: BackfillProgress = { fills: 0, funding: 0, snapshots: 0 };

  const dayChunks: Array<{ start: number; end: number }> = [];
  let current = startTime;
  while (current < endTime) {
    const chunkEnd = Math.min(current + DAY_MS, endTime);
    dayChunks.push({ start: current, end: chunkEnd });
    current = chunkEnd;
  }

  for (let i = 0; i < dayChunks.length; i++) {
    const chunk = dayChunks[i]!;

    const fills = await firstValueFrom(fetchUserFills(address, chunk.start, chunk.end));
    const funding = await firstValueFrom(fetchUserFunding(address, chunk.start, chunk.end));

    for (const fill of fills.sort((a, b) => a.time - b.time)) {
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
      progress.fills++;
    }

    for (const fund of funding.sort((a, b) => a.time - b.time)) {
      const fundingData = parseFundingFromApi(
        fund.coin,
        fund.fundingRate,
        fund.usdc,
        fund.szi,
        fund.time
      );
      state = applyFunding(state, fundingData);
      progress.funding++;
    }

    const snapshot = createSnapshot(state);
    await snapshotsRepo.insert({
      traderId: snapshot.traderId,
      timestamp: new Date(chunk.end),
      realizedPnl: snapshot.realizedPnl,
      unrealizedPnl: snapshot.unrealizedPnl,
      totalPnl: snapshot.totalPnl,
      fundingPnl: snapshot.fundingPnl,
      tradingPnl: snapshot.tradingPnl,
      openPositions: snapshot.openPositions,
      totalVolume: snapshot.totalVolume,
      accountValue: snapshot.accountValue,
    });
    progress.snapshots++;

    await job.updateProgress({
      percent: Math.round(((i + 1) / dayChunks.length) * 100),
      ...progress,
    });

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  logger.info(
    { traderId, address, ...progress },
    'Backfill job completed'
  );
}

export function createBackfillWorker(): Worker<BackfillJobData> {
  const worker = new Worker<BackfillJobData>(QUEUE_NAME, processBackfillJob, {
    connection: {
      host: new URL(config.REDIS_URL).hostname,
      port: parseInt(new URL(config.REDIS_URL).port || '6379'),
    },
    concurrency: 2,
  });

  worker.on('completed', job => {
    logger.info({ jobId: job.id, address: job.data.address }, 'Backfill job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, address: job?.data.address, error: err.message },
      'Backfill job failed'
    );
  });

  worker.on('progress', (job, progress) => {
    logger.debug({ jobId: job.id, progress }, 'Backfill job progress');
  });

  return worker;
}

export async function scheduleBackfill(
  address: string,
  days: number = config.BACKFILL_DAYS
): Promise<Job<BackfillJobData>> {
  const trader = await tradersRepo.findOrCreate(address);

  const endTime = Date.now();
  const startTime = endTime - days * DAY_MS;

  const job = await backfillQueue.add(
    `backfill-${address}`,
    {
      traderId: trader.id,
      address,
      startTime,
      endTime,
    },
    {
      jobId: `backfill-${address}-${startTime}`,
    }
  );

  logger.info(
    { jobId: job.id, address, days },
    'Backfill job scheduled'
  );

  return job;
}

export async function getBackfillStatus(address: string): Promise<{
  isActive: boolean;
  jobs: Array<{ id: string; progress: unknown; state: string }>;
}> {
  const jobs = await backfillQueue.getJobs(['active', 'waiting', 'delayed']);
  const addressJobs = jobs.filter(j => j.data.address === address);

  return {
    isActive: addressJobs.some(j => j.isActive()),
    jobs: await Promise.all(
      addressJobs.map(async j => ({
        id: j.id!,
        progress: await j.progress,
        state: await j.getState(),
      }))
    ),
  };
}
