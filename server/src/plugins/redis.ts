/**
 * plugins/redis.ts — Redis client singleton.
 *
 * Used for:
 *   - Rate limiting (via @fastify/rate-limit)
 *   - Temporary SRP challenge storage during login (TTL 120s)
 *   - WebSocket pub/sub for real-time note sync across server instances
 *
 * Environment variable: REDIS_URL  (e.g. redis://localhost:6379)
 */

import { createClient, type RedisClientType } from 'redis';

let _client: RedisClientType | null = null;

export async function getRedis(): Promise<RedisClientType> {
  if (_client) return _client;

  const client = createClient({
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    socket: {
      reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
    },
  }); //as RedisClientType;

  client.on('error', (err: Error) => console.error('[redis] Error:', err.message));
  client.on('connect', () => console.log('[redis] Connected.'));

  await client.connect();
  _client = client;
  return _client;
}

export async function closeRedis(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
  }
}
