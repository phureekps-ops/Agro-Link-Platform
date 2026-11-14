-- AgroLink -- ให้ backend ลบค่า NDVI จาก Sentinel-2 ของช่วงเวลาที่กำลังดึงใหม่ได้
--
-- POST /admin/satellite-observations/sync-sentinel-series สร้างชุด NDVI ย้อนหลังของแปลงใหม่
-- ทั้งช่วง (ลบแถว sentinel2_optical/ndvi ของแปลงนั้นในช่วงวันที่ แล้วบันทึกใหม่) เพื่อไม่ให้ค่าจาก
-- รอบก่อนที่มีข้อผิดพลาด (เช่น ความละเอียด 10 องศาในรอบทดสอบแรก 14 พ.ย. 2569) ปนอยู่
-- backend ทำงานด้วย SET ROLE agrolink_app ซึ่งเดิมมีสิทธิ์แค่ SELECT/INSERT/UPDATE
-- รันซ้ำได้ ต้องรันหลัง grant_satellite_observation.sql
GRANT DELETE ON satellite.observation TO agrolink_app;
