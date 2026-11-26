const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../src/lib/dairyImportQuota');
const S = require('../src/lib/dairySurplus');

test('raw milk equivalent of imported dairy products', () => {
  assert.equal(Q.rawMilkKg(19366.27, 11), 213028970);
  assert.equal(Q.rawMilkKg(10, 1), 10000);
});

test('surplus measure split 80:20 between entity groups, then by each holder\'s quota', () => {
  const m = { total_kg_day: 47148, group1_pct: 80, product_code: 'smp', quota_year: 2570 };
  const holders = [
    { holder_id: 'a', entity_group: 1, quantity_t: 15000, product_code: 'smp', quota_year: 2570 },
    { holder_id: 'b', entity_group: 1, quantity_t: 10391, product_code: 'smp', quota_year: 2570 },
    { holder_id: 'c', entity_group: 2, quantity_t: 9607, product_code: 'smp', quota_year: 2570 },
    { holder_id: 'x', entity_group: 2, quantity_t: 999, product_code: 'smp', quota_year: 2569 }, // other year
    { holder_id: 'y', entity_group: 1, quantity_t: 999, product_code: 'smp', quota_year: 2570, active: false },
  ];
  const o = Q.obligations(m, holders);
  assert.equal(o.rows.length, 3);
  assert.equal(o.groups[0].kg_per_day, 37718.4);
  assert.equal(o.groups[1].kg_per_day, 9429.6);
  assert.equal(o.rows.find((r) => r.holder_id === 'a').kg_per_day, 22282.54);
  assert.equal(o.rows.find((r) => r.holder_id === 'c').kg_per_day, 9429.6);
  assert.equal(o.unassigned_kg_day, 0);
  assert.equal(Q.obligations(m, holders.slice(0, 2)).unassigned_kg_day, 9429.6); // no group-2 holders recorded yet
});

test('policy options: one deferral proposal on the earliest powder tranche that can still be decided, never more than it holds', () => {
  const smp = (id, agr, g, no, q, opens, status = 'Planned') => ({ tranche_id: id, agreement: agr, product_code: 'smp', entity_group: g, tranche_no: no, quantity_t: q, deferred_t: 0, opens_on: opens, status, raw_milk_factor: 11, name_th: 'นมผงขาดมันเนย' });
  const tr = [
    smp('wto1', 'WTO', 1, 1, 25391, '2027-01-01'), smp('t1', 'TAFTA_TNZCEP', null, 1, 45189.13, '2027-01-01'), smp('t2', 'TAFTA_TNZCEP', null, 2, 19366.27, '2027-06-01'),
    { tranche_id: 'mc', agreement: 'ALL', product_code: 'milk_cream', tranche_no: 1, quantity_t: 17202.2, deferred_t: 0, opens_on: '2027-01-01', status: 'Planned', raw_milk_factor: 1, name_th: 'นมและครีม' },
  ];
  // 26 Nov 2026: the 1 Jan tranches must be decided by 2 Dec (6 days) — too late; the June tranche is recommended
  const o = Q.policyOptions({ today: '2026-11-26', tranches: tr, surplus_kg_day: 47148, horizon_days: 60, holders: [], quota_year: 2570 });
  const d = o.find((x) => x.kind === 'defer_import');
  assert.equal(o.filter((x) => x.kind === 'defer_import').length, 1);
  assert.equal(d.needed_t, 257.17); // 47,148 × 60 ÷ 11 ÷ 1,000
  assert.equal(d.propose_t, 257.17);
  assert.equal(d.recommended_tranche_id, 't2');
  assert.equal(d.decide_by, '2027-05-02');
  assert.equal(d.covers_days, 60);
  assert.deepEqual(d.candidates.map((c) => [c.tranche_id, c.decidable]), [['t1', false], ['wto1', false], ['t2', true]]);
  assert.ok(!d.candidates.some((c) => c.tranche_id === 'mc')); // only milk powder
  // early enough: the earliest tranche takes it; a huge surplus spills into the next and reports the shortfall
  const early = Q.policyOptions({ today: '2026-10-01', tranches: tr, surplus_kg_day: 47148, horizon_days: 60, holders: [] }).find((x) => x.kind === 'defer_import');
  assert.equal(early.recommended_tranche_id, 't1');
  const big = Q.policyOptions({ today: '2027-02-01', tranches: tr, surplus_kg_day: 5e6, horizon_days: 90, holders: [] }).find((x) => x.kind === 'defer_import');
  assert.equal(big.propose_t, 19366.27);
  assert.ok(big.shortfall_t > 0);
  const p = o.find((x) => x.kind === 'domestic_powder');
  assert.equal(p.powder_t, 257.17);
  assert.equal(o[0].kind, 'absorb_by_quota_holders');
  assert.equal(o[0].unassigned_kg_day, 47148);
  assert.deepEqual(Q.policyOptions({ today: '2027-02-01', tranches: tr, surplus_kg_day: 0 }), []);
  assert.ok(!Q.policyOptions({ today: '2027-07-01', tranches: tr, surplus_kg_day: 1000, horizon_days: 30, holders: [] }).some((x) => x.kind === 'defer_import'));
});

test('coop recommender: a quota holder under an active measure is an option with its remaining share', () => {
  const kase = { scope: 'coop', horizon: '7d', surplus_kg_day: 3000, expected_kg_day: 20000, days: 7 };
  const opts = S.buildOptions(kase, {
    s: { surplus_min_price_per_kg: 0, transport_cost_per_ton_km: 3 }, origin: null, hours_left: 72, sale_price: 19.5, today: '2027-02-01',
    quota_holders: [{ holder_id: 'h1', name: 'โรงงาน ก', entity_group: 1, remaining_kg_day: 1200, measure_id: 'm1', lat: 14, lng: 101 }],
  });
  const q = opts.find((o) => o.kind === 'quota_holder');
  assert.equal(q.kg_per_day, 1200);
  assert.equal(q.measure_id, 'm1');
  assert.equal(q.feasible, true);
  assert.ok(q.reasons.includes('import_quota_measure'));
});
