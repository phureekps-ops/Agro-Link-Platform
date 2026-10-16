-- AgroLink -- P1/P4 (RAP-T readiness roadmap): production.stage_template
-- rows (ปฏิทินการผลิต) for the 8 commodity codes grant_rapt_commodity_
-- codes.sql just added (DURIAN, CORN_FEED, COFFEE, COCONUT_AROMATIC,
-- TILAPIA_CAGE, TILAPIA_RED_CAGE, SEABASS_CAGE, GROUPER_CAGE) -- closes the
-- gap the Gap Analysis report's ตารางที่ 1 called out by name ("ไม่มี
-- ปฏิทินการผลิต") for ทุเรียน/ข้าวโพดเลี้ยงสัตว์ specifically, and extends
-- the same coverage to the other 6 codes while at it.
--
-- Shape follows CASSAVA's 5-stage template (grant_stage_calendar_farmer.
-- sql) as asked -- 5 stages per commodity, same stage_seq/typical_offset_
-- days convention.
--
-- Deliberate departure from the CASSAVA/RICE_* template, explained so it
-- isn't mistaken for an oversight: those three commodities' stage 1 uses
-- stage_key='soil_test_fertilizer', which POST /farmer/crop-cycles/:id/
-- stages/:id/confirm (src/routes/stagecalendar.js) will not let a farmer
-- confirm until at least one production.fertilizer_formula_calc row
-- exists for that production unit -- which in turn requires a
-- production.crop_nutrient_requirement row for the commodity (grant_
-- fertilizer_formula.sql), seeded ONLY for RICE_JASMINE/RICE_PADDY/
-- CASSAVA. Reusing stage_key='soil_test_fertilizer' for any of these 8
-- new commodities would seed a stage that can never be confirmed -- a
-- permanent dead end in a farmer's production calendar, not a cosmetic
-- gap. So every stage below leaves stage_key NULL (an ordinary stage, no
-- special completion gate); a first stage covering soil/nutrition
-- preparation is still included for the 4 plant crops where it fits the
-- real cropping practice, just without the gate. Wiring ปุ๋ยสั่งตัด's
-- nutrient-requirement table to these commodities is separate follow-up
-- work (would need its own grant_fertilizer_formula_*.sql-style
-- migration with real agronomic figures, not folded into this one).
--
-- The 4 caged-fish commodities are NOT a planting cycle -- the 5 stages
-- for TILAPIA_CAGE/TILAPIA_RED_CAGE/SEABASS_CAGE/GROUPER_CAGE describe a
-- grow-out cycle instead (stock fingerlings -> nursery -> growth/feeding
-- -> size grading -> harvest), reusing the exact same production.
-- stage_template/stage_calendar/crop_cycle mechanism -- "crop_cycle" here
-- stands in for "grow-out cycle", same polymorphic reuse the table
-- already allows (it's keyed only by commodity_code + unit_id, nothing
-- plant-specific in the schema itself).
--
-- Same honesty caveat as every stage_template row that came before this
-- migration: typical_offset_days are rough, generic-knowledge placeholders
-- (public agronomy/aquaculture knowledge, not an official Department of
-- Agriculture cropping calendar or Department of Fisheries grow-out
-- schedule) -- see COMMENT ON TABLE production.stage_template.
--
-- Re-runnable, same convention as grant_stage_calendar_farmer.sql: deletes
-- existing rows for these 8 codes first, then re-inserts (stage_template
-- has no natural unique constraint to ON CONFLICT against).
-- ============================================================================

DELETE FROM production.stage_template
 WHERE commodity_code IN (
   'DURIAN', 'CORN_FEED', 'COFFEE', 'COCONUT_AROMATIC',
   'TILAPIA_CAGE', 'TILAPIA_RED_CAGE', 'SEABASS_CAGE', 'GROUPER_CAGE'
 );

INSERT INTO production.stage_template (commodity_code, stage_seq, stage_name, typical_offset_days, stage_key) VALUES
  -- ทุเรียน -- รอบต่อฤดูกาล (หลังเก็บเกี่ยวถึงเก็บเกี่ยวรอบถัดไป ~150 วัน)
  ('DURIAN', 1, 'ตัดแต่งกิ่งและใส่ปุ๋ยบำรุงต้นหลังเก็บเกี่ยว', 0,   NULL),
  ('DURIAN', 2, 'กระตุ้นการออกดอก (ราดสาร/งดน้ำ)',            30,  NULL),
  ('DURIAN', 3, 'ดอกบานและผสมเกสร',                          60,  NULL),
  ('DURIAN', 4, 'บำรุงผลและป้องกันโรค/แมลง',                  90,  NULL),
  ('DURIAN', 5, 'เก็บเกี่ยว',                                150, NULL),

  -- ข้าวโพดเลี้ยงสัตว์ -- รอบปลูกเดียว ~100 วัน
  ('CORN_FEED', 1, 'เตรียมดินและปลูก',                       0,   NULL),
  ('CORN_FEED', 2, 'ดูแลระยะต้นกล้า/ใส่ปุ๋ยครั้งแรก',          20,  NULL),
  ('CORN_FEED', 3, 'ใส่ปุ๋ยครั้งที่สอง/กำจัดวัชพืช',           40,  NULL),
  ('CORN_FEED', 4, 'ออกไหม/ผสมเกสร/ดูแลรักษา',                60,  NULL),
  ('CORN_FEED', 5, 'เก็บเกี่ยว',                              100, NULL),

  -- กาแฟ -- รอบต่อฤดูกาล (ตัดแต่งหลังเก็บเกี่ยวถึงเก็บเกี่ยวรอบถัดไป ~270 วัน)
  ('COFFEE', 1, 'ตัดแต่งกิ่งและใส่ปุ๋ยบำรุงต้นหลังเก็บเกี่ยว',  0,   NULL),
  ('COFFEE', 2, 'ออกดอก (หลังฝนแรก)',                        30,  NULL),
  ('COFFEE', 3, 'ติดผลและบำรุงผล',                           90,  NULL),
  ('COFFEE', 4, 'ผลเริ่มสุก/ทยอยเก็บ',                       240, NULL),
  ('COFFEE', 5, 'เก็บเกี่ยว',                                270, NULL),

  -- มะพร้าวน้ำหอม -- รอบต่อทะลาย (ผสมเกสรถึงเก็บเกี่ยว ~210 วัน)
  ('COCONUT_AROMATIC', 1, 'ดูแลต้นและใส่ปุ๋ยบำรุง',            0,   NULL),
  ('COCONUT_AROMATIC', 2, 'ออกจั่น/ดอก',                     40,  NULL),
  ('COCONUT_AROMATIC', 3, 'ติดผล/บำรุงผลอ่อน',                90,  NULL),
  ('COCONUT_AROMATIC', 4, 'ผลเจริญเติบโตเต็มที่ (รอน้ำหวานได้ที่)', 180, NULL),
  ('COCONUT_AROMATIC', 5, 'เก็บเกี่ยว',                      210, NULL),

  -- ปลานิลกระชัง -- รอบเลี้ยง ~120 วัน (โตเร็ว)
  ('TILAPIA_CAGE', 1, 'เตรียมกระชังและปล่อยลูกพันธุ์',         0,   NULL),
  ('TILAPIA_CAGE', 2, 'อนุบาลลูกปลาระยะแรก',                  20,  NULL),
  ('TILAPIA_CAGE', 3, 'ให้อาหารและดูแลระยะเจริญเติบโต',        60,  NULL),
  ('TILAPIA_CAGE', 4, 'คัดขนาด/ดูแลระยะใกล้จับ',               100, NULL),
  ('TILAPIA_CAGE', 5, 'จับขาย',                              120, NULL),

  -- ปลาทับทิมกระชัง -- รอบเลี้ยง ~180 วัน (เลี้ยงถึงไซส์ใหญ่กว่าปลานิล)
  ('TILAPIA_RED_CAGE', 1, 'เตรียมกระชังและปล่อยลูกพันธุ์',     0,   NULL),
  ('TILAPIA_RED_CAGE', 2, 'อนุบาลลูกปลาระยะแรก',               20,  NULL),
  ('TILAPIA_RED_CAGE', 3, 'ให้อาหารและดูแลระยะเจริญเติบโต',     90,  NULL),
  ('TILAPIA_RED_CAGE', 4, 'คัดขนาด/ดูแลระยะใกล้จับ',            150, NULL),
  ('TILAPIA_RED_CAGE', 5, 'จับขาย',                           180, NULL),

  -- ปลากระพงกระชัง -- รอบเลี้ยง ~240 วัน
  ('SEABASS_CAGE', 1, 'เตรียมกระชังและปล่อยลูกพันธุ์',         0,   NULL),
  ('SEABASS_CAGE', 2, 'อนุบาลลูกปลาระยะแรก',                  30,  NULL),
  ('SEABASS_CAGE', 3, 'ให้อาหารและดูแลระยะเจริญเติบโต',        120, NULL),
  ('SEABASS_CAGE', 4, 'คัดขนาด/ดูแลระยะใกล้จับ',               200, NULL),
  ('SEABASS_CAGE', 5, 'จับขาย',                              240, NULL),

  -- ปลาเก๋ากระชัง -- รอบเลี้ยง ~300 วัน (โตช้ากว่าชนิดอื่น)
  ('GROUPER_CAGE', 1, 'เตรียมกระชังและปล่อยลูกพันธุ์',         0,   NULL),
  ('GROUPER_CAGE', 2, 'อนุบาลลูกปลาระยะแรก',                  30,  NULL),
  ('GROUPER_CAGE', 3, 'ให้อาหารและดูแลระยะเจริญเติบโต',        150, NULL),
  ('GROUPER_CAGE', 4, 'คัดขนาด/ดูแลระยะใกล้จับ',               260, NULL),
  ('GROUPER_CAGE', 5, 'จับขาย',                              300, NULL);
