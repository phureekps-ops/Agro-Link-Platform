const test = require('node:test');
const assert = require('node:assert/strict');
const DQ = require('../src/lib/dairyDataQuality');
const CR = require('../src/lib/coopRegistry');
const R = require('../src/lib/coopRisk');

const PROVINCES = [
  { province_code: 'SURIN', province_name_th: 'สุรินทร์' }, { province_code: 'BANGKOK', province_name_th: 'กรุงเทพมหานคร' },
  { province_code: 'KHON_KAEN', province_name_th: 'ขอนแก่น' },
];
const idx = CR.provinceIndex(PROVINCES);
const parse = (kind, csv, opts = {}) => {
  const p = DQ.parseFile('x.csv', Buffer.from(csv, 'utf8'));
  const cols = CR.mapColumns(kind, p.header);
  return { cols, rows: p.rows.map((r) => ({ row_no: r.row_no, ...CR.normalizeRow(kind, r.cells, cols.map, { provinceIdx: idx, ...opts }) })) };
};

test('directory: Thai headers, types from column or name, province names, B.E./C.E. years, statuses, identifiers', () => {
  const { cols, rows } = parse('directory', [
    'ชื่อสหกรณ์,เลขทะเบียน,เลขประจำตัวผู้เสียภาษี,ประเภท,จังหวัด,อำเภอ,ปีที่จดทะเบียน,จำนวนสมาชิก (คน),สถานะ,หมายเหตุ',
    'สหกรณ์การเกษตรเมืองสุรินทร์ จำกัด,สร 12/2520,0-9940-00123-45-6,การเกษตร,จังหวัดสุรินทร์,อำเภอเมืองสุรินทร์,2520,"1,250",ดำเนินการ,',
    'สหกรณ์ออมทรัพย์ครูขอนแก่น จำกัด,ขก 3/2505,,,ขอนแก่น,เมือง,1962,9000,,',
    'สหกรณ์เครดิตยูเนี่ยนบ้านโนน จำกัด,,12345,,กทม,,15/06/2530,,อยู่ระหว่างชำระบัญชี,',
    'สหกรณ์ร้านค้าตัวอย่าง จำกัด,,,,ไม่มีจังหวัดนี้,,,abc,ถอนชื่อออกจากทะเบียน,',
    ',xx,,,สุรินทร์,,,,,',
  ].join('\n'));
  assert.deepEqual(cols.missing, []);
  assert.deepEqual(cols.unknown, ['หมายเหตุ']);
  const [a, b, c, d, e] = rows;
  assert.deepEqual(a.errors, []);
  assert.equal(a.data.tax_id, '0994000123456');
  assert.equal(a.data.coop_type, 'agriculture');
  assert.equal(a.data.province_code, 'SURIN');
  assert.equal(a.data.district, 'เมืองสุรินทร์');
  assert.equal(a.data.member_count, 1250);
  assert.equal(a.data.name_key, 'สหกรณ์การเกษตรเมืองสุรินทร์');
  assert.equal(b.data.coop_type, 'savings'); // ไม่มีคอลัมน์ประเภท → อ่านจากชื่อ
  assert.equal(b.data.established_year, 2505); // ค.ศ. 1962 → พ.ศ.
  assert.equal(c.data.coop_type, 'credit_union');
  assert.equal(c.data.province_code, 'BANGKOK');
  assert.equal(c.data.established_year, 2530);
  assert.equal(c.data.status, 'dissolving');
  assert.deepEqual(c.warnings.map((w) => w.code), ['invalid_tax_id', 'no_identifier']); // เลข 5 หลักไม่ใช้ เหลือจับคู่ด้วยชื่อ+จังหวัด
  assert.equal(c.data.tax_id, null);
  assert.deepEqual(d.errors.map((x) => x.code), ['unknown_province']);
  assert.equal(d.data.status, 'dissolved');
  assert.ok(d.warnings.some((w) => w.code === 'invalid_number'));
  assert.deepEqual(e.errors.map((x) => x.code), ['missing_value', 'unknown_type']);
  assert.deepEqual(parse('directory', 'ชื่อ,ประเภท\nก,ข').cols.missing, ['province']);
});

test('directory classify: new / update (blank cells keep old values) / same / in-file duplicate / identifier conflicts', () => {
  const existing = [
    { directory_id: 'D1', coop_name: 'สหกรณ์การเกษตรเมืองสุรินทร์ จำกัด', name_key: 'สหกรณ์การเกษตรเมืองสุรินทร์', coop_type: 'agriculture', registration_no: 'สร 12/2520', tax_id: '0994000123456', province_code: 'SURIN', district: 'เมืองสุรินทร์', established_year: 2520, member_count: 1200, status: 'active', org_id: 'ORG1' },
    { directory_id: 'D2', coop_name: 'สหกรณ์การเกษตรปราสาท จำกัด', name_key: 'สหกรณ์การเกษตรปราสาท', coop_type: 'agriculture', registration_no: 'สร 20/2522', tax_id: '0994000999999', province_code: 'SURIN', district: null, established_year: null, member_count: null, status: 'active', org_id: null },
  ];
  const { rows } = parse('directory', [
    'ชื่อสหกรณ์,เลขทะเบียน,เลขประจำตัวผู้เสียภาษี,จังหวัด,จำนวนสมาชิก',
    'สหกรณ์การเกษตรเมืองสุรินทร์ จำกัด,,0994000123456,สุรินทร์,1250', // จับคู่ด้วยเลขผู้เสียภาษี → update สมาชิก (เลขทะเบียนว่าง ไม่ลบของเดิม)
    'สหกรณ์การเกษตรปราสาท จำกัด,สร 20/2522,0994000999999,สุรินทร์,', // same
    'สหกรณ์การเกษตรใหม่ จำกัด,สร 99/2560,,สุรินทร์,300', // new
    'สหกรณ์การเกษตรใหม่ (ซ้ำ) จำกัด,สร 99/2560,,สุรินทร์,300', // ซ้ำในไฟล์
    'สหกรณ์การเกษตรสับสน จำกัด,สร 12/2520,0994000999999,สุรินทร์,', // เลขทะเบียนเป็นของ D1 แต่เลขผู้เสียภาษีเป็นของ D2
    'สหกรณ์การเกษตรปราสาท จำกัด,สร 77/2599,0994000999999,สุรินทร์,', // เลขผู้เสียภาษีตรง D2 แต่เลขทะเบียนต่าง
  ].join('\n'));
  const out = CR.classifyDirectory(rows, existing);
  assert.deepEqual(out.map((r) => r.verdict), ['update', 'same', 'new', 'error', 'error', 'error']);
  assert.deepEqual(out[0].changes, [{ field: 'member_count', from: 1200, to: 1250 }]);
  assert.equal(out[0].linked, true);
  assert.equal(out[3].errors[0].code, 'duplicate_in_file');
  assert.equal(out[4].errors[0].code, 'identifier_conflict');
  assert.equal(out[5].errors[0].field, 'registration_no');
  assert.deepEqual(CR.summarize(out), { row_count: 6, new_count: 1, update_count: 1, same_count: 1, error_count: 3, warning_count: 0 });
});

test('financials: match by registration/tax id, new/update/same, balance check; official vs declared comparison → fraud signal', () => {
  const dir = [{ directory_id: 'D1', coop_name: 'สหกรณ์การเกษตรเมืองสุรินทร์ จำกัด', registration_no: 'สร 12/2520', tax_id: '0994000123456' }];
  const { cols, rows } = parse('financials', [
    'เลขทะเบียน,เลขประจำตัวผู้เสียภาษี,ปีบัญชี,สินทรัพย์รวม (บาท),หนี้สินรวม,ทุนของสหกรณ์,กำไรสุทธิ',
    'สร 12/2520,,2567,"80,000,000",40000000,40000000,2000000',
    ',0994000123456,2566,70000000,40000000,20000000,1500000', // ทุนไม่สมดุล → คำเตือน
    'สร 99/9999,,2567,1,1,0,0',
    'สร 12/2520,,2565,,,,',
  ].join('\n'));
  assert.deepEqual(cols.missing, []);
  const out = CR.classifyFinancials(rows, dir, [{ directory_id: 'D1', year: 2566, total_assets: '70000000', total_liabilities: '40000000', equity: '20000000', net_income: '1500000' }]);
  assert.deepEqual(out.map((r) => r.verdict), ['new', 'same', 'error', 'error']);
  assert.deepEqual(out[1].warnings.map((w) => w.code), ['balance_mismatch']);
  assert.equal(out[2].errors[0].code, 'not_in_directory');
  assert.equal(out[3].errors[0].code, 'no_figures');
  assert.deepEqual(CR.mapColumns('financials', ['ชื่อ', 'ปี']).missing, ['registration_no']);

  const declared = [{ year: 2567, total_assets: 80e6, net_income: 3e6, revenue: 50e6 }, { year: 2566, net_income: 1.52e6 }];
  const official = [{ year: 2567, total_assets: '80000000', net_income: '2000000', revenue: null }, { year: 2566, net_income: '1500000' }];
  assert.deepEqual(CR.compareOfficial(declared, official, 5), [{ year: 2567, field: 'net_income', label: 'กำไรสุทธิ', declared: 3e6, official: 2e6, diff_pct: 50 }]);
  const sigs = R.fraudSignals({ borrower: { org_id: 'B1', profile: { financials: declared } }, official: { rows: official, source: 'งบที่ผู้สอบบัญชีรับรอง' }, today: '2026-11-28' });
  assert.deepEqual(sigs.map((x) => [x.code, x.severity, x.dedupe_key]), [['fr_official_mismatch', 'high', 'fr_official_mismatch:B1']]);
  assert.match(sigs[0].detail, /งบที่ผู้สอบบัญชีรับรอง/);
  assert.equal(R.fraudSignals({ borrower: { org_id: 'B1', profile: { financials: declared } }, official: { rows: official }, settings: { fraud_official_diff_pct: 60 }, today: '2026-11-28' }).length, 0);
});

test('helpers: type/status/year parsing, template is importable', () => {
  assert.equal(CR.parseType('', 'สหกรณ์นิคมกันทรลักษ์ จำกัด'), 'settlement');
  assert.equal(CR.parseType('สหกรณ์ประมง', ''), 'fisheries');
  assert.equal(CR.parseType('xyz', 'กลุ่มอะไรสักอย่าง'), null);
  assert.equal(CR.parseStatus('เลิกสหกรณ์ อยู่ระหว่างชำระบัญชี'), 'dissolving');
  assert.equal(CR.parseYearBE(32874), 2533); // Excel serial 1 ม.ค. 1990
  assert.ok(Number.isNaN(CR.parseYearBE('ไม่ทราบ')));
  for (const kind of ['directory', 'financials']) {
    const p = DQ.parseFile('t.csv', Buffer.from(CR.template(kind), 'utf8'));
    const cols = CR.mapColumns(kind, p.header);
    assert.deepEqual(cols.missing, []);
    assert.deepEqual(cols.unknown, []);
    p.rows.forEach((r) => assert.deepEqual(CR.normalizeRow(kind, r.cells, cols.map, { provinceIdx: idx }).errors, []));
  }
});
