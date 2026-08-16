-- AgroLink Platform — Cooperative produce/processed-goods catalog, reusing
-- the existing InputSupplier product-catalog machinery
-- (marketplace.product_listing / product_photo / product_order, added in
-- grant_input_supplier_and_buy_prices.sql + grant_farmer_product_orders.sql)
-- rather than building a parallel table set from scratch.
--
-- Context / decision: the platform already has an open-ended, one-row-per-
-- product catalog with photos, CRUD, and a full order lifecycle
-- (requested -> confirmed/rejected -> fulfilled/cancelled) — built for
-- InputSupplier orgs selling farming inputs TO farmers. The user asked for
-- cooperatives to be able to advertise their available produce/processed
-- goods (milled rice, dried paddy, etc.) to BUYER orgs using "this same
-- catalog" rather than a bespoke new one. Two structural gaps had to be
-- closed to make that possible:
--
--   1. category CHECK on both product_listing and product_order was
--      hard-coded to the four InputSupplier categories
--      (fertilizer_hormone/chemical_pesticide/equipment/other) — widened
--      below to add 'produce' (raw/dried, unprocessed) and
--      'processed_good' (milled/packaged). Which categories are valid for
--      a given seller org_type is enforced at the APPLICATION layer (see
--      src/routes/coopcollection.js's new /coop/products routes), same
--      convention as SATELLITE_OBSERVATION_TYPES in admin.js — the DB
--      CHECK is deliberately the union of every caller's allowed set, not
--      a per-org-type partition (Postgres CHECK constraints cannot see
--      another table to know the calling org's type).
--
--   2. product_order.farmer_id was NOT NULL — hard-wired to "a farmer
--      placed this order". A Buyer org (not a farmer) needs to be able to
--      place an order too. Rather than a parallel order table, farmer_id
--      is loosened to nullable and a new nullable buyer_org_id is added,
--      with a CHECK enforcing exactly one of the two is set — same
--      "generalize the existing table" call as widening category above,
--      and it keeps order history, status transitions, and the
--      confirm/reject/fulfill lifecycle unified across both seller
--      directions instead of duplicating that logic.
--
-- product_listing.org_id already REFERENCES partner.vendor_profile(org_id)
-- — NOT identity.organization directly. A cooperative provisioned via
-- POST /admin/cooperatives (M01) does NOT get a vendor_profile row
-- automatically (see the comment on POST /admin/cooperatives/:id/
-- activate-settlement in admin.js — that endpoint was built for exactly
-- this gap, for M09's settle_delivery() requirement). The new
-- /coop/products POST route below reuses that same idempotent
-- "INSERT INTO partner.vendor_profile ... IF NOT EXISTS" pattern inline,
-- so a cooperative can list products even if it has never processed a
-- buyer settlement before — no new migration needed for that part, it's
-- pure application logic.

-- ------------------------------------------------------------------
-- 1. Widen category on both tables to cover cooperative produce/goods.
-- ------------------------------------------------------------------
ALTER TABLE marketplace.product_listing DROP CONSTRAINT product_listing_category_check;
ALTER TABLE marketplace.product_listing ADD CONSTRAINT product_listing_category_check
  CHECK (category IN ('fertilizer_hormone', 'chemical_pesticide', 'equipment', 'other', 'produce', 'processed_good'));

ALTER TABLE marketplace.product_order DROP CONSTRAINT product_order_category_check;
ALTER TABLE marketplace.product_order ADD CONSTRAINT product_order_category_check
  CHECK (category IN ('fertilizer_hormone', 'chemical_pesticide', 'equipment', 'other', 'produce', 'processed_good'));

-- ------------------------------------------------------------------
-- 2. Let a Buyer org (not just a farmer) place a product_order.
-- ------------------------------------------------------------------
ALTER TABLE marketplace.product_order ALTER COLUMN farmer_id DROP NOT NULL;

ALTER TABLE marketplace.product_order
  ADD COLUMN IF NOT EXISTS buyer_org_id uuid REFERENCES identity.organization(org_id) ON DELETE CASCADE;

ALTER TABLE marketplace.product_order
  ADD CONSTRAINT product_order_orderer_check
  CHECK (
    (farmer_id IS NOT NULL AND buyer_org_id IS NULL)
    OR (farmer_id IS NULL AND buyer_org_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_product_order_buyer_org
  ON marketplace.product_order (buyer_org_id, status)
  WHERE buyer_org_id IS NOT NULL;

-- No new GRANTs needed: agrolink_app already holds SELECT/INSERT/UPDATE on
-- marketplace.product_order and SELECT/INSERT/UPDATE/DELETE on
-- marketplace.product_listing (grant_input_supplier_and_buy_prices.sql) —
-- a table-level grant automatically covers a column added afterward, and
-- partner.vendor_profile's INSERT grant already exists too (used by
-- POST /admin/cooperatives/:id/activate-settlement, see admin.js).

-- ============================================================
-- Verification notes (run manually, not part of this script):
--   \d marketplace.product_listing
--   \d marketplace.product_order
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'marketplace.product_order'::regclass;
-- ============================================================
