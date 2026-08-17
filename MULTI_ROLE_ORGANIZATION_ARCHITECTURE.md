# AgroLink องค์กรหลายบทบาท (Multi-Role Organization) — Architecture

**สถานะเอกสาร:** ฉบับที่ 1 — ออกแบบ 2026-08-17
**ผู้ร้องขอ:** "หน่วยงานหลายแห่งมีหลายหน้าที่ เช่นสหกรณ์ ปล่อยกู้ รับซื้อผลผลิต จำหน่ายปัจจัยการผลิต ให้บริการอุปกรณ์ ให้บริการลานตาก ขายส่งผลผลิต จะต้องออกแบบอย่างไร"

**ข้อสรุปสำคัญที่สุดของเอกสารนี้:** โมเดล "องค์กรเดียว หลายบทบาท" **มีอยู่แล้วในระบบ** — สร้างไว้ตั้งแต่ `backend/db/grant_organization_roles.sql` และใช้งานจริงทุกวันนี้กับ Lender/InputSupplier/Machinery/DryingYard เอกสารนี้จึงไม่ได้ออกแบบระบบใหม่ทั้งหมด แต่ทำสามอย่าง: (1) อธิบายโมเดลที่มีอยู่ให้ครบทุกชั้น (2) ตรวจสอบกรณีตัวอย่างสหกรณ์ 6 หน้าที่ทีละหน้าที่เทียบกับโมเดลเดิม (3) **ระบุ 3 ช่องว่างเชิงออกแบบที่ยังไม่มีคำตอบ** พร้อมข้อเสนอทางแก้ที่ต่อยอดจากโครงเดิมได้ทันที ไม่ต้องรื้อออกแบบใหม่

## 1. หลักการออกแบบ

1. **แยก "ตัวตนนิติบุคคล" ออกจาก "สิทธิ์ทำธุรกิจแต่ละอย่าง"** — องค์กรหนึ่งมี KYB ระดับนิติบุคคลแค่ครั้งเดียว ("เป็นบริษัท/สหกรณ์ที่มีตัวตนจริงหรือไม่") แต่แต่ละ "หน้าที่ทางธุรกิจ" (ปล่อยกู้/ขายปัจจัยการผลิต/ให้บริการเครื่องจักร ฯลฯ) ต้องผ่านการอนุมัติแยกกันเป็นรายหน้าที่ เพราะแต่ละหน้าที่มีความเสี่ยง/มาตรฐานกำกับดูแลไม่เท่ากัน (เช่น ปล่อยกู้ย่อมต้องตรวจสอบเข้มกว่าขายปุ๋ย)
2. **"สมัครหนึ่งบทบาทก่อน ขอเพิ่มทีหลัง"** — ฟอร์มสมัครสมาชิกสาธารณะ (`POST /auth/org-register`) ยังคงให้เลือกได้ทีละหนึ่ง `org_type` เท่านั้น (ไม่เปลี่ยน shape เดิม) บทบาทที่ 2, 3, ... ขอเพิ่มทีหลังผ่าน endpoint แยกต่างหาก (`POST /organization/roles`) หลังผ่าน KYB ระดับนิติบุคคลแล้วเท่านั้น
3. **ไม่ใช่ทุกหน้าที่ต้องผ่านกลไก role-request** — บางความสามารถ (เช่นสหกรณ์รับซื้อผลผลิตจากสมาชิกตัวเอง, หรือขายส่งผลผลิตต่อในตลาด B2B) ถือเป็นความสามารถโดยธรรมชาติของ `org_type` นั้นอยู่แล้ว ไม่ใช่บริการเสริมที่ต้องขออนุมัติแยก — ดูตารางเปรียบเทียบข้อ 3 ว่าหน้าที่ไหนต้องขอ role หน้าที่ไหนไม่ต้อง
4. **"No row-level security, explicit WHERE clause IS the security boundary"** — สืบทอดธรรมเนียมเดิมของระบบ (`identity.organization_role` ไม่มี RLS, ตรวจสอบด้วย `WHERE org_id = $1` ในทุก query แทน)
5. **Additive schema widening ไม่ใช่ breaking change** — ทุกครั้งที่เพิ่มประเภทองค์กร/บทบาทใหม่ (VillageFund, FertilizerMixingService, MarketVenue) ใช้วิธี `DROP CONSTRAINT` แล้ว `ADD CONSTRAINT` ใหม่ที่ widen ค่าที่ยอมรับ ไม่เคยลบค่าเดิมออกจาก DB domain แม้จะปิดไม่ให้สมัครใหม่ผ่านฟอร์มสาธารณะแล้วก็ตาม (ดูกรณี `Cooperative`/`Mill` ในข้อ 2)

## 2. สถานะปัจจุบัน — โมเดลที่มีอยู่แล้ว (ไม่ต้องสร้างใหม่)

### 2.1 สองชั้นข้อมูล

| ชั้น | ตาราง | เช็คอะไร | ตัดสินใจ/อนุมัติโดย |
|---|---|---|---|
| ระดับนิติบุคคล | `identity.organization.kyb_status` | "เป็นนิติบุคคลจริงที่ผ่านการตรวจสอบหรือยัง" (`Pending`/`Verified`/`Rejected`) — ตัดสินใจครั้งเดียว | Platform Ops ผ่าน `POST /admin/organizations/:id/kyb-status` |
| ระดับหน้าที่ทางธุรกิจ | `identity.organization_role` (`org_id, role_type` เป็น PK ร่วม) | "หน้าที่นี้โดยเฉพาะได้รับอนุญาตหรือยัง" (`Pending`/`Verified`/`Rejected`) — ตัดสินใจแยกทุกครั้งที่ขอเพิ่ม | Platform Ops ผ่าน `POST /admin/organizations/:id/roles/:role_type/status` (บทบาทแรกอนุมัติพร้อมกับ KYB ในคลิกเดียว บทบาทที่ 2 ขึ้นไปอนุมัติแยก) |

โดเมนค่า `role_type` ที่ระบบยอมรับวันนี้ (ตรวจจาก `02_full_schema.sql` + migration ที่ widen เพิ่มภายหลัง): `Cooperative, Mill, Bank, InputSupplier, Lender, Logistics, Buyer, VillageFund, TractorService, DroneService, HarvesterService, TruckService, DryingYardService, MarketVenue, FertilizerMixingService`

### 2.2 ทุก route ธุรกิจเช็คสองชั้นนี้เสมอ (ตัวอย่างจริงจาก `lender.js`)

```js
// Since multi-role support (grant_organization_roles.sql), this is a
// TWO-layer check, not one:
//   1. org.kyb_status === 'Verified' — the ENTITY itself must be a real,
//      approved business at all.
//   2. identity.organization_role has a row for (org_id, 'Lender') with
//      status = 'Verified' — the ORG specifically has this role approved.

const role = await client.query(
  `SELECT status FROM identity.organization_role WHERE org_id = $1 AND role_type = 'Lender'`,
  [subjectId],
);
if (result.roleStatus !== 'Verified') {
  return res.status(403).json({
    error: 'role_not_verified', role_type: 'Lender', role_status: result.roleStatus, org_name: result.org.org_name,
  });
}
```

รูปแบบเดียวกันนี้ใช้ซ้ำใน `inputsupplier.js`, `machinery.js`/`farmermachinery.js` (เช็ค role_type ตาม `MACHINERY_ORG_TYPES = ['TractorService','DroneService','HarvesterService','TruckService','DryingYardService']`), `fertilizermixing.js`, `villagefund.js` — ทุกพอร์ทัลธุรกิจที่ผูกกับ role หนึ่งค่าเป๊ะๆ ใช้ pattern เดียวกันหมด

### 2.3 การขอบทบาทเพิ่ม — ฝั่งองค์กร (มีอยู่แล้ว, `organization.js`)

- `GET /organization/roles` — คืนบทบาททั้งหมดที่ถืออยู่ (พร้อมสถานะ) + บทบาทที่ยังขอเพิ่มได้ (`ORG_REQUESTABLE_ROLE_TYPES` ตัดรายการที่มีแถวอยู่แล้วออก ไม่ว่าสถานะใด)
- `POST /organization/roles` — ขอบทบาทใหม่ 1 รายการ ต้องผ่าน `kyb_status='Verified'` ระดับนิติบุคคลก่อน (`409 entity_kyb_not_verified` ถ้ายัง), ห้ามขอซ้ำถ้ามีแถวอยู่แล้วไม่ว่าสถานะใด รวมถึงแถวที่เคย `Rejected` (`409 role_already_requested`) — การขอใหม่หลัง Rejected ต้องให้ Platform Ops เข้าไปจัดการเองในฐานข้อมูลโดยตรง ไม่ใช่ retry loop ไม่จำกัดผ่าน self-service

**หมายเหตุสำคัญ:** `'Cooperative'` และ `'Mill'` ถูกถอดออกจาก `ORG_SELF_REGISTER_TYPES` (`auth.js`) และ `ORG_REQUESTABLE_ROLE_TYPES` (`organization.js`) ตั้งแต่ 2026-07-24 ตามการตัดสินใจว่าสหกรณ์ไม่ควรสมัครเองผ่านฟอร์มสาธารณะ — องค์กร `org_type='Cooperative'` ทุกรายวันนี้ถูกสร้างผ่านช่องทาง Platform-Ops-provisioning (`POST /admin/cooperatives`, ดู `grant_cooperative_tenant_foundation.sql`) เท่านั้น **แต่หลังสร้างแล้ว สหกรณ์นั้นยังคงเรียก `POST /organization/roles` เพื่อขอบทบาทเสริม (Lender/InputSupplier/DryingYardService ฯลฯ) ได้ตามปกติ — endpoint นี้ไม่ได้เช็ค org_type หลักของผู้เรียกเลย ใครก็ตามที่เป็น organization subject ที่ผ่าน KYB ขอได้เหมือนกันหมด**

### 2.4 เงินไหลไปที่ไหน — `partner.activate_vendor_role(org_id, role_type)`

เมื่อบทบาทหนึ่งถูกอนุมัติ (`status='Verified'`) ฟังก์ชันนี้เปิดบัญชีเดินสะพัด (`ledger.account`) ให้บทบาทนั้นใช้งาน แบ่งเป็น 2 กลุ่มเท่านั้น ไม่ใช่ 1 บัญชีต่อ 1 บทบาท:

- **`role_type = 'Lender'`** → บัญชี `lender_clearing` แยกต่างหาก
- **บทบาทอื่นทั้งหมด** (Buyer/InputSupplier/Mill/Cooperative/Logistics/TractorService/DroneService/HarvesterService/TruckService/DryingYardService) → ใช้ร่วมกันบัญชีเดียว `vendor_settlement` (`partner.vendor_profile` มีช่อง `settlement_account_id` แค่ 1 ช่อง)

องค์กรที่มี Buyer+InputSupplier+TractorService พร้อมกัน เงินจากทั้ง 3 หน้าที่จึงไหลลงบัญชีเดียวกันหมด — ผลกระทบของจุดนี้ต่อการแบ่งรายได้คืนสมาชิกอธิบายในข้อ 5.3

## 3. กรณีศึกษา — สหกรณ์ 6 หน้าที่ ตรงกับโมเดลเดิมตรงไหนบ้าง

| หน้าที่ | กลไกที่รองรับ | ต้องขอ role เพิ่มไหม | ไฟล์/เอกสารอ้างอิง |
|---|---|---|---|
| ปล่อยกู้ | `role_type='Lender'` ผ่าน `/organization/roles` | ✅ ต้องขอ | `lender.js`, `requireLenderOrg` |
| จำหน่ายปัจจัยการผลิต | `role_type='InputSupplier'` | ✅ ต้องขอ | `inputsupplier.js` |
| ให้บริการอุปกรณ์ (รถไถ/โดรน/รถเกี่ยว/รถบรรทุก) | `role_type='MachineryService'` (รวมเป็น role เดียว, ✅ ทำแล้ว 2026-08-17 — ดูข้อ 5.1) | ✅ ต้องขอ — **ครั้งเดียว** | `machinery.js`, `farmermachinery.js`, `MACHINERY_ORG_TYPES` |
| ให้บริการลานตาก | `role_type='DryingYardService'` (อยู่ใน `MACHINERY_ORG_TYPES` ตัวที่ 5) | ✅ ต้องขอ | `machinery.js`/`farmermachinery.js` เดียวกับข้างบน |
| รับซื้อผลผลิตจากสมาชิกสหกรณ์เอง | ผูกกับ `org_type='Cooperative'` โดยตรง ไม่ผ่าน role-request | ❌ ไม่ต้องขอ | `coopcollection.js` (Cooperative Collection Station module, `grant_cooperative_collection_station.sql`) |
| ขายส่งผลผลิตต่อ (เช่นให้โรงสี/ผู้รับซื้อรายอื่น) | เป็น "Responder" ใน B2B Commerce Engine ได้ทันทีเมื่อผ่าน KYB ระดับนิติบุคคล — `requireVerifiedOrgIfOrganization()` เช็คแค่ `kyb_status`, ไม่เช็ค `role_type` เลย | ❌ ไม่ต้องขอ | `procurement.js` (RFQ/e-Auction/Contract/PO/Invoice/Revenue-Share) |

**ทำไมสองแถวสุดท้ายไม่ต้องขอ role:** เพราะเป็นความสามารถที่ผูกกับ "การเป็นสหกรณ์" โดยตรง ไม่ใช่บริการเสริมที่มีความเสี่ยง/มาตรฐานกำกับดูแลต่างจากธุรกิจหลัก — B2B Commerce Engine ถูกออกแบบมาให้ทุกองค์กรที่ผ่าน KYB เป็นทั้งผู้ซื้อและผู้ขายได้อยู่แล้วโดยธรรมชาติของตลาดกลาง (ดู `B2B_COMMERCE_ENGINE_ARCHITECTURE.md` ข้อ 3 ตาราง Actor↔Portal↔org_type mapping ที่ระบุบทบาทของสหกรณ์ไว้ว่า "Requester (ซื้อปัจจัยการผลิต) + Responder (ขายผลผลิต/สินค้าแปรรูป)" อยู่แล้วตั้งแต่ต้น)

## 4. Workflow การเปิดใช้งานครบทุกหน้าที่ (จากตัวอย่างสหกรณ์)

1. Platform Ops สร้างองค์กร `org_type='Cooperative'` ผ่าน `POST /admin/cooperatives` → ได้ role แรก (`Cooperative`) verified พร้อมกับ KYB นิติบุคคลในคลิกเดียว (การรับซื้อจากสมาชิก + ขายส่งต่อ **ใช้งานได้ทันทีจากขั้นตอนนี้ขั้นตอนเดียว** ตามข้อ 3)
2. สหกรณ์ login แล้วเรียก `GET /organization/roles` เพื่อดูรายการที่ขอเพิ่มได้
3. เรียก `POST /organization/roles` แยกทีละหน้าที่: `{role_type:'Lender'}`, `{role_type:'InputSupplier'}`, `{role_type:'TractorService'}`, `{role_type:'DryingYardService'}`, ... — แต่ละครั้งได้แถวใหม่สถานะ `Pending`
4. Platform Ops อนุมัติแยกทีละแถวผ่าน `POST /admin/organizations/:id/roles/:role_type/status` — จุดนี้เป็นจุดคัดกรองจริง เช่นอาจอนุมัติ InputSupplier ทันทีแต่ให้ Lender รอเอกสารเพิ่มก่อน
5. เมื่อแถวไหน `Verified` → `partner.activate_vendor_role()` เปิดบัญชีเดินสะพัดที่เกี่ยวข้องให้อัตโนมัติ → พอร์ทัลของหน้าที่นั้นเปิดใช้งานได้จริง (`403 role_not_verified` จะหายไปจาก endpoint ของหน้าที่นั้น)

## 5. ช่องว่างเชิงออกแบบที่ต้องตัดสินใจต่อ

โมเดลข้างบนรองรับ "องค์กรหนึ่งมีหลายหน้าที่" ได้ในระดับ **สิทธิ์การเข้าถึง (authorization)** ครบแล้ว แต่การสำรวจโค้ดจริงพบ 3 จุดที่ยังไม่มีคำตอบระดับ **การดำเนินงาน (operations)** เมื่อหน้าที่หลายอย่างทำงานพร้อมกันจริงในองค์กรเดียว

### 5.1 ความละเอียดของ role บริการเครื่องจักร — ✅ แก้แล้ว 2026-08-17

**สถานะเดิม (ก่อนแก้):** บริการเครื่องจักร 4 ประเภท (รถไถ/โดรน/รถเกี่ยว/รถบรรทุก) เป็น `role_type` แยกกัน 4 ค่า — สหกรณ์ที่อยากให้บริการครบทั้ง 4 อย่างต้องขออนุมัติ 4 รอบแยกกัน

**เหตุผลที่เปลี่ยนใจจากข้อเสนอเดิม ("เก็บไว้ตามเดิม เพิ่มแค่ batch endpoint"):** ตอนลงมือimplement พบว่า `requireMachineryOrg` (`machinery.js`) **ให้สิทธิ์เต็มพอร์ทัลทันทีที่มี role ใดก็ได้ 1 ใน 5 ตัว Verified** — org ที่ผ่านแค่ `DroneService` ตั้งราคา/รับจองได้ทั้ง 7 รายการในตารางค่าบริการอยู่แล้ว (โค้ดเดิมยอมรับตรงๆ ว่า "the rate card itself has no per-role field gating") การแยก role เป็น 4 ค่าจึงไม่เคยให้ประโยชน์ด้าน access control จริง มีแต่เพิ่มขั้นตอนอนุมัติเปล่าๆ — จึงยุบเป็น role เดียวแทนที่จะแค่เพิ่ม batch endpoint

**สิ่งที่ทำจริง:** เพิ่ม `role_type`/`org_type` ใหม่ `MachineryService` (ตาม additive-widening pattern เดิมของโปรเจกต์) แทนที่ `TractorService`/`DroneService`/`HarvesterService`/`TruckService` ใน `ORG_SELF_REGISTER_TYPES` (`auth.js`) และ `ORG_REQUESTABLE_ROLE_TYPES` (`organization.js`) — **ไม่ backfill/ไม่ย้ายแถวเดิม** องค์กรที่เคยขอ role แบบเก่าไว้ก่อนหน้านี้ยังใช้งานได้ปกติทุกอย่าง (`MACHINERY_ORG_TYPES` ใน `machinery.js`/`farmermachinery.js` เช็คทั้ง role เก่าและใหม่) **ไม่ต้องเพิ่มคอลัมน์ `machinery_type`** ในตารางจองเลย — `marketplace.service_listing.service_key`/`service_type` (7 รายการคงที่: ไถดะ/ไถแปร/ปั่นดิน/ฉีดพ่น/เกี่ยวข้าว/รถบรรทุก/ลานตาก) ที่ snapshot ลง `marketplace.machinery_booking` อยู่แล้วเป็นข้อมูลระดับรายการ/การจอง แยกจากแกน role_type (สิทธิ์เข้าถึง) โดยสิ้นเชิงอยู่ก่อนแล้ว การยุบ role จึงไม่กระทบความละเอียดของข้อมูลตรงนี้เลย

**`DryingYardService` ไม่ถูกยุบรวมด้วย** — ยังคงเป็น `role_type` แยกต่างหากตามขอบเขตเดิมของข้อ 3 (เป็นคนละ "หน้าที่" ในตัวอย่างสหกรณ์ 6 ข้อ แม้โค้ดจะรวมอยู่ใน `MACHINERY_ORG_TYPES` เดียวกันเพื่อความสะดวกในการ implement ก็ตาม)

**ไฟล์ที่แก้:** `backend/db/grant_machinery_service_consolidation.sql` (migration ใหม่), `backend/src/routes/{auth.js, organization.js, machinery.js, farmermachinery.js}`, `frontend/js/register-provider.js`, `frontend/register-provider.html`, `frontend/machinery/js/dashboard.js`, `frontend/admin/js/dashboard.js`

**ทดสอบแล้ว:** backend 17 assertions (org เก่าที่ยังถือ `TractorService` ใช้งานพอร์ทัลได้ปกติ + label ไม่เพี้ยน, `GET /organization/roles` ไม่เสนอ 4 ตัวเก่าอีกต่อไปแต่เสนอ `MachineryService` แทน + `DryingYardService` ไม่ถูกแตะ, องค์กรใหม่สมัครด้วย `org_type=MachineryService` ผ่าน KYB แล้วเข้าพอร์ทัลได้ทันที ตั้งราคาค่าบริการ 2 รายการอิสระจากกันได้ถูกต้อง และเกษตรกรเห็นองค์กรใหม่นี้ในรายชื่อผู้ให้บริการ) + headless-browser ยืนยัน dropdown สมัครสมาชิกไม่มี 4 ตัวเก่าอีกต่อไปและ dashboard ของ org เก่าโชว์ label ถูกต้อง ล้างข้อมูลทดสอบเรียบร้อย

### 5.2 การจำกัดสิทธิ์พนักงานตามหน้าที่ (staff permission scoping)

**สถานะปัจจุบัน:** ระบบ staff login รายบุคคล (`identity.register_staff_member()`, `grant_staff_and_government_access.sql`) มี **operational role code** ของสหกรณ์อยู่แล้ว 6 ค่า: `coop.admin`, `coop.manager`, `coop.accountant`, `coop.credit_officer`, `coop.member_officer`, `coop.warehouse_officer` — เก็บใน `identity.subject_role` แยกจาก `identity.organization_role` โดยสิ้นเชิง (คนละตารางคนละแนวคิด: `organization_role` คือ "องค์กรทำหน้าที่นี้ได้ไหม" ส่วน `subject_role` คือ "พนักงานคนนี้ทำอะไรในองค์กรได้")

**ช่องว่าง:** สองระบบนี้ **ไม่ได้เชื่อมกัน** วันนี้ — พนักงานที่ login เป็น `coop.credit_officer` ยังคง login ผ่าน `subject_type='organization_member'` แต่ route gate ของ `/lender/*`/`/machinery/*`/`/inputsupplier/*` ทุกตัวเช็คแค่ `requireOrganization` (`subject_type==='organization'`, คือ login กลางระดับองค์กร) เท่านั้น — หมายความว่าวันนี้ยังไม่มีทางให้ "พนักงานสินเชื่อ" ล็อกอินแล้วเข้าได้เฉพาะโมดูล Lender ในขณะที่ "พนักงานคลังสินค้า/ลานตาก" เข้าได้เฉพาะโมดูล DryingYardService — ทุกหน้าที่ยังคงต้องใช้ shared org-level login เดียวกันหมด (ตามที่ `FARMER_360_ARCHITECTURE.md` ข้อ 2 ระบุไว้ตรงๆ เช่นกัน)

**ข้อเสนอ (ยังไม่ทำ, บันทึกไว้เป็นแนวทาง):**
1. เพิ่ม mapping ตายตัวในโค้ด (ไม่ต้องเป็นตาราง DB ใหม่) `OPERATIONAL_ROLE_TO_BUSINESS_ROLE = { 'coop.credit_officer': ['Lender'], 'coop.warehouse_officer': ['DryingYardService', /* คลังสินค้า */], 'coop.member_officer': ['Cooperative' /* งานรับซื้อ/สมาชิก */], ... }`
2. เพิ่ม middleware ใหม่ `requireOrganizationMemberWithBusinessRole(businessRoleType)` ที่ให้ `subject_type='organization_member'` login เข้าถึง route ของหน้าที่นั้นได้เพิ่มเติมจาก `requireOrganization` เดิม (ไม่ใช่แทนที่ — องค์กรเองยัง login กลางได้เหมือนเดิมเสมอ เป็น superset)
3. ต้อง join `identity.organization_member.org_id` เข้ากับ `identity.organization_role` ของ org เดียวกันด้วย เพื่อกันกรณีพนักงานมี operational role ที่ธุรกิจของ org ยังไม่ได้รับอนุมัติเลย (เช่น `coop.credit_officer` ที่ org ยังไม่มี `Lender` role verified — ต้อง 403 เหมือนเดิม)

จุดนี้เป็นงานที่ **ควรทำก่อน** เปิดให้สหกรณ์จริงมีหลายหน้าที่พร้อมกันในทางปฏิบัติ เพราะไม่งั้นทุกพนักงานที่มีบัญชี login จะเห็นทุกโมดูลเท่ากันหมด ซึ่งขัดกับหลักการแบ่งแยกหน้าที่ (segregation of duties) ที่งานสินเชื่อควรมีอยู่แล้วโดยทั่วไป

### 5.3 การแยกบัญชี/รายได้ตามหน้าที่ สำหรับแบ่งปันคืนสมาชิก

**สถานะปัจจุบัน:** ระบบ Revenue Sharing (`procurement.revenue_share_plan`/`revenue_share_line`, สร้างและทดสอบแล้วตาม `B2B_COMMERCE_ENGINE_ARCHITECTURE.md` ข้อ 4.11) คำนวณสัดส่วนแบ่งคืนสมาชิกจาก **เฉพาะรายได้จากการขายผลผลิต** เท่านั้น — ผูกกับ `lot_id` → `produce.delivery` เพื่อหาสัดส่วนปริมาณที่แต่ละหน่วยผลิตส่งมอบเข้าล็อตที่ขายได้ แล้วโอนจากบัญชี `vendor_settlement` ไปยัง `unit_wallet` ของแต่ละหน่วยผลิต

**ช่องว่าง:** ตามข้อ 2.4 บัญชี `vendor_settlement` เป็นบัญชีเดียวที่ใช้ร่วมกันทุกหน้าที่ที่ไม่ใช่ Lender (InputSupplier + Buyer + TractorService + DroneService + HarvesterService + TruckService + DryingYardService + การขายผลผลิต) — เมื่อสหกรณ์มีรายได้จากหลายหน้าที่พร้อมกัน เงินทั้งหมดไหลลงบัญชีเดียวกันโดยไม่มีป้ายกำกับว่ามาจากหน้าที่ไหน `create_revenue_share_plan(invoice_id)` วันนี้ทำงานถูกต้องเฉพาะกรณี invoice มาจากการขายผลผลิต (มี `lot_id` ให้ resolve สัดส่วนได้) — **รายได้จากดอกเบี้ยเงินกู้ ค่าคอมมิชชันขายปัจจัยการผลิต ค่าเช่าเครื่องจักร ค่าบริการลานตาก ยังไม่มีกลไกแบ่งคืนสมาชิกเลย** (ไม่ใช่บั๊ก — เป็นขอบเขตที่ยังไม่ได้ออกแบบ เพราะ Revenue Sharing ถูกสร้างมาสำหรับ use case ขายผลผลิตโดยเฉพาะตั้งแต่ต้น)

**ข้อเสนอ (สองระดับ ทำได้อิสระจากกัน):**

*ระดับรายงาน (ทำง่ายกว่า, ไม่กระทบการโอนเงินจริง):* เพิ่มคอลัมน์ `source_role_type text` ใน `ledger.journal_entry` (หรือสร้าง view ใหม่ `reporting.v_journal_entry_by_role` ที่ join ย้อนกลับจากตารางต้นทาง — `underwriting.loan_application`→`Lender`, `marketplace.product_order`→`InputSupplier`, `marketplace.machinery_booking`→ประเภทเครื่องจักรนั้นๆ) เพื่อให้ `reporting.coop_finance_summary()` (มีอยู่แล้ว, `grant_cooperative_finance_dashboard.sql`) แตกยอดเงินสด/รายรับตามหน้าที่ได้ ไม่ใช่ตัวเลขก้อนเดียวเหมือนวันนี้ — งานนี้เป็น read-only ไม่กระทบ business logic เดิมเลย เหมาะทำก่อน

*ระดับแบ่งเงินจริง (ทำยากกว่า, เปลี่ยน business logic):* ขยาย `procurement.revenue_share_plan` ให้รองรับ `source_type` มากกว่า `'produce_sale'` เช่น `'machinery_rental'`/`'input_supply_commission'`/`'loan_interest'` แต่ละประเภทต้องมีสูตรคำนวณสัดส่วนของตัวเอง (ขายผลผลิตใช้สัดส่วนปริมาณที่ส่งมอบ แต่ค่าเช่าเครื่องจักรอาจต้องใช้สัดส่วนอื่น เช่นตามหุ้นสมาชิก ไม่ใช่ตามปริมาณผลผลิต) — **นี่คือการตัดสินใจเชิงนโยบายของสหกรณ์จริง ไม่ใช่แค่งาน engineering** ต้องยืนยันกับผู้ใช้ก่อนว่าสหกรณ์ต้องการแบ่งรายได้จากหน้าที่เหล่านี้คืนสมาชิกจริงหรือไม่ (บางสหกรณ์อาจเก็บเป็นรายได้สหกรณ์ล้วนๆ ไม่แบ่งคืนก็ได้ ต่างจากรายได้ขายผลผลิตที่เป็นเงินของสมาชิกโดยธรรมชาติอยู่แล้ว)

## 6. ผลกระทบต่อ UI/พอร์ทัล

พอร์ทัลสหกรณ์ (`frontend/coop/`) ควรอ่าน `GET /organization/roles` ตอน login แล้วแสดงเมนูแบบไดนามิกตามบทบาทที่ `Verified` จริงเท่านั้น — หลักการเดียวกับที่ `frontend/dashboard.html` (พอร์ทัลเกษตรกร) อ่าน `GET /farmer/memberships` มาแสดงผล (ดู `FARMER_360_ARCHITECTURE.md` ข้อ 7.1) รูปแบบเมนูที่แนะนำ:

- แสดงเมนูหลัก (รับซื้อผลผลิตจากสมาชิก, ขายส่งผลผลิต) เสมอ — ผูกกับ `org_type='Cooperative'` โดยตรง ไม่ต้องเช็คอะไรเพิ่ม
- แสดงเมนูของแต่ละหน้าที่เสริม (สินเชื่อ/ปัจจัยการผลิต/เครื่องจักร/ลานตาก) **เฉพาะที่ `status==='Verified'`** ในผลลัพธ์ `roles`
- หน้าที่ที่ `status==='Pending'` แสดงเป็น badge "รออนุมัติ" (ใช้ข้อมูลเดียวกับที่มีอยู่แล้ว ไม่ต้องเรียก endpoint เพิ่ม)
- หน้าที่ที่ยังไม่เคยขอเลย (อยู่ใน `requestable_roles`) แสดงเป็นปุ่ม "ขอเปิดใช้งานบริการนี้" เรียก `POST /organization/roles`

**ยังไม่ได้สร้าง** — เอกสารนี้เป็นการออกแบบระดับ backend/data model เท่านั้น ยังไม่ได้แตะ `frontend/coop/dashboard.html`/`js/dashboard.js` จริง การนำเมนูไดนามิกนี้ไปใช้เป็นงานถัดไปที่แยกจากเอกสารนี้

## 7. ไฟล์ที่เกี่ยวข้อง (แผนที่)

| ไฟล์ | สถานะ | หมายเหตุ |
|---|---|---|
| `backend/db/grant_organization_roles.sql` | ✅ มีอยู่แล้ว — เป็นฐานของทั้งเอกสารนี้ | ตาราง `organization_role`, `partner.activate_vendor_role()` |
| `backend/src/routes/organization.js` | ✅ มีอยู่แล้ว | `GET`/`POST /organization/roles` |
| `backend/src/routes/admin.js` | ✅ มีอยู่แล้ว | `POST /organizations/:id/kyb-status`, `POST /organizations/:id/roles/:role_type/status` |
| `backend/src/routes/lender.js`, `inputsupplier.js`, `machinery.js`, `farmermachinery.js`, `fertilizermixing.js`, `villagefund.js` | ✅ มีอยู่แล้ว | ทุกตัวใช้ two-layer check pattern เดียวกัน (ข้อ 2.2) |
| `backend/db/grant_cooperative_tenant_foundation.sql` | ✅ มีอยู่แล้ว | ช่องทางสร้างองค์กร `Cooperative` โดย Platform Ops (`POST /admin/cooperatives`) |
| `backend/src/routes/coopcollection.js` | ✅ มีอยู่แล้ว | รับซื้อผลผลิตจากสมาชิกสหกรณ์ (ผูกกับ `org_type='Cooperative'` ตรง ไม่ผ่าน role) |
| `backend/src/routes/procurement.js` + `B2B_COMMERCE_ENGINE_ARCHITECTURE.md` | ✅ มีอยู่แล้ว | ขายส่งผลผลิตต่อ (RFQ/e-Auction/Contract/PO/Revenue Share) — ไม่เช็ค role_type |
| `backend/db/grant_staff_and_government_access.sql` | ✅ มีอยู่แล้ว (บางส่วน) | `identity.subject_role` (`coop.*` operational roles) — **ยังไม่เชื่อมกับ `organization_role`** (ดูข้อ 5.2) |
| `backend/db/grant_cooperative_finance_dashboard.sql` | ✅ มีอยู่แล้ว | `reporting.coop_finance_summary()` — วันนี้รายงานยอดรวม ไม่แยกตามหน้าที่ (ดูข้อ 5.3) |
| `backend/db/grant_machinery_service_consolidation.sql` | ✅ สร้างและรันจริงบน `agrolink_test` แล้ว (2026-08-17) | ยุบ `TractorService`/`DroneService`/`HarvesterService`/`TruckService` → `MachineryService` — ข้อ 5.1 |
| `backend/src/routes/{auth.js, organization.js, machinery.js, farmermachinery.js}` | ✅ แก้แล้ว (2026-08-17) | รายการ self-register/requestable-role + `MACHINERY_ORG_TYPES` (รองรับทั้ง role เก่า/ใหม่) |
| `frontend/js/register-provider.js`, `register-provider.html`, `machinery/js/dashboard.js`, `admin/js/dashboard.js` | ✅ แก้แล้ว (2026-08-17) | dropdown สมัคร + label แผนที่ role — ข้อ 5.1 |
| `requireOrganizationMemberWithBusinessRole()` + mapping `coop.* → role_type` | 📋 ยังไม่สร้าง — ข้อเสนอข้อ 5.2 | ควรทำก่อนเปิดใช้งานหลายหน้าที่จริงจัง |
| `ledger.journal_entry.source_role_type` หรือ `reporting.v_journal_entry_by_role` | 📋 ยังไม่สร้าง — ข้อเสนอข้อ 5.3 (ระดับรายงาน) | read-only, ทำได้อิสระ |
| Revenue Sharing รองรับ `source_type` อื่นนอกจาก `produce_sale` | 📋 ยังไม่สร้าง — ข้อเสนอข้อ 5.3 (ระดับแบ่งเงินจริง) | **ต้องยืนยันนโยบายกับผู้ใช้ก่อนเริ่มเขียนโค้ด** |
| เมนูไดนามิกใน `frontend/coop/` ตาม `GET /organization/roles` | 📋 ยังไม่สร้าง — ข้อเสนอข้อ 6 | งาน frontend แยกต่างหาก |

## 8. Roadmap สรุป

| Phase | ขอบเขต | สถานะ |
|---|---|---|
| ฐานราก (มีอยู่แล้ว) | Multi-role authorization สองชั้น (entity KYB + role approval) + settlement account แยก Lender/อื่นๆ | ✅ **มีอยู่แล้ว ใช้งานจริง** |
| กรณีศึกษาสหกรณ์ 6 หน้าที่ (เอกสารนี้) | ยืนยันว่า 4 หน้าที่ใช้กลไก role-request ได้ตรง, 2 หน้าที่ (รับซื้อจากสมาชิก/ขายส่งต่อ) ผูกกับ org_type โดยตรงอยู่แล้ว | ✅ **วิเคราะห์เสร็จ — ไม่ต้องเขียนโค้ดใหม่สำหรับส่วนนี้** |
| 5.1 ยุบ role บริการเครื่องจักรเป็น `MachineryService` | รวม 4 role (รถไถ/โดรน/รถเกี่ยว/รถบรรทุก) เป็น role เดียว, `DryingYardService` แยกต่างหากตามเดิม | ✅ **เสร็จสมบูรณ์และทดสอบ end-to-end แล้ว** (2026-08-17 — 17 assertions backend + headless-browser ผ่านหมด) |
| 5.2 Staff permission scoping ตามหน้าที่ | เชื่อม `identity.subject_role` เข้ากับ `identity.organization_role` เพื่อจำกัดพนักงานให้เห็นเฉพาะโมดูลของตัวเอง | 📋 ถัดไป (**แนะนำทำก่อน 5.3** เพราะเป็นความเสี่ยงด้าน security/segregation-of-duties) |
| 5.3a Revenue reporting แยกตามหน้าที่ | `source_role_type` บน ledger หรือ view ใหม่ | 📋 ถัดไป (read-only ทำได้ทันทีไม่ต้องรอ decision) |
| 5.3b Revenue sharing แยกตามหน้าที่ (แบ่งเงินจริงคืนสมาชิก) | ขยาย `revenue_share_plan` รองรับ source_type อื่นนอกจากขายผลผลิต | 📋 **รอการตัดสินใจเชิงนโยบายจากผู้ใช้ก่อน** ว่าสหกรณ์ต้องการแบ่งรายได้หน้าที่ไหนคืนสมาชิกบ้าง |
| 6. เมนูไดนามิกฝั่ง frontend | `frontend/coop/` อ่าน `GET /organization/roles` มาสร้างเมนู | 📋 ถัดไป |
