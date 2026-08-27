-- AgroLink Platform — ระบบเติมทุนหมุนเวียนสหกรณ์ (Cooperative Working Capital
-- Top-Up System)
--
-- Feature request (2026-08-27): ให้สหกรณ์การเกษตรเสนอขอวงเงินเพิ่มจากแหล่งทุน
-- ภายนอก (ธ.ก.ส., สหกรณ์ออมทรัพย์, สหกรณ์เครดิตยูเนี่ยน, ธนาคารพาณิชย์,
-- Fintech, กองทุนพัฒนาสหกรณ์ ฯลฯ) เพื่อนำไปใช้ 2 วัตถุประสงค์ — (ก) ปล่อยกู้ต่อ
-- ให้สมาชิก และ (ข) เป็นเงินทุนหมุนเวียนรับซื้อผลผลิตช่วงเก็บเกี่ยว — โดยอ้างอิง
-- คะแนนความน่าเชื่อถือระดับสหกรณ์ที่คำนวณจากข้อมูลจริงบนแพลตฟอร์ม พร้อมระบบ
-- ติดตามการใช้เงินแบบเรียลไทม์ ต่อยอดจากเอกสารออกแบบ "AgroLink Cooperative
-- Credit Scoring And Monitoring System Design" (26 ส.ค. 2569)
--
-- ขอบเขตที่ตั้งใจไว้ชัดเจนสำหรับรอบนี้ (v1 — อ่านก่อนต่อยอด):
--   - AgroLink ยังคงเป็นผู้ให้ข้อมูล/จับคู่/ติดตามเท่านั้น ไม่ใช่ผู้ให้กู้เอง —
--     เหมือนหลักการเดิมทุกฟีเจอร์สินเชื่อในโปรเจกต์นี้
--   - "แหล่งทุนภายนอก" (credit.external_funding_source) เป็นเพียงไดเรกทอรีอ้างอิง
--     (ชื่อ/ประเภท) ไม่ใช่ identity.organization เต็มรูปแบบ — เพราะสถาบันการเงิน
--     ภายนอกอย่าง ธ.ก.ส./ธนาคารพาณิชย์ส่วนใหญ่ยังไม่ได้เป็นผู้ใช้งานแพลตฟอร์มจริง
--     ในระยะนี้ (ยืนยันตามหมายเหตุ §9/§12 ของเอกสารออกแบบ) ดังนั้นวงเงินที่อนุมัติ
--     (credit.cooperative_funding_facility) จึงไม่ผูกกับ contract.contract แบบ
--     credit.credit_line เดิม (ซึ่งต้องมี contract_party ฝั่ง 'organization' จริง)
--     — เป็นข้อจำกัดที่ตั้งใจ ไม่ใช่การมองข้าม
--   - การอนุมัติ/ปฏิเสธคำขอวงเงินยังเป็นการบันทึกผลการเจรจาที่เกิดขึ้นนอกระบบ
--     (เจ้าหน้าที่ AgroLink หรือแอดมินสหกรณ์กรอกผลเข้าระบบเอง) ไม่ใช่การเชื่อมต่อ
--     API ของผู้ให้กู้จริง — ตรงตามข้อจำกัดที่ระบุไว้แล้วในเอกสาร Working Capital
--     TopUp Portal Prototype §6
--   - กรณีปล่อยกู้ต่อสมาชิก (member_onlending) ใช้กลไก credit.credit_line/
--     credit.credit_drawdown ที่มีอยู่แล้ว (เพิ่มแค่คอลัมน์ funding_facility_id
--     เพื่อผูกว่าวงเงินไหนมาจากแหล่งทุนภายนอกก้อนไหน) — สหกรณ์ต้องถือบทบาท
--     'Lender' ที่ Verified แล้วจึงจะออกวงเงินให้สมาชิกได้ (เงื่อนไขเดิมของ
--     credit.issue_credit_line ไม่เปลี่ยนแปลง)
--   - กรณีทุนหมุนเวียนรับซื้อผลผลิต (procurement_working_capital) เป็นกลไกใหม่
--     ผูกกับ produce.lot ตรงตัว 1 ล็อต:1 รายการเบิก ตามที่ออกแบบไว้ในเอกสาร §7.2
--     แต่การ "คืนวงเงินอัตโนมัติเมื่อขายผ่าน Buyer Network" ในเวอร์ชันนี้ยังเป็น
--     การกรอกยอดขายด้วยมือ (credit.repay_procurement_drawdown) ไม่ใช่การเชื่อม
--     อัตโนมัติกับ marketplace.product_order จริง เพราะ produce.lot (ล็อตที่รับ
--     ซื้อจากสมาชิก) และ marketplace.product_listing/product_order (ที่สหกรณ์
--     ขายต่อให้ผู้ซื้อ) เป็นคนละกลไกที่ไม่เคยผูกกันมาก่อนในโปรเจกต์นี้ — การเชื่อม
--     อัตโนมัติเต็มรูปแบบเป็นงานขยายผลที่ต้องออกแบบความสัมพันธ์ lot↔order ก่อน
-- ============================================================================

-- ============================================================
-- 1. credit.external_funding_source — ไดเรกทอรีแหล่งทุนภายนอกอ้างอิง (ไม่ใช่
--    identity.organization) พร้อมข้อมูลตัวอย่างตามประเภทที่ระบุไว้ในเอกสาร
--    ออกแบบ §8 — แอดมินเพิ่มรายชื่อจริงต่อได้ภายหลังเมื่อมีการเจรจาจริง
-- ============================================================
CREATE TABLE IF NOT EXISTS credit.external_funding_source (
  funding_source_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_name       text NOT NULL,
  source_type       text NOT NULL,
  contact_note      text,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_funding_source_type_check CHECK (source_type IN
    ('BAAC', 'CommercialBank', 'SavingsCoop', 'CreditUnion', 'Fintech', 'ImpactFund', 'Other'))
);
COMMENT ON TABLE credit.external_funding_source IS 'ไดเรกทอรีแหล่งทุนภายนอกที่สหกรณ์ยื่นขอวงเงินได้ (ธ.ก.ส./ธนาคารพาณิชย์/สหกรณ์ออมทรัพย์/เครดิตยูเนี่ยน/Fintech/กองทุน) — เป็นข้อมูลอ้างอิงเท่านั้น ไม่ใช่บัญชีผู้ใช้งานแพลตฟอร์ม (ดูหมายเหตุขอบเขตหัวไฟล์)';

INSERT INTO credit.external_funding_source (source_name, source_type, contact_note) VALUES
  ('ธนาคารเพื่อการเกษตรและสหกรณ์การเกษตร (ธ.ก.ส.)', 'BAAC', 'ตัวอย่างเริ่มต้น — ต่อยอดสินเชื่อชะลอการขายข้าวเปลือก/สินเชื่อรวบรวมข้าวที่มีอยู่แล้ว'),
  ('กองทุนพัฒนาสหกรณ์ (กพส.) กรมส่งเสริมสหกรณ์', 'Other', 'ตัวอย่างเริ่มต้น — แหล่งทุนภาครัฐสำหรับสหกรณ์โดยเฉพาะ'),
  ('ธนาคารพาณิชย์ (ตัวอย่าง — ระบุชื่อจริงเมื่อมีการเจรจา)', 'CommercialBank', 'ตัวอย่างเริ่มต้น — วาง Produce Procurement Working Capital เป็น Inventory Financing'),
  ('สหกรณ์ออมทรัพย์ (ตัวอย่าง — ระบุชื่อจริงเมื่อมีการเจรจา)', 'SavingsCoop', 'ตัวอย่างเริ่มต้น — ใช้โครงสร้าง Model A/B ตาม Interlending System Design'),
  ('สหกรณ์เครดิตยูเนี่ยน (ตัวอย่าง — ระบุชื่อจริงเมื่อมีการเจรจา)', 'CreditUnion', 'ตัวอย่างเริ่มต้น'),
  ('Fintech Alternative Lender (ตัวอย่าง — ระบุชื่อจริงเมื่อมีการเจรจา)', 'Fintech', 'ตัวอย่างเริ่มต้น — เปิด API ให้ประเมินด้วย Alternative Credit Engine ของตนเอง')
ON CONFLICT DO NOTHING;

GRANT SELECT ON credit.external_funding_source TO agrolink_app;

-- ============================================================
-- 2. credit.cooperative_governance_assessment — สัญญาณธรรมาภิบาล (หมวด 4.2
--    ของเอกสารออกแบบ) เป็นการประเมินที่แอดมิน/เจ้าหน้าที่ AgroLink บันทึกเอง
--    (ไม่ใช่การเชื่อมข้อมูลจากกรมส่งเสริมสหกรณ์จริง — ต้องมีข้อตกลงแบ่งปันข้อมูล
--    อย่างเป็นทางการก่อนตามที่ระบุไว้แล้วในเอกสารออกแบบ §12) หนึ่งแถวต่อสหกรณ์
--    หนึ่งรายการล่าสุดเท่านั้น (ประเมินซ้ำ = UPSERT ทับของเดิม)
-- ============================================================
CREATE TABLE IF NOT EXISTS credit.cooperative_governance_assessment (
  org_id                 uuid PRIMARY KEY REFERENCES identity.organization(org_id),
  no_material_findings   boolean NOT NULL,
  notes                  text,
  assessed_by            text NOT NULL,
  assessed_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE credit.cooperative_governance_assessment IS 'ผลประเมินสัญญาณธรรมาภิบาลของสหกรณ์ที่แอดมิน/เจ้าหน้าที่ AgroLink บันทึกด้วยมือ (ยังไม่เชื่อมข้อมูลจริงจากกรมส่งเสริมสหกรณ์ — รอข้อตกลงแบ่งปันข้อมูลอย่างเป็นทางการ) ใช้เป็นปัจจัยหนึ่งใน credit.compute_cooperative_credit_score()';

GRANT SELECT, INSERT, UPDATE ON credit.cooperative_governance_assessment TO agrolink_app;

-- ============================================================
-- 3. credit.cooperative_credit_score_snapshot — บันทึกภาพนิ่งของคะแนน ณ เวลา
--    ที่คำนวณ (ผูกกับคำขอวงเงินแต่ละครั้งเพื่อไม่ให้คะแนนที่ผู้ให้กู้เห็นตอนอนุมัติ
--    เปลี่ยนไปภายหลังจากข้อมูลใหม่) — คะแนน "ล่าสุดแบบเรียลไทม์" (ไม่ผูกคำขอ)
--    คำนวณสดทุกครั้งผ่าน credit.compute_cooperative_credit_score() โดยไม่ต้อง
--    พึ่งตารางนี้ เช่นเดียวกับหลักการ "ไม่มี cache" ของ reporting.coop_finance_summary()
-- ============================================================
CREATE TABLE IF NOT EXISTS credit.cooperative_credit_score_snapshot (
  snapshot_id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                  uuid NOT NULL REFERENCES identity.organization(org_id),
  computed_at             timestamptz NOT NULL DEFAULT now(),
  score                   integer NOT NULL,
  grade                   text NOT NULL,
  gmv_last_90d            numeric(18,2) NOT NULL,
  gmv_prior_90d           numeric(18,2) NOT NULL,
  gmv_growth_pct          numeric(8,2),
  f1_gmv_growth_score     integer NOT NULL,
  active_member_ratio_pct numeric(6,2),
  f2_member_activity_score integer NOT NULL,
  repayment_on_time_rate_pct numeric(6,2),
  f3_repayment_track_score integer NOT NULL,
  tenure_quarters         integer NOT NULL,
  f4_tenure_score         integer NOT NULL,
  governance_evaluated    boolean NOT NULL,
  f5_governance_score     integer NOT NULL,
  reasons                 text[] NOT NULL,
  CONSTRAINT coop_score_snapshot_score_check CHECK (score BETWEEN 0 AND 100),
  CONSTRAINT coop_score_snapshot_grade_check CHECK (grade IN ('A', 'B', 'C'))
);
CREATE INDEX IF NOT EXISTS idx_coop_score_snapshot_org ON credit.cooperative_credit_score_snapshot (org_id, computed_at DESC);

COMMENT ON TABLE credit.cooperative_credit_score_snapshot IS 'ภาพนิ่งของ AgroLink Cooperative Credit Score ณ เวลาใดเวลาหนึ่ง พร้อมรายละเอียด 5 ปัจจัย (f1-f5) และเหตุผลประกอบที่อธิบายได้ — สร้างขึ้นทุกครั้งที่มีการยื่นขอวงเงิน (credit.submit_funding_application) เพื่อ "ล็อก" คะแนน ณ วันที่ยื่น ไม่ให้เปลี่ยนย้อนหลัง';

GRANT SELECT, INSERT ON credit.cooperative_credit_score_snapshot TO agrolink_app;

-- ============================================================
-- 4. credit.cooperative_funding_application — คำขอวงเงินหนึ่งรายการ ไปยัง
--    แหล่งทุนภายนอกหนึ่งราย (ยื่นได้หลายรายพร้อมกันตามเอกสารออกแบบ §6 — เพียง
--    สร้างคำขอแยกแถวต่อผู้ให้กู้แต่ละราย ไม่มีข้อจำกัดจำนวนคำขอที่ Submitted
--    พร้อมกัน — การป้องกันใช้หลักประกัน/ล็อตซ้ำซ้อนอยู่ที่ระดับการเบิกวงเงินจริง
--    ในหมวด 6 ข้างล่าง ไม่ใช่ระดับคำขอ)
-- ============================================================
CREATE TABLE IF NOT EXISTS credit.cooperative_funding_application (
  application_id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                          uuid NOT NULL REFERENCES identity.organization(org_id),
  funding_source_id               uuid NOT NULL REFERENCES credit.external_funding_source(funding_source_id),
  purpose                         text NOT NULL,
  amount_requested                numeric(18,2) NOT NULL,
  term_months                     integer NOT NULL,
  purpose_note                    text,
  score_snapshot_id               uuid REFERENCES credit.cooperative_credit_score_snapshot(snapshot_id),
  status                          text NOT NULL DEFAULT 'Submitted',
  approved_amount                 numeric(18,2),
  approved_interest_rate_daily_bps integer,
  approved_tenor_months           integer,
  decision_note                   text,
  decided_by                      text,
  submitted_at                    timestamptz NOT NULL DEFAULT now(),
  decided_at                      timestamptz,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coop_funding_app_purpose_check CHECK (purpose IN ('member_onlending', 'procurement_working_capital')),
  CONSTRAINT coop_funding_app_amount_check CHECK (amount_requested > 0),
  CONSTRAINT coop_funding_app_term_check CHECK (term_months > 0),
  CONSTRAINT coop_funding_app_status_check CHECK (status IN ('Submitted', 'UnderReview', 'Approved', 'Rejected', 'Withdrawn')),
  CONSTRAINT coop_funding_app_approved_amount_check CHECK (approved_amount IS NULL OR approved_amount > 0)
);
CREATE INDEX IF NOT EXISTS idx_coop_funding_app_org ON credit.cooperative_funding_application (org_id, status);

COMMENT ON TABLE credit.cooperative_funding_application IS 'คำขอวงเงินของสหกรณ์ไปยังแหล่งทุนภายนอกหนึ่งราย ("Digital Credit Request Package" ตามเอกสารออกแบบ §5-6) — บันทึกผลการเจรจา ไม่ใช่การเชื่อมต่อ API ผู้ให้กู้จริง (ดูหมายเหตุขอบเขตหัวไฟล์) เมื่อ status=Approved ระบบสร้าง credit.cooperative_funding_facility ให้อัตโนมัติผ่าน credit.decide_funding_application()';

GRANT SELECT, INSERT, UPDATE ON credit.cooperative_funding_application TO agrolink_app;

-- ============================================================
-- 5. credit.cooperative_funding_facility — วงเงินที่อนุมัติแล้วหนึ่งก้อน
--    (สร้างอัตโนมัติเมื่อคำขอข้างต้นได้รับอนุมัติ) — ไม่ผูก contract.contract
--    เพราะแหล่งทุนภายนอกยังไม่ใช่ identity.organization จริง (ดูหมายเหตุขอบเขต
--    หัวไฟล์)
-- ============================================================
CREATE TABLE IF NOT EXISTS credit.cooperative_funding_facility (
  facility_id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  application_id          uuid NOT NULL UNIQUE REFERENCES credit.cooperative_funding_application(application_id),
  org_id                  uuid NOT NULL REFERENCES identity.organization(org_id),
  funding_source_id       uuid NOT NULL REFERENCES credit.external_funding_source(funding_source_id),
  purpose                 text NOT NULL,
  facility_limit          numeric(18,2) NOT NULL,
  interest_rate_daily_bps integer NOT NULL DEFAULT 0,
  tenor_months            integer NOT NULL,
  status                  text NOT NULL DEFAULT 'active',
  opened_at               timestamptz NOT NULL DEFAULT now(),
  closed_at               timestamptz,
  CONSTRAINT coop_funding_facility_purpose_check CHECK (purpose IN ('member_onlending', 'procurement_working_capital')),
  CONSTRAINT coop_funding_facility_limit_check CHECK (facility_limit > 0),
  CONSTRAINT coop_funding_facility_status_check CHECK (status IN ('active', 'closed'))
);
CREATE INDEX IF NOT EXISTS idx_coop_funding_facility_org ON credit.cooperative_funding_facility (org_id, status);

COMMENT ON TABLE credit.cooperative_funding_facility IS 'วงเงินจากแหล่งทุนภายนอกที่อนุมัติแล้วและยัง active — กรณี purpose=member_onlending ใช้ติดตามผ่าน credit.credit_line ที่ตั้ง funding_facility_id ชี้มาที่แถวนี้ กรณี purpose=procurement_working_capital ใช้ credit.cooperative_procurement_drawdown ผูกกับ produce.lot โดยตรง';

GRANT SELECT, INSERT, UPDATE ON credit.cooperative_funding_facility TO agrolink_app;

-- ============================================================
-- 6. credit.cooperative_procurement_drawdown — 1 แถวต่อ 1 produce.lot ที่เบิก
--    วงเงินไปซื้อ (ตามเอกสารออกแบบ §7.2 ข้อ 1-2) รองรับคืนวงเงินบางส่วนได้
--    (revolving working capital ต่างจาก credit.credit_drawdown ของสินเชื่อ
--    ปัจจัยการผลิตที่บังคับคืนเต็มจำนวนครั้งเดียว — ที่นี่คืนเป็นงวดตามยอดขายจริง
--    ได้เพราะเป็นเงินทุนหมุนเวียนระยะสั้น ไม่ใช่สินเชื่อมีดอกเบี้ยสะสมรายวัน)
-- ============================================================
CREATE TABLE IF NOT EXISTS credit.cooperative_procurement_drawdown (
  drawdown_id       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  facility_id       uuid NOT NULL REFERENCES credit.cooperative_funding_facility(facility_id),
  lot_id            uuid NOT NULL UNIQUE REFERENCES produce.lot(lot_id),
  drawn_amount      numeric(18,2) NOT NULL,
  drawn_at          timestamptz NOT NULL DEFAULT now(),
  repaid_amount     numeric(18,2) NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'outstanding',
  first_repaid_at   timestamptz,
  fully_repaid_at   timestamptz,
  CONSTRAINT coop_procurement_drawdown_amount_check CHECK (drawn_amount > 0),
  CONSTRAINT coop_procurement_drawdown_repaid_check CHECK (repaid_amount >= 0 AND repaid_amount <= drawn_amount),
  CONSTRAINT coop_procurement_drawdown_status_check CHECK (status IN ('outstanding', 'repaid'))
);
CREATE INDEX IF NOT EXISTS idx_coop_procurement_drawdown_facility ON credit.cooperative_procurement_drawdown (facility_id, status);

COMMENT ON TABLE credit.cooperative_procurement_drawdown IS 'เบิกใช้วงเงินทุนหมุนเวียนรับซื้อผลผลิต ผูกกับ produce.lot หนึ่งล็อตต่อหนึ่งรายการ — drawn_amount คำนวณจากยอดรวมค่าผลผลิตที่จ่ายจริงในล็อตนั้น (SUM ของ produce.delivery.total_amount) repaid_amount อัปเดตด้วยมือเมื่อสหกรณ์ขายต่อได้จริง (ดูหมายเหตุขอบเขตหัวไฟล์ว่าทำไมยังไม่เชื่อมอัตโนมัติกับ marketplace.product_order)';

GRANT SELECT, INSERT, UPDATE ON credit.cooperative_procurement_drawdown TO agrolink_app;

-- ============================================================
-- 7. credit.credit_line ได้คอลัมน์ใหม่ funding_facility_id — ผูกว่าวงเงินที่
--    สหกรณ์ (ในฐานะ Lender) ออกให้สมาชิกรายหนึ่งมาจากวงเงินภายนอกก้อนไหน (ถ้ามี)
--    NULL ได้เสมอ (เพิ่มแบบไม่กระทบ credit_line เดิมทุกแถว/ทุกฟีเจอร์ที่ใช้อยู่)
-- ============================================================
ALTER TABLE credit.credit_line ADD COLUMN IF NOT EXISTS funding_facility_id uuid REFERENCES credit.cooperative_funding_facility(facility_id);
CREATE INDEX IF NOT EXISTS idx_credit_line_funding_facility ON credit.credit_line (funding_facility_id) WHERE funding_facility_id IS NOT NULL;

COMMENT ON COLUMN credit.credit_line.funding_facility_id IS 'NULL = วงเงินที่ผู้ให้กู้ออกจากทุนของตนเองตามปกติ (ค่าเริ่มต้นเดิม ไม่กระทบ) — มีค่า = วงเงินนี้ออกโดยสหกรณ์จากวงเงินเติมทุนภายนอกที่อนุมัติผ่านระบบเติมทุนหมุนเวียนสหกรณ์ ใช้ทำ Roll-up Report ให้แหล่งทุนภายนอกเห็นภาพรวม (เอกสารออกแบบ §7.1)';

-- ============================================================
-- 8. credit.compute_cooperative_credit_score() — คำนวณสดทุกครั้ง (ไม่มี cache
--    เหมือน reporting.coop_finance_summary()) จาก 5 ปัจจัยตามเอกสารออกแบบ §4.2
--    น้ำหนักเท่ากันฝ่ายละ 20% เป็นจุดเริ่มต้นที่โปร่งใส/อธิบายง่ายที่สุด (เอกสาร
--    ออกแบบเองระบุว่าน้ำหนักจริงต้อง "ปรับเทียบกับข้อมูลจริง" ในภายหลัง — ไม่ใช่
--    ตัวเลขสุดท้าย) ทุกปัจจัยที่ยังไม่มีข้อมูลพอจะให้คะแนนกลาง (50) พร้อมเหตุผล
--    บอกตรงๆ ว่า "ยังไม่มีข้อมูล" แทนที่จะเดาหรือปฏิเสธคำนวณทั้งคะแนน
-- ============================================================
CREATE OR REPLACE FUNCTION credit.compute_cooperative_credit_score(p_org_id uuid)
RETURNS TABLE (
  score integer, grade text,
  gmv_last_90d numeric, gmv_prior_90d numeric, gmv_growth_pct numeric, f1_gmv_growth_score integer,
  active_member_ratio_pct numeric, f2_member_activity_score integer,
  repayment_on_time_rate_pct numeric, f3_repayment_track_score integer,
  tenure_quarters integer, f4_tenure_score integer,
  governance_evaluated boolean, f5_governance_score integer,
  reasons text[]
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_org_type TEXT;
  v_created_at TIMESTAMPTZ;
  v_gmv_last_90d NUMERIC := 0;
  v_gmv_prior_90d NUMERIC := 0;
  v_gmv_growth_pct NUMERIC;
  v_f1 INT;
  v_active_members INT := 0;
  v_total_members INT := 0;
  v_active_ratio_pct NUMERIC;
  v_f2 INT;
  v_repaid_on_time INT := 0;
  v_repaid_total INT := 0;
  v_repay_rate_pct NUMERIC;
  v_f3 INT;
  v_tenure_quarters INT;
  v_f4 INT;
  v_governance_evaluated BOOLEAN := false;
  v_governance_ok BOOLEAN;
  v_f5 INT;
  v_reasons TEXT[] := ARRAY[]::TEXT[];
  v_score INT;
  v_grade TEXT;
BEGIN
  SELECT o.org_type, o.created_at INTO v_org_type, v_created_at
    FROM identity.organization o WHERE o.org_id = p_org_id;
  IF v_org_type IS NULL THEN
    RAISE EXCEPTION 'ไม่พบองค์กร %', p_org_id;
  ELSIF v_org_type <> 'Cooperative' THEN
    RAISE EXCEPTION 'องค์กร % ไม่ใช่สหกรณ์ (org_type=%) คะแนนนี้ใช้ได้เฉพาะสหกรณ์เท่านั้น', p_org_id, v_org_type;
  END IF;

  -- f1: การเติบโตของ GMV (produce.delivery ที่ buyer_org_id=สหกรณ์นี้) 90 วัน
  -- ล่าสุด เทียบ 90 วันก่อนหน้า
  SELECT COALESCE(SUM(total_amount), 0) INTO v_gmv_last_90d FROM produce.delivery
    WHERE buyer_org_id = p_org_id AND status IN ('accepted', 'settled')
      AND delivered_at >= now() - INTERVAL '90 days';
  SELECT COALESCE(SUM(total_amount), 0) INTO v_gmv_prior_90d FROM produce.delivery
    WHERE buyer_org_id = p_org_id AND status IN ('accepted', 'settled')
      AND delivered_at >= now() - INTERVAL '180 days' AND delivered_at < now() - INTERVAL '90 days';

  IF v_gmv_prior_90d = 0 THEN
    IF v_gmv_last_90d = 0 THEN
      v_f1 := 50; v_gmv_growth_pct := NULL;
      v_reasons := array_append(v_reasons, 'ยังไม่มีข้อมูลการรับซื้อผลผลิตพอประเมินแนวโน้ม GMV (คะแนนกลาง 50 คะแนน)');
    ELSE
      v_f1 := 75; v_gmv_growth_pct := NULL;
      v_reasons := array_append(v_reasons, 'เริ่มมีธุรกรรมรับซื้อผลผลิตในช่วง 90 วันล่าสุด แต่ยังไม่มีข้อมูลไตรมาสก่อนหน้าเปรียบเทียบ');
    END IF;
  ELSE
    v_gmv_growth_pct := ROUND(((v_gmv_last_90d - v_gmv_prior_90d) / v_gmv_prior_90d) * 100, 2);
    v_f1 := GREATEST(0, LEAST(100, ROUND(50 + v_gmv_growth_pct * 2.5)::int));
    IF v_gmv_growth_pct >= 0 THEN
      v_reasons := array_append(v_reasons, format('GMV การรับซื้อผลผลิตเติบโต %s%% เทียบไตรมาส 90 วันก่อนหน้า', v_gmv_growth_pct));
    ELSE
      v_reasons := array_append(v_reasons, format('GMV การรับซื้อผลผลิตลดลง %s%% เทียบไตรมาส 90 วันก่อนหน้า', abs(v_gmv_growth_pct)));
    END IF;
  END IF;

  -- f2: สัดส่วนสมาชิก Active (มีธุรกรรมส่งมอบผลผลิตใน 180 วันล่าสุด) ต่อสมาชิก
  -- ทั้งหมดที่ status='active' ใน identity.farmer_org_relationship
  SELECT COUNT(*) INTO v_total_members FROM identity.farmer_org_relationship
    WHERE org_id = p_org_id AND status = 'active';
  IF v_total_members > 0 THEN
    SELECT COUNT(DISTINCT pu.owner_farmer_id) INTO v_active_members
      FROM produce.delivery d
      JOIN registry.production_unit pu ON pu.unit_id = d.unit_id
     WHERE d.buyer_org_id = p_org_id AND d.delivered_at >= now() - INTERVAL '180 days'
       AND pu.owner_farmer_id IN (
         SELECT farmer_id FROM identity.farmer_org_relationship WHERE org_id = p_org_id AND status = 'active'
       );
    v_active_ratio_pct := ROUND((v_active_members::numeric / v_total_members) * 100, 2);
    v_f2 := GREATEST(0, LEAST(100, ROUND(v_active_ratio_pct)::int));
    v_reasons := array_append(v_reasons, format('สมาชิก %s จาก %s ราย (%s%%) มีธุรกรรมส่งมอบผลผลิตใน 180 วันล่าสุด', v_active_members, v_total_members, v_active_ratio_pct));
  ELSE
    v_f2 := 50; v_active_ratio_pct := NULL;
    v_reasons := array_append(v_reasons, 'ยังไม่มีข้อมูลสมาชิกที่ยืนยันแล้วในระบบ (คะแนนกลาง 50 คะแนน)');
  END IF;

  -- f3: อัตราชำระคืนตรงเวลาของวงเงินภายนอกที่เคยเบิกใช้ (ทุนหมุนเวียนซื้อผลผลิต
  -- ที่ปิดแล้ว) — ยังไม่มีประวัติ = คะแนนกลาง ไม่ตัดสินล่วงหน้า
  SELECT COUNT(*) FILTER (WHERE d.status = 'repaid'),
         COUNT(*) FILTER (WHERE d.status = 'repaid' AND d.fully_repaid_at <= d.drawn_at + (f.tenor_months || ' months')::interval)
    INTO v_repaid_total, v_repaid_on_time
    FROM credit.cooperative_procurement_drawdown d
    JOIN credit.cooperative_funding_facility f ON f.facility_id = d.facility_id
   WHERE f.org_id = p_org_id;
  IF v_repaid_total = 0 THEN
    v_f3 := 50; v_repay_rate_pct := NULL;
    v_reasons := array_append(v_reasons, 'ยังไม่มีประวัติการชำระคืนวงเงินภายนอกที่ปิดรอบแล้วมาก่อน (คะแนนกลาง 50 คะแนน)');
  ELSE
    v_repay_rate_pct := ROUND((v_repaid_on_time::numeric / v_repaid_total) * 100, 2);
    v_f3 := GREATEST(0, LEAST(100, ROUND(v_repay_rate_pct)::int));
    v_reasons := array_append(v_reasons, format('ชำระคืนวงเงินภายนอกตรงกำหนด %s จาก %s รายการที่ปิดรอบแล้ว (%s%%)', v_repaid_on_time, v_repaid_total, v_repay_rate_pct));
  END IF;

  -- f4: อายุการใช้งานแพลตฟอร์ม (ไตรมาส) — cap ที่ 8 ไตรมาส (2 ปี) = เต็ม 100
  v_tenure_quarters := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - v_created_at)) / (90 * 86400))::int);
  v_f4 := GREATEST(0, LEAST(100, ROUND((v_tenure_quarters::numeric / 8) * 100)::int));
  v_reasons := array_append(v_reasons, format('เป็นสมาชิกแพลตฟอร์มมาแล้ว %s ไตรมาส', v_tenure_quarters));

  -- f5: สัญญาณธรรมาภิบาล — จากการประเมินด้วยมือเท่านั้นในเวอร์ชันนี้ (ดูหมาย
  -- เหตุตาราง credit.cooperative_governance_assessment)
  SELECT true, no_material_findings INTO v_governance_evaluated, v_governance_ok
    FROM credit.cooperative_governance_assessment WHERE org_id = p_org_id;
  IF NOT COALESCE(v_governance_evaluated, false) THEN
    v_f5 := 50; v_governance_evaluated := false;
    v_reasons := array_append(v_reasons, 'ยังไม่มีการประเมินสัญญาณธรรมาภิบาลจากเจ้าหน้าที่ (คะแนนกลาง 50 คะแนน — รอข้อตกลงเชื่อมข้อมูลกับกรมส่งเสริมสหกรณ์)');
  ELSIF v_governance_ok THEN
    v_f5 := 100;
    v_reasons := array_append(v_reasons, 'ผลประเมินธรรมาภิบาลล่าสุดไม่พบข้อบกพร่องสำคัญ');
  ELSE
    v_f5 := 20;
    v_reasons := array_append(v_reasons, 'ผลประเมินธรรมาภิบาลล่าสุดพบข้อบกพร่องที่ต้องติดตาม');
  END IF;

  v_score := ROUND((v_f1 + v_f2 + v_f3 + v_f4 + v_f5) / 5.0)::int;
  v_grade := CASE WHEN v_score >= 80 THEN 'A' WHEN v_score >= 60 THEN 'B' ELSE 'C' END;

  RETURN QUERY SELECT v_score, v_grade, v_gmv_last_90d, v_gmv_prior_90d, v_gmv_growth_pct, v_f1,
    v_active_ratio_pct, v_f2, v_repay_rate_pct, v_f3, v_tenure_quarters, v_f4,
    v_governance_evaluated, v_f5, v_reasons;
END;
$$;

COMMENT ON FUNCTION credit.compute_cooperative_credit_score(uuid) IS 'AgroLink Cooperative Credit Score — คำนวณสดทุกครั้งจากข้อมูลจริง 5 ปัจจัย น้ำหนักเท่ากัน (20% ต่อปัจจัย) พร้อมเหตุผลประกอบที่ตรวจสอบย้อนกลับได้ (ตามเอกสารออกแบบ §4.4) เป็นข้อมูลประกอบการตัดสินใจของผู้ให้กู้เท่านั้น ไม่ใช่การอนุมัติ/รับประกันวงเงิน';

GRANT EXECUTE ON FUNCTION credit.compute_cooperative_credit_score(uuid) TO agrolink_app;

-- ============================================================
-- 9. credit.submit_funding_application() — สหกรณ์ยื่นคำขอวงเงินไปยังแหล่งทุน
--    ภายนอกหนึ่งราย พร้อมล็อกคะแนน ณ วันที่ยื่น (snapshot)
-- ============================================================
CREATE OR REPLACE FUNCTION credit.submit_funding_application(
  p_org_id uuid,
  p_funding_source_id uuid,
  p_purpose text,
  p_amount_requested numeric,
  p_term_months integer,
  p_purpose_note text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_snapshot_id UUID;
  v_application_id UUID;
  v_score RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM credit.external_funding_source WHERE funding_source_id = p_funding_source_id AND is_active) THEN
    RAISE EXCEPTION 'ไม่พบแหล่งทุน % หรือถูกปิดใช้งานแล้ว', p_funding_source_id;
  END IF;

  SELECT * INTO v_score FROM credit.compute_cooperative_credit_score(p_org_id);

  INSERT INTO credit.cooperative_credit_score_snapshot
    (org_id, score, grade, gmv_last_90d, gmv_prior_90d, gmv_growth_pct, f1_gmv_growth_score,
     active_member_ratio_pct, f2_member_activity_score, repayment_on_time_rate_pct, f3_repayment_track_score,
     tenure_quarters, f4_tenure_score, governance_evaluated, f5_governance_score, reasons)
  VALUES
    (p_org_id, v_score.score, v_score.grade, v_score.gmv_last_90d, v_score.gmv_prior_90d, v_score.gmv_growth_pct, v_score.f1_gmv_growth_score,
     v_score.active_member_ratio_pct, v_score.f2_member_activity_score, v_score.repayment_on_time_rate_pct, v_score.f3_repayment_track_score,
     v_score.tenure_quarters, v_score.f4_tenure_score, v_score.governance_evaluated, v_score.f5_governance_score, v_score.reasons)
  RETURNING snapshot_id INTO v_snapshot_id;

  INSERT INTO credit.cooperative_funding_application
    (org_id, funding_source_id, purpose, amount_requested, term_months, purpose_note, score_snapshot_id, status, submitted_at)
  VALUES
    (p_org_id, p_funding_source_id, p_purpose, p_amount_requested, p_term_months, p_purpose_note, v_snapshot_id, 'Submitted', now())
  RETURNING application_id INTO v_application_id;

  RETURN v_application_id;
END;
$$;

COMMENT ON FUNCTION credit.submit_funding_application(uuid, uuid, text, numeric, integer, text) IS 'ยื่น Digital Credit Request Package หนึ่งชุดไปยังแหล่งทุนภายนอกหนึ่งราย — คำนวณและล็อก Cooperative Credit Score ณ เวลานี้ไว้ในคำขอด้วย';

GRANT EXECUTE ON FUNCTION credit.submit_funding_application(uuid, uuid, text, numeric, integer, text) TO agrolink_app;

-- ============================================================
-- 10. credit.decide_funding_application() — บันทึกผลอนุมัติ/ปฏิเสธ (ผลการ
--     เจรจาที่เกิดขึ้นนอกระบบ — ดูหมายเหตุขอบเขตหัวไฟล์) เมื่ออนุมัติ สร้าง
--     credit.cooperative_funding_facility ให้อัตโนมัติ
-- ============================================================
CREATE OR REPLACE FUNCTION credit.decide_funding_application(
  p_application_id uuid,
  p_decision text,
  p_approved_amount numeric DEFAULT NULL,
  p_interest_rate_daily_bps integer DEFAULT 0,
  p_approved_tenor_months integer DEFAULT NULL,
  p_decision_note text DEFAULT NULL,
  p_decided_by text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_app credit.cooperative_funding_application%ROWTYPE;
  v_facility_id UUID;
BEGIN
  IF p_decision NOT IN ('Approved', 'Rejected') THEN
    RAISE EXCEPTION 'ผลการพิจารณาต้องเป็น Approved หรือ Rejected เท่านั้น (ได้รับ %)', p_decision;
  END IF;

  SELECT * INTO v_app FROM credit.cooperative_funding_application WHERE application_id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบคำขอวงเงิน %', p_application_id;
  END IF;
  IF v_app.status NOT IN ('Submitted', 'UnderReview') THEN
    RAISE EXCEPTION 'คำขอวงเงิน % อยู่ในสถานะ % แล้ว ไม่สามารถบันทึกผลซ้ำได้', p_application_id, v_app.status;
  END IF;

  IF p_decision = 'Approved' THEN
    IF p_approved_amount IS NULL OR p_approved_amount <= 0 THEN
      RAISE EXCEPTION 'ต้องระบุวงเงินที่อนุมัติ (มากกว่า 0) เมื่อผลการพิจารณาคือ Approved';
    END IF;

    UPDATE credit.cooperative_funding_application SET
      status = 'Approved', approved_amount = p_approved_amount,
      approved_interest_rate_daily_bps = COALESCE(p_interest_rate_daily_bps, 0),
      approved_tenor_months = COALESCE(p_approved_tenor_months, v_app.term_months),
      decision_note = p_decision_note, decided_by = p_decided_by, decided_at = now(), updated_at = now()
    WHERE application_id = p_application_id;

    INSERT INTO credit.cooperative_funding_facility
      (application_id, org_id, funding_source_id, purpose, facility_limit, interest_rate_daily_bps, tenor_months)
    VALUES
      (p_application_id, v_app.org_id, v_app.funding_source_id, v_app.purpose, p_approved_amount,
       COALESCE(p_interest_rate_daily_bps, 0), COALESCE(p_approved_tenor_months, v_app.term_months))
    RETURNING facility_id INTO v_facility_id;
  ELSE
    UPDATE credit.cooperative_funding_application SET
      status = 'Rejected', decision_note = p_decision_note, decided_by = p_decided_by, decided_at = now(), updated_at = now()
    WHERE application_id = p_application_id;
  END IF;

  RETURN v_facility_id;
END;
$$;

COMMENT ON FUNCTION credit.decide_funding_application(uuid, text, numeric, integer, integer, text, text) IS 'บันทึกผลอนุมัติ/ปฏิเสธคำขอวงเงิน (แอดมิน/เจ้าหน้าที่กรอกผลที่เกิดขึ้นนอกระบบ) — เมื่ออนุมัติ สร้างวงเงินใช้งานจริง (credit.cooperative_funding_facility) ให้ทันที คืนค่า facility_id หรือ NULL หากปฏิเสธ';

GRANT EXECUTE ON FUNCTION credit.decide_funding_application(uuid, text, numeric, integer, integer, text, text) TO agrolink_app;

-- ============================================================
-- 11. credit.upsert_governance_assessment() — บันทึก/แก้ไขผลประเมินธรรมาภิบาล
-- ============================================================
CREATE OR REPLACE FUNCTION credit.upsert_governance_assessment(
  p_org_id uuid,
  p_no_material_findings boolean,
  p_notes text,
  p_assessed_by text
) RETURNS void LANGUAGE sql AS $$
  INSERT INTO credit.cooperative_governance_assessment (org_id, no_material_findings, notes, assessed_by, assessed_at)
  VALUES (p_org_id, p_no_material_findings, p_notes, p_assessed_by, now())
  ON CONFLICT (org_id) DO UPDATE SET
    no_material_findings = EXCLUDED.no_material_findings,
    notes = EXCLUDED.notes,
    assessed_by = EXCLUDED.assessed_by,
    assessed_at = now();
$$;

GRANT EXECUTE ON FUNCTION credit.upsert_governance_assessment(uuid, boolean, text, text) TO agrolink_app;

-- ============================================================
-- 12. credit.draw_procurement_facility_for_lot() — เบิกใช้วงเงินทุนหมุนเวียน
--     รับซื้อผลผลิตสำหรับ 1 ล็อต (ตามเอกสารออกแบบ §7.2 ข้อ 1-2) — จำนวนเงิน
--     คำนวณจากยอดรวมค่าผลผลิตที่จ่ายจริงในล็อตนั้น ไม่ใช่การเบิกเหมารวม
-- ============================================================
CREATE OR REPLACE FUNCTION credit.draw_procurement_facility_for_lot(
  p_facility_id uuid,
  p_lot_id uuid
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_facility credit.cooperative_funding_facility%ROWTYPE;
  v_lot_buyer_org_id UUID;
  v_lot_amount NUMERIC(18,2);
  v_outstanding_total NUMERIC(18,2);
  v_drawdown_id UUID;
BEGIN
  SELECT * INTO v_facility FROM credit.cooperative_funding_facility WHERE facility_id = p_facility_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบวงเงิน %', p_facility_id;
  END IF;
  IF v_facility.purpose <> 'procurement_working_capital' THEN
    RAISE EXCEPTION 'วงเงิน % ไม่ใช่ประเภททุนหมุนเวียนรับซื้อผลผลิต (purpose=%)', p_facility_id, v_facility.purpose;
  END IF;
  IF v_facility.status <> 'active' THEN
    RAISE EXCEPTION 'วงเงิน % อยู่ในสถานะ % ไม่สามารถเบิกใช้ได้', p_facility_id, v_facility.status;
  END IF;

  SELECT buyer_org_id INTO v_lot_buyer_org_id FROM produce.lot WHERE lot_id = p_lot_id;
  IF v_lot_buyer_org_id IS NULL THEN
    RAISE EXCEPTION 'ไม่พบล็อตผลผลิต %', p_lot_id;
  ELSIF v_lot_buyer_org_id <> v_facility.org_id THEN
    RAISE EXCEPTION 'ล็อต % ไม่ใช่ของสหกรณ์เจ้าของวงเงินนี้', p_lot_id;
  END IF;

  IF EXISTS (SELECT 1 FROM credit.cooperative_procurement_drawdown WHERE lot_id = p_lot_id) THEN
    RAISE EXCEPTION 'ล็อต % ถูกเบิกใช้วงเงินไปแล้ว (หนึ่งล็อตเบิกได้ครั้งเดียว)', p_lot_id;
  END IF;

  SELECT COALESCE(SUM(total_amount), 0) INTO v_lot_amount FROM produce.delivery
    WHERE lot_id = p_lot_id AND status IN ('accepted', 'settled');
  IF v_lot_amount <= 0 THEN
    RAISE EXCEPTION 'ล็อต % ยังไม่มีรายการส่งมอบที่ผ่านการตรวจคุณภาพ (accepted/settled) ให้เบิกวงเงินได้', p_lot_id;
  END IF;

  SELECT COALESCE(SUM(drawn_amount - repaid_amount), 0) INTO v_outstanding_total
    FROM credit.cooperative_procurement_drawdown WHERE facility_id = p_facility_id AND status = 'outstanding';

  IF v_outstanding_total + v_lot_amount > v_facility.facility_limit THEN
    RAISE EXCEPTION 'วงเงินไม่พอ: ใช้ไปแล้ว % จากวงเงิน % บาท เหลือ % บาท แต่ล็อตนี้ต้องการ % บาท',
      v_outstanding_total, v_facility.facility_limit, v_facility.facility_limit - v_outstanding_total, v_lot_amount;
  END IF;

  INSERT INTO credit.cooperative_procurement_drawdown (facility_id, lot_id, drawn_amount)
  VALUES (p_facility_id, p_lot_id, v_lot_amount)
  RETURNING drawdown_id INTO v_drawdown_id;

  RETURN v_drawdown_id;
END;
$$;

COMMENT ON FUNCTION credit.draw_procurement_facility_for_lot(uuid, uuid) IS 'เบิกใช้วงเงินทุนหมุนเวียนรับซื้อผลผลิตสำหรับล็อตหนึ่งล็อต — จำนวนเงินเท่ากับยอดรวมที่จ่ายจริงให้สมาชิกในล็อตนั้น (SUM produce.delivery.total_amount) หนึ่งล็อตเบิกได้ครั้งเดียว';

GRANT EXECUTE ON FUNCTION credit.draw_procurement_facility_for_lot(uuid, uuid) TO agrolink_app;

-- ============================================================
-- 13. credit.repay_procurement_drawdown() — คืนวงเงินบางส่วน/เต็มจำนวนเมื่อ
--     สหกรณ์ขายผลผลิตในล็อตนั้นได้จริง (กรอกยอดขายด้วยมือ — ดูหมายเหตุขอบเขต
--     หัวไฟล์ว่าทำไมยังไม่เชื่อมอัตโนมัติกับ marketplace.product_order)
-- ============================================================
CREATE OR REPLACE FUNCTION credit.repay_procurement_drawdown(
  p_drawdown_id uuid,
  p_repay_amount numeric
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_drawdown credit.cooperative_procurement_drawdown%ROWTYPE;
  v_new_repaid NUMERIC(18,2);
BEGIN
  IF p_repay_amount IS NULL OR p_repay_amount <= 0 THEN
    RAISE EXCEPTION 'จำนวนเงินคืนต้องมากกว่า 0';
  END IF;

  SELECT * INTO v_drawdown FROM credit.cooperative_procurement_drawdown WHERE drawdown_id = p_drawdown_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบรายการเบิกวงเงิน %', p_drawdown_id;
  END IF;
  IF v_drawdown.status = 'repaid' THEN
    RAISE EXCEPTION 'รายการเบิกวงเงิน % คืนครบแล้ว', p_drawdown_id;
  END IF;

  v_new_repaid := v_drawdown.repaid_amount + p_repay_amount;
  IF v_new_repaid > v_drawdown.drawn_amount THEN
    RAISE EXCEPTION 'ยอดคืนเกินยอดที่เบิกไป: เบิกไป % บาท คืนแล้ว % บาท พยายามคืนเพิ่มอีก % บาท',
      v_drawdown.drawn_amount, v_drawdown.repaid_amount, p_repay_amount;
  END IF;

  UPDATE credit.cooperative_procurement_drawdown SET
    repaid_amount = v_new_repaid,
    first_repaid_at = COALESCE(first_repaid_at, now()),
    status = CASE WHEN v_new_repaid >= drawn_amount THEN 'repaid' ELSE 'outstanding' END,
    fully_repaid_at = CASE WHEN v_new_repaid >= drawn_amount THEN now() ELSE NULL END
  WHERE drawdown_id = p_drawdown_id;
END;
$$;

COMMENT ON FUNCTION credit.repay_procurement_drawdown(uuid, numeric) IS 'บันทึกยอดคืนวงเงินทุนหมุนเวียน (บางส่วนหรือเต็มจำนวน) เมื่อสหกรณ์ขายผลผลิตในล็อตนั้นได้จริง — สถานะเปลี่ยนเป็น repaid อัตโนมัติเมื่อคืนครบยอดที่เบิกไป';

GRANT EXECUTE ON FUNCTION credit.repay_procurement_drawdown(uuid, numeric) TO agrolink_app;

-- ============================================================
-- Verification notes (run manually, not part of this script):
--   \d credit.external_funding_source
--   \d credit.cooperative_governance_assessment
--   \d credit.cooperative_credit_score_snapshot
--   \d credit.cooperative_funding_application
--   \d credit.cooperative_funding_facility
--   \d credit.cooperative_procurement_drawdown
--   \d credit.credit_line   -- confirm funding_facility_id column present
--   \df credit.compute_cooperative_credit_score
--   \df credit.submit_funding_application
--   \df credit.decide_funding_application
--   \df credit.upsert_governance_assessment
--   \df credit.draw_procurement_facility_for_lot
--   \df credit.repay_procurement_drawdown
-- ============================================================
