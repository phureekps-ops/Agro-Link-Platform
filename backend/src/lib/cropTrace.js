/**
 * ตรวจสอบย้อนกลับสายพืชผล (db/grant_crop_traceability.sql)
 *
 *   แปลง/สมาชิก → produce.delivery → produce.lot (LT-) → warehouse.movement/drying_reading
 *   → processing.batch (PB-) ← batch_input → processing.finished_good (FG-) → finished_good_dispatch / logistics.shipment
 *
 *   loadTrace(c, start, orgId)  ดึงสายทั้งหมดจากจุดเริ่ม: ย้อนกลับ (ต้นทาง) และตามไปข้างหน้า (ปลายทาง)
 *                               start = { type: 'lot'|'batch'|'finished_good'|'farmer', id }
 *   summarize(t, commodity)     สรุปตัวเลข + ผลยืนยันแปลงด้วยดาวเทียม (pure — ทดสอบได้)
 *   publicView(t)               เฉพาะข้อมูลที่ไม่ระบุตัวบุคคล สำหรับหน้า QR สาธารณะ (pure)
 *
 *   ทุกคำค้นจำกัดด้วย orgId ของสหกรณ์เจ้าของ — ไม่มีการข้ามไปดูข้อมูลของสหกรณ์อื่น
 */
const plotAI = require('./plotAI');
const { TH_PROVINCE_NAME } = require('./thProvinces');

const CODE_RE = /^(LT|PB|FG)-[0-9A-HJKMNP-TV-Z]{8}$/;
const PREFIX_TYPE = { LT: 'lot', PB: 'batch', FG: 'finished_good' };
/** พิมพ์เล็ก/เว้นวรรค/สับสน O-0 I-1 L-1 ในส่วนรหัส (ไม่แตะคำนำหน้า LT/PB/FG) ก็หาเจอ */
const normCode = (s) => {
  const m = String(s || '').trim().toUpperCase().replace(/\s+/g, '').match(/^([A-Z]{2})-?(.+)$/);
  return m ? `${m[1]}-${m[2].replace(/[OIL]/g, (ch) => ({ O: '0', I: '1', L: '1' }[ch]))}` : '';
};
const n = (v) => (v === null || v === undefined ? null : Number(v));
const PROCESS_TH = { Milling: 'สี/โม่', Drying: 'อบแห้ง', Sorting: 'คัดแยก', Packaging: 'บรรจุภัณฑ์', Other: 'แปรรูป' };
const uniq = (a) => [...new Set(a.filter((x) => x !== null && x !== undefined))];

/** รหัส → { type, id, org_id, public_trace } หรือ null */
async function resolveCode(c, raw) {
  const code = normCode(raw);
  if (!CODE_RE.test(code)) return null;
  const type = PREFIX_TYPE[code.slice(0, 2)];
  const sql = {
    lot: 'SELECT lot_id AS id, buyer_org_id AS org_id, public_trace FROM produce.lot WHERE trace_code = $1',
    batch: 'SELECT batch_id AS id, org_id, false AS public_trace FROM processing.batch WHERE trace_code = $1',
    finished_good: `SELECT fg.finished_good_id AS id, b.org_id, fg.public_trace FROM processing.finished_good fg
                     JOIN processing.batch b ON b.batch_id = fg.batch_id WHERE fg.trace_code = $1`,
  }[type];
  const r = (await c.query(sql, [code])).rows[0];
  return r ? { type, code, ...r } : null;
}

async function loadTrace(c, start, orgId) {
  const q = async (sql, params) => (await c.query(sql, params)).rows;
  let lotIds = []; let batchIds = []; let fgIds = []; let deliveryFilter = null;
  // ---- จุดเริ่ม → ชุดต้นทาง (ย้อนกลับ) และชุดปลายทาง (ตามไปข้างหน้า)
  if (start.type === 'finished_good') {
    const fg = (await q('SELECT fg.finished_good_id, fg.batch_id FROM processing.finished_good fg JOIN processing.batch b ON b.batch_id = fg.batch_id WHERE fg.finished_good_id = $1 AND b.org_id = $2', [start.id, orgId]))[0];
    if (!fg) return null;
    fgIds = [fg.finished_good_id]; batchIds = [fg.batch_id];
    lotIds = (await q('SELECT DISTINCT lot_id FROM processing.batch_input WHERE batch_id = $1', [fg.batch_id])).map((r) => r.lot_id);
  } else if (start.type === 'batch') {
    const b = (await q('SELECT batch_id FROM processing.batch WHERE batch_id = $1 AND org_id = $2', [start.id, orgId]))[0];
    if (!b) return null;
    batchIds = [b.batch_id];
    lotIds = (await q('SELECT DISTINCT lot_id FROM processing.batch_input WHERE batch_id = $1', [b.batch_id])).map((r) => r.lot_id);
    fgIds = (await q('SELECT finished_good_id FROM processing.finished_good WHERE batch_id = $1', [b.batch_id])).map((r) => r.finished_good_id);
  } else if (start.type === 'lot' || start.type === 'farmer') {
    if (start.type === 'lot') {
      const l = (await q('SELECT lot_id FROM produce.lot WHERE lot_id = $1 AND buyer_org_id = $2', [start.id, orgId]))[0];
      if (!l) return null;
      lotIds = [l.lot_id];
    } else {
      // ตามไปข้างหน้าจากสมาชิก (ใช้ตอนเรียกคืนสินค้า): ผลผลิตของสมาชิกรายนี้ที่ส่งให้สหกรณ์นี้
      const ds = await q(
        `SELECT d.delivery_id, d.lot_id FROM produce.delivery d JOIN registry.production_unit pu ON pu.unit_id = d.unit_id
          WHERE pu.owner_farmer_id = $1 AND d.buyer_org_id = $2`, [start.id, orgId],
      );
      if (!ds.length) return { start, empty: true, lots: [], deliveries: [], batches: [], finished_goods: [], dispatches: [], shipments: [] };
      deliveryFilter = ds.map((d) => d.delivery_id);
      lotIds = uniq(ds.map((d) => d.lot_id));
    }
    batchIds = lotIds.length ? (await q('SELECT DISTINCT bi.batch_id FROM processing.batch_input bi JOIN processing.batch b ON b.batch_id = bi.batch_id WHERE bi.lot_id = ANY($1::uuid[]) AND b.org_id = $2', [lotIds, orgId])).map((r) => r.batch_id) : [];
    fgIds = batchIds.length ? (await q('SELECT finished_good_id FROM processing.finished_good WHERE batch_id = ANY($1::uuid[])', [batchIds])).map((r) => r.finished_good_id) : [];
  } else return null;

  // ---- รายละเอียดแต่ละชั้น
  const lots = lotIds.length ? await q(
    `SELECT l.lot_id, l.trace_code, l.commodity_code, cr.name_th AS commodity_name, l.quality_grade, l.status, l.lot_note, l.public_trace, l.created_at, l.closed_at
       FROM produce.lot l LEFT JOIN registry.commodity_ref cr ON cr.commodity_code = l.commodity_code
      WHERE l.lot_id = ANY($1::uuid[]) AND l.buyer_org_id = $2 ORDER BY l.created_at`, [lotIds, orgId],
  ) : [];
  const hasAI = (await q("SELECT to_regclass('ai.v_latest_assessment') IS NOT NULL AS ok"))[0].ok;
  const deliveries = lotIds.length ? await q(
    `SELECT d.delivery_id, d.lot_id, d.unit_id, d.commodity_code, d.quantity_ton, d.moisture_pct, d.quality_grade, d.status, d.delivered_at,
            f.farmer_id, f.full_name AS farmer_name, f.farmer_code, f.region_code, pu.area_rai,
            CASE WHEN pu.gps_boundary IS NOT NULL THEN ST_Y(ST_Centroid(pu.gps_boundary)) END AS lat,
            CASE WHEN pu.gps_boundary IS NOT NULL THEN ST_X(ST_Centroid(pu.gps_boundary)) END AS lon
            ${hasAI ? ', va.predicted_crop, va.confirmed_crop, va.declared_crop, va.crop_confidence, va.assessed_at' : ''}
       FROM produce.delivery d
       LEFT JOIN registry.production_unit pu ON pu.unit_id = d.unit_id
       LEFT JOIN identity.farmer f ON f.farmer_id = pu.owner_farmer_id
       ${hasAI ? 'LEFT JOIN ai.v_latest_assessment va ON va.unit_id = d.unit_id' : ''}
      WHERE d.lot_id = ANY($1::uuid[]) AND d.buyer_org_id = $2 ${deliveryFilter ? 'AND d.delivery_id = ANY($3::uuid[])' : ''}
      ORDER BY d.delivered_at`, deliveryFilter ? [lotIds, orgId, deliveryFilter] : [lotIds, orgId],
  ) : [];
  const movements = lotIds.length ? await q(
    `SELECT m.lot_id, m.movement_type, m.quantity_ton, m.moisture_pct, m.recorded_at, fb.bin_code AS from_bin, tb.bin_code AS to_bin, COALESCE(tf.facility_name, ff.facility_name) AS facility_name
       FROM warehouse.movement m LEFT JOIN warehouse.bin fb ON fb.bin_id = m.from_bin_id LEFT JOIN warehouse.bin tb ON tb.bin_id = m.to_bin_id
       LEFT JOIN warehouse.facility ff ON ff.facility_id = fb.facility_id LEFT JOIN warehouse.facility tf ON tf.facility_id = tb.facility_id
      WHERE m.lot_id = ANY($1::uuid[]) ORDER BY m.recorded_at`, [lotIds],
  ) : [];
  const drying = lotIds.length ? await q(
    `SELECT lot_id, COUNT(*)::int AS readings, MIN(recorded_at) AS first_at, MAX(recorded_at) AS last_at,
            (ARRAY_AGG(moisture_pct ORDER BY recorded_at))[1] AS first_moisture, (ARRAY_AGG(moisture_pct ORDER BY recorded_at DESC))[1] AS last_moisture
       FROM warehouse.drying_reading WHERE lot_id = ANY($1::uuid[]) GROUP BY lot_id`, [lotIds],
  ) : [];
  const batches = batchIds.length ? await q(
    `SELECT s.batch_id, b.trace_code, s.facility_name, s.source_commodity_code, s.source_commodity_name, s.process_type, s.output_product_name, s.status,
            s.started_at, s.completed_at, s.input_quantity_ton, s.output_quantity_ton, s.yield_pct
       FROM processing.v_batch_summary s JOIN processing.batch b ON b.batch_id = s.batch_id
      WHERE s.batch_id = ANY($1::uuid[]) AND s.org_id = $2 ORDER BY s.started_at`, [batchIds, orgId],
  ) : [];
  const inputs = batchIds.length ? await q('SELECT batch_id, lot_id, quantity_ton, recorded_at FROM processing.batch_input WHERE batch_id = ANY($1::uuid[]) ORDER BY recorded_at', [batchIds]) : [];
  const fgs = fgIds.length ? await q(
    `SELECT fg.finished_good_id, fg.trace_code, fg.batch_id, fg.product_name, fg.quantity_ton, fg.is_primary_product, fg.public_trace, fg.recorded_at,
            COALESCE((SELECT SUM(x.quantity_ton) FROM processing.finished_good_dispatch x WHERE x.finished_good_id = fg.finished_good_id), 0) AS dispatched_ton
       FROM processing.finished_good fg WHERE fg.finished_good_id = ANY($1::uuid[]) ORDER BY fg.recorded_at`, [fgIds],
  ) : [];
  const dispatches = fgIds.length ? await q(
    'SELECT finished_good_id, quantity_ton, recorded_at, note FROM processing.finished_good_dispatch WHERE finished_good_id = ANY($1::uuid[]) ORDER BY recorded_at', [fgIds],
  ) : [];
  // เที่ยวขนส่ง: สินค้าสำเร็จรูปของสายนี้ + ล็อตที่ส่งออกดิบ (เฉพาะเมื่อเริ่มจากล็อต/สมาชิก — เริ่มจากสินค้าจะไม่นับล็อตต้นทางที่ส่งไปที่อื่น)
  const shipLots = ['lot', 'farmer'].includes(start.type) ? lotIds : [];
  const shipItems = (fgIds.length || shipLots.length) ? await q(
    `SELECT si.shipment_id, si.item_type, si.lot_id, si.finished_good_id, si.quantity_ton, sh.destination_name, o.org_name AS destination_org_name, sh.status, sh.scheduled_at, sh.dispatched_at, sh.delivered_at
       FROM logistics.shipment_item si JOIN logistics.shipment sh ON sh.shipment_id = si.shipment_id LEFT JOIN identity.organization o ON o.org_id = sh.destination_org_id
      WHERE sh.org_id = $3 AND sh.status <> 'Cancelled' AND (si.finished_good_id = ANY($1::uuid[]) OR si.lot_id = ANY($2::uuid[]))
      ORDER BY COALESCE(sh.dispatched_at, sh.scheduled_at, si.recorded_at)`, [fgIds, shipLots, orgId],
  ) : [];
  const shipments = Object.values(shipItems.reduce((acc, s) => {
    const k = s.shipment_id;
    acc[k] = acc[k] || { shipment_id: k, destination: s.destination_org_name || s.destination_name, status: s.status, scheduled_at: s.scheduled_at, dispatched_at: s.dispatched_at, delivered_at: s.delivered_at, items: [] };
    acc[k].items.push({ item_type: s.item_type, lot_id: s.lot_id, finished_good_id: s.finished_good_id, quantity_ton: n(s.quantity_ton) });
    return acc;
  }, {}));

  const byLot = (arr) => arr.reduce((a, x) => { (a[x.lot_id] = a[x.lot_id] || []).push(x); return a; }, {});
  const delBy = byLot(deliveries); const movBy = byLot(movements);
  const dryBy = Object.fromEntries(drying.map((d) => [d.lot_id, d]));
  return {
    start,
    lots: lots.map((l) => ({
      ...l,
      quantity_ton: (delBy[l.lot_id] || []).reduce((a, d) => a + Number(d.quantity_ton), 0),
      delivery_count: (delBy[l.lot_id] || []).length,
      movements: (movBy[l.lot_id] || []).map((m) => ({ ...m, quantity_ton: n(m.quantity_ton), moisture_pct: n(m.moisture_pct) })),
      drying: dryBy[l.lot_id] ? { ...dryBy[l.lot_id], first_moisture: n(dryBy[l.lot_id].first_moisture), last_moisture: n(dryBy[l.lot_id].last_moisture) } : null,
    })),
    deliveries: deliveries.map((d) => ({
      ...d, quantity_ton: n(d.quantity_ton), moisture_pct: n(d.moisture_pct), area_rai: n(d.area_rai), crop_confidence: n(d.crop_confidence),
      lat: d.lat === null ? null : Math.round(d.lat * 1e5) / 1e5, lon: d.lon === null ? null : Math.round(d.lon * 1e5) / 1e5,
      province_name_th: TH_PROVINCE_NAME[d.region_code] || null,
    })).map((d) => ({ ...d, sat_check: plotCheck(d) })),
    batches: batches.map((b) => ({
      ...b, input_quantity_ton: n(b.input_quantity_ton), output_quantity_ton: n(b.output_quantity_ton), yield_pct: n(b.yield_pct),
      inputs: inputs.filter((i) => i.batch_id === b.batch_id).map((i) => ({ lot_id: i.lot_id, quantity_ton: n(i.quantity_ton), recorded_at: i.recorded_at })),
    })),
    finished_goods: fgs.map((f) => ({ ...f, quantity_ton: n(f.quantity_ton), dispatched_ton: n(f.dispatched_ton) })),
    dispatches: dispatches.map((d) => ({ ...d, quantity_ton: n(d.quantity_ton) })),
    shipments,
  };
}

/** ผลยืนยันแปลงด้วยดาวเทียม: confirmed (ยืนยันว่าเป็นพืชนี้) · mismatch (ดาวเทียมเห็นพืชอื่น/ไม่มีพืช) · unknown */
function plotCheck(d, commodity) {
  const want = plotAI.commodityToCrop(commodity || d.commodity_code);
  const seen = d.confirmed_crop || d.predicted_crop || null;
  if (!want || !seen || !d.unit_id) return 'unknown';
  if (d.confirmed_crop) return d.confirmed_crop === want ? 'confirmed' : 'mismatch';
  if (Number(d.crop_confidence) < 0.6) return 'unknown';
  return seen === want ? 'confirmed' : 'mismatch';
}

function summarize(t) {
  const ds = t.deliveries || [];
  const plots = {};
  ds.forEach((d) => {
    if (!d.unit_id) return;
    if (!plots[d.unit_id]) plots[d.unit_id] = { area_rai: d.area_rai || 0, check: plotCheck(d), province: d.province_name_th };
  });
  const pv = Object.values(plots);
  const dates = ds.map((d) => d.delivered_at).filter(Boolean).map((x) => new Date(x)).sort((a, b) => a - b);
  const dry = (t.lots || []).map((l) => l.drying).filter(Boolean);
  return {
    farmers: uniq(ds.map((d) => d.farmer_id)).length,
    deliveries: ds.length,
    plots: pv.length,
    area_rai: Math.round(pv.reduce((a, p) => a + Number(p.area_rai || 0), 0) * 100) / 100,
    plots_confirmed: pv.filter((p) => p.check === 'confirmed').length,
    plots_mismatch: pv.filter((p) => p.check === 'mismatch').length,
    provinces: uniq(pv.map((p) => p.province).concat(ds.map((d) => d.province_name_th))),
    raw_ton: Math.round(ds.reduce((a, d) => a + Number(d.quantity_ton || 0), 0) * 1000) / 1000,
    delivered_from: dates[0] || null,
    delivered_to: dates[dates.length - 1] || null,
    avg_moisture_in: ds.some((d) => d.moisture_pct !== null) ? Math.round((ds.filter((d) => d.moisture_pct !== null).reduce((a, d) => a + d.moisture_pct * (d.quantity_ton || 0), 0)
      / Math.max(ds.filter((d) => d.moisture_pct !== null).reduce((a, d) => a + (d.quantity_ton || 0), 0), 1e-9)) * 10) / 10 : null,
    dried_lots: dry.length,
    final_moisture: dry.length ? Math.round(Math.max(...dry.map((x) => x.last_moisture).filter((x) => x !== null)) * 10) / 10 : null,
    grades: uniq(ds.map((d) => d.quality_grade).concat((t.lots || []).map((l) => l.quality_grade))),
    destinations: uniq((t.shipments || []).map((s) => s.destination)).length,
  };
}

/** หน้าสาธารณะ: ไม่มีชื่อ/รหัสสมาชิก ไม่มีพิกัดแปลง ไม่มีชื่อผู้รับปลายทาง */
function publicView(t, coop) {
  const s = summarize(t);
  const fg = t.start.type === 'finished_good' ? t.finished_goods.find((f) => f.finished_good_id === t.start.id) : null;
  const lot = t.start.type === 'lot' ? t.lots.find((l) => l.lot_id === t.start.id) : null;
  const commodity = (t.lots[0] && t.lots[0].commodity_name) || (t.batches[0] && t.batches[0].source_commodity_name) || null;
  return {
    code: t.start.code,
    kind: t.start.type,
    product: fg ? fg.product_name : (lot ? `${lot.commodity_name || lot.commodity_code}${lot.quality_grade ? ` เกรด ${lot.quality_grade}` : ''}` : null),
    commodity,
    cooperative: coop ? { name: coop.org_name, province: coop.province_name_th } : null,
    origin: {
      farmers: s.farmers, plots: s.plots, area_rai: s.area_rai, provinces: s.provinces,
      plots_confirmed: s.plots_confirmed, plots_mismatch: s.plots_mismatch,
      harvest_from: s.delivered_from, harvest_to: s.delivered_to, grades: s.grades,
    },
    steps: [
      s.delivered_from ? { step: 'collect', title: 'รับซื้อผลผลิตจากสมาชิก', from: s.delivered_from, to: s.delivered_to, detail: `${s.farmers} ราย ${s.plots} แปลง${s.avg_moisture_in !== null ? ` · ความชื้นเฉลี่ยตอนรับ ${s.avg_moisture_in}%` : ''}` } : null,
      ...t.lots.map((l) => ({ step: 'lot', title: `ล็อตรวบรวม ${l.trace_code}`, from: l.created_at, to: l.closed_at, detail: `${l.commodity_name || l.commodity_code}${l.quality_grade ? ` เกรด ${l.quality_grade}` : ''}` })),
      s.dried_lots ? { step: 'dry', title: 'ลดความชื้น/เก็บในคลัง', from: null, to: null, detail: `บันทึกความชื้น ${t.lots.reduce((a, l) => a + (l.drying ? l.drying.readings : 0), 0)} ครั้ง${s.final_moisture !== null ? ` · ความชื้นสุดท้าย ${s.final_moisture}%` : ''}` } : null,
      ...t.batches.filter((b) => b.status !== 'Cancelled').map((b) => ({ step: 'process', title: `${PROCESS_TH[b.process_type] || 'แปรรูป'}: ${b.output_product_name}`, from: b.started_at, to: b.completed_at, detail: b.yield_pct !== null ? `อัตราผลผลิต ${b.yield_pct}%` : '' })),
      fg ? { step: 'product', title: `สินค้า ${fg.product_name}`, from: fg.recorded_at, to: null, detail: `${fg.trace_code}` } : null,
    ].filter(Boolean),
    note: 'ข้อมูลจากระบบบันทึกของสหกรณ์บนแพลตฟอร์ม AgroLink · ผลยืนยันแปลงจากภาพดาวเทียมเป็นการประเมินอัตโนมัติ · ไม่แสดงข้อมูลส่วนบุคคลของสมาชิก',
  };
}

module.exports = { PROCESS_TH, CODE_RE, normCode, resolveCode, loadTrace, plotCheck, summarize, publicView };
