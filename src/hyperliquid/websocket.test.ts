import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { take } from 'rxjs/operators';

vi.mock('../utils/config.js', () => ({
  config: {
    HYPERLIQUID_WS_URL: 'ws://localhost:9999',
    LOG_LEVEL: 'silent',
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

let openHandler: (() => void) | null = null;
let messageHandler: ((data: Buffer) => void) | null = null;
let closeHandler: ((code: number, reason: Buffer) => void) | null = null;

const mockWsSend = vi.fn();
const mockWsClose = vi.fn();

vi.mock('ws', () => {
  const WS_OPEN = 1;
  const MockWebSocket = vi.fn().mockImplementation(() => {
    const instance = {
      readyState: WS_OPEN,
      send: mockWsSend,
      close: mockWsClose,
      on: vi.fn().mockImplementation((event: string, handler: unknown) => {
        if (event === 'open') openHandler = handler as () => void;
        if (event === 'message') messageHandler = handler as (data: Buffer) => void;
        if (event === 'close') closeHandler = handler as (code: number, reason: Buffer) => void;
        if (event === 'error') { /* noop */ }
      }),
    };
    // Auto-fire open after microtask
    setTimeout(() => openHandler?.(), 5);
    return instance;
  });
  // Attach the OPEN static constant so `WebSocket.OPEN` resolves
  (MockWebSocket as Record<string, unknown>).OPEN = WS_OPEN;
  return { default: MockWebSocket };
});

import { HyperliquidWebSocket } from './websocket.js';

describe('HyperliquidWebSocket', () => {
  let ws: HyperliquidWebSocket;

  beforeEach(async () => {
    vi.clearAllMocks();
    openHandler = null;
    messageHandler = null;
    closeHandler = null;
    mockWsSend.mockReset();
    mockWsClose.mockReset();
    ws = new HyperliquidWebSocket();
    ws.connect();
    // Wait for the mock 'open' handler to fire
    await new Promise((r) => setTimeout(r, 20));
  });

  afterEach(() => {
    ws.disconnect();
  });

  describe('subscriptions', () => {
    it('should track user subscription count correctly', () => {
      expect(ws.userSubscriptionCount).toBe(0);

      ws.subscribeToUserFills('0xUser1');
      expect(ws.userSubscriptionCount).toBe(1);

      ws.subscribeToUserFills('0xUser2');
      expect(ws.userSubscriptionCount).toBe(2);

      // Duplicate (same key) — should not increment
      ws.subscribeToUserFills('0xUser1');
      expect(ws.userSubscriptionCount).toBe(2);
    });

    it('should decrement user count on unsubscribe', () => {
      ws.subscribeToUserFills('0xUser1');
      ws.subscribeToUserFills('0xUser2');
      expect(ws.userSubscriptionCount).toBe(2);

      ws.unsubscribeFromUserFills('0xUser1');
      expect(ws.userSubscriptionCount).toBe(1);
    });

    it('should count coin subscriptions separately from user subscriptions', () => {
      ws.subscribeToTrades('BTC');
      ws.subscribeToTrades('ETH');
      ws.subscribeToAllMids();

      expect(ws.userSubscriptionCount).toBe(0);
      expect(ws.subscriptionCount).toBe(3);
    });

    it('should not duplicate subscriptions for the same key', () => {
      ws.subscribeToTrades('BTC');
      ws.subscribeToTrades('BTC');
      expect(ws.subscriptionCount).toBe(1);
    });

    it('should send subscription message to WS', () => {
      ws.subscribeToTrades('BTC');
      expect(mockWsSend).toHaveBeenCalledWith(
        expect.stringContaining('"type":"trades"')
      );
    });
  });

  describe('allMids subscription', () => {
    it('should filter and map allMids messages', () => {
      const received: Record<string, string>[] = [];
      ws.subscribeToAllMids().subscribe((m) => received.push(m));

      messageHandler?.(Buffer.from(JSON.stringify({
        channel: 'allMids',
        data: { mids: { BTC: '60000', ETH: '3200' } },
      })));

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ BTC: '60000', ETH: '3200' });
    });

    it('should ignore non-allMids messages', () => {
      const received: unknown[] = [];
      ws.subscribeToAllMids().subscribe((m) => received.push(m));

      messageHandler?.(Buffer.from(JSON.stringify({
        channel: 'trades',
        data: { coin: 'BTC', trades: [] },
      })));

      expect(received).toHaveLength(0);
    });
  });

  describe('trades subscription', () => {
    it('should filter trades by coin', () => {
      const btcTrades: unknown[] = [];
      ws.subscribeToTrades('BTC').subscribe((t) => btcTrades.push(t));

      // BTC trade — should match
      messageHandler?.(Buffer.from(JSON.stringify({
        channel: 'trades',
        data: { coin: 'BTC', trades: [{ px: '60000', sz: '1' }] },
      })));

      // ETH trade — should not match
      messageHandler?.(Buffer.from(JSON.stringify({
        channel: 'trades',
        data: { coin: 'ETH', trades: [{ px: '3200', sz: '10' }] },
      })));

      expect(btcTrades).toHaveLength(1);
    });
  });

  describe('heartbeat / pong filtering', () => {
    it('should filter pong messages from the message subject', () => {
      const received: unknown[] = [];
      ws.subscribeToTrades('BTC').subscribe((m) => received.push(m));

      // Pong should be silently dropped
      messageHandler?.(Buffer.from(JSON.stringify({ channel: 'pong' })));

      // Regular trade should pass through
      messageHandler?.(Buffer.from(JSON.stringify({
        channel: 'trades',
        data: { coin: 'BTC', trades: [{ px: '60000' }] },
      })));

      expect(received).toHaveLength(1);
    });
  });

  describe('connection lifecycle', () => {
    it('should clear subscriptions on disconnect', () => {
      ws.subscribeToTrades('BTC');
      ws.subscribeToUserFills('0xUser');
      expect(ws.subscriptionCount).toBe(2);

      ws.disconnect();
      expect(ws.subscriptionCount).toBe(0);
    });

    it('should expose connection state observable', () => {
      const states: string[] = [];
      ws.state$.pipe(take(1)).subscribe((s) => states.push(s));
      expect(states[0]).toBe('connected');
    });
  });
});
