const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/lib/cropTrace');

test('trace codes: case, spaces and O/0 I/1 L/1 confusion are tolerated, prefix kept', () => {
  assert.equal(T.normCode(' lt-5ewstb3k '), 'LT-5EWSTB3K');
  assert.equal(T.normCode('FG-AB0D2345'.replace('0', 'o')), 'FG-AB0D2345');
  assert.equal(T.normCode('fg ab1d2345'.replace('1', 'l')), 'FG-AB1D2345');
  assert.ok(T.CODE_RE.test(T.normCode('pb-zzzz9999')));
  assert.ok(!T.CODE_RE.test(T.normCode('XX-12345678')));
  assert.ok(!T.CODE_RE.test(T.normCode('FG-1234')));
});

test('satellite plot check, summary and the public view never carry personal data', () => {
  const d = (o) => ({ commodity_code: 'RICE_JASMINE', unit_id: 'U1', crop_confidence: 0.9, quantity_ton: 1, moisture_pct: null, ...o });
  assert.equal(T.plotCheck(d({ predicted_crop: 'rice' })), 'confirmed');
  assert.equal(T.plotCheck(d({ predicted_crop: 'cassava' })), 'mismatch');
  assert.equal(T.plotCheck(d({ predicted_crop: 'cassava', crop_confidence: 0.4 })), 'unknown');
  assert.equal(T.plotCheck(d({ predicted_crop: 'cassava', confirmed_crop: 'rice', crop_confidence: 0.2 })), 'confirmed'); // เกษตรกร/เจ้าหน้าที่ยืนยันแล้ว
  assert.equal(T.plotCheck(d({ unit_id: null, predicted_crop: 'rice' })), 'unknown');

  const trace = {
    start: { type: 'finished_good', id: 'FG1', code: 'FG-AAAABBBB' },
    lots: [{ lot_id: 'L1', trace_code: 'LT-CCCCDDDD', commodity_name: 'ข้าวหอมมะลิ', quality_grade: 'A', created_at: '2026-11-10', closed_at: '2026-11-12', drying: { readings: 3, last_moisture: 14.2 } }],
    deliveries: [
      d({ delivery_id: 'D1', lot_id: 'L1', unit_id: 'U1', area_rai: 10, farmer_id: 'F1', farmer_name: 'นายลับ', farmer_code: 'X1', lat: 14.9, lon: 103.5, predicted_crop: 'rice', quantity_ton: 3, moisture_pct: 25, province_name_th: 'สุรินทร์', quality_grade: 'A', delivered_at: '2026-11-10' }),
      d({ delivery_id: 'D2', lot_id: 'L1', unit_id: 'U1', area_rai: 10, farmer_id: 'F1', farmer_name: 'นายลับ', quantity_ton: 1, moisture_pct: 21, province_name_th: 'สุรินทร์', predicted_crop: 'rice', delivered_at: '2026-11-11' }),
      d({ delivery_id: 'D3', lot_id: 'L1', unit_id: 'U2', area_rai: 5.5, farmer_id: 'F2', farmer_name: 'นางลับ', predicted_crop: 'fallow', quantity_ton: 2, province_name_th: 'บุรีรัมย์', delivered_at: '2026-11-12' }),
    ],
    batches: [{ batch_id: 'B1', status: 'Completed', process_type: 'Milling', output_product_name: 'ข้าวสาร', yield_pct: 66, started_at: '2026-11-13', completed_at: '2026-11-14' },
      { batch_id: 'B2', status: 'Cancelled', process_type: 'Sorting', output_product_name: 'ยกเลิก' }],
    finished_goods: [{ finished_good_id: 'FG1', trace_code: 'FG-AAAABBBB', product_name: 'ข้าวสารหอมมะลิ 5 กก.', recorded_at: '2026-11-14' }],
    shipments: [{ destination: 'ร้านลับ' }],
  };
  const s = T.summarize(trace);
  assert.deepEqual([s.farmers, s.deliveries, s.plots, s.area_rai, s.plots_confirmed, s.plots_mismatch, s.raw_ton, s.final_moisture, s.destinations],
    [2, 3, 2, 15.5, 1, 1, 6, 14.2, 1]);
  assert.equal(s.avg_moisture_in, 24); // ถ่วงด้วยน้ำหนัก (3×25 + 1×21) / 4 — แถวที่ไม่มีค่าความชื้นไม่นับ
  const p = T.publicView(trace, { org_name: 'สหกรณ์ทดสอบ', province_name_th: 'สุรินทร์' });
  assert.equal(p.product, 'ข้าวสารหอมมะลิ 5 กก.');
  assert.deepEqual(p.steps.map((x) => x.step), ['collect', 'lot', 'dry', 'process', 'product']); // รอบที่ยกเลิกไม่แสดง
  const raw = JSON.stringify(p);
  ['นายลับ', 'นางลับ', 'X1', 'ร้านลับ', '14.9', 'F1', 'D1', 'U1'].forEach((secret) => assert.ok(!raw.includes(secret), secret));
});
