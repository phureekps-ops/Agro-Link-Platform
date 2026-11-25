/*
 * End-to-end: สินเชื่อระหว่างสหกรณ์ — real HTTP API + real PostgreSQL (grant_coop_lending.sql).
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
const JWT_SECRET = `cl-test-${crypto.randomBytes(8).toString('hex')}`;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
// 1x1 PNG; a random tail byte keeps each upload's sha256 unique
const png = () => Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), crypto.randomBytes(8)]).toString('base64');

test('crop plan: staged production loan, stage checks with satellite, hold/resume; CPD dashboard scoped by province', { skip: SKIP, timeout: 120000 }, async (t) => {
  // eslint-disable-next-line global-require
  const { Client } = require('pg');
  // eslint-disable-next-line global-require
  const jwt = require('jsonwebtoken');
  const db = new Client();
  await db.connect();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test', STORAGE_ROOT: path.join(os.tmpdir(), `cl-store-${port}`) },
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
    const res = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const txt = await res.text();
    let json; try { json = JSON.parse(txt); } catch { json = txt; }
    assert.equal(res.status, expect, `${method} ${p} → ${res.status} ${txt.slice(0, 400)}`);
    return json;
  }
  const tag = crypto.randomBytes(3).toString('hex');
  const sign = (subjectType, subjectId) => jwt.sign({ subjectType, subjectId }, JWT_SECRET);
  const org = async (type, name) => {
    const id = crypto.randomUUID();
    await db.query(`INSERT INTO identity.organization (org_id, org_type, org_name, tax_id, kyb_status, region_code) VALUES ($1,$2,$3,$4,'Verified','TH-40')`,
      [id, type, name, `P${Date.now()}${crypto.randomBytes(3).toString('hex')}`.slice(0, 20)]);
    await db.query(`INSERT INTO identity.subject_role (subject_type, subject_id, role_code) VALUES ('organization',$1,'org.admin')`, [id]);
    return { id, name, token: sign('organization', id) };
  };
  const savings = await org('SavingsCooperative', `สหกรณ์ออมทรัพย์แผนผลิต ${tag} จำกัด`);
  const coop = await org('Cooperative', `สหกรณ์การเกษตรแผนผลิต ${tag} จำกัด`);
  const supplier = await org('InputSupplier', `ร้านเมล็ดพันธุ์ ${tag}`);
  await db.query(`INSERT INTO registry.cooperative_profile (org_id, province_code, cooperative_registration_no) VALUES ($1,'UBON_RATCHATHANI',$2)
                  ON CONFLICT (org_id) DO UPDATE SET province_code = EXCLUDED.province_code`, [coop.id, `REG${tag}`]);
  const S2 = sign('organization_member', (await db.query('SELECT identity.register_staff_member($1,$2,$3,$4,$5,$6) AS id',
    [savings.id, 'ผู้อนุมัติ', crypto.randomBytes(16).toString('hex'), `oidc|s-${crypto.randomUUID()}`, 'coop.credit_officer', 'test'])).rows[0].id);
  const officer = async (scope, province) => sign('government_officer', (await db.query('SELECT identity.register_government_officer($1,$2,$3,$4,$5,$6,$7,$8) AS id',
    [`เจ้าหน้าที่ ${scope}`, crypto.randomBytes(16).toString('hex'), scope, province, `oidc|g-${crypto.randomUUID()}`, scope === 'National' ? 'gov.national_admin' : 'gov.provincial_admin', 'CPD', 'test'])).rows[0].id);
  const NAT = await officer('National', null);
  const KKN = await officer('Province', 'KHON_KAEN');
  const UBN = await officer('Province', 'UBON_RATCHATHANI');

  const farmerId = crypto.randomUUID();
  await db.query(`INSERT INTO identity.farmer (farmer_id, national_id_hash, full_name, phone, region_code, trust_score, status, farmer_code)
                  VALUES ($1,$2,$3,$4,'TH-30',50,'active',$5)`, [farmerId, crypto.randomBytes(16).toString('hex'), `มานี ทดสอบ${tag}`, `09${Date.now() % 1e8}`.padEnd(10, '0').slice(0, 10), `P${tag}${Date.now() % 1e6}`]);
  await db.query(`INSERT INTO identity.subject_role (subject_type, subject_id, role_code) VALUES ('farmer',$1,'farmer.self') ON CONFLICT DO NOTHING`, [farmerId]).catch(() => {});
  await db.query("SELECT identity.link_farmer_to_org($1,$2,'organization',$2,'test')", [farmerId, coop.id]);
  const F = sign('farmer', farmerId);
  const plot = async (crop) => (await db.query(
    `INSERT INTO registry.production_unit (owner_farmer_id, unit_type, gps_boundary, area_rai, commodity_code, season_id)
     VALUES ($1,'Plot', ST_GeomFromText('POLYGON((102.1 14.9,102.101 14.9,102.101 14.901,102.1 14.901,102.1 14.9))',4326), 12, $2, '2026/27') RETURNING unit_id`, [farmerId, crop],
  )).rows[0].unit_id;
  const unitId = await plot('RICE_JASMINE');
  const upload = async (token) => (await call(token, 'POST', '/storage/upload', {
    purpose: 'coop_lending_evidence', filename: 'p.png', content_type: 'image/png', file_base64: png(), uploaded_by: 'test',
  }, 201)).file_id;

  let facility; let plan;
  const planting = (await db.query("SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok')::date - 25, 'YYYY-MM-DD') AS d")).rows[0].d;
  await t.test('plan is created from the crop template, reserves the facility and waits for the savings coop', async () => {
    const program = await call(savings.token, 'POST', '/savings/programs', {
      name: 'สินเชื่อการผลิตข้าวหอมมะลิ', purposes: ['inputs', 'machinery_service'], total_limit: 1000000, per_borrower_limit: 500000, per_farmer_limit: 100000, rate_pct: 4,
    }, 201);
    const app = await call(coop.token, 'POST', '/coop-lending/applications', { program_id: program.program_id, requested_amount: 300000, member_count: 40 }, 201);
    facility = await call(S2, 'POST', `/savings/applications/${app.application_id}/approve`, { limit_amount: 300000 }, 201);
    const tpl = await call(coop.token, 'GET', '/coop-lending/crop-templates');
    assert.equal(tpl.stages.length, 6);
    const pv = await call(coop.token, 'POST', '/coop-lending/crop-plans/preview', { unit_id: unitId, planting_date: planting, total_amount: 60000 });
    assert.equal(pv.stages.length, 6);
    assert.equal(L2(pv.stages.reduce((s, x) => s + x.planned_amount, 0)), 60000);
    assert.equal(pv.per_rai, 5000);
    const cassava = await plot('DURIAN');
    assert.equal((await call(coop.token, 'POST', '/coop-lending/crop-plans/preview', { unit_id: cassava, planting_date: planting, total_amount: 60000 }, 400)).error, 'crop_not_supported');
    await call(coop.token, 'POST', '/coop-lending/crop-plans', { facility_id: facility.facility_id, unit_id: unitId, season_label: 'นาปี 2569', planting_date: planting, total_amount: 150000 }, 409); // per-farmer cap
    plan = await call(coop.token, 'POST', '/coop-lending/crop-plans', { facility_id: facility.facility_id, unit_id: unitId, season_label: 'นาปี 2569', planting_date: planting, total_amount: 60000 }, 201);
    assert.equal(plan.status, 'Submitted');
    await call(coop.token, 'POST', '/coop-lending/crop-plans', { facility_id: facility.facility_id, unit_id: unitId, season_label: 'ซ้ำ', planting_date: planting, total_amount: 1000 }, 409); // one open plan per plot
    const fac = (await call(coop.token, 'GET', '/coop-lending/facilities')).find((f) => f.facility_id === facility.facility_id);
    assert.equal(Number(fac.available), 240000);
    await call(coop.token, 'POST', '/coop-lending/items', { facility_id: facility.facility_id, plan_id: plan.plan_id, purpose: 'inputs', source_type: 'manual', seller_type: 'organization', seller_id: supplier.id, amount: 5000, description: 'เมล็ดพันธุ์' }, 409);
  });

  await t.test('approval opens stage 1; items are capped by the stage; next stage stays locked', async () => {
    await call(savings.token, 'POST', `/savings/crop-plans/${plan.plan_id}/approve`, {});
    const p = (await call(savings.token, 'GET', '/savings/crop-plans')).find((x) => x.plan_id === plan.plan_id);
    assert.equal(p.status, 'Active');
    assert.deepEqual(p.stages.map((s) => s.status), ['Open', 'Locked', 'Locked', 'Locked', 'Locked', 'Locked']);
    const s1 = Number(p.stages[0].planned_amount);
    assert.equal(s1, 9000);
    const it = await call(coop.token, 'POST', '/coop-lending/items', {
      facility_id: facility.facility_id, plan_id: plan.plan_id, purpose: 'inputs', source_type: 'manual', seller_type: 'organization', seller_id: supplier.id, amount: 6000, description: 'ปูนมาร์ลปรับปรุงดิน',
    }, 201);
    assert.equal(it.stage_seq, 1);
    assert.deepEqual(it.unit_ids || [unitId], [unitId]);
    assert.equal((await call(coop.token, 'POST', '/coop-lending/items', {
      facility_id: facility.facility_id, plan_id: plan.plan_id, purpose: 'inputs', source_type: 'manual', seller_type: 'organization', seller_id: supplier.id, amount: 3001, description: 'เกิน',
    }, 409)).error, 'over_stage_amount');
    assert.equal((await call(coop.token, 'POST', `/coop-lending/crop-plans/${plan.plan_id}/stages/2/check`, { file_id: await upload(coop.token) }, 409)).error, 'stage_not_open');
    const items = await call(coop.token, 'GET', '/coop-lending/items');
    assert.equal(items.find((x) => x.item_id === it.item_id).stage_name, 'เตรียมพื้นที่และปรับปรุงดิน');
  });

  await t.test('stage check → savings coop passes → next stage opens; satellite review needs a reason', async () => {
    const f1 = await upload(coop.token);
    const c1 = await call(coop.token, 'POST', `/coop-lending/crop-plans/${plan.plan_id}/stages/1/check`, { file_id: f1, note: 'ไถเตรียมดินแล้ว' });
    assert.equal(c1.status, 'CheckSubmitted');
    assert.equal(c1.satellite_result, 'na');
    await call(coop.token, 'POST', `/coop-lending/crop-plans/${plan.plan_id}/stages/1/check`, { file_id: f1 }, 409); // already submitted
    const notes = await call(savings.token, 'GET', '/savings/notices');
    assert.ok(notes.some((n) => n.kind === 'stage_check_waiting'));
    const r = await call(savings.token, 'POST', `/savings/crop-plans/${plan.plan_id}/stages/1/pass`, { note: 'ภาพตรงแปลง' });
    assert.equal(r.opened.seq, 2);
    await call(savings.token, 'POST', `/savings/crop-plans/${plan.plan_id}/stages/2/check`, {}, 404); // savings can't submit checks
    // stage 2 (seed/inputs): pass; stage 3 (planting) uses the satellite
    await call(coop.token, 'POST', `/coop-lending/crop-plans/${plan.plan_id}/stages/2/check`, { file_id: await upload(coop.token) });
    await call(savings.token, 'POST', `/savings/crop-plans/${plan.plan_id}/stages/2/pass`, {});
    await db.query(`INSERT INTO ai.plot_assessment (unit_id, as_of, risk_level, flags, result, assessed_by_type, season_status)
                    VALUES ($1, (now() AT TIME ZONE 'Asia/Bangkok')::date, 'medium', $2, '{}', 'platform', 'no_season')`, [unitId, JSON.stringify([{ code: 'CROP_MISMATCH', severity: 'medium', message_th: 'พืชที่ตรวจพบไม่ตรงกับที่แจ้ง' }])]);
    const c3 = await call(coop.token, 'POST', `/coop-lending/crop-plans/${plan.plan_id}/stages/3/check`, { file_id: await upload(coop.token) });
    assert.equal(c3.satellite_result, 'review');
    assert.equal((await call(savings.token, 'POST', `/savings/crop-plans/${plan.plan_id}/stages/3/pass`, {}, 400)).error, 'satellite_review_needs_reason');
  });

  await t.test('hold suspends the whole plan, blocks new items and transfers; resume reopens the stage', async () => {
    await call(savings.token, 'POST', `/savings/crop-plans/${plan.plan_id}/stages/3/hold`, { note: 'ขอภาพแปลงเพิ่ม' });
    const p = (await call(coop.token, 'GET', '/coop-lending/crop-plans')).find((x) => x.plan_id === plan.plan_id);
    assert.equal(p.status, 'Suspended');
    assert.equal(p.stages[2].status, 'Held');
    assert.ok((await call(coop.token, 'GET', '/coop-lending/notices')).some((n) => n.kind === 'plan_held'));
    await call(coop.token, 'POST', '/coop-lending/items', {
      facility_id: facility.facility_id, plan_id: plan.plan_id, purpose: 'inputs', source_type: 'manual', seller_type: 'organization', seller_id: supplier.id, amount: 100, description: 'ระหว่างระงับ',
    }, 409);
    await call(savings.token, 'POST', `/savings/crop-plans/${plan.plan_id}/resume`, {});
    const q = (await call(coop.token, 'GET', '/coop-lending/crop-plans')).find((x) => x.plan_id === plan.plan_id);
    assert.equal(q.status, 'Active');
    assert.equal(q.stages[2].status, 'Open');
    const mine = await call(F, 'GET', '/farmer-lending/plans');
    assert.equal(mine[0].plan_id, plan.plan_id);
    assert.equal(mine[0].stages.length, 6);
  });

  await t.test('CPD dashboard: national sees all, provincial sees only its province, CSV export, others refused', async () => {
    const all = await call(NAT, 'GET', '/gov/coop-lending/overview');
    assert.ok(all.facilities.some((f) => f.facility_id === facility.facility_id));
    assert.ok(all.provinces.some((p) => p.province_code === 'UBON_RATCHATHANI'));
    assert.ok(all.plans.some((p) => p.status === 'Active'));
    assert.ok(all.stages.some((s) => s.seq === 1 && s.passed >= 1));
    assert.ok(all.alerts.some((a) => a.action === 'plan_held'));
    const ubn = await call(UBN, 'GET', '/gov/coop-lending/overview');
    assert.equal(ubn.province, 'UBON_RATCHATHANI');
    assert.ok(ubn.facilities.some((f) => f.facility_id === facility.facility_id));
    const kkn = await call(KKN, 'GET', '/gov/coop-lending/overview?province=UBON_RATCHATHANI'); // cannot widen its own scope
    assert.equal(kkn.province, 'KHON_KAEN');
    assert.ok(!kkn.facilities.some((f) => f.facility_id === facility.facility_id));
    const filtered = await call(NAT, 'GET', '/gov/coop-lending/overview?province=KHON_KAEN');
    assert.ok(!filtered.facilities.some((f) => f.facility_id === facility.facility_id));
    const res = await fetch(`${base}/gov/coop-lending/transactions.csv`, { headers: { Authorization: `Bearer ${UBN}` } });
    assert.equal(res.status, 200);
    const csv = await res.text();
    assert.match(csv, /^\uFEFF?created,lender,borrower/);
    assert.match(csv, /ปูนมาร์ลปรับปรุงดิน/);
    assert.match(csv, /เตรียมพื้นที่และปรับปรุงดิน/);
    await call(coop.token, 'GET', '/gov/coop-lending/overview', undefined, 403);
    await call(savings.token, 'GET', '/gov/coop-lending/overview', undefined, 403);
  });
});

function L2(v) { return Math.round(v * 100) / 100; }
