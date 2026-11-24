/**
 * ระบบแนะนำการแก้ปัญหานมเกินกำลังรับซื้อ (backend/db/grant_dairy_surplus_cases.sql).
 *
 * 1) ตรวจหา "กรณีนมเกิน"
 *    - ศูนย์รับนม วันนี้: นมรับแล้ววันนี้ − ส่งออกแล้ววันนี้ + รอบถัดไป (เฉลี่ย 14 วัน) > ความจุถัง
 *    - สหกรณ์ 7 วัน: นมเข้าเฉลี่ย 14 วัน > max(ที่ผูกพันไว้ 7 วันข้างหน้า, ที่ส่งจริงเฉลี่ย 14 วัน) + โรงนมของตน
 *    - สหกรณ์ 30/60/90 วัน: จาก core.forecast() เอาช่วงแรกที่เกินเกณฑ์เตือน (ช่วงเดียว ไม่ซ้ำ)
 * 2) สร้างทางเลือกแก้ไข → คำนวณรายได้สุทธิ/กก. (ราคา − ค่าขนส่ง − ค่าแปรรูป) → ทำได้ทันเวลาไหม
 *    → เรียงอันดับ (ทำได้ก่อน แล้วมูลค่ารวมสูงสุด) → อันดับ 1-3 + "ขอความช่วยเหลือจังหวัด" ท้ายสุดเสมอ
 * 3) สแกน: อัปเดตกรณีเดิม / เปิดกรณีใหม่ / ปิดกรณีที่หายไปเอง (Cleared) / ยกระดับกรณีที่เลยกำหนด (Escalated)
 *
 * ระบบแนะนำเท่านั้น — ไม่ส่งข้อเสนอหรือทำสัญญาเอง ผู้จัดการสหกรณ์กดอนุมัติใน routes/dairy.js.
 * ฟังก์ชันส่วนบน (detect*, buildOptions, rankOptions) เป็น pure function ทดสอบได้โดยไม่ต้องมีฐานข้อมูล.
 */
const { round2, bkkToday, addDays } = require('./dairy');

// โหลดตอนใช้ (ส่วน pure function ด้านบนทดสอบได้โดยไม่ต้องมี pg)
const core = () => require('./dairyCore'); // eslint-disable-line global-require
const withServiceRole = (fn) => require('../db/pool').withServiceRole(fn); // eslint-disable-line global-require

const ROAD_FACTOR = 1.3; // ระยะทางถนน ≈ ระยะเส้นตรง × 1.3
const ASSUMED_KM = 150; // ไม่มีพิกัด → ประมาณค่าขนส่งที่ 150 กม. (บอกผู้ใช้ว่าเป็นค่าประมาณ)
const BUYER_EXTRA_SHARE = 0.2; // สมมติผู้ซื้อตามสัญญารับเพิ่มได้ไม่เกิน 20% ของปริมาณสัญญา
const LEAD_HOURS = {
  transfer_center: 3, buyer_extra: 6, own_plant: 12, processor_match: 24, gov_help: 48, directory_buyer: 72, herd_plan: 336,
};
const ACT_HOURS = { '7d': 72, '30d': 7 * 24, '60d': 14 * 24, '90d': 30 * 24 };
const HORIZON_DAYS = { today: 1, '7d': 7, '30d': 30, '60d': 60, '90d': 90 };
// หลังปิดกรณี (แก้แล้ว/ไม่ใช่ปัญหา) ไม่เปิดกรณีเดิมซ้ำภายในกี่ชั่วโมง — ค่าเฉลี่ย 14 วันยังไม่ทันลด
const COOLDOWN_HOURS = { today: 12, '7d': 72, '30d': 168, '60d': 168, '90d': 168 };
const LONG_LIFE = ['uht', 'powder', 'cheese', 'butter', 'yogurt', 'pasteurized'];

const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const pos = (v) => Math.max(0, Number(v) || 0);

function haversineKm(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const R = 6371;
  const rad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** ระดับเตือนจาก % เกิน เทียบเกณฑ์ของสหกรณ์ (ไม่มีกำลังรับเลย = แดง). */
function levelOf(surplusKg, capacityKg, s) {
  if (!(capacityKg > 0)) return { level: 'red', pct: null };
  const pct = round2((surplusKg / capacityKg) * 100);
  if (pct > Number(s.alert_red_pct)) return { level: 'red', pct };
  if (pct > Number(s.alert_orange_pct)) return { level: 'orange', pct };
  if (pct > Number(s.alert_yellow_pct)) return { level: 'yellow', pct };
  return { level: 'green', pct };
}

/**
 * ศูนย์รับนม วันนี้. center: { center_id, name, tank_capacity_kg, accepted_today_kg, shipped_today_kg, next_round_kg, measured_tank_kg? }.
 * มีค่าวัดจริงจากเซนเซอร์ระดับถัง (measured_tank_kg) → ใช้แทน "รับ − ส่ง" ที่คำนวณจากบันทึก.
 * เกินความจุอยู่แล้ว = แดง, จะเกินเมื่อรับรอบถัดไป = ส้ม.
 */
function detectCenter(center, s, now = new Date()) {
  const cap = n(center.tank_capacity_kg);
  if (!(cap > 0)) return null;
  const measured = n(center.measured_tank_kg);
  const unshipped = measured !== null ? pos(measured) : pos(n(center.accepted_today_kg) - n(center.shipped_today_kg));
  const next = pos(center.next_round_kg);
  const projected = unshipped + next;
  const surplus = round2(projected - cap);
  if (surplus < Number(s.surplus_min_kg_center) || surplus <= 0) return null;
  return {
    scope: 'center', horizon: 'today', center_id: center.center_id, center_name: center.name,
    alert_level: unshipped > cap ? 'red' : 'orange', expected_kg_day: round2(projected), capacity_kg_day: round2(cap),
    surplus_kg_day: surplus, surplus_pct: round2((surplus / cap) * 100), days: 1,
    deadline_at: new Date(now.getTime() + Number(s.surplus_hold_hours || 24) * 3600 * 1000),
    detail: {
      accepted_today_kg: round2(n(center.accepted_today_kg) || 0), shipped_today_kg: round2(n(center.shipped_today_kg) || 0),
      unshipped_kg: round2(unshipped), next_round_kg: round2(next), tank_capacity_kg: round2(cap), measured_by_sensor: measured !== null,
    },
  };
}

/**
 * สหกรณ์ 7 วัน + ช่วงพยากรณ์แรกที่เกินเกณฑ์.
 * x: { recent_avg_kg_day, committed7_kg_day, shipped14_kg_day, plant_kg_day, windows: [{days, avg_forecast_kg, avg_committed_kg}] }
 * ไม่มีข้อมูลการขายเลย (ไม่มีสัญญา/ดีล/นมโรงเรียน/การส่ง) → ไม่เปิดกรณี เพราะเทียบอะไรไม่ได้.
 */
function detectCoop(x, s, now = new Date()) {
  const out = [];
  const plant = pos(x.plant_kg_day);
  const minKg = Number(s.surplus_min_kg_coop);
  const recent = n(x.recent_avg_kg_day);
  if (recent !== null && recent > 0) {
    const cap = Math.max(pos(x.committed7_kg_day), pos(x.shipped14_kg_day)) + plant;
    const surplus = round2(recent - cap);
    if (cap > 0 && surplus >= minKg) {
      const lv = levelOf(surplus, cap, s);
      if (lv.level !== 'green') {
        out.push({
          scope: 'coop', horizon: '7d', center_id: null, alert_level: lv.level, expected_kg_day: round2(recent), capacity_kg_day: round2(cap),
          surplus_kg_day: surplus, surplus_pct: lv.pct, days: 7, deadline_at: new Date(now.getTime() + ACT_HOURS['7d'] * 3600 * 1000),
          detail: {
            recent_avg_kg_day: round2(recent), committed7_kg_day: round2(pos(x.committed7_kg_day)),
            shipped14_kg_day: round2(pos(x.shipped14_kg_day)), plant_kg_day: round2(plant),
          },
        });
      }
    }
  }
  for (const w of (x.windows || []).slice().sort((a, b) => a.days - b.days)) {
    const cap = pos(w.avg_committed_kg) + plant;
    const surplus = round2(pos(w.avg_forecast_kg) - cap);
    if (!(cap > 0) || surplus < minKg) continue; // eslint-disable-line no-continue
    const lv = levelOf(surplus, cap, s);
    if (lv.level === 'green') continue; // eslint-disable-line no-continue
    // มีกรณี 7 วันอยู่แล้ว และอนาคตไม่ได้หนักกว่าเดิมชัดเจน → เป็นปัญหาเดียวกัน ไม่เปิดซ้ำ
    const now7 = out.find((k) => k.horizon === '7d');
    if (now7 && surplus <= now7.surplus_kg_day + minKg) break;
    const horizon = `${w.days}d`;
    out.push({
      scope: 'coop', horizon, center_id: null, alert_level: lv.level, expected_kg_day: round2(w.avg_forecast_kg), capacity_kg_day: round2(cap),
      surplus_kg_day: surplus, surplus_pct: lv.pct, days: w.days, deadline_at: new Date(now.getTime() + ACT_HOURS[horizon] * 3600 * 1000),
      detail: { avg_forecast_kg: round2(w.avg_forecast_kg), avg_committed_kg: round2(w.avg_committed_kg), plant_kg_day: round2(plant) },
    });
    break; // ช่วงแรกที่เกินพอ — ช่วงยาวกว่าคือปัญหาเดียวกัน
  }
  return out;
}

/** ค่าขนส่งต่อ กก. จากพิกัด (ไม่มีพิกัด = ประมาณ ASSUMED_KM แล้วบอกเหตุผล). */
function transport(origin, target, ratePerTonKm) {
  const straight = haversineKm(origin, target);
  const rate = Number(ratePerTonKm) || 0;
  if (straight === null) return { distance_km: null, transport_per_kg: round2((ASSUMED_KM * rate) / 1000), estimated: true };
  const km = straight * ROAD_FACTOR;
  return { distance_km: Math.round(km * 10) / 10, transport_per_kg: round2((km * rate) / 1000), estimated: false };
}

/**
 * ทางเลือกทั้งหมดสำหรับกรณีหนึ่ง (ยังไม่เรียง).
 * ctx: { s, origin:{lat,lng}|null, hours_left, sale_price, buyers[], centers[], capacities[], directory[], plant_product|null, today }
 */
function buildOptions(kase, ctx) {
  const { s } = ctx;
  const surplus = Number(kase.surplus_kg_day);
  const days = Number(kase.days);
  const floor = Number(s.surplus_min_price_per_kg) || 0;
  const hoursLeft = Number(ctx.hours_left);
  const opts = [];
  const add = (o) => {
    const reasons = [...(o.reasons || [])];
    const lead = LEAD_HOURS[o.kind];
    let feasible = o.feasible !== false;
    if (lead > hoursLeft) { feasible = false; reasons.push('not_in_time'); }
    if (o.price_per_kg != null && o.kind !== 'transfer_center' && o.price_per_kg < floor) { feasible = false; reasons.push('below_min_price'); }
    if (!(o.kg_per_day > 0)) { feasible = false; reasons.push('no_capacity'); }
    const net = o.price_per_kg == null ? null : round2(o.price_per_kg - (o.transport_per_kg || 0) - (o.processing_per_kg || 0));
    opts.push({
      target_type: null, target_id: null, target_name: null, distance_km: null, transport_per_kg: null, processing_per_kg: null, price_per_kg: null,
      ...o, kg_per_day: round2(o.kg_per_day || 0), days: o.days || days, net_per_kg: net, lead_hours: lead, feasible, reasons,
    });
  };
  const withTransport = (o, target) => {
    const t = transport(ctx.origin, target, s.transport_cost_per_ton_km);
    return { ...o, distance_km: t.distance_km, transport_per_kg: t.transport_per_kg, reasons: [...(o.reasons || []), ...(t.estimated ? ['transport_estimated'] : [])] };
  };

  // 1) ศูนย์อื่นของสหกรณ์ที่ถังยังว่าง (เฉพาะกรณีระดับศูนย์)
  if (kase.scope === 'center') {
    (ctx.centers || []).filter((k) => k.center_id !== kase.center_id && pos(k.free_kg) > 0).forEach((k) => {
      add(withTransport({
        kind: 'transfer_center', target_type: 'center', target_id: k.center_id, target_name: k.name,
        kg_per_day: Math.min(surplus, pos(k.free_kg)), days: 1, price_per_kg: ctx.sale_price, reasons: ['moves_storage_only'],
      }, k));
    });
  }
  // 2) ผู้ซื้อตามสัญญาเดิมรับเพิ่ม (เส้นทางขนส่งเดิม ไม่คิดค่าขนส่งเพิ่ม)
  (ctx.buyers || []).forEach((b) => {
    add({
      kind: 'buyer_extra', target_type: 'partner', target_id: b.partner_id, target_name: b.name,
      kg_per_day: Math.min(surplus, round2(Number(b.daily_kg) * BUYER_EXTRA_SHARE)), price_per_kg: n(b.price_per_kg), transport_per_kg: 0,
      reasons: ['confirm_by_phone', 'assumed_20pct_of_contract'],
    });
  });
  // 3) โรงงานที่ประกาศกำลังรับว่างในตลาดนมส่วนเกิน (ช่วงเวลาทับกัน)
  const start = ctx.today;
  const end = addDays(start, Math.max(0, days - 1));
  (ctx.capacities || []).filter((k) => String(k.available_from).slice(0, 10) <= end && String(k.available_to).slice(0, 10) >= start).forEach((k) => {
    add(withTransport({
      kind: 'processor_match', target_type: 'capacity', target_id: k.capacity_id, target_name: k.display_name,
      kg_per_day: Math.min(surplus, Number(k.kg_per_day)), price_per_kg: n(k.price_per_kg), reasons: ['needs_processor_accept'],
    }, k));
  });
  // 4) ผู้รับซื้อในทะเบียนตลาดน้ำนม (จังหวัดเดียวกัน ยังไม่ได้เป็นผู้ใช้ระบบ — ต้องติดต่อเอง)
  (ctx.directory || []).forEach((d) => {
    const capKg = n(d.processing_capacity_l_day);
    add({
      kind: 'directory_buyer', target_type: 'directory', target_id: d.entry_id, target_name: d.name,
      kg_per_day: capKg ? Math.min(surplus, capKg * 1.03) : surplus, price_per_kg: n(d.price_baht_per_kg),
      transport_per_kg: round2((ASSUMED_KM * (Number(s.transport_cost_per_ton_km) || 0)) / 1000),
      reasons: ['contact_needed', 'transport_estimated', ...(capKg ? [] : ['capacity_unknown']), ...(d.price_baht_per_kg == null ? ['price_unknown'] : [])],
    });
  });
  // 5) แปรรูปเองเป็นผลิตภัณฑ์อายุยาว (มีโรงนม)
  if (ctx.plant_product) {
    const p = ctx.plant_product;
    const spare = ctx.plant_spare_kg == null ? null : pos(ctx.plant_spare_kg); // null = ไม่มีประวัติการผลิต
    add({
      kind: 'own_plant', target_type: 'product', target_id: p.product_id, target_name: p.name, kg_per_day: spare == null ? surplus : Math.min(surplus, spare),
      price_per_kg: round2(Number(p.sell_price) / Number(p.milk_kg_per_unit)), processing_per_kg: Number(s.processing_cost_per_kg) || 0,
      reasons: [spare == null ? 'check_plant_capacity' : 'spare_from_history', 'needs_product_market', ...(Number(s.processing_cost_per_kg) > 0 ? [] : ['processing_cost_not_set'])],
    });
  }
  // 6) วางแผนฝูง (ลดน้ำนมที่ต้นทาง) — เฉพาะช่วง 30 วันขึ้นไป
  if (['30d', '60d', '90d'].includes(kase.horizon)) {
    add({
      kind: 'herd_plan', target_type: null, target_name: null, kg_per_day: Math.min(surplus, round2(Number(kase.expected_kg_day) * 0.05)),
      price_per_kg: null, reasons: ['dry_off_early', 'cull_low_yield', 'adjust_concentrate'],
    });
  }
  return opts;
}

/** เรียง: ทำได้ทันก่อน → มูลค่ารวม (สุทธิ/กก. × กก.) สูงสุด → เร็วกว่า. คืนอันดับ 1..top + gov_help ท้ายสุด. */
function rankOptions(opts, kase, top = 3) {
  const value = (o) => (o.net_per_kg == null ? 0 : o.net_per_kg * o.kg_per_day);
  const sorted = opts.slice().sort((a, b) => (b.feasible - a.feasible) || (value(b) - value(a)) || (a.lead_hours - b.lead_hours));
  const picked = sorted.slice(0, top);
  const covered = picked.filter((o) => o.feasible).reduce((a, o) => a + o.kg_per_day, 0);
  picked.push({
    kind: 'gov_help', target_type: 'province', target_id: null, target_name: null, kg_per_day: round2(Math.max(0, Number(kase.surplus_kg_day) - covered) || Number(kase.surplus_kg_day)),
    days: Number(kase.days), price_per_kg: null, transport_per_kg: null, processing_per_kg: null, net_per_kg: null, distance_km: null,
    lead_hours: LEAD_HOURS.gov_help, feasible: true, reasons: covered >= Number(kase.surplus_kg_day) ? ['backup'] : ['uncovered_surplus'],
  });
  return picked.map((o, i) => ({ ...o, rank: i + 1 }));
}

// ===========================================================================
// ส่วนที่ใช้ฐานข้อมูล
// ===========================================================================
async function centerStats(c, coop, today) {
  return (await c.query(
    `SELECT cc.center_id, cc.name, cc.tank_capacity_kg, cc.lat, cc.lng,
            (SELECT COALESCE(SUM(i.weight_kg),0) FROM dairy.milk_intake i JOIN dairy.milk_round r USING (round_id)
              WHERE r.center_id=cc.center_id AND r.round_date=$2 AND i.status='Accepted')::numeric AS accepted_today_kg,
            (SELECT COALESCE(SUM(sent_kg),0) FROM dairy.shipment sh WHERE sh.center_id=cc.center_id AND sh.ship_date=$2 AND sh.status<>'Cancelled')::numeric AS shipped_today_kg,
            (SELECT COALESCE(AVG(r.accepted_kg),0) FROM dairy.milk_round r
              WHERE r.center_id=cc.center_id AND r.status='Closed' AND r.round_date >= $2::date - 14 AND r.round_date < $2)::numeric AS next_round_kg,
            -- ปริมาณนมในถังที่วัดจริงจากเซนเซอร์ (ผ่าน gateway) ภายใน 60 นาที — ไม่มี = NULL ใช้ค่าคำนวณแทน
            (SELECT SUM(x.level_kg) FROM dairy.iot_device d CROSS JOIN LATERAL (
               SELECT level_kg FROM dairy.iot_reading r WHERE r.device_id=d.device_id AND r.level_kg IS NOT NULL AND r.recorded_at >= now() - interval '60 minutes'
                ORDER BY r.recorded_at DESC LIMIT 1) x
              WHERE d.center_id=cc.center_id AND d.device_type='cooling_tank' AND d.active)::numeric AS measured_tank_kg
       FROM dairy.collection_center cc WHERE cc.coop_org_id=$1 AND cc.active ORDER BY cc.created_at`, [coop, today],
  )).rows;
}

/** ทุกอย่างที่ต้องใช้สร้างทางเลือก (โหลดครั้งเดียวต่อการสแกน). */
async function loadContext(c, coop, s, today, centers) {
  const buyers = (await c.query(
    `SELECT p.partner_id, p.name, SUM(k.daily_kg)::numeric AS daily_kg, ROUND(AVG(k.price_per_kg),2) AS price_per_kg
       FROM dairy.contract k JOIN dairy.partner p ON p.partner_id=k.partner_id
      WHERE k.coop_org_id=$1 AND k.status='Active' AND $2 BETWEEN k.start_date AND k.end_date AND p.active
      GROUP BY p.partner_id, p.name ORDER BY price_per_kg DESC`, [coop, today],
  )).rows;
  const capacities = (await c.query(
    `SELECT k.capacity_id, k.org_id, k.available_from::text, k.available_to::text, k.kg_per_day, k.price_per_kg, pp.display_name, pp.province_code, pp.lat, pp.lng
       FROM dairy.processor_capacity k JOIN dairy.processor_profile pp ON pp.org_id=k.org_id AND pp.active
      WHERE k.active AND k.available_to >= $1 ORDER BY k.price_per_kg DESC LIMIT 30`, [today],
  )).rows;
  const prov = (await c.query('SELECT province_code FROM registry.cooperative_profile WHERE org_id=$1', [coop])).rows[0];
  let directory = [];
  const hasDir = (await c.query(`SELECT to_regclass('dairy.market_directory') IS NOT NULL AS ok`)).rows[0].ok;
  if (hasDir && prov && prov.province_code) {
    directory = (await c.query(
      `SELECT d.entry_id, d.name, d.processing_capacity_l_day, d.price_baht_per_kg, d.phone, d.contact_phone
         FROM dairy.market_directory d
        WHERE d.province_code=$1 AND d.buys_raw_milk='yes' AND d.status IN ('verified','onboarded')
          AND (d.linked_org_id IS NULL OR d.linked_org_id NOT IN (SELECT linked_org_id FROM dairy.partner WHERE coop_org_id=$2 AND linked_org_id IS NOT NULL))
        ORDER BY d.price_baht_per_kg DESC NULLS LAST LIMIT 3`, [prov.province_code, coop],
    )).rows;
  }
  let plantProduct = null;
  if (s.has_processing_plant) {
    plantProduct = (await c.query(
      `SELECT product_id, name, product_type, sell_price, milk_kg_per_unit, shelf_life_days FROM dairy.product
        WHERE coop_org_id=$1 AND active AND sell_price > 0 AND product_type = ANY($2)
        ORDER BY (shelf_life_days >= 30) DESC, sell_price / milk_kg_per_unit DESC LIMIT 1`, [coop, LONG_LIFE],
    )).rows[0] || null;
  }
  // กำลังผลิตว่างของโรงนม ≈ วันที่ใช้นมมากที่สุดใน 30 วัน − ค่าเฉลี่ย 14 วัน (ไม่มีประวัติ = ไม่ทราบ)
  let plantSpare = null;
  if (plantProduct) {
    const pr = (await c.query(
      `WITH d AS (SELECT produced_on, SUM(milk_used_kg) AS kg FROM dairy.production_batch WHERE coop_org_id=$1 AND produced_on >= $2::date - 30 GROUP BY produced_on)
       SELECT COUNT(*)::int AS n, COALESCE(MAX(kg),0) AS peak, COALESCE(SUM(kg) FILTER (WHERE produced_on >= $2::date - 14),0) / 14 AS avg14 FROM d`, [coop, today],
    )).rows[0];
    if (pr.n >= 3) plantSpare = Number(pr.peak) - Number(pr.avg14);
  }
  const salePrice = buyers.length
    ? round2(buyers.reduce((a, b) => a + Number(b.price_per_kg) * Number(b.daily_kg), 0) / buyers.reduce((a, b) => a + Number(b.daily_kg), 0))
    : Number(s.base_price_per_kg) || 0;
  const coopOrigin = centers.find((k) => k.lat != null && k.lng != null) || null;
  return {
    s, today, buyers, capacities, directory, plant_product: plantProduct, plant_spare_kg: plantSpare, sale_price: salePrice, coopOrigin,
    // ที่ว่างในถัง = ความจุ − นมค้างถัง − รอบถัดไปของศูนย์นั้นเอง
    centers: centers.map((k) => {
      const inTank = n(k.measured_tank_kg) !== null ? pos(n(k.measured_tank_kg)) : pos(n(k.accepted_today_kg) - n(k.shipped_today_kg));
      return { ...k, free_kg: pos(n(k.tank_capacity_kg) - inTank - pos(k.next_round_kg)) };
    }),
  };
}

async function coopFigures(c, coop, s, today) {
  const f = await core().forecast(c, coop, 90);
  const committed7 = f.days.slice(0, 7).reduce((a, d) => a + d.committed_kg, 0) / 7;
  const [x] = (await c.query(
    `SELECT (SELECT COALESCE(SUM(sent_kg),0) FROM dairy.shipment WHERE coop_org_id=$1 AND status IN ('Sent','Received') AND ship_date >= $2::date - 14 AND ship_date < $2)::numeric / 14 AS shipped14,
            (SELECT COALESCE(SUM(milk_used_kg),0) FROM dairy.production_batch WHERE coop_org_id=$1 AND produced_on >= $2::date - 14 AND produced_on < $2)::numeric / 14 AS plant`,
    [coop, today],
  )).rows;
  return {
    recent_avg_kg_day: f.recent_avg_kg_day, committed7_kg_day: committed7, shipped14_kg_day: Number(x.shipped14),
    plant_kg_day: s.has_processing_plant ? Number(x.plant) : 0, windows: f.windows,
  };
}

const keyOf = (k) => `${k.center_id || '-'}|${k.horizon}`;
async function log(c, caseId, action, detail, who) {
  await c.query('INSERT INTO dairy.surplus_case_log (case_id, action, detail, actor) VALUES ($1,$2,$3,$4)', [caseId, action, JSON.stringify(detail || {}), who]);
}

async function writeOptions(c, kase, ctx, now) {
  const origin = kase.center_id ? (ctx.centers.find((k) => k.center_id === kase.center_id) || null) : ctx.coopOrigin;
  const usable = origin && origin.lat != null ? origin : ctx.coopOrigin;
  const hoursLeft = Math.max(0, (new Date(kase.deadline_at).getTime() - now.getTime()) / 3600000);
  // ทางเลือกที่ผู้ใช้ตัดสินใจไปแล้วไม่ถูกลบและไม่แนะนำซ้ำ
  await c.query(`DELETE FROM dairy.surplus_option WHERE case_id=$1 AND status='Suggested'`, [kase.case_id]);
  const decided = (await c.query(`SELECT kind, target_id FROM dairy.surplus_option WHERE case_id=$1`, [kase.case_id])).rows;
  const seen = new Set(decided.map((o) => `${o.kind}|${o.target_id || ''}`));
  const all = buildOptions(kase, { ...ctx, origin: usable, hours_left: hoursLeft }).filter((o) => !seen.has(`${o.kind}|${o.target_id || ''}`));
  const ranked = rankOptions(all, kase).filter((o) => !(o.kind === 'gov_help' && seen.has('gov_help|')));
  for (const o of ranked) {
    // eslint-disable-next-line no-await-in-loop
    await c.query(
      `INSERT INTO dairy.surplus_option (case_id, rank, kind, target_type, target_id, target_name, kg_per_day, days, price_per_kg, transport_per_kg,
         processing_per_kg, net_per_kg, distance_km, lead_hours, feasible, reasons)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [kase.case_id, o.rank, o.kind, o.target_type, o.target_id, o.target_name, o.kg_per_day, Math.min(90, Math.max(1, o.days)), o.price_per_kg,
        o.transport_per_kg, o.processing_per_kg, o.net_per_kg, o.distance_km, o.lead_hours, o.feasible, JSON.stringify(o.reasons)],
    );
  }
  return ranked.length;
}

/**
 * สแกนหนึ่งสหกรณ์ (client ต้องถูก scope แล้ว และ coop เป็นของผู้เรียก). ต้องเรียกใน transaction.
 * คืน { detected, opened, updated, cleared, escalated }.
 */
async function scanCoop(c, coop, who = 'system', now = new Date()) {
  const s = await core().settings(c, coop);
  if (!s) return { detected: 0, opened: 0, updated: 0, cleared: 0, escalated: 0 };
  const today = bkkToday();
  const centers = await centerStats(c, coop, today);
  const found = [
    ...centers.map((k) => detectCenter(k, s, now)).filter(Boolean),
    ...detectCoop(await coopFigures(c, coop, s, today), s, now),
  ];
  const ctx = await loadContext(c, coop, s, today, centers);
  const active = (await c.query(
    `SELECT * FROM dairy.surplus_case WHERE coop_org_id=$1 AND status IN ('Open','Acting','Escalated') FOR UPDATE`, [coop],
  )).rows;
  const byKey = new Map(active.map((k) => [keyOf(k), k]));
  const recent = (await c.query(
    `SELECT center_id, horizon, closed_at FROM dairy.surplus_case WHERE coop_org_id=$1 AND status IN ('Resolved','Dismissed') AND closed_at >= $2::timestamptz - interval '7 days'`,
    [coop, now],
  )).rows;
  const cooling = new Set(recent.filter((k) => now.getTime() - new Date(k.closed_at).getTime() < COOLDOWN_HOURS[k.horizon] * 3600000).map(keyOf));
  const out = { detected: found.length, opened: 0, updated: 0, cleared: 0, escalated: 0 };
  const hit = new Set();
  for (const f of found) {
    const key = keyOf(f);
    hit.add(key);
    const cur = byKey.get(key);
    if (!cur && cooling.has(key)) { out.cooling = (out.cooling || 0) + 1; continue; } // eslint-disable-line no-continue
    let row;
    if (cur) {
      // eslint-disable-next-line no-await-in-loop
      row = (await c.query(
        `UPDATE dairy.surplus_case SET alert_level=$2, expected_kg_day=$3, capacity_kg_day=$4, surplus_kg_day=$5, surplus_pct=$6, detail=$7, last_detected_at=now()
          WHERE case_id=$1 RETURNING *`,
        [cur.case_id, f.alert_level, f.expected_kg_day, f.capacity_kg_day, f.surplus_kg_day, f.surplus_pct, JSON.stringify(f.detail)],
      )).rows[0];
      out.updated += 1;
    } else {
      // eslint-disable-next-line no-await-in-loop
      row = (await c.query(
        `INSERT INTO dairy.surplus_case (coop_org_id, center_id, horizon, scope, alert_level, expected_kg_day, capacity_kg_day, surplus_kg_day, surplus_pct, days, detail, deadline_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [coop, f.center_id, f.horizon, f.scope, f.alert_level, f.expected_kg_day, f.capacity_kg_day, f.surplus_kg_day, f.surplus_pct, f.days,
          JSON.stringify(f.detail), f.deadline_at],
      )).rows[0];
      // eslint-disable-next-line no-await-in-loop
      await log(c, row.case_id, 'detected', { surplus_kg_day: f.surplus_kg_day, alert_level: f.alert_level }, who);
      out.opened += 1;
    }
    // eslint-disable-next-line no-await-in-loop
    if (row.status !== 'Acting') await writeOptions(c, row, ctx, now);
  }
  for (const k of active) {
    if (hit.has(keyOf(k))) continue; // eslint-disable-line no-continue
    if (k.status === 'Open') {
      // eslint-disable-next-line no-await-in-loop
      await c.query(`UPDATE dairy.surplus_case SET status='Cleared', closed_at=now(), closed_by='system' WHERE case_id=$1`, [k.case_id]);
      // eslint-disable-next-line no-await-in-loop
      await log(c, k.case_id, 'cleared', {}, 'system');
      out.cleared += 1;
    }
  }
  const overdue = (await c.query(
    `UPDATE dairy.surplus_case SET status='Escalated', escalated_at=now(), escalation_note=COALESCE(escalation_note, 'เลยกำหนดเวลาโดยยังไม่มีทางแก้ที่อนุมัติ')
      WHERE coop_org_id=$1 AND status='Open' AND deadline_at < $2 RETURNING case_id`, [coop, now],
  )).rows;
  for (const k of overdue) await log(c, k.case_id, 'auto_escalated', {}, 'system'); // eslint-disable-line no-await-in-loop
  out.escalated = overdue.length;
  return out;
}

/** สแกนทุกสหกรณ์ที่มีรอบรับนมใน 14 วัน (ใช้ service role — ใช้เฉพาะงานเบื้องหลัง). */
let scanning = false;
async function scanAll() {
  if (scanning) return { skipped: true };
  scanning = true;
  const out = { coops: 0, opened: 0, failed: 0 };
  try {
    const coops = await withServiceRole(async (c) => (await c.query(
      `SELECT DISTINCT r.coop_org_id FROM dairy.milk_round r JOIN dairy.setting s ON s.coop_org_id=r.coop_org_id
        WHERE r.round_date >= $1::date - 14`, [bkkToday()],
    )).rows.map((r) => r.coop_org_id));
    for (const coop of coops) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await withServiceRole(async (c) => {
          await c.query('BEGIN');
          try { const x = await scanCoop(c, coop); await c.query('COMMIT'); return x; } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
        });
        out.coops += 1; out.opened += r.opened;
      } catch (err) {
        out.failed += 1;
        if (err.code !== '42P01' && err.code !== '42703') console.error('[dairy-surplus] scan failed', err.message);
      }
    }
  } catch (err) {
    if (err.code !== '42P01' && err.code !== '42703') console.error('[dairy-surplus] scan list failed', err.message);
  } finally {
    scanning = false;
  }
  return out;
}

let interval = null;
/** สแกนทุก 15 นาที (เรียกครั้งเดียวจาก server.js; ปิดใน NODE_ENV=test). */
function start() {
  if (interval || process.env.NODE_ENV === 'test') return;
  interval = setInterval(() => { scanAll(); }, 15 * 60 * 1000);
  if (interval.unref) interval.unref();
}

module.exports = {
  haversineKm, levelOf, detectCenter, detectCoop, transport, buildOptions, rankOptions,
  scanCoop, scanAll, start, log, HORIZON_DAYS, LEAD_HOURS, ASSUMED_KM, COOLDOWN_HOURS,
};
