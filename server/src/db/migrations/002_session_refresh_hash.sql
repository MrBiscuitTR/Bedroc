-- =============================================================================
-- Migration 002: Add refresh_token_hash to sessions
--
-- Previously, each token refresh created a brand-new session row, causing
-- session table bloat and "Unknown device" entries in the sessions list.
--
-- With this column we can look up a session by its refresh token hash and
-- update the access token hash in-place, keeping one row per login.
-- =============================================================================

ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS refresh_token_hash TEXT;

-- Index for fast lookup by refresh token hash during token refresh
CREATE INDEX IF NOT EXISTS idx_sessions_refresh_hash ON sessions (refresh_token_hash)
    WHERE refresh_token_hash IS NOT NULL;
