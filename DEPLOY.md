# คู่มือ Deploy AgroLink Platform ขึ้น Render.com

คู่มือนี้พาไปทีละขั้นตอนตั้งแต่สร้างบัญชี Render จนถึงมีเว็บที่ใช้งานได้จริงบนอินเทอร์เน็ต
เขียนไว้ให้ทำตามได้โดยไม่ต้องเดา — ทุกคำสั่งก็อปวางได้ทันที

**สิ่งที่ผมเตรียมไว้ให้แล้ว** (อยู่ในโค้ดที่ส่งไปพร้อมคู่มือนี้):
- แก้ backend ให้เชื่อมต่อฐานข้อมูลแบบที่ Render ใช้ได้ (`DATABASE_URL`)
- แก้ frontend ทั้ง 8 ไฟล์ให้สลับ URL ของ backend อัตโนมัติ ตามว่าเปิดจากเครื่อง local หรือจากเว็บจริง
- ไฟล์ `render.yaml` ที่บอก Render ว่าต้องสร้างอะไรบ้าง (ฐานข้อมูล + backend + frontend) ในคลิกเดียว
- ชุดสคริปต์ SQL ที่ทำให้สร้างฐานข้อมูลใหม่บน Render ได้ตั้งแต่ศูนย์ (เดิมทีระบบนี้ไม่มีไฟล์แบบนี้เลย — โครงสร้างฐานข้อมูลทั้งหมดมีอยู่แค่ในเครื่อง sandbox ของผมเท่านั้น ผมจึงต้อง export ออกมาเป็นไฟล์ก่อน รายละเอียดอยู่ในหัวข้อที่ 4)

**สิ่งที่คุณต้องทำเอง** (ต้องใช้บัญชี/บัตรของคุณเอง ผมช่วยทำแทนไม่ได้): สมัคร Render, เชื่อม GitHub, กดปุ่มใน Dashboard, และรันคำสั่ง SQL ไม่กี่คำสั่งบนเครื่องตัวเอง

---

## 0. ภาพรวมค่าใช้จ่าย

Render อนุญาตให้แต่ละบัญชีมีฐานข้อมูล Postgres แบบฟรีได้แค่ **1 ฐานข้อมูลเท่านั้น** — ถ้าบัญชีของคุณมีโปรเจกต์อื่นใช้ฐานข้อมูลฟรีอยู่แล้ว `agrolink-db` จะต้องใช้แผนเสียเงินแทน (`render.yaml` ตั้งไว้เป็น `basic-256mb` ให้แล้ว) ส่วน backend/frontend ยังเป็นแผนฟรีได้ตามปกติ:

| ส่วน | แผนที่ตั้งไว้ | ค่าใช้จ่าย/ข้อจำกัด |
|---|---|---|
| ฐานข้อมูล (agrolink-db) | `basic-256mb` | ประมาณ 6 ดอลลาร์/เดือน (คิดตามสัดส่วนเวลาที่ใช้จริงเป็นวินาที) — เหตุผลที่ไม่ใช้แผนฟรี: บัญชีนี้มีฐานข้อมูลฟรีของโปรเจกต์อื่นใช้อยู่แล้ว Render จำกัดไว้ 1 ฐานฟรีต่อบัญชี |
| Backend API (agrolink-backend) | `free` | ฟรีตลอดไป แต่ถ้าไม่มีคนเข้าใช้ 15 นาที ระบบจะ "หลับ" คำขอแรกหลังจากนั้นจะช้าประมาณ 1 นาที (แผนเสียเงินเริ่มต้น 7 ดอลลาร์/เดือน จะไม่หลับ) |
| Frontend (agrolink-frontend) | `free` | ฟรีตลอดไป ไม่มีข้อจำกัด ไม่มีอาการหลับ |

ถ้าภายหลังอยากยกเลิกฐานข้อมูลฟรีของโปรเจกต์อื่นแทน (เพื่อให้ `agrolink-db` ใช้แผนฟรีได้แทน) ทำได้จาก Render Dashboard → เลือกโปรเจกต์นั้น → ลบฐานข้อมูล แล้วแก้ `render.yaml` เปลี่ยน `plan: basic-256mb` กลับเป็น `plan: free` แจ้งผมได้ถ้าต้องการทำแบบนี้

Render บอกไว้ว่าบัญชีที่ไม่ได้ผูกบัตรเครดิตจะยังใช้แผนฟรีของ backend/frontend ได้ปกติ แต่แผนเสียเงินอย่างฐานข้อมูลนี้ต้องผูกบัตรเครดิตก่อนถึงจะสร้างได้

---

## 1. เตรียมโค้ดให้พร้อมก่อน

ก่อนเริ่มที่ Render ให้ทำตามนี้ก่อน:

1. รอให้ผมส่งไฟล์ทั้งหมดเข้าโฟลเดอร์โปรเจกต์ของคุณให้ครบ (ไฟล์ที่แก้/เพิ่มใหม่รอบนี้)
2. เปิด GitHub Desktop → จะเห็นไฟล์ที่เปลี่ยนแปลง → เขียนข้อความ commit (เช่น "เตรียมโค้ดสำหรับ deploy ขึ้น Render") → กด **Commit to main** → กด **Push origin**
3. เข้าไปดูใน GitHub.com ว่า repo ของคุณมีไฟล์ `render.yaml` อยู่ที่ root แล้ว (ไม่ได้อยู่ใน backend/ หรือ frontend/) — ถ้าเห็นแปลว่า push สำเร็จ

---

## 2. สร้างบัญชี Render และเชื่อม GitHub

1. ไปที่ https://render.com → **Get Started** → แนะนำให้เลือก **Sign up with GitHub** (เชื่อม GitHub ให้อัตโนมัติในขั้นตอนเดียว)
2. อนุญาตให้ Render เข้าถึง repo ของคุณ (เลือกได้ว่าจะให้เข้าถึงทุก repo หรือเลือกเฉพาะ repo ของ AgroLink — เลือกเฉพาะ repo นี้ก็พอ)

---

## 3. Deploy ด้วย Blueprint (สร้างทั้ง 3 ส่วนในคลิกเดียว)

1. ใน Render Dashboard กด **New +** (มุมขวาบน) → เลือก **Blueprint**
2. เลือก repo ของ AgroLink ที่เพิ่งเชื่อมไว้ → Render จะอ่านไฟล์ `render.yaml` ที่ root ของ repo อัตโนมัติ และแสดงรายการสิ่งที่จะสร้าง:
   - `agrolink-db` (ฐานข้อมูล Postgres)
   - `agrolink-backend` (Node API)
   - `agrolink-frontend` (เว็บหน้าบ้าน)
3. ตรวจดูว่าทั้ง 3 รายการแสดงแผน **Free** ตามที่ตั้งไว้ (แก้ทีหลังได้ ไม่ต้องกังวลตอนนี้)
4. กด **Apply** (หรือ **Create New Resources** แล้วแต่เวอร์ชันของหน้าจอ)
5. Render จะเริ่มสร้างทั้ง 3 ส่วนพร้อมกัน ใช้เวลาประมาณ 3-8 นาที ระหว่างรอ Render จะ:
   - สร้างฐานข้อมูลเปล่าๆ ขึ้นมาก่อน
   - สุ่มค่า `JWT_SECRET` และ `ADMIN_PASSCODE` ให้ backend อัตโนมัติ (ไม่ใช้ค่าที่เคยใช้ตอนพัฒนา)
   - เชื่อม `DATABASE_URL` ของ backend เข้ากับฐานข้อมูลที่เพิ่งสร้างให้อัตโนมัติ
   - build และ start backend กับ frontend

รอจนทั้ง 3 การ์ดในหน้า Dashboard ขึ้นสถานะ **Live** (สีเขียว) — ถ้าขึ้น **Deploy failed** สีแดง ให้กดเข้าไปดู Logs แล้วส่งข้อความ error มาให้ผมดูได้เลย

> ตอนนี้เว็บจะยังใช้งานไม่ได้ — เพราะฐานข้อมูลยังเป็นฐานเปล่า ไม่มีตาราง ไม่มีสิทธิ์การเข้าถึงใดๆ เลย ต้องรันสคริปต์ตั้งค่าในหัวข้อถัดไปก่อน

---

## 4. ทำไมต้องรันสคริปต์ตั้งค่าฐานข้อมูลเอง (อ่านสั้นๆ ก่อนเริ่ม)

ระบบนี้พัฒนาบน sandbox ของผมมาตลอด และโครงสร้างฐานข้อมูลทั้งหมด (ตาราง, สิทธิ์การเข้าถึง, กฎความปลอดภัยระดับแถว) มีอยู่จริงแค่ในเครื่อง sandbox — ไม่เคยถูกบันทึกเป็นไฟล์ตั้งแต่ต้นมาก่อน (มีแต่ไฟล์ "ส่วนต่อขยาย" ทีหลังๆ) ระหว่างเตรียมย้ายมา Render ผมจึงต้อง export โครงสร้างทั้งหมดออกมาเป็นไฟล์ SQL ชุดใหม่ (`00_roles.sql` ถึง `04_reference_data.sql` ในโฟลเดอร์ `backend/db/`) และ**ทดสอบ restore ใส่ฐานข้อมูลเปล่าจริงๆ จนทำงานได้ครบ** ก่อนส่งคู่มือนี้มาให้ — เพื่อให้มั่นใจว่าขั้นตอนด้านล่างนี้ใช้ได้จริง ไม่ใช่แค่เดาไว้

ฐานข้อมูลบน Render เป็นฐานเปล่า ต้องรันสคริปต์ 17 ไฟล์ตามลำดับ (ครั้งเดียว ก่อนเปิดใช้งานจริง) — ไฟล์เหล่านี้จะ**ไม่**ใส่ข้อมูลตัวอย่าง/ข้อมูลทดสอบใดๆ (เกษตรกรปลอม, องค์กรปลอม ฯลฯ) ลงไป มีแต่ข้อมูลอ้างอิงที่ระบบต้องใช้จริง (เช่น รายการชนิดข้าว, กฎการอนุมัติสินเชื่อ) — ผู้ใช้กลุ่มนำร่องจะเป็นคนแรกที่สมัครเข้าระบบจริงๆ

---

## 5. ติดตั้งเครื่องมือ psql บนเครื่อง Windows

ต้องใช้โปรแกรม `psql` รันคำสั่ง SQL จากเครื่องคุณไปที่ฐานข้อมูลบน Render:

1. ไปที่ https://www.postgresql.org/download/windows/ → กด **Download the installer** (จะพาไปหน้า EDB)
2. เลือกเวอร์ชัน **18** (ให้ตรงกับเวอร์ชันฐานข้อมูลบน Render) และ **Windows x86-64** แล้วดาวน์โหลด
3. รันตัวติดตั้ง — ระหว่างติดตั้ง หน้า **Select Components** จะติ๊กทุกอย่างไว้ให้แล้วก็ปล่อยไว้แบบนั้นได้เลย (ไม่ต้องเลือกเฉพาะ Command Line Tools ก็ได้ ติดตั้งทั้งชุดไม่มีปัญหา)
4. ติดตั้งจนจบ — ถ้ามีหน้าต่าง **Stack Builder** เด้งขึ้นมาหลังติดตั้งเสร็จ กด **Cancel** ปิดไปได้เลย (เป็นแค่ตัวเสริม ไม่จำเป็น)
5. โปรแกรมจะถูกติดตั้งไว้ที่ `C:\Program Files\PostgreSQL\18\bin\psql.exe` — **ใช้ path เต็มนี้แทนคำว่า `psql` เฉยๆ ในทุกคำสั่งด้านล่าง** (เครื่องหลายเครื่องไม่ได้ตั้งค่าให้พิมพ์แค่ `psql` เฉยๆ แล้วใช้งานได้ทันที ต้องใส่ path เต็มถึงจะชัวร์)

---

## 6. คัดลอก Connection String ของฐานข้อมูล

1. ใน Render Dashboard กดเข้า **agrolink-db**
2. หาปุ่ม **Connect** (มุมขวาบน) → เลือกแท็บ **External**
3. จะเห็นสองบรรทัด: **External Database URL** (ขึ้นต้นด้วย `postgresql://agrolink:...`) และ **PSQL Command** (ขึ้นต้นด้วย `render psql ...` — **อันนี้ไม่ต้องใช้** เพราะต้องติดตั้ง Render CLI แยกต่างหาก)
4. กดไอคอนคัดลอก (สี่เหลี่ยมซ้อนกัน) ข้างๆ **External Database URL** — คัดลอกทั้งเส้นเก็บไว้ จะใช้ซ้ำในหัวข้อถัดไป (URL จะมีลักษณะ `postgresql://agrolink:รหัสผ่านยาวๆ@dpg-xxxxx.singapore-postgres.render.com/ชื่อฐานข้อมูล_xxxx` — สังเกตว่าชื่อฐานข้อมูลท้ายสุดมักมีคำต่อท้ายสุ่มด้วย ไม่ใช่ `agrolink` เปล่าๆ)

---

## 7. รันสคริปต์ตั้งค่าฐานข้อมูล (48 ไฟล์ ตามลำดับ)

**แนะนำให้เตรียมคำสั่งใน Notepad หรือ Notepad++ ก่อน** แล้วค่อยคัดลอกไปวางรันใน Command Prompt ทีละบรรทัด (ป้องกันพิมพ์/วางผิดจากการแก้ไขตรงๆ ใน Command Prompt) วิธีทำละเอียด:

1. เปิด Command Prompt → `cd` ไปที่โฟลเดอร์ `backend\db`:
   ```
   cd "C:\Users\User\Documents\Agro-Link-Platform\Agro-Link-Platform\backend\db"
   ```
2. ตั้งค่าการเข้ารหัสตัวอักษรให้ถูกต้องก่อน (ป้องกัน error เรื่องภาษาไทยตอนรันไฟล์ที่มีข้อความไทย) — พิมพ์คำสั่งนี้แล้ว Enter (ไม่มีผลลัพธ์ขึ้นมา ปกติ):
   ```
   set PGCLIENTENCODING=UTF8
   ```
   **ค่านี้จะหายไปถ้าปิดหน้าต่าง Command Prompt แล้วเปิดใหม่ — ถ้าเปิดหน้าต่างใหม่ระหว่างทาง ต้องพิมพ์คำสั่งนี้ซ้ำอีกครั้งก่อนรันไฟล์ต่อ**
3. เปิด Notepad/Notepad++ พิมพ์:
   ```
   "C:\Program Files\PostgreSQL\18\bin\psql.exe" "" -f 00_roles.sql
   ```
4. วางเคอร์เซอร์ตรงกลางระหว่างเครื่องหมาย `""` คู่ที่สอง แล้ววาง **External Database URL** ที่คัดลอกจากขั้นตอนที่ 6 ลงไปตรงนั้น
5. เลือกทั้งบรรทัด (Ctrl+A) → คัดลอก (Ctrl+C) → กลับไป Command Prompt → คลิกขวา (วางอัตโนมัติ) → Enter
6. รอผลลัพธ์ — ไม่มีข้อความสีแดงขึ้นต้นด้วย `ERROR:` แปลว่าผ่าน (ข้อความสี "NOTICE" ที่บอกว่า "already exists, skipping" เป็นเรื่องปกติ ไม่ใช่ error)
7. รันไฟล์ถัดไป: กลับไปที่ Notepad/Notepad++ ใช้ **Find & Replace** (Ctrl+H ใน Notepad++) เปลี่ยนแค่ชื่อไฟล์ท้ายบรรทัดจากไฟล์ปัจจุบันเป็นไฟล์ถัดไปในรายการด้านล่าง แล้วคัดลอก-วาง-Enter ซ้ำแบบเดิม

รันไปตามลำดับนี้ (เปลี่ยนแค่ชื่อไฟล์ท้ายบรรทัด ส่วน URL ตรงกลางเหมือนเดิมทุกครั้ง):

```
00_roles.sql
01_extensions.sql
02_full_schema.sql
03_grant_schema_usage.sql
grant_farmer_portal_reads.sql
fix_submit_application_security.sql
grant_farmer_registration.sql
fix_underwriting_decision_security.sql
fix_produce_settlement_security.sql
grant_buyer_portal.sql
grant_platform_ops.sql
grant_provider_registration.sql
grant_machinery_marketplace.sql
grant_organization_roles.sql
grant_input_supplier_and_buy_prices.sql
grant_farmer_product_orders.sql
grant_market_venue_marketplace.sql
04_reference_data.sql
grant_about_content.sql
grant_admin_dashboard_views.sql
grant_machinery_booking.sql
grant_featured_listings.sql
grant_credit_model.sql
grant_fertilizer_formula.sql
grant_stage_calendar_farmer.sql
grant_fertilizer_mixing_service.sql
grant_fertilizer_mixing_group_order.sql
grant_carbon_awd.sql
grant_cooperative_tenant_foundation.sql
grant_cooperative_collection_station.sql
grant_cooperative_warehouse.sql
grant_cooperative_finance_dashboard.sql
grant_cooperative_processing.sql
grant_cooperative_logistics.sql
grant_cooperative_gov_gateway.sql
grant_staff_and_government_access.sql
grant_object_storage.sql
grant_analytics_warehouse.sql
grant_satellite_observation.sql
grant_cooperative_product_catalog.sql
grant_rfq_marketplace.sql
grant_b2b_commerce_engine.sql
grant_b2b_commerce_engine_phase3.sql
grant_farmer_360.sql
grant_machinery_service_consolidation.sql
grant_ledger_revenue_segregation.sql
grant_sealed_bid_auction.sql
grant_farmer_plot_registration.sql
grant_logistics_portal.sql
grant_group_buy.sql
grant_shrimp_auction.sql
grant_input_credit_line.sql
grant_straw_processing_service.sql
grant_laser_land_leveling_service.sql
grant_machinery_rental_service.sql
```

**เพิ่มเมื่อ 2026-08-29:** `grant_straw_processing_service.sql` — เพิ่ม
"เครื่องอัดเม็ดฟางข้าว" (straw_pelletizing) และ "เครื่องอัดก้อนฟางข้าว"
(straw_baling) เป็นรายการที่ 8-9 ในตารางราคาบริการเครื่องจักรกล (เดิมมี 7
รายการ) — ใช้โครงสร้างเดิมทั้งหมด (marketplace.service_listing /
marketplace.machinery_booking, ผู้ให้บริการกลุ่ม MachineryService/
TractorService/DroneService/HarvesterService/TruckService/DryingYardService
เดิม) แค่ขยาย CHECK constraint ของ service_type (เพิ่มหมวดใหม่
`straw_processing`) และ service_key เท่านั้น ไม่มีตารางใหม่ ไม่มี org_type ใหม่
ดูรายละเอียดที่คอมเมนต์หัวไฟล์ migration นี้เอง

**เพิ่มเมื่อ 2026-08-29 (frontend เท่านั้น ไม่มี migration):** ปรับโครงสร้าง
`frontend/admin/dashboard.html` ให้เป็น sidebar SPA หน้าเดียวแบบเดียวกับ
`frontend/coop/dashboard.html` (พอร์ทัลสหกรณ์) ตามคำขอของผู้ดูแลระบบ — รวม 6
หน้าที่เคยแยกกัน (`cooperatives.html`, `government-officers.html`,
`satellite-observations.html`, `featured-listings.html`, `group-buys.html`,
`capital-topup.html` พร้อม js คู่กันของแต่ละหน้า) เข้ามาเป็นแท็บ
`data-page-content` ภายในไฟล์เดียวและ `js/dashboard.js` ไฟล์เดียว — ยูทิลิตี
ที่ซ้ำกันทุกหน้าเดิม (`session`/`toast`/`escapeHtml`/`thaiDate`/
`thaiDateTime`) เหลือประกาศครั้งเดียว ส่วนตรรกะโหลดข้อมูลของแต่ละหน้าเดิมไม่
เปลี่ยนแปลง (โหลดพร้อมกันหมดตอนเปิดหน้า sidebar แค่ show/hide เท่านั้น
เหมือน coop dashboard) ไฟล์เดิมทั้ง 6 คู่ย้ายไปเก็บไว้ที่
`frontend/_to_delete/admin-pages-merged-into-dashboard-2026-08-29/` ไม่มีที่
ใดอ้างอิงไฟล์เดิมเหล่านี้แล้ว (`carbon-assessment-detail.html` ไม่ได้ย้าย —
ยังคงเป็นหน้าแยกที่เปิดแท็บใหม่จากคิว AWD ตามเดิม)

**เพิ่มเมื่อ 2026-08-29 (ค่ำ):** `grant_laser_land_leveling_service.sql` — เพิ่ม
"ปรับพื้นที่แปลงนาด้วยระบบเลเซอร์" (laser_land_leveling) เป็นรายการที่ 10
ในตารางราคาบริการเครื่องจักรกล (เดิมมี 9 รายการ) — เป็นบริการเตรียมดินแบบหนึ่ง
จึงใช้ service_type เดิมคือ `land_preparation` ที่มีอยู่แล้ว ไม่ต้องเพิ่มหมวดใหม่
ขยายแค่ CHECK constraint ของ service_key เท่านั้น (ไม่แตะ service_type) —
ไม่มีตารางใหม่ ไม่มี org_type ใหม่ ไม่มีการแก้ dropdown ตัวกรองใดๆ ในหน้าเว็บ
เพราะ `land_preparation` มีตัวเลือกตัวกรองอยู่แล้วทั้งฝั่งเกษตรกรและฝั่งแอดมิน
ดูรายละเอียดที่คอมเมนต์หัวไฟล์ migration นี้เอง

**เพิ่มเมื่อ 2026-08-29 (ดึกมาก, frontend+backend เท่านั้น ไม่มี migration):**
ตลาดปัจจัยการผลิต (`frontend/marketplace.html`) เพิ่มการกรองร้านค้าตามจังหวัด
ได้จริง — เดิมดรอปดาวน์ "จังหวัด" มีอยู่ในหน้าเว็บอยู่แล้วแต่เป็นแค่ UI เปล่าๆ
ไม่เคยเชื่อมกับอะไรเลย และฝั่ง backend เองก็ยังไม่เคยกรองตามจังหวัดจริง
(`GET /farmer/products` / `GET /farmer/input-suppliers` เพิ่ม query param
`province_code` ใหม่ในรอบนี้) นอกจากนี้ยังเพิ่มหน้า "พื้นที่ให้บริการ (จังหวัด)"
ในแดชบอร์ดผู้จำหน่ายปัจจัยการผลิต (`frontend/inputsupplier/dashboard.html`)
ให้ร้านค้าเลือกจังหวัดที่ให้บริการได้จริงเป็นครั้งแรก (เชื่อมกับ route
`GET`/`PUT /inputsupplier/service-regions` ที่มีอยู่แล้วแต่ไม่เคยมีหน้าเว็บใช้งาน
มาก่อน) — ใช้ระบบรหัสจังหวัดแบบ ISO 3166-2:TH เดิม (`frontend/js/
provinces.js`) ที่มีอยู่แล้ว **ไม่มีการเพิ่มระดับ "อำเภอ"** ในรอบนี้ เพราะไม่มี
ข้อมูลอำเภอ/ตารางอ้างอิงอำเภออยู่ในระบบเลยแม้แต่ฟีเจอร์เดียว (เป็นสโคปที่ใหญ่กว่า
มาก ต้องสร้างชุดข้อมูลอำเภอทั้งประเทศ ~900 อำเภอขึ้นมาใหม่ทั้งหมด) — ตกลงกับ
ผู้ใช้แล้วว่าทำแค่ระดับจังหวัดก่อนในรอบนี้ ไม่มี migration SQL ใดๆ เพราะ
`partner.vendor_profile.service_regions` เป็นคอลัมน์ที่มีอยู่แล้วตั้งแต่เดิม

**เพิ่มเมื่อ 2026-08-29 (ดึก):** `grant_machinery_rental_service.sql` — เพิ่ม
"ให้เช่าเครื่องจักรกลการเกษตร" (machinery_rental) เป็นรายการที่ 11
ในตารางราคาบริการเครื่องจักรกล (เดิมมี 10 รายการ) ราคาคิดเป็น บาท/วัน —
ต่างจากรายการอื่นตรงที่เป็นการ "ปล่อยเช่าตัวเครื่อง" เฉยๆ ไม่ใช่บริการแบบมี
คนขับ/ปฏิบัติงานให้เหมือนรายการอื่น จึงไม่เข้าพวกกับหมวด service_type ที่มีอยู่
ใดเลย เลยใช้หมวด `other` เดิมที่มีอยู่แล้วแทนการเพิ่มหมวดใหม่ — ขยายแค่ CHECK
constraint ของ service_key เท่านั้น ไม่มีตารางใหม่ ไม่มี org_type ใหม่ ไม่มีการ
แก้ dropdown ตัวกรองในหน้าเว็บ (ตัวเลือก "ทั้งหมด" เดิมก็แสดงรายการนี้อยู่แล้ว)
ดูรายละเอียดที่คอมเมนต์หัวไฟล์ migration นี้เอง

**เพิ่มเมื่อ 2026-08-27:** `grant_input_credit_line.sql` — เพิ่มฟีเจอร์ "เครดิต
ร้านค้าปัจจัยการผลิต" (Input-Supplier Trade Credit) ให้ผู้ให้กู้ (Lender) ที่ได้
อนุมัติวงเงินสินเชื่อหมุนเวียนล่วงหน้าให้เกษตรกรรายหนึ่งไว้แล้ว (`credit.
credit_line`) จ่ายเงินแทนเกษตรกรให้ผู้ขายปัจจัยการผลิตทันทีที่ผู้ขายยืนยัน
ออเดอร์ (หักค่าธรรมเนียมแพลตฟอร์ม 1.5% จากยอดที่ผู้ขายได้รับ ผ่านบัญชี
`fee_revenue`) แล้วให้เกษตรกรผ่อนชำระคืนผู้ให้กู้ทีหลังพร้อมดอกเบี้ยที่คิดจาก
จำนวนวันที่ค้างจริงต่อยอดที่เบิกแต่ละครั้ง (`credit.credit_drawdown`) — ถูกกว่า
การกู้เป็นก้อนเดียวเพราะดอกเบี้ยไม่คิดจากวงเงินทั้งก้อนหรือวันที่ยังไม่ได้ใช้เงิน
เพิ่มคอลัมน์ `payment_status` ให้ `marketplace.product_order` เป็นครั้งแรก
(ค่าเริ่มต้น `unpaid` — ออเดอร์ที่ไม่ได้ใช้เครดิตไลน์ยังคงจ่ายเงินกันเองนอกระบบ
เหมือนเดิมทุกประการ ไม่กระทบออเดอร์เก่า) **ต้องรันหลัง** `grant_b2b_commerce_
engine_phase3.sql` เท่านั้น (อ้างถึงตาราง `procurement.invoice` สำหรับช่องทาง
เบิกเครดิตผ่านใบแจ้งหนี้ที่ยังไม่ได้เปิดใช้งานในรอบนี้ — ดูคอมเมนต์หัวไฟล์)
**ข้อควรระวังก่อนใช้งานจริง:** ต้องมีบัญชี `ledger.account` ประเภท
`fee_revenue`/`platform` อยู่ในระบบก่อน ไม่งั้นฟังก์ชัน `credit.draw_credit_
for_order()` จะ error ตอนใช้งานจริง (ไม่ error ตอนรัน migration นี้) — ถ้ายังไม่มี
ให้รัน `INSERT INTO ledger.account (account_type, owner_type, currency)
VALUES ('fee_revenue', 'platform', 'THB');` เพิ่มอีกครั้งเดียว ดูรายละเอียด
เต็มที่คอมเมนต์หัวไฟล์ migration นี้เอง ฝั่งหน้าเว็บ (UI ให้ผู้ให้กู้ออกวงเงิน,
ปุ่ม "จ่ายด้วยเครดิต" ในหน้าออเดอร์เกษตรกร, และหน้าดูยอดค้างชำระ) ยังไม่ได้
สร้างในรอบนี้ — มีแค่ backend/API พร้อมใช้งาน

**เพิ่มเมื่อ 2026-08-25 (ค่ำ):** `grant_shrimp_auction.sql` — เพิ่มแกนหลักของ
"Auction Place" (ประมูลขายกุ้งสดแบบ Sealed-Bid) สร้าง schema ใหม่
`aquaculture` ทั้งหมด (`farm_profile`, `sampling_event`/`sampling_point` สำหรับ
สุ่มตรวจไซส์ก่อนประมูล, `shrimp_auction`, `auction_size_tier` สำหรับตาราง 5
ไซส์ที่ประมูลพร้อมกัน, `harvest_settlement` สำหรับคำนวณยอดชำระจริงวันจับ) และ
ตารางใหม่ `procurement.auction_bid_tier` (ราคาที่เสนอต่อไซส์ย่อยแต่ละไซส์ ภายใน
1 ประมูล) เป็นการเพิ่ม "โหมด Forward" (ผู้ขาย/เจ้าของบ่อเปิดประมูล ราคาวิ่งขึ้น)
ให้กลไกประมูลที่มีอยู่เดิมซึ่งเดิมรองรับแค่โหมด Reverse (ผู้ซื้อเปิด ราคาวิ่งลง)
รวมถึง `ALTER TABLE procurement.auction_bid ALTER COLUMN bid_price DROP NOT
NULL` (บิดโหมด Forward ประมูลเป็นตารางหลายไซส์ ไม่มีราคาเดียว จึงต้องเปิดให้
เป็น NULL ได้ — ปลอดภัยกับแถวโหมด Reverse เดิมเพราะ CHECK constraint มองว่า
NULL ผ่านเสมอ) **ต้องรันหลัง** `grant_rfq_marketplace.sql` และ
`grant_b2b_commerce_engine.sql` เท่านั้น (ALTER ตาราง `procurement.auction`/
`auction_bid` ที่ต้องมีอยู่ก่อน) ดูรายละเอียดสถาปัตยกรรมเต็มที่
`SHRIMP_AUCTION_ARCHITECTURE.md` ที่ root ของโปรเจกต์ ฝั่งหน้าเว็บมีหน้าใหม่
`frontend/auction-place.html`/`frontend/auction-intro.html` และหน้าใน
`frontend/shrimp-auction-farmer.html`/`frontend/buyer/shrimp-auction.html`

**เพิ่มเมื่อ 2026-08-25:** `grant_group_buy.sql` — เพิ่มฟีเจอร์ "รวมออเดอร์
ประมูลร่วมของสหกรณ์" (Group Buy) ให้หลายสหกรณ์รวมปริมาณความต้องการซื้อปัจจัย
การผลิต (เช่น แม่ปุ๋ย) เข้าด้วยกันก่อน แล้วให้ทีมงาน AgroLink แปลงยอดรวมเป็น
RFQ+e-Auction ก้อนเดียวให้ผู้จำหน่ายแข่งราคากัน — เป็น "ชั้นรวบรวมออเดอร์" ที่
วางไว้หน้าเส้นทาง RFQ→e-Auction→Contract→PO→GRN→Invoice→Payment เดิมทั้งหมด
(`grant_rfq_marketplace.sql`/`grant_b2b_commerce_engine.sql`/
`grant_b2b_commerce_engine_phase3.sql`) โดยไม่แก้โค้ด/ตารางเดิมแม้แต่บรรทัด
เดียว เพิ่มตารางใหม่ 4 ตาราง (`procurement.group_buy`,
`group_buy_participant`, `group_buy_settlement_plan`,
`group_buy_settlement_line`) และฟังก์ชันใหม่ 2 ตัวสำหรับแบ่งต้นทุนคืน
สหกรณ์หัวขบวนผ่าน `ledger.transfer_funds()` เดิม (รูปแบบเดียวกับฟังก์ชัน
กระจายรายได้ `procurement.distribute_revenue_share()` ใน
`grant_b2b_commerce_engine_phase3.sql` แค่กลับทิศทางเงิน) **ต้องรันหลัง**
`grant_rfq_marketplace.sql`, `grant_b2b_commerce_engine.sql`, และ
`grant_b2b_commerce_engine_phase3.sql` เท่านั้น (อ้างถึงตาราง
`procurement.rfq`/`auction`/`invoice` ที่ต้องมีอยู่ก่อน) รันเป็นไฟล์สุดท้าย
ในลำดับนี้ก็เพียงพอ ดูรายละเอียดสถาปัตยกรรมเต็มที่ `GROUP_BUY_ARCHITECTURE.md`
ที่ root ของโปรเจกต์ ฝั่งหน้าเว็บมีส่วนใหม่ "🤝 รวมออเดอร์ประมูลร่วม" ใน
`frontend/coop/dashboard.html` (เปิดรอบ/เข้าร่วม/ถอนตัว/แบ่งต้นทุนคืน) และ
หน้าแอดมินใหม่ `frontend/admin/group-buys.html` (เลือกสหกรณ์หัวขบวน + กด
แปลงเป็นประมูล — ทีมงาน AgroLink เป็นผู้ทำขั้นตอนนี้ ไม่ใช่สหกรณ์เอง)

**เพิ่มเมื่อ 2026-08-23 (บ่าย):** `grant_logistics_portal.sql` — สร้างพอร์ทัลใหม่
ให้องค์กรประเภท "Logistics" (โลจิสติกส์/ขนส่งทั่วไป) ที่สมัครสมาชิกเองผ่านหน้า
"สมัครเป็นผู้ให้บริการ" มาได้แล้วแต่ไม่เคยมีพอร์ทัลของตัวเองเลย (สมัครเสร็จได้แต่
หน้ายืนยัน "อยู่ระหว่างตรวจสอบ" เฉยๆ) — ก่อนหน้านี้ตาราง `logistics.carrier` ที่
สหกรณ์ใช้บันทึกผู้ขนส่ง (จาก `grant_cooperative_logistics.sql`) เป็นแค่ข้อมูลที่
สหกรณ์พิมพ์ชื่อเข้าไปเอง ไม่ได้ผูกกับบัญชีองค์กรจริงเลย ไฟล์นี้เพิ่มคอลัมน์
`linked_org_id` (nullable) ให้ผูกผู้ขนส่งกับบัญชีองค์กร Logistics จริงที่ผ่าน
KYB แล้วได้ (ฟังก์ชันใหม่ `logistics.link_carrier_org()` + parameter ใหม่บน
`logistics.create_carrier()`) และขยาย view `logistics.v_shipment_summary`
ให้กรองงานขนส่งตาม `linked_org_id` ได้ เป็น additive ล้วนๆ ไม่กระทบข้อมูล/
ฟีเจอร์เดิมของสหกรณ์ รันเป็นไฟล์สุดท้ายในลำดับนี้ก็เพียงพอ (ต้องรันหลัง
`grant_cooperative_logistics.sql` เท่านั้น เพราะแก้ตาราง/ฟังก์ชัน/view ที่ไฟล์นั้น
สร้างไว้ก่อน) ฝั่งหน้าเว็บมีพอร์ทัลใหม่ `frontend/logistics/` (login ด้วยรหัส
`oidc|org-...` เหมือนพอร์ทัลอื่น, แดชบอร์ดแสดงงานขนส่งที่ได้รับมอบหมาย พร้อม
ปุ่มบันทึกออกเดินทาง/หลักฐานการส่งมอบ/รายงานปัญหา) และหน้าแดชบอร์ดสหกรณ์
(`frontend/coop/dashboard.html`) มีฟอร์ม/ปุ่มใหม่สำหรับผูกผู้ขนส่งกับบัญชี
องค์กรขนส่งจริง

**เพิ่มเมื่อ 2026-08-23:** `grant_farmer_plot_registration.sql` — เพิ่ม
`POST /farmer/production-units` ให้เกษตรกรลงทะเบียนแปลง/หน่วยผลิต
(แปลงนา/คอก/บ่อ/สวน) ของตนเองได้เองเป็นครั้งแรก (ก่อนหน้านี้ตาราง
`registry.production_unit` มีแต่ endpoint แบบอ่านอย่างเดียวทั่วทั้งระบบ —
แถวข้อมูลที่เคยเห็นตอนทดสอบมาจาก `dev_sample_data.sql` เท่านั้น ซึ่งจงใจไม่รัน
กับ production) เพิ่มฟังก์ชัน `registry.register_production_unit()` แบบ
SECURITY DEFINER ที่ตรวจสอบเอง (มีเกษตรกรจริง, รหัสพืช/สัตว์มีอยู่จริงใน
`registry.commodity_ref`, ขอบเขต GPS เป็น GeoJSON Polygon ที่ถูกต้องตาม
เรขาคณิต, พื้นที่มากกว่า 0) ก่อน INSERT — ตามแบบเดียวกับ
`underwriting.submit_application()` เดิม เป็น additive ล้วนๆ ไม่กระทบของเดิม
รันเป็นไฟล์สุดท้ายในลำดับนี้ก็เพียงพอ (ต้องรันหลัง `02_full_schema.sql` และ
`04_reference_data.sql` เท่านั้น เพราะอ้างถึงตาราง/ข้อมูลอ้างอิงที่ต้องมีอยู่ก่อน)
ฝั่งหน้าเว็บมีหน้าใหม่ `frontend/register-plot.html` (ปักขอบเขต GPS บนแผนที่
ด้วยการคลิก แล้วกรอกรายละเอียด) เชื่อมจากปุ่ม "+ เพิ่มแปลงใหม่" บนแดชบอร์ด

**เพิ่มเมื่อ 2026-08-22:** `grant_sealed_bid_auction.sql` — เพิ่มโหมด Sealed-Bid
แบบเต็มให้ e-Auction (ข้อ 4.4 เดิม) เพิ่มคอลัมน์ `bid_visibility` (nullable
ไม่ได้ แต่มี `DEFAULT 'live'` — auction เดิมทุกใบไม่กระทบ) บน
`procurement.auction`: `'live'` (ค่า default, พฤติกรรมเดิมทุกประการ — ราคา
มองเห็นแบบ real-time, bid ใหม่ต้องต่ำกว่าราคาต่ำสุดปัจจุบันเท่านั้นถึงจะรับ) กับ
`'sealed'` (ใหม่ — ไม่เห็นราคาเลยไม่ว่าฝ่ายไหนรวมถึงผู้จัดประมูลเองระหว่างที่ยัง
เปิดอยู่, เสนอราคาใหม่ได้ไม่จำกัดจำนวนครั้ง, ทุกครั้งที่เสนอราคาได้รับแค่สถานะ
`is_leading: true/false` กลับมาทันที ไม่มีราคาปนมาเลย) ดูรายละเอียดเต็มที่
`B2B_COMMERCE_ENGINE_ARCHITECTURE.md` ข้อ 4.4a และคอมเมนต์หัวไฟล์ migration นี้
เอง **ต้องรันหลัง** `grant_b2b_commerce_engine.sql` เท่านั้น (ต้องมีตาราง
`procurement.auction` อยู่ก่อน) เป็น additive ล้วนๆ ไม่ต้องมี GRANT เพิ่ม
(agrolink_app มีสิทธิ์ระดับตารางอยู่แล้วซึ่งครอบคลุมคอลัมน์ใหม่โดยอัตโนมัติ)
รันเป็นไฟล์สุดท้ายในลำดับนี้ก็เพียงพอ — ทดสอบแล้วจริงกับฐานข้อมูล local ทั้ง
สอง mode (regression บนโหมด `live` เดิม + E2E เต็มรูปแบบบนโหมด `sealed` ใหม่
รวมถึงกรณีปิดประมูลอัตโนมัติเมื่อพ้นเวลา)

**เพิ่มเมื่อ 2026-08-17 (ดึก):** `grant_ledger_revenue_segregation.sql` —
เพิ่มคอลัมน์ `ledger.journal_entry.source_role_type` (nullable, ไม่มี
`CHECK`) เพื่อติด tag ว่าธุรกรรมเงินแต่ละรายการเกิดจากหน้าที่ทางธุรกิจไหน
ของสหกรณ์ (แก้ปัญหาที่บัญชี `vendor_settlement` ใช้ร่วมกันทุกหน้าที่ที่ไม่ใช่
Lender ทำให้แยกรายได้ตามหน้าที่ไม่ได้มาก่อน) พร้อมแก้ `ledger.transfer_funds()`
ให้รับพารามิเตอร์ใหม่ (**ต้อง `DROP FUNCTION` ลายเซ็นเดิม 8 พารามิเตอร์ก่อน
`CREATE`** — ทดสอบแล้วว่า `CREATE OR REPLACE` เพิ่มพารามิเตอร์ต่อท้ายเฉยๆ จะสร้าง
overload ที่สอง ไม่ได้แทนที่ตัวเดิม ทำให้ผู้เรียกที่ใช้จำนวนอาร์กิวเมนต์แบบเดิม
กำกวม — ดูรายละเอียดในคอมเมนต์หัวไฟล์) และแก้ `procurement.pay_invoice()`
ให้ส่งค่า `'Wholesale'` ทุกครั้งที่มีการชำระใบแจ้งหนี้ขายส่งจริง ผู้เรียก
`transfer_funds()` รายอื่นทั้งหมด (`credit.repay_loan`, `ledger.hold_escrow`/
`release_escrow`, `marketplace.complete_service_request`,
`produce.settle_delivery`) **ไม่ถูกแก้ในรอบนี้** เพราะตรวจโค้ดจริงแล้วพบว่า
มีเพียงเส้นทางขายส่ง (`procurement.pay_invoice`) เท่านั้นที่มีเงินไหลผ่าน
เลดเจอร์จริงวันนี้ — ดอกเบี้ยเงินกู้ยังไม่มี route เรียก `credit.repay_loan`
เลย ส่วนค่าเช่าเครื่องจักร/ค่าลานตาก/ค่าคอมมิชชันขายปัจจัยการผลิตตั้งใจให้
ชำระเงินนอกระบบ (ดูรายละเอียดเต็มที่คอมเมนต์หัวไฟล์ migration นี้เอง และ
`backend/README.md` หัวข้อ "Ledger revenue segregation by function" และ
`MULTI_ROLE_ORGANIZATION_ARCHITECTURE.md` ข้อ 5.3a) **ต้องรันหลัง**
`02_full_schema.sql` และ `grant_b2b_commerce_engine_phase3.sql` (ซึ่งเป็นที่
มาของ `procurement.pay_invoice()` ที่ migration นี้ไป `CREATE OR REPLACE`)
เท่านั้น รันเป็นไฟล์สุดท้ายในลำดับนี้ก็เพียงพอ — เป็น additive ล้วนๆ
(เพิ่มคอลัมน์ nullable + เพิ่มพารามิเตอร์ที่มี default + ฟังก์ชันใหม่)
ไม่แตะข้อมูลเดิมแม้แต่แถวเดียว ปลอดภัย 100%

**เพิ่มเมื่อ 2026-08-17 (ค่ำ):** `grant_machinery_service_consolidation.sql` —
ยุบ role บริการเครื่องจักร 4 ประเภทเดิม (`TractorService`/`DroneService`/
`HarvesterService`/`TruckService`) เป็น role เดียว `MachineryService` (แค่
ขยาย `CHECK` constraint เพิ่มค่าใหม่ ไม่แตะแถวข้อมูลเดิมเลย ปลอดภัย 100%)
เพื่อลดขั้นตอนอนุมัติของ Platform Ops จาก 4 รอบเหลือรอบเดียวสำหรับผู้ให้บริการ
เครื่องจักรกลรายใหม่ — ดูรายละเอียดเต็มที่ `backend/README.md` หัวข้อ
"Machinery/Drying-Yard Portal" และ `MULTI_ROLE_ORGANIZATION_ARCHITECTURE.md`
ข้อ 5.1 **ต้องรันหลัง** `02_full_schema.sql` เท่านั้น รันเป็นไฟล์สุดท้ายใน
ลำดับนี้ก็เพียงพอ

**เพิ่มเมื่อ 2026-08-17:** `grant_farmer_360.sql` — สร้างฟีเจอร์ "ข้อมูล
เกษตรกรรอบด้าน" (Farmer 360° View): ตาราง `identity.farmer_org_relationship`
(สมาชิกภาพของเกษตรกรกับหลายองค์กรพร้อมกัน — สหกรณ์/กองทุนหมู่บ้าน/ผู้ปล่อยกู้ ฯลฯ),
ฟังก์ชันเชื่อม/เลิกเชื่อมสมาชิกภาพและซิงค์อัตโนมัติจากธุรกรรมเดิม, และรหัส
"AgroLink ID" (`farmer_code`, รูปแบบ `AF-000001`) ให้เกษตรกรทุกคน — ดูรายละเอียด
เต็มที่ `backend/README.md` หัวข้อ "Farmer 360° View" และ
`FARMER_360_ARCHITECTURE.md` ที่ root ของโปรเจกต์ **ต้องรันหลัง**
`02_full_schema.sql` และ `03_grant_schema_usage.sql` เท่านั้น (ไม่ต้องพึ่งไฟล์
B2B Commerce Engine ด้านบน) รันเป็นไฟล์สุดท้ายในลำดับนี้ก็เพียงพอ

**เพิ่มเมื่อ 2026-08-16 (ดึก):** `grant_b2b_commerce_engine_phase3.sql` —
ต่อยอดจาก `grant_b2b_commerce_engine.sql` ด้านบน เพิ่มใบรับสินค้า (Goods
Receipt Note / GRN), ใบแจ้งหนี้ (Invoice), การชำระเงินจริงผ่านระบบ Ledger
เดิม (`ledger.transfer_funds()`) และการกระจายรายได้คืนสมาชิกสหกรณ์
(Revenue Sharing) ตามสัดส่วนที่แต่ละหน่วยผลิตส่งมอบเข้าล็อตที่ขายได้ —
ทำให้วงจร RFQ/e-Auction → สัญญา → PO ที่มีอยู่แล้วสมบูรณ์ครบวงจรตั้งแต่
"ตกลงซื้อขาย" ไปจนถึง "รับของ → ออกใบแจ้งหนี้ → จ่ายเงินจริง → กระจายเงิน
คืนเกษตรกรสมาชิก" และเพิ่ม UI ของทั้งหมดนี้ (รวมทั้ง e-Auction/PO ที่เดิมมีแค่
ฝั่งสหกรณ์และผู้รับซื้อ) ให้ฝั่งผู้จำหน่ายปัจจัยการผลิต (InputSupplier) ด้วย —
ดูรายละเอียดเต็มที่ `backend/README.md` หัวข้อ "AgroLink B2B Commerce Engine
— Phase 3" และ `B2B_COMMERCE_ENGINE_ARCHITECTURE.md` ที่ root ของโปรเจกต์
**ต้องรันหลัง** `grant_b2b_commerce_engine.sql` เท่านั้น (ต้องมีตาราง
`contract.contract` และ `procurement.purchase_order` อยู่ก่อน) รันเป็นไฟล์
สุดท้ายในลำดับนี้ก็เพียงพอ

**เพิ่มเมื่อ 2026-08-16 (ค่ำ):** `grant_b2b_commerce_engine.sql` — ต่อยอดจาก
`grant_rfq_marketplace.sql` ด้านบน เพิ่ม e-Auction (ประมูลราคาแบบย้อนกลับ),
การสร้างสัญญา (`contract.contract`) อัตโนมัติเมื่อ RFQ/การประมูลถูกตกลง, และใบสั่งซื้อ
(Purchase Order) — ดูรายละเอียดเต็มที่ `backend/README.md` หัวข้อ "AgroLink B2B
Commerce Engine" และ `B2B_COMMERCE_ENGINE_ARCHITECTURE.md` ที่ root ของโปรเจกต์
**ต้องรันหลัง** `grant_rfq_marketplace.sql` เท่านั้น (ต้องมี schema `procurement`
อยู่ก่อน) รันเป็นไฟล์สุดท้ายในลำดับนี้ก็เพียงพอ

**เพิ่มเมื่อ 2026-08-16 (บ่าย):** `grant_cooperative_product_catalog.sql` —
เปิดให้สหกรณ์ประกาศขายผลผลิต/สินค้าแปรรูปให้ผู้รับซื้อผ่านระบบแค็ตตาล็อกเดียวกับที่
ผู้จำหน่ายปัจจัยการผลิตใช้อยู่แล้ว (ไม่ได้สร้างตารางใหม่ แค่ขยาย category ที่อนุญาต
และเปิดให้ผู้รับซื้อ (Buyer) สั่งซื้อได้ ไม่ใช่แค่เกษตรกร) และทำให้ฟีเจอร์ "รายการแนะนำ"
(Featured Listings — มีแค่โครงสร้างฐานข้อมูลมาตั้งแต่ก่อนหน้านี้) ใช้งานได้จริงเป็นครั้งแรก
ต้องรันไฟล์นี้**หลังสุด** (หลัง `grant_input_supplier_and_buy_prices.sql`,
`grant_farmer_product_orders.sql` และ `grant_cooperative_tenant_foundation.sql`
ซึ่งสร้างตาราง/บัญชีที่ไฟล์นี้ต้องใช้ต่อ)

**เพิ่มเมื่อ 2026-08-16 (เย็น):** `grant_rfq_marketplace.sql` — สร้างระบบตลาด
"ประกาศความต้องการ ให้ผู้ขายแข่งราคา" (RFP/RFQ) แบบใหม่ทั้งหมด (schema
`procurement` ใหม่ แยกจากแค็ตตาล็อกเดิม) ให้สมาชิกทุกประเภทในระบบ (ทั้งเกษตรกร
และองค์กรทุกพอร์ทัล) ประกาศความต้องการซื้อได้ และให้องค์กร (รวมถึงสหกรณ์) เสนอราคา
แข่งขันกันได้ — ไม่ต้องรันหลังไฟล์ไหนเป็นพิเศษ นอกจาก `03_grant_schema_usage.sql`
(ต้องมี role `agrolink_app` อยู่ก่อน) รันเป็นไฟล์สุดท้ายในลำดับนี้ก็เพียงพอ

**เพิ่มเมื่อ 2026-08-16 (เช้า):** 11 ไฟล์ (`grant_cooperative_tenant_foundation.sql`
ถึง `grant_satellite_observation.sql`) — โมดูลสหกรณ์ทั้งหมด (M01 รากฐานสหกรณ์,
M09 จุดรับซื้อผลผลิต, M10 คลัง/ลานตาก, M04 แดชบอร์ดการเงินสหกรณ์, M11 การแปรรูป,
M13 การขนส่ง, M15 ประตูเชื่อมต่อภาครัฐ, M01 ส่วนที่ค้าง — ลำดับชั้นจังหวัด/บัญชีรายบุคคล
ของเจ้าหน้าที่สหกรณ์/เจ้าหน้าที่ภาครัฐ + ระบบจัดเก็บไฟล์ และ M14 คลังข้อมูลวิเคราะห์เชิงสถิติ
+ ข้อมูลดาวเทียม) ถูกสร้างและทดสอบจริงในเซสชันนี้เช่นกัน แต่ตกหล่นจากรายการนี้เหมือนกรณี
`grant_carbon_awd.sql` ด้านบน — เพิ่มเข้ามาให้ครบเพื่อให้การ deploy ฐานข้อมูลใหม่ตั้งแต่ต้นได้ครบทุกฟีเจอร์

**เพิ่มเมื่อ 2026-08-04 (เช้า):** `grant_carbon_awd.sql` — ระบบยืนยันการปลูกข้าว
คาร์บอนต่ำแบบเปียกสลับแห้ง (AWD) + ประเมินคาร์บอนเครดิต ดูรายละเอียดที่
`backend/README.md` หัวข้อ "Low-Carbon Rice Cultivation Verification"

**แก้ไขเมื่อ 2026-08-04:** รายการนี้เคยขาดไฟล์ไป 9 ไฟล์ (ตั้งแต่ `grant_about_content.sql`
ถึง `grant_fertilizer_mixing_service.sql` ด้านบน) — ไฟล์เหล่านี้มีอยู่จริงในโฟลเดอร์
`backend/db` และฟีเจอร์ที่เกี่ยวข้อง (หน้า "เกี่ยวกับเรา", แดชบอร์ดผู้ดูแลระบบ, การจองเครื่องจักรกล,
รายการสินค้าแนะนำ, โมเดลคะแนนเครดิต, เครื่องคำนวณสูตรปุ๋ย, ปฏิทินขั้นตอนการเพาะปลูก,
และบริการผสมปุ๋ยสั่งตัด) ก็ใช้งานได้บน Render อยู่แล้วในทางปฏิบัติ (แปลว่าน่าจะเคยรันสคริปต์เหล่านี้
ไปแล้วด้วยมือ แต่ไม่เคยถูกบันทึกไว้ในรายการนี้) — เพิ่มเข้ามาให้ตรงกับความเป็นจริงในรอบนี้
เพื่อให้การ deploy ฐานข้อมูลใหม่ตั้งแต่ต้น (เช่น ย้ายไป Render instance ใหม่) ได้ครบทุกฟีเจอร์
โดยไม่ต้องมานั่งไล่หาไฟล์ที่ขาดไปทีหลัง

**สังเกตว่าไม่มี `setup_backend_role.sql` ในรายการนี้** — อันนี้ตั้งใจ ต่างจากตอนตั้งค่าฐานข้อมูลในเครื่อง local (ที่ backend/README.md อธิบายไว้): บน Render เราให้ backend เชื่อมต่อด้วยบัญชีฐานข้อมูลที่ Render สร้างให้อัตโนมัติเลย (ผ่าน `DATABASE_URL`) แทนที่จะสร้างบัญชีแยกต่างหาก ซึ่งง่ายกว่าและทดสอบแล้วว่าใช้งานได้จริงบน Render ปลอดภัยเหมือนกัน (ไฟล์ `00_roles.sql` มีคำสั่งที่ทำให้บัญชีของ Render ใช้สิทธิ์ที่ระบบ RLS ต้องการได้)

**ถ้าเจอ error สีแดงที่ไม่ใช่เรื่องภาษาไทย (ไม่ใช่ "character with byte sequence...")** — หยุดตรงนั้นทันที อย่ารันไฟล์ถัดไปต่อ แล้วส่งภาพ error ทั้งหมดมาให้ผมดู (จุดที่เคยมีความเสี่ยงคือไฟล์ `01_extensions.sql` เรื่องสิทธิ์การสร้าง extension แต่ทดสอบจริงบน Render ผ่านเรียบร้อยแล้วไม่มีปัญหา)

---

## 8. ตรวจสอบว่า deploy สำเร็จ

**สำคัญ**: Render เติมรหัสสุ่มต่อท้าย URL ของทุก service เสมอ (เช่น `agrolink-backend-vhv6.onrender.com` ไม่ใช่ `agrolink-backend.onrender.com` เฉยๆ) — URL จริงจะอยู่ในหน้า service นั้นๆ เท่านั้น ต้องเข้าไปดูของจริงทุกครั้ง อย่าเดา

1. ใน Render Dashboard กดเข้า **agrolink-backend** → คัดลอก URL ที่แสดงอยู่ใต้ชื่อ service
2. เปิด browser ไปที่ URL นั้นตรงๆ (ไม่ต้องมี path ต่อท้าย) — ถ้าเห็นข้อความ error ของ Express (เช่น "Cannot GET /") แปลว่า backend **ทำงานอยู่** (ปกติ เพราะหน้านั้นไม่มี route ให้)
3. **ถ้า URL ของ agrolink-backend ไม่ตรงกับที่ตั้งไว้ในไฟล์ frontend** (ตอนเตรียมโค้ดผมตั้งไว้ตามค่าที่เจอตอนทดสอบ) ให้แจ้งผม URL จริงมา ผมจะแก้ไฟล์ frontend ทั้ง 8 ไฟล์ให้ตรงแล้วส่งกลับไปให้ push ใหม่
4. หาค่า `ADMIN_PASSCODE` ที่ Render สุ่มให้: ไปที่ agrolink-backend → แท็บ **Environment** → หาแถว `ADMIN_PASSCODE` → กดไอคอนตา (👁) เพื่อดูค่า
5. ไปที่ **agrolink-frontend** → คัดลอก URL ที่แสดงอยู่ (จะมีรหัสสุ่มต่อท้ายเช่นกัน) → เปิดใน browser
6. ควรเห็นหน้าแรกของ AgroLink ตามปกติ ลองกดลิงก์ไปหน้าสมัครผู้ให้บริการ (`register-provider.html`) แล้วลองสมัครทดสอบดูสัก 1 องค์กร — ถ้าสมัครผ่านและพาไปหน้า dashboard ได้ แปลว่าทุกส่วนเชื่อมกันถูกต้องแล้ว

ถ้าอยากทดสอบฝั่งแอดมิน: ไปที่ `<URL frontend>/admin/index.html` แล้ว login ด้วยค่า `ADMIN_PASSCODE` ที่คัดลอกมาจากข้อ 4

---

## 9. สิ่งที่ควรรู้ก่อนให้ผู้ใช้จริงทดลองใช้

- **ข้อมูลเริ่มต้นว่างเปล่า** — ไม่มีเกษตรกร/องค์กรตัวอย่างใดๆ ในระบบ ทุกคนต้องสมัครเข้ามาเอง (ตรงตามที่ตั้งใจไว้)
- **CORS เปิดกว้างทุก origin** — backend อนุญาตให้ frontend จากที่ไหนก็เรียกได้ ซึ่งเหมาะกับช่วงทดสอบ pilot แต่ควรจำกัดให้เหลือเฉพาะโดเมนจริงของคุณก่อนเปิดใช้งานวงกว้าง (แจ้งผมได้เมื่อพร้อมทำขั้นนี้)
- **ยังไม่มีระบบชำระเงิน/เคลียร์บัญชีจริง** — ตามที่คุยกันไว้ก่อนหน้านี้ ระบบสินเชื่อ/การซื้อขายทั้งหมดยังเป็นการบันทึกข้อมูลเท่านั้น ยังไม่ผูกกับธนาคารหรือ payment gateway จริง และเรื่องนี้ควรปรึกษาที่ปรึกษากฎหมาย/การเงินก่อนใช้กับเงินจริง
- **รหัสลับที่ใช้ตอนพัฒนา (ในไฟล์ `.env` ของ sandbox) ไม่ถูกนำมาใช้บน Render** — Render สุ่มค่าใหม่ให้เองตอน deploy (ข้อ 5 ของหัวข้อที่ 3) ไม่ต้องทำอะไรเพิ่ม

---

## 10. เมื่อแก้โค้ดเพิ่มในอนาคต

Render เชื่อมกับ GitHub repo ของคุณโดยตรง — ทุกครั้งที่คุณ `git push` (ผ่าน GitHub Desktop ตามปกติ) ไปที่ branch `main`, Render จะ deploy เวอร์ชันใหม่ให้อัตโนมัติทั้ง backend และ frontend ภายในไม่กี่นาที ไม่ต้องทำอะไรเพิ่มในฝั่ง Render เลย (ยกเว้นถ้ามีการแก้โครงสร้างฐานข้อมูล ซึ่งกรณีนั้นจะต้องรันสคริปต์ SQL ใหม่เพิ่มเติมแบบเดียวกับข้อ 7 — ผมจะแจ้งและเตรียมสคริปต์ให้ทุกครั้งที่เกิดกรณีแบบนี้)
