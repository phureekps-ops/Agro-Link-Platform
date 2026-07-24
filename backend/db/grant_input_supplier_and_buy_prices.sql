-- AgroLink Platform — InputSupplier product catalog + Buyer daily
-- rice-buying-price announcements.
--
-- Two independent features bundled into one migration since both were
-- requested together and both extend the existing `marketplace` schema
-- (the same schema `grant_machinery_marketplace.sql` opened up earlier
-- for `marketplace.service_listing`/`vendor_photo`):
--
--   1. ผู้จัดจำหน่ายปัจจัยการผลิต (InputSupplier) — a product catalog so a
--      supplier can list what they sell, categorized into ปุ๋ย/ฮอร์โมน,
--      สารเคมีและยาปราบศัตรูพืช, อุปกรณ์การเกษตร, and อื่นๆ, with photos.
--      Unlike the Machinery Portal's rate card (7 FIXED line items,
--      upserted by a fixed `service_key`), a product catalog is an
--      open-ended list — a supplier might sell 3 products or 300 — so this
--      is modeled as a normal one-row-per-product table with full
--      create/update/delete, not a fixed-key upsert.
--
--   2. ผู้รับซื้อผลผลิต (Buyer) — a daily rice-buying-price announcement:
--      each Buyer sets/adjusts their own current buying price per rice
--      grade (ข้าวเปลือกหอมมะลิ 105, ปทุมธานี 1, ฯลฯ — referencing the same
--      grade categories a typical rice mill's daily price board uses, per
--      the product decision "ให้อ้างอิงชนิดข้าวจากโรงสีทั่วไป"), and farmers
--      can see and compare every Buyer's current price
--      (GET /farmer/rice-prices) before deciding where to sell — the
--      explicit point of an "announcement," not just an internal buyer
--      tool. Like the machinery rate card, this tracks only the CURRENT
--      live quote per (org, grade) — no historical price archive (see
--      "what's mocked" in backend/README.md).

-- ============================================================
-- 1. InputSupplier product catalog
-- ============================================================

CREATE TABLE IF NOT EXISTS marketplace.product_listing (
  listing_id    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        uuid NOT NULL REFERENCES partner.vendor_profile(org_id),
  category      text NOT NULL,
  product_name  text NOT NULL,
  brand         text,
  description   text,
  unit_price    numeric(18,2) NOT NULL,
  price_unit    text NOT NULL DEFAULT 'บาท/หน่วย',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_listing_category_check
    CHECK (category IN ('fertilizer_hormone', 'chemical_pesticide', 'equipment', 'other')),
  CONSTRAINT product_listing_unit_price_check CHECK (unit_price > 0),
  CONSTRAINT product_listing_product_name_check CHECK (length(trim(product_name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_product_listing_org ON marketplace.product_listing (org_id);
CREATE INDEX IF NOT EXISTS idx_product_listing_org_category ON marketplace.product_listing (org_id, category);

-- Photos are per-PRODUCT here (unlike marketplace.vendor_photo, which is
-- per-ORG with a fixed 'service'/'machinery' type tag) — a catalog with
-- more than one product needs each product to carry its own picture, not
-- one shared org-wide gallery. `org_id` is denormalized onto this table
-- (rather than requiring a join through product_listing) so every route
-- below can scope with a single explicit `WHERE org_id = $1`, matching the
-- established security convention for this whole schema (see the note at
-- the top of src/routes/machinery.js — marketplace.* has NO row-level
-- security at all; the explicit WHERE clause in every query IS the
-- security boundary, not defense-in-depth).
CREATE TABLE IF NOT EXISTS marketplace.product_photo (
  photo_id        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id      uuid NOT NULL REFERENCES marketplace.product_listing(listing_id) ON DELETE CASCADE,
  org_id          uuid NOT NULL,
  photo_data_url  text NOT NULL,
  caption         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_photo_listing ON marketplace.product_photo (listing_id);
CREATE INDEX IF NOT EXISTS idx_product_photo_org ON marketplace.product_photo (org_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON marketplace.product_listing TO agrolink_app;
GRANT SELECT, INSERT, DELETE ON marketplace.product_photo TO agrolink_app;

-- ============================================================
-- 2. Buyer daily rice-buying-price announcements
-- ============================================================

-- Reference list of rice grades a Buyer can quote a price against —
-- modeled after the categories a typical Thai rice mill's own daily price
-- board uses, per the explicit product direction "ให้อ้างอิงชนิดข้าวจาก
-- โรงสีทั่วไป". Deliberately its own small reference table rather than
-- widening registry.commodity_ref (which is generic/high-level — 3 rows:
-- RICE_JASMINE, RICE_PADDY, CASSAVA — used for production-unit/delivery
-- commodity tracking, not price-board-level rice grades).
CREATE TABLE IF NOT EXISTS registry.rice_grade_ref (
  grade_code  text PRIMARY KEY,
  name_th     text NOT NULL,
  sort_order  int NOT NULL
);

INSERT INTO registry.rice_grade_ref (grade_code, name_th, sort_order) VALUES
  ('HOMMALI105',      'ข้าวเปลือกเจ้าหอมมะลิ 105', 1),
  ('PATHUMTHANI1',    'ข้าวเปลือกเจ้าปทุมธานี 1', 2),
  ('WHITE_RICE_5',    'ข้าวเปลือกเจ้า 5%', 3),
  ('WHITE_RICE_25',   'ข้าวเปลือกเจ้า 25%', 4),
  ('GLUTINOUS_RD6',   'ข้าวเปลือกเหนียว กข6 (เมล็ดยาว)', 5),
  ('GLUTINOUS_RD10',  'ข้าวเปลือกเหนียว กข10 (เมล็ดยาว)', 6),
  ('GLUTINOUS_SHORT', 'ข้าวเปลือกเหนียวเมล็ดสั้น', 7)
ON CONFLICT (grade_code) DO NOTHING;

GRANT SELECT ON registry.rice_grade_ref TO agrolink_app;

-- One CURRENT price per (Buyer org, rice grade) — an upsert target, same
-- shape as marketplace.service_listing's (org_id, service_key) pattern,
-- but here the composite PRIMARY KEY itself is the natural unique target
-- (not a partial index), so the ON CONFLICT (org_id, grade_code) arbiter
-- in buyer.js's PUT handler needs no WHERE-predicate — this sidesteps the
-- exact `42P10` partial-index-arbiter bug fixed earlier in
-- src/routes/machinery.js (see backend/README.md's verification section)
-- since there is no partial index involved here at all.
CREATE TABLE IF NOT EXISTS marketplace.buy_price_quote (
  org_id        uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  grade_code    text NOT NULL REFERENCES registry.rice_grade_ref(grade_code),
  quoted_price  numeric(18,2) NOT NULL,
  price_unit    text NOT NULL DEFAULT 'บาท/ตัน',
  is_active     boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, grade_code),
  CONSTRAINT buy_price_quote_price_check CHECK (quoted_price > 0)
);

CREATE INDEX IF NOT EXISTS idx_buy_price_quote_grade_active
  ON marketplace.buy_price_quote (grade_code)
  WHERE is_active;

GRANT SELECT, INSERT, UPDATE ON marketplace.buy_price_quote TO agrolink_app;

-- ============================================================
-- Verification notes (run manually, not part of this script):
--   \d marketplace.product_listing / marketplace.product_photo /
--   marketplace.buy_price_quote / registry.rice_grade_ref
--   SELECT * FROM registry.rice_grade_ref ORDER BY sort_order;
-- ============================================================
