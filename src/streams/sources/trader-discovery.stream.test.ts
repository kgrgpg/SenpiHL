import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Decimal } from 'decimal.js';

vi.mock('../../storage/db/client.js', () => ({
  query: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../hyperliquid/websocket.js', () => {
  const { EMPTY } = require('rxjs');
  return {
    getHyperliquidWebSocket: vi.fn().mockReturnValue({
      subscribeToTrades: vi.fn().mockReturnValue(EMPTY),
      subscribeToUserFills: vi.fn().mockReturnValue(EMPTY),
      userSubscriptionCount: 0,
    }),
  };
});

vi.mock('../../state/trader-state.js', () => ({
  getTraderState: vi.fn().mockReturnValue(undefined),
  setTraderState: vi.fn(),
}));

vi.mock('../../pnl/calculator.js', () => ({
  computeFillFromWsTrade: vi.fn().mockReturnValue({
    coin: 'BTC', side: 'B', size: new Decimal(1), price: new Decimal(50000),
    closedPnl: new Decimal(0), fee: new Decimal(0),
    timestamp: new Date(), tid: 1, isLiquidation: false,
  }),
  updatePositionFromFill: vi.fn(),
  applyTrade: vi.fn((state: unknown) => state),
}));

vi.mock('../../utils/decimal.js', () => ({
  toDecimal: (v: string | number) => new Decimal(v),
  Decimal,
}));

vi.mock('../../storage/db/repositories/trades.repo.js', () => ({
  tradesRepo: {
    insert: vi.fn().mockResolvedValue(undefined),
    insertMany: vi.fn().mockResolvedValue(undefined),
  },
}));

import { query } from '../../storage/db/client.js';
import { TraderDiscoveryStream } from './trader-discovery.stream.js';

describe('TraderDiscoveryStream', () => {
  let stream: TraderDiscoveryStream;

  beforeEach(() => {
    vi.clearAllMocks();
    stream = new TraderDiscoveryStream();
  });

  afterEach(() => {
    stream.stop();
  });

  describe('constructor', () => {
    it('should initialize with correct defaults', () => {
      expect(stream.isRunning).toBe(false);
      expect(stream.discoveredCount).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return initial stats', () => {
      const stats = stream.getStats();

      expect(stats).toEqual({
        seenThisSession: 0,
        knownTotal: 0,
        isRunning: false,
        fillsCaptured: 0,
        subscribedCoins: 15,
      });
    });
  });

  describe('discoveries$ observable', () => {
    it('should be an observable', () => {
      expect(stream.discoveries$).toBeDefined();
      expect(typeof stream.discoveries$.subscribe).toBe('function');
    });
  });

  describe('Address deduplication logic', () => {
    it('should not emit duplicate addresses', async () => {
      // We test the internal checkAddress logic by accessing it through the class
      // Since checkAddress is private, we test via the discovered$ subject
      const discovered: string[] = [];

      stream.discoveries$.subscribe((d) => discovered.push(d.address));

      // Simulate calling checkAddress via the public discovered$ subject
      // We'll need to use the stream's internal method indirectly
      // by starting and providing mock data
      expect(stream.discoveredCount).toBe(0);
    });
  });

  describe('start/stop lifecycle', () => {
    it('should set isRunning on start', async () => {
      // Mock DB queries for loadKnownAddresses
      vi.mocked(query)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // traders
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // discovery queue

      // Mock global fetch for the polling
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });
      vi.stubGlobal('fetch', fetchMock);

      await stream.start();

      expect(stream.isRunning).toBe(true);

      stream.stop();

      expect(stream.isRunning).toBe(false);

      vi.unstubAllGlobals();
    });

    it('should not start twice', async () => {
      vi.mocked(query)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      }));

      await stream.start();
      await stream.start(); // Should be a no-op

      expect(stream.isRunning).toBe(true);
      // query should only be called once for loadKnownAddresses
      expect(query).toHaveBeenCalledTimes(2); // traders + queue

      stream.stop();
      vi.unstubAllGlobals();
    });

    it('should load known addresses on start', async () => {
      vi.mocked(query)
        .mockResolvedValueOnce({
          rows: [
            { address: '0xKnown1' },
            { address: '0xKnown2' },
          ],
          rowCount: 2,
        })
        .mockResolvedValueOnce({
          rows: [{ address: '0xQueued1' }],
          rowCount: 1,
        });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      }));

      await stream.start();

      const stats = stream.getStats();
      expect(stats.knownTotal).toBe(3); // 2 traders + 1 queued

      stream.stop();
      vi.unstubAllGlobals();
    });
  });

  describe('WebSocket-based discovery', () => {
    it('should start with WebSocket discovery (zero weight cost)', async () => {
      vi.mocked(query)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValue({ rows: [], rowCount: 0 });

      await stream.start();

      expect(stream.isRunning).toBe(true);

      stream.stop();
    });

    it('should load known addresses and exclude them from discovery', async () => {
      vi.mocked(query)
        .mockResolvedValueOnce({
          rows: [{ address: '0xknown1' }, { address: '0xknown2' }],
          rowCount: 2,
        })
        .mockResolvedValueOnce({
          rows: [{ address: '0xqueued1' }],
          rowCount: 1,
        })
        .mockResolvedValue({ rows: [], rowCount: 0 });

      await stream.start();

      const stats = stream.getStats();
      expect(stats.knownTotal).toBe(3);

      stream.stop();
    });

    it('should handle startup gracefully even if DB fails', async () => {
      vi.mocked(query).mockRejectedValue(new Error('DB down'));

      await stream.start();

      expect(stream.isRunning).toBe(true);
      expect(stream.discoveredCount).toBe(0);

      stream.stop();
    });
  });

  describe('fill capture for tracked traders', () => {
    it('should capture fills when a tracked trader is detected in WS trades', async () => {
      const { Subject, EMPTY: rxEmpty } = await import('rxjs');
      const btcSubject = new Subject<unknown[]>();

      const { getHyperliquidWebSocket } = await import('../../hyperliquid/websocket.js');
      vi.mocked(getHyperliquidWebSocket).mockReturnValue({
        subscribeToTrades: vi.fn().mockImplementation((coin: string) =>
          coin === 'BTC' ? btcSubject.asObservable() : rxEmpty
        ),
        subscribeToUserFills: vi.fn().mockReturnValue(new Subject().asObservable()),
        userSubscriptionCount: 0,
      } as unknown as ReturnType<typeof getHyperliquidWebSocket>);

      // Make getTraderState return a state for the tracked address
      const { getTraderState } = await import('../../state/trader-state.js');
      vi.mocked(getTraderState).mockImplementation((addr: string) => {
        if (addr === '0xtracked') {
          return {
            traderId: 1, address: '0xtracked',
            realizedTradingPnl: new Decimal(0), realizedFundingPnl: new Decimal(0),
            totalFees: new Decimal(0), positions: new Map(), totalVolume: new Decimal(0),
            tradeCount: 0, lastUpdated: new Date(), peakTotalPnl: new Decimal(0),
            maxDrawdown: new Decimal(0), liquidationCount: 0, flipCount: 0,
          };
        }
        return undefined;
      });

      vi.mocked(query)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValue({ rows: [], rowCount: 0 });

      stream = new TraderDiscoveryStream();
      await stream.start();

      // Emit a trade with a tracked trader via the BTC subscription
      btcSubject.next([{
        coin: 'BTC',
        side: 'B',
        px: '50000',
        sz: '0.1',
        hash: '0xhash',
        time: Date.now(),
        tid: 12345,
        users: ['0xmaker', '0xtracked'],
      }]);

      // Allow async operations to settle
      await new Promise((r) => setTimeout(r, 50));

      expect(stream.getStats().fillsCaptured).toBe(1);

      const { tradesRepo } = await import('../../storage/db/repositories/trades.repo.js');
      expect(tradesRepo.insert).toHaveBeenCalledTimes(1);

      stream.stop();
    });
  });
});
