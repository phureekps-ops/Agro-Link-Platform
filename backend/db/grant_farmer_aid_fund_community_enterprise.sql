-- AgroLink Platform — Add two new "bundle" org_types that each cover
-- several business functions from day one:
--
--   'FarmerAidFund'          (กองทุนสงเคราะห์เกษตรกร — Farmer Aid Fund)
--   'AgriCommunityEnterprise' (วิสาหกิจชุมชนด้านการเกษตร — Agricultural
--                              Community Enterprise)
--
-- Requested capabilities for both, per the user's own list: ให้กู้ยืมเงิน
-- (lending), ให้บริการเครื่องจักรกลเกษตร (machinery service), ขายปัจจัยการ
-- ผลิตและสินค้าอื่นๆ (selling inputs), รวมออเดอร์ซื้อสินค้า (group order —
-- a frontend-only feature already shipped, see frontend/js/group-order-
-- widget.js, no backend role needed for it), and รับซื้อผลผลิต (buying
-- produce). That is exactly the Lender + MachineryService + InputSupplier
-- + Buyer role_type set — all four already exist in the domain below, nothing
-- new needed on that side.
--
-- Per MULTI_ROLE_ORGANIZATION_ARCHITECTURE.md, "one org, many roles" is
-- an EXISTING, already-shipped model (identity.organization_role, additive
-- widening pattern used for VillageFund/MarketVenue/FertilizerMixingService/
-- MachineryService before this). This migration follows that exact same
-- pattern: widen the org_type CHECK (a new org can self-register with a
-- primary type of 'FarmerAidFund'/'AgriCommunityEnterprise') AND the
-- role_type CHECK (so a Verified row with role_type = one of these two
-- values can exist as the "primary role marker" — see the matching
-- backend/src/routes/admin.js change, which bundle-grants Lender +
-- MachineryService + InputSupplier + Buyer as Verified roles the SAME
-- moment KYB is approved for one of these two org_types, on top of the
-- usual primary-role-mirrors-org_type row every self-registered org gets).
--
-- No new tables, no new columns — this is purely a widened CHECK domain,
-- same "additive, never destructive" rule as every prior grant_*.sql that
-- touched these two constraints (grant_machinery_service_consolidation.sql
-- being the most recent, 2026-08-17 — the full ARRAY below is copied from
-- that file's post-migration state with only these two new values added).

ALTER TABLE identity.organization DROP CONSTRAINT IF EXISTS organization_org_type_check;
ALTER TABLE identity.organization ADD CONSTRAINT organization_org_type_check
  CHECK (org_type = ANY (ARRAY[
    'Cooperative', 'Mill', 'Bank', 'InputSupplier', 'Lender', 'Logistics', 'Buyer', 'VillageFund',
    'TractorService', 'DroneService', 'HarvesterService', 'TruckService', 'DryingYardService',
    'MarketVenue', 'FertilizerMixingService', 'MachineryService',
    'FarmerAidFund', 'AgriCommunityEnterprise'
  ]));

ALTER TABLE identity.organization_role DROP CONSTRAINT IF EXISTS organization_role_role_type_check;
ALTER TABLE identity.organization_role ADD CONSTRAINT organization_role_role_type_check
  CHECK (role_type = ANY (ARRAY[
    'Cooperative', 'Mill', 'Bank', 'InputSupplier', 'Lender', 'Logistics', 'Buyer', 'VillageFund',
    'TractorService', 'DroneService', 'HarvesterService', 'TruckService', 'DryingYardService',
    'MarketVenue', 'FertilizerMixingService', 'MachineryService',
    'FarmerAidFund', 'AgriCommunityEnterprise'
  ]));

-- Nothing to backfill — these are brand-new values with no existing rows.
