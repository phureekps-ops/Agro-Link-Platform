-- AgroLink Platform — Carbon Module, Phase 1 (การรวมกลุ่มระดับองค์กร /
-- portal aggregation layer)
--
-- บริบท: ก่อนหน้านี้ carbon.* (grant_carbon_awd.sql) เป็นเครื่องมือระดับ
-- "เกษตรกรรายเดียว" เท่านั้น — ยืนยันรอบปลูก (AWD) แล้วได้ประมาณการ
-- คาร์บอนเครดิตต่อ 1 crop_cycle เท่านั้น ไม่มีชั้นใดๆ ให้สหกรณ์/วิสาหกิจ
-- ชุมชนด้านการเกษตร/กองทุนหมู่บ้าน "รวบรวม" ผลจากสมาชิกหลายคนเข้าเป็น
-- โครงการคาร์บอนเดียวเพื่อยื่นขอรับรอง/ขายจริง
--
-- Phase 1 (ตามเอกสารออกแบบที่ผู้ใช้ยืนยันแล้ว — Design: AgroLink Carbon
-- Module) เพิ่มเฉพาะชั้น "รวมกลุ่ม" นี้ — ยังไม่แตะ MRV evidence (Phase 2)
-- และยังไม่แตะ marketplace/revenue distribution (Phase 3):
--   1. ขยาย identity.farmer_org_relationship_type_check ให้มีค่า
--      'CommunityEnterpriseMember' (เดิมมีแค่ CooperativeMember/
--      VillageFundMember/LoanCustomer/Other — ไม่มีค่าเฉพาะสำหรับ
--      AgriCommunityEnterprise เลย) พร้อมอัปเดต CASE mapping ใน
--      identity.link_farmer_to_org() และ
--      identity.sync_farmer_relationships_from_transactions() (จาก
--      grant_farmer_360.sql) ให้ map org_type = 'AgriCommunityEnterprise'
--      ไปเป็น relationship_type นี้ด้วย — ไม่งั้นฟังก์ชันทั้งสองจะยังคง
--      ปล่อยให้ตกไปที่ 'Other' เหมือนเดิม แม้ constraint จะขยายแล้ว
--   2. carbon.carbon_project — โครงการคาร์บอนของ 1 องค์กร (Cooperative /
--      AgriCommunityEnterprise / VillageFund) พร้อม farmer_pool_pct /
--      platform_fee_pct ที่ตั้งค่าได้ต่อโครงการ (ตามที่ผู้ใช้ยืนยัน:
--      "ส่วนแบ่งรายได้ปรับแก้ได้" ไม่ใช่ค่าคงที่ 80/20 ทั้งระบบ)
--   3. carbon.project_cycle_member — เชื่อม carbon.awd_cycle_assessment
--      (ที่ verified แล้ว) ของสมาชิกแต่ละคนเข้ากับโครงการ ใช้ partial
--      unique index (ไม่ใช่ UNIQUE ตรงๆ) เพื่อบังคับกติกา "1 assessment
--      เข้าร่วมได้ทีละ 1 โครงการในช่วงเวลาเดียวกัน" ตามที่ผู้ใช้ยืนยัน
--      แต่ยังรักษาประวัติไว้ได้ถ้าถูกถอดออกแล้วเพิ่มใหม่ที่อื่น (แบบเดียว
--      กับ carbon.awd_config ใช้ idx_awd_config_one_active และแบบเดียวกับ
--      farmer_org_relationship ใช้ status + ended_at — ไม่ DELETE ทิ้ง)
--
-- Route/UI ที่ใช้ตารางเหล่านี้ (แยก 3 ไฟล์ตามที่ผู้ใช้ยืนยัน — coopcarbon.js,
-- communityenterprisecarbon.js, villagefundcarbon.js — ผ่าน shared helper
-- backend/src/lib/carbonAggregation.js) อยู่ในไฟล์แยกต่างหาก ไม่เกี่ยวกับ
-- migration นี้

-- ============================================================
-- 1. ขยาย identity.farmer_org_relationship_type_check
-- ============================================================
ALTER TABLE identity.farmer_org_relationship DROP CONSTRAINT IF EXISTS farmer_org_relationship_type_check;
ALTER TABLE identity.farmer_org_relationship ADD CONSTRAINT farmer_org_relationship_type_check
  CHECK (relationship_type IN ('CooperativeMember', 'VillageFundMember', 'LoanCustomer', 'CommunityEnterpriseMember', 'Other'));

-- CREATE OR REPLACE ทั้งสองฟังก์ชัน — คัดลอกทั้งฟังก์ชันจาก grant_farmer_360.sql
-- มาเพิ่มแค่ WHEN 'AgriCommunityEnterprise' บรรทัดเดียว ส่วนที่เหลือเหมือนเดิม
-- ทุกตัวอักษร (additive, ไม่ลบพฤติกรรมเดิม)
CREATE OR REPLACE FUNCTION identity.link_farmer_to_org(
  p_farmer_id uuid,
  p_org_id uuid,
  p_created_by_subject_type text,
  p_created_by_subject_id uuid,
  p_notes text DEFAULT NULL
) RETURNS identity.farmer_org_relationship
LANGUAGE plpgsql
AS $$
DECLARE
  v_org_type text;
  v_relationship_type text;
  v_row identity.farmer_org_relationship;
BEGIN
  SELECT org_type INTO v_org_type FROM identity.organization WHERE org_id = p_org_id;
  IF v_org_type IS NULL THEN
    RAISE EXCEPTION 'ไม่พบองค์กร %', p_org_id;
  END IF;

  v_relationship_type := CASE v_org_type
    WHEN 'Cooperative' THEN 'CooperativeMember'
    WHEN 'VillageFund' THEN 'VillageFundMember'
    WHEN 'Lender' THEN 'LoanCustomer'
    WHEN 'Bank' THEN 'LoanCustomer'
    WHEN 'AgriCommunityEnterprise' THEN 'CommunityEnterpriseMember'
    ELSE 'Other'
  END;

  INSERT INTO identity.farmer_org_relationship (
    farmer_id, org_id, relationship_type, status, joined_at,
    created_by_subject_type, created_by_subject_id, notes
  ) VALUES (
    p_farmer_id, p_org_id, v_relationship_type, 'active', now(),
    p_created_by_subject_type, p_created_by_subject_id, p_notes
  )
  ON CONFLICT (farmer_id, org_id) DO UPDATE
    SET status = 'active', ended_at = NULL, joined_at = now(),
        notes = COALESCE(EXCLUDED.notes, identity.farmer_org_relationship.notes),
        updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION identity.sync_farmer_relationships_from_transactions(
  p_org_id uuid,
  p_created_by_subject_type text,
  p_created_by_subject_id uuid
) RETURNS TABLE (linked_farmer_id uuid)
LANGUAGE plpgsql
AS $$
DECLARE
  v_org_type text;
  v_relationship_type text;
BEGIN
  SELECT org_type INTO v_org_type FROM identity.organization WHERE org_id = p_org_id;
  IF v_org_type IS NULL THEN
    RAISE EXCEPTION 'ไม่พบองค์กร %', p_org_id;
  END IF;

  v_relationship_type := CASE v_org_type
    WHEN 'Cooperative' THEN 'CooperativeMember'
    WHEN 'VillageFund' THEN 'VillageFundMember'
    WHEN 'Lender' THEN 'LoanCustomer'
    WHEN 'Bank' THEN 'LoanCustomer'
    WHEN 'AgriCommunityEnterprise' THEN 'CommunityEnterpriseMember'
    ELSE 'Other'
  END;

  RETURN QUERY
  INSERT INTO identity.farmer_org_relationship (
    farmer_id, org_id, relationship_type, status, joined_at,
    created_by_subject_type, created_by_subject_id, notes
  )
  SELECT candidates.candidate_farmer_id, p_org_id, v_relationship_type, 'active', now(),
         p_created_by_subject_type, p_created_by_subject_id, 'sync-from-transactions'
    FROM (
      SELECT DISTINCT pu.owner_farmer_id AS candidate_farmer_id
        FROM produce.delivery d
        JOIN registry.production_unit pu ON pu.unit_id = d.unit_id
       WHERE d.buyer_org_id = p_org_id
      UNION
      SELECT DISTINCT la.farmer_id FROM underwriting.loan_application la WHERE la.lender_org_id = p_org_id
      UNION
      SELECT DISTINCT po.farmer_id FROM marketplace.product_order po
       WHERE po.org_id = p_org_id AND po.farmer_id IS NOT NULL
      UNION
      SELECT DISTINCT mb.farmer_id FROM marketplace.machinery_booking mb WHERE mb.org_id = p_org_id
    ) candidates
   WHERE NOT EXISTS (
     SELECT 1 FROM identity.farmer_org_relationship r
      WHERE r.farmer_id = candidates.candidate_farmer_id AND r.org_id = p_org_id AND r.status = 'active'
   )
  ON CONFLICT (farmer_id, org_id) DO UPDATE
    SET status = 'active', ended_at = NULL, updated_at = now()
  RETURNING farmer_org_relationship.farmer_id AS linked_farmer_id;
END;
$$;

-- ============================================================
-- 2. carbon.carbon_project — โครงการคาร์บอนของ 1 องค์กร
-- ============================================================
CREATE TABLE IF NOT EXISTS carbon.carbon_project (
  project_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  org_role_type text NOT NULL,
  project_name text NOT NULL,
  methodology_ref text NOT NULL DEFAULT 'T-VER_AWD_RICE_v1_estimate',
  status text NOT NULL DEFAULT 'draft',
  farmer_pool_pct numeric(5,2) NOT NULL DEFAULT 80.00,
  platform_fee_pct numeric(5,2) NOT NULL DEFAULT 10.00,
  note text,
  created_by_subject_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carbon_project_org_role_type_check
    CHECK (org_role_type IN ('Cooperative', 'AgriCommunityEnterprise', 'VillageFund')),
  CONSTRAINT carbon_project_status_check
    CHECK (status IN ('draft', 'mrv_prep', 'submitted_to_tver', 'registered', 'credits_issued')),
  CONSTRAINT carbon_project_farmer_pool_pct_check CHECK (farmer_pool_pct >= 0 AND farmer_pool_pct <= 100),
  CONSTRAINT carbon_project_platform_fee_pct_check CHECK (platform_fee_pct >= 0 AND platform_fee_pct <= 100)
);

CREATE INDEX IF NOT EXISTS idx_carbon_project_org ON carbon.carbon_project (org_id, status);

-- ============================================================
-- 3. carbon.project_cycle_member — สมาชิก (assessment ที่ verified แล้ว)
--    ที่ถูกรวมเข้าโครงการ — "1 assessment เข้าร่วมได้ทีละ 1 โครงการใน
--    ช่วงเวลาเดียวกัน" บังคับด้วย partial unique index ด้านล่าง ไม่ใช่
--    UNIQUE ตรงๆ บนคอลัมน์ เพื่อให้ยังเก็บประวัติไว้ได้เมื่อถูกถอดออก
--    (status='removed') แล้วเพิ่มเข้าโครงการอื่นทีหลังได้โดยไม่ชนกัน
-- ============================================================
CREATE TABLE IF NOT EXISTS carbon.project_cycle_member (
  member_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id uuid NOT NULL REFERENCES carbon.carbon_project(project_id) ON DELETE CASCADE,
  assessment_id uuid NOT NULL REFERENCES carbon.awd_cycle_assessment(assessment_id),
  farmer_id uuid NOT NULL REFERENCES identity.farmer(farmer_id) ON DELETE CASCADE,
  allocated_credit_tco2e numeric(12,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by_subject_id uuid NOT NULL,
  removed_at timestamptz,
  CONSTRAINT project_cycle_member_status_check CHECK (status IN ('active', 'removed')),
  CONSTRAINT project_cycle_member_removed_shape CHECK (status <> 'removed' OR removed_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_cycle_member_one_active_assessment
  ON carbon.project_cycle_member (assessment_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_project_cycle_member_project ON carbon.project_cycle_member (project_id, status);
CREATE INDEX IF NOT EXISTS idx_project_cycle_member_farmer ON carbon.project_cycle_member (farmer_id, status);

-- ============================================================
-- Grants — same convention as every other grant_*.sql (agrolink_app is
-- the least-privilege role every request assumes, see db/pool.js). ไม่มี
-- DELETE ให้ตารางไหนเลย — การ "ถอดสมาชิก" ทำผ่าน UPDATE status='removed'
-- เท่านั้น (audit trail ยังอยู่ครบ เหมือน carbon.awd_cycle_assessment)
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON carbon.carbon_project TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON carbon.project_cycle_member TO agrolink_app;
