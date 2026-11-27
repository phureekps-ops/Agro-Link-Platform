/**
 * ตลาดสินเชื่อระหว่างสหกรณ์ (backend/db/grant_coop_lending_marketplace.sql) — pure function ทดสอบได้โดยไม่ต้องมีฐานข้อมูล
 *
 *   creditScore()      คะแนนความน่าเชื่อถือของสหกรณ์ผู้ขอกู้ 0–100 + เกรด A–E พร้อมคำอธิบายทุกปัจจัย (โปร่งใส ไม่ใช่กล่องดำ)
 *   projectRisk()      ตัวชี้วัดของโครงการ (DSCR ของโครงการลงทุน, ผลชำระสมาชิก, ผู้ซื้อปลายทาง)
 *   listingChecks()    ความครบถ้วนก่อนส่งตรวจ/ประกาศ ตามประเภทโครงการ
 *   policyMatch()      โครงการตรงนโยบายสินเชื่อของผู้ให้กู้หรือไม่ (ใช้กรองและแจ้งเตือน)
 *   exposureWarnings() แจ้งเตือนเมื่อข้อเสนอทำให้เกินเงินที่จัดสรรได้ / เพดานต่อผู้กู้ ต่อจังหวัด ต่อประเภทโครงการ
 *   repaymentSchedule() ตารางชำระคืนตามข้อเสนอ (ผ่อนเป็นงวด หรือชำระเงินต้นครั้งเดียว) สมมติเบิกเต็มวงเงินวันเริ่มสัญญา
 */
const L = require('./coopLending');

const { round2 } = L;

const PROJECT_TYPES = {
  member_onlending: { name_th: 'กู้เพื่อปล่อยกู้ต่อแก่สมาชิก', purposes: ['inputs', 'machinery_service'], tranche_days: 180 },
  procurement: { name_th: 'ทุนหมุนเวียนรับซื้อผลผลิต', purposes: ['procurement'], tranche_days: 120 },
  investment: { name_th: 'ลงทุนโครงการใหม่ของสหกรณ์', purposes: ['asset', 'inputs'], tranche_days: 365 },
};
// ระดับความเสี่ยงตาม Master Blueprint ข้อ 6.4 (เกณฑ์ต้นแบบเพื่อทดสอบ ไม่ใช่เกณฑ์อนุมัติแทนคณะกรรมการผู้ให้กู้)
const GRADES = ['A', 'B', 'C', 'D'];
const GRADE_BANDS = [[85, 'A', 'พิจารณาตามปกติ'], [70, 'B', 'พิจารณาพร้อมมาตรการควบคุม'], [55, 'C', 'ต้องเพิ่มหลักฐานและลดวงเงิน'], [0, 'D', 'ไม่แนะนำให้อนุมัติ']];
const gradeOf = (score) => GRADE_BANDS.find(([min]) => score >= min);
/** เกรดเดิม E (ก่อนปรับเกณฑ์) = D */
const normGrade = (g) => (g === 'E' ? 'D' : g);
const GOV_POINTS = { excellent: 10, very_good: 8, good: 6, pass: 4, fail: 0 };
const GOV_TH = { excellent: 'ดีเลิศ', very_good: 'ดีมาก', good: 'ดี', pass: 'ผ่านมาตรฐาน', fail: 'ไม่ผ่านมาตรฐาน' };
const AUDIT_POINTS = { unqualified: 10, qualified: 5, adverse: 0, disclaimer: 0 };
const AUDIT_TH = { unqualified: 'ไม่มีเงื่อนไข', qualified: 'มีเงื่อนไข', adverse: 'ไม่ถูกต้อง', disclaimer: 'ไม่แสดงความเห็น' };

const n = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const pct = (v) => `${round2(v * 100)}%`;
const monthsBetween = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / (30.44 * 864e5);

/**
 * คะแนนความน่าเชื่อถือของสหกรณ์ผู้ขอกู้ (Cooperative Credit Score) — 5 กลุ่มตาม Master Blueprint ข้อ 6.1
 *   ฐานะทางการเงิน 25 · ความสามารถชำระหนี้ 25 · ธรรมาภิบาล 20 · ประวัติการชำระหนี้ 15 · ความเข้มแข็งทางธุรกิจ 15
 * profile: borrower_profile · history: { facilities, overdue_now, late_events }
 * คืน { score, grade, guidance, groups:[{key,label,max,points}], factors:[{key, group, label, points, max, value, note}], completeness_pct, data_as_of, stale }
 */
const SCORE_GROUPS = [
  ['financial', 'ฐานะทางการเงิน', 25], ['capacity', 'ความสามารถชำระหนี้', 25], ['governance', 'ธรรมาภิบาล', 20],
  ['repayment', 'ประวัติการชำระหนี้', 15], ['business', 'ความเข้มแข็งทางธุรกิจ', 15],
];
function creditScore(profile, history = {}, today = L.todayBangkok()) {
  const fin = [...(profile.financials || [])].filter((f) => f && f.year).sort((a, b) => Number(b.year) - Number(a.year));
  const last = fin[0] || {};
  const prev = fin[1] || {};
  const factors = [];
  const add = (group, key, label, max, points, value, note) => factors.push({ group, key, label, max, points: Math.max(0, Math.min(max, points)), value, note });

  // ---- ฐานะทางการเงิน 25
  const ta = n(last.total_assets); const tl = n(last.total_liabilities);
  const eq = n(last.equity) ?? (ta !== null && tl !== null ? ta - tl : null);
  if (ta && eq !== null) {
    const r = eq / ta;
    add('financial', 'equity_ratio', 'ทุนต่อสินทรัพย์', 12, r >= 0.4 ? 12 : r >= 0.25 ? 9 : r >= 0.15 ? 5 : 1, pct(r), 'เกณฑ์: ≥40% เต็ม, 25–40% ดี, 15–25% พอใช้');
  } else add('financial', 'equity_ratio', 'ทุนต่อสินทรัพย์', 12, 0, null, 'ไม่มีข้อมูลงบการเงิน');
  const ca = n(last.current_assets); const cl = n(last.current_liabilities);
  if (ca !== null && cl) {
    const r = ca / cl;
    add('financial', 'current_ratio', 'สภาพคล่อง (สินทรัพย์หมุนเวียน/หนี้สินหมุนเวียน)', 8, r >= 1.5 ? 8 : r >= 1 ? 6 : r >= 0.8 ? 3 : 0, `${round2(r)} เท่า`, 'เกณฑ์: ≥1.5 เต็ม, 1.0–1.5 ดี');
  } else add('financial', 'current_ratio', 'สภาพคล่อง (สินทรัพย์หมุนเวียน/หนี้สินหมุนเวียน)', 8, 0, null, 'ไม่มีข้อมูล');
  const ni = n(last.net_income);
  if (ta && ni !== null) {
    const r = ni / ta;
    add('financial', 'roa', 'กำไรสุทธิต่อสินทรัพย์', 5, r >= 0.03 ? 5 : r >= 0.01 ? 4 : r > 0 ? 2 : 0, pct(r), 'เกณฑ์: ≥3% เต็ม, ขาดทุน = 0');
  } else add('financial', 'roa', 'กำไรสุทธิต่อสินทรัพย์', 5, 0, null, 'ไม่มีข้อมูล');

  // ---- ความสามารถชำระหนี้ 25
  const years = fin.slice(0, 3).filter((f) => n(f.net_income) !== null);
  const profitable = years.filter((f) => n(f.net_income) > 0).length;
  add('capacity', 'trend', 'ผลประกอบการย้อนหลัง (สูงสุด 3 ปี)', 10, years.length === 0 ? 0 : profitable === years.length && years.length >= 3 ? 10 : profitable === years.length ? 7 : profitable >= years.length - 1 ? 5 : 1,
    years.length ? `กำไร ${profitable} จาก ${years.length} ปี` : null, years.length < 3 ? 'มีงบการเงินไม่ครบ 3 ปี' : null);
  if (tl !== null && eq) {
    const de = tl / eq;
    add('capacity', 'de_ratio', 'หนี้สินต่อทุน (D/E)', 8, de <= 1 ? 8 : de <= 2 ? 6 : de <= 3 ? 3 : 0, `${round2(de)} เท่า`, 'เกณฑ์: ≤1 เต็ม, 1–2 ดี, 2–3 พอใช้');
  } else add('capacity', 'de_ratio', 'หนี้สินต่อทุน (D/E)', 8, 0, null, 'ไม่มีข้อมูล');
  const debts = profile.debts || [];
  const debtSum = debts.reduce((a, d) => a + (n(d.outstanding) || 0), 0);
  if (!debts.length || debtSum === 0) add('capacity', 'debt_years', 'หนี้เงินกู้ภายนอก ÷ กำไรสุทธิ', 7, 7, 'ไม่มีหนี้เงินกู้ภายนอก', null);
  else if (ni && ni > 0) {
    const y = debtSum / ni;
    add('capacity', 'debt_years', 'หนี้เงินกู้ภายนอก ÷ กำไรสุทธิ', 7, y <= 3 ? 7 : y <= 6 ? 5 : y <= 10 ? 2 : 0, `${round2(y)} ปี`, 'ใช้กำไรกี่ปีจึงชำระหนี้เดิมหมด — ≤3 ปี เต็ม');
  } else add('capacity', 'debt_years', 'หนี้เงินกู้ภายนอก ÷ กำไรสุทธิ', 7, 0, 'ขาดทุนหรือไม่มีข้อมูลกำไร', null);

  // ---- ธรรมาภิบาล 20
  const g = profile.governance || {};
  add('governance', 'standard', 'ผลการจัดระดับมาตรฐานสหกรณ์', 8, { excellent: 8, very_good: 6, good: 5, pass: 3, fail: 0 }[g.standard_grade] ?? 0,
    g.standard_grade ? GOV_TH[g.standard_grade] : null, g.standard_grade ? null : 'ไม่มีข้อมูล');
  const op = last.audit_opinion;
  add('governance', 'audit', 'ความเห็นผู้สอบบัญชี (ปีล่าสุด)', 8, { unqualified: 8, qualified: 4 }[op] ?? 0, op ? AUDIT_TH[op] || op : null, op ? null : 'ไม่มีข้อมูล');
  const unresolved = Boolean(g.unresolved_issues && String(g.unresolved_issues).trim());
  add('governance', 'issues', 'ข้อบกพร่องที่ยังไม่ได้แก้ไข', 4, unresolved ? 0 : 4, unresolved ? 'มี' : 'ไม่มี', null);

  // ---- ประวัติการชำระหนี้ 15
  const worst = debts.some((d) => d.status === 'default') ? 'default' : debts.some((d) => d.status === 'late') ? 'late'
    : debts.some((d) => d.status === 'restructured') ? 'restructured' : 'current';
  add('repayment', 'debts', 'ประวัติชำระหนี้กับเจ้าหนี้เดิม', 8, debts.length ? { current: 8, restructured: 4, late: 2, default: 0 }[worst] : 6,
    debts.length ? { current: 'ปกติทุกราย', restructured: 'มีการปรับโครงสร้างหนี้', late: 'มีค้างชำระ', default: 'มีผิดนัด' }[worst] : 'ไม่มีหนี้เดิม (กลาง)', null);
  let hp; let hv;
  if (Number(history.overdue_now) > 0) { hp = 0; hv = `ค้างชำระในระบบ ${history.overdue_now} รายการ`; } else if (Number(history.late_events) > 0) { hp = 3; hv = `เคยชำระช้า ${history.late_events} ครั้ง`; } else if (Number(history.facilities) > 0) { hp = 7; hv = `ชำระตรงตามกำหนด (${history.facilities} วงเงิน)`; } else { hp = 4; hv = 'ยังไม่มีประวัติในระบบ (กลาง)'; }
  add('repayment', 'platform', 'ประวัติสินเชื่อใน AgroLink', 7, hp, hv, null);

  // ---- ความเข้มแข็งทางธุรกิจ 15
  const lines = Object.values(profile.businesses || {}).filter((x) => x && (n(x.value) > 0 || (x.volume && String(x.volume).trim()))).length;
  add('business', 'lines', 'จำนวนธุรกิจที่ดำเนินการ', 5, lines >= 3 ? 5 : lines === 2 ? 3 : lines === 1 ? 2 : 0, `${lines} ธุรกิจ`, null);
  const rv = n(last.revenue); const rv0 = n(prev.revenue);
  if (rv !== null && rv0) {
    const gr = (rv - rv0) / Math.abs(rv0);
    add('business', 'growth', 'การเติบโตของรายได้ (ปีล่าสุด)', 5, gr >= 0 ? 5 : gr >= -0.1 ? 3 : 1, pct(gr), null);
  } else add('business', 'growth', 'การเติบโตของรายได้ (ปีล่าสุด)', 5, 0, null, 'ต้องมีรายได้อย่างน้อย 2 ปี');
  const age = profile.established_year ? (Number(today.slice(0, 4)) + 543) - Number(profile.established_year) : null;
  const mc = n(profile.member_count);
  add('business', 'base', 'อายุสหกรณ์และฐานสมาชิก', 5, (age === null ? 0 : age >= 10 ? 3 : age >= 5 ? 2 : 1) + (mc === null ? 0 : mc >= 300 ? 2 : mc >= 100 ? 1 : 0),
    [age !== null ? `${age} ปี` : null, mc !== null ? `${mc} คน` : null].filter(Boolean).join(' · ') || null, null);

  let score = factors.reduce((a, f) => a + f.points, 0);
  const asOf = profile.data_as_of ? L.toDateStr(profile.data_as_of) : null;
  const stale = !asOf || monthsBetween(asOf, today) > 18;
  if (stale) score -= 5;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const [, grade, guidance] = gradeOf(score);
  const fields = [profile.registration_no, profile.member_count, fin.length >= 3, profile.board, lines > 0,
    Array.isArray(profile.debts), (profile.assets || []).length > 0, g.standard_grade, profile.consent_disclose];
  return {
    score, grade, guidance, factors,
    groups: SCORE_GROUPS.map(([key, label, max]) => ({ key, label, max, points: factors.filter((f) => f.group === key).reduce((a, f) => a + f.points, 0) })),
    stale, data_as_of: asOf,
    completeness_pct: Math.round((fields.filter(Boolean).length / fields.length) * 100),
    note: stale ? 'ข้อมูลเก่ากว่า 18 เดือนหรือไม่ระบุวันที่ (−5) — ควรปรับปรุงทุกปีบัญชี' : null,
  };
}

/** ตัวชี้วัดของโครงการ: { indicators:[{label, value, ok, note}] } */
function projectRisk(listing, ratePct = 5) {
  const d = listing.details || {};
  const out = [];
  const amount = Number(listing.amount_requested);
  if (listing.project_type === 'investment') {
    const proj = (d.projections || []).filter((p) => n(p.net_cash) !== null);
    if (proj.length) {
      const sched = repaymentSchedule({ amount, rate_pct: ratePct, tenor_months: listing.tenor_months, repayment_type: 'installment', interval_months: 12, grace_months: listing.grace_months || 0 }, '2000-01-01');
      const annual = sched.length ? Math.max(...sched.map((r) => r.installment)) : 0;
      const avgCash = proj.reduce((a, p) => a + Number(p.net_cash), 0) / proj.length;
      const dscr = annual > 0 ? round2(avgCash / annual) : null;
      out.push({ key: 'dscr', label: 'ความสามารถชำระหนี้ของโครงการ (DSCR)', value: dscr, ok: dscr !== null && dscr >= 1.25, note: `กระแสเงินสดสุทธิเฉลี่ย/ปี ÷ ค่างวดสูงสุดต่อปี (สมมติดอกเบี้ย ${ratePct}%) — ควร ≥ 1.25` });
    } else out.push({ key: 'dscr', label: 'ความสามารถชำระหนี้ของโครงการ (DSCR)', value: null, ok: false, note: 'ยังไม่มีประมาณการกระแสเงินสด' });
    if (n(d.payback_years) !== null) out.push({ key: 'payback', label: 'ระยะเวลาคืนทุน', value: `${d.payback_years} ปี`, ok: Number(d.payback_years) * 12 <= listing.tenor_months, note: 'ควรไม่เกินอายุสัญญา' });
  }
  if (listing.project_type === 'member_onlending') {
    const p = n(d.member_repayment_pct);
    out.push({ key: 'member_repay', label: 'ผลการชำระหนี้ของสมาชิกย้อนหลัง', value: p === null ? null : `${p}%`, ok: p !== null && p >= 90, note: 'ควร ≥ 90%' });
    if (n(d.members_count) && n(d.per_member_limit)) {
      out.push({ key: 'coverage', label: 'วงเงินต่อสมาชิก × จำนวนสมาชิก', value: round2(Number(d.members_count) * Number(d.per_member_limit)), ok: Number(d.members_count) * Number(d.per_member_limit) >= amount * 0.9, note: 'ควรสอดคล้องกับวงเงินที่ขอ' });
    }
  }
  if (listing.project_type === 'procurement') {
    out.push({ key: 'buyers', label: 'ผู้ซื้อปลายทาง', value: d.end_buyers || null, ok: Boolean(d.end_buyers && String(d.end_buyers).trim()), note: 'ควรมีผู้ซื้อหรือสัญญาซื้อขายรองรับ' });
    if (n(d.volume_t) && n(d.reference_price)) {
      const value = Number(d.volume_t) * 1000 * Number(d.reference_price);
      out.push({ key: 'volume_value', label: 'มูลค่ารับซื้อตามแผน (ปริมาณ × ราคาอ้างอิง)', value: round2(value), ok: value >= amount * 0.8, note: 'วงเงินที่ขอไม่ควรเกินมูลค่ารับซื้อตามแผนมาก' });
    }
  }
  return { indicators: out };
}

const REQUIRED_DOC_BY_TYPE = { member_onlending: [], procurement: [], investment: ['quotation'] };
/** ความครบถ้วน: { ok, missing:[{code, label}] } */
function listingChecks(listing, docs = [], profile = null, extra = {}) {
  const m = [];
  const miss = (code, label) => m.push({ code, label });
  const d = listing.details || {};
  const has = (k) => docs.some((x) => x.kind === k);
  if (!profile) miss('profile', 'ข้อมูลสหกรณ์ (ฐานข้อมูลผู้ขอกู้) ยังไม่ได้กรอก');
  else {
    if (!(profile.financials || []).length) miss('financials', 'งบการเงินอย่างน้อย 1 ปี (ควรครบ 3 ปี)');
    if (!profile.consent_disclose) miss('consent', 'ความยินยอมเปิดเผยข้อมูลแก่ผู้ให้กู้');
    // พ.ร.บ.สหกรณ์ มาตรา 47: กู้ยืมได้ไม่เกินวงเงินที่ที่ประชุมใหญ่อนุมัติ
    if (n(profile.max_borrowing) === null) miss('max_borrowing', 'วงเงินกู้ยืมที่ที่ประชุมใหญ่อนุมัติ (พ.ร.บ.สหกรณ์ มาตรา 47)');
    else {
      const debt = (profile.debts || []).reduce((a, x) => a + (n(x.outstanding) || 0), 0) + (Number(extra.platformDebt) || 0);
      const amt = Number(listing.amount_requested);
      if (debt + amt > Number(profile.max_borrowing) + 0.004) {
        const f = (v) => Number(v).toLocaleString('th-TH', { maximumFractionDigits: 2 });
        miss('over_max_borrowing', `หนี้เงินกู้เดิม ${f(debt)} + วงเงินที่ขอ ${f(amt)} เกินวงเงินกู้ยืมที่ที่ประชุมใหญ่อนุมัติ ${f(profile.max_borrowing)} บาท`);
      }
    }
  }
  const plan = listing.use_plan || [];
  const planSum = plan.reduce((a, p) => a + (Number(p.amount) || 0), 0);
  if (!plan.length) miss('use_plan', 'แผนการใช้เงิน');
  else if (Math.abs(planSum - Number(listing.amount_requested)) > Number(listing.amount_requested) * 0.01) miss('use_plan_sum', `แผนการใช้เงินรวม ${round2(planSum)} ไม่เท่ากับวงเงินที่ขอ`);
  if (!listing.repayment_plan || String(listing.repayment_plan).trim().length < 10) miss('repayment_plan', 'แผนชำระคืน');
  if (!listing.resolution_file_id && !has('resolution')) miss('resolution', 'มติที่ประชุมที่อนุมัติให้กู้');
  if (listing.project_type === 'member_onlending') {
    if (!n(d.members_count)) miss('members_count', 'จำนวนสมาชิกผู้กู้');
    if (!n(d.per_member_limit)) miss('per_member_limit', 'วงเงินต่อราย');
    if (!(d.production_plan && String(d.production_plan).trim()) && !has('production_plan')) miss('production_plan', 'แผนการผลิต');
  }
  if (listing.project_type === 'procurement') {
    if (!d.commodity) miss('commodity', 'ชนิดผลผลิต');
    if (!n(d.volume_t)) miss('volume_t', 'ปริมาณรับซื้อ (ตัน)');
    if (!d.period_from || !d.period_to) miss('period', 'ช่วงเวลารับซื้อ');
    if (!n(d.reference_price)) miss('reference_price', 'ราคาอ้างอิง (บาท/กก.)');
    if (!(d.end_buyers && String(d.end_buyers).trim())) miss('end_buyers', 'ผู้ซื้อปลายทาง');
  }
  if (listing.project_type === 'investment') {
    if (!(d.business_plan && String(d.business_plan).trim()) && !has('business_plan')) miss('business_plan', 'แผนธุรกิจ');
    if (!(d.projections || []).length) miss('projections', 'ประมาณการรายได้และกระแสเงินสด');
    REQUIRED_DOC_BY_TYPE.investment.forEach((k) => { if (!has(k)) miss(k, 'ใบเสนอราคาผู้ขาย/ผู้รับจ้าง'); });
  }
  if (!listing.certified_at) miss('certify', 'ผู้ขอกู้รับรองความถูกต้องของข้อมูล');
  return { ok: m.length === 0, missing: m };
}

/** policy ของผู้ให้กู้กับโครงการ: { match, mismatches:[label] } — นโยบายที่ไม่ได้กรอก = ไม่จำกัด */
function policyMatch(policy = {}, listing, grade) {
  const mm = [];
  const p = policy || {};
  if (Array.isArray(p.project_types) && p.project_types.length && !p.project_types.includes(listing.project_type)) mm.push('ประเภทโครงการ');
  const amt = Number(listing.amount_requested);
  if (n(p.max_amount) && Number(listing.min_amount || amt) > Number(p.max_amount)) mm.push('วงเงินเกินสูงสุดต่อราย');
  if (n(p.min_amount) && amt < Number(p.min_amount)) mm.push('วงเงินต่ำกว่าขั้นต่ำ');
  if (n(p.max_tenor_months) && listing.tenor_months > Number(p.max_tenor_months)) mm.push('ระยะเวลานานเกิน');
  if (n(p.min_tenor_months) && listing.tenor_months < Number(p.min_tenor_months)) mm.push('ระยะเวลาสั้นเกิน');
  if (Array.isArray(p.provinces) && p.provinces.length && listing.province_code && !p.provinces.includes(listing.province_code)) mm.push('พื้นที่');
  if (Array.isArray(p.commodities) && p.commodities.length && (listing.commodities || []).length && !(listing.commodities || []).some((c) => p.commodities.includes(c))) mm.push('ชนิดพืช');
  if (p.max_risk_grade && grade && GRADES.indexOf(normGrade(grade)) > GRADES.indexOf(normGrade(p.max_risk_grade))) mm.push(`ระดับความเสี่ยง (${grade} ต่ำกว่าที่รับได้ ${p.max_risk_grade})`);
  return { match: mm.length === 0, mismatches: mm };
}

/**
 * exposure: { total, borrower, province, type } ยอดคงค้าง + ข้อเสนอที่ยังมีผลของผู้ให้กู้ (ไม่รวมข้อเสนอนี้)
 * คืน [{code, message}] — เป็นการแจ้งเตือน ผู้ให้กู้ตัดสินใจเองตามระเบียบ
 */
function exposureWarnings(profile, exposure, offer, listing) {
  const w = [];
  const p = (profile && profile.policy) || {};
  const amt = Number(offer.amount);
  const fmt = (v) => Number(v).toLocaleString('th-TH', { maximumFractionDigits: 2 });
  if (profile && n(profile.allocatable_amount) !== null && exposure.total + amt > Number(profile.allocatable_amount)) {
    w.push({ code: 'over_allocatable', message: `รวมแล้ว ${fmt(exposure.total + amt)} บาท เกินเงินที่จัดสรรได้ ${fmt(profile.allocatable_amount)} บาท` });
  }
  if (n(p.limit_per_borrower) && exposure.borrower + amt > Number(p.limit_per_borrower)) w.push({ code: 'over_borrower', message: `เกินเพดานต่อผู้กู้ ${fmt(p.limit_per_borrower)} บาท (รวม ${fmt(exposure.borrower + amt)})` });
  if (n(p.limit_per_province) && exposure.province + amt > Number(p.limit_per_province)) w.push({ code: 'over_province', message: `เกินเพดานต่อจังหวัด ${fmt(p.limit_per_province)} บาท (รวม ${fmt(exposure.province + amt)})` });
  const lt = (p.limit_per_type || {})[listing.project_type];
  if (n(lt) && exposure.type + amt > Number(lt)) w.push({ code: 'over_type', message: `เกินเพดานโครงการประเภท${PROJECT_TYPES[listing.project_type].name_th} ${fmt(lt)} บาท` });
  if (n(p.max_amount) && amt > Number(p.max_amount)) w.push({ code: 'over_policy_max', message: `เกินวงเงินสูงสุดต่อรายตามนโยบาย ${fmt(p.max_amount)} บาท` });
  if (n(p.rate_min) && Number(offer.rate_pct) < Number(p.rate_min)) w.push({ code: 'rate_below_policy', message: `อัตราดอกเบี้ยต่ำกว่านโยบาย (${p.rate_min}%)` });
  return w;
}

/** ตารางชำระคืน (สมมติเบิกเต็มวงเงินวันเริ่มสัญญา) */
function repaymentSchedule(o, startDate) {
  const amount = Number(o.amount);
  const tenor = Number(o.tenor_months);
  const iv = Number(o.interval_months) || 6;
  if (o.repayment_type === 'bullet') {
    const rows = [];
    let k = 0;
    for (let m = iv; m < tenor; m += iv) {
      k += 1;
      rows.push({ seq: k, due_date: L.addMonths(startDate, m), principal: 0, interest: round2((amount * Number(o.rate_pct) * iv) / 1200), installment: round2((amount * Number(o.rate_pct) * iv) / 1200), balance: amount });
    }
    const lastGap = tenor - (k * iv);
    const intLast = round2((amount * Number(o.rate_pct) * lastGap) / 1200);
    rows.push({ seq: k + 1, due_date: L.addMonths(startDate, tenor), principal: amount, interest: intLast, installment: round2(amount + intLast), balance: 0 });
    return rows;
  }
  const termMonths = Math.max(iv, Math.ceil(tenor / iv) * iv);
  const gracePeriods = Math.floor((Number(o.grace_months) || 0) / iv);
  return L.annuitySchedule({ principal: amount, ratePct: Number(o.rate_pct), termMonths, intervalMonths: iv, gracePeriods: Math.min(gracePeriods, termMonths / iv - 1), startDate })
    .map((r, i) => ({ seq: i + 1, ...r }));
}

/** เลขสัญญา: CL-ปีพ.ศ.-6 ตัว */
function agreementNo(today, rand) { return `CL-${Number(today.slice(0, 4)) + 543}-${rand}`; }

module.exports = {
  PROJECT_TYPES, GRADES, GRADE_BANDS, gradeOf, normGrade, SCORE_GROUPS, GOV_TH, AUDIT_TH, creditScore, projectRisk, listingChecks, policyMatch, exposureWarnings, repaymentSchedule, agreementNo,
};
