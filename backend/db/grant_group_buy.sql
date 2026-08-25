-- ============================================================
-- Group Buy (รวมออเดอร์ประมูลร่วมของสหกรณ์) — M-GroupBuy
-- ============================================================
-- เพิ่ม "ชั้นรวบรวมออเดอร์" ไว้หน้าเส้นทาง RFQ→e-Auction→Contract→PO→GRN→
-- Invoice→Payment เดิมทั้งหมด (procurement.rfq / procurement.auction /
-- procurement.create_contract_from_award / ...) — ไม่แก้ไขโค้ด/ตารางเดิม
-- แม้แต่บรรทัดเดียว ดูเหตุผลและ flow เต็มใน GROUP_BUY_ARCHITECTURE.md
--
-- การตัดสินใจสำคัญที่ยืนยันกับผู้ใช้แล้ว (2026-08-25):
--   1. ผู้เปิดรอบ: สหกรณ์ที่ผ่าน KYB เปิดรอบเองได้อิสระ (ไม่ต้องขออนุมัติก่อน)
--   2. "สหกรณ์หัวขบวน": ทีมงาน AgroLink (platform ops) เป็นผู้เลือก/อนุมัติ
--      เป็นรายรอบตอนแปลงรอบเป็น RFQ+Auction — ไม่ใช้กติกาอัตโนมัติ (เช่น
--      เลือกจากปริมาณมากสุด) เพราะหัวขบวนต้องรับความเสี่ยงสภาพคล่อง/เครดิต
--   3. การส่งของจริง: ซัพพลายเออร์ส่งของไปที่จุดเดียว (สหกรณ์หัวขบวน) แล้ว
--      สหกรณ์อื่นมารับต่อเอง "นอกระบบ" ในรอบแรก — ไม่ขยาย Logistics module
--
-- ขอบเขต MVP (ดู GROUP_BUY_ARCHITECTURE.md ข้อ 7 สำหรับสิ่งที่ตั้งใจไม่ทำรอบนี้):
--   ไม่มีมัดจำ/บทลงโทษผิดนัด, ไม่มี Admin อนุมัติก่อนเปิดรอบ, ไม่รองรับส่งของ
--   หลายจุด — ทั้งหมดนี้เป็น "manual today" ตกลงกันเองนอกระบบไปก่อน

CREATE TABLE IF NOT EXISTS procurement.group_buy (
  group_buy_id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  initiator_org_id       uuid NOT NULL REFERENCES identity.organization(org_id),
  category               text NOT NULL,
  product_description    text NOT NULL,
  target_unit            text,
  min_total_qty          numeric(14,2),
  opens_at               timestamptz NOT NULL DEFAULT now(),
  closes_at              timestamptz NOT NULL,
  status                 text NOT NULL DEFAULT 'collecting',
  lead_org_id            uuid REFERENCES identity.organization(org_id),
  converted_rfq_id       uuid REFERENCES procurement.rfq(rfq_id),
  converted_by_subject_id uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- Same category domain as procurement.rfq.category — an auto-created RFQ
  -- from this round must satisfy rfq_category_check anyway, so there is no
  -- value in allowing a wider domain here.
  CONSTRAINT group_buy_category_check
    CHECK (category IN ('input_product', 'produce', 'processed_good', 'machinery_service', 'other')),
  CONSTRAINT group_buy_status_check
    CHECK (status IN ('collecting', 'converted', 'cancelled')),
  CONSTRAINT group_buy_product_description_check CHECK (length(trim(product_description)) > 0),
  CONSTRAINT group_buy_closes_after_opens CHECK (closes_at > opens_at),
  CONSTRAINT group_buy_min_total_qty_check CHECK (min_total_qty IS NULL OR min_total_qty > 0)
);
CREATE INDEX IF NOT EXISTS idx_group_buy_status ON procurement.group_buy (status, closes_at);
CREATE INDEX IF NOT EXISTS idx_group_buy_initiator ON procurement.group_buy (initiator_org_id);

CREATE TABLE IF NOT EXISTS procurement.group_buy_participant (
  participant_id  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_buy_id    uuid NOT NULL REFERENCES procurement.group_buy(group_buy_id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES identity.organization(org_id),
  requested_qty   numeric(14,2) NOT NULL,
  status          text NOT NULL DEFAULT 'joined',
  joined_at       timestamptz NOT NULL DEFAULT now(),
  withdrawn_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_buy_participant_status_check CHECK (status IN ('joined', 'withdrawn')),
  CONSTRAINT group_buy_participant_qty_check CHECK (requested_qty > 0),
  -- Upsert target: a coop already in the round updates its own qty via
  -- ON CONFLICT DO UPDATE (same idiom as procurement.rfq_quote's uq_rfq_
  -- quote_rfq_responder) rather than inserting duplicate rows.
  CONSTRAINT uq_group_buy_participant UNIQUE (group_buy_id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_group_buy_participant_org ON procurement.group_buy_participant (org_id);

-- Settlement plan/line — deliberately the SAME shape as procurement.
-- revenue_share_plan/revenue_share_line (grant_b2b_commerce_engine_phase3.
-- sql), just with the money direction reversed: revenue-share pays OUT from
-- a coop to its farmer members' unit_wallets; this pays IN from each
-- participating coop to the lead coop that fronted the supplier invoice.
CREATE TABLE IF NOT EXISTS procurement.group_buy_settlement_plan (
  plan_id        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_buy_id   uuid NOT NULL UNIQUE REFERENCES procurement.group_buy(group_buy_id),
  invoice_id     uuid NOT NULL REFERENCES procurement.invoice(invoice_id),
  lead_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  total_amount   numeric(18,2) NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  created_at     timestamptz NOT NULL DEFAULT now(),
  distributed_at timestamptz,
  CONSTRAINT group_buy_settlement_plan_status_check CHECK (status IN ('pending', 'distributed')),
  CONSTRAINT group_buy_settlement_plan_total_amount_check CHECK (total_amount > 0)
);

CREATE TABLE IF NOT EXISTS procurement.group_buy_settlement_line (
  line_id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  plan_id            uuid NOT NULL REFERENCES procurement.group_buy_settlement_plan(plan_id) ON DELETE CASCADE,
  participant_org_id uuid NOT NULL REFERENCES identity.organization(org_id),
  requested_qty      numeric(14,2) NOT NULL,
  share_percent      numeric(6,3) NOT NULL,
  amount             numeric(18,2) NOT NULL,
  status             text NOT NULL DEFAULT 'pending',
  transfer_entry_id  uuid REFERENCES ledger.journal_entry(entry_id),
  failure_reason     text,
  CONSTRAINT group_buy_settlement_line_status_check CHECK (status IN ('pending', 'paid', 'failed')),
  CONSTRAINT group_buy_settlement_line_amount_check CHECK (amount >= 0),
  CONSTRAINT uq_group_buy_settlement_line UNIQUE (plan_id, participant_org_id)
);
CREATE INDEX IF NOT EXISTS idx_group_buy_settlement_line_plan ON procurement.group_buy_settlement_line (plan_id);

-- ============================================================
-- Function: create the settlement plan once the lead org's invoice for the
-- converted RFQ has been paid. Finds the invoice by walking
-- group_buy.converted_rfq_id -> rfq.contract_id -> purchase_order (the PO
-- the lead org issued) -> invoice — same chain procurement.pay_invoice()
-- already validates a payer against, so no new authorization concept is
-- introduced here.
-- ============================================================
CREATE OR REPLACE FUNCTION procurement.create_group_buy_settlement_plan(p_group_buy_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_status TEXT;
  v_lead_org_id UUID;
  v_converted_rfq_id UUID;
  v_contract_id UUID;
  v_invoice_id UUID;
  v_amount NUMERIC(18,2);
  v_total_qty NUMERIC(14,2);
  v_plan_id UUID;
BEGIN
  SELECT status, lead_org_id, converted_rfq_id
    INTO v_status, v_lead_org_id, v_converted_rfq_id
    FROM procurement.group_buy WHERE group_buy_id = p_group_buy_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบรอบรวมออเดอร์ %', p_group_buy_id;
  END IF;
  IF v_status <> 'converted' OR v_lead_org_id IS NULL OR v_converted_rfq_id IS NULL THEN
    RAISE EXCEPTION 'รอบรวมออเดอร์ % ยังไม่ถูกแปลงเป็น RFQ/Auction', p_group_buy_id;
  END IF;
  IF EXISTS (SELECT 1 FROM procurement.group_buy_settlement_plan WHERE group_buy_id = p_group_buy_id) THEN
    RAISE EXCEPTION 'มีแผนแบ่งต้นทุนสำหรับรอบนี้อยู่แล้ว';
  END IF;

  SELECT contract_id INTO v_contract_id FROM procurement.rfq WHERE rfq_id = v_converted_rfq_id;
  IF v_contract_id IS NULL THEN
    RAISE EXCEPTION 'RFQ ของรอบนี้ยังไม่มีสัญญา (ยังไม่ปิดประมูล/ยังไม่มีผู้ชนะ)';
  END IF;

  SELECT inv.invoice_id, inv.amount INTO v_invoice_id, v_amount
    FROM procurement.purchase_order po
    JOIN procurement.invoice inv ON inv.po_id = po.po_id
   WHERE po.contract_id = v_contract_id AND inv.status = 'paid'
   ORDER BY inv.issued_at DESC LIMIT 1;

  IF v_invoice_id IS NULL THEN
    RAISE EXCEPTION 'ยังไม่มีใบแจ้งหนี้ที่ชำระแล้วสำหรับรอบนี้ — สหกรณ์หัวขบวนต้องออก PO/รับของ(GRN)/ชำระใบแจ้งหนี้ให้เสร็จก่อน';
  END IF;

  SELECT COALESCE(SUM(requested_qty), 0) INTO v_total_qty
    FROM procurement.group_buy_participant
   WHERE group_buy_id = p_group_buy_id AND status = 'joined';

  IF v_total_qty <= 0 THEN
    RAISE EXCEPTION 'ไม่มีผู้ร่วมรอบที่ยังคงสถานะเข้าร่วมอยู่ ไม่สามารถคำนวณสัดส่วนได้';
  END IF;

  INSERT INTO procurement.group_buy_settlement_plan (group_buy_id, invoice_id, lead_org_id, total_amount)
  VALUES (p_group_buy_id, v_invoice_id, v_lead_org_id, v_amount)
  RETURNING plan_id INTO v_plan_id;

  -- Settlement lines cover every OTHER participant only — the lead org
  -- already paid the full invoice itself via procurement.pay_invoice(), so
  -- it does not owe itself a share back.
  INSERT INTO procurement.group_buy_settlement_line (plan_id, participant_org_id, requested_qty, share_percent, amount)
  SELECT v_plan_id, gbp.org_id, gbp.requested_qty,
         ROUND(gbp.requested_qty / v_total_qty * 100, 3),
         ROUND(gbp.requested_qty / v_total_qty * v_amount, 2)
    FROM procurement.group_buy_participant gbp
   WHERE gbp.group_buy_id = p_group_buy_id AND gbp.status = 'joined' AND gbp.org_id <> v_lead_org_id;

  RETURN v_plan_id;
END;
$$;

-- ============================================================
-- Function: actually move the money, one participant at a time, isolated
-- per-line failures — identical control-flow shape to procurement.
-- distribute_revenue_share(), direction reversed (participant -> lead
-- instead of coop -> farmer unit_wallet).
-- ============================================================
CREATE OR REPLACE FUNCTION procurement.distribute_group_buy_settlement(p_plan_id uuid)
RETURNS TABLE(line_id uuid, status text, transfer_entry_id uuid, failure_reason text)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_plan_status TEXT;
  v_lead_org_id UUID;
  v_lead_account_id UUID;
  v_line RECORD;
  v_participant_account_id UUID;
  v_entry_id UUID;
BEGIN
  SELECT group_buy_settlement_plan.status, lead_org_id INTO v_plan_status, v_lead_org_id
    FROM procurement.group_buy_settlement_plan WHERE plan_id = p_plan_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบแผนแบ่งต้นทุน %', p_plan_id;
  END IF;
  IF v_plan_status = 'distributed' THEN
    RAISE EXCEPTION 'แผนแบ่งต้นทุน % ถูกดำเนินการไปแล้ว', p_plan_id;
  END IF;

  SELECT settlement_account_id INTO v_lead_account_id FROM partner.vendor_profile WHERE org_id = v_lead_org_id;
  IF v_lead_account_id IS NULL THEN
    RAISE EXCEPTION 'สหกรณ์หัวขบวน % ยังไม่มีบัญชี vendor_settlement', v_lead_org_id;
  END IF;

  FOR v_line IN
    SELECT * FROM procurement.group_buy_settlement_line
     WHERE plan_id = p_plan_id AND group_buy_settlement_line.status = 'pending' FOR UPDATE
  LOOP
    BEGIN
      SELECT settlement_account_id INTO v_participant_account_id
        FROM partner.vendor_profile WHERE org_id = v_line.participant_org_id;

      IF v_participant_account_id IS NULL THEN
        RAISE EXCEPTION 'สหกรณ์ % ยังไม่มีบัญชี vendor_settlement', v_line.participant_org_id;
      END IF;

      v_entry_id := ledger.transfer_funds(
        p_from_account   := v_participant_account_id,
        p_to_account     := v_lead_account_id,
        p_amount         := v_line.amount,
        p_entry_type     := 'Settlement',
        p_description    := 'แบ่งต้นทุนรวมออเดอร์ประมูลร่วม แผน ' || p_plan_id::text,
        p_reference_type := 'group_buy_settlement_line',
        p_reference_id   := v_line.line_id
      );

      UPDATE procurement.group_buy_settlement_line
         SET status = 'paid', transfer_entry_id = v_entry_id, failure_reason = NULL
       WHERE group_buy_settlement_line.line_id = v_line.line_id;
    EXCEPTION WHEN OTHERS THEN
      UPDATE procurement.group_buy_settlement_line
         SET status = 'failed', failure_reason = SQLERRM
       WHERE group_buy_settlement_line.line_id = v_line.line_id;
    END;
  END LOOP;

  UPDATE procurement.group_buy_settlement_plan
     SET status = 'distributed', distributed_at = now()
   WHERE plan_id = p_plan_id;

  RETURN QUERY
    SELECT gbsl.line_id, gbsl.status, gbsl.transfer_entry_id, gbsl.failure_reason
      FROM procurement.group_buy_settlement_line gbsl WHERE gbsl.plan_id = p_plan_id;
END;
$$;

-- ============================================================
-- Grants — same "no RLS, explicit WHERE clause IS the security boundary"
-- convention as every other procurement.* table.
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON procurement.group_buy TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON procurement.group_buy_participant TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON procurement.group_buy_settlement_plan TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON procurement.group_buy_settlement_line TO agrolink_app;
GRANT EXECUTE ON FUNCTION procurement.create_group_buy_settlement_plan(uuid) TO agrolink_app;
GRANT EXECUTE ON FUNCTION procurement.distribute_group_buy_settlement(uuid) TO agrolink_app;

-- ============================================================
-- Verification notes (run manually, not part of this script):
--   \d procurement.group_buy
--   \d procurement.group_buy_participant
--   \d procurement.group_buy_settlement_plan
--   \d procurement.group_buy_settlement_line
--   \df procurement.create_group_buy_settlement_plan
--   \df procurement.distribute_group_buy_settlement
-- ============================================================
