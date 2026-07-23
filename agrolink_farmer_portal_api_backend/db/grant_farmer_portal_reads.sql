-- ============================================================================
-- AgroLink Platform — Backend API Gateway: Farmer Portal Read Grants
-- ============================================================================
-- Discovered while wiring up the real API against the live agrolink_test DB:
-- agrolink_app had USAGE on all the relevant schemas (reporting, risk,
-- underwriting, contract, notification, registry, identity) but no SELECT
-- grant on any of the specific tables/views the Farmer Portal slice reads —
-- these grants were never issued when those layers' schemas were built,
-- since agrolink_app (Layer 8) postdates most of them and nothing had
-- exercised these code paths as agrolink_app until now.
--
-- RLS (already enabled + FORCEd on risk.credit_score, underwriting.
-- loan_application, contract.contract) continues to do the actual row-level
-- narrowing per farmer — these grants only clear the *table/view-level* gate
-- that Postgres checks before RLS is even consulted.
-- ============================================================================

GRANT SELECT ON reporting.v_farmer_360            TO agrolink_app;
GRANT SELECT ON risk.v_farmer_latest_score        TO agrolink_app;
GRANT SELECT ON risk.credit_score                 TO agrolink_app;
GRANT SELECT, INSERT ON underwriting.loan_application TO agrolink_app;
GRANT SELECT ON contract.contract                 TO agrolink_app;
GRANT SELECT ON contract.contract_party           TO agrolink_app;
GRANT SELECT ON notification.v_unread_notifications TO agrolink_app;
GRANT SELECT ON registry.production_unit          TO agrolink_app;
GRANT SELECT ON identity.farmer                   TO agrolink_app;

-- underwriting.submit_application() is NOT SECURITY DEFINER (prosecdef=f) —
-- it runs with the CALLER's privileges, so agrolink_app needs direct grants
-- on everything the function body touches, not just on loan_application:
GRANT SELECT ON identity.organization             TO agrolink_app;
GRANT SELECT ON partner.vendor_profile            TO agrolink_app;
