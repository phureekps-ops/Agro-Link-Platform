-- AgroLink Platform — Support Chat Widget (added 2026-08-30).
--
-- User request: "ทำ Widget บนเว็บ/แอป ... รับข้อความ/เสียงจากผู้ใช้ ส่งต่อไป
-- ยัง Backend ได้ไหม" — scoped down via clarifying questions to: web widget
-- first (LINE OA deferred — needs a LINE Developers channel + a publicly
-- reachable webhook host, neither of which exist in this sandbox yet),
-- text messages only for this round (voice needs an external
-- speech-to-text API key not available here), routed to a human AgroLink
-- support team who reads and replies from the admin dashboard (not an AI
-- auto-responder), and available from every portal (every subject type
-- that can hold a JWT except 'platform' itself — the admin side is the
-- one answering, not another sender).
--
-- Design mirrors procurement.rfq's own polymorphic-subject convention
-- (see grant_rfq_marketplace.sql's header): subject_type/subject_id
-- pairs instead of one FK per subject type, "no RLS, explicit WHERE
-- clause IS the security boundary" (same as every marketplace.*/
-- procurement.* table in this schema — see the note atop
-- src/routes/machinery.js), and a per-subject SINGLE conversation model
-- (one open thread per farmer/org/staff member/officer, not a
-- ticket-per-issue system) since this is meant to feel like a persistent
-- "chat with AgroLink support" channel, not a helpdesk queue. If a real
-- ticket/ticket-history model is ever needed, this is the place to widen
-- (e.g. an is_archived flag + "start a new conversation" affordance),
-- not built this pass.

CREATE SCHEMA IF NOT EXISTS support;

CREATE TABLE IF NOT EXISTS support.conversation (
  conversation_id  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  subject_type     text NOT NULL,
  subject_id       uuid NOT NULL,
  status           text NOT NULL DEFAULT 'open',
  -- Two independent flags rather than one "who's turn is it" enum, since
  -- both a user's follow-up message and an admin's reply are each
  -- possible while the other side hasn't read the latest yet (e.g. the
  -- user sends two messages in a row before admin has read the first).
  unread_by_admin  boolean NOT NULL DEFAULT true,
  unread_by_user   boolean NOT NULL DEFAULT false,
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_conversation_subject_type_check
    CHECK (subject_type IN ('farmer', 'organization', 'organization_member', 'government_officer')),
  CONSTRAINT support_conversation_status_check
    CHECK (status IN ('open', 'closed')),
  -- One conversation per subject — POST /support/messages upserts on this
  -- (see support.js), so a returning user always lands back in the same
  -- thread rather than fragmenting into a new one per session.
  CONSTRAINT uq_support_conversation_subject UNIQUE (subject_type, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_support_conversation_last_message
  ON support.conversation (last_message_at DESC);

CREATE TABLE IF NOT EXISTS support.message (
  message_id       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id  uuid NOT NULL REFERENCES support.conversation(conversation_id) ON DELETE CASCADE,
  sender_role      text NOT NULL,
  body             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_message_sender_role_check CHECK (sender_role IN ('user', 'admin')),
  CONSTRAINT support_message_body_check CHECK (length(trim(body)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_support_message_conversation
  ON support.message (conversation_id, created_at);

GRANT USAGE ON SCHEMA support TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON support.conversation TO agrolink_app;
GRANT SELECT, INSERT ON support.message TO agrolink_app;

-- ============================================================
-- Verification notes (run manually, not part of this script):
--   1. As a farmer/org/staff/officer subject: POST /support/messages
--      { "message": "..." } twice — second call should upsert onto the
--      SAME conversation_id (uq_support_conversation_subject), not create
--      a second row.
--   2. GET /support/messages as that same subject should return both
--      messages, sender_role='user', and mark unread_by_user=false.
--   3. As a platform/admin subject: GET /admin/support/conversations
--      should show that conversation with unread_by_admin=true and a
--      resolved subject_label (farmer/org/staff/officer name).
--   4. POST /admin/support/conversations/:id/reply { "message": "..." }
--      should append a sender_role='admin' row and flip
--      unread_by_user=true — the original subject's next
--      GET /support/messages call should show it.
-- ============================================================
