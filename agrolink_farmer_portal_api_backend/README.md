# AgroLink Platform — Backend API Gateway (Farmer Portal slice)

A real, running Node.js/Express API that sits in front of the `agrolink_test`
PostgreSQL database and implements the Farmer-Portal-facing slice of the
G-1..G-19 contracts designed across Layers 1–10. This is the first piece of
actual application code in the project — everything before it was schema,
API contracts, and documentation. Its job is to be the thing a future
farmer-facing homepage/frontend calls.

Scope decision (confirmed with the user): homepage audience = **farmers**;
first component to build = **Backend API Gateway** (rather than the frontend
itself), so the API contract is solid before any UI is built against it.

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

## Running

```
npm install
npm start          # or: node src/server.js
```

`GET /health` should return `{"status":"ok", ...}` once it's up.

## Endpoints implemented

**Auth** (`src/routes/auth.js`)
- `POST /auth/login` — body `{ "external_subject_claim": "oidc|farmer-001" }` → resolves the claim via `security.resolve_subject_from_external_claim()` and returns a signed JWT.
- `GET /auth/session/current` — requires `Authorization: Bearer <token>`; echoes back the resolved identity and display name.

**Farmer Portal** (`src/routes/farmer.js`, all require a farmer-subject JWT)
- `GET /farmer/dashboard` → `reporting.v_farmer_360`
- `GET /farmer/credit-score` → `risk.v_farmer_latest_score` + full history from `risk.credit_score`
- `GET /farmer/loan-applications` / `POST /farmer/loan-applications` → `underwriting.loan_application`, submission via `underwriting.submit_application()`
- `GET /farmer/contracts` → `contract.contract` joined through `contract.contract_party`
- `GET /farmer/notifications` → `notification.v_unread_notifications`
- `GET /farmer/production-units` → `registry.production_unit` (PostGIS boundary returned as GeoJSON via `ST_AsGeoJSON`)

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
- **Single lender org used in testing.** Only one `Lender`-type organization
  exists in the seed data (`สหกรณ์สินเชื่อเกษตรยั่งยืน จำกัด`), so multi-lender
  scenarios weren't exercised.

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
- A tampered JWT (last character flipped) → `401 invalid_token`; a request
  with no `Bearer` scheme → `401 missing_bearer_token`; an unknown route →
  `404`.
- `ops.v_integrity_checksum` and `monitoring.v_go_live_readiness` were
  re-checked after all of the above — ledger still balances
  (312,515.00 / 312,515.00 / variance 0.00), Go-Live readiness still
  6/6 passed, confirming this testing didn't disturb the invariants earlier
  layers established.

## Next steps (not yet built)

- The actual farmer-facing homepage/frontend that calls this API.
- Real OIDC/JWKS verification in front of `POST /auth/login`.
- RLS on `notification.notification_log`.
- Endpoint slices for the other audiences this platform serves (lenders,
  buyers, platform ops) — this build deliberately covered only the Farmer
  Portal slice per the confirmed scope.
