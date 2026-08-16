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
 * POST /procurement/rfqs/:id/quotes/:quoteId/accept — the award step.
 * Requester-only, RFQ must still be `open`. Sets the chosen quote to
 * `accepted`, every OTHER submitted quote on this RFQ to `rejected`, and
 * the RFQ itself to `awarded` with `awarded_quote_id` set — all inside one
 * transaction (withSessionContext already wraps each call in one). This
 * only records intent; it does NOT create a produce.delivery /
 * marketplace.product_order / contract.contract row (see the design note
 * at the top of grant_rfq_marketplace.sql and the "what's mocked" section
 * in backend/README.md) — that wiring is deliberately left for a
 * follow-up pass.
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
        `SELECT status FROM procurement.rfq
          WHERE rfq_id = $1 AND requester_subject_type = $2 AND requester_subject_id = $3`,
        [id, subject.subjectType, subject.subjectId],
      );
      if (rfqRes.rows.length === 0) return { rfqNotFound: true };
      if (rfqRes.rows[0].status !== 'open') return { wrongStatus: rfqRes.rows[0].status };

      const quoteRes = await client.query(
        `SELECT quote_id, status FROM procurement.rfq_quote WHERE rfq_id = $1 AND quote_id = $2`,
        [id, quoteId],
      );
      if (quoteRes.rows.length === 0) return { quoteNotFound: true };
      if (quoteRes.rows[0].status !== 'submitted') return { quoteWrongStatus: quoteRes.rows[0].status };

      await client.query(
        `UPDATE procurement.rfq_quote SET status = 'accepted', decided_at = now(), updated_at = now()
          WHERE rfq_id = $1 AND quote_id = $2`,
        [id, quoteId],
      );
      await client.query(
        `UPDATE procurement.rfq_quote SET status = 'rejected', decided_at = now(), updated_at = now()
          WHERE rfq_id = $1 AND quote_id <> $2 AND status = 'submitted'`,
        [id, quoteId],
      );
      const { rows } = await client.query(
        `UPDATE procurement.rfq SET status = 'awarded', awarded_quote_id = $2, updated_at = now()
          WHERE rfq_id = $1
          RETURNING rfq_id, status, awarded_quote_id`,
        [id, quoteId],
      );
      await logAccess(client, 'write', 'procurement.rfq', id);
      await logAccess(client, 'write', 'procurement.rfq_quote', quoteId);
      return { rfq: rows[0] };
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

module.exports = router;
