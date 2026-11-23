/*
 * Unit tests for the surplus-milk recommender in src/lib/dairySurplus.js (no database):
 *  - detectCenter / detectCoop: when a case opens, its level, size and deadline
 *  - transport: haversine × road factor × baht/ton-km, estimate without coordinates
 *  - buildOptions / rankOptions: feasibility (time, price floor), net/kg, top 3 + gov help
 * Run with: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/lib/dairySurplus');

const SET = {
  alert_yellow_pct: 1, alert_orange_pct: 3, alert_red_pct: 5, surplus_hold_hours: 24, surplus_min_kg_center: 300,
  surplus_min_kg_coop: 500, transport_cost_per_ton_km: 3, processing_cost_per_kg: 2, surplus_min_price_per_kg: 12, base_price_per_kg: 19,
};
const NOW = new Date('2026-11-23T03:00:00Z');
const MUAKLEK = { lat: 14.65, lng: 101.2 }; // มวกเหล็ก สระบุรี
const NONG_PHO = { lat: 13.73, lng: 99.78 }; // หนองโพ ราชบุรี

test('detectCenter: overflow now = red, overflow at next round = orange, small excess ignored', () => {
  const base = { center_id: 'c1', name: 'ศูนย์ 1', tank_capacity_kg: 5000 };
  const red = S.detectCenter({ ...base, accepted_today_kg: 6000, shipped_today_kg: 500, next_round_kg: 2500 }, SET, NOW);
  assert.equal(red.alert_level, 'red');
  assert.equal(red.surplus_kg_day, 3000); // 5,500 ค้าง + 2,500 รอบหน้า − 5,000
  assert.equal(red.horizon, 'today');
  assert.equal(red.deadline_at.getTime() - NOW.getTime(), 24 * 3600 * 1000);
  assert.deepEqual(red.detail.unshipped_kg, 5500);

  const orange = S.detectCenter({ ...base, accepted_today_kg: 3000, shipped_today_kg: 0, next_round_kg: 2600 }, SET, NOW);
  assert.equal(orange.alert_level, 'orange');
  assert.equal(orange.surplus_kg_day, 600);

  assert.equal(S.detectCenter({ ...base, accepted_today_kg: 3000, shipped_today_kg: 0, next_round_kg: 2200 }, SET, NOW), null); // เกิน 200 < 300
  assert.equal(S.detectCenter({ ...base, tank_capacity_kg: null, accepted_today_kg: 9000 }, SET, NOW), null); // ไม่รู้ความจุ
  // shipping more than was received never goes negative
  assert.equal(S.detectCenter({ ...base, accepted_today_kg: 1000, shipped_today_kg: 4000, next_round_kg: 2000 }, SET, NOW), null);
});

test('detectCoop: 7-day case uses the larger of committed and actually shipped; first forecast window only', () => {
  const x = {
    recent_avg_kg_day: 22000, committed7_kg_day: 18000, shipped14_kg_day: 20000, plant_kg_day: 500,
    windows: [
      { days: 90, avg_forecast_kg: 26000, avg_committed_kg: 18000 },
      { days: 30, avg_forecast_kg: 22500, avg_committed_kg: 21000 },
      { days: 60, avg_forecast_kg: 24000, avg_committed_kg: 20000 },
    ],
  };
  const out = S.detectCoop(x, SET, NOW);
  const d7 = out.find((k) => k.horizon === '7d');
  assert.equal(d7.capacity_kg_day, 20500); // max(18,000, 20,000) + 500
  assert.equal(d7.surplus_kg_day, 1500);
  assert.equal(d7.alert_level, 'red'); // 7.3%
  assert.equal(d7.deadline_at.getTime() - NOW.getTime(), 72 * 3600 * 1000);
  // 30d (1,000 kg) is the same problem as the 7-day case (1,500 kg) → not opened twice
  assert.equal(out.filter((k) => k.horizon !== '7d').length, 0);

  // without a 7-day case: the first window over the threshold, 60/90 not opened separately
  const ahead = S.detectCoop({ ...x, recent_avg_kg_day: 20000 }, SET, NOW);
  assert.deepEqual(ahead.map((k) => k.horizon), ['30d']);
  assert.equal(ahead[0].alert_level, 'orange'); // 22,500 − 21,500 = 1,000 → 4.65%
  assert.equal(ahead[0].deadline_at.getTime() - NOW.getTime(), 7 * 24 * 3600 * 1000);
  // a much bigger surplus later still opens its own case next to the 7-day one
  const worse = S.detectCoop({ ...x, windows: [{ days: 60, avg_forecast_kg: 26000, avg_committed_kg: 20000 }] }, SET, NOW);
  assert.deepEqual(worse.map((k) => k.horizon), ['7d', '60d']);

  // no sales data at all → nothing to compare with → no case
  assert.deepEqual(S.detectCoop({ recent_avg_kg_day: 5000, committed7_kg_day: 0, shipped14_kg_day: 0, plant_kg_day: 0, windows: [] }, SET, NOW), []);
  // below the coop's minimum kg → no case even if the % is high
  assert.deepEqual(S.detectCoop({ recent_avg_kg_day: 1400, committed7_kg_day: 1000, shipped14_kg_day: 0, windows: [] }, SET, NOW), []);
});

test('transport: road distance and cost per kg; estimate when coordinates are missing', () => {
  const t = S.transport(MUAKLEK, NONG_PHO, 3);
  assert.ok(t.distance_km > 210 && t.distance_km < 240, String(t.distance_km)); // ~172 km straight × 1.3
  assert.equal(t.estimated, false);
  assert.equal(t.transport_per_kg, Math.round(((t.distance_km * 3) / 1000) * 100) / 100);
  const e = S.transport(MUAKLEK, { lat: null, lng: null }, 3);
  assert.equal(e.estimated, true);
  assert.equal(e.distance_km, null);
  assert.equal(e.transport_per_kg, 0.45); // 150 กม. × 3 บาท/ตัน-กม.
});

function ctxFor(hours) {
  return {
    s: SET, today: '2026-11-23', hours_left: hours, origin: MUAKLEK, sale_price: 19.5,
    centers: [
      { center_id: 'c1', name: 'ศูนย์ที่ล้น', free_kg: 0, ...MUAKLEK },
      { center_id: 'c2', name: 'ศูนย์ 2', free_kg: 1200, lat: 14.7, lng: 101.1 },
    ],
    buyers: [{ partner_id: 'p1', name: 'โรงงานคู่สัญญา', daily_kg: 10000, price_per_kg: 19.8 }],
    capacities: [
      { capacity_id: 'k1', display_name: 'โรงงาน UHT ราชบุรี', kg_per_day: 5000, price_per_kg: 17, available_from: '2026-11-20', available_to: '2026-12-31', ...NONG_PHO },
      { capacity_id: 'k2', display_name: 'โรงงานราคาต่ำ', kg_per_day: 9000, price_per_kg: 11, available_from: '2026-11-01', available_to: '2026-12-31' },
      { capacity_id: 'k3', display_name: 'ยังไม่เปิดรับ', kg_per_day: 9000, price_per_kg: 18, available_from: '2027-03-01', available_to: '2027-04-01' },
    ],
    directory: [{ entry_id: 'd1', name: 'ผู้รับซื้อในทะเบียน', processing_capacity_l_day: null, price_baht_per_kg: 18 }],
    plant_product: { product_id: 'pr1', name: 'นม UHT 200 มล.', sell_price: 9, milk_kg_per_unit: 0.21 },
  };
}

test('buildOptions: centre case — transfer, buyer extra, processors; timing and price floor', () => {
  const kase = { scope: 'center', horizon: 'today', center_id: 'c1', surplus_kg_day: 3000, expected_kg_day: 8000, days: 1 };
  const opts = S.buildOptions(kase, ctxFor(24));
  const by = (k, id) => opts.find((o) => o.kind === k && (!id || o.target_id === id));
  // never transfers to itself
  assert.equal(opts.filter((o) => o.kind === 'transfer_center').length, 1);
  assert.equal(by('transfer_center').kg_per_day, 1200);
  assert.equal(by('buyer_extra').kg_per_day, 2000); // 20% ของ 10,000
  assert.equal(by('buyer_extra').net_per_kg, 19.8);
  const k1 = by('processor_match', 'k1');
  assert.equal(k1.kg_per_day, 3000);
  assert.ok(k1.transport_per_kg > 0.6 && k1.transport_per_kg < 0.75);
  assert.equal(k1.net_per_kg, Math.round((17 - k1.transport_per_kg) * 100) / 100);
  assert.equal(k1.feasible, true); // 24 ชม. พอดี
  const k2 = by('processor_match', 'k2');
  assert.equal(k2.feasible, false);
  assert.ok(k2.reasons.includes('below_min_price'));
  assert.ok(k2.reasons.includes('transport_estimated'));
  assert.equal(by('processor_match', 'k3'), undefined); // ช่วงเวลาไม่ทับกัน
  // directory buyer needs 72 h of contact → not in time for a same-day overflow
  assert.equal(by('directory_buyer').feasible, false);
  assert.ok(by('directory_buyer').reasons.includes('not_in_time'));
  // own plant: 9 / 0.21 = 42.86 per kg of milk, minus processing 2
  assert.equal(by('own_plant').price_per_kg, 42.86);
  assert.equal(by('own_plant').net_per_kg, 40.86);
  assert.equal(by('own_plant').kg_per_day, 3000);
  assert.ok(by('own_plant').reasons.includes('check_plant_capacity'));
  // with production history the plant only takes its spare capacity
  const spare = S.buildOptions(kase, { ...ctxFor(24), plant_spare_kg: 800 }).find((o) => o.kind === 'own_plant');
  assert.equal(spare.kg_per_day, 800);
  assert.ok(spare.reasons.includes('spare_from_history'));
  assert.equal(by('herd_plan'), undefined); // only for 30 days and longer

  // only 12 hours left → processors (24 h) are not in time
  const tight = S.buildOptions(kase, ctxFor(12));
  assert.equal(tight.find((o) => o.target_id === 'k1').feasible, false);
  assert.equal(tight.find((o) => o.kind === 'own_plant').feasible, true);
});

test('rankOptions: feasible first, by total value; top 3 then province help last', () => {
  const kase = { scope: 'coop', horizon: '30d', center_id: null, surplus_kg_day: 6000, expected_kg_day: 30000, days: 30 };
  const ctx = ctxFor(7 * 24);
  ctx.plant_product = null;
  const ranked = S.rankOptions(S.buildOptions(kase, ctx), kase);
  assert.equal(ranked.length, 4);
  assert.deepEqual(ranked.map((o) => o.rank), [1, 2, 3, 4]);
  assert.equal(ranked[3].kind, 'gov_help');
  // 1) directory 6,000 × (18 − 0.45) 2) processor k1 5,000 × ~16.3 3) buyer extra 2,000 × 19.8
  assert.deepEqual(ranked.slice(0, 3).map((o) => o.kind), ['directory_buyer', 'processor_match', 'buyer_extra']);
  assert.ok(ranked.slice(0, 3).every((o) => o.feasible));
  assert.ok(ranked[3].reasons.includes('backup'));

  // nothing feasible → province help carries the whole surplus
  const none = S.rankOptions([{ kind: 'processor_match', kg_per_day: 100, net_per_kg: 10, feasible: false, lead_hours: 24 }], kase);
  assert.equal(none[1].kind, 'gov_help');
  assert.equal(none[1].kg_per_day, 6000);
  assert.ok(none[1].reasons.includes('uncovered_surplus'));
});

test('herd plan appears for long horizons and is capped at 5% of expected milk', () => {
  const kase = { scope: 'coop', horizon: '90d', center_id: null, surplus_kg_day: 4000, expected_kg_day: 30000, days: 90 };
  const ctx = { ...ctxFor(30 * 24), buyers: [], capacities: [], directory: [], plant_product: null };
  const opts = S.buildOptions(kase, ctx);
  assert.equal(opts.length, 1);
  assert.equal(opts[0].kind, 'herd_plan');
  assert.equal(opts[0].kg_per_day, 1500);
  assert.equal(opts[0].feasible, true);
  assert.equal(opts[0].net_per_kg, null);
});
