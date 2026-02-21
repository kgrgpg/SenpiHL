/**
 * Backfill Job
 *
 * Processes historical data for newly subscribed traders.
 * Uses RxJS patterns internally while integrating with BullMQ.
 */

import { Queue, Worker, Job } from 'bullmq';
import { firstValueFrom, from, forkJoin, of, Observable, interval, Subject } from 'rxjs';
import { mergeMap, map, catchError, delay, mergeScan, reduce, takeUntil, tap } from 'rxjs/operators';

import { fetchUserFills, fetchUserFunding } from '../hyperliquid/client.js';
import { rateBudget } from '../utils/rate-budget.js';
import {
  parseTradeFromApi,
  parseFundingFromApi,
  applyTrade,
  applyFunding,
  createInitialState,
  createSnapshot,
} from '../pnl/calculator.js';
import type { PnLStateData } from '../pnl/types.js';
import { snapshotsRepo, tradersRepo, tradesRepo, fundingRepo } from '../storage/db/repositories/index.js';
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
    fills: fetchUserFills(address, chunk.start, chunk.end, 'backfill'),
    funding: fetchUserFunding(address, chunk.start, chunk.end, 'backfill'),
  }).pipe(
    mergeMap(({ fills, funding }) => {
      let state = initialState;
      let fillCount = 0;
      let fundingCount = 0;

      const tradesToPersist = [];
      const fundingToPersist = [];

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
          fill.tid,
          fill.liquidation ?? false,
          fill.dir,
          fill.startPosition
        );
        state = applyTrade(state, trade);
        tradesToPersist.push({
          traderId: state.traderId,
          coin: trade.coin,
          side: trade.side,
          size: trade.size,
          price: trade.price,
          closedPnl: trade.closedPnl,
          fee: trade.fee,
          timestamp: trade.timestamp,
          txHash: fill.hash,
          oid: fill.oid,
          tid: trade.tid,
        });
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
        fundingToPersist.push({
          traderId: state.traderId,
          coin: fundingData.coin,
          fundingRate: fundingData.fundingRate,
          payment: fundingData.payment,
          positionSize: fundingData.positionSize,
          timestamp: fundingData.timestamp,
        });
        fundingCount++;
      }

      // Persist trades and funding to DB
      const persistTrades = tradesToPersist.length > 0
        ? from(tradesRepo.insertMany(tradesToPersist))
        : of(undefined);
      const persistFunding = fundingToPersist.length > 0
        ? from(fundingRepo.insertMany(fundingToPersist))
        : of(undefined);

      return forkJoin({ t: persistTrades, f: persistFunding }).pipe(
        map(() => ({ fills: fillCount, funding: fundingCount, state })),
        catchError(() => of({ fills: fillCount, funding: fundingCount, state }))
      );
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

  // Process chunks sequentially, chaining state via mergeScan (concurrency 1)
  // Each chunk receives the previous chunk's output state as its input
  const result = await firstValueFrom(
    from(dayChunks).pipe(
      mergeScan(
        (acc, chunk, index) =>
          processChunk$(address, chunk, acc.state).pipe(
            mergeMap((chunkResult) =>
              saveSnapshot$(traderId, chunkResult.state, new Date(chunk.end)).pipe(
                map(() => chunkResult)
              )
            ),
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
            delay(1000),
            map((chunkResult) => ({
              state: chunkResult.state,
              fills: acc.fills + chunkResult.fills,
              funding: acc.funding + chunkResult.funding,
              snapshots: acc.snapshots + 1,
            }))
          ),
        { state: initialState, fills: 0, funding: 0, snapshots: 0 },
        1 // concurrency 1 = sequential, ensures state chains correctly
      ),
      reduce(
        (_, acc) => ({
          fills: acc.fills,
          funding: acc.funding,
          snapshots: acc.snapshots,
        }),
        { fills: 0, funding: 0, snapshots: 0 }
      )
    )
  );

  logger.info({ traderId, address, ...result }, 'Backfill job completed');
}

export function createBackfillWorker(): Worker<BackfillJobData> {
  const initialWorkers = rateBudget.getRecommendedWorkers();

  const worker = new Worker<BackfillJobData>(QUEUE_NAME, processBackfillJob, {
    connection: {
      host: new URL(config.REDIS_URL).hostname,
      port: parseInt(new URL(config.REDIS_URL).port || '6379'),
    },
    concurrency: initialWorkers,
  });

  // Adjust concurrency every 10 seconds based on rate budget (RxJS interval)
  const workerDestroy$ = new Subject<void>();
  interval(10_000).pipe(
    takeUntil(workerDestroy$),
    tap(() => {
      const recommended = rateBudget.getRecommendedWorkers();
      if (recommended !== worker.concurrency) {
        logger.info(
          { from: worker.concurrency, to: recommended, ...rateBudget.getStats() },
          'Adjusting backfill worker concurrency'
        );
        worker.concurrency = recommended;
      }
    })
  ).subscribe();

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

  worker.on('closing', () => workerDestroy$.next());

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
