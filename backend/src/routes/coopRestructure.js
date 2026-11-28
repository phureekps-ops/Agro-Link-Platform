/**
 * ตลาดสินเชื่อระหว่างสหกรณ์ — ปรับโครงสร้างหนี้ (db/grant_coop_lending_restructure.sql · lib/coopRestructure.js)
 *
 *   ผู้กู้      GET  /coop-lending/market/listings/:id/restructure   สถานะหนี้ของสัญญา + คำขอทั้งหมด
 *              POST /coop-lending/market/listings/:id/restructure   ยื่นคำขอ {new_due_date, new_rate_pct?, reason, repayment_plan, file_id?}
 *              POST /coop-lending/market/restructure/:rid/withdraw
 *   ผู้ให้กู้   GET  /savings/market/restructure                      คำขอของสัญญาที่ตนเป็นผู้ให้กู้
 *              POST /savings/market/restructure/:rid/decide          {decision: Approved|Rejected, approval_ref, note}
 *   ทั้งสองฝ่าย GET .../market/restructure/:rid/amendment.docx       บันทึกแก้ไขเพิ่มเติมสัญญา (เมื่ออนุมัติครบแล้ว) · .../file มติที่แนบ
 *   ผู้ดูแล/กรมฯ GET /admin/coop-lending/market/restructure · /gov/coop-lending/market/restructure-summary
 *
 *   ผู้ให้กู้ทุกรายในสัญญาต้องอนุมัติ — รายใดไม่อนุมัติ คำขอตก · เมื่อครบ: คิดดอกเบี้ยถึงวันนี้ด้วยเงื่อนไขเดิม → เลื่อนวันครบกำหนด
 *   (ไม่ร่นวัน) → ปรับอัตรา (ถ้าขอ) → ปลดระงับวงเงินที่ถูกระงับเพราะค้างชำระ → แจ้งทุกฝ่าย
 */
const L = require('../lib/coopLending');
const RS = require('../lib/coopRestructure');

function attach({ savings, borrower, admin, gov }, H) {
  const { wrap, fail, tx, orgTx, text, isUuid, actorOf, objectStorage, govTx, officerScope } = H;
  const adminTx = (req, fn) => tx('platform', req.subject.subjectId, fn);
  const notify = (c, orgId, message, listingId) => c.query(
    `INSERT INTO coop_lending.dunning_notice (target_org_id, kind, notice_date, message, listing_id) VALUES ($1,'agreement',$2,$3,$4)`,
    [orgId, L.todayBangkok(), message.slice(0, 1000), listingId],
  );

  /** สถานะหนี้ของสัญญา: รายการที่ค้าง วันครบกำหนด อัตราดอกเบี้ย ผู้ให้กู้ */
  async function debtState(c, ag) {
    const today = L.todayBangkok();
    const facilities = (await c.query(
      `SELECT f.facility_id, f.rate_pct, f.status, f.suspended_reason, f.lender_org_id, o.org_name AS lender_name
         FROM coop_lending.facility f JOIN identity.organization o ON o.org_id = f.lender_org_id WHERE f.agreement_id = $1 ORDER BY o.org_name`, [ag.agreement_id],
    )).rows;
    const items = facilities.length ? (await c.query(
      `SELECT item_id, facility_id, description, seller_name, loan_due_date, principal_outstanding, interest_unpaid FROM coop_lending.disbursement_item
        WHERE facility_id = ANY($1::uuid[]) AND purpose <> 'asset' AND principal_outstanding > 0 ORDER BY loan_due_date`, [facilities.map((f) => f.facility_id)],
    )).rows : [];
    const outstanding = L.round2(items.reduce((a, i) => a + Number(i.principal_outstanding), 0));
    const overdue = L.round2(items.filter((i) => L.toDateStr(i.loan_due_date) < today).reduce((a, i) => a + Number(i.principal_outstanding), 0));
    const dues = items.map((i) => L.toDateStr(i.loan_due_date)).sort();
    return {
      today, facilities: facilities.map((f) => ({ ...f, rate_pct: Number(f.rate_pct) })), outstanding, overdue,
      items: items.map((i) => ({ ...i, loan_due_date: L.toDateStr(i.loan_due_date), principal_outstanding: Number(i.principal_outstanding), interest_unpaid: Number(i.interest_unpaid) })),
      earliest_due: dues[0] || null, latest_due: dues[dues.length - 1] || null, max_rate: facilities.length ? Math.max(...facilities.map((f) => Number(f.rate_pct))) : null,
    };
  }
  async function requestsOf(c, where, params) {
    const rows = (await c.query(
      `SELECT r.*, ag.agreement_no, l.title AS listing_title, o.org_name AS borrower_name
         FROM coop_lending.restructure_request r JOIN coop_lending.loan_agreement ag ON ag.agreement_id = r.agreement_id
         JOIN coop_lending.loan_listing l ON l.listing_id = r.listing_id JOIN identity.organization o ON o.org_id = r.borrower_org_id
        WHERE ${where} ORDER BY r.created_at DESC LIMIT 200`, params,
    )).rows;
    if (!rows.length) return [];
    const lenders = (await c.query(
      `SELECT al.agreement_id, al.lender_org_id, o.org_name FROM coop_lending.agreement_lender al JOIN identity.organization o ON o.org_id = al.lender_org_id
        WHERE al.agreement_id = ANY($1::uuid[])`, [[...new Set(rows.map((r) => r.agreement_id))]],
    )).rows;
    const votes = (await c.query('SELECT * FROM coop_lending.restructure_vote WHERE request_id = ANY($1::uuid[])', [rows.map((r) => r.request_id)])).rows;
    return rows.map((r) => ({
      ...r, new_due_date: L.toDateStr(r.new_due_date), new_rate_pct: r.new_rate_pct === null ? null : Number(r.new_rate_pct), outstanding: Number(r.outstanding), overdue: Number(r.overdue),
      has_file: Boolean(r.file_id),
      lenders: lenders.filter((x) => x.agreement_id === r.agreement_id).map((x) => {
        const v = votes.find((y) => y.request_id === r.request_id && y.lender_org_id === x.lender_org_id);
        return { lender_org_id: x.lender_org_id, org_name: x.org_name, decision: v ? v.decision : null, approval_ref: v ? v.approval_ref : null, note: v ? v.note : null, decided_at: v ? v.decided_at : null };
      }),
    }));
  }
  async function signedAgreement(c, listingId, borrowerOrg) {
    if (!isUuid(listingId)) fail(404, 'listing_not_found');
    const ag = (await c.query(
      `SELECT ag.*, l.title, l.borrower_org_id FROM coop_lending.loan_agreement ag JOIN coop_lending.loan_listing l ON l.listing_id = ag.listing_id
        WHERE ag.listing_id = $1 AND l.borrower_org_id = $2`, [listingId, borrowerOrg],
    )).rows[0];
    if (!ag) fail(404, 'listing_not_found');
    if (ag.status !== 'Signed') fail(409, 'agreement_not_signed');
    return ag;
  }

  // ================================================================ ผู้กู้
  borrower.get('/market/listings/:id/restructure', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => {
      if (!isUuid(req.params.id)) fail(404, 'listing_not_found');
      const ag = (await c.query(
        `SELECT ag.* FROM coop_lending.loan_agreement ag JOIN coop_lending.loan_listing l ON l.listing_id = ag.listing_id WHERE ag.listing_id = $1 AND l.borrower_org_id = $2`,
        [req.params.id, req.org.org_id],
      )).rows[0];
      if (!ag || ag.status !== 'Signed') return { eligible: false, requests: [] };
      const st = await debtState(c, ag);
      return { eligible: st.outstanding > 0, state: st, max_months: RS.MAX_MONTHS, requests: await requestsOf(c, 'r.agreement_id = $1', [ag.agreement_id]) };
    }));
  }));
  borrower.post('/market/listings/:id/restructure', wrap(async (req, res) => {
    const b = req.body || {};
    res.status(201).json(await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      const ag = await signedAgreement(c, req.params.id, req.org.org_id);
      await c.query('SELECT 1 FROM coop_lending.loan_agreement WHERE agreement_id = $1 FOR UPDATE', [ag.agreement_id]);
      if ((await c.query(`SELECT 1 FROM coop_lending.restructure_request WHERE agreement_id = $1 AND status = 'Pending'`, [ag.agreement_id])).rows[0]) fail(409, 'restructure_already_pending');
      const st = await debtState(c, ag);
      const p = { new_due_date: b.new_due_date, new_rate_pct: b.new_rate_pct === '' || b.new_rate_pct === undefined ? null : b.new_rate_pct };
      const errors = RS.validate(p, st);
      if (errors.length) fail(400, errors[0], { errors, earliest_due: st.earliest_due, max_rate: st.max_rate });
      let fileId = null;
      if (b.file_id) {
        if (!isUuid(b.file_id)) fail(400, 'file_required');
        const f = (await c.query(
          `SELECT file_id FROM storage.file_object WHERE file_id = $1 AND ((owner_subject_type = 'organization' AND owner_subject_id = $2)
              OR (owner_subject_type = 'organization_member' AND owner_subject_id IN (SELECT member_id FROM identity.organization_member WHERE org_id = $2)))`, [b.file_id, req.org.org_id],
        )).rows[0];
        if (!f) fail(404, 'file_not_found');
        fileId = f.file_id;
      }
      const r = (await c.query(
        `INSERT INTO coop_lending.restructure_request (agreement_id, listing_id, borrower_org_id, new_due_date, new_rate_pct, reason, repayment_plan, file_id, outstanding, overdue, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [ag.agreement_id, ag.listing_id, req.org.org_id, p.new_due_date, p.new_rate_pct === null ? null : Number(p.new_rate_pct),
          text(b.reason, 'reason', { min: 10, max: 2000 }), text(b.repayment_plan, 'repayment_plan', { min: 10, max: 2000 }), fileId, st.outstanding, st.overdue, actor.key],
      )).rows[0];
      for (const f of st.facilities) {
        await notify(c, f.lender_org_id, `${req.org.org_name} ขอปรับโครงสร้างหนี้สัญญา ${ag.agreement_no}: ขยายวันครบกำหนดเป็น ${p.new_due_date}${p.new_rate_pct !== null ? ` และอัตราดอกเบี้ย ${Number(p.new_rate_pct)}% ต่อปี` : ''} — รอผู้ให้กู้ทุกรายพิจารณา`, ag.listing_id);
      }
      return (await requestsOf(c, 'r.request_id = $1', [r.request_id]))[0];
    }));
  }));
  borrower.post('/market/restructure/:rid/withdraw', wrap(async (req, res) => {
    if (!isUuid(req.params.rid)) fail(404, 'restructure_not_found');
    res.json(await orgTx(req, async (c) => {
      const r = (await c.query(`UPDATE coop_lending.restructure_request SET status = 'Withdrawn', decided_at = now() WHERE request_id = $1 AND borrower_org_id = $2 AND status = 'Pending' RETURNING *`,
        [req.params.rid, req.org.org_id])).rows[0];
      if (!r) fail(404, 'restructure_not_found');
      return r;
    }));
  }));

  // ================================================================ ผู้ให้กู้
  savings.get('/market/restructure', wrap(async (req, res) => {
    res.json(await orgTx(req, (c) => requestsOf(c, 'r.agreement_id IN (SELECT agreement_id FROM coop_lending.agreement_lender WHERE lender_org_id = $1)', [req.org.org_id])));
  }));
  savings.post('/market/restructure/:rid/decide', wrap(async (req, res) => {
    const b = req.body || {};
    if (!['Approved', 'Rejected'].includes(b.decision)) fail(400, 'invalid_decision');
    if (!isUuid(req.params.rid)) fail(404, 'restructure_not_found');
    res.json(await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      const r = (await c.query('SELECT * FROM coop_lending.restructure_request WHERE request_id = $1 FOR UPDATE', [req.params.rid])).rows[0];
      if (!r) fail(404, 'restructure_not_found');
      const lenders = (await c.query('SELECT lender_org_id FROM coop_lending.agreement_lender WHERE agreement_id = $1', [r.agreement_id])).rows.map((x) => x.lender_org_id);
      if (!lenders.includes(req.org.org_id)) fail(404, 'restructure_not_found');
      if (r.status !== 'Pending') fail(409, 'restructure_not_pending', { status: r.status });
      const ref = text(b.approval_ref, 'approval_ref', { min: 2, max: 200, allowNull: b.decision === 'Rejected' });
      const note = text(b.note, 'note', { min: b.decision === 'Rejected' ? 5 : 0, max: 2000, allowNull: b.decision === 'Approved' });
      await c.query(
        `INSERT INTO coop_lending.restructure_vote (request_id, lender_org_id, decision, approval_ref, note, decided_by) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (request_id, lender_org_id) DO UPDATE SET decision = EXCLUDED.decision, approval_ref = EXCLUDED.approval_ref, note = EXCLUDED.note, decided_by = EXCLUDED.decided_by, decided_at = now()`,
        [r.request_id, req.org.org_id, b.decision, ref, note, actor.key],
      );
      const ag = (await c.query('SELECT * FROM coop_lending.loan_agreement WHERE agreement_id = $1', [r.agreement_id])).rows[0];
      if (b.decision === 'Rejected') {
        await c.query(`UPDATE coop_lending.restructure_request SET status = 'Rejected', decided_at = now() WHERE request_id = $1`, [r.request_id]);
        await notify(c, r.borrower_org_id, `${req.org.org_name} ไม่อนุมัติคำขอปรับโครงสร้างหนี้สัญญา ${ag.agreement_no}: ${note}`, r.listing_id);
        return (await requestsOf(c, 'r.request_id = $1', [r.request_id]))[0];
      }
      const votes = (await c.query(`SELECT lender_org_id FROM coop_lending.restructure_vote WHERE request_id = $1 AND decision = 'Approved'`, [r.request_id])).rows.map((x) => x.lender_org_id);
      if (lenders.every((x) => votes.includes(x))) await apply(c, r, ag, actor);
      else await notify(c, r.borrower_org_id, `${req.org.org_name} อนุมัติคำขอปรับโครงสร้างหนี้แล้ว (${votes.length}/${lenders.length} ราย) — รอผู้ให้กู้รายอื่น`, r.listing_id);
      return (await requestsOf(c, 'r.request_id = $1', [r.request_id]))[0];
    }));
  }));

  /** ผู้ให้กู้ครบทุกราย: คิดดอกเบี้ยถึงวันนี้ด้วยเงื่อนไขเดิม แล้วจึงเลื่อนวันครบกำหนด/ปรับอัตรา */
  async function apply(c, r, ag, actor) {
    const today = L.todayBangkok();
    const settings = await L.loadSettings(c);
    const facilities = (await c.query(
      `SELECT f.*, o.org_name AS lender_name FROM coop_lending.facility f JOIN identity.organization o ON o.org_id = f.lender_org_id
        WHERE f.agreement_id = $1 FOR UPDATE OF f`, [r.agreement_id],
    )).rows;
    for (const f of facilities) await L.accrueFacility(c, f, today, settings);
    const items = (await c.query(
      `SELECT item_id, facility_id, description, loan_due_date, principal_outstanding FROM coop_lending.disbursement_item
        WHERE facility_id = ANY($1::uuid[]) AND purpose <> 'asset' AND principal_outstanding > 0 FOR UPDATE`, [facilities.map((f) => f.facility_id)],
    )).rows;
    const newRate = r.new_rate_pct === null ? null : Number(r.new_rate_pct);
    const pl = RS.plan(items, facilities, { new_due_date: L.toDateStr(r.new_due_date), new_rate_pct: newRate });
    for (const x of pl.itemChanges) {
      await c.query('UPDATE coop_lending.disbursement_item SET loan_due_date = $2, updated_at = now() WHERE item_id = $1', [x.item_id, x.to]);
      await L.logEvent(c, { itemId: x.item_id, facilityId: x.facility_id, actor: actor.key, action: 'restructured', detail: { request_id: r.request_id, from: x.from, to: x.to } });
    }
    for (const x of pl.rateChanges) {
      await c.query('UPDATE coop_lending.facility SET rate_pct = $2 WHERE facility_id = $1', [x.facility_id, x.to]);
      await L.logEvent(c, { facilityId: x.facility_id, actor: actor.key, action: 'rate_restructured', detail: { request_id: r.request_id, from: x.from, to: x.to } });
    }
    // วงเงินที่ถูกระงับเพราะค้างชำระ → กลับมาใช้ได้ (ระงับด้วยเหตุอื่นคงไว้)
    const reactivated = (await c.query(
      `UPDATE coop_lending.facility SET status = 'Active', suspended_reason = NULL
        WHERE agreement_id = $1 AND status = 'Suspended' AND suspended_reason LIKE '%ค้างชำระ%' RETURNING facility_id`, [r.agreement_id],
    )).rows.map((x) => x.facility_id);
    for (const fid of reactivated) await L.logEvent(c, { facilityId: fid, actor: actor.key, action: 'facility_reactivated', detail: { request_id: r.request_id } });
    const descr = Object.fromEntries(items.map((i) => [i.item_id, i.description]));
    const snapshot = {
      accrued_to: today,
      items: pl.itemChanges.map((x) => ({ ...x, description: descr[x.item_id] })),
      rates: pl.rateChanges, reactivated_facilities: reactivated, principal: pl.principal,
    };
    await c.query(`UPDATE coop_lending.restructure_request SET status = 'Approved', decided_at = now(), applied_snapshot = $2 WHERE request_id = $1`, [r.request_id, JSON.stringify(snapshot)]);
    const msg = `ปรับโครงสร้างหนี้สัญญา ${ag.agreement_no} มีผลแล้ว: เงินต้น ${pl.principal.toLocaleString('th-TH')} บาท ครบกำหนดใหม่ ${L.toDateStr(r.new_due_date)}`
      + `${pl.rateChanges.length ? ` · อัตราดอกเบี้ย ${newRate}% ต่อปี` : ''} — ดาวน์โหลดบันทึกแก้ไขเพิ่มเติมสัญญาเพื่อลงนาม`;
    await notify(c, r.borrower_org_id, msg, r.listing_id);
    for (const f of facilities) await notify(c, f.lender_org_id, msg, r.listing_id);
  }

  // ================================================================ เอกสาร
  async function canSee(c, r, orgId) {
    if (r.borrower_org_id === orgId) return true;
    return Boolean((await c.query('SELECT 1 FROM coop_lending.agreement_lender WHERE agreement_id = $1 AND lender_org_id = $2', [r.agreement_id, orgId])).rows[0]);
  }
  async function amendment(req, res) {
    if (!isUuid(req.params.rid)) fail(404, 'restructure_not_found');
    const buf = await orgTx(req, async (c) => {
      const r = (await c.query('SELECT * FROM coop_lending.restructure_request WHERE request_id = $1', [req.params.rid])).rows[0];
      if (!r || !(await canSee(c, r, req.org.org_id))) fail(404, 'restructure_not_found');
      if (r.status !== 'Approved') fail(409, 'restructure_not_approved');
      const ag = (await c.query('SELECT * FROM coop_lending.loan_agreement WHERE agreement_id = $1', [r.agreement_id])).rows[0];
      const listing = (await c.query('SELECT title FROM coop_lending.loan_listing WHERE listing_id = $1', [r.listing_id])).rows[0];
      const bo = (await c.query(
        `SELECT o.org_name, bp.signatories FROM identity.organization o LEFT JOIN coop_lending.borrower_profile bp ON bp.org_id = o.org_id WHERE o.org_id = $1`, [r.borrower_org_id],
      )).rows[0];
      const lenders = (await c.query(
        `SELECT o.org_name, lp.signatories, v.approval_ref FROM coop_lending.agreement_lender al JOIN identity.organization o ON o.org_id = al.lender_org_id
           LEFT JOIN coop_lending.lender_profile lp ON lp.org_id = al.lender_org_id
           LEFT JOIN coop_lending.restructure_vote v ON v.request_id = $2 AND v.lender_org_id = al.lender_org_id
          WHERE al.agreement_id = $1 ORDER BY al.amount DESC`, [r.agreement_id, r.request_id],
      )).rows;
      return RS.amendmentDocx({ request: r, agreement: ag, listing, borrower: bo, lenders, snapshot: r.applied_snapshot });
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="restructure-amendment.docx"');
    res.send(buf);
  }
  async function attachment(req, res) {
    if (!isUuid(req.params.rid)) fail(404, 'restructure_not_found');
    await orgTx(req, async (c) => {
      const r = (await c.query('SELECT * FROM coop_lending.restructure_request WHERE request_id = $1', [req.params.rid])).rows[0];
      if (!r || !r.file_id || !(await canSee(c, r, req.org.org_id))) fail(404, 'file_not_found');
      const f = (await c.query('SELECT storage_path, content_type, original_filename FROM storage.file_object WHERE file_id = $1', [r.file_id])).rows[0];
      res.setHeader('Content-Type', f.content_type);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.original_filename)}"`);
      res.send(await objectStorage.readFile(f.storage_path));
    });
  }
  for (const router of [borrower, savings]) {
    router.get('/market/restructure/:rid/amendment.docx', wrap(amendment));
    router.get('/market/restructure/:rid/file', wrap(attachment));
  }

  // ================================================================ ผู้ดูแล / กรมฯ
  admin.get('/market/restructure', wrap(async (req, res) => {
    res.json(await adminTx(req, (c) => requestsOf(c, 'true', [])));
  }));
  gov.get('/market/restructure-summary', wrap(async (req, res) => {
    res.json(await govTx(req, async (c) => {
      const { province } = await officerScope(c, req);
      return (await c.query(
        `SELECT r.status, COUNT(*)::int AS n, COALESCE(SUM(r.outstanding), 0)::numeric AS outstanding
           FROM coop_lending.restructure_request r JOIN registry.cooperative_profile cp ON cp.org_id = r.borrower_org_id AND ($1::text IS NULL OR cp.province_code = $1)
          GROUP BY 1`, [province],
      )).rows.map((x) => ({ ...x, outstanding: Number(x.outstanding) }));
    }));
  }));
}

module.exports = { attach };
