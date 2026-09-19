-- AgroLink Platform — Carbon Module, Phase 3 (Marketplace + Revenue
-- Sharing อัตโนมัติ) — ตามเอกสารออกแบบที่ผู้ใช้ยืนยันแล้ว ("ออกแบบ Carbon
-- Module — สหกรณ์ / วิสาหกิจชุมชน / กองทุนหมู่บ้าน", หัวข้อ "แผนพัฒนา
-- เป็นเฟส" > เฟส 3 และหัวข้อ "กลไกแบ่งรายได้ (Revenue Sharing Engine)")
--
-- ขอบเขตเฟส 3 (3 ข้อตามเอกสาร):
--   1. carbon.marketplace_listing / carbon.marketplace_order — จับคู่กับ
--      org_type='Buyer' ที่มีอยู่แล้ว การจับคู่เป็นแบบ MANUAL (Platform Ops
--      จับคู่ listing กับ order เอง เหมือนการตรวจสอบ AWD ที่มีอยู่ — ไม่ใช่
--      self-serve) ตามที่ยืนยัน — UI ส่วนจับคู่จึงเป็นเครื่องมือฝั่ง Admin
--      (backend/src/routes/admin.js ภายใต้ /admin/carbon/marketplace/*
--      เดิม /admin/carbon/* มีอยู่แล้วสำหรับตรวจสอบ AWD) ไม่ใช่หน้าร้าน
--      สาธารณะ
--   2. carbon.revenue_distribution + กลไกคำนวณอัตโนมัติ — คำนวณที่ backend
--      เสมอ 100% (ไม่ให้เจ้าหน้าที่กรอกเอง) ตามสูตร: Gross Revenue (=
--      matched_credit_tco2e × matched_price_per_tco2e) → หัก Project Cost
--      (กรอกโดย Platform Ops ตอนจับคู่) → หัก AgroLink Fee (platform_fee_pct
--      % ของ Gross, มาจาก carbon.carbon_project) → Net Revenue → แบ่ง
--      farmer_pool_pct % เข้า Farmer Pool (จัดสรรตามสัดส่วน
--      allocated_credit_tco2e ของสมาชิก active แต่ละคนใน
--      carbon.project_cycle_member) ส่วนที่เหลือเข้าองค์กร — หนึ่งแถวต่อ
--      ผู้รับต่อ order ใน carbon.revenue_distribution เพื่อให้ตรวจย้อนหลัง
--      ได้เสมอ (ดูตัวอย่างตัวเลขในเอกสารออกแบบ: Gross 30,000 บาท − ต้นทุน
--      โครงการ 2,000 − ค่าธรรมเนียม 10% ของ Gross (3,000) = Net 25,000 →
--      80% เข้ากลุ่มเกษตรกร (20,000) / 20% เข้าองค์กร (5,000))
--   3. ช่องทางจ่ายเงินจริง — ยังไม่มีระบบ payment/payout กลางในแพลตฟอร์มนี้
--      (ยืนยันจากการสำรวจโค้ดทั้งหมด ไม่พบ payment gateway ใดๆ) ตามที่
--      เอกสารออกแบบเสนอไว้สำหรับช่วงเริ่มต้น: บันทึกยอดค้างจ่าย
--      (payout_status) ไว้ในตารางนี้ ให้สหกรณ์/วิสาหกิจชุมชน/กองทุนหมู่บ้าน
--      โอนเงินกลับเกษตรกรเองผ่านช่องทางเดิมที่มีอยู่ แล้วกลับมากดยืนยันว่า
--      จ่ายแล้วในระบบ (audit trail เท่านั้น ไม่มีการโอนเงินจริงผ่านระบบนี้)
--
-- Design decision — "จับคู่ = ขายเต็มจำนวน, ไม่รองรับขายบางส่วนในรอบนี้":
-- เมื่อ listing ถูกจับคู่กับ order แล้ว ถือว่า listing นั้นถูกใช้ไปทั้งหมด
-- (status → 'matched', ไม่มีการคำนวณยอดคงเหลือให้ไปจับคู่กับ order อื่น
-- ต่อ) — ทำให้ตรรกะรอบแรกนี้เรียบง่ายและตรวจสอบได้ง่าย ถ้าต้องการขายเป็น
-- ล็อตย่อยหลายครั้งจากเครดิตก้อนเดียวกัน ให้สร้าง listing หลายใบแยกกัน
-- (จำนวนรวมที่แต่ละ listing ประกาศไม่ได้ถูกตรวจสอบไขว้กับยอดเครดิตทั้งหมด
-- ที่โครงการมี — เป็นความรับผิดชอบของผู้สร้าง listing เอง เหมือนที่ระบบ
-- ปัจจุบันไม่ตรวจสอบภาระผูกพันซ้อนในโมดูลการเงินอื่นๆ)
--
-- Listing ผูกกับโครงการที่ status = 'registered' หรือ 'credits_issued'
-- เท่านั้น (บังคับที่ชั้นแอปพลิเคชัน ไม่ใช่ CHECK ข้ามตาราง) — ขายได้ก็ต่อ
-- เมื่อเครดิตขึ้นทะเบียน/ออกแล้วจริง ไม่ใช่ตอนยังร่าง/เตรียมข้อมูลอยู่

CREATE TABLE IF NOT EXISTS carbon.marketplace_listing (
  listing_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id uuid NOT NULL REFERENCES carbon.carbon_project(project_id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  listed_credit_tco2e numeric(12,4) NOT NULL,
  asking_price_per_tco2e numeric(12,2) NOT NULL,
  status text NOT NULL DEFAULT 'open',
  note text,
  created_by_subject_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_listing_status_check CHECK (status IN ('open', 'matched', 'closed', 'cancelled')),
  CONSTRAINT marketplace_listing_credit_check CHECK (listed_credit_tco2e > 0),
  CONSTRAINT marketplace_listing_price_check CHECK (asking_price_per_tco2e > 0)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_listing_org ON carbon.marketplace_listing (org_id, status);
CREATE INDEX IF NOT EXISTS idx_marketplace_listing_project ON carbon.marketplace_listing (project_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_listing_status ON carbon.marketplace_listing (status);

CREATE TABLE IF NOT EXISTS carbon.marketplace_order (
  order_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  buyer_org_id uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  requested_credit_tco2e numeric(12,4) NOT NULL,
  offered_price_per_tco2e numeric(12,2) NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  note text,
  -- ทุกคอลัมน์ตั้งแต่ listing_id ลงไปเป็น NULL จนกว่า Platform Ops จะจับคู่
  -- (POST /admin/carbon/marketplace/orders/:id/match) — ค่าที่บันทึกคือ
  -- ราคา/จำนวนที่ "ตกลงกันจริง" ซึ่งอาจต่างจาก asking/offered เดิมของ
  -- แต่ละฝ่ายก็ได้ (Platform Ops เป็นคนกรอกตอนจับคู่)
  listing_id uuid REFERENCES carbon.marketplace_listing(listing_id),
  matched_credit_tco2e numeric(12,4),
  matched_price_per_tco2e numeric(12,2),
  project_cost_baht numeric(14,2),
  matched_by_subject_id uuid,
  matched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_order_status_check CHECK (status IN ('pending', 'matched', 'completed', 'cancelled')),
  CONSTRAINT marketplace_order_credit_check CHECK (requested_credit_tco2e > 0),
  CONSTRAINT marketplace_order_price_check CHECK (offered_price_per_tco2e > 0),
  CONSTRAINT marketplace_order_matched_shape CHECK (
    status NOT IN ('matched', 'completed')
    OR (listing_id IS NOT NULL AND matched_credit_tco2e IS NOT NULL AND matched_price_per_tco2e IS NOT NULL AND matched_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_marketplace_order_buyer ON carbon.marketplace_order (buyer_org_id, status);
CREATE INDEX IF NOT EXISTS idx_marketplace_order_listing ON carbon.marketplace_order (listing_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_order_status ON carbon.marketplace_order (status);

-- หนึ่งแถวต่อ "ผู้รับเงินหนึ่งราย" ต่อ order หนึ่งรายการ (องค์กร 1 แถว +
-- เกษตรกร active แต่ละคนในโครงการ 1 แถว) — เขียนครั้งเดียวตอนจับคู่สำเร็จ
-- (backend คำนวณ ไม่รับค่าจาก client) แล้วไม่แก้ไขตัวเลขอีก มีแค่
-- payout_status ที่อัปเดตได้ภายหลังตอนโอนเงินจริงเกิดขึ้นแล้ว (นอกระบบ)
CREATE TABLE IF NOT EXISTS carbon.revenue_distribution (
  distribution_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid NOT NULL REFERENCES carbon.marketplace_order(order_id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES carbon.carbon_project(project_id) ON DELETE CASCADE,
  recipient_type text NOT NULL,
  recipient_org_id uuid REFERENCES identity.organization(org_id),
  recipient_farmer_id uuid REFERENCES identity.farmer(farmer_id),
  amount_baht numeric(14,2) NOT NULL,
  payout_status text NOT NULL DEFAULT 'pending',
  paid_at timestamptz,
  paid_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT revenue_distribution_recipient_type_check CHECK (recipient_type IN ('organization', 'farmer')),
  CONSTRAINT revenue_distribution_recipient_shape CHECK (
    (recipient_type = 'organization' AND recipient_org_id IS NOT NULL AND recipient_farmer_id IS NULL)
    OR (recipient_type = 'farmer' AND recipient_farmer_id IS NOT NULL AND recipient_org_id IS NULL)
  ),
  CONSTRAINT revenue_distribution_amount_check CHECK (amount_baht >= 0),
  CONSTRAINT revenue_distribution_payout_status_check CHECK (payout_status IN ('pending', 'paid')),
  CONSTRAINT revenue_distribution_paid_shape CHECK (payout_status <> 'paid' OR paid_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_revenue_distribution_order ON carbon.revenue_distribution (order_id);
CREATE INDEX IF NOT EXISTS idx_revenue_distribution_project ON carbon.revenue_distribution (project_id);
CREATE INDEX IF NOT EXISTS idx_revenue_distribution_org ON carbon.revenue_distribution (recipient_org_id) WHERE recipient_org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_revenue_distribution_farmer ON carbon.revenue_distribution (recipient_farmer_id) WHERE recipient_farmer_id IS NOT NULL;

-- ============================================================
-- Grants — same convention as every other grant_*.sql (agrolink_app is
-- the least-privilege role every request assumes, see db/pool.js). ไม่มี
-- DELETE ให้ตารางไหนเลย — ยกเลิก listing/order ใช้ status='cancelled'
-- (UPDATE) เพื่อรักษาประวัติไว้ตามธรรมเนียมเดิมของ schema นี้ทั้งหมด
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON carbon.marketplace_listing TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON carbon.marketplace_order TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON carbon.revenue_distribution TO agrolink_app;
