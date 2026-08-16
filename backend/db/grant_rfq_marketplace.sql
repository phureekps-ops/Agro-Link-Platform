-- AgroLink Platform — RFP/RFQ (Request for Proposal / Request for Quote)
-- marketplace: a "post what you need, let sellers compete on price" flow,
-- open to every member type in the system (both farmer and organization
-- subjects) rather than scoped to one portal — explicit user request
-- ("สำหรับให้สมาชิกในระบบ Agrolink ใช้งาน... และให้อยู่ใน SaaS ของสหกรณ์ด้วย" —
-- "for AgroLink members to use... and have it be in the cooperative's SaaS
-- too"). This is deliberately a NEW, separate mechanism from the direct
-- catalogs (marketplace.product_listing/service_listing) built earlier —
-- those are "browse a fixed price and buy now"; this is "broadcast a need
-- and receive competing quotes," a genuinely different transaction shape
-- (reverse marketplace / competitive bidding) that a fixed-price catalog
-- cannot express.
--
-- Design decisions (documented up front so scope is honest):
--   1. A REQUESTER can be either a farmer or an organization (polymorphic
--      subject_type/subject_id pair, same convention as identity.
--      subject_role / storage.file_object's owner columns elsewhere in
--      this schema) — any member can post a need.
--   2. A RESPONDER (someone submitting a quote) is always an
--      ORGANIZATION — farmers are never quote responders in this pass.
--      Real-world AgroLink sellers (cooperatives, input suppliers,
--      machinery/logistics providers, mills) are all organizations; a
--      farmer-to-farmer quoting flow was judged out of scope for this
--      round and can be added later by widening rfq_quote the same way
--      rfq itself is polymorphic, if ever needed.
--   3. `category` is intentionally broad/shared across every portal
--      rather than one enum per org type — 'input_product' (fertilizer/
--      pesticide/equipment), 'produce' (raw/unprocessed), 'processed_good'
--      (milled/packaged), 'machinery_service' (tractor/drone/harvester/
--      truck/drying), 'other'. This lets ANY member browse RFQs by
--      category regardless of which portal posted or will respond to it —
--      the whole point of a shared cross-portal marketplace.
--   4. Accepting a quote (`awarded_quote_id`) only records INTENT — it
--      does NOT auto-create a produce.delivery / marketplace.product_order
--      / contract.contract row. Wiring an awarded RFQ into the actual
--      fulfillment record for its category is a follow-up integration,
--      not built in this pass (see backend/README.md's RFQ section for
--      the explicit "what's mocked" note) — same "manual today, real
--      integration later" honesty pattern used throughout this project
--      (e.g. satellite.observation's source_provider, ledger settlement).

CREATE SCHEMA IF NOT EXISTS procurement;

CREATE TABLE IF NOT EXISTS procurement.rfq (
  rfq_id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  requester_subject_type  text NOT NULL,
  requester_subject_id    uuid NOT NULL,
  title                   text NOT NULL,
  category                text NOT NULL,
  description             text,
  quantity                numeric(14,2),
  quantity_unit           text,
  target_price            numeric(18,2),
  delivery_location       text,
  needed_by_date          date,
  quotes_deadline         timestamptz,
  status                  text NOT NULL DEFAULT 'open',
  awarded_quote_id        uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfq_requester_subject_type_check
    CHECK (requester_subject_type IN ('farmer', 'organization')),
  CONSTRAINT rfq_category_check
    CHECK (category IN ('input_product', 'produce', 'processed_good', 'machinery_service', 'other')),
  CONSTRAINT rfq_status_check
    CHECK (status IN ('open', 'awarded', 'cancelled', 'closed')),
  CONSTRAINT rfq_title_check CHECK (length(trim(title)) > 0),
  CONSTRAINT rfq_quantity_check CHECK (quantity IS NULL OR quantity > 0),
  CONSTRAINT rfq_target_price_check CHECK (target_price IS NULL OR target_price > 0)
);

-- No FK from awarded_quote_id to rfq_quote here (added below, after
-- rfq_quote exists) — kept as a separate ALTER so the two tables can be
-- created in either order without a forward-reference problem.

CREATE INDEX IF NOT EXISTS idx_rfq_requester ON procurement.rfq (requester_subject_type, requester_subject_id);
CREATE INDEX IF NOT EXISTS idx_rfq_status_category ON procurement.rfq (status, category);

CREATE TABLE IF NOT EXISTS procurement.rfq_quote (
  quote_id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  rfq_id            uuid NOT NULL REFERENCES procurement.rfq(rfq_id) ON DELETE CASCADE,
  responder_org_id  uuid NOT NULL REFERENCES identity.organization(org_id) ON DELETE CASCADE,
  quoted_price      numeric(18,2) NOT NULL,
  price_unit        text NOT NULL DEFAULT 'บาท/หน่วย',
  quoted_quantity   numeric(14,2),
  message           text,
  status            text NOT NULL DEFAULT 'submitted',
  submitted_at      timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfq_quote_status_check
    CHECK (status IN ('submitted', 'withdrawn', 'accepted', 'rejected')),
  CONSTRAINT rfq_quote_price_check CHECK (quoted_price > 0),
  CONSTRAINT rfq_quote_quantity_check CHECK (quoted_quantity IS NULL OR quoted_quantity > 0),
  -- One row per (rfq, responder org) — a responder updates their existing
  -- quote via upsert (ON CONFLICT) rather than submitting duplicates. This
  -- is also what makes "withdraw then re-quote" work cleanly: the same
  -- row flips status back to 'submitted' instead of a new row appearing.
  CONSTRAINT uq_rfq_quote_rfq_responder UNIQUE (rfq_id, responder_org_id)
);

CREATE INDEX IF NOT EXISTS idx_rfq_quote_rfq ON procurement.rfq_quote (rfq_id, status);
CREATE INDEX IF NOT EXISTS idx_rfq_quote_responder ON procurement.rfq_quote (responder_org_id, status);

ALTER TABLE procurement.rfq
  ADD CONSTRAINT rfq_awarded_quote_id_fkey
  FOREIGN KEY (awarded_quote_id) REFERENCES procurement.rfq_quote(quote_id);

-- Same "no row-level security, explicit WHERE clause IS the security
-- boundary" situation as every marketplace.* table in this schema (see
-- the note at the top of src/routes/machinery.js) — procurement.* follows
-- the identical convention. Every query in src/routes/procurement.js must
-- filter explicitly by requester_subject_id / responder_org_id as
-- appropriate; there is no RLS backstop.
GRANT USAGE ON SCHEMA procurement TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON procurement.rfq TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON procurement.rfq_quote TO agrolink_app;

-- ============================================================
-- Verification notes (run manually, not part of this script):
--   \d procurement.rfq
--   \d procurement.rfq_quote
-- ============================================================
