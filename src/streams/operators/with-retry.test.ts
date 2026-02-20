import { describe, it, expect, vi } from 'vitest';
import { TestScheduler } from 'rxjs/testing';
import { Observable, of, throwError, timer } from 'rxjs';
import { mergeMap, delay } from 'rxjs/operators';

import { withRetry } from './with-retry.js';

describe('withRetry Operator', () => {
  let testScheduler: TestScheduler;

  beforeEach(() => {
    testScheduler = new TestScheduler((actual, expected) => {
      expect(actual).toEqual(expected);
    });
  });

  it('should pass through successful emissions', () => {
    testScheduler.run(({ cold, expectObservable }) => {
      const source$ = cold('a-b-c|');
      const expected = '    a-b-c|';

      const result$ = source$.pipe(withRetry('test-stream', { maxRetries: 3 }));

      expectObservable(result$).toBe(expected);
    });
  });

  it('should handle empty stream', () => {
    testScheduler.run(({ cold, expectObservable }) => {
      const source$ = cold('|');
      const expected = '    |';

      const result$ = source$.pipe(withRetry('test-stream'));

      expectObservable(result$).toBe(expected);
    });
  });

  it('should eventually throw after max retries', async () => {
    const error = new Error('Test error');
    let callCount = 0;

    const failingObservable = new Observable(subscriber => {
      callCount++;
      subscriber.error(error);
    });

    const result$ = failingObservable.pipe(
      withRetry('test-stream', {
        maxRetries: 2,
        initialDelay: 10,
        maxDelay: 100,
        backoffMultiplier: 2,
      })
    );

    await expect(
      new Promise((resolve, reject) => {
        result$.subscribe({
          next: resolve,
          error: reject,
          complete: resolve,
        });
      })
    ).rejects.toThrow('Test error');

    expect(callCount).toBe(3);
  });

  it('should succeed after transient failures', async () => {
    let callCount = 0;

    const eventuallySuccessful = new Observable<string>(subscriber => {
      callCount++;
      if (callCount < 3) {
        subscriber.error(new Error('Transient error'));
      } else {
        subscriber.next('success');
        subscriber.complete();
      }
    });

    const result = await new Promise<string>((resolve, reject) => {
      eventuallySuccessful
        .pipe(
          withRetry('test-stream', {
            maxRetries: 3,
            initialDelay: 10,
            maxDelay: 100,
            backoffMultiplier: 2,
          })
        )
        .subscribe({
          next: resolve,
          error: reject,
        });
    });

    expect(result).toBe('success');
    expect(callCount).toBe(3);
  });
});

describe('withRetry Configuration', () => {
  it('should use default configuration values', () => {
    const source$ = of('test');
    const result$ = source$.pipe(withRetry('test-stream'));

    expect(result$).toBeDefined();
  });

  it('should accept partial configuration', () => {
    const source$ = of('test');
    const result$ = source$.pipe(withRetry('test-stream', { maxRetries: 5 }));

    expect(result$).toBeDefined();
  });

  it('should accept full configuration', () => {
    const source$ = of('test');
    const result$ = source$.pipe(
      withRetry('test-stream', {
        maxRetries: 10,
        initialDelay: 500,
        maxDelay: 10000,
        backoffMultiplier: 3,
      })
    );

    expect(result$).toBeDefined();
  });
});
