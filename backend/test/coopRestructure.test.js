const test = require('node:test');
const assert = require('node:assert/strict');
const RS = require('../src/lib/coopRestructure');

test('restructure request validation and plan: never shortens a due date, rate can only go down', async () => {
  const st = { today: '2026-11-28', earliest_due: '2026-11-18', max_rate: 5, outstanding: 1e6 };
  assert.deepEqual(RS.validate({ new_due_date: '2027-05-30' }, st), []);
  assert.deepEqual(RS.validate({ new_due_date: '2026-11-28' }, st), ['new_due_date_not_future']);
  assert.deepEqual(RS.validate({ new_due_date: '2026-11-29' }, { ...st, earliest_due: '2026-12-01' }), ['new_due_date_not_later']);
  assert.deepEqual(RS.validate({ new_due_date: '2029-12-01' }, st), ['new_due_date_too_far']);
  assert.deepEqual(RS.validate({ new_due_date: 'x' }, st), ['invalid_new_due_date']);
  assert.deepEqual(RS.validate({ new_due_date: '2027-05-30', new_rate_pct: 5.5 }, st), ['rate_higher_than_current']);
  assert.deepEqual(RS.validate({ new_due_date: '2027-05-30', new_rate_pct: 0 }, st), []);
  assert.deepEqual(RS.validate({ new_due_date: '2027-05-30' }, { ...st, outstanding: 0 }), ['nothing_outstanding']);
  const items = [
    { item_id: 'a', facility_id: 'F1', loan_due_date: '2026-11-18', principal_outstanding: '1000000' },
    { item_id: 'b', facility_id: 'F2', loan_due_date: '2027-08-01', principal_outstanding: '700000' }, // ครบหลังวันใหม่ — ไม่ร่น
    { item_id: 'c', facility_id: 'F2', loan_due_date: '2026-12-15', principal_outstanding: '0' },
  ];
  const facs = [{ facility_id: 'F1', rate_pct: '4.5', lender_name: 'ก' }, { facility_id: 'F2', rate_pct: '4', lender_name: 'ข' }];
  const p = RS.plan(items, facs, { new_due_date: '2027-05-30', new_rate_pct: 4 });
  assert.deepEqual(p.itemChanges.map((x) => [x.item_id, x.from, x.to]), [['a', '2026-11-18', '2027-05-30']]);
  assert.deepEqual(p.rateChanges.map((x) => [x.facility_id, x.from, x.to]), [['F1', 4.5, 4]]);
  assert.equal(p.principal, 1e6);
  assert.deepEqual(RS.plan(items, facs, { new_due_date: '2027-05-30', new_rate_pct: null }).rateChanges, []);
  const buf = await RS.amendmentDocx({
    request: { created_at: '2026-11-20', reason: 'ราคาผลผลิตตกต่ำ', repayment_plan: 'ชำระหลังขายผลผลิต', new_due_date: '2027-05-30' },
    agreement: { agreement_no: 'CL-2569-ABC123' }, listing: { title: 'โครงการทดสอบ' }, borrower: { org_name: 'สหกรณ์ผู้กู้' },
    lenders: [{ org_name: 'สหกรณ์ผู้ให้กู้', approval_ref: 'มติ 1/2569' }], snapshot: { accrued_to: '2026-11-28', items: p.itemChanges, rates: p.rateChanges },
  });
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
});
