import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Subject, of, EMPTY } from 'rxjs';
import { take, toArray } from 'rxjs/operators';

vi.mock('../../utils/config.js', () => ({
  config: {
    POLL_INTERVAL_MS: 300000,
    LOG_LEVEL: 'silent',
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const fillSubjects = new Map<string, Subject<unknown>>();
let userSubCount = 0;

vi.mock('../../hyperliquid/websocket.js', () => ({
  getHyperliquidWebSocket: vi.fn().mockReturnValue({
    subscribeToUserFills: vi.fn().mockImplementation((address: string) => {
      const subject = new Subject();
      fillSubjects.set(address, subject);
      userSubCount++;
      return subject.asObservable();
    }),
    unsubscribeFromUserFills: vi.fn().mockImplementation((address: string) => {
      fillSubjects.delete(address);
      userSubCount--;
    }),
    get userSubscriptionCount() {
      return userSubCount;
    },
    connect: vi.fn(),
  }),
}));

vi.mock('../../hyperliquid/client.js', () => ({
  fetchClearinghouseState: vi.fn().mockReturnValue(of({
    assetPositions: [],
    crossMarginSummary: { accountValue: '1000', totalMarginUsed: '0', totalNtlPos: '0', totalRawUsd: '1000' },
    marginSummary: { accountValue: '1000', totalMarginUsed: '0', totalNtlPos: '0', totalRawUsd: '1000' },
    crossMaintenanceMarginUsed: '0',
    withdrawable: '1000',
  })),
}));

import { HybridDataStream } from './hybrid.stream.js';

describe('HybridDataStream', () => {
  let stream: HybridDataStream;

  beforeEach(() => {
    vi.clearAllMocks();
    fillSubjects.clear();
    userSubCount = 0;
    stream = new HybridDataStream();
  });

  afterEach(() => {
    stream.disconnect();
  });

  describe('subscription management', () => {
    it('should subscribe a trader and increment count', () => {
      stream.subscribeTrader('0xTrader1');
      expect(stream.traderCount).toBe(1);
    });

    it('should not duplicate subscriptions', () => {
      stream.subscribeTrader('0xTrader1');
      stream.subscribeTrader('0xTrader1');
      expect(stream.traderCount).toBe(1);
    });

    it('should unsubscribe a trader and decrement count', () => {
      stream.subscribeTrader('0xTrader1');
      stream.subscribeTrader('0xTrader2');
      expect(stream.traderCount).toBe(2);

      stream.unsubscribeTrader('0xTrader1');
      expect(stream.traderCount).toBe(1);
    });

    it('should handle unsubscribing non-existent trader gracefully', () => {
      stream.unsubscribeTrader('0xNonExistent');
      expect(stream.traderCount).toBe(0);
    });
  });

  describe('WebSocket user limit (10 max)', () => {
    it('should subscribe first 10 traders to userFills via WebSocket', () => {
      for (let i = 0; i < 10; i++) {
        stream.subscribeTrader(`0xTrader${i}`);
      }
      // All 10 should have WS fill subscriptions
      expect(fillSubjects.size).toBe(10);
    });

    it('should subscribe trader 11+ as polling-only (no WS fills)', () => {
      for (let i = 0; i < 12; i++) {
        stream.subscribeTrader(`0xTrader${i}`);
      }
      expect(stream.traderCount).toBe(12);
      // Only first 10 get WS subscriptions
      expect(fillSubjects.size).toBe(10);
    });
  });

  describe('event streaming', () => {
    it('should emit fill events from WebSocket', async () => {
      const events: unknown[] = [];
      stream.stream$.subscribe((e) => events.push(e));

      stream.subscribeTrader('0xTrader1');

      // Simulate a fill via the WS subject
      const subject = fillSubjects.get('0xTrader1');
      subject?.next({
        coin: 'BTC',
        px: '60000',
        sz: '1',
        side: 'B',
        time: Date.now(),
        closedPnl: '0',
        fee: '5.0',
        tid: 1,
        hash: '0x123',
        oid: 1,
        crossed: true,
        startPosition: '0',
        dir: 'Open Long',
        feeToken: 'USDC',
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(events.length).toBe(1); // fill only (initial snapshot deferred to polling loop)
      expect(events[0]).toMatchObject({ type: 'fill', address: '0xTrader1' });
    });

    it('should register trader for polling', () => {
      stream.subscribeTrader('0xTrader1');
      expect(stream.traderCount).toBe(1);
    });
  });

  describe('cleanup', () => {
    it('should disconnect all traders on disconnect', () => {
      stream.subscribeTrader('0xT1');
      stream.subscribeTrader('0xT2');
      stream.subscribeTrader('0xT3');
      expect(stream.traderCount).toBe(3);

      stream.disconnect();
      expect(stream.traderCount).toBe(0);
    });
  });
});
