const zlib = require('zlib');

/**
 * นำเข้าข้อมูลน้ำนมจากไฟล์ + กฎคุณภาพข้อมูลกลาง (pure — ไม่แตะฐานข้อมูล ทดสอบได้ตรง ๆ)
 *
 * ขั้นตอน: parseFile (xlsx/csv/json → ตาราง) → mapColumns (หัวคอลัมน์ไทย/อังกฤษ → ฟิลด์)
 * → normalizeRow (แปลงวันที่ พ.ศ./ค.ศ./Excel, รอบ, ตัวเลข, หน่วย) → validateRows (ตรวจกับข้อมูลในระบบ
 * ที่ route เตรียมไว้ใน ctx) → แต่ละแถวได้ verdict: ok | warning | duplicate | error
 *
 * - error      ไม่บันทึก (ต้องแก้ไฟล์แล้วนำเข้าใหม่)
 * - duplicate  มีข้อมูลเดียวกันในระบบแล้ว ข้าม (นำเข้าไฟล์เดิมซ้ำได้โดยไม่เกิดข้อมูลซ้ำ)
 * - warning    บันทึกได้ แต่ให้ผู้ใช้ดูก่อน (เช่น น้ำหนักต่างจากปกติมาก ค่าคุณภาพต่ำกว่ามาตรฐาน)
 */

const MAX_ROWS = 5000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_INTAKE_KG = 5000;

// ---------------------------------------------------------------------------
// อ่านไฟล์
// ---------------------------------------------------------------------------
class FileError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}

/** อ่าน zip (ไฟล์ .xlsx) ด้วย zlib ของ Node — ไม่ต้องพึ่ง library ภายนอก */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new FileError('invalid_xlsx');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new FileError('invalid_xlsx');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    if (!/^xl\/(sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/.test(name)) continue;
    if (usize > 40 * 1024 * 1024) throw new FileError('file_too_large');
    const lnlen = buf.readUInt16LE(off + 26);
    const lelen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    if (method === 0) files[name] = data;
    else if (method === 8) files[name] = zlib.inflateRawSync(data, { maxOutputLength: 40 * 1024 * 1024 });
    else throw new FileError('invalid_xlsx');
  }
  return files;
}

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return XML_ENT[e.toLowerCase()];
});
const textOf = (xml) => unxml((xml.match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g) || []).map((t) => t.replace(/^<t(?:\s[^>]*)?>|<\/t>$/g, '')).join(''));
const colIndex = (ref) => { let n = 0; for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

/** แผ่นงานแรกของ .xlsx → ตาราง (array ของ array) ค่าตัวเลขเป็น number วันที่แบบ Excel ยังเป็นเลข serial */
function parseXlsx(buf) {
  const f = readZip(buf);
  let sheet = 'xl/worksheets/sheet1.xml';
  const wb = f['xl/workbook.xml'] && f['xl/workbook.xml'].toString('utf8');
  const rels = f['xl/_rels/workbook.xml.rels'] && f['xl/_rels/workbook.xml.rels'].toString('utf8');
  if (wb && rels) {
    const first = wb.match(/<sheet\b[^>]*\br:id="([^"]+)"/) || wb.match(/<sheet\b[^>]*\bid="([^"]+)"/);
    if (first) {
      const rel = rels.match(new RegExp(`<Relationship\\b[^>]*\\bId="${first[1]}"[^>]*>`));
      const target = rel && rel[0].match(/Target="([^"]+)"/);
      if (target) sheet = `xl/${target[1].replace(/^\/?xl\//, '').replace(/^\//, '')}`;
    }
  }
  if (!f[sheet]) sheet = Object.keys(f).filter((k) => k.startsWith('xl/worksheets/')).sort()[0];
  if (!sheet || !f[sheet]) throw new FileError('invalid_xlsx');
  const shared = [];
  if (f['xl/sharedStrings.xml']) {
    const ss = f['xl/sharedStrings.xml'].toString('utf8');
    (ss.match(/<si>[\s\S]*?<\/si>|<si\/>/g) || []).forEach((si) => shared.push(textOf(si)));
  }
  const xml = f[sheet].toString('utf8');
  const rows = [];
  (xml.match(/<row\b[^>]*>[\s\S]*?<\/row>|<row\b[^>]*\/>/g) || []).forEach((rx) => {
    const rn = rx.match(/^<row\b[^>]*\br="(\d+)"/);
    const ri = rn ? Number(rn[1]) - 1 : rows.length;
    const row = [];
    (rx.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || []).forEach((cx) => {
      const attrs = cx.match(/^<c\b([^>]*)>/)[1];
      const ref = attrs.match(/\br="([A-Z]+)\d+"/);
      const t = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      const ci = ref ? colIndex(ref[1]) : row.length;
      const v = (cx.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = null;
      if (t === 's') val = v !== undefined ? shared[Number(v)] : null;
      else if (t === 'inlineStr') val = textOf(cx);
      else if (t === 'str' || t === 'e') val = v !== undefined ? unxml(v) : null;
      else if (t === 'b') val = v === '1';
      else if (v !== undefined) val = Number(v);
      row[ci] = val;
    });
    rows[ri] = row;
  });
  return Array.from(rows, (r) => Array.from(r || [], (x) => (x === undefined ? null : x)));
}

/** CSV / TSV: ตัด BOM เดาเครื่องหมายคั่น (, ; tab) รองรับ "ค่าในเครื่องหมายคำพูด" และขึ้นบรรทัดใหม่ในเซลล์ */
function parseCsv(text) {
  const s = text.replace(/^\uFEFF/, '');
  const head = s.split(/\r?\n/, 1)[0] || '';
  const counts = [',', ';', '\t'].map((d) => [d, head.split(d).length]);
  const delim = counts.sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i += 1; } else q = false; } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function parseFile(filename, buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new FileError('empty_file');
  if (buf.length > MAX_BYTES) throw new FileError('file_too_large', { max_mb: MAX_BYTES / 1024 / 1024 });
  const name = String(filename || '').toLowerCase();
  let format;
  let table;
  if (buf[0] === 0x50 && buf[1] === 0x4b) { format = 'xlsx'; table = parseXlsx(buf); }
  else if (name.endsWith('.xls')) throw new FileError('xls_not_supported');
  else {
    // Excel ภาษาไทยรุ่นเก่าบันทึก CSV เป็น TIS-620 (windows-874) — อ่านได้ทั้งสองแบบ
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-874').decode(buf); }
    const trimmed = text.replace(/^\uFEFF/, '').trim();
    if (name.endsWith('.json') || trimmed.startsWith('[') || trimmed.startsWith('{')) {
      format = 'json';
      let data;
      try { data = JSON.parse(trimmed); } catch { throw new FileError('invalid_json'); }
      if (!Array.isArray(data)) data = data && Array.isArray(data.rows) ? data.rows : null;
      if (!data || data.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw new FileError('invalid_json');
      const heads = [...new Set(data.flatMap((r) => Object.keys(r)))];
      table = [heads, ...data.map((r) => heads.map((k) => (r[k] === undefined ? null : r[k])))];
    } else {
      format = 'csv';
      table = parseCsv(text);
    }
  }
  // ตัดแถวว่างท้ายตาราง/แถวว่างทั้งแถว แต่จำเลขแถวเดิมไว้ให้ผู้ใช้หาในไฟล์ได้
  const blank = (r) => !r || r.every((v) => v === null || v === undefined || String(v).trim() === '');
  const headerIdx = table.findIndex((r) => !blank(r));
  if (headerIdx < 0) throw new FileError('empty_file');
  const header = table[headerIdx].map((v) => (v === null || v === undefined ? '' : String(v).trim()));
  const rows = [];
  for (let i = headerIdx + 1; i < table.length; i += 1) {
    if (!blank(table[i])) rows.push({ row_no: i + 1, cells: table[i] });
  }
  if (!rows.length) throw new FileError('no_data_rows');
  if (rows.length > MAX_ROWS) throw new FileError('too_many_rows', { max: MAX_ROWS });
  return { format, header, rows };
}

// ---------------------------------------------------------------------------
// หัวคอลัมน์
// ---------------------------------------------------------------------------
const FIELDS = {
  intake: {
    member_code: ['member_code', 'รหัสสมาชิก', 'รหัส', 'เลขสมาชิก', 'member', 'member id', 'code'],
    round_date: ['round_date', 'date', 'วันที่', 'วันที่รับนม', 'วันรับนม'],
    shift: ['shift', 'รอบ', 'รอบรับนม', 'เช้า/เย็น', 'ช่วง'],
    center: ['center', 'center_name', 'ศูนย์', 'ศูนย์รับนม', 'ศูนย์รวบรวมน้ำนม', 'จุดรับนม'],
    weight_kg: ['weight_kg', 'weight', 'kg', 'น้ำหนัก', 'น้ำหนัก (กก.)', 'น้ำหนักกก', 'กก.', 'กิโลกรัม', 'ปริมาณ', 'ปริมาณนม'],
    status: ['status', 'สถานะ', 'ผล', 'ผลการรับ', 'รับ/ไม่รับ'],
    reject_reason: ['reject_reason', 'reason', 'เหตุผล', 'สาเหตุ', 'สาเหตุที่ไม่รับ'],
    sample_no: ['sample_no', 'sample', 'เลขตัวอย่าง', 'เลขที่ตัวอย่าง'],
  },
  quality: {
    member_code: ['member_code', 'รหัสสมาชิก', 'รหัส', 'เลขสมาชิก', 'member', 'member id', 'code'],
    sample_date: ['sample_date', 'date', 'วันที่', 'วันที่เก็บตัวอย่าง', 'วันเก็บตัวอย่าง', 'วันที่ตรวจ'],
    fat_pct: ['fat_pct', 'fat', 'fat %', 'fat(%)', 'ไขมัน', 'ไขมัน %', 'ไขมัน (%)'],
    snf_pct: ['snf_pct', 'snf', 'snf %', 'snf(%)', 'ของแข็งไม่รวมไขมัน', 'เนื้อนมไม่รวมไขมัน'],
    protein_pct: ['protein_pct', 'protein', 'โปรตีน', 'โปรตีน %', 'โปรตีน (%)'],
    scc_k: ['scc_k', 'scc', 'scc (k)', 'scc (พันเซลล์/มล.)', 'โซมาติกเซลล์', 'โซมาติก'],
    tbc_k: ['tbc_k', 'tbc', 'tbc (k)', 'แบคทีเรีย', 'แบคทีเรียรวม'],
    antibiotic_pos: ['antibiotic_pos', 'antibiotic', 'ยาปฏิชีวนะ', 'สารตกค้าง', 'ยาตกค้าง'],
    lab_name: ['lab_name', 'lab', 'ห้องปฏิบัติการ', 'ห้องแล็บ', 'แล็บ'],
  },
};
const REQUIRED = { intake: ['member_code', 'weight_kg'], quality: ['member_code'] };
const normHead = (s) => String(s || '').toLowerCase().replace(/[\s_]+/g, ' ').trim();

function mapColumns(kind, header) {
  const spec = FIELDS[kind];
  const map = {};
  const used = new Set();
  Object.entries(spec).forEach(([field, aliases]) => {
    const al = aliases.map(normHead);
    const idx = header.findIndex((h, i) => !used.has(i) && al.includes(normHead(h)));
    if (idx >= 0) { map[field] = idx; used.add(idx); }
  });
  // หัวที่มีคำหลักอยู่ข้างใน เช่น "น้ำหนักนม (กก.)" "ไขมัน%"
  Object.entries(spec).forEach(([field, aliases]) => {
    if (field in map) return;
    const al = aliases.map(normHead).filter((a) => a.length >= 3);
    const idx = header.findIndex((h, i) => !used.has(i) && al.some((a) => normHead(h).includes(a)));
    if (idx >= 0) { map[field] = idx; used.add(idx); }
  });
  const missing = REQUIRED[kind].filter((f) => !(f in map));
  const unknown = header.map((h, i) => (used.has(i) || !h ? null : h)).filter(Boolean);
  return { map, missing, unknown };
}

// ---------------------------------------------------------------------------
// แปลงค่า
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const validYmd = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** วันที่: 2026-11-26, 26/11/2569 (พ.ศ.), 26/11/2026, 26/11/69, 26 พ.ย. 69, เลข serial ของ Excel. คืน {date, era} หรือ null */
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return { date: v.toISOString().slice(0, 10), era: 'iso' };
  if (typeof v === 'number' || /^\d{5}(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    if (n < 20000 || n > 80000) return null;
    return { date: new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10), era: 'excel' };
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (m) {
    let y = Number(m[1]); let era = 'ce';
    if (y > 2400) { y -= 543; era = 'be'; }
    const d = validYmd(y, Number(m[2]), Number(m[3]));
    return d ? { date: d, era } : null;
  }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s.*)?$/);
  let day; let mon; let yr;
  if (m) { [day, mon, yr] = [Number(m[1]), Number(m[2]), m[3]]; } else {
    m = s.match(/^(\d{1,2})\s*([ก-๙.]+)\s*(\d{2}|\d{4})$/);
    if (!m) return null;
    const mi = TH_MONTHS.findIndex((x) => x.replace(/\./g, '') === m[2].replace(/\./g, ''));
    if (mi < 0) return null;
    [day, mon, yr] = [Number(m[1]), mi + 1, m[3]];
  }
  let y = Number(yr); let era;
  if (yr.length === 2) { if (y >= 40) { y = 2500 + y - 543; era = 'be'; } else { y += 2000; era = 'ce'; } }
  else if (y > 2400) { y -= 543; era = 'be'; } else era = 'ce';
  const d = validYmd(y, mon, day);
  return d ? { date: d, era } : null;
}

function parseNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const s = String(v).replace(/[,\s]/g, '').replace(/(กก\.?|kg|%)$/i, '');
  if (s === '' || s === '-') return null;
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

function parseShift(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (['am', 'เช้า', 'ช', 'ช.', 'morning', '1', 'รอบเช้า'].includes(s)) return 'AM';
  if (['pm', 'เย็น', 'บ่าย', 'ย', 'ย.', 'บ', 'evening', 'afternoon', '2', 'รอบเย็น'].includes(s)) return 'PM';
  return undefined;
}
function parseStatus(v) {
  if (v === null || v === undefined || v === '') return 'Accepted';
  const s = String(v).trim().toLowerCase();
  if (['accepted', 'accept', 'รับ', 'ผ่าน', 'ok', 'y', 'yes'].includes(s)) return 'Accepted';
  if (['rejected', 'reject', 'ไม่รับ', 'ปฏิเสธ', 'ไม่ผ่าน', 'คืน', 'n', 'no'].includes(s)) return 'Rejected';
  return undefined;
}
const REASONS = {
  antibiotic: ['antibiotic', 'ยาปฏิชีวนะ', 'ยา', 'สารตกค้าง', 'ยาตกค้าง'],
  temperature: ['temperature', 'อุณหภูมิ', 'ร้อน', 'อุณหภูมิสูง'],
  smell: ['smell', 'กลิ่น', 'มีกลิ่น', 'กลิ่นผิดปกติ'],
  clot: ['clot', 'จับตัว', 'จับตัวเป็นก้อน', 'เป็นก้อน', 'ตกตะกอน'],
  other: ['other', 'อื่น', 'อื่นๆ', 'อื่น ๆ'],
};
function parseReason(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().toLowerCase();
  const hit = Object.entries(REASONS).find(([, al]) => al.includes(s));
  return hit ? hit[0] : 'other';
}
function parseBool(v) {
  if (v === null || v === undefined || v === '') return false;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'positive', 'pos', '+', 'บวก', 'พบ', 'มี', 'ผลบวก'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'negative', 'neg', '-', 'ลบ', 'ไม่พบ', 'ไม่มี', 'ผลลบ'].includes(s)) return false;
  return undefined;
}

const issue = (code, field, extra) => ({ code, field: field || null, ...(extra || {}) });

/** แถวดิบ → ค่าที่แปลงแล้ว + ปัญหาที่ตรวจได้โดยไม่ต้องดูฐานข้อมูล */
function normalizeRow(kind, cells, map, opts = {}) {
  const raw = (f) => (f in map ? cells[map[f]] : null);
  const v = {};
  const errors = [];
  const warnings = [];
  const today = opts.today;
  v.member_code = raw('member_code') === null || raw('member_code') === undefined ? null : String(raw('member_code')).trim() || null;
  if (!v.member_code) errors.push(issue('missing_member_code', 'member_code'));
  const dateField = kind === 'intake' ? 'round_date' : 'sample_date';
  const d = parseDate(raw(dateField));
  if (d) {
    v[dateField] = d.date;
    if (today && d.date > today) errors.push(issue('future_date', dateField, { value: d.date }));
    if (d.era === 'be') v.date_era = 'be';
  } else if (raw(dateField) !== null && raw(dateField) !== undefined && String(raw(dateField)).trim() !== '') {
    errors.push(issue('invalid_date', dateField, { value: String(raw(dateField)) }));
  } else if (opts.default_date) {
    v[dateField] = opts.default_date;
    warnings.push(issue('date_defaulted', dateField, { value: opts.default_date }));
  } else errors.push(issue('missing_date', dateField));

  if (kind === 'intake') {
    const sh = parseShift(raw('shift'));
    if (sh === undefined) errors.push(issue('invalid_shift', 'shift', { value: String(raw('shift')) }));
    else if (sh) v.shift = sh;
    else if (opts.default_shift === 'AM' || opts.default_shift === 'PM') { v.shift = opts.default_shift; warnings.push(issue('shift_defaulted', 'shift', { value: opts.default_shift })); }
    else errors.push(issue('missing_shift', 'shift'));
    const c = raw('center');
    v.center = c === null || c === undefined ? null : String(c).trim() || null;
    const kg = parseNum(raw('weight_kg'));
    if (kg === null) errors.push(issue('missing_weight', 'weight_kg'));
    else if (Number.isNaN(kg)) errors.push(issue('invalid_number', 'weight_kg', { value: String(raw('weight_kg')) }));
    else if (kg <= 0) errors.push(issue('weight_not_positive', 'weight_kg', { value: kg }));
    else if (kg > MAX_INTAKE_KG) errors.push(issue('weight_too_high', 'weight_kg', { value: kg, max: MAX_INTAKE_KG }));
    else v.weight_kg = Math.round(kg * 100) / 100;
    const st = parseStatus(raw('status'));
    if (st === undefined) errors.push(issue('invalid_status', 'status', { value: String(raw('status')) }));
    else v.status = st;
    const rs = parseReason(raw('reject_reason'));
    if (v.status === 'Rejected') {
      if (!rs) errors.push(issue('missing_reject_reason', 'reject_reason'));
      else v.reject_reason = rs;
    } else if (rs && st === 'Accepted' && raw('status') === null) {
      // มีเหตุผลแต่ไม่ได้ระบุสถานะ → ถือว่าไม่รับ
      v.status = 'Rejected'; v.reject_reason = rs;
      warnings.push(issue('status_inferred_rejected', 'status'));
    }
    const sn = raw('sample_no');
    v.sample_no = sn === null || sn === undefined ? null : String(sn).trim() || null;
  } else {
    const LIMITS = { fat_pct: [0, 15], snf_pct: [0, 20], protein_pct: [0, 10], scc_k: [0, 10000], tbc_k: [0, 100000] };
    Object.entries(LIMITS).forEach(([f, [lo, hi]]) => {
      let n = parseNum(raw(f));
      if (n === null) { v[f] = null; return; }
      if (Number.isNaN(n)) { errors.push(issue('invalid_number', f, { value: String(raw(f)) })); return; }
      // SCC/TBC เป็นเซลล์ต่อมล. (เช่น 350000) → แปลงเป็นพัน
      if ((f === 'scc_k' || f === 'tbc_k') && n > hi && n / 1000 <= hi) { n /= 1000; warnings.push(issue('unit_converted', f, { value: n })); }
      if (n < lo || n > hi) { errors.push(issue('out_of_range', f, { value: n, min: lo, max: hi })); return; }
      v[f] = Math.round(n * 100) / 100;
    });
    if (['fat_pct', 'snf_pct', 'scc_k', 'tbc_k'].every((f) => v[f] === null || v[f] === undefined) && !errors.some((e) => e.code === 'invalid_number' || e.code === 'out_of_range')) {
      errors.push(issue('empty_test'));
    }
    const ab = parseBool(raw('antibiotic_pos'));
    if (ab === undefined) errors.push(issue('invalid_boolean', 'antibiotic_pos', { value: String(raw('antibiotic_pos')) }));
    else v.antibiotic_pos = ab;
    const lab = raw('lab_name');
    v.lab_name = lab === null || lab === undefined ? (opts.lab_name || null) : String(lab).trim() || null;
    // ต่ำกว่าเกณฑ์ทั่วไปของน้ำนมดิบ → แจ้งเตือน (ยังบันทึกได้ ระบบคิดราคาตามตารางคุณภาพของสหกรณ์)
    if (v.fat_pct !== null && v.fat_pct !== undefined && v.fat_pct < 3.2) warnings.push(issue('fat_below_standard', 'fat_pct', { value: v.fat_pct }));
    if (v.snf_pct !== null && v.snf_pct !== undefined && v.snf_pct < 8.25) warnings.push(issue('snf_below_standard', 'snf_pct', { value: v.snf_pct }));
    if (v.scc_k !== null && v.scc_k !== undefined && v.scc_k > 500) warnings.push(issue('scc_high', 'scc_k', { value: v.scc_k }));
    if (v.antibiotic_pos) warnings.push(issue('antibiotic_positive', 'antibiotic_pos'));
  }
  return { values: v, errors, warnings };
}

// ---------------------------------------------------------------------------
// ตรวจกับข้อมูลในระบบ
// ---------------------------------------------------------------------------
/**
 * ctx (route เตรียมให้):
 *  members: Map(code → {member_id, status, center_id, full_name, avg_kg})
 *  centers: [{center_id, name}]
 *  rounds: Map(`${center_id}|${date}|${shift}` → {round_id, status})
 *  intakes: Map(`${member_id}|${center_id}|${date}|${shift}` → {weight_kg, status, reject_reason})
 *  otherCenterIntakes: Map(`${member_id}|${date}|${shift}` → center_name)
 *  withdrawal: Map(member_id → [{ear_tag, until}])
 *  tests: Map(`${member_id}|${date}` → [{fat_pct, snf_pct, ...}])
 *  settled: [{start, end}]   งวดจ่ายเงินที่ปิดไปแล้ว
 *  defaultCenterId          ใช้เมื่อไม่มีคอลัมน์ศูนย์และสมาชิกไม่ได้ผูกศูนย์
 */
function validateRows(kind, rows, ctx) {
  const seen = new Map();
  const centerBy = (name) => {
    const s = String(name).trim().toLowerCase();
    return ctx.centers.find((c) => c.name.trim().toLowerCase() === s || c.center_id === name || c.center_id.slice(0, 8) === s);
  };
  const inSettled = (d) => (ctx.settled || []).some((p) => d >= p.start && d <= p.end);
  return rows.map((r) => {
    const out = { row_no: r.row_no, values: { ...r.values }, errors: [...r.errors], warnings: [...r.warnings] };
    const v = out.values;
    const m = v.member_code ? ctx.members.get(v.member_code) : null;
    if (v.member_code && !m) out.errors.push(issue('member_not_found', 'member_code', { value: v.member_code }));
    else if (m && m.status !== 'Approved') out.errors.push(issue('member_not_approved', 'member_code', { status: m.status }));
    if (m) { v.member_id = m.member_id; v.full_name = m.full_name; }
    if (kind === 'intake') {
      let center = null;
      if (v.center) {
        center = centerBy(v.center);
        if (!center) out.errors.push(issue('center_not_found', 'center', { value: v.center }));
        else if (m && m.center_id && m.center_id !== center.center_id) out.warnings.push(issue('center_differs_from_member', 'center'));
      } else if (m && m.center_id) center = ctx.centers.find((c) => c.center_id === m.center_id);
      else if (ctx.defaultCenterId) { center = ctx.centers.find((c) => c.center_id === ctx.defaultCenterId); if (center) out.warnings.push(issue('center_defaulted', 'center')); }
      if (!center && m && !v.center) out.errors.push(issue('missing_center', 'center'));
      if (center) { v.center_id = center.center_id; v.center_name = center.name; }
      if (v.round_date && inSettled(v.round_date)) out.errors.push(issue('period_settled', 'round_date', { value: v.round_date }));
      if (m && center && v.round_date && v.shift) {
        const key = `${m.member_id}|${v.round_date}|${v.shift}`;
        if (seen.has(key)) out.errors.push(issue('duplicate_in_file', null, { first_row: seen.get(key) }));
        else seen.set(key, r.row_no);
        const rd = ctx.rounds.get(`${center.center_id}|${v.round_date}|${v.shift}`);
        const ex = ctx.intakes.get(`${m.member_id}|${center.center_id}|${v.round_date}|${v.shift}`);
        const same = ex && Number(ex.weight_kg) === Number(v.weight_kg) && ex.status === v.status && (ex.reject_reason || null) === (v.reject_reason || null);
        if (same) out.duplicate = true;
        else if (rd && rd.status !== 'Open') out.errors.push(issue('round_closed', null, { existing_kg: ex ? Number(ex.weight_kg) : null }));
        else if (ex) out.warnings.push(issue('will_replace', 'weight_kg', { existing_kg: Number(ex.weight_kg), existing_status: ex.status }));
        const other = ctx.otherCenterIntakes && ctx.otherCenterIntakes.get(key);
        if (other && other.center_id !== center.center_id) out.warnings.push(issue('also_delivered_other_center', 'center', { center: other.center_name }));
        if (v.status === 'Accepted' && v.weight_kg && m.avg_kg > 0) {
          const ratio = v.weight_kg / m.avg_kg;
          if (ratio > 3 || ratio < 0.2) out.warnings.push(issue('weight_outlier', 'weight_kg', { value: v.weight_kg, avg_kg: Math.round(m.avg_kg * 10) / 10 }));
        }
        if (v.status === 'Accepted') {
          const w = (ctx.withdrawal.get(m.member_id) || []).filter((a) => a.until >= v.round_date);
          if (w.length) { out.warnings.push(issue('withdrawal_animals', null, { ear_tags: w.map((a) => a.ear_tag) })); out.withdrawal = true; }
        }
      }
    } else if (m && v.sample_date) {
      const key = `${m.member_id}|${v.sample_date}`;
      if (seen.has(key)) out.errors.push(issue('duplicate_in_file', null, { first_row: seen.get(key) }));
      else seen.set(key, r.row_no);
      const ex = ctx.tests.get(key) || [];
      const F = ['fat_pct', 'snf_pct', 'protein_pct', 'scc_k', 'tbc_k'];
      const eq = (a, b) => (a === null || a === undefined ? null : Number(a)) === (b === null || b === undefined ? null : Number(b));
      if (ex.some((t) => F.every((f) => eq(t[f], v[f])) && !!t.antibiotic_pos === !!v.antibiotic_pos)) out.duplicate = true;
      else if (ex.length) out.warnings.push(issue('test_exists_same_date', null, { existing: ex.length }));
    }
    out.verdict = out.errors.length ? 'error' : out.duplicate ? 'duplicate' : out.warnings.length ? 'warning' : 'ok';
    return out;
  });
}

function summarize(rows) {
  const n = (k) => rows.filter((r) => r.verdict === k).length;
  const issues = {};
  rows.forEach((r) => [...r.errors, ...r.warnings].forEach((i) => { issues[i.code] = (issues[i.code] || 0) + 1; }));
  return { row_count: rows.length, ok_count: n('ok'), warning_count: n('warning'), error_count: n('error'), duplicate_count: n('duplicate'), issues };
}

// ---------------------------------------------------------------------------
// แบบฟอร์มตัวอย่าง (CSV UTF-8 มี BOM ให้ Excel เปิดภาษาไทยได้)
// ---------------------------------------------------------------------------
function template(kind, sample = {}) {
  const q = (s) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  const code = sample.member_code || 'M001';
  const center = sample.center || 'ศูนย์รับนม 1';
  const date = sample.date_be || '26/11/2569';
  const rows = kind === 'quality'
    ? [['รหัสสมาชิก', 'วันที่เก็บตัวอย่าง', 'ไขมัน', 'SNF', 'โปรตีน', 'SCC (พันเซลล์/มล.)', 'TBC (พัน/มล.)', 'ยาปฏิชีวนะ', 'ห้องปฏิบัติการ'],
      [code, date, '3.8', '8.6', '3.2', '280', '45', 'ไม่พบ', 'แล็บสหกรณ์']]
    : [['รหัสสมาชิก', 'วันที่', 'รอบ', 'ศูนย์รับนม', 'น้ำหนัก (กก.)', 'สถานะ', 'สาเหตุที่ไม่รับ', 'เลขตัวอย่าง'],
      [code, date, 'เช้า', center, '42.5', 'รับ', '', 'S-001'],
      [code, date, 'เย็น', center, '38', 'ไม่รับ', 'ยาปฏิชีวนะ', '']];
  return `\uFEFF${rows.map((r) => r.map(q).join(',')).join('\r\n')}\r\n`;
}

module.exports = {
  FileError, readZip, parseXlsx, parseCsv, parseFile, mapColumns, parseDate, parseNum, parseShift, parseStatus, parseReason, parseBool,
  normalizeRow, validateRows, summarize, template, FIELDS, MAX_ROWS, MAX_BYTES, MAX_INTAKE_KG,
};
