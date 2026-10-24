-- grant_biomass_producer_portal.sql
--
-- "พอร์ทัลผู้ผลิตสินค้าจากชีวมวล" (Biomass Product Producer Portal) — a new
-- self-service portal where an already-registered organization (per the
-- user's explicit scoping: สหกรณ์/กลุ่มเกษตรกร that already have an
-- AgroLink login) declares which biomass product category/categories it
-- produces (multi-select among 5 fixed categories) and fills in a short
-- public profile, so buyers/mills can discover it on a new aggregate
-- "card directory" page (frontend/biomassproducer-directory.html — kept
-- separate from the existing BUYER-facing frontend/biomass-portal.html,
-- per the user's explicit answer that the two must not be merged).
--
-- Design decisions (per the 4 clarifying answers the user gave):
--   1. Members = existing registered organizations (Cooperative/farmer
--      group etc.), not individual farmers — so this is modeled as an
--      ADDITIONAL business role on identity.organization, exactly the
--      same multi-role mechanism every other role here uses (see
--      grant_organization_roles.sql) — NOT a new subject type, NOT a new
--      login. 'BiomassProducer' is added ONLY to
--      organization_role_role_type_check (NOT to organization_org_type_
--      check) — deliberately scoped to "additional role on an existing,
--      already-KYB-Verified org", not offered on the public from-scratch
--      self-registration form (POST /auth/org-register / register-
--      provider.html). An org requests it the same way it already
--      requests Lender/Buyer/etc as a second role: POST /organization/
--      roles (frontend/manage-roles.html — already fully generic, reads
--      its requestable-roles list from the backend, needs ZERO changes)
--      then Platform Ops approves it via the existing generic
--      POST /admin/organizations/:id/roles/:role_type/status endpoint
--      (also needs ZERO changes — see that endpoint's own comment in
--      admin.js, it already works for any role_type in the CHECK domain).
--   2. New standalone portal with its own login page (frontend/
--      biomassproducer/), same shape as every other single-role portal
--      (lender/, buyer/, dryingyard/ etc.) — logging in there uses the
--      SAME POST /auth/login + the SAME org claim as every other portal,
--      just stored under this portal's own localStorage key (see
--      frontend/dryingyard/js/api.js's doc comment for why that's the
--      house convention, not a new auth mechanism).
--   3. Multi-select among exactly 5 fixed product categories — modeled as
--      a normalized join table (biomass.producer_product), NOT an array
--      column, per the project's own established preference for
--      normalized join tables (production.batch_input / finished_good
--      etc.) — lets "which product types does org X produce" be queried/
--      indexed/joined directly, and the biomass.v_producer_directory view
--      below aggregates it back into an array for the card UI.
--   4. A new, separate aggregate "card directory" page, NOT merged into
--      frontend/biomass-portal.html (the existing BUYER-facing portal,
--      which has no backend of its own at all — confirmed: it's a static
--      marketing page). Made PUBLIC (no auth) — explicit assumption,
--      flagged to the user — on the reasoning that the entire point of
--      the directory is for buyers/mills (who may not have, or want, an
--      AgroLink login) to discover producers, same reasoning as
--      content.js's public GET /about.
--
-- Whether a producer business sells via the real ledger (ledger.*
-- double-entry) is explicitly OUT of scope here, same "manual today, real
-- wiring later" / "payment handled offline" pattern as marketplace.
-- fertilizer_mixing_order (see that table's own grant file comment) —
-- this portal is a REGISTRATION + DIRECTORY, not an order/payment system.
-- A buyer who finds a producer card here still contacts them directly
-- (contact_phone on the card) — exactly like grant_fertilizer_mixing_
-- service.sql's "AgroLink records state, it never confirms or moves
-- money itself" for a provider-type marketplace with no existing
-- transaction flow to plug into.

-- ---------------------------------------------------------------------
-- 1. Widen identity.organization_role.role_type only — see design
--    decision §1 above for why organization_org_type_check is
--    deliberately NOT touched. Additive CHECK-constraint-widening
--    pattern, same as every prior grant_*.sql that touched this
--    constraint (grant_farmer_aid_fund_community_enterprise.sql being the
--    most recent before this one — the full ARRAY below is copied from
--    that file's post-migration state with only 'BiomassProducer' added).
-- ---------------------------------------------------------------------
ALTER TABLE identity.organization_role DROP CONSTRAINT IF EXISTS organization_role_role_type_check;
ALTER TABLE identity.organization_role ADD CONSTRAINT organization_role_role_type_check
  CHECK (role_type = ANY (ARRAY[
    'Cooperative', 'Mill', 'Bank', 'InputSupplier', 'Lender', 'Logistics', 'Buyer', 'VillageFund',
    'TractorService', 'DroneService', 'HarvesterService', 'TruckService', 'DryingYardService',
    'MarketVenue', 'FertilizerMixingService', 'MachineryService',
    'FarmerAidFund', 'AgriCommunityEnterprise',
    'BiomassProducer'
  ]));

-- partner.activate_vendor_role() (grant_organization_roles.sql) already
-- handles ANY role_type generically via its ELSE branch (-> vendor_
-- settlement account) — no change needed there. Every self-registered
-- org already gets a partner.vendor_profile row at POST /auth/org-
-- register time (business_registration_no = tax_id), and every org that
-- can request 'BiomassProducer' here is, by definition, an already-
-- registered org, so it already has that row too — the approval
-- endpoint's existing `partner.activate_vendor_role($1, $2)` call
-- (admin.js) will succeed with no special-casing for this role.

-- ---------------------------------------------------------------------
-- 2. New schema: biomass — same house convention as every other feature
--    that needed a schema not in the original bootstrap dump (carbon,
--    alliance, procurement, logistics, processing, warehouse, etc. — see
--    their own grant_*.sql files).
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS biomass;
GRANT USAGE ON SCHEMA biomass TO agrolink_app;

-- ---------------------------------------------------------------------
-- 3. biomass.producer_profile — one row per org holding the
--    'BiomassProducer' role. org_id is BOTH the primary key and the FK
--    (one profile per org — a second profile makes no sense; unlike,
--    say, marketplace.service_listing where one org can have many rate-
--    card rows, this portal has exactly one "card" per producer org).
--    Deliberately does NOT duplicate region_code/district_code — those
--    already live on identity.organization itself (grant_org_district.
--    sql) for every self-registerable org_type; the directory view below
--    reads them straight from there instead of a third copy.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS biomass.producer_profile (
  org_id               uuid PRIMARY KEY REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  description          text,
  capacity_note        text,
  cover_photo_data_url text,
  contact_phone        text,
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE biomass.producer_profile IS 'โปรไฟล์สาธารณะของผู้ผลิตสินค้าจากชีวมวล — แสดงผลเป็นการ์ดในหน้าพอร์ทัลรวม';

-- ---------------------------------------------------------------------
-- 4. biomass.producer_product — the multi-select join table. Exactly the
--    5 fixed categories the user named, in the user's own stated order.
--    A row existing = "this org produces this category" — no row = no,
--    simple membership semantics, nothing else to model (no price/
--    quantity here; this is a directory, not a catalog — see header
--    comment on why that's deliberately out of scope).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS biomass.producer_product (
  org_id       uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  product_type text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, product_type),
  CONSTRAINT producer_product_type_check CHECK (product_type = ANY (ARRAY[
    'baled_straw',          -- 1. ฟางอัดก้อน
    'baled_sugarcane_top',  -- 2. ยอดอ้อยอัดก้อน
    'pelletized_straw',     -- 3. ฟางอัดเม็ด
    'biochar',              -- 4. Biochar
    'organic_fertilizer'    -- 5. ปุ๋ยอินทรีย์
  ]))
);

CREATE INDEX IF NOT EXISTS idx_producer_product_type ON biomass.producer_product(product_type);

COMMENT ON TABLE biomass.producer_product IS 'ประเภทสินค้าจากชีวมวลที่สมาชิกแต่ละรายเลือกผลิต (เลือกได้หลายประเภท)';

GRANT SELECT, INSERT, UPDATE ON biomass.producer_profile TO agrolink_app;
GRANT SELECT, INSERT, DELETE ON biomass.producer_product TO agrolink_app;

-- ---------------------------------------------------------------------
-- 5. biomass.v_producer_directory — backs the public aggregate card page
--    (GET /biomass/directory, withServiceRole() like content.js's public
--    GET /about — see header comment §4). Only orgs that (a) hold a
--    VERIFIED 'BiomassProducer' role AND (b) have an active profile are
--    listed — a Pending/Rejected role, or a profile the org has toggled
--    is_active=false on, is excluded, same spirit as marketplace.
--    service_listing.is_active gating what farmers see elsewhere.
--    product_types is aggregated back into an array for the card UI
--    (array_agg ... FILTER so an org with zero product rows yet — e.g.
--    right after requesting the role, before filling anything in —
--    still gets '{}' rather than being dropped by the LEFT JOIN).
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW biomass.v_producer_directory AS
SELECT
  o.org_id,
  o.org_name,
  o.region_code,
  o.district_code,
  pp.description,
  pp.capacity_note,
  pp.cover_photo_data_url,
  pp.contact_phone,
  pp.updated_at,
  COALESCE(
    array_agg(prod.product_type ORDER BY prod.product_type) FILTER (WHERE prod.product_type IS NOT NULL),
    '{}'
  ) AS product_types
FROM identity.organization o
JOIN identity.organization_role r
  ON r.org_id = o.org_id AND r.role_type = 'BiomassProducer' AND r.status = 'Verified'
JOIN biomass.producer_profile pp
  ON pp.org_id = o.org_id AND pp.is_active = true
LEFT JOIN biomass.producer_product prod
  ON prod.org_id = o.org_id
GROUP BY o.org_id, o.org_name, o.region_code, o.district_code,
         pp.description, pp.capacity_note, pp.cover_photo_data_url, pp.contact_phone, pp.updated_at;

GRANT SELECT ON biomass.v_producer_directory TO agrolink_app;

-- ---------------------------------------------------------------------
-- Reminder for the next person reading this: biomass.producer_profile and
-- biomass.producer_product have NO row-level security (relrowsecurity =
-- false, same situation as identity.organization_role and every other
-- table this project has added for a single portal's own use — see
-- grant_organization_roles.sql's own closing reminder). src/routes/
-- biomass.js's explicit `WHERE org_id = $1` (via requireBiomassProducerOrg
-- + req.org.org_id) IS the entire security boundary for these two tables
-- on every WRITE path, not defense-in-depth. The one READ path with no
-- org_id scoping at all (GET /biomass/directory, via the view above) is
-- deliberately public — see header comment §4 — so that's not a gap,
-- it's the intended design.
-- ---------------------------------------------------------------------
