-- AgroLink Platform — B2B Commerce Engine, Phase 3
-- GRN (Goods Receipt) + Invoice + Payment hook (ledger.transfer_funds) +
-- Revenue Sharing (cooperative → member farmers).
--
-- Continues directly from grant_b2b_commerce_engine.sql (Phase 2:
-- e-Auction + Contract auto-generation + Purchase Order). This file
-- completes the chain sketched in B2B_COMMERCE_ENGINE_ARCHITECTURE.md
-- section 4.8–4.11:
--
--   PO (acknowledged) → GRN (buyer confirms receipt) → Invoice (seller
--   bills for what was actually accepted) → Payment (real ledger.*
--   double-entry transfer) → [optional] Revenue Share (cooperative-seller
--   only — splits the money it just received among the member farmers
--   whose produce.delivery rows fed the lot that was sold).
--
-- DESIGN DECISIONS (read before extending this):
--
-- 1. GRN is one-per-PO, not tranche/partial-shipment tracking. A real
--    procurement system might let one PO receive goods across several
--    partial shipments; that's out of scope here — the existing "one
--    contract → several POs" design (Phase 2) is already how this
--    codebase models partial delivery (issue another PO for the next
--    tranche), so GRN staying 1:1 with PO keeps the status machine simple
--    and honest rather than half-building partial-GRN support nobody
--    asked for. `uq_grn_po` enforces this at the DB level.
--
-- 2. GRN is recorded by whoever ISSUED the PO (the buyer/farmer side —
--    same convention as the existing `produce.delivery` flow, where the
--    buyer records what arrived, not the seller). Matched by exact
--    subject_type/subject_id equality against `purchase_order.
--    issued_by_subject_type/id` — no extra join needed, the PO row
--    already carries this.
--
-- 3. PO status machine, extended from Phase 2:
--      issued → acknowledged → (GRN recorded) → in_fulfillment
--                                                    → (Invoice paid) → completed
--    `in_fulfillment` now means "goods physically received, financially
--    still open" regardless of whether the GRN accepted the full
--    quantity or rejected some of it — `completed` is reserved
--    exclusively for "money has actually moved," matching
--    produce.settle_delivery's status='settled' semantics.
--
-- 4. Invoice amount is computed from the GRN's `accepted_quantity`, not
--    the PO's requested quantity — the seller bills for what the buyer
--    actually agreed was acceptable, not what was originally ordered.
--    This is why `invoice.grn_id` is NOT NULL: an invoice cannot exist
--    before a GRN does (matches the standard "3-way match" PO→GRN→Invoice
--    procurement control, not novel to this project).
--
-- 5. Invoice `status` intentionally omits an 'approved' step even though
--    the architecture doc's earlier sketch listed one — same reasoning
--    as Phase 2 skipping contract 'draft': no endpoint anywhere in this
--    codebase implements a buyer-approval gate before payment, so adding
--    a status value with no way to reach it would just be dead state.
--    'disputed' and 'cancelled' ARE reachable (see procurement.js).
--
-- 6. Payment reuses `ledger.transfer_funds()` — the SAME function
--    `produce.settle_delivery()` and `marketplace.complete_service_request()`
--    already call. `procurement.pay_invoice()` below is written in the
--    identical SECURITY DEFINER / lock-row / resolve-accounts / transfer /
--    update-status shape as those two, just resolving BOTH sides
--    polymorphically (payer can be farmer OR organization; payee — the
--    seller party on the contract — is always an organization, same
--    invariant Phase 2 already established). A farmer payer must specify
--    WHICH of their production units' wallets pays (`p_payer_unit_id`) —
--    unlike produce.delivery/service_request (which already have a
--    unit_id on the row itself), procurement.rfq/contract is farmer-level,
--    not unit-level, so there's no existing column to infer this from.
--    Asking the farmer to pick is the honest choice over silently
--    guessing "their first unit."
--
-- 7. Revenue sharing keys lines by `unit_id`, NOT `farmer_id` as the
--    architecture doc's original sketch suggested — `ledger.account`'s
--    own `uq_unit_wallet_per_unit` constraint (see grant_credit_model.sql
--    et al.) already establishes "one wallet per production unit" as the
--    load-bearing invariant everywhere else in this schema
--    (settle_delivery, complete_service_request); keying by farmer_id
--    would need to invent a new "which of this farmer's units gets paid"
--    resolution this codebase doesn't otherwise need. `farmer_id` is kept
--    as a denormalized display column only.
--
-- 8. Revenue-share percentages are computed from `produce.delivery` rows
--    already sitting in the database (`GROUP BY unit_id` on `quantity_ton`
--    within the lot, `status = 'settled'`) — never hand-entered by a
--    cooperative staffer. This requires the WINNING quote/bid to have been
--    tagged with the `lot_id` it's fulfilling from (new
--    `procurement.rfq_quote.lot_id` / `procurement.auction_bid.lot_id`
--    columns below), captured at quote/bid-submission time by the
--    RESPONDER (the seller). Deliberately NOT on `procurement.rfq` itself
--    (an earlier draft of this migration put it there) — for a 'produce'
--    category RFQ, `create_contract_from_award()` makes the REQUESTER the
--    contract's 'buyer' party and the RESPONDER who wins the 'seller'
--    party; it's the seller who receives the invoice payment and later
--    runs revenue-share distribution (see pay_invoice/create_revenue_
--    share_plan below, both resolving the payee/coop_org_id from the
--    'seller' contract_party). Tagging lot_id on the RFQ would have
--    associated it with the buyer, who never receives sale proceeds to
--    redistribute. An RFQ whose awarded quote/bid has no lot_id simply
--    can't have a revenue-share plan created against its resulting
--    invoice (checked explicitly, not silently skipped).
--
-- 9. Per-line amounts are rounded independently (ROUND(...,2) per row) —
--    known limitation: the sum of all lines can drift from
--    invoice.amount by a few satang due to independent rounding. Not
--    reconciled in this pass (would need a remainder-assignment step);
--    flagging it here rather than silently shipping imprecise money math
--    unlabeled.
--
-- 10. `distribute_revenue_share()` processes each line inside its own
--     BEGIN/EXCEPTION block (PL/pgSQL's equivalent of a savepoint) so one
--     farmer's transfer failing (e.g. their unit has no wallet yet) does
--     NOT roll back every other farmer's payment in the same plan — the
--     architecture doc was explicit that this must be "many transactions,
--     not one," and a single top-level PL/pgSQL call is one transaction
--     unless it uses exactly this pattern.

-- 0. Seller-offer → lot linkage (for revenue-share sourcing). Lives on the
--    RESPONDER's own quote/bid, not on procurement.rfq — see design note 8
--    above. Additive-only widen, same convention as every prior
--    grant_*.sql in this project.
ALTER TABLE procurement.rfq_quote ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES produce.lot(lot_id);
ALTER TABLE procurement.auction_bid ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES produce.lot(lot_id);

-- 1. Goods Receipt (GRN)
CREATE TABLE IF NOT EXISTS procurement.goods_receipt (
  grn_id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  po_id                     uuid NOT NULL REFERENCES procurement.purchase_order(po_id) ON DELETE CASCADE,
  received_quantity         numeric(14,2) NOT NULL,
  accepted_quantity         numeric(14,2) NOT NULL,
  rejected_quantity         numeric(14,2) NOT NULL DEFAULT 0,
  rejection_reason          text,
  received_by_subject_type  text NOT NULL,
  received_by_subject_id    uuid NOT NULL,
  received_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grn_received_quantity_check CHECK (received_quantity > 0),
  CONSTRAINT grn_accepted_quantity_check CHECK (accepted_quantity >= 0),
  CONSTRAINT grn_rejected_quantity_check CHECK (rejected_quantity >= 0),
  CONSTRAINT grn_quantity_sum_check CHECK (accepted_quantity + rejected_quantity <= received_quantity),
  CONSTRAINT grn_received_by_subject_type_check CHECK (received_by_subject_type IN ('farmer', 'organization')),
  CONSTRAINT uq_grn_po UNIQUE (po_id)
);
CREATE INDEX IF NOT EXISTS idx_grn_po ON procurement.goods_receipt (po_id);

-- 2. Invoice
CREATE TABLE IF NOT EXISTS procurement.invoice (
  invoice_id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_no            text NOT NULL UNIQUE,
  po_id                 uuid NOT NULL REFERENCES procurement.purchase_order(po_id) ON DELETE CASCADE,
  grn_id                uuid NOT NULL REFERENCES procurement.goods_receipt(grn_id),
  issued_by_subject_type text NOT NULL,
  issued_by_subject_id   uuid NOT NULL,
  amount                numeric(18,2) NOT NULL,
  status                text NOT NULL DEFAULT 'issued',
  due_date              date,
  dispute_reason        text,
  issued_at             timestamptz NOT NULL DEFAULT now(),
  paid_at               timestamptz,
  paid_entry_id         uuid REFERENCES ledger.journal_entry(entry_id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_amount_check CHECK (amount > 0),
  CONSTRAINT invoice_status_check CHECK (status IN ('issued', 'paid', 'disputed', 'cancelled')),
  CONSTRAINT invoice_issued_by_subject_type_check CHECK (issued_by_subject_type IN ('farmer', 'organization')),
  CONSTRAINT uq_invoice_po UNIQUE (po_id)
);
CREATE INDEX IF NOT EXISTS idx_invoice_po ON procurement.invoice (po_id);
CREATE INDEX IF NOT EXISTS idx_invoice_status ON procurement.invoice (status);

-- 3. Revenue share plan + line
CREATE TABLE IF NOT EXISTS procurement.revenue_share_plan (
  plan_id        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id     uuid NOT NULL UNIQUE REFERENCES procurement.invoice(invoice_id),
  lot_id         uuid NOT NULL REFERENCES produce.lot(lot_id),
  coop_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  total_amount   numeric(18,2) NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  created_at     timestamptz NOT NULL DEFAULT now(),
  distributed_at timestamptz,
  CONSTRAINT revenue_share_plan_status_check CHECK (status IN ('pending', 'distributed')),
  CONSTRAINT revenue_share_plan_total_amount_check CHECK (total_amount > 0)
);
CREATE INDEX IF NOT EXISTS idx_revshare_plan_coop ON procurement.revenue_share_plan (coop_org_id);

CREATE TABLE IF NOT EXISTS procurement.revenue_share_line (
  line_id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  plan_id                   uuid NOT NULL REFERENCES procurement.revenue_share_plan(plan_id) ON DELETE CASCADE,
  unit_id                   uuid NOT NULL REFERENCES registry.production_unit(unit_id),
  farmer_id                 uuid NOT NULL REFERENCES identity.farmer(farmer_id),
  contributed_quantity_ton  numeric(12,3) NOT NULL,
  share_percent             numeric(6,3) NOT NULL,
  amount                    numeric(18,2) NOT NULL,
  status                    text NOT NULL DEFAULT 'pending',
  transfer_entry_id         uuid REFERENCES ledger.journal_entry(entry_id),
  failure_reason            text,
  CONSTRAINT revenue_share_line_status_check CHECK (status IN ('pending', 'paid', 'failed')),
  CONSTRAINT revenue_share_line_amount_check CHECK (amount >= 0),
  CONSTRAINT uq_revshare_line_plan_unit UNIQUE (plan_id, unit_id)
);
CREATE INDEX IF NOT EXISTS idx_revshare_line_plan ON procurement.revenue_share_line (plan_id);

-- 4. Payment hook: pay an invoice via the real ledger, same shape as
--    produce.settle_delivery() / marketplace.complete_service_request().
CREATE OR REPLACE FUNCTION procurement.pay_invoice(
  p_invoice_id uuid,
  p_payer_subject_type text,
  p_payer_subject_id uuid,
  p_payer_unit_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_status TEXT;
  v_amount NUMERIC(18,2);
  v_po_id UUID;
  v_contract_id UUID;
  v_issued_by_subject_type TEXT;
  v_issued_by_subject_id UUID;
  v_seller_org_id UUID;
  v_payer_account_id UUID;
  v_payee_account_id UUID;
  v_entry_id UUID;
  v_grn_accepted_qty NUMERIC(14,2);
  v_agreed_quantity NUMERIC(12,3);
  v_total_accepted_paid NUMERIC(14,2);
BEGIN
  SELECT status, amount, po_id INTO v_status, v_amount, v_po_id
    FROM procurement.invoice WHERE invoice_id = p_invoice_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบใบแจ้งหนี้ %', p_invoice_id;
  END IF;
  IF v_status <> 'issued' THEN
    RAISE EXCEPTION 'ใบแจ้งหนี้ % อยู่ในสถานะ % ต้องเป็น issued ก่อนจึงจะชำระได้', p_invoice_id, v_status;
  END IF;

  SELECT contract_id, issued_by_subject_type, issued_by_subject_id
    INTO v_contract_id, v_issued_by_subject_type, v_issued_by_subject_id
    FROM procurement.purchase_order WHERE po_id = v_po_id;

  IF v_issued_by_subject_type <> p_payer_subject_type OR v_issued_by_subject_id <> p_payer_subject_id THEN
    RAISE EXCEPTION 'สิทธิ์ไม่ตรง: ผู้ชำระต้องเป็นผู้ออกใบสั่งซื้อ (PO) ของใบแจ้งหนี้นี้เท่านั้น';
  END IF;

  IF p_payer_subject_type = 'organization' THEN
    SELECT settlement_account_id INTO v_payer_account_id FROM partner.vendor_profile WHERE org_id = p_payer_subject_id;
    IF v_payer_account_id IS NULL THEN
      RAISE EXCEPTION 'องค์กร % ยังไม่มีบัญชี vendor_settlement (ต้องผ่าน KYB และเปิดใช้งานก่อน)', p_payer_subject_id;
    END IF;
  ELSIF p_payer_subject_type = 'farmer' THEN
    IF p_payer_unit_id IS NULL THEN
      RAISE EXCEPTION 'ต้องระบุแปลง/หน่วยผลิต (unit) ที่จะใช้ชำระเงิน';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM registry.production_unit WHERE unit_id = p_payer_unit_id AND owner_farmer_id = p_payer_subject_id
    ) THEN
      RAISE EXCEPTION 'หน่วยผลิต % ไม่ใช่ของเกษตรกร %', p_payer_unit_id, p_payer_subject_id;
    END IF;
    SELECT account_id INTO v_payer_account_id FROM ledger.account
     WHERE account_type = 'unit_wallet' AND owner_id = p_payer_unit_id;
    IF v_payer_account_id IS NULL THEN
      RAISE EXCEPTION 'หน่วยผลิต % ยังไม่มีกระเป๋าเงิน (unit_wallet)', p_payer_unit_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'ประเภทผู้ชำระไม่ถูกต้อง: %', p_payer_subject_type;
  END IF;

  SELECT cp.party_id INTO v_seller_org_id
    FROM contract.contract_party cp
   WHERE cp.contract_id = v_contract_id AND cp.party_type = 'organization' AND cp.party_role NOT IN ('farmer', 'buyer')
   LIMIT 1;

  IF v_seller_org_id IS NULL THEN
    RAISE EXCEPTION 'ไม่พบคู่ค้าฝั่งผู้ขายของสัญญา %', v_contract_id;
  END IF;

  SELECT settlement_account_id INTO v_payee_account_id FROM partner.vendor_profile WHERE org_id = v_seller_org_id;
  IF v_payee_account_id IS NULL THEN
    RAISE EXCEPTION 'ผู้ขาย % ยังไม่มีบัญชี vendor_settlement', v_seller_org_id;
  END IF;

  v_entry_id := ledger.transfer_funds(
    p_from_account   := v_payer_account_id,
    p_to_account     := v_payee_account_id,
    p_amount         := v_amount,
    p_entry_type     := 'Settlement',
    p_description    := 'ชำระใบแจ้งหนี้ ' || p_invoice_id::text,
    p_reference_type := 'procurement_invoice',
    p_reference_id   := p_invoice_id
  );

  UPDATE procurement.invoice
     SET status = 'paid', paid_at = now(), paid_entry_id = v_entry_id, updated_at = now()
   WHERE invoice_id = p_invoice_id;

  UPDATE procurement.purchase_order
     SET status = 'completed', updated_at = now()
   WHERE po_id = v_po_id AND status IN ('acknowledged', 'in_fulfillment');

  -- Mirror produce.settle_delivery()'s auto-complete-the-contract behavior:
  -- once cumulative GRN-accepted quantity across every PAID-invoice PO on
  -- this contract reaches the agreed quantity, the contract is done.
  IF v_contract_id IS NOT NULL THEN
    SELECT agreed_quantity INTO v_agreed_quantity FROM contract.contract WHERE contract_id = v_contract_id;

    SELECT COALESCE(SUM(gr.accepted_quantity), 0) INTO v_total_accepted_paid
      FROM procurement.goods_receipt gr
      JOIN procurement.purchase_order po ON po.po_id = gr.po_id
      JOIN procurement.invoice inv ON inv.po_id = po.po_id
     WHERE po.contract_id = v_contract_id AND inv.status = 'paid';

    IF v_agreed_quantity IS NOT NULL AND v_total_accepted_paid >= v_agreed_quantity THEN
      UPDATE contract.contract SET status = 'completed' WHERE contract_id = v_contract_id AND status = 'active';
    END IF;
  END IF;

  RETURN v_entry_id;
END;
$$;

-- 5. Revenue share: compute the plan from real produce.delivery rows.
CREATE OR REPLACE FUNCTION procurement.create_revenue_share_plan(p_invoice_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_invoice_status TEXT;
  v_amount NUMERIC(18,2);
  v_po_id UUID;
  v_contract_id UUID;
  v_lot_id UUID;
  v_coop_org_id UUID;
  v_plan_id UUID;
  v_total_qty NUMERIC(14,3);
BEGIN
  SELECT status, amount, po_id INTO v_invoice_status, v_amount, v_po_id
    FROM procurement.invoice WHERE invoice_id = p_invoice_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบใบแจ้งหนี้ %', p_invoice_id;
  END IF;
  IF v_invoice_status <> 'paid' THEN
    RAISE EXCEPTION 'ใบแจ้งหนี้ % ต้องชำระแล้ว (paid) ก่อนจึงจะสร้างแผนกระจายรายได้ได้', p_invoice_id;
  END IF;
  IF EXISTS (SELECT 1 FROM procurement.revenue_share_plan WHERE invoice_id = p_invoice_id) THEN
    RAISE EXCEPTION 'มีแผนกระจายรายได้สำหรับใบแจ้งหนี้นี้อยู่แล้ว';
  END IF;

  SELECT contract_id INTO v_contract_id FROM procurement.purchase_order WHERE po_id = v_po_id;

  -- lot_id lives on the WINNING quote/bid (the seller's own offer), not on
  -- the RFQ — see design note 8 at the top of this file. Check both award
  -- paths: a direct-quote award always leaves rfq.awarded_quote_id set
  -- (see awardRfqToResponder in procurement.js, which upserts a
  -- rfq_quote row for BOTH the direct-quote and the auction-close path),
  -- so a single join through rfq_quote covers both.
  SELECT rq.lot_id INTO v_lot_id
    FROM procurement.rfq r
    JOIN procurement.rfq_quote rq ON rq.quote_id = r.awarded_quote_id
   WHERE r.contract_id = v_contract_id;

  IF v_lot_id IS NULL THEN
    RAISE EXCEPTION 'ใบเสนอราคา/ราคาประมูลที่ชนะไม่ได้ผูกกับล็อตผลผลิต (lot_id) — ไม่สามารถคำนวณสัดส่วนกระจายรายได้ได้';
  END IF;

  SELECT cp.party_id INTO v_coop_org_id
    FROM contract.contract_party cp
   WHERE cp.contract_id = v_contract_id AND cp.party_type = 'organization' AND cp.party_role NOT IN ('farmer', 'buyer')
   LIMIT 1;

  IF v_coop_org_id IS NULL THEN
    RAISE EXCEPTION 'ไม่พบองค์กรผู้ขาย (สหกรณ์) ของสัญญา %', v_contract_id;
  END IF;

  SELECT COALESCE(SUM(quantity_ton), 0) INTO v_total_qty
    FROM produce.delivery WHERE lot_id = v_lot_id AND status = 'settled';

  IF v_total_qty <= 0 THEN
    RAISE EXCEPTION 'ล็อต % ไม่มีการส่งมอบที่ settled แล้ว ไม่สามารถคำนวณสัดส่วนได้', v_lot_id;
  END IF;

  INSERT INTO procurement.revenue_share_plan (invoice_id, lot_id, coop_org_id, total_amount)
  VALUES (p_invoice_id, v_lot_id, v_coop_org_id, v_amount)
  RETURNING plan_id INTO v_plan_id;

  INSERT INTO procurement.revenue_share_line (plan_id, unit_id, farmer_id, contributed_quantity_ton, share_percent, amount)
  SELECT v_plan_id, d.unit_id, pu.owner_farmer_id,
         SUM(d.quantity_ton),
         ROUND(SUM(d.quantity_ton) / v_total_qty * 100, 3),
         ROUND(SUM(d.quantity_ton) / v_total_qty * v_amount, 2)
    FROM produce.delivery d
    JOIN registry.production_unit pu ON pu.unit_id = d.unit_id
   WHERE d.lot_id = v_lot_id AND d.status = 'settled'
   GROUP BY d.unit_id, pu.owner_farmer_id;

  RETURN v_plan_id;
END;
$$;

-- 6. Revenue share: actually move the money, one farmer at a time,
--    isolated per-line failures (see design note 10 above).
CREATE OR REPLACE FUNCTION procurement.distribute_revenue_share(p_plan_id uuid)
RETURNS TABLE(line_id uuid, status text, transfer_entry_id uuid, failure_reason text)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_plan_status TEXT;
  v_coop_org_id UUID;
  v_coop_account_id UUID;
  v_line RECORD;
  v_unit_account_id UUID;
  v_entry_id UUID;
BEGIN
  -- Bare `status` is ambiguous here — this function's RETURNS TABLE(...,
  -- status text, ...) implicitly declares `status` as an OUT parameter/
  -- PL/pgSQL variable in scope for the whole function body, colliding
  -- with revenue_share_plan.status and revenue_share_line.status below.
  -- Table-qualify every reference to that column throughout this
  -- function rather than relying on unqualified names.
  SELECT revenue_share_plan.status, coop_org_id INTO v_plan_status, v_coop_org_id
    FROM procurement.revenue_share_plan WHERE plan_id = p_plan_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบแผนกระจายรายได้ %', p_plan_id;
  END IF;
  IF v_plan_status = 'distributed' THEN
    RAISE EXCEPTION 'แผนกระจายรายได้ % ถูกดำเนินการไปแล้ว', p_plan_id;
  END IF;

  SELECT settlement_account_id INTO v_coop_account_id FROM partner.vendor_profile WHERE org_id = v_coop_org_id;
  IF v_coop_account_id IS NULL THEN
    RAISE EXCEPTION 'สหกรณ์ % ยังไม่มีบัญชี vendor_settlement', v_coop_org_id;
  END IF;

  FOR v_line IN SELECT * FROM procurement.revenue_share_line WHERE plan_id = p_plan_id AND revenue_share_line.status = 'pending' FOR UPDATE LOOP
    BEGIN
      SELECT account_id INTO v_unit_account_id FROM ledger.account
       WHERE account_type = 'unit_wallet' AND owner_id = v_line.unit_id;

      IF v_unit_account_id IS NULL THEN
        RAISE EXCEPTION 'หน่วยผลิต % ยังไม่มีกระเป๋าเงิน (unit_wallet)', v_line.unit_id;
      END IF;

      v_entry_id := ledger.transfer_funds(
        p_from_account   := v_coop_account_id,
        p_to_account     := v_unit_account_id,
        p_amount         := v_line.amount,
        p_entry_type     := 'Settlement',
        p_description    := 'กระจายรายได้จากการขายล็อตผลผลิต แผน ' || p_plan_id::text,
        p_reference_type := 'revenue_share_line',
        p_reference_id   := v_line.line_id
      );

      UPDATE procurement.revenue_share_line
         SET status = 'paid', transfer_entry_id = v_entry_id, failure_reason = NULL
       WHERE revenue_share_line.line_id = v_line.line_id;
    EXCEPTION WHEN OTHERS THEN
      UPDATE procurement.revenue_share_line
         SET status = 'failed', failure_reason = SQLERRM
       WHERE revenue_share_line.line_id = v_line.line_id;
    END;
  END LOOP;

  UPDATE procurement.revenue_share_plan
     SET status = 'distributed', distributed_at = now()
   WHERE plan_id = p_plan_id;

  RETURN QUERY
    SELECT rsl.line_id, rsl.status, rsl.transfer_entry_id, rsl.failure_reason
      FROM procurement.revenue_share_line rsl WHERE rsl.plan_id = p_plan_id;
END;
$$;

-- Grants — same convention as grant_b2b_commerce_engine.sql.
GRANT SELECT, INSERT ON procurement.goods_receipt TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON procurement.invoice TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON procurement.revenue_share_plan TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON procurement.revenue_share_line TO agrolink_app;
GRANT EXECUTE ON FUNCTION procurement.pay_invoice(uuid, text, uuid, uuid) TO agrolink_app;
GRANT EXECUTE ON FUNCTION procurement.create_revenue_share_plan(uuid) TO agrolink_app;
GRANT EXECUTE ON FUNCTION procurement.distribute_revenue_share(uuid) TO agrolink_app;
