const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');

const router = express.Router();

/**
 * Group Buy (รวมออเดอร์ประมูลร่วมของสหกรณ์) — mounted at the SAME
 * '/procurement' prefix as src/routes/procurement.js (Express allows more
 * than one router on one prefix, same idiom as src/routes/fertilizer.js
 * sharing '/farmer' with src/routes/farmer.js) rather than growing
 * procurement.js further.
 *
 * This is deliberately a thin "collection layer" in front of the existing
 * RFQ/e-Auction pipeline in procurement.js — nothing here creates a
 * contract, PO, GRN, or invoice directly. Once a round is converted (see
 * POST /admin/group-buys/:id/convert in admin.js, platform-ops only per
 * the user's explicit decision that AgroLink staff pick the lead
 * cooperative per round), the resulting RFQ/Auction/Contract/PO/GRN/
 * Invoice/Payment all flow through procurement.js completely unmodified.
 * See GROUP_BUY_ARCHITECTURE.md for the full design and the open
 * questions that are still "manual today" (no deposit/penalty for a
 * participant who backs out, no multi-drop-point delivery).
 */
router.use(requireAuth, requireOrganization);

const GROUP_BUY_CATEGORIES = ['input_product', 'produce', 'processed_good', 'machinery_service', 'other'];

/**
 * Same two-layer KYB/role gate (entity kyb_status, then role-level status)
 * as requireCooperativeOrg in coopcollection.js — copy-pasted rather than
 * imported, matching this codebase's established "no generic
 * requireOrgType() helper" convention (see villagefund.js's doc comment).
 * Group Buy is scoped to Cooperative organizations only in this pass —
 * the feature exists specifically for cooperatives to pool input-product
 * purchases (see coop-portal.html's "ประมูลซื้อแม่ปุ๋ย" section).
 */
async function requireCooperativeOrg(req, res, next) {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const org = await client.query(
        'SELECT org_id, org_name, org_type, kyb_status FROM identity.organization WHERE org_id = $1',
        [subjectId],
      );
      if (org.rows.length === 0) return { orgMissing: true };
      const orgRow = org.rows[0];
      if (orgRow.kyb_status !== 'Verified') return { kybNotVerified: true, org: orgRow };

      const role = await client.query(
        `SELECT status FROM identity.organization_role WHERE org_id = $1 AND role_type = 'Cooperative'`,
        [subjectId],
      );
      return { org: orgRow, roleStatus: role.rows[0] ? role.rows[0].status : null };
    });

    if (result.orgMissing) {
      return res.status(403).json({ error: 'cooperative_subject_required' });
    }
    if (result.kybNotVerified) {
      return res.status(403).json({ error: 'kyb_not_verified', kyb_status: result.org.kyb_status, org_name: result.org.org_name });
    }
    if (result.roleStatus !== 'Verified') {
      return res.status(403).json({
        error: 'role_not_verified', role_type: 'Cooperative', role_status: result.roleStatus, org_name: result.org.org_name,
      });
    }
    req.org = result.org;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(requireCooperativeOrg);

/**
 * POST /procurement/group-buys — open a new round. Any KYB-Verified
 * cooperative can open one freely (no platform-ops pre-approval in this
 * pass — see GROUP_BUY_ARCHITECTURE.md §7 MVP scope table).
 */
router.post('/group-buys', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    category, product_description: productDescription, target_unit: targetUnit,
    min_total_qty: minTotalQty, closes_at: closesAt,
  } = req.body || {};

  if (!category || !GROUP_BUY_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'invalid_category', valid: GROUP_BUY_CATEGORIES });
  }
  if (!productDescription || !productDescription.trim()) {
    return res.status(400).json({ error: 'product_description_required' });
  }
  const closesAtDate = closesAt ? new Date(closesAt) : null;
  if (!closesAtDate || Number.isNaN(closesAtDate.getTime()) || closesAtDate.getTime() <= Date.now()) {
    return res.status(400).json({ error: 'invalid_closes_at', detail: 'must be a valid future timestamp' });
  }
  if (minTotalQty !== undefined && minTotalQty !== null && (!Number.isFinite(Number(minTotalQty)) || Number(minTotalQty) <= 0)) {
    return res.status(400).json({ error: 'invalid_min_total_qty' });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO procurement.group_buy
           (initiator_org_id, category, product_description, target_unit, min_total_qty, closes_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING group_buy_id, initiator_org_id, category, product_description, target_unit,
                   min_total_qty, opens_at, closes_at, status, created_at`,
        [subjectId, category, productDescription.trim(), targetUnit || null, minTotalQty || null, closesAtDate.toISOString()],
      );
      await logAccess(client, 'write', 'procurement.group_buy', rows[0].group_buy_id);
      return { groupBuy: rows[0] };
    });
    return res.status(201).json(result.groupBuy);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /procurement/group-buys?status= — browse rounds, defaults to every
 * status (a closed/converted round is still useful to see — it shows
 * where the collective buying power went). Includes a live aggregate of
 * joined quantity so the frontend can render a progress bar without a
 * second round trip per row.
 */
router.get('/group-buys', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;
  if (status && !['collecting', 'converted', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'invalid_status', valid: ['collecting', 'converted', 'cancelled'] });
  }

  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const { rows: gbRows } = await client.query(
        `SELECT gb.group_buy_id, gb.category, gb.product_description, gb.target_unit, gb.min_total_qty,
                gb.opens_at, gb.closes_at, gb.status, gb.lead_org_id, gb.converted_rfq_id, gb.created_at,
                io.org_name AS initiator_org_name,
                lo.org_name AS lead_org_name,
                COALESCE(SUM(p.requested_qty) FILTER (WHERE p.status = 'joined'), 0) AS total_requested_qty,
                COUNT(*) FILTER (WHERE p.status = 'joined')::int AS participant_count
           FROM procurement.group_buy gb
           JOIN identity.organization io ON io.org_id = gb.initiator_org_id
           LEFT JOIN identity.organization lo ON lo.org_id = gb.lead_org_id
           LEFT JOIN procurement.group_buy_participant p ON p.group_buy_id = gb.group_buy_id
          WHERE ($1::text IS NULL OR gb.status = $1)
          GROUP BY gb.group_buy_id, io.org_name, lo.org_name
          ORDER BY gb.created_at DESC`,
        [status || null],
      );
      return gbRows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /procurement/group-buys/mine — rounds this cooperative either opened
 * itself OR has joined (in any status, including 'withdrawn' — a
 * cooperative that pulled out should still see it disappear cleanly from
 * "open rounds" but not simply vanish from its own history). Mirrors GET
 * /procurement/rfqs/mine's "my activity across this whole feature" shape.
 */
router.get('/group-buys/mine', async (req, res, next) => {
  const { subjectId } = req.subject;

  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const { rows: gbRows } = await client.query(
        `SELECT gb.group_buy_id, gb.category, gb.product_description, gb.target_unit, gb.min_total_qty,
                gb.opens_at, gb.closes_at, gb.status, gb.lead_org_id, gb.converted_rfq_id, gb.created_at,
                io.org_name AS initiator_org_name,
                lo.org_name AS lead_org_name,
                (gb.initiator_org_id = $1) AS is_mine,
                (gb.lead_org_id = $1) AS is_lead,
                mp.requested_qty AS my_requested_qty,
                mp.status AS my_participation_status,
                COALESCE(SUM(p.requested_qty) FILTER (WHERE p.status = 'joined'), 0) AS total_requested_qty
           FROM procurement.group_buy gb
           JOIN identity.organization io ON io.org_id = gb.initiator_org_id
           LEFT JOIN identity.organization lo ON lo.org_id = gb.lead_org_id
           LEFT JOIN procurement.group_buy_participant mp ON mp.group_buy_id = gb.group_buy_id AND mp.org_id = $1
           LEFT JOIN procurement.group_buy_participant p ON p.group_buy_id = gb.group_buy_id
          WHERE gb.initiator_org_id = $1 OR mp.participant_id IS NOT NULL
          GROUP BY gb.group_buy_id, io.org_name, lo.org_name, mp.requested_qty, mp.status
          ORDER BY gb.created_at DESC`,
        [subjectId],
      );
      return gbRows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /procurement/group-buys/:id — full detail including the participant
 * roster (org names visible to every cooperative — same "everyone sees
 * who's in the pool" transparency as an RFQ's browse view) plus the
 * caller's own participation row, if any.
 */
router.get('/group-buys/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const { rows: gbRows } = await client.query(
        `SELECT gb.*, io.org_name AS initiator_org_name, lo.org_name AS lead_org_name
           FROM procurement.group_buy gb
           JOIN identity.organization io ON io.org_id = gb.initiator_org_id
           LEFT JOIN identity.organization lo ON lo.org_id = gb.lead_org_id
          WHERE gb.group_buy_id = $1`,
        [id],
      );
      if (gbRows.length === 0) return { notFound: true };

      const { rows: participants } = await client.query(
        `SELECT p.participant_id, p.org_id, o.org_name, p.requested_qty, p.status, p.joined_at, p.withdrawn_at
           FROM procurement.group_buy_participant p
           JOIN identity.organization o ON o.org_id = p.org_id
          WHERE p.group_buy_id = $1
          ORDER BY p.requested_qty DESC`,
        [id],
      );

      const totalRequestedQty = participants
        .filter((p) => p.status === 'joined')
        .reduce((sum, p) => sum + Number(p.requested_qty), 0);

      const myParticipation = participants.find((p) => p.org_id === subjectId) || null;

      return {
        groupBuy: gbRows[0], participants, totalRequestedQty, myParticipation,
        isLead: gbRows[0].lead_org_id === subjectId,
      };
    });

    if (result.notFound) return res.status(404).json({ error: 'group_buy_not_found' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /procurement/group-buys/:id/join — declare (or update, via upsert)
 * this cooperative's requested quantity. Re-joining after a withdrawal
 * flips the same row back to 'joined' rather than creating a new one, the
 * same upsert idiom procurement.rfq_quote uses.
 */
router.post('/group-buys/:id/join', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { requested_qty: requestedQty } = req.body || {};

  if (!Number.isFinite(Number(requestedQty)) || Number(requestedQty) <= 0) {
    return res.status(400).json({ error: 'invalid_requested_qty' });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const gb = await client.query(
        'SELECT status, closes_at FROM procurement.group_buy WHERE group_buy_id = $1 FOR UPDATE',
        [id],
      );
      if (gb.rows.length === 0) return { notFound: true };
      if (gb.rows[0].status !== 'collecting') return { wrongStatus: gb.rows[0].status };
      if (new Date(gb.rows[0].closes_at).getTime() <= Date.now()) return { closed: true };

      const { rows } = await client.query(
        `INSERT INTO procurement.group_buy_participant (group_buy_id, org_id, requested_qty)
         VALUES ($1, $2, $3)
         ON CONFLICT (group_buy_id, org_id) DO UPDATE SET
           requested_qty = EXCLUDED.requested_qty,
           status = 'joined',
           joined_at = now(),
           withdrawn_at = NULL,
           updated_at = now()
         RETURNING participant_id, group_buy_id, org_id, requested_qty, status, joined_at`,
        [id, subjectId, Number(requestedQty)],
      );
      await logAccess(client, 'write', 'procurement.group_buy_participant', rows[0].participant_id);
      return { participant: rows[0] };
    });

    if (result.notFound) return res.status(404).json({ error: 'group_buy_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'group_buy_not_collecting', current_status: result.wrongStatus });
    if (result.closed) return res.status(409).json({ error: 'group_buy_closes_at_passed' });
    return res.status(201).json(result.participant);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /procurement/group-buys/:id/withdraw — pull out before the round
 * closes. Same "manual today" honesty note as GROUP_BUY_ARCHITECTURE.md
 * §6.5: there is no deposit or credit-score penalty for withdrawing, or
 * for a cooperative that stays 'joined' but never pays its settlement
 * share later — that is an agreed-outside-the-system risk for this pass.
 */
router.post('/group-buys/:id/withdraw', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const gb = await client.query(
        'SELECT status FROM procurement.group_buy WHERE group_buy_id = $1 FOR UPDATE',
        [id],
      );
      if (gb.rows.length === 0) return { notFound: true };
      if (gb.rows[0].status !== 'collecting') return { wrongStatus: gb.rows[0].status };

      const { rows } = await client.query(
        `UPDATE procurement.group_buy_participant
            SET status = 'withdrawn', withdrawn_at = now(), updated_at = now()
          WHERE group_buy_id = $1 AND org_id = $2 AND status = 'joined'
          RETURNING participant_id`,
        [id, subjectId],
      );
      if (rows.length === 0) return { notJoined: true };
      await logAccess(client, 'write', 'procurement.group_buy_participant', rows[0].participant_id);
      return { ok: true };
    });

    if (result.notFound) return res.status(404).json({ error: 'group_buy_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'group_buy_not_collecting', current_status: result.wrongStatus });
    if (result.notJoined) return res.status(409).json({ error: 'not_a_joined_participant' });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /procurement/group-buys/:id/settlement — the lead org sees the full
 * plan + every line (it needs to chase whoever hasn't paid yet); any
 * other participant sees only their own line.
 */
router.get('/group-buys/:id/settlement', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const plan = await client.query(
        'SELECT * FROM procurement.group_buy_settlement_plan WHERE group_buy_id = $1',
        [id],
      );
      if (plan.rows.length === 0) return { notFound: true };

      const isLead = plan.rows[0].lead_org_id === subjectId;
      const { rows: lines } = await client.query(
        `SELECT gbsl.line_id, gbsl.participant_org_id, o.org_name, gbsl.requested_qty,
                gbsl.share_percent, gbsl.amount, gbsl.status, gbsl.failure_reason
           FROM procurement.group_buy_settlement_line gbsl
           JOIN identity.organization o ON o.org_id = gbsl.participant_org_id
          WHERE gbsl.plan_id = $1 ${isLead ? '' : 'AND gbsl.participant_org_id = $2'}
          ORDER BY gbsl.amount DESC`,
        isLead ? [plan.rows[0].plan_id] : [plan.rows[0].plan_id, subjectId],
      );
      return { plan: plan.rows[0], lines, isLead };
    });

    if (result.notFound) return res.status(404).json({ error: 'settlement_not_found' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /procurement/group-buys/:id/settle — the lead org only, once its
 * invoice for the converted RFQ is paid. Creates the settlement plan and
 * immediately distributes it (two DB functions in sequence, same
 * create-then-distribute two-step procurement.revenue_share_plan already
 * uses elsewhere in this codebase, just called back-to-back here since
 * there is no reason for the lead org to review the split before money
 * moves — the split is a pure arithmetic function of quantities already
 * declared before the round closed).
 */
router.post('/group-buys/:id/settle', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const gb = await client.query(
        'SELECT status, lead_org_id FROM procurement.group_buy WHERE group_buy_id = $1',
        [id],
      );
      if (gb.rows.length === 0) return { notFound: true };
      if (gb.rows[0].lead_org_id !== subjectId) return { notLead: true };
      if (gb.rows[0].status !== 'converted') return { wrongStatus: gb.rows[0].status };

      const planRes = await client.query(
        'SELECT procurement.create_group_buy_settlement_plan($1) AS plan_id',
        [id],
      );
      const planId = planRes.rows[0].plan_id;

      const { rows: lines } = await client.query(
        'SELECT * FROM procurement.distribute_group_buy_settlement($1)',
        [planId],
      );
      await logAccess(client, 'write', 'procurement.group_buy_settlement_plan', planId);
      return { planId, lines };
    });

    if (result.notFound) return res.status(404).json({ error: 'group_buy_not_found' });
    if (result.notLead) return res.status(403).json({ error: 'lead_org_required' });
    if (result.wrongStatus) return res.status(409).json({ error: 'group_buy_not_converted', current_status: result.wrongStatus });
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
