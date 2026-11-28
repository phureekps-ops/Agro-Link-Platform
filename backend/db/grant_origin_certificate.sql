-- AgroLink -- ใบรับรองแหล่งที่มา (Certificate of Origin) ต่อสินค้าสำเร็จรูป (FG-) หรือล็อตรวบรวม (LT-)
--   สหกรณ์ออกใบรับรองจากหน้าตรวจสอบย้อนกลับ → ระบบเก็บ "ภาพนิ่ง" ของข้อมูล ณ วันออก (ไม่มีข้อมูลส่วนบุคคล)
--   + SHA-256 ของข้อมูลนั้น + SHA-256 ของใบก่อนหน้าของสหกรณ์เดียวกัน (ต่อกันเป็นสาย แก้ใบใดใบหนึ่งย้อนหลังจะเห็นได้)
--   ใบรับรองดาวน์โหลดเป็น PDF มี QR ไปหน้าตรวจสอบสาธารณะ certificate.html?no=OC-XXXXXXXX
--   ยกเลิกได้พร้อมเหตุผล (แสดงสถานะ "ยกเลิกแล้ว" ต่อสาธารณะ) — ไม่ลบ
--
-- รันหลัง grant_crop_traceability.sql · รันซ้ำได้
-- ============================================================================
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS traceability.origin_certificate (
  cert_id         uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  cert_no         text NOT NULL UNIQUE,
  org_id          uuid NOT NULL REFERENCES identity.organization(org_id),
  subject_type    text NOT NULL CHECK (subject_type IN ('lot', 'finished_good')),
  subject_id      uuid NOT NULL,
  trace_code      text NOT NULL,
  payload         jsonb NOT NULL,            -- ภาพนิ่งที่รับรอง (ไม่มีชื่อ รหัส หรือพิกัดของสมาชิก)
  payload_sha256  text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  prev_sha256     text CHECK (prev_sha256 IS NULL OR prev_sha256 ~ '^[0-9a-f]{64}$'),
  status          text NOT NULL DEFAULT 'Issued' CHECK (status IN ('Issued', 'Revoked')),
  issued_by       text NOT NULL,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  revoked_by      text,
  revoked_at      timestamptz,
  revoked_reason  text CHECK (revoked_reason IS NULL OR length(revoked_reason) BETWEEN 5 AND 500),
  CHECK ((status = 'Revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_origin_cert_subject ON traceability.origin_certificate (trace_code, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_origin_cert_org ON traceability.origin_certificate (org_id, issued_at DESC);

-- ข้อมูลที่รับรองแล้วแก้ไม่ได้ (เปลี่ยนได้เฉพาะสถานะยกเลิก)
CREATE OR REPLACE FUNCTION traceability.origin_certificate_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
     OR NEW.prev_sha256 IS DISTINCT FROM OLD.prev_sha256 OR NEW.cert_no IS DISTINCT FROM OLD.cert_no
     OR NEW.trace_code IS DISTINCT FROM OLD.trace_code OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'origin certificate % is immutable', OLD.cert_no USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'Revoked' AND NEW.status <> 'Revoked' THEN
    RAISE EXCEPTION 'revoked certificate % cannot be reinstated', OLD.cert_no USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_origin_certificate_immutable ON traceability.origin_certificate;
CREATE TRIGGER trg_origin_certificate_immutable BEFORE UPDATE ON traceability.origin_certificate
  FOR EACH ROW EXECUTE FUNCTION traceability.origin_certificate_immutable();

GRANT SELECT, INSERT, UPDATE ON traceability.origin_certificate TO agrolink_app;
GRANT EXECUTE ON FUNCTION traceability.origin_certificate_immutable() TO agrolink_app;
