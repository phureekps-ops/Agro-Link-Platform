-- AgroLink Platform — Multi-Role Organizations
--
-- Real institutions like ธกส. (BAAC) or an agricultural cooperative are not
-- just a Lender, or just a Buyer, or just an input supplier — they commonly
-- do several of these at once (lend money, sell fertilizer/pesticide/farm
-- tools, buy produce, run a drying yard). Until this migration,
-- identity.organization.org_type was a single value and every portal's
-- gate (requireLenderOrg/requireBuyerOrg/requireMachineryOrg) checked it
-- with strict equality — an organization could only ever be ONE of these,
-- full stop.
--
-- Design (per explicit product decisions made with the user):
--   1. At first registration, an organization still picks ONE role (no
--      change to POST /auth/org-register's shape) — org_type stays as the
--      organization's "primary" role, kept exactly as before for backward
--      compatibility with every existing read of it.
--   2. An already-Verified organization can request ADDITIONAL roles later
--      through a new self-service endpoint (POST /organization/roles).
--   3. EVERY new role — including the very first one, submitted at
--      registration — requires a separate Platform Ops approval before it
--      can be used. identity.organization.kyb_status stays the ENTITY-level
--      check ("is this a real, legitimate registered business at all",
--      decided once) while the new identity.organization_role.status is
--      the ROLE-level check ("is this specific business capability
--      authorized", decided per role, every time one is added). A brand
--      new organization's primary role is approved together with its KYB
--      in the same existing admin action — see the sync logic added to
--      POST /admin/organizations/:id/kyb-status in src/routes/admin.js —
--      so the common case (a new org's first and only role) needs no extra
--      click from Platform Ops beyond what already existed. A SECOND (or
--      third...) role requested later goes through the new
--      POST /admin/organizations/:id/roles/:role_type/status endpoint
--      instead, as its own separate approval.

CREATE TABLE IF NOT EXISTS identity.organization_role (
  org_id         uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  role_type      text NOT NULL,
  status         text NOT NULL DEFAULT 'Pending',
  requested_at   timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  decided_reason text,
  PRIMARY KEY (org_id, role_type)
);

-- Same role_type domain as identity.organization.org_type — additive
-- widening pattern, drop/re-add rather than a destructive rewrite.
ALTER TABLE identity.organization_role DROP CONSTRAINT IF EXISTS organization_role_role_type_check;
ALTER TABLE identity.organization_role ADD CONSTRAINT organization_role_role_type_check
  CHECK (role_type = ANY (ARRAY[
    'Cooperative', 'Mill', 'Bank', 'InputSupplier', 'Lender', 'Logistics', 'Buyer', 'VillageFund',
    'TractorService', 'DroneService', 'HarvesterService', 'TruckService', 'DryingYardService'
  ]));
ALTER TABLE identity.organization_role DROP CONSTRAINT IF EXISTS organization_role_status_check;
ALTER TABLE identity.organization_role ADD CONSTRAINT organization_role_status_check
  CHECK (status IN ('Pending', 'Verified', 'Rejected'));

CREATE INDEX IF NOT EXISTS idx_organization_role_status ON identity.organization_role(status);

GRANT SELECT, INSERT, UPDATE ON identity.organization_role TO agrolink_app;

-- Backfill: give every EXISTING organization a role row mirroring its
-- current org_type/kyb_status, so nothing that already works (every seeded
-- Lender/Buyer login, every already-approved org) breaks the moment the
-- portal middleware below switches from reading org_type/kyb_status
-- directly to reading this table. Idempotent (ON CONFLICT DO NOTHING) —
-- safe to re-run this migration.
INSERT INTO identity.organization_role (org_id, role_type, status, requested_at, decided_at)
SELECT org_id, org_type, kyb_status, created_at,
       CASE WHEN kyb_status <> 'Pending' THEN updated_at ELSE NULL END
  FROM identity.organization
ON CONFLICT (org_id, role_type) DO NOTHING;

-- ---------------------------------------------------------------------
-- partner.activate_vendor_role(org_id, role_type) — the role-aware
-- replacement for the activation logic. Same account-per-kind rule as the
-- original: Lender role -> lender_clearing account; every other role
-- (Buyer/InputSupplier/Mill/Cooperative/Logistics/the machinery & drying
-- roles) -> vendor_settlement account, shared across however many
-- non-Lender roles one org holds (partner.vendor_profile has exactly one
-- settlement_account_id slot, so a Buyer+InputSupplier+TractorService
-- organization settles all three through the same account — matches how
-- money actually moves for a real multi-role business). Checks the
-- ROLE's own status, not the organization's overall kyb_status, since a
-- Verified entity can still have a Pending/Rejected secondary role.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION partner.activate_vendor_role(p_org_id uuid, p_role_type text)
RETURNS uuid
LANGUAGE plpgsql
AS $function$
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
$function$;

-- partner.activate_vendor(org_id) is kept, unchanged in name/signature, so
-- every existing call site (POST /admin/organizations/:id/kyb-status, for
-- the primary-role approval path) keeps working with zero code changes —
-- it now simply delegates to the role-aware version above using the
-- organization's own org_type as the role being activated.
CREATE OR REPLACE FUNCTION partner.activate_vendor(p_org_id uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $function$
DECLARE
    v_org_type TEXT;
BEGIN
    SELECT org_type INTO v_org_type FROM identity.organization WHERE org_id = p_org_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบองค์กร org_id % ใน identity.organization', p_org_id;
    END IF;
    RETURN partner.activate_vendor_role(p_org_id, v_org_type);
END;
$function$;

-- ---------------------------------------------------------------------
-- Reminder for the next person reading this: identity.organization_role
-- has NO row-level security (verified via relrowsecurity — false, same
-- situation as every other table this project has added for a portal's
-- own use). src/routes/organization.js's and every requireXOrg()
-- middleware's explicit `WHERE org_id = $1` IS the entire security
-- boundary for this table, not defense-in-depth.
-- ---------------------------------------------------------------------
