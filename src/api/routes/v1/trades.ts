import type { FastifyInstance } from 'fastify';

import { query } from '../../../storage/db/client.js';

export async function tradesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { limit?: string } }>('/trades/recent', async (request) => {
    const limitNum = Math.min(Math.max(parseInt(request.query.limit || '30') || 30, 1), 50);

    const result = await query<{
      address: string;
      coin: string;
      side: string;
      size: string;
      price: string;
      closed_pnl: string;
      timestamp: Date;
      tid: number;
    }>(
      `SELECT t.address, tr.coin, tr.side, tr.size, tr.price, tr.closed_pnl, tr.timestamp, tr.tid
       FROM trades tr JOIN traders t ON t.id = tr.trader_id
       ORDER BY tr.timestamp DESC LIMIT $1`,
      [limitNum]
    );

    return {
      trades: result.rows.map(r => ({
        address: r.address,
        coin: r.coin,
        side: r.side === 'B' ? 'BUY' : 'SELL',
        size: r.size,
        price: r.price,
        closed_pnl: r.closed_pnl,
        timestamp: Math.floor(new Date(r.timestamp).getTime() / 1000),
        tid: r.tid,
      })),
      count: result.rows.length,
    };
  });
}
