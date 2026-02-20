import { query } from '../client.js';

export interface TraderRow {
  id: number;
  address: string;
  first_seen_at: Date;
  last_updated_at: Date;
  is_active: boolean;
}

export async function findTraderByAddress(address: string): Promise<TraderRow | null> {
  const result = await query<TraderRow>(
    'SELECT * FROM traders WHERE address = $1',
    [address.toLowerCase()]
  );
  return result.rows[0] ?? null;
}

export async function findTraderById(id: number): Promise<TraderRow | null> {
  const result = await query<TraderRow>('SELECT * FROM traders WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

export async function createTrader(address: string): Promise<TraderRow> {
  const result = await query<TraderRow>(
    `INSERT INTO traders (address, first_seen_at, last_updated_at, is_active)
     VALUES ($1, NOW(), NOW(), true)
     RETURNING *`,
    [address.toLowerCase()]
  );
  return result.rows[0]!;
}

export async function findOrCreateTrader(address: string): Promise<TraderRow> {
  const existing = await findTraderByAddress(address);
  if (existing) {
    return existing;
  }
  return createTrader(address);
}

export async function updateTraderLastSeen(id: number): Promise<void> {
  await query('UPDATE traders SET last_updated_at = NOW() WHERE id = $1', [id]);
}

export async function setTraderActive(id: number, isActive: boolean): Promise<void> {
  await query('UPDATE traders SET is_active = $1, last_updated_at = NOW() WHERE id = $2', [
    isActive,
    id,
  ]);
}

export async function getActiveTraders(): Promise<TraderRow[]> {
  const result = await query<TraderRow>(
    'SELECT * FROM traders WHERE is_active = true ORDER BY last_updated_at DESC'
  );
  return result.rows;
}

export async function getActiveTraderAddresses(): Promise<string[]> {
  const result = await query<{ address: string }>(
    'SELECT address FROM traders WHERE is_active = true'
  );
  return result.rows.map(r => r.address);
}

export const tradersRepo = {
  findByAddress: findTraderByAddress,
  findById: findTraderById,
  create: createTrader,
  findOrCreate: findOrCreateTrader,
  updateLastSeen: updateTraderLastSeen,
  setActive: setTraderActive,
  getActive: getActiveTraders,
  getActiveAddresses: getActiveTraderAddresses,
};
