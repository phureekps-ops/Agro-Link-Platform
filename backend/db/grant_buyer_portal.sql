-- ============================================================================
-- AgroLink Platform — Backend API Gateway: Buyer Portal Grants
-- ============================================================================
-- produce.delivery has NO row-level security at all (relrowsecurity=false),
-- unlike risk.credit_score / underwriting.loan_application / contract.contract.
-- That means, unlike those tables, agrolink_app has no RLS backstop here —
-- every /buyer/* route in src/routes/buyer.js MUST filter explicitly by
-- buyer_org_id itself; this is not defense-in-depth, it is the entire
-- security boundary (same situation as notification.notification_log,
-- documented in the backend README).
--
-- produce.record_delivery() and produce.confirm_quality() are NOT SECURITY
-- DEFINER (unlike settle_delivery(), see fix_produce_settlement_security.sql)
-- — they don't touch contract.contract, so there's no FORCE-RLS table in
-- their way, but they DO need direct grants since they run with the
-- caller's (agrolink_app's) own privileges.
-- ============================================================================

GRANT SELECT, INSERT, UPDATE ON produce.delivery TO agrolink_app;
GRANT SELECT ON registry.commodity_ref TO agrolink_app;

-- A subtler gap, found only by actually letting a settlement COMMIT
-- (not just testing inside a transaction that gets rolled back):
-- ledger.journal_line has a DEFERRABLE INITIALLY DEFERRED constraint
-- trigger (trg_check_entry_balanced) that validates debits = credits for
-- an entry. Deferred constraint triggers fire at COMMIT time, which is
-- OUTSIDE the dynamic scope of the SECURITY DEFINER function that did the
-- INSERT (produce.settle_delivery() -> ledger.transfer_funds()) — by the
-- time this trigger runs, the effective privileges have already reverted
-- to the original caller (agrolink_app), not the function owner
-- (postgres). SECURITY DEFINER only protects work done SYNCHRONOUSLY
-- within the function call; it does NOT cover deferred trigger checks
-- that fire later, at commit. Without this grant, every real (committed)
-- settlement failed with "permission denied for table journal_line" —
-- verified by reproducing it directly via psql without a wrapping
-- BEGIN/ROLLBACK (a ROLLBACK never lets a deferred trigger fire at all,
-- which is exactly why an earlier reproduction attempt wrongly appeared
-- to succeed).
GRANT SELECT ON ledger.journal_line TO agrolink_app;
