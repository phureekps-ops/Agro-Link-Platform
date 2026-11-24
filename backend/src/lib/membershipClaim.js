/**
 * เกษตรกรแจ้งการเป็นสมาชิก/ลูกค้าของหน่วยงาน → หน่วยงานยืนยัน (backend/db/grant_membership_claim.sql).
 *
 * ใช้ร่วมกันโดย: POST /auth/register (แจ้งตอนสมัคร), /farmer/membership-claims (แจ้งภายหลัง),
 * /farmer360/membership-claims (หน่วยงานยืนยัน/ปฏิเสธ). client ที่รับเข้ามาต้องถูก scope แล้ว
 * และ farmerId/orgId ต้องเป็นของผู้เรียกเท่านั้น (ไม่มี RLS).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** หน่วยงานที่เกษตรกรแจ้งเป็นสมาชิก/ลูกค้าได้ (ต้องผ่าน KYB แล้ว) */
const MEMBERSHIP_ORG_TYPES = ['Cooperative', 'AgriCommunityEnterprise', 'VillageFund', 'FarmerAidFund', 'Bank', 'Lender'];
const MAX_AT_REGISTRATION = 5;

class ClaimError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.httpStatus = status;
    this.body = { error: code, ...(extra || {}) };
  }
}

const clean = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (s.length > max) throw new ClaimError(400, 'field_too_long', { max });
  return s;
};

const ORG_WHERE = `o.org_type = ANY($1) AND o.kyb_status = 'Verified'`;

/**
 * ค้นหาหน่วยงาน (ชื่อ + ประเภท + จังหวัดเท่านั้น) — ต้องมี q ≥ 2 ตัวอักษร หรือจังหวัด.
 * จังหวัดมี 2 ระบบรหัสในฐานข้อมูล: registry.province (เช่น NAKHON_RATCHASIMA ใช้ใน cooperative_profile)
 * และรหัส ISO (เช่น TH-30 ใช้ใน identity.organization.region_code / farmer.region_code) —
 * รับได้ทั้งรหัส (province) และชื่อจังหวัดภาษาไทย (province_name) แล้วจับคู่ทั้งสองแบบ
 */
async function searchOrganizations(c, { q, province, provinceName, type }) {
  const types = type && MEMBERSHIP_ORG_TYPES.includes(type) ? [type] : MEMBERSHIP_ORG_TYPES;
  const params = [types];
  const where = [ORG_WHERE];
  const text = q ? String(q).trim().slice(0, 60) : '';
  if (text.length >= 2) { params.push(`%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`); where.push(`o.org_name ILIKE $${params.length}`); }
  const prov = [];
  if (province) { params.push(String(province).slice(0, 40)); prov.push(`cp.province_code = $${params.length}`, `o.region_code = $${params.length}`); }
  if (provinceName) { params.push(String(provinceName).trim().slice(0, 60)); prov.push(`pv.province_name_th = $${params.length}`); }
  if (prov.length) where.push(`(${prov.join(' OR ')})`);
  if (params.length === 1) return [];
  return (await c.query(
    `SELECT o.org_id, o.org_name, o.org_type, pv.province_name_th, o.region_code
       FROM identity.organization o
       LEFT JOIN registry.cooperative_profile cp ON cp.org_id = o.org_id
       LEFT JOIN registry.province pv ON pv.province_code = cp.province_code
      WHERE ${where.join(' AND ')}
      ORDER BY (o.org_type = 'Cooperative') DESC, o.org_name LIMIT 30`, params,
  )).rows;
}

async function orgOrThrow(c, orgId) {
  if (!UUID_RE.test(String(orgId || ''))) throw new ClaimError(400, 'invalid_organization');
  const r = (await c.query(`SELECT o.org_id, o.org_name, o.org_type FROM identity.organization o WHERE o.org_id = $2 AND ${ORG_WHERE}`,
    [MEMBERSHIP_ORG_TYPES, orgId])).rows[0];
  if (!r) throw new ClaimError(400, 'invalid_organization');
  return r;
}

/** ตรวจหนึ่งคำแจ้ง { org_id, member_no?, farmer_note? } */
async function validateClaim(c, body) {
  const org = await orgOrThrow(c, body && body.org_id);
  return { org, member_no: clean(body.member_no, 40), farmer_note: clean(body.farmer_note, 300) };
}

/** ตรวจหลายคำแจ้งตอนสมัคร (ไม่เกิน 5 หน่วยงาน ไม่ซ้ำกัน) */
async function validateClaims(c, list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new ClaimError(400, 'invalid_memberships');
  if (list.length > MAX_AT_REGISTRATION) throw new ClaimError(400, 'too_many_memberships', { max: MAX_AT_REGISTRATION });
  const out = [];
  for (const item of list) {
    const v = await validateClaim(c, item || {}); // eslint-disable-line no-await-in-loop
    if (out.some((x) => x.org.org_id === v.org.org_id)) throw new ClaimError(400, 'duplicate_organization');
    out.push(v);
  }
  return out;
}

/** บันทึกคำแจ้ง (Pending) — เป็นสมาชิกอยู่แล้ว/มีคำแจ้งค้าง → 409 */
async function createClaim(c, farmerId, v, source) {
  const active = (await c.query(
    `SELECT 1 FROM identity.farmer_org_relationship WHERE farmer_id = $1 AND org_id = $2 AND status = 'active'`, [farmerId, v.org.org_id],
  )).rows.length;
  if (active) throw new ClaimError(409, 'already_member', { org_name: v.org.org_name });
  try {
    return (await c.query(
      `INSERT INTO identity.membership_claim (farmer_id, org_id, member_no, farmer_note, source)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [farmerId, v.org.org_id, v.member_no, v.farmer_note, source],
    )).rows[0];
  } catch (err) {
    if (err.code === '23505') throw new ClaimError(409, 'claim_pending', { org_name: v.org.org_name });
    throw err;
  }
}

/** หน่วยงานยืนยัน: เปิดความสัมพันธ์ (ประเภทตาม org_type ของหน่วยงาน) + เลขสมาชิก — ต้องอยู่ใน transaction */
async function approveClaim(c, orgId, claimId, memberNo, actor) {
  if (!UUID_RE.test(String(claimId || ''))) throw new ClaimError(404, 'claim_not_found');
  const claim = (await c.query(
    'SELECT * FROM identity.membership_claim WHERE claim_id = $1 AND org_id = $2 FOR UPDATE', [claimId, orgId],
  )).rows[0];
  if (!claim) throw new ClaimError(404, 'claim_not_found');
  if (claim.status !== 'Pending') throw new ClaimError(409, 'claim_already_decided', { status: claim.status });
  const no = memberNo === undefined || memberNo === '' ? claim.member_no : clean(memberNo, 40);
  const rel = (await c.query('SELECT * FROM identity.link_farmer_to_org($1, $2, $3, $4, $5)',
    [claim.farmer_id, orgId, 'organization', orgId, 'ยืนยันจากคำแจ้งของเกษตรกร'])).rows[0];
  await c.query('UPDATE identity.farmer_org_relationship SET member_no = $2, updated_at = now() WHERE relationship_id = $1', [rel.relationship_id, no]);
  return (await c.query(
    `UPDATE identity.membership_claim SET status = 'Approved', member_no = $2, decided_at = now(), decided_by = $3, relationship_id = $4
      WHERE claim_id = $1 RETURNING *`, [claim.claim_id, no, actor, rel.relationship_id],
  )).rows[0];
}

async function rejectClaim(c, orgId, claimId, reason, actor) {
  if (!UUID_RE.test(String(claimId || ''))) throw new ClaimError(404, 'claim_not_found');
  const why = clean(reason, 300);
  if (!why) throw new ClaimError(400, 'reason_required');
  const r = (await c.query(
    `UPDATE identity.membership_claim SET status = 'Rejected', reject_reason = $3, decided_at = now(), decided_by = $4
      WHERE claim_id = $1 AND org_id = $2 AND status = 'Pending' RETURNING *`, [claimId, orgId, why, actor],
  )).rows[0];
  if (!r) throw new ClaimError(404, 'claim_not_found_or_decided');
  return r;
}

/** ส่ง ClaimError เป็น JSON (คืน true) — อย่างอื่นให้ error handler กลางจัดการ */
function sendClaimError(res, err) {
  if (err instanceof ClaimError) { res.status(err.httpStatus).json(err.body); return true; }
  return false;
}

module.exports = {
  MEMBERSHIP_ORG_TYPES, ClaimError, searchOrganizations, validateClaim, validateClaims, createClaim, approveClaim, rejectClaim, sendClaimError,
};
