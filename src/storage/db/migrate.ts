import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { pool, query } from './client.js';
import { logger } from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function getAppliedMigrations(): Promise<Set<string>> {
  try {
    const result = await query<{ version: string }>('SELECT version FROM schema_migrations');
    return new Set(result.rows.map(r => r.version));
  } catch {
    return new Set();
  }
}

async function markMigrationApplied(version: string): Promise<void> {
  await query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
}

async function runMigration(filename: string, sql: string): Promise<void> {
  logger.info({ filename }, 'Running migration');
  await query(sql);
  await markMigrationApplied(filename);
  logger.info({ filename }, 'Migration applied successfully');
}

async function migrate(): Promise<void> {
  logger.info('Starting database migrations...');

  const appliedMigrations = await getAppliedMigrations();

  const migrationFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const filename of migrationFiles) {
    if (appliedMigrations.has(filename)) {
      logger.debug({ filename }, 'Skipping (already applied)');
      continue;
    }

    const filePath = path.join(MIGRATIONS_DIR, filename);
    const sql = fs.readFileSync(filePath, 'utf-8');

    try {
      await runMigration(filename, sql);
    } catch (error) {
      logger.error({ filename, error: (error as Error).message }, 'Migration failed');
      throw error;
    }
  }

  logger.info('All migrations completed successfully');
}

migrate()
  .then(() => process.exit(0))
  .catch(error => {
    logger.error({ error: error.message }, 'Migration failed');
    process.exit(1);
  })
  .finally(() => pool.end());
