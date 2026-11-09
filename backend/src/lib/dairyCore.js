/**
 * Dairy business logic shared by more than one router (coop, member,
 * partner, gov): applying animal events, receiving a shipment at the
 * factory, accepting a surplus proposal, ledger/fee writes and the
 * 30/60/90-day milk forecast. Every function takes an already-scoped
 * client and ids the caller has ALREADY verified belong to it.
 */
const { logAccess } = require('../db/pool');
const {
  bad, conflict, notFound, round2, feeOf, bkkToday, isDate, num, addDays, daysBetween, alertLevel, priceFor, ds,
} = require('./dairy');

async function settings(c, coopId) {
  return (await c.query('SELECT * FROM dairy.setting WHERE coop_org_id=$1', [coopId])).rows[0];
}

async function addLedger(c, coopId, memberId, entryType, amount, refType, refId, note, entryDate) {
  if (Number(amount) === 0) return null;
  const r = await c.query(
    `INSERT INTO dairy.member_ledger (coop_org_id, member_id, entry_type, amount, ref_type, ref_id, note, entry_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date) RETURNING entry_id`,
    [coopId, memberId, entryType, round2(amount), refType, refId, note || null, entryDate || bkkToday()],
  );
  return r.rows[0].entry_id;
}

async function addPlatformFee(c, coopId, feeType, payerType, payerRef, base, rate, refType, refId) {
  const fee = feeOf(base, rate);
  await c.query(
    `INSERT INTO dairy.platform_fee (coop_org_id, fee_type, payer_type, payer_ref, base_amount, rate_pct, fee_amount, ref_type, ref_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (ref_type, ref_id, fee_type) DO NOTHING`,
    [coopId, feeType, payerType, payerRef, round2(base), rate, fee, refType, refId],
  );
  return fee;
}

/** Current open (unsettled) balance of a member: credits minus debits not yet in a run. */
async function openBalance(c, memberId) {
  return Number((await c.query(
    'SELECT COALESCE(SUM(amount),0) AS b FROM dairy.member_ledger WHERE member_id=$1 AND run_id IS NULL', [memberId],
  )).rows[0].b);
}

/**
 * Applies one animal event: inserts dairy.animal_event, updates the animal's
 * state, creates a calf on calving, and charges the member's ledger for a
 * paid service (insemination → ai_service; treatment/vaccination/pregnancy
 * check → vet_service) unless opts.charge_member === false.
 */
async function applyEvent(c, coopId, animal, eventType, eventDate, details, opts = {}) {
  const s = await settings(c, coopId);
  const d = details || {};
  const cost = opts.cost ? Number(opts.cost) : 0;
  const upd = {};
  const terminal = ['Sold', 'Dead', 'Culled'];
  if (terminal.includes(animal.status) && eventType !== 'note') throw conflict('animal_not_active', { status: animal.status });
  const female = animal.sex === 'F';
  let calf = null;
  switch (eventType) {
    case 'heat':
      if (!female) throw bad('female_only');
      break;
    case 'insemination':
      if (!female) throw bad('female_only');
      upd.last_insemination_date = eventDate;
      upd.pregnant = false;
      upd.expected_calving_date = null;
      upd.dry_off_due_date = null;
      break;
    case 'pregnancy_check': {
      if (!female) throw bad('female_only');
      if (!['positive', 'negative'].includes(d.result)) throw bad('invalid_field', { field: 'result' });
      if (d.result === 'positive') {
        const base = d.insemination_date && isDate(d.insemination_date) ? d.insemination_date
          : ds(animal.last_insemination_date);
        if (!base) throw conflict('no_insemination_record');
        const due = addDays(base, Number(s.gestation_days));
        upd.pregnant = true;
        upd.expected_calving_date = due;
        upd.dry_off_due_date = addDays(due, -Number(s.dry_period_days));
        d.expected_calving_date = due;
      } else {
        upd.pregnant = false;
        upd.expected_calving_date = null;
        upd.dry_off_due_date = null;
      }
      break;
    }
    case 'calving': {
      if (!female) throw bad('female_only');
      upd.lactation_no = Number(animal.lactation_no) + 1;
      upd.last_calving_date = eventDate;
      upd.status = 'Milking';
      upd.pregnant = false;
      upd.expected_calving_date = null;
      upd.dry_off_due_date = null;
      if (d.calf_ear_tag) {
        const sex = d.calf_sex === 'M' ? 'M' : 'F';
        try {
          calf = (await c.query(
            `INSERT INTO dairy.animal (coop_org_id, member_id, ear_tag, sex, birth_date, dam_ear_tag, sire_code, breed, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Calf') RETURNING animal_id, ear_tag`,
            [coopId, animal.member_id, String(d.calf_ear_tag).trim(), sex, eventDate, animal.ear_tag, d.sire_code || null, animal.breed],
          )).rows[0];
        } catch (e) {
          if (e.code === '23505') throw conflict('ear_tag_exists', { ear_tag: d.calf_ear_tag });
          throw e;
        }
      }
      break;
    }
    case 'dry_off':
      if (!female) throw bad('female_only');
      upd.status = 'Dry';
      break;
    case 'treatment': {
      const w = num(d.withdrawal_days, { min: 0, max: 120 });
      if (Number.isNaN(w)) throw bad('invalid_field', { field: 'withdrawal_days' });
      if (w) {
        const until = addDays(eventDate, w);
        const cur = ds(animal.withdrawal_until);
        if (!cur || until > cur) upd.withdrawal_until = until;
        d.withdrawal_until = until;
      }
      break;
    }
    case 'vaccination':
    case 'note':
      break;
    case 'sold': upd.status = 'Sold'; break;
    case 'dead': upd.status = 'Dead'; break;
    case 'culled': upd.status = 'Culled'; break;
    default: throw bad('invalid_event_type');
  }
  const ev = (await c.query(
    `INSERT INTO dairy.animal_event (coop_org_id, animal_id, event_type, event_date, details, vet_partner_id, cost, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [coopId, animal.animal_id, eventType, eventDate, JSON.stringify(d), opts.vet_partner_id || null, cost, opts.recorded_by || null],
  )).rows[0];
  const keys = Object.keys(upd);
  if (keys.length) {
    await c.query(`UPDATE dairy.animal SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE animal_id=$1`,
      [animal.animal_id, ...Object.values(upd)]);
  }
  let charged = 0;
  const chargeType = eventType === 'insemination' ? 'ai_service'
    : ['treatment', 'vaccination', 'pregnancy_check'].includes(eventType) ? 'vet_service' : null;
  if (cost > 0 && chargeType && opts.charge_member !== false) {
    await addLedger(c, coopId, animal.member_id, chargeType, -cost, 'animal_event', ev.event_id,
      `${animal.ear_tag}: ${eventType}`, eventDate);
    charged = cost;
  }
  if (opts.request_id) {
    await c.query(
      `UPDATE dairy.service_request SET status='Done', done_at=now(), result_ref_id=$2
        WHERE request_id=$1 AND coop_org_id=$3 AND status IN ('Open','Assigned')`,
      [opts.request_id, ev.event_id, coopId],
    );
  }
  await logAccess(c, 'write', 'dairy.animal_event', ev.event_id);
  return { event: ev, calf, charged };
}

/**
 * Records the factory's result for a shipment (by the coop on the
 * factory's behalf, or by the factory itself in the partner portal) and
 * books AgroLink's fee (seller = coop pays).
 */
async function receiveShipment(c, ship, body) {
  if (ship.status !== 'Sent') throw conflict('invalid_shipment_status', { status: ship.status });
  const s = await settings(c, ship.coop_org_id);
  const b = body || {};
  if (b.status === 'Rejected') {
    const reason = String(b.reject_reason || '').trim();
    if (!reason) throw bad('missing_reject_reason');
    return (await c.query(
      `UPDATE dairy.shipment SET status='Rejected', reject_reason=$2, received_at=now() WHERE shipment_id=$1 RETURNING *`,
      [ship.shipment_id, reason],
    )).rows[0];
  }
  const kg = num(b.received_kg, { min: 0 });
  if (kg === null || Number.isNaN(kg) || kg <= 0) throw bad('invalid_field', { field: 'received_kg' });
  if (kg > Number(ship.sent_kg) * 1.02) throw bad('received_more_than_sent');
  let price = num(b.price_per_kg, { min: 0 });
  if (Number.isNaN(price)) throw bad('invalid_field', { field: 'price_per_kg' });
  if (price === null) {
    if (ship.contract_id) price = Number((await c.query('SELECT price_per_kg FROM dairy.contract WHERE contract_id=$1', [ship.contract_id])).rows[0].price_per_kg);
    else if (ship.proposal_id) price = Number((await c.query('SELECT price_per_kg FROM dairy.surplus_proposal WHERE proposal_id=$1', [ship.proposal_id])).rows[0].price_per_kg);
    else throw bad('missing_price');
  }
  const q = {};
  ['fat_pct', 'snf_pct', 'scc_k', 'tbc_k'].forEach((f) => {
    const v = num(b[f], { min: 0 });
    if (Number.isNaN(v)) throw bad('invalid_field', { field: f });
    q[f] = v;
  });
  const amount = round2(kg * price);
  const surplus = !!ship.proposal_id;
  const feeType = surplus ? 'surplus_sale' : 'raw_milk_sale';
  const rate = surplus ? Number(s.fee_rate_surplus_pct) : Number(s.fee_rate_raw_milk_pct);
  const fee = await addPlatformFee(c, ship.coop_org_id, feeType, 'coop', ship.coop_org_id, amount, rate, 'shipment', ship.shipment_id);
  return (await c.query(
    `UPDATE dairy.shipment SET status='Received', received_kg=$2, price_per_kg=$3, amount=$4, fat_pct=$5, snf_pct=$6, scc_k=$7, tbc_k=$8,
            fee_type=$9, fee_rate_pct=$10, fee_amount=$11, received_at=now() WHERE shipment_id=$1 RETURNING *`,
    [ship.shipment_id, kg, price, amount, q.fat_pct, q.snf_pct, q.scc_k, q.tbc_k, feeType, rate, fee],
  )).rows[0];
}

/**
 * Accepts a surplus proposal: links the processor to the coop as a
 * 'processor' partner (creating the link if needed), marks the offer
 * Matched and rejects every other pending proposal on it.
 */
async function acceptProposal(c, proposal, offer) {
  if (proposal.status !== 'Pending') throw conflict('invalid_proposal_status', { status: proposal.status });
  if (offer.status !== 'Open') throw conflict('offer_not_open', { status: offer.status });
  const prof = (await c.query('SELECT * FROM dairy.processor_profile WHERE org_id=$1', [proposal.processor_org_id])).rows[0];
  let partner = (await c.query(
    `SELECT partner_id FROM dairy.partner WHERE coop_org_id=$1 AND linked_org_id=$2 AND partner_type='processor' ORDER BY active DESC LIMIT 1`,
    [offer.coop_org_id, proposal.processor_org_id],
  )).rows[0];
  if (!partner) {
    partner = (await c.query(
      `INSERT INTO dairy.partner (coop_org_id, partner_type, name, phone, linked_org_id, note)
       VALUES ($1,'processor',$2,$3,$4,'จับคู่จากตลาดนมส่วนเกิน') RETURNING partner_id`,
      [offer.coop_org_id, prof.display_name, prof.contact_phone, proposal.processor_org_id],
    )).rows[0];
  } else await c.query('UPDATE dairy.partner SET active=true WHERE partner_id=$1', [partner.partner_id]);
  await c.query(`UPDATE dairy.surplus_proposal SET status='Accepted', decided_at=now(), partner_id=$2 WHERE proposal_id=$1`,
    [proposal.proposal_id, partner.partner_id]);
  await c.query(`UPDATE dairy.surplus_proposal SET status='Rejected', decided_at=now() WHERE offer_id=$1 AND status='Pending'`, [offer.offer_id]);
  await c.query(`UPDATE dairy.surplus_offer SET status='Matched' WHERE offer_id=$1`, [offer.offer_id]);
  return { proposal_id: proposal.proposal_id, partner_id: partner.partner_id, offer_id: offer.offer_id };
}

/**
 * Milk forecast for one coop over `horizon` days from tomorrow.
 *  - per member: average accepted kg/day over the last 14 days (today included) of rounds
 *    (zero-kg days included) ÷ cows currently Milking = kg per cow;
 *  - day by day, a Milking cow leaves the herd on its dry_off_due_date,
 *    a pregnant Dry/Heifer cow joins on its expected_calving_date;
 *  - members with no cow records keep their flat 14-day average.
 * Committed = active contracts + accepted surplus deals + school milk
 * deliveries (units × milk per unit) on school days within terms.
 */
async function forecast(c, coopId, horizon = 90) {
  const s = await settings(c, coopId);
  const today = bkkToday();
  const from = addDays(today, -13);
  const hist = (await c.query(
    `SELECT i.member_id, SUM(i.weight_kg) AS kg
       FROM dairy.milk_intake i JOIN dairy.milk_round r ON r.round_id=i.round_id
      WHERE i.coop_org_id=$1 AND i.status='Accepted' AND r.round_date >= $2 AND r.round_date <= $3
      GROUP BY i.member_id`,
    [coopId, from, today],
  )).rows;
  const daysWithRounds = Number((await c.query(
    'SELECT COUNT(DISTINCT round_date)::int AS n FROM dairy.milk_round WHERE coop_org_id=$1 AND round_date >= $2 AND round_date <= $3',
    [coopId, from, today],
  )).rows[0].n) || 0;
  const animals = (await c.query(
    `SELECT member_id, status, pregnant, expected_calving_date::text AS ecd, dry_off_due_date::text AS dod
       FROM dairy.animal WHERE coop_org_id=$1 AND sex='F' AND status IN ('Milking','Dry','Heifer')`,
    [coopId],
  )).rows;
  const byMember = new Map();
  animals.forEach((a) => {
    const m = byMember.get(a.member_id) || [];
    m.push(a);
    byMember.set(a.member_id, m);
  });
  const members = hist.map((hrow) => {
    const avg = daysWithRounds ? Number(hrow.kg) / daysWithRounds : 0;
    const cows = byMember.get(hrow.member_id) || [];
    const milking = cows.filter((a) => a.status === 'Milking').length;
    return { member_id: hrow.member_id, avg_kg_day: avg, cows, per_cow: milking ? avg / milking : null };
  });
  const contracts = (await c.query(
    `SELECT start_date::text AS s, end_date::text AS e, daily_kg FROM dairy.contract WHERE coop_org_id=$1 AND status='Active'`, [coopId],
  )).rows;
  const deals = (await c.query(
    `SELECT o.start_date::text AS s, o.days, p.kg_per_day FROM dairy.surplus_proposal p JOIN dairy.surplus_offer o ON o.offer_id=p.offer_id
      WHERE o.coop_org_id=$1 AND p.status='Accepted'`, [coopId],
  )).rows;
  const schools = (await c.query(
    `SELECT sc.school_id, sc.students, sc.units_per_student_day, sc.delivery_weekdays, pr.milk_kg_per_unit
       FROM dairy.school sc JOIN dairy.product pr ON pr.product_id=sc.product_id WHERE sc.coop_org_id=$1 AND sc.active`, [coopId],
  )).rows;
  const terms = (await c.query(
    'SELECT school_id, start_date::text AS s, end_date::text AS e FROM dairy.school_term WHERE coop_org_id=$1', [coopId],
  )).rows;
  const inTerm = (schoolId, day) => terms.some((t) => (t.school_id === null || t.school_id === schoolId) && t.s <= day && day <= t.e);
  const days = [];
  for (let i = 1; i <= horizon; i += 1) {
    const day = addDays(today, i);
    const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
    let fkg = 0;
    members.forEach((m) => {
      if (m.per_cow === null) { fkg += m.avg_kg_day; return; }
      const milking = m.cows.filter((a) => {
        if (a.status === 'Milking') return !(a.dod && a.dod <= day);
        return a.pregnant && a.ecd && a.ecd <= day;
      }).length;
      fkg += m.per_cow * milking;
    });
    let committed = 0;
    contracts.forEach((k) => { if (k.s <= day && day <= k.e) committed += Number(k.daily_kg); });
    deals.forEach((k) => { if (k.s <= day && day < addDays(k.s, Number(k.days))) committed += Number(k.kg_per_day); });
    let schoolKg = 0;
    schools.forEach((sc) => {
      if (!(sc.delivery_weekdays || []).map(Number).includes(wd) || !inTerm(sc.school_id, day)) return;
      schoolKg += Number(sc.students) * Number(sc.units_per_student_day) * Number(sc.milk_kg_per_unit);
    });
    committed += schoolKg;
    days.push({ date: day, forecast_kg: round2(fkg), committed_kg: round2(committed), school_kg: round2(schoolKg) });
  }
  const windows = [30, 60, 90].filter((w) => w <= horizon).map((w) => {
    const slice = days.slice(0, w);
    const f = slice.reduce((a, x) => a + x.forecast_kg, 0) / w;
    const k = slice.reduce((a, x) => a + x.committed_kg, 0) / w;
    return { days: w, avg_forecast_kg: round2(f), avg_committed_kg: round2(k), ...alertLevel(f, k, s) };
  });
  const recentAvg = round2(hist.reduce((a, x) => a + Number(x.kg), 0) / (daysWithRounds || 1));
  return {
    as_of: today, history_days: daysWithRounds, recent_avg_kg_day: daysWithRounds ? recentAvg : null,
    thresholds: { yellow: Number(s.alert_yellow_pct), orange: Number(s.alert_orange_pct), red: Number(s.alert_red_pct) },
    windows, days,
  };
}

/** Prices + books every accepted intake of a round (called when the round closes). */
async function priceRound(c, coopId, round) {
  const s = await settings(c, coopId);
  if (!(Number(s.base_price_per_kg) > 0)) throw conflict('base_price_not_set');
  const rules = (await c.query('SELECT * FROM dairy.quality_rule WHERE coop_org_id=$1 AND active', [coopId])).rows;
  const roundDate = ds(round.round_date);
  const intakes = (await c.query(
    `SELECT i.*, m.full_name FROM dairy.milk_intake i JOIN dairy.member m ON m.member_id=i.member_id WHERE i.round_id=$1`, [round.round_id],
  )).rows;
  let acc = 0; let rej = 0; let total = 0;
  for (const it of intakes) {
    if (it.status !== 'Accepted') { rej += Number(it.weight_kg); continue; }
    const test = (await c.query(
      `SELECT sample_date::text AS sample_date, fat_pct, snf_pct, scc_k, tbc_k FROM dairy.quality_test
        WHERE member_id=$1 AND sample_date <= $2 ORDER BY sample_date DESC, created_at DESC LIMIT 1`,
      [it.member_id, roundDate],
    )).rows[0];
    const { price, detail } = priceFor(s.base_price_per_kg, test, rules);
    const amount = round2(Number(it.weight_kg) * price);
    await c.query('UPDATE dairy.milk_intake SET price_per_kg=$2, amount=$3, price_detail=$4 WHERE intake_id=$1',
      [it.intake_id, price, amount, JSON.stringify(detail)]);
    await addLedger(c, coopId, it.member_id, 'milk_sale', amount, 'milk_intake', it.intake_id,
      `น้ำนม ${roundDate} ${round.shift === 'AM' ? 'เช้า' : 'เย็น'} ${it.weight_kg} กก. × ${price}`, roundDate);
    acc += Number(it.weight_kg); total += amount;
  }
  return { accepted_kg: round2(acc), rejected_kg: round2(rej), amount: round2(total), intakes: intakes.length };
}

module.exports = {
  settings, addLedger, addPlatformFee, openBalance, applyEvent, receiveShipment, acceptProposal, forecast, priceRound, daysBetween, notFound,
};
