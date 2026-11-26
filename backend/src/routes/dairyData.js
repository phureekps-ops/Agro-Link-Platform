const crypto = require('crypto');

const { logAccess } = require('../db/pool');
const { h, tx, bad, notFound, conflict, round2, bkkToday, isUuid, addDays } = require('../lib/dairy');
const DQ = require('../lib/dairyDataQuality');
const trace = require('../lib/dairyTrace');

/**
 * /dairy ส่วนต่อขยาย: นำเข้าไฟล์พร้อมตรวจคุณภาพข้อมูล, แดชบอร์ดคุณภาพข้อมูล, ล็อตน้ำนมและการตรวจสอบย้อนกลับ
 * ใช้ helper ของ routes/dairy.js (db/own/actor/closeRoundById/saveQualityTests) ผ่าน attach() — ไม่มี middleware ของตัวเอง
 * ทุก query กรองด้วย coop_org_id ของสหกรณ์ที่ login เหมือนส่วนอื่นของ /dairy
 */
function attach(router, { db, own, actor, closeRoundById, saveQualityTests, scanSurplusAfterClose }) {
  const KINDS = ['intake', 'quality'];

  /** ข้อมูลในระบบที่ใช้ตรวจแถว (ดึงครั้งเดียวต่อไฟล์) */
  async function buildCtx(c, coop, kind, norm, opts) {
    const codes = [...new Set(norm.map((r) => r.values.member_code).filter(Boolean))];
    const dateField = kind === 'intake' ? 'round_date' : 'sample_date';
    const dates = norm.map((r) => r.values[dateField]).filter(Boolean).sort();
    const lo = dates[0] || bkkToday();
    const hi = dates[dates.length - 1] || bkkToday();
    const members = new Map((await c.query(
      `SELECT m.member_id, m.member_code, m.full_name, m.status, m.center_id,
              (SELECT AVG(i.weight_kg) FROM dairy.milk_intake i JOIN dairy.milk_round r ON r.round_id=i.round_id
                WHERE i.member_id=m.member_id AND i.status='Accepted' AND r.round_date BETWEEN $3::date - 30 AND $3::date - 1)::float AS avg_kg
         FROM dairy.member m WHERE m.coop_org_id=$1 AND m.member_code = ANY($2)`, [coop, codes, lo],
    )).rows.map((m) => [m.member_code, m]));
    const centers = (await c.query('SELECT center_id, name FROM dairy.collection_center WHERE coop_org_id=$1', [coop])).rows;
    const settled = (await c.query(
      `SELECT period_start::text AS start, period_end::text AS end FROM dairy.settlement_run WHERE coop_org_id=$1 AND status <> 'Cancelled' AND period_end >= $2`, [coop, lo],
    )).rows;
    const ids = [...members.values()].map((m) => m.member_id);
    const ctx = { members, centers, settled, defaultCenterId: opts.center_id || null, rounds: new Map(), intakes: new Map(), otherCenterIntakes: new Map(), withdrawal: new Map(), tests: new Map() };
    if (kind === 'intake') {
      (await c.query(
        `SELECT round_id, center_id, round_date::text AS d, shift, status FROM dairy.milk_round WHERE coop_org_id=$1 AND round_date BETWEEN $2 AND $3`, [coop, lo, hi],
      )).rows.forEach((r) => ctx.rounds.set(`${r.center_id}|${r.d}|${r.shift}`, r));
      (await c.query(
        `SELECT i.member_id, r.center_id, cc.name AS center_name, r.round_date::text AS d, r.shift, i.weight_kg, i.status, i.reject_reason
           FROM dairy.milk_intake i JOIN dairy.milk_round r ON r.round_id=i.round_id JOIN dairy.collection_center cc ON cc.center_id=r.center_id
          WHERE r.coop_org_id=$1 AND r.round_date BETWEEN $2 AND $3 AND i.member_id = ANY($4)`, [coop, lo, hi, ids],
      )).rows.forEach((i) => {
        ctx.intakes.set(`${i.member_id}|${i.center_id}|${i.d}|${i.shift}`, i);
        ctx.otherCenterIntakes.set(`${i.member_id}|${i.d}|${i.shift}`, i);
      });
      (await c.query(
        `SELECT member_id, ear_tag, withdrawal_until::text AS until FROM dairy.animal WHERE member_id = ANY($1) AND status='Milking' AND withdrawal_until >= $2`, [ids, lo],
      )).rows.forEach((a) => { if (!ctx.withdrawal.has(a.member_id)) ctx.withdrawal.set(a.member_id, []); ctx.withdrawal.get(a.member_id).push(a); });
    } else {
      (await c.query(
        `SELECT member_id, sample_date::text AS d, fat_pct, snf_pct, protein_pct, scc_k, tbc_k, antibiotic_pos FROM dairy.quality_test
          WHERE coop_org_id=$1 AND sample_date BETWEEN $2 AND $3 AND member_id = ANY($4)`, [coop, lo, hi, ids],
      )).rows.forEach((t) => { const k = `${t.member_id}|${t.d}`; if (!ctx.tests.has(k)) ctx.tests.set(k, []); ctx.tests.get(k).push(t); });
    }
    return ctx;
  }

  const slim = (r) => ({
    row_no: r.row_no, verdict: r.verdict, values: r.values, errors: r.errors, warnings: r.warnings, ...(r.withdrawal ? { withdrawal: true } : {}),
  });
  async function validateImport(c, coop, imp) {
    const ctx = await buildCtx(c, coop, imp.kind, imp.rows, imp.options || {});
    return DQ.validateRows(imp.kind, imp.rows, ctx);
  }

  // ---- แบบฟอร์ม -----------------------------------------------------------
  router.get('/imports/template', h(async (req, res) => db(req, async (c, coop) => {
    const kind = KINDS.includes(req.query.kind) ? req.query.kind : 'intake';
    const m = (await c.query(
      `SELECT m.member_code, cc.name AS center FROM dairy.member m LEFT JOIN dairy.collection_center cc ON cc.center_id=m.center_id
        WHERE m.coop_org_id=$1 AND m.status='Approved' ORDER BY m.member_code LIMIT 1`, [coop],
    )).rows[0] || {};
    const [y, mo, d] = bkkToday().split('-').map(Number);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="agrolink-${kind === 'quality' ? 'quality' : 'milk-intake'}-template.csv"`);
    res.send(DQ.template(kind, { member_code: m.member_code, center: m.center, date_be: `${d}/${mo}/${y + 543}` }));
    return undefined;
  })));

  // ---- ตรวจไฟล์ (ยังไม่บันทึก) ------------------------------------------------
  router.post('/imports/preview', h(async (req) => db(req, async (c, coop) => {
    const b = req.body || {};
    const kind = b.kind;
    if (!KINDS.includes(kind)) throw bad('invalid_field', { field: 'kind' });
    const filename = String(b.filename || '').trim().slice(0, 200) || `upload.${kind}`;
    if (typeof b.content_base64 !== 'string' || !b.content_base64) throw bad('missing_file');
    const buf = Buffer.from(b.content_base64.replace(/^data:[^,]*,/, ''), 'base64');
    const o = b.options || {};
    const opts = {
      default_shift: ['AM', 'PM'].includes(o.default_shift) ? o.default_shift : null,
      default_date: DQ.parseDate(o.default_date) ? DQ.parseDate(o.default_date).date : null,
      center_id: null,
      lab_name: o.lab_name ? String(o.lab_name).trim().slice(0, 120) : null,
    };
    if (o.center_id) opts.center_id = (await own(c, coop, 'center', o.center_id)).center_id;
    let parsed;
    try { parsed = DQ.parseFile(filename, buf); } catch (e) {
      if (e instanceof DQ.FileError) throw bad(e.code, e.detail || {});
      throw e;
    }
    const cols = DQ.mapColumns(kind, parsed.header);
    if (cols.missing.length) throw bad('missing_columns', { missing: cols.missing, header: parsed.header });
    const today = bkkToday();
    const norm = parsed.rows.map((r) => ({ row_no: r.row_no, ...DQ.normalizeRow(kind, r.cells, cols.map, { ...opts, today }) }));
    const imp = { kind, rows: norm, options: opts };
    const rows = await validateImport(c, coop, imp);
    const sum = DQ.summarize(rows);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const prev = (await c.query(
      `SELECT import_id, committed_at FROM dairy.data_import WHERE coop_org_id=$1 AND file_sha256=$2 AND status='Committed' ORDER BY committed_at DESC LIMIT 1`, [coop, sha],
    )).rows[0];
    const columns = Object.fromEntries(Object.entries(cols.map).map(([f, i]) => [f, parsed.header[i]]));
    const saved = (await c.query(
      `INSERT INTO dairy.data_import (coop_org_id, kind, filename, file_format, file_sha256, row_count, ok_count, warning_count, error_count, duplicate_count,
                                      rows, columns, options, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING import_id, created_at`,
      [coop, kind, filename, parsed.format, sha, sum.row_count, sum.ok_count, sum.warning_count, sum.error_count, sum.duplicate_count,
        JSON.stringify(norm), JSON.stringify(columns), JSON.stringify(opts), actor(req)],
    )).rows[0];
    return {
      import_id: saved.import_id, kind, filename, format: parsed.format, columns, unknown_columns: cols.unknown, summary: sum,
      same_file_committed_at: prev ? prev.committed_at : null, rows: rows.map(slim),
    };
  })));

  router.get('/imports', h(async (req) => db(req, async (c, coop) => (await c.query(
    `SELECT import_id, kind, filename, file_format, row_count, ok_count, warning_count, error_count, duplicate_count, status, created_by, created_at,
            committed_by, committed_at, result->'counts' AS result_counts
       FROM dairy.data_import WHERE coop_org_id=$1 ORDER BY created_at DESC LIMIT 100`, [coop],
  )).rows)));

  async function ownImport(c, coop, id, lock) {
    if (!isUuid(id)) throw notFound('import_not_found');
    const r = (await c.query(`SELECT * FROM dairy.data_import WHERE import_id=$1 AND coop_org_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, coop])).rows[0];
    if (!r) throw notFound('import_not_found');
    return r;
  }

  router.get('/imports/:id', h(async (req) => db(req, async (c, coop) => {
    const imp = await ownImport(c, coop, req.params.id);
    const { rows: norm, ...meta } = imp;
    if (imp.status === 'Previewed') {
      const rows = await validateImport(c, coop, imp);
      return { ...meta, summary: DQ.summarize(rows), rows: rows.map(slim) };
    }
    return { ...meta, rows: norm.map((r) => ({ row_no: r.row_no, values: r.values })) };
  })));

  router.post('/imports/:id/discard', h(async (req) => db(req, async (c, coop) => {
    const imp = await ownImport(c, coop, req.params.id);
    if (imp.status !== 'Previewed') throw conflict('import_not_previewed', { status: imp.status });
    await c.query(`UPDATE dairy.data_import SET status='Discarded' WHERE import_id=$1`, [imp.import_id]);
    return { import_id: imp.import_id, status: 'Discarded' };
  })));

  /**
   * บันทึก: ตรวจซ้ำกับข้อมูลล่าสุดในระบบ (อาจมีคนบันทึกระหว่างดูตัวอย่าง) แล้วบันทึกแถว ok (+ warning ถ้า include_warnings)
   * ทั้งไฟล์อยู่ใน transaction เดียว — ผิดพลาดกลางทางจะไม่มีอะไรถูกบันทึก
   */
  router.post('/imports/:id/commit', h(async (req) => db(req, async (c, coop) => {
    const b = req.body || {};
    let closed = 0;
    const out = await tx(c, async () => {
      const imp = await ownImport(c, coop, req.params.id, true);
      if (imp.status !== 'Previewed') throw conflict('import_not_previewed', { status: imp.status });
      const rows = await validateImport(c, coop, imp);
      const exclude = new Set(Array.isArray(b.exclude_rows) ? b.exclude_rows.map(Number) : []);
      const withWarnings = b.include_warnings !== false;
      const outcome = [];
      const take = [];
      rows.forEach((r) => {
        let o = null;
        if (exclude.has(r.row_no)) o = 'excluded';
        else if (r.verdict === 'error') o = 'skipped_error';
        else if (r.verdict === 'duplicate') o = 'skipped_duplicate';
        else if (r.verdict === 'warning' && !withWarnings) o = 'skipped_warning';
        else if (r.withdrawal && b.confirm_withdrawal !== true) o = 'skipped_withdrawal';
        if (o) outcome.push({ row_no: r.row_no, outcome: o });
        else take.push(r);
      });
      const who = actor(req);
      const counts = { inserted: 0, replaced: 0, rounds_created: 0, rounds_closed: 0 };
      if (imp.kind === 'intake') {
        const groups = new Map();
        take.forEach((r) => {
          const k = `${r.values.center_id}|${r.values.round_date}|${r.values.shift}`;
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(r);
        });
        const touched = [];
        const keys = [...groups.keys()].sort((a, z) => { const [, da, sa] = a.split('|'); const [, dz, sz] = z.split('|'); return `${da}${sa}`.localeCompare(`${dz}${sz}`); });
        for (const k of keys) {
          const [centerId, date, shift] = k.split('|');
          const ins = await c.query(
            `INSERT INTO dairy.milk_round (coop_org_id, center_id, round_date, shift) VALUES ($1,$2,$3,$4) ON CONFLICT (center_id, round_date, shift) DO NOTHING RETURNING round_id`,
            [coop, centerId, date, shift],
          );
          if (ins.rows.length) counts.rounds_created += 1;
          const round = (await c.query('SELECT * FROM dairy.milk_round WHERE center_id=$1 AND round_date=$2 AND shift=$3 FOR UPDATE', [centerId, date, shift])).rows[0];
          if (round.status !== 'Open') { groups.get(k).forEach((r) => outcome.push({ row_no: r.row_no, outcome: 'skipped_round_closed' })); continue; }
          touched.push(round.round_id);
          for (const r of groups.get(k)) {
            const v = r.values;
            const res = (await c.query(
              `INSERT INTO dairy.milk_intake (coop_org_id, round_id, member_id, weight_kg, status, reject_reason, sample_no, source, import_id, recorded_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'file',$8,$9)
               ON CONFLICT (round_id, member_id) DO UPDATE SET weight_kg=EXCLUDED.weight_kg, status=EXCLUDED.status, reject_reason=EXCLUDED.reject_reason,
                  sample_no=COALESCE(EXCLUDED.sample_no, dairy.milk_intake.sample_no), source='file', import_id=EXCLUDED.import_id,
                  recorded_by=EXCLUDED.recorded_by, recorded_at=now()
               RETURNING (xmax = 0) AS inserted`,
              [coop, round.round_id, v.member_id, v.weight_kg, v.status, v.status === 'Rejected' ? v.reject_reason : null, v.sample_no, imp.import_id, who],
            )).rows[0];
            if (res.inserted) counts.inserted += 1; else counts.replaced += 1;
            outcome.push({ row_no: r.row_no, outcome: res.inserted ? 'inserted' : 'replaced', round_id: round.round_id });
          }
        }
        if (b.close_rounds === true) {
          for (const id of touched) {
            const done = await closeRoundById(c, coop, id, {});
            counts.rounds_closed += 1;
            outcome.filter((o) => o.round_id === id).forEach((o) => { o.batch_code = done.batch_code; });
          }
          closed = counts.rounds_closed;
        }
      } else if (take.length) {
        const list = take.map((r) => ({
          member_id: r.values.member_id, sample_date: r.values.sample_date, fat_pct: r.values.fat_pct, snf_pct: r.values.snf_pct, protein_pct: r.values.protein_pct,
          scc_k: r.values.scc_k, tbc_k: r.values.tbc_k, antibiotic_pos: !!r.values.antibiotic_pos, lab_name: r.values.lab_name,
        }));
        await saveQualityTests(c, coop, list, { source: 'file', importId: imp.import_id });
        counts.inserted = list.length;
        take.forEach((r) => outcome.push({ row_no: r.row_no, outcome: 'inserted' }));
      }
      outcome.sort((a, z) => a.row_no - z.row_no);
      outcome.forEach((o) => { if (o.outcome.startsWith('skipped') || o.outcome === 'excluded') counts[o.outcome] = (counts[o.outcome] || 0) + 1; });
      const result = { counts, rows: outcome.map(({ round_id, ...o }) => o), options: { close_rounds: b.close_rounds === true, include_warnings: withWarnings, confirm_withdrawal: b.confirm_withdrawal === true } };
      await c.query(
        `UPDATE dairy.data_import SET status='Committed', committed_by=$2, committed_at=now(), result=$3 WHERE import_id=$1`,
        [imp.import_id, who, JSON.stringify(result)],
      );
      await logAccess(c, 'write', 'dairy.data_import', imp.import_id);
      return { import_id: imp.import_id, status: 'Committed', ...result };
    });
    if (closed) await scanSurplusAfterClose(c, coop, actor(req));
    return out;
  })));

  // ---- แดชบอร์ดคุณภาพข้อมูล -------------------------------------------------
  router.get('/data-quality', h(async (req) => db(req, async (c, coop) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 180);
    const to = bkkToday();
    const from = addDays(to, -(days - 1));
    const P = [coop, from, to];
    const bySource = (await c.query(
      `SELECT i.source, COUNT(*)::int AS records, COALESCE(SUM(i.weight_kg),0)::numeric(14,2) AS kg
         FROM dairy.milk_intake i JOIN dairy.milk_round r ON r.round_id=i.round_id
        WHERE r.coop_org_id=$1 AND r.round_date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 2 DESC`, P,
    )).rows;
    const testsBySource = (await c.query(
      `SELECT source, COUNT(*)::int AS records FROM dairy.quality_test WHERE coop_org_id=$1 AND sample_date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 2 DESC`, P,
    )).rows;
    const openRounds = (await c.query(
      `SELECT r.round_id, r.round_date::text AS round_date, r.shift, cc.name AS center_name,
              (SELECT COUNT(*) FROM dairy.milk_intake i WHERE i.round_id=r.round_id)::int AS intakes
         FROM dairy.milk_round r JOIN dairy.collection_center cc ON cc.center_id=r.center_id
        WHERE r.coop_org_id=$1 AND r.status='Open' AND r.round_date < $2 ORDER BY r.round_date LIMIT 50`, [coop, to],
    )).rows;
    const outliers = (await c.query(
      `WITH x AS (
         SELECT i.intake_id, m.member_code, m.full_name, r.round_date, r.shift, i.weight_kg, i.source,
                AVG(i.weight_kg) OVER (PARTITION BY i.member_id) AS avg_kg, COUNT(*) OVER (PARTITION BY i.member_id) AS n
           FROM dairy.milk_intake i JOIN dairy.milk_round r ON r.round_id=i.round_id JOIN dairy.member m ON m.member_id=i.member_id
          WHERE r.coop_org_id=$1 AND r.round_date BETWEEN $2 AND $3 AND i.status='Accepted')
       SELECT member_code, full_name, round_date::text AS round_date, shift, weight_kg, source, ROUND(avg_kg, 1) AS avg_kg
         FROM x WHERE n >= 4 AND (weight_kg > 3 * avg_kg OR weight_kg < 0.2 * avg_kg) ORDER BY round_date DESC LIMIT 30`, P,
    )).rows;
    const multiCenter = (await c.query(
      `SELECT m.member_code, m.full_name, r.round_date::text AS round_date, r.shift, string_agg(cc.name, ', ' ORDER BY cc.name) AS centers, SUM(i.weight_kg)::numeric(12,2) AS kg
         FROM dairy.milk_intake i JOIN dairy.milk_round r ON r.round_id=i.round_id JOIN dairy.member m ON m.member_id=i.member_id
         JOIN dairy.collection_center cc ON cc.center_id=r.center_id
        WHERE r.coop_org_id=$1 AND r.round_date BETWEEN $2 AND $3
        GROUP BY m.member_id, r.round_date, r.shift HAVING COUNT(DISTINCT r.center_id) > 1 ORDER BY r.round_date DESC LIMIT 30`, P,
    )).rows;
    const noTest = (await c.query(
      `SELECT m.member_code, m.full_name, MAX(t.sample_date)::text AS last_test
         FROM dairy.member m LEFT JOIN dairy.quality_test t ON t.member_id=m.member_id
        WHERE m.coop_org_id=$1 AND m.status='Approved'
          AND EXISTS (SELECT 1 FROM dairy.milk_intake i JOIN dairy.milk_round r ON r.round_id=i.round_id WHERE i.member_id=m.member_id AND r.round_date BETWEEN $2 AND $3)
        GROUP BY m.member_id HAVING MAX(t.sample_date) IS NULL OR MAX(t.sample_date) < $3::date - 30 ORDER BY m.member_code LIMIT 200`, P,
    )).rows;
    const [rounds] = (await c.query(
      `SELECT COUNT(*) FILTER (WHERE status='Closed')::int AS closed,
              COUNT(*) FILTER (WHERE status='Closed' AND tank_temp_c IS NULL)::int AS closed_without_temp,
              COUNT(*) FILTER (WHERE status='Closed' AND batch_id IS NOT NULL)::int AS in_batch
         FROM dairy.milk_round WHERE coop_org_id=$1 AND round_date BETWEEN $2 AND $3`, P,
    )).rows;
    const [ships] = (await c.query(
      `SELECT COUNT(*)::int AS shipments, COUNT(*) FILTER (WHERE batch_id IS NOT NULL)::int AS with_batch,
              COUNT(*) FILTER (WHERE center_id IS NULL)::int AS without_center
         FROM dairy.shipment WHERE coop_org_id=$1 AND ship_date BETWEEN $2 AND $3 AND status <> 'Cancelled'`, P,
    )).rows;
    const mismatches = (await c.query(
      `SELECT b.batch_code, b.accepted_kg, s.sent_kg, s.received_kg, s.status, s.ship_date::text AS ship_date,
              ROUND((s.sent_kg - b.accepted_kg) / NULLIF(b.accepted_kg, 0) * 100, 2) AS diff_pct
         FROM dairy.milk_batch b JOIN dairy.shipment s ON s.shipment_id=b.shipment_id
        WHERE b.coop_org_id=$1 AND s.ship_date BETWEEN $2 AND $3
          AND (b.accepted_kg = 0 OR ABS(s.sent_kg - b.accepted_kg) / b.accepted_kg * 100 > $4)
        ORDER BY s.ship_date DESC LIMIT 30`, [...P, trace.DIFF_WARN_PCT],
    )).rows;
    const imports = (await c.query(
      `SELECT import_id, kind, filename, row_count, ok_count, warning_count, error_count, duplicate_count, status, created_at
         FROM dairy.data_import WHERE coop_org_id=$1 ORDER BY created_at DESC LIMIT 5`, [coop],
    )).rows;
    const totalRec = bySource.reduce((a, r) => a + r.records, 0);
    const autoRec = bySource.filter((r) => ['scale', 'gateway', 'api'].includes(r.source)).reduce((a, r) => a + r.records, 0);
    return {
      from, to, days,
      intake_by_source: bySource, tests_by_source: testsBySource,
      automated_pct: totalRec ? round2((autoRec / totalRec) * 100) : null,
      open_rounds: openRounds, outliers, multi_center: multiCenter, members_without_recent_test: noTest,
      rounds, shipments: ships, batch_mismatches: mismatches, recent_imports: imports,
    };
  })));

  // ---- ล็อตน้ำนม / ตรวจสอบย้อนกลับ -----------------------------------------
  router.get('/milk-batches', h(async (req) => db(req, async (c, coop) => {
    const params = [coop];
    let f = '';
    if (['Collecting', 'Shipped', 'Received', 'Rejected'].includes(req.query.status)) { params.push(req.query.status); f += ` AND b.status=$${params.length}`; }
    if (req.query.q) { params.push(`%${String(req.query.q).trim().toUpperCase()}%`); f += ` AND b.batch_code LIKE $${params.length}`; }
    return (await c.query(
      `SELECT b.batch_code, b.status, b.rounds, b.accepted_kg, b.farm_count, b.first_round_date::text AS first_round_date, b.last_round_date::text AS last_round_date,
              b.shipped_at, b.closed_at, cc.name AS center_name, s.sent_kg, s.received_kg, s.ship_date::text AS ship_date, s.vehicle, p.name AS partner_name,
              ROUND((s.sent_kg - b.accepted_kg) / NULLIF(b.accepted_kg, 0) * 100, 2) AS sent_diff_pct
         FROM dairy.milk_batch b JOIN dairy.collection_center cc ON cc.center_id=b.center_id
         LEFT JOIN dairy.shipment s ON s.shipment_id=b.shipment_id LEFT JOIN dairy.partner p ON p.partner_id=s.partner_id
        WHERE b.coop_org_id=$1 ${f} ORDER BY (b.status='Collecting') DESC, b.opened_at DESC LIMIT 200`, params,
    )).rows;
  })));

  router.get('/milk-batches/:code/trace', h(async (req) => db(req, async (c, coop) => {
    const b = (await c.query('SELECT * FROM dairy.milk_batch WHERE batch_code=$1 AND coop_org_id=$2', [String(req.params.code).trim().toUpperCase(), coop])).rows[0];
    if (!b) throw notFound('batch_not_found');
    await logAccess(c, 'read', 'dairy.milk_batch', b.batch_id);
    return trace.traceBatch(c, b, 'coop');
  })));

  router.get('/members/:id/milk-batches', h(async (req) => db(req, async (c, coop) => {
    const m = await own(c, coop, 'member', req.params.id);
    return { member_code: m.member_code, full_name: m.full_name, batches: await trace.batchesOfMember(c, m.member_id) };
  })));
}

module.exports = { attach };
