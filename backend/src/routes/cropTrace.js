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
const OC = require('../lib/originCert');

const PUBLIC_SITE = (process.env.PUBLIC_SITE_URL || 'https://www.agrolinkthai.com').replace(/\/+$/, '');
const publicUrl = (code) => `${PUBLIC_SITE}/trace.html?c=${encodeURIComponent(code)}`;
const certUrl = (no) => `${PUBLIC_SITE}/certificate.html?no=${encodeURIComponent(no)}`;
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

// ---- ใบรับรองแหล่งที่มา (grant_origin_certificate.sql) ----
const CERT_COLS = 'cert_no, trace_code, subject_type, status, issued_by, issued_at, revoked_at, revoked_reason, payload_sha256, prev_sha256';
coop.post('/code/:code/certificate', h(async (req, res) => {
  const out = await db(req, async (c) => {
    const r = await T.resolveCode(c, req.params.code);
    if (!r || r.org_id !== req.orgId) return { status: 404, body: { error: 'trace_code_not_found' } };
    if (r.type === 'batch') return { status: 400, body: { error: 'certificate_for_lot_or_product_only' } };
    const ready = r.type === 'lot'
      ? (await c.query('SELECT status = \'Closed\' AS ok FROM produce.lot WHERE lot_id = $1', [r.id])).rows[0].ok
      : (await c.query(`SELECT b.status = 'Completed' AS ok FROM processing.finished_good fg JOIN processing.batch b ON b.batch_id = fg.batch_id WHERE fg.finished_good_id = $1`, [r.id])).rows[0].ok;
    if (!ready) return { status: 409, body: { error: r.type === 'lot' ? 'lot_not_closed' : 'batch_not_completed' } };
    const t = await T.loadTrace(c, { type: r.type, id: r.id, code: r.code }, req.orgId);
    if (!t || !t.deliveries.length) return { status: 409, body: { error: 'no_origin_data' } };
    await c.query('BEGIN');
    try {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`origin_cert:${req.orgId}`]); // ต่อสายแฮชตามลำดับ
      const core = await OC.buildCore(c, t, req.orgId);
      const prev = (await c.query('SELECT payload_sha256 FROM traceability.origin_certificate WHERE org_id = $1 ORDER BY issued_at DESC, cert_id DESC LIMIT 1', [req.orgId])).rows[0];
      const certNo = (await c.query("SELECT traceability.new_trace_code('OC') AS no")).rows[0].no;
      const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
      const payload = { cert_no: certNo, issued_at: issuedAt, issuer: 'AgroLink Traceability', core, prev_sha256: prev ? prev.payload_sha256 : null };
      const row = (await c.query(
        `INSERT INTO traceability.origin_certificate (cert_no, org_id, subject_type, subject_id, trace_code, payload, payload_sha256, prev_sha256, issued_by, issued_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${CERT_COLS}`,
        [certNo, req.orgId, r.type, r.id, r.code, JSON.stringify(payload), OC.sha256(payload), payload.prev_sha256, `org:${req.orgId}`, issuedAt],
      )).rows[0];
      await c.query('COMMIT');
      return { status: 201, body: { ...row, verify_url: certUrl(certNo) } };
    } catch (err) { await c.query('ROLLBACK'); throw err; }
  });
  res.status(out.status).json(out.body);
}));
coop.get('/code/:code/certificates', h(async (req, res) => {
  res.json(await db(req, async (c) => {
    const r = await T.resolveCode(c, req.params.code);
    if (!r || r.org_id !== req.orgId) return [];
    return (await c.query(`SELECT ${CERT_COLS} FROM traceability.origin_certificate WHERE trace_code = $1 AND org_id = $2 ORDER BY issued_at DESC`, [r.code, req.orgId]))
      .rows.map((x) => ({ ...x, verify_url: certUrl(x.cert_no) }));
  }));
}));
coop.post('/certificates/:no/revoke', h(async (req, res) => {
  const no = OC.normCertNo(req.params.no);
  const reason = String((req.body || {}).reason || '').trim().replace(/\s+/g, ' ');
  if (reason.length < 5 || reason.length > 500) { res.status(400).json({ error: 'reason_required' }); return; }
  const row = await db(req, async (c) => (await c.query(
    `UPDATE traceability.origin_certificate SET status = 'Revoked', revoked_at = now(), revoked_by = $3, revoked_reason = $4
      WHERE cert_no = $1 AND org_id = $2 AND status = 'Issued' RETURNING ${CERT_COLS}`, [no, req.orgId, `org:${req.orgId}`, reason],
  )).rows[0]);
  if (!row) { res.status(404).json({ error: 'certificate_not_found_or_revoked' }); return; }
  res.json(row);
}));

async function certPdf(c, no, orgId) {
  const cert = (await c.query(`SELECT * FROM traceability.origin_certificate WHERE cert_no = $1 ${orgId ? 'AND org_id = $2' : ''}`, orgId ? [no, orgId] : [no])).rows[0];
  if (!cert) return null;
  return { cert, pdf: await OC.renderPdf(cert, { verifyUrl: certUrl(cert.cert_no) }) };
}
const sendPdf = (res, x) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${x.cert.cert_no}.pdf"`);
  res.send(x.pdf);
};
coop.get('/certificates/:no/pdf', h(async (req, res) => {
  const x = await db(req, (c) => certPdf(c, OC.normCertNo(req.params.no), req.orgId));
  if (!x) { res.status(404).json({ error: 'certificate_not_found' }); return; }
  sendPdf(res, x);
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
    const hasCert = (await c.query("SELECT to_regclass('traceability.origin_certificate') IS NOT NULL AS ok")).rows[0].ok;
    const certificates = hasCert ? (await c.query(
      `SELECT cert_no, status, issued_at, revoked_at FROM traceability.origin_certificate WHERE trace_code = $1 ORDER BY issued_at DESC LIMIT 10`, [r.code],
    )).rows.map((x) => ({ ...x, verify_url: certUrl(x.cert_no) })) : [];
    return { ...T.publicView(t, await coopOf(c, r.org_id)), url: publicUrl(r.code), certificates };
  });
  if (!out) { res.status(404).json({ error: 'trace_code_not_found' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.json(out);
}));

// ---- ตรวจสอบใบรับรอง (สาธารณะ) ----
const cert = express.Router();
cert.get('/:no/pdf', h(async (req, res) => {
  const no = OC.normCertNo(req.params.no);
  if (!OC.CERT_RE.test(no)) { res.status(404).json({ error: 'certificate_not_found' }); return; }
  const x = await withServiceRole((c) => certPdf(c, no, null));
  if (!x) { res.status(404).json({ error: 'certificate_not_found' }); return; }
  sendPdf(res, x);
}));
cert.get('/:no', h(async (req, res) => {
  const no = OC.normCertNo(req.params.no);
  if (!OC.CERT_RE.test(no)) { res.status(404).json({ error: 'certificate_not_found' }); return; }
  const out = await withServiceRole(async (c) => {
    const x = (await c.query('SELECT * FROM traceability.origin_certificate WHERE cert_no = $1', [no])).rows[0];
    if (!x) return null;
    // 1) แฮชของข้อมูลที่เก็บไว้ยังตรงกับที่บันทึกตอนออก  2) ข้อมูลสายการผลิตปัจจุบันยังตรงกับที่รับรองหรือไม่
    const hashOk = OC.sha256(x.payload) === x.payload_sha256;
    let changed = null;
    const t = await T.loadTrace(c, { type: x.subject_type, id: x.subject_id, code: x.trace_code }, x.org_id);
    if (t) changed = OC.liveDiff(x.payload.core, await OC.buildCore(c, t, x.org_id));
    return {
      cert_no: x.cert_no, status: x.status, issued_at: x.issued_at, revoked_at: x.revoked_at, revoked_reason: x.revoked_reason,
      payload: x.payload, payload_sha256: x.payload_sha256, prev_sha256: x.prev_sha256, hash_ok: hashOk, changed_since_issue: changed,
      trace_url: publicUrl(x.trace_code), pdf_path: `/public/certificate/${x.cert_no}/pdf`,
    };
  });
  if (!out) { res.status(404).json({ error: 'certificate_not_found' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.json(out);
}));

module.exports = { coop, pub, cert, publicUrl, certUrl };
