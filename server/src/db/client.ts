/**
 * db/client.ts — PostgreSQL connection pool.
 *
 * Uses the `pg` library's Pool for automatic connection management.
 * All queries go through this pool; never create ad-hoc Client instances.
 *
 * Environment variables required:
 *   DATABASE_URL  postgresql://user:password@host:5432/dbname
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
 */
export async function runMigrations(): Promise<void> {
  const sqlPath = join(__dir, 'migrations', '001_init.sql');
  const sql = readFileSync(sqlPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('[db] Migrations applied.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
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
