-- ============================================================================
-- AgroLink Platform — Shrimp Sealed-Bid Auction ("Auction Place") — Phase 1a
-- ============================================================================
-- Added 2026-08-25. Scope note: this is the CORE-AUCTION slice only, per the
-- user's explicit choice (see SHRIMP_AUCTION_ARCHITECTURE.md section 9) —
-- Sealed Bid multi-size bidding, the farmer manually selecting a winning
-- buyer, and settlement pricing driven by a real Final Sampling. Feed/
-- medication/water-quality logs, photo requirements, buyer/farm trust
-- scores, and the full Data Quality Score gate from the architecture doc are
-- explicitly deferred to a later pass — this migration does NOT create
-- those tables. Simple farm/pond profile forms are included since the
-- auction detail page needs something to show.
--
-- Design decisions worth calling out (see SHRIMP_AUCTION_ARCHITECTURE.md for
-- the full reasoning):
--   1. This is a "forward" auction (buyers bid the price UP, highest/
--      qualified bid wins, but the FARMER picks manually — no auto-award).
--      The existing procurement.auction/auction_bid tables are REUSED, not
--      duplicated: a new `auction_mode` column discriminates 'reverse'
--      (all existing auctions, unaffected default) from 'forward' (new).
--      All forward-mode read/write happens through src/routes/aquaculture.js
--      — src/routes/procurement.js's generic bid/close endpoints now
--      explicitly reject auction_mode='forward' rows (see the two guards
--      added there) rather than risk corrupting a tier-matrix auction with
--      single-price logic.
--   2. Contract.contract / purchase_order / invoice / pay_invoice are
--      DELIBERATELY NOT reused here. Investigation while designing this
--      found that procurement.pay_invoice() hardcodes the seller side of a
--      contract to be an organization (resolves payment via
--      partner.vendor_profile) — it has no path for a farmer-as-seller. This
--      is not a new problem: grant_fertilizer_mixing_service.sql's own doc
--      comment already documents this exact gap ("NOTHING in this codebase
--      yet opens a unit_wallet ledger account for a real (non-seed-data)
--      farmer's production unit... Payment is handled OFFLINE directly
--      between farmer and provider, same as every other marketplace.*
--      booking table"). Shrimp settlement follows that SAME established
--      convention: AgroLink computes and records the exact amount owed
--      (aquaculture.harvest_settlement), both sides see it, and the farmer
--      marks it paid once money has actually changed hands outside the
--      system. Wiring this into the real ledger is future work tracked in
--      the architecture doc, not a shortcut invented here.
--   3. Ponds reuse registry.production_unit (unit_type='Pond' already in its
--      domain) via the EXISTING registry.register_production_unit()
--      function — no new pond table. A pond registered this way still needs
--      a GPS boundary polygon (that function's own validation), so
--      src/routes/aquaculture.js builds a small square buffer polygon around
--      a single lat/lng point the farmer enters, rather than requiring a
--      full map-drawing UI in this first pass (that's the "ง่ายๆก่อน" /
--      simple-form scope the user asked for).
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS aquaculture;

-- ----------------------------------------------------------------------------
-- 0. Shrimp species as commodity_ref rows — registry.register_production_unit
--    requires commodity_code to exist in registry.commodity_ref. Additive
--    only (existing RICE_JASMINE/RICE_PADDY/CASSAVA rows untouched).
-- ----------------------------------------------------------------------------
INSERT INTO registry.commodity_ref (commodity_code, name_th, agrovoc_ref) VALUES
  ('SHRIMP_VANNAMEI', 'กุ้งขาวแวนนาไม', NULL),
  ('SHRIMP_BLACKTIGER', 'กุ้งกุลาดำ', NULL),
  ('SHRIMP_OTHER', 'กุ้งชนิดอื่น', NULL)
ON CONFLICT (commodity_code) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 1. Farm profile — identity.farmer has no farm_name/province/district
--    columns (only a coarse region_code), and the auction detail page needs
--    something to show buyers. One profile per farmer.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aquaculture.farm_profile (
  farm_profile_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  farmer_id       uuid NOT NULL UNIQUE REFERENCES identity.farmer(farmer_id) ON DELETE CASCADE,
  farm_name       text NOT NULL,
  province        text NOT NULL,
  district        text,
  phone           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT farm_profile_farm_name_check CHECK (length(trim(farm_name)) > 0)
);

-- ----------------------------------------------------------------------------
-- 2. Sampling — used BOTH before opening an auction (purpose='pre_auction',
--    determines the Target size tier) and on harvest day
--    (purpose='final_harvest', determines the real settlement price). Same
--    table for both keeps "how a size estimate was produced" uniform.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aquaculture.sampling_event (
  sampling_id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id                uuid NOT NULL REFERENCES registry.production_unit(unit_id) ON DELETE CASCADE,
  purpose                text NOT NULL,
  sampled_at             timestamptz NOT NULL DEFAULT now(),
  computed_size_per_kg   numeric(6,2) NOT NULL,
  confidence_score       text NOT NULL,
  point_count            int NOT NULL,
  created_by_subject_type text NOT NULL,
  created_by_subject_id   uuid NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sampling_event_purpose_check CHECK (purpose IN ('pre_auction', 'final_harvest')),
  CONSTRAINT sampling_event_confidence_check CHECK (confidence_score IN ('High', 'Medium', 'Low')),
  CONSTRAINT sampling_event_size_check CHECK (computed_size_per_kg > 0),
  CONSTRAINT sampling_event_point_count_check CHECK (point_count >= 5)
);
CREATE INDEX IF NOT EXISTS idx_sampling_event_unit ON aquaculture.sampling_event (unit_id, purpose, sampled_at DESC);

CREATE TABLE IF NOT EXISTS aquaculture.sampling_point (
  point_id        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  sampling_id     uuid NOT NULL REFERENCES aquaculture.sampling_event(sampling_id) ON DELETE CASCADE,
  point_no        int NOT NULL,
  sample_count    int NOT NULL,
  sample_weight_kg numeric(8,3) NOT NULL,
  CONSTRAINT sampling_point_count_check CHECK (sample_count > 0),
  CONSTRAINT sampling_point_weight_check CHECK (sample_weight_kg > 0)
);
CREATE INDEX IF NOT EXISTS idx_sampling_point_event ON aquaculture.sampling_point (sampling_id);

-- ----------------------------------------------------------------------------
-- 3. procurement.auction extension — additive widening, matches the exact
--    pattern grant_sealed_bid_auction.sql already used for bid_visibility
--    (existing rows all default to 'reverse', unaffected).
-- ----------------------------------------------------------------------------
ALTER TABLE procurement.auction
  ADD COLUMN IF NOT EXISTS auction_mode text NOT NULL DEFAULT 'reverse'
    CHECK (auction_mode IN ('reverse', 'forward'));

-- A forward-mode (shrimp) bid has no single "the price" — it prices 5
-- separate size tiers in procurement.auction_bid_tier instead. bid_price
-- was NOT NULL with no default (reverse mode always has exactly one
-- price), so src/routes/aquaculture.js's forward-mode bid insert would
-- otherwise fail every time. Relaxing to nullable is safe: a CHECK
-- constraint treats NULL as satisfying it, so auction_bid_price_check
-- (bid_price > 0) still holds for every existing/future reverse-mode row,
-- which always supplies a real price and is never affected.
ALTER TABLE procurement.auction_bid ALTER COLUMN bid_price DROP NOT NULL;

COMMENT ON COLUMN procurement.auction.auction_mode IS
  'reverse (default, existing behaviour) = requester needs something, sellers bid price DOWN, lowest wins, auto-awarded on close. forward (new, shrimp/Auction Place) = requester (farmer) is selling, buyers bid price UP via a multi-size-tier matrix (procurement.auction_bid_tier), NOT auto-awarded — closing only flips status to closed; the farmer picks the winning bid manually via aquaculture.js.';

-- Widen status to add 'completed' (settlement paid) — drop/re-add is the
-- established pattern for widening a CHECK in this codebase (see
-- grant_b2b_commerce_engine.sql's party_role widening), never a destructive
-- rewrite, so existing 'open'/'closed'/'awarded'/'cancelled' rows/behaviour
-- are completely unaffected.
ALTER TABLE procurement.auction DROP CONSTRAINT IF EXISTS auction_status_check;
ALTER TABLE procurement.auction ADD CONSTRAINT auction_status_check
  CHECK (status IN ('open', 'closed', 'awarded', 'cancelled', 'completed'));

-- ----------------------------------------------------------------------------
-- 4. Shrimp-auction extension record — links a forward-mode auction back to
--    the pond/farmer it's for (procurement.rfq itself has no unit_id column).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aquaculture.shrimp_auction (
  auction_id       uuid PRIMARY KEY REFERENCES procurement.auction(auction_id) ON DELETE CASCADE,
  unit_id          uuid NOT NULL REFERENCES registry.production_unit(unit_id),
  farmer_id        uuid NOT NULL REFERENCES identity.farmer(farmer_id),
  pre_sampling_id  uuid REFERENCES aquaculture.sampling_event(sampling_id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shrimp_auction_farmer ON aquaculture.shrimp_auction (farmer_id);
CREATE INDEX IF NOT EXISTS idx_shrimp_auction_unit ON aquaculture.shrimp_auction (unit_id);

-- ----------------------------------------------------------------------------
-- 5. Size-tier price matrix — 5 rows per forward auction (S-2/S-1/Target/
--    S+1/S+2), and the price each bidder attaches to each tier.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aquaculture.auction_size_tier (
  tier_id        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  rfq_id         uuid NOT NULL REFERENCES procurement.rfq(rfq_id) ON DELETE CASCADE,
  tier_label     text NOT NULL,
  size_per_kg_min numeric(6,2) NOT NULL,
  size_per_kg_max numeric(6,2) NOT NULL,
  display_order  int NOT NULL,
  CONSTRAINT auction_size_tier_label_check CHECK (tier_label IN ('S-2', 'S-1', 'Target', 'S+1', 'S+2')),
  CONSTRAINT auction_size_tier_range_check CHECK (size_per_kg_max >= size_per_kg_min),
  CONSTRAINT uq_auction_size_tier_rfq_label UNIQUE (rfq_id, tier_label)
);
CREATE INDEX IF NOT EXISTS idx_auction_size_tier_rfq ON aquaculture.auction_size_tier (rfq_id);

CREATE TABLE IF NOT EXISTS procurement.auction_bid_tier (
  bid_tier_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  bid_id      uuid NOT NULL REFERENCES procurement.auction_bid(bid_id) ON DELETE CASCADE,
  tier_id     uuid NOT NULL REFERENCES aquaculture.auction_size_tier(tier_id) ON DELETE CASCADE,
  price       numeric(18,2) NOT NULL,
  CONSTRAINT auction_bid_tier_price_check CHECK (price > 0),
  CONSTRAINT uq_auction_bid_tier UNIQUE (bid_id, tier_id)
);
CREATE INDEX IF NOT EXISTS idx_auction_bid_tier_bid ON procurement.auction_bid_tier (bid_id);

COMMENT ON TABLE procurement.auction_bid_tier IS
  'Per-size price a bidder attaches to one procurement.auction_bid — a forward-mode (shrimp) bid must have exactly one row per aquaculture.auction_size_tier belonging to that auction, enforced at the API layer (src/routes/aquaculture.js), not by a DB trigger.';

-- ----------------------------------------------------------------------------
-- 6. Harvest settlement — the real price/amount once Final Sampling has
--    happened, computed from the WINNING bid's tier matrix. Payment itself
--    is recorded, not moved (see design note 2 above) — payment_status is
--    flipped by the farmer confirming money was received offline.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aquaculture.harvest_settlement (
  settlement_id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  auction_id             uuid NOT NULL UNIQUE REFERENCES procurement.auction(auction_id) ON DELETE CASCADE,
  final_sampling_id      uuid NOT NULL REFERENCES aquaculture.sampling_event(sampling_id),
  matched_tier_id        uuid NOT NULL REFERENCES aquaculture.auction_size_tier(tier_id),
  tier_price             numeric(18,2) NOT NULL,
  requires_renegotiation boolean NOT NULL DEFAULT false,
  actual_weight_kg       numeric(10,2),
  final_amount           numeric(18,2),
  payment_status         text NOT NULL DEFAULT 'pending',
  paid_confirmed_at      timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT harvest_settlement_tier_price_check CHECK (tier_price > 0),
  CONSTRAINT harvest_settlement_weight_check CHECK (actual_weight_kg IS NULL OR actual_weight_kg > 0),
  CONSTRAINT harvest_settlement_payment_status_check CHECK (payment_status IN ('pending', 'paid'))
);

-- ----------------------------------------------------------------------------
-- 7. Grants
-- ----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA aquaculture TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON aquaculture.farm_profile TO agrolink_app;
GRANT SELECT, INSERT ON aquaculture.sampling_event TO agrolink_app;
GRANT SELECT, INSERT ON aquaculture.sampling_point TO agrolink_app;
GRANT SELECT, INSERT ON aquaculture.shrimp_auction TO agrolink_app;
GRANT SELECT, INSERT ON aquaculture.auction_size_tier TO agrolink_app;
GRANT SELECT, INSERT ON procurement.auction_bid_tier TO agrolink_app;
-- forward-mode bid resubmission is implemented as DELETE-then-INSERT (see
-- src/routes/aquaculture.js) rather than an UPSERT, to avoid adding a new
-- UNIQUE(auction_id, bidder_org_id) constraint onto the SHARED
-- procurement.auction_bid table, which reverse-mode auctions may already
-- violate (their resubmission model keeps every historical row). DELETE was
-- not previously granted on this table (reverse mode never deletes bids).
GRANT DELETE ON procurement.auction_bid TO agrolink_app;
GRANT DELETE ON procurement.auction_bid_tier TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON aquaculture.harvest_settlement TO agrolink_app;
