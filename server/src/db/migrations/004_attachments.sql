-- Migration 004: Attachments table
--
-- Stores encrypted attachment blobs server-side so they sync across devices.
-- The server stores only AES-256-GCM ciphertext — plaintext is never seen here.
--
-- Key design decisions:
--   - `hash` is SHA-256 of the PLAINTEXT data URI (content-addressed).
--     Same content from any device → same hash → stored once (idempotent).
--   - `encrypted_data` is the `enc:<JSON {iv,ct}>` string the client produces.
--   - `size_bytes` is the plaintext size for display (not a secret).
--   - No soft-delete: attachments are removed when explicitly deleted.
--     Deletion is expected to be rare (user removes file card from all notes).
--   - `user_id` scopes all access; no sharing between users.

CREATE TABLE IF NOT EXISTS attachments (
    hash            TEXT NOT NULL,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    encrypted_data  TEXT NOT NULL,          -- "enc:{\"iv\":\"...\",\"ct\":\"...\"}"
    mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (hash, user_id)
);

CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments (user_id);
