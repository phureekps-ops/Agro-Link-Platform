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

test('marketplace: borrower lists → admin review → lender compliance → offers (syndicated) → counter → accept → confirm by approver → match → docx → sign → facilities → tranches', { skip: SKIP, timeout: 120000 }, async (t) => {
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
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
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
      [id, type, name, `M${Date.now()}${crypto.randomBytes(3).toString('hex')}`.slice(0, 20)]);
    await db.query(`INSERT INTO identity.subject_role (subject_type, subject_id, role_code) VALUES ('organization',$1,'org.admin')`, [id]);
    return { id, name, token: sign('organization', id) };
  };
  const staff = async (orgId, role, name) => sign('organization_member', (await db.query('SELECT identity.register_staff_member($1,$2,$3,$4,$5,$6) AS id',
    [orgId, name, crypto.randomBytes(16).toString('hex'), `oidc|m-${crypto.randomUUID()}`, role, 'test'])).rows[0].id);
  const coop = await org('Cooperative', `สหกรณ์การเกษตรตลาดสินเชื่อ ${tag} จำกัด`);
  await db.query(`INSERT INTO registry.cooperative_profile (org_id, province_code) VALUES ($1,'SURIN') ON CONFLICT (org_id) DO UPDATE SET province_code = 'SURIN'`, [coop.id]);
  const sav = await org('SavingsCooperative', `สหกรณ์ออมทรัพย์ตลาด ${tag} จำกัด`);
  const cu = await org('CreditUnion', `สหกรณ์เครดิตยูเนี่ยนตลาด ${tag} จำกัด`);
  const supplier = await org('InputSupplier', `ร้านปัจจัยการผลิตตลาด ${tag}`);
  await db.query(`INSERT INTO identity.organization_role (org_id, role_type, status) VALUES ($1,'SavingsCooperative','Verified'), ($2,'CreditUnion','Verified')`, [sav.id, cu.id]).catch(() => {});
  const S2 = await staff(sav.id, 'coop.credit_officer', 'ผู้อนุมัติออมทรัพย์');
  const U2 = await staff(cu.id, 'coop.credit_officer', 'ผู้อนุมัติเครดิตยูเนี่ยน');
  const ADMIN = jwt.sign({ subjectType: 'platform' }, JWT_SECRET);
  const officerId = (await db.query('SELECT identity.register_government_officer($1,$2,$3,$4,$5,$6,$7,$8) AS id',
    ['เจ้าหน้าที่สุรินทร์', crypto.randomBytes(16).toString('hex'), 'Province', 'SURIN', `oidc|g-${crypto.randomUUID()}`, 'gov.provincial_admin', 'CPD', 'test'])).rows[0].id;
  const GOV = sign('government_officer', officerId);
  const upload = async (token) => (await call(token, 'POST', '/storage/upload', {
    purpose: 'coop_lending_evidence', filename: 'd.png', content_type: 'image/png', file_base64: png(), uploaded_by: 'test',
  }, 201)).file_id;

  const PSCORE = 80; // เกรด B — ยังไม่มีประวัติในระบบและไม่ได้กรอกธุรกิจ/รายได้ (ดูรายละเอียดใน factors)
  let listing; let savOffer; let cuOffer; let agreement;
  await t.test('borrower profile → credit score; listing must be complete before review', async () => {
    const p = await call(coop.token, 'PUT', '/coop-lending/market/profile', {
      registration_no: 'สร 123', member_count: 820, signatories: 'นายประธาน กรรมการ', consent_disclose: true, board: 'คณะกรรมการ 9 คน',
      financials: [{ year: 2567, total_assets: 80e6, total_liabilities: 40e6, current_assets: 25e6, current_liabilities: 15e6, net_income: 2e6, audit_opinion: 'unqualified' },
        { year: 2566, net_income: 1.5e6 }, { year: 2565, net_income: 1.1e6 }],
      governance: { standard_grade: 'good' }, debts: [{ creditor: 'ธ.ก.ส.', outstanding: 5e6, status: 'current' }], assets: [{ kind: 'โกดัง', value: 3e6 }],
      coop_kind: 'dairy', max_borrowing: 20e6, max_borrowing_ref: 'มติที่ประชุมใหญ่ 1/2569',
    });
    assert.equal(p.profile.coop_kind, 'dairy');
    assert.equal(Number(p.profile.max_borrowing), 20e6);
    assert.equal(p.score.grade, 'B');
    assert.equal(p.score.score, PSCORE);
    assert.deepEqual(p.score.groups.map((g) => [g.key, g.max]), [['financial', 25], ['capacity', 25], ['governance', 20], ['repayment', 15], ['business', 15]]);
    listing = await call(coop.token, 'POST', '/coop-lending/market/listings', {
      project_type: 'member_onlending', title: 'สินเชื่อปัจจัยการผลิตข้าวนาปีสำหรับสมาชิก', amount_requested: 3000000, min_amount: 2000000, tenor_months: 12,
      use_plan: [{ item: 'ปัจจัยการผลิต', amount: 1800000, timing: 'พ.ค.-ก.ค.' }, { item: 'ค่าบริการเครื่องจักร', amount: 1200000 }],
      repayment_plan: 'สมาชิกชำระคืนหลังจำหน่ายข้าวเดือน ธ.ค.', commodities: ['RICE_JASMINE'],
      details: { members_count: 120, per_member_limit: 25000, member_repayment_pct: 97, production_plan: 'ข้าวหอมมะลิ 105 นาปี 3,000 ไร่' },
    }, 201);
    assert.equal(listing.province_code, 'SURIN');
    const inc = await call(coop.token, 'POST', `/coop-lending/market/listings/${listing.listing_id}/submit`, {}, 400);
    assert.deepEqual(inc.missing.map((m) => m.code), ['resolution', 'certify']);
    await call(coop.token, 'POST', `/coop-lending/market/listings/${listing.listing_id}/documents`, { kind: 'resolution', title: 'มติที่ประชุมใหญ่ 2569', file_id: await upload(coop.token) }, 201);
    await call(coop.token, 'POST', `/coop-lending/market/listings/${listing.listing_id}/certify`);
    assert.equal((await call(coop.token, 'POST', `/coop-lending/market/listings/${listing.listing_id}/submit`)).status, 'Review');
    await call(coop.token, 'PATCH', `/coop-lending/market/listings/${listing.listing_id}`, { title: 'แก้ไม่ได้ระหว่างตรวจ' }, 409);
  });

  await t.test('lender policy; admin approves → listed, matching lenders notified; Q&A', async () => {
    await call(sav.token, 'PUT', '/savings/market/profile', {
      registration_no: 'อท 77', allocatable_amount: 10000000, approval_authority: 'คณะกรรมการดำเนินการอนุมัติ', signatories: 'นางผู้จัดการ',
      policy: { project_types: ['member_onlending', 'procurement'], max_amount: 5000000, provinces: ['SURIN'], max_risk_grade: 'B', rate_min: 4, min_verification_level: 2 },
      financials: [{ year: 2568, total_assets: 600e6, share_capital: 300e6, reserve: 40e6, liquid_assets: 60e6, liquidity_required: 12e6 }],
    });
    await call(cu.token, 'PUT', '/savings/market/profile', {
      allocatable_amount: 800000, policy: { project_types: ['investment'] },
      financials: [{ year: 2568, total_assets: 90e6, share_capital: 40e6, reserve: 5e6, liquid_assets: 8e6, liquidity_required: 3e6 }],
    });
    assert.ok(!(await call(sav.token, 'GET', '/savings/market/listings')).listings.some((l) => l.listing_id === listing.listing_id), 'not visible before review');
    await call(sav.token, 'GET', `/savings/market/listings/${listing.listing_id}`, undefined, 404);
    const q = await call(ADMIN, 'GET', '/admin/coop-lending/market/listings');
    assert.equal(q.find((l) => l.listing_id === listing.listing_id).checks.ok, true);
    const ap = await call(ADMIN, 'POST', `/admin/coop-lending/market/listings/${listing.listing_id}/approve`, { offer_days: 21 });
    assert.equal(ap.status, 'Listed');
    assert.ok((await call(sav.token, 'GET', '/savings/notices')).some((n) => n.kind === 'listing_match' && n.listing_id === listing.listing_id));
    assert.ok(!(await call(cu.token, 'GET', '/savings/notices')).some((n) => n.kind === 'listing_match' && n.listing_id === listing.listing_id), 'credit union policy is investment only');
    const found = await call(sav.token, 'GET', '/savings/market/listings?type=member_onlending&match_only=1');
    assert.ok(found.listings.some((l) => l.listing_id === listing.listing_id && l.grade === 'B'));
    assert.ok(!(await call(cu.token, 'GET', '/savings/market/listings?match_only=1')).listings.some((l) => l.listing_id === listing.listing_id));
    const det = await call(sav.token, 'GET', `/savings/market/listings/${listing.listing_id}`);
    assert.equal(det.borrower.profile.registration_no, 'สร 123');
    assert.equal(det.score.score, PSCORE);
    assert.ok(det.project_score && det.project_score.factors.length === 6);
    assert.equal(det.project_score.factors.reduce((a, f) => a + f.max, 0), 100);
    assert.equal(det.compliance.ok, false); // ยังไม่ส่งเอกสารคุณสมบัติ
    const qq = await call(sav.token, 'POST', `/savings/market/listings/${listing.listing_id}/questions`, { kind: 'document_request', question: 'ขอรายชื่อสมาชิกผู้กู้และผลชำระย้อนหลัง 3 ปี' }, 201);
    await call(coop.token, 'POST', `/coop-lending/market/questions/${qq.question_id}/answer`, { answer: 'แนบรายชื่อแล้ว ผลชำระเฉลี่ย 97%' });
    const qs = (await call(cu.token, 'GET', `/savings/market/listings/${listing.listing_id}`)).questions;
    assert.equal(qs[0].answer, 'แนบรายชื่อแล้ว ผลชำระเฉลี่ย 97%');
    assert.equal(qs[0].mine, false);
  });

  await t.test('lender compliance: offers blocked until 5 documents pass admin review; limit / liquidity / large exposure computed', async () => {
    const blocked = await call(sav.token, 'POST', `/savings/market/listings/${listing.listing_id}/offers`, { amount: 2000000, rate_pct: 4.5, tenor_months: 12 }, 409);
    assert.equal(blocked.error, 'compliance_not_passed');
    assert.deepEqual(blocked.checks.map((c) => c.code), ['registration', 'bylaws', 'lending_regulation', 'board_resolution', 'signatories']);
    const codes = ['registration', 'bylaws', 'lending_regulation', 'board_resolution', 'signatories'];
    for (const lender of [sav, cu]) {
      for (const code of codes) await call(lender.token, 'PUT', `/savings/market/compliance/${code}`, { file_id: await upload(lender.token), note: code });
    }
    const pend = await call(sav.token, 'GET', '/savings/market/compliance');
    assert.ok(pend.status.checks.filter((c) => codes.includes(c.code)).every((c) => c.status === 'pending'));
    const adm = await call(ADMIN, 'GET', '/admin/coop-lending/market/compliance');
    assert.ok(adm.lenders.some((l) => l.org_id === sav.id && l.documents.length === 5));
    const fres = await fetch(`${base}/admin/coop-lending/market/compliance/${sav.id}/bylaws/file`, { headers: { Authorization: `Bearer ${ADMIN}` } });
    assert.equal(fres.status, 200);
    await call(ADMIN, 'POST', `/admin/coop-lending/market/compliance/${sav.id}/bylaws/decide`, { status: 'Fail', note: 'ข้อบังคับฉบับเก่า' });
    const failed = await call(sav.token, 'GET', '/savings/market/compliance');
    assert.equal(failed.status.checks.find((c) => c.code === 'bylaws').status, 'fail');
    assert.ok((await call(sav.token, 'GET', '/savings/notices')).some((n) => n.kind === 'compliance'));
    for (const lender of [sav, cu]) {
      for (const code of codes) await call(ADMIN, 'POST', `/admin/coop-lending/market/compliance/${lender.id}/${code}/decide`, { status: 'Pass', valid_until: '2099-12-31' });
    }
    const ok = await call(sav.token, 'GET', '/savings/market/compliance');
    assert.equal(ok.status.ok, true);
    assert.equal(ok.status.checks.length, 8);
    assert.ok(['approved_limit', 'liquidity', 'large_exposure'].every((k) => ok.status.checks.find((c) => c.code === k).status === 'pass'));
    // เครดิตยูเนี่ยน: เสนอเกินวงเงินที่จัดสรร → ไม่ผ่านการตรวจวงเงิน (ไม่ใช่แค่คำเตือน)
    const over = await call(cu.token, 'POST', `/savings/market/listings/${listing.listing_id}/offers`, { amount: 1000000, rate_pct: 5.5, tenor_months: 12, repayment_type: 'bullet' }, 409);
    assert.deepEqual(over.checks.map((c) => c.code), ['approved_limit']);
    await call(cu.token, 'PUT', '/savings/market/profile', {
      allocatable_amount: 1500000, policy: { project_types: ['investment'] },
      financials: [{ year: 2568, total_assets: 90e6, share_capital: 40e6, reserve: 5e6, liquid_assets: 8e6, liquidity_required: 3e6 }],
    });
  });

  await t.test('two lenders offer; exposure warnings; counter → revise → accept; confirmation needs a second person', async () => {
    savOffer = await call(sav.token, 'POST', `/savings/market/listings/${listing.listing_id}/offers`, { amount: 2000000, rate_pct: 4.5, tenor_months: 12, repayment_type: 'bullet', interval_months: 6, conditions: 'รายงานผลผลิตทุกเดือน' }, 201);
    await call(sav.token, 'POST', `/savings/market/listings/${listing.listing_id}/offers`, { amount: 100000, rate_pct: 4, tenor_months: 12 }, 409); // one live offer per lender
    cuOffer = await call(cu.token, 'POST', `/savings/market/listings/${listing.listing_id}/offers`, { amount: 1000000, rate_pct: 5.5, tenor_months: 12, repayment_type: 'bullet' }, 201);
    assert.deepEqual(cuOffer.warnings.map((w) => w.code), []);
    await call(cu.token, 'POST', `/savings/market/listings/${listing.listing_id}/offers`, { amount: 4000000, rate_pct: 5, tenor_months: 12 }, 400); // more than requested
    const mine = await call(coop.token, 'GET', `/coop-lending/market/listings/${listing.listing_id}`);
    assert.equal(mine.listing.status, 'Offered');
    assert.equal(mine.offers.length, 2);
    assert.equal(mine.offers[0].lender_name, sav.name); // sorted by rate
    await call(coop.token, 'POST', `/coop-lending/market/offers/${cuOffer.offer_id}/counter`, { rate_pct: 5, note: 'ขอดอกเบี้ย 5%' });
    await call(coop.token, 'POST', `/coop-lending/market/offers/${cuOffer.offer_id}/accept`, {}, 409); // countered: lender must answer first
    const rev = await call(cu.token, 'POST', `/savings/market/offers/${cuOffer.offer_id}/revise`, { amount: 1000000, rate_pct: 5, tenor_months: 12, repayment_type: 'bullet' });
    assert.equal(rev.status, 'Submitted');
    await call(coop.token, 'POST', `/coop-lending/market/listings/${listing.listing_id}/match`, {}, 409); // nothing confirmed yet
    await call(coop.token, 'POST', `/coop-lending/market/offers/${savOffer.offer_id}/accept`);
    await call(coop.token, 'POST', `/coop-lending/market/offers/${cuOffer.offer_id}/accept`);
    assert.equal((await call(sav.token, 'POST', `/savings/market/offers/${savOffer.offer_id}/confirm`, { approval_ref: 'มติ คกก. 9/2569' }, 409)).error, 'approver_must_differ_from_preparer');
    assert.equal((await call(S2, 'POST', `/savings/market/offers/${savOffer.offer_id}/confirm`, { approval_ref: 'มติ คกก. 9/2569' })).status, 'Confirmed');
    await call(U2, 'POST', `/savings/market/offers/${cuOffer.offer_id}/confirm`, { approval_ref: 'บันทึกอนุมัติ 14/2569' });
  });

  await t.test('match → agreement (syndicated 2:1) → .docx → all parties sign → facilities open', async () => {
    agreement = await call(coop.token, 'POST', `/coop-lending/market/listings/${listing.listing_id}/match`, {}, 201);
    assert.equal(Number(agreement.total_amount), 3000000);
    assert.match(agreement.agreement_no, /^CL-25\d\d-[0-9A-F]{6}$/);
    const res = await fetch(`${base}/coop-lending/market/listings/${listing.listing_id}/agreement.docx`, { headers: { Authorization: `Bearer ${coop.token}` } });
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 2).toString(), 'PK');
    const lres = await fetch(`${base}/savings/market/agreements/${agreement.agreement_id}/docx`, { headers: { Authorization: `Bearer ${cu.token}` } });
    assert.equal(lres.status, 200);
    const det = await call(coop.token, 'GET', `/coop-lending/market/listings/${listing.listing_id}`);
    assert.equal(det.listing.status, 'Matched');
    assert.deepEqual(det.agreement.parties.map((p) => Number(p.share_pct)), [66.6667, 33.3333]);
    const proj = await call(coop.token, 'POST', '/coop-lending/bank-accounts', { purpose: 'loan_dedicated', bank_code: '034', account_no: '6556667778', account_name: coop.name }, 201);
    const s1 = await call(coop.token, 'POST', `/coop-lending/market/listings/${listing.listing_id}/agreement/sign`, { file_id: await upload(coop.token), project_account_id: proj.account_id });
    assert.equal(s1.status, 'Drafted');
    assert.equal(s1.pending.lenders.length, 2);
    await call(sav.token, 'POST', `/savings/market/agreements/${agreement.agreement_id}/sign`, { file_id: await upload(sav.token) });
    const done = await call(U2, 'POST', `/savings/market/agreements/${agreement.agreement_id}/sign`, { file_id: await upload(cu.token) });
    assert.equal(done.status, 'Signed');
    const facs = await call(coop.token, 'GET', '/coop-lending/facilities');
    const mine = facs.filter((f) => f.listing_id === listing.listing_id);
    assert.equal(mine.length, 2);
    assert.ok(mine.every((f) => f.dedicated_account_id === proj.account_id));
    assert.equal(Number(mine.find((f) => f.lender_name === sav.name).rate_pct), 4.5);
    assert.ok(!(await call(sav.token, 'GET', '/savings/programs')).some((p) => p.listing_id === listing.listing_id), 'internal programs stay hidden');
    // the facility works with the existing crop-plan / item flow: purposes come from the project type
    assert.deepEqual(mine[0].purposes.sort(), ['inputs', 'machinery_service']);
    const g = await call(GOV, 'GET', '/gov/coop-lending/market');
    assert.ok(g.listings.some((l) => l.listing_id === listing.listing_id && l.lenders.includes(sav.name)));
    assert.ok(g.flow.signed >= 1);
    assert.ok(g.flow.syndicated >= 1);
    assert.equal(g.national_counts.credit_unions, 587);
    assert.ok(g.controls && g.controls.tranches >= 2);
  });

  await t.test('tranches: one open at a time, reconcile before the next opens, checker ≠ approver; verification level; go-live gates', async () => {
    const det = await call(coop.token, 'GET', `/coop-lending/market/listings/${listing.listing_id}`);
    assert.deepEqual(det.tranches.map((x) => [x.seq, x.status, Number(x.amount)]), [[1, 'Open', 1800000], [2, 'Locked', 1200000]]);
    assert.equal(det.tranches[0].lead_lender_org_id, sav.id);
    assert.ok(det.performance && det.performance.factors.length === 5);
    const facs = (await call(coop.token, 'GET', '/coop-lending/facilities')).filter((f) => f.listing_id === listing.listing_id);
    const fs = facs.find((f) => f.lender_name === sav.name);
    const fc = facs.find((f) => f.lender_name === cu.name);
    const empty = await call(coop.token, 'POST', `/coop-lending/market/listings/${listing.listing_id}/tranches/1/submit`, {}, 409);
    assert.equal(empty.error, 'tranche_not_ready');
    const mk = (f, amount) => call(coop.token, 'POST', '/coop-lending/items', {
      facility_id: f.facility_id, purpose: 'inputs', source_type: 'manual', seller_type: 'organization', seller_id: supplier.id, amount, description: 'ปุ๋ยงวด 1',
    }, 201);
    const i1 = await mk(fs, 1000000);
    assert.equal(i1.tranche_seq, 1);
    const i2 = await mk(fc, 700000);
    const over = await call(coop.token, 'POST', '/coop-lending/items', {
      facility_id: fs.facility_id, purpose: 'inputs', source_type: 'manual', seller_type: 'organization', seller_id: supplier.id, amount: 200000, description: 'เกินงวด',
    }, 409);
    assert.equal(over.error, 'over_tranche_amount');
    assert.equal(over.available, 100000);
    const pending = await call(coop.token, 'POST', `/coop-lending/market/listings/${listing.listing_id}/tranches/1/submit`, {}, 409);
    assert.ok(pending.blockers.some((b) => /ยังไม่ได้จ่ายผู้ขาย/.test(b)));
    // ส่วนโอนเงินจริงทดสอบใน coopLending.db.test.js — ที่นี่จำลองว่าจ่ายผู้ขายแล้ว
    await db.query(`UPDATE coop_lending.disbursement_item SET status = 'Paid', paid_at = now() WHERE item_id = ANY($1)`, [[i1.item_id, i2.item_id]]);
    const insp = await call(ADMIN, 'POST', `/admin/coop-lending/items/${i1.item_id}/inspection`, { inspector: 'ผู้ตรวจสอบกิจการ จ.สุรินทร์', result: 'pass', note: 'ตรวจโกดังพบปุ๋ยครบ' }, 201);
    assert.equal(insp.verification.level, 5);
    const sub = await call(coop.token, 'POST', `/coop-lending/market/listings/${listing.listing_id}/tranches/1/submit`, { sales_amount: 0, note: 'แจกจ่ายปุ๋ยให้สมาชิกครบ 120 ราย' });
    assert.equal(sub.status, 'Submitted');
    assert.equal(sub.reconciliation.paid_items, 2);
    assert.ok((await call(sav.token, 'GET', '/savings/notices')).some((n) => n.kind === 'tranche_review'));
    const aid = agreement.agreement_id;
    await call(cu.token, 'POST', `/savings/market/agreements/${aid}/tranches/1/check`, {}, 403); // ไม่ใช่ผู้ให้กู้หลัก
    await call(sav.token, 'POST', `/savings/market/agreements/${aid}/tranches/1/approve`, {}, 409); // ยังไม่ตรวจ
    await call(sav.token, 'POST', `/savings/market/agreements/${aid}/tranches/1/check`, { note: 'เอกสารครบ' });
    assert.equal((await call(sav.token, 'POST', `/savings/market/agreements/${aid}/tranches/1/approve`, {}, 409)).error, 'approver_must_differ_from_checker');
    const ap = await call(S2, 'POST', `/savings/market/agreements/${aid}/tranches/1/approve`);
    assert.equal(ap.tranche.status, 'Verified');
    assert.equal(ap.next_open.seq, 2);
    assert.equal((await mk(fc, 500000)).tranche_seq, 2);
    const lv = await call(sav.token, 'GET', `/savings/market/listings/${listing.listing_id}`);
    assert.deepEqual(lv.tranches.map((x) => x.status), ['Verified', 'Open']);
    // ข้อเสนอที่กลายเป็นวงเงินแล้วไม่นับซ้ำในวงเงินที่ใช้ไป
    const cs = await call(sav.token, 'GET', '/savings/market/compliance');
    assert.match(cs.status.checks.find((c) => c.code === 'approved_limit').detail, /ใช้ไปแล้ว 2,000,000 จาก/);
    const gl = await call(ADMIN, 'GET', '/admin/coop-lending/market/golive');
    assert.equal(gl.gates.length, 8);
    assert.ok(gl.lenders_passed >= 2);
  });
});
