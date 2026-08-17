-- AgroLink Platform — Farmer 360° View, MVP
-- See FARMER_360_ARCHITECTURE.md at the repo root for the full design
-- rationale and the Phase-2 roadmap (consent workflow + credit-score
-- sharing) deliberately NOT built in this pass.
--
-- Design summary:
--   1. There was NO persistent "farmer is a member/customer of org X"
--      roster anywhere in the schema before this file — `identity.
--      organization_member` is a staff/signatory table (eKYB + staff
--      logins), not a farmer roster; `registry.cooperative_profile.
--      member_count_reported` is explicitly self-reported, not a real
--      count. `identity.farmer_org_relationship` below is that roster,
--      new. Nothing in the existing schema blocks a farmer having
--      simultaneous relationships with many orgs of many types (verified
--      before writing this — no unique constraint anywhere ties a farmer
--      to a single org), so this is a pure addition, no conflict to
--      resolve.
--   2. `relationship_type` is NEVER taken from client input — it's
--      derived server-side from the org's own `org_type` inside
--      `identity.link_farmer_to_org()`, the same "don't trust the client
--      for anything derivable from data we already have" convention used
--      throughout this codebase (e.g. procurement.js computing invoice
--      amounts from GRN rather than accepting a client-supplied amount).
--   3. MVP explicitly does NOT touch `risk.credit_score`'s RLS, and does
--      NOT add any consent table — both are real product/policy
--      decisions the user deferred to Phase 2 (see architecture doc §5).
--      Nothing in this file grants any new visibility into credit
--      scoring.
--   4. `farmer_code` (the "AgroLink ID", e.g. AF-000001) is a new public-
--      facing identifier for `identity.farmer` — added because staff need
--      a way to look a farmer up that isn't their phone number or asking
--      them to recite a UUID. Backfilled deterministically by `created_at`
--      order (via ROW_NUMBER(), NOT by relying on bulk UPDATE row order,
--      which Postgres does not guarantee), then a sequence takes over for
--      new farmers via a BEFORE INSERT trigger.

-- ============================================================
-- 1. identity.farmer_org_relationship — the membership/customer roster
-- ============================================================
CREATE TABLE identity.farmer_org_relationship (
  relationship_id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  farmer_id                 uuid NOT NULL REFERENCES identity.farmer(farmer_id),
  org_id                     uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  relationship_type           text NOT NULL,
  status                       text NOT NULL DEFAULT 'active',
  joined_at                    timestamptz NOT NULL DEFAULT now(),
  ended_at                     timestamptz,
  created_by_subject_type       text NOT NULL,
  created_by_subject_id         uuid NOT NULL,
  notes                         text,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_farmer_org_relationship UNIQUE (farmer_id, org_id),
  CONSTRAINT farmer_org_relationship_type_check
    CHECK (relationship_type IN ('CooperativeMember', 'VillageFundMember', 'LoanCustomer', 'Other')),
  CONSTRAINT farmer_org_relationship_status_check CHECK (status IN ('active', 'ended')),
  CONSTRAINT farmer_org_relationship_creator_check
    CHECK (created_by_subject_type IN ('organization', 'platform')),
  CONSTRAINT farmer_org_relationship_ended_shape
    CHECK (status <> 'ended' OR ended_at IS NOT NULL)
);

CREATE INDEX idx_farmer_org_relationship_farmer ON identity.farmer_org_relationship (farmer_id, status);
CREATE INDEX idx_farmer_org_relationship_org ON identity.farmer_org_relationship (org_id, status);

-- No RLS here — same "explicit WHERE clause IS the security boundary"
-- convention as marketplace.*/procurement.* (see machinery.js's header
-- note for the canonical explanation). Every query in farmer360.js MUST
-- filter by org_id = the caller's own subjectId.

-- ============================================================
-- 2. identity.link_farmer_to_org() / unlink_farmer_from_org()
-- ============================================================
CREATE OR REPLACE FUNCTION identity.link_farmer_to_org(
  p_farmer_id uuid,
  p_org_id uuid,
  p_created_by_subject_type text,
  p_created_by_subject_id uuid,
  p_notes text DEFAULT NULL
) RETURNS identity.farmer_org_relationship
LANGUAGE plpgsql
AS $$
DECLARE
  v_org_type text;
  v_relationship_type text;
  v_row identity.farmer_org_relationship;
BEGIN
  SELECT org_type INTO v_org_type FROM identity.organization WHERE org_id = p_org_id;
  IF v_org_type IS NULL THEN
    RAISE EXCEPTION 'ไม่พบองค์กร %', p_org_id;
  END IF;

  v_relationship_type := CASE v_org_type
    WHEN 'Cooperative' THEN 'CooperativeMember'
    WHEN 'VillageFund' THEN 'VillageFundMember'
    WHEN 'Lender' THEN 'LoanCustomer'
    WHEN 'Bank' THEN 'LoanCustomer'
    ELSE 'Other'
  END;

  INSERT INTO identity.farmer_org_relationship (
    farmer_id, org_id, relationship_type, status, joined_at,
    created_by_subject_type, created_by_subject_id, notes
  ) VALUES (
    p_farmer_id, p_org_id, v_relationship_type, 'active', now(),
    p_created_by_subject_type, p_created_by_subject_id, p_notes
  )
  ON CONFLICT (farmer_id, org_id) DO UPDATE
    SET status = 'active', ended_at = NULL, joined_at = now(),
        notes = COALESCE(EXCLUDED.notes, identity.farmer_org_relationship.notes),
        updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION identity.unlink_farmer_from_org(
  p_farmer_id uuid,
  p_org_id uuid
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated int;
BEGIN
  UPDATE identity.farmer_org_relationship
     SET status = 'ended', ended_at = now(), updated_at = now()
   WHERE farmer_id = p_farmer_id AND org_id = p_org_id AND status = 'active';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- Bulk-creates relationships for every farmer who already has a real
-- transaction with this org (produce delivery, loan application, product
-- order, machinery booking) but no roster row yet — this is exactly the
-- "member import" gap `registry.cooperative_profile`'s own comment admits
-- doesn't exist ("ยังไม่มีการนำเข้าสมาชิกจริง"). Reuses the same org_type
-- -> relationship_type mapping as link_farmer_to_org() above so an org
-- calling this and an org calling link_farmer_to_org() one-by-one always
-- land on the same relationship_type. Returns the farmer_ids newly linked.
-- NOTE: the output column is named `linked_farmer_id`, NOT `farmer_id` —
-- RETURNS TABLE(farmer_id uuid) would implicitly declare a PL/pgSQL
-- variable named farmer_id that shadows identity.farmer_org_relationship's
-- own farmer_id column everywhere below (the exact "column reference is
-- ambiguous" bug hit and fixed in grant_b2b_commerce_engine_phase3.sql's
-- distribute_revenue_share() — same root cause, avoided here up front).
CREATE OR REPLACE FUNCTION identity.sync_farmer_relationships_from_transactions(
  p_org_id uuid,
  p_created_by_subject_type text,
  p_created_by_subject_id uuid
) RETURNS TABLE (linked_farmer_id uuid)
LANGUAGE plpgsql
AS $$
DECLARE
  v_org_type text;
  v_relationship_type text;
BEGIN
  SELECT org_type INTO v_org_type FROM identity.organization WHERE org_id = p_org_id;
  IF v_org_type IS NULL THEN
    RAISE EXCEPTION 'ไม่พบองค์กร %', p_org_id;
  END IF;

  v_relationship_type := CASE v_org_type
    WHEN 'Cooperative' THEN 'CooperativeMember'
    WHEN 'VillageFund' THEN 'VillageFundMember'
    WHEN 'Lender' THEN 'LoanCustomer'
    WHEN 'Bank' THEN 'LoanCustomer'
    ELSE 'Other'
  END;

  RETURN QUERY
  INSERT INTO identity.farmer_org_relationship (
    farmer_id, org_id, relationship_type, status, joined_at,
    created_by_subject_type, created_by_subject_id, notes
  )
  SELECT candidates.candidate_farmer_id, p_org_id, v_relationship_type, 'active', now(),
         p_created_by_subject_type, p_created_by_subject_id, 'sync-from-transactions'
    FROM (
      SELECT DISTINCT pu.owner_farmer_id AS candidate_farmer_id
        FROM produce.delivery d
        JOIN registry.production_unit pu ON pu.unit_id = d.unit_id
       WHERE d.buyer_org_id = p_org_id
      UNION
      SELECT DISTINCT la.farmer_id FROM underwriting.loan_application la WHERE la.lender_org_id = p_org_id
      UNION
      SELECT DISTINCT po.farmer_id FROM marketplace.product_order po
       WHERE po.org_id = p_org_id AND po.farmer_id IS NOT NULL
      UNION
      SELECT DISTINCT mb.farmer_id FROM marketplace.machinery_booking mb WHERE mb.org_id = p_org_id
    ) candidates
   WHERE NOT EXISTS (
     SELECT 1 FROM identity.farmer_org_relationship r
      WHERE r.farmer_id = candidates.candidate_farmer_id AND r.org_id = p_org_id AND r.status = 'active'
   )
  ON CONFLICT (farmer_id, org_id) DO UPDATE
    SET status = 'active', ended_at = NULL, updated_at = now()
  RETURNING farmer_org_relationship.farmer_id AS linked_farmer_id;
END;
$$;

-- ============================================================
-- 3. identity.farmer.farmer_code — public-facing "AgroLink ID"
-- ============================================================
ALTER TABLE identity.farmer ADD COLUMN IF NOT EXISTS farmer_code text;

CREATE SEQUENCE IF NOT EXISTS identity.farmer_code_seq;

-- Backfill existing farmers deterministically by created_at (NOT by bulk
-- UPDATE row order, which Postgres does not guarantee), then advance the
-- sequence past whatever was just assigned so new farmers continue the
-- numbering without collision.
DO $$
DECLARE
  v_max int;
BEGIN
  WITH numbered AS (
    SELECT farmer_id, ROW_NUMBER() OVER (ORDER BY created_at, farmer_id) AS rn
      FROM identity.farmer
     WHERE farmer_code IS NULL
  )
  UPDATE identity.farmer f
     SET farmer_code = 'AF-' || LPAD(numbered.rn::text, 6, '0')
    FROM numbered
   WHERE f.farmer_id = numbered.farmer_id;

  SELECT COALESCE(MAX(SUBSTRING(farmer_code FROM 4)::int), 0) INTO v_max FROM identity.farmer;
  PERFORM setval('identity.farmer_code_seq', v_max, true);
END $$;

ALTER TABLE identity.farmer ALTER COLUMN farmer_code SET NOT NULL;
ALTER TABLE identity.farmer ADD CONSTRAINT uq_farmer_code UNIQUE (farmer_code);

CREATE OR REPLACE FUNCTION identity.assign_farmer_code() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.farmer_code IS NULL THEN
    NEW.farmer_code := 'AF-' || LPAD(nextval('identity.farmer_code_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_assign_farmer_code
  BEFORE INSERT ON identity.farmer
  FOR EACH ROW EXECUTE FUNCTION identity.assign_farmer_code();

-- ============================================================
-- Grants — same convention as every other grant_*.sql (agrolink_app is
-- the least-privilege role every request assumes, see db/pool.js).
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON identity.farmer_org_relationship TO agrolink_app;
GRANT USAGE ON SEQUENCE identity.farmer_code_seq TO agrolink_app;
GRANT EXECUTE ON FUNCTION identity.link_farmer_to_org(uuid, uuid, text, uuid, text) TO agrolink_app;
GRANT EXECUTE ON FUNCTION identity.unlink_farmer_from_org(uuid, uuid) TO agrolink_app;
GRANT EXECUTE ON FUNCTION identity.sync_farmer_relationships_from_transactions(uuid, text, uuid) TO agrolink_app;
