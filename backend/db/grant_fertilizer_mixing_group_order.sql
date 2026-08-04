-- grant_fertilizer_mixing_group_order.sql
--
-- Fulfillment Marketplace (module 2.3) — เส้นทาง B: รวมกลุ่มสั่งซื้อบริการผสมปุ๋ย
-- สั่งตัด (group buying / order pooling). Product decision made with the
-- user: a FARMER starts the group (not the platform auto-matching by
-- location/time, and not the provider) — they pick a Verified
-- FertilizerMixingService provider's listing, share an invite code with
-- other farmers, and once the group's combined kg crosses a threshold the
-- PROVIDER set on their own rate card, every order in the group gets a
-- per-kg discount.
--
-- Design, kept as close as possible to the เส้นทาง A pattern already in
-- grant_fertilizer_mixing_service.sql (same author intent, same file, same
-- reviewer should read both together):
--
--   1. A group starts as a lightweight "pledge" — marketplace.
--      fertilizer_mixing_group_order (the group shell) plus one
--      marketplace.fertilizer_mixing_group_participant row per farmer who
--      joins (including the organizer). NEITHER of these is a real order
--      yet — no provider sees anything, nothing is snapshotted into their
--      review queue, and a farmer can freely withdraw.
--   2. Only when the ORGANIZER explicitly submits the group (POST
--      /farmer/fertilizer-mixing-groups/:id/submit — see
--      src/routes/fertilizer.js) does this become real: every current
--      participant gets one real marketplace.fertilizer_mixing_order row
--      created for them (group_id set), using the group's own final
--      unit_price (discounted if the group's total kg met the provider's
--      threshold, the listing's normal price otherwise). From that moment
--      on, every one of those orders flows through the EXACT SAME
--      Accept/Decline/Complete lifecycle a solo เส้นทาง A order already
--      does — src/routes/fertilizermixing.js (the provider's dashboard)
--      needed NO new endpoints for this, only two additive read-side
--      touches (rate-card discount fields, group_id surfaced on order
--      rows) — see the router file's own comments.
--   3. No auto-submit on a background job/cron: this sandbox has no
--      scheduler, and the product decision was that GROUP FINALIZATION IS
--      AN EXPLICIT ORGANIZER ACTION. join_deadline is advisory (shown to
--      farmers deciding whether to join a group that's about to close) —
--      nothing automatically happens when it passes; the organizer must
--      still click "ยืนยันส่งคำขอกลุ่ม" (or "ยกเลิกกลุ่ม") themselves. A
--      future scheduled job auto-submitting/expiring stale Open groups is
--      an explicit, documented gap (see backend/README.md's Next Steps).
--
-- Explicitly OUT of scope for this pass (documented, not silently
-- dropped): multiple discount TIERS (v1 is one threshold + one flat
-- percent per listing, matching เส้นทาง A's one-rate-card-item
-- simplicity); a shared delivery date/address across the whole group
-- (each participant still sets their own, same fields a solo order
-- already has); re-joining a group after withdrawing (UNIQUE(group_id,
-- farmer_id) below blocks it — a farmer who changes their mind needs a
-- fresh invite-code lookup, which still works, just creates no new
-- participant row until they re-POST join, which a repeat call to the
-- same endpoint after a genuine DB delete would allow — see the route's
-- own doc comment for the exact re-join semantics implemented).

-- ---------------------------------------------------------------------
-- 1. Provider-set volume-discount policy on their own fertilizer-mixing
--    rate card row. Both nullable — a provider who never sets these has
--    simply not opted into group-buying discounts; solo orders (เส้นทาง A)
--    are completely unaffected either way. Lives on marketplace.
--    service_listing (not a new table) since it's a property of the ONE
--    rate-card line item this portal has (fertilizer_custom_mix), read
--    and written through the same GET/PUT /fertilizermixing/rate-card
--    upsert src/routes/fertilizermixing.js already has.
-- ---------------------------------------------------------------------
ALTER TABLE marketplace.service_listing
  ADD COLUMN IF NOT EXISTS bulk_discount_min_kg numeric(10,2),
  ADD COLUMN IF NOT EXISTS bulk_discount_percent numeric(5,2);

ALTER TABLE marketplace.service_listing DROP CONSTRAINT IF EXISTS service_listing_bulk_discount_percent_check;
ALTER TABLE marketplace.service_listing ADD CONSTRAINT service_listing_bulk_discount_percent_check
  CHECK (bulk_discount_percent IS NULL OR (bulk_discount_percent > 0 AND bulk_discount_percent <= 50));

ALTER TABLE marketplace.service_listing DROP CONSTRAINT IF EXISTS service_listing_bulk_discount_min_kg_check;
ALTER TABLE marketplace.service_listing ADD CONSTRAINT service_listing_bulk_discount_min_kg_check
  CHECK (bulk_discount_min_kg IS NULL OR bulk_discount_min_kg > 0);

COMMENT ON COLUMN marketplace.service_listing.bulk_discount_min_kg IS
  'เส้นทาง B: เมื่อยอดรวม กก. ของกลุ่มสั่งซื้อ (urea+dap+mop รวมทุกคนในกลุ่ม) ถึงเกณฑ์นี้ ทุกคำสั่งซื้อในกลุ่มจะได้รับส่วนลด bulk_discount_percent ต่อกก. — ใช้เฉพาะ service_key = fertilizer_custom_mix, เป็น NULL ได้ถ้าผู้ให้บริการยังไม่เปิดใช้ส่วนลดกลุ่ม';
COMMENT ON COLUMN marketplace.service_listing.bulk_discount_percent IS
  'เส้นทาง B: เปอร์เซ็นต์ส่วนลดต่อกก. เมื่อกลุ่มถึงเกณฑ์ bulk_discount_min_kg (0-50%) — ดู src/routes/fertilizer.js POST /farmer/fertilizer-mixing-groups/:id/submit สำหรับตรรกะการคำนวณราคาสุดท้าย';

-- ---------------------------------------------------------------------
-- 2. marketplace.fertilizer_mixing_group_order — the group "shell".
--    service_key/label_th/service_type/unit_price/price_unit/
--    bulk_discount_min_kg/bulk_discount_percent are SNAPSHOTTED from the
--    listing at group-CREATION time (same snapshot convention as
--    fertilizer_mixing_order itself) — a provider editing their rate card
--    or discount policy mid-group must not silently change what farmers
--    already joined expecting.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.fertilizer_mixing_group_order (
  group_id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id           uuid NOT NULL REFERENCES marketplace.service_listing(listing_id),
  org_id               uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  organizer_farmer_id  uuid NOT NULL REFERENCES identity.farmer(farmer_id) ON DELETE CASCADE,
  -- Short, farmer-shareable invite code (e.g. via LINE/social) — NOT the
  -- uuid group_id, which is unwieldy to type/read aloud. Generated by the
  -- application (src/routes/fertilizer.js), not the database, so the
  -- exact alphabet/length can change without a migration.
  group_code           text NOT NULL,
  status               text NOT NULL DEFAULT 'Open',
  join_deadline        timestamptz NOT NULL,
  -- Snapshot of the listing + its discount policy at group-creation time.
  service_key          text NOT NULL,
  label_th             text NOT NULL,
  service_type         text NOT NULL,
  unit_price           numeric(18,2) NOT NULL,
  price_unit           text NOT NULL,
  bulk_discount_min_kg  numeric(10,2),
  bulk_discount_percent numeric(5,2),
  -- Filled in only at submission (see POST .../:id/submit) — NULL for
  -- every still-Open or Cancelled group.
  final_total_kg       numeric(10,2),
  final_unit_price     numeric(18,2),
  discount_applied     boolean,
  created_at           timestamptz NOT NULL DEFAULT now(),
  submitted_at         timestamptz,
  cancelled_at          timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fertilizer_mixing_group_order_status_check
    CHECK (status IN ('Open', 'Submitted', 'Cancelled')),
  CONSTRAINT fertilizer_mixing_group_order_code_unique UNIQUE (group_code)
);

CREATE INDEX IF NOT EXISTS idx_fertilizer_mixing_group_order_org ON marketplace.fertilizer_mixing_group_order (org_id, status);
CREATE INDEX IF NOT EXISTS idx_fertilizer_mixing_group_order_organizer ON marketplace.fertilizer_mixing_group_order (organizer_farmer_id);

GRANT SELECT, INSERT, UPDATE ON marketplace.fertilizer_mixing_group_order TO agrolink_app;

COMMENT ON TABLE marketplace.fertilizer_mixing_group_order IS 'กลุ่มรวมสั่งซื้อบริการผสมปุ๋ยสั่งตัด (Fulfillment Marketplace เส้นทาง B, module 2.3) — เกษตรกรผู้ริเริ่มกลุ่ม (organizer_farmer_id) เชิญเกษตรกรอื่นเข้าร่วมผ่าน group_code, เมื่อยอดรวมถึงเกณฑ์ที่ผู้ให้บริการตั้งไว้ทุกคำสั่งซื้อในกลุ่มได้รับส่วนลด ดู src/routes/fertilizer.js';

-- ---------------------------------------------------------------------
-- 3. marketplace.fertilizer_mixing_group_participant — one row per farmer
--    who has (or had) pledged into a group. NOT yet a real order — see
--    header comment. order_id is filled in only once, at submission, and
--    never changes after.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.fertilizer_mixing_group_participant (
  participant_id     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id           uuid NOT NULL REFERENCES marketplace.fertilizer_mixing_group_order(group_id) ON DELETE CASCADE,
  farmer_id          uuid NOT NULL REFERENCES identity.farmer(farmer_id) ON DELETE CASCADE,
  unit_id            uuid NOT NULL REFERENCES registry.production_unit(unit_id) ON DELETE CASCADE,
  requested_urea_kg  numeric(8,2),
  requested_dap_kg   numeric(8,2),
  requested_mop_kg   numeric(8,2),
  delivery_option    text NOT NULL DEFAULT 'pickup',
  delivery_address   text,
  preferred_date     date NOT NULL,
  farmer_note        text,
  status             text NOT NULL DEFAULT 'Joined',
  -- Set once, at group submission — links this pledge to the real order
  -- created for it. NULL for every still-pending or withdrawn pledge.
  order_id           uuid REFERENCES marketplace.fertilizer_mixing_order(order_id),
  joined_at          timestamptz NOT NULL DEFAULT now(),
  withdrawn_at       timestamptz,
  CONSTRAINT fertilizer_mixing_group_participant_status_check
    CHECK (status IN ('Joined', 'Withdrawn')),
  CONSTRAINT fertilizer_mixing_group_participant_delivery_option_check
    CHECK (delivery_option IN ('pickup', 'delivery')),
  -- One participation row per farmer per group. A farmer who withdraws
  -- cannot re-join the SAME group in v1 (their row still exists, just
  -- Withdrawn) — see header comment's explicit scope note.
  CONSTRAINT fertilizer_mixing_group_participant_unique UNIQUE (group_id, farmer_id)
);

CREATE INDEX IF NOT EXISTS idx_fertilizer_mixing_group_participant_group ON marketplace.fertilizer_mixing_group_participant (group_id, status);
CREATE INDEX IF NOT EXISTS idx_fertilizer_mixing_group_participant_farmer ON marketplace.fertilizer_mixing_group_participant (farmer_id);

-- No DELETE grant — a withdrawal is a status transition (status =
-- 'Withdrawn'), not a row delete, same convention as every *_booking /
-- *_order table in this project.
GRANT SELECT, INSERT, UPDATE ON marketplace.fertilizer_mixing_group_participant TO agrolink_app;

COMMENT ON TABLE marketplace.fertilizer_mixing_group_participant IS 'เกษตรกรแต่ละคนที่เข้าร่วมกลุ่มรวมสั่งซื้อ (ยังไม่ใช่คำสั่งซื้อจริงจนกว่ากลุ่มจะถูกส่ง — ดู order_id) ดู marketplace.fertilizer_mixing_group_order และ src/routes/fertilizer.js';

-- ---------------------------------------------------------------------
-- 4. Link a real fertilizer_mixing_order back to the group it came from
--    (NULL for every solo เส้นทาง A order — fully backward compatible,
--    src/routes/fertilizermixing.js's existing queries are entirely
--    unaffected by this new nullable column).
-- ---------------------------------------------------------------------
ALTER TABLE marketplace.fertilizer_mixing_order
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES marketplace.fertilizer_mixing_group_order(group_id);

CREATE INDEX IF NOT EXISTS idx_fertilizer_mixing_order_group ON marketplace.fertilizer_mixing_order (group_id);

-- ---------------------------------------------------------------------
-- Reminder for the next person reading this: both new tables (and the
-- widened fertilizer_mixing_order) have NO row-level security
-- (relrowsecurity = false), same situation as every other marketplace.*
-- table in this project. src/routes/fertilizer.js's explicit `WHERE
-- farmer_id = $1` / `WHERE organizer_farmer_id = $1` clauses ARE the
-- entire security boundary for who can see/act on a group and its
-- participant rows — not defense-in-depth. group_code lookup (GET
-- /farmer/fertilizer-mixing-groups/:code) is the one intentional
-- exception: any authenticated farmer who has the code can read that
-- group's summary (by design — that's how an invite link works), but
-- still cannot join/withdraw/submit/cancel on another farmer's behalf.
-- ---------------------------------------------------------------------
