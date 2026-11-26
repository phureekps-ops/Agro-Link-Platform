/**
 * ระบบจัดทำเอกสารการกู้ยืม (Concept Note ข้อ 7) — ชุดเอกสาร .docx ที่แก้ไขได้ จากข้อตกลงที่บันทึกในระบบ
 *
 *   สัญญากู้ยืมเงินระหว่างสหกรณ์ (ผู้ให้กู้ร่วมหลายรายได้ สัดส่วนตามวงเงิน)
 *   ภาคผนวก ก ตารางการเบิกจ่าย · ข ตารางการชำระคืน · ค หลักประกัน/ค้ำประกัน · ง ข้อตกลงบัญชีโครงการ
 *   ภาคผนวก จ หนังสือยินยอมเปิดเผยและติดตามข้อมูล · ฉ รายการเอกสารแนบ
 *
 * เป็นร่างจากแม่แบบมาตรฐาน — ทุกหน้ามีหัวกระดาษเตือนให้ที่ปรึกษากฎหมายของคู่สัญญาตรวจทานก่อนลงนาม
 */
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel, Header, Footer,
  PageNumber, BorderStyle, ShadingType, PageBreak, LevelFormat,
} = require('docx');
const M = require('./coopMarket');
const L = require('./coopLending');

const FONT = 'TH Sarabun New';
const PAGE_W = 11906; // A4
const MARGIN = 1134; // 2 ซม.
const CONTENT_W = PAGE_W - (MARGIN * 2);
const BANKS = {
  '002': 'กรุงเทพ', '004': 'กสิกรไทย', '006': 'กรุงไทย', '011': 'ทหารไทยธนชาต', '014': 'ไทยพาณิชย์', '025': 'กรุงศรีอยุธยา', '030': 'ออมสิน', '033': 'อาคารสงเคราะห์', '034': 'ธ.ก.ส.',
};
const TH_MONTH = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const thDate = (d) => { if (!d) return '……………………'; const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number); return `${dd} ${TH_MONTH[m - 1]} ${y + 543}`; };
const baht = (v) => `${Number(v || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`;
const num = (v) => Number(v || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const KIND_TH = { SavingsCooperative: 'สหกรณ์ออมทรัพย์', CreditUnion: 'สหกรณ์เครดิตยูเนี่ยน' };
const DOC_KIND_TH = {
  resolution: 'มติที่ประชุม', financial_statement: 'งบการเงิน', business_plan: 'แผนธุรกิจ', quotation: 'ใบเสนอราคา', member_list: 'รายชื่อสมาชิกผู้กู้',
  production_plan: 'แผนการผลิต', buyer_contract: 'สัญญา/หนังสือผู้ซื้อปลายทาง', collateral: 'เอกสารหลักประกัน', other: 'อื่น ๆ',
};

const run = (t, o = {}) => new TextRun({ text: String(t ?? ''), font: FONT, size: 32, ...o });
const p = (children, o = {}) => new Paragraph({ children: (Array.isArray(children) ? children : [children]).map((c) => (typeof c === 'string' ? run(c) : c)), spacing: { after: 80 }, ...o });
const h1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, spacing: { before: 120, after: 200 }, children: [run(t, { bold: true, size: 40 })] });
const h2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 }, children: [run(t, { bold: true, size: 34 })] });
const clause = (no, title, body) => [p([run(`ข้อ ${no} ${title}`, { bold: true })], { spacing: { before: 140, after: 60 } }),
  ...(Array.isArray(body) ? body : [body]).map((b) => p(b, { indent: { firstLine: 567 } }))];
const pageBreak = () => new Paragraph({ children: [new PageBreak()] });
const blank = (len = 30) => '.'.repeat(len);

function table(headers, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  const w = widths.map((x) => Math.floor((x / total) * CONTENT_W));
  w[w.length - 1] += CONTENT_W - w.reduce((a, b) => a + b, 0);
  const border = { style: BorderStyle.SINGLE, size: 4, color: '999999' };
  const borders = { top: border, bottom: border, left: border, right: border };
  const cell = (t, i, head, right) => new TableCell({
    width: { size: w[i], type: WidthType.DXA }, borders, margins: { top: 40, bottom: 40, left: 80, right: 80 },
    shading: head ? { type: ShadingType.CLEAR, color: 'auto', fill: 'E8F1EA' } : undefined,
    children: [new Paragraph({ alignment: right ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [run(t, { size: 26, bold: head })] })],
  });
  const isNum = (v) => typeof v === 'number';
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: w,
    rows: [new TableRow({ tableHeader: true, children: headers.map((hd, i) => cell(hd, i, true, false)) }),
      ...rows.map((r) => new TableRow({ children: r.map((v, i) => cell(isNum(v) ? num(v) : v, i, false, isNum(v))) }))],
  });
}
function signBlock(label, name, signatories) {
  return [p(''), p(`ลงชื่อ ${blank(45)} ${label}`, { alignment: AlignmentType.RIGHT }), p(`( ${signatories || blank(40)} )`, { alignment: AlignmentType.RIGHT }),
    p(`ผู้มีอำนาจลงนามแทน ${name}`, { alignment: AlignmentType.RIGHT }), p(`ประทับตราสหกรณ์ (ถ้ามี)  วันที่ ${blank(20)}`, { alignment: AlignmentType.RIGHT })];
}

/** ตารางเบิกจ่ายตามประเภทโครงการ */
function disbursementRows(listing) {
  const d = listing.details || {};
  if (listing.project_type === 'member_onlending') {
    return {
      intro: 'เบิกจ่ายเป็นงวดตามกิจกรรมจริงในแปลงของสมาชิกแต่ละราย (แผนสินเชื่อการผลิตรายแปลงในระบบ) จ่ายตรงร้านค้าปัจจัยการผลิตหรือผู้ให้บริการ ไม่จ่ายเงินสดให้เกษตรกร '
        + `วงเงินต่อสมาชิกไม่เกิน ${d.per_member_limit ? baht(d.per_member_limit) : blank(15)} งวดถัดไปของแต่ละแปลงเปิดเมื่อผู้ให้กู้ผ่านผลตรวจแปลงของงวดก่อน`,
      headers: ['งวด', 'กิจกรรม', 'สัดส่วนโดยประมาณ', 'หลักฐาน/วิธีตรวจก่อนเบิก', 'ผู้รับเงิน'],
      rows: L.STAGE_TEMPLATE.map((s, i) => [String(i + 1), s.name_th, `${s.pct}%`, s.check_th, s.purposes.includes('machinery_service') && !s.purposes.includes('inputs') ? 'ผู้ให้บริการเครื่องจักร' : 'ร้านค้าปัจจัย / ผู้ให้บริการ']),
      widths: [8, 28, 14, 34, 22],
    };
  }
  if (listing.project_type === 'procurement') {
    return {
      intro: `เบิกจ่ายตามรายการรับซื้อ${d.commodity ? ` ${d.commodity}` : ''} แต่ละรายการ ช่วง ${thDate(d.period_from)} ถึง ${thDate(d.period_to)} ปริมาณรวมไม่เกิน ${d.volume_t || blank(8)} ตัน `
        + `ราคาอ้างอิง ${d.reference_price ? `${d.reference_price} บาท/กก.` : blank(8)} รายการที่ราคาต่างจากราคาอ้างอิงเกินร้อยละ 15 ต้องได้รับการยืนยันจากผู้ให้กู้ก่อนจ่าย`,
      headers: ['ขั้น', 'รายการที่ต้องเกิดขึ้น', 'หลักฐานที่ต้องแสดง', 'ผู้รับเงิน'],
      rows: [['1', 'เกษตรกรนำผลผลิตมาจำหน่าย', 'ตัวตนผู้ขายและบัญชีธนาคารที่ตรวจชื่อแล้ว', '—'], ['2', 'ชั่งน้ำหนักและตรวจคุณภาพ', 'ใบชั่งน้ำหนัก ใบตรวจคุณภาพ', '—'],
        ['3', 'บันทึกรับซื้อ', 'ใบรับซื้อ ราคา ปริมาณ มูลค่า', '—'], ['4', 'อนุมัติและจ่ายเงิน', 'หลักฐานโอนเงินและเลขอ้างอิงธุรกรรม', 'บัญชีผู้ขายผลผลิตโดยตรง หรือผ่านบัญชีโครงการ']],
      widths: [8, 30, 40, 26],
    };
  }
  return {
    intro: 'จ่ายตรงแก่ผู้ขายหรือผู้รับจ้างตามงวดงานหรือการส่งมอบที่ตรวจรับแล้วเท่านั้น ตามรายการต่อไปนี้',
    headers: ['งวด', 'รายการ/งวดงาน', 'จำนวนเงิน', 'ช่วงเวลา', 'หลักฐานการเบิก'],
    rows: (listing.use_plan || []).map((u, i) => [String(i + 1), u.item || '', Number(u.amount || 0), u.timing || '', 'สัญญาซื้อ/จ้าง ใบส่งมอบ การตรวจรับ ภาพถ่ายการติดตั้ง']),
    widths: [8, 32, 18, 16, 30],
  };
}

/**
 * ctx: { agreement, listing, borrower:{org, profile}, lenders:[{org, profile, offer, amount, share_pct}], documents:[], projectAccount, settings, startDate }
 */
async function buildAgreementDocx(ctx) {
  const {
    agreement, listing, borrower, lenders, documents = [], projectAccount, settings = {},
  } = ctx;
  const start = ctx.startDate || agreement.start_date || L.todayBangkok();
  const type = M.PROJECT_TYPES[listing.project_type];
  const bp = borrower.profile || {};
  const penalty = Number(settings.late_penalty_pct ?? 10);
  const multi = lenders.length > 1;
  const children = [];

  // ---------- สัญญาหลัก ----------
  children.push(h1('สัญญากู้ยืมเงินระหว่างสหกรณ์'));
  children.push(p([run(`เลขที่สัญญา ${agreement.agreement_no}`, { bold: true })], { alignment: AlignmentType.CENTER }));
  children.push(p(`โครงการ: ${listing.title} (${type.name_th})`, { alignment: AlignmentType.CENTER }));
  children.push(p(`ทำที่ ${blank(40)}  วันที่ ${blank(25)}`, { alignment: AlignmentType.RIGHT }));
  children.push(p([run('สัญญานี้ทำขึ้นระหว่าง', { bold: true })]));
  children.push(p(`${borrower.org.org_name} เลขทะเบียน ${bp.registration_no || blank(15)} ${bp.signatories ? `โดย ${bp.signatories} ผู้มีอำนาจลงนาม` : ''} ซึ่งต่อไปในสัญญานี้เรียกว่า "ผู้กู้" ฝ่ายหนึ่ง`, { indent: { firstLine: 567 } }));
  lenders.forEach((x, i) => {
    children.push(p(`${x.org.org_name} (${KIND_TH[x.org.org_type] || 'สหกรณ์'}) เลขทะเบียน ${(x.profile && x.profile.registration_no) || blank(15)} ${x.profile && x.profile.signatories ? `โดย ${x.profile.signatories} ผู้มีอำนาจลงนาม` : ''} `
      + `ซึ่งต่อไปในสัญญานี้เรียกว่า "ผู้ให้กู้${multi ? ` รายที่ ${i + 1}` : ''}" ${i === lenders.length - 1 ? 'อีกฝ่ายหนึ่ง' : ''}`, { indent: { firstLine: 567 } }));
  });
  children.push(p(`คู่สัญญาตกลงกันตามมติที่ประชุมของแต่ละฝ่ายซึ่งแนบท้ายสัญญานี้ โดยมีข้อความดังต่อไปนี้`, { indent: { firstLine: 567 } }));

  children.push(...clause(1, 'วัตถุประสงค์และวงเงินกู้', [
    `ผู้ให้กู้ตกลงให้ผู้กู้กู้เงินรวม ${baht(agreement.total_amount)} เพื่อ${type.name_th} ตามโครงการ "${listing.title}"${listing.objective ? ` — ${listing.objective}` : ''}`,
    ...lenders.map((x, i) => `${multi ? `ผู้ให้กู้รายที่ ${i + 1} ` : 'ผู้ให้กู้ '}${x.org.org_name} วงเงิน ${baht(x.amount)} (ร้อยละ ${num(x.share_pct)} ของวงเงินรวม)`),
    'ผู้กู้จะใช้เงินกู้เพื่อวัตถุประสงค์ตามสัญญานี้เท่านั้น',
  ]));
  children.push(...clause(2, 'การเบิกจ่ายและเงื่อนไขก่อนการเบิกจ่าย', [
    'การเบิกจ่ายเป็นไปตามตารางการเบิกจ่าย (ภาคผนวก ก) ผ่านระบบ AgroLink โดยไม่จ่ายเป็นเงินสดให้ผู้กู้หรือสมาชิก และโอนตรงถึงผู้ขาย ผู้ให้บริการ หรือผู้รับจ้าง หรือผ่านบัญชีโครงการ (ภาคผนวก ง)',
    'เงื่อนไขก่อนการเบิกจ่ายแต่ละงวด: (1) สัญญาลงนามครบทุกฝ่ายและเปิดบัญชีโครงการแล้ว (2) มีหลักฐานกิจกรรม รายการซื้อขาย หรือการส่งมอบครบตามภาคผนวก ก (3) ไม่มีเหตุผิดนัดตามข้อ 8 (4) ผู้กู้ส่งรายงานตามข้อ 7 ครบถ้วน',
    'ผู้ให้กู้มีสิทธิระงับการเบิกจ่ายงวดถัดไปเมื่อพบความผิดปกติจากการตรวจสอบกิจกรรมในแปลง ภาพถ่ายดาวเทียม หรือหลักฐานการซื้อขาย จนกว่าจะได้รับคำชี้แจงหรือแก้ไข',
  ]));
  children.push(...clause(3, 'ดอกเบี้ย', [
    ...lenders.map((x, i) => `${multi ? `ผู้ให้กู้รายที่ ${i + 1}: ` : ''}อัตราร้อยละ ${num(x.offer.rate_pct)} ต่อปี`),
    'คิดดอกเบี้ยเป็นรายวันจากยอดเงินต้นที่เบิกจ่ายจริงและยังไม่ได้ชำระ นับจากวันที่เงินเข้าบัญชีโครงการหรือวันที่โอนถึงผู้รับเงิน',
    `กรณีผิดนัดชำระ ผู้กู้ต้องเสียดอกเบี้ยผิดนัดในอัตราร้อยละ ${penalty} ต่อปีของยอดที่ค้างชำระ นับจากวันถัดจากวันครบกำหนด (ไม่เกินอัตราที่กฎหมายกำหนด)`,
  ]));
  children.push(...clause(4, 'ระยะเวลาและการชำระคืน', [
    ...lenders.map((x, i) => {
      const o = x.offer;
      return `${multi ? `ผู้ให้กู้รายที่ ${i + 1}: ` : ''}อายุสัญญา ${o.tenor_months} เดือน นับจากวันที่ ${thDate(start)} ${o.repayment_type === 'bullet' ? `ชำระดอกเบี้ยทุก ${o.interval_months} เดือน และชำระเงินต้นครั้งเดียวเมื่อครบกำหนด` : `ผ่อนชำระเงินต้นพร้อมดอกเบี้ยทุก ${o.interval_months} เดือน`}${Number(o.grace_months) ? ` ปลอดชำระเงินต้น ${o.grace_months} เดือนแรก` : ''} ตามตารางการชำระคืน (ภาคผนวก ข)`;
    }),
    `แหล่งชำระคืน: ${listing.repayment_source || listing.repayment_plan || blank(40)}`,
    'ตารางในภาคผนวก ข คำนวณโดยสมมติว่าเบิกเต็มวงเงินในวันเริ่มสัญญา ยอดจริงคำนวณจากยอดและวันที่เบิกจ่ายจริงในระบบ',
  ]));
  children.push(...clause(5, 'บัญชีโครงการและลำดับการนำรายได้ไปชำระหนี้', [
    `ผู้กู้เปิดบัญชีเฉพาะโครงการ${projectAccount ? ` ธนาคาร${BANKS[projectAccount.bank_code] || projectAccount.bank_code} เลขที่ xxx-x-${String(projectAccount.account_no).slice(-5)} ชื่อบัญชี ${projectAccount.account_name}` : ` ${blank(40)}`} เพื่อรับเงินกู้ จ่ายผู้รับเงิน และรับรายได้ของโครงการ ตามข้อตกลงบัญชีโครงการ (ภาคผนวก ง)`,
    'รายได้ของโครงการที่เข้าบัญชีโครงการให้นำไปชำระตามลำดับ: (1) ดอกเบี้ยผิดนัดและค่าปรับ (2) ดอกเบี้ยค้างชำระ (3) เงินต้นที่ถึงกำหนด ส่วนที่เหลือจึงคืนแก่ผู้กู้',
  ]));
  children.push(...clause(6, 'หลักประกัน', 'ผู้กู้ตกลงให้หลักประกันตามรายการในภาคผนวก ค และทรัพย์สินที่ได้จากโครงการ (ถ้ามี) ใช้เป็นหลักประกันได้ตามที่ตกลงและกฎหมายที่เกี่ยวข้อง'));
  children.push(...clause(7, 'หน้าที่รายงานข้อมูลและรักษาอัตราส่วนทางการเงิน', [
    'ผู้กู้ต้องบันทึกหลักฐานการใช้เงินทุกรายการในระบบ รายงานผลการดำเนินงานเทียบกับแผน (ผลผลิต รายได้ การรับซื้อ หรือผลประกอบการของโครงการ) ทุกไตรมาส และส่งงบการเงินที่ผ่านการสอบบัญชีภายใน 30 วันหลังได้รับ',
    'ผู้กู้ต้องรักษาฐานะการเงินไม่ให้ด้อยลงอย่างมีนัยสำคัญจากวันทำสัญญา และแจ้งผู้ให้กู้ทันทีเมื่อเกิดเหตุที่อาจกระทบความสามารถในการชำระหนี้',
  ]));
  children.push(...clause(8, 'เหตุผิดนัด การระงับการเบิกจ่าย และการเรียกคืนเงินกู้', [
    'เหตุผิดนัด ได้แก่ (1) ไม่ชำระหนี้เมื่อถึงกำหนดเกินระยะผ่อนผัน (2) ใช้เงินผิดวัตถุประสงค์หรือแสดงหลักฐานอันเป็นเท็จ (3) ไม่ปฏิบัติตามหน้าที่ตามข้อ 7 หลังได้รับแจ้งให้แก้ไขภายใน 30 วัน (4) ถูกสั่งเลิกสหกรณ์หรืออยู่ระหว่างชำระบัญชี',
    'เมื่อเกิดเหตุผิดนัด ผู้ให้กู้มีสิทธิระงับการเบิกจ่ายงวดถัดไปทันที และเมื่อแจ้งเป็นหนังสือแล้วผู้กู้ไม่แก้ไขภายในเวลาที่กำหนด มีสิทธิเรียกให้ชำระหนี้ทั้งหมดคืนก่อนกำหนด',
    'ผู้กู้ยังคงรับผิดชำระหนี้ต่อผู้ให้กู้เต็มจำนวน แม้สมาชิกบางรายผิดนัดชำระต่อผู้กู้',
  ]));
  children.push(...clause(9, 'การผ่อนผันและการปรับโครงสร้างหนี้', 'กรณีภัยธรรมชาติ ผลผลิตเสียหาย หรือราคาผลผลิตตกต่ำอย่างรุนแรงซึ่งมีหลักฐานจากหน่วยงานราชการหรือข้อมูลในระบบ ผู้กู้ขอผ่อนผันหรือปรับโครงสร้างหนี้ได้ โดยผู้ให้กู้พิจารณาตามระเบียบของตน การผ่อนผันต้องทำเป็นหนังสือและบันทึกในระบบ'));
  children.push(...clause(10, 'กรณีผู้ให้กู้หลายรายร่วมให้กู้', multi
    ? [`ผู้ให้กู้แต่ละรายมีสิทธิตามสัดส่วนวงเงินในข้อ 1 การชำระคืนทุกครั้งแบ่งให้ผู้ให้กู้ตามสัดส่วนยอดหนี้คงค้างของแต่ละรายโดยมีลำดับเท่าเทียมกัน (pari passu)`,
      'การผ่อนผัน การเรียกคืนก่อนกำหนด หรือการบังคับหลักประกัน ต้องได้รับความเห็นชอบจากผู้ให้กู้ที่มีสัดส่วนวงเงินรวมเกินกึ่งหนึ่ง เว้นแต่การระงับการเบิกจ่ายในส่วนของตน ซึ่งผู้ให้กู้แต่ละรายทำได้เอง']
    : 'สัญญานี้มีผู้ให้กู้รายเดียว หากภายหลังมีผู้ให้กู้รายอื่นร่วมให้กู้ ให้ทำบันทึกต่อท้ายสัญญากำหนดสัดส่วนและลำดับการรับชำระ'));
  children.push(...clause(11, 'การเปิดเผยและติดตามข้อมูล', 'ผู้กู้ยินยอมให้ผู้ให้กู้และกรมส่งเสริมสหกรณ์เข้าถึงข้อมูลการใช้เงิน การเบิกจ่าย ผลการดำเนินงาน และการชำระคืนตามหนังสือยินยอม (ภาคผนวก จ)'));
  children.push(...clause(12, 'การระงับข้อพิพาทและการแก้ไขสัญญา', [
    'ข้อพิพาทให้คู่สัญญาเจรจากันก่อน หากตกลงกันไม่ได้ภายใน 30 วัน ให้ขอให้นายทะเบียนสหกรณ์หรือกรมส่งเสริมสหกรณ์ไกล่เกลี่ย ก่อนนำคดีสู่ศาลที่มีเขตอำนาจ',
    'การแก้ไขเพิ่มเติมสัญญาต้องทำเป็นหนังสือลงนามโดยคู่สัญญาทุกฝ่าย และบันทึกฉบับแก้ไขในระบบ',
  ]));
  children.push(...clause(13, 'ผู้ให้บริการระบบ', 'บริษัท ภักดี คอร์ปอเรชั่น จำกัด (AgroLink) เป็นผู้ให้บริการระบบเท่านั้น ไม่เป็นคู่สัญญา ไม่ใช่ผู้ให้สินเชื่อ ไม่รับฝากเงิน และไม่ถือเงินของคู่สัญญา การตัดสินใจให้กู้และการรับความเสี่ยงเป็นของผู้ให้กู้'));
  const extra = lenders.filter((x) => x.offer.conditions || x.offer.collateral_required);
  if (extra.length) {
    children.push(...clause(14, 'เงื่อนไขเพิ่มเติมตามข้อเสนอของผู้ให้กู้', extra.flatMap((x) => [
      ...(x.offer.conditions ? [`${x.org.org_name}: ${x.offer.conditions}`] : []),
      ...(x.offer.collateral_required ? [`${x.org.org_name} — หลักประกันที่กำหนด: ${x.offer.collateral_required}`] : []),
    ])));
  }
  children.push(p('สัญญานี้ทำขึ้นเป็นหลายฉบับมีข้อความถูกต้องตรงกัน คู่สัญญาได้อ่านและเข้าใจข้อความโดยตลอดแล้ว จึงลงลายมือชื่อไว้เป็นสำคัญ', { indent: { firstLine: 567 }, spacing: { before: 200 } }));
  children.push(...signBlock('ผู้กู้', borrower.org.org_name, bp.signatories));
  lenders.forEach((x, i) => children.push(...signBlock(`ผู้ให้กู้${multi ? ` รายที่ ${i + 1}` : ''}`, x.org.org_name, x.profile && x.profile.signatories)));
  children.push(p(''), p(`ลงชื่อ ${blank(40)} พยาน`, { alignment: AlignmentType.RIGHT }), p(`ลงชื่อ ${blank(40)} พยาน`, { alignment: AlignmentType.RIGHT }));

  // ---------- ภาคผนวก ก ----------
  const dr = disbursementRows(listing);
  children.push(pageBreak(), h2('ภาคผนวก ก  ตารางการเบิกจ่าย'), p(dr.intro, { indent: { firstLine: 567 } }), table(dr.headers, dr.rows, dr.widths));
  if ((listing.use_plan || []).length && listing.project_type !== 'investment') {
    children.push(p('แผนการใช้เงินตามที่ผู้กู้เสนอ', { spacing: { before: 160 } }), table(['รายการ', 'จำนวนเงิน', 'ช่วงเวลา'], listing.use_plan.map((u) => [u.item || '', Number(u.amount || 0), u.timing || '']), [50, 25, 25]));
  }

  // ---------- ภาคผนวก ข ----------
  children.push(pageBreak(), h2('ภาคผนวก ข  ตารางการชำระคืน'));
  lenders.forEach((x, i) => {
    const sched = M.repaymentSchedule({ ...x.offer, amount: x.amount }, start);
    children.push(p([run(`${multi ? `ผู้ให้กู้รายที่ ${i + 1}: ` : ''}${x.org.org_name} — วงเงิน ${baht(x.amount)} ดอกเบี้ยร้อยละ ${num(x.offer.rate_pct)} ต่อปี`, { bold: true })], { spacing: { before: 120 } }));
    children.push(table(['งวด', 'กำหนดชำระ', 'เงินต้น', 'ดอกเบี้ย', 'รวม', 'คงเหลือ'], sched.map((r) => [String(r.seq), thDate(r.due_date), r.principal, r.interest, r.installment, r.balance]), [6, 20, 19, 17, 20, 18]));
  });
  children.push(p(`รับชำระเข้าบัญชีของผู้ให้กู้แต่ละรายที่แจ้งในระบบ ผ่านคำสั่งโอนจากบัญชีโครงการที่ต้องมีผู้จัดทำและผู้อนุมัติคนละคน`, { spacing: { before: 120 } }));

  // ---------- ภาคผนวก ค ----------
  const col = listing.collateral || [];
  children.push(pageBreak(), h2('ภาคผนวก ค  หลักประกันและการค้ำประกัน'));
  children.push(col.length ? table(['ลำดับ', 'ประเภท', 'รายละเอียด', 'มูลค่าประเมิน'], col.map((x, i) => [String(i + 1), x.kind || '', x.description || '', Number(x.value || 0)]), [8, 20, 52, 20])
    : p('ผู้กู้ไม่ได้เสนอหลักประกันในโครงการ — คู่สัญญาระบุเพิ่มเติม: ' + blank(40)));
  children.push(p('เงื่อนไขการบังคับหลักประกัน: เมื่อเกิดเหตุผิดนัดตามข้อ 8 และผู้กู้ไม่แก้ไขภายในเวลาที่แจ้ง ผู้ให้กู้มีสิทธิบังคับหลักประกันตามกฎหมาย โดยกรณีผู้ให้กู้หลายรายให้แบ่งเงินที่ได้ตามสัดส่วนยอดหนี้คงค้าง การจดทะเบียนหลักประกัน (ถ้ามี) ให้ทำตามกฎหมายที่เกี่ยวข้อง', { indent: { firstLine: 567 }, spacing: { before: 120 } }));

  // ---------- ภาคผนวก ง ----------
  children.push(pageBreak(), h2('ภาคผนวก ง  ข้อตกลงบัญชีโครงการ'));
  [
    `1. ผู้กู้เปิดบัญชีเฉพาะโครงการ${projectAccount ? ` (ธนาคาร${BANKS[projectAccount.bank_code] || projectAccount.bank_code} ชื่อบัญชี ${projectAccount.account_name})` : ''} ซึ่งระบบตรวจชื่อบัญชีตรงกับชื่อผู้กู้แล้ว และใช้เพื่อโครงการนี้เท่านั้น`,
    '2. เงินกู้ทุกงวดโอนเข้าบัญชีโครงการหรือโอนตรงถึงผู้รับเงิน การจ่ายออกจากบัญชีโครงการทำผ่านคำสั่งโอนในระบบที่มีผู้จัดทำและผู้อนุมัติคนละคน และต้องผูกกับรายการเบิกที่มีหลักฐานครบ',
    '3. รายได้จากโครงการ (เงินชำระคืนจากสมาชิก รายได้จากการจำหน่ายผลผลิต หรือรายได้ของธุรกิจใหม่) ให้นำเข้าบัญชีโครงการ และนำไปชำระหนี้ตามลำดับในข้อ 5 ของสัญญา',
    '4. ผู้กู้ยินยอมให้ระบบบันทึกเลขอ้างอิงธุรกรรมของธนาคารทุกรายการเพื่อการตรวจสอบย้อนหลัง และให้ผู้ให้กู้ดูยอดและรายการเคลื่อนไหวของบัญชีโครงการผ่านระบบ',
    '5. การปิดบัญชีโครงการทำได้เมื่อชำระหนี้ครบถ้วนแล้ว',
  ].forEach((t) => children.push(p(t)));
  children.push(...signBlock('ผู้กู้', borrower.org.org_name, bp.signatories));

  // ---------- ภาคผนวก จ ----------
  children.push(pageBreak(), h2('ภาคผนวก จ  หนังสือยินยอมเปิดเผยและติดตามข้อมูล'));
  [
    `ข้าพเจ้า ${borrower.org.org_name} ในฐานะผู้กู้ตามสัญญาเลขที่ ${agreement.agreement_no} ยินยอมให้`,
    `1. ผู้ให้กู้ตามสัญญานี้ (${lenders.map((x) => x.org.org_name).join(', ')}) เข้าถึงข้อมูลของผู้กู้ในระบบ AgroLink ได้แก่ ข้อมูลสหกรณ์ งบการเงิน ข้อมูลธุรกิจ หนี้สิน ทรัพย์สิน ผลการกำกับดูแล ข้อมูลแปลงเกษตรและภาพถ่ายดาวเทียมของแปลงที่ใช้ในโครงการ หลักฐานการเบิกจ่าย และผลการชำระคืน ตลอดอายุสัญญา`,
    '2. กรมส่งเสริมสหกรณ์เข้าถึงข้อมูลธุรกรรมของสัญญานี้เพื่อกำกับ ส่งเสริม และติดตามตามอำนาจหน้าที่',
    '3. ข้อมูลส่วนบุคคลของสมาชิกที่เกี่ยวข้องให้เปิดเผยเท่าที่จำเป็นต่อการตรวจสอบการใช้เงิน และปฏิบัติตามกฎหมายว่าด้วยการคุ้มครองข้อมูลส่วนบุคคล ผู้กู้รับรองว่าได้รับความยินยอมจากสมาชิกแล้ว',
    '4. ความยินยอมนี้มีผลจนกว่าจะชำระหนี้ตามสัญญาครบถ้วน และไม่กระทบสิทธิของเจ้าของข้อมูลตามกฎหมาย',
  ].forEach((t) => children.push(p(t)));
  children.push(...signBlock('ผู้ให้ความยินยอม', borrower.org.org_name, bp.signatories));

  // ---------- ภาคผนวก ฉ ----------
  children.push(pageBreak(), h2('ภาคผนวก ฉ  รายการเอกสารแนบ'));
  const docRows = [
    ['1', 'สำเนามติที่ประชุมของผู้กู้ที่อนุมัติให้กู้', listing.resolution_file_id || documents.some((d) => d.kind === 'resolution') ? 'มีในระบบ' : 'ต้องแนบ'],
    ...lenders.map((x, i) => [String(i + 2), `สำเนามติ/บันทึกอนุมัติของ ${x.org.org_name}${x.offer.approval_ref ? ` (เลขที่ ${x.offer.approval_ref})` : ''}`, x.profile && x.profile.resolution_file_id ? 'มีในระบบ' : 'ต้องแนบ']),
    ...documents.map((d, i) => [String(lenders.length + 2 + i), `${DOC_KIND_TH[d.kind] || d.kind}: ${d.title}`, 'มีในระบบ']),
  ];
  children.push(table(['ลำดับ', 'เอกสาร', 'สถานะ'], docRows, [10, 70, 20]));
  children.push(p(`ข้อมูลที่ใช้จัดทำเอกสาร: ข้อมูลผู้กู้ ณ ${thDate(bp.data_as_of)} · ข้อตกลงที่บันทึกในระบบ ณ ${thDate(L.todayBangkok())} · ฉบับที่ ${agreement.doc_version}`, { spacing: { before: 160 } }));

  const doc = new Document({
    creator: 'AgroLink', title: `สัญญากู้ยืมเงินระหว่างสหกรณ์ ${agreement.agreement_no}`,
    styles: {
      default: { document: { run: { font: { ascii: FONT, hAnsi: FONT, cs: FONT, eastAsia: FONT }, size: 32 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 40, bold: true }, paragraph: { outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 34, bold: true }, paragraph: { outlineLevel: 1 } },
      ],
    },
    numbering: { config: [{ reference: 'none', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT }] }] },
    sections: [{
      properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [run('ร่างเอกสารที่ระบบ AgroLink จัดทำจากแม่แบบมาตรฐาน — คู่สัญญาแต่ละฝ่ายต้องให้ที่ปรึกษากฎหมายตรวจทานก่อนลงนาม', { size: 22, color: '8A5A00' })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [run(`สัญญาเลขที่ ${agreement.agreement_no} · หน้า `, { size: 22 }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 22 })] })] }) },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildAgreementDocx, disbursementRows };
