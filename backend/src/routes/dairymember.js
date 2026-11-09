const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireFarmer } = require('../middleware/auth');
const {
  h, tx, bad, notFound, conflict, bkkToday, isDate, needPos, isUuid, addDays, priceFor, MEMBER_EVENT_TYPES,
} = require('../lib/dairy');
const core = require('../lib/dairyCore');

/**
 * /dairy-member — หน้ามือถือสำหรับสมาชิกผู้เลี้ยงโคนม (JWT เกษตรกร).
 * เกษตรกรคนหนึ่งอาจเป็นสมาชิกได้หลายสหกรณ์ — ทุก endpoint รับ member_id แล้ว
 * ตรวจว่า dairy.member.farmer_id = ผู้ login เสมอ (ไม่มี RLS ในสคีมานี้).
 * สมาชิกบันทึกได้เฉพาะเหตุการณ์ที่ทำเองได้ (เป็นสัด คลอด หยุดรีด บันทึก)
 * การรักษา/ผสมเทียม/ตรวจท้องบันทึกโดยสหกรณ์หรือสัตวแพทย์เท่านั้น.
 */
const router = express.Router();
router.use(requireAuth, requireFarmer);

const db = (req, fn) => withSessionContext('farmer', req.subject.subjectId, (client) => fn(client, req.subject.subjectId));

async function myMember(c, farmerId, memberId) {
  if (!isUuid(memberId)) throw notFound('member_not_found');
  const r = await c.query(
    `SELECT m.*, o.org_name AS coop_name FROM dairy.member m JOIN identity.organization o ON o.org_id=m.coop_org_id
      WHERE m.member_id=$1 AND m.farmer_id=$2`, [memberId, farmerId],
  );
  if (!r.rows.length) throw notFound('member_not_found');
  return r.rows[0];
}
const mid = (req) => req.query.member_id || (req.body || {}).member_id;

router.get('/coops', h(async (req) => db(req, async (c) => (await c.query(
  `SELECT o.org_id, o.org_name FROM dairy.setting s JOIN identity.organization o ON o.org_id=s.coop_org_id
     JOIN identity.organization_role r ON r.org_id=o.org_id AND r.role_type='Cooperative' AND r.status='Verified'
    WHERE o.kyb_status='Verified' ORDER BY o.org_name`,
)).rows)));

router.get('/memberships', h(async (req) => db(req, async (c, farmer) => (await c.query(
  `SELECT m.member_id, m.member_code, m.status, m.coop_org_id, o.org_name AS coop_name FROM dairy.member m
     JOIN identity.organization o ON o.org_id=m.coop_org_id WHERE m.farmer_id=$1 ORDER BY m.created_at`, [farmer],
)).rows)));

router.post('/join', h(async (req) => db(req, async (c, farmer) => {
  const b = req.body || {};
  if (!isUuid(b.coop_org_id)) throw bad('invalid_coop');
  if (!(await c.query('SELECT 1 FROM dairy.setting WHERE coop_org_id=$1', [b.coop_org_id])).rows.length) throw notFound('coop_not_found');
  const f = (await c.query('SELECT full_name, phone FROM identity.farmer WHERE farmer_id=$1', [farmer])).rows[0];
  return tx(c, async () => {
    const n = (await c.query('SELECT COUNT(*)::int AS n FROM dairy.member WHERE coop_org_id=$1', [b.coop_org_id])).rows[0].n;
    try {
      const r = (await c.query(
        `INSERT INTO dairy.member (coop_org_id, farmer_id, member_code, full_name, phone, address, farm_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING member_id, member_code, status`,
        [b.coop_org_id, farmer, `D${String(n + 1).padStart(4, '0')}`, f.full_name, f.phone, b.address || null, b.farm_name || null],
      )).rows[0];
      await logAccess(c, 'write', 'dairy.member', r.member_id);
      return r;
    } catch (e) {
      if (e.code === '23505') throw conflict('already_member');
      throw e;
    }
  });
})));

/** หน้าหลัก: น้ำนมวันนี้/7 วัน, ผลคุณภาพล่าสุด + ราคาที่ได้, ยอดค้างรอบนี้, งานฝูงที่ต้องทำ */
router.get('/home', h(async (req) => db(req, async (c, farmer) => {
  const m = await myMember(c, farmer, mid(req));
  const today = bkkToday();
  const s = await core.settings(c, m.coop_org_id);
  const rules = (await c.query('SELECT * FROM dairy.quality_rule WHERE coop_org_id=$1 AND active', [m.coop_org_id])).rows;
  const recent = (await c.query(
    `SELECT r.round_date::text AS round_date, r.shift, i.weight_kg, i.status, i.reject_reason, i.price_per_kg, i.amount
       FROM dairy.milk_intake i JOIN dairy.milk_round r USING (round_id) WHERE i.member_id=$1 AND r.round_date >= $2::date - 6
      ORDER BY r.round_date DESC, r.shift DESC`, [m.member_id, today],
  )).rows;
  const test = (await c.query(
    `SELECT sample_date::text AS sample_date, fat_pct, snf_pct, protein_pct, scc_k, tbc_k, antibiotic_pos FROM dairy.quality_test
      WHERE member_id=$1 ORDER BY sample_date DESC, created_at DESC LIMIT 1`, [m.member_id],
  )).rows[0] || null;
  const tasks = (await c.query(
    `SELECT ear_tag, name, status, expected_calving_date::text AS ecd, dry_off_due_date::text AS dod, withdrawal_until::text AS wu
       FROM dairy.animal WHERE member_id=$1 AND status NOT IN ('Sold','Dead','Culled')
        AND ((pregnant AND expected_calving_date <= $2::date + 21) OR (status='Milking' AND dry_off_due_date <= $2::date + 7) OR withdrawal_until >= $2)`,
    [m.member_id, today],
  )).rows.map((a) => {
    const out = [];
    if (a.wu && a.wu >= today) out.push({ type: 'withdrawal', ear_tag: a.ear_tag, date: a.wu });
    if (a.ecd) out.push({ type: 'calving', ear_tag: a.ear_tag, date: a.ecd });
    if (a.status === 'Milking' && a.dod) out.push({ type: 'dry_off', ear_tag: a.ear_tag, date: a.dod });
    return out;
  }).flat();
  const herd = (await c.query(
    `SELECT status, COUNT(*)::int AS n FROM dairy.animal WHERE member_id=$1 AND status NOT IN ('Sold','Dead','Culled') GROUP BY 1`, [m.member_id],
  )).rows;
  const unsettled = await core.openBalance(c, m.member_id);
  const last = (await c.query(`SELECT MAX(period_end)::text AS d FROM dairy.settlement_run WHERE coop_org_id=$1 AND status<>'Cancelled'`, [m.coop_org_id])).rows[0].d;
  return {
    member: { member_id: m.member_id, member_code: m.member_code, full_name: m.full_name, coop_name: m.coop_name, status: m.status },
    today, recent, test, price_now: priceFor(s.base_price_per_kg, test, rules), base_price_per_kg: s.base_price_per_kg,
    tasks, herd, unsettled_net: unsettled, next_pay_period_end: last ? addDays(last, Number(s.settlement_days)) : null,
  };
})));

router.get('/animals', h(async (req) => db(req, async (c, farmer) => {
  const m = await myMember(c, farmer, mid(req));
  return (await c.query(
    `SELECT a.*, (SELECT json_agg(e ORDER BY e.event_date DESC) FROM (SELECT event_type, event_date, details FROM dairy.animal_event x
       WHERE x.animal_id=a.animal_id ORDER BY event_date DESC LIMIT 5) e) AS recent_events
       FROM dairy.animal a WHERE a.member_id=$1 AND a.status NOT IN ('Sold','Dead','Culled') ORDER BY a.status, a.ear_tag`, [m.member_id],
  )).rows;
})));

router.post('/animals', h(async (req) => db(req, async (c, farmer) => {
  const b = req.body || {};
  const m = await myMember(c, farmer, b.member_id);
  const tag = String(b.ear_tag || '').trim();
  if (!tag) throw bad('missing_ear_tag');
  const sex = b.sex === 'M' ? 'M' : 'F';
  const status = ['Calf', 'Heifer', 'Milking', 'Dry', 'Bull'].includes(b.status) ? b.status : (sex === 'M' ? 'Bull' : 'Heifer');
  if (b.birth_date && !isDate(b.birth_date)) throw bad('invalid_field', { field: 'birth_date' });
  try {
    return (await c.query(
      `INSERT INTO dairy.animal (coop_org_id, member_id, ear_tag, name, breed, sex, birth_date, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [m.coop_org_id, m.member_id, tag, b.name || null, b.breed || null, sex, b.birth_date || null, status],
    )).rows[0];
  } catch (e) {
    if (e.code === '23505') throw conflict('ear_tag_exists');
    throw e;
  }
})));

router.post('/animals/:id/events', h(async (req) => db(req, async (c, farmer) => tx(c, async () => {
  const b = req.body || {};
  const m = await myMember(c, farmer, b.member_id);
  if (!isUuid(req.params.id)) throw notFound('animal_not_found');
  const a = (await c.query('SELECT * FROM dairy.animal WHERE animal_id=$1 AND member_id=$2 FOR UPDATE', [req.params.id, m.member_id])).rows[0];
  if (!a) throw notFound('animal_not_found');
  if (!MEMBER_EVENT_TYPES.includes(b.event_type)) throw bad('event_not_allowed_for_member');
  const date = b.event_date || bkkToday();
  if (!isDate(date) || date > bkkToday()) throw bad('invalid_field', { field: 'event_date' });
  const details = {};
  if (b.event_type === 'calving') { if (b.calf_ear_tag) details.calf_ear_tag = String(b.calf_ear_tag).trim(); details.calf_sex = b.calf_sex === 'M' ? 'M' : 'F'; }
  if (b.note) details.note = String(b.note).slice(0, 500);
  return core.applyEvent(c, m.coop_org_id, a, b.event_type, date, details, { recorded_by: `farmer:${farmer}` });
}))));

/** คำขอ: เบิกอาหาร/ปัจจัย (item + qty), เรียกสัตวแพทย์ หรือผสมเทียม (เลือกโค แนบรูปได้) */
router.get('/items', h(async (req) => db(req, async (c, farmer) => {
  const m = await myMember(c, farmer, mid(req));
  return (await c.query(`SELECT item_id, name, unit, sell_price, category FROM dairy.supply_item WHERE coop_org_id=$1 AND active AND sell_price > 0 ORDER BY category, name`, [m.coop_org_id])).rows;
})));
router.get('/requests', h(async (req) => db(req, async (c, farmer) => {
  const m = await myMember(c, farmer, mid(req));
  return (await c.query(
    `SELECT r.request_id, r.request_type, r.status, r.description, r.qty, r.created_at, r.done_at, a.ear_tag, i.name AS item_name, i.unit, p.name AS partner_name
       FROM dairy.service_request r LEFT JOIN dairy.animal a ON a.animal_id=r.animal_id LEFT JOIN dairy.supply_item i ON i.item_id=r.item_id
       LEFT JOIN dairy.partner p ON p.partner_id=r.assigned_partner_id WHERE r.member_id=$1 ORDER BY r.created_at DESC LIMIT 50`, [m.member_id],
  )).rows;
})));
router.post('/requests', h(async (req) => db(req, async (c, farmer) => {
  const b = req.body || {};
  const m = await myMember(c, farmer, b.member_id);
  if (m.status !== 'Approved') throw conflict('member_not_approved');
  if (!['feed', 'vet', 'ai'].includes(b.request_type)) throw bad('invalid_field', { field: 'request_type' });
  let animalId = null; let itemId = null; let qty = null;
  if (b.request_type === 'feed') {
    if (!isUuid(b.item_id)) throw bad('invalid_field', { field: 'item_id' });
    const it = (await c.query('SELECT item_id FROM dairy.supply_item WHERE item_id=$1 AND coop_org_id=$2 AND active', [b.item_id, m.coop_org_id])).rows[0];
    if (!it) throw notFound('item_not_found');
    itemId = it.item_id; qty = needPos(b.qty, 'qty');
  } else if (b.animal_id) {
    if (!isUuid(b.animal_id)) throw notFound('animal_not_found');
    const a = (await c.query('SELECT animal_id FROM dairy.animal WHERE animal_id=$1 AND member_id=$2', [b.animal_id, m.member_id])).rows[0];
    if (!a) throw notFound('animal_not_found');
    animalId = a.animal_id;
  }
  const photo = b.photo_data_url || null;
  if (photo && (!/^data:image\/(jpeg|png|webp);base64,/.test(photo) || photo.length > 1.5 * 1024 * 1024)) throw bad('photo_too_large');
  return (await c.query(
    `INSERT INTO dairy.service_request (coop_org_id, member_id, request_type, animal_id, item_id, qty, description, photo_data_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING request_id, request_type, status, created_at`,
    [m.coop_org_id, m.member_id, b.request_type, animalId, itemId, qty, b.description ? String(b.description).slice(0, 1000) : null, photo],
  )).rows[0];
})));

/** ใบแจ้งยอด: รายการค้าง (รอบนี้) + รอบจ่ายที่ผ่านมา */
router.get('/statement', h(async (req) => db(req, async (c, farmer) => {
  const m = await myMember(c, farmer, mid(req));
  const open = (await c.query(
    `SELECT entry_date::text AS entry_date, entry_type, amount, note FROM dairy.member_ledger WHERE member_id=$1 AND run_id IS NULL ORDER BY entry_date DESC, created_at DESC LIMIT 300`,
    [m.member_id],
  )).rows;
  const runs = (await c.query(
    `SELECT r.run_id, r.period_start::text AS period_start, r.period_end::text AS period_end, r.status, r.paid_at, s.total_credit, s.total_debit, s.net_amount, s.carried_debit
       FROM dairy.settlement_line s JOIN dairy.settlement_run r ON r.run_id=s.run_id WHERE s.member_id=$1 AND r.status <> 'Cancelled'
      ORDER BY r.period_end DESC LIMIT 24`, [m.member_id],
  )).rows;
  return { open, open_total: open.reduce((a, x) => a + Number(x.amount), 0), runs, baac_account_no: m.baac_account_no ? `****${m.baac_account_no.slice(-4)}` : null };
})));

module.exports = router;
