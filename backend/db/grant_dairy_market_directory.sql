-- grant_dairy_market_directory.sql — ทะเบียนตลาดน้ำนมดิบระดับประเทศ
-- (AgroLink National Dairy, โมดูล 04 National Dairy Buyer Database)
--
-- A working directory for the AgroLink team: raw-milk buyers (อ.ส.ค.,
-- private plants, school-milk operators), dairy cooperatives and collection
-- centres nationwide — most of which are NOT AgroLink users yet. It is a
-- sales/market-development pipeline, deliberately separate from
-- dairy.partner (a cooperative's own business partners) and from
-- identity.organization (real platform accounts). When an entry signs up,
-- linked_org_id points at its organization and its status becomes
-- 'onboarded'.
--
-- Data honesty: volumes, prices and terms stay NULL until a named person at
-- the buyer gives them (volume_source records who and when — the API
-- refuses a volume without it). Rows are never deleted; an entry that turns
-- out not to buy raw milk is set to 'not_relevant'.
--
-- Seed data: seed_dairy_market_directory_v0_1.sql (from
-- AgroLink_National_Dairy_Buyer_Master_Database_v0.1.xlsx). Run that file
-- after this one. Both are safe to run more than once.
-- ============================================================================

SET client_encoding = 'UTF8';

CREATE TABLE IF NOT EXISTS dairy.market_directory (
  entry_id                  uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  external_ref              text UNIQUE,
  entry_kind                text NOT NULL,
  name                      text NOT NULL,
  org_category              text,
  school_milk_zone          smallint,
  province_code             text REFERENCES registry.province(province_code),
  province_note             text,
  district                  text,
  address                   text,
  phone                     text,
  email                     text,
  website                   text,
  contact_name              text,
  contact_role              text,
  contact_phone             text,
  chain_role                text,
  buys_raw_milk             text NOT NULL DEFAULT 'unknown',
  actual_volume_l_day       numeric(12,1),
  contract_volume_l_day     numeric(12,1),
  processing_capacity_l_day numeric(12,1),
  price_baht_per_kg         numeric(8,2),
  quality_standard          text,
  purchase_terms            text,
  volume_source             text,
  status                    text NOT NULL DEFAULT 'unverified',
  source                    text,
  source_url                text,
  last_verified_on          date,
  owner_name                text,
  notes                     text,
  possible_duplicate_of     uuid REFERENCES dairy.market_directory(entry_id),
  linked_org_id             uuid REFERENCES identity.organization(org_id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_directory_kind_check CHECK (entry_kind IN ('dpo','processor','school_milk_operator','cooperative','collection_center','other')),
  CONSTRAINT market_directory_status_check CHECK (status IN ('unverified','contacted','verified','onboarded','not_relevant')),
  CONSTRAINT market_directory_buys_check CHECK (buys_raw_milk IN ('unknown','yes','no')),
  CONSTRAINT market_directory_zone_check CHECK (school_milk_zone IS NULL OR school_milk_zone BETWEEN 1 AND 7),
  CONSTRAINT market_directory_numbers_check CHECK (
    (actual_volume_l_day IS NULL OR actual_volume_l_day >= 0) AND (contract_volume_l_day IS NULL OR contract_volume_l_day >= 0)
    AND (processing_capacity_l_day IS NULL OR processing_capacity_l_day >= 0) AND (price_baht_per_kg IS NULL OR price_baht_per_kg >= 0)),
  CONSTRAINT market_directory_volume_source_check CHECK (
    (actual_volume_l_day IS NULL AND contract_volume_l_day IS NULL AND price_baht_per_kg IS NULL) OR volume_source IS NOT NULL),
  CONSTRAINT market_directory_onboarded_check CHECK (status <> 'onboarded' OR linked_org_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_market_directory_kind ON dairy.market_directory (entry_kind, status);
CREATE INDEX IF NOT EXISTS idx_market_directory_province ON dairy.market_directory (province_code);

CREATE TABLE IF NOT EXISTS dairy.market_directory_log (
  log_id        uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  entry_id      uuid NOT NULL REFERENCES dairy.market_directory(entry_id) ON DELETE CASCADE,
  logged_at     timestamptz NOT NULL DEFAULT now(),
  channel       text NOT NULL,
  summary       text NOT NULL,
  outcome       text,
  next_step     text,
  next_step_on  date,
  logged_by     text NOT NULL,
  CONSTRAINT market_directory_log_channel_check CHECK (channel IN ('phone','email','line','visit','meeting','other'))
);
CREATE INDEX IF NOT EXISTS idx_market_directory_log_entry ON dairy.market_directory_log (entry_id, logged_at DESC);

GRANT SELECT, INSERT, UPDATE ON dairy.market_directory TO agrolink_app;
GRANT SELECT, INSERT ON dairy.market_directory_log TO agrolink_app;

COMMENT ON TABLE dairy.market_directory IS 'ทะเบียนตลาดน้ำนมดิบระดับประเทศ (ผู้รับซื้อ อ.ส.ค. โรงงาน ผู้ประกอบการนมโรงเรียน สหกรณ์ ศูนย์รวบรวม) สำหรับทีม AgroLink ติดต่อและยืนยันข้อมูล — ไม่ใช่บัญชีผู้ใช้ เมื่อสมัครใช้ระบบแล้วผูกกับ identity.organization ผ่าน linked_org_id';
COMMENT ON TABLE dairy.market_directory_log IS 'บันทึกการติดต่อแต่ละครั้งกับรายการในทะเบียนตลาดน้ำนม';
