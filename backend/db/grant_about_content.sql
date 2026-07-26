-- AgroLink -- "เกี่ยวกับเรา" (About Us) public content management.
--
-- New, additive schema: content.about_section. Holds free-text sections
-- that render on the public frontend/about.html page (no auth, GET /about),
-- and are fully editable by Platform Ops through
-- GET/POST/PUT/DELETE /admin/about-sections (see routes/admin.js). This is
-- the FIRST schema in the project with no upstream org_id/farmer_id
-- ownership boundary at all -- it's platform-wide marketing copy, not a
-- per-actor resource, so there's no RLS and no WHERE-clause ownership
-- filter to worry about (unlike every other marketplace.* table).
--
-- Seeded with starter copy for the platform intro plus every existing
-- service category (Lender/Buyer/InputSupplier/Machinery/MarketVenue/
-- Logistics) so the admin form opens with real, editable content on day
-- one, instead of an empty screen with nothing to click "edit" on. The
-- seed INSERT is guarded by "only if the table is currently empty" (rather
-- than ON CONFLICT DO NOTHING against no real unique key) so re-running
-- this script after an admin has already edited/added/deleted content
-- never duplicates or resurrects rows -- additive and idempotent, same as
-- every other grant_*.sql in this project.

CREATE SCHEMA IF NOT EXISTS content;

CREATE TABLE IF NOT EXISTS content.about_section (
  section_id    SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_about_section_browse
  ON content.about_section (display_order)
  WHERE is_active = true;

GRANT USAGE ON SCHEMA content TO agrolink_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON content.about_section TO agrolink_app;
GRANT USAGE, SELECT ON SEQUENCE content.about_section_section_id_seq TO agrolink_app;

INSERT INTO content.about_section (title, body, display_order)
SELECT * FROM (VALUES
  ('เกี่ยวกับ AgroLink',
   'AgroLink คือแพลตฟอร์มบริการครบวงจรและสินเชื่อเชื่อมโยง สำหรับเกษตรกรไทยทุกแปลง เชื่อมทุกฝ่ายที่เกี่ยวข้องในห่วงโซ่การผลิต — เกษตรกร ผู้ให้บริการ ผู้ให้สินเชื่อ และผู้รับซื้อ — ไว้บนแพลตฟอร์มเดียว โปร่งใส ตรวจสอบได้ และเป็นธรรมกับทุกฝ่าย',
   0::int),
  ('ผู้ปล่อยกู้ (Lender)',
   'ธนาคาร สหกรณ์ และกองทุนหมู่บ้าน สามารถปล่อยสินเชื่อให้เกษตรกรผ่านระบบเบิกจ่ายเป็นงวดที่ตรวจสอบได้จริง ลดความเสี่ยงจากการผิดนัดชำระ พร้อมข้อมูลแปลงและสถานะการผลิตแบบเรียลไทม์',
   20::int),
  ('ผู้รับซื้อผลผลิต (Buyer)',
   'ท่าข้าว โรงสี และโรงงานแปรรูป รับซื้อผลผลิตจากเกษตรกรที่ขึ้นทะเบียนในระบบ พร้อมข้อมูลตรวจสอบย้อนกลับ (Traceability) ครบถ้วนตั้งแต่แปลงจนถึงจุดรับซื้อ',
   30::int),
  ('ผู้จำหน่ายปัจจัยการผลิต (Input Supplier)',
   'ร้านค้าและผู้จำหน่ายปุ๋ย เมล็ดพันธุ์ และปัจจัยการผลิตอื่นๆ เข้าถึงเกษตรกรลูกค้าโดยตรงผ่านเครือข่ายที่ผ่านการตรวจสอบแล้ว',
   40::int),
  ('บริการเครื่องจักรกลการเกษตร',
   'บริการรถไถ โดรนฉีดพ่นสารเคมี รถเกี่ยวข้าว รถบรรทุก และลานตากข้าว รับงานจับคู่กับเกษตรกรที่ต้องการใช้บริการในพื้นที่และช่วงเวลาที่ต้องการ',
   50::int),
  ('หาที่ขายสินค้า (สถานที่จำหน่าย)',
   'เกษตรกร สหกรณ์ และวิสาหกิจชุมชน ค้นหาและจองพื้นที่จำหน่ายสินค้า เช่น ตลาดค้าส่ง ตลาดสด หรือลานตลาดนัด โดยเฉพาะในช่วงผลผลิตล้นตลาดราคาตกต่ำ ติดต่อและจ่ายค่าบริการโดยตรงกับเจ้าของสถานที่',
   60::int),
  ('โลจิสติกส์ / ขนส่ง',
   'ผู้ให้บริการขนส่งทั่วไป เชื่อมต่อกับเกษตรกรและผู้ประกอบการในระบบเพื่อรองรับการขนย้ายผลผลิตและสินค้าเกษตร',
   70::int)
) AS seed(title, body, display_order)
WHERE NOT EXISTS (SELECT 1 FROM content.about_section);
