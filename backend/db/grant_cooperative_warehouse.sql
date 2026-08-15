-- AgroLink -- Cooperative SaaS, M10 Warehouse / Drying.
--
-- Context: AgroLink_Cooperative_SaaS_Master_Blueprint_v1.0's Gap Analysis
-- flagged M10 as a genuine gap — "ไม่มี schema/route ใดๆ" (nothing exists at
-- all, confirmed again here by grepping 02_full_schema.sql for warehouse/
-- storage/bin/dry — zero matches). This migration is the first real
-- implementation of it, and is deliberately scoped as a direct extension of
-- M09 Collection & Quality: produce.lot (added in
-- grant_cooperative_collection_station.sql) already represents "a batch of
-- collected produce" — M10 answers the next question, "where does that lot
-- physically sit, and how full is each storage location."
--
-- NOT the same thing as the existing M08 machinery/drying-yard BOOKING
-- system (marketplace.service_listing + marketplace.machinery_booking,
-- src/routes/machinery.js + farmermachinery.js): that lets a farmer book a
-- time slot at a THIRD-PARTY drying-yard/machinery business. M10 is a
-- cooperative's OWN warehouse — bins/locations it operates itself, with
-- inventory movements and moisture readings over time — a completely
-- different data shape (no calendar/booking concept here at all, no
-- third-party provider). The two modules can coexist without conflict;
-- confirmed no table/route name collisions.
--
-- New schema (`warehouse`) rather than folding into `produce` or
-- `registry`, matching the platform's one-schema-per-domain convention
-- (produce, contract, credit, ledger, marketplace, partner, production,
-- registry, risk, traceability, underwriting are all separate domain
-- schemas already). A brand-new schema needs its own explicit
-- `GRANT USAGE ON SCHEMA` — 03_grant_schema_usage.sql's own header comment
-- explains why this is easy to forget (Postgres checks schema USAGE before
-- table privileges) — done below.
--
-- Scope explicitly NOT covered here (documented as a Follow-up, matching
-- the convention in every prior grant_cooperative_*.sql migration):
--   - facility.org_id has no org_type restriction (same convention as
--     produce.delivery.buyer_org_id) — a Buyer could in principle also
--     operate a warehouse, but the route layer built alongside this
--     migration (coopcollection.js) only exposes it under /coop/*.
--     Wiring an equivalent slice into buyer.js is left for later if a real
--     Buyer pilot asks for it.
--   - No processing/output-batch concept (that is M11's job — a lot
--     leaving a warehouse via warehouse.release_lot() just marks it gone
--     from storage; what happens to it next is out of scope here).
--   - No physical weighbridge/IoT integration — quantity_ton and
--     moisture_pct on every movement/reading are manually entered by
--     cooperative staff, same as every other manual-entry number
--     elsewhere in this platform (see produce.confirm_quality()).
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS warehouse;
GRANT USAGE ON SCHEMA warehouse TO agrolink_app;

-- ---------------------------------------------------------------------------
-- 1. warehouse.facility — a cooperative's own storage site (a warehouse
--    building, a drying yard, a silo). No RLS — same `WHERE org_id = $1`
--    convention as produce.delivery/produce.lot; the route layer is the
--    entire security boundary.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS warehouse.facility (
  facility_id     uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  org_id          uuid NOT NULL REFERENCES identity.organization(org_id),
  facility_name   text NOT NULL,
  facility_type   text NOT NULL,
  capacity_ton    numeric(14,3),
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT facility_type_check CHECK (facility_type IN ('Warehouse', 'DryingYard', 'Silo')),
  CONSTRAINT facility_status_check CHECK (status IN ('active', 'inactive')),
  CONSTRAINT facility_capacity_check CHECK (capacity_ton IS NULL OR capacity_ton > 0)
);

CREATE INDEX IF NOT EXISTS idx_facility_org ON warehouse.facility (org_id);

-- ---------------------------------------------------------------------------
-- 2. warehouse.bin — a storage location within a facility (a specific bin,
--    drying floor section, or silo cell). bin_code unique per facility
--    (not globally) — two different cooperatives' facilities can both have
--    a "A1".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS warehouse.bin (
  bin_id          uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  facility_id     uuid NOT NULL REFERENCES warehouse.facility(facility_id) ON DELETE CASCADE,
  bin_code        text NOT NULL,
  capacity_ton    numeric(14,3),
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bin_status_check CHECK (status IN ('active', 'inactive')),
  CONSTRAINT bin_capacity_check CHECK (capacity_ton IS NULL OR capacity_ton > 0),
  CONSTRAINT uq_bin_facility_code UNIQUE (facility_id, bin_code)
);

CREATE INDEX IF NOT EXISTS idx_bin_facility ON warehouse.bin (facility_id);

-- ---------------------------------------------------------------------------
-- 3. warehouse.movement — the full inventory-movement ledger for a lot.
--    receive: from_bin_id NULL, to_bin_id = where it enters storage.
--    transfer: from_bin_id = source, to_bin_id = destination (both must
--      belong to the SAME facility_id — checked in the function, not by a
--      constraint, since that needs a lookup).
--    release: from_bin_id = source, to_bin_id NULL — the lot leaves
--      warehouse tracking entirely (sold, sent to processing, etc.).
--    A lot's CURRENT location is derived (not stored) from the most recent
--    row here — see warehouse.v_lot_current_location below — avoiding a
--    denormalized "current_bin_id" column on produce.lot that could drift
--    out of sync with the movement history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS warehouse.movement (
  movement_id     uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  lot_id          uuid NOT NULL REFERENCES produce.lot(lot_id),
  from_bin_id     uuid REFERENCES warehouse.bin(bin_id),
  to_bin_id       uuid REFERENCES warehouse.bin(bin_id),
  movement_type   text NOT NULL,
  quantity_ton    numeric(14,3) NOT NULL,
  moisture_pct    numeric(5,2),
  recorded_by     text NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  note            text,
  CONSTRAINT movement_type_check CHECK (movement_type IN ('receive', 'transfer', 'release')),
  CONSTRAINT movement_quantity_check CHECK (quantity_ton > 0),
  CONSTRAINT movement_moisture_check CHECK (moisture_pct IS NULL OR (moisture_pct >= 0 AND moisture_pct <= 100)),
  CONSTRAINT movement_receive_shape CHECK (movement_type <> 'receive' OR (from_bin_id IS NULL AND to_bin_id IS NOT NULL)),
  CONSTRAINT movement_transfer_shape CHECK (movement_type <> 'transfer' OR (from_bin_id IS NOT NULL AND to_bin_id IS NOT NULL)),
  CONSTRAINT movement_release_shape CHECK (movement_type <> 'release' OR (from_bin_id IS NOT NULL AND to_bin_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_movement_lot ON warehouse.movement (lot_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_movement_to_bin ON warehouse.movement (to_bin_id);
CREATE INDEX IF NOT EXISTS idx_movement_from_bin ON warehouse.movement (from_bin_id);

-- ---------------------------------------------------------------------------
-- 4. warehouse.drying_reading — periodic ความชื้น readings for a lot while
--    it sits in a (usually DryingYard-type) bin, independent of the one-off
--    moisture_pct captured at M09's produce.confirm_quality() time. This is
--    what lets a "batch อบแห้ง" actually be tracked over several days
--    rather than a single snapshot.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS warehouse.drying_reading (
  reading_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  lot_id          uuid NOT NULL REFERENCES produce.lot(lot_id),
  bin_id          uuid NOT NULL REFERENCES warehouse.bin(bin_id),
  moisture_pct    numeric(5,2) NOT NULL,
  recorded_by     text NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drying_reading_moisture_check CHECK (moisture_pct >= 0 AND moisture_pct <= 100)
);

CREATE INDEX IF NOT EXISTS idx_drying_reading_lot ON warehouse.drying_reading (lot_id, recorded_at);

GRANT SELECT, INSERT, UPDATE ON warehouse.facility TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON warehouse.bin TO agrolink_app;
GRANT SELECT, INSERT ON warehouse.movement TO agrolink_app;
GRANT SELECT, INSERT ON warehouse.drying_reading TO agrolink_app;

-- ---------------------------------------------------------------------------
-- 5. Views — utilization (per bin, and rolled up per facility) and each
--    lot's current location. Views run with the OWNER's (postgres')
--    privileges to read the underlying tables (same pattern already used
--    by produce.v_delivery_status / partner.v_vendor_directory) — so only
--    SELECT on the view itself is needed, not additional table grants.
-- ---------------------------------------------------------------------------
CREATE VIEW warehouse.v_bin_utilization AS
  SELECT
    b.bin_id, b.facility_id, b.bin_code, b.capacity_ton, b.status,
    COALESCE(inbound.qty, 0) - COALESCE(outbound.qty, 0) AS current_quantity_ton,
    CASE WHEN b.capacity_ton IS NULL OR b.capacity_ton = 0 THEN NULL
         ELSE ROUND((COALESCE(inbound.qty, 0) - COALESCE(outbound.qty, 0)) / b.capacity_ton * 100, 1)
    END AS utilization_pct
  FROM warehouse.bin b
  LEFT JOIN (
    SELECT to_bin_id AS bin_id, SUM(quantity_ton) AS qty
    FROM warehouse.movement WHERE movement_type IN ('receive', 'transfer') GROUP BY to_bin_id
  ) inbound ON inbound.bin_id = b.bin_id
  LEFT JOIN (
    SELECT from_bin_id AS bin_id, SUM(quantity_ton) AS qty
    FROM warehouse.movement WHERE movement_type IN ('transfer', 'release') GROUP BY from_bin_id
  ) outbound ON outbound.bin_id = b.bin_id;

CREATE VIEW warehouse.v_lot_current_location AS
  WITH latest AS (
    SELECT DISTINCT ON (lot_id) lot_id, movement_type, to_bin_id, recorded_at
    FROM warehouse.movement
    ORDER BY lot_id, recorded_at DESC
  ),
  first_receive AS (
    SELECT lot_id, MIN(recorded_at) AS first_received_at
    FROM warehouse.movement WHERE movement_type = 'receive' GROUP BY lot_id
  )
  SELECT
    l.lot_id,
    CASE WHEN latest.movement_type = 'release' THEN NULL ELSE latest.to_bin_id END AS current_bin_id,
    CASE WHEN latest.lot_id IS NULL THEN 'not_in_warehouse'
         WHEN latest.movement_type = 'release' THEN 'released'
         ELSE 'in_storage' END AS warehouse_status,
    fr.first_received_at,
    CASE WHEN fr.first_received_at IS NULL THEN NULL
         ELSE EXTRACT(DAY FROM now() - fr.first_received_at)::int END AS age_days
  FROM produce.lot l
  LEFT JOIN latest ON latest.lot_id = l.lot_id
  LEFT JOIN first_receive fr ON fr.lot_id = l.lot_id;

GRANT SELECT ON warehouse.v_bin_utilization TO agrolink_app;
GRANT SELECT ON warehouse.v_lot_current_location TO agrolink_app;

-- ---------------------------------------------------------------------------
-- 6. Movement functions. Same "route does the ownership check, function
--    does the business rule" split as produce.assign_delivery_to_lot() /
--    produce.close_lot() — the route MUST verify the facility/bin (and the
--    lot) belong to the calling cooperative before calling any of these;
--    these functions trust their caller on ownership.
-- ---------------------------------------------------------------------------
CREATE FUNCTION warehouse.receive_lot(
  p_lot_id uuid, p_bin_id uuid, p_quantity_ton numeric, p_recorded_by text, p_moisture_pct numeric DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_bin_status TEXT;
    v_movement_id uuid;
BEGIN
    SELECT status INTO v_bin_status FROM warehouse.bin WHERE bin_id = p_bin_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบตำแหน่งจัดเก็บ %', p_bin_id;
    END IF;
    IF v_bin_status <> 'active' THEN
        RAISE EXCEPTION 'ตำแหน่งจัดเก็บ % ไม่ได้เปิดใช้งาน', p_bin_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM produce.lot WHERE lot_id = p_lot_id) THEN
        RAISE EXCEPTION 'ไม่พบล็อต %', p_lot_id;
    END IF;

    INSERT INTO warehouse.movement (lot_id, from_bin_id, to_bin_id, movement_type, quantity_ton, moisture_pct, recorded_by)
    VALUES (p_lot_id, NULL, p_bin_id, 'receive', p_quantity_ton, p_moisture_pct, p_recorded_by)
    RETURNING movement_id INTO v_movement_id;

    IF p_moisture_pct IS NOT NULL THEN
        INSERT INTO warehouse.drying_reading (lot_id, bin_id, moisture_pct, recorded_by)
        VALUES (p_lot_id, p_bin_id, p_moisture_pct, p_recorded_by);
    END IF;

    RETURN v_movement_id;
END;
$$;

CREATE FUNCTION warehouse.transfer_lot(
  p_lot_id uuid, p_from_bin_id uuid, p_to_bin_id uuid, p_quantity_ton numeric, p_recorded_by text
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_from_facility uuid;
    v_to_facility uuid;
    v_movement_id uuid;
BEGIN
    SELECT facility_id INTO v_from_facility FROM warehouse.bin WHERE bin_id = p_from_bin_id AND status = 'active';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบตำแหน่งต้นทาง % หรือไม่ได้เปิดใช้งาน', p_from_bin_id;
    END IF;
    SELECT facility_id INTO v_to_facility FROM warehouse.bin WHERE bin_id = p_to_bin_id AND status = 'active';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบตำแหน่งปลายทาง % หรือไม่ได้เปิดใช้งาน', p_to_bin_id;
    END IF;
    IF v_from_facility <> v_to_facility THEN
        RAISE EXCEPTION 'การย้ายข้ามคลัง (facility) ยังไม่รองรับในขั้นนี้ — ตำแหน่งต้นทางและปลายทางต้องอยู่ในคลังเดียวกัน';
    END IF;

    INSERT INTO warehouse.movement (lot_id, from_bin_id, to_bin_id, movement_type, quantity_ton, recorded_by)
    VALUES (p_lot_id, p_from_bin_id, p_to_bin_id, 'transfer', p_quantity_ton, p_recorded_by)
    RETURNING movement_id INTO v_movement_id;

    RETURN v_movement_id;
END;
$$;

CREATE FUNCTION warehouse.release_lot(
  p_lot_id uuid, p_from_bin_id uuid, p_quantity_ton numeric, p_recorded_by text, p_note text DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_movement_id uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM warehouse.bin WHERE bin_id = p_from_bin_id) THEN
        RAISE EXCEPTION 'ไม่พบตำแหน่งจัดเก็บ %', p_from_bin_id;
    END IF;

    INSERT INTO warehouse.movement (lot_id, from_bin_id, to_bin_id, movement_type, quantity_ton, recorded_by, note)
    VALUES (p_lot_id, p_from_bin_id, NULL, 'release', p_quantity_ton, p_recorded_by, p_note)
    RETURNING movement_id INTO v_movement_id;

    RETURN v_movement_id;
END;
$$;

CREATE FUNCTION warehouse.record_drying_reading(
  p_lot_id uuid, p_bin_id uuid, p_moisture_pct numeric, p_recorded_by text
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_reading_id uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM warehouse.bin WHERE bin_id = p_bin_id) THEN
        RAISE EXCEPTION 'ไม่พบตำแหน่งจัดเก็บ %', p_bin_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM produce.lot WHERE lot_id = p_lot_id) THEN
        RAISE EXCEPTION 'ไม่พบล็อต %', p_lot_id;
    END IF;

    INSERT INTO warehouse.drying_reading (lot_id, bin_id, moisture_pct, recorded_by)
    VALUES (p_lot_id, p_bin_id, p_moisture_pct, p_recorded_by)
    RETURNING reading_id INTO v_reading_id;

    RETURN v_reading_id;
END;
$$;

-- ============================================================================
-- Follow-up work this migration deliberately leaves open:
--   - No cross-facility transfer (see warehouse.transfer_lot()'s own
--     exception message) — a real multi-site cooperative would need this
--     eventually; out of scope for the first pilot slice.
--   - No partial-quantity tracking safeguard: nothing stops recording a
--     transfer/release quantity_ton larger than what a bin's utilization
--     view shows as currently present — same "trust the operator's manual
--     entry" posture as the rest of this platform (see the top-of-file
--     note on no weighbridge/IoT integration).
--   - No link yet from a released lot to what it became (a settlement, a
--     processing batch) — that connective tissue is M11's job.
-- ============================================================================
