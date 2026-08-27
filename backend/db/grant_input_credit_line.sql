-- AgroLink Platform — Input-Supplier Trade Credit (เครดิตร้านค้าปัจจัยการผลิต)
--
-- Feature request (2026-08-27): let an input supplier effectively sell "on
-- credit" to a farmer by having a THIRD PARTY — a Lender the farmer already
-- has a pre-approved revolving credit line with — pay the supplier on the
-- farmer's behalf (minus a platform fee) the moment the supplier confirms
-- the order. The farmer then repays the LENDER later, with interest
-- computed only on the amount actually drawn and only for the days it was
-- actually outstanding — cheaper for the farmer than taking out a lump-sum
-- loan for the same purchase, because interest never accrues on unused
-- headroom or on days before the purchase happened.
--
-- Business terms confirmed with the product owner before writing this:
--   - Interest: flat rate PER DAY the drawdown is outstanding (simple,
--     non-compounding), stored in basis points/day on the credit line —
--     same bps convention underwriting.loan_policy already uses for its
--     (never actually applied — see note below) interest_rate_bps column.
--   - A lender may only fund a purchase for a farmer it has ALREADY
--     extended a standing, pre-approved revolving credit line to
--     (credit.credit_line, status='active') — there is no "any lender can
--     fund any invoice on the spot" path. Issuing that credit line is a
--     lender-initiated decision (POST /lender/credit-lines), not an
--     auto-underwritten application — see design note below on why this
--     does NOT reuse underwriting.loan_application/evaluate_application.
--   - Platform fee: a flat percentage of the amount funded, deducted from
--     what the SUPPLIER receives (the farmer still owes the full purchase
--     price to the lender) — the same "merchant discount rate" shape credit
--     card acquiring uses, not an add-on charged to the farmer.
--   - Scope: covers BOTH the heavier RFQ/invoice B2B pipeline (not wired up
--     in this pass — see credit_drawdown.invoice_id below, deliberately
--     left as documented future widening) AND, per explicit product
--     decision, the everyday one-at-a-time catalog ordering flow
--     (marketplace.product_order) that farmers actually use most — which
--     had ZERO payment step of any kind before this migration (confirmed by
--     reading grant_ledger_revenue_segregation.sql's own audit comment: "no
--     payment step of any kind in POST /inputsupplier/orders/:id/fulfill").
--     Orders NOT paid via a credit line are UNCHANGED — they keep
--     settling payment offline exactly as before; `payment_status` merely
--     distinguishes the two, it does not force every order through the
--     ledger.
--
-- IMPORTANT PRE-EXISTING GAP this migration does NOT fix (discovered while
-- researching this feature, flagging honestly rather than silently working
-- around it): `credit.repay_loan()` — the ORIGINAL farmer-loan repayment
-- function — has never been wired to any API route in this codebase; a
-- farmer cannot repay an ordinary loan through the app today. This
-- migration's own `credit.repay_drawdown()` below is a NEW, separate
-- function with a real route (see src/routes/farmer.js) — it does not
-- retroactively fix loan repayment, which remains a known gap outside this
-- feature's scope.
--
-- Why a NEW parallel application/approval path instead of reusing
-- underwriting.loan_application: that machinery is shaped for a ONE-TIME
-- lump-sum disbursement (evaluate_application → single principal_amount →
-- escrow → single payout), auto-scored against underwriting.loan_policy per
-- risk tier. A revolving credit LINE is a standing facility a lender grants
-- once and then funds many small purchases against over time — reusing the
-- one-shot machinery would mean bolting a fundamentally different repayment
-- shape onto it. Instead this migration adds a deliberately SIMPLER,
-- lender-initiated grant (credit.issue_credit_line) that still reuses the
-- SAME risk-tier gate (`risk.v_farmer_latest_score`, refusing tier 'D' —
-- identical business rule to underwriting.evaluate_application) so lending
-- policy stays consistent across both paths without duplicating the actual
-- underwriting engine.
--
-- Why credit_drawdown repayment requires paying the FULL outstanding
-- balance in one transaction (principal + interest accrued to date), not
-- partial/amortized repayment: computing interest correctly against a
-- partially-repaid principal balance over multiple repayments needs a real
-- amortization schedule, which nothing else in this codebase has ever
-- built (credit.repay_loan doesn't do it either — it just accumulates
-- payments until they cross principal_amount, with no interest math at
-- all). Full-payoff-only is an honest, explicit simplification for this
-- first release rather than a half-built partial-interest calculation.
-- ============================================================================

-- ============================================================
-- 1. Widen contract_type to add 'credit_line_agreement' — additive only,
--    same convention as every prior widening in this codebase (input_supply_
--    agreement, seller party_role, etc). No principal_amount is required
--    for this type (chk_loan_has_principal only fires for 'loan_agreement')
--    — a credit LINE's limit lives on credit.credit_line, not the contract.
-- ============================================================
ALTER TABLE contract.contract DROP CONSTRAINT contract_contract_type_check;
ALTER TABLE contract.contract ADD CONSTRAINT contract_contract_type_check
  CHECK (contract_type IN ('loan_agreement', 'forward_purchase', 'service_agreement', 'input_supply_agreement', 'credit_line_agreement'));

-- ============================================================
-- 2. credit.credit_line — the standing, pre-approved revolving facility.
-- ============================================================
CREATE TABLE IF NOT EXISTS credit.credit_line (
  credit_line_id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id             uuid NOT NULL REFERENCES contract.contract(contract_id),
  farmer_id               uuid NOT NULL REFERENCES identity.farmer(farmer_id),
  lender_org_id           uuid NOT NULL REFERENCES identity.organization(org_id),
  credit_limit            numeric(18,2) NOT NULL,
  interest_rate_daily_bps integer NOT NULL,
  tenor_days              integer NOT NULL DEFAULT 30,
  status                  text NOT NULL DEFAULT 'active',
  created_at              timestamptz NOT NULL DEFAULT now(),
  closed_at               timestamptz,
  CONSTRAINT credit_line_credit_limit_check CHECK (credit_limit > 0),
  CONSTRAINT credit_line_interest_rate_check CHECK (interest_rate_daily_bps >= 0),
  CONSTRAINT credit_line_tenor_days_check CHECK (tenor_days > 0),
  CONSTRAINT credit_line_status_check CHECK (status IN ('active', 'suspended', 'closed'))
);
CREATE INDEX IF NOT EXISTS idx_credit_line_farmer ON credit.credit_line (farmer_id);
CREATE INDEX IF NOT EXISTS idx_credit_line_lender ON credit.credit_line (lender_org_id);
-- One ACTIVE line per (farmer, lender) pair — a lender tops up an existing
-- line's credit_limit rather than issuing a second overlapping one; enforced
-- as a partial unique index (same technique 04_reference_data.sql-era
-- migrations use elsewhere) rather than a plain UNIQUE, since a farmer can
-- still have a new active line with a DIFFERENT lender, or a new one with
-- the SAME lender once the old one is 'closed'.
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_line_active_pair
  ON credit.credit_line (farmer_id, lender_org_id) WHERE status = 'active';

COMMENT ON TABLE credit.credit_line IS 'วงเงินสินเชื่อหมุนเวียนที่ผู้ให้กู้อนุมัติล่วงหน้าให้เกษตรกรรายหนึ่ง ใช้เบิกเป็นงวดๆ ต่อการซื้อปัจจัยการผลิตแต่ละครั้ง (ดู credit.credit_drawdown) ไม่ใช่การจ่ายเงินก้อนเดียวแบบ underwriting.loan_application';

-- ============================================================
-- 3. credit.credit_drawdown — one row per purchase funded against a line.
-- ============================================================
CREATE TABLE IF NOT EXISTS credit.credit_drawdown (
  drawdown_id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  credit_line_id          uuid NOT NULL REFERENCES credit.credit_line(credit_line_id),
  order_id                uuid REFERENCES marketplace.product_order(order_id),
  -- Wiring the heavier RFQ/invoice B2B pipeline (procurement.invoice) up to
  -- this same drawdown mechanism is a documented future widening, not built
  -- in this pass — see the file header. The column exists now so that
  -- future work never has to migrate existing drawdown rows.
  invoice_id              uuid REFERENCES procurement.invoice(invoice_id),
  principal_amount        numeric(18,2) NOT NULL,
  platform_fee_amount     numeric(18,2) NOT NULL,
  net_amount_to_supplier  numeric(18,2) NOT NULL,
  interest_rate_daily_bps integer NOT NULL,
  drawn_at                timestamptz NOT NULL DEFAULT now(),
  due_date                date NOT NULL,
  status                  text NOT NULL DEFAULT 'outstanding',
  repaid_amount           numeric(18,2),
  repaid_at               timestamptz,
  fund_entry_id           uuid REFERENCES ledger.journal_entry(entry_id),
  fee_entry_id            uuid REFERENCES ledger.journal_entry(entry_id),
  CONSTRAINT credit_drawdown_one_source_check CHECK (
    (order_id IS NOT NULL AND invoice_id IS NULL) OR (order_id IS NULL AND invoice_id IS NOT NULL)
  ),
  CONSTRAINT credit_drawdown_principal_check CHECK (principal_amount > 0),
  CONSTRAINT credit_drawdown_fee_check CHECK (platform_fee_amount >= 0 AND platform_fee_amount < principal_amount),
  CONSTRAINT credit_drawdown_net_check CHECK (net_amount_to_supplier > 0),
  CONSTRAINT credit_drawdown_status_check CHECK (status IN ('outstanding', 'repaid'))
);
CREATE INDEX IF NOT EXISTS idx_credit_drawdown_line ON credit.credit_drawdown (credit_line_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_drawdown_order ON credit.credit_drawdown (order_id) WHERE order_id IS NOT NULL;

COMMENT ON TABLE credit.credit_drawdown IS 'เบิกใช้วงเงินเครดิตหนึ่งครั้งต่อการซื้อหนึ่งออเดอร์ — ผู้ให้กู้จ่ายเงินสุทธิ (หักค่าธรรมเนียมแพลตฟอร์ม) ให้ผู้ขายทันทีที่เบิก เกษตรกรติดหนี้ผู้ให้กู้เต็มจำนวน principal_amount บวกดอกเบี้ยที่คำนวณตอนชำระคืน';

-- ============================================================
-- 4. credit.credit_line_repayment — full-payoff repayment record, one row
--    per drawdown once repaid (see file header on why partial/amortized
--    repayment is out of scope for this pass).
-- ============================================================
CREATE TABLE IF NOT EXISTS credit.credit_line_repayment (
  repayment_id       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  drawdown_id        uuid NOT NULL UNIQUE REFERENCES credit.credit_drawdown(drawdown_id),
  principal_portion  numeric(18,2) NOT NULL,
  interest_portion   numeric(18,2) NOT NULL,
  amount             numeric(18,2) NOT NULL,
  days_outstanding   integer NOT NULL,
  paid_date          date NOT NULL DEFAULT CURRENT_DATE,
  status             text NOT NULL,
  settlement_entry_id uuid NOT NULL REFERENCES ledger.journal_entry(entry_id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_line_repayment_amount_check CHECK (amount > 0),
  CONSTRAINT credit_line_repayment_status_check CHECK (status IN ('paid_on_time', 'paid_late'))
);

COMMENT ON TABLE credit.credit_line_repayment IS 'บันทึกการชำระคืนยอดเบิกครบตามจำนวน (เงินต้น+ดอกเบี้ยสะสมถึงวันที่ชำระ) — เทียบเท่า credit.loan_repayment ของสินเชื่อก้อนเดียว แต่คำนวณดอกเบี้ยจากจำนวนวันที่ค้างจริงต่อยอดเบิกแต่ละครั้ง';

-- ============================================================
-- 5. marketplace.product_order gets a payment_status column — additive,
--    defaults to 'unpaid' so every existing/未来 offline-settled order is
--    completely unaffected. Only an order actually funded through a credit
--    line ever becomes 'paid_via_credit_line'.
-- ============================================================
ALTER TABLE marketplace.product_order ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unpaid';
ALTER TABLE marketplace.product_order ADD CONSTRAINT product_order_payment_status_check
  CHECK (payment_status IN ('unpaid', 'paid_via_credit_line'));

COMMENT ON COLUMN marketplace.product_order.payment_status IS 'unpaid = ชำระเงินกันเองนอกระบบตามเดิม (ค่าเริ่มต้น ไม่กระทบออเดอร์เก่า/ใหม่ที่ไม่ใช้เครดิต) — paid_via_credit_line = ผู้ให้กู้จ่ายเงินให้ผู้ขายแทนแล้วผ่าน credit.draw_credit_for_order()';

-- ============================================================
-- 6. credit.issue_credit_line() — lender-initiated grant of a new standing
--    line. Same risk-tier gate as underwriting.evaluate_application (refuse
--    tier D) but otherwise a direct decision, not an auto-scored
--    application — see file header for why.
-- ============================================================
CREATE OR REPLACE FUNCTION credit.issue_credit_line(
  p_farmer_id uuid,
  p_lender_org_id uuid,
  p_credit_limit numeric,
  p_interest_rate_daily_bps integer,
  p_tenor_days integer DEFAULT 30
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_org_type TEXT;
  v_commercial_status TEXT;
  v_risk_tier TEXT;
  v_contract_id UUID;
  v_credit_line_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM identity.farmer WHERE farmer_id = p_farmer_id) THEN
    RAISE EXCEPTION 'ไม่พบเกษตรกร %', p_farmer_id;
  END IF;
  IF p_credit_limit IS NULL OR p_credit_limit <= 0 THEN
    RAISE EXCEPTION 'วงเงินเครดิตต้องมากกว่า 0';
  END IF;

  SELECT o.org_type, vp.commercial_status INTO v_org_type, v_commercial_status
    FROM identity.organization o
    JOIN partner.vendor_profile vp ON vp.org_id = o.org_id
   WHERE o.org_id = p_lender_org_id;

  IF v_org_type IS NULL THEN
    RAISE EXCEPTION 'ไม่พบผู้ให้สินเชื่อรหัส % ในระบบคู่ค้า', p_lender_org_id;
  ELSIF v_org_type <> 'Lender' THEN
    RAISE EXCEPTION 'องค์กร % ไม่ใช่ประเภทผู้ให้สินเชื่อ (Lender)', p_lender_org_id;
  ELSIF v_commercial_status <> 'active' THEN
    RAISE EXCEPTION 'ผู้ให้สินเชื่อ % ยังไม่ได้เปิดใช้งานเชิงพาณิชย์ (สถานะ %)', p_lender_org_id, v_commercial_status;
  END IF;

  SELECT risk_tier INTO v_risk_tier FROM risk.v_farmer_latest_score WHERE farmer_id = p_farmer_id;
  IF v_risk_tier IS NULL THEN
    RAISE EXCEPTION 'เกษตรกร % ยังไม่มีคะแนนความน่าเชื่อถือในระบบ ต้องเรียก risk.compute_credit_score() ก่อน', p_farmer_id;
  ELSIF v_risk_tier = 'D' THEN
    RAISE EXCEPTION 'ระดับความเสี่ยงของเกษตรกร % สูงเกินกว่าจะอนุมัติวงเงินเครดิตได้ (risk_tier D)', p_farmer_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM credit.credit_line WHERE farmer_id = p_farmer_id AND lender_org_id = p_lender_org_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'เกษตรกร % มีวงเงินเครดิตที่ยัง active กับผู้ให้กู้รายนี้อยู่แล้ว ต้องปิดวงเงินเดิมก่อนจึงจะออกใหม่ได้', p_farmer_id;
  END IF;

  INSERT INTO contract.contract (contract_type, status, currency, effective_date, terms_summary)
  VALUES ('credit_line_agreement', 'active', 'THB', CURRENT_DATE,
          'วงเงินสินเชื่อหมุนเวียนสำหรับซื้อปัจจัยการผลิต วงเงิน ' || p_credit_limit || ' บาท')
  RETURNING contract_id INTO v_contract_id;

  INSERT INTO contract.contract_party (contract_id, party_role, party_type, party_id) VALUES
    (v_contract_id, 'farmer', 'farmer', p_farmer_id),
    (v_contract_id, 'lender', 'organization', p_lender_org_id);

  INSERT INTO credit.credit_line (contract_id, farmer_id, lender_org_id, credit_limit, interest_rate_daily_bps, tenor_days)
  VALUES (v_contract_id, p_farmer_id, p_lender_org_id, p_credit_limit, COALESCE(p_interest_rate_daily_bps, 0), COALESCE(p_tenor_days, 30))
  RETURNING credit_line_id INTO v_credit_line_id;

  RETURN v_credit_line_id;
END;
$$;

-- ============================================================
-- 7. credit.draw_credit_for_order() — pay the supplier NOW (net of platform
--    fee) out of the lender's own lender_clearing account, tag the order as
--    paid, and open an outstanding drawdown the farmer owes the lender.
-- ============================================================
CREATE OR REPLACE FUNCTION credit.draw_credit_for_order(
  p_order_id uuid,
  p_credit_line_id uuid,
  p_platform_fee_percent numeric
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_order marketplace.product_order%ROWTYPE;
  v_line credit.credit_line%ROWTYPE;
  v_outstanding_total NUMERIC(18,2);
  v_fee_amount NUMERIC(18,2);
  v_net_amount NUMERIC(18,2);
  v_lender_account_id UUID;
  v_supplier_account_id UUID;
  v_fee_account_id UUID;
  v_fund_entry_id UUID;
  v_fee_entry_id UUID;
  v_drawdown_id UUID;
BEGIN
  SELECT * INTO v_order FROM marketplace.product_order WHERE order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบออเดอร์ %', p_order_id;
  END IF;
  IF v_order.payment_status <> 'unpaid' THEN
    RAISE EXCEPTION 'ออเดอร์ % ถูกชำระเงินไปแล้ว (สถานะ %)', p_order_id, v_order.payment_status;
  END IF;
  IF v_order.status NOT IN ('confirmed', 'fulfilled') THEN
    RAISE EXCEPTION 'ออเดอร์ % ต้องได้รับการยืนยันจากผู้ขายก่อน (สถานะปัจจุบัน %) จึงจะใช้วงเงินเครดิตจ่ายแทนได้', p_order_id, v_order.status;
  END IF;

  SELECT * INTO v_line FROM credit.credit_line WHERE credit_line_id = p_credit_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบวงเงินเครดิต %', p_credit_line_id;
  END IF;
  IF v_line.farmer_id <> v_order.farmer_id THEN
    RAISE EXCEPTION 'วงเงินเครดิต % ไม่ใช่ของเกษตรกรเจ้าของออเดอร์นี้', p_credit_line_id;
  END IF;
  IF v_line.status <> 'active' THEN
    RAISE EXCEPTION 'วงเงินเครดิต % อยู่ในสถานะ % ไม่สามารถเบิกใช้ได้', p_credit_line_id, v_line.status;
  END IF;

  SELECT COALESCE(SUM(principal_amount), 0) INTO v_outstanding_total
    FROM credit.credit_drawdown WHERE credit_line_id = p_credit_line_id AND status = 'outstanding';

  IF v_outstanding_total + v_order.total_price > v_line.credit_limit THEN
    RAISE EXCEPTION 'วงเงินไม่พอ: ใช้ไปแล้ว % จากวงเงิน % บาท เหลือ % บาท แต่ออเดอร์นี้ต้องการ % บาท',
      v_outstanding_total, v_line.credit_limit, v_line.credit_limit - v_outstanding_total, v_order.total_price;
  END IF;

  v_fee_amount := ROUND(v_order.total_price * COALESCE(p_platform_fee_percent, 0) / 100.0, 2);
  v_net_amount := v_order.total_price - v_fee_amount;
  IF v_net_amount <= 0 THEN
    RAISE EXCEPTION 'ค่าธรรมเนียมแพลตฟอร์มสูงเกินไป (คำนวณแล้วยอดสุทธิให้ผู้ขาย <= 0)';
  END IF;

  SELECT lender_clearing_account_id INTO v_lender_account_id FROM partner.vendor_profile WHERE org_id = v_line.lender_org_id;
  IF v_lender_account_id IS NULL THEN
    RAISE EXCEPTION 'ผู้ให้กู้ % ยังไม่มีบัญชี lender_clearing', v_line.lender_org_id;
  END IF;

  SELECT settlement_account_id INTO v_supplier_account_id FROM partner.vendor_profile WHERE org_id = v_order.org_id;
  IF v_supplier_account_id IS NULL THEN
    RAISE EXCEPTION 'ผู้ขาย % ยังไม่มีบัญชี vendor_settlement', v_order.org_id;
  END IF;

  SELECT account_id INTO v_fee_account_id FROM ledger.account WHERE account_type = 'fee_revenue' AND owner_type = 'platform' LIMIT 1;
  IF v_fee_account_id IS NULL THEN
    RAISE EXCEPTION 'ยังไม่มีบัญชี fee_revenue ของแพลตฟอร์มในระบบ (ต้องสร้างก่อนใช้งานฟีเจอร์นี้)';
  END IF;

  v_fund_entry_id := ledger.transfer_funds(
    p_from_account   := v_lender_account_id,
    p_to_account     := v_supplier_account_id,
    p_amount         := v_net_amount,
    p_entry_type     := 'CreditLineDrawdown',
    p_description    := 'จ่ายเงินแทนเกษตรกรผ่านวงเงินเครดิต สำหรับออเดอร์ ' || p_order_id::text,
    p_reference_type := 'product_order',
    p_reference_id   := p_order_id
  );

  IF v_fee_amount > 0 THEN
    v_fee_entry_id := ledger.transfer_funds(
      p_from_account   := v_lender_account_id,
      p_to_account     := v_fee_account_id,
      p_amount         := v_fee_amount,
      p_entry_type     := 'CreditLineFee',
      p_description    := 'ค่าธรรมเนียมแพลตฟอร์มจากการเบิกวงเงินเครดิต สำหรับออเดอร์ ' || p_order_id::text,
      p_reference_type := 'product_order',
      p_reference_id   := p_order_id
    );
  END IF;

  INSERT INTO credit.credit_drawdown
    (credit_line_id, order_id, principal_amount, platform_fee_amount, net_amount_to_supplier,
     interest_rate_daily_bps, due_date, fund_entry_id, fee_entry_id)
  VALUES
    (p_credit_line_id, p_order_id, v_order.total_price, v_fee_amount, v_net_amount,
     v_line.interest_rate_daily_bps, CURRENT_DATE + v_line.tenor_days, v_fund_entry_id, v_fee_entry_id)
  RETURNING drawdown_id INTO v_drawdown_id;

  UPDATE marketplace.product_order SET payment_status = 'paid_via_credit_line', updated_at = now() WHERE order_id = p_order_id;

  RETURN v_drawdown_id;
END;
$$;

-- ============================================================
-- 8. credit.repay_drawdown() — full payoff only (principal + interest
--    accrued to CURRENT_DATE), farmer's unit_wallet -> lender_clearing.
-- ============================================================
CREATE OR REPLACE FUNCTION credit.repay_drawdown(
  p_drawdown_id uuid,
  p_payer_unit_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_drawdown credit.credit_drawdown%ROWTYPE;
  v_line credit.credit_line%ROWTYPE;
  v_days_outstanding INT;
  v_interest NUMERIC(18,2);
  v_total_due NUMERIC(18,2);
  v_payer_account_id UUID;
  v_lender_account_id UUID;
  v_entry_id UUID;
  v_status_computed TEXT;
  v_repayment_id UUID;
BEGIN
  SELECT * INTO v_drawdown FROM credit.credit_drawdown WHERE drawdown_id = p_drawdown_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบรายการเบิกวงเงิน %', p_drawdown_id;
  END IF;
  IF v_drawdown.status <> 'outstanding' THEN
    RAISE EXCEPTION 'รายการเบิกวงเงิน % ถูกชำระคืนไปแล้ว', p_drawdown_id;
  END IF;

  SELECT * INTO v_line FROM credit.credit_line WHERE credit_line_id = v_drawdown.credit_line_id;

  IF NOT EXISTS (
    SELECT 1 FROM registry.production_unit WHERE unit_id = p_payer_unit_id AND owner_farmer_id = v_line.farmer_id
  ) THEN
    RAISE EXCEPTION 'หน่วยผลิต % ไม่ใช่ของเกษตรกรเจ้าของวงเงินเครดิตนี้', p_payer_unit_id;
  END IF;

  v_days_outstanding := GREATEST(0, (CURRENT_DATE - v_drawdown.drawn_at::date));
  v_interest := ROUND(v_drawdown.principal_amount * (v_drawdown.interest_rate_daily_bps / 10000.0) * v_days_outstanding, 2);
  v_total_due := v_drawdown.principal_amount + v_interest;

  SELECT account_id INTO v_payer_account_id FROM ledger.account WHERE account_type = 'unit_wallet' AND owner_id = p_payer_unit_id;
  IF v_payer_account_id IS NULL THEN
    RAISE EXCEPTION 'หน่วยผลิต % ยังไม่มีกระเป๋าเงิน (unit_wallet)', p_payer_unit_id;
  END IF;

  SELECT lender_clearing_account_id INTO v_lender_account_id FROM partner.vendor_profile WHERE org_id = v_line.lender_org_id;
  IF v_lender_account_id IS NULL THEN
    RAISE EXCEPTION 'ผู้ให้กู้ % ยังไม่มีบัญชี lender_clearing', v_line.lender_org_id;
  END IF;

  v_entry_id := ledger.transfer_funds(
    p_from_account   := v_payer_account_id,
    p_to_account     := v_lender_account_id,
    p_amount         := v_total_due,
    p_entry_type     := 'CreditLineRepayment',
    p_description    := 'ชำระคืนยอดเบิกวงเงินเครดิต ' || p_drawdown_id::text,
    p_reference_type := 'credit_drawdown',
    p_reference_id   := p_drawdown_id
  );

  v_status_computed := CASE WHEN CURRENT_DATE <= v_drawdown.due_date THEN 'paid_on_time' ELSE 'paid_late' END;

  INSERT INTO credit.credit_line_repayment
    (drawdown_id, principal_portion, interest_portion, amount, days_outstanding, status, settlement_entry_id)
  VALUES
    (p_drawdown_id, v_drawdown.principal_amount, v_interest, v_total_due, v_days_outstanding, v_status_computed, v_entry_id)
  RETURNING repayment_id INTO v_repayment_id;

  UPDATE credit.credit_drawdown
     SET status = 'repaid', repaid_amount = v_total_due, repaid_at = now()
   WHERE drawdown_id = p_drawdown_id;

  RETURN v_repayment_id;
END;
$$;

COMMENT ON FUNCTION credit.repay_drawdown(uuid, uuid) IS 'ชำระคืนยอดเบิกเต็มจำนวน (เงินต้น + ดอกเบี้ยที่คำนวณจากจำนวนวันที่ค้างจริง ณ วันที่ชำระ) ในครั้งเดียว — ไม่รองรับการผ่อนชำระบางส่วนในเวอร์ชันนี้ (ดูคอมเมนต์หัวไฟล์)';

-- ============================================================
-- Grants — same "no RLS, explicit WHERE/ownership-check IS the security
-- boundary, enforced in the SECURITY DEFINER functions above" convention as
-- every other credit/procurement table in this project.
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON credit.credit_line TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON credit.credit_drawdown TO agrolink_app;
GRANT SELECT, INSERT ON credit.credit_line_repayment TO agrolink_app;
GRANT EXECUTE ON FUNCTION credit.issue_credit_line(uuid, uuid, numeric, integer, integer) TO agrolink_app;
GRANT EXECUTE ON FUNCTION credit.draw_credit_for_order(uuid, uuid, numeric) TO agrolink_app;
GRANT EXECUTE ON FUNCTION credit.repay_drawdown(uuid, uuid) TO agrolink_app;

-- ============================================================
-- Verification notes (run manually, not part of this script):
--   \d credit.credit_line
--   \d credit.credit_drawdown
--   \d credit.credit_line_repayment
--   \d marketplace.product_order   -- confirm payment_status column present
--   \df credit.issue_credit_line
--   \df credit.draw_credit_for_order
--   \df credit.repay_drawdown
-- ============================================================
