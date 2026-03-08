-- =============================================================================
-- Bedroc — Initial Database Schema
-- Migration 001: Users, sessions, notes, topics, folders
--
-- Security notes:
--   - notes.encrypted_content / encrypted_title are AES-256-GCM ciphertext.
--     The server NEVER stores or processes plaintext note content.
--   - users.srp_verifier / srp_salt implement SRP-6a: password never sent to server.
--   - users.encrypted_dek is the user's Data Encryption Key wrapped with their
--     PBKDF2-derived Master Key. Useless without the user's password.
--   - sessions.token_hash stores SHA-256(JWT) for fast revocation lookup.
--     Raw tokens are never persisted.
-- =============================================================================

-- pgcrypto is created by docker/postgres/init.sh (requires superuser).
-- bedroc_app (the app user) lacks CREATE privilege so it cannot run this.
-- gen_random_uuid() is available because the extension is already installed.

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        TEXT UNIQUE NOT NULL,

    -- SRP-6a authentication material (password never stored or sent)
    srp_salt        BYTEA NOT NULL,       -- random 32-byte salt for SRP verifier
    srp_verifier    BYTEA NOT NULL,       -- v = g^x mod N  (x = H(salt||H(user:pass)))

    -- Two-layer key material: server stores only the encrypted DEK wrapper.
    -- Client derives Master Key from password+dek_salt, then decrypts encrypted_dek.
    -- Server never sees the plaintext DEK.
    encrypted_dek   TEXT NOT NULL,        -- AES-256-GCM({ iv, ciphertext }) as JSON
    dek_salt        BYTEA NOT NULL,       -- random 32-byte PBKDF2 salt for Master Key

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for login lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- We store only the hash of the JWT so we can check revocation without
    -- ever persisting the raw token.  Hash = SHA-256(access_token).
    token_hash  TEXT NOT NULL UNIQUE,

    -- Optional device fingerprint (user-agent, truncated)
    device_info TEXT,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked     BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_hash ON sessions (token_hash);

-- ---------------------------------------------------------------------------
-- Folders  (UI grouping for topics)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS folders (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    parent_id   UUID REFERENCES folders(id) ON DELETE SET NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    collapsed   BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_folders_user ON folders (user_id);

-- ---------------------------------------------------------------------------
-- Topics  (coloured tag/category for notes)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topics (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT '#6b8afd',
    folder_id   UUID REFERENCES folders(id) ON DELETE SET NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_topics_user ON topics (user_id);

-- ---------------------------------------------------------------------------
-- Notes  (encrypted blobs only — server is a dumb storage bucket)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notes (
    id                  UUID PRIMARY KEY,   -- client-generated UUID

    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic_id            UUID REFERENCES topics(id) ON DELETE SET NULL,

    -- Both fields are AES-256-GCM ciphertext JSON: { iv: base64, ct: base64 }
    -- Server never inspects, logs, or processes their content.
    encrypted_title     TEXT NOT NULL DEFAULT '{}',
    encrypted_body      TEXT NOT NULL DEFAULT '{}',

    -- Sync/ordering metadata (NOT encrypted — needed server-side for sync)
    custom_order        INTEGER NOT NULL DEFAULT 0,
    client_updated_at   TIMESTAMPTZ NOT NULL,  -- set by editing device
    server_updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Soft-delete: client can detect deletions during sync
    is_deleted          BOOLEAN NOT NULL DEFAULT false,

    -- Optimistic locking: client sends version; server rejects stale writes
    version             INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_notes_user        ON notes (user_id);
CREATE INDEX IF NOT EXISTS idx_notes_topic       ON notes (topic_id);
CREATE INDEX IF NOT EXISTS idx_notes_updated     ON notes (user_id, client_updated_at);
CREATE INDEX IF NOT EXISTS idx_notes_not_deleted ON notes (user_id, is_deleted) WHERE is_deleted = false;

-- ---------------------------------------------------------------------------
-- Automatic updated_at trigger helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER users_updated_at    BEFORE UPDATE ON users    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER folders_updated_at  BEFORE UPDATE ON folders  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER topics_updated_at   BEFORE UPDATE ON topics   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- (notes uses server_updated_at separately, managed by application code)
