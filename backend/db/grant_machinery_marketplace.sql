-- AgroLink Platform — Agricultural Machinery & Drying-Yard Service Portal
--
-- marketplace.service_listing already existed in the schema (created by a
-- much earlier migration) but had ZERO grants for agrolink_app and ZERO row
-- level security — meaning no API route could touch it at all until now.
-- This migration (1) opens it up, (2) adds a `service_key` column so the
-- fixed rate-card line items this portal exposes (ไถดะ, ไถแปรและหว่าน,
-- ปั่นดิน, ฉีดพ่นสารเคมี, เกี่ยวข้าว, รถบรรทุก, ลานตากข้าว) can be
-- told apart and upserted reliably, (3) adds a photo-gallery table for the
-- provider's profile, and (4) widens identity.organization.org_type to add
-- DryingYardService (rice/produce drying-yard providers) — the fifth
-- org_type folded into this portal alongside the four seeded earlier
-- (TractorService, DroneService, HarvesterService, TruckService).
--
-- Per the RETURNING-needs-SELECT lesson learned earlier in this project
-- (see grant_platform_ops.sql's comment block): ANY insert that uses
-- RETURNING also needs SELECT granted, not just INSERT/UPDATE — both are
-- included below up front specifically to avoid rediscovering that the
-- hard way a second time.

-- ---------------------------------------------------------------------
-- 1. Widen org_type to add DryingYardService (ผู้ให้บริการลานตากข้าว).
--    Additive CHECK-constraint-widening pattern used earlier in this
--    project for org_type (grant_provider_registration.sql) — drop and
--    re-add rather than a destructive rewrite, so existing rows are
--    untouched.
-- ---------------------------------------------------------------------
ALTER TABLE identity.organization DROP CONSTRAINT IF EXISTS organization_org_type_check;
ALTER TABLE identity.organization ADD CONSTRAINT organization_org_type_check
  CHECK (org_type = ANY (ARRAY[
    'Cooperative', 'Mill', 'Bank', 'InputSupplier', 'Lender', 'Logistics', 'Buyer', 'VillageFund',
    'TractorService', 'DroneService', 'HarvesterService', 'TruckService', 'DryingYardService'
  ]));

-- ---------------------------------------------------------------------
-- 2. Grants + service_key column on marketplace.service_listing.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON marketplace.service_listing TO agrolink_app;

-- service_key identifies WHICH of the seven fixed rate-card line items a
-- row represents. service_type alone can't tell ไถดะ apart from
-- ไถแปรและหว่าน apart from ปั่นดิน since all three share
-- service_type = 'land_preparation'. NULL stays allowed so any
-- pre-existing/seeded listing rows (created before this column existed)
-- aren't broken by the constraint.
ALTER TABLE marketplace.service_listing ADD COLUMN IF NOT EXISTS service_key text;

ALTER TABLE marketplace.service_listing DROP CONSTRAINT IF EXISTS service_listing_service_key_check;
ALTER TABLE marketplace.service_listing ADD CONSTRAINT service_listing_service_key_check
  CHECK (service_key IS NULL OR service_key IN (
    'plow_rough', 'plow_secondary_seed', 'rotary_till', 'spraying', 'harvesting', 'trucking', 'drying'
  ));

-- One row per (org, fixed rate-card item) — the API does an upsert against
-- this (ON CONFLICT (org_id, service_key) DO UPDATE), so a provider
-- re-saving their "ไถดะ" price updates the existing row instead of piling
-- up duplicates. Partial (service_key IS NOT NULL) so it doesn't collide
-- with any older NULL-service_key rows.
DROP INDEX IF EXISTS marketplace.uq_service_listing_org_service_key;
CREATE UNIQUE INDEX uq_service_listing_org_service_key
  ON marketplace.service_listing (org_id, service_key)
  WHERE service_key IS NOT NULL;

-- ---------------------------------------------------------------------
-- 3. Photo gallery (service photos / machinery photos) for the provider's
--    profile. Kept as its own table, decoupled from any one rate-card
--    row, since these read as "photos of this provider / their
--    equipment" rather than "photos of this specific price line".
--
--    No object storage or CDN exists in this sandbox, so photos are
--    stored as data: URLs directly in the row (photo_data_url) — workable
--    for a demo at a handful of photos per provider, but NOT how a real
--    deployment should store images (that needs S3/GCS + a CDN, with only
--    the URL kept in Postgres).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.vendor_photo (
  photo_id       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id         uuid NOT NULL REFERENCES partner.vendor_profile(org_id) ON DELETE CASCADE,
  photo_type     text NOT NULL CHECK (photo_type IN ('service', 'machinery')),
  photo_data_url text NOT NULL,
  caption        text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vendor_photo_org ON marketplace.vendor_photo(org_id);

GRANT SELECT, INSERT, DELETE ON marketplace.vendor_photo TO agrolink_app;

-- ---------------------------------------------------------------------
-- Reminder for the next person reading this: marketplace.service_listing
-- and marketplace.vendor_photo have NO row-level security (verified via
-- relrowsecurity — both false, same situation as identity.organization,
-- partner.vendor_profile, and notification.notification_log elsewhere in
-- this project). The database enforces NOTHING about which org can read
-- or write which row here — src/routes/machinery.js's explicit
-- `WHERE org_id = $1` on every query IS the entire security boundary, not
-- defense-in-depth. Forgetting that WHERE clause in a future edit would be
-- a real cross-tenant data leak/write, not just a style nit.
-- ---------------------------------------------------------------------
