/*
 * End-to-end test of the dairy money flow + member notifications, through the
 * real HTTP API against a real PostgreSQL database:
 *
 *   quality tests → milk rounds → close (pricing) → feed / loan / share →
 *   settlement run (strict deduction order, carry-over) → BAAC file →
 *   cancel + redo → paid → inbox + LINE push (to a fake LINE server)
 *
 * NEVER point this at Render / production: it creates a new cooperative,
 * farmers and members on every run. It only runs when DAIRY_DB_TEST=1 and the
 * database host is local. Needs every SQL file in DEPLOY.md applied, including
 * grant_dairy_line_notify.sql. Example:
 *
 *   DAIRY_DB_TEST=1 PGHOST=localhost PGPORT=5432 PGDATABASE=agrolink_test \
 *   PGUSER=agrolink PGPASSWORD=... node --test test/dairy.db.test.js
 *
 * PGUSER must be able to insert into identity.* (the schema owner) because
 * the test creates its own cooperative and farmers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ENABLED = process.env.DAIRY_DB_TEST === '1';
const host = process.env.PGHOST || '';
const LOCAL = !process.env.DATABASE_URL && (host.startsWith('/') || ['localhost', '127.0.0.1', '::1'].includes(host));
const SKIP = !ENABLED ? 'set DAIRY_DB_TEST=1 to run (local test database only)'
  : (!LOCAL ? 'refusing to run: PGHOST must be a local database (and DATABASE_URL unset)' : false);

const JWT_SECRET = `dairy-test-${crypto.randomBytes(8).toString('hex')}`;
const LINE_SECRET = 'line-test-secret';
const today = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const dayOffset = (n) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

test('dairy pricing → settlement → LINE notifications (database)', { skip: SKIP, timeout: 120000 }, async (t) => {
  // eslint-disable-next-line global-require
  const { Client } = require('pg');
  // eslint-disable-next-line global-require
  const jwt = require('jsonwebtoken');
  const db = new Client();
  await db.connect();

  // ---- fake LINE platform ---------------------------------------------------
  const line = { pushes: [], replies: [] };
  const lineSrv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const rec = { auth: req.headers.authorization, retryKey: req.headers['x-line-retry-key'], body };
      if (req.url === '/v2/bot/message/push') line.pushes.push(rec);
      else if (req.url === '/v2/bot/message/reply') line.replies.push(rec);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => { lineSrv.listen(0, '127.0.0.1', r); });

  // ---- API server -----------------------------------------------------------
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      JWT_SECRET,
      NODE_ENV: 'test',
      LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
      LINE_CHANNEL_SECRET: LINE_SECRET,
      LINE_OA_ID: '@agrolinktest',
      LINE_API_BASE: `http://127.0.0.1:${lineSrv.address().port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  srv.stdout.on('data', (d) => { srvLog += d; });
  srv.stderr.on('data', (d) => { srvLog += d; });
  t.after(async () => {
    if (process.env.DAIRY_TEST_VERBOSE) console.log(srvLog);
    srv.kill();
    lineSrv.close();
    await db.end();
  });
  for (let i = 0; i < 100 && !/listening on port/.test(srvLog); i += 1) await sleep(100);
  assert.match(srvLog, /listening on port/, 'API server did not start');

  const base = `http://127.0.0.1:${port}`;
  async function call(token, method, p, body, expectStatus = 200) {
    const res = await fetch(base + p, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    assert.equal(res.status, expectStatus, `${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
    return json;
  }

  // ---- fixtures: a verified cooperative + two farmers ----------------------
  const tag = crypto.randomBytes(4).toString('hex');
  const coopId = crypto.randomUUID();
  await db.query(
    `INSERT INTO identity.organization (org_id, org_type, org_name, tax_id, kyb_status) VALUES ($1,'Cooperative',$2,$3,'Verified')`,
    [coopId, `สหกรณ์โคนมทดสอบ ${tag}`, `T${Date.now()}${tag}`.slice(0, 20)],
  );
  await db.query(`INSERT INTO identity.organization_role (org_id, role_type, status) VALUES ($1,'Cooperative','Verified')`, [coopId]);
  await db.query(`INSERT INTO identity.subject_role (subject_type, subject_id, role_code) VALUES ('organization',$1,'org.admin')`, [coopId]);
  async function farmer(name, n) {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO identity.farmer (farmer_id, national_id_hash, full_name, phone, region_code, farmer_code)
       VALUES ($1,$2,$3,$4,'TH-30',$5)`,
      [id, crypto.randomBytes(16).toString('hex'), name, `09${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, `DT${tag}${n}`],
    );
    await db.query(`INSERT INTO identity.subject_role (subject_type, subject_id, role_code) VALUES ('farmer',$1,'farmer.self')`, [id]);
    return id;
  }
  const fA = await farmer('สมชาย ทดสอบ', 1);
  const fB = await farmer('สมหญิง ทดสอบ', 2);
  const COOP = jwt.sign({ subjectType: 'organization', subjectId: coopId }, JWT_SECRET);
  const FA = jwt.sign({ subjectType: 'farmer', subjectId: fA }, JWT_SECRET);
  const FB = jwt.sign({ subjectType: 'farmer', subjectId: fB }, JWT_SECRET);

  // ---- LINE link for farmer A (code → signed webhook) ----------------------
  await t.test('LINE: link a farmer with a one-time code', async () => {
    const st = await call(FA, 'GET', '/dairy-member/line');
    assert.equal(st.configured, true);
    assert.equal(st.linked, false);
    assert.equal(st.add_friend_url, 'https://line.me/R/ti/p/%40agrolinktest');
    const { code } = await call(FA, 'POST', '/dairy-member/line/code');
    assert.match(code, /^\d{6}$/);

    const lineUserA = `U${crypto.randomBytes(16).toString('hex')}`;
    const hook = async (events, secret = LINE_SECRET) => {
      const raw = JSON.stringify({ destination: 'Utest', events });
      const sig = crypto.createHmac('sha256', secret).update(raw).digest('base64');
      return fetch(`${base}/line/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Line-Signature': sig }, body: raw });
    };
    const msg = (text) => ({
      type: 'message', replyToken: `r${crypto.randomBytes(4).toString('hex')}`, source: { type: 'user', userId: lineUserA }, message: { type: 'text', text },
    });
    assert.equal((await hook([msg(code)], 'wrong-secret')).status, 401, 'bad signature must be rejected');
    assert.equal((await hook([msg('000000')])).status, 200);
    assert.equal((await hook([msg(code)])).status, 200);
    for (let i = 0; i < 50 && line.replies.length < 2; i += 1) await sleep(50);
    assert.match(line.replies[0].body.messages[0].text, /ไม่ถูกต้อง/);
    assert.match(line.replies[1].body.messages[0].text, /ผูกบัญชีสำเร็จ/);
    const after = await call(FA, 'GET', '/dairy-member/line');
    assert.equal(after.linked, true);
    // the same code cannot be used twice
    await hook([msg(code)]);
    for (let i = 0; i < 50 && line.replies.length < 3; i += 1) await sleep(50);
    assert.match(line.replies[2].body.messages[0].text, /ไม่ถูกต้อง/);
    // farmer A does not want lab results on LINE (inbox still gets them)
    const p = await call(FA, 'PUT', '/dairy-member/line/prefs', { prefs: { quality: false } });
    assert.equal(p.prefs.quality, false);
    assert.equal(p.prefs.settlement, true);
    await call(FB, 'PUT', '/dairy-member/line/prefs', { prefs: { quality: false } }, 404); // B never linked
  });

  // ---- coop setup -----------------------------------------------------------
  let center; const M = {};
  await t.test('setup: price table, center, members', async () => {
    await call(COOP, 'GET', '/dairy/overview'); // creates dairy.setting defaults
    await call(COOP, 'PUT', '/dairy/settings', { base_price_per_kg: 18.5, settlement_days: 15 });
    for (const r of [
      { param: 'fat', max_value: 3.2, adjust_per_kg: -0.5 },
      { param: 'fat', min_value: 3.8, adjust_per_kg: 0.3 },
      { param: 'scc', min_value: 500, max_value: 1000, adjust_per_kg: -0.25 },
    ]) await call(COOP, 'POST', '/dairy/quality-rules', r);
    center = await call(COOP, 'POST', '/dairy/centers', { name: `ศูนย์ ${tag}`, tank_capacity_kg: 3000 });
    M.A = await call(COOP, 'POST', '/dairy/members', {
      farmer_id: fA, member_code: 'A001', share_deduct_per_round: 100, baac_account_no: '020-1-23456-789', center_id: center.center_id,
    });
    M.B = await call(COOP, 'POST', '/dairy/members', {
      farmer_id: fB, member_code: 'B001', baac_account_no: '1234567890', center_id: center.center_id,
    });
    M.C = await call(COOP, 'POST', '/dairy/members', { full_name: 'นายซี ไม่มีบัญชีแอป', member_code: 'C001', center_id: center.center_id });
    for (const k of ['A', 'B', 'C']) await call(COOP, 'POST', `/dairy/members/${M[k].member_id}/status`, { status: 'Approved' });
    assert.equal(M.A.baac_account_no, '020123456789');
  });

  await t.test('pricing: latest test on/before the round day, rules applied', async () => {
    await call(COOP, 'POST', '/dairy/quality-tests', {
      tests: [
        { member_code: 'A001', sample_date: dayOffset(-5), fat_pct: 4.0, snf_pct: 8.5, scc_k: 300 },
        { member_code: 'B001', sample_date: dayOffset(-5), fat_pct: 3.0, snf_pct: 8.3, scc_k: 700 },
      ],
    });
    await call(COOP, 'POST', '/dairy/quality-tests', { member_code: 'B001', sample_date: dayOffset(-2), fat_pct: 3.5, snf_pct: 8.4, scc_k: 300 });
    // back-dated result (older than B's latest): stored, but no new message
    await call(COOP, 'POST', '/dairy/quality-tests', { member_code: 'B001', sample_date: dayOffset(-4), fat_pct: 3.0, snf_pct: 8.3, scc_k: 700 });

    const r1 = await call(COOP, 'POST', '/dairy/rounds', { center_id: center.center_id, round_date: dayOffset(-4), shift: 'AM' });
    await call(COOP, 'POST', `/dairy/rounds/${r1.round_id}/intakes`, { member_code: 'A001', weight_kg: 100 });
    await call(COOP, 'POST', `/dairy/rounds/${r1.round_id}/intakes`, { member_code: 'B001', weight_kg: 50 });
    await call(COOP, 'POST', `/dairy/rounds/${r1.round_id}/intakes`, {
      member_code: 'C001', weight_kg: 20, status: 'Rejected', reject_reason: 'antibiotic',
    });
    const c1 = await call(COOP, 'POST', `/dairy/rounds/${r1.round_id}/close`, { tank_temp_c: 3.5 });
    assert.equal(Number(c1.accepted_kg), 150);
    assert.equal(Number(c1.rejected_kg), 20);
    assert.equal(Number(c1.amount), 2767.5); // A 100 × 18.80 + B 50 × 17.75 (B's D-4 test is the same as D-5)
    assert.equal(c1.warning, null);
    await call(COOP, 'POST', `/dairy/rounds/${r1.round_id}/close`, { tank_temp_c: 3.5 }, 409); // round_closed

    const det = await call(COOP, 'GET', `/dairy/rounds/${r1.round_id}`);
    const a = det.intakes.find((x) => x.member_code === 'A001');
    assert.equal(Number(a.price_per_kg), 18.8);
    assert.deepEqual(a.price_detail.adjustments.map((x) => x.param), ['fat']);

    const r2 = await call(COOP, 'POST', '/dairy/rounds', { center_id: center.center_id, round_date: dayOffset(-1), shift: 'PM' });
    await call(COOP, 'POST', `/dairy/rounds/${r2.round_id}/intakes`, { member_code: 'A001', weight_kg: 80 });
    await call(COOP, 'POST', `/dairy/rounds/${r2.round_id}/intakes`, {
      member_code: 'B001', weight_kg: 60, status: 'Rejected', reject_reason: 'smell',
    });
    await call(COOP, 'POST', `/dairy/rounds/${r2.round_id}/intakes`, { member_code: 'C001', weight_kg: 40 });
    const c2 = await call(COOP, 'POST', `/dairy/rounds/${r2.round_id}/close`, { tank_temp_c: 5 });
    assert.equal(Number(c2.amount), 2244); // A 80 × 18.80 + C 40 × 18.50 (no test = base)
    assert.equal(c2.warning, 'tank_temp_high');
  });

  let run;
  await t.test('settlement: strict deduction order and carry-over', async () => {
    const item = await call(COOP, 'POST', '/dairy/items', {
      category: 'concentrate', name: `อาหารข้น ${tag}`, unit: 'กระสอบ', sell_price: 500,
    });
    await call(COOP, 'POST', `/dairy/items/${item.item_id}/adjust`, { qty: 10, unit_cost: 420, note: 'รับเข้าทดสอบ' });
    await call(COOP, 'POST', '/dairy/issues', { member_id: M.B.member_id, item_id: item.item_id, qty: 2 }); // B feed 1,000
    await call(COOP, 'POST', '/dairy/ledger/entry', {
      member_id: M.A.member_id, entry_type: 'loan_repayment', amount: 500, note: 'งวดสินเชื่อ',
    });
    await call(COOP, 'POST', '/dairy/ledger/entry', {
      member_id: M.B.member_id, entry_type: 'loan_repayment', amount: 300, note: 'งวดสินเชื่อ',
    });
    await call(COOP, 'POST', '/dairy/ledger/entry', {
      member_id: M.C.member_id, entry_type: 'adjustment', amount: 10, note: 'ค่าขนส่งคืน',
    });
    // feed/loan entries are dated today: settle up to today so they are included
    run = await call(COOP, 'POST', '/dairy/settlements', { period_end: today() });
    await call(COOP, 'POST', '/dairy/settlements', { period_end: today() }, 409); // draft_run_exists
    assert.equal(Number(run.total_net), 4421.5);
    assert.equal(run.member_count, 3);
    assert.equal(run.members_with_carried_debit, 1);

    const d = await call(COOP, 'GET', `/dairy/settlements/${run.run_id}`);
    const L = Object.fromEntries(d.lines.map((l) => [l.member_code, l]));
    // A: milk 1,880 + 1,504 − loan 500 − share 100
    assert.deepEqual([L.A001.total_credit, L.A001.total_debit, L.A001.net_amount, L.A001.carried_debit].map(Number), [3384, 600, 2784, 0]);
    // B: milk 887.50; feed 1,000 does not fit → feed AND the later loan 300 are carried (strict order)
    assert.deepEqual([L.B001.total_credit, L.B001.total_debit, L.B001.net_amount, L.B001.carried_debit].map(Number), [887.5, 0, 887.5, 1300]);
    // C: milk 740 + adjustment 10
    assert.equal(Number(L.C001.net_amount), 750);
    assert.equal(d.missing_account, 1);
  });

  await t.test('settlement: BAAC account required, export, cancel and redo', async () => {
    const e = await call(COOP, 'POST', `/dairy/settlements/${run.run_id}/submit`, undefined, 409);
    assert.equal(e.error, 'missing_baac_account');
    await call(COOP, 'PUT', `/dairy/members/${M.C.member_id}`, { baac_account_no: '3333333333' });
    const sub = await call(COOP, 'POST', `/dairy/settlements/${run.run_id}/submit`);
    assert.equal(sub.status, 'Submitted');
    const res = await fetch(`${base}/dairy/settlements/${run.run_id}/baac-export`, { headers: { Authorization: `Bearer ${COOP}` } });
    const csv = (await res.text()).replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(csv.length, 4);
    assert.equal(csv.slice(1).reduce((a, r) => a + Number(r.split(',')[3]), 0), 4421.5);

    // cancel → every entry is open again and the auto share entry is removed
    await call(COOP, 'POST', `/dairy/settlements/${run.run_id}/cancel`);
    const open = Number((await db.query('SELECT COALESCE(SUM(amount),0) AS s FROM dairy.member_ledger WHERE member_id=$1 AND run_id IS NULL', [M.A.member_id])).rows[0].s);
    assert.equal(open, 2884); // 3,384 − 500 (share 100 removed)
    run = await call(COOP, 'POST', '/dairy/settlements', { period_end: today() });
    assert.equal(Number(run.total_net), 4421.5);
    await call(COOP, 'POST', `/dairy/settlements/${run.run_id}/submit`);
    await call(COOP, 'POST', `/dairy/settlements/${run.run_id}/paid`);
    await call(COOP, 'POST', `/dairy/settlements/${run.run_id}/paid`, undefined, 409);
    // B's carried feed + loan are still open for the next run
    const bOpen = Number((await db.query('SELECT COALESCE(SUM(amount),0) AS s FROM dairy.member_ledger WHERE member_id=$1 AND run_id IS NULL', [M.B.member_id])).rows[0].s);
    assert.equal(bOpen, -1300);
  });

  await t.test('notifications: inbox for every event, LINE only where linked and not muted', async () => {
    await call(FA, 'POST', '/dairy-member/line/test');
    // wait until the sender has handled every row of farmer A
    for (let i = 0; i < 80; i += 1) {
      const p = (await db.query(`SELECT COUNT(*)::int AS n FROM dairy.notification WHERE farmer_id=$1 AND line_status='pending'`, [fA])).rows[0].n;
      if (!p) break;
      await sleep(100);
    }
    const rows = async (f) => (await db.query('SELECT kind, line_status, body FROM dairy.notification WHERE farmer_id=$1 ORDER BY created_at', [f])).rows;
    const a = await rows(fA);
    const b = await rows(fB);
    assert.deepEqual(a.map((x) => x.kind).sort(), ['membership', 'quality', 'settlement', 'test']);
    assert.deepEqual(Object.fromEntries(a.map((x) => [x.kind, x.line_status])), {
      membership: 'sent', quality: 'muted', settlement: 'sent', test: 'sent',
    });
    // B: two lab results (the back-dated one is silent), one rejected round, one payment — B has no LINE
    assert.deepEqual(b.map((x) => x.kind).sort(), ['membership', 'milk_rejected', 'quality', 'quality', 'settlement']);
    assert.ok(b.every((x) => ['no_link', 'pending'].includes(x.line_status)));
    assert.match(b.find((x) => x.kind === 'milk_rejected').body, /60 กก\..*กลิ่นผิดปกติ/);
    assert.match(b.find((x) => x.kind === 'settlement').body, /ยกไปรอบหน้า 1,300\.00/);
    assert.match(a.find((x) => x.kind === 'settlement').body, /โอนเงิน 2,784\.00 บาท เข้าบัญชี ธ\.ก\.ส\. \*\*\*\*6789/);

    // what the fake LINE server received for farmer A
    assert.equal(line.pushes.length, 3);
    line.pushes.forEach((p) => {
      assert.equal(p.auth, 'Bearer test-token');
      assert.match(p.retryKey, /^[0-9a-f-]{36}$/);
      assert.match(p.body.to, /^U[0-9a-f]{32}$/);
    });
    assert.ok(line.pushes.some((p) => /โอนเงินค่านมแล้ว/.test(p.body.messages[0].text)));

    // the member page inbox
    const inbox = await call(FA, 'GET', '/dairy-member/notifications');
    assert.equal(inbox.unread, 4);
    await call(FA, 'POST', '/dairy-member/notifications/read');
    assert.equal((await call(FA, 'GET', '/dairy-member/notifications')).unread, 0);
    // a farmer never sees another farmer's inbox
    assert.equal((await call(FB, 'GET', '/dairy-member/notifications')).items.length, 5);
  });
});
