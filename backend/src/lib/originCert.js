/**
 * ใบรับรองแหล่งที่มา (db/grant_origin_certificate.sql)
 *
 *   buildCore(c, trace, orgId)   ภาพนิ่งของสาย ณ ตอนนี้ — ไม่มีชื่อ รหัส หรือพิกัดของสมาชิก
 *                                แปลงแทนด้วย "ลายนิ้วมือ" SHA-256 ของ (รหัสแปลง + ขอบเขตแปลง) เพื่อพิสูจน์ภายหลังว่าเป็นแปลงชุดเดิม
 *   canonical / sha256           JSON เรียงคีย์คงที่ → แฮชเดิมทุกครั้งไม่ว่าลำดับคีย์ในฐานข้อมูล
 *   liveDiff(oldCore, newCore)   เทียบข้อมูลปัจจุบันกับที่รับรองไว้ (เฉพาะส่วนสายการผลิต — ผลดาวเทียมเปลี่ยนตามรอบภาพได้)
 *   renderPdf(cert, opts)        PDF A4 ภาษาไทย (ฟอนต์ Sarabun, OFL) พร้อม QR ไปหน้าตรวจสอบ
 */
const crypto = require('crypto');
const T = require('./cropTrace');

const CERT_RE = /^OC-[0-9A-HJKMNP-TV-Z]{8}$/;
const normCertNo = (s) => {
  const m = String(s || '').trim().toUpperCase().replace(/\s+/g, '').match(/^OC-?(.+)$/);
  return m ? `OC-${m[1].replace(/[OIL]/g, (ch) => ({ O: '0', I: '1', L: '1' }[ch]))}` : '';
};

function canonical(v) {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
  return JSON.stringify(v);
}
const sha256 = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex');
const iso = (v) => (v ? new Date(v).toISOString() : null);
const r3 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 1000) / 1000);

/** ภาพนิ่งที่รับรอง — t จาก cropTrace.loadTrace */
async function buildCore(c, t, orgId) {
  const unitIds = [...new Set(t.deliveries.map((d) => d.unit_id).filter(Boolean))];
  const plots = unitIds.length ? (await c.query(
    `SELECT unit_id, COALESCE(ST_AsText(gps_boundary), '') AS wkt FROM registry.production_unit WHERE unit_id = ANY($1::uuid[])`, [unitIds],
  )).rows : [];
  const coop = (await c.query(
    `SELECT o.org_name, pv.province_name_th, cp.cooperative_registration_no FROM identity.organization o
       LEFT JOIN registry.cooperative_profile cp ON cp.org_id = o.org_id LEFT JOIN registry.province pv ON pv.province_code = cp.province_code
      WHERE o.org_id = $1`, [orgId],
  )).rows[0] || {};
  let registration = coop.cooperative_registration_no || null;
  if ((await c.query("SELECT to_regclass('registry.coop_directory') IS NOT NULL AS ok")).rows[0].ok) {
    const d = (await c.query('SELECT registration_no FROM registry.coop_directory WHERE org_id = $1', [orgId])).rows[0];
    if (d && d.registration_no) registration = d.registration_no;
  }
  const pub = T.publicView(t, { org_name: coop.org_name, province_name_th: coop.province_name_th });
  const s = T.summarize(t);
  const fg = t.start.type === 'finished_good' ? t.finished_goods.find((f) => f.finished_good_id === t.start.id) : null;
  const lot = t.start.type === 'lot' ? t.lots.find((l) => l.lot_id === t.start.id) : null;
  return {
    version: 1,
    subject: {
      type: t.start.type, code: t.start.code, product: pub.product, commodity: pub.commodity,
      quantity_ton: r3(fg ? fg.quantity_ton : lot ? lot.quantity_ton : null),
    },
    cooperative: { name: coop.org_name || null, province: coop.province_name_th || null, registration_no: registration },
    origin: {
      farmers: s.farmers, plots: s.plots, area_rai: s.area_rai, provinces: [...s.provinces].sort(),
      plots_satellite_confirmed: s.plots_confirmed, plots_satellite_mismatch: s.plots_mismatch,
      harvest_from: iso(s.delivered_from), harvest_to: iso(s.delivered_to), grades: [...s.grades].sort(), raw_ton: r3(s.raw_ton),
    },
    chain: {
      lots: t.lots.map((l) => ({ code: l.trace_code, ton: r3(l.quantity_ton), deliveries: l.delivery_count })).sort((a, b) => a.code.localeCompare(b.code)),
      batches: t.batches.filter((b) => b.status !== 'Cancelled').map((b) => ({ code: b.trace_code, process: b.process_type, input_ton: r3(b.input_quantity_ton), output_ton: r3(b.output_quantity_ton), completed_at: iso(b.completed_at) }))
        .sort((a, b) => a.code.localeCompare(b.code)),
      plot_fingerprints: plots.map((p) => sha256(`${p.unit_id}|${p.wkt}`)).sort(),
    },
    steps: pub.steps.map((x) => ({ title: x.title, from: iso(x.from), to: iso(x.to), detail: x.detail || '' })),
  };
}

const LIVE_LABELS = {
  'subject.code': 'รหัสสินค้า/ล็อต', 'subject.quantity_ton': 'ปริมาณสินค้า', 'origin.farmers': 'จำนวนครอบครัวเกษตรกร', 'origin.plots': 'จำนวนแปลง',
  'origin.area_rai': 'พื้นที่รวม', 'origin.raw_ton': 'ปริมาณผลผลิตที่รับซื้อ', 'chain.lots': 'ล็อตรวบรวม', 'chain.batches': 'รอบแปรรูป', 'chain.plot_fingerprints': 'ชุดแปลงที่มา',
};
/** ส่วนสายการผลิตที่เปลี่ยนไปหลังออกใบรับรอง (ผลดาวเทียมไม่นับ เพราะอัปเดตตามรอบภาพ) */
function liveDiff(oldCore, newCore) {
  const get = (o, path) => path.split('.').reduce((a, k) => (a ? a[k] : undefined), o);
  return Object.entries(LIVE_LABELS).filter(([p]) => canonical(get(oldCore, p)) !== canonical(get(newCore, p))).map(([p, label]) => ({ field: p, label }));
}

// ---------------------------------------------------------------- PDF
const THAI_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
function thDate(v) {
  if (!v) return '-';
  const d = new Date(new Date(v).getTime() + 7 * 3600e3); // เวลาไทย
  return `${d.getUTCDate()} ${THAI_MONTH[d.getUTCMonth()]} ${d.getUTCFullYear() + 543}`;
}
const fmt = (v, dp = 2) => (v === null || v === undefined ? '-' : Number(v).toLocaleString('en-US', { maximumFractionDigits: dp }));

function renderPdf(cert, { verifyUrl }) {
  // eslint-disable-next-line global-require
  const PDFDocument = require('pdfkit');
  // eslint-disable-next-line global-require
  const qrcode = require('qrcode-generator');
  const font = (n) => require.resolve(`@fontsource/sarabun/files/sarabun-${n}-normal.woff`);
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `ใบรับรองแหล่งที่มา ${cert.cert_no}`, Author: 'AgroLink', Subject: cert.payload.core.subject.code } });
  doc.registerFont('th', font('thai-400')); doc.registerFont('la', font('latin-400'));
  doc.registerFont('thb', font('thai-700')); doc.registerFont('lab', font('latin-700'));
  const chunks = [];
  doc.on('data', (b) => chunks.push(b));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  // ข้อความผสมไทย/อังกฤษ: สลับฟอนต์ตามอักษร (ฟอนต์ไทยของ Sarabun แยกชุดอักษร)
  const text = (s, { bold = false, size = 11, color = '#1d2a20', ...o } = {}) => {
    const parts = String(s).match(/[฀-๿]+|[^฀-๿]+/g) || [''];
    doc.fontSize(size).fillColor(color);
    parts.forEach((p, i) => {
      doc.font(/[฀-๿]/.test(p) ? (bold ? 'thb' : 'th') : (bold ? 'lab' : 'la'));
      doc.text(p, { ...o, continued: i < parts.length - 1 });
    });
  };
  const core = cert.payload.core;
  const W = doc.page.width - 96;
  const revoked = cert.status === 'Revoked';

  // หัวกระดาษ
  doc.rect(48, 40, W, 6).fill('#2e7d32');
  doc.moveDown(0.6);
  text('ใบรับรองแหล่งที่มาสินค้าเกษตร', { bold: true, size: 22, color: '#1b3a1f' });
  text('Certificate of Origin · AgroLink Traceability', { size: 11, color: '#55605a' });
  doc.moveDown(0.3);
  text(`เลขที่ ${cert.cert_no}   ·   ออกเมื่อ ${thDate(cert.issued_at)}   ·   สถานะ ${revoked ? 'ยกเลิกแล้ว' : 'มีผล'}`, { size: 11, bold: true, color: revoked ? '#a1261d' : '#1f6b38' });
  if (revoked) text(`ยกเลิกเมื่อ ${thDate(cert.revoked_at)}: ${cert.revoked_reason || ''}`, { size: 10, color: '#a1261d', width: W });

  // QR มุมขวาบน
  const qr = qrcode(0, 'M'); qr.addData(verifyUrl); qr.make();
  const n = qr.getModuleCount(); const size = 104; const cell = size / n; const qx = 48 + W - size; const qy = 64;
  doc.save().fillColor('#000');
  for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) if (qr.isDark(r, c)) doc.rect(qx + c * cell, qy + r * cell, cell + 0.2, cell + 0.2).fill();
  doc.restore();
  doc.fontSize(7).font('la').fillColor('#55605a').text('Scan to verify', qx, qy + size + 2, { width: size, align: 'center' });
  doc.x = 48; doc.y = Math.max(doc.y, qy + size + 18);

  const section = (title) => { doc.moveDown(0.6); text(title, { bold: true, size: 13, color: '#1b3a1f' }); doc.moveTo(48, doc.y + 1).lineTo(48 + W, doc.y + 1).lineWidth(0.5).strokeColor('#cfe0d1').stroke(); doc.moveDown(0.3); };
  const row = (k, v) => { const y = doc.y; text(k, { size: 10.5, color: '#55605a', width: 150 }); const y2 = doc.y; doc.x = 200; doc.y = y; text(v, { size: 10.5, width: W - 152 }); doc.x = 48; doc.y = Math.max(y2, doc.y) + 2; };

  section('สินค้าที่รับรอง');
  row('สินค้า/ล็อต', `${core.subject.product || '-'}`);
  row('รหัสติดตาม', core.subject.code);
  row('ชนิดผลผลิต', core.subject.commodity || '-');
  if (core.subject.quantity_ton !== null) row('ปริมาณ', `${fmt(core.subject.quantity_ton, 3)} ตัน`);
  section('ผู้รวบรวมและผลิต');
  row('สหกรณ์', core.cooperative.name || '-');
  row('จังหวัด', core.cooperative.province || '-');
  row('เลขทะเบียนสหกรณ์', core.cooperative.registration_no || 'ยังไม่ได้ยืนยันกับทะเบียน');
  section('แหล่งที่มา');
  const o = core.origin;
  row('เกษตรกรสมาชิก', `${o.farmers} ครอบครัว`);
  row('แปลงเพาะปลูก', `${o.plots} แปลง รวม ${fmt(o.area_rai)} ไร่ ใน ${o.provinces.join(', ') || '-'}`);
  row('ตรวจด้วยภาพดาวเทียม', `ยืนยันชนิดพืชตรงกัน ${o.plots_satellite_confirmed} จาก ${o.plots} แปลง${o.plots_satellite_mismatch ? ` (เห็นพืชอื่น/ไม่พบพืช ${o.plots_satellite_mismatch} แปลง)` : ''}`);
  row('ช่วงรับซื้อผลผลิต', `${thDate(o.harvest_from)} – ${thDate(o.harvest_to)}${o.grades.length ? ` · เกรด ${o.grades.join(', ')}` : ''}`);
  row('ผลผลิตที่รับซื้อ', `${fmt(o.raw_ton, 3)} ตัน`);
  section('เส้นทางของผลผลิต');
  core.steps.forEach((st, i) => {
    const when = st.from ? `${thDate(st.from)}${st.to && thDate(st.to) !== thDate(st.from) ? ` – ${thDate(st.to)}` : ''}` : '';
    text(`${i + 1}. ${st.title}${when ? `  (${when})` : ''}${st.detail ? ` · ${st.detail}` : ''}`, { size: 10.5, width: W });
  });
  section('การตรวจสอบความถูกต้อง');
  text(`ตรวจสอบออนไลน์: ${verifyUrl}`, { size: 10, width: W });
  text(`ลายนิ้วมือข้อมูล (SHA-256): ${cert.payload_sha256}`, { size: 9, width: W, color: '#55605a' });
  if (cert.prev_sha256) text(`ต่อจากใบก่อนหน้าของสหกรณ์ (SHA-256): ${cert.prev_sha256}`, { size: 8, width: W, color: '#8a958d' });
  text(`ลายนิ้วมือแปลงที่มา ${core.chain.plot_fingerprints.length} แปลง บันทึกไว้ในใบรับรอง — พิสูจน์ได้ว่าเป็นแปลงชุดเดิมโดยไม่เปิดเผยตำแหน่ง`, { size: 9, width: W, color: '#55605a' });
  doc.moveDown(0.8);
  text('ใบรับรองนี้ออกโดยสหกรณ์ผ่านแพลตฟอร์ม AgroLink จากข้อมูลที่สหกรณ์บันทึกในระบบ ณ วันที่ออก ผลการตรวจด้วยภาพดาวเทียมเป็นการประเมินอัตโนมัติ '
    + 'ใบรับรองนี้ไม่ใช่การรับรองมาตรฐานจากหน่วยงานรัฐหรือหน่วยรับรอง และไม่มีข้อมูลส่วนบุคคลของสมาชิก หากข้อมูลหน้าเว็บตรวจสอบไม่ตรงกับเอกสารนี้ ให้ถือตามหน้าเว็บ',
  { size: 8.5, width: W, color: '#8a958d' });
  if (revoked) {
    doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] }).fontSize(80).font('thb').fillColor('#a1261d').opacity(0.15)
      .text('ยกเลิกแล้ว', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center' }).restore();
  }
  doc.end();
  return done;
}

module.exports = { CERT_RE, normCertNo, canonical, sha256, buildCore, liveDiff, renderPdf, thDate };
