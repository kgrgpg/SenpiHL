/**
 * Backfill Job
 *
 * Processes historical data for newly subscribed traders.
 * Uses RxJS patterns internally while integrating with BullMQ.
 */

import { Queue, Worker, Job } from 'bullmq';
import { firstValueFrom, from, forkJoin, of, Observable } from 'rxjs';
import { mergeMap, tap, map, catchError, concatMap, reduce, delay } from 'rxjs/operators';

import { fetchUserFills, fetchUserFunding } from '../hyperliquid/client.js';
import {
  parseTradeFromApi,
  parseFundingFromApi,
  applyTrade,
  applyFunding,
  createInitialState,
  createSnapshot,
} from '../pnl/calculator.js';
import type { PnLStateData } from '../pnl/types.js';
import { snapshotsRepo, tradersRepo } from '../storage/db/repositories/index.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

interface BackfillJobData {
  traderId: number;
  address: string;
  startTime: number;
  endTime: number;
}

interface ChunkResult {
  fills: number;
  funding: number;
  state: PnLStateData;
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

/**
 * Process a single day chunk (returns Observable)
 */
function processChunk$(
  address: string,
  chunk: { start: number; end: number },
  initialState: PnLStateData
): Observable<ChunkResult> {
  // Fetch fills and funding in parallel using forkJoin
  return forkJoin({
    fills: fetchUserFills(address, chunk.start, chunk.end),
    funding: fetchUserFunding(address, chunk.start, chunk.end),
  }).pipe(
    map(({ fills, funding }) => {
      let state = initialState;
      let fillCount = 0;
      let fundingCount = 0;

      // Apply fills
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
        fillCount++;
      }

      // Apply funding
      for (const fund of funding.sort((a, b) => a.time - b.time)) {
        const fundingData = parseFundingFromApi(
          fund.coin,
          fund.fundingRate,
          fund.usdc,
          fund.szi,
          fund.time
        );
        state = applyFunding(state, fundingData);
        fundingCount++;
      }

      return {
        fills: fillCount,
        funding: fundingCount,
        state,
      };
    }),
    catchError((err) => {
      logger.error({ error: (err as Error).message, address }, 'Failed to process chunk');
      return of({ fills: 0, funding: 0, state: initialState });
    })
  );
}

/**
 * Save snapshot (returns Observable)
 */
function saveSnapshot$(traderId: number, state: PnLStateData, timestamp: Date): Observable<void> {
  const snapshot = createSnapshot(state);
  return from(
    snapshotsRepo.insert({
      traderId: snapshot.traderId,
      timestamp,
      realizedPnl: snapshot.realizedPnl,
      unrealizedPnl: snapshot.unrealizedPnl,
      totalPnl: snapshot.totalPnl,
      fundingPnl: snapshot.fundingPnl,
      tradingPnl: snapshot.tradingPnl,
      openPositions: snapshot.openPositions,
      totalVolume: snapshot.totalVolume,
      accountValue: snapshot.accountValue,
    })
  ).pipe(map(() => void 0));
}

/**
 * Process backfill job (BullMQ-compatible async wrapper)
 */
async function processBackfillJob(job: Job<BackfillJobData>): Promise<void> {
  const { traderId, address, startTime, endTime } = job.data;

  logger.info(
    { traderId, address, startTime: new Date(startTime), endTime: new Date(endTime) },
    'Starting backfill job'
  );

  // Create day chunks
  const dayChunks: Array<{ start: number; end: number }> = [];
  let current = startTime;
  while (current < endTime) {
    const chunkEnd = Math.min(current + DAY_MS, endTime);
    dayChunks.push({ start: current, end: chunkEnd });
    current = chunkEnd;
  }

  const initialState = createInitialState(traderId, address);

  // Process all chunks using RxJS
  const result = await firstValueFrom(
    from(dayChunks).pipe(
      concatMap((chunk, index) =>
        of(chunk).pipe(
          // Process this chunk
          mergeMap((c) =>
            // Use initial state for first chunk, otherwise we need to chain
            processChunk$(address, c, initialState)
          ),
          // Save snapshot for this chunk
          mergeMap((chunkResult) =>
            saveSnapshot$(traderId, chunkResult.state, new Date(chunk.end)).pipe(
              map(() => chunkResult)
            )
          ),
          // Update job progress (use mergeMap to handle Promise properly)
          mergeMap((chunkResult) =>
            from(
              job.updateProgress({
                percent: Math.round(((index + 1) / dayChunks.length) * 100),
                fills: chunkResult.fills,
                funding: chunkResult.funding,
                snapshots: index + 1,
              })
            ).pipe(map(() => chunkResult))
          ),
          // Rate limiting delay
          delay(1000)
        )
      ),
      // Aggregate final stats
      reduce(
        (acc, result) => ({
          fills: acc.fills + result.fills,
          funding: acc.funding + result.funding,
          snapshots: acc.snapshots + 1,
        }),
        { fills: 0, funding: 0, snapshots: 0 }
      )
    )
  );

  logger.info({ traderId, address, ...result }, 'Backfill job completed');
}

export function createBackfillWorker(): Worker<BackfillJobData> {
  const worker = new Worker<BackfillJobData>(QUEUE_NAME, processBackfillJob, {
    connection: {
      host: new URL(config.REDIS_URL).hostname,
      port: parseInt(new URL(config.REDIS_URL).port || '6379'),
    },
    concurrency: 2,
  });

  worker.on('completed', (job) => {
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

  logger.info({ jobId: job.id, address, days }, 'Backfill job scheduled');

  return job;
}

export async function getBackfillStatus(address: string): Promise<{
  isActive: boolean;
  jobs: Array<{ id: string; progress: unknown; state: string }>;
}> {
  const jobs = await backfillQueue.getJobs(['active', 'waiting', 'delayed']);
  const addressJobs = jobs.filter((j) => j.data.address === address);

  return {
    isActive: addressJobs.some((j) => j.isActive()),
    jobs: await Promise.all(
      addressJobs.map(async (j) => ({
        id: j.id!,
        progress: await j.progress,
        state: await j.getState(),
      }))
    ),
  };
}
