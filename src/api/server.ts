import fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

import { healthRoutes } from './routes/health.js';
import { metricsRoute } from './routes/metrics.js';
import { tradersRoutes, leaderboardRoutes, backfillRoutes, statusRoutes, tradesRoutes } from './routes/v1/index.js';
import { dashboardRoute } from './dashboard.js';

export async function createServer(): Promise<FastifyInstance> {
  const app = fastify({
    logger: false,
  });

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'PnL Indexer API',
        description: 'PnL indexing service for Hyperliquid perpetual traders. Tracks realized/unrealized PnL, funding payments, and trading volume.',
        version: '1.4.0',
      },
      tags: [
        { name: 'health', description: 'Health and readiness probes' },
        { name: 'traders', description: 'Trader PnL, positions, and management' },
        { name: 'leaderboard', description: 'Trader rankings by PnL' },
        { name: 'backfill', description: 'Historical data backfill' },
        { name: 'status', description: 'System status and monitoring' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });

  app.addHook('onRequest', async request => {
    logger.debug({ method: request.method, url: request.url }, 'Incoming request');
  });

  app.addHook('onResponse', async (request, reply) => {
    logger.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'Request completed'
    );
  });

  app.setErrorHandler((error, request, reply) => {
    logger.error({ error: error.message, stack: error.stack }, 'Request error');

    const statusCode = error.statusCode ?? 500;
    return reply.status(statusCode).send({
      error: statusCode >= 500 ? 'Internal server error' : error.message,
    });
  });

  await app.register(healthRoutes);
  await app.register(metricsRoute);
  await app.register(dashboardRoute);

  await app.register(
    async function v1Routes(instance) {
      await instance.register(tradersRoutes);
      await instance.register(leaderboardRoutes);
      await instance.register(backfillRoutes);
      await instance.register(statusRoutes);
      await instance.register(tradesRoutes);
    },
    { prefix: '/v1' }
  );

  app.get('/', async () => {
    return {
      name: 'PnL Indexer API',
      version: '1.0.0',
      docs: '/v1/docs',
    };
  });

  return app;
}

export async function startServer(app: FastifyInstance): Promise<void> {
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    logger.info({ port: config.PORT }, 'Server started');
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    throw error;
  }
}

export async function stopServer(app: FastifyInstance): Promise<void> {
  await app.close();
  logger.info('Server stopped');
}
