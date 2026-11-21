/* Unit tests for src/lib/lddSoil.js (LDD soil-analysis connector) — no network, no database. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const ldd = require('../src/lib/lddSoil');

test('classifyParameter: Thai, English and HTML names', () => {
  const cases = {
    'pH (1:1 H<sub>2</sub>O)': 'ph',
    'ความเป็นกรด-ด่าง': 'ph',
    'อินทรียวัตถุ (%)': 'om',
    'Organic Matter': 'om',
    'OM': 'om',
    'ฟอสฟอรัสที่เป็นประโยชน์ (mg/kg)': 'p',
    'Avail. P': 'p',
    'P<sub>2</sub>O<sub>5</sub>': 'p',
    'โพแทสเซียมที่แลกเปลี่ยนได้': 'k',
    'Exch. K': 'k',
    'ไนโตรเจนทั้งหมด (%)': 'n',
    'Total N': 'n',
    'EC (dS/m)': 'ec',
    'ความต้องการปูน (Lime requirement)': null,
    'แคลเซียม': null,
    '': null,
  };
  for (const [name, want] of Object.entries(cases)) assert.equal(ldd.classifyParameter(name), want, name);
});

test('parseNumber / parseDate / parseLevelText', () => {
  assert.equal(ldd.parseNumber('12.5'), 12.5);
  assert.equal(ldd.parseNumber('< 0.5'), 0.5);
  assert.equal(ldd.parseNumber('1,234.5 mg/kg'), 1234.5);
  assert.equal(ldd.parseNumber('-'), null);
  assert.equal(ldd.parseNumber(''), null);
  assert.equal(ldd.parseNumber(7), 7);
  assert.equal(ldd.parseDate('2025-08-01 10:00:00'), '2025-08-01');
  assert.equal(ldd.parseDate('01/08/2568'), '2025-08-01');
  assert.equal(ldd.parseDate('5/1/2024'), '2024-01-05');
  assert.equal(ldd.parseDate('ไม่ทราบ'), null);
  assert.equal(ldd.parseLevelText('ต่ำ'), 'low');
  assert.equal(ldd.parseLevelText('ปานกลาง'), 'medium');
  assert.equal(ldd.parseLevelText('สูงมาก'), 'high');
});

test('extractRows accepts an array or a wrapped array', () => {
  assert.deepEqual(ldd.extractRows([1]), [1]);
  assert.deepEqual(ldd.extractRows({ data: [2] }), [2]);
  assert.deepEqual(ldd.extractRows({ result: [3] }), [3]);
  assert.equal(ldd.extractRows({ foo: 1 }), null);
});

const ROWS = [
  // sample 1 (Khon Kaen, 2 items + one unmapped)
  { parameter: 'pH', province: 'ขอนแก่น', value: '5.2', latitude: '16.4400', longitude: '102.8300', date: '2025-06-01', amphur: 'เมืองขอนแก่น' },
  { parameter: 'อินทรียวัตถุ (%)', province: 'ขอนแก่น', value: '0.9', latitude: '16.4400', longitude: '102.8300', date: '2025-06-01', amphur: 'เมืองขอนแก่น' },
  { parameter: 'ฟอสฟอรัสที่เป็นประโยชน์', province: 'ขอนแก่น', value: '8', latitude: '16.4400', longitude: '102.8300', date: '2025-06-01', amphur: 'เมืองขอนแก่น' },
  { parameter: 'โพแทสเซียมที่แลกเปลี่ยนได้', province: 'ขอนแก่น', value: '95', latitude: '16.4400', longitude: '102.8300', date: '2025-06-01', amphur: 'เมืองขอนแก่น' },
  { parameter: 'แคลเซียม', province: 'ขอนแก่น', value: '300', latitude: '16.4400', longitude: '102.8300', date: '2025-06-01', amphur: 'เมืองขอนแก่น' },
  // sample 2 (same province, other point, text level for K)
  { parameter: 'อินทรียวัตถุ', province: 'จังหวัดขอนแก่น', value: '2.0', latitude: 16.5, longitude: 102.9, date: '10/07/2568' },
  { parameter: 'Exch. K', province: 'จังหวัดขอนแก่น', value: 'ต่ำ', latitude: 16.5, longitude: 102.9, date: '10/07/2568' },
  // other province and an out-of-Thailand point — both dropped
  { parameter: 'pH', province: 'เชียงใหม่', value: '6.0', latitude: 18.8, longitude: 98.98, date: '2025-06-01' },
  { parameter: 'pH', province: 'ขอนแก่น', value: '6.0', latitude: 0, longitude: 0, date: '2025-06-01' },
];

test('groupSamples: rows → samples, province filter, unmapped names counted', () => {
  const { samples, unmapped } = ldd.groupSamples(ROWS, 'ขอนแก่น');
  assert.equal(samples.length, 2);
  const s1 = samples.find((s) => s.values.ph === 5.2);
  assert.deepEqual(s1.values, { ph: 5.2, om: 0.9, p: 8, k: 95 });
  assert.equal(s1.sampled_on, '2025-06-01');
  assert.equal(s1.amphur, 'เมืองขอนแก่น');
  const s2 = samples.find((s) => s.values.om === 2);
  assert.equal(s2.sampled_on, '2025-07-10');
  assert.equal(s2.text_levels.k, 'low');
  assert.deepEqual(unmapped, { แคลเซียม: 1 });
});

// Exact shape returned by https://osd101.ldd.go.th/api/data.php (seen 21 Nov 2026):
// one row per item, HTML <sup> in the name, unit after a line break, Thai long date,
// and two soil samples taken at the same point on the same day.
const API_ROWS = [];
const P = (name, value, extra = {}) => API_ROWS.push({
  parameter: name, province: 'สุราษฎร์ธานี', value, latitude: '8.878', longitude: '98.806',
  date: '13 พฤศจิกายน พ.ศ. 2569', address: '22', village: '', district: 'พังกาญจน์', amphur: 'พนม', ...extra,
});
[['1.77', '1.72', '70', '4.93', '0.021'], ['1.94', '1.26', '50', '4.83', '0.010']].forEach(([om, p, k, ph, ec]) => {
  P('อินทรียวัตถุ<sup>1</sup> (OM)\n%', om);
  P('ฟอสฟอรัส<sup>2</sup> (P)\nmg/kg', p);
  P('โพแทสเซียม<sup>3</sup> (K)\nmg/kg', k);
  P('ความเป็นกรด-ด่าง<sup>4*</sup> (pH)\n', ph);
  P('ค่าการนำไฟฟ้า<sup>5*</sup> (EC)\ndS/m', ec);
});
P('อินทรียวัตถุ<sup>1</sup> (OM)\n%', '0.03', { province: 'กาญจนบุรี', latitude: '14.70343', longitude: '99.33972', address: '98/3' });

test('groupSamples: real osd101 rows — two samples at one point stay separate, Thai date, other province dropped', () => {
  const { samples, unmapped } = ldd.groupSamples(API_ROWS, 'สุราษฎร์ธานี');
  assert.deepEqual(unmapped, {});
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map((s) => s.values), [
    { om: 1.77, p: 1.72, k: 70, ph: 4.93, ec: 0.021 },
    { om: 1.94, p: 1.26, k: 50, ph: 4.83, ec: 0.01 },
  ]);
  assert.equal(samples[0].sampled_on, '2026-11-13');
  assert.equal(samples[0].amphur, 'พนม');
  assert.ok(!samples[0].sample_key.includes('22'), 'house number must not be stored in the key');
  // the import page numbers rows before splitting a file; _occ keeps the keys stable
  const chunk2 = ldd.groupSamples(API_ROWS.slice(5, 10).map((r) => ({ ...r, _occ: 1 })), 'สุราษฎร์ธานี').samples;
  assert.equal(chunk2[0].sample_key, samples[1].sample_key);
});

test('levelsOf: OM drives N, P/K by mg/kg cut-offs, text levels as fallback', () => {
  assert.deepEqual(ldd.levelsOf({ values: { om: 0.9, p: 8, k: 95 } }), { n_level: 'low', p_level: 'low', k_level: 'high' });
  assert.deepEqual(ldd.levelsOf({ values: { om: 2.0, p: 15, k: 70 } }), { n_level: 'medium', p_level: 'medium', k_level: 'medium' });
  assert.deepEqual(ldd.levelsOf({ values: { om: 4, p: 30 }, text_levels: { k: 'low' } }), { n_level: 'high', p_level: 'high', k_level: 'low' });
  assert.equal(ldd.levelOf('om', 1.5), 'medium'); // boundary belongs to the middle class
  assert.equal(ldd.levelOf('k', 60), 'medium');
  assert.equal(ldd.levelOf('k', 59.9), 'low');
  assert.equal(ldd.levelOf('p', null), null);
});

test('haversineKm', () => {
  const d = ldd.haversineKm(16.44, 102.83, 16.5, 102.9);
  assert.ok(d > 9 && d < 11, String(d));
});

test('buildUrl + fetchRows against a local fake server', async () => {
  let seen = null;
  const srv = http.createServer((req, res) => {
    seen = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: ROWS }));
  });
  await new Promise((r) => { srv.listen(0, '127.0.0.1', r); });
  const old = process.env.LDD_SOIL_API_URL;
  process.env.LDD_SOIL_API_URL = `http://127.0.0.1:${srv.address().port}/api/data.php?province={province}`;
  try {
    const { rows } = await ldd.fetchRows('ขอนแก่น');
    assert.equal(rows.length, ROWS.length);
    assert.equal(decodeURIComponent(seen), '/api/data.php?province=ขอนแก่น');
  } finally {
    if (old === undefined) delete process.env.LDD_SOIL_API_URL; else process.env.LDD_SOIL_API_URL = old;
    srv.close();
  }
});
