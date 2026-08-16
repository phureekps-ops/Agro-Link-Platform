-- AgroLink -- M01 Tenant Foundation, remaining piece #1: per-staff-member
-- login (Coop Admin/Manager/Accountant/etc. as DISTINCT people) and
-- Provincial/National government officer login.
--
-- Context: grant_cooperative_tenant_foundation.sql's own Follow-up section
-- named both of these explicitly as not-yet-built:
--   "1. Per-staff-member login (coop.manager / coop.accountant / etc. as
--    distinct people, not the shared org login) needs an auth_subject_id +
--    JWT login path added to identity.organization_member first."
--   "3. gov.* roles are seeded into identity.role but nothing yet GRANTS
--    them to any subject, and requirePlatform... remains the only gate in
--    front of /admin/* — a real National/Provincial government login
--    distinct from the shared Platform Ops passcode is Sprint S2+ work."
-- The Master Blueprint's own Gap Analysis rates the surrounding item
-- ("M01 Provincial/National tenant hierarchy") "สูง — จำเป็นสำหรับ
-- Government Dashboard (M15) และ Provincial Officer role" (high priority —
-- needed for the Government Dashboard and the Provincial Officer role).
-- registry.province already exists (grant_cooperative_tenant_foundation.
-- sql) — what was still missing was an actual IDENTITY a Provincial
-- Officer or a cooperative's own individual staff member could log in as.
-- This migration is that identity layer. The Government Dashboard itself
-- (the actual /gov/* routes and UI that USE this login) lands separately.
--
-- Design decision: identity.organization_member already exists and is
-- already exactly what the Follow-up note pointed at — one row per real
-- person affiliated with an organization, and identity.subject_role
-- already allows subject_type = 'organization_member'. Rather than invent
-- a parallel "cooperative staff" table, this migration widens
-- organization_member with the two columns a real login needs
-- (auth_subject_id, status) and leaves its existing eKYB purpose
-- (role_in_org = AuthorizedSignatory/Staff/Representative) completely
-- alone — a staff LOGIN account uses role_in_org = 'Staff' (already a
-- valid value) plus a NEW identity.subject_role row carrying the
-- OPERATIONAL role (coop.manager, coop.accountant, ...), which is a
-- separate concept from the KYB-signatory role_in_org column and was
-- already modeled that way before this migration touched anything.
--
-- Government officers have no existing table to extend — they are not
-- affiliated with any identity.organization at all (that is the whole
-- point of a National/Province-scoped role) — so this migration adds
-- identity.government_officer as a genuinely new, minimal identity table:
-- just enough to log in and carry a scope (National, or a specific
-- Province). It intentionally does NOT attempt to model a "department"
-- (กรม) entity — this platform only has ONE government department in
-- scope (กรมส่งเสริมสหกรณ์, per the Master Blueprint), so scope_type =
-- 'National' already means "the department", and a whole registry.
-- department table for a single row would be unjustified structure.
--
-- Both new login types require widening THREE existing Layer 8 security
-- primitives, all in this one migration since they're the same three
-- widenings for both:
--   1. security.resolve_subject_from_external_claim() — must resolve an
--      auth_subject_id claim to subject_type IN ('organization_member',
--      'government_officer') too, exactly like it already does for
--      farmer/organization.
--   2. security.set_session_context() — its subject_type allow-list
--      hard-codes ('farmer','organization','platform') today; must widen
--      to accept the two new types.
--   3. audit.access_log.subject_type CHECK — same reason: without this,
--      audit.log_access() (already called from every route this platform
--      has) would fail the instant a staff member or gov officer did
--      anything, since Postgres would reject the INSERT outright.
-- ============================================================================

-- ---------------------------------------------------------------------
-- 1. identity.organization_member — add login capability. auth_subject_id
--    is nullable: MOST rows in this table today are eKYB signatories with
--    no login at all, and that stays true — only a member explicitly
--    created via identity.register_staff_member() below gets one.
-- ---------------------------------------------------------------------
ALTER TABLE identity.organization_member ADD COLUMN IF NOT EXISTS auth_subject_id text UNIQUE;
ALTER TABLE identity.organization_member ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Active';
ALTER TABLE identity.organization_member DROP CONSTRAINT IF EXISTS organization_member_status_check;
ALTER TABLE identity.organization_member ADD CONSTRAINT organization_member_status_check
  CHECK (status IN ('Active', 'Inactive'));

COMMENT ON COLUMN identity.organization_member.auth_subject_id IS
  'Mock-OIDC login claim for a STAFF login account (identity.register_staff_member()) — NULL for eKYB-only signatory/representative rows that predate this migration and never log in themselves.';
COMMENT ON COLUMN identity.organization_member.status IS
  'Active/Inactive gate on LOGIN only (see security.resolve_subject_from_external_claim()) — an Inactive member keeps their historical audit.access_log trail intact, they simply can no longer authenticate.';

-- identity.organization_member predates this migration (eKYB signatory
-- capture only, grant_cooperative_tenant_foundation.sql) and was NEVER
-- granted to agrolink_app — it was only ever written through a SECURITY
-- DEFINER function during org onboarding, never queried directly by route
-- code. GET/POST /coop/staff (coopcollection.js) now query and write this
-- table directly as agrolink_app, so it needs its own grant here — found
-- the hard way in testing (42501 permission denied for table
-- organization_member on both the list and create routes).
GRANT SELECT, INSERT, UPDATE ON identity.organization_member TO agrolink_app;

-- ---------------------------------------------------------------------
-- 2. identity.government_officer — new, minimal identity table for
--    National/Province-scoped government staff. See header note on why
--    there is no separate "department" entity.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.government_officer (
  officer_id          uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  full_name            text NOT NULL,
  national_id_hash     text NOT NULL,
  scope_type           text NOT NULL,
  province_code        text REFERENCES registry.province(province_code),
  auth_subject_id       text NOT NULL UNIQUE,
  status               text NOT NULL DEFAULT 'Active',
  created_by           text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT government_officer_scope_type_check CHECK (scope_type IN ('National', 'Province')),
  CONSTRAINT government_officer_status_check CHECK (status IN ('Active', 'Inactive')),
  CONSTRAINT government_officer_province_shape CHECK (
    (scope_type = 'National' AND province_code IS NULL) OR
    (scope_type = 'Province' AND province_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_government_officer_province ON identity.government_officer (province_code);

COMMENT ON TABLE identity.government_officer IS
  'บุคลากรภาครัฐที่มีสิทธิ์เข้าสู่ระบบ ขอบเขต National (กรมฯ) หรือ Province (สำนักงานสหกรณ์จังหวัดใดจังหวัดหนึ่ง) — จัดตั้งโดย Platform Ops เท่านั้น (POST /admin/government-officers) เหมือนกับ POST /admin/cooperatives, ไม่มีการสมัครด้วยตนเอง';

GRANT SELECT, INSERT, UPDATE ON identity.government_officer TO agrolink_app;

-- ---------------------------------------------------------------------
-- 3. Widen the three Layer 8 security primitives.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION security.resolve_subject_from_external_claim(p_external_subject_claim text)
RETURNS TABLE(subject_type text, subject_id uuid)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    AS $$
BEGIN
  RETURN QUERY
  SELECT 'farmer'::text, f.farmer_id FROM identity.farmer f WHERE f.auth_subject_id = p_external_subject_claim
  UNION ALL
  SELECT 'organization'::text, o.org_id FROM identity.organization o WHERE o.auth_subject_id = p_external_subject_claim
  UNION ALL
  SELECT 'organization_member'::text, m.member_id FROM identity.organization_member m
    WHERE m.auth_subject_id = p_external_subject_claim AND m.status = 'Active'
  UNION ALL
  SELECT 'government_officer'::text, g.officer_id FROM identity.government_officer g
    WHERE g.auth_subject_id = p_external_subject_claim AND g.status = 'Active';
END;
$$;

CREATE OR REPLACE FUNCTION security.set_session_context(p_subject_type text, p_subject_id uuid DEFAULT NULL::uuid)
RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  IF p_subject_type NOT IN ('farmer', 'organization', 'platform', 'organization_member', 'government_officer') THEN
    RAISE EXCEPTION 'ประเภทผู้ใช้งานไม่ถูกต้อง: % (ต้องเป็น farmer, organization, organization_member, government_officer หรือ platform)', p_subject_type;
  END IF;

  IF p_subject_type <> 'platform' THEN
    IF p_subject_id IS NULL THEN
      RAISE EXCEPTION 'ต้องระบุ subject_id สำหรับผู้ใช้งานประเภท %', p_subject_type;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM identity.subject_role
      WHERE subject_type = p_subject_type AND subject_id = p_subject_id
    ) THEN
      RAISE EXCEPTION 'ผู้ใช้งาน % (%) ยังไม่ได้รับสิทธิ์ (Role) ใดๆ ในระบบ ไม่สามารถเข้าใช้งานได้', p_subject_type, p_subject_id;
    END IF;
  END IF;

  PERFORM set_config('app.subject_type', p_subject_type, false);
  PERFORM set_config('app.subject_id', COALESCE(p_subject_id::text, ''), false);
END;
$$;

ALTER TABLE audit.access_log DROP CONSTRAINT IF EXISTS access_log_subject_type_check;
ALTER TABLE audit.access_log ADD CONSTRAINT access_log_subject_type_check
  CHECK (subject_type IN ('farmer', 'organization', 'platform', 'organization_member', 'government_officer'));

-- identity.subject_role already allowed 'organization_member' (see the
-- header note) but NOT 'government_officer' — this is the fourth Layer 8
-- widening, found the hard way in testing: without it,
-- register_government_officer()'s own INSERT INTO identity.subject_role
-- fails outright, since that table's own CHECK constraint is a separate
-- gate from set_session_context()'s allow-list above.
ALTER TABLE identity.subject_role DROP CONSTRAINT IF EXISTS subject_role_subject_type_check;
ALTER TABLE identity.subject_role ADD CONSTRAINT subject_role_subject_type_check
  CHECK (subject_type IN ('farmer', 'organization', 'organization_member', 'government_officer'));

-- ---------------------------------------------------------------------
-- 4. Functions. Same "route does the ownership/ID-format check, function
--    does the business rule" split as every other module. auth_subject_id
--    is generated in the JS route layer (same mock-OIDC-claim convention
--    as generateOrgAuthSubjectId() in auth.js) and passed in as a
--    parameter, not generated here.
-- ---------------------------------------------------------------------

-- Creates a STAFF LOGIN for an existing Cooperative organization. Requires
-- p_role_code to already exist in identity.role AND start with 'coop.' —
-- the operational role set seeded by grant_cooperative_tenant_foundation.
-- sql (coop.admin/coop.manager/coop.accountant/coop.credit_officer/
-- coop.member_officer/coop.warehouse_officer). role_in_org is hard-coded
-- 'Staff' — this function is specifically the LOGIN path, not the
-- pre-existing eKYB-signatory path (which stays a direct INSERT with no
-- login, exactly as it worked before this migration).
CREATE FUNCTION identity.register_staff_member(
  p_org_id uuid, p_full_name text, p_national_id_hash text, p_auth_subject_id text,
  p_role_code text, p_created_by text
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_org_type TEXT;
    v_member_id uuid;
BEGIN
    SELECT org_type INTO v_org_type FROM identity.organization WHERE org_id = p_org_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบองค์กร %', p_org_id;
    END IF;
    IF v_org_type <> 'Cooperative' THEN
        RAISE EXCEPTION 'บัญชีพนักงานรายบุคคลใช้ได้เฉพาะองค์กรประเภทสหกรณ์เท่านั้น (org_id % คือ %)', p_org_id, v_org_type;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM identity.role WHERE role_code = p_role_code AND role_code LIKE 'coop.%') THEN
        RAISE EXCEPTION 'role_code ไม่ถูกต้องหรือไม่ใช่สิทธิ์ระดับสหกรณ์: %', p_role_code;
    END IF;

    INSERT INTO identity.organization_member (org_id, full_name, national_id_hash, role_in_org, auth_subject_id, status)
    VALUES (p_org_id, p_full_name, p_national_id_hash, 'Staff', p_auth_subject_id, 'Active')
    RETURNING member_id INTO v_member_id;

    INSERT INTO identity.subject_role (subject_type, subject_id, role_code)
    VALUES ('organization_member', v_member_id, p_role_code);

    RETURN v_member_id;
END;
$$;

CREATE FUNCTION identity.deactivate_staff_member(p_member_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.organization_member WHERE member_id = p_member_id) THEN
        RAISE EXCEPTION 'ไม่พบพนักงาน %', p_member_id;
    END IF;

    UPDATE identity.organization_member SET status = 'Inactive' WHERE member_id = p_member_id;
END;
$$;

CREATE FUNCTION identity.register_government_officer(
  p_full_name text, p_national_id_hash text, p_scope_type text, p_province_code text,
  p_auth_subject_id text, p_role_code text, p_created_by text
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_officer_id uuid;
BEGIN
    IF p_scope_type NOT IN ('National', 'Province') THEN
        RAISE EXCEPTION 'scope_type ไม่ถูกต้อง: %', p_scope_type;
    END IF;
    IF p_scope_type = 'Province' AND p_province_code IS NULL THEN
        RAISE EXCEPTION 'ต้องระบุจังหวัดสำหรับขอบเขต Province';
    END IF;
    IF p_scope_type = 'National' AND p_province_code IS NOT NULL THEN
        RAISE EXCEPTION 'ขอบเขต National ต้องไม่ระบุจังหวัด';
    END IF;
    IF p_province_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM registry.province WHERE province_code = p_province_code) THEN
        RAISE EXCEPTION 'ไม่พบจังหวัด %', p_province_code;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM identity.role WHERE role_code = p_role_code AND role_code LIKE 'gov.%') THEN
        RAISE EXCEPTION 'role_code ไม่ถูกต้องหรือไม่ใช่สิทธิ์ระดับภาครัฐ: %', p_role_code;
    END IF;

    INSERT INTO identity.government_officer (full_name, national_id_hash, scope_type, province_code, auth_subject_id, created_by)
    VALUES (p_full_name, p_national_id_hash, p_scope_type, p_province_code, p_auth_subject_id, p_created_by)
    RETURNING officer_id INTO v_officer_id;

    INSERT INTO identity.subject_role (subject_type, subject_id, role_code)
    VALUES ('government_officer', v_officer_id, p_role_code);

    RETURN v_officer_id;
END;
$$;

CREATE FUNCTION identity.deactivate_government_officer(p_officer_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.government_officer WHERE officer_id = p_officer_id) THEN
        RAISE EXCEPTION 'ไม่พบบุคลากรภาครัฐ %', p_officer_id;
    END IF;

    UPDATE identity.government_officer SET status = 'Inactive' WHERE officer_id = p_officer_id;
END;
$$;

-- ============================================================================
-- Follow-up work this migration deliberately leaves open:
--   - Only ONE operational role per staff member / government officer at
--     creation time (identity.subject_role itself supports many roles per
--     subject — the general table is untouched — but
--     register_staff_member()/register_government_officer() each insert
--     exactly one row and there is no "add another role" endpoint yet).
--   - No password/MFA of any kind — same mock-OIDC-claim-as-bearer-secret
--     convention as every other subject type in this sandbox
--     (auth_subject_id IS the credential). A real deployment needs a real
--     IdP for staff/government logins exactly as much as it does for
--     farmers/organizations today.
--   - No self-service "forgot my claim" recovery — Coop Admin (for staff)
--     or Platform Ops (for government officers) must look the claim back
--     up and relay it out-of-band, same as cooperative provisioning today.
--   - identity.government_officer has no notion of a specific person's
--     employment ending vs. a temporary suspension — status is a simple
--     Active/Inactive toggle, reactivation is not exposed via any route
--     yet (would just be a direct UPDATE today).
--   - No department (กรม) entity — see header note on why this is a
--     deliberate simplification, not an oversight, for a single-department
--     platform.
-- ============================================================================
