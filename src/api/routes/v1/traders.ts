import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { hyperliquidClient } from '../../../hyperliquid/client.js';
import { initializeTraderState, getTraderState } from '../../../streams/index.js';
import { tradersRepo, snapshotsRepo } from '../../../storage/db/repositories/index.js';
import { toDecimal } from '../../../utils/decimal.js';
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

  fastify.post<{ Params: AddressParams; Body: { backfill_days?: number } }>(
    '/traders/:address/subscribe',
    async (request, reply) => {
      const { address } = request.params;
      const { backfill_days = 30 } = request.body ?? {};

      if (!hyperliquidClient.isValidAddress(address)) {
        return reply.status(400).send({ error: 'Invalid Ethereum address' });
      }

      const trader = await tradersRepo.findOrCreate(address);
      const existingState = getTraderState(address);

      if (!existingState) {
        initializeTraderState(trader.id, address);
      }

      logger.info({ address, traderId: trader.id }, 'Trader subscribed');

      return {
        address,
        trader_id: trader.id,
        status: 'tracking',
        message: existingState ? 'Already tracking' : 'Subscribed successfully',
      };
    }
  );
}
