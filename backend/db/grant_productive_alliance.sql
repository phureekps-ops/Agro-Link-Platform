-- AgroLink -- P2 (RAP-T readiness roadmap): "กลไกพันธมิตรเพื่อการผลิตแบบ
-- ทางการ (Productive Alliance)" -- บันทึกข้อตกลงร่วมลงทุน 3 ฝ่าย (ภาครัฐ /
-- ผู้รับซื้อภาคเอกชน / สถาบันเกษตรกร) ต่อยอดจากระบบสัญญาซื้อขาย (contract.
-- contract, grant_b2b_commerce_engine.sql) และ Group Buy (grant_group_buy.
-- sql) ที่มีอยู่แล้ว -- ปิดช่องว่างที่รายงาน AgroLink x RAP-T Gap Analysis
-- ระบุไว้ในแผนงาน P2: "ออกแบบโครงสร้างบันทึกข้อตกลงร่วมลงทุน 3 ฝ่าย"
--
-- ความแตกต่างจากสัญญาซื้อขาย (contract.contract) ที่มีอยู่แล้ว: สัญญาซื้อขาย
-- คือข้อตกลง 2 ฝ่าย (ผู้ซื้อ-ผู้ขาย) ว่าจะซื้อ-ขายอะไร ราคาเท่าไหร่ -- พันธมิตร
-- เพื่อการผลิตคือ "ชั้นธรรมาภิบาล/การลงทุนร่วม" ที่คลุมอยู่เหนือสัญญาซื้อขายนั้น
-- (ถ้ามี) บอกว่าใคร (รัฐ/ผู้ซื้อ/สถาบันเกษตรกร) สนับสนุนอะไรให้โครงการสำเร็จ
-- (เงินทุน/สิ่งของ/การค้ำประกัน/ความรู้) และใครต้องทำอะไรให้เสร็จเมื่อไหร่
-- (milestone ตามแผนธุรกิจร่วม) -- จึงไม่ใช่ contract_party แบบเดิม (ซึ่งมี
-- เพียง 2 บทบาทต่อสัญญาและไม่มีแนวคิดเรื่อง "เงินสนับสนุน"/"พันธสัญญา" เลย)
--
-- การตัดสินใจสำคัญที่ยืนยันกับผู้ใช้แล้ว (2026-10-18):
--   1. ฝั่งภาครัฐ: Platform Ops บันทึกแทนเจ้าหน้าที่รัฐก่อน (ไม่มีหน้าจอ
--      Government Dashboard ให้เจ้าหน้าที่ภาครัฐ (identity.government_officer,
--      grant_staff_and_government_access.sql) ล็อกอินมาจัดการเอง -- หน้าจอ
--      นั้นเป็นงานแยก M15 ที่ยังไม่สร้าง) -- เหมือนกับที่ Platform Ops เป็น
--      ผู้สร้างบัญชีเจ้าหน้าที่ภาครัฐเองทั้งหมดอยู่แล้ว (POST /admin/
--      government-officers, ไม่มีการสมัครด้วยตนเอง)
--   2. การลงทุนร่วม (เงิน/ของ/การค้ำประกันจากแต่ละฝ่าย): บันทึกเป็นข้อมูล
--      (pledged/disbursed) เท่านั้นในรอบนี้ -- ไม่เดินเงินจริงผ่าน
--      ledger.transfer_funds เหมือน Group Buy Settlement -- "manual today,
--      real wiring later" แบบเดียวกับที่ใช้มาตลอดในโปรเจกต์นี้ (Agri-Map,
--      ข้อมูลดาวเทียมก่อนเชื่อม Sentinel Hub) ถ้าวันหนึ่งต้องเดินเงินจริง
--      จะเป็นการเพิ่มฟังก์ชัน alliance.disburse_contribution() ที่เรียก
--      ledger.transfer_funds() ภายหลัง ไม่ใช่การแก้ schema นี้
--   3. ผูกกับสัญญาซื้อขาย (contract.contract) ได้ ถ้ามี แต่ไม่บังคับ --
--      underlying_contract_id เป็น NULLABLE เพราะข้อตกลงพันธมิตรฯ มักเกิด
--      ก่อนที่จะมีสัญญาซื้อขายจริง (ตกลงร่วมลงทุน/วางแผนธุรกิจกันก่อน แล้ว
--      ค่อยไปเปิด RFQ/e-Auction จริงทีหลัง) -- ไม่บังคับให้ชี้ไปที่สัญญาตั้งแต่
--      วันแรก
--
-- ขอบเขต MVP ที่ตั้งใจไม่ทำรอบนี้ (ตกลงกันเองนอกระบบไปก่อน เหมือน Group Buy):
--   ไม่มีการอนุมัติ/เซ็นชื่อแบบ workflow (draft -> active เปลี่ยนเองโดย
--   Platform Ops, ไม่ใช่ state machine ที่ตรวจเงื่อนไขอัตโนมัติ), ไม่มีการ
--   แจ้งเตือนเมื่อ milestone ใกล้ครบกำหนด, ไม่มีหน้าจอให้ผู้ซื้อ/สหกรณ์เข้ามา
--   ดูเอง (ทั้งหมดผ่านแอดมินก่อน) -- ทั้งหมดนี้เป็นงานต่อยอดในอนาคตถ้าจำเป็น
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS alliance;
GRANT USAGE ON SCHEMA alliance TO agrolink_app;

-- ============================================================
-- 1. ข้อตกลงพันธมิตรเพื่อการผลิต (หัวข้อตกลง 3 ฝ่าย)
-- ============================================================
CREATE TABLE IF NOT EXISTS alliance.agreement (
  agreement_id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  title                       text NOT NULL,
  commodity_code              text REFERENCES registry.commodity_ref(commodity_code),
  -- ฝ่ายผู้รับซื้อภาคเอกชน -- ปกติ org_type = 'Buyer' หรือ 'Mill' แต่ไม่บังคับ
  -- ระดับฐานข้อมูล (เหมือน contract.contract_party ที่ไม่บังคับ org_type ต่อ
  -- party_role เช่นกัน) -- หน้าแอดมินเป็นผู้กรองรายชื่อให้เลือกถูกต้อง
  buyer_org_id                uuid NOT NULL REFERENCES identity.organization(org_id),
  -- ฝ่ายสถาบันเกษตรกร -- สหกรณ์ (org_type = 'Cooperative') ในรอบนี้
  farmer_institution_org_id   uuid NOT NULL REFERENCES identity.organization(org_id),
  -- ฝ่ายภาครัฐ -- ผู้ลงนาม/ผู้รับผิดชอบจากฝั่งรัฐ (พ่วงหน่วยงาน+ขอบเขต
  -- จังหวัด/ประเทศมาด้วยอยู่แล้วผ่าน identity.government_officer.
  -- department_code/scope_type/province_code)
  government_officer_id       uuid NOT NULL REFERENCES identity.government_officer(officer_id),
  government_support_note     text,
  -- สัญญาซื้อขายที่เกี่ยวข้อง (ถ้ามี) -- ดูหมายเหตุข้อ 3 ด้านบนว่าทำไม NULLABLE
  underlying_contract_id      uuid REFERENCES contract.contract(contract_id),
  business_plan_summary       text,
  total_project_value         numeric(18,2),
  target_quantity             numeric(14,2),
  quantity_unit                text,
  start_date                   date,
  end_date                      date,
  status                        text NOT NULL DEFAULT 'draft',
  created_by_subject_type       text NOT NULL DEFAULT 'platform',
  created_by_subject_id          uuid,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alliance_agreement_title_check CHECK (length(trim(title)) > 0),
  CONSTRAINT alliance_agreement_status_check
    CHECK (status IN ('draft', 'active', 'completed', 'terminated')),
  CONSTRAINT alliance_agreement_parties_distinct_check
    CHECK (buyer_org_id <> farmer_institution_org_id),
  CONSTRAINT alliance_agreement_dates_check
    CHECK (end_date IS NULL OR start_date IS NULL OR end_date > start_date),
  CONSTRAINT alliance_agreement_total_project_value_check
    CHECK (total_project_value IS NULL OR total_project_value > 0),
  CONSTRAINT alliance_agreement_target_quantity_check
    CHECK (target_quantity IS NULL OR target_quantity > 0)
);
CREATE INDEX IF NOT EXISTS idx_alliance_agreement_status ON alliance.agreement (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alliance_agreement_buyer ON alliance.agreement (buyer_org_id);
CREATE INDEX IF NOT EXISTS idx_alliance_agreement_farmer_institution ON alliance.agreement (farmer_institution_org_id);
CREATE INDEX IF NOT EXISTS idx_alliance_agreement_gov_officer ON alliance.agreement (government_officer_id);

COMMENT ON TABLE alliance.agreement IS
  'ข้อตกลง "พันธมิตรเพื่อการผลิต" (Productive Alliance) 3 ฝ่าย ตามแนวคิดนโยบาย RAP-T -- ชั้นธรรมาภิบาล/การลงทุนร่วมที่คลุมเหนือสัญญาซื้อขาย (ถ้ามี) ระหว่างภาครัฐ ผู้รับซื้อภาคเอกชน และสถาบันเกษตรกร';
COMMENT ON COLUMN alliance.agreement.status IS
  'draft = กำลังร่างข้อตกลง/รอครบองค์ประกอบ, active = ดำเนินการอยู่, completed = ปิดโครงการสำเร็จ, terminated = ยกเลิกก่อนครบกำหนด -- เปลี่ยนด้วยมือโดย Platform Ops เท่านั้น ไม่มี state machine ตรวจเงื่อนไขอัตโนมัติในรอบนี้';

-- ============================================================
-- 2. การลงทุน/สนับสนุนร่วมของแต่ละฝ่าย (บันทึกเป็นข้อมูล ไม่เดินเงินจริง)
-- ============================================================
CREATE TABLE IF NOT EXISTS alliance.contribution (
  contribution_id    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  agreement_id       uuid NOT NULL REFERENCES alliance.agreement(agreement_id) ON DELETE CASCADE,
  party_role         text NOT NULL,
  contribution_type  text NOT NULL,
  description        text NOT NULL,
  -- NULL ได้สำหรับการสนับสนุนที่ไม่มีมูลค่าเป็นตัวเงินชัดเจน (เช่น ความรู้/
  -- คำปรึกษาด้านเทคนิค) -- ไม่บังคับประเมินมูลค่าทุกรายการ
  amount             numeric(18,2),
  status             text NOT NULL DEFAULT 'pledged',
  pledged_at         timestamptz NOT NULL DEFAULT now(),
  disbursed_at       timestamptz,
  recorded_by_subject_type text NOT NULL DEFAULT 'platform',
  recorded_by_subject_id   uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alliance_contribution_party_role_check
    CHECK (party_role IN ('government', 'buyer', 'farmer_institution')),
  CONSTRAINT alliance_contribution_type_check
    CHECK (contribution_type IN ('cash', 'in_kind', 'guarantee', 'technical_support', 'subsidy', 'other')),
  CONSTRAINT alliance_contribution_description_check CHECK (length(trim(description)) > 0),
  CONSTRAINT alliance_contribution_status_check CHECK (status IN ('pledged', 'disbursed', 'cancelled')),
  CONSTRAINT alliance_contribution_amount_check CHECK (amount IS NULL OR amount >= 0)
);
CREATE INDEX IF NOT EXISTS idx_alliance_contribution_agreement ON alliance.contribution (agreement_id);

COMMENT ON TABLE alliance.contribution IS
  'รายการเงิน/สิ่งของ/การสนับสนุนที่แต่ละฝ่าย (รัฐ/ผู้ซื้อ/สถาบันเกษตรกร) รับปากหรือได้ลงทุนไปแล้วตามข้อตกลงพันธมิตรฯ -- pledged/disbursed เป็นการบันทึกสถานะเท่านั้น ไม่ผูกกับการโอนเงินจริงผ่าน ledger ในรอบนี้ (ดูหมายเหตุหัวไฟล์)';
COMMENT ON COLUMN alliance.contribution.party_role IS
  'ฝ่ายที่ให้การสนับสนุนรายการนี้ -- government อ้างถึง alliance.agreement.government_officer_id, buyer อ้างถึง buyer_org_id, farmer_institution อ้างถึง farmer_institution_org_id ของข้อตกลงเดียวกัน';

-- ============================================================
-- 3. พันธสัญญา/ขั้นตอนตามแผนธุรกิจร่วม (milestone ติดตามความคืบหน้า)
-- ============================================================
CREATE TABLE IF NOT EXISTS alliance.commitment (
  commitment_id      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  agreement_id        uuid NOT NULL REFERENCES alliance.agreement(agreement_id) ON DELETE CASCADE,
  party_role           text NOT NULL,
  description           text NOT NULL,
  due_date               date,
  status                  text NOT NULL DEFAULT 'pending',
  completed_at             timestamptz,
  evidence_note             text,
  recorded_by_subject_type text NOT NULL DEFAULT 'platform',
  recorded_by_subject_id    uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alliance_commitment_party_role_check
    CHECK (party_role IN ('government', 'buyer', 'farmer_institution')),
  CONSTRAINT alliance_commitment_description_check CHECK (length(trim(description)) > 0),
  CONSTRAINT alliance_commitment_status_check CHECK (status IN ('pending', 'done', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_alliance_commitment_agreement ON alliance.commitment (agreement_id);
CREATE INDEX IF NOT EXISTS idx_alliance_commitment_due_date ON alliance.commitment (due_date) WHERE status = 'pending';

COMMENT ON TABLE alliance.commitment IS
  'พันธสัญญา/ขั้นตอนตามแผนธุรกิจร่วมของข้อตกลงพันธมิตรฯ ที่แต่ละฝ่ายต้องทำให้สำเร็จ (เช่น "ผู้ซื้อวางมัดจำ", "สหกรณ์ส่งมอบพื้นที่เพาะปลูก", "รัฐโอนเงินสนับสนุนงวดแรก") -- "เลยกำหนด" (overdue) คำนวณฝั่งหน้าจอจาก due_date เทียบกับวันนี้ ไม่ได้เก็บเป็นสถานะแยกในฐานข้อมูล เพื่อไม่ต้องมีงาน background cron มาไล่เปลี่ยนสถานะ';

-- ============================================================
-- Grants -- รูปแบบเดียวกับ procurement.group_buy/purchase_order ทุกประการ:
-- ไม่มี RLS, WHERE clause ใน route (requirePlatform ที่ /admin/* ทั้งหมด)
-- คือขอบเขตความปลอดภัยจริง
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON alliance.agreement TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON alliance.contribution TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON alliance.commitment TO agrolink_app;

-- ============================================================
-- Verification notes (run manually, not part of this script):
--   \d alliance.agreement
--   \d alliance.contribution
--   \d alliance.commitment
-- ============================================================
