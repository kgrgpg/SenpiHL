import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { pool, query } from './client.js';

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
  console.log(`Running migration: ${filename}`);
  await query(sql);
  await markMigrationApplied(filename);
  console.log(`✓ Migration ${filename} applied successfully`);
}

async function migrate(): Promise<void> {
  console.log('Starting database migrations...');

  const appliedMigrations = await getAppliedMigrations();

  const migrationFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const filename of migrationFiles) {
    if (appliedMigrations.has(filename)) {
      console.log(`Skipping ${filename} (already applied)`);
      continue;
    }

    const filePath = path.join(MIGRATIONS_DIR, filename);
    const sql = fs.readFileSync(filePath, 'utf-8');

    try {
      await runMigration(filename, sql);
    } catch (error) {
      console.error(`✗ Migration ${filename} failed:`, error);
      throw error;
    }
  }

  console.log('All migrations completed successfully');
}

migrate()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Migration failed:', error);
    process.exit(1);
  })
  .finally(() => pool.end());
