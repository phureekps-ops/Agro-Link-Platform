-- AgroLink Platform — Consolidate the four individual machinery org_types
-- into one 'MachineryService' role_type.
--
-- Context: MULTI_ROLE_ORGANIZATION_ARCHITECTURE.md §5.1 flagged that
-- TractorService / DroneService / HarvesterService / TruckService are FOUR
-- separate role_types today, so an org offering all four machinery services
-- needs FOUR separate Platform Ops approvals (POST /organization/roles ->
-- POST /admin/organizations/:id/roles/:role_type/status, once per type).
-- Re-reading src/routes/machinery.js while implementing this showed that
-- approval friction buys NOTHING downstream: requireMachineryOrg already
-- treats all five machinery/drying-yard org_types as ONE unified portal and
-- grants full access the moment ANY ONE of them is Verified (its own doc
-- comment says so directly: "the rate card itself has no per-role field
-- gating"). A provider Verified only for DroneService can already price and
-- take bookings for ALL seven rate-card items (ไถดะ/ไถแปร/ปั่นดิน/ฉีดพ่น/
-- เกี่ยวข้าว/รถบรรทุก/ลานตาก) today, not just spraying. Four separate
-- approval rows therefore added process overhead without adding real
-- per-service access control — this migration removes that overhead by
-- adding a single 'MachineryService' role_type that new requests use going
-- forward.
--
-- What does NOT need to change: which SPECIFIC machine/service a listing or
-- booking is for. That was never encoded in org_type/role_type to begin
-- with — marketplace.service_listing.service_key (7 fixed values: plow_rough,
-- plow_secondary_seed, rotary_till, spraying, harvesting, trucking, drying,
-- see grant_machinery_marketplace.sql) and its snapshotted service_type
-- column on marketplace.machinery_booking already identify the specific
-- service at the LISTING/BOOKING level, fully decoupled from which role the
-- org holds. So this migration does NOT add a new machinery_type column
-- anywhere — service_key/service_type already are that column, and adding a
-- second one would just duplicate information that already exists (the
-- kind of unjustified structure this project's other migrations explicitly
-- avoid — see grant_cooperative_tenant_foundation.sql's reasoning against a
-- one-row registry.department table for the same kind of reason).
--
-- Backward compatibility: TractorService/DroneService/HarvesterService/
-- TruckService are NOT removed from the org_type/role_type domain — same
-- additive-widening, never-destructive pattern as 'Cooperative'/'Mill'
-- being dropped from the self-registration/role-request LISTS on
-- 2026-07-24 while staying valid DB values (see auth.js's own comment).
-- Any already-seeded/approved org still holding one of the four individual
-- roles keeps working exactly as before — src/routes/machinery.js and
-- farmermachinery.js widen their MACHINERY_ORG_TYPES arrays to check for
-- EITHER the new consolidated role OR any of the four legacy ones. Only
-- self-registration (auth.js's ORG_SELF_REGISTER_TYPES) and the additional-
-- role request list (organization.js's ORG_REQUESTABLE_ROLE_TYPES) are
-- narrowed to offer 'MachineryService' instead of the four individual
-- entries — new requests use the consolidated type, old rows are untouched.
--
-- DryingYardService is explicitly OUT of scope here and unchanged — per
-- the original product framing (MULTI_ROLE_ORGANIZATION_ARCHITECTURE.md §3)
-- ให้บริการอุปกรณ์ (machinery) and ให้บริการลานตาก (drying yard) are two
-- distinct business functions in the six-function cooperative example, even
-- though the code has always bundled DryingYardService into the same
-- MACHINERY_ORG_TYPES set/portal for implementation convenience.

ALTER TABLE identity.organization DROP CONSTRAINT IF EXISTS organization_org_type_check;
ALTER TABLE identity.organization ADD CONSTRAINT organization_org_type_check
  CHECK (org_type = ANY (ARRAY[
    'Cooperative', 'Mill', 'Bank', 'InputSupplier', 'Lender', 'Logistics', 'Buyer', 'VillageFund',
    'TractorService', 'DroneService', 'HarvesterService', 'TruckService', 'DryingYardService',
    'MarketVenue', 'FertilizerMixingService', 'MachineryService'
  ]));

ALTER TABLE identity.organization_role DROP CONSTRAINT IF EXISTS organization_role_role_type_check;
ALTER TABLE identity.organization_role ADD CONSTRAINT organization_role_role_type_check
  CHECK (role_type = ANY (ARRAY[
    'Cooperative', 'Mill', 'Bank', 'InputSupplier', 'Lender', 'Logistics', 'Buyer', 'VillageFund',
    'TractorService', 'DroneService', 'HarvesterService', 'TruckService', 'DryingYardService',
    'MarketVenue', 'FertilizerMixingService', 'MachineryService'
  ]));

-- No data backfill/migration of existing TractorService/DroneService/
-- HarvesterService/TruckService rows to 'MachineryService' — same
-- deliberate choice as every other type removed from a self-service list
-- in this project (see auth.js's 'Cooperative'/'Mill' comment): existing
-- rows keep their original role_type forever, only the path for NEW
-- requests changes. A real product decision to relabel historical rows
-- would need its own explicit sign-off, not a side effect of this migration.
