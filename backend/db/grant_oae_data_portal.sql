-- AgroLink -- M15+ Government Data Portal: สำนักงานเศรษฐกิจการเกษตร (OAE,
-- Office of Agricultural Economics) officer login + outbound data-sharing
-- catalog, plus the generic "more than one government department" identity
-- piece the platform was missing.
--
-- Context: grant_staff_and_government_access.sql deliberately did NOT model
-- a department (กรม) entity -- its own header note says so explicitly:
-- "this platform only has ONE government department in scope (กรมส่งเสริม
-- สหกรณ์ ... a whole registry.department table for a single row would be
-- unjustified structure." That stopped being true the moment a SECOND
-- department (สศก.) needed its own officer login -- this migration is what
-- turns that single-department assumption into a real, if still minimal,
-- multi-department one. Everything here is additive: existing officers,
-- roles, and routes keep working completely unchanged (see the backfill in
-- step 2 below).
--
-- What this migration deliberately is, and is not:
--   - IS a generic registry.department table (any future department gets a
--     row, the same way registry.province already works for provinces) and
--     a department_code column added to identity.government_officer, so
--     Platform Ops can tell a กรมส่งเสริมสหกรณ์ officer apart from a สศก.
--     officer when provisioning an account. This, together with the
--     existing gov.* role-naming convention, is the REUSABLE part for
--     "other departments later" -- a third department just gets a new
--     registry.department row and its own gov.<dept>_officer role(s),
--     no schema change needed.
--   - IS a genuinely new oae schema -- สศก.'s own outbound data-sharing
--     catalog (oae.dataset), a per-audience sharing toggle (oae.
--     dataset_sharing), and a plain table for an OAE officer to record
--     REAL commodity price figures by hand (oae.commodity_price) once
--     they have them. Scoped specifically to สศก., the same way govgw.*
--     is scoped specifically to the cooperative-government gateway rather
--     than being a generic multi-agency data bus -- see that migration's
--     own header for why a narrower, concrete module beats a speculative
--     generic one in this codebase's established style (coopcarbon/
--     buyercarbon/villagefundcarbon are three separate schemas for the
--     same reason, not one mega "carbon" schema).
--   - Is NOT a real statistics feed from the actual สศก./NABC systems. No
--     real-time integration, file feed, or API agreement with สศก. exists
--     while writing this migration. oae.dataset is seeded with FOUR
--     category rows naming real, publicly-documented categories that
--     สศก./NABC actually publishes (ราคาสินค้าเกษตรที่เกษตรกรขายได้, ดัชนี
--     ราคา/ผลผลิตสินค้าเกษตร, การนำเข้า-ส่งออกสินค้าเกษตร, เศรษฐกิจสังคม
--     ครัวเรือนเกษตร) -- category placeholders only, exactly like govgw.
--     endpoint_catalog's two rows. oae.commodity_price is left completely
--     EMPTY by this migration -- no invented numbers. It only ever holds
--     a figure an actual OAE officer typed in through POST /oae/
--     commodity-prices (oae.record_commodity_price()) -- a legitimate
--     manual-entry workflow until a real automated feed exists, not a
--     fabrication. The cooperative and farmer portals built against this
--     migration will show "ยังไม่มีข้อมูล" until that happens, which is the
--     honest state of a real pilot rather than a fake demo full of
--     plausible-looking numbers.
--   - Is NOT a generic cross-agency data marketplace. oae.dataset_sharing's
--     audience column is a CHECK'd enum ('cooperative', 'farmer') rather
--     than an open text field -- adding a third audience (e.g. 'buyer')
--     later is a one-line CHECK change plus a new route, not a redesign.
--   - Does NOT couple a government officer's operational role_code to
--     their department_code in the database -- identity.role's existing
--     gov.* rows (gov.national_admin/gov.provincial_admin/gov.inspector,
--     CPD-flavored; this migration's new gov.oae_officer, OAE-specific)
--     stay independent of department_code. Platform Ops is trusted to pick
--     a role that matches the department when provisioning an account
--     (the admin UI's dropdown does this visually but not with a hard DB
--     constraint) -- tightening that is real future work, not assumed
--     here, same spirit as every other "route/UI convention, not a DB
--     constraint" shortcut already in this codebase (e.g. STAFF_ROLE_TO_
--     BUSINESS_ROLES in middleware/auth.js).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. registry.department -- generic reference data, same pattern as
--    registry.province. Seeded with the ONE department that already had an
--    implicit identity (CPD, backfilled onto every pre-existing officer
--    below) plus the new one (OAE) this migration is actually for.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS registry.department (
  department_code   text PRIMARY KEY,
  department_name_th text NOT NULL,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE registry.department IS
  'หน่วยงานภาครัฐที่มีเจ้าหน้าที่เข้าสู่ระบบ AgroLink ได้ -- ข้อมูลอ้างอิงทั่วแพลตฟอร์ม เพิ่มหน่วยงานใหม่ได้โดยไม่ต้องแก้ schema (ดูหมายเหตุหัวไฟล์นี้)';

GRANT SELECT ON registry.department TO agrolink_app;

INSERT INTO registry.department (department_code, department_name_th) VALUES
  ('CPD', 'กรมส่งเสริมสหกรณ์'),
  ('OAE', 'สำนักงานเศรษฐกิจการเกษตร (สศก.)')
ON CONFLICT (department_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. identity.government_officer -- widen with department_code. Backfilled
--    to 'CPD' for every officer created before this migration existed
--    (grant_staff_and_government_access.sql's only department in scope),
--    so no existing officer, role, or route changes behavior.
-- ---------------------------------------------------------------------------
ALTER TABLE identity.government_officer ADD COLUMN IF NOT EXISTS department_code text;

UPDATE identity.government_officer SET department_code = 'CPD' WHERE department_code IS NULL;

ALTER TABLE identity.government_officer ALTER COLUMN department_code SET NOT NULL;
ALTER TABLE identity.government_officer ADD CONSTRAINT government_officer_department_code_fkey
  FOREIGN KEY (department_code) REFERENCES registry.department(department_code);

CREATE INDEX IF NOT EXISTS idx_government_officer_department ON identity.government_officer (department_code);

COMMENT ON COLUMN identity.government_officer.department_code IS
  'หน่วยงานต้นสังกัดของเจ้าหน้าที่ -- บันทึกย้อนหลังเป็น CPD (กรมส่งเสริมสหกรณ์) ให้ทุกบัญชีที่สร้างก่อน migration นี้ (ดูหมายเหตุหัวไฟล์)';

-- ---------------------------------------------------------------------------
-- 3. identity.register_government_officer -- widen the parameter list to
--    accept p_department_code. A changed parameter list is a DIFFERENT
--    function identity to Postgres, so the old 7-argument overload is
--    explicitly dropped first (CREATE OR REPLACE would otherwise leave it
--    orphaned) -- same "DROP FUNCTION then CREATE FUNCTION" approach used
--    whenever a prior migration in this project widens a function's
--    signature rather than just its body.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS identity.register_government_officer(text, text, text, text, text, text, text);

CREATE FUNCTION identity.register_government_officer(
  p_full_name text, p_national_id_hash text, p_scope_type text, p_province_code text,
  p_auth_subject_id text, p_role_code text, p_department_code text, p_created_by text
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
    IF NOT EXISTS (SELECT 1 FROM registry.department WHERE department_code = p_department_code AND is_active) THEN
        RAISE EXCEPTION 'ไม่พบหน่วยงาน หรือหน่วยงานไม่ได้เปิดใช้งาน: %', p_department_code;
    END IF;

    INSERT INTO identity.government_officer (full_name, national_id_hash, scope_type, province_code, auth_subject_id, department_code, created_by)
    VALUES (p_full_name, p_national_id_hash, p_scope_type, p_province_code, p_auth_subject_id, p_department_code, p_created_by)
    RETURNING officer_id INTO v_officer_id;

    INSERT INTO identity.subject_role (subject_type, subject_id, role_code)
    VALUES ('government_officer', v_officer_id, p_role_code);

    RETURN v_officer_id;
END;
$$;

-- identity.deactivate_government_officer's signature is untouched -- no
-- DROP/CREATE needed for it.

-- ---------------------------------------------------------------------------
-- 4. identity.role -- seed the OAE officer operational role. Follows the
--    SAME gov.* naming convention as the three existing CPD-flavored rows
--    (gov.national_admin/gov.provincial_admin/gov.inspector) -- a future
--    third department would add its own gov.<dept>_officer row the same
--    way, not a schema change.
-- ---------------------------------------------------------------------------
INSERT INTO identity.role (role_code, description) VALUES
  ('gov.oae_officer', 'เจ้าหน้าที่สำนักงานเศรษฐกิจการเกษตร (สศก.) — จัดการรายการข้อมูล/ราคาสินค้าเกษตรที่เผยแพร่ผ่าน AgroLink และเปิด/ปิดการแบ่งปันข้อมูลให้พอร์ทัลสหกรณ์/เกษตรกร')
ON CONFLICT (role_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. oae schema -- สศก.'s own outbound data-sharing catalog. See header
--    note on why this is deliberately scoped to สศก., not a generic
--    cross-agency data bus.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS oae;
GRANT USAGE ON SCHEMA oae TO agrolink_app;

-- 5a. oae.dataset -- the catalog of data categories สศก. may choose to
--     share. Migration-seeded reference data (same pattern as govgw.
--     endpoint_catalog / registry.commodity_ref) -- agrolink_app gets
--     SELECT only, no INSERT/UPDATE/DELETE from the app role. See header
--     note: these four rows name REAL, public สศก./NABC category names,
--     not a live field-level feed.
CREATE TABLE IF NOT EXISTS oae.dataset (
  dataset_id        uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  dataset_code      text NOT NULL UNIQUE,
  dataset_name_th   text NOT NULL,
  description       text,
  update_frequency_th text,
  status            text NOT NULL DEFAULT 'Active',
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dataset_status_check CHECK (status IN ('Active', 'Retired'))
);

GRANT SELECT ON oae.dataset TO agrolink_app;

INSERT INTO oae.dataset (dataset_code, dataset_name_th, description, update_frequency_th) VALUES
  ('FARMGATE_PRICE',
   'ราคาสินค้าเกษตรที่เกษตรกรขายได้',
   'หมวดหมู่สำหรับราคาสินค้าเกษตรที่เกษตรกรขายได้จริงหน้าฟาร์ม ตามแนวทางการเผยแพร่ข้อมูลของสำนักงานเศรษฐกิจการเกษตร (สศก.) — ยังไม่มีการเชื่อมต่อฟีดข้อมูลจริงจาก สศก. ณ เวลาที่เขียน migration นี้ เป็นเพียงหมวดหมู่ placeholder รอข้อตกลงเชื่อมต่อจริง (ดูหมายเหตุขอบเขตท้ายไฟล์) ราคาที่แสดงในระบบมาจากการบันทึกด้วยมือของเจ้าหน้าที่ สศก. เท่านั้น',
   'รายวัน/รายสัปดาห์ (ตามที่เจ้าหน้าที่บันทึก)'),
  ('PRICE_PRODUCTION_INDEX',
   'ดัชนีราคาและดัชนีผลผลิตสินค้าเกษตร',
   'หมวดหมู่สำหรับดัชนีราคาสินค้าเกษตรและดัชนีผลผลิตสินค้าเกษตร ตามที่ สศก. เผยแพร่เป็นประจำ — placeholder เช่นเดียวกับข้างต้น',
   'รายเดือน (ตามที่เจ้าหน้าที่บันทึก)'),
  ('IMPORT_EXPORT',
   'ข้อมูลการนำเข้า-ส่งออกสินค้าเกษตร',
   'หมวดหมู่สำหรับข้อมูลปริมาณ/มูลค่าการนำเข้า-ส่งออกสินค้าเกษตรที่ สศก. รวบรวม — placeholder เช่นเดียวกับข้างต้น',
   'รายเดือน (ตามที่เจ้าหน้าที่บันทึก)'),
  ('FARM_HOUSEHOLD_SOCIOECONOMIC',
   'ข้อมูลเศรษฐกิจสังคมครัวเรือนเกษตร',
   'หมวดหมู่สำหรับข้อมูลภาวะเศรษฐกิจสังคมของครัวเรือนเกษตรที่ สศก. สำรวจเป็นประจำปี — placeholder เช่นเดียวกับข้างต้น',
   'รายปี (ตามที่เจ้าหน้าที่บันทึก)')
ON CONFLICT (dataset_code) DO NOTHING;

-- 5b. oae.dataset_sharing -- per-dataset, per-audience ON/OFF toggle. The
--     audience CHECK is the deliberately narrow (not open-text) extension
--     point named in the header note for adding a third audience later.
CREATE TABLE IF NOT EXISTS oae.dataset_sharing (
  dataset_id    uuid NOT NULL REFERENCES oae.dataset(dataset_id),
  audience      text NOT NULL,
  is_enabled    boolean NOT NULL DEFAULT false,
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, audience),
  CONSTRAINT dataset_sharing_audience_check CHECK (audience IN ('cooperative', 'farmer'))
);

CREATE INDEX IF NOT EXISTS idx_dataset_sharing_audience ON oae.dataset_sharing (audience, is_enabled);

GRANT SELECT, INSERT, UPDATE ON oae.dataset_sharing TO agrolink_app;

COMMENT ON TABLE oae.dataset_sharing IS
  'เปิด/ปิดการแบ่งปันข้อมูลแต่ละ dataset ให้แต่ละกลุ่มผู้ชม (cooperative/farmer) แยกกัน -- ไม่มีแถวสำหรับคู่ dataset/audience ใด แปลว่ายังไม่เปิดแบ่งปัน (ค่าเริ่มต้นปิด เช่นเดียวกับ consent-before-sharing ของ govgw)';

-- 5c. oae.commodity_price -- left COMPLETELY EMPTY by this migration. See
--     header note: only ever populated by a real OAE officer through
--     POST /oae/commodity-prices, never seeded with invented figures.
CREATE TABLE IF NOT EXISTS oae.commodity_price (
  price_id        uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  dataset_id      uuid NOT NULL REFERENCES oae.dataset(dataset_id),
  commodity_name_th text NOT NULL,
  price_date      date NOT NULL,
  price_value     numeric(14,2) NOT NULL,
  unit            text NOT NULL,
  source_note     text,
  recorded_by     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commodity_price_value_check CHECK (price_value >= 0)
);

CREATE INDEX IF NOT EXISTS idx_commodity_price_dataset ON oae.commodity_price (dataset_id, price_date DESC);

GRANT SELECT, INSERT ON oae.commodity_price TO agrolink_app;

-- 5d. oae.usage_log -- append-only. Lets an OAE officer actually see who
--     is using data they shared (a real, concrete answer to "สศก. ได้
--     ประโยชน์อะไร" raised earlier in this engagement) -- viewer_subject_
--     type reuses the platform's own existing subject-type vocabulary
--     (security.set_session_context()'s allow-list), not a new one.
CREATE TABLE IF NOT EXISTS oae.usage_log (
  usage_id            uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  dataset_id          uuid NOT NULL REFERENCES oae.dataset(dataset_id),
  viewer_subject_type text NOT NULL,
  viewer_ref_id       uuid NOT NULL,
  viewed_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_log_viewer_subject_type_check CHECK (viewer_subject_type IN ('organization', 'farmer'))
);

CREATE INDEX IF NOT EXISTS idx_usage_log_dataset ON oae.usage_log (dataset_id, viewed_at DESC);

GRANT SELECT, INSERT ON oae.usage_log TO agrolink_app;

-- ---------------------------------------------------------------------------
-- 6. Functions. Same "route checks the caller's authorization, function
--    trusts it and enforces the business rule" split as govgw.* above it.
-- ---------------------------------------------------------------------------

/** Resolves an Active OAE officer's own row, or NULL. Mirrors government.js's loadOfficerScope(). */
CREATE FUNCTION oae.assert_active_oae_officer(p_officer_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_department_code TEXT;
    v_status TEXT;
BEGIN
    SELECT department_code, status INTO v_department_code, v_status
      FROM identity.government_officer WHERE officer_id = p_officer_id;
    IF NOT FOUND OR v_status <> 'Active' THEN
        RAISE EXCEPTION 'ไม่พบเจ้าหน้าที่ หรือบัญชีถูกปิดใช้งาน: %', p_officer_id;
    END IF;
    IF v_department_code <> 'OAE' THEN
        RAISE EXCEPTION 'การทำรายการนี้สงวนไว้สำหรับเจ้าหน้าที่สำนักงานเศรษฐกิจการเกษตร (สศก.) เท่านั้น';
    END IF;
END;
$$;

CREATE FUNCTION oae.set_dataset_sharing(
  p_dataset_id uuid, p_audience text, p_is_enabled boolean, p_officer_id uuid
) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM oae.assert_active_oae_officer(p_officer_id);

    IF p_audience NOT IN ('cooperative', 'farmer') THEN
        RAISE EXCEPTION 'audience ไม่ถูกต้อง: %', p_audience;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM oae.dataset WHERE dataset_id = p_dataset_id) THEN
        RAISE EXCEPTION 'ไม่พบรายการข้อมูล %', p_dataset_id;
    END IF;

    INSERT INTO oae.dataset_sharing (dataset_id, audience, is_enabled, updated_by, updated_at)
    VALUES (p_dataset_id, p_audience, p_is_enabled, p_officer_id::text, now())
    ON CONFLICT (dataset_id, audience) DO UPDATE
      SET is_enabled = EXCLUDED.is_enabled, updated_by = EXCLUDED.updated_by, updated_at = now();
END;
$$;

CREATE FUNCTION oae.record_commodity_price(
  p_dataset_id uuid, p_commodity_name_th text, p_price_date date, p_price_value numeric,
  p_unit text, p_source_note text, p_recorded_by text, p_officer_id uuid
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_price_id uuid;
BEGIN
    PERFORM oae.assert_active_oae_officer(p_officer_id);

    IF NOT EXISTS (SELECT 1 FROM oae.dataset WHERE dataset_id = p_dataset_id AND status = 'Active') THEN
        RAISE EXCEPTION 'ไม่พบรายการข้อมูล หรือรายการถูกเลิกใช้แล้ว: %', p_dataset_id;
    END IF;
    IF p_price_value < 0 THEN
        RAISE EXCEPTION 'ราคาต้องไม่เป็นค่าลบ';
    END IF;

    INSERT INTO oae.commodity_price (dataset_id, commodity_name_th, price_date, price_value, unit, source_note, recorded_by)
    VALUES (p_dataset_id, p_commodity_name_th, p_price_date, p_price_value, p_unit, p_source_note, p_recorded_by)
    RETURNING price_id INTO v_price_id;

    RETURN v_price_id;
END;
$$;

/**
 * Called from the COOPERATIVE and FARMER portal routes (coopcollection.js /
 * farmer.js), never from oae.js itself -- trusts its caller on the viewer's
 * own identity, same convention as govgw.attempt_submission() trusting its
 * caller on the outcome. Silently a no-op if the dataset/audience pair
 * isn't actually shared, so a route can call this unconditionally right
 * after it has already filtered a dataset list down to shared-only rows
 * without needing a second existence check here.
 */
CREATE FUNCTION oae.log_dataset_usage(
  p_dataset_id uuid, p_viewer_subject_type text, p_viewer_ref_id uuid
) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF p_viewer_subject_type NOT IN ('organization', 'farmer') THEN
        RAISE EXCEPTION 'viewer_subject_type ไม่ถูกต้อง: %', p_viewer_subject_type;
    END IF;

    INSERT INTO oae.usage_log (dataset_id, viewer_subject_type, viewer_ref_id)
    VALUES (p_dataset_id, p_viewer_subject_type, p_viewer_ref_id);
END;
$$;

-- ============================================================================
-- Follow-up work this migration deliberately leaves open:
--   - No real สศก./NABC data feed of any kind -- oae.commodity_price is
--     empty until a real OAE officer types real figures in by hand through
--     POST /oae/commodity-prices. Building an actual automated feed is
--     future work once a real data-sharing agreement and spec exist, same
--     reasoning as govgw's own "no fabricated schema" note.
--   - Only ONE operational role per officer at creation time, and role_code
--     is not DB-enforced to match department_code -- same limitation
--     register_government_officer() already had before this migration,
--     see header note.
--   - oae.dataset_sharing's audience enum covers exactly the two audiences
--     asked for (cooperative, farmer). A third (e.g. 'buyer') is a CHECK
--     change plus a new route, not a redesign.
--   - A second government department wanting ITS OWN outbound data catalog
--     (not สศก.'s price/statistics data) would get its own schema
--     following this same pattern -- registry.department and the gov.*
--     role convention are the reusable pieces, oae.* itself is not a
--     generic multi-agency data bus (see header note).
--   - No notion of dataset versioning/history on oae.dataset_sharing
--     beyond updated_by/updated_at on the current row -- a full audit
--     trail of every toggle flip is real future work if that level of
--     oversight is ever needed.
-- ============================================================================
