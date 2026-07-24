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
| `PORT` | HTTP port the API listens on (default 4000) |
| `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD` | Connection to Postgres, using the `agrolink_backend` service account |
| `JWT_SECRET` | HS256 signing key for session tokens — **rotate and load from a real secret manager in production, not `.env`** |
| `JWT_EXPIRES_IN` | Session token lifetime (default `8h`) |

## One-time database setup

Run these against the target database, in order, before starting the API
for the first time:

```
psql -d agrolink_test -f db/setup_backend_role.sql
psql -d agrolink_test -f db/grant_farmer_portal_reads.sql
psql -d agrolink_test -f db/fix_submit_application_security.sql
psql -d agrolink_test -f db/grant_farmer_registration.sql
psql -d agrolink_test -f db/fix_underwriting_decision_security.sql
psql -d agrolink_test -f db/fix_produce_settlement_security.sql
psql -d agrolink_test -f db/grant_buyer_portal.sql
psql -d agrolink_test -f db/grant_platform_ops.sql
psql -d agrolink_test -f db/grant_provider_registration.sql
```

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
- `POST /auth/org-register` — body `{ "org_name", "tax_id", "org_type" }` → the service-provider equivalent of `POST /auth/register`. `org_type` must be one of `Cooperative`/`Mill`/`InputSupplier`/`Lender`/`Logistics`/`Buyer`/`TractorService`/`DroneService`/`HarvesterService`/`TruckService`/`DryingYardService` (see `ORG_SELF_REGISTER_TYPES` in `src/routes/auth.js` — `Bank` and `VillageFund` are deliberately excluded, see "what's mocked" below). Creates a new `identity.organization` row at `kyb_status = 'Pending'`, grants it the `org.admin` role, creates a matching `partner.vendor_profile` row (using `tax_id` as `business_registration_no` — a real simplification, see below), mints a fresh mock OIDC claim (`oidc|org-<uuid>`), and auto-issues a session JWT. Also inserts this `org_type` as the org's **primary role** into `identity.organization_role` at `status = 'Pending'` — see "Multi-role organizations" below. Duplicate `tax_id` returns `409 tax_id_already_registered`.

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
- `GET /farmer/lenders` → active `Lender` organizations from `identity.organization` — added while building the frontend, so the loan-application form's lender dropdown reads real data instead of a hardcoded value.
- `GET /farmer/rice-prices` → for every row in `registry.rice_grade_ref`, every Buyer org's current ACTIVE `marketplace.buy_price_quote` (org name, price, price unit, last-updated), sorted `quoted_price DESC` within each grade so the highest payer for a given rice type is always first. Grades nobody has quoted yet still appear, with an empty `quotes: []` array, so the page can render a "no buyer has posted a price for this yet" state rather than silently omitting the grade. This is the farmer-facing half of the daily rice-buying-price announcement feature — see "Daily rice-buying-price announcements" below.

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

**Machinery/Drying-Yard Portal** (`src/routes/machinery.js`, all require an organization-subject JWT that passes `requireMachineryOrg`: entity `kyb_status = 'Verified'` (`403 kyb_not_verified`) first, then — unlike the single-role-type check in `requireLenderOrg`/`requireBuyerOrg` — an `organization_role` row with `status = 'Verified'` for **any one of** `TractorService`/`DroneService`/`HarvesterService`/`TruckService`/`DryingYardService` (`403 role_not_verified`, `role_type: 'machinery'` generically, otherwise). One unified portal covers all five role types rather than five separate ones, since a single real-world provider commonly offers more than one of these services (e.g. a tractor operator who also runs a truck) — see `MACHINERY_ORG_TYPES` in `src/routes/machinery.js`. An org that holds e.g. `TractorService` Verified but a separately-requested `DroneService` still Pending gets in — the rate card itself has no per-role field gating.
- `GET /machinery/dashboard` — org info (`service_types`: every machinery role this org actually holds at `Verified` — e.g. `["TractorService", "TruckService"]` — deliberately NOT `identity.organization.org_type`, the entity's primary role from registration, which can be a completely different, non-machinery type for a multi-role org; see "Multi-role organizations" below for the bug this would otherwise cause), how many of the seven fixed rate-card items are currently priced (out of 7), and a photo count.
- `GET /machinery/rate-card` — this org's current prices for all seven fixed line items (`plow_rough`/`plow_secondary_seed`/`rotary_till`/`spraying`/`harvesting`/`trucking`/`drying` — see `RATE_CARD_ITEMS`), keyed by `service_key`, pre-filled with `unit_price: null` for anything never priced.
- `PUT /machinery/rate-card` — body `{ "prices": { "plow_rough"?: number|null, ... } }` → upserts a `marketplace.service_listing` row per key present with a positive value (`ON CONFLICT (org_id, service_key)`); a key set to `null`/`0` deactivates (`is_active = false`) rather than deletes the row, since deleting could violate `marketplace.service_request`'s FK to `listing_id` if a farmer has already booked against it. A provider is never required to price all seven — most will only fill in what matches their actual equipment (a `DroneService` org typically only sets `spraying`).
- `GET /machinery/photos` / `POST /machinery/photos` / `DELETE /machinery/photos/:id` — the provider's photo gallery (`photo_type: 'service'|'machinery'`). `POST` expects `photo_data_url` as a `data:image/...` URL read client-side via `FileReader` — see "what's mocked" below, there is no object storage/CDN in this sandbox. Capped at ~3MB per photo (`MAX_PHOTO_DATA_URL_LENGTH`) and `express.json()`'s body limit was raised from the default 100kb to 5mb (`src/server.js`) specifically to let this route through.

**InputSupplier Portal** (`src/routes/inputsupplier.js`, all require an organization-subject JWT that passes `requireInputSupplierOrg`: entity `kyb_status = 'Verified'` (`403 kyb_not_verified`) AND an `organization_role` row with `role_type = 'InputSupplier'`, `status = 'Verified'` (`403 role_not_verified`) — same two-layer shape as `requireLenderOrg`/`requireBuyerOrg`.) See "Product catalog vs. rate card" below for why this portal's data shape deliberately differs from the Machinery Portal's fixed-key rate card.
- `GET /inputsupplier/dashboard` — org info, `total_active_products`, a `products_by_category` breakdown across the four fixed categories, and a photo count.
- `GET /inputsupplier/products?category=` — this org's full catalog (every status, not just active), optionally filtered to one of the four `PRODUCT_CATEGORIES` (`fertilizer_hormone`/`chemical_pesticide`/`equipment`/`other`).
- `POST /inputsupplier/products` — body `{ category, product_name, brand?, description?, unit_price, price_unit? }` → inserts a brand-new `marketplace.product_listing` row. Unlike the machinery rate card's fixed seven keys, this is a genuinely open-ended list — a supplier can list as many or as few products as they actually sell, in any category, and list the same category more than once (e.g. two different fertilizer brands).
- `PUT /inputsupplier/products/:id` — body is a partial update (any subset of the `POST` fields) applied via `COALESCE`; ownership-gated by an explicit `SELECT ... WHERE org_id = $1 AND listing_id = $2` before the update, `404` if the listing doesn't belong to this org (or doesn't exist).
- `DELETE /inputsupplier/products/:id` — a **real hard delete**, deliberately unlike the machinery rate card's deactivate-only `PUT`. Nothing else in the schema references `product_listing` yet (no order/booking flow sits on top of it — see "what's mocked" below), so there's no dangling-FK risk in actually removing the row; `marketplace.product_photo` for that listing cascades away with it (`ON DELETE CASCADE`).
- `GET /inputsupplier/products/:id/photos` / `POST /inputsupplier/products/:id/photos` / `DELETE /inputsupplier/products/:id/photos/:photoId` — same `data:image/...` upload pattern as the Machinery Portal's photo gallery, scoped per-product instead of per-org. Capped at 4MB per photo (`MAX_PHOTO_DATA_URL_LENGTH`).

**Organization Roles / multi-role self-service** (`src/routes/organization.js`, requires any valid organization-subject JWT — deliberately NOT gated to any one `org_type`/role, since managing your own set of business roles is something every organization can do regardless of which roles it currently holds)
- `GET /organization/roles` — this org's full role picture: `org_name`, `primary_org_type` (the role chosen at registration), `entity_kyb_status`, every role it currently holds (`roles[]`, each with `status`/`requested_at`/`decided_at`/`decided_reason`/`label_th`), and every role type it could still request (`requestable_roles[]` — anything in the fixed 11-type domain it doesn't already have a row for, regardless of that row's status).
- `POST /organization/roles` — body `{ role_type }` → self-service request for an ADDITIONAL business role. Requires the org's entity `kyb_status` to already be `Verified` (`409 entity_kyb_not_verified` — you need to clear base KYB before adding business capabilities on top of it) and no existing `(org_id, role_type)` row at all (`409 role_already_requested`, with the existing row's `status` — deliberately does NOT let a `Rejected` role be re-requested through self-service; that needs a human to intervene directly, not an unlimited retry loop against the same rejection). On success, inserts a new row at `status = 'Pending'` — same starting state as the org's primary role, same approval flow via `POST /admin/organizations/:id/roles/:role_type/status` above.

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
  `identity.organization.org_type` (including `Bank`/`VillageFund`, which
  can never be *requested* via `POST /organization/roles` since they're
  excluded from `ORG_REQUESTABLE_ROLE_TYPES`, but a seeded org could in
  principle already hold one).
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

## Product catalog vs. rate card (why InputSupplier isn't just Machinery again)

The Machinery Portal's `marketplace.service_listing` is a **fixed-key rate
card**: exactly seven possible line items (`plow_rough`, `spraying`,
`drying`, ...), one row per `(org_id, service_key)`, priced or not. That
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
booking's FK. `marketplace.product_listing` has no such booking/order flow
sitting on top of it yet (see "what's mocked" below), so `DELETE
/inputsupplier/products/:id` is a real hard delete — there's nothing yet
that a delete could orphan. If/when a purchase-order flow is added against
the catalog, this will need to switch to the same deactivate-only pattern
the rate card already uses.

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
- **`POST /auth/org-register` excludes `Bank` and `VillageFund` from
  self-service sign-up.** `ORG_SELF_REGISTER_TYPES` in `src/routes/auth.js`
  deliberately leaves these two out of the selectable list — they read as
  institutional/government-linked entities that wouldn't plausibly sign up
  through a public web form in a real deployment. There is currently no
  other onboarding path for these two types at all (they can still only be
  seeded directly), which is a real gap if AgroLink ever needs to onboard
  one — just a deliberately out-of-scope one for now.
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
- **No purchase-order/booking flow sits on top of the product catalog
  yet.** A supplier can fully manage their catalog (add/edit/delete
  products, upload photos) and it's visible via `GET
  /inputsupplier/products`, but there is currently no farmer-facing
  `GET .../products` browse endpoint or an order/request flow analogous to
  `marketplace.service_request` on the machinery side. This is why `DELETE
  /inputsupplier/products/:id` is safe to implement as a real hard delete
  today — see "Product catalog vs. rate card" above — but it will need
  revisiting if/when an order flow is added.
- **No historical price archive for rice-buying-price quotes.**
  `marketplace.buy_price_quote` only stores each buyer's *current* price
  per grade (upserted in place) — there is no day-by-day history table, so
  neither buyers nor farmers can see how a price has moved over time, only
  today's live number and its `updated_at` timestamp.

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

## Next steps (not yet built)

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
- An onboarding path for `Bank` and `VillageFund` organizations — currently
  excluded from `POST /auth/org-register`'s self-service list (see "what's
  mocked" above) with no alternative path built yet.
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
- Dedicated portals for `Cooperative`, `Mill`, `InputSupplier`, and
  `Logistics` — these four org_types can still only self-register and get a
  registration-received confirmation; there's nowhere for them to log into
  yet, unlike the five machinery/drying-yard org_types (which now share the
  unified portal built this session).
- Farmer Portal, Lender Portal, Buyer Portal, Platform Ops, and the
  Machinery/Drying-Yard Portal are all now built end-to-end (backend +
  frontend, tested), and organizations can now both self-register and be
  approved through the API — closing the loop that was the previous "Next
  steps" headline item. The natural next candidates are the gaps just
  above, or a fresh vertical slice (e.g. Logistics, VillageFund) reusing
  the same patterns established here.
