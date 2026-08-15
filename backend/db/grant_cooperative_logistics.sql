-- AgroLink -- Cooperative SaaS, M13 Logistics.
--
-- Context: AgroLink_Cooperative_SaaS_Master_Blueprint_v1.0's Gap Analysis
-- lists M13 as "ผู้ขนส่ง, ยานพาหนะ, การจัดส่ง, เส้นทาง, POD, ข้อยกเว้น" (carrier,
-- vehicle, shipment, route, proof-of-delivery, exceptions) with current
-- status "ไม่มี — ช่องว่างจริง ไม่พบ schema/route ที่เกี่ยวข้องเลย" (a genuine
-- gap, confirmed again here — grepping the whole schema for carrier/
-- shipment/logistics/POD turns up nothing). The 12-sprint plan (S9) groups
-- it with M12 Buyer Marketplace as "M13 สร้างใหม่ทั้งหมด" (M13 built entirely
-- from scratch).
--
-- Scope: a cooperative moving goods it already has — either a raw
-- produce.lot (collected in M09, possibly warehoused in M10) or a
-- processing.finished_good (produced in M11) — out to a destination (a
-- buyer, a central depot, wherever). This is deliberately the SIMPLEST
-- possible logistics slice: one shipment per truck run, one or more cargo
-- items, one proof-of-delivery, an append-only exception log. No route
-- optimization, no GPS tracking, no rate cards — those are real logistics
-- features but nothing in this platform's current scope asks for them yet.
--
-- Cross-module wiring (the actual point of this migration, same as M10->M11
-- before it):
--   - A shipment item can carry EITHER a produce.lot (raw) OR a
--     processing.finished_good (processed) — never both — via item_type +
--     two nullable FK columns, same "polymorphic reference, CHECK enforces
--     exactly one set" shape used nowhere else in this platform yet, but a
--     natural fit here since "cargo" really can be either kind of thing.
--   - Adding a FinishedGood item to a shipment calls
--     processing.record_dispatch() (grant_cooperative_processing.sql)
--     immediately — this IS the "buyer/order hookup" that migration's own
--     Follow-up section flagged as missing ("Wiring it to a real buyer/
--     contract ... is M12/M13 territory"). One inventory-drawdown ledger
--     (processing.finished_good_dispatch), not a second parallel one here.
--   - A shipment item carrying a raw Lot does NOT auto-call
--     warehouse.release_lot() — a lot might never have entered warehouse
--     tracking in the first place (e.g. shipped raw straight from the
--     collection station), and when it DID go through the warehouse, the
--     bin_id context release_lot() needs isn't something a shipment record
--     has. The cooperative calls that separately if relevant, same as every
--     other cross-module action in this platform being explicit rather
--     than auto-triggered.
--   - processing.v_lot_processing_availability (M11) is widened below
--     (CREATE OR REPLACE) to also subtract quantity already committed to a
--     non-cancelled shipment — without this, the same ten tons of a lot
--     could be committed to BOTH a processing batch AND a raw shipment,
--     double-booking produce that only exists once. This is the
--     "connective tissue" M11's own Follow-up section left for later.
--
-- Cancellation is intentionally narrow: cancel_shipment() only works on a
-- shipment with ZERO items. Once a Lot item is added it's just a
-- (reversible, view-computed) commitment — but once a FinishedGood item is
-- added it has ALREADY called processing.record_dispatch(), which is an
-- append-only ledger with no UPDATE/DELETE grant for the app role (same
-- "movement ledgers are effectively immutable once written" posture as
-- warehouse.movement and processing.finished_good_dispatch itself) — there
-- is no clean way to undo that. Rather than build a correcting-entry
-- mechanism this slice doesn't need yet, a shipment that already has cargo
-- must be carried through to delivery (or left as a stuck Pending record a
-- human sorts out manually) instead of cancelled.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS logistics;
GRANT USAGE ON SCHEMA logistics TO agrolink_app;

-- ---------------------------------------------------------------------------
-- 1. logistics.carrier — a transport provider this cooperative uses: its
--    own fleet (Internal) or a third-party trucking company (ThirdParty).
--    No RLS — same `WHERE org_id = $1` convention as every other
--    cooperative table in this platform; the route layer is the security
--    boundary.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logistics.carrier (
  carrier_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  org_id          uuid NOT NULL REFERENCES identity.organization(org_id),
  carrier_name    text NOT NULL,
  carrier_type    text NOT NULL,
  contact_phone   text,
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carrier_type_check CHECK (carrier_type IN ('Internal', 'ThirdParty')),
  CONSTRAINT carrier_status_check CHECK (status IN ('active', 'inactive'))
);

CREATE INDEX IF NOT EXISTS idx_carrier_org ON logistics.carrier (org_id);

-- ---------------------------------------------------------------------------
-- 2. logistics.vehicle — one truck/pickup belonging to a carrier.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logistics.vehicle (
  vehicle_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  carrier_id      uuid NOT NULL REFERENCES logistics.carrier(carrier_id),
  vehicle_type    text NOT NULL,
  license_plate   text NOT NULL,
  capacity_ton    numeric(14,3),
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_type_check CHECK (vehicle_type IN ('Truck', 'Pickup', 'Trailer', 'Other')),
  CONSTRAINT vehicle_status_check CHECK (status IN ('active', 'inactive')),
  CONSTRAINT vehicle_capacity_check CHECK (capacity_ton IS NULL OR capacity_ton > 0)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_carrier ON logistics.vehicle (carrier_id);

-- ---------------------------------------------------------------------------
-- 3. logistics.shipment — one truck run. status lifecycle: Pending ->
--    InTransit -> Delivered, or Pending -> Cancelled (only while empty —
--    see the design note above). destination_org_id is an OPTIONAL pointer
--    at a known identity.organization (e.g. a Buyer this cooperative has a
--    real relationship with) — no org_type restriction, same convention as
--    produce.delivery.buyer_org_id; destination_name is always required as
--    free text since plenty of real destinations (a rice mill that isn't
--    itself a platform user, a member's own truck, a market) are not, and
--    may never be, a registered organization here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logistics.shipment (
  shipment_id         uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  org_id              uuid NOT NULL REFERENCES identity.organization(org_id),
  carrier_id          uuid NOT NULL REFERENCES logistics.carrier(carrier_id),
  vehicle_id          uuid REFERENCES logistics.vehicle(vehicle_id),
  destination_name    text NOT NULL,
  destination_org_id  uuid REFERENCES identity.organization(org_id),
  driver_name         text,
  status              text NOT NULL DEFAULT 'Pending',
  scheduled_at        timestamptz,
  dispatched_at       timestamptz,
  delivered_at        timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        text,
  cancel_reason       text,
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_status_check CHECK (status IN ('Pending', 'InTransit', 'Delivered', 'Cancelled')),
  CONSTRAINT shipment_cancelled_shape CHECK (status <> 'Cancelled' OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_shipment_org ON logistics.shipment (org_id);
CREATE INDEX IF NOT EXISTS idx_shipment_carrier ON logistics.shipment (carrier_id);

-- ---------------------------------------------------------------------------
-- 4. logistics.shipment_item — one piece of cargo on a shipment. Exactly
--    one of lot_id / finished_good_id is set, matching item_type.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logistics.shipment_item (
  shipment_item_id  uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  shipment_id       uuid NOT NULL REFERENCES logistics.shipment(shipment_id),
  item_type         text NOT NULL,
  lot_id            uuid REFERENCES produce.lot(lot_id),
  finished_good_id  uuid REFERENCES processing.finished_good(finished_good_id),
  quantity_ton      numeric(14,3) NOT NULL,
  recorded_by       text NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_item_type_check CHECK (item_type IN ('Lot', 'FinishedGood')),
  CONSTRAINT shipment_item_quantity_check CHECK (quantity_ton > 0),
  CONSTRAINT shipment_item_lot_shape CHECK (item_type <> 'Lot' OR (lot_id IS NOT NULL AND finished_good_id IS NULL)),
  CONSTRAINT shipment_item_fg_shape CHECK (item_type <> 'FinishedGood' OR (finished_good_id IS NOT NULL AND lot_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_shipment_item_shipment ON logistics.shipment_item (shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_item_lot ON logistics.shipment_item (lot_id);
CREATE INDEX IF NOT EXISTS idx_shipment_item_fg ON logistics.shipment_item (finished_good_id);

-- ---------------------------------------------------------------------------
-- 5. logistics.proof_of_delivery — one POD per shipment (recorded once, on
--    delivery). received_quantity_ton is captured SEPARATELY from what was
--    shipped (sum of shipment_item.quantity_ton) — a mismatch between the
--    two is exactly the kind of thing logistics.shipment_exception exists
--    to record, not something this table blocks or auto-detects. No
--    signature/photo FILE — see the Follow-up note below (this platform
--    has no object storage yet at all, same gap flagged for KYC documents
--    in the Master Blueprint's own Gap Analysis); signature_name is a text
--    field only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logistics.proof_of_delivery (
  pod_id                  uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  shipment_id             uuid NOT NULL UNIQUE REFERENCES logistics.shipment(shipment_id),
  received_by             text NOT NULL,
  received_quantity_ton   numeric(14,3) NOT NULL,
  signature_name          text,
  note                    text,
  recorded_by             text NOT NULL,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pod_received_quantity_check CHECK (received_quantity_ton >= 0)
);

-- ---------------------------------------------------------------------------
-- 6. logistics.shipment_exception — an append-only log of things that went
--    wrong on a shipment (damage, shortage, delay, rejection). Does NOT
--    change logistics.shipment.status — a shipment can be Delivered AND
--    have an exception on file (e.g. delivered short), same "status tracks
--    the workflow stage, exceptions are a separate annotation log" shape as
--    produce.delivery's status vs. a rejection reason.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logistics.shipment_exception (
  exception_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  shipment_id       uuid NOT NULL REFERENCES logistics.shipment(shipment_id),
  exception_type    text NOT NULL,
  description       text NOT NULL,
  reported_by       text NOT NULL,
  reported_at       timestamptz NOT NULL DEFAULT now(),
  resolved          boolean NOT NULL DEFAULT false,
  resolved_at       timestamptz,
  resolution_note   text,
  CONSTRAINT shipment_exception_type_check CHECK (exception_type IN ('Damage', 'Shortage', 'Delay', 'Rejected', 'Other')),
  CONSTRAINT shipment_exception_resolved_shape CHECK (NOT resolved OR resolved_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_shipment_exception_shipment ON logistics.shipment_exception (shipment_id);

GRANT SELECT, INSERT, UPDATE ON logistics.carrier TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON logistics.vehicle TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON logistics.shipment TO agrolink_app;
GRANT SELECT, INSERT ON logistics.shipment_item TO agrolink_app;
GRANT SELECT, INSERT ON logistics.proof_of_delivery TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON logistics.shipment_exception TO agrolink_app;

-- ---------------------------------------------------------------------------
-- 7. Views — run with the OWNER's (postgres') privileges to read the
--    underlying tables (same pattern as every other view in this
--    platform) — only SELECT on the view itself is needed.
-- ---------------------------------------------------------------------------

CREATE VIEW logistics.v_shipment_summary AS
  SELECT
    s.shipment_id, s.org_id, s.carrier_id, c.carrier_name, s.vehicle_id, v.license_plate,
    s.destination_name, s.destination_org_id, s.driver_name, s.status,
    s.scheduled_at, s.dispatched_at, s.delivered_at, s.cancelled_at, s.cancelled_by, s.cancel_reason,
    s.created_by, s.created_at,
    COALESCE(items.item_count, 0) AS item_count,
    COALESCE(items.total_quantity_ton, 0) AS total_quantity_ton,
    pod.received_by AS pod_received_by, pod.received_quantity_ton AS pod_received_quantity_ton, pod.recorded_at AS pod_recorded_at,
    COALESCE(exc.exception_count, 0) AS exception_count
  FROM logistics.shipment s
  LEFT JOIN logistics.carrier c ON c.carrier_id = s.carrier_id
  LEFT JOIN logistics.vehicle v ON v.vehicle_id = s.vehicle_id
  LEFT JOIN logistics.proof_of_delivery pod ON pod.shipment_id = s.shipment_id
  LEFT JOIN (
    SELECT shipment_id, COUNT(*)::int AS item_count, SUM(quantity_ton) AS total_quantity_ton
    FROM logistics.shipment_item GROUP BY shipment_id
  ) items ON items.shipment_id = s.shipment_id
  LEFT JOIN (
    SELECT shipment_id, COUNT(*)::int AS exception_count
    FROM logistics.shipment_exception GROUP BY shipment_id
  ) exc ON exc.shipment_id = s.shipment_id;

-- How much of a raw lot is still free to put on a (new or existing)
-- shipment — total delivered, minus what's committed to a non-cancelled
-- processing batch, minus what's committed to a non-cancelled shipment.
-- This is the authoritative "what's left of this lot" view; see the
-- CREATE OR REPLACE of processing.v_lot_processing_availability below,
-- which now also subtracts the shipment side so the two views can never
-- disagree about how much of a lot has already been spoken for.
CREATE VIEW logistics.v_lot_shipping_availability AS
  SELECT
    l.lot_id, l.buyer_org_id AS org_id, l.commodity_code, l.status AS lot_status,
    COALESCE(d.total_quantity_ton, 0) AS total_quantity_ton,
    COALESCE(bi.committed_quantity_ton, 0) AS processing_committed_quantity_ton,
    COALESCE(si.committed_quantity_ton, 0) AS shipment_committed_quantity_ton,
    COALESCE(d.total_quantity_ton, 0) - COALESCE(bi.committed_quantity_ton, 0) - COALESCE(si.committed_quantity_ton, 0) AS available_quantity_ton
  FROM produce.lot l
  LEFT JOIN (
    SELECT lot_id, SUM(quantity_ton) AS total_quantity_ton
    FROM produce.delivery WHERE lot_id IS NOT NULL GROUP BY lot_id
  ) d ON d.lot_id = l.lot_id
  LEFT JOIN (
    SELECT bi.lot_id, SUM(bi.quantity_ton) AS committed_quantity_ton
    FROM processing.batch_input bi
    JOIN processing.batch b ON b.batch_id = bi.batch_id
    WHERE b.status <> 'Cancelled'
    GROUP BY bi.lot_id
  ) bi ON bi.lot_id = l.lot_id
  LEFT JOIN (
    SELECT si.lot_id, SUM(si.quantity_ton) AS committed_quantity_ton
    FROM logistics.shipment_item si
    JOIN logistics.shipment s ON s.shipment_id = si.shipment_id
    WHERE si.item_type = 'Lot' AND s.status <> 'Cancelled'
    GROUP BY si.lot_id
  ) si ON si.lot_id = l.lot_id;

GRANT SELECT ON logistics.v_shipment_summary TO agrolink_app;
GRANT SELECT ON logistics.v_lot_shipping_availability TO agrolink_app;

-- Widen M11's own "how much of this lot is left" view to also account for
-- raw-lot shipments, now that logistics.shipment_item exists as a second
-- consumer of a lot's finite quantity — without this, the same produce
-- could be committed to a processing batch AND a shipment at once. Same
-- shape as before (CREATE OR REPLACE, not a new view), just with one more
-- LEFT JOIN subtracted.
CREATE OR REPLACE VIEW processing.v_lot_processing_availability AS
  SELECT
    l.lot_id, l.buyer_org_id AS org_id, l.commodity_code, l.status AS lot_status,
    COALESCE(d.total_quantity_ton, 0) AS total_quantity_ton,
    COALESCE(bi.committed_quantity_ton, 0) AS committed_quantity_ton,
    COALESCE(d.total_quantity_ton, 0) - COALESCE(bi.committed_quantity_ton, 0) - COALESCE(si.committed_quantity_ton, 0) AS available_quantity_ton
  FROM produce.lot l
  LEFT JOIN (
    SELECT lot_id, SUM(quantity_ton) AS total_quantity_ton
    FROM produce.delivery WHERE lot_id IS NOT NULL GROUP BY lot_id
  ) d ON d.lot_id = l.lot_id
  LEFT JOIN (
    SELECT bi.lot_id, SUM(bi.quantity_ton) AS committed_quantity_ton
    FROM processing.batch_input bi
    JOIN processing.batch b ON b.batch_id = bi.batch_id
    WHERE b.status <> 'Cancelled'
    GROUP BY bi.lot_id
  ) bi ON bi.lot_id = l.lot_id
  LEFT JOIN (
    SELECT si.lot_id, SUM(si.quantity_ton) AS committed_quantity_ton
    FROM logistics.shipment_item si
    JOIN logistics.shipment s ON s.shipment_id = si.shipment_id
    WHERE si.item_type = 'Lot' AND s.status <> 'Cancelled'
    GROUP BY si.lot_id
  ) si ON si.lot_id = l.lot_id;

-- ---------------------------------------------------------------------------
-- 8. Functions. Same "route does the ownership check, function does the
--    business rule" split as every other module's functions — the route
--    MUST verify the carrier/vehicle/shipment/lot/finished_good belongs to
--    the calling cooperative before calling any of these; these functions
--    trust their caller on ownership.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics.create_carrier(
  p_org_id uuid, p_carrier_name text, p_carrier_type text, p_contact_phone text DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_carrier_id uuid;
BEGIN
    INSERT INTO logistics.carrier (org_id, carrier_name, carrier_type, contact_phone)
    VALUES (p_org_id, p_carrier_name, p_carrier_type, p_contact_phone)
    RETURNING carrier_id INTO v_carrier_id;

    RETURN v_carrier_id;
END;
$$;

CREATE FUNCTION logistics.create_vehicle(
  p_carrier_id uuid, p_vehicle_type text, p_license_plate text, p_capacity_ton numeric DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_vehicle_id uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM logistics.carrier WHERE carrier_id = p_carrier_id) THEN
        RAISE EXCEPTION 'ไม่พบผู้ขนส่ง %', p_carrier_id;
    END IF;

    INSERT INTO logistics.vehicle (carrier_id, vehicle_type, license_plate, capacity_ton)
    VALUES (p_carrier_id, p_vehicle_type, p_license_plate, p_capacity_ton)
    RETURNING vehicle_id INTO v_vehicle_id;

    RETURN v_vehicle_id;
END;
$$;

CREATE FUNCTION logistics.create_shipment(
  p_org_id uuid, p_carrier_id uuid, p_vehicle_id uuid, p_destination_name text, p_destination_org_id uuid,
  p_driver_name text, p_scheduled_at timestamptz, p_created_by text
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_shipment_id uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM logistics.carrier WHERE carrier_id = p_carrier_id) THEN
        RAISE EXCEPTION 'ไม่พบผู้ขนส่ง %', p_carrier_id;
    END IF;
    IF p_vehicle_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM logistics.vehicle WHERE vehicle_id = p_vehicle_id AND carrier_id = p_carrier_id) THEN
        RAISE EXCEPTION 'ไม่พบยานพาหนะ % ของผู้ขนส่งนี้', p_vehicle_id;
    END IF;

    INSERT INTO logistics.shipment (org_id, carrier_id, vehicle_id, destination_name, destination_org_id, driver_name, scheduled_at, created_by)
    VALUES (p_org_id, p_carrier_id, p_vehicle_id, p_destination_name, p_destination_org_id, p_driver_name, p_scheduled_at, p_created_by)
    RETURNING shipment_id INTO v_shipment_id;

    RETURN v_shipment_id;
END;
$$;

CREATE FUNCTION logistics.add_shipment_item(
  p_shipment_id uuid, p_item_type text, p_lot_id uuid, p_finished_good_id uuid, p_quantity_ton numeric, p_recorded_by text
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_shipment_status TEXT;
    v_available NUMERIC(14,3);
    v_shipment_item_id uuid;
BEGIN
    SELECT status INTO v_shipment_status FROM logistics.shipment WHERE shipment_id = p_shipment_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบการจัดส่ง %', p_shipment_id;
    END IF;
    IF v_shipment_status <> 'Pending' THEN
        RAISE EXCEPTION 'เพิ่มสินค้าได้เฉพาะการจัดส่งที่ยังไม่ออกเดินทางเท่านั้น (สถานะปัจจุบัน %)', v_shipment_status;
    END IF;

    IF p_item_type = 'Lot' THEN
        SELECT available_quantity_ton INTO v_available
          FROM logistics.v_lot_shipping_availability WHERE lot_id = p_lot_id;
        IF v_available IS NULL OR p_quantity_ton > v_available THEN
            RAISE EXCEPTION 'ปริมาณที่ต้องการจัดส่ง (%) เกินปริมาณคงเหลือของล็อตที่ยังไม่ถูกจอง (%)', p_quantity_ton, COALESCE(v_available, 0);
        END IF;

        INSERT INTO logistics.shipment_item (shipment_id, item_type, lot_id, quantity_ton, recorded_by)
        VALUES (p_shipment_id, 'Lot', p_lot_id, p_quantity_ton, p_recorded_by)
        RETURNING shipment_item_id INTO v_shipment_item_id;

    ELSIF p_item_type = 'FinishedGood' THEN
        -- Draws down real inventory immediately via the SAME dispatch
        -- ledger M11 uses for any other outbound movement — see this
        -- migration's top-of-file note on why there is no separate
        -- shipment-side stock number to keep in sync.
        PERFORM processing.record_dispatch(p_finished_good_id, p_quantity_ton, p_recorded_by,
          'จัดส่ง ' || p_shipment_id::text);

        INSERT INTO logistics.shipment_item (shipment_id, item_type, finished_good_id, quantity_ton, recorded_by)
        VALUES (p_shipment_id, 'FinishedGood', p_finished_good_id, p_quantity_ton, p_recorded_by)
        RETURNING shipment_item_id INTO v_shipment_item_id;

    ELSE
        RAISE EXCEPTION 'item_type ไม่ถูกต้อง: %', p_item_type;
    END IF;

    RETURN v_shipment_item_id;
END;
$$;

CREATE FUNCTION logistics.dispatch_shipment(
  p_shipment_id uuid, p_dispatched_by text
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_status TEXT;
BEGIN
    SELECT status INTO v_status FROM logistics.shipment WHERE shipment_id = p_shipment_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบการจัดส่ง %', p_shipment_id;
    END IF;
    IF v_status <> 'Pending' THEN
        RAISE EXCEPTION 'การจัดส่ง % ไม่ได้อยู่ในสถานะรอดำเนินการแล้ว (สถานะปัจจุบัน %)', p_shipment_id, v_status;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM logistics.shipment_item WHERE shipment_id = p_shipment_id) THEN
        RAISE EXCEPTION 'การจัดส่ง % ยังไม่มีสินค้า — กรุณาเพิ่มสินค้าก่อนออกเดินทาง', p_shipment_id;
    END IF;

    UPDATE logistics.shipment
    SET status = 'InTransit', dispatched_at = now()
    WHERE shipment_id = p_shipment_id;
    -- p_dispatched_by is intentionally not persisted on a dedicated column
    -- — created_by already identifies who planned the shipment, and
    -- logistics.proof_of_delivery.recorded_by identifies who closed it out;
    -- who physically pressed "ออกเดินทาง" in between is not tracked as a
    -- separate fact this MVP slice needs.
END;
$$;

CREATE FUNCTION logistics.record_pod(
  p_shipment_id uuid, p_received_by text, p_received_quantity_ton numeric, p_recorded_by text,
  p_signature_name text DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_status TEXT;
    v_pod_id uuid;
BEGIN
    SELECT status INTO v_status FROM logistics.shipment WHERE shipment_id = p_shipment_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบการจัดส่ง %', p_shipment_id;
    END IF;
    IF v_status <> 'InTransit' THEN
        RAISE EXCEPTION 'บันทึกหลักฐานการส่งมอบได้เฉพาะการจัดส่งที่กำลังเดินทางเท่านั้น (สถานะปัจจุบัน %)', v_status;
    END IF;

    INSERT INTO logistics.proof_of_delivery (shipment_id, received_by, received_quantity_ton, signature_name, note, recorded_by)
    VALUES (p_shipment_id, p_received_by, p_received_quantity_ton, p_signature_name, p_note, p_recorded_by)
    RETURNING pod_id INTO v_pod_id;

    UPDATE logistics.shipment
    SET status = 'Delivered', delivered_at = now()
    WHERE shipment_id = p_shipment_id;

    RETURN v_pod_id;
END;
$$;

CREATE FUNCTION logistics.report_exception(
  p_shipment_id uuid, p_exception_type text, p_description text, p_reported_by text
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_status TEXT;
    v_exception_id uuid;
BEGIN
    SELECT status INTO v_status FROM logistics.shipment WHERE shipment_id = p_shipment_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบการจัดส่ง %', p_shipment_id;
    END IF;
    IF v_status NOT IN ('InTransit', 'Delivered') THEN
        RAISE EXCEPTION 'รายงานข้อยกเว้นได้เฉพาะการจัดส่งที่ออกเดินทางแล้วเท่านั้น (สถานะปัจจุบัน %)', v_status;
    END IF;

    INSERT INTO logistics.shipment_exception (shipment_id, exception_type, description, reported_by)
    VALUES (p_shipment_id, p_exception_type, p_description, p_reported_by)
    RETURNING exception_id INTO v_exception_id;

    RETURN v_exception_id;
END;
$$;

CREATE FUNCTION logistics.resolve_exception(
  p_exception_id uuid, p_resolution_note text
) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM logistics.shipment_exception WHERE exception_id = p_exception_id) THEN
        RAISE EXCEPTION 'ไม่พบข้อยกเว้น %', p_exception_id;
    END IF;

    UPDATE logistics.shipment_exception
    SET resolved = true, resolved_at = now(), resolution_note = p_resolution_note
    WHERE exception_id = p_exception_id;
END;
$$;

CREATE FUNCTION logistics.cancel_shipment(
  p_shipment_id uuid, p_cancelled_by text, p_reason text
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_status TEXT;
BEGIN
    SELECT status INTO v_status FROM logistics.shipment WHERE shipment_id = p_shipment_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบการจัดส่ง %', p_shipment_id;
    END IF;
    IF v_status <> 'Pending' THEN
        RAISE EXCEPTION 'ยกเลิกได้เฉพาะการจัดส่งที่ยังรอดำเนินการเท่านั้น (สถานะปัจจุบัน %)', v_status;
    END IF;
    IF EXISTS (SELECT 1 FROM logistics.shipment_item WHERE shipment_id = p_shipment_id) THEN
        RAISE EXCEPTION 'ยกเลิกไม่ได้ — การจัดส่ง % มีสินค้าที่เพิ่มไว้แล้ว (ดูหมายเหตุขอบเขตท้ายไฟล์ migration นี้)', p_shipment_id;
    END IF;

    UPDATE logistics.shipment
    SET status = 'Cancelled', cancelled_by = p_cancelled_by, cancelled_at = now(), cancel_reason = p_reason
    WHERE shipment_id = p_shipment_id;
END;
$$;

-- ============================================================================
-- Follow-up work this migration deliberately leaves open:
--   - No route optimization, GPS tracking, or rate cards — this is a
--     record-keeping slice (what shipped, on what truck, to where, who
--     signed for it), not a dispatch-optimization tool.
--   - No file/photo attachment on proof_of_delivery — this platform has no
--     object storage anywhere yet (the Master Blueprint's own Gap Analysis
--     flags this for KYC documents too); signature_name is text-only until
--     that exists.
--   - cancel_shipment() only works on an empty shipment — see the
--     cancellation design note at the top of this file for why (a
--     FinishedGood item's processing.record_dispatch() call is not
--     reversible without an UPDATE/DELETE grant this platform deliberately
--     doesn't hand the app role).
--   - No automatic warehouse.release_lot() call when a raw Lot item is
--     added — see the cross-module wiring note at the top of this file.
--   - No link from a shipment to a produce/contract order on the buyer
--     side (M12) — destination_org_id is just a pointer at an
--     organization, not a real order/contract reference. Wiring an actual
--     buyer PO to a shipment is real future work once a cooperative-side
--     buyer order flow exists to link against.
-- ============================================================================
