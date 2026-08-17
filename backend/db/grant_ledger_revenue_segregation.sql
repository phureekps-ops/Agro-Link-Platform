-- AgroLink -- Ledger revenue segregation by cooperative function (report/
-- record layer only, no change to real money movement) — added 2026-08-17,
-- MULTI_ROLE_ORGANIZATION_ARCHITECTURE.md §5.3a.
--
-- Context: when a cooperative holds multiple business roles at once (§5.2's
-- example — credit officer vs. drying-yard officer, or the six-function
-- cooperative case in §3), every non-Lender role shares ONE ledger account
-- (`vendor_settlement` — see `partner.activate_vendor_role()` and §2.4:
-- "one account per org, not per role"). Money from very different
-- functions — machinery rental, drying-yard fees, wholesale produce sale —
-- lands in that same shared account with nothing distinguishing which
-- function earned it. That makes an accurate per-function revenue-sharing
-- distribution to members (Revenue Sharing, already built in the B2B
-- Commerce Engine — `procurement.revenue_share_plan`) impossible for
-- anything beyond produce sales, and makes even simple per-function
-- reporting impossible today.
--
-- IMPORTANT — what this migration actually fixes, and what it can't
-- (discovered while implementing, not assumed from the design doc):
-- auditing every real ledger.transfer_funds() call site in this codebase
-- found that of the five revenue categories originally named for this
-- feature (loan interest, input-supplier commission, machinery rental,
-- drying-yard fees, wholesale produce margin), only ONE — wholesale
-- produce margin, via `procurement.pay_invoice()` — actually moves money
-- through AgroLink's ledger today:
--   - `credit.repay_loan()` (loan interest via loan repayment) exists in
--     the schema since an early layer of this platform but is NOT called
--     from any API route — there is no way for a farmer or an org to
--     trigger a loan repayment through this application at all yet. Not a
--     design decision, just unbuilt.
--   - Machinery rental and drying-yard fees go through
--     `marketplace.machinery_booking` (see `grant_machinery_booking.sql`),
--     which is DELIBERATELY offline-settled by product decision — that
--     migration's own comment says so directly: "payment is handled
--     OFFLINE directly between farmer and provider, AgroLink never
--     confirms the job actually happened." The older
--     `marketplace.service_request`/`complete_service_request()` mechanism
--     DOES move real ledger money, but it is legacy/unwired — no route in
--     this codebase calls it (grant_machinery_booking.sql's own comment
--     explains why it was superseded).
--   - Input-supplier commission (`marketplace.product_order`) has no
--     payment step of any kind in `POST /inputsupplier/orders/:id/fulfill`
--     — same offline/untracked shape as machinery bookings, just without
--     the explicit design note.
-- So this migration tags the ONE flow that has real ledger data
-- (wholesale/procurement_invoice) and adds the generic `source_role_type`
-- column + parameter so any future flow (a real loan-repayment endpoint, a
-- machinery/drying-yard settlement flow, an input-supplier payment flow —
-- none of which are built by this migration) can opt into the same
-- tagging the moment it exists, with zero further schema change needed.
-- Tagging four categories that generate no ledger rows at all would just
-- be an empty/misleading report — see the reporting function's own
-- comment below for how it surfaces this honestly instead of hiding it.
--
-- Why a new column on ledger.journal_entry (not a report-only view joining
-- back from reference_type/reference_id): the architecture doc originally
-- offered both as equivalent options. A column is chosen here because
-- procurement_invoice's `reference_id` alone can't identify the seller's
-- function without re-deriving it via contract.contract_party on every
-- report query — recording it once, at the moment the transfer actually
-- happens (inside procurement.pay_invoice(), which already knows exactly
-- who the seller is), is simpler and cheaper to query than a join-back
-- view, and just as safe: it's an extra piece of metadata on a normal
-- INSERT, not a change to any amount, account, or business rule. No
-- existing row is touched (`source_role_type` defaults to NULL for every
-- journal_entry ever created before this migration ran) and no accounting
-- invariant (double-entry balance, immutability) changes at all.
--
-- Function-signature note: `ledger.transfer_funds()` gets a NEW parameter
-- (`p_source_role_type`). Verified locally that `CREATE OR REPLACE
-- FUNCTION` adding a trailing DEFAULT parameter does NOT replace the old
-- signature in place — Postgres creates a second overload instead, and any
-- caller that still supplies exactly the OLD argument count becomes
-- ambiguous between the two overloads (reproduced directly against this
-- project's own Postgres before writing this migration). So the old
-- 8-argument signature is explicitly DROPped first, then the 9-argument
-- version is created — this is safe here specifically because EVERY
-- existing caller of `ledger.transfer_funds()` in this codebase uses named
-- (`:=`) arguments, not positional, so none of them break from the extra
-- trailing parameter; they simply don't pass it and get the NULL default,
-- identical behavior to before this migration.
-- ============================================================================

-- 1. New column — nullable, no CHECK constraint (same free-text convention
--    already used by `reference_type` on this same table; the domain of
--    "which function" isn't fixed to organization_role's role_type list,
--    since e.g. 'Wholesale' below isn't a role_type an org requests at all
--    — procurement.js has never gated wholesale selling behind a role, see
--    MULTI_ROLE_ORGANIZATION_ARCHITECTURE.md §3).
ALTER TABLE ledger.journal_entry ADD COLUMN IF NOT EXISTS source_role_type text;

COMMENT ON COLUMN ledger.journal_entry.source_role_type IS
  'ป้ายกำกับหน้าที่ทางธุรกิจที่ก่อรายการนี้ (เช่น Wholesale) — NULL หมายถึงยังไม่ได้ระบุ (รายการเก่าก่อน 2026-08-17 ทั้งหมด, และรายการใหม่จากฟังก์ชันที่ยังไม่ได้แก้ให้ส่งค่านี้) ไม่ใช่ error — ดู grant_ledger_revenue_segregation.sql สำหรับรายการฟังก์ชันที่ระบุค่านี้จริงในรอบนี้ (มีแค่ procurement.pay_invoice())';

-- 2. ledger.transfer_funds() — add p_source_role_type, DROP old signature
--    first (see note above on overload ambiguity). Body is otherwise
--    byte-for-byte identical to the version in 02_full_schema.sql except
--    for the new parameter and its one new INSERT column.
DROP FUNCTION IF EXISTS ledger.transfer_funds(uuid, uuid, numeric, text, text, text, uuid, boolean);

CREATE OR REPLACE FUNCTION ledger.transfer_funds(
  p_from_account uuid,
  p_to_account uuid,
  p_amount numeric,
  p_entry_type text,
  p_description text DEFAULT NULL::text,
  p_reference_type text DEFAULT NULL::text,
  p_reference_id uuid DEFAULT NULL::uuid,
  p_allow_negative boolean DEFAULT false,
  p_source_role_type text DEFAULT NULL::text
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_entry_id UUID;
    v_lock_first UUID;
    v_lock_second UUID;
    v_from_balance NUMERIC(18,2);
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'จำนวนเงินโอนต้องมากกว่า 0';
    END IF;

    IF p_from_account < p_to_account THEN
        v_lock_first := p_from_account; v_lock_second := p_to_account;
    ELSE
        v_lock_first := p_to_account; v_lock_second := p_from_account;
    END IF;
    PERFORM 1 FROM ledger.account WHERE account_id = v_lock_first FOR UPDATE;
    PERFORM 1 FROM ledger.account WHERE account_id = v_lock_second FOR UPDATE;

    SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
         - COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0)
      INTO v_from_balance
      FROM ledger.journal_line WHERE account_id = p_from_account;

    IF NOT p_allow_negative AND v_from_balance < p_amount THEN
        RAISE EXCEPTION 'ยอดคงเหลือไม่เพียงพอ: บัญชี % มียอด % แต่ต้องการโอน %', p_from_account, v_from_balance, p_amount;
    END IF;

    INSERT INTO ledger.journal_entry (entry_type, description, reference_type, reference_id, source_role_type)
    VALUES (p_entry_type, p_description, p_reference_type, p_reference_id, p_source_role_type)
    RETURNING entry_id INTO v_entry_id;

    INSERT INTO ledger.journal_line (entry_id, account_id, direction, amount) VALUES
        (v_entry_id, p_from_account, 'debit', p_amount),
        (v_entry_id, p_to_account, 'credit', p_amount);

    RETURN v_entry_id;
END;
$$;

COMMENT ON FUNCTION ledger.transfer_funds(uuid, uuid, numeric, text, text, text, uuid, boolean, text) IS 'จุดเดียวที่ได้รับอนุญาตให้โอนเงินระหว่างบัญชี — ทุก endpoint ของ API ต้องเรียกผ่านฟังก์ชันนี้เท่านั้น (REVOKE INSERT บนตาราง journal_* จาก app role โดยตรงใน Production) — p_source_role_type เพิ่มเมื่อ 2026-08-17 (ดู MULTI_ROLE_ORGANIZATION_ARCHITECTURE.md §5.3a), optional, NULL คือค่าเริ่มต้นเดิมสำหรับผู้เรียกที่ยังไม่ได้แก้ให้ส่งค่านี้';

-- 3. procurement.pay_invoice() — same external signature (no DROP needed,
--    CREATE OR REPLACE is safe when the function's OWN parameter list
--    doesn't change), now tags every wholesale settlement 'Wholesale'.
--    This is the only real revenue flow tagged in this pass — see the
--    file header above for why the other four categories aren't.
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
    p_reference_id   := p_invoice_id,
    p_source_role_type := 'Wholesale'
  );

  UPDATE procurement.invoice
     SET status = 'paid', paid_at = now(), paid_entry_id = v_entry_id, updated_at = now()
   WHERE invoice_id = p_invoice_id;

  UPDATE procurement.purchase_order
     SET status = 'completed', updated_at = now()
   WHERE po_id = v_po_id AND status IN ('acknowledged', 'in_fulfillment');

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

-- 4. Reporting function — per-org revenue/cash-flow broken down by
--    source_role_type. Deliberately does NOT filter out the NULL bucket:
--    surfacing "ยังไม่ระบุหน้าที่" as its own row (with its own real total)
--    is what keeps this honest — a cooperative looking at this report sees
--    directly that most of its ledger activity has no function attributed
--    yet, instead of the report silently only showing the one category
--    that happens to be tagged and implying that's the whole picture.
CREATE OR REPLACE FUNCTION reporting.coop_revenue_by_function(p_org_id uuid)
RETURNS TABLE (
  source_role_type text,
  entry_count       int,
  total_in          numeric,
  total_out         numeric
)
LANGUAGE sql STABLE AS $$
  SELECT
    je.source_role_type AS source_role_type,
    COUNT(*)::int AS entry_count,
    COALESCE(SUM(jl.amount) FILTER (WHERE jl.direction = 'credit'), 0) AS total_in,
    COALESCE(SUM(jl.amount) FILTER (WHERE jl.direction = 'debit'), 0) AS total_out
  FROM ledger.journal_line jl
  JOIN ledger.journal_entry je ON je.entry_id = jl.entry_id
  JOIN ledger.account a ON a.account_id = jl.account_id
  WHERE a.owner_id = p_org_id
  GROUP BY je.source_role_type
  ORDER BY 3 DESC, je.source_role_type NULLS LAST
$$;

COMMENT ON FUNCTION reporting.coop_revenue_by_function(uuid) IS
  'M04 ส่วนขยาย: สรุปเงินไหลเข้า/ออกบัญชีของสหกรณ์ แยกตาม source_role_type (ดู ledger.journal_entry.source_role_type) — เพิ่มเมื่อ 2026-08-17, MULTI_ROLE_ORGANIZATION_ARCHITECTURE.md §5.3a. วันนี้มีแค่แถว ''Wholesale'' (ขายส่งผลผลิตผ่าน procurement.pay_invoice) ที่มาจากข้อมูลจริง ส่วนแถว NULL คือรายการทั้งหมดที่ยังไม่ได้ระบุหน้าที่ (สินเชื่อที่ชำระคืนยังไม่มี route จริง, ค่าเช่าเครื่องจักร/ค่าลานตาก/ค่าคอมมิชชันปัจจัยการผลิตยังชำระเงินนอกระบบทั้งหมด — ดูรายละเอียดที่ไฟล์นี้ตอนบน) ไม่ใช่การรายงานผิดพลาด';

GRANT SELECT ON ledger.journal_line TO agrolink_app;

-- ============================================================================
-- Follow-up work this migration deliberately leaves open (see the header
-- comment for the full audit that led to this list):
--   - No loan-repayment API route exists at all yet — building one is a
--     prerequisite before 'Lender' can ever appear as a real row in
--     reporting.coop_revenue_by_function(). credit.repay_loan() itself
--     would need the same p_source_role_type wiring this migration gave
--     procurement.pay_invoice() once that route exists.
--   - Machinery rental / drying-yard fees / input-supplier commission stay
--     off-ledger (offline settlement) — bringing them onto the ledger is a
--     product decision with real user-facing consequences (AgroLink would
--     start being asked to confirm/track payments it currently has no
--     opinion on at all), not a schema change this migration should make
--     unilaterally.
--   - No change to procurement.create_revenue_share_plan() or
--     revenue_share_plan/revenue_share_line — those still only compute
--     from produce_sale lot data (§5.3b, still open, still needs an
--     explicit policy decision on allocation formula per source_type
--     before any code gets written there).
-- ============================================================================
