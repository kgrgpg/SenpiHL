/**
 * Real-Time Price Service
 *
 * Subscribes to Hyperliquid's allMids WebSocket channel to maintain
 * an in-memory cache of current mid prices for all coins.
 * Zero API weight cost (WebSocket push-based).
 *
 * Used for:
 * - Computing unrealized PnL from position state
 * - Computing closedPnl when processing trades from coin-level WS
 */

import { Subject } from 'rxjs';
import { takeUntil, tap, catchError } from 'rxjs/operators';
import { EMPTY } from 'rxjs';

import { Decimal, toDecimal } from '../utils/decimal.js';
import { getHyperliquidWebSocket } from '../hyperliquid/websocket.js';
import { logger } from '../utils/logger.js';

const prices = new Map<string, Decimal>();
const destroy$ = new Subject<void>();
let initialized = false;

export function startPriceService(): void {
  if (initialized) return;
  initialized = true;

  const ws = getHyperliquidWebSocket();

  ws.subscribeToAllMids()
    .pipe(
      takeUntil(destroy$),
      tap((mids) => {
        for (const [coin, px] of Object.entries(mids)) {
          prices.set(coin, toDecimal(px));
        }
      }),
      catchError((err) => {
        logger.error({ error: (err as Error).message }, 'allMids subscription error');
        return EMPTY;
      })
    )
    .subscribe();

  logger.info('Price service started (allMids WebSocket subscription)');
}

export function stopPriceService(): void {
  destroy$.next();
  prices.clear();
  initialized = false;
}

export function getMarkPrice(coin: string): Decimal | undefined {
  return prices.get(coin);
}

export function getAllPrices(): Map<string, Decimal> {
  return prices;
}

export function getPriceCount(): number {
  return prices.size;
}
