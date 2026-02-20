import type { FastifyInstance } from 'fastify';

import { hyperliquidClient } from '../../../hyperliquid/client.js';
import { tradersRepo, snapshotsRepo } from '../../../storage/db/repositories/index.js';
import { getHybridDataStream } from '../../../streams/sources/hybrid.stream.js';
import {
  getTraderState,
  initializeTraderState,
  removeTraderState,
} from '../../../state/trader-state.js';
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

    const trader = await tradersRepo.findByAddress(address);
    if (!trader) {
      return reply.status(404).send({ error: 'Trader not found. Subscribe first.' });
    }

    const days = timeframe === '1h' ? 1 / 24 : timeframe === '1d' ? 1 : timeframe === '7d' ? 7 : 30;
    const now = Date.now();
    const fromDate = from ? new Date(parseInt(from) * 1000) : new Date(now - days * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(parseInt(to) * 1000) : new Date(now);

    const autoGranularity = granularity ?? (days > 7 ? 'daily' : days > 1 ? 'hourly' : 'raw');

    const snapshots = await snapshotsRepo.getForTrader(
      trader.id,
      fromDate,
      toDate,
      autoGranularity
    );

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
      // backfill_days can be used for triggering backfill job in future
      const _backfillDays = request.body?.backfill_days ?? 30;

      if (!hyperliquidClient.isValidAddress(address)) {
        return reply.status(400).send({ error: 'Invalid Ethereum address' });
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

      return {
        address,
        trader_id: trader.id,
        status: 'tracking',
        mode: config.USE_HYBRID_MODE ? 'hybrid' : 'legacy',
        message: 'Subscribed successfully',
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
}
