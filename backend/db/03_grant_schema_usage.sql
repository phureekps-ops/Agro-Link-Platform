-- ============================================================================
-- AgroLink Platform — schema-level USAGE grants for agrolink_app.
-- ============================================================================
-- Table-level GRANTs (in setup_backend_role.sql and every grant_*.sql /
-- fix_*.sql script) are meaningless without USAGE on the schema they live
-- in — Postgres checks schema USAGE before it even looks at table
-- privileges. In the original sandbox this was granted by hand, once,
-- outside of any file in the repo, so every later script silently assumed
-- it already existed. Discovered while preparing a from-scratch restore
-- for the Render migration: a fresh database with every grant_*.sql /
-- fix_*.sql script applied still failed with
-- "permission denied for schema identity" on the very first real request,
-- because agrolink_app had table grants but no schema USAGE.
--
-- Run this AFTER 02_full_schema.sql (the schemas must exist) and BEFORE
-- setup_backend_role.sql / any grant_*.sql / fix_*.sql script.
-- ============================================================================

GRANT USAGE ON SCHEMA
  audit, contract, credit, identity, ledger, marketplace, monitoring,
  notification, ops, partner, produce, production, registry, reporting,
  retention, risk, security, traceability, underwriting
TO agrolink_app;
