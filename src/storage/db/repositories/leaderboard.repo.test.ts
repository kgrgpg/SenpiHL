import { describe, it, expect, vi, beforeEach } from 'vitest';
import { of, throwError } from 'rxjs';

vi.mock('../client.js', () => ({
  query: vi.fn(),
}));

vi.mock('../../../hyperliquid/client.js', () => ({
  fetchPortfolio: vi.fn(),
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { query } from '../client.js';
import { fetchPortfolio } from '../../../hyperliquid/client.js';
import { getLeaderboard, getAllTimeLeaderboard } from './leaderboard.repo.js';

function mockPortfolio(perpDayPnl: string, perpWeekPnl: string, perpMonthPnl: string, perpAllTimePnl: string) {
  return of([
    ['perpDay', { pnlHistory: [[Date.now(), perpDayPnl]], vlm: '100000', accountValueHistory: [] }],
    ['perpWeek', { pnlHistory: [[Date.now(), perpWeekPnl]], vlm: '500000', accountValueHistory: [] }],
    ['perpMonth', { pnlHistory: [[Date.now(), perpMonthPnl]], vlm: '2000000', accountValueHistory: [] }],
    ['perpAllTime', { pnlHistory: [[Date.now(), perpAllTimePnl]], vlm: '10000000', accountValueHistory: [] }],
    ['allTime', { pnlHistory: [[Date.now(), perpAllTimePnl]], vlm: '10000000', accountValueHistory: [] }],
  ]);
}

describe('Leaderboard Repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getLeaderboard (two-phase: snapshots + portfolio)', () => {
    it('should fetch portfolio for candidates and rank by authoritative PnL', async () => {
      // Phase 1: snapshot candidates
      vi.mocked(query)
        .mockResolvedValueOnce({
          rows: [
            { trader_id: 1, address: '0xWinner', first_seen_at: '2026-01-01', delta_pnl: '5000' },
            { trader_id: 2, address: '0xLoser', first_seen_at: '2026-01-01', delta_pnl: '3000' },
          ],
          rowCount: 2,
        })
        // Phase 3: trade counts
        .mockResolvedValueOnce({
          rows: [{ trader_id: 1, cnt: '50' }],
          rowCount: 1,
        });

      // Phase 2: portfolio fetches (0xLoser actually has higher 7d PnL than 0xWinner)
      vi.mocked(fetchPortfolio)
        .mockImplementation((address: string) => {
          if (address === '0xWinner') return mockPortfolio('1000', '8000', '20000', '100000');
          return mockPortfolio('2000', '15000', '30000', '50000');
        });

      const result = await getLeaderboard('7d', 'total_pnl', 10);

      expect(result).toHaveLength(2);
      // 0xLoser has higher perpWeek PnL (15000 > 8000), so ranked first
      expect(result[0]!.address).toBe('0xLoser');
      expect(result[0]!.total_pnl).toBe('15000');
      expect(result[0]!.data_source).toBe('hyperliquid_portfolio');
      expect(result[1]!.address).toBe('0xWinner');
      expect(result[1]!.total_pnl).toBe('8000');
      expect(result[1]!.trade_count).toBe(50);
    });

    it('should use correct portfolio period for each timeframe', async () => {
      vi.mocked(query)
        .mockResolvedValue({ rows: [
          { trader_id: 1, address: '0xT', first_seen_at: '2026-01-01', delta_pnl: '100' },
        ], rowCount: 1 });

      vi.mocked(fetchPortfolio).mockReturnValue(mockPortfolio('1000', '7000', '28000', '99000'));

      const r1d = await getLeaderboard('1d', 'total_pnl', 10);
      expect(r1d[0]!.total_pnl).toBe('1000'); // perpDay

      const r7d = await getLeaderboard('7d', 'total_pnl', 10);
      expect(r7d[0]!.total_pnl).toBe('7000'); // perpWeek

      const r30d = await getLeaderboard('30d', 'total_pnl', 10);
      expect(r30d[0]!.total_pnl).toBe('28000'); // perpMonth
    });

    it('should fall back to snapshot delta when portfolio fetch fails', async () => {
      vi.mocked(query)
        .mockResolvedValueOnce({
          rows: [{ trader_id: 1, address: '0xDown', first_seen_at: '2026-02-20', delta_pnl: '999' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      vi.mocked(fetchPortfolio).mockReturnValue(throwError(() => new Error('429')));

      const result = await getLeaderboard('7d', 'total_pnl', 10);

      expect(result).toHaveLength(1);
      expect(result[0]!.total_pnl).toBe('999');
      expect(result[0]!.data_source).toBe('snapshot_delta');
      expect(result[0]!.timeframe_coverage).toBe('partial');
    });

    it('should return empty for no candidates', async () => {
      vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await getLeaderboard('7d', 'total_pnl', 10);
      expect(result).toHaveLength(0);
    });

    it('should mark coverage as full when tracking started before timeframe', async () => {
      const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      vi.mocked(query)
        .mockResolvedValueOnce({
          rows: [{ trader_id: 1, address: '0xOld', first_seen_at: thirtyOneDaysAgo, delta_pnl: '100' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      vi.mocked(fetchPortfolio).mockReturnValue(mockPortfolio('500', '3000', '12000', '50000'));

      const result = await getLeaderboard('30d', 'total_pnl', 10);
      expect(result[0]!.timeframe_coverage).toBe('full');
    });

    it('should mark coverage as partial when tracking started within timeframe', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      vi.mocked(query)
        .mockResolvedValueOnce({
          rows: [{ trader_id: 1, address: '0xNew', first_seen_at: twoDaysAgo, delta_pnl: '100' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      vi.mocked(fetchPortfolio).mockReturnValue(mockPortfolio('500', '3000', '12000', '50000'));

      const result = await getLeaderboard('30d', 'total_pnl', 10);
      expect(result[0]!.timeframe_coverage).toBe('partial');
    });
  });

  describe('getAllTimeLeaderboard', () => {
    it('should fetch portfolio and rank by allTime PnL', async () => {
      vi.mocked(query).mockResolvedValueOnce({
        rows: [
          { id: 1, address: '0xA', first_seen_at: '2026-01-01' },
          { id: 2, address: '0xB', first_seen_at: '2026-01-01' },
        ],
        rowCount: 2,
      });

      vi.mocked(fetchPortfolio).mockImplementation((address: string) => {
        if (address === '0xA') return mockPortfolio('100', '700', '2800', '50000');
        return mockPortfolio('200', '1400', '5600', '80000');
      });

      const result = await getAllTimeLeaderboard(10);

      expect(result).toHaveLength(2);
      expect(result[0]!.address).toBe('0xB');
      expect(result[0]!.all_time_pnl).toBe('80000');
      expect(result[1]!.address).toBe('0xA');
      expect(result[1]!.all_time_pnl).toBe('50000');
    });
  });
});
