/**
 * ทะเบียนสหกรณ์ล่วงหน้า (Cooperative Directory) — ส่วนคำนวณล้วน ไม่แตะฐานข้อมูล (test/coopRegistry.test.js)
 *
 *   นำเข้า 2 แบบ:  directory  รายชื่อสหกรณ์ (ชื่อ เลขทะเบียน เลขผู้เสียภาษี ประเภท จังหวัด อำเภอ ปีจดทะเบียน สมาชิก สถานะ)
 *                  financials งบการเงินจากแหล่งทางการ (ต่อเลขทะเบียน/เลขผู้เสียภาษี ต่อปี พ.ศ.)
 *   ขั้นตอน: DQ.parseFile (xlsx/csv/json — ใช้ตัวอ่านเดียวกับการนำเข้าข้อมูลโคนม) → mapColumns → normalizeRow
 *            → classifyDirectory / classifyFinancials (เทียบกับข้อมูลในระบบที่ route ดึงมา) → แต่ละแถวได้ verdict
 *            new | update | same | error  (+ warnings ที่ไม่ขวางการบันทึก)
 *   นำเข้าไฟล์เดิมซ้ำได้: แถวที่ไม่เปลี่ยนเป็น same · ช่องว่างในไฟล์ไม่ลบค่าที่มีอยู่
 */
const DQ = require('./dairyDataQuality');

const TYPES = {
  agriculture: 'สหกรณ์การเกษตร', fisheries: 'สหกรณ์ประมง', settlement: 'สหกรณ์นิคม', store: 'สหกรณ์ร้านค้า',
  service: 'สหกรณ์บริการ', savings: 'สหกรณ์ออมทรัพย์', credit_union: 'สหกรณ์เครดิตยูเนี่ยน',
};
/** ประเภททะเบียน → ประเภทองค์กรในระบบที่ยืนยันสิทธิ์ได้ */
const ORG_TYPE = {
  agriculture: 'Cooperative', fisheries: 'Cooperative', settlement: 'Cooperative', store: 'Cooperative', service: 'Cooperative',
  savings: 'SavingsCooperative', credit_union: 'CreditUnion',
};
const BORROWER_TYPES = ['agriculture', 'fisheries', 'settlement'];
const LENDER_TYPES = ['savings', 'credit_union'];
const STATUS_TH = { active: 'ดำเนินการ', dissolving: 'อยู่ระหว่างชำระบัญชี', dissolved: 'เลิก/ถอนชื่อแล้ว' };

const FIN_FIELDS = ['total_assets', 'total_liabilities', 'equity', 'share_capital', 'reserve', 'current_assets', 'current_liabilities', 'revenue', 'net_income'];
const FIN_TH = {
  total_assets: 'สินทรัพย์รวม', total_liabilities: 'หนี้สินรวม', equity: 'ทุนของสหกรณ์', share_capital: 'ทุนเรือนหุ้น', reserve: 'ทุนสำรอง',
  current_assets: 'สินทรัพย์หมุนเวียน', current_liabilities: 'หนี้สินหมุนเวียน', revenue: 'รายได้รวม', net_income: 'กำไรสุทธิ',
};

const FIELDS = {
  directory: {
    coop_name: ['coop_name', 'name', 'ชื่อสหกรณ์', 'ชื่อ', 'สหกรณ์', 'ชื่อสหกรณ์/กลุ่มเกษตรกร'],
    registration_no: ['registration_no', 'reg_no', 'เลขทะเบียน', 'เลขทะเบียนสหกรณ์', 'ทะเบียนเลขที่', 'เลขที่ทะเบียน'],
    tax_id: ['tax_id', 'เลขประจำตัวผู้เสียภาษี', 'เลขผู้เสียภาษี', 'เลขประจำตัวผู้เสียภาษีอากร', 'เลขนิติบุคคล', 'เลขทะเบียนนิติบุคคล'],
    coop_type: ['coop_type', 'type', 'ประเภท', 'ประเภทสหกรณ์'],
    province: ['province', 'province_code', 'จังหวัด'],
    district: ['district', 'อำเภอ', 'เขต', 'อำเภอ/เขต'],
    established_year: ['established_year', 'year', 'ปีที่จดทะเบียน', 'ปีจดทะเบียน', 'ปีที่ก่อตั้ง', 'วันที่จดทะเบียน', 'วันจดทะเบียน'],
    member_count: ['member_count', 'members', 'จำนวนสมาชิก', 'สมาชิก', 'สมาชิก (คน)'],
    status: ['status', 'สถานะ', 'สถานะสหกรณ์', 'สถานะการดำเนินงาน'],
  },
  financials: {
    registration_no: ['registration_no', 'reg_no', 'เลขทะเบียน', 'เลขทะเบียนสหกรณ์', 'ทะเบียนเลขที่'],
    tax_id: ['tax_id', 'เลขประจำตัวผู้เสียภาษี', 'เลขผู้เสียภาษี', 'เลขนิติบุคคล'],
    coop_name: ['coop_name', 'name', 'ชื่อสหกรณ์', 'ชื่อ'],
    year: ['year', 'ปี', 'ปีบัญชี', 'ปีงบการเงิน', 'ปีบัญชี (พ.ศ.)'],
    total_assets: ['total_assets', 'สินทรัพย์รวม', 'รวมสินทรัพย์'],
    total_liabilities: ['total_liabilities', 'หนี้สินรวม', 'รวมหนี้สิน'],
    equity: ['equity', 'ทุนของสหกรณ์', 'รวมทุนของสหกรณ์', 'ส่วนของทุน'],
    share_capital: ['share_capital', 'ทุนเรือนหุ้น'],
    reserve: ['reserve', 'ทุนสำรอง'],
    current_assets: ['current_assets', 'สินทรัพย์หมุนเวียน'],
    current_liabilities: ['current_liabilities', 'หนี้สินหมุนเวียน'],
    revenue: ['revenue', 'รายได้', 'รายได้รวม', 'รวมรายได้'],
    net_income: ['net_income', 'กำไรสุทธิ', 'กำไร(ขาดทุน)สุทธิ', 'กำไรขาดทุนสุทธิ', 'กำไร (ขาดทุน) สุทธิ'],
    audit_opinion: ['audit_opinion', 'ความเห็นผู้สอบบัญชี'],
  },
};
const REQUIRED = { directory: ['coop_name', 'province'], financials: ['year'] };

// หัวคอลัมน์: ตัวพิมพ์/ช่องว่าง/หน่วยในวงเล็บ เช่น "สินทรัพย์รวม (บาท)" ไม่มีผล
const normHead = (s) => String(s || '').toLowerCase().replace(/\((บาท|ล้านบาท|คน|baht)\)/g, '').replace(/[\s_]+/g, ' ').trim();
function mapColumns(kind, header) {
  const fields = FIELDS[kind];
  const map = {};
  const used = new Set();
  Object.entries(fields).forEach(([f, aliases]) => {
    const want = aliases.map(normHead);
    const idx = header.findIndex((h, i) => !used.has(i) && want.includes(normHead(h)));
    if (idx >= 0) { map[f] = idx; used.add(idx); }
  });
  const missing = REQUIRED[kind].filter((f) => map[f] === undefined);
  if (kind === 'financials' && map.registration_no === undefined && map.tax_id === undefined) missing.push('registration_no');
  const unknown = header.filter((h, i) => h && !used.has(i));
  return { map, missing, unknown };
}

/** ชื่อสำหรับจับคู่: ตัด "จำกัด" ช่องว่าง เครื่องหมาย */
const nameKey = (s) => String(s || '').toLowerCase().replace(/จำกัด|\(จำกัด\)/g, '').replace(/[\s.,()'"\-–]/g, '');
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const clean = (v) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());

function parseType(v, name) {
  const s = clean(v).toLowerCase().replace(/^สหกรณ์/, '');
  if (TYPES[s]) return s;
  const byText = (t) => {
    if (/เครดิตยูเนี่ยน|credit ?union/.test(t)) return 'credit_union';
    if (/ออมทรัพย์|saving/.test(t)) return 'savings';
    if (/นิคม|settlement/.test(t)) return 'settlement';
    if (/ประมง|fisher/.test(t)) return 'fisheries';
    if (/ร้านค้า|store|consumer/.test(t)) return 'store';
    if (/บริการ|service/.test(t)) return 'service';
    if (/การเกษตร|เกษตร|agri/.test(t)) return 'agriculture';
    return null;
  };
  return (s && byText(s)) || byText(String(name || '')) || null;
}
function parseStatus(v) {
  const s = clean(v).toLowerCase();
  if (!s) return 'active';
  if (/ถอนชื่อ|dissolved|เลิกแล้ว|ยกเลิก/.test(s)) return 'dissolved';
  if (/ชำระบัญชี|เลิก|dissolving|liquidat/.test(s)) return 'dissolving';
  if (/ดำเนิน|ปกติ|active|ใช้งาน/.test(s)) return 'active';
  return null;
}
/** ปี พ.ศ. จากตัวเลข/วันที่/Excel serial — รับ ค.ศ. แล้วแปลงเป็น พ.ศ. */
function parseYearBE(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 864e5).getUTCFullYear() + 543;
  const m = String(v).match(/(\d{4})/);
  if (!m) return NaN;
  const y = Number(m[1]);
  if (y >= 2400 && y <= 2700) return y;
  if (y >= 1857 && y <= 2157) return y + 543;
  return NaN;
}
/** จังหวัด: รหัสในระบบ (เช่น SURIN) หรือชื่อไทย (ตัด "จังหวัด"/"จ.") — provinces = [{province_code, province_name_th}] */
function provinceIndex(provinces) {
  const idx = new Map();
  (provinces || []).forEach((p) => {
    idx.set(p.province_code.toLowerCase(), p.province_code);
    idx.set(p.province_name_th.replace(/\s/g, ''), p.province_code);
  });
  const bkk = (provinces || []).find((p) => p.province_name_th === 'กรุงเทพมหานคร');
  if (bkk) ['กทม', 'กทม.', 'กรุงเทพ', 'กรุงเทพฯ'].forEach((k) => idx.set(k, bkk.province_code));
  return idx;
}
function parseProvince(v, idx) {
  const s = clean(v).replace(/^(จังหวัด|จ\.)\s*/, '').replace(/\s/g, '');
  if (!s) return null;
  return idx.get(s) || idx.get(s.toLowerCase()) || undefined;
}

const issue = (code, field, extra) => ({ code, field: field || null, ...(extra || {}) });

/** แปลงหนึ่งแถว → { data, errors, warnings } — opts: { provinceIdx, default_type } */
function normalizeRow(kind, cells, map, opts = {}) {
  const get = (f) => (map[f] === undefined ? null : cells[map[f]]);
  const errors = []; const warnings = [];
  const data = {};
  const reg = clean(get('registration_no'));
  data.registration_no = reg ? reg.slice(0, 60) : null;
  const taxRaw = clean(get('tax_id'));
  if (taxRaw) {
    const t = digits(taxRaw);
    if (t.length === 13) data.tax_id = t;
    else { data.tax_id = null; warnings.push(issue('invalid_tax_id', 'tax_id', { value: taxRaw })); }
  } else data.tax_id = null;
  const name = clean(get('coop_name'));
  data.coop_name = name || null;

  if (kind === 'directory') {
    if (!name || name.length < 3) errors.push(issue('missing_value', 'coop_name'));
    else if (name.length > 300) errors.push(issue('too_long', 'coop_name'));
    data.name_key = nameKey(name);
    const typ = parseType(get('coop_type'), name) || opts.default_type || null;
    if (!typ) errors.push(issue('unknown_type', 'coop_type', { value: clean(get('coop_type')) }));
    data.coop_type = typ;
    const pv = parseProvince(get('province'), opts.provinceIdx || new Map());
    if (pv === null) errors.push(issue('missing_value', 'province'));
    else if (pv === undefined) errors.push(issue('unknown_province', 'province', { value: clean(get('province')) }));
    data.province_code = pv || null;
    data.district = clean(get('district')).replace(/^(อำเภอ|อ\.|เขต)\s*/, '').slice(0, 120) || null;
    const y = parseYearBE(get('established_year'));
    if (Number.isNaN(y)) { warnings.push(issue('invalid_year', 'established_year', { value: clean(get('established_year')) })); data.established_year = null; }
    else data.established_year = y;
    const mc = DQ.parseNum(get('member_count'));
    if (Number.isNaN(mc) || (mc !== null && mc < 0)) { warnings.push(issue('invalid_number', 'member_count')); data.member_count = null; }
    else data.member_count = mc === null ? null : Math.round(mc);
    const st = parseStatus(get('status'));
    if (!st) { warnings.push(issue('unknown_status', 'status', { value: clean(get('status')) })); data.status = 'active'; }
    else data.status = st;
    if (!data.registration_no && !data.tax_id) warnings.push(issue('no_identifier', 'registration_no'));
  } else {
    const y = parseYearBE(get('year'));
    if (y === null) errors.push(issue('missing_value', 'year'));
    else if (Number.isNaN(y)) errors.push(issue('invalid_year', 'year', { value: clean(get('year')) }));
    data.year = Number.isNaN(y) ? null : y;
    if (!data.registration_no && !data.tax_id) errors.push(issue('no_identifier', 'registration_no'));
    let any = false;
    FIN_FIELDS.forEach((f) => {
      const n = DQ.parseNum(get(f));
      if (Number.isNaN(n)) { errors.push(issue('invalid_number', f, { value: clean(get(f)) })); data[f] = null; }
      else { data[f] = n; if (n !== null) any = true; }
    });
    if (!any) errors.push(issue('no_figures', null));
    data.audit_opinion = clean(get('audit_opinion')).slice(0, 120) || null;
    const a = data.total_assets; const li = data.total_liabilities; const eq = data.equity;
    if (a !== null && li !== null && eq !== null && Math.abs(a - li - eq) > Math.max(1, Math.abs(a) * 0.01)) {
      warnings.push(issue('balance_mismatch', 'equity', { expected: Math.round((a - li) * 100) / 100 }));
    }
  }
  return { data, errors, warnings };
}

const DIR_FIELDS = ['coop_name', 'coop_type', 'registration_no', 'tax_id', 'province_code', 'district', 'established_year', 'member_count', 'status'];
/**
 * rows: [{row_no, data, errors, warnings}] · existing: [coop_directory ...]
 * จับคู่ตามลำดับ: เลขทะเบียน → เลขผู้เสียภาษี → ชื่อ+จังหวัด · ค่าว่างในไฟล์ไม่ลบค่าเดิม
 */
function classifyDirectory(rows, existing) {
  const byReg = new Map(); const byTax = new Map(); const byName = new Map();
  (existing || []).forEach((e) => {
    if (e.registration_no) byReg.set(e.registration_no, e);
    if (e.tax_id) byTax.set(e.tax_id, e);
    byName.set(`${e.name_key}|${e.province_code}`, e);
  });
  const seen = new Map();
  return rows.map((r) => {
    const out = { ...r, errors: [...r.errors], warnings: [...r.warnings], changes: [] };
    if (out.errors.length) return { ...out, verdict: 'error' };
    const d = r.data;
    const fileKey = d.registration_no ? `r:${d.registration_no}` : d.tax_id ? `t:${d.tax_id}` : `n:${d.name_key}|${d.province_code}`;
    if (seen.has(fileKey)) { out.errors.push(issue('duplicate_in_file', null, { first_row: seen.get(fileKey) })); return { ...out, verdict: 'error' }; }
    seen.set(fileKey, r.row_no);
    const a = d.registration_no ? byReg.get(d.registration_no) : null;
    const b = d.tax_id ? byTax.get(d.tax_id) : null;
    if (a && b && a.directory_id !== b.directory_id) {
      out.errors.push(issue('identifier_conflict', 'tax_id', { registration_owner: a.coop_name, tax_owner: b.coop_name }));
      return { ...out, verdict: 'error' };
    }
    let match = a || b;
    if (!match && !d.registration_no && !d.tax_id) match = byName.get(`${d.name_key}|${d.province_code}`) || null;
    if (!match) {
      const sameName = byName.get(`${d.name_key}|${d.province_code}`);
      if (sameName) out.warnings.push(issue('similar_name_exists', 'coop_name', { existing: sameName.coop_name, registration_no: sameName.registration_no }));
      return { ...out, verdict: 'new' };
    }
    // เลขทะเบียนในไฟล์ต่างจากที่มีอยู่ (จับคู่ด้วยเลขผู้เสียภาษี) → แจ้ง ไม่เขียนทับ
    if (match.registration_no && d.registration_no && match.registration_no !== d.registration_no) {
      out.errors.push(issue('identifier_conflict', 'registration_no', { existing: match.registration_no }));
      return { ...out, verdict: 'error' };
    }
    DIR_FIELDS.forEach((f) => {
      if (d[f] === null || d[f] === undefined) return;
      if (String(match[f] ?? '') !== String(d[f])) out.changes.push({ field: f, from: match[f] ?? null, to: d[f] });
    });
    return { ...out, directory_id: match.directory_id, linked: Boolean(match.org_id), verdict: out.changes.length ? 'update' : 'same' };
  });
}

/** existingDir: [{directory_id, registration_no, tax_id, coop_name}] · existingFin: [{directory_id, year, ...}] */
function classifyFinancials(rows, existingDir, existingFin) {
  const byReg = new Map(); const byTax = new Map();
  (existingDir || []).forEach((e) => { if (e.registration_no) byReg.set(e.registration_no, e); if (e.tax_id) byTax.set(e.tax_id, e); });
  const fin = new Map((existingFin || []).map((x) => [`${x.directory_id}|${x.year}`, x]));
  const seen = new Map();
  return rows.map((r) => {
    const out = { ...r, errors: [...r.errors], warnings: [...r.warnings], changes: [] };
    if (out.errors.length) return { ...out, verdict: 'error' };
    const d = r.data;
    const e = (d.registration_no && byReg.get(d.registration_no)) || (d.tax_id && byTax.get(d.tax_id)) || null;
    if (!e) { out.errors.push(issue('not_in_directory', 'registration_no', { value: d.registration_no || d.tax_id })); return { ...out, verdict: 'error' }; }
    const key = `${e.directory_id}|${d.year}`;
    if (seen.has(key)) { out.errors.push(issue('duplicate_in_file', null, { first_row: seen.get(key) })); return { ...out, verdict: 'error' }; }
    seen.set(key, r.row_no);
    if (d.coop_name && nameKey(d.coop_name) !== nameKey(e.coop_name)) out.warnings.push(issue('name_differs', 'coop_name', { directory: e.coop_name }));
    const prev = fin.get(key);
    const base = { ...out, directory_id: e.directory_id, coop_name_directory: e.coop_name };
    if (!prev) return { ...base, verdict: 'new' };
    [...FIN_FIELDS, 'audit_opinion'].forEach((f) => {
      if (d[f] === null || d[f] === undefined) return;
      const pv = prev[f] === null || prev[f] === undefined ? null : (f === 'audit_opinion' ? prev[f] : Number(prev[f]));
      if (pv === null || (f === 'audit_opinion' ? pv !== d[f] : Math.abs(pv - d[f]) > 0.004)) base.changes.push({ field: f, from: pv, to: d[f] });
    });
    return { ...base, verdict: base.changes.length ? 'update' : 'same' };
  });
}

function summarize(rows) {
  const c = (v) => rows.filter((r) => r.verdict === v).length;
  return { row_count: rows.length, new_count: c('new'), update_count: c('update'), same_count: c('same'), error_count: c('error'), warning_count: rows.filter((r) => r.warnings.length).length };
}

/** งบที่ผู้กู้กรอก เทียบงบจากแหล่งทางการ — คืนรายการที่ต่างเกิน pct% (ไม่นับช่องที่ฝั่งใดฝั่งหนึ่งว่าง) */
function compareOfficial(declared, official, pct = 5) {
  const off = new Map((official || []).map((o) => [Number(o.year), o]));
  const out = [];
  (declared || []).forEach((y) => {
    const o = off.get(Number(y.year));
    if (!o) return;
    FIN_FIELDS.forEach((f) => {
      const a = y[f]; const b = o[f];
      if (a === null || a === undefined || a === '' || b === null || b === undefined) return;
      const dv = Number(a); const ov = Number(b);
      if (!Number.isFinite(dv) || !Number.isFinite(ov)) return;
      const diff = ov === 0 ? (Math.abs(dv) > 1 ? 100 : 0) : (Math.abs(dv - ov) / Math.abs(ov)) * 100;
      if (diff > pct && Math.abs(dv - ov) > 1) out.push({ year: Number(y.year), field: f, label: FIN_TH[f], declared: dv, official: ov, diff_pct: Math.round(diff * 10) / 10 });
    });
  });
  return out;
}

/** แบบฟอร์ม CSV (UTF-8 BOM) ให้ผู้ดูแลกรอก/วางข้อมูล */
function template(kind) {
  const rows = kind === 'financials'
    ? [['เลขทะเบียน', 'เลขประจำตัวผู้เสียภาษี', 'ชื่อสหกรณ์', 'ปีบัญชี', 'สินทรัพย์รวม', 'หนี้สินรวม', 'ทุนของสหกรณ์', 'ทุนเรือนหุ้น', 'ทุนสำรอง', 'สินทรัพย์หมุนเวียน', 'หนี้สินหมุนเวียน', 'รายได้รวม', 'กำไรสุทธิ', 'ความเห็นผู้สอบบัญชี'],
      ['สร 123/2520', '0994000123456', 'สหกรณ์การเกษตรตัวอย่าง จำกัด', '2567', '80000000', '40000000', '40000000', '25000000', '8000000', '25000000', '15000000', '60000000', '2000000', 'ไม่มีเงื่อนไข']]
    : [['ชื่อสหกรณ์', 'เลขทะเบียน', 'เลขประจำตัวผู้เสียภาษี', 'ประเภท', 'จังหวัด', 'อำเภอ', 'ปีที่จดทะเบียน', 'จำนวนสมาชิก', 'สถานะ'],
      ['สหกรณ์การเกษตรตัวอย่าง จำกัด', 'สร 123/2520', '0994000123456', 'การเกษตร', 'สุรินทร์', 'เมืองสุรินทร์', '2520', '820', 'ดำเนินการ'],
      ['สหกรณ์ออมทรัพย์ครูตัวอย่าง จำกัด', 'สร 45/2510', '0994000654321', 'ออมทรัพย์', 'สุรินทร์', 'เมืองสุรินทร์', '2510', '3200', 'ดำเนินการ']];
  const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `﻿${rows.map((r) => r.map(cell).join(',')).join('\n')}\n`;
}

module.exports = {
  TYPES, ORG_TYPE, BORROWER_TYPES, LENDER_TYPES, STATUS_TH, FIN_FIELDS, FIN_TH, FIELDS,
  mapColumns, nameKey, digits, parseType, parseStatus, parseYearBE, provinceIndex, parseProvince, normalizeRow,
  classifyDirectory, classifyFinancials, summarize, compareOfficial, template, DIR_FIELDS,
};
