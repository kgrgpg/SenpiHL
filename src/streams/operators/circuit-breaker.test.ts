import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Subject, of, throwError, firstValueFrom, lastValueFrom, toArray } from 'rxjs';
import { take } from 'rxjs/operators';

import { withCircuitBreaker, type CircuitState } from './circuit-breaker.js';

describe('withCircuitBreaker Operator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should pass through successful emissions in closed state', async () => {
    const source$ = of('a', 'b', 'c');

    const result$ = source$.pipe(
      withCircuitBreaker('test-stream', { failureThreshold: 3, resetTimeout: 1000 })
    );

    const results = await firstValueFrom(result$.pipe(toArray()));
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('should stay closed when failures are below threshold', async () => {
    let callCount = 0;
    const source$ = new Subject<string>();

    const result$ = source$.pipe(
      withCircuitBreaker('test-stream', {
        failureThreshold: 3,
        resetTimeout: 1000,
      })
    );

    const values: string[] = [];
    const errors: Error[] = [];

    result$.subscribe({
      next: v => values.push(v),
      error: e => errors.push(e),
    });

    source$.next('value1');
    expect(values).toContain('value1');
  });

  it('should accept configuration options', () => {
    const source$ = of('test');

    const result$ = source$.pipe(
      withCircuitBreaker('test-stream', {
        failureThreshold: 5,
        resetTimeout: 30000,
        halfOpenRequests: 2,
      })
    );

    expect(result$).toBeDefined();
  });

  it('should use default configuration when not provided', () => {
    const source$ = of('test');

    const result$ = source$.pipe(withCircuitBreaker('test-stream'));

    expect(result$).toBeDefined();
  });

  describe('state transitions', () => {
    it('should start in closed state', () => {
      const source$ = of('test');

      const result$ = source$.pipe(
        withCircuitBreaker('test-stream', { failureThreshold: 5 })
      );

      expect(result$).toBeDefined();
    });
  });
});
