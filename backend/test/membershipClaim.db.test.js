/*
 * End-to-end test: a farmer declares cooperative / other-organization membership (at
 * registration or later) and each organization confirms or rejects it — real HTTP API +
 * real PostgreSQL (grant_membership_claim.sql). Same rules as dairy.db.test.js: only runs
 * with DAIRY_DB_TEST=1 against a LOCAL database.
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
const JWT_SECRET = `mc-test-${crypto.randomBytes(8).toString('hex')}`;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

test('membership claims: register → organizations confirm / reject → farmer sees result (database)', { skip: SKIP, timeout: 90000 }, async (t) => {
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
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    assert.equal(res.status, expect, `${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
    return json;
  }

  const tag = crypto.randomBytes(3).toString('hex');
  const org = async (type, name, kyb = 'Verified', region = null) => {
    const id = crypto.randomUUID();
    await db.query(`INSERT INTO identity.organization (org_id, org_type, org_name, tax_id, kyb_status, region_code) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, type, name, `M${Date.now()}${crypto.randomBytes(3).toString('hex')}`.slice(0, 20), kyb, region]);
    await db.query(`INSERT INTO identity.subject_role (subject_type, subject_id, role_code) VALUES ('organization',$1,'org.admin')`, [id]);
    return { id, token: jwt.sign({ subjectType: 'organization', subjectId: id }, JWT_SECRET) };
  };
  const coop = await org('Cooperative', `สหกรณ์การเกษตรทดสอบ ${tag} จำกัด`);
  await db.query(`INSERT INTO registry.cooperative_profile (org_id, province_code) VALUES ($1,'NAKHON_RATCHASIMA')`, [coop.id]);
  const fund = await org('VillageFund', `กองทุนหมู่บ้านทดสอบ ${tag}`, 'Verified', 'TH-30'); // organization.region_code ใช้รหัส ISO
  const unverified = await org('Cooperative', `สหกรณ์ยังไม่ยืนยัน ${tag}`, 'Pending');
  const buyer = await org('Buyer', `ผู้รับซื้อ ${tag}`);
  const other = await org('Cooperative', `สหกรณ์อื่น ${tag}`);
  const phone = () => `08${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const nid = () => String(Math.floor(Math.random() * 9e12) + 1e12);
  const reg = (x) => ({ full_name: `เกษตรกร ${tag}`, phone: phone(), national_id: nid(), region_code: 'TH-30', district_code: '3001', ...x });

  await t.test('search: only verified cooperatives and member-type organizations, needs a name or a province', async () => {
    const found = await call(null, 'GET', `/auth/member-organizations?q=${encodeURIComponent(tag)}`);
    const names = found.map((o) => o.org_name);
    assert.ok(names.includes(`สหกรณ์การเกษตรทดสอบ ${tag} จำกัด`));
    assert.ok(names.includes(`กองทุนหมู่บ้านทดสอบ ${tag}`));
    assert.ok(!names.some((n) => n.includes('ยังไม่ยืนยัน') || n.includes('ผู้รับซื้อ')));
    assert.equal(found.find((o) => o.org_id === coop.id).province_name_th, 'นครราชสีมา');
    assert.equal(found.find((o) => o.org_id === fund.id).region_code, 'TH-30');
    assert.deepEqual(Object.keys(found[0]).sort(), ['org_id', 'org_name', 'org_type', 'region_code', 'province_name_th'].sort());
    const coopsOnly = await call(null, 'GET', `/auth/member-organizations?q=${encodeURIComponent(tag)}&type=Cooperative`);
    assert.ok(coopsOnly.every((o) => o.org_type === 'Cooperative'));
    assert.deepEqual(await call(null, 'GET', '/auth/member-organizations'), []);
    assert.deepEqual(await call(null, 'GET', '/auth/member-organizations?q=a'), []);
    // the registration form sends the farmer's ISO province code + its Thai name → both code systems match
    const byProv = await call(null, 'GET', `/auth/member-organizations?province=TH-30&province_name=${encodeURIComponent('นครราชสีมา')}`);
    assert.ok(byProv.some((o) => o.org_id === fund.id), 'ISO region_code');
    assert.ok(byProv.some((o) => o.org_id === coop.id), 'cooperative_profile by Thai name');
    assert.ok(!(await call(null, 'GET', '/auth/member-organizations?province=TH-10')).some((o) => o.org_id === fund.id));
    assert.deepEqual(await call(null, 'GET', '/auth/member-organizations?q=%25%25'), []); // LIKE wildcards are literal
  });

  let F; let farmerId;
  await t.test('register with two memberships → two pending claims; a bad organization creates no account', async () => {
    const bad = reg({ memberships: [{ org_id: coop.id }, { org_id: buyer.id }] });
    assert.equal((await call(null, 'POST', '/auth/register', bad, 400)).error, 'invalid_organization');
    assert.equal((await db.query('SELECT 1 FROM identity.farmer WHERE phone=$1', [bad.phone])).rows.length, 0, 'no half-created account');
    assert.equal((await call(null, 'POST', '/auth/register', reg({ memberships: [{ org_id: unverified.id }] }), 400)).error, 'invalid_organization');
    assert.equal((await call(null, 'POST', '/auth/register', reg({ memberships: [{ org_id: coop.id }, { org_id: coop.id }] }), 400)).error, 'duplicate_organization');
    const ok = await call(null, 'POST', '/auth/register', reg({ memberships: [{ org_id: coop.id, member_no: ' 0123 ' }, { org_id: fund.id }] }), 201);
    F = ok.access_token; farmerId = ok.subject_id;
    const mine = await call(F, 'GET', '/farmer/membership-claims');
    assert.equal(mine.length, 2);
    assert.ok(mine.every((c) => c.status === 'Pending' && c.source === 'registration'));
    assert.equal(mine.find((c) => c.org_id === coop.id).member_no, '0123');
    assert.deepEqual(await call(F, 'GET', '/farmer/memberships'), []); // not a member until confirmed
    assert.equal((await call(F, 'POST', '/farmer/membership-claims', { org_id: coop.id }, 409)).error, 'claim_pending');
    // registering without memberships still works exactly as before
    assert.ok((await call(null, 'POST', '/auth/register', reg({}), 201)).access_token);
  });

  await t.test('each organization sees only claims sent to it; cooperative confirms with its own member number', async () => {
    const forCoop = await call(coop.token, 'GET', '/farmer360/membership-claims');
    assert.equal(forCoop.filter((c) => c.farmer_id === farmerId).length, 1);
    assert.equal((await call(other.token, 'GET', '/farmer360/membership-claims')).length, 0);
    const claim = forCoop.find((c) => c.farmer_id === farmerId);
    assert.equal(claim.member_no, '0123');
    await call(other.token, 'POST', `/farmer360/membership-claims/${claim.claim_id}/approve`, {}, 404); // not theirs
    const ok = await call(coop.token, 'POST', `/farmer360/membership-claims/${claim.claim_id}/approve`, { member_no: 'C-0123' });
    assert.equal(ok.status, 'Approved');
    await call(coop.token, 'POST', `/farmer360/membership-claims/${claim.claim_id}/approve`, {}, 409);
    const roster = await call(coop.token, 'GET', '/farmer360/relationships/mine');
    const r = roster.find((x) => x.farmer_id === farmerId);
    assert.equal(r.relationship_type, 'CooperativeMember');
    assert.equal(r.member_no, 'C-0123');
    const mine = await call(F, 'GET', '/farmer/memberships');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].member_no, 'C-0123');
    assert.equal((await call(F, 'POST', '/farmer/membership-claims', { org_id: coop.id }, 409)).error, 'already_member');
  });

  await t.test('village fund rejects (reason required); farmer sees why, can send again, then withdraw', async () => {
    const c = (await call(fund.token, 'GET', '/farmer360/membership-claims')).find((x) => x.farmer_id === farmerId);
    assert.equal((await call(fund.token, 'POST', `/farmer360/membership-claims/${c.claim_id}/reject`, {}, 400)).error, 'reason_required');
    await call(fund.token, 'POST', `/farmer360/membership-claims/${c.claim_id}/reject`, { reason: 'ไม่พบชื่อในทะเบียนกองทุน' });
    let mine = await call(F, 'GET', '/farmer/membership-claims');
    assert.equal(mine.find((x) => x.claim_id === c.claim_id).reject_reason, 'ไม่พบชื่อในทะเบียนกองทุน');
    const again = await call(F, 'POST', '/farmer/membership-claims', { org_id: fund.id, member_no: 'VF-9', farmer_note: 'สมัครปี 2567' }, 201);
    assert.equal(again.source, 'portal');
    await call(F, 'POST', `/farmer/membership-claims/${again.claim_id}/withdraw`, {});
    await call(F, 'POST', `/farmer/membership-claims/${again.claim_id}/withdraw`, {}, 404);
    mine = await call(F, 'GET', '/farmer/membership-claims');
    assert.equal(mine.find((x) => x.claim_id === again.claim_id).status, 'Withdrawn');
    assert.equal((await call(fund.token, 'GET', '/farmer360/membership-claims')).filter((x) => x.farmer_id === farmerId).length, 0);
    const all = await call(fund.token, 'GET', '/farmer360/membership-claims?status=all');
    assert.deepEqual(all.filter((x) => x.farmer_id === farmerId).map((x) => x.status).sort(), ['Rejected', 'Withdrawn']);
    assert.equal((await call(F, 'POST', '/farmer/membership-claims', { org_id: buyer.id }, 400)).error, 'invalid_organization');
  });
});
