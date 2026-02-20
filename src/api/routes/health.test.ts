import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';

import { healthRoutes } from './health.js';

vi.mock('../../storage/db/client.js', () => ({
  checkConnection: vi.fn(),
}));

vi.mock('../../storage/cache/redis.js', () => ({
  checkRedisConnection: vi.fn(),
}));

import { checkConnection } from '../../storage/db/client.js';
import { checkRedisConnection } from '../../storage/cache/redis.js';

describe('Health Routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    await app.register(healthRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  describe('GET /health', () => {
    it('should return ok status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
    });

    it('should return timestamp as number', async () => {
      const before = Date.now();
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });
      const after = Date.now();

      const body = JSON.parse(response.body);
      expect(body.timestamp).toBeGreaterThanOrEqual(before);
      expect(body.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('GET /ready', () => {
    it('should return ready when all services are healthy', async () => {
      vi.mocked(checkConnection).mockResolvedValue(true);
      vi.mocked(checkRedisConnection).mockResolvedValue(true);

      const response = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ready');
      expect(body.checks.database).toBe(true);
      expect(body.checks.redis).toBe(true);
    });

    it('should return 503 when database is unhealthy', async () => {
      vi.mocked(checkConnection).mockResolvedValue(false);
      vi.mocked(checkRedisConnection).mockResolvedValue(true);

      const response = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('not_ready');
      expect(body.checks.database).toBe(false);
      expect(body.checks.redis).toBe(true);
    });

    it('should return 503 when redis is unhealthy', async () => {
      vi.mocked(checkConnection).mockResolvedValue(true);
      vi.mocked(checkRedisConnection).mockResolvedValue(false);

      const response = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('not_ready');
      expect(body.checks.database).toBe(true);
      expect(body.checks.redis).toBe(false);
    });

    it('should return 503 when all services are unhealthy', async () => {
      vi.mocked(checkConnection).mockResolvedValue(false);
      vi.mocked(checkRedisConnection).mockResolvedValue(false);

      const response = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('not_ready');
      expect(body.checks.database).toBe(false);
      expect(body.checks.redis).toBe(false);
    });
  });
});
