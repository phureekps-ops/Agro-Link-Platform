-- AgroLink -- Gateway อุตสาหกรรมที่ศูนย์รับนม (แพลตฟอร์มบริหารโคนมแห่งชาติ).
--
-- Gateway หนึ่งเครื่องต่อศูนย์ อ่านค่าจาก 4 อุปกรณ์แล้วส่งขึ้น AgroLink ด้วยคีย์เดียว:
--   เครื่องชั่งนม (milk_scale)         → รับนมรายสมาชิกลงรอบของเวลาที่ชั่งจริง
--   ถังเย็น (cooling_tank)             → อุณหภูมิ + ปริมาณนมในถัง (เตือนเกินเกณฑ์)
--   เครื่องวิเคราะห์นม (milk_analyzer) → ไขมัน SNF โปรตีน แลคโตส ความหนาแน่น น้ำปน จุดเยือกแข็ง
--   ตัว gateway เอง (gateway)          → สัญญาณยังทำงาน (heartbeat) / เตือนเมื่อเงียบเกินกำหนด
--
-- อุปกรณ์ลูก (channel) ผูกกับ gateway ผ่าน gateway_id + channel — ไม่มีคีย์ของตัวเอง
-- ทุกเหตุการณ์จาก gateway มีรหัส (event_id) — ส่งซ้ำกี่ครั้งก็บันทึกครั้งเดียว (dairy.iot_event)
-- Gateway เก็บข้อมูลไว้ในเครื่องเมื่อเน็ตหลุด แล้วส่งย้อนหลังพร้อมเวลาที่วัดจริง
--
-- Security convention เหมือน grant_dairy_cooperative.sql: ไม่มี RLS, /dairy-iot ยืนยันด้วย
-- X-Device-Key (เก็บเฉพาะ sha256) และทุกอย่างอยู่ในขอบเขตสหกรณ์/ศูนย์ของ gateway นั้น
--
-- Idempotent: รันซ้ำได้. ต้องรันหลัง grant_dairy_cooperative.sql.
-- ============================================================================

ALTER TABLE dairy.iot_device DROP CONSTRAINT IF EXISTS iot_device_device_type_check;
ALTER TABLE dairy.iot_device ADD CONSTRAINT iot_device_device_type_check
  CHECK (device_type IN ('cooling_tank', 'milk_scale', 'vehicle', 'biogas', 'barn', 'gateway', 'milk_analyzer'));

ALTER TABLE dairy.iot_device ADD COLUMN IF NOT EXISTS gateway_id        uuid REFERENCES dairy.iot_device(device_id);
ALTER TABLE dairy.iot_device ADD COLUMN IF NOT EXISTS channel           text CHECK (channel IS NULL OR channel ~ '^[a-z0-9_-]{1,32}$');
ALTER TABLE dairy.iot_device ADD COLUMN IF NOT EXISTS offline_after_min smallint CHECK (offline_after_min IS NULL OR offline_after_min BETWEEN 2 AND 1440);
ALTER TABLE dairy.iot_device ADD COLUMN IF NOT EXISTS gateway_info      jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS uq_dairy_iot_channel ON dairy.iot_device (gateway_id, channel) WHERE gateway_id IS NOT NULL;

ALTER TABLE dairy.iot_alert DROP CONSTRAINT IF EXISTS iot_alert_alert_type_check;
ALTER TABLE dairy.iot_alert ADD CONSTRAINT iot_alert_alert_type_check
  CHECK (alert_type IN ('temp_low', 'temp_high', 'offline', 'milk_quality'));

ALTER TABLE dairy.milk_intake DROP CONSTRAINT IF EXISTS milk_intake_source_check;
ALTER TABLE dairy.milk_intake ADD CONSTRAINT milk_intake_source_check CHECK (source IN ('manual', 'scale', 'gateway'));

-- ใช้ผลเครื่องวิเคราะห์ที่ศูนย์ (ไขมัน/SNF/โปรตีน) คิดราคาค่านมด้วยหรือไม่ (ค่าเริ่ม = ไม่ใช้ ใช้ผลแล็บเหมือนเดิม)
ALTER TABLE dairy.setting ADD COLUMN IF NOT EXISTS analyzer_for_pricing boolean NOT NULL DEFAULT false;

-- เหตุการณ์ที่ gateway ส่งมา (กันบันทึกซ้ำเมื่อ gateway ส่งซ้ำตอนเน็ตกระตุก)
CREATE TABLE IF NOT EXISTS dairy.iot_event (
  device_id    uuid NOT NULL REFERENCES dairy.iot_device(device_id) ON DELETE CASCADE,
  event_id     text NOT NULL CHECK (event_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  event_type   text NOT NULL,
  measured_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL CHECK (status IN ('ok', 'error')),
  error        text,
  result       jsonb,
  PRIMARY KEY (device_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_dairy_iot_event_recv ON dairy.iot_event (device_id, received_at DESC);

-- ผลเครื่องวิเคราะห์น้ำนมที่ศูนย์ (รายตัวอย่าง)
CREATE TABLE IF NOT EXISTS dairy.milk_analysis (
  analysis_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id      uuid NOT NULL REFERENCES identity.organization(org_id),
  center_id        uuid REFERENCES dairy.collection_center(center_id),
  device_id        uuid NOT NULL REFERENCES dairy.iot_device(device_id),
  member_id        uuid REFERENCES dairy.member(member_id),
  round_id         uuid REFERENCES dairy.milk_round(round_id),
  sample_no        text,
  measured_at      timestamptz NOT NULL,
  fat_pct          numeric(5,2) CHECK (fat_pct IS NULL OR fat_pct BETWEEN 0 AND 20),
  snf_pct          numeric(5,2) CHECK (snf_pct IS NULL OR snf_pct BETWEEN 0 AND 20),
  protein_pct      numeric(5,2) CHECK (protein_pct IS NULL OR protein_pct BETWEEN 0 AND 20),
  lactose_pct      numeric(5,2) CHECK (lactose_pct IS NULL OR lactose_pct BETWEEN 0 AND 20),
  density          numeric(7,2),
  added_water_pct  numeric(5,2) CHECK (added_water_pct IS NULL OR added_water_pct BETWEEN 0 AND 100),
  freezing_point_c numeric(6,3),
  milk_temp_c      numeric(5,2),
  test_id          uuid REFERENCES dairy.quality_test(test_id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dairy_analysis_coop ON dairy.milk_analysis (coop_org_id, measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_dairy_analysis_member ON dairy.milk_analysis (member_id, measured_at DESC);

COMMENT ON TABLE dairy.iot_event IS 'เหตุการณ์จาก gateway ที่ศูนย์รับนม (รหัสเหตุการณ์ไม่ซ้ำต่อ gateway) — กันบันทึกซ้ำ';
COMMENT ON TABLE dairy.milk_analysis IS 'ผลเครื่องวิเคราะห์น้ำนมที่ศูนย์ — ไม่มี RLS กรองด้วย coop_org_id';

GRANT SELECT, INSERT, UPDATE, DELETE ON dairy.iot_event, dairy.milk_analysis TO agrolink_app;
