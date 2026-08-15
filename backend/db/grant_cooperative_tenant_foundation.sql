-- AgroLink -- Cooperative SaaS, M01 Tenant Foundation.
--
-- Context: AgroLink_Cooperative_SaaS_Master_Blueprint_v1.0 (section 4 + 7,
-- Sprint S1-S2) calls for a "1 cooperative = 1 tenant" model built ON TOP
-- of this existing platform rather than a green-field NestJS/Java stack.
-- This migration is the first concrete step of that plan: it gives a
-- Cooperative-typed identity.organization row somewhere to live as a real
-- tenant, and gives Platform Ops a way to actually create one.
--
-- Why this was previously impossible: identity.organization.org_type and
-- identity.organization_role.role_type have ALWAYS allowed 'Cooperative'
-- as a value (see 02_full_schema.sql) — but 'Cooperative' was deliberately
-- REMOVED from both ORG_SELF_REGISTER_TYPES (src/routes/auth.js) and
-- ORG_REQUESTABLE_ROLE_TYPES (src/routes/organization.js) on 2026-07-24,
-- per an explicit product decision that a cooperative should not be able
-- to self-register through the public sign-up form like a private
-- machinery/input-supplier business can. The practical effect of that
-- decision: until this migration + the matching POST /admin/cooperatives
-- endpoint, there was NO path in the whole codebase to create a
-- Cooperative organization at all (not even a seed script). This migration
-- does not reverse that decision — self-registration stays closed — it
-- adds the Platform-Ops-provisioning path the decision always implied
-- would need to exist somewhere.
--
-- Scope explicitly NOT covered here (see Master Blueprint section 10, Open
-- Decisions Log, and the follow-up note at the bottom of this file):
--   - Per-staff-member login for a cooperative (Coop Manager / Accountant /
--     Credit Officer as DISTINCT logins). identity.organization_member
--     already models individual staff, and identity.subject_role already
--     allows subject_type = 'organization_member', but organization_member
--     has no auth_subject_id / JWT login path anywhere in this codebase.
--     Until that exists, every coop.* role added below is granted at the
--     ORGANIZATION level (the cooperative's own single login), same
--     granularity every other org type in this platform already uses.
--   - Postgres Row-Level Security for tenant isolation (Open Decision #3).
--     registry.cooperative_profile follows the same convention as
--     marketplace.machinery_booking et al.: explicit `WHERE org_id = $1`
--     in every query IS the security boundary, not RLS.
--   - Province is seeded here ONLY for the provinces that already appear
--     in AgroLink_Cooperative_National_Selection_Database_50_Cooperatives
--     (the Top-10 + Reserve-10 pilot list) — NOT all 77 Thai provinces.
--     This is intentionally partial; see the seed block below.

-- ---------------------------------------------------------------------
-- 1. registry.province — new reference table. Needed because Provincial
--    Officer (M01 role) and the future Government Dashboard (M15) both
--    require a real province concept, which nothing in this codebase had
--    before now (identity.farmer.region_code is free text, not FK'd to
--    anything).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS registry.province (
  province_code     text PRIMARY KEY,
  province_name_th  text NOT NULL,
  region_th         text NOT NULL,
  CONSTRAINT province_region_th_check
    CHECK (region_th IN ('เหนือ', 'อีสาน', 'กลาง', 'ตะวันออก', 'ตะวันตก', 'ใต้'))
);

COMMENT ON TABLE registry.province IS
  'อ้างอิงจังหวัด — PARTIAL SEED (เฉพาะจังหวัดที่ปรากฏใน National_Selection_Database_50_Cooperatives ณ วันที่ทำ migration นี้) ต้องเติมให้ครบ 77 จังหวัดจากรายการทางการ (DOPA / ISO 3166-2:TH) ก่อนใช้งานจริงระดับประเทศ';

INSERT INTO registry.province (province_code, province_name_th, region_th) VALUES
  ('UTTARADIT',          'อุตรดิตถ์',      'เหนือ'),
  ('NAKHON_RATCHASIMA',  'นครราชสีมา',     'อีสาน'),
  ('PHITSANULOK',        'พิษณุโลก',       'เหนือ'),
  ('PHICHIT',            'พิจิตร',         'กลาง'),
  ('SI_SA_KET',          'ศรีสะเกษ',       'อีสาน'),
  ('UBON_RATCHATHANI',   'อุบลราชธานี',    'อีสาน'),
  ('CHANTHABURI',        'จันทบุรี',        'ตะวันออก'),
  ('SONGKHLA',           'สงขลา',          'ใต้'),
  ('CHIANG_MAI',         'เชียงใหม่',       'เหนือ'),
  ('SUKHOTHAI',          'สุโขทัย',         'เหนือ'),
  ('TRAT',               'ตราด',           'ตะวันออก'),
  ('KANCHANABURI',       'กาญจนบุรี',      'ตะวันตก'),
  ('SAMUT_SAKHON',       'สมุทรสาคร',      'กลาง'),
  ('NAKHON_SAWAN',       'นครสวรรค์',      'กลาง'),
  ('PHETCHABURI',        'เพชรบุรี',        'ตะวันตก'),
  ('RATCHABURI',         'ราชบุรี',         'ตะวันตก')
ON CONFLICT (province_code) DO NOTHING;

GRANT SELECT ON registry.province TO agrolink_app;

-- ---------------------------------------------------------------------
-- 2. registry.cooperative_profile — cooperative-specific extension data,
--    kept OUT of identity.organization itself (same convention as
--    registry.production_unit extending identity.farmer, rather than
--    widening a shared core table every org type would carry unused
--    columns for).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS registry.cooperative_profile (
  org_id                        uuid PRIMARY KEY REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  province_code                 text NOT NULL REFERENCES registry.province(province_code),
  cooperative_registration_no   text,
  established_year              int,
  member_count_reported         int,
  notes                         text,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cooperative_profile_established_year_check
    CHECK (established_year IS NULL OR established_year BETWEEN 1900 AND 2100),
  CONSTRAINT cooperative_profile_member_count_check
    CHECK (member_count_reported IS NULL OR member_count_reported >= 0)
);

COMMENT ON TABLE registry.cooperative_profile IS
  'ข้อมูลเฉพาะของสหกรณ์ ต่อขยายจาก identity.organization (org_type=''Cooperative'') หนึ่งแถวต่อหนึ่งสหกรณ์ — member_count_reported เป็นตัวเลขที่สหกรณ์แจ้งเอง ไม่ใช่ COUNT จริงจาก identity.organization_member (ยังไม่มีการนำเข้าสมาชิกจริงในขั้นนี้ — เป็นงานของ M02)';

-- Enforced in a trigger rather than a CHECK constraint because a CHECK
-- cannot reference another table — same pattern already used elsewhere in
-- this schema for a cross-table invariant (see the party_id validation
-- trigger near contract.contract_party in 02_full_schema.sql).
CREATE OR REPLACE FUNCTION registry.check_cooperative_profile_org_type()
RETURNS trigger AS $$
DECLARE
  v_org_type text;
BEGIN
  SELECT org_type INTO v_org_type FROM identity.organization WHERE org_id = NEW.org_id;
  IF v_org_type IS NULL THEN
    RAISE EXCEPTION 'ไม่พบองค์กร org_id % ใน identity.organization', NEW.org_id;
  END IF;
  IF v_org_type <> 'Cooperative' THEN
    RAISE EXCEPTION 'registry.cooperative_profile ใช้ได้เฉพาะองค์กรที่ org_type = ''Cooperative'' เท่านั้น (org_id % คือ %)', NEW.org_id, v_org_type;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cooperative_profile_org_type ON registry.cooperative_profile;
CREATE TRIGGER trg_cooperative_profile_org_type
  BEFORE INSERT OR UPDATE ON registry.cooperative_profile
  FOR EACH ROW EXECUTE FUNCTION registry.check_cooperative_profile_org_type();

CREATE INDEX IF NOT EXISTS idx_cooperative_profile_province ON registry.cooperative_profile (province_code);

-- Same denormalized-org_id-scoping convention as every marketplace.* table
-- in this project — no RLS here either; WHERE org_id = $1 in every query
-- IS the security boundary.
GRANT SELECT, INSERT, UPDATE ON registry.cooperative_profile TO agrolink_app;

-- ---------------------------------------------------------------------
-- 3. New identity.role catalog entries — the reconciled role model from
--    the Master Blueprint (section 3), scoped to what is actually wired
--    today: ORGANIZATION-level roles (see the scope note at the top of
--    this file re: per-staff login not existing yet). Idempotent insert,
--    same idiom as registry.rice_grade_ref in grant_input_supplier_and_
--    buy_prices.sql — identity.role is also listed as belonging in
--    04_reference_data.sql for fresh installs; this ON CONFLICT DO NOTHING
--    insert here makes the same rows land correctly on an EXISTING
--    database too (this migration's actual purpose).
-- ---------------------------------------------------------------------
INSERT INTO identity.role (role_code, description) VALUES
  ('coop.admin',            'ผู้ดูแลระบบของสหกรณ์ (Coop Admin) — จัดการบัญชีผู้ใช้และการตั้งค่าของสหกรณ์ตนเอง'),
  ('coop.manager',          'ผู้จัดการสหกรณ์ (Coop Manager) — เห็นภาพรวมทุกโมดูลของสหกรณ์ตนเอง'),
  ('coop.accountant',       'บัญชี/การเงินสหกรณ์ (Accountant) — ดูแล M04 Cooperative Finance'),
  ('coop.credit_officer',   'เจ้าหน้าที่สินเชื่อสหกรณ์ (Credit Officer / Loan Officer) — ดูแล M05 Loan & Agri Credit'),
  ('coop.member_officer',   'เจ้าหน้าที่ทะเบียนสมาชิก (Member Officer) — ดูแล M02 Digital Member & Farmer'),
  ('coop.warehouse_officer','เจ้าหน้าที่คลัง/ลานตาก (Warehouse Officer) — ดูแล M10 Warehouse/Drying (ยังไม่พัฒนาในขั้นนี้)'),
  ('gov.national_admin',    'ผู้ดูแลระบบระดับกรม (CPD National/Super Admin) — ขอบเขต National'),
  ('gov.provincial_admin',  'เจ้าหน้าที่สำนักงานสหกรณ์จังหวัด (Provincial Officer) — ขอบเขต Province'),
  ('gov.inspector',         'ผู้ตรวจการสหกรณ์ (Inspector) — สิทธิ์อ่านเชิงตรวจสอบเท่านั้น ขอบเขต Province/National')
ON CONFLICT (role_code) DO NOTHING;

GRANT SELECT ON identity.role TO agrolink_app;
GRANT SELECT ON identity.subject_role TO agrolink_app;

-- ---------------------------------------------------------------------
-- Follow-up work this migration deliberately leaves open (tracked so the
-- next person picking up M02+ does not have to rediscover it):
--   1. Per-staff-member login (coop.manager / coop.accountant / etc. as
--      distinct people, not the shared org login) needs an auth_subject_id
--      + JWT login path added to identity.organization_member first.
--   2. registry.province needs the remaining ~61 Thai provinces before any
--      cooperative outside this migration's 16-province seed can be
--      provisioned (POST /admin/cooperatives will 400 on an unknown
--      province_code by design, not silently accept one).
--   3. gov.* roles are seeded into identity.role but nothing yet GRANTS
--      them to any subject, and requirePlatform (src/middleware/auth.js)
--      remains the only gate in front of /admin/* — a real National/
--      Provincial government login distinct from the shared Platform Ops
--      passcode is Sprint S2+ work, not this migration.
-- ---------------------------------------------------------------------
