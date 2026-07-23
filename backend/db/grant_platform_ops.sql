-- ============================================================================
-- AgroLink Platform — Backend API Gateway: Platform Ops / Admin Portal Grants
-- ============================================================================
-- None of the tables the admin portal writes to have row-level security
-- enabled (verified: relrowsecurity = false on identity.farmer,
-- identity.organization, partner.vendor_profile, ledger.account,
-- notification.notification_log), so — unlike every other portal built so
-- far — no SECURITY DEFINER fix was needed here. Only plain grants.
--
-- - identity.farmer / identity.organization: agrolink_app already had
--   SELECT (and INSERT on farmer, for registration); the admin portal is
--   the first thing to ever UPDATE farmer.status or organization.kyb_status
--   as agrolink_app, so UPDATE is newly required on both.
-- - partner.vendor_profile: already had SELECT (from grant_farmer_portal_reads.sql,
--   used by submit_application()'s own checks); approving KYB now also calls
--   partner.activate_vendor(), which UPDATEs this table, so UPDATE is added.
-- - ledger.account: activate_vendor() reads AND (idempotently) creates the
--   org's settlement/clearing account — first thing to ever need SELECT or
--   INSERT on this table as agrolink_app.
-- - notification.notification_log: every KYC/KYB decision notifies the
--   affected farmer/organization via notification.notify() — first thing
--   to ever need INSERT here as agrolink_app (GET /farmer/notifications
--   only ever needed SELECT on the read-only view built over this table).
--
--   GOTCHA FOUND DURING TESTING: INSERT alone was NOT enough, even though
--   every ACL check (information_schema.role_table_grants,
--   has_table_privilege(), \dp, aclexplode(relacl)) showed the INSERT grant
--   present and correct. The real cause: notification.notify()'s INSERT ends
--   with `RETURNING notification_id`, and PostgreSQL requires SELECT
--   privilege (on the returned columns, in addition to INSERT on the table)
--   to use RETURNING at all — it is documented behavior, not a bug, but easy
--   to miss because the error ("permission denied for table
--   notification_log") looks identical to a missing-INSERT error and gives
--   no hint that RETURNING is the actual culprit. Confirmed by testing the
--   same INSERT with and without a RETURNING clause as agrolink_app: the
--   bare INSERT succeeded, the INSERT ... RETURNING failed, every time.
--   So this needs SELECT granted too, not just INSERT.
-- ============================================================================

GRANT UPDATE ON identity.farmer TO agrolink_app;
GRANT UPDATE ON identity.organization TO agrolink_app;
GRANT UPDATE ON partner.vendor_profile TO agrolink_app;
GRANT SELECT, INSERT ON ledger.account TO agrolink_app;
GRANT SELECT, INSERT ON notification.notification_log TO agrolink_app;
