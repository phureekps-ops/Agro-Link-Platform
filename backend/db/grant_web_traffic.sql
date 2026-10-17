-- AgroLink -- Public marketing-site page-view counter ("มีคนเปิดเข้ามาดูเว็บไซต์
-- Agrolinkthai เท่าไร" -- how many people have opened/viewed the Agrolinkthai
-- website), surfaced on the admin (Platform Ops) portal.
--
-- This is deliberately NOT the same thing as the existing `analytics` schema
-- (see grant_analytics_warehouse.sql) -- that schema is business-data BI
-- (cooperative membership, delivery volume, warehouse utilization, ...),
-- explicitly scoped to COOPERATIVE-owned data to feed the M14/M15 government
-- aggregate dashboard. This is raw HTTP traffic on the public frontend/*.html
-- marketing pages -- an unrelated concern with an unrelated access pattern
-- (written by anonymous visitors, read only by Platform Ops) -- so it gets
-- its own schema rather than growing `analytics` to cover both.
--
-- Design decisions:
--   1. No RLS, no per-actor ownership column -- same reasoning as
--      content.about_section (see grant_about_content.sql / content.js):
--      an anonymous site visitor has no identity.subject_role row to scope
--      a policy to, and the only reader is Platform Ops (gated at the route
--      layer by requireAuth + requirePlatform, same as every other /admin/*
--      endpoint -- see backend/src/routes/admin.js).
--   2. No raw IP address is ever stored. visitor_hash is a SHA-256 of
--      (ip + user-agent + today's Bangkok-local date + a server-side salt),
--      computed in the API route (see backend/src/routes/traffic.js) and
--      discarded immediately after -- it rotates every calendar day, so it
--      cannot be used to reconstruct one visitor's history across days or
--      correlate with any other system. It exists ONLY so the admin
--      dashboard can show "how many distinct people" (COUNT DISTINCT
--      visitor_hash) rather than just raw hit counts, for a single day/
--      week/month window.
--   3. user_agent is stored in full (not PII on its own -- a browser/OS
--      string shared by thousands of visitors) so a future pass can break
--      traffic down by device/browser without a schema change; nothing in
--      this pass reads it back out yet.
--   4. Follow-up (not built in this pass, same spirit as
--      grant_analytics_warehouse.sql's own Follow-up notes):
--        - No bot/crawler filtering -- every POST /traffic/track hit is
--          counted as-is. A real deployment getting meaningful search-
--          engine-bot traffic would want a simple user-agent allowlist/
--          denylist pass before counting.
--        - No per-IP rate limiting at the database layer (the API route is
--          deliberately permissive/best-effort, matching a page-view
--          counter's low-stakes nature) -- would be the first thing to add
--          if this ever saw abuse.
--        - traffic.v_pageviews_daily aggregates over the ENTIRE history
--          with no retention/pruning policy -- fine at a prototype's
--          traffic volume; a high-traffic production deployment would want
--          a retention job (e.g. roll anything older than N months into a
--          monthly summary table and drop the raw rows).
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS traffic;
GRANT USAGE ON SCHEMA traffic TO agrolink_app;

-- ---------------------------------------------------------------------
-- 1. traffic.page_view -- one row per page load on a public frontend/*.html
--    page. Append-only from the visitor's side (POST /traffic/track never
--    updates or deletes a row); Platform Ops only ever reads it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS traffic.page_view (
  view_id       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),  -- same id convention as grant_support_chat.sql etc.
  path          TEXT NOT NULL,               -- e.g. '/integrated-longan-business.html' -- see frontend/js/track.js
  referrer      TEXT,                        -- document.referrer as reported by the browser, if any
  visitor_hash  TEXT NOT NULL,                -- SHA-256, rotates daily -- see design decision #2 above; never a raw IP
  user_agent    TEXT,                        -- full UA string -- see design decision #3 above
  viewed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE traffic.page_view IS
  'One row per public marketing-site page load, written by the anonymous '
  'POST /traffic/track endpoint. visitor_hash is a daily-rotating SHA-256, '
  'never a raw IP -- see this file''s header comment for the full design '
  'rationale.';

CREATE INDEX IF NOT EXISTS idx_page_view_viewed_at ON traffic.page_view (viewed_at);
CREATE INDEX IF NOT EXISTS idx_page_view_path ON traffic.page_view (path);
CREATE INDEX IF NOT EXISTS idx_page_view_visitor_hash ON traffic.page_view (visitor_hash);

GRANT SELECT, INSERT ON traffic.page_view TO agrolink_app;

-- ---------------------------------------------------------------------
-- 2. traffic.v_pageviews_daily -- one row per Bangkok-local calendar day,
--    oldest-to-newest irrelevant (ORDER BY view_date DESC, most recent
--    first) -- the shape GET /admin/traffic-summary needs for a trend list,
--    same "views are the GROUP-BY shape a dashboard needs for a chart"
--    convention as grant_analytics_warehouse.sql's views.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW traffic.v_pageviews_daily AS
SELECT
  (viewed_at AT TIME ZONE 'Asia/Bangkok')::date AS view_date,
  COUNT(*)::bigint AS pageviews,
  COUNT(DISTINCT visitor_hash)::bigint AS unique_visitors
FROM traffic.page_view
GROUP BY (viewed_at AT TIME ZONE 'Asia/Bangkok')::date
ORDER BY view_date DESC;

GRANT SELECT ON traffic.v_pageviews_daily TO agrolink_app;
