import type { FastifyInstance } from 'fastify';

import { config } from '../../../utils/config.js';
import { getHybridDataStream } from '../../../streams/sources/hybrid.stream.js';
import { getTraderDiscoveryStream } from '../../../streams/sources/trader-discovery.stream.js';
import { getHyperliquidWebSocket } from '../../../hyperliquid/websocket.js';
import { getTrackedTraderCount, getAllTrackedAddresses } from '../../../state/trader-state.js';
import { query } from '../../../storage/db/client.js';

export async function statusRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /v1/status
   * Get system status including mode, connections, and active subscriptions
   */
  fastify.get('/status', async () => {
    const ws = getHyperliquidWebSocket();
    
    // Get database counts
    const traderCount = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM traders WHERE is_active = true'
    );
    const snapshotCount = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM pnl_snapshots'
    );
    const discoveryQueueCount = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM trader_discovery_queue WHERE processed_at IS NULL'
    );

    // Build base status
    const baseStatus = {
      mode: config.USE_HYBRID_MODE ? 'hybrid' : 'legacy',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      connections: {
        websocket: {
          subscriptions: ws.subscriptionCount,
          hybrid_subscriptions: 0,
        },
        database: true,
      },
      tracking: {
        in_memory_traders: getTrackedTraderCount(),
        database_active_traders: parseInt(traderCount.rows[0]?.count ?? '0'),
        total_snapshots: parseInt(snapshotCount.rows[0]?.count ?? '0'),
      },
      discovery: {
        queue_pending: parseInt(discoveryQueueCount.rows[0]?.count ?? '0'),
        is_running: false,
        discovered_count: 0,
      },
      config: {
        poll_interval_ms: config.POLL_INTERVAL_MS,
        snapshot_interval: config.SNAPSHOT_INTERVAL,
        hybrid_mode: config.USE_HYBRID_MODE,
      },
    };

    // Add hybrid-specific info
    if (config.USE_HYBRID_MODE) {
      const hybridStream = getHybridDataStream();
      const discoveryStream = getTraderDiscoveryStream();
      
      baseStatus.connections.websocket.hybrid_subscriptions = hybridStream.traderCount;
      baseStatus.discovery.is_running = discoveryStream.isRunning;
      baseStatus.discovery.discovered_count = discoveryStream.discoveredCount;
    }

    return baseStatus;
  });

  /**
   * GET /v1/status/subscriptions
   * Get list of all currently tracked addresses
   */
  fastify.get('/status/subscriptions', async () => {
    const addresses = getAllTrackedAddresses();
    
    return {
      count: addresses.length,
      mode: config.USE_HYBRID_MODE ? 'hybrid' : 'legacy',
      addresses: addresses.slice(0, 100), // Limit to first 100
      truncated: addresses.length > 100,
    };
  });
}
