import type { FastifyInstance } from 'fastify';

import { checkConnection } from '../../storage/db/client.js';
import { checkRedisConnection } from '../../storage/cache/redis.js';

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: Date.now(),
    };
  });

  fastify.get('/ready', async (request, reply) => {
    const checks = {
      database: await checkConnection(),
      redis: await checkRedisConnection(),
    };

    const allHealthy = Object.values(checks).every(Boolean);

    if (allHealthy) {
      return {
        status: 'ready',
        checks,
      };
    }

    return reply.status(503).send({
      status: 'not_ready',
      checks,
    });
  });
}
