-- AgroLink Platform — B2B Commerce Engine, Phase 2
-- e-Auction (reverse auction) + Contract auto-generation on award +
-- Purchase Order (PO) — the next three stages of the pipeline described
-- in B2B_COMMERCE_ENGINE_ARCHITECTURE.md, immediately downstream of the
-- RFP/RFQ marketplace (grant_rfq_marketplace.sql).
--
-- Design summary (see the architecture doc for the full rationale):
--   1. An AUCTION is always created FROM an existing open RFQ (one-to-one)
--      — it does not duplicate requester/category/description, it just
--      adds real-time competitive bidding on top of an RFQ that already
--      exists. Reverse-auction only in this pass (buyer posts a need,
--      sellers bid the price DOWN) — a "forward" (sell-side, price bid UP)
--      mode is a documented future widening, not built now.
--   2. Bidding is OPEN-PRICE / ANONYMOUS-BIDDER: any eligible organization
--      can see the current lowest bid (so they know what they need to
--      beat) but not WHO holds it until the auction closes — this is
--      enforced at the application layer (src/routes/procurement.js), not
--      the database.
--   3. Closing an auction AUTO-AWARDS the lowest bid immediately (unlike
--      RFQ, where accepting a quote is a separate manual step) — the
--      whole point of an auction is that the competition result IS the
--      decision, there is nothing left for a human to choose between.
--   4. CONTRACT creation reuses the EXISTING contract.contract /
--      contract_party tables (built for loan_agreement, but its own
--      contract_type CHECK already included 'forward_purchase' /
--      'service_agreement' / 'input_supply_agreement' — this schema was
--      designed to support exactly this case, just never had a caller for
--      those three contract types until now). A new SECURITY DEFINER
--      function, procurement.create_contract_from_award(), mirrors
--      underwriting.approve_application()'s existing shape exactly (same
--      "look up the source row FOR UPDATE, INSERT contract + parties,
--      write the new contract_id back onto the source row" pattern) and
--      is called from BOTH "accept an RFQ quote" and "close an auction".
--   5. contract_party.party_role's existing CHECK constraint
--      ('farmer','lender','buyer','service_provider','input_supplier',
--      'platform') has no role for "an organization selling produce/
--      processed goods" (the existing roles were named for the loan/
--      forward-purchase-with-a-farmer case, where the produce SELLER is
--      always tagged 'farmer' regardless of direction). RFQ's
--      produce/processed_good/other categories can have an ORGANIZATION
--      as the seller (a Cooperative or Mill responding to a buyer's RFQ)
--      — there is no existing role name for that, so this migration
--      ADDS 'seller' to the allowed set (additive widening, same pattern
--      grant_cooperative_product_catalog.sql used for product_listing's
--      category CHECK — never narrows, only adds).
--   6. PURCHASE ORDER is a new table, one per delivery tranche against an
--      active contract (a single contract can be drawn down over several
--      POs). No FK to marketplace/produce delivery tables — wiring a PO
--      into logistics.shipment / produce.delivery / a future GRN is the
--      next phase (see architecture doc section 4.7–4.9), deliberately
--      not built in this pass.

-- ============================================================
-- 1. Widen contract_party's party_role to add 'seller'
-- ============================================================
ALTER TABLE contract.contract_party DROP CONSTRAINT contract_party_party_role_check;
ALTER TABLE contract.contract_party ADD CONSTRAINT contract_party_party_role_check
  CHECK (party_role IN ('farmer', 'lender', 'buyer', 'service_provider', 'input_supplier', 'platform', 'seller'));

-- ============================================================
-- 2. Traceability: which contract (if any) an RFQ's award produced
-- ============================================================
ALTER TABLE procurement.rfq ADD COLUMN IF NOT EXISTS contract_id uuid REFERENCES contract.contract(contract_id);

-- ============================================================
-- 3. e-Auction
-- ============================================================
CREATE TABLE IF NOT EXISTS procurement.auction (
  auction_id    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  rfq_id         uuid NOT NULL REFERENCES procurement.rfq(rfq_id) ON DELETE CASCADE,
  starts_at       timestamptz NOT NULL DEFAULT now(),
  closes_at        timestamptz NOT NULL,
  status             text NOT NULL DEFAULT 'open',
  winning_bid_id      uuid,
  closed_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auction_status_check CHECK (status IN ('open', 'closed', 'awarded', 'cancelled')),
  CONSTRAINT auction_closes_after_starts CHECK (closes_at > starts_at),
  -- One auction per RFQ in this pass — keeps "which auction is this RFQ's"
  -- unambiguous everywhere (RFQ detail, contract traceability) without a
  -- separate "current auction" pointer column.
  CONSTRAINT uq_auction_rfq UNIQUE (rfq_id)
);
CREATE INDEX IF NOT EXISTS idx_auction_status ON procurement.auction (status, closes_at);

CREATE TABLE IF NOT EXISTS procurement.auction_bid (
  bid_id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  auction_id       uuid NOT NULL REFERENCES procurement.auction(auction_id) ON DELETE CASCADE,
  bidder_org_id     uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  bid_price           numeric(18,2) NOT NULL,
  bid_quantity          numeric(14,2),
  message                 text,
  submitted_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auction_bid_price_check CHECK (bid_price > 0),
  CONSTRAINT auction_bid_quantity_check CHECK (bid_quantity IS NULL OR bid_quantity > 0)
);
CREATE INDEX IF NOT EXISTS idx_auction_bid_auction_price ON procurement.auction_bid (auction_id, bid_price ASC);
CREATE INDEX IF NOT EXISTS idx_auction_bid_bidder ON procurement.auction_bid (bidder_org_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'auction_winning_bid_id_fkey'
  ) THEN
    ALTER TABLE procurement.auction
      ADD CONSTRAINT auction_winning_bid_id_fkey
      FOREIGN KEY (winning_bid_id) REFERENCES procurement.auction_bid(bid_id);
  END IF;
END $$;

-- ============================================================
-- 4. Contract auto-generation on award (RFQ quote accept OR auction close)
-- ============================================================

-- p_category is the RFQ's category (passed in rather than re-queried,
-- since both call sites already have the RFQ row loaded). Mirrors
-- underwriting.approve_application()'s exact shape: SECURITY DEFINER,
-- one INSERT into contract.contract, matching contract_party rows, write
-- the new contract_id back onto the source RFQ row.
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
    ELSE 'forward_purchase' -- produce | processed_good | other
  END;

  v_responder_role := CASE p_category
    WHEN 'input_product' THEN 'input_supplier'
    WHEN 'machinery_service' THEN 'service_provider'
    ELSE 'seller' -- produce | processed_good | other
  END;

  v_requester_role := CASE WHEN p_requester_subject_type = 'farmer' THEN 'farmer' ELSE 'buyer' END;

  -- status = 'active' (not 'draft') is a deliberate simplification: unlike
  -- underwriting.approve_application()'s loan contracts (which land in
  -- 'draft' and wait for a signature step that itself doesn't exist yet
  -- anywhere in this codebase — same gap, not introduced here), a
  -- contract produced by RFQ/auction AWARD already represents a completed
  -- mutual agreement — the requester explicitly chose this quote/bid, and
  -- the responder explicitly submitted it knowing acceptance is binding.
  -- There is nothing left to "sign" that the award step itself didn't
  -- already settle. Starting active (rather than sitting undrawable in
  -- 'draft' forever, which is what would happen given no activation
  -- endpoint exists) is what makes the very next stage — Purchase Order,
  -- which requires an active contract — actually reachable.
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

-- ============================================================
-- 5. Purchase Order
-- ============================================================
CREATE TABLE IF NOT EXISTS procurement.purchase_order (
  po_id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  po_number                text NOT NULL UNIQUE,
  contract_id                uuid NOT NULL REFERENCES contract.contract(contract_id),
  issued_by_subject_type       text NOT NULL,
  issued_by_subject_id           uuid NOT NULL,
  quantity                         numeric(14,2) NOT NULL,
  quantity_unit                      text,
  unit_price                           numeric(18,2) NOT NULL,
  total_amount                           numeric(18,2) NOT NULL,
  delivery_location                        text,
  needed_by_date                             date,
  status                                       text NOT NULL DEFAULT 'issued',
  notes                                          text,
  issued_at                                        timestamptz NOT NULL DEFAULT now(),
  acknowledged_at                                    timestamptz,
  updated_at                                           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT po_issued_by_subject_type_check CHECK (issued_by_subject_type IN ('farmer', 'organization')),
  CONSTRAINT po_status_check CHECK (status IN ('issued', 'acknowledged', 'in_fulfillment', 'completed', 'cancelled')),
  CONSTRAINT po_quantity_check CHECK (quantity > 0),
  CONSTRAINT po_unit_price_check CHECK (unit_price > 0),
  CONSTRAINT po_total_amount_check CHECK (total_amount > 0)
);
CREATE INDEX IF NOT EXISTS idx_po_contract ON procurement.purchase_order (contract_id);
CREATE INDEX IF NOT EXISTS idx_po_issued_by ON procurement.purchase_order (issued_by_subject_type, issued_by_subject_id);

-- ============================================================
-- Grants — same "no RLS, explicit WHERE clause IS the security boundary"
-- convention as every other procurement.* table (see grant_rfq_
-- marketplace.sql's own note). EXECUTE on the new SECURITY DEFINER
-- function is required separately from table grants.
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON procurement.auction TO agrolink_app;
GRANT SELECT, INSERT ON procurement.auction_bid TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON procurement.purchase_order TO agrolink_app;
GRANT EXECUTE ON FUNCTION procurement.create_contract_from_award(uuid, text, text, uuid, uuid, numeric, text, numeric) TO agrolink_app;

-- ============================================================
-- Verification notes (run manually, not part of this script):
--   \d procurement.auction
--   \d procurement.auction_bid
--   \d procurement.purchase_order
--   \df procurement.create_contract_from_award
-- ============================================================
