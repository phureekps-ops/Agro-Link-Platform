const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lib/coopLending');

test('business days skip weekends and declared holidays', () => {
  // 2026-12-04 is a Friday
  assert.equal(L.addBusinessDays('2026-12-04', 3), '2026-12-09');
  assert.equal(L.addBusinessDays('2026-12-04', 3, new Set(['2026-12-07'])), '2026-12-10');
  // evidence complete on a Saturday: counting starts Monday
  assert.equal(L.addBusinessDays('2026-12-05', 1), '2026-12-07');
  assert.equal(L.isBusinessDay('2026-12-06'), false);
  assert.equal(L.businessDaysLate('2026-12-09', '2026-12-09'), 0);
  assert.equal(L.businessDaysLate('2026-12-09', '2026-12-14'), 3); // Thu, Fri, Mon
});

test('interest accrues daily, overdue days switch to the 10% default rate', () => {
  const a = L.accrueInterest({ principal: 300000, from: '2027-01-01', to: '2027-04-01', dueDate: '2027-06-30', ratePct: 4.5, penaltyPct: 10 });
  assert.equal(a.normalDays, 90);
  assert.equal(a.total, 3328.77); // matches the design doc example
  const b = L.accrueInterest({ principal: 100000, from: '2027-01-01', to: '2027-01-21', dueDate: '2027-01-11', ratePct: 3.65, penaltyPct: 10 });
  assert.equal(b.normalDays, 10);
  assert.equal(b.overdueDays, 10);
  assert.equal(b.normal, 100);
  assert.equal(b.overdue, 273.97);
  const c = L.accrueInterest({ principal: 100000, from: '2027-02-01', to: '2027-02-11', dueDate: '2027-01-11', ratePct: 3.65, penaltyPct: 10 });
  assert.equal(c.normalDays, 0);
  assert.equal(c.overdueDays, 10);
});

test('late penalty: 10% a year on the late amount, calendar days after due', () => {
  assert.equal(L.latePenalty(300000, '2027-01-10', '2027-01-13', 10), 246.58); // design doc example
  assert.equal(L.latePenalty(300000, '2027-01-10', '2027-01-10', 10), 0);
  assert.equal(L.latePenalty(300000, '2027-01-10', '2027-01-05', 10), 0);
});

test('annuity schedule reproduces the tractor example and balances to zero', () => {
  const s = L.annuitySchedule({ principal: 722500, ratePct: 4.5, termMonths: 36, intervalMonths: 6, startDate: '2027-01-15' });
  assert.equal(s.length, 6);
  assert.equal(s[0].interest, 16256.25);
  assert.equal(s[0].principal, 113819.01);
  assert.equal(s[0].installment, 130075.26);
  assert.equal(s[5].balance, 0);
  assert.equal(L.round2(s.reduce((x, r) => x + r.principal, 0)), 722500);
  assert.equal(s[0].due_date, '2027-07-15');
  const g = L.annuitySchedule({ principal: 120000, ratePct: 6, termMonths: 12, intervalMonths: 1, gracePeriods: 2, startDate: '2027-01-31' });
  assert.equal(g[0].principal, 0);
  assert.equal(g[0].interest, 600);
  assert.equal(g[1].due_date, '2027-03-31');
  assert.equal(g[0].due_date, '2027-02-28');
  assert.equal(g.at(-1).balance, 0);
  assert.throws(() => L.annuitySchedule({ principal: 1, ratePct: 1, termMonths: 10, intervalMonths: 6, startDate: '2027-01-01' }), /term_not_multiple/);
  const aff = L.affordability(s, 260000, 50);
  assert.equal(aff.ratio_pct, 50.03);
  assert.equal(aff.ok, false);
});

test('repayment pays all overdue interest first, then principal of the earliest-due item', () => {
  const r = L.allocateRepayment(50000, [
    { item_id: 'b', loan_due_date: '2027-06-01', interest_unpaid: 1000, principal_outstanding: 80000 },
    { item_id: 'a', loan_due_date: '2027-03-01', interest_unpaid: 2000, principal_outstanding: 30000 },
  ]);
  assert.equal(r.interest, 3000);
  assert.equal(r.principal, 47000);
  assert.deepEqual(r.allocation.find((x) => x.item_id === 'a'), { item_id: 'a', interest: 2000, principal: 30000 });
  assert.deepEqual(r.allocation.find((x) => x.item_id === 'b'), { item_id: 'b', interest: 1000, principal: 17000 });
  assert.equal(r.leftover, 0);
  assert.equal(L.allocateRepayment(200000, [{ item_id: 'a', loan_due_date: '2027-03-01', interest_unpaid: 10, principal_outstanding: 100 }]).leftover, 199890);
});

test('evidence rules per purpose', () => {
  const base = { farmer_id: 'f', farmer_confirmed_at: null };
  assert.deepEqual(L.missingEvidence({ ...base, purpose: 'inputs', source_type: 'product_order' }, [], true),
    { missingKinds: ['invoice'], missingFields: [], needFarmer: true, needPayout: false });
  const m = L.missingEvidence({ ...base, purpose: 'machinery_service', source_type: 'machinery_booking', service_date: '2027-01-01', farmer_confirmed_at: 'x' }, ['work_photo'], false);
  assert.deepEqual(m, { missingKinds: [], missingFields: ['service_area_rai'], needFarmer: false, needPayout: true });
  const a = L.missingEvidence({ farmer_id: null, purpose: 'asset', source_type: 'asset_loan' }, ['contract', 'invoice'], true);
  assert.deepEqual(a.missingKinds, ['down_payment_slip', 'serial_photo']);
  assert.equal(a.needFarmer, false);
});

test('satellite: relevant medium/high flags need review, low data or no assessment is insufficient, not a rejection', () => {
  assert.equal(L.classifySatellite('inputs', []).result, 'na');
  assert.equal(L.classifySatellite('inputs', [{ unit_id: 'u', assessment: null }]).result, 'insufficient');
  assert.equal(L.classifySatellite('inputs', [{ unit_id: 'u', assessment: { flags: [{ code: 'LOW_DATA', severity: 'info' }] } }]).result, 'insufficient');
  assert.equal(L.classifySatellite('inputs', [{ unit_id: 'u', assessment: { flags: [{ code: 'YIELD_OUTLIER', severity: 'high' }] } }]).result, 'pass');
  assert.equal(L.classifySatellite('procurement', [{ unit_id: 'u', assessment: { flags: [{ code: 'DELIVERY_BEFORE_HARVEST', severity: 'high' }] } }]).result, 'review');
  const area = L.classifySatellite('machinery_service', [{ unit_id: 'u', area_rai: 10, assessment: { flags: [] } }], { serviceAreaRai: 15 });
  assert.equal(area.result, 'review');
  assert.equal(area.flags[0].code, 'SERVICE_AREA_EXCEEDS_PLOT');
  assert.equal(L.classifySatellite('machinery_service', [{ unit_id: 'u', area_rai: 10, assessment: { flags: [] } }], { serviceAreaRai: 10.5 }).result, 'pass');
});

test('account names match after removing titles and spaces', () => {
  assert.equal(L.namesMatch('นาย สมชาย ใจดี', 'สมชาย  ใจดี'), true);
  assert.equal(L.namesMatch('บริษัท ปุ๋ยดี จำกัด', 'บริษัทปุ๋ยดีจำกัด'), true);
  assert.equal(L.namesMatch('สมชาย ใจดี', 'สมหญิง ใจดี'), false);
});

test('sandbox bank driver', async () => {
  const bank = require('../src/lib/bankGateway');
  const d = bank.driver();
  assert.equal(d.live, false);
  assert.equal((await d.verifyAccount({ account_no: '9991234567', account_name: 'x' })).status, 'Failed');
  const ok = await d.transfer({ from: { account_no: '1231234567' }, idempotencyKey: 'k1' });
  assert.equal(ok.status, 'Succeeded');
  assert.equal(ok.bank_ref, (await d.transfer({ from: { account_no: '1231234567' }, idempotencyKey: 'k1' })).bank_ref);
  assert.equal((await d.transfer({ from: { account_no: '0001234567' }, idempotencyKey: 'k2' })).status, 'Failed');
});
