# AgroLink Platform — Farmer Portal + Lender Portal Frontend

The homepage/frontend for farmers, plus a separate portal for lenders,
both calling the same Backend API Gateway (`../backend`). Plain
HTML/CSS/JavaScript — no build step, no framework — so it runs anywhere a
static file can be served, and every byte shipped here is what actually
runs in the browser.

## Pages — Farmer Portal (this directory)

- `index.html` — login. A real form field for the identity claim (labeled
  and explained as a stand-in for a verified OIDC token's `sub` claim, since
  no real identity provider is connected in this environment), plus three
  "quick demo login" buttons for the farmers seeded across earlier layers
  (สมชาย ใจดี / สมหญิง รักนา / ประยุทธ นาดี). The demo buttons are clearly
  labeled as such and only exist to make manual testing fast — a production
  build would remove them entirely, since a real user would arrive here via
  an OIDC redirect, not by typing or picking a claim.
- `dashboard.html` — the portal itself: account overview, credit score
  (with per-factor breakdown and history), production units, contracts,
  loan applications (list + a real submission form), and unread
  notifications. Every section is loaded independently and fails
  independently — one broken panel doesn't take down the rest of the page.
  Submitting a loan application now shows the automated underwriting
  decision immediately (auto-approved / needs manual review / auto-declined)
  — see the backend README's `evaluate_application()` note.
- `register.html` — farmer sign-up: full name, phone, national ID (13
  digits — hashed server-side, see backend README), and a province dropdown
  (`js/provinces.js`, all 77 Thai provinces with their real ISO 3166-2:TH
  codes, matching the `region_code` format already used by the seeded
  farmers). On success the backend auto-issues a session token and the page
  goes straight to `dashboard.html`, same as logging in. Linked from
  `index.html` ("ยังไม่มีบัญชี? สมัครสมาชิกเกษตรกร").

## Pages — Lender Portal (`lender/`)

A separate small app in its own folder, not a section bolted onto the
Farmer Portal — different audience, different session (own `localStorage`
key `agrolink_lender_session`, so a farmer session and a lender session in
the same browser never collide), same shared CSS (`../css/style.css`).

- `lender/index.html` — login, same mock-claim pattern as the Farmer
  Portal's login, with one demo button for the seeded Lender org
  (สหกรณ์สินเชื่อเกษตรยั่งยืน จำกัด, `oidc|org-001`). Uses the *same*
  `POST /auth/login` endpoint — no separate lender-login API exists, since
  `security.resolve_subject_from_external_claim()` already resolves a claim
  to either a farmer or an organization.
- `lender/dashboard.html` — org overview (counts by application status,
  active-contract count, outstanding principal); a **review queue** of
  applications that need this lender's action (`manual_review` and
  `approved`-but-not-yet-a-contract, both fetched via
  `?status=action_needed`), each with an inline final-amount field and
  approve/decline buttons; a filterable read-only list of every application
  ever submitted to this lender; and a read-only contracts-portfolio list.

If a farmer's token (or any non-Lender organization's token) is used
against a `/lender/*` route, the backend returns `403`; `lender/js/api.js`
treats that the same as an expired session — clears it and bounces back to
`lender/index.html` with a reason shown inline, rather than a confusing
blank/broken dashboard.

## Running

The backend must already be running on `http://localhost:4000` (see
`../backend/README.md`). Then, from this directory:

```
node serve.js          # serves this directory at http://localhost:5173
```

No `npm install` needed — `serve.js` is a zero-dependency static file
server (`http`/`fs` from Node's standard library only) and serves any
subpath, so the Lender Portal is reachable at the same server, no separate
process needed:

- Farmer Portal: `http://localhost:5173/index.html`
- Lender Portal: `http://localhost:5173/lender/index.html`

If the API runs somewhere other than `localhost:4000`, change `API_BASE` at
the top of both `js/api.js` (Farmer Portal) and `lender/js/api.js` (Lender
Portal) — they're separate copies, not shared, on purpose (see above).

## How it talks to the backend

`js/api.js` (and its Lender Portal counterpart, `lender/js/api.js`) is the
only file in each app that knows about HTTP — it wraps `fetch()`, attaches
the `Authorization: Bearer <token>` header once logged in, and centralizes
both 401 handling (expired/invalid token) and 403 handling (a
structurally-valid token for the wrong kind of subject — e.g. a farmer
token used against `/lender/*`): either way, it clears the stored session
and bounces back to that app's own login page rather than the page just
silently failing. The JWT is kept in `localStorage` under
`agrolink_farmer_session` (Farmer Portal) or `agrolink_lender_session`
(Lender Portal) — normal practice for a real single-page app; logging out
clears it.

## Verified end-to-end (real browser, real backend, real database)

Tested with Playwright against the actually-running static server and API
gateway — not a mock:

- Login via both the demo quick-select buttons and by typing a claim
  manually into the form; an unrecognized claim shows a real Thai error
  message inline and does not navigate away from the login page.
- Farmer สมชาย's dashboard renders his real data: 2 production units,
  3 contracts, credit score 80.00 (tier A) with its factor breakdown.
- Logging in as a different farmer (สมหญิง) shows entirely different data
  (1 production unit growing CASSAVA, tier D score) — confirmed the two
  farmers' pages never show each other's production units or loan
  application text, matching the RLS isolation already verified at the API
  layer.
- A real loan application was submitted through the on-page form (unit and
  lender selected from live dropdowns populated by `/farmer/production-units`
  and the new `/farmer/lenders` endpoint) and appeared in the list
  immediately after submission, with no page reload.
- Logout clears the session and returns to the login page.
- One rendering bug found and fixed during this testing: `factor_score`
  in the credit-score breakdown can legitimately be `null` when there isn't
  enough underlying data yet (e.g. a farmer with zero settled deliveries) —
  the page used to print the literal string "null/100"; it now shows
  "ไม่มีข้อมูลเพียงพอ" (not enough data) instead.
- Registration tested end-to-end through the actual form: submitted a new
  farmer, landed on the dashboard auto-logged-in with every section
  correctly showing empty states (0 units, "ยังไม่มีการประเมินคะแนนสินเชื่อ",
  "ยังไม่มีสัญญา", etc.) rather than errors; re-submitting the same
  phone/national ID from the form shows the duplicate error inline and
  correctly stays on the registration page.
- **Lender Portal**, tested with Playwright the same way: logged in as the
  seeded Lender org via its demo button; the dashboard showed the org's real
  name and correct application counts; the review queue showed exactly the
  applications actually awaiting this lender's action; clicking "อนุมัติ /
  แปลงเป็นสัญญา" on a real application converted it into a real contract and
  it disappeared from the queue, with a success toast and the summary counts
  updating without a page reload; clicking "ปฏิเสธ" with a typed-in reason
  correctly declined a different application; switching the "ทั้งหมด" status
  filter to `converted` showed both just-actioned applications; the
  contracts-portfolio section showed the newly-created contracts; logout
  returned to the login page. Separately confirmed (via a real farmer JWT
  placed in `agrolink_lender_session`) that the app correctly detects a
  wrong-subject-type token and bounces to the login page with
  "บัญชีนี้ไม่ใช่บัญชีผู้ปล่อยกู้" shown, rather than rendering a broken dashboard.

## New backend endpoints added while building this

- `GET /farmer/lenders` (in `../backend/src/routes/farmer.js`) — returns
  active `Lender` organizations so the loan-application form's lender
  dropdown is populated from real data instead of being hardcoded in the
  frontend. Behind `requireAuth`, reading `identity.organization` (already
  granted to `agrolink_app` in the backend's `grant_farmer_portal_reads.sql`).
- `POST /auth/register` (in `../backend/src/routes/auth.js`) — backs
  `register.html`. See the backend README for the two real database grant
  gaps this surfaced.
- The entire `/lender/*` slice (in `../backend/src/routes/lender.js`) —
  backs `lender/dashboard.html`. See the backend README for what it does
  and the real database/authorization gaps building it surfaced.

## What's next

- Real OIDC login redirect in place of the claim-entry form (once an IdP is
  connected) — see the backend README's mocked/simplified section, since
  this is the same underlying gap.
- Map rendering for production unit boundaries (`gps_boundary` is already
  returned as GeoJSON by the API; this page currently shows it as plain
  attributes only).
- Pagination/filtering once contract and loan-application volumes grow
  beyond what fits comfortably on one page.
- A Buyer Portal and a platform-ops/admin portal (including farmer KYC
  approval) — the natural next audiences per the backend README.
