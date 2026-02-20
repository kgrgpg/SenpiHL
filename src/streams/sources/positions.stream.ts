import { Observable, interval, from, EMPTY } from 'rxjs';
import {
  switchMap,
  mergeMap,
  map,
  share,
  startWith,
  catchError,
  bufferCount,
  concatMap,
  toArray,
  delay,
} from 'rxjs/operators';

import { fetchClearinghouseState } from '../../hyperliquid/client.js';
import type { HyperliquidClearinghouseState } from '../../hyperliquid/types.js';
import { config } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { withMetrics } from '../operators/with-metrics.js';
import { withRetry } from '../operators/with-retry.js';

export interface PositionUpdate {
  address: string;
  state: HyperliquidClearinghouseState;
  timestamp: Date;
}

export function createPositionsStream(
  getActiveTraders: () => Promise<string[]>
): Observable<PositionUpdate[]> {
  return interval(config.POSITION_POLL_INTERVAL).pipe(
    startWith(0),
    switchMap(() => from(getActiveTraders())),
    switchMap(traders => {
      if (traders.length === 0) {
        return EMPTY;
      }

      return from(traders).pipe(
        bufferCount(50),
        concatMap(batch =>
          from(batch).pipe(
            mergeMap(
              address =>
                fetchClearinghouseState(address).pipe(
                  map(state => ({
                    address,
                    state,
                    timestamp: new Date(),
                  })),
                  withRetry('positions-fetch'),
                  catchError(error => {
                    logger.error(
                      { address, error: error.message },
                      'Failed to fetch position for trader'
                    );
                    return EMPTY;
                  })
                ),
              10
            ),
            toArray()
          )
        ),
        delay(1000),
        toArray(),
        map(batches => batches.flat())
      );
    }),
    withMetrics('positions'),
    share()
  );
}
