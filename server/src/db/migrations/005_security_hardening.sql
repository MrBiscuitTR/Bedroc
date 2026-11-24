-- =============================================================================
-- Migration 005: Security hardening
--
-- users.srp_kdf_version
--   1 = legacy  x = SHA-256(salt | SHA-256(username ":" password))   (unstretched)
--   2 = current x = PBKDF2-SHA256(username ":" password, salt, 600k)  (stretched)
--   Legacy accounts are upgraded transparently on their next successful login.
--
-- sessions.prev_refresh_token_hash / refresh_rotated_at
--   Keep the previous refresh-token hash after each rotation so a replayed
--   (stolen) token can be detected. A replay inside a short grace window is
--   treated as a benign multi-tab race; a replay after it revokes the session.
-- =============================================================================

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS srp_kdf_version SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS prev_refresh_token_hash TEXT,
    ADD COLUMN IF NOT EXISTS refresh_rotated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sessions_prev_refresh_hash ON sessions (prev_refresh_token_hash)
    WHERE prev_refresh_token_hash IS NOT NULL;

-- Case-insensitive username lookups (uniqueness is enforced in application code
-- so that pre-existing case-variant duplicates do not break this migration).
CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users (lower(username));
