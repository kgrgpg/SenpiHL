import type { FastifyInstance } from 'fastify';

import { hyperliquidClient } from '../../../hyperliquid/client.js';
import { scheduleBackfill, getBackfillStatus } from '../../../jobs/backfill.js';
import { config } from '../../../utils/config.js';

interface BackfillBody {
  address: string;
  days?: number;
}

export async function backfillRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: BackfillBody }>('/backfill', async (request, reply) => {
    const { address, days = config.BACKFILL_DAYS } = request.body;

    if (!hyperliquidClient.isValidAddress(address)) {
      return reply.status(400).send({ error: 'Invalid Ethereum address' });
    }

    if (days < 1 || days > 365) {
      return reply.status(400).send({ error: 'Days must be between 1 and 365' });
    }

    const status = await getBackfillStatus(address);
    if (status.isActive) {
      return reply.status(409).send({
        error: 'Backfill already in progress',
        status,
      });
    }

    const job = await scheduleBackfill(address, days);

    return {
      message: 'Backfill job scheduled',
      job_id: job.id,
      address,
      days,
    };
  });

  fastify.get<{ Params: { address: string } }>('/backfill/:address/status', async (request, reply) => {
    const { address } = request.params;

    if (!hyperliquidClient.isValidAddress(address)) {
      return reply.status(400).send({ error: 'Invalid Ethereum address' });
    }

    const status = await getBackfillStatus(address);

    return {
      address,
      ...status,
    };
  });
}
