/**
 * GET /auth/my-portals — which portals the logged-in account can open, so
 * frontend/login.html can offer ONE login box and send each user straight to
 * their own portal(s) instead of showing every portal on the platform.
 *
 * This is navigation only. Every portal still enforces its own access rules
 * in its own route file (requireXOrg / resolveEffectiveOrgSubject /
 * requireGovernmentOfficer); listing a portal here grants nothing.
 *
 * Every portal's own api.js stores the same /auth/login response under its
 * own localStorage key, so `storage_key` tells login.html where to put the
 * session for each portal it offers.
 */
const express = require('express');

const { withSessionContext } = require('../db/pool');
const { requireAuth, STAFF_ROLE_TO_BUSINESS_ROLES } = require('../middleware/auth');

const PORTALS = {
  farmer: { name_th: 'เกษตรกร', desc_th: 'ข้อมูลแปลง คะแนนสินเชื่อ สัญญา และคำขอสินเชื่อ', icon: '🌾', url: 'dashboard.html', storage_key: 'agrolink_farmer_session' },
  coop: { name_th: 'สหกรณ์การเกษตร', desc_th: 'บริการสมาชิกสหกรณ์แบบครบวงจร', icon: '🤝', url: 'coop/dashboard.html', storage_key: 'agrolink_coop_session' },
  dairy: { name_th: 'สหกรณ์โคนม', desc_th: 'รับน้ำนม คุณภาพและราคา ฝูงโค ส่งโรงงาน รอบจ่ายสมาชิก', icon: '🐄', url: 'coop/dairy.html', storage_key: 'agrolink_coop_session' },
  buyer: { name_th: 'ผู้รับซื้อผลผลิตการเกษตร', desc_th: 'รับซื้อผลผลิต ประกาศราคา ประมูล', icon: '📦', url: 'buyer/dashboard.html', storage_key: 'agrolink_buyer_session' },
  lender: { name_th: 'ผู้ปล่อยกู้', desc_th: 'พิจารณาและติดตามสินเชื่อ', icon: '🏦', url: 'lender/dashboard.html', storage_key: 'agrolink_lender_session' },
  villagefund: { name_th: 'กองทุนหมู่บ้าน', desc_th: 'บริหารเงินกู้กองทุนหมู่บ้าน', icon: '💰', url: 'villagefund/dashboard.html', storage_key: 'agrolink_villagefund_session' },
  machinery: { name_th: 'เครื่องจักรกล', desc_th: 'รถไถ โดรน รถเกี่ยว และรถบรรทุก', icon: '🚜', url: 'machinery/dashboard.html', storage_key: 'agrolink_machinery_session' },
  logistics: { name_th: 'ผู้ให้บริการขนส่ง', desc_th: 'ขนส่งผลผลิต ปุ๋ย และชีวมวล', icon: '🚚', url: 'logistics/dashboard.html', storage_key: 'agrolink_logistics_session' },
  dryingyard: { name_th: 'ลานตาก/โกดังและไซโล', desc_th: 'บริการลานตากและเก็บผลผลิต', icon: '🌞', url: 'dryingyard/dashboard.html', storage_key: 'agrolink_dryingyard_session' },
  inputsupplier: { name_th: 'ผู้จำหน่ายปัจจัยการผลิต', desc_th: 'เมล็ดพันธุ์ ปุ๋ย และปัจจัยการผลิต', icon: '🌱', url: 'inputsupplier/dashboard.html', storage_key: 'agrolink_inputsupplier_session' },
  marketvenue: { name_th: 'ผู้ให้บริการพื้นที่ขายสินค้าเกษตร', desc_th: 'พื้นที่ซื้อขายและกระจายสินค้า', icon: '🏪', url: 'marketvenue/dashboard.html', storage_key: 'agrolink_marketvenue_session' },
  fertilizermixing: { name_th: 'ผสมปุ๋ยสั่งตัด', desc_th: 'บริการผสมปุ๋ยตามค่าวิเคราะห์ดิน', icon: '🧪', url: 'fertilizermixing/dashboard.html', storage_key: 'agrolink_fertilizermixing_session' },
  farmeraidfund: { name_th: 'กองทุนสงเคราะห์เกษตรกร', desc_th: 'สินเชื่อ เครื่องจักรกล ปัจจัยการผลิต รับซื้อผลผลิต', icon: '🤲', url: 'farmeraidfund/dashboard.html', storage_key: 'agrolink_farmeraidfund_session' },
  communityenterprise: { name_th: 'วิสาหกิจชุมชนด้านการเกษตร', desc_th: 'สินเชื่อ เครื่องจักรกล ปัจจัยการผลิต รับซื้อผลผลิต', icon: '🏘️', url: 'communityenterprise/dashboard.html', storage_key: 'agrolink_communityenterprise_session' },
  biomassproducer: { name_th: 'ผู้ผลิตสินค้าจากชีวมวล', desc_th: 'ฟางอัดก้อน/อัดเม็ด ยอดอ้อยอัดก้อน ไบโอชาร์', icon: '♻️', url: 'biomassproducer/dashboard.html', storage_key: 'agrolink_biomassproducer_session' },
  biomassbuyer: { name_th: 'ผู้รับซื้อชีวมวล', desc_th: 'ระบุชนิดชีวมวลและสเปคที่ต้องการ', icon: '🏭', url: 'biomassbuyer/dashboard.html', storage_key: 'agrolink_biomassbuyer_session' },
  dairypartner: { name_th: 'คู่ค้าโคนม', desc_th: 'โรงงานแปรรูปนม ตลาดนมส่วนเกิน ผู้ขายอาหารสัตว์ สัตวแพทย์', icon: '🥛', url: 'dairy-partner.html', storage_key: 'agrolink_dairy_partner_session' },
  gov: { name_th: 'เจ้าหน้าที่ภาครัฐ', desc_th: 'ติดตามข้อมูลระดับพื้นที่และนโยบาย', icon: '🏛️', url: 'gov/dashboard.html', storage_key: 'agrolink_gov_session' },
  oae: { name_th: 'สำนักงานเศรษฐกิจการเกษตร (สศก.)', desc_th: 'ข้อมูลเศรษฐกิจการเกษตรและราคาสินค้า', icon: '📊', url: 'oae/dashboard.html', storage_key: 'agrolink_oae_session' },
};

// business role (identity.organization_role.role_type, or org_type for the
// portals that check org_type) → portal keys
const ROLE_PORTALS = {
  Cooperative: ['coop', 'dairy'],
  Buyer: ['buyer'],
  Lender: ['lender'],
  VillageFund: ['villagefund'],
  MachineryService: ['machinery'], TractorService: ['machinery'], DroneService: ['machinery'], HarvesterService: ['machinery'], TruckService: ['machinery'],
  DryingYardService: ['dryingyard'],
  Logistics: ['logistics'],
  InputSupplier: ['inputsupplier'],
  MarketVenue: ['marketvenue'],
  FertilizerMixingService: ['fertilizermixing'],
  FarmerAidFund: ['farmeraidfund'],
  AgriCommunityEnterprise: ['communityenterprise'],
  BiomassProducer: ['biomassproducer'],
  BiomassBuyer: ['biomassbuyer'],
};
// portals whose backend accepts a staff (organization_member) login
const STAFF_PORTALS = {
  coop: 'Cooperative', dairy: 'Cooperative', lender: 'Lender', logistics: 'Logistics', machinery: null, dryingyard: 'DryingYardService',
  biomassproducer: 'BiomassProducer', biomassbuyer: 'BiomassBuyer',
};

const STATUS_RANK = { Verified: 2, Pending: 1, Rejected: 0 };

/** org's business roles → { portalKey: 'ready' | 'pending' } */
async function orgPortals(c, orgId) {
  const org = (await c.query('SELECT org_id, org_name, org_type, kyb_status FROM identity.organization WHERE org_id = $1', [orgId])).rows[0];
  if (!org) return { org: null, portals: {} };
  const roles = (await c.query('SELECT role_type, status FROM identity.organization_role WHERE org_id = $1', [orgId])).rows;
  // org_type itself counts as a role for the portals that check org_type
  // (fertilizer mixing, farmer aid fund, community enterprise)
  // and comes first, so a bundle org (กองทุนสงเคราะห์ / วิสาหกิจชุมชน) sees its own portal at the top
  const primary = roles.find((r) => r.role_type === org.org_type) || { role_type: org.org_type, status: org.kyb_status };
  roles.splice(roles.indexOf(primary) >= 0 ? roles.indexOf(primary) : 0, roles.indexOf(primary) >= 0 ? 1 : 0);
  roles.unshift(primary);
  const out = {};
  roles.forEach((r) => {
    if (r.status === 'Rejected') return;
    const ready = r.status === 'Verified' && org.kyb_status === 'Verified';
    (ROLE_PORTALS[r.role_type] || []).forEach((k) => {
      if (!out[k] || (ready && out[k] !== 'ready')) out[k] = ready ? 'ready' : 'pending';
    });
  });
  // dairy partner portal: any org a dairy cooperative has linked as a partner, or with a processor profile
  try {
    const dp = await c.query(
      `SELECT (EXISTS (SELECT 1 FROM dairy.partner WHERE linked_org_id = $1 AND active)
            OR EXISTS (SELECT 1 FROM dairy.processor_profile WHERE org_id = $1)) AS yes`, [orgId],
    );
    if (dp.rows[0].yes && org.kyb_status === 'Verified') out.dairypartner = 'ready';
  } catch (err) {
    if (err.code !== '42P01') throw err; // dairy schema not installed
  }
  return { org, portals: out };
}

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  const { subjectType, subjectId } = req.subject;
  try {
    const result = await withSessionContext(subjectType, subjectId, async (c) => {
      if (subjectType === 'farmer') {
        const f = (await c.query('SELECT full_name FROM identity.farmer WHERE farmer_id = $1', [subjectId])).rows[0];
        return { display_name: f ? f.full_name : null, portals: { farmer: 'ready' } };
      }
      if (subjectType === 'government_officer') {
        const g = (await c.query('SELECT full_name, department_code FROM identity.government_officer WHERE officer_id = $1 AND status = $2', [subjectId, 'Active'])).rows[0];
        if (!g) return { display_name: null, portals: {} };
        return { display_name: g.full_name, portals: g.department_code === 'OAE' ? { oae: 'ready' } : { gov: 'ready' } };
      }
      if (subjectType === 'organization') {
        const { org, portals } = await orgPortals(c, subjectId);
        return { display_name: org ? org.org_name : null, kyb_status: org ? org.kyb_status : null, portals };
      }
      if (subjectType === 'organization_member') {
        const m = (await c.query(
          `SELECT m.org_id, m.full_name, m.status, sr.role_code FROM identity.organization_member m
             LEFT JOIN identity.subject_role sr ON sr.subject_type = 'organization_member' AND sr.subject_id = m.member_id
            WHERE m.member_id = $1`, [subjectId],
        )).rows[0];
        if (!m || m.status !== 'Active') return { display_name: null, portals: {} };
        const allowed = STAFF_ROLE_TO_BUSINESS_ROLES[m.role_code];
        const { org, portals } = await orgPortals(c, m.org_id);
        const staffPortals = {};
        Object.entries(portals).forEach(([k, st]) => {
          if (!(k in STAFF_PORTALS)) return;
          const need = STAFF_PORTALS[k];
          const ok = allowed === null || (Array.isArray(allowed) && (need === null
            ? allowed.some((r) => (ROLE_PORTALS[r] || []).includes(k))
            : allowed.includes(need)));
          if (ok) staffPortals[k] = st;
        });
        return { display_name: m.full_name, org_name: org ? org.org_name : null, portals: staffPortals };
      }
      return { display_name: null, portals: {} };
    });
    const portals = Object.entries(result.portals)
      .sort((a, b) => STATUS_RANK[b[1] === 'ready' ? 'Verified' : 'Pending'] - STATUS_RANK[a[1] === 'ready' ? 'Verified' : 'Pending'])
      .map(([key, status]) => ({ key, status, ...PORTALS[key] }));
    return res.json({ subject_type: subjectType, display_name: result.display_name, org_name: result.org_name || null, kyb_status: result.kyb_status || null, portals });
  } catch (err) {
    return next(err);
  }
});

module.exports = { router, PORTALS, ROLE_PORTALS, orgPortals };
