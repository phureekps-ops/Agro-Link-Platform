const L = require('./coopLending');
const M = require('./coopMarket');

const { round2 } = L;
const n = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const fmt = (v) => Number(v).toLocaleString('th-TH', { maximumFractionDigits: 2 });

/**
 * ชั้นควบคุมของตลาดสินเชื่อระหว่างสหกรณ์ตาม Master Blueprint 2026–2027 (pure — ไม่แตะฐานข้อมูล ทดสอบได้ตรง ๆ)
 *  - ข้อ 5.2  Regulatory Compliance Engine: ตรวจผู้ให้กู้ 8 ข้อก่อนยื่น/ยืนยันข้อเสนอ
 *  - ข้อ 6    คะแนนโครงการ (Project Credit Score) และคะแนนผลการดำเนินงานระหว่างสัญญา (Activity Performance Score)
 *  - ข้อ 7.2  งวดเบิกตามกิจกรรม: งวดถัดไปเปิดเมื่อผู้ให้กู้ตรวจปิดยอดงวดก่อน ("No Verification, No Disbursement")
 *  - ข้อ 8.2  ระดับความน่าเชื่อถือของหลักฐาน 1–5
 *  - ข้อ 18   Go-live Gate G1–G8: ไม่เปิดโอนเงินจริงจนกว่าจะผ่านครบ
 */

// ---------------------------------------------------------------------------
// 5.2 Regulatory Compliance Engine
// ---------------------------------------------------------------------------
/** เอกสารที่ผู้ดูแลแพลตฟอร์มตรวจ (ผ่าน/ไม่ผ่าน) */
const DOC_CHECKS = [
  ['registration', 'สถานะจดทะเบียน', 'หนังสือรับรองการจดทะเบียนสหกรณ์ / ผลตรวจสถานะจากนายทะเบียน'],
  ['bylaws', 'ข้อบังคับและวัตถุประสงค์', 'ข้อบังคับที่ให้อำนาจให้สหกรณ์อื่นกู้ (พ.ร.บ.สหกรณ์ มาตรา 46(8))'],
  ['lending_regulation', 'ระเบียบการให้สหกรณ์อื่นกู้', 'ระเบียบว่าด้วยการให้สหกรณ์อื่นกู้ยืมเงินที่นายทะเบียนเห็นชอบ'],
  ['board_resolution', 'มติคณะกรรมการ', 'มติที่อนุญาตให้นำเงินให้สหกรณ์อื่นกู้ และวงเงินที่จัดสรร'],
  ['signatories', 'ผู้มีอำนาจลงนาม', 'รายชื่อและหลักฐานผู้มีอำนาจลงนามผูกพันสหกรณ์'],
];
/** คำนวณจากข้อมูลผู้ให้กู้และข้อเสนอแต่ละรายการ */
const CALC_CHECKS = [
  ['approved_limit', 'วงเงินที่ได้รับอนุมัติ'],
  ['liquidity', 'สภาพคล่องหลังปล่อยกู้'],
  ['large_exposure', 'เพดานลูกหนี้รายใหญ่'],
];
const CHECK_ORDER = ['registration', 'bylaws', 'lending_regulation', 'board_resolution', 'approved_limit', 'liquidity', 'large_exposure', 'signatories'];
const CHECK_LABEL = Object.fromEntries([...DOC_CHECKS, ...CALC_CHECKS].map(([k, l]) => [k, l]));

/**
 * docRows: lender_compliance rows · profile: lender_profile · exposure: { total, borrower } (ไม่รวมข้อเสนอนี้)
 * amount: วงเงินข้อเสนอ (null = ตรวจเฉพาะเอกสาร) · settings: { large_exposure_pct, large_exposure_min_assets }
 * คืน { ok, docs_ok, checks:[{code,label,status:'pass'|'fail'|'pending',detail}] }
 */
function complianceStatus(docRows, profile, exposure, amount, settings, today = L.todayBangkok()) {
  const byCode = new Map((docRows || []).map((r) => [r.check_code, r]));
  const checks = [];
  for (const [code, label] of DOC_CHECKS) {
    const r = byCode.get(code);
    let status = 'fail'; let detail = 'ยังไม่ได้ส่งเอกสาร';
    if (r) {
      const expired = r.valid_until && L.toDateStr(r.valid_until) < today;
      if (r.status === 'Pass' && !expired) { status = 'pass'; detail = `ผู้ดูแลตรวจแล้ว${r.valid_until ? ` · ใช้ได้ถึง ${L.toDateStr(r.valid_until)}` : ''}`; } else if (r.status === 'Pass' && expired) { detail = 'หมดอายุ — ส่งเอกสารฉบับปัจจุบัน'; } else if (r.status === 'Fail') { detail = `ไม่ผ่าน: ${r.review_note || ''}`.trim(); } else { status = 'pending'; detail = 'รอผู้ดูแลแพลตฟอร์มตรวจ'; }
    }
    checks.push({ code, label, status, detail });
  }
  const p = profile || {};
  const fin = [...(p.financials || [])].filter((f) => f && f.year).sort((a, b) => Number(b.year) - Number(a.year))[0] || {};
  const amt = n(amount);
  const ex = exposure || { total: 0, borrower: 0 };
  // วงเงินที่ได้รับอนุมัติ (มติ/ระเบียบ)
  if (n(p.allocatable_amount) === null) checks.push({ code: 'approved_limit', label: CHECK_LABEL.approved_limit, status: 'fail', detail: 'ยังไม่ได้ระบุวงเงินที่จัดสรรให้สหกรณ์อื่นกู้' });
  else {
    const after = ex.total + (amt || 0);
    checks.push({
      code: 'approved_limit', label: CHECK_LABEL.approved_limit, status: after <= Number(p.allocatable_amount) + 0.004 ? 'pass' : 'fail',
      detail: `${amt ? 'รวมข้อเสนอนี้' : 'ใช้ไปแล้ว'} ${fmt(after)} จากวงเงิน ${fmt(p.allocatable_amount)} บาท`,
    });
  }
  // สภาพคล่องหลังปล่อยกู้ (พ.ร.บ.สหกรณ์ มาตรา 48 — ประมาณการจากงบล่าสุด)
  const liquid = n(fin.liquid_assets); const required = n(fin.liquidity_required);
  if (liquid === null || required === null) checks.push({ code: 'liquidity', label: CHECK_LABEL.liquidity, status: 'fail', detail: 'ยังไม่ได้กรอกสินทรัพย์สภาพคล่องและสภาพคล่องที่ต้องดำรงในงบล่าสุด' });
  else {
    const after = liquid - (ex.pending || 0) - (amt || 0);
    checks.push({
      code: 'liquidity', label: CHECK_LABEL.liquidity, status: after >= required ? 'pass' : 'fail',
      detail: `คงเหลือหลังปล่อยกู้ (ประมาณการ) ${fmt(after)} · ต้องดำรง ${fmt(required)} บาท`,
    });
  }
  // เพดานลูกหนี้รายใหญ่: สหกรณ์ที่สินทรัพย์ถึงเกณฑ์ ให้สหกรณ์อื่นกู้แต่ละแห่งไม่เกิน x% ของทุนเรือนหุ้น + ทุนสำรอง (ค่าตั้งได้ในหน้าผู้ดูแล)
  const s = settings || {};
  const pctCap = n(s.large_exposure_pct) ?? 10;
  const minAssets = n(s.large_exposure_min_assets) ?? 5e9;
  const ta = n(fin.total_assets);
  if (ta === null) checks.push({ code: 'large_exposure', label: CHECK_LABEL.large_exposure, status: 'fail', detail: 'ยังไม่ได้กรอกสินทรัพย์รวมในงบล่าสุด' });
  else if (ta < minAssets) checks.push({ code: 'large_exposure', label: CHECK_LABEL.large_exposure, status: 'pass', detail: `สินทรัพย์ ${fmt(ta)} ต่ำกว่า ${fmt(minAssets)} บาท — ใช้เพดานตามระเบียบของสหกรณ์` });
  else {
    const base = (n(fin.share_capital) || 0) + (n(fin.reserve) || 0);
    if (!base) checks.push({ code: 'large_exposure', label: CHECK_LABEL.large_exposure, status: 'fail', detail: 'ยังไม่ได้กรอกทุนเรือนหุ้นและทุนสำรอง' });
    else {
      const cap = round2((base * pctCap) / 100);
      const after = ex.borrower + (amt || 0);
      checks.push({
        code: 'large_exposure', label: CHECK_LABEL.large_exposure, status: after <= cap + 0.004 ? 'pass' : 'fail',
        detail: `ลูกหนี้รายนี้รวม ${fmt(after)} · เพดาน ${pctCap}% ของทุนเรือนหุ้น+ทุนสำรอง = ${fmt(cap)} บาท`,
      });
    }
  }
  checks.sort((a, b) => CHECK_ORDER.indexOf(a.code) - CHECK_ORDER.indexOf(b.code));
  return {
    ok: checks.every((c) => c.status === 'pass'),
    docs_ok: checks.filter((c) => DOC_CHECKS.some(([k]) => k === c.code)).every((c) => c.status === 'pass'),
    passed: checks.filter((c) => c.status === 'pass').length,
    checks,
  };
}

// ---------------------------------------------------------------------------
// 8.2 ระดับความน่าเชื่อถือของหลักฐาน
// ---------------------------------------------------------------------------
const LEVELS = {
  0: 'ยังไม่มีหลักฐาน',
  1: 'เอกสารที่สหกรณ์ส่งเข้าระบบ',
  2: 'ยืนยันกับคู่ค้า/สมาชิก',
  3: 'ข้อมูลธุรกรรมจากธนาคาร',
  4: 'ข้อมูลจาก IoT/ระบบภาคสนาม',
  5: 'ตรวจโดยบุคคลหรือหน่วยงานอิสระ',
};
/**
 * item: disbursement_item · ctx: { evidence: n, sellerPaidByBank: bool, fieldData: [string], inspection: {result} }
 * ระดับ = ระดับสูงสุดที่ได้จากแหล่งที่ตรวจสอบได้จริง — มีแต่ไฟล์/รูป ได้ไม่เกินระดับ 1
 */
function verificationLevel(item, ctx = {}) {
  const sources = [];
  if (ctx.evidence > 0) sources.push({ level: 1, source: `ไฟล์หลักฐาน ${ctx.evidence} รายการ` });
  if (item.farmer_confirmed_at) sources.push({ level: 2, source: 'สมาชิก/เกษตรกรยืนยันในแอป' });
  if (['product_order', 'machinery_booking', 'asset_loan'].includes(item.source_type)) sources.push({ level: 2, source: 'รายการยืนยันโดยผู้ขายในระบบ' });
  if (ctx.sellerPaidByBank) sources.push({ level: 3, source: 'โอนเงินให้ผู้ขายผ่านธนาคารสำเร็จ' });
  if (item.satellite_result === 'pass') sources.push({ level: 4, source: 'ภาพดาวเทียมยืนยันกิจกรรมในแปลง' });
  (ctx.fieldData || []).forEach((s) => sources.push({ level: 4, source: s }));
  if (ctx.inspection && ctx.inspection.result === 'pass') sources.push({ level: 5, source: `ผู้ตรวจอิสระ: ${ctx.inspection.inspector || ''}`.trim() });
  const level = sources.reduce((a, s) => Math.max(a, s.level), 0);
  return { level, label: LEVELS[level], sources };
}

// ---------------------------------------------------------------------------
// 7.2 งวดเบิกตามกิจกรรม
// ---------------------------------------------------------------------------
/** แผนการใช้เงิน → งวด (ตามลำดับ) ปรับสัดส่วนเมื่อได้วงเงินไม่เต็มที่ขอ */
function tranchePlan(listing, totalAmount) {
  const plan = (listing.use_plan || []).filter((u) => Number(u.amount) > 0);
  const total = Number(totalAmount);
  if (!plan.length) return [{ seq: 1, name: listing.title || 'งวดเดียว', amount: round2(total), timing: null }];
  const sum = plan.reduce((a, u) => a + Number(u.amount), 0);
  const out = plan.map((u, i) => ({ seq: i + 1, name: String(u.item).slice(0, 200), amount: round2((Number(u.amount) / sum) * total), timing: u.timing || null }));
  const drift = round2(total - out.reduce((a, t) => a + t.amount, 0));
  out[out.length - 1].amount = round2(out[out.length - 1].amount + drift);
  return out;
}
/**
 * ปิดยอดงวด (ข้อ 7.2 "ก่อนจ่ายงวดถัดไปต้องตรวจสอบ"): items ของงวด + ข้อมูลที่ผู้กู้กรอก + ข้อมูลโคนม (ถ้ามี)
 * คืน { ready, blockers:[...], summary }
 */
function trancheReconciliation(tranche, items, input = {}, extra = {}) {
  const live = items.filter((i) => !['Rejected', 'Cancelled'].includes(i.status));
  const blockers = [];
  const pending = live.filter((i) => !['Paid', 'Disputed'].includes(i.status));
  if (!live.length) blockers.push('ยังไม่มีรายการเบิกในงวดนี้');
  if (pending.length) blockers.push(`ยังมี ${pending.length} รายการที่ยังไม่ได้จ่ายผู้ขาย`);
  const paid = live.filter((i) => i.status === 'Paid');
  const levels = paid.map((i) => Number(i.verification_level) || 0);
  const kg = live.reduce((a, i) => a + (i.price_check && i.price_check.quantity_kg ? Number(i.price_check.quantity_kg) : 0), 0);
  const summary = {
    items: live.length,
    paid_items: paid.length,
    paid_amount: round2(paid.reduce((a, i) => a + Number(i.amount), 0)),
    tranche_amount: Number(tranche.amount),
    sellers: new Set(live.map((i) => i.seller_id)).size,
    farmer_sellers: new Set(live.filter((i) => i.seller_type === 'farmer').map((i) => i.seller_id)).size,
    weighed_kg: round2(kg),
    bank_paid_items: paid.filter((i) => (Number(i.verification_level) || 0) >= 3 || i.paid_at).length,
    disputed: live.filter((i) => i.status === 'Disputed').length,
    min_level: levels.length ? Math.min(...levels) : 0,
    avg_level: levels.length ? round2(levels.reduce((a, b) => a + b, 0) / levels.length) : 0,
    inventory_kg: n(input.inventory_kg),
    inventory_value: n(input.inventory_value),
    sales_amount: n(input.sales_amount),
    overdue_items: Number(extra.overdue_items) || 0,
    dairy: extra.dairy || null,
  };
  if (summary.disputed) blockers.push(`มีรายการที่ถูกโต้แย้ง ${summary.disputed} รายการ`);
  if (summary.inventory_kg === null && summary.weighed_kg > 0) blockers.push('ยังไม่ได้รายงานสินค้าคงเหลือ');
  if (summary.overdue_items) blockers.push(`มีเงินต้นค้างชำระเกินกำหนด ${summary.overdue_items} รายการ`);
  // สินค้าคงเหลือ + ขายแล้วไม่ควรเกินที่รับซื้อ (กันตัวเลขเกินจริง)
  if (summary.weighed_kg > 0 && summary.inventory_kg !== null && summary.inventory_kg > summary.weighed_kg * 1.02) {
    blockers.push(`สินค้าคงเหลือ ${fmt(summary.inventory_kg)} กก. มากกว่าที่รับซื้อในงวด ${fmt(summary.weighed_kg)} กก.`);
  }
  return { ready: blockers.length === 0, blockers, summary };
}

// ---------------------------------------------------------------------------
// 6.2 Project Credit Score
// ---------------------------------------------------------------------------
/**
 * listing + docs + ctx { platform:{members_on_platform, plots, deliveries}, dairy:{days, accepted_kg, farms, ...}|null }
 * 6 ปัจจัย: ความเป็นไปได้ 20 · ตลาด/ผู้ซื้อ 20 · กระแสเงินสด 20 · หลักฐานกิจกรรมจริง 20 · หลักประกันและการควบคุม 10 · ความเสี่ยงด้านราคา 10
 */
function projectScore(listing, docs = [], ctx = {}) {
  const d = listing.details || {};
  const amount = Number(listing.amount_requested);
  const has = (k) => docs.some((x) => x.kind === k);
  const risk = M.projectRisk(listing);
  const ind = (k) => risk.indicators.find((x) => x.key === k);
  const factors = [];
  const add = (key, label, max, points, note) => factors.push({ key, label, max, points: Math.max(0, Math.min(max, Math.round(points))), note });
  const t = listing.project_type;

  if (t === 'investment') {
    const dscr = ind('dscr'); const pb = ind('payback');
    add('feasibility', 'ความเป็นไปได้ทางธุรกิจ', 20, (d.business_plan || has('business_plan') ? 6 : 0) + (dscr && dscr.ok ? 8 : dscr && dscr.value >= 1 ? 4 : 0) + (pb && pb.ok ? 6 : 0), 'แผนธุรกิจ · DSCR · ระยะคืนทุน');
    add('market', 'ตลาดและผู้ซื้อ', 20, ((d.projections || []).some((p) => n(p.revenue) > 0) ? 10 : 0) + (has('buyer_contract') ? 10 : 0), 'ประมาณการรายได้ · สัญญาซื้อขาย');
  } else if (t === 'procurement') {
    const vv = ind('volume_value');
    add('feasibility', 'ความเป็นไปได้ทางธุรกิจ', 20, (vv && vv.ok ? 10 : 0) + (d.history && String(d.history).trim() ? 10 : 0), 'มูลค่ารับซื้อตามแผน · ประวัติการรับซื้อ');
    add('market', 'ตลาดและผู้ซื้อ', 20, (d.end_buyers && String(d.end_buyers).trim() ? 10 : 0) + (has('buyer_contract') ? 10 : 0), 'ผู้ซื้อปลายทาง · สัญญาซื้อขาย');
  } else {
    const mr = ind('member_repay');
    add('feasibility', 'ความเป็นไปได้ทางธุรกิจ', 20, (mr && mr.ok ? 10 : n(d.member_repayment_pct) >= 80 ? 5 : 0) + (d.production_plan || has('production_plan') ? 10 : 0), 'ผลชำระของสมาชิก · แผนการผลิต');
    add('market', 'ตลาดและผู้ซื้อ', 20, (n(d.members_count) ? 8 : 0) + (n(d.area_rai) || n(d.plots_count) ? 6 : 0) + (has('member_list') ? 6 : 0), 'สมาชิกผู้กู้ · พื้นที่ปลูก · รายชื่อสมาชิก');
  }
  let cash = (listing.repayment_plan && String(listing.repayment_plan).trim().length >= 10 ? 5 : 0) + (listing.repayment_source && String(listing.repayment_source).trim() ? 5 : 0);
  if (t === 'investment') { const x = ind('dscr'); cash += x && x.ok ? 10 : x && x.value >= 1 ? 5 : 0; }
  if (t === 'procurement') {
    const months = d.period_from && d.period_to ? (Date.parse(d.period_to) - Date.parse(d.period_from)) / (30.44 * 864e5) : null;
    cash += months !== null && months + 2 <= listing.tenor_months ? 10 : months !== null ? 4 : 0;
  }
  if (t === 'member_onlending') { const x = ind('coverage'); cash += x && x.ok ? 10 : 4; }
  add('cashflow', 'กระแสเงินสด', 20, cash, 'แผนชำระคืน · แหล่งชำระ · ความสามารถชำระของโครงการ');

  const pf = ctx.platform || {};
  let act = 0; const actNote = [];
  if (ctx.dairy && Number(ctx.dairy.accepted_kg) > 0) { act = 20; actNote.push(`ข้อมูลรับน้ำนมจริง ${fmt(ctx.dairy.accepted_kg)} กก. ใน ${ctx.dairy.days} วัน`); } else {
    if (Number(pf.members_on_platform) > 0) { act += 8; actNote.push(`สมาชิกในระบบ ${pf.members_on_platform} ราย`); }
    if (Number(pf.plots) > 0) { act += 6; actNote.push(`แปลงที่ติดตามได้ ${pf.plots} แปลง`); }
    if (Number(pf.deliveries) > 0) { act += 6; actNote.push(`ประวัติรับซื้อผลผลิตในระบบ ${pf.deliveries} รายการ`); }
  }
  add('activity', 'หลักฐานกิจกรรมจริง', 20, act, actNote.join(' · ') || 'ยังไม่มีข้อมูลกิจกรรมในระบบ');

  const coll = (listing.collateral || []).reduce((a, x) => a + (n(x.value) || 0), 0);
  const tranches = (listing.use_plan || []).filter((u) => Number(u.amount) > 0).length;
  add('control', 'หลักประกันและการควบคุม', 10, (coll >= amount * 0.5 ? 5 : coll > 0 ? 3 : 0) + (tranches >= 2 ? 5 : 2), `หลักประกัน ${fmt(coll)} บาท · แบ่งเบิก ${Math.max(1, tranches)} งวด`);
  let price = 6;
  if (t === 'procurement') price = (n(d.reference_price) && d.commodity ? 5 : 0) + (has('buyer_contract') ? 5 : 0);
  if (t === 'investment') price = (d.projections || []).length >= 3 ? 8 : 4;
  add('price', 'ความเสี่ยงด้านราคา', 10, price, t === 'procurement' ? 'ราคาอ้างอิง · สัญญาซื้อขายล่วงหน้า' : 'ความผันผวนของราคาที่มีผลต่อการชำระคืน');

  const score = factors.reduce((a, f) => a + f.points, 0);
  const [, grade, guidance] = M.gradeOf(score);
  return { score, grade, guidance, factors };
}

// ---------------------------------------------------------------------------
// 6.3 Activity Performance Score (ระหว่างสัญญา)
// ---------------------------------------------------------------------------
/** ctx: { tranches:[{status, opened_at}], items:[{status, verification_level}], reports:[{revenue, planned_revenue}], overdue_now, late_events, today } */
function performanceScore(ctx) {
  const today = ctx.today || L.todayBangkok();
  const factors = [];
  const add = (key, label, points, note) => factors.push({ key, label, max: 20, points: Math.max(0, Math.min(20, Math.round(points))), note });
  const tr = ctx.tranches || [];
  const due = tr.filter((t) => t.status === 'Verified' || (t.opened_at && (Date.parse(`${today}T00:00:00Z`) - new Date(t.opened_at).getTime()) / 864e5 > 90));
  const onPlan = due.filter((t) => t.status === 'Verified').length;
  add('plan', 'ดำเนินกิจกรรมตามแผน', due.length ? (onPlan / due.length) * 20 : 20, due.length ? `ปิดยอดแล้ว ${onPlan} จาก ${due.length} งวดที่ถึงรอบ` : 'ยังไม่ถึงรอบตรวจ');
  const items = (ctx.items || []).filter((i) => i.status !== 'Cancelled');
  const bad = items.filter((i) => ['Rejected', 'Disputed'].includes(i.status)).length;
  add('purpose', 'เบิกจ่ายตรงวัตถุประสงค์', items.length ? (1 - bad / items.length) * 20 : 20, items.length ? `ถูกปฏิเสธ/โต้แย้ง ${bad} จาก ${items.length} รายการ` : 'ยังไม่มีรายการเบิก');
  const paid = items.filter((i) => i.status === 'Paid');
  const avg = paid.length ? paid.reduce((a, i) => a + (Number(i.verification_level) || 0), 0) / paid.length : null;
  add('real', 'มีสินค้าและผลผลิตจริง', avg === null ? 10 : (avg / 5) * 20, avg === null ? 'ยังไม่มีรายการที่จ่ายแล้ว (กลาง)' : `ระดับหลักฐานเฉลี่ย ${round2(avg)} จาก 5`);
  const rep = (ctx.reports || []).filter((r) => n(r.planned_revenue) > 0 && n(r.revenue) !== null);
  const last = rep[0];
  const ratio = last ? Number(last.revenue) / Number(last.planned_revenue) : null;
  add('revenue', 'มีรายได้ตามแผน', ratio === null ? 10 : ratio >= 0.9 ? 20 : ratio >= 0.7 ? 12 : 5, ratio === null ? 'ยังไม่มีรายงานผล (กลาง)' : `รายได้ ${round2(ratio * 100)}% ของแผน`);
  add('repay', 'ชำระคืนตามกำหนด', Number(ctx.overdue_now) > 0 ? 0 : Number(ctx.late_events) > 0 ? 10 : 20,
    Number(ctx.overdue_now) > 0 ? `ค้างชำระ ${ctx.overdue_now} รายการ` : Number(ctx.late_events) > 0 ? `เคยชำระช้า ${ctx.late_events} ครั้ง` : 'ตรงตามกำหนด');
  const score = factors.reduce((a, f) => a + f.points, 0);
  const [, grade, guidance] = M.gradeOf(score);
  return { score, grade, guidance, factors };
}

// ---------------------------------------------------------------------------
// 18 Go-live Gates
// ---------------------------------------------------------------------------
const GATES = [
  ['G1', 'Legal Opinion ยืนยันรูปแบบธุรกรรม', 'global'],
  ['G2', 'ผู้ให้กู้มีระเบียบและอำนาจให้กู้', 'lender'],
  ['G3', 'ผู้ขอกู้ผ่านการตรวจสอบ', 'borrower'],
  ['G4', 'มีสัญญากู้และสัญญาบริการ', 'global'],
  ['G5', 'ระบบบัญชีและธนาคารพร้อม', 'global'],
  ['G6', 'ระบบ Digital Verification ผ่านการทดสอบ', 'global'],
  ['G7', 'ระบบ Cybersecurity และ Audit พร้อม', 'global'],
  ['G8', 'คณะกรรมการ Pilot อนุมัติเริ่มโครงการ', 'global'],
];
/** gateRows: golive_gate · lenderOk/borrowerOk: ผลรายสหกรณ์ (G2/G3) — คืน { ok, gates:[{code,title,scope,status}] } */
function goLiveStatus(gateRows, { lenderOk = null, borrowerOk = null } = {}) {
  const by = new Map((gateRows || []).map((r) => [r.code, r]));
  const gates = GATES.map(([code, title, scope]) => {
    const r = by.get(code) || {};
    let status = r.status === 'Pass' ? 'pass' : r.status === 'Fail' ? 'fail' : 'pending';
    if (scope === 'lender' && lenderOk !== null && status === 'pass') status = lenderOk ? 'pass' : 'fail';
    if (scope === 'borrower' && borrowerOk !== null && status === 'pass') status = borrowerOk ? 'pass' : 'fail';
    return { code, title, scope, status, note: r.note || null, decided_by: r.decided_by || null, decided_at: r.decided_at || null };
  });
  return { ok: gates.every((g) => g.status === 'pass'), passed: gates.filter((g) => g.status === 'pass').length, gates };
}

module.exports = {
  DOC_CHECKS, CALC_CHECKS, CHECK_LABEL, complianceStatus, LEVELS, verificationLevel, tranchePlan, trancheReconciliation,
  projectScore, performanceScore, GATES, goLiveStatus,
};
