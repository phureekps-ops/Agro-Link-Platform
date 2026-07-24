-- AgroLink Platform — Farmer-facing browse + order flow against the
-- InputSupplier product catalog.
--
-- Builds on marketplace.product_listing/product_photo (added earlier the
-- same week — see grant_input_supplier_and_buy_prices.sql), which until now
-- was manageable by a supplier but invisible to farmers: nothing let a
-- farmer see it or place an order against it (called out explicitly as a
-- gap in backend/README.md's "what's mocked" section). This migration adds
-- the missing half.
--
-- Once orders can reference a listing_id, marketplace.product_listing can
-- no longer be safely hard-deleted (see the note in that table's original
-- migration promising exactly this change once an order flow existed) —
-- DELETE /inputsupplier/products/:id switches to deactivate-only
-- (is_active = false) in src/routes/inputsupplier.js, matching the pattern
-- already used by PUT /machinery/rate-card. This migration does not need to
-- touch product_listing's schema for that — is_active already exists.

-- marketplace.product_order — one row per farmer order against one
-- supplier's product. Price/name/category are SNAPSHOTTED onto the order
-- at creation time (not read live via a join to product_listing every time)
-- — the same reasoning a real invoice line item follows: if the supplier
-- edits their price tomorrow, an order placed today must not silently
-- change value. listing_id is still kept as a real FK (for traceability
-- back to the catalog entry), just not relied on for display.
CREATE TABLE IF NOT EXISTS marketplace.product_order (
  order_id        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id      uuid NOT NULL REFERENCES marketplace.product_listing(listing_id),
  org_id          uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  farmer_id       uuid NOT NULL REFERENCES identity.farmer(farmer_id) ON DELETE CASCADE,
  -- Snapshot of the listing at order time (see comment above).
  product_name    text NOT NULL,
  category        text NOT NULL,
  unit_price      numeric(18,2) NOT NULL,
  price_unit      text NOT NULL,
  quantity        numeric(14,2) NOT NULL,
  total_price     numeric(18,2) NOT NULL,
  status          text NOT NULL DEFAULT 'requested',
  decided_reason  text,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  fulfilled_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_order_status_check
    CHECK (status IN ('requested', 'confirmed', 'rejected', 'fulfilled', 'cancelled')),
  CONSTRAINT product_order_category_check
    CHECK (category IN ('fertilizer_hormone', 'chemical_pesticide', 'equipment', 'other')),
  CONSTRAINT product_order_quantity_check CHECK (quantity > 0),
  CONSTRAINT product_order_unit_price_check CHECK (unit_price > 0),
  CONSTRAINT product_order_total_price_check CHECK (total_price > 0)
);

-- Same denormalized-org_id-for-direct-WHERE-scoping convention as every
-- other marketplace.* table — see the note at the top of
-- src/routes/machinery.js. marketplace.product_order has NO row-level
-- security either; the explicit `WHERE org_id = $1` (supplier side) /
-- `WHERE farmer_id = $1` (farmer side) in every query IS the security
-- boundary, not defense-in-depth.
CREATE INDEX IF NOT EXISTS idx_product_order_org ON marketplace.product_order (org_id, status);
CREATE INDEX IF NOT EXISTS idx_product_order_farmer ON marketplace.product_order (farmer_id);
CREATE INDEX IF NOT EXISTS idx_product_order_listing ON marketplace.product_order (listing_id);

-- No DELETE grant — orders are never deleted, only status-transitioned
-- (requested -> confirmed/rejected/cancelled -> fulfilled), same convention
-- as underwriting.loan_application and produce.delivery, neither of which
-- ever gets a row removed either.
GRANT SELECT, INSERT, UPDATE ON marketplace.product_order TO agrolink_app;

-- ============================================================
-- Verification notes (run manually, not part of this script):
--   \d marketplace.product_order
-- ============================================================
