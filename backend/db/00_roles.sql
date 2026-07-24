-- ============================================================================
-- AgroLink Platform — base application role.
-- ============================================================================
-- agrolink_app is the least-privilege, RLS-governed role every request runs
-- as (via SET ROLE agrolink_app inside withSessionContext() in
-- src/db/pool.js). It is intentionally NOLOGIN — nothing authenticates to
-- Postgres directly as agrolink_app. The API instead authenticates as
-- agrolink_backend (a separate LOGIN role, created later by
-- setup_backend_role.sql) which is only granted membership in this role.
--
-- This file did not exist anywhere in the repo before the Render migration
-- — in the original sandbox, agrolink_app was created by hand once and
-- every later grant_*.sql/fix_*.sql script just assumed it already existed.
-- Run this FIRST, before 02_full_schema.sql and before setup_backend_role.sql.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agrolink_app') THEN
        CREATE ROLE agrolink_app NOLOGIN;
    END IF;
END $$;

-- Whoever is running this script (the local Postgres superuser in dev, or
-- Render's own database owner user on a fresh Render Postgres instance)
-- needs to be able to `SET ROLE agrolink_app` too, either to run later
-- setup scripts or — on Render specifically, see DEPLOY.md — to run the
-- API itself using Render's own default database user instead of a
-- separately-created agrolink_backend account. Membership is harmless to
-- grant broadly: agrolink_app has no LOGIN capability of its own, so this
-- only matters to a session that already authenticated as some other,
-- already-trusted role.
GRANT agrolink_app TO CURRENT_USER;
