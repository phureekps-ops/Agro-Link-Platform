/**
 * ปรับโครงสร้างหนี้ของสัญญาในตลาดสินเชื่อระหว่างสหกรณ์ (db/grant_coop_lending_restructure.sql)
 *
 *   validate(proposal, state)   ตรวจคำขอ: วันครบกำหนดใหม่ต้องหลังวันนี้และหลังวันครบกำหนดที่เร็วที่สุดที่ค้างอยู่ ไม่เกิน 36 เดือน
 *                               อัตราดอกเบี้ยใหม่ต้องไม่สูงกว่าอัตราเดิมสูงสุด (ปรับโครงสร้างคือการผ่อนปรน ไม่ใช่เพิ่มภาระ)
 *   plan(items, facilities, p)  รายการที่จะเปลี่ยน: เลื่อนวันครบกำหนดเฉพาะรายการที่ครบก่อนวันใหม่ (ไม่ร่นวัน) · อัตราดอกเบี้ยต่อวงเงิน
 *   amendmentDocx(ctx)          บันทึกข้อตกลงแก้ไขเพิ่มเติมสัญญา (.docx) ให้ทุกฝ่ายลงนาม
 */
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, ShadingType, Header,
} = require('docx');
const L = require('./coopLending');

const MAX_MONTHS = 36;
const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

function validate(p, state) {
  const errors = [];
  const today = state.today || L.todayBangkok();
  if (!L.isDate(p.new_due_date)) errors.push('invalid_new_due_date');
  else {
    if (p.new_due_date <= today) errors.push('new_due_date_not_future');
    if (state.earliest_due && p.new_due_date <= state.earliest_due) errors.push('new_due_date_not_later');
    if (p.new_due_date > L.addMonths(today, MAX_MONTHS)) errors.push('new_due_date_too_far');
  }
  if (p.new_rate_pct !== null && p.new_rate_pct !== undefined) {
    const r = Number(p.new_rate_pct);
    if (!Number.isFinite(r) || r < 0) errors.push('invalid_rate');
    else if (state.max_rate !== null && state.max_rate !== undefined && r > Number(state.max_rate)) errors.push('rate_higher_than_current');
  }
  if (!(state.outstanding > 0)) errors.push('nothing_outstanding');
  return errors;
}

/** items: [{item_id, facility_id, loan_due_date, principal_outstanding}] · facilities: [{facility_id, rate_pct, lender_name}] */
function plan(items, facilities, p) {
  const itemChanges = items.filter((i) => Number(i.principal_outstanding) > 0 && L.toDateStr(i.loan_due_date) < p.new_due_date)
    .map((i) => ({ item_id: i.item_id, facility_id: i.facility_id, principal: r2(i.principal_outstanding), from: L.toDateStr(i.loan_due_date), to: p.new_due_date }));
  const rateChanges = (p.new_rate_pct === null || p.new_rate_pct === undefined) ? []
    : facilities.filter((f) => Number(f.rate_pct) !== Number(p.new_rate_pct)).map((f) => ({ facility_id: f.facility_id, lender_name: f.lender_name, from: Number(f.rate_pct), to: Number(p.new_rate_pct) }));
  return { itemChanges, rateChanges, principal: r2(itemChanges.reduce((a, x) => a + x.principal, 0)) };
}

// ---------------------------------------------------------------- .docx
const FONT = 'TH Sarabun New';
const PAGE_W = 11906; const MARGIN = 1134; const CONTENT_W = PAGE_W - MARGIN * 2;
const TH_MONTH = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const thDate = (d) => { if (!d) return '……………………'; const [y, m, dd] = L.toDateStr(d).split('-').map(Number); return `${dd} ${TH_MONTH[m - 1]} ${y + 543}`; };
const num = (v) => Number(v || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const run = (t, o = {}) => new TextRun({ text: String(t ?? ''), font: FONT, size: 32, ...o });
const para = (t, o = {}) => new Paragraph({ children: (Array.isArray(t) ? t : [t]).map((x) => (typeof x === 'string' ? run(x) : x)), spacing: { after: 80 }, ...o });
function table(headers, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  const w = widths.map((x) => Math.floor((x / total) * CONTENT_W)); w[w.length - 1] += CONTENT_W - w.reduce((a, b) => a + b, 0);
  const b = { style: BorderStyle.SINGLE, size: 4, color: '999999' };
  const cell = (t, i, head) => new TableCell({
    width: { size: w[i], type: WidthType.DXA }, borders: { top: b, bottom: b, left: b, right: b }, margins: { top: 40, bottom: 40, left: 80, right: 80 },
    shading: head ? { type: ShadingType.CLEAR, color: 'auto', fill: 'E8F1EA' } : undefined,
    children: [new Paragraph({ alignment: typeof t === 'number' ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [run(typeof t === 'number' ? num(t) : t, { size: 26, bold: head })] })],
  });
  return new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: w, rows: [new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, i, true)) }), ...rows.map((r) => new TableRow({ children: r.map((v, i) => cell(v, i, false)) }))] });
}

/** ctx: { request, agreement, listing, borrower:{org_name, signatories}, lenders:[{org_name, signatories, approval_ref}], snapshot } */
async function amendmentDocx(ctx) {
  const { request: rq, agreement: ag, listing, borrower, lenders, snapshot } = ctx;
  const items = (snapshot && snapshot.items) || [];
  const rates = (snapshot && snapshot.rates) || [];
  const children = [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: [run('บันทึกข้อตกลงแก้ไขเพิ่มเติมสัญญากู้ยืมเงินระหว่างสหกรณ์', { bold: true, size: 40 })] }),
    para([run(`(ปรับโครงสร้างหนี้) แนบท้ายสัญญาเลขที่ ${ag.agreement_no}`, { bold: true })], { alignment: AlignmentType.CENTER }),
    para(`โครงการ: ${listing.title}`, { alignment: AlignmentType.CENTER }),
    para(`ทำที่ ${'.'.repeat(40)}  วันที่ ${'.'.repeat(25)}`, { alignment: AlignmentType.RIGHT }),
    para(`บันทึกนี้ทำขึ้นระหว่าง ${borrower.org_name} ("ผู้กู้") กับ ${lenders.map((x) => x.org_name).join(' และ ')} ("ผู้ให้กู้") คู่สัญญาตามสัญญากู้ยืมเงินเลขที่ ${ag.agreement_no} `
      + `เพื่อแก้ไขเงื่อนไขการชำระหนี้ตามคำขอของผู้กู้ลงวันที่ ${thDate(rq.created_at)} ซึ่งผู้ให้กู้ทุกรายอนุมัติแล้ว โดยมีข้อความดังนี้`, { indent: { firstLine: 567 } }),
    para([run('ข้อ 1 เหตุผลและแผนการชำระหนี้ใหม่', { bold: true })]),
    para(`เหตุผลของผู้กู้: ${rq.reason}`, { indent: { firstLine: 567 } }),
    para(`แผนการชำระหนี้ใหม่: ${rq.repayment_plan}`, { indent: { firstLine: 567 } }),
    para([run('ข้อ 2 การขยายระยะเวลาชำระเงินต้น', { bold: true })]),
    para(`คู่สัญญาตกลงขยายวันครบกำหนดชำระเงินต้นที่ค้างอยู่เป็นวันที่ ${thDate(rq.new_due_date)} ตามรายการต่อไปนี้ ดอกเบี้ยและดอกเบี้ยผิดนัดที่เกิดขึ้นจนถึงวันที่ ${thDate(snapshot && snapshot.accrued_to)} ยังคงเป็นหนี้ที่ผู้กู้ต้องชำระ`, { indent: { firstLine: 567 } }),
    items.length ? table(['รายการ', 'เงินต้นคงค้าง (บาท)', 'ครบกำหนดเดิม', 'ครบกำหนดใหม่'], items.map((x, i) => [`${i + 1}. ${x.description || x.item_id.slice(0, 8)}`, x.principal, thDate(x.from), thDate(x.to)]), [46, 18, 18, 18])
      : para('— ไม่มีรายการที่ต้องเลื่อนวันครบกำหนด —'),
    para([run('ข้อ 3 อัตราดอกเบี้ย', { bold: true })], { spacing: { before: 160, after: 80 } }),
    rates.length ? table(['ผู้ให้กู้', 'อัตราเดิม (% ต่อปี)', 'อัตราใหม่ (% ต่อปี)'], rates.map((x) => [x.lender_name || '-', x.from, x.to]), [50, 25, 25])
      : para('อัตราดอกเบี้ยคงเดิมตามสัญญา', { indent: { firstLine: 567 } }),
    para([run('ข้อ 4 ผลของบันทึกนี้', { bold: true })], { spacing: { before: 160, after: 80 } }),
    para('ข้อความอื่นในสัญญาเดิมที่ไม่ขัดหรือแย้งกับบันทึกนี้ให้คงใช้บังคับต่อไป หากผู้กู้ผิดนัดชำระตามกำหนดใหม่ ให้ถือเป็นการผิดนัดตามสัญญาเดิม', { indent: { firstLine: 567 } }),
    para([run('การอนุมัติของผู้ให้กู้', { bold: true })], { spacing: { before: 160, after: 80 } }),
    table(['ผู้ให้กู้', 'เลขที่มติ/บันทึกอนุมัติ'], lenders.map((x) => [x.org_name, x.approval_ref || '-']), [60, 40]),
  ];
  const sign = (label, name, who) => [para(''), para(`ลงชื่อ ${'.'.repeat(45)} ${label}`, { alignment: AlignmentType.RIGHT }),
    para(`( ${who || '.'.repeat(40)} )`, { alignment: AlignmentType.RIGHT }), para(`ผู้มีอำนาจลงนามแทน ${name}`, { alignment: AlignmentType.RIGHT })];
  children.push(...sign('ผู้กู้', borrower.org_name, borrower.signatories));
  lenders.forEach((x) => children.push(...sign('ผู้ให้กู้', x.org_name, x.signatories)));
  const doc = new Document({
    creator: 'AgroLink', title: `บันทึกแก้ไขเพิ่มเติมสัญญา ${ag.agreement_no}`,
    styles: { default: { document: { run: { font: { ascii: FONT, hAnsi: FONT, cs: FONT, eastAsia: FONT }, size: 32 } } } },
    sections: [{
      properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [run('ร่างเอกสารที่ระบบ AgroLink จัดทำจากข้อตกลงในระบบ — ให้ที่ปรึกษากฎหมายของคู่สัญญาตรวจทานก่อนลงนาม', { size: 22, color: '8A5A00' })] })] }) },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { MAX_MONTHS, validate, plan, amendmentDocx };
