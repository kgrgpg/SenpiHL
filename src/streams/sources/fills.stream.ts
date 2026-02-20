import { Observable, interval, from, EMPTY, BehaviorSubject } from 'rxjs';
import {
  switchMap,
  mergeMap,
  map,
  share,
  startWith,
  catchError,
  tap,
  withLatestFrom,
} from 'rxjs/operators';

import { fetchUserFills } from '../../hyperliquid/client.js';
import type { HyperliquidFill } from '../../hyperliquid/types.js';
import { config } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { withMetrics } from '../operators/with-metrics.js';
import { withRetry } from '../operators/with-retry.js';

export interface FillsUpdate {
  address: string;
  fills: HyperliquidFill[];
  timestamp: Date;
}

const lastProcessedTime$ = new BehaviorSubject<number>(Date.now() - 24 * 60 * 60 * 1000);

export function updateLastProcessedTime(fills: HyperliquidFill[]): void {
  if (fills.length > 0) {
    const maxTime = Math.max(...fills.map(f => f.time));
    const current = lastProcessedTime$.getValue();
    if (maxTime > current) {
      lastProcessedTime$.next(maxTime);
    }
  }
}

export function createFillsStream(
  getActiveTraders: () => Promise<string[]>
): Observable<FillsUpdate[]> {
  return interval(config.FILLS_POLL_INTERVAL).pipe(
    startWith(0),
    withLatestFrom(lastProcessedTime$),
    switchMap(([_, sinceTime]) => from(getActiveTraders()).pipe(map(traders => ({ traders, sinceTime })))),
    switchMap(({ traders, sinceTime }) => {
      if (traders.length === 0) {
        return EMPTY;
      }

      return from(traders).pipe(
        mergeMap(
          address =>
            fetchUserFills(address, sinceTime).pipe(
              map(fills => ({
                address,
                fills,
                timestamp: new Date(),
              })),
              tap(update => updateLastProcessedTime(update.fills)),
              withRetry('fills-fetch'),
              catchError(error => {
                logger.error({ address, error: error.message }, 'Failed to fetch fills for trader');
                return EMPTY;
              })
            ),
          5
        ),
        map(update => [update])
      );
    }),
    withMetrics('fills'),
    share()
  );
}
