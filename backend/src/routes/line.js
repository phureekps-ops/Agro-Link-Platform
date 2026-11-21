const crypto = require('crypto');
const express = require('express');

const { withServiceRole } = require('../db/pool');
const notify = require('../lib/dairyNotify');

/**
 * POST /line/webhook — LINE Messaging API webhook for the AgroLink Official
 * Account (set this URL in LINE Developers › Messaging API › Webhook URL:
 *   https://<backend>/line/webhook ).
 *
 * Mounted in server.js BEFORE express.json(): the signature is an HMAC of the
 * exact raw body bytes, so this router parses its own body. Every request
 * without a valid X-Line-Signature (HMAC-SHA256 with LINE_CHANNEL_SECRET) is
 * rejected; nothing here trusts a userId that LINE did not sign.
 *
 * Chat commands from a LINE user:
 *   <6-digit code>  link this LINE account to the farmer who generated the
 *                   code on dairy-member.html (code: single use, 10 minutes)
 *   ยกเลิก / หยุด    stop notifications (unlink)
 *   anything else   help text
 * follow → welcome text, unfollow (blocked the OA) → link switched off.
 */
const router = express.Router();

const HELP = 'พิมพ์รหัส 6 หลักจากหน้า "โคนมของฉัน" ใน AgroLink เพื่อรับแจ้งเตือนค่านม ผลตรวจคุณภาพ และการโอนเงิน\n'
  + 'พิมพ์ "ยกเลิก" เพื่อหยุดรับแจ้งเตือน';

// Wrong-code throttle per LINE user (in memory; one Render instance).
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 5;
const fails = new Map();
function tooManyFails(userId) {
  const now = Date.now();
  const list = (fails.get(userId) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  fails.set(userId, list);
  return list.length >= MAX_FAILS;
}
function addFail(userId) {
  const list = fails.get(userId) || [];
  list.push(Date.now());
  fails.set(userId, list);
  if (fails.size > 5000) fails.clear(); // memory cap
}

const hashCode = (code) => crypto.createHash('sha256').update(`dairy-line:${code}`).digest('hex');

function validSignature(raw, signature) {
  if (!signature || !process.env.LINE_CHANNEL_SECRET) return false;
  const expected = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET).update(raw).digest();
  let got;
  try { got = Buffer.from(String(signature), 'base64'); } catch { return false; }
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/** Links lineUserId to the farmer who owns `code`. Returns a reply text. */
async function linkWithCode(c, lineUserId, code) {
  if (tooManyFails(lineUserId)) return 'ใส่รหัสผิดหลายครั้ง โปรดรอ 10 นาทีแล้วขอรหัสใหม่จากหน้า "โคนมของฉัน"';
  await c.query('BEGIN');
  try {
    const row = (await c.query(
      `UPDATE dairy.line_link_code SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING farmer_id`,
      [hashCode(code)],
    )).rows[0];
    if (!row) {
      await c.query('ROLLBACK');
      addFail(lineUserId);
      return 'รหัสไม่ถูกต้องหรือหมดอายุแล้ว โปรดกดขอรหัสใหม่ในหน้า "โคนมของฉัน"';
    }
    // one LINE account ↔ one farmer: drop any older link of this LINE user
    await c.query('DELETE FROM dairy.line_link WHERE line_user_id=$1 AND farmer_id<>$2', [lineUserId, row.farmer_id]);
    await c.query(
      `INSERT INTO dairy.line_link (farmer_id, line_user_id, active) VALUES ($1,$2,true)
       ON CONFLICT (farmer_id) DO UPDATE SET line_user_id=EXCLUDED.line_user_id, active=true, linked_at=now(), updated_at=now()`,
      [row.farmer_id, lineUserId],
    );
    const f = (await c.query('SELECT full_name FROM identity.farmer WHERE farmer_id=$1', [row.farmer_id])).rows[0];
    await c.query('COMMIT');
    fails.delete(lineUserId);
    return `ผูกบัญชีสำเร็จ${f ? ` (${f.full_name})` : ''} ✅\nต่อไปนี้จะได้รับแจ้งเตือนจากสหกรณ์โคนมทาง LINE นี้\nพิมพ์ "ยกเลิก" เมื่อต้องการหยุดรับ`;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function handleEvent(c, ev) {
  const userId = ev.source && ev.source.type === 'user' ? ev.source.userId : null;
  if (!userId || !/^U[0-9a-f]{32}$/.test(userId)) return null;
  if (ev.type === 'follow') return `สวัสดีครับ 🐄\n${HELP}`;
  if (ev.type === 'unfollow') {
    await c.query('UPDATE dairy.line_link SET active=false, updated_at=now() WHERE line_user_id=$1', [userId]);
    return null;
  }
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return null;
  const text = String(ev.message.text || '').trim().replace(/\s+/g, '');
  if (/^\d{6}$/.test(text)) return linkWithCode(c, userId, text);
  if (['ยกเลิก', 'หยุด', 'stop'].includes(text.toLowerCase())) {
    const r = await c.query('UPDATE dairy.line_link SET active=false, updated_at=now() WHERE line_user_id=$1 AND active', [userId]);
    return r.rowCount ? 'หยุดส่งแจ้งเตือนแล้ว เปิดใหม่ได้ที่หน้า "โคนมของฉัน"' : 'LINE นี้ยังไม่ได้ผูกกับบัญชี AgroLink';
  }
  return HELP;
}

router.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!notify.webhookConfigured()) return res.status(503).json({ error: 'line_not_configured' });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!validSignature(raw, req.get('x-line-signature'))) return res.status(401).json({ error: 'invalid_signature' });
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'invalid_json' }); }
  const events = Array.isArray(body.events) ? body.events.slice(0, 100) : [];
  // LINE wants a fast 200; the "verify" button sends an empty events list
  res.status(200).json({ ok: true });
  for (const ev of events) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const reply = await withServiceRole((c) => handleEvent(c, ev));
      if (reply && ev.replyToken && notify.lineConfigured()) {
        // eslint-disable-next-line no-await-in-loop
        const r = await notify.replyText(ev.replyToken, reply);
        if (!r.ok) console.error('[line] reply failed', r.error);
      }
    } catch (err) {
      console.error('[line] webhook event failed', err.message);
    }
  }
  return undefined;
});

module.exports = { router, hashCode, validSignature };
