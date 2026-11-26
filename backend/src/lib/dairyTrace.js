const { ds, round2 } = require('./dairy');
const core = require('./dairyCore');

/**
 * ตรวจสอบย้อนกลับล็อตน้ำนม: ฟาร์ม → รอบรับนม → ถังเย็นของศูนย์ → เที่ยวรถ → โรงงาน
 *
 * view:
 *  - 'coop'    สหกรณ์เจ้าของ เห็นชื่อสมาชิก
 *  - 'partner' โรงงานที่รับล็อตนั้น: เห็นรหัสสมาชิกและเลขทะเบียนฟาร์ม แต่ไม่เห็นชื่อบุคคล
 *  - 'gov'     เจ้าหน้าที่รัฐ: เห็นเฉพาะเลขทะเบียนฟาร์ม (ทะเบียนของกรมปศุสัตว์ ใช้เรียกคืนสินค้า)
 *
 * ผู้เรียกต้องตรวจสิทธิ์เข้าถึงล็อตก่อนเสมอ ฟังก์ชันนี้ไม่ตรวจสิทธิ์
 */
const DIFF_WARN_PCT = 3;

async function traceBatch(c, batch, view = 'coop') {
  const coop = batch.coop_org_id;
  const s = await core.settings(c, coop);
  const center = (await c.query('SELECT center_id, name, tank_capacity_kg FROM dairy.collection_center WHERE center_id=$1', [batch.center_id])).rows[0];
  const coopName = (await c.query('SELECT org_name FROM identity.organization WHERE org_id=$1', [coop])).rows[0];
  const rounds = (await c.query(
    `SELECT round_id, round_date::text AS round_date, shift, status, accepted_kg, rejected_kg, tank_temp_c, closed_at
       FROM dairy.milk_round WHERE batch_id=$1 ORDER BY round_date, shift`, [batch.batch_id],
  )).rows;
  const lastDate = batch.last_round_date ? ds(batch.last_round_date) : null;
  const farms = (await c.query(
    `SELECT m.member_id, m.member_code, m.full_name, m.farm_registration_no,
            SUM(i.weight_kg) FILTER (WHERE i.status='Accepted')::numeric(12,2) AS accepted_kg,
            SUM(i.weight_kg) FILTER (WHERE i.status='Rejected')::numeric(12,2) AS rejected_kg,
            COUNT(*)::int AS deliveries,
            array_agg(DISTINCT i.source) AS sources,
            array_agg(DISTINCT i.reject_reason) FILTER (WHERE i.reject_reason IS NOT NULL) AS reject_reasons,
            q.sample_date::text AS test_date, q.fat_pct, q.snf_pct, q.scc_k, q.tbc_k, q.antibiotic_pos,
            (SELECT COUNT(*) FROM dairy.animal a WHERE a.member_id=m.member_id AND a.withdrawal_until >= $2::date - 7)::int AS recent_withdrawal_cows
       FROM dairy.milk_intake i JOIN dairy.milk_round r ON r.round_id=i.round_id JOIN dairy.member m ON m.member_id=i.member_id
       LEFT JOIN LATERAL (SELECT * FROM dairy.quality_test t WHERE t.member_id=m.member_id AND t.sample_date <= $2::date
                           ORDER BY t.sample_date DESC, t.created_at DESC LIMIT 1) q ON true
      WHERE r.batch_id=$1
      GROUP BY m.member_id, q.sample_date, q.fat_pct, q.snf_pct, q.scc_k, q.tbc_k, q.antibiotic_pos, q.created_at
      ORDER BY accepted_kg DESC NULLS LAST, m.member_code`, [batch.batch_id, lastDate || ds(new Date())],
  )).rows.map((f) => {
    const o = {
      member_code: f.member_code, farm_registration_no: f.farm_registration_no, accepted_kg: Number(f.accepted_kg || 0), rejected_kg: Number(f.rejected_kg || 0),
      deliveries: f.deliveries, sources: (f.sources || []).filter(Boolean), reject_reasons: f.reject_reasons || [],
      quality: f.test_date ? { sample_date: f.test_date, fat_pct: f.fat_pct, snf_pct: f.snf_pct, scc_k: f.scc_k, tbc_k: f.tbc_k, antibiotic_pos: f.antibiotic_pos } : null,
      recent_withdrawal_cows: f.recent_withdrawal_cows,
    };
    if (view === 'coop') { o.member_id = f.member_id; o.full_name = f.full_name; }
    if (view === 'gov') delete o.member_code;
    return o;
  });

  // อุณหภูมิถังเย็นของศูนย์ระหว่างที่นมล็อตนี้อยู่ในถัง (ตั้งแต่รอบแรกถึงเวลาส่ง)
  const from = rounds.length ? `${rounds[0].round_date}T00:00:00+07:00` : batch.opened_at;
  const to = batch.shipped_at || new Date();
  const tankMax = Number(s.tank_temp_max);
  const tank = (await c.query(
    `SELECT d.device_id, d.name, COALESCE(d.temp_max, $4) AS limit_c, COUNT(r.*)::int AS readings, MIN(r.temp_c) AS min_c, MAX(r.temp_c) AS max_c, ROUND(AVG(r.temp_c), 2) AS avg_c,
            COUNT(r.*) FILTER (WHERE r.temp_c > COALESCE(d.temp_max, $4))::int AS over_limit
       FROM dairy.iot_device d LEFT JOIN dairy.iot_reading r ON r.device_id=d.device_id AND r.recorded_at BETWEEN $2 AND $3 AND r.temp_c IS NOT NULL
      WHERE d.center_id=$1 AND d.device_type='cooling_tank' GROUP BY d.device_id ORDER BY d.name`, [batch.center_id, from, to, tankMax],
  )).rows.map((t) => ({
    name: t.name, limit_c: Number(t.limit_c), readings: t.readings, min_c: t.min_c, max_c: t.max_c, avg_c: t.avg_c, over_limit: t.over_limit, device_id: t.device_id,
  }));
  for (const t of tank) {
    // ชุดข้อมูลย่อ ≤ 48 จุด สำหรับกราฟเส้น
    t.series = t.readings ? (await c.query(
      `SELECT to_char(date_trunc('hour', recorded_at) AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD"T"HH24:00') AS t, ROUND(MAX(temp_c), 2) AS c
         FROM dairy.iot_reading WHERE device_id=$1 AND recorded_at BETWEEN $2 AND $3 AND temp_c IS NOT NULL
        GROUP BY 1 ORDER BY 1 DESC LIMIT 48`, [t.device_id, from, to],
    )).rows.reverse() : [];
    delete t.device_id;
  }

  let shipment = null;
  if (batch.shipment_id) {
    const sh = (await c.query(
      `SELECT s.shipment_id, s.ship_date::text AS ship_date, s.vehicle, s.driver_name, s.sent_kg, s.tank_temp_c, s.status, s.received_kg, s.received_at, s.sent_at,
              s.fat_pct, s.snf_pct, s.scc_k, s.tbc_k, s.reject_reason, p.name AS partner_name, k.contract_no, s.proposal_id IS NOT NULL AS is_surplus
         FROM dairy.shipment s JOIN dairy.partner p ON p.partner_id=s.partner_id LEFT JOIN dairy.contract k ON k.contract_id=s.contract_id
        WHERE s.shipment_id=$1`, [batch.shipment_id],
    )).rows[0];
    shipment = sh || null;
  }

  // จุดที่ต้องตรวจสอบ
  const checks = [];
  const acc = Number(batch.accepted_kg);
  const totalRejected = rounds.reduce((a, r) => a + Number(r.rejected_kg || 0), 0);
  if (shipment) {
    const sent = Number(shipment.sent_kg);
    const diff = acc ? round2(((sent - acc) / acc) * 100) : null;
    checks.push({ code: 'sent_vs_collected', level: diff !== null && Math.abs(diff) > DIFF_WARN_PCT ? 'warning' : 'ok', collected_kg: acc, sent_kg: sent, diff_pct: diff });
    if (shipment.status === 'Received') {
      const rec = Number(shipment.received_kg);
      const d2 = sent ? round2(((rec - sent) / sent) * 100) : null;
      checks.push({ code: 'received_vs_sent', level: d2 !== null && Math.abs(d2) > DIFF_WARN_PCT ? 'warning' : 'ok', sent_kg: sent, received_kg: rec, diff_pct: d2 });
    }
    if (shipment.status === 'Rejected') checks.push({ code: 'factory_rejected', level: 'critical', reason: shipment.reject_reason });
    if (shipment.tank_temp_c !== null && Number(shipment.tank_temp_c) > tankMax) checks.push({ code: 'truck_temp_high', level: 'warning', value: Number(shipment.tank_temp_c), max: tankMax });
  }
  const hotRounds = rounds.filter((r) => r.tank_temp_c !== null && Number(r.tank_temp_c) > tankMax);
  if (hotRounds.length) checks.push({ code: 'round_tank_temp_high', level: 'warning', rounds: hotRounds.length, max: tankMax });
  const noTemp = rounds.filter((r) => r.tank_temp_c === null).length;
  if (noTemp && !tank.some((t) => t.readings)) checks.push({ code: 'no_tank_temperature', level: 'info', rounds: noTemp });
  const overLimit = tank.reduce((a, t) => a + t.over_limit, 0);
  if (overLimit) checks.push({ code: 'tank_sensor_over_limit', level: 'warning', readings: overLimit, max: Math.min(...tank.filter((t) => t.over_limit).map((t) => t.limit_c)) });
  const abFarms = farms.filter((f) => f.quality && f.quality.antibiotic_pos && f.accepted_kg > 0).length;
  if (abFarms) checks.push({ code: 'farm_antibiotic_positive', level: 'critical', farms: abFarms });
  const wdFarms = farms.filter((f) => f.recent_withdrawal_cows > 0 && f.accepted_kg > 0).length;
  if (wdFarms) checks.push({ code: 'farm_recent_withdrawal', level: 'warning', farms: wdFarms });
  const noTest = farms.filter((f) => !f.quality && f.accepted_kg > 0).length;
  if (noTest) checks.push({ code: 'farm_without_quality_test', level: 'info', farms: noTest });
  if (center && center.tank_capacity_kg && acc > Number(center.tank_capacity_kg)) checks.push({ code: 'over_tank_capacity', level: 'warning', kg: acc, capacity: Number(center.tank_capacity_kg) });

  const timeline = [];
  rounds.forEach((r) => { if (r.closed_at) timeline.push({ at: r.closed_at, event: 'round_closed', round_date: r.round_date, shift: r.shift, kg: Number(r.accepted_kg) }); });
  if (shipment) {
    timeline.push({ at: shipment.sent_at, event: 'shipped', label: shipment.vehicle || '', kg: Number(shipment.sent_kg) });
    if (shipment.received_at) timeline.push({ at: shipment.received_at, event: shipment.status === 'Rejected' ? 'factory_rejected' : 'factory_received', label: shipment.partner_name, kg: shipment.received_kg === null ? null : Number(shipment.received_kg) });
  }
  timeline.sort((a, b) => new Date(a.at) - new Date(b.at));

  const out = {
    batch: {
      batch_code: batch.batch_code, status: batch.status, rounds: batch.rounds, accepted_kg: acc, rejected_kg: round2(totalRejected), farm_count: batch.farm_count,
      first_round_date: batch.first_round_date ? ds(batch.first_round_date) : null, last_round_date: lastDate,
      opened_at: batch.opened_at, shipped_at: batch.shipped_at, closed_at: batch.closed_at,
    },
    coop_name: coopName ? coopName.org_name : null,
    center: center ? { name: center.name, tank_capacity_kg: center.tank_capacity_kg } : null,
    rounds: rounds.map(({ round_id, ...r }) => (view === 'coop' ? { round_id, ...r } : r)),
    farms,
    tank,
    tank_temp_max: tankMax,
    shipment: shipment && view !== 'coop' ? (({ shipment_id, ...x }) => x)(shipment) : shipment,
    checks,
    timeline,
  };
  if (view === 'coop') out.batch.batch_id = batch.batch_id;
  return out;
}

/** ล็อตที่ฟาร์มหนึ่งเคยส่งนมเข้า (ใช้ตอบว่า "นมของฟาร์มนี้ไปอยู่โรงงานไหน") */
async function batchesOfMember(c, memberId, limit = 60) {
  return (await c.query(
    `SELECT b.batch_code, b.status, b.first_round_date::text AS first_round_date, b.last_round_date::text AS last_round_date,
            SUM(i.weight_kg) FILTER (WHERE i.status='Accepted')::numeric(12,2) AS member_kg, b.accepted_kg AS batch_kg,
            p.name AS partner_name, s.ship_date::text AS ship_date, s.status AS shipment_status
       FROM dairy.milk_intake i JOIN dairy.milk_round r ON r.round_id=i.round_id JOIN dairy.milk_batch b ON b.batch_id=r.batch_id
       LEFT JOIN dairy.shipment s ON s.shipment_id=b.shipment_id LEFT JOIN dairy.partner p ON p.partner_id=s.partner_id
      WHERE i.member_id=$1 GROUP BY b.batch_id, p.name, s.ship_date, s.status ORDER BY b.opened_at DESC LIMIT $2`, [memberId, limit],
  )).rows;
}

module.exports = { traceBatch, batchesOfMember, DIFF_WARN_PCT };
