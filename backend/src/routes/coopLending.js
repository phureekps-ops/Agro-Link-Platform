/**
 * สินเชื่อระหว่างสหกรณ์ (สหกรณ์ออมทรัพย์ → สหกรณ์การเกษตร)
 * ตาราง: backend/db/grant_coop_lending.sql · ตรรกะ: lib/coopLending.js · ธนาคาร: lib/bankGateway.js
 *
 * 4 router:
 *   /savings        พอร์ทัลสหกรณ์ออมทรัพย์ (org_type 'SavingsCooperative')
 *   /coop-lending   สหกรณ์การเกษตรผู้กู้ (org_type 'Cooperative')
 *   /farmer-lending เกษตรกรยืนยันรับของ/งานเสร็จ/ขายผลผลิตจริง
 *   /admin/coop-lending  ผู้ดูแลแพลตฟอร์ม: ค่าธรรมเนียม วันหยุด บัญชีแพลตฟอร์ม
 *
 * หลักสำคัญ:
 *   - ไม่มีการโอนเงินก้อน: เงินออกเป็นรายการตามหลักฐาน และจ่ายตรงถึงผู้ขาย
 *   - ทุกการโอนสั่งผ่าน lib/bankGateway.js หลังผู้จัดทำและผู้อนุมัติ "คนละคน" (บัญชีหลักขององค์กร = 1 คน,
 *     บัญชีเจ้าหน้าที่แต่ละคน = 1 คน) — ฐานข้อมูลบังคับซ้ำด้วย CHECK (approved_by <> prepared_by)
 *   - ไม่มี RLS ในสคีมา coop_lending: ทุก query ต้องกรองด้วย org_id/farmer_id ของผู้เรียก
 */
const express = require('express');
const crypto = require('crypto');

const { withSessionContext } = require('../db/pool');
const {
  requireAuth, requireOrganizationOrStaff, resolveEffectiveOrgSubject, requireFarmer, requirePlatform,
} = require('../middleware/auth');
const L = require('../lib/coopLending');
const bank = require('../lib/bankGateway');
const objectStorage = require('../lib/storage');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

class HttpError extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra || {}; }
}
const fail = (status, code, extra) => { throw new HttpError(status, code, extra); };

const CONSTRAINT_ERRORS = {
  uq_cl_item_source: 'source_already_used',
  uq_cl_item_doc: 'doc_no_already_used',
  uq_cl_evidence_hash: 'evidence_file_already_used',
  uq_cl_application_open: 'application_already_open',
  uq_cl_asset_serial: 'serial_no_already_financed',
  uq_cl_bank_account: 'bank_account_exists',
  bank_transfer_check: 'approver_must_differ_from_preparer',
};
function wrap(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, ...err.extra });
      if (err.code === '23505') return res.status(409).json({ error: CONSTRAINT_ERRORS[err.constraint] || 'duplicate', constraint: err.constraint });
      if (err.code === '23514') return res.status(400).json({ error: CONSTRAINT_ERRORS[err.constraint] || 'invalid_value', constraint: err.constraint });
      if (err.code === '22P02' || err.code === '22003') return res.status(400).json({ error: 'invalid_value' });
      return next(err);
    }
  };
}
async function tx(subjectType, subjectId, fn) {
  return withSessionContext(subjectType, subjectId, async (c) => {
    await c.query('BEGIN');
    try {
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  });
}
const orgTx = (req, fn) => tx('organization', req.org.org_id, fn);

const num = (v, name, { min = 0, max = 1e13, allowNull = false } = {}) => {
  if ((v === null || v === undefined || v === '') && allowNull) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(400, 'invalid_number', { field: name });
  return L.round2(n);
};
const text = (v, name, { min = 0, max = 500, allowNull = false } = {}) => {
  if ((v === null || v === undefined || String(v).trim() === '') && allowNull) return null;
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (s.length < min || s.length > max) fail(400, 'invalid_text', { field: name, min, max });
  return s;
};
const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ผู้กระทำ: บัญชีหลักขององค์กร หรือเจ้าหน้าที่รายบุคคล (ใช้แยกผู้จัดทำ/ผู้อนุมัติ) */
async function actorOf(c, req) {
  if (req.actingStaff) {
    const m = (await c.query('SELECT full_name FROM identity.organization_member WHERE member_id = $1', [req.actingStaff.memberId])).rows[0];
    return { key: `member:${req.actingStaff.memberId}`, label: m ? m.full_name : 'เจ้าหน้าที่' };
  }
  return { key: `org:${req.org.org_id}`, label: 'บัญชีหลักขององค์กร' };
}

function orgGuard(orgType, staffBusinessRoles) {
  return async (req, res, next) => {
    try {
      const okStaff = await resolveEffectiveOrgSubject(req, res, staffBusinessRoles);
      if (!okStaff) return undefined;
      const org = await withSessionContext('organization', req.subject.subjectId, async (c) => (await c.query(
        'SELECT org_id, org_name, org_type, kyb_status, tax_id, region_code FROM identity.organization WHERE org_id = $1', [req.subject.subjectId],
      )).rows[0]);
      if (!org) return res.status(403).json({ error: 'organization_not_found' });
      if (org.org_type !== orgType) return res.status(403).json({ error: 'wrong_org_type', required: orgType, org_type: org.org_type });
      if (org.kyb_status !== 'Verified') return res.status(403).json({ error: 'kyb_not_verified', kyb_status: org.kyb_status, org_name: org.org_name });
      req.org = org;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// ส่วนที่ใช้ร่วม: บัญชีธนาคาร คำสั่งโอน
// ---------------------------------------------------------------------------

/** เพิ่ม/ตรวจบัญชีธนาคาร — ชื่อที่ธนาคารยืนยันต้องตรงกับชื่อเจ้าของในระบบ */
async function addBankAccount(c, {
  ownerType, ownerId, purpose, body, expectedName, addedBy,
}) {
  const bankCode = String(body.bank_code || '').trim();
  const accountNo = String(body.account_no || '').replace(/[\s-]/g, '');
  const accountName = text(body.account_name, 'account_name', { min: 2, max: 160 });
  if (!/^[0-9]{3}$/.test(bankCode)) fail(400, 'invalid_bank_code');
  if (!/^[0-9]{10,15}$/.test(accountNo)) fail(400, 'invalid_account_no');
  const gw = bank.driver();
  const v = await gw.verifyAccount({ bank_code: bankCode, account_no: accountNo, account_name: accountName });
  let status = v.status;
  let note = v.note;
  if (status === 'Verified' && expectedName && !L.namesMatch(v.account_name, expectedName)) {
    status = 'Failed';
    note = `ชื่อบัญชี "${v.account_name}" ไม่ตรงกับชื่อในระบบ "${expectedName}"`;
  }
  const row = (await c.query(
    `INSERT INTO coop_lending.bank_account (owner_type, owner_id, purpose, bank_code, account_no, account_name, verified_name,
            verification_status, verification_note, verified_at, gateway, added_by_org_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $8 = 'Verified' THEN now() END, $10, $11)
     ON CONFLICT (owner_type, COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), bank_code, account_no, purpose)
     DO UPDATE SET account_name = EXCLUDED.account_name, verified_name = EXCLUDED.verified_name,
                   verification_status = EXCLUDED.verification_status, verification_note = EXCLUDED.verification_note,
                   verified_at = EXCLUDED.verified_at, gateway = EXCLUDED.gateway
     RETURNING *`,
    [ownerType, ownerId, purpose, bankCode, accountNo, accountName, v.account_name, status, note, gw.name, addedBy],
  )).rows[0];
  return row;
}
const maskAcc = (a) => (a ? { ...a, account_no_masked: `xxx-x-${String(a.account_no).slice(-5)}` } : a);

async function verifiedAccount(c, accountId, ownerType, ownerId, purposes) {
  if (!isUuid(accountId)) fail(400, 'account_required');
  const a = (await c.query('SELECT * FROM coop_lending.bank_account WHERE account_id = $1', [accountId])).rows[0];
  if (!a || a.owner_type !== ownerType || (ownerId && a.owner_id !== ownerId) || !purposes.includes(a.purpose)) fail(404, 'account_not_found');
  if (a.verification_status !== 'Verified') fail(409, 'account_not_verified');
  return a;
}

async function createTransfer(c, t, actor) {
  const row = (await c.query(
    `INSERT INTO coop_lending.bank_transfer (kind, initiator_org_id, from_account_id, to_account_id, amount, penalty_amount, fee_amount,
            memo, facility_id, asset_loan_id, idempotency_key, prepared_by, prepared_by_label, gateway)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [t.kind, t.initiatorOrgId, t.fromAccountId, t.toAccountId, L.round2(t.amount), L.round2(t.penalty || 0), L.round2(t.fee || 0),
      t.memo, t.facilityId || null, t.assetLoanId || null, `cl-${crypto.randomUUID()}`, actor.key, actor.label, bank.driver().name],
  )).rows[0];
  for (const it of t.items || []) {
    await c.query('INSERT INTO coop_lending.transfer_item (transfer_id, item_id, amount, penalty) VALUES ($1,$2,$3,$4)',
      [row.transfer_id, it.item_id, it.amount, it.penalty || 0]);
  }
  await L.logEvent(c, { facilityId: t.facilityId, assetLoanId: t.assetLoanId, actor: actor.key, action: `transfer_prepared:${t.kind}`, detail: { transfer_id: row.transfer_id, amount: row.amount } });
  return row;
}

async function openTransferFor(c, itemId, kind) {
  return (await c.query(
    `SELECT t.transfer_id FROM coop_lending.transfer_item ti JOIN coop_lending.bank_transfer t ON t.transfer_id = ti.transfer_id
      WHERE ti.item_id = $1 AND t.kind = $2 AND t.status IN ('PendingApproval', 'Submitted')`, [itemId, kind],
  )).rows[0];
}

/** ผลหลังธนาคารยืนยันว่าโอนสำเร็จ — แยกตามชนิดการโอน */
async function settleTransfer(c, t, actor) {
  const settings = await L.loadSettings(c);
  const holidays = await L.loadHolidays(c);
  const today = L.todayBangkok();
  const items = (await c.query(
    `SELECT ti.amount AS t_amount, ti.penalty AS t_penalty, i.* FROM coop_lending.transfer_item ti
       JOIN coop_lending.disbursement_item i ON i.item_id = ti.item_id WHERE ti.transfer_id = $1 FOR UPDATE OF i`, [t.transfer_id],
  )).rows;
  if (t.kind === 'disbursement') {
    const acDue = L.addBusinessDays(today, settings.ac_sla_days, holidays);
    for (const it of items) {
      if (it.status !== 'EvidenceComplete') fail(409, 'item_state_changed', { item_id: it.item_id, status: it.status });
      const prog = (await c.query('SELECT p.tranche_tenor_days FROM coop_lending.facility f JOIN coop_lending.program p ON p.program_id = f.program_id WHERE f.facility_id = $1', [it.facility_id])).rows[0];
      const isAsset = it.purpose === 'asset';
      await c.query(
        `UPDATE coop_lending.disbursement_item SET status = 'Funded', funded_at = now(), ac_due_date = $2, sc_penalty = $3,
                principal_outstanding = $4, interest_accrued_to = $5, loan_due_date = $6, updated_at = now()
          WHERE item_id = $1`,
        [it.item_id, acDue, it.t_penalty, isAsset ? 0 : it.amount, today, isAsset ? null : L.addDays(today, prog.tranche_tenor_days)],
      );
      if (isAsset) await activateAssetLoan(c, it.source_id, today);
      await L.logEvent(c, { itemId: it.item_id, facilityId: it.facility_id, actor: actor.key, action: 'funded', detail: { transfer_id: t.transfer_id, ac_due_date: acDue, sc_penalty: Number(it.t_penalty) } });
    }
  } else if (t.kind === 'seller_payment') {
    for (const it of items) {
      if (it.status !== 'Funded') fail(409, 'item_state_changed', { item_id: it.item_id, status: it.status });
      await c.query(`UPDATE coop_lending.disbursement_item SET status = 'Paid', paid_at = now(), ac_penalty = $2, updated_at = now() WHERE item_id = $1`,
        [it.item_id, it.t_penalty]);
      await L.logEvent(c, { itemId: it.item_id, facilityId: it.facility_id, actor: actor.key, action: 'paid_to_seller', detail: { transfer_id: t.transfer_id, bank_ref: t.bank_ref, ac_penalty: Number(it.t_penalty) } });
    }
  } else if (t.kind === 'repayment') {
    const facility = (await c.query('SELECT * FROM coop_lending.facility WHERE facility_id = $1 FOR UPDATE', [t.facility_id])).rows[0];
    const loans = await L.accrueFacility(c, facility, today, settings);
    const alloc = L.allocateRepayment(Number(t.amount), loans.map((i) => ({
      item_id: i.item_id, loan_due_date: L.toDateStr(i.loan_due_date), interest_unpaid: Number(i.interest_unpaid), principal_outstanding: Number(i.principal_outstanding),
    })));
    if (alloc.leftover > 0) fail(409, 'repayment_exceeds_debt', { leftover: alloc.leftover });
    for (const a of alloc.allocation) {
      await c.query(
        `UPDATE coop_lending.disbursement_item SET interest_unpaid = interest_unpaid - $2, principal_outstanding = principal_outstanding - $3, updated_at = now()
          WHERE item_id = $1`, [a.item_id, a.interest, a.principal],
      );
    }
    await c.query(
      `INSERT INTO coop_lending.repayment (facility_id, transfer_id, amount, interest_part, principal_part, allocation, paid_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`, [t.facility_id, t.transfer_id, t.amount, alloc.interest, alloc.principal, JSON.stringify(alloc.allocation), today],
    );
    await L.logEvent(c, { facilityId: t.facility_id, actor: actor.key, action: 'repayment', detail: { amount: Number(t.amount), interest: alloc.interest, principal: alloc.principal } });
  } else if (t.kind === 'installment') {
    const rows = (await c.query('SELECT * FROM coop_lending.repayment_schedule WHERE asset_loan_id = $1 ORDER BY seq FOR UPDATE', [t.asset_loan_id])).rows;
    const due = L.installmentsDue(rows, today, Number(settings.late_penalty_pct));
    let left = Number(t.amount);
    let penaltyPart = 0;
    let paidPart = 0;
    const allocation = [];
    for (const d of due) {
      if (left <= 0 || d.unpaid <= 0) continue;
      const pen = Math.min(left, d.penalty);
      left = L.round2(left - pen);
      const pay = Math.min(left, d.unpaid);
      left = L.round2(left - pay);
      penaltyPart = L.round2(penaltyPart + pen);
      paidPart = L.round2(paidPart + pay);
      allocation.push({ seq: d.seq, penalty: L.round2(pen), installment: L.round2(pay) });
      await c.query(
        `UPDATE coop_lending.repayment_schedule SET paid_amount = paid_amount + $3, penalty_paid = penalty_paid + $4,
                paid_at = CASE WHEN paid_amount + $3 >= installment THEN $5::date ELSE paid_at END
          WHERE asset_loan_id = $1 AND seq = $2`, [t.asset_loan_id, d.seq, L.round2(pay), L.round2(pen), today],
      );
    }
    if (left > 0) fail(409, 'payment_exceeds_installments', { leftover: left });
    const remaining = (await c.query('SELECT COALESCE(SUM(installment - paid_amount), 0)::numeric AS r FROM coop_lending.repayment_schedule WHERE asset_loan_id = $1', [t.asset_loan_id])).rows[0].r;
    if (Number(remaining) <= 0.004) await c.query(`UPDATE coop_lending.asset_loan SET status = 'Closed' WHERE asset_loan_id = $1`, [t.asset_loan_id]);
    await c.query(
      `INSERT INTO coop_lending.repayment (facility_id, asset_loan_id, transfer_id, amount, penalty_part, principal_part, allocation, paid_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [t.facility_id, t.asset_loan_id, t.transfer_id, t.amount, penaltyPart, paidPart, JSON.stringify(allocation), today],
    );
    await L.logEvent(c, { assetLoanId: t.asset_loan_id, facilityId: t.facility_id, actor: actor.key, action: 'installment_paid', detail: { amount: Number(t.amount), penalty: penaltyPart } });
  }
}

async function activateAssetLoan(c, assetLoanId, today) {
  const a = (await c.query('SELECT * FROM coop_lending.asset_loan WHERE asset_loan_id = $1 FOR UPDATE', [assetLoanId])).rows[0];
  if (!a || a.status !== 'Approved') fail(409, 'asset_loan_not_approved');
  const sched = L.annuitySchedule({
    principal: Number(a.loan_amount), ratePct: Number(a.rate_pct), termMonths: a.term_months, intervalMonths: a.interval_months, gracePeriods: a.grace_periods, startDate: today,
  });
  for (const r of sched) {
    await c.query(
      `INSERT INTO coop_lending.repayment_schedule (asset_loan_id, seq, due_date, principal, interest, installment) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (asset_loan_id, seq) DO UPDATE SET due_date = EXCLUDED.due_date, principal = EXCLUDED.principal, interest = EXCLUDED.interest, installment = EXCLUDED.installment`,
      [assetLoanId, r.seq, r.due_date, r.principal, r.interest, r.installment],
    );
  }
  await c.query(`UPDATE coop_lending.asset_loan SET status = 'Active', funded_at = $2 WHERE asset_loan_id = $1`, [assetLoanId, today]);
}

/** ตรวจซ้ำก่อนส่งธนาคาร (สถานะอาจเปลี่ยนระหว่างผู้จัดทำกับผู้อนุมัติ) */
async function precheckTransfer(c, t) {
  const items = (await c.query(
    `SELECT i.item_id, i.status FROM coop_lending.transfer_item ti JOIN coop_lending.disbursement_item i ON i.item_id = ti.item_id
      WHERE ti.transfer_id = $1 FOR UPDATE OF i`, [t.transfer_id],
  )).rows;
  const need = { disbursement: 'EvidenceComplete', seller_payment: 'Funded' }[t.kind];
  for (const it of items) if (need && it.status !== need) fail(409, 'item_state_changed', { item_id: it.item_id, status: it.status });
  if (t.kind === 'repayment') {
    const f = (await c.query('SELECT * FROM coop_lending.facility WHERE facility_id = $1', [t.facility_id])).rows[0];
    const debt = await debtOf(c, f);
    if (Number(t.amount) > debt.total + 0.004) fail(409, 'repayment_exceeds_debt', { total: debt.total });
  }
  if (t.kind === 'installment') {
    const settings = await L.loadSettings(c);
    const rows = (await c.query('SELECT * FROM coop_lending.repayment_schedule WHERE asset_loan_id = $1 ORDER BY seq', [t.asset_loan_id])).rows;
    const max = L.round2(L.installmentsDue(rows, L.todayBangkok(), Number(settings.late_penalty_pct)).reduce((s, d) => s + d.unpaid + d.penalty, 0));
    if (Number(t.amount) > max + 0.004) fail(409, 'payment_exceeds_installments', { max });
  }
}

/** ผู้อนุมัติ (คนละคนกับผู้จัดทำ) สั่งโอนผ่านธนาคาร */
async function approveTransfer(c, req, transferId) {
  if (!isUuid(transferId)) fail(404, 'transfer_not_found');
  const t = (await c.query('SELECT * FROM coop_lending.bank_transfer WHERE transfer_id = $1 AND initiator_org_id = $2 FOR UPDATE', [transferId, req.org.org_id])).rows[0];
  if (!t) fail(404, 'transfer_not_found');
  if (t.status !== 'PendingApproval') fail(409, 'transfer_not_pending', { status: t.status });
  const actor = await actorOf(c, req);
  if (actor.key === t.prepared_by) fail(409, 'approver_must_differ_from_preparer');
  const from = (await c.query('SELECT * FROM coop_lending.bank_account WHERE account_id = $1', [t.from_account_id])).rows[0];
  const to = (await c.query('SELECT * FROM coop_lending.bank_account WHERE account_id = $1', [t.to_account_id])).rows[0];
  if (from.verification_status !== 'Verified' || to.verification_status !== 'Verified') fail(409, 'account_not_verified');
  await precheckTransfer(c, t);
  const gw = bank.driver();
  const r = await gw.transfer({
    from, to, amount: Number(t.amount), memo: t.memo, idempotencyKey: t.idempotency_key,
  });
  const status = r.status === 'Succeeded' ? 'Succeeded' : (r.status === 'Submitted' ? 'Submitted' : 'Failed');
  const updated = (await c.query(
    `UPDATE coop_lending.bank_transfer SET status = $2, approved_by = $3, approved_by_label = $4, approved_at = now(), bank_ref = $5,
            failure_reason = $6, settled_at = CASE WHEN $2 = 'Succeeded' THEN now() END, gateway = $7
      WHERE transfer_id = $1 RETURNING *`,
    [t.transfer_id, status, actor.key, actor.label, r.bank_ref, r.failure_reason, gw.name],
  )).rows[0];
  if (status === 'Succeeded') {
    // เงินออกจากธนาคารแล้ว: ถ้าบันทึกผลไม่สำเร็จ ห้าม rollback คำสั่งโอน — เก็บไว้ให้ผู้ดูแลกระทบยอด
    await c.query('SAVEPOINT settle');
    try {
      await settleTransfer(c, updated, actor);
      await c.query('RELEASE SAVEPOINT settle');
    } catch (err) {
      await c.query('ROLLBACK TO SAVEPOINT settle');
      await c.query('UPDATE coop_lending.bank_transfer SET failure_reason = $2 WHERE transfer_id = $1', [t.transfer_id, `โอนสำเร็จแต่บันทึกผลไม่สำเร็จ: ${err.code || err.message}`]);
      await L.logEvent(c, { facilityId: t.facility_id, actor: actor.key, action: 'settle_error', detail: { transfer_id: t.transfer_id, error: err.code || err.message } });
      updated.settle_error = err.code || err.message;
    }
  }
  await L.logEvent(c, { facilityId: t.facility_id, assetLoanId: t.asset_loan_id, actor: actor.key, action: `transfer_${status.toLowerCase()}:${t.kind}`, detail: { transfer_id: t.transfer_id, bank_ref: r.bank_ref, failure_reason: r.failure_reason } });
  return updated;
}

async function cancelTransfer(c, req, transferId) {
  if (!isUuid(transferId)) fail(404, 'transfer_not_found');
  const actor = await actorOf(c, req);
  const t = (await c.query(
    `UPDATE coop_lending.bank_transfer SET status = 'Cancelled' WHERE transfer_id = $1 AND initiator_org_id = $2 AND status = 'PendingApproval' RETURNING *`,
    [transferId, req.org.org_id],
  )).rows[0];
  if (!t) fail(404, 'transfer_not_found_or_not_pending');
  await L.logEvent(c, { facilityId: t.facility_id, actor: actor.key, action: `transfer_cancelled:${t.kind}`, detail: { transfer_id: t.transfer_id } });
  return t;
}

async function listTransfers(c, orgId, status) {
  return (await c.query(
    `SELECT t.*, fa.account_name AS from_name, fa.bank_code AS from_bank, right(fa.account_no, 5) AS from_tail,
            ta.account_name AS to_name, ta.bank_code AS to_bank, right(ta.account_no, 5) AS to_tail,
            (SELECT json_agg(json_build_object('item_id', ti.item_id, 'amount', ti.amount, 'penalty', ti.penalty, 'description', i.description, 'seller_name', i.seller_name))
               FROM coop_lending.transfer_item ti JOIN coop_lending.disbursement_item i ON i.item_id = ti.item_id WHERE ti.transfer_id = t.transfer_id) AS items
       FROM coop_lending.bank_transfer t
       JOIN coop_lending.bank_account fa ON fa.account_id = t.from_account_id
       JOIN coop_lending.bank_account ta ON ta.account_id = t.to_account_id
      WHERE t.initiator_org_id = $1 AND ($2::text IS NULL OR t.status = $2)
      ORDER BY t.created_at DESC LIMIT 200`, [orgId, status || null],
  )).rows;
}

async function notices(c, orgId) {
  return (await c.query(
    `SELECT * FROM coop_lending.dunning_notice WHERE target_org_id = $1 ORDER BY created_at DESC LIMIT 100`, [orgId],
  )).rows;
}

/** รายการเบิกพร้อมรายละเอียดสำหรับแสดงผล (กรองด้วยเงื่อนไขของผู้เรียก) */
async function itemRows(c, where, params) {
  return (await c.query(
    `SELECT i.*, b.org_name AS borrower_name, l.org_name AS lender_name, f.full_name AS farmer_name,
            pa.account_name AS payout_name, pa.bank_code AS payout_bank, right(pa.account_no, 5) AS payout_tail, pa.verification_status AS payout_status,
            (SELECT COALESCE(json_agg(json_build_object('evidence_id', e.evidence_id, 'kind', e.kind, 'file_id', e.file_id, 'doc_no', e.doc_no, 'note', e.note, 'created_at', e.created_at) ORDER BY e.created_at), '[]')
               FROM coop_lending.evidence e WHERE e.item_id = i.item_id) AS evidence,
            (SELECT COALESCE(json_agg(json_build_object('unit_id', pu.unit_id, 'area_rai', pu.area_rai, 'commodity_code', pu.commodity_code)), '[]')
               FROM coop_lending.item_plot ip JOIN registry.production_unit pu ON pu.unit_id = ip.unit_id WHERE ip.item_id = i.item_id) AS plots
       FROM coop_lending.disbursement_item i
       JOIN identity.organization b ON b.org_id = i.borrower_org_id
       JOIN identity.organization l ON l.org_id = i.lender_org_id
       LEFT JOIN identity.farmer f ON f.farmer_id = i.farmer_id
       LEFT JOIN coop_lending.bank_account pa ON pa.account_id = i.payout_account_id
      WHERE ${where} ORDER BY i.created_at DESC LIMIT 300`, params,
  )).rows.map(decorateItem);
}
function decorateItem(i) {
  const today = L.todayBangkok();
  const kinds = (i.evidence || []).map((e) => e.kind);
  const miss = L.missingEvidence(i, kinds, i.payout_status === 'Verified');
  const sc = i.sc_due_date ? L.toDateStr(i.sc_due_date) : null;
  const ac = i.ac_due_date ? L.toDateStr(i.ac_due_date) : null;
  return {
    ...i,
    missing: miss,
    sc_due_date: sc,
    ac_due_date: ac,
    loan_due_date: i.loan_due_date ? L.toDateStr(i.loan_due_date) : null,
    sc_late: i.status === 'EvidenceComplete' && sc && today > sc,
    ac_late: i.status === 'Funded' && ac && today > ac,
  };
}


/** เปิดไฟล์หลักฐาน — ผู้ให้กู้และผู้กู้ของรายการนั้นเท่านั้น (ไฟล์ใน storage เปิดได้เฉพาะเจ้าของ จึงต้องผ่านเส้นทางนี้) */
function evidenceFileRoute(column) {
  return wrap(async (req, res) => {
    if (!isUuid(req.params.id)) fail(404, 'evidence_not_found');
    const f = await orgTx(req, async (c) => (await c.query(
      `SELECT fo.storage_path, fo.content_type, fo.original_filename FROM coop_lending.evidence e
         JOIN coop_lending.disbursement_item i ON i.item_id = e.item_id JOIN storage.file_object fo ON fo.file_id = e.file_id
        WHERE e.evidence_id = $1 AND i.${column} = $2`, [req.params.id, req.org.org_id],
    )).rows[0]);
    if (!f) fail(404, 'evidence_not_found');
    const buf = await objectStorage.readFile(f.storage_path);
    res.setHeader('Content-Type', f.content_type);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.original_filename)}"`);
    res.send(buf);
  });
}

// ===========================================================================
// /savings — พอร์ทัลสหกรณ์ออมทรัพย์
// ===========================================================================
const savings = express.Router();
savings.use(requireAuth, requireOrganizationOrStaff, orgGuard('SavingsCooperative', ['SavingsCooperative']));

savings.get('/overview', wrap(async (req, res) => {
  const out = await orgTx(req, async (c) => {
    const orgId = req.org.org_id;
    const prog = (await c.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total_limit) FILTER (WHERE status = 'Open'), 0)::numeric AS open_limit FROM coop_lending.program WHERE lender_org_id = $1`, [orgId])).rows[0];
    const fac = (await c.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(limit_amount), 0)::numeric AS approved FROM coop_lending.facility WHERE lender_org_id = $1 AND status <> 'Closed'`, [orgId])).rows[0];
    const out2 = (await c.query(
      `SELECT COALESCE(SUM(principal_outstanding), 0)::numeric AS tranche_outstanding,
              COUNT(*) FILTER (WHERE status = 'EvidenceComplete')::int AS queue,
              COUNT(*) FILTER (WHERE status = 'EvidenceComplete' AND sc_due_date < $2)::int AS late,
              COUNT(*) FILTER (WHERE status = 'EvidenceComplete' AND satellite_result = 'review' AND satellite_ack_by IS NULL)::int AS satellite_review
         FROM coop_lending.disbursement_item WHERE lender_org_id = $1`, [orgId, L.todayBangkok()],
    )).rows[0];
    const asset = (await c.query(
      `SELECT COALESCE(SUM(s.principal - LEAST(s.paid_amount, s.installment) * s.principal / NULLIF(s.installment, 0)), 0)::numeric AS asset_outstanding
         FROM coop_lending.repayment_schedule s JOIN coop_lending.asset_loan a ON a.asset_loan_id = s.asset_loan_id
        WHERE a.lender_org_id = $1 AND a.status = 'Active'`, [orgId],
    )).rows[0];
    const apps = (await c.query(`SELECT COUNT(*)::int AS n FROM coop_lending.application a JOIN coop_lending.program p ON p.program_id = a.program_id WHERE p.lender_org_id = $1 AND a.status = 'Submitted'`, [orgId])).rows[0];
    const assets = (await c.query(`SELECT COUNT(*)::int AS n FROM coop_lending.asset_loan WHERE lender_org_id = $1 AND status = 'Submitted'`, [orgId])).rows[0];
    const pend = (await c.query(`SELECT COUNT(*)::int AS n FROM coop_lending.bank_transfer WHERE initiator_org_id = $1 AND status = 'PendingApproval'`, [orgId])).rows[0];
    const unread = (await c.query('SELECT COUNT(*)::int AS n FROM coop_lending.dunning_notice WHERE target_org_id = $1 AND read_at IS NULL', [orgId])).rows[0];
    const settings = await L.loadSettings(c);
    return {
      org: req.org, acting_staff: req.actingStaff || null, bank: bank.info(),
      settings: { fee_pct: Number(settings.fee_pct), sc_sla_days: settings.sc_sla_days, ac_sla_days: settings.ac_sla_days, late_penalty_pct: Number(settings.late_penalty_pct) },
      programs: prog.n, open_limit: Number(prog.open_limit), facilities: fac.n, approved: Number(fac.approved),
      tranche_outstanding: Number(out2.tranche_outstanding), asset_outstanding: L.round2(Number(asset.asset_outstanding)),
      queue: out2.queue, late: out2.late, satellite_review: out2.satellite_review,
      pending_applications: apps.n, pending_asset_loans: assets.n, pending_transfers: pend.n, unread_notices: unread.n,
    };
  });
  res.json(out);
}));

// เจ้าหน้าที่รายบุคคล (ใช้เป็นผู้จัดทำ/ผู้อนุมัติการโอนคนที่สอง)
savings.get('/staff', wrap(async (req, res) => {
  res.json(await orgTx(req, async (c) => (await c.query(
    `SELECT m.member_id, m.full_name, m.status, m.created_at, sr.role_code
       FROM identity.organization_member m
       LEFT JOIN identity.subject_role sr ON sr.subject_type = 'organization_member' AND sr.subject_id = m.member_id
      WHERE m.org_id = $1 AND m.auth_subject_id IS NOT NULL ORDER BY m.created_at DESC`, [req.org.org_id],
  )).rows));
}));
savings.post('/staff', wrap(async (req, res) => {
  if (req.actingStaff && !['coop.admin', 'coop.manager'].includes(req.actingStaff.roleCode)) fail(403, 'only_admin_can_manage_staff');
  const b = req.body || {};
  const fullName = text(b.full_name, 'full_name', { min: 3, max: 120 });
  const nid = String(b.national_id || '').replace(/\D/g, '');
  if (nid.length !== 13) fail(400, 'invalid_national_id');
  const role = ['coop.credit_officer', 'coop.manager', 'coop.admin'].includes(b.role_code) ? b.role_code : fail(400, 'invalid_role_code');
  const authSubjectId = `oidc|staff-${crypto.randomUUID()}`;
  const out = await orgTx(req, async (c) => {
    const actor = await actorOf(c, req);
    const id = (await c.query('SELECT identity.register_staff_member($1,$2,$3,$4,$5,$6) AS id',
      [req.org.org_id, fullName, crypto.createHash('sha256').update(nid).digest('hex'), authSubjectId, role, actor.label])).rows[0].id;
    return { member_id: id, auth_subject_id: authSubjectId };
  });
  res.status(201).json(out);
}));
savings.post('/staff/:id/deactivate', wrap(async (req, res) => {
  if (req.actingStaff && !['coop.admin', 'coop.manager'].includes(req.actingStaff.roleCode)) fail(403, 'only_admin_can_manage_staff');
  if (!isUuid(req.params.id)) fail(404, 'staff_not_found');
  await orgTx(req, async (c) => {
    const own = (await c.query('SELECT 1 FROM identity.organization_member WHERE member_id = $1 AND org_id = $2', [req.params.id, req.org.org_id])).rows[0];
    if (!own) fail(404, 'staff_not_found');
    await c.query('SELECT identity.deactivate_staff_member($1)', [req.params.id]);
  });
  res.json({ status: 'Inactive' });
}));

savings.get('/bank-accounts', wrap(async (req, res) => {
  res.json(await orgTx(req, async (c) => (await c.query(
    `SELECT * FROM coop_lending.bank_account WHERE owner_type = 'organization' AND owner_id = $1 ORDER BY created_at`, [req.org.org_id],
  )).rows.map(maskAcc)));
}));
savings.post('/bank-accounts', wrap(async (req, res) => {
  const row = await orgTx(req, (c) => addBankAccount(c, {
    ownerType: 'organization', ownerId: req.org.org_id, purpose: 'operating', body: req.body || {}, expectedName: req.org.org_name, addedBy: req.org.org_id,
  }));
  res.status(201).json(maskAcc(row));
}));

function programBody(b, partial = false) {
  const out = {};
  if (!partial || b.name !== undefined) out.name = text(b.name, 'name', { min: 2, max: 160 });
  if (!partial || b.purposes !== undefined) {
    const p = Array.isArray(b.purposes) ? [...new Set(b.purposes)] : [];
    if (!p.length || p.some((x) => !L.PURPOSES.includes(x))) fail(400, 'invalid_purposes');
    out.purposes = p;
  }
  if (!partial || b.total_limit !== undefined) out.total_limit = num(b.total_limit, 'total_limit', { min: 1000 });
  if (!partial || b.per_borrower_limit !== undefined) out.per_borrower_limit = num(b.per_borrower_limit, 'per_borrower_limit', { min: 1000 });
  if (!partial || b.rate_pct !== undefined) out.rate_pct = num(b.rate_pct, 'rate_pct', { min: 0, max: 30 });
  const opt = [['tranche_tenor_days', 7, 730], ['grace_days', 0, 120], ['asset_min_down_pct', 0, 90], ['asset_max_months', 3, 120], ['asset_max_income_ratio_pct', 5, 100]];
  for (const [k, mn, mx] of opt) if (b[k] !== undefined && b[k] !== '') out[k] = num(b[k], k, { min: mn, max: mx });
  for (const k of ['per_farmer_limit', 'per_seller_limit']) if (b[k] !== undefined) out[k] = num(b[k], k, { min: 1, allowNull: true });
  if (b.conditions !== undefined) out.conditions = text(b.conditions, 'conditions', { max: 2000, allowNull: true });
  if (b.province_codes !== undefined) out.province_codes = Array.isArray(b.province_codes) && b.province_codes.length ? b.province_codes.map(String).slice(0, 80) : null;
  if (b.status !== undefined) out.status = ['Draft', 'Open', 'Paused', 'Closed'].includes(b.status) ? b.status : fail(400, 'invalid_status');
  return out;
}
savings.get('/programs', wrap(async (req, res) => {
  res.json(await orgTx(req, async (c) => (await c.query(
    `SELECT p.*, (SELECT COALESCE(SUM(f.limit_amount), 0) FROM coop_lending.facility f WHERE f.program_id = p.program_id AND f.status <> 'Closed')::numeric AS committed
       FROM coop_lending.program p WHERE lender_org_id = $1 ORDER BY created_at DESC`, [req.org.org_id],
  )).rows));
}));
savings.post('/programs', wrap(async (req, res) => {
  const p = programBody(req.body || {});
  const keys = Object.keys(p);
  const row = await orgTx(req, async (c) => {
    const r = (await c.query(
      `INSERT INTO coop_lending.program (lender_org_id, ${keys.join(', ')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
      [req.org.org_id, ...keys.map((k) => p[k])],
    )).rows[0];
    await L.logEvent(c, { actor: (await actorOf(c, req)).key, action: 'program_created', detail: { program_id: r.program_id } });
    return r;
  });
  res.status(201).json(row);
}));
savings.patch('/programs/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) fail(404, 'program_not_found');
  const p = programBody(req.body || {}, true);
  const keys = Object.keys(p);
  if (!keys.length) fail(400, 'nothing_to_update');
  const row = await orgTx(req, async (c) => {
    const r = (await c.query(
      `UPDATE coop_lending.program SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now()
        WHERE program_id = $1 AND lender_org_id = $2 RETURNING *`, [req.params.id, req.org.org_id, ...keys.map((k) => p[k])],
    )).rows[0];
    if (!r) fail(404, 'program_not_found');
    const committed = Number((await c.query(`SELECT COALESCE(SUM(limit_amount), 0) AS s FROM coop_lending.facility WHERE program_id = $1 AND status <> 'Closed'`, [r.program_id])).rows[0].s);
    if (Number(r.total_limit) < committed) fail(409, 'limit_below_committed', { committed });
    return r;
  });
  res.json(row);
}));

savings.get('/applications', wrap(async (req, res) => {
  res.json(await orgTx(req, async (c) => (await c.query(
    `SELECT a.*, p.name AS program_name, o.org_name AS borrower_name, o.region_code,
            cp.province_code, pv.province_name_th,
            (SELECT COUNT(*) FROM identity.farmer_org_relationship r WHERE r.org_id = a.borrower_org_id AND r.status = 'active')::int AS verified_members,
            (SELECT COALESCE(SUM(f.limit_amount), 0) FROM coop_lending.facility f WHERE f.borrower_org_id = a.borrower_org_id AND f.status <> 'Closed')::numeric AS other_facilities_total,
            (SELECT COUNT(*) FROM coop_lending.facility f WHERE f.borrower_org_id = a.borrower_org_id AND f.status = 'Suspended')::int AS suspended_facilities
       FROM coop_lending.application a
       JOIN coop_lending.program p ON p.program_id = a.program_id
       JOIN identity.organization o ON o.org_id = a.borrower_org_id
       LEFT JOIN registry.cooperative_profile cp ON cp.org_id = o.org_id
       LEFT JOIN registry.province pv ON pv.province_code = cp.province_code
      WHERE p.lender_org_id = $1 ORDER BY (a.status = 'Submitted') DESC, a.created_at DESC`, [req.org.org_id],
  )).rows));
}));
savings.post('/applications/:id/approve', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) fail(404, 'application_not_found');
  const b = req.body || {};
  const out = await orgTx(req, async (c) => {
    const a = (await c.query(
      `SELECT a.*, p.lender_org_id, p.total_limit, p.per_borrower_limit, p.rate_pct, p.status AS program_status, p.purposes
         FROM coop_lending.application a JOIN coop_lending.program p ON p.program_id = a.program_id
        WHERE a.application_id = $1 AND p.lender_org_id = $2 FOR UPDATE OF a, p`, [req.params.id, req.org.org_id],
    )).rows[0];
    if (!a) fail(404, 'application_not_found');
    if (a.status !== 'Submitted') fail(409, 'application_already_decided');
    const limit = num(b.limit_amount ?? a.requested_amount, 'limit_amount', { min: 1000 });
    if (limit > Number(a.per_borrower_limit)) fail(400, 'over_per_borrower_limit', { max: Number(a.per_borrower_limit) });
    const committed = Number((await c.query(`SELECT COALESCE(SUM(limit_amount), 0) AS s FROM coop_lending.facility WHERE program_id = $1 AND status <> 'Closed'`, [a.program_id])).rows[0].s);
    if (committed + limit > Number(a.total_limit)) fail(409, 'program_limit_exhausted', { available: L.round2(Number(a.total_limit) - committed) });
    const until = b.available_until && L.isDate(b.available_until) ? b.available_until : L.addMonths(L.todayBangkok(), 12);
    if (until <= L.todayBangkok()) fail(400, 'invalid_available_until');
    const purposeLimits = {};
    for (const p of a.purposes) if (b.purpose_limits && b.purpose_limits[p] !== undefined && b.purpose_limits[p] !== '') purposeLimits[p] = num(b.purpose_limits[p], `purpose_limits.${p}`, { min: 0 });
    const actor = await actorOf(c, req);
    await c.query(`UPDATE coop_lending.application SET status = 'Approved', decided_at = now(), decided_by = $2 WHERE application_id = $1`, [a.application_id, actor.key]);
    const f = (await c.query(
      `INSERT INTO coop_lending.facility (application_id, program_id, lender_org_id, borrower_org_id, limit_amount, purpose_limits, rate_pct, available_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [a.application_id, a.program_id, req.org.org_id, a.borrower_org_id, limit, JSON.stringify(purposeLimits), a.rate_pct, until],
    )).rows[0];
    await L.logEvent(c, { facilityId: f.facility_id, actor: actor.key, action: 'facility_approved', detail: { limit } });
    return f;
  });
  res.status(201).json(out);
}));
savings.post('/applications/:id/reject', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) fail(404, 'application_not_found');
  const reason = text((req.body || {}).reason, 'reason', { min: 3, max: 500 });
  const out = await orgTx(req, async (c) => {
    const actor = await actorOf(c, req);
    const r = (await c.query(
      `UPDATE coop_lending.application a SET status = 'Rejected', decided_reason = $3, decided_at = now(), decided_by = $4
         FROM coop_lending.program p WHERE p.program_id = a.program_id AND a.application_id = $1 AND p.lender_org_id = $2 AND a.status = 'Submitted'
       RETURNING a.*`, [req.params.id, req.org.org_id, reason, actor.key],
    )).rows[0];
    if (!r) fail(404, 'application_not_found_or_decided');
    return r;
  });
  res.json(out);
}));

savings.get('/facilities', wrap(async (req, res) => {
  res.json(await orgTx(req, async (c) => (await c.query(
    `SELECT f.*, o.org_name AS borrower_name, p.name AS program_name,
            (SELECT COALESCE(SUM(principal_outstanding), 0) FROM coop_lending.disbursement_item i WHERE i.facility_id = f.facility_id)::numeric AS tranche_outstanding,
            (SELECT COALESCE(SUM(interest_unpaid), 0) FROM coop_lending.disbursement_item i WHERE i.facility_id = f.facility_id)::numeric AS interest_unpaid
       FROM coop_lending.facility f JOIN identity.organization o ON o.org_id = f.borrower_org_id JOIN coop_lending.program p ON p.program_id = f.program_id
      WHERE f.lender_org_id = $1 ORDER BY f.created_at DESC`, [req.org.org_id],
  )).rows));
}));
for (const ACTION of ['suspend', 'reactivate']) savings.post(`/facilities/:id/${ACTION}`, wrap(async (req, res) => {
  req.params.action = ACTION;
  if (!isUuid(req.params.id)) fail(404, 'facility_not_found');
  const suspend = req.params.action === 'suspend';
  const reason = suspend ? text((req.body || {}).reason, 'reason', { min: 3, max: 300 }) : null;
  const out = await orgTx(req, async (c) => {
    const actor = await actorOf(c, req);
    const r = (await c.query(
      `UPDATE coop_lending.facility SET status = $3, suspended_reason = $4 WHERE facility_id = $1 AND lender_org_id = $2 AND status = $5 RETURNING *`,
      [req.params.id, req.org.org_id, suspend ? 'Suspended' : 'Active', reason, suspend ? 'Active' : 'Suspended'],
    )).rows[0];
    if (!r) fail(404, 'facility_not_found_or_state');
    await L.logEvent(c, { facilityId: r.facility_id, actor: actor.key, action: suspend ? 'facility_suspended' : 'facility_reactivated', detail: { reason } });
    return r;
  });
  res.json(out);
}));

savings.get('/items', wrap(async (req, res) => {
  const scope = req.query.scope === 'all' ? null : ['EvidencePending', 'EvidenceComplete', 'Funded', 'Disputed'];
  res.json(await orgTx(req, (c) => itemRows(c, 'i.lender_org_id = $1 AND ($2::text[] IS NULL OR i.status = ANY($2))', [req.org.org_id, scope])));
}));
savings.get('/items/:id/events', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) fail(404, 'item_not_found');
  res.json(await orgTx(req, async (c) => {
    const own = (await c.query('SELECT 1 FROM coop_lending.disbursement_item WHERE item_id = $1 AND lender_org_id = $2', [req.params.id, req.org.org_id])).rows[0];
    if (!own) fail(404, 'item_not_found');
    return (await c.query('SELECT actor, action, detail, created_at FROM coop_lending.event WHERE item_id = $1 ORDER BY event_id', [req.params.id])).rows;
  }));
}));
for (const ACTION of ['return', 'reject', 'ack-satellite']) savings.post(`/items/:id/${ACTION}`, wrap(async (req, res) => {
  req.params.action = ACTION;
  if (!isUuid(req.params.id)) fail(404, 'item_not_found');
  const { action } = req.params;
  const reason = action === 'ack-satellite' ? null : text((req.body || {}).reason, 'reason', { min: 3, max: 500 });
  const out = await orgTx(req, async (c) => {
    const actor = await actorOf(c, req);
    const it = (await c.query('SELECT * FROM coop_lending.disbursement_item WHERE item_id = $1 AND lender_org_id = $2 FOR UPDATE', [req.params.id, req.org.org_id])).rows[0];
    if (!it) fail(404, 'item_not_found');
    if (!['EvidencePending', 'EvidenceComplete', 'Disputed'].includes(it.status)) fail(409, 'item_not_reviewable', { status: it.status });
    if (await openTransferFor(c, it.item_id, 'disbursement')) fail(409, 'transfer_pending_cancel_first');
    let r;
    if (action === 'ack-satellite') {
      r = (await c.query('UPDATE coop_lending.disbursement_item SET satellite_ack_by = $2 WHERE item_id = $1 RETURNING *', [it.item_id, actor.key])).rows[0];
    } else if (action === 'return') {
      r = (await c.query(
        `UPDATE coop_lending.disbursement_item SET status = 'Draft', returned_reason = $2, evidence_complete_at = NULL, sc_due_date = NULL, submitted_at = NULL, updated_at = now()
          WHERE item_id = $1 RETURNING *`, [it.item_id, reason],
      )).rows[0];
    } else {
      r = (await c.query(`UPDATE coop_lending.disbursement_item SET status = 'Rejected', rejected_reason = $2, updated_at = now() WHERE item_id = $1 RETURNING *`, [it.item_id, reason])).rows[0];
      if (it.purpose === 'asset') await c.query(`UPDATE coop_lending.asset_loan SET status = 'Cancelled' WHERE asset_loan_id = $1 AND status = 'Approved'`, [it.source_id]);
    }
    await L.logEvent(c, { itemId: it.item_id, facilityId: it.facility_id, actor: actor.key, action: `sc_${action}`, detail: { reason } });
    return r;
  });
  res.json(out);
}));

/** ผู้จัดทำ: เตรียมโอนเงินเข้าบัญชีเฉพาะของสหกรณ์การเกษตร (หลายรายการในวงเงินเดียวกัน = โอนครั้งเดียว) */
savings.post('/transfers/prepare', wrap(async (req, res) => {
  const ids = Array.isArray((req.body || {}).item_ids) ? [...new Set(req.body.item_ids)] : [];
  if (!ids.length || ids.length > 50 || !ids.every(isUuid)) fail(400, 'item_ids_required');
  const fromId = (req.body || {}).from_account_id;
  const out = await orgTx(req, async (c) => {
    const actor = await actorOf(c, req);
    const from = await verifiedAccount(c, fromId, 'organization', req.org.org_id, ['operating']);
    const items = (await c.query(
      'SELECT * FROM coop_lending.disbursement_item WHERE item_id = ANY($1) AND lender_org_id = $2 ORDER BY created_at FOR UPDATE', [ids, req.org.org_id],
    )).rows;
    if (items.length !== ids.length) fail(404, 'item_not_found');
    const facilityIds = [...new Set(items.map((i) => i.facility_id))];
    if (facilityIds.length !== 1) fail(400, 'items_must_share_facility');
    const facility = (await c.query('SELECT * FROM coop_lending.facility WHERE facility_id = $1', [facilityIds[0]])).rows[0];
    if (!facility.dedicated_account_id) fail(409, 'borrower_dedicated_account_missing');
    const to = (await c.query('SELECT * FROM coop_lending.bank_account WHERE account_id = $1', [facility.dedicated_account_id])).rows[0];
    if (to.verification_status !== 'Verified') fail(409, 'borrower_dedicated_account_not_verified');
    const settings = await L.loadSettings(c);
    const today = L.todayBangkok();
    const lines = [];
    for (const it of items) {
      if (it.status !== 'EvidenceComplete') fail(409, 'item_not_ready', { item_id: it.item_id, status: it.status });
      if (it.satellite_result === 'review' && !it.satellite_ack_by) fail(409, 'satellite_review_not_acknowledged', { item_id: it.item_id });
      if (await openTransferFor(c, it.item_id, 'disbursement')) fail(409, 'transfer_already_pending', { item_id: it.item_id });
      const penalty = L.latePenalty(Number(it.amount), L.toDateStr(it.sc_due_date), today, Number(settings.late_penalty_pct));
      lines.push({ item_id: it.item_id, amount: Number(it.amount), penalty });
    }
    const principal = L.round2(lines.reduce((s, l) => s + l.amount, 0));
    const penalty = L.round2(lines.reduce((s, l) => s + l.penalty, 0));
    const fee = L.round2(principal * Number(settings.fee_pct) / 100);
    const borrower = (await c.query('SELECT org_name FROM identity.organization WHERE org_id = $1', [facility.borrower_org_id])).rows[0];
    return createTransfer(c, {
      kind: 'disbursement', initiatorOrgId: req.org.org_id, fromAccountId: from.account_id, toAccountId: to.account_id,
      amount: principal + penalty, penalty, fee, facilityId: facility.facility_id,
      memo: `เบิกเงินกู้ ${lines.length} รายการ ให้${borrower.org_name}`, items: lines,
    }, actor);
  });
  res.status(201).json(out);
}));
savings.get('/transfers', wrap(async (req, res) => { res.json(await orgTx(req, (c) => listTransfers(c, req.org.org_id, req.query.status))); }));
savings.post('/transfers/:id/approve', wrap(async (req, res) => { res.json(await orgTx(req, (c) => approveTransfer(c, req, req.params.id))); }));
savings.post('/transfers/:id/cancel', wrap(async (req, res) => { res.json(await orgTx(req, (c) => cancelTransfer(c, req, req.params.id))); }));

savings.get('/asset-loans', wrap(async (req, res) => {
  res.json(await orgTx(req, async (c) => (await c.query(
    `SELECT a.*, b.org_name AS borrower_name, s.org_name AS seller_name, f.full_name AS farmer_name,
            (SELECT json_agg(r ORDER BY r.seq) FROM coop_lending.repayment_schedule r WHERE r.asset_loan_id = a.asset_loan_id) AS schedule
       FROM coop_lending.asset_loan a JOIN identity.organization b ON b.org_id = a.borrower_org_id
       JOIN identity.organization s ON s.org_id = a.seller_org_id LEFT JOIN identity.farmer f ON f.farmer_id = a.farmer_id
      WHERE a.lender_org_id = $1 ORDER BY (a.status = 'Submitted') DESC, a.created_at DESC`, [req.org.org_id],
  )).rows));
}));
for (const ACTION of ['approve', 'reject']) savings.post(`/asset-loans/:id/${ACTION}`, wrap(async (req, res) => {
  req.params.action = ACTION;
  if (!isUuid(req.params.id)) fail(404, 'asset_loan_not_found');
  const approve = req.params.action === 'approve';
  const reason = approve ? null : text((req.body || {}).reason, 'reason', { min: 3, max: 500 });
  const out = await orgTx(req, async (c) => {
    const actor = await actorOf(c, req);
    const r = (await c.query(
      `UPDATE coop_lending.asset_loan SET status = $3, decided_reason = $4, decided_at = now(), decided_by = $5
        WHERE asset_loan_id = $1 AND lender_org_id = $2 AND status = 'Submitted' RETURNING *`,
      [req.params.id, req.org.org_id, approve ? 'Approved' : 'Rejected', reason, actor.key],
    )).rows[0];
    if (!r) fail(404, 'asset_loan_not_found_or_decided');
    await L.logEvent(c, { assetLoanId: r.asset_loan_id, facilityId: r.facility_id, actor: actor.key, action: `asset_loan_${req.params.action}`, detail: { reason } });
    return r;
  });
  res.json(out);
}));

savings.get('/repayments', wrap(async (req, res) => {
  res.json(await orgTx(req, async (c) => (await c.query(
    `SELECT r.*, o.org_name AS borrower_name, t.bank_ref FROM coop_lending.repayment r
       JOIN coop_lending.facility f ON f.facility_id = r.facility_id JOIN identity.organization o ON o.org_id = f.borrower_org_id
       JOIN coop_lending.bank_transfer t ON t.transfer_id = r.transfer_id
      WHERE f.lender_org_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [req.org.org_id],
  )).rows));
}));

/** ค่าธรรมเนียมแพลตฟอร์ม: % ของยอดที่โอนแต่ละงวด รวมรายเดือน หักที่ชำระแล้ว */
savings.get('/fees', wrap(async (req, res) => {
  res.json(await orgTx(req, async (c) => {
    const months = (await c.query(
      `SELECT to_char(settled_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') AS month, SUM(amount - penalty_amount)::numeric AS disbursed, SUM(fee_amount)::numeric AS fee
         FROM coop_lending.bank_transfer WHERE initiator_org_id = $1 AND kind = 'disbursement' AND status = 'Succeeded'
        GROUP BY 1 ORDER BY 1 DESC`, [req.org.org_id],
    )).rows;
    const paid = Number((await c.query(`SELECT COALESCE(SUM(amount), 0) AS s FROM coop_lending.bank_transfer WHERE initiator_org_id = $1 AND kind = 'platform_fee' AND status = 'Succeeded'`, [req.org.org_id])).rows[0].s);
    const total = L.round2(months.reduce((s, m) => s + Number(m.fee), 0));
    const settings = await L.loadSettings(c);
    return { fee_pct: Number(settings.fee_pct), months, total_fee: total, paid: L.round2(paid), outstanding: L.round2(total - paid), platform_account_ready: Boolean(settings.platform_account_id) };
  }));
}));
savings.post('/fees/prepare', wrap(async (req, res) => {
  const amount = num((req.body || {}).amount, 'amount', { min: 0.01 });
  const out = await orgTx(req, async (c) => {
    const actor = await actorOf(c, req);
    const from = await verifiedAccount(c, (req.body || {}).from_account_id, 'organization', req.org.org_id, ['operating']);
    const settings = await L.loadSettings(c);
    if (!settings.platform_account_id) fail(409, 'platform_account_not_set');
    const total = Number((await c.query(`SELECT COALESCE(SUM(fee_amount), 0) AS s FROM coop_lending.bank_transfer WHERE initiator_org_id = $1 AND kind = 'disbursement' AND status = 'Succeeded'`, [req.org.org_id])).rows[0].s);
    const paid = Number((await c.query(`SELECT COALESCE(SUM(amount), 0) AS s FROM coop_lending.bank_transfer WHERE initiator_org_id = $1 AND kind = 'platform_fee' AND status IN ('PendingApproval','Submitted','Succeeded')`, [req.org.org_id])).rows[0].s);
    if (amount > L.round2(total - paid) + 0.004) fail(409, 'over_outstanding_fee', { outstanding: L.round2(total - paid) });
    return createTransfer(c, {
      kind: 'platform_fee', initiatorOrgId: req.org.org_id, fromAccountId: from.account_id, toAccountId: settings.platform_account_id, amount, memo: 'ค่าธรรมเนียมแพลตฟอร์ม AgroLink',
    }, actor);
  });
  res.status(201).json(out);
}));

savings.get('/evidence/:id/file', evidenceFileRoute('lender_org_id'));
savings.get('/notices', wrap(async (req, res) => { res.json(await orgTx(req, (c) => notices(c, req.org.org_id))); }));
savings.post('/notices/read', wrap(async (req, res) => {
  await orgTx(req, (c) => c.query('UPDATE coop_lending.dunning_notice SET read_at = now() WHERE target_org_id = $1 AND read_at IS NULL', [req.org.org_id]));
  res.json({ ok: true });
}));

// ===========================================================================
// /coop-lending — สหกรณ์การเกษตรผู้กู้
// ===========================================================================
const borrower = express.Router();
borrower.use(requireAuth, requireOrganizationOrStaff, orgGuard('Cooperative', ['Cooperative', 'Lender']));

borrower.get('/overview', wrap(async (req, res) => {
  res.json(await orgTx(req, async (c) => {
    const orgId = req.org.org_id;
    const f = (await c.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(limit_amount), 0)::numeric AS limit_total FROM coop_lending.facility WHERE borrower_org_id = $1 AND status <> 'Closed'`, [orgId])).rows[0];
    const i = (await c.query(
      `SELECT COALESCE(SUM(principal_outstanding), 0)::numeric AS outstanding, COALESCE(SUM(interest_unpaid), 0)::numeric AS interest_unpaid,
              COUNT(*) FILTER (WHERE status = 'Funded')::int AS to_pay, COUNT(*) FILTER (WHERE status = 'Funded' AND ac_due_date < $2)::int AS late,
              COUNT(*) FILTER (WHERE status IN ('Draft', 'EvidencePending'))::int AS drafts, COUNT(*) FILTER (WHERE status = 'EvidenceComplete')::int AS waiting_sc
         FROM coop_lending.disbursement_item WHERE borrower_org_id = $1`, [orgId, L.todayBangkok()],
    )).rows[0];
    const pend = (await c.query(`SELECT COUNT(*)::int AS n FROM coop_lending.bank_transfer WHERE initiator_org_id = $1 AND status = 'PendingApproval'`, [orgId])).rows[0];
    const unread = (await c.query('SELECT COUNT(*)::int AS n FROM coop_lending.dunning_notice WHERE target_org_id = $1 AND read_at IS NULL', [orgId])).rows[0];
    const settings = await L.loadSettings(c);
    return {
      org: req.org, acting_staff: req.actingStaff || null, bank: bank.info(),
      settings: { sc_sla_days: settings.sc_sla_days, ac_sla_days: settings.ac_sla_days, late_penalty_pct: Number(settings.late_penalty_pct) },
      facilities: f.n, limit_total: Number(f.limit_total), outstanding: Number(i.outstanding), interest_unpaid: Number(i.interest_unpaid),
      to_pay: i.to_pay, late: i.late, drafts: i.drafts, waiting_sc: i.waiting_sc, pending_transfers: pend.n, unread_notices: unread.n,
    };
  }));
}));

borrower.get('/programs', wrap(async (req, res) => {
  res.json(await orgTx(req, async (c) => (await c.query(
    `SELECT p.program_id, p.name, p.purposes, p.total_limit, p.per_borrower_limit, p.rate_pct, p.tranche_tenor_days, p.grace_days,
            p.asset_min_down_pct, p.asset_max_months, p.asset_max_income_ratio_pct, p.conditions, p.province_codes,
            o.org_name AS lender_name,
            GREATEST(p.total_limit - (SELECT COALESCE(SUM(f.limit_amount), 0) FROM coop_lending.facility f WHERE f.program_id = p.program_id AND f.status <> 'Closed'), 0)::numeric AS available,
            (SELECT a.status FROM coop_lending.application a WHERE a.program_id = p.program_id AND a.borrower_org_id = $1 ORDER BY a.created_at DESC LIMIT 1) AS my_status
       FROM coop_lending.program p JOIN identity.organization o ON o.org_id = p.lender_org_id
       LEFT JOIN registry.cooperative_profile cp ON cp.org_id = $1
      WHERE p.status = 'Open' AND o.kyb_status = 'Verified'
        AND (p.province_codes IS NULL OR cp.province_code = ANY(p.province_codes) OR $2 = ANY(p.province_codes))
      ORDER BY p.rate_pct, p.created_at DESC`, [req.org.org_id, req.org.region_code || ''],
  )).rows));
}));

borrower.post('/applications', wrap(async (req, res) => {
  const b = req.body || {};
  if (!isUuid(b.program_id)) fail(400, 'program_required');
  const amount = num(b.requested_amount, 'requested_amount', { min: 1000 });
  const purposeAmounts = {};
  for (const p of L.PURPOSES) if (b.purpose_amounts && b.purpose_amounts[p]) purposeAmounts[p] = num(b.purpose_amounts[p], `purpose_amounts.${p}`, { min: 0 });
  const out = await orgTx(req, async (c) => {
    const p = (await c.query(`SELECT * FROM coop_lending.program WHERE program_id = $1 AND status = 'Open'`, [b.program_id])).rows[0];
    if (!p) fail(404, 'program_not_found');
    if (amount > Number(p.per_borrower_limit)) fail(400, 'over_per_borrower_limit', { max: Number(p.per_borrower_limit) });
    const r = (await c.query(
      `INSERT INTO coop_lending.application (program_id, borrower_org_id, requested_amount, purpose_amounts, member_count, plan_note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [p.program_id, req.org.org_id, amount, JSON.stringify(purposeAmounts), b.member_count ? Math.max(0, parseInt(b.member_count, 10) || 0) : null, text(b.plan_note, 'plan_note', { max: 3000, allowNull: true })],
    )).rows[0];
    await L.logEvent(c, { actor: (await actorOf(c, req)).key, action: 'application_submitted', detail: { application_id: r.application_id } });
    return r;
  });
  res.status(201).json(out);
}));
borrower.get('/applications', wrap(async (req, res) => {
  res.json(await orgTx(req, async (c) => (await c.query(
    `SELECT a.*, p.name AS program_name, o.org_name AS lender_name FROM coop_lending.application a
       JOIN coop_lending.program p ON p.program_id = a.program_id JOIN identity.organization o ON o.org_id = p.lender_org_id
      WHERE a.borrower_org_id = $1 ORDER BY a.created_at DESC`, [req.org.org_id],
  )).rows));
}));
borrower.post('/applications/:id/withdraw', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) fail(404, 'application_not_found');
  const r = await orgTx(req, async (c) => (await c.query(
    `UPDATE coop_lending.application SET status = 'Withdrawn', decided_at = now() WHERE application_id = $1 AND borrower_org_id = $2 AND status = 'Submitted' RETURNING *`,
    [req.params.id, req.org.org_id],
  )).rows[0]);
  if (!r) fail(404, 'application_not_found_or_decided');
  res.json(r);
}));

borrower.get('/bank-accounts', wrap(async (req, res) => {
  res.json(await orgTx(req, async (c) => (await c.query(
    `SELECT a.*, CASE a.owner_type WHEN 'farmer' THEN f.full_name ELSE o.org_name END AS owner_name
       FROM coop_lending.bank_account a LEFT JOIN identity.organization o ON a.owner_type = 'organization' AND o.org_id = a.owner_id
       LEFT JOIN identity.farmer f ON a.owner_type = 'farmer' AND f.farmer_id = a.owner_id
      WHERE (a.owner_type = 'organization' AND a.owner_id = $1) OR (a.purpose = 'payout' AND a.added_by_org_id = $1)
      ORDER BY a.purpose, a.created_at`, [req.org.org_id],
  )).rows.map(maskAcc)));
}));
borrower.post('/bank-accounts', wrap(async (req, res) => {
  const b = req.body || {};
  const purpose = ['operating', 'loan_dedicated'].includes(b.purpose) ? b.purpose : fail(400, 'invalid_purpose');
  res.status(201).json(maskAcc(await orgTx(req, (c) => addBankAccount(c, {
    ownerType: 'organization', ownerId: req.org.org_id, purpose, body: b, expectedName: req.org.org_name, addedBy: req.org.org_id,
  }))));
}));
/** บัญชีรับเงินของผู้ขาย — ชื่อบัญชีต้องตรงกับชื่อผู้ขายในระบบ (ผู้ขายองค์กรต้องผ่าน KYB, เกษตรกรต้องเป็นสมาชิก) */
borrower.post('/payout-accounts', wrap(async (req, res) => {
  const b = req.body || {};
  const sellerType = ['organization', 'farmer'].includes(b.seller_type) ? b.seller_type : fail(400, 'invalid_seller_type');
  if (!isUuid(b.seller_id)) fail(400, 'seller_required');
  res.status(201).json(maskAcc(await orgTx(req, async (c) => {
    const name = await sellerName(c, req.org.org_id, sellerType, b.seller_id);
    return addBankAccount(c, {
      ownerType: sellerType, ownerId: b.seller_id, purpose: 'payout', body: b, expectedName: name, addedBy: req.org.org_id,
    });
  })));
}));
async function sellerName(c, orgId, sellerType, sellerId) {
  if (sellerType === 'organization') {
    const o = (await c.query('SELECT org_name, kyb_status FROM identity.organization WHERE org_id = $1', [sellerId])).rows[0];
    if (!o) fail(404, 'seller_not_found');
    if (o.kyb_status !== 'Verified') fail(409, 'seller_not_verified');
    if (sellerId === orgId) fail(400, 'seller_cannot_be_borrower');
    return o.org_name;
  }
  return memberName(c, orgId, sellerId);
}
async function memberName(c, orgId, farmerId) {
  const f = (await c.query(
    `SELECT f.full_name FROM identity.farmer f JOIN identity.farmer_org_relationship r ON r.farmer_id = f.farmer_id
      WHERE f.farmer_id = $1 AND r.org_id = $2 AND r.status = 'active' LIMIT 1`, [farmerId, orgId],
  )).rows[0];
  if (!f) fail(409, 'farmer_not_verified_member');
  return f.full_name;
}

borrower.get('/facilities', wrap(async (req, res) => {
  res.json(await orgTx(req, async (c) => {
    const rows = (await c.query(
      `SELECT f.*, o.org_name AS lender_name, p.name AS program_name, p.purposes, p.tranche_tenor_days, p.grace_days,
              p.asset_min_down_pct, p.asset_max_months, p.asset_max_income_ratio_pct, p.per_farmer_limit, p.per_seller_limit,
              da.account_name AS dedicated_name, right(da.account_no, 5) AS dedicated_tail, da.verification_status AS dedicated_status,
              (SELECT COALESCE(SUM(amount), 0) FROM coop_lending.disbursement_item i WHERE i.facility_id = f.facility_id AND i.status IN ('EvidencePending','EvidenceComplete') AND i.purpose <> 'asset')::numeric AS in_review,
              (SELECT COALESCE(SUM(principal_outstanding), 0) FROM coop_lending.disbursement_item i WHERE i.facility_id = f.facility_id)::numeric AS outstanding,
              (SELECT COALESCE(SUM(interest_unpaid), 0) FROM coop_lending.disbursement_item i WHERE i.facility_id = f.facility_id)::numeric AS interest_unpaid,
              (SELECT COALESCE(SUM(a.loan_amount), 0) FROM coop_lending.asset_loan a WHERE a.facility_id = f.facility_id AND a.status IN ('Submitted','Approved','Active'))::numeric AS asset_committed
         FROM coop_lending.facility f JOIN identity.organization o ON o.org_id = f.lender_org_id JOIN coop_lending.program p ON p.program_id = f.program_id
         LEFT JOIN coop_lending.bank_account da ON da.account_id = f.dedicated_account_id
        WHERE f.borrower_org_id = $1 ORDER BY f.created_at DESC`, [req.org.org_id],
    )).rows;
    const settings = await L.loadSettings(c);
    const today = L.todayBangkok();
    return rows.map((f) => ({
      ...f,
      available: L.round2(Number(f.limit_amount) - Number(f.in_review) - Number(f.outstanding) - Number(f.asset_committed)),
      // ดอกเบี้ยถึงวันนี้ (ประมาณการ — ตัดจริงตอนชำระ)
      penalty_pct: Number(settings.late_penalty_pct),
      as_of: today,
    }));
  }));
}));
borrower.patch('/facilities/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) fail(404, 'facility_not_found');
  const b = req.body || {};
  const out = await orgTx(req, async (c) => {
    const f = (await c.query('SELECT * FROM coop_lending.facility WHERE facility_id = $1 AND borrower_org_id = $2 FOR UPDATE', [req.params.id, req.org.org_id])).rows[0];
    if (!f) fail(404, 'facility_not_found');
    let dedicated = f.dedicated_account_id;
    if (b.dedicated_account_id !== undefined) dedicated = (await verifiedAccount(c, b.dedicated_account_id, 'organization', req.org.org_id, ['loan_dedicated'])).account_id;
    const memberRate = b.member_rate_pct !== undefined ? num(b.member_rate_pct, 'member_rate_pct', { min: 0, max: 30, allowNull: true }) : f.member_rate_pct;
    return (await c.query('UPDATE coop_lending.facility SET dedicated_account_id = $2, member_rate_pct = $3 WHERE facility_id = $1 RETURNING *',
      [f.facility_id, dedicated, memberRate])).rows[0];
  });
  res.json(out);
}));

/** สมาชิกที่ยืนยันแล้ว + แปลงที่ลงทะเบียน (สำหรับผูกรายการเบิก) */
borrower.get('/members', wrap(async (req, res) => {
  res.json(await orgTx(req, async (c) => (await c.query(
    `SELECT f.farmer_id, f.full_name, f.farmer_code, r.member_no,
            (SELECT COALESCE(json_agg(json_build_object('unit_id', pu.unit_id, 'area_rai', pu.area_rai, 'commodity_code', pu.commodity_code) ORDER BY pu.created_at), '[]')
               FROM registry.production_unit pu WHERE pu.owner_farmer_id = f.farmer_id) AS plots
       FROM identity.farmer_org_relationship r JOIN identity.farmer f ON f.farmer_id = r.farmer_id
      WHERE r.org_id = $1 AND r.status = 'active' ORDER BY f.full_name LIMIT 2000`, [req.org.org_id],
  )).rows));
}));
/** ผู้ขายที่ผ่าน KYB (ผู้จำหน่ายปัจจัย/เครื่องจักร) — ค้นด้วยชื่อ */
borrower.get('/sellers', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q.length < 2) return res.json([]);
  return res.json(await orgTx(req, async (c) => (await c.query(
    `SELECT org_id, org_name, org_type FROM identity.organization
      WHERE kyb_status = 'Verified' AND org_id <> $1 AND org_name ILIKE $2 ORDER BY org_name LIMIT 30`,
    [req.org.org_id, `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`],
  )).rows));
}));
/** ต้นทางที่ใช้เบิกได้ (ยังไม่เคยเบิก) ตามวัตถุประสงค์ */
borrower.get('/sources', wrap(async (req, res) => {
  const purpose = req.query.purpose;
  const out = await orgTx(req, async (c) => {
    const used = `NOT EXISTS (SELECT 1 FROM coop_lending.disbursement_item d WHERE d.source_type = $2 AND d.source_id = x.id AND d.status NOT IN ('Rejected','Cancelled'))`;
    if (purpose === 'inputs') {
      return (await c.query(
        `SELECT * FROM (SELECT o.order_id AS id, o.farmer_id, f.full_name AS farmer_name, o.org_id AS seller_id, s.org_name AS seller_name,
                o.product_name AS label, o.quantity, o.total_price AS amount, o.status, o.requested_at AS at
           FROM marketplace.product_order o JOIN identity.organization s ON s.org_id = o.org_id
           LEFT JOIN identity.farmer f ON f.farmer_id = o.farmer_id
          WHERE o.status IN ('confirmed', 'fulfilled')
            AND (o.buyer_org_id = $1 OR o.farmer_id IN (SELECT farmer_id FROM identity.farmer_org_relationship WHERE org_id = $1 AND status = 'active'))) x
          WHERE ${used} ORDER BY at DESC LIMIT 200`, [req.org.org_id, 'product_order'],
      )).rows;
    }
    if (purpose === 'machinery_service') {
      return (await c.query(
        `SELECT * FROM (SELECT b.booking_id AS id, b.farmer_id, f.full_name AS farmer_name, b.org_id AS seller_id, s.org_name AS seller_name,
                b.label_th AS label, b.unit_price, b.price_unit, b.quantity_note, b.preferred_date, b.status, b.requested_at AS at
           FROM marketplace.machinery_booking b JOIN identity.organization s ON s.org_id = b.org_id JOIN identity.farmer f ON f.farmer_id = b.farmer_id
          WHERE b.status = 'Accepted' AND b.farmer_id IN (SELECT farmer_id FROM identity.farmer_org_relationship WHERE org_id = $1 AND status = 'active')) x
          WHERE ${used} ORDER BY at DESC LIMIT 200`, [req.org.org_id, 'machinery_booking'],
      )).rows;
    }
    if (purpose === 'procurement') {
      return (await c.query(
        `SELECT * FROM (SELECT d.delivery_id AS id, pu.owner_farmer_id AS farmer_id, f.full_name AS farmer_name, d.unit_id, d.commodity_code AS label,
                d.quantity_ton, d.unit_price, d.total_amount AS amount, d.quality_grade, d.status, d.delivered_at AS at
           FROM produce.delivery d JOIN registry.production_unit pu ON pu.unit_id = d.unit_id JOIN identity.farmer f ON f.farmer_id = pu.owner_farmer_id
          WHERE d.buyer_org_id = $1 AND d.total_amount > 0) x
          WHERE ${used} ORDER BY at DESC NULLS LAST LIMIT 200`, [req.org.org_id, 'produce_delivery'],
      )).rows;
    }
    if (purpose === 'asset') {
      return (await c.query(
        `SELECT * FROM (SELECT a.asset_loan_id AS id, a.farmer_id, f.full_name AS farmer_name, a.seller_org_id AS seller_id, s.org_name AS seller_name,
                a.asset_kind || ' ' || a.brand_model AS label, a.loan_amount AS amount, a.facility_id, a.status, a.decided_at AS at
           FROM coop_lending.asset_loan a JOIN identity.organization s ON s.org_id = a.seller_org_id LEFT JOIN identity.farmer f ON f.farmer_id = a.farmer_id
          WHERE a.borrower_org_id = $1 AND a.status = 'Approved') x
          WHERE ${used} ORDER BY at DESC LIMIT 200`, [req.org.org_id, 'asset_loan'],
      )).rows;
    }
    return fail(400, 'invalid_purpose');
  });
  res.json(out);
}));

/** สร้างรายการเบิก (Draft) — ตรวจต้นทาง ผู้ขาย วงเงิน เพดาน */
borrower.post('/items', wrap(async (req, res) => {
  const b = req.body || {};
  if (!isUuid(b.facility_id)) fail(400, 'facility_required');
  const purpose = L.PURPOSES.includes(b.purpose) ? b.purpose : fail(400, 'invalid_purpose');
  const sourceType = ['product_order', 'machinery_booking', 'produce_delivery', 'asset_loan', 'manual'].includes(b.source_type) ? b.source_type : fail(400, 'invalid_source_type');
  const expectSource = { inputs: ['product_order', 'manual'], machinery_service: ['machinery_booking', 'manual'], procurement: ['produce_delivery'], asset: ['asset_loan'] };
  if (!expectSource[purpose].includes(sourceType)) fail(400, 'source_type_not_allowed_for_purpose');
  const out = await orgTx(req, async (c) => {
    const actor = await actorOf(c, req);
    const f = (await c.query(
      `SELECT f.*, p.purposes, p.per_farmer_limit, p.per_seller_limit FROM coop_lending.facility f JOIN coop_lending.program p ON p.program_id = f.program_id
        WHERE f.facility_id = $1 AND f.borrower_org_id = $2 FOR UPDATE OF f`, [b.facility_id, req.org.org_id],
    )).rows[0];
    if (!f) fail(404, 'facility_not_found');
    if (f.status !== 'Active') fail(409, 'facility_not_active', { status: f.status, reason: f.suspended_reason });
    if (L.toDateStr(f.available_until) < L.todayBangkok()) fail(409, 'facility_expired');
    if (!f.purposes.includes(purpose)) fail(400, 'purpose_not_in_program');

    // ต้นทางกำหนดผู้ขาย เกษตรกร และยอด — ไม่ให้กรอกเองเมื่อมีต้นทางในระบบ
    let farmerId = isUuid(b.farmer_id) ? b.farmer_id : null;
    let sellerType = b.seller_type;
    let sellerId = b.seller_id;
    let amount = b.amount !== undefined ? num(b.amount, 'amount', { min: 1 }) : null;
    let sourceId = sourceType === 'manual' ? null : b.source_id;
    if (sourceType !== 'manual' && !isUuid(sourceId)) fail(400, 'source_required');
    if (sourceType === 'product_order') {
      const o = (await c.query(
        `SELECT * FROM marketplace.product_order WHERE order_id = $1 AND status IN ('confirmed','fulfilled')
            AND (buyer_org_id = $2 OR farmer_id IN (SELECT farmer_id FROM identity.farmer_org_relationship WHERE org_id = $2 AND status = 'active'))`, [sourceId, req.org.org_id],
      )).rows[0];
      if (!o) fail(404, 'order_not_found_or_not_confirmed');
      farmerId = o.farmer_id; sellerType = 'organization'; sellerId = o.org_id; amount = L.round2(Number(o.total_price));
    } else if (sourceType === 'machinery_booking') {
      const bk = (await c.query(
        `SELECT * FROM marketplace.machinery_booking WHERE booking_id = $1 AND status = 'Accepted'
            AND farmer_id IN (SELECT farmer_id FROM identity.farmer_org_relationship WHERE org_id = $2 AND status = 'active')`, [sourceId, req.org.org_id],
      )).rows[0];
      if (!bk) fail(404, 'booking_not_found_or_not_accepted');
      farmerId = bk.farmer_id; sellerType = 'organization'; sellerId = bk.org_id;
      if (!amount) fail(400, 'amount_required');
    } else if (sourceType === 'produce_delivery') {
      const d = (await c.query(
        `SELECT d.*, pu.owner_farmer_id FROM produce.delivery d JOIN registry.production_unit pu ON pu.unit_id = d.unit_id
          WHERE d.delivery_id = $1 AND d.buyer_org_id = $2 AND d.total_amount > 0`, [sourceId, req.org.org_id],
      )).rows[0];
      if (!d) fail(404, 'delivery_not_found');
      farmerId = d.owner_farmer_id; sellerType = 'farmer'; sellerId = d.owner_farmer_id; amount = L.round2(Number(d.total_amount));
      b.unit_ids = [...new Set([...(Array.isArray(b.unit_ids) ? b.unit_ids : []), d.unit_id])];
    } else if (sourceType === 'asset_loan') {
      const a = (await c.query(`SELECT * FROM coop_lending.asset_loan WHERE asset_loan_id = $1 AND borrower_org_id = $2 AND facility_id = $3 AND status = 'Approved'`,
        [sourceId, req.org.org_id, f.facility_id])).rows[0];
      if (!a) fail(404, 'asset_loan_not_approved');
      farmerId = a.farmer_id; sellerType = 'organization'; sellerId = a.seller_org_id; amount = L.round2(Number(a.loan_amount));
    } else {
      if (!['organization', 'farmer'].includes(sellerType) || !isUuid(sellerId)) fail(400, 'seller_required');
      if (!amount) fail(400, 'amount_required');
    }
    if (farmerId) await memberName(c, req.org.org_id, farmerId);
    const name = await sellerName(c, req.org.org_id, sellerType, sellerId);

    // วงเงิน: คงเหลือ = วงเงิน − ยอดรอพิจารณา − เงินต้นค้าง − สินเชื่อเครื่องจักรที่ผูกไว้ (รายการเครื่องจักรนับในสินเชื่อเครื่องจักรแล้ว)
    if (purpose !== 'asset') {
      const used = (await c.query(
        `SELECT COALESCE(SUM(CASE WHEN status IN ('Draft','EvidencePending','EvidenceComplete') THEN amount ELSE principal_outstanding END), 0)::numeric AS used,
                COALESCE(SUM(CASE WHEN status IN ('Draft','EvidencePending','EvidenceComplete') THEN amount ELSE principal_outstanding END) FILTER (WHERE purpose = $2), 0)::numeric AS used_purpose
           FROM coop_lending.disbursement_item WHERE facility_id = $1 AND purpose <> 'asset' AND status NOT IN ('Rejected','Cancelled','Disputed')`, [f.facility_id, purpose],
      )).rows[0];
      const asset = Number((await c.query(`SELECT COALESCE(SUM(loan_amount), 0) AS s FROM coop_lending.asset_loan WHERE facility_id = $1 AND status IN ('Submitted','Approved','Active')`, [f.facility_id])).rows[0].s);
      const available = L.round2(Number(f.limit_amount) - Number(used.used) - asset);
      if (amount > available) fail(409, 'over_facility_limit', { available });
      const pl = f.purpose_limits && f.purpose_limits[purpose];
      if (pl !== undefined && Number(used.used_purpose) + amount > Number(pl)) fail(409, 'over_purpose_limit', { available: L.round2(Number(pl) - Number(used.used_purpose)) });
    }
    if (farmerId && f.per_farmer_limit) {
      const s = Number((await c.query(`SELECT COALESCE(SUM(amount), 0) AS s FROM coop_lending.disbursement_item WHERE facility_id = $1 AND farmer_id = $2 AND status NOT IN ('Rejected','Cancelled')`, [f.facility_id, farmerId])).rows[0].s);
      if (s + amount > Number(f.per_farmer_limit)) fail(409, 'over_per_farmer_limit', { available: L.round2(Number(f.per_farmer_limit) - s) });
    }
    if (f.per_seller_limit) {
      const s = Number((await c.query(`SELECT COALESCE(SUM(amount), 0) AS s FROM coop_lending.disbursement_item WHERE facility_id = $1 AND seller_id = $2 AND status NOT IN ('Rejected','Cancelled')`, [f.facility_id, sellerId])).rows[0].s);
      if (s + amount > Number(f.per_seller_limit)) fail(409, 'over_per_seller_limit', { available: L.round2(Number(f.per_seller_limit) - s) });
    }

    let payout = null;
    if (b.payout_account_id) payout = await verifiedAccount(c, b.payout_account_id, sellerType, sellerId, ['payout']);
    const item = (await c.query(
      `INSERT INTO coop_lending.disbursement_item (facility_id, borrower_org_id, lender_org_id, purpose, farmer_id, seller_type, seller_id, seller_name,
              payout_account_id, amount, description, source_type, source_id, doc_no, service_date, service_area_rai, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [f.facility_id, req.org.org_id, f.lender_org_id, purpose, farmerId, sellerType, sellerId, name, payout ? payout.account_id : null, amount,
        text(b.description, 'description', { min: 3, max: 500 }), sourceType, sourceId, text(b.doc_no, 'doc_no', { max: 60, allowNull: true }),
        b.service_date && L.isDate(b.service_date) ? b.service_date : null, b.service_area_rai ? num(b.service_area_rai, 'service_area_rai', { min: 0.01, max: 100000 }) : null, actor.key],
    )).rows[0];
    await setPlots(c, item, b.unit_ids);
    await L.logEvent(c, { itemId: item.item_id, facilityId: f.facility_id, actor: actor.key, action: 'item_created', detail: { amount } });
    return item;
  });
  res.status(201).json(out);
}));
async function setPlots(c, item, unitIds) {
  if (!Array.isArray(unitIds)) return;
  const ids = [...new Set(unitIds.filter(isUuid))].slice(0, 20);
  if (ids.length) {
    const owners = (await c.query('SELECT unit_id, owner_farmer_id FROM registry.production_unit WHERE unit_id = ANY($1)', [ids])).rows;
    if (owners.length !== ids.length) fail(404, 'plot_not_found');
    if (owners.some((o) => o.owner_farmer_id !== item.farmer_id)) fail(400, 'plot_not_owned_by_farmer');
  }
  await c.query('DELETE FROM coop_lending.item_plot WHERE item_id = $1', [item.item_id]);
  for (const id of ids) await c.query('INSERT INTO coop_lending.item_plot (item_id, unit_id) VALUES ($1,$2)', [item.item_id, id]);
}

borrower.get('/items', wrap(async (req, res) => {
  res.json(await orgTx(req, (c) => itemRows(c, 'i.borrower_org_id = $1 AND ($2::uuid IS NULL OR i.facility_id = $2)', [req.org.org_id, isUuid(req.query.facility_id) ? req.query.facility_id : null])));
}));
borrower.patch('/items/:id', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) fail(404, 'item_not_found');
  const b = req.body || {};
  const out = await orgTx(req, async (c) => {
    const it = (await c.query('SELECT * FROM coop_lending.disbursement_item WHERE item_id = $1 AND borrower_org_id = $2 FOR UPDATE', [req.params.id, req.org.org_id])).rows[0];
    if (!it) fail(404, 'item_not_found');
    if (it.status !== 'Draft') fail(409, 'only_draft_editable');
    const sets = {};
    if (b.payout_account_id !== undefined) sets.payout_account_id = (await verifiedAccount(c, b.payout_account_id, it.seller_type, it.seller_id, ['payout'])).account_id;
    if (b.doc_no !== undefined) sets.doc_no = text(b.doc_no, 'doc_no', { max: 60, allowNull: true });
    if (b.description !== undefined) sets.description = text(b.description, 'description', { min: 3, max: 500 });
    if (b.service_date !== undefined) sets.service_date = L.isDate(b.service_date) ? b.service_date : null;
    if (b.service_area_rai !== undefined) sets.service_area_rai = num(b.service_area_rai, 'service_area_rai', { min: 0.01, max: 100000, allowNull: true });
    if (b.amount !== undefined && ['machinery_booking', 'manual'].includes(it.source_type)) sets.amount = num(b.amount, 'amount', { min: 1, max: Number(it.amount) });
    const keys = Object.keys(sets);
    let row = it;
    if (keys.length) {
      row = (await c.query(`UPDATE coop_lending.disbursement_item SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE item_id = $1 RETURNING *`,
        [it.item_id, ...keys.map((k) => sets[k])])).rows[0];
    }
    if (b.unit_ids !== undefined) await setPlots(c, row, b.unit_ids);
    return row;
  });
  res.json(out);
}));
/** แนบหลักฐาน: อัปโหลดไฟล์ผ่าน POST /storage/upload (purpose 'coop_lending_evidence') ก่อน แล้วส่ง file_id มาที่นี่ */
borrower.post('/items/:id/evidence', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) fail(404, 'item_not_found');
  const b = req.body || {};
  const kinds = ['invoice', 'delivery_note', 'work_photo', 'weighing_slip', 'contract', 'down_payment_slip', 'serial_photo', 'ownership_doc', 'insurance', 'other'];
  if (!kinds.includes(b.kind)) fail(400, 'invalid_kind');
  if (!isUuid(b.file_id)) fail(400, 'file_required');
  const out = await orgTx(req, async (c) => {
    const actor = await actorOf(c, req);
    const it = (await c.query('SELECT * FROM coop_lending.disbursement_item WHERE item_id = $1 AND borrower_org_id = $2 FOR UPDATE', [req.params.id, req.org.org_id])).rows[0];
    if (!it) fail(404, 'item_not_found');
    if (!['Draft', 'EvidencePending'].includes(it.status)) fail(409, 'evidence_locked', { status: it.status });
    const file = (await c.query(
      `SELECT fo.* FROM storage.file_object fo
        WHERE fo.file_id = $1 AND ((fo.owner_subject_type = 'organization' AND fo.owner_subject_id = $2)
           OR (fo.owner_subject_type = 'organization_member' AND fo.owner_subject_id IN (SELECT member_id FROM identity.organization_member WHERE org_id = $2)))`,
      [b.file_id, req.org.org_id],
    )).rows[0];
    if (!file) fail(404, 'file_not_found');
    const e = (await c.query(
      `INSERT INTO coop_lending.evidence (item_id, kind, file_id, sha256_hash, doc_no, note, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [it.item_id, b.kind, file.file_id, file.sha256_hash, text(b.doc_no, 'doc_no', { max: 60, allowNull: true }), text(b.note, 'note', { max: 300, allowNull: true }), actor.key],
    )).rows[0];
    await L.logEvent(c, { itemId: it.item_id, facilityId: it.facility_id, actor: actor.key, action: 'evidence_added', detail: { kind: b.kind, file_id: file.file_id } });
    if (it.status === 'EvidencePending') await L.evaluateItem(c, it.item_id, actor.key);
    return e;
  });
  res.status(201).json(out);
}));
/** ส่งให้ตรวจ: ตรวจดาวเทียม แล้วประเมินว่าหลักฐานครบหรือยัง (ครบ = เริ่มนับ 3 วันทำการของสหกรณ์ออมทรัพย์) */
borrower.post('/items/:id/submit', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) fail(404, 'item_not_found');
  const out = await orgTx(req, async (c) => {
    const actor = await actorOf(c, req);
    const it = (await c.query('SELECT * FROM coop_lending.disbursement_item WHERE item_id = $1 AND borrower_org_id = $2 FOR UPDATE', [req.params.id, req.org.org_id])).rows[0];
    if (!it) fail(404, 'item_not_found');
    if (it.status !== 'Draft') fail(409, 'item_not_draft', { status: it.status });
    const f = (await c.query('SELECT status FROM coop_lending.facility WHERE facility_id = $1', [it.facility_id])).rows[0];
    if (f.status !== 'Active') fail(409, 'facility_not_active');
    const kinds = (await c.query('SELECT DISTINCT kind FROM coop_lending.evidence WHERE item_id = $1', [it.item_id])).rows.map((r) => r.kind);
    const payout = it.payout_account_id ? (await c.query('SELECT verification_status FROM coop_lending.bank_account WHERE account_id = $1', [it.payout_account_id])).rows[0] : null;
    const miss = L.missingEvidence(it, kinds, payout && payout.verification_status === 'Verified');
    if (miss.missingKinds.length || miss.missingFields.length || miss.needPayout) fail(400, 'evidence_incomplete', { missing: miss });
    await c.query(`UPDATE coop_lending.disbursement_item SET status = 'EvidencePending', submitted_at = now(), returned_reason = NULL, updated_at = now() WHERE item_id = $1`, [it.item_id]);
    await L.checkSatellite(c, it);
    await L.logEvent(c, { itemId: it.item_id, facilityId: it.facility_id, actor: actor.key, action: 'submitted' });
    return L.evaluateItem(c, it.item_id, actor.key);
  });
  res.json(out);
}));
borrower.post('/items/:id/cancel', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) fail(404, 'item_not_found');
  const out = await orgTx(req, async (c) => {
    const actor = await actorOf(c, req);
    const r = (await c.query(
      `UPDATE coop_lending.disbursement_item SET status = 'Cancelled', updated_at = now()
        WHERE item_id = $1 AND borrower_org_id = $2 AND status IN ('Draft','EvidencePending') RETURNING *`, [req.params.id, req.org.org_id],
    )).rows[0];
    if (!r) fail(409, 'item_not_cancellable');
    await L.logEvent(c, { itemId: r.item_id, facilityId: r.facility_id, actor: actor.key, action: 'cancelled' });
    return r;
  });
  res.json(out);
}));

/** ผู้จัดทำ: เตรียมจ่ายผู้ขายจากบัญชีเฉพาะ (รวมค่าปรับถ้าสหกรณ์ออมทรัพย์/สหกรณ์การเกษตรช้า) */
borrower.post('/transfers/prepare-seller', wrap(async (req, res) => {
  const { item_id: itemId } = req.body || {};
  if (!isUuid(itemId)) fail(400, 'item_required');
  const out = await orgTx(req, async (c) => {
    const actor = await actorOf(c, req);
    const it = (await c.query('SELECT * FROM coop_lending.disbursement_item WHERE item_id = $1 AND borrower_org_id = $2 FOR UPDATE', [itemId, req.org.org_id])).rows[0];
    if (!it) fail(404, 'item_not_found');
    if (it.status !== 'Funded') fail(409, 'item_not_funded', { status: it.status });
    if (await openTransferFor(c, it.item_id, 'seller_payment')) fail(409, 'transfer_already_pending');
    const f = (await c.query('SELECT * FROM coop_lending.facility WHERE facility_id = $1', [it.facility_id])).rows[0];
    const from = await verifiedAccount(c, f.dedicated_account_id, 'organization', req.org.org_id, ['loan_dedicated']);
    const to = await verifiedAccount(c, it.payout_account_id, it.seller_type, it.seller_id, ['payout']);
    const settings = await L.loadSettings(c);
    const acPenalty = L.latePenalty(Number(it.amount), L.toDateStr(it.ac_due_date), L.todayBangkok(), Number(settings.late_penalty_pct));
    const total = L.round2(Number(it.amount) + Number(it.sc_penalty) + acPenalty);
    return createTransfer(c, {
      kind: 'seller_payment', initiatorOrgId: req.org.org_id, fromAccountId: from.account_id, toAccountId: to.account_id,
      amount: total, penalty: L.round2(Number(it.sc_penalty) + acPenalty), facilityId: f.facility_id,
      memo: `${it.description}${it.doc_no ? ` (เอกสาร ${it.doc_no})` : ''}`, items: [{ item_id: it.item_id, amount: Number(it.amount), penalty: acPenalty }],
    }, actor);
  });
  res.status(201).json(out);
}));
/** ผู้จัดทำ: เตรียมชำระคืนเงินกู้ (ตัดดอกเบี้ยค้างก่อน แล้วเงินต้นรายการที่ครบกำหนดก่อน) */
borrower.post('/transfers/prepare-repayment', wrap(async (req, res) => {
  const b = req.body || {};
  if (!isUuid(b.facility_id)) fail(400, 'facility_required');
  const amount = num(b.amount, 'amount', { min: 1 });
  const out = await orgTx(req, async (c) => {
    const actor = await actorOf(c, req);
    const f = (await c.query('SELECT * FROM coop_lending.facility WHERE facility_id = $1 AND borrower_org_id = $2', [b.facility_id, req.org.org_id])).rows[0];
    if (!f) fail(404, 'facility_not_found');
    const from = await verifiedAccount(c, b.from_account_id, 'organization', req.org.org_id, ['operating', 'loan_dedicated']);
    const to = (await c.query(
      `SELECT * FROM coop_lending.bank_account WHERE owner_type = 'organization' AND owner_id = $1 AND purpose = 'operating' AND verification_status = 'Verified' ORDER BY created_at LIMIT 1`, [f.lender_org_id],
    )).rows[0];
    if (!to) fail(409, 'lender_account_missing');
    const debt = await debtOf(c, f);
    if (amount > debt.total + 0.004) fail(409, 'repayment_exceeds_debt', { total: debt.total });
    return createTransfer(c, {
      kind: 'repayment', initiatorOrgId: req.org.org_id, fromAccountId: from.account_id, toAccountId: to.account_id, amount, facilityId: f.facility_id, memo: 'ชำระคืนเงินกู้สหกรณ์',
    }, actor);
  });
  res.status(201).json(out);
}));
/** ยอดหนี้ ณ วันนี้ (ไม่บันทึก — คำนวณดอกเบี้ยถึงวันนี้แบบอ่านอย่างเดียว) */
async function debtOf(c, f) {
  const settings = await L.loadSettings(c);
  const today = L.todayBangkok();
  const items = (await c.query(`SELECT * FROM coop_lending.disbursement_item WHERE facility_id = $1 AND purpose <> 'asset' AND (principal_outstanding > 0 OR interest_unpaid > 0)`, [f.facility_id])).rows;
  let principal = 0; let interest = 0;
  const rows = items.map((it) => {
    const from = L.toDateStr(it.interest_accrued_to) || L.toDateStr(it.funded_at);
    const acc = L.accrueInterest({
      principal: Number(it.principal_outstanding), from, to: today, dueDate: L.toDateStr(it.loan_due_date), ratePct: Number(f.rate_pct), penaltyPct: Number(settings.late_penalty_pct),
    });
    const i = L.round2(Number(it.interest_unpaid) + acc.total);
    principal += Number(it.principal_outstanding); interest += i;
    return {
      item_id: it.item_id, description: it.description, loan_due_date: L.toDateStr(it.loan_due_date), principal: Number(it.principal_outstanding), interest: i, overdue: L.toDateStr(it.loan_due_date) < today,
    };
  });
  return { principal: L.round2(principal), interest: L.round2(interest), total: L.round2(principal + interest), items: rows, as_of: today };
}
borrower.get('/facilities/:id/debt', wrap(async (req, res) => {
  if (!isUuid(req.params.id)) fail(404, 'facility_not_found');
  res.json(await orgTx(req, async (c) => {
    const f = (await c.query('SELECT * FROM coop_lending.facility WHERE facility_id = $1 AND borrower_org_id = $2', [req.params.id, req.org.org_id])).rows[0];
    if (!f) fail(404, 'facility_not_found');
    return debtOf(c, f);
  }));
}));

function assetBody(b, program) {
  const price = num(b.price, 'price', { min: 1000 });
  const down = num(b.down_payment, 'down_payment', { min: 0, max: price - 1 });
  const term = parseInt(b.term_months, 10);
  const interval = parseInt(b.interval_months, 10);
  const grace = parseInt(b.grace_periods || 0, 10);
  if (![1, 3, 6, 12].includes(interval)) fail(400, 'invalid_interval_months');
  if (!Number.isInteger(term) || term < 3 || term > Number(program.asset_max_months) || term % interval !== 0) fail(400, 'invalid_term_months', { max: program.asset_max_months });
  if (!Number.isInteger(grace) || grace < 0 || grace > 4) fail(400, 'invalid_grace_periods');
  if (down < price * Number(program.asset_min_down_pct) / 100 - 0.004) fail(400, 'down_payment_too_low', { min_pct: Number(program.asset_min_down_pct), min: L.round2(price * Number(program.asset_min_down_pct) / 100) });
  return {
    price, down, loan: L.round2(price - down), term, interval, grace, income: num(b.income_per_period, 'income_per_period', { min: 1 }),
  };
}
async function facilityForAsset(c, orgId, facilityId) {
  const f = (await c.query(
    `SELECT f.*, p.purposes, p.asset_min_down_pct, p.asset_max_months, p.asset_max_income_ratio_pct
       FROM coop_lending.facility f JOIN coop_lending.program p ON p.program_id = f.program_id WHERE f.facility_id = $1 AND f.borrower_org_id = $2`, [facilityId, orgId],
  )).rows[0];
  if (!f) fail(404, 'facility_not_found');
  if (!f.purposes.includes('asset')) fail(400, 'purpose_not_in_program');
  return f;
}
/** คำนวณตารางผ่อน + ตรวจความสามารถชำระ (ไม่บันทึก) */
borrower.post('/asset-loans/preview', wrap(async (req, res) => {
  const b = req.body || {};
  if (!isUuid(b.facility_id)) fail(400, 'facility_required');
  res.json(await orgTx(req, async (c) => {
    const f = await facilityForAsset(c, req.org.org_id, b.facility_id);
    const v = assetBody(b, f);
    const schedule = L.annuitySchedule({
      principal: v.loan, ratePct: Number(f.rate_pct), termMonths: v.term, intervalMonths: v.interval, gracePeriods: v.grace, startDate: L.todayBangkok(),
    });
    const aff = L.affordability(schedule, v.income, Number(f.asset_max_income_ratio_pct));
    return {
      loan_amount: v.loan, rate_pct: Number(f.rate_pct), schedule, ...aff, max_ratio_pct: Number(f.asset_max_income_ratio_pct), total_interest: L.round2(schedule.reduce((s, r) => s + r.interest, 0)),
    };
  }));
}));
borrower.post('/asset-loans', wrap(async (req, res) => {
  const b = req.body || {};
  if (!isUuid(b.facility_id)) fail(400, 'facility_required');
  if (!isUuid(b.seller_org_id)) fail(400, 'seller_required');
  const buyerType = ['cooperative', 'member'].includes(b.buyer_type) ? b.buyer_type : fail(400, 'invalid_buyer_type');
  const out = await orgTx(req, async (c) => {
    const actor = await actorOf(c, req);
    const f = await facilityForAsset(c, req.org.org_id, b.facility_id);
    if (f.status !== 'Active') fail(409, 'facility_not_active');
    const v = assetBody(b, f);
    let farmerId = null;
    if (buyerType === 'member') {
      if (!isUuid(b.farmer_id)) fail(400, 'farmer_required');
      await memberName(c, req.org.org_id, b.farmer_id);
      farmerId = b.farmer_id;
    }
    await sellerName(c, req.org.org_id, 'organization', b.seller_org_id);
    const schedule = L.annuitySchedule({
      principal: v.loan, ratePct: Number(f.rate_pct), termMonths: v.term, intervalMonths: v.interval, gracePeriods: v.grace, startDate: L.todayBangkok(),
    });
    const aff = L.affordability(schedule, v.income, Number(f.asset_max_income_ratio_pct));
    if (!aff.ok) fail(409, 'installment_exceeds_income_ratio', { ratio_pct: aff.ratio_pct, max_ratio_pct: Number(f.asset_max_income_ratio_pct), installment: aff.installment });
    const used = Number((await c.query(
      `SELECT COALESCE(SUM(CASE WHEN status IN ('Draft','EvidencePending','EvidenceComplete') THEN amount ELSE principal_outstanding END), 0) AS s
         FROM coop_lending.disbursement_item WHERE facility_id = $1 AND purpose <> 'asset' AND status NOT IN ('Rejected','Cancelled','Disputed')`, [f.facility_id],
    )).rows[0].s);
    const asset = Number((await c.query(`SELECT COALESCE(SUM(loan_amount), 0) AS s FROM coop_lending.asset_loan WHERE facility_id = $1 AND status IN ('Submitted','Approved','Active')`, [f.facility_id])).rows[0].s);
    if (v.loan > Number(f.limit_amount) - used - asset + 0.004) fail(409, 'over_facility_limit', { available: L.round2(Number(f.limit_amount) - used - asset) });
    const r = (await c.query(
      `INSERT INTO coop_lending.asset_loan (facility_id, borrower_org_id, lender_org_id, buyer_type, farmer_id, asset_kind, brand_model, seller_org_id, quotation_no,
              price, down_payment, loan_amount, rate_pct, term_months, interval_months, grace_periods, income_per_period, income_basis, installment, income_ratio_pct, serial_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [f.facility_id, req.org.org_id, f.lender_org_id, buyerType, farmerId, text(b.asset_kind, 'asset_kind', { min: 2, max: 120 }), text(b.brand_model, 'brand_model', { min: 2, max: 160 }),
        b.seller_org_id, text(b.quotation_no, 'quotation_no', { max: 60, allowNull: true }), v.price, v.down, v.loan, f.rate_pct, v.term, v.interval, v.grace, v.income,
        text(b.income_basis, 'income_basis', { min: 3, max: 1000 }), aff.installment, aff.ratio_pct, text(b.serial_no, 'serial_no', { min: 3, max: 60, allowNull: true })],
    )).rows[0];
    await L.logEvent(c, { assetLoanId: r.asset_loan_id, facilityId: f.facility_id, actor: actor.key, action: 'asset_loan_submitted', detail: { loan: v.loan, ratio_pct: aff.ratio_pct } });
    return { ...r, schedule_preview: schedule };
  });
  res.status(201).json(out);
}));
borrower.get('/asset-loans', wrap(async (req, res) => {
  res.json(await orgTx(req, async (c) => {
    const settings = await L.loadSettings(c);
    const today = L.todayBangkok();
    const rows = (await c.query(
      `SELECT a.*, s.org_name AS seller_name, l.org_name AS lender_name, f.full_name AS farmer_name,
              (SELECT json_agg(r ORDER BY r.seq) FROM coop_lending.repayment_schedule r WHERE r.asset_loan_id = a.asset_loan_id) AS schedule
         FROM coop_lending.asset_loan a JOIN identity.organization s ON s.org_id = a.seller_org_id JOIN identity.organization l ON l.org_id = a.lender_org_id
         LEFT JOIN identity.farmer f ON f.farmer_id = a.farmer_id
        WHERE a.borrower_org_id = $1 ORDER BY a.created_at DESC`, [req.org.org_id],
    )).rows;
    return rows.map((a) => {
      const due = a.schedule ? L.installmentsDue(a.schedule, today, Number(settings.late_penalty_pct)) : [];
      const payable = due.filter((d) => d.unpaid > 0 && d.due_date <= L.addDays(today, 31));
      return { ...a, due, due_now: L.round2(payable.reduce((s, d) => s + d.unpaid + d.penalty, 0)) };
    });
  }));
}));
borrower.post('/transfers/prepare-installment', wrap(async (req, res) => {
  const b = req.body || {};
  if (!isUuid(b.asset_loan_id)) fail(400, 'asset_loan_required');
  const amount = num(b.amount, 'amount', { min: 1 });
  const out = await orgTx(req, async (c) => {
    const actor = await actorOf(c, req);
    const a = (await c.query(`SELECT * FROM coop_lending.asset_loan WHERE asset_loan_id = $1 AND borrower_org_id = $2 AND status = 'Active'`, [b.asset_loan_id, req.org.org_id])).rows[0];
    if (!a) fail(404, 'asset_loan_not_active');
    const from = await verifiedAccount(c, b.from_account_id, 'organization', req.org.org_id, ['operating', 'loan_dedicated']);
    const to = (await c.query(
      `SELECT * FROM coop_lending.bank_account WHERE owner_type = 'organization' AND owner_id = $1 AND purpose = 'operating' AND verification_status = 'Verified' ORDER BY created_at LIMIT 1`, [a.lender_org_id],
    )).rows[0];
    if (!to) fail(409, 'lender_account_missing');
    const settings = await L.loadSettings(c);
    const rows = (await c.query('SELECT * FROM coop_lending.repayment_schedule WHERE asset_loan_id = $1 ORDER BY seq', [a.asset_loan_id])).rows;
    const due = L.installmentsDue(rows, L.todayBangkok(), Number(settings.late_penalty_pct));
    const max = L.round2(due.reduce((s, d) => s + d.unpaid + d.penalty, 0));
    if (amount > max + 0.004) fail(409, 'payment_exceeds_installments', { max });
    return createTransfer(c, {
      kind: 'installment', initiatorOrgId: req.org.org_id, fromAccountId: from.account_id, toAccountId: to.account_id, amount, facilityId: a.facility_id, assetLoanId: a.asset_loan_id,
      memo: `ค่างวด ${a.asset_kind} ${a.brand_model}`,
    }, actor);
  });
  res.status(201).json(out);
}));
borrower.get('/transfers', wrap(async (req, res) => { res.json(await orgTx(req, (c) => listTransfers(c, req.org.org_id, req.query.status))); }));
borrower.post('/transfers/:id/approve', wrap(async (req, res) => { res.json(await orgTx(req, (c) => approveTransfer(c, req, req.params.id))); }));
borrower.post('/transfers/:id/cancel', wrap(async (req, res) => { res.json(await orgTx(req, (c) => cancelTransfer(c, req, req.params.id))); }));
borrower.get('/evidence/:id/file', evidenceFileRoute('borrower_org_id'));
borrower.get('/notices', wrap(async (req, res) => { res.json(await orgTx(req, (c) => notices(c, req.org.org_id))); }));
borrower.post('/notices/read', wrap(async (req, res) => {
  await orgTx(req, (c) => c.query('UPDATE coop_lending.dunning_notice SET read_at = now() WHERE target_org_id = $1 AND read_at IS NULL', [req.org.org_id]));
  res.json({ ok: true });
}));

// ===========================================================================
// /farmer-lending — เกษตรกรยืนยันจากบัญชีของตนเอง (เจ้าหน้าที่สหกรณ์กดแทนไม่ได้)
// ===========================================================================
const farmer = express.Router();
farmer.use(requireAuth, requireFarmer);
const farmerTx = (req, fn) => tx('farmer', req.subject.subjectId, fn);

farmer.get('/items', wrap(async (req, res) => {
  res.json(await farmerTx(req, async (c) => (await c.query(
    `SELECT i.item_id, i.purpose, i.description, i.amount, i.status, i.seller_name, i.seller_type, i.doc_no, i.service_date, i.service_area_rai,
            i.farmer_confirmed_at, i.created_at, i.funded_at, i.paid_at, b.org_name AS coop_name, f.member_rate_pct,
            (i.seller_type = 'farmer' AND i.seller_id = $1) AS i_am_seller
       FROM coop_lending.disbursement_item i JOIN identity.organization b ON b.org_id = i.borrower_org_id
       JOIN coop_lending.facility f ON f.facility_id = i.facility_id
      WHERE i.farmer_id = $1 AND i.status NOT IN ('Cancelled') ORDER BY (i.status = 'EvidencePending' AND i.farmer_confirmed_at IS NULL) DESC, i.created_at DESC LIMIT 100`,
    [req.subject.subjectId],
  )).rows));
}));
for (const ACTION of ['confirm', 'dispute']) farmer.post(`/items/:id/${ACTION}`, wrap(async (req, res) => {
  req.params.action = ACTION;
  if (!isUuid(req.params.id)) fail(404, 'item_not_found');
  const confirm = req.params.action === 'confirm';
  const note = confirm ? text((req.body || {}).note, 'note', { max: 300, allowNull: true }) : text((req.body || {}).reason, 'reason', { min: 3, max: 500 });
  const out = await farmerTx(req, async (c) => {
    const it = (await c.query('SELECT * FROM coop_lending.disbursement_item WHERE item_id = $1 AND farmer_id = $2 FOR UPDATE', [req.params.id, req.subject.subjectId])).rows[0];
    if (!it) fail(404, 'item_not_found');
    const actor = `farmer:${req.subject.subjectId}`;
    if (confirm) {
      if (!['Draft', 'EvidencePending'].includes(it.status) || it.farmer_confirmed_at) fail(409, 'not_awaiting_confirmation');
      await c.query('UPDATE coop_lending.disbursement_item SET farmer_confirmed_at = now(), farmer_note = $2, updated_at = now() WHERE item_id = $1', [it.item_id, note]);
      await L.logEvent(c, { itemId: it.item_id, facilityId: it.facility_id, actor, action: 'farmer_confirmed', detail: { note } });
      return L.evaluateItem(c, it.item_id, actor);
    }
    if (!['Draft', 'EvidencePending', 'EvidenceComplete'].includes(it.status)) fail(409, 'cannot_dispute_now', { status: it.status });
    if (await openTransferFor(c, it.item_id, 'disbursement')) {
      await c.query(`UPDATE coop_lending.bank_transfer t SET status = 'Cancelled' FROM coop_lending.transfer_item ti
                      WHERE ti.transfer_id = t.transfer_id AND ti.item_id = $1 AND t.status = 'PendingApproval'`, [it.item_id]);
    }
    const r = (await c.query(`UPDATE coop_lending.disbursement_item SET status = 'Disputed', disputed_reason = $2, updated_at = now() WHERE item_id = $1 RETURNING *`, [it.item_id, note])).rows[0];
    await L.logEvent(c, { itemId: it.item_id, facilityId: it.facility_id, actor, action: 'farmer_disputed', detail: { reason: note } });
    return r;
  });
  res.json(out);
}));

// ===========================================================================
// /admin/coop-lending — ผู้ดูแลแพลตฟอร์ม
// ===========================================================================
const admin = express.Router();
admin.use(requireAuth, requirePlatform);
const adminTx = (req, fn) => tx('platform', req.subject.subjectId, fn);

admin.get('/settings', wrap(async (req, res) => {
  res.json(await adminTx(req, async (c) => {
    const s = await L.loadSettings(c);
    const acc = s.platform_account_id ? (await c.query('SELECT * FROM coop_lending.bank_account WHERE account_id = $1', [s.platform_account_id])).rows[0] : null;
    const holidays = (await c.query(`SELECT to_char(holiday_date, 'YYYY-MM-DD') AS holiday_date, name_th FROM coop_lending.holiday WHERE holiday_date >= current_date - 30 ORDER BY holiday_date`)).rows;
    const stats = (await c.query(
      `SELECT (SELECT COUNT(*) FROM identity.organization WHERE org_type = 'SavingsCooperative')::int AS savings_coops,
              (SELECT COUNT(*) FROM coop_lending.facility WHERE status = 'Active')::int AS active_facilities,
              (SELECT COALESCE(SUM(principal_outstanding), 0) FROM coop_lending.disbursement_item)::numeric AS outstanding,
              (SELECT COUNT(*) FROM coop_lending.disbursement_item WHERE status = 'EvidenceComplete' AND sc_due_date < current_date)::int AS sc_late,
              (SELECT COUNT(*) FROM coop_lending.disbursement_item WHERE status = 'Funded' AND ac_due_date < current_date)::int AS ac_late,
              (SELECT COALESCE(SUM(fee_amount), 0) FROM coop_lending.bank_transfer WHERE kind = 'disbursement' AND status = 'Succeeded')::numeric AS fee_earned`,
    )).rows[0];
    return { ...s, platform_account: maskAcc(acc), holidays, bank: bank.info(), stats };
  }));
}));
admin.put('/settings', wrap(async (req, res) => {
  const b = req.body || {};
  const sets = {};
  if (b.fee_pct !== undefined) sets.fee_pct = num(b.fee_pct, 'fee_pct', { min: 0, max: 5 });
  if (b.sc_sla_days !== undefined) sets.sc_sla_days = num(b.sc_sla_days, 'sc_sla_days', { min: 1, max: 30 });
  if (b.ac_sla_days !== undefined) sets.ac_sla_days = num(b.ac_sla_days, 'ac_sla_days', { min: 1, max: 30 });
  if (b.late_penalty_pct !== undefined) sets.late_penalty_pct = num(b.late_penalty_pct, 'late_penalty_pct', { min: 0, max: 30 });
  const keys = Object.keys(sets);
  if (!keys.length) fail(400, 'nothing_to_update');
  res.json(await adminTx(req, async (c) => (await c.query(
    `UPDATE coop_lending.setting SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id RETURNING *`, keys.map((k) => sets[k]),
  )).rows[0]));
}));
admin.post('/platform-account', wrap(async (req, res) => {
  res.status(201).json(maskAcc(await adminTx(req, async (c) => {
    const a = await addBankAccount(c, {
      ownerType: 'platform', ownerId: null, purpose: 'platform', body: req.body || {}, expectedName: null, addedBy: null,
    });
    if (a.verification_status !== 'Verified') fail(409, 'account_not_verified', { note: a.verification_note });
    await c.query('UPDATE coop_lending.setting SET platform_account_id = $1, updated_at = now() WHERE id', [a.account_id]);
    return a;
  })));
}));
admin.post('/holidays', wrap(async (req, res) => {
  const b = req.body || {};
  const list = Array.isArray(b.holidays) ? b.holidays : [b];
  if (!list.length || list.length > 60) fail(400, 'holidays_required');
  const rows = list.map((h) => {
    if (!L.isDate(h.holiday_date)) fail(400, 'invalid_date', { value: h.holiday_date });
    return [h.holiday_date, text(h.name_th, 'name_th', { min: 1, max: 120 })];
  });
  res.status(201).json(await adminTx(req, async (c) => {
    for (const [d, n] of rows) {
      await c.query('INSERT INTO coop_lending.holiday (holiday_date, name_th) VALUES ($1,$2) ON CONFLICT (holiday_date) DO UPDATE SET name_th = EXCLUDED.name_th', [d, n]);
    }
    return { saved: rows.length };
  }));
}));
admin.delete('/holidays/:date', wrap(async (req, res) => {
  if (!L.isDate(req.params.date)) fail(400, 'invalid_date');
  await adminTx(req, (c) => c.query('DELETE FROM coop_lending.holiday WHERE holiday_date = $1', [req.params.date]));
  res.json({ ok: true });
}));
admin.post('/sla-sweep', wrap(async (req, res) => { res.json(await adminTx(req, (c) => L.slaSweep(c))); }));

module.exports = {
  savings, borrower, farmer, admin, _internal: { approveTransfer, settleTransfer },
};
