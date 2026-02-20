import { Observable, interval, from, EMPTY } from 'rxjs';
import {
  switchMap,
  mergeMap,
  map,
  share,
  startWith,
  catchError,
  toArray,
} from 'rxjs/operators';

import { fetchUserFunding } from '../../hyperliquid/client.js';
import type { HyperliquidFunding } from '../../hyperliquid/types.js';
import { config } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { withMetrics } from '../operators/with-metrics.js';
import { withRetry } from '../operators/with-retry.js';

export interface FundingUpdate {
  address: string;
  funding: HyperliquidFunding[];
  timestamp: Date;
}

export function createFundingStream(
  getActiveTraders: () => Promise<string[]>
): Observable<FundingUpdate[]> {
  const startTime = Date.now() - 2 * 60 * 60 * 1000;

  return interval(config.FUNDING_POLL_INTERVAL).pipe(
    startWith(0),
    switchMap(() => from(getActiveTraders())),
    switchMap(traders => {
      if (traders.length === 0) {
        return EMPTY;
      }

      return from(traders).pipe(
        mergeMap(
          address =>
            fetchUserFunding(address, startTime).pipe(
              map(funding => ({
                address,
                funding,
                timestamp: new Date(),
              })),
              withRetry('funding-fetch'),
              catchError(error => {
                logger.error(
                  { address, error: error.message },
                  'Failed to fetch funding for trader'
                );
                return EMPTY;
              })
            ),
          5
        ),
        toArray()
      );
    }),
    withMetrics('funding'),
    share()
  );
}
