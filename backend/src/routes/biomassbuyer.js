const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganizationOrStaff, resolveEffectiveOrgSubject } = require('../middleware/auth');

const router = express.Router();

// The 11 fixed biomass types the user named (10 originally, + 'biochar'
// added in the same conversation turn as a follow-up — kept in the order
// named). Single source of truth for this route file — the DB's own CHECK
// constraint (biomass.buyer_biomass_type, see grant_biomass_buyer_portal.
// sql) is the real enforcement; this list is just what validates a
// request body before it ever reaches the database, and what GET
// /biomassbuyer/dashboard echoes back so the frontend doesn't have to
// hardcode a second copy of the category list + Thai labels — same
// convention as PRODUCT_TYPES in routes/biomass.js.
const BIOMASS_TYPES = [
  { biomass_type: 'rice_straw', label_th: 'ฟางข้าว' },
  { biomass_type: 'sugarcane_leaf', label_th: 'ใบอ้อย' },
  { biomass_type: 'corn_cob', label_th: 'ซังข้าวโพด' },
  { biomass_type: 'palm_empty_bunch', label_th: 'ทะลายปาล์ม' },
  { biomass_type: 'eucalyptus_wood', label_th: 'ไม้ยูคา' },
  { biomass_type: 'mixed_wood', label_th: 'ไม้เบญจพรรณ' },
  { biomass_type: 'raw_rice_husk', label_th: 'แกลบดิบ' },
  { biomass_type: 'manure', label_th: 'ปุ๋ยคอก' },
  { biomass_type: 'compost', label_th: 'ปุ๋ยหมัก' },
  { biomass_type: 'sugarcane_filter_cake', label_th: 'ขี้เค็กอ้อย' },
  { biomass_type: 'biochar', label_th: 'ไบโอชาร์' },
];
const BIOMASS_TYPE_VALUES = BIOMASS_TYPES.map((p) => p.biomass_type);

// Every route in this file requires a valid organization JWT — OR a named
// cooperative staff login whose operational role covers this module (same
// shape as biomass.js — see that file's matching comment for the full
// reasoning: STAFF_ROLE_TO_BUSINESS_ROLES maps coop.admin/coop.manager to
// `null`, which already covers ANY business module including this new
// one, so no change was needed there for this portal either).
router.use(requireAuth, requireOrganizationOrStaff);

/**
 * Confirms the authenticated organization holds a Verified 'BiomassBuyer'
 * role, on top of entity-level KYB — copied near-verbatim from
 * requireBiomassProducerOrg in routes/biomass.js; see that function's own
 * doc comment for the full reasoning (entity KYB vs. per-role Verified
 * being two separate checks, staff resolution, etc.), not repeated here
 * to avoid drift between two copies of the same prose.
 */
async function requireBiomassBuyerOrg(req, res, next) {
  try {
    const resolved = await resolveEffectiveOrgSubject(req, res, ['BiomassBuyer']);
    if (!resolved) return;
    const { subjectId } = req.subject;
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const org = await client.query(
        'SELECT org_id, org_name, org_type, kyb_status, region_code, district_code FROM identity.organization WHERE org_id = $1',
        [subjectId],
      );
      if (org.rows.length === 0) return { orgMissing: true };
      const orgRow = org.rows[0];
      if (orgRow.kyb_status !== 'Verified') return { kybNotVerified: true, org: orgRow };

      const role = await client.query(
        `SELECT status FROM identity.organization_role WHERE org_id = $1 AND role_type = 'BiomassBuyer'`,
        [subjectId],
      );
      return { org: orgRow, roleStatus: role.rows[0] ? role.rows[0].status : null };
    });

    if (result.orgMissing) {
      return res.status(403).json({ error: 'biomassbuyer_subject_required' });
    }
    if (result.kybNotVerified) {
      return res.status(403).json({ error: 'kyb_not_verified', kyb_status: result.org.kyb_status, org_name: result.org.org_name });
    }
    if (result.roleStatus !== 'Verified') {
      return res.status(403).json({
        error: 'role_not_verified', role_type: 'BiomassBuyer', role_status: result.roleStatus, org_name: result.org.org_name,
      });
    }
    req.org = result.org;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(requireBiomassBuyerOrg);

/**
 * IMPORTANT: biomass.buyer_profile / biomass.buyer_biomass_type have NO
 * row-level security (see grant_biomass_buyer_portal.sql's closing
 * comment, copied from grant_biomass_producer_portal.sql's own) — every
 * query below MUST include an explicit `WHERE org_id = $1`. This is not
 * defense-in-depth here, it is the entire security boundary.
 */

/**
 * GET /biomassbuyer/dashboard — org info, the org's own registration
 * fields, and which of the 11 biomass types it has currently selected —
 * enough for the frontend to render the whole dashboard in one round
 * trip. Unlike GET /biomass/dashboard (the producer side), there is no
 * public-facing "card" concept here — this portal is a registration
 * program, not a directory listing — so no card_visible field.
 */
router.get('/dashboard', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const profile = await client.query(
        `SELECT company_name, address_detail, monthly_usage_note, usage_purpose, desired_spec, contact_phone, updated_at
           FROM biomass.buyer_profile WHERE org_id = $1`,
        [subjectId],
      );
      const types = await client.query(
        'SELECT biomass_type FROM biomass.buyer_biomass_type WHERE org_id = $1',
        [subjectId],
      );
      await logAccess(client, 'read', 'biomass.buyer_profile', subjectId);

      const selected = new Set(types.rows.map((r) => r.biomass_type));
      return {
        org_name: req.org.org_name,
        region_code: req.org.region_code,
        district_code: req.org.district_code,
        profile: profile.rows[0] || null,
        registration_complete: Boolean(profile.rows[0] && profile.rows[0].company_name),
        biomass_types: BIOMASS_TYPES.map((t) => ({ ...t, selected: selected.has(t.biomass_type) })),
      };
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /biomassbuyer/profile
 * Body: { company_name, address_detail?, monthly_usage_note?, usage_purpose?, desired_spec?, contact_phone? }
 *
 * Upserts the org's one registration row — ON CONFLICT (org_id) DO
 * UPDATE, same upsert-by-org_id shape as PUT /biomass/profile. company_
 * name is the one required field (everything else is optional detail
 * the buyer can fill in progressively), matching the user's own field
 * list where "ชื่อบริษัท" was named first.
 */
router.put('/profile', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    company_name: companyName, address_detail: addressDetail, monthly_usage_note: monthlyUsageNote,
    usage_purpose: usagePurpose, desired_spec: desiredSpec, contact_phone: contactPhone,
  } = req.body || {};

  if (!companyName || !String(companyName).trim()) {
    return res.status(400).json({ error: 'company_name_required' });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO biomass.buyer_profile
           (org_id, company_name, address_detail, monthly_usage_note, usage_purpose, desired_spec, contact_phone)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (org_id) DO UPDATE SET
           company_name = EXCLUDED.company_name,
           address_detail = EXCLUDED.address_detail,
           monthly_usage_note = EXCLUDED.monthly_usage_note,
           usage_purpose = EXCLUDED.usage_purpose,
           desired_spec = EXCLUDED.desired_spec,
           contact_phone = EXCLUDED.contact_phone,
           updated_at = now()
         RETURNING company_name, address_detail, monthly_usage_note, usage_purpose, desired_spec, contact_phone, updated_at`,
        [
          subjectId, String(companyName).trim(), addressDetail || null, monthlyUsageNote || null,
          usagePurpose || null, desiredSpec || null, contactPhone || null,
        ],
      );
      await logAccess(client, 'write', 'biomass.buyer_profile', subjectId);
      return rows[0];
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /biomassbuyer/biomass-types
 * Body: { biomass_types: string[] }
 *
 * Replaces the FULL set of selected types in one call (delete-then-insert
 * inside a transaction) — same shape as PUT /biomass/products, matches
 * the frontend's checkbox-grid UI (submit the whole current selection).
 * An empty array is valid.
 */
router.put('/biomass-types', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { biomass_types: biomassTypes } = req.body || {};

  if (!Array.isArray(biomassTypes)) {
    return res.status(400).json({ error: 'biomass_types_must_be_array' });
  }
  const invalid = biomassTypes.filter((t) => !BIOMASS_TYPE_VALUES.includes(t));
  if (invalid.length > 0) {
    return res.status(400).json({ error: 'invalid_biomass_type', invalid, valid: BIOMASS_TYPE_VALUES });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('DELETE FROM biomass.buyer_biomass_type WHERE org_id = $1', [subjectId]);
        const unique = [...new Set(biomassTypes)];
        for (const biomassType of unique) {
          await client.query(
            'INSERT INTO biomass.buyer_biomass_type (org_id, biomass_type) VALUES ($1, $2)',
            [subjectId, biomassType],
          );
        }
        await logAccess(client, 'write', 'biomass.buyer_biomass_type', subjectId);
        await client.query('COMMIT');
        return unique;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
    return res.json({
      biomass_types: BIOMASS_TYPES.map((t) => ({ ...t, selected: result.includes(t.biomass_type) })),
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
