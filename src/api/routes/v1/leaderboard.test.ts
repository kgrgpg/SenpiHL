import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';

import { leaderboardRoutes } from './leaderboard.js';

vi.mock('../../../storage/db/repositories/index.js', () => ({
  leaderboardRepo: {
    get: vi.fn(),
  },
}));

vi.mock('../../../storage/cache/redis.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { leaderboardRepo } from '../../../storage/db/repositories/index.js';
import { cacheGet, cacheSet } from '../../../storage/cache/redis.js';

function mockLeaderboardRows(count = 2) {
  return Array.from({ length: count }, (_, i) => ({
    rank: i + 1,
    address: `0x${'1'.repeat(40 - String(i + 1).length)}${i + 1}`,
    trader_id: i + 1,
    total_pnl: String(50000 - i * 20000),
    trade_count: 100 - i * 25,
    tracking_since: '2026-02-20T21:00:00.000Z',
    data_source: 'hyperliquid_portfolio' as const,
    timeframe_coverage: 'full' as const,
  }));
}

describe('Leaderboard Routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    await app.register(leaderboardRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  describe('GET /leaderboard', () => {
    it('should return leaderboard with default parameters', async () => {
      vi.mocked(leaderboardRepo.get).mockResolvedValue(mockLeaderboardRows());

      const response = await app.inject({ method: 'GET', url: '/leaderboard' });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.timeframe).toBe('7d');
      expect(body.data).toHaveLength(2);
      expect(body.data[0].rank).toBe(1);
      expect(body.data[0].data_source).toBe('hyperliquid_portfolio');
      expect(body.data[0].timeframe_coverage).toBe('full');
    });

    it('should accept custom timeframe', async () => {
      vi.mocked(leaderboardRepo.get).mockResolvedValue([]);

      const response = await app.inject({ method: 'GET', url: '/leaderboard?timeframe=30d' });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.timeframe).toBe('30d');
      expect(leaderboardRepo.get).toHaveBeenCalledWith('30d', 'total_pnl', 50);
    });

    it('should accept custom metric', async () => {
      vi.mocked(leaderboardRepo.get).mockResolvedValue([]);
      await app.inject({ method: 'GET', url: '/leaderboard?metric=volume' });
      expect(leaderboardRepo.get).toHaveBeenCalledWith('7d', 'volume', 50);
    });

    it('should clamp limit to minimum 10', async () => {
      vi.mocked(leaderboardRepo.get).mockResolvedValue([]);
      await app.inject({ method: 'GET', url: '/leaderboard?limit=5' });
      expect(leaderboardRepo.get).toHaveBeenCalledWith('7d', 'total_pnl', 10);
    });

    it('should clamp limit to maximum 100', async () => {
      vi.mocked(leaderboardRepo.get).mockResolvedValue([]);
      await app.inject({ method: 'GET', url: '/leaderboard?limit=500' });
      expect(leaderboardRepo.get).toHaveBeenCalledWith('7d', 'total_pnl', 100);
    });

    it('should include data_quality stats', async () => {
      vi.mocked(leaderboardRepo.get).mockResolvedValue(mockLeaderboardRows());

      const response = await app.inject({ method: 'GET', url: '/leaderboard' });
      const body = JSON.parse(response.body);

      expect(body.data_quality).toBeDefined();
      expect(body.data_quality.total_traders).toBe(2);
      expect(body.data_quality.portfolio_sourced).toBe(2);
      expect(body.data_quality.full_timeframe_coverage).toBe(2);
    });

    it('should include updated_at timestamp', async () => {
      vi.mocked(leaderboardRepo.get).mockResolvedValue([]);

      const before = Math.floor(Date.now() / 1000);
      const response = await app.inject({ method: 'GET', url: '/leaderboard' });
      const after = Math.floor(Date.now() / 1000);

      const body = JSON.parse(response.body);
      expect(body.updated_at).toBeGreaterThanOrEqual(before);
      expect(body.updated_at).toBeLessThanOrEqual(after);
    });

    it('should return cached data on cache hit', async () => {
      const cachedData = {
        timeframe: '7d',
        data: [{ rank: 1, address: '0xCached' }],
        updated_at: 12345,
      };
      vi.mocked(cacheGet).mockResolvedValue(cachedData);

      const response = await app.inject({ method: 'GET', url: '/leaderboard' });
      const body = JSON.parse(response.body);

      expect(body.cached).toBe(true);
      expect(body.data[0].address).toBe('0xCached');
      expect(leaderboardRepo.get).not.toHaveBeenCalled();
    });

    it('should write to cache on miss with v2 key', async () => {
      vi.mocked(cacheGet).mockResolvedValue(null);
      vi.mocked(leaderboardRepo.get).mockResolvedValue([]);

      const response = await app.inject({ method: 'GET', url: '/leaderboard' });
      const body = JSON.parse(response.body);

      expect(body.cached).toBe(false);
      expect(cacheSet).toHaveBeenCalledWith(
        'leaderboard:v2:7d:total_pnl:50',
        expect.objectContaining({ timeframe: '7d' }),
        120
      );
    });

    it('should fall through to repo if cache read fails', async () => {
      vi.mocked(cacheGet).mockRejectedValue(new Error('Redis down'));
      vi.mocked(leaderboardRepo.get).mockResolvedValue([]);

      const response = await app.inject({ method: 'GET', url: '/leaderboard' });
      expect(response.statusCode).toBe(200);
      expect(leaderboardRepo.get).toHaveBeenCalled();
    });

    it('should return empty data for no traders', async () => {
      vi.mocked(leaderboardRepo.get).mockResolvedValue([]);

      const response = await app.inject({ method: 'GET', url: '/leaderboard' });
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(0);
    });

    it('should handle partial coverage traders', async () => {
      const mixed = [
        { ...mockLeaderboardRows(1)[0]!, timeframe_coverage: 'full' as const },
        { ...mockLeaderboardRows(1)[0]!, rank: 2, address: '0xPartial', timeframe_coverage: 'partial' as const },
      ];
      vi.mocked(leaderboardRepo.get).mockResolvedValue(mixed);

      const response = await app.inject({ method: 'GET', url: '/leaderboard' });
      const body = JSON.parse(response.body);

      expect(body.data_quality.full_timeframe_coverage).toBe(1);
      expect(body.data_quality.partial_coverage).toBe(1);
    });
  });
});
