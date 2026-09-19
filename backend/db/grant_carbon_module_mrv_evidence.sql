-- AgroLink Platform — Carbon Module, Phase 2 (MRV Data Room + เตรียมยื่น
-- T-VER) — ตามเอกสารออกแบบที่ผู้ใช้ยืนยันแล้ว ("ออกแบบ Carbon Module —
-- สหกรณ์ / วิสาหกิจชุมชน / กองทุนหมู่บ้าน", หัวข้อ "แผนพัฒนาเป็นเฟส" > เฟส 2)
--
-- ขอบเขตเฟส 2 (3 ข้อตามเอกสาร):
--   1. carbon.vvb_evidence + หน้าจัดเก็บเอกสาร (ภาพถ่าย/ภาพดาวเทียม, GIS
--      ขอบเขตแปลง, เอกสารรับรอง) — ตารางนี้เท่านั้นที่เป็นของใหม่ในไฟล์นี้
--   2. สถานะโครงการ mrv_prep → submitted_to_tver → registered — CHECK
--      constraint ของ carbon.carbon_project.status มีค่าเหล่านี้ครบอยู่แล้ว
--      ตั้งแต่เฟส 1 (grant_carbon_module_portal_aggregation.sql) ไม่ต้องแก้
--      อะไรเพิ่มในไฟล์นี้ — เฟส 2 แค่ทำให้สถานะเหล่านี้ "มีความหมายจริง" ผ่าน
--      evidence + export ด้านล่าง
--   3. Export ชุดเอกสาร — ไม่มีตารางใหม่ (แค่ endpoint อ่านข้อมูลรวมที่มีอยู่
--      แล้วประกอบเป็น manifest ให้ดาวน์โหลด) ดู backend/src/lib/
--      carbonAggregation.js + 3 route files
--
-- Design decision: ไฟล์จริง (รูปถ่าย/ภาพดาวเทียม/เอกสารรับรอง) ไม่ได้คิดค้น
-- ระบบเก็บไฟล์ใหม่ — ใช้ storage.file_object ที่มีอยู่แล้ว (grant_object_
-- storage.sql, subject-type agnostic, มี allowlist jpeg/png/webp/pdf และ
-- แคป 5MB อยู่แล้วที่ backend/src/routes/storage.js) ผ่าน POST /storage/
-- upload เดิม แล้วค่อยเอา file_id ที่ได้มาผูกกับแถวใน carbon.vvb_evidence
-- นี้อีกที (รูปแบบเดียวกับที่ registry.cooperative_profile.registration_
-- document_file_id ทำอยู่แล้ว) — ข้อมูลขอบเขตแปลง (GIS) เป็นข้อความ/
-- พิกัด/GeoJSON ที่พิมพ์ตรงๆ ลงคอลัมน์ geo_data แทนการอัปโหลดไฟล์ เพราะ
-- ประเภทไฟล์ GIS มาตรฐาน (.geojson/.kml/.shp) ไม่อยู่ใน allowlist ของ
-- storage.js — เพิ่ม allowlist ที่นั่นจะกระทบทุกโมดูลที่ใช้ระบบไฟล์ร่วมกัน
-- โดยไม่จำเป็น ในเมื่อเก็บเป็นข้อความก็เพียงพอสำหรับรอบนี้
--
-- Security: บังคับว่า file_id ที่แนบต้องเป็นไฟล์ที่องค์กรเดียวกันนี้เป็น
-- คนอัปโหลดเองเท่านั้น (กันไม่ให้อ้าง file_id ของคนอื่น) — เช็คที่ชั้น
-- แอปพลิเคชัน (backend/src/lib/carbonAggregation.js) ไม่ใช่ DB constraint
-- (join ข้าม schema เป็น CHECK ไม่ได้อยู่แล้ว) ตามธรรมเนียม "explicit WHERE
-- clause IS the security boundary" เดิมของโค้ดฐานนี้

CREATE TABLE IF NOT EXISTS carbon.vvb_evidence (
  evidence_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id uuid NOT NULL REFERENCES carbon.carbon_project(project_id) ON DELETE CASCADE,
  evidence_type text NOT NULL,
  title text NOT NULL,
  file_id uuid REFERENCES storage.file_object(file_id),
  geo_data text,
  note text,
  uploaded_by_subject_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vvb_evidence_type_check
    CHECK (evidence_type IN ('satellite_image', 'gis_boundary', 'certification_document', 'other')),
  CONSTRAINT vvb_evidence_shape_check CHECK (file_id IS NOT NULL OR geo_data IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_vvb_evidence_project ON carbon.vvb_evidence (project_id, created_at);

-- DELETE ได้ (ไม่ใช่ "immutable" แบบ storage.file_object เอง) — ที่ลบได้คือ
-- แค่แถวอ้างอิงในตารางนี้ (ไม่ได้ลบไฟล์จริงใน storage.file_object) ใช้ตอน
-- แนบไฟล์ผิดแล้วอยากถอดออกก่อนส่งออกจริง — backend บังคับให้ลบได้เฉพาะตอน
-- โครงการยังอยู่สถานะ draft/mrv_prep เท่านั้น (ดู EVIDENCE_EDITABLE_STATUSES
-- ใน carbonAggregation.js)
GRANT SELECT, INSERT, DELETE ON carbon.vvb_evidence TO agrolink_app;
