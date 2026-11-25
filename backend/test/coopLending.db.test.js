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

test('coop lending: program → facility → evidence → 2-person bank transfers → seller paid → repayment, SLA penalty, asset loan', { skip: SKIP, timeout: 120000 }, async (t) => {
  // eslint-disable-next-line global-require
  const { Client } = require('pg');
  // eslint-disable-next-line global-require
  const jwt = require('jsonwebtoken');
  const db = new Client();
  await db.connect();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env, PORT: String(port), JWT_SECRET, NODE_ENV: 'test', STORAGE_ROOT: path.join(os.tmpdir(), `cl-store-${port}`),
    },
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
    await db.query(`INSERT INTO identity.organization (org_id, org_type, org_name, tax_id, kyb_status, region_code) VALUES ($1,$2,$3,$4,'Verified','TH-30')`,
      [id, type, name, `C${Date.now()}${crypto.randomBytes(3).toString('hex')}`.slice(0, 20)]);
    await db.query(`INSERT INTO identity.subject_role (subject_type, subject_id, role_code) VALUES ('organization',$1,'org.admin')`, [id]);
    return { id, name, token: sign('organization', id) };
  };
  const staff = async (orgId, roleCode, name) => {
    const id = (await db.query('SELECT identity.register_staff_member($1,$2,$3,$4,$5,$6) AS id',
      [orgId, name, crypto.randomBytes(16).toString('hex'), `oidc|staff-${crypto.randomUUID()}`, roleCode, 'test'])).rows[0].id;
    return sign('organization_member', id);
  };
  const savings = await org('SavingsCooperative', `สหกรณ์ออมทรัพย์ครูทดสอบ ${tag} จำกัด`);
  const coop = await org('Cooperative', `สหกรณ์การเกษตรทดสอบสินเชื่อ ${tag} จำกัด`);
  const supplier = await org('InputSupplier', `ร้านปุ๋ยทดสอบ ${tag}`);
  const dealer = await org('InputSupplier', `ตัวแทนรถไถทดสอบ ${tag}`);
  const S2 = await staff(savings.id, 'coop.credit_officer', 'นางสาวผู้อนุมัติ ออมทรัพย์');
  const C2 = await staff(coop.id, 'coop.manager', 'นายผู้จัดการ สหกรณ์');
  // farmer member with a plot that Plot AI flagged
  const farmerId = crypto.randomUUID();
  await db.query(`INSERT INTO identity.farmer (farmer_id, national_id_hash, full_name, phone, region_code, trust_score, status, farmer_code)
                  VALUES ($1,$2,$3,$4,'TH-30',50,'active',$5)`, [farmerId, crypto.randomBytes(16).toString('hex'), `สมชาย ทดสอบ${tag}`, `08${Date.now() % 1e8}`.padEnd(10, '0').slice(0, 10), `F${tag}${Date.now() % 1e6}`]);
  await db.query(`INSERT INTO identity.subject_role (subject_type, subject_id, role_code) VALUES ('farmer',$1,'farmer.self') ON CONFLICT DO NOTHING`, [farmerId]).catch(() => {});
  await db.query("SELECT identity.link_farmer_to_org($1,$2,'organization',$2,'test')", [farmerId, coop.id]);
  const F = sign('farmer', farmerId);
  const unitId = (await db.query(
    `INSERT INTO registry.production_unit (owner_farmer_id, unit_type, gps_boundary, area_rai, commodity_code, season_id)
     VALUES ($1,'Plot', ST_GeomFromText('POLYGON((102.1 14.9,102.101 14.9,102.101 14.901,102.1 14.901,102.1 14.9))',4326), 10, 'RICE_PADDY', '2026/27') RETURNING unit_id`, [farmerId],
  )).rows[0].unit_id;
  await db.query(`INSERT INTO ai.plot_assessment (unit_id, as_of, risk_level, flags, result, assessed_by_type)
                  VALUES ($1, current_date, 'medium', $2, '{}', 'platform')`, [unitId, JSON.stringify([{ code: 'NO_CROP_CYCLE', severity: 'medium', message_th: 'ไม่พบรอบการปลูก' }])]);
  await db.query(`INSERT INTO partner.vendor_profile (org_id, business_registration_no, commercial_status) VALUES ($1, $2, 'active')`, [supplier.id, `BR${tag}`]);
  const listing = (await db.query(`INSERT INTO marketplace.product_listing (org_id, category, product_name, unit_price) VALUES ($1,'fertilizer_hormone','ปุ๋ย 16-16-8',850) RETURNING listing_id`, [supplier.id])).rows[0].listing_id;
  const orderId = (await db.query(
    `INSERT INTO marketplace.product_order (listing_id, org_id, farmer_id, product_name, category, unit_price, price_unit, quantity, total_price, status)
     VALUES ($1,$2,$3,'ปุ๋ย 16-16-8','fertilizer_hormone',850,'กระสอบ',100,85000,'confirmed') RETURNING order_id`, [listing, supplier.id, farmerId],
  )).rows[0].order_id;
  const admin = jwt.sign({ subjectType: 'platform' }, JWT_SECRET);
  const upload = async (token, owner) => (await call(token, 'POST', '/storage/upload', {
    purpose: 'coop_lending_evidence', filename: 'e.png', content_type: 'image/png', file_base64: png(), uploaded_by: owner,
  }, 201)).file_id;

  let program; let facility; let soAcc; let ded; let cop; let payout; let item;
  await t.test('accounts are verified by name; programs and facility', async () => {
    const bad = await call(savings.token, 'POST', '/savings/bank-accounts', { bank_code: '006', account_no: '1234567890', account_name: 'ชื่ออื่น' }, 201);
    assert.equal(bad.verification_status, 'Failed');
    soAcc = await call(savings.token, 'POST', '/savings/bank-accounts', { bank_code: '006', account_no: '1234567891', account_name: savings.name }, 201);
    assert.equal(soAcc.verification_status, 'Verified');
    assert.equal(soAcc.account_no_masked, 'xxx-x-67891');
    program = await call(savings.token, 'POST', '/savings/programs', {
      name: 'ปัจจัยการผลิตฤดูนาปี', purposes: ['inputs', 'procurement', 'asset'], total_limit: 2000000, per_borrower_limit: 1500000, rate_pct: 4.5, asset_min_down_pct: 15,
    }, 201);
    const visible = await call(coop.token, 'GET', '/coop-lending/programs');
    assert.ok(visible.some((p) => p.program_id === program.program_id));
    await call(supplier.token, 'GET', '/coop-lending/programs', undefined, 403); // wrong org type
    await call(coop.token, 'GET', '/savings/overview', undefined, 403);
    const app = await call(coop.token, 'POST', '/coop-lending/applications', { program_id: program.program_id, requested_amount: 1200000, member_count: 120 }, 201);
    await call(coop.token, 'POST', '/coop-lending/applications', { program_id: program.program_id, requested_amount: 1000 }, 409);
    const apps = await call(savings.token, 'GET', '/savings/applications');
    assert.equal(apps.find((a) => a.application_id === app.application_id).verified_members, 1);
    facility = await call(S2, 'POST', `/savings/applications/${app.application_id}/approve`, { limit_amount: 1200000 }, 201);
    ded = await call(coop.token, 'POST', '/coop-lending/bank-accounts', { purpose: 'loan_dedicated', bank_code: '030', account_no: '2234567890', account_name: coop.name }, 201);
    cop = await call(coop.token, 'POST', '/coop-lending/bank-accounts', { purpose: 'operating', bank_code: '030', account_no: '2234567899', account_name: coop.name }, 201);
    await call(coop.token, 'PATCH', `/coop-lending/facilities/${facility.facility_id}`, { dedicated_account_id: ded.account_id, member_rate_pct: 6.5 });
    payout = await call(coop.token, 'POST', '/coop-lending/payout-accounts', { seller_type: 'organization', seller_id: supplier.id, bank_code: '004', account_no: '3234567890', account_name: supplier.name }, 201);
    assert.equal(payout.verification_status, 'Verified');
  });

  await t.test('item from a confirmed order: evidence, one-time file, farmer confirms, satellite review', async () => {
    const src = await call(coop.token, 'GET', '/coop-lending/sources?purpose=inputs');
    assert.ok(src.some((s) => s.id === orderId));
    item = await call(coop.token, 'POST', '/coop-lending/items', {
      facility_id: facility.facility_id, purpose: 'inputs', source_type: 'product_order', source_id: orderId, description: 'ปุ๋ย 100 กระสอบ', doc_no: 'INV-001', payout_account_id: payout.account_id, unit_ids: [unitId], amount: 1,
    }, 201);
    assert.equal(Number(item.amount), 85000); // amount comes from the order, not the request
    assert.equal(item.seller_id, supplier.id);
    await call(coop.token, 'POST', '/coop-lending/items', { facility_id: facility.facility_id, purpose: 'inputs', source_type: 'product_order', source_id: orderId, description: 'ซ้ำ' }, 409);
    assert.equal((await call(coop.token, 'POST', `/coop-lending/items/${item.item_id}/submit`, {}, 400)).missing.missingKinds[0], 'invoice');
    const fileId = await upload(coop.token, 'test');
    await call(coop.token, 'POST', `/coop-lending/items/${item.item_id}/evidence`, { kind: 'invoice', file_id: fileId, doc_no: 'INV-001' }, 201);
    await call(supplier.token, 'POST', `/coop-lending/items/${item.item_id}/evidence`, { kind: 'invoice', file_id: fileId }, 403);
    const sub = await call(C2, 'POST', `/coop-lending/items/${item.item_id}/submit`, {});
    assert.equal(sub.status, 'EvidencePending'); // farmer has not confirmed
    const mine = await call(F, 'GET', '/farmer-lending/items');
    assert.equal(mine[0].item_id, item.item_id);
    assert.equal(Number(mine[0].member_rate_pct), 6.5);
    const done = await call(F, 'POST', `/farmer-lending/items/${item.item_id}/confirm`, { note: 'ได้รับครบ' });
    assert.equal(done.status, 'EvidenceComplete');
    assert.ok(done.sc_due_date);
    await call(F, 'POST', `/farmer-lending/items/${item.item_id}/confirm`, {}, 409);
    const q = await call(savings.token, 'GET', '/savings/items');
    const qi = q.find((x) => x.item_id === item.item_id);
    assert.equal(qi.satellite_result, 'review');
    assert.equal(qi.satellite_detail.flags[0].code, 'NO_CROP_CYCLE');
  });

  let transfer;
  await t.test('disbursement needs satellite acknowledgement and two different people', async () => {
    await call(savings.token, 'POST', '/savings/transfers/prepare', { item_ids: [item.item_id], from_account_id: soAcc.account_id }, 409);
    await call(savings.token, 'POST', `/savings/items/${item.item_id}/ack-satellite`, {});
    transfer = await call(savings.token, 'POST', '/savings/transfers/prepare', { item_ids: [item.item_id], from_account_id: soAcc.account_id }, 201);
    assert.equal(Number(transfer.amount), 85000);
    await call(savings.token, 'POST', '/savings/transfers/prepare', { item_ids: [item.item_id], from_account_id: soAcc.account_id }, 409);
    assert.equal((await call(savings.token, 'POST', `/savings/transfers/${transfer.transfer_id}/approve`, {}, 409)).error, 'approver_must_differ_from_preparer');
    const ok = await call(S2, 'POST', `/savings/transfers/${transfer.transfer_id}/approve`, {});
    assert.equal(ok.status, 'Succeeded');
    assert.match(ok.bank_ref, /^SBX-/);
    const it = (await call(coop.token, 'GET', '/coop-lending/items')).find((x) => x.item_id === item.item_id);
    assert.equal(it.status, 'Funded');
    assert.equal(Number(it.principal_outstanding), 85000);
    assert.ok(it.ac_due_date);
  });

  await t.test('cooperative pays the seller from the dedicated account (also two people)', async () => {
    const tr = await call(C2, 'POST', '/coop-lending/transfers/prepare-seller', { item_id: item.item_id }, 201);
    assert.equal(Number(tr.amount), 85000);
    await call(C2, 'POST', `/coop-lending/transfers/${tr.transfer_id}/approve`, {}, 409);
    assert.equal((await call(coop.token, 'POST', `/coop-lending/transfers/${tr.transfer_id}/approve`, {})).status, 'Succeeded');
    assert.equal((await call(coop.token, 'GET', '/coop-lending/items')).find((x) => x.item_id === item.item_id).status, 'Paid');
  });

  await t.test('repayment: interest accrues daily, overdue days at 10%, interest first then principal', async () => {
    // pretend the money went out 200 days ago (tenor 180 → 20 days overdue)
    await db.query(`UPDATE coop_lending.disbursement_item SET interest_accrued_to = current_date - 200, funded_at = now() - interval '200 days', loan_due_date = current_date - 20 WHERE item_id = $1`, [item.item_id]);
    const debt = await call(coop.token, 'GET', `/coop-lending/facilities/${facility.facility_id}/debt`);
    const expected = Math.round((85000 * 0.045 * 180 / 365 + 85000 * 0.10 * 20 / 365) * 100) / 100;
    assert.ok(Math.abs(debt.interest - expected) <= 0.02, `${debt.interest} vs ${expected}`);
    assert.equal(debt.items[0].overdue, true);
    await call(coop.token, 'POST', '/coop-lending/transfers/prepare-repayment', { facility_id: facility.facility_id, from_account_id: cop.account_id, amount: debt.total + 100 }, 409);
    await call(savings.token, 'POST', '/savings/transfers/prepare', { item_ids: [item.item_id], from_account_id: soAcc.account_id }, 409);
    const tr = await call(coop.token, 'POST', '/coop-lending/transfers/prepare-repayment', { facility_id: facility.facility_id, from_account_id: cop.account_id, amount: debt.total }, 201);
    await call(C2, 'POST', `/coop-lending/transfers/${tr.transfer_id}/approve`, {});
    const after = await call(coop.token, 'GET', `/coop-lending/facilities/${facility.facility_id}/debt`);
    assert.equal(after.total, 0);
    const rep = await call(savings.token, 'GET', '/savings/repayments');
    assert.ok(Math.abs(Number(rep[0].interest_part) - expected) <= 0.02);
    assert.equal(Number(rep[0].principal_part), 85000);
  });

  await t.test('late savings coop: dunning notice + 10% penalty paid through to the seller; fee charged to the savings coop', async () => {
    await call(admin, 'PUT', '/admin/coop-lending/settings', { fee_pct: 0.5 });
    const o2 = (await db.query(
      `INSERT INTO marketplace.product_order (listing_id, org_id, farmer_id, product_name, category, unit_price, price_unit, quantity, total_price, status)
       VALUES ($1,$2,$3,'ปุ๋ย 46-0-0','fertilizer_hormone',730,'กระสอบ',100,73000,'fulfilled') RETURNING order_id`, [listing, supplier.id, farmerId],
    )).rows[0].order_id;
    const it2 = await call(coop.token, 'POST', '/coop-lending/items', {
      facility_id: facility.facility_id, purpose: 'inputs', source_type: 'product_order', source_id: o2, description: 'ปุ๋ยยูเรีย', payout_account_id: payout.account_id,
    }, 201);
    await call(coop.token, 'POST', `/coop-lending/items/${it2.item_id}/evidence`, { kind: 'invoice', file_id: await upload(coop.token, 't') }, 201);
    await call(coop.token, 'POST', `/coop-lending/items/${it2.item_id}/submit`, {});
    await call(F, 'POST', `/farmer-lending/items/${it2.item_id}/confirm`, {});
    await db.query('UPDATE coop_lending.disbursement_item SET sc_due_date = current_date - 3 WHERE item_id = $1', [it2.item_id]);
    await db.query(`DELETE FROM coop_lending.holiday WHERE holiday_date = current_date`);
    const sweep = await call(admin, 'POST', '/admin/coop-lending/sla-sweep', {});
    const notices = await call(savings.token, 'GET', '/savings/notices');
    const weekday = ![0, 6].includes(new Date(Date.now() + 7 * 3600e3).getUTCDay());
    if (weekday) assert.ok(notices.some((n) => n.kind === 'sc_transfer_late' && n.item_id === it2.item_id), JSON.stringify(sweep));
    const tr = await call(savings.token, 'POST', '/savings/transfers/prepare', { item_ids: [it2.item_id], from_account_id: soAcc.account_id }, 201);
    const pen = Math.round(73000 * 0.10 * 3 / 365 * 100) / 100;
    assert.equal(Number(tr.penalty_amount), pen);
    assert.equal(Number(tr.amount), 73000 + pen);
    assert.equal(Number(tr.fee_amount), 365);
    await call(S2, 'POST', `/savings/transfers/${tr.transfer_id}/approve`, {});
    const fees = await call(savings.token, 'GET', '/savings/fees');
    assert.equal(fees.total_fee, 365);
    const sp = await call(coop.token, 'POST', '/coop-lending/transfers/prepare-seller', { item_id: it2.item_id }, 201);
    assert.equal(Number(sp.amount), 73000 + pen); // the seller receives the savings coop's late penalty
    const it2row = (await call(coop.token, 'GET', '/coop-lending/items')).find((x) => x.item_id === it2.item_id);
    assert.equal(Number(it2row.principal_outstanding), 73000); // penalty is not loan principal
    await call(admin, 'PUT', '/admin/coop-lending/settings', { fee_pct: 0 });
  });

  await t.test('farmer can dispute: the item stops', async () => {
    const o3 = (await db.query(
      `INSERT INTO marketplace.product_order (listing_id, org_id, farmer_id, product_name, category, unit_price, price_unit, quantity, total_price, status)
       VALUES ($1,$2,$3,'ยาฆ่าแมลง','fertilizer_hormone',100,'ขวด',10,1000,'confirmed') RETURNING order_id`, [listing, supplier.id, farmerId],
    )).rows[0].order_id;
    const it3 = await call(coop.token, 'POST', '/coop-lending/items', { facility_id: facility.facility_id, purpose: 'inputs', source_type: 'product_order', source_id: o3, description: 'ยาฆ่าแมลง', payout_account_id: payout.account_id }, 201);
    await call(coop.token, 'POST', `/coop-lending/items/${it3.item_id}/evidence`, { kind: 'invoice', file_id: await upload(coop.token, 't') }, 201);
    await call(coop.token, 'POST', `/coop-lending/items/${it3.item_id}/submit`, {});
    assert.equal((await call(F, 'POST', `/farmer-lending/items/${it3.item_id}/dispute`, { reason: 'ยังไม่ได้รับของ' })).status, 'Disputed');
  });

  await t.test('machinery loan: affordability, approval, evidence, funding activates the installment schedule', async () => {
    const tooHigh = { facility_id: facility.facility_id, buyer_type: 'cooperative', asset_kind: 'รถแทรกเตอร์', brand_model: 'รุ่นทดสอบ 50 แรงม้า', seller_org_id: dealer.id, price: 850000, down_payment: 127500, term_months: 36, interval_months: 6, income_per_period: 200000, income_basis: 'รับจ้างไถ 1,500 ไร่ต่อฤดู × 150 บาท', serial_no: `SN-${tag}` };
    const p = await call(coop.token, 'POST', '/coop-lending/asset-loans/preview', tooHigh);
    assert.equal(p.installment, 130075.26);
    assert.equal(p.ok, false);
    await call(coop.token, 'POST', '/coop-lending/asset-loans', tooHigh, 409);
    await call(coop.token, 'POST', '/coop-lending/asset-loans', { ...tooHigh, down_payment: 50000, income_per_period: 300000 }, 400); // down < 15%
    const loan = await call(coop.token, 'POST', '/coop-lending/asset-loans', { ...tooHigh, income_per_period: 300000 }, 201);
    assert.equal(Number(loan.loan_amount), 722500);
    await call(S2, 'POST', `/savings/asset-loans/${loan.asset_loan_id}/approve`, {});
    const dp = await call(coop.token, 'POST', '/coop-lending/payout-accounts', { seller_type: 'organization', seller_id: dealer.id, bank_code: '014', account_no: '4234567890', account_name: dealer.name }, 201);
    const it = await call(coop.token, 'POST', '/coop-lending/items', { facility_id: facility.facility_id, purpose: 'asset', source_type: 'asset_loan', source_id: loan.asset_loan_id, description: 'รถแทรกเตอร์ศูนย์บริการ', payout_account_id: dp.account_id, doc_no: 'TX-01' }, 201);
    assert.equal(Number(it.amount), 722500);
    for (const kind of ['contract', 'down_payment_slip', 'serial_photo']) {
      await call(coop.token, 'POST', `/coop-lending/items/${it.item_id}/evidence`, { kind, file_id: await upload(coop.token, 't') }, 201);
    }
    assert.deepEqual((await call(coop.token, 'POST', `/coop-lending/items/${it.item_id}/submit`, {}, 400)).missing.missingKinds, ['invoice']);
    await call(coop.token, 'POST', `/coop-lending/items/${it.item_id}/evidence`, { kind: 'invoice', file_id: await upload(coop.token, 't') }, 201);
    assert.equal((await call(coop.token, 'POST', `/coop-lending/items/${it.item_id}/submit`, {})).status, 'EvidenceComplete'); // coop-owned: no farmer step
    const tr = await call(savings.token, 'POST', '/savings/transfers/prepare', { item_ids: [it.item_id], from_account_id: soAcc.account_id }, 201);
    await call(S2, 'POST', `/savings/transfers/${tr.transfer_id}/approve`, {});
    const loans = await call(coop.token, 'GET', '/coop-lending/asset-loans');
    const l = loans.find((x) => x.asset_loan_id === loan.asset_loan_id);
    assert.equal(l.status, 'Active');
    assert.equal(l.schedule.length, 6);
    assert.equal(Number(l.schedule[0].installment), 130075.26);
    // first installment 10 days late → 10% default interest on top
    await db.query(`UPDATE coop_lending.repayment_schedule SET due_date = current_date - 10 WHERE asset_loan_id = $1 AND seq = 1`, [loan.asset_loan_id]);
    const l2 = (await call(coop.token, 'GET', '/coop-lending/asset-loans')).find((x) => x.asset_loan_id === loan.asset_loan_id);
    const pen = Math.round(130075.26 * 0.10 * 10 / 365 * 100) / 100;
    assert.equal(l2.due[0].penalty, pen);
    const pay = await call(coop.token, 'POST', '/coop-lending/transfers/prepare-installment', { asset_loan_id: loan.asset_loan_id, from_account_id: cop.account_id, amount: L2(130075.26 + pen) }, 201);
    await call(C2, 'POST', `/coop-lending/transfers/${pay.transfer_id}/approve`, {});
    const sched = (await db.query('SELECT * FROM coop_lending.repayment_schedule WHERE asset_loan_id = $1 ORDER BY seq', [loan.asset_loan_id])).rows;
    assert.equal(Number(sched[0].paid_amount), 130075.26);
    assert.equal(Number(sched[0].penalty_paid), pen);
    assert.equal(Number(sched[1].paid_amount), 0);
    // the same serial number cannot back a second loan
    await call(coop.token, 'POST', '/coop-lending/asset-loans', { ...tooHigh, income_per_period: 300000 }, 409);
  });

  await t.test('bank failure keeps the item where it was', async () => {
    const bad = await call(savings.token, 'POST', '/savings/bank-accounts', { bank_code: '006', account_no: '0001234567', account_name: savings.name }, 201);
    const o4 = (await db.query(
      `INSERT INTO marketplace.product_order (listing_id, org_id, farmer_id, product_name, category, unit_price, price_unit, quantity, total_price, status)
       VALUES ($1,$2,$3,'เมล็ดพันธุ์','fertilizer_hormone',100,'ถุง',10,1000,'confirmed') RETURNING order_id`, [listing, supplier.id, farmerId],
    )).rows[0].order_id;
    const it4 = await call(coop.token, 'POST', '/coop-lending/items', { facility_id: facility.facility_id, purpose: 'inputs', source_type: 'product_order', source_id: o4, description: 'เมล็ดพันธุ์', payout_account_id: payout.account_id }, 201);
    await call(coop.token, 'POST', `/coop-lending/items/${it4.item_id}/evidence`, { kind: 'invoice', file_id: await upload(coop.token, 't') }, 201);
    await call(coop.token, 'POST', `/coop-lending/items/${it4.item_id}/submit`, {});
    await call(F, 'POST', `/farmer-lending/items/${it4.item_id}/confirm`, {});
    await call(savings.token, 'POST', `/savings/items/${it4.item_id}/ack-satellite`, {});
    const tr = await call(savings.token, 'POST', '/savings/transfers/prepare', { item_ids: [it4.item_id], from_account_id: bad.account_id }, 201);
    assert.equal((await call(S2, 'POST', `/savings/transfers/${tr.transfer_id}/approve`, {})).status, 'Failed');
    assert.equal((await call(savings.token, 'GET', '/savings/items')).find((x) => x.item_id === it4.item_id).status, 'EvidenceComplete');
    const ov = await call(savings.token, 'GET', '/savings/overview');
    assert.equal(ov.bank.live, false);
  });
});

function L2(v) { return Math.round(v * 100) / 100; }
