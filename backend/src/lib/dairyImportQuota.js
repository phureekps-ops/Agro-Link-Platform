/**
 * โควตานำเข้าสินค้านม × ปัญหานมล้น (backend/db/grant_dairy_import_quota.sql)
 *
 * ส่วนบน = pure function (ทดสอบได้โดยไม่ต้องมีฐานข้อมูล):
 *   rawMilkKg()      สินค้านำเข้า (ตัน) → น้ำนมดิบเทียบเท่า (กก.)
 *   obligations()    แบ่งภาระรับซื้อนมส่วนเกินตามกลุ่มนิติบุคคล (เช่น 80:20) แล้วตามสัดส่วนโควตาของแต่ละราย
 *   policyOptions()  ทางเลือกเชิงนโยบายให้ภาครัฐ: ผู้ถือโควตารับซื้อ / ชะลองวดที่ยังไม่เปิด / แปรรูปเป็นนมผงทดแทนการนำเข้า
 * ส่วนล่าง = อ่านฐานข้อมูล (โหลดโควตา, ภาระคงเหลือของผู้ถือโควตาสำหรับระบบแนะนำของสหกรณ์)
 *
 * ระบบแนะนำเท่านั้น — การจัดสรร/ชะลอโควตาเป็นอำนาจของคณะกรรมการโคนมและผลิตภัณฑ์นม
 */
const { round2, bkkToday, addDays, ds } = require('./dairy');

const DEFAULT_HORIZON_DAYS = 90;
const DECISION_LEAD_DAYS = 30; // ควรมีมติก่อนวันเปิดงวดอย่างน้อย 30 วัน เพื่อแจ้งกรมการค้าต่างประเทศ
const MIN_DECISION_DAYS = 14; // เวลาขั้นต่ำที่คณะกรรมการต้องใช้ประชุมออกมติ
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

function rawMilkKg(tons, factor) { return round2(Number(tons) * 1000 * Number(factor)); }

/**
 * ภาระรับซื้อของผู้ถือโควตาแต่ละราย (กก./วัน)
 * measure: { total_kg_day, group1_pct, product_code, quota_year } · holders: [{ holder_id, entity_group, quantity_t, product_code, quota_year, active }]
 * กลุ่มที่ไม่มีผู้ถือโควตาในข้อมูล → ภาระของกลุ่มนั้นยัง "ไม่ได้มอบหมาย"
 */
function obligations(measure, holders) {
  const total = Number(measure.total_kg_day);
  const pct = { 1: Number(measure.group1_pct), 2: 100 - Number(measure.group1_pct) };
  const list = holders.filter((h) => h.active !== false && h.product_code === measure.product_code && Number(h.quota_year) === Number(measure.quota_year));
  const groupQty = { 1: 0, 2: 0 };
  list.forEach((h) => { groupQty[h.entity_group] += Number(h.quantity_t); });
  const rows = list.map((h) => {
    const groupKg = (total * pct[h.entity_group]) / 100;
    const share = groupQty[h.entity_group] > 0 ? Number(h.quantity_t) / groupQty[h.entity_group] : 0;
    return { ...h, share_pct_in_group: round2(share * 100), kg_per_day: round2(groupKg * share) };
  }).sort((a, b) => a.entity_group - b.entity_group || b.kg_per_day - a.kg_per_day);
  const unassigned = [1, 2].filter((g) => groupQty[g] === 0).reduce((a, g) => a + (total * pct[g]) / 100, 0);
  return {
    rows, unassigned_kg_day: round2(unassigned),
    groups: [1, 2].map((g) => ({ entity_group: g, pct: pct[g], kg_per_day: round2((total * pct[g]) / 100), holders: list.filter((h) => h.entity_group === g).length, quota_t: round2(groupQty[g]) })),
  };
}

/**
 * ทางเลือกเชิงนโยบาย
 * ctx: { today, tranches:[{tranche_id, quota_year, agreement, product_code, entity_group, tranche_no, quantity_t, deferred_t, opens_on, status, raw_milk_factor, name_th}],
 *        surplus_kg_day, horizon_days, basis, measure|null, holders:[], group1_pct }
 */
function policyOptions(ctx) {
  const today = ctx.today;
  const surplus = Number(ctx.surplus_kg_day) || 0;
  const days = Number(ctx.horizon_days) || DEFAULT_HORIZON_DAYS;
  const out = [];
  if (!(surplus > 0)) return out;
  const surplusTotalKg = surplus * days;

  // 1) ผู้ถือโควตารับซื้อนมดิบส่วนเกินตามสัดส่วนโควตา
  const m = ctx.measure || { total_kg_day: surplus, group1_pct: ctx.group1_pct ?? 80, product_code: 'smp', quota_year: ctx.quota_year };
  const ob = obligations(m, ctx.holders || []);
  out.push({
    kind: 'absorb_by_quota_holders',
    title_th: ctx.measure ? `ติดตามมาตรการ: ${ctx.measure.title}` : 'ให้ผู้ถือโควตานำเข้ารับซื้อน้ำนมดิบส่วนเกินตามสัดส่วนโควตา',
    kg_per_day: round2(Number(m.total_kg_day)), days: ctx.measure ? Number(ctx.measure.days) : days,
    groups: ob.groups, holders: ob.rows.map((r) => ({
      holder_id: r.holder_id, holder_name: r.holder_name, entity_group: r.entity_group, quantity_t: Number(r.quantity_t), share_pct_in_group: r.share_pct_in_group,
      kg_per_day: r.kg_per_day, on_platform: !!r.org_id, delivered_kg: r.delivered_kg ?? null, approved_kg_day: r.approved_kg_day ?? null,
    })),
    unassigned_kg_day: ob.unassigned_kg_day,
    notes: [
      `แบ่งภาระกลุ่มนิติบุคคลที่ 1 : 2 = ${Number(m.group1_pct)} : ${100 - Number(m.group1_pct)} แล้วตามสัดส่วนโควตาของแต่ละราย`,
      ...(ob.unassigned_kg_day > 0 ? ['ยังไม่มีรายชื่อผู้ได้รับจัดสรรโควตาบางกลุ่มในระบบ — ผู้ดูแลเพิ่มได้ที่หน้า โควตานำเข้านม'] : []),
      'ผู้ถือโควตาที่เป็นโรงงานในระบบจะปรากฏเป็นทางเลือกในระบบแนะนำนมเกินของสหกรณ์โดยอัตโนมัติระหว่างมาตรการ',
    ],
  });

  // 2) ชะลอการนำเข้านมผงงวดที่ยังไม่เปิด — นมผงมีค่าแปลงสูงสุด ผลต่อสมดุลชัดที่สุด
  //    ปริมาณที่ควรชะลอ = นมเกินตลอดช่วง ÷ ค่าแปลง · เลือกงวดที่เปิดเร็วที่สุดซึ่งยังมีเวลาตัดสินใจ ≥ MIN_DECISION_DAYS
  //    (ไม่พอค่อยเติมจากงวดถัดไป) · งวดอื่นแสดงเป็นทางเลือกให้คณะกรรมการพิจารณา
  const cands = (ctx.tranches || []).filter((t) => t.product_code === 'smp' && ds(t.opens_on) > today && ['Planned', 'DeferProposed'].includes(t.status))
    .map((t) => {
      const remaining = round2(Number(t.quantity_t) - Number(t.deferred_t || 0));
      const decideBy = addDays(ds(t.opens_on), -DECISION_LEAD_DAYS);
      const dtd = daysBetween(today, decideBy);
      return {
        tranche_id: t.tranche_id, label: `${t.agreement === 'TAFTA_TNZCEP' ? 'TAFTA/TNZCEP' : t.agreement}${t.entity_group ? ` กลุ่มนิติบุคคล ${t.entity_group}` : ''} งวดที่ ${t.tranche_no}`,
        opens_on: ds(t.opens_on), decide_by: decideBy, days_to_decide: dtd, decidable: dtd >= MIN_DECISION_DAYS, remaining_t: remaining,
        raw_milk_kg: rawMilkKg(remaining, t.raw_milk_factor), factor: Number(t.raw_milk_factor), status: t.status, defer_t: 0,
      };
    })
    .filter((x) => x.remaining_t > 0)
    .sort((a, b) => a.opens_on.localeCompare(b.opens_on) || b.remaining_t - a.remaining_t);
  if (cands.length) {
    const factor = cands[0].factor;
    const neededT = round2(surplusTotalKg / factor / 1000);
    let left = neededT;
    cands.filter((x) => x.decidable).forEach((x) => {
      if (left <= 0) return;
      x.defer_t = round2(Math.min(left, x.remaining_t));
      left = round2(left - x.defer_t);
    });
    const proposeT = round2(neededT - Math.max(0, left));
    const first = cands.find((x) => x.defer_t > 0) || null;
    out.push({
      kind: 'defer_import', title_th: 'ชะลอการนำเข้านมผงขาดมันเนยงวดที่ยังไม่เปิด',
      needed_t: neededT, propose_t: proposeT, raw_milk_kg: rawMilkKg(proposeT, factor), covers_days: round2(rawMilkKg(proposeT, factor) / surplus),
      shortfall_t: round2(Math.max(0, left)), recommended_tranche_id: first ? first.tranche_id : null, decide_by: first ? first.decide_by : null,
      days_to_decide: first ? first.days_to_decide : null, candidates: cands,
      notes: [
        `นมเกิน ${round2(surplus).toLocaleString('en-US')} กก./วัน × ${days} วัน = นมผงเทียบเท่า ${neededT.toLocaleString('en-US')} ตัน (ค่าแปลง ${factor})`,
        `เลือกงวดที่เปิดเร็วที่สุดซึ่งยังมีเวลาออกมติอย่างน้อย ${MIN_DECISION_DAYS} วัน (มติต้องออกก่อนวันลงระบบ ${DECISION_LEAD_DAYS} วัน เพื่อแจ้งกรมการค้าต่างประเทศ)`,
        'ต้องคำนึงถึงข้อผูกพันตามความตกลงการค้า และความต้องการวัตถุดิบของอุตสาหกรรมที่ไม่ได้ใช้นมดิบ',
        ...(left > 0 ? [`งวดที่ยังทันตัดสินใจรองรับได้ไม่พอ ขาดอีก ${round2(left).toLocaleString('en-US')} ตัน — ต้องใช้ทางเลือกอื่นร่วม`] : []),
      ],
    });
  }

  // 3) แปรรูปนมส่วนเกินเป็นนมผงในประเทศ ทดแทนโควตาที่ยังไม่นำเข้า
  const smp = (ctx.tranches || []).filter((t) => t.product_code === 'smp');
  if (smp.length) {
    const factor = Number(smp[0].raw_milk_factor);
    const powderT = round2(surplusTotalKg / factor / 1000);
    const notYet = smp.filter((t) => ds(t.opens_on) > today && t.status !== 'Deferred').reduce((a, t) => a + Number(t.quantity_t) - Number(t.deferred_t || 0), 0);
    out.push({
      kind: 'domestic_powder', title_th: 'แปรรูปน้ำนมดิบส่วนเกินเป็นนมผงในประเทศ เพื่อใช้แทนโควตานำเข้าที่ยังไม่เปิด',
      raw_milk_kg: round2(surplusTotalKg), powder_t: powderT, substitutes_pct: notYet > 0 ? round2((powderT / notYet) * 100) : null, not_yet_imported_t: round2(notYet),
      notes: ['ต้องมีโรงงานที่มีเครื่องทำนมผง/ระเหยน้ำว่างพอ และผู้ใช้นมผงยอมรับสเปกในประเทศ', 'ใช้คู่กับการชะลอนำเข้า — นมผงที่ผลิตได้ช่วยให้ผู้ใช้ไม่ขาดวัตถุดิบ'],
    });
  }
  return out;
}

// ===========================================================================
// ส่วนที่ใช้ฐานข้อมูล
// ===========================================================================
async function installed(c) {
  return (await c.query(`SELECT to_regclass('dairy.import_quota_tranche') IS NOT NULL AS ok`)).rows[0].ok;
}

/** มาตรการที่มีผลวันนี้ (start_date ≤ วันนี้ ≤ start_date + days − 1) */
async function activeMeasures(c, today = bkkToday()) {
  return (await c.query(
    `SELECT * FROM dairy.absorption_measure WHERE status='Active' AND start_date <= $1 AND start_date + days - 1 >= $1 ORDER BY start_date`, [today],
  )).rows;
}

/** ภาระและผลการรับซื้อรายผู้ถือโควตาของมาตรการ (จากทางเลือก quota_holder ที่สหกรณ์อนุมัติ/บันทึกผล) */
async function measureProgress(c, measure) {
  const holders = (await c.query(
    `SELECT h.*, pp.display_name AS processor_name, pp.lat, pp.lng,
            (SELECT COALESCE(SUM(o.kg_per_day),0) FROM dairy.surplus_option o WHERE o.kind='quota_holder' AND o.measure_id=$1 AND o.target_id=h.holder_id AND o.status IN ('Approved','Done'))::numeric AS approved_kg_day,
            (SELECT COALESCE(SUM(o.outcome_kg),0) FROM dairy.surplus_option o WHERE o.kind='quota_holder' AND o.measure_id=$1 AND o.target_id=h.holder_id AND o.status='Done')::numeric AS delivered_kg
       FROM dairy.import_quota_holder h LEFT JOIN dairy.processor_profile pp ON pp.org_id=h.org_id AND pp.active
      WHERE h.quota_year=$2 AND h.product_code=$3 AND h.active`, [measure.measure_id, measure.quota_year, measure.product_code],
  )).rows.map((h) => ({ ...h, approved_kg_day: Number(h.approved_kg_day), delivered_kg: Number(h.delivered_kg) }));
  return { holders, ...obligations(measure, holders) };
}

/** สำหรับระบบแนะนำนมเกินของสหกรณ์: ผู้ถือโควตาที่เป็นโรงงานในระบบและยังรับไม่ครบส่วนของตน */
async function holdersForCoop(c, today = bkkToday()) {
  if (!(await installed(c))) return [];
  const out = [];
  for (const m of await activeMeasures(c, today)) {
    // eslint-disable-next-line no-await-in-loop
    const p = await measureProgress(c, m);
    p.rows.filter((h) => h.org_id && h.processor_name).forEach((h) => {
      const left = round2(h.kg_per_day - h.approved_kg_day);
      if (left > 0) {
        out.push({
          holder_id: h.holder_id, org_id: h.org_id, name: h.processor_name, entity_group: h.entity_group, lat: h.lat, lng: h.lng,
          remaining_kg_day: left, measure_id: m.measure_id, measure_title: m.title, measure_end: addDays(ds(m.start_date), m.days - 1),
        });
      }
    });
  }
  return out.sort((a, b) => b.remaining_kg_day - a.remaining_kg_day).slice(0, 5);
}

async function loadYear(c, year) {
  const tranches = (await c.query(
    `SELECT t.*, p.name_th, p.raw_milk_factor FROM dairy.import_quota_tranche t JOIN dairy.import_product p USING (product_code)
      WHERE t.quota_year=$1 ORDER BY t.opens_on, t.product_code, t.agreement, t.entity_group NULLS FIRST, t.tranche_no`, [year],
  )).rows.map((t) => ({ ...t, opens_on: ds(t.opens_on), quantity_t: Number(t.quantity_t), deferred_t: Number(t.deferred_t), raw_milk_factor: Number(t.raw_milk_factor) }));
  const holders = (await c.query(
    `SELECT h.*, pp.display_name AS processor_name FROM dairy.import_quota_holder h LEFT JOIN dairy.processor_profile pp ON pp.org_id=h.org_id
      WHERE h.quota_year=$1 ORDER BY h.entity_group, h.quantity_t DESC`, [year],
  )).rows;
  const measures = (await c.query('SELECT * FROM dairy.absorption_measure WHERE quota_year=$1 ORDER BY created_at DESC', [year])).rows
    .map((m) => ({ ...m, start_date: ds(m.start_date), end_date: addDays(ds(m.start_date), m.days - 1) }));
  const products = (await c.query('SELECT * FROM dairy.import_product ORDER BY product_code')).rows;
  return { tranches, holders, measures, products };
}

module.exports = {
  rawMilkKg, obligations, policyOptions, installed, MIN_DECISION_DAYS, activeMeasures, measureProgress, holdersForCoop, loadYear, DECISION_LEAD_DAYS, DEFAULT_HORIZON_DAYS,
};
