# AgroLink Platform — Backend API Gateway (Farmer + Lender + Buyer + Platform Ops Portals)

A real, running Node.js/Express API that sits in front of the `agrolink_test`
PostgreSQL database and implements the Farmer-Portal-, Lender-Portal-,
Buyer-Portal-, and Platform-Ops-facing slices of the G-1..G-19 contracts
designed across Layers 1–10. This was the first piece of actual application
code in the project — everything before it was schema, API contracts, and
documentation.

Scope decision (confirmed with the user): homepage audience = **farmers**;
first component built = **Backend API Gateway** (rather than the frontend
itself), so the API contract is solid before any UI is built against it.
The Farmer Portal slice shipped first end-to-end (auth, dashboard, credit
score, loan applications, contracts, notifications, registration); the
Lender Portal slice (`src/routes/lender.js`) was added next, closing the
loop on loan applications that need a lender's decision rather than sitting
unevaluated forever; the Buyer Portal slice (`src/routes/buyer.js`) was
added after that, closing the produce-delivery loop the same way — record
delivery → confirm quality → settle payment → auto-close the contract once
the agreed quantity is fully delivered. The Platform Ops / Admin slice
(`src/routes/admin.js`) was added next, closing the KYC/KYB *approval*
loop: it's the only thing in the whole system that ever moves a farmer out
of `pending_kyc` or an organization out of `Pending` KYB — before this
slice existed, both statuses could only ever be set directly in the seed
data. `POST /auth/org-register` was added after that, closing the
matching *submission* loop: before it existed, every organization
(including the ones Platform Ops approves) could only ever be inserted
directly into the database — there was no way for a new business to apply
to join AgroLink at all.

## Architecture in one paragraph

Every request that touches business data goes through `withSessionContext()`
(`src/db/pool.js`): it borrows a connection from the pool, `SET ROLE
agrolink_app` (the least-privilege, RLS-governed role from Layer 8),
calls `security.set_session_context()` to tell Postgres who is asking, runs
the query, then always `RESET ROLE`s and releases the connection in a
`finally` block. This matters specifically because `pg.Pool` reuses TCP
connections across unrelated requests — without the reset, one farmer's
identity could leak onto the connection the next request happens to borrow.
`agrolink_app` itself is `NOLOGIN` by design (Layer 8); the API authenticates
to Postgres as a separate service account, `agrolink_backend`, which is only
granted membership in `agrolink_app` and nothing else.

## Configuration

Copy `.env` (already present, dev-only values) and adjust as needed:

| Variable | Meaning |
|---|---|
| `PORT` | HTTP port the API listens on (default 4000; Render sets this automatically) |
| `DATABASE_URL` | Single-string Postgres connection (`postgresql://user:pass@host:port/db`), as handed out by Render and most managed Postgres hosts. When set, this takes priority over the `PG*` vars below and the pool connects over TLS. See `src/db/pool.js`. |
| `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD` | Discrete connection to Postgres, using the `agrolink_backend` service account. Used only when `DATABASE_URL` is not set — this is the local dev path. |
| `PGSSLMODE` | Set to `disable` to force a non-TLS connection even when `DATABASE_URL` is set (rarely needed). |
| `JWT_SECRET` | HS256 signing key for session tokens — **rotate and load from a real secret manager in production, not `.env`** |
| `JWT_EXPIRES_IN` | Session token lifetime (default `8h`) |
| `ADMIN_PASSCODE` | Shared passcode for `POST /auth/admin-login` — generate a fresh one in production, never reuse the dev value |

To deploy this to Render.com instead of running it locally, see `DEPLOY.md`
at the repo root — it covers the same setup below plus the Render-specific
steps (creating the database, setting these env vars, etc.).

## One-time database setup

Run these against the target database, **in this exact order**, before
starting the API for the first time. This full set (including the first
four bootstrap files) was reconstructed from the live sandbox database
while preparing the Render migration — see `db/00_roles.sql` and
`db/03_grant_schema_usage.sql` for why they exist and why they're new.

```
psql -d agrolink_test -f db/00_roles.sql
psql -d agrolink_test -f db/01_extensions.sql
psql -d agrolink_test -f db/02_full_schema.sql
psql -d agrolink_test -f db/03_grant_schema_usage.sql
psql -d agrolink_test -f db/setup_backend_role.sql
psql -d agrolink_test -f db/grant_farmer_portal_reads.sql
psql -d agrolink_test -f db/fix_submit_application_security.sql
psql -d agrolink_test -f db/grant_farmer_registration.sql
psql -d agrolink_test -f db/fix_underwriting_decision_security.sql
psql -d agrolink_test -f db/fix_produce_settlement_security.sql
psql -d agrolink_test -f db/grant_buyer_portal.sql
psql -d agrolink_test -f db/grant_platform_ops.sql
psql -d agrolink_test -f db/grant_provider_registration.sql
psql -d agrolink_test -f db/grant_machinery_marketplace.sql
psql -d agrolink_test -f db/grant_organization_roles.sql
psql -d agrolink_test -f db/grant_input_supplier_and_buy_prices.sql
psql -d agrolink_test -f db/grant_farmer_product_orders.sql
psql -d agrolink_test -f db/grant_market_venue_marketplace.sql
psql -d agrolink_test -f db/04_reference_data.sql
psql -d agrolink_test -f db/grant_about_content.sql
psql -d agrolink_test -f db/grant_admin_dashboard_views.sql
psql -d agrolink_test -f db/grant_machinery_booking.sql
psql -d agrolink_test -f db/grant_featured_listings.sql
psql -d agrolink_test -f db/grant_credit_model.sql
psql -d agrolink_test -f db/grant_fertilizer_formula.sql
psql -d agrolink_test -f db/grant_stage_calendar_farmer.sql
psql -d agrolink_test -f db/grant_fertilizer_mixing_service.sql
psql -d agrolink_test -f db/grant_fertilizer_mixing_group_order.sql
psql -d agrolink_test -f db/grant_carbon_awd.sql
psql -d agrolink_test -f db/grant_cooperative_tenant_foundation.sql
psql -d agrolink_test -f db/grant_cooperative_collection_station.sql
psql -d agrolink_test -f db/grant_cooperative_warehouse.sql
psql -d agrolink_test -f db/grant_cooperative_finance_dashboard.sql
psql -d agrolink_test -f db/grant_cooperative_processing.sql
psql -d agrolink_test -f db/grant_cooperative_logistics.sql
psql -d agrolink_test -f db/grant_cooperative_gov_gateway.sql
psql -d agrolink_test -f db/grant_staff_and_government_access.sql
psql -d agrolink_test -f db/grant_object_storage.sql
psql -d agrolink_test -f db/grant_analytics_warehouse.sql
psql -d agrolink_test -f db/grant_satellite_observation.sql
psql -d agrolink_test -f db/grant_cooperative_product_catalog.sql
psql -d agrolink_test -f db/grant_rfq_marketplace.sql
psql -d agrolink_test -f db/grant_b2b_commerce_engine.sql
psql -d agrolink_test -f db/grant_b2b_commerce_engine_phase3.sql
psql -d agrolink_test -f db/grant_farmer_360.sql
psql -d agrolink_test -f db/grant_machinery_service_consolidation.sql
psql -d agrolink_test -f db/grant_ledger_revenue_segregation.sql
psql -d agrolink_test -f db/grant_sealed_bid_auction.sql
```

(This continues the same file-by-file order as `DEPLOY.md`'s ordered list at
the repo root, with `setup_backend_role.sql` inserted after
`03_grant_schema_usage.sql` — see that file's own "checked against a real
run" note.)

**2026-08-04 correction:** this list had silently fallen nine migrations
behind actual `db/` contents — everything from `grant_about_content.sql`
through `grant_fertilizer_mixing_service.sql` above existed on disk and was
already relied on by shipped features (the "เกี่ยวกับเรา" page, the admin
dashboard's summary views, machinery booking, featured listings, the
credit-scoring model, the fertilizer-formula calculator, the crop-cycle
stage calendar, and Fulfillment Marketplace เส้นทาง A) but was never added
to this run list, meaning a from-scratch deploy following only the steps
above would have booted an API with those routes returning 500s on their
first query (missing tables/columns), not 404s — silent at the routing
layer, loud only once a request actually reached the database. Order
above was reconstructed from each file's own filesystem modification time,
cross-checked against internal doc-comment references between files (e.g.
`grant_fertilizer_mixing_service.sql` explicitly names
`grant_machinery_booking.sql`/`grant_market_venue_marketplace.sql` as
"the same design decision," confirming it belongs after both). Re-verified
in this pass by actually running the full 28-file chain against a clean
local Postgres 16 database with `ON_ERROR_STOP=1` end-to-end — it applies
cleanly in the order listed above.

- `00_roles.sql` / `01_extensions.sql` / `02_full_schema.sql` /
  `03_grant_schema_usage.sql` / `04_reference_data.sql` — added while
  preparing the Render migration, after discovering the repo had no
  reproducible base schema at all: everything below this point (the
  `grant_*.sql`/`fix_*.sql` scripts) is an *incremental* migration written
  against schema/role state that, until now, had only ever existed live in
  this sandbox. These four files are a `pg_dump`-based export of that
  state (roles, extensions, every table/function/policy, and the static
  reference/config data the app needs) so a brand-new database — like a
  fresh Render Postgres instance — can be brought up from nothing. Verified
  by restoring into a completely empty local database and re-running the
  full curl/API smoke test against it. **`03_grant_schema_usage.sql`
  specifically fixes a real, previously-invisible gap**: every
  `grant_*.sql`/`fix_*.sql` script below grants table-level privileges, but
  none of them (nor anything else in the repo) ever granted `agrolink_app`
  schema-level `USAGE` — that had only ever been set by hand, once, outside
  of any file. A fresh restore without this script fails on the very first
  real request with `permission denied for schema identity`.
- `db/dev_sample_data.sql` (optional, **local dev only** — do not run this
  against Render/production) — the sandbox's fake farmers, organizations,
  contracts, loans, and orders generated while building and testing this
  project, split out from the reference data above so a local dev database
  can optionally be seeded with realistic-looking sample data. Wraps the
  three `FORCE ROW LEVEL SECURITY` tables (`contract.contract`,
  `risk.credit_score`, `underwriting.loan_application`) in a temporary
  `NO FORCE`/`FORCE` toggle so it also restores cleanly under a
  non-superuser role.

- `grant_market_venue_marketplace.sql` — adds the Selling-Space Matching
  Portal (ระบบจับคู่พื้นที่จำหน่ายสินค้า): a new self-registerable
  `MarketVenue` org_type/role (wholesale markets, fresh markets, market-day
  organizers), `marketplace.venue_listing` (a venue owner's posted selling
  space), and `marketplace.venue_booking` (a farmer's request to use one).
  Payment is offline/on-site between the farmer and the venue owner — this
  only records the booking request itself, per an explicit product scope
  decision. See `src/routes/marketvenue.js` (venue owner side) and the
  `venue-*` endpoints added to `src/routes/farmer.js` (farmer side).
- `setup_backend_role.sql` creates the `agrolink_backend` LOGIN role, grants
  it membership in `agrolink_app`, and grants it direct `EXECUTE` on
  `security.resolve_subject_from_external_claim()` (needed pre-login, before
  any session context exists).
- `grant_farmer_portal_reads.sql` — **a real gap this build surfaced**:
  `agrolink_app` had schema-level `USAGE` on `reporting`/`risk`/
  `underwriting`/`contract`/`notification`/`registry`/`identity` from
  earlier layers, but no object-level `SELECT` on the specific
  tables/views the Farmer Portal reads. Nothing had exercised those code
  paths as `agrolink_app` until this endpoint slice was tested end-to-end.
  This script adds the missing grants.
- `fix_submit_application_security.sql` — a second real gap:
  `underwriting.submit_application()` was defined as an ordinary
  (caller-rights) function, but `underwriting.loan_application` has
  `FORCE ROW LEVEL SECURITY` with **only `SELECT` policies** — no `INSERT`
  policy exists, so any INSERT from a non-owner role is denied outright,
  regardless of grants. The function already does its own authorization
  (verifies the production unit belongs to the requesting farmer; verifies
  the lender org is an active `Lender`) before inserting, matching the
  shape of the Layer 10 `SECURITY DEFINER` functions
  (`evaluate_metric`, `acknowledge_alert`, `purge_expired_rows`). Marking it
  `SECURITY DEFINER` brings it in line with that established pattern instead
  of bolting on a bespoke `INSERT` policy that would duplicate checks the
  function already performs.
- `grant_farmer_registration.sql` — a third real gap, found while building
  `POST /auth/register`: `agrolink_app` had `SELECT` on `identity.farmer` but
  never `INSERT`; and separately, `security.set_session_context()` turned
  out to raise `"ยังไม่ได้รับสิทธิ์ (Role) ใดๆ"` for any subject with no row in
  `identity.subject_role` — every previously-seeded farmer already had one,
  but a freshly-registered farmer does not until the registration code
  inserts it. This script grants the missing `INSERT` on both
  `identity.farmer` and `identity.subject_role`.
- `fix_underwriting_decision_security.sql` — a fourth real gap, found while
  building the Lender Portal: `underwriting.evaluate_application()`,
  `approve_application()`, and `decline_application()` were all ordinary
  (caller-rights) functions, same problem as `submit_application()` before
  it was fixed — they `UPDATE underwriting.loan_application` (and
  `approve_application()` also `INSERT`s into `contract.contract`), both
  `FORCE ROW LEVEL SECURITY` with only `SELECT` policies defined, so the
  write is denied outright regardless of grants. Marked all three
  `SECURITY DEFINER`, same fix as before. Unlike `submit_application()`,
  none of these three check *who* is calling relative to the application's
  `lender_org_id` — that authorization gap is closed at the API layer
  instead (see `src/routes/lender.js`), not in the database.
- `fix_produce_settlement_security.sql` — a fifth real gap, found while
  building the Buyer Portal, and the subtlest one yet:
  `produce.settle_delivery()` ends by `UPDATE`ing `contract.contract` to
  `completed` once a contract's full agreed quantity has been delivered —
  same `FORCE ROW LEVEL SECURITY`-with-no-`UPDATE`-policy problem as
  `approve_application()`. Marked `SECURITY DEFINER`, same fix. But this
  one had a second, sneakier layer: `ledger.transfer_funds()` (which
  `settle_delivery()` calls to actually move money) inserts into
  `ledger.journal_line`, which has a **`DEFERRABLE INITIALLY DEFERRED`**
  constraint trigger validating that debits equal credits. Deferred
  triggers fire at **COMMIT** time — which is *outside* the dynamic scope
  of the `SECURITY DEFINER` call that did the insert, so by the time the
  trigger actually runs, the effective privileges have already reverted to
  the original caller (`agrolink_app`), not the function owner. Every real
  (committed) settlement failed with `permission denied for table
  journal_line` until `grant_buyer_portal.sql` granted `agrolink_app`
  direct `SELECT` on `ledger.journal_line`. This one is worth flagging for
  anyone extending this pattern elsewhere: **`SECURITY DEFINER` does not
  protect deferred constraint trigger checks** — testing inside a
  transaction that gets rolled back can hide this entirely, since a
  rollback never lets a deferred trigger fire at all; only an actual
  commit (a real end-to-end test) surfaces it.
- `grant_buyer_portal.sql` — grants `SELECT`/`INSERT`/`UPDATE` on
  `produce.delivery` (which has **no row-level security at all** —
  see the "what's mocked" section below), `SELECT` on
  `registry.commodity_ref`, and the `ledger.journal_line` grant described
  just above.
- `grant_platform_ops.sql` — a sixth real gap, found while building the
  Platform Ops / Admin slice. None of the tables this slice writes to have
  row-level security at all (verified `relrowsecurity = false` on
  `identity.farmer`, `identity.organization`, `partner.vendor_profile`,
  `ledger.account`, `notification.notification_log`), so — unlike every
  other portal — no `SECURITY DEFINER` fix was needed; only plain grants
  (`UPDATE` on `identity.farmer`/`identity.organization` for KYC/KYB
  decisions, `UPDATE` on `partner.vendor_profile` and `SELECT`/`INSERT` on
  `ledger.account` for `partner.activate_vendor()`, and `SELECT`/`INSERT`
  on `notification.notification_log` for `notification.notify()`).
  **The genuinely subtle part**: `INSERT` alone on
  `notification.notification_log` was *not* enough, even though every ACL
  check (`information_schema.role_table_grants`,
  `has_table_privilege()`, `\dp`, `aclexplode(relacl)`) showed the grant
  present and correct — `notification.notify()`'s INSERT ends with
  `RETURNING notification_id`, and PostgreSQL requires **`SELECT`
  privilege in addition to `INSERT`** to use `RETURNING` at all. This is
  documented Postgres behavior, not a bug, but the error
  (`permission denied for table notification_log`) is indistinguishable
  from a plain missing-`INSERT` error and gives no hint that `RETURNING`
  is the actual culprit. Confirmed by testing the identical `INSERT` as
  `agrolink_app` with and without a `RETURNING` clause: the bare `INSERT`
  succeeded every time, the `INSERT ... RETURNING` failed every time, until
  `SELECT` was also granted. Worth remembering alongside the deferred-
  trigger gotcha above as a second "the ACL check said yes, Postgres still
  said no" lesson — this time for a completely different reason.
- `grant_provider_registration.sql` — for `POST /auth/org-register` (the
  service-provider self-registration endpoint). Two parts: (1) widens
  `identity.organization.org_type`'s `CHECK` constraint to add four new
  business categories the user asked for directly — `TractorService`,
  `DroneService`, `HarvesterService`, `TruckService` (farm-machinery/
  mechanization rental services that don't fit any prior org_type) — a
  purely additive change, nothing existing is affected; (2) grants
  `agrolink_app` `INSERT` on `identity.organization` and
  `partner.vendor_profile`, the first thing to ever create either as
  `agrolink_app` rather than through direct seeding.

## Running

```
npm install
npm start          # or: node src/server.js
```

`GET /health` should return `{"status":"ok", ...}` once it's up.

## Endpoints implemented

**Auth** (`src/routes/auth.js`)
- `POST /auth/login` — body `{ "external_subject_claim": "oidc|farmer-001" }` → resolves the claim via `security.resolve_subject_from_external_claim()` and returns a signed JWT.
- `POST /auth/register` — body `{ "full_name", "phone", "national_id", "region_code" }` → creates a new `identity.farmer` row (status `pending_kyc`), grants it the `farmer.self` role in `identity.subject_role`, mints a fresh mock OIDC claim (`oidc|farmer-<uuid>`), and auto-issues a session JWT so the new farmer lands straight in the portal. `national_id` is SHA-256 hashed before it ever reaches the database — only the hash is stored. Duplicate phone/national ID return `409` with `phone_already_registered` / `national_id_already_registered`.
- `GET /auth/session/current` — requires `Authorization: Bearer <token>`; echoes back the resolved identity and display name.
- `POST /auth/org-register` — body `{ "org_name", "tax_id", "org_type" }` → the service-provider equivalent of `POST /auth/register`. `org_type` must be one of `InputSupplier`/`Lender`/`Logistics`/`Buyer`/`VillageFund`/`MachineryService`/`DryingYardService` (see `ORG_SELF_REGISTER_TYPES` in `src/routes/auth.js` — `Bank` remains deliberately excluded, see "what's mocked" below, and `Cooperative`/`Mill` were removed from this list on 2026-07-24 per an explicit product decision — both values still exist in `identity.organization`'s underlying `org_type` domain, they just aren't self-registerable through this endpoint anymore. `VillageFund` was ADDED to this list on 2026-08-17 for the Farmer 360° View feature — see "Farmer 360° View" below and `FARMER_360_ARCHITECTURE.md` §6 — because no admin-side org-creation endpoint exists anywhere in this codebase, so self-registration behind the same KYB gate as every other type here was the lowest-cost onboarding path. `TractorService`/`DroneService`/`HarvesterService`/`TruckService` were CONSOLIDATED into `MachineryService` on 2026-08-17 — see `MULTI_ROLE_ORGANIZATION_ARCHITECTURE.md` §5.1 and the "Machinery/Drying-Yard Portal" section below for why; the four individual values stay valid in `identity.organization`'s `org_type` domain for any org that registered before the consolidation, they're just not offered here anymore). Creates a new `identity.organization` row at `kyb_status = 'Pending'`, grants it the `org.admin` role, creates a matching `partner.vendor_profile` row (using `tax_id` as `business_registration_no` — a real simplification, see below), mints a fresh mock OIDC claim (`oidc|org-<uuid>`), and auto-issues a session JWT. Also inserts this `org_type` as the org's **primary role** into `identity.organization_role` at `status = 'Pending'` — see "Multi-role organizations" below. Duplicate `tax_id` returns `409 tax_id_already_registered`.

Note: `POST /auth/login` is shared by the Farmer Portal, Lender Portal, AND
Buyer Portal — `security.resolve_subject_from_external_claim()` already
resolves a claim to either a `farmer` or an `organization` row (regardless
of `org_type`), so no separate lender- or buyer-login endpoint was needed.

- `POST /auth/admin-login` — body `{ "passcode": "..." }` → the Platform Ops
  login, and the one login path that does **not** go through
  `security.resolve_subject_from_external_claim()`. There is no per-admin
  identity table in this sandbox — no individual ops accounts, no MFA, no
  real SSO — so a single shared passcode (`ADMIN_PASSCODE` in `.env`) stands
  in for "is this an authorized platform operator at all". Every successful
  login is issued the same `subjectType: 'platform'` JWT with **no
  `subjectId`** — `security.set_session_context()` already treats
  `subject_type = 'platform'` as the one case needing neither a `subject_id`
  nor an `identity.subject_role` row (designed into Layer 8 for exactly
  this, but never exercised by any API path until now). Practical
  consequence: `audit.access_log` can prove *a* platform operator did
  something, but not *which one* — a real deployment needs real per-admin
  accounts specifically so that attribution exists.

**Farmer Portal** (`src/routes/farmer.js`, all require a farmer-subject JWT)
- `GET /farmer/dashboard` → `reporting.v_farmer_360`
- `GET /farmer/credit-score` → `risk.v_farmer_latest_score` + full history from `risk.credit_score`
- `GET /farmer/loan-applications` / `POST /farmer/loan-applications` → `underwriting.loan_application`, submission via `underwriting.submit_application()`, immediately followed in the same request by `underwriting.evaluate_application()` (see below) so the farmer gets an instant decision instead of an application that sits at `pending` forever.
- `GET /farmer/contracts` → `contract.contract` joined through `contract.contract_party`
- `GET /farmer/notifications` → `notification.v_unread_notifications`
- `GET /farmer/production-units` → `registry.production_unit` (PostGIS boundary returned as GeoJSON via `ST_AsGeoJSON`)
- `GET /farmer/memberships` → the farmer's OWN active rows from `identity.farmer_org_relationship`, joined with `identity.organization` for `org_name`/`org_type` — added 2026-08-17 as the farmer-facing counterpart to the Farmer 360° View (see below): "which organizations am I currently a member/customer of." Deliberately a plain read-only list (name, type, joined date) with no transaction detail and no per-org access controls — the natural extension point for the Phase 2 consent screen, not built this pass.
- `GET /farmer/lenders` → active `Lender` organizations from `identity.organization` — added while building the frontend, so the loan-application form's lender dropdown reads real data instead of a hardcoded value.
- `GET /farmer/rice-prices` → for every row in `registry.rice_grade_ref`, every Buyer org's current ACTIVE `marketplace.buy_price_quote` (org name, price, price unit, last-updated), sorted `quoted_price DESC` within each grade so the highest payer for a given rice type is always first. Grades nobody has quoted yet still appear, with an empty `quotes: []` array, so the page can render a "no buyer has posted a price for this yet" state rather than silently omitting the grade. This is the farmer-facing half of the daily rice-buying-price announcement feature — see "Daily rice-buying-price announcements" below.
- `GET /farmer/input-suppliers` → every Verified `InputSupplier` organization, with how many active products it currently has listed — a small supporting directory endpoint, same shape as `GET /farmer/lenders`, so the frontend never has to hardcode an `org_id`.
- `GET /farmer/products?category=&org_id=` → browse the ACTIVE catalog (`is_active = true` only) across every Verified InputSupplier, or one via `org_id`, joined with the supplier's `org_name`. See "Farmer ordering flow" below.
- `POST /farmer/orders` — body `{ listing_id, quantity }` → places a new `marketplace.product_order` at `status = 'requested'`, snapshotting the listing's current `product_name`/`category`/`unit_price`/`price_unit` onto the order and computing `total_price = quantity * unit_price` server-side. `farmer_id` always comes from the JWT, never the request body. `404 product_not_found` if the listing doesn't exist or isn't currently active.
- `GET /farmer/orders?status=` — this farmer's own order history across every supplier, joined with the supplier's `org_name`.
- `POST /farmer/orders/:id/cancel` — a farmer can cancel their OWN order, only while it's still `requested` (`409 order_not_cancellable` with the current status otherwise — once a supplier has `confirmed` it, they're already committed, so cancellation past that point needs to go through the supplier's own `reject`, not this endpoint). Ownership-gated the same way as every other subject-scoped write in this project.

**Lender Portal** (`src/routes/lender.js`, all require an organization-subject JWT that passes the two-layer check in `requireLenderOrg`: (1) `identity.organization.kyb_status = 'Verified'` — the entity-level check that existed before multi-role support, `403 kyb_not_verified` otherwise — AND (2) an `identity.organization_role` row for this org with `role_type = 'Lender'` AND `status = 'Verified'` — the newer per-role check, `403 role_not_verified` (with `role_type`/`role_status`/`org_name`) otherwise. See "Multi-role organizations" below for why these are two separate checks.)
- `GET /lender/dashboard` — org info, application counts by status, active-contract count and outstanding principal.
- `GET /lender/loan-applications?status=...` — applications submitted to this lender, joined with the farmer's name and latest credit score. `status` accepts any real status value, or the shorthand `action_needed` (`manual_review` + `approved` — both still require the lender to act; `approved` is only an automated pre-approval until a contract actually exists).
- `GET /lender/loan-applications/:id` — single application detail, plus the related production unit.
- `POST /lender/loan-applications/:id/approve` — body `{ final_amount? }` → `underwriting.approve_application()`, converting the application into a real `contract.contract` row (status `converted`).
- `POST /lender/loan-applications/:id/decline` — body `{ reason? }` → `underwriting.decline_application()`.
- `GET /lender/contracts` — this org's loan-agreement portfolio (contracts where it is the `lender` party).

**Buyer Portal** (`src/routes/buyer.js`, all require an organization-subject JWT that passes the same two-layer `requireBuyerOrg` check — entity `kyb_status = 'Verified'` (`403 kyb_not_verified`) AND an `organization_role` row with `role_type = 'Buyer'`, `status = 'Verified'` (`403 role_not_verified`) — same shape and reasoning as `requireLenderOrg` above)
- `GET /buyer/dashboard` — org info, delivery counts by status, lifetime settled amount, active-contract count.
- `GET /buyer/deliveries?status=...` — this buyer's own deliveries, joined with the farmer's name and production unit. `status` accepts any real status value, or the shorthand `action_needed` (`delivered` + `accepted` — `delivered` still needs quality confirmation, `accepted` still needs settlement).
- `GET /buyer/deliveries/:id` — single delivery detail.
- `POST /buyer/deliveries` — body `{ unit_id, commodity_code, quantity_ton, contract_id?, cycle_id?, unit_price? }` → `produce.record_delivery()`. If `contract_id` is given, the function itself validates the contract is `active`, has an agreed price, and that this buyer is really its buyer party. With no `contract_id` ("Spot Sale"), `unit_price` is required directly instead.
- `POST /buyer/deliveries/:id/confirm-quality` — body `{ quality_grade, accepted, inspected_by }` → `produce.confirm_quality()`, moving the delivery to `accepted` or `rejected`.
- `POST /buyer/deliveries/:id/settle` — body `{}` → `produce.settle_delivery()`: moves the delivery to `settled`, makes a real `ledger.transfer_funds()` payment from the buyer's settlement account to the production unit's wallet, and auto-closes the contract (`status = 'completed'`) once its full agreed quantity has been settled. Fails with a real, descriptive `409` (not a generic 500) if the buyer's settlement account has insufficient balance, or isn't activated yet.
- `GET /buyer/contracts` — this org's forward-purchase portfolio (contracts where it is the `buyer` party).
- `GET /buyer/production-units` — small read-only directory of active production units with their owning farmer's name, so the delivery form doesn't require knowing a `unit_id` by heart. Mirrors the intent of `GET /farmer/lenders`.
- `GET /buyer/commodities` — `registry.commodity_ref`, for the delivery form's commodity dropdown.
- `GET /buyer/price-quotes` — this buyer's daily rice-buying-price announcement: LEFT JOINs `registry.rice_grade_ref` (all 7 fixed grades) against this org's own `marketplace.buy_price_quote` rows, so every grade always appears even if never priced (`quoted_price: null`).
- `PUT /buyer/price-quotes` — body `{ quotes: { grade_code: price|null, ... } }` → upserts a `marketplace.buy_price_quote` row per grade present (`ON CONFLICT (org_id, grade_code) DO UPDATE` — a genuine non-partial composite-PK upsert target, deliberately chosen over a partial unique index so no `WHERE` predicate is ever needed on the conflict clause; see "Daily rice-buying-price announcements" below for why that matters). Each `grade_code` is validated against `registry.rice_grade_ref` (`400 invalid_grade_code` otherwise). A price of `null`/`0`/empty deactivates that grade's quote (`is_active = false`) rather than deleting the row, mirroring the machinery rate card's deactivate-not-delete convention. Farmers see the result immediately via `GET /farmer/rice-prices`.

**Machinery/Drying-Yard Portal** (`src/routes/machinery.js`, all require an organization-subject JWT that passes `requireMachineryOrg`: entity `kyb_status = 'Verified'` (`403 kyb_not_verified`) first, then — unlike the single-role-type check in `requireLenderOrg`/`requireBuyerOrg` — an `organization_role` row with `status = 'Verified'` for **any one of** `MachineryService`/`TractorService`/`DroneService`/`HarvesterService`/`TruckService`/`DryingYardService` (`403 role_not_verified`, `role_type: 'machinery'` generically, otherwise). One unified portal covers all these role types rather than one portal per type, since a single real-world provider commonly offers more than one of these services (e.g. a tractor operator who also runs a truck) — see `MACHINERY_ORG_TYPES` in `src/routes/machinery.js`. An org that holds e.g. `TractorService` Verified but a separately-requested `DroneService` still Pending gets in — the rate card itself has no per-role field gating.
  - **2026-08-17 consolidation:** `TractorService`/`DroneService`/`HarvesterService`/`TruckService` were four separate `role_type`s that all unlocked this exact same portal with the exact same full access (per the "no per-role field gating" point above) — four approvals bought no real access-control distinction. `MULTI_ROLE_ORGANIZATION_ARCHITECTURE.md` §5.1 replaced them with a single `MachineryService` role_type for new requests (`grant_machinery_service_consolidation.sql`, additive — the four old values stay valid in the DB domain, unmigrated, so any org that already holds one keeps working exactly as before; `MACHINERY_ORG_TYPES` here checks for either the new or the legacy values). `DryingYardService` was deliberately left out of the consolidation (kept as its own role_type). No `machinery_type` column was added anywhere — `marketplace.service_listing.service_key`/`service_type` already identify which specific service (ไถดะ/ไถแปร/ปั่นดิน/ฉีดพ่น/เกี่ยวข้าว/รถบรรทุก/ลานตาก/อัดเม็ดฟาง/อัดก้อนฟาง) a listing/booking is for, fully independent of which role the org holds, since before this change even a single-role org's rate card could already cover all nine items (originally seven — see `grant_straw_processing_service.sql` for the two straw-byproduct items added after this consolidation note was written).
- `GET /machinery/dashboard` — org info (`service_types`: every machinery role this org actually holds at `Verified` — e.g. `["TractorService", "TruckService"]` — deliberately NOT `identity.organization.org_type`, the entity's primary role from registration, which can be a completely different, non-machinery type for a multi-role org; see "Multi-role organizations" below for the bug this would otherwise cause), how many of the nine fixed rate-card items are currently priced (out of 9), and a photo count.
- `GET /machinery/rate-card` — this org's current prices for all nine fixed line items (`plow_rough`/`plow_secondary_seed`/`rotary_till`/`spraying`/`harvesting`/`trucking`/`drying`/`straw_pelletizing`/`straw_baling` — see `RATE_CARD_ITEMS`), keyed by `service_key`, pre-filled with `unit_price: null` for anything never priced.
- `PUT /machinery/rate-card` — body `{ "prices": { "plow_rough"?: number|null, ... } }` → upserts a `marketplace.service_listing` row per key present with a positive value (`ON CONFLICT (org_id, service_key)`); a key set to `null`/`0` deactivates (`is_active = false`) rather than deletes the row, since deleting could violate `marketplace.service_request`'s FK to `listing_id` if a farmer has already booked against it. A provider is never required to price all nine — most will only fill in what matches their actual equipment (a `DroneService` org typically only sets `spraying`).
- `GET /machinery/photos` / `POST /machinery/photos` / `DELETE /machinery/photos/:id` — the provider's photo gallery (`photo_type: 'service'|'machinery'`). `POST` expects `photo_data_url` as a `data:image/...` URL read client-side via `FileReader` — see "what's mocked" below, there is no object storage/CDN in this sandbox. Capped at ~3MB per photo (`MAX_PHOTO_DATA_URL_LENGTH`) and `express.json()`'s body limit was raised from the default 100kb to 5mb (`src/server.js`) specifically to let this route through.

**InputSupplier Portal** (`src/routes/inputsupplier.js`, all require an organization-subject JWT that passes `requireInputSupplierOrg`: entity `kyb_status = 'Verified'` (`403 kyb_not_verified`) AND an `organization_role` row with `role_type = 'InputSupplier'`, `status = 'Verified'` (`403 role_not_verified`) — same two-layer shape as `requireLenderOrg`/`requireBuyerOrg`.) See "Product catalog vs. rate card" below for why this portal's data shape deliberately differs from the Machinery Portal's fixed-key rate card.
- `GET /inputsupplier/dashboard` — org info, `total_active_products`, a `products_by_category` breakdown across the four fixed categories, and a photo count.
- `GET /inputsupplier/products?category=` — this org's full catalog (every status, not just active), optionally filtered to one of the four `PRODUCT_CATEGORIES` (`fertilizer_hormone`/`chemical_pesticide`/`equipment`/`other`).
- `POST /inputsupplier/products` — body `{ category, product_name, brand?, description?, unit_price, price_unit? }` → inserts a brand-new `marketplace.product_listing` row. Unlike the machinery rate card's fixed seven keys, this is a genuinely open-ended list — a supplier can list as many or as few products as they actually sell, in any category, and list the same category more than once (e.g. two different fertilizer brands).
- `PUT /inputsupplier/products/:id` — body is a partial update (any subset of the `POST` fields) applied via `COALESCE`; ownership-gated by an explicit `SELECT ... WHERE org_id = $1 AND listing_id = $2` before the update, `404` if the listing doesn't belong to this org (or doesn't exist).
- `DELETE /inputsupplier/products/:id` — **deactivates, not a real delete** (`is_active = false`). This used to be a genuine hard delete when nothing else referenced `product_listing`; now that `marketplace.product_order` can reference a `listing_id` (see "Farmer ordering flow" below), it switched to the same deactivate-only pattern `PUT /machinery/rate-card` already uses, for the same reason — an order placed against a listing must not be orphaned by the listing disappearing out from under it. The endpoint's shape (`DELETE`, `204` on success) is unchanged; only what happens underneath changed.
- `GET /inputsupplier/products/:id/photos` / `POST /inputsupplier/products/:id/photos` / `DELETE /inputsupplier/products/:id/photos/:photoId` — same `data:image/...` upload pattern as the Machinery Portal's photo gallery, scoped per-product instead of per-org. Capped at 4MB per photo (`MAX_PHOTO_DATA_URL_LENGTH`).
- `GET /inputsupplier/orders?status=` — orders placed against THIS org's products, joined with the ordering farmer's name. `status` accepts any real status value, or the shorthand `action_needed` (`requested` + `confirmed` — same two-value shorthand pattern as `GET /lender/loan-applications`/`GET /buyer/deliveries`).
- `GET /inputsupplier/orders/:id` — single order detail, including the farmer's phone number.
- `POST /inputsupplier/orders/:id/confirm` — `requested` → `confirmed`. `409 order_not_requested` (with the order's actual current status) if it isn't `requested`.
- `POST /inputsupplier/orders/:id/reject` — body `{ reason? }` → `requested` → `rejected`. Same `409` guard as confirm.
- `POST /inputsupplier/orders/:id/fulfill` — `confirmed` → `fulfilled`, the terminal "handed the goods over" step. `409 order_not_confirmed` if it isn't `confirmed`.

**Organization Roles / multi-role self-service** (`src/routes/organization.js`, requires any valid organization-subject JWT — deliberately NOT gated to any one `org_type`/role, since managing your own set of business roles is something every organization can do regardless of which roles it currently holds)
- `GET /organization/roles` — this org's full role picture: `org_name`, `primary_org_type` (the role chosen at registration), `entity_kyb_status`, every role it currently holds (`roles[]`, each with `status`/`requested_at`/`decided_at`/`decided_reason`/`label_th`), and every role type it could still request (`requestable_roles[]` — anything in the `ORG_REQUESTABLE_ROLE_TYPES` domain it doesn't already have a row for, regardless of that row's status; `Bank`/`Cooperative`/`Mill` are excluded from this domain. `VillageFund` was ADDED to this domain on 2026-08-17, same reasoning/date as `ORG_SELF_REGISTER_TYPES` above — an org that already holds some other primary role can now request `VillageFund` as an ADDITIONAL role here too).
- `POST /organization/roles` — body `{ role_type }` → self-service request for an ADDITIONAL business role. Requires the org's entity `kyb_status` to already be `Verified` (`409 entity_kyb_not_verified` — you need to clear base KYB before adding business capabilities on top of it) and no existing `(org_id, role_type)` row at all (`409 role_already_requested`, with the existing row's `status` — deliberately does NOT let a `Rejected` role be re-requested through self-service; that needs a human to intervene directly, not an unlimited retry loop against the same rejection). On success, inserts a new row at `status = 'Pending'` — same starting state as the org's primary role, same approval flow via `POST /admin/organizations/:id/roles/:role_type/status` above.

**Staff permission scoping** (`src/middleware/auth.js` — `resolveEffectiveOrgSubject`, `requireOrganizationOrStaff`, `STAFF_ROLE_TO_BUSINESS_ROLES`; wired into `requireLenderOrg` in `lender.js` and `requireMachineryOrg` in `machinery.js` — added 2026-08-17, `MULTI_ROLE_ORGANIZATION_ARCHITECTURE.md` §5.2): closes a gap that existed since the cooperative staff-login system was added (`grant_staff_and_government_access.sql`) — a staff login (`subject_type='organization_member'`, created via `identity.register_staff_member()`/`POST /coop/staff`) could authenticate but had **zero functional access** to any business route; `requireOrganizationMember` middleware existed but was never wired into a single route file, and `coopcollection.js`'s own code comment called this out explicitly as future work. There was no way for "the credit officer" to see only the Lender module while "the drying-yard officer" saw only DryingYardService — every staff login was either fully blocked or (had it been wired the obvious way) would have seen everything the org's shared login could see, with no segregation of duties.
  - `STAFF_ROLE_TO_BUSINESS_ROLES` maps each seeded `coop.*` operational role (`identity.subject_role`, from `grant_cooperative_tenant_foundation.sql`) to the `organization_role` `role_type`(s) it's allowed to act as the org for: `coop.credit_officer` → `['Lender']`, `coop.warehouse_officer` → `['DryingYardService']`, `coop.member_officer` → `['Cooperative']`, `coop.admin`/`coop.manager` → `null` (oversight — any module a retrofitted route asks for), `coop.accountant` → `[]` (a real seeded role with no route retrofitted to this mechanism yet — kept explicit so it reads as "known, nothing granted" rather than an unrecognized role_code, which fails closed with a different error). Any role_code not in this map at all is denied (`403 operational_role_not_recognized`) rather than silently falling through to full access.
  - `requireOrganizationOrStaff` replaces `requireOrganization` at the top of a retrofitted route file's `router.use(...)`, widening the subject-type gate to also admit `organization_member` (staff) logins — same as before for the shared org login, purely additive.
  - `resolveEffectiveOrgSubject(req, res, allowedBusinessRoleTypes)` is called from inside each route's own `requireXOrg` (e.g. `requireLenderOrg`) as the very first step, before the existing entity-KYB/role-Verified checks. For an `organization` subject it's a no-op (`true` immediately — zero behavior change for the shared org login, which is still how most of this project logs in). For an `organization_member` subject, it resolves the staff member's `org_id`+operational `role_code`, requires `status = 'Active'` (`403 staff_member_inactive` otherwise — deactivating a staff member via `POST /coop/staff/:id/deactivate` revokes route access on their very next request, no token revocation needed since this check runs fresh every time), confirms the role covers at least one of `allowedBusinessRoleTypes` (`403 operational_role_does_not_cover_module` otherwise), audit-logs the resolution (`identity.organization_member`, per staff member), then **rewrites `req.subject` to look like an org login** (`{subjectType: 'organization', subjectId: org_id}`) and sets `req.actingStaff = {memberId, roleCode}`. That rewrite is what let this ship with zero changes to any existing query in `lender.js`/`machinery.js` — none of that code has ever needed to know whether a request came from the org's own login or a staff member acting on its behalf, and still doesn't. `GET /lender/dashboard` and `GET /machinery/dashboard` both now echo `acting_staff` (`null` for the shared org login) in their response.
  - **Not done this pass** (documented, not silently skipped): no field-level gating inside `machinery.js`'s rate card — a `coop.warehouse_officer` who gets into `/machinery/*` because the org holds `DryingYardService` Verified sees the same unified rate card as any other machinery-role staff member, not a filtered drying-yard-only view (this predates the feature, see "no per-role field gating" in the Machinery Portal section above — fixing it needs a deeper `machinery.js` data-model change, out of scope here). `coop.accountant` has no route wired to this mechanism yet. No frontend surfaces `acting_staff` yet — this pass is backend authorization only.
  - **No new database migration** — this feature reuses `identity.organization_member`/`identity.subject_role`, both already created by `grant_staff_and_government_access.sql`; only `middleware/auth.js`, `lender.js`, and `machinery.js` changed.
  - Tested with a 25-assertion backend E2E suite (shared org login unaffected; each of 4 staff roles tested for correct accept/reject per module including the two negative-cross-module cases; oversight role reaches both modules; deactivation immediately revokes access) plus a re-run of the 17-assertion machinery-consolidation regression suite to confirm no interaction with §5.1's changes.

**Ledger revenue segregation by function** (`ledger.journal_entry.source_role_type`, `ledger.transfer_funds()`, `procurement.pay_invoice()` — `backend/db/grant_ledger_revenue_segregation.sql`; exposed via `GET /coop/finance/revenue-by-function` and a new column on `GET /coop/finance/transactions`, both in `coopcollection.js` — added 2026-08-17, `MULTI_ROLE_ORGANIZATION_ARCHITECTURE.md` §5.3a): a cooperative holding multiple non-Lender roles at once shares ONE `vendor_settlement` ledger account across all of them (see "Multi-role organizations" below and §2.4) — money from machinery rental, drying-yard fees, and wholesale produce sale all land in the same account with nothing distinguishing which function earned it, which makes even basic per-function reporting impossible, let alone an accurate Revenue Sharing distribution to members.
  - `source_role_type text` (nullable, no `CHECK` — same free-text convention as this table's existing `reference_type` column) was added to `ledger.journal_entry`, and `ledger.transfer_funds()` gained a matching optional `p_source_role_type` parameter (default `NULL`) that inserts straight into the new column at the moment the transfer happens.
  - **Signature-change note, worth remembering if this pattern gets reused:** verified directly against this project's own Postgres, before writing the migration, that `CREATE OR REPLACE FUNCTION` adding a new trailing `DEFAULT`-valued parameter does **not** replace the old signature — it creates a second overload, and any caller still supplying exactly the old argument count becomes ambiguous between the two (`function ... is not unique`). `grant_ledger_revenue_segregation.sql` explicitly `DROP FUNCTION`s the old 8-argument `transfer_funds` signature before creating the 9-argument one. Safe here specifically because every existing caller in this codebase uses named (`:=`) arguments, not positional, so none of them broke from the extra trailing parameter.
  - Of `transfer_funds()`'s several callers, only `procurement.pay_invoice()` was changed to actually pass a value — every wholesale produce settlement now gets tagged `'Wholesale'`. This is deliberately narrow, not an oversight: auditing every real money-moving call site in this codebase (not just guessing from the schema) found that of the five revenue categories originally scoped for this feature — loan interest, input-supplier commission, machinery rental, drying-yard fees, wholesale produce margin — wholesale is the **only one that moves real money through the ledger today**. `credit.repay_loan()` (loan interest) exists in the schema since an early layer of this platform but no API route anywhere calls it. Machinery rental and drying-yard fees go through `marketplace.machinery_booking` (see the Machinery/Drying-Yard Portal section above), which `grant_machinery_booking.sql`'s own comment says is deliberately offline-settled ("AgroLink never confirms the job actually happened") — the older `marketplace.service_request`/`complete_service_request()` mechanism does move real ledger money but is unwired legacy code, superseded by `machinery_booking` for exactly this reason. Input-supplier commission (`marketplace.product_order`) has no payment step in `POST /inputsupplier/orders/:id/fulfill` at all, same untracked shape. So `credit.repay_loan`, `ledger.hold_escrow`/`release_escrow`, `marketplace.complete_service_request`, and `produce.settle_delivery` were all left untouched in this pass — they keep defaulting to `source_role_type = NULL`, same as every `journal_entry` row created before this migration ran.
  - `reporting.coop_revenue_by_function(p_org_id)` aggregates `ledger.journal_line`/`journal_entry` for an org's own accounts, grouped by `source_role_type`, returning `entry_count`/`total_in`/`total_out` per group — deliberately does NOT filter out the `NULL` group, so a cooperative looking at `GET /coop/finance/revenue-by-function` sees directly that most of its ledger activity has no function attributed yet (today: one `'Wholesale'` row, if any, plus everything else under `NULL`) instead of the report silently only showing the one tagged category and implying that's the whole picture.
  - **No change to money movement, amounts, or any existing business rule** — this is metadata added to a normal `INSERT`, not a change to what gets transferred or between which accounts. No historical row was touched (`source_role_type` defaults to `NULL` for everything that existed before this migration).
  - Tested with a 21-assertion backend E2E suite (fresh cooperative + fresh Buyer org, full B2B Commerce Engine chain — RFQ → quote → accept → PO → GRN → invoice → pay — confirming the resulting journal entry is tagged `'Wholesale'` in both `GET /coop/finance/transactions` and the new `GET /coop/finance/revenue-by-function`, with `total_in` matching the invoice amount exactly) plus a standalone SQL smoke test confirming a legacy-style positional call to `transfer_funds()` (matching `hold_escrow`'s own call shape) still works post-migration and correctly defaults to `source_role_type = NULL`, plus re-runs of the §5.1/§5.2 regression suites (17 + 25 assertions) confirming no interaction with either prior change.
  - **Not done this pass:** no route was added for `credit.repay_loan()`; machinery rental, drying-yard fees, and input-supplier commission were NOT moved onto the ledger (that's a product decision with real user-facing consequences — AgroLink would start being asked to confirm/track payments it currently has no opinion on — not a schema change to make unilaterally). §5.3b (actually distributing revenue from these functions back to members, extending `procurement.revenue_share_plan` beyond `produce_sale`) remains open and explicitly blocked on a policy decision the user has confirmed isn't ready to make yet.

**Platform Ops / Admin Portal** (`src/routes/admin.js`, all require a `platform`-subject JWT from `POST /auth/admin-login`)
- `GET /admin/dashboard` — farmer counts by status, organization counts by `kyb_status`, and a `system_health` block built from `ops.v_integrity_checksum` + `monitoring.v_go_live_readiness` + an active-alerts count. These three views/queries already existed from Layer 9/10 and `agrolink_app` already had `SELECT` on all of them — nothing had ever exposed them through the API before; every previous check of them in this whole project was a manual `psql` query.
- `GET /admin/system-health` — the detailed version, including the actual list of currently-active alerts (not just a count) from `monitoring.v_active_alerts`.
- `GET /admin/farmers?status=...` — every farmer in the system (platform sees everyone; `identity.farmer` has no RLS), optionally filtered by `status` (`pending_kyc`/`active`/`suspended`/`closed`).
- `POST /admin/farmers/:id/status` — body `{ status, reason? }` → the KYC decision point. `pending_kyc → active` is a KYC approval; `pending_kyc → closed` is a rejection (`identity.farmer`'s own check constraint has no distinct "kyc_rejected" value, so `closed` is the correct terminal state). The same endpoint also covers ordinary later moderation (suspend/reactivate/close an already-active farmer), since the constraint allows any of the four values and there's no reason to special-case KYC vs later moderation at the API layer. Always sends the farmer a real notification via `notification.notify()` with the reason if given — the *only* way a farmer finds out about the decision in this sandbox, surfacing through their existing `GET /farmer/notifications`.
- `GET /admin/organizations?kyb_status=...` — every organization, left-joined with `partner.vendor_profile` for its commercial-activation status, optionally filtered by `kyb_status` (`Pending`/`Verified`/`Rejected`).
- `POST /admin/organizations/:id/kyb-status` — body `{ kyb_status, reason? }` → the KYB decision point. `Pending → Verified` is approval, `Pending → Rejected` is rejection. On approval, if the organization already has a `partner.vendor_profile` row, this also calls `partner.activate_vendor()` — that function itself requires `kyb_status = 'Verified'` to already be set, so the ordering here (update `kyb_status` first, then attempt activation) matches what it expects; its own idempotency (checks for an existing `ledger.account` before creating one) means this is safe to call again on an already-active org. Activation failure doesn't fail the whole KYB approval — the org is still legitimately `Verified` even if commercial activation needs manual follow-up. Same notification pattern as the farmer endpoint. **Also** syncs the org's PRIMARY role in `identity.organization_role` to the same `kyb_status`/`reason` in the same request (`ON CONFLICT (org_id, role_type) DO UPDATE`) — see "Multi-role organizations" below; this one endpoint still covers both the entity KYB decision and the primary-role decision together, exactly as it did before multi-role support existed.
- `GET /admin/role-requests?status=...` — every row in `identity.organization_role` (every org's primary role AND every secondary role request), joined with the organization's name/primary `org_type`/entity `kyb_status`, optionally filtered by the role's own `status`. Includes primary-role rows too, since both live in the same table — the frontend admin dashboard distinguishes "this is the org's original role, already handled by the KYB queue above" from "this is a genuinely separate secondary-role request" by comparing `role_type` to `primary_org_type` client-side.
- `POST /admin/organizations/:id/roles/:role_type/status` — body `{ status, reason? }` → the decision point for a **secondary** role request (see `POST /organization/roles` below) — deliberately separate from the primary-role decision folded into the KYB endpoint above, per the explicit product decision that every additional role needs its own Platform Ops sign-off, not a one-time blanket approval. Requires the organization's entity `kyb_status` to already be `Verified` (`409 entity_kyb_not_verified` otherwise — an org that hasn't cleared base KYB can't have a secondary request to begin with) and an existing `(org_id, role_type)` row (`404 role_request_not_found` — this endpoint will never create a role request nobody asked for). On `status: 'Verified'`, also calls `partner.activate_vendor_role(org_id, role_type)` (best-effort — a failure here doesn't fail the role approval itself, same pattern as the KYB endpoint) and sends a real notification via `notification.notify()`.

`underwriting.evaluate_application()` itself is not exposed as its own
route — it is only ever called internally, immediately after
`submit_application()`, against the application id that call just returned.
It runs the same automated policy check every layer-10-style function
does: a `risk_tier` of `D` auto-declines; a request within the matching
`underwriting.loan_policy` cap with `auto_approve = true` auto-approves; anything
else (over cap, or a tier whose policy requires manual sign-off even in
cap) lands in `manual_review`. If the farmer has no credit score at all yet
(e.g. brand new, no production/delivery history for
`risk.compute_credit_score()` to have run against), the evaluation call
itself raises — the route catches that specifically and leaves the
application at `pending` rather than failing the whole request; a real
deployment would have a scheduled job compute the score and retry once
there's enough history.

Every handler calls `audit.log_access()` (action `'read'` or `'write'` — the
only two values `audit.access_log`'s check constraint allows) inside the
same session-context-scoped client, after a successful operation.

## Multi-role organizations (an org can hold more than one business role)

Real institutions like BAAC or a cooperative do more than one thing at
once — they lend money, buy produce, sell fertilizer/inputs, and sometimes
run a rice-drying yard, all under one legal entity. Before this feature, an
organization was permanently locked to the single `org_type` it registered
with (`identity.organization.org_type` is set once at insert and never
changed by any route). This closes that gap, per an explicit product
decision: **register with one role first, request more later — and every
new role, including the first, needs its own Platform Ops approval** (not a
one-time blanket approval that lets an org silently pick up new business
capabilities once it clears KYB once).

**Two-layer verification model:**
1. **Entity-level KYB** (`identity.organization.kyb_status`) — is this a
   real, legally legitimate business at all? Decided once, via the
   pre-existing `POST /admin/organizations/:id/kyb-status` endpoint.
   Unchanged by this feature.
2. **Per-role commercial authorization** (`identity.organization_role.status`)
   — is this *specific* business activity (Lender, Buyer, TractorService,
   ...) something Platform Ops has actually cleared this org to do? New in
   this feature. The org's PRIMARY role (chosen at registration) gets a row
   here too, kept in lockstep with `kyb_status` by the *same* KYB-approval
   endpoint (so the pre-existing single-role signup/approval flow needs zero
   changes from an operator's point of view). Any ADDITIONAL role goes
   through a wholly separate request (`POST /organization/roles`) and
   approval (`POST /admin/organizations/:id/roles/:role_type/status`) path.

Every portal gate (`requireLenderOrg`/`requireBuyerOrg`/`requireMachineryOrg`)
now checks BOTH layers, in order: entity `kyb_status` first (`403
kyb_not_verified` — same error as before this feature, so a plain
single-role org that's still Pending its very first review sees exactly the
same behavior as always), then the specific role's status (`403
role_not_verified` — new). This means a Lender org that later gets a
Verified Buyer role reaches `GET /buyer/dashboard` with the **same JWT** it
already has — no re-login, no new token, since the JWT only ever encoded
`(subjectType, subjectId)`, never a role list.

**Schema** (`backend/db/grant_organization_roles.sql`):
- `identity.organization_role (org_id, role_type, status, requested_at, decided_at, decided_reason)`,
  primary key `(org_id, role_type)` — one row per role an org holds or has
  requested, `status` following the same `Pending`/`Verified`/`Rejected`
  domain as `kyb_status`. `role_type` accepts the same 13-value domain as
  `identity.organization.org_type` (`VillageFund` is both self-registerable
  and self-requestable as of 2026-08-17, same as most of this domain — see
  "Farmer 360° View" below. `Bank` is the remaining excluded value: it can
  never be *requested* via `POST /organization/roles` since it's excluded
  from `ORG_REQUESTABLE_ROLE_TYPES`, but a seeded org could in principle
  already hold it).
- `partner.activate_vendor_role(p_org_id, p_role_type)` — role-aware
  replacement for the old `partner.activate_vendor(p_org_id)`: creates a
  `lender_clearing` ledger account for a `Lender` role, or a shared
  `vendor_settlement` account for every other role type (checks for an
  existing one first — an org with both a Buyer role and, say, a
  TractorService role gets ONE `vendor_settlement` account shared across
  both, not one per role; verified in testing, see below). `partner.activate_vendor(p_org_id)`
  itself is kept as a backward-compatible wrapper that delegates to the new
  function using the org's `org_type` as the role — every pre-existing call
  site (the KYB-approval endpoint) still works unchanged.
- Backfill: the three pre-existing seeded organizations each got one
  `Verified` row matching their existing `org_type`/`kyb_status`, so no
  seeded org lost portal access when this migration ran.

**End-to-end verification performed** (see also the dated entry further
down): a fresh org registered as `Lender` → confirmed blocked from
`/lender/dashboard` (`kyb_not_verified`) → confirmed `POST
/organization/roles` itself blocked pre-KYB (`409 entity_kyb_not_verified`)
→ admin approved the primary KYB → confirmed the primary role row synced to
`Verified` automatically and `/lender/dashboard` now works → confirmed
`/buyer/dashboard` still blocked (`role_not_verified`, `role_status: null`
— no row exists yet) → requested a `Buyer` role → confirmed a second
identical request 409s (`role_already_requested`) → confirmed
`/buyer/dashboard` still blocked while `Pending` (`role_status: "Pending"`)
→ admin approved the `Buyer` role via the new endpoint → confirmed
`/buyer/dashboard` now works **with the same JWT**, no re-login → confirmed
via direct SQL that the org ended up with exactly two ledger accounts
(`lender_clearing` + `vendor_settlement`, no duplicates) → requested and
then admin-REJECTED a `TractorService` role → confirmed `/machinery/dashboard`
reports `role_status: "Rejected"` → confirmed re-requesting a Rejected role
409s rather than silently resetting it to Pending → re-verified an existing
seeded single-role org (the seeded Lender) still logs in and reaches
`/lender/dashboard` exactly as before (regression check). Separately caught
and fixed a real bug this testing surfaced: `GET /machinery/dashboard` was
returning `identity.organization.org_type` (the entity's PRIMARY role) as
"this org's service type" — for a multi-role org whose primary role isn't a
machinery type at all (e.g. a Buyer org that added a Verified
`TractorService` role), this showed the wrong, unrelated type. Fixed by
having `requireMachineryOrg` compute the actual Verified machinery role(s)
held and returning those as `service_types` instead.

**2026-08-04 addition (Fulfillment Marketplace เส้นทาง C):** `FertilizerMixingService`
added to `ORG_REQUESTABLE_ROLE_TYPES`/`ROLE_LABEL_TH` in
`src/routes/organization.js`. The `org_type`/`role_type` CHECK constraints
already allowed this value (added by `grant_fertilizer_mixing_service.sql`
for เส้นทาง A's own from-scratch self-registration path) — only the
*requestable-as-a-secondary-role* list was missing it. Practical effect: an
org that already cleared entity KYB under some other primary role (e.g. an
`InputSupplier` already selling fertilizer) can now request
`FertilizerMixingService` as an ADDITIONAL role through this exact
mechanism, with zero new endpoints — it reuses `POST /organization/roles`
and `POST /admin/organizations/:id/roles/:role_type/status` as-is. Also
fixed while wiring this up: `frontend/js/manage-roles.js`'s `SESSION_KEYS`
only checked the Lender/Buyer/Machinery portal session keys, silently
stranding an InputSupplier/MarketVenue/FertilizerMixingService-only org on
"ยังไม่ได้เข้าสู่ระบบ" even with a perfectly valid session in another
portal's `localStorage` — now checks all six. Verified end-to-end (fresh
local Postgres 16 + the real Node server + real HTTP requests): a
`Verified` `InputSupplier` org's `GET /organization/roles` now lists
`FertilizerMixingService` under `requestable_roles`, and `POST
/organization/roles {"role_type":"FertilizerMixingService"}` correctly
creates a `Pending` row for Platform Ops to review.

## Fulfillment Marketplace — custom fertilizer-mixing service

Three-path feature (named เส้นทาง A/B/C in the codebase's own comments):
farmers order a custom urea/DAP/MOP blend from a KYB-verified mixing
provider (**เส้นทาง A**, previously shipped but never written up in this
README — corrected here), farmers can pool orders into a group for a
volume discount (**เส้นทาง B**, this pass), and existing KYB-verified orgs
can add fertilizer-mixing as a secondary business role (**เส้นทาง C**, this
pass — see the dated note above). **เส้นทาง D (นักตรวจดินเคลื่อนที่ / mobile
soil-test technician, the other new Stage-based Service Marketplace
category the source analysis doc names alongside fertilizer-mixing) is
NOT built** — out of scope for all three passes so far.

**เส้นทาง A — solo orders** (`grant_fertilizer_mixing_service.sql`,
`src/routes/fertilizer.js` farmer-side + `src/routes/fertilizermixing.js`
provider-side, `frontend/fertilizermixing/*` provider portal,
`frontend/fertilizer-mixing-marketplace.html` farmer page): a dedicated
`marketplace.fertilizer_mixing_order` table (not the older, unwired
`marketplace.service_request` mechanism — payment is offline between
farmer and provider, same as every other `*_booking` table in this
project). An order can optionally link back to the exact Stage Calendar
fertilizer stage and/or AI-calculated formula run it came from, so a
provider sees the real numbers, not a vague request. **Found and fixed in
this pass, unrelated to Path B/C themselves but blocking all of เส้นทาง A
in production:** `src/server.js` never actually `require()`'d or
`app.use()`'d `fertilizer.js`, `fertilizermixing.js`, `stagecalendar.js`,
`marketvenue.js`, or `content.js` — every route in all five files was
returning `404 not_found`, not just failing some other way, despite the
files themselves being complete and correct. Fixed by adding the five
missing mounts (three of them — `farmer.js`, `stagecalendar.js`,
`fertilizer.js` — deliberately share the `/farmer` prefix; verified no two
of their route paths collide). Verified via a live route-reachability
smoke test (every previously-404 path now correctly returns `401`, proving
the router is reached) and, for the fertilizer-mixing/group-buying slice
specifically, full functional verification against a real local Postgres
16 database (see below). Also found and fixed: the farmer dashboard
(`frontend/dashboard.html`) had no navigation link to
`fertilizer-calculator.html`, `fertilizer-mixing-marketplace.html`, or
(now) `fertilizer-mixing-group.html` at all — added all three. **Known
still-broken, NOT fixed in this pass** (out of scope — unrelated to
Fulfillment Marketplace): `frontend/js/venue-marketplace.js` calls `GET
/farmer/venue-listings/recommended` and `POST`/`GET
/farmer/venue-bookings`, none of which exist in ANY route file (not a
mounting gap like the five above — these were never implemented). The
Selling-Space Matching Portal's PROVIDER side (`src/routes/marketvenue.js`)
is real and now reachable; the farmer-facing booking side is not.

**เส้นทาง B — group buying** (`grant_fertilizer_mixing_group_order.sql`,
new endpoints in `src/routes/fertilizer.js`, additive changes to `GET`/`PUT
/fertilizermixing/rate-card` and `GET /fertilizermixing/orders` in
`src/routes/fertilizermixing.js`, new `frontend/fertilizer-mixing-group.html`
+ `frontend/js/fertilizer-mixing-group.js`). Product decision made with the
user: **a farmer starts the group** (not the platform auto-matching by
location/time, and not the provider), and **the provider sets a volume
threshold + percent discount** on their own rate card
(`bulk_discount_min_kg`/`bulk_discount_percent` on
`marketplace.service_listing`) that applies to every order in a group once
crossed.

- A group starts as a lightweight pledge:
  `marketplace.fertilizer_mixing_group_order` (the shell — organizer,
  shareable `group_code`, join deadline, a snapshot of the listing's price
  + discount policy at creation time) plus one
  `marketplace.fertilizer_mixing_group_participant` row per farmer who
  joins. Neither is a real order yet — the provider sees nothing until
  submission.
- Only the ORGANIZER's explicit submit
  (`POST /farmer/fertilizer-mixing-groups/:id/submit`) turns a group into
  real orders: one `marketplace.fertilizer_mixing_order` row per current
  participant (`group_id` set), priced at the group's discounted
  `unit_price` if the combined kg met `bulk_discount_min_kg`, at the normal
  snapshotted price otherwise. From that moment on, every one of those
  orders flows through the EXACT SAME Accept/Decline/Complete lifecycle a
  solo เส้นทาง A order does — the provider's dashboard needed no new
  action endpoints, only two additive read-side touches (rate-card
  discount fields; `group_id` surfaced on order rows, shown as a "👥
  กลุ่มสั่งซื้อ" badge). This is the one place in the whole codebase with an
  explicit `BEGIN`/`COMMIT`/`ROLLBACK` transaction (every other write path
  here is a single `INSERT`/`UPDATE`) — submitting a group creates N order
  rows + updates N participant rows + updates the group row, and a crash
  mid-loop must not leave some participants with a real order and others
  silently without one.
- No auto-submit/auto-expire background job — this sandbox has no
  scheduler. `join_deadline` is advisory (shown to a farmer deciding
  whether to join a group about to close); the organizer must still
  explicitly submit or cancel. Documented gap, see Next Steps.
- Explicitly out of scope for this pass: multiple discount tiers (one
  threshold + one flat percent per listing, matching เส้นทาง A's
  one-rate-card-item simplicity), a shared delivery date/address across
  the whole group (each participant still sets their own), re-joining a
  group after withdrawing (`UNIQUE(group_id, farmer_id)` blocks it — a
  farmer who changes their mind needs a fresh group).

**End-to-end verification performed:** ran the FULL migration chain (all 29
files, in the corrected order above) against a clean local Postgres 16
database with `ON_ERROR_STOP=1` — applies cleanly, and the new migration
is idempotent (re-ran it a second time, zero errors, only expected
`already exists, skipping` notices). Started the real Node server against
that database and drove the complete group-buying flow through the actual
HTTP API: created a group as one seeded farmer (organizer), looked it up
by `group_code` as a second seeded farmer, joined, confirmed a duplicate
join 409s, confirmed the organizer cannot withdraw (`409
organizer_cannot_withdraw`, must cancel instead), submitted the group with
combined kg above the listing's threshold and confirmed the resulting
orders both landed in the provider's `GET /fertilizermixing/orders` with
the correct discounted `unit_price` and `group_id`, confirmed re-submitting
an already-Submitted group 409s, separately confirmed a group whose
combined kg stayed BELOW the threshold submits at the normal (undiscounted)
price, and confirmed the cancel flow blocks a later submit attempt. Then
repeated the group-creation → invite-by-URL → join → submit flow through
the actual rendered pages (headless Chromium against the real server and
database, not a DOM/unit test) to catch UI-wiring bugs the API-level test
alone couldn't — no bugs found; all toasts, badges, and progress displays
matched the API responses driving them.

## Low-Carbon Rice Cultivation Verification (AWD water-log + carbon-credit estimate)

Added 2026-08-04 (`db/grant_carbon_awd.sql`, `src/routes/carbon.js`,
`src/routes/admin.js` additions, `frontend/carbon-credit.html` +
`frontend/js/carbon-credit.js`, `frontend/admin/carbon-assessment-detail.html`
+ its own js, and additions to `frontend/admin/dashboard.html`/`dashboard.js`).
A completely new feature area (unrelated to the Fulfillment Marketplace
above), requested as: "ระบบยืนยันการปลูกข้าวแบบคาร์บอนต่ำ (มีการควบคุมน้ำให้
ท่วมให้แห้งระหว่างการปลูกข้าว) และการยืนยันเพื่อคิดคาร์บอนเครดิตสำหรับแปลง
เกษตรกรที่เข้าเกณฑ์" — a farmer-self-reported AWD (Alternate Wetting and
Drying) water-log, reviewed by Platform Ops, that produces an **estimated**
carbon-credit figure for eligible rice crop cycles.

**Scope, stated plainly**: this is an internal MRV (Measurement, Reporting,
Verification) tool + a rough credit *estimate*, not real carbon-credit
issuance. Getting a tradeable credit still requires a separate application
to an actual registry/validator (e.g. Thailand's T-VER program run by
TGO/อบก.). The calculation below is loosely inspired by T-VER's AWD
approach (minimum qualifying dry-down count, minimum water-level drop,
per-area credit) but every constant is a rough placeholder the operator
must correct against the real published methodology before relying on it
commercially — the same honesty caveat this project already applies to
`stage_template.typical_offset_days` and `crop_nutrient_requirement`.

**Design decisions, each confirmed with the user via AskUserQuestion before
building:**
- **Water-level data source**: farmer self-report is the primary source
  (status flooded/dry + optional field-water-tube reading in cm + an
  optional photo URL — no file-upload infra exists in this sandbox, so
  `photo_url` is just a text link, same pattern as
  `partner.vendor_document.document_ref`). Satellite imagery is explicitly
  a *supplementary* corroborating signal, not the primary source — the user
  has no Sentinel Hub/Google Earth Engine/GISTDA account yet, so
  `carbon.satellite_observation` today is populated by Platform Ops typing
  in a manual reading (`source_provider = 'manual'`); the other
  `source_provider` values (`sentinel1_sar`, `sentinel2_optical`, `gistda`,
  `other`) are reserved so a real automated integration can plug in later
  with no schema change.
- **Credit methodology**: loosely aligned with T-VER's AWD approach, with
  every constant adjustable by Platform Ops (`carbon.awd_config`,
  versioned — new values apply only to future calculations, never
  retroactively, same snapshot pattern as price snapshotting on every
  order/booking table in this project) rather than hardcoded.
- **Reviewer**: the existing Platform Ops team (same team/role that
  reviews KYC/KYB) — no dedicated "carbon verifier" org role was built.

**Calculation model** (`recomputeAssessment()` in `src/routes/carbon.js`):
walk a crop cycle's `carbon.awd_water_log` rows chronologically; a reading
counts as "AWD-dry" if `water_status='dry'` AND (`water_level_cm IS NULL`
OR `water_level_cm <= -min_water_level_drop_cm`) — a status-only report
with no cm reading is trusted as-is. Consecutive AWD-dry readings form a
run; a run "qualifies" as one dry event once its span reaches
`min_dry_period_days`. The cycle is eligible for the *full* per-rai credit
only once it accumulates `min_dry_events_required` qualifying events in the
whole season — all-or-nothing per cycle, not partial credit per event, to
keep this estimate model simple and legible rather than pretending to more
precision than the input data supports.

**State machine** (`carbon.awd_cycle_assessment`, one row per
`production.crop_cycle`, restricted to `commodity_code LIKE 'RICE_%'` since
AWD is rice-specific): `draft` (recalculated on every new water-log entry)
→ farmer calls `POST /farmer/carbon/cycles/:id/submit` → `pending_review`
(locks out further water-log inserts) → Platform Ops calls `POST
/admin/carbon/assessments/:id/verify` → `verified` (permanently locked), or
`POST .../reject` (requires a `review_note`) → `rejected`, which — like
`draft` — still accepts new water-log entries and a resubmit, so a
rejection is a bounce-back-and-fix loop, not a dead end.

**Verified**: applied `grant_carbon_awd.sql` against the same from-scratch
local Postgres 16 + PostGIS build used for the Fulfillment Marketplace
verification below (full 30-file migration chain, zero errors — the same
kind of `agrolink_app` grant gap that Fulfillment Marketplace's testing
caught earlier would have surfaced here too). Then, against a real running
`node src/server.js` + real HTTP requests: created a farmer, a rice
production unit, and a crop cycle; logged a realistic sequence of
flood/dry-with-cm-reading events covering three qualifying dry-downs, one
too-short dry-down (3 days, correctly excluded), and one qualifying-length
but too-shallow dry-down (-10cm against a -15cm threshold, correctly
excluded) — the resulting `qualifying_dry_events=3`,
`total_dry_days=23`, `estimated_credit_tco2e=0.8000` (10 rai × 0.08
tCO2e/rai) all matched hand-calculation exactly. Also verified: the
submit→lock→reject→reopen→resubmit→verify state machine end to end
(including the 409 a farmer gets trying to log against a locked
assessment); cross-tenant isolation (a second farmer gets 404, not another
farmer's data); the `RICE_%` filter correctly excludes a CASSAVA cycle from
every carbon endpoint; `carbon.awd_config` versioning (posting a new
config deactivates the old one, and an already-verified assessment keeps
its original snapshotted emission factor even after the config changes);
the manual satellite-observation upsert (`ON CONFLICT (unit_id,
observation_date, source_provider)`, re-ingesting corrects rather than
duplicates); and both `notification.notify()` calls (verified/rejected)
landing in `notification.notification_log`. Then repeated the
create-cycle → log-water-levels → submit → (admin) verify flow through the
actual rendered pages (headless Chromium against the real server and
database) for both the farmer portal (`carbon-credit.html`) and the admin
portal (`admin/dashboard.html`'s AWD queue +
`admin/carbon-assessment-detail.html`) — this is where a real bug was
caught and fixed: the new `loadAwdQueue()`/`loadAwdConfig()` functions were
initially defined but never actually called from `dashboard.js`'s
`refreshAll()`/page-load section, so the whole admin section would have
silently sat on its loading spinner forever in production. No other
UI-wiring bugs found.

## Product catalog vs. rate card (why InputSupplier isn't just Machinery again)

The Machinery Portal's `marketplace.service_listing` is a **fixed-key rate
card**: exactly nine possible line items (`plow_rough`, `spraying`,
`drying`, `straw_pelletizing`, `straw_baling`, ...), one row per
`(org_id, service_key)`, priced or not. That
shape fits machinery/drying-yard services because the *menu* of possible
services is small, fixed, and shared across the whole industry — a provider
either offers `spraying` or doesn't, there's no such thing as two different
`spraying` offerings from the same org.

An input supplier's actual product list doesn't fit that shape at all — a
fertilizer/chemical/equipment shop can carry an arbitrary, ever-changing
number of distinct products, several in the same category (two different
15-15-15 fertilizer brands, three different herbicides), each with its own
name/brand/price. Modeling that as a fixed-key rate card would mean
inventing an unbounded set of keys up front, which doesn't work. Instead
`marketplace.product_listing` is a genuinely open-ended list — `listing_id`
is its own primary key (not `(org_id, service_key)`), `POST` always inserts
a new row, and `category` (`fertilizer_hormone`/`chemical_pesticide`/
`equipment`/`other`) is just a filterable field on each row rather than part
of the identity of the row.

This also changes the deletion story: the rate card's `PUT` never deletes a
row, only deactivates it (`is_active = false`), specifically because a
farmer could already have booked a `marketplace.service_request` against
that exact `(org_id, service_key)` and deleting it would orphan that
booking's FK. `marketplace.product_listing` used to have no such
booking/order flow sitting on top of it, so `DELETE
/inputsupplier/products/:id` started as a real hard delete. That changed
the moment `marketplace.product_order` was added (see "Farmer ordering
flow" immediately below) — `DELETE` now deactivates instead, for exactly
the reason predicted here originally.

## Farmer ordering flow (browse + order against the catalog)

Building the catalog (above) only gave a supplier somewhere to list
products — nothing let a farmer see it or buy anything, which was called
out explicitly as a gap at the time. This closes that gap with a real
request → confirm/reject → fulfill lifecycle, modeled after
`underwriting.loan_application`'s shape (farmer-initiated, org decides)
rather than `produce.delivery`'s (org-initiated) — an order request, like a
loan application, starts with the farmer wanting something and the
counterparty saying yes or no.

**Schema** (`backend/db/grant_farmer_product_orders.sql`):
`marketplace.product_order` has one row per order, with `status` following
`requested → confirmed → fulfilled` (the happy path) or `requested →
rejected` / `requested → cancelled` (the two ways an order stops early —
the supplier says no, or the farmer changes their mind before the supplier
has acted). Once `confirmed`, only `fulfilled` is reachable — a supplier
can't reject an order they already agreed to, and a farmer can't cancel one
the supplier is already committed to; the farmer's only path from a
`confirmed` order is to wait, same as a lender's `approved`
loan-application-turned-contract can't be un-approved by the farmer either.

Price/name/category are **snapshotted onto the order at creation time**
rather than read live via a join back to `product_listing` — the same
reasoning a real invoice line item follows: if the supplier edits their
price tomorrow, an order placed today must not silently change value.
`listing_id` is still a real FK (kept for traceability back to the catalog
entry), it just isn't relied on for display.

No push notification fires on a status change (no `notification.notify()`
call anywhere in this flow) — this deliberately matches the existing
`POST /lender/loan-applications/:id/approve`/`decline` and
`POST /buyer/deliveries/:id/confirm-quality` convention: only
Platform-Ops-initiated actions (KYC/KYB decisions) push a notification in
this sandbox; peer-to-peer decisions are discovered by the affected party
re-checking their own portal (`GET /farmer/orders` here), not pushed to
them. Kept consistent rather than introducing a one-off exception for this
one flow.

**What this flow deliberately does NOT do**: there is no payment or
`ledger.transfer_funds()` call anywhere in this lifecycle — `fulfilled`
just marks that the supplier says they handed the goods over, nothing more.
This is unlike `POST /buyer/deliveries/:id/settle`, which moves real money
through the ledger. A real deployment would need to decide how payment for
these orders actually happens (on delivery, in advance, through the
existing `ledger` schema, or entirely outside AgroLink) — deliberately out
of scope for this pass; see "what's mocked" below.

## Daily rice-buying-price announcements (two audiences, one table)

Buyers (rice mills etc.) traditionally post a daily buying price per rice
grade — this is a real, everyday practice the feature needed to mirror, not
an invented one. Two distinct audiences read/write here: the Buyer sets
their own prices (`PUT /buyer/price-quotes`), and farmers compare prices
*across every Buyer* for a given grade (`GET /farmer/rice-prices`) — this
was an explicit product decision (confirmed with IT Development Manager
before building) rather than an internal-only buyer tool, since an
announcement nobody outside the org can see isn't really an announcement.

`registry.rice_grade_ref` (7 rows: `HOMMALI105`, `PATHUMTHANI1`,
`WHITE_RICE_5`, `WHITE_RICE_25`, `GLUTINOUS_RD6`, `GLUTINOUS_RD10`,
`GLUTINOUS_SHORT`) is a **new, separate table** from the pre-existing
`registry.commodity_ref` (3 generic rows: `RICE_JASMINE`, `RICE_PADDY`,
`CASSAVA`, used by the Buyer Portal's delivery-recording flow). They serve
different purposes — `commodity_ref` is a generic commodity list for
`produce.record_delivery()`, while `rice_grade_ref` specifically mirrors the
grade categories a general rice mill (โรงสีทั่วไป) actually quotes prices
against day to day — so the existing table was deliberately left alone
rather than widened to try to serve both purposes at once.

`marketplace.buy_price_quote` uses a genuine composite **primary key**
`(org_id, grade_code)` — not a partial unique index gated on
`is_active`, unlike a bug that had to be fixed once elsewhere in this
project (`service_listing`'s original partial-unique-index `ON CONFLICT`
target). A non-partial PK means `ON CONFLICT (org_id, grade_code) DO
UPDATE` never needs a matching `WHERE` predicate — this was a deliberate
design choice made specifically to avoid re-triggering that class of bug,
not an accident.

## Featured Listings (Platform-Ops-managed promotion)

`grant_featured_listings.sql` added `is_featured`/`featured_until` to
`marketplace.product_listing` and `marketplace.service_listing` some time
ago, but shipped schema-only — no route ever read or wrote those columns,
and no frontend ever surfaced them. **That gap is now closed.**

- `GET/POST /admin/product-listings*` and `GET/POST /admin/service-listings*`
  (`src/routes/admin.js`) let Platform Ops list every catalog row across
  every org and flip `is_featured` on for a chosen number of days
  (`POST .../feature`, body `{ days? }`, defaults to 30) or off
  (`POST .../unfeature`). Deliberately admin-toggled, not self-serve — like
  every other paid interaction in this platform, there is no online payment
  gateway; a provider pays AgroLink offline and Platform Ops flips the
  switch, same operating model as KYB approval.
- `GET /farmer/products` and `GET /farmer/machinery-providers` sort
  currently-featured rows first and return a computed `featured` boolean
  (`is_featured AND (featured_until IS NULL OR featured_until > now())`) —
  computed live rather than trusted from the stored flag, since
  `is_featured` is never auto-cleared once `featured_until` passes.
- The management UI lives in `frontend/admin/dashboard.html`'s "⭐
  รายการแนะนำ" sidebar tab (`js/dashboard.js`'s `initFeaturedListings()` —
  merged into the single admin dashboard SPA on 2026-08-29, previously its
  own `featured-listings.html`/`featured-listings.js` page, now archived
  under `frontend/_to_delete/`); `frontend/js/marketplace.js` and
  `frontend/js/machinery-marketplace.js` render the "⭐ แนะนำ" badge on
  the farmer-facing side.

## Cooperative produce/processed-goods catalog (M14.1)

A cooperative can now advertise available produce/processed goods (milled
rice, dried paddy, etc.) to **Buyer** orgs, reusing the exact same
`marketplace.product_listing` / `product_photo` / `product_order` machinery
the InputSupplier catalog above uses, rather than a parallel table set —
an explicit product decision to have the cooperative "use this same
catalog." `grant_cooperative_product_catalog.sql` made two schema changes
to allow it: widened the `category` CHECK on both tables to add `produce`/
`processed_good` (which categories are valid for which seller org_type is
enforced at the application layer, not the database — see that file's
comment), and made `product_order.farmer_id` nullable alongside a new
nullable `buyer_org_id`, with a CHECK requiring exactly one of the two set.

- Seller side: `GET/POST /coop/products`, `PUT/DELETE /coop/products/:id`,
  photo endpoints, and the order lifecycle
  (`GET /coop/products/orders`, `.../confirm`, `.../reject`, `.../fulfill`)
  — `src/routes/coopcollection.js`, gated by the existing
  `requireCooperativeOrg`. A cooperative provisioned via
  `POST /admin/cooperatives` has no `partner.vendor_profile` row yet
  (`product_listing.org_id` REFERENCES that table) — the first `POST
  /coop/products` call provisions one inline, idempotently, rather than
  requiring the coop to go through `POST /admin/cooperatives/:id/
  activate-settlement` first.
- Buyer side: `GET /buyer/coop-directory`, `GET /buyer/coop-products`,
  `POST /buyer/coop-products/orders`, `GET /buyer/coop-products/orders`,
  `POST /buyer/coop-products/orders/:id/cancel` — `src/routes/buyer.js`,
  mirroring `farmer.js`'s InputSupplier-browsing routes shape exactly.
- `GET /farmer/products` and `GET /buyer/coop-products` each add a FIXED
  (not client-controlled) `o.org_type = 'InputSupplier'` /
  `o.org_type = 'Cooperative'` filter respectively — without it, both
  seller directions sharing one table would bleed into each other's
  audience now that Cooperative orgs can also write to
  `marketplace.product_listing`.
- Frontend: `frontend/coop/dashboard.html`/`js/dashboard.js` (catalog
  management + incoming-order queue) and
  `frontend/buyer/dashboard.html`/`js/dashboard.js` (browse + order +
  cancel + order history).

## RFP/RFQ — cross-portal "post what you need, sellers compete" marketplace

A NEW mechanism, deliberately separate from the direct catalogs above
(`marketplace.product_listing`/`service_listing`, "browse a fixed price and
buy now"): a member posts a need (an RFQ/RFP), and any organization in the
system can respond with a competing price quote — a reverse marketplace /
competitive-bidding shape a fixed-price catalog can't express. Built at an
explicit user request to be usable by every AgroLink member ("สำหรับให้
สมาชิกในระบบ Agrolink ใช้งาน") and to also live inside the cooperative's own
SaaS ("และให้อยู่ใน SaaS ของสหกรณ์ด้วย").

Schema: `backend/db/grant_rfq_marketplace.sql` adds a new `procurement`
schema with two tables — `procurement.rfq` and `procurement.rfq_quote`.
Design decisions (see that file's own doc comment for the full rationale):

- A **requester** can be either a farmer or an organization (polymorphic
  `requester_subject_type`/`requester_subject_id`, the same convention as
  `identity.subject_role`/`storage.file_object`'s owner columns elsewhere
  in this schema) — any member can post a need.
- A **responder** (quote submitter) is always an **organization** —
  farmers don't submit quotes in this pass. Real AgroLink sellers
  (cooperatives, input suppliers, buyers, machinery/logistics providers)
  are all organizations; farmer-to-farmer quoting is a possible future
  widening, not built now.
- `category` is intentionally broad and shared across every portal
  (`input_product`, `produce`, `processed_good`, `machinery_service`,
  `other`) rather than one enum per org type, so any member can browse by
  category regardless of which portal will respond.
- Accepting a quote (`rfq.awarded_quote_id`) records intent AND, as of the
  B2B Commerce Engine phase below, auto-creates a real `contract.contract`
  row — it still does NOT auto-create a `produce.delivery` /
  `marketplace.product_order` row, only the contract. See "AgroLink B2B
  Commerce Engine" below for the full award → contract → PO chain.
- A responder submitting/editing a quote upserts via
  `ON CONFLICT (rfq_id, responder_org_id)` rather than creating duplicate
  rows — the same pattern `marketplace.buy_price_quote` already uses.

Backend: `src/routes/procurement.js`, mounted at `/procurement`. This is
the **first route file in the project accepting both farmer and
organization JWTs on the same endpoints** — rather than gating the whole
router with `requireFarmer`/`requireOrganization`, it only requires
`requireAuth` and checks `req.subject.subjectType` per handler.
Organization requesters/responders must additionally be
`kyb_status = 'Verified'` (checked inline, no specific `role_type`
required — RFQ spans every portal).

- `POST /procurement/rfqs` — post a new RFQ (farmer or verified org).
- `GET /procurement/rfqs?category=&status=` — browse (defaults to
  `status=open`), open to any eligible subject.
- `GET /procurement/rfqs/mine` — the caller's own RFQs, all statuses.
- `GET /procurement/rfqs/:id` — detail, including `quote_count` and (for
  an organization caller) `my_quote`.
- `POST /procurement/rfqs/:id/cancel` — requester-only, only while `open`.
- `GET /procurement/rfqs/:id/quotes` — requester-only, full quote list.
- `POST /procurement/rfqs/:id/quotes/:quoteId/accept` — requester-only;
  sets the chosen quote `accepted`, every other `submitted` quote on that
  RFQ `rejected`, and the RFQ `awarded` — all in one transaction.
- `POST /procurement/rfqs/:id/quotes` — organization-only, upserts.
- `GET /procurement/quotes/mine?status=` — organization-only, the
  caller's own submitted quotes.
- `POST /procurement/quotes/:quoteId/withdraw` — organization-only
  (responder), only while `submitted`.

Frontend: a full RFQ section (post / my RFQs / browse open RFQs / accept /
cancel, plus submit-quote / my quotes / withdraw for organizations) was
added to four portals — the ones reachable with a working login in this
sandbox and the one the user explicitly named:

- **Cooperative** (`frontend/coop/dashboard.html`/`js/dashboard.js`) —
  explicit user requirement ("ให้อยู่ใน SaaS ของสหกรณ์ด้วย").
- **Buyer** (`frontend/buyer/dashboard.html`/`js/dashboard.js`).
- **InputSupplier**
  (`frontend/inputsupplier/dashboard.html`/`js/dashboard.js`).
- **Farmer** — a new standalone page, `frontend/rfq.html`/`js/rfq.js`
  (linked from the farmer dashboard's top nav as "ตลาดขอใบเสนอราคา
  (RFQ)"), mirroring `marketplace.html`'s existing standalone-page
  pattern. The quote-submission UI is hidden here — farmers post/browse/
  cancel/accept, they don't quote (see the design decision above).

All four share the same `refreshRfq()`/card-rendering JS shape (only the
API client variable and DOM-id prefix differ), and every one hides the
"my quotes" section automatically when the logged-in subject isn't an
organization, so the exact same markup works for both the always-org
portals and the farmer page.

Not yet wired to a UI: **Lender, Machinery, MarketVenue,
FertilizerMixingService, Admin, and Gov** portals. The backend endpoints
already accept any verified-organization JWT regardless of role type, so
those portals could add the identical section later with no backend
changes — this is a UI coverage gap, not a backend limitation.

## AgroLink B2B Commerce Engine — e-Auction + Contract + Purchase Order

Phase 2 of the RFQ marketplace above, evolving it from a single "post a
need, accept a quote" step into a real B2B transaction chain: **RFQ →
e-Auction (optional) → Contract (auto-generated) → Purchase Order**. Full
design rationale, the whole 11-stage target pipeline (through Logistics,
GRN, Invoice, Payment, Revenue Sharing), and the reuse-before-rebuild
analysis of every existing table this reuses live in
`B2B_COMMERCE_ENGINE_ARCHITECTURE.md` at the repo root. This section
covers only what's actually built and running as of Phase 2 — **see "AgroLink
B2B Commerce Engine — Phase 3" below for GRN, Invoice, Payment, and Revenue
Sharing**, all of which are now built too (the "roadmap, not built" line
above described this Phase-2-era state, not the current one).

Schema: `backend/db/grant_b2b_commerce_engine.sql` — three additions to
the existing `procurement`/`contract` schemas, no new top-level schema:

- **`procurement.auction` / `procurement.auction_bid`** — a reverse
  (descending-price) auction opened on top of one of the caller's own
  open RFQs (`POST /procurement/auctions`, one auction per RFQ). Bidding
  orgs see the current lowest bid and how many bids exist, but never each
  other's identity (sealed-bidder design) until the requester closes the
  auction — only then does `GET /procurement/auctions/:id/bids`
  (requester-only) reveal every bidder. A new bid must be **strictly
  lower** than the current lowest (enforced at the application layer via
  a `MIN()` query — not expressible as a plain `CHECK` constraint).
  Closing has no cron job: `ensureAuctionSettled()` runs a lazy-expiry
  check at the top of every auction read/write, so an auction past its
  `closes_at` self-settles the moment anyone next touches it (or the
  requester can close early via `POST /procurement/auctions/:id/close`).
  Once an auction exists for an RFQ, direct quoting on that RFQ
  (`POST /procurement/rfqs/:id/quotes`) is blocked (`409
  rfq_has_auction`) — the two award mechanisms don't run concurrently on
  the same RFQ.
- **`procurement.create_contract_from_award()`** — a `SECURITY DEFINER`
  function (same pattern as the pre-existing
  `underwriting.approve_application()`) called by BOTH award paths
  (direct quote-accept and auction-close, via a shared
  `awardRfqToResponder()` helper) that writes a real
  `contract.contract` + `contract.contract_party` pair, reusing the
  contract machinery originally built for loans — `forward_purchase`/
  `service_agreement`/`input_supply_agreement` were already valid
  `contract_type` values, just never had a non-loan caller until now.
  `contract_party.party_role` was widened to add `'seller'` (for a
  produce/processed_good/other responder — the one case no existing role
  fit). These contracts are created directly at `status = 'active'`, not
  `'draft'` — deliberate: no signature/activation endpoint exists
  anywhere in this codebase for ANY contract type (loan contracts
  included), and an RFQ/auction award already represents a completed
  mutual agreement (price and quantity settled through competition), so
  skipping an unreachable draft phase is what makes the next stage
  actually usable. The awarding auction bid is also written back as an
  `rfq_quote` row (`status = 'accepted'`) so `rfq.awarded_quote_id` — an
  FK that can only point at `rfq_quote`, not `auction_bid` — stays
  meaningful regardless of which mechanism produced the win.
- **`procurement.purchase_order`** — issued against an `active` contract
  by whichever party is on the "wants the goods" side
  (`PO_ISSUER_ROLES = ['farmer', 'buyer']`; a contract can be drawn down
  over several POs, this endpoint does not track cumulative quantity
  against `agreed_quantity`). The other party acknowledges it
  (`POST /procurement/purchase-orders/:id/acknowledge`); either party can
  cancel while `issued`/`acknowledged`.

Backend: all of this lives in `src/routes/procurement.js` alongside the
RFQ routes above (same file, same `requireAuth`-only + per-handler
subject-type branching convention):

- `POST /procurement/auctions`, `GET /procurement/auctions?status=`,
  `GET /procurement/auctions/mine`, `GET /procurement/auctions/:id`,
  `POST /procurement/auctions/:id/bids`,
  `GET /procurement/auctions/:id/bids`,
  `POST /procurement/auctions/:id/close`.
- `GET /procurement/contracts/mine` — every contract the caller is a
  party to via an RFQ/auction award, any role (unlike `GET
  /buyer/contracts`/`GET /farmer/contracts`, which only return the
  `'buyer'`/`'farmer'` rows) — backs the frontend's PO screen.
- `POST /procurement/purchase-orders`,
  `GET /procurement/purchase-orders/mine`,
  `POST /procurement/purchase-orders/:id/acknowledge`,
  `POST /procurement/purchase-orders/:id/cancel`.

Frontend: added to the **Cooperative** and **Buyer** dashboards at first
(same two portals as the RFQ section, minus InputSupplier/Farmer for this
pass — extended to **InputSupplier** in Phase 3 below, see that section).
Each RFQ card the caller owns shows either a "🏆 เปิดประมูล (e-Auction)"
button (if still `open` with no auction yet) or a live auction-status
badge — `auctionMineByRfqId` is loaded before the RFQ cards render so this
never offers to open a duplicate auction. Three new sections sit below the
existing RFQ UI: "การประมูลของฉัน" (my auctions, with a bid-history
toggle and manual-close button), "ประมูลที่เปิดอยู่" (browse + bid on
others' open auctions), "สัญญา" (every contract the caller is a party
to, with an "ออกใบสั่งซื้อ" button on the ones they can issue a PO
against), and "ใบสั่งซื้อ" (every PO, with acknowledge/cancel actions
shown only to the side actually eligible for them).

## AgroLink B2B Commerce Engine — Sealed-Bid Auction Mode (2026-08-22)

A second e-Auction mode alongside the "sealed-bid-lite" one described above.
No new tables — `backend/db/grant_sealed_bid_auction.sql` adds one column,
`procurement.auction.bid_visibility text NOT NULL DEFAULT 'live' CHECK (IN
('live', 'sealed'))`. Every existing/previously-created auction defaults to
`'live'`, i.e. exactly the behaviour documented in the section above,
unchanged — this migration is purely additive and was regression-tested
against that unchanged behaviour (see "End-to-end verification performed"
below).

`'sealed'` (chosen by the requester at `POST /procurement/auctions` time via
`{ bid_visibility: 'sealed' }`) is a genuinely sealed bid, per an explicit
product request: while the auction is `open`, **no price is ever exposed to
anyone** — not the bidders, not spectators, and not even the requester who
created the auction (this last part is a deliberate design choice beyond
what was literally asked: hiding price from the requester too, not just
bidders, is what stops the requester from tipping off a favoured bidder
mid-auction, which is how a real sealed tender works). Concretely:

- `GET /procurement/auctions`, `/auctions/mine`, and `/auctions/:id` all
  omit `current_lowest_bid`/`my_lowest_bid` for a `sealed`+`open` auction.
  `bid_count` stays visible in both modes (it's an activity count, not a
  price). An organization caller hitting the detail endpoint gets
  `my_status: 'leading' | 'not_leading' | 'no_bid_yet'` instead of
  `my_lowest_bid`.
- `POST /procurement/auctions/:id/bids` drops the `'live'` mode's "must
  strictly beat the current lowest" rejection entirely for `sealed`
  auctions — a bidder who can't see the current lowest has nothing to beat
  against, and rejecting would itself leak "you weren't competitive". Every
  positive-price bid is accepted, and a bidder may resubmit as many times
  as they like before `closes_at`, at any price (better or worse than their
  own last attempt — nothing is validated against price history). The
  response is `{ bid_id, auction_id, submitted_at, is_leading }` — **no
  price field at all**, not even the price the caller themselves just
  submitted. `is_leading` is computed by `computeLeadingStatus()`, which
  runs the *exact same* `ORDER BY bid_price ASC, submitted_at ASC LIMIT 1`
  query `closeAndAwardAuction()` uses to pick the real winner, so the live
  indicator shown mid-auction can never disagree with the eventual
  auto-award — verified directly in the E2E test (the historically cheapest
  bid after close was the same one every intermediate `is_leading: true`
  response had pointed to).
- Once the auction closes/is awarded, prices reappear exactly the way they
  already do for `'live'` auctions: `current_lowest_bid` returns in the
  summary/detail endpoints, and the existing requester-only
  `GET /procurement/auctions/:id/bids` full-history endpoint (bidder
  identity + price, ordered cheapest-first) needed **zero changes** — it
  was already gated to fire only for the auction's own requester, matching
  the reveal-only-after-award pattern this codebase already uses for direct
  RFQ quotes.
- `closeAndAwardAuction()` and `ensureAuctionSettled()` (lazy-expiry
  auto-close, no cron job) also needed **zero changes** — they already pick
  the winner from `procurement.auction_bid` by lowest price regardless of
  mode; the only thing that differs between `'live'` and `'sealed'` is who
  gets to see prices while the auction is still running.

**Not built in this pass:** a dashboard UI for choosing `bid_visibility` at
auction-creation time or for showing the `is_leading`/`my_status` indicator
— the existing e-Auction UI described in the section above lives in
dashboard page files that weren't part of this working session, so this
round shipped API-only, verified end-to-end with a raw-`fetch()` test
script (see below) rather than through the dashboard. The API is fully
backward-compatible and ready for a UI pass whenever those page files are
available to edit.

**Full design rationale:** `B2B_COMMERCE_ENGINE_ARCHITECTURE.md` §4.4a at
the repo root, and the header comment in
`backend/db/grant_sealed_bid_auction.sql`.

## AgroLink B2B Commerce Engine — Phase 3: GRN, Invoice, Payment, Revenue Sharing

Phase 3 of the same pipeline, closing the loop from "we have a Purchase
Order" all the way to "money actually moved and, if the seller is a
cooperative, got redistributed to the member farmers who supplied the
goods": **Purchase Order → Goods Receipt Note (GRN) → Invoice → Payment
(via the existing ledger) → Revenue Sharing (cooperative sellers only)**.
Design rationale and the full draft-vs-built comparison live in
`B2B_COMMERCE_ENGINE_ARCHITECTURE.md` §4.8–4.11. This section covers what's
actually built, running, and verified end-to-end against the live database.

Schema: `backend/db/grant_b2b_commerce_engine_phase3.sql` — three new
tables plus one column addition to two Phase-2 tables, no new top-level
schema:

- **`procurement.goods_receipt`** — recorded by whichever party **issued**
  the PO (`PO_ISSUER_ROLES = ['farmer', 'buyer']`), confirming what was
  actually received against it: `received_quantity` /
  `accepted_quantity` / `rejected_quantity` (+ `rejection_reason`),
  constrained so accepted+rejected never exceeds received. One GRN per PO
  (`uq_grn_po`); recording it flips the PO to `in_fulfillment`
  immediately, so a second attempt is rejected at the status-guard layer
  (`409 po_not_acknowledged`) before it can ever reach the DB's unique
  constraint — a real race (two concurrent inserts) is still caught by
  the constraint itself.
- **`procurement.invoice`** — issued by the **other** contract party (the
  seller) once a GRN with `accepted_quantity > 0` exists; `amount` is
  computed server-side as `grn.accepted_quantity * po.unit_price`, never
  taken from client input. `procurement.pay_invoice(p_invoice_id,
  p_payer_subject_type, p_payer_subject_id, p_payer_unit_id)` mirrors
  `produce.settle_delivery()` / `marketplace.complete_service_request()`
  exactly: lock the row, call `ledger.transfer_funds()`, flip to `paid`.
  `p_payer_unit_id` is **required** when the payer is a farmer (a clear
  `409` if omitted) — a farmer pays from their own
  `unit_wallet` ledger account, not a generic personal balance. Paying
  the invoice also checks whether every PO on the parent contract now has
  `accepted_quantity` summing to the full `agreed_quantity`; if so the
  contract auto-completes (`status = 'completed'`) — verified against
  both a partial-acceptance case (stays `active`) and a full-acceptance
  case (flips to `completed`). `POST /invoices/:id/dispute` exists
  (moves to `disputed`) but there's no further resolution workflow yet —
  see "Next steps" below. `POST /invoices/:id/cancel` works pre-payment
  only. A genuine duplicate `POST /invoices` against the same `po_id`
  (unlike GRN, issuing an invoice doesn't change PO status, so a second
  attempt really does reach the insert) correctly hits `uq_invoice_po` →
  `409 invoice_already_exists`.
- **`procurement.rfq_quote.lot_id`** / **`procurement.auction_bid.lot_id`**
  — the seller's own quote/bid now optionally links to one of their
  `produce.lot` rows (only when `rfq.category = 'produce'`, and only a
  lot the responding org actually owns — `403 lot_not_owned` otherwise).
  **This lives on the seller's offer, not the RFQ itself** — an
  architecture correction made during design, before any code was
  written: `create_contract_from_award()` always assigns the RFQ
  requester the `'buyer'` party role and the award winner the `'seller'`
  role, and both `pay_invoice()` and `create_revenue_share_plan()` below
  resolve the payee cooperative from the `'seller'` party. Tagging
  `lot_id` on the RFQ (the requester's side) would have sent revenue-share
  money to whoever won the bid — an unrelated org — instead of to the
  cooperative that actually owns the sold lot.
- **`procurement.revenue_share_plan`** / **`procurement.revenue_share_line`**
  — for produce sales where the seller is a Cooperative:
  `create_revenue_share_plan(invoice_id)` (callable once `invoice.status
  = 'paid'`) resolves the sold lot via `rfq.awarded_quote_id →
  rfq_quote.lot_id`, then computes each contributing production unit's
  share from `SUM(quantity_ton) GROUP BY unit_id FROM produce.delivery
  WHERE lot_id = X AND status = 'settled'` — no manual percentage entry.
  `distribute_revenue_share(plan_id)` transfers each line's amount from
  the cooperative's `vendor_settlement` account to the unit's
  `unit_wallet`, **one `BEGIN...EXCEPTION WHEN OTHERS...END` block per
  line** (a PL/pgSQL implicit savepoint) so one farmer's failed transfer
  (e.g. no `unit_wallet` yet) doesn't roll back the others — that line is
  marked `failed` with a `failure_reason` and the rest proceed.

Backend: all of this lives in `src/routes/procurement.js` alongside the
RFQ/auction/PO routes above (same file, same conventions):

- `POST /procurement/goods-receipts`, `GET /procurement/goods-receipts/mine`.
- `POST /procurement/invoices`, `GET /procurement/invoices/mine`,
  `POST /procurement/invoices/:id/pay`,
  `POST /procurement/invoices/:id/dispute`,
  `POST /procurement/invoices/:id/cancel`.
- `POST /procurement/revenue-share-plans`,
  `GET /procurement/revenue-share-plans/mine`,
  `POST /procurement/revenue-share-plans/:id/distribute`.
- `POST /procurement/auctions/:id/close` now also returns `contract_id` in
  its response (a small Phase-2 gap — the direct-quote-accept path already
  surfaced it, the auction-close path didn't).

Frontend: GRN + Invoice UI added to **Cooperative**, **Buyer**, and
**InputSupplier** dashboards, folded into each PO card (expand a PO to see
its GRN summary/form and invoice summary/issue/pay/dispute/cancel
actions, gated to whichever side is actually eligible for each action).
Revenue Sharing UI ("💰 กระจายรายได้คืนสมาชิก") added to the
**Cooperative** dashboard only, since it's the only portal that can be
the seller-side cooperative in this flow. The e-Auction + Contract + PO
UI from Phase 2 (previously Cooperative/Buyer only) was also extended to
the **InputSupplier** dashboard in this pass, closing that Phase-2 gap —
InputSupplier is typically the input_product *seller*, so this mainly
surfaces auctions to bid on, awarded contracts, and POs/invoices from the
seller's side.

**End-to-end verification performed:** three complete chains run as real
HTTP requests against the running server and the live database (not
mocks) — (1) an organization Buyer accepts a Cooperative's produce quote
directly → PO → GRN → Invoice → real payment → revenue-share plan → real
payout split across 2 production units by delivered tonnage; (2) the same
chain via e-Auction close instead of direct quote-accept; (3) a farmer
issues their own PO for input_product, pays the resulting invoice from
their `unit_wallet` (no revenue sharing on this path — the seller is an
InputSupplier, not a cooperative). All three inspected the resulting
`ledger.journal_entry`/`journal_line` rows directly to confirm correct,
balanced debit/credit amounts — not just that the API returned 200.
Contract auto-completion was checked against both a partial-acceptance
(stays `active`) and full-acceptance (`completed`) case. The InputSupplier
UI addition was verified with a headless-browser pass (no page errors,
correct rendering of real contract/PO/GRN/invoice data through the new
sections). All test data created for this (one throwaway Cooperative org,
4 produce lots, 8 settled deliveries, 9 RFQs and everything auto-created
from them, and 15 ledger entries) was deleted afterward — nothing test-only
was left in the database.

## Farmer 360° View — cross-organization farmer profile (consent-free MVP)

A farmer in the real world is often simultaneously a member/customer of
several separate organizations at once — a Cooperative, BAAC or another
Lender, a Village Fund (กองทุนหมู่บ้าน) — and none of those organizations
could previously see anything about the farmer's relationships elsewhere.
This feature gives staff at ANY verified organization a consolidated
"360°" view of a farmer, scoped per organization so each org sees only
what it's entitled to. Full design rationale, the visibility-rules table,
and the Phase 2 (consent + credit score) roadmap all live in
`FARMER_360_ARCHITECTURE.md` at the repo root — this section is the
implementation summary.

**This is an explicit MVP scope, decided 2026-08-17**: membership + land +
transactions only. No consent workflow, no credit-score sharing — both
deferred to Phase 2 (see the architecture doc §5). The visibility rules
this pass enforces:
- **Basic identity + land**: shown in full to ANY org with an active
  relationship to the farmer.
- **Other orgs' membership**: shown as name + type only (e.g. "สหกรณ์ A
  (สมาชิกสหกรณ์)") — existence, not financial detail. This is the actual
  "360°" value (a Lender can see a farmer already has a Village Fund
  relationship) without leaking anything sensitive, since there's no
  consent system yet to gate a deeper share.
- **Transactions**: visible ONLY between the farmer and the VIEWING org
  itself — never another org's amounts. Enforced at the query level (every
  transaction sub-query filters on both `farmer_id` AND the caller's own
  `org_id`), not just in the response shape.
- **Credit score**: NOT included this pass at all (`credit_score: null`,
  `credit_score_available_in_next_phase: true` in every response) —
  `risk.credit_score`'s RLS has no policy for organization subjects, and
  that's a deliberate pre-existing product decision this pass does not
  route around.

**Schema** (`backend/db/grant_farmer_360.sql`):
- `identity.farmer_org_relationship (relationship_id, farmer_id, org_id, relationship_type, status, joined_at, ended_at, created_by_subject_type, created_by_subject_id, notes)`,
  `UNIQUE(farmer_id, org_id)` — the "membership roster" concept that never
  existed anywhere in the schema before this feature (`identity.organization_member`
  is a staff/signatory table, not a farmer roster, and
  `registry.cooperative_profile.member_count_reported` is explicitly
  self-reported — see that column's own comment).
- `identity.link_farmer_to_org(p_farmer_id, p_org_id, p_created_by_subject_type, p_created_by_subject_id, p_notes)` —
  the only way a relationship row gets created. `relationship_type` is
  derived server-side from the org's own `org_type` (Cooperative →
  `CooperativeMember`, VillageFund → `VillageFundMember`, Lender/Bank →
  `LoanCustomer`, else `Other`) — never taken from the client. Reactivates
  an `ended` relationship on conflict rather than erroring.
- `identity.unlink_farmer_from_org(p_farmer_id, p_org_id)` — soft-delete
  (`status = 'ended'`), row kept for history.
- `identity.sync_farmer_relationships_from_transactions(p_org_id, p_created_by_subject_type, p_created_by_subject_id)` —
  bulk-creates relationship rows for every farmer who already has a real
  transaction with the calling org (produce delivery / loan application /
  product order / machinery booking) but no roster row yet. Solves the "no
  real member import exists" gap `cooperative_profile`'s own comment
  already admitted, for every org type at once, not just cooperatives.
- `identity.farmer.farmer_code` ("AgroLink ID", format `AF-000001`) — new
  public-facing farmer identifier. Backfilled deterministically
  (`ROW_NUMBER() OVER (ORDER BY created_at, farmer_id)`, not a bulk
  `nextval()` update, since Postgres doesn't guarantee row order for
  that), then a sequence + `BEFORE INSERT` trigger continues numbering new
  farmers.

**Backend** (`src/routes/farmer360.js`, mounted at `/farmer360`, generic
across ANY verified organization — same "own prefix, not portal-scoped"
convention as `procurement.js`, since the real security boundary is "does
my org have an active relationship with this farmer," not the org's
`org_type`):
- `GET /farmer360/search?code=AF-000001` or `?phone=+66...` — exact-match
  only, by design (deliberately no partial/name search, so this endpoint
  can never be used to browse the farmer table). Returns only a minimal
  preview (`farmer_id`, `farmer_code`, `full_name`) — not the full 360
  view, which still requires an actual relationship.
- `POST /farmer360/relationships` — body `{ farmer_id }` → adds a
  found farmer as a member/customer of the calling org.
- `POST /farmer360/relationships/sync` — bulk-import via
  `identity.sync_farmer_relationships_from_transactions()`, returns
  `{ linked_count }`.
- `GET /farmer360/relationships/mine` — the calling org's own roster.
- `DELETE /farmer360/relationships/:farmerId` — ends the relationship.
- `GET /farmer360/:farmerId` — the 360 view itself. `403
  no_relationship_with_farmer` (deliberately 403, not 404 — `farmer_id` is
  a UUID, not a guessable sequential id, so there's little to protect by
  hiding existence; 403 is the more honest signal that this is a
  permission wall) unless the calling org has an active relationship row.

**Portals**: the feature is wired into THREE portals simultaneously (per
the 2026-08-17 product decision to launch across all org types at once,
not stagger by type) — the existing Cooperative Portal
(`frontend/coop/`) and Lender Portal (`frontend/lender/`, standing in for
"Bank" since it's the only bank-like org type with an existing portal),
plus a brand-new **VillageFund Portal** (`frontend/villagefund/`,
built from scratch this pass — `index.html`/`dashboard.html`/`js/api.js`/
`js/login.js`/`js/dashboard.js`, ~620 lines total, same structure as every
other single-purpose portal in this codebase). Each portal's dashboard
gained a search/add/sync/roster UI with an expand-inline "ดูข้อมูล 360°"
detail view — same expand-inline pattern already used for PO/GRN/invoice
detail in the B2B Commerce Engine UI above, no modal pattern exists in
this codebase.

`VillageFund` was added to `ORG_SELF_REGISTER_TYPES` (`auth.js`),
`ORG_REQUESTABLE_ROLE_TYPES` (`organization.js`), the org-type dropdown on
`register-provider.html` (with the matching auto-login-and-redirect
branch in `js/register-provider.js`, same as `Lender`/`Buyer`/
`InputSupplier`), and the session-key list in `js/manage-roles.js` — see
"Multi-role organizations" above and "what's mocked" below for why
self-registration (rather than a new admin-creation endpoint) was the
chosen onboarding path.

**Verified**: a 16-assertion end-to-end script covering the full flow
(VillageFund self-registration → pre/post-KYB dashboard gating → admin KYB
approval → farmer search by code/phone → 360-view-blocked-without-
relationship → linking to two different orgs simultaneously → cross-org
membership visibility confirmed BOTH directions (a Lender and a
VillageFund, both linked to the same farmer, each see the OTHER org's
membership badge but 0 transaction amounts for the other org's dealings)
→ credit-score withholding → roster listing → idempotent sync → unlink +
re-block → non-organization-subject rejection) — all 16 assertions
passed. Each of the three portals' Farmer 360 UI was additionally verified
with a real headless-browser pass (search → add → expand 360 detail →
unlink, against live seeded data, no JS errors). All test data (throwaway
VillageFund/Cooperative orgs, relationship rows) was deleted afterward.

**Farmer-facing counterpart ("สมาชิกภาพของฉัน" / "My Memberships"), added
same day:** the Farmer Portal's own dashboard (`frontend/dashboard.html`)
gained a read-only section listing the farmer's OWN active relationships —
`GET /farmer/memberships` (see above), rendered as a card list right below
the account summary, above the credit-score panel (matching the original
mockup's ordering: identity → membership badges → land → credit). This is
NOT the org-facing Farmer 360 view — it's deliberately minimal (org name +
type + joined date, no transaction detail, no per-org access controls) —
but it's the natural seed for the Phase 2 consent screen, where the farmer
will need exactly this list to grant/revoke access per org. Verified with
a dedicated backend test (farmer sees 0 memberships before linking, sees
the correct org name/relationship_type/joined_at after an org links them,
a non-farmer JWT gets `403`, list goes back to empty after unlink — 8
assertions, all passed) plus a headless-browser pass confirming the UI
renders the org name and Thai relationship-type label correctly. Test data
was deleted afterward.

## What's mocked / simplified (be aware of this before relying on it)

- **OIDC verification is stubbed.** `POST /auth/login` trusts whatever
  `external_subject_claim` string the caller sends — it does **not** verify
  a real signed OIDC token against an IdP's JWKS, because no IdP is
  connected in this sandbox. In production, an upstream gateway or this
  service must verify the token signature/issuer/audience/expiry before
  ever trusting the `sub` claim. Everything downstream of that point
  (claim → internal identity resolution, JWT issuance, RLS enforcement,
  audit logging) is real, tested, working code — only the "is this claim
  actually attested by a real login" step is out of scope for this sandbox.
- **`notification.notification_log` has no row-level security at all**
  (`pg_class.relrowsecurity = false`), unlike `risk.credit_score`,
  `underwriting.loan_application`, and `contract.contract`, which are
  `FORCE ROW LEVEL SECURITY` and scope rows to the caller automatically.
  `GET /farmer/notifications` is the *only* thing standing between a farmer
  and every other subject's notifications — its explicit
  `WHERE subject_type = 'farmer' AND subject_id = $1` is not
  defense-in-depth, it is the actual security boundary. Hardening this
  properly (enabling RLS on `notification.notification_log`, mirroring the
  pattern already used elsewhere) is a good candidate for a future layer.
- **Secrets in `.env`.** `JWT_SECRET` and the `agrolink_backend` DB password
  are plain values in a checked-in-looking `.env` file, appropriate only for
  this sandbox. Production needs a real secret manager and credential
  rotation.
- **Single lender/buyer org used in testing.** Only one `Lender`-type
  (`สหกรณ์สินเชื่อเกษตรยั่งยืน จำกัด`) and one `Buyer`-type
  (`โรงสีข้าวไทยเจริญ จำกัด`) organization exist in the seed data, so
  multi-lender/multi-buyer scenarios weren't exercised against seed data —
  a second, temporary org of each type was inserted and removed specifically
  to verify cross-organization isolation (see below), rather than being
  left in the seed data permanently.
- **`produce.delivery` has no row-level security at all**
  (`pg_class.relrowsecurity = false`), same situation as
  `notification.notification_log` above but for the Buyer Portal: unlike
  `underwriting.loan_application` and `contract.contract`, there is no
  database-level backstop scoping a delivery to its `buyer_org_id`. Every
  query in `src/routes/buyer.js` that touches `produce.delivery` therefore
  has an explicit `WHERE buyer_org_id = $1` — not defense-in-depth, the
  actual security boundary. Verified against a real second Buyer org (see
  below).
- **`confirm_quality()`/`settle_delivery()` don't check ownership
  themselves either**, and unlike `approve_application()`/
  `decline_application()` there's no RLS at all on `produce.delivery` to
  even theoretically fall back on. `src/routes/buyer.js` closes this the
  same way as the Lender Portal: every confirm-quality/settle request first
  re-reads the delivery with an explicit `WHERE buyer_org_id = $1`, and
  404s before ever calling the function if that read finds nothing.
- **`marketplace.service_listing` and `marketplace.vendor_photo` have no
  row-level security at all** (`pg_class.relrowsecurity = false`), same
  situation as `notification.notification_log`/`produce.delivery` above but
  for the Machinery/Drying-Yard Portal. Every query in
  `src/routes/machinery.js` therefore has an explicit `WHERE org_id = $1` —
  not defense-in-depth, the actual security boundary.
- **No object storage/CDN for photos.** `POST /machinery/photos` stores
  each photo as a base64 `data:` URL directly in
  `marketplace.vendor_photo.photo_data_url` — workable for a demo at a
  handful of photos per provider, but a real deployment needs S3/GCS behind
  a CDN, with only the resulting URL kept in Postgres. The ~3MB
  per-photo/5MB request-body caps in `src/routes/machinery.js` and
  `src/server.js` exist specifically to keep this workable in the meantime,
  not as a real upload limit design.
- **`marketplace.service_request` (the farmer-facing booking half of the
  marketplace) is not wired up to any route yet.** The table already exists
  in the schema and this session opened up `marketplace.service_listing`
  and added `service_key`/`vendor_photo` for the *provider* side (setting
  prices, uploading photos — this is what a farmer would browse), but there
  is currently no `GET /farmer/machinery-services` or
  `POST /farmer/machinery-services/:listing_id/request` endpoint for a
  farmer to actually discover and book one. A provider can fully manage
  their rate card and gallery today; nothing yet reads that data back out
  on the farmer side.
- **Registration has no KYC step.** `POST /auth/register` sets
  `status='pending_kyc'` but nothing currently transitions a farmer out of
  that status — there is no verification workflow yet (real deployments
  would check the national ID against an actual ID-verification service
  before activating the account).
- **`approve_application()`/`decline_application()` don't check ownership
  themselves.** Making them `SECURITY DEFINER` (see
  `fix_underwriting_decision_security.sql`) only fixes the RLS-vs-grants
  mechanics; neither function checks that the caller's org actually owns
  the application's `lender_org_id` — only that the application's *status*
  is `approved`/`manual_review`. `src/routes/lender.js` closes this gap
  itself: every approve/decline request first re-reads the application
  through the caller's own RLS-scoped session, which the existing
  `lender_own_applications` policy already narrows to rows this lender
  owns. Zero rows → 404, before the function is ever called. This was
  verified against a real second Lender organization, not just reasoned
  about (see below).
- **Platform Ops has no per-admin identity, only a shared passcode.** See
  `POST /auth/admin-login` above — there is no individual ops-account
  table, no MFA, no real SSO. `audit.access_log` can show that *a* platform
  operator acted, never *which one*. This is the single biggest gap in the
  admin slice and is called out explicitly rather than glossed over: a
  real deployment must not ship this as-is.
- **`POST /auth/org-register` excludes `Bank`, `Cooperative`, and `Mill`
  from self-service sign-up.** `ORG_SELF_REGISTER_TYPES` in
  `src/routes/auth.js` deliberately leaves these three out of the selectable
  list. `Bank` reads as an institutional/government-linked entity that
  wouldn't plausibly sign up through a public web form in a real
  deployment. `Cooperative`/`Mill` were removed later, on 2026-07-24,
  per an explicit product decision (not an architectural one — both are
  otherwise completely ordinary private-business categories, same shape as
  `Logistics`, which is still self-registerable). `POST /organization/roles`
  (self-service *additional*-role requests, see "Multi-role organizations"
  below) excludes the same three types from `ORG_REQUESTABLE_ROLE_TYPES` in
  `src/routes/organization.js`, kept in lockstep with the registration list
  by convention (the two lists are separate on purpose, but have always been
  kept identical in practice — see that file's own comment). There is
  currently no other onboarding path for any of these three types at all
  (they can still only be created directly, e.g. seeded — `Cooperative`
  being the one exception, provisioned via `POST /admin/cooperatives`, see
  that endpoint's own doc comment), which is a real gap if AgroLink ever
  needs to onboard `Bank` or `Mill` — just a deliberately out-of-scope one
  for now.
  `VillageFund` was REMOVED from both exclusion lists on 2026-08-17 (it is
  now both self-registerable and self-requestable, same as `Lender`/`Buyer`/
  etc.) specifically to unblock the Farmer 360° View feature — see
  "Farmer 360° View" below and `FARMER_360_ARCHITECTURE.md` §6 for the full
  reasoning (no admin-side org-creation endpoint exists for it, unlike
  `Cooperative`, so self-registration was the only low-cost path).
- **`business_registration_no` is assumed equal to `tax_id`.**
  `POST /auth/org-register` only collects one number (`tax_id`) but
  `partner.vendor_profile.business_registration_no` is a real, distinct
  field in the schema — a real deployment would collect both separately.
  Using the same value for both here is a deliberate simplification to
  keep the registration form to three fields, matching what the user asked
  for; it means a real business with a genuinely different registration
  number would need this corrected later (e.g. by platform ops, out of
  band — there's no edit endpoint for `vendor_profile` fields yet).
- **KYC/KYB decisions don't check for a stale/already-decided state before
  overwriting it.** `POST /admin/farmers/:id/status` and `POST
  /admin/organizations/:id/kyb-status` will happily flip an already-`active`
  farmer back to `pending_kyc`, or an already-`Verified` org back to
  `Pending`, if asked — there's no guard against a confusing or
  nonsensical transition (e.g. re-rejecting an already-rejected farmer).
  This mirrors real moderation tools that trust the operator's judgment
  over a rigid state machine, but is worth knowing before assuming the API
  enforces a particular KYC/KYB lifecycle graph.
- **`marketplace.product_listing` and `marketplace.product_photo` have no
  row-level security at all** (`pg_class.relrowsecurity = false`), same
  situation as `service_listing`/`vendor_photo` above but for the
  InputSupplier Portal. Every query in `src/routes/inputsupplier.js`
  therefore has an explicit `WHERE org_id = $1` — not defense-in-depth, the
  actual security boundary. `marketplace.buy_price_quote` is the same way.
- **`marketplace.product_order` has no row-level security either.** Same
  situation, just for the farmer ordering flow — `src/routes/farmer.js`
  scopes every order query with an explicit `WHERE farmer_id = $1`, and
  `src/routes/inputsupplier.js` with `WHERE org_id = $1`; neither is
  defense-in-depth.
- **No payment/settlement is wired into the order flow.** `POST
  /inputsupplier/orders/:id/fulfill` just marks that the supplier says they
  handed the goods over — unlike `POST /buyer/deliveries/:id/settle`, no
  `ledger.transfer_funds()` call happens anywhere in this lifecycle. See
  "Farmer ordering flow" above for the full reasoning; a real deployment
  needs to decide how payment for these orders actually happens.
- **No quantity/stock tracking on the catalog.** A supplier can receive
  more orders for a product than they can actually fulfill — `unit_price`
  and availability are not decremented by an order, there's no inventory
  count anywhere in `marketplace.product_listing`. A real deployment would
  need real stock management, or at minimum a manual "mark as unavailable"
  step a supplier remembers to do themselves.
- **No historical price archive for rice-buying-price quotes.**
  `marketplace.buy_price_quote` only stores each buyer's *current* price
  per grade (upserted in place) — there is no day-by-day history table, so
  neither buyers nor farmers can see how a price has moved over time, only
  today's live number and its `updated_at` timestamp.
- **Awarding an RFQ (direct accept or auction close) creates a contract,
  not yet a fulfillment record.** Award auto-creates a real
  `contract.contract` row and the requester can issue a Purchase Order
  against it — but a PO still does not auto-create a `produce.delivery`
  or `marketplace.product_order` row (GRN is the org↔org equivalent of
  `produce.delivery` and IS built now, see the Phase 3 section above —
  this bullet is about the two staying separate concepts, not GRN being
  missing).
- **A PO does not track cumulative quantity against its contract.**
  `POST /procurement/purchase-orders` lets the same active contract have
  multiple POs issued against it without checking their combined quantity
  against `contract.agreed_quantity` — same "no stock/quantity
  enforcement" gap `marketplace.product_order` already has elsewhere in
  this codebase. (Contract *completion* does check cumulative GRN
  acceptance across all the contract's POs, see Phase 3 above — this
  bullet is specifically about PO *issuance* not checking against it.)
- **Invoice disputes have no resolution workflow.** `POST
  /invoices/:id/dispute` moves an invoice to `disputed` and that's the
  end of it — no renegotiate/re-issue/admin-arbitration path exists yet.
- **RFQ/e-Auction/PO/GRN/Invoice UI exists on four (RFQ) / three
  (e-Auction+PO+GRN+Invoice) portals only.** RFQ: Cooperative, Buyer,
  InputSupplier, and the Farmer top-level nav. e-Auction + Contract +
  Purchase Order + GRN + Invoice: Cooperative, Buyer, and InputSupplier.
  Revenue Sharing: Cooperative only (by design — it's the only portal
  that can be the seller-side cooperative). Lender, Machinery,
  MarketVenue, FertilizerMixingService, Admin, and Gov have none of it,
  even though the backend already accepts a verified-organization JWT of
  any role type for all of it. Purely a UI coverage gap — adding any of
  these sections to another portal needs no backend change.

## End-to-end verification performed

All of the below were run as real HTTP requests against the running server
and the live `agrolink_test` database — not unit tests against mocks:

- Logged in as all three seeded farmers via their real `auth_subject_id`
  values (สมชาย = `oidc|farmer-001`, สมหญิง = `oidc|farmer-002`,
  ประยุทธ = `oidc|farmer-003`); an unrecognized claim correctly returns 401.
- Every `GET /farmer/*` endpoint returns data scoped to the logged-in farmer
  only — verified สมชาย and สมหญิง get different dashboards, different
  production units (`a1111111-...` vs `a2222222-...`), different contracts,
  different loan applications. There is no `farmer_id` path/query parameter
  anywhere in the API, so there is no IDOR vector to even attempt cross-farmer
  reads through this surface.
- A real `POST /farmer/loan-applications` (as สมชาย, against his own real
  production unit and the seeded lender) persisted a new row and
  immediately reappeared in a subsequent `GET /farmer/loan-applications`.
- `audit.access_log` gained new, correctly-attributed rows (`read`/`write`,
  correct `resource_type`, correct `subject_id`) for every one of the above
  calls.
- Logged in as the seeded Lender org (`oidc|org-001`) and confirmed both a
  farmer JWT and a non-Lender organization JWT (the seeded Buyer,
  `oidc|org-002`) are correctly rejected from every `/lender/*` route
  (`403 organization_subject_required` / `403 lender_subject_required`).
- Submitted real loan applications covering all four automated-evaluation
  branches and confirmed each landed in the correct status: tier A within
  the policy cap → `approved`; tier A over the cap → `manual_review` with
  the capped amount offered as the alternative; tier C within cap →
  `manual_review` (policy requires manual sign-off even in-cap); tier D →
  auto-`declined`.
- Approved one `manual_review` application and one already-`approved`
  application through `POST /lender/loan-applications/:id/approve` — both
  correctly converted into real `contract.contract` rows (status
  `converted`, `contract_id` populated) and immediately appeared in
  `GET /lender/contracts`.
- Declined an application through `POST /lender/loan-applications/:id/decline`
  with a real reason string, and confirmed it stored correctly and moved to
  `declined`.
- **Cross-lender isolation, verified against a real second Lender org**
  (inserted temporarily, removed after the test — not left in seed data):
  its dashboard correctly showed all-zero counts, and attempting to view or
  approve the first lender's applications by their real `application_id`
  returned `404 application_not_found` — not `403` — so a lender can't even
  distinguish "not yours" from "doesn't exist" for another lender's data.
- Logged in as the seeded Buyer org (`oidc|org-002`) and confirmed both a
  farmer JWT and a non-Buyer organization JWT (the seeded Lender) are
  correctly rejected from every `/buyer/*` route.
- Recorded real deliveries covering both paths: a "Spot Sale" (no
  `contract_id`, `unit_price` supplied directly) and, separately, confirmed
  `record_delivery()`'s own validation (active contract required, price
  must come from the contract, caller must actually be the contract's
  buyer party) by exercising the function's error paths.
- Ran a delivery through its full real lifecycle —
  `delivered` → `POST .../confirm-quality` (`accepted`) →
  `POST .../settle` — and hit the **insufficient-balance case for real**:
  the buyer's settlement account genuinely didn't have enough balance for
  a larger delivery, and `ledger.transfer_funds()`'s own balance check
  correctly rejected it with a real Thai error message surfaced as `409`,
  not a generic failure. A smaller delivery within the actual available
  balance settled successfully and produced a real, balanced
  `ledger.journal_entry`.
- Also exercised the rejection path (`accepted: false`) and confirmed it
  stores the inspector's reasoning and moves the delivery to `rejected`
  rather than `settled`.
- **Cross-buyer isolation, verified against a real second Buyer org**
  (inserted temporarily, removed after the test): its dashboard correctly
  showed all-zero counts, and attempting to view, confirm-quality, or
  settle the first buyer's delivery by its real `delivery_id` returned
  `404 delivery_not_found` every time — the same "can't distinguish
  not-yours from doesn't-exist" property verified for the Lender Portal,
  which mattered even more here since `produce.delivery` has no RLS
  backstop at all.
- The `permission denied for table journal_line` deferred-trigger bug (see
  `fix_produce_settlement_security.sql` above) was caught specifically
  *because* testing went all the way through a real commit rather than
  stopping at a rolled-back transaction — worth remembering as a testing
  lesson as much as a database one.
- Logged in via `POST /auth/admin-login` with the real passcode (success),
  a wrong passcode (`401 invalid_passcode`), and no passcode at all
  (`400 passcode_required`).
- Confirmed a farmer JWT and an organization JWT (the seeded Lender org)
  are both correctly rejected from every `/admin/*` route
  (`403 platform_subject_required`), and conversely that a platform JWT is
  rejected from `/farmer/*` and `/lender/*`
  (`403 farmer_subject_required` / `403 organization_subject_required`) —
  the platform identity has no special back-door into the other portals.
- Approved a real pending KYC farmer (มานี มีนา) through
  `POST /admin/farmers/:id/status` (`status: "active"`), then logged in as
  her via `POST /auth/login` and confirmed her own `GET /farmer/notifications`
  showed the real notification the admin action generated — proving the
  loop closes all the way to the farmer's own portal, not just the database
  row.
- Rejected a second pending KYC farmer (วิชัย ทองดี) with a real reason
  string, confirming `status` moved to `closed` and the reason appears in
  the stored notification message.
- Approved a real pending-KYB organization (ปุ๋ยไทยพัฒนา จำกัด) through
  `POST /admin/organizations/:id/kyb-status` (`kyb_status: "Verified"`),
  confirmed the response reported `vendor_activated: true`, and confirmed
  directly against the database that `partner.activate_vendor()` really
  ran: `partner.vendor_profile.commercial_status` became `active` with a
  real `activated_at` timestamp, and a real `ledger.account`
  (`vendor_settlement` type, owned by that org) was created.
- Also drove the full KYC and KYB approve/reject flow through the actual
  **frontend** (Playwright, headless) — passcode login (including a wrong
  passcode showing the right Thai error), dashboard load (summary cards,
  system-health panel, active-alerts list), approving a real pending-KYC
  farmer's card in the KYC queue, approving a real pending-KYB
  organization's card in the KYB queue (a temporary test org, inserted then
  removed afterward — not left in seed data), filtering the all-farmers
  list by status, and logout — not just the API in isolation.
- `ops.v_integrity_checksum` and `monitoring.v_go_live_readiness` were
  re-checked after all of the above (and again after removing the
  temporary test organization) — ledger still balances, Go-Live readiness
  still 6/6 passed.
- A tampered JWT (last character flipped) → `401 invalid_token`; a request
  with no `Bearer` scheme → `401 missing_bearer_token`; an unknown route →
  `404`.
- `ops.v_integrity_checksum` and `monitoring.v_go_live_readiness` were
  re-checked after all of the above — ledger still balances
  (322,515.00 / 322,515.00 / variance 0.00, reflecting the real settlement
  payments made during this testing), Go-Live readiness still 6/6 passed,
  confirming this testing didn't disturb the invariants earlier layers
  established.
- Registered a brand-new farmer through `POST /auth/register`, confirmed the
  returned token works immediately (`GET /auth/session/current` resolves the
  right name), confirmed `GET /farmer/dashboard` returns clean zero/empty
  values rather than erroring for a farmer with no data yet, confirmed
  duplicate phone and duplicate national ID both correctly return `409`,
  and confirmed logging in again afterward with the persisted auto-generated
  claim works — proving the new identity is durable, not just a one-request
  fluke.
- Registered three real organizations through `POST /auth/org-register`
  covering three distinct code paths: a `TractorService` (a brand-new
  org_type value, confirming the widened `CHECK` constraint really works
  and that org_types with no dedicated portal get a plain confirmation, no
  broken redirect), a `Lender` (confirming the returned JWT gets redirected
  toward `lender/dashboard.html` but is correctly gated), and a duplicate
  `tax_id` re-registration attempt (`409 tax_id_already_registered`).
- Confirmed the newly-registered `Lender` org immediately appeared in
  Platform Ops's `GET /admin/organizations?kyb_status=Pending` queue, and
  that `GET /lender/dashboard` with its fresh JWT correctly returned
  `403 kyb_not_verified` (not a generic 500 or a confusing
  `lender_subject_required`) — proving the org-registration →
  KYB-approval loop is fully wired together, not just each half tested in
  isolation.
- Approved that same org's KYB through `POST
  /admin/organizations/:id/kyb-status`, then re-tried the identical
  `GET /lender/dashboard` call with the **same, still-valid** JWT from
  registration (no re-login) and confirmed it now returns real (empty,
  since it's a brand-new org) dashboard data — confirming a self-registered
  org's session survives across its own KYB approval.
- Re-tested an existing, already-`Verified` seeded Lender org
  (`oidc|org-001`) end-to-end after adding the `kyb_status` gate, to
  confirm the new check doesn't regress any previously-working org —
  its dashboard, review queue, and full application list all still
  returned real data exactly as before.
- Deleted all three test organizations (and their `ledger.account` /
  `identity.subject_role` rows) afterward — not left in seed data — and
  re-confirmed `ops.v_integrity_checksum` / `monitoring.v_go_live_readiness`
  still pass.
- **Machinery/Drying-Yard Portal**: registered a `TractorService` org and a
  `DryingYardService` org through `POST /auth/org-register`, confirmed
  `GET /machinery/dashboard` correctly returned `403 kyb_not_verified` for
  both before approval, approved the `TractorService` org through
  `POST /admin/organizations/:id/kyb-status`, then re-tried the identical
  `GET /machinery/dashboard` call with the same still-valid JWT (no
  re-login) and confirmed it now returns real dashboard data. `PUT
  /machinery/rate-card` was exercised end-to-end: setting three of the
  seven items, clearing one back to `null` (confirmed it deactivates rather
  than deletes — `priced_items_count` dropped from 3 to 2, the row survived
  in `marketplace.service_listing` with `is_active = false`), then
  re-setting it (confirmed the same row reactivates via the upsert rather
  than a duplicate being created). Also caught and fixed a real bug this
  way: the first `ON CONFLICT (org_id, service_key)` attempt failed with
  `42P10 no unique or exclusion constraint matching the ON CONFLICT
  specification`, because the arbiter index is partial
  (`WHERE service_key IS NOT NULL`) and Postgres only infers a partial
  unique index as the ON CONFLICT target when the insert's own `ON
  CONFLICT` clause repeats that same `WHERE` predicate — fixed in
  `src/routes/machinery.js`. `POST`/`GET`/`DELETE /machinery/photos` were
  each exercised directly (upload, list, delete-and-confirm-gone).
  `invalid_org_type`, `unknown_service_key`, `invalid_price` (negative), and
  `invalid_photo_data_url` (non-`data:image/...` string) were all confirmed
  to return real `400`s, not 500s. Also drove the full flow through the
  actual **frontend** (Playwright, headless): registered via
  `register-provider.html`, landed on the machinery dashboard's KYB-pending
  notice, approved via a direct admin-API call (simulating Platform Ops),
  reloaded to confirm the real dashboard now renders, filled in and saved
  three rate-card fields, uploaded a real photo file through the file
  input, and reloaded once more to confirm everything (prices, photo count,
  the photo itself) persisted server-side rather than only existing in
  browser state. Deleted the three temporary test organizations (and their
  `marketplace.service_listing`/`marketplace.vendor_photo`/
  `ledger.account`/`identity.subject_role` rows) afterward — not left in
  seed data.
- **InputSupplier product catalog + Buyer daily rice-price announcements
  (2026-07-24)**: 27 real curl checks against the running server covering
  the full InputSupplier flow (register → confirmed blocked pending KYB →
  admin-approved → added two products in different categories → edited a
  price → deleted a product → uploaded and listed a photo → confirmed
  cross-org isolation: a second InputSupplier org's JWT gets `404` trying to
  read/edit/delete the first org's products or photos by real id) and the
  Buyer price-quote flow (get all 7 grades pre-filled `null` → set several
  real prices → invalid `grade_code` correctly `400`s → invalid
  (zero/negative) price correctly `400`s → farmer-facing `GET
  /farmer/rice-prices` immediately reflects the buyer's saved prices →
  registered a second Buyer org, quoted a higher price for the same grade,
  confirmed it sorts first (`quoted_price DESC`) ahead of the original
  buyer → deactivated a quote with `null` and confirmed it disappears from
  the farmer-facing list without deleting the row). All 27 checks passed.
  Also drove the complete flow through the actual **frontend** (Playwright,
  headless): registered an InputSupplier org via `register-provider.html`,
  landed on the KYB-pending notice, admin-approved, added two products
  (different categories) through the real on-page form, uploaded a real
  photo file to one of them, filtered the catalog by category, edited a
  price, deleted the other product, and reloaded to confirm everything
  persisted server-side. Separately logged into the seeded Buyer org
  (`oidc|org-002`), filled in and saved the new daily-price-quote form,
  reloaded to confirm persistence, then logged in as a seeded farmer and
  clicked through to the new `rice-prices.html` page and confirmed the
  buyer's real saved prices appeared there, correctly sorted. **Caught and
  fixed a real bug this way**: the price-quote form's submit handler was
  silently failing with zero console output and zero network requests —
  traced to `frontend/buyer/js/api.js` never having had a `put()` helper
  (every prior Buyer Portal feature only ever needed `get`/`post`), so
  calling `AgroLinkBuyerAPI.put(...)` threw a `TypeError` that the handler's
  own `try/catch` swallowed silently. Fixed by adding the missing `put()`
  helper; re-ran the full suite afterward to confirm the fix. Also
  regression-checked the seeded Lender and Buyer dashboards still return
  real data, and confirmed the seeded InputSupplier org's
  `organization_role` row (backfilled during the earlier multi-role
  migration) was already correctly `Verified`. Deleted all five temporary
  test organizations created during this testing (and their
  `marketplace.product_photo`/`product_listing`/`identity.subject_role`
  rows, plus any orphaned `ledger.account` rows) afterward via a single
  FK-safe transaction — not left in seed data. The seeded Buyer org's real
  price quotes set during this testing (`HOMMALI105`/`PATHUMTHANI1`/
  `WHITE_RICE_5`) were deliberately left in place rather than reset,
  matching this project's existing convention of leaving legitimate
  feature-testing data on seeded orgs (e.g. the seeded Lender's loan
  applications) rather than wiping it after the fact.
- **Farmer ordering flow against the InputSupplier catalog (2026-07-24)**:
  34 real curl checks covering the full lifecycle — registered a fresh
  InputSupplier org, admin-approved it, added two products; as the seeded
  farmer (`oidc|farmer-001`), confirmed `GET /farmer/input-suppliers`
  reported the correct `active_product_count`, confirmed `GET
  /farmer/products` returned both products and the `category`/`org_id`
  filters worked, confirmed an invalid category `400`s; placed an order and
  confirmed `total_price` was computed correctly (`quantity × unit_price`);
  confirmed a zero/negative quantity and a nonexistent `listing_id` both
  `400`/`404` correctly; confirmed the order appeared in both `GET
  /farmer/orders` and the supplier's `GET /inputsupplier/orders?
  status=action_needed`; confirmed → fulfilled it through the real
  `requested → confirmed → fulfilled` lifecycle, and confirmed
  re-confirming an already-confirmed order correctly `409`s; ran the
  reject path (with a reason) and the farmer-initiated cancel path on two
  more orders, and confirmed cancelling an already-cancelled order `409`s.
  **Cross-subject isolation, verified against real second accounts**: a
  second farmer could not see or cancel the first farmer's order (`404`,
  own-history-only on `GET /farmer/orders`); a second InputSupplier org
  could not read the first org's order by real `order_id` (`404`).
  **Deactivate-not-delete, verified directly**: `DELETE
  /inputsupplier/products/:id` was confirmed to leave the row in place with
  `is_active = false` (still visible to the supplier's own `GET
  /inputsupplier/products`, gone from the farmer-facing `GET
  /farmer/products`), and ordering a deactivated product correctly `404`s.
  Confirmed `GET /inputsupplier/dashboard`'s new `orders_by_status`/
  `pending_orders_count` fields matched reality after all of the above. All
  34 checks passed. Also drove the complete flow through the actual
  **frontend** (Playwright, headless): registered a fresh InputSupplier org
  via `register-provider.html`, admin-approved it via a direct API call,
  added three real products through the on-page form; as a seeded farmer,
  navigated to the new `marketplace.html` via the dashboard header link,
  filtered to that one supplier, and placed three real orders through the
  on-page quantity input + "สั่งซื้อ" button; on the supplier side, reloaded
  `inputsupplier/dashboard.html` and confirmed all three orders appeared in
  the new order-review-queue section, confirmed one, rejected a second
  (with a typed reason), then fulfilled the confirmed one — all through the
  real buttons, no direct API calls; confirmed the farmer's own order
  history (reloaded from scratch) showed all three final statuses
  correctly (`ส่งมอบแล้ว`/`ผู้จำหน่ายปฏิเสธ` with the reason text/`ยกเลิกแล้ว`
  after the farmer cancelled the third order themselves through the page's
  own cancel button). Screenshots taken at every step. Regression-checked
  the seeded Lender/Buyer dashboards and `GET /farmer/rice-prices` still
  return real data unaffected by this change. All test organizations and
  their orders/listings/photos were deleted afterward via a single FK-safe
  transaction, not left in seed data.
- **RFP/RFQ** (`procurement.rfq`/`rfq_quote`), backend via `curl` against
  the running server: posted an RFQ as a real seeded farmer
  (`oidc|farmer-001`) and confirmed it appeared in both `GET
  /procurement/rfqs` (public browse) and `GET /procurement/rfqs/mine`;
  confirmed a farmer correctly gets `403 organization_subject_required`
  attempting to submit a quote; submitted a real quote as a seeded Buyer
  org (`oidc|org-002`) and confirmed it appeared in both the requester's
  `GET /procurement/rfqs/:id/quotes` and the responder's `GET
  /procurement/quotes/mine`; accepted that quote as the requester and
  confirmed the RFQ flipped to `awarded` with the correct
  `awarded_quote_id`, and that a non-requester (the responding org) got
  `404` attempting to accept it themselves. Posted a second RFQ as an
  organization requester and confirmed cancel-then-quote correctly `409`s
  (`rfq_not_open`) and that a non-owner gets `404` on cancel. Posted a
  third RFQ and confirmed the upsert-on-conflict quote path: submitting a
  second quote from the same responder org updated the existing row
  (`quote_id` unchanged, price/message updated, still exactly one row for
  that `(rfq_id, responder_org_id)` pair) rather than creating a duplicate;
  withdrew that quote and confirmed accepting a `withdrawn` quote correctly
  `409`s (`quote_not_submitted`). **Frontend** (Playwright, headless),
  across all four wired-up portals with real accounts (a seeded farmer,
  a freshly admin-provisioned Cooperative, a freshly self-registered-then-
  admin-KYB-approved InputSupplier org, and the seeded Buyer org): posted
  a real RFQ through each portal's on-page form and confirmed it appeared
  in "ประกาศของฉัน"; confirmed the "ใบเสนอราคาที่ฉันเสนอ" section is hidden
  (`display: none`) on the farmer's standalone `rfq.html` and visible on
  all three organization dashboards; browsed open RFQs and submitted real
  quotes through the inline quote form on the Buyer and Cooperative
  dashboards, confirming each appeared in that org's own "ใบเสนอราคาที่ฉัน
  เสนอ" list. No page errors on any of the four pages, including a mobile
  (390×844) viewport check of the farmer page. All RFQ/quote test rows
  (the `procurement` schema was entirely new, so this meant clearing all
  of it) and the two ad-hoc test organizations (with their
  `organization_role`/`subject_role`/`vendor_profile`/
  `cooperative_profile` rows) were deleted afterward, not left in seed
  data.
- **Sealed-Bid Auction Mode** (2026-08-22, raw `fetch()` script against a
  real running server + rebuilt `agrolink_test`, all 47 migrations applied
  including the new `grant_sealed_bid_auction.sql`): registered a fresh
  Buyer org (requester) and two fresh InputSupplier orgs (bidders),
  fast-tracked KYB to `Verified` for all three. **Sealed mode:** created an
  RFQ + a `bid_visibility: 'sealed'` auction; bidder A's first bid (500)
  came back `is_leading: true` with no price field in the response at all;
  bidder B underbid at 300 and flipped to `is_leading: true`; confirmed via
  `GET /auctions/:id` that bidder A now saw `my_status: 'not_leading'` with
  `current_lowest_bid`/`my_lowest_bid` both absent from the response;
  bidder A resubmitted at 200 (a brand-new row, not an update — unlimited
  resubmission) and flipped back to leading; bidder B resubmitted at a
  *worse* price (400) than their own earlier 300 and the bid was still
  accepted (sealed mode never rejects on price), correctly reported
  `is_leading: false`. Confirmed `GET /procurement/auctions` (browse) and
  `GET /procurement/auctions/mine` (the requester's own view) both showed
  `current_lowest_bid: null` while open+sealed — including for the
  requester themselves, per this feature's stricter-than-asked design
  choice — while `bid_count` stayed visible and correct in both. Let the
  auction's `closes_at` pass (short window, no manual close) and confirmed
  the existing lazy-expiry `ensureAuctionSettled()` auto-closed and
  auto-awarded it with **zero code changes** — the winner was bidder A's
  200 bid, the same bidder every intermediate `is_leading: true` response
  had already pointed to, confirming the live indicator never disagreed
  with the real award. Confirmed the existing requester-only
  `GET /auctions/:id/bids` endpoint (unmodified) correctly revealed all 4
  historical bid attempts with real prices and bidder identities once
  closed, and that `current_lowest_bid` reappeared in the detail endpoint
  post-award. Confirmed a bid submitted after close correctly `409`s
  (`auction_not_open`). **Live-mode regression, same run:** created a
  second RFQ + a default (`bid_visibility` omitted) auction and confirmed
  it came back `bid_visibility: 'live'`; a bid still echoed its
  `bid_price` back unchanged, and a subsequent non-competitive bid still
  `409`'d with `bid_not_competitive` exactly as before this migration —
  confirming the new column is genuinely additive and changed nothing
  about the pre-existing auction mode.

## Next steps (not yet built)

- Real satellite-imagery integration for AWD verification (see the
  Low-Carbon Rice Cultivation Verification section above) — `carbon.
  satellite_observation` and `POST /admin/carbon/satellite-observations`
  exist and work today, but only as a *manual* Platform Ops data-entry
  point; a real Sentinel Hub/Google Earth Engine/GISTDA account +
  automated ingestion job was explicitly out of scope for this pass (the
  user does not have API credentials for any of those yet).
- A scheduled job to auto-submit or auto-expire `Open` fertilizer-mixing
  groups (เส้นทาง B) once `join_deadline` passes — today `join_deadline` is
  purely advisory; the organizer must still explicitly submit or cancel,
  and a group nobody ever acts on just sits `Open` forever. This sandbox
  has no scheduler/cron infrastructure at all yet, so this is blocked on
  that being built generally, not specific to this feature.
- Multiple discount tiers for fertilizer-mixing group buying (เส้นทาง B) —
  v1 is one threshold + one flat percent per listing.
- The farmer-facing half of the Selling-Space Matching Portal (เกี่ยวข้องกับ
  MarketVenue, unrelated to fertilizer-mixing): `frontend/js/venue-marketplace.js`
  calls `GET /farmer/venue-listings/recommended` and `POST`/`GET
  /farmer/venue-bookings`, none of which exist in any route file — found
  while auditing `src/server.js`'s router mounts in this pass (see the
  Fulfillment Marketplace section above). The provider side
  (`src/routes/marketvenue.js`) is real; only the farmer-booking side is
  missing.
- Real OIDC/JWKS verification in front of `POST /auth/login`.
- RLS on `notification.notification_log` and `produce.delivery` — both
  currently rely entirely on API-layer `WHERE` clauses for their security
  boundary, documented above.
- A scheduled/retry path for `underwriting.evaluate_application()` when it
  can't run at submission time (farmer has no credit score yet) — right now
  those applications just sit at `pending` until someone re-submits or a
  future job picks them up.
- A way to actually *create* a `forward_purchase` contract through the API
  — right now the Buyer Portal can only record deliveries against an
  already-existing contract (or as a Spot Sale); the negotiation/creation
  step for a brand-new forward-purchase agreement isn't built yet.
- Real per-admin accounts for Platform Ops (see "what's mocked" above) —
  the single shared passcode is the biggest known gap in the whole system
  at this point.
- RLS on `identity.farmer`/`identity.organization`/`ledger.account` — same
  API-layer-is-the-only-boundary situation as `notification.notification_log`
  and `produce.delivery` above, just for the tables the admin slice writes
  to. Low risk today since only a `platform`-subject JWT can reach these
  routes at all, but worth hardening consistently with the rest of the
  schema eventually.
- An onboarding path for `Bank`, `Cooperative`, and `Mill` organizations —
  all three currently excluded from `POST /auth/org-register`'s
  self-service list (see "what's mocked" above); `Cooperative` has an
  alternative path (`POST /admin/cooperatives`, Platform-Ops-provisioned),
  but `Bank`/`Mill` have none built yet. (`VillageFund` was REMOVED from
  this gap on 2026-08-17 — it now self-registers through the normal flow,
  see "Farmer 360° View" below.)
- A way to correct `partner.vendor_profile.business_registration_no` after
  registration if it genuinely differs from `tax_id` — no edit endpoint
  exists for `vendor_profile` fields today.
- The farmer-facing half of the marketplace: `marketplace.service_request`
  exists in the schema but has no route yet — a farmer today cannot browse
  machinery/drying-yard providers' rate cards or photos, nor book a
  service. See "what's mocked" above.
- Object storage/CDN for `marketplace.vendor_photo` — photos are currently
  base64 `data:` URLs directly in Postgres, fine for a demo, not for
  production.
- RLS on `marketplace.service_listing`/`marketplace.vendor_photo` — same
  API-layer-is-the-only-boundary situation as the other tables listed
  above, just for the Machinery/Drying-Yard Portal.
- Payment/settlement for the InputSupplier order flow — see "Farmer
  ordering flow" and "what's mocked" above; `fulfilled` today is just a
  status label, no money actually moves.
- Stock/quantity tracking for `marketplace.product_listing` — nothing today
  stops a supplier's product from being ordered more times than they can
  actually supply.
- `Logistics` got its own dedicated portal on 2026-08-23 (`frontend/logistics/`,
  `src/routes/logistics.js`, `grant_logistics_portal.sql`) — the one
  remaining self-registerable org_type with no portal of its own is now
  closed. (`Cooperative` and `Mill` were removed from self-registration
  entirely on 2026-07-24, so they were never part of this gap;
  `InputSupplier` got its own dedicated portal earlier the same day.
  `VillageFund` got its own dedicated portal on 2026-08-17 — see "Farmer
  360° View" below.) Note this portal only shows shipments assigned
  through a `logistics.carrier` row a cooperative has explicitly linked to
  the org (see "Cooperative Collection Station Portal" / M13 Logistics
  below) — a Logistics org with no linked carrier yet sees an empty
  dashboard, same as e.g. a fresh Lender org with no applications yet.
- Group Buy (รวมออเดอร์ประมูลร่วมของสหกรณ์) shipped 2026-08-25
  (`grant_group_buy.sql`, `src/routes/groupbuy.js`, plus the platform-ops
  "convert" endpoints added to `src/routes/admin.js` — see
  `GROUP_BUY_ARCHITECTURE.md` at the project root for the full design).
  Cooperatives pool a requested quantity of an input product (e.g. bulk
  fertilizer) into a round before it closes; Platform Ops then picks a
  "lead cooperative" per round and converts the pooled total into one
  ordinary `procurement.rfq` + `procurement.auction` — the entire
  RFQ→e-Auction→Contract→PO→GRN→Invoice→Payment pipeline downstream of
  that point is completely unmodified. The lead org fronts the invoice
  payment and then triggers a settlement step that reimburses itself from
  every other participant proportional to their declared quantity, via
  `ledger.transfer_funds()` — the exact same money-movement primitive
  `procurement.distribute_revenue_share()` already uses, just reversed in
  direction. Deliberately NOT built this pass (see the architecture doc's
  MVP-scope table): multi-drop-point delivery (goods ship to the lead
  org's single location only, redistribution to other cooperatives happens
  outside the system), and any deposit/penalty for a participant who joins
  a round and later doesn't pay its settlement share.
- Farmer Portal, Lender Portal, Buyer Portal, Platform Ops, the
  Machinery/Drying-Yard Portal, the Cooperative Portal, the VillageFund
  Portal, and the Logistics Portal are all now built end-to-end (backend +
  frontend, tested), and organizations can now both self-register and be
  approved through the API — closing the loop that was the previous "Next
  steps" headline item. The natural next candidates are the gaps just
  above, or a fresh vertical slice (e.g. a `Mill` portal) reusing the same
  patterns established here.
