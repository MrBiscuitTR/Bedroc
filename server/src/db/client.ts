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

const MIGRATIONS = [
  '001_init.sql',
  '002_session_refresh_hash.sql',
  '003_session_metadata.sql',
  '004_attachments.sql',
  '005_security_hardening.sql',
];

/** Postgres error codes meaning "this role may not do that" (not owner / no privilege). */
const PRIVILEGE_ERRORS = new Set(['42501']);

/**
 * Run all SQL migrations in order. Idempotent: each migration uses
 * IF NOT EXISTS / CREATE OR REPLACE, so running them on every deploy is safe.
 *
 * Least privilege: migrations first run as the application role (DATABASE_URL).
 * Only if that role lacks the privilege (e.g. older installs where the tables
 * are owned by the `postgres` superuser) are they retried with POSTGRES_URL.
 * In Docker this runs in the short-lived `migrate` container, so the
 * long-running API server never holds the superuser password.
 */
export async function runMigrations(): Promise<void> {
  const appUrl = process.env.DATABASE_URL;
  const superUrl = process.env.POSTGRES_URL;
  try {
    await runMigrationsAs(appUrl);
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    if (superUrl && superUrl !== appUrl && PRIVILEGE_ERRORS.has(code)) {
      console.log('[db] Application role lacks privileges for this migration; retrying as the database owner.');
      await runMigrationsAs(superUrl);
      return;
    }
    throw err;
  }
}

async function runMigrationsAs(connectionString: string | undefined): Promise<void> {
  const migrationClient = new pg.Client({ connectionString });
  await migrationClient.connect();

  try {
    for (const file of MIGRATIONS) {
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

/** Run `fn` inside a single transaction on a dedicated pooled connection. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
