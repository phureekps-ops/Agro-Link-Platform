-- AgroLink -- Cooperative SaaS, M04 Cooperative Finance (Dashboard slice).
--
-- Context: AgroLink_Cooperative_SaaS_Master_Blueprint_v1.0's Gap Analysis
-- marked M04 as "มีฐานบัญชีคู่อยู่แล้ว" (the double-entry ledger already
-- exists — ledger.account/journal_entry/journal_line, all built in an
-- earlier phase of this platform, confirmed unchanged by grepping
-- 02_full_schema.sql) but "ยังไม่มี KPI dashboard ระดับสหกรณ์" (no
-- per-cooperative KPI dashboard). This migration is exactly that: a
-- reporting layer on top of ledger/produce/warehouse data that already
-- exists, scoped to one cooperative's own org_id. No new transactional
-- tables, no new business logic that changes money movement — this is
-- read-only reporting.
--
-- Scope decision — receivables ("ลูกหนี้") deliberately NOT included:
-- the Master Blueprint's M04 definition lists "ลูกหนี้/เจ้าหนี้" (both
-- receivables AND payables), but this platform has no concept yet of a
-- cooperative invoicing a downstream buyer for produce it sells onward
-- (that would live in M12 Buyer Marketplace, wired to a cooperative
-- rather than a private Buyer org — not built). Fabricating a receivables
-- number with no underlying data would violate this project's own
-- standing rule against inventing figures with no evidence (see the
-- Master Blueprint's own "Watchlist 30" note). What IS concretely
-- derivable from data that already exists is payables to members
-- (produce.delivery rows accepted but not yet settled — money the
-- cooperative owes its own farmers) and cash position (the cooperative's
-- ledger.account balance) — this migration reports those, and the
-- dashboard route/frontend say so explicitly rather than showing a
-- receivables figure that would just be zero/fake.
--
-- Why a SQL function (reporting.coop_finance_summary(p_org_id)) instead of
-- a VIEW like reporting.v_executive_summary: that view is platform-wide,
-- with no per-org parameter — a KPI summary for ONE cooperative needs a
-- WHERE org_id = $1, which a plain view can't parameterize. A table
-- function is the natural equivalent, same schema (`reporting`) and
-- established EXECUTE-is-PUBIC-by-default convention as every other
-- business-logic function in this platform (produce.record_delivery(),
-- etc. — none of them ever needed an explicit GRANT EXECUTE).
-- ============================================================================

GRANT SELECT ON ledger.journal_entry TO agrolink_app;
GRANT SELECT ON ledger.v_account_balance TO agrolink_app;

CREATE FUNCTION reporting.coop_finance_summary(p_org_id uuid)
RETURNS TABLE (
  cash_balance                     numeric,
  cash_account_status               text,
  accounts_payable_to_members        numeric,
  deliveries_pending_settlement_count int,
  total_paid_to_members_alltime        numeric,
  deliveries_settled_count               int,
  total_collected_value_alltime            numeric,
  deliveries_pending_quality_count           int,
  inventory_tons_in_storage                    numeric,
  open_lots_count                                int
)
LANGUAGE sql STABLE AS $$
  SELECT
    (SELECT balance FROM ledger.v_account_balance
      WHERE owner_id = p_org_id AND account_type = 'vendor_settlement'),
    (SELECT status FROM ledger.account
      WHERE owner_id = p_org_id AND account_type = 'vendor_settlement' LIMIT 1),
    (SELECT COALESCE(SUM(total_amount), 0) FROM produce.delivery
      WHERE buyer_org_id = p_org_id AND status = 'accepted'),
    (SELECT COUNT(*)::int FROM produce.delivery
      WHERE buyer_org_id = p_org_id AND status = 'accepted'),
    (SELECT COALESCE(SUM(total_amount), 0) FROM produce.delivery
      WHERE buyer_org_id = p_org_id AND status = 'settled'),
    (SELECT COUNT(*)::int FROM produce.delivery
      WHERE buyer_org_id = p_org_id AND status = 'settled'),
    (SELECT COALESCE(SUM(total_amount), 0) FROM produce.delivery
      WHERE buyer_org_id = p_org_id),
    (SELECT COUNT(*)::int FROM produce.delivery
      WHERE buyer_org_id = p_org_id AND status = 'delivered'),
    (SELECT COALESCE(SUM(u.current_quantity_ton), 0) FROM warehouse.v_bin_utilization u
      JOIN warehouse.facility f ON f.facility_id = u.facility_id
      WHERE f.org_id = p_org_id),
    (SELECT COUNT(*)::int FROM produce.lot
      WHERE buyer_org_id = p_org_id AND status = 'Open')
$$;

COMMENT ON FUNCTION reporting.coop_finance_summary(uuid) IS
  'M04: สรุป KPI การเงินระดับสหกรณ์แบบ real-time (ไม่มี cache) — cash_account_status เป็น NULL หากยังไม่เคยเรียก partner.activate_vendor (ดู POST /admin/cooperatives/:id/activate-settlement ใน admin.js) หมายเหตุ: ไม่รวมลูกหนี้ (ยังไม่มีโมเดลใบแจ้งหนี้ผู้ซื้อปลายทางสำหรับสหกรณ์)';

-- ============================================================================
-- Follow-up work this migration deliberately leaves open:
--   - No receivables figure (see the design-decision note above) — add one
--     only once a real onward-sale/invoicing concept for cooperatives
--     exists (a future M12 extension), with real data behind it.
--   - No accounting-system adapter (the Master Blueprint's M04 scope also
--     mentions one) — this stays internal-reporting-only; exporting to an
--     external accounting package is a distinct integration task, closer
--     in spirit to M15 Government Integration Gateway, not attempted here.
--   - No period-over-period (month-over-month) comparison baked into the
--     function — GET /coop/finance/monthly (in coopcollection.js) computes
--     that directly with date_trunc() instead, since it returns a
--     multi-row time series rather than a single summary row.
-- ============================================================================
