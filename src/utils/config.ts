import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: isTest
    ? z.string().default('postgresql://postgres:password@localhost:5432/pnl_indexer_test')
    : z.string().url(),
  DATABASE_POOL_SIZE: z.coerce.number().default(10),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  HYPERLIQUID_API_URL: z.string().url().default('https://api.hyperliquid.xyz'),
  HYPERLIQUID_WS_URL: z.string().default('wss://api.hyperliquid.xyz/ws'),

  POSITION_POLL_INTERVAL: z.coerce.number().default(30000),
  FILLS_POLL_INTERVAL: z.coerce.number().default(300000),
  FUNDING_POLL_INTERVAL: z.coerce.number().default(3600000),

  SNAPSHOT_INTERVAL: z.coerce.number().default(60000),
  
  // Hybrid mode: WebSocket for real-time fills + periodic polling for snapshots
  USE_HYBRID_MODE: z.coerce.boolean().default(true),
  POLL_INTERVAL_MS: z.coerce.number().default(300000), // 5 minutes for hybrid mode
  BACKFILL_DAYS: z.coerce.number().default(30),

  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW: z.coerce.number().default(60000),
});

const parseResult = envSchema.safeParse(process.env);

if (!parseResult.success && !isTest) {
  console.error('❌ Invalid environment variables:');
  console.error(parseResult.error.format());
  process.exit(1);
}

export const config = parseResult.success ? parseResult.data : envSchema.parse({});

export type Config = z.infer<typeof envSchema>;
