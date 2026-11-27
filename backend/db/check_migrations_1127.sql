-- ตรวจว่ารันไฟล์ migration 2 ไฟล์ล่าสุดบนฐานข้อมูลนี้แล้วหรือยัง (อ่านอย่างเดียว ไม่แก้ข้อมูล)
SELECT 'grant_dairy_import_trace.sql' AS migration,
       CASE WHEN to_regclass('dairy.data_import') IS NOT NULL AND to_regclass('dairy.milk_batch') IS NOT NULL
            THEN 'รันแล้ว' ELSE 'ยังไม่ได้รัน' END AS status
UNION ALL
SELECT 'grant_coop_lending_controls.sql',
       CASE WHEN to_regclass('coop_lending.agreement_tranche') IS NOT NULL AND to_regclass('coop_lending.lender_compliance') IS NOT NULL
                 AND to_regclass('coop_lending.golive_gate') IS NOT NULL
            THEN 'รันแล้ว' ELSE 'ยังไม่ได้รัน' END;
