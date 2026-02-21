import RedisModule from 'ioredis';
import { Observable, from, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';

import { config } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

const Redis = RedisModule as unknown as typeof RedisModule.default;

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times: number) {
    const delay = Math.min(times * 100, 3000);
    return delay;
  },
  lazyConnect: true,
});

redis.on('connect', () => {
  logger.info('Connected to Redis');
});

redis.on('error', (err: Error) => {
  logger.error({ error: err.message }, 'Redis error');
});

redis.on('close', () => {
  logger.warn('Redis connection closed');
});

export async function connectRedis(): Promise<void> {
  await redis.connect();
}

export async function checkRedisConnection(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  await redis.quit();
  logger.info('Redis connection closed');
}

// Observable-based cache operations with built-in error handling

export function cacheGet$<T>(key: string): Observable<T | null> {
  return from(redis.get(key)).pipe(
    map(value => value ? JSON.parse(value) as T : null),
    catchError(err => {
      logger.warn({ error: (err as Error).message, key }, 'Cache read failed');
      return of(null);
    })
  );
}

export function cacheSet$(key: string, value: unknown, ttlSeconds?: number): Observable<void> {
  const serialized = JSON.stringify(value);
  const op = ttlSeconds
    ? from(redis.setex(key, ttlSeconds, serialized))
    : from(redis.set(key, serialized));
  return op.pipe(
    map(() => void 0),
    catchError(err => {
      logger.warn({ error: (err as Error).message, key }, 'Cache write failed');
      return of(void 0);
    })
  );
}

export function cacheDelete$(key: string): Observable<void> {
  return from(redis.del(key)).pipe(
    map(() => void 0),
    catchError(err => {
      logger.warn({ error: (err as Error).message, key }, 'Cache delete failed');
      return of(void 0);
    })
  );
}

// Promise-based wrappers (for backward compatibility with Fastify handlers)
export async function cacheGet<T>(key: string): Promise<T | null> {
  const value = await redis.get(key);
  if (!value) return null;
  return JSON.parse(value) as T;
}

export async function cacheSet(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  const serialized = JSON.stringify(value);
  if (ttlSeconds) {
    await redis.setex(key, ttlSeconds, serialized);
  } else {
    await redis.set(key, serialized);
  }
}

export async function cacheDelete(key: string): Promise<void> {
  await redis.del(key);
}

export async function leaderboardAdd(key: string, score: number, member: string): Promise<void> {
  await redis.zadd(key, score, member);
}

export async function leaderboardGetTop(
  key: string,
  count: number
): Promise<Array<{ member: string; score: number }>> {
  const results = await redis.zrevrange(key, 0, count - 1, 'WITHSCORES');
  const entries: Array<{ member: string; score: number }> = [];

  for (let i = 0; i < results.length; i += 2) {
    entries.push({
      member: results[i]!,
      score: parseFloat(results[i + 1]!),
    });
  }

  return entries;
}

export const cache = {
  redis,
  connect: connectRedis,
  check: checkRedisConnection,
  close: closeRedis,
  get: cacheGet,
  get$: cacheGet$,
  set: cacheSet,
  set$: cacheSet$,
  delete: cacheDelete,
  delete$: cacheDelete$,
  leaderboardAdd,
  leaderboardGetTop,
};
