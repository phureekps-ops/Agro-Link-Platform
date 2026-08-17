const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');

const router = express.Router();

/**
 * Farmer 360° View — MVP. See FARMER_360_ARCHITECTURE.md at the repo root
 * for the full design and the visibility-rules table (§4) this file
 * implements. Mounted generically for ANY verified organization (same
 * convention as procurement.js) — the real security boundary here is
 * "does my org have an active farmer_org_relationship row with this
 * farmer," not the org's org_type, so there is no per-portal duplicate of
 * this file.
 *
 * MVP explicitly does NOT include: credit score (risk.credit_score's RLS
 * has no policy for organization subjects, and that's a deliberate
 * product decision this pass does not route around — see architecture
 * doc §3/§5), a consent workflow, or another org's transaction amounts.
 * Every response below is scoped exactly per the visibility table.
 */
router.use(requireAuth);
router.use(requireOrganization);

async function requireVerifiedOrg(client, orgId) {
  const result = await client.query(
    'SELECT org_id, org_name, org_type, kyb_status FROM identity.organization WHERE org_id = $1',
    [orgId],
  );
  if (result.rows.length === 0) return { ok: false, reason: 'org_missing' };
  if (result.rows[0].kyb_status !== 'Verified') {
    return { ok: false, reason: 'kyb_not_verified', org: result.rows[0] };
  }
  return { ok: true, org: result.rows[0] };
}

function sendGateError(res, gate) {
  if (gate.reason === 'kyb_not_verified') {
    return res.status(403).json({ error: 'kyb_not_verified', org_name: gate.org.org_name });
  }
  return res.status(403).json({ error: 'organization_not_found' });
}

/**
 * GET /farmer360/search?code=AF-000001  or  ?phone=0812345678
 * Exact-match only, by design — there is deliberately no partial/name
 * search, so this endpoint can never be used to browse the farmer table.
 * A staff member has to already know a specific farmer's AgroLink ID
 * (e.g. printed on a membership card) or their exact phone number.
 * Returns only a minimal preview — not the full 360 view, which still
 * requires an actual relationship (see POST /relationships below).
 */
router.get('/search', async (req, res, next) => {
  try {
    const code = typeof req.query.code === 'string' ? req.query.code.trim().toUpperCase() : null;
    const phone = typeof req.query.phone === 'string' ? req.query.phone.trim() : null;
    if (!code && !phone) return res.status(400).json({ error: 'code_or_phone_required' });

    const result = await withSessionContext('organization', req.subject.subjectId, async (client) => {
      const gate = await requireVerifiedOrg(client, req.subject.subjectId);
      if (!gate.ok) return { gate };

      const farmerResult = code
        ? await client.query(
            'SELECT farmer_id, farmer_code, full_name FROM identity.farmer WHERE farmer_code = $1',
            [code],
          )
        : await client.query(
            'SELECT farmer_id, farmer_code, full_name FROM identity.farmer WHERE phone = $1',
            [phone],
          );

      return { gate, farmer: farmerResult.rows[0] || null };
    });

    if (!result.gate.ok) return sendGateError(res, result.gate);
    if (!result.farmer) return res.status(404).json({ error: 'farmer_not_found' });
    res.json(result.farmer);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /farmer360/relationships
 * Body: { farmer_id }
 * Adds a farmer (already found via GET /search) as a member/customer of
 * the calling org — relationship_type is derived server-side from the
 * org's own org_type, never taken from the client (see
 * identity.link_farmer_to_org() in grant_farmer_360.sql).
 */
router.post('/relationships', async (req, res, next) => {
  try {
    const farmerId = req.body && req.body.farmer_id;
    if (!farmerId) return res.status(400).json({ error: 'farmer_id_required' });

    const result = await withSessionContext('organization', req.subject.subjectId, async (client) => {
      const gate = await requireVerifiedOrg(client, req.subject.subjectId);
      if (!gate.ok) return { gate };

      const farmerCheck = await client.query(
        'SELECT farmer_id FROM identity.farmer WHERE farmer_id = $1',
        [farmerId],
      );
      if (farmerCheck.rows.length === 0) return { gate, farmerMissing: true };

      const linked = await client.query(
        'SELECT * FROM identity.link_farmer_to_org($1, $2, $3, $4, $5)',
        [farmerId, req.subject.subjectId, 'organization', req.subject.subjectId, null],
      );
      await logAccess(client, 'write', 'identity.farmer_org_relationship', linked.rows[0].relationship_id);
      return { gate, relationship: linked.rows[0] };
    });

    if (!result.gate.ok) return sendGateError(res, result.gate);
    if (result.farmerMissing) return res.status(404).json({ error: 'farmer_not_found' });
    res.status(201).json(result.relationship);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /farmer360/relationships/sync
 * Bulk-creates relationships for every farmer who already has a real
 * transaction with the calling org (delivery/loan/order/booking) but no
 * roster row yet — see identity.sync_farmer_relationships_from_transactions()
 * in grant_farmer_360.sql. Solves the "no real member import exists"
 * gap this codebase's own cooperative_profile comment already admitted.
 */
router.post('/relationships/sync', async (req, res, next) => {
  try {
    const result = await withSessionContext('organization', req.subject.subjectId, async (client) => {
      const gate = await requireVerifiedOrg(client, req.subject.subjectId);
      if (!gate.ok) return { gate };

      const synced = await client.query(
        'SELECT * FROM identity.sync_farmer_relationships_from_transactions($1, $2, $3)',
        [req.subject.subjectId, 'organization', req.subject.subjectId],
      );
      if (synced.rows.length > 0) {
        await logAccess(client, 'write', 'identity.farmer_org_relationship', req.subject.subjectId);
      }
      return { gate, count: synced.rows.length };
    });

    if (!result.gate.ok) return sendGateError(res, result.gate);
    res.json({ linked_count: result.count });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /farmer360/relationships/mine
 * The calling org's own roster — every farmer currently linked to it.
 */
router.get('/relationships/mine', async (req, res, next) => {
  try {
    const result = await withSessionContext('organization', req.subject.subjectId, async (client) => {
      const gate = await requireVerifiedOrg(client, req.subject.subjectId);
      if (!gate.ok) return { gate };

      const rows = await client.query(
        `SELECT r.relationship_id, r.farmer_id, f.farmer_code, f.full_name, f.phone,
                r.relationship_type, r.status, r.joined_at
           FROM identity.farmer_org_relationship r
           JOIN identity.farmer f ON f.farmer_id = r.farmer_id
          WHERE r.org_id = $1 AND r.status = 'active'
          ORDER BY r.joined_at DESC`,
        [req.subject.subjectId],
      );
      return { gate, rows: rows.rows };
    });

    if (!result.gate.ok) return sendGateError(res, result.gate);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /farmer360/relationships/:farmerId
 * Ends the relationship (status='ended', row kept for history — see
 * identity.unlink_farmer_from_org()).
 */
router.delete('/relationships/:farmerId', async (req, res, next) => {
  try {
    const { farmerId } = req.params;
    const result = await withSessionContext('organization', req.subject.subjectId, async (client) => {
      const gate = await requireVerifiedOrg(client, req.subject.subjectId);
      if (!gate.ok) return { gate };

      const unlinked = await client.query(
        'SELECT identity.unlink_farmer_from_org($1, $2) AS ok',
        [farmerId, req.subject.subjectId],
      );
      if (unlinked.rows[0].ok) {
        await logAccess(client, 'write', 'identity.farmer_org_relationship', farmerId);
      }
      return { gate, ok: unlinked.rows[0].ok };
    });

    if (!result.gate.ok) return sendGateError(res, result.gate);
    if (!result.ok) return res.status(404).json({ error: 'relationship_not_found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /farmer360/:farmerId
 * The 360 view itself. Requires an ACTIVE relationship between the
 * calling org and this farmer, otherwise 403 `no_relationship_with_farmer`
 * — deliberately 403 rather than 404 (farmer_id is a UUID, not a
 * guessable sequential id, so there's little to protect by hiding
 * existence; 403 is the more honest signal that this is a permission
 * wall, not a lookup miss, matching the "own vs not found" spirit used
 * elsewhere in this codebase without contradicting it).
 *
 * Visibility per FARMER_360_ARCHITECTURE.md §4:
 *   - basic identity + land: shown in full to any org with a relationship
 *   - other orgs' membership: shown as name+type only, no transaction detail
 *   - transactions: ONLY the ones between this farmer and the CALLING org
 *   - credit score: NOT included this pass (see file header)
 */
router.get('/:farmerId', async (req, res, next) => {
  try {
    const { farmerId } = req.params;
    const result = await withSessionContext('organization', req.subject.subjectId, async (client) => {
      const gate = await requireVerifiedOrg(client, req.subject.subjectId);
      if (!gate.ok) return { gate };

      const relationship = await client.query(
        `SELECT relationship_type, joined_at FROM identity.farmer_org_relationship
          WHERE farmer_id = $1 AND org_id = $2 AND status = 'active'`,
        [farmerId, req.subject.subjectId],
      );
      if (relationship.rows.length === 0) return { gate, noRelationship: true };

      const farmerResult = await client.query(
        'SELECT farmer_id, farmer_code, full_name, phone, region_code, status FROM identity.farmer WHERE farmer_id = $1',
        [farmerId],
      );
      if (farmerResult.rows.length === 0) return { gate, noRelationship: true };

      const landResult = await client.query(
        `SELECT pu.unit_id, pu.unit_type, pu.area_rai, pu.commodity_code,
                COALESCE(c.name_th, pu.commodity_code) AS commodity_name, pu.status
           FROM registry.production_unit pu
           LEFT JOIN registry.commodity_ref c ON c.commodity_code = pu.commodity_code
          WHERE pu.owner_farmer_id = $1
          ORDER BY pu.registration_date`,
        [farmerId],
      );

      const membershipResult = await client.query(
        `SELECT o.org_id, o.org_name, o.org_type, r.relationship_type, r.joined_at
           FROM identity.farmer_org_relationship r
           JOIN identity.organization o ON o.org_id = r.org_id
          WHERE r.farmer_id = $1 AND r.status = 'active'
          ORDER BY r.joined_at`,
        [farmerId],
      );

      const [produceResult, loanResult, orderResult, machineryResult] = await Promise.all([
        client.query(
          `SELECT COUNT(*) AS count, COALESCE(SUM(d.total_amount), 0) AS total_amount
             FROM produce.delivery d
             JOIN registry.production_unit pu ON pu.unit_id = d.unit_id
            WHERE pu.owner_farmer_id = $1 AND d.buyer_org_id = $2 AND d.status = 'settled'`,
          [farmerId, req.subject.subjectId],
        ),
        client.query(
          `SELECT COUNT(*) AS count, COALESCE(SUM(requested_amount), 0) AS total_amount
             FROM underwriting.loan_application WHERE farmer_id = $1 AND lender_org_id = $2`,
          [farmerId, req.subject.subjectId],
        ),
        client.query(
          `SELECT COUNT(*) AS count, COALESCE(SUM(total_price), 0) AS total_amount
             FROM marketplace.product_order WHERE farmer_id = $1 AND org_id = $2`,
          [farmerId, req.subject.subjectId],
        ),
        // machinery_booking has no total-amount column (unit_price is a
        // per-unit rate against a free-text quantity_note, not a
        // computable total) — count only, so this never reports a
        // misleading "total spent" figure.
        client.query(
          `SELECT COUNT(*) AS count
             FROM marketplace.machinery_booking WHERE farmer_id = $1 AND org_id = $2`,
          [farmerId, req.subject.subjectId],
        ),
      ]);

      await logAccess(client, 'read', 'identity.farmer', farmerId);

      return {
        gate,
        view: {
          farmer: farmerResult.rows[0],
          my_relationship: relationship.rows[0],
          land: landResult.rows,
          memberships: membershipResult.rows,
          transactions: {
            produce_sales: produceResult.rows[0],
            loans: loanResult.rows[0],
            input_purchases: orderResult.rows[0],
            machinery_rental: machineryResult.rows[0],
          },
          credit_score: null,
          credit_score_available_in_next_phase: true,
          consent_available_in_next_phase: true,
        },
      };
    });

    if (!result.gate.ok) return sendGateError(res, result.gate);
    if (result.noRelationship) return res.status(403).json({ error: 'no_relationship_with_farmer' });
    res.json(result.view);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
