-- AgroLink -- เกษตรกรแจ้งการเป็นสมาชิกสหกรณ์ / หน่วยงานอื่น (ตอนสมัคร หรือภายหลังในหน้า "สมาชิกภาพของฉัน")
--
-- เดิมทะเบียนสมาชิก (identity.farmer_org_relationship, grant_farmer_360.sql) เพิ่มได้จากฝั่ง
-- องค์กรเท่านั้น. ไฟล์นี้เพิ่ม "คำแจ้งสมาชิกภาพ" จากฝั่งเกษตรกร:
--   เกษตรกรเลือกหน่วยงาน + ใส่เลขสมาชิก/เลขลูกค้า (ถ้ามี) → สถานะ Pending
--   หน่วยงานตรวจกับทะเบียนของตน → ยืนยัน (Approved: สร้าง/เปิดความสัมพันธ์ผ่าน
--   identity.link_farmer_to_org() พร้อมเลขสมาชิก) หรือปฏิเสธ (Rejected + เหตุผล)
-- หน่วยงานที่แจ้งได้ (src/lib/membership.js MEMBERSHIP_ORG_TYPES): สหกรณ์ วิสาหกิจชุมชน
-- กองทุนหมู่บ้าน กองทุนช่วยเหลือเกษตรกร ธนาคาร/ผู้ให้สินเชื่อ (เป็นลูกค้า)
-- เกษตรกรแจ้งเองไม่ทำให้เป็นสมาชิกทันที — หน่วยงานต้องยืนยันก่อนเสมอ (กันการอ้างสิทธิ์/ส่วนแบ่งที่ไม่จริง)
-- ทะเบียนที่ยืนยันแล้วนี้เป็นฐานของการให้ส่วนแบ่งค่าธรรมเนียมแก่สหกรณ์ต้นสังกัดในภายหลัง
--
-- Security convention เหมือน grant_farmer_360.sql: ไม่มี RLS — ทุก query ต้องกรองด้วย
-- farmer_id ของผู้ login (farmer.js) หรือ org_id ของหน่วยงานที่ login (farmer360.js)
--
-- Idempotent: รันซ้ำได้. ต้องรันหลัง grant_farmer_360.sql.
-- ============================================================================

ALTER TABLE identity.farmer_org_relationship ADD COLUMN IF NOT EXISTS member_no text
  CHECK (member_no IS NULL OR length(member_no) BETWEEN 1 AND 40);

CREATE TABLE IF NOT EXISTS identity.membership_claim (
  claim_id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  farmer_id        uuid NOT NULL REFERENCES identity.farmer(farmer_id),
  org_id           uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  member_no        text CHECK (member_no IS NULL OR length(member_no) BETWEEN 1 AND 40),
  farmer_note      text CHECK (farmer_note IS NULL OR length(farmer_note) <= 300),
  source           text NOT NULL CHECK (source IN ('registration', 'portal')),
  status           text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Withdrawn')),
  reject_reason    text,
  decided_at       timestamptz,
  decided_by       text,
  relationship_id  uuid REFERENCES identity.farmer_org_relationship(relationship_id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'Rejected' OR reject_reason IS NOT NULL)
);
-- รอการยืนยันได้ครั้งละหนึ่งคำแจ้งต่อ (เกษตรกร, หน่วยงาน)
CREATE UNIQUE INDEX IF NOT EXISTS uq_membership_claim_pending ON identity.membership_claim (farmer_id, org_id) WHERE status = 'Pending';
CREATE INDEX IF NOT EXISTS idx_membership_claim_org ON identity.membership_claim (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_membership_claim_farmer ON identity.membership_claim (farmer_id, created_at DESC);

COMMENT ON TABLE identity.membership_claim IS 'เกษตรกรแจ้งว่าเป็นสมาชิก/ลูกค้าของหน่วยงาน — รอหน่วยงานยืนยัน (ไม่มี RLS กรองด้วย farmer_id/org_id)';

GRANT SELECT, INSERT, UPDATE ON identity.membership_claim TO agrolink_app;
