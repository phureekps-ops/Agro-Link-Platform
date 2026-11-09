const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');
const {
  h, tx, bad, notFound, conflict, bkkToday, isDate, isUuid, needPos, needNonNeg,
} = require('../lib/dairy');
const core = require('../lib/dairyCore');

/**
 * /dairy-partner — พอร์ทัลคู่ค้าโคนม สำหรับองค์กรที่มีบัญชีบน AgroLink:
 *  - โรงงานแปรรูปนม: ยืนยันรับนม+ผลตรวจปลายทาง, ดูสัญญา, ตลาดนมส่วนเกิน
 *    (ลงทะเบียนโปรไฟล์โรงงาน ประกาศกำลังรับว่าง เสนอรับนม/ตอบรับข้อเสนอ)
 *  - ผู้ขายอาหารสัตว์: ยืนยันใบสั่งซื้อ
 *  - สัตวแพทย์/ผสมเทียม: งานที่สหกรณ์มอบหมาย บันทึกการรักษา (คิดเงินสมาชิก)
 *  - ผู้ซื้อผลิตภัณฑ์: ประวัติการซื้อ
 * SECURITY: เอกสารของสหกรณ์กรองด้วย partner.linked_org_id = องค์กรที่ login;
 * ตลาดนมส่วนเกินกรองด้วย processor_profile.org_id = องค์กรที่ login.
 */
const router = express.Router();
router.use(requireAuth, requireOrganization);

const db = (req, fn) => withSessionContext('organization', req.subject.subjectId, (client) => fn(client, req.subject.subjectId));

router.get('/links', h(async (req) => db(req, async (c, org) => ({
  links: (await c.query(
    `SELECT p.partner_id, p.partner_type, p.name, p.coop_org_id, o.org_name AS coop_name FROM dairy.partner p
       JOIN identity.organization o ON o.org_id=p.coop_org_id WHERE p.linked_org_id=$1 AND p.active ORDER BY o.org_name, p.partner_type`, [org],
  )).rows,
  processor_profile: (await c.query('SELECT * FROM dairy.processor_profile WHERE org_id=$1', [org])).rows[0] || null,
}))));

// ---- โรงงานแปรรูป: โปรไฟล์ + กำลังรับว่าง ----
router.put('/processor/profile', h(async (req) => db(req, async (c, org) => {
  const b = req.body || {};
  const o = (await c.query(`SELECT org_name FROM identity.organization WHERE org_id=$1 AND kyb_status='Verified'`, [org])).rows[0];
  if (!o) throw conflict('kyb_not_verified');
  const name = String(b.display_name || o.org_name).trim();
  if (b.province_code && !(await c.query('SELECT 1 FROM registry.province WHERE province_code=$1', [b.province_code])).rows.length) throw bad('invalid_province');
  return (await c.query(
    `INSERT INTO dairy.processor_profile (org_id, display_name, province_code, products, contact_phone, active) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (org_id) DO UPDATE SET display_name=EXCLUDED.display_name, province_code=EXCLUDED.province_code, products=EXCLUDED.products,
       contact_phone=EXCLUDED.contact_phone, active=EXCLUDED.active RETURNING *`,
    [org, name, b.province_code || null, b.products || null, b.contact_phone || null, b.active !== false],
  )).rows[0];
})));

async function myProfile(c, org) {
  const p = (await c.query('SELECT * FROM dairy.processor_profile WHERE org_id=$1 AND active', [org])).rows[0];
  if (!p) throw conflict('processor_profile_required');
  return p;
}

router.get('/processor/capacities', h(async (req) => db(req, async (c, org) => (await c.query(
  'SELECT * FROM dairy.processor_capacity WHERE org_id=$1 ORDER BY active DESC, available_from DESC LIMIT 100', [org],
)).rows)));
router.post('/processor/capacities', h(async (req) => db(req, async (c, org) => {
  await myProfile(c, org);
  const b = req.body || {};
  if (!isDate(b.available_from) || !isDate(b.available_to) || b.available_to < b.available_from || b.available_to < bkkToday()) throw bad('invalid_dates');
  return (await c.query(
    `INSERT INTO dairy.processor_capacity (org_id, available_from, available_to, kg_per_day, price_per_kg, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [org, b.available_from, b.available_to, needPos(b.kg_per_day, 'kg_per_day'), needNonNeg(b.price_per_kg, 'price_per_kg'), b.note || null],
  )).rows[0];
})));
router.post('/processor/capacities/:id/close', h(async (req) => db(req, async (c, org) => {
  if (!isUuid(req.params.id)) throw notFound('capacity_not_found');
  const r = (await c.query('UPDATE dairy.processor_capacity SET active=false WHERE capacity_id=$1 AND org_id=$2 RETURNING *', [req.params.id, org])).rows[0];
  if (!r) throw notFound('capacity_not_found');
  return r;
})));

// ---- ตลาดนมส่วนเกิน ----
router.get('/market', h(async (req) => db(req, async (c, org) => {
  const prof = (await c.query('SELECT * FROM dairy.processor_profile WHERE org_id=$1', [org])).rows[0] || null;
  const offers = (await c.query(
    `SELECT o.offer_id, o.start_date, o.days, o.kg_per_day, o.min_price, o.avg_fat_pct, o.avg_snf_pct, o.note, o.created_at,
            org.org_name AS coop_name, pv.province_name_th
       FROM dairy.surplus_offer o JOIN identity.organization org ON org.org_id=o.coop_org_id
       LEFT JOIN registry.cooperative_profile cp ON cp.org_id=o.coop_org_id LEFT JOIN registry.province pv ON pv.province_code=cp.province_code
      WHERE o.status='Open' AND o.start_date + o.days > $1 ORDER BY o.start_date LIMIT 200`, [bkkToday()],
  )).rows;
  const proposals = (await c.query(
    `SELECT p.*, o.start_date, o.days, org.org_name AS coop_name, o.status AS offer_status
       FROM dairy.surplus_proposal p JOIN dairy.surplus_offer o USING (offer_id) JOIN identity.organization org ON org.org_id=o.coop_org_id
      WHERE p.processor_org_id=$1 ORDER BY p.created_at DESC LIMIT 100`, [org],
  )).rows;
  return { profile: prof, offers, proposals };
})));
router.post('/market/offers/:id/propose', h(async (req) => db(req, async (c, org) => {
  await myProfile(c, org);
  if (!isUuid(req.params.id)) throw notFound('offer_not_found');
  const o = (await c.query(`SELECT * FROM dairy.surplus_offer WHERE offer_id=$1 AND status='Open'`, [req.params.id])).rows[0];
  if (!o) throw notFound('offer_not_found');
  const b = req.body || {};
  const price = needNonNeg(b.price_per_kg, 'price_per_kg');
  if (price < Number(o.min_price)) throw bad('below_min_price', { min_price: Number(o.min_price) });
  const kg = needPos(b.kg_per_day, 'kg_per_day');
  if (kg > Number(o.kg_per_day)) throw bad('more_than_offered');
  try {
    return (await c.query(
      `INSERT INTO dairy.surplus_proposal (offer_id, processor_org_id, kg_per_day, price_per_kg, proposed_by) VALUES ($1,$2,$3,$4,'processor') RETURNING *`,
      [o.offer_id, org, kg, price],
    )).rows[0];
  } catch (e) {
    if (e.code === '23505') throw conflict('proposal_exists');
    throw e;
  }
})));
async function myProposal(c, org, id) {
  if (!isUuid(id)) throw notFound('proposal_not_found');
  const p = (await c.query('SELECT * FROM dairy.surplus_proposal WHERE proposal_id=$1 AND processor_org_id=$2 FOR UPDATE', [id, org])).rows[0];
  if (!p) throw notFound('proposal_not_found');
  return p;
}
router.post('/market/proposals/:id/accept', h(async (req) => db(req, async (c, org) => tx(c, async () => {
  const p = await myProposal(c, org, req.params.id);
  if (p.proposed_by !== 'coop') throw conflict('waiting_for_coop');
  const o = (await c.query('SELECT * FROM dairy.surplus_offer WHERE offer_id=$1 FOR UPDATE', [p.offer_id])).rows[0];
  return core.acceptProposal(c, p, o);
}))));
router.post('/market/proposals/:id/reject', h(async (req) => db(req, async (c, org) => {
  const p = await myProposal(c, org, req.params.id);
  if (p.status !== 'Pending') throw conflict('invalid_proposal_status');
  const status = p.proposed_by === 'processor' ? 'Withdrawn' : 'Rejected';
  return (await c.query('UPDATE dairy.surplus_proposal SET status=$2, decided_at=now() WHERE proposal_id=$1 RETURNING *', [p.proposal_id, status])).rows[0];
})));

// ---- โรงงาน: สัญญาและการรับนม ----
router.get('/contracts', h(async (req) => db(req, async (c, org) => (await c.query(
  `SELECT k.contract_id, k.contract_no, k.start_date, k.end_date, k.daily_kg, k.price_per_kg, k.payment_days, k.status, o.org_name AS coop_name
     FROM dairy.contract k JOIN dairy.partner p ON p.partner_id=k.partner_id JOIN identity.organization o ON o.org_id=k.coop_org_id
    WHERE p.linked_org_id=$1 ORDER BY k.status, k.end_date DESC`, [org],
)).rows)));
router.get('/shipments', h(async (req) => db(req, async (c, org) => {
  const r = (await c.query(
    `SELECT s.shipment_id, s.ship_date, s.vehicle, s.driver_name, s.sent_kg, s.tank_temp_c, s.status, s.received_kg, s.fat_pct, s.snf_pct, s.scc_k, s.tbc_k,
            s.price_per_kg, s.amount, s.reject_reason, s.paid_at, s.proposal_id IS NOT NULL AS is_surplus, k.contract_no, k.price_per_kg AS contract_price,
            sp.price_per_kg AS deal_price, o.org_name AS coop_name
       FROM dairy.shipment s JOIN dairy.partner p ON p.partner_id=s.partner_id JOIN identity.organization o ON o.org_id=s.coop_org_id
       LEFT JOIN dairy.contract k ON k.contract_id=s.contract_id LEFT JOIN dairy.surplus_proposal sp ON sp.proposal_id=s.proposal_id
      WHERE p.linked_org_id=$1 AND s.status <> 'Cancelled' ORDER BY (s.status='Sent') DESC, s.ship_date DESC LIMIT 200`, [org],
  )).rows;
  await logAccess(c, 'read', 'dairy.shipment', org);
  return r;
})));
router.post('/shipments/:id/receive', h(async (req) => db(req, async (c, org) => tx(c, async () => {
  if (!isUuid(req.params.id)) throw notFound('shipment_not_found');
  const s = (await c.query(
    `SELECT s.* FROM dairy.shipment s JOIN dairy.partner p ON p.partner_id=s.partner_id WHERE s.shipment_id=$1 AND p.linked_org_id=$2 FOR UPDATE OF s`,
    [req.params.id, org],
  )).rows[0];
  if (!s) throw notFound('shipment_not_found');
  return core.receiveShipment(c, s, req.body || {});
}))));

// ---- ผู้ขายอาหารสัตว์ ----
router.get('/purchase-orders', h(async (req) => db(req, async (c, org) => (await c.query(
  `SELECT po.po_id, po.status, po.expected_date, po.total_amount, po.fee_rate_pct, po.fee_amount, po.note, po.ordered_at, po.confirmed_at, po.delivered_at, po.paid_at,
          o.org_name AS coop_name,
          COALESCE(json_agg(json_build_object('name', i.name, 'unit', i.unit, 'qty', l.qty, 'unit_price', l.unit_price, 'amount', l.amount))
            FILTER (WHERE l.line_id IS NOT NULL), '[]') AS lines
     FROM dairy.purchase_order po JOIN dairy.partner p ON p.partner_id=po.partner_id JOIN identity.organization o ON o.org_id=po.coop_org_id
     LEFT JOIN dairy.purchase_order_line l ON l.po_id=po.po_id LEFT JOIN dairy.supply_item i ON i.item_id=l.item_id
    WHERE p.linked_org_id=$1 GROUP BY po.po_id, o.org_name ORDER BY po.ordered_at DESC LIMIT 200`, [org],
)).rows)));
router.post('/purchase-orders/:id/confirm', h(async (req) => db(req, async (c, org) => {
  if (!isUuid(req.params.id)) throw notFound('po_not_found');
  const r = (await c.query(
    `UPDATE dairy.purchase_order po SET status='Confirmed', confirmed_at=now() FROM dairy.partner p
      WHERE po.po_id=$1 AND p.partner_id=po.partner_id AND p.linked_org_id=$2 AND po.status='Ordered' RETURNING po.*`, [req.params.id, org],
  )).rows[0];
  if (!r) throw conflict('po_not_confirmable');
  return r;
})));

// ---- สัตวแพทย์ / เจ้าหน้าที่ผสมเทียม ----
router.get('/vet/requests', h(async (req) => db(req, async (c, org) => (await c.query(
  `SELECT r.request_id, r.request_type, r.status, r.description, r.created_at, r.done_at, (r.photo_data_url IS NOT NULL) AS has_photo,
          m.full_name AS member_name, m.phone AS member_phone, m.address, a.animal_id, a.ear_tag, a.status AS animal_status, a.last_insemination_date,
          o.org_name AS coop_name
     FROM dairy.service_request r JOIN dairy.partner p ON p.partner_id=r.assigned_partner_id JOIN dairy.member m ON m.member_id=r.member_id
     JOIN identity.organization o ON o.org_id=r.coop_org_id LEFT JOIN dairy.animal a ON a.animal_id=r.animal_id
    WHERE p.linked_org_id=$1 AND p.partner_type='vet' ORDER BY (r.status='Assigned') DESC, r.created_at DESC LIMIT 200`, [org],
)).rows)));
router.get('/vet/requests/:id/photo', h(async (req) => db(req, async (c, org) => {
  if (!isUuid(req.params.id)) throw notFound('request_not_found');
  const r = (await c.query(
    `SELECT r.photo_data_url FROM dairy.service_request r JOIN dairy.partner p ON p.partner_id=r.assigned_partner_id WHERE r.request_id=$1 AND p.linked_org_id=$2`,
    [req.params.id, org],
  )).rows[0];
  if (!r) throw notFound('request_not_found');
  return r;
})));
/** บันทึกงานที่ทำ (รักษา/วัคซีน/ผสมเทียม/ตรวจท้อง) — ค่าบริการถูกหักจากบัญชีสมาชิก */
router.post('/vet/requests/:id/record', h(async (req) => db(req, async (c, org) => tx(c, async () => {
  if (!isUuid(req.params.id)) throw notFound('request_not_found');
  const r = (await c.query(
    `SELECT r.*, p.partner_id AS vet_id FROM dairy.service_request r JOIN dairy.partner p ON p.partner_id=r.assigned_partner_id
      WHERE r.request_id=$1 AND p.linked_org_id=$2 AND p.partner_type='vet' FOR UPDATE OF r`, [req.params.id, org],
  )).rows[0];
  if (!r) throw notFound('request_not_found');
  if (r.status !== 'Assigned') throw conflict('invalid_request_status', { status: r.status });
  const b = req.body || {};
  if (!['treatment', 'vaccination', 'insemination', 'pregnancy_check'].includes(b.event_type)) throw bad('invalid_event_type');
  const animalId = r.animal_id || b.animal_id;
  if (!isUuid(animalId)) throw bad('missing_animal');
  const a = (await c.query('SELECT * FROM dairy.animal WHERE animal_id=$1 AND member_id=$2 FOR UPDATE', [animalId, r.member_id])).rows[0];
  if (!a) throw notFound('animal_not_found');
  const date = b.event_date || bkkToday();
  if (!isDate(date) || date > bkkToday()) throw bad('invalid_field', { field: 'event_date' });
  const cost = b.cost ? needNonNeg(b.cost, 'cost') : 0;
  return core.applyEvent(c, r.coop_org_id, a, b.event_type, date, b.details || {}, {
    cost, vet_partner_id: r.vet_id, recorded_by: `partner_org:${org}`, request_id: r.request_id,
  });
}))));

// ---- ผู้ซื้อผลิตภัณฑ์ ----
router.get('/product-purchases', h(async (req) => db(req, async (c, org) => (await c.query(
  `SELECT s.sold_on, s.units, s.unit_price, s.amount, b.lot_code, b.expires_on, pr.name AS product_name, pr.unit, o.org_name AS coop_name
     FROM dairy.product_sale s JOIN dairy.partner p ON p.partner_id=s.partner_id JOIN dairy.production_batch b ON b.batch_id=s.batch_id
     JOIN dairy.product pr ON pr.product_id=b.product_id JOIN identity.organization o ON o.org_id=s.coop_org_id
    WHERE p.linked_org_id=$1 ORDER BY s.created_at DESC LIMIT 200`, [org],
)).rows)));

module.exports = router;
