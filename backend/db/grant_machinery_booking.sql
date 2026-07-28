-- AgroLink -- select-service-provider feature, Machinery leg: a farmer's
-- request to book one priced rate-card item from a machinery/drying-yard
-- provider (TractorService / DroneService / HarvesterService / TruckService
-- / DryingYardService — see MACHINERY_ORG_TYPES in src/routes/machinery.js).
--
-- Why a NEW table instead of the older, already-present-but-unwired
-- marketplace.service_request (+ accept_service_request/complete_service_
-- request/request_service functions, from the original Layer-9/10 export
-- in 02_full_schema.sql): that mechanism requires a registry.production_
-- unit (a farmer's registered plot/pen/pond) on every request, and its
-- "complete" step performs an actual ledger fund transfer via partner.
-- vendor_profile.settlement_account_id (partner.activate_vendor must have
-- run first). Neither of those fits the scope agreed for this feature —
-- same as marketplace.venue_booking, this is a simple request/accept/
-- decline record; payment is handled OFFLINE directly between farmer and
-- provider, AgroLink never confirms the job actually happened. Reusing
-- service_request would mean either force-fitting a production_unit
-- selection the user never asked for, or leaving required columns
-- meaningless placeholders. A dedicated table mirrors marketplace.
-- venue_booking's proven shape instead (see grant_market_venue_marketplace.
-- sql) — status vocabulary, snapshot-at-request-time columns, decided_
-- reason/decided_at, no RLS (explicit WHERE org_id/farmer_id IS the
-- security boundary, same as every other marketplace.* table).
--
-- service_key/label_th/service_type/unit_price/price_unit are SNAPSHOTTED
-- from marketplace.service_listing at request time — a provider changing
-- their rate card tomorrow must not silently change what a farmer already
-- requested today (same reasoning as venue_booking's own snapshot columns).

CREATE TABLE IF NOT EXISTS marketplace.machinery_booking (
  booking_id      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id      uuid NOT NULL REFERENCES marketplace.service_listing(listing_id),
  org_id          uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  farmer_id       uuid NOT NULL REFERENCES identity.farmer(farmer_id) ON DELETE CASCADE,
  -- Snapshot of the listing at request time (see comment above).
  service_key     text NOT NULL,
  label_th        text NOT NULL,
  service_type    text NOT NULL,
  unit_price      numeric(18,2) NOT NULL,
  price_unit      text NOT NULL,
  quantity_note   text,
  preferred_date  date NOT NULL,
  farmer_note     text,
  status          text NOT NULL DEFAULT 'Requested',
  decided_reason  text,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT machinery_booking_status_check
    CHECK (status IN ('Requested', 'Accepted', 'Declined', 'Cancelled'))
);

-- Same denormalized-org_id-for-direct-WHERE-scoping convention as every
-- other marketplace.* table — neither service_listing nor machinery_booking
-- has row-level security; the explicit `WHERE org_id = $1` (provider side)
-- / `WHERE farmer_id = $1` (farmer side) in every query IS the security
-- boundary, not defense-in-depth.
CREATE INDEX IF NOT EXISTS idx_machinery_booking_org ON marketplace.machinery_booking (org_id, status);
CREATE INDEX IF NOT EXISTS idx_machinery_booking_farmer ON marketplace.machinery_booking (farmer_id);
CREATE INDEX IF NOT EXISTS idx_machinery_booking_listing ON marketplace.machinery_booking (listing_id);

-- No DELETE grant — a booking is never deleted, only status-transitioned,
-- same convention as marketplace.venue_booking / product_order.
GRANT SELECT, INSERT, UPDATE ON marketplace.machinery_booking TO agrolink_app;

-- ---------------------------------------------------------------------
-- Reminder for the next person reading this: marketplace.machinery_booking
-- has NO row-level security (relrowsecurity = false, same situation as
-- every other marketplace.* table in this project). src/routes/machinery.js's
-- and src/routes/farmer.js's explicit WHERE clauses ARE the entire security
-- boundary here.
-- ---------------------------------------------------------------------
