import { describe, it, expect, vi, beforeEach } from 'vitest';
import { firstValueFrom, of, throwError } from 'rxjs';

vi.mock('../storage/db/client.js', () => ({
  query: vi.fn(),
}));

vi.mock('../hyperliquid/client.js', () => ({
  hyperliquidClient: {
    isValidAddress: vi.fn(),
  },
}));

vi.mock('../streams/sources/hybrid.stream.js', () => ({
  getHybridDataStream: vi.fn().mockReturnValue({
    subscribeTrader: vi.fn(),
  }),
}));

vi.mock('../state/trader-state.js', () => ({
  initializeTraderState: vi.fn(),
}));

vi.mock('./backfill.js', () => ({
  scheduleBackfill: vi.fn().mockResolvedValue({ id: 'backfill-1' }),
}));

vi.mock('../utils/config.js', () => ({
  config: {
    USE_HYBRID_MODE: true,
    REDIS_URL: 'redis://localhost:6379',
    BACKFILL_DAYS: 30,
    LOG_LEVEL: 'info',
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { query } from '../storage/db/client.js';
import { hyperliquidClient } from '../hyperliquid/client.js';
import { initializeTraderState } from '../state/trader-state.js';
import { getHybridDataStream } from '../streams/sources/hybrid.stream.js';
import { scheduleBackfill } from './backfill.js';
import { processDiscoveryQueue$ } from './auto-subscribe.js';

describe('Auto-Subscribe Job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('processDiscoveryQueue$', () => {
    it('should return zero stats when queue is empty', async () => {
      vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await firstValueFrom(processDiscoveryQueue$());

      expect(result).toEqual({ processed: 0, subscribed: 0, skipped: 0 });
    });

    it('should process and subscribe a new trader', async () => {
      // First call: fetch pending traders
      vi.mocked(query)
        .mockResolvedValueOnce({
          rows: [{
            id: 1,
            address: '0xNewTrader',
            source: 'market_trade',
            priority: 1,
            notes: null,
          }],
          rowCount: 1,
        })
        // Second: traderExists check
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // Third: INSERT trader
        .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })
        // Fourth: markProcessed
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      vi.mocked(hyperliquidClient.isValidAddress).mockReturnValue(true);

      const result = await firstValueFrom(processDiscoveryQueue$());

      expect(result.processed).toBe(1);
      expect(result.subscribed).toBe(1);
      expect(result.skipped).toBe(0);
      expect(initializeTraderState).toHaveBeenCalledWith(42, '0xnewtrader');
      expect(getHybridDataStream().subscribeTrader).toHaveBeenCalledWith('0xnewtrader');
      expect(scheduleBackfill).toHaveBeenCalledWith('0xnewtrader', 30);
    });

    it('should skip already-subscribed traders', async () => {
      vi.mocked(query)
        .mockResolvedValueOnce({
          rows: [{
            id: 1,
            address: '0xExistingTrader',
            source: 'market_trade',
            priority: 1,
            notes: null,
          }],
          rowCount: 1,
        })
        // traderExists returns true
        .mockResolvedValueOnce({ rows: [{ id: 10 }], rowCount: 1 })
        // markProcessed
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      vi.mocked(hyperliquidClient.isValidAddress).mockReturnValue(true);

      const result = await firstValueFrom(processDiscoveryQueue$());

      expect(result.processed).toBe(1);
      expect(result.subscribed).toBe(0);
      expect(result.skipped).toBe(1);
      expect(initializeTraderState).not.toHaveBeenCalled();
    });

    it('should skip invalid addresses', async () => {
      vi.mocked(query)
        .mockResolvedValueOnce({
          rows: [{
            id: 1,
            address: 'not-an-address',
            source: 'market_trade',
            priority: 1,
            notes: null,
          }],
          rowCount: 1,
        })
        // markProcessed
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      vi.mocked(hyperliquidClient.isValidAddress).mockReturnValue(false);

      const result = await firstValueFrom(processDiscoveryQueue$());

      expect(result.processed).toBe(1);
      expect(result.subscribed).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('should process multiple traders sequentially', async () => {
      vi.mocked(query)
        .mockResolvedValueOnce({
          rows: [
            { id: 1, address: '0xTrader1', source: 'market_trade', priority: 2, notes: null },
            { id: 2, address: '0xTrader2', source: 'market_trade', priority: 1, notes: null },
          ],
          rowCount: 2,
        })
        // Trader1: exists check -> no
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // Trader1: INSERT
        .mockResolvedValueOnce({ rows: [{ id: 100 }], rowCount: 1 })
        // Trader1: markProcessed
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // Trader2: exists check -> yes (already subscribed)
        .mockResolvedValueOnce({ rows: [{ id: 200 }], rowCount: 1 })
        // Trader2: markProcessed
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      vi.mocked(hyperliquidClient.isValidAddress).mockReturnValue(true);

      const result = await firstValueFrom(processDiscoveryQueue$());

      expect(result.processed).toBe(2);
      expect(result.subscribed).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it('should handle DB errors gracefully', async () => {
      vi.mocked(query).mockRejectedValue(new Error('DB connection lost'));

      const result = await firstValueFrom(processDiscoveryQueue$());

      expect(result).toEqual({ processed: 0, subscribed: 0, skipped: 0 });
    });

    it('should handle individual trader processing errors', async () => {
      vi.mocked(query)
        .mockResolvedValueOnce({
          rows: [{
            id: 1,
            address: '0xErrorTrader',
            source: 'market_trade',
            priority: 1,
            notes: null,
          }],
          rowCount: 1,
        })
        // traderExists fails
        .mockRejectedValueOnce(new Error('Query timeout'));

      vi.mocked(hyperliquidClient.isValidAddress).mockReturnValue(true);

      const result = await firstValueFrom(processDiscoveryQueue$());

      expect(result.processed).toBe(1);
      expect(result.subscribed).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });
});
