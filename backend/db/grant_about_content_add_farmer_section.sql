-- AgroLink -- Add a "เกษตรกร" (Farmer) section to the public "เกี่ยวกับเรา"
-- (About Us) content, right after the platform intro card and before the
-- "ผู้ปล่อยกู้ (Lender)" card.
--
-- content.about_section (see grant_about_content.sql) already renders in
-- display_order, and the original seed deliberately left gaps of 10-20
-- between rows (0, 20, 30, 40, 50, 60, 70) for exactly this kind of later
-- insertion -- this uses display_order = 10 to slot in between the
-- "เกี่ยวกับ AgroLink" row (0) and the "ผู้ปล่อยกู้ (Lender)" row (20)
-- without renumbering anything else.
--
-- Guarded by "only insert if no row with this exact title already exists"
-- so re-running this script (or re-running it after an admin has already
-- edited/reordered the row through a future admin UI) never duplicates it
-- -- additive and idempotent, same as every other grant_*.sql here.

INSERT INTO content.about_section (title, body, display_order)
SELECT
  'เกษตรกร',
  'เกษตรกรคือกระดูกสันหลังของชาติเป็นหน่วยการผลิตสินค้าอาหารหล่อเลี้ยงคนในชาติและยังสามารถส่งออกไปยังต่างประเทศได้อีกด้วย Agrolink Platform จัดตั้งขึ้นมาเพื่อยกระดับการบริหารจัดการธุรกิจแปลงเกษตรของเกษตรกรทุกขนาด และส่งเสริมให้หน่วยงานที่เกี่ยวข้องกับเกษตรกรมีความเข้มแข็งมากขึ้นมีการเชื่อมโยงข้อมูลที่เป็นปัจจุบันกระจายไปสู่หน่วยงานต้นสังกัดและภาครัฐเพื่อใช้บริหารจัดการให้มีประสิทธิภาพมากยิ่งขึ้น',
  10
WHERE NOT EXISTS (
  SELECT 1 FROM content.about_section WHERE title = 'เกษตรกร'
);
