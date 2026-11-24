-- ตรวจว่ามีข้อมูลให้หน้า "ตลาดปัจจัยการผลิต" และ "เช่า/จองบริการเครื่องจักรกล" แสดงหรือไม่ (อ่านอย่างเดียว ไม่แก้ข้อมูล)
-- รัน: psql "%DBURL%" -f backend\db\check_marketplace_data.sql
-- เกษตรกรจะเห็นผู้ให้บริการ/สินค้า ก็ต่อเมื่อ: องค์กรผ่าน KYB (Verified) + บทบาทผ่านการอนุมัติ (Verified) + มีรายการที่เปิดขาย/เปิดรับ

\echo '=== ตลาดปัจจัยการผลิต ==='
SELECT
  (SELECT COUNT(*) FROM identity.organization_role r WHERE r.role_type = 'InputSupplier')                       AS "ขอบทบาท",
  (SELECT COUNT(*) FROM identity.organization_role r WHERE r.role_type = 'InputSupplier' AND r.status = 'Verified') AS "อนุมัติแล้ว",
  (SELECT COUNT(*) FROM identity.organization o WHERE o.kyb_status = 'Verified' AND EXISTS (
     SELECT 1 FROM identity.organization_role r WHERE r.org_id = o.org_id AND r.role_type = 'InputSupplier' AND r.status = 'Verified')) AS "ร้านที่เห็นได้",
  (SELECT COUNT(*) FROM marketplace.product_listing p WHERE p.is_active)                                          AS "สินค้าเปิดขาย",
  (SELECT COUNT(*) FROM marketplace.product_listing p JOIN identity.organization o ON o.org_id = p.org_id
    WHERE p.is_active AND o.kyb_status = 'Verified' AND EXISTS (
     SELECT 1 FROM identity.organization_role r WHERE r.org_id = o.org_id AND r.role_type = 'InputSupplier' AND r.status = 'Verified')) AS "สินค้าที่เห็นได้";

\echo '=== เช่า/จองบริการเครื่องจักรกล ==='
SELECT
  (SELECT COUNT(*) FROM identity.organization_role r
    WHERE r.role_type IN ('MachineryService','TractorService','DroneService','HarvesterService','TruckService','DryingYardService'))  AS "ขอบทบาท",
  (SELECT COUNT(*) FROM identity.organization_role r
    WHERE r.role_type IN ('MachineryService','TractorService','DroneService','HarvesterService','TruckService','DryingYardService') AND r.status = 'Verified') AS "อนุมัติแล้ว",
  (SELECT COUNT(*) FROM marketplace.service_listing sl WHERE sl.is_active AND sl.service_key IS NOT NULL)          AS "บริการเปิดรับ",
  (SELECT COUNT(*) FROM marketplace.service_listing sl JOIN identity.organization o ON o.org_id = sl.org_id
    WHERE sl.is_active AND sl.service_key IS NOT NULL AND o.kyb_status = 'Verified' AND EXISTS (
     SELECT 1 FROM identity.organization_role r WHERE r.org_id = sl.org_id
        AND r.role_type IN ('MachineryService','TractorService','DroneService','HarvesterService','TruckService','DryingYardService') AND r.status = 'Verified')) AS "บริการที่เห็นได้";

\echo '=== องค์กรที่ขอบทบาทแล้วแต่ยังไม่ผ่าน (ชื่อ/ประเภท/สถานะเท่านั้น) ==='
SELECT o.org_name, r.role_type, o.kyb_status AS kyb, r.status AS role_status
  FROM identity.organization_role r JOIN identity.organization o ON o.org_id = r.org_id
 WHERE r.role_type IN ('InputSupplier','MachineryService','TractorService','DroneService','HarvesterService','TruckService','DryingYardService')
   AND (o.kyb_status <> 'Verified' OR r.status <> 'Verified')
 ORDER BY r.role_type, o.org_name LIMIT 30;
