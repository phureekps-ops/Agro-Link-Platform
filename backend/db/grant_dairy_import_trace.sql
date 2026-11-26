-- AgroLink -- นำเข้าข้อมูลน้ำนมจากไฟล์ + รหัสล็อตน้ำนม (Milk Batch ID) และการตรวจสอบย้อนกลับ ฟาร์ม → ศูนย์ → ถัง → รถ → โรงงาน
--
-- 1) นำเข้าไฟล์ (Excel .xlsx / CSV / JSON): ระบบอ่านไฟล์ → ตรวจทุกแถวด้วยกฎคุณภาพข้อมูลกลาง → แสดงตัวอย่าง (ผ่าน / เตือน / ผิด / ซ้ำ)
--    → ผู้ใช้กดยืนยัน → บันทึกเข้ารอบรับนมและผลตรวจคุณภาพ (source = 'file') พร้อมรหัสการนำเข้า ย้อนดูได้ว่าข้อมูลมาจากไฟล์ไหน
-- 2) ล็อตน้ำนม: ปิดรอบรับนมเมื่อใด รอบนั้นเข้าล็อตที่กำลังรวบรวมของศูนย์ (นมในถังเย็นระหว่างการส่งแต่ละเที่ยว)
--    บันทึกเที่ยวส่งนมจากศูนย์ → ล็อตปิดและผูกกับเที่ยวส่ง → โรงงานรับ/ปฏิเสธ → สถานะล็อตตาม
--    ทำด้วย trigger จึงใช้ได้กับทุกช่องทาง (หน้าเว็บ Gateway ไฟล์ และพอร์ทัลโรงงาน)
--
-- Security convention เหมือน grant_dairy_cooperative.sql: ไม่มี RLS ทุก query กรองด้วย coop_org_id
-- Idempotent: รันซ้ำได้ ไม่ลบข้อมูลเดิม. ต้องรันหลัง grant_dairy_cooperative.sql และ grant_dairy_iot_gateway.sql
-- ============================================================================
SET client_min_messages = warning;

-- ---------------------------------------------------------------------------
-- 1) การนำเข้าไฟล์
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dairy.data_import (
  import_id       uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id     uuid NOT NULL REFERENCES identity.organization(org_id),
  kind            text NOT NULL CHECK (kind IN ('intake', 'quality')),
  filename        text NOT NULL,
  file_format     text NOT NULL CHECK (file_format IN ('csv', 'xlsx', 'json')),
  file_sha256     text NOT NULL,
  row_count       int NOT NULL DEFAULT 0,
  ok_count        int NOT NULL DEFAULT 0,
  warning_count   int NOT NULL DEFAULT 0,
  error_count     int NOT NULL DEFAULT 0,
  duplicate_count int NOT NULL DEFAULT 0,
  rows            jsonb NOT NULL DEFAULT '[]'::jsonb,   -- แถวที่แปลงแล้ว + ผลตรวจรายแถว
  columns         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- หัวคอลัมน์ในไฟล์ → ฟิลด์ในระบบ
  status          text NOT NULL DEFAULT 'Previewed' CHECK (status IN ('Previewed', 'Committed', 'Discarded')),
  options         jsonb NOT NULL DEFAULT '{}'::jsonb,
  result          jsonb,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  committed_by    text,
  committed_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_dairy_import_coop ON dairy.data_import (coop_org_id, created_at DESC);

ALTER TABLE dairy.milk_intake DROP CONSTRAINT IF EXISTS milk_intake_source_check;
ALTER TABLE dairy.milk_intake ADD CONSTRAINT milk_intake_source_check CHECK (source IN ('manual', 'scale', 'gateway', 'file', 'api'));
ALTER TABLE dairy.milk_intake ADD COLUMN IF NOT EXISTS import_id uuid REFERENCES dairy.data_import(import_id);
ALTER TABLE dairy.quality_test ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE dairy.quality_test DROP CONSTRAINT IF EXISTS quality_test_source_check;
ALTER TABLE dairy.quality_test ADD CONSTRAINT quality_test_source_check CHECK (source IN ('manual', 'file', 'gateway', 'api'));
ALTER TABLE dairy.quality_test ADD COLUMN IF NOT EXISTS import_id uuid REFERENCES dairy.data_import(import_id);

-- ---------------------------------------------------------------------------
-- 2) ล็อตน้ำนม
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dairy.milk_batch (
  batch_id        uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id     uuid NOT NULL REFERENCES identity.organization(org_id),
  center_id       uuid NOT NULL REFERENCES dairy.collection_center(center_id),
  batch_code      text NOT NULL UNIQUE,                 -- MB-ปปดดวว(ค.ศ.)-รหัสศูนย์ 6 หลัก-ลำดับ
  status          text NOT NULL DEFAULT 'Collecting' CHECK (status IN ('Collecting', 'Shipped', 'Received', 'Rejected')),
  rounds          int NOT NULL DEFAULT 0,
  accepted_kg     numeric(12,2) NOT NULL DEFAULT 0,
  farm_count      int NOT NULL DEFAULT 0,
  first_round_date date,
  last_round_date date,
  shipment_id     uuid REFERENCES dairy.shipment(shipment_id),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  shipped_at      timestamptz,
  closed_at       timestamptz
);
CREATE INDEX IF NOT EXISTS idx_dairy_batch_center ON dairy.milk_batch (center_id, status, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_dairy_batch_coop ON dairy.milk_batch (coop_org_id, opened_at DESC);
-- ศูนย์หนึ่งมีล็อตที่กำลังรวบรวมได้ครั้งละหนึ่งล็อต
CREATE UNIQUE INDEX IF NOT EXISTS uq_dairy_batch_collecting ON dairy.milk_batch (center_id) WHERE status = 'Collecting';
ALTER TABLE dairy.milk_round ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES dairy.milk_batch(batch_id);
ALTER TABLE dairy.shipment ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES dairy.milk_batch(batch_id);
CREATE INDEX IF NOT EXISTS idx_dairy_round_batch ON dairy.milk_round (batch_id) WHERE batch_id IS NOT NULL;

-- ปิดรอบ → เข้าล็อตที่กำลังรวบรวมของศูนย์ (ไม่มีก็เปิดล็อตใหม่)
-- ยกเว้นรอบย้อนหลังที่ปิดช้า (วันที่รอบก่อนวันที่ศูนย์ส่งนมเที่ยวล่าสุด) → เข้าล็อตของเที่ยวส่งแรกหลังวันนั้น
-- เพราะนมของรอบนั้นออกจากถังไปกับเที่ยวนั้นแล้ว (หน้าตรวจสอบย้อนกลับจะแสดงว่า "บันทึกหลังส่ง")
CREATE OR REPLACE FUNCTION dairy.assign_round_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  b dairy.milk_batch%ROWTYPE;
  prefix text;
  seq int;
BEGIN
  SELECT * INTO b FROM dairy.milk_batch
   WHERE center_id = NEW.center_id AND status <> 'Collecting' AND shipped_at IS NOT NULL
     AND (shipped_at AT TIME ZONE 'Asia/Bangkok')::date > NEW.round_date
   ORDER BY shipped_at LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO b FROM dairy.milk_batch WHERE center_id = NEW.center_id AND status = 'Collecting' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    prefix := 'MB-' || to_char(NEW.round_date, 'YYMMDD') || '-' || upper(substr(replace(NEW.center_id::text, '-', ''), 1, 6)) || '-';
    SELECT COUNT(*) + 1 INTO seq FROM dairy.milk_batch WHERE batch_code LIKE prefix || '%';
    WHILE EXISTS (SELECT 1 FROM dairy.milk_batch WHERE batch_code = prefix || lpad(seq::text, 2, '0')) LOOP seq := seq + 1; END LOOP;
    INSERT INTO dairy.milk_batch (coop_org_id, center_id, batch_code, first_round_date)
    VALUES (NEW.coop_org_id, NEW.center_id, prefix || lpad(seq::text, 2, '0'), NEW.round_date)
    ON CONFLICT (center_id) WHERE status = 'Collecting' DO NOTHING;
    SELECT * INTO b FROM dairy.milk_batch WHERE center_id = NEW.center_id AND status = 'Collecting' FOR UPDATE;
  END IF;
  UPDATE dairy.milk_round SET batch_id = b.batch_id WHERE round_id = NEW.round_id;
  UPDATE dairy.milk_batch SET
    rounds = (SELECT COUNT(*) FROM dairy.milk_round WHERE batch_id = b.batch_id),
    accepted_kg = (SELECT COALESCE(SUM(accepted_kg), 0) FROM dairy.milk_round WHERE batch_id = b.batch_id),
    farm_count = (SELECT COUNT(DISTINCT i.member_id) FROM dairy.milk_intake i JOIN dairy.milk_round r ON r.round_id = i.round_id
                   WHERE r.batch_id = b.batch_id AND i.status = 'Accepted'),
    first_round_date = (SELECT MIN(round_date) FROM dairy.milk_round WHERE batch_id = b.batch_id),
    last_round_date = (SELECT MAX(round_date) FROM dairy.milk_round WHERE batch_id = b.batch_id)
  WHERE batch_id = b.batch_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_dairy_round_batch ON dairy.milk_round;
CREATE TRIGGER trg_dairy_round_batch AFTER UPDATE OF status ON dairy.milk_round
  FOR EACH ROW WHEN (OLD.status = 'Open' AND NEW.status = 'Closed') EXECUTE FUNCTION dairy.assign_round_batch();

-- เที่ยวส่งนมจากศูนย์ → ล็อตที่กำลังรวบรวมปิดและผูกกับเที่ยวส่ง
-- (BEFORE ผูก batch_id ให้เที่ยวส่ง, AFTER ปิดล็อต — ต้องรอให้แถว shipment มีอยู่ก่อนเพราะ milk_batch.shipment_id อ้างถึง)
CREATE OR REPLACE FUNCTION dairy.attach_shipment_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.center_id IS NOT NULL AND NEW.batch_id IS NULL THEN
    SELECT batch_id INTO NEW.batch_id FROM dairy.milk_batch WHERE center_id = NEW.center_id AND status = 'Collecting' FOR UPDATE;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_dairy_shipment_batch ON dairy.shipment;
CREATE TRIGGER trg_dairy_shipment_batch BEFORE INSERT ON dairy.shipment FOR EACH ROW EXECUTE FUNCTION dairy.attach_shipment_batch();

CREATE OR REPLACE FUNCTION dairy.ship_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE dairy.milk_batch SET status = 'Shipped', shipment_id = NEW.shipment_id, shipped_at = NEW.sent_at
   WHERE batch_id = NEW.batch_id AND status = 'Collecting';
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_dairy_shipment_batch_ship ON dairy.shipment;
CREATE TRIGGER trg_dairy_shipment_batch_ship AFTER INSERT ON dairy.shipment
  FOR EACH ROW WHEN (NEW.batch_id IS NOT NULL) EXECUTE FUNCTION dairy.ship_batch();

-- โรงงานรับ / ปฏิเสธ / ยกเลิกเที่ยวส่ง → สถานะล็อตตาม (ยกเลิก = ล็อตกลับไปรวบรวมต่อ ถ้ายังไม่มีล็อตใหม่ของศูนย์)
CREATE OR REPLACE FUNCTION dairy.sync_batch_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.batch_id IS NULL OR NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NEW.status = 'Received' THEN
    UPDATE dairy.milk_batch SET status = 'Received', closed_at = now() WHERE batch_id = NEW.batch_id;
  ELSIF NEW.status = 'Rejected' THEN
    UPDATE dairy.milk_batch SET status = 'Rejected', closed_at = now() WHERE batch_id = NEW.batch_id;
  ELSIF NEW.status = 'Cancelled' THEN
    IF NOT EXISTS (SELECT 1 FROM dairy.milk_batch WHERE center_id = NEW.center_id AND status = 'Collecting') THEN
      UPDATE dairy.milk_batch SET status = 'Collecting', shipment_id = NULL, shipped_at = NULL WHERE batch_id = NEW.batch_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_dairy_shipment_batch_status ON dairy.shipment;
CREATE TRIGGER trg_dairy_shipment_batch_status AFTER UPDATE OF status ON dairy.shipment FOR EACH ROW EXECUTE FUNCTION dairy.sync_batch_status();

COMMENT ON TABLE dairy.milk_batch IS 'ล็อตน้ำนม (นมในถังเย็นของศูนย์ระหว่างการส่งแต่ละเที่ยว) — ร้อยรายการรับนมรายฟาร์ม → รอบ → ถัง → เที่ยวส่ง → โรงงาน';
COMMENT ON TABLE dairy.data_import IS 'การนำเข้าข้อมูลน้ำนม/ผลคุณภาพจากไฟล์ พร้อมผลตรวจรายแถว';

GRANT SELECT, INSERT, UPDATE ON dairy.data_import, dairy.milk_batch TO agrolink_app;
