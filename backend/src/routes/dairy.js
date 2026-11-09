const express = require('express');
const crypto = require('crypto');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganizationOrStaff, resolveEffectiveOrgSubject } = require('../middleware/auth');
const {
  h, tx, bad, notFound, conflict, round2, feeOf, bkkToday, isDate, num, needPos, needNonNeg, needUuid, isUuid,
  addDays, ds, priceFor, PARTNER_TYPES, ANIMAL_STATUS, EVENT_TYPES, DAIRY_PRODUCT_TYPES, REJECT_REASONS, DEBIT_TYPES,
} = require('../lib/dairy');
const core = require('../lib/dairyCore');

/**
 * /dairy — พอร์ทัลสหกรณ์โคนม (โปรแกรมบริหารธุรกิจโคนมครบวงจร) ฝั่งสหกรณ์.
 * ดู backend/db/grant_dairy_cooperative.sql สำหรับ schema และข้อตัดสินใจ
 * (จ่ายทุก 15 วัน, ราคาฐาน ± คุณภาพ, หักกลบตามลำดับผ่าน ธ.ก.ส.,
 * ค่าบริการ % ผู้ขายจ่าย).
 *
 * SECURITY: ตาราง dairy.* ไม่มี RLS — ทุก query ต้องมี coop_org_id = สหกรณ์
 * ที่ login และทุก id จาก client ต้องผ่าน own() ก่อนใช้เสมอ.
 */
const router = express.Router();
router.use(requireAuth, requireOrganizationOrStaff);

async function requireCooperativeOrg(req, res, next) {
  try {
    const ok = await resolveEffectiveOrgSubject(req, res, ['Cooperative']);
    if (!ok) return undefined;
    const { subjectId } = req.subject;
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const org = await client.query('SELECT org_id, org_name, org_type, kyb_status FROM identity.organization WHERE org_id = $1', [subjectId]);
      if (org.rows.length === 0) return { orgMissing: true };
      const orgRow = org.rows[0];
      if (orgRow.kyb_status !== 'Verified') return { kybNotVerified: true, org: orgRow };
      const role = await client.query(
        `SELECT status FROM identity.organization_role WHERE org_id = $1 AND role_type = 'Cooperative'`, [subjectId],
      );
      const roleStatus = role.rows[0] ? role.rows[0].status : null;
      if (roleStatus === 'Verified') await client.query('SELECT dairy.ensure_coop_defaults($1)', [subjectId]);
      return { org: orgRow, roleStatus };
    });
    if (result.orgMissing) return res.status(403).json({ error: 'cooperative_subject_required' });
    if (result.kybNotVerified) return res.status(403).json({ error: 'kyb_not_verified', kyb_status: result.org.kyb_status, org_name: result.org.org_name });
    if (result.roleStatus !== 'Verified') {
      return res.status(403).json({ error: 'role_not_verified', role_type: 'Cooperative', role_status: result.roleStatus, org_name: result.org.org_name });
    }
    req.org = result.org;
    return next();
  } catch (err) {
    return next(err);
  }
}
router.use(requireCooperativeOrg);

const db = (req, fn) => withSessionContext('organization', req.subject.subjectId, (client) => fn(client, req.subject.subjectId));
const actor = (req) => (req.actingStaff ? `staff:${req.actingStaff.memberId}` : `org:${req.subject.subjectId}`);

const OWN_TABLES = {
  member: ['dairy.member', 'member_id'],
  partner: ['dairy.partner', 'partner_id'],
  center: ['dairy.collection_center', 'center_id'],
  animal: ['dairy.animal', 'animal_id'],
  round: ['dairy.milk_round', 'round_id'],
  rule: ['dairy.quality_rule', 'rule_id'],
  item: ['dairy.supply_item', 'item_id'],
  po: ['dairy.purchase_order', 'po_id'],
  request: ['dairy.service_request', 'request_id'],
  contract: ['dairy.contract', 'contract_id'],
  shipment: ['dairy.shipment', 'shipment_id'],
  offer: ['dairy.surplus_offer', 'offer_id'],
  product: ['dairy.product', 'product_id'],
  batch: ['dairy.production_batch', 'batch_id'],
  school: ['dairy.school', 'school_id'],
  delivery: ['dairy.school_delivery', 'delivery_id'],
  run: ['dairy.settlement_run', 'run_id'],
  device: ['dairy.iot_device', 'device_id'],
};

async function own(c, coopId, kind, id, { lock = false } = {}) {
  const [table, pk] = OWN_TABLES[kind];
  if (!isUuid(id)) throw notFound(`${kind}_not_found`);
  const r = await c.query(`SELECT * FROM ${table} WHERE ${pk}=$1 AND coop_org_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, coopId]);
  if (!r.rows.length) throw notFound(`${kind}_not_found`);
  return r.rows[0];
}
const txt = (v) => (v === null || v === undefined ? null : String(v).trim() || null);
const dstr = ds;

/** Generic "build an UPDATE/INSERT from whitelisted, validated fields" helper. */
function pick(b, spec) {
  const out = {};
  Object.entries(spec).forEach(([f, kind]) => {
    if (!(f in b)) return;
    let v = b[f];
    if (kind === 'text') v = txt(v);
    else if (kind === 'bool') v = !!v;
    else if (kind === 'date') { if (v === '' || v === null) v = null; else if (!isDate(v)) throw bad('invalid_field', { field: f }); }
    else if (kind === 'num' || kind === 'int' || kind === 'numnull') {
      v = num(v, { min: 0 });
      if (Number.isNaN(v) || (v === null && kind !== 'numnull') || (kind === 'int' && v !== null && !Number.isInteger(v))) throw bad('invalid_field', { field: f });
    }
    out[f] = v;
  });
  return out;
}
async function insertRow(c, table, vals) {
  const cols = Object.keys(vals);
  return (await c.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, Object.values(vals))).rows[0];
}
async function updateRow(c, table, pk, id, vals) {
  const keys = Object.keys(vals);
  if (!keys.length) return (await c.query(`SELECT * FROM ${table} WHERE ${pk}=$1`, [id])).rows[0];
  return (await c.query(`UPDATE ${table} SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE ${pk}=$1 RETURNING *`, [id, ...Object.values(vals)])).rows[0];
}
const uniq = (code) => (e) => { if (e.code === '23505') throw conflict(code); throw e; };

// ===========================================================================
// ภาพรวม
// ===========================================================================
router.get('/overview', h(async (req) => db(req, async (c, coop) => {
  const s = await core.settings(c, coop);
  const today = bkkToday();
  const [x] = (await c.query(
    `SELECT
       (SELECT COUNT(*) FROM dairy.member WHERE coop_org_id=$1)::int AS members_total,
       (SELECT COUNT(*) FROM dairy.member WHERE coop_org_id=$1 AND status='Pending')::int AS members_pending,
       (SELECT COUNT(*) FROM dairy.animal WHERE coop_org_id=$1 AND status='Milking')::int AS milking,
       (SELECT COUNT(*) FROM dairy.animal WHERE coop_org_id=$1 AND status='Dry')::int AS dry,
       (SELECT COUNT(*) FROM dairy.animal WHERE coop_org_id=$1 AND pregnant AND status NOT IN ('Sold','Dead','Culled'))::int AS pregnant,
       (SELECT COUNT(*) FROM dairy.animal WHERE coop_org_id=$1 AND withdrawal_until >= $2 AND status='Milking')::int AS withdrawal,
       (SELECT COALESCE(SUM(i.weight_kg) FILTER (WHERE i.status='Accepted'),0) FROM dairy.milk_intake i JOIN dairy.milk_round r USING (round_id)
          WHERE r.coop_org_id=$1 AND r.round_date=$2)::numeric AS today_accepted_kg,
       (SELECT COALESCE(SUM(i.weight_kg) FILTER (WHERE i.status='Rejected'),0) FROM dairy.milk_intake i JOIN dairy.milk_round r USING (round_id)
          WHERE r.coop_org_id=$1 AND r.round_date=$2)::numeric AS today_rejected_kg,
       (SELECT COALESCE(SUM(sent_kg),0) FROM dairy.shipment WHERE coop_org_id=$1 AND ship_date=$2 AND status<>'Cancelled')::numeric AS today_shipped_kg,
       (SELECT COALESCE(SUM(milk_used_kg),0) FROM dairy.production_batch WHERE coop_org_id=$1 AND produced_on=$2)::numeric AS today_processed_kg,
       (SELECT COALESCE(SUM(daily_kg),0) FROM dairy.contract WHERE coop_org_id=$1 AND status='Active' AND $2 BETWEEN start_date AND end_date)::numeric AS contracted_kg_day,
       (SELECT COUNT(*) FROM dairy.milk_round WHERE coop_org_id=$1 AND status='Open')::int AS open_rounds,
       (SELECT COUNT(*) FROM dairy.service_request WHERE coop_org_id=$1 AND status IN ('Open','Assigned'))::int AS open_requests,
       (SELECT COUNT(*) FROM dairy.shipment WHERE coop_org_id=$1 AND status='Sent')::int AS shipments_pending,
       (SELECT COUNT(*) FROM dairy.surplus_proposal p JOIN dairy.surplus_offer o USING (offer_id)
          WHERE o.coop_org_id=$1 AND p.status='Pending' AND p.proposed_by='processor')::int AS proposals_waiting,
       (SELECT COUNT(*) FROM dairy.iot_alert a JOIN dairy.iot_device d USING (device_id) WHERE d.coop_org_id=$1 AND a.acknowledged_at IS NULL)::int AS open_alerts,
       (SELECT COUNT(*) FROM dairy.school_delivery WHERE coop_org_id=$1 AND delivery_date=$2 AND status='Planned')::int AS school_today,
       (SELECT COUNT(*) FROM dairy.production_batch WHERE coop_org_id=$1 AND units_left>0 AND expires_on <= $2::date + 3)::int AS expiring_batches,
       (SELECT COALESCE(SUM(amount),0) FROM dairy.member_ledger WHERE coop_org_id=$1 AND run_id IS NULL)::numeric AS unsettled_net`,
    [coop, today],
  )).rows;
  const f = await core.forecast(c, coop, 30);
  return {
    org_name: req.org.org_name, today, settings_incomplete: !(Number(s.base_price_per_kg) > 0),
    has_processing_plant: s.has_processing_plant, ...x, forecast30: f.windows[0] || null, recent_avg_kg_day: f.recent_avg_kg_day,
  };
})));

// ===========================================================================
// ตั้งค่า + ตารางคุณภาพ + ศูนย์รวบรวม
// ===========================================================================
const SETTING_FIELDS = {
  base_price_per_kg: { min: 0, max: 1000 }, settlement_days: { min: 1, max: 31, int: true },
  fee_rate_feed_pct: { min: 0, max: 100 }, fee_rate_raw_milk_pct: { min: 0, max: 100 }, fee_rate_surplus_pct: { min: 0, max: 100 },
  fee_rate_product_pct: { min: 0, max: 100 }, tank_temp_max: { min: -5, max: 30 }, alert_yellow_pct: { min: 0, max: 100 },
  alert_orange_pct: { min: 0, max: 100 }, alert_red_pct: { min: 0, max: 100 }, gestation_days: { min: 250, max: 310, int: true },
  dry_period_days: { min: 0, max: 120, int: true },
};
const SETTING_BOOLS = ['gov_data_consent', 'has_processing_plant'];

async function history(c, coop, field, oldV, newV, who) {
  await c.query('INSERT INTO dairy.setting_history (coop_org_id, field_name, old_value, new_value, changed_by) VALUES ($1,$2,$3,$4,$5)',
    [coop, field, oldV === null || oldV === undefined ? null : String(oldV), newV === null || newV === undefined ? null : String(newV), who]);
}

router.get('/settings', h(async (req) => db(req, async (c, coop) => ({
  settings: await core.settings(c, coop),
  quality_rules: (await c.query('SELECT * FROM dairy.quality_rule WHERE coop_org_id=$1 ORDER BY param, min_value NULLS FIRST', [coop])).rows,
  centers: (await c.query('SELECT * FROM dairy.collection_center WHERE coop_org_id=$1 ORDER BY created_at', [coop])).rows,
  history: (await c.query('SELECT * FROM dairy.setting_history WHERE coop_org_id=$1 ORDER BY changed_at DESC LIMIT 60', [coop])).rows,
}))));

router.put('/settings', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = req.body || {};
  const cur = (await c.query('SELECT * FROM dairy.setting WHERE coop_org_id=$1 FOR UPDATE', [coop])).rows[0];
  const changes = [];
  Object.entries(SETTING_FIELDS).forEach(([f, rule]) => {
    if (!(f in b)) return;
    const v = num(b[f], rule);
    if (v === null || Number.isNaN(v) || (rule.int && !Number.isInteger(v))) throw bad('invalid_field', { field: f });
    if (Number(cur[f]) !== v) changes.push([f, cur[f], v]);
  });
  SETTING_BOOLS.forEach((f) => { if (f in b && !!b[f] !== cur[f]) changes.push([f, cur[f], !!b[f]]); });
  if ('deduction_order' in b) {
    const order = Array.isArray(b.deduction_order) ? b.deduction_order : String(b.deduction_order).split(',').map((x) => x.trim());
    if (order.length !== DEBIT_TYPES.length || DEBIT_TYPES.some((t) => !order.includes(t))) throw bad('invalid_deduction_order', { valid: DEBIT_TYPES });
    if (order.join(',') !== cur.deduction_order.join(',')) changes.push(['deduction_order', cur.deduction_order.join(','), order]);
  }
  const next = { ...cur };
  changes.forEach(([f, , v]) => { next[f] = v; });
  if (!(Number(next.alert_yellow_pct) <= Number(next.alert_orange_pct) && Number(next.alert_orange_pct) <= Number(next.alert_red_pct))) throw bad('invalid_alert_thresholds');
  for (const [f, oldV, newV] of changes) {
    await c.query(`UPDATE dairy.setting SET ${f}=$2, updated_at=now() WHERE coop_org_id=$1`, [coop, newV]);
    await history(c, coop, f, Array.isArray(oldV) ? oldV.join(',') : oldV, Array.isArray(newV) ? newV.join(',') : newV, actor(req));
  }
  await logAccess(c, 'write', 'dairy.setting', coop);
  return { updated: changes.map((x) => x[0]), settings: await core.settings(c, coop) };
}))));

function ruleValues(b, partial) {
  const out = {};
  if (!partial || 'param' in b) {
    if (!['fat', 'snf', 'scc', 'tbc'].includes(b.param)) throw bad('invalid_field', { field: 'param' });
    out.param = b.param;
  }
  ['min_value', 'max_value'].forEach((f) => {
    if (!(f in b)) return;
    const v = num(b[f], { min: 0 });
    if (Number.isNaN(v)) throw bad('invalid_field', { field: f });
    out[f] = v;
  });
  if (!partial || 'adjust_per_kg' in b) {
    const v = num(b.adjust_per_kg, { min: -1000, max: 1000 });
    if (v === null || Number.isNaN(v)) throw bad('invalid_field', { field: 'adjust_per_kg' });
    out.adjust_per_kg = v;
  }
  if ('active' in b) out.active = !!b.active;
  if (out.min_value != null && out.max_value != null && out.min_value >= out.max_value) throw bad('invalid_range');
  return out;
}
const ruleLabel = (r) => `quality:${r.param}[${r.min_value ?? ''},${r.max_value ?? ''})`;

router.post('/quality-rules', h(async (req) => db(req, async (c, coop) => {
  const r = await insertRow(c, 'dairy.quality_rule', { coop_org_id: coop, ...ruleValues(req.body || {}, false) });
  await history(c, coop, ruleLabel(r), null, r.adjust_per_kg, actor(req));
  return r;
})));

router.put('/quality-rules/:id', h(async (req) => db(req, async (c, coop) => {
  const old = await own(c, coop, 'rule', req.params.id);
  const r = await updateRow(c, 'dairy.quality_rule', 'rule_id', old.rule_id, ruleValues(req.body || {}, true));
  if (Number(old.adjust_per_kg) !== Number(r.adjust_per_kg) || old.active !== r.active) {
    await history(c, coop, ruleLabel(r), `${old.adjust_per_kg}${old.active ? '' : ' (ปิด)'}`, `${r.adjust_per_kg}${r.active ? '' : ' (ปิด)'}`, actor(req));
  }
  return r;
})));

router.get('/centers', h(async (req) => db(req, async (c, coop) => (await c.query(
  `SELECT cc.*, (SELECT COUNT(*) FROM dairy.member m WHERE m.center_id=cc.center_id)::int AS members
     FROM dairy.collection_center cc WHERE cc.coop_org_id=$1 ORDER BY cc.created_at`, [coop],
)).rows)));

const CENTER_SPEC = { name: 'text', address: 'text', tank_capacity_kg: 'num', active: 'bool' };
router.post('/centers', h(async (req) => db(req, async (c, coop) => {
  const v = pick(req.body || {}, CENTER_SPEC);
  if (!v.name) throw bad('missing_name');
  return insertRow(c, 'dairy.collection_center', { coop_org_id: coop, ...v }).catch(uniq('center_exists'));
})));
router.put('/centers/:id', h(async (req) => db(req, async (c, coop) => {
  const cc = await own(c, coop, 'center', req.params.id);
  const v = pick(req.body || {}, CENTER_SPEC);
  if ('name' in v && !v.name) throw bad('missing_name');
  return updateRow(c, 'dairy.collection_center', 'center_id', cc.center_id, v).catch(uniq('center_exists'));
})));

// ===========================================================================
// (1) สมาชิกและฟาร์ม
// ===========================================================================
router.get('/farmers/lookup', h(async (req) => db(req, async (c) => {
  const phone = String(req.query.phone || '').replace(/\D/g, '');
  if (phone.length < 9) throw bad('invalid_phone');
  return (await c.query(
    `SELECT farmer_id, full_name, phone, farmer_code FROM identity.farmer WHERE regexp_replace(phone, '\\D', '', 'g') = $1 LIMIT 5`, [phone],
  )).rows;
})));

const MEMBER_SPEC = {
  full_name: 'text', phone: 'text', address: 'text', farm_name: 'text', farm_registration_no: 'text', gap_certified: 'bool',
  distance_km: 'numnull', credit_limit: 'numnull', share_deduct_per_round: 'num', baac_account_no: 'text', baac_account_name: 'text', note: 'text',
};
async function memberValues(c, coop, b) {
  const v = pick(b, MEMBER_SPEC);
  if (v.baac_account_no) {
    v.baac_account_no = v.baac_account_no.replace(/[\s-]/g, '');
    if (!/^\d{10,15}$/.test(v.baac_account_no)) throw bad('invalid_baac_account_no');
  }
  if ('center_id' in b) v.center_id = b.center_id ? (await own(c, coop, 'center', b.center_id)).center_id : null;
  return v;
}

router.get('/members', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(
    `SELECT m.*, cc.name AS center_name,
            (SELECT COUNT(*) FROM dairy.animal a WHERE a.member_id=m.member_id AND a.status='Milking')::int AS milking,
            (SELECT COUNT(*) FROM dairy.animal a WHERE a.member_id=m.member_id AND a.status NOT IN ('Sold','Dead','Culled'))::int AS herd,
            (SELECT COALESCE(SUM(i.weight_kg),0) FROM dairy.milk_intake i JOIN dairy.milk_round r USING (round_id)
              WHERE i.member_id=m.member_id AND i.status='Accepted' AND r.round_date >= $2::date - 14)::numeric / 14 AS avg_kg_day_14,
            (SELECT row_to_json(q) FROM (SELECT sample_date, fat_pct, snf_pct, scc_k, tbc_k FROM dairy.quality_test t
              WHERE t.member_id=m.member_id ORDER BY sample_date DESC, created_at DESC LIMIT 1) q) AS last_test,
            (SELECT COALESCE(SUM(amount),0) FROM dairy.member_ledger l WHERE l.member_id=m.member_id AND l.run_id IS NULL)::numeric AS unsettled_net
       FROM dairy.member m LEFT JOIN dairy.collection_center cc ON cc.center_id=m.center_id
      WHERE m.coop_org_id=$1 ORDER BY m.status, m.member_code`,
    [coop, bkkToday()],
  );
  await logAccess(c, 'read', 'dairy.member', coop);
  return r.rows.map((m) => ({ ...m, avg_kg_day_14: round2(m.avg_kg_day_14) }));
})));

router.post('/members', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = req.body || {};
  const v = await memberValues(c, coop, b);
  let farmerId = null;
  if (b.farmer_id) {
    farmerId = needUuid(b.farmer_id, 'farmer_id');
    const f = (await c.query('SELECT full_name, phone FROM identity.farmer WHERE farmer_id=$1', [farmerId])).rows[0];
    if (!f) throw notFound('farmer_not_found');
    v.full_name = v.full_name || f.full_name;
    v.phone = v.phone || f.phone;
  }
  if (!v.full_name) throw bad('missing_full_name');
  if (!('center_id' in v)) v.center_id = (await c.query('SELECT center_id FROM dairy.collection_center WHERE coop_org_id=$1 AND active ORDER BY created_at LIMIT 1', [coop])).rows[0]?.center_id || null;
  const n = (await c.query('SELECT COUNT(*)::int AS n FROM dairy.member WHERE coop_org_id=$1', [coop])).rows[0].n;
  const code = txt(b.member_code) || `D${String(n + 1).padStart(4, '0')}`;
  const r = await insertRow(c, 'dairy.member', { coop_org_id: coop, farmer_id: farmerId, member_code: code, ...v }).catch(uniq('member_exists'));
  await logAccess(c, 'write', 'dairy.member', r.member_id);
  return r;
}))));

router.put('/members/:id', h(async (req) => db(req, async (c, coop) => {
  const m = await own(c, coop, 'member', req.params.id);
  const v = await memberValues(c, coop, req.body || {});
  if ('full_name' in v && !v.full_name) throw bad('missing_full_name');
  await logAccess(c, 'write', 'dairy.member', m.member_id);
  return updateRow(c, 'dairy.member', 'member_id', m.member_id, v);
})));

router.post('/members/:id/status', h(async (req) => db(req, async (c, coop) => {
  const m = await own(c, coop, 'member', req.params.id);
  const status = (req.body || {}).status;
  if (!['Approved', 'Suspended', 'Pending'].includes(status)) throw bad('invalid_status');
  if (status === 'Approved' && !m.center_id) throw bad('member_needs_center');
  return (await c.query(
    `UPDATE dairy.member SET status=$2, approved_at = CASE WHEN $2='Approved' THEN now() ELSE approved_at END WHERE member_id=$1 RETURNING *`,
    [m.member_id, status],
  )).rows[0];
})));

// ===========================================================================
// คู่ค้า
// ===========================================================================
router.get('/partners', h(async (req) => db(req, async (c, coop) => {
  const params = [coop];
  let f = '';
  if (req.query.type) {
    if (!PARTNER_TYPES.includes(req.query.type)) throw bad('invalid_type');
    params.push(req.query.type); f = 'AND p.partner_type=$2';
  }
  return (await c.query(
    `SELECT p.*, o.org_name AS linked_org_name FROM dairy.partner p LEFT JOIN identity.organization o ON o.org_id=p.linked_org_id
      WHERE p.coop_org_id=$1 ${f} ORDER BY p.partner_type, p.name`, params,
  )).rows;
})));

router.get('/linkable-orgs', h(async (req) => db(req, async (c) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) throw bad('query_too_short');
  return (await c.query(
    `SELECT org_id, org_name, org_type FROM identity.organization WHERE kyb_status='Verified' AND org_name ILIKE $1 ORDER BY org_name LIMIT 20`, [`%${q}%`],
  )).rows;
})));

async function partnerValues(c, b, partial) {
  const out = pick(b, { name: 'text', contact_name: 'text', phone: 'text', address: 'text', note: 'text', active: 'bool' });
  if (!partial || 'partner_type' in b) {
    if (!PARTNER_TYPES.includes(b.partner_type)) throw bad('invalid_partner_type');
    out.partner_type = b.partner_type;
  }
  if ((!partial || 'name' in b) && !out.name) throw bad('missing_name');
  if ('linked_org_id' in b) {
    if (b.linked_org_id) {
      const id = needUuid(b.linked_org_id, 'linked_org_id');
      if (!(await c.query(`SELECT 1 FROM identity.organization WHERE org_id=$1 AND kyb_status='Verified'`, [id])).rows.length) throw notFound('linked_org_not_found');
      out.linked_org_id = id;
    } else out.linked_org_id = null;
  }
  return out;
}
router.post('/partners', h(async (req) => db(req, async (c, coop) => insertRow(c, 'dairy.partner', { coop_org_id: coop, ...(await partnerValues(c, req.body || {}, false)) }))));
router.put('/partners/:id', h(async (req) => db(req, async (c, coop) => {
  const p = await own(c, coop, 'partner', req.params.id);
  return updateRow(c, 'dairy.partner', 'partner_id', p.partner_id, await partnerValues(c, req.body || {}, true));
})));

async function ownPartner(c, coop, id, type) {
  const p = await own(c, coop, 'partner', id);
  if (type && p.partner_type !== type) throw bad('partner_type_mismatch', { expected: type });
  if (!p.active) throw conflict('partner_inactive');
  return p;
}

// ===========================================================================
// (2) ฝูงโค สืบพันธุ์ สุขภาพ
// ===========================================================================
router.get('/animals', h(async (req) => db(req, async (c, coop) => {
  const params = [coop];
  let f = '';
  if (req.query.member_id) { params.push(needUuid(req.query.member_id, 'member_id')); f += ` AND a.member_id=$${params.length}`; }
  if (req.query.status) {
    if (!ANIMAL_STATUS.includes(req.query.status)) throw bad('invalid_status');
    params.push(req.query.status); f += ` AND a.status=$${params.length}`;
  } else if (req.query.all !== '1') f += ` AND a.status NOT IN ('Sold','Dead','Culled')`;
  if (req.query.q) { params.push(`%${String(req.query.q).trim()}%`); f += ` AND (a.ear_tag ILIKE $${params.length} OR a.name ILIKE $${params.length})`; }
  return (await c.query(
    `SELECT a.*, m.full_name AS member_name, m.member_code FROM dairy.animal a JOIN dairy.member m ON m.member_id=a.member_id
      WHERE a.coop_org_id=$1 ${f} ORDER BY m.member_code, a.ear_tag LIMIT 1000`, params,
  )).rows;
})));

const ANIMAL_SPEC = { ear_tag: 'text', name: 'text', breed: 'text', birth_date: 'date', dam_ear_tag: 'text', sire_code: 'text', lactation_no: 'int', last_calving_date: 'date' };
function animalValues(b) {
  const v = pick(b, ANIMAL_SPEC);
  if ('sex' in b) { if (!['F', 'M'].includes(b.sex)) throw bad('invalid_field', { field: 'sex' }); v.sex = b.sex; }
  if ('status' in b) {
    if (!['Calf', 'Heifer', 'Milking', 'Dry', 'Bull'].includes(b.status)) throw bad('invalid_field', { field: 'status' });
    v.status = b.status;
  }
  return v;
}

router.post('/animals', h(async (req) => db(req, async (c, coop) => {
  const b = req.body || {};
  const m = await own(c, coop, 'member', b.member_id);
  const v = animalValues(b);
  if (!v.ear_tag) throw bad('missing_ear_tag');
  if (v.sex === 'M' && !v.status) v.status = 'Bull';
  return insertRow(c, 'dairy.animal', { coop_org_id: coop, member_id: m.member_id, ...v }).catch(uniq('ear_tag_exists'));
})));

router.put('/animals/:id', h(async (req) => db(req, async (c, coop) => {
  const a = await own(c, coop, 'animal', req.params.id);
  const b = req.body || {};
  const v = animalValues(b);
  if ('ear_tag' in v && !v.ear_tag) throw bad('missing_ear_tag');
  if (b.member_id && b.member_id !== a.member_id) v.member_id = (await own(c, coop, 'member', b.member_id)).member_id;
  return updateRow(c, 'dairy.animal', 'animal_id', a.animal_id, v).catch(uniq('ear_tag_exists'));
})));

router.get('/animals/:id', h(async (req) => db(req, async (c, coop) => {
  const a = await own(c, coop, 'animal', req.params.id);
  const events = (await c.query(
    `SELECT e.*, p.name AS vet_name FROM dairy.animal_event e LEFT JOIN dairy.partner p ON p.partner_id=e.vet_partner_id
      WHERE e.animal_id=$1 ORDER BY e.event_date DESC, e.created_at DESC`, [a.animal_id],
  )).rows;
  return { ...a, events };
})));

router.post('/animals/:id/events', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const a = await own(c, coop, 'animal', req.params.id, { lock: true });
  const b = req.body || {};
  if (!EVENT_TYPES.includes(b.event_type)) throw bad('invalid_event_type');
  const date = b.event_date || bkkToday();
  if (!isDate(date) || date > bkkToday()) throw bad('invalid_field', { field: 'event_date' });
  const cost = b.cost ? needNonNeg(b.cost, 'cost') : 0;
  let vet = null;
  if (b.vet_partner_id) vet = (await ownPartner(c, coop, b.vet_partner_id, 'vet')).partner_id;
  let requestId = null;
  if (b.request_id) {
    const rq = await own(c, coop, 'request', b.request_id);
    if (rq.member_id !== a.member_id) throw bad('request_member_mismatch');
    requestId = rq.request_id;
  }
  return core.applyEvent(c, coop, a, b.event_type, date, b.details || {}, {
    cost, vet_partner_id: vet, charge_member: b.charge_member !== false, recorded_by: actor(req), request_id: requestId,
  });
}))));

/** ปฏิทินงานฝูง: ใกล้คลอด ถึงกำหนดหยุดรีด ควรตรวจท้อง คาดว่าเป็นสัด อยู่ในระยะหยุดยา */
router.get('/herd/calendar', h(async (req) => db(req, async (c, coop) => {
  const today = bkkToday();
  const q = (where, order) => c.query(
    `SELECT a.animal_id, a.ear_tag, a.name, a.status, a.expected_calving_date, a.dry_off_due_date, a.last_insemination_date, a.withdrawal_until,
            m.full_name AS member_name, m.member_code,
            (SELECT MAX(event_date) FROM dairy.animal_event e WHERE e.animal_id=a.animal_id AND e.event_type IN ('heat','insemination')) AS last_heat
       FROM dairy.animal a JOIN dairy.member m ON m.member_id=a.member_id
      WHERE a.coop_org_id=$1 AND a.status NOT IN ('Sold','Dead','Culled') AND ${where} ORDER BY ${order} LIMIT 300`,
    [coop, today],
  ).then((r) => r.rows);
  return {
    calving_soon: await q(`a.pregnant AND a.expected_calving_date <= $2::date + 30`, 'a.expected_calving_date'),
    dry_off_due: await q(`a.status='Milking' AND a.dry_off_due_date <= $2::date + 14`, 'a.dry_off_due_date'),
    pregnancy_check_due: await q(`a.sex='F' AND NOT a.pregnant AND a.last_insemination_date BETWEEN $2::date - 90 AND $2::date - 35
      AND NOT EXISTS (SELECT 1 FROM dairy.animal_event e WHERE e.animal_id=a.animal_id AND e.event_type='pregnancy_check' AND e.event_date >= a.last_insemination_date)`, 'a.last_insemination_date'),
    heat_expected: await q(`a.sex='F' AND NOT a.pregnant AND a.status IN ('Milking','Heifer','Dry')
      AND EXISTS (SELECT 1 FROM dairy.animal_event e WHERE e.animal_id=a.animal_id AND e.event_type IN ('heat','insemination')
        AND ((($2::date - e.event_date) % 21) BETWEEN 18 AND 20) AND e.event_date = (SELECT MAX(event_date) FROM dairy.animal_event x WHERE x.animal_id=a.animal_id AND x.event_type IN ('heat','insemination')))`, 'a.ear_tag'),
    withdrawal: await q(`a.withdrawal_until >= $2`, 'a.withdrawal_until'),
  };
})));

// ===========================================================================
// (3) รับน้ำนม (รอบเช้า/เย็น)
// ===========================================================================
router.get('/rounds', h(async (req) => db(req, async (c, coop) => {
  const date = isDate(req.query.date) ? req.query.date : null;
  const params = [coop];
  let f = '';
  if (date) { params.push(date); f = 'AND r.round_date=$2'; }
  return (await c.query(
    `SELECT r.*, cc.name AS center_name, (SELECT COUNT(*) FROM dairy.milk_intake i WHERE i.round_id=r.round_id)::int AS intakes,
            (SELECT COALESCE(SUM(weight_kg),0) FROM dairy.milk_intake i WHERE i.round_id=r.round_id AND i.status='Accepted')::numeric AS live_accepted_kg
       FROM dairy.milk_round r JOIN dairy.collection_center cc ON cc.center_id=r.center_id
      WHERE r.coop_org_id=$1 ${f} ORDER BY r.round_date DESC, r.shift DESC, cc.name LIMIT 120`, params,
  )).rows;
})));

router.post('/rounds', h(async (req) => db(req, async (c, coop) => {
  const b = req.body || {};
  const center = await own(c, coop, 'center', b.center_id);
  const date = b.round_date || bkkToday();
  if (!isDate(date) || date > bkkToday()) throw bad('invalid_field', { field: 'round_date' });
  if (!['AM', 'PM'].includes(b.shift)) throw bad('invalid_field', { field: 'shift' });
  const ex = (await c.query('SELECT * FROM dairy.milk_round WHERE center_id=$1 AND round_date=$2 AND shift=$3', [center.center_id, date, b.shift])).rows[0];
  if (ex) return { ...ex, existing: true };
  return insertRow(c, 'dairy.milk_round', { coop_org_id: coop, center_id: center.center_id, round_date: date, shift: b.shift });
})));

router.get('/rounds/:id', h(async (req) => db(req, async (c, coop) => {
  const r = await own(c, coop, 'round', req.params.id);
  const day = dstr(r.round_date);
  const intakes = (await c.query(
    `SELECT i.*, m.member_code, m.full_name FROM dairy.milk_intake i JOIN dairy.member m ON m.member_id=i.member_id
      WHERE i.round_id=$1 ORDER BY m.member_code`, [r.round_id],
  )).rows;
  const pending = (await c.query(
    `SELECT m.member_id, m.member_code, m.full_name,
            (SELECT COUNT(*) FROM dairy.animal a WHERE a.member_id=m.member_id AND a.status='Milking' AND a.withdrawal_until >= $3)::int AS withdrawal_cows
       FROM dairy.member m WHERE m.coop_org_id=$1 AND m.center_id=$2 AND m.status='Approved'
        AND NOT EXISTS (SELECT 1 FROM dairy.milk_intake i WHERE i.round_id=$4 AND i.member_id=m.member_id) ORDER BY m.member_code`,
    [coop, r.center_id, day, r.round_id],
  )).rows;
  return { ...r, round_date: day, intakes, pending };
})));

router.post('/rounds/:id/intakes', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const r = await own(c, coop, 'round', req.params.id, { lock: true });
  if (r.status !== 'Open') throw conflict('round_closed');
  const b = req.body || {};
  let m;
  if (b.member_code) {
    m = (await c.query('SELECT * FROM dairy.member WHERE coop_org_id=$1 AND member_code=$2', [coop, String(b.member_code).trim()])).rows[0];
    if (!m) throw notFound('member_not_found');
  } else m = await own(c, coop, 'member', b.member_id);
  if (m.status !== 'Approved') throw conflict('member_not_approved');
  const kg = needPos(b.weight_kg, 'weight_kg');
  const status = b.status === 'Rejected' ? 'Rejected' : 'Accepted';
  let reason = null;
  if (status === 'Rejected') {
    if (!REJECT_REASONS.includes(b.reject_reason)) throw bad('invalid_field', { field: 'reject_reason' });
    reason = b.reject_reason;
  } else {
    const w = (await c.query(
      `SELECT ear_tag FROM dairy.animal WHERE member_id=$1 AND status='Milking' AND withdrawal_until >= $2`, [m.member_id, dstr(r.round_date)],
    )).rows;
    if (w.length && b.confirm_withdrawal !== true) {
      throw conflict('member_has_withdrawal_animals', { ear_tags: w.map((x) => x.ear_tag), detail: 'มีโคอยู่ในระยะหยุดยา — ยืนยันว่าไม่ได้ปนน้ำนมจากโคตัวนั้น' });
    }
  }
  const row = (await c.query(
    `INSERT INTO dairy.milk_intake (coop_org_id, round_id, member_id, weight_kg, status, reject_reason, sample_no, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (round_id, member_id) DO UPDATE SET weight_kg=EXCLUDED.weight_kg, status=EXCLUDED.status, reject_reason=EXCLUDED.reject_reason,
        sample_no=COALESCE(EXCLUDED.sample_no, dairy.milk_intake.sample_no), recorded_by=EXCLUDED.recorded_by, recorded_at=now()
     RETURNING *`,
    [coop, r.round_id, m.member_id, kg, status, reason, txt(b.sample_no), actor(req)],
  )).rows[0];
  return { ...row, member_code: m.member_code, full_name: m.full_name };
}))));

router.delete('/rounds/:id/intakes/:intakeId', h(async (req) => db(req, async (c, coop) => {
  const r = await own(c, coop, 'round', req.params.id);
  if (r.status !== 'Open') throw conflict('round_closed');
  if (!isUuid(req.params.intakeId)) throw notFound('intake_not_found');
  const d = await c.query('DELETE FROM dairy.milk_intake WHERE intake_id=$1 AND round_id=$2 RETURNING intake_id', [req.params.intakeId, r.round_id]);
  if (!d.rows.length) throw notFound('intake_not_found');
  return { deleted: true };
})));

router.post('/rounds/:id/close', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const r = await own(c, coop, 'round', req.params.id, { lock: true });
  if (r.status !== 'Open') throw conflict('round_closed');
  const b = req.body || {};
  const temp = num(b.tank_temp_c, { min: -10, max: 50 });
  if (Number.isNaN(temp)) throw bad('invalid_field', { field: 'tank_temp_c' });
  const res = await core.priceRound(c, coop, r);
  const s = await core.settings(c, coop);
  const row = (await c.query(
    `UPDATE dairy.milk_round SET status='Closed', closed_at=now(), tank_temp_c=$2, accepted_kg=$3, rejected_kg=$4, amount=$5 WHERE round_id=$1 RETURNING *`,
    [r.round_id, temp, res.accepted_kg, res.rejected_kg, res.amount],
  )).rows[0];
  await logAccess(c, 'write', 'dairy.milk_round', r.round_id);
  return { ...row, warning: temp !== null && temp > Number(s.tank_temp_max) ? 'tank_temp_high' : null };
}))));

// ===========================================================================
// (4) คุณภาพ
// ===========================================================================
const TEST_SPEC = { fat_pct: 'numnull', snf_pct: 'numnull', protein_pct: 'numnull', scc_k: 'numnull', tbc_k: 'numnull', antibiotic_pos: 'bool', lab_name: 'text' };
router.get('/quality-tests', h(async (req) => db(req, async (c, coop) => {
  const params = [coop];
  let f = '';
  if (req.query.member_id) { params.push(needUuid(req.query.member_id, 'member_id')); f = 'AND t.member_id=$2'; }
  return (await c.query(
    `SELECT t.*, m.member_code, m.full_name FROM dairy.quality_test t JOIN dairy.member m ON m.member_id=t.member_id
      WHERE t.coop_org_id=$1 ${f} ORDER BY t.sample_date DESC, t.created_at DESC LIMIT 500`, params,
  )).rows;
})));

/** บันทึกผลตรวจ: ทีละรายการ หรือ { tests: [...] } (นำเข้าจากผลแล็บ ใช้ member_code ได้) */
router.post('/quality-tests', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = req.body || {};
  const list = Array.isArray(b.tests) ? b.tests : [b];
  if (!list.length || list.length > 1000) throw bad('invalid_tests_count');
  const out = [];
  for (const t of list) {
    let m;
    if (t.member_code) {
      m = (await c.query('SELECT member_id FROM dairy.member WHERE coop_org_id=$1 AND member_code=$2', [coop, String(t.member_code).trim()])).rows[0];
      if (!m) throw notFound('member_not_found');
    } else m = await own(c, coop, 'member', t.member_id);
    const date = t.sample_date || bkkToday();
    if (!isDate(date)) throw bad('invalid_field', { field: 'sample_date' });
    const v = pick(t, TEST_SPEC);
    if (['fat_pct', 'snf_pct', 'scc_k', 'tbc_k'].every((k) => v[k] === null || v[k] === undefined)) throw bad('empty_test');
    out.push(await insertRow(c, 'dairy.quality_test', { coop_org_id: coop, member_id: m.member_id, sample_date: date, ...v }));
  }
  return { saved: out.length, tests: out };
}))));

/** ผลล่าสุดของสมาชิกแต่ละรายพร้อมราคาที่จะได้ (ราคาฐาน ± ตาราง) */
router.get('/quality/summary', h(async (req) => db(req, async (c, coop) => {
  const s = await core.settings(c, coop);
  const rules = (await c.query('SELECT * FROM dairy.quality_rule WHERE coop_org_id=$1 AND active', [coop])).rows;
  const rows = (await c.query(
    `SELECT m.member_id, m.member_code, m.full_name, t.sample_date::text AS sample_date, t.fat_pct, t.snf_pct, t.scc_k, t.tbc_k, t.antibiotic_pos
       FROM dairy.member m LEFT JOIN LATERAL (SELECT * FROM dairy.quality_test x WHERE x.member_id=m.member_id ORDER BY sample_date DESC, created_at DESC LIMIT 1) t ON true
      WHERE m.coop_org_id=$1 AND m.status='Approved' ORDER BY m.member_code`, [coop],
  )).rows;
  return {
    base_price_per_kg: s.base_price_per_kg,
    members: rows.map((r) => ({ ...r, ...priceFor(s.base_price_per_kg, r.sample_date ? r : null, rules) })),
  };
})));

// ===========================================================================
// (5) อาหารสัตว์และปัจจัยการผลิต
// ===========================================================================
const STOCK_SQL = `
  SELECT i.*, COALESCE(SUM(CASE WHEN s.direction='in' THEN s.qty ELSE -s.qty END),0)::numeric(14,2) AS stock,
         COALESCE(ROUND(SUM(s.qty*s.unit_cost) FILTER (WHERE s.direction='in' AND s.unit_cost>0)
           / NULLIF(SUM(s.qty) FILTER (WHERE s.direction='in' AND s.unit_cost>0),0), 2), 0)::numeric(12,2) AS avg_cost
    FROM dairy.supply_item i LEFT JOIN dairy.stock_movement s ON s.item_id=i.item_id
   WHERE i.coop_org_id=$1`;
async function stockOf(c, itemId) {
  return Number((await c.query(`SELECT COALESCE(SUM(CASE WHEN direction='in' THEN qty ELSE -qty END),0) AS q FROM dairy.stock_movement WHERE item_id=$1`, [itemId])).rows[0].q);
}

router.get('/items', h(async (req) => db(req, async (c, coop) => (await c.query(`${STOCK_SQL} GROUP BY i.item_id ORDER BY i.category, i.name`, [coop])).rows)));

const ITEM_SPEC = { code: 'text', name: 'text', unit: 'text', sell_price: 'num', reorder_level: 'num', active: 'bool' };
const ITEM_CATS = ['concentrate', 'roughage', 'mineral', 'medicine', 'semen', 'other'];
function itemValues(b, partial) {
  const v = pick(b, ITEM_SPEC);
  if (!partial || 'category' in b) { if (!ITEM_CATS.includes(b.category)) throw bad('invalid_field', { field: 'category' }); v.category = b.category; }
  if ((!partial || 'name' in b) && !v.name) throw bad('missing_name');
  if (!partial && !v.code) v.code = `item${Date.now().toString(36)}`;
  return v;
}
router.post('/items', h(async (req) => db(req, async (c, coop) => insertRow(c, 'dairy.supply_item', { coop_org_id: coop, ...itemValues(req.body || {}, false) }).catch(uniq('item_exists')))));
router.put('/items/:id', h(async (req) => db(req, async (c, coop) => {
  const it = await own(c, coop, 'item', req.params.id);
  const v = itemValues(req.body || {}, true);
  if ('sell_price' in v && Number(v.sell_price) !== Number(it.sell_price)) await history(c, coop, `item:${it.name}:sell_price`, it.sell_price, v.sell_price, actor(req));
  return updateRow(c, 'dairy.supply_item', 'item_id', it.item_id, v).catch(uniq('item_exists'));
})));
router.post('/items/:id/adjust', h(async (req) => db(req, async (c, coop) => {
  const it = await own(c, coop, 'item', req.params.id);
  const b = req.body || {};
  const qty = num(b.qty);
  if (qty === null || Number.isNaN(qty) || qty === 0) throw bad('invalid_field', { field: 'qty' });
  const note = txt(b.note);
  if (!note) throw bad('missing_note');
  if (qty < 0 && (await stockOf(c, it.item_id)) < -qty) throw conflict('insufficient_stock');
  await c.query(`INSERT INTO dairy.stock_movement (coop_org_id, item_id, direction, qty, unit_cost, source_type, note) VALUES ($1,$2,$3,$4,$5,'adjust',$6)`,
    [coop, it.item_id, qty > 0 ? 'in' : 'out', Math.abs(qty), qty > 0 ? (num(b.unit_cost, { min: 0 }) || 0) : 0, `${note} (โดย ${actor(req)})`]);
  return { stock: await stockOf(c, it.item_id) };
})));

router.get('/purchase-orders', h(async (req) => db(req, async (c, coop) => (await c.query(
  `SELECT po.*, p.name AS partner_name,
          COALESCE(json_agg(json_build_object('item_id', l.item_id, 'name', i.name, 'unit', i.unit, 'qty', l.qty, 'unit_price', l.unit_price, 'amount', l.amount))
            FILTER (WHERE l.line_id IS NOT NULL), '[]') AS lines
     FROM dairy.purchase_order po JOIN dairy.partner p ON p.partner_id=po.partner_id
     LEFT JOIN dairy.purchase_order_line l ON l.po_id=po.po_id LEFT JOIN dairy.supply_item i ON i.item_id=l.item_id
    WHERE po.coop_org_id=$1 GROUP BY po.po_id, p.name ORDER BY po.ordered_at DESC LIMIT 200`, [coop],
)).rows)));

router.post('/purchase-orders', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = req.body || {};
  const p = await ownPartner(c, coop, b.partner_id, 'feed_supplier');
  const lines = Array.isArray(b.lines) ? b.lines : [];
  if (!lines.length) throw bad('missing_lines');
  if (b.expected_date && !isDate(b.expected_date)) throw bad('invalid_field', { field: 'expected_date' });
  const po = await insertRow(c, 'dairy.purchase_order', { coop_org_id: coop, partner_id: p.partner_id, expected_date: b.expected_date || null, note: txt(b.note) });
  let total = 0;
  for (const l of lines) {
    const it = await own(c, coop, 'item', l.item_id);
    const qty = needPos(l.qty, 'qty');
    const price = needNonNeg(l.unit_price, 'unit_price');
    const amount = round2(qty * price);
    total += amount;
    await c.query('INSERT INTO dairy.purchase_order_line (po_id, item_id, qty, unit_price, amount) VALUES ($1,$2,$3,$4,$5)', [po.po_id, it.item_id, qty, price, amount]);
  }
  return updateRow(c, 'dairy.purchase_order', 'po_id', po.po_id, { total_amount: round2(total) });
}))));

router.post('/purchase-orders/:id/deliver', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const po = await own(c, coop, 'po', req.params.id, { lock: true });
  if (!['Ordered', 'Confirmed'].includes(po.status)) throw conflict('invalid_po_status', { status: po.status });
  const lines = (await c.query('SELECT * FROM dairy.purchase_order_line WHERE po_id=$1', [po.po_id])).rows;
  for (const l of lines) {
    await c.query(`INSERT INTO dairy.stock_movement (coop_org_id, item_id, direction, qty, unit_cost, source_type, ref_id) VALUES ($1,$2,'in',$3,$4,'purchase',$5)`,
      [coop, l.item_id, l.qty, l.unit_price, po.po_id]);
  }
  const s = await core.settings(c, coop);
  const rate = Number(s.fee_rate_feed_pct);
  const fee = await core.addPlatformFee(c, coop, 'feed_purchase', 'partner', po.partner_id, po.total_amount, rate, 'purchase_order', po.po_id);
  return updateRow(c, 'dairy.purchase_order', 'po_id', po.po_id, { status: 'Delivered', delivered_at: new Date(), fee_rate_pct: rate, fee_amount: fee });
}))));
router.post('/purchase-orders/:id/cancel', h(async (req) => db(req, async (c, coop) => {
  const po = await own(c, coop, 'po', req.params.id);
  if (!['Ordered', 'Confirmed'].includes(po.status)) throw conflict('invalid_po_status', { status: po.status });
  return updateRow(c, 'dairy.purchase_order', 'po_id', po.po_id, { status: 'Cancelled' });
})));
router.post('/purchase-orders/:id/paid', h(async (req) => db(req, async (c, coop) => {
  const po = await own(c, coop, 'po', req.params.id);
  if (po.status !== 'Delivered') throw conflict('invalid_po_status', { status: po.status });
  return updateRow(c, 'dairy.purchase_order', 'po_id', po.po_id, { paid_at: new Date() });
})));

/** สมาชิกเบิกอาหาร/ปัจจัย (เชื่อ หักจากค่านมรอบถัดไป) — ตรวจสต็อกและวงเงิน */
async function issueToMember(c, coop, b, who) {
  const m = await own(c, coop, 'member', b.member_id);
  if (m.status !== 'Approved') throw conflict('member_not_approved');
  const it = await own(c, coop, 'item', b.item_id);
  const qty = needPos(b.qty, 'qty');
  const price = b.unit_price !== undefined && b.unit_price !== '' ? needNonNeg(b.unit_price, 'unit_price') : Number(it.sell_price);
  if (!(price > 0)) throw conflict('item_price_not_set');
  const amount = round2(qty * price);
  const stock = await stockOf(c, it.item_id);
  if (stock < qty) throw conflict('insufficient_stock', { available: stock, needed: qty });
  if (m.credit_limit !== null) {
    const bal = await core.openBalance(c, m.member_id);
    if (bal - amount < -Number(m.credit_limit)) throw conflict('over_credit_limit', { balance: bal, credit_limit: Number(m.credit_limit) });
  }
  const iss = await insertRow(c, 'dairy.member_issue', {
    coop_org_id: coop, member_id: m.member_id, item_id: it.item_id, qty, unit_price: price, amount, request_id: b.request_id || null,
  });
  await c.query(`INSERT INTO dairy.stock_movement (coop_org_id, item_id, direction, qty, unit_cost, source_type, ref_id) VALUES ($1,$2,'out',$3,0,'member_issue',$4)`,
    [coop, it.item_id, qty, iss.issue_id]);
  await core.addLedger(c, coop, m.member_id, 'feed', -amount, 'member_issue', iss.issue_id, `${it.name} ${qty} ${it.unit} × ${price} (${who})`);
  return { ...iss, item_name: it.name, member_name: m.full_name };
}
router.post('/issues', h(async (req) => db(req, async (c, coop) => tx(c, async () => issueToMember(c, coop, req.body || {}, actor(req))))));
router.get('/issues', h(async (req) => db(req, async (c, coop) => (await c.query(
  `SELECT x.*, m.member_code, m.full_name, i.name AS item_name, i.unit FROM dairy.member_issue x JOIN dairy.member m ON m.member_id=x.member_id
     JOIN dairy.supply_item i ON i.item_id=x.item_id WHERE x.coop_org_id=$1 ORDER BY x.issued_at DESC LIMIT 300`, [coop],
)).rows)));

// ---- คำขอจากสมาชิก (เบิกอาหาร / สัตวแพทย์ / ผสมเทียม) ----
router.get('/requests', h(async (req) => db(req, async (c, coop) => {
  const params = [coop];
  let f = '';
  if (req.query.status) { params.push(req.query.status); f = 'AND r.status=$2'; }
  return (await c.query(
    `SELECT r.request_id, r.request_type, r.status, r.description, r.qty, r.created_at, r.done_at, r.animal_id, r.item_id, r.assigned_partner_id,
            (r.photo_data_url IS NOT NULL) AS has_photo, m.member_id, m.member_code, m.full_name, a.ear_tag, i.name AS item_name, i.unit, p.name AS partner_name
       FROM dairy.service_request r JOIN dairy.member m ON m.member_id=r.member_id
       LEFT JOIN dairy.animal a ON a.animal_id=r.animal_id LEFT JOIN dairy.supply_item i ON i.item_id=r.item_id
       LEFT JOIN dairy.partner p ON p.partner_id=r.assigned_partner_id
      WHERE r.coop_org_id=$1 ${f} ORDER BY (r.status IN ('Open','Assigned')) DESC, r.created_at DESC LIMIT 300`, params,
  )).rows;
})));
router.get('/requests/:id/photo', h(async (req) => db(req, async (c, coop) => {
  const r = await own(c, coop, 'request', req.params.id);
  return { photo_data_url: r.photo_data_url };
})));
router.post('/requests/:id/assign', h(async (req) => db(req, async (c, coop) => {
  const r = await own(c, coop, 'request', req.params.id);
  if (!['vet', 'ai'].includes(r.request_type)) throw bad('only_vet_or_ai');
  if (!['Open', 'Assigned'].includes(r.status)) throw conflict('invalid_request_status');
  const p = await ownPartner(c, coop, (req.body || {}).partner_id, 'vet');
  return updateRow(c, 'dairy.service_request', 'request_id', r.request_id, { status: 'Assigned', assigned_partner_id: p.partner_id });
})));
router.post('/requests/:id/fulfil', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const r = await own(c, coop, 'request', req.params.id, { lock: true });
  if (r.request_type !== 'feed') throw bad('use_animal_event_for_service');
  if (r.status !== 'Open') throw conflict('invalid_request_status');
  const b = req.body || {};
  const iss = await issueToMember(c, coop, { member_id: r.member_id, item_id: b.item_id || r.item_id, qty: b.qty || r.qty, unit_price: b.unit_price, request_id: r.request_id }, actor(req));
  await updateRow(c, 'dairy.service_request', 'request_id', r.request_id, { status: 'Done', done_at: new Date(), result_ref_id: iss.issue_id });
  return iss;
}))));
router.post('/requests/:id/cancel', h(async (req) => db(req, async (c, coop) => {
  const r = await own(c, coop, 'request', req.params.id);
  if (!['Open', 'Assigned'].includes(r.status)) throw conflict('invalid_request_status');
  return updateRow(c, 'dairy.service_request', 'request_id', r.request_id, { status: 'Cancelled', done_at: new Date() });
})));

// ===========================================================================
// (7) สัญญาและส่งน้ำนมให้โรงงาน
// ===========================================================================
router.get('/contracts', h(async (req) => db(req, async (c, coop) => (await c.query(
  `SELECT k.*, p.name AS partner_name,
          (SELECT COALESCE(SUM(received_kg),0) FROM dairy.shipment s WHERE s.contract_id=k.contract_id AND s.status='Received')::numeric AS delivered_kg
     FROM dairy.contract k JOIN dairy.partner p ON p.partner_id=k.partner_id WHERE k.coop_org_id=$1 ORDER BY k.status, k.end_date DESC`, [coop],
)).rows)));
router.post('/contracts', h(async (req) => db(req, async (c, coop) => {
  const b = req.body || {};
  const p = await ownPartner(c, coop, b.partner_id, 'processor');
  if (!isDate(b.start_date) || !isDate(b.end_date) || b.end_date < b.start_date) throw bad('invalid_dates');
  const v = pick(b, { contract_no: 'text', note: 'text', payment_days: 'int' });
  return insertRow(c, 'dairy.contract', {
    coop_org_id: coop, partner_id: p.partner_id, start_date: b.start_date, end_date: b.end_date,
    daily_kg: needPos(b.daily_kg, 'daily_kg'), price_per_kg: needNonNeg(b.price_per_kg, 'price_per_kg'), ...v,
  });
})));
router.post('/contracts/:id/end', h(async (req) => db(req, async (c, coop) => {
  const k = await own(c, coop, 'contract', req.params.id);
  if (k.status !== 'Active') throw conflict('contract_not_active');
  return updateRow(c, 'dairy.contract', 'contract_id', k.contract_id, { status: 'Ended' });
})));

router.get('/shipments', h(async (req) => db(req, async (c, coop) => (await c.query(
  `SELECT s.*, p.name AS partner_name, k.contract_no, cc.name AS center_name FROM dairy.shipment s JOIN dairy.partner p ON p.partner_id=s.partner_id
     LEFT JOIN dairy.contract k ON k.contract_id=s.contract_id LEFT JOIN dairy.collection_center cc ON cc.center_id=s.center_id
    WHERE s.coop_org_id=$1 ORDER BY s.ship_date DESC, s.sent_at DESC LIMIT 300`, [coop],
)).rows)));

router.post('/shipments', h(async (req) => db(req, async (c, coop) => {
  const b = req.body || {};
  const date = b.ship_date || bkkToday();
  if (!isDate(date)) throw bad('invalid_field', { field: 'ship_date' });
  let partnerId; let contractId = null; let proposalId = null;
  if (b.contract_id) {
    const k = await own(c, coop, 'contract', b.contract_id);
    if (k.status !== 'Active') throw conflict('contract_not_active');
    if (date < dstr(k.start_date) || date > dstr(k.end_date)) throw bad('outside_contract_period');
    partnerId = k.partner_id; contractId = k.contract_id;
  } else if (b.proposal_id) {
    if (!isUuid(b.proposal_id)) throw notFound('proposal_not_found');
    const p = (await c.query(
      `SELECT p.* FROM dairy.surplus_proposal p JOIN dairy.surplus_offer o USING (offer_id) WHERE p.proposal_id=$1 AND o.coop_org_id=$2 AND p.status='Accepted'`,
      [b.proposal_id, coop],
    )).rows[0];
    if (!p) throw notFound('proposal_not_found');
    partnerId = p.partner_id; proposalId = p.proposal_id;
  } else partnerId = (await ownPartner(c, coop, b.partner_id, 'processor')).partner_id;
  const centerId = b.center_id ? (await own(c, coop, 'center', b.center_id)).center_id : null;
  const temp = num(b.tank_temp_c, { min: -10, max: 50 });
  if (Number.isNaN(temp)) throw bad('invalid_field', { field: 'tank_temp_c' });
  return insertRow(c, 'dairy.shipment', {
    coop_org_id: coop, partner_id: partnerId, contract_id: contractId, proposal_id: proposalId, center_id: centerId, ship_date: date,
    vehicle: txt(b.vehicle), driver_name: txt(b.driver_name), sent_kg: needPos(b.sent_kg, 'sent_kg'), tank_temp_c: temp,
  });
})));
router.post('/shipments/:id/receive', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const s = await own(c, coop, 'shipment', req.params.id, { lock: true });
  return core.receiveShipment(c, s, req.body || {});
}))));
router.post('/shipments/:id/paid', h(async (req) => db(req, async (c, coop) => {
  const s = await own(c, coop, 'shipment', req.params.id);
  if (s.status !== 'Received') throw conflict('invalid_shipment_status', { status: s.status });
  return updateRow(c, 'dairy.shipment', 'shipment_id', s.shipment_id, { paid_at: new Date() });
})));
router.post('/shipments/:id/cancel', h(async (req) => db(req, async (c, coop) => {
  const s = await own(c, coop, 'shipment', req.params.id);
  if (s.status !== 'Sent') throw conflict('invalid_shipment_status', { status: s.status });
  return updateRow(c, 'dairy.shipment', 'shipment_id', s.shipment_id, { status: 'Cancelled' });
})));

// ===========================================================================
// (10) ตลาดนมส่วนเกิน
// ===========================================================================
router.get('/surplus', h(async (req) => db(req, async (c, coop) => {
  const offers = (await c.query(
    `SELECT o.*, COALESCE(json_agg(json_build_object('proposal_id', p.proposal_id, 'processor', pp.display_name, 'kg_per_day', p.kg_per_day,
              'price_per_kg', p.price_per_kg, 'proposed_by', p.proposed_by, 'status', p.status, 'created_at', p.created_at))
              FILTER (WHERE p.proposal_id IS NOT NULL), '[]') AS proposals
       FROM dairy.surplus_offer o LEFT JOIN dairy.surplus_proposal p ON p.offer_id=o.offer_id
       LEFT JOIN dairy.processor_profile pp ON pp.org_id=p.processor_org_id
      WHERE o.coop_org_id=$1 GROUP BY o.offer_id ORDER BY o.created_at DESC LIMIT 100`, [coop],
  )).rows;
  const capacities = (await c.query(
    `SELECT k.capacity_id, k.available_from, k.available_to, k.kg_per_day, k.price_per_kg, k.note, pp.display_name, pp.province_code, pv.province_name_th, pp.products
       FROM dairy.processor_capacity k JOIN dairy.processor_profile pp ON pp.org_id=k.org_id AND pp.active
       LEFT JOIN registry.province pv ON pv.province_code=pp.province_code
      WHERE k.active AND k.available_to >= $1 ORDER BY k.price_per_kg DESC, k.available_from LIMIT 100`, [bkkToday()],
  )).rows;
  return { offers, capacities };
})));

router.post('/surplus/offers', h(async (req) => db(req, async (c, coop) => {
  const b = req.body || {};
  const start = b.start_date || bkkToday();
  if (!isDate(start) || start < bkkToday()) throw bad('invalid_field', { field: 'start_date' });
  const days = num(b.days, { min: 1, max: 90 });
  if (!days || Number.isNaN(days) || !Number.isInteger(days)) throw bad('invalid_field', { field: 'days' });
  const avg = (await c.query(
    `SELECT ROUND(AVG(fat_pct),2) AS fat, ROUND(AVG(snf_pct),2) AS snf FROM dairy.quality_test WHERE coop_org_id=$1 AND sample_date >= $2::date - 30`,
    [coop, bkkToday()],
  )).rows[0];
  return insertRow(c, 'dairy.surplus_offer', {
    coop_org_id: coop, start_date: start, days, kg_per_day: needPos(b.kg_per_day, 'kg_per_day'), min_price: b.min_price ? needNonNeg(b.min_price, 'min_price') : 0,
    avg_fat_pct: avg.fat, avg_snf_pct: avg.snf, note: txt(b.note),
  });
})));
const endOffer = (action) => h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const o = await own(c, coop, 'offer', req.params.id, { lock: true });
  if (action === 'cancel' && o.status !== 'Open') throw conflict('offer_not_open');
  if (action === 'close' && !['Open', 'Matched'].includes(o.status)) throw conflict('invalid_offer_status');
  await c.query(`UPDATE dairy.surplus_proposal SET status='Withdrawn', decided_at=now() WHERE offer_id=$1 AND status='Pending'`, [o.offer_id]);
  return updateRow(c, 'dairy.surplus_offer', 'offer_id', o.offer_id, { status: action === 'cancel' ? 'Cancelled' : 'Closed' });
})));
router.post('/surplus/offers/:id/cancel', endOffer('cancel'));
router.post('/surplus/offers/:id/close', endOffer('close'));
/** สหกรณ์เสนอไปยังกำลังรับว่างของโรงงาน — โรงงานกดตอบรับในพอร์ทัลคู่ค้า */
router.post('/surplus/offers/:id/propose', h(async (req) => db(req, async (c, coop) => {
  const o = await own(c, coop, 'offer', req.params.id);
  if (o.status !== 'Open') throw conflict('offer_not_open');
  const b = req.body || {};
  if (!isUuid(b.capacity_id)) throw notFound('capacity_not_found');
  const k = (await c.query(
    `SELECT k.* FROM dairy.processor_capacity k JOIN dairy.processor_profile pp ON pp.org_id=k.org_id AND pp.active
      WHERE k.capacity_id=$1 AND k.active AND k.available_to >= $2`, [b.capacity_id, bkkToday()],
  )).rows[0];
  if (!k) throw notFound('capacity_not_found');
  const kg = b.kg_per_day ? needPos(b.kg_per_day, 'kg_per_day') : Math.min(Number(o.kg_per_day), Number(k.kg_per_day));
  return insertRow(c, 'dairy.surplus_proposal', {
    offer_id: o.offer_id, processor_org_id: k.org_id, capacity_id: k.capacity_id, kg_per_day: kg,
    price_per_kg: b.price_per_kg ? needNonNeg(b.price_per_kg, 'price_per_kg') : k.price_per_kg, proposed_by: 'coop',
  }).catch(uniq('proposal_exists'));
})));
const decideProposal = (action) => h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  if (!isUuid(req.params.id)) throw notFound('proposal_not_found');
  const p = (await c.query(
    `SELECT p.* FROM dairy.surplus_proposal p JOIN dairy.surplus_offer o USING (offer_id) WHERE p.proposal_id=$1 AND o.coop_org_id=$2 FOR UPDATE OF p`,
    [req.params.id, coop],
  )).rows[0];
  if (!p) throw notFound('proposal_not_found');
  if (p.proposed_by !== 'processor') throw conflict('waiting_for_processor');
  const o = await own(c, coop, 'offer', p.offer_id, { lock: true });
  if (action === 'reject') {
    if (p.status !== 'Pending') throw conflict('invalid_proposal_status');
    return updateRow(c, 'dairy.surplus_proposal', 'proposal_id', p.proposal_id, { status: 'Rejected', decided_at: new Date() });
  }
  return core.acceptProposal(c, p, o);
})));
router.post('/surplus/proposals/:id/accept', decideProposal('accept'));
router.post('/surplus/proposals/:id/reject', decideProposal('reject'));

// ===========================================================================
// (8) แปรรูปและสต็อกผลิตภัณฑ์
// ===========================================================================
const PRODUCT_SPEC = { name: 'text', unit: 'text', milk_kg_per_unit: 'num', shelf_life_days: 'int', sell_price: 'num', active: 'bool' };
function productValues(b, partial) {
  const v = pick(b, PRODUCT_SPEC);
  if (!partial || 'product_type' in b) { if (!DAIRY_PRODUCT_TYPES.includes(b.product_type)) throw bad('invalid_field', { field: 'product_type' }); v.product_type = b.product_type; }
  if ((!partial || 'name' in b) && !v.name) throw bad('missing_name');
  if ((!partial || 'milk_kg_per_unit' in b) && !(Number(v.milk_kg_per_unit) > 0)) throw bad('invalid_field', { field: 'milk_kg_per_unit' });
  if ((!partial || 'shelf_life_days' in b) && !(Number(v.shelf_life_days) > 0)) throw bad('invalid_field', { field: 'shelf_life_days' });
  return v;
}
router.get('/products', h(async (req) => db(req, async (c, coop) => (await c.query(
  `SELECT p.*, (SELECT COALESCE(SUM(units_left),0) FROM dairy.production_batch b WHERE b.product_id=p.product_id AND b.expires_on >= $2)::int AS units_in_stock
     FROM dairy.product p WHERE p.coop_org_id=$1 ORDER BY p.name`, [coop, bkkToday()],
)).rows)));
router.post('/products', h(async (req) => db(req, async (c, coop) => insertRow(c, 'dairy.product', { coop_org_id: coop, ...productValues(req.body || {}, false) }).catch(uniq('product_exists')))));
router.put('/products/:id', h(async (req) => db(req, async (c, coop) => {
  const p = await own(c, coop, 'product', req.params.id);
  return updateRow(c, 'dairy.product', 'product_id', p.product_id, productValues(req.body || {}, true)).catch(uniq('product_exists'));
})));

router.get('/batches', h(async (req) => db(req, async (c, coop) => (await c.query(
  `SELECT b.*, p.name AS product_name, p.unit, (b.expires_on < $2) AS expired, (b.expires_on - $2::date) AS days_left
     FROM dairy.production_batch b JOIN dairy.product p ON p.product_id=b.product_id
    WHERE b.coop_org_id=$1 ORDER BY (b.units_left>0) DESC, b.expires_on LIMIT 300`, [coop, bkkToday()],
)).rows)));
router.post('/batches', h(async (req) => db(req, async (c, coop) => {
  const b = req.body || {};
  const p = await own(c, coop, 'product', b.product_id);
  const date = b.produced_on || bkkToday();
  if (!isDate(date) || date > bkkToday()) throw bad('invalid_field', { field: 'produced_on' });
  const units = num(b.units, { min: 1 });
  if (!units || Number.isNaN(units) || !Number.isInteger(units)) throw bad('invalid_field', { field: 'units' });
  const milk = b.milk_used_kg ? needPos(b.milk_used_kg, 'milk_used_kg') : round2(units * Number(p.milk_kg_per_unit));
  const n = (await c.query('SELECT COUNT(*)::int AS n FROM dairy.production_batch WHERE coop_org_id=$1 AND produced_on=$2', [coop, date])).rows[0].n;
  return insertRow(c, 'dairy.production_batch', {
    coop_org_id: coop, product_id: p.product_id, lot_code: txt(b.lot_code) || `P${date.replace(/-/g, '').slice(2)}-${String(n + 1).padStart(2, '0')}`,
    produced_on: date, expires_on: addDays(date, Number(p.shelf_life_days)), milk_used_kg: milk, units, units_left: units,
  }).catch(uniq('lot_code_exists'));
})));

async function sellBatch(c, coop, b) {
  const bt = await own(c, coop, 'batch', b.batch_id, { lock: true });
  const units = num(b.units, { min: 1 });
  if (!units || Number.isNaN(units) || !Number.isInteger(units)) throw bad('invalid_field', { field: 'units' });
  if (units > bt.units_left) throw conflict('insufficient_stock', { available: bt.units_left, needed: units });
  if (dstr(bt.expires_on) < bkkToday()) throw conflict('batch_expired');
  const p = await own(c, coop, 'product', bt.product_id);
  const price = b.unit_price !== undefined && b.unit_price !== '' ? needNonNeg(b.unit_price, 'unit_price') : Number(p.sell_price);
  const amount = round2(units * price);
  const s = await core.settings(c, coop);
  const sale = await insertRow(c, 'dairy.product_sale', {
    coop_org_id: coop, batch_id: bt.batch_id, partner_id: b.partner_id || null, school_id: b.school_id || null, buyer_name: txt(b.buyer_name),
    units, unit_price: price, amount, sold_on: bkkToday(), fee_rate_pct: s.fee_rate_product_pct,
  });
  const fee = await core.addPlatformFee(c, coop, 'product_sale', 'coop', coop, amount, Number(s.fee_rate_product_pct), 'product_sale', sale.sale_id);
  await c.query('UPDATE dairy.product_sale SET fee_amount=$2 WHERE sale_id=$1', [sale.sale_id, fee]);
  await c.query('UPDATE dairy.production_batch SET units_left=units_left-$2 WHERE batch_id=$1', [bt.batch_id, units]);
  return { ...sale, fee_amount: fee };
}
router.post('/product-sales', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = req.body || {};
  if (b.partner_id) b.partner_id = (await ownPartner(c, coop, b.partner_id, 'product_buyer')).partner_id;
  else if (!txt(b.buyer_name)) throw bad('missing_buyer');
  return sellBatch(c, coop, b);
}))));
router.get('/product-sales', h(async (req) => db(req, async (c, coop) => (await c.query(
  `SELECT s.*, b.lot_code, pr.name AS product_name, pr.unit, COALESCE(p.name, sc.name, s.buyer_name) AS buyer
     FROM dairy.product_sale s JOIN dairy.production_batch b ON b.batch_id=s.batch_id JOIN dairy.product pr ON pr.product_id=b.product_id
     LEFT JOIN dairy.partner p ON p.partner_id=s.partner_id LEFT JOIN dairy.school sc ON sc.school_id=s.school_id
    WHERE s.coop_org_id=$1 ORDER BY s.created_at DESC LIMIT 300`, [coop],
)).rows)));

// ===========================================================================
// (9) นมโรงเรียน
// ===========================================================================
const SCHOOL_SPEC = { name: 'text', district: 'text', province: 'text', students: 'int', contact_name: 'text', phone: 'text', units_per_student_day: 'num', active: 'bool' };
async function schoolValues(c, coop, b, partial) {
  const v = pick(b, SCHOOL_SPEC);
  if ((!partial || 'name' in b) && !v.name) throw bad('missing_name');
  if ('product_id' in b) v.product_id = b.product_id ? (await own(c, coop, 'product', b.product_id)).product_id : null;
  if ('delivery_weekdays' in b) {
    const w = (Array.isArray(b.delivery_weekdays) ? b.delivery_weekdays : String(b.delivery_weekdays).split(',')).map((x) => Number(x));
    if (!w.length || w.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) throw bad('invalid_field', { field: 'delivery_weekdays' });
    v.delivery_weekdays = [...new Set(w)].sort();
  }
  return v;
}
router.get('/schools', h(async (req) => db(req, async (c, coop) => (await c.query(
  `SELECT s.*, p.name AS product_name, p.unit,
          (SELECT COUNT(*) FROM dairy.school_delivery d WHERE d.school_id=s.school_id AND d.status='Confirmed')::int AS confirmed,
          (SELECT COUNT(*) FROM dairy.school_delivery d WHERE d.school_id=s.school_id AND d.status='Issue')::int AS issues
     FROM dairy.school s LEFT JOIN dairy.product p ON p.product_id=s.product_id WHERE s.coop_org_id=$1 ORDER BY s.name`, [coop],
)).rows)));
router.post('/schools', h(async (req) => db(req, async (c, coop) => insertRow(c, 'dairy.school', { coop_org_id: coop, ...(await schoolValues(c, coop, req.body || {}, false)) }).catch(uniq('school_exists')))));
router.put('/schools/:id', h(async (req) => db(req, async (c, coop) => {
  const s = await own(c, coop, 'school', req.params.id);
  return updateRow(c, 'dairy.school', 'school_id', s.school_id, await schoolValues(c, coop, req.body || {}, true)).catch(uniq('school_exists'));
})));
router.get('/school-terms', h(async (req) => db(req, async (c, coop) => (await c.query(
  `SELECT t.*, s.name AS school_name FROM dairy.school_term t LEFT JOIN dairy.school s ON s.school_id=t.school_id WHERE t.coop_org_id=$1 ORDER BY t.start_date DESC`, [coop],
)).rows)));
router.post('/school-terms', h(async (req) => db(req, async (c, coop) => {
  const b = req.body || {};
  if (!isDate(b.start_date) || !isDate(b.end_date) || b.end_date < b.start_date) throw bad('invalid_dates');
  const name = txt(b.name);
  if (!name) throw bad('missing_name');
  return insertRow(c, 'dairy.school_term', {
    coop_org_id: coop, school_id: b.school_id ? (await own(c, coop, 'school', b.school_id)).school_id : null, name, start_date: b.start_date, end_date: b.end_date,
  });
})));

router.get('/school-deliveries', h(async (req) => db(req, async (c, coop) => {
  const from = isDate(req.query.from) ? req.query.from : addDays(bkkToday(), -7);
  const to = isDate(req.query.to) ? req.query.to : addDays(bkkToday(), 14);
  return (await c.query(
    `SELECT d.*, s.name AS school_name, p.unit, b.lot_code FROM dairy.school_delivery d JOIN dairy.school s ON s.school_id=d.school_id
       LEFT JOIN dairy.product p ON p.product_id=s.product_id LEFT JOIN dairy.production_batch b ON b.batch_id=d.batch_id
      WHERE d.coop_org_id=$1 AND d.delivery_date BETWEEN $2 AND $3 ORDER BY d.delivery_date, s.name`, [coop, from, to],
  )).rows;
})));
/** วางแผนส่งนมโรงเรียนตามวันส่งของแต่ละโรงเรียนในภาคเรียน (ข้ามวันที่มีแผนแล้ว) */
router.post('/school-deliveries/plan', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = req.body || {};
  const from = b.from || bkkToday();
  const to = b.to || addDays(from, 13);
  if (!isDate(from) || !isDate(to) || to < from || core.daysBetween(from, to) > 120) throw bad('invalid_dates');
  const schools = (await c.query('SELECT * FROM dairy.school WHERE coop_org_id=$1 AND active AND product_id IS NOT NULL AND students > 0', [coop])).rows;
  const terms = (await c.query('SELECT school_id, start_date::text AS s, end_date::text AS e FROM dairy.school_term WHERE coop_org_id=$1', [coop])).rows;
  let created = 0;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
    for (const s of schools) {
      if (!s.delivery_weekdays.map(Number).includes(wd)) continue;
      if (!terms.some((t) => (t.school_id === null || t.school_id === s.school_id) && t.s <= day && day <= t.e)) continue;
      const units = Math.ceil(Number(s.students) * Number(s.units_per_student_day));
      const r = await c.query(
        `INSERT INTO dairy.school_delivery (coop_org_id, school_id, delivery_date, units, confirm_token) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (school_id, delivery_date) DO NOTHING RETURNING delivery_id`,
        [coop, s.school_id, day, units, crypto.randomBytes(16).toString('hex')],
      );
      created += r.rows.length;
    }
  }
  return { created, from, to };
}))));
router.post('/school-deliveries/:id/deliver', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const d = await own(c, coop, 'delivery', req.params.id, { lock: true });
  if (d.status !== 'Planned') throw conflict('invalid_delivery_status', { status: d.status });
  const b = req.body || {};
  const sale = await sellBatch(c, coop, { batch_id: b.batch_id, units: b.units || d.units, unit_price: b.unit_price, school_id: d.school_id });
  return updateRow(c, 'dairy.school_delivery', 'delivery_id', d.delivery_id, { status: 'Delivered', batch_id: sale.batch_id, units: sale.units, delivered_at: new Date() })
    .then((row) => ({ ...row, sale }));
}))));
router.post('/school-deliveries/:id/cancel', h(async (req) => db(req, async (c, coop) => {
  const d = await own(c, coop, 'delivery', req.params.id);
  if (d.status !== 'Planned') throw conflict('invalid_delivery_status', { status: d.status });
  return updateRow(c, 'dairy.school_delivery', 'delivery_id', d.delivery_id, { status: 'Cancelled' });
})));

// ===========================================================================
// (11) ไบโอแก๊ส
// ===========================================================================
router.get('/biogas', h(async (req) => db(req, async (c, coop) => ({
  logs: (await c.query(
    `SELECT g.*, m.full_name AS member_name FROM dairy.biogas_log g LEFT JOIN dairy.member m ON m.member_id=g.member_id
      WHERE g.coop_org_id=$1 ORDER BY g.log_date DESC LIMIT 200`, [coop],
  )).rows,
  totals_90d: (await c.query(
    `SELECT COALESCE(SUM(manure_kg),0)::numeric AS manure_kg, COALESCE(SUM(gas_m3),0)::numeric AS gas_m3, COALESCE(SUM(electricity_kwh),0)::numeric AS electricity_kwh,
            COALESCE(SUM(digestate_kg),0)::numeric AS digestate_kg, COALESCE(SUM(digestate_sold_kg),0)::numeric AS digestate_sold_kg,
            COALESCE(SUM(digestate_revenue),0)::numeric AS digestate_revenue
       FROM dairy.biogas_log WHERE coop_org_id=$1 AND log_date >= $2::date - 90`, [coop, bkkToday()],
  )).rows[0],
}))));
router.post('/biogas', h(async (req) => db(req, async (c, coop) => {
  const b = req.body || {};
  const v = pick(b, { manure_kg: 'num', gas_m3: 'num', electricity_kwh: 'num', digestate_kg: 'num', digestate_sold_kg: 'num', digestate_revenue: 'num', note: 'text' });
  const date = b.log_date || bkkToday();
  if (!isDate(date) || date > bkkToday()) throw bad('invalid_field', { field: 'log_date' });
  const site = txt(b.site_name);
  if (!site) throw bad('missing_site_name');
  const memberId = b.member_id ? (await own(c, coop, 'member', b.member_id)).member_id : null;
  return insertRow(c, 'dairy.biogas_log', { coop_org_id: coop, member_id: memberId, site_name: site, log_date: date, ...v });
})));

// ===========================================================================
// (6) บัญชีสมาชิก รอบจ่าย ธ.ก.ส. ค่าบริการ
// ===========================================================================
router.get('/ledger', h(async (req) => db(req, async (c, coop) => {
  const params = [coop];
  let f = '';
  if (req.query.member_id) { params.push(needUuid(req.query.member_id, 'member_id')); f = 'AND l.member_id=$2'; }
  if (req.query.unsettled === '1') f += ' AND l.run_id IS NULL';
  return (await c.query(
    `SELECT l.*, m.full_name AS member_name, m.member_code FROM dairy.member_ledger l JOIN dairy.member m ON m.member_id=l.member_id
      WHERE l.coop_org_id=$1 ${f} ORDER BY l.entry_date DESC, l.created_at DESC LIMIT 500`, params,
  )).rows;
})));

/** รายการหักอื่น ๆ: ชำระสินเชื่อ ค่าหุ้น ปรับปรุง (ใส่จำนวนบวก = หัก, adjustment ใส่เครื่องหมายได้) */
router.post('/ledger/entry', h(async (req) => db(req, async (c, coop) => {
  const b = req.body || {};
  const m = await own(c, coop, 'member', b.member_id);
  if (!['loan_repayment', 'share', 'adjustment'].includes(b.entry_type)) throw bad('invalid_field', { field: 'entry_type' });
  const amount = num(b.amount);
  if (amount === null || Number.isNaN(amount) || amount === 0) throw bad('invalid_field', { field: 'amount' });
  const note = txt(b.note);
  if (!note) throw bad('missing_note');
  const signed = b.entry_type === 'adjustment' ? amount : -Math.abs(amount);
  await core.addLedger(c, coop, m.member_id, b.entry_type, signed, null, null, `${note} (โดย ${actor(req)})`);
  return { ok: true, amount: signed };
})));

router.get('/settlements', h(async (req) => db(req, async (c, coop) => {
  const s = await core.settings(c, coop);
  const last = (await c.query(`SELECT MAX(period_end)::text AS d FROM dairy.settlement_run WHERE coop_org_id=$1 AND status <> 'Cancelled'`, [coop])).rows[0].d;
  return {
    settlement_days: s.settlement_days, last_period_end: last,
    suggested_period_end: last ? addDays(last, Number(s.settlement_days)) : bkkToday(),
    runs: (await c.query('SELECT * FROM dairy.settlement_run WHERE coop_org_id=$1 ORDER BY period_end DESC, created_at DESC LIMIT 100', [coop])).rows,
  };
})));

/**
 * สร้างรอบจ่าย (Draft) ถึง period_end: ต่อสมาชิก รวมรายรับ (ค่านม ฯลฯ) แล้วหัก
 * รายการหักตามลำดับใน setting.deduction_order ทีละรายการเท่าที่รายรับพอ
 * รายการแรกที่หักไม่พอและทุกรายการหลังจากนั้นยกไปรอบถัดไป (ไม่จ่ายติดลบ). ค่าหุ้นต่อรอบถูกเพิ่มอัตโนมัติ.
 */
router.post('/settlements', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const s = await core.settings(c, coop);
  const periodEnd = (req.body || {}).period_end || bkkToday();
  if (!isDate(periodEnd) || periodEnd > bkkToday()) throw bad('invalid_period_end');
  if ((await c.query(`SELECT 1 FROM dairy.settlement_run WHERE coop_org_id=$1 AND status='Draft'`, [coop])).rows.length) throw conflict('draft_run_exists');
  if ((await c.query(`SELECT 1 FROM dairy.milk_round WHERE coop_org_id=$1 AND status='Open' AND round_date <= $2`, [coop, periodEnd])).rows.length) {
    throw conflict('open_rounds_in_period');
  }
  const last = (await c.query(`SELECT MAX(period_end)::text AS d FROM dairy.settlement_run WHERE coop_org_id=$1 AND status <> 'Cancelled'`, [coop])).rows[0].d;
  if (last && periodEnd <= last) throw bad('period_already_settled', { last_period_end: last });
  const members = (await c.query(
    `SELECT DISTINCT m.* FROM dairy.member m JOIN dairy.member_ledger l ON l.member_id=m.member_id
      WHERE m.coop_org_id=$1 AND l.run_id IS NULL AND l.entry_date <= $2`, [coop, periodEnd],
  )).rows;
  const firstDate = (await c.query(
    `SELECT MIN(entry_date)::text AS d FROM dairy.member_ledger WHERE coop_org_id=$1 AND run_id IS NULL AND entry_date <= $2`, [coop, periodEnd],
  )).rows[0].d;
  if (!members.length) throw conflict('nothing_to_settle');
  const run = await insertRow(c, 'dairy.settlement_run', {
    coop_org_id: coop, period_start: last ? addDays(last, 1) : (firstDate < periodEnd ? firstDate : periodEnd), period_end: periodEnd,
  });
  const order = s.deduction_order;
  let total = 0; let paid = 0; let carried = 0;
  for (const m of members) {
    if (Number(m.share_deduct_per_round) > 0) {
      await core.addLedger(c, coop, m.member_id, 'share', -Number(m.share_deduct_per_round), 'settlement_run', run.run_id, 'ค่าหุ้นต่อรอบ', periodEnd);
    }
    const entries = (await c.query(
      `SELECT entry_id, entry_type, amount FROM dairy.member_ledger WHERE member_id=$1 AND run_id IS NULL AND entry_date <= $2 ORDER BY entry_date, created_at`,
      [m.member_id, periodEnd],
    )).rows;
    const credits = entries.filter((e) => Number(e.amount) > 0);
    const debits = entries.filter((e) => Number(e.amount) < 0)
      .sort((a, b2) => order.indexOf(a.entry_type) - order.indexOf(b2.entry_type));
    let avail = credits.reduce((a, e) => a + Number(e.amount), 0);
    const take = credits.map((e) => e.entry_id);
    // ลำดับเคร่งครัด: เมื่อรายการใดหักไม่พอ รายการนั้นและรายการลำดับถัดไปทั้งหมดยกไปรอบหน้า
    let debit = 0; let carry = 0; let stopped = false;
    debits.forEach((e) => {
      const amt = -Number(e.amount);
      if (!stopped && amt <= avail + 1e-9) { avail -= amt; debit += amt; take.push(e.entry_id); } else { stopped = true; carry += amt; }
    });
    const credit = credits.reduce((a, e) => a + Number(e.amount), 0);
    if (!take.length) { carried += 1; continue; }
    const net = round2(credit - debit);
    await c.query('UPDATE dairy.member_ledger SET run_id=$1 WHERE entry_id = ANY($2::uuid[])', [run.run_id, take]);
    await c.query(
      `INSERT INTO dairy.settlement_line (run_id, member_id, total_credit, total_debit, net_amount, carried_debit, baac_account_no, baac_account_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [run.run_id, m.member_id, round2(credit), round2(debit), net, round2(carry), m.baac_account_no, m.baac_account_name || m.full_name],
    );
    total += net;
    if (net > 0) paid += 1;
    if (carry > 0) carried += 1;
  }
  const r = await updateRow(c, 'dairy.settlement_run', 'run_id', run.run_id, { total_net: round2(total), member_count: paid });
  await logAccess(c, 'write', 'dairy.settlement_run', run.run_id);
  return { ...r, members_with_carried_debit: carried };
}))));

router.get('/settlements/:id', h(async (req) => db(req, async (c, coop) => {
  const run = await own(c, coop, 'run', req.params.id);
  const lines = (await c.query(
    `SELECT s.*, m.full_name, m.member_code FROM dairy.settlement_line s JOIN dairy.member m ON m.member_id=s.member_id WHERE s.run_id=$1 ORDER BY m.member_code`,
    [run.run_id],
  )).rows;
  const byType = (await c.query(
    `SELECT entry_type, SUM(amount)::numeric AS amount FROM dairy.member_ledger WHERE run_id=$1 GROUP BY 1 ORDER BY 1`, [run.run_id],
  )).rows;
  return { ...run, lines, by_type: byType, missing_account: lines.filter((l) => Number(l.net_amount) > 0 && !l.baac_account_no).length };
})));

router.post('/settlements/:id/submit', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const run = await own(c, coop, 'run', req.params.id, { lock: true });
  if (run.status !== 'Draft') throw conflict('invalid_run_status', { status: run.status });
  await c.query(
    `UPDATE dairy.settlement_line s SET baac_account_no=m.baac_account_no, baac_account_name=COALESCE(m.baac_account_name, m.full_name)
       FROM dairy.member m WHERE m.member_id=s.member_id AND s.run_id=$1`, [run.run_id],
  );
  const missing = (await c.query(
    `SELECT m.full_name FROM dairy.settlement_line s JOIN dairy.member m ON m.member_id=s.member_id
      WHERE s.run_id=$1 AND s.net_amount > 0 AND s.baac_account_no IS NULL`, [run.run_id],
  )).rows;
  if (missing.length) throw conflict('missing_baac_account', { members: missing.map((x) => x.full_name) });
  const ref = `DAIRY-${dstr(run.period_end).replace(/-/g, '')}-${run.run_id.slice(0, 6).toUpperCase()}`;
  return updateRow(c, 'dairy.settlement_run', 'run_id', run.run_id, { status: 'Submitted', submitted_at: new Date(), baac_batch_ref: ref });
}))));

/** ไฟล์โอนเงิน ธ.ก.ส. (CSV UTF-8 + BOM) รูปแบบกลาง — ต้องยืนยันรูปแบบจริงกับธนาคาร */
router.get('/settlements/:id/baac-export', h(async (req, res) => db(req, async (c, coop) => {
  const run = await own(c, coop, 'run', req.params.id);
  if (!['Submitted', 'Paid'].includes(run.status)) throw conflict('run_not_submitted');
  const lines = (await c.query(
    `SELECT s.*, m.member_code FROM dairy.settlement_line s JOIN dairy.member m ON m.member_id=s.member_id
      WHERE s.run_id=$1 AND s.net_amount > 0 ORDER BY m.member_code`, [run.run_id],
  )).rows;
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['seq', 'baac_account_no', 'account_name', 'amount_thb', 'member_code', 'reference'].join(',')];
  lines.forEach((l, i) => rows.push([i + 1, esc(l.baac_account_no), esc(l.baac_account_name), Number(l.net_amount).toFixed(2), esc(l.member_code), esc(run.baac_batch_ref)].join(',')));
  await logAccess(c, 'read', 'dairy.settlement_run', run.run_id);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${run.baac_batch_ref}.csv"`);
  res.send(`﻿${rows.join('\r\n')}\r\n`);
  return undefined;
})));
router.post('/settlements/:id/paid', h(async (req) => db(req, async (c, coop) => {
  const run = await own(c, coop, 'run', req.params.id);
  if (run.status !== 'Submitted') throw conflict('invalid_run_status', { status: run.status });
  return updateRow(c, 'dairy.settlement_run', 'run_id', run.run_id, { status: 'Paid', paid_at: new Date() });
})));
router.post('/settlements/:id/cancel', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const run = await own(c, coop, 'run', req.params.id, { lock: true });
  if (!['Draft', 'Submitted'].includes(run.status)) throw conflict('invalid_run_status', { status: run.status });
  await c.query(`DELETE FROM dairy.member_ledger WHERE run_id=$1 AND entry_type='share' AND ref_type='settlement_run' AND ref_id=$1`, [run.run_id]);
  await c.query(`DELETE FROM dairy.member_ledger WHERE run_id IS NULL AND entry_type='share' AND ref_type='settlement_run' AND ref_id=$1`, [run.run_id]);
  await c.query('UPDATE dairy.member_ledger SET run_id=NULL WHERE run_id=$1', [run.run_id]);
  return updateRow(c, 'dairy.settlement_run', 'run_id', run.run_id, { status: 'Cancelled' });
}))));

router.get('/fees', h(async (req) => db(req, async (c, coop) => {
  const params = [coop];
  let f = '';
  if (isDate(req.query.from)) { params.push(req.query.from); f += ` AND created_at >= $${params.length}::date`; }
  if (isDate(req.query.to)) { params.push(req.query.to); f += ` AND created_at < $${params.length}::date + 1`; }
  return (await c.query(
    `SELECT fee_type, payer_type, COUNT(*)::int AS n, SUM(base_amount)::numeric AS base, SUM(fee_amount)::numeric AS fee
       FROM dairy.platform_fee WHERE coop_org_id=$1 ${f} GROUP BY 1,2 ORDER BY 1`, params,
  )).rows;
})));

// ===========================================================================
// (12) IoT พยากรณ์ รายงาน
// ===========================================================================
const DEVICE_TYPES = ['cooling_tank', 'milk_scale', 'vehicle', 'biogas', 'barn'];
router.get('/iot/devices', h(async (req) => db(req, async (c, coop) => (await c.query(
  `SELECT d.device_id, d.name, d.device_type, d.center_id, cc.name AS center_name, d.member_id, m.full_name AS member_name, d.temp_min, d.temp_max,
          d.active, d.last_seen_at,
          (SELECT row_to_json(x) FROM (SELECT recorded_at, temp_c, level_kg, gas_m3 FROM dairy.iot_reading r WHERE r.device_id=d.device_id ORDER BY recorded_at DESC LIMIT 1) x) AS last_reading,
          (SELECT COUNT(*)::int FROM dairy.iot_alert a WHERE a.device_id=d.device_id AND a.acknowledged_at IS NULL) AS open_alerts
     FROM dairy.iot_device d LEFT JOIN dairy.collection_center cc ON cc.center_id=d.center_id LEFT JOIN dairy.member m ON m.member_id=d.member_id
    WHERE d.coop_org_id=$1 ORDER BY d.created_at`, [coop],
)).rows)));

router.post('/iot/devices', h(async (req) => db(req, async (c, coop) => {
  const b = req.body || {};
  const name = txt(b.name);
  if (!name) throw bad('missing_name');
  if (!DEVICE_TYPES.includes(b.device_type)) throw bad('invalid_field', { field: 'device_type' });
  const centerId = b.center_id ? (await own(c, coop, 'center', b.center_id)).center_id : null;
  if (['cooling_tank', 'milk_scale'].includes(b.device_type) && !centerId) throw bad('device_needs_center');
  const memberId = b.member_id ? (await own(c, coop, 'member', b.member_id)).member_id : null;
  const s = await core.settings(c, coop);
  let tmin = num(b.temp_min, { min: -20, max: 80 });
  let tmax = num(b.temp_max, { min: -20, max: 80 });
  if (Number.isNaN(tmin) || Number.isNaN(tmax)) throw bad('invalid_field', { field: 'temp' });
  if (b.device_type === 'cooling_tank' && tmax === null) tmax = Number(s.tank_temp_max);
  if (tmin === null) tmin = null;
  const apiKey = `dk_${crypto.randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const r = await insertRow(c, 'dairy.iot_device', {
    coop_org_id: coop, name, device_type: b.device_type, center_id: centerId, member_id: memberId, api_key_hash: hash, temp_min: tmin, temp_max: tmax,
  });
  delete r.api_key_hash;
  return { ...r, api_key: apiKey, api_key_note: 'แสดงครั้งเดียว — ใส่ในอุปกรณ์เป็น header X-Device-Key' };
})));
router.put('/iot/devices/:id', h(async (req) => db(req, async (c, coop) => {
  const d = await own(c, coop, 'device', req.params.id);
  const b = req.body || {};
  const v = pick(b, { name: 'text', active: 'bool' });
  ['temp_min', 'temp_max'].forEach((f) => {
    if (!(f in b)) return;
    const x = num(b[f], { min: -20, max: 80 });
    if (Number.isNaN(x)) throw bad('invalid_field', { field: f });
    v[f] = x;
  });
  if ('name' in v && !v.name) throw bad('missing_name');
  const r = await updateRow(c, 'dairy.iot_device', 'device_id', d.device_id, v);
  delete r.api_key_hash;
  return r;
})));
router.get('/iot/devices/:id/readings', h(async (req) => db(req, async (c, coop) => {
  const d = await own(c, coop, 'device', req.params.id);
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 14);
  return (await c.query(
    `SELECT recorded_at, temp_c, level_kg, gas_m3, lat, lng FROM dairy.iot_reading WHERE device_id=$1 AND recorded_at >= now() - ($2 || ' hours')::interval ORDER BY recorded_at`,
    [d.device_id, String(hours)],
  )).rows;
})));
router.get('/iot/alerts', h(async (req) => db(req, async (c, coop) => (await c.query(
  `SELECT a.*, d.name AS device_name, d.device_type FROM dairy.iot_alert a JOIN dairy.iot_device d USING (device_id)
    WHERE d.coop_org_id=$1 ORDER BY (a.acknowledged_at IS NULL) DESC, a.created_at DESC LIMIT 200`, [coop],
)).rows)));
router.post('/iot/alerts/:id/ack', h(async (req) => db(req, async (c, coop) => {
  if (!isUuid(req.params.id)) throw notFound('alert_not_found');
  const r = await c.query(
    `UPDATE dairy.iot_alert a SET acknowledged_at=now() FROM dairy.iot_device d
      WHERE a.alert_id=$1 AND d.device_id=a.device_id AND d.coop_org_id=$2 AND a.acknowledged_at IS NULL RETURNING a.*`, [req.params.id, coop],
  );
  if (!r.rows.length) throw notFound('alert_not_found');
  return r.rows[0];
})));

router.get('/forecast', h(async (req) => db(req, async (c, coop) => core.forecast(c, coop, 90))));

/** รายงานสรุปช่วงเวลา (ค่าเริ่มต้น 30 วันล่าสุด) */
router.get('/reports/summary', h(async (req) => db(req, async (c, coop) => {
  const to = isDate(req.query.to) ? req.query.to : bkkToday();
  const from = isDate(req.query.from) ? req.query.from : addDays(to, -29);
  const P = [coop, from, to];
  const [milk] = (await c.query(
    `SELECT COALESCE(SUM(i.weight_kg) FILTER (WHERE i.status='Accepted'),0)::numeric AS accepted_kg,
            COALESCE(SUM(i.weight_kg) FILTER (WHERE i.status='Rejected'),0)::numeric AS rejected_kg,
            COALESCE(SUM(i.amount),0)::numeric AS paid_to_members,
            COUNT(DISTINCT r.round_date)::int AS days
       FROM dairy.milk_intake i JOIN dairy.milk_round r USING (round_id) WHERE r.coop_org_id=$1 AND r.round_date BETWEEN $2 AND $3`, P,
  )).rows;
  const rejects = (await c.query(
    `SELECT i.reject_reason, COUNT(*)::int AS n, SUM(i.weight_kg)::numeric AS kg FROM dairy.milk_intake i JOIN dairy.milk_round r USING (round_id)
      WHERE r.coop_org_id=$1 AND r.round_date BETWEEN $2 AND $3 AND i.status='Rejected' GROUP BY 1 ORDER BY 3 DESC`, P,
  )).rows;
  const [ship] = (await c.query(
    `SELECT COALESCE(SUM(sent_kg) FILTER (WHERE status<>'Cancelled'),0)::numeric AS sent_kg,
            COALESCE(SUM(received_kg) FILTER (WHERE status='Received'),0)::numeric AS received_kg,
            COALESCE(SUM(sent_kg) FILTER (WHERE status='Rejected'),0)::numeric AS rejected_kg,
            COALESCE(SUM(amount) FILTER (WHERE status='Received'),0)::numeric AS sales_amount,
            COALESCE(SUM(received_kg) FILTER (WHERE status='Received' AND proposal_id IS NOT NULL),0)::numeric AS surplus_kg
       FROM dairy.shipment WHERE coop_org_id=$1 AND ship_date BETWEEN $2 AND $3`, P,
  )).rows;
  const [proc] = (await c.query(
    `SELECT COALESCE(SUM(milk_used_kg),0)::numeric AS milk_used_kg, COALESCE(SUM(units),0)::int AS units
       FROM dairy.production_batch WHERE coop_org_id=$1 AND produced_on BETWEEN $2 AND $3`, P,
  )).rows;
  const [psale] = (await c.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS amount, COALESCE(SUM(amount) FILTER (WHERE school_id IS NOT NULL),0)::numeric AS school_amount
       FROM dairy.product_sale WHERE coop_org_id=$1 AND sold_on BETWEEN $2 AND $3`, P,
  )).rows;
  const [feed] = (await c.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS amount FROM dairy.member_issue WHERE coop_org_id=$1 AND issued_at::date BETWEEN $2 AND $3`, P,
  )).rows;
  const members = (await c.query(
    `SELECT m.member_code, m.full_name,
            COALESCE(SUM(i.weight_kg) FILTER (WHERE i.status='Accepted'),0)::numeric AS kg,
            COALESCE(SUM(i.amount),0)::numeric AS amount,
            ROUND(SUM(i.amount) / NULLIF(SUM(i.weight_kg) FILTER (WHERE i.status='Accepted'),0), 2) AS avg_price,
            COALESCE(SUM(i.weight_kg) FILTER (WHERE i.status='Rejected'),0)::numeric AS rejected_kg,
            (SELECT ROUND(AVG(t.fat_pct),2) FROM dairy.quality_test t WHERE t.member_id=m.member_id AND t.sample_date BETWEEN $2 AND $3) AS avg_fat,
            (SELECT ROUND(AVG(t.snf_pct),2) FROM dairy.quality_test t WHERE t.member_id=m.member_id AND t.sample_date BETWEEN $2 AND $3) AS avg_snf,
            (SELECT ROUND(AVG(t.scc_k),0) FROM dairy.quality_test t WHERE t.member_id=m.member_id AND t.sample_date BETWEEN $2 AND $3) AS avg_scc
       FROM dairy.member m LEFT JOIN dairy.milk_intake i ON i.member_id=m.member_id
        AND i.round_id IN (SELECT round_id FROM dairy.milk_round r WHERE r.coop_org_id=$1 AND r.round_date BETWEEN $2 AND $3)
      WHERE m.coop_org_id=$1 AND m.status <> 'Pending' GROUP BY m.member_id ORDER BY kg DESC`, P,
  )).rows;
  const fees = (await c.query(
    `SELECT fee_type, SUM(fee_amount)::numeric AS fee FROM dairy.platform_fee WHERE coop_org_id=$1 AND created_at::date BETWEEN $2 AND $3 GROUP BY 1`, P,
  )).rows;
  const [bio] = (await c.query(
    `SELECT COALESCE(SUM(manure_kg),0)::numeric AS manure_kg, COALESCE(SUM(gas_m3),0)::numeric AS gas_m3, COALESCE(SUM(electricity_kwh),0)::numeric AS electricity_kwh,
            COALESCE(SUM(digestate_revenue),0)::numeric AS digestate_revenue FROM dairy.biogas_log WHERE coop_org_id=$1 AND log_date BETWEEN $2 AND $3`, P,
  )).rows;
  const [herd] = (await c.query(
    `SELECT (SELECT COUNT(*) FROM dairy.animal_event e WHERE e.coop_org_id=$1 AND e.event_type='calving' AND e.event_date BETWEEN $2 AND $3)::int AS calvings,
            (SELECT COUNT(*) FROM dairy.animal_event e WHERE e.coop_org_id=$1 AND e.event_type='insemination' AND e.event_date BETWEEN $2 AND $3)::int AS inseminations,
            (SELECT COUNT(*) FROM dairy.animal_event e WHERE e.coop_org_id=$1 AND e.event_type='pregnancy_check' AND e.details->>'result'='positive' AND e.event_date BETWEEN $2 AND $3)::int AS pregnancies,
            (SELECT COUNT(*) FROM dairy.animal_event e WHERE e.coop_org_id=$1 AND e.event_type='treatment' AND e.event_date BETWEEN $2 AND $3)::int AS treatments`, P,
  )).rows;
  const balance = round2(Number(milk.accepted_kg) - Number(ship.sent_kg) - Number(proc.milk_used_kg));
  return {
    from, to, milk: { ...milk, avg_kg_day: milk.days ? round2(Number(milk.accepted_kg) / milk.days) : null }, rejects, shipments: ship,
    processing: proc, product_sales: psale, feed_sold: feed.amount, members, fees, biogas: bio, herd,
    milk_balance_kg: balance,
  };
})));

module.exports = router;
