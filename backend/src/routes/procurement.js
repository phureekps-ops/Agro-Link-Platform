const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * RFP/RFQ marketplace — "post what you need, receive competing quotes."
 * See grant_rfq_marketplace.sql for the full design rationale. Unlike
 * every other route file in this project, this one is deliberately
 * mounted for BOTH farmer and organization subjects — `router.use
 * (requireAuth)` only, no requireFarmer/requireOrganization gate — because
 * a requester can legitimately be either. Each handler below branches on
 * `req.subject.subjectType` itself and 403s subject types that make no
 * sense for that action ('platform', 'government_officer',
 * 'organization_member' can never post/quote/browse here).
 *
 * IMPORTANT: procurement.rfq / procurement.rfq_quote have NO row-level
 * security (same situation as every marketplace.* table — see the note
 * at the top of src/routes/machinery.js). Every query below MUST filter
 * explicitly by requester_subject_id / responder_org_id as appropriate —
 * this is the entire security boundary, not defense-in-depth.
 */
router.use(requireAuth);

const RFQ_CATEGORIES = ['input_product', 'produce', 'processed_good', 'machinery_service', 'other'];

// A requester can be a farmer or an organization; a quote responder is
// always an organization (see grant_rfq_marketplace.sql's design note).
function isRequesterEligible(subjectType) {
  return subjectType === 'farmer' || subjectType === 'organization';
}

/**
 * Resolves a display name for a polymorphic requester (farmer or
 * organization) — used only for the caller's OWN "is this my RFQ"
 * ownership checks below, never trusted from the client.
 */
async function requireVerifiedOrgIfOrganization(client, subject) {
  if (subject.subjectType !== 'organization') return { ok: true };
  const org = await client.query(
    'SELECT org_id, org_name, kyb_status FROM identity.organization WHERE org_id = $1',
    [subject.subjectId],
  );
  if (org.rows.length === 0) return { ok: false, reason: 'org_missing' };
  if (org.rows[0].kyb_status !== 'Verified') return { ok: false, reason: 'kyb_not_verified', org: org.rows[0] };
  return { ok: true, org: org.rows[0] };
}

// Shared SELECT list + the CASE/JOIN that resolves a polymorphic
// requester's display name — reused by every route that lists/reads RFQs,
// so the same join shape doesn't drift between them.
const RFQ_SELECT_WITH_REQUESTER_NAME = `
  SELECT r.rfq_id, r.requester_subject_type, r.requester_subject_id,
         COALESCE(f.full_name, o.org_name) AS requester_name,
         r.title, r.category, r.description, r.quantity, r.quantity_unit,
         r.target_price, r.delivery_location, r.needed_by_date, r.quotes_deadline,
         r.status, r.awarded_quote_id, r.created_at, r.updated_at
    FROM procurement.rfq r
    LEFT JOIN identity.farmer f ON r.requester_subject_type = 'farmer' AND f.farmer_id = r.requester_subject_id
    LEFT JOIN identity.organization o ON r.requester_subject_type = 'organization' AND o.org_id = r.requester_subject_id
`;

/**
 * POST /procurement/rfqs
 * Body: { title, category, description?, quantity?, quantity_unit?,
 *         target_price?, delivery_location?, needed_by_date?, quotes_deadline? }
 * requester_subject_type/subject_id always come from the JWT, never the
 * body — same convention as every other subject-scoped write in this
 * project. Organizations must hold a Verified kyb_status (same bar as
 * every other org-authenticated write); farmers have no equivalent gate
 * here, matching every other farmer-authenticated write in farmer.js
 * (none of which check identity.farmer.status either).
 */
router.post('/rfqs', async (req, res, next) => {
  const subject = req.subject;
  if (!isRequesterEligible(subject.subjectType)) {
    return res.status(403).json({ error: 'farmer_or_organization_subject_required' });
  }

  const {
    title, category, description, quantity, quantity_unit: quantityUnit,
    target_price: targetPrice, delivery_location: deliveryLocation,
    needed_by_date: neededByDate, quotes_deadline: quotesDeadline,
  } = req.body || {};

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'title_required' });
  }
  if (!category || !RFQ_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'invalid_category', valid: RFQ_CATEGORIES });
  }
  if (quantity !== undefined && quantity !== null && (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0)) {
    return res.status(400).json({ error: 'invalid_quantity' });
  }
  if (targetPrice !== undefined && targetPrice !== null && (!Number.isFinite(Number(targetPrice)) || Number(targetPrice) <= 0)) {
    return res.status(400).json({ error: 'invalid_target_price' });
  }

  try {
    const result = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const gate = await requireVerifiedOrgIfOrganization(client, subject);
      if (!gate.ok) return { gate };

      const { rows } = await client.query(
        `INSERT INTO procurement.rfq
           (requester_subject_type, requester_subject_id, title, category, description,
            quantity, quantity_unit, target_price, delivery_location, needed_by_date, quotes_deadline)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING rfq_id, requester_subject_type, requester_subject_id, title, category, description,
                   quantity, quantity_unit, target_price, delivery_location, needed_by_date,
                   quotes_deadline, status, created_at, updated_at`,
        [
          subject.subjectType, subject.subjectId, title.trim(), category, description || null,
          quantity || null, quantityUnit || null, targetPrice || null,
          deliveryLocation || null, neededByDate || null, quotesDeadline || null,
        ],
      );
      await logAccess(client, 'write', 'procurement.rfq', rows[0].rfq_id);
      return { rfq: rows[0] };
    });

    if (result.gate && !result.gate.ok) {
      if (result.gate.reason === 'kyb_not_verified') {
        return res.status(403).json({ error: 'kyb_not_verified', org_name: result.gate.org.org_name });
      }
      return res.status(403).json({ error: 'organization_subject_required' });
    }
    return res.status(201).json(result.rfq);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /procurement/rfqs?category=&status=
 * Browse RFQs open to the whole system — the "find something to quote on"
 * view. Defaults to status=open (the only status a responder can usefully
 * act on); pass an explicit status to see others. Open to any farmer or
 * organization subject.
 */
router.get('/rfqs', async (req, res, next) => {
  const subject = req.subject;
  if (!isRequesterEligible(subject.subjectType)) {
    return res.status(403).json({ error: 'farmer_or_organization_subject_required' });
  }
  const { category, status } = req.query;
  if (category && !RFQ_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'invalid_category', valid: RFQ_CATEGORIES });
  }

  try {
    const rows = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const params = [];
      const filters = [];
      const effectiveStatus = status || 'open';
      params.push(effectiveStatus);
      filters.push(`r.status = $${params.length}`);
      if (category) { params.push(category); filters.push(`r.category = $${params.length}`); }

      const result = await client.query(
        `${RFQ_SELECT_WITH_REQUESTER_NAME}
          WHERE ${filters.join(' AND ')}
          ORDER BY r.created_at DESC`,
        params,
      );
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /procurement/rfqs/mine — this subject's own posted RFQs, every
 * status included (a requester needs to see their awarded/cancelled ones
 * too, not just open).
 */
router.get('/rfqs/mine', async (req, res, next) => {
  const subject = req.subject;
  if (!isRequesterEligible(subject.subjectType)) {
    return res.status(403).json({ error: 'farmer_or_organization_subject_required' });
  }

  try {
    const rows = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const result = await client.query(
        `${RFQ_SELECT_WITH_REQUESTER_NAME}
          WHERE r.requester_subject_type = $1 AND r.requester_subject_id = $2
          ORDER BY r.created_at DESC`,
        [subject.subjectType, subject.subjectId],
      );
      await logAccess(client, 'read', 'procurement.rfq', subject.subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /procurement/rfqs/:id — single RFQ detail, plus a `quote_count` and
 * (if the caller is an organization) `my_quote` — their own quote on this
 * RFQ if they've submitted one, so the frontend doesn't need a second
 * round trip to know whether to show "submit a quote" or "edit my quote."
 * The full quote LIST (every responder's quote) is requester-only — see
 * GET /procurement/rfqs/:id/quotes below.
 */
router.get('/rfqs/:id', async (req, res, next) => {
  const subject = req.subject;
  if (!isRequesterEligible(subject.subjectType)) {
    return res.status(403).json({ error: 'farmer_or_organization_subject_required' });
  }
  const { id } = req.params;

  try {
    const result = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const rfqRes = await client.query(`${RFQ_SELECT_WITH_REQUESTER_NAME} WHERE r.rfq_id = $1`, [id]);
      if (rfqRes.rows.length === 0) return { notFound: true };
      const rfq = rfqRes.rows[0];

      const countRes = await client.query(
        `SELECT count(*) FILTER (WHERE status <> 'withdrawn') AS quote_count
           FROM procurement.rfq_quote WHERE rfq_id = $1`,
        [id],
      );
      rfq.quote_count = Number(countRes.rows[0].quote_count);

      if (subject.subjectType === 'organization') {
        const myQuote = await client.query(
          `SELECT quote_id, quoted_price, price_unit, quoted_quantity, message, status, submitted_at, decided_at
             FROM procurement.rfq_quote WHERE rfq_id = $1 AND responder_org_id = $2`,
          [id, subject.subjectId],
        );
        rfq.my_quote = myQuote.rows[0] || null;
      }

      return { rfq };
    });

    if (result.notFound) return res.status(404).json({ error: 'rfq_not_found' });
    return res.json(result.rfq);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /procurement/rfqs/:id/cancel — requester-only, only while still
 * `open` (an awarded/already-cancelled/closed RFQ can't be cancelled
 * again). Ownership-gated the same way as every other subject-scoped
 * write in this project: re-read WHERE requester_subject_type = $1 AND
 * requester_subject_id = $2 first.
 */
router.post('/rfqs/:id/cancel', async (req, res, next) => {
  const subject = req.subject;
  if (!isRequesterEligible(subject.subjectType)) {
    return res.status(403).json({ error: 'farmer_or_organization_subject_required' });
  }
  const { id } = req.params;

  try {
    const result = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const existing = await client.query(
        `SELECT status FROM procurement.rfq
          WHERE rfq_id = $1 AND requester_subject_type = $2 AND requester_subject_id = $3`,
        [id, subject.subjectType, subject.subjectId],
      );
      if (existing.rows.length === 0) return { notFound: true };
      if (existing.rows[0].status !== 'open') return { wrongStatus: existing.rows[0].status };

      const { rows } = await client.query(
        `UPDATE procurement.rfq SET status = 'cancelled', updated_at = now()
          WHERE rfq_id = $1
          RETURNING rfq_id, status`,
        [id],
      );
      await logAccess(client, 'write', 'procurement.rfq', id);
      return { rfq: rows[0] };
    });

    if (result.notFound) return res.status(404).json({ error: 'rfq_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'rfq_not_open', current_status: result.wrongStatus });
    return res.json(result.rfq);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /procurement/rfqs/:id/quotes — requester-only, the full quote list
 * for this RFQ (every responder, not just the caller's own), joined with
 * the responder org's name.
 */
router.get('/rfqs/:id/quotes', async (req, res, next) => {
  const subject = req.subject;
  if (!isRequesterEligible(subject.subjectType)) {
    return res.status(403).json({ error: 'farmer_or_organization_subject_required' });
  }
  const { id } = req.params;

  try {
    const result = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const owned = await client.query(
        `SELECT rfq_id FROM procurement.rfq
          WHERE rfq_id = $1 AND requester_subject_type = $2 AND requester_subject_id = $3`,
        [id, subject.subjectType, subject.subjectId],
      );
      if (owned.rows.length === 0) return { notFound: true };

      const quotes = await client.query(
        `SELECT q.quote_id, q.rfq_id, q.responder_org_id, o.org_name AS responder_org_name,
                q.quoted_price, q.price_unit, q.quoted_quantity, q.message, q.status,
                q.submitted_at, q.decided_at
           FROM procurement.rfq_quote q
           JOIN identity.organization o ON o.org_id = q.responder_org_id
          WHERE q.rfq_id = $1
          ORDER BY q.quoted_price ASC, q.submitted_at ASC`,
        [id],
      );
      return { quotes: quotes.rows };
    });

    if (result.notFound) return res.status(404).json({ error: 'rfq_not_found' });
    return res.json(result.quotes);
  } catch (err) {
    return next(err);
  }
});

/**
 * Shared "award" tail — used by BOTH POST /rfqs/:id/quotes/:quoteId/accept
 * (direct RFQ path) AND the auction-close path below, so the two entry
 * points into "this RFQ now has a winner" can never drift out of sync.
 * Upserts a procurement.rfq_quote row representing the winner (status
 * 'accepted') even when the win came from an auction bid rather than a
 * normal quote submission — this keeps `rfq.awarded_quote_id`'s existing
 * FK (which only points at rfq_quote, not auction_bid) meaningful for
 * BOTH award paths, so every downstream reader (GET /rfqs/:id, the
 * frontend's "my_quote" lookup, quote history) sees one consistent shape
 * regardless of which mechanism produced the win. Rejects every other
 * still-`submitted` quote on the RFQ, calls
 * procurement.create_contract_from_award(), and flips the RFQ to
 * `awarded`. Caller must already hold the RFQ row FOR UPDATE-equivalent
 * certainty (both call sites re-check status immediately before calling
 * this, inside the same withSessionContext transaction).
 */
async function awardRfqToResponder(client, {
  rfqId, category, requesterSubjectType, requesterSubjectId,
  responderOrgId, price, priceUnit, quantity, quantityUnit, message,
}) {
  const quoteRes = await client.query(
    `INSERT INTO procurement.rfq_quote
       (rfq_id, responder_org_id, quoted_price, price_unit, quoted_quantity, message, status, decided_at)
     VALUES ($1, $2, $3, COALESCE($4, 'บาท/หน่วย'), $5, $6, 'accepted', now())
     ON CONFLICT (rfq_id, responder_org_id) DO UPDATE SET
       quoted_price = EXCLUDED.quoted_price,
       price_unit = EXCLUDED.price_unit,
       quoted_quantity = EXCLUDED.quoted_quantity,
       message = EXCLUDED.message,
       status = 'accepted',
       decided_at = now(),
       updated_at = now()
     RETURNING quote_id`,
    [rfqId, responderOrgId, price, priceUnit || null, quantity || null, message || null],
  );
  const quoteId = quoteRes.rows[0].quote_id;

  await client.query(
    `UPDATE procurement.rfq_quote SET status = 'rejected', decided_at = now(), updated_at = now()
      WHERE rfq_id = $1 AND quote_id <> $2 AND status = 'submitted'`,
    [rfqId, quoteId],
  );

  const contractRes = await client.query(
    `SELECT procurement.create_contract_from_award($1, $2, $3, $4, $5, $6, $7, $8) AS contract_id`,
    [rfqId, category, requesterSubjectType, requesterSubjectId, responderOrgId, quantity, quantityUnit, price],
  );
  const contractId = contractRes.rows[0].contract_id;

  const { rows } = await client.query(
    `UPDATE procurement.rfq SET status = 'awarded', awarded_quote_id = $2, updated_at = now()
      WHERE rfq_id = $1
      RETURNING rfq_id, status, awarded_quote_id, contract_id`,
    [rfqId, quoteId],
  );
  await logAccess(client, 'write', 'procurement.rfq', rfqId);
  await logAccess(client, 'write', 'procurement.rfq_quote', quoteId);
  await logAccess(client, 'write', 'contract.contract', contractId);

  return { quoteId, contractId, rfq: rows[0] };
}

/**
 * POST /procurement/rfqs/:id/quotes/:quoteId/accept — the award step.
 * Requester-only, RFQ must still be `open`. Sets the chosen quote to
 * `accepted`, every OTHER submitted quote on this RFQ to `rejected`, and
 * the RFQ itself to `awarded` with `awarded_quote_id` set — all inside one
 * transaction (withSessionContext already wraps each call in one).
 *
 * B2B Commerce Engine Phase 2 (grant_b2b_commerce_engine.sql): accepting a
 * quote now ALSO calls procurement.create_contract_from_award(), which
 * writes a real contract.contract + contract_party pair (reusing the
 * existing contract machinery built for loans, forward_purchase/
 * service_agreement/input_supply_agreement were already in its
 * contract_type CHECK, just never had a caller) and records the new
 * contract_id back onto this RFQ. This closes the gap the original RFQ
 * "what's mocked" note flagged — award now produces a real, traceable
 * contract, not just a status flip. Still does NOT auto-create a
 * produce.delivery / marketplace.product_order / Purchase Order — issuing
 * a PO against the new contract is a separate, deliberate next step (see
 * POST /procurement/purchase-orders below), not automatic.
 */
router.post('/rfqs/:id/quotes/:quoteId/accept', async (req, res, next) => {
  const subject = req.subject;
  if (!isRequesterEligible(subject.subjectType)) {
    return res.status(403).json({ error: 'farmer_or_organization_subject_required' });
  }
  const { id, quoteId } = req.params;

  try {
    const result = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const rfqRes = await client.query(
        `SELECT status, category, quantity, quantity_unit FROM procurement.rfq
          WHERE rfq_id = $1 AND requester_subject_type = $2 AND requester_subject_id = $3`,
        [id, subject.subjectType, subject.subjectId],
      );
      if (rfqRes.rows.length === 0) return { rfqNotFound: true };
      if (rfqRes.rows[0].status !== 'open') return { wrongStatus: rfqRes.rows[0].status };
      const rfq = rfqRes.rows[0];

      const quoteRes = await client.query(
        `SELECT quote_id, status, responder_org_id, quoted_price, price_unit, quoted_quantity, message
           FROM procurement.rfq_quote WHERE rfq_id = $1 AND quote_id = $2`,
        [id, quoteId],
      );
      if (quoteRes.rows.length === 0) return { quoteNotFound: true };
      if (quoteRes.rows[0].status !== 'submitted') return { quoteWrongStatus: quoteRes.rows[0].status };
      const quote = quoteRes.rows[0];

      const award = await awardRfqToResponder(client, {
        rfqId: id,
        category: rfq.category,
        requesterSubjectType: subject.subjectType,
        requesterSubjectId: subject.subjectId,
        responderOrgId: quote.responder_org_id,
        price: quote.quoted_price,
        priceUnit: quote.price_unit,
        quantity: quote.quoted_quantity || rfq.quantity,
        quantityUnit: rfq.quantity_unit,
        message: quote.message,
      });
      return { rfq: award.rfq };
    });

    if (result.rfqNotFound) return res.status(404).json({ error: 'rfq_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'rfq_not_open', current_status: result.wrongStatus });
    if (result.quoteNotFound) return res.status(404).json({ error: 'quote_not_found' });
    if (result.quoteWrongStatus) return res.status(409).json({ error: 'quote_not_submitted', current_status: result.quoteWrongStatus });
    return res.json(result.rfq);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /procurement/rfqs/:id/quotes
 * Body: { quoted_price, price_unit?, quoted_quantity?, message? }
 * Organization-only (see grant_rfq_marketplace.sql's design note — farmers
 * never respond to RFQs in this pass). Upserts on (rfq_id, responder_org_id)
 * — a responder editing their price re-submits to the same row rather than
 * creating a duplicate, and this is also how "withdraw then re-quote"
 * works (status flips back to 'submitted'). Blocked once the RFQ is no
 * longer `open`.
 */
router.post('/rfqs/:id/quotes', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'organization') {
    return res.status(403).json({ error: 'organization_subject_required' });
  }
  const { id } = req.params;
  const {
    quoted_price: quotedPrice, price_unit: priceUnit,
    quoted_quantity: quotedQuantity, message,
  } = req.body || {};

  const price = Number(quotedPrice);
  if (!Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ error: 'invalid_quoted_price' });
  }
  if (quotedQuantity !== undefined && quotedQuantity !== null
    && (!Number.isFinite(Number(quotedQuantity)) || Number(quotedQuantity) <= 0)) {
    return res.status(400).json({ error: 'invalid_quoted_quantity' });
  }

  try {
    const result = await withSessionContext('organization', subject.subjectId, async (client) => {
      const gate = await requireVerifiedOrgIfOrganization(client, subject);
      if (!gate.ok) return { gate };

      const rfqRes = await client.query('SELECT status FROM procurement.rfq WHERE rfq_id = $1', [id]);
      if (rfqRes.rows.length === 0) return { rfqNotFound: true };
      if (rfqRes.rows[0].status !== 'open') return { wrongStatus: rfqRes.rows[0].status };

      // An RFQ that already has an e-Auction running on it is bid on
      // THROUGH the auction (POST /procurement/auctions/:id/bids), not
      // through this direct-quote endpoint — one RFQ, one channel for
      // price competition, so a requester never has to reconcile two
      // separate ranked lists for the same need.
      const auctionRes = await client.query('SELECT auction_id FROM procurement.auction WHERE rfq_id = $1', [id]);
      if (auctionRes.rows.length > 0) return { hasAuction: true };

      const { rows } = await client.query(
        `INSERT INTO procurement.rfq_quote (rfq_id, responder_org_id, quoted_price, price_unit, quoted_quantity, message)
         VALUES ($1, $2, $3, COALESCE($4, 'บาท/หน่วย'), $5, $6)
         ON CONFLICT (rfq_id, responder_org_id) DO UPDATE SET
           quoted_price = EXCLUDED.quoted_price,
           price_unit = EXCLUDED.price_unit,
           quoted_quantity = EXCLUDED.quoted_quantity,
           message = EXCLUDED.message,
           status = 'submitted',
           submitted_at = now(),
           decided_at = NULL,
           updated_at = now()
         RETURNING quote_id, rfq_id, quoted_price, price_unit, quoted_quantity, message, status, submitted_at`,
        [id, subject.subjectId, price, priceUnit || null, quotedQuantity || null, message || null],
      );
      await logAccess(client, 'write', 'procurement.rfq_quote', rows[0].quote_id);
      return { quote: rows[0] };
    });

    if (result.gate && !result.gate.ok) {
      if (result.gate.reason === 'kyb_not_verified') {
        return res.status(403).json({ error: 'kyb_not_verified', org_name: result.gate.org.org_name });
      }
      return res.status(403).json({ error: 'organization_subject_required' });
    }
    if (result.rfqNotFound) return res.status(404).json({ error: 'rfq_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'rfq_not_open', current_status: result.wrongStatus });
    if (result.hasAuction) return res.status(409).json({ error: 'rfq_has_auction' });
    return res.status(201).json(result.quote);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /procurement/quotes/mine?status= — organization-only, every quote
 * this org has submitted across every RFQ, joined with the RFQ's title/
 * requester name/status so the frontend can show "your quote on X, RFQ
 * currently Y" without a second round trip per row.
 */
router.get('/quotes/mine', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'organization') {
    return res.status(403).json({ error: 'organization_subject_required' });
  }
  const { status } = req.query;

  try {
    const rows = await withSessionContext('organization', subject.subjectId, async (client) => {
      const params = [subject.subjectId];
      let filter = '';
      if (status) { params.push(status); filter = 'AND q.status = $2'; }

      const result = await client.query(
        `SELECT q.quote_id, q.rfq_id, q.quoted_price, q.price_unit, q.quoted_quantity, q.message,
                q.status, q.submitted_at, q.decided_at,
                r.title AS rfq_title, r.category AS rfq_category, r.status AS rfq_status,
                COALESCE(f.full_name, o.org_name) AS rfq_requester_name
           FROM procurement.rfq_quote q
           JOIN procurement.rfq r ON r.rfq_id = q.rfq_id
           LEFT JOIN identity.farmer f ON r.requester_subject_type = 'farmer' AND f.farmer_id = r.requester_subject_id
           LEFT JOIN identity.organization o ON r.requester_subject_type = 'organization' AND o.org_id = r.requester_subject_id
          WHERE q.responder_org_id = $1 ${filter}
          ORDER BY q.submitted_at DESC`,
        params,
      );
      await logAccess(client, 'read', 'procurement.rfq_quote', subject.subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /procurement/quotes/:quoteId/withdraw — responder-only, only while
 * still `submitted` (can't withdraw one that's already been accepted/
 * rejected/withdrawn).
 */
router.post('/quotes/:quoteId/withdraw', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'organization') {
    return res.status(403).json({ error: 'organization_subject_required' });
  }
  const { quoteId } = req.params;

  try {
    const result = await withSessionContext('organization', subject.subjectId, async (client) => {
      const existing = await client.query(
        'SELECT status FROM procurement.rfq_quote WHERE quote_id = $1 AND responder_org_id = $2',
        [quoteId, subject.subjectId],
      );
      if (existing.rows.length === 0) return { notFound: true };
      if (existing.rows[0].status !== 'submitted') return { wrongStatus: existing.rows[0].status };

      const { rows } = await client.query(
        `UPDATE procurement.rfq_quote SET status = 'withdrawn', updated_at = now()
          WHERE quote_id = $1
          RETURNING quote_id, status`,
        [quoteId],
      );
      await logAccess(client, 'write', 'procurement.rfq_quote', quoteId);
      return { quote: rows[0] };
    });

    if (result.notFound) return res.status(404).json({ error: 'quote_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'quote_not_submitted', current_status: result.wrongStatus });
    return res.json(result.quote);
  } catch (err) {
    return next(err);
  }
});

// ============================================================
// e-Auction — real-time reverse auction layered on top of an RFQ.
// See B2B_COMMERCE_ENGINE_ARCHITECTURE.md section 4.4 and
// grant_b2b_commerce_engine.sql for the full design rationale. An auction
// always belongs to exactly one RFQ (uq_auction_rfq); once one exists for
// an RFQ, direct quoting on that RFQ is blocked (see the guard added to
// POST /rfqs/:id/quotes above) — bidding happens here instead.
// ============================================================

/**
 * Closes an auction and, if it received at least one bid, awards it —
 * shared by POST /auctions/:id/close (manual, requester-initiated) and
 * the lazy-expiry check performed by every other auction endpoint (no
 * cron job in this sandbox; the next read or bid against an
 * already-expired-but-still-'open' auction settles it first). `auction`
 * must already be loaded with at least {auction_id, rfq_id} and the
 * caller must have already verified status === 'open'.
 */
async function closeAndAwardAuction(client, auction) {
  const winnerRes = await client.query(
    `SELECT bid_id, bidder_org_id, bid_price, bid_quantity, message
       FROM procurement.auction_bid
      WHERE auction_id = $1
      ORDER BY bid_price ASC, submitted_at ASC
      LIMIT 1`,
    [auction.auction_id],
  );

  if (winnerRes.rows.length === 0) {
    // No bids at all — close with no winner. The RFQ underneath is left
    // untouched (still 'open') so the requester can still accept a direct
    // quote later or re-run the process; nothing to award here.
    const { rows } = await client.query(
      `UPDATE procurement.auction SET status = 'closed', closed_at = now()
        WHERE auction_id = $1
        RETURNING auction_id, rfq_id, status, closed_at, winning_bid_id`,
      [auction.auction_id],
    );
    await logAccess(client, 'write', 'procurement.auction', auction.auction_id);
    return { auction: rows[0], awarded: false };
  }

  const winner = winnerRes.rows[0];
  const rfqRes = await client.query(
    `SELECT category, requester_subject_type, requester_subject_id, quantity, quantity_unit
       FROM procurement.rfq WHERE rfq_id = $1`,
    [auction.rfq_id],
  );
  const rfq = rfqRes.rows[0];

  const award = await awardRfqToResponder(client, {
    rfqId: auction.rfq_id,
    category: rfq.category,
    requesterSubjectType: rfq.requester_subject_type,
    requesterSubjectId: rfq.requester_subject_id,
    responderOrgId: winner.bidder_org_id,
    price: winner.bid_price,
    priceUnit: 'บาท/หน่วย',
    quantity: winner.bid_quantity || rfq.quantity,
    quantityUnit: rfq.quantity_unit,
    message: winner.message,
  });

  const { rows } = await client.query(
    `UPDATE procurement.auction SET status = 'awarded', winning_bid_id = $2, closed_at = now()
      WHERE auction_id = $1
      RETURNING auction_id, rfq_id, status, closed_at, winning_bid_id`,
    [auction.auction_id, winner.bid_id],
  );
  await logAccess(client, 'write', 'procurement.auction', auction.auction_id);

  return { auction: rows[0], awarded: true, rfq: award.rfq, contractId: award.contractId };
}

/** Lazy-expiry check — see closeAndAwardAuction's doc comment. */
async function ensureAuctionSettled(client, auctionRow) {
  if (auctionRow.status === 'open' && new Date(auctionRow.closes_at).getTime() <= Date.now()) {
    const { auction } = await closeAndAwardAuction(client, auctionRow);
    return { ...auctionRow, status: auction.status, closed_at: auction.closed_at, winning_bid_id: auction.winning_bid_id };
  }
  return auctionRow;
}

/**
 * POST /procurement/auctions
 * Body: { rfq_id, closes_at }
 * Creates a real-time reverse auction on an RFQ the caller already owns
 * (requester-only) and which is still `open`. One auction per RFQ.
 */
router.post('/auctions', async (req, res, next) => {
  const subject = req.subject;
  if (!isRequesterEligible(subject.subjectType)) {
    return res.status(403).json({ error: 'farmer_or_organization_subject_required' });
  }
  const { rfq_id: rfqId, closes_at: closesAt } = req.body || {};
  if (!rfqId) return res.status(400).json({ error: 'rfq_id_required' });
  const closesAtDate = closesAt ? new Date(closesAt) : null;
  if (!closesAtDate || Number.isNaN(closesAtDate.getTime()) || closesAtDate.getTime() <= Date.now()) {
    return res.status(400).json({ error: 'invalid_closes_at', detail: 'must be a valid future timestamp' });
  }

  try {
    const result = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const rfqRes = await client.query(
        `SELECT status FROM procurement.rfq
          WHERE rfq_id = $1 AND requester_subject_type = $2 AND requester_subject_id = $3`,
        [rfqId, subject.subjectType, subject.subjectId],
      );
      if (rfqRes.rows.length === 0) return { rfqNotFound: true };
      if (rfqRes.rows[0].status !== 'open') return { wrongStatus: rfqRes.rows[0].status };

      const existing = await client.query('SELECT auction_id FROM procurement.auction WHERE rfq_id = $1', [rfqId]);
      if (existing.rows.length > 0) return { alreadyExists: true };

      const { rows } = await client.query(
        `INSERT INTO procurement.auction (rfq_id, closes_at)
         VALUES ($1, $2)
         RETURNING auction_id, rfq_id, starts_at, closes_at, status, created_at`,
        [rfqId, closesAtDate.toISOString()],
      );
      await logAccess(client, 'write', 'procurement.auction', rows[0].auction_id);
      return { auction: rows[0] };
    });

    if (result.rfqNotFound) return res.status(404).json({ error: 'rfq_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'rfq_not_open', current_status: result.wrongStatus });
    if (result.alreadyExists) return res.status(409).json({ error: 'auction_already_exists' });
    return res.status(201).json(result.auction);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /procurement/auctions?category=&status= — browse, open to any
 * eligible subject (spectating an auction is harmless; only bidding is
 * organization-gated). Includes `current_lowest_bid`/`bid_count` but
 * never bidder identity — see the sealed-bidder-identity note in
 * grant_b2b_commerce_engine.sql.
 */
router.get('/auctions', async (req, res, next) => {
  const subject = req.subject;
  if (!isRequesterEligible(subject.subjectType)) {
    return res.status(403).json({ error: 'farmer_or_organization_subject_required' });
  }
  const { category, status } = req.query;
  if (category && !RFQ_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'invalid_category', valid: RFQ_CATEGORIES });
  }

  try {
    const rows = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const params = [];
      const filters = [];
      if (status) { params.push(status); filters.push(`a.status = $${params.length}`); }
      if (category) { params.push(category); filters.push(`r.category = $${params.length}`); }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

      const result = await client.query(
        `SELECT a.auction_id, a.rfq_id, a.starts_at, a.closes_at, a.status, a.created_at,
                r.title, r.category, r.description, r.quantity, r.quantity_unit,
                COALESCE(f.full_name, o.org_name) AS requester_name,
                (SELECT MIN(bid_price) FROM procurement.auction_bid WHERE auction_id = a.auction_id) AS current_lowest_bid,
                (SELECT count(*)::int FROM procurement.auction_bid WHERE auction_id = a.auction_id) AS bid_count
           FROM procurement.auction a
           JOIN procurement.rfq r ON r.rfq_id = a.rfq_id
           LEFT JOIN identity.farmer f ON r.requester_subject_type = 'farmer' AND f.farmer_id = r.requester_subject_id
           LEFT JOIN identity.organization o ON r.requester_subject_type = 'organization' AND o.org_id = r.requester_subject_id
          ${where}
          ORDER BY a.created_at DESC`,
        params,
      );
      const settled = [];
      for (const row of result.rows) {
        if (row.status === 'open' && new Date(row.closes_at).getTime() <= Date.now()) {
          const fresh = await ensureAuctionSettled(client, row);
          settled.push({ ...row, status: fresh.status });
        } else {
          settled.push(row);
        }
      }
      return settled;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/** GET /procurement/auctions/mine — requester's own auctions, every status. */
router.get('/auctions/mine', async (req, res, next) => {
  const subject = req.subject;
  if (!isRequesterEligible(subject.subjectType)) {
    return res.status(403).json({ error: 'farmer_or_organization_subject_required' });
  }
  try {
    const rows = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const result = await client.query(
        `SELECT a.auction_id, a.rfq_id, a.starts_at, a.closes_at, a.status, a.winning_bid_id, a.closed_at, a.created_at,
                r.title, r.category,
                (SELECT MIN(bid_price) FROM procurement.auction_bid WHERE auction_id = a.auction_id) AS current_lowest_bid,
                (SELECT count(*)::int FROM procurement.auction_bid WHERE auction_id = a.auction_id) AS bid_count
           FROM procurement.auction a
           JOIN procurement.rfq r ON r.rfq_id = a.rfq_id
          WHERE r.requester_subject_type = $1 AND r.requester_subject_id = $2
          ORDER BY a.created_at DESC`,
        [subject.subjectType, subject.subjectId],
      );
      const settled = [];
      for (const row of result.rows) {
        if (row.status === 'open' && new Date(row.closes_at).getTime() <= Date.now()) {
          const fresh = await ensureAuctionSettled(client, row);
          settled.push({ ...row, status: fresh.status, winning_bid_id: fresh.winning_bid_id, closed_at: fresh.closed_at });
        } else {
          settled.push(row);
        }
      }
      return settled;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /procurement/auctions/:id — detail. Includes `current_lowest_bid`/
 * `bid_count` for everyone, and `my_lowest_bid` for an organization caller
 * (so a bidder knows where they stand without seeing who else is bidding).
 */
router.get('/auctions/:id', async (req, res, next) => {
  const subject = req.subject;
  if (!isRequesterEligible(subject.subjectType)) {
    return res.status(403).json({ error: 'farmer_or_organization_subject_required' });
  }
  const { id } = req.params;

  try {
    const result = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const auctionRes = await client.query(
        `SELECT a.auction_id, a.rfq_id, a.starts_at, a.closes_at, a.status, a.winning_bid_id, a.closed_at, a.created_at,
                r.title, r.category, r.description, r.quantity, r.quantity_unit, r.target_price,
                r.delivery_location, r.needed_by_date,
                COALESCE(f.full_name, o.org_name) AS requester_name
           FROM procurement.auction a
           JOIN procurement.rfq r ON r.rfq_id = a.rfq_id
           LEFT JOIN identity.farmer f ON r.requester_subject_type = 'farmer' AND f.farmer_id = r.requester_subject_id
           LEFT JOIN identity.organization o ON r.requester_subject_type = 'organization' AND o.org_id = r.requester_subject_id
          WHERE a.auction_id = $1`,
        [id],
      );
      if (auctionRes.rows.length === 0) return { notFound: true };
      let auction = auctionRes.rows[0];

      if (auction.status === 'open' && new Date(auction.closes_at).getTime() <= Date.now()) {
        const fresh = await ensureAuctionSettled(client, auction);
        auction = { ...auction, status: fresh.status, winning_bid_id: fresh.winning_bid_id, closed_at: fresh.closed_at };
      }

      const lowestRes = await client.query(
        'SELECT MIN(bid_price) AS current_lowest_bid, count(*)::int AS bid_count FROM procurement.auction_bid WHERE auction_id = $1',
        [id],
      );
      auction.current_lowest_bid = lowestRes.rows[0].current_lowest_bid;
      auction.bid_count = lowestRes.rows[0].bid_count;

      if (subject.subjectType === 'organization') {
        const myBidRes = await client.query(
          'SELECT MIN(bid_price) AS my_lowest_bid FROM procurement.auction_bid WHERE auction_id = $1 AND bidder_org_id = $2',
          [id, subject.subjectId],
        );
        auction.my_lowest_bid = myBidRes.rows[0].my_lowest_bid;
      }

      return { auction };
    });

    if (result.notFound) return res.status(404).json({ error: 'auction_not_found' });
    return res.json(result.auction);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /procurement/auctions/:id/bids
 * Body: { bid_price, bid_quantity?, message? }
 * Organization-only. A new bid must be strictly LOWER than the current
 * global lowest bid (if any exist) — this is what makes it a live
 * descending-price auction rather than an independent-quote list; enforced
 * here at the application layer (needs a MIN() query, not expressible as a
 * plain CHECK constraint).
 */
router.post('/auctions/:id/bids', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'organization') {
    return res.status(403).json({ error: 'organization_subject_required' });
  }
  const { id } = req.params;
  const { bid_price: bidPriceRaw, bid_quantity: bidQuantityRaw, message } = req.body || {};
  const bidPrice = Number(bidPriceRaw);
  if (!Number.isFinite(bidPrice) || bidPrice <= 0) {
    return res.status(400).json({ error: 'invalid_bid_price' });
  }
  if (bidQuantityRaw !== undefined && bidQuantityRaw !== null
    && (!Number.isFinite(Number(bidQuantityRaw)) || Number(bidQuantityRaw) <= 0)) {
    return res.status(400).json({ error: 'invalid_bid_quantity' });
  }

  try {
    const result = await withSessionContext('organization', subject.subjectId, async (client) => {
      const gate = await requireVerifiedOrgIfOrganization(client, subject);
      if (!gate.ok) return { gate };

      const auctionRes = await client.query(
        'SELECT auction_id, rfq_id, status, closes_at FROM procurement.auction WHERE auction_id = $1',
        [id],
      );
      if (auctionRes.rows.length === 0) return { notFound: true };
      let auction = auctionRes.rows[0];

      if (auction.status === 'open' && new Date(auction.closes_at).getTime() <= Date.now()) {
        const fresh = await ensureAuctionSettled(client, auction);
        auction = { ...auction, status: fresh.status };
      }
      if (auction.status !== 'open') return { wrongStatus: auction.status };

      const lowestRes = await client.query(
        'SELECT MIN(bid_price) AS current_lowest_bid FROM procurement.auction_bid WHERE auction_id = $1',
        [id],
      );
      const currentLowest = lowestRes.rows[0].current_lowest_bid;
      if (currentLowest !== null && bidPrice >= Number(currentLowest)) {
        return { notCompetitive: true, currentLowest: Number(currentLowest) };
      }

      const { rows } = await client.query(
        `INSERT INTO procurement.auction_bid (auction_id, bidder_org_id, bid_price, bid_quantity, message)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING bid_id, auction_id, bid_price, bid_quantity, message, submitted_at`,
        [id, subject.subjectId, bidPrice, bidQuantityRaw || null, message || null],
      );
      await logAccess(client, 'write', 'procurement.auction_bid', rows[0].bid_id);
      return { bid: rows[0] };
    });

    if (result.gate && !result.gate.ok) {
      if (result.gate.reason === 'kyb_not_verified') {
        return res.status(403).json({ error: 'kyb_not_verified', org_name: result.gate.org.org_name });
      }
      return res.status(403).json({ error: 'organization_subject_required' });
    }
    if (result.notFound) return res.status(404).json({ error: 'auction_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'auction_not_open', current_status: result.wrongStatus });
    if (result.notCompetitive) {
      return res.status(409).json({ error: 'bid_not_competitive', current_lowest_bid: result.currentLowest });
    }
    return res.status(201).json(result.bid);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /procurement/auctions/:id/bids — requester-only, the full bid
 * history (every bidder's identity + price), ordered lowest-first. Mirrors
 * GET /rfqs/:id/quotes's requester-only shape.
 */
router.get('/auctions/:id/bids', async (req, res, next) => {
  const subject = req.subject;
  if (!isRequesterEligible(subject.subjectType)) {
    return res.status(403).json({ error: 'farmer_or_organization_subject_required' });
  }
  const { id } = req.params;

  try {
    const result = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const owned = await client.query(
        `SELECT a.auction_id FROM procurement.auction a
           JOIN procurement.rfq r ON r.rfq_id = a.rfq_id
          WHERE a.auction_id = $1 AND r.requester_subject_type = $2 AND r.requester_subject_id = $3`,
        [id, subject.subjectType, subject.subjectId],
      );
      if (owned.rows.length === 0) return { notFound: true };

      const bids = await client.query(
        `SELECT b.bid_id, b.bidder_org_id, o.org_name AS bidder_org_name, b.bid_price, b.bid_quantity,
                b.message, b.submitted_at
           FROM procurement.auction_bid b
           JOIN identity.organization o ON o.org_id = b.bidder_org_id
          WHERE b.auction_id = $1
          ORDER BY b.bid_price ASC, b.submitted_at ASC`,
        [id],
      );
      return { bids: bids.rows };
    });

    if (result.notFound) return res.status(404).json({ error: 'auction_not_found' });
    return res.json(result.bids);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /procurement/auctions/:id/close — requester-only manual close
 * (before closes_at — an already-expired auction settles itself lazily,
 * see ensureAuctionSettled, so this is for a requester who wants to end
 * bidding early once they're happy with the price).
 */
router.post('/auctions/:id/close', async (req, res, next) => {
  const subject = req.subject;
  if (!isRequesterEligible(subject.subjectType)) {
    return res.status(403).json({ error: 'farmer_or_organization_subject_required' });
  }
  const { id } = req.params;

  try {
    const result = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const auctionRes = await client.query(
        `SELECT a.auction_id, a.rfq_id, a.status FROM procurement.auction a
           JOIN procurement.rfq r ON r.rfq_id = a.rfq_id
          WHERE a.auction_id = $1 AND r.requester_subject_type = $2 AND r.requester_subject_id = $3`,
        [id, subject.subjectType, subject.subjectId],
      );
      if (auctionRes.rows.length === 0) return { notFound: true };
      const auction = auctionRes.rows[0];
      if (auction.status !== 'open') return { wrongStatus: auction.status };

      const closeResult = await closeAndAwardAuction(client, auction);
      return { closeResult };
    });

    if (result.notFound) return res.status(404).json({ error: 'auction_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'auction_not_open', current_status: result.wrongStatus });
    return res.json(result.closeResult.auction);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /procurement/contracts/mine — every contract.contract row the caller
 * is a party to via an RFQ/auction award (any role — 'buyer'/'farmer' on
 * the issuing side, 'seller'/'input_supplier'/'service_provider' on the
 * fulfilling side), newest first. Deliberately UNSCOPED by role, unlike
 * GET /buyer/contracts or GET /farmer/contracts (which only return the
 * 'buyer'/'farmer' rows) — this endpoint backs the frontend's PO screen,
 * which needs to show a caller their contracts regardless of which side of
 * the deal they ended up on, so it can decide for itself (via
 * PO_ISSUER_ROLES, mirrored client-side) whether "ออก PO" or nothing
 * belongs on that card. Includes rfq_id/rfq_title via procurement.rfq's
 * own contract_id back-reference so the UI can show what the contract was
 * for without a second round trip.
 */
router.get('/contracts/mine', async (req, res, next) => {
  const subject = req.subject;
  if (!isRequesterEligible(subject.subjectType)) {
    return res.status(403).json({ error: 'farmer_or_organization_subject_required' });
  }
  try {
    const rows = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const result = await client.query(
        `SELECT c.contract_id, c.contract_type, c.status, cp.party_role,
                c.agreed_quantity, c.agreed_unit_price, c.quantity_unit,
                c.effective_date, c.terms_summary, c.created_at,
                r.rfq_id, r.title AS rfq_title
           FROM contract.contract c
           JOIN contract.contract_party cp ON cp.contract_id = c.contract_id
           LEFT JOIN procurement.rfq r ON r.contract_id = c.contract_id
          WHERE cp.party_type = $1 AND cp.party_id = $2
          ORDER BY c.created_at DESC`,
        [subject.subjectType, subject.subjectId],
      );
      await logAccess(client, 'read', 'contract.contract', subject.subjectId);
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// ============================================================
// Purchase Order — issued against an ACTIVE contract (see
// procurement.create_contract_from_award's doc comment for why a contract
// produced by an RFQ/auction award starts 'active' rather than 'draft').
// See B2B_COMMERCE_ENGINE_ARCHITECTURE.md section 4.6.
// ============================================================

// The "wants the goods" side of a contract — whoever holds one of these
// roles is the only one allowed to issue a PO against it. Mirrors the
// v_requester_role mapping in create_contract_from_award().
const PO_ISSUER_ROLES = ['farmer', 'buyer'];

function generatePoNumber() {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randomPart = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `PO-${datePart}-${randomPart}`;
}

/**
 * POST /procurement/purchase-orders
 * Body: { contract_id, quantity, quantity_unit?, unit_price, delivery_location?, needed_by_date?, notes? }
 * Only the buyer-side party of an ACTIVE contract can issue a PO against
 * it. A contract can be drawn down over several POs (delivered in
 * tranches) — this endpoint does not check the sum of prior POs against
 * the contract's agreed_quantity (see the architecture doc's note on this
 * being an application-layer concern for a future pass, same as
 * marketplace.product_order never enforcing stock levels).
 */
router.post('/purchase-orders', async (req, res, next) => {
  const subject = req.subject;
  if (!isRequesterEligible(subject.subjectType)) {
    return res.status(403).json({ error: 'farmer_or_organization_subject_required' });
  }
  const {
    contract_id: contractId, quantity, quantity_unit: quantityUnit, unit_price: unitPriceRaw,
    delivery_location: deliveryLocation, needed_by_date: neededByDate, notes,
  } = req.body || {};

  if (!contractId) return res.status(400).json({ error: 'contract_id_required' });
  const qty = Number(quantity);
  const unitPrice = Number(unitPriceRaw);
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'invalid_quantity' });
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return res.status(400).json({ error: 'invalid_unit_price' });

  try {
    const result = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const contractRes = await client.query(
        `SELECT c.contract_id, c.status
           FROM contract.contract c
           JOIN contract.contract_party cp ON cp.contract_id = c.contract_id
          WHERE c.contract_id = $1 AND cp.party_type = $2 AND cp.party_id = $3 AND cp.party_role = ANY($4)`,
        [contractId, subject.subjectType, subject.subjectId, PO_ISSUER_ROLES],
      );
      if (contractRes.rows.length === 0) return { notFound: true };
      if (contractRes.rows[0].status !== 'active') return { wrongStatus: contractRes.rows[0].status };

      const totalAmount = qty * unitPrice;
      const poNumber = generatePoNumber();

      const { rows } = await client.query(
        `INSERT INTO procurement.purchase_order
           (po_number, contract_id, issued_by_subject_type, issued_by_subject_id,
            quantity, quantity_unit, unit_price, total_amount, delivery_location, needed_by_date, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING po_id, po_number, contract_id, quantity, quantity_unit, unit_price, total_amount,
                   delivery_location, needed_by_date, status, notes, issued_at`,
        [
          poNumber, contractId, subject.subjectType, subject.subjectId,
          qty, quantityUnit || null, unitPrice, totalAmount,
          deliveryLocation || null, neededByDate || null, notes || null,
        ],
      );
      await logAccess(client, 'write', 'procurement.purchase_order', rows[0].po_id);
      return { po: rows[0] };
    });

    if (result.notFound) return res.status(404).json({ error: 'contract_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'contract_not_active', current_status: result.wrongStatus });
    return res.status(201).json(result.po);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /procurement/purchase-orders/mine — every PO the caller is a party
 * to (via the underlying contract's contract_party rows), whichever side
 * they're on — issuer or recipient. Includes issued_by_subject_type/id so
 * the frontend can tell, without a second lookup, whether the caller was
 * the one who issued this PO (and should therefore never see an
 * "acknowledge" action on it) or is on the receiving side (and should).
 */
router.get('/purchase-orders/mine', async (req, res, next) => {
  const subject = req.subject;
  if (!isRequesterEligible(subject.subjectType)) {
    return res.status(403).json({ error: 'farmer_or_organization_subject_required' });
  }
  try {
    const rows = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const result = await client.query(
        `SELECT DISTINCT po.po_id, po.po_number, po.contract_id, po.quantity, po.quantity_unit, po.unit_price,
                po.total_amount, po.delivery_location, po.needed_by_date, po.status, po.notes,
                po.issued_by_subject_type, po.issued_by_subject_id,
                po.issued_at, po.acknowledged_at, po.updated_at, c.contract_type
           FROM procurement.purchase_order po
           JOIN contract.contract c ON c.contract_id = po.contract_id
           JOIN contract.contract_party cp ON cp.contract_id = po.contract_id
          WHERE cp.party_type = $1 AND cp.party_id = $2
          ORDER BY po.issued_at DESC`,
        [subject.subjectType, subject.subjectId],
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /procurement/purchase-orders/:id/acknowledge — seller-side only
 * (the contract party whose role is NOT in PO_ISSUER_ROLES), only while
 * still `issued`.
 */
router.post('/purchase-orders/:id/acknowledge', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'organization') {
    return res.status(403).json({ error: 'organization_subject_required' });
  }
  const { id } = req.params;

  try {
    const result = await withSessionContext('organization', subject.subjectId, async (client) => {
      const poRes = await client.query(
        `SELECT po.po_id, po.status
           FROM procurement.purchase_order po
           JOIN contract.contract_party cp ON cp.contract_id = po.contract_id
          WHERE po.po_id = $1 AND cp.party_type = 'organization' AND cp.party_id = $2
            AND NOT (cp.party_role = ANY($3))`,
        [id, subject.subjectId, PO_ISSUER_ROLES],
      );
      if (poRes.rows.length === 0) return { notFound: true };
      if (poRes.rows[0].status !== 'issued') return { wrongStatus: poRes.rows[0].status };

      const { rows } = await client.query(
        `UPDATE procurement.purchase_order SET status = 'acknowledged', acknowledged_at = now(), updated_at = now()
          WHERE po_id = $1
          RETURNING po_id, status, acknowledged_at`,
        [id],
      );
      await logAccess(client, 'write', 'procurement.purchase_order', id);
      return { po: rows[0] };
    });

    if (result.notFound) return res.status(404).json({ error: 'purchase_order_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'po_not_issued', current_status: result.wrongStatus });
    return res.json(result.po);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /procurement/purchase-orders/:id/cancel — either party, only while
 * `issued` or `acknowledged` (not once `in_fulfillment`/`completed`).
 */
router.post('/purchase-orders/:id/cancel', async (req, res, next) => {
  const subject = req.subject;
  if (!isRequesterEligible(subject.subjectType)) {
    return res.status(403).json({ error: 'farmer_or_organization_subject_required' });
  }
  const { id } = req.params;

  try {
    const result = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const poRes = await client.query(
        `SELECT po.po_id, po.status
           FROM procurement.purchase_order po
           JOIN contract.contract_party cp ON cp.contract_id = po.contract_id
          WHERE po.po_id = $1 AND cp.party_type = $2 AND cp.party_id = $3`,
        [id, subject.subjectType, subject.subjectId],
      );
      if (poRes.rows.length === 0) return { notFound: true };
      if (!['issued', 'acknowledged'].includes(poRes.rows[0].status)) return { wrongStatus: poRes.rows[0].status };

      const { rows } = await client.query(
        `UPDATE procurement.purchase_order SET status = 'cancelled', updated_at = now()
          WHERE po_id = $1
          RETURNING po_id, status`,
        [id],
      );
      await logAccess(client, 'write', 'procurement.purchase_order', id);
      return { po: rows[0] };
    });

    if (result.notFound) return res.status(404).json({ error: 'purchase_order_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'po_not_cancellable', current_status: result.wrongStatus });
    return res.json(result.po);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
