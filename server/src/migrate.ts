/**
 * migrate.ts — one-shot migration runner (the `migrate` service in Docker).
 *
 * Runs before the API server starts. Exits 0 on success, 1 on failure, so
 * `depends_on: condition: service_completed_successfully` keeps the server
 * from starting against a half-migrated database.
 */
import { runMigrations, pool } from './db/client.js';

try {
  await runMigrations();
  console.log('[migrate] Database is up to date.');
  await pool.end();
  process.exit(0);
} catch (err) {
  const e = err as { message?: string; code?: string };
  console.error(`[migrate] Migration failed${e.code ? ` (${e.code})` : ''}: ${e.message ?? err}`);
  if (e.code === '28P01') {
    console.error('[migrate] Password authentication failed. DATABASE_URL / POSTGRES_PASSWORD must match the');
    console.error('[migrate] passwords the database was FIRST created with (changing them in the env file later');
    console.error('[migrate] does not change them inside an existing database).');
  }
  process.exit(1);
}
