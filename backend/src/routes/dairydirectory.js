/**
 * ทะเบียนตลาดน้ำนมดิบระดับประเทศ (AgroLink National Dairy โมดูล 04) —
 * db/grant_dairy_market_directory.sql.
 *
 *   /admin/dairy-directory/*   Platform Ops: ดู ค้นหา เพิ่ม แก้ไข บันทึกการติดต่อ
 *                              ผูกกับองค์กรที่สมัครใช้ระบบแล้ว สรุปรายจังหวัด
 *   /dairy/market-directory    สหกรณ์โคนม: เห็นเฉพาะผู้รับซื้อที่ทีมยืนยันแล้ว
 *                              (ข้อมูลระดับองค์กร ไม่รวมปริมาณ ราคา หรือผู้ติดต่อรายบุคคล)
 *
 * Kept out of admin.js / dairy.js on purpose (both are large files that have
 * been overwritten from stale copies before).
 */
const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const {
  requireAuth, requirePlatform, requireOrganizationOrStaff, resolveEffectiveOrgSubject,
} = require('../middleware/auth');

const KINDS = ['dpo', 'processor', 'school_milk_operator', 'cooperative', 'collection_center', 'other'];
const BUYER_KINDS = ['dpo', 'processor', 'school_milk_operator', 'other'];
const STATUSES = ['unverified', 'contacted', 'verified', 'onboarded', 'not_relevant'];
const BUYS = ['unknown', 'yes', 'no'];
const CHANNELS = ['phone', 'email', 'line', 'visit', 'meeting', 'other'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Every editable column, with how to validate it. Text is trimmed and capped.
const TEXT_FIELDS = {
  name: 200, org_category: 80, province_note: 200, district: 120, address: 400, phone: 80, email: 160, website: 300,
  contact_name: 160, contact_role: 160, contact_phone: 80, chain_role: 200, quality_standard: 400, purchase_terms: 400,
  volume_source: 300, source: 300, source_url: 500, owner_name: 120, notes: 2000,
};
const NUM_FIELDS = ['actual_volume_l_day', 'contract_volume_l_day', 'processing_capacity_l_day', 'price_baht_per_kg'];

function bad(res, error, extra) { return res.status(400).json({ error, ...(extra || {}) }); }
function missingSchema(err) { return err && err.code === '42P01'; }
function handle(res, next) {
  return (err) => {
    if (missingSchema(err)) return res.status(503).json({ error: 'dairy_directory_not_installed', detail: 'run backend/db/grant_dairy_market_directory.sql' });
    if (err && err.code === '23514') return res.status(400).json({ error: 'constraint_violation', constraint: err.constraint });
    if (err && err.code === '23503') return res.status(400).json({ error: 'invalid_reference', constraint: err.constraint });
    return next(err);
  };
}

/** Validates a create/update body into { col: value } (only keys present in body). */
function cleanFields(body, { creating }) {
  const out = {};
  const b = body || {};
  for (const [k, max] of Object.entries(TEXT_FIELDS)) {
    if (!(k in b)) continue;
    if (b[k] === null || b[k] === '') { out[k] = null; continue; }
    if (typeof b[k] !== 'string') return { error: `invalid_${k}` };
    out[k] = b[k].trim().slice(0, max) || null;
  }
  for (const k of NUM_FIELDS) {
    if (!(k in b)) continue;
    if (b[k] === null || b[k] === '') { out[k] = null; continue; }
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n < 0) return { error: `invalid_${k}` };
    out[k] = n;
  }
  if ('entry_kind' in b) { if (!KINDS.includes(b.entry_kind)) return { error: 'invalid_entry_kind', allowed: KINDS }; out.entry_kind = b.entry_kind; }
  if ('status' in b) { if (!STATUSES.includes(b.status)) return { error: 'invalid_status', allowed: STATUSES }; out.status = b.status; }
  if ('buys_raw_milk' in b) { if (!BUYS.includes(b.buys_raw_milk)) return { error: 'invalid_buys_raw_milk' }; out.buys_raw_milk = b.buys_raw_milk; }
  if ('school_milk_zone' in b) {
    const z = b.school_milk_zone === null || b.school_milk_zone === '' ? null : Number(b.school_milk_zone);
    if (z !== null && !(Number.isInteger(z) && z >= 1 && z <= 7)) return { error: 'invalid_school_milk_zone' };
    out.school_milk_zone = z;
  }
  if ('province_code' in b) {
    if (b.province_code !== null && b.province_code !== '' && !/^[A-Z_]{2,40}$/.test(String(b.province_code))) return { error: 'invalid_province_code' };
    out.province_code = b.province_code || null;
  }
  if ('last_verified_on' in b) {
    if (b.last_verified_on && !DATE_RE.test(b.last_verified_on)) return { error: 'invalid_last_verified_on' };
    out.last_verified_on = b.last_verified_on || null;
  }
  if (creating) {
    if (!out.name) return { error: 'name_required' };
    if (!out.entry_kind) return { error: 'invalid_entry_kind', allowed: KINDS };
  }
  if ('status' in out && out.status === 'onboarded') return { error: 'use_link_endpoint_to_onboard' };
  return { fields: out };
}

const LIST_COLS = `d.entry_id, d.external_ref, d.entry_kind, d.name, d.org_category, d.school_milk_zone, d.province_code,
  p.province_name_th, d.province_note, d.phone, d.email, d.website, d.contact_role, d.chain_role, d.buys_raw_milk,
  d.actual_volume_l_day::float8 AS actual_volume_l_day, d.contract_volume_l_day::float8 AS contract_volume_l_day,
  d.processing_capacity_l_day::float8 AS processing_capacity_l_day, d.price_baht_per_kg::float8 AS price_baht_per_kg,
  d.status, d.last_verified_on::text AS last_verified_on, d.owner_name, d.possible_duplicate_of, d.linked_org_id,
  o.org_name AS linked_org_name, d.updated_at,
  (SELECT max(l.logged_at) FROM dairy.market_directory_log l WHERE l.entry_id = d.entry_id) AS last_contact_at,
  (SELECT l.next_step_on::text FROM dairy.market_directory_log l WHERE l.entry_id = d.entry_id ORDER BY l.logged_at DESC LIMIT 1) AS next_step_on`;
const FROM = `FROM dairy.market_directory d
  LEFT JOIN registry.province p ON p.province_code = d.province_code
  LEFT JOIN identity.organization o ON o.org_id = d.linked_org_id`;

// ------------------------------------------------------------ platform
const admin = express.Router();
admin.use(requireAuth, requirePlatform);
const pdb = (req, fn) => withSessionContext('platform', req.subject.subjectId, fn);

/** GET /admin/dairy-directory?kind=&status=&province=&q=&buys=&hide_duplicates=1 */
admin.get('/', async (req, res, next) => {
  const { kind, status, province, q, buys } = req.query;
  const where = []; const params = [];
  if (kind) { if (!KINDS.includes(kind)) return bad(res, 'invalid_kind'); params.push(kind); where.push(`d.entry_kind = $${params.length}`); }
  if (status) { if (!STATUSES.includes(status)) return bad(res, 'invalid_status'); params.push(status); where.push(`d.status = $${params.length}`); }
  if (buys) { if (!BUYS.includes(buys)) return bad(res, 'invalid_buys'); params.push(buys); where.push(`d.buys_raw_milk = $${params.length}`); }
  if (province === 'none') where.push('d.province_code IS NULL');
  else if (province) { params.push(province); where.push(`d.province_code = $${params.length}`); }
  if (q) { params.push(`%${String(q).slice(0, 100)}%`); where.push(`(d.name ILIKE $${params.length} OR d.external_ref ILIKE $${params.length} OR d.notes ILIKE $${params.length})`); }
  if (req.query.hide_duplicates === '1') where.push('d.possible_duplicate_of IS NULL');
  try {
    const rows = await pdb(req, async (c) => {
      const r = await c.query(`SELECT ${LIST_COLS} ${FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY CASE d.status WHEN 'contacted' THEN 0 WHEN 'unverified' THEN 1 WHEN 'verified' THEN 2 WHEN 'onboarded' THEN 3 ELSE 4 END,
                 CASE d.entry_kind WHEN 'dpo' THEN 0 WHEN 'processor' THEN 1 WHEN 'school_milk_operator' THEN 2 WHEN 'other' THEN 3
                                   WHEN 'cooperative' THEN 4 ELSE 5 END, d.name`, params);
      await logAccess(c, 'read', 'dairy.market_directory', null);
      return r.rows;
    });
    return res.json(rows);
  } catch (err) { return handle(res, next)(err); }
});

/** GET /admin/dairy-directory/summary — counts by kind × status, and by province (replaces the "77 Province Coverage" sheet). */
admin.get('/summary', async (req, res, next) => {
  try {
    const data = await pdb(req, async (c) => {
      const byStatus = await c.query(`SELECT entry_kind, status, count(*)::int AS n FROM dairy.market_directory
                                       WHERE possible_duplicate_of IS NULL GROUP BY 1, 2`);
      const byProvince = await c.query(`
        SELECT p.province_code, p.province_name_th, p.region_th,
               count(d.entry_id) FILTER (WHERE d.entry_kind IN ('dpo','processor','school_milk_operator','other'))::int AS buyers,
               count(d.entry_id) FILTER (WHERE d.entry_kind = 'cooperative')::int AS cooperatives,
               count(d.entry_id) FILTER (WHERE d.entry_kind = 'collection_center')::int AS centers,
               count(d.entry_id) FILTER (WHERE d.status IN ('verified','onboarded'))::int AS verified
          FROM registry.province p
          LEFT JOIN dairy.market_directory d ON d.province_code = p.province_code AND d.possible_duplicate_of IS NULL
         GROUP BY 1, 2, 3 ORDER BY 4 DESC, 2`);
      const noProvince = await c.query('SELECT count(*)::int AS n FROM dairy.market_directory WHERE province_code IS NULL AND possible_duplicate_of IS NULL');
      const due = await c.query(`
        SELECT d.entry_id, d.name, l.next_step, l.next_step_on::text AS next_step_on
          FROM dairy.market_directory d
          JOIN LATERAL (SELECT next_step, next_step_on FROM dairy.market_directory_log x WHERE x.entry_id = d.entry_id ORDER BY logged_at DESC LIMIT 1) l ON true
         WHERE l.next_step_on IS NOT NULL AND l.next_step_on <= (now() AT TIME ZONE 'Asia/Bangkok')::date + 7
           AND d.status NOT IN ('onboarded','not_relevant')
         ORDER BY l.next_step_on LIMIT 50`);
      return { by_status: byStatus.rows, by_province: byProvince.rows, without_province: noProvince.rows[0].n, follow_ups_due: due.rows };
    });
    return res.json(data);
  } catch (err) { return handle(res, next)(err); }
});

/** GET /admin/dairy-directory/orgs?q= — organizations to link an onboarded entry to. */
admin.get('/orgs', async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const rows = await pdb(req, async (c) => (await c.query(
      `SELECT org_id, org_name, org_type, kyb_status FROM identity.organization WHERE org_name ILIKE $1 ORDER BY org_name LIMIT 20`,
      [`%${q.slice(0, 100)}%`],
    )).rows);
    return res.json(rows);
  } catch (err) { return handle(res, next)(err); }
});

admin.get('/:id', async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return bad(res, 'invalid_entry_id');
  try {
    const data = await pdb(req, async (c) => {
      const r = await c.query(`SELECT d.*, d.last_verified_on::text AS last_verified_on, p.province_name_th, o.org_name AS linked_org_name,
                                      dup.name AS duplicate_of_name, dup.external_ref AS duplicate_of_ref
                                 ${FROM} LEFT JOIN dairy.market_directory dup ON dup.entry_id = d.possible_duplicate_of
                                WHERE d.entry_id = $1`, [req.params.id]);
      if (!r.rows.length) return null;
      const logs = await c.query(`SELECT log_id, logged_at, channel, summary, outcome, next_step, next_step_on::text AS next_step_on, logged_by
                                    FROM dairy.market_directory_log WHERE entry_id = $1 ORDER BY logged_at DESC`, [req.params.id]);
      const dups = await c.query('SELECT entry_id, external_ref, name FROM dairy.market_directory WHERE possible_duplicate_of = $1', [req.params.id]);
      await logAccess(c, 'read', 'dairy.market_directory', req.params.id);
      return { ...r.rows[0], logs: logs.rows, duplicates: dups.rows };
    });
    if (!data) return res.status(404).json({ error: 'entry_not_found' });
    return res.json(data);
  } catch (err) { return handle(res, next)(err); }
});

admin.post('/', async (req, res, next) => {
  const v = cleanFields(req.body, { creating: true });
  if (v.error) return bad(res, v.error, v.allowed ? { allowed: v.allowed } : undefined);
  const cols = Object.keys(v.fields);
  try {
    const row = await pdb(req, async (c) => {
      const r = await c.query(
        `INSERT INTO dairy.market_directory (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING entry_id`,
        cols.map((k) => v.fields[k]),
      );
      await logAccess(c, 'write', 'dairy.market_directory', r.rows[0].entry_id);
      return r.rows[0];
    });
    return res.status(201).json(row);
  } catch (err) { return handle(res, next)(err); }
});

admin.put('/:id', async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return bad(res, 'invalid_entry_id');
  const v = cleanFields(req.body, { creating: false });
  if (v.error) return bad(res, v.error, v.allowed ? { allowed: v.allowed } : undefined);
  if ('possible_duplicate_of' in (req.body || {})) {
    const d = req.body.possible_duplicate_of;
    if (d !== null && d !== '' && (!UUID_RE.test(d) || d === req.params.id)) return bad(res, 'invalid_possible_duplicate_of');
    v.fields.possible_duplicate_of = d || null;
  }
  const cols = Object.keys(v.fields);
  if (!cols.length) return bad(res, 'nothing_to_update');
  try {
    const row = await pdb(req, async (c) => {
      const cur = await c.query('SELECT status FROM dairy.market_directory WHERE entry_id = $1', [req.params.id]);
      if (!cur.rows.length) return null;
      // an onboarded entry stays onboarded unless it is unlinked first
      if (cur.rows[0].status === 'onboarded' && v.fields.status && v.fields.status !== 'onboarded') return { conflict: 'unlink_before_changing_status' };
      const r = await c.query(
        `UPDATE dairy.market_directory SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
          WHERE entry_id = $1 RETURNING entry_id, status`,
        [req.params.id, ...cols.map((k) => v.fields[k])],
      );
      await logAccess(c, 'write', 'dairy.market_directory', req.params.id);
      return r.rows[0];
    });
    if (!row) return res.status(404).json({ error: 'entry_not_found' });
    if (row.conflict) return res.status(409).json({ error: row.conflict });
    return res.json(row);
  } catch (err) { return handle(res, next)(err); }
});

/** POST /admin/dairy-directory/:id/logs { channel, summary, outcome?, next_step?, next_step_on?, logged_by } */
admin.post('/:id/logs', async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return bad(res, 'invalid_entry_id');
  const b = req.body || {};
  if (!CHANNELS.includes(b.channel)) return bad(res, 'invalid_channel', { allowed: CHANNELS });
  const summary = typeof b.summary === 'string' ? b.summary.trim().slice(0, 2000) : '';
  const by = typeof b.logged_by === 'string' ? b.logged_by.trim().slice(0, 120) : '';
  if (!summary) return bad(res, 'summary_required');
  if (!by) return bad(res, 'logged_by_required');
  if (b.next_step_on && !DATE_RE.test(b.next_step_on)) return bad(res, 'invalid_next_step_on');
  try {
    const out = await pdb(req, async (c) => {
      const cur = await c.query('SELECT status FROM dairy.market_directory WHERE entry_id = $1', [req.params.id]);
      if (!cur.rows.length) return null;
      const r = await c.query(
        `INSERT INTO dairy.market_directory_log (entry_id, channel, summary, outcome, next_step, next_step_on, logged_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING log_id, logged_at`,
        [req.params.id, b.channel, summary, b.outcome ? String(b.outcome).slice(0, 500) : null,
          b.next_step ? String(b.next_step).slice(0, 500) : null, b.next_step_on || null, by],
      );
      // first contact moves an unverified entry along the pipeline
      if (cur.rows[0].status === 'unverified') {
        await c.query("UPDATE dairy.market_directory SET status = 'contacted', updated_at = now() WHERE entry_id = $1", [req.params.id]);
      }
      await logAccess(c, 'write', 'dairy.market_directory_log', r.rows[0].log_id);
      return r.rows[0];
    });
    if (!out) return res.status(404).json({ error: 'entry_not_found' });
    return res.status(201).json(out);
  } catch (err) { return handle(res, next)(err); }
});

/** POST /admin/dairy-directory/:id/link { org_id | null } — mark as signed up on AgroLink (or undo). */
admin.post('/:id/link', async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return bad(res, 'invalid_entry_id');
  const orgId = req.body ? req.body.org_id : undefined;
  if (orgId !== null && !UUID_RE.test(String(orgId))) return bad(res, 'invalid_org_id');
  try {
    const row = await pdb(req, async (c) => {
      const r = orgId
        ? await c.query(`UPDATE dairy.market_directory SET linked_org_id = $2, status = 'onboarded', updated_at = now()
                          WHERE entry_id = $1 RETURNING entry_id, status, linked_org_id`, [req.params.id, orgId])
        : await c.query(`UPDATE dairy.market_directory SET linked_org_id = NULL,
                                status = CASE WHEN status = 'onboarded' THEN 'verified' ELSE status END, updated_at = now()
                          WHERE entry_id = $1 RETURNING entry_id, status, linked_org_id`, [req.params.id]);
      if (r.rows.length) await logAccess(c, 'write', 'dairy.market_directory', req.params.id);
      return r.rows[0];
    });
    if (!row) return res.status(404).json({ error: 'entry_not_found' });
    return res.json(row);
  } catch (err) { return handle(res, next)(err); }
});

// --------------------------------------------------------- cooperative
async function requireCooperativeOrg(req, res, next) {
  try {
    const ok = await resolveEffectiveOrgSubject(req, res, ['Cooperative']);
    if (!ok) return undefined;
    const result = await withSessionContext('organization', req.subject.subjectId, async (c) => {
      const org = await c.query('SELECT kyb_status FROM identity.organization WHERE org_id = $1', [req.subject.subjectId]);
      if (!org.rows.length || org.rows[0].kyb_status !== 'Verified') return false;
      const role = await c.query("SELECT status FROM identity.organization_role WHERE org_id = $1 AND role_type = 'Cooperative'", [req.subject.subjectId]);
      return !!(role.rows[0] && role.rows[0].status === 'Verified');
    });
    if (!result) return res.status(403).json({ error: 'cooperative_role_required' });
    return next();
  } catch (err) { return next(err); }
}

const coop = express.Router();
coop.use(requireAuth, requireOrganizationOrStaff, requireCooperativeOrg);

/** GET /dairy/market-directory — buyers the AgroLink team has verified (organisation-level facts only). */
coop.get('/', async (req, res, next) => {
  try {
    const rows = await withSessionContext('organization', req.subject.subjectId, async (c) => {
      const r = await c.query(
        `SELECT d.entry_id, d.entry_kind, d.name, d.org_category, d.school_milk_zone, d.province_code, p.province_name_th,
                d.phone, d.email, d.website, d.buys_raw_milk, d.quality_standard, d.last_verified_on::text AS last_verified_on,
                (d.linked_org_id IS NOT NULL) AS on_agrolink
           FROM dairy.market_directory d LEFT JOIN registry.province p ON p.province_code = d.province_code
          WHERE d.status IN ('verified','onboarded') AND d.entry_kind = ANY($1) AND d.possible_duplicate_of IS NULL
          ORDER BY (d.buys_raw_milk = 'yes') DESC, p.province_name_th NULLS LAST, d.name`,
        [BUYER_KINDS],
      );
      await logAccess(c, 'read', 'dairy.market_directory', null);
      return r.rows;
    });
    return res.json(rows);
  } catch (err) { return handle(res, next)(err); }
});

module.exports = { admin, coop, cleanFields, KINDS, STATUSES };
