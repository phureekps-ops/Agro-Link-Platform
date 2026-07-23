-- ============================================================================
-- AgroLink Platform — Backend API Gateway: Service-Provider (Organization)
-- Self-Registration
-- ============================================================================
-- Widens identity.organization.org_type to add four new business
-- categories requested directly by the user: farm-machinery/mechanization
-- rental services that don't fit any existing org_type value
-- (Cooperative/Mill/Bank/InputSupplier/Lender/Logistics/Buyer/VillageFund).
-- This is an ADDITIVE change to the CHECK constraint only — no existing
-- rows are affected, nothing is removed, every previously-valid org_type
-- value is still valid.
--
-- 'TractorService'   — บริการรถไถ (plowing/tilling service)
-- 'DroneService'      — บริการโดรน (drone spraying service)
-- 'HarvesterService'  — บริการรถเกี่ยว (combine-harvester service)
-- 'TruckService'      — บริการรถบรรทุก (transport/haulage service)
--
-- (Kept distinct from the existing 'Logistics' type rather than merged
-- into it, since the user listed all four as separate selectable
-- categories — in practice a tractor-plowing outfit, a drone-spraying
-- outfit, a harvester contractor, and a trucking company are usually
-- different businesses, not one generic "logistics" company.)
-- ============================================================================

ALTER TABLE identity.organization DROP CONSTRAINT organization_org_type_check;
ALTER TABLE identity.organization ADD CONSTRAINT organization_org_type_check
  CHECK (org_type = ANY (ARRAY[
    'Cooperative','Mill','Bank','InputSupplier','Lender','Logistics','Buyer','VillageFund',
    'TractorService','DroneService','HarvesterService','TruckService'
  ]::text[]));

-- POST /auth/org-register (src/routes/auth.js) is the first thing to ever
-- INSERT into identity.organization or partner.vendor_profile as
-- agrolink_app — every organization before this was seeded directly via a
-- superuser connection, never through the API. agrolink_app already had
-- SELECT/UPDATE on both tables (from grant_platform_ops.sql, for the
-- Platform Ops KYB-approval flow); INSERT is newly required here.
GRANT INSERT ON identity.organization TO agrolink_app;
GRANT INSERT ON partner.vendor_profile TO agrolink_app;
