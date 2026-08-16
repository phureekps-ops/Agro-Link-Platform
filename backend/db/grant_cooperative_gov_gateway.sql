-- AgroLink -- Cooperative SaaS, M15 Government Integration Gateway.
--
-- Context: AgroLink_Cooperative_SaaS_Master_Blueprint_v1.0's Gap Analysis
-- lists M15 as "ไม่มี — ไม่มี connector/schema-mapping/retry/dead-letter
-- queue ใดๆ" (nothing exists — no connector, schema mapping, retry, or
-- dead-letter queue of any kind), rated "สูงเชิงกลยุทธ์ — เป็นจุดขายหลักต่อ
-- กรมฯ แต่ทำได้หลัง M01-M03 เสถียรก่อน" (strategically high priority — the
-- main selling point to the government departments, but only buildable
-- after M01-M03 are stable). The module description names the scope as
-- "Dashboard รัฐ, API catalog, GDX/TGIX adapter, consent, audit, security"
-- and the technical-architecture section names the concrete standard:
-- "แนวทาง GDX/TGIX ของ DGA (REST/JSON, HTTPS, auth, API account,
-- token/session, logging/monitoring) เป็นเหตุผลที่เอกสารต้นฉบับแนะนำให้
-- AgroLink สร้าง 'Government Integration Adapter' แยกออกมาต่างหาก แทนที่จะ
-- ผูกทุกโมดูลเข้ากับ endpoint ราชการโดยตรง" (build a separate adapter,
-- rather than wiring every module directly to a government endpoint).
--
-- Scope decision (resolves Open Decision #5 in the blueprint -- "ยังไม่ได้
-- เลือกว่าจะ implement เป็นส่วนหนึ่งของ backend เดิม ... หรือแยกเป็น
-- service ต่างหาก"): this migration implements the adapter as new
-- schema + Express routes INSIDE the existing backend, same as every
-- other module so far, NOT as a separate microservice. That keeps this
-- slice buildable today; splitting it into a standalone service (with
-- its own deploy lifecycle, and a real message broker -- see the
-- dead-letter note below) remains open future work once submission
-- volume or the government side's own infrastructure actually demands
-- it. Sign-off on this choice, and on Open Decision #4 (Provincial/
-- National tenant hierarchy) which this migration deliberately does
-- NOT touch, is still owed per the blueprint's own "ขั้นตอนถัดไป" list.
--
-- What this migration deliberately is, and is not:
--   - IS the internal data model + business rules for a cooperative to
--     manage consent, request/activate/rotate/revoke a government API
--     credential, and queue/attempt/acknowledge/retry/dead-letter a data
--     submission -- i.e. the "connector, schema mapping, retry/dead-
--     letter queue, credential lifecycle, audit log แยกฝั่ง government"
--     named in Sprint S10 of the blueprint's 12-sprint plan.
--   - Is NOT a real outbound HTTP client calling an actual GDX/TGIX
--     endpoint. No real field-level schema from either department is
--     available while writing this migration, so govgw.data_submission.
--     payload is deliberately an opaque jsonb blob (a human-authored
--     summary, not a mapped government form) -- fabricating a fake
--     field-by-field government schema would be worse than admitting
--     the real one isn't known yet. govgw.attempt_submission() records
--     the OUTCOME of an attempt (as reported by its caller); it does not
--     perform the network call itself. Building the real adapter is
--     explicit future work once an actual data-sharing agreement,
--     credentials, and spec exist with either department.
--   - Is NOT the Government Dashboard itself. That needs a Provincial/
--     National tenant hierarchy (registry.province / registry.department
--     or equivalent) to aggregate ACROSS cooperatives -- explicitly
--     unresolved as Open Decision #4 in the blueprint. This migration
--     stays inside the existing per-cooperative org_id boundary, same
--     as every other grant_cooperative_*.sql so far: a government-side
--     read surface across all cooperatives is real future work for
--     whichever module ends up owning that hierarchy (M01 first).
--   - Is NOT a real message queue. The blueprint's own tech-stack table
--     says "Event Bus ... ยังไม่มี — เพิ่มเมื่อมีความจำเป็นจริง (เช่น
--     เชื่อม Government Integration Gateway)" -- i.e. THIS module is the
--     trigger the blueprint itself names for eventually adding a real
--     broker (Kafka/Redpanda/PubSub), not something that already has
--     one. Retry/dead-letter here is a status-field simulation on
--     govgw.data_submission (attempt_count vs. max_attempts, flipping to
--     'DeadLettered'), queryable by polling govgw.v_dead_letter_queue --
--     good enough for a human ops workflow at pilot scale, not a
--     substitute for a real broker once volume grows.
--
-- Consent-before-credential-before-submission is enforced in the
-- functions below, not just in the UI: govgw.request_credential()
-- requires an Active consent already on file for that org/endpoint (or a
-- blanket consent), and govgw.create_submission() requires BOTH an
-- Active consent AND a usable credential before a submission can even be
-- queued. This mirrors the "auth, API account" step GDX/TGIX itself
-- requires, and gives this platform a PDPA-relevant paper trail: no
-- outbound government submission can exist without a recorded consent
-- decision behind it.
--
-- govgw.credential deliberately has NO secret/token/key column. Storing
-- real government API credentials belongs in a proper secrets manager
-- (Vault/KMS-class system), never in this application database in
-- plaintext -- this table only tracks the credential's LIFECYCLE
-- (Requested/Active/Expiring/Revoked/Expired, issued/expires/rotated
-- timestamps), which is exactly what the blueprint's "credential
-- lifecycle" phrase names and all a cooperative's own staff actually
-- need to see.
--
-- govgw.gov_audit_log is a SEPARATE, purpose-built append-only log from
-- the platform's existing audit.access_log (grant already present,
-- audit.log_access() already wired into every other module's routes via
-- src/db/pool.js's logAccess() helper, and used unchanged here too for
-- the generic technical access trail). audit.access_log's own schema is
-- deliberately coarse -- action is CHECK'd to only ('read','write') --
-- which cannot express "submission acknowledged by government with
-- reference X" or "credential rotated". That richer, government-
-- lifecycle-specific trail is exactly what the blueprint's "audit log
-- แยกฝั่ง government" (a government-side-SEPARATE audit log) phrase
-- calls for, so this migration adds it as a real second table rather
-- than trying to force it through access_log's narrower shape. Every
-- state-changing function below writes to both: audit.log_access() is
-- called from the Express route layer (same convention as M09-M13), and
-- govgw.gov_audit_log is written directly by the SQL function itself, so
-- it stays complete even if a future caller forgets the route-level
-- logAccess() call.
--
-- govgw.endpoint_catalog is migration-seeded reference data only -- SAME
-- pattern as registry.commodity_ref (see grant_cooperative_processing.
-- sql's header note on why finished-goods products aren't a commodity_
-- code FK): agrolink_app gets SELECT only, no INSERT/UPDATE. It is
-- seeded here with exactly two placeholder rows naming the two
-- departments the blueprint itself names (กรมส่งเสริมสหกรณ์ /
-- Department of Cooperative Promotion, and กรมตรวจบัญชีสหกรณ์ /
-- Cooperative Auditing Department) -- NOT a real API catalog with real
-- endpoint paths, since no real technical spec from either department is
-- available. Treat these two rows as category placeholders pending a
-- real integration agreement, not as documentation of an actual live
-- government API.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS govgw;
GRANT USAGE ON SCHEMA govgw TO agrolink_app;

-- ---------------------------------------------------------------------------
-- 1. govgw.endpoint_catalog -- platform-wide reference data (not org-
--    scoped), seeded below, SELECT-only for the app role. See header note.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS govgw.endpoint_catalog (
  endpoint_id     uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  endpoint_code   text NOT NULL UNIQUE,
  endpoint_name   text NOT NULL,
  agency_name     text NOT NULL,
  description     text,
  status          text NOT NULL DEFAULT 'Active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT endpoint_catalog_status_check CHECK (status IN ('Active', 'Deprecated'))
);

-- ---------------------------------------------------------------------------
-- 2. govgw.consent -- a cooperative's on-file decision to allow data
--    sharing with a government endpoint (or, with endpoint_id NULL, a
--    blanket consent covering all endpoints). Required before a
--    credential can be requested for that org/endpoint combination.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS govgw.consent (
  consent_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  org_id          uuid NOT NULL REFERENCES identity.organization(org_id),
  endpoint_id     uuid REFERENCES govgw.endpoint_catalog(endpoint_id),
  scope_note      text,
  status          text NOT NULL DEFAULT 'Active',
  granted_by      text NOT NULL,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  revoked_by      text,
  revoked_at      timestamptz,
  revoke_reason   text,
  CONSTRAINT consent_status_check CHECK (status IN ('Active', 'Revoked')),
  CONSTRAINT consent_revoked_shape CHECK (status <> 'Revoked' OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_consent_org ON govgw.consent (org_id);
CREATE INDEX IF NOT EXISTS idx_consent_endpoint ON govgw.consent (endpoint_id);

-- ---------------------------------------------------------------------------
-- 3. govgw.credential -- lifecycle metadata ONLY for a per-org, per-
--    endpoint government API account. No secret/token column -- see
--    header note.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS govgw.credential (
  credential_id     uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  org_id            uuid NOT NULL REFERENCES identity.organization(org_id),
  endpoint_id       uuid NOT NULL REFERENCES govgw.endpoint_catalog(endpoint_id),
  credential_label  text NOT NULL,
  status            text NOT NULL DEFAULT 'Requested',
  requested_by      text NOT NULL,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  activated_at      timestamptz,
  expires_at        timestamptz,
  last_rotated_at   timestamptz,
  revoked_by        text,
  revoked_at        timestamptz,
  revoke_reason     text,
  note              text,
  CONSTRAINT credential_status_check CHECK (status IN ('Requested', 'Active', 'Expiring', 'Revoked', 'Expired')),
  CONSTRAINT credential_revoked_shape CHECK (status <> 'Revoked' OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_credential_org ON govgw.credential (org_id);
CREATE INDEX IF NOT EXISTS idx_credential_endpoint ON govgw.credential (endpoint_id);

-- ---------------------------------------------------------------------------
-- 4. govgw.data_submission -- one queued/sent/acknowledged/dead-lettered
--    outbound submission. payload is an opaque jsonb summary -- see
--    header note on why there is no real field-level schema mapping yet.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS govgw.data_submission (
  submission_id     uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  org_id            uuid NOT NULL REFERENCES identity.organization(org_id),
  endpoint_id       uuid NOT NULL REFERENCES govgw.endpoint_catalog(endpoint_id),
  period_label      text NOT NULL,
  payload           jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'Queued',
  max_attempts      integer NOT NULL DEFAULT 3,
  attempt_count     integer NOT NULL DEFAULT 0,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_attempted_at timestamptz,
  acknowledged_at   timestamptz,
  ack_reference     text,
  last_error        text,
  cancelled_by      text,
  cancelled_at      timestamptz,
  cancel_reason     text,
  CONSTRAINT data_submission_status_check CHECK (status IN ('Queued', 'Sent', 'Acknowledged', 'DeadLettered', 'Cancelled')),
  CONSTRAINT data_submission_max_attempts_check CHECK (max_attempts > 0),
  CONSTRAINT data_submission_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT data_submission_cancelled_shape CHECK (status <> 'Cancelled' OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_data_submission_org ON govgw.data_submission (org_id);
CREATE INDEX IF NOT EXISTS idx_data_submission_endpoint ON govgw.data_submission (endpoint_id);
CREATE INDEX IF NOT EXISTS idx_data_submission_status ON govgw.data_submission (status);

-- ---------------------------------------------------------------------------
-- 5. govgw.submission_attempt -- append-only retry/attempt log. This,
--    together with data_submission.attempt_count/max_attempts/status, IS
--    the "retry / dead-letter queue" named in the blueprint -- see
--    header note on why it's a status-field simulation, not a real
--    broker.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS govgw.submission_attempt (
  attempt_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  submission_id   uuid NOT NULL REFERENCES govgw.data_submission(submission_id),
  attempt_number  integer NOT NULL,
  attempted_at    timestamptz NOT NULL DEFAULT now(),
  outcome         text NOT NULL,
  response_code   text,
  error_message   text,
  recorded_by     text NOT NULL,
  CONSTRAINT submission_attempt_outcome_check CHECK (outcome IN ('Success', 'Failure')),
  CONSTRAINT submission_attempt_unique_number UNIQUE (submission_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_submission_attempt_submission ON govgw.submission_attempt (submission_id);

-- ---------------------------------------------------------------------------
-- 6. govgw.gov_audit_log -- append-only, government-gateway-specific
--    audit trail. See header note on why this is separate from
--    audit.access_log rather than reusing it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS govgw.gov_audit_log (
  gov_audit_id    uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  org_id          uuid NOT NULL REFERENCES identity.organization(org_id),
  event_type      text NOT NULL,
  related_table   text NOT NULL,
  related_id      uuid NOT NULL,
  actor           text NOT NULL,
  detail          text,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gov_audit_log_event_type_check CHECK (event_type IN (
    'ConsentGranted', 'ConsentRevoked',
    'CredentialRequested', 'CredentialActivated', 'CredentialRotated', 'CredentialRevoked',
    'SubmissionCreated', 'SubmissionAttempted', 'SubmissionDeadLettered',
    'SubmissionAcknowledged', 'SubmissionCancelled', 'SubmissionRequeued'
  ))
);

CREATE INDEX IF NOT EXISTS idx_gov_audit_log_org ON govgw.gov_audit_log (org_id);
CREATE INDEX IF NOT EXISTS idx_gov_audit_log_related ON govgw.gov_audit_log (related_table, related_id);

GRANT SELECT ON govgw.endpoint_catalog TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON govgw.consent TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON govgw.credential TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON govgw.data_submission TO agrolink_app;
GRANT SELECT, INSERT ON govgw.submission_attempt TO agrolink_app;
GRANT SELECT, INSERT ON govgw.gov_audit_log TO agrolink_app;

-- Seed the placeholder endpoint catalog -- see header note. Reference
-- data only, never touched by the app role's grants above.
INSERT INTO govgw.endpoint_catalog (endpoint_code, endpoint_name, agency_name, description, status) VALUES
  ('CPD.COOP_DIGITAL_PROFILE',
   'รายงานข้อมูลโปรไฟล์สหกรณ์ดิจิทัลรายเดือน (Digital Cooperative Profile)',
   'กรมส่งเสริมสหกรณ์',
   'หมวดหมู่ทั่วไปสำหรับการส่งข้อมูลโปรไฟล์สหกรณ์/สมาชิก/ปริมาณผลผลิตให้กรมส่งเสริมสหกรณ์ ตามแนวทาง GDX ของ DGA — ยังไม่มี field-level schema จริงจากกรมฯ ณ เวลาที่เขียน migration นี้ เป็นเพียงหมวดหมู่ placeholder รอข้อตกลงเชื่อมต่อจริง (ดูหมายเหตุขอบเขตท้ายไฟล์)',
   'Active'),
  ('CAD.FINANCIAL_STATEMENT',
   'รายงานงบการเงินสหกรณ์ (Cooperative Financial Statement)',
   'กรมตรวจบัญชีสหกรณ์',
   'หมวดหมู่ทั่วไปสำหรับการส่งข้อมูลงบการเงิน/บัญชีของสหกรณ์ให้กรมตรวจบัญชีสหกรณ์ ตามแนวทาง TGIX — ยังไม่มี field-level schema จริงจากกรมฯ ณ เวลาที่เขียน migration นี้ เป็นเพียงหมวดหมู่ placeholder รอข้อตกลงเชื่อมต่อจริง (ดูหมายเหตุขอบเขตท้ายไฟล์)',
   'Active');

-- ---------------------------------------------------------------------------
-- 7. Views -- run with the OWNER's (postgres') privileges, same pattern
--    as every other view in this platform -- only SELECT on the view
--    itself is needed.
-- ---------------------------------------------------------------------------

CREATE VIEW govgw.v_consent_status AS
  SELECT
    c.consent_id, c.org_id, c.endpoint_id,
    COALESCE(e.endpoint_name, 'ทุกช่องทาง (Blanket)') AS endpoint_name,
    e.agency_name,
    c.scope_note, c.status, c.granted_by, c.granted_at, c.revoked_by, c.revoked_at, c.revoke_reason
  FROM govgw.consent c
  LEFT JOIN govgw.endpoint_catalog e ON e.endpoint_id = c.endpoint_id;

CREATE VIEW govgw.v_credential_status AS
  SELECT
    cr.credential_id, cr.org_id, cr.endpoint_id, e.endpoint_name, e.agency_name,
    cr.credential_label, cr.status, cr.requested_by, cr.requested_at, cr.activated_at,
    cr.expires_at, cr.last_rotated_at, cr.revoked_by, cr.revoked_at, cr.revoke_reason, cr.note,
    (cr.status = 'Active' AND cr.expires_at IS NOT NULL AND cr.expires_at <= now() + interval '30 days') AS is_expiring_soon
  FROM govgw.credential cr
  JOIN govgw.endpoint_catalog e ON e.endpoint_id = cr.endpoint_id;

CREATE VIEW govgw.v_submission_summary AS
  SELECT
    s.submission_id, s.org_id, s.endpoint_id, e.endpoint_name, e.agency_name,
    s.period_label, s.payload, s.status, s.max_attempts, s.attempt_count,
    s.created_by, s.created_at, s.last_attempted_at, s.acknowledged_at, s.ack_reference,
    s.last_error, s.cancelled_by, s.cancelled_at, s.cancel_reason,
    la.outcome AS last_attempt_outcome, la.response_code AS last_attempt_response_code,
    la.attempted_at AS last_attempt_at
  FROM govgw.data_submission s
  JOIN govgw.endpoint_catalog e ON e.endpoint_id = s.endpoint_id
  LEFT JOIN LATERAL (
    SELECT outcome, response_code, attempted_at
    FROM govgw.submission_attempt sa
    WHERE sa.submission_id = s.submission_id
    ORDER BY sa.attempt_number DESC
    LIMIT 1
  ) la ON true;

CREATE VIEW govgw.v_dead_letter_queue AS
  SELECT * FROM govgw.v_submission_summary WHERE status = 'DeadLettered';

GRANT SELECT ON govgw.v_consent_status TO agrolink_app;
GRANT SELECT ON govgw.v_credential_status TO agrolink_app;
GRANT SELECT ON govgw.v_submission_summary TO agrolink_app;
GRANT SELECT ON govgw.v_dead_letter_queue TO agrolink_app;

-- ---------------------------------------------------------------------------
-- 8. Functions. Same "route does the ownership check, function does the
--    business rule" split as every other module's functions -- the
--    route MUST verify the consent/credential/submission belongs to the
--    calling cooperative before calling any of these; these functions
--    trust their caller on ownership. Every state-changing function
--    below also writes its own govgw.gov_audit_log row -- see header
--    note on why that's separate from the route-level audit.log_access()
--    call.
-- ---------------------------------------------------------------------------

CREATE FUNCTION govgw.grant_consent(
  p_org_id uuid, p_endpoint_id uuid, p_scope_note text, p_granted_by text
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_consent_id uuid;
BEGIN
    IF p_endpoint_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM govgw.endpoint_catalog WHERE endpoint_id = p_endpoint_id) THEN
        RAISE EXCEPTION 'ไม่พบช่องทางราชการ %', p_endpoint_id;
    END IF;

    INSERT INTO govgw.consent (org_id, endpoint_id, scope_note, granted_by)
    VALUES (p_org_id, p_endpoint_id, p_scope_note, p_granted_by)
    RETURNING consent_id INTO v_consent_id;

    INSERT INTO govgw.gov_audit_log (org_id, event_type, related_table, related_id, actor, detail)
    VALUES (p_org_id, 'ConsentGranted', 'govgw.consent', v_consent_id, p_granted_by, p_scope_note);

    RETURN v_consent_id;
END;
$$;

CREATE FUNCTION govgw.revoke_consent(
  p_consent_id uuid, p_revoked_by text, p_reason text
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_org_id uuid;
    v_status TEXT;
BEGIN
    SELECT org_id, status INTO v_org_id, v_status FROM govgw.consent WHERE consent_id = p_consent_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบความยินยอม %', p_consent_id;
    END IF;
    IF v_status <> 'Active' THEN
        RAISE EXCEPTION 'ความยินยอม % ไม่ได้อยู่ในสถานะใช้งานแล้ว (สถานะปัจจุบัน %)', p_consent_id, v_status;
    END IF;

    UPDATE govgw.consent
    SET status = 'Revoked', revoked_by = p_revoked_by, revoked_at = now(), revoke_reason = p_reason
    WHERE consent_id = p_consent_id;

    INSERT INTO govgw.gov_audit_log (org_id, event_type, related_table, related_id, actor, detail)
    VALUES (v_org_id, 'ConsentRevoked', 'govgw.consent', p_consent_id, p_revoked_by, p_reason);
END;
$$;

CREATE FUNCTION govgw.request_credential(
  p_org_id uuid, p_endpoint_id uuid, p_credential_label text, p_requested_by text
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_endpoint_status TEXT;
    v_credential_id uuid;
BEGIN
    SELECT status INTO v_endpoint_status FROM govgw.endpoint_catalog WHERE endpoint_id = p_endpoint_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบช่องทางราชการ %', p_endpoint_id;
    END IF;
    IF v_endpoint_status <> 'Active' THEN
        RAISE EXCEPTION 'ช่องทางราชการ % ไม่ได้เปิดใช้งาน (สถานะปัจจุบัน %)', p_endpoint_id, v_endpoint_status;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM govgw.consent
      WHERE org_id = p_org_id AND status = 'Active' AND (endpoint_id = p_endpoint_id OR endpoint_id IS NULL)
    ) THEN
        RAISE EXCEPTION 'ต้องมีความยินยอม (consent) ที่ยังใช้งานอยู่สำหรับช่องทางนี้ก่อนขอบัญชี API';
    END IF;

    INSERT INTO govgw.credential (org_id, endpoint_id, credential_label, requested_by)
    VALUES (p_org_id, p_endpoint_id, p_credential_label, p_requested_by)
    RETURNING credential_id INTO v_credential_id;

    INSERT INTO govgw.gov_audit_log (org_id, event_type, related_table, related_id, actor, detail)
    VALUES (p_org_id, 'CredentialRequested', 'govgw.credential', v_credential_id, p_requested_by, p_credential_label);

    RETURN v_credential_id;
END;
$$;

CREATE FUNCTION govgw.activate_credential(
  p_credential_id uuid, p_activated_by text, p_expires_at timestamptz
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_org_id uuid;
    v_status TEXT;
BEGIN
    SELECT org_id, status INTO v_org_id, v_status FROM govgw.credential WHERE credential_id = p_credential_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบบัญชี API %', p_credential_id;
    END IF;
    IF v_status <> 'Requested' THEN
        RAISE EXCEPTION 'เปิดใช้งานได้เฉพาะบัญชี API ที่อยู่ในสถานะรอดำเนินการเท่านั้น (สถานะปัจจุบัน %)', v_status;
    END IF;

    UPDATE govgw.credential
    SET status = 'Active', activated_at = now(), last_rotated_at = now(), expires_at = p_expires_at
    WHERE credential_id = p_credential_id;

    INSERT INTO govgw.gov_audit_log (org_id, event_type, related_table, related_id, actor, detail)
    VALUES (v_org_id, 'CredentialActivated', 'govgw.credential', p_credential_id, p_activated_by, NULL);
END;
$$;

CREATE FUNCTION govgw.rotate_credential(
  p_credential_id uuid, p_rotated_by text, p_new_expires_at timestamptz
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_org_id uuid;
    v_status TEXT;
BEGIN
    SELECT org_id, status INTO v_org_id, v_status FROM govgw.credential WHERE credential_id = p_credential_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบบัญชี API %', p_credential_id;
    END IF;
    IF v_status NOT IN ('Active', 'Expiring') THEN
        RAISE EXCEPTION 'หมุนเวียนได้เฉพาะบัญชี API ที่ใช้งานอยู่เท่านั้น (สถานะปัจจุบัน %)', v_status;
    END IF;

    UPDATE govgw.credential
    SET status = 'Active', last_rotated_at = now(), expires_at = p_new_expires_at
    WHERE credential_id = p_credential_id;

    INSERT INTO govgw.gov_audit_log (org_id, event_type, related_table, related_id, actor, detail)
    VALUES (v_org_id, 'CredentialRotated', 'govgw.credential', p_credential_id, p_rotated_by, NULL);
END;
$$;

CREATE FUNCTION govgw.revoke_credential(
  p_credential_id uuid, p_revoked_by text, p_reason text
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_org_id uuid;
    v_status TEXT;
BEGIN
    SELECT org_id, status INTO v_org_id, v_status FROM govgw.credential WHERE credential_id = p_credential_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบบัญชี API %', p_credential_id;
    END IF;
    IF v_status NOT IN ('Requested', 'Active', 'Expiring') THEN
        RAISE EXCEPTION 'บัญชี API % ไม่ได้อยู่ในสถานะที่ยกเลิกได้ (สถานะปัจจุบัน %)', p_credential_id, v_status;
    END IF;

    UPDATE govgw.credential
    SET status = 'Revoked', revoked_by = p_revoked_by, revoked_at = now(), revoke_reason = p_reason
    WHERE credential_id = p_credential_id;

    INSERT INTO govgw.gov_audit_log (org_id, event_type, related_table, related_id, actor, detail)
    VALUES (v_org_id, 'CredentialRevoked', 'govgw.credential', p_credential_id, p_revoked_by, p_reason);
END;
$$;

CREATE FUNCTION govgw.create_submission(
  p_org_id uuid, p_endpoint_id uuid, p_period_label text, p_payload jsonb, p_created_by text,
  p_max_attempts integer DEFAULT 3
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_endpoint_status TEXT;
    v_submission_id uuid;
BEGIN
    SELECT status INTO v_endpoint_status FROM govgw.endpoint_catalog WHERE endpoint_id = p_endpoint_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบช่องทางราชการ %', p_endpoint_id;
    END IF;
    IF v_endpoint_status <> 'Active' THEN
        RAISE EXCEPTION 'ช่องทางราชการ % ไม่ได้เปิดใช้งาน (สถานะปัจจุบัน %)', p_endpoint_id, v_endpoint_status;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM govgw.consent
      WHERE org_id = p_org_id AND status = 'Active' AND (endpoint_id = p_endpoint_id OR endpoint_id IS NULL)
    ) THEN
        RAISE EXCEPTION 'ต้องมีความยินยอม (consent) ที่ยังใช้งานอยู่สำหรับช่องทางนี้ก่อนส่งข้อมูล';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM govgw.credential
      WHERE org_id = p_org_id AND endpoint_id = p_endpoint_id AND status IN ('Active', 'Expiring')
    ) THEN
        RAISE EXCEPTION 'ต้องมีบัญชี API ที่ใช้งานได้สำหรับช่องทางนี้ก่อนส่งข้อมูล';
    END IF;

    INSERT INTO govgw.data_submission (org_id, endpoint_id, period_label, payload, created_by, max_attempts)
    VALUES (p_org_id, p_endpoint_id, p_period_label, p_payload, p_created_by, p_max_attempts)
    RETURNING submission_id INTO v_submission_id;

    INSERT INTO govgw.gov_audit_log (org_id, event_type, related_table, related_id, actor, detail)
    VALUES (p_org_id, 'SubmissionCreated', 'govgw.data_submission', v_submission_id, p_created_by, p_period_label);

    RETURN v_submission_id;
END;
$$;

CREATE FUNCTION govgw.attempt_submission(
  p_submission_id uuid, p_outcome text, p_response_code text, p_error_message text, p_recorded_by text
) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_org_id uuid;
    v_status TEXT;
    v_attempt_count INTEGER;
    v_max_attempts INTEGER;
    v_next_attempt INTEGER;
    v_new_status TEXT;
BEGIN
    SELECT org_id, status, attempt_count, max_attempts
      INTO v_org_id, v_status, v_attempt_count, v_max_attempts
      FROM govgw.data_submission WHERE submission_id = p_submission_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบรายการส่งข้อมูล %', p_submission_id;
    END IF;
    IF v_status <> 'Queued' THEN
        RAISE EXCEPTION 'ลองส่งได้เฉพาะรายการที่อยู่ในคิวเท่านั้น (สถานะปัจจุบัน %)', v_status;
    END IF;
    IF p_outcome NOT IN ('Success', 'Failure') THEN
        RAISE EXCEPTION 'outcome ไม่ถูกต้อง: %', p_outcome;
    END IF;

    v_next_attempt := v_attempt_count + 1;

    INSERT INTO govgw.submission_attempt (submission_id, attempt_number, outcome, response_code, error_message, recorded_by)
    VALUES (p_submission_id, v_next_attempt, p_outcome, p_response_code, p_error_message, p_recorded_by);

    IF p_outcome = 'Success' THEN
        v_new_status := 'Sent';
        UPDATE govgw.data_submission
        SET status = v_new_status, attempt_count = v_next_attempt, last_attempted_at = now(), last_error = NULL
        WHERE submission_id = p_submission_id;
    ELSIF v_next_attempt >= v_max_attempts THEN
        v_new_status := 'DeadLettered';
        UPDATE govgw.data_submission
        SET status = v_new_status, attempt_count = v_next_attempt, last_attempted_at = now(), last_error = p_error_message
        WHERE submission_id = p_submission_id;
        INSERT INTO govgw.gov_audit_log (org_id, event_type, related_table, related_id, actor, detail)
        VALUES (v_org_id, 'SubmissionDeadLettered', 'govgw.data_submission', p_submission_id, p_recorded_by, p_error_message);
    ELSE
        v_new_status := 'Queued';
        UPDATE govgw.data_submission
        SET attempt_count = v_next_attempt, last_attempted_at = now(), last_error = p_error_message
        WHERE submission_id = p_submission_id;
    END IF;

    INSERT INTO govgw.gov_audit_log (org_id, event_type, related_table, related_id, actor, detail)
    VALUES (v_org_id, 'SubmissionAttempted', 'govgw.data_submission', p_submission_id, p_recorded_by,
      format('attempt %s/%s: %s', v_next_attempt, v_max_attempts, p_outcome));

    RETURN v_new_status;
END;
$$;

CREATE FUNCTION govgw.record_acknowledgement(
  p_submission_id uuid, p_ack_reference text, p_recorded_by text
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_org_id uuid;
    v_status TEXT;
BEGIN
    SELECT org_id, status INTO v_org_id, v_status FROM govgw.data_submission WHERE submission_id = p_submission_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบรายการส่งข้อมูล %', p_submission_id;
    END IF;
    IF v_status <> 'Sent' THEN
        RAISE EXCEPTION 'บันทึกการตอบรับได้เฉพาะรายการที่ส่งไปแล้วเท่านั้น (สถานะปัจจุบัน %)', v_status;
    END IF;

    UPDATE govgw.data_submission
    SET status = 'Acknowledged', acknowledged_at = now(), ack_reference = p_ack_reference
    WHERE submission_id = p_submission_id;

    INSERT INTO govgw.gov_audit_log (org_id, event_type, related_table, related_id, actor, detail)
    VALUES (v_org_id, 'SubmissionAcknowledged', 'govgw.data_submission', p_submission_id, p_recorded_by, p_ack_reference);
END;
$$;

CREATE FUNCTION govgw.cancel_submission(
  p_submission_id uuid, p_cancelled_by text, p_reason text
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_org_id uuid;
    v_status TEXT;
BEGIN
    SELECT org_id, status INTO v_org_id, v_status FROM govgw.data_submission WHERE submission_id = p_submission_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบรายการส่งข้อมูล %', p_submission_id;
    END IF;
    IF v_status <> 'Queued' THEN
        RAISE EXCEPTION 'ยกเลิกได้เฉพาะรายการที่ยังไม่เคยส่งสำเร็จเท่านั้น (สถานะปัจจุบัน %)', v_status;
    END IF;

    UPDATE govgw.data_submission
    SET status = 'Cancelled', cancelled_by = p_cancelled_by, cancelled_at = now(), cancel_reason = p_reason
    WHERE submission_id = p_submission_id;

    INSERT INTO govgw.gov_audit_log (org_id, event_type, related_table, related_id, actor, detail)
    VALUES (v_org_id, 'SubmissionCancelled', 'govgw.data_submission', p_submission_id, p_cancelled_by, p_reason);
END;
$$;

CREATE FUNCTION govgw.retry_dead_letter(
  p_submission_id uuid, p_additional_attempts integer, p_recorded_by text
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_org_id uuid;
    v_status TEXT;
BEGIN
    IF p_additional_attempts IS NULL OR p_additional_attempts <= 0 THEN
        RAISE EXCEPTION 'จำนวนครั้งที่เพิ่มต้องมากกว่า 0';
    END IF;

    SELECT org_id, status INTO v_org_id, v_status FROM govgw.data_submission WHERE submission_id = p_submission_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบรายการส่งข้อมูล %', p_submission_id;
    END IF;
    IF v_status <> 'DeadLettered' THEN
        RAISE EXCEPTION 'นำกลับเข้าคิวได้เฉพาะรายการที่อยู่ใน Dead-letter เท่านั้น (สถานะปัจจุบัน %)', v_status;
    END IF;

    UPDATE govgw.data_submission
    SET status = 'Queued', max_attempts = max_attempts + p_additional_attempts
    WHERE submission_id = p_submission_id;

    INSERT INTO govgw.gov_audit_log (org_id, event_type, related_table, related_id, actor, detail)
    VALUES (v_org_id, 'SubmissionRequeued', 'govgw.data_submission', p_submission_id, p_recorded_by,
      format('เพิ่มโควตาอีก %s ครั้ง', p_additional_attempts));
END;
$$;

-- ============================================================================
-- Follow-up work this migration deliberately leaves open:
--   - No real outbound HTTP connector to an actual GDX/TGIX endpoint --
--     govgw.attempt_submission() records the OUTCOME its caller reports;
--     it does not itself call any government system. Building the real
--     adapter (with a real API Gateway per the blueprint's own tech-
--     stack note, and real field-level schema mapping) is future work
--     once an actual data-sharing agreement and spec exist.
--   - No real secret/token storage anywhere -- govgw.credential is
--     lifecycle metadata only. A real integration needs a proper
--     secrets manager (Vault/KMS-class), not a database column.
--   - Retry/dead-letter is a status-field simulation, not a real
--     message broker -- see header note quoting the blueprint's own
--     tech-stack table on Event Bus being deferred until this module
--     becomes real.
--   - No Provincial/National tenant hierarchy or cross-cooperative
--     Government Dashboard -- Open Decision #4 in the blueprint is
--     still unresolved; this migration stays inside the existing
--     per-org_id boundary like every other cooperative module.
--   - endpoint_catalog has exactly two placeholder rows naming the two
--     departments the blueprint names -- not a real API catalog. Adding
--     real endpoint codes requires an actual agreement with each
--     department, not a guess.
--   - Outbound direction only -- nothing here models government-to-
--     platform data (e.g. policy or price updates pushed down). Not
--     named in the blueprint's M15 scope for this MVP.
--   - No automatic linkage from a submission's payload to real live data
--     in other modules (e.g. auto-composing govgw.data_submission.
--     payload from produce.delivery/ledger aggregates) -- payload is
--     supplied by the caller as a jsonb blob; wiring an auto-populate
--     helper once the real government field spec is known is future
--     work, same reasoning as the "no fabricated schema" note above.
-- ============================================================================
