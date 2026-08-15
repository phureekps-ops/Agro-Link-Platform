-- AgroLink -- Cooperative SaaS, M11 Processing.
--
-- Context: AgroLink_Cooperative_SaaS_Master_Blueprint_v1.0's Gap Analysis
-- says M11 "มีเฉพาะ traceability.certificate ยังไม่มี processing_batch/
-- processing_order ใดๆ" (only traceability.certificate exists — no
-- processing_batch/processing_order concept at all) and its 12-sprint plan
-- (S8) describes the scope as "สร้างใหม่: processing_order, batch
-- traceability, yield, finished goods — ต่อยอดจาก traceability.certificate".
-- This migration is that: a cooperative turns raw produce.lot(s) it has
-- collected (M09) — typically after they've passed through the warehouse
-- (M10, see grant_cooperative_warehouse.sql's own "Follow-up work" note:
-- "No link yet from a released lot to what it became ... that connective
-- tissue is M11's job") — into one or more processing.batch runs (milling,
-- drying, sorting, packaging), each yielding one or more finished-goods line
-- items with a live yield_pct, and keeps the full input->output chain
-- traceable back to the contributing farmers.
--
-- Why NOT built directly on traceability.certificate: that table is
-- deliberately one delivery_id per row (NOT NULL, singular) — a certificate
-- for a single raw delivery (origin / EUDR / organic-GAP). A processing
-- batch routinely combines MULTIPLE lots (each lot itself an aggregation of
-- multiple deliveries from M09) into one run, and a single output product
-- can draw from more than one commodity harvest date — that many-to-one
-- shape does not fit traceability.certificate's schema without changing it
-- for every other module that already relies on its current shape. Instead,
-- processing.batch_input is the many-to-many join (batch <-> lot) that
-- carries this traceability; routes join batch_input -> produce.lot ->
-- produce.delivery -> registry.production_unit -> identity.farmer to answer
-- "which farmers' produce ended up in this batch," which is the practical
-- meaning of "batch traceability" for a cooperative manager. Wiring an
-- actual traceability.certificate row onto a *finished good* (so a bag of
-- milled rice gets its own QR-traceable certificate) is left as follow-up
-- work below — that needs a schema change to traceability.certificate
-- itself (a new certificate_type, and a nullable delivery_id / new
-- finished_good_id column) that is out of scope for this slice.
--
-- Why finished goods are free-text product names, not a commodity_code FK:
-- registry.commodity_ref is explicitly "ตารางอ้างอิงชั่วคราวสำหรับความ
-- สมบูรณ์ของ FK เท่านั้น — ระบบ Catalog เต็มรูปแบบพัฒนาในขั้นถัดไป" (a
-- temporary FK-integrity-only lookup table; a real Catalog system is future
-- work) and only lists 3 RAW commodities (RICE_JASMINE, RICE_PADDY,
-- CASSAVA) — no processed products like "ข้าวสารหอมมะลิ" or "แป้งมัน
-- สำปะหลัง" exist there at all. Forcing finished-good product names through
-- that FK would mean either fabricating catalog entries with no real
-- product-master behind them, or blocking cooperatives from recording any
-- processed product this platform's catalog doesn't already know about —
-- both worse than a free-text product_name (same posture as lot_note,
-- facility_name, and every other free-text field already in this
-- platform). The batch's source_commodity_code (the RAW input) still goes
-- through the commodity_ref FK, same as produce.delivery/produce.lot.
--
-- warehouse.facility gets a new facility_type value ('ProcessingPlant') so
-- a cooperative that runs its own mill can register it the same way it
-- registers a warehouse or drying yard — reusing M10's existing
-- facility/bin CRUD rather than duplicating a parallel "plant" concept.
-- processing.batch.facility_id is nullable and NOT restricted to that one
-- type (a cooperative might process produce right inside an existing
-- DryingYard-type facility without a dedicated plant record) — same
-- "trust the operator, don't over-constrain" posture as the rest of this
-- platform.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS processing;
GRANT USAGE ON SCHEMA processing TO agrolink_app;

ALTER TABLE warehouse.facility DROP CONSTRAINT facility_type_check;
ALTER TABLE warehouse.facility ADD CONSTRAINT facility_type_check
  CHECK (facility_type IN ('Warehouse', 'DryingYard', 'Silo', 'ProcessingPlant'));

-- ---------------------------------------------------------------------------
-- 1. processing.batch — one processing run (e.g. "สีข้าวเปลือกล็อตนี้เป็น
--    ข้าวสาร"). status lifecycle: InProgress -> Completed | Cancelled, both
--    terminal. No RLS — same `WHERE org_id = $1` convention as every other
--    cooperative table in this platform; the route layer is the security
--    boundary.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processing.batch (
  batch_id              uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  org_id                uuid NOT NULL REFERENCES identity.organization(org_id),
  facility_id           uuid REFERENCES warehouse.facility(facility_id),
  source_commodity_code text NOT NULL REFERENCES registry.commodity_ref(commodity_code),
  process_type          text NOT NULL,
  output_product_name   text NOT NULL,
  status                text NOT NULL DEFAULT 'InProgress',
  started_by            text NOT NULL,
  started_at            timestamptz NOT NULL DEFAULT now(),
  completed_by          text,
  completed_at          timestamptz,
  cancelled_by          text,
  cancelled_at          timestamptz,
  cancel_reason         text,
  batch_note            text,
  CONSTRAINT batch_process_type_check CHECK (process_type IN ('Milling', 'Drying', 'Sorting', 'Packaging', 'Other')),
  CONSTRAINT batch_status_check CHECK (status IN ('InProgress', 'Completed', 'Cancelled')),
  CONSTRAINT batch_completed_shape CHECK (status <> 'Completed' OR (completed_by IS NOT NULL AND completed_at IS NOT NULL)),
  CONSTRAINT batch_cancelled_shape CHECK (status <> 'Cancelled' OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_batch_org ON processing.batch (org_id);
CREATE INDEX IF NOT EXISTS idx_batch_facility ON processing.batch (facility_id);

-- ---------------------------------------------------------------------------
-- 2. processing.batch_input — which lot(s), and how much of each, went into
--    a batch. Many-to-many (a batch can draw from several lots; in
--    principle the same lot could also be split across more than one batch
--    over time, tracked via processing.v_lot_processing_availability below)
--    but only ONE row per (batch, lot) pair — call commit_lot_to_batch()
--    again with a different lot to add more input, not to top up the same
--    one twice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processing.batch_input (
  batch_input_id  uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  batch_id        uuid NOT NULL REFERENCES processing.batch(batch_id),
  lot_id          uuid NOT NULL REFERENCES produce.lot(lot_id),
  quantity_ton    numeric(14,3) NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT batch_input_quantity_check CHECK (quantity_ton > 0),
  CONSTRAINT uq_batch_input_lot UNIQUE (batch_id, lot_id)
);

CREATE INDEX IF NOT EXISTS idx_batch_input_batch ON processing.batch_input (batch_id);
CREATE INDEX IF NOT EXISTS idx_batch_input_lot ON processing.batch_input (lot_id);

-- ---------------------------------------------------------------------------
-- 3. processing.finished_good — one output line item from a batch. A single
--    batch can have more than one row (the main product plus by-products —
--    e.g. milling rice paddy yields ข้าวสาร as the primary product and รำข้าว
--    / ปลายข้าว as by-products, all worth tracking as real inventory).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processing.finished_good (
  finished_good_id    uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  batch_id            uuid NOT NULL REFERENCES processing.batch(batch_id),
  product_name        text NOT NULL,
  quantity_ton        numeric(14,3) NOT NULL,
  is_primary_product  boolean NOT NULL DEFAULT true,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finished_good_quantity_check CHECK (quantity_ton > 0)
);

CREATE INDEX IF NOT EXISTS idx_finished_good_batch ON processing.finished_good (batch_id);

-- ---------------------------------------------------------------------------
-- 4. processing.finished_good_dispatch — the drawdown ledger for finished
--    goods (sold / distributed / sent onward), same "append-only movement
--    ledger, current stock is derived not stored" shape as
--    warehouse.movement. No buyer/order concept wired in yet (see Follow-up
--    below) — this is intentionally just "quantity_ton left inventory,
--    recorded_by whom, when, and why" until a real M12 hookup exists.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processing.finished_good_dispatch (
  dispatch_id         uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  finished_good_id    uuid NOT NULL REFERENCES processing.finished_good(finished_good_id),
  quantity_ton        numeric(14,3) NOT NULL,
  recorded_by         text NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  note                text,
  CONSTRAINT finished_good_dispatch_quantity_check CHECK (quantity_ton > 0)
);

CREATE INDEX IF NOT EXISTS idx_fg_dispatch_fg ON processing.finished_good_dispatch (finished_good_id);

GRANT SELECT, INSERT, UPDATE ON processing.batch TO agrolink_app;
GRANT SELECT, INSERT ON processing.batch_input TO agrolink_app;
GRANT SELECT, INSERT ON processing.finished_good TO agrolink_app;
GRANT SELECT, INSERT ON processing.finished_good_dispatch TO agrolink_app;

-- ---------------------------------------------------------------------------
-- 5. Views — run with the OWNER's (postgres') privileges to read the
--    underlying tables (same pattern as warehouse.v_bin_utilization /
--    ledger.v_account_balance) — only SELECT on the view itself is needed.
-- ---------------------------------------------------------------------------

-- Live yield: output vs. input, computed on read (never cached/stored) —
-- same "no denormalized figure that can drift" posture as
-- warehouse.v_lot_current_location.
CREATE VIEW processing.v_batch_summary AS
  SELECT
    b.batch_id, b.org_id, b.facility_id, f.facility_name,
    b.source_commodity_code, cr.name_th AS source_commodity_name,
    b.process_type, b.output_product_name, b.status,
    b.started_by, b.started_at, b.completed_by, b.completed_at,
    b.cancelled_by, b.cancelled_at, b.cancel_reason, b.batch_note,
    COALESCE(bi.input_quantity_ton, 0) AS input_quantity_ton,
    COALESCE(fg.output_quantity_ton, 0) AS output_quantity_ton,
    CASE WHEN COALESCE(bi.input_quantity_ton, 0) = 0 THEN NULL
         ELSE ROUND(COALESCE(fg.output_quantity_ton, 0) / bi.input_quantity_ton * 100, 1)
    END AS yield_pct
  FROM processing.batch b
  LEFT JOIN warehouse.facility f ON f.facility_id = b.facility_id
  LEFT JOIN registry.commodity_ref cr ON cr.commodity_code = b.source_commodity_code
  LEFT JOIN (
    SELECT batch_id, SUM(quantity_ton) AS input_quantity_ton
    FROM processing.batch_input GROUP BY batch_id
  ) bi ON bi.batch_id = b.batch_id
  LEFT JOIN (
    SELECT batch_id, SUM(quantity_ton) AS output_quantity_ton
    FROM processing.finished_good GROUP BY batch_id
  ) fg ON fg.batch_id = b.batch_id;

-- How much of a given lot is still free to commit to a (new or existing)
-- batch. Cancelled batches' inputs are excluded from "committed" — a
-- cancelled batch never happened, so it should not permanently lock up part
-- of a lot (batch_input rows are kept, not deleted, for audit history; see
-- the Follow-up note below).
CREATE VIEW processing.v_lot_processing_availability AS
  SELECT
    l.lot_id, l.buyer_org_id AS org_id, l.commodity_code, l.status AS lot_status,
    COALESCE(d.total_quantity_ton, 0) AS total_quantity_ton,
    COALESCE(bi.committed_quantity_ton, 0) AS committed_quantity_ton,
    COALESCE(d.total_quantity_ton, 0) - COALESCE(bi.committed_quantity_ton, 0) AS available_quantity_ton
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
  ) bi ON bi.lot_id = l.lot_id;

-- Current on-hand stock per finished-good line item.
CREATE VIEW processing.v_finished_good_stock AS
  SELECT
    fg.finished_good_id, fg.batch_id, b.org_id, fg.product_name,
    fg.is_primary_product, fg.quantity_ton AS produced_quantity_ton,
    COALESCE(disp.dispatched_quantity_ton, 0) AS dispatched_quantity_ton,
    fg.quantity_ton - COALESCE(disp.dispatched_quantity_ton, 0) AS quantity_on_hand_ton,
    fg.recorded_at
  FROM processing.finished_good fg
  JOIN processing.batch b ON b.batch_id = fg.batch_id
  LEFT JOIN (
    SELECT finished_good_id, SUM(quantity_ton) AS dispatched_quantity_ton
    FROM processing.finished_good_dispatch GROUP BY finished_good_id
  ) disp ON disp.finished_good_id = fg.finished_good_id;

GRANT SELECT ON processing.v_batch_summary TO agrolink_app;
GRANT SELECT ON processing.v_lot_processing_availability TO agrolink_app;
GRANT SELECT ON processing.v_finished_good_stock TO agrolink_app;

-- ---------------------------------------------------------------------------
-- 6. Functions. Same "route does the ownership check, function does the
--    business rule" split as every produce.*/warehouse.* function — the
--    route MUST verify the batch (and any facility/lot/finished_good it
--    references) belongs to the calling cooperative before calling any of
--    these; these functions trust their caller on ownership.
-- ---------------------------------------------------------------------------
CREATE FUNCTION processing.create_batch(
  p_org_id uuid, p_facility_id uuid, p_source_commodity_code text, p_process_type text,
  p_output_product_name text, p_started_by text, p_batch_note text DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_batch_id uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM registry.commodity_ref WHERE commodity_code = p_source_commodity_code) THEN
        RAISE EXCEPTION 'ไม่พบชนิดผลผลิต %', p_source_commodity_code;
    END IF;
    IF p_facility_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM warehouse.facility WHERE facility_id = p_facility_id) THEN
        RAISE EXCEPTION 'ไม่พบคลัง/โรงงาน %', p_facility_id;
    END IF;

    INSERT INTO processing.batch (org_id, facility_id, source_commodity_code, process_type, output_product_name, started_by, batch_note)
    VALUES (p_org_id, p_facility_id, p_source_commodity_code, p_process_type, p_output_product_name, p_started_by, p_batch_note)
    RETURNING batch_id INTO v_batch_id;

    RETURN v_batch_id;
END;
$$;

CREATE FUNCTION processing.commit_lot_to_batch(
  p_batch_id uuid, p_lot_id uuid, p_quantity_ton numeric
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_batch_status TEXT;
    v_batch_commodity TEXT;
    v_lot_commodity TEXT;
    v_available NUMERIC(14,3);
    v_batch_input_id uuid;
BEGIN
    SELECT status, source_commodity_code INTO v_batch_status, v_batch_commodity
      FROM processing.batch WHERE batch_id = p_batch_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบชุดการแปรรูป %', p_batch_id;
    END IF;
    IF v_batch_status <> 'InProgress' THEN
        RAISE EXCEPTION 'ชุดการแปรรูป % ไม่ได้อยู่ระหว่างดำเนินการแล้ว (สถานะ %)', p_batch_id, v_batch_status;
    END IF;

    SELECT commodity_code INTO v_lot_commodity FROM produce.lot WHERE lot_id = p_lot_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบล็อต %', p_lot_id;
    END IF;
    IF v_lot_commodity <> v_batch_commodity THEN
        RAISE EXCEPTION 'ชนิดผลผลิตของล็อต (%) ไม่ตรงกับชนิดผลผลิตต้นทางของชุดการแปรรูปนี้ (%)', v_lot_commodity, v_batch_commodity;
    END IF;

    SELECT available_quantity_ton INTO v_available
      FROM processing.v_lot_processing_availability WHERE lot_id = p_lot_id;
    IF v_available IS NULL OR p_quantity_ton > v_available THEN
        RAISE EXCEPTION 'ปริมาณที่ต้องการนำเข้าแปรรูป (%) เกินปริมาณคงเหลือของล็อตที่ยังไม่ถูกจอง (%)', p_quantity_ton, COALESCE(v_available, 0);
    END IF;

    INSERT INTO processing.batch_input (batch_id, lot_id, quantity_ton)
    VALUES (p_batch_id, p_lot_id, p_quantity_ton)
    RETURNING batch_input_id INTO v_batch_input_id;

    RETURN v_batch_input_id;
END;
$$;

CREATE FUNCTION processing.add_finished_good(
  p_batch_id uuid, p_product_name text, p_quantity_ton numeric, p_is_primary_product boolean DEFAULT true
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_batch_status TEXT;
    v_finished_good_id uuid;
BEGIN
    SELECT status INTO v_batch_status FROM processing.batch WHERE batch_id = p_batch_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบชุดการแปรรูป %', p_batch_id;
    END IF;
    IF v_batch_status <> 'InProgress' THEN
        RAISE EXCEPTION 'ชุดการแปรรูป % ไม่ได้อยู่ระหว่างดำเนินการแล้ว (สถานะ %)', p_batch_id, v_batch_status;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM processing.batch_input WHERE batch_id = p_batch_id) THEN
        RAISE EXCEPTION 'ชุดการแปรรูป % ยังไม่มีวัตถุดิบนำเข้า — กรุณานำเข้าล็อตก่อนบันทึกผลผลิต', p_batch_id;
    END IF;

    INSERT INTO processing.finished_good (batch_id, product_name, quantity_ton, is_primary_product)
    VALUES (p_batch_id, p_product_name, p_quantity_ton, p_is_primary_product)
    RETURNING finished_good_id INTO v_finished_good_id;

    RETURN v_finished_good_id;
END;
$$;

CREATE FUNCTION processing.complete_batch(
  p_batch_id uuid, p_completed_by text
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_batch_status TEXT;
BEGIN
    SELECT status INTO v_batch_status FROM processing.batch WHERE batch_id = p_batch_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบชุดการแปรรูป %', p_batch_id;
    END IF;
    IF v_batch_status <> 'InProgress' THEN
        RAISE EXCEPTION 'ชุดการแปรรูป % ไม่ได้อยู่ระหว่างดำเนินการแล้ว (สถานะ %)', p_batch_id, v_batch_status;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM processing.batch_input WHERE batch_id = p_batch_id) THEN
        RAISE EXCEPTION 'ชุดการแปรรูป % ยังไม่มีวัตถุดิบนำเข้า', p_batch_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM processing.finished_good WHERE batch_id = p_batch_id) THEN
        RAISE EXCEPTION 'ชุดการแปรรูป % ยังไม่มีผลผลิตที่ได้ — กรุณาบันทึกผลผลิตก่อนปิดชุด', p_batch_id;
    END IF;

    UPDATE processing.batch
    SET status = 'Completed', completed_by = p_completed_by, completed_at = now()
    WHERE batch_id = p_batch_id;
END;
$$;

CREATE FUNCTION processing.cancel_batch(
  p_batch_id uuid, p_cancelled_by text, p_reason text
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_batch_status TEXT;
BEGIN
    SELECT status INTO v_batch_status FROM processing.batch WHERE batch_id = p_batch_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบชุดการแปรรูป %', p_batch_id;
    END IF;
    IF v_batch_status <> 'InProgress' THEN
        RAISE EXCEPTION 'ยกเลิกได้เฉพาะชุดการแปรรูปที่ยังอยู่ระหว่างดำเนินการเท่านั้น (สถานะปัจจุบัน %)', v_batch_status;
    END IF;

    UPDATE processing.batch
    SET status = 'Cancelled', cancelled_by = p_cancelled_by, cancelled_at = now(), cancel_reason = p_reason
    WHERE batch_id = p_batch_id;
END;
$$;

CREATE FUNCTION processing.record_dispatch(
  p_finished_good_id uuid, p_quantity_ton numeric, p_recorded_by text, p_note text DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_on_hand NUMERIC(14,3);
    v_dispatch_id uuid;
BEGIN
    SELECT quantity_on_hand_ton INTO v_on_hand
      FROM processing.v_finished_good_stock WHERE finished_good_id = p_finished_good_id;
    IF v_on_hand IS NULL THEN
        RAISE EXCEPTION 'ไม่พบสินค้าสำเร็จรูป %', p_finished_good_id;
    END IF;
    IF p_quantity_ton > v_on_hand THEN
        RAISE EXCEPTION 'ปริมาณที่ต้องการนำออก (%) เกินสต็อกคงเหลือ (%)', p_quantity_ton, v_on_hand;
    END IF;

    INSERT INTO processing.finished_good_dispatch (finished_good_id, quantity_ton, recorded_by, note)
    VALUES (p_finished_good_id, p_quantity_ton, p_recorded_by, p_note)
    RETURNING dispatch_id INTO v_dispatch_id;

    RETURN v_dispatch_id;
END;
$$;

-- ============================================================================
-- Follow-up work this migration deliberately leaves open:
--   - No real link from finished goods to a QR-traceable
--     traceability.certificate row (see the design note at the top of this
--     file) — needs a schema change to that table's own shape, which
--     affects every other module already reading it; left as a dedicated
--     future migration once a concrete "consumer-facing QR code" requirement
--     exists.
--   - No buyer/order hookup for processing.finished_good_dispatch — it is
--     currently just an inventory drawdown record (quantity, who, when,
--     note), not a sale. Wiring it to a real buyer/contract (so dispatching
--     finished goods also creates the matching produce/ledger records) is
--     M12/M13 territory, once cooperatives selling PROCESSED (not raw)
--     product to buyers is an actual requirement.
--   - Cancelled batches keep their processing.batch_input rows (excluded
--     from "committed" via v_lot_processing_availability, but not deleted)
--     — same non-destructive, audit-preserving posture as the rest of this
--     platform's append-only tables.
--   - No physical weighbridge/IoT integration for input/output quantities
--     — manually entered by cooperative staff, same posture as every other
--     manual-entry number in this platform.
-- ============================================================================
