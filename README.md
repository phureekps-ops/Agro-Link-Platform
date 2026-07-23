# AgroLink Platform

**เครือข่ายเชื่อมโยงวงการเกษตร** — แพลตฟอร์มที่เชื่อมโยงเกษตรกร ผู้ให้สินเชื่อ ผู้ซื้อผลผลิต และผู้จัดหาปัจจัยการผลิต เข้าไว้ด้วยกันบนโครงสร้างข้อมูลและ API ชุดเดียว ตั้งแต่การขึ้นทะเบียนแปลง การประเมินความน่าเชื่อถือทางสินเชื่อ การทำสัญญา ไปจนถึงการตรวจสอบย้อนกลับผลผลิต (traceability)

---

## ภาพรวมโปรเจกต์

โปรเจกต์นี้พัฒนาแบบ "ทีละชั้นสถาปัตยกรรม" (architecture layer) โดยแต่ละชั้นจะออกแบบฐานข้อมูลจริง รันและทดสอบบน PostgreSQL จริง เขียน OpenAPI spec และตรวจสอบด้วยเครื่องมือจริง สร้างแผนภาพ ERD และจัดทำเอกสารออกแบบภาษาไทยประกอบ — ไม่ใช่แค่เอกสารแผนงาน แต่เป็นระบบที่รันได้และทดสอบแล้วจริงในทุกขั้น

ปัจจุบันพัฒนาไปแล้ว **11 ขั้นตอน (ขั้นที่ 0–10)** ครอบคลุมระบบย่อยตั้งแต่ G-01 ถึง G-19 บวกกับ**ชั้นแอปพลิเคชัน** (Backend API Gateway + Frontend) ที่เริ่มเชื่อมต่อผู้ใช้งานจริงกลุ่มแรกคือเกษตรกร (Farmer Portal)

## สถาปัตยกรรม — 11 ขั้นตอนที่พัฒนาแล้ว

| ขั้นที่ | หัวข้อ | ระบบย่อย | สรุป |
|---|---|---|---|
| 0 | Foundation & Governance | G-01 | Security Baseline, Charter, Cloud Landing Zone (Terraform), Data Dictionary & Taxonomy Registry |
| 1 | Identity & Registry | G-02, G-03 | Identity & Access Management, Master Registry (เกษตรกร, องค์กร, หน่วยผลิต) |
| 2 | Core Ledger | G-04 | Ledger & Wallet กลาง — บัญชีแยกประเภท, การเดินบัญชี |
| 3 | Partner & Contract | G-05, G-06 | ข้อมูลคู่ค้า (Partner/Vendor), สัญญาทุกประเภท (สินเชื่อ, ซื้อขายล่วงหน้า, บริการ) |
| 4 | Production & Marketplace | G-07, G-08 | รอบการผลิต (crop cycle), ตลาดกลางบริการ/ปัจจัยการผลิต |
| 5 | Produce & Traceability | G-09, G-10 | การส่งมอบผลผลิต, ใบรับรอง, การตรวจสอบย้อนกลับ |
| 6 | Credit & Risk | G-11 | โมเดลคะแนนความน่าเชื่อถือทางสินเชื่อ (credit scoring) แบบ rule-based |
| 7 | Underwriting, Notification, Reporting | G-12, G-13 | การพิจารณาสินเชื่ออัตโนมัติ, ระบบแจ้งเตือน, แดชบอร์ดรายงานเชิงบริหาร |
| 8 | Security & Audit | G-14, G-15 | Row-Level Security (RLS) บังคับระดับตาราง, Audit log ครบทุกการเข้าถึงข้อมูล |
| 9 | Operations Readiness | G-16, G-17 | แผน Backup/DR ที่ทดสอบ restore จริง, ผลทดสอบ load/performance (pgbench) |
| 10 | Controlled Go-Live | G-18, G-19 | Observability & Alerting (เกณฑ์จากข้อมูลวัดจริง), Data Retention Policy, Go-Live Readiness Gate |

ทุกขั้นตอนใช้ PostgreSQL 16 + PostGIS เป็นฐานข้อมูลหลัก (ฐานข้อมูลทดสอบ: `agrolink_test`) และสะสม schema ต่อเนื่องกันมาตั้งแต่ขั้นที่ 0 จนถึงปัจจุบัน (identity, registry, ledger, partner, contract, production, marketplace, produce, traceability, credit, risk, underwriting, notification, reporting, security, audit, ops, monitoring, retention)

> หมายเหตุ: ไฟล์ DDL, OpenAPI spec, แผนภาพ ERD และเอกสารออกแบบ (docx) ของแต่ละขั้นตอนถูกส่งมอบให้ทีมงานแล้วในระหว่างการพัฒนา ยังไม่ได้นำเข้ามาเก็บใน repo นี้ทั้งหมด — ถ้าต้องการเก็บไว้เป็นหลักฐานเดียวกันใน repo (เช่นในโฟลเดอร์ `docs/` หรือ `database/`) แจ้งได้ครับ

## ชั้นแอปพลิเคชัน — Farmer Portal

ต่อยอดจาก 11 ขั้นตอนข้างต้น เริ่มสร้างระบบที่ผู้ใช้งานจริงเข้าถึงได้ โดยเลือกกลุ่มเกษตรกรเป็นกลุ่มแรก:

- **`backend/`** — Backend API Gateway (Node.js/Express) เชื่อมต่อฐานข้อมูลจริงผ่าน role `agrolink_app` ที่มี RLS บังคับใช้ทุก request รองรับ endpoint สำหรับแดชบอร์ด, คะแนนสินเชื่อ, สัญญา, คำขอสินเชื่อ, การแจ้งเตือน, หน่วยผลิต และรายชื่อผู้ให้สินเชื่อ — รายละเอียดเต็มดูที่ [`backend/README.md`](./backend/README.md)
- **`frontend/`** — หน้าเว็บพอร์ทัลเกษตรกร (HTML/CSS/JS ล้วน ไม่มี build step) หน้า Login + Dashboard ที่เรียกใช้ backend ข้างต้นจริง ทดสอบผ่าน headless browser แล้วว่าข้อมูลของเกษตรกรแต่ละคนแยกจากกันถูกต้อง — รายละเอียดเต็มดูที่ [`frontend/README.md`](./frontend/README.md)
- **`index.html`** — หน้าโฮมเพจหลักของเว็บไซต์

## สถานะปัจจุบัน

- ✅ สถาปัตยกรรมฐานข้อมูล 11 ขั้นตอน (ขั้นที่ 0–10) ออกแบบ, รัน DDL จริง, ทดสอบ, และจัดทำเอกสารครบถ้วน
- ✅ Backend API Gateway สำหรับ Farmer Portal — สร้างและทดสอบ end-to-end กับฐานข้อมูลจริงแล้ว
- ✅ Frontend Farmer Portal — สร้างและทดสอบผ่านเบราว์เซอร์จริงแล้ว (login, ดูข้อมูล, ยื่นคำขอสินเชื่อ, การแยกข้อมูลระหว่างผู้ใช้)
- ⏭️ ที่ยังไม่ได้ทำ: การเชื่อมต่อระบบยืนยันตัวตน (OIDC) จริงแทนฟอร์มจำลอง, การเพิ่ม RLS ให้ตาราง notification, พอร์ทัลสำหรับผู้ใช้กลุ่มอื่น (ผู้ให้สินเชื่อ, ผู้ซื้อผลผลิต, ทีมปฏิบัติการ)

## เทคโนโลยีที่ใช้

- **ฐานข้อมูล:** PostgreSQL 16 + PostGIS 3.4
- **Backend:** Node.js, Express 5, `pg`, `jsonwebtoken`
- **Frontend:** HTML/CSS/JavaScript (ไม่มี framework/build step)
- **API Contracts:** OpenAPI 3.0.3 (ตรวจสอบด้วย `openapi_spec_validator`)
- **แผนภาพ ERD:** Graphviz

## เริ่มต้นใช้งาน

ดูขั้นตอนติดตั้งและรันแบบละเอียดได้ที่ README ของแต่ละส่วน:

1. ตั้งค่าและรัน Backend — [`backend/README.md`](./backend/README.md)
2. ตั้งค่าและรัน Frontend — [`frontend/README.md`](./frontend/README.md)
