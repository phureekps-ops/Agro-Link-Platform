/*
 * End-to-end test of the milk-centre gateway API through the real HTTP API and a real
 * PostgreSQL database: gateway + channels in the coop portal → config → events batch
 * (intake / reading / analysis / heartbeat) → duplicates, permanent errors, round by
 * measured time, closed rounds, analyzer results used for pricing, offline alerts, key rotation.
 *
 * Same rules as dairy.db.test.js: only runs with DAIRY_DB_TEST=1 against a LOCAL database
 * with every SQL file applied, including grant_dairy_iot_gateway.sql.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ENABLED = process.env.DAIRY_DB_TEST === '1';
const host = process.env.PGHOST || '';
const LOCAL = !process.env.DATABASE_URL && (host.startsWith('/') || ['localhost', '127.0.0.1', '::1'].includes(host));
const SKIP = !ENABLED ? 'set DAIRY_DB_TEST=1 to run (local test database only)'
  : (!LOCAL ? 'refusing to run: PGHOST must be a local database (and DATABASE_URL unset)' : false);

const JWT_SECRET = `gw-test-${crypto.randomBytes(8).toString('hex')}`;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const bkk = (d) => new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const eid = () => `t_${crypto.randomBytes(12).toString('hex')}`;

test('milk-centre gateway: config → events → duplicates → errors → pricing → offline (database)', { skip: SKIP, timeout: 120000 }, async (t) => {
  // eslint-disable-next-line global-require
  const { Client } = require('pg');
  // eslint-disable-next-line global-require
  const jwt = require('jsonwebtoken');
  // eslint-disable-next-line global-require
  const G = require('../src/lib/dairyIot');
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
    const headers = { 'Content-Type': 'application/json', ...(auth.startsWith('dk_') ? { 'X-Device-Key': auth } : { Authorization: `Bearer ${auth}` }) };
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    assert.equal(res.status, expectStatus, `${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
    return json;
  }

  const tag = crypto.randomBytes(4).toString('hex');
  const coopId = crypto.randomUUID();
  await db.query(`INSERT INTO identity.organization (org_id, org_type, org_name, tax_id, kyb_status) VALUES ($1,'Cooperative',$2,$3,'Verified')`,
    [coopId, `สหกรณ์ทดสอบ gateway ${tag}`, `G${Date.now()}${tag}`.slice(0, 20)]);
  await db.query(`INSERT INTO identity.organization_role (org_id, role_type, status) VALUES ($1,'Cooperative','Verified')`, [coopId]);
  await db.query(`INSERT INTO identity.subject_role (subject_type, subject_id, role_code) VALUES ('organization',$1,'org.admin')`, [coopId]);
  const COOP = jwt.sign({ subjectType: 'organization', subjectId: coopId }, JWT_SECRET);

  let center; let KEY; let gw; const M = {};
  await t.test('coop portal: gateway with a key, channels without keys', async () => {
    await call(COOP, 'GET', '/dairy/overview');
    await call(COOP, 'PUT', '/dairy/settings', { base_price_per_kg: 19 });
    await call(COOP, 'POST', '/dairy/quality-rules', { param: 'fat', min_value: 3.8, adjust_per_kg: 0.4 });
    center = await call(COOP, 'POST', '/dairy/centers', { name: `ศูนย์ ${tag}`, tank_capacity_kg: 3000 });
    for (const [code, name] of [['G001', 'สมชาย'], ['G002', 'สมศรี']]) {
      M[code] = await call(COOP, 'POST', '/dairy/members', { full_name: name, member_code: code, center_id: center.center_id });
      await call(COOP, 'POST', `/dairy/members/${M[code].member_id}/status`, { status: 'Approved' });
    }
    await call(COOP, 'POST', '/dairy/iot/devices', { name: 'gw', device_type: 'gateway' }, 400); // needs a centre
    gw = await call(COOP, 'POST', '/dairy/iot/devices', { name: `Gateway ${tag}`, device_type: 'gateway', center_id: center.center_id });
    assert.match(gw.api_key, /^dk_[0-9a-f]{48}$/);
    assert.equal(gw.offline_after_min, 10);
    KEY = gw.api_key;
    const scale = await call(COOP, 'POST', '/dairy/iot/devices', { name: 'เครื่องชั่ง 1', device_type: 'milk_scale', gateway_id: gw.device_id, channel: 'scale1' });
    assert.equal(scale.api_key, undefined, 'a channel has no key of its own');
    assert.equal(scale.center_id, center.center_id);
    await call(COOP, 'POST', '/dairy/iot/devices', { name: 'ถังเย็น 1', device_type: 'cooling_tank', gateway_id: gw.device_id, channel: 'tank1', temp_max: 6 });
    await call(COOP, 'POST', '/dairy/iot/devices', { name: 'เครื่องวิเคราะห์', device_type: 'milk_analyzer', gateway_id: gw.device_id, channel: 'analyzer1' });
    await call(COOP, 'POST', '/dairy/iot/devices', { name: 'ซ้ำ', device_type: 'milk_scale', gateway_id: gw.device_id, channel: 'scale1' }, 409);
    await call(COOP, 'POST', '/dairy/iot/devices', { name: 'ผิด', device_type: 'vehicle', gateway_id: gw.device_id, channel: 'car1' }, 400);
    await call(COOP, 'POST', '/dairy/iot/devices', { name: 'ผิด', device_type: 'milk_scale', gateway_id: gw.device_id, channel: 'Scale 2' }, 400);
  });

  await t.test('gateway config: centre, channels, members (offline copy)', async () => {
    const cfg = await call(KEY, 'GET', '/dairy-iot/gateway/config');
    assert.equal(cfg.center.name, center.name);
    assert.deepEqual(cfg.channels.map((c) => c.channel), ['analyzer1', 'scale1', 'tank1']);
    assert.deepEqual(cfg.members.map((m) => m.member_code), ['G001', 'G002']);
    await call('dk_' + '0'.repeat(48), 'GET', '/dairy-iot/gateway/config', undefined, 401);
    // a channel's key does not exist; an ordinary device key is not a gateway
    const scaleOld = await call(COOP, 'POST', '/dairy/iot/devices', { name: 'เครื่องชั่งเดี่ยว', device_type: 'milk_scale', center_id: center.center_id });
    await call(scaleOld.api_key, 'GET', '/dairy-iot/gateway/config', undefined, 403);
  });

  const now = new Date();
  const ev = (type, x) => ({ id: eid(), type, at: new Date().toISOString(), ...x });
  let first;
  await t.test('intake: same event twice is stored once; cans add up; errors are permanent', async () => {
    first = ev('intake', { channel: 'scale1', member_code: 'G001', weight_kg: 20.5 });
    const can2 = ev('intake', { channel: 'scale1', member_code: 'G001', weight_kg: 14 });
    const bad1 = ev('intake', { channel: 'scale1', member_code: 'NOPE', weight_kg: 10 });
    const bad2 = ev('intake', { channel: 'scale9', member_code: 'G001', weight_kg: 10 });
    const bad3 = ev('intake', { channel: 'tank1', member_code: 'G001', weight_kg: 10 });
    const r = await call(KEY, 'POST', '/dairy-iot/gateway/events', { gateway: { version: '1.0.0', queue: 5 }, events: [first, can2, bad1, bad2, bad3, { id: 'x' }] });
    assert.deepEqual(r.results.map((x) => x.status), ['ok', 'ok', 'error', 'error', 'error', 'error']);
    assert.deepEqual(r.results.slice(2).map((x) => x.error), ['member_not_found', 'channel_not_found', 'channel_type_mismatch', 'invalid_event_id']);
    assert.equal(r.results[1].data.member_total_kg, 34.5);
    assert.equal(r.results[0].data.shift, now.getUTCHours() + 7 >= 12 && now.getUTCHours() + 7 < 24 ? 'PM' : 'AM');
    // the gateway did not get our answer and sends the same batch again
    const again = await call(KEY, 'POST', '/dairy-iot/gateway/events', { events: [first, can2, bad1] });
    assert.deepEqual(again.results.map((x) => x.status), ['duplicate', 'duplicate', 'duplicate']);
    assert.equal(again.results[0].ok, true);
    assert.equal(again.results[2].ok, false);
    assert.equal(again.results[2].error, 'member_not_found');
    const rows = (await db.query(`SELECT weight_kg, source FROM dairy.milk_intake WHERE member_id=$1`, [M.G001.member_id])).rows;
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].weight_kg), 34.5);
    assert.equal(rows[0].source, 'gateway');
    const g = (await db.query('SELECT gateway_info, last_seen_at FROM dairy.iot_device WHERE device_id=$1', [gw.device_id])).rows[0];
    assert.equal(g.gateway_info.version, '1.0.0');
    assert.ok(g.last_seen_at);
  });

  await t.test('buffered data goes to the round of the time it was weighed; closed rounds refuse', async () => {
    const y = new Date(Date.now() - 86400000);
    const yPm = new Date(`${bkk(y)}T18:30:00+07:00`);
    const late = await call(KEY, 'POST', '/dairy-iot/gateway/events', { events: [ev('intake', { channel: 'scale1', member_code: 'G002', weight_kg: 11, at: yPm.toISOString() })] });
    assert.equal(late.results[0].status, 'ok');
    assert.equal(late.results[0].data.round_date, bkk(y));
    assert.equal(late.results[0].data.shift, 'PM');
    const round = (await db.query(`SELECT round_id FROM dairy.milk_round WHERE center_id=$1 AND round_date=$2 AND shift='PM'`, [center.center_id, bkk(y)])).rows[0];
    await call(COOP, 'POST', `/dairy/rounds/${round.round_id}/close`, {});
    const closed = await call(KEY, 'POST', '/dairy-iot/gateway/events', {
      events: [ev('intake', { channel: 'scale1', member_code: 'G002', weight_kg: 3, at: new Date(yPm.getTime() + 60000).toISOString() })],
    });
    assert.equal(closed.results[0].status, 'error');
    assert.equal(closed.results[0].error, 'round_closed');
    const r = await call(KEY, 'POST', '/dairy-iot/gateway/events', {
      events: [ev('intake', { channel: 'scale1', member_code: 'G001', weight_kg: 3, at: new Date(Date.now() + 3600000).toISOString() })],
    });
    assert.equal(r.results[0].error, 'event_time_in_future');
  });

  await t.test('tank readings: temperature alert only for fresh values; level feeds the surplus check', async () => {
    const old = ev('reading', { channel: 'tank1', temp_c: 9, level_kg: 1500, at: new Date(Date.now() - 3600000).toISOString() });
    const fresh = ev('reading', { channel: 'tank1', temp_c: 7.5, level_kg: 1800 });
    const r = await call(KEY, 'POST', '/dairy-iot/gateway/events', { events: [old, fresh] });
    assert.deepEqual(r.results[0].data.alerts, []);
    assert.deepEqual(r.results[1].data.alerts, ['temp_high']);
    const alerts = await call(COOP, 'GET', '/dairy/iot/alerts');
    assert.equal(alerts.filter((a) => a.alert_type === 'temp_high').length, 1);
    const devs = await call(COOP, 'GET', '/dairy/iot/devices');
    const tank = devs.find((d) => d.channel === 'tank1');
    assert.equal(Number(tank.last_reading.level_kg), 1800);
    assert.equal(tank.gateway_name, gw.name);
    assert.equal(devs.find((d) => d.device_id === gw.device_id).event_stats.events_24h > 0, true);
  });

  await t.test('analyzer: stored per member; used for pricing only when the coop turns it on; water alert', async () => {
    const a1 = ev('analysis', { channel: 'analyzer1', member_code: 'G001', sample_no: 'S1', fat_pct: 4.1, snf_pct: 8.6, added_water_pct: 0, freezing_point_c: -0.535 });
    let r = await call(KEY, 'POST', '/dairy-iot/gateway/events', { events: [a1] });
    assert.equal(r.results[0].data.used_for_pricing, false);
    await call(COOP, 'PUT', '/dairy/settings', { analyzer_for_pricing: true });
    const a2 = ev('analysis', { channel: 'analyzer1', member_code: 'G002', sample_no: 'S2', fat_pct: 3.5, snf_pct: 8.2, added_water_pct: 4.2, freezing_point_c: -0.49 });
    const a3 = ev('analysis', { channel: 'analyzer1', sample_no: 'S3', milk_temp_c: 5 });
    r = await call(KEY, 'POST', '/dairy-iot/gateway/events', { events: [a2, a3] });
    assert.equal(r.results[0].data.used_for_pricing, true);
    assert.match(r.results[0].data.warning, /น้ำปน 4.2%/);
    assert.equal(r.results[1].error, 'empty_analysis');
    const list = await call(COOP, 'GET', '/dairy/iot/analyses');
    assert.deepEqual(list.map((x) => x.member_code).sort(), ['G001', 'G002']);
    const t2 = (await db.query(`SELECT fat_pct, lab_name FROM dairy.quality_test WHERE member_id=$1`, [M.G002.member_id])).rows;
    assert.equal(t2.length, 1);
    assert.match(t2[0].lab_name, /เครื่องวิเคราะห์ที่ศูนย์/);
    const q = (await call(COOP, 'GET', '/dairy/iot/alerts')).filter((x) => x.alert_type === 'milk_quality');
    assert.equal(q.length, 1);
    assert.match(q[0].message, /G002.*น้ำปน/);
  });

  await t.test('offline alert after silence; cleared when the gateway is back', async () => {
    await db.query(`UPDATE dairy.iot_device SET last_seen_at = now() - interval '30 minutes' WHERE device_id=$1`, [gw.device_id]);
    assert.ok(await G.checkOffline(db) >= 1);
    assert.equal(await G.checkOffline(db) >= 0, true);
    let off = (await call(COOP, 'GET', '/dairy/iot/alerts')).filter((x) => x.alert_type === 'offline' && x.device_id === gw.device_id);
    assert.equal(off.length, 1);
    assert.equal(off[0].acknowledged_at, null);
    assert.match(off[0].message, /ไม่มีสัญญาณเกิน 10 นาที/);
    await call(KEY, 'POST', '/dairy-iot/gateway/events', { gateway: { version: '1.0.0' }, events: [] }); // heartbeat
    off = (await call(COOP, 'GET', '/dairy/iot/alerts')).filter((x) => x.alert_type === 'offline' && x.device_id === gw.device_id);
    assert.ok(off[0].acknowledged_at);
  });

  await t.test('rotate key: old key stops working at once', async () => {
    const r = await call(COOP, 'POST', `/dairy/iot/devices/${gw.device_id}/rotate-key`, {});
    await call(KEY, 'POST', '/dairy-iot/gateway/events', { events: [] }, 401);
    await call(r.api_key, 'POST', '/dairy-iot/gateway/events', { events: [] });
    const ch = (await call(COOP, 'GET', '/dairy/iot/devices')).find((d) => d.channel === 'scale1');
    await call(COOP, 'POST', `/dairy/iot/devices/${ch.device_id}/rotate-key`, {}, 400);
  });
});
