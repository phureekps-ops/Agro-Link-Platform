-- AgroLink -- fix: grant agrolink_app SELECT on the ops/monitoring views
-- that GET /admin/dashboard (Platform Ops "ภาพรวม" panel) reads.
--
-- ops.v_integrity_checksum, monitoring.v_go_live_readiness, and
-- monitoring.v_active_alerts were created back in Layer 9/10 and queried
-- manually via psql (as the agrolink owner role) during development --
-- GET /admin/dashboard (added later, see routes/admin.js) reads them
-- through withSessionContext() like every other route, i.e. as the
-- least-privilege agrolink_app role. Nobody had ever granted agrolink_app
-- SELECT on these three views specifically, so the admin portal's
-- "ภาพรวม" panel has been throwing "permission denied" through the API
-- since the route was added, even though a direct psql query (as the
-- table/view owner) always looked fine. Plain additive GRANT, safe to run
-- any number of times.

GRANT SELECT ON ops.v_integrity_checksum TO agrolink_app;
GRANT SELECT ON monitoring.v_go_live_readiness TO agrolink_app;
GRANT SELECT ON monitoring.v_active_alerts TO agrolink_app;
