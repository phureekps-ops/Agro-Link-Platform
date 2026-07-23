-- ============================================================================
-- AgroLink Platform — Backend API Gateway: Service Account Setup
-- ============================================================================
-- agrolink_app (created in Layer 8) is intentionally NOLOGIN — it exists only
-- as the role RLS policies are written against, assumed via SET ROLE. A real
-- application needs a LOGIN-capable service account that is granted the
-- ability to assume agrolink_app per-request. This mirrors standard practice:
-- credentials the app authenticates with are kept separate from the
-- least-privilege role that actually touches business data under RLS.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agrolink_backend') THEN
        CREATE ROLE agrolink_backend LOGIN PASSWORD 'cBRLcYnY6LX6WTsnCXJgDi6hah2n1vEj';
    END IF;
END $$;

GRANT agrolink_app TO agrolink_backend;

-- agrolink_backend also needs USAGE on schemas + EXECUTE on the
-- security.*/audit.* bootstrap functions BEFORE it has assumed agrolink_app
-- (SET ROLE itself requires no special grant, but resolving the external
-- claim happens before session context — i.e. before SET ROLE — so grant
-- these directly to agrolink_backend too).
GRANT USAGE ON SCHEMA security, audit TO agrolink_backend;
GRANT EXECUTE ON FUNCTION security.resolve_subject_from_external_claim(TEXT) TO agrolink_backend;
