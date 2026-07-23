-- ============================================================================
-- AgroLink Platform — Backend API Gateway: Farmer Registration Grant
-- ============================================================================
-- POST /auth/register inserts a new row into identity.farmer, AND a matching
-- role-grant row into identity.subject_role (role_code = 'farmer.self') —
-- discovered while testing end-to-end that security.set_session_context()
-- raises "ยังไม่ได้รับสิทธิ์ (Role) ใดๆ" for any subject with no row in
-- identity.subject_role, which every previously-seeded farmer already had
-- but a freshly-registered one does not, until this insert happens too.
-- Both run via SET ROLE agrolink_app, the same least-privilege role
-- everything else uses. agrolink_app already had SELECT on both tables
-- (grant_farmer_portal_reads.sql / Layer 8) but never INSERT, since nothing
-- before the registration feature ever wrote to either through the API.
-- ============================================================================

GRANT INSERT ON identity.farmer TO agrolink_app;
GRANT INSERT ON identity.subject_role TO agrolink_app;
