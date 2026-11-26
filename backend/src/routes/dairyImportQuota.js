/**
 * โควตานำเข้าสินค้านม × ปัญหานมล้น (backend/db/grant_dairy_import_quota.sql, src/lib/dairyImportQuota.js)
 *
 *   /admin/dairy-import-quota  ผู้ดูแลแพลตฟอร์มบันทึกตามมติคณะกรรมการโคนมฯ: โควตารายงวด ผู้ได้รับจัดสรรรายนิติบุคคล
 *                              มาตรการรับซื้อนมส่วนเกิน และค่าแปลงเป็นน้ำนมดิบ
 *   /dairy-gov/import-quota    เจ้าหน้าที่รัฐ (อ่านอย่างเดียว): เทียบโควตากับนมเกิน + ทางเลือกเชิงนโยบาย + ความคืบหน้ามาตรการ
 */
const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requirePlatform, requireGovernmentOfficer } = require('../middleware/auth');
const {
  h, tx, bad, notFound, conflict, round2, bkkToday, isDate, num, needPos, isUuid, addDays,
} = require('../lib/dairy');
const Q = require('../lib/dairyImportQuota');

const STATUSES = ['Planned', 'Open', 'DeferProposed', 'Deferred', 'Closed'];
const AGREEMENTS = ['WTO', 'TAFTA', 'TNZCEP', 'TAFTA_TNZCEP', 'AFTA', 'ALL'];
const txt = (v, max = 500) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
const year = (v) => {
  const y = parseInt(v, 10);
  if (!(y >= 2560 && y <= 2700)) throw bad('invalid_field', { field: 'quota_year' });
  return y;
};
const group = (v, allowNull) => {
  if ((v === null || v === undefined || v === '') && allowNull) return null;
  const g = parseInt(v, 10);
  if (![1, 2].includes(g)) throw bad('invalid_field', { field: 'entity_group' });
  return g;
};
const uq = (code) => (e) => { if (e.code === '23505') throw conflict(code); throw e; };
async function needInstalled(c) {
  if (!(await Q.installed(c))) throw new (require('../lib/mushroom').HttpError)(503, 'dairy_import_quota_not_installed', { detail: 'run backend/db/grant_dairy_import_quota.sql' }); // eslint-disable-line global-require
}
async function defaultYear(c, q) {
  if (q) return year(q);
  // ปีปัจจุบัน (พ.ศ.) ถ้ามีข้อมูล ไม่มีก็ปีถัดไปที่ใกล้ที่สุด แล้วจึงปีล่าสุด
  const be = Number(bkkToday().slice(0, 4)) + 543;
  const r = (await c.query(
    `SELECT COALESCE((SELECT MIN(quota_year) FROM dairy.import_quota_tranche WHERE quota_year >= $1), (SELECT MAX(quota_year) FROM dairy.import_quota_tranche)) AS y`, [be],
  )).rows[0];
  return r.y || be + 1;
}

// ===========================================================================
// ผู้ดูแลแพลตฟอร์ม
// ===========================================================================
const admin = express.Router();
admin.use(requireAuth, requirePlatform);
const adb = (req, fn) => withSessionContext('platform', req.subject.subjectId || null, async (c) => { await needInstalled(c); return fn(c); });
const who = (req) => `platform:${req.subject.subjectId || 'admin'}`;

admin.get('/', h(async (req) => adb(req, async (c) => {
  const y = await defaultYear(c, req.query.year);
  const data = await Q.loadYear(c, y);
  const years = (await c.query('SELECT DISTINCT quota_year FROM dairy.import_quota_tranche ORDER BY 1 DESC')).rows.map((r) => r.quota_year);
  const processors = (await c.query('SELECT org_id, display_name, province_code FROM dairy.processor_profile WHERE active ORDER BY display_name')).rows;
  const progress = [];
  for (const m of data.measures.filter((x) => x.status === 'Active')) {
    // eslint-disable-next-line no-await-in-loop
    const p = await Q.measureProgress(c, m);
    progress.push({ measure_id: m.measure_id, rows: p.rows, groups: p.groups, unassigned_kg_day: p.unassigned_kg_day });
  }
  return { quota_year: y, years, ...data, processors, progress };
})));

admin.put('/products/:code', h(async (req) => adb(req, async (c) => {
  const b = req.body || {};
  const f = num(b.raw_milk_factor, { min: 0.01, max: 50 });
  if (!f) throw bad('invalid_field', { field: 'raw_milk_factor' });
  const r = (await c.query('UPDATE dairy.import_product SET raw_milk_factor=$2, factor_note=COALESCE($3, factor_note), updated_at=now() WHERE product_code=$1 RETURNING *',
    [req.params.code, f, txt(b.factor_note)])).rows[0];
  if (!r) throw notFound('product_not_found');
  await logAccess(c, 'write', 'dairy.import_product', null);
  return r;
})));

admin.post('/tranches', h(async (req, res) => adb(req, async (c) => {
  const b = req.body || {};
  if (!AGREEMENTS.includes(b.agreement)) throw bad('invalid_field', { field: 'agreement' });
  if (!isDate(b.opens_on)) throw bad('invalid_field', { field: 'opens_on' });
  const r = (await c.query(
    `INSERT INTO dairy.import_quota_tranche (quota_year, agreement, product_code, entity_group, tranche_no, quantity_t, opens_on, source_ref, note, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [year(b.quota_year), b.agreement, String(b.product_code || ''), group(b.entity_group, true), parseInt(b.tranche_no, 10) || 1, needPos(b.quantity_t, 'quantity_t'), b.opens_on,
      txt(b.source_ref), txt(b.note), who(req)],
  ).catch(uq('tranche_exists')).catch((e) => { if (e.code === '23503') throw bad('invalid_field', { field: 'product_code' }); throw e; })).rows[0];
  await logAccess(c, 'write', 'dairy.import_quota_tranche', r.tranche_id);
  res.status(201);
  return r;
})));

/** บันทึกมติ: เปลี่ยนสถานะงวด (เสนอชะลอ / ชะลอแล้ว ปริมาณที่ชะลอ / เปิด / ปิด) และปริมาณนำเข้าจริง */
admin.patch('/tranches/:id', h(async (req) => adb(req, async (c) => tx(c, async () => {
  if (!isUuid(req.params.id)) throw notFound('tranche_not_found');
  const t = (await c.query('SELECT * FROM dairy.import_quota_tranche WHERE tranche_id=$1 FOR UPDATE', [req.params.id])).rows[0];
  if (!t) throw notFound('tranche_not_found');
  const b = req.body || {};
  const sets = {};
  if (b.status !== undefined) { if (!STATUSES.includes(b.status)) throw bad('invalid_field', { field: 'status' }); sets.status = b.status; }
  if (b.quantity_t !== undefined) sets.quantity_t = needPos(b.quantity_t, 'quantity_t');
  if (b.deferred_t !== undefined) {
    const d = num(b.deferred_t, { min: 0 });
    if (d === null || Number.isNaN(d) || d > Number(sets.quantity_t ?? t.quantity_t)) throw bad('invalid_field', { field: 'deferred_t' });
    sets.deferred_t = d;
  }
  if (b.imported_t !== undefined) { const d = num(b.imported_t, { min: 0 }); if (Number.isNaN(d)) throw bad('invalid_field', { field: 'imported_t' }); sets.imported_t = d; }
  if (b.opens_on !== undefined) { if (!isDate(b.opens_on)) throw bad('invalid_field', { field: 'opens_on' }); sets.opens_on = b.opens_on; }
  if (b.note !== undefined) sets.note = txt(b.note);
  if (b.source_ref !== undefined) sets.source_ref = txt(b.source_ref);
  if ((sets.status || t.status) === 'Deferred' && !(Number(sets.deferred_t ?? t.deferred_t) > 0)) throw bad('deferred_amount_required');
  const keys = Object.keys(sets);
  if (!keys.length) return t;
  const r = (await c.query(
    `UPDATE dairy.import_quota_tranche SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_by=$${keys.length + 2}, updated_at=now() WHERE tranche_id=$1 RETURNING *`,
    [t.tranche_id, ...keys.map((k) => sets[k]), who(req)],
  )).rows[0];
  await logAccess(c, 'write', 'dairy.import_quota_tranche', t.tranche_id);
  return r;
}))));

function holderBody(b, partial) {
  const out = {};
  if (!partial || b.holder_name !== undefined) { out.holder_name = txt(b.holder_name, 200); if (!out.holder_name || out.holder_name.length < 2) throw bad('invalid_field', { field: 'holder_name' }); }
  if (!partial || b.entity_group !== undefined) out.entity_group = group(b.entity_group);
  if (!partial || b.quantity_t !== undefined) out.quantity_t = needPos(b.quantity_t, 'quantity_t');
  if (b.org_id !== undefined) { if (b.org_id && !isUuid(b.org_id)) throw bad('invalid_field', { field: 'org_id' }); out.org_id = b.org_id || null; }
  if (b.mou_raw_milk_kg_day !== undefined) { const m = num(b.mou_raw_milk_kg_day, { min: 0 }); if (Number.isNaN(m)) throw bad('invalid_field', { field: 'mou_raw_milk_kg_day' }); out.mou_raw_milk_kg_day = m; }
  if (b.active !== undefined) out.active = b.active !== false;
  if (b.note !== undefined) out.note = txt(b.note);
  return out;
}
admin.post('/holders', h(async (req, res) => adb(req, async (c) => {
  const b = req.body || {};
  const v = holderBody(b, false);
  const r = (await c.query(
    `INSERT INTO dairy.import_quota_holder (quota_year, product_code, holder_name, entity_group, quantity_t, org_id, mou_raw_milk_kg_day, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [year(b.quota_year), b.product_code || 'smp', v.holder_name, v.entity_group, v.quantity_t, v.org_id || null, v.mou_raw_milk_kg_day ?? null, v.note || null],
  ).catch(uq('holder_exists')).catch((e) => { if (e.code === '23503') throw bad('processor_or_product_not_found'); throw e; })).rows[0];
  await logAccess(c, 'write', 'dairy.import_quota_holder', r.holder_id);
  res.status(201);
  return r;
})));
admin.patch('/holders/:id', h(async (req) => adb(req, async (c) => {
  if (!isUuid(req.params.id)) throw notFound('holder_not_found');
  const v = holderBody(req.body || {}, true);
  const keys = Object.keys(v);
  if (!keys.length) throw bad('nothing_to_update');
  const r = (await c.query(`UPDATE dairy.import_quota_holder SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE holder_id=$1 RETURNING *`,
    [req.params.id, ...keys.map((k) => v[k])]).catch(uq('holder_exists'))).rows[0];
  if (!r) throw notFound('holder_not_found');
  await logAccess(c, 'write', 'dairy.import_quota_holder', r.holder_id);
  return r;
})));

admin.post('/measures', h(async (req, res) => adb(req, async (c) => {
  const b = req.body || {};
  if (!isDate(b.start_date)) throw bad('invalid_field', { field: 'start_date' });
  const days = parseInt(b.days, 10);
  if (!(days >= 1 && days <= 365)) throw bad('invalid_field', { field: 'days' });
  const g1 = num(b.group1_pct ?? 80, { min: 0, max: 100 });
  if (g1 === null || Number.isNaN(g1)) throw bad('invalid_field', { field: 'group1_pct' });
  const title = txt(b.title, 200);
  if (!title || title.length < 3) throw bad('invalid_field', { field: 'title' });
  const r = (await c.query(
    `INSERT INTO dairy.absorption_measure (title, quota_year, product_code, total_kg_day, start_date, days, group1_pct, status, source_ref, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [title, year(b.quota_year), b.product_code || 'smp', needPos(b.total_kg_day, 'total_kg_day'), b.start_date, days, g1, b.status === 'Active' ? 'Active' : 'Draft',
      txt(b.source_ref), txt(b.note), who(req)],
  )).rows[0];
  await logAccess(c, 'write', 'dairy.absorption_measure', r.measure_id);
  res.status(201);
  return r;
})));
admin.patch('/measures/:id', h(async (req) => adb(req, async (c) => {
  if (!isUuid(req.params.id)) throw notFound('measure_not_found');
  const b = req.body || {};
  if (!['Draft', 'Active', 'Closed'].includes(b.status)) throw bad('invalid_field', { field: 'status' });
  const r = (await c.query('UPDATE dairy.absorption_measure SET status=$2 WHERE measure_id=$1 RETURNING *', [req.params.id, b.status])).rows[0];
  if (!r) throw notFound('measure_not_found');
  await logAccess(c, 'write', 'dairy.absorption_measure', r.measure_id);
  return r;
})));

// ===========================================================================
// เจ้าหน้าที่รัฐ (mount ใน /dairy-gov ก่อน router หลัก)
// ===========================================================================
const gov = express.Router();
gov.use(requireAuth, requireGovernmentOfficer);
gov.get('/', h(async (req, res) => withSessionContext('government_officer', req.subject.subjectId, async (c) => {
  const officer = (await c.query(
    `SELECT o.officer_id, o.full_name, o.scope_type, o.province_code, pv.province_name_th FROM identity.government_officer o
       LEFT JOIN registry.province pv ON pv.province_code=o.province_code WHERE o.officer_id=$1 AND o.status='Active'`, [req.subject.subjectId],
  )).rows[0];
  if (!officer) { res.status(403).json({ error: 'officer_not_found_or_inactive' }); return undefined; }
  await needInstalled(c);
  const today = bkkToday();
  const y = await defaultYear(c, req.query.year);
  const data = await Q.loadYear(c, y);
  const years = (await c.query('SELECT DISTINCT quota_year FROM dairy.import_quota_tranche ORDER BY 1 DESC')).rows.map((r) => r.quota_year);

  // นมเกินที่ระบบตรวจพบ (สหกรณ์ที่ใช้ระบบ) ตามขอบเขตของเจ้าหน้าที่
  const prov = officer.scope_type === 'Province' ? officer.province_code : null;
  const sur = (await c.query(
    `SELECT COALESCE(SUM(k.surplus_kg_day) FILTER (WHERE k.horizon IN ('today','7d')),0)::numeric AS now_kg_day,
            COALESCE(MAX(k.surplus_kg_day) FILTER (WHERE k.horizon IN ('30d','60d','90d')),0)::numeric AS ahead_max_kg_day,
            COALESCE(SUM(k.surplus_kg_day) FILTER (WHERE k.horizon IN ('30d','60d','90d')),0)::numeric AS ahead_kg_day,
            COUNT(DISTINCT k.coop_org_id)::int AS coops
       FROM dairy.surplus_case k JOIN registry.cooperative_profile cp ON cp.org_id=k.coop_org_id
      WHERE k.status IN ('Open','Acting','Escalated') AND ($1::text IS NULL OR cp.province_code=$1)`, [prov],
  )).rows[0];
  const milk = (await c.query(
    `SELECT COALESCE(SUM(i.weight_kg),0)::numeric / 30 AS kg_day FROM dairy.milk_intake i JOIN dairy.milk_round r USING (round_id)
       JOIN registry.cooperative_profile cp ON cp.org_id=r.coop_org_id
      WHERE i.status='Accepted' AND r.round_date > $1::date - 30 AND r.round_date <= $1 AND ($2::text IS NULL OR cp.province_code=$2)`, [today, prov],
  )).rows[0];

  // ภาพรวมโควตา: น้ำนมดิบเทียบเท่า ทั้งปีและต่อวัน
  const tranches = data.tranches.map((t) => {
    const net = t.quantity_t - t.deferred_t;
    return { ...t, net_t: round2(net), raw_milk_kg: Q.rawMilkKg(net, t.raw_milk_factor), days_to_open: Math.round((Date.parse(t.opens_on) - Date.parse(today)) / 864e5) };
  });
  const yearRawKg = tranches.reduce((a, t) => a + t.raw_milk_kg, 0);
  const active = data.measures.find((m) => m.status === 'Active' && m.start_date <= today && m.end_date >= today) || null;
  let progress = null;
  if (active) {
    const p = await Q.measureProgress(c, active);
    progress = { ...p, delivered_kg: round2(p.holders.reduce((a, x) => a + x.delivered_kg, 0)), approved_kg_day: round2(p.holders.reduce((a, x) => a + x.approved_kg_day, 0)) };
  }
  const basisKg = active ? Number(active.total_kg_day) : (Number(sur.now_kg_day) || Number(sur.ahead_max_kg_day));
  const basis = active ? 'measure' : (Number(sur.now_kg_day) > 0 ? 'detected_now' : 'detected_ahead');
  const holders = active && progress ? progress.holders : data.holders.filter((x) => x.product_code === 'smp' && x.active);
  const options = Q.policyOptions({
    today, tranches, surplus_kg_day: basisKg, horizon_days: active ? Number(active.days) : Q.DEFAULT_HORIZON_DAYS, measure: active, holders, quota_year: y,
  });
  await logAccess(c, 'read', 'dairy.import_quota_tranche', null);
  return {
    officer, as_of: today, quota_year: y, years, products: data.products,
    tranches, year_raw_milk_kg: round2(yearRawKg), year_raw_milk_kg_day: round2(yearRawKg / 365),
    platform: { milk_kg_day: round2(Number(milk.kg_day)), surplus_now_kg_day: Number(sur.now_kg_day), surplus_ahead_kg_day: Number(sur.ahead_kg_day), coops_in_surplus: sur.coops },
    basis, basis_kg_day: round2(basisKg),
    measures: data.measures, active_measure: active, progress,
    holders_count: data.holders.length, holders_on_platform: data.holders.filter((x) => x.org_id).length,
    options,
    decision_points: tranches.filter((t) => t.days_to_open > 0 && ['Planned', 'DeferProposed'].includes(t.status))
      .map((t) => ({ tranche_id: t.tranche_id, label: `${t.name_th} ${t.agreement} งวด ${t.tranche_no}`, opens_on: t.opens_on, decide_by: addDays(t.opens_on, -Q.DECISION_LEAD_DAYS), net_t: t.net_t, raw_milk_kg: t.raw_milk_kg })),
  };
})));

module.exports = { admin, gov };
