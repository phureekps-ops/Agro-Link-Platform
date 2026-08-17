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

### 5.2 การจำกัดสิทธิ์พนักงานตามหน้าที่ (staff permission scoping) — ✅ แก้แล้ว 2026-08-17

**สถานะเดิม (ก่อนแก้):** ระบบ staff login รายบุคคล (`identity.register_staff_member()`, `grant_staff_and_government_access.sql`) มี **operational role code** ของสหกรณ์อยู่แล้ว 6 ค่า: `coop.admin`, `coop.manager`, `coop.accountant`, `coop.credit_officer`, `coop.member_officer`, `coop.warehouse_officer` — เก็บใน `identity.subject_role` แยกจาก `identity.organization_role` โดยสิ้นเชิง (คนละตารางคนละแนวคิด: `organization_role` คือ "องค์กรทำหน้าที่นี้ได้ไหม" ส่วน `subject_role` คือ "พนักงานคนนี้ทำอะไรในองค์กรได้") แต่สองระบบนี้ **ไม่ได้เชื่อมกันเลย** — ตอนลงมือแก้พบว่าสถานการณ์จริงแย่กว่าที่เอกสารฉบับก่อนหน้าระบุไว้: `requireOrganizationMember` middleware มีอยู่แล้วใน `middleware/auth.js` แต่ **ไม่ถูกใช้ในไฟล์ route ใดเลยแม้แต่ไฟล์เดียว** — พนักงานที่ login เป็น `subject_type='organization_member'` ยืนยันตัวตนผ่านได้ แต่เข้าถึง business route ใดๆ ไม่ได้เลย (0%) ไม่ใช่แค่ "เข้าได้แบบหยาบๆ ไม่แยกโมดูล" ตามที่เข้าใจไว้ก่อนหน้านี้ — โค้ดคอมเมนต์ใน `coopcollection.js` เองก็ระบุตรงๆ ว่าเรื่องนี้เป็น "real future work — deliberately not attempted here"

**สิ่งที่ทำจริง:** เพิ่มกลไกใหม่ 3 ชิ้นใน `middleware/auth.js` โดยไม่แก้ schema ฐานข้อมูลเลย (ไม่มี migration SQL ใหม่สำหรับข้อนี้):

1. **`STAFF_ROLE_TO_BUSINESS_ROLES`** — mapping ตายตัวในโค้ด จาก operational role_code → รายการ business `role_type` ที่อนุญาต: `coop.admin`/`coop.manager` → `null` (สิทธิ์เต็ม ทุกโมดูลที่ route นั้นขอ — บทบาทกำกับดูแลภาพรวม), `coop.credit_officer` → `['Lender']`, `coop.warehouse_officer` → `['DryingYardService']`, `coop.member_officer` → `['Cooperative']`, `coop.accountant` → `[]` (เป็น role ที่มีจริงแต่ยังไม่มี route ใดผูกกับกลไกนี้ในรอบนี้ — ตั้งใจเว้นว่างไว้ ไม่ใช่ลืม) role_code ที่ไม่อยู่ใน mapping นี้เลย **fail closed ทันที** (403 `operational_role_not_recognized`) ไม่ตกไปที่ "เข้าได้ทุกอย่าง" โดยไม่ตั้งใจ
2. **`requireOrganizationOrStaff`** — gate ระดับ `subject_type` แทนที่ `requireOrganization` เดิมที่หัวไฟล์ route (`router.use(...)`) ให้ทั้ง `'organization'` (shared org login เดิม) และ `'organization_member'` (staff login) ผ่านเข้ามาได้ ส่วนจะเข้าถึงโมดูลไหนได้จริงเช็คในขั้นถัดไป
3. **`resolveEffectiveOrgSubject(req, res, allowedBusinessRoleTypes)`** — เรียกจากภายใน `requireXOrg` เดิมของแต่ละ route (เช่น `requireLenderOrg`, `requireMachineryOrg`) เป็นขั้นตอนแรกก่อนเช็ค KYB/role-Verified เดิม: ถ้าเป็น org login เดิม เป็น no-op (ผ่านทันที ไม่กระทบพฤติกรรมเดิมเลย) ถ้าเป็น staff login จะ resolve `org_id`+`role_code` ของพนักงานคนนั้น เช็คว่า `status='Active'` และ operational role ครอบคลุม module นี้ตาม mapping ข้างต้น บันทึก audit log แยกรายพนักงาน (`subject_type='organization_member', subject_id=member_id`) แล้ว **rewrite `req.subject` ให้เป็นรูป org login** (`{subjectType:'organization', subjectId: org_id}`) — ผลคือโค้ด query เดิมทั้งหมดใน `lender.js`/`machinery.js` (ที่ไม่เคยรู้จักแนวคิด "พนักงาน" มาก่อน) **ไม่ต้องแก้อะไรเลยแม้แต่บรรทัดเดียว** ทำงานถูกต้องทันที พร้อมตั้ง `req.actingStaff = {memberId, roleCode}` ให้ route ที่อยากโชว์ "กำลังใช้งานในนามพนักงานคนไหน" (เช่น dashboard) ดึงไปใช้ได้

**ผูกใช้งานจริงกับ 2 โมดูลตามตัวอย่างที่ผู้ใช้ระบุ:** `lender.js` (`requireLenderOrg`) สำหรับ `coop.credit_officer`, และ `machinery.js` (`requireMachineryOrg`) สำหรับ `coop.warehouse_officer` — ทั้งสองไฟล์เพิ่ม `acting_staff` เข้าไปใน response ของ `GET .../dashboard` ด้วย

**ข้อจำกัดที่รู้ตัวและไม่ได้แก้ในรอบนี้:** `machinery.js` มี "no per-role field gating" ที่ระดับ rate-card/booking อยู่ก่อนแล้ว (ดูข้อ 5.1) — ผลคือ `coop.warehouse_officer` ที่ผ่านเข้า `/machinery/*` ได้เพราะ org มี `DryingYardService` role Verified จะเห็น rate card **รวมเดียวกัน**กับผู้ถือ role เครื่องจักรทุกประเภท ไม่ได้ถูกกรองเหลือแค่รายการลานตากเท่านั้น — การกรองระดับฟิลด์ละเอียดขนาดนั้นต้องแก้ data model ของ `machinery.js` เพิ่มเติม ถือว่าอยู่นอกขอบเขตของงาน staff-permission-gating รอบนี้ (เป็นงานคนละชั้นกัน: รอบนี้คือ "พนักงานคนนี้เข้าโมดูลนี้ได้ไหม" ไม่ใช่ "เข้าโมดูลแล้วเห็นข้อมูลกรองละเอียดแค่ไหน")

`coop.accountant` (M04 Cooperative Finance) ยังไม่ได้ผูก route ใดในรอบนี้เช่นกัน (ไม่มี route ธุรกิจแยกสำหรับโมดูลนี้ที่ชัดเจนพอจะ retrofit ได้ตอนนี้) — mapping ตั้งเป็น `[]` ไว้รอ ไม่ใช่ `null`/ไม่มีเลย

**ไฟล์ที่แก้:** `backend/src/middleware/auth.js` (กลไกใหม่ทั้งหมด), `backend/src/routes/lender.js`, `backend/src/routes/machinery.js` — **ไม่มี migration SQL ใหม่** (ไม่แก้ schema เลย ใช้ `identity.organization_member`/`identity.subject_role` ที่มีอยู่แล้วจาก `grant_staff_and_government_access.sql`)

**ทดสอบแล้ว:** backend 25 assertions ครอบคลุม (1) org shared login ยังเข้าได้ทั้งสองพอร์ทัลเหมือนเดิมทุกประการ `acting_staff:null` (2) สร้างพนักงาน 4 คน 4 operational role ผ่าน `POST /coop/staff` (3) `coop.credit_officer` เข้า `/lender/dashboard` ได้ ถูกปฏิเสธจาก `/machinery/dashboard` ด้วย `operational_role_does_not_cover_module` (4) `coop.warehouse_officer` เข้า `/machinery/dashboard` ได้ (เห็น `DryingYardService` ใน `service_types`) ถูกปฏิเสธจาก `/lender/dashboard` (5) `coop.member_officer` ถูกปฏิเสธจากทั้งสองโมดูล (ไม่ครอบคลุมโมดูลใดเลยตาม mapping) (6) `coop.admin` (oversight, `null` mapping) เข้าได้ทั้งสองโมดูล (7) deactivate พนักงานผ่าน `POST /coop/staff/:id/deactivate` แล้วเรียกซ้ำทันทีถูกปฏิเสธด้วย `staff_member_inactive` — **ผ่านครบทั้ง 25 ข้อ** และรัน regression suite ของข้อ 5.1 ซ้ำ (17 assertions) ยืนยันไม่กระทบงานยุบ role เครื่องจักรที่ทำไปก่อนหน้า — ล้างข้อมูลทดสอบเรียบร้อย

ยังไม่ได้ทำ (นอกขอบเขตรอบนี้ ตามที่ระบุไว้ข้างบน): field-level gating ในรายการ rate card ของ `machinery.js`, การผูก route ให้ `coop.accountant`, และหน้า UI ฝั่ง frontend ที่โชว์ `acting_staff` (ยังไม่มี frontend surface ใดอ่านค่านี้ — เป็น backend authorization change ล้วนๆ ในรอบนี้)

### 5.3 การแยกบัญชี/รายได้ตามหน้าที่ สำหรับแบ่งปันคืนสมาชิก

**สถานะปัจจุบัน:** ระบบ Revenue Sharing (`procurement.revenue_share_plan`/`revenue_share_line`, สร้างและทดสอบแล้วตาม `B2B_COMMERCE_ENGINE_ARCHITECTURE.md` ข้อ 4.11) คำนวณสัดส่วนแบ่งคืนสมาชิกจาก **เฉพาะรายได้จากการขายผลผลิต** เท่านั้น — ผูกกับ `lot_id` → `produce.delivery` เพื่อหาสัดส่วนปริมาณที่แต่ละหน่วยผลิตส่งมอบเข้าล็อตที่ขายได้ แล้วโอนจากบัญชี `vendor_settlement` ไปยัง `unit_wallet` ของแต่ละหน่วยผลิต

**ช่องว่าง:** ตามข้อ 2.4 บัญชี `vendor_settlement` เป็นบัญชีเดียวที่ใช้ร่วมกันทุกหน้าที่ที่ไม่ใช่ Lender (InputSupplier + Buyer + TractorService + DroneService + HarvesterService + TruckService + DryingYardService + การขายผลผลิต) — เมื่อสหกรณ์มีรายได้จากหลายหน้าที่พร้อมกัน เงินทั้งหมดไหลลงบัญชีเดียวกันโดยไม่มีป้ายกำกับว่ามาจากหน้าที่ไหน `create_revenue_share_plan(invoice_id)` วันนี้ทำงานถูกต้องเฉพาะกรณี invoice มาจากการขายผลผลิต (มี `lot_id` ให้ resolve สัดส่วนได้) — **รายได้จากดอกเบี้ยเงินกู้ ค่าคอมมิชชันขายปัจจัยการผลิต ค่าเช่าเครื่องจักร ค่าบริการลานตาก ยังไม่มีกลไกแบ่งคืนสมาชิกเลย** (ไม่ใช่บั๊ก — เป็นขอบเขตที่ยังไม่ได้ออกแบบ เพราะ Revenue Sharing ถูกสร้างมาสำหรับ use case ขายผลผลิตโดยเฉพาะตั้งแต่ต้น)

#### 5.3a การแยกบันทึก/รายงานตามหน้าที่ — ✅ แก้แล้ว 2026-08-17 (เฉพาะขายส่ง)

**สิ่งที่ทำจริง:** เพิ่มคอลัมน์ `source_role_type text` (nullable, ไม่มี `CHECK`) ใน `ledger.journal_entry` และเพิ่มพารามิเตอร์ใหม่ `p_source_role_type` ใน `ledger.transfer_funds()` — ดู `grant_ledger_revenue_segregation.sql` สำหรับรายละเอียดเต็ม รวมถึงข้อควรระวังเรื่อง `CREATE OR REPLACE FUNCTION` ที่เพิ่มพารามิเตอร์ต่อท้ายจะสร้าง overload ใหม่แทนที่จะแทนที่ของเดิม (ทดสอบยืนยันแล้วก่อนเขียน migration จริง) จึงต้อง `DROP FUNCTION` ลายเซ็นเดิมก่อน เพิ่มฟังก์ชันรายงานใหม่ `reporting.coop_revenue_by_function(p_org_id)` เปิดผ่าน `GET /coop/finance/revenue-by-function` และเพิ่มคอลัมน์ `source_role_type` ใน `GET /coop/finance/transactions` ที่มีอยู่แล้ว

**สิ่งที่ค้นพบระหว่าง implement ซึ่งเปลี่ยนขอบเขตงานทั้งหมด:** ตรวจ `ledger.transfer_funds()` call site จริงทุกจุดในโค้ด (ไม่ใช่แค่เดาจาก schema) พบว่าใน 5 หมวดรายได้ที่ยกตัวอย่างไว้ตอนแรก (ดอกเบี้ยเงินกู้ + ค่าคอมมิชชันขายปัจจัยการผลิต + ค่าเช่าเครื่องจักร + ค่าลานตาก + ส่วนต่างขายส่ง) มีเพียง **"ส่วนต่างขายส่ง" (ผ่าน `procurement.pay_invoice()`) เท่านั้น** ที่มีเงินไหลผ่านเลดเจอร์จริงในแอปวันนี้:

- **ดอกเบี้ยเงินกู้:** `credit.repay_loan()` มีอยู่ใน schema ตั้งแต่ layer แรกๆ ของโปรเจกต์ แต่**ไม่มี route ไหนในทั้งระบบเรียกใช้เลย** — ไม่ใช่การตั้งใจให้ชำระนอกระบบ แค่ยังไม่มีใครสร้าง endpoint ให้เกษตรกร/องค์กรกดชำระคืนสินเชื่อได้
- **ค่าเช่าเครื่องจักร / ค่าลานตาก:** ใช้ `marketplace.machinery_booking` (`grant_machinery_booking.sql`) ซึ่ง**ตั้งใจให้ชำระเงินนอกระบบโดยตรงระหว่างเกษตรกรกับผู้ให้บริการ** ตามคอมเมนต์ในไฟล์ migration นั้นเอง — AgroLink ไม่เคยยืนยันว่าจ่ายเงินจริงหรือไม่ กลไกเก่า `marketplace.service_request`/`complete_service_request()` ที่เคยโอนเงินผ่านเลดเจอร์จริงถูกแทนที่ไปแล้วและไม่มี route เรียกใช้อีก (ดูข้อ 5.1 และคอมเมนต์ใน `grant_machinery_booking.sql`)
- **ค่าคอมมิชชันขายปัจจัยการผลิต:** `POST /inputsupplier/orders/:id/fulfill` ไม่มีขั้นตอนชำระเงินผ่านเลดเจอร์เลยเช่นกัน (รูปแบบเดียวกับข้อข้างบน)

จึงติด tag เฉพาะเส้นทางขายส่งเท่านั้นในรอบนี้ (ตามที่ผู้ใช้ยืนยันหลังเห็นผลตรวจโค้ดจริง — ทำเท่าที่มีข้อมูลจริงให้ tag ระบุชัดเจนว่าอีก 4 หมวดยังไม่มีข้อมูล ดีกว่าเดาหรือสร้างรายงานที่ดูครบแต่ว่างเปล่า) `ledger.journal_entry` แถวเก่าทั้งหมดก่อน migration นี้ และแถวใหม่จากฟังก์ชันอื่นที่ยังไม่ได้แก้ (`credit.repay_loan`, `ledger.hold_escrow`/`release_escrow`, `marketplace.complete_service_request`, `produce.settle_delivery`) จะมี `source_role_type IS NULL` ตลอด — `reporting.coop_revenue_by_function()` แสดงแถว NULL นี้ตรงๆ ไม่กรองทิ้ง เพื่อให้รายงานสื่อสารตรงว่า "ยังไม่ระบุหน้าที่" แทนที่จะดูเหมือนรายงานครบถ้วนทั้งที่มีข้อมูลจริงแค่หมวดเดียว

**ไฟล์ที่แก้:** `backend/db/grant_ledger_revenue_segregation.sql` (migration ใหม่ — เพิ่มคอลัมน์ + แก้ `ledger.transfer_funds()`/`procurement.pay_invoice()` + ฟังก์ชันรายงานใหม่), `backend/src/routes/coopcollection.js` (route ใหม่ + คอลัมน์เพิ่มใน route เดิม)

**ทดสอบแล้ว:** backend 21 assertions (สร้างสหกรณ์+ผู้ซื้อใหม่ผ่าน admin flow, เดินสายโซ่ RFQ→quote→accept→PO→GRN→invoice→pay ของ B2B Commerce Engine จนจบ, ยืนยัน `source_role_type='Wholesale'` ปรากฏทั้งใน `GET /coop/finance/transactions` และแถวรวมของ `GET /coop/finance/revenue-by-function` ตรงกับยอด invoice เป๊ะ, ยืนยัน `GET /coop/finance/summary` เดิมยังทำงานปกติไม่กระทบ) + smoke test แยกยืนยันว่า caller เดิมที่เรียก `transfer_funds()` แบบ positional argument (รูปแบบเดียวกับ `hold_escrow`) ยังทำงานได้ปกติหลัง migration และได้ `source_role_type = NULL` ตามที่ควรจะเป็น + รัน regression suite ของข้อ 5.1/5.2 ซ้ำ (17 + 25 assertions) ยืนยันไม่กระทบงานก่อนหน้า ล้างข้อมูลทดสอบเรียบร้อย

**ยังไม่ได้ทำ (นอกขอบเขตรอบนี้ ตามที่ผู้ใช้ยืนยัน):** ไม่ได้สร้าง route ให้ `credit.repay_loan()` ใช้งานได้จริง, ไม่ได้เปลี่ยนค่าเช่าเครื่องจักร/ค่าลานตาก/ค่าคอมมิชชันขายปัจจัยการผลิตให้ขึ้นเลดเจอร์ (เป็นการตัดสินใจเชิงผลิตภัณฑ์ที่กระทบผู้ใช้จริง ไม่ใช่แค่งาน schema) — ทั้งสามงานนี้เป็นเงื่อนไขล่วงหน้าก่อนที่ `reporting.coop_revenue_by_function()` จะมีแถวจริงมากกว่า `'Wholesale'`/`NULL`

#### 5.3b การแบ่งเงินจริงคืนสมาชิกตามหน้าที่ — ยังไม่ทำ

**ข้อเสนอ (ทำยากกว่า, เปลี่ยน business logic):** ขยาย `procurement.revenue_share_plan` ให้รองรับ `source_type` มากกว่า `'produce_sale'` เช่น `'machinery_rental'`/`'input_supply_commission'`/`'loan_interest'`/`'wholesale'` แต่ละประเภทต้องมีสูตรคำนวณสัดส่วนของตัวเอง (ขายผลผลิตใช้สัดส่วนปริมาณที่ส่งมอบ แต่ค่าเช่าเครื่องจักรอาจต้องใช้สัดส่วนอื่น เช่นตามหุ้นสมาชิก ไม่ใช่ตามปริมาณผลผลิต) — **นี่คือการตัดสินใจเชิงนโยบายของสหกรณ์จริง ไม่ใช่แค่งาน engineering** ยังไม่ได้ตัดสินใจว่าจะใช้เกณฑ์ไหน (ผู้ใช้ยืนยันเมื่อ 2026-08-17 ว่ายังไม่ตัดสินใจตอนนี้ ให้ทำแค่ชั้นบันทึก/รายงาน 5.3a ก่อน) ต้องยืนยันกับผู้ใช้ก่อนว่าสหกรณ์ต้องการแบ่งรายได้จากหน้าที่เหล่านี้คืนสมาชิกจริงหรือไม่ (บางสหกรณ์อาจเก็บเป็นรายได้สหกรณ์ล้วนๆ ไม่แบ่งคืนก็ได้ ต่างจากรายได้ขายผลผลิตที่เป็นเงินของสมาชิกโดยธรรมชาติอยู่แล้ว) และยังต้องรอ 5.3a ขยายให้ครบทั้ง 5 หมวดก่อน (ตอนนี้มีข้อมูลจริงให้แบ่งแค่หมวดขายส่งเท่านั้น)

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
| `backend/db/grant_staff_and_government_access.sql` | ✅ มีอยู่แล้ว | `identity.subject_role` (`coop.*` operational roles) — เชื่อมกับ `organization_role` แล้ว (ดูข้อ 5.2) |
| `backend/db/grant_cooperative_finance_dashboard.sql` | ✅ มีอยู่แล้ว | `reporting.coop_finance_summary()` — วันนี้รายงานยอดรวม ไม่แยกตามหน้าที่ (ดูข้อ 5.3) |
| `backend/db/grant_machinery_service_consolidation.sql` | ✅ สร้างและรันจริงบน `agrolink_test` แล้ว (2026-08-17) | ยุบ `TractorService`/`DroneService`/`HarvesterService`/`TruckService` → `MachineryService` — ข้อ 5.1 |
| `backend/src/routes/{auth.js, organization.js, machinery.js, farmermachinery.js}` | ✅ แก้แล้ว (2026-08-17) | รายการ self-register/requestable-role + `MACHINERY_ORG_TYPES` (รองรับทั้ง role เก่า/ใหม่) |
| `frontend/js/register-provider.js`, `register-provider.html`, `machinery/js/dashboard.js`, `admin/js/dashboard.js` | ✅ แก้แล้ว (2026-08-17) | dropdown สมัคร + label แผนที่ role — ข้อ 5.1 |
| `backend/src/middleware/auth.js` (`resolveEffectiveOrgSubject`, `requireOrganizationOrStaff`, `STAFF_ROLE_TO_BUSINESS_ROLES`) | ✅ สร้างแล้ว (2026-08-17) | กลไก staff-permission-gating หลัก — ข้อ 5.2 |
| `backend/src/routes/lender.js`, `machinery.js` (`requireLenderOrg`/`requireMachineryOrg` เรียก `resolveEffectiveOrgSubject`) | ✅ แก้แล้ว (2026-08-17) | ผูก `coop.credit_officer`→Lender, `coop.warehouse_officer`→DryingYardService — ข้อ 5.2 |
| `backend/db/grant_ledger_revenue_segregation.sql` | ✅ สร้างและรันจริงบน `agrolink_test` แล้ว (2026-08-17) | เพิ่ม `ledger.journal_entry.source_role_type` + แก้ `transfer_funds()`/`pay_invoice()` + `reporting.coop_revenue_by_function()` — ข้อ 5.3a (เฉพาะขายส่ง) |
| `backend/src/routes/coopcollection.js` (`GET /coop/finance/revenue-by-function`, คอลัมน์ใหม่ใน `GET /coop/finance/transactions`) | ✅ แก้แล้ว (2026-08-17) | ข้อ 5.3a |
| Revenue Sharing รองรับ `source_type` อื่นนอกจาก `produce_sale` | 📋 ยังไม่สร้าง — ข้อเสนอข้อ 5.3b (ระดับแบ่งเงินจริง) | **ต้องยืนยันนโยบายกับผู้ใช้ก่อนเริ่มเขียนโค้ด** (ผู้ใช้ยืนยันแล้วว่ายังไม่ตัดสินใจตอนนี้) |
| Route จริงให้ `credit.repay_loan()` ใช้งานได้ / นำค่าเช่าเครื่องจักร-ค่าลานตาก-ค่าคอมมิชชันขึ้นเลดเจอร์ | 📋 ยังไม่สร้าง — พบระหว่าง implement ข้อ 5.3a | เงื่อนไขล่วงหน้าก่อน 5.3a จะครบทั้ง 5 หมวด และก่อน 5.3b จะมีอะไรให้แบ่งนอกจากขายส่ง |
| เมนูไดนามิกใน `frontend/coop/` ตาม `GET /organization/roles` | 📋 ยังไม่สร้าง — ข้อเสนอข้อ 6 | งาน frontend แยกต่างหาก |

## 8. Roadmap สรุป

| Phase | ขอบเขต | สถานะ |
|---|---|---|
| ฐานราก (มีอยู่แล้ว) | Multi-role authorization สองชั้น (entity KYB + role approval) + settlement account แยก Lender/อื่นๆ | ✅ **มีอยู่แล้ว ใช้งานจริง** |
| กรณีศึกษาสหกรณ์ 6 หน้าที่ (เอกสารนี้) | ยืนยันว่า 4 หน้าที่ใช้กลไก role-request ได้ตรง, 2 หน้าที่ (รับซื้อจากสมาชิก/ขายส่งต่อ) ผูกกับ org_type โดยตรงอยู่แล้ว | ✅ **วิเคราะห์เสร็จ — ไม่ต้องเขียนโค้ดใหม่สำหรับส่วนนี้** |
| 5.1 ยุบ role บริการเครื่องจักรเป็น `MachineryService` | รวม 4 role (รถไถ/โดรน/รถเกี่ยว/รถบรรทุก) เป็น role เดียว, `DryingYardService` แยกต่างหากตามเดิม | ✅ **เสร็จสมบูรณ์และทดสอบ end-to-end แล้ว** (2026-08-17 — 17 assertions backend + headless-browser ผ่านหมด) |
| 5.2 Staff permission scoping ตามหน้าที่ | เชื่อม `identity.subject_role` เข้ากับ `identity.organization_role` เพื่อจำกัดพนักงานให้เห็นเฉพาะโมดูลของตัวเอง | ✅ **เสร็จสมบูรณ์และทดสอบ end-to-end แล้ว** (2026-08-17 — 25 assertions ผ่านหมด + regression 17 assertions ของข้อ 5.1 ยังผ่าน ไม่มี migration SQL ใหม่) |
| 5.3a Revenue reporting แยกตามหน้าที่ | `source_role_type` บน `ledger.journal_entry` + `reporting.coop_revenue_by_function()` | ✅ **เสร็จสมบูรณ์และทดสอบ end-to-end แล้ว** (2026-08-17 — 21 assertions ผ่านหมด, แต่ตรวจโค้ดจริงพบว่ามีเพียง "ขายส่ง" ใน 5 หมวดที่ขอตอนแรกที่มีเงินไหลผ่านเลดเจอร์จริงวันนี้ — อีก 4 หมวดยังไม่มี route/กลไกชำระเงินผ่านระบบเลย ไม่ใช่แค่ยังไม่ได้ tag) |
| 5.3b Revenue sharing แยกตามหน้าที่ (แบ่งเงินจริงคืนสมาชิก) | ขยาย `revenue_share_plan` รองรับ source_type อื่นนอกจากขายผลผลิต | 📋 **รอการตัดสินใจเชิงนโยบายจากผู้ใช้ก่อน** (ยืนยันแล้วเมื่อ 2026-08-17 ว่ายังไม่ตัดสินใจตอนนี้) และรอให้อีก 4 หมวดมีเส้นทางชำระเงินผ่านเลดเจอร์จริงก่อน จึงจะมีอะไรให้แบ่งนอกจากขายส่ง |
| 6. เมนูไดนามิกฝั่ง frontend | `frontend/coop/` อ่าน `GET /organization/roles` มาสร้างเมนู | 📋 ถัดไป |
