/**
 * ตลาดสินเชื่อระหว่างสหกรณ์ — ระบบเตือนภัยล่วงหน้า (Master Blueprint ข้อ 9.3) และสัญญาณทุจริต (ข้อ 10.3)
 * ส่วนคำนวณล้วน: รับข้อมูลที่ดึงมาแล้ว คืนรายการสัญญาณ { category, code, severity, title, detail, dedupe_key, ...ref }
 * ไม่มีฐานข้อมูลหรือเครือข่าย จึงทดสอบได้ทั้งหมด (test/coopRisk.test.js) — การดึงข้อมูลและบันทึกอยู่ที่ routes/coopRisk.js
 *
 * หลักการ (ข้อ 10.3): ทุกสัญญาณเป็น "เรื่องที่ต้องตรวจสอบ" ไม่ใช่ข้อสรุปว่ามีการทุจริต ต้องมีผู้ตรวจสอบและให้ผู้เกี่ยวข้องชี้แจงก่อนเสมอ
 */
const L = require('./coopLending');
const CR = require('./coopRegistry');

const n = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const fmt = (v, d = 0) => Number(v).toLocaleString('th-TH', { minimumFractionDigits: d, maximumFractionDigits: d });
const dayMs = 864e5;
const toDay = (v) => (v ? Date.parse(`${L.toDateStr(v)}T00:00:00Z`) : null);
const daysBetween = (a, b) => Math.round((toDay(b) - toDay(a)) / dayMs);
const LIVE = (i) => !['Rejected', 'Cancelled'].includes(i.status);

const DEFAULTS = {
  ew_purchase_below_pct: 70, ew_price_drop_pct: 15, ew_report_days: 100, ew_revenue_below_pct: 70, ew_inventory_gap_pct: 20,
  fraud_split_days: 90, fraud_new_member_days: 30, fraud_yield_factor: 1.5, fraud_official_diff_pct: 5,
};
const cfg = (s) => ({ ...DEFAULTS, ...Object.fromEntries(Object.entries(s || {}).filter(([k, v]) => k in DEFAULTS && n(v) !== null).map(([k, v]) => [k, Number(v)])) });

/** ชื่อและคำอธิบายของสัญญาณแต่ละแบบ (แสดงในทุกพอร์ทัล) */
const CODES = {
  ew_purchase_below_plan: ['early_warning', 'ยอดรับซื้อจริงต่ำกว่าแผน'],
  ew_price_drop: ['early_warning', 'ราคาผลผลิตลดลงมาก'],
  ew_inventory_mismatch: ['early_warning', 'สินค้าคงเหลือไม่ตรงกับเงินที่ใช้รับซื้อ'],
  ew_buyer_default: ['early_warning', 'ผู้ซื้อผิดนัดชำระหรือปฏิเสธสินค้า'],
  ew_report_late: ['early_warning', 'สหกรณ์ไม่ส่งรายงานตามรอบ'],
  ew_inflow_below: ['early_warning', 'รายได้ต่ำกว่าประมาณการ'],
  ew_unusual_transfer: ['early_warning', 'การโอนเงินผิดปกติ'],
  fr_duplicate_invoice: ['fraud', 'รายการเบิกที่อาจซ้ำกัน'],
  fr_ghost_seller: ['fraud', 'ผู้ขายที่ไม่มีข้อมูลการผลิตรองรับ'],
  fr_related_party: ['fraud', 'ซื้อขายกับผู้มีผลประโยชน์ร่วม'],
  fr_quantity_mismatch: ['fraud', 'ปริมาณที่รับซื้อไม่สอดคล้องกับพื้นที่หรือภาพดาวเทียม'],
  fr_shared_account: ['fraud', 'บัญชีรับเงินที่ไม่ใช่ของผู้ขาย'],
  fr_backdated_edit: ['fraud', 'แก้ไขข้อมูลงบการเงินย้อนหลัง'],
  fr_split_listing: ['fraud', 'แตกโครงการเพื่อเลี่ยงเพดานวงเงิน'],
  fr_official_mismatch: ['fraud', 'งบการเงินที่กรอกไม่ตรงกับข้อมูลทางการ'],
};
function sig(code, severity, key, detail, ref = {}) {
  const [category, title] = CODES[code];
  return { category, code, severity, title, detail, dedupe_key: `${code}:${key}`, ...ref };
}

// =====================================================================
// 9.3 Early Warning — ต่อสัญญาที่ลงนามแล้ว
// =====================================================================
/**
 * ctx: { listing, agreement:{agreement_id, signed_at}, items:[disbursement_item + payout_created_at, transfer_at, facility_id],
 *        deliveries_kg (ผลผลิตที่สหกรณ์รับซื้อในช่วงโครงการ จาก produce.delivery), tranches:[agreement_tranche],
 *        reports:[listing_report ใหม่สุดก่อน], dairy:{rejected_30d}|null, settings, today }
 */
function earlyWarnings(ctx) {
  const s = cfg(ctx.settings);
  const today = ctx.today || L.todayBangkok();
  const l = ctx.listing; const d = l.details || {};
  const ref = { borrower_org_id: l.borrower_org_id, listing_id: l.listing_id, agreement_id: ctx.agreement && ctx.agreement.agreement_id };
  const items = (ctx.items || []).filter(LIVE);
  const out = [];

  // 1) ยอดรับซื้อจริงต่ำกว่าแผน (โครงการรับซื้อ: ปริมาณตามแผน × สัดส่วนเวลาที่ผ่านไป)
  if (l.project_type === 'procurement' && n(d.volume_t) && d.period_from && d.period_to) {
    const span = daysBetween(d.period_from, d.period_to);
    const elapsed = Math.min(1, Math.max(0, daysBetween(d.period_from, today) / Math.max(span, 1)));
    if (elapsed >= 0.25) {
      const planned = Number(d.volume_t) * 1000 * elapsed;
      const itemKg = items.reduce((a, i) => a + (i.price_check && n(i.price_check.quantity_kg) ? Number(i.price_check.quantity_kg) : 0), 0);
      const actual = Math.max(itemKg, Number(ctx.deliveries_kg) || 0);
      const pct = planned ? (actual / planned) * 100 : 100;
      if (pct < s.ew_purchase_below_pct) {
        out.push(sig('ew_purchase_below_plan', pct < s.ew_purchase_below_pct / 2 ? 'high' : 'warning', l.listing_id,
          `รับซื้อแล้ว ${fmt(actual)} กก. หรือร้อยละ ${fmt(pct, 1)} ของแผน ณ วันนี้ (${fmt(planned)} กก. จากแผนทั้งโครงการ ${fmt(Number(d.volume_t) * 1000)} กก.) เกณฑ์เตือนต่ำกว่าร้อยละ ${s.ew_purchase_below_pct}`,
          ref));
      }
    }
  }
  // 2) ราคาผลผลิตลดลงมาก: ราคารับซื้อเฉลี่ย 30 วันล่าสุด เทียบราคาอ้างอิงในประกาศ
  if (n(d.reference_price)) {
    const recent = items.filter((i) => i.price_check && n(i.price_check.actual) && i.created_at && daysBetween(i.created_at, today) <= 30);
    const kg = recent.reduce((a, i) => a + (n(i.price_check.quantity_kg) || 0), 0);
    if (recent.length && kg > 0) {
      const avg = recent.reduce((a, i) => a + Number(i.price_check.actual) * (n(i.price_check.quantity_kg) || 0), 0) / kg;
      const drop = ((Number(d.reference_price) - avg) / Number(d.reference_price)) * 100;
      if (drop >= s.ew_price_drop_pct) {
        out.push(sig('ew_price_drop', drop >= s.ew_price_drop_pct * 2 ? 'high' : 'warning', l.listing_id,
          `ราคารับซื้อเฉลี่ย 30 วันล่าสุด ${fmt(avg, 2)} บาท/กก. ต่ำกว่าราคาอ้างอิง ${fmt(d.reference_price, 2)} บาท/กก. ร้อยละ ${fmt(drop, 1)} — มูลค่าสินค้าในมืออาจไม่พอชำระคืนตามแผน`,
          ref));
      }
    }
  }
  // 3) สินค้าคงเหลือไม่ตรงบัญชี (โครงการรับซื้อ): มูลค่าคงเหลือ + ยอดขาย ต่ำกว่าเงินที่จ่ายรับซื้อในงวด
  for (const t of l.project_type === 'procurement' ? ctx.tranches || [] : []) {
    const inp = t.borrower_input || {}; const rec = t.reconciliation || {};
    const paid = n(rec.paid_amount); const inv = n(inp.inventory_value); const sales = n(inp.sales_amount);
    if (!paid || (inv === null && sales === null)) continue;
    const covered = (inv || 0) + (sales || 0);
    const gap = ((paid - covered) / paid) * 100;
    if (gap > s.ew_inventory_gap_pct) {
      out.push(sig('ew_inventory_mismatch', gap > s.ew_inventory_gap_pct * 2 ? 'high' : 'warning', `${t.agreement_id}:${t.seq}`,
        `งวดที่ ${t.seq}: จ่ายรับซื้อ ${fmt(paid)} บาท แต่สินค้าคงเหลือ ${fmt(inv || 0)} + ยอดขาย ${fmt(sales || 0)} = ${fmt(covered)} บาท ขาดไปร้อยละ ${fmt(gap, 1)}`,
        ref));
    }
  }
  // 4) ผู้ซื้อผิดนัดชำระ (ผู้กู้รายงาน) หรือโรงงานปฏิเสธนมหลายเที่ยว (Pilot B สหกรณ์โคนม)
  const last = (ctx.reports || [])[0];
  if (last && n(last.buyer_overdue) > 0) {
    const share = n(last.revenue) ? (Number(last.buyer_overdue) / Math.max(Number(last.revenue), 1)) * 100 : null;
    out.push(sig('ew_buyer_default', share === null || share >= 20 ? 'high' : 'warning', `${l.listing_id}:report`,
      `รายงาน ${last.period_label}: ผู้ซื้อค้างชำระ ${fmt(last.buyer_overdue)} บาท${share !== null ? ` (ร้อยละ ${fmt(share, 1)} ของรายได้งวด)` : ''}`, ref));
  }
  if (ctx.dairy && Number(ctx.dairy.rejected_30d) >= 2) {
    out.push(sig('ew_buyer_default', 'warning', `${l.listing_id}:dairy`,
      `โรงงานปฏิเสธน้ำนม ${ctx.dairy.rejected_30d} เที่ยวใน 30 วันล่าสุด (ข้อมูลระบบบริหารโคนม)`, ref));
  }
  // 5) ไม่ส่งรายงานตามรอบ
  if (ctx.agreement && ctx.agreement.signed_at) {
    const since = last ? last.created_at : ctx.agreement.signed_at;
    const days = daysBetween(since, today);
    if (days > s.ew_report_days) {
      out.push(sig('ew_report_late', days > s.ew_report_days * 2 ? 'high' : 'warning', l.listing_id,
        `ไม่มีรายงานผลการดำเนินงาน ${fmt(days)} วัน นับจาก${last ? `รายงานล่าสุด (${last.period_label})` : 'วันลงนามสัญญา'} เกณฑ์ ${s.ew_report_days} วัน`, ref));
    }
  }
  // 6) รายได้ต่ำกว่าประมาณการ
  if (last && n(last.planned_revenue) > 0 && n(last.revenue) !== null) {
    const pct = (Number(last.revenue) / Number(last.planned_revenue)) * 100;
    if (pct < s.ew_revenue_below_pct) {
      out.push(sig('ew_inflow_below', pct < s.ew_revenue_below_pct / 2 ? 'high' : 'warning', `${l.listing_id}:${last.report_id}`,
        `รายงาน ${last.period_label}: รายได้ ${fmt(last.revenue)} บาท หรือร้อยละ ${fmt(pct, 1)} ของประมาณการ ${fmt(last.planned_revenue)} บาท`, ref));
    }
  }
  // 7) การโอนเงินผิดปกติ: บัญชีรับเงินเพิ่งเพิ่มก่อนโอน / ยอดสูงผิดปกติเทียบรายการอื่นในวงเงินเดียวกัน
  const byFac = {};
  items.forEach((i) => { (byFac[i.facility_id] = byFac[i.facility_id] || []).push(Number(i.amount)); });
  for (const i of items) {
    if (i.transfer_at && i.payout_created_at && (new Date(i.transfer_at) - new Date(i.payout_created_at)) / dayMs < 3) {
      out.push(sig('ew_unusual_transfer', 'warning', `new_account:${i.item_id}`,
        `โอนให้ ${i.seller_name} ${fmt(i.amount)} บาท เข้าบัญชีที่เพิ่งเพิ่มในระบบไม่ถึง 3 วันก่อนโอน`, { ...ref, item_id: i.item_id }));
    }
    const arr = (byFac[i.facility_id] || []).slice().sort((a, b) => a - b);
    if (arr.length >= 4) {
      const med = arr[Math.floor(arr.length / 2)];
      if (Number(i.amount) >= 100000 && Number(i.amount) > med * 3) {
        out.push(sig('ew_unusual_transfer', 'warning', `large:${i.item_id}`,
          `รายการ ${fmt(i.amount)} บาท (${i.seller_name}) สูงกว่าค่ากลางของรายการในวงเงินเดียวกัน (${fmt(med)} บาท) เกิน 3 เท่า`, { ...ref, item_id: i.item_id }));
      }
    }
  }
  return out;
}

// =====================================================================
// 10.3 สัญญาณทุจริต — ต่อสหกรณ์ผู้กู้
// =====================================================================
/** แยกชื่อบุคคลจากข้อความ "ผู้มีอำนาจลงนาม" (คั่นด้วย , ; / ขึ้นบรรทัด) ตัดคำตำแหน่งออก */
function personNames(textValue) {
  return String(textValue || '').split(/[,;/\n]+/).map((x) => x.replace(/(ประธาน|กรรมการ|ผู้จัดการ|เหรัญญิก|เลขานุการ|รองประธาน)\S*/gu, '').trim())
    .filter((x) => x.replace(/\s/g, '').length >= 6);
}
/**
 * f: { borrower:{org_id, profile:{signatories, debts, max_borrowing}}, related:[related_party],
 *      items:[disbursement_item + seller_tax_id, payout:{bank_code, account_no, account_name, owners:n, is_borrower_account}],
 *      farmers:{ [farmer_id]: { plots:[{area_rai, crop, max_t_per_rai, predicted_crop, crop_confidence}], joined_at } },
 *      listings:[loan_listing], history:[profile_history], settings, today }
 */
function fraudSignals(f) {
  const s = cfg(f.settings);
  const today = f.today || L.todayBangkok();
  const org = f.borrower.org_id;
  const ref = { borrower_org_id: org };
  const items = (f.items || []).filter(LIVE);
  const out = [];
  const itemRef = (i) => ({ ...ref, item_id: i.item_id, listing_id: i.listing_id || null });

  // 1) รายการซ้ำ: ผู้ขายเดียวกัน ยอดเท่ากัน ห่างกันไม่เกิน 7 วัน (เลขเอกสารซ้ำถูกบล็อกตั้งแต่บันทึกแล้ว)
  const groups = {};
  items.forEach((i) => { (groups[`${i.seller_id}:${r2(i.amount)}`] = groups[`${i.seller_id}:${r2(i.amount)}`] || []).push(i); });
  Object.values(groups).forEach((g) => {
    g.sort((a, b) => new Date(a.service_date || a.created_at) - new Date(b.service_date || b.created_at));
    for (let k = 1; k < g.length; k += 1) {
      const a = g[k - 1]; const b = g[k];
      if (Math.abs(daysBetween(a.service_date || a.created_at, b.service_date || b.created_at)) <= 7) {
        out.push(sig('fr_duplicate_invoice', 'high', [a.item_id, b.item_id].sort().join(':'),
          `${b.seller_name}: 2 รายการยอดเท่ากัน ${fmt(b.amount)} บาท ห่างกันไม่เกิน 7 วัน (เลขเอกสาร ${a.doc_no || '-'} / ${b.doc_no || '-'}) ตรวจว่าเป็นการซื้อจริง 2 ครั้งหรือเอกสารชุดเดียวกัน`,
          itemRef(b)));
      }
    }
  });
  // 2) ผู้ขายที่เป็นสมาชิกแต่ไม่มีข้อมูลการผลิต (ไม่มีแปลง หรือเพิ่งเป็นสมาชิกก่อนขายไม่นาน)
  const seenGhost = new Set();
  for (const i of items.filter((x) => x.seller_type === 'farmer' && x.purpose === 'procurement')) {
    const fm = (f.farmers || {})[i.seller_id] || { plots: [] };
    const noPlot = !fm.plots.length;
    const newMember = fm.joined_at && daysBetween(fm.joined_at, i.created_at) <= s.fraud_new_member_days;
    if ((noPlot || newMember) && !seenGhost.has(i.seller_id)) {
      seenGhost.add(i.seller_id);
      const why = [noPlot ? 'ไม่มีแปลงที่ขึ้นทะเบียน' : null, newMember ? `เป็นสมาชิกเพียง ${daysBetween(fm.joined_at, i.created_at)} วันก่อนขาย` : null].filter(Boolean).join(' และ ');
      out.push(sig('fr_ghost_seller', noPlot && newMember ? 'high' : 'warning', `${org}:${i.seller_id}`,
        `ผู้ขาย ${i.seller_name}: ${why} — ตรวจตัวตนและแปลงจริงของสมาชิก`, itemRef(i)));
    }
  }
  // 3) ผู้มีผลประโยชน์ร่วม: ผู้ขายตรงกับที่สหกรณ์แจ้งไว้ หรือชื่อบัญชีรับเงินตรงกับผู้มีอำนาจลงนาม/ผู้เกี่ยวข้อง
  const related = f.related || [];
  const persons = [...related.map((x) => x.person_name), ...personNames(f.borrower.profile && f.borrower.profile.signatories)];
  const relHits = {};
  for (const i of items) {
    const hitOrg = related.find((x) => (x.related_org_id && x.related_org_id === i.seller_id)
      || (x.related_tax_id && i.seller_tax_id && x.related_tax_id === i.seller_tax_id)
      || (x.related_name && L.namesMatch(x.related_name, i.seller_name)));
    const accName = i.payout && i.payout.account_name;
    const hitPerson = accName && persons.find((p) => L.namesMatch(p, accName));
    if (hitOrg || hitPerson) {
      const h = relHits[i.seller_id] || (relHits[i.seller_id] = { items: [], total: 0, hitOrg, hitPerson, accName });
      h.items.push(i); h.total += Number(i.amount);
    }
  }
  // หนึ่งเรื่องต่อผู้ขาย (รวมทุกรายการ) — ยอดรวมอัปเดตทุกรอบตรวจ
  for (const [sellerId, h] of Object.entries(relHits)) {
    const last = h.items[h.items.length - 1];
    const amt = `${h.items.length} รายการ รวม ${fmt(h.total)} บาท`;
    out.push(sig('fr_related_party', 'high', `${org}:${sellerId}`,
      h.hitOrg ? `ผู้ขาย ${last.seller_name} ตรงกับผู้เกี่ยวข้องที่สหกรณ์แจ้งไว้ (${h.hitOrg.person_name}${h.hitOrg.role ? ` · ${h.hitOrg.role}` : ''}) ${amt} — ตรวจว่าผ่านการอนุมัติและราคาเป็นธรรม`
        : `ชื่อบัญชีรับเงินของ ${last.seller_name} (${h.accName}) ตรงกับ ${h.hitPerson} ซึ่งเป็นผู้มีอำนาจลงนาม/ผู้เกี่ยวข้องของสหกรณ์ ${amt}`,
      itemRef(last)));
  }
  // 4) ปริมาณไม่สอดคล้องกับพื้นที่ หรือภาพดาวเทียมไม่พบพืช
  const kgBy = {};
  items.filter((i) => i.seller_type === 'farmer' && i.price_check && n(i.price_check.quantity_kg) && daysBetween(i.created_at, today) <= 365)
    .forEach((i) => { (kgBy[i.seller_id] = kgBy[i.seller_id] || { kg: 0, items: [] }); kgBy[i.seller_id].kg += Number(i.price_check.quantity_kg); kgBy[i.seller_id].items.push(i); });
  for (const [fid, v] of Object.entries(kgBy)) {
    const fm = (f.farmers || {})[fid] || { plots: [] };
    const cap = fm.plots.reduce((a, p) => a + (n(p.max_t_per_rai) ? Number(p.area_rai) * Number(p.max_t_per_rai) * 1000 : 0), 0) * s.fraud_yield_factor;
    const it = v.items[v.items.length - 1];
    if (cap > 0 && v.kg > cap) {
      out.push(sig('fr_quantity_mismatch', 'high', `yield:${org}:${fid}`,
        `${it.seller_name} ขายให้สหกรณ์ ${fmt(v.kg)} กก. ใน 12 เดือน เกินผลผลิตสูงสุดที่แปลงที่ขึ้นทะเบียน (${fmt(fm.plots.reduce((a, p) => a + Number(p.area_rai), 0), 2)} ไร่) ให้ได้ (${fmt(cap)} กก. รวมส่วนเผื่อ ${s.fraud_yield_factor} เท่า)`,
        itemRef(it)));
    }
    const bare = fm.plots.filter((p) => p.predicted_crop === 'fallow' && Number(p.crop_confidence) >= 0.6);
    if (bare.length && bare.length === fm.plots.length) {
      out.push(sig('fr_quantity_mismatch', 'warning', `satellite:${org}:${fid}`,
        `${it.seller_name} ขายผลผลิต ${fmt(v.kg)} กก. แต่ภาพดาวเทียมล่าสุดของทุกแปลง (${bare.length} แปลง) ไม่พบพืชปลูก — ตรวจแหล่งที่มาของผลผลิต`, itemRef(it)));
    }
  }
  // 5) โอนเข้าบัญชีที่ไม่ใช่ของผู้ขาย: เลขบัญชีเดียวกันใช้กับผู้รับหลายราย หรือเป็นบัญชีของสหกรณ์ผู้กู้เอง
  const seenAcc = new Set();
  for (const i of items.filter((x) => x.payout)) {
    const key = `${i.payout.bank_code}:${i.payout.account_no}`;
    if (seenAcc.has(key)) continue;
    if (Number(i.payout.owners) > 1 || i.payout.is_borrower_account) {
      seenAcc.add(key);
      out.push(sig('fr_shared_account', 'high', `${org}:${key}`,
        i.payout.is_borrower_account
          ? `บัญชีรับเงินของ ${i.seller_name} (ลงท้าย ${String(i.payout.account_no).slice(-4)}) เป็นบัญชีเดียวกับบัญชีของสหกรณ์ผู้กู้`
          : `บัญชีรับเงินของ ${i.seller_name} (ลงท้าย ${String(i.payout.account_no).slice(-4)}) ถูกใช้เป็นบัญชีรับเงินของผู้รับ ${i.payout.owners} รายในระบบ`,
        itemRef(i)));
    }
  }
  // 6) แก้งบการเงินปีที่เคยแจ้งแล้ว หลังจากเริ่มขอกู้
  const firstListing = (f.listings || []).filter((x) => x.listed_at || ['Review', 'Listed', 'Offered', 'Matched', 'Signed', 'Active', 'Closed'].includes(x.status))
    .map((x) => new Date(x.created_at)).sort((a, b) => a - b)[0];
  const FIN_TH = { total_assets: 'สินทรัพย์รวม', total_liabilities: 'หนี้สินรวม', equity: 'ทุนของสหกรณ์', current_assets: 'สินทรัพย์หมุนเวียน', current_liabilities: 'หนี้สินหมุนเวียน', revenue: 'รายได้รวม', net_income: 'กำไรสุทธิ' };
  for (const h of f.history || []) {
    if (!firstListing || new Date(h.changed_at) < firstListing) continue;
    const oldBy = Object.fromEntries((h.old_financials || []).map((y) => [y.year, y]));
    const changes = [];
    (h.new_financials || []).forEach((y) => {
      const o = oldBy[y.year]; if (!o) return;
      ['total_assets', 'total_liabilities', 'equity', 'current_assets', 'current_liabilities', 'revenue', 'net_income'].forEach((k) => {
        if (n(o[k]) !== null && n(y[k]) !== null && Math.abs(Number(o[k]) - Number(y[k])) > 0.5) {
          changes.push({ year: y.year, field: k, label: FIN_TH[k], from: Number(o[k]), to: Number(y[k]), pct: Number(o[k]) ? Math.abs((Number(y[k]) - Number(o[k])) / Number(o[k])) * 100 : 100 });
        }
      });
    });
    if (changes.length) {
      const big = changes.some((x) => x.pct >= 10);
      out.push(sig('fr_backdated_edit', big ? 'high' : 'warning', `${h.history_id}`,
        `แก้ตัวเลขงบการเงินของปีที่แจ้งไว้แล้ว ${changes.length} รายการ หลังเริ่มขอกู้ เช่น ปี ${changes[0].year} ${FIN_TH[changes[0].field]} จาก ${fmt(changes[0].from)} เป็น ${fmt(changes[0].to)} — ขอเอกสารงบที่ผู้สอบบัญชีรับรอง`,
        { ...ref, detail_changes: changes.slice(0, 10) }));
    }
  }
  // 7) แตกโครงการ: หลายโครงการประเภทเดียวกันในช่วงสั้น รวมกันเกินวงเงินกู้ยืมที่เหลือ หรือ 3 โครงการขึ้นไป
  const p = f.borrower.profile || {};
  const ext = (p.debts || []).reduce((a, x) => a + (n(x.outstanding) || 0), 0);
  const capacity = n(p.max_borrowing) !== null ? Number(p.max_borrowing) - ext : null;
  const live = (f.listings || []).filter((x) => !['Withdrawn', 'Closed'].includes(x.status) && daysBetween(x.created_at, today) <= s.fraud_split_days);
  const byType = {};
  live.forEach((x) => { (byType[x.project_type] = byType[x.project_type] || []).push(x); });
  for (const [type, ls] of Object.entries(byType)) {
    if (ls.length < 2) continue;
    const sum = ls.reduce((a, x) => a + Number(x.amount_requested), 0);
    const over = capacity !== null && sum > capacity + 0.004;
    if (over || ls.length >= 3) {
      out.push(sig('fr_split_listing', over ? 'high' : 'warning', `${org}:${type}`,
        `${ls.length} โครงการประเภทเดียวกันภายใน ${s.fraud_split_days} วัน รวม ${fmt(sum)} บาท${over ? ` เกินวงเงินกู้ยืมที่เหลือตามมติที่ประชุมใหญ่ (${fmt(capacity)} บาท หลังหักหนี้เดิม)` : ''}`,
        { ...ref, listing_id: ls[ls.length - 1].listing_id }));
    }
  }
  // 8) งบที่กรอกไม่ตรงกับงบจากแหล่งทางการ (ทะเบียนสหกรณ์ล่วงหน้า — grant_coop_registry.sql)
  if (f.official && f.official.rows && f.official.rows.length) {
    const mm = CR.compareOfficial(p.financials || [], f.official.rows, s.fraud_official_diff_pct);
    if (mm.length) {
      const big = mm.some((x) => x.diff_pct >= Math.max(10, s.fraud_official_diff_pct * 2));
      const x = mm[0];
      out.push(sig('fr_official_mismatch', big ? 'high' : 'warning', `${org}`,
        `งบที่สหกรณ์กรอกต่างจาก${f.official.source ? ` ${f.official.source}` : 'ข้อมูลทางการ'} ${mm.length} รายการ เช่น ปี ${x.year} ${x.label} กรอก ${fmt(x.declared)} แต่ข้อมูลทางการ ${fmt(x.official)} (ต่างร้อยละ ${fmt(x.diff_pct, 1)}) — เกณฑ์ร้อยละ ${s.fraud_official_diff_pct}`,
        { ...ref, detail_changes: mm.slice(0, 10).map((m) => ({ year: m.year, field: m.field, label: `${m.label} (ทางการ → กรอก)`, from: m.official, to: m.declared, pct: m.diff_pct })) }));
    }
  }
  return out;
}

module.exports = { DEFAULTS, CODES, cfg, earlyWarnings, fraudSignals, personNames };
