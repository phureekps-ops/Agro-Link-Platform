const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/lib/coopMarket');

const strong = {
  financials: [
    { year: 2567, total_assets: 100e6, total_liabilities: 45e6, current_assets: 30e6, current_liabilities: 18e6, net_income: 3.5e6, revenue: 40e6, audit_opinion: 'unqualified' },
    { year: 2566, net_income: 3e6, revenue: 36e6 }, { year: 2565, net_income: 2e6 },
  ],
  businesses: { collect: { value: 20e6 }, credit: { value: 15e6 }, supply: { value: 5e6 } }, established_year: 2540, member_count: 800,
  governance: { standard_grade: 'excellent' }, debts: [{ creditor: 'กองทุนพัฒนาสหกรณ์', status: 'current' }], data_as_of: '2026-06-30', consent_disclose: true,
  max_borrowing: 20e6,
};

test('credit score: 5 groups 25/25/20/15/15, grade bands A/B/C/D, stale data and bad history lower the score', () => {
  const s = M.creditScore(strong, { facilities: 2 }, '2026-11-26');
  assert.equal(s.score, 100);
  assert.equal(s.grade, 'A');
  assert.ok(s.factors.every((f) => f.points <= f.max));
  const groupMax = {};
  s.factors.forEach((f) => { groupMax[f.group] = (groupMax[f.group] || 0) + f.max; });
  assert.deepEqual(groupMax, { financial: 25, capacity: 25, governance: 20, repayment: 15, business: 15 });
  const weak = M.creditScore({ ...strong, debts: [{ status: 'default' }], governance: { standard_grade: 'pass', unresolved_issues: 'ยังไม่แก้ข้อสังเกตผู้สอบบัญชี' } }, { overdue_now: 2 }, '2026-11-26');
  assert.equal(weak.factors.find((f) => f.key === 'debts').points, 0);
  assert.equal(weak.factors.find((f) => f.key === 'standard').points, 3);
  assert.equal(weak.factors.find((f) => f.key === 'issues').points, 0);
  assert.equal(weak.factors.find((f) => f.key === 'platform').points, 0);
  assert.equal(weak.score, 76); // 100 − มาตรฐาน 5 − ข้อสังเกต 4 − หนี้เดิม 8 − ประวัติในระบบ 7
  assert.equal(weak.grade, 'B');
  const stale = M.creditScore({ ...strong, data_as_of: '2024-01-01' }, { facilities: 1 }, '2026-11-26');
  assert.equal(stale.score, 95);
  assert.ok(stale.stale);
  const empty = M.creditScore({}, {}, '2026-11-26');
  assert.equal(empty.grade, 'D');
  assert.ok(empty.score < 55);
  assert.equal(M.gradeOf(85)[1], 'A');
  assert.equal(M.gradeOf(84)[1], 'B');
  assert.equal(M.gradeOf(55)[1], 'C');
  assert.equal(M.gradeOf(54)[1], 'D');
});

test('listing checks by project type; policy match; exposure warnings', () => {
  const base = { amount_requested: 1000000, tenor_months: 12, use_plan: [{ item: 'ปุ๋ย', amount: 1000000 }], repayment_plan: 'ชำระหลังขายผลผลิตเดือน ธ.ค.', certified_at: 'x', resolution_file_id: 'f' };
  const onl = { ...base, project_type: 'member_onlending', details: { members_count: 40, per_member_limit: 25000, production_plan: 'ข้าวนาปี' } };
  const ok = M.listingChecks(onl, [], strong);
  assert.equal(ok.ok, true);
  // มาตรา 47: ต้องระบุวงเงินกู้ยืมที่ที่ประชุมใหญ่อนุมัติ และหนี้เดิม + วงเงินที่ขอต้องไม่เกิน
  assert.deepEqual(M.listingChecks(onl, [], { ...strong, max_borrowing: null }).missing.map((m) => m.code), ['max_borrowing']);
  assert.deepEqual(M.listingChecks(onl, [], { ...strong, max_borrowing: 5e6 }, { platformDebt: 4.5e6 }).missing.map((m) => m.code), ['over_max_borrowing']);
  const proc = M.listingChecks({ ...base, project_type: 'procurement', details: {} }, [], strong);
  assert.deepEqual(proc.missing.map((m) => m.code), ['commodity', 'volume_t', 'period', 'reference_price', 'end_buyers']);
  const inv = M.listingChecks({ ...base, project_type: 'investment', use_plan: [{ item: 'เครื่อง', amount: 500 }], details: { business_plan: 'x', projections: [{ year: '1', net_cash: 1 }] }, certified_at: null }, [], { ...strong, consent_disclose: false });
  assert.deepEqual(inv.missing.map((m) => m.code), ['consent', 'use_plan_sum', 'quotation', 'certify']);

  const listing = { project_type: 'procurement', amount_requested: 3e6, tenor_months: 6, province_code: 'KHON_KAEN', commodities: ['CASSAVA'] };
  assert.equal(M.policyMatch({}, listing, 'C').match, true);
  const pm = M.policyMatch({ project_types: ['member_onlending'], max_amount: 2e6, provinces: ['NAKHON_RATCHASIMA'], max_risk_grade: 'B' }, listing, 'C');
  assert.deepEqual(pm.mismatches.length, 4);

  const w = M.exposureWarnings({ allocatable_amount: 5e6, policy: { limit_per_borrower: 2e6, limit_per_type: { procurement: 1e6 }, rate_min: 4 } },
    { total: 4e6, borrower: 1.5e6, province: 0, type: 0 }, { amount: 1.2e6, rate_pct: 3.5 }, listing);
  assert.deepEqual(w.map((x) => x.code), ['over_allocatable', 'over_borrower', 'over_type', 'rate_below_policy']);
});

test('project risk: investment DSCR from projected cash flow', () => {
  const r = M.projectRisk({ project_type: 'investment', amount_requested: 1e6, tenor_months: 60, grace_months: 0, details: { projections: [{ year: 'ปี 1', net_cash: 350000 }, { year: 'ปี 2', net_cash: 350000 }], payback_years: 4 } }, 5);
  const d = r.indicators.find((x) => x.key === 'dscr');
  assert.equal(d.value, 1.52); // 350,000 ÷ 230,974.80 a year
  assert.equal(d.ok, true);
  assert.equal(r.indicators.find((x) => x.key === 'payback').ok, true);
});

test('repayment schedules: annuity with grace, bullet with periodic interest', () => {
  const a = M.repaymentSchedule({ amount: 1200000, rate_pct: 4.5, tenor_months: 36, repayment_type: 'installment', interval_months: 6, grace_months: 6 }, '2027-01-15');
  assert.equal(a.length, 6);
  assert.equal(a[0].principal, 0);
  assert.equal(a.at(-1).balance, 0);
  const b = M.repaymentSchedule({ amount: 1000000, rate_pct: 6, tenor_months: 12, repayment_type: 'bullet', interval_months: 6 }, '2027-01-15');
  assert.deepEqual(b.map((r) => [r.due_date, r.principal, r.interest]), [['2027-07-15', 0, 30000], ['2028-01-15', 1000000, 30000]]);
});
