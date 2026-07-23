# AgroLink Platform — Backend API Gateway (Farmer + Lender + Buyer Portals)

A real, running Node.js/Express API that sits in front of the `agrolink_test`
PostgreSQL database and implements the Farmer-Portal-, Lender-Portal-, and
Buyer-Portal-facing slices of the G-1..G-19 contracts designed across
Layers 1–10. This was the first piece of actual application code in the
project — everything before it was schema, API contracts, and documentation.

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
the agreed quantity is fully delivered.

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

Note: `POST /auth/login` is shared by the Farmer Portal, Lender Portal, AND
Buyer Portal — `security.resolve_subject_from_external_claim()` already
resolves a claim to either a `farmer` or an `organization` row (regardless
of `org_type`), so no separate lender- or buyer-login endpoint was needed.

**Farmer Portal** (`src/routes/farmer.js`, all require a farmer-subject JWT)
- `GET /farmer/dashboard` → `reporting.v_farmer_360`
- `GET /farmer/credit-score` → `risk.v_farmer_latest_score` + full history from `risk.credit_score`
- `GET /farmer/loan-applications` / `POST /farmer/loan-applications` → `underwriting.loan_application`, submission via `underwriting.submit_application()`, immediately followed in the same request by `underwriting.evaluate_application()` (see below) so the farmer gets an instant decision instead of an application that sits at `pending` forever.
- `GET /farmer/contracts` → `contract.contract` joined through `contract.contract_party`
- `GET /farmer/notifications` → `notification.v_unread_notifications`
- `GET /farmer/production-units` → `registry.production_unit` (PostGIS boundary returned as GeoJSON via `ST_AsGeoJSON`)
- `GET /farmer/lenders` → active `Lender` organizations from `identity.organization` — added while building the frontend, so the loan-application form's lender dropdown reads real data instead of a hardcoded value.

**Lender Portal** (`src/routes/lender.js`, all require an organization-subject JWT whose `org_type = 'Lender'`)
- `GET /lender/dashboard` — org info, application counts by status, active-contract count and outstanding principal.
- `GET /lender/loan-applications?status=...` — applications submitted to this lender, joined with the farmer's name and latest credit score. `status` accepts any real status value, or the shorthand `action_needed` (`manual_review` + `approved` — both still require the lender to act; `approved` is only an automated pre-approval until a contract actually exists).
- `GET /lender/loan-applications/:id` — single application detail, plus the related production unit.
- `POST /lender/loan-applications/:id/approve` — body `{ final_amount? }` → `underwriting.approve_application()`, converting the application into a real `contract.contract` row (status `converted`).
- `POST /lender/loan-applications/:id/decline` — body `{ reason? }` → `underwriting.decline_application()`.
- `GET /lender/contracts` — this org's loan-agreement portfolio (contracts where it is the `lender` party).

**Buyer Portal** (`src/routes/buyer.js`, all require an organization-subject JWT whose `org_type = 'Buyer'`)
- `GET /buyer/dashboard` — org info, delivery counts by status, lifetime settled amount, active-contract count.
- `GET /buyer/deliveries?status=...` — this buyer's own deliveries, joined with the farmer's name and production unit. `status` accepts any real status value, or the shorthand `action_needed` (`delivered` + `accepted` — `delivered` still needs quality confirmation, `accepted` still needs settlement).
- `GET /buyer/deliveries/:id` — single delivery detail.
- `POST /buyer/deliveries` — body `{ unit_id, commodity_code, quantity_ton, contract_id?, cycle_id?, unit_price? }` → `produce.record_delivery()`. If `contract_id` is given, the function itself validates the contract is `active`, has an agreed price, and that this buyer is really its buyer party. With no `contract_id` ("Spot Sale"), `unit_price` is required directly instead.
- `POST /buyer/deliveries/:id/confirm-quality` — body `{ quality_grade, accepted, inspected_by }` → `produce.confirm_quality()`, moving the delivery to `accepted` or `rejected`.
- `POST /buyer/deliveries/:id/settle` — body `{}` → `produce.settle_delivery()`: moves the delivery to `settled`, makes a real `ledger.transfer_funds()` payment from the buyer's settlement account to the production unit's wallet, and auto-closes the contract (`status = 'completed'`) once its full agreed quantity has been settled. Fails with a real, descriptive `409` (not a generic 500) if the buyer's settlement account has insufficient balance, or isn't activated yet.
- `GET /buyer/contracts` — this org's forward-purchase portfolio (contracts where it is the `buyer` party).
- `GET /buyer/production-units` — small read-only directory of active production units with their owning farmer's name, so the delivery form doesn't require knowing a `unit_id` by heart. Mirrors the intent of `GET /farmer/lenders`.
- `GET /buyer/commodities` — `registry.commodity_ref`, for the delivery form's commodity dropdown.

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
- **No org self-registration.** Unlike farmers, organizations (lenders,
  buyers, etc.) have no `POST /auth/register`-equivalent — they're assumed
  to be onboarded through a separate KYB (know-your-business) process not
  built yet, consistent with `identity.organization.kyb_status` already
  existing as a column with no workflow behind it.

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

## Next steps (not yet built)

- Real OIDC/JWKS verification in front of `POST /auth/login`.
- RLS on `notification.notification_log` and `produce.delivery` — both
  currently rely entirely on API-layer `WHERE` clauses for their security
  boundary, documented above.
- A scheduled/retry path for `underwriting.evaluate_application()` when it
  can't run at submission time (farmer has no credit score yet) — right now
  those applications just sit at `pending` until someone re-submits or a
  future job picks them up.
- A real KYB (know-your-business) workflow so organizations can be onboarded
  and verified rather than only ever seeded directly into the database.
- A way to actually *create* a `forward_purchase` contract through the API
  — right now the Buyer Portal can only record deliveries against an
  already-existing contract (or as a Spot Sale); the negotiation/creation
  step for a brand-new forward-purchase agreement isn't built yet.
- A platform-ops/admin slice (including farmer KYC approval and
  organization KYB approval) — Farmer Portal, Lender Portal, and Buyer
  Portal are all now built; platform ops is the natural next candidate.
