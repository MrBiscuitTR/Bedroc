/**
 * routes/attachments.ts — Encrypted attachment upload/download.
 *
 * Attachments are content-addressed: hash = SHA-256(plaintext data URI).
 * The server stores and returns AES-256-GCM ciphertext only — never plaintext.
 *
 * Routes:
 *   POST /api/attachments/check    — check which of a list of hashes exist
 *   PUT  /api/attachments/:hash    — upload one attachment (idempotent)
 *   GET  /api/attachments/:hash    — download one attachment
 *   DELETE /api/attachments/:hash  — delete one attachment (explicit removal)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { verifyAuth } from '../middleware/auth.js';
import {
  upsertAttachment,
  getAttachment,
  getExistingHashes,
  deleteAttachment,
} from '../db/queries/attachments.js';

const HASH_RE = /^[0-9a-f]{64}$/;

// enc:<JSON {iv,ct}> — base64 chars + JSON punctuation. Max ~3MB (2MB file + overhead).
const MAX_ENCRYPTED_DATA_LENGTH = 3_200_000;

const UploadSchema = z.object({
  encryptedData: z.string().min(10).max(MAX_ENCRYPTED_DATA_LENGTH),
  mimeType:      z.string().min(1).max(120),
  sizeBytes:     z.number().int().min(0).max(10_000_000), // max 10 MB plaintext
});

const CheckSchema = z.object({
  hashes: z.array(z.string().regex(HASH_RE)).min(1).max(200),
});

function uid(req: FastifyRequest): string {
  return (req as FastifyRequest & { userId: string }).userId;
}

export default async function attachmentRoutes(fastify: FastifyInstance): Promise<void> {

  // ── POST /api/attachments/check — which hashes does the server already have? ─
  // Called before a batch upload so the client can skip re-uploading.
  fastify.post('/api/attachments/check', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;

    const parsed = CheckSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });

    const existing = await getExistingHashes(parsed.data.hashes, uid(req));
    return reply.code(200).send({ existing });
  });

  // ── PUT /api/attachments/:hash — upload (idempotent) ──────────────────────
  fastify.put('/api/attachments/:hash', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;

    const { hash } = req.params as { hash: string };
    if (!HASH_RE.test(hash)) return reply.code(400).send({ error: 'Invalid hash' });

    const parsed = UploadSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });

    await upsertAttachment({
      hash,
      userId: uid(req),
      encryptedData: parsed.data.encryptedData,
      mimeType:      parsed.data.mimeType,
      sizeBytes:     parsed.data.sizeBytes,
    });

    return reply.code(204).send();
  });

  // ── GET /api/attachments/:hash — download ─────────────────────────────────
  fastify.get('/api/attachments/:hash', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;

    const { hash } = req.params as { hash: string };
    if (!HASH_RE.test(hash)) return reply.code(400).send({ error: 'Invalid hash' });

    const row = await getAttachment(hash, uid(req));
    if (!row) return reply.code(404).send({ error: 'Not found' });

    return reply.code(200).send({
      encryptedData: row.encrypted_data,
      mimeType:      row.mime_type,
      sizeBytes:     row.size_bytes,
    });
  });

  // ── DELETE /api/attachments/:hash — explicit removal ─────────────────────
  fastify.delete('/api/attachments/:hash', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;

    const { hash } = req.params as { hash: string };
    if (!HASH_RE.test(hash)) return reply.code(400).send({ error: 'Invalid hash' });

    await deleteAttachment(hash, uid(req));
    return reply.code(204).send();
  });
}
