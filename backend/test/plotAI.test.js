/* Unit tests for src/lib/plotAI.js — run with: node --test test/ (Node 18+, no dependencies) */
const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../src/lib/plotAI');
const real = require('./fixtures/ndvi_abc.json'); // 3 real AgroLink plots (T69-10-239 test set)

const AS_OF = '2026-11-17';
const PROFILES = {
  rice: { crop_code: 'rice', typical_yield_t_per_rai: 0.45, max_yield_t_per_rai: 1.2, reference_peak_ndvi: 0.8, peak_to_harvest_days: 35, typical_season_days: 120 },
  maize: { crop_code: 'maize', typical_yield_t_per_rai: 0.7, max_yield_t_per_rai: 1.6, reference_peak_ndvi: 0.8, peak_to_harvest_days: 45, typical_season_days: 110 },
  cassava: { crop_code: 'cassava', typical_yield_t_per_rai: 3.3, max_yield_t_per_rai: 8, reference_peak_ndvi: 0.75, peak_to_harvest_days: 120, typical_season_days: 300 },
  sugarcane: { crop_code: 'sugarcane', typical_yield_t_per_rai: 10, max_yield_t_per_rai: 25, reference_peak_ndvi: 0.8, peak_to_harvest_days: 150, typical_season_days: 365 },
};

// deterministic pseudo-noise
function noise(i) { const x = Math.sin(i * 12.9898) * 43758.5453; return (x - Math.floor(x) - 0.5) * 0.04; }
/** NDVI every 5 days from `from` for `days`, shape(t in days) → ndvi */
function synth(from, days, shape, every = 5) {
  const d0 = ai.toDay(from); const out = [];
  for (let t = 0; t <= days; t += every) out.push({ date: ai.dayToIso(d0 + t), ndvi: Math.max(-0.1, Math.min(0.95, shape(t) + noise(t + d0))) });
  return out;
}
const bell = (t, start, rise, plateau, fall, lo, hi) => {
  if (t < start) return lo;
  if (t < start + rise) return lo + (hi - lo) * ((t - start) / rise);
  if (t < start + rise + plateau) return hi;
  if (t < start + rise + plateau + fall) return hi - (hi - lo) * ((t - start - rise - plateau) / fall);
  return lo;
};

function assess(points, extra = {}) {
  return ai.assessPlot({
    unit: { unit_id: 'u', commodity_code: 'RICE_PADDY', area_rai: 10, poly_area_rai: 10, ...(extra.unit || {}) },
    points, deliveries: extra.deliveries || [], harvestStages: extra.harvestStages || [], groundTruth: extra.groundTruth || null,
    profiles: PROFILES, models: extra.models || {}, asOf: extra.asOf || AS_OF,
  });
}

test('plot B (two rice crops a year): two seasons, rice-like, harvest found in August', () => {
  const r = assess(real.B);
  assert.equal(r.seasons.length, 2);
  assert.ok(['rice', 'maize'].includes(r.predicted_crop));
  assert.equal(r.predicted_crop, 'rice');
  // harvested in August and a third crop is greening up again in Oct-Nov
  assert.equal(r.season_status, 'new_season_starting');
  assert.match(r.harvest_date, /^2026-08/);
  assert.ok(!r.flags.some((f) => f.code === 'CROP_MISMATCH'), 'declared rice must not be flagged');
  assert.ok(r.forecast && r.forecast.tons > 0);
});

test('plot C (registered rice, actually water spinach + pond): crop mismatch is flagged', () => {
  const r = assess(real.C, { unit: { commodity_code: 'RICE_PADDY', area_rai: 11.29, poly_area_rai: 11.27 } });
  assert.notEqual(r.predicted_crop, 'rice');
  const m = r.flags.find((f) => f.code === 'CROP_MISMATCH');
  assert.ok(m, 'CROP_MISMATCH expected');
  assert.equal(m.evidence.declared, 'rice');
  assert.ok(m.evidence.declared_fit < 0.25);
  assert.ok(['high', 'medium'].includes(r.risk_level));
});

test('plot C after the owner confirms the crop: mismatch is reported against the confirmation', () => {
  const r = assess(real.C, { groundTruth: { crop_code: 'vegetable' } });
  const m = r.flags.find((f) => f.code === 'CROP_MISMATCH');
  assert.ok(m);
  assert.equal(m.evidence.confirmed, 'vegetable');
  assert.equal(r.confirmed_crop, 'vegetable');
});

test('plot A (jasmine rice, 30 t test delivery in September): delivery before harvest is flagged', () => {
  const r = assess(real.A, {
    unit: { commodity_code: 'RICE_JASMINE', area_rai: 62.04, poly_area_rai: 61.9 },
    deliveries: [{ delivered_at: '2026-09-15', quantity_ton: 30, status: 'delivered' }],
  });
  assert.equal(r.predicted_crop, 'rice');
  assert.ok(!r.flags.some((f) => f.code === 'CROP_MISMATCH'));
  const d = r.flags.find((f) => f.code === 'DELIVERY_BEFORE_HARVEST');
  assert.ok(d, 'DELIVERY_BEFORE_HARVEST expected');
  assert.equal(d.severity, 'high');
  assert.equal(r.risk_level, 'high');
  assert.equal(r.season_status, 'growing');
  assert.ok(r.expected_harvest_date > '2026-11-17');
});

test('synthetic crops: sugarcane, perennial orchard and fallow land are told apart', () => {
  const cane = synth('2025-05-20', 545, (t) => bell(t, 60, 120, 230, 30, 0.2, 0.82));
  assert.equal(assess(cane, { unit: { commodity_code: 'SUGARCANE' } }).predicted_crop, 'sugarcane');
  const orchard = synth('2025-05-20', 545, (t) => 0.72 + 0.04 * Math.sin(t / 58));
  assert.equal(assess(orchard, { unit: { commodity_code: 'DURIAN' } }).predicted_crop, 'perennial');
  const bare = synth('2025-05-20', 545, () => 0.18);
  const r = assess(bare);
  assert.equal(r.predicted_crop, 'fallow');
  assert.ok(r.flags.some((f) => f.code === 'NO_CROP_CYCLE'));
});

test('synthetic cassava (about 10 months) is not called rice', () => {
  const cas = synth('2025-05-20', 545, (t) => bell(t, 150, 110, 150, 40, 0.22, 0.74));
  const r = assess(cas, { unit: { commodity_code: 'CASSAVA' } });
  assert.equal(r.predicted_crop, 'cassava');
  assert.ok(!r.flags.some((f) => f.code === 'CROP_MISMATCH'));
});

test('area, yield and harvest-date checks', () => {
  const rice = synth('2025-05-20', 545, (t) => bell(t, 330, 45, 35, 25, 0.2, 0.82));
  const harvest = assess(rice).harvest_date;
  assert.ok(harvest, 'season should be harvested');
  const r = assess(rice, {
    unit: { area_rai: 10, poly_area_rai: 14 },
    deliveries: [{ delivered_at: harvest, quantity_ton: 20, status: 'delivered' }],
    harvestStages: [{ actual_date: '2026-01-10' }],
  });
  const codes = r.flags.map((f) => f.code);
  assert.ok(codes.includes('AREA_MISMATCH'));
  assert.ok(codes.includes('YIELD_OUTLIER'), '2 t/rai of rice is impossible');
  assert.ok(codes.includes('HARVEST_DATE_MISMATCH'));
  const ok = assess(rice, { deliveries: [{ delivered_at: harvest, quantity_ton: 4.5, status: 'delivered' }] });
  assert.equal(ok.risk_level, 'low');
});

test('too few clear images: LOW_DATA and no crop guess', () => {
  const sparse = [{ date: '2026-03-01', ndvi: 0.5 }, { date: '2026-09-01', ndvi: 0.6 }];
  const r = assess(sparse);
  assert.equal(r.predicted_crop, null);
  assert.ok(r.flags.some((f) => f.code === 'LOW_DATA'));
  assert.equal(r.risk_level, 'unknown');
});

test('crop model refuses to activate on too few labels, then learns from enough', () => {
  const few = ai.trainCropModel([{ features: {}, crop: 'rice' }]);
  assert.equal(few.activated, false);
  assert.equal(few.reason, 'insufficient_data');

  const samples = [];
  for (let i = 0; i < 20; i += 1) {
    const shift = (i * 7) % 40;
    const mk = (pts) => { const s = ai.composite(pts, ai.toDay(AS_OF), 540); return ai.extractFeatures(s, ai.detectSeasons(s)); };
    samples.push({ crop: 'rice', features: mk(synth('2025-05-20', 545, (t) => bell(t, 330 + shift, 45, 35, 25, 0.2, 0.8 + (i % 3) * 0.03))) });
    samples.push({ crop: 'cassava', features: mk(synth('2025-05-20', 545, (t) => bell(t, 150 + shift, 110, 150, 40, 0.22, 0.72))) });
    samples.push({ crop: 'vegetable', features: mk(synth('2025-05-20', 545, (t) => 0.45 + 0.15 * Math.sin((t + shift) / 9))) });
  }
  const m = ai.trainCropModel(samples);
  assert.equal(m.usable_size, 60);
  assert.deepEqual(m.classes, ['rice', 'cassava', 'vegetable']);
  assert.ok(m.metrics.cv_accuracy >= 0.9, `cv ${m.metrics.cv_accuracy}`);
  assert.ok(typeof m.activated === 'boolean');
  if (m.activated) {
    const scores = ai.predictCropMl(m.params, samples[0].features);
    assert.ok(scores.rice > 0.5);
  }
});

test('yield model activates only when it beats the NDVI-scaled baseline', () => {
  const samples = [];
  for (let i = 0; i < 24; i += 1) {
    const peak = 0.6 + (i % 8) * 0.04;
    const season = { peak, amplitude: peak - 0.2, auc: (peak - 0.2) * 900, lengthDays: 100, lengthSoFar: 100 };
    const y = 0.15 + (peak - 0.6) * 2.2 + noise(i) * 0.5; // strong, steeper-than-baseline relation
    samples.push({ features: ai.seasonYieldFeatures(season), yield_t_per_rai: y, baseline: ai.baselineYieldPerRai(PROFILES.rice, season) });
  }
  const m = ai.trainYieldModel('rice', samples);
  assert.equal(m.activated, true);
  assert.ok(m.metrics.cv_mape < m.metrics.baseline_mape);
  const f = ai.forecastYield({ crop: 'rice', season: { peak: 0.8, amplitude: 0.6, auc: 540, lengthDays: 100 }, profile: PROFILES.rice, areaRai: 10, activeYieldModel: { model_id: 'x', params: m.params } });
  assert.equal(f.method, 'ml_ridge');
  assert.ok(f.tons_low < f.tons && f.tons < f.tons_high);
  assert.equal(ai.trainYieldModel('rice', samples.slice(0, 5)).reason, 'insufficient_data');
});

test('plot health factor for the credit model', () => {
  assert.equal(ai.plotHealthFactor([]), null);
  assert.equal(ai.plotHealthFactor([{ risk_level: 'unknown' }]), null);
  assert.equal(ai.plotHealthFactor([{ risk_level: 'low' }, { risk_level: 'high' }, { risk_level: 'unknown' }]), 50);
});
