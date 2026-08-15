-- AgroLink -- Cooperative SaaS, M09 Collection & Quality Station.
--
-- Context: AgroLink_Cooperative_SaaS_Master_Blueprint_v1.0's Gap Analysis
-- flagged M09 (จุดรับซื้อผลผลิต / Collection & Quality) as a real gap: the
-- existing produce.delivery / produce.record_delivery() / produce.
-- confirm_quality() / produce.settle_delivery() machinery built for the
-- Buyer Portal (see grant_buyer_portal.sql) already covers "one delivery
-- at a time," but the Blueprint's collection-station workflow additionally
-- expects (a) a ความชื้น (moisture %) reading captured at quality
-- inspection, and (b) a "lot" concept — grouping several individual
-- deliveries from different farmers into one batch for downstream
-- warehouse/processing handling (M10/M11, not built yet). Neither exists
-- in 02_full_schema.sql today (confirmed by reading produce.delivery's DDL
-- directly — no moisture_pct column, no lot table). This migration adds
-- both, and nothing else — it deliberately reuses record_delivery() /
-- settle_delivery() unchanged rather than forking them, since a
-- cooperative's collection flow is otherwise identical to a Buyer's.
--
-- Design decision — no membership gating (yet): there is no
-- farmer<->cooperative membership table anywhere in this codebase (M02
-- Digital Member & Farmer, which would define it, has not been built).
-- src/routes/buyer.js's own GET /buyer/production-units already browses
-- ALL active production units platform-wide with no relationship
-- restriction — the new cooperative-facing route mirrors that exact
-- precedent rather than blocking M09 on M02 first. This is a documented,
-- temporary scope boundary (see the route file's own comment), not an
-- oversight.
--
-- Design decision — extending confirm_quality() rather than forking it:
-- produce.confirm_quality(p_delivery_id, p_quality_grade, p_accepted,
-- p_inspected_by) is DROPped and re-CREATEd with a 5th parameter
-- (p_moisture_pct numeric DEFAULT NULL). Because the new parameter has a
-- DEFAULT, every existing 4-argument caller — src/routes/buyer.js's
-- `SELECT produce.confirm_quality($1,$2,$3,$4)` — keeps working completely
-- unchanged (Postgres fills the default), and simply never records a
-- moisture reading, exactly like today. This was chosen over
-- CREATE OR REPLACE (which would have created a second, separately
-- maintained 5-arg overload instead of actually replacing the function,
-- since the argument list changed) specifically to keep one single
-- implementation of the quality-confirmation business logic.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ความชื้น (moisture %) on produce.delivery + a nullable lot_id FK.
-- ---------------------------------------------------------------------------
ALTER TABLE produce.delivery
  ADD COLUMN IF NOT EXISTS moisture_pct numeric(5,2);

ALTER TABLE produce.delivery
  ADD CONSTRAINT delivery_moisture_pct_check
    CHECK (moisture_pct IS NULL OR (moisture_pct >= 0 AND moisture_pct <= 100));

-- ---------------------------------------------------------------------------
-- 2. produce.lot — batches several individual deliveries (same buyer +
--    commodity) into one lot for downstream handling. A lot starts 'Open'
--    (deliveries can still be assigned to it) and is explicitly 'Closed' by
--    the cooperative once collection for that batch is done; a Closed lot
--    is not itself a workflow dead-end here — settlement still happens per
--    DELIVERY (produce.settle_delivery() is unchanged) — a lot is a
--    grouping/traceability record for M10 Warehouse to build on, not a
--    payment unit. No RLS: same `WHERE buyer_org_id = $1` convention as
--    produce.delivery itself (see grant_buyer_portal.sql's own note on why
--    that table has none).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS produce.lot (
  lot_id          uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  buyer_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  commodity_code  text NOT NULL REFERENCES registry.commodity_ref(commodity_code),
  quality_grade   text,
  status          text NOT NULL DEFAULT 'Open',
  lot_note        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  CONSTRAINT lot_status_check CHECK (status IN ('Open', 'Closed'))
);

CREATE INDEX IF NOT EXISTS idx_lot_buyer_org ON produce.lot (buyer_org_id);

ALTER TABLE produce.delivery
  ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES produce.lot(lot_id);

CREATE INDEX IF NOT EXISTS idx_delivery_lot_id ON produce.delivery (lot_id);

GRANT SELECT, INSERT, UPDATE ON produce.lot TO agrolink_app;

-- ---------------------------------------------------------------------------
-- 3. produce.confirm_quality() — add ความชื้น capture (see design note
--    above for why this is a DROP + re-CREATE rather than CREATE OR
--    REPLACE). Body is otherwise byte-for-byte identical to the original.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS produce.confirm_quality(uuid, text, boolean, text);

CREATE FUNCTION produce.confirm_quality(
  p_delivery_id uuid, p_quality_grade text, p_accepted boolean, p_inspected_by text,
  p_moisture_pct numeric DEFAULT NULL
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_status TEXT;
BEGIN
    SELECT status INTO v_status FROM produce.delivery WHERE delivery_id = p_delivery_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบการส่งมอบ %', p_delivery_id;
    END IF;
    IF v_status <> 'delivered' THEN
        RAISE EXCEPTION 'การส่งมอบ % อยู่ในสถานะ % แล้ว ไม่สามารถตรวจคุณภาพซ้ำได้', p_delivery_id, v_status;
    END IF;

    UPDATE produce.delivery
    SET status = CASE WHEN p_accepted THEN 'accepted' ELSE 'rejected' END,
        quality_grade = p_quality_grade, inspected_by = p_inspected_by, inspected_at = now(),
        moisture_pct = p_moisture_pct
    WHERE delivery_id = p_delivery_id;
END;
$$;

COMMENT ON FUNCTION produce.confirm_quality(uuid, text, boolean, text, numeric) IS
  'M09: เหมือนต้นฉบับ (Buyer Portal) ทุกประการ + บันทึกความชื้น (moisture_pct) ตอนตรวจคุณภาพ — p_moisture_pct เป็น optional (DEFAULT NULL) เพื่อไม่กระทบ src/routes/buyer.js ที่เรียกแบบ 4 พารามิเตอร์เดิม';

-- ---------------------------------------------------------------------------
-- 4. Lot lifecycle functions. Deliberately mirror the "route does the
--    ownership check, function does the business rule" split used by
--    confirm_quality()/settle_delivery() throughout buyer.js: these
--    functions trust their caller on ownership for close_lot/
--    assign_delivery_to_lot (the route MUST verify buyer_org_id = $subject
--    itself before calling, exactly like buyer.js's confirm-quality/settle
--    routes do for produce.delivery) — create_lot needs no such check since
--    buyer_org_id is supplied directly as the new row's own value.
-- ---------------------------------------------------------------------------
CREATE FUNCTION produce.create_lot(
  p_buyer_org_id uuid, p_commodity_code text, p_quality_grade text DEFAULT NULL, p_lot_note text DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_lot_id uuid;
BEGIN
    INSERT INTO produce.lot (buyer_org_id, commodity_code, quality_grade, lot_note)
    VALUES (p_buyer_org_id, p_commodity_code, p_quality_grade, p_lot_note)
    RETURNING lot_id INTO v_lot_id;
    RETURN v_lot_id;
END;
$$;

CREATE FUNCTION produce.assign_delivery_to_lot(p_delivery_id uuid, p_lot_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_lot_status         TEXT;
    v_lot_commodity       TEXT;
    v_delivery_status         TEXT;
    v_delivery_commodity          TEXT;
BEGIN
    SELECT status, commodity_code INTO v_lot_status, v_lot_commodity
    FROM produce.lot WHERE lot_id = p_lot_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบล็อต %', p_lot_id;
    END IF;
    IF v_lot_status <> 'Open' THEN
        RAISE EXCEPTION 'ล็อต % ปิดแล้ว ไม่สามารถเพิ่มการส่งมอบเข้าไปได้', p_lot_id;
    END IF;

    SELECT status, commodity_code INTO v_delivery_status, v_delivery_commodity
    FROM produce.delivery WHERE delivery_id = p_delivery_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบการส่งมอบ %', p_delivery_id;
    END IF;
    IF v_delivery_status = 'settled' THEN
        RAISE EXCEPTION 'การส่งมอบ % ชำระเงินแล้ว ไม่สามารถย้ายเข้าล็อตได้', p_delivery_id;
    END IF;
    IF v_delivery_commodity <> v_lot_commodity THEN
        RAISE EXCEPTION 'สินค้าของการส่งมอบ (%) ไม่ตรงกับสินค้าของล็อต (%)', v_delivery_commodity, v_lot_commodity;
    END IF;

    UPDATE produce.delivery SET lot_id = p_lot_id WHERE delivery_id = p_delivery_id;
END;
$$;

CREATE FUNCTION produce.close_lot(p_lot_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_status TEXT;
BEGIN
    SELECT status INTO v_status FROM produce.lot WHERE lot_id = p_lot_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบล็อต %', p_lot_id;
    END IF;
    IF v_status <> 'Open' THEN
        RAISE EXCEPTION 'ล็อต % ปิดไปแล้ว', p_lot_id;
    END IF;

    UPDATE produce.lot SET status = 'Closed', closed_at = now() WHERE lot_id = p_lot_id;
END;
$$;

-- ============================================================================
-- Follow-up work this migration deliberately leaves open (mirrors the
-- "Follow-up" checklist convention at the bottom of
-- grant_cooperative_tenant_foundation.sql):
--   - Membership-gated production-unit browsing (needs M02 Digital Member &
--     Farmer first — see the route file's comment).
--   - A lot is currently just a label/grouping (traceability), not a
--     storage/inventory record — M10 Warehouse will need to add its own
--     structures (bin/location, weight-in/weight-out) on top of this.
--   - No endpoint yet un-assigns a delivery from a lot, or moves it to a
--     different lot, or re-opens a Closed lot — none of that was in scope
--     for the Sprint plan's M09 slice and can be added if a real coop pilot
--     asks for it.
-- ============================================================================
