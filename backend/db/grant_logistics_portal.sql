-- AgroLink -- Logistics Org Self-Service Portal.
--
-- Context: grant_cooperative_logistics.sql built logistics.carrier/vehicle/
-- shipment/shipment_item/proof_of_delivery/shipment_exception entirely from
-- the COOPERATIVE's point of view -- a "carrier" there is just a free-text
-- record (carrier_name/contact_phone) the cooperative types in itself; it
-- is NOT linked to any real platform account. That's fine for a
-- cooperative's own internal bookkeeping, but it means a real, separately-
-- registered org_type='Logistics' organization (a trucking company that
-- self-registered via POST /auth/org-register) has no way to log in and
-- see the shipments assigned to it -- there was, in fact, no portal for it
-- at all (see B2B_COMMERCE_ENGINE_ARCHITECTURE.md's own "*ยังไม่มีพอร์ทัล*"
-- note and backend/README.md's "one remaining self-registerable org_type
-- without a portal" line).
--
-- This migration closes that gap with the minimum schema change needed:
--   1. logistics.carrier gets a new NULLABLE linked_org_id column, pointing
--      at a real identity.organization row. A carrier row from BEFORE this
--      migration (or one a cooperative deliberately keeps as free text --
--      e.g. a member's own truck, never going to be a platform user) just
--      has linked_org_id = NULL and behaves exactly as before.
--   2. Two functions manage that link: logistics.create_carrier() gains an
--      optional 5th parameter to link at creation time, and the new
--      logistics.link_carrier_org() links (or unlinks, passing NULL) an
--      EXISTING carrier row after the fact -- covering both "the
--      cooperative already knows which real org this is" and "the
--      cooperative typed a carrier in ages ago and wants to link it now"
--      cases. Both funnel through logistics.assert_linkable_logistics_org(),
--      which enforces the only two rules that matter here: the target must
--      actually be an org_type='Logistics' organization, and it must be
--      kyb_status='Verified' (same "don't let an unapproved account plug
--      itself into anything real" posture used everywhere else in this
--      platform).
--   3. logistics.v_shipment_summary is widened (columns appended at the
--      end, so this stays a safe CREATE OR REPLACE for the cooperative's
--      existing reads of it) to also expose carrier.linked_org_id and the
--      owning cooperative's org_name -- exactly what the new portal's own
--      "shipments assigned to me" query needs to filter and to show who
--      sent the shipment.
--
-- Deliberately NOT changed: who can call dispatch_shipment() / record_pod()
-- / report_exception() at the SQL level -- those functions still just
-- trust their caller on ownership, same as every other function in this
-- migration's parent file. The new backend/src/routes/logistics.js portal
-- calls the exact same functions grant_cooperative_logistics.sql already
-- defined, just gated by "does this shipment's carrier.linked_org_id match
-- my own org_id" instead of coopcollection.js's "does this shipment.org_id
-- match my own org_id" -- two different, equally legitimate parties acting
-- on the same shipment lifecycle (the cooperative that books it, the
-- carrier that carries it out), exactly like a real shipment works.
-- ============================================================================

ALTER TABLE logistics.carrier ADD COLUMN IF NOT EXISTS linked_org_id uuid REFERENCES identity.organization(org_id);
CREATE INDEX IF NOT EXISTS idx_carrier_linked_org ON logistics.carrier (linked_org_id) WHERE linked_org_id IS NOT NULL;

CREATE OR REPLACE FUNCTION logistics.assert_linkable_logistics_org(p_linked_org_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_org_type    TEXT;
    v_kyb_status  TEXT;
BEGIN
    IF p_linked_org_id IS NULL THEN
        RETURN; -- unlinking, or never linked -- always allowed
    END IF;

    SELECT org_type, kyb_status INTO v_org_type, v_kyb_status
      FROM identity.organization WHERE org_id = p_linked_org_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบองค์กร %', p_linked_org_id;
    END IF;
    IF v_org_type <> 'Logistics' THEN
        RAISE EXCEPTION 'องค์กร % ไม่ใช่ประเภทผู้ให้บริการขนส่ง (Logistics) จึงผูกบัญชีเป็นผู้ขนส่งไม่ได้', p_linked_org_id;
    END IF;
    IF v_kyb_status <> 'Verified' THEN
        RAISE EXCEPTION 'องค์กรขนส่งนี้ยังไม่ผ่านการตรวจสอบ (KYB) จึงยังผูกบัญชีไม่ได้ (สถานะปัจจุบัน %)', v_kyb_status;
    END IF;
END;
$$;

-- Re-created with one extra optional parameter -- DROP first since adding a
-- parameter changes the function's signature (Postgres would otherwise
-- leave the old 4-arg version around as a separate, now-dead overload
-- instead of truly replacing it).
DROP FUNCTION IF EXISTS logistics.create_carrier(uuid, text, text, text);
CREATE FUNCTION logistics.create_carrier(
  p_org_id uuid, p_carrier_name text, p_carrier_type text, p_contact_phone text DEFAULT NULL,
  p_linked_org_id uuid DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_carrier_id uuid;
BEGIN
    PERFORM logistics.assert_linkable_logistics_org(p_linked_org_id);

    INSERT INTO logistics.carrier (org_id, carrier_name, carrier_type, contact_phone, linked_org_id)
    VALUES (p_org_id, p_carrier_name, p_carrier_type, p_contact_phone, p_linked_org_id)
    RETURNING carrier_id INTO v_carrier_id;

    RETURN v_carrier_id;
END;
$$;

CREATE FUNCTION logistics.link_carrier_org(p_carrier_id uuid, p_linked_org_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM logistics.carrier WHERE carrier_id = p_carrier_id) THEN
        RAISE EXCEPTION 'ไม่พบผู้ขนส่ง %', p_carrier_id;
    END IF;
    PERFORM logistics.assert_linkable_logistics_org(p_linked_org_id);

    UPDATE logistics.carrier SET linked_org_id = p_linked_org_id WHERE carrier_id = p_carrier_id;
END;
$$;

GRANT EXECUTE ON FUNCTION logistics.assert_linkable_logistics_org(uuid) TO agrolink_app;
GRANT EXECUTE ON FUNCTION logistics.create_carrier(uuid, text, text, text, uuid) TO agrolink_app;
GRANT EXECUTE ON FUNCTION logistics.link_carrier_org(uuid, uuid) TO agrolink_app;

-- Widen the existing view -- columns appended at the END of the SELECT
-- list only, so this stays a valid CREATE OR REPLACE VIEW (Postgres allows
-- adding columns this way; reordering or removing any would require a
-- DROP). coop_org_name lets the Logistics portal show "who sent this
-- shipment" without a second round trip; linked_org_id is what the
-- portal's own dashboard query filters on.
CREATE OR REPLACE VIEW logistics.v_shipment_summary AS
  SELECT
    s.shipment_id, s.org_id, s.carrier_id, c.carrier_name, s.vehicle_id, v.license_plate,
    s.destination_name, s.destination_org_id, s.driver_name, s.status,
    s.scheduled_at, s.dispatched_at, s.delivered_at, s.cancelled_at, s.cancelled_by, s.cancel_reason,
    s.created_by, s.created_at,
    COALESCE(items.item_count, 0) AS item_count,
    COALESCE(items.total_quantity_ton, 0) AS total_quantity_ton,
    pod.received_by AS pod_received_by, pod.received_quantity_ton AS pod_received_quantity_ton, pod.recorded_at AS pod_recorded_at,
    COALESCE(exc.exception_count, 0) AS exception_count,
    c.linked_org_id,
    coop.org_name AS coop_org_name
  FROM logistics.shipment s
  LEFT JOIN logistics.carrier c ON c.carrier_id = s.carrier_id
  LEFT JOIN logistics.vehicle v ON v.vehicle_id = s.vehicle_id
  LEFT JOIN logistics.proof_of_delivery pod ON pod.shipment_id = s.shipment_id
  LEFT JOIN identity.organization coop ON coop.org_id = s.org_id
  LEFT JOIN (
    SELECT shipment_id, COUNT(*)::int AS item_count, SUM(quantity_ton) AS total_quantity_ton
    FROM logistics.shipment_item GROUP BY shipment_id
  ) items ON items.shipment_id = s.shipment_id
  LEFT JOIN (
    SELECT shipment_id, COUNT(*)::int AS exception_count
    FROM logistics.shipment_exception GROUP BY shipment_id
  ) exc ON exc.shipment_id = s.shipment_id;

-- ============================================================================
-- Follow-up work this migration deliberately leaves open:
--   - A carrier can only be linked to ONE real org, and nothing stops the
--     same real Logistics org from being linked as the carrier for several
--     DIFFERENT cooperatives (each cooperative has its own separate
--     logistics.carrier row, since that table's own org_id is the
--     cooperative, not the carrier) -- that's intentional, matches a real
--     trucking company serving multiple clients, and the new portal's own
--     dashboard query (WHERE c.linked_org_id = $1) already reads across all
--     of them together correctly.
--   - No self-service "vehicle" management from the Logistics org's own
--     side yet -- vehicles stay something the cooperative enters (matches
--     how routing/rates are still entirely the cooperative's own
--     bookkeeping in this MVP slice; see grant_cooperative_logistics.sql's
--     own Follow-up note).
--   - No notification (email/SMS/push) to the linked Logistics org when a
--     new shipment is assigned to it -- this platform has no
--     notification/messaging infrastructure anywhere yet; the org has to
--     check its own dashboard.
-- ============================================================================
