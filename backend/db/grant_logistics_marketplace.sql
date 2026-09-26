-- AgroLink Platform — Logistics Marketplace: self-service fleet, service
-- area, load-board matching, and empty-leg (backhaul) matching for the
-- Logistics org portal (frontend/logistics/, backend/src/routes/logistics.js).
--
-- Context / what this closes: grant_logistics_portal.sql gave a real,
-- self-registered org_type='Logistics' company a login and a view of
-- shipments a COOPERATIVE assigns to it — but that migration's own
-- "Follow-up work this migration deliberately leaves open" note said
-- plainly: "No self-service 'vehicle' management from the Logistics org's
-- own side yet" and there was no way for a carrier to advertise spare
-- capacity, browse hauling jobs from OTHER members, or negotiate a price —
-- every real interaction was still cooperative-initiated. This migration
-- closes that gap for the three remaining pieces the org-facing portal
-- was missing: a fleet registry it manages itself, a declared service
-- area, and two-sided marketplace matching (jobs + empty return trips).
--
-- Design decisions (documented up front so scope is honest):
--
--   1. Fleet registry (logistics.carrier_vehicle) is a NEW, separate table
--      from logistics.vehicle — that older table is scoped to
--      logistics.carrier.carrier_id, which is itself scoped to the
--      COOPERATIVE's own org_id (a carrier row there is the cooperative's
--      bookkeeping about a transporter, real account or not — see
--      grant_cooperative_logistics.sql's own comment on logistics.carrier).
--      A carrier_vehicle row here is scoped directly to the Logistics
--      org's OWN org_id instead — its self-declared fleet, independent of
--      how many different cooperatives separately keep it as a free-text
--      carrier record. The two tables intentionally never reference each
--      other; reconciling "this self-declared vehicle IS that
--      cooperative-entered logistics.vehicle row" is a real gap, same
--      "not built in this pass" honesty as every other follow-up note in
--      this schema.
--
--   2. Service area reuses partner.vendor_profile.service_regions
--      (text[], already in 02_full_schema.sql, NOT LOGISTICS-SPECIFIC) —
--      the exact same column GET/PUT /machinery/service-regions and
--      GET/PUT /inputsupplier/service-regions already read/write for
--      their own orgs. Every self-registered org (including Logistics —
--      see auth.js's POST /auth/org-register) already gets a
--      vendor_profile row at registration, defaulted to '{}'. No schema
--      change needed for this piece at all — just the new GET/PUT
--      /logistics/service-area route pair (added directly in
--      src/routes/logistics.js, not in this file).
--
--   3. Load board / bid-negotiate / booking confirmation deliberately do
--      NOT get a bespoke logistics.* schema. procurement.rfq /
--      procurement.rfq_quote (grant_rfq_marketplace.sql) already ARE
--      exactly this shape — "post what you need, receive competing
--      quotes, accept one" — open to any farmer/organization requester
--      and any organization responder, with award already producing a
--      real contract.contract row (grant_b2b_commerce_engine.sql). A
--      cooperative or buyer needing produce/fertilizer/biomass hauled
--      posts an RFQ with the new 'logistics_transport' category (added
--      below); a Logistics org (or another carrier subcontracting a load
--      it can't cover) responds with a quote — "เสนอราคา/ต่อรองราคา"
--      is procurement.rfq_quote's existing upsert-to-resubmit flow, and
--      "การจองยืนยัน" is the existing accept-a-quote award step. Building
--      a second, parallel bid/negotiate mechanism just for logistics
--      would duplicate a mechanism that already does this correctly and
--      would fragment where a shipper looks for price competition (see
--      procurement.js's own comment on why an RFQ with an e-Auction
--      running is bid on through ONE channel, not two, for the identical
--      reasoning). The only change needed is additive: widen
--      procurement.rfq's category CHECK constraint and
--      create_contract_from_award()'s category->contract_type/role
--      mapping to recognize the new category — everything else (quote
--      upsert/withdraw, award, contract creation) already works
--      unmodified for it.
--
--   4. Empty-leg / backhaul board (logistics.empty_leg) is the one
--      genuinely NEW two-sided flow, because it inverts the RFQ shape:
--      here the CARRIER is the one broadcasting ("I have a truck with
--      spare capacity going from A to B on date X"), not requesting.
--      procurement.rfq has no way to express "I am offering capacity,
--      not asking for it" without corrupting its own requester/responder
--      semantics, so this gets its own small table instead of being
--      force-fit into RFQ. Posting an empty leg is restricted to Verified
--      Logistics orgs (only a real carrier has a truck to offer); BROWSING
--      the open board is opened to any Verified organization (see
--      src/routes/logistics.js's placement of GET /empty-legs BEFORE the
--      requireLogisticsOrg gate) — a cooperative or buyer needing a
--      cheap one-off haul is exactly who this feature is for, and
--      restricting the read side to carriers-only would make the board
--      pointless. Booking an empty leg is NOT wired to a contract/PO —
--      same "manual today, real integration later" honesty as the
--      original RFQ "what's mocked" note; a shipper coordinates directly
--      with the carrier once posted (this is the current commercial norm:
--      empty-leg matching is a lead-generation/discovery tool, not a
--      binding contract by itself, even on real freight-matching
--      platforms) and the carrier itself marks it Booked/Cancelled/Expired.
--
-- No row-level security on any table below — same "explicit WHERE clause
-- IS the security boundary" convention as every logistics.*/marketplace.*/
-- procurement.* table already in this schema (see grant_logistics_
-- portal.sql's and grant_rfq_marketplace.sql's own notes). src/routes/
-- logistics.js's queries are the entire security boundary here.
-- ============================================================================

-- ----------------------------------------------------------------------
-- 1. Fleet registry — logistics.carrier_vehicle (see design note 1 above).
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logistics.carrier_vehicle (
  carrier_vehicle_id  uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  org_id              uuid NOT NULL REFERENCES identity.organization(org_id),
  vehicle_type        text NOT NULL,
  license_plate       text NOT NULL,
  capacity_ton        numeric(14,3),
  status              text NOT NULL DEFAULT 'active',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carrier_vehicle_type_check CHECK (vehicle_type IN ('Truck', 'Trailer', 'Pickup', 'Other')),
  CONSTRAINT carrier_vehicle_status_check CHECK (status IN ('active', 'inactive')),
  CONSTRAINT carrier_vehicle_capacity_check CHECK (capacity_ton IS NULL OR capacity_ton > 0)
);

CREATE INDEX IF NOT EXISTS idx_carrier_vehicle_org ON logistics.carrier_vehicle (org_id, status);

GRANT SELECT, INSERT, UPDATE ON logistics.carrier_vehicle TO agrolink_app;

-- ----------------------------------------------------------------------
-- 2. Empty-leg / backhaul board — logistics.empty_leg (see design note 4
--    above). carrier_vehicle_id is OPTIONAL — a carrier can post a leg
--    before entering that specific vehicle into the fleet registry above,
--    same "don't force a dependency that isn't load-bearing" posture as
--    logistics.shipment.vehicle_id being nullable in grant_cooperative_
--    logistics.sql.
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logistics.empty_leg (
  empty_leg_id        uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  org_id              uuid NOT NULL REFERENCES identity.organization(org_id),
  carrier_vehicle_id  uuid REFERENCES logistics.carrier_vehicle(carrier_vehicle_id),
  origin              text NOT NULL,
  destination         text NOT NULL,
  available_date      date NOT NULL,
  capacity_ton        numeric(14,3),
  note                text,
  contact_phone       text,
  status              text NOT NULL DEFAULT 'Open',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT empty_leg_status_check CHECK (status IN ('Open', 'Booked', 'Cancelled', 'Expired')),
  CONSTRAINT empty_leg_capacity_check CHECK (capacity_ton IS NULL OR capacity_ton > 0)
);

CREATE INDEX IF NOT EXISTS idx_empty_leg_org ON logistics.empty_leg (org_id, status);
CREATE INDEX IF NOT EXISTS idx_empty_leg_board ON logistics.empty_leg (status, available_date);

GRANT SELECT, INSERT, UPDATE ON logistics.empty_leg TO agrolink_app;

-- ----------------------------------------------------------------------
-- 3. Load board / bid-negotiate — widen the existing RFQ marketplace
--    instead of building a parallel one (see design note 3 above).
-- ----------------------------------------------------------------------
ALTER TABLE procurement.rfq DROP CONSTRAINT IF EXISTS rfq_category_check;
ALTER TABLE procurement.rfq ADD CONSTRAINT rfq_category_check
  CHECK (category IN ('input_product', 'produce', 'processed_good', 'machinery_service', 'logistics_transport', 'other'));

-- Adds the 'logistics_transport' branch alongside the existing ones —
-- same function signature, so a plain CREATE OR REPLACE (not a DROP)
-- is enough, unlike logistics.create_carrier() in grant_logistics_
-- portal.sql, which needed a new PARAMETER and therefore a real DROP.
-- 'service_agreement'/'service_provider' are both already valid values
-- on contract.contract's and contract.contract_party's own CHECK
-- constraints (added for 'machinery_service' — see 02_full_schema.sql and
-- grant_b2b_commerce_engine.sql), so no further ALTER is needed there: a
-- hauling job awarded through this marketplace produces a real contract
-- exactly like an awarded machinery-service RFQ already does today.
CREATE OR REPLACE FUNCTION procurement.create_contract_from_award(
  p_rfq_id uuid,
  p_category text,
  p_requester_subject_type text,
  p_requester_subject_id uuid,
  p_responder_org_id uuid,
  p_agreed_quantity numeric,
  p_quantity_unit text,
  p_agreed_unit_price numeric
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_contract_type TEXT;
  v_responder_role TEXT;
  v_requester_role TEXT;
  v_contract_id UUID;
BEGIN
  v_contract_type := CASE p_category
    WHEN 'input_product' THEN 'input_supply_agreement'
    WHEN 'machinery_service' THEN 'service_agreement'
    WHEN 'logistics_transport' THEN 'service_agreement'
    ELSE 'forward_purchase' -- produce | processed_good | other
  END;

  v_responder_role := CASE p_category
    WHEN 'input_product' THEN 'input_supplier'
    WHEN 'machinery_service' THEN 'service_provider'
    WHEN 'logistics_transport' THEN 'service_provider'
    ELSE 'seller' -- produce | processed_good | other
  END;

  v_requester_role := CASE WHEN p_requester_subject_type = 'farmer' THEN 'farmer' ELSE 'buyer' END;

  INSERT INTO contract.contract
    (contract_type, status, agreed_quantity, agreed_unit_price, quantity_unit, effective_date, terms_summary)
  VALUES
    (v_contract_type, 'active', p_agreed_quantity, p_agreed_unit_price, COALESCE(p_quantity_unit, 'หน่วย'), CURRENT_DATE,
     'สร้างอัตโนมัติจากผลการคัดเลือกผู้ขายใน RFQ/e-Auction อ้างอิง procurement.rfq ' || p_rfq_id::text)
  RETURNING contract_id INTO v_contract_id;

  INSERT INTO contract.contract_party (contract_id, party_role, party_type, party_id) VALUES
    (v_contract_id, v_requester_role, p_requester_subject_type, p_requester_subject_id),
    (v_contract_id, v_responder_role, 'organization', p_responder_org_id);

  UPDATE procurement.rfq SET contract_id = v_contract_id WHERE rfq_id = p_rfq_id;

  RETURN v_contract_id;
END;
$$;

-- ============================================================================
-- Verification notes (run manually, not part of this script):
--   \d logistics.carrier_vehicle
--   \d logistics.empty_leg
--   \d procurement.rfq                  (category CHECK includes logistics_transport)
--   \df procurement.create_contract_from_award
-- ============================================================================
-- Follow-up work this migration deliberately leaves open:
--   - No link between a self-declared logistics.carrier_vehicle row and
--     any cooperative's own logistics.vehicle bookkeeping row for the
--     "same" real truck (see design note 1) — they were never one shared
--     record to begin with, so there is nothing to keep "in sync."
--   - Booking an empty leg is not wired into any contract/PO/notification
--     flow (see design note 4) — purely a discovery board.
--   - No expiry sweep that automatically flips a past-available_date
--     'Open' empty leg to 'Expired' — status transitions are all
--     caller-driven (same as every status column elsewhere in this
--     schema; there is no scheduled job infrastructure in this project).
-- ============================================================================
