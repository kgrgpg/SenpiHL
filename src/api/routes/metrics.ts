import type { FastifyInstance } from 'fastify';
import { register, Gauge, collectDefaultMetrics } from 'prom-client';

import { getTrackedTraderCount } from '../../state/trader-state.js';
import { getPriceCount } from '../../state/price-service.js';

collectDefaultMetrics({ register });

const trackedTradersGauge = new Gauge({
  name: 'pnl_tracked_traders',
  help: 'Number of currently tracked traders',
  collect() {
    this.set(getTrackedTraderCount());
  },
});

const pricesCachedGauge = new Gauge({
  name: 'pnl_prices_cached',
  help: 'Number of coins with cached mark prices from allMids',
  collect() {
    this.set(getPriceCount());
  },
});

const uptimeGauge = new Gauge({
  name: 'pnl_uptime_seconds',
  help: 'Process uptime in seconds',
  collect() {
    this.set(process.uptime());
  },
});

register.registerMetric(trackedTradersGauge);
register.registerMetric(pricesCachedGauge);
register.registerMetric(uptimeGauge);

export async function metricsRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get('/metrics', async (_request, reply) => {
    const metrics = await register.metrics();
    return reply
      .header('Content-Type', register.contentType)
      .send(metrics);
  });
}
