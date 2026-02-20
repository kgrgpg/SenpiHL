import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Counter, Histogram } from 'prom-client';

const streamEventsCounter = new Counter({
  name: 'stream_events_total',
  help: 'Total events processed by stream',
  labelNames: ['stream', 'result'] as const,
});

const streamLatencyHistogram = new Histogram({
  name: 'stream_processing_duration_seconds',
  help: 'Stream processing duration',
  labelNames: ['stream'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
});

export function withMetrics<T>(streamName: string) {
  return (source$: Observable<T>): Observable<T> => {
    return source$.pipe(
      tap({
        next: () => {
          streamEventsCounter.inc({ stream: streamName, result: 'success' });
        },
        error: () => {
          streamEventsCounter.inc({ stream: streamName, result: 'error' });
        },
      })
    );
  };
}

export function withTimedMetrics<T>(streamName: string) {
  return (source$: Observable<T>): Observable<T> => {
    return new Observable<T>(subscriber => {
      const startTime = Date.now();

      return source$.subscribe({
        next: value => {
          const duration = (Date.now() - startTime) / 1000;
          streamLatencyHistogram.observe({ stream: streamName }, duration);
          streamEventsCounter.inc({ stream: streamName, result: 'success' });
          subscriber.next(value);
        },
        error: err => {
          streamEventsCounter.inc({ stream: streamName, result: 'error' });
          subscriber.error(err);
        },
        complete: () => {
          subscriber.complete();
        },
      });
    });
  };
}
