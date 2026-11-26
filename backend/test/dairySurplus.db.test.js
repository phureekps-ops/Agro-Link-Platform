/*
 * End-to-end test of the surplus-milk recommender through the real HTTP API
 * against a real PostgreSQL database:
 *
 *   two centres + contract + processor capacity → rounds → close (auto scan)
 *   → centre-overflow case with ranked options → approve processor match
 *   (offer + proposal created) → outcome → resolve (discard needs a reason)
 *   → cool-down → escalate → province officer sees only shared cases
 *
 * Same rules as dairy.db.test.js: only runs with DAIRY_DB_TEST=1 against a
 * LOCAL database that has every SQL file applied, including
 * grant_dairy_surplus_cases.sql. Never point it at Render / production.
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

const JWT_SECRET = `surplus-test-${crypto.randomBytes(8).toString('hex')}`;
const today = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const dayOffset = (n) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

test('surplus milk: detect → recommend → approve → resolve → province (database)', { skip: SKIP, timeout: 120000 }, async (t) => {
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
  t.after(async () => {
    if (process.env.DAIRY_TEST_VERBOSE) console.log(srvLog);
    srv.kill();
    await db.end();
  });
  for (let i = 0; i < 100 && !/listening on port/.test(srvLog); i += 1) await sleep(100);
  assert.match(srvLog, /listening on port/, 'API server did not start');

  const base = `http://127.0.0.1:${port}`;
  async function call(token, method, p, body, expectStatus = 200) {
    const res = await fetch(base + p, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    assert.equal(res.status, expectStatus, `${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
    return json;
  }

  // ---- fixtures -------------------------------------------------------------
  const tag = crypto.randomBytes(4).toString('hex');
  const org = async (type, name) => {
    const id = crypto.randomUUID();
    await db.query(`INSERT INTO identity.organization (org_id, org_type, org_name, tax_id, kyb_status) VALUES ($1,$2,$3,$4,'Verified')`,
      [id, type, name, `T${Date.now()}${crypto.randomBytes(3).toString('hex')}`.slice(0, 20)]);
    await db.query(`INSERT INTO identity.subject_role (subject_type, subject_id, role_code) VALUES ('organization',$1,'org.admin')`, [id]);
    return id;
  };
  const coopId = await org('Cooperative', `สหกรณ์โคนมนมเกิน ${tag}`);
  await db.query(`INSERT INTO identity.organization_role (org_id, role_type, status) VALUES ($1,'Cooperative','Verified')`, [coopId]);
  await db.query(`INSERT INTO registry.cooperative_profile (org_id, province_code) VALUES ($1,'SARABURI')`, [coopId]);
  const COOP = jwt.sign({ subjectType: 'organization', subjectId: coopId }, JWT_SECRET);

  const factoryId = await org('Buyer', `โรงงานยูเอชที ${tag}`);
  await db.query(`INSERT INTO dairy.processor_profile (org_id, display_name, province_code, lat, lng) VALUES ($1,$2,'RATCHABURI',13.73,99.78)`,
    [factoryId, `โรงงานยูเอชที ${tag}`]);
  const cap = (await db.query(
    `INSERT INTO dairy.processor_capacity (org_id, available_from, available_to, kg_per_day, price_per_kg) VALUES ($1,$2,$3,2000,18) RETURNING capacity_id`,
    [factoryId, dayOffset(-1), dayOffset(30)],
  )).rows[0].capacity_id;
  // the local test DB keeps capacities from earlier runs — only this run's factory is open
  await db.query('UPDATE dairy.processor_capacity SET active=false WHERE org_id<>$1 AND active', [factoryId]);
  // ...and no import-quota surplus measure from earlier runs/demos (grant_dairy_import_quota.sql) adds options here
  if ((await db.query(`SELECT to_regclass('dairy.absorption_measure') IS NOT NULL AS ok`)).rows[0].ok) {
    await db.query(`UPDATE dairy.absorption_measure SET status='Closed' WHERE status='Active'`);
  }

  const officerId = crypto.randomUUID();
  await db.query(
    `INSERT INTO identity.government_officer (officer_id, full_name, national_id_hash, scope_type, province_code, auth_subject_id, created_by, department_code)
     VALUES ($1,'เจ้าหน้าที่ปศุสัตว์จังหวัด',$2,'Province','SARABURI',$3,'test','CPD')`,
    [officerId, crypto.randomBytes(16).toString('hex'), `gov-${tag}`],
  );
  await db.query(`INSERT INTO identity.subject_role (subject_type, subject_id, role_code) VALUES ('government_officer',$1,'gov.provincial_admin')`, [officerId])
    .catch(() => {});
  const GOV = jwt.sign({ subjectType: 'government_officer', subjectId: officerId }, JWT_SECRET);

  let A; let B; let member;
  await t.test('setup: settings, two centres with tanks and coordinates, a contract', async () => {
    await call(COOP, 'GET', '/dairy/overview');
    const st = await call(COOP, 'PUT', '/dairy/settings', {
      base_price_per_kg: 19, surplus_min_kg_center: 100, surplus_hold_hours: 12, transport_cost_per_ton_km: 3, surplus_min_price_per_kg: 12,
    });
    assert.deepEqual(st.updated.sort(), ['base_price_per_kg', 'surplus_hold_hours', 'surplus_min_kg_center', 'surplus_min_price_per_kg'].sort());
    await call(COOP, 'PUT', '/dairy/settings', { surplus_hold_hours: 0 }, 400);
    A = await call(COOP, 'POST', '/dairy/centers', { name: `ศูนย์ A ${tag}`, tank_capacity_kg: 1000, lat: 14.65, lng: 101.2 });
    B = await call(COOP, 'POST', '/dairy/centers', { name: `ศูนย์ B ${tag}`, tank_capacity_kg: 5000, lat: 14.55, lng: 101.0 });
    await call(COOP, 'POST', '/dairy/centers', { name: 'นอกประเทศ', lat: 40, lng: 101 }, 400);
    assert.equal(Number(A.lat), 14.65);
    member = await call(COOP, 'POST', '/dairy/members', { full_name: 'นายนมเยอะ', member_code: 'S001', center_id: A.center_id });
    await call(COOP, 'POST', `/dairy/members/${member.member_id}/status`, { status: 'Approved' });
    const p = await call(COOP, 'POST', '/dairy/partners', { partner_type: 'processor', name: `ผู้ซื้อตามสัญญา ${tag}` });
    await call(COOP, 'POST', '/dairy/contracts', {
      partner_id: p.partner_id, start_date: dayOffset(-30), end_date: dayOffset(60), daily_kg: 3000, price_per_kg: 19.5,
    });
  });

  await t.test('closing today\'s round opens a centre-overflow case with ranked options', async () => {
    const r0 = await call(COOP, 'POST', '/dairy/rounds', { center_id: A.center_id, round_date: dayOffset(-1), shift: 'PM' });
    await call(COOP, 'POST', `/dairy/rounds/${r0.round_id}/intakes`, { member_code: 'S001', weight_kg: 600 });
    await call(COOP, 'POST', `/dairy/rounds/${r0.round_id}/close`, {});
    assert.equal((await call(COOP, 'GET', '/dairy/surplus-cases')).cases.length, 0, 'yesterday alone is not an overflow');

    const r1 = await call(COOP, 'POST', '/dairy/rounds', { center_id: A.center_id, round_date: today(), shift: 'AM' });
    await call(COOP, 'POST', `/dairy/rounds/${r1.round_id}/intakes`, { member_code: 'S001', weight_kg: 900 });
    await call(COOP, 'POST', `/dairy/rounds/${r1.round_id}/close`, {});

    const list = await call(COOP, 'GET', '/dairy/surplus-cases');
    assert.equal(list.cases.length, 1);
    const k = list.cases[0];
    assert.equal(k.horizon, 'today');
    assert.equal(k.scope, 'center');
    assert.equal(k.center_name, A.name);
    assert.equal(k.alert_level, 'orange'); // 900 < 1,000 now, 900 + 600 next round > 1,000
    assert.equal(Number(k.surplus_kg_day), 500);
    assert.equal(k.detail.unshipped_kg, 900);
    const kinds = k.options.map((o) => o.kind);
    assert.equal(kinds[kinds.length - 1], 'gov_help');
    assert.deepEqual(kinds.slice(0, 3).sort(), ['buyer_extra', 'processor_match', 'transfer_center']);
    const by = Object.fromEntries(k.options.map((o) => [o.kind, o]));
    assert.equal(by.buyer_extra.rank, 1); // 500 × 19.50, same route
    assert.equal(Number(by.buyer_extra.net_per_kg), 19.5);
    assert.equal(by.transfer_center.target_id, B.center_id);
    assert.ok(Number(by.transfer_center.distance_km) > 20 && Number(by.transfer_center.distance_km) < 40);
    assert.equal(by.processor_match.feasible, false); // needs 24 h, milk can be held 12 h
    assert.ok(by.processor_match.reasons.includes('not_in_time'));
    assert.ok(Number(by.processor_match.distance_km) > 200);
    assert.equal(list.summary.open, 1);
    assert.equal((await call(COOP, 'GET', '/dairy/overview')).surplus_cases_open, 1);

    // rescanning updates the same case instead of opening another
    const again = await call(COOP, 'POST', '/dairy/surplus-cases/scan');
    assert.equal(again.scan.opened, 0);
    assert.equal(again.scan.updated, 1);
    assert.equal(again.cases.length, 1);
  });

  let kase;
  await t.test('approve the processor option → offer + proposal to that capacity; outcome; resolve', async () => {
    kase = (await call(COOP, 'GET', '/dairy/surplus-cases')).cases[0];
    const opt = kase.options.find((o) => o.kind === 'processor_match');
    const ok = await call(COOP, 'POST', `/dairy/surplus-cases/${kase.case_id}/options/${opt.option_id}/approve`);
    assert.equal(ok.status, 'Approved');
    assert.ok(ok.offer_id && ok.proposal_id);
    const prop = (await db.query('SELECT * FROM dairy.surplus_proposal WHERE proposal_id=$1', [ok.proposal_id])).rows[0];
    assert.equal(prop.capacity_id, cap);
    assert.equal(prop.proposed_by, 'coop');
    assert.equal(Number(prop.kg_per_day), 500);
    await call(COOP, 'POST', `/dairy/surplus-cases/${kase.case_id}/options/${opt.option_id}/approve`, undefined, 409);
    const rej = kase.options.find((o) => o.kind === 'transfer_center');
    assert.equal((await call(COOP, 'POST', `/dairy/surplus-cases/${kase.case_id}/options/${rej.option_id}/reject`, { note: 'รถไม่ว่าง' })).status, 'Rejected');

    const acting = (await call(COOP, 'GET', '/dairy/surplus-cases')).cases[0];
    assert.equal(acting.status, 'Acting');
    // while acting, a rescan keeps the user's decisions
    await call(COOP, 'POST', '/dairy/surplus-cases/scan');
    const after = (await call(COOP, 'GET', '/dairy/surplus-cases')).cases[0];
    assert.equal(after.options.find((o) => o.option_id === rej.option_id).status, 'Rejected');

    await call(COOP, 'POST', `/dairy/surplus-cases/${kase.case_id}/options/${opt.option_id}/outcome`, { done: true, outcome_kg: 450 });
    await call(COOP, 'POST', `/dairy/surplus-cases/${kase.case_id}/resolve`, { discarded_kg: 50 }, 400);
    const done = await call(COOP, 'POST', `/dairy/surplus-cases/${kase.case_id}/resolve`, { discarded_kg: 50, discard_reason: 'ค้างถังเกินเวลา', note: 'ส่งโรงงานได้ 450' });
    assert.equal(done.status, 'Resolved');
    assert.equal(Number(done.handled_kg), 450);
    const logs = (await db.query('SELECT action FROM dairy.surplus_case_log WHERE case_id=$1 ORDER BY created_at', [kase.case_id])).rows.map((x) => x.action);
    assert.deepEqual(logs, ['detected', 'option_approved', 'option_rejected', 'option_done', 'resolved']);
  });

  await t.test('cool-down: the same overflow is not reopened right after it was resolved', async () => {
    const r = await call(COOP, 'POST', '/dairy/surplus-cases/scan');
    assert.equal(r.scan.opened, 0);
    assert.equal(r.scan.cooling, 1);
    assert.equal(r.cases.length, 0);
    const closed = await call(COOP, 'GET', '/dairy/surplus-cases?view=closed');
    assert.equal(closed.cases.length, 1);
    assert.equal(Number(closed.summary.discarded_30d_kg), 50);
  });

  await t.test('province officer: totals always, details only when the coop shares the case', async () => {
    // reopen: pretend the case was resolved 13 hours ago
    await db.query(`UPDATE dairy.surplus_case SET closed_at = now() - interval '13 hours' WHERE case_id=$1`, [kase.case_id]);
    const r = await call(COOP, 'POST', '/dairy/surplus-cases/scan');
    assert.equal(r.scan.opened, 1);
    const k2 = r.cases[0];
    // the approved/rejected history belongs to the old case — the new one gets fresh options
    assert.ok(k2.options.every((o) => o.status === 'Suggested'));

    let g = await call(GOV, 'GET', '/dairy-gov/surplus');
    const sb = g.provinces.find((p) => p.province_code === 'SARABURI');
    assert.ok(sb.active_cases >= 1);
    assert.ok(Number(sb.surplus_now_kg_day) >= 500);
    assert.ok(!g.cases.some((x) => x.case_id === k2.case_id), 'not shared yet');
    assert.ok(g.cases_not_shared >= 1);

    await call(COOP, 'POST', `/dairy/surplus-cases/${k2.case_id}/escalate`, { note: 'ขอรถขนนมจากจังหวัด' });
    g = await call(GOV, 'GET', '/dairy-gov/surplus');
    const seen = g.cases.find((x) => x.case_id === k2.case_id);
    assert.ok(seen);
    assert.equal(seen.status, 'Escalated');
    assert.equal(seen.escalation_note, 'ขอรถขนนมจากจังหวัด');
    assert.equal(seen.center_name, A.name);
    assert.ok(!('price_per_kg' in (seen.options[0] || {})), 'no prices to government');
    const gopt = (await db.query(`SELECT status FROM dairy.surplus_option WHERE case_id=$1 AND kind='gov_help'`, [k2.case_id])).rows[0];
    assert.equal(gopt.status, 'Approved');

    // a coop can never touch another coop's case
    const otherId = await org('Cooperative', `สหกรณ์อื่น ${tag}`);
    await db.query(`INSERT INTO identity.organization_role (org_id, role_type, status) VALUES ($1,'Cooperative','Verified')`, [otherId]);
    const OTHER = jwt.sign({ subjectType: 'organization', subjectId: otherId }, JWT_SECRET);
    await call(OTHER, 'POST', `/dairy/surplus-cases/${k2.case_id}/resolve`, {}, 404);
    assert.equal((await call(OTHER, 'GET', '/dairy/surplus-cases')).cases.length, 0);

    await call(COOP, 'POST', `/dairy/surplus-cases/${k2.case_id}/dismiss`, {}, 400);
    assert.equal((await call(COOP, 'POST', `/dairy/surplus-cases/${k2.case_id}/dismiss`, { note: 'ตาชั่งผิด' })).status, 'Dismissed');
  });

  await t.test('import quota: holders share the surplus measure 80:20; quota holder becomes a coop option; government sees policy options', async () => {
    if (!(await db.query(`SELECT to_regclass('dairy.import_quota_tranche') IS NOT NULL AS ok`)).rows[0].ok) return; // grant_dairy_import_quota.sql not applied
    const ADMIN = jwt.sign({ subjectType: 'platform' }, JWT_SECRET);
    const Y = 2599;
    await db.query(`UPDATE dairy.absorption_measure SET status='Closed' WHERE status='Active'`); // local DB: earlier runs
    await db.query('DELETE FROM dairy.import_quota_holder WHERE quota_year=$1', [Y]);
    await db.query('DELETE FROM dairy.import_quota_tranche WHERE quota_year=$1', [Y]);
    await call(ADMIN, 'POST', '/admin/dairy-import-quota/tranches', { quota_year: Y, agreement: 'TAFTA_TNZCEP', product_code: 'smp', tranche_no: 1, quantity_t: 700, opens_on: dayOffset(-30) }, 201);
    const t2 = await call(ADMIN, 'POST', '/admin/dairy-import-quota/tranches', { quota_year: Y, agreement: 'TAFTA_TNZCEP', product_code: 'smp', tranche_no: 2, quantity_t: 300, opens_on: dayOffset(120) }, 201);
    await call(ADMIN, 'POST', '/admin/dairy-import-quota/tranches', { quota_year: Y, agreement: 'TAFTA_TNZCEP', product_code: 'smp', tranche_no: 2, quantity_t: 1, opens_on: dayOffset(120) }, 409);
    await call(ADMIN, 'POST', '/admin/dairy-import-quota/holders', { quota_year: Y, holder_name: `โรงงานยูเอชที ${tag}`, org_id: factoryId, entity_group: 1, quantity_t: 600 }, 201);
    await call(ADMIN, 'POST', '/admin/dairy-import-quota/holders', { quota_year: Y, holder_name: `บริษัทนมนอกระบบ ${tag}`, entity_group: 1, quantity_t: 400 }, 201);
    await call(ADMIN, 'POST', '/admin/dairy-import-quota/holders', { quota_year: Y, holder_name: `ผู้ใช้นมผงอุตสาหกรรม ${tag}`, entity_group: 2, quantity_t: 200 }, 201);
    await call(COOP, 'GET', '/admin/dairy-import-quota', undefined, 403);
    const m = await call(ADMIN, 'POST', '/admin/dairy-import-quota/measures', {
      title: 'มาตรการเร่งด่วนรับซื้อน้ำนมดิบส่วนเกิน (ทดสอบ)', quota_year: Y, total_kg_day: 5000, start_date: dayOffset(-1), days: 60, group1_pct: 80, status: 'Active',
    }, 201);
    const a = await call(ADMIN, 'GET', `/admin/dairy-import-quota?year=${Y}`);
    const rows = a.progress[0].rows;
    assert.equal(rows.find((r) => r.org_id === factoryId).kg_per_day, 2400); // 5,000 × 80% × 600/1,000
    assert.equal(rows.find((r) => r.entity_group === 2).kg_per_day, 1000);

    // the coop's next overflow: the quota holder's factory is an option (other capacity closed, milk can wait 48 h)
    await db.query('UPDATE dairy.processor_capacity SET active=false WHERE capacity_id=$1', [cap]);
    await call(COOP, 'PUT', '/dairy/settings', { surplus_hold_hours: 48 });
    await db.query(`UPDATE dairy.surplus_case SET closed_at = now() - interval '13 hours' WHERE coop_org_id=$1 AND status IN ('Resolved','Dismissed')`, [coopId]);
    const r = await call(COOP, 'POST', '/dairy/surplus-cases/scan');
    const k3 = r.cases[0];
    const q = k3.options.find((o) => o.kind === 'quota_holder');
    assert.ok(q, JSON.stringify(k3.options.map((o) => o.kind)));
    assert.equal(q.feasible, true);
    assert.match(q.target_name, /ผู้ถือโควตานำเข้า กลุ่ม 1/);
    const ok = await call(COOP, 'POST', `/dairy/surplus-cases/${k3.case_id}/options/${q.option_id}/approve`);
    const prop = (await db.query('SELECT * FROM dairy.surplus_proposal WHERE proposal_id=$1', [ok.proposal_id])).rows[0];
    assert.equal(prop.processor_org_id, factoryId);
    assert.equal(prop.capacity_id, null);
    const a2 = await call(ADMIN, 'GET', `/admin/dairy-import-quota?year=${Y}`);
    assert.equal(Number(a2.progress[0].rows.find((x) => x.org_id === factoryId).approved_kg_day), Number(q.kg_per_day));

    // government: quota vs surplus, policy options computed on the measure (5,000 kg/day × 60 days)
    const g = await call(GOV, 'GET', `/dairy-gov/import-quota?year=${Y}`);
    assert.equal(g.basis, 'measure');
    assert.equal(g.active_measure.measure_id, m.measure_id);
    const defer = g.options.find((o) => o.kind === 'defer_import');
    assert.equal(defer.recommended_tranche_id, t2.tranche_id);
    assert.equal(defer.propose_t, 27.27); // 300,000 kg ÷ 11 ÷ 1,000
    assert.equal(defer.decide_by, dayOffset(90));
    assert.equal(g.options.find((o) => o.kind === 'domestic_powder').powder_t, 27.27);
    const ab = g.options.find((o) => o.kind === 'absorb_by_quota_holders');
    assert.equal(ab.holders.length, 3);
    assert.equal(ab.unassigned_kg_day, 0);
    assert.equal(g.decision_points[0].tranche_id, t2.tranche_id);
    // recording the committee's decision
    await call(ADMIN, 'PATCH', `/admin/dairy-import-quota/tranches/${t2.tranche_id}`, { status: 'Deferred' }, 400);
    await call(ADMIN, 'PATCH', `/admin/dairy-import-quota/tranches/${t2.tranche_id}`, { status: 'Deferred', deferred_t: 27.27 });
    const g2 = await call(GOV, 'GET', `/dairy-gov/import-quota?year=${Y}`);
    assert.equal(g2.tranches.find((x) => x.tranche_id === t2.tranche_id).net_t, 272.73);
    await call(COOP, 'GET', `/dairy-gov/import-quota?year=${Y}`, undefined, 403);
    await call(ADMIN, 'PATCH', `/admin/dairy-import-quota/measures/${m.measure_id}`, { status: 'Closed' });
  });
});
