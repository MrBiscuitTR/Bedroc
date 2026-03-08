/**
 * routes/notes.ts — Encrypted note CRUD, topic/folder CRUD, and delta sync.
 *
 * All note content (title, body) is AES-256-GCM ciphertext from the client.
 * The server stores and returns blobs without inspection.
 *
 * Topics and folders store plaintext metadata (name, color, order) because
 * they are not sensitive — they are just labels visible in the sidebar.
 * A future version could encrypt topic/folder names if desired.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { verifyAuth } from '../middleware/auth.js';
import {
  upsertNote, getNoteById, getNotesByUser, getNotesSince, softDeleteNote,
  upsertTopic, getTopicsByUser, deleteTopic,
  upsertFolder, getFoldersByUser, deleteFolder,
} from '../db/queries/notes.js';
import { notifyClients } from './sync.js';

// ---------------------------------------------------------------------------
// Zod schemas — validate incoming shapes without trusting the client
// ---------------------------------------------------------------------------

const NoteUpsertSchema = z.object({
  id:               z.string().uuid(),
  topicId:          z.string().uuid().nullable(),
  encryptedTitle:   z.string().min(1),     // JSON { iv, ct }
  encryptedBody:    z.string().min(1),     // JSON { iv, ct }
  customOrder:      z.number().int().min(0),
  clientUpdatedAt:  z.string().datetime(),
  version:          z.number().int().min(1),
});

const TopicUpsertSchema = z.object({
  id:        z.string().uuid(),
  name:      z.string().min(1).max(80),
  color:     z.string().regex(/^#[0-9a-fA-F]{6}$/),
  folderId:  z.string().uuid().nullable(),
  sortOrder: z.number().int().min(0),
});

const FolderUpsertSchema = z.object({
  id:        z.string().uuid(),
  name:      z.string().min(1).max(80),
  parentId:  z.string().uuid().nullable(),
  sortOrder: z.number().int().min(0),
  collapsed: z.boolean(),
});

// ---------------------------------------------------------------------------
// Helper: extract verified userId from request
// ---------------------------------------------------------------------------

function uid(req: FastifyRequest): string {
  return (req as FastifyRequest & { userId: string }).userId;
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export default async function notesRoutes(fastify: FastifyInstance): Promise<void> {

  // ── GET /api/notes — list all notes for the authenticated user ───────────
  fastify.get('/api/notes', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const notes = await getNotesByUser(uid(req));
    return reply.code(200).send({ notes });
  });

  // ── GET /api/notes/sync?since=ISO — delta sync ───────────────────────────
  fastify.get('/api/notes/sync', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const { since } = req.query as { since?: string };
    const sinceDate = since ? new Date(since) : new Date(0);
    if (isNaN(sinceDate.getTime())) return reply.code(400).send({ error: 'Invalid since parameter' });
    const notes = await getNotesSince(uid(req), sinceDate);
    return reply.code(200).send({ notes, serverTime: new Date().toISOString() });
  });

  // ── GET /api/notes/:id — fetch a single note ─────────────────────────────
  fastify.get('/api/notes/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const { id } = req.params as { id: string };
    const note = await getNoteById(id, uid(req));
    if (!note) return reply.code(404).send({ error: 'Not found' });
    return reply.code(200).send({ note });
  });

  // ── PUT /api/notes/:id — upsert (create or update) ───────────────────────
  fastify.put('/api/notes/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const { id } = req.params as { id: string };
    const body = { ...(req.body as object), id };
    const parse = NoteUpsertSchema.safeParse(body);
    if (!parse.success) return reply.code(400).send({ error: 'Invalid note', details: parse.error.flatten() });

    const note = await upsertNote({
      ...parse.data,
      userId:         uid(req),
      topicId:        parse.data.topicId,
      encryptedTitle: parse.data.encryptedTitle,
      encryptedBody:  parse.data.encryptedBody,
      clientUpdatedAt: new Date(parse.data.clientUpdatedAt),
    });

    // Push real-time notification to other connected sessions for this user
    await notifyClients(uid(req), { type: 'note:updated', noteId: id });

    return reply.code(200).send({ note });
  });

  // ── DELETE /api/notes/:id — soft delete ──────────────────────────────────
  fastify.delete('/api/notes/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const { id } = req.params as { id: string };
    await softDeleteNote(id, uid(req));
    await notifyClients(uid(req), { type: 'note:deleted', noteId: id });
    return reply.code(200).send({ ok: true });
  });

  // ── GET /api/topics ───────────────────────────────────────────────────────
  fastify.get('/api/topics', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const topics = await getTopicsByUser(uid(req));
    return reply.code(200).send({ topics });
  });

  // ── PUT /api/topics/:id ───────────────────────────────────────────────────
  fastify.put('/api/topics/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const { id } = req.params as { id: string };
    const parse = TopicUpsertSchema.safeParse({ ...(req.body as object), id });
    if (!parse.success) return reply.code(400).send({ error: 'Invalid topic' });
    const topic = await upsertTopic({ ...parse.data, userId: uid(req) });
    return reply.code(200).send({ topic });
  });

  // ── DELETE /api/topics/:id ────────────────────────────────────────────────
  fastify.delete('/api/topics/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const { id } = req.params as { id: string };
    await deleteTopic(id, uid(req));
    return reply.code(200).send({ ok: true });
  });

  // ── GET /api/folders ──────────────────────────────────────────────────────
  fastify.get('/api/folders', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const folders = await getFoldersByUser(uid(req));
    return reply.code(200).send({ folders });
  });

  // ── PUT /api/folders/:id ──────────────────────────────────────────────────
  fastify.put('/api/folders/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const { id } = req.params as { id: string };
    const parse = FolderUpsertSchema.safeParse({ ...(req.body as object), id });
    if (!parse.success) return reply.code(400).send({ error: 'Invalid folder' });
    const folder = await upsertFolder({ ...parse.data, userId: uid(req) });
    return reply.code(200).send({ folder });
  });

  // ── DELETE /api/folders/:id ───────────────────────────────────────────────
  fastify.delete('/api/folders/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    await verifyAuth(req, reply);
    if (reply.sent) return;
    const { id } = req.params as { id: string };
    await deleteFolder(id, uid(req));
    return reply.code(200).send({ ok: true });
  });
}
