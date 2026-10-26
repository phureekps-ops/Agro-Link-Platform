-- grant_biomass_buyer_portal.sql
--
-- "พอร์ทัลผู้รับซื้อชีวมวล" (Biomass Buyer Registration Portal) — a new
-- self-service portal where an already-registered organization declares
-- itself as a biomass buyer: company name, detailed address, which of 11
-- fixed biomass types it uses (multi-select), monthly usage volume,
-- purpose of use, and desired product spec. Sibling feature to
-- grant_biomass_producer_portal.sql's "พอร์ทัลผู้ผลิตสินค้าจากชีวมวล" —
-- same schema (biomass), same architecture, mirrored field-for-field
-- against that file's own design decisions, with one deliberate
-- difference noted in §4 below (no public directory here).
--
-- Design decisions (mirroring grant_biomass_producer_portal.sql's §1-§4):
--   1. Members = existing registered organizations, not individual
--      farmers or a from-scratch signup — modeled as an ADDITIONAL
--      business role on identity.organization, same multi-role mechanism
--      as every other role (see grant_organization_roles.sql).
--      'BiomassBuyer' is added ONLY to organization_role_role_type_check
--      (NOT to organization_org_type_check) — requestable the same way an
--      org already requests Lender/Buyer/BiomassProducer/etc as a second
--      role: POST /organization/roles (frontend/manage-roles.html — fully
--      generic, needs ZERO changes) then Platform Ops approves it via the
--      existing generic POST /admin/organizations/:id/roles/:role_type/
--      status endpoint (also needs ZERO changes).
--   2. New standalone portal with its own login page (frontend/
--      biomassbuyer/), same shape as every other single-role portal —
--      same POST /auth/login + the same org claim as every other portal,
--      stored under this portal's own localStorage key.
--   3. Multi-select among exactly 11 fixed biomass types — modeled as a
--      normalized join table (biomass.buyer_biomass_type), NOT an array
--      column, same reasoning as biomass.producer_product (see that
--      table's own comment in grant_biomass_producer_portal.sql).
--   4. UNLIKE the producer side, this portal has NO public directory view
--      — a buyer registering here is declaring its own purchasing need,
--      not offering something for other orgs to discover via a public
--      card page. (If a future feature wants producers to see aggregate
--      buyer demand, that is a separate, explicit ask — not assumed
--      here.) This portal is a REGISTRATION program only, same "manual
--      today, no order/payment system" scope as the producer side — a
--      producer who wants to reach a registered buyer still does so
--      off-platform (contact_phone on the buyer's own profile, visible
--      only to the buyer's own org, same single-org-scoped security
--      boundary as every table below).
--
-- Whether this feeds a real matching/order flow (ledger.*, marketplace.*)
-- is explicitly OUT of scope here — same reasoning as every other
-- "registration, not transaction system" grant file in this project.

-- ---------------------------------------------------------------------
-- 1. Widen identity.organization_role.role_type only — additive
--    CHECK-constraint-widening pattern, same as every prior grant_*.sql
--    that touched this constraint. Full ARRAY below is copied from
--    grant_biomass_producer_portal.sql's post-migration state with only
--    'BiomassBuyer' added.
-- ---------------------------------------------------------------------
ALTER TABLE identity.organization_role DROP CONSTRAINT IF EXISTS organization_role_role_type_check;
ALTER TABLE identity.organization_role ADD CONSTRAINT organization_role_role_type_check
  CHECK (role_type = ANY (ARRAY[
    'Cooperative', 'Mill', 'Bank', 'InputSupplier', 'Lender', 'Logistics', 'Buyer', 'VillageFund',
    'TractorService', 'DroneService', 'HarvesterService', 'TruckService', 'DryingYardService',
    'MarketVenue', 'FertilizerMixingService', 'MachineryService',
    'FarmerAidFund', 'AgriCommunityEnterprise',
    'BiomassProducer',
    'BiomassBuyer'
  ]));

-- partner.activate_vendor_role() (grant_organization_roles.sql) already
-- handles ANY role_type generically via its ELSE branch — no change
-- needed there, same reasoning as grant_biomass_producer_portal.sql §1's
-- matching paragraph (not repeated here).

-- ---------------------------------------------------------------------
-- 2. Schema: reuse the existing `biomass` schema (created by
--    grant_biomass_producer_portal.sql) — same domain, no reason for a
--    second schema.
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS biomass;
GRANT USAGE ON SCHEMA biomass TO agrolink_app;

-- ---------------------------------------------------------------------
-- 3. biomass.buyer_profile — one row per org holding the 'BiomassBuyer'
--    role. org_id is BOTH the primary key and the FK (one registration
--    per org). company_name and address_detail are captured here as this
--    portal's OWN fields (distinct from identity.organization.org_name/
--    region_code/district_code) — same precedent as biomass.
--    producer_profile capturing its own description/capacity_note
--    alongside the org's existing identity fields: the business-facing
--    registration details a buyer fills in here may legitimately differ
--    from the org's own top-level registered name/address (e.g. a
--    procurement office address vs. the org's registered address).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS biomass.buyer_profile (
  org_id              uuid PRIMARY KEY REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  company_name        text NOT NULL,
  address_detail      text,
  monthly_usage_note  text,
  usage_purpose       text,
  desired_spec        text,
  contact_phone       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE biomass.buyer_profile IS 'ข้อมูลลงทะเบียนสมาชิกผู้รับซื้อชีวมวล — ชื่อบริษัท ที่อยู่ ปริมาณการใช้ วัตถุประสงค์ และสเปคที่ต้องการ';

-- ---------------------------------------------------------------------
-- 4. biomass.buyer_biomass_type — the multi-select join table. Exactly
--    the 11 fixed types the user named (10 named first, 'biochar' added
--    as an explicit follow-up in the same conversation turn), in the
--    user's own stated order. A row existing = "this org uses this
--    type" — no row = no, same simple membership semantics as biomass.
--    producer_product.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS biomass.buyer_biomass_type (
  org_id        uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  biomass_type  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, biomass_type),
  CONSTRAINT buyer_biomass_type_check CHECK (biomass_type = ANY (ARRAY[
    'rice_straw',             -- 1. ฟางข้าว
    'sugarcane_leaf',         -- 2. ใบอ้อย
    'corn_cob',                -- 3. ซังข้าวโพด
    'palm_empty_bunch',        -- 4. ทะลายปาล์ม
    'eucalyptus_wood',         -- 5. ไม้ยูคา
    'mixed_wood',              -- 6. ไม้เบญจพรรณ
    'raw_rice_husk',           -- 7. แกลบดิบ
    'manure',                  -- 8. ปุ๋ยคอก
    'compost',                 -- 9. ปุ๋ยหมัก
    'sugarcane_filter_cake',   -- 10. ขี้เค็กอ้อย
    'biochar'                  -- 11. ไบโอชาร์
  ]))
);

CREATE INDEX IF NOT EXISTS idx_buyer_biomass_type ON biomass.buyer_biomass_type(biomass_type);

COMMENT ON TABLE biomass.buyer_biomass_type IS 'ชนิดชีวมวลที่สมาชิกผู้รับซื้อแต่ละรายระบุว่าใช้ (เลือกได้หลายประเภท)';

GRANT SELECT, INSERT, UPDATE ON biomass.buyer_profile TO agrolink_app;
GRANT SELECT, INSERT, DELETE ON biomass.buyer_biomass_type TO agrolink_app;

-- ---------------------------------------------------------------------
-- Reminder for the next person reading this: biomass.buyer_profile and
-- biomass.buyer_biomass_type have NO row-level security (relrowsecurity
-- = false, same situation as biomass.producer_profile/producer_product
-- and every other table this project has added for a single portal's own
-- use). src/routes/biomassbuyer.js's explicit `WHERE org_id = $1` (via
-- requireBiomassBuyerOrg + req.org.org_id) IS the entire security
-- boundary for these two tables on every path — unlike the producer
-- side, there is no public view here at all (see header comment §4), so
-- every single route in biomassbuyer.js sits behind requireAuth +
-- requireBiomassBuyerOrg with no exception.
-- ---------------------------------------------------------------------
