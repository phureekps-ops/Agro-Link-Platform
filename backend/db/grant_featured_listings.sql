-- grant_featured_listings.sql
--
-- Adds "สินค้า/บริการแนะนำ" (Featured Listing) support to marketplace.
-- product_listing (InputSupplier catalog) and marketplace.service_listing
-- (Machinery rate card) — backs the new Platform-Ops-managed promotion
-- feature: GET/POST /admin/product-listings* and
-- GET/POST /admin/service-listings* (src/routes/admin.js), surfaced to
-- farmers as a sort-to-top + "⭐ แนะนำ" badge on GET /farmer/products and
-- GET /farmer/machinery-providers.
--
-- Deliberately admin-toggled rather than self-serve by the provider org:
-- like every other paid interaction already in this platform (loan
-- disbursement, machinery/product payment — all settled OFFLINE), there is
-- no real online payment gateway integrated anywhere. A provider pays the
-- AgroLink team offline, and a Platform Ops admin then flips is_featured
-- on for a chosen number of days via the new admin routes — same operating
-- model as KYB approval and business-role approval elsewhere in admin.js.
--
-- featured_until is nullable: NULL together with is_featured = true would
-- mean "featured with no expiry" if ever used that way, but the admin UI
-- always sends a days count that computes a concrete expiry, so in
-- practice the two columns are always set together.
--
-- No new GRANT statements needed below — agrolink_app already has UPDATE
-- on both tables (grant_input_supplier_and_buy_prices.sql for
-- product_listing, grant_machinery_marketplace.sql for service_listing).
-- A table-level UPDATE grant automatically covers columns added to that
-- table afterward; it does not need to be re-granted per column.

ALTER TABLE marketplace.product_listing
  ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS featured_until timestamptz;

ALTER TABLE marketplace.service_listing
  ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS featured_until timestamptz;

CREATE INDEX IF NOT EXISTS idx_product_listing_featured
  ON marketplace.product_listing (is_featured, featured_until)
  WHERE is_featured = true;

CREATE INDEX IF NOT EXISTS idx_service_listing_featured
  ON marketplace.service_listing (is_featured, featured_until)
  WHERE is_featured = true;
