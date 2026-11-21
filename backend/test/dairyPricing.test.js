/*
 * Unit tests for the dairy money rules in src/lib/dairy.js (no database):
 *  - priceFor: base price ± the coop's Fat/SNF/SCC/TBC table
 *  - allocateSettlement: strict deduction order, carry-over, no negative pay
 *  - alertLevel / feeOf: surplus colour and AgroLink fee rounding
 * Run with: npm test   (Node 18+, no dependencies)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  priceFor, allocateSettlement, alertLevel, feeOf, DEBIT_TYPES,
} = require('../src/lib/dairy');

// A typical coop table (values like the ones cooperatives publish).
const RULES = [
  { param: 'fat', min_value: null, max_value: '3.20', adjust_per_kg: '-0.50' },
  { param: 'fat', min_value: '3.80', max_value: null, adjust_per_kg: '0.30' },
  { param: 'snf', min_value: null, max_value: '8.25', adjust_per_kg: '-0.40' },
  { param: 'scc', min_value: '500', max_value: '1000', adjust_per_kg: '-0.25' },
  { param: 'scc', min_value: '1000', max_value: null, adjust_per_kg: '-1.00' },
  { param: 'tbc', min_value: null, max_value: '100', adjust_per_kg: '0.15' },
];
const test0 = {
  sample_date: '2026-11-01', fat_pct: '3.50', snf_pct: '8.40', scc_k: '300', tbc_k: '200',
};

// ---------------------------------------------------------------------------
// priceFor
// ---------------------------------------------------------------------------
test('priceFor: no test yet = base price only, flagged no_test', () => {
  const { price, detail } = priceFor('18.50', undefined, RULES);
  assert.equal(price, 18.5);
  assert.equal(detail.no_test, true);
  assert.deepEqual(detail.adjustments, []);
  assert.equal(detail.test_date, null);
});

test('priceFor: values inside every neutral band = base price, no adjustments', () => {
  const { price, detail } = priceFor(18.5, test0, RULES);
  assert.equal(price, 18.5);
  assert.deepEqual(detail.adjustments, []);
  assert.equal(detail.test_date, '2026-11-01');
  assert.equal(detail.no_test, undefined);
});

test('priceFor: several rules add up (bonus fat + bonus TBC, penalty SCC)', () => {
  const t = {
    ...test0, fat_pct: 4.1, scc_k: 650, tbc_k: 50,
  };
  const { price, detail } = priceFor(18.5, t, RULES);
  assert.equal(price, 18.7); // 18.50 + 0.30 - 0.25 + 0.15
  assert.deepEqual(detail.adjustments.map((a) => a.param).sort(), ['fat', 'scc', 'tbc']);
});

test('priceFor: band is [min, max) — min inclusive, max exclusive', () => {
  // fat exactly 3.80 hits the bonus band (min inclusive)
  assert.equal(priceFor(18, { ...test0, fat_pct: 3.8 }, RULES).price, 18.3);
  // fat exactly 3.20 is NOT in the penalty band (max exclusive)
  assert.equal(priceFor(18, { ...test0, fat_pct: 3.2 }, RULES).price, 18);
  // SCC exactly 1000 falls in the 1000+ band only, never both
  const r = priceFor(18, { ...test0, scc_k: 1000 }, RULES);
  assert.equal(r.price, 17);
  assert.equal(r.detail.adjustments.length, 1);
  // SCC 999.999 still in the 500–1000 band
  assert.equal(priceFor(18, { ...test0, scc_k: 999.999 }, RULES).price, 17.75);
});

test('priceFor: a parameter missing from the test is skipped, not treated as 0', () => {
  const t = { ...test0, fat_pct: null, tbc_k: undefined };
  // fat null must NOT trigger "fat < 3.20" and tbc missing must NOT trigger "tbc < 100"
  assert.equal(priceFor(18, t, RULES).price, 18);
});

test('priceFor: worst-case milk never goes below 0 and is rounded to satang', () => {
  const t = {
    sample_date: '2026-11-01', fat_pct: 2.5, snf_pct: 7.9, scc_k: 1500, tbc_k: 900,
  };
  assert.equal(priceFor(18.5, t, RULES).price, 16.6); // 18.50 - 0.50 - 0.40 - 1.00
  assert.equal(priceFor(1, t, RULES).price, 0); // clamped
  const odd = [{ param: 'fat', min_value: null, max_value: null, adjust_per_kg: 0.333 }];
  assert.equal(priceFor(10, test0, odd).price, 10.33);
});

test('priceFor: no rules = base price even with a test', () => {
  assert.equal(priceFor(19.25, test0, []).price, 19.25);
});

// ---------------------------------------------------------------------------
// allocateSettlement
// ---------------------------------------------------------------------------
let seq = 0;
const e = (entry_type, amount) => { seq += 1; return { entry_id: `e${seq}`, entry_type, amount: String(amount) }; };
const ORDER = DEBIT_TYPES; // default: feed, vet_service, ai_service, loan_repayment, share, adjustment

test('allocateSettlement: enough income — every debit deducted, net = credit - debit', () => {
  const entries = [e('milk_sale', 5000), e('milk_sale', 4800.5), e('feed', -3000), e('vet_service', -450), e('share', -100)];
  const r = allocateSettlement(entries, ORDER);
  assert.equal(r.credit, 9800.5);
  assert.equal(r.debit, 3550);
  assert.equal(r.net, 6250.5);
  assert.equal(r.carry, 0);
  assert.equal(r.take.length, 5);
  assert.deepEqual(r.carried, []);
});

test('allocateSettlement: strict order — first debit that does not fit and all after it are carried', () => {
  // income 1000: feed 600 fits, loan 500 does not → loan AND the later, smaller share 100 are carried
  const feed = e('feed', -600); const loan = e('loan_repayment', -500); const share = e('share', -100);
  const milk = e('milk_sale', 1000);
  const r = allocateSettlement([share, loan, milk, feed], ORDER);
  assert.equal(r.debit, 600);
  assert.equal(r.net, 400);
  assert.equal(r.carry, 600);
  assert.deepEqual(r.carried, [loan.entry_id, share.entry_id]);
  assert.ok(r.take.includes(feed.entry_id) && r.take.includes(milk.entry_id));
});

test('allocateSettlement: the coop\'s own order is respected (loan before feed)', () => {
  const order = ['loan_repayment', 'feed', 'vet_service', 'ai_service', 'share', 'adjustment'];
  const feed = e('feed', -600); const loan = e('loan_repayment', -500);
  const r = allocateSettlement([e('milk_sale', 1000), feed, loan], order);
  assert.deepEqual(r.carried, [feed.entry_id]);
  assert.equal(r.net, 500);
});

test('allocateSettlement: same type keeps date order (older feed bill first)', () => {
  const feed1 = e('feed', -700); const feed2 = e('feed', -200);
  const r = allocateSettlement([e('milk_sale', 800), feed1, feed2], ORDER);
  // 700 fits, then 200 does not (100 left) → feed2 carried
  assert.deepEqual(r.carried, [feed2.entry_id]);
  assert.equal(r.net, 100);
});

test('allocateSettlement: a debit equal to the remaining income is deducted (net 0, not carried)', () => {
  const r = allocateSettlement([e('milk_sale', 1234.56), e('feed', -1234.56)], ORDER);
  assert.equal(r.net, 0);
  assert.equal(r.carry, 0);
});

test('allocateSettlement: floating-point sums do not wrongly carry a debit', () => {
  // 0.1 + 0.2 style drift
  const r = allocateSettlement([e('milk_sale', 0.1), e('milk_sale', 0.2), e('feed', -0.3)], ORDER);
  assert.equal(r.carry, 0);
  assert.equal(r.net, 0);
});

test('allocateSettlement: no income — nothing deducted, never a negative payment', () => {
  const r = allocateSettlement([e('feed', -500), e('share', -100)], ORDER);
  assert.equal(r.net, 0);
  assert.equal(r.debit, 0);
  assert.equal(r.carry, 600);
  assert.deepEqual(r.take, []);
});

test('allocateSettlement: positive adjustment is income, negative adjustment is a debit', () => {
  const r = allocateSettlement([e('milk_sale', 1000), e('adjustment', 50), e('adjustment', -30)], ORDER);
  assert.equal(r.credit, 1050);
  assert.equal(r.debit, 30);
  assert.equal(r.net, 1020);
});

test('allocateSettlement: net is always >= 0 and credit = net + debit (random cases)', () => {
  let s = 42;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let k = 0; k < 500; k += 1) {
    const entries = [];
    const n = 1 + Math.floor(rnd() * 8);
    for (let i = 0; i < n; i += 1) {
      const credit = rnd() < 0.4;
      const type = credit ? 'milk_sale' : DEBIT_TYPES[Math.floor(rnd() * DEBIT_TYPES.length)];
      const amt = Math.round(rnd() * 500000) / 100;
      if (amt > 0) entries.push(e(type, credit ? amt : -amt));
    }
    const r = allocateSettlement(entries, ORDER);
    assert.ok(r.net >= 0, `net ${r.net}`);
    assert.ok(Math.abs(r.credit - r.net - r.debit) < 0.011);
    const totalDebit = entries.filter((x) => Number(x.amount) < 0).reduce((a, x) => a - Number(x.amount), 0);
    assert.ok(Math.abs(r.debit + r.carry - totalDebit) < 0.011);
    assert.equal(r.take.length + r.carried.length, entries.length);
  }
});

// ---------------------------------------------------------------------------
// alertLevel / feeOf
// ---------------------------------------------------------------------------
test('alertLevel: surplus colour from forecast vs committed milk', () => {
  const s = { alert_yellow_pct: 1, alert_orange_pct: 3, alert_red_pct: 5 };
  assert.equal(alertLevel(0, 1000, s).level, 'green');
  assert.equal(alertLevel(1010, 1000, s).level, 'green'); // exactly 1% is not above
  assert.equal(alertLevel(1020, 1000, s).level, 'yellow');
  assert.equal(alertLevel(1040, 1000, s).level, 'orange');
  assert.equal(alertLevel(1060, 1000, s).level, 'red');
  assert.deepEqual(alertLevel(500, 0, s), { level: 'red', surplus_pct: null }); // milk with no buyer
  assert.equal(alertLevel(1060, 1000, s).surplus_pct, 6);
});

test('feeOf: percentage fee rounded to satang', () => {
  assert.equal(feeOf(12345.67, 0), 0);
  assert.equal(feeOf(12345.67, 1.5), 185.19);
  assert.equal(feeOf('1000', '0.25'), 2.5);
});
