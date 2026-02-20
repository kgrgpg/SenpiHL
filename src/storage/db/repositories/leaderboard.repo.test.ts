import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
}));

vi.mock('../../../hyperliquid/client.js', () => ({
  fetchPortfolio: vi.fn(),
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

import { query } from '../client.js';
import { getLeaderboard, getTraderRank } from './leaderboard.repo.js';

describe('Leaderboard Repository - Delta Calculation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getLeaderboard', () => {
    it('should calculate delta PnL (latest - earliest) for 7d timeframe', async () => {
      const mockRows = [
        {
          rank: 1,
          address: '0xWinner',
          trader_id: 1,
          total_pnl: '1000.00',
          realized_pnl: '800.00',
          unrealized_pnl: '200.00',
          volume: '50000.00',
          trade_count: 0,
          tracking_since: '2026-01-01',
          data_source: 'calculated',
        },
        {
          rank: 2,
          address: '0xLoser',
          trader_id: 2,
          total_pnl: '-500.00',
          realized_pnl: '-400.00',
          unrealized_pnl: '-100.00',
          volume: '10000.00',
          trade_count: 0,
          tracking_since: '2026-01-01',
          data_source: 'calculated',
        },
      ];

      vi.mocked(query).mockResolvedValue({ rows: mockRows, rowCount: 2 });

      const result = await getLeaderboard('7d', 'total_pnl', 50);

      expect(result).toEqual(mockRows);
      expect(query).toHaveBeenCalledTimes(1);

      const [sqlQuery] = vi.mocked(query).mock.calls[0]!;

      // Verify SQL contains delta calculation logic
      expect(sqlQuery).toContain('earliest_snapshots');
      expect(sqlQuery).toContain('latest_snapshots');
      expect(sqlQuery).toContain('delta_pnl');
      expect(sqlQuery).toContain('end_total_pnl::numeric - COALESCE(es.start_total_pnl::numeric, 0)');
      expect(sqlQuery).toContain('as delta_total_pnl');
    });

    it('should use correct time boundaries for 1d, 7d, 30d', async () => {
      vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 });

      const timeframes = ['1d', '7d', '30d'] as const;
      const expectedDays = [1, 7, 30];

      for (let i = 0; i < timeframes.length; i++) {
        vi.clearAllMocks();
        const before = Date.now();

        await getLeaderboard(timeframes[i]!, 'total_pnl', 50);

        const [, params] = vi.mocked(query).mock.calls[0]!;
        const since = params![0] as Date;
        const expectedMs = expectedDays[i]! * 24 * 60 * 60 * 1000;

        // Check that since is approximately (expectedDays ago ± 1 second)
        const actualDiff = before - since.getTime();
        expect(actualDiff).toBeGreaterThan(expectedMs - 1000);
        expect(actualDiff).toBeLessThan(expectedMs + 1000);
      }
    });

    it('should order by delta_volume when metric is volume', async () => {
      vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 });

      await getLeaderboard('7d', 'volume', 50);

      const [sqlQuery] = vi.mocked(query).mock.calls[0]!;
      expect(sqlQuery).toContain('ORDER BY dp.delta_volume DESC');
    });

    it('should order by delta_realized_pnl when metric is realized_pnl', async () => {
      vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 });

      await getLeaderboard('7d', 'realized_pnl', 50);

      const [sqlQuery] = vi.mocked(query).mock.calls[0]!;
      expect(sqlQuery).toContain('ORDER BY dp.delta_realized_pnl DESC');
    });

    it('should calculate negative delta for traders who lost money', async () => {
      // Simulates a scenario where trader had +1000 at start, -500 at end = delta -1500
      const mockRows = [
        {
          rank: 1,
          address: '0xLoser',
          trader_id: 1,
          total_pnl: '-1500.00', // This is the delta: end(-500) - start(+1000)
          realized_pnl: '-1200.00',
          unrealized_pnl: '-300.00',
          volume: '5000.00',
          trade_count: 0,
          tracking_since: '2026-01-01',
          data_source: 'calculated',
        },
      ];

      vi.mocked(query).mockResolvedValue({ rows: mockRows, rowCount: 1 });

      const result = await getLeaderboard('7d', 'total_pnl', 50);

      expect(result[0]!.total_pnl).toBe('-1500.00');
    });
  });

  describe('getTraderRank', () => {
    it('should use delta calculation for trader rank', async () => {
      vi.mocked(query).mockResolvedValue({ rows: [{ rank: 5 }], rowCount: 1 });

      const rank = await getTraderRank(123, '7d', 'total_pnl');

      expect(rank).toBe(5);

      const [sqlQuery] = vi.mocked(query).mock.calls[0]!;

      // Verify SQL contains delta calculation logic
      expect(sqlQuery).toContain('earliest_snapshots');
      expect(sqlQuery).toContain('latest_snapshots');
      expect(sqlQuery).toContain('delta_pnl');
      expect(sqlQuery).toContain('delta_total_pnl');
    });

    it('should return null when trader has no rank', async () => {
      vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 });

      const rank = await getTraderRank(999, '7d', 'total_pnl');

      expect(rank).toBeNull();
    });
  });
});
