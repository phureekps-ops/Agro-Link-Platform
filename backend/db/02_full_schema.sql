--
-- PostgreSQL database dump
--


-- Dumped from database version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: audit; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA audit;


--
-- Name: contract; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA contract;


--
-- Name: credit; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA credit;


--
-- Name: identity; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA identity;


--
-- Name: ledger; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA ledger;


--
-- Name: marketplace; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA marketplace;


--
-- Name: monitoring; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA monitoring;


--
-- Name: notification; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA notification;


--
-- Name: ops; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA ops;


--
-- Name: partner; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA partner;


--
-- Name: produce; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA produce;


--
-- Name: production; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA production;


--
-- Name: registry; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA registry;


--
-- Name: reporting; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA reporting;


--
-- Name: retention; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA retention;


--
-- Name: risk; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA risk;


--
-- Name: security; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA security;


--
-- Name: traceability; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA traceability;


--
-- Name: underwriting; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA underwriting;


--
-- Name: log_access(text, text, uuid); Type: FUNCTION; Schema: audit; Owner: -
--

CREATE FUNCTION audit.log_access(p_action text, p_resource_type text, p_resource_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_access_id UUID;
  v_subject_type TEXT := current_setting('app.subject_type', true);
  v_subject_id UUID := NULLIF(current_setting('app.subject_id', true), '')::uuid;
BEGIN
  IF v_subject_type IS NULL THEN
    RAISE EXCEPTION 'ไม่พบบริบท Session ปัจจุบัน — ต้องเรียก security.set_session_context() ก่อนบันทึกการเข้าถึง';
  END IF;
  INSERT INTO audit.access_log (subject_type, subject_id, action, resource_type, resource_id)
  VALUES (v_subject_type, v_subject_id, p_action, p_resource_type, p_resource_id)
  RETURNING access_id INTO v_access_id;
  RETURN v_access_id;
END;
$$;


--
-- Name: fn_check_party_owner(); Type: FUNCTION; Schema: contract; Owner: -
--

CREATE FUNCTION contract.fn_check_party_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.party_type = 'farmer' THEN
        IF NOT EXISTS (SELECT 1 FROM identity.farmer WHERE farmer_id = NEW.party_id) THEN
            RAISE EXCEPTION 'party_id % ไม่พบใน identity.farmer', NEW.party_id;
        END IF;
    ELSIF NEW.party_type = 'organization' THEN
        IF NOT EXISTS (SELECT 1 FROM identity.organization WHERE org_id = NEW.party_id) THEN
            RAISE EXCEPTION 'party_id % ไม่พบใน identity.organization', NEW.party_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: fn_log_status_change(); Type: FUNCTION; Schema: contract; Owner: -
--

CREATE FUNCTION contract.fn_log_status_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO contract.contract_status_history (contract_id, from_status, to_status)
        VALUES (NEW.contract_id, OLD.status, NEW.status);
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: sign_contract(uuid, uuid, text, text, text, text); Type: FUNCTION; Schema: contract; Owner: -
--

CREATE FUNCTION contract.sign_contract(p_contract_id uuid, p_party_id uuid, p_party_type text, p_signature_method text, p_signature_hash text, p_signed_document_ref text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_contract_party_id   UUID;
    v_signature_id          UUID;
    v_required_count          INT;
    v_signed_count              INT;
    v_contract_type                TEXT;
    v_status                        TEXT;
    v_principal                      NUMERIC(18,2);
    v_related_unit_id                    UUID;
    v_lender_org_id                        UUID;
    v_lender_account_id                      UUID;
    v_escrow_account_id                        UUID;
    v_hold_id                                    UUID;
BEGIN
    SELECT contract_party_id INTO v_contract_party_id
    FROM contract.contract_party
    WHERE contract_id = p_contract_id AND party_id = p_party_id AND party_type = p_party_type
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบคู่สัญญา party_id % (%) ในสัญญา %', p_party_id, p_party_type, p_contract_id;
    END IF;

    IF EXISTS (SELECT 1 FROM contract.digital_signature WHERE contract_party_id = v_contract_party_id) THEN
        RAISE EXCEPTION 'คู่สัญญารายนี้เซ็นสัญญา % ไปแล้ว ไม่สามารถเซ็นซ้ำได้', p_contract_id;
    END IF;

    INSERT INTO contract.digital_signature (contract_party_id, signature_method, signature_hash, signed_document_ref)
    VALUES (v_contract_party_id, p_signature_method, p_signature_hash, p_signed_document_ref)
    RETURNING signature_id INTO v_signature_id;

    SELECT count(*) INTO v_required_count FROM contract.contract_party WHERE contract_id = p_contract_id;
    SELECT count(*) INTO v_signed_count
    FROM contract.contract_party cp
    JOIN contract.digital_signature ds ON ds.contract_party_id = cp.contract_party_id
    WHERE cp.contract_id = p_contract_id;

    SELECT contract_type, status, principal_amount, related_unit_id
    INTO v_contract_type, v_status, v_principal, v_related_unit_id
    FROM contract.contract WHERE contract_id = p_contract_id FOR UPDATE;

    IF v_signed_count = v_required_count AND v_status IN ('draft','pending_signature') THEN
        UPDATE contract.contract
        SET status = 'active', effective_date = COALESCE(effective_date, CURRENT_DATE)
        WHERE contract_id = p_contract_id;

        -- สัญญาสินเชื่อ: พักเงินต้นจาก lender_clearing เข้า escrow ผ่านฟังก์ชันขั้นที่ 2
        IF v_contract_type = 'loan_agreement' THEN
            SELECT cp.party_id INTO v_lender_org_id
            FROM contract.contract_party cp
            WHERE cp.contract_id = p_contract_id AND cp.party_role = 'lender' LIMIT 1;

            SELECT lender_clearing_account_id INTO v_lender_account_id
            FROM partner.vendor_profile WHERE org_id = v_lender_org_id;

            SELECT account_id INTO v_escrow_account_id
            FROM ledger.account WHERE account_type = 'escrow' AND owner_type = 'platform' LIMIT 1;

            IF v_lender_account_id IS NULL THEN
                RAISE EXCEPTION 'ผู้ให้กู้ % ยังไม่มีบัญชี lender_clearing (ต้องเรียก partner.activate_vendor ก่อน)', v_lender_org_id;
            END IF;

            v_hold_id := ledger.hold_escrow(
                p_from_account := v_lender_account_id,
                p_unit_id := v_related_unit_id,
                p_amount := v_principal,
                p_release_condition_ref := 'Contract:' || p_contract_id::text || '_Stage1'
            );

            UPDATE contract.contract SET escrow_hold_id = v_hold_id WHERE contract_id = p_contract_id;
        END IF;
    ELSIF v_status = 'draft' THEN
        UPDATE contract.contract SET status = 'pending_signature' WHERE contract_id = p_contract_id;
    END IF;

    RETURN v_signature_id;
END;
$$;


--
-- Name: FUNCTION sign_contract(p_contract_id uuid, p_party_id uuid, p_party_type text, p_signature_method text, p_signature_hash text, p_signed_document_ref text); Type: COMMENT; Schema: contract; Owner: -
--

COMMENT ON FUNCTION contract.sign_contract(p_contract_id uuid, p_party_id uuid, p_party_type text, p_signature_method text, p_signature_hash text, p_signed_document_ref text) IS 'จุดเดียวที่บันทึกลายมือชื่อดิจิทัลได้ เชื่อมต่อกับ ledger.hold_escrow() ของขั้นที่ 2 โดยตรงเมื่อสัญญาสินเชื่อเซ็นครบทุกฝ่าย';


--
-- Name: terminate_contract(uuid, text); Type: FUNCTION; Schema: contract; Owner: -
--

CREATE FUNCTION contract.terminate_contract(p_contract_id uuid, p_reason text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_status TEXT;
BEGIN
    SELECT status INTO v_status FROM contract.contract WHERE contract_id = p_contract_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบสัญญา %', p_contract_id;
    END IF;
    IF v_status IN ('completed','terminated') THEN
        RAISE EXCEPTION 'สัญญา % อยู่ในสถานะสุดท้ายแล้ว (%) ไม่สามารถยกเลิกซ้ำได้', p_contract_id, v_status;
    END IF;

    UPDATE contract.contract SET status = 'terminated' WHERE contract_id = p_contract_id;
    UPDATE contract.contract_status_history
    SET reason = p_reason
    WHERE history_id = (SELECT history_id FROM contract.contract_status_history
                         WHERE contract_id = p_contract_id ORDER BY changed_at DESC LIMIT 1);
END;
$$;


--
-- Name: repay_loan(uuid, numeric, date); Type: FUNCTION; Schema: credit; Owner: -
--

CREATE FUNCTION credit.repay_loan(p_contract_id uuid, p_amount numeric, p_due_date date) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_contract_type      TEXT;
    v_status                TEXT;
    v_principal_amount        NUMERIC(18,2);
    v_related_unit_id            UUID;
    v_lender_org_id                  UUID;
    v_wallet_account_id                 UUID;
    v_lender_account_id                    UUID;
    v_entry_id                                UUID;
    v_repayment_id                               UUID;
    v_status_computed                               TEXT;
    v_total_repaid                                     NUMERIC(18,2);
BEGIN
    SELECT contract_type, status, principal_amount, related_unit_id
    INTO v_contract_type, v_status, v_principal_amount, v_related_unit_id
    FROM contract.contract WHERE contract_id = p_contract_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบสัญญา %', p_contract_id;
    END IF;
    IF v_contract_type <> 'loan_agreement' THEN
        RAISE EXCEPTION 'สัญญา % ไม่ใช่สัญญาสินเชื่อ (ประเภทปัจจุบัน %) ไม่สามารถชำระคืนสินเชื่อได้', p_contract_id, v_contract_type;
    END IF;
    IF v_status <> 'active' THEN
        RAISE EXCEPTION 'สัญญาสินเชื่อ % อยู่ในสถานะ % ต้อง active เท่านั้นจึงจะชำระคืนได้', p_contract_id, v_status;
    END IF;

    SELECT party_id INTO v_lender_org_id
    FROM contract.contract_party WHERE contract_id = p_contract_id AND party_role = 'lender' LIMIT 1;

    SELECT account_id INTO v_wallet_account_id FROM ledger.account WHERE account_type = 'unit_wallet' AND owner_id = v_related_unit_id;
    SELECT lender_clearing_account_id INTO v_lender_account_id FROM partner.vendor_profile WHERE org_id = v_lender_org_id;

    IF v_wallet_account_id IS NULL OR v_lender_account_id IS NULL THEN
        RAISE EXCEPTION 'ไม่พบบัญชีกระเป๋าเงินของหน่วยผลิตหรือบัญชี lender_clearing ของผู้ให้กู้สำหรับสัญญา %', p_contract_id;
    END IF;

    v_entry_id := ledger.transfer_funds(
        p_from_account := v_wallet_account_id,
        p_to_account   := v_lender_account_id,
        p_amount       := p_amount,
        p_entry_type   := 'LoanRepayment',
        p_description  := 'ชำระคืนสินเชื่อสำหรับสัญญา ' || p_contract_id::text,
        p_reference_type := 'contract',
        p_reference_id    := p_contract_id
    );

    v_status_computed := CASE WHEN CURRENT_DATE <= p_due_date THEN 'paid_on_time' ELSE 'paid_late' END;

    INSERT INTO credit.loan_repayment (contract_id, amount, due_date, status, settlement_entry_id)
    VALUES (p_contract_id, p_amount, p_due_date, v_status_computed, v_entry_id)
    RETURNING repayment_id INTO v_repayment_id;

    SELECT COALESCE(sum(amount), 0) INTO v_total_repaid FROM credit.loan_repayment WHERE contract_id = p_contract_id;

    IF v_total_repaid >= v_principal_amount THEN
        UPDATE contract.contract SET status = 'completed' WHERE contract_id = p_contract_id AND status = 'active';
    END IF;

    RETURN v_repayment_id;
END;
$$;


--
-- Name: FUNCTION repay_loan(p_contract_id uuid, p_amount numeric, p_due_date date); Type: COMMENT; Schema: credit; Owner: -
--

COMMENT ON FUNCTION credit.repay_loan(p_contract_id uuid, p_amount numeric, p_due_date date) IS 'เรียก ledger.transfer_funds() ของขั้นที่ 2 โดยตรงจากกระเป๋าเงินหน่วยผลิตไปยัง lender_clearing ของผู้ให้กู้ ปิดสัญญาสินเชื่ออัตโนมัติเมื่อยอดชำระสะสมครบเงินต้น เป็นสัญญาณความน่าเชื่อถือหลักของ G-11';


--
-- Name: fn_check_verification_subject(); Type: FUNCTION; Schema: identity; Owner: -
--

CREATE FUNCTION identity.fn_check_verification_subject() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.subject_type = 'farmer' THEN
        IF NOT EXISTS (SELECT 1 FROM identity.farmer WHERE farmer_id = NEW.subject_id) THEN
            RAISE EXCEPTION 'subject_id % ไม่พบใน identity.farmer', NEW.subject_id;
        END IF;
    ELSIF NEW.subject_type = 'organization' THEN
        IF NOT EXISTS (SELECT 1 FROM identity.organization WHERE org_id = NEW.subject_id) THEN
            RAISE EXCEPTION 'subject_id % ไม่พบใน identity.organization', NEW.subject_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: fn_check_account_owner(); Type: FUNCTION; Schema: ledger; Owner: -
--

CREATE FUNCTION ledger.fn_check_account_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.owner_type = 'production_unit' THEN
        IF NOT EXISTS (SELECT 1 FROM registry.production_unit WHERE unit_id = NEW.owner_id) THEN
            RAISE EXCEPTION 'owner_id % ไม่พบใน registry.production_unit', NEW.owner_id;
        END IF;
    ELSIF NEW.owner_type = 'organization' THEN
        IF NOT EXISTS (SELECT 1 FROM identity.organization WHERE org_id = NEW.owner_id) THEN
            RAISE EXCEPTION 'owner_id % ไม่พบใน identity.organization', NEW.owner_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: fn_check_entry_balanced(); Type: FUNCTION; Schema: ledger; Owner: -
--

CREATE FUNCTION ledger.fn_check_entry_balanced() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_entry_id UUID;
    v_debit NUMERIC(18,2);
    v_credit NUMERIC(18,2);
BEGIN
    v_entry_id := COALESCE(NEW.entry_id, OLD.entry_id);
    SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0),
           COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
      INTO v_debit, v_credit
      FROM ledger.journal_line WHERE entry_id = v_entry_id;
    IF v_debit <> v_credit THEN
        RAISE EXCEPTION 'journal_entry % ไม่สมดุล: debit=% credit=% (ต้องเท่ากันตามหลัก Double-entry)', v_entry_id, v_debit, v_credit;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ledger.journal_line WHERE entry_id = v_entry_id) THEN
        RAISE EXCEPTION 'journal_entry % ไม่มี journal_line ใดๆ', v_entry_id;
    END IF;
    RETURN NULL;
END;
$$;


--
-- Name: hold_escrow(uuid, uuid, numeric, text); Type: FUNCTION; Schema: ledger; Owner: -
--

CREATE FUNCTION ledger.hold_escrow(p_from_account uuid, p_unit_id uuid, p_amount numeric, p_release_condition_ref text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_escrow_account UUID;
    v_entry_id UUID;
    v_hold_id UUID;
BEGIN
    SELECT account_id INTO v_escrow_account FROM ledger.account WHERE account_type = 'escrow' LIMIT 1;
    IF v_escrow_account IS NULL THEN
        RAISE EXCEPTION 'ไม่พบบัญชี escrow กลาง ต้องสร้างก่อนใช้งาน';
    END IF;

    v_entry_id := ledger.transfer_funds(p_from_account, v_escrow_account, p_amount,
                                         'EscrowHold', 'พักเงินรองบเบิกจ่ายเป็นงวด');

    INSERT INTO ledger.escrow_hold (escrow_account_id, unit_id, amount, release_condition_ref, hold_entry_id)
    VALUES (v_escrow_account, p_unit_id, p_amount, p_release_condition_ref, v_entry_id)
    RETURNING hold_id INTO v_hold_id;

    RETURN v_hold_id;
END;
$$;


--
-- Name: release_escrow(uuid, uuid); Type: FUNCTION; Schema: ledger; Owner: -
--

CREATE FUNCTION ledger.release_escrow(p_hold_id uuid, p_to_account uuid) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_hold RECORD;
    v_entry_id UUID;
BEGIN
    SELECT * INTO v_hold FROM ledger.escrow_hold WHERE hold_id = p_hold_id FOR UPDATE;
    IF v_hold IS NULL THEN
        RAISE EXCEPTION 'ไม่พบ escrow_hold %', p_hold_id;
    END IF;
    IF v_hold.status <> 'held' THEN
        RAISE EXCEPTION 'escrow_hold % อยู่ในสถานะ % แล้ว ไม่สามารถปลดล็อกซ้ำได้', p_hold_id, v_hold.status;
    END IF;

    v_entry_id := ledger.transfer_funds(v_hold.escrow_account_id, p_to_account, v_hold.amount,
                                         'EscrowRelease', 'ปลดล็อกเงินงวดตามเงื่อนไขที่ยืนยันแล้ว');

    UPDATE ledger.escrow_hold
       SET status = 'released', released_at = now(), release_entry_id = v_entry_id
     WHERE hold_id = p_hold_id;

    RETURN v_entry_id;
END;
$$;


--
-- Name: FUNCTION release_escrow(p_hold_id uuid, p_to_account uuid); Type: COMMENT; Schema: ledger; Owner: -
--

COMMENT ON FUNCTION ledger.release_escrow(p_hold_id uuid, p_to_account uuid) IS 'ปลดล็อกเงินจาก Escrow ไปยังบัญชีปลายทาง (ปกติคือ unit_wallet ของเจ้าของหน่วยผลิต) เมื่อเงื่อนไขงวดผ่านการยืนยันแล้ว';


--
-- Name: transfer_funds(uuid, uuid, numeric, text, text, text, uuid, boolean); Type: FUNCTION; Schema: ledger; Owner: -
--

CREATE FUNCTION ledger.transfer_funds(p_from_account uuid, p_to_account uuid, p_amount numeric, p_entry_type text, p_description text DEFAULT NULL::text, p_reference_type text DEFAULT NULL::text, p_reference_id uuid DEFAULT NULL::uuid, p_allow_negative boolean DEFAULT false) RETURNS uuid
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

    -- ล็อกบัญชีทั้งสองตามลำดับ UUID คงที่เสมอ (deterministic ordering) เพื่อป้องกัน Deadlock
    -- เมื่อมีสองธุรกรรมพยายามโอนระหว่างบัญชีคู่เดียวกันพร้อมกันในทิศทางตรงข้าม
    IF p_from_account < p_to_account THEN
        v_lock_first := p_from_account; v_lock_second := p_to_account;
    ELSE
        v_lock_first := p_to_account; v_lock_second := p_from_account;
    END IF;
    PERFORM 1 FROM ledger.account WHERE account_id = v_lock_first FOR UPDATE;
    PERFORM 1 FROM ledger.account WHERE account_id = v_lock_second FOR UPDATE;

    -- เมื่อถือ Lock แล้ว จึงคำนวณยอดคงเหลือปัจจุบันของบัญชีต้นทาง — รับประกันว่าไม่มี
    -- ธุรกรรมอื่นแทรกระหว่างการอ่านยอดกับการบันทึกโอน (ป้องกัน Race Condition / Double-spend)
    SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
         - COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0)
      INTO v_from_balance
      FROM ledger.journal_line WHERE account_id = p_from_account;

    IF NOT p_allow_negative AND v_from_balance < p_amount THEN
        RAISE EXCEPTION 'ยอดคงเหลือไม่เพียงพอ: บัญชี % มียอด % แต่ต้องการโอน %', p_from_account, v_from_balance, p_amount;
    END IF;

    INSERT INTO ledger.journal_entry (entry_type, description, reference_type, reference_id)
    VALUES (p_entry_type, p_description, p_reference_type, p_reference_id)
    RETURNING entry_id INTO v_entry_id;

    INSERT INTO ledger.journal_line (entry_id, account_id, direction, amount) VALUES
        (v_entry_id, p_from_account, 'debit', p_amount),
        (v_entry_id, p_to_account, 'credit', p_amount);

    RETURN v_entry_id;
END;
$$;


--
-- Name: FUNCTION transfer_funds(p_from_account uuid, p_to_account uuid, p_amount numeric, p_entry_type text, p_description text, p_reference_type text, p_reference_id uuid, p_allow_negative boolean); Type: COMMENT; Schema: ledger; Owner: -
--

COMMENT ON FUNCTION ledger.transfer_funds(p_from_account uuid, p_to_account uuid, p_amount numeric, p_entry_type text, p_description text, p_reference_type text, p_reference_id uuid, p_allow_negative boolean) IS 'จุดเดียวที่ได้รับอนุญาตให้โอนเงินระหว่างบัญชี — ทุก endpoint ของ API ต้องเรียกผ่านฟังก์ชันนี้เท่านั้น (REVOKE INSERT บนตาราง journal_* จาก app role โดยตรงใน Production)';


--
-- Name: accept_service_request(uuid); Type: FUNCTION; Schema: marketplace; Owner: -
--

CREATE FUNCTION marketplace.accept_service_request(p_request_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_status TEXT;
BEGIN
    SELECT status INTO v_status FROM marketplace.service_request WHERE request_id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบคำขอใช้บริการ %', p_request_id;
    END IF;
    IF v_status <> 'requested' THEN
        RAISE EXCEPTION 'คำขอ % อยู่ในสถานะ % แล้ว ไม่สามารถยอมรับซ้ำได้', p_request_id, v_status;
    END IF;
    UPDATE marketplace.service_request SET status = 'accepted' WHERE request_id = p_request_id;
END;
$$;


--
-- Name: complete_service_request(uuid); Type: FUNCTION; Schema: marketplace; Owner: -
--

CREATE FUNCTION marketplace.complete_service_request(p_request_id uuid) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_status             TEXT;
    v_unit_id              UUID;
    v_listing_id             UUID;
    v_agreed_price              NUMERIC(18,2);
    v_org_id                       UUID;
    v_wallet_account_id               UUID;
    v_settlement_account_id              UUID;
    v_entry_id                              UUID;
BEGIN
    SELECT status, unit_id, listing_id, agreed_price
    INTO v_status, v_unit_id, v_listing_id, v_agreed_price
    FROM marketplace.service_request WHERE request_id = p_request_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบคำขอใช้บริการ %', p_request_id;
    END IF;
    IF v_status <> 'accepted' THEN
        RAISE EXCEPTION 'คำขอ % อยู่ในสถานะ % ต้องอยู่ในสถานะ accepted ก่อนจึงจะปิดงานได้', p_request_id, v_status;
    END IF;

    SELECT org_id INTO v_org_id FROM marketplace.service_listing WHERE listing_id = v_listing_id;
    SELECT settlement_account_id INTO v_settlement_account_id FROM partner.vendor_profile WHERE org_id = v_org_id;
    SELECT account_id INTO v_wallet_account_id FROM ledger.account WHERE account_type = 'unit_wallet' AND owner_id = v_unit_id;

    IF v_settlement_account_id IS NULL THEN
        RAISE EXCEPTION 'คู่ค้า % ยังไม่มีบัญชี vendor_settlement (ต้องเรียก partner.activate_vendor ก่อน)', v_org_id;
    END IF;

    v_entry_id := ledger.transfer_funds(
        p_from_account := v_wallet_account_id,
        p_to_account   := v_settlement_account_id,
        p_amount       := v_agreed_price,
        p_entry_type   := 'Settlement',
        p_description  := 'ชำระค่าบริการ Marketplace สำหรับคำขอ ' || p_request_id::text,
        p_reference_type := 'service_request',
        p_reference_id    := p_request_id
    );

    UPDATE marketplace.service_request
    SET status = 'completed', completed_at = now(), payment_entry_id = v_entry_id
    WHERE request_id = p_request_id;

    RETURN v_entry_id;
END;
$$;


--
-- Name: request_service(uuid, uuid, uuid, uuid, date); Type: FUNCTION; Schema: marketplace; Owner: -
--

CREATE FUNCTION marketplace.request_service(p_listing_id uuid, p_unit_id uuid, p_cycle_id uuid DEFAULT NULL::uuid, p_stage_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT NULL::date) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_price       NUMERIC(18,2);
    v_is_active     BOOLEAN;
    v_request_id      UUID;
BEGIN
    SELECT unit_price, is_active INTO v_price, v_is_active
    FROM marketplace.service_listing WHERE listing_id = p_listing_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบประกาศบริการ %', p_listing_id;
    END IF;
    IF NOT v_is_active THEN
        RAISE EXCEPTION 'ประกาศบริการ % ปิดรับคำขอแล้ว', p_listing_id;
    END IF;

    INSERT INTO marketplace.service_request (listing_id, unit_id, cycle_id, stage_id, agreed_price, scheduled_date)
    VALUES (p_listing_id, p_unit_id, p_cycle_id, p_stage_id, v_price, p_scheduled_date)
    RETURNING request_id INTO v_request_id;

    RETURN v_request_id;
END;
$$;


--
-- Name: acknowledge_alert(uuid); Type: FUNCTION; Schema: monitoring; Owner: -
--

CREATE FUNCTION monitoring.acknowledge_alert(p_alert_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    UPDATE monitoring.alert_event
    SET acknowledged = true, acknowledged_at = now()
    WHERE alert_id = p_alert_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบการแจ้งเตือน (alert_id=%)', p_alert_id;
    END IF;
END;
$$;


--
-- Name: evaluate_metric(text, numeric, text, text); Type: FUNCTION; Schema: monitoring; Owner: -
--

CREATE FUNCTION monitoring.evaluate_metric(p_metric_name text, p_value numeric, p_source text, p_notes text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_observation_id UUID;
    v_threshold RECORD;
    v_breached  BOOLEAN;
    v_severity  TEXT;
BEGIN
    INSERT INTO monitoring.metric_observation (metric_name, observed_value, source, notes)
    VALUES (p_metric_name, p_value, p_source, p_notes)
    RETURNING observation_id INTO v_observation_id;

    FOR v_threshold IN
        SELECT * FROM monitoring.metric_threshold WHERE metric_name = p_metric_name
    LOOP
        v_severity := NULL;

        IF v_threshold.comparison = 'gt' THEN
            IF v_threshold.critical_value IS NOT NULL AND p_value > v_threshold.critical_value THEN
                v_severity := 'critical';
            ELSIF v_threshold.warning_value IS NOT NULL AND p_value > v_threshold.warning_value THEN
                v_severity := 'warning';
            END IF;
        ELSIF v_threshold.comparison = 'lt' THEN
            IF v_threshold.critical_value IS NOT NULL AND p_value < v_threshold.critical_value THEN
                v_severity := 'critical';
            ELSIF v_threshold.warning_value IS NOT NULL AND p_value < v_threshold.warning_value THEN
                v_severity := 'warning';
            END IF;
        END IF;

        IF v_severity IS NOT NULL THEN
            INSERT INTO monitoring.alert_event (threshold_id, observation_id, severity, message)
            VALUES (
                v_threshold.threshold_id, v_observation_id, v_severity,
                format('%s = %s %s (เกณฑ์ %s: %s %s)', p_metric_name, p_value, COALESCE(v_threshold.unit, ''),
                       v_severity,
                       CASE WHEN v_severity = 'critical' THEN v_threshold.critical_value ELSE v_threshold.warning_value END,
                       COALESCE(v_threshold.unit, ''))
            );
        END IF;
    END LOOP;

    RETURN v_observation_id;
END;
$$;


--
-- Name: fn_notify_application_decision(); Type: FUNCTION; Schema: notification; Owner: -
--

CREATE FUNCTION notification.fn_notify_application_decision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_severity TEXT;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_severity := CASE NEW.status
      WHEN 'approved' THEN 'info'
      WHEN 'converted' THEN 'info'
      WHEN 'manual_review' THEN 'warning'
      WHEN 'declined' THEN 'warning'
      ELSE 'info'
    END;
    PERFORM notification.notify(
      'loan_application_' || NEW.status,
      v_severity,
      'loan_application',
      NEW.application_id,
      COALESCE(NEW.decision_reason, 'สถานะใบสมัครเปลี่ยนเป็น ' || NEW.status)
    );
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: fn_notify_contract_status(); Type: FUNCTION; Schema: notification; Owner: -
--

CREATE FUNCTION notification.fn_notify_contract_status() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.to_status IN ('terminated', 'breached') THEN
    PERFORM notification.notify(
      'contract_' || NEW.to_status,
      'critical',
      'contract',
      NEW.contract_id,
      'สัญญา ' || NEW.contract_id || ' เปลี่ยนสถานะเป็น ' || NEW.to_status
    );
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: fn_notify_late_repayment(); Type: FUNCTION; Schema: notification; Owner: -
--

CREATE FUNCTION notification.fn_notify_late_repayment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.status = 'paid_late' THEN
    PERFORM notification.notify(
      'loan_repayment_late',
      'warning',
      'contract',
      NEW.contract_id,
      'ชำระคืนสินเชื่อล่าช้า ' || NEW.amount || ' บาท (ครบกำหนด ' || NEW.due_date || ', ชำระจริง ' || NEW.paid_date || ')'
    );
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: fn_notify_low_score(); Type: FUNCTION; Schema: notification; Owner: -
--

CREATE FUNCTION notification.fn_notify_low_score() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.risk_tier = 'D' THEN
    PERFORM notification.notify(
      'credit_score_high_risk',
      'critical',
      'farmer',
      NEW.farmer_id,
      'เกษตรกร ' || NEW.farmer_id || ' มีคะแนนความน่าเชื่อถือ ' || NEW.score_value || ' อยู่ในระดับความเสี่ยง D'
    );
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: notify(text, text, text, uuid, text); Type: FUNCTION; Schema: notification; Owner: -
--

CREATE FUNCTION notification.notify(p_event_type text, p_severity text, p_subject_type text, p_subject_id uuid, p_message text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_notification_id UUID;
BEGIN
  INSERT INTO notification.notification_log (event_type, severity, subject_type, subject_id, message)
  VALUES (p_event_type, p_severity, p_subject_type, p_subject_id, p_message)
  RETURNING notification_id INTO v_notification_id;
  RETURN v_notification_id;
END;
$$;


--
-- Name: record_backup(text, timestamp with time zone, timestamp with time zone, text, text, bigint, bigint, text); Type: FUNCTION; Schema: ops; Owner: -
--

CREATE FUNCTION ops.record_backup(p_backup_type text, p_started_at timestamp with time zone, p_completed_at timestamp with time zone, p_status text, p_file_path text, p_file_size_bytes bigint, p_database_size_bytes bigint, p_notes text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_backup_id UUID;
BEGIN
    INSERT INTO ops.backup_log (
        backup_type, started_at, completed_at, status,
        file_path, file_size_bytes, database_size_bytes, notes
    ) VALUES (
        p_backup_type, p_started_at, p_completed_at, p_status,
        p_file_path, p_file_size_bytes, p_database_size_bytes, p_notes
    ) RETURNING backup_id INTO v_backup_id;
    RETURN v_backup_id;
END;
$$;


--
-- Name: record_benchmark(text, integer, integer, bigint, numeric, numeric, text); Type: FUNCTION; Schema: ops; Owner: -
--

CREATE FUNCTION ops.record_benchmark(p_test_name text, p_concurrent_clients integer, p_duration_seconds integer, p_total_transactions bigint, p_tps numeric, p_latency_avg_ms numeric, p_notes text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_benchmark_id UUID;
BEGIN
    INSERT INTO ops.performance_benchmark (
        test_name, concurrent_clients, duration_seconds,
        total_transactions, tps, latency_avg_ms, notes
    ) VALUES (
        p_test_name, p_concurrent_clients, p_duration_seconds,
        p_total_transactions, p_tps, p_latency_avg_ms, p_notes
    ) RETURNING benchmark_id INTO v_benchmark_id;
    RETURN v_benchmark_id;
END;
$$;


--
-- Name: record_query_observation(text, text, numeric, numeric, text); Type: FUNCTION; Schema: ops; Owner: -
--

CREATE FUNCTION ops.record_query_observation(p_query_label text, p_phase text, p_planning_time_ms numeric, p_execution_time_ms numeric, p_notes text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_observation_id UUID;
BEGIN
    IF p_phase NOT IN ('before_optimization', 'after_optimization') THEN
        RAISE EXCEPTION 'phase ต้องเป็น before_optimization หรือ after_optimization เท่านั้น (ได้รับ: %)', p_phase;
    END IF;

    INSERT INTO ops.query_observation (
        query_label, phase, planning_time_ms, execution_time_ms, notes
    ) VALUES (
        p_query_label, p_phase, p_planning_time_ms, p_execution_time_ms, p_notes
    ) RETURNING observation_id INTO v_observation_id;
    RETURN v_observation_id;
END;
$$;


--
-- Name: record_restore_test(uuid, timestamp with time zone, timestamp with time zone, text, text, boolean, numeric, text); Type: FUNCTION; Schema: ops; Owner: -
--

CREATE FUNCTION ops.record_restore_test(p_backup_id uuid, p_started_at timestamp with time zone, p_completed_at timestamp with time zone, p_target_database text, p_status text, p_rows_verified_ok boolean, p_ledger_variance_after_restore numeric, p_verification_notes text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_restore_test_id UUID;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM ops.backup_log WHERE backup_id = p_backup_id) THEN
        RAISE EXCEPTION 'ไม่พบรายการสำรองข้อมูล (backup_id=%) ที่จะนำมาทดสอบกู้คืน', p_backup_id;
    END IF;

    INSERT INTO ops.restore_test_log (
        backup_id, started_at, completed_at, target_database, status,
        rows_verified_ok, ledger_variance_after_restore, verification_notes
    ) VALUES (
        p_backup_id, p_started_at, p_completed_at, p_target_database, p_status,
        p_rows_verified_ok, p_ledger_variance_after_restore, p_verification_notes
    ) RETURNING restore_test_id INTO v_restore_test_id;
    RETURN v_restore_test_id;
END;
$$;


--
-- Name: activate_vendor(uuid); Type: FUNCTION; Schema: partner; Owner: -
--

CREATE FUNCTION partner.activate_vendor(p_org_id uuid) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_org_type TEXT;
BEGIN
    SELECT org_type INTO v_org_type FROM identity.organization WHERE org_id = p_org_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบองค์กร org_id % ใน identity.organization', p_org_id;
    END IF;
    RETURN partner.activate_vendor_role(p_org_id, v_org_type);
END;
$$;


--
-- Name: FUNCTION activate_vendor(p_org_id uuid); Type: COMMENT; Schema: partner; Owner: -
--

COMMENT ON FUNCTION partner.activate_vendor(p_org_id uuid) IS 'ขยายในขั้นที่ 4: เปิดบัญชี lender_clearing สำหรับผู้ให้กู้ หรือ vendor_settlement สำหรับคู่ค้าทั่วไป แบบ idempotent';


--
-- Name: activate_vendor_role(uuid, text); Type: FUNCTION; Schema: partner; Owner: -
--

CREATE FUNCTION partner.activate_vendor_role(p_org_id uuid, p_role_type text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_role_status TEXT;
    v_account_id  UUID;
BEGIN
    SELECT status INTO v_role_status
    FROM identity.organization_role WHERE org_id = p_org_id AND role_type = p_role_type FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบบทบาท % สำหรับองค์กร % ใน identity.organization_role', p_role_type, p_org_id;
    END IF;

    IF v_role_status <> 'Verified' THEN
        RAISE EXCEPTION 'บทบาท % ขององค์กร % ยังไม่ผ่านการอนุมัติ (สถานะปัจจุบัน = %) จึงเปิดใช้งานเชิงพาณิชย์ไม่ได้', p_role_type, p_org_id, v_role_status;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM partner.vendor_profile WHERE org_id = p_org_id) THEN
        RAISE EXCEPTION 'ยังไม่มีข้อมูล vendor_profile สำหรับ org_id % กรุณาขึ้นทะเบียนข้อมูลเชิงธุรกิจก่อน', p_org_id;
    END IF;

    IF p_role_type = 'Lender' THEN
        SELECT account_id INTO v_account_id
        FROM ledger.account
        WHERE owner_type = 'organization' AND owner_id = p_org_id AND account_type = 'lender_clearing';

        IF v_account_id IS NULL THEN
            INSERT INTO ledger.account (account_type, owner_type, owner_id, currency, status)
            VALUES ('lender_clearing', 'organization', p_org_id, 'THB', 'active')
            RETURNING account_id INTO v_account_id;
        END IF;

        UPDATE partner.vendor_profile
        SET commercial_status = 'active', lender_clearing_account_id = v_account_id,
            activated_at = COALESCE(activated_at, now()), updated_at = now()
        WHERE org_id = p_org_id;
    ELSE
        SELECT account_id INTO v_account_id
        FROM ledger.account
        WHERE owner_type = 'organization' AND owner_id = p_org_id AND account_type = 'vendor_settlement';

        IF v_account_id IS NULL THEN
            INSERT INTO ledger.account (account_type, owner_type, owner_id, currency, status)
            VALUES ('vendor_settlement', 'organization', p_org_id, 'THB', 'active')
            RETURNING account_id INTO v_account_id;
        END IF;

        UPDATE partner.vendor_profile
        SET commercial_status = 'active', settlement_account_id = v_account_id,
            activated_at = COALESCE(activated_at, now()), updated_at = now()
        WHERE org_id = p_org_id;
    END IF;

    RETURN p_org_id;
END;
$$;


--
-- Name: confirm_quality(uuid, text, boolean, text); Type: FUNCTION; Schema: produce; Owner: -
--

CREATE FUNCTION produce.confirm_quality(p_delivery_id uuid, p_quality_grade text, p_accepted boolean, p_inspected_by text) RETURNS void
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
        quality_grade = p_quality_grade, inspected_by = p_inspected_by, inspected_at = now()
    WHERE delivery_id = p_delivery_id;
END;
$$;


--
-- Name: record_delivery(uuid, uuid, text, numeric, uuid, uuid, numeric); Type: FUNCTION; Schema: produce; Owner: -
--

CREATE FUNCTION produce.record_delivery(p_unit_id uuid, p_buyer_org_id uuid, p_commodity_code text, p_quantity_ton numeric, p_contract_id uuid DEFAULT NULL::uuid, p_cycle_id uuid DEFAULT NULL::uuid, p_unit_price numeric DEFAULT NULL::numeric) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_contract_status   TEXT;
    v_price                NUMERIC(18,2);
    v_delivery_id             UUID;
BEGIN
    IF p_contract_id IS NOT NULL THEN
        SELECT status, agreed_unit_price INTO v_contract_status, v_price
        FROM contract.contract WHERE contract_id = p_contract_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'ไม่พบสัญญา %', p_contract_id;
        END IF;
        IF v_contract_status <> 'active' THEN
            RAISE EXCEPTION 'สัญญา % อยู่ในสถานะ % ต้อง active เท่านั้นจึงจะส่งมอบผลผลิตได้', p_contract_id, v_contract_status;
        END IF;
        IF v_price IS NULL THEN
            RAISE EXCEPTION 'สัญญา % ไม่มีราคาที่ตกลงกัน (agreed_unit_price)', p_contract_id;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM contract.contract_party WHERE contract_id = p_contract_id AND party_role = 'buyer' AND party_id = p_buyer_org_id) THEN
            RAISE EXCEPTION 'org_id % ไม่ใช่ผู้ซื้อในสัญญา %', p_buyer_org_id, p_contract_id;
        END IF;
    ELSE
        v_price := p_unit_price;
        IF v_price IS NULL THEN
            RAISE EXCEPTION 'ต้องระบุ p_unit_price เมื่อส่งมอบแบบไม่มีสัญญา (Spot Sale)';
        END IF;
    END IF;

    INSERT INTO produce.delivery (contract_id, cycle_id, unit_id, buyer_org_id, commodity_code, quantity_ton, unit_price, total_amount)
    VALUES (p_contract_id, p_cycle_id, p_unit_id, p_buyer_org_id, p_commodity_code, p_quantity_ton, v_price, p_quantity_ton * v_price)
    RETURNING delivery_id INTO v_delivery_id;

    RETURN v_delivery_id;
END;
$$;


--
-- Name: settle_delivery(uuid); Type: FUNCTION; Schema: produce; Owner: -
--

CREATE FUNCTION produce.settle_delivery(p_delivery_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_status              TEXT;
    v_unit_id                UUID;
    v_buyer_org_id              UUID;
    v_total_amount                 NUMERIC(18,2);
    v_contract_id                     UUID;
    v_buyer_account_id                   UUID;
    v_wallet_account_id                     UUID;
    v_entry_id                                 UUID;
    v_agreed_quantity                             NUMERIC(12,3);
    v_delivered_quantity                             NUMERIC(12,3);
BEGIN
    SELECT status, unit_id, buyer_org_id, total_amount, contract_id
    INTO v_status, v_unit_id, v_buyer_org_id, v_total_amount, v_contract_id
    FROM produce.delivery WHERE delivery_id = p_delivery_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบการส่งมอบ %', p_delivery_id;
    END IF;
    IF v_status <> 'accepted' THEN
        RAISE EXCEPTION 'การส่งมอบ % อยู่ในสถานะ % ต้องผ่านการตรวจคุณภาพ (accepted) ก่อนจึงจะชำระเงินได้', p_delivery_id, v_status;
    END IF;

    SELECT settlement_account_id INTO v_buyer_account_id FROM partner.vendor_profile WHERE org_id = v_buyer_org_id;
    SELECT account_id INTO v_wallet_account_id FROM ledger.account WHERE account_type = 'unit_wallet' AND owner_id = v_unit_id;

    IF v_buyer_account_id IS NULL THEN
        RAISE EXCEPTION 'ผู้ซื้อ % ยังไม่มีบัญชี vendor_settlement (ต้องเรียก partner.activate_vendor ก่อน)', v_buyer_org_id;
    END IF;

    v_entry_id := ledger.transfer_funds(
        p_from_account := v_buyer_account_id,
        p_to_account   := v_wallet_account_id,
        p_amount       := v_total_amount,
        p_entry_type   := 'Settlement',
        p_description  := 'ชำระค่าผลผลิตสำหรับการส่งมอบ ' || p_delivery_id::text,
        p_reference_type := 'produce_delivery',
        p_reference_id    := p_delivery_id
    );

    UPDATE produce.delivery
    SET status = 'settled', settled_at = now(), settlement_entry_id = v_entry_id
    WHERE delivery_id = p_delivery_id;

    -- ปิดสัญญาอัตโนมัติเมื่อส่งมอบครบตามปริมาณที่ตกลงกัน
    IF v_contract_id IS NOT NULL THEN
        SELECT agreed_quantity INTO v_agreed_quantity FROM contract.contract WHERE contract_id = v_contract_id;

        SELECT COALESCE(sum(quantity_ton), 0) INTO v_delivered_quantity
        FROM produce.delivery WHERE contract_id = v_contract_id AND status = 'settled';

        IF v_agreed_quantity IS NOT NULL AND v_delivered_quantity >= v_agreed_quantity THEN
            UPDATE contract.contract SET status = 'completed'
            WHERE contract_id = v_contract_id AND status = 'active';
        END IF;
    END IF;

    RETURN v_entry_id;
END;
$$;


--
-- Name: FUNCTION settle_delivery(p_delivery_id uuid); Type: COMMENT; Schema: produce; Owner: -
--

COMMENT ON FUNCTION produce.settle_delivery(p_delivery_id uuid) IS 'เรียก ledger.transfer_funds() ของขั้นที่ 2 โดยตรง และปิดสัญญาของขั้นที่ 3 อัตโนมัติ (status=completed) เมื่อส่งมอบครบตามปริมาณที่ตกลงกัน';


--
-- Name: generate_stage_calendar(uuid); Type: FUNCTION; Schema: production; Owner: -
--

CREATE FUNCTION production.generate_stage_calendar(p_cycle_id uuid) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_commodity_code   TEXT;
    v_start_date          DATE;
    v_count                  INT;
BEGIN
    SELECT commodity_code, planned_start_date INTO v_commodity_code, v_start_date
    FROM production.crop_cycle WHERE cycle_id = p_cycle_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบรอบการผลิต %', p_cycle_id;
    END IF;

    IF EXISTS (SELECT 1 FROM production.stage_calendar WHERE cycle_id = p_cycle_id) THEN
        RAISE EXCEPTION 'รอบการผลิต % มีปฏิทินงวดอยู่แล้ว ไม่สร้างซ้ำ', p_cycle_id;
    END IF;

    INSERT INTO production.stage_calendar (cycle_id, stage_seq, stage_name, planned_date)
    SELECT p_cycle_id, st.stage_seq, st.stage_name, v_start_date + st.typical_offset_days
    FROM production.stage_template st
    WHERE st.commodity_code = v_commodity_code
    ORDER BY st.stage_seq;

    GET DIAGNOSTICS v_count = ROW_COUNT;

    IF v_count = 0 THEN
        RAISE EXCEPTION 'ไม่พบ stage_template สำหรับพืช % กรุณาขึ้นทะเบียนงวดมาตรฐานก่อน', v_commodity_code;
    END IF;

    UPDATE production.crop_cycle
    SET status = 'active',
        planned_harvest_date = (SELECT max(planned_date) FROM production.stage_calendar WHERE cycle_id = p_cycle_id)
    WHERE cycle_id = p_cycle_id;

    RETURN v_count;
END;
$$;


--
-- Name: verify_stage(uuid, text, text); Type: FUNCTION; Schema: production; Owner: -
--

CREATE FUNCTION production.verify_stage(p_stage_id uuid, p_verification_ref text, p_verified_by text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_status              TEXT;
    v_cycle_id              UUID;
    v_stage_seq               INT;
    v_unit_id                   UUID;
    v_linked_contract_id           UUID;
    v_expected_ref                    TEXT;
    v_hold_id                            UUID;
    v_wallet_account_id                     UUID;
    v_release_entry_id                         UUID;
    v_remaining_count                             INT;
BEGIN
    SELECT sc.status, sc.cycle_id, sc.stage_seq
    INTO v_status, v_cycle_id, v_stage_seq
    FROM production.stage_calendar sc WHERE sc.stage_id = p_stage_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบงวด %', p_stage_id;
    END IF;

    IF v_status NOT IN ('pending','in_progress') THEN
        RAISE EXCEPTION 'งวด % อยู่ในสถานะ % แล้ว ไม่สามารถยืนยันซ้ำได้', p_stage_id, v_status;
    END IF;

    UPDATE production.stage_calendar
    SET status = 'verified', actual_date = CURRENT_DATE,
        verification_ref = p_verification_ref, verified_by = p_verified_by, verified_at = now()
    WHERE stage_id = p_stage_id;

    SELECT unit_id, linked_contract_id INTO v_unit_id, v_linked_contract_id
    FROM production.crop_cycle WHERE cycle_id = v_cycle_id;

    IF v_linked_contract_id IS NOT NULL THEN
        v_expected_ref := 'Contract:' || v_linked_contract_id::text || '_Stage' || v_stage_seq::text;

        SELECT hold_id INTO v_hold_id
        FROM ledger.escrow_hold
        WHERE release_condition_ref = v_expected_ref AND status = 'held'
        FOR UPDATE;

        IF v_hold_id IS NOT NULL THEN
            SELECT account_id INTO v_wallet_account_id
            FROM ledger.account WHERE account_type = 'unit_wallet' AND owner_id = v_unit_id;

            IF v_wallet_account_id IS NULL THEN
                RAISE EXCEPTION 'ไม่พบบัญชี unit_wallet ของหน่วยผลิต %', v_unit_id;
            END IF;

            v_release_entry_id := ledger.release_escrow(v_hold_id, v_wallet_account_id);
        END IF;
    END IF;

    -- ส่วนขยายขั้นที่ 5: ปิดรอบการผลิตอัตโนมัติเมื่อไม่มีงวดใดค้างอยู่ (pending/in_progress) แล้ว
    SELECT count(*) INTO v_remaining_count
    FROM production.stage_calendar
    WHERE cycle_id = v_cycle_id AND status IN ('pending','in_progress');

    IF v_remaining_count = 0 THEN
        UPDATE production.crop_cycle
        SET status = 'completed', actual_harvest_date = COALESCE(actual_harvest_date, CURRENT_DATE)
        WHERE cycle_id = v_cycle_id AND status <> 'completed';
    END IF;

    RETURN v_release_entry_id;
END;
$$;


--
-- Name: FUNCTION verify_stage(p_stage_id uuid, p_verification_ref text, p_verified_by text); Type: COMMENT; Schema: production; Owner: -
--

COMMENT ON FUNCTION production.verify_stage(p_stage_id uuid, p_verification_ref text, p_verified_by text) IS 'ขยายในขั้นที่ 5: เพิ่มการปิดรอบการผลิตอัตโนมัติ (status=completed) เมื่อทุกงวดยืนยัน/ข้ามครบแล้ว นอกเหนือจากหน้าที่เดิมในขั้นที่ 4 คือปลดล็อก Escrow อัตโนมัติ';


--
-- Name: purge_expired_rows(text, text); Type: FUNCTION; Schema: retention; Owner: -
--

CREATE FUNCTION retention.purge_expired_rows(p_table_schema text, p_table_name text) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_policy       RECORD;
    v_rows_deleted BIGINT;
BEGIN
    SELECT * INTO v_policy
    FROM retention.retention_policy
    WHERE table_schema = p_table_schema AND table_name = p_table_name;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบนโยบายเก็บรักษาข้อมูลสำหรับ %.% — ปฏิเสธการล้างข้อมูลเพื่อความปลอดภัย (ต้องกำหนดนโยบายก่อนเสมอ)',
            p_table_schema, p_table_name;
    END IF;

    EXECUTE format(
        'DELETE FROM %I.%I WHERE %I < now() - (%L || '' days'')::interval',
        v_policy.table_schema, v_policy.table_name, v_policy.date_column, v_policy.retain_days
    );
    GET DIAGNOSTICS v_rows_deleted = ROW_COUNT;

    UPDATE retention.retention_policy
    SET last_purged_at = now(), rows_purged_last_run = v_rows_deleted
    WHERE policy_id = v_policy.policy_id;

    RETURN v_rows_deleted;
END;
$$;


--
-- Name: compute_all_scores(); Type: FUNCTION; Schema: risk; Owner: -
--

CREATE FUNCTION risk.compute_all_scores() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_farmer_id  UUID;
    v_count        INT := 0;
BEGIN
    FOR v_farmer_id IN
        SELECT DISTINCT owner_farmer_id FROM registry.production_unit
    LOOP
        PERFORM risk.compute_credit_score(v_farmer_id);
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$;


--
-- Name: compute_credit_score(uuid); Type: FUNCTION; Schema: risk; Owner: -
--

CREATE FUNCTION risk.compute_credit_score(p_farmer_id uuid) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_production_total     INT;
    v_production_on_time     INT;
    v_production_factor        NUMERIC;
    v_contract_total               INT;
    v_contract_completed              INT;
    v_contract_factor                    NUMERIC;
    v_repayment_total                        INT;
    v_repayment_on_time                         INT;
    v_repayment_factor                             NUMERIC;
    v_delivery_total                                   INT;
    v_delivery_settled                                    INT;
    v_delivery_factor                                        NUMERIC;
    v_weight_sum          NUMERIC := 0;
    v_score_sum              NUMERIC := 0;
    v_score_value                NUMERIC(5,2);
    v_risk_tier                      TEXT;
    v_factors                            JSONB;
    v_score_id                              UUID;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.farmer WHERE farmer_id = p_farmer_id) THEN
        RAISE EXCEPTION 'ไม่พบเกษตรกร %', p_farmer_id;
    END IF;

    -- ปัจจัยที่ 1: ความสม่ำเสมอการยืนยันงวดตามแผน (น้ำหนัก 30%)
    SELECT count(*), count(*) FILTER (WHERE sc.actual_date <= sc.planned_date)
    INTO v_production_total, v_production_on_time
    FROM production.stage_calendar sc
    JOIN production.crop_cycle cc ON cc.cycle_id = sc.cycle_id
    JOIN registry.production_unit pu ON pu.unit_id = cc.unit_id
    WHERE pu.owner_farmer_id = p_farmer_id AND sc.status = 'verified';

    IF v_production_total > 0 THEN
        v_production_factor := 100.0 * v_production_on_time / v_production_total;
        v_weight_sum := v_weight_sum + 30; v_score_sum := v_score_sum + v_production_factor * 30;
    END IF;

    -- ปัจจัยที่ 2: อัตราสัญญาที่จบสมบูรณ์ (completed) เทียบกับสัญญาที่ถึงจุดสิ้นสุดแล้วทั้งหมด (น้ำหนัก 25%)
    SELECT count(DISTINCT c.contract_id) FILTER (WHERE c.status IN ('completed','terminated','breached')),
           count(DISTINCT c.contract_id) FILTER (WHERE c.status = 'completed')
    INTO v_contract_total, v_contract_completed
    FROM contract.contract c
    JOIN contract.contract_party cp ON cp.contract_id = c.contract_id
    WHERE cp.party_type = 'farmer' AND cp.party_id = p_farmer_id;

    IF v_contract_total > 0 THEN
        v_contract_factor := 100.0 * v_contract_completed / v_contract_total;
        v_weight_sum := v_weight_sum + 25; v_score_sum := v_score_sum + v_contract_factor * 25;
    END IF;

    -- ปัจจัยที่ 3: อัตราการชำระคืนสินเชื่อตรงเวลา (น้ำหนัก 25%)
    SELECT count(r.repayment_id), count(r.repayment_id) FILTER (WHERE r.status = 'paid_on_time')
    INTO v_repayment_total, v_repayment_on_time
    FROM credit.loan_repayment r
    JOIN contract.contract c ON c.contract_id = r.contract_id
    JOIN contract.contract_party cp ON cp.contract_id = c.contract_id
    WHERE cp.party_type = 'farmer' AND cp.party_id = p_farmer_id;

    IF v_repayment_total > 0 THEN
        v_repayment_factor := 100.0 * v_repayment_on_time / v_repayment_total;
        v_weight_sum := v_weight_sum + 25; v_score_sum := v_score_sum + v_repayment_factor * 25;
    END IF;

    -- ปัจจัยที่ 4: อัตราการส่งมอบผลผลิตที่ชำระเงินสำเร็จ (ไม่ถูกปฏิเสธคุณภาพ) (น้ำหนัก 20%)
    SELECT count(d.delivery_id) FILTER (WHERE d.status IN ('settled','rejected')),
           count(d.delivery_id) FILTER (WHERE d.status = 'settled')
    INTO v_delivery_total, v_delivery_settled
    FROM produce.delivery d
    JOIN registry.production_unit pu ON pu.unit_id = d.unit_id
    WHERE pu.owner_farmer_id = p_farmer_id;

    IF v_delivery_total > 0 THEN
        v_delivery_factor := 100.0 * v_delivery_settled / v_delivery_total;
        v_weight_sum := v_weight_sum + 20; v_score_sum := v_score_sum + v_delivery_factor * 20;
    END IF;

    IF v_weight_sum = 0 THEN
        v_score_value := 50.00;
    ELSE
        v_score_value := round(v_score_sum / v_weight_sum, 2);
    END IF;

    v_risk_tier := CASE
        WHEN v_score_value >= 80 THEN 'A'
        WHEN v_score_value >= 60 THEN 'B'
        WHEN v_score_value >= 40 THEN 'C'
        ELSE 'D'
    END;

    v_factors := jsonb_build_object(
        'production_reliability', jsonb_build_object('total', v_production_total, 'on_time', v_production_on_time, 'factor_score', v_production_factor),
        'contract_fulfillment', jsonb_build_object('total', v_contract_total, 'completed', v_contract_completed, 'factor_score', v_contract_factor),
        'loan_repayment', jsonb_build_object('total', v_repayment_total, 'on_time', v_repayment_on_time, 'factor_score', v_repayment_factor),
        'delivery_quality', jsonb_build_object('total', v_delivery_total, 'settled', v_delivery_settled, 'factor_score', v_delivery_factor),
        'weight_sum_used', v_weight_sum,
        'insufficient_data', (v_weight_sum = 0)
    );

    INSERT INTO risk.credit_score (farmer_id, score_value, risk_tier, factors)
    VALUES (p_farmer_id, v_score_value, v_risk_tier, v_factors)
    RETURNING score_id INTO v_score_id;

    UPDATE identity.farmer SET trust_score = v_score_value, updated_at = now() WHERE farmer_id = p_farmer_id;

    RETURN v_score_id;
END;
$$;


--
-- Name: FUNCTION compute_credit_score(p_farmer_id uuid); Type: COMMENT; Schema: risk; Owner: -
--

COMMENT ON FUNCTION risk.compute_credit_score(p_farmer_id uuid) IS 'อ่านประวัติจากขั้นที่ 4 (ความสม่ำเสมอการยืนยันงวด) ขั้นที่ 3 (การทำสัญญาสำเร็จ) ขั้นที่ 6 เอง (การชำระคืนสินเชื่อ) และขั้นที่ 5 (คุณภาพการส่งมอบ) โดยตรง ไม่เก็บข้อมูลซ้ำ แล้วอัปเดต identity.farmer.trust_score ของขั้นที่ 1 เป็นครั้งแรกนับตั้งแต่สร้างคอลัมน์นี้ไว้';


--
-- Name: link_external_identity(text, uuid, text); Type: FUNCTION; Schema: security; Owner: -
--

CREATE FUNCTION security.link_external_identity(p_subject_type text, p_subject_id uuid, p_external_subject_claim text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF p_subject_type = 'farmer' THEN
    IF NOT EXISTS (SELECT 1 FROM identity.farmer WHERE farmer_id = p_subject_id) THEN
      RAISE EXCEPTION 'ไม่พบเกษตรกรรหัส %', p_subject_id;
    END IF;
    UPDATE identity.farmer SET auth_subject_id = p_external_subject_claim, updated_at = now()
    WHERE farmer_id = p_subject_id;
  ELSIF p_subject_type = 'organization' THEN
    IF NOT EXISTS (SELECT 1 FROM identity.organization WHERE org_id = p_subject_id) THEN
      RAISE EXCEPTION 'ไม่พบองค์กรรหัส %', p_subject_id;
    END IF;
    UPDATE identity.organization SET auth_subject_id = p_external_subject_claim, updated_at = now()
    WHERE org_id = p_subject_id;
  ELSE
    RAISE EXCEPTION 'ประเภทผู้ใช้งานไม่ถูกต้อง: % (ต้องเป็น farmer หรือ organization เท่านั้น)', p_subject_type;
  END IF;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'Claim ภายนอก % ถูกผูกกับผู้ใช้งานรายอื่นไปแล้ว ไม่สามารถผูกซ้ำได้', p_external_subject_claim;
END;
$$;


--
-- Name: resolve_subject_from_external_claim(text); Type: FUNCTION; Schema: security; Owner: -
--

CREATE FUNCTION security.resolve_subject_from_external_claim(p_external_subject_claim text) RETURNS TABLE(subject_type text, subject_id uuid)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    AS $$
BEGIN
  RETURN QUERY
  SELECT 'farmer'::text, f.farmer_id FROM identity.farmer f WHERE f.auth_subject_id = p_external_subject_claim
  UNION ALL
  SELECT 'organization'::text, o.org_id FROM identity.organization o WHERE o.auth_subject_id = p_external_subject_claim;
END;
$$;


--
-- Name: set_session_context(text, uuid); Type: FUNCTION; Schema: security; Owner: -
--

CREATE FUNCTION security.set_session_context(p_subject_type text, p_subject_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  IF p_subject_type NOT IN ('farmer', 'organization', 'platform') THEN
    RAISE EXCEPTION 'ประเภทผู้ใช้งานไม่ถูกต้อง: % (ต้องเป็น farmer, organization หรือ platform)', p_subject_type;
  END IF;

  IF p_subject_type <> 'platform' THEN
    IF p_subject_id IS NULL THEN
      RAISE EXCEPTION 'ต้องระบุ subject_id สำหรับผู้ใช้งานประเภท %', p_subject_type;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM identity.subject_role
      WHERE subject_type = p_subject_type AND subject_id = p_subject_id
    ) THEN
      RAISE EXCEPTION 'ผู้ใช้งาน % (%) ยังไม่ได้รับสิทธิ์ (Role) ใดๆ ในระบบ ไม่สามารถเข้าใช้งานได้', p_subject_type, p_subject_id;
    END IF;
  END IF;

  PERFORM set_config('app.subject_type', p_subject_type, false);
  PERFORM set_config('app.subject_id', COALESCE(p_subject_id::text, ''), false);
END;
$$;


--
-- Name: issue_certificate(uuid, text, text); Type: FUNCTION; Schema: traceability; Owner: -
--

CREATE FUNCTION traceability.issue_certificate(p_delivery_id uuid, p_certificate_type text, p_issued_by text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_status          TEXT;
    v_unit_id           UUID;
    v_cycle_id             UUID;
    v_geo_boundary            GEOMETRY(Polygon, 4326);
    v_stage_digest               TEXT;
    v_certificate_ref               TEXT;
    v_certificate_id                   UUID;
BEGIN
    SELECT status, unit_id, cycle_id INTO v_status, v_unit_id, v_cycle_id
    FROM produce.delivery WHERE delivery_id = p_delivery_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบการส่งมอบ %', p_delivery_id;
    END IF;
    IF v_status <> 'settled' THEN
        RAISE EXCEPTION 'การส่งมอบ % ยังไม่ได้ชำระเงิน (สถานะปัจจุบัน %) จึงยังออกใบรับรองไม่ได้', p_delivery_id, v_status;
    END IF;

    SELECT gps_boundary INTO v_geo_boundary FROM registry.production_unit WHERE unit_id = v_unit_id;

    SELECT encode(sha256(string_agg(stage_id::text || ':' || coalesce(verification_ref,'') , '|' ORDER BY stage_seq)::bytea), 'hex')
    INTO v_stage_digest
    FROM production.stage_calendar
    WHERE cycle_id = v_cycle_id AND status = 'verified';

    v_certificate_ref := 'AGL-CERT-' || encode(sha256((p_delivery_id::text || ':' || coalesce(v_stage_digest,''))::bytea), 'hex');

    INSERT INTO traceability.certificate (delivery_id, unit_id, cycle_id, certificate_type, geo_boundary_snapshot, certificate_ref, issued_by)
    VALUES (p_delivery_id, v_unit_id, v_cycle_id, p_certificate_type, v_geo_boundary, v_certificate_ref, p_issued_by)
    RETURNING certificate_id INTO v_certificate_id;

    RETURN v_certificate_id;
END;
$$;


--
-- Name: FUNCTION issue_certificate(p_delivery_id uuid, p_certificate_type text, p_issued_by text); Type: COMMENT; Schema: traceability; Owner: -
--

COMMENT ON FUNCTION traceability.issue_certificate(p_delivery_id uuid, p_certificate_type text, p_issued_by text) IS 'ออกใบรับรองได้เฉพาะการส่งมอบที่ settled แล้วเท่านั้น certificate_ref เป็นแฮชที่ผูกกับประวัติงวดที่ยืนยันแล้วทั้งหมดของรอบการผลิต ทำให้ตรวจสอบย้อนกลับและพิสูจน์ความไม่ถูกแก้ไขได้';


--
-- Name: approve_application(uuid, numeric); Type: FUNCTION; Schema: underwriting; Owner: -
--

CREATE FUNCTION underwriting.approve_application(p_application_id uuid, p_final_amount numeric DEFAULT NULL::numeric) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_app underwriting.loan_application%ROWTYPE;
  v_final_amount NUMERIC(18,2);
  v_contract_id UUID;
BEGIN
  SELECT * INTO v_app FROM underwriting.loan_application WHERE application_id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบใบสมัครรหัส %', p_application_id;
  END IF;
  IF v_app.status NOT IN ('approved','manual_review') THEN
    RAISE EXCEPTION 'ใบสมัคร % อยู่ในสถานะ % ต้องเป็น approved หรือ manual_review เท่านั้นจึงจะแปลงเป็นสัญญาได้', p_application_id, v_app.status;
  END IF;

  v_final_amount := COALESCE(p_final_amount, v_app.approved_amount);
  IF v_final_amount IS NULL OR v_final_amount <= 0 THEN
    RAISE EXCEPTION 'ต้องระบุวงเงินอนุมัติสุดท้ายที่มากกว่า 0';
  END IF;

  INSERT INTO contract.contract (contract_type, status, related_unit_id, principal_amount, currency, effective_date, terms_summary)
  VALUES ('loan_agreement', 'draft', v_app.related_unit_id, v_final_amount, 'THB', CURRENT_DATE,
          'สินเชื่ออนุมัติผ่านระบบพิจารณาสินเชื่ออัตโนมัติ G-12 อ้างอิงใบสมัคร ' || p_application_id)
  RETURNING contract_id INTO v_contract_id;

  INSERT INTO contract.contract_party (contract_id, party_role, party_type, party_id) VALUES
    (v_contract_id, 'farmer', 'farmer', v_app.farmer_id),
    (v_contract_id, 'lender', 'organization', v_app.lender_org_id);

  UPDATE underwriting.loan_application
  SET status = 'converted', contract_id = v_contract_id, decided_at = now()
  WHERE application_id = p_application_id;

  RETURN v_contract_id;
END;
$$;


--
-- Name: decline_application(uuid, text); Type: FUNCTION; Schema: underwriting; Owner: -
--

CREATE FUNCTION underwriting.decline_application(p_application_id uuid, p_reason text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM underwriting.loan_application WHERE application_id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบใบสมัครรหัส %', p_application_id;
  END IF;
  IF v_status NOT IN ('approved','manual_review') THEN
    RAISE EXCEPTION 'ใบสมัคร % อยู่ในสถานะ % ไม่สามารถปฏิเสธด้วยมือได้ (ต้องเป็น approved หรือ manual_review)', p_application_id, v_status;
  END IF;

  UPDATE underwriting.loan_application
  SET status = 'declined',
      decision_reason = COALESCE(p_reason, decision_reason),
      decided_at = now()
  WHERE application_id = p_application_id;

  RETURN p_application_id;
END;
$$;


--
-- Name: evaluate_application(uuid); Type: FUNCTION; Schema: underwriting; Owner: -
--

CREATE FUNCTION underwriting.evaluate_application(p_application_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_app underwriting.loan_application%ROWTYPE;
  v_score risk.v_farmer_latest_score%ROWTYPE;
  v_policy underwriting.loan_policy%ROWTYPE;
  v_status TEXT;
  v_approved_amount NUMERIC(18,2);
  v_reason TEXT;
BEGIN
  SELECT * INTO v_app FROM underwriting.loan_application WHERE application_id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบใบสมัครรหัส %', p_application_id;
  END IF;
  IF v_app.status <> 'pending' THEN
    RAISE EXCEPTION 'ใบสมัคร % อยู่ในสถานะ % แล้ว ต้องเป็น pending เท่านั้นจึงจะประเมินได้', p_application_id, v_app.status;
  END IF;

  SELECT * INTO v_score FROM risk.v_farmer_latest_score WHERE farmer_id = v_app.farmer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'เกษตรกร % ยังไม่มีคะแนนความน่าเชื่อถือในระบบ ต้องเรียก risk.compute_credit_score() ก่อนยื่นพิจารณา', v_app.farmer_id;
  END IF;

  SELECT * INTO v_policy FROM underwriting.loan_policy WHERE risk_tier = v_score.risk_tier;

  IF v_score.risk_tier = 'D' THEN
    v_status := 'declined';
    v_approved_amount := NULL;
    v_reason := 'ระดับความเสี่ยงสูงเกินกว่าจะอนุมัติสินเชื่อได้ (risk_tier D, คะแนน ' || v_score.score_value || ')';
  ELSIF v_app.requested_amount <= v_policy.max_principal_amount AND v_policy.auto_approve THEN
    v_status := 'approved';
    v_approved_amount := v_app.requested_amount;
    v_reason := 'อนุมัติอัตโนมัติตามนโยบายระดับความเสี่ยง ' || v_score.risk_tier || ' (คะแนน ' || v_score.score_value || ', วงเงินขออยู่ในเพดาน ' || v_policy.max_principal_amount || ' บาท)';
  ELSIF v_app.requested_amount <= v_policy.max_principal_amount AND NOT v_policy.auto_approve THEN
    v_status := 'manual_review';
    v_approved_amount := v_app.requested_amount;
    v_reason := 'วงเงินที่ขออยู่ในเพดานของระดับความเสี่ยง ' || v_score.risk_tier || ' แต่นโยบายกำหนดให้ต้องผ่านการพิจารณาโดยเจ้าหน้าที่เสมอ';
  ELSE
    v_status := 'manual_review';
    v_approved_amount := v_policy.max_principal_amount;
    v_reason := 'วงเงินที่ขอ (' || v_app.requested_amount || ' บาท) เกินเพดานของระดับความเสี่ยง ' || v_score.risk_tier || ' (' || v_policy.max_principal_amount || ' บาท) เสนอวงเงินทางเลือกที่เพดาน รอการพิจารณาโดยเจ้าหน้าที่';
  END IF;

  UPDATE underwriting.loan_application
  SET status = v_status,
      score_id = v_score.score_id,
      risk_tier_at_decision = v_score.risk_tier,
      decision_reason = v_reason,
      approved_amount = v_approved_amount,
      decided_at = now()
  WHERE application_id = p_application_id;

  RETURN p_application_id;
END;
$$;


--
-- Name: submit_application(uuid, uuid, uuid, numeric, text); Type: FUNCTION; Schema: underwriting; Owner: -
--

CREATE FUNCTION underwriting.submit_application(p_farmer_id uuid, p_lender_org_id uuid, p_related_unit_id uuid, p_requested_amount numeric, p_purpose text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_application_id UUID;
  v_org_type TEXT;
  v_commercial_status TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM identity.farmer WHERE farmer_id = p_farmer_id) THEN
    RAISE EXCEPTION 'ไม่พบเกษตรกรรหัส %', p_farmer_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM registry.production_unit
    WHERE unit_id = p_related_unit_id AND owner_farmer_id = p_farmer_id
  ) THEN
    RAISE EXCEPTION 'หน่วยผลิต % ไม่ใช่ของเกษตรกร %', p_related_unit_id, p_farmer_id;
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

  INSERT INTO underwriting.loan_application (farmer_id, lender_org_id, related_unit_id, requested_amount, purpose)
  VALUES (p_farmer_id, p_lender_org_id, p_related_unit_id, p_requested_amount, p_purpose)
  RETURNING application_id INTO v_application_id;

  RETURN v_application_id;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: access_log; Type: TABLE; Schema: audit; Owner: -
--

CREATE TABLE audit.access_log (
    access_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid,
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT access_log_action_check CHECK ((action = ANY (ARRAY['read'::text, 'write'::text]))),
    CONSTRAINT access_log_subject_type_check CHECK ((subject_type = ANY (ARRAY['farmer'::text, 'organization'::text, 'platform'::text])))
);


--
-- Name: TABLE access_log; Type: COMMENT; Schema: audit; Owner: -
--

COMMENT ON TABLE audit.access_log IS 'บันทึกการเข้าถึงข้อมูลแบบ Append-only แยกจาก notification.notification_log (ขั้นที่ 7) โดยเจตนา — notification_log บันทึกเหตุการณ์ทางธุรกิจที่ต้องแจ้งผู้ใช้ ส่วน access_log บันทึกร่องรอยทางเทคนิคว่าใครอ่าน/เขียนข้อมูลใดเมื่อใด สำหรับการสอบทานด้านความปลอดภัยข้อมูลส่วนบุคคลโดยเฉพาะ ไม่มีคอลัมน์ใดแก้ไขได้เลยแม้แต่ is_read';


--
-- Name: farmer; Type: TABLE; Schema: identity; Owner: -
--

CREATE TABLE identity.farmer (
    farmer_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    national_id_hash text NOT NULL,
    full_name text NOT NULL,
    phone text NOT NULL,
    region_code text NOT NULL,
    farmbook_ref_id text,
    trust_score numeric(5,2) DEFAULT 0 NOT NULL,
    auth_subject_id text,
    status text DEFAULT 'pending_kyc'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT farmer_status_check CHECK ((status = ANY (ARRAY['pending_kyc'::text, 'active'::text, 'suspended'::text, 'closed'::text]))),
    CONSTRAINT farmer_trust_score_check CHECK (((trust_score >= (0)::numeric) AND (trust_score <= (100)::numeric)))
);


--
-- Name: TABLE farmer; Type: COMMENT; Schema: identity; Owner: -
--

COMMENT ON TABLE identity.farmer IS 'แหล่งความจริงเดียวของตัวตนเกษตรกร — มาตรฐาน: W3C DID & VC, ISO 3166-2:TH';


--
-- Name: COLUMN farmer.national_id_hash; Type: COMMENT; Schema: identity; Owner: -
--

COMMENT ON COLUMN identity.farmer.national_id_hash IS 'ห้ามเก็บเลขบัตรประชาชนแบบ plaintext ตามหลัก PDPA Data Minimization';


--
-- Name: organization; Type: TABLE; Schema: identity; Owner: -
--

CREATE TABLE identity.organization (
    org_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    org_type text NOT NULL,
    org_name text NOT NULL,
    tax_id text NOT NULL,
    kyb_status text DEFAULT 'Pending'::text NOT NULL,
    verified_badge boolean DEFAULT false NOT NULL,
    auth_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_kyb_status_check CHECK ((kyb_status = ANY (ARRAY['Pending'::text, 'Verified'::text, 'Rejected'::text]))),
    CONSTRAINT organization_org_type_check CHECK ((org_type = ANY (ARRAY['Cooperative'::text, 'Mill'::text, 'Bank'::text, 'InputSupplier'::text, 'Lender'::text, 'Logistics'::text, 'Buyer'::text, 'VillageFund'::text, 'TractorService'::text, 'DroneService'::text, 'HarvesterService'::text, 'TruckService'::text, 'DryingYardService'::text])))
);


--
-- Name: TABLE organization; Type: COMMENT; Schema: identity; Owner: -
--

COMMENT ON TABLE identity.organization IS 'คู่ค้านิติบุคคล เช่น สหกรณ์ ท่าข้าว/โรงสี ธนาคาร ผู้ให้บริการ — มาตรฐาน: FATF KYC/AML, eIDAS-inspired Trust Framework';


--
-- Name: v_recent_access; Type: VIEW; Schema: audit; Owner: -
--

CREATE VIEW audit.v_recent_access AS
 SELECT al.access_id,
    al.subject_type,
    al.subject_id,
        CASE al.subject_type
            WHEN 'farmer'::text THEN f.full_name
            WHEN 'organization'::text THEN o.org_name
            ELSE 'platform'::text
        END AS subject_name,
    al.action,
    al.resource_type,
    al.resource_id,
    al.occurred_at
   FROM ((audit.access_log al
     LEFT JOIN identity.farmer f ON (((al.subject_type = 'farmer'::text) AND (f.farmer_id = al.subject_id))))
     LEFT JOIN identity.organization o ON (((al.subject_type = 'organization'::text) AND (o.org_id = al.subject_id))))
  ORDER BY al.occurred_at DESC;


--
-- Name: contract; Type: TABLE; Schema: contract; Owner: -
--

CREATE TABLE contract.contract (
    contract_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    contract_type text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    related_unit_id uuid,
    principal_amount numeric(18,2),
    currency character(3) DEFAULT 'THB'::bpchar NOT NULL,
    escrow_hold_id uuid,
    effective_date date,
    expiry_date date,
    terms_summary text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    agreed_quantity numeric(12,3),
    agreed_unit_price numeric(18,2),
    quantity_unit text DEFAULT 'ตัน'::text,
    CONSTRAINT chk_loan_has_principal CHECK (((contract_type <> 'loan_agreement'::text) OR (principal_amount IS NOT NULL))),
    CONSTRAINT contract_contract_type_check CHECK ((contract_type = ANY (ARRAY['loan_agreement'::text, 'forward_purchase'::text, 'service_agreement'::text, 'input_supply_agreement'::text]))),
    CONSTRAINT contract_principal_amount_check CHECK (((principal_amount IS NULL) OR (principal_amount > (0)::numeric))),
    CONSTRAINT contract_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'pending_signature'::text, 'active'::text, 'completed'::text, 'terminated'::text, 'breached'::text])))
);

ALTER TABLE ONLY contract.contract FORCE ROW LEVEL SECURITY;


--
-- Name: contract_party; Type: TABLE; Schema: contract; Owner: -
--

CREATE TABLE contract.contract_party (
    contract_party_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    contract_id uuid NOT NULL,
    party_role text NOT NULL,
    party_type text NOT NULL,
    party_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contract_party_party_role_check CHECK ((party_role = ANY (ARRAY['farmer'::text, 'lender'::text, 'buyer'::text, 'service_provider'::text, 'input_supplier'::text, 'platform'::text]))),
    CONSTRAINT contract_party_party_type_check CHECK ((party_type = ANY (ARRAY['farmer'::text, 'organization'::text])))
);


--
-- Name: contract_status_history; Type: TABLE; Schema: contract; Owner: -
--

CREATE TABLE contract.contract_status_history (
    history_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    contract_id uuid NOT NULL,
    from_status text,
    to_status text NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    reason text
);


--
-- Name: digital_signature; Type: TABLE; Schema: contract; Owner: -
--

CREATE TABLE contract.digital_signature (
    signature_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    contract_party_id uuid NOT NULL,
    signature_method text NOT NULL,
    signature_hash text NOT NULL,
    signed_document_ref text,
    signed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT digital_signature_signature_method_check CHECK ((signature_method = ANY (ARRAY['OTP_ESignature'::text, 'PKI_Digital_Signature'::text, 'DID_VerifiableCredential'::text])))
);


--
-- Name: v_contract_signature_status; Type: VIEW; Schema: contract; Owner: -
--

CREATE VIEW contract.v_contract_signature_status AS
 SELECT c.contract_id,
    c.contract_type,
    c.status,
    count(cp.contract_party_id) AS required_signatures,
    count(ds.signature_id) AS collected_signatures,
    (count(cp.contract_party_id) = count(ds.signature_id)) AS fully_signed
   FROM ((contract.contract c
     LEFT JOIN contract.contract_party cp ON ((cp.contract_id = c.contract_id)))
     LEFT JOIN contract.digital_signature ds ON ((ds.contract_party_id = cp.contract_party_id)))
  GROUP BY c.contract_id, c.contract_type, c.status;


--
-- Name: loan_repayment; Type: TABLE; Schema: credit; Owner: -
--

CREATE TABLE credit.loan_repayment (
    repayment_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    contract_id uuid NOT NULL,
    amount numeric(18,2) NOT NULL,
    due_date date NOT NULL,
    paid_date date DEFAULT CURRENT_DATE NOT NULL,
    status text NOT NULL,
    settlement_entry_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT loan_repayment_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT loan_repayment_status_check CHECK ((status = ANY (ARRAY['paid_on_time'::text, 'paid_late'::text])))
);


--
-- Name: v_repayment_summary; Type: VIEW; Schema: credit; Owner: -
--

CREATE VIEW credit.v_repayment_summary AS
 SELECT c.contract_id,
    c.principal_amount,
    c.status AS contract_status,
    count(r.repayment_id) AS installments_paid,
    COALESCE(sum(r.amount), (0)::numeric) AS total_repaid,
    count(r.repayment_id) FILTER (WHERE (r.status = 'paid_on_time'::text)) AS on_time_count,
    count(r.repayment_id) FILTER (WHERE (r.status = 'paid_late'::text)) AS late_count
   FROM (contract.contract c
     LEFT JOIN credit.loan_repayment r ON ((r.contract_id = c.contract_id)))
  WHERE (c.contract_type = 'loan_agreement'::text)
  GROUP BY c.contract_id, c.principal_amount, c.status;


--
-- Name: identity_verification; Type: TABLE; Schema: identity; Owner: -
--

CREATE TABLE identity.identity_verification (
    verification_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid NOT NULL,
    method text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    evidence_ref text,
    verifier_ref text,
    standard_ref text DEFAULT 'FATF KYC/AML Guidance'::text NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    CONSTRAINT chk_subject_type_method CHECK ((((subject_type = 'farmer'::text) AND (method = ANY (ARRAY['eKYC_NDID'::text, 'eKYC_DOPA'::text, 'Manual_FieldAgent'::text]))) OR ((subject_type = 'organization'::text) AND (method = ANY (ARRAY['eKYB_DBD'::text, 'Manual_FieldAgent'::text]))))),
    CONSTRAINT identity_verification_method_check CHECK ((method = ANY (ARRAY['eKYC_NDID'::text, 'eKYC_DOPA'::text, 'eKYB_DBD'::text, 'Manual_FieldAgent'::text]))),
    CONSTRAINT identity_verification_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_review'::text, 'verified'::text, 'rejected'::text, 'expired'::text]))),
    CONSTRAINT identity_verification_subject_type_check CHECK ((subject_type = ANY (ARRAY['farmer'::text, 'organization'::text])))
);


--
-- Name: TABLE identity_verification; Type: COMMENT; Schema: identity; Owner: -
--

COMMENT ON TABLE identity.identity_verification IS 'ประวัติการยืนยันตัวตนทุกครั้ง รองรับทั้งเกษตรกรรายบุคคลและนิติบุคคล';


--
-- Name: organization_member; Type: TABLE; Schema: identity; Owner: -
--

CREATE TABLE identity.organization_member (
    member_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    org_id uuid NOT NULL,
    farmer_id uuid,
    full_name text NOT NULL,
    national_id_hash text NOT NULL,
    role_in_org text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_member_role_in_org_check CHECK ((role_in_org = ANY (ARRAY['AuthorizedSignatory'::text, 'Staff'::text, 'Representative'::text])))
);


--
-- Name: TABLE organization_member; Type: COMMENT; Schema: identity; Owner: -
--

COMMENT ON TABLE identity.organization_member IS 'บุคคลผู้มีอำนาจ/ตัวแทนขององค์กร ใช้ยืนยันตัวตนระดับบุคคลประกอบ eKYB';


--
-- Name: organization_role; Type: TABLE; Schema: identity; Owner: -
--

CREATE TABLE identity.organization_role (
    org_id uuid NOT NULL,
    role_type text NOT NULL,
    status text DEFAULT 'Pending'::text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    decided_reason text,
    CONSTRAINT organization_role_role_type_check CHECK ((role_type = ANY (ARRAY['Cooperative'::text, 'Mill'::text, 'Bank'::text, 'InputSupplier'::text, 'Lender'::text, 'Logistics'::text, 'Buyer'::text, 'VillageFund'::text, 'TractorService'::text, 'DroneService'::text, 'HarvesterService'::text, 'TruckService'::text, 'DryingYardService'::text]))),
    CONSTRAINT organization_role_status_check CHECK ((status = ANY (ARRAY['Pending'::text, 'Verified'::text, 'Rejected'::text])))
);


--
-- Name: role; Type: TABLE; Schema: identity; Owner: -
--

CREATE TABLE identity.role (
    role_code text NOT NULL,
    description text NOT NULL
);


--
-- Name: subject_role; Type: TABLE; Schema: identity; Owner: -
--

CREATE TABLE identity.subject_role (
    subject_type text NOT NULL,
    subject_id uuid NOT NULL,
    role_code text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subject_role_subject_type_check CHECK ((subject_type = ANY (ARRAY['farmer'::text, 'organization'::text, 'organization_member'::text])))
);


--
-- Name: TABLE subject_role; Type: COMMENT; Schema: identity; Owner: -
--

COMMENT ON TABLE identity.subject_role IS 'การกำหนดสิทธิ์แบบ RBAC ใช้ประกอบ OAuth2 scope เวลาออก Access Token';


--
-- Name: verifiable_credential; Type: TABLE; Schema: identity; Owner: -
--

CREATE TABLE identity.verifiable_credential (
    credential_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    holder_type text NOT NULL,
    holder_id uuid NOT NULL,
    credential_type text NOT NULL,
    issuer text DEFAULT 'did:web:agrolink.example/issuer'::text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    revoked boolean DEFAULT false NOT NULL,
    proof_ref text NOT NULL,
    CONSTRAINT verifiable_credential_holder_type_check CHECK ((holder_type = ANY (ARRAY['farmer'::text, 'organization'::text])))
);


--
-- Name: TABLE verifiable_credential; Type: COMMENT; Schema: identity; Owner: -
--

COMMENT ON TABLE identity.verifiable_credential IS 'มาตรฐาน: W3C Verifiable Credentials Data Model 1.1/2.0';


--
-- Name: account; Type: TABLE; Schema: ledger; Owner: -
--

CREATE TABLE ledger.account (
    account_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    account_type text NOT NULL,
    owner_type text,
    owner_id uuid,
    currency character(3) DEFAULT 'THB'::bpchar NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_account_type_check CHECK ((account_type = ANY (ARRAY['unit_wallet'::text, 'escrow'::text, 'lender_clearing'::text, 'vendor_settlement'::text, 'fee_revenue'::text, 'external_settlement'::text, 'platform_cash'::text]))),
    CONSTRAINT account_owner_type_check CHECK ((owner_type = ANY (ARRAY['production_unit'::text, 'organization'::text, 'platform'::text]))),
    CONSTRAINT account_status_check CHECK ((status = ANY (ARRAY['active'::text, 'closed'::text]))),
    CONSTRAINT chk_owner_required CHECK ((((account_type = 'unit_wallet'::text) AND (owner_type = 'production_unit'::text) AND (owner_id IS NOT NULL)) OR ((account_type = ANY (ARRAY['lender_clearing'::text, 'vendor_settlement'::text])) AND (owner_type = 'organization'::text) AND (owner_id IS NOT NULL)) OR ((account_type = ANY (ARRAY['escrow'::text, 'fee_revenue'::text, 'external_settlement'::text, 'platform_cash'::text])) AND (owner_type = 'platform'::text))))
);


--
-- Name: TABLE account; Type: COMMENT; Schema: ledger; Owner: -
--

COMMENT ON TABLE ledger.account IS 'ผังบัญชีกลาง — มาตรฐาน ISO 4217 สำหรับสกุลเงิน หนึ่งหน่วยผลิตมีกระเป๋าเงิน (unit_wallet) ได้บัญชีเดียวเท่านั้น';


--
-- Name: escrow_hold; Type: TABLE; Schema: ledger; Owner: -
--

CREATE TABLE ledger.escrow_hold (
    hold_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    escrow_account_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    amount numeric(18,2) NOT NULL,
    status text DEFAULT 'held'::text NOT NULL,
    release_condition_ref text,
    hold_entry_id uuid,
    release_entry_id uuid,
    held_at timestamp with time zone DEFAULT now() NOT NULL,
    released_at timestamp with time zone,
    CONSTRAINT escrow_hold_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT escrow_hold_status_check CHECK ((status = ANY (ARRAY['held'::text, 'released'::text, 'forfeited'::text])))
);


--
-- Name: TABLE escrow_hold; Type: COMMENT; Schema: ledger; Owner: -
--

COMMENT ON TABLE ledger.escrow_hold IS 'พักเงินระหว่างรอเงื่อนไขปลดล็อกงวด — เช่น รอสัญญาณยืนยันความคืบหน้าจาก G-09/G-11 ก่อนโอนเข้ากระเป๋าเงินเกษตรกรจริง';


--
-- Name: journal_entry; Type: TABLE; Schema: ledger; Owner: -
--

CREATE TABLE ledger.journal_entry (
    entry_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    entry_type text NOT NULL,
    reference_type text,
    reference_id uuid,
    description text,
    posted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_subject_type text,
    created_by_subject_id uuid,
    CONSTRAINT journal_entry_created_by_subject_type_check CHECK ((created_by_subject_type = ANY (ARRAY['farmer'::text, 'organization'::text, 'system'::text]))),
    CONSTRAINT journal_entry_entry_type_check CHECK ((entry_type = ANY (ARRAY['CreditDisbursement'::text, 'Settlement'::text, 'FeeCharge'::text, 'EscrowHold'::text, 'EscrowRelease'::text, 'EscrowForfeit'::text, 'Adjustment'::text, 'LoanRepayment'::text])))
);


--
-- Name: TABLE journal_entry; Type: COMMENT; Schema: ledger; Owner: -
--

COMMENT ON TABLE ledger.journal_entry IS 'ธุรกรรมทางบัญชีหนึ่งรายการ อาจประกอบด้วยหลาย journal_line แต่ผลรวม debit ต้องเท่ากับ credit เสมอ (บังคับด้วย Deferred Constraint Trigger)';


--
-- Name: journal_line; Type: TABLE; Schema: ledger; Owner: -
--

CREATE TABLE ledger.journal_line (
    line_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    entry_id uuid NOT NULL,
    account_id uuid NOT NULL,
    direction text NOT NULL,
    amount numeric(18,2) NOT NULL,
    currency character(3) DEFAULT 'THB'::bpchar NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT journal_line_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT journal_line_direction_check CHECK ((direction = ANY (ARRAY['debit'::text, 'credit'::text])))
);


--
-- Name: TABLE journal_line; Type: COMMENT; Schema: ledger; Owner: -
--

COMMENT ON TABLE ledger.journal_line IS 'บรรทัดบัญชี (debit/credit) แต่ละรายการ — Immutable ห้าม UPDATE/DELETE หลังบันทึก (บังคับใช้ระดับสิทธิ์ฐานข้อมูลใน Production)';


--
-- Name: v_account_balance; Type: VIEW; Schema: ledger; Owner: -
--

CREATE VIEW ledger.v_account_balance AS
 SELECT a.account_id,
    a.account_type,
    a.owner_type,
    a.owner_id,
    a.currency,
    (COALESCE(sum(jl.amount) FILTER (WHERE (jl.direction = 'credit'::text)), (0)::numeric) - COALESCE(sum(jl.amount) FILTER (WHERE (jl.direction = 'debit'::text)), (0)::numeric)) AS balance
   FROM (ledger.account a
     LEFT JOIN ledger.journal_line jl ON ((jl.account_id = a.account_id)))
  GROUP BY a.account_id, a.account_type, a.owner_type, a.owner_id, a.currency;


--
-- Name: VIEW v_account_balance; Type: COMMENT; Schema: ledger; Owner: -
--

COMMENT ON VIEW ledger.v_account_balance IS 'ยอดคงเหลือปัจจุบันของทุกบัญชี คำนวณสดจาก journal_line เสมอ (ไม่มี Cache ที่อาจไม่ตรงกับความจริง)';


--
-- Name: v_reconciliation_summary; Type: VIEW; Schema: ledger; Owner: -
--

CREATE VIEW ledger.v_reconciliation_summary AS
 SELECT ( SELECT COALESCE(sum(journal_line.amount), (0)::numeric) AS "coalesce"
           FROM ledger.journal_line
          WHERE (journal_line.direction = 'debit'::text)) AS total_debit,
    ( SELECT COALESCE(sum(journal_line.amount), (0)::numeric) AS "coalesce"
           FROM ledger.journal_line
          WHERE (journal_line.direction = 'credit'::text)) AS total_credit,
    (( SELECT COALESCE(sum(journal_line.amount), (0)::numeric) AS "coalesce"
           FROM ledger.journal_line
          WHERE (journal_line.direction = 'debit'::text)) - ( SELECT COALESCE(sum(journal_line.amount), (0)::numeric) AS "coalesce"
           FROM ledger.journal_line
          WHERE (journal_line.direction = 'credit'::text))) AS variance;


--
-- Name: VIEW v_reconciliation_summary; Type: COMMENT; Schema: ledger; Owner: -
--

COMMENT ON VIEW ledger.v_reconciliation_summary IS 'variance ต้องเท่ากับ 0 เสมอ (ผลต่างสะสมเป็นศูนย์) ตามเกณฑ์ผ่านระยะขั้นที่ 2 — หากไม่เท่ากับ 0 แปลว่ามีข้อมูลผิดปกติที่ต้องตรวจสอบทันที';


--
-- Name: v_unbalanced_entries; Type: VIEW; Schema: ledger; Owner: -
--

CREATE VIEW ledger.v_unbalanced_entries AS
 SELECT je.entry_id,
    je.entry_type,
    je.posted_at,
    COALESCE(sum(jl.amount) FILTER (WHERE (jl.direction = 'debit'::text)), (0)::numeric) AS total_debit,
    COALESCE(sum(jl.amount) FILTER (WHERE (jl.direction = 'credit'::text)), (0)::numeric) AS total_credit
   FROM (ledger.journal_entry je
     LEFT JOIN ledger.journal_line jl ON ((jl.entry_id = je.entry_id)))
  GROUP BY je.entry_id, je.entry_type, je.posted_at
 HAVING (COALESCE(sum(jl.amount) FILTER (WHERE (jl.direction = 'debit'::text)), (0)::numeric) <> COALESCE(sum(jl.amount) FILTER (WHERE (jl.direction = 'credit'::text)), (0)::numeric));


--
-- Name: VIEW v_unbalanced_entries; Type: COMMENT; Schema: ledger; Owner: -
--

COMMENT ON VIEW ledger.v_unbalanced_entries IS 'ต้องว่างเปล่าเสมอ (0 แถว) — ใช้เป็น Health Check ประจำวันสำหรับทีมปฏิบัติการ';


--
-- Name: buy_price_quote; Type: TABLE; Schema: marketplace; Owner: -
--

CREATE TABLE marketplace.buy_price_quote (
    org_id uuid NOT NULL,
    grade_code text NOT NULL,
    quoted_price numeric(18,2) NOT NULL,
    price_unit text DEFAULT 'บาท/ตัน'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT buy_price_quote_price_check CHECK ((quoted_price > (0)::numeric))
);


--
-- Name: product_listing; Type: TABLE; Schema: marketplace; Owner: -
--

CREATE TABLE marketplace.product_listing (
    listing_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    org_id uuid NOT NULL,
    category text NOT NULL,
    product_name text NOT NULL,
    brand text,
    description text,
    unit_price numeric(18,2) NOT NULL,
    price_unit text DEFAULT 'บาท/หน่วย'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_listing_category_check CHECK ((category = ANY (ARRAY['fertilizer_hormone'::text, 'chemical_pesticide'::text, 'equipment'::text, 'other'::text]))),
    CONSTRAINT product_listing_product_name_check CHECK ((length(TRIM(BOTH FROM product_name)) > 0)),
    CONSTRAINT product_listing_unit_price_check CHECK ((unit_price > (0)::numeric))
);


--
-- Name: product_order; Type: TABLE; Schema: marketplace; Owner: -
--

CREATE TABLE marketplace.product_order (
    order_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    listing_id uuid NOT NULL,
    org_id uuid NOT NULL,
    farmer_id uuid NOT NULL,
    product_name text NOT NULL,
    category text NOT NULL,
    unit_price numeric(18,2) NOT NULL,
    price_unit text NOT NULL,
    quantity numeric(14,2) NOT NULL,
    total_price numeric(18,2) NOT NULL,
    status text DEFAULT 'requested'::text NOT NULL,
    decided_reason text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    fulfilled_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_order_category_check CHECK ((category = ANY (ARRAY['fertilizer_hormone'::text, 'chemical_pesticide'::text, 'equipment'::text, 'other'::text]))),
    CONSTRAINT product_order_quantity_check CHECK ((quantity > (0)::numeric)),
    CONSTRAINT product_order_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'confirmed'::text, 'rejected'::text, 'fulfilled'::text, 'cancelled'::text]))),
    CONSTRAINT product_order_total_price_check CHECK ((total_price > (0)::numeric)),
    CONSTRAINT product_order_unit_price_check CHECK ((unit_price > (0)::numeric))
);


--
-- Name: product_photo; Type: TABLE; Schema: marketplace; Owner: -
--

CREATE TABLE marketplace.product_photo (
    photo_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    listing_id uuid NOT NULL,
    org_id uuid NOT NULL,
    photo_data_url text NOT NULL,
    caption text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: service_listing; Type: TABLE; Schema: marketplace; Owner: -
--

CREATE TABLE marketplace.service_listing (
    listing_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    org_id uuid NOT NULL,
    service_type text NOT NULL,
    description text,
    unit_price numeric(18,2) NOT NULL,
    price_unit text DEFAULT 'ต่อไร่'::text NOT NULL,
    region_code text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    service_key text,
    CONSTRAINT service_listing_service_key_check CHECK (((service_key IS NULL) OR (service_key = ANY (ARRAY['plow_rough'::text, 'plow_secondary_seed'::text, 'rotary_till'::text, 'spraying'::text, 'harvesting'::text, 'trucking'::text, 'drying'::text])))),
    CONSTRAINT service_listing_service_type_check CHECK ((service_type = ANY (ARRAY['land_preparation'::text, 'harvesting'::text, 'pest_control'::text, 'transport'::text, 'drying_storage'::text, 'other'::text]))),
    CONSTRAINT service_listing_unit_price_check CHECK ((unit_price > (0)::numeric))
);


--
-- Name: service_request; Type: TABLE; Schema: marketplace; Owner: -
--

CREATE TABLE marketplace.service_request (
    request_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    listing_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    cycle_id uuid,
    stage_id uuid,
    status text DEFAULT 'requested'::text NOT NULL,
    agreed_price numeric(18,2) NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    scheduled_date date,
    completed_at timestamp with time zone,
    payment_entry_id uuid,
    CONSTRAINT service_request_agreed_price_check CHECK ((agreed_price > (0)::numeric)),
    CONSTRAINT service_request_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'accepted'::text, 'completed'::text, 'cancelled'::text])))
);


--
-- Name: v_service_request_status; Type: VIEW; Schema: marketplace; Owner: -
--

CREATE VIEW marketplace.v_service_request_status AS
 SELECT r.request_id,
    r.status,
    r.agreed_price,
    l.service_type,
    o.org_name AS vendor_name,
    r.unit_id,
    r.scheduled_date,
    r.completed_at,
    r.payment_entry_id
   FROM ((marketplace.service_request r
     JOIN marketplace.service_listing l ON ((l.listing_id = r.listing_id)))
     JOIN identity.organization o ON ((o.org_id = l.org_id)));


--
-- Name: vendor_photo; Type: TABLE; Schema: marketplace; Owner: -
--

CREATE TABLE marketplace.vendor_photo (
    photo_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    org_id uuid NOT NULL,
    photo_type text NOT NULL,
    photo_data_url text NOT NULL,
    caption text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vendor_photo_photo_type_check CHECK ((photo_type = ANY (ARRAY['service'::text, 'machinery'::text])))
);


--
-- Name: alert_event; Type: TABLE; Schema: monitoring; Owner: -
--

CREATE TABLE monitoring.alert_event (
    alert_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    threshold_id uuid NOT NULL,
    observation_id uuid NOT NULL,
    severity text NOT NULL,
    message text NOT NULL,
    fired_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged boolean DEFAULT false NOT NULL,
    acknowledged_at timestamp with time zone,
    CONSTRAINT alert_event_severity_check CHECK ((severity = ANY (ARRAY['warning'::text, 'critical'::text])))
);


--
-- Name: TABLE alert_event; Type: COMMENT; Schema: monitoring; Owner: -
--

COMMENT ON TABLE monitoring.alert_event IS 'บันทึกทุกครั้งที่ค่าที่สังเกตได้จริง (metric_observation) ทะลุเกณฑ์ที่กำหนด (metric_threshold) — สร้างโดย monitoring.evaluate_metric() เท่านั้น ไม่มีช่องทางแทรกด้วยมือเพื่อรักษาความน่าเชื่อถือของประวัติการแจ้งเตือน';


--
-- Name: go_live_checklist; Type: TABLE; Schema: monitoring; Owner: -
--

CREATE TABLE monitoring.go_live_checklist (
    item_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    category text NOT NULL,
    description text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    evidence_reference text,
    verified_at timestamp with time zone,
    CONSTRAINT go_live_checklist_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'passed'::text, 'failed'::text])))
);


--
-- Name: TABLE go_live_checklist; Type: COMMENT; Schema: monitoring; Owner: -
--

COMMENT ON TABLE monitoring.go_live_checklist IS 'ประตูเปิดใช้งานจริง (Go-Live Gate) แบบ Query ได้จริง แทนเอกสาร Checklist กระดาษ — แต่ละแถวอ้างอิงหลักฐานที่พิสูจน์แล้วจริงจากขั้นที่ 8-10 ผ่าน monitoring.v_go_live_readiness เพื่อสรุปว่าพร้อมเปิดใช้งานจริงหรือไม่';


--
-- Name: metric_observation; Type: TABLE; Schema: monitoring; Owner: -
--

CREATE TABLE monitoring.metric_observation (
    observation_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    metric_name text NOT NULL,
    observed_value numeric(14,3) NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    source text NOT NULL,
    notes text
);


--
-- Name: metric_threshold; Type: TABLE; Schema: monitoring; Owner: -
--

CREATE TABLE monitoring.metric_threshold (
    threshold_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    metric_name text NOT NULL,
    comparison text NOT NULL,
    warning_value numeric(14,3),
    critical_value numeric(14,3),
    unit text,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT metric_threshold_comparison_check CHECK ((comparison = ANY (ARRAY['gt'::text, 'lt'::text])))
);


--
-- Name: TABLE metric_threshold; Type: COMMENT; Schema: monitoring; Owner: -
--

COMMENT ON TABLE monitoring.metric_threshold IS 'เกณฑ์แจ้งเตือนของแต่ละตัวชี้วัด กำหนดจากค่าที่วัดได้จริงในขั้นที่ 9 (ops.performance_benchmark) ไม่ใช่ค่าประมาณการ — comparison=''gt'' หมายถึง แจ้งเตือนเมื่อค่าสูงกว่าเกณฑ์ (เช่น Latency), ''lt'' หมายถึงแจ้งเตือนเมื่อ ค่าต่ำกว่าเกณฑ์ (เช่น TPS)';


--
-- Name: v_active_alerts; Type: VIEW; Schema: monitoring; Owner: -
--

CREATE VIEW monitoring.v_active_alerts AS
 SELECT a.alert_id,
    a.severity,
    a.message,
    a.fired_at,
    t.metric_name,
    o.observed_value,
    o.source
   FROM ((monitoring.alert_event a
     JOIN monitoring.metric_threshold t ON ((t.threshold_id = a.threshold_id)))
     JOIN monitoring.metric_observation o ON ((o.observation_id = a.observation_id)))
  WHERE (a.acknowledged = false)
  ORDER BY a.fired_at DESC;


--
-- Name: v_go_live_readiness; Type: VIEW; Schema: monitoring; Owner: -
--

CREATE VIEW monitoring.v_go_live_readiness AS
 SELECT count(*) AS total_items,
    count(*) FILTER (WHERE (status = 'passed'::text)) AS passed_items,
    count(*) FILTER (WHERE (status = 'failed'::text)) AS failed_items,
    count(*) FILTER (WHERE (status = 'pending'::text)) AS pending_items,
    (count(*) FILTER (WHERE (status = 'passed'::text)) = count(*)) AS ready_for_go_live
   FROM monitoring.go_live_checklist;


--
-- Name: notification_log; Type: TABLE; Schema: notification; Owner: -
--

CREATE TABLE notification.notification_log (
    notification_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    event_type text NOT NULL,
    severity text NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid NOT NULL,
    message text NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_log_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text]))),
    CONSTRAINT notification_log_subject_type_check CHECK ((subject_type = ANY (ARRAY['farmer'::text, 'contract'::text, 'loan_application'::text, 'organization'::text])))
);


--
-- Name: TABLE notification_log; Type: COMMENT; Schema: notification; Owner: -
--

COMMENT ON TABLE notification.notification_log IS 'บันทึกเหตุการณ์แบบเพิ่มอย่างเดียว (Append-only) เช่นเดียวกับ journal_line ของขั้นที่ 2 และ contract_status_history ของขั้นที่ 3 — ยกเว้นคอลัมน์ is_read ที่ตั้งใจให้แก้ไขได้ เพราะเป็นสถานะการอ่านของผู้ใช้ ไม่ใช่ข้อเท็จจริงทางประวัติศาสตร์ของเหตุการณ์';


--
-- Name: v_unread_notifications; Type: VIEW; Schema: notification; Owner: -
--

CREATE VIEW notification.v_unread_notifications AS
 SELECT notification_id,
    event_type,
    severity,
    subject_type,
    subject_id,
    message,
    created_at
   FROM notification.notification_log
  WHERE (is_read = false)
  ORDER BY
        CASE severity
            WHEN 'critical'::text THEN 1
            WHEN 'warning'::text THEN 2
            ELSE 3
        END, created_at DESC;


--
-- Name: backup_log; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.backup_log (
    backup_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    backup_type text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    status text NOT NULL,
    file_path text,
    file_size_bytes bigint,
    database_size_bytes bigint,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT backup_log_backup_type_check CHECK ((backup_type = ANY (ARRAY['full'::text, 'incremental'::text]))),
    CONSTRAINT backup_log_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'failed'::text])))
);


--
-- Name: TABLE backup_log; Type: COMMENT; Schema: ops; Owner: -
--

COMMENT ON TABLE ops.backup_log IS 'บันทึกทุกครั้งที่มีการสำรองข้อมูลจริง (pg_dump) แยกจาก Business Audit Trail (ขั้นที่ 3/7) และ Access Audit Log (ขั้นที่ 8) โดยเจตนา — ตารางนี้บันทึกผล การดำเนินงานเชิงปฏิบัติการ (Operations) ไม่ใช่เหตุการณ์ทางธุรกิจหรือการเข้าถึงข้อมูล';


--
-- Name: performance_benchmark; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.performance_benchmark (
    benchmark_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    test_name text NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    concurrent_clients integer NOT NULL,
    duration_seconds integer NOT NULL,
    total_transactions bigint NOT NULL,
    tps numeric(10,2) NOT NULL,
    latency_avg_ms numeric(10,3),
    notes text
);


--
-- Name: TABLE performance_benchmark; Type: COMMENT; Schema: ops; Owner: -
--

COMMENT ON TABLE ops.performance_benchmark IS 'บันทึกผลการทดสอบภาระงาน (Load Test) แต่ละรอบจริงที่รันด้วย pgbench กับ Custom Script ที่จำลองการเรียกฟังก์ชัน/มุมมองสำคัญของแพลตฟอร์ม (ไม่ใช่ตาราง เปล่าตามค่าเริ่มต้นของ pgbench) ใช้เป็นเส้นฐาน (Baseline) เปรียบเทียบก่อน/หลังการปรับปรุงประสิทธิภาพ เช่น การเพิ่มดัชนี (Index)';


--
-- Name: query_observation; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.query_observation (
    observation_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    query_label text NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    phase text NOT NULL,
    planning_time_ms numeric(10,3),
    execution_time_ms numeric(10,3),
    notes text,
    CONSTRAINT query_observation_phase_check CHECK ((phase = ANY (ARRAY['before_optimization'::text, 'after_optimization'::text])))
);


--
-- Name: TABLE query_observation; Type: COMMENT; Schema: ops; Owner: -
--

COMMENT ON TABLE ops.query_observation IS 'บันทึกผล EXPLAIN ANALYZE ของ Query สำคัญก่อนและหลังการปรับปรุงประสิทธิภาพ จริง (เช่น เพิ่มดัชนี) เพื่อพิสูจน์ด้วยตัวเลขจริงว่าการปรับปรุงมีผลจริง ไม่ใช่แค่คำแนะนำเชิงทฤษฎี';


--
-- Name: restore_test_log; Type: TABLE; Schema: ops; Owner: -
--

CREATE TABLE ops.restore_test_log (
    restore_test_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    backup_id uuid NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    target_database text NOT NULL,
    status text NOT NULL,
    rows_verified_ok boolean,
    ledger_variance_after_restore numeric(14,2),
    verification_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT restore_test_log_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'failed'::text])))
);


--
-- Name: TABLE restore_test_log; Type: COMMENT; Schema: ops; Owner: -
--

COMMENT ON TABLE ops.restore_test_log IS 'บันทึกผลการซ้อมกู้คืนข้อมูล (Disaster Recovery Drill) จาก Backup แต่ละครั้ง จริง — ต้องมีการรัน pg_restore ลงฐานข้อมูลทดสอบใหม่จริง และตรวจสอบ ความถูกต้องของข้อมูล (rows_verified_ok, ledger_variance_after_restore) ก่อน บันทึกว่า status=success ห้ามบันทึก success โดยไม่ได้ตรวจสอบจริง';


--
-- Name: v_backup_restore_summary; Type: VIEW; Schema: ops; Owner: -
--

CREATE VIEW ops.v_backup_restore_summary AS
 SELECT b.backup_id,
    b.backup_type,
    b.started_at AS backup_started_at,
    b.completed_at AS backup_completed_at,
    b.status AS backup_status,
    b.file_size_bytes,
    b.database_size_bytes,
    r.restore_test_id,
    r.target_database,
    r.status AS restore_status,
    r.rows_verified_ok,
    r.ledger_variance_after_restore
   FROM (ops.backup_log b
     LEFT JOIN ops.restore_test_log r ON ((r.backup_id = b.backup_id)))
  ORDER BY b.started_at DESC;


--
-- Name: production_unit; Type: TABLE; Schema: registry; Owner: -
--

CREATE TABLE registry.production_unit (
    unit_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    owner_farmer_id uuid NOT NULL,
    unit_type text NOT NULL,
    gps_boundary public.geometry(Polygon,4326) NOT NULL,
    area_rai numeric(10,2) NOT NULL,
    commodity_code text NOT NULL,
    season_id text NOT NULL,
    registration_date date DEFAULT CURRENT_DATE NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_valid_polygon CHECK (public.st_isvalid(gps_boundary)),
    CONSTRAINT production_unit_area_rai_check CHECK ((area_rai > (0)::numeric)),
    CONSTRAINT production_unit_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'under_review'::text]))),
    CONSTRAINT production_unit_unit_type_check CHECK ((unit_type = ANY (ARRAY['Plot'::text, 'Pen'::text, 'Pond'::text, 'Orchard'::text])))
);


--
-- Name: TABLE production_unit; Type: COMMENT; Schema: registry; Owner: -
--

COMMENT ON TABLE registry.production_unit IS 'หัวใจของแม่แบบวงจรการผลิตสากล — หนึ่งบัญชีต่อแปลง/คอก/บ่อ ต่อรอบการผลิต. มาตรฐาน: OGC GeoJSON, ISO 19115, ISO 8601';


--
-- Name: COLUMN production_unit.gps_boundary; Type: COMMENT; Schema: registry; Owner: -
--

COMMENT ON COLUMN registry.production_unit.gps_boundary IS 'จัดเก็บเป็น PostGIS geometry; ฝั่ง API แปลงเข้า/ออกเป็น GeoJSON Polygon ตาม OGC มาตรฐาน';


--
-- Name: credit_score; Type: TABLE; Schema: risk; Owner: -
--

CREATE TABLE risk.credit_score (
    score_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    farmer_id uuid NOT NULL,
    score_value numeric(5,2) NOT NULL,
    risk_tier text NOT NULL,
    factors jsonb NOT NULL,
    model_version text DEFAULT 'v1.0-rule-based'::text NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT credit_score_risk_tier_check CHECK ((risk_tier = ANY (ARRAY['A'::text, 'B'::text, 'C'::text, 'D'::text]))),
    CONSTRAINT credit_score_score_value_check CHECK (((score_value >= (0)::numeric) AND (score_value <= (100)::numeric)))
);

ALTER TABLE ONLY risk.credit_score FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE credit_score; Type: COMMENT; Schema: risk; Owner: -
--

COMMENT ON TABLE risk.credit_score IS 'บันทึกทุกครั้งที่คำนวณคะแนน ไม่เคย UPDATE ทับของเดิม เพื่อรักษาประวัติคะแนนย้อนหลังทั้งหมดไว้ตรวจสอบได้ (เช่นเดียวกับหลักการ Immutable ของ ledger.journal_line ในขั้นที่ 2)';


--
-- Name: loan_application; Type: TABLE; Schema: underwriting; Owner: -
--

CREATE TABLE underwriting.loan_application (
    application_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    farmer_id uuid NOT NULL,
    lender_org_id uuid NOT NULL,
    related_unit_id uuid NOT NULL,
    requested_amount numeric(18,2) NOT NULL,
    purpose text,
    status text DEFAULT 'pending'::text NOT NULL,
    score_id uuid,
    risk_tier_at_decision text,
    decision_reason text,
    approved_amount numeric(18,2),
    contract_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    CONSTRAINT loan_application_requested_amount_check CHECK ((requested_amount > (0)::numeric)),
    CONSTRAINT loan_application_risk_tier_at_decision_check CHECK ((risk_tier_at_decision = ANY (ARRAY['A'::text, 'B'::text, 'C'::text, 'D'::text]))),
    CONSTRAINT loan_application_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'manual_review'::text, 'declined'::text, 'converted'::text])))
);

ALTER TABLE ONLY underwriting.loan_application FORCE ROW LEVEL SECURITY;


--
-- Name: v_integrity_checksum; Type: VIEW; Schema: ops; Owner: -
--

CREATE VIEW ops.v_integrity_checksum AS
 SELECT ( SELECT count(*) AS count
           FROM identity.farmer) AS farmer_count,
    ( SELECT count(*) AS count
           FROM identity.organization) AS organization_count,
    ( SELECT count(*) AS count
           FROM registry.production_unit) AS production_unit_count,
    ( SELECT count(*) AS count
           FROM contract.contract) AS contract_count,
    ( SELECT count(*) AS count
           FROM underwriting.loan_application) AS loan_application_count,
    ( SELECT count(*) AS count
           FROM risk.credit_score) AS credit_score_count,
    ( SELECT count(*) AS count
           FROM notification.notification_log) AS notification_log_count,
    ( SELECT count(*) AS count
           FROM audit.access_log) AS access_log_count,
    ( SELECT count(*) AS count
           FROM ledger.journal_line) AS journal_line_count,
    ( SELECT v_reconciliation_summary.total_debit
           FROM ledger.v_reconciliation_summary) AS total_debit,
    ( SELECT v_reconciliation_summary.total_credit
           FROM ledger.v_reconciliation_summary) AS total_credit,
    ( SELECT v_reconciliation_summary.variance
           FROM ledger.v_reconciliation_summary) AS ledger_variance;


--
-- Name: VIEW v_integrity_checksum; Type: COMMENT; Schema: ops; Owner: -
--

COMMENT ON VIEW ops.v_integrity_checksum IS 'สรุปจำนวนแถวของตารางสำคัญและผลกระทบยอดบัญชีในบรรทัดเดียว ใช้เปรียบเทียบ ระหว่างฐานข้อมูลต้นทางกับฐานข้อมูลที่กู้คืนจาก Backup เพื่อพิสูจน์ความถูกต้อง ของกระบวนการกู้คืนแบบวัดผลได้จริง ไม่ใช่การอนุมานจากสถานะ success เพียงอย่างเดียว';


--
-- Name: v_query_improvement; Type: VIEW; Schema: ops; Owner: -
--

CREATE VIEW ops.v_query_improvement AS
 SELECT b.query_label,
    b.execution_time_ms AS execution_time_ms_before,
    a.execution_time_ms AS execution_time_ms_after,
    round((((1)::numeric - (a.execution_time_ms / NULLIF(b.execution_time_ms, (0)::numeric))) * (100)::numeric), 1) AS improvement_pct
   FROM (ops.query_observation b
     JOIN ops.query_observation a ON (((a.query_label = b.query_label) AND (a.phase = 'after_optimization'::text))))
  WHERE (b.phase = 'before_optimization'::text);


--
-- Name: VIEW v_query_improvement; Type: COMMENT; Schema: ops; Owner: -
--

COMMENT ON VIEW ops.v_query_improvement IS 'เปรียบเทียบเวลาการทำงานของ Query เดียวกันก่อนและหลังการปรับปรุง คำนวณ ร้อยละที่ดีขึ้นจากตัวเลขจริงที่บันทึกไว้';


--
-- Name: vendor_profile; Type: TABLE; Schema: partner; Owner: -
--

CREATE TABLE partner.vendor_profile (
    org_id uuid NOT NULL,
    business_registration_no text NOT NULL,
    license_no text,
    license_issuer text DEFAULT 'กรมพัฒนาธุรกิจการค้า (DBD)'::text,
    service_regions text[] DEFAULT '{}'::text[] NOT NULL,
    capacity_note text,
    commercial_status text DEFAULT 'pending_activation'::text NOT NULL,
    lender_clearing_account_id uuid,
    activated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    settlement_account_id uuid,
    CONSTRAINT vendor_profile_commercial_status_check CHECK ((commercial_status = ANY (ARRAY['pending_activation'::text, 'active'::text, 'suspended'::text, 'terminated'::text])))
);


--
-- Name: TABLE vendor_profile; Type: COMMENT; Schema: partner; Owner: -
--

COMMENT ON TABLE partner.vendor_profile IS 'ข้อมูลเชิงธุรกิจของคู่ค้าที่ขึ้นทะเบียนในเครือข่าย AgroLink ต่อยอดจาก identity.organization ของขั้นที่ 1';


--
-- Name: v_vendor_directory; Type: VIEW; Schema: partner; Owner: -
--

CREATE VIEW partner.v_vendor_directory AS
 SELECT o.org_id,
    o.org_name,
    o.org_type,
    o.kyb_status,
    vp.commercial_status,
    vp.service_regions,
    vp.lender_clearing_account_id,
    vp.activated_at
   FROM (identity.organization o
     JOIN partner.vendor_profile vp ON ((vp.org_id = o.org_id)));


--
-- Name: vendor_document; Type: TABLE; Schema: partner; Owner: -
--

CREATE TABLE partner.vendor_document (
    document_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    org_id uuid NOT NULL,
    document_type text NOT NULL,
    document_ref text NOT NULL,
    issued_at date,
    expires_at date,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vendor_document_document_type_check CHECK ((document_type = ANY (ARRAY['business_registration_cert'::text, 'trade_license'::text, 'bank_guarantee'::text, 'other'::text])))
);


--
-- Name: delivery; Type: TABLE; Schema: produce; Owner: -
--

CREATE TABLE produce.delivery (
    delivery_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    contract_id uuid,
    cycle_id uuid,
    unit_id uuid NOT NULL,
    buyer_org_id uuid NOT NULL,
    commodity_code text NOT NULL,
    quantity_ton numeric(12,3) NOT NULL,
    unit_price numeric(18,2) NOT NULL,
    total_amount numeric(18,2) NOT NULL,
    quality_grade text,
    status text DEFAULT 'delivered'::text NOT NULL,
    inspected_by text,
    inspected_at timestamp with time zone,
    settlement_entry_id uuid,
    delivered_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT delivery_quantity_ton_check CHECK ((quantity_ton > (0)::numeric)),
    CONSTRAINT delivery_status_check CHECK ((status = ANY (ARRAY['delivered'::text, 'accepted'::text, 'rejected'::text, 'settled'::text]))),
    CONSTRAINT delivery_total_amount_check CHECK ((total_amount > (0)::numeric)),
    CONSTRAINT delivery_unit_price_check CHECK ((unit_price > (0)::numeric))
);


--
-- Name: v_delivery_status; Type: VIEW; Schema: produce; Owner: -
--

CREATE VIEW produce.v_delivery_status AS
 SELECT d.delivery_id,
    d.status,
    d.commodity_code,
    d.quantity_ton,
    d.unit_price,
    d.total_amount,
    d.quality_grade,
    o.org_name AS buyer_name,
    d.contract_id,
    d.unit_id,
    d.settlement_entry_id
   FROM (produce.delivery d
     JOIN identity.organization o ON ((o.org_id = d.buyer_org_id)));


--
-- Name: crop_cycle; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.crop_cycle (
    cycle_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    unit_id uuid NOT NULL,
    commodity_code text NOT NULL,
    planned_start_date date NOT NULL,
    planned_harvest_date date,
    actual_harvest_date date,
    status text DEFAULT 'planning'::text NOT NULL,
    linked_contract_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crop_cycle_status_check CHECK ((status = ANY (ARRAY['planning'::text, 'active'::text, 'completed'::text, 'abandoned'::text])))
);


--
-- Name: stage_calendar; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.stage_calendar (
    stage_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    cycle_id uuid NOT NULL,
    stage_seq integer NOT NULL,
    stage_name text NOT NULL,
    planned_date date NOT NULL,
    actual_date date,
    status text DEFAULT 'pending'::text NOT NULL,
    verification_ref text,
    verified_by text,
    verified_at timestamp with time zone,
    CONSTRAINT stage_calendar_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'verified'::text, 'skipped'::text])))
);


--
-- Name: stage_template; Type: TABLE; Schema: production; Owner: -
--

CREATE TABLE production.stage_template (
    stage_template_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    commodity_code text NOT NULL,
    stage_seq integer NOT NULL,
    stage_name text NOT NULL,
    typical_offset_days integer NOT NULL,
    CONSTRAINT stage_template_stage_seq_check CHECK ((stage_seq > 0)),
    CONSTRAINT stage_template_typical_offset_days_check CHECK ((typical_offset_days >= 0))
);


--
-- Name: v_stage_calendar_status; Type: VIEW; Schema: production; Owner: -
--

CREATE VIEW production.v_stage_calendar_status AS
 SELECT cc.cycle_id,
    cc.unit_id,
    cc.commodity_code,
    cc.status AS cycle_status,
    sc.stage_id,
    sc.stage_seq,
    sc.stage_name,
    sc.planned_date,
    sc.actual_date,
    sc.status AS stage_status
   FROM (production.crop_cycle cc
     JOIN production.stage_calendar sc ON ((sc.cycle_id = cc.cycle_id)))
  ORDER BY cc.cycle_id, sc.stage_seq;


--
-- Name: commodity_ref; Type: TABLE; Schema: registry; Owner: -
--

CREATE TABLE registry.commodity_ref (
    commodity_code text NOT NULL,
    name_th text NOT NULL,
    agrovoc_ref text
);


--
-- Name: TABLE commodity_ref; Type: COMMENT; Schema: registry; Owner: -
--

COMMENT ON TABLE registry.commodity_ref IS 'ตารางอ้างอิงชั่วคราวสำหรับความสมบูรณ์ของ FK เท่านั้น — ระบบ Catalog เต็มรูปแบบพัฒนาในขั้นถัดไป (ขั้นที่ 4)';


--
-- Name: farmbook_sync_log; Type: TABLE; Schema: registry; Owner: -
--

CREATE TABLE registry.farmbook_sync_log (
    sync_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    farmer_id uuid NOT NULL,
    sync_status text NOT NULL,
    farmbook_ref_id text,
    response_summary text,
    attempted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT farmbook_sync_log_sync_status_check CHECK ((sync_status = ANY (ARRAY['pending'::text, 'success'::text, 'not_found'::text, 'failed'::text])))
);


--
-- Name: TABLE farmbook_sync_log; Type: COMMENT; Schema: registry; Owner: -
--

COMMENT ON TABLE registry.farmbook_sync_log IS 'บันทึกทุกครั้งที่เชื่อมต่อกับทะเบียนเกษตรกรกลาง (Farmbook) เป็นแหล่งอ้างอิงภายนอกชุดแรกของแพลตฟอร์ม';


--
-- Name: production_cycle_history; Type: TABLE; Schema: registry; Owner: -
--

CREATE TABLE registry.production_cycle_history (
    cycle_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    unit_id uuid NOT NULL,
    season_id text NOT NULL,
    commodity_code text NOT NULL,
    started_at date NOT NULL,
    ended_at date,
    outcome_summary text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_cycle_dates CHECK (((ended_at IS NULL) OR (ended_at >= started_at)))
);


--
-- Name: TABLE production_cycle_history; Type: COMMENT; Schema: registry; Owner: -
--

COMMENT ON TABLE registry.production_cycle_history IS 'ประวัติย้อนหลังของแต่ละหน่วยผลิต ใช้ประกอบการประเมินความเสี่ยงและวงเงินสินเชื่อในขั้นถัดไป';


--
-- Name: rice_grade_ref; Type: TABLE; Schema: registry; Owner: -
--

CREATE TABLE registry.rice_grade_ref (
    grade_code text NOT NULL,
    name_th text NOT NULL,
    sort_order integer NOT NULL
);


--
-- Name: v_exit_criteria_pilot_plots; Type: VIEW; Schema: registry; Owner: -
--

CREATE VIEW registry.v_exit_criteria_pilot_plots AS
 SELECT count(*) AS total_pilot_plots,
    count(*) FILTER (WHERE (f.status = 'active'::text)) AS plots_with_verified_owner,
    round(((100.0 * (count(*) FILTER (WHERE (f.status = 'active'::text)))::numeric) / (NULLIF(count(*), 0))::numeric), 2) AS pct_verified
   FROM (registry.production_unit pu
     JOIN identity.farmer f ON ((f.farmer_id = pu.owner_farmer_id)));


--
-- Name: VIEW v_exit_criteria_pilot_plots; Type: COMMENT; Schema: registry; Owner: -
--

COMMENT ON VIEW registry.v_exit_criteria_pilot_plots IS 'ใช้ตรวจสอบเกณฑ์ผ่านระยะขั้นที่ 1: ขึ้นทะเบียนแปลงนำร่อง 20-50 แปลง พร้อมยืนยันตัวตนเจ้าของแปลงสำเร็จ 100%';


--
-- Name: v_farmer_latest_score; Type: VIEW; Schema: risk; Owner: -
--

CREATE VIEW risk.v_farmer_latest_score AS
 SELECT DISTINCT ON (cs.farmer_id) cs.farmer_id,
    f.full_name,
    cs.score_value,
    cs.risk_tier,
    cs.factors,
    cs.computed_at,
    cs.score_id
   FROM (risk.credit_score cs
     JOIN identity.farmer f ON ((f.farmer_id = cs.farmer_id)))
  ORDER BY cs.farmer_id, cs.computed_at DESC;


--
-- Name: certificate; Type: TABLE; Schema: traceability; Owner: -
--

CREATE TABLE traceability.certificate (
    certificate_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    delivery_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    cycle_id uuid,
    certificate_type text NOT NULL,
    geo_boundary_snapshot public.geometry(Polygon,4326),
    certificate_ref text NOT NULL,
    status text DEFAULT 'issued'::text NOT NULL,
    issued_by text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT certificate_certificate_type_check CHECK ((certificate_type = ANY (ARRAY['origin_certificate'::text, 'eudr_due_diligence'::text, 'organic_gap'::text]))),
    CONSTRAINT certificate_status_check CHECK ((status = ANY (ARRAY['issued'::text, 'revoked'::text])))
);


--
-- Name: v_executive_summary; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.v_executive_summary AS
 SELECT ( SELECT count(*) AS count
           FROM identity.farmer) AS total_farmers,
    ( SELECT count(*) AS count
           FROM registry.production_unit) AS total_production_units,
    ( SELECT count(*) AS count
           FROM contract.contract
          WHERE (contract.status = 'active'::text)) AS contracts_active,
    ( SELECT count(*) AS count
           FROM contract.contract
          WHERE (contract.status = 'completed'::text)) AS contracts_completed,
    ( SELECT count(*) AS count
           FROM contract.contract
          WHERE (contract.status = ANY (ARRAY['terminated'::text, 'breached'::text]))) AS contracts_terminated_or_breached,
    ( SELECT COALESCE(sum(jl.amount), (0)::numeric) AS "coalesce"
           FROM (ledger.journal_line jl
             JOIN ledger.journal_entry je ON ((je.entry_id = jl.entry_id)))
          WHERE ((je.entry_type = 'CreditDisbursement'::text) AND (jl.direction = 'debit'::text))) AS total_credit_disbursed,
    ( SELECT COALESCE(sum(loan_repayment.amount), (0)::numeric) AS "coalesce"
           FROM credit.loan_repayment) AS total_loan_repaid,
    ( SELECT COALESCE(sum(delivery.total_amount), (0)::numeric) AS "coalesce"
           FROM produce.delivery
          WHERE (delivery.status = 'settled'::text)) AS total_produce_settled_value,
    ( SELECT count(*) AS count
           FROM traceability.certificate) AS certificates_issued,
    ( SELECT round(avg(v_farmer_latest_score.score_value), 2) AS round
           FROM risk.v_farmer_latest_score) AS avg_credit_score,
    ( SELECT count(*) AS count
           FROM risk.v_farmer_latest_score
          WHERE (v_farmer_latest_score.risk_tier = 'A'::text)) AS farmers_tier_a,
    ( SELECT count(*) AS count
           FROM risk.v_farmer_latest_score
          WHERE (v_farmer_latest_score.risk_tier = 'B'::text)) AS farmers_tier_b,
    ( SELECT count(*) AS count
           FROM risk.v_farmer_latest_score
          WHERE (v_farmer_latest_score.risk_tier = 'C'::text)) AS farmers_tier_c,
    ( SELECT count(*) AS count
           FROM risk.v_farmer_latest_score
          WHERE (v_farmer_latest_score.risk_tier = 'D'::text)) AS farmers_tier_d,
    ( SELECT count(*) AS count
           FROM underwriting.loan_application
          WHERE (loan_application.status = 'pending'::text)) AS applications_pending,
    ( SELECT count(*) AS count
           FROM underwriting.loan_application
          WHERE (loan_application.status = 'manual_review'::text)) AS applications_manual_review,
    ( SELECT count(*) AS count
           FROM underwriting.loan_application
          WHERE (loan_application.status = 'converted'::text)) AS applications_converted,
    ( SELECT count(*) AS count
           FROM notification.notification_log
          WHERE ((notification_log.is_read = false) AND (notification_log.severity = 'critical'::text))) AS unread_critical_notifications,
    ( SELECT v_reconciliation_summary.variance
           FROM ledger.v_reconciliation_summary) AS ledger_variance;


--
-- Name: v_farmer_360; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.v_farmer_360 AS
 SELECT f.farmer_id,
    f.full_name,
    ( SELECT count(*) AS count
           FROM registry.production_unit pu
          WHERE (pu.owner_farmer_id = f.farmer_id)) AS production_units_count,
    ( SELECT count(DISTINCT cp.contract_id) AS count
           FROM contract.contract_party cp
          WHERE ((cp.party_type = 'farmer'::text) AND (cp.party_id = f.farmer_id))) AS contracts_total,
    ( SELECT count(DISTINCT cp.contract_id) AS count
           FROM (contract.contract_party cp
             JOIN contract.contract c ON ((c.contract_id = cp.contract_id)))
          WHERE ((cp.party_type = 'farmer'::text) AND (cp.party_id = f.farmer_id) AND (c.status = 'completed'::text))) AS contracts_completed,
    vfs.score_value AS latest_credit_score,
    vfs.risk_tier AS latest_risk_tier,
    vfs.computed_at AS score_computed_at,
    ( SELECT COALESCE(sum(r.amount), (0)::numeric) AS "coalesce"
           FROM ((credit.loan_repayment r
             JOIN contract.contract c ON ((c.contract_id = r.contract_id)))
             JOIN contract.contract_party cp ON ((cp.contract_id = c.contract_id)))
          WHERE ((cp.party_type = 'farmer'::text) AND (cp.party_id = f.farmer_id))) AS total_loan_repaid,
    ( SELECT count(*) AS count
           FROM ((traceability.certificate cert
             JOIN produce.delivery d ON ((d.delivery_id = cert.delivery_id)))
             JOIN registry.production_unit pu ON ((pu.unit_id = d.unit_id)))
          WHERE (pu.owner_farmer_id = f.farmer_id)) AS certificates_count,
    ( SELECT count(*) AS count
           FROM (produce.delivery d
             JOIN registry.production_unit pu ON ((pu.unit_id = d.unit_id)))
          WHERE ((pu.owner_farmer_id = f.farmer_id) AND (d.status = 'settled'::text))) AS deliveries_settled_count
   FROM (identity.farmer f
     LEFT JOIN risk.v_farmer_latest_score vfs ON ((vfs.farmer_id = f.farmer_id)))
  ORDER BY f.full_name;


--
-- Name: retention_policy; Type: TABLE; Schema: retention; Owner: -
--

CREATE TABLE retention.retention_policy (
    policy_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    table_schema text NOT NULL,
    table_name text NOT NULL,
    date_column text NOT NULL,
    retain_days integer NOT NULL,
    last_purged_at timestamp with time zone,
    rows_purged_last_run bigint,
    notes text,
    CONSTRAINT retention_policy_retain_days_check CHECK ((retain_days > 0))
);


--
-- Name: TABLE retention_policy; Type: COMMENT; Schema: retention; Owner: -
--

COMMENT ON TABLE retention.retention_policy IS 'นโยบายเก็บรักษาข้อมูลต่อตาราง — ตารางที่ไม่มีนโยบายในนี้จะไม่ถูก retention.purge_expired_rows() แตะต้องเลย (Allow-list โดยเจตนา ไม่ใช่ Deny-list) เพื่อป้องกันการลบข้อมูลผิดตารางโดยไม่ตั้งใจ';


--
-- Name: v_retention_status; Type: VIEW; Schema: retention; Owner: -
--

CREATE VIEW retention.v_retention_status AS
 SELECT table_schema,
    table_name,
    date_column,
    retain_days,
    last_purged_at,
    rows_purged_last_run,
    notes
   FROM retention.retention_policy
  ORDER BY table_schema, table_name;


--
-- Name: v_current_session; Type: VIEW; Schema: security; Owner: -
--

CREATE VIEW security.v_current_session AS
 SELECT current_setting('app.subject_type'::text, true) AS subject_type,
    (NULLIF(current_setting('app.subject_id'::text, true), ''::text))::uuid AS subject_id;


--
-- Name: v_certificate_trace; Type: VIEW; Schema: traceability; Owner: -
--

CREATE VIEW traceability.v_certificate_trace AS
 SELECT c.certificate_id,
    c.certificate_type,
    c.certificate_ref,
    c.status AS certificate_status,
    c.issued_at,
    d.delivery_id,
    d.commodity_code,
    d.quantity_ton,
    d.quality_grade,
    f.full_name AS farmer_name,
    pu.unit_id,
    pu.area_rai,
    sc.stage_seq,
    sc.stage_name,
    sc.actual_date AS stage_verified_date,
    sc.verification_ref
   FROM ((((traceability.certificate c
     JOIN produce.delivery d ON ((d.delivery_id = c.delivery_id)))
     JOIN registry.production_unit pu ON ((pu.unit_id = c.unit_id)))
     JOIN identity.farmer f ON ((f.farmer_id = pu.owner_farmer_id)))
     LEFT JOIN production.stage_calendar sc ON (((sc.cycle_id = c.cycle_id) AND (sc.status = 'verified'::text))))
  ORDER BY c.certificate_id, sc.stage_seq;


--
-- Name: loan_policy; Type: TABLE; Schema: underwriting; Owner: -
--

CREATE TABLE underwriting.loan_policy (
    risk_tier text NOT NULL,
    max_principal_amount numeric(18,2) NOT NULL,
    interest_rate_bps integer NOT NULL,
    auto_approve boolean DEFAULT false NOT NULL,
    policy_note text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT loan_policy_interest_rate_bps_check CHECK ((interest_rate_bps >= 0)),
    CONSTRAINT loan_policy_max_principal_amount_check CHECK ((max_principal_amount >= (0)::numeric)),
    CONSTRAINT loan_policy_risk_tier_check CHECK ((risk_tier = ANY (ARRAY['A'::text, 'B'::text, 'C'::text, 'D'::text])))
);


--
-- Name: TABLE loan_policy; Type: COMMENT; Schema: underwriting; Owner: -
--

COMMENT ON TABLE underwriting.loan_policy IS 'ตารางนโยบาย (Configuration) กำหนดวงเงินสูงสุดและเงื่อนไขอนุมัติอัตโนมัติต่อระดับความเสี่ยง A-D ของขั้นที่ 6 — แก้ไขได้โดยฝ่ายบริหารความเสี่ยง ไม่ใช่ตารางธุรกรรม';


--
-- Name: v_application_status; Type: VIEW; Schema: underwriting; Owner: -
--

CREATE VIEW underwriting.v_application_status AS
 SELECT la.application_id,
    f.full_name AS farmer_name,
    o.org_name AS lender_name,
    la.requested_amount,
    la.approved_amount,
    la.status,
    la.risk_tier_at_decision,
    la.decision_reason,
    la.contract_id,
    c.status AS contract_status,
    la.created_at,
    la.decided_at
   FROM (((underwriting.loan_application la
     JOIN identity.farmer f ON ((f.farmer_id = la.farmer_id)))
     JOIN identity.organization o ON ((o.org_id = la.lender_org_id)))
     LEFT JOIN contract.contract c ON ((c.contract_id = la.contract_id)));


--
-- Name: access_log access_log_pkey; Type: CONSTRAINT; Schema: audit; Owner: -
--

ALTER TABLE ONLY audit.access_log
    ADD CONSTRAINT access_log_pkey PRIMARY KEY (access_id);


--
-- Name: contract_party contract_party_pkey; Type: CONSTRAINT; Schema: contract; Owner: -
--

ALTER TABLE ONLY contract.contract_party
    ADD CONSTRAINT contract_party_pkey PRIMARY KEY (contract_party_id);


--
-- Name: contract contract_pkey; Type: CONSTRAINT; Schema: contract; Owner: -
--

ALTER TABLE ONLY contract.contract
    ADD CONSTRAINT contract_pkey PRIMARY KEY (contract_id);


--
-- Name: contract_status_history contract_status_history_pkey; Type: CONSTRAINT; Schema: contract; Owner: -
--

ALTER TABLE ONLY contract.contract_status_history
    ADD CONSTRAINT contract_status_history_pkey PRIMARY KEY (history_id);


--
-- Name: digital_signature digital_signature_contract_party_id_key; Type: CONSTRAINT; Schema: contract; Owner: -
--

ALTER TABLE ONLY contract.digital_signature
    ADD CONSTRAINT digital_signature_contract_party_id_key UNIQUE (contract_party_id);


--
-- Name: digital_signature digital_signature_pkey; Type: CONSTRAINT; Schema: contract; Owner: -
--

ALTER TABLE ONLY contract.digital_signature
    ADD CONSTRAINT digital_signature_pkey PRIMARY KEY (signature_id);


--
-- Name: contract_party uq_contract_party; Type: CONSTRAINT; Schema: contract; Owner: -
--

ALTER TABLE ONLY contract.contract_party
    ADD CONSTRAINT uq_contract_party UNIQUE (contract_id, party_role, party_id);


--
-- Name: loan_repayment loan_repayment_pkey; Type: CONSTRAINT; Schema: credit; Owner: -
--

ALTER TABLE ONLY credit.loan_repayment
    ADD CONSTRAINT loan_repayment_pkey PRIMARY KEY (repayment_id);


--
-- Name: farmer farmer_auth_subject_id_key; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.farmer
    ADD CONSTRAINT farmer_auth_subject_id_key UNIQUE (auth_subject_id);


--
-- Name: farmer farmer_pkey; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.farmer
    ADD CONSTRAINT farmer_pkey PRIMARY KEY (farmer_id);


--
-- Name: identity_verification identity_verification_pkey; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.identity_verification
    ADD CONSTRAINT identity_verification_pkey PRIMARY KEY (verification_id);


--
-- Name: organization organization_auth_subject_id_key; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.organization
    ADD CONSTRAINT organization_auth_subject_id_key UNIQUE (auth_subject_id);


--
-- Name: organization_member organization_member_pkey; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.organization_member
    ADD CONSTRAINT organization_member_pkey PRIMARY KEY (member_id);


--
-- Name: organization organization_pkey; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.organization
    ADD CONSTRAINT organization_pkey PRIMARY KEY (org_id);


--
-- Name: organization_role organization_role_pkey; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.organization_role
    ADD CONSTRAINT organization_role_pkey PRIMARY KEY (org_id, role_type);


--
-- Name: role role_pkey; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.role
    ADD CONSTRAINT role_pkey PRIMARY KEY (role_code);


--
-- Name: subject_role subject_role_pkey; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.subject_role
    ADD CONSTRAINT subject_role_pkey PRIMARY KEY (subject_type, subject_id, role_code);


--
-- Name: farmer uq_farmer_national_id_hash; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.farmer
    ADD CONSTRAINT uq_farmer_national_id_hash UNIQUE (national_id_hash);


--
-- Name: farmer uq_farmer_phone; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.farmer
    ADD CONSTRAINT uq_farmer_phone UNIQUE (phone);


--
-- Name: organization uq_organization_tax_id; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.organization
    ADD CONSTRAINT uq_organization_tax_id UNIQUE (tax_id);


--
-- Name: verifiable_credential verifiable_credential_pkey; Type: CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.verifiable_credential
    ADD CONSTRAINT verifiable_credential_pkey PRIMARY KEY (credential_id);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: ledger; Owner: -
--

ALTER TABLE ONLY ledger.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (account_id);


--
-- Name: escrow_hold escrow_hold_pkey; Type: CONSTRAINT; Schema: ledger; Owner: -
--

ALTER TABLE ONLY ledger.escrow_hold
    ADD CONSTRAINT escrow_hold_pkey PRIMARY KEY (hold_id);


--
-- Name: journal_entry journal_entry_pkey; Type: CONSTRAINT; Schema: ledger; Owner: -
--

ALTER TABLE ONLY ledger.journal_entry
    ADD CONSTRAINT journal_entry_pkey PRIMARY KEY (entry_id);


--
-- Name: journal_line journal_line_pkey; Type: CONSTRAINT; Schema: ledger; Owner: -
--

ALTER TABLE ONLY ledger.journal_line
    ADD CONSTRAINT journal_line_pkey PRIMARY KEY (line_id);


--
-- Name: buy_price_quote buy_price_quote_pkey; Type: CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.buy_price_quote
    ADD CONSTRAINT buy_price_quote_pkey PRIMARY KEY (org_id, grade_code);


--
-- Name: product_listing product_listing_pkey; Type: CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.product_listing
    ADD CONSTRAINT product_listing_pkey PRIMARY KEY (listing_id);


--
-- Name: product_order product_order_pkey; Type: CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.product_order
    ADD CONSTRAINT product_order_pkey PRIMARY KEY (order_id);


--
-- Name: product_photo product_photo_pkey; Type: CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.product_photo
    ADD CONSTRAINT product_photo_pkey PRIMARY KEY (photo_id);


--
-- Name: service_listing service_listing_pkey; Type: CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.service_listing
    ADD CONSTRAINT service_listing_pkey PRIMARY KEY (listing_id);


--
-- Name: service_request service_request_pkey; Type: CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.service_request
    ADD CONSTRAINT service_request_pkey PRIMARY KEY (request_id);


--
-- Name: vendor_photo vendor_photo_pkey; Type: CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.vendor_photo
    ADD CONSTRAINT vendor_photo_pkey PRIMARY KEY (photo_id);


--
-- Name: alert_event alert_event_pkey; Type: CONSTRAINT; Schema: monitoring; Owner: -
--

ALTER TABLE ONLY monitoring.alert_event
    ADD CONSTRAINT alert_event_pkey PRIMARY KEY (alert_id);


--
-- Name: go_live_checklist go_live_checklist_pkey; Type: CONSTRAINT; Schema: monitoring; Owner: -
--

ALTER TABLE ONLY monitoring.go_live_checklist
    ADD CONSTRAINT go_live_checklist_pkey PRIMARY KEY (item_id);


--
-- Name: metric_observation metric_observation_pkey; Type: CONSTRAINT; Schema: monitoring; Owner: -
--

ALTER TABLE ONLY monitoring.metric_observation
    ADD CONSTRAINT metric_observation_pkey PRIMARY KEY (observation_id);


--
-- Name: metric_threshold metric_threshold_pkey; Type: CONSTRAINT; Schema: monitoring; Owner: -
--

ALTER TABLE ONLY monitoring.metric_threshold
    ADD CONSTRAINT metric_threshold_pkey PRIMARY KEY (threshold_id);


--
-- Name: notification_log notification_log_pkey; Type: CONSTRAINT; Schema: notification; Owner: -
--

ALTER TABLE ONLY notification.notification_log
    ADD CONSTRAINT notification_log_pkey PRIMARY KEY (notification_id);


--
-- Name: backup_log backup_log_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.backup_log
    ADD CONSTRAINT backup_log_pkey PRIMARY KEY (backup_id);


--
-- Name: performance_benchmark performance_benchmark_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.performance_benchmark
    ADD CONSTRAINT performance_benchmark_pkey PRIMARY KEY (benchmark_id);


--
-- Name: query_observation query_observation_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.query_observation
    ADD CONSTRAINT query_observation_pkey PRIMARY KEY (observation_id);


--
-- Name: restore_test_log restore_test_log_pkey; Type: CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.restore_test_log
    ADD CONSTRAINT restore_test_log_pkey PRIMARY KEY (restore_test_id);


--
-- Name: vendor_profile uq_vendor_business_registration_no; Type: CONSTRAINT; Schema: partner; Owner: -
--

ALTER TABLE ONLY partner.vendor_profile
    ADD CONSTRAINT uq_vendor_business_registration_no UNIQUE (business_registration_no);


--
-- Name: vendor_document vendor_document_pkey; Type: CONSTRAINT; Schema: partner; Owner: -
--

ALTER TABLE ONLY partner.vendor_document
    ADD CONSTRAINT vendor_document_pkey PRIMARY KEY (document_id);


--
-- Name: vendor_profile vendor_profile_pkey; Type: CONSTRAINT; Schema: partner; Owner: -
--

ALTER TABLE ONLY partner.vendor_profile
    ADD CONSTRAINT vendor_profile_pkey PRIMARY KEY (org_id);


--
-- Name: delivery delivery_pkey; Type: CONSTRAINT; Schema: produce; Owner: -
--

ALTER TABLE ONLY produce.delivery
    ADD CONSTRAINT delivery_pkey PRIMARY KEY (delivery_id);


--
-- Name: crop_cycle crop_cycle_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.crop_cycle
    ADD CONSTRAINT crop_cycle_pkey PRIMARY KEY (cycle_id);


--
-- Name: stage_calendar stage_calendar_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.stage_calendar
    ADD CONSTRAINT stage_calendar_pkey PRIMARY KEY (stage_id);


--
-- Name: stage_template stage_template_pkey; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.stage_template
    ADD CONSTRAINT stage_template_pkey PRIMARY KEY (stage_template_id);


--
-- Name: stage_calendar uq_stage_calendar; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.stage_calendar
    ADD CONSTRAINT uq_stage_calendar UNIQUE (cycle_id, stage_seq);


--
-- Name: stage_template uq_stage_template; Type: CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.stage_template
    ADD CONSTRAINT uq_stage_template UNIQUE (commodity_code, stage_seq);


--
-- Name: commodity_ref commodity_ref_pkey; Type: CONSTRAINT; Schema: registry; Owner: -
--

ALTER TABLE ONLY registry.commodity_ref
    ADD CONSTRAINT commodity_ref_pkey PRIMARY KEY (commodity_code);


--
-- Name: farmbook_sync_log farmbook_sync_log_pkey; Type: CONSTRAINT; Schema: registry; Owner: -
--

ALTER TABLE ONLY registry.farmbook_sync_log
    ADD CONSTRAINT farmbook_sync_log_pkey PRIMARY KEY (sync_id);


--
-- Name: production_cycle_history production_cycle_history_pkey; Type: CONSTRAINT; Schema: registry; Owner: -
--

ALTER TABLE ONLY registry.production_cycle_history
    ADD CONSTRAINT production_cycle_history_pkey PRIMARY KEY (cycle_id);


--
-- Name: production_unit production_unit_pkey; Type: CONSTRAINT; Schema: registry; Owner: -
--

ALTER TABLE ONLY registry.production_unit
    ADD CONSTRAINT production_unit_pkey PRIMARY KEY (unit_id);


--
-- Name: rice_grade_ref rice_grade_ref_pkey; Type: CONSTRAINT; Schema: registry; Owner: -
--

ALTER TABLE ONLY registry.rice_grade_ref
    ADD CONSTRAINT rice_grade_ref_pkey PRIMARY KEY (grade_code);


--
-- Name: retention_policy retention_policy_pkey; Type: CONSTRAINT; Schema: retention; Owner: -
--

ALTER TABLE ONLY retention.retention_policy
    ADD CONSTRAINT retention_policy_pkey PRIMARY KEY (policy_id);


--
-- Name: retention_policy retention_policy_table_schema_table_name_key; Type: CONSTRAINT; Schema: retention; Owner: -
--

ALTER TABLE ONLY retention.retention_policy
    ADD CONSTRAINT retention_policy_table_schema_table_name_key UNIQUE (table_schema, table_name);


--
-- Name: credit_score credit_score_pkey; Type: CONSTRAINT; Schema: risk; Owner: -
--

ALTER TABLE ONLY risk.credit_score
    ADD CONSTRAINT credit_score_pkey PRIMARY KEY (score_id);


--
-- Name: certificate certificate_pkey; Type: CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.certificate
    ADD CONSTRAINT certificate_pkey PRIMARY KEY (certificate_id);


--
-- Name: loan_application loan_application_pkey; Type: CONSTRAINT; Schema: underwriting; Owner: -
--

ALTER TABLE ONLY underwriting.loan_application
    ADD CONSTRAINT loan_application_pkey PRIMARY KEY (application_id);


--
-- Name: loan_policy loan_policy_pkey; Type: CONSTRAINT; Schema: underwriting; Owner: -
--

ALTER TABLE ONLY underwriting.loan_policy
    ADD CONSTRAINT loan_policy_pkey PRIMARY KEY (risk_tier);


--
-- Name: idx_access_log_occurred_at; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX idx_access_log_occurred_at ON audit.access_log USING btree (occurred_at DESC);


--
-- Name: idx_access_log_resource; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX idx_access_log_resource ON audit.access_log USING btree (resource_type, resource_id);


--
-- Name: idx_access_log_subject; Type: INDEX; Schema: audit; Owner: -
--

CREATE INDEX idx_access_log_subject ON audit.access_log USING btree (subject_type, subject_id);


--
-- Name: idx_contract_party_contract; Type: INDEX; Schema: contract; Owner: -
--

CREATE INDEX idx_contract_party_contract ON contract.contract_party USING btree (contract_id);


--
-- Name: idx_loan_repayment_contract; Type: INDEX; Schema: credit; Owner: -
--

CREATE INDEX idx_loan_repayment_contract ON credit.loan_repayment USING btree (contract_id);


--
-- Name: idx_identity_verification_subject; Type: INDEX; Schema: identity; Owner: -
--

CREATE INDEX idx_identity_verification_subject ON identity.identity_verification USING btree (subject_type, subject_id);


--
-- Name: idx_organization_role_status; Type: INDEX; Schema: identity; Owner: -
--

CREATE INDEX idx_organization_role_status ON identity.organization_role USING btree (status);


--
-- Name: idx_vc_holder; Type: INDEX; Schema: identity; Owner: -
--

CREATE INDEX idx_vc_holder ON identity.verifiable_credential USING btree (holder_type, holder_id);


--
-- Name: idx_account_owner; Type: INDEX; Schema: ledger; Owner: -
--

CREATE INDEX idx_account_owner ON ledger.account USING btree (owner_type, owner_id);


--
-- Name: idx_escrow_unit; Type: INDEX; Schema: ledger; Owner: -
--

CREATE INDEX idx_escrow_unit ON ledger.escrow_hold USING btree (unit_id);


--
-- Name: idx_journal_entry_posted_at; Type: INDEX; Schema: ledger; Owner: -
--

CREATE INDEX idx_journal_entry_posted_at ON ledger.journal_entry USING btree (posted_at);


--
-- Name: idx_journal_entry_reference; Type: INDEX; Schema: ledger; Owner: -
--

CREATE INDEX idx_journal_entry_reference ON ledger.journal_entry USING btree (reference_type, reference_id);


--
-- Name: idx_journal_line_account; Type: INDEX; Schema: ledger; Owner: -
--

CREATE INDEX idx_journal_line_account ON ledger.journal_line USING btree (account_id, created_at);


--
-- Name: idx_journal_line_entry; Type: INDEX; Schema: ledger; Owner: -
--

CREATE INDEX idx_journal_line_entry ON ledger.journal_line USING btree (entry_id);


--
-- Name: uq_unit_wallet_per_unit; Type: INDEX; Schema: ledger; Owner: -
--

CREATE UNIQUE INDEX uq_unit_wallet_per_unit ON ledger.account USING btree (owner_id) WHERE (account_type = 'unit_wallet'::text);


--
-- Name: idx_buy_price_quote_grade_active; Type: INDEX; Schema: marketplace; Owner: -
--

CREATE INDEX idx_buy_price_quote_grade_active ON marketplace.buy_price_quote USING btree (grade_code) WHERE is_active;


--
-- Name: idx_product_listing_org; Type: INDEX; Schema: marketplace; Owner: -
--

CREATE INDEX idx_product_listing_org ON marketplace.product_listing USING btree (org_id);


--
-- Name: idx_product_listing_org_category; Type: INDEX; Schema: marketplace; Owner: -
--

CREATE INDEX idx_product_listing_org_category ON marketplace.product_listing USING btree (org_id, category);


--
-- Name: idx_product_order_farmer; Type: INDEX; Schema: marketplace; Owner: -
--

CREATE INDEX idx_product_order_farmer ON marketplace.product_order USING btree (farmer_id);


--
-- Name: idx_product_order_listing; Type: INDEX; Schema: marketplace; Owner: -
--

CREATE INDEX idx_product_order_listing ON marketplace.product_order USING btree (listing_id);


--
-- Name: idx_product_order_org; Type: INDEX; Schema: marketplace; Owner: -
--

CREATE INDEX idx_product_order_org ON marketplace.product_order USING btree (org_id, status);


--
-- Name: idx_product_photo_listing; Type: INDEX; Schema: marketplace; Owner: -
--

CREATE INDEX idx_product_photo_listing ON marketplace.product_photo USING btree (listing_id);


--
-- Name: idx_product_photo_org; Type: INDEX; Schema: marketplace; Owner: -
--

CREATE INDEX idx_product_photo_org ON marketplace.product_photo USING btree (org_id);


--
-- Name: idx_service_listing_org; Type: INDEX; Schema: marketplace; Owner: -
--

CREATE INDEX idx_service_listing_org ON marketplace.service_listing USING btree (org_id);


--
-- Name: idx_service_request_unit; Type: INDEX; Schema: marketplace; Owner: -
--

CREATE INDEX idx_service_request_unit ON marketplace.service_request USING btree (unit_id);


--
-- Name: idx_vendor_photo_org; Type: INDEX; Schema: marketplace; Owner: -
--

CREATE INDEX idx_vendor_photo_org ON marketplace.vendor_photo USING btree (org_id);


--
-- Name: uq_service_listing_org_service_key; Type: INDEX; Schema: marketplace; Owner: -
--

CREATE UNIQUE INDEX uq_service_listing_org_service_key ON marketplace.service_listing USING btree (org_id, service_key) WHERE (service_key IS NOT NULL);


--
-- Name: idx_alert_event_unacknowledged; Type: INDEX; Schema: monitoring; Owner: -
--

CREATE INDEX idx_alert_event_unacknowledged ON monitoring.alert_event USING btree (fired_at DESC) WHERE (acknowledged = false);


--
-- Name: idx_metric_observation_name_time; Type: INDEX; Schema: monitoring; Owner: -
--

CREATE INDEX idx_metric_observation_name_time ON monitoring.metric_observation USING btree (metric_name, observed_at DESC);


--
-- Name: idx_notification_log_subject; Type: INDEX; Schema: notification; Owner: -
--

CREATE INDEX idx_notification_log_subject ON notification.notification_log USING btree (subject_type, subject_id);


--
-- Name: idx_notification_log_unread; Type: INDEX; Schema: notification; Owner: -
--

CREATE INDEX idx_notification_log_unread ON notification.notification_log USING btree (is_read) WHERE (is_read = false);


--
-- Name: idx_backup_log_started_at; Type: INDEX; Schema: ops; Owner: -
--

CREATE INDEX idx_backup_log_started_at ON ops.backup_log USING btree (started_at DESC);


--
-- Name: idx_restore_test_log_backup_id; Type: INDEX; Schema: ops; Owner: -
--

CREATE INDEX idx_restore_test_log_backup_id ON ops.restore_test_log USING btree (backup_id);


--
-- Name: idx_vendor_document_org; Type: INDEX; Schema: partner; Owner: -
--

CREATE INDEX idx_vendor_document_org ON partner.vendor_document USING btree (org_id);


--
-- Name: idx_delivery_contract; Type: INDEX; Schema: produce; Owner: -
--

CREATE INDEX idx_delivery_contract ON produce.delivery USING btree (contract_id);


--
-- Name: idx_delivery_unit; Type: INDEX; Schema: produce; Owner: -
--

CREATE INDEX idx_delivery_unit ON produce.delivery USING btree (unit_id);


--
-- Name: idx_crop_cycle_unit; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX idx_crop_cycle_unit ON production.crop_cycle USING btree (unit_id);


--
-- Name: idx_stage_calendar_cycle; Type: INDEX; Schema: production; Owner: -
--

CREATE INDEX idx_stage_calendar_cycle ON production.stage_calendar USING btree (cycle_id);


--
-- Name: idx_cycle_unit; Type: INDEX; Schema: registry; Owner: -
--

CREATE INDEX idx_cycle_unit ON registry.production_cycle_history USING btree (unit_id);


--
-- Name: idx_farmbook_sync_farmer; Type: INDEX; Schema: registry; Owner: -
--

CREATE INDEX idx_farmbook_sync_farmer ON registry.farmbook_sync_log USING btree (farmer_id, attempted_at DESC);


--
-- Name: idx_production_unit_boundary; Type: INDEX; Schema: registry; Owner: -
--

CREATE INDEX idx_production_unit_boundary ON registry.production_unit USING gist (gps_boundary);


--
-- Name: idx_production_unit_owner; Type: INDEX; Schema: registry; Owner: -
--

CREATE INDEX idx_production_unit_owner ON registry.production_unit USING btree (owner_farmer_id);


--
-- Name: idx_credit_score_farmer; Type: INDEX; Schema: risk; Owner: -
--

CREATE INDEX idx_credit_score_farmer ON risk.credit_score USING btree (farmer_id, computed_at DESC);


--
-- Name: idx_certificate_delivery; Type: INDEX; Schema: traceability; Owner: -
--

CREATE INDEX idx_certificate_delivery ON traceability.certificate USING btree (delivery_id);


--
-- Name: idx_loan_application_farmer; Type: INDEX; Schema: underwriting; Owner: -
--

CREATE INDEX idx_loan_application_farmer ON underwriting.loan_application USING btree (farmer_id);


--
-- Name: idx_loan_application_status; Type: INDEX; Schema: underwriting; Owner: -
--

CREATE INDEX idx_loan_application_status ON underwriting.loan_application USING btree (status);


--
-- Name: contract_party trg_check_contract_party; Type: TRIGGER; Schema: contract; Owner: -
--

CREATE TRIGGER trg_check_contract_party BEFORE INSERT OR UPDATE ON contract.contract_party FOR EACH ROW EXECUTE FUNCTION contract.fn_check_party_owner();


--
-- Name: contract trg_log_status_change; Type: TRIGGER; Schema: contract; Owner: -
--

CREATE TRIGGER trg_log_status_change AFTER UPDATE ON contract.contract FOR EACH ROW EXECUTE FUNCTION contract.fn_log_status_change();


--
-- Name: contract_status_history trg_notify_contract_status; Type: TRIGGER; Schema: contract; Owner: -
--

CREATE TRIGGER trg_notify_contract_status AFTER INSERT ON contract.contract_status_history FOR EACH ROW EXECUTE FUNCTION notification.fn_notify_contract_status();


--
-- Name: loan_repayment trg_notify_late_repayment; Type: TRIGGER; Schema: credit; Owner: -
--

CREATE TRIGGER trg_notify_late_repayment AFTER INSERT ON credit.loan_repayment FOR EACH ROW EXECUTE FUNCTION notification.fn_notify_late_repayment();


--
-- Name: identity_verification trg_check_verification_subject; Type: TRIGGER; Schema: identity; Owner: -
--

CREATE TRIGGER trg_check_verification_subject BEFORE INSERT OR UPDATE ON identity.identity_verification FOR EACH ROW EXECUTE FUNCTION identity.fn_check_verification_subject();


--
-- Name: account trg_check_account_owner; Type: TRIGGER; Schema: ledger; Owner: -
--

CREATE TRIGGER trg_check_account_owner BEFORE INSERT OR UPDATE ON ledger.account FOR EACH ROW EXECUTE FUNCTION ledger.fn_check_account_owner();


--
-- Name: journal_line trg_check_entry_balanced; Type: TRIGGER; Schema: ledger; Owner: -
--

CREATE CONSTRAINT TRIGGER trg_check_entry_balanced AFTER INSERT OR DELETE OR UPDATE ON ledger.journal_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.fn_check_entry_balanced();


--
-- Name: credit_score trg_notify_low_score; Type: TRIGGER; Schema: risk; Owner: -
--

CREATE TRIGGER trg_notify_low_score AFTER INSERT ON risk.credit_score FOR EACH ROW EXECUTE FUNCTION notification.fn_notify_low_score();


--
-- Name: loan_application trg_notify_application_decision; Type: TRIGGER; Schema: underwriting; Owner: -
--

CREATE TRIGGER trg_notify_application_decision AFTER UPDATE ON underwriting.loan_application FOR EACH ROW EXECUTE FUNCTION notification.fn_notify_application_decision();


--
-- Name: contract contract_escrow_hold_id_fkey; Type: FK CONSTRAINT; Schema: contract; Owner: -
--

ALTER TABLE ONLY contract.contract
    ADD CONSTRAINT contract_escrow_hold_id_fkey FOREIGN KEY (escrow_hold_id) REFERENCES ledger.escrow_hold(hold_id);


--
-- Name: contract_party contract_party_contract_id_fkey; Type: FK CONSTRAINT; Schema: contract; Owner: -
--

ALTER TABLE ONLY contract.contract_party
    ADD CONSTRAINT contract_party_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES contract.contract(contract_id) ON DELETE CASCADE;


--
-- Name: contract contract_related_unit_id_fkey; Type: FK CONSTRAINT; Schema: contract; Owner: -
--

ALTER TABLE ONLY contract.contract
    ADD CONSTRAINT contract_related_unit_id_fkey FOREIGN KEY (related_unit_id) REFERENCES registry.production_unit(unit_id);


--
-- Name: contract_status_history contract_status_history_contract_id_fkey; Type: FK CONSTRAINT; Schema: contract; Owner: -
--

ALTER TABLE ONLY contract.contract_status_history
    ADD CONSTRAINT contract_status_history_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES contract.contract(contract_id) ON DELETE CASCADE;


--
-- Name: digital_signature digital_signature_contract_party_id_fkey; Type: FK CONSTRAINT; Schema: contract; Owner: -
--

ALTER TABLE ONLY contract.digital_signature
    ADD CONSTRAINT digital_signature_contract_party_id_fkey FOREIGN KEY (contract_party_id) REFERENCES contract.contract_party(contract_party_id) ON DELETE CASCADE;


--
-- Name: loan_repayment loan_repayment_contract_id_fkey; Type: FK CONSTRAINT; Schema: credit; Owner: -
--

ALTER TABLE ONLY credit.loan_repayment
    ADD CONSTRAINT loan_repayment_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES contract.contract(contract_id);


--
-- Name: loan_repayment loan_repayment_settlement_entry_id_fkey; Type: FK CONSTRAINT; Schema: credit; Owner: -
--

ALTER TABLE ONLY credit.loan_repayment
    ADD CONSTRAINT loan_repayment_settlement_entry_id_fkey FOREIGN KEY (settlement_entry_id) REFERENCES ledger.journal_entry(entry_id);


--
-- Name: organization_member organization_member_farmer_id_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.organization_member
    ADD CONSTRAINT organization_member_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES identity.farmer(farmer_id) ON DELETE SET NULL;


--
-- Name: organization_member organization_member_org_id_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.organization_member
    ADD CONSTRAINT organization_member_org_id_fkey FOREIGN KEY (org_id) REFERENCES identity.organization(org_id) ON DELETE CASCADE;


--
-- Name: organization_role organization_role_org_id_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.organization_role
    ADD CONSTRAINT organization_role_org_id_fkey FOREIGN KEY (org_id) REFERENCES identity.organization(org_id) ON DELETE CASCADE;


--
-- Name: subject_role subject_role_role_code_fkey; Type: FK CONSTRAINT; Schema: identity; Owner: -
--

ALTER TABLE ONLY identity.subject_role
    ADD CONSTRAINT subject_role_role_code_fkey FOREIGN KEY (role_code) REFERENCES identity.role(role_code);


--
-- Name: escrow_hold escrow_hold_escrow_account_id_fkey; Type: FK CONSTRAINT; Schema: ledger; Owner: -
--

ALTER TABLE ONLY ledger.escrow_hold
    ADD CONSTRAINT escrow_hold_escrow_account_id_fkey FOREIGN KEY (escrow_account_id) REFERENCES ledger.account(account_id);


--
-- Name: escrow_hold escrow_hold_hold_entry_id_fkey; Type: FK CONSTRAINT; Schema: ledger; Owner: -
--

ALTER TABLE ONLY ledger.escrow_hold
    ADD CONSTRAINT escrow_hold_hold_entry_id_fkey FOREIGN KEY (hold_entry_id) REFERENCES ledger.journal_entry(entry_id);


--
-- Name: escrow_hold escrow_hold_release_entry_id_fkey; Type: FK CONSTRAINT; Schema: ledger; Owner: -
--

ALTER TABLE ONLY ledger.escrow_hold
    ADD CONSTRAINT escrow_hold_release_entry_id_fkey FOREIGN KEY (release_entry_id) REFERENCES ledger.journal_entry(entry_id);


--
-- Name: escrow_hold escrow_hold_unit_id_fkey; Type: FK CONSTRAINT; Schema: ledger; Owner: -
--

ALTER TABLE ONLY ledger.escrow_hold
    ADD CONSTRAINT escrow_hold_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES registry.production_unit(unit_id);


--
-- Name: journal_line journal_line_account_id_fkey; Type: FK CONSTRAINT; Schema: ledger; Owner: -
--

ALTER TABLE ONLY ledger.journal_line
    ADD CONSTRAINT journal_line_account_id_fkey FOREIGN KEY (account_id) REFERENCES ledger.account(account_id);


--
-- Name: journal_line journal_line_entry_id_fkey; Type: FK CONSTRAINT; Schema: ledger; Owner: -
--

ALTER TABLE ONLY ledger.journal_line
    ADD CONSTRAINT journal_line_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES ledger.journal_entry(entry_id) ON DELETE CASCADE;


--
-- Name: buy_price_quote buy_price_quote_grade_code_fkey; Type: FK CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.buy_price_quote
    ADD CONSTRAINT buy_price_quote_grade_code_fkey FOREIGN KEY (grade_code) REFERENCES registry.rice_grade_ref(grade_code);


--
-- Name: buy_price_quote buy_price_quote_org_id_fkey; Type: FK CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.buy_price_quote
    ADD CONSTRAINT buy_price_quote_org_id_fkey FOREIGN KEY (org_id) REFERENCES identity.organization(org_id) ON DELETE CASCADE;


--
-- Name: product_listing product_listing_org_id_fkey; Type: FK CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.product_listing
    ADD CONSTRAINT product_listing_org_id_fkey FOREIGN KEY (org_id) REFERENCES partner.vendor_profile(org_id);


--
-- Name: product_order product_order_farmer_id_fkey; Type: FK CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.product_order
    ADD CONSTRAINT product_order_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES identity.farmer(farmer_id) ON DELETE CASCADE;


--
-- Name: product_order product_order_listing_id_fkey; Type: FK CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.product_order
    ADD CONSTRAINT product_order_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES marketplace.product_listing(listing_id);


--
-- Name: product_order product_order_org_id_fkey; Type: FK CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.product_order
    ADD CONSTRAINT product_order_org_id_fkey FOREIGN KEY (org_id) REFERENCES identity.organization(org_id) ON DELETE CASCADE;


--
-- Name: product_photo product_photo_listing_id_fkey; Type: FK CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.product_photo
    ADD CONSTRAINT product_photo_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES marketplace.product_listing(listing_id) ON DELETE CASCADE;


--
-- Name: service_listing service_listing_org_id_fkey; Type: FK CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.service_listing
    ADD CONSTRAINT service_listing_org_id_fkey FOREIGN KEY (org_id) REFERENCES partner.vendor_profile(org_id);


--
-- Name: service_request service_request_cycle_id_fkey; Type: FK CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.service_request
    ADD CONSTRAINT service_request_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES production.crop_cycle(cycle_id);


--
-- Name: service_request service_request_listing_id_fkey; Type: FK CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.service_request
    ADD CONSTRAINT service_request_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES marketplace.service_listing(listing_id);


--
-- Name: service_request service_request_payment_entry_id_fkey; Type: FK CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.service_request
    ADD CONSTRAINT service_request_payment_entry_id_fkey FOREIGN KEY (payment_entry_id) REFERENCES ledger.journal_entry(entry_id);


--
-- Name: service_request service_request_stage_id_fkey; Type: FK CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.service_request
    ADD CONSTRAINT service_request_stage_id_fkey FOREIGN KEY (stage_id) REFERENCES production.stage_calendar(stage_id);


--
-- Name: service_request service_request_unit_id_fkey; Type: FK CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.service_request
    ADD CONSTRAINT service_request_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES registry.production_unit(unit_id);


--
-- Name: vendor_photo vendor_photo_org_id_fkey; Type: FK CONSTRAINT; Schema: marketplace; Owner: -
--

ALTER TABLE ONLY marketplace.vendor_photo
    ADD CONSTRAINT vendor_photo_org_id_fkey FOREIGN KEY (org_id) REFERENCES partner.vendor_profile(org_id) ON DELETE CASCADE;


--
-- Name: alert_event alert_event_observation_id_fkey; Type: FK CONSTRAINT; Schema: monitoring; Owner: -
--

ALTER TABLE ONLY monitoring.alert_event
    ADD CONSTRAINT alert_event_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES monitoring.metric_observation(observation_id);


--
-- Name: alert_event alert_event_threshold_id_fkey; Type: FK CONSTRAINT; Schema: monitoring; Owner: -
--

ALTER TABLE ONLY monitoring.alert_event
    ADD CONSTRAINT alert_event_threshold_id_fkey FOREIGN KEY (threshold_id) REFERENCES monitoring.metric_threshold(threshold_id);


--
-- Name: restore_test_log restore_test_log_backup_id_fkey; Type: FK CONSTRAINT; Schema: ops; Owner: -
--

ALTER TABLE ONLY ops.restore_test_log
    ADD CONSTRAINT restore_test_log_backup_id_fkey FOREIGN KEY (backup_id) REFERENCES ops.backup_log(backup_id);


--
-- Name: vendor_document vendor_document_org_id_fkey; Type: FK CONSTRAINT; Schema: partner; Owner: -
--

ALTER TABLE ONLY partner.vendor_document
    ADD CONSTRAINT vendor_document_org_id_fkey FOREIGN KEY (org_id) REFERENCES partner.vendor_profile(org_id) ON DELETE CASCADE;


--
-- Name: vendor_profile vendor_profile_lender_clearing_account_id_fkey; Type: FK CONSTRAINT; Schema: partner; Owner: -
--

ALTER TABLE ONLY partner.vendor_profile
    ADD CONSTRAINT vendor_profile_lender_clearing_account_id_fkey FOREIGN KEY (lender_clearing_account_id) REFERENCES ledger.account(account_id);


--
-- Name: vendor_profile vendor_profile_org_id_fkey; Type: FK CONSTRAINT; Schema: partner; Owner: -
--

ALTER TABLE ONLY partner.vendor_profile
    ADD CONSTRAINT vendor_profile_org_id_fkey FOREIGN KEY (org_id) REFERENCES identity.organization(org_id) ON DELETE CASCADE;


--
-- Name: vendor_profile vendor_profile_settlement_account_id_fkey; Type: FK CONSTRAINT; Schema: partner; Owner: -
--

ALTER TABLE ONLY partner.vendor_profile
    ADD CONSTRAINT vendor_profile_settlement_account_id_fkey FOREIGN KEY (settlement_account_id) REFERENCES ledger.account(account_id);


--
-- Name: delivery delivery_buyer_org_id_fkey; Type: FK CONSTRAINT; Schema: produce; Owner: -
--

ALTER TABLE ONLY produce.delivery
    ADD CONSTRAINT delivery_buyer_org_id_fkey FOREIGN KEY (buyer_org_id) REFERENCES identity.organization(org_id);


--
-- Name: delivery delivery_commodity_code_fkey; Type: FK CONSTRAINT; Schema: produce; Owner: -
--

ALTER TABLE ONLY produce.delivery
    ADD CONSTRAINT delivery_commodity_code_fkey FOREIGN KEY (commodity_code) REFERENCES registry.commodity_ref(commodity_code);


--
-- Name: delivery delivery_contract_id_fkey; Type: FK CONSTRAINT; Schema: produce; Owner: -
--

ALTER TABLE ONLY produce.delivery
    ADD CONSTRAINT delivery_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES contract.contract(contract_id);


--
-- Name: delivery delivery_cycle_id_fkey; Type: FK CONSTRAINT; Schema: produce; Owner: -
--

ALTER TABLE ONLY produce.delivery
    ADD CONSTRAINT delivery_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES production.crop_cycle(cycle_id);


--
-- Name: delivery delivery_settlement_entry_id_fkey; Type: FK CONSTRAINT; Schema: produce; Owner: -
--

ALTER TABLE ONLY produce.delivery
    ADD CONSTRAINT delivery_settlement_entry_id_fkey FOREIGN KEY (settlement_entry_id) REFERENCES ledger.journal_entry(entry_id);


--
-- Name: delivery delivery_unit_id_fkey; Type: FK CONSTRAINT; Schema: produce; Owner: -
--

ALTER TABLE ONLY produce.delivery
    ADD CONSTRAINT delivery_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES registry.production_unit(unit_id);


--
-- Name: crop_cycle crop_cycle_commodity_code_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.crop_cycle
    ADD CONSTRAINT crop_cycle_commodity_code_fkey FOREIGN KEY (commodity_code) REFERENCES registry.commodity_ref(commodity_code);


--
-- Name: crop_cycle crop_cycle_linked_contract_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.crop_cycle
    ADD CONSTRAINT crop_cycle_linked_contract_id_fkey FOREIGN KEY (linked_contract_id) REFERENCES contract.contract(contract_id);


--
-- Name: crop_cycle crop_cycle_unit_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.crop_cycle
    ADD CONSTRAINT crop_cycle_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES registry.production_unit(unit_id);


--
-- Name: stage_calendar stage_calendar_cycle_id_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.stage_calendar
    ADD CONSTRAINT stage_calendar_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES production.crop_cycle(cycle_id) ON DELETE CASCADE;


--
-- Name: stage_template stage_template_commodity_code_fkey; Type: FK CONSTRAINT; Schema: production; Owner: -
--

ALTER TABLE ONLY production.stage_template
    ADD CONSTRAINT stage_template_commodity_code_fkey FOREIGN KEY (commodity_code) REFERENCES registry.commodity_ref(commodity_code);


--
-- Name: farmbook_sync_log farmbook_sync_log_farmer_id_fkey; Type: FK CONSTRAINT; Schema: registry; Owner: -
--

ALTER TABLE ONLY registry.farmbook_sync_log
    ADD CONSTRAINT farmbook_sync_log_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES identity.farmer(farmer_id) ON DELETE CASCADE;


--
-- Name: production_cycle_history production_cycle_history_commodity_code_fkey; Type: FK CONSTRAINT; Schema: registry; Owner: -
--

ALTER TABLE ONLY registry.production_cycle_history
    ADD CONSTRAINT production_cycle_history_commodity_code_fkey FOREIGN KEY (commodity_code) REFERENCES registry.commodity_ref(commodity_code);


--
-- Name: production_cycle_history production_cycle_history_unit_id_fkey; Type: FK CONSTRAINT; Schema: registry; Owner: -
--

ALTER TABLE ONLY registry.production_cycle_history
    ADD CONSTRAINT production_cycle_history_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES registry.production_unit(unit_id) ON DELETE CASCADE;


--
-- Name: production_unit production_unit_commodity_code_fkey; Type: FK CONSTRAINT; Schema: registry; Owner: -
--

ALTER TABLE ONLY registry.production_unit
    ADD CONSTRAINT production_unit_commodity_code_fkey FOREIGN KEY (commodity_code) REFERENCES registry.commodity_ref(commodity_code);


--
-- Name: production_unit production_unit_owner_farmer_id_fkey; Type: FK CONSTRAINT; Schema: registry; Owner: -
--

ALTER TABLE ONLY registry.production_unit
    ADD CONSTRAINT production_unit_owner_farmer_id_fkey FOREIGN KEY (owner_farmer_id) REFERENCES identity.farmer(farmer_id);


--
-- Name: credit_score credit_score_farmer_id_fkey; Type: FK CONSTRAINT; Schema: risk; Owner: -
--

ALTER TABLE ONLY risk.credit_score
    ADD CONSTRAINT credit_score_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES identity.farmer(farmer_id);


--
-- Name: certificate certificate_cycle_id_fkey; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.certificate
    ADD CONSTRAINT certificate_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES production.crop_cycle(cycle_id);


--
-- Name: certificate certificate_delivery_id_fkey; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.certificate
    ADD CONSTRAINT certificate_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES produce.delivery(delivery_id);


--
-- Name: certificate certificate_unit_id_fkey; Type: FK CONSTRAINT; Schema: traceability; Owner: -
--

ALTER TABLE ONLY traceability.certificate
    ADD CONSTRAINT certificate_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES registry.production_unit(unit_id);


--
-- Name: loan_application loan_application_contract_id_fkey; Type: FK CONSTRAINT; Schema: underwriting; Owner: -
--

ALTER TABLE ONLY underwriting.loan_application
    ADD CONSTRAINT loan_application_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES contract.contract(contract_id);


--
-- Name: loan_application loan_application_farmer_id_fkey; Type: FK CONSTRAINT; Schema: underwriting; Owner: -
--

ALTER TABLE ONLY underwriting.loan_application
    ADD CONSTRAINT loan_application_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES identity.farmer(farmer_id);


--
-- Name: loan_application loan_application_lender_org_id_fkey; Type: FK CONSTRAINT; Schema: underwriting; Owner: -
--

ALTER TABLE ONLY underwriting.loan_application
    ADD CONSTRAINT loan_application_lender_org_id_fkey FOREIGN KEY (lender_org_id) REFERENCES identity.organization(org_id);


--
-- Name: loan_application loan_application_related_unit_id_fkey; Type: FK CONSTRAINT; Schema: underwriting; Owner: -
--

ALTER TABLE ONLY underwriting.loan_application
    ADD CONSTRAINT loan_application_related_unit_id_fkey FOREIGN KEY (related_unit_id) REFERENCES registry.production_unit(unit_id);


--
-- Name: loan_application loan_application_score_id_fkey; Type: FK CONSTRAINT; Schema: underwriting; Owner: -
--

ALTER TABLE ONLY underwriting.loan_application
    ADD CONSTRAINT loan_application_score_id_fkey FOREIGN KEY (score_id) REFERENCES risk.credit_score(score_id);


--
-- Name: contract; Type: ROW SECURITY; Schema: contract; Owner: -
--

ALTER TABLE contract.contract ENABLE ROW LEVEL SECURITY;

--
-- Name: contract party_own_contract; Type: POLICY; Schema: contract; Owner: -
--

CREATE POLICY party_own_contract ON contract.contract FOR SELECT USING (((current_setting('app.subject_type'::text, true) = 'platform'::text) OR (EXISTS ( SELECT 1
   FROM contract.contract_party cp
  WHERE ((cp.contract_id = contract.contract_id) AND (cp.party_type = current_setting('app.subject_type'::text, true)) AND (cp.party_id = (NULLIF(current_setting('app.subject_id'::text, true), ''::text))::uuid))))));


--
-- Name: POLICY party_own_contract ON contract; Type: COMMENT; Schema: contract; Owner: -
--

COMMENT ON POLICY party_own_contract ON contract.contract IS 'ใช้ EXISTS กับ contract.contract_party ของขั้นที่ 3 โดยตรง ไม่สร้างคอลัมน์ owner ซ้ำซ้อนในตาราง contract — Convention-based Reference เช่นเดียวกับหลักการที่ใช้มาตั้งแต่ขั้นที่ 2';


--
-- Name: credit_score; Type: ROW SECURITY; Schema: risk; Owner: -
--

ALTER TABLE risk.credit_score ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_score farmer_own_score; Type: POLICY; Schema: risk; Owner: -
--

CREATE POLICY farmer_own_score ON risk.credit_score FOR SELECT USING (((current_setting('app.subject_type'::text, true) = 'farmer'::text) AND (farmer_id = (NULLIF(current_setting('app.subject_id'::text, true), ''::text))::uuid)));


--
-- Name: credit_score platform_all_scores; Type: POLICY; Schema: risk; Owner: -
--

CREATE POLICY platform_all_scores ON risk.credit_score FOR SELECT USING ((current_setting('app.subject_type'::text, true) = 'platform'::text));


--
-- Name: loan_application farmer_own_applications; Type: POLICY; Schema: underwriting; Owner: -
--

CREATE POLICY farmer_own_applications ON underwriting.loan_application FOR SELECT USING (((current_setting('app.subject_type'::text, true) = 'farmer'::text) AND (farmer_id = (NULLIF(current_setting('app.subject_id'::text, true), ''::text))::uuid)));


--
-- Name: loan_application lender_own_applications; Type: POLICY; Schema: underwriting; Owner: -
--

CREATE POLICY lender_own_applications ON underwriting.loan_application FOR SELECT USING (((current_setting('app.subject_type'::text, true) = 'organization'::text) AND (lender_org_id = (NULLIF(current_setting('app.subject_id'::text, true), ''::text))::uuid)));


--
-- Name: loan_application; Type: ROW SECURITY; Schema: underwriting; Owner: -
--

ALTER TABLE underwriting.loan_application ENABLE ROW LEVEL SECURITY;

--
-- Name: loan_application platform_all_applications; Type: POLICY; Schema: underwriting; Owner: -
--

CREATE POLICY platform_all_applications ON underwriting.loan_application FOR SELECT USING ((current_setting('app.subject_type'::text, true) = 'platform'::text));


--
-- PostgreSQL database dump complete
--


