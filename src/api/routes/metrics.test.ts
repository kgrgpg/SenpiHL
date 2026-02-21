import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../state/trader-state.js', () => ({
  getTrackedTraderCount: vi.fn().mockReturnValue(42),
}));

vi.mock('../../state/price-service.js', () => ({
  getPriceCount: vi.fn().mockReturnValue(500),
}));

import { metricsRoute } from './metrics.js';

describe('Metrics Route', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    await app.register(metricsRoute);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('should return 200 with Prometheus text format', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
  });

  it('should include custom application gauges', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });

    const body = response.body;
    expect(body).toContain('pnl_tracked_traders');
    expect(body).toContain('pnl_prices_cached');
    expect(body).toContain('pnl_uptime_seconds');
  });

  it('should include default Node.js metrics', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });

    const body = response.body;
    expect(body).toContain('process_cpu');
    expect(body).toContain('nodejs_heap');
  });

  it('should include HELP and TYPE annotations in Prometheus format', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });

    const body = response.body;
    expect(body).toContain('# HELP pnl_tracked_traders');
    expect(body).toContain('# TYPE pnl_tracked_traders gauge');
  });
});
