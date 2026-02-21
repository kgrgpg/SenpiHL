import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Subject } from 'rxjs';

const allMidsSubject = new Subject<Record<string, string>>();

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../hyperliquid/websocket.js', () => {
  // Import from the test scope via closure — vi.mock factories are hoisted
  // but the module-level allMidsSubject is available since Subject is statically initialized.
  const { Subject: RxSubject } = require('rxjs');
  const subject = new RxSubject();
  // Expose on globalThis so tests can push values
  (globalThis as Record<string, unknown>).__testAllMidsSubject = subject;
  return {
    getHyperliquidWebSocket: vi.fn().mockReturnValue({
      subscribeToAllMids: vi.fn().mockReturnValue(subject.asObservable()),
    }),
  };
});

function getTestSubject(): Subject<Record<string, string>> {
  return (globalThis as Record<string, unknown>).__testAllMidsSubject as Subject<Record<string, string>>;
}

import {
  startPriceService,
  stopPriceService,
  getMarkPrice,
  getAllPrices,
  getPriceCount,
} from './price-service.js';

describe('PriceService', () => {
  beforeEach(() => {
    stopPriceService();
  });

  afterEach(() => {
    stopPriceService();
  });

  it('should start and track prices from allMids', () => {
    startPriceService();
    getTestSubject().next({ BTC: '60000.5', ETH: '3200.25', SOL: '150.10' });

    expect(getPriceCount()).toBe(3);
    expect(getMarkPrice('BTC')!.toNumber()).toBe(60000.5);
    expect(getMarkPrice('ETH')!.toNumber()).toBe(3200.25);
    expect(getMarkPrice('SOL')!.toNumber()).toBe(150.10);
  });

  it('should update prices on subsequent allMids events', () => {
    startPriceService();
    getTestSubject().next({ BTC: '60000' });
    expect(getMarkPrice('BTC')!.toNumber()).toBe(60000);

    getTestSubject().next({ BTC: '61000' });
    expect(getMarkPrice('BTC')!.toNumber()).toBe(61000);
  });

  it('should return undefined for unknown coins', () => {
    startPriceService();
    expect(getMarkPrice('UNKNOWN')).toBeUndefined();
  });

  it('should clear prices on stop', () => {
    startPriceService();
    getTestSubject().next({ BTC: '60000' });
    expect(getPriceCount()).toBe(1);

    stopPriceService();
    expect(getPriceCount()).toBe(0);
    expect(getMarkPrice('BTC')).toBeUndefined();
  });

  it('should not start twice', () => {
    startPriceService();
    getTestSubject().next({ BTC: '60000' });
    startPriceService(); // no-op
    getTestSubject().next({ BTC: '61000' });
    expect(getMarkPrice('BTC')!.toNumber()).toBe(61000);
  });

  it('should expose all prices via getAllPrices', () => {
    startPriceService();
    getTestSubject().next({ BTC: '60000', ETH: '3200' });

    const all = getAllPrices();
    expect(all.size).toBe(2);
    expect(all.get('BTC')!.toNumber()).toBe(60000);
    expect(all.get('ETH')!.toNumber()).toBe(3200);
  });
});
