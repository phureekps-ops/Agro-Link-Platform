-- AgroLink -- M14 Data/AI/Satellite, piece #1: descriptive analytics data
-- warehouse. Five GROUP-BY views over data that already exists (M04
-- Finance, M09 Collection, M10 Warehouse, M11 Processing, and the earlier
-- risk.credit_score table) — no new source data, purely aggregation. This
-- is deliberately a THIN layer: plain SQL views, not materialized views or
-- a real ETL pipeline, since the underlying tables in this sandbox are
-- small enough that querying live is fast — see the Follow-up note below
-- for when that stops being true.
--
-- Context: reporting.v_farmer_360 and reporting.v_executive_summary already
-- exist (an earlier phase of this platform) as ONE-ROW, farmer-scoped /
-- platform-wide summaries. The views below are deliberately the
-- complement: multi-row, GROUP-BY breakdowns (by province, by commodity, by
-- facility, by risk tier) — the shape a dashboard needs for a bar chart or
-- a table, not a single KPI tile. Task M14's own gap analysis calls for
-- "member counts, delivery volume by commodity/province, warehouse
-- utilization, processing yield, credit score distribution" — the five
-- views here map 1:1 to that list.
--
-- Design decision: analytics.v_delivery_volume_by_commodity_province and
-- analytics.v_warehouse_utilization_by_facility deliberately scope to
-- COOPERATIVE-owned data only (buyer_org_id / facility org_id joined
-- through registry.cooperative_profile) rather than every Buyer/Machinery/
-- etc. organization on the platform — this warehouse exists to feed the
-- M14+M15 government aggregate dashboard (Provincial/National officers,
-- see grant_staff_and_government_access.sql), and a government officer has
-- no legitimate reason to see a private Buyer's commercial volumes. A
-- platform-wide (all org types) version of these views is straightforward
-- future work if Platform Ops ever wants one, but is NOT what M15 needs.
--
-- Design decision: analytics.v_credit_score_distribution stays
-- PLATFORM-ONLY BY CONSTRUCTION — risk.credit_score has forced row-level
-- security with policies for 'farmer' (own score) and 'platform' (all
-- scores) ONLY (see grant_credit_risk.sql from Layer 6) — there is no
-- 'organization' or 'government_officer' policy on that table. This view
-- does not attempt to add one (a farmer's individual credit tier is
-- sensitive; widening its visibility is a real product/policy decision,
-- not a schema-migration one) — querying this view under any session
-- context other than 'platform' simply returns zero rows for every tier,
-- by the same RLS the base table already enforces. Task #160 (government
-- dashboard) is written with this in mind and does NOT surface this
-- particular view to gov officers.
--
-- Follow-up (not built in this pass):
--   1. Plain views, not materialized — recomputed on every query. Fine at
--      this sandbox's data volume; a real deployment with a large
--      produce.delivery/processing.batch history would want these
--      materialized and refreshed on a schedule (see the ops/monitoring
--      schemas from Layer 9/10 for where a refresh job would plug in).
--   2. No time-windowing (e.g. "this month" vs "all time") — every view
--      aggregates over the ENTIRE history in the table. A dashboard that
--      wants a trend line still needs to add its own date filtering on
--      top of these views (or a future v_..._by_month variant).
--   3. analytics.v_processing_yield only covers COMPLETED batches (yield
--      is undefined for an in-progress or cancelled batch) — an
--      InProgress batch simply does not appear in this view yet.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS analytics;
GRANT USAGE ON SCHEMA analytics TO agrolink_app;

-- ---------------------------------------------------------------------
-- 1. Member counts — cooperative membership figures rolled up by province.
--    member_count_reported is self-reported by each cooperative (see
--    registry.cooperative_profile's own comment — no real member import
--    exists yet, that is M02's job), so this is descriptive of what
--    cooperatives HAVE TOLD the platform, not a verified census.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.v_cooperative_membership_by_province AS
SELECT
  p.province_code,
  p.province_name_th,
  p.region_th,
  COUNT(cp.org_id)::int AS cooperative_count,
  COALESCE(SUM(cp.member_count_reported), 0)::bigint AS total_members_reported,
  ROUND(AVG(cp.member_count_reported), 1) AS avg_members_reported_per_coop
FROM registry.province p
LEFT JOIN registry.cooperative_profile cp ON cp.province_code = p.province_code
LEFT JOIN identity.organization o ON o.org_id = cp.org_id AND o.org_type = 'Cooperative'
GROUP BY p.province_code, p.province_name_th, p.region_th
ORDER BY p.province_name_th;

COMMENT ON VIEW analytics.v_cooperative_membership_by_province IS
  'จำนวนสหกรณ์และสมาชิกที่แจ้ง (self-reported) แยกตามจังหวัด — ทุกจังหวัดปรากฏในผลลัพธ์แม้ยังไม่มีสหกรณ์ (LEFT JOIN จาก registry.province)';

-- ---------------------------------------------------------------------
-- 2. Delivery volume by commodity + province — cooperative buyers only
--    (see header design decision).
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.v_delivery_volume_by_commodity_province AS
SELECT
  cp.province_code,
  p.province_name_th,
  d.commodity_code,
  c.name_th AS commodity_name_th,
  COUNT(*)::int AS delivery_count,
  SUM(d.quantity_ton) AS total_quantity_ton,
  SUM(d.quantity_ton) FILTER (WHERE d.status = 'settled') AS settled_quantity_ton,
  SUM(d.total_amount) FILTER (WHERE d.status = 'settled') AS settled_amount
FROM produce.delivery d
JOIN registry.cooperative_profile cp ON cp.org_id = d.buyer_org_id
JOIN registry.province p ON p.province_code = cp.province_code
LEFT JOIN registry.commodity_ref c ON c.commodity_code = d.commodity_code
GROUP BY cp.province_code, p.province_name_th, d.commodity_code, c.name_th
ORDER BY p.province_name_th, d.commodity_code;

COMMENT ON VIEW analytics.v_delivery_volume_by_commodity_province IS
  'ปริมาณการรับซื้อของสหกรณ์ (ไม่รวมผู้รับซื้อเอกชน/Buyer ทั่วไป) แยกตามจังหวัดและชนิดผลผลิต — ดูหมายเหตุการออกแบบใน header comment ของไฟล์นี้';

-- ---------------------------------------------------------------------
-- 3. Warehouse utilization — rolled up from the existing warehouse.
--    v_bin_utilization view (per-bin) to per-facility and per-province,
--    cooperative facilities only.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.v_warehouse_utilization_by_facility AS
SELECT
  f.facility_id,
  f.facility_name,
  f.facility_type,
  f.org_id,
  o.org_name,
  cp.province_code,
  p.province_name_th,
  f.capacity_ton AS facility_capacity_ton,
  COALESCE(SUM(bu.current_quantity_ton), 0) AS current_quantity_ton,
  CASE
    WHEN f.capacity_ton IS NULL OR f.capacity_ton = 0 THEN NULL
    ELSE ROUND(COALESCE(SUM(bu.current_quantity_ton), 0) / f.capacity_ton * 100, 1)
  END AS utilization_pct
FROM warehouse.facility f
JOIN identity.organization o ON o.org_id = f.org_id
JOIN registry.cooperative_profile cp ON cp.org_id = f.org_id
JOIN registry.province p ON p.province_code = cp.province_code
LEFT JOIN warehouse.v_bin_utilization bu ON bu.facility_id = f.facility_id
GROUP BY f.facility_id, f.facility_name, f.facility_type, f.org_id, o.org_name, cp.province_code, p.province_name_th, f.capacity_ton;

COMMENT ON VIEW analytics.v_warehouse_utilization_by_facility IS
  'อัตราการใช้พื้นที่คลัง/ลานตากของสหกรณ์ ต่อยอดจาก warehouse.v_bin_utilization (รวมทุก bin ในคลังเดียวกัน) — เฉพาะคลังของสหกรณ์ (org_type=Cooperative)';

CREATE OR REPLACE VIEW analytics.v_warehouse_utilization_by_province AS
SELECT
  province_code,
  province_name_th,
  COUNT(*)::int AS facility_count,
  SUM(facility_capacity_ton) AS total_capacity_ton,
  SUM(current_quantity_ton) AS total_current_quantity_ton,
  CASE
    WHEN SUM(facility_capacity_ton) IS NULL OR SUM(facility_capacity_ton) = 0 THEN NULL
    ELSE ROUND(SUM(current_quantity_ton) / SUM(facility_capacity_ton) * 100, 1)
  END AS utilization_pct
FROM analytics.v_warehouse_utilization_by_facility
GROUP BY province_code, province_name_th
ORDER BY province_name_th;

COMMENT ON VIEW analytics.v_warehouse_utilization_by_province IS
  'สรุปการใช้พื้นที่คลัง/ลานตากของสหกรณ์ระดับจังหวัด (รวมทุกคลังของทุกสหกรณ์ในจังหวัดนั้น)';

-- ---------------------------------------------------------------------
-- 4. Processing yield — Completed batches only (see header Follow-up #3).
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.v_processing_yield AS
SELECT
  b.org_id,
  o.org_name,
  b.process_type,
  b.source_commodity_code,
  c.name_th AS source_commodity_name_th,
  COUNT(*)::int AS completed_batch_count,
  SUM(bi.input_ton) AS total_input_ton,
  SUM(fg.output_ton) AS total_output_ton,
  CASE
    WHEN SUM(bi.input_ton) IS NULL OR SUM(bi.input_ton) = 0 THEN NULL
    ELSE ROUND(SUM(fg.output_ton) / SUM(bi.input_ton) * 100, 1)
  END AS yield_pct
FROM processing.batch b
JOIN identity.organization o ON o.org_id = b.org_id
LEFT JOIN registry.commodity_ref c ON c.commodity_code = b.source_commodity_code
LEFT JOIN (
  SELECT batch_id, SUM(quantity_ton) AS input_ton FROM processing.batch_input GROUP BY batch_id
) bi ON bi.batch_id = b.batch_id
LEFT JOIN (
  SELECT batch_id, SUM(quantity_ton) AS output_ton FROM processing.finished_good GROUP BY batch_id
) fg ON fg.batch_id = b.batch_id
WHERE b.status = 'Completed'
GROUP BY b.org_id, o.org_name, b.process_type, b.source_commodity_code, c.name_th;

COMMENT ON VIEW analytics.v_processing_yield IS
  'ผลผลิตที่ได้ (yield) เทียบกับวัตถุดิบนำเข้า แยกตามองค์กร/ประเภทกระบวนการ/ชนิดผลผลิตต้นทาง — เฉพาะชุดการแปรรูปที่เสร็จสิ้นแล้ว (status=Completed)';

-- ---------------------------------------------------------------------
-- 5. Credit score distribution — PLATFORM-ONLY (see header design
--    decision). Latest score per farmer only (a farmer re-scored over
--    time should count once, at their current tier).
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.v_credit_score_distribution AS
WITH latest_score AS (
  SELECT DISTINCT ON (farmer_id) farmer_id, score_value, risk_tier, computed_at
  FROM risk.credit_score
  ORDER BY farmer_id, computed_at DESC
)
SELECT
  risk_tier,
  COUNT(*)::int AS farmer_count,
  ROUND(AVG(score_value), 1) AS avg_score_value,
  MIN(score_value) AS min_score_value,
  MAX(score_value) AS max_score_value
FROM latest_score
GROUP BY risk_tier
ORDER BY risk_tier;

COMMENT ON VIEW analytics.v_credit_score_distribution IS
  'จำนวนเกษตรกรแยกตามระดับความเสี่ยงสินเชื่อล่าสุด (risk_tier) — เห็นได้เฉพาะ subject_type=platform เท่านั้น เพราะ risk.credit_score มี Row-Level Security ที่อนุญาตแค่ farmer(ดูของตัวเอง)/platform(ดูทั้งหมด) — ดูหมายเหตุการออกแบบใน header comment';

-- Views inherit table-level SELECT privileges from their underlying
-- tables/views at query time (Postgres view privilege model) — but a
-- view's OWNER still needs USAGE on every schema it references, and the
-- QUERYING role needs SELECT on the view itself. All underlying tables
-- above (registry.*, produce.*, warehouse.*, processing.*, risk.*,
-- identity.*, production.*) were already granted to agrolink_app by
-- earlier migrations; this view schema itself needs its own explicit
-- grant, same lesson as every other new-schema migration in this repo.
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO agrolink_app;
