import type { FastifyInstance } from 'fastify';

import { leaderboardRepo } from '../../../storage/db/repositories/index.js';

interface LeaderboardQuery {
  timeframe?: '1d' | '7d' | '30d';
  metric?: 'total_pnl' | 'realized_pnl' | 'volume';
  limit?: string;
}

export async function leaderboardRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: LeaderboardQuery }>('/leaderboard', async (request) => {
    const { timeframe = '7d', metric = 'total_pnl', limit = '50' } = request.query;

    const limitNum = Math.min(Math.max(parseInt(limit) || 50, 10), 100);

    const entries = await leaderboardRepo.get(timeframe, metric, limitNum);

    return {
      timeframe,
      metric,
      data: entries.map(entry => ({
        rank: Number(entry.rank),
        address: entry.address,
        pnl: entry.total_pnl,
        realized_pnl: entry.realized_pnl,
        volume: entry.volume,
        trade_count: entry.trade_count,
      })),
      updated_at: Math.floor(Date.now() / 1000),
    };
  });
}
