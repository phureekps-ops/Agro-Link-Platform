# AgroLink Farmer 360° View — Architecture

**สถานะเอกสาร:** ฉบับที่ 1 — ออกแบบ 2026-08-17
**ผู้ร้องขอ:** "เกษตรกรเป็นสมาชิกได้หลายหน่วยงานทั้ง ธ.ก.ส. สหกรณ์ กองทุนหมู่บ้าน ธนาคารอื่นๆ กองทุนอื่นๆ — เจ้าหน้าที่แต่ละหน่วยงานควรดูข้อมูลเกษตรกรแบบรวมศูนย์ได้ (Farmer 360°) แต่แต่ละหน่วยงานเห็นเฉพาะข้อมูลที่ตัวเองมีสิทธิ์เห็นเท่านั้น"

**ขอบเขตรอบนี้ (ตัดสินใจร่วมกับผู้ใช้ 2026-08-17):** สร้าง **MVP** ก่อน — สมาชิกภาพหลายหน่วยงาน + ที่ดิน/ฟาร์ม + ธุรกรรม (เฉพาะกับหน่วยงานที่ดูอยู่) **ยังไม่มีระบบ consent และยังไม่แสดง Credit Score ในรอบนี้** (ดูเหตุผลที่ข้อ 3 และ 5) ใช้งานได้พร้อมกันใน 3 พอร์ทัล: สหกรณ์ (Cooperative), ผู้ปล่อยกู้ (Lender — ใช้แทน "ธนาคาร" ทั่วไปรวมถึง ธ.ก.ส. เพราะเป็น org_type เดียวที่มีพอร์ทัลอยู่แล้ว ดูข้อ 6), และกองทุนหมู่บ้าน (VillageFund — พอร์ทัลใหม่ทั้งหมด สร้างในรอบนี้)

## 1. หลักการออกแบบ

1. **ต่อยอดของเดิม ไม่สร้างซ้ำ** — สำรวจ schema เดิมก่อนออกแบบตารางใหม่ (ดูข้อ 2) พบว่ามีโครงกระดูกที่ใช้ได้อยู่แล้ว (`reporting.v_farmer_360` มี join สำคัญไว้แล้ว, `govgw.consent` มี pattern การทำ consent ไว้แล้วแม้ grain จะไม่ตรง) แต่ **ยังไม่มีตาราง "สมาชิกภาพเกษตรกร↔องค์กร" อยู่เลย** — เป็นช่องว่างที่ใหญ่ที่สุดที่ต้องสร้างใหม่จริงๆ
2. **"No row-level security, explicit WHERE clause IS the security boundary"** — ตามธรรมเนียมเดิมของ `marketplace.*`/`procurement.*` — ยกเว้นจุดเดียวที่ต่างจากนี้คือ `risk.credit_score` ที่มี RLS แบบ FORCE ไว้อย่างจงใจ (ดูข้อ 5)
3. **Consent เป็น decision จริงที่ต้องคิดให้รอบคอบ ไม่ใช่ flag เปิด/ปิดง่ายๆ** — โค้ดเดิมของระบบ (`government.js`, `grant_analytics_warehouse.sql`) มีคอมเมนต์ระบุชัดเจนว่าการเปิดให้เห็น credit score ข้ามองค์กรเป็น "การตัดสินใจเชิงนโยบายจริงๆ ไม่ใช่การแก้ไขเงียบๆ" — เอกสารนี้จึงแยก MVP (ไม่มี consent, ไม่มี credit score) ออกจาก Phase 2 (มี consent + credit score เต็มรูปแบบ) อย่างชัดเจน
4. **"Manual today, real integration later" honesty pattern** สืบทอดจากทุกฟีเจอร์ก่อนหน้า — จุดที่ยังไม่ auto-wire ระบุไว้ชัดเจนในเอกสารนี้และใน `backend/README.md`

## 2. สิ่งที่มีอยู่แล้ว vs. สิ่งที่ต้องสร้างใหม่ (สำรวจ schema ก่อนออกแบบ)

| รายการ | สถานะ | รายละเอียด |
|---|---|---|
| Multi-org membership พร้อมกันหลายหน่วยงาน | ✅ **ไม่มีอะไรบล็อกอยู่แล้ว** | ไม่มี unique constraint ใดๆ ในระบบที่ห้ามเกษตรกรคนหนึ่งมีความสัมพันธ์กับหลายองค์กรพร้อมกัน (`organization_member`, `loan_application`, `product_order`, `machinery_booking` ทุกตัวไม่มี unique ผูกกับ farmer_id เดี่ยวๆ) |
| ตาราง "สมาชิกภาพ" เกษตรกร↔องค์กร | ❌ **ไม่มีอยู่เลย — ต้องสร้างใหม่** | `identity.organization_member` เป็นตารางพนักงาน/ผู้แทนองค์กร (staff login) ไม่ใช่ตารางสมาชิกเกษตรกร; `registry.cooperative_profile.member_count_reported` เป็นตัวเลขที่สหกรณ์กรอกเองล้วนๆ ไม่ใช่ COUNT จริง — คอมเมนต์ในไฟล์เดิมยอมรับตรงๆ ว่า "ยังไม่มีการนำเข้าสมาชิกจริงในขั้นนี้" |
| Consent infrastructure | 🔶 **มี pattern ให้ก๊อป แต่ grain ผิด** | `govgw.consent` คือ org→รัฐ (องค์กรยินยอมให้ส่งข้อมูลตัวเองให้หน่วยงานรัฐ) ไม่ใช่ farmer→org ต้องสร้างตารางใหม่แต่ก๊อปโครง (Active/Revoked lifecycle) ได้ — **Phase 2 เท่านั้น ไม่ทำรอบนี้** |
| Credit Score | 🔶 **มีอยู่แล้ว แต่ถูกกันไว้ไม่ให้องค์กรเห็นโดยเจตนา** | `risk.credit_score` มี `FORCE ROW LEVEL SECURITY` และมี policy แค่ 2 อัน (`farmer_own_score`, `platform_all_scores`) — ไม่มี policy สำหรับ `organization`/`organization_member` เลย หมายความว่าวันนี้ session องค์กรจะได้ 0 แถวเสมอ — **Phase 2 เท่านั้น ไม่ทำรอบนี้** (ดูข้อ 5) |
| Aggregation join พื้นฐาน | ✅ **มีแล้ว ใช้เป็นฐาน** | `reporting.v_farmer_360` (มีอยู่แล้ว ใช้จริงใน `GET /farmer/dashboard`) มี join ที่ถูกต้องอยู่แล้ว: `production_unit → contract_party → farmer`, `production_unit → delivery` — แต่ scope วันนี้คือ "เกษตรกรดูของตัวเอง" เท่านั้น (ผ่าน RLS ของตารางลูก) ยังไม่รวม `product_order`/`machinery_booking`/fertilizer-mixing และไม่มี consent-based filtering |
| Staff/officer login | ✅ **มีอยู่แล้ว ใช้ shared org login พอสำหรับรอบนี้** | Lender/Cooperative/VillageFund ทุก org_type ใช้ shared org-level login (`subject_type='organization'`) ได้อยู่แล้ววันนี้โดยไม่ต้องแก้อะไร — ระบบ named-individual staff login (`register_staff_member`) วันนี้รองรับเฉพาะ `role_code LIKE 'coop.%'` เท่านั้น การขยายไปยัง Lender/VillageFund เป็น Phase 2 |
| AgroLink ID (เช่น AF-000001) | ❌ **ไม่มีอยู่เลย — ต้องสร้างใหม่** | `identity.farmer` ไม่มีคอลัมน์รหัสสาธารณะใดๆ นอกจาก UUID — ทำรอบนี้เพราะมี cost ต่ำและช่วยให้ค้นหาเกษตรกรได้โดยไม่ต้องรู้เบอร์โทร/เลขบัตร |
| พอร์ทัล VillageFund | ❌ **ไม่มีอยู่เลย — ต้องสร้างใหม่ทั้งหมด** | `org_type='VillageFund'` มีอยู่แล้วใน DB constraint (ทั้ง `identity.organization` และ `identity.organization_role`) แต่ไม่เคยมี frontend และไม่อยู่ใน `ORG_SELF_REGISTER_TYPES` ของ `auth.js` (ดูข้อ 6) |

## 3. โมเดลข้อมูลใหม่ — สมาชิกภาพ (Membership / Relationship Roster)

### `identity.farmer_org_relationship`

```sql
CREATE TABLE identity.farmer_org_relationship (
  relationship_id     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  farmer_id            uuid NOT NULL REFERENCES identity.farmer(farmer_id),
  org_id                uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  relationship_type      text NOT NULL, -- CooperativeMember|VillageFundMember|LoanCustomer|Other (มาจาก org_type อัตโนมัติ ไม่รับจาก client)
  status                  text NOT NULL DEFAULT 'active', -- active|ended
  joined_at                timestamptz NOT NULL DEFAULT now(),
  ended_at                 timestamptz,
  created_by_subject_type   text NOT NULL, -- organization|platform
  created_by_subject_id     uuid NOT NULL,
  notes                     text,
  created_at, updated_at,
  CONSTRAINT uq_farmer_org_relationship UNIQUE (farmer_id, org_id)
);
```

- **สร้างผ่านฟังก์ชัน `identity.link_farmer_to_org(p_farmer_id, p_org_id, p_created_by_subject_type, p_created_by_subject_id, p_notes)`** — ไม่ให้ client ส่ง `relationship_type` มาเอง ฟังก์ชัน resolve จาก `identity.organization.org_type` ให้เอง (`Cooperative→CooperativeMember`, `VillageFund→VillageFundMember`, `Lender`/`Bank→LoanCustomer`, อื่นๆ→`Other`) — กันไม่ให้ข้อมูล type ผิดเพี้ยนจากการกรอกมือ, `ON CONFLICT (farmer_id, org_id) DO UPDATE` (รองรับการ "เพิ่มสมาชิกกลับมาใหม่" หลังเคย unlink)
- **`identity.unlink_farmer_from_org(p_farmer_id, p_org_id)`** — ตั้ง `status='ended', ended_at=now()` ไม่ลบแถวจริง (เก็บประวัติไว้)
- **สองวิธีเพิ่มสมาชิก:** (1) เจ้าหน้าที่ค้นหาเกษตรกรด้วยรหัส AgroLink ID หรือเบอร์โทรที่ตรงเป๊ะ (ดูข้อ 4) แล้วกด "เพิ่มเป็นสมาชิก/ลูกค้า", (2) endpoint sync อัตโนมัติที่สแกนธุรกรรมเดิมที่มีอยู่แล้ว (`produce.delivery`/`loan_application`/`product_order`/`machinery_booking`) ของหน่วยงานตัวเอง แล้วสร้างความสัมพันธ์ให้อัตโนมัติสำหรับเกษตรกรที่เคยทำธุรกรรมด้วยแต่ยังไม่มีแถว relationship — แก้ปัญหา "ยังไม่มีการนำเข้าสมาชิกจริง" ที่ระบบเดิมยอมรับไว้ตรงๆ

### `identity.farmer.farmer_code` (AgroLink ID)

```sql
ALTER TABLE identity.farmer ADD COLUMN IF NOT EXISTS farmer_code text UNIQUE;
CREATE SEQUENCE IF NOT EXISTS identity.farmer_code_seq;
-- backfill เกษตรกรเดิมตามลำดับ created_at ก่อน (ROW_NUMBER, ไม่ใช่พึ่ง UPDATE...nextval() ที่ลำดับแถวไม่แน่นอน)
-- แล้วตั้ง sequence ให้ต่อจากเลขสูงสุดที่ backfill ไปแล้ว
-- trigger BEFORE INSERT ON identity.farmer ให้เกษตรกรใหม่ได้รหัสอัตโนมัติ รูปแบบ AF-000001
```

## 4. ขอบเขตการมองเห็นข้อมูล (Visibility Model) — MVP นี้ *ไม่มี consent workflow*

**นี่คือจุดที่ต้องระบุให้ชัดเจนที่สุด เพราะเป็นหัวใจของคำขอ "หน้าจอของสหกรณ์เห็นเฉพาะที่มีสิทธิ์เห็น"** เนื่องจากยังไม่มีระบบ consent ในรอบนี้ (ตามที่ตัดสินใจไว้) เอกสารนี้กำหนดกฎการมองเห็นข้อมูลเริ่มต้น (default) ไว้ล่วงหน้า โดยแยกตามระดับความอ่อนไหวของข้อมูล:

| ส่วนข้อมูล | ใครเห็นได้ | เหตุผล |
|---|---|---|
| ข้อมูลพื้นฐานเกษตรกร (ชื่อ, รหัส AgroLink ID, เบอร์โทร, ภูมิภาค) | องค์กรที่มีความสัมพันธ์ (`farmer_org_relationship.status='active'`) กับเกษตรกรคนนั้นเท่านั้น | ต้องเป็น "ลูกค้า/สมาชิก" ของตัวเองก่อนถึงจะดูได้ ป้องกัน browse ข้อมูลเกษตรกรทั้งระบบ |
| ที่ดิน/ฟาร์ม (พืช, ไร่) | เหมือนข้างบน — เห็นทั้งหมด ไม่แยกตามองค์กรผู้ดู | ข้อมูลเกษตรกรรมความอ่อนไหวต่ำ มีประโยชน์กับทุกหน่วยงานที่เกี่ยวข้อง (เช่น ผู้ปล่อยกู้อยากรู้พื้นที่เพื่อประเมินหลักประกัน) |
| **สมาชิกภาพกับ "องค์กรอื่น"** (badge "✓ สหกรณ์ A / ✓ กองทุนหมู่บ้าน B / ✓ ธ.ก.ส.") | เหมือนข้างบน — **แสดงแค่ชื่อ+ประเภทองค์กรอื่นที่เกษตรกรสังกัดอยู่ ไม่แสดงมูลค่า/รายละเอียดธุรกรรมขององค์กรอื่น** | นี่คือหัวใจของ "360 องศา" ตามที่ผู้ใช้ขอ (เห็นว่าเกษตรกรเป็นสมาชิกที่ไหนบ้าง) — ความเสี่ยงข้อมูลรั่วจำกัดอยู่ที่ "มีความสัมพันธ์อยู่" เท่านั้น ไม่ใช่ตัวเลขเงิน — **หมายเหตุ: นี่เป็นการตัดสินใจของรอบนี้ที่ควรทบทวนอีกครั้งเมื่อสร้างระบบ consent ใน Phase 2** (เกษตรกรอาจอยากซ่อนแม้แต่การมีสมาชิกภาพจากบางองค์กร) |
| ธุรกรรม (ซื้อปุ๋ย, ขายข้าว, เครื่องจักร, สินเชื่อ) | **เห็นเฉพาะธุรกรรมที่ทำกับ "องค์กรตัวเอง" เท่านั้น** — ไม่เห็นยอดเงิน/รายละเอียดธุรกรรมที่เกษตรกรทำกับองค์กรอื่น | ป้องกันการรั่วไหลของข้อมูลการเงินข้ามสถาบัน ซึ่งอ่อนไหวกว่าการรู้แค่ "มีสมาชิกภาพ" มาก — ต้องรอ consent workflow (Phase 2) ก่อนถึงจะเปิดข้ามองค์กรได้ |
| Credit Score | **ไม่แสดงเลยในรอบนี้** (ทั้งของตัวเองและอื่น) | `risk.credit_score` มี RLS กันไว้อย่างจงใจ, ผู้ใช้ตัดสินใจแล้วว่ารอบนี้ยังไม่ทำ — เมื่อทำ Phase 2 ผู้ใช้ระบุไว้แล้วว่าให้ "แสดงคะแนนเต็ม (0-100) เมื่อเกษตรกรยินยอม" ไม่ใช่แค่ risk tier |
| Consent | placeholder "จะเปิดใช้งานเร็วๆ นี้" — ยังไม่มีฟังก์ชันจริง | รอ Phase 2 |

## 5. Phase 2 (ยังไม่ทำรอบนี้) — Consent + Credit Score

บันทึกไว้ล่วงหน้าเพื่อให้ทีมงานในอนาคตต่อยอดได้ทันที ไม่ต้องออกแบบใหม่:

- **`consent.farmer_data_grant`** (ตารางใหม่ ก๊อปโครงจาก `govgw.consent`): `grant_id, farmer_id REFERENCES identity.farmer, grantee_org_id REFERENCES identity.organization, data_category CHECK ('transactions','credit_score','membership_visibility',...), status Active/Revoked, granted_at, revoked_at, ...` — grantor คือ**เกษตรกรเอง** (ต่างจาก `govgw.consent` ที่ grantor คือองค์กร) จึงต้องมี UI ฝั่งเกษตรกร (`frontend/` top-level) ให้กดอนุมัติ/เพิกถอนด้วย ไม่ใช่แค่ฝั่งองค์กร
- **Credit Score ให้องค์กรเห็นได้แบบ consent-gated:** ตาม decision ของผู้ใช้ (2026-08-17) ให้แสดง**คะแนนเต็ม 0-100** ไม่ใช่แค่ risk tier เมื่อมี Active grant สำหรับ `data_category='credit_score'` — ทำได้ 2 แบบ: (a) เพิ่ม RLS policy ใหม่บน `risk.credit_score` ที่ใช้ `EXISTS` เช็คตาราง consent (รูปแบบเดียวกับ `contract.contract`'s `party_own_contract` policy), หรือ (b) `SECURITY DEFINER` function ที่เช็ค consent เองแล้ว bypass RLS อย่างจงใจ (รูปแบบเดียวกับฟังก์ชันใน `govgw.*`) — แนะนำ (a) เพราะสอดคล้องกับสไตล์ที่มีอยู่แล้วในตารางเดียวกัน
- **Membership-visibility consent** ถ้าต้องการให้เกษตรกรซ่อนสมาชิกภาพบางองค์กรจากองค์กรอื่น (ดูหมายเหตุในตารางข้อ 4)
- **Transaction cross-org visibility** ถ้าต้องการให้องค์กร A เห็นยอดธุรกรรมที่เกษตรกรทำกับองค์กร B (ต้อง consent แบบเจาะจงรายองค์กรผู้รับสิทธิ์)
- **ขยาย `register_staff_member`** ให้รองรับ role catalog ของ Lender/VillageFund (วันนี้รับเฉพาะ `role_code LIKE 'coop.%'`) ถ้าต้องการ named-individual staff login แทน shared org login

## 6. พอร์ทัลใหม่ — VillageFund

**เหตุผลที่ใช้ Lender แทน "ธนาคาร" ทั่วไปรอบนี้:** `identity.organization.org_type` มีทั้ง `'Bank'` และ `'Lender'` แยกกัน แต่มีแค่ `frontend/lender/` ที่สร้างพอร์ทัลไว้แล้ว (`requireLenderOrg` เช็ค `role_type='Lender'` เท่านั้น ไม่รวม `'Bank'`) — ธ.ก.ส./ธนาคารอื่นๆ ในระบบวันนี้จึงลงทะเบียนเป็น `org_type='Lender'` ไปพลางก่อน (เหมือนที่ B2B Commerce Engine เอกสารเดิมแนะนำให้ "โรงงานอาหารสัตว์" ใช้ `Buyer` แทนไปพลางก่อนที่จะมี org_type เฉพาะ) พอร์ทัล `Bank` แยกต่างหากเป็น roadmap ในอนาคต

**VillageFund เปิด self-registration รอบนี้** — `auth.js`'s `ORG_SELF_REGISTER_TYPES` เดิมกันไว้เพราะมองว่า VillageFund "เป็นหน่วยงานภาครัฐ/สถาบัน ไม่น่าจะสมัครผ่านฟอร์มสาธารณะ" แต่ในทางปฏิบัติกองทุนหมู่บ้านคือคณะกรรมการระดับหมู่บ้าน สมัครเองผ่านฟอร์มได้จริง (คล้าย Lender ที่เป็นได้ทั้งธนาคารใหญ่และ MFI เล็กๆ) — เพิ่ม `'VillageFund'` เข้า `ORG_SELF_REGISTER_TYPES` เป็นการเปลี่ยน 1 บรรทัด ถูกกว่าและสอดคล้องกับ pattern เดิมมากกว่าการสร้าง endpoint "admin สร้างองค์กรให้" ใหม่ทั้งหมด (ซึ่งไม่มีอยู่จริงในระบบวันนี้ ตรวจสอบแล้วว่า `admin.js` มีแค่ endpoint อนุมัติ KYB/role ไม่มี endpoint สร้างองค์กรเลย)

**โครงพอร์ทัล** (ก๊อป `frontend/lender/` ~600 บรรทัด เป็นต้นแบบ): `frontend/villagefund/index.html` (login), `frontend/villagefund/dashboard.html`, `frontend/villagefund/js/api.js` (`AUTH_STORAGE_KEY = "agrolink_villagefund_session"`), `frontend/villagefund/js/login.js`, `frontend/villagefund/js/dashboard.js` — รอบนี้มีแค่ฟีเจอร์ Farmer 360 เท่านั้น (ค้นหา/เพิ่มสมาชิก + ดูโปรไฟล์ 360) ไม่มีฟีเจอร์อื่นของแพลตฟอร์ม (RFQ/marketplace ฯลฯ) เพราะนอกขอบเขตคำขอนี้ — เพิ่มทีหลังได้โดยไม่กระทบโครงที่วางไว้

**Backend:** `src/routes/villagefund.js` ใหม่ — `requireVillageFundOrg` middleware (ก๊อป pattern จาก `requireLenderOrg` ใน `lender.js`: เช็ค `kyb_status='Verified'` + `organization_role.status='Verified' AND role_type='VillageFund'`) — ให้ route เฉพาะของพอร์ทัลนี้ (ปัจจุบันมีแค่ mount จุดเข้าเท่านั้น ตัวฟีเจอร์ Farmer 360 จริงอยู่ที่ router กลางข้อ 7)

## 7. Backend — Farmer 360 เป็น router กลาง ใช้ร่วมกัน 3 พอร์ทัล

**`src/routes/farmer360.js` (ใหม่) mount ที่ `/farmer360`** — เขียนครั้งเดียว ใช้ร่วมกันทุก org_type (เหมือน `procurement.js` ที่ใช้ร่วมกันทุกพอร์ทัลอยู่แล้ว) เพราะ security boundary ที่แท้จริงคือ "มีความสัมพันธ์กับเกษตรกรคนนี้หรือยัง" ไม่ใช่ "เป็น org_type ไหน" — ใช้ `router.use(requireOrganization)` + เช็ค `kyb_status='Verified'` แบบ inline (ก๊อป `requireVerifiedOrgIfOrganization` pattern จาก `procurement.js`)

- `GET /farmer360/search?code=AF-000001` หรือ `?phone=0812345678` — ค้นหาแบบ **exact match เท่านั้น** (ไม่รองรับค้นหาบางส่วน/ชื่อ) ป้องกันการไล่ดูรายชื่อเกษตรกรทั้งระบบ — คืนแค่ `{farmer_id, farmer_code, full_name}` ถ้าพบ, `404` ถ้าไม่พบ
- `POST /farmer360/relationships` — body `{farmer_id}` — เพิ่มเกษตรกรที่พบจากการค้นหาเป็นสมาชิก/ลูกค้าของหน่วยงานตัวเอง
- `POST /farmer360/relationships/sync` — สแกน `produce.delivery`(ผ่าน `production_unit`)/`underwriting.loan_application`/`marketplace.product_order`/`marketplace.machinery_booking` ที่มี org_id/buyer_org_id/lender_org_id ตรงกับหน่วยงานตัวเอง แล้วสร้างความสัมพันธ์ให้อัตโนมัติสำหรับรายที่ยังไม่มี — คืน `{linked_count}`
- `GET /farmer360/relationships/mine` — รายชื่อสมาชิก/ลูกค้าทั้งหมดของหน่วยงานตัวเอง (roster)
- `DELETE /farmer360/relationships/:farmerId` — เลิกความสัมพันธ์ (`status='ended'`)
- `GET /farmer360/:farmerId` — **หน้าจอ 360 องศา** (ต้องมีความสัมพันธ์ `status='active'` กับเกษตรกรคนนี้ก่อน มิฉะนั้น `403`) คืนข้อมูลตามตารางข้อ 4: ข้อมูลพื้นฐาน, ที่ดิน (`registry.production_unit` ทั้งหมดของเกษตรกร), สมาชิกภาพกับองค์กรอื่น (ชื่อ+ประเภทเท่านั้น), สรุปธุรกรรมกับหน่วยงานตัวเองเท่านั้น (แยกหมวด: ซื้อปัจจัยการผลิต/ขายผลผลิต/เครื่องจักร/สินเชื่อ — ยอดรวมและจำนวนรายการ), `credit_score: null` พร้อม flag `available_in_next_phase: true`

### 7.1 ฝั่งเกษตรกรเอง — "สมาชิกภาพของฉัน" (เพิ่มเติมนอกแผนเดิม วันเดียวกัน)

หลัง MVP ฝั่งองค์กรเสร็จ มีคำถามตามธรรมชาติว่า **เกษตรกรควรเห็นข้อมูลนี้ของตัวเองด้วยไหม** — คำตอบคือใช่ เพราะจะเป็นรากฐานให้ Phase 2 (consent) ต่อยอดได้ทันที (เกษตรกรต้องเห็นรายชื่อหน่วยงานที่เข้าถึงข้อมูลตัวเองอยู่แล้ว ก่อนจะอนุมัติ/เพิกถอนสิทธิ์ได้)

- **`GET /farmer/memberships`** (ใหม่ ใน `backend/src/routes/farmer.js`, ไม่ใช่ `farmer360.js` — เพราะ subject เป็น farmer ไม่ใช่ organization ต้องอยู่หลัง `requireFarmer` ไม่ใช่ `requireOrganization`) — คืนรายการ `identity.farmer_org_relationship` ของเกษตรกรคนที่ login เองเท่านั้น (`WHERE r.farmer_id = $1` จาก JWT ไม่รับจาก client) join กับ `identity.organization` เอาชื่อ/ประเภทองค์กร — **จงใจให้เป็น read-only list ธรรมดา** (ชื่อ+ประเภท+วันที่เป็นสมาชิก) ไม่มีปุ่มจัดการสิทธิ์ใดๆ รอบนี้ เพราะยังไม่มีระบบ consent จริงให้ผูก
- **UI**: เพิ่ม section "🏷️ สมาชิกภาพของฉัน" ใน `frontend/dashboard.html` (พอร์ทัลเกษตรกรหลัก) วางไว้หลัง "ภาพรวมบัญชี" ก่อน "คะแนนความน่าเชื่อถือทางสินเชื่อ" — ตำแหน่งเดียวกับ mockup ต้นฉบับ (ชื่อ/ID → badge สมาชิกภาพ → ที่ดิน → เครดิต)
- **ทดสอบแล้ว**: backend 8 assertions (เกษตรกรเห็น 0 สมาชิกภาพก่อนถูกเพิ่ม, เห็นชื่อองค์กร/ประเภทความสัมพันธ์/วันที่ถูกต้องหลังถูกเพิ่ม, JWT ที่ไม่ใช่ farmer โดน `403`, กลับเป็น 0 หลังเลิกเป็นสมาชิก) + headless-browser ยืนยัน UI แสดงผลถูกต้อง ล้างข้อมูลทดสอบเรียบร้อย

## 8. ไฟล์ที่เกี่ยวข้อง (แผนที่)

| ไฟล์ | สถานะ |
|---|---|
| `backend/db/grant_farmer_360.sql` | ✅ สร้างและรันจริงบน `agrolink_test` แล้ว — `farmer_org_relationship`, `farmer_code`, ฟังก์ชัน link/unlink/sync |
| `backend/src/routes/farmer360.js` | ✅ สร้างและทดสอบแล้ว — router กลาง ใช้ร่วมกัน 3 พอร์ทัล |
| `backend/src/routes/villagefund.js` | ✅ สร้างและทดสอบแล้ว — mount จุดเข้าพอร์ทัลใหม่ |
| `backend/src/routes/auth.js` | ✅ แก้แล้ว — เพิ่ม `'VillageFund'` เข้า `ORG_SELF_REGISTER_TYPES` |
| `backend/src/routes/organization.js` | ✅ แก้แล้ว (เพิ่มเติมนอกแผนเดิม) — เพิ่ม `'VillageFund'` เข้า `ORG_REQUESTABLE_ROLE_TYPES` ด้วย เพื่อให้องค์กรที่มีบทบาทอื่นอยู่แล้วขอเพิ่มบทบาท VillageFund ได้เช่นกัน |
| `frontend/js/register-provider.js`, `register-provider.html`, `manage-roles.html`/`.js` | ✅ แก้แล้ว (เพิ่มเติมนอกแผนเดิม) — ตอนสำรวจ frontend พบว่า `register-provider.js` ยังไม่รู้จัก org_type ใหม่ (จะสมัคร VillageFund ผ่านฟอร์มได้แต่ไม่ redirect ไปพอร์ทัลใหม่) และ `manage-roles.js` ยังไม่รู้จัก session key ของพอร์ทัลใหม่ — แก้ทั้งสองจุดให้ครบวงจรก่อนส่งมอบ |
| `frontend/villagefund/*` | ✅ สร้างครบทั้งหมดแล้ว (`index.html`, `dashboard.html`, `js/api.js`, `js/login.js`, `js/dashboard.js`) |
| `frontend/coop/`, `frontend/lender/` | ✅ ขยายแล้ว — เพิ่ม UI ค้นหา/ดูโปรไฟล์ 360 |
| `consent.farmer_data_grant`, credit-score RLS policy ใหม่, ขยาย `register_staff_member` ให้ Lender/VillageFund | 📋 ออกแบบไว้แล้วในเอกสารนี้ (ข้อ 5) — Phase 2 ยังไม่เริ่ม |
| พอร์ทัล `Bank` แยกจาก `Lender` | 📋 org_type มีอยู่แล้ว ยังไม่มี frontend — รอบถัดไป (เหมือน Mill/Logistics เดิม) |
| `backend/src/routes/farmer.js` (route `GET /memberships`) | ✅ สร้างและทดสอบแล้ว (เพิ่มเติมนอกแผนเดิม วันเดียวกัน — ดูข้อ 7.1) — ฝั่งเกษตรกรเองดูสมาชิกภาพของตัวเอง |
| `frontend/dashboard.html`, `frontend/js/dashboard.js` | ✅ แก้แล้ว (เพิ่มเติมนอกแผนเดิม วันเดียวกัน — ดูข้อ 7.1) — เพิ่ม section "🏷️ สมาชิกภาพของฉัน" ในพอร์ทัลเกษตรกรหลัก |

## 9. Roadmap สรุป

| Phase | ขอบเขต | สถานะ |
|---|---|---|
| MVP | สมาชิกภาพหลายองค์กร + ที่ดิน + ธุรกรรม (เฉพาะกับตัวเอง) + พอร์ทัล VillageFund ใหม่ + UI ใน 3 พอร์ทัล | ✅ **เสร็จสมบูรณ์และทดสอบ end-to-end แล้ว** (16 assertions ผ่านหมด ทั้ง backend + headless-browser ทั้ง 3 พอร์ทัล ล้างข้อมูลทดสอบเรียบร้อย) |
| MVP+ | ฝั่งเกษตรกรเอง — "สมาชิกภาพของฉัน" (`GET /farmer/memberships` + UI ใน `dashboard.html`) — ดูข้อ 7.1 | ✅ **เสร็จสมบูรณ์และทดสอบ end-to-end แล้ว** (8 assertions ผ่านหมด + headless-browser ยืนยัน UI ล้างข้อมูลทดสอบเรียบร้อย) |
| 2 | Consent workflow (farmer-grants-org) + Credit Score แบบ consent-gated (คะแนนเต็ม 0-100) + membership-visibility consent + cross-org transaction visibility | 📋 ถัดไป |
| 3 | ขยาย `register_staff_member` ให้ Lender/VillageFund (named-individual login แทน shared org login) | 📋 ถัดไป |
| 4 | พอร์ทัล `Bank` แยกจาก `Lender` | 📋 ถัดไป |
