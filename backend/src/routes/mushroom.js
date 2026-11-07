const express = require('express');
const crypto = require('crypto');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganizationOrStaff, resolveEffectiveOrgSubject } = require('../middleware/auth');
const M = require('../lib/mushroom');

const {
  h, tx, bad, notFound, conflict, round2, feeOf, bkkToday, isDate, num, needPos, needNonNeg, needUuid, isUuid,
  GRADES, PRODUCT_TYPES,
} = M;

/**
 * /mushroom — โปรแกรมบริหารจัดการการผลิตเห็ดฟางครบวงจร ฝั่งสหกรณ์
 * (ศูนย์ผลิตกล่องเพาะ). ดู backend/db/grant_straw_mushroom.sql สำหรับ schema
 * และข้อตัดสินใจทางธุรกิจ (กล่องฝากเลี้ยง, ราคาประกาศรายวัน, หักกลบรายสัปดาห์
 * ผ่าน ธ.ก.ส., ค่าบริการ % ผู้ขายจ่าย).
 *
 * ครอบคลุม 9 โมดูลตามเอกสารแนวทางพัฒนา: (1) ทะเบียนสมาชิก/จุดเปิดดอก
 * (2) วัตถุดิบชีวมวลและคลัง (3) ศูนย์ผลิตกล่องเพาะ + ทะเบียนกล่อง QR
 * (4) สมาชิกเปิดดอก (ฝั่งสหกรณ์: จอง แจกกล่อง รับคืน ปัญหา) (5) รับซื้อ คัดเกรด
 * แปรรูป (6) ตลาด/คำสั่งซื้อผู้ซื้อ (7) การเงินและหักกลบ (8) ขนส่งไป-กลับ
 * (9) IoT และรายงาน.
 *
 * SECURITY: ตาราง mushroom.* ไม่มี RLS — ทุก query ต้องมี coop_org_id = $1
 * (subjectId ของสหกรณ์ที่ login) นี่คือขอบเขตความปลอดภัยทั้งหมด. ทุก id ที่รับ
 * มาจาก client (member_id, partner_id, batch_id, ...) ต้องถูกตรวจว่าเป็นของ
 * สหกรณ์นี้ก่อนใช้เสมอ (ดู own()).
 */
const router = express.Router();

router.use(requireAuth, requireOrganizationOrStaff);

/** Same two-layer Cooperative check as coopcollection.js, staff-aware. */
async function requireCooperativeOrg(req, res, next) {
  try {
    const ok = await resolveEffectiveOrgSubject(req, res, ['Cooperative']);
    if (!ok) return undefined;
    const { subjectId } = req.subject;
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const org = await client.query(
        'SELECT org_id, org_name, org_type, kyb_status FROM identity.organization WHERE org_id = $1',
        [subjectId],
      );
      if (org.rows.length === 0) return { orgMissing: true };
      const orgRow = org.rows[0];
      if (orgRow.kyb_status !== 'Verified') return { kybNotVerified: true, org: orgRow };
      const role = await client.query(
        `SELECT status FROM identity.organization_role WHERE org_id = $1 AND role_type = 'Cooperative'`,
        [subjectId],
      );
      const roleStatus = role.rows[0] ? role.rows[0].status : null;
      if (roleStatus === 'Verified') await client.query('SELECT mushroom.ensure_coop_defaults($1)', [subjectId]);
      return { org: orgRow, roleStatus };
    });
    if (result.orgMissing) return res.status(403).json({ error: 'cooperative_subject_required' });
    if (result.kybNotVerified) {
      return res.status(403).json({ error: 'kyb_not_verified', kyb_status: result.org.kyb_status, org_name: result.org.org_name });
    }
    if (result.roleStatus !== 'Verified') {
      return res.status(403).json({
        error: 'role_not_verified', role_type: 'Cooperative', role_status: result.roleStatus, org_name: result.org.org_name,
      });
    }
    req.org = result.org;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(requireCooperativeOrg);

/** Shorthand: run fn(client, coopId) in the coop's session context. */
const db = (req, fn) => withSessionContext('organization', req.subject.subjectId, (client) => fn(client, req.subject.subjectId));

const actor = (req) => (req.actingStaff ? `staff:${req.actingStaff.memberId}` : `org:${req.subject.subjectId}`);

const OWN_TABLES = {
  member: ['mushroom.member', 'member_id'],
  partner: ['mushroom.partner', 'partner_id'],
  material: ['mushroom.material', 'material_id'],
  recipe: ['mushroom.recipe', 'recipe_id'],
  batch: ['mushroom.batch', 'batch_id'],
  box: ['mushroom.box', 'box_id'],
  box_type: ['mushroom.box_type', 'box_type_id'],
  spawn_lot: ['mushroom.spawn_lot', 'spawn_lot_id'],
  po: ['mushroom.purchase_order', 'po_id'],
  trip: ['mushroom.trip', 'trip_id'],
  lot: ['mushroom.product_lot', 'lot_id'],
  order: ['mushroom.sales_order', 'order_id'],
  booking: ['mushroom.box_booking', 'booking_id'],
  issue: ['mushroom.issue_report', 'report_id'],
  run: ['mushroom.settlement_run', 'run_id'],
  device: ['mushroom.iot_device', 'device_id'],
};

/**
 * Loads one row of `kind` by id, ONLY if it belongs to this cooperative.
 * Throws 404 otherwise (never reveals rows of another cooperative).
 * `lock` adds FOR UPDATE (use inside tx()).
 */
async function own(client, coopId, kind, id, { lock = false } = {}) {
  const [table, pk] = OWN_TABLES[kind];
  if (!isUuid(id)) throw notFound(`${kind}_not_found`);
  const r = await client.query(
    `SELECT * FROM ${table} WHERE ${pk} = $1 AND coop_org_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [id, coopId],
  );
  if (r.rows.length === 0) throw notFound(`${kind}_not_found`);
  return r.rows[0];
}

async function settings(client, coopId) {
  const r = await client.query('SELECT * FROM mushroom.setting WHERE coop_org_id = $1', [coopId]);
  return r.rows[0];
}

async function addLedger(client, coopId, memberId, entryType, amount, refType, refId, note, entryDate) {
  if (Number(amount) === 0) return;
  await client.query(
    `INSERT INTO mushroom.member_ledger (coop_org_id, member_id, entry_type, amount, ref_type, ref_id, note, entry_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, CURRENT_DATE))`,
    [coopId, memberId, entryType, round2(amount), refType, refId, note || null, entryDate || bkkToday()],
  );
}

async function addPlatformFee(client, coopId, feeType, payerType, payerRef, base, rate, refType, refId) {
  const fee = feeOf(base, rate);
  await client.query(
    `INSERT INTO mushroom.platform_fee (coop_org_id, fee_type, payer_type, payer_ref, base_amount, rate_pct, fee_amount, ref_type, ref_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (ref_type, ref_id, fee_type) DO NOTHING`,
    [coopId, feeType, payerType, payerRef, round2(base), rate, fee, refType, refId],
  );
  return fee;
}

// ===========================================================================
// ภาพรวม
// ===========================================================================
router.get('/overview', h(async (req) => db(req, async (c, coop) => {
  const today = bkkToday();
  const q = (sql, p = [coop]) => c.query(sql, p).then((r) => r.rows);
  const [members] = await q(`SELECT COUNT(*) FILTER (WHERE status='Approved')::int AS approved,
                                    COUNT(*) FILTER (WHERE status='Pending')::int AS pending
                               FROM mushroom.member WHERE coop_org_id=$1`);
  const boxes = await q(`SELECT status, COUNT(*)::int AS n FROM mushroom.box WHERE coop_org_id=$1 GROUP BY status`);
  const batches = await q(`SELECT status, COUNT(*)::int AS n FROM mushroom.batch WHERE coop_org_id=$1
                            AND status NOT IN ('Closed','Failed') GROUP BY status`);
  const prices = await q(`SELECT grade, price_per_kg FROM mushroom.daily_price WHERE coop_org_id=$1 AND price_date=$2`, [coop, today]);
  const [week] = await q(`SELECT COALESCE(SUM(weight_kg),0)::numeric AS kg, COALESCE(SUM(amount),0)::numeric AS amount
                            FROM mushroom.harvest WHERE coop_org_id=$1 AND collected_at >= now() - interval '7 days'`);
  const [issues] = await q(`SELECT COUNT(*)::int AS n FROM mushroom.issue_report WHERE coop_org_id=$1 AND status='Open'`);
  const [orders] = await q(`SELECT COUNT(*)::int AS n FROM mushroom.sales_order WHERE coop_org_id=$1 AND status IN ('Requested','Confirmed')`);
  const [bookings] = await q(`SELECT COUNT(*)::int AS n FROM mushroom.box_booking WHERE coop_org_id=$1 AND status='Requested'`);
  const [alerts] = await q(`SELECT COUNT(*)::int AS n FROM mushroom.iot_alert a JOIN mushroom.iot_device d USING (device_id)
                             WHERE d.coop_org_id=$1 AND a.acknowledged_at IS NULL`);
  const [unsettled] = await q(`SELECT COALESCE(SUM(amount),0)::numeric AS net FROM mushroom.member_ledger WHERE coop_org_id=$1 AND run_id IS NULL`);
  const lowStock = await q(`SELECT m.name, m.reorder_level_kg,
                                   COALESCE(SUM(CASE WHEN mm.direction='in' THEN mm.qty_kg ELSE -mm.qty_kg END),0)::numeric AS stock_kg
                              FROM mushroom.material m LEFT JOIN mushroom.material_movement mm ON mm.material_id=m.material_id
                             WHERE m.coop_org_id=$1 AND m.active AND m.reorder_level_kg > 0
                             GROUP BY m.material_id HAVING COALESCE(SUM(CASE WHEN mm.direction='in' THEN mm.qty_kg ELSE -mm.qty_kg END),0) < m.reorder_level_kg`);
  const s = await settings(c, coop);
  await logAccess(c, 'read', 'mushroom.overview', coop);
  const byStatus = (rows) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return {
    org_name: req.org.org_name,
    today,
    members,
    boxes_by_status: byStatus(boxes),
    batches_by_status: byStatus(batches),
    prices_today: Object.fromEntries(prices.map((p) => [p.grade, p.price_per_kg])),
    harvest_7d: week,
    open_issues: issues.n,
    open_orders: orders.n,
    pending_bookings: bookings.n,
    open_iot_alerts: alerts.n,
    unsettled_net: unsettled.net,
    low_stock: lowStock,
    settings_incomplete: Number(s.fee_rate_member_sale_pct) === 0 && Number(s.fee_rate_spawn_pct) === 0
      && Number(s.fee_rate_substrate_pct) === 0 && Number(s.fee_rate_external_sale_pct) === 0,
  };
})));

// ===========================================================================
// ตั้งค่า (อัตรา % ค่าบริการ ราคาฟาง ราคากล่อง) — แก้ได้ และบันทึกประวัติ
// ===========================================================================
const SETTING_FIELDS = {
  fee_rate_spawn_pct: { min: 0, max: 100 },
  fee_rate_substrate_pct: { min: 0, max: 100 },
  fee_rate_member_sale_pct: { min: 0, max: 100 },
  fee_rate_external_sale_pct: { min: 0, max: 100 },
  straw_price_per_kg: { min: 0, max: 1000 },
  settlement_weekday: { min: 0, max: 6, int: true },
  spawn_run_temp_min: { min: 0, max: 60 },
  spawn_run_temp_max: { min: 0, max: 60 },
  spawn_run_days: { min: 1, max: 30, int: true },
  max_delivery_km: { min: 1, max: 1000 },
};

router.get('/settings', h(async (req) => db(req, async (c, coop) => {
  const s = await settings(c, coop);
  const types = await c.query(
    'SELECT box_type_id, name, replacement_price, active FROM mushroom.box_type WHERE coop_org_id=$1 ORDER BY created_at',
    [coop],
  );
  const hist = await c.query(
    `SELECT field_name, old_value, new_value, changed_by, changed_at FROM mushroom.setting_history
      WHERE coop_org_id=$1 ORDER BY changed_at DESC LIMIT 50`,
    [coop],
  );
  return { settings: s, box_types: types.rows, history: hist.rows };
})));

router.put('/settings', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const body = req.body || {};
  const cur = (await c.query('SELECT * FROM mushroom.setting WHERE coop_org_id=$1 FOR UPDATE', [coop])).rows[0];
  const changes = [];
  Object.entries(SETTING_FIELDS).forEach(([field, rule]) => {
    if (!(field in body)) return;
    const v = num(body[field], rule);
    if (v === null || Number.isNaN(v) || (rule.int && !Number.isInteger(v))) throw bad('invalid_field', { field });
    if (Number(cur[field]) !== v) changes.push([field, cur[field], v]);
  });
  const tmin = 'spawn_run_temp_min' in body ? Number(body.spawn_run_temp_min) : Number(cur.spawn_run_temp_min);
  const tmax = 'spawn_run_temp_max' in body ? Number(body.spawn_run_temp_max) : Number(cur.spawn_run_temp_max);
  if (tmin > tmax) throw bad('invalid_temp_range');
  for (const [field, oldV, newV] of changes) {
    await c.query(`UPDATE mushroom.setting SET ${field}=$2, updated_at=now() WHERE coop_org_id=$1`, [coop, newV]);
    await c.query(
      `INSERT INTO mushroom.setting_history (coop_org_id, field_name, old_value, new_value, changed_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [coop, field, String(oldV), String(newV), actor(req)],
    );
  }
  await logAccess(c, 'write', 'mushroom.setting', coop);
  return { updated: changes.map((x) => x[0]), settings: await settings(c, coop) };
}))));

router.post('/box-types', h(async (req) => db(req, async (c, coop) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) throw bad('missing_name');
  const price = needNonNeg(req.body.replacement_price ?? 0, 'replacement_price');
  try {
    const r = await c.query(
      `INSERT INTO mushroom.box_type (coop_org_id, name, replacement_price) VALUES ($1,$2,$3) RETURNING *`,
      [coop, name, price],
    );
    await c.query(
      `INSERT INTO mushroom.setting_history (coop_org_id, field_name, old_value, new_value, changed_by)
       VALUES ($1,$2,NULL,$3,$4)`,
      [coop, `box_type:${name}:replacement_price`, String(price), actor(req)],
    );
    return r.rows[0];
  } catch (e) {
    if (e.code === '23505') throw conflict('box_type_exists');
    throw e;
  }
})));

router.put('/box-types/:id', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const t = await own(c, coop, 'box_type', req.params.id, { lock: true });
  const b = req.body || {};
  if ('replacement_price' in b) {
    const price = needNonNeg(b.replacement_price, 'replacement_price');
    if (Number(t.replacement_price) !== price) {
      await c.query('UPDATE mushroom.box_type SET replacement_price=$2 WHERE box_type_id=$1', [t.box_type_id, price]);
      await c.query(
        `INSERT INTO mushroom.setting_history (coop_org_id, field_name, old_value, new_value, changed_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [coop, `box_type:${t.name}:replacement_price`, String(t.replacement_price), String(price), actor(req)],
      );
    }
  }
  if ('active' in b) await c.query('UPDATE mushroom.box_type SET active=$2 WHERE box_type_id=$1', [t.box_type_id, !!b.active]);
  return (await c.query('SELECT * FROM mushroom.box_type WHERE box_type_id=$1', [t.box_type_id])).rows[0];
}))));

// ===========================================================================
// (1) สมาชิกและจุดเปิดดอก
// ===========================================================================
router.get('/farmers/lookup', h(async (req) => db(req, async (c) => {
  const phone = String(req.query.phone || '').replace(/\D/g, '');
  if (phone.length < 9) throw bad('invalid_phone');
  const r = await c.query(
    `SELECT farmer_id, full_name, phone, farmer_code FROM identity.farmer
      WHERE regexp_replace(phone, '\\D', '', 'g') = $1 LIMIT 5`,
    [phone],
  );
  return r.rows;
})));

const MEMBER_FIELDS = ['full_name', 'phone', 'address', 'lat', 'lng', 'distance_km', 'capacity_boxes', 'wind_protected',
  'water_available', 'site_photo_url', 'baac_account_no', 'baac_account_name', 'consent_finance_share', 'note'];

function memberValues(b) {
  const out = {};
  MEMBER_FIELDS.forEach((f) => {
    if (!(f in b)) return;
    let v = b[f];
    if (['lat', 'lng', 'distance_km'].includes(f)) {
      v = num(v, f === 'lat' ? { min: -90, max: 90 } : f === 'lng' ? { min: -180, max: 180 } : { min: 0 });
      if (Number.isNaN(v)) throw bad('invalid_field', { field: f });
    } else if (f === 'capacity_boxes') {
      v = num(v, { min: 0 });
      if (v === null || Number.isNaN(v) || !Number.isInteger(v)) throw bad('invalid_field', { field: f });
    } else if (['wind_protected', 'water_available', 'consent_finance_share'].includes(f)) {
      v = !!v;
    } else if (f === 'baac_account_no') {
      v = v ? String(v).replace(/[\s-]/g, '') : null;
      if (v && !/^\d{10,15}$/.test(v)) throw bad('invalid_baac_account_no');
    } else {
      v = v === null || v === undefined ? null : String(v).trim() || null;
    }
    out[f] = v;
  });
  return out;
}

router.get('/members', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(
    `SELECT m.*,
            (SELECT COUNT(*)::int FROM mushroom.box_assignment a WHERE a.member_id=m.member_id AND a.returned_at IS NULL) AS boxes_on_hand,
            (SELECT COALESCE(SUM(amount),0) FROM mushroom.member_ledger l WHERE l.member_id=m.member_id AND l.run_id IS NULL) AS unsettled_net
       FROM mushroom.member m WHERE m.coop_org_id=$1 ORDER BY m.status, m.member_code`,
    [coop],
  );
  await logAccess(c, 'read', 'mushroom.member', coop);
  return r.rows;
})));

router.post('/members', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = req.body || {};
  const vals = memberValues(b);
  let farmerId = null;
  if (b.farmer_id) {
    farmerId = needUuid(b.farmer_id, 'farmer_id');
    const f = await c.query('SELECT full_name, phone FROM identity.farmer WHERE farmer_id=$1', [farmerId]);
    if (!f.rows.length) throw notFound('farmer_not_found');
    vals.full_name = vals.full_name || f.rows[0].full_name;
    vals.phone = vals.phone || f.rows[0].phone;
  }
  if (!vals.full_name) throw bad('missing_full_name');
  const n = (await c.query('SELECT COUNT(*)::int AS n FROM mushroom.member WHERE coop_org_id=$1', [coop])).rows[0].n;
  const code = String(b.member_code || '').trim() || `M${String(n + 1).padStart(4, '0')}`;
  const cols = ['coop_org_id', 'farmer_id', 'member_code', ...Object.keys(vals)];
  const params = [coop, farmerId, code, ...Object.values(vals)];
  try {
    const r = await c.query(
      `INSERT INTO mushroom.member (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      params,
    );
    await logAccess(c, 'write', 'mushroom.member', r.rows[0].member_id);
    return r.rows[0];
  } catch (e) {
    if (e.code === '23505') throw conflict('member_exists');
    throw e;
  }
}))));

router.put('/members/:id', h(async (req) => db(req, async (c, coop) => {
  const m = await own(c, coop, 'member', req.params.id);
  const vals = memberValues(req.body || {});
  if ('full_name' in vals && !vals.full_name) throw bad('missing_full_name');
  const keys = Object.keys(vals);
  if (!keys.length) return m;
  const r = await c.query(
    `UPDATE mushroom.member SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE member_id=$1 RETURNING *`,
    [m.member_id, ...Object.values(vals)],
  );
  await logAccess(c, 'write', 'mushroom.member', m.member_id);
  return r.rows[0];
})));

router.post('/members/:id/status', h(async (req) => db(req, async (c, coop) => {
  const m = await own(c, coop, 'member', req.params.id);
  const status = (req.body || {}).status;
  if (!['Approved', 'Suspended', 'Pending'].includes(status)) throw bad('invalid_status');
  if (status === 'Approved' && !(m.wind_protected && m.water_available)) {
    throw bad('site_not_ready', { detail: 'จุดเปิดดอกต้องกันลมและมีน้ำก่อนอนุมัติ' });
  }
  const r = await c.query(
    `UPDATE mushroom.member SET status=$2, approved_at = CASE WHEN $2='Approved' THEN now() ELSE approved_at END
      WHERE member_id=$1 RETURNING *`,
    [m.member_id, status],
  );
  return r.rows[0];
})));

// ===========================================================================
// คู่ค้า (ผู้ขายวัสดุ ผู้ขายเชื้อ ผู้ซื้อ ผู้ขนส่ง)
// ===========================================================================
const PARTNER_TYPES = ['biomass_seller', 'spawn_seller', 'buyer', 'transporter'];

router.get('/partners', h(async (req) => db(req, async (c, coop) => {
  const params = [coop];
  let f = '';
  if (req.query.type) {
    if (!PARTNER_TYPES.includes(req.query.type)) throw bad('invalid_type');
    params.push(req.query.type);
    f = 'AND p.partner_type=$2';
  }
  const r = await c.query(
    `SELECT p.*, o.org_name AS linked_org_name FROM mushroom.partner p
       LEFT JOIN identity.organization o ON o.org_id=p.linked_org_id
      WHERE p.coop_org_id=$1 ${f} ORDER BY p.partner_type, p.name`,
    params,
  );
  return r.rows;
})));

router.get('/linkable-orgs', h(async (req) => db(req, async (c) => {
  const qtext = String(req.query.q || '').trim();
  if (qtext.length < 2) throw bad('query_too_short');
  const r = await c.query(
    `SELECT org_id, org_name, org_type FROM identity.organization
      WHERE kyb_status='Verified' AND org_name ILIKE $1 ORDER BY org_name LIMIT 20`,
    [`%${qtext}%`],
  );
  return r.rows;
})));

async function partnerValues(c, b, partial) {
  const out = {};
  if (!partial || 'partner_type' in b) {
    if (!PARTNER_TYPES.includes(b.partner_type)) throw bad('invalid_partner_type');
    out.partner_type = b.partner_type;
  }
  if (!partial || 'name' in b) {
    const name = String(b.name || '').trim();
    if (!name) throw bad('missing_name');
    out.name = name;
  }
  ['contact_name', 'phone', 'address', 'note'].forEach((f) => {
    if (f in b) out[f] = b[f] ? String(b[f]).trim() : null;
  });
  if ('active' in b) out.active = !!b.active;
  if ('linked_org_id' in b) {
    if (b.linked_org_id) {
      const id = needUuid(b.linked_org_id, 'linked_org_id');
      const o = await c.query(`SELECT 1 FROM identity.organization WHERE org_id=$1 AND kyb_status='Verified'`, [id]);
      if (!o.rows.length) throw notFound('linked_org_not_found');
      out.linked_org_id = id;
    } else out.linked_org_id = null;
  }
  return out;
}

router.post('/partners', h(async (req) => db(req, async (c, coop) => {
  const vals = await partnerValues(c, req.body || {}, false);
  const cols = ['coop_org_id', ...Object.keys(vals)];
  const r = await c.query(
    `INSERT INTO mushroom.partner (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    [coop, ...Object.values(vals)],
  );
  return r.rows[0];
})));

router.put('/partners/:id', h(async (req) => db(req, async (c, coop) => {
  const p = await own(c, coop, 'partner', req.params.id);
  const vals = await partnerValues(c, req.body || {}, true);
  const keys = Object.keys(vals);
  if (!keys.length) return p;
  const r = await c.query(
    `UPDATE mushroom.partner SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE partner_id=$1 RETURNING *`,
    [p.partner_id, ...Object.values(vals)],
  );
  return r.rows[0];
})));

// ===========================================================================
// (2) วัตถุดิบชีวมวลและคลัง
// ===========================================================================
const STOCK_SQL = `
  SELECT m.material_id, m.code, m.name, m.category, m.reorder_level_kg, m.active,
         COALESCE(SUM(CASE WHEN mm.direction='in' THEN mm.qty_kg ELSE -mm.qty_kg END),0)::numeric(14,2) AS stock_kg,
         COALESCE(ROUND(SUM(mm.qty_kg*mm.unit_price) FILTER (WHERE mm.direction='in' AND mm.unit_price>0)
           / NULLIF(SUM(mm.qty_kg) FILTER (WHERE mm.direction='in' AND mm.unit_price>0),0), 2), 0)::numeric(12,2) AS avg_cost_per_kg
    FROM mushroom.material m
    LEFT JOIN mushroom.material_movement mm ON mm.material_id=m.material_id
   WHERE m.coop_org_id=$1`;

router.get('/materials', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(`${STOCK_SQL} GROUP BY m.material_id ORDER BY m.category, m.name`, [coop]);
  return r.rows;
})));

router.post('/materials', h(async (req) => db(req, async (c, coop) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const code = String(b.code || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!name || !code) throw bad('missing_name_or_code');
  if (!['main', 'mix', 'supplement'].includes(b.category || 'main')) throw bad('invalid_category');
  try {
    const r = await c.query(
      `INSERT INTO mushroom.material (coop_org_id, code, name, category, reorder_level_kg)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [coop, code, name, b.category || 'main', needNonNeg(b.reorder_level_kg ?? 0, 'reorder_level_kg')],
    );
    return r.rows[0];
  } catch (e) {
    if (e.code === '23505') throw conflict('material_code_exists');
    throw e;
  }
})));

router.put('/materials/:id', h(async (req) => db(req, async (c, coop) => {
  const m = await own(c, coop, 'material', req.params.id);
  const b = req.body || {};
  const name = 'name' in b ? String(b.name || '').trim() : m.name;
  if (!name) throw bad('missing_name');
  const reorder = 'reorder_level_kg' in b ? needNonNeg(b.reorder_level_kg, 'reorder_level_kg') : m.reorder_level_kg;
  const active = 'active' in b ? !!b.active : m.active;
  const r = await c.query(
    'UPDATE mushroom.material SET name=$2, reorder_level_kg=$3, active=$4 WHERE material_id=$1 RETURNING *',
    [m.material_id, name, reorder, active],
  );
  return r.rows[0];
})));

router.get('/material-movements', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(
    `SELECT mm.*, m.name AS material_name, mb.full_name AS member_name, b.batch_code
       FROM mushroom.material_movement mm
       JOIN mushroom.material m ON m.material_id=mm.material_id
       LEFT JOIN mushroom.member mb ON mb.member_id=mm.member_id
       LEFT JOIN mushroom.batch b ON b.batch_id=mm.batch_id
      WHERE mm.coop_org_id=$1 ORDER BY mm.moved_at DESC LIMIT 200`,
    [coop],
  );
  return r.rows;
})));

/** สมาชิกส่งฟาง — เข้าคลัง + เครดิตบัญชีสมาชิก (ราคาฟางตามที่ตั้งค่าไว้ หรือระบุ) */
router.post('/straw-receipts', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = req.body || {};
  const member = await own(c, coop, 'member', b.member_id);
  const qty = needPos(b.qty_kg, 'qty_kg');
  const moisture = num(b.moisture_pct, { min: 0, max: 100 });
  if (Number.isNaN(moisture)) throw bad('invalid_field', { field: 'moisture_pct' });
  const s = await settings(c, coop);
  const price = b.price_per_kg !== undefined && b.price_per_kg !== '' ? needNonNeg(b.price_per_kg, 'price_per_kg') : Number(s.straw_price_per_kg);
  const mat = (await c.query(`SELECT material_id FROM mushroom.material WHERE coop_org_id=$1 AND code='rice_straw'`, [coop])).rows[0];
  const mv = await c.query(
    `INSERT INTO mushroom.material_movement (coop_org_id, material_id, direction, qty_kg, unit_price, moisture_pct, source_type, member_id, note)
     VALUES ($1,$2,'in',$3,$4,$5,'member_straw',$6,$7) RETURNING *`,
    [coop, mat.material_id, qty, price, moisture, member.member_id, b.note || null],
  );
  await addLedger(c, coop, member.member_id, 'straw_sale', qty * price, 'material_movement', mv.rows[0].movement_id,
    `ส่งฟาง ${qty} กก. x ${price} บาท`);
  return mv.rows[0];
}))));

router.post('/material-adjust', h(async (req) => db(req, async (c, coop) => {
  const b = req.body || {};
  const m = await own(c, coop, 'material', b.material_id);
  if (!['in', 'out'].includes(b.direction)) throw bad('invalid_direction');
  const qty = needPos(b.qty_kg, 'qty_kg');
  const note = String(b.note || '').trim();
  if (!note) throw bad('missing_note');
  const r = await c.query(
    `INSERT INTO mushroom.material_movement (coop_org_id, material_id, direction, qty_kg, unit_price, source_type, note)
     VALUES ($1,$2,$3,$4,$5,'adjust',$6) RETURNING *`,
    [coop, m.material_id, b.direction, qty, b.direction === 'in' ? needNonNeg(b.unit_price ?? 0, 'unit_price') : 0, note],
  );
  return r.rows[0];
})));

// ---- ใบสั่งซื้อวัสดุเพาะ / เชื้อเห็ด ----
router.get('/purchase-orders', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(
    `SELECT po.*, p.name AS partner_name, p.partner_type,
            COALESCE(json_agg(l ORDER BY l.item_name) FILTER (WHERE l.line_id IS NOT NULL), '[]') AS lines
       FROM mushroom.purchase_order po
       JOIN mushroom.partner p ON p.partner_id=po.partner_id
       LEFT JOIN mushroom.purchase_order_line l ON l.po_id=po.po_id
      WHERE po.coop_org_id=$1 GROUP BY po.po_id, p.partner_id ORDER BY po.ordered_at DESC LIMIT 200`,
    [coop],
  );
  return r.rows;
})));

router.post('/purchase-orders', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = req.body || {};
  if (!['substrate', 'spawn'].includes(b.po_type)) throw bad('invalid_po_type');
  const partner = await own(c, coop, 'partner', b.partner_id);
  const want = b.po_type === 'spawn' ? 'spawn_seller' : 'biomass_seller';
  if (partner.partner_type !== want) throw bad('partner_type_mismatch', { expected: want });
  const lines = Array.isArray(b.lines) ? b.lines : [];
  if (!lines.length) throw bad('missing_lines');
  if (b.expected_date && !isDate(b.expected_date)) throw bad('invalid_expected_date');
  const po = (await c.query(
    `INSERT INTO mushroom.purchase_order (coop_org_id, partner_id, po_type, expected_date, note)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [coop, partner.partner_id, b.po_type, b.expected_date || null, b.note || null],
  )).rows[0];
  let total = 0;
  for (const ln of lines) {
    const qty = needPos(ln.qty, 'qty');
    const price = needNonNeg(ln.unit_price ?? 0, 'unit_price');
    let materialId = null;
    let itemName = String(ln.item_name || '').trim();
    if (b.po_type === 'substrate') {
      const m = await own(c, coop, 'material', ln.material_id);
      materialId = m.material_id;
      itemName = m.name;
    } else if (!itemName) itemName = 'เชื้อเห็ดฟาง';
    const amount = round2(qty * price);
    total += amount;
    await c.query(
      `INSERT INTO mushroom.purchase_order_line (po_id, material_id, item_name, qty, unit, unit_price, amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [po.po_id, materialId, itemName, qty, b.po_type === 'spawn' ? 'ถุง' : 'kg', price, amount],
    );
  }
  await c.query('UPDATE mushroom.purchase_order SET total_amount=$2 WHERE po_id=$1', [po.po_id, round2(total)]);
  await logAccess(c, 'write', 'mushroom.purchase_order', po.po_id);
  return { ...po, total_amount: round2(total) };
}))));

/**
 * รับของตามใบสั่งซื้อ: วัสดุ -> เข้าคลังที่ราคาตามใบสั่งซื้อ, เชื้อ -> สร้าง spawn_lot
 * (ต้องมีเลขล็อต จากผู้ขายตอนยืนยัน หรือกรอกตอนรับ). คิดค่าบริการ AgroLink
 * จากยอดซื้อ ผู้ขาย (partner) เป็นผู้จ่าย.
 */
router.post('/purchase-orders/:id/deliver', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const po = await own(c, coop, 'po', req.params.id, { lock: true });
  if (!['Ordered', 'Confirmed'].includes(po.status)) throw conflict('invalid_po_status', { status: po.status });
  const lines = (await c.query('SELECT *, spawn_produced_on::text AS produced_txt FROM mushroom.purchase_order_line WHERE po_id=$1', [po.po_id])).rows;
  const lotInput = Array.isArray((req.body || {}).spawn_lots) ? req.body.spawn_lots : [];
  for (const ln of lines) {
    if (po.po_type === 'substrate') {
      await c.query(
        `INSERT INTO mushroom.material_movement (coop_org_id, material_id, direction, qty_kg, unit_price, source_type, po_id)
         VALUES ($1,$2,'in',$3,$4,'purchase',$5)`,
        [coop, ln.material_id, ln.qty, ln.unit_price, po.po_id],
      );
    } else {
      const given = lotInput.find((x) => x.line_id === ln.line_id) || {};
      const lotNo = String(given.lot_no || ln.spawn_lot_no || '').trim();
      if (!lotNo) throw bad('missing_spawn_lot_no', { line_id: ln.line_id });
      const producedOn = given.produced_on || ln.produced_txt || null;
      if (producedOn && !isDate(String(producedOn))) throw bad('invalid_produced_on');
      await c.query(
        `INSERT INTO mushroom.spawn_lot (coop_org_id, partner_id, po_id, lot_no, produced_on, qty_bags, unit_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [coop, po.partner_id, po.po_id, lotNo, producedOn, ln.qty, ln.unit_price],
      );
    }
  }
  const s = await settings(c, coop);
  const rate = po.po_type === 'spawn' ? s.fee_rate_spawn_pct : s.fee_rate_substrate_pct;
  const fee = await addPlatformFee(c, coop, po.po_type === 'spawn' ? 'spawn_purchase' : 'substrate_purchase', 'partner',
    po.partner_id, po.total_amount, rate, 'purchase_order', po.po_id);
  const r = await c.query(
    `UPDATE mushroom.purchase_order SET status='Delivered', delivered_at=now(), fee_rate_pct=$2, fee_amount=$3
      WHERE po_id=$1 RETURNING *`,
    [po.po_id, rate, fee],
  );
  return r.rows[0];
}))));

router.post('/purchase-orders/:id/cancel', h(async (req) => db(req, async (c, coop) => {
  const po = await own(c, coop, 'po', req.params.id);
  if (!['Ordered', 'Confirmed'].includes(po.status)) throw conflict('invalid_po_status', { status: po.status });
  return (await c.query(`UPDATE mushroom.purchase_order SET status='Cancelled' WHERE po_id=$1 RETURNING *`, [po.po_id])).rows[0];
})));

router.post('/purchase-orders/:id/paid', h(async (req) => db(req, async (c, coop) => {
  const po = await own(c, coop, 'po', req.params.id);
  if (po.status !== 'Delivered') throw conflict('invalid_po_status', { status: po.status });
  return (await c.query('UPDATE mushroom.purchase_order SET paid_at=now() WHERE po_id=$1 RETURNING *', [po.po_id])).rows[0];
})));

router.get('/spawn-lots', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(
    `SELECT s.*, p.name AS partner_name, (s.qty_bags - s.qty_used_bags) AS remaining_bags
       FROM mushroom.spawn_lot s LEFT JOIN mushroom.partner p ON p.partner_id=s.partner_id
      WHERE s.coop_org_id=$1 ORDER BY s.received_at DESC`,
    [coop],
  );
  return r.rows;
})));

// ===========================================================================
// (3) ศูนย์ผลิตกล่องเพาะ: สูตร รุ่นการผลิต ทะเบียนกล่อง QR
// ===========================================================================
router.get('/recipes', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(
    `SELECT r.*, COALESCE(json_agg(json_build_object('material_id', i.material_id, 'name', m.name, 'pct', i.pct)
              ORDER BY i.pct DESC) FILTER (WHERE i.material_id IS NOT NULL), '[]') AS items
       FROM mushroom.recipe r
       LEFT JOIN mushroom.recipe_item i ON i.recipe_id=r.recipe_id
       LEFT JOIN mushroom.material m ON m.material_id=i.material_id
      WHERE r.coop_org_id=$1 GROUP BY r.recipe_id ORDER BY r.active DESC, r.created_at DESC`,
    [coop],
  );
  return r.rows;
})));

async function writeRecipeItems(c, coop, recipeId, items) {
  if (!Array.isArray(items) || !items.length) throw bad('missing_items');
  let sum = 0;
  const seen = new Set();
  for (const it of items) {
    const m = await own(c, coop, 'material', it.material_id);
    if (seen.has(m.material_id)) throw bad('duplicate_material');
    seen.add(m.material_id);
    sum += needPos(it.pct, 'pct');
  }
  if (Math.abs(sum - 100) > 0.5) throw bad('pct_must_total_100', { total: round2(sum) });
  await c.query('DELETE FROM mushroom.recipe_item WHERE recipe_id=$1', [recipeId]);
  for (const it of items) {
    await c.query('INSERT INTO mushroom.recipe_item (recipe_id, material_id, pct) VALUES ($1,$2,$3)', [recipeId, it.material_id, Number(it.pct)]);
  }
}

router.post('/recipes', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) throw bad('missing_name');
  const r = (await c.query(
    `INSERT INTO mushroom.recipe (coop_org_id, name, kg_per_box, spawn_bags_per_box, approved_by, note)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [coop, name, needPos(b.kg_per_box, 'kg_per_box'), needNonNeg(b.spawn_bags_per_box ?? 0, 'spawn_bags_per_box'),
      b.approved_by || null, b.note || null],
  )).rows[0];
  await writeRecipeItems(c, coop, r.recipe_id, b.items);
  return r;
}))));

router.put('/recipes/:id', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const r = await own(c, coop, 'recipe', req.params.id, { lock: true });
  const b = req.body || {};
  const name = 'name' in b ? String(b.name || '').trim() : r.name;
  if (!name) throw bad('missing_name');
  await c.query(
    `UPDATE mushroom.recipe SET name=$2, kg_per_box=$3, spawn_bags_per_box=$4, approved_by=$5, note=$6, active=$7 WHERE recipe_id=$1`,
    [r.recipe_id, name,
      'kg_per_box' in b ? needPos(b.kg_per_box, 'kg_per_box') : r.kg_per_box,
      'spawn_bags_per_box' in b ? needNonNeg(b.spawn_bags_per_box, 'spawn_bags_per_box') : r.spawn_bags_per_box,
      'approved_by' in b ? b.approved_by || null : r.approved_by,
      'note' in b ? b.note || null : r.note,
      'active' in b ? !!b.active : r.active],
  );
  if ('items' in b) await writeRecipeItems(c, coop, r.recipe_id, b.items);
  return (await c.query('SELECT * FROM mushroom.recipe WHERE recipe_id=$1', [r.recipe_id])).rows[0];
}))));

// ---- ทะเบียนกล่อง ----
router.get('/boxes', h(async (req) => db(req, async (c, coop) => {
  const params = [coop];
  let f = '';
  if (req.query.status) { params.push(req.query.status); f = 'AND b.status=$2'; }
  const r = await c.query(
    `SELECT b.box_id, b.qr_code, b.status, t.name AS box_type, t.replacement_price,
            bt.batch_code, m.full_name AS member_name, m.member_code
       FROM mushroom.box b JOIN mushroom.box_type t ON t.box_type_id=b.box_type_id
       LEFT JOIN mushroom.batch bt ON bt.batch_id=b.current_batch_id
       LEFT JOIN mushroom.member m ON m.member_id=b.current_member_id
      WHERE b.coop_org_id=$1 ${f} ORDER BY b.qr_code LIMIT 2000`,
    params,
  );
  return r.rows;
})));

router.get('/boxes/summary', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(
    `SELECT t.name AS box_type, b.status, COUNT(*)::int AS n FROM mushroom.box b
       JOIN mushroom.box_type t ON t.box_type_id=b.box_type_id WHERE b.coop_org_id=$1 GROUP BY 1,2 ORDER BY 1,2`,
    [coop],
  );
  return r.rows;
})));

/** ลงทะเบียนกล่องใหม่ครั้งละหลายใบ — สร้างรหัส QR ให้อัตโนมัติ */
router.post('/boxes/bulk', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = req.body || {};
  const type = await own(c, coop, 'box_type', b.box_type_id);
  const count = num(b.count, { min: 1, max: 2000 });
  if (!count || Number.isNaN(count) || !Number.isInteger(count)) throw bad('invalid_count', { max: 2000 });
  const prefix = String(b.prefix || 'BX').replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'BX';
  const tag = coop.replace(/-/g, '').slice(0, 6).toUpperCase();
  const start = (await c.query('SELECT COUNT(*)::int AS n FROM mushroom.box WHERE coop_org_id=$1', [coop])).rows[0].n;
  const codes = [];
  for (let i = 1; i <= count; i += 1) codes.push(`${prefix}-${tag}-${String(start + i).padStart(5, '0')}`);
  await c.query(
    `INSERT INTO mushroom.box (coop_org_id, box_type_id, qr_code) SELECT $1, $2, unnest($3::text[])`,
    [coop, type.box_type_id, codes],
  );
  return { created: count, box_type: type.name, qr_codes: codes };
}))));

router.get('/boxes/by-qr/:qr', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(
    `SELECT b.*, t.name AS box_type, t.replacement_price, bt.batch_code, m.full_name AS member_name,
            (SELECT row_to_json(a) FROM mushroom.box_assignment a WHERE a.box_id=b.box_id AND a.returned_at IS NULL) AS open_assignment
       FROM mushroom.box b JOIN mushroom.box_type t ON t.box_type_id=b.box_type_id
       LEFT JOIN mushroom.batch bt ON bt.batch_id=b.current_batch_id
       LEFT JOIN mushroom.member m ON m.member_id=b.current_member_id
      WHERE b.coop_org_id=$1 AND b.qr_code=$2`,
    [coop, req.params.qr],
  );
  if (!r.rows.length) throw notFound('box_not_found');
  const history = await c.query(
    `SELECT a.*, m.full_name AS member_name, bt.batch_code FROM mushroom.box_assignment a
       JOIN mushroom.member m ON m.member_id=a.member_id JOIN mushroom.batch bt ON bt.batch_id=a.batch_id
      WHERE a.box_id=$1 ORDER BY a.delivered_at DESC LIMIT 20`,
    [r.rows[0].box_id],
  );
  return { ...r.rows[0], history: history.rows };
})));

router.post('/boxes/:id/retire', h(async (req) => db(req, async (c, coop) => {
  const b = await own(c, coop, 'box', req.params.id);
  if (b.status !== 'Available' && b.status !== 'Broken') throw conflict('box_not_retirable', { status: b.status });
  return (await c.query(`UPDATE mushroom.box SET status='Retired' WHERE box_id=$1 RETURNING *`, [b.box_id])).rows[0];
})));

router.post('/boxes/:id/restore', h(async (req) => db(req, async (c, coop) => {
  const b = await own(c, coop, 'box', req.params.id);
  if (!['Lost', 'Broken'].includes(b.status)) throw conflict('box_not_restorable', { status: b.status });
  return (await c.query(`UPDATE mushroom.box SET status='Available', current_member_id=NULL, current_batch_id=NULL WHERE box_id=$1 RETURNING *`, [b.box_id])).rows[0];
})));

// ---- รุ่นการผลิต ----
router.get('/batches', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(
    `SELECT b.*, r.name AS recipe_name, s.lot_no AS spawn_lot_no,
            (SELECT COALESCE(SUM(amount),0) FROM mushroom.batch_cost bc WHERE bc.batch_id=b.batch_id) AS total_cost,
            (SELECT COUNT(*)::int FROM mushroom.box x WHERE x.current_batch_id=b.batch_id AND x.status='InBatch') AS boxes_in_center,
            (SELECT COUNT(*)::int FROM mushroom.box_assignment a WHERE a.batch_id=b.batch_id) AS boxes_distributed,
            (SELECT COALESCE(SUM(weight_kg),0) FROM mushroom.harvest hv WHERE hv.batch_id=b.batch_id) AS harvest_kg
       FROM mushroom.batch b JOIN mushroom.recipe r ON r.recipe_id=b.recipe_id
       LEFT JOIN mushroom.spawn_lot s ON s.spawn_lot_id=b.spawn_lot_id
      WHERE b.coop_org_id=$1 ORDER BY b.created_at DESC LIMIT 200`,
    [coop],
  );
  return r.rows;
})));

router.get('/batches/:id', h(async (req) => db(req, async (c, coop) => {
  const b = await own(c, coop, 'batch', req.params.id);
  const [events, costs, recipe, materials] = await Promise.all([
    c.query('SELECT * FROM mushroom.batch_event WHERE batch_id=$1 ORDER BY at', [b.batch_id]),
    c.query('SELECT * FROM mushroom.batch_cost WHERE batch_id=$1 ORDER BY created_at', [b.batch_id]),
    c.query('SELECT * FROM mushroom.recipe WHERE recipe_id=$1', [b.recipe_id]),
    c.query(`SELECT m.name, mm.qty_kg, mm.unit_price FROM mushroom.material_movement mm JOIN mushroom.material m USING (material_id)
              WHERE mm.batch_id=$1 AND mm.direction='out'`, [b.batch_id]),
  ]).then((rs) => rs.map((x) => x.rows));
  const assignments = (await c.query(
    `SELECT a.*, x.qr_code, m.full_name AS member_name FROM mushroom.box_assignment a
       JOIN mushroom.box x ON x.box_id=a.box_id JOIN mushroom.member m ON m.member_id=a.member_id
      WHERE a.batch_id=$1 ORDER BY a.delivered_at`,
    [b.batch_id],
  )).rows;
  const harvest = (await c.query(
    'SELECT grade, SUM(weight_kg)::numeric AS kg, SUM(amount)::numeric AS amount FROM mushroom.harvest WHERE batch_id=$1 GROUP BY grade',
    [b.batch_id],
  )).rows;
  return { ...b, recipe: recipe[0], events, costs, materials, assignments, harvest };
})));

/**
 * สร้างรุ่นการผลิต: ตัดวัสดุตามสูตร (บันทึกต้นทุนวัสดุที่ราคาเฉลี่ย) และจองกล่อง
 * ว่างตามจำนวนกล่องที่วางแผน. วัสดุหรือกล่องไม่พอ -> 409 พร้อมรายละเอียด.
 */
router.post('/batches', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = req.body || {};
  const recipe = await own(c, coop, 'recipe', b.recipe_id);
  if (!recipe.active) throw bad('recipe_inactive');
  const boxes = num(b.boxes_planned, { min: 1, max: 20000 });
  if (!boxes || Number.isNaN(boxes) || !Number.isInteger(boxes)) throw bad('invalid_field', { field: 'boxes_planned' });
  const totalKg = boxes * Number(recipe.kg_per_box);
  const items = (await c.query(
    `${STOCK_SQL} AND m.material_id IN (SELECT material_id FROM mushroom.recipe_item WHERE recipe_id=$2)
     GROUP BY m.material_id`,
    [coop, recipe.recipe_id],
  )).rows;
  const pct = Object.fromEntries((await c.query('SELECT material_id, pct FROM mushroom.recipe_item WHERE recipe_id=$1', [recipe.recipe_id])).rows
    .map((r) => [r.material_id, Number(r.pct)]));
  const shortages = [];
  items.forEach((it) => {
    const need = round2((totalKg * pct[it.material_id]) / 100);
    it.need = need;
    if (Number(it.stock_kg) < need) shortages.push({ material: it.name, need_kg: need, stock_kg: Number(it.stock_kg) });
  });
  if (shortages.length) throw conflict('insufficient_material', { shortages });

  const typeFilter = b.box_type_id ? (await own(c, coop, 'box_type', b.box_type_id)).box_type_id : null;
  const avail = (await c.query(
    `SELECT box_id FROM mushroom.box WHERE coop_org_id=$1 AND status='Available' ${typeFilter ? 'AND box_type_id=$3' : ''}
      ORDER BY qr_code LIMIT $2 FOR UPDATE SKIP LOCKED`,
    typeFilter ? [coop, boxes, typeFilter] : [coop, boxes],
  )).rows;
  if (avail.length < boxes) throw conflict('not_enough_boxes', { available: avail.length, needed: boxes });

  const n = (await c.query('SELECT COUNT(*)::int AS n FROM mushroom.batch WHERE coop_org_id=$1', [coop])).rows[0].n;
  const code = String(b.batch_code || '').trim() || `B${bkkToday().replace(/-/g, '').slice(2)}-${String(n + 1).padStart(3, '0')}`;
  let batch;
  try {
    batch = (await c.query(
      `INSERT INTO mushroom.batch (coop_org_id, batch_code, recipe_id, boxes_planned, compost_started_on, note)
       VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6) RETURNING *`,
      [coop, code, recipe.recipe_id, boxes, isDate(b.compost_started_on) ? b.compost_started_on : null, b.note || null],
    )).rows[0];
  } catch (e) {
    if (e.code === '23505') throw conflict('batch_code_exists');
    throw e;
  }
  let materialCost = 0;
  for (const it of items) {
    await c.query(
      `INSERT INTO mushroom.material_movement (coop_org_id, material_id, direction, qty_kg, unit_price, source_type, batch_id)
       VALUES ($1,$2,'out',$3,$4,'batch_use',$5)`,
      [coop, it.material_id, it.need, it.avg_cost_per_kg, batch.batch_id],
    );
    materialCost += it.need * Number(it.avg_cost_per_kg);
  }
  await c.query(`INSERT INTO mushroom.batch_cost (batch_id, cost_type, amount, note) VALUES ($1,'material',$2,'วัสดุเพาะตามสูตร')`,
    [batch.batch_id, round2(materialCost)]);
  await c.query(
    `UPDATE mushroom.box SET status='InBatch', current_batch_id=$2 WHERE box_id = ANY($1::uuid[])`,
    [avail.map((x) => x.box_id), batch.batch_id],
  );
  await c.query(`INSERT INTO mushroom.batch_event (batch_id, event_type, note) VALUES ($1,'create',$2)`,
    [batch.batch_id, `ตั้งกองหมัก ${round2(totalKg)} กก. สำหรับ ${boxes} กล่อง`]);
  await logAccess(c, 'write', 'mushroom.batch', batch.batch_id);
  return { ...batch, material_kg: round2(totalKg), material_cost: round2(materialCost) };
}))));

async function batchEvent(c, batchId, type, fields = {}) {
  await c.query(
    'INSERT INTO mushroom.batch_event (batch_id, event_type, temp_c, hours, note) VALUES ($1,$2,$3,$4,$5)',
    [batchId, type, fields.temp_c ?? null, fields.hours ?? null, fields.note || null],
  );
}

router.post('/batches/:id/turn', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = await own(c, coop, 'batch', req.params.id, { lock: true });
  if (b.status !== 'Composting') throw conflict('invalid_batch_status', { status: b.status });
  await c.query('UPDATE mushroom.batch SET turn_count=turn_count+1 WHERE batch_id=$1', [b.batch_id]);
  await batchEvent(c, b.batch_id, 'turn', { temp_c: num((req.body || {}).temp_c), note: (req.body || {}).note });
  return { turn_count: b.turn_count + 1 };
}))));

router.post('/batches/:id/pasteurize', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = await own(c, coop, 'batch', req.params.id, { lock: true });
  if (b.status !== 'Composting') throw conflict('invalid_batch_status', { status: b.status });
  const temp = needPos(req.body.temp_c, 'temp_c');
  const hours = needPos(req.body.hours, 'hours');
  const r = await c.query(
    `UPDATE mushroom.batch SET status='Pasteurized', pasteurize_temp_c=$2, pasteurize_hours=$3, pasteurized_at=now()
      WHERE batch_id=$1 RETURNING *`,
    [b.batch_id, temp, hours],
  );
  await batchEvent(c, b.batch_id, 'pasteurize', { temp_c: temp, hours, note: req.body.note });
  // แนวทางของ อ.อานนท์ ~65-72°C 4-6 ชม. — เตือน ไม่บล็อก (สหกรณ์อาจทดลองปรับเอง)
  const warning = temp < 65 || temp > 72 || hours < 4 || hours > 6 ? 'outside_guidance_65_72c_4_6h' : null;
  return { ...r.rows[0], warning };
}))));

router.post('/batches/:id/spawn', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = await own(c, coop, 'batch', req.params.id, { lock: true });
  if (b.status !== 'Pasteurized') throw conflict('invalid_batch_status', { status: b.status });
  const lot = await own(c, coop, 'spawn_lot', (req.body || {}).spawn_lot_id, { lock: true });
  const recipe = await own(c, coop, 'recipe', b.recipe_id);
  const bags = round2(Number(recipe.spawn_bags_per_box) * b.boxes_planned);
  const remaining = Number(lot.qty_bags) - Number(lot.qty_used_bags);
  if (bags > remaining) throw conflict('insufficient_spawn', { need_bags: bags, remaining_bags: remaining });
  await c.query('UPDATE mushroom.spawn_lot SET qty_used_bags=qty_used_bags+$2 WHERE spawn_lot_id=$1', [lot.spawn_lot_id, bags]);
  if (bags > 0) {
    await c.query(`INSERT INTO mushroom.batch_cost (batch_id, cost_type, amount, note) VALUES ($1,'spawn',$2,$3)`,
      [b.batch_id, round2(bags * Number(lot.unit_cost)), `เชื้อล็อต ${lot.lot_no} ${bags} ถุง`]);
  }
  const r = await c.query(
    `UPDATE mushroom.batch SET status='SpawnRun', spawn_lot_id=$2, spawned_at=now() WHERE batch_id=$1 RETURNING *`,
    [b.batch_id, lot.spawn_lot_id],
  );
  await batchEvent(c, b.batch_id, 'spawn', { note: `ใส่เชื้อล็อต ${lot.lot_no} (${bags} ถุง)` });
  return r.rows[0];
}))));

/** ผ่าน QC พร้อมแจก: กล่องเสียคืนสถานะ Available (ทิ้งวัสดุ ใช้กล่องซ้ำ) */
router.post('/batches/:id/ready', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = await own(c, coop, 'batch', req.params.id, { lock: true });
  if (b.status !== 'SpawnRun') throw conflict('invalid_batch_status', { status: b.status });
  const bad_ = num((req.body || {}).boxes_bad ?? 0, { min: 0, max: b.boxes_planned });
  if (bad_ === null || Number.isNaN(bad_) || !Number.isInteger(bad_)) throw bad('invalid_field', { field: 'boxes_bad' });
  if (bad_ > 0) {
    await c.query(
      `UPDATE mushroom.box SET status='Available', current_batch_id=NULL
        WHERE box_id IN (SELECT box_id FROM mushroom.box WHERE current_batch_id=$1 AND status='InBatch' ORDER BY qr_code DESC LIMIT $2)`,
      [b.batch_id, bad_],
    );
  }
  const r = await c.query(
    `UPDATE mushroom.batch SET status='Ready', boxes_bad=$2, boxes_good=boxes_planned-$2, ready_at=now() WHERE batch_id=$1 RETURNING *`,
    [b.batch_id, bad_],
  );
  await batchEvent(c, b.batch_id, 'ready', { temp_c: num(req.body.temp_c), note: req.body.note || `QC ผ่าน ${b.boxes_planned - bad_} กล่อง เสีย ${bad_}` });
  return r.rows[0];
}))));

router.post('/batches/:id/costs', h(async (req) => db(req, async (c, coop) => {
  const b = await own(c, coop, 'batch', req.params.id);
  const type = (req.body || {}).cost_type;
  if (!['energy', 'labor', 'other'].includes(type)) throw bad('invalid_cost_type');
  const r = await c.query(
    'INSERT INTO mushroom.batch_cost (batch_id, cost_type, amount, note) VALUES ($1,$2,$3,$4) RETURNING *',
    [b.batch_id, type, needPos(req.body.amount, 'amount'), req.body.note || null],
  );
  return r.rows[0];
})));

router.post('/batches/:id/note', h(async (req) => db(req, async (c, coop) => {
  const b = await own(c, coop, 'batch', req.params.id);
  const note = String((req.body || {}).note || '').trim();
  if (!note) throw bad('missing_note');
  await batchEvent(c, b.batch_id, 'note', { temp_c: num(req.body.temp_c), note });
  return { ok: true };
})));

router.post('/batches/:id/fail', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = await own(c, coop, 'batch', req.params.id, { lock: true });
  if (['Distributed', 'Closed', 'Failed'].includes(b.status)) throw conflict('invalid_batch_status', { status: b.status });
  await c.query(`UPDATE mushroom.box SET status='Available', current_batch_id=NULL WHERE current_batch_id=$1 AND status='InBatch'`, [b.batch_id]);
  const r = await c.query(`UPDATE mushroom.batch SET status='Failed' WHERE batch_id=$1 RETURNING *`, [b.batch_id]);
  await batchEvent(c, b.batch_id, 'fail', { note: (req.body || {}).note || 'ยกเลิก/เสียทั้งรุ่น' });
  return r.rows[0];
}))));

router.post('/batches/:id/close', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = await own(c, coop, 'batch', req.params.id, { lock: true });
  if (b.status !== 'Distributed') throw conflict('invalid_batch_status', { status: b.status });
  const open = (await c.query('SELECT COUNT(*)::int AS n FROM mushroom.box_assignment WHERE batch_id=$1 AND returned_at IS NULL', [b.batch_id])).rows[0].n;
  if (open > 0) throw conflict('boxes_not_returned', { open_boxes: open });
  const r = await c.query(`UPDATE mushroom.batch SET status='Closed' WHERE batch_id=$1 RETURNING *`, [b.batch_id]);
  await batchEvent(c, b.batch_id, 'close', { note: 'ปิดรุ่น กล่องคืนครบ' });
  return r.rows[0];
}))));

// ===========================================================================
// (4) สมาชิกเปิดดอก — จองกล่อง แจกกล่อง รับคืน ปัญหา
// ===========================================================================
router.get('/bookings', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(
    `SELECT k.*, m.full_name AS member_name, m.member_code, m.capacity_boxes, bt.batch_code
       FROM mushroom.box_booking k JOIN mushroom.member m ON m.member_id=k.member_id
       LEFT JOIN mushroom.batch bt ON bt.batch_id=k.batch_id
      WHERE k.coop_org_id=$1 ORDER BY (k.status='Requested') DESC, k.wanted_date LIMIT 300`,
    [coop],
  );
  return r.rows;
})));

router.post('/bookings', h(async (req) => db(req, async (c, coop) => {
  const b = req.body || {};
  const m = await own(c, coop, 'member', b.member_id);
  if (m.status !== 'Approved') throw conflict('member_not_approved');
  const n = needPos(b.requested_boxes, 'requested_boxes');
  if (!isDate(b.wanted_date)) throw bad('invalid_wanted_date');
  const r = await c.query(
    `INSERT INTO mushroom.box_booking (coop_org_id, member_id, requested_boxes, wanted_date) VALUES ($1,$2,$3,$4) RETURNING *`,
    [coop, m.member_id, Math.round(n), b.wanted_date],
  );
  return r.rows[0];
})));

router.post('/bookings/:id/cancel', h(async (req) => db(req, async (c, coop) => {
  const k = await own(c, coop, 'booking', req.params.id);
  if (!['Requested', 'Allocated'].includes(k.status)) throw conflict('invalid_booking_status', { status: k.status });
  return (await c.query(`UPDATE mushroom.box_booking SET status='Cancelled' WHERE booking_id=$1 RETURNING *`, [k.booking_id])).rows[0];
})));

router.post('/bookings/:id/allocate', h(async (req) => db(req, async (c, coop) => {
  const k = await own(c, coop, 'booking', req.params.id);
  if (k.status !== 'Requested') throw conflict('invalid_booking_status', { status: k.status });
  const batch = await own(c, coop, 'batch', (req.body || {}).batch_id);
  if (!['SpawnRun', 'Ready'].includes(batch.status)) throw conflict('invalid_batch_status', { status: batch.status });
  return (await c.query(`UPDATE mushroom.box_booking SET status='Allocated', batch_id=$2 WHERE booking_id=$1 RETURNING *`,
    [k.booking_id, batch.batch_id])).rows[0];
})));

/**
 * แจกกล่อง (ฝากเลี้ยง) จากรุ่นที่พร้อม ให้สมาชิก: ระบุ qr_codes หรือ count.
 * ตรวจไม่เกินความจุจุดเปิดดอก (capacity_boxes) และสมาชิกต้องได้รับอนุมัติ.
 */
async function distribute(c, coop, { batchId, memberId, qrCodes, count, tripId, bookingId }) {
  const batch = await own(c, coop, 'batch', batchId, { lock: true });
  if (!['Ready', 'Distributed'].includes(batch.status)) throw conflict('batch_not_ready', { status: batch.status });
  const m = await own(c, coop, 'member', memberId);
  if (m.status !== 'Approved') throw conflict('member_not_approved');
  let boxes;
  if (Array.isArray(qrCodes) && qrCodes.length) {
    boxes = (await c.query(
      `SELECT box_id, qr_code FROM mushroom.box WHERE coop_org_id=$1 AND current_batch_id=$2 AND status='InBatch' AND qr_code = ANY($3::text[]) FOR UPDATE`,
      [coop, batch.batch_id, qrCodes],
    )).rows;
    if (boxes.length !== qrCodes.length) {
      const found = new Set(boxes.map((x) => x.qr_code));
      throw conflict('boxes_not_in_batch', { missing: qrCodes.filter((q) => !found.has(q)) });
    }
  } else {
    const n = num(count, { min: 1 });
    if (!n || Number.isNaN(n) || !Number.isInteger(n)) throw bad('invalid_field', { field: 'count' });
    boxes = (await c.query(
      `SELECT box_id, qr_code FROM mushroom.box WHERE coop_org_id=$1 AND current_batch_id=$2 AND status='InBatch'
        ORDER BY qr_code LIMIT $3 FOR UPDATE SKIP LOCKED`,
      [coop, batch.batch_id, n],
    )).rows;
    if (boxes.length < n) throw conflict('not_enough_boxes_in_batch', { available: boxes.length, needed: n });
  }
  const onHand = (await c.query('SELECT COUNT(*)::int AS n FROM mushroom.box_assignment WHERE member_id=$1 AND returned_at IS NULL', [m.member_id])).rows[0].n;
  if (m.capacity_boxes > 0 && onHand + boxes.length > m.capacity_boxes) {
    throw conflict('over_member_capacity', { capacity: m.capacity_boxes, on_hand: onHand, adding: boxes.length });
  }
  for (const x of boxes) {
    await c.query(
      `INSERT INTO mushroom.box_assignment (coop_org_id, box_id, batch_id, member_id, trip_id) VALUES ($1,$2,$3,$4,$5)`,
      [coop, x.box_id, batch.batch_id, m.member_id, tripId || null],
    );
  }
  await c.query(`UPDATE mushroom.box SET status='WithMember', current_member_id=$2 WHERE box_id = ANY($1::uuid[])`,
    [boxes.map((x) => x.box_id), m.member_id]);
  const left = (await c.query(`SELECT COUNT(*)::int AS n FROM mushroom.box WHERE current_batch_id=$1 AND status='InBatch'`, [batch.batch_id])).rows[0].n;
  if (left === 0) await c.query(`UPDATE mushroom.batch SET status='Distributed' WHERE batch_id=$1`, [batch.batch_id]);
  await batchEvent(c, batch.batch_id, 'distribute', { note: `ฝากเลี้ยง ${boxes.length} กล่อง -> ${m.full_name}` });
  if (bookingId) {
    await c.query(`UPDATE mushroom.box_booking SET status='Delivered', batch_id=$2 WHERE booking_id=$1 AND coop_org_id=$3`,
      [bookingId, batch.batch_id, coop]);
  }
  return { member: m.full_name, boxes: boxes.map((x) => x.qr_code), batch_remaining: left };
}

router.post('/distribute', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = req.body || {};
  if (b.booking_id) await own(c, coop, 'booking', b.booking_id);
  if (b.trip_id) await own(c, coop, 'trip', b.trip_id);
  return distribute(c, coop, {
    batchId: b.batch_id, memberId: b.member_id, qrCodes: b.qr_codes, count: b.count, tripId: b.trip_id, bookingId: b.booking_id,
  });
}))));

/**
 * รับกล่องคืน: items = [{ qr_code, outcome: 'Returned'|'Lost'|'Broken' }].
 * Lost/Broken -> หักบัญชีสมาชิกตามราคากล่องที่ตั้งไว้ (ราคา ณ เวลาที่คืน).
 */
async function returnBoxes(c, coop, items, tripId) {
  if (!Array.isArray(items) || !items.length) throw bad('missing_items');
  const out = [];
  for (const it of items) {
    if (!['Returned', 'Lost', 'Broken'].includes(it.outcome)) throw bad('invalid_outcome', { qr_code: it.qr_code });
    const row = (await c.query(
      `SELECT a.assignment_id, a.member_id, a.batch_id, x.box_id, x.qr_code, t.replacement_price, r.kg_per_box
         FROM mushroom.box x JOIN mushroom.box_type t ON t.box_type_id=x.box_type_id
         JOIN mushroom.box_assignment a ON a.box_id=x.box_id AND a.returned_at IS NULL
         JOIN mushroom.batch bt ON bt.batch_id=a.batch_id JOIN mushroom.recipe r ON r.recipe_id=bt.recipe_id
        WHERE x.coop_org_id=$1 AND x.qr_code=$2 FOR UPDATE OF a, x`,
      [coop, it.qr_code],
    )).rows[0];
    if (!row) throw conflict('box_not_with_member', { qr_code: it.qr_code });
    const liability = it.outcome === 'Returned' ? 0 : Number(row.replacement_price);
    await c.query(
      `UPDATE mushroom.box_assignment SET returned_at=now(), outcome=$2, liability_amount=$3, spent_substrate_kg=$4
        WHERE assignment_id=$1`,
      [row.assignment_id, it.outcome, liability, it.outcome === 'Lost' ? null : row.kg_per_box],
    );
    await c.query(
      `UPDATE mushroom.box SET status=$2, current_member_id=NULL, current_batch_id=NULL WHERE box_id=$1`,
      [row.box_id, it.outcome === 'Returned' ? 'Available' : it.outcome],
    );
    if (liability > 0) {
      await addLedger(c, coop, row.member_id, 'box_liability', -liability, 'box_assignment', row.assignment_id,
        `กล่อง ${row.qr_code} ${it.outcome === 'Lost' ? 'สูญหาย' : 'แตกหัก'}`);
    }
    out.push({ qr_code: row.qr_code, outcome: it.outcome, liability });
  }
  void tripId;
  return out;
}

router.post('/boxes/return', h(async (req) => db(req, async (c, coop) => tx(c, async () => ({
  returned: await returnBoxes(c, coop, (req.body || {}).items),
})))));

router.get('/issues', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(
    `SELECT i.*, m.full_name AS member_name, m.phone, b.batch_code FROM mushroom.issue_report i
       JOIN mushroom.member m ON m.member_id=i.member_id LEFT JOIN mushroom.batch b ON b.batch_id=i.batch_id
      WHERE i.coop_org_id=$1 ORDER BY (i.status='Open') DESC, i.created_at DESC LIMIT 200`,
    [coop],
  );
  return r.rows;
})));

router.post('/issues/:id/resolve', h(async (req) => db(req, async (c, coop) => {
  const i = await own(c, coop, 'issue', req.params.id);
  if (i.status !== 'Open') throw conflict('issue_already_resolved');
  return (await c.query(`UPDATE mushroom.issue_report SET status='Resolved', resolution=$2, resolved_at=now() WHERE report_id=$1 RETURNING *`,
    [i.report_id, (req.body || {}).resolution || null])).rows[0];
})));

// ===========================================================================
// (5) ราคาประกาศรายวัน รับซื้อ คัดเกรด แปรรูป
// ===========================================================================
router.get('/prices', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(
    `SELECT price_date, grade, price_per_kg, announced_at FROM mushroom.daily_price
      WHERE coop_org_id=$1 ORDER BY price_date DESC, grade LIMIT 90`,
    [coop],
  );
  return r.rows;
})));

router.post('/prices', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = req.body || {};
  const date = b.price_date || bkkToday();
  if (!isDate(date)) throw bad('invalid_price_date');
  const set = [];
  for (const g of GRADES) {
    if (b[g] === undefined || b[g] === '' || b[g] === null) continue;
    const p = needNonNeg(b[g], g);
    await c.query(
      `INSERT INTO mushroom.daily_price (coop_org_id, price_date, grade, price_per_kg) VALUES ($1,$2,$3,$4)
       ON CONFLICT (coop_org_id, price_date, grade) DO UPDATE SET price_per_kg=EXCLUDED.price_per_kg, announced_at=now()`,
      [coop, date, g, p],
    );
    set.push(g);
  }
  if (!set.length) throw bad('no_prices_given');
  return { price_date: date, grades: set };
}))));

/**
 * รับซื้อเห็ดจากสมาชิก: ราคาตามที่ประกาศของวันนั้นตามเกรด (จ่ายตามน้ำหนักอย่าง
 * เดียว), เครดิตบัญชีสมาชิก, หักค่าบริการ AgroLink ส่วนที่สมาชิกเป็นผู้ขาย.
 */
async function recordHarvest(c, coop, b, recordedBy) {
  const m = await own(c, coop, 'member', b.member_id);
  if (!GRADES.includes(b.grade)) throw bad('invalid_grade');
  const kg = needPos(b.weight_kg, 'weight_kg');
  const date = b.date && isDate(b.date) ? b.date : bkkToday();
  const price = (await c.query(
    'SELECT price_per_kg FROM mushroom.daily_price WHERE coop_org_id=$1 AND price_date=$2 AND grade=$3',
    [coop, date, b.grade],
  )).rows[0];
  if (!price) throw conflict('price_not_announced', { date, grade: b.grade });
  let batchId = null;
  if (b.batch_id) batchId = (await own(c, coop, 'batch', b.batch_id)).batch_id;
  else {
    const a = (await c.query(
      `SELECT batch_id FROM mushroom.box_assignment WHERE member_id=$1 ORDER BY (returned_at IS NULL) DESC, delivered_at DESC LIMIT 1`,
      [m.member_id],
    )).rows[0];
    batchId = a ? a.batch_id : null;
  }
  if (b.trip_id) await own(c, coop, 'trip', b.trip_id);
  const s = await settings(c, coop);
  const amount = round2(kg * Number(price.price_per_kg));
  const rate = Number(s.fee_rate_member_sale_pct);
  const fee = feeOf(amount, rate);
  const hv = (await c.query(
    `INSERT INTO mushroom.harvest (coop_org_id, member_id, batch_id, trip_id, grade, weight_kg, price_per_kg, amount, fee_rate_pct, fee_amount, recorded_by, collected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $12::date = (now() AT TIME ZONE 'Asia/Bangkok')::date THEN now() ELSE ($12::date + time '12:00') AT TIME ZONE 'Asia/Bangkok' END)
     RETURNING *`,
    [coop, m.member_id, batchId, b.trip_id || null, b.grade, kg, price.price_per_kg, amount, rate, fee, recordedBy, date],
  )).rows[0];
  await addLedger(c, coop, m.member_id, 'mushroom_sale', amount, 'harvest', hv.harvest_id,
    `เห็ดเกรด ${b.grade} ${kg} กก. x ${price.price_per_kg} บาท`, date);
  if (fee > 0) {
    await addLedger(c, coop, m.member_id, 'sale_fee', -fee, 'harvest', hv.harvest_id, `ค่าบริการ AgroLink ${rate}%`, date);
  }
  await addPlatformFee(c, coop, 'member_sale', 'member', m.member_id, amount, rate, 'harvest', hv.harvest_id);
  return { ...hv, member_name: m.full_name };
}

router.post('/harvests', h(async (req) => db(req, async (c, coop) => tx(c, async () => recordHarvest(c, coop, req.body || {}, actor(req))))));

router.get('/harvests', h(async (req) => db(req, async (c, coop) => {
  const params = [coop];
  let f = '';
  if (req.query.member_id) { params.push(needUuid(req.query.member_id, 'member_id')); f += ` AND h.member_id=$${params.length}`; }
  if (isDate(req.query.from)) { params.push(req.query.from); f += ` AND h.collected_at >= ($${params.length}::date AT TIME ZONE 'Asia/Bangkok')`; }
  if (isDate(req.query.to)) { params.push(req.query.to); f += ` AND h.collected_at < (($${params.length}::date + 1) AT TIME ZONE 'Asia/Bangkok')`; }
  const r = await c.query(
    `SELECT h.*, m.full_name AS member_name, m.member_code, b.batch_code, l.lot_code FROM mushroom.harvest h
       JOIN mushroom.member m ON m.member_id=h.member_id LEFT JOIN mushroom.batch b ON b.batch_id=h.batch_id
       LEFT JOIN mushroom.product_lot l ON l.lot_id=h.lot_id
      WHERE h.coop_org_id=$1 ${f} ORDER BY h.collected_at DESC LIMIT 500`,
    params,
  );
  return r.rows;
})));

router.get('/lots', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(
    `SELECT * FROM mushroom.product_lot WHERE coop_org_id=$1 ORDER BY (qty_available_kg > 0) DESC, produced_on DESC LIMIT 300`,
    [coop],
  );
  return r.rows;
})));

/**
 * สร้างล็อตสินค้า:
 *   - product_type='fresh' + from_date/grade: รวมการรับซื้อของวันนั้นที่ยังไม่มีล็อตเป็นล็อตเห็ดสด
 *   - แปรรูป (ลวกแช่แข็ง/ดองซีอิ๊ว/กระป๋อง): ระบุ qty_kg (ผลผลิต) + input_fresh_kg
 *     และ source_lot_id (ล็อตเห็ดสดที่ใช้) — ตัดสต็อกล็อตต้นทาง
 */
router.post('/lots', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = req.body || {};
  if (!PRODUCT_TYPES.includes(b.product_type)) throw bad('invalid_product_type');
  const n = (await c.query('SELECT COUNT(*)::int AS n FROM mushroom.product_lot WHERE coop_org_id=$1', [coop])).rows[0].n;
  const prefix = { fresh: 'FR', blanched_frozen: 'BF', soy_pickled: 'SP', canned: 'CN' }[b.product_type];
  const code = `${prefix}${bkkToday().replace(/-/g, '').slice(2)}-${String(n + 1).padStart(3, '0')}`;
  if (b.expires_on && !isDate(b.expires_on)) throw bad('invalid_expires_on');
  if (b.product_type === 'fresh') {
    const date = b.from_date || bkkToday();
    if (!isDate(date)) throw bad('invalid_from_date');
    if (b.grade && !GRADES.includes(b.grade)) throw bad('invalid_grade');
    const hv = (await c.query(
      `SELECT harvest_id, weight_kg FROM mushroom.harvest
        WHERE coop_org_id=$1 AND lot_id IS NULL AND (collected_at AT TIME ZONE 'Asia/Bangkok')::date = $2
          ${b.grade ? 'AND grade=$3' : ''} FOR UPDATE`,
      b.grade ? [coop, date, b.grade] : [coop, date],
    )).rows;
    if (!hv.length) throw conflict('no_unlotted_harvest', { date });
    const kg = round2(hv.reduce((s, x) => s + Number(x.weight_kg), 0));
    const lot = (await c.query(
      `INSERT INTO mushroom.product_lot (coop_org_id, lot_code, product_type, grade, qty_kg, qty_available_kg, input_fresh_kg, produced_on, expires_on, storage_location, note)
       VALUES ($1,$2,'fresh',$3,$4,$4,$4,$5,$6,$7,$8) RETURNING *`,
      [coop, code, b.grade || null, kg, date, b.expires_on || null, b.storage_location || null, b.note || null],
    )).rows[0];
    await c.query('UPDATE mushroom.harvest SET lot_id=$1 WHERE harvest_id = ANY($2::uuid[])', [lot.lot_id, hv.map((x) => x.harvest_id)]);
    return { ...lot, harvest_count: hv.length };
  }
  const out = needPos(b.qty_kg, 'qty_kg');
  const input = needPos(b.input_fresh_kg, 'input_fresh_kg');
  const src = await own(c, coop, 'lot', b.source_lot_id, { lock: true });
  if (src.product_type !== 'fresh') throw bad('source_must_be_fresh');
  if (Number(src.qty_available_kg) < input) throw conflict('insufficient_source_lot', { available: Number(src.qty_available_kg) });
  await c.query('UPDATE mushroom.product_lot SET qty_available_kg=qty_available_kg-$2 WHERE lot_id=$1', [src.lot_id, input]);
  const lot = (await c.query(
    `INSERT INTO mushroom.product_lot (coop_org_id, lot_code, product_type, grade, qty_kg, qty_available_kg, input_fresh_kg, produced_on, expires_on, storage_location, note)
     VALUES ($1,$2,$3,$4,$5,$5,$6,CURRENT_DATE,$7,$8,$9) RETURNING *`,
    [coop, code, b.product_type, src.grade, out, input, b.expires_on || null, b.storage_location || null,
      b.note || `แปรรูปจากล็อต ${src.lot_code}`],
  )).rows[0];
  return lot;
}))));

router.post('/lots/:id/adjust', h(async (req) => db(req, async (c, coop) => {
  const l = await own(c, coop, 'lot', req.params.id);
  const qty = needNonNeg(req.body.qty_available_kg, 'qty_available_kg');
  if (qty > Number(l.qty_available_kg)) throw bad('can_only_reduce');
  const note = String(req.body.note || '').trim();
  if (!note) throw bad('missing_note');
  return (await c.query(`UPDATE mushroom.product_lot SET qty_available_kg=$2, note=concat_ws(' | ', note, $3::text) WHERE lot_id=$1 RETURNING *`,
    [l.lot_id, qty, `ปรับลด: ${note}`])).rows[0];
})));

// ===========================================================================
// (6) ตลาดและคำสั่งซื้อผู้ซื้อ
// ===========================================================================
router.get('/sales-orders', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(
    `SELECT o.*, p.name AS buyer_name,
            COALESCE((SELECT json_agg(json_build_object('lot_code', l.lot_code, 'qty_kg', a.qty_kg))
                        FROM mushroom.sales_allocation a JOIN mushroom.product_lot l ON l.lot_id=a.lot_id WHERE a.order_id=o.order_id), '[]') AS allocations
       FROM mushroom.sales_order o JOIN mushroom.partner p ON p.partner_id=o.partner_id
      WHERE o.coop_org_id=$1 ORDER BY o.created_at DESC LIMIT 300`,
    [coop],
  );
  return r.rows;
})));

function orderValues(b) {
  if (!PRODUCT_TYPES.includes(b.product_type)) throw bad('invalid_product_type');
  if (b.grade && !GRADES.includes(b.grade)) throw bad('invalid_grade');
  if (b.order_kind && !['spot', 'contract'].includes(b.order_kind)) throw bad('invalid_order_kind');
  if (b.deliver_on && !isDate(b.deliver_on)) throw bad('invalid_deliver_on');
  if (b.contract_end && !isDate(b.contract_end)) throw bad('invalid_contract_end');
  const qty = needPos(b.qty_kg, 'qty_kg');
  const price = needNonNeg(b.price_per_kg, 'price_per_kg');
  return {
    order_kind: b.order_kind || 'spot', product_type: b.product_type, grade: b.grade || null, qty_kg: qty, price_per_kg: price,
    amount: round2(qty * price), deliver_on: b.deliver_on || null, contract_end: b.contract_end || null, note: b.note || null,
  };
}

router.post('/sales-orders', h(async (req) => db(req, async (c, coop) => {
  const b = req.body || {};
  const p = await own(c, coop, 'partner', b.partner_id);
  if (p.partner_type !== 'buyer') throw bad('partner_not_buyer');
  const v = orderValues(b);
  const r = await c.query(
    `INSERT INTO mushroom.sales_order (coop_org_id, partner_id, order_kind, status, product_type, grade, qty_kg, price_per_kg, amount, deliver_on, contract_end, note, created_by, confirmed_at)
     VALUES ($1,$2,$3,'Confirmed',$4,$5,$6,$7,$8,$9,$10,$11,'coop',now()) RETURNING *`,
    [coop, p.partner_id, v.order_kind, v.product_type, v.grade, v.qty_kg, v.price_per_kg, v.amount, v.deliver_on, v.contract_end, v.note],
  );
  return r.rows[0];
})));

router.post('/sales-orders/:id/confirm', h(async (req) => db(req, async (c, coop) => {
  const o = await own(c, coop, 'order', req.params.id);
  if (o.status !== 'Requested') throw conflict('invalid_order_status', { status: o.status });
  return (await c.query(`UPDATE mushroom.sales_order SET status='Confirmed', confirmed_at=now() WHERE order_id=$1 RETURNING *`, [o.order_id])).rows[0];
})));

/**
 * ส่งมอบ: ตัดสต็อกจากล็อตที่ระบุ (allocations) หรือ FIFO อัตโนมัติจากล็อตชนิด/เกรด
 * เดียวกันที่หมดอายุก่อน. คิดค่าบริการ AgroLink การขายให้ผู้ซื้อภายนอก (สหกรณ์เป็นผู้ขาย).
 */
router.post('/sales-orders/:id/deliver', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const o = await own(c, coop, 'order', req.params.id, { lock: true });
  if (o.status !== 'Confirmed') throw conflict('invalid_order_status', { status: o.status });
  const given = Array.isArray((req.body || {}).allocations) ? req.body.allocations : [];
  let allocs = [];
  if (given.length) {
    let total = 0;
    for (const a of given) {
      const l = await own(c, coop, 'lot', a.lot_id, { lock: true });
      const q = needPos(a.qty_kg, 'qty_kg');
      if (l.product_type !== o.product_type) throw bad('lot_product_mismatch', { lot: l.lot_code });
      if (Number(l.qty_available_kg) < q) throw conflict('insufficient_lot', { lot: l.lot_code, available: Number(l.qty_available_kg) });
      total += q;
      allocs.push({ lot_id: l.lot_id, qty: q });
    }
    if (Math.abs(total - Number(o.qty_kg)) > 0.01) throw bad('allocation_must_equal_order_qty', { order_qty: Number(o.qty_kg), allocated: round2(total) });
  } else {
    let need = Number(o.qty_kg);
    const lots = (await c.query(
      `SELECT lot_id, qty_available_kg FROM mushroom.product_lot
        WHERE coop_org_id=$1 AND product_type=$2 AND qty_available_kg > 0 ${o.grade ? 'AND grade=$3' : ''}
          AND (expires_on IS NULL OR expires_on >= CURRENT_DATE)
        ORDER BY expires_on NULLS LAST, produced_on FOR UPDATE`,
      o.grade ? [coop, o.product_type, o.grade] : [coop, o.product_type],
    )).rows;
    for (const l of lots) {
      if (need <= 0) break;
      const q = Math.min(need, Number(l.qty_available_kg));
      allocs.push({ lot_id: l.lot_id, qty: round2(q) });
      need = round2(need - q);
    }
    if (need > 0) throw conflict('insufficient_stock', { short_kg: need });
  }
  allocs = allocs.filter((a) => a.qty > 0);
  for (const a of allocs) {
    await c.query('UPDATE mushroom.product_lot SET qty_available_kg=qty_available_kg-$2 WHERE lot_id=$1', [a.lot_id, a.qty]);
    await c.query('INSERT INTO mushroom.sales_allocation (order_id, lot_id, qty_kg) VALUES ($1,$2,$3)', [o.order_id, a.lot_id, a.qty]);
  }
  const s = await settings(c, coop);
  const rate = Number(s.fee_rate_external_sale_pct);
  const fee = await addPlatformFee(c, coop, 'external_sale', 'coop', coop, o.amount, rate, 'sales_order', o.order_id);
  const n = (await c.query(`SELECT COUNT(*)::int AS n FROM mushroom.sales_order WHERE coop_org_id=$1 AND invoice_no IS NOT NULL`, [coop])).rows[0].n;
  const inv = `INV-MUSH-${bkkToday().replace(/-/g, '')}-${String(n + 1).padStart(4, '0')}`;
  return (await c.query(
    `UPDATE mushroom.sales_order SET status='Delivered', delivered_at=now(), fee_rate_pct=$2, fee_amount=$3, invoice_no=$4
      WHERE order_id=$1 RETURNING *`,
    [o.order_id, rate, fee, inv],
  )).rows[0];
}))));

router.post('/sales-orders/:id/paid', h(async (req) => db(req, async (c, coop) => {
  const o = await own(c, coop, 'order', req.params.id);
  if (o.status !== 'Delivered') throw conflict('invalid_order_status', { status: o.status });
  return (await c.query(`UPDATE mushroom.sales_order SET status='Paid', paid_at=now() WHERE order_id=$1 RETURNING *`, [o.order_id])).rows[0];
})));

router.post('/sales-orders/:id/cancel', h(async (req) => db(req, async (c, coop) => {
  const o = await own(c, coop, 'order', req.params.id);
  if (!['Requested', 'Confirmed'].includes(o.status)) throw conflict('invalid_order_status', { status: o.status });
  return (await c.query(`UPDATE mushroom.sales_order SET status='Cancelled' WHERE order_id=$1 RETURNING *`, [o.order_id])).rows[0];
})));

/**
 * คาดการณ์ผลผลิต 7 วัน: ใช้ผลผลิตเฉลี่ยต่อกล่องจากรุ่นที่ปิดแล้วของสหกรณ์เอง
 * (ไม่สมมติตัวเลขแทน — ถ้ายังไม่มีประวัติจะคืน null).
 */
async function forecast(c, coop) {
  const perBatch = (await c.query(
    `SELECT b.batch_id,
            (SELECT COUNT(*) FROM mushroom.box_assignment a WHERE a.batch_id=b.batch_id) AS boxes,
            (SELECT COALESCE(SUM(weight_kg),0) FROM mushroom.harvest h WHERE h.batch_id=b.batch_id) AS kg
       FROM mushroom.batch b WHERE b.coop_org_id=$1 AND b.status='Closed'`,
    [coop],
  )).rows;
  const boxesHist = perBatch.reduce((s, r) => s + Number(r.boxes), 0);
  const kgHist = perBatch.reduce((s, r) => s + Number(r.kg), 0);
  const avgKgPerBox = boxesHist > 0 ? round2(kgHist / boxesHist) : null;
  const open = (await c.query(
    `SELECT a.batch_id, COUNT(*)::int AS boxes,
            (SELECT COALESCE(SUM(weight_kg),0) FROM mushroom.harvest h WHERE h.batch_id=a.batch_id) AS kg_so_far,
            MIN(a.delivered_at) AS first_delivered
       FROM mushroom.box_assignment a WHERE a.coop_org_id=$1 AND a.returned_at IS NULL GROUP BY a.batch_id`,
    [coop],
  )).rows;
  const openBoxes = open.reduce((s, r) => s + r.boxes, 0);
  let expectedRemainingKg = null;
  if (avgKgPerBox !== null) {
    expectedRemainingKg = round2(open.reduce((s, r) => s + Math.max(0, r.boxes * avgKgPerBox - Number(r.kg_so_far)), 0));
  }
  const last7 = (await c.query(
    `SELECT (collected_at AT TIME ZONE 'Asia/Bangkok')::date AS day, SUM(weight_kg)::numeric AS kg
       FROM mushroom.harvest WHERE coop_org_id=$1 AND collected_at >= now() - interval '7 days' GROUP BY 1 ORDER BY 1`,
    [coop],
  )).rows;
  const stock = (await c.query(
    `SELECT product_type, grade, SUM(qty_available_kg)::numeric AS kg FROM mushroom.product_lot
      WHERE coop_org_id=$1 AND qty_available_kg > 0 AND (expires_on IS NULL OR expires_on >= CURRENT_DATE)
      GROUP BY 1,2 ORDER BY 1,2`,
    [coop],
  )).rows;
  const committed = (await c.query(
    `SELECT product_type, SUM(qty_kg)::numeric AS kg FROM mushroom.sales_order
      WHERE coop_org_id=$1 AND status IN ('Requested','Confirmed') GROUP BY 1`,
    [coop],
  )).rows;
  return {
    boxes_with_members: openBoxes,
    avg_kg_per_box_history: avgKgPerBox,
    expected_remaining_kg: expectedRemainingKg,
    harvest_last_7_days: last7,
    stock_available: stock,
    open_order_commitments: committed,
  };
}

router.get('/forecast', h(async (req) => db(req, async (c, coop) => forecast(c, coop))));

// ===========================================================================
// (8) ขนส่งไป-กลับ (ส่งกล่อง + รับเห็ด + รับฟาง ในเที่ยวเดียว)
// ===========================================================================
router.get('/trips', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(
    `SELECT t.*, p.name AS transporter_name,
            (SELECT COUNT(*)::int FROM mushroom.trip_stop s WHERE s.trip_id=t.trip_id) AS stops,
            (SELECT COUNT(*)::int FROM mushroom.trip_stop s WHERE s.trip_id=t.trip_id AND s.status='Done') AS stops_done
       FROM mushroom.trip t LEFT JOIN mushroom.partner p ON p.partner_id=t.partner_id
      WHERE t.coop_org_id=$1 ORDER BY t.trip_date DESC, t.created_at DESC LIMIT 200`,
    [coop],
  );
  return r.rows;
})));

/** แนะนำจุดแวะของวันที่กำหนด: สมาชิกที่มีการจองถึงกำหนด + สมาชิกที่มีกล่องอยู่ (รับเห็ด) */
router.get('/trips/suggest', h(async (req) => db(req, async (c, coop) => {
  const date = isDate(req.query.date) ? req.query.date : bkkToday();
  const s = await settings(c, coop);
  const r = await c.query(
    `SELECT m.member_id, m.full_name, m.member_code, m.distance_km, m.address,
            COALESCE((SELECT SUM(k.requested_boxes) FROM mushroom.box_booking k
                       WHERE k.member_id=m.member_id AND k.status IN ('Requested','Allocated') AND k.wanted_date <= $2),0)::int AS boxes_to_drop,
            (SELECT k.booking_id FROM mushroom.box_booking k WHERE k.member_id=m.member_id AND k.status IN ('Requested','Allocated')
              AND k.wanted_date <= $2 ORDER BY k.wanted_date LIMIT 1) AS booking_id,
            (SELECT COUNT(*)::int FROM mushroom.box_assignment a WHERE a.member_id=m.member_id AND a.returned_at IS NULL) AS boxes_on_hand
       FROM mushroom.member m WHERE m.coop_org_id=$1 AND m.status='Approved'`,
    [coop, date],
  );
  const stops = r.rows.filter((x) => x.boxes_to_drop > 0 || x.boxes_on_hand > 0)
    .map((x) => ({ ...x, over_max_distance: x.distance_km !== null && Number(x.distance_km) > Number(s.max_delivery_km) }))
    .sort((a, b) => (Number(a.distance_km) || 9999) - (Number(b.distance_km) || 9999));
  return { date, max_delivery_km: s.max_delivery_km, stops };
})));

router.post('/trips', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const b = req.body || {};
  if (!isDate(b.trip_date)) throw bad('invalid_trip_date');
  let partnerId = null;
  if (b.partner_id) {
    const p = await own(c, coop, 'partner', b.partner_id);
    if (p.partner_type !== 'transporter') throw bad('partner_not_transporter');
    partnerId = p.partner_id;
  }
  const stops = Array.isArray(b.stops) ? b.stops : [];
  if (!stops.length) throw bad('missing_stops');
  const t = (await c.query(
    `INSERT INTO mushroom.trip (coop_org_id, trip_date, vehicle, driver_name, partner_id, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [coop, b.trip_date, b.vehicle || null, b.driver_name || null, partnerId, b.note || null],
  )).rows[0];
  let seq = 0;
  for (const s of stops) {
    const m = await own(c, coop, 'member', s.member_id);
    seq += 1;
    const drop = num(s.drop_boxes ?? 0, { min: 0 });
    if (drop === null || Number.isNaN(drop) || !Number.isInteger(drop)) throw bad('invalid_field', { field: 'drop_boxes' });
    if (s.booking_id) await own(c, coop, 'booking', s.booking_id);
    await c.query(
      `INSERT INTO mushroom.trip_stop (trip_id, member_id, seq, drop_boxes, booking_id, collect_mushroom, collect_straw, collect_boxes, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [t.trip_id, m.member_id, seq, drop, s.booking_id || null, s.collect_mushroom !== false, !!s.collect_straw, !!s.collect_boxes, s.note || null],
    );
  }
  return t;
}))));

router.get('/trips/:id', h(async (req) => db(req, async (c, coop) => {
  const t = await own(c, coop, 'trip', req.params.id);
  const stops = (await c.query(
    `SELECT s.*, m.full_name, m.member_code, m.phone, m.address, m.distance_km,
            (SELECT COUNT(*)::int FROM mushroom.box_assignment a WHERE a.member_id=s.member_id AND a.returned_at IS NULL) AS boxes_on_hand
       FROM mushroom.trip_stop s JOIN mushroom.member m ON m.member_id=s.member_id WHERE s.trip_id=$1 ORDER BY s.seq`,
    [t.trip_id],
  )).rows;
  const harvest = (await c.query('SELECT SUM(weight_kg)::numeric AS kg, COUNT(*)::int AS n FROM mushroom.harvest WHERE trip_id=$1', [t.trip_id])).rows[0];
  return { ...t, stops, harvest };
})));

router.post('/trips/:id/start', h(async (req) => db(req, async (c, coop) => {
  const t = await own(c, coop, 'trip', req.params.id);
  if (t.status !== 'Planned') throw conflict('invalid_trip_status', { status: t.status });
  return (await c.query(`UPDATE mushroom.trip SET status='InProgress' WHERE trip_id=$1 RETURNING *`, [t.trip_id])).rows[0];
})));

/**
 * ปิดจุดแวะ: ในคำขอเดียวทำได้ทั้ง แจกกล่อง (batch_id + qr_codes/จำนวน),
 * รับเห็ด (harvests[]), รับฟาง (straw_kg), รับกล่องคืน (returns[]).
 */
router.post('/trips/:id/stops/:stopId/done', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const t = await own(c, coop, 'trip', req.params.id, { lock: true });
  if (!['Planned', 'InProgress'].includes(t.status)) throw conflict('invalid_trip_status', { status: t.status });
  if (!isUuid(req.params.stopId)) throw notFound('stop_not_found');
  const stop = (await c.query('SELECT * FROM mushroom.trip_stop WHERE stop_id=$1 AND trip_id=$2 FOR UPDATE', [req.params.stopId, t.trip_id])).rows[0];
  if (!stop) throw notFound('stop_not_found');
  if (stop.status !== 'Pending') throw conflict('stop_already_closed');
  const b = req.body || {};
  const result = {};
  if (b.batch_id && (Array.isArray(b.qr_codes) ? b.qr_codes.length : Number(b.drop_count) > 0)) {
    result.distributed = await distribute(c, coop, {
      batchId: b.batch_id, memberId: stop.member_id, qrCodes: b.qr_codes, count: b.drop_count, tripId: t.trip_id, bookingId: stop.booking_id,
    });
  }
  if (Array.isArray(b.harvests) && b.harvests.length) {
    result.harvests = [];
    for (const hv of b.harvests) {
      result.harvests.push(await recordHarvest(c, coop, { ...hv, member_id: stop.member_id, trip_id: t.trip_id }, actor(req)));
    }
  }
  if (b.straw_kg) {
    const qty = needPos(b.straw_kg, 'straw_kg');
    const s = await settings(c, coop);
    const mat = (await c.query(`SELECT material_id FROM mushroom.material WHERE coop_org_id=$1 AND code='rice_straw'`, [coop])).rows[0];
    const mv = (await c.query(
      `INSERT INTO mushroom.material_movement (coop_org_id, material_id, direction, qty_kg, unit_price, source_type, member_id, note)
       VALUES ($1,$2,'in',$3,$4,'member_straw',$5,'รับฟางระหว่างเที่ยวรถ') RETURNING movement_id`,
      [coop, mat.material_id, qty, s.straw_price_per_kg, stop.member_id],
    )).rows[0];
    await addLedger(c, coop, stop.member_id, 'straw_sale', qty * Number(s.straw_price_per_kg), 'material_movement', mv.movement_id,
      `ส่งฟาง ${qty} กก.`);
    result.straw_kg = qty;
  }
  if (Array.isArray(b.returns) && b.returns.length) result.returns = await returnBoxes(c, coop, b.returns, t.trip_id);
  await c.query(`UPDATE mushroom.trip_stop SET status=$2, done_at=now(), note=COALESCE($3, note) WHERE stop_id=$1`,
    [stop.stop_id, b.skipped ? 'Skipped' : 'Done', b.note || null]);
  if (t.status === 'Planned') await c.query(`UPDATE mushroom.trip SET status='InProgress' WHERE trip_id=$1`, [t.trip_id]);
  return result;
}))));

router.post('/trips/:id/complete', h(async (req) => db(req, async (c, coop) => {
  const t = await own(c, coop, 'trip', req.params.id);
  if (!['Planned', 'InProgress'].includes(t.status)) throw conflict('invalid_trip_status', { status: t.status });
  const b = req.body || {};
  const km = num(b.distance_km, { min: 0 });
  if (Number.isNaN(km)) throw bad('invalid_field', { field: 'distance_km' });
  const cost = num(b.cost ?? 0, { min: 0 });
  if (cost === null || Number.isNaN(cost)) throw bad('invalid_field', { field: 'cost' });
  await c.query(`UPDATE mushroom.trip_stop SET status='Skipped' WHERE trip_id=$1 AND status='Pending'`, [t.trip_id]);
  return (await c.query(`UPDATE mushroom.trip SET status='Done', distance_km=$2, cost=$3 WHERE trip_id=$1 RETURNING *`,
    [t.trip_id, km, cost])).rows[0];
})));

// ===========================================================================
// (7) บัญชีสมาชิก การหักกลบรายสัปดาห์ผ่าน ธ.ก.ส. และค่าบริการ AgroLink
// ===========================================================================
router.get('/ledger', h(async (req) => db(req, async (c, coop) => {
  const params = [coop];
  let f = '';
  if (req.query.member_id) { params.push(needUuid(req.query.member_id, 'member_id')); f = 'AND l.member_id=$2'; }
  if (req.query.unsettled === '1') f += ' AND l.run_id IS NULL';
  const r = await c.query(
    `SELECT l.*, m.full_name AS member_name, m.member_code FROM mushroom.member_ledger l
       JOIN mushroom.member m ON m.member_id=l.member_id
      WHERE l.coop_org_id=$1 ${f} ORDER BY l.entry_date DESC, l.created_at DESC LIMIT 500`,
    params,
  );
  return r.rows;
})));

router.post('/ledger/adjust', h(async (req) => db(req, async (c, coop) => {
  const b = req.body || {};
  const m = await own(c, coop, 'member', b.member_id);
  const amount = num(b.amount);
  if (amount === null || Number.isNaN(amount) || amount === 0) throw bad('invalid_field', { field: 'amount' });
  const note = String(b.note || '').trim();
  if (!note) throw bad('missing_note');
  await addLedger(c, coop, m.member_id, 'adjustment', amount, null, null, `${note} (โดย ${actor(req)})`);
  return { ok: true };
})));

router.get('/settlements', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query('SELECT * FROM mushroom.settlement_run WHERE coop_org_id=$1 ORDER BY period_end DESC, created_at DESC LIMIT 100', [coop]);
  return r.rows;
})));

/**
 * สร้างรอบหักกลบ (Draft): รวมรายการที่ยังไม่เข้ารอบถึง period_end ต่อสมาชิก.
 * สมาชิกที่ยอดสุทธิติดลบ (เช่นค่ากล่องหายมากกว่ารายได้) ยกไปรอบถัดไป ไม่จ่ายติดลบ.
 */
router.post('/settlements', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const periodEnd = (req.body || {}).period_end || bkkToday();
  if (!isDate(periodEnd)) throw bad('invalid_period_end');
  const open = (await c.query(`SELECT 1 FROM mushroom.settlement_run WHERE coop_org_id=$1 AND status='Draft'`, [coop])).rows;
  if (open.length) throw conflict('draft_run_exists');
  const last = (await c.query(
    `SELECT MAX(period_end)::text AS d FROM mushroom.settlement_run WHERE coop_org_id=$1 AND status <> 'Cancelled'`, [coop],
  )).rows[0].d;
  const sums = (await c.query(
    `SELECT l.member_id, SUM(GREATEST(l.amount,0)) AS credit, SUM(LEAST(l.amount,0)) AS debit, SUM(l.amount) AS net,
            MIN(l.entry_date)::text AS first_date, m.baac_account_no, m.baac_account_name, m.full_name
       FROM mushroom.member_ledger l JOIN mushroom.member m ON m.member_id=l.member_id
      WHERE l.coop_org_id=$1 AND l.run_id IS NULL AND l.entry_date <= $2
      GROUP BY l.member_id, m.member_id`,
    [coop, periodEnd],
  )).rows;
  const payable = sums.filter((s) => Number(s.net) > 0);
  if (!payable.length) throw conflict('nothing_to_settle');
  const firstDate = payable.reduce((d, s) => (s.first_date < d ? s.first_date : d), payable[0].first_date);
  const periodStart = last ? new Date(Date.parse(`${last}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : firstDate;
  const run = (await c.query(
    `INSERT INTO mushroom.settlement_run (coop_org_id, period_start, period_end) VALUES ($1, LEAST($2::date,$3::date), $3) RETURNING *`,
    [coop, periodStart, periodEnd],
  )).rows[0];
  let total = 0;
  for (const s of payable) {
    await c.query(
      `INSERT INTO mushroom.settlement_line (run_id, member_id, total_credit, total_debit, net_amount, baac_account_no, baac_account_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [run.run_id, s.member_id, s.credit, Math.abs(Number(s.debit)), s.net, s.baac_account_no, s.baac_account_name || s.full_name],
    );
    await c.query(
      `UPDATE mushroom.member_ledger SET run_id=$1 WHERE coop_org_id=$2 AND member_id=$3 AND run_id IS NULL AND entry_date <= $4`,
      [run.run_id, coop, s.member_id, periodEnd],
    );
    total += Number(s.net);
  }
  const r = (await c.query('UPDATE mushroom.settlement_run SET total_net=$2, member_count=$3 WHERE run_id=$1 RETURNING *',
    [run.run_id, round2(total), payable.length])).rows[0];
  await logAccess(c, 'write', 'mushroom.settlement_run', run.run_id);
  return { ...r, carried_forward_members: sums.length - payable.length };
}))));

router.get('/settlements/:id', h(async (req) => db(req, async (c, coop) => {
  const run = await own(c, coop, 'run', req.params.id);
  const lines = (await c.query(
    `SELECT s.*, m.full_name, m.member_code FROM mushroom.settlement_line s JOIN mushroom.member m ON m.member_id=s.member_id
      WHERE s.run_id=$1 ORDER BY m.member_code`,
    [run.run_id],
  )).rows;
  return { ...run, lines, missing_account: lines.filter((l) => !l.baac_account_no).length };
})));

router.post('/settlements/:id/submit', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const run = await own(c, coop, 'run', req.params.id, { lock: true });
  if (run.status !== 'Draft') throw conflict('invalid_run_status', { status: run.status });
  // ดึงเลขบัญชีล่าสุดจากทะเบียนสมาชิก (อาจแก้ไขหลังสร้าง Draft)
  await c.query(
    `UPDATE mushroom.settlement_line s SET baac_account_no=m.baac_account_no, baac_account_name=COALESCE(m.baac_account_name, m.full_name)
       FROM mushroom.member m WHERE m.member_id=s.member_id AND s.run_id=$1`,
    [run.run_id],
  );
  const missing = (await c.query(
    `SELECT m.full_name FROM mushroom.settlement_line s JOIN mushroom.member m ON m.member_id=s.member_id
      WHERE s.run_id=$1 AND s.baac_account_no IS NULL`,
    [run.run_id],
  )).rows;
  if (missing.length) throw conflict('missing_baac_account', { members: missing.map((x) => x.full_name) });
  const endTxt = (await c.query('SELECT period_end::text AS d FROM mushroom.settlement_run WHERE run_id=$1', [run.run_id])).rows[0].d;
  const ref = `MUSH-${endTxt.replace(/-/g, '')}-${run.run_id.slice(0, 6).toUpperCase()}`;
  return (await c.query(`UPDATE mushroom.settlement_run SET status='Submitted', submitted_at=now(), baac_batch_ref=$2 WHERE run_id=$1 RETURNING *`,
    [run.run_id, ref])).rows[0];
}))));

/**
 * ไฟล์โอนเงินสำหรับ ธ.ก.ส. (CSV UTF-8 มี BOM เปิดใน Excel ได้). หมายเหตุ: รูปแบบ
 * ไฟล์ Bulk Payment จริงของ ธ.ก.ส. ต้องยืนยันกับธนาคารก่อนใช้งานจริง — ไฟล์นี้
 * เป็นรูปแบบกลาง (ลำดับ, เลขบัญชี, ชื่อบัญชี, จำนวนเงิน, อ้างอิง).
 */
router.get('/settlements/:id/baac-export', h(async (req, res) => db(req, async (c, coop) => {
  const run = await own(c, coop, 'run', req.params.id);
  if (!['Submitted', 'Paid'].includes(run.status)) throw conflict('run_not_submitted');
  const lines = (await c.query(
    `SELECT s.*, m.member_code FROM mushroom.settlement_line s JOIN mushroom.member m ON m.member_id=s.member_id
      WHERE s.run_id=$1 ORDER BY m.member_code`,
    [run.run_id],
  )).rows;
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['seq', 'baac_account_no', 'account_name', 'amount_thb', 'member_code', 'reference'].join(',')];
  lines.forEach((l, i) => rows.push([i + 1, esc(l.baac_account_no), esc(l.baac_account_name), Number(l.net_amount).toFixed(2),
    esc(l.member_code), esc(run.baac_batch_ref)].join(',')));
  await logAccess(c, 'read', 'mushroom.settlement_run', run.run_id);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${run.baac_batch_ref}.csv"`);
  res.send(`﻿${rows.join('\r\n')}\r\n`);
  return undefined;
})));

router.post('/settlements/:id/paid', h(async (req) => db(req, async (c, coop) => {
  const run = await own(c, coop, 'run', req.params.id);
  if (run.status !== 'Submitted') throw conflict('invalid_run_status', { status: run.status });
  return (await c.query(`UPDATE mushroom.settlement_run SET status='Paid', paid_at=now() WHERE run_id=$1 RETURNING *`, [run.run_id])).rows[0];
})));

router.post('/settlements/:id/cancel', h(async (req) => db(req, async (c, coop) => tx(c, async () => {
  const run = await own(c, coop, 'run', req.params.id, { lock: true });
  if (!['Draft', 'Submitted'].includes(run.status)) throw conflict('invalid_run_status', { status: run.status });
  await c.query('UPDATE mushroom.member_ledger SET run_id=NULL WHERE run_id=$1', [run.run_id]);
  return (await c.query(`UPDATE mushroom.settlement_run SET status='Cancelled' WHERE run_id=$1 RETURNING *`, [run.run_id])).rows[0];
}))));

router.get('/fees', h(async (req) => db(req, async (c, coop) => {
  const params = [coop];
  let f = '';
  if (isDate(req.query.from)) { params.push(req.query.from); f += ` AND created_at >= $${params.length}::date`; }
  if (isDate(req.query.to)) { params.push(req.query.to); f += ` AND created_at < $${params.length}::date + 1`; }
  const r = await c.query(
    `SELECT fee_type, payer_type, COUNT(*)::int AS n, SUM(base_amount)::numeric AS base, SUM(fee_amount)::numeric AS fee
       FROM mushroom.platform_fee WHERE coop_org_id=$1 ${f} GROUP BY 1,2 ORDER BY 1`,
    params,
  );
  return r.rows;
})));

// ===========================================================================
// (9) IoT และรายงาน
// ===========================================================================
const LOCATION_TYPES = ['steam_room', 'spawn_room', 'fruiting_site', 'cold_storage'];

router.get('/iot/devices', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(
    `SELECT d.device_id, d.name, d.location_type, d.member_id, m.full_name AS member_name, d.temp_min, d.temp_max, d.rh_min, d.rh_max,
            d.auto_mist, d.active, d.last_seen_at,
            (SELECT row_to_json(x) FROM (SELECT recorded_at, temp_c, rh_pct FROM mushroom.iot_reading r WHERE r.device_id=d.device_id
              ORDER BY recorded_at DESC LIMIT 1) x) AS last_reading,
            (SELECT COUNT(*)::int FROM mushroom.iot_alert a WHERE a.device_id=d.device_id AND a.acknowledged_at IS NULL) AS open_alerts
       FROM mushroom.iot_device d LEFT JOIN mushroom.member m ON m.member_id=d.member_id
      WHERE d.coop_org_id=$1 ORDER BY d.created_at`,
    [coop],
  );
  return r.rows;
})));

function deviceThresholds(b) {
  const out = {};
  ['temp_min', 'temp_max', 'rh_min', 'rh_max'].forEach((f) => {
    if (!(f in b)) return;
    const v = num(b[f], { min: -20, max: 120 });
    if (Number.isNaN(v)) throw bad('invalid_field', { field: f });
    out[f] = v;
  });
  return out;
}

router.post('/iot/devices', h(async (req) => db(req, async (c, coop) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) throw bad('missing_name');
  if (!LOCATION_TYPES.includes(b.location_type)) throw bad('invalid_location_type');
  let memberId = null;
  if (b.member_id) memberId = (await own(c, coop, 'member', b.member_id)).member_id;
  const th = deviceThresholds(b);
  const s = await settings(c, coop);
  if (b.location_type === 'spawn_room') {
    if (th.temp_min === undefined) th.temp_min = s.spawn_run_temp_min;
    if (th.temp_max === undefined) th.temp_max = s.spawn_run_temp_max;
  }
  const apiKey = `mk_${crypto.randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const r = await c.query(
    `INSERT INTO mushroom.iot_device (coop_org_id, name, location_type, member_id, api_key_hash, temp_min, temp_max, rh_min, rh_max, auto_mist)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING device_id, name, location_type, temp_min, temp_max, rh_min, rh_max, auto_mist`,
    [coop, name, b.location_type, memberId, hash, th.temp_min ?? null, th.temp_max ?? null, th.rh_min ?? null, th.rh_max ?? null, !!b.auto_mist],
  );
  return { ...r.rows[0], api_key: apiKey, api_key_note: 'แสดงครั้งเดียว — ใส่ในอุปกรณ์เป็น header X-Device-Key' };
})));

router.put('/iot/devices/:id', h(async (req) => db(req, async (c, coop) => {
  const d = await own(c, coop, 'device', req.params.id);
  const b = req.body || {};
  const th = deviceThresholds(b);
  if ('auto_mist' in b) th.auto_mist = !!b.auto_mist;
  if ('active' in b) th.active = !!b.active;
  if ('name' in b) { th.name = String(b.name || '').trim(); if (!th.name) throw bad('missing_name'); }
  const keys = Object.keys(th);
  if (!keys.length) return d;
  return (await c.query(
    `UPDATE mushroom.iot_device SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE device_id=$1
     RETURNING device_id, name, location_type, temp_min, temp_max, rh_min, rh_max, auto_mist, active`,
    [d.device_id, ...Object.values(th)],
  )).rows[0];
})));

router.get('/iot/devices/:id/readings', h(async (req) => db(req, async (c, coop) => {
  const d = await own(c, coop, 'device', req.params.id);
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 14);
  const r = await c.query(
    `SELECT recorded_at, temp_c, rh_pct FROM mushroom.iot_reading WHERE device_id=$1 AND recorded_at >= now() - ($2 || ' hours')::interval
      ORDER BY recorded_at`,
    [d.device_id, String(hours)],
  );
  return r.rows;
})));

router.post('/iot/devices/:id/command', h(async (req) => db(req, async (c, coop) => {
  const d = await own(c, coop, 'device', req.params.id);
  const cmd = (req.body || {}).command;
  if (!['mist_on', 'mist_off'].includes(cmd)) throw bad('invalid_command');
  return (await c.query(`INSERT INTO mushroom.iot_command (device_id, command) VALUES ($1,$2) RETURNING *`, [d.device_id, cmd])).rows[0];
})));

router.get('/iot/alerts', h(async (req) => db(req, async (c, coop) => {
  const r = await c.query(
    `SELECT a.*, d.name AS device_name, d.location_type FROM mushroom.iot_alert a JOIN mushroom.iot_device d USING (device_id)
      WHERE d.coop_org_id=$1 ORDER BY (a.acknowledged_at IS NULL) DESC, a.created_at DESC LIMIT 200`,
    [coop],
  );
  return r.rows;
})));

router.post('/iot/alerts/:id/ack', h(async (req) => db(req, async (c, coop) => {
  if (!isUuid(req.params.id)) throw notFound('alert_not_found');
  const r = await c.query(
    `UPDATE mushroom.iot_alert a SET acknowledged_at=now() FROM mushroom.iot_device d
      WHERE a.alert_id=$1 AND d.device_id=a.device_id AND d.coop_org_id=$2 AND a.acknowledged_at IS NULL RETURNING a.*`,
    [req.params.id, coop],
  );
  if (!r.rows.length) throw notFound('alert_not_found');
  return r.rows[0];
})));

/** รายงานสรุปช่วงเวลา (ค่าเริ่มต้น 30 วันล่าสุด) */
router.get('/reports/summary', h(async (req) => db(req, async (c, coop) => {
  const to = isDate(req.query.to) ? req.query.to : bkkToday();
  const from = isDate(req.query.from) ? req.query.from : new Date(Date.parse(to) - 29 * 86400000).toISOString().slice(0, 10);
  const P = [coop, from, to];
  const inRange = (col) => `${col} >= ($2::date AT TIME ZONE 'Asia/Bangkok') AND ${col} < (($3::date + 1) AT TIME ZONE 'Asia/Bangkok')`;
  const batches = (await c.query(
    `SELECT b.batch_code, b.status, r.name AS recipe_name, s.lot_no AS spawn_lot_no, b.boxes_planned, b.boxes_bad,
            (SELECT COALESCE(SUM(amount),0) FROM mushroom.batch_cost x WHERE x.batch_id=b.batch_id)::numeric AS total_cost,
            (SELECT COUNT(*) FROM mushroom.box_assignment a WHERE a.batch_id=b.batch_id)::int AS boxes_distributed,
            (SELECT COALESCE(SUM(weight_kg),0) FROM mushroom.harvest h WHERE h.batch_id=b.batch_id)::numeric AS harvest_kg,
            (SELECT COALESCE(SUM(amount),0) FROM mushroom.harvest h WHERE h.batch_id=b.batch_id)::numeric AS harvest_paid
       FROM mushroom.batch b JOIN mushroom.recipe r ON r.recipe_id=b.recipe_id LEFT JOIN mushroom.spawn_lot s ON s.spawn_lot_id=b.spawn_lot_id
      WHERE b.coop_org_id=$1 AND b.compost_started_on BETWEEN $2 AND $3 ORDER BY b.compost_started_on`,
    P,
  )).rows.map((b) => ({
    ...b,
    cost_per_box: b.boxes_planned ? round2(Number(b.total_cost) / b.boxes_planned) : null,
    kg_per_box: b.boxes_distributed ? round2(Number(b.harvest_kg) / b.boxes_distributed) : null,
    loss_rate_pct: b.boxes_planned ? round2((100 * b.boxes_bad) / b.boxes_planned) : null,
  }));
  const groupBy = (key) => {
    const m = new Map();
    batches.forEach((b) => {
      const k = b[key] || '-';
      const g = m.get(k) || { [key]: k, batches: 0, boxes_distributed: 0, harvest_kg: 0, total_cost: 0, boxes_planned: 0 };
      g.batches += 1; g.boxes_distributed += b.boxes_distributed; g.harvest_kg += Number(b.harvest_kg);
      g.total_cost += Number(b.total_cost); g.boxes_planned += b.boxes_planned;
      m.set(k, g);
    });
    return [...m.values()].map((g) => ({
      ...g, harvest_kg: round2(g.harvest_kg), total_cost: round2(g.total_cost),
      kg_per_box: g.boxes_distributed ? round2(g.harvest_kg / g.boxes_distributed) : null,
      cost_per_box: g.boxes_planned ? round2(g.total_cost / g.boxes_planned) : null,
    }));
  };
  const members = (await c.query(
    `SELECT m.member_code, m.full_name,
            (SELECT COUNT(*) FROM mushroom.box_assignment a WHERE a.member_id=m.member_id AND ${inRange('a.delivered_at')})::int AS boxes_received,
            (SELECT COALESCE(SUM(weight_kg),0) FROM mushroom.harvest h WHERE h.member_id=m.member_id AND ${inRange('h.collected_at')})::numeric AS harvest_kg,
            (SELECT COALESCE(SUM(amount),0) FROM mushroom.member_ledger l WHERE l.member_id=m.member_id AND l.entry_date BETWEEN $2 AND $3)::numeric AS net_income,
            (SELECT COUNT(*) FROM mushroom.box_assignment a WHERE a.member_id=m.member_id AND a.outcome IN ('Lost','Broken') AND ${inRange('a.returned_at')})::int AS boxes_lost_broken
       FROM mushroom.member m WHERE m.coop_org_id=$1 AND m.status <> 'Pending' ORDER BY net_income DESC`,
    P,
  )).rows.map((m) => ({ ...m, kg_per_box: m.boxes_received ? round2(Number(m.harvest_kg) / m.boxes_received) : null }));
  const [totals] = (await c.query(
    `SELECT
       (SELECT COALESCE(SUM(qty_kg),0) FROM mushroom.material_movement WHERE coop_org_id=$1 AND source_type='member_straw' AND ${inRange('moved_at')})::numeric AS straw_from_members_kg,
       (SELECT COALESCE(SUM(qty_kg),0) FROM mushroom.material_movement WHERE coop_org_id=$1 AND direction='in' AND ${inRange('moved_at')})::numeric AS biomass_in_kg,
       (SELECT COALESCE(SUM(spent_substrate_kg),0) FROM mushroom.box_assignment WHERE coop_org_id=$1 AND ${inRange('returned_at')})::numeric AS spent_substrate_kg,
       (SELECT COALESCE(SUM(weight_kg),0) FROM mushroom.harvest WHERE coop_org_id=$1 AND ${inRange('collected_at')})::numeric AS harvest_kg,
       (SELECT COALESCE(SUM(amount),0) FROM mushroom.harvest WHERE coop_org_id=$1 AND ${inRange('collected_at')})::numeric AS paid_to_members,
       (SELECT COALESCE(SUM(amount),0) FROM mushroom.sales_order WHERE coop_org_id=$1 AND status IN ('Delivered','Paid') AND ${inRange('delivered_at')})::numeric AS sales_amount,
       (SELECT COALESCE(SUM(qty_kg),0) FROM mushroom.sales_order WHERE coop_org_id=$1 AND status <> 'Cancelled' AND ${inRange('created_at')}
           AND (order_kind='contract' OR confirmed_at IS NOT NULL))::numeric AS presold_kg,
       (SELECT COALESCE(SUM(cost),0) FROM mushroom.trip WHERE coop_org_id=$1 AND trip_date BETWEEN $2 AND $3)::numeric AS transport_cost`,
    P,
  )).rows;
  const fees = (await c.query(
    `SELECT fee_type, SUM(fee_amount)::numeric AS fee FROM mushroom.platform_fee WHERE coop_org_id=$1 AND ${inRange('created_at')} GROUP BY 1`,
    P,
  )).rows;
  return {
    from, to,
    totals: {
      ...totals,
      straw_not_burned_ton: round2(Number(totals.straw_from_members_kg) / 1000),
      presold_share_pct: Number(totals.harvest_kg) > 0 ? round2((100 * Number(totals.presold_kg)) / Number(totals.harvest_kg)) : null,
    },
    batches,
    by_recipe: groupBy('recipe_name'),
    by_spawn_lot: groupBy('spawn_lot_no'),
    members,
    fees,
  };
})));

router.forecast = forecast;
module.exports = router;
