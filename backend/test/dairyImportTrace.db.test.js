/*
 * End-to-end: นำเข้าไฟล์รับนม/ผลคุณภาพ (ตรวจก่อนบันทึก) → ปิดรอบ → ล็อตน้ำนม → เที่ยวส่ง → โรงงานรับ
 * → ตรวจสอบย้อนกลับ (สหกรณ์ / โรงงาน / เจ้าหน้าที่รัฐ) ผ่าน HTTP API จริงกับ PostgreSQL จริง
 *
 * NEVER point this at Render / production. Runs only when DAIRY_DB_TEST=1 and the database is local.
 * Needs grant_dairy_import_trace.sql applied.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { xlsx } = require('./fixtures/xlsx');

const ENABLED = process.env.DAIRY_DB_TEST === '1';
const host = process.env.PGHOST || '';
const LOCAL = !process.env.DATABASE_URL && (host.startsWith('/') || ['localhost', '127.0.0.1', '::1'].includes(host));
const SKIP = !ENABLED ? 'set DAIRY_DB_TEST=1 to run (local test database only)'
  : (!LOCAL ? 'refusing to run: PGHOST must be a local database (and DATABASE_URL unset)' : false);

const JWT_SECRET = `imp-test-${crypto.randomBytes(8).toString('hex')}`;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const today = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const dayOffset = (n) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const be = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d}/${m}/${y + 543}`; };
const b64 = (s) => Buffer.from(s).toString('base64');

test('import with validation → milk batch → shipment → trace (database)', { skip: SKIP, timeout: 120000 }, async (t) => {
  // eslint-disable-next-line global-require
  const { Client } = require('pg');
  // eslint-disable-next-line global-require
  const jwt = require('jsonwebtoken');
  const db = new Client();
  await db.connect();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  srv.stdout.on('data', (d) => { srvLog += d; });
  srv.stderr.on('data', (d) => { srvLog += d; });
  t.after(async () => { if (process.env.DAIRY_TEST_VERBOSE) console.log(srvLog); srv.kill(); await db.end(); });
  for (let i = 0; i < 100 && !/listening on port/.test(srvLog); i += 1) await sleep(100);
  assert.match(srvLog, /listening on port/, 'API server did not start');
  const base = `http://127.0.0.1:${port}`;
  async function call(auth, method, p, body, expectStatus = 200) {
    const res = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    assert.equal(res.status, expectStatus, `${method} ${p} → ${res.status} ${text.slice(0, 400)}`);
    return json;
  }

  const tag = crypto.randomBytes(4).toString('hex');
  const org = async (type, name) => {
    const id = crypto.randomUUID();
    await db.query(`INSERT INTO identity.organization (org_id, org_type, org_name, tax_id, kyb_status) VALUES ($1,$2,$3,$4,'Verified')`,
      [id, type, name, `I${Date.now()}${crypto.randomBytes(3).toString('hex')}`.slice(0, 20)]);
    await db.query(`INSERT INTO identity.subject_role (subject_type, subject_id, role_code) VALUES ('organization',$1,'org.admin')`, [id]);
    return id;
  };
  const coopId = await org('Cooperative', `สหกรณ์โคนมทดสอบนำเข้า ${tag}`);
  await db.query(`INSERT INTO identity.organization_role (org_id, role_type, status) VALUES ($1,'Cooperative','Verified')`, [coopId]);
  await db.query(`INSERT INTO registry.cooperative_profile (org_id, province_code) VALUES ($1,'SARABURI')`, [coopId]);
  const COOP = jwt.sign({ subjectType: 'organization', subjectId: coopId }, JWT_SECRET);
  const factoryId = await org('Buyer', `โรงงานนมทดสอบ ${tag}`);
  const FACTORY = jwt.sign({ subjectType: 'organization', subjectId: factoryId }, JWT_SECRET);
  const otherId = await org('Buyer', `โรงงานอื่น ${tag}`);
  const OTHER = jwt.sign({ subjectType: 'organization', subjectId: otherId }, JWT_SECRET);
  const officerId = crypto.randomUUID();
  await db.query(
    `INSERT INTO identity.government_officer (officer_id, full_name, national_id_hash, scope_type, province_code, auth_subject_id, created_by, department_code)
     VALUES ($1,'เจ้าหน้าที่ปศุสัตว์',$2,'Province','SARABURI',$3,'test','CPD')`, [officerId, crypto.randomBytes(16).toString('hex'), `gov-imp-${tag}`],
  );
  await db.query(`INSERT INTO identity.subject_role (subject_type, subject_id, role_code) VALUES ('government_officer',$1,'gov.provincial_admin')`, [officerId]).catch(() => {});
  const GOV = jwt.sign({ subjectType: 'government_officer', subjectId: officerId }, JWT_SECRET);

  let A; let tank; let contract; const M = {};
  await t.test('setup: centre with a cooling-tank sensor, members, a factory contract', async () => {
    await call(COOP, 'GET', '/dairy/overview');
    await call(COOP, 'PUT', '/dairy/settings', { base_price_per_kg: 19 });
    A = await call(COOP, 'POST', '/dairy/centers', { name: `ศูนย์หนองโพ ${tag}`, tank_capacity_kg: 2000 });
    for (const [code, name, reg] of [['D001', 'นายหนึ่ง', 'FR-001'], ['D002', 'นางสอง', 'FR-002'], ['D003', 'นายสาม', null]]) {
      M[code] = await call(COOP, 'POST', '/dairy/members', { full_name: name, member_code: code, center_id: A.center_id, farm_registration_no: reg });
      await call(COOP, 'POST', `/dairy/members/${M[code].member_id}/status`, { status: 'Approved' });
    }
    tank = await call(COOP, 'POST', '/dairy/iot/devices', { name: 'ถังเย็น 1', device_type: 'cooling_tank', center_id: A.center_id, temp_max: 6 });
    const p = await call(COOP, 'POST', '/dairy/partners', { partner_type: 'processor', name: `โรงงานนมทดสอบ ${tag}`, linked_org_id: factoryId });
    contract = await call(COOP, 'POST', '/dairy/contracts', { partner_id: p.partner_id, start_date: dayOffset(-30), end_date: dayOffset(60), daily_kg: 500, price_per_kg: 19.5 });
  });

  await t.test('template downloads as a UTF-8 CSV with BOM and this coop\'s member code', async () => {
    const res = await fetch(`${base}/dairy/imports/template?kind=intake`, { headers: { Authorization: `Bearer ${COOP}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const raw = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.match(raw.toString('utf8'), /D001/);
  });

  const y = dayOffset(-1);
  const csv = [
    'รหัสสมาชิก,วันที่,รอบ,น้ำหนัก (กก.),สถานะ,สาเหตุที่ไม่รับ',
    `D001,${be(y)},เช้า,40,รับ,`, // 2 ok
    `D002,${be(y)},เช้า,35,รับ,`, // 3 ok
    `D001,${be(y)},เช้า,41,รับ,`, // 4 ซ้ำในไฟล์
    `D999,${be(y)},เช้า,10,รับ,`, // 5 ไม่พบสมาชิก
    `D001,${be(dayOffset(1))},เช้า,10,รับ,`, // 6 วันที่อนาคต
    `D002,${be(y)},เย็น,12,ไม่รับ,กลิ่น`, // 7 ok (ไม่รับ)
    `D003,${be(y)},เย็น,"1,250",รับ,`, // 8 ok
  ].join('\r\n');
  let preview; let batchCode;
  await t.test('preview: every row is checked before anything is saved', async () => {
    await call(COOP, 'POST', '/dairy/imports/preview', { kind: 'intake', filename: 'x.csv', content_base64: b64('ชื่อ,อายุ\nก,1\n') }, 400);
    await call(COOP, 'POST', '/dairy/imports/preview', { kind: 'intake', filename: 'x.xls', content_base64: b64('xx') }, 400);
    preview = await call(COOP, 'POST', '/dairy/imports/preview', { kind: 'intake', filename: 'รับนม.csv', content_base64: b64(`\uFEFF${csv}`) });
    assert.equal(preview.format, 'csv');
    assert.deepEqual(
      [preview.summary.row_count, preview.summary.ok_count, preview.summary.warning_count, preview.summary.error_count, preview.summary.duplicate_count],
      [7, 4, 0, 3, 0],
    );
    const by = Object.fromEntries(preview.rows.map((r) => [r.row_no, r.errors.map((e) => e.code)]));
    assert.deepEqual(by[4], ['duplicate_in_file']);
    assert.deepEqual(by[5], ['member_not_found']);
    assert.deepEqual(by[6], ['future_date']);
    assert.equal(preview.rows.find((r) => r.row_no === 8).values.weight_kg, 1250);
    assert.equal(preview.columns.weight_kg, 'น้ำหนัก (กก.)');
    const n = (await db.query('SELECT COUNT(*)::int AS n FROM dairy.milk_intake i JOIN dairy.milk_round r USING (round_id) WHERE r.coop_org_id=$1', [coopId])).rows[0].n;
    assert.equal(n, 0, 'preview writes nothing');
  });

  await t.test('commit: saves the good rows, creates and closes the rounds, which open a milk batch', async () => {
    const r = await call(COOP, 'POST', `/dairy/imports/${preview.import_id}/commit`, { close_rounds: true });
    assert.equal(r.counts.inserted, 4);
    assert.equal(r.counts.rounds_created, 2);
    assert.equal(r.counts.rounds_closed, 2);
    assert.equal(r.counts.skipped_error, 3);
    batchCode = r.rows.find((x) => x.row_no === 2).batch_code;
    assert.match(batchCode, /^MB-\d{6}-[0-9A-F]{6}-\d{2}$/);
    await call(COOP, 'POST', `/dairy/imports/${preview.import_id}/commit`, {}, 409);
    const rows = (await db.query(
      `SELECT i.source, i.import_id FROM dairy.milk_intake i JOIN dairy.milk_round r USING (round_id) WHERE r.coop_org_id=$1`, [coopId],
    )).rows;
    assert.equal(rows.length, 4);
    assert.ok(rows.every((x) => x.source === 'file' && x.import_id === preview.import_id));
    const list = await call(COOP, 'GET', '/dairy/milk-batches');
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'Collecting');
    assert.equal(list[0].rounds, 2);
    assert.equal(Number(list[0].accepted_kg), 1325);
    assert.equal(list[0].farm_count, 3);
    const hist = await call(COOP, 'GET', '/dairy/imports');
    assert.equal(hist[0].status, 'Committed');
    assert.equal(hist[0].result_counts.inserted, 4);
  });

  await t.test('importing the same file again: nothing new, and it says so', async () => {
    const again = await call(COOP, 'POST', '/dairy/imports/preview', { kind: 'intake', filename: 'รับนม.csv', content_base64: b64(`\uFEFF${csv}`) });
    assert.ok(again.same_file_committed_at);
    assert.equal(again.summary.duplicate_count, 4);
    assert.equal(again.summary.ok_count, 0);
    const changed = await call(COOP, 'POST', '/dairy/imports/preview', {
      kind: 'intake', filename: 'แก้.csv', content_base64: b64(`รหัสสมาชิก,วันที่,รอบ,น้ำหนัก\nD001,${be(y)},เช้า,44\n`),
    });
    assert.deepEqual(changed.rows[0].errors.map((e) => e.code), ['round_closed']);
    await call(COOP, 'POST', `/dairy/imports/${changed.import_id}/discard`, {});
    await call(COOP, 'POST', `/dairy/imports/${changed.import_id}/commit`, {}, 409);
  });

  await t.test('lab results from an Excel file: SCC in cells/ml is converted, antibiotic positive is flagged', async () => {
    const buf = xlsx([
      ['Member Code', 'วันที่เก็บตัวอย่าง', 'ไขมัน', 'SNF', 'SCC', 'ยาปฏิชีวนะ'],
      ['D001', be(y), 3.9, 8.7, 250000, 'ไม่พบ'],
      ['D002', be(y), 3.6, 8.4, 310, 'พบ'],
      ['D404', be(y), 3.6, 8.4, 310, 'ไม่พบ'],
    ]);
    const p = await call(COOP, 'POST', '/dairy/imports/preview', { kind: 'quality', filename: 'แล็บ.xlsx', content_base64: buf.toString('base64'), options: { lab_name: 'แล็บ อ.ส.ค.' } });
    assert.equal(p.format, 'xlsx');
    assert.deepEqual([p.summary.ok_count, p.summary.warning_count, p.summary.error_count], [0, 2, 1]);
    assert.equal(p.rows[0].values.scc_k, 250);
    const c = await call(COOP, 'POST', `/dairy/imports/${p.import_id}/commit`, {});
    assert.equal(c.counts.inserted, 2);
    const tests = (await db.query('SELECT source, lab_name, antibiotic_pos FROM dairy.quality_test WHERE coop_org_id=$1 ORDER BY antibiotic_pos', [coopId])).rows;
    assert.deepEqual(tests.map((x) => [x.source, x.lab_name, x.antibiotic_pos]), [['file', 'แล็บ อ.ส.ค.', false], ['file', 'แล็บ อ.ส.ค.', true]]);
  });

  let ship;
  await t.test('shipment from the centre closes the batch and links it; the factory sees the batch code', async () => {
    const from = new Date(Date.now() - 20 * 3600 * 1000);
    for (let i = 0; i < 6; i += 1) {
      await db.query('INSERT INTO dairy.iot_reading (device_id, recorded_at, temp_c) VALUES ($1,$2,$3)', [tank.device_id, new Date(from.getTime() + i * 3 * 3600 * 1000), i === 3 ? 7.5 : 3.8]);
    }
    ship = await call(COOP, 'POST', '/dairy/shipments', { contract_id: contract.contract_id, center_id: A.center_id, sent_kg: 1310, vehicle: 'รถถัง 82-1234', tank_temp_c: 4.2 });
    assert.equal(ship.batch_code, batchCode);
    const b = (await call(COOP, 'GET', `/dairy/milk-batches?q=${batchCode}`))[0];
    assert.equal(b.status, 'Shipped');
    assert.equal(Number(b.sent_diff_pct), -1.13);
    const ps = await call(FACTORY, 'GET', '/dairy-partner/shipments');
    assert.equal(ps.find((s) => s.shipment_id === ship.shipment_id).batch_code, batchCode);
  });

  await t.test('coop trace: farms by name, tank temperatures, checks, timeline', async () => {
    const tr = await call(COOP, 'GET', `/dairy/milk-batches/${batchCode.toLowerCase()}/trace`);
    assert.equal(tr.batch.status, 'Shipped');
    assert.equal(tr.farms.length, 3);
    const d1 = tr.farms.find((f) => f.member_code === 'D001');
    assert.equal(d1.full_name, 'นายหนึ่ง');
    assert.equal(d1.accepted_kg, 40);
    assert.equal(Number(d1.quality.scc_k), 250);
    const d2 = tr.farms.find((f) => f.member_code === 'D002');
    assert.equal(d2.rejected_kg, 12);
    assert.deepEqual(d2.reject_reasons, ['smell']);
    assert.equal(tr.tank[0].readings, 6);
    assert.equal(Number(tr.tank[0].max_c), 7.5);
    assert.equal(tr.tank[0].over_limit, 1);
    const codes = Object.fromEntries(tr.checks.map((c) => [c.code, c.level]));
    assert.equal(codes.sent_vs_collected, 'ok');
    assert.equal(codes.tank_sensor_over_limit, 'warning');
    assert.equal(codes.farm_antibiotic_positive, 'critical');
    assert.equal(codes.farm_without_quality_test, 'info');
    assert.deepEqual(tr.timeline.map((e) => e.event), ['round_closed', 'round_closed', 'shipped']);
    const mb = await call(COOP, 'GET', `/dairy/members/${M.D003.member_id}/milk-batches`);
    assert.equal(mb.batches[0].batch_code, batchCode);
    assert.equal(Number(mb.batches[0].member_kg), 1250);
  });

  await t.test('factory trace: farm codes and registrations, no names; other factories get 404', async () => {
    const tr = await call(FACTORY, 'GET', `/dairy-partner/trace/${batchCode}`);
    assert.ok(tr.farms.every((f) => f.full_name === undefined && f.member_id === undefined));
    assert.equal(tr.farms.find((f) => f.member_code === 'D001').farm_registration_no, 'FR-001');
    assert.equal(tr.shipment.shipment_id, undefined);
    await call(OTHER, 'GET', `/dairy-partner/trace/${batchCode}`, undefined, 404);
    await call(FACTORY, 'POST', `/dairy-partner/shipments/${ship.shipment_id}/receive`, { received_kg: 1240, fat_pct: 3.7 });
    const after = await call(FACTORY, 'GET', `/dairy-partner/trace/${batchCode}`);
    assert.equal(after.batch.status, 'Received');
    const chk = after.checks.find((c) => c.code === 'received_vs_sent');
    assert.equal(chk.level, 'warning');
    assert.equal(chk.diff_pct, -5.34);
    assert.equal(after.timeline[after.timeline.length - 1].event, 'factory_received');
  });

  await t.test('late round goes to the batch it physically left with; a new round starts a new batch', async () => {
    const late = await call(COOP, 'POST', '/dairy/rounds', { center_id: A.center_id, round_date: dayOffset(-2), shift: 'PM' });
    await call(COOP, 'POST', `/dairy/rounds/${late.round_id}/intakes`, { member_code: 'D001', weight_kg: 20 });
    const closed = await call(COOP, 'POST', `/dairy/rounds/${late.round_id}/close`, {});
    assert.equal(closed.batch_code, batchCode);
    const now = await call(COOP, 'POST', '/dairy/rounds', { center_id: A.center_id, round_date: today(), shift: 'AM' });
    await call(COOP, 'POST', `/dairy/rounds/${now.round_id}/intakes`, { member_code: 'D002', weight_kg: 30 });
    const c2 = await call(COOP, 'POST', `/dairy/rounds/${now.round_id}/close`, { tank_temp_c: 3.9 });
    assert.notEqual(c2.batch_code, batchCode);
    // ส่งแล้วยกเลิก → ล็อตกลับมารวบรวมต่อ
    const s2 = await call(COOP, 'POST', '/dairy/shipments', { contract_id: contract.contract_id, center_id: A.center_id, sent_kg: 30 });
    assert.equal(s2.batch_code, c2.batch_code);
    await call(COOP, 'POST', `/dairy/shipments/${s2.shipment_id}/cancel`, {});
    const b2 = (await call(COOP, 'GET', `/dairy/milk-batches?q=${c2.batch_code}`))[0];
    assert.equal(b2.status, 'Collecting');
    assert.equal(b2.sent_kg, null);
  });

  await t.test('data-quality dashboard counts sources and traced shipments', async () => {
    const dq = await call(COOP, 'GET', '/dairy/data-quality?days=30');
    const src = Object.fromEntries(dq.intake_by_source.map((r) => [r.source, r.records]));
    assert.equal(src.file, 4);
    assert.equal(src.manual, 2);
    assert.equal(dq.shipments.shipments, 1);
    assert.equal(dq.shipments.with_batch, 1);
    assert.equal(dq.recent_imports.length >= 3, true);
  });

  await t.test('government: only with the coop\'s data consent, and only farm registrations', async () => {
    await call(GOV, 'GET', `/dairy-gov/trace/${batchCode}`, undefined, 403);
    await call(COOP, 'PUT', '/dairy/settings', { gov_data_consent: true });
    const tr = await call(GOV, 'GET', `/dairy-gov/trace/${batchCode}`);
    assert.ok(tr.farms.every((f) => f.member_code === undefined && f.full_name === undefined));
    assert.deepEqual(tr.farms.map((f) => f.farm_registration_no).sort((a, b) => String(a).localeCompare(String(b))), ['FR-001', 'FR-002', null]);
    await call(GOV, 'GET', '/dairy-gov/trace/MB-000000-XXXXXX-01', undefined, 404);
    const dq = await call(GOV, 'GET', '/dairy-gov/data-quality');
    const mine = dq.coops.find((k) => k.org_name.includes(tag));
    assert.equal(mine.traced_pct, 100);
    assert.equal(mine.from_file, 4);
  });
});
