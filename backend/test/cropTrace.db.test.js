/*
 * End-to-end: ตรวจสอบย้อนกลับสายพืชผล — real HTTP API + real PostgreSQL (grant_crop_traceability.sql).
 * Same rules as dairy.db.test.js: only runs with DAIRY_DB_TEST=1 against a LOCAL database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ENABLED = process.env.DAIRY_DB_TEST === '1';
const host = process.env.PGHOST || '';
const LOCAL = !process.env.DATABASE_URL && (host.startsWith('/') || ['localhost', '127.0.0.1', '::1'].includes(host));
const SKIP = !ENABLED ? 'set DAIRY_DB_TEST=1 to run (local test database only)'
  : (!LOCAL ? 'refusing to run: PGHOST must be a local database (and DATABASE_URL unset)' : false);
const JWT_SECRET = `ct-test-${crypto.randomBytes(8).toString('hex')}`;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

test('crop traceability: farmer plot → delivery → lot → drying → milling → finished good → dispatch/shipment, backward + forward, public QR page without personal data', { skip: SKIP, timeout: 120000 }, async (t) => {
  // eslint-disable-next-line global-require
  const { Client } = require('pg');
  // eslint-disable-next-line global-require
  const jwt = require('jsonwebtoken');
  const db = new Client();
  await db.connect();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test', STORAGE_ROOT: path.join(os.tmpdir(), `ct-store-${port}`), PUBLIC_SITE_URL: 'https://trace.example' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  t.after(async () => { if (process.env.DAIRY_TEST_VERBOSE) console.log(log); srv.kill(); await db.end(); });
  for (let i = 0; i < 100 && !/listening on port/.test(log); i += 1) await sleep(100);
  assert.match(log, /listening on port/);
  const base = `http://127.0.0.1:${port}`;
  async function call(token, method, p, body, expect = 200) {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const txt = await res.text();
    let json; try { json = JSON.parse(txt); } catch { json = txt; }
    assert.equal(res.status, expect, `${method} ${p} → ${res.status} ${txt.slice(0, 400)}`);
    return json;
  }
  const tag = crypto.randomBytes(3).toString('hex');
  const coopOrg = async (name) => {
    const id = crypto.randomUUID();
    await db.query(`INSERT INTO identity.organization (org_id, org_type, org_name, tax_id, kyb_status, region_code) VALUES ($1,'Cooperative',$2,$3,'Verified','TH-32')`,
      [id, name, `T${Date.now()}${crypto.randomBytes(3).toString('hex')}`.slice(0, 20)]);
    await db.query(`INSERT INTO identity.subject_role (subject_type, subject_id, role_code) VALUES ('organization',$1,'org.admin')`, [id]);
    await db.query(`INSERT INTO identity.organization_role (org_id, role_type, status) VALUES ($1,'Cooperative','Verified')`, [id]);
    await db.query(`INSERT INTO registry.cooperative_profile (org_id, province_code) VALUES ($1,'SURIN')`, [id]);
    return { id, name, token: jwt.sign({ subjectType: 'organization', subjectId: id }, JWT_SECRET) };
  };
  const coop = await coopOrg(`สหกรณ์การเกษตรตรวจสอบย้อนกลับ ${tag} จำกัด`);
  const other = await coopOrg(`สหกรณ์อื่น ${tag} จำกัด`);
  const farmer = async (name, region, poly, area, crop, conf) => {
    const fid = crypto.randomUUID();
    await db.query(`INSERT INTO identity.farmer (farmer_id, national_id_hash, full_name, phone, region_code, trust_score, status, farmer_code) VALUES ($1,$2,$3,$4,$5,50,'active',$6)`,
      [fid, crypto.randomBytes(16).toString('hex'), name, `09${String(crypto.randomInt(1e8)).padStart(8, '0')}`, region, `FC${tag}${crypto.randomInt(1e5)}`]);
    const unit = (await db.query(`INSERT INTO registry.production_unit (owner_farmer_id, unit_type, gps_boundary, area_rai, commodity_code, season_id)
      VALUES ($1,'Plot', ST_GeomFromText($2,4326), $3, 'RICE_JASMINE', '2026/27') RETURNING unit_id`, [fid, poly, area])).rows[0].unit_id;
    await db.query(`INSERT INTO ai.plot_assessment (unit_id, as_of, risk_level, flags, result, assessed_by_type, predicted_crop, crop_confidence)
      VALUES ($1, current_date, 'low', '[]', '{}', 'platform', $2, $3)`, [unit, crop, conf]);
    return { fid, unit, name };
  };
  const f1 = await farmer(`นายสมหมาย ข้าวหอม${tag}`, 'TH-32', 'POLYGON((103.49 14.88,103.492 14.88,103.492 14.882,103.49 14.882,103.49 14.88))', 15, 'rice', 0.92);
  const f2 = await farmer(`นางสมใจ นาดี${tag}`, 'TH-33', 'POLYGON((103.6 14.9,103.602 14.9,103.602 14.902,103.6 14.902,103.6 14.9))', 8, 'fallow', 0.8);
  const lot = async (orgId, note) => (await db.query(`INSERT INTO produce.lot (buyer_org_id, commodity_code, quality_grade, lot_note) VALUES ($1,'RICE_JASMINE','A',$2) RETURNING lot_id, trace_code`, [orgId, note])).rows[0];
  const L1 = await lot(coop.id, `ล็อตข้าวหอมมะลิ ${tag}`);
  const L2 = await lot(coop.id, `ล็อตขายข้าวเปลือก ${tag}`);
  const deliver = (unit, lotId, ton, moist, at) => db.query(
    `INSERT INTO produce.delivery (unit_id, buyer_org_id, commodity_code, quantity_ton, unit_price, total_amount, quality_grade, status, moisture_pct, lot_id, delivered_at)
     VALUES ($1,$2,'RICE_JASMINE',$3,15000,$7,'A','accepted',$4,$5,$6)`, [unit, coop.id, ton, moist, lotId, at, ton * 15000]);
  await deliver(f1.unit, L1.lot_id, 3, 25, '2026-11-10T08:00:00+07:00');
  await deliver(f2.unit, L1.lot_id, 2, 24, '2026-11-11T08:00:00+07:00');
  await deliver(f1.unit, L2.lot_id, 1, 22, '2026-11-12T08:00:00+07:00');
  await db.query(`UPDATE produce.lot SET status = 'Closed', closed_at = now() WHERE lot_id = ANY($1)`, [[L1.lot_id, L2.lot_id]]);
  const fac = (await db.query(`INSERT INTO warehouse.facility (org_id, facility_name, facility_type) VALUES ($1,'ลานตากและโกดัง 1','Warehouse') RETURNING facility_id`, [coop.id])).rows[0].facility_id;
  const bin = (await db.query(`INSERT INTO warehouse.bin (facility_id, bin_code) VALUES ($1,'B-01') RETURNING bin_id`, [fac])).rows[0].bin_id;
  await db.query(`INSERT INTO warehouse.movement (lot_id, to_bin_id, movement_type, quantity_ton, moisture_pct, recorded_by) VALUES ($1,$2,'receive',5,24.6,'คลัง')`, [L1.lot_id, bin]);
  await db.query(`INSERT INTO warehouse.drying_reading (lot_id, bin_id, moisture_pct, recorded_by, recorded_at) VALUES ($1,$2,24.6,'คลัง','2026-11-12'), ($1,$2,14.5,'คลัง','2026-11-14')`, [L1.lot_id, bin]);
  const batch = (await db.query(`INSERT INTO processing.batch (org_id, facility_id, source_commodity_code, process_type, output_product_name, status, started_by, completed_by, completed_at)
    VALUES ($1,$2,'RICE_JASMINE','Milling','ข้าวสารหอมมะลิ 100%','Completed','โรงสี','โรงสี',now()) RETURNING batch_id, trace_code`, [coop.id, fac])).rows[0];
  await db.query(`INSERT INTO processing.batch_input (batch_id, lot_id, quantity_ton) VALUES ($1,$2,5)`, [batch.batch_id, L1.lot_id]);
  const FG = (await db.query(`INSERT INTO processing.finished_good (batch_id, product_name, quantity_ton, is_primary_product) VALUES ($1,'ข้าวสารหอมมะลิ 100% ถุง 5 กก.',3.2,true) RETURNING finished_good_id, trace_code`, [batch.batch_id])).rows[0];
  const BRAN = (await db.query(`INSERT INTO processing.finished_good (batch_id, product_name, quantity_ton, is_primary_product) VALUES ($1,'รำข้าว',0.5,false) RETURNING finished_good_id, trace_code`, [batch.batch_id])).rows[0];
  await db.query(`INSERT INTO processing.finished_good_dispatch (finished_good_id, quantity_ton, recorded_by, note) VALUES ($1,1,'คลัง','ขายหน้าร้านสหกรณ์')`, [FG.finished_good_id]);
  const carrier = (await db.query(`INSERT INTO logistics.carrier (org_id, carrier_name, carrier_type) VALUES ($1,'รถสหกรณ์','Internal') RETURNING carrier_id`, [coop.id])).rows[0].carrier_id;
  const ship = async (dest, item) => {
    const s = (await db.query(`INSERT INTO logistics.shipment (org_id, carrier_id, destination_name, status, created_by, dispatched_at) VALUES ($1,$2,$3,'InTransit','ขนส่ง',now()) RETURNING shipment_id`, [coop.id, carrier, dest])).rows[0].shipment_id;
    await db.query(`INSERT INTO logistics.shipment_item (shipment_id, item_type, lot_id, finished_good_id, quantity_ton, recorded_by) VALUES ($1,$2,$3,$4,$5,'ขนส่ง')`,
      [s, item.type, item.lot || null, item.fg || null, item.ton]);
  };
  await ship(`ห้างค้าปลีกปลายทาง ${tag}`, { type: 'FinishedGood', fg: FG.finished_good_id, ton: 1.5 });
  await ship(`โรงสีเอกชนปลายทาง ${tag}`, { type: 'Lot', lot: L2.lot_id, ton: 1 });

  await t.test('codes are assigned automatically and searchable', async () => {
    for (const x of [L1.trace_code, batch.trace_code, FG.trace_code]) assert.match(x, /^(LT|PB|FG)-[0-9A-HJKMNP-TV-Z]{8}$/);
    const s = await call(coop.token, 'GET', `/coop/trace/search?q=${encodeURIComponent(tag)}`);
    assert.ok(s.some((x) => x.code === L1.trace_code && x.type === 'lot' && x.quantity_ton === 5));
    assert.ok(s.some((x) => x.type === 'farmer' && x.code === f1.fid));
    const recent = await call(coop.token, 'GET', '/coop/trace/search');
    assert.ok(recent.some((x) => x.code === FG.trace_code));
  });

  await t.test('backward from a finished good: lots, deliveries, farmers, plots + satellite check, drying, milling; forward only that product', async () => {
    const tr = await call(coop.token, 'GET', `/coop/trace/code/${FG.trace_code.toLowerCase().replace(/0/g, 'o')}`); // พิมพ์เล็ก/สับสน O-0 ก็หาเจอ
    assert.equal(tr.start.code, FG.trace_code);
    assert.deepEqual(tr.lots.map((l) => [l.trace_code, l.quantity_ton, l.delivery_count]), [[L1.trace_code, 5, 2]]);
    assert.deepEqual(tr.lots[0].drying && [tr.lots[0].drying.readings, tr.lots[0].drying.last_moisture], [2, 14.5]);
    assert.equal(tr.lots[0].movements[0].to_bin, 'B-01');
    assert.deepEqual(tr.deliveries.map((d) => d.farmer_name).sort(), [f1.name, f2.name].sort());
    assert.ok(tr.deliveries.every((d) => d.lat > 14 && d.lon > 103));
    assert.deepEqual(tr.batches.map((b) => [b.trace_code, b.yield_pct]), [[batch.trace_code, 74]]);
    assert.deepEqual(tr.finished_goods.map((f) => f.trace_code), [FG.trace_code]);
    assert.deepEqual(tr.shipments.map((s) => s.destination), [`ห้างค้าปลีกปลายทาง ${tag}`]);
    assert.equal(tr.dispatches.length, 1);
    const s = tr.summary;
    assert.deepEqual([s.farmers, s.plots, s.area_rai, s.plots_confirmed, s.plots_mismatch, s.raw_ton, s.final_moisture], [2, 2, 23, 1, 1, 5, 14.5]);
    assert.deepEqual(s.provinces.sort(), ['ศรีสะเกษ', 'สุรินทร์'].sort());
  });

  await t.test('forward from a lot and from a farmer (recall): every product and shipment their rice went into', async () => {
    const fl = await call(coop.token, 'GET', `/coop/trace/code/${L1.trace_code}`);
    assert.deepEqual(fl.finished_goods.map((f) => f.trace_code).sort(), [FG.trace_code, BRAN.trace_code].sort());
    assert.ok(!fl.shipments.some((x) => /โรงสีเอกชน/.test(x.destination)));
    const ff = await call(coop.token, 'GET', `/coop/trace/farmer/${f1.fid}`);
    assert.equal(ff.farmer.full_name, f1.name);
    assert.deepEqual(ff.lots.map((l) => l.trace_code).sort(), [L1.trace_code, L2.trace_code].sort());
    assert.ok(ff.deliveries.every((d) => d.farmer_id === f1.fid));
    assert.deepEqual(ff.shipments.map((x) => x.destination).sort(), [`ห้างค้าปลีกปลายทาง ${tag}`, `โรงสีเอกชนปลายทาง ${tag}`].sort());
    assert.equal(ff.summary.raw_ton, 4);
    // สหกรณ์อื่นดูไม่ได้
    await call(other.token, 'GET', `/coop/trace/code/${FG.trace_code}`, undefined, 404);
    await call(other.token, 'GET', `/coop/trace/farmer/${f1.fid}`);
    assert.equal((await call(other.token, 'GET', `/coop/trace/farmer/${f1.fid}`)).empty, true);
    await call(coop.token, 'GET', '/coop/trace/code/FG-XXXX', undefined, 404);
  });

  await t.test('public page (no login): anonymised origin + steps, QR, scan counter, can be switched off; batches never public', async () => {
    const p = await call(null, 'GET', `/public/trace/${FG.trace_code}`);
    assert.equal(p.product, 'ข้าวสารหอมมะลิ 100% ถุง 5 กก.');
    assert.equal(p.cooperative.name, coop.name);
    assert.deepEqual([p.origin.farmers, p.origin.plots, p.origin.plots_confirmed], [2, 2, 1]);
    assert.equal(p.url, `https://trace.example/trace.html?c=${FG.trace_code}`);
    assert.ok(p.steps.some((s) => s.step === 'process' && /สี\/โม่/.test(s.title)));
    const raw = JSON.stringify(p);
    for (const secret of [f1.name, f2.name, 'farmer_name', 'farmer_code', '"lat"', '"lon"', 'ห้างค้าปลีก', f1.fid]) assert.ok(!raw.includes(secret), `public page leaks ${secret}`);
    const qr = await fetch(`${base}/public/trace/${FG.trace_code}/qr.svg`);
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /svg/);
    assert.match(await qr.text(), /^<svg/);
    await call(null, 'GET', `/public/trace/${batch.trace_code}`, undefined, 404);
    await call(null, 'GET', `/public/trace/${L2.trace_code}`); // ล็อตเปิดหน้าสาธารณะได้เช่นกัน
    assert.equal((await call(coop.token, 'GET', `/coop/trace/code/${FG.trace_code}`)).scans[FG.trace_code], 1);
    await call(coop.token, 'POST', `/coop/trace/code/${FG.trace_code}/public`, { public_trace: false });
    await call(null, 'GET', `/public/trace/${FG.trace_code}`, undefined, 404);
    await call(null, 'GET', `/public/trace/${FG.trace_code}/qr.svg`, undefined, 404);
    await call(other.token, 'POST', `/coop/trace/code/${FG.trace_code}/public`, { public_trace: true }, 404);
    await call(coop.token, 'POST', `/coop/trace/code/${FG.trace_code}/public`, { public_trace: true });
    await call(null, 'GET', `/public/trace/${FG.trace_code}`);
  });

  await t.test('certificate of origin: issue (closed lot / completed batch only) → PDF + public verification, hash chain, immutable, live change check, revoke', async () => {
    await call(coop.token, 'POST', `/coop/trace/code/${batch.trace_code}/certificate`, {}, 400);
    const L3 = await lot(coop.id, `ล็อตยังไม่ปิด ${tag}`);
    assert.equal((await call(coop.token, 'POST', `/coop/trace/code/${L3.trace_code}/certificate`, {}, 409)).error, 'lot_not_closed');
    await call(other.token, 'POST', `/coop/trace/code/${FG.trace_code}/certificate`, {}, 404);
    const c1 = await call(coop.token, 'POST', `/coop/trace/code/${FG.trace_code}/certificate`, {}, 201);
    assert.match(c1.cert_no, /^OC-[0-9A-HJKMNP-TV-Z]{8}$/);
    assert.equal(c1.verify_url, `https://trace.example/certificate.html?no=${c1.cert_no}`);
    const v = await call(null, 'GET', `/public/certificate/${c1.cert_no.toLowerCase()}`);
    assert.equal(v.status, 'Issued');
    assert.equal(v.hash_ok, true);
    assert.deepEqual(v.changed_since_issue, []);
    const core = v.payload.core;
    assert.deepEqual([core.origin.farmers, core.origin.plots, core.origin.area_rai, core.origin.plots_satellite_confirmed, core.subject.quantity_ton], [2, 2, 23, 1, 3.2]);
    assert.equal(core.chain.plot_fingerprints.length, 2);
    assert.ok(core.chain.plot_fingerprints.every((x) => /^[0-9a-f]{64}$/.test(x)));
    const raw = JSON.stringify(v);
    for (const secret of [f1.name, f2.name, f1.fid, f1.unit, '103.49', 'ห้างค้าปลีก']) assert.ok(!raw.includes(secret), `certificate leaks ${secret}`);
    const pdf = await fetch(`${base}/public/certificate/${c1.cert_no}/pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.equal((await fetch(`${base}/coop/trace/certificates/${c1.cert_no}/pdf`, { headers: { Authorization: `Bearer ${coop.token}` } })).status, 200);
    assert.ok((await call(null, 'GET', `/public/trace/${FG.trace_code}`)).certificates.some((x) => x.cert_no === c1.cert_no));
    // ใบถัดไปของสหกรณ์เดียวกันต่อสายแฮชจากใบก่อน
    const c2 = await call(coop.token, 'POST', `/coop/trace/code/${L1.trace_code}/certificate`, {}, 201);
    assert.equal(c2.prev_sha256, c1.payload_sha256);
    assert.deepEqual((await call(coop.token, 'GET', `/coop/trace/code/${L1.trace_code}/certificates`)).map((x) => x.cert_no), [c2.cert_no]);
    // แก้ข้อมูลที่รับรองแล้วในฐานข้อมูลไม่ได้
    await assert.rejects(db.query(`UPDATE traceability.origin_certificate SET payload = payload || '{"x":1}' WHERE cert_no = $1`, [c1.cert_no]), /immutable/);
    // ข้อมูลสายการผลิตเปลี่ยนหลังออกใบ → หน้าตรวจสอบบอกว่าเปลี่ยนอะไร
    await deliver(f2.unit, L1.lot_id, 0.5, 20, '2026-11-12T09:00:00+07:00');
    const v2 = await call(null, 'GET', `/public/certificate/${c2.cert_no}`);
    assert.equal(v2.hash_ok, true);
    assert.ok(v2.changed_since_issue.some((x) => x.field === 'origin.raw_ton'), JSON.stringify(v2.changed_since_issue));
    // ยกเลิก
    await call(coop.token, 'POST', `/coop/trace/certificates/${c2.cert_no}/revoke`, { reason: 'สั้น' }, 400);
    await call(other.token, 'POST', `/coop/trace/certificates/${c2.cert_no}/revoke`, { reason: 'ไม่ใช่ของเรา ลองยกเลิก' }, 404);
    const rv = await call(coop.token, 'POST', `/coop/trace/certificates/${c2.cert_no}/revoke`, { reason: 'ผลผลิตบางส่วนบันทึกผิดล็อต ออกใบใหม่แทน' });
    assert.equal(rv.status, 'Revoked');
    assert.equal((await call(null, 'GET', `/public/certificate/${c2.cert_no}`)).status, 'Revoked');
    await call(coop.token, 'POST', `/coop/trace/certificates/${c2.cert_no}/revoke`, { reason: 'ยกเลิกซ้ำอีกครั้ง' }, 404);
    await assert.rejects(db.query(`UPDATE traceability.origin_certificate SET status = 'Issued', revoked_at = NULL WHERE cert_no = $1`, [c2.cert_no]), /reinstated|check/);
    await call(null, 'GET', '/public/certificate/OC-ZZZZZZZZ', undefined, 404);
  });
});
