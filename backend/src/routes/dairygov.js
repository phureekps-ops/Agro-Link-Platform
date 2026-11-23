const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireGovernmentOfficer } = require('../middleware/auth');
const { h, round2, bkkToday, addDays } = require('../lib/dairy');
const core = require('../lib/dairyCore');

/**
 * /dairy-gov — Dashboard นโยบายโคนมสำหรับเจ้าหน้าที่รัฐ (อ่านอย่างเดียว).
 * ขอบเขตเดียวกับ /gov: เจ้าหน้าที่ระดับประเทศเห็นทุกจังหวัด ระดับจังหวัดเห็น
 * เฉพาะสหกรณ์ในจังหวัดตน (registry.cooperative_profile.province_code).
 *
 * ความเป็นส่วนตัว: ตัวเลขรวมรายจังหวัดรวมทุกสหกรณ์ที่ใช้โปรแกรม แต่ข้อมูล
 * รายสหกรณ์ (ชื่อ ตัวเลข ระดับเตือน) แสดงเฉพาะสหกรณ์ที่เปิด
 * dairy.setting.gov_data_consent. ไม่ส่งราคาสัญญารายบริษัท ไม่ส่งข้อมูลสมาชิกรายคน.
 */
const router = express.Router();
router.use(requireAuth, requireGovernmentOfficer);

const db = (req, fn) => withSessionContext('government_officer', req.subject.subjectId, (client) => fn(client, req.subject.subjectId));
const LEVEL_RANK = {
  green: 0, yellow: 1, orange: 2, red: 3,
};

router.get('/overview', h(async (req, res) => db(req, async (c, officerId) => {
  const officer = (await c.query(
    `SELECT officer_id, full_name, scope_type, province_code FROM identity.government_officer WHERE officer_id=$1 AND status='Active'`, [officerId],
  )).rows[0];
  if (!officer) { res.status(403).json({ error: 'officer_not_found_or_inactive' }); return undefined; }
  const params = [];
  let scope = '';
  if (officer.scope_type === 'Province') { params.push(officer.province_code); scope = 'AND cp.province_code=$1'; }
  const coops = (await c.query(
    `SELECT s.coop_org_id, s.gov_data_consent, o.org_name, cp.province_code, pv.province_name_th
       FROM dairy.setting s JOIN identity.organization o ON o.org_id=s.coop_org_id
       JOIN registry.cooperative_profile cp ON cp.org_id=s.coop_org_id JOIN registry.province pv ON pv.province_code=cp.province_code
      WHERE o.kyb_status='Verified' ${scope} ORDER BY pv.province_name_th, o.org_name`, params,
  )).rows;
  const today = bkkToday();
  const from30 = addDays(today, -30);
  const rows = [];
  for (const k of coops) {
    const [x] = (await c.query(
      `SELECT (SELECT COUNT(*) FROM dairy.member WHERE coop_org_id=$1 AND status='Approved')::int AS members,
              (SELECT COUNT(*) FROM dairy.animal WHERE coop_org_id=$1 AND status='Milking')::int AS milking_cows,
              (SELECT COALESCE(SUM(i.weight_kg),0) FROM dairy.milk_intake i JOIN dairy.milk_round r USING (round_id)
                WHERE r.coop_org_id=$1 AND i.status='Accepted' AND r.round_date >= $2 AND r.round_date <= $3)::numeric AS milk_30d_kg,
              (SELECT COUNT(DISTINCT round_date) FROM dairy.milk_round WHERE coop_org_id=$1 AND round_date >= $2 AND round_date <= $3)::int AS days_30d,
              (SELECT COALESCE(SUM(daily_kg),0) FROM dairy.contract WHERE coop_org_id=$1 AND status='Active' AND $3::date BETWEEN start_date AND end_date)::numeric AS contracted_kg_day,
              (SELECT COALESCE(SUM(received_kg),0) FROM dairy.shipment WHERE coop_org_id=$1 AND status='Received' AND ship_date >= $2)::numeric AS sold_30d_kg,
              (SELECT COALESCE(SUM(sent_kg),0) FROM dairy.shipment WHERE coop_org_id=$1 AND status='Rejected' AND ship_date >= $2)::numeric AS rejected_30d_kg,
              (SELECT COALESCE(SUM(kg_per_day),0) FROM dairy.surplus_offer WHERE coop_org_id=$1 AND status='Open')::numeric AS open_surplus_kg_day,
              (SELECT ROUND(AVG(fat_pct),2) FROM dairy.quality_test WHERE coop_org_id=$1 AND sample_date >= $2) AS avg_fat,
              (SELECT ROUND(AVG(snf_pct),2) FROM dairy.quality_test WHERE coop_org_id=$1 AND sample_date >= $2) AS avg_snf,
              (SELECT ROUND(AVG(scc_k),0) FROM dairy.quality_test WHERE coop_org_id=$1 AND sample_date >= $2) AS avg_scc_k`,
      [k.coop_org_id, from30, today],
    )).rows;
    const f = await core.forecast(c, k.coop_org_id, 90);
    rows.push({ ...k, ...x, milk_kg_day: x.days_30d ? round2(Number(x.milk_30d_kg) / x.days_30d) : 0, forecast: f.windows });
  }
  const provinces = new Map();
  rows.forEach((r) => {
    const p = provinces.get(r.province_code) || {
      province_code: r.province_code, province_name_th: r.province_name_th, coops: 0, members: 0, milking_cows: 0, milk_kg_day: 0,
      contracted_kg_day: 0, open_surplus_kg_day: 0, rejected_30d_kg: 0, f30: 0, c30: 0, f90: 0, c90: 0,
    };
    p.coops += 1; p.members += r.members; p.milking_cows += r.milking_cows; p.milk_kg_day += Number(r.milk_kg_day);
    p.contracted_kg_day += Number(r.contracted_kg_day); p.open_surplus_kg_day += Number(r.open_surplus_kg_day); p.rejected_30d_kg += Number(r.rejected_30d_kg);
    const w30 = r.forecast.find((w) => w.days === 30); const w90 = r.forecast.find((w) => w.days === 90);
    if (w30) { p.f30 += w30.avg_forecast_kg; p.c30 += w30.avg_committed_kg; }
    if (w90) { p.f90 += w90.avg_forecast_kg; p.c90 += w90.avg_committed_kg; }
    provinces.set(r.province_code, p);
  });
  const level = (f, k) => {
    if (!(f > 0)) return { level: 'green', surplus_pct: 0 };
    if (!(k > 0)) return { level: 'red', surplus_pct: null };
    const pct = round2(((f - k) / k) * 100);
    // ระดับประเทศใช้เกณฑ์ตามรายงาน (1/3/5%) — แต่ละสหกรณ์ปรับเกณฑ์ของตนเองได้
    return { level: pct > 5 ? 'red' : pct > 3 ? 'orange' : pct > 1 ? 'yellow' : 'green', surplus_pct: pct };
  };
  const prov = [...provinces.values()].map((p) => ({
    ...p, milk_kg_day: round2(p.milk_kg_day), contracted_kg_day: round2(p.contracted_kg_day),
    forecast30_kg_day: round2(p.f30), committed30_kg_day: round2(p.c30), alert30: level(p.f30, p.c30),
    forecast90_kg_day: round2(p.f90), committed90_kg_day: round2(p.c90), alert90: level(p.f90, p.c90),
  })).sort((a, b) => LEVEL_RANK[b.alert30.level] - LEVEL_RANK[a.alert30.level]);
  const consenting = rows.filter((r) => r.gov_data_consent).map((r) => ({
    org_name: r.org_name, province_name_th: r.province_name_th, members: r.members, milking_cows: r.milking_cows, milk_kg_day: r.milk_kg_day,
    contracted_kg_day: Number(r.contracted_kg_day), sold_30d_kg: Number(r.sold_30d_kg), rejected_30d_kg: Number(r.rejected_30d_kg),
    open_surplus_kg_day: Number(r.open_surplus_kg_day), avg_fat: r.avg_fat, avg_snf: r.avg_snf, avg_scc_k: r.avg_scc_k, forecast: r.forecast,
  }));
  const capacity = (await c.query(
    `SELECT COALESCE(SUM(kg_per_day),0)::numeric AS kg_per_day, COUNT(DISTINCT org_id)::int AS processors FROM dairy.processor_capacity
      WHERE active AND available_from <= $1::date + 30 AND available_to >= $1`, [today],
  )).rows[0];
  const school = (await c.query(
    `SELECT COUNT(*)::int AS deliveries, COALESCE(SUM(units),0)::int AS units, COALESCE(SUM(received_units) FILTER (WHERE status IN ('Confirmed','Issue')),0)::int AS received_units,
            COUNT(*) FILTER (WHERE status='Issue')::int AS issues
       FROM dairy.school_delivery d ${officer.scope_type === 'Province' ? 'JOIN registry.cooperative_profile cp ON cp.org_id=d.coop_org_id AND cp.province_code=$2' : ''}
      WHERE d.delivery_date BETWEEN $1::date - 30 AND $1 AND d.status <> 'Cancelled'`,
    officer.scope_type === 'Province' ? [today, officer.province_code] : [today],
  )).rows[0];
  const totals = prov.reduce((a, p) => {
    ['coops', 'members', 'milking_cows', 'milk_kg_day', 'contracted_kg_day', 'open_surplus_kg_day', 'f30', 'c30'].forEach((f) => { a[f] = (a[f] || 0) + Number(p[f]); });
    return a;
  }, {});
  await logAccess(c, 'read', 'dairy.setting', null);
  return {
    officer, as_of: today,
    totals: { ...totals, milk_kg_day: round2(totals.milk_kg_day || 0), alert30: level(totals.f30 || 0, totals.c30 || 0) },
    provinces: prov, cooperatives: consenting, coops_not_sharing: rows.length - consenting.length,
    processor_capacity_30d: capacity, school_milk_30d: school,
  };
})));

/**
 * GET /dairy-gov/surplus — กรณีนมเกินกำลังรับซื้อ (grant_dairy_surplus_cases.sql).
 * รวมรายจังหวัดจากทุกสหกรณ์ (ไม่ระบุชื่อ). รายละเอียดรายกรณีแสดงเฉพาะสหกรณ์ที่เปิด
 * gov_data_consent หรือกรณีที่สหกรณ์กด "ขอความช่วยเหลือจังหวัด" เอง (shared_with_gov).
 * ไม่ส่งราคาที่ตกลงกับโรงงาน และไม่ส่งข้อมูลสมาชิก.
 */
router.get('/surplus', h(async (req, res) => db(req, async (c, officerId) => {
  const officer = (await c.query(
    `SELECT officer_id, full_name, scope_type, province_code FROM identity.government_officer WHERE officer_id=$1 AND status='Active'`, [officerId],
  )).rows[0];
  if (!officer) { res.status(403).json({ error: 'officer_not_found_or_inactive' }); return undefined; }
  if (!(await c.query(`SELECT to_regclass('dairy.surplus_case') IS NOT NULL AS ok`)).rows[0].ok) {
    res.status(503).json({ error: 'dairy_surplus_not_installed', detail: 'run backend/db/grant_dairy_surplus_cases.sql' });
    return undefined;
  }
  const params = [];
  let scope = '';
  if (officer.scope_type === 'Province') { params.push(officer.province_code); scope = `AND cp.province_code=$${params.length}`; }
  const from = `FROM dairy.surplus_case k JOIN dairy.setting s ON s.coop_org_id=k.coop_org_id
       JOIN identity.organization o ON o.org_id=k.coop_org_id AND o.kyb_status='Verified'
       JOIN registry.cooperative_profile cp ON cp.org_id=k.coop_org_id JOIN registry.province pv ON pv.province_code=cp.province_code
       LEFT JOIN dairy.collection_center cc ON cc.center_id=k.center_id`;
  const base = `${from}
      WHERE true ${scope}`;
  const provinces = (await c.query(
    `SELECT cp.province_code, pv.province_name_th,
            COUNT(*) FILTER (WHERE k.status IN ('Open','Acting','Escalated'))::int AS active_cases,
            COUNT(*) FILTER (WHERE k.status IN ('Open','Acting','Escalated') AND k.alert_level='red')::int AS red_cases,
            COUNT(*) FILTER (WHERE k.status='Escalated')::int AS escalated_cases,
            COUNT(DISTINCT k.coop_org_id) FILTER (WHERE k.status IN ('Open','Acting','Escalated'))::int AS coops_affected,
            COALESCE(SUM(k.surplus_kg_day) FILTER (WHERE k.status IN ('Open','Acting','Escalated') AND k.horizon IN ('today','7d')),0)::numeric AS surplus_now_kg_day,
            COALESCE(SUM(k.surplus_kg_day) FILTER (WHERE k.status IN ('Open','Acting','Escalated') AND k.horizon IN ('30d','60d','90d')),0)::numeric AS surplus_ahead_kg_day,
            COALESCE(SUM(k.discarded_kg) FILTER (WHERE k.closed_at >= now() - interval '30 days'),0)::numeric AS discarded_30d_kg,
            COALESCE(SUM(k.handled_kg) FILTER (WHERE k.closed_at >= now() - interval '30 days'),0)::numeric AS handled_30d_kg,
            COUNT(*) FILTER (WHERE k.status='Resolved' AND k.closed_at >= now() - interval '30 days')::int AS resolved_30d
       ${base} AND (k.status IN ('Open','Acting','Escalated') OR k.closed_at >= now() - interval '30 days')
      GROUP BY cp.province_code, pv.province_name_th ORDER BY red_cases DESC, surplus_now_kg_day DESC`, params,
  )).rows;
  const cases = (await c.query(
    `SELECT k.case_id, o.org_name, pv.province_name_th, k.horizon, k.scope, cc.name AS center_name, k.status, k.alert_level,
            k.surplus_kg_day, k.surplus_pct, k.days, k.deadline_at, k.first_detected_at, k.escalated_at, k.escalation_note, k.shared_with_gov,
            (SELECT json_agg(json_build_object('kind', x.kind, 'target_name', x.target_name, 'kg_per_day', x.kg_per_day, 'feasible', x.feasible, 'status', x.status)
                     ORDER BY x.rank) FROM dairy.surplus_option x WHERE x.case_id=k.case_id AND x.kind <> 'gov_help') AS options
       ${base} AND k.status IN ('Open','Acting','Escalated') AND (s.gov_data_consent OR k.shared_with_gov)
      ORDER BY (k.status='Escalated') DESC, CASE k.alert_level WHEN 'red' THEN 0 WHEN 'orange' THEN 1 ELSE 2 END, k.deadline_at LIMIT 200`, params,
  )).rows;
  const hidden = (await c.query(
    `SELECT COUNT(*)::int AS n ${base} AND k.status IN ('Open','Acting','Escalated') AND NOT (s.gov_data_consent OR k.shared_with_gov)`, params,
  )).rows[0].n;
  const capacity = (await c.query(
    `SELECT COALESCE(SUM(kg_per_day),0)::numeric AS kg_per_day, COUNT(DISTINCT org_id)::int AS processors FROM dairy.processor_capacity
      WHERE active AND available_from <= $1::date + 7 AND available_to >= $1`, [bkkToday()],
  )).rows[0];
  const totals = provinces.reduce((a, p) => {
    ['active_cases', 'red_cases', 'escalated_cases', 'coops_affected', 'surplus_now_kg_day', 'surplus_ahead_kg_day', 'discarded_30d_kg', 'handled_30d_kg']
      .forEach((f) => { a[f] = round2((a[f] || 0) + Number(p[f])); });
    return a;
  }, {});
  await logAccess(c, 'read', 'dairy.surplus_case', null);
  return { officer, as_of: bkkToday(), totals, provinces, cases, cases_not_shared: hidden, processor_capacity_7d: capacity };
})));

module.exports = router;
