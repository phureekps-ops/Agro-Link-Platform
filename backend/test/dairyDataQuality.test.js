const test = require('node:test');
const assert = require('node:assert/strict');

const DQ = require('../src/lib/dairyDataQuality');

const { xlsx } = require('./fixtures/xlsx');

test('parseDate: ISO, พ.ศ., ค.ศ., ปี 2 หลัก, เดือนไทย, Excel serial; ปฏิเสธวันที่ไม่มีจริง', () => {
  assert.deepEqual(DQ.parseDate('2026-11-26'), { date: '2026-11-26', era: 'ce' });
  assert.deepEqual(DQ.parseDate('26/11/2569'), { date: '2026-11-26', era: 'be' });
  assert.deepEqual(DQ.parseDate('26/11/2026'), { date: '2026-11-26', era: 'ce' });
  assert.equal(DQ.parseDate('26/11/69').date, '2026-11-26');
  assert.equal(DQ.parseDate('26/11/26').date, '2026-11-26');
  assert.equal(DQ.parseDate('26 พ.ย. 69').date, '2026-11-26');
  assert.equal(DQ.parseDate(46352).date, '2026-11-26');
  assert.equal(DQ.parseDate('31/02/2569'), null);
  assert.equal(DQ.parseDate('abc'), null);
});

test('parseCsv: BOM, ; และค่าในเครื่องหมายคำพูดที่มีจุลภาค/ขึ้นบรรทัด', () => {
  const t = DQ.parseCsv('\uFEFFรหัส;น้ำหนัก;หมายเหตุ\r\nM1;"1,234.5";"ก, ข\nค"\r\n');
  assert.deepEqual(t, [['รหัส', 'น้ำหนัก', 'หมายเหตุ'], ['M1', '1,234.5', 'ก, ข\nค']]);
  assert.equal(DQ.parseNum('1,234.5'), 1234.5);
  assert.equal(DQ.parseNum('42 กก.'), 42);
  assert.ok(Number.isNaN(DQ.parseNum('สี่สิบ')));
});

test('parseFile: อ่าน .xlsx แผ่นแรก ข้ามแถวว่าง และเก็บเลขแถวเดิม', () => {
  const buf = xlsx([['รหัสสมาชิก', 'วันที่', 'รอบ', 'น้ำหนัก (กก.)'], ['M001', 46352, 'เช้า', 42.5], [null, null, null, null], ['M002', '26/11/2569', 'เย็น', 38]]);
  const p = DQ.parseFile('รับนม.xlsx', buf);
  assert.equal(p.format, 'xlsx');
  assert.deepEqual(p.header, ['รหัสสมาชิก', 'วันที่', 'รอบ', 'น้ำหนัก (กก.)']);
  assert.deepEqual(p.rows.map((r) => r.row_no), [2, 4]);
  assert.equal(p.rows[0].cells[3], 42.5);
  assert.throws(() => DQ.parseFile('x.xls', Buffer.from('abc')), (e) => e.code === 'xls_not_supported');
  assert.throws(() => DQ.parseFile('x.csv', Buffer.from('a,b\n')), (e) => e.code === 'no_data_rows');
  // CSV จาก Excel ภาษาไทยรุ่นเก่า (TIS-620)
  const tis = Buffer.from([0xC3, 0xCB, 0xD1, 0xCA, 0x2C, 0x6B, 0x67, 0x0A, 0x4D, 0x31, 0x2C, 0x35, 0x0A]);
  assert.deepEqual(DQ.parseFile('old.csv', tis).header, ['รหัส', 'kg']);
  const j = DQ.parseFile('x.json', Buffer.from(JSON.stringify([{ member_code: 'M1', weight_kg: 10 }])));
  assert.deepEqual(j.header, ['member_code', 'weight_kg']);
});

test('mapColumns: หัวคอลัมน์ไทย/อังกฤษ และแจ้งคอลัมน์ที่ขาด', () => {
  const m = DQ.mapColumns('intake', ['รหัสสมาชิก', 'วันที่รับนม', 'รอบ', 'ศูนย์รับนม', 'น้ำหนักนม (กก.)', 'หมายเหตุ']);
  assert.deepEqual(m.map, { member_code: 0, round_date: 1, shift: 2, center: 3, weight_kg: 4 });
  assert.deepEqual(m.unknown, ['หมายเหตุ']);
  assert.deepEqual(DQ.mapColumns('intake', ['code', 'date']).missing, ['weight_kg']);
  const q = DQ.mapColumns('quality', ['Member Code', 'Date', 'Fat %', 'SNF', 'SCC', 'Antibiotic']);
  assert.deepEqual(Object.keys(q.map).sort(), ['antibiotic_pos', 'fat_pct', 'member_code', 'sample_date', 'scc_k', 'snf_pct']);
});

const MAP = { member_code: 0, round_date: 1, shift: 2, weight_kg: 3, status: 4, reject_reason: 5 };
const norm = (cells, opts) => DQ.normalizeRow('intake', cells, MAP, { today: '2026-11-26', ...opts });

test('normalizeRow (รับนม): แปลงค่า และจับข้อผิดพลาดพื้นฐาน', () => {
  const ok = norm(['M001', '26/11/2569', 'เช้า', '42.5', 'รับ', null]);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.values.round_date, '2026-11-26');
  assert.equal(ok.values.shift, 'AM');
  assert.equal(ok.values.status, 'Accepted');
  const codes = (r) => r.errors.map((e) => e.code);
  assert.deepEqual(codes(norm(['M001', '27/11/2569', 'เช้า', '10'])), ['future_date']);
  assert.deepEqual(codes(norm(['M001', '26/11/2569', 'กลางวัน', '10'])), ['invalid_shift']);
  assert.deepEqual(codes(norm(['M001', '26/11/2569', 'เช้า', '-3'])), ['weight_not_positive']);
  assert.deepEqual(codes(norm(['M001', '26/11/2569', 'เช้า', '9000'])), ['weight_too_high']);
  assert.deepEqual(codes(norm(['M001', '26/11/2569', 'เช้า', '10', 'ไม่รับ', null])), ['missing_reject_reason']);
  assert.deepEqual(codes(norm([null, null, null, null])), ['missing_member_code', 'missing_date', 'missing_shift', 'missing_weight']);
  const d = norm(['M001', null, null, '10'], { default_date: '2026-11-25', default_shift: 'PM' });
  assert.deepEqual(d.errors, []);
  assert.deepEqual(d.warnings.map((w) => w.code), ['date_defaulted', 'shift_defaulted']);
  const rj = norm(['M001', '26/11/2569', 'เย็น', '20', 'ปฏิเสธ', 'ยาปฏิชีวนะ']);
  assert.equal(rj.values.reject_reason, 'antibiotic');
});

test('normalizeRow (คุณภาพ): หน่วย SCC เซลล์/มล. → พัน, ช่วงค่า, เกณฑ์มาตรฐาน', () => {
  const QM = { member_code: 0, sample_date: 1, fat_pct: 2, snf_pct: 3, scc_k: 4, antibiotic_pos: 5 };
  const r = DQ.normalizeRow('quality', ['M001', '2026-11-20', '3.0', '8.6', '650000', 'พบ'], QM, { today: '2026-11-26' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.values.scc_k, 650);
  assert.deepEqual(r.warnings.map((w) => w.code).sort(), ['antibiotic_positive', 'fat_below_standard', 'scc_high', 'unit_converted']);
  const bad = DQ.normalizeRow('quality', ['M001', '2026-11-20', '45', null, null, 'อาจจะ'], QM, { today: '2026-11-26' });
  assert.deepEqual(bad.errors.map((e) => e.code), ['out_of_range', 'invalid_boolean']);
  const empty = DQ.normalizeRow('quality', ['M001', '2026-11-20', null, null, null, null], QM, { today: '2026-11-26' });
  assert.deepEqual(empty.errors.map((e) => e.code), ['empty_test']);
});

test('validateRows (รับนม): สมาชิก ศูนย์ รอบปิด ซ้ำในไฟล์ ซ้ำในระบบ ผิดปกติ หยุดยา งวดที่จ่ายแล้ว', () => {
  const C1 = '11111111-1111-1111-1111-111111111111';
  const C2 = '22222222-2222-2222-2222-222222222222';
  const ctx = {
    members: new Map([
      ['M001', { member_id: 'a', status: 'Approved', center_id: C1, full_name: 'ก', avg_kg: 40 }],
      ['M002', { member_id: 'b', status: 'Suspended', center_id: C1, full_name: 'ข', avg_kg: 0 }],
      ['M003', { member_id: 'c', status: 'Approved', center_id: null, full_name: 'ค', avg_kg: 0 }],
      ['M004', { member_id: 'd', status: 'Approved', center_id: C2, full_name: 'ง', avg_kg: 30 }],
    ]),
    centers: [{ center_id: C1, name: 'ศูนย์ 1' }, { center_id: C2, name: 'ศูนย์ 2' }],
    rounds: new Map([[`${C2}|2026-11-25|AM`, { status: 'Closed' }]]),
    intakes: new Map([
      [`a|${C1}|2026-11-25|PM`, { weight_kg: '41.00', status: 'Accepted', reject_reason: null }],
      [`a|${C1}|2026-11-24|PM`, { weight_kg: '39.00', status: 'Accepted', reject_reason: null }],
    ]),
    otherCenterIntakes: new Map(),
    withdrawal: new Map([['d', [{ ear_tag: 'TH-9', until: '2026-11-30' }]]]),
    tests: new Map(),
    settled: [{ start: '2026-11-01', end: '2026-11-15' }],
  };
  const rows = [
    norm(['M001', '2026-11-26', 'AM', '42']), // 2 ok
    norm(['M001', '2026-11-26', 'AM', '43']), // 3 ซ้ำในไฟล์
    norm(['M002', '2026-11-26', 'AM', '10']), // 4 สมาชิกถูกระงับ
    norm(['M009', '2026-11-26', 'AM', '10']), // 5 ไม่พบสมาชิก
    norm(['M003', '2026-11-26', 'AM', '10']), // 6 ไม่มีศูนย์
    norm(['M001', '2026-11-25', 'PM', '41']), // 7 ซ้ำกับในระบบ → duplicate
    norm(['M001', '2026-11-24', 'PM', '35']), // 8 จะแทนค่าเดิม
    norm(['M004', '2026-11-25', 'AM', '30']), // 9 รอบปิดแล้ว
    norm(['M001', '2026-11-23', 'AM', '200']), // 10 ผิดปกติ
    norm(['M004', '2026-11-26', 'PM', '30']), // 11 หยุดยา
    norm(['M001', '2026-11-10', 'AM', '40']), // 12 งวดจ่ายแล้ว
  ].map((r, i) => ({ row_no: i + 2, ...r }));
  const v = DQ.validateRows('intake', rows, ctx);
  const by = Object.fromEntries(v.map((r) => [r.row_no, [r.verdict, ...r.errors.map((e) => e.code), ...r.warnings.map((w) => w.code)]]));
  assert.deepEqual(by[2], ['ok']);
  assert.deepEqual(by[3], ['error', 'duplicate_in_file']);
  assert.deepEqual(by[4], ['error', 'member_not_approved']);
  assert.deepEqual(by[5], ['error', 'member_not_found']);
  assert.deepEqual(by[6], ['error', 'missing_center']);
  assert.deepEqual(by[7], ['duplicate']);
  assert.deepEqual(by[8], ['warning', 'will_replace']);
  assert.deepEqual(by[9], ['error', 'round_closed', 'withdrawal_animals']);
  assert.deepEqual(by[10], ['warning', 'weight_outlier']);
  assert.deepEqual(by[11], ['warning', 'withdrawal_animals']);
  assert.equal(v.find((r) => r.row_no === 11).withdrawal, true);
  assert.deepEqual(by[12], ['error', 'period_settled']);
  const s = DQ.summarize(v);
  assert.deepEqual([s.ok_count, s.warning_count, s.error_count, s.duplicate_count], [1, 3, 6, 1]);
  // ใส่ศูนย์ปลายทางให้ M003 ได้จากตัวเลือก
  const d = DQ.validateRows('intake', [rows[4]], { ...ctx, defaultCenterId: C2 });
  assert.equal(d[0].verdict, 'warning');
  assert.equal(d[0].values.center_name, 'ศูนย์ 2');
});

test('template: CSV มี BOM และอ่านกลับเข้าระบบได้ครบ', () => {
  ['intake', 'quality'].forEach((kind) => {
    const csv = DQ.template(kind, { member_code: 'M001', center: 'ศูนย์ 1', date_be: '26/11/2569' });
    assert.ok(csv.startsWith('\uFEFF'));
    const p = DQ.parseFile('t.csv', Buffer.from(csv));
    const m = DQ.mapColumns(kind, p.header);
    assert.deepEqual(m.missing, []);
    assert.deepEqual(m.unknown, []);
    p.rows.forEach((r) => assert.deepEqual(DQ.normalizeRow(kind, r.cells, m.map, { today: '2026-11-26' }).errors, []));
  });
});
