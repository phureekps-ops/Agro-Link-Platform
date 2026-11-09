const express = require('express');
const crypto = require('crypto');

const { withServiceRole } = require('../db/pool');
const {
  h, bad, conflict, notFound, num, bkkToday, shiftOf,
} = require('../lib/dairy');

/**
 * /dairy-iot — endpoint สำหรับอุปกรณ์ (ไม่มี JWT; ยืนยันด้วย header
 * `X-Device-Key` ที่ได้ครั้งเดียวตอนสหกรณ์สร้างอุปกรณ์ใน POST /dairy/iot/devices;
 * เก็บเฉพาะ sha256). ใช้ withServiceRole เหมือน /mushroom-iot — ขอบเขต
 * ความปลอดภัยคือ device ที่ resolve ได้จาก key เท่านั้น.
 *
 *  POST /readings  ถังเย็น/รถ/บ่อไบโอแก๊ส/โรงเรือน: { temp_c, level_kg, gas_m3, lat, lng, recorded_at? } หรือ { readings: [...] }
 *  POST /intake    เครื่องชั่งนมที่ศูนย์: { member_code, weight_kg } → บันทึกลงรอบเปิดของวันนี้ (เช้า/เย็นตามเวลา)
 *
 * /dairy-public — หน้าโรงเรียนยืนยันรับนม (สแกน QR ที่แนบใบส่ง) ไม่ต้อง login
 * ใช้ token สุ่ม 32 hex ต่อการส่งหนึ่งครั้ง.
 */
const iot = express.Router();
const pub = express.Router();

async function deviceFromKey(c, req) {
  const key = req.get('x-device-key') || '';
  if (!/^dk_[0-9a-f]{48}$/.test(key)) return null;
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return (await c.query('SELECT * FROM dairy.iot_device WHERE api_key_hash=$1 AND active', [hash])).rows[0] || null;
}

iot.post('/readings', h(async (req, res) => withServiceRole(async (c) => {
  const d = await deviceFromKey(c, req);
  if (!d) { res.status(401).json({ error: 'invalid_device_key' }); return undefined; }
  const b = req.body || {};
  const list = Array.isArray(b.readings) ? b.readings : [b];
  if (!list.length || list.length > 500) throw bad('invalid_readings_count', { max: 500 });
  let last = null;
  for (const r of list) {
    const v = {
      temp_c: num(r.temp_c, { min: -40, max: 120 }), level_kg: num(r.level_kg, { min: 0 }), gas_m3: num(r.gas_m3, { min: 0 }),
      lat: num(r.lat, { min: -90, max: 90 }), lng: num(r.lng, { min: -180, max: 180 }),
    };
    if (Object.values(v).some((x) => Number.isNaN(x)) || Object.values(v).every((x) => x === null)) throw bad('invalid_reading');
    const at = r.recorded_at && !Number.isNaN(Date.parse(r.recorded_at)) ? new Date(r.recorded_at) : new Date();
    if (at.getTime() > Date.now() + 5 * 60000) throw bad('recorded_at_in_future');
    await c.query('INSERT INTO dairy.iot_reading (device_id, recorded_at, temp_c, level_kg, gas_m3, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [d.device_id, at, v.temp_c, v.level_kg, v.gas_m3, v.lat, v.lng]);
    if (!last || at > last.at) last = { at, t: v.temp_c };
  }
  await c.query('UPDATE dairy.iot_device SET last_seen_at=now() WHERE device_id=$1', [d.device_id]);
  const alerts = [];
  const checks = [
    ['temp_low', last.t !== null && d.temp_min !== null && last.t < Number(d.temp_min), `อุณหภูมิต่ำกว่าเกณฑ์ ${d.temp_min}°C`],
    ['temp_high', last.t !== null && d.temp_max !== null && last.t > Number(d.temp_max), `อุณหภูมิสูงกว่าเกณฑ์ ${d.temp_max}°C`],
  ];
  for (const [type, hit, msg] of checks) {
    if (!hit) continue;
    if ((await c.query('SELECT 1 FROM dairy.iot_alert WHERE device_id=$1 AND alert_type=$2 AND acknowledged_at IS NULL', [d.device_id, type])).rows.length) continue;
    await c.query('INSERT INTO dairy.iot_alert (device_id, alert_type, value, message) VALUES ($1,$2,$3,$4)', [d.device_id, type, last.t, `${d.name}: ${msg} (วัดได้ ${last.t}°C)`]);
    alerts.push(type);
  }
  return { accepted: list.length, alerts };
})));

iot.post('/intake', h(async (req, res) => withServiceRole(async (c) => {
  const d = await deviceFromKey(c, req);
  if (!d) { res.status(401).json({ error: 'invalid_device_key' }); return undefined; }
  if (d.device_type !== 'milk_scale' || !d.center_id) throw bad('not_a_milk_scale');
  const b = req.body || {};
  const kg = num(b.weight_kg, { min: 0 });
  if (!kg || Number.isNaN(kg)) throw bad('invalid_field', { field: 'weight_kg' });
  const m = (await c.query(`SELECT * FROM dairy.member WHERE coop_org_id=$1 AND member_code=$2`, [d.coop_org_id, String(b.member_code || '').trim()])).rows[0];
  if (!m) throw notFound('member_not_found');
  if (m.status !== 'Approved') throw conflict('member_not_approved');
  const day = bkkToday();
  const shift = shiftOf();
  await c.query(`INSERT INTO dairy.milk_round (coop_org_id, center_id, round_date, shift) VALUES ($1,$2,$3,$4) ON CONFLICT (center_id, round_date, shift) DO NOTHING`,
    [d.coop_org_id, d.center_id, day, shift]);
  const round = (await c.query('SELECT * FROM dairy.milk_round WHERE center_id=$1 AND round_date=$2 AND shift=$3', [d.center_id, day, shift])).rows[0];
  if (round.status !== 'Open') throw conflict('round_closed');
  // เครื่องชั่งไม่รู้เรื่องระยะหยุดยา: ถ้ามีโคหยุดยา บันทึกน้ำหนักไว้แต่ให้เจ้าหน้าที่ยืนยันในพอร์ทัล (Rejected ชั่วคราว เหตุผล antibiotic)
  const w = (await c.query(`SELECT 1 FROM dairy.animal WHERE member_id=$1 AND status='Milking' AND withdrawal_until >= $2`, [m.member_id, day])).rows.length;
  const r = (await c.query(
    `INSERT INTO dairy.milk_intake (coop_org_id, round_id, member_id, weight_kg, status, reject_reason, source, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,'scale',$7)
     ON CONFLICT (round_id, member_id) DO UPDATE SET weight_kg=dairy.milk_intake.weight_kg + EXCLUDED.weight_kg, recorded_at=now()
     RETURNING intake_id, weight_kg, status`,
    [d.coop_org_id, round.round_id, m.member_id, kg, w ? 'Rejected' : 'Accepted', w ? 'antibiotic' : null, `device:${d.device_id}`],
  )).rows[0];
  await c.query('UPDATE dairy.iot_device SET last_seen_at=now() WHERE device_id=$1', [d.device_id]);
  return { ...r, shift, member: m.full_name, needs_review: !!w };
})));

pub.get('/school-delivery/:token', h(async (req) => withServiceRole(async (c) => {
  if (!/^[0-9a-f]{32}$/.test(req.params.token)) throw notFound('delivery_not_found');
  const r = (await c.query(
    `SELECT d.delivery_date, d.units, d.status, d.received_units, d.confirmed_at, s.name AS school_name, o.org_name AS coop_name, p.name AS product_name, p.unit,
            b.lot_code, b.expires_on
       FROM dairy.school_delivery d JOIN dairy.school s ON s.school_id=d.school_id JOIN identity.organization o ON o.org_id=d.coop_org_id
       LEFT JOIN dairy.product p ON p.product_id=s.product_id LEFT JOIN dairy.production_batch b ON b.batch_id=d.batch_id
      WHERE d.confirm_token=$1`, [req.params.token],
  )).rows[0];
  if (!r) throw notFound('delivery_not_found');
  return r;
})));
pub.post('/school-delivery/:token/confirm', h(async (req) => withServiceRole(async (c) => {
  if (!/^[0-9a-f]{32}$/.test(req.params.token)) throw notFound('delivery_not_found');
  const d = (await c.query('SELECT * FROM dairy.school_delivery WHERE confirm_token=$1', [req.params.token])).rows[0];
  if (!d) throw notFound('delivery_not_found');
  if (d.status !== 'Delivered') throw conflict('invalid_delivery_status', { status: d.status });
  const b = req.body || {};
  const units = num(b.received_units, { min: 0 });
  if (units === null || Number.isNaN(units) || !Number.isInteger(units) || units > d.units * 2) throw bad('invalid_field', { field: 'received_units' });
  const note = b.issue_note ? String(b.issue_note).slice(0, 500) : null;
  const issue = units !== d.units || !!note;
  return (await c.query(
    `UPDATE dairy.school_delivery SET status=$2, received_units=$3, issue_note=$4, confirmed_at=now() WHERE delivery_id=$1
     RETURNING delivery_date, units, received_units, status, issue_note, confirmed_at`,
    [d.delivery_id, issue ? 'Issue' : 'Confirmed', units, note],
  )).rows[0];
})));

module.exports = { iot, pub };
