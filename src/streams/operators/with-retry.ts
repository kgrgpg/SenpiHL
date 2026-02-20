import { Observable, timer } from 'rxjs';
import { retry } from 'rxjs/operators';

import { logger } from '../../utils/logger.js';

export interface RetryConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

const defaultConfig: RetryConfig = {
  maxRetries: 5,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
};

export function withRetry<T>(
  streamName: string,
  config: Partial<RetryConfig> = {}
) {
  const { maxRetries, initialDelay, maxDelay, backoffMultiplier } = {
    ...defaultConfig,
    ...config,
  };

  return (source$: Observable<T>): Observable<T> =>
    source$.pipe(
      retry({
        count: maxRetries,
        delay: (error, retryCount) => {
          const delay = Math.min(
            initialDelay * Math.pow(backoffMultiplier, retryCount - 1),
            maxDelay
          );

          logger.warn(
            {
              stream: streamName,
              error: error instanceof Error ? error.message : String(error),
              retryCount,
              nextRetryIn: delay,
            },
            'Retrying stream after error'
          );

          return timer(delay);
        },
      })
    );
}
