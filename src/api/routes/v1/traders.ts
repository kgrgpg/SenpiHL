import type { FastifyInstance } from 'fastify';

import { firstValueFrom } from 'rxjs';

import { hyperliquidClient, fetchClearinghouseState, fetchUserFills, fetchUserFunding, fetchPortfolio } from '../../../hyperliquid/client.js';
import { tradersRepo, snapshotsRepo, tradesRepo, fundingRepo } from '../../../storage/db/repositories/index.js';
import { query } from '../../../storage/db/client.js';
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
    const isCustomRange = !!(from || to);
    const fromDate = from ? new Date(parseInt(from) * 1000) : new Date(now - days * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(parseInt(to) * 1000) : new Date(now);
    const portfolioPeriod = timeframe === '1h' ? 'perpDay' : timeframe === '1d' ? 'perpDay' : timeframe === '7d' ? 'perpWeek' : 'perpMonth';

    // Fetch all data sources in parallel
    const [portfolio, fills, funding, clearinghouse] = await Promise.allSettled([
      firstValueFrom(fetchPortfolio(address)),
      firstValueFrom(fetchUserFills(address, fromDate.getTime(), toDate.getTime(), 'user')),
      firstValueFrom(fetchUserFunding(address, fromDate.getTime(), toDate.getTime(), 'user')),
      firstValueFrom(fetchClearinghouseState(address)),
    ]);

    // ── TOTAL PnL: portfolio is the single source of truth ──
    let totalPnl = toDecimal('0');
    let pnlSource: 'hyperliquid_portfolio' | 'our_calculation' = 'our_calculation';
    let pnlHistoryData: Array<[number, string]> = [];

    if (!isCustomRange && portfolio.status === 'fulfilled') {
      const periodData = portfolio.value.find(([p]) => p === portfolioPeriod);
      if (periodData) {
        const [, info] = periodData;
        pnlHistoryData = info.pnlHistory || [];
        if (pnlHistoryData.length > 0) {
          totalPnl = toDecimal(pnlHistoryData[pnlHistoryData.length - 1]![1]);
          pnlSource = 'hyperliquid_portfolio';
        }
      }
    }

    // ── UNREALIZED PnL: directly from clearinghouseState (current positions) ──
    let unrealizedPnl = toDecimal('0');
    let positionCount = 0;
    if (clearinghouse.status === 'fulfilled') {
      for (const ap of clearinghouse.value.assetPositions) {
        unrealizedPnl = unrealizedPnl.plus(toDecimal(ap.position.unrealizedPnl));
      }
      positionCount = clearinghouse.value.assetPositions.length;
    }

    // ── REALIZED PnL: from fills + funding (if available) ──
    const fillsData = fills.status === 'fulfilled' ? fills.value : [];
    const fundingData = funding.status === 'fulfilled'
      ? funding.value.filter(f => f.coin && f.usdc)
      : [];

    let tradingPnl = toDecimal('0');
    let totalFees = toDecimal('0');
    let totalVolume = toDecimal('0');
    for (const f of fillsData) {
      tradingPnl = tradingPnl.plus(toDecimal(f.closedPnl));
      totalFees = totalFees.plus(toDecimal(f.fee));
      totalVolume = totalVolume.plus(toDecimal(f.sz).times(toDecimal(f.px)));
    }
    let fundingPnl = toDecimal('0');
    for (const f of fundingData) {
      fundingPnl = fundingPnl.plus(toDecimal(f.usdc));
    }
    const realizedPnl = tradingPnl.plus(fundingPnl).minus(totalFees);

    // If no portfolio, fall back to our calculation
    if (pnlSource === 'our_calculation') {
      totalPnl = realizedPnl.plus(unrealizedPnl);
    }

    // ── CHART DATA ──
    let data;
    if (pnlHistoryData.length > 0) {
      data = pnlHistoryData.map(([ts, pnl]) => ({
        timestamp: Math.floor(ts / 1000),
        total_pnl: pnl,
      }));
    } else {
      const preferredGranularity = granularity ?? (days > 7 ? 'daily' : days > 1 ? 'hourly' : 'raw');
      let snapshots = await snapshotsRepo.getForTrader(trader.id, fromDate, toDate, preferredGranularity);
      if (snapshots.length === 0 && preferredGranularity !== 'raw') {
        snapshots = await snapshotsRepo.getForTrader(trader.id, fromDate, toDate, 'raw');
      }
      data = snapshots.map(s => ({
        timestamp: Math.floor(new Date(s.timestamp).getTime() / 1000),
        total_pnl: s.total_pnl,
      }));
    }

    // Peak / drawdown from history
    let peakPnl = totalPnl.toNumber();
    let troughPnl = totalPnl.toNumber();
    for (const [, pnl] of pnlHistoryData) {
      const v = parseFloat(pnl);
      if (v > peakPnl) peakPnl = v;
      if (v < troughPnl) troughPnl = v;
    }

    // ── DATA STATUS: report exactly what we have ──
    const trackingSince = trader.first_seen_at ? new Date(trader.first_seen_at) : null;
    const trackingCoversTimeframe = trackingSince ? trackingSince.getTime() <= fromDate.getTime() : false;
    const snapshotCount = await snapshotsRepo.getCount(trader.id, fromDate, toDate);

    // Check for gaps in snapshot coverage
    const gapsResult = await query<{ gap_start: string; gap_end: string; gap_type: string }>(
      `SELECT gap_start, gap_end, gap_type FROM data_gaps
       WHERE trader_id = $1 AND resolved_at IS NULL
         AND gap_start <= $3 AND gap_end >= $2
       ORDER BY gap_start`,
      [trader.id, fromDate, toDate]
    );
    const knownGaps = gapsResult.rows.map(g => ({
      start: g.gap_start,
      end: g.gap_end,
      type: g.gap_type,
    }));

    const hasFillData = fillsData.length > 0;
    const fillsCapped = fillsData.length >= 2000;

    // ── CONFIDENCE: single summary of data quality ──
    let confidence: { level: 'high' | 'medium' | 'low' | 'none'; reason: string };
    if (pnlSource === 'hyperliquid_portfolio') {
      confidence = { level: 'high', reason: 'Authoritative PnL from Hyperliquid portfolio API' };
    } else if (hasFillData && trackingCoversTimeframe && knownGaps.length === 0) {
      confidence = { level: 'medium', reason: 'Computed from fills + positions, full tracking coverage, no gaps' };
    } else if (hasFillData) {
      const issues: string[] = [];
      if (!trackingCoversTimeframe) issues.push('tracking started within requested window');
      if (knownGaps.length > 0) issues.push(`${knownGaps.length} data gap(s)`);
      if (fillsCapped) issues.push('fills capped at 2000');
      confidence = { level: 'low', reason: `Partial data: ${issues.join(', ')}` };
    } else if (snapshotCount > 0) {
      confidence = { level: 'low', reason: 'No fills captured, PnL derived from snapshots + current positions only' };
    } else {
      confidence = { level: 'none', reason: 'No data available for this time range' };
    }

    return {
      trader: address,
      timeframe: isCustomRange ? `${fromDate.toISOString()} to ${toDate.toISOString()}` : timeframe,
      confidence,
      data,
      summary: {
        total_pnl: totalPnl.toString(),
        realized_pnl: hasFillData ? realizedPnl.toString() : null,
        trading_pnl: hasFillData ? tradingPnl.toString() : null,
        funding_pnl: hasFillData ? fundingPnl.toString() : null,
        total_fees: hasFillData ? totalFees.toString() : null,
        unrealized_pnl: clearinghouse.status === 'fulfilled' ? unrealizedPnl.toString() : null,
        positions: positionCount,
        trade_count: fillsData.length,
        volume: hasFillData ? totalVolume.toString() : null,
        peak_pnl: peakPnl.toString(),
        max_drawdown: (troughPnl - peakPnl).toString(),
      },
      data_status: {
        pnl_source: pnlSource,
        pnl_period: pnlSource === 'hyperliquid_portfolio' ? portfolioPeriod : null,
        tracking_since: trackingSince?.toISOString() ?? null,
        tracking_covers_timeframe: trackingCoversTimeframe,
        fills_in_range: fillsData.length,
        fills_capped: fillsCapped,
        funding_payments: fundingData.length,
        snapshots_in_range: snapshotCount,
        known_gaps: knownGaps,
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
