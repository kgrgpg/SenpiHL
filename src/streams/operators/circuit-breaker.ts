import { Observable, Subject, timer, throwError } from 'rxjs';
import { catchError, tap, switchMap } from 'rxjs/operators';

import { logger } from '../../utils/logger.js';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeout: number;
  halfOpenRequests: number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

const defaultConfig: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeout: 60000,
  halfOpenRequests: 1,
};

export function withCircuitBreaker<T>(
  streamName: string,
  config: Partial<CircuitBreakerConfig> = {}
) {
  const { failureThreshold, resetTimeout, halfOpenRequests } = {
    ...defaultConfig,
    ...config,
  };

  let state: CircuitState = 'closed';
  let failures = 0;
  let halfOpenAttempts = 0;
  const stateChange$ = new Subject<CircuitState>();

  const resetCircuit = () => {
    failures = 0;
    halfOpenAttempts = 0;
    state = 'closed';
    logger.info({ stream: streamName }, 'Circuit breaker reset to CLOSED');
    stateChange$.next(state);
  };

  const openCircuit = () => {
    state = 'open';
    logger.warn({ stream: streamName, resetTimeout }, 'Circuit breaker OPEN');
    stateChange$.next(state);

    timer(resetTimeout).subscribe(() => {
      state = 'half-open';
      halfOpenAttempts = 0;
      logger.info({ stream: streamName }, 'Circuit breaker HALF-OPEN');
      stateChange$.next(state);
    });
  };

  return (source$: Observable<T>): Observable<T> =>
    source$.pipe(
      switchMap(value => {
        if (state === 'open') {
          return throwError(() => new Error(`Circuit breaker is OPEN for ${streamName}`));
        }
        return new Observable<T>(subscriber => {
          subscriber.next(value);
          subscriber.complete();
        });
      }),
      tap({
        next: () => {
          if (state === 'half-open') {
            halfOpenAttempts++;
            if (halfOpenAttempts >= halfOpenRequests) {
              resetCircuit();
            }
          } else if (state === 'closed' && failures > 0) {
            failures = 0;
          }
        },
      }),
      catchError(error => {
        failures++;
        logger.debug(
          { stream: streamName, failures, threshold: failureThreshold },
          'Circuit breaker recorded failure'
        );

        if (failures >= failureThreshold && state === 'closed') {
          openCircuit();
        }

        return throwError(() => error);
      })
    );
}
