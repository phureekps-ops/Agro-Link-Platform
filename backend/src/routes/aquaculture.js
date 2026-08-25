const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// Auction Place — Shrimp Sealed-Bid Auction (Phase 1a: core auction only).
// See SHRIMP_AUCTION_ARCHITECTURE.md for the full design and what is
// deliberately NOT built in this pass (feed/medication/water logs, photo
// requirements, buyer/farm trust scores, Data Quality Score gate).
//
// Mounted for BOTH farmer subjects (pond owners, who open auctions) and
// organization subjects (buyers, who bid) — same "no requireFarmer/
// requireOrganization gate, branch on req.subject.subjectType per handler"
// pattern procurement.js already uses for its RFQ marketplace, for the
// identical reason: a single router genuinely serves two different subject
// types here.
// ============================================================
router.use(requireAuth);

const SHRIMP_COMMODITY_CODES = ['SHRIMP_VANNAMEI', 'SHRIMP_BLACKTIGER', 'SHRIMP_OTHER'];
const TIER_LABELS_HIGH_TO_LOW_SIZE = ['S-2', 'S-1', 'Target', 'S+1', 'S+2']; // S-2 = smallest shrimp (highest count/kg)

/**
 * Confirms the authenticated organization holds a Verified 'Buyer' role.
 * Copy of buyer.js's requireBuyerOrg — this codebase's established
 * convention is each portal route file keeps its own copy rather than a
 * shared generic helper (see requireCooperativeOrg in coopcollection.js /
 * groupbuy.js for the same pattern).
 */
async function requireVerifiedBuyerOrg(client, orgId) {
  const org = await client.query(
    'SELECT org_id, org_name, kyb_status FROM identity.organization WHERE org_id = $1',
    [orgId],
  );
  if (org.rows.length === 0) return { ok: false, reason: 'org_missing' };
  if (org.rows[0].kyb_status !== 'Verified') return { ok: false, reason: 'kyb_not_verified', org: org.rows[0] };
  const role = await client.query(
    `SELECT status FROM identity.organization_role WHERE org_id = $1 AND role_type = 'Buyer'`,
    [orgId],
  );
  if (!role.rows[0] || role.rows[0].status !== 'Verified') {
    return { ok: false, reason: 'role_not_verified', org: org.rows[0] };
  }
  return { ok: true, org: org.rows[0] };
}

function computeSizeStats(points) {
  // points: [{sample_count, sample_weight_kg}, ...]
  const perPointSizes = points.map((p) => p.sample_count / p.sample_weight_kg);
  const totalCount = points.reduce((s, p) => s + p.sample_count, 0);
  const totalWeight = points.reduce((s, p) => s + p.sample_weight_kg, 0);
  const overallSize = totalCount / totalWeight;
  const mean = perPointSizes.reduce((s, v) => s + v, 0) / perPointSizes.length;
  const variance = perPointSizes.reduce((s, v) => s + (v - mean) ** 2, 0) / perPointSizes.length;
  const stdev = Math.sqrt(variance);
  const coefficientOfVariation = mean > 0 ? stdev / mean : 1;
  let confidence = 'Low';
  if (points.length >= 5 && coefficientOfVariation <= 0.15) confidence = 'High';
  else if (points.length >= 5 && coefficientOfVariation <= 0.30) confidence = 'Medium';
  return { computedSizePerKg: overallSize, confidence };
}

/**
 * Builds a small square GeoJSON Polygon around a single lat/lng point (~ a
 * few tens of metres per side depending on latitude) purely to satisfy
 * registry.register_production_unit()'s GPS-boundary-Polygon requirement.
 * Phase 1a deliberately skips a full map-drawing UI (see grant_shrimp_
 * auction.sql design note 3) — a real boundary can replace this later
 * without touching anything downstream, since only the polygon geometry
 * itself would change.
 */
function buildPointBufferPolygonGeoJSON(lat, lng, halfSideDegrees = 0.0005) {
  const coords = [
    [lng - halfSideDegrees, lat - halfSideDegrees],
    [lng + halfSideDegrees, lat - halfSideDegrees],
    [lng + halfSideDegrees, lat + halfSideDegrees],
    [lng - halfSideDegrees, lat + halfSideDegrees],
    [lng - halfSideDegrees, lat - halfSideDegrees],
  ];
  return JSON.stringify({ type: 'Polygon', coordinates: [coords] });
}

function buildSizeTiers(targetSizePerKg) {
  const t = Math.round(targetSizePerKg);
  return [
    { label: 'S-2', min: t + 6, max: t + 10, order: 1 },
    { label: 'S-1', min: t + 2, max: t + 5, order: 2 },
    { label: 'Target', min: t - 1, max: t + 1, order: 3 },
    { label: 'S+1', min: t - 5, max: t - 2, order: 4 },
    { label: 'S+2', min: Math.max(1, t - 9), max: t - 6, order: 5 },
  ];
}

// ============================================================
// Farm profile
// ============================================================

router.post('/farm-profile', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'farmer') return res.status(403).json({ error: 'farmer_subject_required' });
  const { farm_name: farmName, province, district, phone } = req.body || {};
  if (!farmName || !String(farmName).trim()) return res.status(400).json({ error: 'farm_name_required' });
  if (!province || !String(province).trim()) return res.status(400).json({ error: 'province_required' });

  try {
    const row = await withSessionContext('farmer', subject.subjectId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO aquaculture.farm_profile (farmer_id, farm_name, province, district, phone)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (farmer_id) DO UPDATE SET
           farm_name = EXCLUDED.farm_name, province = EXCLUDED.province,
           district = EXCLUDED.district, phone = EXCLUDED.phone, updated_at = now()
         RETURNING farm_profile_id, farmer_id, farm_name, province, district, phone, created_at, updated_at`,
        [subject.subjectId, farmName, province, district || null, phone || null],
      );
      await logAccess(client, 'write', 'aquaculture.farm_profile', rows[0].farm_profile_id);
      return rows[0];
    });
    return res.status(201).json(row);
  } catch (err) {
    return next(err);
  }
});

router.get('/farm-profile', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'farmer') return res.status(403).json({ error: 'farmer_subject_required' });
  try {
    const row = await withSessionContext('farmer', subject.subjectId, async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM aquaculture.farm_profile WHERE farmer_id = $1',
        [subject.subjectId],
      );
      return rows[0] || null;
    });
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

// ============================================================
// Ponds — thin wrapper over registry.register_production_unit(unit_type='Pond')
// ============================================================

router.post('/ponds', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'farmer') return res.status(403).json({ error: 'farmer_subject_required' });
  const {
    lat, lng, area_rai: areaRai, species, season_id: seasonId,
  } = req.body || {};
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return res.status(400).json({ error: 'invalid_lat_lng' });
  }
  const areaRaiNum = Number(areaRai);
  if (!Number.isFinite(areaRaiNum) || areaRaiNum <= 0) return res.status(400).json({ error: 'invalid_area_rai' });
  if (!SHRIMP_COMMODITY_CODES.includes(species)) {
    return res.status(400).json({ error: 'invalid_species', valid: SHRIMP_COMMODITY_CODES });
  }
  if (!seasonId || !String(seasonId).trim()) return res.status(400).json({ error: 'season_id_required' });

  const geojson = buildPointBufferPolygonGeoJSON(latNum, lngNum);

  try {
    const unitId = await withSessionContext('farmer', subject.subjectId, async (client) => {
      const { rows } = await client.query(
        `SELECT registry.register_production_unit($1, 'Pond', $2, $3, $4, $5) AS unit_id`,
        [subject.subjectId, geojson, areaRaiNum, species, seasonId],
      );
      await logAccess(client, 'write', 'registry.production_unit', rows[0].unit_id);
      return rows[0].unit_id;
    });
    return res.status(201).json({ unit_id: unitId });
  } catch (err) {
    if (err.message && /ไม่พบ|ต้องมากกว่า|ไม่ถูกต้อง/.test(err.message)) {
      return res.status(400).json({ error: 'registration_failed', detail: err.message });
    }
    return next(err);
  }
});

router.get('/ponds', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'farmer') return res.status(403).json({ error: 'farmer_subject_required' });
  try {
    const rows = await withSessionContext('farmer', subject.subjectId, async (client) => {
      const { rows: units } = await client.query(
        `SELECT unit_id, unit_type, area_rai, commodity_code, season_id, registration_date, status
           FROM registry.production_unit
          WHERE owner_farmer_id = $1 AND unit_type = 'Pond'
          ORDER BY registration_date DESC`,
        [subject.subjectId],
      );
      return units;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// ============================================================
// Sampling (pre_auction and final_harvest share this shape)
// ============================================================

async function insertSamplingEvent(client, { unitId, purpose, points, createdBySubjectType, createdBySubjectId }) {
  const { computedSizePerKg, confidence } = computeSizeStats(points);
  const { rows } = await client.query(
    `INSERT INTO aquaculture.sampling_event
       (unit_id, purpose, computed_size_per_kg, confidence_score, point_count,
        created_by_subject_type, created_by_subject_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING sampling_id, unit_id, purpose, sampled_at, computed_size_per_kg, confidence_score, point_count`,
    [unitId, purpose, computedSizePerKg, confidence, points.length, createdBySubjectType, createdBySubjectId],
  );
  const samplingId = rows[0].sampling_id;
  for (let i = 0; i < points.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO aquaculture.sampling_point (sampling_id, point_no, sample_count, sample_weight_kg)
       VALUES ($1, $2, $3, $4)`,
      [samplingId, i + 1, points[i].sample_count, points[i].sample_weight_kg],
    );
  }
  return rows[0];
}

function validateSamplingPoints(pointsRaw) {
  if (!Array.isArray(pointsRaw) || pointsRaw.length < 5) return { error: 'at_least_5_points_required' };
  const points = [];
  for (const p of pointsRaw) {
    const sampleCount = Number(p.sample_count);
    const sampleWeightKg = Number(p.sample_weight_kg);
    if (!Number.isFinite(sampleCount) || sampleCount <= 0) return { error: 'invalid_sample_count' };
    if (!Number.isFinite(sampleWeightKg) || sampleWeightKg <= 0) return { error: 'invalid_sample_weight_kg' };
    points.push({ sample_count: sampleCount, sample_weight_kg: sampleWeightKg });
  }
  return { points };
}

router.post('/ponds/:unitId/sampling', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'farmer') return res.status(403).json({ error: 'farmer_subject_required' });
  const { unitId } = req.params;
  const validated = validateSamplingPoints((req.body || {}).points);
  if (validated.error) return res.status(400).json({ error: validated.error });

  try {
    const result = await withSessionContext('farmer', subject.subjectId, async (client) => {
      const owned = await client.query(
        `SELECT unit_id FROM registry.production_unit WHERE unit_id = $1 AND owner_farmer_id = $2 AND unit_type = 'Pond'`,
        [unitId, subject.subjectId],
      );
      if (owned.rows.length === 0) return { notFound: true };
      const event = await insertSamplingEvent(client, {
        unitId,
        purpose: 'pre_auction',
        points: validated.points,
        createdBySubjectType: 'farmer',
        createdBySubjectId: subject.subjectId,
      });
      await logAccess(client, 'write', 'aquaculture.sampling_event', event.sampling_id);
      return { event };
    });
    if (result.notFound) return res.status(404).json({ error: 'pond_not_found' });
    return res.status(201).json(result.event);
  } catch (err) {
    return next(err);
  }
});

router.get('/ponds/:unitId/sampling', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'farmer') return res.status(403).json({ error: 'farmer_subject_required' });
  const { unitId } = req.params;
  try {
    const rows = await withSessionContext('farmer', subject.subjectId, async (client) => {
      const { rows: events } = await client.query(
        `SELECT se.sampling_id, se.purpose, se.sampled_at, se.computed_size_per_kg, se.confidence_score, se.point_count
           FROM aquaculture.sampling_event se
           JOIN registry.production_unit pu ON pu.unit_id = se.unit_id
          WHERE se.unit_id = $1 AND pu.owner_farmer_id = $2
          ORDER BY se.sampled_at DESC`,
        [unitId, subject.subjectId],
      );
      return events;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// ============================================================
// Auctions
// ============================================================

/** Lazily flips status 'open' -> 'closed' once closes_at has passed —
 * same convention groupbuy.js/procurement.js already use instead of a cron.
 * Never auto-awards (that's the whole point of forward mode). */
async function ensureForwardAuctionClosed(client, auction) {
  if (auction.status === 'open' && new Date(auction.closes_at).getTime() <= Date.now()) {
    await client.query(`UPDATE procurement.auction SET status = 'closed' WHERE auction_id = $1`, [auction.auction_id]);
    return { ...auction, status: 'closed' };
  }
  return auction;
}

router.post('/auctions', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'farmer') return res.status(403).json({ error: 'farmer_subject_required' });
  const {
    unit_id: unitId, sampling_id: samplingId, closes_at: closesAt, product_description: productDescription,
  } = req.body || {};
  if (!unitId || !samplingId) return res.status(400).json({ error: 'unit_id_and_sampling_id_required' });
  const closesAtDate = new Date(closesAt);
  if (!closesAt || Number.isNaN(closesAtDate.getTime()) || closesAtDate.getTime() <= Date.now()) {
    return res.status(400).json({ error: 'invalid_closes_at' });
  }

  try {
    const result = await withSessionContext('farmer', subject.subjectId, async (client) => {
      const unitRes = await client.query(
        `SELECT unit_id, commodity_code FROM registry.production_unit
          WHERE unit_id = $1 AND owner_farmer_id = $2 AND unit_type = 'Pond'`,
        [unitId, subject.subjectId],
      );
      if (unitRes.rows.length === 0) return { unitNotFound: true };

      const samplingRes = await client.query(
        `SELECT sampling_id, computed_size_per_kg FROM aquaculture.sampling_event
          WHERE sampling_id = $1 AND unit_id = $2 AND purpose = 'pre_auction'`,
        [samplingId, unitId],
      );
      if (samplingRes.rows.length === 0) return { samplingNotFound: true };
      const targetSize = Number(samplingRes.rows[0].computed_size_per_kg);

      const rfqRes = await client.query(
        `INSERT INTO procurement.rfq
           (requester_subject_type, requester_subject_id, title, category, description, quantity_unit)
         VALUES ('farmer', $1, $2, 'produce', $3, 'กก.')
         RETURNING rfq_id`,
        [
          subject.subjectId,
          `ประมูลกุ้งสด — ไซส์เป้าหมายประมาณ ${targetSize.toFixed(1)} ตัว/กก.`,
          productDescription || null,
        ],
      );
      const rfqId = rfqRes.rows[0].rfq_id;

      const tiers = buildSizeTiers(targetSize);
      const tierRows = [];
      for (const tier of tiers) {
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await client.query(
          `INSERT INTO aquaculture.auction_size_tier (rfq_id, tier_label, size_per_kg_min, size_per_kg_max, display_order)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING tier_id, tier_label, size_per_kg_min, size_per_kg_max, display_order`,
          [rfqId, tier.label, tier.min, tier.max, tier.order],
        );
        tierRows.push(rows[0]);
      }

      const auctionRes = await client.query(
        `INSERT INTO procurement.auction (rfq_id, closes_at, auction_mode)
         VALUES ($1, $2, 'forward')
         RETURNING auction_id, rfq_id, starts_at, closes_at, status, auction_mode`,
        [rfqId, closesAtDate.toISOString()],
      );
      const auction = auctionRes.rows[0];

      await client.query(
        `INSERT INTO aquaculture.shrimp_auction (auction_id, unit_id, farmer_id, pre_sampling_id)
         VALUES ($1, $2, $3, $4)`,
        [auction.auction_id, unitId, subject.subjectId, samplingId],
      );

      await logAccess(client, 'write', 'procurement.auction', auction.auction_id);
      return { auction, tiers: tierRows };
    });

    if (result.unitNotFound) return res.status(404).json({ error: 'pond_not_found' });
    if (result.samplingNotFound) return res.status(404).json({ error: 'pre_auction_sampling_not_found' });
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

router.get('/auctions', async (req, res, next) => {
  const subject = req.subject;
  const { status } = req.query;
  try {
    const rows = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const { rows: auctions } = await client.query(
        `SELECT a.auction_id, a.rfq_id, a.status, a.closes_at, a.starts_at, r.title, r.description,
                fp.farm_name, fp.province, sa.unit_id,
                (SELECT computed_size_per_kg FROM aquaculture.sampling_event WHERE sampling_id = sa.pre_sampling_id) AS target_size_per_kg,
                (SELECT confidence_score FROM aquaculture.sampling_event WHERE sampling_id = sa.pre_sampling_id) AS sampling_confidence,
                (SELECT COUNT(DISTINCT bidder_org_id) FROM procurement.auction_bid WHERE auction_id = a.auction_id) AS bidder_count
           FROM procurement.auction a
           JOIN procurement.rfq r ON r.rfq_id = a.rfq_id
           JOIN aquaculture.shrimp_auction sa ON sa.auction_id = a.auction_id
           LEFT JOIN aquaculture.farm_profile fp ON fp.farmer_id = sa.farmer_id
          WHERE a.auction_mode = 'forward' AND ($1::text IS NULL OR a.status = $1)
          ORDER BY a.closes_at ASC`,
        [status || null],
      );
      return auctions;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

router.get('/auctions/mine', async (req, res, next) => {
  const subject = req.subject;
  try {
    const rows = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      if (subject.subjectType === 'farmer') {
        const { rows: auctions } = await client.query(
          `SELECT a.auction_id, a.rfq_id, a.status, a.closes_at, r.title, sa.unit_id,
                  (SELECT COUNT(DISTINCT bidder_org_id) FROM procurement.auction_bid WHERE auction_id = a.auction_id) AS bidder_count
             FROM procurement.auction a
             JOIN procurement.rfq r ON r.rfq_id = a.rfq_id
             JOIN aquaculture.shrimp_auction sa ON sa.auction_id = a.auction_id
            WHERE sa.farmer_id = $1
            ORDER BY a.closes_at DESC`,
          [subject.subjectId],
        );
        return auctions;
      }
      if (subject.subjectType === 'organization') {
        const { rows: auctions } = await client.query(
          `SELECT DISTINCT a.auction_id, a.rfq_id, a.status, a.closes_at, r.title,
                  (a.winning_bid_id IN (SELECT bid_id FROM procurement.auction_bid WHERE auction_id = a.auction_id AND bidder_org_id = $1)) AS is_winner
             FROM procurement.auction a
             JOIN procurement.rfq r ON r.rfq_id = a.rfq_id
             JOIN procurement.auction_bid b ON b.auction_id = a.auction_id
            WHERE a.auction_mode = 'forward' AND b.bidder_org_id = $1
            ORDER BY a.closes_at DESC`,
          [subject.subjectId],
        );
        return auctions;
      }
      return [];
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

router.get('/auctions/:id', async (req, res, next) => {
  const subject = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const auctionRes = await client.query(
        `SELECT a.auction_id, a.rfq_id, a.status, a.closes_at, a.starts_at, a.winning_bid_id,
                r.title, r.description, sa.unit_id, sa.farmer_id, sa.pre_sampling_id,
                fp.farm_name, fp.province, fp.district
           FROM procurement.auction a
           JOIN procurement.rfq r ON r.rfq_id = a.rfq_id
           JOIN aquaculture.shrimp_auction sa ON sa.auction_id = a.auction_id
           LEFT JOIN aquaculture.farm_profile fp ON fp.farmer_id = sa.farmer_id
          WHERE a.auction_id = $1 AND a.auction_mode = 'forward'`,
        [id],
      );
      if (auctionRes.rows.length === 0) return { notFound: true };
      const auction = await ensureForwardAuctionClosed(client, auctionRes.rows[0]);

      const tiersRes = await client.query(
        `SELECT tier_id, tier_label, size_per_kg_min, size_per_kg_max, display_order
           FROM aquaculture.auction_size_tier WHERE rfq_id = $1 ORDER BY display_order`,
        [auction.rfq_id],
      );

      const preSamplingRes = await client.query(
        'SELECT sampling_id, computed_size_per_kg, confidence_score, point_count, sampled_at FROM aquaculture.sampling_event WHERE sampling_id = $1',
        [auction.pre_sampling_id],
      );

      let myBid = null;
      if (subject.subjectType === 'organization') {
        const myBidRes = await client.query(
          `SELECT b.bid_id, bt.tier_id, bt.price
             FROM procurement.auction_bid b
             JOIN procurement.auction_bid_tier bt ON bt.bid_id = b.bid_id
            WHERE b.auction_id = $1 AND b.bidder_org_id = $2`,
          [id, subject.subjectId],
        );
        if (myBidRes.rows.length > 0) {
          myBid = {
            bid_id: myBidRes.rows[0].bid_id,
            prices: Object.fromEntries(myBidRes.rows.map((r) => [r.tier_id, Number(r.price)])),
          };
        }
      }

      const isOwner = subject.subjectType === 'farmer' && subject.subjectId === auction.farmer_id;

      return {
        auction, tiers: tiersRes.rows, preSampling: preSamplingRes.rows[0] || null, myBid, isOwner,
      };
    });

    if (result.notFound) return res.status(404).json({ error: 'auction_not_found' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// ============================================================
// Bidding (forward mode only — see procurement.js guards rejecting these
// auctions on the old single-price bid/close endpoints)
// ============================================================

router.post('/auctions/:id/bids', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'organization') return res.status(403).json({ error: 'organization_subject_required' });
  const { id } = req.params;
  const pricesByTier = (req.body || {}).prices;
  if (!pricesByTier || typeof pricesByTier !== 'object') return res.status(400).json({ error: 'prices_required' });

  try {
    const result = await withSessionContext('organization', subject.subjectId, async (client) => {
      const gate = await requireVerifiedBuyerOrg(client, subject.subjectId);
      if (!gate.ok) return { gate };

      const auctionRes = await client.query(
        `SELECT auction_id, rfq_id, status, closes_at FROM procurement.auction
          WHERE auction_id = $1 AND auction_mode = 'forward'`,
        [id],
      );
      if (auctionRes.rows.length === 0) return { notFound: true };
      const auction = await ensureForwardAuctionClosed(client, auctionRes.rows[0]);
      if (auction.status !== 'open') return { wrongStatus: auction.status };

      const tiersRes = await client.query(
        'SELECT tier_id FROM aquaculture.auction_size_tier WHERE rfq_id = $1',
        [auction.rfq_id],
      );
      const tierIds = tiersRes.rows.map((r) => r.tier_id);
      const suppliedTierIds = Object.keys(pricesByTier);
      const allTiersSupplied = tierIds.length > 0 && tierIds.every((t) => suppliedTierIds.includes(t));
      if (!allTiersSupplied) return { incompleteTiers: true, requiredTierIds: tierIds };
      for (const tierId of tierIds) {
        const price = Number(pricesByTier[tierId]);
        if (!Number.isFinite(price) || price <= 0) return { invalidPrice: true };
      }

      // Resubmission = replace, not upsert-in-place (see grant_shrimp_
      // auction.sql's DELETE-grant comment for why this table can't safely
      // get a new UNIQUE constraint).
      await client.query(
        `DELETE FROM procurement.auction_bid WHERE auction_id = $1 AND bidder_org_id = $2`,
        [id, subject.subjectId],
      );
      const bidRes = await client.query(
        `INSERT INTO procurement.auction_bid (auction_id, bidder_org_id)
         VALUES ($1, $2) RETURNING bid_id, submitted_at`,
        [id, subject.subjectId],
      );
      const bidId = bidRes.rows[0].bid_id;
      for (const tierId of tierIds) {
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO procurement.auction_bid_tier (bid_id, tier_id, price) VALUES ($1, $2, $3)`,
          [bidId, tierId, Number(pricesByTier[tierId])],
        );
      }
      await logAccess(client, 'write', 'procurement.auction_bid', bidId);

      // Per-tier status vs the best OTHER bidder — never reveals prices.
      const statusRes = await client.query(
        `SELECT bt.tier_id,
                bt.price AS my_price,
                (SELECT MAX(bt2.price) FROM procurement.auction_bid_tier bt2
                   JOIN procurement.auction_bid b2 ON b2.bid_id = bt2.bid_id
                  WHERE b2.auction_id = $1 AND bt2.tier_id = bt.tier_id AND b2.bidder_org_id <> $2) AS best_other_price
           FROM procurement.auction_bid_tier bt WHERE bt.bid_id = $3`,
        [id, subject.subjectId, bidId],
      );
      const tierStatus = statusRes.rows.map((r) => {
        const best = r.best_other_price === null ? null : Number(r.best_other_price);
        let status = 'Winning';
        if (best !== null) {
          if (Number(r.my_price) < best) status = 'Losing';
          else if (Number(r.my_price) === best) status = 'Tied';
        }
        return { tier_id: r.tier_id, status };
      });

      return { bid: { bid_id: bidId, submitted_at: bidRes.rows[0].submitted_at }, tierStatus };
    });

    if (result.gate && !result.gate.ok) {
      if (result.gate.reason === 'kyb_not_verified') return res.status(403).json({ error: 'kyb_not_verified' });
      if (result.gate.reason === 'role_not_verified') return res.status(403).json({ error: 'buyer_role_not_verified' });
      return res.status(403).json({ error: 'buyer_subject_required' });
    }
    if (result.notFound) return res.status(404).json({ error: 'auction_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'auction_not_open', current_status: result.wrongStatus });
    if (result.incompleteTiers) return res.status(400).json({ error: 'must_bid_all_tiers', required_tier_ids: result.requiredTierIds });
    if (result.invalidPrice) return res.status(400).json({ error: 'invalid_price' });
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

// ============================================================
// Farmer selects the winning buyer (no auto-award — see design note 1)
// ============================================================

router.get('/auctions/:id/ranked-buyers', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'farmer') return res.status(403).json({ error: 'farmer_subject_required' });
  const { id } = req.params;
  try {
    const result = await withSessionContext('farmer', subject.subjectId, async (client) => {
      const ownRes = await client.query(
        `SELECT a.auction_id, a.status FROM procurement.auction a
           JOIN aquaculture.shrimp_auction sa ON sa.auction_id = a.auction_id
          WHERE a.auction_id = $1 AND sa.farmer_id = $2 AND a.auction_mode = 'forward'`,
        [id, subject.subjectId],
      );
      if (ownRes.rows.length === 0) return { notFound: true };
      const auction = await ensureForwardAuctionClosed(client, ownRes.rows[0]);
      if (auction.status !== 'closed') return { wrongStatus: auction.status };

      const { rows: bids } = await client.query(
        `SELECT b.bid_id, b.bidder_org_id, o.org_name, b.submitted_at,
                json_agg(json_build_object('tier_id', bt.tier_id, 'tier_label', ast.tier_label, 'price', bt.price) ORDER BY ast.display_order) AS prices,
                AVG(bt.price) AS avg_price
           FROM procurement.auction_bid b
           JOIN identity.organization o ON o.org_id = b.bidder_org_id
           JOIN procurement.auction_bid_tier bt ON bt.bid_id = b.bid_id
           JOIN aquaculture.auction_size_tier ast ON ast.tier_id = bt.tier_id
          WHERE b.auction_id = $1
          GROUP BY b.bid_id, b.bidder_org_id, o.org_name, b.submitted_at
          ORDER BY avg_price DESC`,
        [id],
      );
      return { bids };
    });
    if (result.notFound) return res.status(404).json({ error: 'auction_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'auction_not_closed', current_status: result.wrongStatus });
    return res.json(result.bids);
  } catch (err) {
    return next(err);
  }
});

router.post('/auctions/:id/select-buyer', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'farmer') return res.status(403).json({ error: 'farmer_subject_required' });
  const { id } = req.params;
  const { bid_id: bidId } = req.body || {};
  if (!bidId) return res.status(400).json({ error: 'bid_id_required' });

  try {
    const result = await withSessionContext('farmer', subject.subjectId, async (client) => {
      const ownRes = await client.query(
        `SELECT a.auction_id, a.status FROM procurement.auction a
           JOIN aquaculture.shrimp_auction sa ON sa.auction_id = a.auction_id
          WHERE a.auction_id = $1 AND sa.farmer_id = $2 AND a.auction_mode = 'forward'`,
        [id, subject.subjectId],
      );
      if (ownRes.rows.length === 0) return { notFound: true };
      const auction = await ensureForwardAuctionClosed(client, ownRes.rows[0]);
      if (auction.status !== 'closed') return { wrongStatus: auction.status };

      const bidRes = await client.query(
        'SELECT bid_id FROM procurement.auction_bid WHERE bid_id = $1 AND auction_id = $2',
        [bidId, id],
      );
      if (bidRes.rows.length === 0) return { bidNotFound: true };

      const { rows } = await client.query(
        `UPDATE procurement.auction SET status = 'awarded', winning_bid_id = $2, closed_at = COALESCE(closed_at, now())
          WHERE auction_id = $1
          RETURNING auction_id, status, winning_bid_id`,
        [id, bidId],
      );
      await logAccess(client, 'write', 'procurement.auction', id);
      return { auction: rows[0] };
    });
    if (result.notFound) return res.status(404).json({ error: 'auction_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'auction_not_closed', current_status: result.wrongStatus });
    if (result.bidNotFound) return res.status(404).json({ error: 'bid_not_found' });
    return res.json(result.auction);
  } catch (err) {
    return next(err);
  }
});

// ============================================================
// Final sampling -> settlement -> (offline) payment confirmation
// ============================================================

router.post('/auctions/:id/final-sampling', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'farmer') return res.status(403).json({ error: 'farmer_subject_required' });
  const { id } = req.params;
  const validated = validateSamplingPoints((req.body || {}).points);
  if (validated.error) return res.status(400).json({ error: validated.error });

  try {
    const result = await withSessionContext('farmer', subject.subjectId, async (client) => {
      const ownRes = await client.query(
        `SELECT a.auction_id, a.rfq_id, a.status, a.winning_bid_id, sa.unit_id
           FROM procurement.auction a
           JOIN aquaculture.shrimp_auction sa ON sa.auction_id = a.auction_id
          WHERE a.auction_id = $1 AND sa.farmer_id = $2 AND a.auction_mode = 'forward'`,
        [id, subject.subjectId],
      );
      if (ownRes.rows.length === 0) return { notFound: true };
      const auction = ownRes.rows[0];
      if (auction.status !== 'awarded') return { wrongStatus: auction.status };

      const existing = await client.query(
        'SELECT settlement_id FROM aquaculture.harvest_settlement WHERE auction_id = $1',
        [id],
      );
      if (existing.rows.length > 0) return { alreadySettled: true };

      const samplingEvent = await insertSamplingEvent(client, {
        unitId: auction.unit_id,
        purpose: 'final_harvest',
        points: validated.points,
        createdBySubjectType: 'farmer',
        createdBySubjectId: subject.subjectId,
      });
      const finalSize = Number(samplingEvent.computed_size_per_kg);

      const tiersRes = await client.query(
        `SELECT tier_id, tier_label, size_per_kg_min, size_per_kg_max
           FROM aquaculture.auction_size_tier WHERE rfq_id = $1 ORDER BY display_order`,
        [auction.rfq_id],
      );
      const tiers = tiersRes.rows;

      // Option A (nearest tier) with a threshold: if final size falls
      // outside every tier's range, use the tier whose boundary is
      // closest, but flag requires_renegotiation when that gap exceeds
      // one tier's typical width (~4 count/kg) — see
      // SHRIMP_AUCTION_ARCHITECTURE.md section 8.1.
      let matchedTier = tiers.find((t) => finalSize >= Number(t.size_per_kg_min) && finalSize <= Number(t.size_per_kg_max));
      let requiresRenegotiation = false;
      if (!matchedTier) {
        let bestGap = Infinity;
        for (const t of tiers) {
          const gap = finalSize < Number(t.size_per_kg_min)
            ? Number(t.size_per_kg_min) - finalSize
            : finalSize - Number(t.size_per_kg_max);
          if (gap < bestGap) {
            bestGap = gap;
            matchedTier = t;
          }
        }
        requiresRenegotiation = bestGap > 4;
      }

      const priceRes = await client.query(
        `SELECT price FROM procurement.auction_bid_tier WHERE bid_id = $1 AND tier_id = $2`,
        [auction.winning_bid_id, matchedTier.tier_id],
      );
      const tierPrice = Number(priceRes.rows[0].price);

      const settlementRes = await client.query(
        `INSERT INTO aquaculture.harvest_settlement
           (auction_id, final_sampling_id, matched_tier_id, tier_price, requires_renegotiation)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING settlement_id, auction_id, matched_tier_id, tier_price, requires_renegotiation, payment_status`,
        [id, samplingEvent.sampling_id, matchedTier.tier_id, tierPrice, requiresRenegotiation],
      );
      await logAccess(client, 'write', 'aquaculture.harvest_settlement', settlementRes.rows[0].settlement_id);

      return {
        settlement: settlementRes.rows[0], matchedTierLabel: matchedTier.tier_label, finalSizePerKg: finalSize,
      };
    });

    if (result.notFound) return res.status(404).json({ error: 'auction_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'auction_not_awarded', current_status: result.wrongStatus });
    if (result.alreadySettled) return res.status(409).json({ error: 'already_settled' });
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

router.get('/auctions/:id/settlement', async (req, res, next) => {
  const subject = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext(subject.subjectType, subject.subjectId, async (client) => {
      const { rows } = await client.query(
        `SELECT hs.settlement_id, hs.auction_id, hs.tier_price, hs.requires_renegotiation,
                hs.actual_weight_kg, hs.final_amount, hs.payment_status, hs.paid_confirmed_at,
                ast.tier_label,
                se.computed_size_per_kg AS final_size_per_kg, se.confidence_score AS final_sampling_confidence
           FROM aquaculture.harvest_settlement hs
           JOIN aquaculture.auction_size_tier ast ON ast.tier_id = hs.matched_tier_id
           JOIN aquaculture.sampling_event se ON se.sampling_id = hs.final_sampling_id
           JOIN procurement.auction a ON a.auction_id = hs.auction_id
           JOIN aquaculture.shrimp_auction sa ON sa.auction_id = a.auction_id
          WHERE hs.auction_id = $1
            AND (
              (sa.farmer_id = $2 AND $3 = 'farmer')
              OR ($3 = 'organization' AND a.winning_bid_id IN (SELECT bid_id FROM procurement.auction_bid WHERE auction_id = a.auction_id AND bidder_org_id = $2))
            )`,
        [id, subject.subjectId, subject.subjectType],
      );
      return rows[0] || null;
    });
    if (!result) return res.status(404).json({ error: 'settlement_not_found' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post('/auctions/:id/settlement/weight', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'farmer') return res.status(403).json({ error: 'farmer_subject_required' });
  const { id } = req.params;
  const actualWeightKg = Number((req.body || {}).actual_weight_kg);
  if (!Number.isFinite(actualWeightKg) || actualWeightKg <= 0) return res.status(400).json({ error: 'invalid_actual_weight_kg' });

  try {
    const result = await withSessionContext('farmer', subject.subjectId, async (client) => {
      const ownRes = await client.query(
        `SELECT hs.settlement_id, hs.tier_price, hs.payment_status FROM aquaculture.harvest_settlement hs
           JOIN aquaculture.shrimp_auction sa ON sa.auction_id = hs.auction_id
          WHERE hs.auction_id = $1 AND sa.farmer_id = $2`,
        [id, subject.subjectId],
      );
      if (ownRes.rows.length === 0) return { notFound: true };
      if (ownRes.rows[0].payment_status === 'paid') return { alreadyPaid: true };
      const finalAmount = actualWeightKg * Number(ownRes.rows[0].tier_price);

      const { rows } = await client.query(
        `UPDATE aquaculture.harvest_settlement
            SET actual_weight_kg = $2, final_amount = $3, updated_at = now()
          WHERE auction_id = $1
          RETURNING settlement_id, actual_weight_kg, final_amount, payment_status`,
        [id, actualWeightKg, finalAmount],
      );
      return { settlement: rows[0] };
    });
    if (result.notFound) return res.status(404).json({ error: 'settlement_not_found' });
    if (result.alreadyPaid) return res.status(409).json({ error: 'already_paid_cannot_edit_weight' });
    return res.json(result.settlement);
  } catch (err) {
    return next(err);
  }
});

// Payment itself happens OFFLINE (see grant_shrimp_auction.sql design note
// 2 — this exact convention already governs every other farmer-as-seller
// flow in this codebase, e.g. marketplace fertilizer-mixing/machinery
// bookings). This endpoint only records that the farmer confirms money was
// received — it never moves any money.
router.post('/auctions/:id/confirm-payment', async (req, res, next) => {
  const subject = req.subject;
  if (subject.subjectType !== 'farmer') return res.status(403).json({ error: 'farmer_subject_required' });
  const { id } = req.params;
  try {
    const result = await withSessionContext('farmer', subject.subjectId, async (client) => {
      const ownRes = await client.query(
        `SELECT hs.settlement_id, hs.final_amount, hs.payment_status FROM aquaculture.harvest_settlement hs
           JOIN aquaculture.shrimp_auction sa ON sa.auction_id = hs.auction_id
          WHERE hs.auction_id = $1 AND sa.farmer_id = $2`,
        [id, subject.subjectId],
      );
      if (ownRes.rows.length === 0) return { notFound: true };
      if (ownRes.rows[0].final_amount === null) return { weightNotEntered: true };
      if (ownRes.rows[0].payment_status === 'paid') return { alreadyPaid: true };

      await client.query(
        `UPDATE aquaculture.harvest_settlement SET payment_status = 'paid', paid_confirmed_at = now(), updated_at = now()
          WHERE auction_id = $1`,
        [id],
      );
      const { rows } = await client.query(
        `UPDATE procurement.auction SET status = 'completed' WHERE auction_id = $1 RETURNING auction_id, status`,
        [id],
      );
      await logAccess(client, 'write', 'aquaculture.harvest_settlement', ownRes.rows[0].settlement_id);
      return { auction: rows[0] };
    });
    if (result.notFound) return res.status(404).json({ error: 'settlement_not_found' });
    if (result.weightNotEntered) return res.status(409).json({ error: 'actual_weight_not_entered_yet' });
    if (result.alreadyPaid) return res.status(409).json({ error: 'already_paid' });
    return res.json(result.auction);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
