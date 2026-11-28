/**
 * ตลาดสินเชื่อระหว่างสหกรณ์ — ระบบเตือนภัยล่วงหน้า (Blueprint 9.3) และสัญญาณทุจริต (10.3)
 *
 *   ส่วนคำนวณ: lib/coopRisk.js · ตาราง: db/grant_coop_lending_risk.sql
 *   ตรวจอัตโนมัติทุก 6 ชั่วโมง (start) หรือผู้ดูแลกด POST /admin/coop-lending/market/risk/sweep
 *
 *   ผู้ดูแลแพลตฟอร์ม  ดูทุกสัญญาณ เปิดการสอบสวน (Investigating) ปิดเรื่อง (Resolved/Dismissed) พร้อมบันทึก
 *   ผู้ให้กู้          เห็นสัญญาณของสหกรณ์ผู้กู้ที่ตนมีวงเงิน/สัญญาด้วย (อ่านอย่างเดียว)
 *   ผู้กู้            เห็นสัญญาณเตือนภัยของตนทันที และสัญญาณทุจริตเมื่อผู้ดูแลเปิดการสอบสวนแล้ว — ชี้แจงได้
 *                    แจ้งรายชื่อผู้มีผลประโยชน์ร่วม (กรรมการ/ผู้จัดการ และกิจการที่เกี่ยวข้อง)
 */
const L = require('../lib/coopLending');
const R = require('../lib/coopRisk');
const plotAI = require('../lib/plotAI');

/** ตรวจทั้งระบบหนึ่งรอบ — client ต้องมีสิทธิ์อ่านทุกสหกรณ์ (platform/service role) */
async function sweep(c, { today = L.todayBangkok() } = {}) {
  const started = (await c.query('SELECT now() AS t')).rows[0].t; // เวลาเริ่มธุรกรรม = ค่า last_seen_at ที่บันทึกรอบนี้
  const settings = await L.loadSettings(c);
  const has = async (rel) => (await c.query('SELECT to_regclass($1) IS NOT NULL AS ok', [rel])).rows[0].ok;
  const hasDairy = await has('dairy.shipment');
  const hasAI = await has('ai.v_latest_assessment');
  const signals = [];

  // ------------------------------------------------ 9.3 เตือนภัยล่วงหน้า: สัญญาที่ลงนามแล้ว
  const ags = (await c.query(
    `SELECT l.*, ag.agreement_id, ag.signed_at AS agreement_signed_at FROM coop_lending.loan_agreement ag JOIN coop_lending.loan_listing l ON l.listing_id = ag.listing_id
      WHERE ag.status = 'Signed' AND l.status NOT IN ('Closed', 'Withdrawn')`,
  )).rows;
  for (const a of ags) {
    const items = (await c.query(
      `SELECT i.*, ba.created_at AS payout_created_at,
              (SELECT MIN(bt.created_at) FROM coop_lending.transfer_item ti JOIN coop_lending.bank_transfer bt ON bt.transfer_id = ti.transfer_id
                WHERE ti.item_id = i.item_id AND bt.kind = 'seller_payment' AND bt.status <> 'Cancelled') AS transfer_at
         FROM coop_lending.disbursement_item i JOIN coop_lending.facility f ON f.facility_id = i.facility_id
         LEFT JOIN coop_lending.bank_account ba ON ba.account_id = i.payout_account_id
        WHERE f.agreement_id = $1`, [a.agreement_id],
    )).rows;
    const d = a.details || {};
    let deliveriesKg = 0;
    if (a.project_type === 'procurement' && L.isDate(d.period_from)) {
      deliveriesKg = Number((await c.query(
        `SELECT COALESCE(SUM(quantity_ton), 0) * 1000 AS kg FROM produce.delivery WHERE buyer_org_id = $1 AND status <> 'rejected' AND delivered_at::date BETWEEN $2 AND $3`,
        [a.borrower_org_id, d.period_from, today],
      )).rows[0].kg);
    }
    const tranches = (await c.query(`SELECT * FROM coop_lending.agreement_tranche WHERE agreement_id = $1 AND status IN ('Submitted','Checked','Verified')`, [a.agreement_id])).rows;
    const reports = (await c.query('SELECT * FROM coop_lending.listing_report WHERE listing_id = $1 ORDER BY created_at DESC', [a.listing_id])).rows;
    const dairy = hasDairy ? (await c.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'Rejected' AND ship_date > $2::date - 30)::int AS rejected_30d FROM dairy.shipment WHERE coop_org_id = $1`, [a.borrower_org_id, today],
    )).rows[0] : null;
    signals.push(...R.earlyWarnings({
      listing: a, agreement: { agreement_id: a.agreement_id, signed_at: a.agreement_signed_at }, items, deliveries_kg: deliveriesKg, tranches, reports, dairy, settings, today,
    }));
  }

  // ------------------------------------------------ 10.3 สัญญาณทุจริต: สหกรณ์ผู้กู้ทุกแห่ง
  const borrowers = (await c.query(
    `SELECT org_id FROM coop_lending.borrower_profile UNION SELECT DISTINCT borrower_org_id FROM coop_lending.facility`,
  )).rows.map((r) => r.org_id);
  const crops = (await has('ai.crop_profile'))
    ? Object.fromEntries((await c.query('SELECT crop_code, max_yield_t_per_rai FROM ai.crop_profile')).rows.map((r) => [r.crop_code, r.max_yield_t_per_rai])) : {};
  const hasRel = await has('identity.farmer_org_relationship');
  const hasReg = await has('registry.coop_directory_financial');
  for (const org of borrowers) {
    const profile = (await c.query('SELECT signatories, debts, max_borrowing, financials FROM coop_lending.borrower_profile WHERE org_id = $1', [org])).rows[0] || {};
    const official = hasReg ? {
      rows: (await c.query('SELECT f.* FROM registry.coop_directory_financial f JOIN registry.coop_directory d ON d.directory_id = f.directory_id WHERE d.org_id = $1', [org])).rows,
    } : null;
    if (official && official.rows.length) official.source = official.rows[0].source_label;
    const related = (await c.query('SELECT * FROM coop_lending.related_party WHERE borrower_org_id = $1', [org])).rows;
    const items = (await c.query(
      `SELECT i.*, f.listing_id, so.tax_id AS seller_tax_id, ba.bank_code, ba.account_no, ba.account_name,
              (SELECT COUNT(DISTINCT b2.owner_type || ':' || COALESCE(b2.owner_id::text, '')) FROM coop_lending.bank_account b2
                WHERE b2.bank_code = ba.bank_code AND b2.account_no = ba.account_no AND b2.purpose = 'payout')::int AS owners,
              EXISTS (SELECT 1 FROM coop_lending.bank_account b3 WHERE b3.owner_type = 'organization' AND b3.owner_id = i.borrower_org_id
                         AND b3.bank_code = ba.bank_code AND b3.account_no = ba.account_no AND b3.purpose <> 'payout') AS is_borrower_account
         FROM coop_lending.disbursement_item i JOIN coop_lending.facility f ON f.facility_id = i.facility_id
         LEFT JOIN identity.organization so ON i.seller_type = 'organization' AND so.org_id = i.seller_id
         LEFT JOIN coop_lending.bank_account ba ON ba.account_id = i.payout_account_id
        WHERE i.borrower_org_id = $1`, [org],
    )).rows.map((i) => ({
      ...i, payout: i.account_no ? { bank_code: i.bank_code, account_no: i.account_no, account_name: i.account_name, owners: i.owners, is_borrower_account: i.is_borrower_account } : null,
    }));
    const farmerIds = [...new Set(items.filter((i) => i.seller_type === 'farmer').map((i) => i.seller_id))];
    const farmers = {};
    if (farmerIds.length) {
      const plots = (await c.query(
        `SELECT pu.owner_farmer_id, pu.area_rai, pu.commodity_code${hasAI ? ', va.predicted_crop, va.crop_confidence' : ''}
           FROM registry.production_unit pu ${hasAI ? 'LEFT JOIN ai.v_latest_assessment va ON va.unit_id = pu.unit_id' : ''}
          WHERE pu.owner_farmer_id = ANY($1::uuid[]) AND pu.status = 'active'`, [farmerIds],
      )).rows;
      const joined = hasRel ? (await c.query(
        `SELECT farmer_id, MIN(joined_at) AS joined_at FROM identity.farmer_org_relationship WHERE org_id = $1 AND farmer_id = ANY($2::uuid[]) GROUP BY farmer_id`, [org, farmerIds],
      )).rows : [];
      farmerIds.forEach((fid) => { farmers[fid] = { plots: [], joined_at: null }; });
      plots.forEach((p) => {
        const crop = plotAI.commodityToCrop(p.commodity_code);
        farmers[p.owner_farmer_id].plots.push({ area_rai: p.area_rai, crop, max_t_per_rai: crops[crop] ?? null, predicted_crop: p.predicted_crop || null, crop_confidence: p.crop_confidence || null });
      });
      joined.forEach((j) => { if (farmers[j.farmer_id]) farmers[j.farmer_id].joined_at = j.joined_at; });
    }
    const listings = (await c.query('SELECT listing_id, status, project_type, amount_requested, created_at, listed_at FROM coop_lending.loan_listing WHERE borrower_org_id = $1', [org])).rows;
    const history = (await c.query('SELECT * FROM coop_lending.profile_history WHERE org_id = $1 ORDER BY changed_at', [org])).rows;
    signals.push(...R.fraudSignals({ borrower: { org_id: org, profile }, related, items, farmers, listings, history, official, settings, today }));
  }

  // ------------------------------------------------ บันทึก/อัปเดต แล้วแจ้งผู้เกี่ยวข้องเฉพาะเรื่องใหม่หรือเรื่องที่กลับมาอีก
  let created = 0; let reopened = 0;
  const seen = new Set();
  for (const s of signals) {
    if (seen.has(s.dedupe_key)) continue; // สัญญาณเดียวกันจากหลายเส้นทาง บันทึกครั้งเดียว
    seen.add(s.dedupe_key);
    const extra = s.detail_changes ? { changes: s.detail_changes } : null;
    const prev = (await c.query('SELECT alert_id, status, active FROM coop_lending.risk_alert WHERE dedupe_key = $1 FOR UPDATE', [s.dedupe_key])).rows[0];
    if (!prev) {
      const r = (await c.query(
        `INSERT INTO coop_lending.risk_alert (category, code, severity, title, detail, extra, borrower_org_id, listing_id, agreement_id, item_id, dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING alert_id`,
        [s.category, s.code, s.severity, s.title, s.detail, extra, s.borrower_org_id, s.listing_id || null, s.agreement_id || null, s.item_id || null, s.dedupe_key],
      )).rows[0];
      created += 1;
      await notifyParties(c, { ...s, alert_id: r.alert_id }, { borrower: s.category === 'early_warning' });
      continue;
    }
    // ปิดเรื่องว่า "ดำเนินการแล้ว" แต่เงื่อนไขหายไปแล้วกลับมาอีก → เปิดใหม่ · "ตรวจแล้วไม่พบปัญหา" (Dismissed) ไม่เปิดซ้ำ
    const reopen = prev.status === 'Resolved' && !prev.active;
    await c.query(
      `UPDATE coop_lending.risk_alert SET severity = $2, detail = $3, extra = $4, active = true, last_seen_at = now(),
              status = CASE WHEN $5 THEN 'Open' ELSE status END WHERE alert_id = $1`,
      [prev.alert_id, s.severity, s.detail, extra, reopen],
    );
    if (reopen) {
      reopened += 1;
      await notifyParties(c, { ...s, alert_id: prev.alert_id }, { borrower: s.category === 'early_warning' });
    }
  }
  const stale = (await c.query('UPDATE coop_lending.risk_alert SET active = false WHERE active AND last_seen_at < $1 RETURNING alert_id', [started])).rowCount;
  await c.query('UPDATE coop_lending.setting SET risk_swept_at = now() WHERE id');
  return { signals: signals.length, created, reopened, cleared: stale };
}

/** ผู้ให้กู้ที่ต้องรับรู้: ทุกรายที่มีวงเงินกับสหกรณ์ผู้กู้ (ตรงกับสิทธิ์ดูใน GET /savings/market/risk) */
async function lendersOf(c, a) {
  return (await c.query(
    `SELECT lender_org_id FROM coop_lending.facility WHERE borrower_org_id = $1 AND status <> 'Closed'
     UNION SELECT lender_org_id FROM coop_lending.agreement_lender WHERE agreement_id = $2`, [a.borrower_org_id, a.agreement_id || null],
  )).rows.map((r) => r.lender_org_id);
}
async function notify(c, orgId, message, listingId) {
  await c.query(`INSERT INTO coop_lending.dunning_notice (target_org_id, kind, notice_date, message, listing_id) VALUES ($1,'risk_alert',$2,$3,$4)`,
    [orgId, L.todayBangkok(), message.slice(0, 1000), listingId || null]);
}
async function notifyParties(c, a, { borrower }) {
  const tag = a.category === 'fraud' ? 'สัญญาณที่ต้องตรวจสอบ' : 'เตือนภัยล่วงหน้า';
  for (const lender of await lendersOf(c, a)) await notify(c, lender, `${tag}: ${a.title} — ${a.detail}`, a.listing_id);
  if (borrower) await notify(c, a.borrower_org_id, `${tag}: ${a.title} — ${a.detail} กรุณาชี้แจงในหน้าโครงการ`, a.listing_id);
}

function attach({ savings, borrower, admin, gov }, H) {
  const { wrap, fail, tx, orgTx, text, isUuid, actorOf, govTx, officerScope } = H;
  const adminTx = (req, fn) => tx('platform', req.subject.subjectId, fn);
  const SELECT = `SELECT a.*, o.org_name AS borrower_name, l.title AS listing_title, i.seller_name, i.amount AS item_amount
                    FROM coop_lending.risk_alert a JOIN identity.organization o ON o.org_id = a.borrower_org_id
                    LEFT JOIN coop_lending.loan_listing l ON l.listing_id = a.listing_id
                    LEFT JOIN coop_lending.disbursement_item i ON i.item_id = a.item_id`;
  const ORDER = `ORDER BY (a.status IN ('Open','Investigating')) DESC, (a.severity = 'high') DESC, a.last_seen_at DESC LIMIT 300`;
  const listingFilter = (req, params) => {
    if (req.query.listing_id === undefined) return '';
    if (!isUuid(req.query.listing_id)) fail(400, 'invalid_listing');
    params.push(req.query.listing_id);
    return ` AND a.listing_id = $${params.length}`;
  };

  // ------------------------------------------------ ผู้กู้
  borrower.get('/market/risk', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => {
      const params = [req.org.org_id];
      const f = listingFilter(req, params);
      return (await c.query(`${SELECT} WHERE a.borrower_org_id = $1 AND (a.category = 'early_warning' OR a.status <> 'Open')${f} ${ORDER}`, params)).rows;
    }));
  }));
  borrower.post('/market/risk/:id/explain', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) fail(404, 'alert_not_found');
    res.json(await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      const a = (await c.query(`SELECT * FROM coop_lending.risk_alert WHERE alert_id = $1 AND borrower_org_id = $2 AND (category = 'early_warning' OR status <> 'Open') FOR UPDATE`,
        [req.params.id, req.org.org_id])).rows[0];
      if (!a) fail(404, 'alert_not_found');
      const note = text((req.body || {}).note, 'note', { min: 5, max: 2000 });
      const r = (await c.query('UPDATE coop_lending.risk_alert SET borrower_note = $2, borrower_note_by = $3, borrower_note_at = now() WHERE alert_id = $1 RETURNING *',
        [a.alert_id, note, actor.key])).rows[0];
      for (const lender of await lendersOf(c, a)) await notify(c, lender, `ผู้กู้ชี้แจงเรื่อง "${a.title}": ${note}`, a.listing_id);
      return r;
    }));
  }));
  borrower.get('/market/related-parties', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => (await c.query('SELECT * FROM coop_lending.related_party WHERE borrower_org_id = $1 ORDER BY declared_at, person_name', [req.org.org_id])).rows));
  }));
  borrower.put('/market/related-parties', wrap(async (req, res) => {
    const list = Array.isArray((req.body || {}).parties) ? req.body.parties.slice(0, 50) : fail(400, 'parties_required');
    res.json(await orgTx(req, async (c) => {
      const actor = await actorOf(c, req);
      const rows = list.map((p) => ({
        person_name: text(p.person_name, 'person_name', { min: 2, max: 160 }),
        role: text(p.role, 'role', { max: 80, allowNull: true }),
        related_name: text(p.related_name, 'related_name', { max: 200, allowNull: true }),
        related_tax_id: p.related_tax_id ? (/^[0-9]{13}$/.test(String(p.related_tax_id).replace(/[-\s]/g, '')) ? String(p.related_tax_id).replace(/[-\s]/g, '') : fail(400, 'invalid_tax_id')) : null,
      }));
      await c.query('DELETE FROM coop_lending.related_party WHERE borrower_org_id = $1', [req.org.org_id]);
      const out = [];
      for (const p of rows) {
        const org = p.related_tax_id ? (await c.query('SELECT org_id FROM identity.organization WHERE tax_id = $1', [p.related_tax_id])).rows[0] : null;
        out.push((await c.query(
          `INSERT INTO coop_lending.related_party (borrower_org_id, person_name, role, related_name, related_tax_id, related_org_id, declared_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [req.org.org_id, p.person_name, p.role, p.related_name, p.related_tax_id, org ? org.org_id : null, actor.key],
        )).rows[0]);
      }
      return out;
    }));
  }));

  // ------------------------------------------------ ผู้ให้กู้: สหกรณ์ผู้กู้ที่ตนมีวงเงินหรือสัญญาด้วย
  savings.get('/market/risk', wrap(async (req, res) => {
    res.json(await orgTx(req, async (c) => {
      const params = [req.org.org_id];
      const f = listingFilter(req, params);
      return (await c.query(
        `${SELECT} WHERE a.borrower_org_id IN (SELECT borrower_org_id FROM coop_lending.facility WHERE lender_org_id = $1)${f} ${ORDER}`, params,
      )).rows;
    }));
  }));

  // ------------------------------------------------ ผู้ดูแลแพลตฟอร์ม
  admin.get('/market/risk', wrap(async (req, res) => {
    res.json(await adminTx(req, async (c) => {
      const params = []; const where = [];
      if (['Open', 'Investigating', 'Resolved', 'Dismissed'].includes(req.query.status)) { params.push(req.query.status); where.push(`a.status = $${params.length}`); }
      if (['early_warning', 'fraud'].includes(req.query.category)) { params.push(req.query.category); where.push(`a.category = $${params.length}`); }
      const rows = (await c.query(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${ORDER}`, params)).rows;
      const s = (await c.query('SELECT risk_swept_at FROM coop_lending.setting WHERE id')).rows[0];
      const counts = (await c.query(`SELECT category, status, COUNT(*)::int AS n FROM coop_lending.risk_alert GROUP BY 1, 2`)).rows;
      return { alerts: rows, swept_at: s ? s.risk_swept_at : null, counts, codes: R.CODES };
    }));
  }));
  admin.post('/market/risk/sweep', wrap(async (req, res) => {
    res.json(await adminTx(req, (c) => sweep(c)));
  }));
  admin.post('/market/risk/:id/decide', wrap(async (req, res) => {
    const b = req.body || {};
    if (!['Investigating', 'Resolved', 'Dismissed'].includes(b.status)) fail(400, 'invalid_status');
    if (!isUuid(req.params.id)) fail(404, 'alert_not_found');
    res.json(await adminTx(req, async (c) => {
      const a = (await c.query('SELECT * FROM coop_lending.risk_alert WHERE alert_id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!a) fail(404, 'alert_not_found');
      const note = text(b.note, 'note', { min: b.status === 'Investigating' ? 0 : 5, max: 2000, allowNull: b.status === 'Investigating' });
      const r = (await c.query('UPDATE coop_lending.risk_alert SET status = $2, decision_note = $3, decided_by = $4, decided_at = now() WHERE alert_id = $1 RETURNING *',
        [a.alert_id, b.status, note, `platform:${req.subject.subjectId || 'admin'}`])).rows[0];
      if (b.status === 'Investigating' && a.category === 'fraud') {
        await notify(c, a.borrower_org_id, `ผู้ดูแลแพลตฟอร์มขอให้ชี้แจงเรื่อง "${a.title}": ${a.detail}${note ? ` (${note})` : ''}`, a.listing_id);
      }
      if (['Resolved', 'Dismissed'].includes(b.status)) {
        const msg = `ปิดเรื่อง "${a.title}" (${b.status === 'Resolved' ? 'ดำเนินการแล้ว' : 'ตรวจแล้วไม่พบปัญหา'}): ${note}`;
        for (const lender of await lendersOf(c, a)) await notify(c, lender, msg, a.listing_id);
        if (a.category === 'early_warning' || a.status !== 'Open') await notify(c, a.borrower_org_id, msg, a.listing_id);
      }
      return r;
    }));
  }));

  // ------------------------------------------------ กรมส่งเสริมสหกรณ์: จำนวนตามจังหวัดที่ดูแล
  gov.get('/market/risk-summary', wrap(async (req, res) => {
    res.json(await govTx(req, async (c) => {
      const { province } = await officerScope(c, req);
      return (await c.query(
        `SELECT a.category, a.code, a.status, COUNT(*)::int AS n FROM coop_lending.risk_alert a
           JOIN registry.cooperative_profile cp ON cp.org_id = a.borrower_org_id AND ($1::text IS NULL OR cp.province_code = $1)
          GROUP BY 1, 2, 3`, [province],
      )).rows;
    }));
  }));
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV === 'test') return;
  const { withServiceRole } = require('../db/pool'); // eslint-disable-line global-require
  const run = () => withServiceRole((c) => sweep(c)).catch((err) => {
    if (err && err.code === '42P01') return; // ยังไม่ได้รัน grant_coop_lending_risk.sql
    console.error('[coop-lending] risk sweep failed', err.message);
  });
  setTimeout(run, 60e3);
  timer = setInterval(run, 6 * 3600e3);
  if (timer.unref) timer.unref();
}

module.exports = { attach, sweep, start };
