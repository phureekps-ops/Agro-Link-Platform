const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireFarmer } = require('../middleware/auth');
const {
  h, tx, bad, notFound, conflict, bkkToday, isDate, needPos, isUuid, GRADES,
} = require('../lib/mushroom');

/**
 * /mushroom-member — หน้าสมาชิกผู้เปิดดอก (เกษตรกรรายย่อย) บนมือถือ.
 * ใช้ JWT ของเกษตรกร (subjectType='farmer') — สมาชิกคนเดียวอาจเป็นสมาชิกได้
 * หลายสหกรณ์ จึงทุก endpoint ที่เกี่ยวกับสหกรณ์ใดสหกรณ์หนึ่งรับ member_id
 * แล้วตรวจว่า mushroom.member.farmer_id = ผู้ login เสมอ (ไม่มี RLS ในสคีมานี้).
 */
const router = express.Router();
router.use(requireAuth, requireFarmer);

const db = (req, fn) => withSessionContext('farmer', req.subject.subjectId, (client) => fn(client, req.subject.subjectId));

async function myMember(c, farmerId, memberId) {
  if (!isUuid(memberId)) throw notFound('member_not_found');
  const r = await c.query(
    `SELECT m.*, o.org_name AS coop_name FROM mushroom.member m JOIN identity.organization o ON o.org_id=m.coop_org_id
      WHERE m.member_id=$1 AND m.farmer_id=$2`,
    [memberId, farmerId],
  );
  if (!r.rows.length) throw notFound('member_not_found');
  return r.rows[0];
}

/** สหกรณ์ที่เปิดใช้โปรแกรมเห็ดฟาง (มีการตั้งค่าแล้ว) — ให้สมาชิกเลือกสมัคร */
router.get('/coops', h(async (req) => db(req, async (c) => {
  const r = await c.query(
    `SELECT o.org_id, o.org_name FROM mushroom.setting s JOIN identity.organization o ON o.org_id=s.coop_org_id
      JOIN identity.organization_role r ON r.org_id=o.org_id AND r.role_type='Cooperative' AND r.status='Verified'
      WHERE o.kyb_status='Verified' ORDER BY o.org_name`,
  );
  return r.rows;
})));

router.get('/memberships', h(async (req) => db(req, async (c, farmer) => {
  const r = await c.query(
    `SELECT m.member_id, m.member_code, m.status, m.coop_org_id, o.org_name AS coop_name, m.capacity_boxes
       FROM mushroom.member m JOIN identity.organization o ON o.org_id=m.coop_org_id
      WHERE m.farmer_id=$1 ORDER BY m.created_at`,
    [farmer],
  );
  return r.rows;
})));

/** สมัครเป็นสมาชิกผู้เปิดดอกของสหกรณ์ (สถานะ Pending รอสหกรณ์ตรวจจุดเปิดดอก) */
router.post('/join', h(async (req) => db(req, async (c, farmer) => {
  const b = req.body || {};
  if (!isUuid(b.coop_org_id)) throw bad('invalid_coop');
  const coop = await c.query('SELECT 1 FROM mushroom.setting WHERE coop_org_id=$1', [b.coop_org_id]);
  if (!coop.rows.length) throw notFound('coop_not_found');
  const f = (await c.query('SELECT full_name, phone FROM identity.farmer WHERE farmer_id=$1', [farmer])).rows[0];
  const cap = b.capacity_boxes !== undefined ? Math.max(0, Math.round(Number(b.capacity_boxes) || 0)) : 0;
  return tx(c, async () => {
    const n = (await c.query('SELECT COUNT(*)::int AS n FROM mushroom.member WHERE coop_org_id=$1', [b.coop_org_id])).rows[0].n;
    try {
      const r = await c.query(
        `INSERT INTO mushroom.member (coop_org_id, farmer_id, member_code, full_name, phone, address, capacity_boxes, wind_protected, water_available)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING member_id, member_code, status`,
        [b.coop_org_id, farmer, `M${String(n + 1).padStart(4, '0')}`, f.full_name, f.phone, b.address || null, cap,
          !!b.wind_protected, !!b.water_available],
      );
      await logAccess(c, 'write', 'mushroom.member', r.rows[0].member_id);
      return r.rows[0];
    } catch (e) {
      if (e.code === '23505') throw conflict('already_member');
      throw e;
    }
  });
})));

/**
 * หน้าหลักสมาชิก: ราคาประกาศวันนี้, กล่องที่ฝากเลี้ยงอยู่ + งานที่ต้องทำ,
 * ยอดรอจ่ายสัปดาห์นี้, รถรอบถัดไป.
 */
router.get('/home', h(async (req) => db(req, async (c, farmer) => {
  const m = await myMember(c, farmer, req.query.member_id);
  const today = bkkToday();
  const prices = (await c.query(
    `SELECT grade, price_per_kg FROM mushroom.daily_price WHERE coop_org_id=$1 AND price_date=$2 ORDER BY grade`,
    [m.coop_org_id, today],
  )).rows;
  const boxes = (await c.query(
    `SELECT b.batch_code, COUNT(*)::int AS boxes, MIN(a.delivered_at) AS delivered_at,
            (CURRENT_DATE - MIN(a.delivered_at AT TIME ZONE 'Asia/Bangkok')::date)::int AS days_on_site
       FROM mushroom.box_assignment a JOIN mushroom.batch b ON b.batch_id=a.batch_id
      WHERE a.member_id=$1 AND a.returned_at IS NULL GROUP BY b.batch_code ORDER BY MIN(a.delivered_at)`,
    [m.member_id],
  )).rows;
  // งานตามวันหลังรับกล่อง ตามแนวทางเปิดดอกของ อ.อานนท์ (ตัดใย -> ดูแลความชื้น -> เก็บดอกตูม)
  const tasks = boxes.map((x) => {
    const d = x.days_on_site;
    let task;
    if (d <= 0) task = 'วางกล่องในจุดที่กันลม แล้วรดน้ำกระตุ้นให้เส้นใยยุบ (ตัดใย)';
    else if (d <= 3) task = 'รักษาความชื้น อย่าให้ผิววัสดุแห้ง สังเกตตุ่มดอก';
    else task = 'ตรวจดอกทุกเช้า เก็บดอกตูมตามมาตรฐาน แจ้งรถรับเห็ด';
    return { batch_code: x.batch_code, boxes: x.boxes, days_on_site: d, task };
  });
  const [bal] = (await c.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS unsettled_net,
            COALESCE(SUM(amount) FILTER (WHERE entry_type='mushroom_sale'),0)::numeric AS mushroom_sales,
            COALESCE(SUM(amount) FILTER (WHERE entry_type='straw_sale'),0)::numeric AS straw_sales,
            COALESCE(SUM(amount) FILTER (WHERE entry_type IN ('sale_fee','box_liability','adjustment')),0)::numeric AS deductions
       FROM mushroom.member_ledger WHERE member_id=$1 AND run_id IS NULL`,
    [m.member_id],
  )).rows;
  const nextTrip = (await c.query(
    `SELECT t.trip_date, s.drop_boxes, s.collect_mushroom, s.collect_straw, s.status FROM mushroom.trip_stop s JOIN mushroom.trip t ON t.trip_id=s.trip_id
      WHERE s.member_id=$1 AND s.status='Pending' AND t.status IN ('Planned','InProgress') ORDER BY t.trip_date LIMIT 1`,
    [m.member_id],
  )).rows[0] || null;
  const s = (await c.query('SELECT settlement_weekday FROM mushroom.setting WHERE coop_org_id=$1', [m.coop_org_id])).rows[0];
  await logAccess(c, 'read', 'mushroom.member', m.member_id);
  return {
    member: {
      member_id: m.member_id, member_code: m.member_code, full_name: m.full_name, status: m.status, coop_name: m.coop_name,
      capacity_boxes: m.capacity_boxes, baac_account_no: m.baac_account_no ? `xxxxxx${String(m.baac_account_no).slice(-4)}` : null,
    },
    today,
    prices,
    boxes_on_hand: boxes.reduce((t, x) => t + x.boxes, 0),
    tasks,
    balance: bal,
    settlement_weekday: s ? s.settlement_weekday : null,
    next_trip: nextTrip,
  };
})));

router.get('/prices', h(async (req) => db(req, async (c, farmer) => {
  const m = await myMember(c, farmer, req.query.member_id);
  return (await c.query(
    `SELECT price_date, grade, price_per_kg FROM mushroom.daily_price WHERE coop_org_id=$1 ORDER BY price_date DESC, grade LIMIT 42`,
    [m.coop_org_id],
  )).rows;
})));

router.get('/bookings', h(async (req) => db(req, async (c, farmer) => {
  const m = await myMember(c, farmer, req.query.member_id);
  return (await c.query(
    'SELECT booking_id, requested_boxes, wanted_date, status, created_at FROM mushroom.box_booking WHERE member_id=$1 ORDER BY created_at DESC LIMIT 30',
    [m.member_id],
  )).rows;
})));

router.post('/bookings', h(async (req) => db(req, async (c, farmer) => {
  const b = req.body || {};
  const m = await myMember(c, farmer, b.member_id);
  if (m.status !== 'Approved') throw conflict('member_not_approved');
  const n = Math.round(needPos(b.requested_boxes, 'requested_boxes'));
  if (!isDate(b.wanted_date) || b.wanted_date < bkkToday()) throw bad('invalid_wanted_date');
  const onHand = (await c.query('SELECT COUNT(*)::int AS n FROM mushroom.box_assignment WHERE member_id=$1 AND returned_at IS NULL', [m.member_id])).rows[0].n;
  if (m.capacity_boxes > 0 && onHand + n > m.capacity_boxes) {
    throw conflict('over_member_capacity', { capacity: m.capacity_boxes, on_hand: onHand });
  }
  return (await c.query(
    `INSERT INTO mushroom.box_booking (coop_org_id, member_id, requested_boxes, wanted_date) VALUES ($1,$2,$3,$4)
     RETURNING booking_id, requested_boxes, wanted_date, status`,
    [m.coop_org_id, m.member_id, n, b.wanted_date],
  )).rows[0];
})));

router.post('/bookings/:id/cancel', h(async (req) => db(req, async (c, farmer) => {
  if (!isUuid(req.params.id)) throw notFound('booking_not_found');
  const r = await c.query(
    `UPDATE mushroom.box_booking k SET status='Cancelled' FROM mushroom.member m
      WHERE k.booking_id=$1 AND m.member_id=k.member_id AND m.farmer_id=$2 AND k.status='Requested' RETURNING k.booking_id, k.status`,
    [req.params.id, farmer],
  );
  if (!r.rows.length) throw conflict('booking_not_cancellable');
  return r.rows[0];
})));

const ISSUE_TYPES = ['no_mycelium', 'mold', 'pest', 'box_damaged', 'other'];

/** แจ้งปัญหาพร้อมรูป (photo_url = ลิงก์จาก POST /storage หรือ data URL ขนาดเล็ก) */
router.post('/issues', h(async (req) => db(req, async (c, farmer) => {
  const b = req.body || {};
  const m = await myMember(c, farmer, b.member_id);
  if (!ISSUE_TYPES.includes(b.issue_type)) throw bad('invalid_issue_type');
  const photo = b.photo_url ? String(b.photo_url) : null;
  if (photo && photo.length > 1500000) throw bad('photo_too_large');
  const batch = (await c.query(
    `SELECT batch_id FROM mushroom.box_assignment WHERE member_id=$1 AND returned_at IS NULL ORDER BY delivered_at DESC LIMIT 1`,
    [m.member_id],
  )).rows[0];
  return (await c.query(
    `INSERT INTO mushroom.issue_report (coop_org_id, member_id, batch_id, issue_type, note, photo_url)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING report_id, issue_type, status, created_at`,
    [m.coop_org_id, m.member_id, batch ? batch.batch_id : null, b.issue_type, b.note || null, photo],
  )).rows[0];
})));

router.get('/issues', h(async (req) => db(req, async (c, farmer) => {
  const m = await myMember(c, farmer, req.query.member_id);
  return (await c.query(
    'SELECT report_id, issue_type, note, status, resolution, created_at, resolved_at FROM mushroom.issue_report WHERE member_id=$1 ORDER BY created_at DESC LIMIT 30',
    [m.member_id],
  )).rows;
})));

/** แจ้งคาดการณ์เห็ดที่จะเก็บได้ (ช่วยสหกรณ์จัดรถ/ขาย) */
router.post('/harvest-estimate', h(async (req) => db(req, async (c, farmer) => {
  const b = req.body || {};
  const m = await myMember(c, farmer, b.member_id);
  const kg = needPos(b.est_kg, 'est_kg');
  return (await c.query(
    'INSERT INTO mushroom.member_harvest_log (member_id, est_kg, note) VALUES ($1,$2,$3) RETURNING log_id, log_date, est_kg',
    [m.member_id, kg, b.note || null],
  )).rows[0];
})));

router.get('/harvests', h(async (req) => db(req, async (c, farmer) => {
  const m = await myMember(c, farmer, req.query.member_id);
  return (await c.query(
    `SELECT collected_at, grade, weight_kg, price_per_kg, amount, fee_amount FROM mushroom.harvest
      WHERE member_id=$1 ORDER BY collected_at DESC LIMIT 100`,
    [m.member_id],
  )).rows;
})));

/** ใบแจ้งยอด: รายการที่ยังไม่เข้ารอบ + รอบหักกลบที่ผ่านมา */
router.get('/statement', h(async (req) => db(req, async (c, farmer) => {
  const m = await myMember(c, farmer, req.query.member_id);
  const open = (await c.query(
    `SELECT entry_date, entry_type, amount, note FROM mushroom.member_ledger WHERE member_id=$1 AND run_id IS NULL
      ORDER BY entry_date DESC, created_at DESC LIMIT 200`,
    [m.member_id],
  )).rows;
  const runs = (await c.query(
    `SELECT r.period_start, r.period_end, r.status, r.paid_at, s.total_credit, s.total_debit, s.net_amount
       FROM mushroom.settlement_line s JOIN mushroom.settlement_run r ON r.run_id=s.run_id
      WHERE s.member_id=$1 AND r.status <> 'Cancelled' ORDER BY r.period_end DESC LIMIT 26`,
    [m.member_id],
  )).rows;
  await logAccess(c, 'read', 'mushroom.member_ledger', m.member_id);
  return { open_entries: open, settlements: runs };
})));

router.get('/grades', h(async () => GRADES));

module.exports = router;
