const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');
const {
  h, tx, bad, notFound, conflict, isDate, isUuid, round2, needPos, needNonNeg, GRADES, PRODUCT_TYPES,
} = require('../lib/mushroom');
const coopRouter = require('./mushroom');

/**
 * /mushroom-partner — คู่ค้าภายนอกของโปรแกรมเห็ดฟาง ที่มีบัญชีองค์กรบน AgroLink
 * แล้วสหกรณ์ผูกไว้ (mushroom.partner.linked_org_id): ผู้ขายเศษวัสดุชีวมวล
 * ผู้ขายเชื้อเห็ด ผู้ซื้อ (พ่อค้าส่ง/โรงงานอาหารกระป๋อง) ผู้ขนส่ง.
 *
 * SECURITY: ทุก query กรองด้วย partner.linked_org_id = องค์กรที่ login
 * — คู่ค้าเห็นเฉพาะเอกสารของตนกับสหกรณ์ที่ผูกไว้เท่านั้น.
 */
const router = express.Router();
router.use(requireAuth, requireOrganization);

const db = (req, fn) => withSessionContext('organization', req.subject.subjectId, (client) => fn(client, req.subject.subjectId));

async function myPartner(c, orgId, partnerId, type) {
  if (!isUuid(partnerId)) throw notFound('partner_not_found');
  const r = await c.query(
    `SELECT p.*, o.org_name AS coop_name FROM mushroom.partner p JOIN identity.organization o ON o.org_id=p.coop_org_id
      WHERE p.partner_id=$1 AND p.linked_org_id=$2 AND p.active`,
    [partnerId, orgId],
  );
  if (!r.rows.length) throw notFound('partner_not_found');
  if (type && r.rows[0].partner_type !== type) throw bad('partner_type_mismatch');
  return r.rows[0];
}

router.get('/links', h(async (req) => db(req, async (c, org) => {
  const r = await c.query(
    `SELECT p.partner_id, p.partner_type, p.name, p.coop_org_id, o.org_name AS coop_name
       FROM mushroom.partner p JOIN identity.organization o ON o.org_id=p.coop_org_id
      WHERE p.linked_org_id=$1 AND p.active ORDER BY o.org_name, p.partner_type`,
    [org],
  );
  return r.rows;
})));

// ---- ผู้ขายวัสดุ / ผู้ขายเชื้อ: ใบสั่งซื้อจากสหกรณ์ ----
router.get('/purchase-orders', h(async (req) => db(req, async (c, org) => {
  const r = await c.query(
    `SELECT po.po_id, po.po_type, po.status, po.expected_date, po.total_amount, po.fee_rate_pct, po.fee_amount, po.note,
            po.ordered_at, po.confirmed_at, po.delivered_at, po.paid_at, o.org_name AS coop_name,
            COALESCE(json_agg(json_build_object('line_id', l.line_id, 'item_name', l.item_name, 'qty', l.qty, 'unit', l.unit,
              'unit_price', l.unit_price, 'amount', l.amount, 'spawn_lot_no', l.spawn_lot_no, 'spawn_produced_on', l.spawn_produced_on))
              FILTER (WHERE l.line_id IS NOT NULL), '[]') AS lines
       FROM mushroom.purchase_order po
       JOIN mushroom.partner p ON p.partner_id=po.partner_id
       JOIN identity.organization o ON o.org_id=po.coop_org_id
       LEFT JOIN mushroom.purchase_order_line l ON l.po_id=po.po_id
      WHERE p.linked_org_id=$1 GROUP BY po.po_id, o.org_name ORDER BY po.ordered_at DESC LIMIT 200`,
    [org],
  );
  await logAccess(c, 'read', 'mushroom.purchase_order', org);
  return r.rows;
})));

/** ยืนยันใบสั่งซื้อ; ผู้ขายเชื้อแจ้งเลขล็อตและวันผลิตต่อรายการ */
router.post('/purchase-orders/:id/confirm', h(async (req) => db(req, async (c, org) => tx(c, async () => {
  if (!isUuid(req.params.id)) throw notFound('po_not_found');
  const po = (await c.query(
    `SELECT po.* FROM mushroom.purchase_order po JOIN mushroom.partner p ON p.partner_id=po.partner_id
      WHERE po.po_id=$1 AND p.linked_org_id=$2 FOR UPDATE OF po`,
    [req.params.id, org],
  )).rows[0];
  if (!po) throw notFound('po_not_found');
  if (po.status !== 'Ordered') throw conflict('invalid_po_status', { status: po.status });
  const lots = Array.isArray((req.body || {}).spawn_lots) ? req.body.spawn_lots : [];
  if (po.po_type === 'spawn') {
    const lines = (await c.query('SELECT line_id FROM mushroom.purchase_order_line WHERE po_id=$1', [po.po_id])).rows;
    for (const ln of lines) {
      const given = lots.find((x) => x.line_id === ln.line_id);
      if (!given || !String(given.lot_no || '').trim()) throw bad('missing_spawn_lot_no', { line_id: ln.line_id });
      if (given.produced_on && !isDate(given.produced_on)) throw bad('invalid_produced_on');
      await c.query('UPDATE mushroom.purchase_order_line SET spawn_lot_no=$2, spawn_produced_on=$3 WHERE line_id=$1',
        [ln.line_id, String(given.lot_no).trim(), given.produced_on || null]);
    }
  }
  return (await c.query(
    `UPDATE mushroom.purchase_order SET status='Confirmed', confirmed_at=now(), expected_date=COALESCE($2::date, expected_date)
      WHERE po_id=$1 RETURNING po_id, status, confirmed_at, expected_date`,
    [po.po_id, isDate((req.body || {}).expected_date) ? req.body.expected_date : null],
  )).rows[0];
}))));

/** ผู้ขายเชื้อดูผลผลิตต่อกล่องของรุ่นที่ใช้เชื้อของตน (ข้อมูลรวม ไม่ระบุตัวสมาชิก) */
router.get('/spawn-performance', h(async (req) => db(req, async (c, org) => {
  const r = await c.query(
    `SELECT s.lot_no, s.produced_on, o.org_name AS coop_name, COUNT(DISTINCT b.batch_id)::int AS batches,
            (SELECT COUNT(*) FROM mushroom.box_assignment a JOIN mushroom.batch b2 ON b2.batch_id=a.batch_id WHERE b2.spawn_lot_id=s.spawn_lot_id)::int AS boxes,
            (SELECT COALESCE(SUM(hv.weight_kg),0) FROM mushroom.harvest hv JOIN mushroom.batch b3 ON b3.batch_id=hv.batch_id WHERE b3.spawn_lot_id=s.spawn_lot_id)::numeric AS harvest_kg
       FROM mushroom.spawn_lot s JOIN mushroom.partner p ON p.partner_id=s.partner_id
       JOIN identity.organization o ON o.org_id=s.coop_org_id
       LEFT JOIN mushroom.batch b ON b.spawn_lot_id=s.spawn_lot_id
      WHERE p.linked_org_id=$1 GROUP BY s.spawn_lot_id, o.org_name ORDER BY s.received_at DESC LIMIT 100`,
    [org],
  );
  return r.rows.map((x) => ({ ...x, kg_per_box: x.boxes ? round2(Number(x.harvest_kg) / x.boxes) : null }));
})));

// ---- ผู้ซื้อ: คาดการณ์ สต็อก และคำสั่งซื้อ ----
router.get('/forecast', h(async (req) => db(req, async (c, org) => {
  const p = await myPartner(c, org, req.query.partner_id, 'buyer');
  const f = await coopRouter.forecast(c, p.coop_org_id);
  return { coop_name: p.coop_name, ...f };
})));

router.get('/sales-orders', h(async (req) => db(req, async (c, org) => {
  const r = await c.query(
    `SELECT so.order_id, so.order_kind, so.status, so.product_type, so.grade, so.qty_kg, so.price_per_kg, so.amount,
            so.deliver_on, so.contract_end, so.invoice_no, so.note, so.created_by, so.created_at, so.confirmed_at,
            so.delivered_at, so.paid_at, o.org_name AS coop_name
       FROM mushroom.sales_order so JOIN mushroom.partner p ON p.partner_id=so.partner_id
       JOIN identity.organization o ON o.org_id=so.coop_org_id
      WHERE p.linked_org_id=$1 ORDER BY so.created_at DESC LIMIT 200`,
    [org],
  );
  return r.rows;
})));

/** ผู้ซื้อส่งคำขอซื้อ (สถานะ Requested รอสหกรณ์ยืนยันราคา/จำนวน) */
router.post('/sales-orders', h(async (req) => db(req, async (c, org) => {
  const b = req.body || {};
  const p = await myPartner(c, org, b.partner_id, 'buyer');
  if (!PRODUCT_TYPES.includes(b.product_type)) throw bad('invalid_product_type');
  if (b.grade && !GRADES.includes(b.grade)) throw bad('invalid_grade');
  if (b.order_kind && !['spot', 'contract'].includes(b.order_kind)) throw bad('invalid_order_kind');
  if (b.deliver_on && !isDate(b.deliver_on)) throw bad('invalid_deliver_on');
  if (b.contract_end && !isDate(b.contract_end)) throw bad('invalid_contract_end');
  const qty = needPos(b.qty_kg, 'qty_kg');
  const price = needNonNeg(b.price_per_kg, 'price_per_kg');
  return (await c.query(
    `INSERT INTO mushroom.sales_order (coop_org_id, partner_id, order_kind, product_type, grade, qty_kg, price_per_kg, amount, deliver_on, contract_end, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'buyer') RETURNING order_id, status, amount`,
    [p.coop_org_id, p.partner_id, b.order_kind || 'spot', b.product_type, b.grade || null, qty, price, round2(qty * price),
      b.deliver_on || null, b.contract_end || null, b.note || null],
  )).rows[0];
})));

router.post('/sales-orders/:id/cancel', h(async (req) => db(req, async (c, org) => {
  if (!isUuid(req.params.id)) throw notFound('order_not_found');
  const r = await c.query(
    `UPDATE mushroom.sales_order so SET status='Cancelled' FROM mushroom.partner p
      WHERE so.order_id=$1 AND p.partner_id=so.partner_id AND p.linked_org_id=$2 AND so.status='Requested'
      RETURNING so.order_id, so.status`,
    [req.params.id, org],
  );
  if (!r.rows.length) throw conflict('order_not_cancellable');
  return r.rows[0];
})));

// ---- ผู้ขนส่ง: เที่ยวรถที่ได้รับมอบหมาย ----
router.get('/trips', h(async (req) => db(req, async (c, org) => {
  const r = await c.query(
    `SELECT t.trip_id, t.trip_date, t.vehicle, t.driver_name, t.status, t.distance_km, t.cost, o.org_name AS coop_name,
            COALESCE((SELECT json_agg(json_build_object('seq', s.seq, 'member', m.full_name, 'phone', m.phone, 'address', m.address,
                      'drop_boxes', s.drop_boxes, 'collect_mushroom', s.collect_mushroom, 'collect_straw', s.collect_straw, 'status', s.status)
                      ORDER BY s.seq)
                        FROM mushroom.trip_stop s JOIN mushroom.member m ON m.member_id=s.member_id WHERE s.trip_id=t.trip_id), '[]') AS stops
       FROM mushroom.trip t JOIN mushroom.partner p ON p.partner_id=t.partner_id
       JOIN identity.organization o ON o.org_id=t.coop_org_id
      WHERE p.linked_org_id=$1 AND t.trip_date >= CURRENT_DATE - 14 ORDER BY t.trip_date DESC LIMIT 100`,
    [org],
  );
  await logAccess(c, 'read', 'mushroom.trip', org);
  return r.rows;
})));

module.exports = router;
