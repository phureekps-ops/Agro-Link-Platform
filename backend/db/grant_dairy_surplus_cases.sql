-- AgroLink -- ระบบแนะนำการแก้ปัญหานมเกินกำลังรับซื้อ (โปรแกรมโคนม ฝั่งสหกรณ์ + ภาครัฐ).
--
-- ระบบสแกนทุก 15 นาที (และทุกครั้งที่ปิดรอบรับนม) หา "กรณีนมเกิน" 3 ระดับ:
--   ศูนย์รับนม  วันนี้   นมค้างถัง + รอบถัดไป > ความจุถัง
--   สหกรณ์      7 วัน    นมเข้าเฉลี่ย 14 วัน > สัญญา + ดีลส่วนเกิน + นมโรงเรียน + โรงนมของตน
--   สหกรณ์      30/60/90 วันล่วงหน้า (จาก forecast เดิม) เกินเกณฑ์เตือนของสหกรณ์
-- แล้วสร้างทางเลือกแก้ไข (ผู้ซื้อตามสัญญารับเพิ่ม / โอนไปศูนย์อื่น / โรงงานที่ประกาศกำลังรับว่าง /
-- ผู้รับซื้อในทะเบียนตลาด / แปรรูปเอง / วางแผนฝูง / ขอความช่วยเหลือจังหวัด) จัดอันดับด้วย
-- รายได้สุทธิต่อ กก. หลังหักค่าขนส่งและค่าแปรรูป — ผู้จัดการสหกรณ์เป็นคนกดอนุมัติเสมอ
-- (ระบบไม่ส่งข้อเสนอหรือทำสัญญาเอง).
--
-- กรณีที่เลยกำหนดเวลาโดยยังไม่แก้ → Escalated อัตโนมัติ. ภาครัฐเห็นรายละเอียดรายสหกรณ์เฉพาะ
-- เมื่อสหกรณ์เปิด gov_data_consent หรือสหกรณ์กด "ขอความช่วยเหลือจังหวัด" เอง (shared_with_gov).
--
-- Security convention เหมือน grant_dairy_cooperative.sql: ไม่มี RLS ทุก query ต้องกรองด้วย
-- coop_org_id ของผู้ login (routes/dairy.js) หรือขอบเขตจังหวัดของเจ้าหน้าที่ (routes/dairygov.js).
--
-- Idempotent: รันซ้ำได้. ต้องรันหลัง grant_dairy_cooperative.sql.
-- ============================================================================

-- ค่าตั้งของระบบแนะนำ (ปรับได้ในหน้า ตั้งค่า ของสหกรณ์)
ALTER TABLE dairy.setting ADD COLUMN IF NOT EXISTS surplus_hold_hours        smallint      NOT NULL DEFAULT 24;
ALTER TABLE dairy.setting ADD COLUMN IF NOT EXISTS surplus_min_kg_center     numeric(12,2) NOT NULL DEFAULT 300;
ALTER TABLE dairy.setting ADD COLUMN IF NOT EXISTS surplus_min_kg_coop       numeric(12,2) NOT NULL DEFAULT 500;
ALTER TABLE dairy.setting ADD COLUMN IF NOT EXISTS transport_cost_per_ton_km numeric(10,2) NOT NULL DEFAULT 3;
ALTER TABLE dairy.setting ADD COLUMN IF NOT EXISTS processing_cost_per_kg    numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE dairy.setting ADD COLUMN IF NOT EXISTS surplus_min_price_per_kg  numeric(10,2) NOT NULL DEFAULT 0;

-- พิกัด (ใช้คำนวณระยะทางและค่าขนส่ง — ไม่มีพิกัด = ระบบบอกว่า "ค่าขนส่งยังไม่ทราบ")
ALTER TABLE dairy.collection_center ADD COLUMN IF NOT EXISTS lat numeric(9,6) CHECK (lat BETWEEN 5 AND 21);
ALTER TABLE dairy.collection_center ADD COLUMN IF NOT EXISTS lng numeric(9,6) CHECK (lng BETWEEN 97 AND 106);
ALTER TABLE dairy.processor_profile ADD COLUMN IF NOT EXISTS lat numeric(9,6) CHECK (lat BETWEEN 5 AND 21);
ALTER TABLE dairy.processor_profile ADD COLUMN IF NOT EXISTS lng numeric(9,6) CHECK (lng BETWEEN 97 AND 106);

-- ---------------------------------------------------------------------------
-- กรณีนมเกิน
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dairy.surplus_case (
  case_id           uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id       uuid NOT NULL REFERENCES identity.organization(org_id),
  center_id         uuid REFERENCES dairy.collection_center(center_id),
  horizon           text NOT NULL CHECK (horizon IN ('today', '7d', '30d', '60d', '90d')),
  scope             text NOT NULL CHECK (scope IN ('center', 'coop')),
  status            text NOT NULL DEFAULT 'Open'
                    CHECK (status IN ('Open', 'Acting', 'Resolved', 'Escalated', 'Cleared', 'Dismissed')),
  alert_level       text NOT NULL CHECK (alert_level IN ('yellow', 'orange', 'red')),
  expected_kg_day   numeric(12,2) NOT NULL,
  capacity_kg_day   numeric(12,2) NOT NULL,
  surplus_kg_day    numeric(12,2) NOT NULL CHECK (surplus_kg_day > 0),
  surplus_pct       numeric(8,2),
  days              smallint NOT NULL CHECK (days BETWEEN 1 AND 90),
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  deadline_at       timestamptz NOT NULL,
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at  timestamptz NOT NULL DEFAULT now(),
  handled_kg        numeric(12,2) NOT NULL DEFAULT 0 CHECK (handled_kg >= 0),
  discarded_kg      numeric(12,2) NOT NULL DEFAULT 0 CHECK (discarded_kg >= 0),
  discard_reason    text,
  outcome_note      text,
  shared_with_gov   boolean NOT NULL DEFAULT false,
  escalated_at      timestamptz,
  escalation_note   text,
  closed_at         timestamptz,
  closed_by         text,
  CHECK (discarded_kg = 0 OR discard_reason IS NOT NULL),
  CHECK ((scope = 'center') = (center_id IS NOT NULL))
);
-- กรณีที่ยังเปิดอยู่ มีได้หนึ่งกรณีต่อ (สหกรณ์, ศูนย์, ช่วงเวลา) — สแกนซ้ำจะอัปเดตกรณีเดิม
CREATE UNIQUE INDEX IF NOT EXISTS uq_dairy_surplus_case_active
  ON dairy.surplus_case (coop_org_id, COALESCE(center_id, '00000000-0000-0000-0000-000000000000'::uuid), horizon)
  WHERE status IN ('Open', 'Acting', 'Escalated');
CREATE INDEX IF NOT EXISTS idx_dairy_surplus_case_coop ON dairy.surplus_case (coop_org_id, status, first_detected_at DESC);

-- ทางเลือกแก้ไขที่ระบบแนะนำ (อันดับ 1-3 + ทางเลือกสำรอง)
CREATE TABLE IF NOT EXISTS dairy.surplus_option (
  option_id         uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  case_id           uuid NOT NULL REFERENCES dairy.surplus_case(case_id) ON DELETE CASCADE,
  rank              smallint NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('buyer_extra', 'transfer_center', 'processor_match', 'directory_buyer',
                                                  'own_plant', 'herd_plan', 'gov_help')),
  target_type       text,
  target_id         uuid,
  target_name       text,
  kg_per_day        numeric(12,2) NOT NULL CHECK (kg_per_day >= 0),
  days              smallint NOT NULL,
  price_per_kg      numeric(10,2),
  transport_per_kg  numeric(10,2),
  processing_per_kg numeric(10,2),
  net_per_kg        numeric(10,2),
  distance_km       numeric(8,1),
  lead_hours        smallint NOT NULL,
  feasible          boolean NOT NULL,
  reasons           jsonb NOT NULL DEFAULT '[]'::jsonb,
  status            text NOT NULL DEFAULT 'Suggested' CHECK (status IN ('Suggested', 'Approved', 'Rejected', 'Done', 'Failed')),
  decided_by        text,
  decided_at        timestamptz,
  offer_id          uuid REFERENCES dairy.surplus_offer(offer_id),
  proposal_id       uuid REFERENCES dairy.surplus_proposal(proposal_id),
  outcome_kg        numeric(12,2) CHECK (outcome_kg >= 0),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dairy_surplus_option_case ON dairy.surplus_option (case_id, rank);

-- บันทึกทุกการกระทำกับกรณี (ใครทำอะไรเมื่อไร)
CREATE TABLE IF NOT EXISTS dairy.surplus_case_log (
  log_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  case_id     uuid NOT NULL REFERENCES dairy.surplus_case(case_id) ON DELETE CASCADE,
  action      text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dairy_surplus_log_case ON dairy.surplus_case_log (case_id, created_at);

COMMENT ON TABLE dairy.surplus_case IS 'กรณีนมเกินกำลังรับซื้อ (ศูนย์/สหกรณ์ × วันนี้/7/30/60/90 วัน) ที่ระบบตรวจพบ — ไม่มี RLS กรองด้วย coop_org_id';
COMMENT ON TABLE dairy.surplus_option IS 'ทางเลือกแก้ไขที่ระบบแนะนำต่อกรณี จัดอันดับด้วยรายได้สุทธิ — สหกรณ์อนุมัติเอง';

GRANT SELECT, INSERT, UPDATE, DELETE ON dairy.surplus_case, dairy.surplus_option, dairy.surplus_case_log TO agrolink_app;
