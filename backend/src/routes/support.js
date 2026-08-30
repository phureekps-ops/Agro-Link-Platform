const express = require('express');

const { withSessionContext } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * Support Chat Widget — see grant_support_chat.sql for the schema and the
 * user request that scoped this feature (web widget first, text only,
 * routed to a human admin, every portal). Mounted generically for EVERY
 * subject type EXCEPT 'platform' (same "own prefix, not portal-scoped"
 * convention as procurement.js/farmer360.js) — `router.use(requireAuth)`
 * only, no requireFarmer/requireOrganization gate, because the caller can
 * legitimately be a farmer, an organization, a cooperative staff member,
 * or a government officer. isSupportEligible() below is the actual gate,
 * same pattern as procurement.js's isRequesterEligible().
 *
 * The admin (platform) side of this feature — listing every conversation,
 * reading a thread, replying — lives in admin.js under /admin/support/*,
 * not here, matching this project's convention of keeping all
 * platform-only endpoints inside admin.js rather than scattering
 * requirePlatform gates across every other route file.
 */
router.use(requireAuth);

function isSupportEligible(subjectType) {
  return (
    subjectType === 'farmer' ||
    subjectType === 'organization' ||
    subjectType === 'organization_member' ||
    subjectType === 'government_officer'
  );
}

/**
 * GET /support/messages — the calling subject's own support conversation
 * with AgroLink staff. Returns { conversation: null, messages: [] } if
 * this subject has never sent a message yet (there is deliberately no
 * "start a conversation" step separate from sending the first message —
 * POST /support/messages below creates it lazily).
 *
 * Marks the conversation read BY THE USER (unread_by_user -> false) as a
 * side effect — the widget calls this both for its initial load and to
 * poll for admin replies, so "the user has now seen this" is exactly what
 * calling this endpoint means.
 */
router.get('/messages', async (req, res, next) => {
  const { subjectType, subjectId } = req.subject;
  if (!isSupportEligible(subjectType)) {
    return res.status(403).json({ error: 'subject_type_not_eligible' });
  }
  try {
    const result = await withSessionContext(subjectType, subjectId, async (client) => {
      const convResult = await client.query(
        `SELECT conversation_id, status, last_message_at
           FROM support.conversation
          WHERE subject_type = $1 AND subject_id = $2`,
        [subjectType, subjectId],
      );
      if (convResult.rows.length === 0) {
        return { conversation: null, messages: [] };
      }
      const conversation = convResult.rows[0];
      const messagesResult = await client.query(
        `SELECT message_id, sender_role, body, created_at
           FROM support.message
          WHERE conversation_id = $1
          ORDER BY created_at ASC`,
        [conversation.conversation_id],
      );
      await client.query(
        `UPDATE support.conversation SET unread_by_user = false WHERE conversation_id = $1`,
        [conversation.conversation_id],
      );
      return { conversation, messages: messagesResult.rows };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /support/messages — body { message } → get-or-create this
 * subject's own conversation (ON CONFLICT upsert on the
 * (subject_type, subject_id) unique constraint — see
 * grant_support_chat.sql) and append a sender_role='user' message.
 * Flags unread_by_admin=true and re-opens the conversation
 * (status='open') so it surfaces on the admin support inbox
 * (GET /admin/support/conversations in admin.js) even if it had
 * previously been closed.
 */
router.post('/messages', async (req, res, next) => {
  const { subjectType, subjectId } = req.subject;
  if (!isSupportEligible(subjectType)) {
    return res.status(403).json({ error: 'subject_type_not_eligible' });
  }
  const body = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  if (!body) return res.status(400).json({ error: 'message_required' });
  if (body.length > 4000) return res.status(400).json({ error: 'message_too_long', max_length: 4000 });

  try {
    const message = await withSessionContext(subjectType, subjectId, async (client) => {
      const convResult = await client.query(
        `INSERT INTO support.conversation (subject_type, subject_id, unread_by_admin, last_message_at)
              VALUES ($1, $2, true, now())
         ON CONFLICT (subject_type, subject_id)
         DO UPDATE SET unread_by_admin = true, last_message_at = now(), status = 'open', updated_at = now()
         RETURNING conversation_id`,
        [subjectType, subjectId],
      );
      const conversationId = convResult.rows[0].conversation_id;
      const msgResult = await client.query(
        `INSERT INTO support.message (conversation_id, sender_role, body)
              VALUES ($1, 'user', $2)
         RETURNING message_id, sender_role, body, created_at`,
        [conversationId, body],
      );
      return msgResult.rows[0];
    });
    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
