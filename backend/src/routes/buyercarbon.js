const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');
const carbonAggregation = require('../lib/carbonAggregation');

const router = express.Router();

/**
 * Buyer-side Carbon Marketplace portal — Phase 3 (see backend/db/
 * grant_carbon_module_marketplace.sql). Mounted at its own '/buyer-carbon'
 * prefix, distinct from '/buyer' (buyer.js, the existing produce-buying
 * portal — an unrelated feature area; org_type='Buyer' is shared by both,
 * but the underlying business is different, hence a new route file rather
 * than extending buyer.js).
 *
 * requireBuyerOrg() below is a copy-paste of buyer.js's own function of the
 * same name (no generic requireOrgType() helper exists in this codebase —
 * see FARMER_360_ARCHITECTURE.md §6) — duplicated here on purpose, same
 * "own prefix, own copy-pasted gate" convention as coopcarbon.js /
 * communityenterprisecarbon.js / villagefundcarbon.js. All actual business
 * logic is in the shared backend/src/lib/carbonAggregation.js helper.
 *
 * A Buyer org only ever creates/lists/cancels its own orders here — it
 * never sees a seller's carbon_project directly, and matching an order to
 * a seller's listing is MANUAL, done by Platform Ops only (see admin.js's
 * /carbon/marketplace/* routes).
 */
router.use(requireAuth, requireOrganization);

async function requireBuyerOrg(req, res, next) {
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
        `SELECT status FROM identity.organization_role WHERE org_id = $1 AND role_type = 'Buyer'`,
        [subjectId],
      );
      return { org: orgRow, roleStatus: role.rows[0] ? role.rows[0].status : null };
    });

    if (result.orgMissing) {
      return res.status(403).json({ error: 'buyer_subject_required' });
    }
    if (result.kybNotVerified) {
      return res.status(403).json({
        error: 'kyb_not_verified', kyb_status: result.org.kyb_status, org_name: result.org.org_name,
      });
    }
    if (result.roleStatus !== 'Verified') {
      return res.status(403).json({
        error: 'role_not_verified', role_type: 'Buyer', role_status: result.roleStatus, org_name: result.org.org_name,
      });
    }
    req.org = result.org;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(requireBuyerOrg);

// GET /buyer-carbon/orders
router.get('/orders', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, (client) =>
      carbonAggregation.listOrdersForBuyer(client, { buyerOrgId: subjectId }));
    return res.json({ orders: rows });
  } catch (err) {
    return next(err);
  }
});

// POST /buyer-carbon/orders — body: { requested_credit_tco2e, offered_price_per_tco2e, note? }
router.post('/orders', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    requested_credit_tco2e: requestedCreditTco2e, offered_price_per_tco2e: offeredPricePerTco2e, note,
  } = req.body || {};
  try {
    const order = await withSessionContext('organization', subjectId, async (client) => {
      const created = await carbonAggregation.createOrder(client, {
        buyerOrgId: subjectId, requestedCreditTco2e, offeredPricePerTco2e, note,
      });
      await logAccess(client, 'create', 'carbon_marketplace_order', created.order_id);
      return created;
    });
    return res.status(201).json({ order });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

// POST /buyer-carbon/orders/:orderId/cancel
router.post('/orders/:orderId/cancel', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { orderId } = req.params;
  try {
    const cancelled = await withSessionContext('organization', subjectId, async (client) => {
      const ok = await carbonAggregation.cancelOrder(client, { buyerOrgId: subjectId, orderId });
      if (ok) await logAccess(client, 'update', 'carbon_marketplace_order', orderId);
      return ok;
    });
    if (!cancelled) return res.status(404).json({ error: 'order_not_found_or_not_cancellable' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
