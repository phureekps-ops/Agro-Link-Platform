-- AgroLink -- แจ้งเตือนสมาชิกโคนม (กล่องแจ้งเตือนในเว็บมือถือ + LINE Official Account).
--
-- 1) dairy.notification   กล่องแจ้งเตือนของเกษตรกร (เห็นในหน้า "โคนมของฉัน" เสมอ)
--                          และคิวส่ง LINE (line_status) ในตารางเดียวกัน
-- 2) dairy.line_link       บัญชีเกษตรกร ↔ LINE userId (หนึ่งต่อหนึ่ง) + ตั้งค่าว่าจะรับเรื่องอะไร
-- 3) dairy.line_link_code  รหัสผูกบัญชี 6 หลัก (เก็บเฉพาะ sha256 ใช้ได้ครั้งเดียว หมดอายุ 10 นาที)
--
-- การผูกบัญชี: สมาชิกกด "รับแจ้งเตือนทาง LINE" ในหน้าโคนมของฉัน → ได้รหัส 6 หลัก →
-- เพิ่มเพื่อน LINE OA ของ AgroLink แล้วพิมพ์รหัสในแชท → webhook /line/webhook ผูกให้.
-- LINE userId ไม่ถูกส่งกลับไปที่หน้าเว็บใด ๆ.
--
-- Security convention เหมือน grant_dairy_cooperative.sql: ไม่มี RLS ทุก query
-- กรองด้วย farmer_id ของผู้ login (dairymember.js) หรือ LINE userId ที่ผ่านการ
-- ตรวจลายเซ็น X-Line-Signature แล้ว (line.js).
--
-- Idempotent: รันซ้ำได้. ต้องรันหลัง grant_dairy_cooperative.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS dairy.line_link (
  farmer_id     uuid PRIMARY KEY REFERENCES identity.farmer(farmer_id),
  line_user_id  text NOT NULL UNIQUE CHECK (line_user_id ~ '^U[0-9a-f]{32}$'),
  active        boolean NOT NULL DEFAULT true,
  -- เรื่องที่ต้องการรับทาง LINE (กล่องแจ้งเตือนในเว็บได้ทุกเรื่องเสมอ)
  prefs         jsonb NOT NULL DEFAULT '{"milk_rejected": true, "quality": true, "settlement": true, "request": true, "membership": true}'::jsonb,
  linked_at     timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dairy.line_link_code (
  code_hash   text PRIMARY KEY,
  farmer_id   uuid NOT NULL REFERENCES identity.farmer(farmer_id),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dairy_line_code_farmer ON dairy.line_link_code (farmer_id);

CREATE TABLE IF NOT EXISTS dairy.notification (
  notif_id     uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  farmer_id    uuid NOT NULL REFERENCES identity.farmer(farmer_id),
  member_id    uuid REFERENCES dairy.member(member_id),
  coop_org_id  uuid REFERENCES identity.organization(org_id),
  kind         text NOT NULL CHECK (kind IN ('milk_rejected', 'quality', 'settlement', 'request', 'membership', 'test')),
  title        text NOT NULL,
  body         text NOT NULL,
  ref_type     text,
  ref_id       uuid,
  read_at      timestamptz,
  -- คิว LINE: pending = รอส่ง, sent = ส่งแล้ว, no_link = เกษตรกรยังไม่ผูก LINE,
  -- muted = ปิดเรื่องนี้ไว้, failed = ส่งไม่สำเร็จครบ 5 ครั้ง, expired = ค้างเกิน 24 ชม.
  line_status  text NOT NULL DEFAULT 'pending'
               CHECK (line_status IN ('pending', 'sent', 'no_link', 'muted', 'failed', 'expired')),
  line_attempts smallint NOT NULL DEFAULT 0,
  line_error   text,
  line_sent_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- เหตุการณ์เดียวกันแจ้งสมาชิกคนเดียวกันได้ครั้งเดียว (เช่น กด "โอนแล้ว" ซ้ำ)
CREATE UNIQUE INDEX IF NOT EXISTS uq_dairy_notif_ref
  ON dairy.notification (kind, ref_id, farmer_id, COALESCE(member_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE ref_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dairy_notif_farmer ON dairy.notification (farmer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dairy_notif_pending ON dairy.notification (created_at) WHERE line_status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON dairy.line_link, dairy.line_link_code, dairy.notification TO agrolink_app;
