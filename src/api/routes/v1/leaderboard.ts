import type { FastifyInstance } from 'fastify';

import { leaderboardRepo } from '../../../storage/db/repositories/index.js';
import { cacheGet, cacheSet } from '../../../storage/cache/redis.js';
import { logger } from '../../../utils/logger.js';

interface LeaderboardQuery {
  timeframe?: '1d' | '7d' | '30d' | 'all';
  metric?: 'total_pnl' | 'realized_pnl' | 'volume';
  limit?: string;
}

const CACHE_TTL: Record<string, number> = {
  '1d': 60,    // 1 minute (portfolio API, not ultra-volatile)
  '7d': 120,   // 2 minutes
  '30d': 300,  // 5 minutes
  all: 300,    // 5 minutes
};

export async function leaderboardRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: LeaderboardQuery }>('/leaderboard', async (request) => {
    const { timeframe = '7d', metric = 'total_pnl', limit = '50' } = request.query;

    const limitNum = Math.min(Math.max(parseInt(limit) || 50, 10), 100);
    const cacheKey = `leaderboard:v2:${timeframe}:${metric}:${limitNum}`;

    try {
      const cached = await cacheGet<Record<string, unknown>>(cacheKey);
      if (cached) {
        return { ...cached, cached: true };
      }
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Cache read failed');
    }

    let response: Record<string, unknown>;

    if (timeframe === 'all') {
      const entries = await leaderboardRepo.getAllTime(limitNum);

      response = {
        timeframe: 'all',
        data_source: 'hyperliquid_portfolio',
        data: entries.map((entry) => ({
          rank: entry.rank,
          address: entry.address,
          all_time_pnl: entry.all_time_pnl,
          all_time_volume: entry.all_time_volume,
          perp_pnl: entry.perp_pnl,
          perp_volume: entry.perp_volume,
          tracking_since: entry.tracking_since,
          data_source: entry.data_source,
        })),
        updated_at: Math.floor(Date.now() / 1000),
      };
    } else {
      const entries = await leaderboardRepo.get(timeframe, metric, limitNum);

      const fullCoverage = entries.filter(e => e.timeframe_coverage === 'full').length;
      const partialCoverage = entries.filter(e => e.timeframe_coverage === 'partial').length;
      const portfolioSource = entries.filter(e => e.data_source === 'hyperliquid_portfolio').length;

      response = {
        timeframe,
        data_source: portfolioSource === entries.length ? 'hyperliquid_portfolio' : 'mixed',
        data_quality: {
          total_traders: entries.length,
          portfolio_sourced: portfolioSource,
          full_timeframe_coverage: fullCoverage,
          partial_coverage: partialCoverage,
        },
        data: entries.map((entry) => ({
          rank: entry.rank,
          address: entry.address,
          total_pnl: entry.total_pnl,
          trade_count: entry.trade_count,
          tracking_since: entry.tracking_since,
          data_source: entry.data_source,
          timeframe_coverage: entry.timeframe_coverage,
        })),
        updated_at: Math.floor(Date.now() / 1000),
      };
    }

    const ttl = CACHE_TTL[timeframe] ?? 60;
    cacheSet(cacheKey, response, ttl).catch((err) =>
      logger.warn({ error: (err as Error).message }, 'Cache write failed')
    );

    return { ...response, cached: false };
  });

  fastify.get('/leaderboard/info', async () => {
    return {
      description: 'PnL Leaderboard - Rankings by profit and loss',
      data_source: 'All timeframes now use Hyperliquid portfolio API as authoritative source',
      timeframes: {
        '1d': { period: 'perpDay', description: '24-hour perp PnL from Hyperliquid' },
        '7d': { period: 'perpWeek', description: '7-day perp PnL from Hyperliquid' },
        '30d': { period: 'perpMonth', description: '30-day perp PnL from Hyperliquid' },
        all: { period: 'perpAllTime', description: 'All-time perp PnL from Hyperliquid' },
      },
      fields: {
        total_pnl: 'Authoritative PnL for the timeframe from Hyperliquid portfolio API',
        trade_count: 'Trades captured by our system (may be partial)',
        tracking_since: 'When we started tracking this trader',
        data_source: '"hyperliquid_portfolio" = authoritative, "snapshot_delta" = fallback from our data',
        timeframe_coverage: '"full" = tracking started before timeframe window, "partial" = tracking started within window',
      },
    };
  });
}
