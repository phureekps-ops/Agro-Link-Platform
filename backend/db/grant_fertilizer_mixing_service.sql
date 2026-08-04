-- grant_fertilizer_mixing_service.sql
--
-- Fulfillment Marketplace (module 2.3 of the Prescription Fertilizer
-- service plan) — เส้นทาง A: สั่งซื้อบริการผสมปุ๋ยสั่งตัดผ่าน "ผู้ให้บริการ
-- ผสมปุ๋ยสั่งตัด" (FertilizerMixingService) ที่ลงทะเบียน/ผ่าน KYB แล้ว.
-- Section 4 of the analysis doc names this org type (ผู้ให้บริการผสมปุ๋ย
-- สั่งตัด) as one of two new Stage-based Service Marketplace categories to
-- add — the other, นักตรวจดินเคลื่อนที่ (Mobile Soil Test Technician), is
-- intentionally NOT built here; this migration is fertilizer-mixing only.
--
-- Same design decision as grant_machinery_booking.sql / grant_market_venue_
-- marketplace.sql, made for the identical reason (see that file's own doc
-- comment for the full argument): a dedicated table, NOT the older, already
-- -present-but-unwired marketplace.service_request (+ request_service /
-- accept_service_request / complete_service_request functions from the
-- original schema export). That mechanism's "complete" step performs a
-- REAL ledger fund transfer out of a farmer's unit_wallet account
-- (partner.vendor_profile.settlement_account_id must exist too) — and
-- NOTHING in this codebase yet opens a unit_wallet ledger account for a
-- real (non-seed-data) farmer's production unit. Forcing that gap open
-- here was judged out of scope for this pass. Payment for a fertilizer-
-- mixing order is handled OFFLINE directly between farmer and provider,
-- same as every other marketplace.*_booking table in this project —
-- AgroLink records the request/accept/decline/complete lifecycle, it never
-- confirms or moves money itself.
--
-- What makes this table different from marketplace.machinery_booking: an
-- order here can optionally link back to the exact Stage Calendar fertilizer
-- stage (cycle_id/stage_id — production.crop_cycle/production.stage_calendar,
-- see grant_stage_calendar_farmer.sql) and the exact AI-calculated formula
-- run (calc_id — production.fertilizer_formula_calc, see grant_fertilizer_
-- formula.sql) it was ordered from, so a provider sees exactly how much
-- urea/DAP/MOP a farmer needs mixed, not just a vague request. All three
-- links are nullable — a farmer can still request custom mixing without
-- having run the calculator or started a crop cycle first.

-- ---------------------------------------------------------------------
-- 1. Widen org_type + organization_role.role_type to add
--    FertilizerMixingService — additive CHECK-constraint-widening pattern
--    used for every org type added so far (see grant_machinery_marketplace
--    .sql / grant_market_venue_marketplace.sql), drop and re-add rather
--    than a destructive rewrite so existing rows are untouched.
-- ---------------------------------------------------------------------
ALTER TABLE identity.organization DROP CONSTRAINT IF EXISTS organization_org_type_check;
ALTER TABLE identity.organization ADD CONSTRAINT organization_org_type_check
  CHECK (org_type = ANY (ARRAY[
    'Cooperative', 'Mill', 'Bank', 'InputSupplier', 'Lender', 'Logistics', 'Buyer', 'VillageFund',
    'TractorService', 'DroneService', 'HarvesterService', 'TruckService', 'DryingYardService',
    'MarketVenue', 'FertilizerMixingService'
  ]));

ALTER TABLE identity.organization_role DROP CONSTRAINT IF EXISTS organization_role_role_type_check;
ALTER TABLE identity.organization_role ADD CONSTRAINT organization_role_role_type_check
  CHECK (role_type = ANY (ARRAY[
    'Cooperative', 'Mill', 'Bank', 'InputSupplier', 'Lender', 'Logistics', 'Buyer', 'VillageFund',
    'TractorService', 'DroneService', 'HarvesterService', 'TruckService', 'DryingYardService',
    'MarketVenue', 'FertilizerMixingService'
  ]));

-- ---------------------------------------------------------------------
-- 2. Widen marketplace.service_listing's service_type/service_key so a
--    fertilizer-mixing provider can post a rate-card row the same way a
--    machinery provider does (ON CONFLICT (org_id, service_key) upsert —
--    the partial unique index this relies on already exists, added by
--    grant_machinery_marketplace.sql, and is NOT per-service_type so it
--    already covers this new key with no further change needed).
--    One fixed line item for v1 (fertilizer_custom_mix) — unlike the
--    machinery portal's seven, a mixing provider offers essentially one
--    service (custom-blend a farmer's requested urea/DAP/MOP mix),
--    typically priced per kilogram of finished mix.
-- ---------------------------------------------------------------------
ALTER TABLE marketplace.service_listing DROP CONSTRAINT IF EXISTS service_listing_service_type_check;
ALTER TABLE marketplace.service_listing ADD CONSTRAINT service_listing_service_type_check
  CHECK (service_type = ANY (ARRAY[
    'land_preparation', 'harvesting', 'pest_control', 'transport', 'drying_storage', 'fertilizer_mixing', 'other'
  ]));

ALTER TABLE marketplace.service_listing DROP CONSTRAINT IF EXISTS service_listing_service_key_check;
ALTER TABLE marketplace.service_listing ADD CONSTRAINT service_listing_service_key_check
  CHECK (service_key IS NULL OR service_key IN (
    'plow_rough', 'plow_secondary_seed', 'rotary_till', 'spraying', 'harvesting', 'trucking', 'drying',
    'fertilizer_custom_mix'
  ));

-- ---------------------------------------------------------------------
-- 3. marketplace.fertilizer_mixing_order — a farmer's request to a
--    Verified FertilizerMixingService provider. service_key/label_th/
--    service_type/unit_price/price_unit are SNAPSHOTTED from the listing
--    at request time (same reasoning as every other *_booking table here —
--    a provider editing their price tomorrow must not silently change
--    what a farmer already requested today).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.fertilizer_mixing_order (
  order_id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id         uuid NOT NULL REFERENCES marketplace.service_listing(listing_id),
  org_id             uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  farmer_id          uuid NOT NULL REFERENCES identity.farmer(farmer_id) ON DELETE CASCADE,
  unit_id            uuid NOT NULL REFERENCES registry.production_unit(unit_id) ON DELETE CASCADE,
  -- Optional links back to the exact crop-cycle stage / calculator run
  -- this order came from — all nullable, see header comment.
  cycle_id           uuid REFERENCES production.crop_cycle(cycle_id),
  stage_id           uuid REFERENCES production.stage_calendar(stage_id),
  calc_id            uuid REFERENCES production.fertilizer_formula_calc(calc_id),
  -- Snapshot of the listing at request time (see comment above).
  service_key        text NOT NULL,
  label_th           text NOT NULL,
  service_type       text NOT NULL,
  unit_price         numeric(18,2) NOT NULL,
  price_unit         text NOT NULL,
  -- What the farmer is asking to have mixed — pre-fillable from calc_id's
  -- own urea_kg/dap_kg/mop_kg (production.fertilizer_formula_calc) but
  -- always editable, since a farmer may want a different mix than the
  -- calculator's suggestion (e.g. they already have some urea on hand).
  requested_urea_kg  numeric(8,2),
  requested_dap_kg   numeric(8,2),
  requested_mop_kg   numeric(8,2),
  delivery_option    text NOT NULL DEFAULT 'pickup',
  delivery_address   text,
  preferred_date     date NOT NULL,
  farmer_note        text,
  status             text NOT NULL DEFAULT 'Requested',
  decided_reason     text,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  -- Unlike machinery_booking/venue_booking (accept/decline only — the job
  -- happens off-platform with no further status update), a fertilizer-mix
  -- order also tracks Completed: mixing takes days and the farmer benefits
  -- from knowing "your mix is ready for pickup/delivery" inside the app,
  -- even though the payment itself still happens offline (see header
  -- comment — this is a status/record, not a payment confirmation).
  completed_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fertilizer_mixing_order_status_check
    CHECK (status IN ('Requested', 'Accepted', 'Declined', 'Completed', 'Cancelled')),
  CONSTRAINT fertilizer_mixing_order_delivery_option_check
    CHECK (delivery_option IN ('pickup', 'delivery'))
);

-- Same denormalized-org_id/farmer_id-for-direct-WHERE-scoping convention as
-- every other marketplace.* table in this project — no row-level security
-- here either; the explicit `WHERE org_id = $1` (provider side) /
-- `WHERE farmer_id = $1` (farmer side) in every query IS the security
-- boundary, not defense-in-depth.
CREATE INDEX IF NOT EXISTS idx_fertilizer_mixing_order_org ON marketplace.fertilizer_mixing_order (org_id, status);
CREATE INDEX IF NOT EXISTS idx_fertilizer_mixing_order_farmer ON marketplace.fertilizer_mixing_order (farmer_id);
CREATE INDEX IF NOT EXISTS idx_fertilizer_mixing_order_listing ON marketplace.fertilizer_mixing_order (listing_id);
CREATE INDEX IF NOT EXISTS idx_fertilizer_mixing_order_cycle ON marketplace.fertilizer_mixing_order (cycle_id);

-- No DELETE grant — an order is never deleted, only status-transitioned,
-- same convention as marketplace.machinery_booking / venue_booking /
-- product_order.
GRANT SELECT, INSERT, UPDATE ON marketplace.fertilizer_mixing_order TO agrolink_app;

COMMENT ON TABLE marketplace.fertilizer_mixing_order IS 'คำขอสั่งบริการผสมปุ๋ยสั่งตัดจากเกษตรกรไปยังผู้ให้บริการผสมปุ๋ย (Fulfillment Marketplace เส้นทาง A, module 2.3) — การชำระเงินทำกันเองนอกระบบระหว่างเกษตรกรและผู้ให้บริการ ระบบบันทึกเฉพาะสถานะคำขอ (Requested/Accepted/Declined/Completed/Cancelled) ดู src/routes/fertilizermixing.js และ src/routes/farmer.js';

-- ---------------------------------------------------------------------
-- Reminder for the next person reading this: marketplace.service_listing,
-- marketplace.fertilizer_mixing_order, and every other marketplace.* table
-- in this project have NO row-level security (relrowsecurity = false).
-- src/routes/fertilizermixing.js's and src/routes/farmer.js's explicit
-- WHERE clauses ARE the entire security boundary here — not
-- defense-in-depth. Forgetting that WHERE clause in a future edit would be
-- a real cross-tenant data leak/write, not just a style nit.
-- ---------------------------------------------------------------------
