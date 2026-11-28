-- สถานะ: OK = รันแล้ว · NOT RUN = ยังไม่ได้รัน
-- ตรวจว่ารัน migration 4 ไฟล์ของรอบ 28 พ.ย. บนฐานข้อมูลนี้แล้วหรือยัง (อ่านอย่างเดียว ไม่แก้ข้อมูล)
SELECT '1 grant_coop_registry.sql' AS migration,
       CASE WHEN to_regclass('registry.coop_directory') IS NOT NULL AND to_regclass('registry.coop_directory_claim') IS NOT NULL
            THEN 'OK' ELSE 'NOT RUN' END AS status
UNION ALL
SELECT '2 grant_crop_traceability.sql',
       CASE WHEN to_regclass('traceability.public_scan') IS NOT NULL
                 AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'produce' AND table_name = 'lot' AND column_name = 'trace_code')
            THEN 'OK' ELSE 'NOT RUN' END
UNION ALL
SELECT '3 grant_origin_certificate.sql',
       CASE WHEN to_regclass('traceability.origin_certificate') IS NOT NULL THEN 'OK' ELSE 'NOT RUN' END
UNION ALL
SELECT '4 grant_coop_lending_restructure.sql',
       CASE WHEN to_regclass('coop_lending.restructure_request') IS NOT NULL AND to_regclass('coop_lending.restructure_vote') IS NOT NULL
            THEN 'OK' ELSE 'NOT RUN' END
ORDER BY 1;
