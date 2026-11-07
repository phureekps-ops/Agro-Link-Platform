const express = require('express');
const crypto = require('crypto');

const { withServiceRole } = require('../db/pool');
const { h, bad, num } = require('../lib/mushroom');

/**
 * /mushroom-iot — endpoint สำหรับอุปกรณ์ IoT (เซนเซอร์อุณหภูมิ/ความชื้น และ
 * ตัวควบคุมพ่นหมอก) ในห้องอบ ห้องบ่ม และจุดเปิดดอก. อุปกรณ์ไม่มี JWT — ยืนยัน
 * ตัวตนด้วย header `X-Device-Key` (ได้ครั้งเดียวตอนสหกรณ์สร้างอุปกรณ์ใน
 * POST /mushroom/iot/devices; เก็บเฉพาะ sha256 ใน mushroom.iot_device).
 *
 * ใช้ withServiceRole (SET ROLE agrolink_app อย่างเดียว ไม่มี session context)
 * เหมือน POST /traffic/track — ไม่มี subject ให้ผูก และสคีมา mushroom ไม่มี
 * RLS; ขอบเขตความปลอดภัยคือ device_id ที่ resolve ได้จาก key เท่านั้น.
 */
const router = express.Router();

async function deviceFromKey(client, req) {
  const key = req.get('x-device-key') || '';
  if (!/^mk_[0-9a-f]{48}$/.test(key)) return null;
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  const r = await client.query('SELECT * FROM mushroom.iot_device WHERE api_key_hash=$1 AND active', [hash]);
  return r.rows[0] || null;
}

/** อ่านค่าได้ทีละค่าหรือเป็นชุด: { temp_c, rh_pct, recorded_at? } หรือ { readings: [...] } (สูงสุด 500) */
router.post('/readings', h(async (req, res) => withServiceRole(async (c) => {
  const d = await deviceFromKey(c, req);
  if (!d) { res.status(401).json({ error: 'invalid_device_key' }); return undefined; }
  const b = req.body || {};
  const list = Array.isArray(b.readings) ? b.readings : [b];
  if (!list.length || list.length > 500) throw bad('invalid_readings_count', { max: 500 });
  const alerts = [];
  let last = null;
  for (const r of list) {
    const t = num(r.temp_c, { min: -40, max: 120 });
    const rh = num(r.rh_pct, { min: 0, max: 100 });
    if (Number.isNaN(t) || Number.isNaN(rh) || (t === null && rh === null)) throw bad('invalid_reading');
    const at = r.recorded_at && !Number.isNaN(Date.parse(r.recorded_at)) ? new Date(r.recorded_at) : new Date();
    if (at.getTime() > Date.now() + 5 * 60000) throw bad('recorded_at_in_future');
    await c.query('INSERT INTO mushroom.iot_reading (device_id, recorded_at, temp_c, rh_pct) VALUES ($1,$2,$3,$4)', [d.device_id, at, t, rh]);
    if (!last || at > last.at) last = { at, t, rh };
  }
  await c.query('UPDATE mushroom.iot_device SET last_seen_at=now() WHERE device_id=$1', [d.device_id]);
  // ตรวจเกณฑ์จากค่าล่าสุดของชุด — ไม่สร้าง alert ซ้ำถ้ายังมี alert ชนิดเดียวกันค้างอยู่
  const checks = [
    ['temp_low', last.t !== null && d.temp_min !== null && last.t < Number(d.temp_min), last.t, `อุณหภูมิต่ำกว่าเกณฑ์ ${d.temp_min}°C`],
    ['temp_high', last.t !== null && d.temp_max !== null && last.t > Number(d.temp_max), last.t, `อุณหภูมิสูงกว่าเกณฑ์ ${d.temp_max}°C`],
    ['rh_low', last.rh !== null && d.rh_min !== null && last.rh < Number(d.rh_min), last.rh, `ความชื้นต่ำกว่าเกณฑ์ ${d.rh_min}%`],
    ['rh_high', last.rh !== null && d.rh_max !== null && last.rh > Number(d.rh_max), last.rh, `ความชื้นสูงกว่าเกณฑ์ ${d.rh_max}%`],
  ];
  for (const [type, hit, value, msg] of checks) {
    if (!hit) continue;
    const open = await c.query('SELECT 1 FROM mushroom.iot_alert WHERE device_id=$1 AND alert_type=$2 AND acknowledged_at IS NULL', [d.device_id, type]);
    if (open.rows.length) continue;
    await c.query('INSERT INTO mushroom.iot_alert (device_id, alert_type, value, message) VALUES ($1,$2,$3,$4)',
      [d.device_id, type, value, `${d.name}: ${msg} (วัดได้ ${value})`]);
    alerts.push(type);
  }
  // พ่นหมอกอัตโนมัติเมื่อความชื้นต่ำ (เฉพาะอุปกรณ์ที่เปิด auto_mist)
  if (d.auto_mist && last.rh !== null && d.rh_min !== null) {
    const cmd = last.rh < Number(d.rh_min) ? 'mist_on' : (d.rh_max !== null && last.rh >= Number(d.rh_max) ? 'mist_off' : null);
    if (cmd) {
      const pending = await c.query(`SELECT 1 FROM mushroom.iot_command WHERE device_id=$1 AND command=$2 AND status='Pending'`, [d.device_id, cmd]);
      if (!pending.rows.length) await c.query('INSERT INTO mushroom.iot_command (device_id, command) VALUES ($1,$2)', [d.device_id, cmd]);
    }
  }
  return { accepted: list.length, alerts };
})));

/** อุปกรณ์ดึงคำสั่งที่ค้าง (พ่นหมอก เปิด/ปิด) แล้วระบบทำเครื่องหมายว่าส่งแล้ว */
router.get('/commands', h(async (req, res) => withServiceRole(async (c) => {
  const d = await deviceFromKey(c, req);
  if (!d) { res.status(401).json({ error: 'invalid_device_key' }); return undefined; }
  const r = await c.query(
    `UPDATE mushroom.iot_command SET status='Sent', sent_at=now()
      WHERE command_id IN (SELECT command_id FROM mushroom.iot_command WHERE device_id=$1 AND status='Pending' ORDER BY created_at LIMIT 20)
      RETURNING command_id, command, created_at`,
    [d.device_id],
  );
  await c.query('UPDATE mushroom.iot_device SET last_seen_at=now() WHERE device_id=$1', [d.device_id]);
  return r.rows.sort((a, b) => a.created_at - b.created_at);
})));

module.exports = router;
