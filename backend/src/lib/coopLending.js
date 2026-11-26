/**
 * สินเชื่อระหว่างสหกรณ์ (สหกรณ์ออมทรัพย์ → สหกรณ์การเกษตร) — ตรรกะกลาง
 * (backend/db/grant_coop_lending.sql, routes/coopLending.js)
 *
 * ส่วนบนเป็นฟังก์ชันบริสุทธิ์ (ทดสอบใน test/coopLending.test.js):
 *   วันทำการ, ดอกเบี้ยรายวัน + ดอกเบี้ยผิดนัด, ค่าปรับจ่ายช้า, ตารางผ่อน (งวดเท่ากัน),
 *   การตัดชำระ, ความสามารถชำระ, หลักฐานที่ต้องมี, ผลตรวจดาวเทียม
 * ส่วนล่างทำงานกับฐานข้อมูล (client ต้องอยู่ใน withSessionContext/withServiceRole แล้ว)
 *
 * วันที่ทั้งหมดเป็นสตริง 'YYYY-MM-DD' ตามเวลาประเทศไทย ดอกเบี้ยคิดฐานวันจริง/365
 */

const PURPOSES = ['inputs', 'machinery_service', 'procurement', 'asset'];
const PURPOSE_TH = {
  inputs: 'ปัจจัยการผลิต', machinery_service: 'ค่าบริการเครื่องจักร', procurement: 'รับซื้อผลผลิต', asset: 'ซื้อเครื่องจักร/อุปกรณ์',
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

function todayBangkok(now = Date.now()) {
  return new Date(now + 7 * 3600e3).toISOString().slice(0, 10);
}
function isDate(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function toDateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return new Date(v.getTime() + 7 * 3600e3).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
function addDays(d, n) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
/** จำนวนวันปฏิทินจาก a ถึง b (b − a) */
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
}
function addMonths(d, m) {
  const [y, mo, day] = d.split('-').map(Number);
  const total = (mo - 1) + m;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ny, nm, Math.min(day, last))).toISOString().slice(0, 10);
}

/** วันทำการ = ไม่ใช่เสาร์-อาทิตย์ และไม่อยู่ในวันหยุดที่ประกาศ */
function isBusinessDay(d, holidays = new Set()) {
  const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays.has(d);
}
/** วันที่ครบ n วันทำการ นับถัดจากวัน d (เริ่มนับวันทำการแรกหลัง d) */
function addBusinessDays(d, n, holidays = new Set()) {
  let cur = d;
  let left = n;
  while (left > 0) {
    cur = addDays(cur, 1);
    if (isBusinessDay(cur, holidays)) left -= 1;
  }
  return cur;
}
/** จำนวนวันทำการที่เลย due มาแล้ว ณ วัน today (0 = ยังไม่เลย) */
function businessDaysLate(due, today, holidays = new Set()) {
  if (!due || today <= due) return 0;
  let n = 0;
  let cur = due;
  while (cur < today) {
    cur = addDays(cur, 1);
    if (isBusinessDay(cur, holidays)) n += 1;
  }
  return n;
}

/**
 * ดอกเบี้ยของเงินต้น principal ช่วงวัน (from, to] — วันที่เลย dueDate ใช้อัตราผิดนัด penaltyPct แทนอัตราปกติ
 * คืน { normalDays, overdueDays, normal, overdue, total }
 */
function accrueInterest({
  principal, from, to, dueDate, ratePct, penaltyPct,
}) {
  const days = Math.max(0, daysBetween(from, to));
  if (!days || !(principal > 0)) return { normalDays: 0, overdueDays: 0, normal: 0, overdue: 0, total: 0 };
  let normalDays = days;
  let overdueDays = 0;
  if (dueDate && to > dueDate) {
    overdueDays = Math.min(days, daysBetween(from > dueDate ? from : dueDate, to));
    normalDays = days - overdueDays;
  }
  const normal = (principal * ratePct) / 100 * normalDays / 365;
  const overdue = (principal * penaltyPct) / 100 * overdueDays / 365;
  return {
    normalDays, overdueDays, normal: round2(normal), overdue: round2(overdue), total: round2(normal + overdue),
  };
}

/** ค่าปรับจ่ายช้า: ยอด × pct% × วันปฏิทินที่เลย due / 365 */
function latePenalty(amount, dueDate, paidDate, pct) {
  if (!dueDate || !paidDate || paidDate <= dueDate) return 0;
  return round2((Number(amount) * pct) / 100 * daysBetween(dueDate, paidDate) / 365);
}

/**
 * ตารางผ่อนงวดเท่ากัน (annuity) — ช่วงปลอดเงินต้น gracePeriods งวดแรกจ่ายดอกเบี้ยอย่างเดียว
 * ดอกเบี้ยต่องวด = อัตราต่อปี × intervalMonths/12 (ตารางแสดงผล; ดอกเบี้ยผิดนัดคิดรายวันตอนชำระจริง)
 */
function annuitySchedule({
  principal, ratePct, termMonths, intervalMonths, gracePeriods = 0, startDate,
}) {
  if (!(principal > 0)) throw new Error('principal_required');
  if (!Number.isInteger(termMonths) || !Number.isInteger(intervalMonths) || termMonths % intervalMonths !== 0) throw new Error('term_not_multiple_of_interval');
  const n = termMonths / intervalMonths;
  if (gracePeriods >= n) throw new Error('grace_too_long');
  const r = (ratePct / 100) * (intervalMonths / 12);
  const amortN = n - gracePeriods;
  const pmt = r === 0 ? principal / amortN : (principal * r) / (1 - (1 + r) ** -amortN);
  const rows = [];
  let bal = principal;
  for (let k = 1; k <= n; k += 1) {
    const interest = round2(bal * r);
    let principalPart = 0;
    if (k > gracePeriods) principalPart = k === n ? round2(bal) : round2(pmt - bal * r);
    bal = round2(bal - principalPart);
    rows.push({
      seq: k, due_date: addMonths(startDate, k * intervalMonths), principal: principalPart, interest, installment: round2(principalPart + interest), balance: bal,
    });
  }
  return rows;
}

/** ค่างวดสูงสุด (หลังช่วงปลอดเงินต้น) เทียบรายได้ต่องวด */
function affordability(schedule, incomePerPeriod, maxRatioPct) {
  const maxInstallment = Math.max(...schedule.map((r) => r.installment));
  const ratio = round2((maxInstallment / incomePerPeriod) * 100);
  return { installment: maxInstallment, ratio_pct: ratio, ok: ratio <= maxRatioPct };
}

/**
 * ตัดชำระ: ดอกเบี้ยค้าง (รวมดอกเบี้ยผิดนัด) ทุกรายการก่อน เรียงตามวันครบกำหนด แล้วตัดเงินต้นรายการที่ครบกำหนดก่อน
 * items: [{ item_id, loan_due_date, interest_unpaid, principal_outstanding }] (accrue แล้ว)
 * คืน { allocation: [{item_id, interest, principal}], interest, principal, leftover }
 */
function allocateRepayment(amount, items) {
  let left = round2(amount);
  const sorted = [...items].sort((a, b) => String(a.loan_due_date).localeCompare(String(b.loan_due_date)));
  const map = new Map(sorted.map((i) => [i.item_id, { item_id: i.item_id, interest: 0, principal: 0 }]));
  for (const it of sorted) {
    const take = Math.min(left, round2(it.interest_unpaid));
    if (take > 0) { map.get(it.item_id).interest = round2(take); left = round2(left - take); }
  }
  for (const it of sorted) {
    const take = Math.min(left, round2(it.principal_outstanding));
    if (take > 0) { map.get(it.item_id).principal = round2(take); left = round2(left - take); }
  }
  const allocation = [...map.values()].filter((a) => a.interest > 0 || a.principal > 0);
  return {
    allocation,
    interest: round2(allocation.reduce((s, a) => s + a.interest, 0)),
    principal: round2(allocation.reduce((s, a) => s + a.principal, 0)),
    leftover: left,
  };
}

/** หลักฐานที่ต้องมีก่อน "หลักฐานครบ" */
function evidenceRequirements(item) {
  const req = { kinds: [], farmerConfirm: Boolean(item.farmer_id), fields: [] };
  switch (item.source_type === 'manual' ? `manual_${item.purpose}` : item.purpose) {
    case 'inputs': req.kinds = ['invoice']; break;
    case 'machinery_service': req.kinds = ['work_photo']; req.fields = ['service_date', 'service_area_rai']; break;
    case 'procurement': req.kinds = ['weighing_slip', 'quality_slip', 'purchase_receipt']; break; // ใบชั่ง ใบตรวจคุณภาพ ใบรับซื้อ
    case 'asset': req.kinds = ['contract', 'down_payment_slip', 'serial_photo', 'invoice']; break;
    default: req.kinds = ['invoice'];
  }
  if (item.source_type === 'manual' && item.purpose === 'machinery_service') { req.kinds = ['invoice', 'work_photo']; req.fields = ['service_date', 'service_area_rai']; }
  return req;
}
/** สิ่งที่ยังขาด: { missingKinds, missingFields, needFarmer, needPayout } */
function missingEvidence(item, evidenceKinds, payoutVerified) {
  const req = evidenceRequirements(item);
  const have = new Set(evidenceKinds);
  return {
    missingKinds: req.kinds.filter((k) => !have.has(k)),
    missingFields: req.fields.filter((f) => item[f] === null || item[f] === undefined || item[f] === ''),
    needFarmer: req.farmerConfirm && !item.farmer_confirmed_at,
    needPayout: !payoutVerified,
  };
}

const SAT_FLAGS = {
  inputs: ['NO_CROP_CYCLE', 'CROP_MISMATCH', 'AREA_MISMATCH'],
  machinery_service: ['HARVEST_DATE_MISMATCH', 'AREA_MISMATCH', 'NO_CROP_CYCLE'],
  procurement: ['DELIVERY_BEFORE_HARVEST', 'DELIVERY_WITHOUT_HARVEST', 'YIELD_OUTLIER', 'CROP_MISMATCH'],
  asset: ['NO_CROP_CYCLE'],
};
/**
 * ผลตรวจดาวเทียมจากผล Plot AI ล่าสุดของแปลง (ai.v_latest_assessment)
 * plots: [{ unit_id, area_rai, assessment: { flags:[{code,severity,message_th}], assessed_at } | null }]
 * 'na' = ไม่ได้ระบุแปลง · 'insufficient' = ไม่มีผลประเมินหรือภาพไม่พอ · 'review' = มีธงที่เกี่ยวข้อง · 'pass'
 * ผลนี้เป็นหลักฐานประกอบ: 'review' ต้องให้สหกรณ์ออมทรัพย์รับทราบก่อนอนุมัติ ไม่ปฏิเสธอัตโนมัติ
 */
function classifySatellite(purpose, plots, { serviceAreaRai } = {}) {
  if (!plots || plots.length === 0) return { result: 'na', flags: [] };
  const relevant = SAT_FLAGS[purpose] || [];
  const flags = [];
  let insufficient = false;
  for (const p of plots) {
    const a = p.assessment;
    if (!a) { insufficient = true; flags.push({ unit_id: p.unit_id, code: 'NO_ASSESSMENT', severity: 'info', message_th: 'แปลงนี้ยังไม่มีผลประเมินจากภาพดาวเทียม' }); continue; }
    for (const f of a.flags || []) {
      if (f.code === 'LOW_DATA') { insufficient = true; flags.push({ unit_id: p.unit_id, ...f }); }
      else if (relevant.includes(f.code) && (f.severity === 'high' || f.severity === 'medium')) flags.push({ unit_id: p.unit_id, ...f });
    }
  }
  if (purpose === 'machinery_service' && serviceAreaRai) {
    const area = plots.reduce((s, p) => s + Number(p.area_rai || 0), 0);
    if (area > 0 && Number(serviceAreaRai) > area * 1.1) {
      flags.push({ code: 'SERVICE_AREA_EXCEEDS_PLOT', severity: 'high', message_th: `พื้นที่ที่คิดค่าบริการ ${serviceAreaRai} ไร่ มากกว่าพื้นที่แปลงรวม ${round2(area)} ไร่` });
    }
  }
  const hasReview = flags.some((f) => f.severity === 'high' || f.severity === 'medium');
  return { result: hasReview ? 'review' : (insufficient ? 'insufficient' : 'pass'), flags };
}

/** ชื่อบัญชีตรงกับชื่อเจ้าของ (ตัดช่องว่าง/คำนำหน้า เทียบแบบมีอีกฝั่งอยู่ในกัน) */
function namesMatch(a, b) {
  const norm = (s) => String(s || '').toLowerCase()
    .replace(/^(นาย|นางสาว|นาง|น\.ส\.|mr\.?|mrs\.?|ms\.?)\s*/u, '')
    .replace(/[\s.,()'"-]/gu, '');
  const x = norm(a); const y = norm(b);
  if (x.length < 2 || y.length < 2) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// ---------------------------------------------------------------------------
// ส่วนที่ทำงานกับฐานข้อมูล
// ---------------------------------------------------------------------------

async function loadSettings(c) {
  return (await c.query('SELECT * FROM coop_lending.setting WHERE id')).rows[0]
    || { fee_pct: 0, sc_sla_days: 3, ac_sla_days: 4, late_penalty_pct: 10, platform_account_id: null };
}
async function loadHolidays(c) {
  const rows = (await c.query(`SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d FROM coop_lending.holiday
                                 WHERE holiday_date BETWEEN current_date - 400 AND current_date + 400`)).rows;
  return new Set(rows.map((r) => r.d));
}
async function logEvent(c, {
  itemId = null, facilityId = null, assetLoanId = null, actor, action, detail = {},
}) {
  await c.query(
    `INSERT INTO coop_lending.event (item_id, facility_id, asset_loan_id, actor, action, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
    [itemId, facilityId, assetLoanId, actor, action, JSON.stringify(detail)],
  );
}

/** ตรวจดาวเทียมของรายการ (อ่านผล Plot AI ล่าสุดของแปลงที่ผูกไว้) แล้วบันทึกผล */
async function checkSatellite(c, item) {
  const plots = (await c.query(
    `SELECT pu.unit_id, pu.area_rai, a.flags, a.assessed_at
       FROM coop_lending.item_plot ip
       JOIN registry.production_unit pu ON pu.unit_id = ip.unit_id
       LEFT JOIN ai.v_latest_assessment a ON a.unit_id = pu.unit_id
      WHERE ip.item_id = $1`, [item.item_id],
  )).rows.map((r) => ({ unit_id: r.unit_id, area_rai: r.area_rai, assessment: r.assessed_at ? { flags: r.flags || [], assessed_at: r.assessed_at } : null }));
  const out = classifySatellite(item.purpose, plots, { serviceAreaRai: item.service_area_rai });
  await c.query(
    `UPDATE coop_lending.disbursement_item SET satellite_result = $2, satellite_detail = $3, satellite_checked_at = now(), satellite_ack_by = NULL
      WHERE item_id = $1`, [item.item_id, out.result, JSON.stringify(out)],
  );
  return out;
}

/** ประเมินว่ารายการที่ส่งแล้วหลักฐานครบหรือยัง — ครบ = เริ่มนับ 3 วันทำการของสหกรณ์ออมทรัพย์ */
async function evaluateItem(c, itemId, actor) {
  const item = (await c.query('SELECT * FROM coop_lending.disbursement_item WHERE item_id = $1 FOR UPDATE', [itemId])).rows[0];
  if (!item || !['EvidencePending', 'EvidenceComplete'].includes(item.status)) return item;
  if (item.status === 'EvidenceComplete') return item;
  const kinds = (await c.query('SELECT DISTINCT kind FROM coop_lending.evidence WHERE item_id = $1', [itemId])).rows.map((r) => r.kind);
  const payout = item.payout_account_id
    ? (await c.query('SELECT verification_status FROM coop_lending.bank_account WHERE account_id = $1', [item.payout_account_id])).rows[0]
    : null;
  const miss = missingEvidence(item, kinds, payout && payout.verification_status === 'Verified');
  if (miss.missingKinds.length || miss.missingFields.length || miss.needFarmer || miss.needPayout) return item;
  const settings = await loadSettings(c);
  const holidays = await loadHolidays(c);
  const today = todayBangkok();
  const due = addBusinessDays(today, settings.sc_sla_days, holidays);
  const updated = (await c.query(
    `UPDATE coop_lending.disbursement_item SET status = 'EvidenceComplete', evidence_complete_at = now(), sc_due_date = $2, updated_at = now()
      WHERE item_id = $1 RETURNING *`, [itemId, due],
  )).rows[0];
  await logEvent(c, { itemId, facilityId: item.facility_id, actor, action: 'evidence_complete', detail: { sc_due_date: due } });
  return updated;
}

/** คิดดอกเบี้ยสะสมของรายการเงินกู้ (ไม่รวมสินเชื่อเครื่องจักร) จนถึงวัน toDate แล้วบันทึก */
async function accrueFacility(c, facility, toDate, settings) {
  const items = (await c.query(
    `SELECT * FROM coop_lending.disbursement_item
      WHERE facility_id = $1 AND purpose <> 'asset' AND principal_outstanding > 0 FOR UPDATE`, [facility.facility_id],
  )).rows;
  for (const it of items) {
    const from = toDateStr(it.interest_accrued_to) || toDateStr(it.funded_at);
    if (from >= toDate) continue;
    const acc = accrueInterest({
      principal: Number(it.principal_outstanding), from, to: toDate, dueDate: toDateStr(it.loan_due_date),
      ratePct: Number(facility.rate_pct), penaltyPct: Number(settings.late_penalty_pct),
    });
    it.interest_unpaid = round2(Number(it.interest_unpaid) + acc.total);
    it.interest_accrued_to = toDate;
    await c.query('UPDATE coop_lending.disbursement_item SET interest_unpaid = $2, interest_accrued_to = $3 WHERE item_id = $1',
      [it.item_id, it.interest_unpaid, toDate]);
  }
  return items;
}

/** ยอดที่ต้องชำระของงวดผ่อนเครื่องจักร ณ วัน today: ค่างวดค้าง + ดอกเบี้ยผิดนัด 10% ต่อปีของงวดที่เลยกำหนด */
function installmentsDue(schedule, today, penaltyPct) {
  return schedule.map((r) => {
    const unpaid = round2(Number(r.installment) - Number(r.paid_amount));
    const due = toDateStr(r.due_date);
    const penalty = unpaid > 0 ? latePenalty(unpaid, due, today, penaltyPct) : 0;
    return {
      seq: r.seq, due_date: due, installment: Number(r.installment), paid_amount: Number(r.paid_amount), unpaid, penalty, overdue: unpaid > 0 && due < today,
    };
  });
}

/**
 * รอบตรวจกำหนดเวลา (ทุก 15 นาที ทำงานจริงวันละครั้งต่อเรื่องเพราะ dunning ไม่ซ้ำในวันเดียวกัน)
 * — ทวงสหกรณ์ออมทรัพย์ที่ยังไม่โอน, สหกรณ์การเกษตรที่ยังไม่จ่ายผู้ขาย, เงินกู้/ค่างวดที่เลยกำหนด
 * — เงินกู้ค้างเกินวันผ่อนผัน = ระงับวงเงิน
 */
async function slaSweep(c, today = todayBangkok()) {
  const holidays = await loadHolidays(c);
  const settings = await loadSettings(c);
  const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const notice = async (orgId, kind, ref, daysLate, amount, message) => {
    await c.query(
      `INSERT INTO coop_lending.dunning_notice (target_org_id, kind, item_id, asset_loan_id, notice_date, days_late, amount, message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [orgId, kind, ref.item || null, ref.asset || null, today, daysLate, amount, message],
    );
  };
  if (!isBusinessDay(today, holidays)) return { skipped: 'holiday' };
  let count = 0;
  const scLate = (await c.query(
    `SELECT i.item_id, i.lender_org_id, i.amount, i.sc_due_date, i.seller_name, b.org_name AS borrower_name
       FROM coop_lending.disbursement_item i JOIN identity.organization b ON b.org_id = i.borrower_org_id
      WHERE i.status = 'EvidenceComplete' AND i.sc_due_date < $1`, [today],
  )).rows;
  for (const r of scLate) {
    const due = toDateStr(r.sc_due_date);
    const pen = latePenalty(r.amount, due, today, settings.late_penalty_pct);
    await notice(r.lender_org_id, 'sc_transfer_late', { item: r.item_id }, daysBetween(due, today), pen,
      `เลยกำหนดโอน (ครบ ${due}) รายการ ${fmt(r.amount)} บาท ของ${r.borrower_name} → ${r.seller_name} · ค่าปรับสะสม ${fmt(pen)} บาท (ให้ผู้ขาย)`);
    count += 1;
  }
  const acLate = (await c.query(
    `SELECT item_id, borrower_org_id, amount, sc_penalty, ac_due_date, seller_name FROM coop_lending.disbursement_item
      WHERE status = 'Funded' AND ac_due_date < $1`, [today],
  )).rows;
  for (const r of acLate) {
    const due = toDateStr(r.ac_due_date);
    const pen = latePenalty(Number(r.amount), due, today, settings.late_penalty_pct);
    await notice(r.borrower_org_id, 'ac_payment_late', { item: r.item_id }, daysBetween(due, today), pen,
      `เลยกำหนดจ่ายผู้ขาย (ครบ ${due}) ${r.seller_name} ${fmt(r.amount)} บาท · ค่าปรับสะสม ${fmt(pen)} บาท (ให้ผู้ขาย)`);
    count += 1;
  }
  const loans = (await c.query(
    `SELECT i.item_id, i.borrower_org_id, i.facility_id, i.loan_due_date, i.principal_outstanding, p.grace_days
       FROM coop_lending.disbursement_item i JOIN coop_lending.facility f ON f.facility_id = i.facility_id
       JOIN coop_lending.program p ON p.program_id = f.program_id
      WHERE i.purpose <> 'asset' AND i.principal_outstanding > 0 AND i.loan_due_date < $1`, [today],
  )).rows;
  for (const r of loans) {
    const due = toDateStr(r.loan_due_date);
    const late = daysBetween(due, today);
    await notice(r.borrower_org_id, 'tranche_overdue', { item: r.item_id }, late, r.principal_outstanding,
      `เงินกู้ครบกำหนด ${due} ยังค้างเงินต้น ${fmt(r.principal_outstanding)} บาท · คิดดอกเบี้ยผิดนัด ${settings.late_penalty_pct}% ต่อปีแทนอัตราปกติ`);
    count += 1;
    if (late > Number(r.grace_days)) await suspendFacility(c, r.facility_id, `เงินกู้ค้างชำระเกินวันผ่อนผัน ${r.grace_days} วัน`, today);
  }
  const inst = (await c.query(
    `SELECT s.asset_loan_id, s.seq, s.due_date, s.installment - s.paid_amount AS unpaid, a.borrower_org_id, a.facility_id, p.grace_days
       FROM coop_lending.repayment_schedule s JOIN coop_lending.asset_loan a ON a.asset_loan_id = s.asset_loan_id
       JOIN coop_lending.facility f ON f.facility_id = a.facility_id JOIN coop_lending.program p ON p.program_id = f.program_id
      WHERE a.status = 'Active' AND s.paid_amount < s.installment AND s.due_date < $1 ORDER BY s.seq`, [today],
  )).rows;
  const seen = new Set();
  for (const r of inst) {
    if (seen.has(r.asset_loan_id)) continue;
    seen.add(r.asset_loan_id);
    const due = toDateStr(r.due_date);
    const late = daysBetween(due, today);
    await notice(r.borrower_org_id, 'installment_overdue', { asset: r.asset_loan_id }, late, r.unpaid,
      `ค่างวดที่ ${r.seq} (ครบ ${due}) ค้าง ${fmt(r.unpaid)} บาท · คิดดอกเบี้ยผิดนัด ${settings.late_penalty_pct}% ต่อปี`);
    count += 1;
    if (late > Number(r.grace_days)) await suspendFacility(c, r.facility_id, `ค่างวดสินเชื่อเครื่องจักรค้างเกินวันผ่อนผัน ${r.grace_days} วัน`, today);
  }
  return { notices: count };
}

async function suspendFacility(c, facilityId, reason, today = todayBangkok()) {
  const f = (await c.query(
    `UPDATE coop_lending.facility SET status = 'Suspended', suspended_reason = $2
      WHERE facility_id = $1 AND status = 'Active' RETURNING *`, [facilityId, reason],
  )).rows[0];
  if (!f) return null;
  await logEvent(c, { facilityId, actor: 'system', action: 'facility_suspended', detail: { reason } });
  for (const orgId of [f.borrower_org_id, f.lender_org_id]) {
    await c.query(
      `INSERT INTO coop_lending.dunning_notice (target_org_id, kind, notice_date, message)
       VALUES ($1, 'facility_suspended', $2, $3) ON CONFLICT DO NOTHING`, [orgId, today, `ระงับการเบิกวงเงิน: ${reason}`],
    );
  }
  return f;
}

// ---------------------------------------------------------------------------
// สินเชื่อการผลิตแบบแบ่งงวด (grant_coop_lending_crop_plan.sql)
// ---------------------------------------------------------------------------

/**
 * แม่แบบงวดตาม Concept Note ประเภท A — วันเป็นจำนวนวันนับจากวันปลูก (ข้าวรอบ 120 วัน)
 * พืชอื่นปรับช่วงเวลาตามอายุพืช (cycle) — สัดส่วนเงินแต่ละงวดแก้ได้ตอนสร้างแผน
 * satellite: none = ใช้ภาพหน้างาน, planted = ต้องเห็นการเริ่มรอบปลูก, growing = พืชกำลังเจริญเติบโต, harvested = เก็บเกี่ยวแล้ว
 */
const STAGE_TEMPLATE = [
  { key: 'land_prep', name_th: 'เตรียมพื้นที่และปรับปรุงดิน', pct: 15, from: -30, to: -1, purposes: ['machinery_service', 'inputs'], satellite: 'none', check_th: 'ภาพถ่ายแปลงที่เตรียมดินแล้ว (มีพิกัดและเวลา)' },
  { key: 'seed_inputs', name_th: 'จัดซื้อเมล็ดพันธุ์และปัจจัยการผลิต', pct: 20, from: -14, to: 7, purposes: ['inputs'], satellite: 'none', check_th: 'ใบสั่งซื้อ หลักฐานส่งมอบ และภาพปัจจัยที่แปลง' },
  { key: 'planting', name_th: 'เพาะปลูกและลงมือดำเนินการ', pct: 15, from: 0, to: 21, purposes: ['machinery_service', 'inputs'], satellite: 'planted', check_th: 'ภาพถ่ายดาวเทียมพบการเริ่มรอบปลูก + ภาพแปลงหลังปลูก' },
  { key: 'fertilize', name_th: 'ใส่ปุ๋ยและบำรุงรักษา', pct: 25, from: 21, to: 60, purposes: ['inputs', 'machinery_service'], satellite: 'growing', check_th: 'หลักฐานการจัดซื้อปุ๋ย + ภาพแปลง + ดาวเทียมพืชเจริญเติบโต' },
  { key: 'care', name_th: 'ดูแลรักษาและติดตามการเจริญเติบโต', pct: 10, from: 60, to: 100, purposes: ['inputs', 'machinery_service'], satellite: 'growing', check_th: 'Satellite Monitoring และ AI ติดตามแปลง' },
  { key: 'harvest', name_th: 'เก็บเกี่ยวและรวบรวมผลผลิต', pct: 15, from: 100, to: 130, purposes: ['machinery_service'], satellite: 'harvested', check_th: 'ดาวเทียมพบการเก็บเกี่ยว + หลักฐานผลผลิต/การรับซื้อ' },
];
const CROP_TEMPLATES = {
  rice: { name_th: 'ข้าว (รอบ 120 วัน)', cycle: 120, commodities: ['RICE_JASMINE', 'RICE_PADDY'] },
  corn: { name_th: 'ข้าวโพดเลี้ยงสัตว์ (รอบ 110 วัน)', cycle: 110, commodities: ['CORN_FEED'] },
  cassava: { name_th: 'มันสำปะหลัง (รอบ 300 วัน)', cycle: 300, commodities: ['CASSAVA'] },
};
function templateFor(commodity) {
  const key = Object.keys(CROP_TEMPLATES).find((k) => CROP_TEMPLATES[k].commodities.includes(commodity));
  return key ? { key, ...CROP_TEMPLATES[key] } : null;
}
/** งวดของแผน: ช่วงวันที่จากวันปลูก และเงินแต่ละงวด (ปัดให้รวมเท่ายอดรวมพอดี) */
function buildStages(templateKey, plantingDate, totalAmount, amounts) {
  const t = CROP_TEMPLATES[templateKey];
  if (!t) throw new Error('unknown_template');
  const scale = t.cycle / 120;
  const n = STAGE_TEMPLATE.length;
  let planned;
  if (Array.isArray(amounts) && amounts.length === n) {
    planned = amounts.map((a) => round2(Number(a)));
    if (planned.some((a) => !(a >= 0))) throw new Error('invalid_stage_amount');
    if (Math.abs(planned.reduce((x, y) => x + y, 0) - totalAmount) > 0.01) throw new Error('stage_amounts_must_sum_to_total');
  } else {
    planned = STAGE_TEMPLATE.map((s) => round2(totalAmount * s.pct / 100));
    planned[n - 1] = round2(totalAmount - planned.slice(0, -1).reduce((x, y) => x + y, 0));
  }
  return STAGE_TEMPLATE.map((s, i) => ({
    seq: i + 1, stage_key: s.key, name_th: s.name_th, purposes: s.purposes, planned_amount: planned[i], satellite: s.satellite, check_method_th: s.check_th,
    window_start: addDays(plantingDate, Math.round(s.from * (s.from < 0 ? 1 : scale))), window_end: addDays(plantingDate, Math.round(s.to * (s.to < 0 ? 1 : scale))),
  }));
}
const stageSatelliteExpect = (stageKey) => (STAGE_TEMPLATE.find((s) => s.key === stageKey) || {}).satellite || 'none';

/**
 * ผลดาวเทียมของการตรวจงวด จากผล Plot AI ล่าสุดของแปลง (ai.v_latest_assessment)
 * ใช้ประกอบภาพหน้างาน ไม่ปฏิเสธเอง: 'review' = สหกรณ์ออมทรัพย์ต้องระบุเหตุผลก่อนผ่านงวด
 */
function classifyStage(stageKey, a, { plantingDate, today = todayBangkok() } = {}) {
  const expect = stageSatelliteExpect(stageKey);
  if (expect === 'none') return { result: 'na', expect, notes: ['งวดนี้ตรวจด้วยภาพหน้างานและหลักฐานการซื้อ'] };
  if (!a) return { result: 'insufficient', expect, notes: ['แปลงนี้ยังไม่มีผลประเมินจากภาพดาวเทียม — สั่งประเมินได้ที่หน้า AI ติดตามแปลง'] };
  const asOf = toDateStr(a.assessed_at);
  const age = daysBetween(asOf, today);
  const out = {
    expect, season_status: a.season_status || null, planting_date: toDateStr(a.planting_date), harvest_date: toDateStr(a.harvest_date), assessed_at: asOf, notes: [],
  };
  if (age > 30) return { ...out, result: 'insufficient', notes: [`ผลประเมินล่าสุดเก่า ${age} วัน — ควรสั่งประเมินใหม่`] };
  const flags = a.flags || [];
  if (flags.some((f) => f.code === 'LOW_DATA')) return { ...out, result: 'insufficient', notes: ['ภาพปลอดเมฆไม่พอ (ฤดูฝน) — ใช้ภาพหน้างานประกอบ'] };
  const bad = flags.filter((f) => ['CROP_MISMATCH', 'AREA_MISMATCH'].includes(f.code) && (f.severity === 'high' || f.severity === 'medium'));
  if (bad.length) return { ...out, result: 'review', notes: bad.map((f) => f.message_th || f.code) };
  const st = a.season_status;
  if (expect === 'planted') {
    const ok = ['growing', 'new_season_starting'].includes(st) || (out.planting_date && plantingDate && out.planting_date >= addDays(plantingDate, -30));
    return { ...out, result: ok ? 'pass' : 'review', notes: [ok ? 'ภาพดาวเทียมพบการเริ่มรอบปลูก' : 'ภาพดาวเทียมยังไม่พบการเริ่มรอบปลูกในแปลงนี้'] };
  }
  if (expect === 'growing') {
    const ok = st === 'growing' && !flags.some((f) => f.code === 'NO_CROP_CYCLE');
    return { ...out, result: ok ? 'pass' : 'review', notes: [ok ? 'พืชกำลังเจริญเติบโตตามรอบ' : 'ภาพดาวเทียมไม่พบพืชที่กำลังเจริญเติบโต'] };
  }
  const ok = st === 'harvested' || (out.harvest_date && plantingDate && out.harvest_date >= plantingDate);
  return { ...out, result: ok ? 'pass' : 'review', notes: [ok ? 'ภาพดาวเทียมพบการเก็บเกี่ยวแล้ว' : 'ภาพดาวเทียมยังไม่พบการเก็บเกี่ยว'] };
}

/**
 * วงเงินที่ใช้ไปแล้วของ facility:
 *   รายการทั่วไป (ไม่ใช่แผน/เครื่องจักร): ยอดที่รออนุมัติ + เงินต้นคงค้าง
 *   สินเชื่อเครื่องจักร: ยอดกู้ของรายการที่ยื่น/อนุมัติ/ผ่อนอยู่
 *   แผนสินเชื่อการผลิตที่ยังไม่จบ: กันวงเงินทั้งแผน (หักเงินต้นที่ชำระคืนแล้ว) · แผนที่จบแล้ว: เงินต้นคงค้าง
 */
async function facilityUsage(c, facilityId) {
  const r = (await c.query(
    `SELECT
       (SELECT COALESCE(SUM(CASE WHEN status IN ('Draft','EvidencePending','EvidenceComplete') THEN amount ELSE principal_outstanding END), 0)
          FROM coop_lending.disbursement_item WHERE facility_id = $1 AND purpose <> 'asset' AND plan_id IS NULL
           AND status NOT IN ('Rejected','Cancelled','Disputed'))::numeric AS items,
       (SELECT COALESCE(SUM(loan_amount), 0) FROM coop_lending.asset_loan WHERE facility_id = $1 AND status IN ('Submitted','Approved','Active'))::numeric AS asset,
       (SELECT COALESCE(SUM(CASE WHEN p.status IN ('Submitted','Active','Suspended')
                   THEN p.total_amount - COALESCE((SELECT SUM(i.amount - i.principal_outstanding) FROM coop_lending.disbursement_item i
                                                    WHERE i.plan_id = p.plan_id AND i.status IN ('Funded','Paid')), 0)
                   ELSE COALESCE((SELECT SUM(i.principal_outstanding) FROM coop_lending.disbursement_item i WHERE i.plan_id = p.plan_id), 0) END), 0)
          FROM coop_lending.crop_plan p WHERE p.facility_id = $1 AND p.status NOT IN ('Rejected','Cancelled'))::numeric AS plans`, [facilityId],
  )).rows[0];
  const items = Number(r.items); const asset = Number(r.asset); const plans = Number(r.plans);
  return { items, asset, plans, used: round2(items + asset + plans) };
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV === 'test') return;
  const { withServiceRole } = require('../db/pool'); // eslint-disable-line global-require
  const run = () => withServiceRole((c) => slaSweep(c)).catch((err) => {
    if (err && err.code === '42P01') return; // ยังไม่ได้รัน grant_coop_lending.sql
    console.error('[coop-lending] sla sweep failed', err.message);
  });
  setTimeout(run, 20e3);
  timer = setInterval(run, 15 * 60e3);
  if (timer.unref) timer.unref();
}

module.exports = {
  PURPOSES, PURPOSE_TH, round2, todayBangkok, isDate, toDateStr, addDays, addMonths, daysBetween,
  isBusinessDay, addBusinessDays, businessDaysLate, accrueInterest, latePenalty, annuitySchedule, affordability,
  allocateRepayment, evidenceRequirements, missingEvidence, classifySatellite, namesMatch,
  STAGE_TEMPLATE, CROP_TEMPLATES, templateFor, buildStages, classifyStage, facilityUsage,
  loadSettings, loadHolidays, logEvent, checkSatellite, evaluateItem, accrueFacility, installmentsDue, slaSweep, suspendFacility, start,
};
