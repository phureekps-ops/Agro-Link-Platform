/**
 * Dairy member notifications (backend/db/grant_dairy_line_notify.sql).
 *
 *  - notify*(): called INSIDE the caller's transaction, right where the event
 *    happens. Each writes rows to dairy.notification (the member's in-app
 *    inbox on dairy-member.html) — one per member that has a farmer account.
 *    Same event twice (e.g. "paid" pressed again) is de-duplicated by the
 *    unique (kind, ref_id, farmer, member) index.
 *  - kick(): after the request, pushes pending rows to LINE (Messaging API
 *    push). X-Line-Retry-Key = notif_id, so a retry after a timeout is never
 *    delivered twice. A 60-second sweep (start()) retries failures.
 *
 * LINE is optional: with no LINE_CHANNEL_ACCESS_TOKEN the inbox still works
 * and rows simply stay 'pending' (anything older than 24 h becomes 'expired'
 * instead of being blasted out the day LINE is switched on).
 *
 * Env: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET (webhook, see
 * routes/line.js), LINE_OA_ID (e.g. @agrolink — shown on the member page),
 * APP_PUBLIC_URL (optional, link at the end of each message),
 * LINE_API_BASE (tests only; default https://api.line.me).
 */
const { withServiceRole } = require('../db/pool');

const MAX_ATTEMPTS = 5;
const KINDS = ['milk_rejected', 'quality', 'settlement', 'request', 'membership', 'test'];
const PREF_KINDS = ['milk_rejected', 'quality', 'settlement', 'request', 'membership'];

const apiBase = () => (process.env.LINE_API_BASE || 'https://api.line.me').replace(/\/$/, '');
const lineConfigured = () => !!process.env.LINE_CHANNEL_ACCESS_TOKEN;
const webhookConfigured = () => !!process.env.LINE_CHANNEL_SECRET;

const baht = (v) => Number(v || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kg = (v) => Number(v || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const TH_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
/** '2026-11-21' (or a pg Date) → '21 พ.ย.' */
function thDate(v) {
  if (!v) return '-';
  let y; let m; let d;
  if (v instanceof Date) { y = v.getFullYear(); m = v.getMonth() + 1; d = v.getDate(); } else [y, m, d] = String(v).slice(0, 10).split('-').map(Number);
  return y ? `${d} ${TH_MONTH[m - 1]}` : '-';
}
const REJECT_TH = {
  antibiotic: 'พบยาตกค้าง', temperature: 'อุณหภูมิไม่ผ่าน', smell: 'กลิ่นผิดปกติ', clot: 'นมจับตัว', other: 'อื่น ๆ',
};
const REQUEST_TH = { feed: 'เบิกอาหาร/ปัจจัย', vet: 'เรียกสัตวแพทย์', ai: 'ผสมเทียม' };
const PARAM_TH = {
  fat: 'ไขมัน', snf: 'SNF', scc: 'SCC', tbc: 'แบคทีเรีย',
};

/** Inserts one inbox row (skips members with no farmer account). Returns true if a new row was written. */
async function add(c, {
  farmerId, memberId = null, coopId = null, kind, title, body, refType = null, refId = null,
}) {
  if (!farmerId) return false;
  if (!KINDS.includes(kind)) throw new Error(`unknown notification kind ${kind}`);
  const r = await c.query(
    `INSERT INTO dairy.notification (farmer_id, member_id, coop_org_id, kind, title, body, ref_type, ref_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING notif_id`,
    [farmerId, memberId, coopId, kind, String(title).slice(0, 200), String(body).slice(0, 2000), refType, refId],
  );
  if (r.rows.length) kick();
  return r.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Events. Each takes the caller's client (inside its transaction).
// ---------------------------------------------------------------------------

/** Round closed: tell each member whose milk was turned away, and why. */
async function notifyRoundRejections(c, round) {
  const rows = (await c.query(
    `SELECT i.intake_id, i.weight_kg, i.reject_reason, m.member_id, m.farmer_id, m.coop_org_id
       FROM dairy.milk_intake i JOIN dairy.member m ON m.member_id=i.member_id
      WHERE i.round_id=$1 AND i.status='Rejected' AND m.farmer_id IS NOT NULL`, [round.round_id],
  )).rows;
  for (const r of rows) {
    await add(c, {
      farmerId: r.farmer_id,
      memberId: r.member_id,
      coopId: r.coop_org_id,
      kind: 'milk_rejected',
      title: 'น้ำนมไม่ผ่านการรับ',
      body: `รอบ${round.shift === 'AM' ? 'เช้า' : 'เย็น'} ${thDate(round.round_date)}: น้ำนม ${kg(r.weight_kg)} กก. ไม่ผ่านการรับ`
        + ` (${REJECT_TH[r.reject_reason] || r.reject_reason}) ไม่ได้ค่านมรอบนี้ โปรดติดต่อสหกรณ์`,
      refType: 'milk_intake',
      refId: r.intake_id,
    });
  }
  return rows.length;
}

/** New lab result: the numbers and the price per kg it now earns. */
async function notifyQualityTest(c, test, member, priced) {
  const parts = [];
  if (test.fat_pct !== null && test.fat_pct !== undefined) parts.push(`ไขมัน ${kg(test.fat_pct)}%`);
  if (test.snf_pct !== null && test.snf_pct !== undefined) parts.push(`SNF ${kg(test.snf_pct)}%`);
  if (test.scc_k !== null && test.scc_k !== undefined) parts.push(`SCC ${kg(test.scc_k)} พัน`);
  if (test.tbc_k !== null && test.tbc_k !== undefined) parts.push(`แบคทีเรีย ${kg(test.tbc_k)} พัน`);
  const adj = priced.detail.adjustments.map((a) => `${PARAM_TH[a.param]} ${a.adjust > 0 ? '+' : ''}${a.adjust}`).join(', ');
  let body = `ผลตรวจน้ำนม ${thDate(test.sample_date)}: ${parts.join(' · ')}\nราคาที่ได้ ${kg(priced.price)} บาท/กก.`
    + ` (ราคาฐาน ${kg(priced.detail.base)}${adj ? `, ${adj}` : ''})`;
  if (test.antibiotic_pos) body += '\n⚠️ พบยาตกค้าง — ห้ามส่งนมจากโคที่ได้รับยาจนพ้นระยะหยุดยา';
  return add(c, {
    farmerId: member.farmer_id,
    memberId: member.member_id,
    coopId: member.coop_org_id,
    kind: 'quality',
    title: 'ผลตรวจคุณภาพน้ำนม',
    body,
    refType: 'quality_test',
    refId: test.test_id,
  });
}

/** Settlement run marked paid: net transferred, deductions and anything carried over. */
async function notifySettlementPaid(c, run) {
  const lines = (await c.query(
    `SELECT s.member_id, s.total_credit, s.total_debit, s.net_amount, s.carried_debit, s.baac_account_no, m.farmer_id, m.coop_org_id
       FROM dairy.settlement_line s JOIN dairy.member m ON m.member_id=s.member_id
      WHERE s.run_id=$1 AND m.farmer_id IS NOT NULL`, [run.run_id],
  )).rows;
  for (const l of lines) {
    const acct = l.baac_account_no ? ` เข้าบัญชี ธ.ก.ส. ****${String(l.baac_account_no).slice(-4)}` : '';
    let body = `รอบ ${thDate(run.period_start)} – ${thDate(run.period_end)}: สหกรณ์โอนเงิน ${baht(l.net_amount)} บาท${acct}`
      + `\nรายรับ ${baht(l.total_credit)} หัก ${baht(l.total_debit)}`;
    if (Number(l.carried_debit) > 0) body += `\nยอดหักที่ยกไปรอบหน้า ${baht(l.carried_debit)} บาท`;
    await add(c, {
      farmerId: l.farmer_id,
      memberId: l.member_id,
      coopId: l.coop_org_id,
      kind: 'settlement',
      title: Number(l.net_amount) > 0 ? 'โอนเงินค่านมแล้ว' : 'สรุปรอบจ่ายเงิน',
      body,
      refType: 'settlement_run',
      refId: run.run_id,
    });
  }
  return lines.length;
}

/** Service request (feed / vet / AI) changed state. status: Assigned | Done | Cancelled. */
async function notifyRequest(c, request, status, extra = {}) {
  const m = (await c.query('SELECT member_id, farmer_id, coop_org_id FROM dairy.member WHERE member_id=$1', [request.member_id])).rows[0];
  if (!m || !m.farmer_id) return false;
  const what = REQUEST_TH[request.request_type] || 'คำขอบริการ';
  const text = {
    Assigned: `คำขอ${what}ของคุณ: สหกรณ์มอบหมาย${extra.partner_name ? ` ${extra.partner_name}` : 'สัตวแพทย์'}แล้ว จะติดต่อกลับเร็ว ๆ นี้`,
    Done: `คำขอ${what}ของคุณเสร็จแล้ว${extra.amount ? ` ค่าใช้จ่าย ${baht(extra.amount)} บาท (หักจากค่านมรอบถัดไป)` : ''}`,
    Cancelled: `คำขอ${what}ของคุณถูกยกเลิก${extra.reason ? `: ${extra.reason}` : ''}`,
  }[status];
  if (!text) return false;
  // ref = request; one row per (request, status) via a status-specific ref_type
  return add(c, {
    farmerId: m.farmer_id,
    memberId: m.member_id,
    coopId: m.coop_org_id,
    kind: 'request',
    title: { Assigned: 'มอบหมายงานแล้ว', Done: 'คำขอเสร็จแล้ว', Cancelled: 'คำขอถูกยกเลิก' }[status],
    body: text,
    refType: `service_request:${status}`,
    refId: status === 'Assigned' ? null : request.request_id, // re-assigning to another vet notifies again
  });
}

/** Membership approved / suspended. */
async function notifyMembership(c, member, status, coopName) {
  const text = {
    Approved: `${coopName || 'สหกรณ์'} อนุมัติการเป็นสมาชิกแล้ว (รหัสสมาชิก ${member.member_code}) เริ่มส่งนมที่ศูนย์รวบรวมได้`,
    Suspended: `${coopName || 'สหกรณ์'} ระงับการเป็นสมาชิกชั่วคราว โปรดติดต่อสหกรณ์`,
  }[status];
  if (!text) return false;
  return add(c, {
    farmerId: member.farmer_id,
    memberId: member.member_id,
    coopId: member.coop_org_id,
    kind: 'membership',
    title: status === 'Approved' ? 'อนุมัติสมาชิกแล้ว' : 'ระงับสมาชิกชั่วคราว',
    body: text,
  });
}

// ---------------------------------------------------------------------------
// LINE Messaging API
// ---------------------------------------------------------------------------
async function lineCall(path, payload, retryKey) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` };
  if (retryKey) headers['X-Line-Retry-Key'] = retryKey;
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
  });
  if (res.ok) return { ok: true };
  // 409 with a retry key = LINE already accepted this exact message earlier
  if (res.status === 409 && retryKey) return { ok: true, duplicate: true };
  let detail = '';
  try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
  return { ok: false, status: res.status, error: `HTTP ${res.status} ${detail}` };
}

const pushText = (to, text, retryKey) => lineCall('/v2/bot/message/push', { to, messages: [{ type: 'text', text: text.slice(0, 5000) }] }, retryKey);
const replyText = (replyToken, text) => lineCall('/v2/bot/message/reply', { replyToken, messages: [{ type: 'text', text: text.slice(0, 5000) }] });

function messageText(n) {
  const link = process.env.APP_PUBLIC_URL ? `\n\nดูรายละเอียด: ${process.env.APP_PUBLIC_URL.replace(/\/$/, '')}/dairy-member.html` : '';
  return `🐄 ${n.coop_name ? `${n.coop_name}\n` : ''}${n.title}\n${n.body}${link}`;
}

let flushing = null;
let again = false;
/**
 * Sends every pending notification it can. Safe to call any time; concurrent
 * calls collapse into one running sweep (plus one follow-up).
 */
async function flush() {
  if (flushing) { again = true; return flushing; }
  flushing = (async () => {
    const out = { sent: 0, failed: 0, skipped: 0 };
    try {
      do {
        again = false;
        // eslint-disable-next-line no-await-in-loop
        const r = await withServiceRole((c) => sweep(c));
        out.sent += r.sent; out.failed += r.failed; out.skipped += r.skipped;
      } while (again);
    } catch (err) {
      console.error('[line] notification sweep failed', err.message);
    } finally {
      flushing = null;
    }
    return out;
  })();
  return flushing;
}

async function sweep(c) {
  const out = { sent: 0, failed: 0, skipped: 0 };
  await c.query(`UPDATE dairy.notification SET line_status='expired' WHERE line_status='pending' AND created_at < now() - interval '24 hours'`);
  if (!lineConfigured()) return out;
  // nobody to send to: no LINE link, link switched off, or this kind muted
  const sk = await c.query(
    `UPDATE dairy.notification n SET line_status = CASE WHEN l.farmer_id IS NULL OR NOT l.active THEN 'no_link' ELSE 'muted' END
       FROM dairy.notification x LEFT JOIN dairy.line_link l ON l.farmer_id=x.farmer_id
      WHERE n.notif_id=x.notif_id AND n.line_status='pending' AND x.kind <> 'test'
        AND (l.farmer_id IS NULL OR NOT l.active OR COALESCE((l.prefs->>x.kind)::boolean, true) = false)`,
  );
  out.skipped += sk.rowCount;
  for (;;) {
    // claim a batch so two app instances never push the same row
    const r = await sendBatch(c);
    out.sent += r.sent; out.failed += r.failed;
    if (!r.claimed || !r.progressed) break; // nothing left, or LINE is down: leave the rest for the next sweep
  }
  return out;
}

async function sendBatch(c) {
  const out = {
    sent: 0, failed: 0, claimed: 0, progressed: false,
  };
  await c.query('BEGIN');
  try {
    const batch = (await c.query(
      `SELECT n.*, l.line_user_id, o.org_name AS coop_name FROM dairy.notification n
         JOIN dairy.line_link l ON l.farmer_id=n.farmer_id AND l.active
         LEFT JOIN identity.organization o ON o.org_id=n.coop_org_id
        WHERE n.line_status='pending' AND (n.kind='test' OR COALESCE((l.prefs->>n.kind)::boolean, true))
        ORDER BY n.created_at LIMIT 20 FOR UPDATE OF n SKIP LOCKED`,
    )).rows;
    out.claimed = batch.length;
    for (const n of batch) {
      let r;
      try { r = await pushText(n.line_user_id, messageText(n), n.notif_id); } catch (err) { r = { ok: false, error: err.message }; }
      if (r.ok) {
        await c.query(`UPDATE dairy.notification SET line_status='sent', line_sent_at=now(), line_attempts=line_attempts+1, line_error=NULL WHERE notif_id=$1`, [n.notif_id]);
        out.sent += 1; out.progressed = true;
      } else {
        // 4xx other than 429 will not get better by retrying (bad token, user blocked the OA …)
        const permanent = r.status && r.status >= 400 && r.status < 500 && r.status !== 429;
        const attempts = n.line_attempts + 1;
        const status = permanent || attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
        await c.query('UPDATE dairy.notification SET line_status=$2, line_attempts=$3, line_error=$4 WHERE notif_id=$1',
          [n.notif_id, status, attempts, String(r.error || 'error').slice(0, 300)]);
        out.failed += 1;
        if (status === 'failed') out.progressed = true;
      }
    }
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  }
  return out;
}

let kickTimer = null;
/** Schedules a sweep shortly after the current request finishes (its transaction must commit first). */
function kick() {
  if (kickTimer) return;
  kickTimer = setTimeout(() => { kickTimer = null; flush(); }, 300);
  if (kickTimer.unref) kickTimer.unref();
}

let interval = null;
/** Retry sweep every 60 s (called once from server.js). */
function start() {
  if (interval || process.env.NODE_ENV === 'test') return;
  interval = setInterval(() => { flush(); }, 60000);
  if (interval.unref) interval.unref();
}

module.exports = {
  add,
  notifyRoundRejections,
  notifyQualityTest,
  notifySettlementPaid,
  notifyRequest,
  notifyMembership,
  flush,
  kick,
  start,
  pushText,
  replyText,
  lineConfigured,
  webhookConfigured,
  messageText,
  thDate,
  PREF_KINDS,
};
