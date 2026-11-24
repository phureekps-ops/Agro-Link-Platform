/**
 * รับข้อมูลจาก Gateway ที่ศูนย์รับนม (backend/db/grant_dairy_iot_gateway.sql, โปรแกรม gateway/).
 *
 * POST /dairy-iot/gateway/events  { gateway: {version,...}, events: [ { id, type, channel, at, ... } ] }
 *   type = intake    { member_code, weight_kg }                     → เครื่องชั่ง: ลงรอบของ "เวลาที่ชั่งจริง"
 *          reading   { temp_c?, level_kg? }                         → ถังเย็น: อุณหภูมิ/ปริมาณนม + เตือนเกินเกณฑ์
 *          analysis  { member_code?, sample_no?, fat_pct, snf_pct, ... } → เครื่องวิเคราะห์นม
 *          heartbeat {}                                             → gateway ยังทำงาน
 * ทุกเหตุการณ์มี id ไม่ซ้ำ (gateway สร้าง) — ส่งซ้ำกี่ครั้งก็บันทึกครั้งเดียว และตอบผลเดิม.
 * ผลต่อเหตุการณ์: ok | duplicate | error (ผิดถาวร เช่น ไม่พบสมาชิก — gateway ไม่ต้องส่งซ้ำ) | retry (ระบบขัดข้องชั่วคราว).
 *
 * client ที่ส่งเข้ามาต้องเป็น withServiceRole และ gateway ต้อง resolve มาจาก X-Device-Key แล้ว —
 * ขอบเขตทุกอย่างคือสหกรณ์/อุปกรณ์ลูกของ gateway นั้น.
 */
const {
  bad, conflict, notFound, num, bkkToday, shiftOf, round2,
} = require('./dairy');

const MAX_EVENTS = 200;
const MAX_AGE_DAYS = 7;
const EVENT_TYPES = ['intake', 'reading', 'analysis', 'heartbeat'];
const ANALYSIS_FIELDS = {
  fat_pct: [0, 20], snf_pct: [0, 20], protein_pct: [0, 20], lactose_pct: [0, 20], density: [0, 2000],
  added_water_pct: [0, 100], freezing_point_c: [-2, 0], milk_temp_c: [-5, 60],
};
// เกณฑ์เตือนคุณภาพจากเครื่องวิเคราะห์ (สงสัยน้ำปน) — สหกรณ์ต้องตรวจซ้ำก่อนตัดสิน
const WATER_ALERT_PCT = 2;
const FREEZING_ALERT_C = -0.5;

const bkkDay = (d) => new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);

/** ตรวจรูปแบบเหตุการณ์ (pure) — คืน { id, type, channel, at } หรือ throw bad(). */
function parseEvent(ev, now = new Date()) {
  if (!ev || typeof ev !== 'object') throw bad('invalid_event');
  const id = String(ev.id || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw bad('invalid_event_id');
  if (!EVENT_TYPES.includes(ev.type)) throw bad('invalid_event_type');
  const channel = ev.channel == null ? null : String(ev.channel);
  if (ev.type !== 'heartbeat' && !/^[a-z0-9_-]{1,32}$/.test(channel || '')) throw bad('invalid_channel');
  const at = ev.at ? new Date(ev.at) : null;
  if (!at || Number.isNaN(at.getTime())) throw bad('invalid_event_time');
  if (at.getTime() > now.getTime() + 5 * 60000) throw bad('event_time_in_future');
  if (at.getTime() < now.getTime() - MAX_AGE_DAYS * 86400000) throw bad('event_too_old', { max_days: MAX_AGE_DAYS });
  return { id, type: ev.type, channel, at };
}

/** ค่าผลวิเคราะห์ (pure) — ตัดค่าที่อยู่นอกช่วงทิ้งเป็น error. */
function analysisValues(ev) {
  const v = {};
  Object.entries(ANALYSIS_FIELDS).forEach(([f, [lo, hi]]) => {
    const x = num(ev[f], { min: lo, max: hi });
    if (Number.isNaN(x)) throw bad('invalid_field', { field: f });
    v[f] = x;
  });
  if (v.fat_pct === null && v.snf_pct === null && v.protein_pct === null && v.density === null) throw bad('empty_analysis');
  return v;
}

/** ข้อความเตือนคุณภาพ (pure) — null = ปกติ. */
function qualityWarning(v) {
  const w = [];
  if (v.added_water_pct != null && v.added_water_pct >= WATER_ALERT_PCT) w.push(`น้ำปน ${v.added_water_pct}%`);
  if (v.freezing_point_c != null && v.freezing_point_c > FREEZING_ALERT_C) w.push(`จุดเยือกแข็ง ${v.freezing_point_c}°C`);
  return w.length ? w.join(', ') : null;
}

async function tempAlerts(c, d, t) {
  const out = [];
  if (t === null || t === undefined) return out;
  const checks = [
    ['temp_low', d.temp_min !== null && t < Number(d.temp_min), `อุณหภูมิต่ำกว่าเกณฑ์ ${d.temp_min}°C`],
    ['temp_high', d.temp_max !== null && t > Number(d.temp_max), `อุณหภูมิสูงกว่าเกณฑ์ ${d.temp_max}°C`],
  ];
  for (const [type, hit, msg] of checks) {
    if (!hit) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    if ((await c.query('SELECT 1 FROM dairy.iot_alert WHERE device_id=$1 AND alert_type=$2 AND acknowledged_at IS NULL', [d.device_id, type])).rows.length) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await c.query('INSERT INTO dairy.iot_alert (device_id, alert_type, value, message) VALUES ($1,$2,$3,$4)', [d.device_id, type, t, `${d.name}: ${msg} (วัดได้ ${t}°C)`]);
    out.push(type);
  }
  return out;
}

async function child(c, gw, channel, types) {
  const d = (await c.query('SELECT * FROM dairy.iot_device WHERE gateway_id=$1 AND channel=$2 AND active', [gw.device_id, channel])).rows[0];
  if (!d) throw bad('channel_not_found', { channel });
  if (!types.includes(d.device_type)) throw bad('channel_type_mismatch', { channel, device_type: d.device_type });
  return d;
}
async function memberByCode(c, coop, code) {
  const m = (await c.query('SELECT * FROM dairy.member WHERE coop_org_id=$1 AND member_code=$2', [coop, String(code || '').trim()])).rows[0];
  if (!m) throw notFound('member_not_found');
  return m;
}

async function onIntake(c, gw, ev, p) {
  const d = await child(c, gw, p.channel, ['milk_scale']);
  const centerId = d.center_id || gw.center_id;
  const kg = num(ev.weight_kg, { min: 0, max: 5000 });
  if (!kg || Number.isNaN(kg)) throw bad('invalid_field', { field: 'weight_kg' });
  const m = await memberByCode(c, gw.coop_org_id, ev.member_code);
  if (m.status !== 'Approved') throw conflict('member_not_approved');
  const day = bkkDay(p.at);
  const shift = shiftOf(p.at);
  await c.query(`INSERT INTO dairy.milk_round (coop_org_id, center_id, round_date, shift) VALUES ($1,$2,$3,$4) ON CONFLICT (center_id, round_date, shift) DO NOTHING`,
    [gw.coop_org_id, centerId, day, shift]);
  const round = (await c.query('SELECT * FROM dairy.milk_round WHERE center_id=$1 AND round_date=$2 AND shift=$3 FOR UPDATE', [centerId, day, shift])).rows[0];
  if (round.status !== 'Open') throw conflict('round_closed', { round_date: day, shift });
  // เครื่องชั่งไม่รู้เรื่องระยะหยุดยา: มีโคหยุดยา → บันทึกน้ำหนักไว้เป็น "ปฏิเสธ (ยาตกค้าง)" ให้เจ้าหน้าที่ยืนยันในพอร์ทัล
  const w = (await c.query(`SELECT 1 FROM dairy.animal WHERE member_id=$1 AND status='Milking' AND withdrawal_until >= $2`, [m.member_id, day])).rows.length;
  const r = (await c.query(
    `INSERT INTO dairy.milk_intake (coop_org_id, round_id, member_id, weight_kg, status, reject_reason, sample_no, source, recorded_by, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'gateway',$8,$9)
     ON CONFLICT (round_id, member_id) DO UPDATE SET weight_kg=dairy.milk_intake.weight_kg + EXCLUDED.weight_kg,
        sample_no=COALESCE(EXCLUDED.sample_no, dairy.milk_intake.sample_no), recorded_at=EXCLUDED.recorded_at
     RETURNING intake_id, weight_kg, status`,
    [gw.coop_org_id, round.round_id, m.member_id, kg, w ? 'Rejected' : 'Accepted', w ? 'antibiotic' : null,
      ev.sample_no ? String(ev.sample_no).slice(0, 40) : null, `device:${d.device_id}`, p.at],
  )).rows[0];
  await c.query('UPDATE dairy.iot_device SET last_seen_at=now() WHERE device_id=$1', [d.device_id]);
  return {
    intake_id: r.intake_id, round_date: day, shift, weight_kg: kg, member_total_kg: Number(r.weight_kg), status: r.status,
    member_code: m.member_code, member: m.full_name, needs_review: !!w,
  };
}

async function onReading(c, gw, ev, p) {
  const d = await child(c, gw, p.channel, ['cooling_tank', 'barn', 'biogas']);
  const t = num(ev.temp_c, { min: -40, max: 120 });
  const lv = num(ev.level_kg, { min: 0, max: 1000000 });
  if (Number.isNaN(t) || Number.isNaN(lv) || (t === null && lv === null)) throw bad('invalid_reading');
  await c.query('INSERT INTO dairy.iot_reading (device_id, recorded_at, temp_c, level_kg) VALUES ($1,$2,$3,$4)', [d.device_id, p.at, t, lv]);
  await c.query('UPDATE dairy.iot_device SET last_seen_at=now() WHERE device_id=$1', [d.device_id]);
  // เตือนจากค่าล่าสุดเท่านั้น (ข้อมูลย้อนหลังที่ค้างไว้ไม่ควรเปิดเตือนเก่า)
  const recent = Date.now() - p.at.getTime() < 15 * 60000;
  return { alerts: recent ? await tempAlerts(c, d, t) : [] };
}

async function onAnalysis(c, gw, ev, p, settings) {
  const d = await child(c, gw, p.channel, ['milk_analyzer']);
  const v = analysisValues(ev);
  let m = null;
  if (ev.member_code) m = await memberByCode(c, gw.coop_org_id, ev.member_code);
  const day = bkkDay(p.at);
  const centerId = d.center_id || gw.center_id;
  const round = (await c.query('SELECT round_id FROM dairy.milk_round WHERE center_id=$1 AND round_date=$2 AND shift=$3', [centerId, day, shiftOf(p.at)])).rows[0];
  let testId = null;
  if (m && settings.analyzer_for_pricing && (v.fat_pct !== null || v.snf_pct !== null)) {
    // ใช้คิดราคา: เป็นผลตรวจล่าสุดของวันนั้น (ราคา = ราคาฐาน ± ตารางคุณภาพ ตอนปิดรอบ)
    testId = (await c.query(
      `INSERT INTO dairy.quality_test (coop_org_id, member_id, sample_date, fat_pct, snf_pct, protein_pct, lab_name) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING test_id`,
      [gw.coop_org_id, m.member_id, day, v.fat_pct, v.snf_pct, v.protein_pct, `เครื่องวิเคราะห์ที่ศูนย์ (${d.name})`],
    )).rows[0].test_id;
  }
  const row = (await c.query(
    `INSERT INTO dairy.milk_analysis (coop_org_id, center_id, device_id, member_id, round_id, sample_no, measured_at, fat_pct, snf_pct, protein_pct,
       lactose_pct, density, added_water_pct, freezing_point_c, milk_temp_c, test_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING analysis_id`,
    [gw.coop_org_id, centerId, d.device_id, m ? m.member_id : null, round ? round.round_id : null, ev.sample_no ? String(ev.sample_no).slice(0, 40) : null, p.at,
      v.fat_pct, v.snf_pct, v.protein_pct, v.lactose_pct, v.density, v.added_water_pct, v.freezing_point_c, v.milk_temp_c, testId],
  )).rows[0];
  const warn = qualityWarning(v);
  if (warn) {
    await c.query('INSERT INTO dairy.iot_alert (device_id, alert_type, value, message) VALUES ($1,$2,$3,$4)', [
      d.device_id, 'milk_quality', v.added_water_pct ?? v.freezing_point_c,
      `${d.name}: ${m ? `${m.member_code} ${m.full_name}` : `ตัวอย่าง ${ev.sample_no || '-'}`} — ${warn} (ตรวจซ้ำก่อนตัดสิน)`]);
  }
  await c.query('UPDATE dairy.iot_device SET last_seen_at=now() WHERE device_id=$1', [d.device_id]);
  return { analysis_id: row.analysis_id, member_code: m ? m.member_code : null, used_for_pricing: !!testId, warning: warn };
}

/** ประมวลผลหนึ่งชุด. gw = แถว dairy.iot_device ชนิด gateway. */
async function processBatch(c, gw, body, now = new Date()) {
  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length > MAX_EVENTS) throw bad('too_many_events', { max: MAX_EVENTS });
  const settings = (await c.query('SELECT * FROM dairy.setting WHERE coop_org_id=$1', [gw.coop_org_id])).rows[0] || {};
  const results = [];
  for (const ev of events) {
    const id = ev && typeof ev.id === 'string' ? ev.id : null;
    let p;
    try { p = parseEvent(ev, now); } catch (e) { results.push({ id, status: 'error', error: e.body ? e.body.error : 'invalid_event' }); continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const seen = (await c.query('SELECT status, error, result FROM dairy.iot_event WHERE device_id=$1 AND event_id=$2', [gw.device_id, p.id])).rows[0];
    if (seen) { results.push({ id: p.id, status: 'duplicate', ok: seen.status === 'ok', error: seen.error, data: seen.result }); continue; } // eslint-disable-line no-continue
    try {
      await c.query('BEGIN'); // eslint-disable-line no-await-in-loop
      // จองรหัสเหตุการณ์ก่อน — ชุดที่ส่งซ้ำพร้อมกันจะรอแล้วชน PK แทนที่จะบันทึกซ้ำ
      // eslint-disable-next-line no-await-in-loop
      await c.query(`INSERT INTO dairy.iot_event (device_id, event_id, event_type, measured_at, status) VALUES ($1,$2,$3,$4,'ok')`, [gw.device_id, p.id, p.type, p.at]);
      let data = {};
      if (p.type === 'intake') data = await onIntake(c, gw, ev, p); // eslint-disable-line no-await-in-loop
      else if (p.type === 'reading') data = await onReading(c, gw, ev, p); // eslint-disable-line no-await-in-loop
      else if (p.type === 'analysis') data = await onAnalysis(c, gw, ev, p, settings); // eslint-disable-line no-await-in-loop
      // eslint-disable-next-line no-await-in-loop
      await c.query('UPDATE dairy.iot_event SET result=$3 WHERE device_id=$1 AND event_id=$2', [gw.device_id, p.id, JSON.stringify(data)]);
      await c.query('COMMIT'); // eslint-disable-line no-await-in-loop
      results.push({ id: p.id, status: 'ok', data });
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {}); // eslint-disable-line no-await-in-loop
      if (err.httpStatus && err.httpStatus < 500) {
        // ผิดถาวร: จำไว้ ส่งซ้ำก็ได้คำตอบเดิม
        // eslint-disable-next-line no-await-in-loop
        await c.query(
          `INSERT INTO dairy.iot_event (device_id, event_id, event_type, measured_at, status, error, result) VALUES ($1,$2,$3,$4,'error',$5,$6) ON CONFLICT DO NOTHING`,
          [gw.device_id, p.id, p.type, p.at, err.body.error, JSON.stringify(err.body)],
        );
        results.push({ id: p.id, status: 'error', error: err.body.error, data: err.body });
      } else {
        if (err.code !== '23505') console.error('[dairy-gateway] event failed', p.type, err.message);
        results.push({ id: p.id, status: 'retry' });
      }
    }
  }
  const info = body.gateway && typeof body.gateway === 'object' ? body.gateway : {};
  // เก็บเฉพาะค่าที่ส่งมา (ชุดที่ไม่มีข้อมูล gateway ไม่ลบค่าเดิม)
  const keep = { seen_at: now.toISOString() };
  if (info.version) keep.version = String(info.version).slice(0, 40);
  if (Number.isFinite(info.queue)) keep.queue = info.queue;
  if (Number.isFinite(info.uptime_s)) keep.uptime_s = info.uptime_s;
  if (Array.isArray(info.ports)) keep.ports = info.ports.slice(0, 20);
  await c.query(`UPDATE dairy.iot_device SET last_seen_at=now(), gateway_info=COALESCE(gateway_info, '{}'::jsonb) || $2::jsonb WHERE device_id=$1`,
    [gw.device_id, JSON.stringify(keep)]);
  // กลับมาออนไลน์ → ปิดเตือน "ออฟไลน์" ที่ค้างอยู่
  await c.query(`UPDATE dairy.iot_alert SET acknowledged_at=now() WHERE device_id=$1 AND alert_type='offline' AND acknowledged_at IS NULL`, [gw.device_id]);
  return { server_time: now.toISOString(), results };
}

/** สิ่งที่ gateway ต้องรู้ (ดึงทุก 10 นาที เก็บไว้ใช้ตอนออฟไลน์). */
async function gatewayConfig(c, gw) {
  const today = bkkToday();
  const center = gw.center_id ? (await c.query('SELECT center_id, name, tank_capacity_kg FROM dairy.collection_center WHERE center_id=$1', [gw.center_id])).rows[0] : null;
  const channels = (await c.query(
    `SELECT channel, device_type, name, temp_min, temp_max FROM dairy.iot_device WHERE gateway_id=$1 AND active ORDER BY channel`, [gw.device_id],
  )).rows;
  const members = (await c.query(
    `SELECT m.member_code, m.full_name,
            EXISTS (SELECT 1 FROM dairy.animal a WHERE a.member_id=m.member_id AND a.status='Milking' AND a.withdrawal_until >= $3) AS withdrawal
       FROM dairy.member m WHERE m.coop_org_id=$1 AND m.status='Approved' AND (m.center_id=$2 OR m.center_id IS NULL) ORDER BY m.member_code`,
    [gw.coop_org_id, gw.center_id, today],
  )).rows;
  const org = (await c.query('SELECT org_name FROM identity.organization WHERE org_id=$1', [gw.coop_org_id])).rows[0];
  return {
    server_time: new Date().toISOString(), gateway: { name: gw.name, offline_after_min: gw.offline_after_min }, coop: org ? org.org_name : null, center, channels, members,
  };
}

/** เปิดเตือน "ออฟไลน์" ให้ gateway ที่เงียบเกินกำหนด (ทุก 60 วินาที). */
async function checkOffline(c) {
  return (await c.query(
    `INSERT INTO dairy.iot_alert (device_id, alert_type, message)
     SELECT d.device_id, 'offline', d.name || ': ไม่มีสัญญาณเกิน ' || d.offline_after_min || ' นาที (ล่าสุด ' || to_char(d.last_seen_at AT TIME ZONE 'Asia/Bangkok', 'DD/MM HH24:MI') || ' น.)'
       FROM dairy.iot_device d
      WHERE d.active AND d.offline_after_min IS NOT NULL AND d.last_seen_at IS NOT NULL
        AND d.last_seen_at < now() - make_interval(mins => d.offline_after_min)
        AND NOT EXISTS (SELECT 1 FROM dairy.iot_alert a WHERE a.device_id=d.device_id AND a.alert_type='offline' AND a.acknowledged_at IS NULL)
     RETURNING device_id`,
  )).rows.length;
}

let interval = null;
function start() {
  if (interval || process.env.NODE_ENV === 'test') return;
  const { withServiceRole } = require('../db/pool'); // eslint-disable-line global-require
  interval = setInterval(() => {
    withServiceRole((c) => checkOffline(c)).catch((err) => {
      if (err.code !== '42703' && err.code !== '42P01') console.error('[dairy-gateway] offline check failed', err.message);
    });
  }, 60000);
  if (interval.unref) interval.unref();
}

module.exports = {
  parseEvent, analysisValues, qualityWarning, processBatch, gatewayConfig, checkOffline, tempAlerts, start, bkkDay, MAX_EVENTS, round2,
};
