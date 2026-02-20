import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';

import { leaderboardRoutes } from './leaderboard.js';

vi.mock('../../../storage/db/repositories/index.js', () => ({
  leaderboardRepo: {
    get: vi.fn(),
  },
}));

import { leaderboardRepo } from '../../../storage/db/repositories/index.js';

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
      vi.mocked(leaderboardRepo.get).mockResolvedValue([
        {
          rank: 1,
          address: '0x1111111111111111111111111111111111111111',
          trader_id: 1,
          total_pnl: '50000',
          realized_pnl: '45000',
          volume: '1000000',
          trade_count: 100,
        },
        {
          rank: 2,
          address: '0x2222222222222222222222222222222222222222',
          trader_id: 2,
          total_pnl: '30000',
          realized_pnl: '28000',
          volume: '800000',
          trade_count: 75,
        },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/leaderboard',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.timeframe).toBe('7d');
      expect(body.metric).toBe('total_pnl');
      expect(body.data).toHaveLength(2);
      expect(body.data[0].rank).toBe(1);
      expect(body.data[0].address).toBe('0x1111111111111111111111111111111111111111');
    });

    it('should accept custom timeframe', async () => {
      vi.mocked(leaderboardRepo.get).mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: '/leaderboard?timeframe=30d',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.timeframe).toBe('30d');
      expect(leaderboardRepo.get).toHaveBeenCalledWith('30d', 'total_pnl', 50);
    });

    it('should accept custom metric', async () => {
      vi.mocked(leaderboardRepo.get).mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: '/leaderboard?metric=volume',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.metric).toBe('volume');
      expect(leaderboardRepo.get).toHaveBeenCalledWith('7d', 'volume', 50);
    });

    it('should accept custom limit', async () => {
      vi.mocked(leaderboardRepo.get).mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: '/leaderboard?limit=25',
      });

      expect(response.statusCode).toBe(200);
      expect(leaderboardRepo.get).toHaveBeenCalledWith('7d', 'total_pnl', 25);
    });

    it('should clamp limit to minimum 10', async () => {
      vi.mocked(leaderboardRepo.get).mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: '/leaderboard?limit=5',
      });

      expect(response.statusCode).toBe(200);
      expect(leaderboardRepo.get).toHaveBeenCalledWith('7d', 'total_pnl', 10);
    });

    it('should clamp limit to maximum 100', async () => {
      vi.mocked(leaderboardRepo.get).mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: '/leaderboard?limit=500',
      });

      expect(response.statusCode).toBe(200);
      expect(leaderboardRepo.get).toHaveBeenCalledWith('7d', 'total_pnl', 100);
    });

    it('should include updated_at timestamp', async () => {
      vi.mocked(leaderboardRepo.get).mockResolvedValue([]);

      const before = Math.floor(Date.now() / 1000);
      const response = await app.inject({
        method: 'GET',
        url: '/leaderboard',
      });
      const after = Math.floor(Date.now() / 1000);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.updated_at).toBeGreaterThanOrEqual(before);
      expect(body.updated_at).toBeLessThanOrEqual(after);
    });

    it('should return empty data for no traders', async () => {
      vi.mocked(leaderboardRepo.get).mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: '/leaderboard',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(0);
    });

    it('should handle all query parameters together', async () => {
      vi.mocked(leaderboardRepo.get).mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: '/leaderboard?timeframe=1d&metric=realized_pnl&limit=20',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.timeframe).toBe('1d');
      expect(body.metric).toBe('realized_pnl');
      expect(leaderboardRepo.get).toHaveBeenCalledWith('1d', 'realized_pnl', 20);
    });
  });
});
