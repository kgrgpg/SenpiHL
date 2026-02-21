import type { FastifyInstance } from 'fastify';

import { leaderboardRepo } from '../../../storage/db/repositories/index.js';
import { cacheGet, cacheSet } from '../../../storage/cache/redis.js';
import { query } from '../../../storage/db/client.js';
import { logger } from '../../../utils/logger.js';

interface LeaderboardQuery {
  timeframe?: '1d' | '7d' | '30d' | 'all';
  metric?: 'total_pnl' | 'realized_pnl' | 'volume';
  limit?: string;
}

const CACHE_TTL: Record<string, number> = {
  '1d': 30,   // 30 seconds - most volatile
  '7d': 60,   // 1 minute
  '30d': 120, // 2 minutes - least volatile
  all: 300,   // 5 minutes - external API, rate limited
};

export async function leaderboardRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: LeaderboardQuery }>('/leaderboard', async (request) => {
    const { timeframe = '7d', metric = 'total_pnl', limit = '50' } = request.query;

    const limitNum = Math.min(Math.max(parseInt(limit) || 50, 10), 100);
    const cacheKey = `leaderboard:${timeframe}:${metric}:${limitNum}`;

    // Check cache first
    try {
      const cached = await cacheGet<Record<string, unknown>>(cacheKey);
      if (cached) {
        return { ...cached, cached: true };
      }
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Cache read failed, falling through to DB');
    }

    let response: Record<string, unknown>;

    if (timeframe === 'all') {
      const entries = await leaderboardRepo.getAllTime(limitNum);

      response = {
        timeframe: 'all',
        metric: 'all_time_pnl',
        description: 'All-time PnL from Hyperliquid portfolio (authoritative)',
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
        note: 'All-time PnL is fetched directly from Hyperliquid and represents true lifetime performance.',
      };
    } else {
      const entries = await leaderboardRepo.get(timeframe, metric, limitNum);

      // Check actual data coverage for the requested timeframe
      const days = timeframe === '1d' ? 1 : timeframe === '7d' ? 7 : 30;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const rangeResult = await query<{ oldest: Date; newest: Date }>(
        `SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest
         FROM pnl_snapshots
         WHERE timestamp >= $1
           AND NOT (total_pnl = 0 AND realized_pnl = 0 AND unrealized_pnl = 0)`,
        [since]
      );

      const oldest = rangeResult.rows[0]?.oldest;
      const newest = rangeResult.rows[0]?.newest;
      const actualSpanMs = oldest && newest ? new Date(newest).getTime() - new Date(oldest).getTime() : 0;
      const requestedMs = days * 24 * 60 * 60 * 1000;
      const coveragePercent = requestedMs > 0 ? Math.min(100, Math.round((actualSpanMs / requestedMs) * 100)) : 0;

      let coverageWarning: string | undefined;
      if (coveragePercent < 50) {
        const actualHours = Math.round(actualSpanMs / (1000 * 60 * 60));
        coverageWarning = `Data covers ${actualHours}h of the requested ${days * 24}h (${coveragePercent}%). Rankings reflect this shorter period. Full coverage requires ${days}+ days of continuous collection.`;
      }

      response = {
        timeframe,
        metric,
        data_coverage: {
          requested_hours: days * 24,
          actual_hours: Math.round(actualSpanMs / (1000 * 60 * 60)),
          coverage_percent: coveragePercent,
          ...(coverageWarning && { warning: coverageWarning }),
        },
        data: entries.map((entry) => ({
          rank: Number(entry.rank),
          address: entry.address,
          total_pnl: entry.total_pnl,
          realized_pnl: entry.realized_pnl,
          unrealized_pnl: entry.unrealized_pnl,
          trade_count: entry.trade_count,
          tracking_since: entry.tracking_since,
          data_source: entry.data_source,
        })),
        updated_at: Math.floor(Date.now() / 1000),
      };
    }

    // Write to cache (non-blocking, don't fail the request)
    const ttl = CACHE_TTL[timeframe] ?? 60;
    cacheSet(cacheKey, response, ttl).catch((err) =>
      logger.warn({ error: (err as Error).message }, 'Cache write failed')
    );

    return { ...response, cached: false };
  });

  /**
   * GET /v1/leaderboard/info
   * 
   * Returns information about how the leaderboard works
   */
  fastify.get('/leaderboard/info', async () => {
    return {
      description: 'PnL Leaderboard - Rankings by profit and loss',
      timeframes: {
        '1d': {
          description: '24-hour PnL',
          data_source: 'Our calculated snapshots',
          accuracy: 'Accurate for data we have collected',
          limitation: 'Only includes time since we started tracking each trader',
        },
        '7d': {
          description: '7-day PnL',
          data_source: 'Our calculated snapshots',
          accuracy: 'Accurate for data we have collected',
          limitation: 'Only includes time since we started tracking each trader',
        },
        '30d': {
          description: '30-day PnL',
          data_source: 'Our calculated snapshots',
          accuracy: 'Accurate for data we have collected',
          limitation: 'Only includes time since we started tracking each trader',
        },
        all: {
          description: 'All-time PnL',
          data_source: "Hyperliquid's portfolio endpoint",
          accuracy: 'AUTHORITATIVE - directly from Hyperliquid',
          limitation: 'None - this is the official all-time PnL',
        },
      },
      metrics: {
        total_pnl: 'Realized + Unrealized PnL',
        realized_pnl: 'PnL from closed positions only',
        volume: 'Total trading volume',
      },
      fields: {
        tracking_since: 'ISO timestamp of when we started tracking this trader',
        data_source: '"calculated" = our data, "hyperliquid_portfolio" = official',
      },
      recommendation:
        'Use timeframe=all for accurate all-time rankings. Use 1d/7d/30d for recent performance tracking.',
    };
  });
}
