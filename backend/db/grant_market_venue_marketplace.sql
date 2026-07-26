-- AgroLink Platform — Selling-Space Matching Portal (ระบบจับคู่พื้นที่จำหน่ายสินค้า)
--
-- New feature requested directly by the user: a farmer/cooperative/
-- community-enterprise (วิสาหกิจชุมชน) whose harvest is oversupplied and
-- selling at a depressed price needs somewhere physical to go sell it —
-- a wholesale market, a fresh market, or a pop-up market-day organizer.
-- This migration adds the "เจ้าของสถานที่" (venue owner/market organizer)
-- side of that: a new self-registerable org_type that can post available
-- selling space, and a farmer-facing booking request against it.
--
-- Deliberately modeled as closely as possible on the existing
-- marketplace.product_listing / marketplace.product_order pair (see
-- grant_input_supplier_and_buy_prices.sql + grant_farmer_product_orders.sql)
-- — same "provider posts a listing, farmer requests against it, provider
-- accepts/declines" shape, same denormalized org_id-on-the-request
-- convention, same is_active-deactivate-not-delete convention once a
-- booking can reference a listing.
--
-- Scope decisions confirmed with the user before writing this (2026-07-26):
--   1. Payment happens OFFLINE, directly between the farmer and the venue
--      owner, on-site — this system only records the booking itself, no
--      payment/collection flow. fee_amount/fee_unit are informational
--      (shown to the farmer up front, snapshotted onto the booking), not
--      billed through AgroLink.
--   2. A venue owner must clear normal KYB + role approval (Platform Ops)
--      before its listings become visible to farmers — same approval loop
--      every other provider type already goes through, no special-casing
--      needed in admin.js.
--   3. V1 matching is farmer-search-and-request only — no automatic
--      matching/notification against oversupply/price-crash conditions yet
--      (a real, sensible follow-up once this base is live, tied into
--      monitoring.v_active_alerts, but explicitly out of scope for now).
--   4. No rating/review system in V1.

-- ---------------------------------------------------------------------
-- 1. Widen org_type / role_type domains to add 'MarketVenue'.
--    Additive CHECK-constraint-widening pattern used throughout this
--    project (see grant_provider_registration.sql, grant_machinery_
--    marketplace.sql) — drop and re-add rather than a destructive
--    rewrite, so every existing row/value is untouched. Both
--    identity.organization.org_type AND identity.organization_role.
--    role_type need widening — they're two separate CHECK constraints
--    over the same value domain (see grant_organization_roles.sql).
-- ---------------------------------------------------------------------
ALTER TABLE identity.organization DROP CONSTRAINT IF EXISTS organization_org_type_check;
ALTER TABLE identity.organization ADD CONSTRAINT organization_org_type_check
  CHECK (org_type = ANY (ARRAY[
    'Cooperative', 'Mill', 'Bank', 'InputSupplier', 'Lender', 'Logistics', 'Buyer', 'VillageFund',
    'TractorService', 'DroneService', 'HarvesterService', 'TruckService', 'DryingYardService',
    'MarketVenue'
  ]));

ALTER TABLE identity.organization_role DROP CONSTRAINT IF EXISTS organization_role_role_type_check;
ALTER TABLE identity.organization_role ADD CONSTRAINT organization_role_role_type_check
  CHECK (role_type = ANY (ARRAY[
    'Cooperative', 'Mill', 'Bank', 'InputSupplier', 'Lender', 'Logistics', 'Buyer', 'VillageFund',
    'TractorService', 'DroneService', 'HarvesterService', 'TruckService', 'DryingYardService',
    'MarketVenue'
  ]));

-- ---------------------------------------------------------------------
-- 2. marketplace.venue_listing — one row per selling-space offer a venue
--    owner posts (a wholesale market's available lots, a fresh market's
--    open stalls, a market-day organizer's upcoming event, etc).
--
--    province_code follows the exact same free-text convention as
--    identity.farmer.region_code (ISO 3166-2:TH codes like "TH-18", no
--    lookup/FK table in the database — see frontend/js/provinces.js)
--    rather than introducing a new geography table for this one feature.
--
--    schedule_note is deliberately free text rather than a strict
--    available_from/available_to date range: real markets are commonly
--    recurring by weekday ("ทุกวันเสาร์-อาทิตย์") or tied to an event date
--    rather than a fixed open/close window, and forcing that into two
--    date columns would misrepresent most real listings.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.venue_listing (
  listing_id        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  venue_name        text NOT NULL,
  venue_type        text NOT NULL,
  province_code     text NOT NULL,
  address_detail    text,
  accepted_products text,
  space_description text,
  fee_amount        numeric(18,2),
  fee_unit          text,
  schedule_note     text,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT venue_listing_venue_type_check
    CHECK (venue_type IN ('wholesale_market', 'fresh_market', 'popup_market', 'other')),
  CONSTRAINT venue_listing_fee_amount_check CHECK (fee_amount IS NULL OR fee_amount >= 0)
);

CREATE INDEX IF NOT EXISTS idx_venue_listing_org ON marketplace.venue_listing (org_id);
CREATE INDEX IF NOT EXISTS idx_venue_listing_browse ON marketplace.venue_listing (province_code, venue_type) WHERE is_active = true;

-- No DELETE grant — same deactivate-only convention as marketplace.
-- product_listing, for the same reason (a booking can reference a
-- listing_id; see marketplace.venue_booking below).
GRANT SELECT, INSERT, UPDATE ON marketplace.venue_listing TO agrolink_app;

-- ---------------------------------------------------------------------
-- 3. marketplace.venue_booking — a farmer's request to use one listing's
--    space. venue_name/venue_type/fee_amount/fee_unit are SNAPSHOTTED
--    from the listing at request time (same reasoning as marketplace.
--    product_order's snapshot columns — see grant_farmer_product_orders.
--    sql's comment: a listing's fee edited tomorrow must not silently
--    change what a farmer already agreed to today).
--
--    status vocabulary uses PascalCase ('Requested'/'Accepted'/'Declined'/
--    'Cancelled') to match identity.organization_role.status's convention
--    for a booking decision (Verified/Pending/Rejected shape), since this
--    is fundamentally the same kind of "someone else approves or declines
--    your request" flow as a role request, not a commercial order —
--    there's no 'fulfilled' terminal state here because AgroLink never
--    confirms the physical sale happened (payment/goods handover is
--    entirely offline, per the scope decision above).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.venue_booking (
  booking_id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id         uuid NOT NULL REFERENCES marketplace.venue_listing(listing_id),
  org_id             uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  farmer_id          uuid NOT NULL REFERENCES identity.farmer(farmer_id) ON DELETE CASCADE,
  -- Snapshot of the listing at request time (see comment above).
  venue_name         text NOT NULL,
  venue_type         text NOT NULL,
  fee_amount         numeric(18,2),
  fee_unit           text,
  product_type       text NOT NULL,
  quantity_note       text,
  preferred_date     date NOT NULL,
  farmer_note        text,
  status             text NOT NULL DEFAULT 'Requested',
  decided_reason     text,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT venue_booking_status_check
    CHECK (status IN ('Requested', 'Accepted', 'Declined', 'Cancelled'))
);

-- Same denormalized-org_id-for-direct-WHERE-scoping convention as every
-- other marketplace.* table — see the note at the top of
-- src/routes/machinery.js. Neither venue_listing nor venue_booking has
-- row-level security; the explicit `WHERE org_id = $1` (venue-owner side)
-- / `WHERE farmer_id = $1` (farmer side) in every query IS the security
-- boundary, not defense-in-depth.
CREATE INDEX IF NOT EXISTS idx_venue_booking_org ON marketplace.venue_booking (org_id, status);
CREATE INDEX IF NOT EXISTS idx_venue_booking_farmer ON marketplace.venue_booking (farmer_id);
CREATE INDEX IF NOT EXISTS idx_venue_booking_listing ON marketplace.venue_booking (listing_id);

-- No DELETE grant — a booking is never deleted, only status-transitioned,
-- same convention as marketplace.product_order.
GRANT SELECT, INSERT, UPDATE ON marketplace.venue_booking TO agrolink_app;

-- ---------------------------------------------------------------------
-- Reminder for the next person reading this: marketplace.venue_listing and
-- marketplace.venue_booking have NO row-level security (relrowsecurity =
-- false, same situation as every other marketplace.* table in this
-- project). src/routes/marketvenue.js's and src/routes/farmer.js's
-- explicit WHERE clauses ARE the entire security boundary here.
-- ---------------------------------------------------------------------
