/**
 * ตรวจสอบย้อนกลับสายพืชผล — db/grant_crop_traceability.sql · lib/cropTrace.js
 *
 *   /coop/trace/...    พอร์ทัลสหกรณ์ (เข้าสู่ระบบ): ค้นด้วยรหัส LT-/PB-/FG- หรือสมาชิก เห็นสายเต็มทั้งย้อนกลับและตามไปข้างหน้า
 *                      เปิด/ปิดหน้าสาธารณะรายล็อต/รายสินค้า
 *   /public/trace/...  ไม่ต้องเข้าสู่ระบบ: หน้าที่ QR บนบรรจุภัณฑ์ชี้มา — ข้อมูลที่ไม่ระบุตัวบุคคลเท่านั้น + รูป QR (SVG)
 */
const express = require('express');
const qrcode = require('qrcode-generator');
const { withSessionContext, withServiceRole } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');
const T = require('../lib/cropTrace');

const PUBLIC_SITE = (process.env.PUBLIC_SITE_URL || 'https://www.agrolinkthai.com').replace(/\/+$/, '');
const publicUrl = (code) => `${PUBLIC_SITE}/trace.html?c=${encodeURIComponent(code)}`;
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const h = (fn) => (req, res, next) => fn(req, res).catch(next);

async function coopOf(c, orgId) {
  return (await c.query(
    `SELECT o.org_id, o.org_name, pv.province_name_th FROM identity.organization o
       LEFT JOIN registry.cooperative_profile cp ON cp.org_id = o.org_id LEFT JOIN registry.province pv ON pv.province_code = cp.province_code
      WHERE o.org_id = $1`, [orgId],
  )).rows[0] || null;
}

// =================================================================== พอร์ทัลสหกรณ์
const coop = express.Router();
coop.use(requireAuth, requireOrganization);
coop.use(async (req, res, next) => {
  try {
    const ok = await withSessionContext('organization', req.subject.subjectId, async (c) => (await c.query(
      `SELECT 1 FROM identity.organization o JOIN identity.organization_role r ON r.org_id = o.org_id AND r.role_type = 'Cooperative' AND r.status = 'Verified'
        WHERE o.org_id = $1 AND o.kyb_status = 'Verified'`, [req.subject.subjectId],
    )).rows[0]);
    if (!ok) return res.status(403).json({ error: 'cooperative_subject_required' });
    req.orgId = req.subject.subjectId;
    return next();
  } catch (err) { return next(err); }
});

const db = (req, fn) => withSessionContext('organization', req.orgId, fn);
async function full(c, start, orgId) {
  const t = await T.loadTrace(c, start, orgId);
  if (!t) return null;
  const codes = [...t.lots.map((l) => l.trace_code), ...t.finished_goods.map((f) => f.trace_code)];
  const scans = codes.length ? (await c.query('SELECT trace_code, SUM(scans)::int AS scans FROM traceability.public_scan WHERE trace_code = ANY($1) GROUP BY 1', [codes])).rows : [];
  return { ...t, summary: T.summarize(t), scans: Object.fromEntries(scans.map((s) => [s.trace_code, s.scans])), public_base: `${PUBLIC_SITE}/trace.html?c=` };
}

/** ล็อตและสินค้าล่าสุด + ค้นด้วยรหัส/ชื่อสมาชิก/รหัสสมาชิก */
coop.get('/search', h(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  res.json(await db(req, async (c) => {
    const org = req.orgId;
    const like = `%${q}%`;
    const lots = (await c.query(
      `SELECT 'lot' AS type, l.trace_code AS code, COALESCE(l.lot_note, cr.name_th, l.commodity_code) AS label, l.status, l.created_at AS at,
              (SELECT COALESCE(SUM(d.quantity_ton), 0) FROM produce.delivery d WHERE d.lot_id = l.lot_id)::numeric AS quantity_ton
         FROM produce.lot l LEFT JOIN registry.commodity_ref cr ON cr.commodity_code = l.commodity_code
        WHERE l.buyer_org_id = $1 AND ($2 = '' OR l.trace_code ILIKE $3 OR l.lot_note ILIKE $3 OR cr.name_th ILIKE $3)
        ORDER BY l.created_at DESC LIMIT 15`, [org, q, like],
    )).rows;
    const fgs = (await c.query(
      `SELECT 'finished_good' AS type, fg.trace_code AS code, fg.product_name AS label, b.status, fg.recorded_at AS at, fg.quantity_ton
         FROM processing.finished_good fg JOIN processing.batch b ON b.batch_id = fg.batch_id
        WHERE b.org_id = $1 AND ($2 = '' OR fg.trace_code ILIKE $3 OR fg.product_name ILIKE $3)
        ORDER BY fg.recorded_at DESC LIMIT 15`, [org, q, like],
    )).rows;
    const batches = q ? (await c.query(
      `SELECT 'batch' AS type, trace_code AS code, output_product_name AS label, status, started_at AS at, NULL::numeric AS quantity_ton
         FROM processing.batch WHERE org_id = $1 AND (trace_code ILIKE $2 OR output_product_name ILIKE $2) ORDER BY started_at DESC LIMIT 10`, [org, like],
    )).rows : [];
    const farmers = q.length >= 2 ? (await c.query(
      `SELECT DISTINCT 'farmer' AS type, f.farmer_id::text AS code, f.full_name AS label, f.farmer_code AS status, NULL::timestamptz AS at, NULL::numeric AS quantity_ton
         FROM produce.delivery d JOIN registry.production_unit pu ON pu.unit_id = d.unit_id JOIN identity.farmer f ON f.farmer_id = pu.owner_farmer_id
        WHERE d.buyer_org_id = $1 AND (f.full_name ILIKE $2 OR f.farmer_code ILIKE $2) LIMIT 10`, [org, like],
    )).rows : [];
    return [...fgs, ...lots, ...batches, ...farmers].map((r) => ({ ...r, quantity_ton: r.quantity_ton === null ? null : Number(r.quantity_ton) }));
  }));
}));

coop.get('/code/:code', h(async (req, res) => {
  const out = await db(req, async (c) => {
    const r = await T.resolveCode(c, req.params.code);
    if (!r || r.org_id !== req.orgId) return null;
    return full(c, { type: r.type, id: r.id, code: r.code }, req.orgId);
  });
  if (!out) { res.status(404).json({ error: 'trace_code_not_found' }); return; }
  res.json(out);
}));

/** ตามไปข้างหน้าจากสมาชิก: ผลผลิตของสมาชิกรายนี้ไปอยู่ในล็อต รอบแปรรูป สินค้า และเที่ยวขนส่งใด (เรียกคืนสินค้า) */
coop.get('/farmer/:farmerId', h(async (req, res) => {
  if (!isUuid(req.params.farmerId)) { res.status(404).json({ error: 'farmer_not_found' }); return; }
  const out = await db(req, async (c) => {
    const f = (await c.query('SELECT farmer_id, full_name, farmer_code FROM identity.farmer WHERE farmer_id = $1', [req.params.farmerId])).rows[0];
    if (!f) return null;
    const t = await full(c, { type: 'farmer', id: f.farmer_id }, req.orgId);
    return t && { ...t, farmer: f };
  });
  if (!out) { res.status(404).json({ error: 'farmer_not_found' }); return; }
  res.json(out);
}));

coop.post('/code/:code/public', h(async (req, res) => {
  const on = (req.body || {}).public_trace === true;
  const out = await db(req, async (c) => {
    const r = await T.resolveCode(c, req.params.code);
    if (!r || r.org_id !== req.orgId) return { status: 404, body: { error: 'trace_code_not_found' } };
    if (r.type === 'batch') return { status: 400, body: { error: 'batch_has_no_public_page' } };
    const table = r.type === 'lot' ? 'produce.lot' : 'processing.finished_good';
    await c.query(`UPDATE ${table} SET public_trace = $2 WHERE trace_code = $1`, [r.code, on]);
    return { status: 200, body: { code: r.code, public_trace: on } };
  });
  res.status(out.status).json(out.body);
}));

// =================================================================== สาธารณะ (ไม่ต้องเข้าสู่ระบบ)
const pub = express.Router();
async function publicResolve(c, raw) {
  const r = await T.resolveCode(c, raw);
  if (!r || r.type === 'batch' || !r.public_trace) return null;
  return r;
}
pub.get('/:code/qr.svg', h(async (req, res) => {
  const r = await withServiceRole((c) => publicResolve(c, req.params.code));
  if (!r) { res.status(404).json({ error: 'trace_code_not_found' }); return; }
  const qr = qrcode(0, 'M');
  qr.addData(publicUrl(r.code));
  qr.make();
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(qr.createSvgTag({ cellSize: 8, margin: 4, scalable: true }));
}));
pub.get('/:code', h(async (req, res) => {
  const out = await withServiceRole(async (c) => {
    const r = await publicResolve(c, req.params.code);
    if (!r) return null;
    const t = await T.loadTrace(c, { type: r.type, id: r.id, code: r.code }, r.org_id);
    if (!t) return null;
    await c.query(
      `INSERT INTO traceability.public_scan (trace_code, scan_date, scans) VALUES ($1, (now() AT TIME ZONE 'Asia/Bangkok')::date, 1)
       ON CONFLICT (trace_code, scan_date) DO UPDATE SET scans = traceability.public_scan.scans + 1`, [r.code],
    );
    return { ...T.publicView(t, await coopOf(c, r.org_id)), url: publicUrl(r.code) };
  });
  if (!out) { res.status(404).json({ error: 'trace_code_not_found' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.json(out);
}));

module.exports = { coop, pub, publicUrl };
