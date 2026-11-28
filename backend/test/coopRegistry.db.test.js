/*
 * End-to-end: ทะเบียนสหกรณ์ล่วงหน้า — real HTTP API + real PostgreSQL (grant_coop_registry.sql).
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
const JWT_SECRET = `cr-test-${crypto.randomBytes(8).toString('hex')}`;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const png = () => Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), crypto.randomBytes(8)]).toString('base64');
const tax13 = () => `09${String(crypto.randomInt(1e9)).padStart(9, '0')}${String(crypto.randomInt(100)).padStart(2, '0')}`;

test('coop directory: import (preview → commit, idempotent) → claim → admin approve/reject/link/provision → official financials → fraud signal → DPD coverage', { skip: SKIP, timeout: 120000 }, async (t) => {
  // eslint-disable-next-line global-require
  const { Client } = require('pg');
  // eslint-disable-next-line global-require
  const jwt = require('jsonwebtoken');
  const db = new Client();
  await db.connect();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test', STORAGE_ROOT: path.join(os.tmpdir(), `cr-store-${port}`) },
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
  const org = async (type, name, tax) => {
    const id = crypto.randomUUID();
    await db.query(`INSERT INTO identity.organization (org_id, org_type, org_name, tax_id, kyb_status, region_code) VALUES ($1,$2,$3,$4,'Verified','TH-32')`, [id, type, name, tax]);
    await db.query(`INSERT INTO identity.subject_role (subject_type, subject_id, role_code) VALUES ('organization',$1,'org.admin')`, [id]);
    await db.query(`INSERT INTO identity.organization_role (org_id, role_type, status) VALUES ($1,$2,'Verified')`, [id, type]).catch(() => {});
    return { id, name, tax, token: sign('organization', id) };
  };
  const ADMIN = jwt.sign({ subjectType: 'platform' }, JWT_SECRET);
  const officerId = (await db.query('SELECT identity.register_government_officer($1,$2,$3,$4,$5,$6,$7,$8) AS id',
    ['เจ้าหน้าที่สุรินทร์ทะเบียน', crypto.randomBytes(16).toString('hex'), 'Province', 'SURIN', `oidc|g-${crypto.randomUUID()}`, 'gov.provincial_admin', 'CPD', 'test'])).rows[0].id;
  const GOV = sign('government_officer', officerId);
  const upload = async (token) => (await call(token, 'POST', '/storage/upload', {
    purpose: 'coop_lending_evidence', filename: 'auth.png', content_type: 'image/png', file_base64: png(), uploaded_by: 'test',
  }, 201)).file_id;

  const taxA = tax13(); const taxS = tax13(); const taxP = tax13();
  const nameA = `สหกรณ์การเกษตรทะเบียนทดสอบ ${tag} จำกัด`;
  const nameS = `สหกรณ์ออมทรัพย์ทะเบียนทดสอบ ${tag} จำกัด`;
  const nameP = `สหกรณ์การเกษตรจัดตั้งจากทะเบียน ${tag} จำกัด`;
  const nameX = `สหกรณ์การเกษตรเลิกแล้ว ${tag} จำกัด`;
  const regA = `สร A${tag}`; const regS = `สร S${tag}`; const regP = `สร P${tag}`; const regX = `สร X${tag}`;
  const csv = [
    'ชื่อสหกรณ์,เลขทะเบียน,เลขประจำตัวผู้เสียภาษี,ประเภท,จังหวัด,อำเภอ,ปีที่จดทะเบียน,จำนวนสมาชิก,สถานะ',
    `${nameA},${regA},${taxA},การเกษตร,สุรินทร์,เมืองสุรินทร์,2520,820,ดำเนินการ`,
    `${nameS},${regS},${taxS},ออมทรัพย์,สุรินทร์,เมืองสุรินทร์,2510,3200,ดำเนินการ`,
    `${nameP},${regP},${taxP},การเกษตร,จ.สุรินทร์,ปราสาท,1985,450,`,
    `${nameX},${regX},,การเกษตร,สุรินทร์,,2500,,ถอนชื่อออกจากทะเบียน`,
    `แถวผิด ${tag},,,การเกษตร,ไม่มีจังหวัด,,,,`,
  ].join('\n');
  const b64 = (s) => Buffer.from(`﻿${s}`, 'utf8').toString('base64');
  const SRC = 'กรมส่งเสริมสหกรณ์ ทะเบียน ณ 30 ก.ย. 2569 (ทดสอบ)';
  let A; let S; let P; let X;

  await t.test('admin import: preview shows verdicts → commit inserts → same file again = all unchanged', async () => {
    const tpl = await fetch(`${base}/admin/coop-lending/registry/template/directory`, { headers: { Authorization: `Bearer ${ADMIN}` } });
    assert.equal(tpl.status, 200);
    assert.match(await tpl.text(), /ชื่อสหกรณ์,เลขทะเบียน/);
    await call(ADMIN, 'POST', '/admin/coop-lending/registry/imports/preview', { kind: 'directory', filename: 'd.csv', content_base64: b64('ชื่อ,ประเภท\nก,ข'), source_label: SRC }, 400);
    const pv = await call(ADMIN, 'POST', '/admin/coop-lending/registry/imports/preview', { kind: 'directory', filename: 'cpd.csv', content_base64: b64(csv), source_label: SRC, as_of: '2026-09-30' });
    assert.deepEqual([pv.summary.new_count, pv.summary.error_count], [4, 1]);
    assert.equal(pv.rows[4].errors[0].code, 'unknown_province');
    assert.equal(pv.rows[2].data.established_year, 2528);
    const cm = await call(ADMIN, 'POST', `/admin/coop-lending/registry/imports/${pv.import_id}/commit`);
    assert.deepEqual(cm.counts, { inserted: 4, updated: 0, same: 0, skipped_error: 1 });
    await call(ADMIN, 'POST', `/admin/coop-lending/registry/imports/${pv.import_id}/commit`, {}, 409);
    const again = await call(ADMIN, 'POST', '/admin/coop-lending/registry/imports/preview', { kind: 'directory', filename: 'cpd.csv', content_base64: b64(csv), source_label: SRC });
    assert.equal(again.summary.same_count, 4);
    assert.ok(again.same_file_committed_at);
    await call(ADMIN, 'POST', `/admin/coop-lending/registry/imports/${again.import_id}/discard`);
    // แก้จำนวนสมาชิก 1 ราย → update เฉพาะช่องนั้น
    const upd = await call(ADMIN, 'POST', '/admin/coop-lending/registry/imports/preview', {
      kind: 'directory', filename: 'u.csv', content_base64: b64(`ชื่อสหกรณ์,เลขทะเบียน,จังหวัด,จำนวนสมาชิก\n${nameA},${regA},สุรินทร์,850`), source_label: SRC,
    });
    assert.deepEqual(upd.rows[0].changes, [{ field: 'member_count', from: 820, to: 850 }]);
    assert.deepEqual((await call(ADMIN, 'POST', `/admin/coop-lending/registry/imports/${upd.import_id}/commit`)).counts.updated, 1);
    const list = await call(ADMIN, 'GET', `/admin/coop-lending/registry?q=${encodeURIComponent(tag)}`);
    assert.equal(list.total, 4);
    const by = (n) => list.rows.find((r) => r.coop_name === n);
    [A, S, P, X] = [by(nameA), by(nameS), by(nameP), by(nameX)];
    assert.equal(A.member_count, 850);
    assert.equal(A.tax_id, taxA); // ไฟล์อัปเดตไม่มีคอลัมน์เลขผู้เสียภาษี → ค่าเดิมยังอยู่
    assert.equal(X.status, 'dissolved');
    assert.equal(S.coop_type, 'savings');
    assert.ok((await call(ADMIN, 'GET', '/admin/coop-lending/registry/imports')).some((i) => i.import_id === pv.import_id && i.status === 'Committed'));
  });

  const coop = await org('Cooperative', nameA, taxA);
  await db.query(`INSERT INTO registry.cooperative_profile (org_id, province_code) VALUES ($1,'SURIN') ON CONFLICT (org_id) DO NOTHING`, [coop.id]);
  const sav = await org('SavingsCooperative', `สหกรณ์ออมทรัพย์ที่สมัครเอง ${tag} จำกัด`, tax13());

  await t.test('cooperatives find their own entry and claim it with an authorization document', async () => {
    const m0 = await call(coop.token, 'GET', '/coop-lending/registry/mine');
    assert.equal(m0.installed, true);
    assert.equal(m0.entry, null);
    await call(coop.token, 'GET', '/coop-lending/registry/search?q=a', undefined, 400);
    const found = await call(coop.token, 'GET', `/coop-lending/registry/search?q=${encodeURIComponent(`ทะเบียนทดสอบ ${tag}`)}`);
    assert.deepEqual(found.map((x) => x.coop_name), [nameA]); // ออมทรัพย์ชื่อคล้ายกันไม่แสดงกับสหกรณ์การเกษตร
    assert.equal(found[0].tax_match, true);
    await call(coop.token, 'POST', '/coop-lending/registry/claims', { directory_id: S.directory_id, file_id: await upload(coop.token), contact_name: 'ผู้จัดการ' }, 409);
    await call(coop.token, 'POST', '/coop-lending/registry/claims', { directory_id: A.directory_id, contact_name: 'ผู้จัดการ' }, 400);
    const cl = await call(coop.token, 'POST', '/coop-lending/registry/claims', { directory_id: A.directory_id, file_id: await upload(coop.token), contact_name: 'นางผู้จัดการ ทดสอบ', contact_position: 'ผู้จัดการ' }, 201);
    assert.equal(cl.status, 'Pending');
    await call(coop.token, 'POST', '/coop-lending/registry/claims', { directory_id: P.directory_id, file_id: await upload(coop.token), contact_name: 'ซ้ำ' }, 409);
    const sf = await call(sav.token, 'GET', `/savings/registry/search?q=${encodeURIComponent(regS)}`);
    assert.deepEqual(sf.map((x) => x.coop_name), [nameS]);
    assert.equal(sf[0].tax_match, false);
    await call(sav.token, 'POST', '/savings/registry/claims', { directory_id: S.directory_id, file_id: await upload(sav.token), contact_name: 'นายประธาน ออมทรัพย์' }, 201);
  });

  await t.test('admin: approve (tax id matches) links + fills registration no; reject needs a reason; manual link; provision new borrower account', async () => {
    const claims = await call(ADMIN, 'GET', '/admin/coop-lending/registry/claims?status=Pending');
    const ca = claims.find((x) => x.org_id === coop.id);
    const cs = claims.find((x) => x.org_id === sav.id);
    assert.equal(ca.tax_match, true);
    assert.equal(cs.tax_match, false);
    const f = await fetch(`${base}/admin/coop-lending/registry/claims/${ca.claim_id}/file`, { headers: { Authorization: `Bearer ${ADMIN}` } });
    assert.equal(f.status, 200);
    assert.equal((await call(ADMIN, 'POST', `/admin/coop-lending/registry/claims/${ca.claim_id}/decide`, { status: 'Approved' })).status, 'Approved');
    const mine = await call(coop.token, 'GET', '/coop-lending/registry/mine');
    assert.equal(mine.entry.registration_no, regA);
    assert.equal(mine.entry.link_method, 'claim');
    assert.equal((await db.query('SELECT cooperative_registration_no FROM registry.cooperative_profile WHERE org_id = $1', [coop.id])).rows[0].cooperative_registration_no, regA);
    assert.ok((await call(coop.token, 'GET', '/coop-lending/notices')).some((n) => n.kind === 'registry' && /ยืนยันทะเบียนสหกรณ์แล้ว/.test(n.message)));

    await call(ADMIN, 'POST', `/admin/coop-lending/registry/claims/${cs.claim_id}/decide`, { status: 'Rejected', note: 'สั้น' }, 400);
    await call(ADMIN, 'POST', `/admin/coop-lending/registry/claims/${cs.claim_id}/decide`, { status: 'Rejected', note: 'หนังสือมอบอำนาจไม่มีลายมือชื่อประธาน' });
    assert.ok((await call(sav.token, 'GET', '/savings/notices')).some((n) => n.kind === 'registry' && /ไม่ผ่าน/.test(n.message)));
    // ผู้ดูแลเชื่อมเอง: ประเภทต้องตรง
    assert.equal((await call(ADMIN, 'POST', `/admin/coop-lending/registry/${P.directory_id}/link`, { org_id: sav.id }, 409)).error, 'org_type_mismatch');
    await call(ADMIN, 'POST', `/admin/coop-lending/registry/${S.directory_id}/link`, { org_id: sav.id });
    assert.equal((await call(sav.token, 'GET', '/savings/registry/mine')).entry.coop_name, nameS);
    assert.equal((await call(ADMIN, 'POST', `/admin/coop-lending/registry/${A.directory_id}/link`, { org_id: sav.id }, 409)).error, 'directory_already_linked');
    // จัดตั้งบัญชีสหกรณ์การเกษตรจากทะเบียน
    assert.equal((await call(ADMIN, 'POST', `/admin/coop-lending/registry/${X.directory_id}/provision`, { tax_id: tax13() }, 409)).error, 'directory_not_active');
    assert.equal((await call(ADMIN, 'POST', `/admin/coop-lending/registry/${S.directory_id}/provision`, {}, 409)).error, 'directory_already_linked');
    const pr = await call(ADMIN, 'POST', `/admin/coop-lending/registry/${P.directory_id}/provision`, {}, 201);
    const o = (await db.query(`SELECT o.org_type, o.tax_id, cp.province_code, cp.cooperative_registration_no, cp.established_year FROM identity.organization o
                               JOIN registry.cooperative_profile cp ON cp.org_id = o.org_id WHERE o.org_id = $1`, [pr.org_id])).rows[0];
    assert.deepEqual(o, { org_type: 'Cooperative', tax_id: taxP, province_code: 'SURIN', cooperative_registration_no: regP, established_year: 1985 }); // cooperative_profile เก็บ ค.ศ.
    await call(ADMIN, 'POST', `/admin/coop-lending/registry/${P.directory_id}/provision`, {}, 409);
    const det = await call(ADMIN, 'GET', `/admin/coop-lending/registry/${P.directory_id}`);
    assert.equal(det.entry.link_method, 'provisioned');
  });

  await t.test('official financials import → compared with what the borrower declared → fraud signal; DPD coverage by province', async () => {
    await call(coop.token, 'PUT', '/coop-lending/market/profile', {
      registration_no: regA, member_count: 850, consent_disclose: true, max_borrowing: 10e6,
      financials: [{ year: 2567, total_assets: 80e6, total_liabilities: 40e6, net_income: 3.5e6 }, { year: 2566, net_income: 1.5e6 }],
    });
    const fin = [
      'เลขทะเบียน,ปีบัญชี,สินทรัพย์รวม,หนี้สินรวม,ทุนของสหกรณ์,กำไรสุทธิ',
      `${regA},2567,80000000,40000000,40000000,2000000`,
      `${regA},2566,75000000,38000000,37000000,1500000`,
      `ไม่มีในทะเบียน ${tag},2567,1,1,0,0`,
    ].join('\n');
    const pv = await call(ADMIN, 'POST', '/admin/coop-lending/registry/imports/preview', { kind: 'financials', filename: 'fin.csv', content_base64: b64(fin), source_label: 'งบที่ผู้สอบบัญชีรับรอง (ทดสอบ)' });
    assert.deepEqual(pv.rows.map((r) => r.verdict), ['new', 'new', 'error']);
    assert.deepEqual((await call(ADMIN, 'POST', `/admin/coop-lending/registry/imports/${pv.import_id}/commit`)).counts, { inserted: 2, updated: 0, same: 0, skipped_error: 1 });
    const det = await call(ADMIN, 'GET', `/admin/coop-lending/registry/${A.directory_id}`);
    assert.equal(det.financials.length, 2);
    assert.deepEqual(det.check.mismatches.map((m) => [m.year, m.field, m.diff_pct]), [[2567, 'net_income', 75]]);
    const mine = await call(coop.token, 'GET', '/coop-lending/registry/mine');
    assert.deepEqual(mine.financials.map((x) => x.year), [2567, 2566]);
    await call(ADMIN, 'POST', '/admin/coop-lending/market/risk/sweep');
    const sig = (await call(ADMIN, 'GET', '/admin/coop-lending/market/risk?category=fraud')).alerts.find((a) => a.borrower_org_id === coop.id && a.code === 'fr_official_mismatch');
    assert.ok(sig, 'fr_official_mismatch raised');
    assert.equal(sig.severity, 'high');
    assert.equal(sig.extra.changes[0].from, 2e6);

    const cov = await call(GOV, 'GET', '/gov/coop-lending/registry/coverage');
    assert.equal(cov.province, 'SURIN');
    const agri = cov.by_type.find((x) => x.coop_type === 'agriculture');
    assert.ok(agri.linked >= 2 && agri.in_market >= 1);
    assert.ok(!cov.not_joined.some((x) => [nameA, nameP, nameX, nameS].includes(x.coop_name)), 'linked and dissolved coops are not listed as not-joined');
  });
});
