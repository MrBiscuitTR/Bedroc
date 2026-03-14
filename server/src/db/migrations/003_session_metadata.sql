-- =============================================================================
-- Migration 003: Add login_ip and last_used_at to sessions
--
-- login_ip       — IP address recorded at login time (NULL for old sessions)
-- last_used_at   — Timestamp of the most recent activity on this session
--
-- Both columns are optional/nullable so existing sessions are not broken.
-- =============================================================================

ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS login_ip TEXT,
    ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
