/**
 * ตลาดสินเชื่อระหว่างสหกรณ์ (Cooperative Lending Marketplace) — backend/db/grant_coop_lending_marketplace.sql
 *
 * ผูกเข้ากับ router ของ routes/coopLending.js (ใช้ guard และ helper ชุดเดียวกัน):
 *   /coop-lending/market/*        สหกรณ์การเกษตร (ผู้ขอกู้): ข้อมูลสหกรณ์ โครงการขอกู้ ตอบคำถาม เปรียบเทียบ/โต้ตอบ/รับข้อเสนอ จับคู่ ลงนาม รายงานผล
 *   /savings/market/*             สหกรณ์ออมทรัพย์ / เครดิตยูเนี่ยน (ผู้ให้กู้): ข้อมูลและนโยบายสินเชื่อ ค้นหาโครงการ ถาม ยื่น/แก้/ถอนข้อเสนอ ยืนยันตามอำนาจอนุมัติ ลงนาม
 *   /admin/coop-lending/market/*  ผู้ดูแลแพลตฟอร์ม: ตรวจความครบถ้วนก่อนประกาศ
 *   /gov/coop-lending/market      กรมส่งเสริมสหกรณ์: ตัวชี้วัดตลาด (อ่านอย่างเดียว ตามขอบเขตจังหวัด)
 *
 * หลังลงนามครบทุกฝ่าย ระบบเปิดวงเงิน (coop_lending.facility) ให้ผู้ให้กู้แต่ละราย แล้วการเบิกจ่าย/โอน/ชำระคืนใช้ระบบเดิม
 * AgroLink เป็นผู้ให้บริการระบบ ไม่ใช่ผู้ให้กู้ ไม่ถือเงินของคู่สัญญา
 */
const crypto = require('crypto');
const M = require('../lib/coopMarket');
const L = require('../lib/coopLending');
const { buildAgreementDocx } = require('../lib/coopAgreementDoc');

const LIVE_OFFER = ['Submitted', 'Countered', 'Accepted', 'Confirmed'];
const VISIBLE_TO_LENDERS = ['Listed', 'Offered'];
const DOC_KINDS = ['resolution', 'financial_statement', 'business_plan', 'quotation', 'member_list', 'production_plan', 'buyer_contract', 'collateral', 'other'];
const GOV_GRADES = ['excellent', 'very_good', 'good', 'pass', 'fail'];
const AUDIT = ['unqualified', 'qualified', 'adverse', 'disclaimer'];
const DEBT_ST = ['current', 'late', 'restructured', 'default'];

function attach({ savings, borrower, admin, gov }, H) {
  const {
    wrap, fail, tx, orgTx, num, text, isUuid, actorOf, verifiedAccount, logAccess, objectStorage, govTx, officerScope,
  } = H;
  const today = () => L.todayBangkok();
  const ds = (v) => (v ? L.toDateStr(v) : null);

  // ---------------------------------------------------------------- ตัวช่วย
  const nOrNull = (v, name, o = {}) => num(v, name, { allowNull: true, ...o });
  const arr = (v, max = 50) => (Array.isArray(v) ? v.slice(0, max) : []);
  const strs = (v, max = 40) => arr(v, max).map((x) => String(x).trim().slice(0, 60)).filter(Boolean);
  function cleanFinancials(v) {
    return arr(v, 5).map((f) => ({
      year: parseInt(f.year, 10) || null,
      ...Object.fromEntries(['total_assets', 'total_liabilities', 'equity', 'share_capital', 'reserve', 'deposits', 'loans', 'investments', 'current_assets', 'current_liabilities', 'revenue', 'net_income']
        .map((k) => [k, f[k] === undefined || f[k] === '' || f[k] === null ? null : num(f[k], k, { min: -1e13 })])),
      ...(f.audit_opinion !== undefined ? { audit_opinion: AUDIT.includes(f.audit_opinion) ? f.audit_opinion : null } : {}),
      ...(f.audited !== undefined ? { audited: f.audited === true } : {}),
    })).filter((f) => f.year && f.year >= 2500 && f.year <= 2700);
  }
  async function fileOwnedBy(c, fileId, orgId) {
    if (!isUuid(fileId)) fail(400, 'file_required');
    const f = (await c.query(
      `SELECT fo.* FROM storage.file_object fo WHERE fo.file_id = $1 AND ((fo.owner_subject_type = 'organization' AND fo.owner_subject_id = $2)
          OR (fo.owner_subject_type = 'organization_member' AND fo.owner_subject_id IN (SELECT member_id FROM identity.organization_member WHERE org_id = $2)))`, [fileId, orgId],
    )).rows[0];
    if (!f) fail(404, 'file_not_found');
    return f;
  }
  async function sendFile(res, c, fileId) {
    const f = (await c.query('SELECT storage_path, content_type, original_filename FROM storage.file_object WHERE file_id = $1', [fileId])).rows[0];
    if (!f) fail(404, 'file_not_found');
    res.setHeader('Content-Type', f.content_type);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.original_filename)}"`);
    res.send(await objectStorage.readFile(f.storage_path));
  }
  async function notify(c, orgId, kind, message, listingId) {
    await c.query(`INSERT INTO coop_lending.dunning_notice (target_org_id, kind, notice_date, message, listing_id) VALUES ($1,$2,$3,$4,$5)`,
      [orgId, kind, today(), message.slice(0, 1000), listingId || null]);
  }
  async function history(c, orgId) {
    return (await c.query(
      `SELECT (SELECT COUNT(*) FROM coop_lending.facility WHERE borrower_org_id = $1)::int AS facilities,
              (SELECT COUNT(*) FROM coop_lending.disbursement_item WHERE borrower_org_id = $1 AND principal_outstanding > 0 AND loan_due_date < $2)::int AS overdue_now,
              (SELECT COUNT(*) FROM coop_lending.dunning_notice WHERE target_org_id = $1 AND kind IN ('tranche_overdue','installment_overdue','facility_suspended'))::int AS late_events`,
      [orgId, today()],
    )).rows[0];
  }
  async function borrowerProfile(c, orgId) {
    return (await c.query('SELECT * FROM coop_lending.borrower_profile WHERE org_id = $1', [orgId])).rows[0] || null;
  }
  async function scoreFor(c, orgId) {
    const p = await borrowerProfile(c, orgId);
    return { profile: p, score: M.creditScore(p || {}, await history(c, orgId)) };
  }
  async function lenderProfile(c, orgId) {
    return (await c.query('SELECT * FROM coop_lending.lender_profile WHERE org_id = $1', [orgId])).rows[0] || null;
  }
  async function listingFor(c, id, where, params, lock = false) {
    if (!isUuid(id)) fail(404, 'listing_not_found');
    const r = (await c.query(`SELECT * FROM coop_lending.loan_listing l WHERE l.listing_id = $1 AND ${where} ${lock ? 'FOR UPDATE' : ''}`, [id, ...params])).rows[0];
    if (!r) fail(404, 'listing_not_found');
    return r;
  }
  const listingOut = (l) => ({ ...l, offers_close_on: ds(l.offers_close_on), type_name_th: (M.PROJECT_TYPES[l.project_type] || {}).name_th });
  async function documents(c, listingId) {
    return (await c.query('SELECT doc_id, kind, title, file_id, created_at FROM coop_lending.listing_document WHERE listing_id = $1 ORDER BY created_at', [listingId])).rows;
  }
  async function questions(c, listingId, viewerLender) {
    return (await c.query(
      `SELECT question_id, kind, question, answer, answer_file_id IS NOT NULL AS has_answer_file, answered_at, created_at, lender_org_id = $2 AS mine
         FROM coop_lending.listing_question WHERE listing_id = $1 ORDER BY created_at`, [listingId, viewerLender || '00000000-0000-0000-0000-000000000000'],
    )).rows;
  }
  async function offersOf(c, listingId) {
    return (await c.query(
      `SELECT o.*, org.org_name AS lender_name, org.org_type AS lender_type, lp.province_code AS lender_province,
              (SELECT COUNT(*) FROM coop_lending.facility f WHERE f.lender_org_id = o.lender_org_id)::int AS lender_facilities
         FROM coop_lending.loan_offer o JOIN identity.organization org ON org.org_id = o.lender_org_id
         LEFT JOIN coop_lending.lender_profile lp ON lp.org_id = o.lender_org_id
        WHERE o.listing_id = $1 ORDER BY (o.status IN ('Submitted','Countered','Accepted','Confirmed')) DESC, o.rate_pct, o.created_at`, [listingId],
    )).rows.map((o) => ({ ...o, valid_until: ds(o.valid_until), total_interest: totalInterest(o) }));
  }
  function totalInterest(o) {
    try { return L.round2(M.repaymentSchedule(o, '2027-01-01').reduce((a, r) => a + r.interest, 0)); } catch (e) { return null; }
  }
  async function agreementOf(c, listingId) {
    const a = (await c.query('SELECT * FROM coop_lending.loan_agreement WHERE listing_id = $1', [listingId])).rows[0];
    if (!a) return null;
    const parties = (await c.query(
      `SELECT al.*, o.org_name FROM coop_lending.agreement_lender al JOIN identity.organization o ON o.org_id = al.lender_org_id WHERE al.agreement_id = $1 ORDER BY al.amount DESC`, [a.agreement_id],
    )).rows.map((x) => ({ ...x, signed: Boolean(x.signed_file_id), signed_file_id: undefined }));
    return { ...a, borrower_signed: Boolean(a.borrower_signed_file_id), borrower_signed_file_id: undefined, start_date: ds(a.start_date), parties };
  }
  async function exposure(c, lenderOrgId, listing) {
    const q = async (extra, params) => Number((await c.query(
      `SELECT COALESCE((SELECT SUM(f.limit_amount) FROM coop_lending.facility f LEFT JOIN coop_lending.loan_listing ll ON ll.listing_id = f.listing_id
                         LEFT JOIN registry.cooperative_profile cp ON cp.org_id = f.borrower_org_id
                         WHERE f.lender_org_id = $1 AND f.status <> 'Closed' ${extra.f}), 0)
            + COALESCE((SELECT SUM(o.amount) FROM coop_lending.loan_offer o JOIN coop_lending.loan_listing ll ON ll.listing_id = o.listing_id
                         WHERE o.lender_org_id = $1 AND o.status IN ('Submitted','Countered','Accepted','Confirmed') AND o.listing_id <> $2 ${extra.o}), 0) AS v`,
      [lenderOrgId, listing.listing_id, ...params],
    )).rows[0].v);
    return {
      total: await q({ f: '', o: '' }, []),
      borrower: await q({ f: 'AND f.borrower_org_id = $3', o: 'AND ll.borrower_org_id = $3' }, [listing.borrower_org_id]),
      province: listing.province_code ? await q({ f: 'AND COALESCE(ll.province_code, cp.province_code) = $3', o: 'AND ll.province_code = $3' }, [listing.province_code]) : 0,
      type: await q({ f: 'AND ll.project_type = $3', o: 'AND ll.project_type = $3' }, [listing.project_type]),
    };
  }

  // ======================================================================
  // ผู้ขอกู้ (สหกรณ์การเกษตร)
  // ======================================================================
  borrower.get('/market/profile', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => {
      const s = await scoreFor(c, req.org.org_id);
      const cp = (await c.query('SELECT cp.*, pv.province_name_th FROM registry.cooperative_profile cp LEFT JOIN registry.province pv ON pv.province_code = cp.province_code WHERE cp.org_id = $1', [req.org.org_id])).rows[0] || null;
      const plots = (await c.query(
        `SELECT COUNT(DISTINCT r.farmer_id)::int AS members_on_platform, COUNT(pu.unit_id)::int AS plots, COALESCE(SUM(pu.area_rai), 0)::numeric AS area_rai
           FROM identity.farmer_org_relationship r LEFT JOIN registry.production_unit pu ON pu.owner_farmer_id = r.farmer_id WHERE r.org_id = $1 AND r.status = 'active'`, [req.org.org_id],
      )).rows[0];
      return { org: req.org, registry: cp, platform: { ...plots, area_rai: Number(plots.area_rai) }, profile: s.profile, score: s.score };
    }));
  }));
  borrower.put('/market/profile', wrap(async (req, res) => {
    const b = req.body || {};
    const out = await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      const gov0 = b.governance || {};
      const v = {
        coop_kind: ['agriculture', 'settlement', 'fisheries'].includes(b.coop_kind) ? b.coop_kind : 'agriculture',
        registration_no: text(b.registration_no, 'registration_no', { max: 60, allowNull: true }),
        established_year: b.established_year ? parseInt(b.established_year, 10) : null,
        member_count: b.member_count === '' || b.member_count == null ? null : parseInt(b.member_count, 10),
        board: text(b.board, 'board', { max: 2000, allowNull: true }),
        signatories: text(b.signatories, 'signatories', { max: 500, allowNull: true }),
        financials: JSON.stringify(cleanFinancials(b.financials)),
        businesses: JSON.stringify(Object.fromEntries(['credit', 'supply', 'collection', 'processing', 'service'].map((k) => [k, {
          volume: text((b.businesses || {})[k] && b.businesses[k].volume, `${k}_volume`, { max: 200, allowNull: true }),
          value: nOrNull((b.businesses || {})[k] && b.businesses[k].value, `${k}_value`),
        }]))),
        debts: JSON.stringify(arr(b.debts, 30).map((d) => ({ creditor: text(d.creditor, 'creditor', { min: 2, max: 160 }), outstanding: nOrNull(d.outstanding, 'outstanding'), status: DEBT_ST.includes(d.status) ? d.status : 'current' }))),
        assets: JSON.stringify(arr(b.assets, 50).map((a) => ({ kind: text(a.kind, 'asset_kind', { min: 2, max: 80 }), description: text(a.description, 'asset_description', { max: 300, allowNull: true }), value: nOrNull(a.value, 'asset_value'), pledged: a.pledged === true }))),
        governance: JSON.stringify({ standard_grade: GOV_GRADES.includes(gov0.standard_grade) ? gov0.standard_grade : null, audit_findings: text(gov0.audit_findings, 'audit_findings', { max: 2000, allowNull: true }), unresolved_issues: text(gov0.unresolved_issues, 'unresolved_issues', { max: 2000, allowNull: true }) }),
        consent_disclose: b.consent_disclose === true,
        data_as_of: L.isDate(b.data_as_of) ? b.data_as_of : today(),
      };
      if (v.member_count !== null && !(v.member_count >= 0)) fail(400, 'invalid_number', { field: 'member_count' });
      const r = (await c.query(
        `INSERT INTO coop_lending.borrower_profile (org_id, coop_kind, registration_no, established_year, member_count, board, signatories, financials, businesses, debts, assets, governance,
                consent_disclose, consent_at, data_as_of, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $13 THEN now() END, $14, $15)
         ON CONFLICT (org_id) DO UPDATE SET coop_kind = EXCLUDED.coop_kind, registration_no = EXCLUDED.registration_no, established_year = EXCLUDED.established_year,
           member_count = EXCLUDED.member_count, board = EXCLUDED.board, signatories = EXCLUDED.signatories, financials = EXCLUDED.financials, businesses = EXCLUDED.businesses,
           debts = EXCLUDED.debts, assets = EXCLUDED.assets, governance = EXCLUDED.governance, consent_disclose = EXCLUDED.consent_disclose,
           consent_at = CASE WHEN EXCLUDED.consent_disclose AND NOT coop_lending.borrower_profile.consent_disclose THEN now() WHEN EXCLUDED.consent_disclose THEN coop_lending.borrower_profile.consent_at END,
           data_as_of = EXCLUDED.data_as_of, updated_at = now(), updated_by = EXCLUDED.updated_by
         RETURNING *`,
        [req.org.org_id, v.coop_kind, v.registration_no, v.established_year, v.member_count, v.board, v.signatories, v.financials, v.businesses, v.debts, v.assets, v.governance,
          v.consent_disclose, v.data_as_of, actor.key],
      )).rows[0];
      return { profile: r, score: M.creditScore(r, await history(c, req.org.org_id)) };
    });
    res.json(out);
  }));
  /** ทะเบียนผู้ให้กู้: ให้ผู้ขอกู้รู้นโยบายสินเชื่อของแต่ละราย */
  borrower.get('/market/lenders', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => (await c.query(
      `SELECT o.org_id, o.org_name, o.org_type, lp.province_code, pv.province_name_th, lp.member_count, lp.policy, lp.data_as_of,
              (SELECT COUNT(*) FROM coop_lending.facility f WHERE f.lender_org_id = o.org_id)::int AS facilities
         FROM identity.organization o JOIN coop_lending.lender_profile lp ON lp.org_id = o.org_id LEFT JOIN registry.province pv ON pv.province_code = lp.province_code
        WHERE o.org_type IN ('SavingsCooperative','CreditUnion') AND o.kyb_status = 'Verified' ORDER BY o.org_name`,
    )).rows));
  }));

  function listingBody(b, partial) {
    const v = {};
    const set = (k, val) => { if (!partial || b[k] !== undefined) v[k] = val(); };
    set('project_type', () => (M.PROJECT_TYPES[b.project_type] ? b.project_type : fail(400, 'invalid_project_type')));
    set('title', () => text(b.title, 'title', { min: 5, max: 200 }));
    set('objective', () => text(b.objective, 'objective', { max: 3000, allowNull: true }));
    set('amount_requested', () => num(b.amount_requested, 'amount_requested', { min: 10000 }));
    set('min_amount', () => nOrNull(b.min_amount, 'min_amount', { min: 1000 }));
    set('tenor_months', () => { const t = parseInt(b.tenor_months, 10); if (!(t >= 1 && t <= 180)) fail(400, 'invalid_number', { field: 'tenor_months' }); return t; });
    set('grace_months', () => { const t = parseInt(b.grace_months || 0, 10); if (!(t >= 0 && t <= 60)) fail(400, 'invalid_number', { field: 'grace_months' }); return t; });
    set('use_plan', () => JSON.stringify(arr(b.use_plan, 40).map((u) => ({ item: text(u.item, 'use_item', { min: 2, max: 200 }), amount: num(u.amount, 'use_amount', { min: 0 }), timing: text(u.timing, 'use_timing', { max: 100, allowNull: true }) }))));
    set('repayment_plan', () => text(b.repayment_plan, 'repayment_plan', { max: 3000, allowNull: true }));
    set('repayment_source', () => text(b.repayment_source, 'repayment_source', { max: 1000, allowNull: true }));
    set('collateral', () => JSON.stringify(arr(b.collateral, 20).map((x) => ({ kind: text(x.kind, 'collateral_kind', { min: 2, max: 80 }), description: text(x.description, 'collateral_description', { max: 400, allowNull: true }), value: nOrNull(x.value, 'collateral_value') }))));
    set('province_code', () => text(b.province_code, 'province_code', { max: 40, allowNull: true }));
    set('commodities', () => strs(b.commodities, 10));
    set('details', () => {
      const d = b.details || {};
      const t = b.project_type;
      const o = {};
      const nn = (k) => { if (d[k] !== undefined && d[k] !== '') o[k] = num(d[k], k, { min: 0 }); };
      const tt = (k, max = 3000) => { if (d[k] !== undefined) o[k] = text(d[k], k, { max, allowNull: true }); };
      if (t === 'member_onlending' || partial) { nn('members_count'); nn('per_member_limit'); nn('member_repayment_pct'); nn('plots_count'); nn('area_rai'); tt('production_plan'); }
      if (t === 'procurement' || partial) { tt('commodity', 80); nn('volume_t'); nn('reference_price'); tt('end_buyers', 1000); tt('history', 2000); ['period_from', 'period_to'].forEach((k) => { if (d[k] !== undefined) o[k] = L.isDate(d[k]) ? d[k] : null; }); }
      if (t === 'investment' || partial) {
        tt('business_plan', 6000); tt('vendor', 200); nn('quotation_total'); nn('payback_years');
        if (d.projections !== undefined) o.projections = arr(d.projections, 15).map((p) => ({ year: text(p.year, 'proj_year', { max: 20 }), revenue: nOrNull(p.revenue, 'proj_revenue', { min: -1e13 }), cost: nOrNull(p.cost, 'proj_cost', { min: -1e13 }), net_cash: nOrNull(p.net_cash, 'proj_net_cash', { min: -1e13 }) }));
      }
      return JSON.stringify(o);
    });
    return v;
  }
  borrower.get('/market/listings', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => (await c.query(
      `SELECT l.*, (SELECT COUNT(*) FROM coop_lending.loan_offer o WHERE o.listing_id = l.listing_id AND o.status IN ('Submitted','Countered','Accepted','Confirmed'))::int AS live_offers,
              (SELECT COALESCE(SUM(o.amount), 0) FROM coop_lending.loan_offer o WHERE o.listing_id = l.listing_id AND o.status = 'Confirmed')::numeric AS confirmed_amount,
              (SELECT COUNT(*) FROM coop_lending.listing_question q WHERE q.listing_id = l.listing_id AND q.answer IS NULL)::int AS open_questions
         FROM coop_lending.loan_listing l WHERE l.borrower_org_id = $1 ORDER BY l.created_at DESC`, [req.org.org_id],
    )).rows.map(listingOut)));
  }));
  borrower.post('/market/listings', wrap(async (req, res) => {
    const v = listingBody(req.body || {}, false);
    const out = await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      if (!v.province_code) v.province_code = ((await c.query('SELECT province_code FROM registry.cooperative_profile WHERE org_id = $1', [req.org.org_id])).rows[0] || {}).province_code || null;
      const keys = Object.keys(v);
      return (await c.query(
        `INSERT INTO coop_lending.loan_listing (borrower_org_id, created_by, ${keys.join(', ')}) VALUES ($1, $2, ${keys.map((k, i) => `$${i + 3}`).join(', ')}) RETURNING *`,
        [req.org.org_id, actor.key, ...keys.map((k) => v[k])],
      )).rows[0];
    });
    res.status(201).json(listingOut(out));
  }));
  borrower.patch('/market/listings/:id', wrap(async (req, res) => {
    const b = req.body || {};
    res.json(await orgTx(req, async (c) => {
      const l = await listingFor(c, req.params.id, 'l.borrower_org_id = $2', [req.org.org_id], true);
      if (!['Draft', 'Returned'].includes(l.status)) fail(409, 'listing_not_editable', { status: l.status });
      const v = listingBody({ ...b, project_type: b.project_type || l.project_type }, true);
      if (b.resolution_file_id !== undefined) v.resolution_file_id = b.resolution_file_id ? (await fileOwnedBy(c, b.resolution_file_id, req.org.org_id)).file_id : null;
      const keys = Object.keys(v);
      if (!keys.length) return listingOut(l);
      const r = (await c.query(
        `UPDATE coop_lending.loan_listing SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, certified_at = NULL, certified_by = NULL, updated_at = now() WHERE listing_id = $1 RETURNING *`,
        [l.listing_id, ...keys.map((k) => v[k])],
      )).rows[0];
      if (r.min_amount && Number(r.min_amount) > Number(r.amount_requested)) fail(400, 'min_amount_over_requested');
      return listingOut(r);
    }));
  }));
  borrower.post('/market/listings/:id/documents', wrap(async (req, res) => {
    const b = req.body || {};
    if (!DOC_KINDS.includes(b.kind)) fail(400, 'invalid_document_kind');
    const out = await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      const l = await listingFor(c, req.params.id, 'l.borrower_org_id = $2', [req.org.org_id]);
      if (['Matched', 'Signed', 'Closed', 'Withdrawn'].includes(l.status)) fail(409, 'listing_not_editable', { status: l.status });
      const f = await fileOwnedBy(c, b.file_id, req.org.org_id);
      return (await c.query(`INSERT INTO coop_lending.listing_document (listing_id, kind, title, file_id, uploaded_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [l.listing_id, b.kind, text(b.title, 'title', { min: 2, max: 200 }), f.file_id, actor.key])).rows[0];
    });
    res.status(201).json(out);
  }));
  borrower.post('/market/listings/:id/documents/:docId/delete', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => {
      const l = await listingFor(c, req.params.id, 'l.borrower_org_id = $2', [req.org.org_id]);
      if (!['Draft', 'Returned'].includes(l.status)) fail(409, 'listing_not_editable', { status: l.status });
      if (!isUuid(req.params.docId)) fail(404, 'document_not_found');
      const r = (await c.query('DELETE FROM coop_lending.listing_document WHERE doc_id = $1 AND listing_id = $2 RETURNING doc_id', [req.params.docId, l.listing_id])).rows[0];
      if (!r) fail(404, 'document_not_found');
      return r;
    }));
  }));
  borrower.get('/market/listings/:id/documents/:docId/file', wrap(async (req, res) => {
    await orgTx(req, async (c) => {
      const l = await listingFor(c, req.params.id, 'l.borrower_org_id = $2', [req.org.org_id]);
      if (!isUuid(req.params.docId)) fail(404, 'document_not_found');
      const d = (await c.query('SELECT file_id FROM coop_lending.listing_document WHERE doc_id = $1 AND listing_id = $2', [req.params.docId, l.listing_id])).rows[0];
      if (!d) fail(404, 'document_not_found');
      await sendFile(res, c, d.file_id);
    });
  }));
  /** รายละเอียดโครงการของตนเอง: ความครบถ้วน คะแนน ข้อเสนอทั้งหมด (เปรียบเทียบ) คำถาม สัญญา รายงานผล */
  borrower.get('/market/listings/:id', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => {
      const l = await listingFor(c, req.params.id, 'l.borrower_org_id = $2', [req.org.org_id]);
      const docs = await documents(c, l.listing_id);
      const s = await scoreFor(c, req.org.org_id);
      return {
        listing: listingOut(l), documents: docs, checks: M.listingChecks(l, docs, s.profile), score: s.score, risk: M.projectRisk(l),
        offers: await offersOf(c, l.listing_id), questions: await questions(c, l.listing_id, null), agreement: await agreementOf(c, l.listing_id),
        reports: (await c.query('SELECT * FROM coop_lending.listing_report WHERE listing_id = $1 ORDER BY created_at DESC', [l.listing_id])).rows,
        facilities: (await c.query(`SELECT f.facility_id, f.limit_amount, f.rate_pct, f.status, o.org_name AS lender_name FROM coop_lending.facility f JOIN identity.organization o ON o.org_id = f.lender_org_id WHERE f.listing_id = $1`, [l.listing_id])).rows,
      };
    }));
  }));
  borrower.post('/market/listings/:id/certify', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      const l = await listingFor(c, req.params.id, 'l.borrower_org_id = $2', [req.org.org_id], true);
      if (!['Draft', 'Returned'].includes(l.status)) fail(409, 'listing_not_editable', { status: l.status });
      return listingOut((await c.query('UPDATE coop_lending.loan_listing SET certified_by = $2, certified_at = now() WHERE listing_id = $1 RETURNING *', [l.listing_id, actor.key])).rows[0]);
    }));
  }));
  borrower.post('/market/listings/:id/submit', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => {
      const l = await listingFor(c, req.params.id, 'l.borrower_org_id = $2', [req.org.org_id], true);
      if (!['Draft', 'Returned'].includes(l.status)) fail(409, 'listing_not_editable', { status: l.status });
      const s = await scoreFor(c, req.org.org_id);
      const chk = M.listingChecks(l, await documents(c, l.listing_id), s.profile);
      if (!chk.ok) fail(400, 'listing_incomplete', { missing: chk.missing });
      return listingOut((await c.query(`UPDATE coop_lending.loan_listing SET status = 'Review', score = $2, review_note = NULL, updated_at = now() WHERE listing_id = $1 RETURNING *`,
        [l.listing_id, JSON.stringify(s.score)])).rows[0]);
    }));
  }));
  borrower.post('/market/listings/:id/withdraw', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => {
      const l = await listingFor(c, req.params.id, 'l.borrower_org_id = $2', [req.org.org_id], true);
      if (!['Draft', 'Review', 'Returned', 'Listed', 'Offered'].includes(l.status)) fail(409, 'listing_not_withdrawable', { status: l.status });
      const live = (await c.query(`UPDATE coop_lending.loan_offer SET status = 'Expired' WHERE listing_id = $1 AND status IN ('Submitted','Countered','Accepted','Confirmed') RETURNING lender_org_id`, [l.listing_id])).rows;
      for (const o of live) await notify(c, o.lender_org_id, 'offer_update', `ผู้ขอกู้ถอนโครงการ "${l.title}" — ข้อเสนอของท่านสิ้นผล`, l.listing_id);
      return listingOut((await c.query(`UPDATE coop_lending.loan_listing SET status = 'Withdrawn', closed_at = now() WHERE listing_id = $1 RETURNING *`, [l.listing_id])).rows[0]);
    }));
  }));
  borrower.post('/market/questions/:qid/answer', wrap(async (req, res) => {
    const b = req.body || {};
    res.json(await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      if (!isUuid(req.params.qid)) fail(404, 'question_not_found');
      const q = (await c.query(`SELECT q.*, l.title FROM coop_lending.listing_question q JOIN coop_lending.loan_listing l ON l.listing_id = q.listing_id
                                 WHERE q.question_id = $1 AND l.borrower_org_id = $2 FOR UPDATE OF q`, [req.params.qid, req.org.org_id])).rows[0];
      if (!q) fail(404, 'question_not_found');
      const fileId = b.file_id ? (await fileOwnedBy(c, b.file_id, req.org.org_id)).file_id : null;
      const r = (await c.query(`UPDATE coop_lending.listing_question SET answer = $2, answer_file_id = COALESCE($3, answer_file_id), answered_by = $4, answered_at = now() WHERE question_id = $1 RETURNING *`,
        [q.question_id, text(b.answer, 'answer', { min: 2, max: 4000 }), fileId, actor.key])).rows[0];
      await notify(c, q.lender_org_id, 'question', `ผู้ขอกู้ตอบคำถามของท่านในโครงการ "${q.title}"`, q.listing_id);
      return r;
    }));
  }));

  async function borrowerOffer(c, req, lock = true) {
    if (!isUuid(req.params.oid)) fail(404, 'offer_not_found');
    const o = (await c.query(`SELECT o.*, l.title, l.status AS listing_status, l.amount_requested, l.borrower_org_id FROM coop_lending.loan_offer o JOIN coop_lending.loan_listing l ON l.listing_id = o.listing_id
                               WHERE o.offer_id = $1 AND l.borrower_org_id = $2 ${lock ? 'FOR UPDATE OF o, l' : ''}`, [req.params.oid, req.org.org_id])).rows[0];
    if (!o) fail(404, 'offer_not_found');
    if (!['Listed', 'Offered'].includes(o.listing_status)) fail(409, 'listing_not_open', { status: o.listing_status });
    return o;
  }
  borrower.post('/market/offers/:oid/counter', wrap(async (req, res) => {
    const b = req.body || {};
    res.json(await orgTx(req, async (c) => {
      const o = await borrowerOffer(c, req);
      if (o.status !== 'Submitted') fail(409, 'offer_not_counterable', { status: o.status });
      const counter = {
        amount: nOrNull(b.amount, 'amount', { min: 1000 }), rate_pct: nOrNull(b.rate_pct, 'rate_pct', { max: 30 }), tenor_months: b.tenor_months ? parseInt(b.tenor_months, 10) : null,
        grace_months: b.grace_months !== undefined && b.grace_months !== '' ? parseInt(b.grace_months, 10) : null, note: text(b.note, 'note', { max: 1000, allowNull: true }),
      };
      if (counter.amount === null && counter.rate_pct === null && counter.tenor_months === null && counter.grace_months === null && !counter.note) fail(400, 'counter_empty');
      const r = (await c.query(`UPDATE coop_lending.loan_offer SET status = 'Countered', counter = $2, countered_at = now() WHERE offer_id = $1 RETURNING *`, [o.offer_id, JSON.stringify(counter)])).rows[0];
      await notify(c, o.lender_org_id, 'offer_update', `ผู้ขอกู้ยื่นข้อเสนอโต้ตอบในโครงการ "${o.title}" — แก้ไขข้อเสนอหรือคงเดิมได้`, o.listing_id);
      return r;
    }));
  }));
  borrower.post('/market/offers/:oid/accept', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      const o = await borrowerOffer(c, req);
      if (o.status !== 'Submitted') fail(409, 'offer_not_acceptable', { status: o.status });
      if (o.valid_until && L.toDateStr(o.valid_until) < today()) fail(409, 'offer_expired');
      const taken = Number((await c.query(`SELECT COALESCE(SUM(amount), 0) AS s FROM coop_lending.loan_offer WHERE listing_id = $1 AND status IN ('Accepted','Confirmed')`, [o.listing_id])).rows[0].s);
      if (taken + Number(o.amount) > Number(o.amount_requested) + 0.004) fail(409, 'over_requested_amount', { available: L.round2(Number(o.amount_requested) - taken) });
      const r = (await c.query(`UPDATE coop_lending.loan_offer SET status = 'Accepted', accepted_at = now(), accepted_by = $2 WHERE offer_id = $1 RETURNING *`, [o.offer_id, actor.key])).rows[0];
      await notify(c, o.lender_org_id, 'offer_update', `ผู้ขอกู้เลือกข้อเสนอของท่านในโครงการ "${o.title}" — ให้ผู้มีอำนาจอนุมัติของสหกรณ์ยืนยัน`, o.listing_id);
      return r;
    }));
  }));
  borrower.post('/market/offers/:oid/decline', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => {
      const o = await borrowerOffer(c, req);
      if (!['Submitted', 'Countered', 'Accepted'].includes(o.status)) fail(409, 'offer_not_declinable', { status: o.status });
      const r = (await c.query(`UPDATE coop_lending.loan_offer SET status = 'Declined', decline_reason = $2 WHERE offer_id = $1 RETURNING *`,
        [o.offer_id, text((req.body || {}).reason, 'reason', { max: 500, allowNull: true })])).rows[0];
      await notify(c, o.lender_org_id, 'offer_update', `ผู้ขอกู้ไม่เลือกข้อเสนอของท่านในโครงการ "${o.title}"`, o.listing_id);
      return r;
    }));
  }));
  /** จับคู่: ใช้ข้อเสนอที่ผู้ให้กู้ยืนยันแล้ว → สร้างสัญญา (ผู้ให้กู้ร่วมได้หลายราย) */
  borrower.post('/market/listings/:id/match', wrap(async (req, res) => {
    const out = await orgTx(req, async (c) => {
      const l = await listingFor(c, req.params.id, 'l.borrower_org_id = $2', [req.org.org_id], true);
      if (!['Listed', 'Offered'].includes(l.status)) fail(409, 'listing_not_open', { status: l.status });
      const conf = (await c.query(`SELECT * FROM coop_lending.loan_offer WHERE listing_id = $1 AND status = 'Confirmed' ORDER BY amount DESC FOR UPDATE`, [l.listing_id])).rows;
      if (!conf.length) fail(409, 'no_confirmed_offer');
      const total = L.round2(conf.reduce((a, o) => a + Number(o.amount), 0));
      const need = Number(l.min_amount || l.amount_requested);
      if (total + 0.004 < need) fail(409, 'confirmed_below_minimum', { available: total, need });
      const ag = (await c.query(`INSERT INTO coop_lending.loan_agreement (listing_id, agreement_no, total_amount) VALUES ($1,$2,$3) RETURNING *`,
        [l.listing_id, M.agreementNo(today(), crypto.randomBytes(3).toString('hex').toUpperCase()), total])).rows[0];
      for (const o of conf) {
        await c.query(`INSERT INTO coop_lending.agreement_lender (agreement_id, offer_id, lender_org_id, amount, share_pct) VALUES ($1,$2,$3,$4,$5)`,
          [ag.agreement_id, o.offer_id, o.lender_org_id, o.amount, Math.round((Number(o.amount) / total) * 1e6) / 1e4]);
        await notify(c, o.lender_org_id, 'agreement', `จับคู่สำเร็จ: โครงการ "${l.title}" สัญญาเลขที่ ${ag.agreement_no} — ดาวน์โหลดร่างสัญญา ตรวจทาน และอัปโหลดฉบับลงนาม`, l.listing_id);
      }
      const others = (await c.query(`UPDATE coop_lending.loan_offer SET status = 'Superseded' WHERE listing_id = $1 AND status IN ('Submitted','Countered','Accepted') RETURNING lender_org_id`, [l.listing_id])).rows;
      for (const o of others) await notify(c, o.lender_org_id, 'offer_update', `โครงการ "${l.title}" จับคู่กับผู้ให้กู้รายอื่นแล้ว — ข้อเสนอของท่านสิ้นผล`, l.listing_id);
      await c.query(`UPDATE coop_lending.loan_listing SET status = 'Matched', matched_at = now(), updated_at = now() WHERE listing_id = $1`, [l.listing_id]);
      return ag;
    });
    res.status(201).json(out);
  }));
  borrower.get('/market/listings/:id/agreement.docx', wrap(async (req, res) => {
    const buf = await orgTx(req, async (c) => {
      const l = await listingFor(c, req.params.id, 'l.borrower_org_id = $2', [req.org.org_id]);
      return agreementDocx(c, l);
    });
    sendDocx(res, buf);
  }));
  borrower.post('/market/listings/:id/agreement/sign', wrap(async (req, res) => {
    const b = req.body || {};
    res.json(await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      const l = await listingFor(c, req.params.id, 'l.borrower_org_id = $2', [req.org.org_id], true);
      const ag = (await c.query('SELECT * FROM coop_lending.loan_agreement WHERE listing_id = $1 FOR UPDATE', [l.listing_id])).rows[0];
      if (!ag || ag.status !== 'Drafted') fail(409, 'agreement_not_signable');
      const f = await fileOwnedBy(c, b.file_id, req.org.org_id);
      const acct = await verifiedAccount(c, b.project_account_id, 'organization', req.org.org_id, ['loan_dedicated']);
      await c.query(`UPDATE coop_lending.loan_agreement SET borrower_signed_file_id = $2, borrower_signed_at = now(), borrower_signed_by = $3, project_account_id = $4 WHERE agreement_id = $1`,
        [ag.agreement_id, f.file_id, actor.key, acct.account_id]);
      return finalizeIfSigned(c, ag.agreement_id);
    }));
  }));
  borrower.post('/market/listings/:id/reports', wrap(async (req, res) => {
    const b = req.body || {};
    const out = await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      const l = await listingFor(c, req.params.id, 'l.borrower_org_id = $2', [req.org.org_id]);
      if (!['Signed', 'Active', 'Closed'].includes(l.status)) fail(409, 'listing_not_signed');
      const fileId = b.file_id ? (await fileOwnedBy(c, b.file_id, req.org.org_id)).file_id : null;
      const r = (await c.query(
        `INSERT INTO coop_lending.listing_report (listing_id, period_label, revenue, cost, planned_revenue, note, file_id, reported_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [l.listing_id, text(b.period_label, 'period_label', { min: 2, max: 40 }), nOrNull(b.revenue, 'revenue', { min: -1e13 }), nOrNull(b.cost, 'cost', { min: -1e13 }),
          nOrNull(b.planned_revenue, 'planned_revenue', { min: -1e13 }), text(b.note, 'note', { max: 2000, allowNull: true }), fileId, actor.key],
      )).rows[0];
      const lenders = (await c.query('SELECT DISTINCT lender_org_id FROM coop_lending.facility WHERE listing_id = $1', [l.listing_id])).rows;
      for (const x of lenders) await notify(c, x.lender_org_id, 'agreement', `ผู้กู้ส่งรายงานผลการดำเนินงาน ${r.period_label} ของโครงการ "${l.title}"`, l.listing_id);
      return r;
    });
    res.status(201).json(out);
  }));

  // ---------------------------------------------------------------- สัญญา
  async function agreementContext(c, l) {
    const ag = (await c.query('SELECT * FROM coop_lending.loan_agreement WHERE listing_id = $1', [l.listing_id])).rows[0];
    if (!ag) fail(404, 'agreement_not_found');
    const borrowerOrg = (await c.query('SELECT org_id, org_name, org_type FROM identity.organization WHERE org_id = $1', [l.borrower_org_id])).rows[0];
    const parties = (await c.query(
      `SELECT al.*, o.org_name, o.org_type, row_to_json(lo.*) AS offer FROM coop_lending.agreement_lender al JOIN identity.organization o ON o.org_id = al.lender_org_id
         JOIN coop_lending.loan_offer lo ON lo.offer_id = al.offer_id WHERE al.agreement_id = $1 ORDER BY al.amount DESC`, [ag.agreement_id],
    )).rows;
    const lenders = [];
    for (const p of parties) {
      lenders.push({ org: { org_id: p.lender_org_id, org_name: p.org_name, org_type: p.org_type }, profile: await lenderProfile(c, p.lender_org_id), offer: p.offer, amount: Number(p.amount), share_pct: Number(p.share_pct) });
    }
    const acct = ag.project_account_id ? (await c.query('SELECT * FROM coop_lending.bank_account WHERE account_id = $1', [ag.project_account_id])).rows[0] : null;
    return {
      agreement: { ...ag, start_date: ds(ag.start_date) }, listing: l, borrower: { org: borrowerOrg, profile: await borrowerProfile(c, l.borrower_org_id) }, lenders,
      documents: await documents(c, l.listing_id), projectAccount: acct, settings: await L.loadSettings(c), startDate: ds(ag.start_date) || today(),
    };
  }
  async function agreementDocx(c, l) { return buildAgreementDocx(await agreementContext(c, l)); }
  function sendDocx(res, buf) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="coop-loan-agreement.docx"');
    res.send(buf);
  }
  /** ลงนามครบทุกฝ่าย → เปิดวงเงินให้ผู้ให้กู้แต่ละราย (program/application ภายในระบบ ไม่แสดงในรายการเดิม) */
  async function finalizeIfSigned(c, agreementId) {
    const ag = (await c.query('SELECT * FROM coop_lending.loan_agreement WHERE agreement_id = $1', [agreementId])).rows[0];
    const parties = (await c.query('SELECT al.*, row_to_json(lo.*) AS offer FROM coop_lending.agreement_lender al JOIN coop_lending.loan_offer lo ON lo.offer_id = al.offer_id WHERE al.agreement_id = $1', [agreementId])).rows;
    const pending = { borrower: !ag.borrower_signed_file_id, lenders: parties.filter((p) => !p.signed_file_id).map((p) => p.lender_org_id) };
    if (pending.borrower || pending.lenders.length) return { status: 'Drafted', pending };
    const l = (await c.query('SELECT * FROM coop_lending.loan_listing WHERE listing_id = $1 FOR UPDATE', [ag.listing_id])).rows[0];
    const type = M.PROJECT_TYPES[l.project_type];
    const start = today();
    for (const p of parties) {
      const o = p.offer;
      const prog = (await c.query(
        `INSERT INTO coop_lending.program (lender_org_id, name, purposes, total_limit, per_borrower_limit, rate_pct, tranche_tenor_days, grace_days, per_farmer_limit,
                asset_min_down_pct, asset_max_months, asset_max_income_ratio_pct, conditions, status, listing_id)
         VALUES ($1,$2,$3,$4,$4,$5,$6,15,$7,0,$8,100,$9,'Closed',$10) RETURNING program_id`,
        [p.lender_org_id, `ตลาดสินเชื่อ ${ag.agreement_no}: ${l.title}`.slice(0, 160), type.purposes, p.amount, o.rate_pct,
          Math.min(730, Math.max(7, Number(o.tenor_months) * 30)), l.project_type === 'member_onlending' && l.details && l.details.per_member_limit ? l.details.per_member_limit : null,
          Math.min(120, Math.max(3, Number(o.tenor_months))), o.conditions ? String(o.conditions).slice(0, 2000) : null, l.listing_id],
      )).rows[0];
      const app = (await c.query(
        `INSERT INTO coop_lending.application (program_id, borrower_org_id, requested_amount, status, decided_at, decided_by, listing_id, plan_note)
         VALUES ($1,$2,$3,'Approved',now(),$4,$5,$6) RETURNING application_id`,
        [prog.program_id, l.borrower_org_id, p.amount, p.signed_by, l.listing_id, `สัญญา ${ag.agreement_no}`],
      )).rows[0];
      const fac = (await c.query(
        `INSERT INTO coop_lending.facility (application_id, program_id, lender_org_id, borrower_org_id, limit_amount, rate_pct, available_until, dedicated_account_id, listing_id, agreement_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING facility_id`,
        [app.application_id, prog.program_id, p.lender_org_id, l.borrower_org_id, p.amount, o.rate_pct, L.addMonths(start, Number(o.tenor_months)), ag.project_account_id, l.listing_id, ag.agreement_id],
      )).rows[0];
      await c.query('UPDATE coop_lending.agreement_lender SET facility_id = $3 WHERE agreement_id = $1 AND offer_id = $2', [agreementId, p.offer_id, fac.facility_id]);
      await L.logEvent(c, { facilityId: fac.facility_id, actor: 'system', action: 'agreement_signed', detail: { agreement_no: ag.agreement_no, listing_id: l.listing_id } });
      await notify(c, p.lender_org_id, 'agreement', `สัญญา ${ag.agreement_no} ลงนามครบทุกฝ่ายแล้ว — เปิดวงเงิน ${Number(p.amount).toLocaleString('th-TH')} บาท พร้อมเบิกจ่ายตามหลักฐาน`, l.listing_id);
    }
    await c.query(`UPDATE coop_lending.loan_agreement SET status = 'Signed', signed_at = now(), start_date = $2 WHERE agreement_id = $1`, [agreementId, start]);
    await c.query(`UPDATE coop_lending.loan_listing SET status = 'Signed', signed_at = now(), updated_at = now() WHERE listing_id = $1`, [l.listing_id]);
    await notify(c, l.borrower_org_id, 'agreement', `สัญญา ${ag.agreement_no} ลงนามครบทุกฝ่ายแล้ว — เบิกจ่ายได้ที่แท็บรายการเบิก/แผนการผลิต`, l.listing_id);
    return { status: 'Signed', pending: null };
  }

  // ======================================================================
  // ผู้ให้กู้ (สหกรณ์ออมทรัพย์ / เครดิตยูเนี่ยน)
  // ======================================================================
  savings.get('/market/profile', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => {
      const p = await lenderProfile(c, req.org.org_id);
      const committed = Number((await c.query(`SELECT COALESCE(SUM(limit_amount), 0) AS s FROM coop_lending.facility WHERE lender_org_id = $1 AND status <> 'Closed'`, [req.org.org_id])).rows[0].s);
      const offered = Number((await c.query(`SELECT COALESCE(SUM(amount), 0) AS s FROM coop_lending.loan_offer WHERE lender_org_id = $1 AND status IN ('Submitted','Countered','Accepted','Confirmed')`, [req.org.org_id])).rows[0].s);
      return { org: req.org, profile: p, committed, offered };
    }));
  }));
  savings.put('/market/profile', wrap(async (req, res) => {
    const b = req.body || {};
    res.json(await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      const pol = b.policy || {};
      const policy = {
        project_types: strs(pol.project_types, 3).filter((t) => M.PROJECT_TYPES[t]),
        min_amount: nOrNull(pol.min_amount, 'min_amount'), max_amount: nOrNull(pol.max_amount, 'max_amount'),
        min_tenor_months: nOrNull(pol.min_tenor_months, 'min_tenor_months', { max: 180 }), max_tenor_months: nOrNull(pol.max_tenor_months, 'max_tenor_months', { max: 180 }),
        rate_min: nOrNull(pol.rate_min, 'rate_min', { max: 30 }), rate_max: nOrNull(pol.rate_max, 'rate_max', { max: 30 }),
        collateral: strs(pol.collateral, 10), provinces: strs(pol.provinces, 80), commodities: strs(pol.commodities, 20),
        max_risk_grade: M.GRADES.includes(pol.max_risk_grade) ? pol.max_risk_grade : null,
        limit_per_borrower: nOrNull(pol.limit_per_borrower, 'limit_per_borrower'), limit_per_province: nOrNull(pol.limit_per_province, 'limit_per_province'),
        limit_per_type: Object.fromEntries(Object.keys(M.PROJECT_TYPES).map((k) => [k, nOrNull((pol.limit_per_type || {})[k], `limit_${k}`)]).filter(([, v]) => v !== null)),
      };
      const resolution = b.resolution_file_id ? (await fileOwnedBy(c, b.resolution_file_id, req.org.org_id)).file_id : null;
      const r = (await c.query(
        `INSERT INTO coop_lending.lender_profile (org_id, registration_no, province_code, member_count, signatories, contact, financials, allocatable_amount, liquidity_note,
                approval_authority, resolution_file_id, policy, data_as_of, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (org_id) DO UPDATE SET registration_no = EXCLUDED.registration_no, province_code = EXCLUDED.province_code, member_count = EXCLUDED.member_count,
           signatories = EXCLUDED.signatories, contact = EXCLUDED.contact, financials = EXCLUDED.financials, allocatable_amount = EXCLUDED.allocatable_amount,
           liquidity_note = EXCLUDED.liquidity_note, approval_authority = EXCLUDED.approval_authority,
           resolution_file_id = COALESCE(EXCLUDED.resolution_file_id, coop_lending.lender_profile.resolution_file_id), policy = EXCLUDED.policy,
           data_as_of = EXCLUDED.data_as_of, updated_at = now(), updated_by = EXCLUDED.updated_by RETURNING *`,
        [req.org.org_id, text(b.registration_no, 'registration_no', { max: 60, allowNull: true }), text(b.province_code, 'province_code', { max: 40, allowNull: true }),
          b.member_count === '' || b.member_count == null ? null : parseInt(b.member_count, 10), text(b.signatories, 'signatories', { max: 500, allowNull: true }),
          text(b.contact, 'contact', { max: 300, allowNull: true }), JSON.stringify(cleanFinancials(b.financials)), nOrNull(b.allocatable_amount, 'allocatable_amount'),
          text(b.liquidity_note, 'liquidity_note', { max: 2000, allowNull: true }), text(b.approval_authority, 'approval_authority', { max: 2000, allowNull: true }),
          resolution, JSON.stringify(policy), L.isDate(b.data_as_of) ? b.data_as_of : today(), actor.key],
      )).rows[0];
      return r;
    }));
  }));
  /** ค้นหาโครงการที่ประกาศ — กรองตามประเภท พื้นที่ วงเงิน ระยะเวลา ชนิดพืช ระดับความเสี่ยง หรือเฉพาะที่ตรงนโยบาย */
  savings.get('/market/listings', wrap(async (req, res) => {
    const q = req.query || {};
    res.json(await orgTx(req, async (c) => {
      const prof = await lenderProfile(c, req.org.org_id);
      const rows = (await c.query(
        `SELECT l.*, o.org_name AS borrower_name, pv.province_name_th,
                (SELECT COUNT(*) FROM coop_lending.loan_offer x WHERE x.listing_id = l.listing_id AND x.status IN ('Submitted','Countered','Accepted','Confirmed'))::int AS live_offers,
                (SELECT row_to_json(x.*) FROM coop_lending.loan_offer x WHERE x.listing_id = l.listing_id AND x.lender_org_id = $1 ORDER BY x.created_at DESC LIMIT 1) AS my_offer,
                (SELECT COUNT(*) FROM coop_lending.listing_question x WHERE x.listing_id = l.listing_id)::int AS questions
           FROM coop_lending.loan_listing l JOIN identity.organization o ON o.org_id = l.borrower_org_id LEFT JOIN registry.province pv ON pv.province_code = l.province_code
          WHERE (l.status IN ('Listed','Offered') OR EXISTS (SELECT 1 FROM coop_lending.loan_offer x WHERE x.listing_id = l.listing_id AND x.lender_org_id = $1))
          ORDER BY (l.status IN ('Listed','Offered')) DESC, l.listed_at DESC NULLS LAST LIMIT 300`, [req.org.org_id],
      )).rows.map((l) => {
        const grade = l.score ? l.score.grade : null;
        return { ...listingOut(l), grade, score_value: l.score ? l.score.score : null, policy: M.policyMatch(prof ? prof.policy : {}, l, grade) };
      });
      const f = rows.filter((l) => (!q.type || l.project_type === q.type) && (!q.province || l.province_code === q.province)
        && (!q.min || Number(l.amount_requested) >= Number(q.min)) && (!q.max || Number(l.min_amount || l.amount_requested) <= Number(q.max))
        && (!q.tenor_max || l.tenor_months <= Number(q.tenor_max)) && (!q.commodity || (l.commodities || []).includes(q.commodity))
        && (!q.grade || (l.grade && M.GRADES.indexOf(l.grade) <= M.GRADES.indexOf(q.grade))) && (q.match_only !== '1' || l.policy.match));
      await logAccess(c, 'read', 'coop_lending.loan_listing', null);
      return { listings: f, has_profile: Boolean(prof) };
    }));
  }));
  async function lenderListing(c, req) {
    const l = await listingFor(c, req.params.id, `(l.status IN ('Listed','Offered') OR EXISTS (SELECT 1 FROM coop_lending.loan_offer x WHERE x.listing_id = l.listing_id AND x.lender_org_id = $2))`, [req.org.org_id]);
    return l;
  }
  savings.get('/market/listings/:id', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => {
      const l = await lenderListing(c, req);
      const s = await scoreFor(c, l.borrower_org_id);
      const prof = await lenderProfile(c, req.org.org_id);
      const borrowerOrg = (await c.query(
        `SELECT o.org_id, o.org_name, cp.cooperative_registration_no, cp.established_year, cp.member_count_reported, pv.province_name_th
           FROM identity.organization o LEFT JOIN registry.cooperative_profile cp ON cp.org_id = o.org_id LEFT JOIN registry.province pv ON pv.province_code = cp.province_code WHERE o.org_id = $1`, [l.borrower_org_id],
      )).rows[0];
      const platform = (await c.query(
        `SELECT COUNT(DISTINCT r.farmer_id)::int AS members_on_platform, COUNT(pu.unit_id)::int AS plots, COALESCE(SUM(pu.area_rai), 0)::numeric AS area_rai
           FROM identity.farmer_org_relationship r LEFT JOIN registry.production_unit pu ON pu.owner_farmer_id = r.farmer_id WHERE r.org_id = $1 AND r.status = 'active'`, [l.borrower_org_id],
      )).rows[0];
      const mine = (await c.query('SELECT * FROM coop_lending.loan_offer WHERE listing_id = $1 AND lender_org_id = $2 ORDER BY created_at DESC', [l.listing_id, req.org.org_id])).rows;
      const comp = (await c.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::numeric AS amount FROM coop_lending.loan_offer WHERE listing_id = $1 AND lender_org_id <> $2 AND status IN ('Submitted','Countered','Accepted','Confirmed')`, [l.listing_id, req.org.org_id])).rows[0];
      await logAccess(c, 'read', 'coop_lending.borrower_profile', l.borrower_org_id);
      return {
        listing: listingOut(l), borrower: { ...borrowerOrg, profile: s.profile && s.profile.consent_disclose ? s.profile : null, platform: { ...platform, area_rai: Number(platform.area_rai) } },
        score: s.score, risk: M.projectRisk(l), documents: await documents(c, l.listing_id), questions: await questions(c, l.listing_id, req.org.org_id),
        my_offers: mine.map((o) => ({ ...o, valid_until: ds(o.valid_until) })), other_offers: { n: comp.n, amount: Number(comp.amount) },
        policy: M.policyMatch(prof ? prof.policy : {}, l, s.score.grade), exposure: await exposure(c, req.org.org_id, l), lender_profile: prof,
        agreement: await agreementOf(c, l.listing_id),
        reports: (await c.query('SELECT * FROM coop_lending.listing_report WHERE listing_id = $1 ORDER BY created_at DESC', [l.listing_id])).rows,
      };
    }));
  }));
  savings.get('/market/listings/:id/documents/:docId/file', wrap(async (req, res) => {
    await orgTx(req, async (c) => {
      const l = await lenderListing(c, req);
      if (!isUuid(req.params.docId)) fail(404, 'document_not_found');
      const d = (await c.query('SELECT file_id FROM coop_lending.listing_document WHERE doc_id = $1 AND listing_id = $2', [req.params.docId, l.listing_id])).rows[0];
      if (!d) fail(404, 'document_not_found');
      await logAccess(c, 'read', 'coop_lending.listing_document', req.params.docId);
      await sendFile(res, c, d.file_id);
    });
  }));
  savings.post('/market/listings/:id/questions', wrap(async (req, res) => {
    const b = req.body || {};
    const out = await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      const l = await lenderListing(c, req);
      if (!VISIBLE_TO_LENDERS.includes(l.status)) fail(409, 'listing_not_open', { status: l.status });
      const kind = ['question', 'document_request', 'visit_request'].includes(b.kind) ? b.kind : 'question';
      const r = (await c.query(`INSERT INTO coop_lending.listing_question (listing_id, lender_org_id, kind, question, asked_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [l.listing_id, req.org.org_id, kind, text(b.question, 'question', { min: 3, max: 2000 }), actor.key])).rows[0];
      await notify(c, l.borrower_org_id, 'question', `${{ question: 'มีคำถาม', document_request: 'มีคำขอเอกสารเพิ่มเติม', visit_request: 'มีคำขอนัดเยี่ยมชมสหกรณ์' }[kind]}จากผู้ให้กู้ในโครงการ "${l.title}"`, l.listing_id);
      return r;
    });
    res.status(201).json(out);
  }));
  function offerTerms(b, l) {
    const t = {
      amount: num(b.amount, 'amount', { min: 1000 }), rate_pct: num(b.rate_pct, 'rate_pct', { max: 30 }),
      tenor_months: parseInt(b.tenor_months, 10), repayment_type: b.repayment_type === 'bullet' ? 'bullet' : 'installment',
      interval_months: [1, 3, 6, 12].includes(Number(b.interval_months)) ? Number(b.interval_months) : 6,
      grace_months: parseInt(b.grace_months || 0, 10), collateral_required: text(b.collateral_required, 'collateral_required', { max: 2000, allowNull: true }),
      conditions: text(b.conditions, 'conditions', { max: 4000, allowNull: true }), valid_until: L.isDate(b.valid_until) ? b.valid_until : null,
    };
    if (!(t.tenor_months >= 1 && t.tenor_months <= 180)) fail(400, 'invalid_number', { field: 'tenor_months' });
    if (!(t.grace_months >= 0 && t.grace_months < t.tenor_months)) fail(400, 'invalid_number', { field: 'grace_months' });
    if (t.amount > Number(l.amount_requested) + 0.004) fail(400, 'offer_over_requested', { available: Number(l.amount_requested) });
    return t;
  }
  savings.post('/market/listings/:id/offers', wrap(async (req, res) => {
    const out = await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      const l = await lenderListing(c, req);
      if (!VISIBLE_TO_LENDERS.includes(l.status)) fail(409, 'listing_not_open', { status: l.status });
      if (l.offers_close_on && L.toDateStr(l.offers_close_on) < today()) fail(409, 'offers_closed');
      const t = offerTerms(req.body || {}, l);
      const prof = await lenderProfile(c, req.org.org_id);
      if (!prof) fail(409, 'lender_profile_required');
      const warnings = M.exposureWarnings(prof, await exposure(c, req.org.org_id, l), t, l);
      const r = (await c.query(
        `INSERT INTO coop_lending.loan_offer (listing_id, lender_org_id, amount, rate_pct, tenor_months, repayment_type, interval_months, grace_months, collateral_required, conditions, valid_until, submitted_by, warnings)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [l.listing_id, req.org.org_id, t.amount, t.rate_pct, t.tenor_months, t.repayment_type, t.interval_months, t.grace_months, t.collateral_required, t.conditions, t.valid_until, actor.key, JSON.stringify(warnings)],
      )).rows[0];
      if (l.status === 'Listed') await c.query(`UPDATE coop_lending.loan_listing SET status = 'Offered', updated_at = now() WHERE listing_id = $1`, [l.listing_id]);
      await notify(c, l.borrower_org_id, 'offer_received', `มีข้อเสนอใหม่ในโครงการ "${l.title}": ${Number(t.amount).toLocaleString('th-TH')} บาท ดอกเบี้ย ${t.rate_pct}% ${t.tenor_months} เดือน`, l.listing_id);
      return r;
    });
    res.status(201).json(out);
  }));
  async function lenderOffer(c, req) {
    if (!isUuid(req.params.oid)) fail(404, 'offer_not_found');
    const o = (await c.query(`SELECT o.*, l.title, l.status AS listing_status, l.borrower_org_id, l.amount_requested, l.min_amount, row_to_json(l.*) AS listing FROM coop_lending.loan_offer o
                               JOIN coop_lending.loan_listing l ON l.listing_id = o.listing_id WHERE o.offer_id = $1 AND o.lender_org_id = $2 FOR UPDATE OF o`, [req.params.oid, req.org.org_id])).rows[0];
    if (!o) fail(404, 'offer_not_found');
    return o;
  }
  savings.post('/market/offers/:oid/revise', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      const o = await lenderOffer(c, req);
      if (!['Submitted', 'Countered'].includes(o.status) || !VISIBLE_TO_LENDERS.includes(o.listing_status)) fail(409, 'offer_not_revisable', { status: o.status });
      const t = offerTerms(req.body || {}, o.listing);
      const warnings = M.exposureWarnings(await lenderProfile(c, req.org.org_id), await exposure(c, req.org.org_id, o.listing), t, o.listing);
      const r = (await c.query(
        `UPDATE coop_lending.loan_offer SET amount = $2, rate_pct = $3, tenor_months = $4, repayment_type = $5, interval_months = $6, grace_months = $7, collateral_required = $8,
                conditions = $9, valid_until = $10, status = 'Submitted', submitted_by = $11, warnings = $12 WHERE offer_id = $1 RETURNING *`,
        [o.offer_id, t.amount, t.rate_pct, t.tenor_months, t.repayment_type, t.interval_months, t.grace_months, t.collateral_required, t.conditions, t.valid_until, actor.key, JSON.stringify(warnings)],
      )).rows[0];
      await notify(c, o.borrower_org_id, 'offer_update', `ผู้ให้กู้ปรับข้อเสนอในโครงการ "${o.title}": ${Number(t.amount).toLocaleString('th-TH')} บาท ดอกเบี้ย ${t.rate_pct}%`, o.listing_id);
      return r;
    }));
  }));
  savings.post('/market/offers/:oid/withdraw', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => {
      const o = await lenderOffer(c, req);
      if (!['Submitted', 'Countered', 'Accepted'].includes(o.status)) fail(409, 'offer_not_withdrawable', { status: o.status });
      const r = (await c.query(`UPDATE coop_lending.loan_offer SET status = 'Withdrawn' WHERE offer_id = $1 RETURNING *`, [o.offer_id])).rows[0];
      await notify(c, o.borrower_org_id, 'offer_update', `ผู้ให้กู้ถอนข้อเสนอในโครงการ "${o.title}"`, o.listing_id);
      return r;
    }));
  }));
  /** ยืนยันข้อเสนอที่ผู้ขอกู้เลือก ตามอำนาจอนุมัติของสหกรณ์ — ต้องเป็นคนละคนกับผู้ยื่นข้อเสนอ */
  savings.post('/market/offers/:oid/confirm', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      const o = await lenderOffer(c, req);
      if (o.status !== 'Accepted') fail(409, 'offer_not_accepted', { status: o.status });
      if (o.submitted_by === actor.key) fail(409, 'approver_must_differ_from_preparer');
      const r = (await c.query(`UPDATE coop_lending.loan_offer SET status = 'Confirmed', confirmed_at = now(), confirmed_by = $2, approval_ref = $3 WHERE offer_id = $1 RETURNING *`,
        [o.offer_id, actor.key, text((req.body || {}).approval_ref, 'approval_ref', { min: 2, max: 120 })])).rows[0];
      await notify(c, o.borrower_org_id, 'offer_update', `ผู้ให้กู้ยืนยันข้อเสนอในโครงการ "${o.title}" ตามอำนาจอนุมัติแล้ว — กด "จับคู่และจัดทำสัญญา" ได้`, o.listing_id);
      return r;
    }));
  }));
  savings.get('/market/offers', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => (await c.query(
      `SELECT o.*, l.title, l.project_type, l.status AS listing_status, l.amount_requested, b.org_name AS borrower_name,
              ag.agreement_id, ag.agreement_no, ag.status AS agreement_status, al.signed_file_id IS NOT NULL AS i_signed, al.facility_id
         FROM coop_lending.loan_offer o JOIN coop_lending.loan_listing l ON l.listing_id = o.listing_id JOIN identity.organization b ON b.org_id = l.borrower_org_id
         LEFT JOIN coop_lending.loan_agreement ag ON ag.listing_id = l.listing_id LEFT JOIN coop_lending.agreement_lender al ON al.agreement_id = ag.agreement_id AND al.offer_id = o.offer_id
        WHERE o.lender_org_id = $1 ORDER BY o.created_at DESC LIMIT 300`, [req.org.org_id],
    )).rows.map((o) => ({ ...o, valid_until: ds(o.valid_until) }))));
  }));
  async function lenderAgreementListing(c, req) {
    if (!isUuid(req.params.aid)) fail(404, 'agreement_not_found');
    const r = (await c.query(`SELECT l.* FROM coop_lending.loan_agreement ag JOIN coop_lending.loan_listing l ON l.listing_id = ag.listing_id
                               WHERE ag.agreement_id = $1 AND EXISTS (SELECT 1 FROM coop_lending.agreement_lender al WHERE al.agreement_id = ag.agreement_id AND al.lender_org_id = $2)`, [req.params.aid, req.org.org_id])).rows[0];
    if (!r) fail(404, 'agreement_not_found');
    return r;
  }
  savings.get('/market/agreements/:aid/docx', wrap(async (req, res) => {
    const buf = await orgTx(req, async (c) => agreementDocx(c, await lenderAgreementListing(c, req)));
    sendDocx(res, buf);
  }));
  savings.post('/market/agreements/:aid/sign', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      await lenderAgreementListing(c, req);
      const ag = (await c.query('SELECT * FROM coop_lending.loan_agreement WHERE agreement_id = $1 FOR UPDATE', [req.params.aid])).rows[0];
      if (ag.status !== 'Drafted') fail(409, 'agreement_not_signable');
      const f = await fileOwnedBy(c, (req.body || {}).file_id, req.org.org_id);
      await c.query(`UPDATE coop_lending.agreement_lender SET signed_file_id = $3, signed_at = now(), signed_by = $4 WHERE agreement_id = $1 AND lender_org_id = $2`, [ag.agreement_id, req.org.org_id, f.file_id, actor.key]);
      return finalizeIfSigned(c, ag.agreement_id);
    }));
  }));

  // ======================================================================
  // ผู้ดูแลแพลตฟอร์ม: ตรวจความครบถ้วนก่อนประกาศ
  // ======================================================================
  const adminTx = (req, fn) => tx('platform', req.subject.subjectId, fn);
  admin.get('/market/listings', wrap(async (req, res) => {
    res.json(await adminTx(req, async (c) => {
      const rows = (await c.query(
        `SELECT l.*, o.org_name AS borrower_name, pv.province_name_th,
                (SELECT COUNT(*) FROM coop_lending.loan_offer x WHERE x.listing_id = l.listing_id AND x.status IN ('Submitted','Countered','Accepted','Confirmed'))::int AS live_offers
           FROM coop_lending.loan_listing l JOIN identity.organization o ON o.org_id = l.borrower_org_id LEFT JOIN registry.province pv ON pv.province_code = l.province_code
          WHERE l.status <> 'Draft' ORDER BY (l.status = 'Review') DESC, l.updated_at DESC LIMIT 300`,
      )).rows;
      const out = [];
      for (const l of rows) {
        const docs = await documents(c, l.listing_id);
        out.push({ ...listingOut(l), documents: docs, checks: M.listingChecks(l, docs, await borrowerProfile(c, l.borrower_org_id)) });
      }
      return out;
    }));
  }));
  admin.post('/market/listings/:id/approve', wrap(async (req, res) => {
    res.json(await adminTx(req, async (c) => {
      const l = await listingFor(c, req.params.id, 'true', [], true);
      if (l.status !== 'Review') fail(409, 'listing_not_in_review', { status: l.status });
      const s = await scoreFor(c, l.borrower_org_id);
      const chk = M.listingChecks(l, await documents(c, l.listing_id), s.profile);
      if (!chk.ok) fail(400, 'listing_incomplete', { missing: chk.missing });
      const days = Math.min(90, Math.max(7, parseInt((req.body || {}).offer_days, 10) || 30));
      const r = (await c.query(
        `UPDATE coop_lending.loan_listing SET status = 'Listed', listed_at = now(), offers_close_on = $2, score = $3, reviewed_by = $4, review_note = NULL, updated_at = now() WHERE listing_id = $1 RETURNING *`,
        [l.listing_id, L.addDays(today(), days), JSON.stringify(s.score), `platform:${req.subject.subjectId || 'admin'}`],
      )).rows[0];
      await notify(c, l.borrower_org_id, 'listing_review', `โครงการ "${l.title}" ผ่านการตรวจและประกาศแล้ว — รับข้อเสนอถึง ${L.addDays(today(), days)}`, l.listing_id);
      // แจ้งผู้ให้กู้ที่นโยบายสินเชื่อตรงกับโครงการ
      const lenders = (await c.query(`SELECT lp.org_id, lp.policy FROM coop_lending.lender_profile lp JOIN identity.organization o ON o.org_id = lp.org_id WHERE o.kyb_status = 'Verified'`)).rows;
      let matched = 0;
      for (const x of lenders) {
        if (M.policyMatch(x.policy, r, s.score.grade).match) {
          matched += 1;
          await notify(c, x.org_id, 'listing_match', `โครงการใหม่ตรงนโยบายสินเชื่อของท่าน: "${l.title}" ${Number(l.amount_requested).toLocaleString('th-TH')} บาท ${l.tenor_months} เดือน (เกรด ${s.score.grade})`, l.listing_id);
        }
      }
      return { ...listingOut(r), notified_lenders: matched };
    }));
  }));
  admin.post('/market/listings/:id/return', wrap(async (req, res) => {
    res.json(await adminTx(req, async (c) => {
      const l = await listingFor(c, req.params.id, 'true', [], true);
      if (l.status !== 'Review') fail(409, 'listing_not_in_review', { status: l.status });
      const note = text((req.body || {}).note, 'note', { min: 3, max: 1000 });
      const r = (await c.query(`UPDATE coop_lending.loan_listing SET status = 'Returned', review_note = $2, certified_at = NULL, updated_at = now() WHERE listing_id = $1 RETURNING *`, [l.listing_id, note])).rows[0];
      await notify(c, l.borrower_org_id, 'listing_review', `โครงการ "${l.title}" ถูกส่งกลับให้แก้ไข: ${note}`, l.listing_id);
      return listingOut(r);
    }));
  }));

  // ======================================================================
  // กรมส่งเสริมสหกรณ์: ตัวชี้วัดตลาด (ตามขอบเขตจังหวัดของเจ้าหน้าที่)
  // ======================================================================
  gov.get('/market', wrap(async (req, res) => {
    res.json(await govTx(req, async (c) => {
      const { province } = await officerScope(c, req);
      const q = async (sql, extra = []) => (await c.query(sql, [province, ...extra])).rows;
      const scope = `($1::text IS NULL OR l.province_code = $1)`;
      const byStatus = await q(`SELECT l.status, l.project_type, COUNT(*)::int AS n, COALESCE(SUM(l.amount_requested), 0)::numeric AS amount FROM coop_lending.loan_listing l WHERE ${scope} AND l.status <> 'Draft' GROUP BY 1, 2`);
      const offers = (await q(
        `SELECT COUNT(*)::int AS offers, COUNT(DISTINCT o.listing_id)::int AS listings_with_offers, COUNT(DISTINCT o.lender_org_id)::int AS lenders_offering,
                ROUND(AVG(o.rate_pct), 2) AS avg_rate
           FROM coop_lending.loan_offer o JOIN coop_lending.loan_listing l ON l.listing_id = o.listing_id WHERE ${scope}`,
      ))[0];
      const flow = (await q(
        `SELECT COUNT(*) FILTER (WHERE l.listed_at IS NOT NULL)::int AS listed, COUNT(*) FILTER (WHERE l.matched_at IS NOT NULL)::int AS matched,
                COUNT(*) FILTER (WHERE l.signed_at IS NOT NULL)::int AS signed,
                ROUND(AVG(EXTRACT(EPOCH FROM (l.signed_at - l.listed_at)) / 86400) FILTER (WHERE l.signed_at IS NOT NULL), 1) AS avg_days_to_sign,
                COALESCE(SUM(ag.total_amount) FILTER (WHERE ag.status = 'Signed'), 0)::numeric AS signed_amount,
                COUNT(*) FILTER (WHERE (SELECT COUNT(*) FROM coop_lending.agreement_lender al WHERE al.agreement_id = ag.agreement_id) > 1)::int AS syndicated
           FROM coop_lending.loan_listing l LEFT JOIN coop_lending.loan_agreement ag ON ag.listing_id = l.listing_id WHERE ${scope}`,
      ))[0];
      const registry = (await c.query(
        `SELECT (SELECT COUNT(*) FROM identity.organization WHERE org_type = 'SavingsCooperative' AND kyb_status = 'Verified')::int AS savings,
                (SELECT COUNT(*) FROM identity.organization WHERE org_type = 'CreditUnion' AND kyb_status = 'Verified')::int AS credit_unions,
                (SELECT COUNT(*) FROM coop_lending.lender_profile)::int AS lender_profiles,
                (SELECT COALESCE(SUM(allocatable_amount), 0) FROM coop_lending.lender_profile)::numeric AS allocatable,
                (SELECT COUNT(*) FROM coop_lending.borrower_profile bp LEFT JOIN registry.cooperative_profile cp ON cp.org_id = bp.org_id WHERE $1::text IS NULL OR cp.province_code = $1)::int AS borrower_profiles,
                (SELECT COUNT(*) FROM coop_lending.borrower_profile bp LEFT JOIN registry.cooperative_profile cp ON cp.org_id = bp.org_id WHERE bp.consent_disclose AND ($1::text IS NULL OR cp.province_code = $1))::int AS borrower_consented`,
        [province],
      )).rows[0];
      const grades = await q(`SELECT l.score->>'grade' AS grade, COUNT(*)::int AS n FROM coop_lending.loan_listing l WHERE ${scope} AND l.score IS NOT NULL AND l.status <> 'Draft' GROUP BY 1 ORDER BY 1`);
      const listings = await q(
        `SELECT l.listing_id, l.title, l.project_type, l.status, l.amount_requested, l.tenor_months, l.score->>'grade' AS grade, b.org_name AS borrower_name, pv.province_name_th,
                l.listed_at, l.signed_at, (SELECT COUNT(*) FROM coop_lending.loan_offer o WHERE o.listing_id = l.listing_id)::int AS offers,
                (SELECT string_agg(o2.org_name, ', ') FROM coop_lending.agreement_lender al JOIN coop_lending.loan_agreement ag ON ag.agreement_id = al.agreement_id
                   JOIN identity.organization o2 ON o2.org_id = al.lender_org_id WHERE ag.listing_id = l.listing_id) AS lenders
           FROM coop_lending.loan_listing l JOIN identity.organization b ON b.org_id = l.borrower_org_id LEFT JOIN registry.province pv ON pv.province_code = l.province_code
          WHERE ${scope} AND l.status NOT IN ('Draft') ORDER BY l.updated_at DESC LIMIT 100`,
      );
      await logAccess(c, 'read', 'coop_lending.loan_listing', null);
      const N = (x) => Number(x);
      return {
        national_counts: { savings: 1383, credit_unions: 587, agri: 2988, source: 'กรมส่งเสริมสหกรณ์ ณ 31 ธ.ค. 2567 (สมุดสถิติรายปีประเทศไทย 2568 ตาราง 18.13)' },
        registry: { ...registry, allocatable: N(registry.allocatable) },
        by_status: byStatus.map((r) => ({ ...r, amount: N(r.amount) })),
        offers: { ...offers, avg_rate: offers.avg_rate == null ? null : N(offers.avg_rate), per_listing: flow.listed ? Math.round((offers.offers / flow.listed) * 10) / 10 : null },
        flow: { ...flow, signed_amount: N(flow.signed_amount), avg_days_to_sign: flow.avg_days_to_sign == null ? null : N(flow.avg_days_to_sign), match_rate_pct: flow.listed ? Math.round((flow.matched / flow.listed) * 1000) / 10 : null },
        grades, listings,
      };
    }));
  }));
}

module.exports = { attach };
