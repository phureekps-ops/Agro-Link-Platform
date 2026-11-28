/**
 * ทะเบียนสหกรณ์ล่วงหน้า (Cooperative Directory) — db/grant_coop_registry.sql · ส่วนคำนวณ lib/coopRegistry.js
 *
 *   ผู้ดูแลแพลตฟอร์ม  /admin/coop-lending/registry/...  นำเข้าไฟล์ (ตรวจก่อน → ยืนยัน) ค้นหา เชื่อม/จัดตั้งบัญชี ตรวจคำขอยืนยันสิทธิ์
 *   สหกรณ์ในระบบ     /coop-lending/registry/... (สหกรณ์การเกษตร) · /savings/registry/... (ออมทรัพย์/เครดิตยูเนี่ยน)
 *                    ค้นหารายการของตน → ยืนยันสิทธิ์พร้อมหนังสือมอบอำนาจ/มติ → รอผู้ดูแลตรวจ
 *   กรมส่งเสริมสหกรณ์  /gov/coop-lending/registry/coverage  สหกรณ์ในจังหวัดที่เข้าร่วม/ยังไม่เข้าร่วม
 */
const crypto = require('crypto');
const DQ = require('../lib/dairyDataQuality');
const CR = require('../lib/coopRegistry');

const has = async (c, rel) => (await c.query('SELECT to_regclass($1) IS NOT NULL AS ok', [rel])).rows[0].ok;

/** งบที่ผู้กู้กรอกเทียบงบทางการ — ใช้ในหน้าผู้ให้กู้ (coopMarket) และตัวตรวจสัญญาณ (coopRisk) · ยังไม่รัน SQL = null */
async function registryCheck(c, orgId, declared, pct) {
  if (!(await has(c, 'registry.coop_directory'))) return null;
  const e = (await c.query(
    `SELECT d.directory_id, d.coop_name, d.registration_no, d.coop_type, d.status, d.source_label, d.linked_at, pv.province_name_th
       FROM registry.coop_directory d LEFT JOIN registry.province pv ON pv.province_code = d.province_code WHERE d.org_id = $1`, [orgId],
  )).rows[0];
  if (!e) return { linked: false };
  const official = (await c.query('SELECT * FROM registry.coop_directory_financial WHERE directory_id = $1 ORDER BY year DESC', [e.directory_id])).rows;
  const p = pct ?? Number(((await c.query('SELECT fraud_official_diff_pct FROM coop_lending.setting WHERE id')).rows[0] || {}).fraud_official_diff_pct ?? 5);
  const years = new Set((declared || []).map((y) => Number(y.year)));
  return {
    linked: true, ...e, official_years: official.map((o) => o.year), official_source: official[0] ? official[0].source_label : null,
    compared_years: official.filter((o) => years.has(Number(o.year))).map((o) => o.year), threshold_pct: p,
    mismatches: CR.compareOfficial(declared, official, p),
  };
}

function attach({ savings, borrower, admin, gov }, H) {
  const { wrap, fail, tx, orgTx, text, isUuid, actorOf, objectStorage, govTx, officerScope } = H;
  const adminTx = (req, fn) => tx('platform', req.subject.subjectId, fn);
  const adminKey = (req) => `platform:${req.subject.subjectId || 'admin'}`;
  const notify = (c, orgId, message) => c.query(
    `INSERT INTO coop_lending.dunning_notice (target_org_id, kind, notice_date, message) VALUES ($1,'registry',(now() AT TIME ZONE 'Asia/Bangkok')::date,$2)`,
    [orgId, message.slice(0, 1000)],
  );
  const ENTRY = `SELECT d.*, pv.province_name_th, o.org_name AS linked_org_name, o.org_type AS linked_org_type
                   FROM registry.coop_directory d LEFT JOIN registry.province pv ON pv.province_code = d.province_code
                   LEFT JOIN identity.organization o ON o.org_id = d.org_id`;
  const sendFile = async (res, c, fileId) => {
    const f = (await c.query('SELECT storage_path, content_type, original_filename FROM storage.file_object WHERE file_id = $1', [fileId])).rows[0];
    if (!f) fail(404, 'file_not_found');
    res.setHeader('Content-Type', f.content_type);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.original_filename)}"`);
    res.send(await objectStorage.readFile(f.storage_path));
  };

  /** เชื่อมรายการทะเบียนกับองค์กร (ยืนยันสิทธิ์ผ่าน / ผู้ดูแลเชื่อมเอง / จัดตั้งใหม่) แล้วเติมเลขทะเบียนในโปรไฟล์ที่ยังว่าง */
  async function link(c, entry, orgId, method, by) {
    if (entry.org_id && entry.org_id !== orgId) fail(409, 'directory_already_linked', { org_name: entry.linked_org_name });
    const org = (await c.query('SELECT org_id, org_type, org_name FROM identity.organization WHERE org_id = $1', [orgId])).rows[0];
    if (!org) fail(404, 'organization_not_found');
    if (CR.ORG_TYPE[entry.coop_type] !== org.org_type) fail(409, 'org_type_mismatch', { expected: CR.ORG_TYPE[entry.coop_type], org_type: org.org_type });
    const other = (await c.query('SELECT coop_name FROM registry.coop_directory WHERE org_id = $1 AND directory_id <> $2', [orgId, entry.directory_id])).rows[0];
    if (other) fail(409, 'org_already_linked', { coop_name: other.coop_name });
    await c.query('UPDATE registry.coop_directory SET org_id = $2, linked_at = now(), linked_by = $3, link_method = $4, updated_at = now() WHERE directory_id = $1',
      [entry.directory_id, orgId, by, method]);
    if (entry.registration_no) {
      if (org.org_type === 'Cooperative') {
        await c.query('UPDATE registry.cooperative_profile SET cooperative_registration_no = $2, updated_at = now() WHERE org_id = $1 AND cooperative_registration_no IS NULL', [orgId, entry.registration_no]);
        await c.query('UPDATE coop_lending.borrower_profile SET registration_no = $2 WHERE org_id = $1 AND (registration_no IS NULL OR registration_no = \'\')', [orgId, entry.registration_no]);
      } else {
        await c.query('UPDATE coop_lending.lender_profile SET registration_no = $2 WHERE org_id = $1 AND (registration_no IS NULL OR registration_no = \'\')', [orgId, entry.registration_no]);
      }
    }
    // คำขอของผู้อื่นที่ค้างอยู่กับรายการนี้ → ไม่อนุมัติอัตโนมัติ
    const others = (await c.query(
      `UPDATE registry.coop_directory_claim SET status = 'Rejected', decided_by = $3, decided_at = now(), decision_note = 'รายการนี้เชื่อมกับบัญชีอื่นแล้ว'
        WHERE directory_id = $1 AND org_id <> $2 AND status = 'Pending' RETURNING org_id`, [entry.directory_id, orgId, by],
    )).rows;
    for (const o of others) await notify(c, o.org_id, `คำขอยืนยันทะเบียน "${entry.coop_name}" ไม่ผ่าน: รายการนี้เชื่อมกับบัญชีอื่นแล้ว — ติดต่อผู้ดูแลแพลตฟอร์มถ้าเห็นว่าไม่ถูกต้อง`);
  }

  // =================================================================== ผู้ดูแลแพลตฟอร์ม
  admin.get('/registry/template/:kind', wrap(async (req, res) => {
    const kind = req.params.kind === 'financials' ? 'financials' : 'directory';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="coop-${kind}-template.csv"`);
    res.send(CR.template(kind));
  }));

  async function classify(c, kind, rows) {
    if (kind === 'directory') {
      const existing = (await c.query('SELECT directory_id, coop_name, name_key, coop_type, registration_no, tax_id, province_code, district, established_year, member_count, status, org_id FROM registry.coop_directory')).rows;
      return CR.classifyDirectory(rows, existing);
    }
    const regs = rows.map((r) => r.data.registration_no).filter(Boolean);
    const taxes = rows.map((r) => r.data.tax_id).filter(Boolean);
    const dir = (await c.query('SELECT directory_id, coop_name, registration_no, tax_id FROM registry.coop_directory WHERE registration_no = ANY($1) OR tax_id = ANY($2)', [regs, taxes])).rows;
    const fin = dir.length ? (await c.query('SELECT * FROM registry.coop_directory_financial WHERE directory_id = ANY($1::uuid[])', [dir.map((d) => d.directory_id)])).rows : [];
    return CR.classifyFinancials(rows, dir, fin);
  }
  const slim = (r) => ({ row_no: r.row_no, verdict: r.verdict, data: r.data, errors: r.errors, warnings: r.warnings, changes: r.changes, directory_id: r.directory_id || null, linked: r.linked || false });

  admin.post('/registry/imports/preview', wrap(async (req, res) => {
    const b = req.body || {};
    const kind = ['directory', 'financials'].includes(b.kind) ? b.kind : fail(400, 'invalid_kind');
    const filename = String(b.filename || '').trim().slice(0, 200) || `${kind}.csv`;
    if (typeof b.content_base64 !== 'string' || !b.content_base64) fail(400, 'missing_file');
    const source = text(b.source_label, 'source_label', { min: 2, max: 200 });
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(b.as_of || '')) ? b.as_of : null;
    const defType = CR.TYPES[b.default_type] ? b.default_type : null;
    const buf = Buffer.from(b.content_base64.replace(/^data:[^,]*,/, ''), 'base64');
    let parsed;
    try { parsed = DQ.parseFile(filename, buf); } catch (e) {
      if (e instanceof DQ.FileError) fail(400, e.code, e.detail || {});
      throw e;
    }
    const cols = CR.mapColumns(kind, parsed.header);
    if (cols.missing.length) fail(400, 'missing_columns', { missing: cols.missing, header: parsed.header });
    res.json(await adminTx(req, async (c) => {
      const provinceIdx = CR.provinceIndex((await c.query('SELECT province_code, province_name_th FROM registry.province')).rows);
      const norm = parsed.rows.map((r) => ({ row_no: r.row_no, ...CR.normalizeRow(kind, r.cells, cols.map, { provinceIdx, default_type: defType }) }));
      const rows = await classify(c, kind, norm);
      const sum = CR.summarize(rows);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const prev = (await c.query(`SELECT committed_at FROM registry.coop_directory_import WHERE file_sha256 = $1 AND status = 'Committed' ORDER BY committed_at DESC LIMIT 1`, [sha])).rows[0];
      const imp = (await c.query(
        `INSERT INTO registry.coop_directory_import (kind, filename, file_format, file_sha256, source_label, as_of, rows, summary, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING import_id, created_at`,
        [kind, filename, parsed.format, sha, source, asOf, JSON.stringify(norm), JSON.stringify(sum), adminKey(req)],
      )).rows[0];
      const columns = Object.fromEntries(Object.entries(cols.map).map(([f, i]) => [f, parsed.header[i]]));
      return { import_id: imp.import_id, kind, filename, format: parsed.format, columns, unknown_columns: cols.unknown, summary: sum, same_file_committed_at: prev ? prev.committed_at : null, rows: rows.map(slim) };
    }));
  }));

  admin.post('/registry/imports/:id/commit', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) fail(404, 'import_not_found');
    res.json(await adminTx(req, async (c) => {
      const imp = (await c.query('SELECT * FROM registry.coop_directory_import WHERE import_id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!imp) fail(404, 'import_not_found');
      if (imp.status !== 'Preview') fail(409, 'import_not_pending', { status: imp.status });
      await c.query('LOCK TABLE registry.coop_directory IN SHARE ROW EXCLUSIVE MODE');
      const rows = await classify(c, imp.kind, imp.rows); // ตรวจซ้ำกับข้อมูลล่าสุด ณ เวลายืนยัน
      const counts = { inserted: 0, updated: 0, same: 0, skipped_error: 0 };
      for (const r of rows) {
        const d = r.data;
        if (r.verdict === 'error') { counts.skipped_error += 1; continue; }
        if (r.verdict === 'same') { counts.same += 1; continue; }
        if (imp.kind === 'directory') {
          if (r.verdict === 'new') {
            await c.query(
              `INSERT INTO registry.coop_directory (coop_type, coop_name, name_key, registration_no, tax_id, province_code, district, established_year, member_count, status, source_label, import_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
              [d.coop_type, d.coop_name, d.name_key, d.registration_no, d.tax_id, d.province_code, d.district, d.established_year, d.member_count, d.status, imp.source_label, imp.import_id],
            );
            counts.inserted += 1;
          } else {
            const set = r.changes.map((x) => x.field);
            const vals = set.map((f) => d[f]);
            if (set.includes('coop_name')) { set.push('name_key'); vals.push(d.name_key); }
            await c.query(
              `UPDATE registry.coop_directory SET ${set.map((f, i) => `${f} = $${i + 2}`).join(', ')}, source_label = $${set.length + 2}, import_id = $${set.length + 3}, updated_at = now() WHERE directory_id = $1`,
              [r.directory_id, ...vals, imp.source_label, imp.import_id],
            );
            counts.updated += 1;
          }
        } else {
          const cols = [...CR.FIN_FIELDS, 'audit_opinion'];
          const vals = cols.map((f) => d[f]);
          await c.query(
            `INSERT INTO registry.coop_directory_financial (directory_id, year, ${cols.join(', ')}, source_label, import_id)
             VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}, $${cols.length + 3}, $${cols.length + 4})
             ON CONFLICT (directory_id, year) DO UPDATE SET ${cols.map((f) => `${f} = COALESCE(EXCLUDED.${f}, registry.coop_directory_financial.${f})`).join(', ')},
               source_label = EXCLUDED.source_label, import_id = EXCLUDED.import_id, updated_at = now()`,
            [r.directory_id, d.year, ...vals, imp.source_label, imp.import_id],
          );
          counts[r.verdict === 'new' ? 'inserted' : 'updated'] += 1;
        }
      }
      await c.query(`UPDATE registry.coop_directory_import SET status = 'Committed', result = $2, committed_by = $3, committed_at = now() WHERE import_id = $1`,
        [imp.import_id, JSON.stringify({ counts }), adminKey(req)]);
      return { import_id: imp.import_id, kind: imp.kind, counts };
    }));
  }));
  admin.post('/registry/imports/:id/discard', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) fail(404, 'import_not_found');
    res.json(await adminTx(req, async (c) => {
      const r = (await c.query(`UPDATE registry.coop_directory_import SET status = 'Discarded' WHERE import_id = $1 AND status = 'Preview' RETURNING import_id`, [req.params.id])).rows[0];
      if (!r) fail(409, 'import_not_pending');
      return r;
    }));
  }));
  admin.get('/registry/imports', wrap(async (req, res) => {
    res.json(await adminTx(req, async (c) => (await c.query(
      `SELECT import_id, kind, filename, file_format, source_label, as_of, summary, status, result, created_by, created_at, committed_at
         FROM registry.coop_directory_import WHERE status <> 'Discarded' ORDER BY created_at DESC LIMIT 50`,
    )).rows));
  }));

  // ---- คำขอยืนยันสิทธิ์ ----
  admin.get('/registry/claims', wrap(async (req, res) => {
    const st = ['Pending', 'Approved', 'Rejected', 'Withdrawn'].includes(req.query.status) ? req.query.status : null;
    res.json(await adminTx(req, async (c) => (await c.query(
      `SELECT cl.*, d.coop_name, d.registration_no, d.tax_id AS directory_tax_id, d.coop_type, d.org_id AS directory_org_id, pv.province_name_th,
              o.org_name, o.org_type, o.tax_id AS org_tax_id,
              (regexp_replace(COALESCE(o.tax_id, ''), '\\D', '', 'g') = d.tax_id) AS tax_match
         FROM registry.coop_directory_claim cl JOIN registry.coop_directory d ON d.directory_id = cl.directory_id
         JOIN identity.organization o ON o.org_id = cl.org_id LEFT JOIN registry.province pv ON pv.province_code = d.province_code
        WHERE ($1::text IS NULL OR cl.status = $1) ORDER BY (cl.status = 'Pending') DESC, cl.created_at DESC LIMIT 200`, [st],
    )).rows));
  }));
  admin.get('/registry/claims/:id/file', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) fail(404, 'claim_not_found');
    await adminTx(req, async (c) => {
      const cl = (await c.query('SELECT file_id FROM registry.coop_directory_claim WHERE claim_id = $1', [req.params.id])).rows[0];
      if (!cl) fail(404, 'claim_not_found');
      await sendFile(res, c, cl.file_id);
    });
  }));
  admin.post('/registry/claims/:id/decide', wrap(async (req, res) => {
    const b = req.body || {};
    if (!['Approved', 'Rejected'].includes(b.status)) fail(400, 'invalid_status');
    if (!isUuid(req.params.id)) fail(404, 'claim_not_found');
    res.json(await adminTx(req, async (c) => {
      const cl = (await c.query(`SELECT * FROM registry.coop_directory_claim WHERE claim_id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!cl) fail(404, 'claim_not_found');
      if (cl.status !== 'Pending') fail(409, 'claim_not_pending');
      const note = text(b.note, 'note', { min: b.status === 'Rejected' ? 5 : 0, max: 1000, allowNull: b.status === 'Approved' });
      const entry = (await c.query(`${ENTRY} WHERE d.directory_id = $1 FOR UPDATE OF d`, [cl.directory_id])).rows[0];
      if (b.status === 'Approved') await link(c, entry, cl.org_id, 'claim', adminKey(req));
      const r = (await c.query(`UPDATE registry.coop_directory_claim SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE claim_id = $1 RETURNING *`,
        [cl.claim_id, b.status, adminKey(req), note])).rows[0];
      await notify(c, cl.org_id, b.status === 'Approved'
        ? `ยืนยันทะเบียนสหกรณ์แล้ว: บัญชีของท่านเชื่อมกับ "${entry.coop_name}"${entry.registration_no ? ` เลขทะเบียน ${entry.registration_no}` : ''}`
        : `คำขอยืนยันทะเบียน "${entry.coop_name}" ไม่ผ่าน: ${note}`);
      return r;
    }));
  }));

  // ---- ค้นหา/ดูรายการ ----
  admin.get('/registry', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const params = []; const where = [];
    if (q) { params.push(`%${CR.nameKey(q)}%`, q); where.push(`(d.name_key LIKE $${params.length - 1} OR d.registration_no = $${params.length} OR d.tax_id = $${params.length})`); }
    if (typeof req.query.province === 'string' && req.query.province) { params.push(req.query.province.slice(0, 40)); where.push(`d.province_code = $${params.length}`); }
    if (CR.TYPES[req.query.type]) { params.push(req.query.type); where.push(`d.coop_type = $${params.length}`); }
    if (req.query.linked === 'yes') where.push('d.org_id IS NOT NULL');
    if (req.query.linked === 'no') where.push('d.org_id IS NULL');
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    res.json(await adminTx(req, async (c) => {
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = (await c.query(`SELECT COUNT(*)::int AS n FROM registry.coop_directory d ${w}`, params)).rows[0].n;
      const rows = (await c.query(`${ENTRY} ${w} ORDER BY d.province_code, d.coop_name LIMIT 100 OFFSET ${page * 100}`, params)).rows;
      const counts = (await c.query(
        `SELECT coop_type, COUNT(*)::int AS total, COUNT(org_id)::int AS linked, COUNT(*) FILTER (WHERE status = 'active')::int AS active FROM registry.coop_directory GROUP BY 1`,
      )).rows;
      const pending = (await c.query(`SELECT COUNT(*)::int AS n FROM registry.coop_directory_claim WHERE status = 'Pending'`)).rows[0].n;
      const fin = (await c.query('SELECT COUNT(DISTINCT directory_id)::int AS coops, COUNT(*)::int AS rows FROM registry.coop_directory_financial')).rows[0];
      const provinces = (await c.query(
        `SELECT d.province_code, pv.province_name_th, COUNT(*)::int AS n FROM registry.coop_directory d JOIN registry.province pv ON pv.province_code = d.province_code GROUP BY 1, 2 ORDER BY 2`,
      )).rows;
      return { total, page, rows, counts, pending_claims: pending, financials: fin, provinces, types: CR.TYPES };
    }));
  }));
  admin.get('/registry/:id', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) fail(404, 'directory_not_found');
    res.json(await adminTx(req, async (c) => {
      const e = (await c.query(`${ENTRY} WHERE d.directory_id = $1`, [req.params.id])).rows[0];
      if (!e) fail(404, 'directory_not_found');
      const financials = (await c.query('SELECT * FROM registry.coop_directory_financial WHERE directory_id = $1 ORDER BY year DESC', [e.directory_id])).rows;
      const claims = (await c.query(`SELECT cl.*, o.org_name FROM registry.coop_directory_claim cl JOIN identity.organization o ON o.org_id = cl.org_id WHERE cl.directory_id = $1 ORDER BY cl.created_at DESC`, [e.directory_id])).rows;
      // บัญชีในระบบที่น่าจะเป็นสหกรณ์นี้: เลขผู้เสียภาษีตรง หรือชื่อตรง (ประเภทองค์กรต้องตรง)
      const candidates = e.org_id ? [] : (await c.query(
        `SELECT o.org_id, o.org_name, o.org_type, o.tax_id, o.kyb_status, (regexp_replace(o.tax_id, '\\D', '', 'g') = $2) AS tax_match
           FROM identity.organization o WHERE o.org_type = $1 AND NOT EXISTS (SELECT 1 FROM registry.coop_directory x WHERE x.org_id = o.org_id)
            AND ((regexp_replace(o.tax_id, '\\D', '', 'g') = $2) OR lower(regexp_replace(o.org_name, '[[:space:].,()''"-]|จำกัด', '', 'g')) = $3)
          LIMIT 10`, [CR.ORG_TYPE[e.coop_type], e.tax_id || '-', e.name_key],
      )).rows;
      let check = null;
      if (e.org_id && e.linked_org_type === 'Cooperative') {
        const prof = (await c.query('SELECT financials FROM coop_lending.borrower_profile WHERE org_id = $1', [e.org_id])).rows[0];
        check = prof ? await registryCheck(c, e.org_id, prof.financials) : null;
      }
      return { entry: e, financials, claims, candidates, check };
    }));
  }));
  admin.post('/registry/:id/link', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) fail(404, 'directory_not_found');
    const orgId = (req.body || {}).org_id;
    res.json(await adminTx(req, async (c) => {
      const e = (await c.query(`${ENTRY} WHERE d.directory_id = $1 FOR UPDATE OF d`, [req.params.id])).rows[0];
      if (!e) fail(404, 'directory_not_found');
      if (orgId === null) { // ยกเลิกการเชื่อม (เชื่อมผิด)
        if (!e.org_id) fail(409, 'not_linked');
        await c.query('UPDATE registry.coop_directory SET org_id = NULL, linked_at = NULL, linked_by = NULL, link_method = NULL, updated_at = now() WHERE directory_id = $1', [e.directory_id]);
        await notify(c, e.org_id, `ผู้ดูแลแพลตฟอร์มยกเลิกการเชื่อมบัญชีของท่านกับทะเบียน "${e.coop_name}"`);
        return { directory_id: e.directory_id, org_id: null };
      }
      if (!isUuid(orgId)) fail(400, 'invalid_org');
      await link(c, e, orgId, 'admin_link', adminKey(req));
      await notify(c, orgId, `ผู้ดูแลแพลตฟอร์มเชื่อมบัญชีของท่านกับทะเบียน "${e.coop_name}"${e.registration_no ? ` เลขทะเบียน ${e.registration_no}` : ''}`);
      return { directory_id: e.directory_id, org_id: orgId };
    }));
  }));
  /** จัดตั้งบัญชีสหกรณ์การเกษตร/ประมง/นิคมจากรายการทะเบียน (ออมทรัพย์/เครดิตยูเนี่ยนสมัครเองแล้วยืนยันสิทธิ์) */
  admin.post('/registry/:id/provision', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) fail(404, 'directory_not_found');
    const b = req.body || {};
    res.status(201).json(await adminTx(req, async (c) => {
      const e = (await c.query(`${ENTRY} WHERE d.directory_id = $1 FOR UPDATE OF d`, [req.params.id])).rows[0];
      if (!e) fail(404, 'directory_not_found');
      if (e.org_id) fail(409, 'directory_already_linked', { org_name: e.linked_org_name });
      if (!CR.BORROWER_TYPES.includes(e.coop_type)) fail(409, 'provision_borrower_types_only');
      if (e.status !== 'active') fail(409, 'directory_not_active');
      const tax = e.tax_id || CR.digits(b.tax_id);
      if (!/^[0-9]{13}$/.test(tax)) fail(400, 'invalid_tax_id');
      const dup = (await c.query('SELECT org_id, org_name FROM identity.organization WHERE tax_id = $1', [tax])).rows[0];
      if (dup) fail(409, 'tax_id_in_use', { org_id: dup.org_id, org_name: dup.org_name });
      const org = (await c.query(
        `INSERT INTO identity.organization (org_type, org_name, tax_id, kyb_status, verified_badge, auth_subject_id)
         VALUES ('Cooperative', $1, $2, 'Verified', true, $3) RETURNING org_id, org_name`,
        [e.coop_name, tax, `oidc|coop-${crypto.randomUUID()}`],
      )).rows[0];
      await c.query(`INSERT INTO identity.subject_role (subject_type, subject_id, role_code) VALUES ('organization', $1, 'org.admin'), ('organization', $1, 'coop.admin')`, [org.org_id]);
      await c.query(`INSERT INTO identity.organization_role (org_id, role_type, status, decided_at, decided_reason) VALUES ($1, 'Cooperative', 'Verified', now(), $2)`,
        [org.org_id, `จัดตั้งจากทะเบียนสหกรณ์ (${e.source_label})`]);
      await c.query(
        `INSERT INTO registry.cooperative_profile (org_id, province_code, cooperative_registration_no, established_year, member_count_reported, notes) VALUES ($1,$2,$3,$4,$5,$6)`,
        [org.org_id, e.province_code, e.registration_no, e.established_year ? e.established_year - 543 : null, e.member_count, `จัดตั้งจากทะเบียนสหกรณ์ล่วงหน้า (${e.source_label})`], // cooperative_profile เก็บปี ค.ศ.
      );
      if (!e.tax_id) await c.query('UPDATE registry.coop_directory SET tax_id = $2 WHERE directory_id = $1', [e.directory_id, tax]);
      await link(c, { ...e, tax_id: tax }, org.org_id, 'provisioned', adminKey(req));
      return { org_id: org.org_id, org_name: org.org_name, directory_id: e.directory_id };
    }));
  }));

  // =================================================================== สหกรณ์ในระบบ (ผู้ขอกู้ / ผู้ให้กู้)
  const allowedTypes = (orgType) => Object.entries(CR.ORG_TYPE).filter(([, t]) => t === orgType).map(([k]) => k);
  for (const router of [borrower, savings]) {
    router.get('/registry/mine', wrap(async (req, res) => {
      res.json(await orgTx(req, async (c) => {
        if (!(await has(c, 'registry.coop_directory'))) return { installed: false };
        const entry = (await c.query(`${ENTRY} WHERE d.org_id = $1`, [req.org.org_id])).rows[0] || null;
        const financials = entry ? (await c.query('SELECT * FROM registry.coop_directory_financial WHERE directory_id = $1 ORDER BY year DESC', [entry.directory_id])).rows : [];
        const claims = (await c.query(
          `SELECT cl.claim_id, cl.status, cl.created_at, cl.decided_at, cl.decision_note, d.coop_name, d.registration_no
             FROM registry.coop_directory_claim cl JOIN registry.coop_directory d ON d.directory_id = cl.directory_id WHERE cl.org_id = $1 ORDER BY cl.created_at DESC LIMIT 10`, [req.org.org_id],
        )).rows;
        const size = (await c.query('SELECT COUNT(*)::int AS n FROM registry.coop_directory WHERE coop_type = ANY($1)', [allowedTypes(req.org.org_type)])).rows[0].n;
        return { installed: true, entry, financials, claims, directory_size: size, types: CR.TYPES };
      }));
    }));
    router.get('/registry/search', wrap(async (req, res) => {
      const q = String(req.query.q || '').trim().slice(0, 100);
      if (q.length < 2) fail(400, 'query_too_short');
      res.json(await orgTx(req, async (c) => (await c.query(
        `SELECT d.directory_id, d.coop_name, d.registration_no, d.coop_type, d.district, d.status, pv.province_name_th, d.org_id IS NOT NULL AS linked,
                (d.tax_id IS NOT NULL AND d.tax_id = regexp_replace($4, '\\D', '', 'g')) AS tax_match
           FROM registry.coop_directory d LEFT JOIN registry.province pv ON pv.province_code = d.province_code
          WHERE d.coop_type = ANY($3) AND (d.name_key LIKE $1 OR d.registration_no = $2 OR d.tax_id = $2)
          ORDER BY tax_match DESC, d.coop_name LIMIT 20`,
        [`%${CR.nameKey(q)}%`, q, allowedTypes(req.org.org_type), req.org.tax_id || ''],
      )).rows));
    }));
    router.post('/registry/claims', wrap(async (req, res) => {
      const b = req.body || {};
      if (!isUuid(b.directory_id)) fail(400, 'invalid_directory');
      if (!isUuid(b.file_id)) fail(400, 'file_required');
      res.status(201).json(await orgTx(req, async (c) => {
        const actor = await actorOf(c, req);
        const e = (await c.query('SELECT * FROM registry.coop_directory WHERE directory_id = $1', [b.directory_id])).rows[0];
        if (!e) fail(404, 'directory_not_found');
        if (!allowedTypes(req.org.org_type).includes(e.coop_type)) fail(409, 'org_type_mismatch');
        if (e.org_id) fail(409, e.org_id === req.org.org_id ? 'already_yours' : 'directory_already_linked');
        if ((await c.query('SELECT 1 FROM registry.coop_directory WHERE org_id = $1', [req.org.org_id])).rows[0]) fail(409, 'org_already_linked');
        const f = (await c.query(
          `SELECT file_id FROM storage.file_object WHERE file_id = $1 AND ((owner_subject_type = 'organization' AND owner_subject_id = $2)
              OR (owner_subject_type = 'organization_member' AND owner_subject_id IN (SELECT member_id FROM identity.organization_member WHERE org_id = $2)))`, [b.file_id, req.org.org_id],
        )).rows[0];
        if (!f) fail(404, 'file_not_found');
        if ((await c.query(`SELECT 1 FROM registry.coop_directory_claim WHERE org_id = $1 AND status = 'Pending'`, [req.org.org_id])).rows[0]) fail(409, 'claim_already_pending');
        return (await c.query(
          `INSERT INTO registry.coop_directory_claim (directory_id, org_id, contact_name, contact_position, note, file_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [e.directory_id, req.org.org_id, text(b.contact_name, 'contact_name', { min: 2, max: 160 }), text(b.contact_position, 'contact_position', { max: 120, allowNull: true }),
            text(b.note, 'note', { max: 1000, allowNull: true }), f.file_id, actor.key],
        )).rows[0];
      }));
    }));
    router.post('/registry/claims/:id/withdraw', wrap(async (req, res) => {
      if (!isUuid(req.params.id)) fail(404, 'claim_not_found');
      res.json(await orgTx(req, async (c) => {
        const r = (await c.query(`UPDATE registry.coop_directory_claim SET status = 'Withdrawn', decided_at = now() WHERE claim_id = $1 AND org_id = $2 AND status = 'Pending' RETURNING *`,
          [req.params.id, req.org.org_id])).rows[0];
        if (!r) fail(404, 'claim_not_found');
        return r;
      }));
    }));
  }

  // =================================================================== กรมส่งเสริมสหกรณ์
  gov.get('/registry/coverage', wrap(async (req, res) => {
    res.json(await govTx(req, async (c) => {
      if (!(await has(c, 'registry.coop_directory'))) return { installed: false };
      const { province } = await officerScope(c, req);
      const byType = (await c.query(
        `SELECT d.coop_type, COUNT(*) FILTER (WHERE d.status = 'active')::int AS active, COUNT(d.org_id)::int AS linked,
                COUNT(*) FILTER (WHERE d.org_id IS NOT NULL AND (EXISTS (SELECT 1 FROM coop_lending.borrower_profile bp WHERE bp.org_id = d.org_id)
                                                           OR EXISTS (SELECT 1 FROM coop_lending.lender_profile lp WHERE lp.org_id = d.org_id)))::int AS in_market
           FROM registry.coop_directory d WHERE ($1::text IS NULL OR d.province_code = $1) GROUP BY 1`, [province],
      )).rows;
      const notJoined = (await c.query(
        `SELECT d.coop_name, d.registration_no, d.coop_type, d.district, pv.province_name_th, d.member_count
           FROM registry.coop_directory d LEFT JOIN registry.province pv ON pv.province_code = d.province_code
          WHERE d.org_id IS NULL AND d.status = 'active' AND d.coop_type = ANY($2) AND ($1::text IS NULL OR d.province_code = $1)
          ORDER BY d.member_count DESC NULLS LAST, d.coop_name LIMIT 300`, [province, [...CR.BORROWER_TYPES, ...CR.LENDER_TYPES]],
      )).rows;
      const src = (await c.query(`SELECT source_label, as_of FROM registry.coop_directory_import WHERE kind = 'directory' AND status = 'Committed' ORDER BY committed_at DESC LIMIT 1`)).rows[0] || null;
      return { installed: true, province, by_type: byType, not_joined: notJoined, source: src, types: CR.TYPES };
    }));
  }));
}

module.exports = { attach, registryCheck };
