-- ============================================================================
-- AgroLink Platform — Backend API Gateway: Farmer Group Self-Declaration
-- ============================================================================
-- Lets an already-registered farmer optionally label their own account, in
-- their own dashboard (frontend/dashboard.html) — requested directly by
-- the user:
--   * กลุ่มเกษตรกร (farmer_group) — เกษตรกรอินทรีย์ (Organic) or เกษตรกร GAP,
--     or left unset. This is a plain SELF-DECLARATION, not a verified
--     certification: there is no VVB/inspector approval step behind it
--     (unlike carbon.carbon_project's own registered/credits_issued
--     lifecycle) — it is shown as-is, exactly like a farmer typing their
--     own bio. If AgroLink ever needs a verified-certificate version of
--     this later, that is a separate feature (a real cert upload +
--     approval queue), not this column.
--   * produce_types (ชนิดพืชหรือสัตว์ที่ผลิต) — free text, e.g. "ข้าวหอมมะลิ,
--     กุ้งขาว". Deliberately NOT a foreign key into registry.commodity_ref:
--     that table is its own explicit stub ("ตารางอ้างอิงชั่วคราวสำหรับความ
--     สมบูรณ์ของ FK เท่านั้น — ระบบ Catalog เต็มรูปแบบพัฒนาในขั้นถัดไป", see
--     02_full_schema.sql) and is scoped to registry.production_unit's
--     per-plot commodity_code, a different and more specific concept (one
--     exact crop/animal per plot per season) than this field (a farmer's
--     own free-text summary of what they generally produce, for their own
--     profile/group badge — not tied to any one plot or season).
--
-- Both columns are nullable and independent of each other — a farmer can
-- set either, both, or neither ("หรือไม่เลือกก็ได้" — optional, exactly as
-- asked). No new table needed: same one-row-per-farmer shape as every
-- other identity.farmer column.
--
-- farmer_group gets an app-layer CHECK (same additive drop-and-re-add
-- pattern used throughout this codebase whenever a CHECK needs widening
-- later) rather than trusting the Node layer alone, matching how every
-- other constrained free-choice column on this table already works
-- (see farmer_status_check in 02_full_schema.sql).
--
-- agrolink_app already has SELECT/INSERT/UPDATE on identity.farmer (see
-- grant_farmer_portal_reads.sql / grant_farmer_registration.sql / Layer 8,
-- and grant_farmer_district.sql's own note that Postgres column privileges
-- are table-wide unless a GRANT names specific columns) — no new GRANT
-- statements needed for either new column.
-- ============================================================================

ALTER TABLE identity.farmer ADD COLUMN IF NOT EXISTS farmer_group text;
ALTER TABLE identity.farmer ADD COLUMN IF NOT EXISTS produce_types text;

ALTER TABLE identity.farmer DROP CONSTRAINT IF EXISTS farmer_group_check;
ALTER TABLE identity.farmer ADD CONSTRAINT farmer_group_check
  CHECK (farmer_group IS NULL OR farmer_group IN ('Organic', 'GAP'));
