/**
 * db/client.ts — PostgreSQL connection pool.
 *
 * Uses the `pg` library's Pool for automatic connection management.
 * All queries go through this pool; never create ad-hoc Client instances.
 *
 * Environment variables required:
 *   DATABASE_URL       postgresql://bedroc_app:password@host:5432/dbname  (app queries)
 *   POSTGRES_URL       postgresql://postgres:password@host:5432/dbname    (migrations only)
 *                      Falls back to DATABASE_URL if not set, but migrations may fail
 *                      if bedroc_app lacks CREATE ON SCHEMA PUBLIC.
 */

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Pool setup
// ---------------------------------------------------------------------------

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Keep at most 10 connections per server instance.
  // Adjust upward if you run many concurrent users.
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Crash loudly on unexpected pool errors so Docker restarts the container.
pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));

/**
 * Run all SQL migrations in order on startup.
 * Idempotent: each migration uses IF NOT EXISTS / CREATE OR REPLACE.
 *
 * Uses POSTGRES_URL (superuser) if available so migrations can CREATE EXTENSION,
 * CREATE TABLE etc. without requiring elevated grants on bedroc_app.
 */
export async function runMigrations(): Promise<void> {
  const migrationUrl = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
  const migrationClient = new pg.Client({ connectionString: migrationUrl });
  await migrationClient.connect();

  const migrations = ['001_init.sql', '002_session_refresh_hash.sql', '003_session_metadata.sql'];
  try {
    for (const file of migrations) {
      const sqlPath = join(__dir, 'migrations', file);
      const sql = readFileSync(sqlPath, 'utf8');
      await migrationClient.query('BEGIN');
      try {
        await migrationClient.query(sql);
        await migrationClient.query('COMMIT');
        console.log(`[db] Applied migration: ${file}`);
      } catch (err) {
        await migrationClient.query('ROLLBACK');
        throw err;
      }
    }
    console.log('[db] All migrations applied.');
  } finally {
    await migrationClient.end();
  }
}

// ---------------------------------------------------------------------------
// Typed query helper (prevents accidental raw string interpolation)
// ---------------------------------------------------------------------------

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}
