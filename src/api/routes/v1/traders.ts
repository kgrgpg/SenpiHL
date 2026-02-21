import type { FastifyInstance } from 'fastify';

import { firstValueFrom } from 'rxjs';

import { hyperliquidClient, fetchClearinghouseState, fetchUserFills, fetchUserFunding } from '../../../hyperliquid/client.js';
import { tradersRepo, snapshotsRepo } from '../../../storage/db/repositories/index.js';
import { getHybridDataStream } from '../../../streams/sources/hybrid.stream.js';
import {
  getTraderState,
  initializeTraderState,
  removeTraderState,
} from '../../../state/trader-state.js';
import { scheduleBackfill, getBackfillStatus } from '../../../jobs/backfill.js';
import {
  createInitialState,
  createSnapshot,
  applyTrade,
  applyFunding,
  parseTradeFromApi,
  parseFundingFromApi,
  parsePositionFromApi,
  updatePositions,
  calculatePnL,
} from '../../../pnl/calculator.js';
import { toDecimal } from '../../../utils/decimal.js';
import { config } from '../../../utils/config.js';
import { logger } from '../../../utils/logger.js';

interface PnLQueryParams {
  timeframe?: '1h' | '1d' | '7d' | '30d';
  from?: string;
  to?: string;
  granularity?: 'raw' | 'hourly' | 'daily';
}

interface AddressParams {
  address: string;
}

export async function tradersRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /v1/traders/:address/pnl
   * Get PnL data for a trader
   */
  fastify.get<{
    Params: AddressParams;
    Querystring: PnLQueryParams;
  }>('/traders/:address/pnl', async (request, reply) => {
    const { address } = request.params;
    const { timeframe = '1d', from, to, granularity } = request.query;

    if (!hyperliquidClient.isValidAddress(address)) {
      return reply.status(400).send({ error: 'Invalid Ethereum address' });
    }

    let trader = await tradersRepo.findByAddress(address);

    // On-demand: fetch live data for unknown traders instead of returning 404
    if (!trader) {
      try {
        const clearinghouse = await firstValueFrom(fetchClearinghouseState(address));
        const recentFills = await firstValueFrom(fetchUserFills(address, Date.now() - 24 * 60 * 60 * 1000, undefined, 'user'));

        trader = await tradersRepo.findOrCreate(address);
        let state = createInitialState(trader.id, address);

        for (const fill of recentFills.sort((a, b) => a.time - b.time)) {
          state = applyTrade(state, parseTradeFromApi(
            fill.coin, fill.side, fill.sz, fill.px, fill.closedPnl,
            fill.fee, fill.time, fill.tid, fill.liquidation ?? false, fill.dir, fill.startPosition
          ));
        }

        const positions = clearinghouse.assetPositions.map(ap => {
          const pos = ap.position;
          return parsePositionFromApi(
            pos.coin, pos.szi, pos.entryPx, pos.unrealizedPnl,
            pos.leverage.value, pos.liquidationPx, pos.marginUsed, pos.leverage.type
          );
        });
        state = updatePositions(state, positions);
        initializeTraderState(trader.id, address);

        const pnl = calculatePnL(state);

        // Schedule full backfill in background
        scheduleBackfill(address, config.BACKFILL_DAYS).catch(err =>
          logger.warn({ err: (err as Error).message }, 'Failed to schedule backfill for on-demand trader')
        );

        // Return live data immediately
        const accountValue = toDecimal(clearinghouse.marginSummary.accountValue);
        return {
          trader: address,
          timeframe,
          data: [{
            timestamp: Math.floor(Date.now() / 1000),
            realized_pnl: pnl.realizedPnl.toString(),
            unrealized_pnl: pnl.unrealizedPnl.toString(),
            total_pnl: pnl.totalPnl.toString(),
            positions: positions.length,
            volume: state.totalVolume.toString(),
          }],
          summary: {
            total_realized: pnl.realizedPnl.toString(),
            peak_pnl: pnl.totalPnl.toString(),
            max_drawdown: '0',
            current_pnl: pnl.totalPnl.toString(),
          },
          note: 'Live data fetched on-demand. Full history will be available after backfill completes.',
        };
      } catch (err) {
        logger.warn({ address, err: (err as Error).message }, 'On-demand fetch failed');
        return reply.status(404).send({ error: 'Trader not found and live fetch failed.' });
      }
    }

    const days = timeframe === '1h' ? 1 / 24 : timeframe === '1d' ? 1 : timeframe === '7d' ? 7 : 30;
    const now = Date.now();
    const fromDate = from ? new Date(parseInt(from) * 1000) : new Date(now - days * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(parseInt(to) * 1000) : new Date(now);

    const preferredGranularity = granularity ?? (days > 7 ? 'daily' : days > 1 ? 'hourly' : 'raw');

    let snapshots = await snapshotsRepo.getForTrader(trader.id, fromDate, toDate, preferredGranularity);
    if (snapshots.length === 0 && preferredGranularity !== 'raw') {
      snapshots = await snapshotsRepo.getForTrader(trader.id, fromDate, toDate, 'raw');
    }

    // Check if stored data is sufficient -- filter out zero-PnL initialization artifacts
    const validSnapshots = snapshots.filter(s =>
      !(s.total_pnl === '0.00000000' && s.realized_pnl === '0.00000000' && s.unrealized_pnl === '0.00000000')
    );
    const earliestValid = validSnapshots[0];
    const latestValid = validSnapshots[validSnapshots.length - 1];
    const requestedMs = toDate.getTime() - fromDate.getTime();
    const actualMs = (earliestValid && latestValid)
      ? new Date(latestValid.timestamp).getTime() - new Date(earliestValid.timestamp).getTime()
      : 0;
    const coverageOk = validSnapshots.length >= 2 && requestedMs > 0 && actualMs / requestedMs > 0.8;

    if (!coverageOk) {
      try {
        logger.info({
          address, timeframe, days,
          validSnaps: validSnapshots.length,
          actualMs, requestedMs,
          coveragePercent: requestedMs > 0 ? Math.round((actualMs / requestedMs) * 100) : 0,
        }, 'Insufficient data, fetching inline from Hyperliquid');

        // Stagger the 3 API calls to avoid burst rate-limiting
        const clearinghouse = await firstValueFrom(fetchClearinghouseState(address));
        const fills = await firstValueFrom(fetchUserFills(address, fromDate.getTime(), toDate.getTime(), 'user'));
        const funding = await firstValueFrom(fetchUserFunding(address, fromDate.getTime(), toDate.getTime(), 'user'));

        let state = createInitialState(trader.id, address);

        const allEvents: Array<{ time: number; type: 'fill' | 'funding'; data: unknown }> = [];
        for (const f of fills) allEvents.push({ time: f.time, type: 'fill', data: f });
        for (const f of funding) {
          if (f.coin && f.usdc && f.time) {
            allEvents.push({ time: f.time, type: 'funding', data: f });
          }
        }
        allEvents.sort((a, b) => a.time - b.time);

        const dataPoints: Array<{
          timestamp: number;
          realized_pnl: string;
          unrealized_pnl: string;
          total_pnl: string;
          positions: number;
          volume: string;
        }> = [];

        // Process events and create data points at day boundaries
        let lastDayBucket = 0;
        for (const event of allEvents) {
          if (event.type === 'fill') {
            const f = event.data as { coin: string; side: 'A' | 'B'; sz: string; px: string; closedPnl: string; fee: string; time: number; tid: number; liquidation?: boolean; dir: string; startPosition: string };
            state = applyTrade(state, parseTradeFromApi(
              f.coin, f.side, f.sz, f.px, f.closedPnl, f.fee, f.time, f.tid,
              f.liquidation ?? false, f.dir, f.startPosition
            ));
          } else {
            const f = event.data as { coin: string; fundingRate: string; usdc: string; szi: string; time: number };
            if (f.fundingRate && f.usdc && f.szi) {
              state = applyFunding(state, parseFundingFromApi(f.coin, f.fundingRate, f.usdc, f.szi, f.time));
            }
          }

          const dayBucket = Math.floor(event.time / (24 * 60 * 60 * 1000));
          if (dayBucket !== lastDayBucket) {
            const pnl = calculatePnL(state);
            dataPoints.push({
              timestamp: Math.floor(event.time / 1000),
              realized_pnl: pnl.realizedPnl.toString(),
              unrealized_pnl: pnl.unrealizedPnl.toString(),
              total_pnl: pnl.totalPnl.toString(),
              positions: state.positions.size,
              volume: state.totalVolume.toString(),
            });
            lastDayBucket = dayBucket;
          }
        }

        // Add current state as final data point with live positions
        const positions = clearinghouse.assetPositions.map(ap => {
          const pos = ap.position;
          return parsePositionFromApi(
            pos.coin, pos.szi, pos.entryPx, pos.unrealizedPnl,
            pos.leverage.value, pos.liquidationPx, pos.marginUsed, pos.leverage.type
          );
        });
        state = updatePositions(state, positions);
        const finalPnl = calculatePnL(state);

        dataPoints.push({
          timestamp: Math.floor(Date.now() / 1000),
          realized_pnl: finalPnl.realizedPnl.toString(),
          unrealized_pnl: finalPnl.unrealizedPnl.toString(),
          total_pnl: finalPnl.totalPnl.toString(),
          positions: positions.length,
          volume: state.totalVolume.toString(),
        });

        // Compute summary from computed data points
        let peakPnl = -Infinity;
        let troughPnl = Infinity;
        for (const dp of dataPoints) {
          const v = parseFloat(dp.total_pnl);
          if (v > peakPnl) peakPnl = v;
          if (v < troughPnl) troughPnl = v;
        }

        return {
          trader: address,
          timeframe,
          data: dataPoints,
          summary: {
            total_realized: finalPnl.realizedPnl.toString(),
            peak_pnl: isFinite(peakPnl) ? peakPnl.toString() : '0',
            max_drawdown: isFinite(troughPnl) && isFinite(peakPnl) ? (troughPnl - peakPnl).toString() : '0',
            current_pnl: finalPnl.totalPnl.toString(),
          },
          fetched_live: true,
        };
      } catch (err) {
        logger.error({ address, error: (err as Error).message, stack: (err as Error).stack }, 'Inline fetch failed, returning stored data');
      }
    }

    const summary = await snapshotsRepo.getSummary(trader.id, fromDate, toDate);
    const latestSnapshot = snapshots[snapshots.length - 1];

    return {
      trader: address,
      timeframe,
      data: snapshots.map(s => ({
        timestamp: Math.floor(new Date(s.timestamp).getTime() / 1000),
        realized_pnl: s.realized_pnl,
        unrealized_pnl: s.unrealized_pnl,
        total_pnl: s.total_pnl,
        positions: s.open_positions,
        volume: s.total_volume,
      })),
      summary: summary
        ? {
            total_realized: summary.totalRealized,
            peak_pnl: summary.peakPnl,
            max_drawdown: toDecimal(summary.troughPnl)
              .minus(toDecimal(summary.peakPnl))
              .toString(),
            current_pnl: latestSnapshot?.total_pnl ?? '0',
          }
        : {
            total_realized: '0',
            peak_pnl: '0',
            max_drawdown: '0',
            current_pnl: '0',
          },
    };
  });

  /**
   * GET /v1/traders/:address/stats
   * Get statistics for a trader
   */
  fastify.get<{ Params: AddressParams }>('/traders/:address/stats', async (request, reply) => {
    const { address } = request.params;

    if (!hyperliquidClient.isValidAddress(address)) {
      return reply.status(400).send({ error: 'Invalid Ethereum address' });
    }

    const trader = await tradersRepo.findByAddress(address);
    if (!trader) {
      return reply.status(404).send({ error: 'Trader not found' });
    }

    const state = getTraderState(address);
    const latestSnapshot = await snapshotsRepo.getLatest(trader.id);

    return {
      address,
      total_trades: state?.tradeCount ?? 0,
      total_volume: state?.totalVolume.toString() ?? '0',
      realized_pnl: state?.realizedTradingPnl.toString() ?? '0',
      funding_pnl: state?.realizedFundingPnl.toString() ?? '0',
      total_fees: state?.totalFees.toString() ?? '0',
      open_positions: state?.positions.size ?? 0,
      last_updated: state?.lastUpdated.toISOString() ?? null,
      latest_snapshot: latestSnapshot
        ? {
            timestamp: latestSnapshot.timestamp,
            total_pnl: latestSnapshot.total_pnl,
          }
        : null,
    };
  });

  /**
   * POST /v1/traders/:address/subscribe
   * Subscribe to a trader for tracking
   */
  fastify.post<{ Params: AddressParams; Body: { backfill_days?: number } }>(
    '/traders/:address/subscribe',
    async (request, reply) => {
      const { address } = request.params;
      const backfillDays = request.body?.backfill_days ?? 30;

      if (!hyperliquidClient.isValidAddress(address)) {
        return reply.status(400).send({ error: 'Invalid Ethereum address' });
      }

      // Check if already tracking
      const existingState = getTraderState(address);
      if (existingState) {
        const trader = await tradersRepo.findByAddress(address);
        const backfillStatus = await getBackfillStatus(address);
        return {
          address,
          trader_id: trader?.id ?? existingState.traderId,
          status: 'tracking',
          mode: config.USE_HYBRID_MODE ? 'hybrid' : 'legacy',
          message: 'Already tracking this trader',
          backfill: backfillStatus,
        };
      }

      const trader = await tradersRepo.findOrCreate(address);

      // Initialize state
      initializeTraderState(trader.id, address);

      if (config.USE_HYBRID_MODE) {
        // Subscribe via HybridDataStream
        const hybridStream = getHybridDataStream();
        hybridStream.subscribeTrader(address);
        logger.info({ address, traderId: trader.id, mode: 'hybrid' }, 'Trader subscribed');
      } else {
        logger.info({ address, traderId: trader.id, mode: 'legacy' }, 'Trader subscribed');
      }

      // Schedule backfill job for historical data
      const backfillJob = await scheduleBackfill(address, backfillDays);
      logger.info(
        { address, traderId: trader.id, backfillDays, jobId: backfillJob.id },
        'Backfill job scheduled'
      );

      return {
        address,
        trader_id: trader.id,
        status: 'tracking',
        mode: config.USE_HYBRID_MODE ? 'hybrid' : 'legacy',
        message: 'Subscribed successfully',
        backfill_job_id: backfillJob.id,
        backfill_days: backfillDays,
      };
    }
  );

  /**
   * DELETE /v1/traders/:address/unsubscribe
   * Unsubscribe from tracking a trader
   */
  fastify.delete<{ Params: AddressParams }>(
    '/traders/:address/unsubscribe',
    async (request, reply) => {
      const { address } = request.params;

      if (!hyperliquidClient.isValidAddress(address)) {
        return reply.status(400).send({ error: 'Invalid Ethereum address' });
      }

      const trader = await tradersRepo.findByAddress(address);
      if (!trader) {
        return reply.status(404).send({ error: 'Trader not found' });
      }

      // Mark as inactive in database
      await tradersRepo.setActive(trader.id, false);

      // Remove from state
      removeTraderState(address);

      if (config.USE_HYBRID_MODE) {
        // Unsubscribe from hybrid stream
        const hybridStream = getHybridDataStream();
        hybridStream.unsubscribeTrader(address);
        logger.info({ address, traderId: trader.id, mode: 'hybrid' }, 'Trader unsubscribed');
      } else {
        logger.info({ address, traderId: trader.id, mode: 'legacy' }, 'Trader unsubscribed');
      }

      return {
        address,
        trader_id: trader.id,
        status: 'unsubscribed',
        message: 'Trader removed from tracking',
      };
    }
  );

  /**
   * GET /v1/traders/:address/positions
   * Get current positions for a trader
   */
  fastify.get<{ Params: AddressParams }>('/traders/:address/positions', async (request, reply) => {
    const { address } = request.params;

    if (!hyperliquidClient.isValidAddress(address)) {
      return reply.status(400).send({ error: 'Invalid Ethereum address' });
    }

    const trader = await tradersRepo.findByAddress(address);
    if (!trader) {
      return reply.status(404).send({ error: 'Trader not found' });
    }

    const state = getTraderState(address);

    if (!state) {
      return reply.status(404).send({ error: 'No position data available yet' });
    }

    const positions = Array.from(state.positions.values()).map(p => ({
      coin: p.coin,
      size: p.size.toString(),
      entry_price: p.entryPrice.toString(),
      unrealized_pnl: p.unrealizedPnl.toString(),
      leverage: p.leverage,
      liquidation_price: p.liquidationPrice?.toString() ?? null,
      margin_used: p.marginUsed.toString(),
    }));

    return {
      address,
      positions,
      total_positions: positions.length,
      total_unrealized_pnl: state.positions.size > 0
        ? Array.from(state.positions.values())
            .reduce((sum, p) => sum.plus(p.unrealizedPnl), toDecimal('0'))
            .toString()
        : '0',
    };
  });

  /**
   * GET /v1/traders/:address/backfill
   * Get backfill job status for a trader
   */
  fastify.get<{ Params: AddressParams }>('/traders/:address/backfill', async (request, reply) => {
    const { address } = request.params;

    if (!hyperliquidClient.isValidAddress(address)) {
      return reply.status(400).send({ error: 'Invalid Ethereum address' });
    }

    const trader = await tradersRepo.findByAddress(address);
    if (!trader) {
      return reply.status(404).send({ error: 'Trader not found' });
    }

    const status = await getBackfillStatus(address);

    return {
      address,
      trader_id: trader.id,
      ...status,
    };
  });

  /**
   * POST /v1/traders/:address/backfill
   * Manually trigger backfill for a trader
   */
  fastify.post<{ Params: AddressParams; Body: { days?: number } }>(
    '/traders/:address/backfill',
    async (request, reply) => {
      const { address } = request.params;
      const days = request.body?.days ?? 30;

      if (!hyperliquidClient.isValidAddress(address)) {
        return reply.status(400).send({ error: 'Invalid Ethereum address' });
      }

      const trader = await tradersRepo.findByAddress(address);
      if (!trader) {
        return reply.status(404).send({ error: 'Trader not found. Subscribe first.' });
      }

      // Check if backfill already running
      const currentStatus = await getBackfillStatus(address);
      if (currentStatus.isActive) {
        return reply.status(409).send({
          error: 'Backfill already in progress',
          jobs: currentStatus.jobs,
        });
      }

      // Schedule backfill
      const job = await scheduleBackfill(address, days);
      logger.info({ address, days, jobId: job.id }, 'Manual backfill scheduled');

      return {
        address,
        trader_id: trader.id,
        backfill_job_id: job.id,
        days,
        message: `Backfill scheduled for ${days} days of historical data`,
      };
    }
  );
}
