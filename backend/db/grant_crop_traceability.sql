-- AgroLink -- ตรวจสอบย้อนกลับสายพืชผล (Crop Traceability)
--   รหัสติดตามที่อ่านง่ายและเดาไม่ได้บนล็อตรวบรวม (LT-) รอบแปรรูป (PB-) และสินค้าสำเร็จรูป (FG-)
--   ใช้ค้นสายทั้งหมด: แปลง/สมาชิก → การส่งผลผลิต → ล็อต → คลัง/อบแห้ง → แปรรูป → สินค้า → นำออก/ขนส่ง (และย้อนกลับ)
--   QR บนบรรจุภัณฑ์ชี้ไปหน้าสาธารณะ trace.html?c=รหัส — แสดงเฉพาะข้อมูลที่ไม่ระบุตัวบุคคล
--   สหกรณ์ปิดหน้าสาธารณะรายล็อต/รายสินค้าได้ (public_trace = false)
--
-- รันหลัง grant_cooperative_collection_station.sql, grant_cooperative_warehouse.sql,
--          grant_cooperative_processing.sql, grant_cooperative_logistics.sql · รันซ้ำได้
-- ============================================================================
SET client_min_messages = warning;

-- 8 ตัวอักษร Crockford base32 (ไม่มี I L O U) = 32^8 ≈ 1.1 ล้านล้านแบบ — สุ่มเดาไม่ได้ในทางปฏิบัติ
CREATE OR REPLACE FUNCTION traceability.new_trace_code(p_prefix text) RETURNS text
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  b bytea := decode(replace(public.uuid_generate_v4()::text, '-', ''), 'hex');
  out text := p_prefix || '-';
  i int;
BEGIN
  -- ข้ามไบต์ที่ 6 และ 8 ของ UUID v4 (มีบิตเวอร์ชัน/variant คงที่)
  FOREACH i IN ARRAY ARRAY[0, 1, 2, 3, 4, 5, 9, 10] LOOP
    out := out || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
  END LOOP;
  RETURN out;
END;
$$;

ALTER TABLE produce.lot              ADD COLUMN IF NOT EXISTS trace_code text;
ALTER TABLE produce.lot              ADD COLUMN IF NOT EXISTS public_trace boolean NOT NULL DEFAULT true;
ALTER TABLE processing.batch         ADD COLUMN IF NOT EXISTS trace_code text;
ALTER TABLE processing.finished_good ADD COLUMN IF NOT EXISTS trace_code text;
ALTER TABLE processing.finished_good ADD COLUMN IF NOT EXISTS public_trace boolean NOT NULL DEFAULT true;

-- เติมรหัสให้ข้อมูลเดิม
UPDATE produce.lot SET trace_code = traceability.new_trace_code('LT') WHERE trace_code IS NULL;
UPDATE processing.batch SET trace_code = traceability.new_trace_code('PB') WHERE trace_code IS NULL;
UPDATE processing.finished_good SET trace_code = traceability.new_trace_code('FG') WHERE trace_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_lot_trace_code ON produce.lot (trace_code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_batch_trace_code ON processing.batch (trace_code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_finished_good_trace_code ON processing.finished_good (trace_code);

-- รหัสใหม่ทุกแถวที่เพิ่ม (ทุกช่องทาง: หน้าเว็บ API นำเข้า)
CREATE OR REPLACE FUNCTION traceability.assign_trace_code() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.trace_code IS NULL THEN
    NEW.trace_code := traceability.new_trace_code(TG_ARGV[0]);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_lot_trace_code ON produce.lot;
CREATE TRIGGER trg_lot_trace_code BEFORE INSERT ON produce.lot FOR EACH ROW EXECUTE FUNCTION traceability.assign_trace_code('LT');
DROP TRIGGER IF EXISTS trg_batch_trace_code ON processing.batch;
CREATE TRIGGER trg_batch_trace_code BEFORE INSERT ON processing.batch FOR EACH ROW EXECUTE FUNCTION traceability.assign_trace_code('PB');
DROP TRIGGER IF EXISTS trg_finished_good_trace_code ON processing.finished_good;
CREATE TRIGGER trg_finished_good_trace_code BEFORE INSERT ON processing.finished_good FOR EACH ROW EXECUTE FUNCTION traceability.assign_trace_code('FG');

ALTER TABLE produce.lot ALTER COLUMN trace_code SET NOT NULL;
ALTER TABLE processing.batch ALTER COLUMN trace_code SET NOT NULL;
ALTER TABLE processing.finished_good ALTER COLUMN trace_code SET NOT NULL;

-- จำนวนครั้งที่มีผู้สแกน/เปิดหน้าสาธารณะ (ไม่เก็บข้อมูลผู้สแกน)
CREATE TABLE IF NOT EXISTS traceability.public_scan (
  trace_code     text NOT NULL,
  scan_date      date NOT NULL,
  scans          int NOT NULL DEFAULT 0,
  PRIMARY KEY (trace_code, scan_date)
);

GRANT USAGE ON SCHEMA traceability TO agrolink_app;
GRANT EXECUTE ON FUNCTION traceability.new_trace_code(text), traceability.assign_trace_code() TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON traceability.public_scan TO agrolink_app;
GRANT UPDATE (public_trace) ON produce.lot, processing.finished_good TO agrolink_app;
