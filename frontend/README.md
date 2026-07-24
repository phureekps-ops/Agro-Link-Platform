# AgroLink Platform — Farmer + Lender + Buyer + Platform Ops Portal Frontend

The homepage/frontend for farmers, plus separate portals for lenders,
produce buyers, and platform-ops staff, all calling the same Backend API
Gateway (`../backend`). Plain HTML/CSS/JavaScript — no build step, no
framework — so it runs anywhere a static file can be served, and every byte
shipped here is what actually runs in the browser.

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

## Pages — Buyer Portal (`buyer/`)

Another separate small app, same pattern as the Lender Portal: its own
`localStorage` key (`agrolink_buyer_session`), its own login page, same
shared CSS.

- `buyer/index.html` — login, same mock-claim pattern, with one demo
  button for the seeded Buyer org (โรงสีข้าวไทยเจริญ จำกัด, `oidc|org-002`).
  Same `POST /auth/login` endpoint as the other two portals.
- `buyer/dashboard.html` — org overview (delivery counts by status,
  lifetime settled amount, active-contract count); a **review queue** of
  deliveries needing action (`delivered` — needs quality confirmation — and
  `accepted` — needs settlement — both fetched via `?status=action_needed`),
  each `delivered` card showing an inline quality-grade + inspector-name
  form with accept/reject buttons, each `accepted` card showing a settle
  button; a filterable read-only list of every delivery this buyer has ever
  recorded; a form to record a brand-new delivery (toggles between "Spot
  Sale" — pick any active production unit, a commodity, and set your own
  price — and "against an active contract" — pick from this buyer's own
  active forward-purchase contracts, which auto-fills the unit and lets the
  contract's own agreed price apply); a read-only forward-purchase
  contracts-portfolio list; and a **"📢 ประกาศราคารับซื้อข้าวเปลือกประจำวัน"**
  (daily rice-buying-price announcement) section — one price field per rice
  grade in `registry.rice_grade_ref` (ข้าวเปลือกเจ้าหอมมะลิ 105, ปทุมธานี 1,
  ข้าวเปลือกเจ้า 5%/25%, ข้าวเปลือกเหนียว กข6/กข10/เมล็ดสั้น), pre-filled with
  whatever this buyer has already quoted, saved in one request via `PUT
  /buyer/price-quotes`. Clearing a field back to empty and saving
  deactivates that grade's quote rather than deleting it. These prices are
  visible to every farmer on the platform via `rice-prices.html` (see
  below) — this was a deliberate product decision, not an internal-only
  tool.

Same `403` → bounce-to-login treatment as the Lender Portal if a
wrong-subject-type token is used against `/buyer/*`.

Cross-linked with the other two: each portal's login page has a small link
to the other two, so navigating between them during testing doesn't
require re-typing URLs.

## Pages — Platform Ops / Admin Portal (`admin/`)

A fourth separate small app, same overall pattern as the Lender/Buyer
Portals (own `localStorage` key `agrolink_admin_session`, same shared CSS)
but with one real difference: login is **passcode-based**, not
claim-based, because there is no per-admin identity table in this sandbox
— see `../backend/README.md`'s note on `POST /auth/admin-login`.

- `admin/index.html` — login: a single passcode field (no demo-account
  buttons, since there's no per-admin identity to pick between — just the
  one shared `ADMIN_PASSCODE`), with the mock explained inline the same
  way the other portals explain their mock-claim login.
- `admin/dashboard.html` — an overview panel (pending-KYC/KYB counts,
  active/suspended/closed farmer counts, verified-org count); a **system
  health** panel built from `GET /admin/dashboard`'s `system_health` block
  (ledger-balanced badge, Go-Live readiness badge, active-alert count) plus
  the full active-alerts list when there are any; a **KYC queue** — every
  `pending_kyc` farmer, each card with an optional reason field and
  approve/reject buttons; a **KYB queue** — every `Pending` organization,
  same card shape; a filterable read-only list of every farmer in the
  system; and a filterable read-only list of every organization (showing
  its commercial-activation status alongside its KYB status).

Same `403` → bounce-to-login treatment as the other two portals if a
wrong-subject-type token is used against `/admin/*` — and, in the other
direction, a platform token is equally rejected by `/farmer/*`,
`/lender/*`, and `/buyer/*`; the platform identity has no special access
to the other three portals' own pages.

All portals now cross-link each other from their login pages (Farmer,
Lender, Buyer, Admin, Machinery, and now InputSupplier).

## Pages — Machinery/Drying-Yard Portal (`machinery/`)

A fifth separate small app, same overall pattern as the Lender/Buyer
Portals (own `localStorage` key `agrolink_machinery_session`, own
`machinery/js/api.js` copy, same shared CSS, same claim-based mock login as
the Farmer/Lender/Buyer Portals). One unified portal serves all five
machinery/drying-yard `org_type` values (`TractorService`, `DroneService`,
`HarvesterService`, `TruckService`, `DryingYardService`) rather than five
separate ones — see `../backend/README.md`'s note on why (a single
real-world provider commonly offers more than one of these services).

- `machinery/index.html` — login: same claim-based mock login as the other
  portals. No demo-account buttons — unlike the seeded Lender/Buyer orgs,
  no machinery/drying-yard org exists in seed data; every one is created
  through `register-provider.html`.
- `machinery/dashboard.html` — an overview panel (the org's Verified
  machinery/drying-yard role(s) — e.g. "บริการรถไถ" or "บริการรถไถ ·
  บริการรถบรรทุก" for an org holding more than one — NOT the entity's
  primary `org_type`; see "Multi-role organizations" below for why that
  distinction matters, KYB status, how
  many of the 7 rate-card items are priced, photo count); a **rate card**
  form with one input per fixed line item — ไถดะ, ไถแปรและหว่าน, ปั่นดิน,
  ฉีดพ่นสารเคมี (โดรน/รถฉีดพ่น), เกี่ยวข้าว, ขนส่งด้วยรถบรรทุก (บาท/ตัน-กม.),
  and ลานตากข้าว/ตากผลผลิต (บาท/ตัน) — rendered dynamically from `GET
  /machinery/rate-card` rather than hardcoded, so a provider only fills in
  what they actually offer and leaves the rest blank; and a **photo
  gallery** (upload with a type selector — เครื่องจักรกล/บริการ — and an
  optional caption, a responsive thumbnail grid, and a delete button per
  photo). File selection happens through a plain `<input type="file">` read
  client-side via `FileReader.readAsDataURL()` and posted straight to the
  backend as a `data:` URL — see the backend README's note on there being
  no object storage in this sandbox. Client-side caps a selected file at
  2MB before even attempting the upload, matching the backend's ~3MB
  data-URL ceiling with margin for base64 inflation.

Same `kyb_not_verified` pending-notice pattern as the Lender/Buyer Portals
below, and the same wrong-subject-type `403` → bounce-to-login treatment as
every other portal.

## Pages — InputSupplier Portal (`inputsupplier/`)

A sixth separate small app, same overall pattern as the other portals (own
`localStorage` key `agrolink_inputsupplier_session`, own
`inputsupplier/js/api.js` copy, same shared CSS, same claim-based mock
login). Backs the product-catalog half of the feature request: input
suppliers (ผู้จำหน่ายปัจจัยการผลิต) need somewhere to list what they actually
sell.

- `inputsupplier/index.html` — login: same claim-based mock login as the
  other portals. No demo-account button — every InputSupplier org used in
  testing was created through `register-provider.html`, same as the
  machinery org_types.
- `inputsupplier/dashboard.html` — an overview panel (active-product count,
  a per-category breakdown, KYB/role status, photo count, and now an order
  summary by status); an **order review queue**
  (`GET /inputsupplier/orders?status=action_needed`) — one card per order
  still needing this supplier's action, with "ยืนยันคำสั่งซื้อ" +
  "ปฏิเสธ" (with an optional reason field) buttons on a `requested` order, or
  a single "บันทึกว่าส่งมอบสินค้าแล้ว" button on a `confirmed` one — mirrors
  the Lender/Buyer Portals' own review-queue pattern
  (`GET .../loan-applications?status=action_needed` /
  `GET .../deliveries?status=action_needed`); a **full order history**
  section (`GET /inputsupplier/orders`, filterable by status) below that,
  using the same card renderer so a settled order simply shows its final
  status badge with no action buttons; a **product form** (category
  dropdown — ปุ๋ย/ฮอร์โมน, สารเคมีและยาปราบศัตรูพืช, อุปกรณ์การเกษตร, อื่นๆ —
  product name, brand, price, price unit, description) that adds a new
  catalog entry on submit, and switches into an edit mode (submit button
  relabeled "บันทึกการแก้ไข", with a "ยกเลิกการแก้ไข" cancel button) when
  "แก้ไข" is clicked on an existing product card — unlike the Machinery
  Portal's rate card, this is a genuinely open-ended list, not a fixed set
  of fields, so add/edit/delete are three distinct actions rather than one
  upsert form (see the backend README's "Product catalog vs. rate card"
  note for why); a **category filter** over the product list; and a
  **per-product photo mini-gallery** (same `data:` URL upload pattern as
  the Machinery Portal, 2MB client-side cap before upload, scoped to that
  one product rather than the whole org). "ลบสินค้า" now deactivates rather
  than truly deleting the row (see the backend README's note on
  `DELETE /inputsupplier/products/:id`) — the button and its label are
  unchanged, only what happens underneath changed, since an order could now
  point at that exact product.

Same `kyb_not_verified`/`role_not_verified` pending-notice pattern and the
same wrong-subject-type `403` → bounce-to-login treatment as every other
portal.

## Page — เปรียบเทียบราคารับซื้อข้าว / Rice-Price Comparison (`rice-prices.html`)

A single page living at the Farmer Portal's own top level (`frontend/`,
alongside `dashboard.html`) rather than a separate mini-app — it reuses the
Farmer Portal's own session (`AgroLinkAPI`, `agrolink_farmer_session`)
since its whole purpose is showing a logged-in farmer something, not
managing a separate identity. Linked from a new button in
`dashboard.html`'s header ("เปรียบเทียบราคารับซื้อข้าว").

Calls `GET /farmer/rice-prices` and renders one card per rice grade (`js/rice-prices.js`,
`gradeCard()`), each card listing every Buyer currently quoting that grade,
sorted highest price first with a 🏆 marker on the top offer — so a farmer
can see at a glance which buyer is currently paying the most for, say,
ข้าวเปลือกเจ้าหอมมะลิ 105, without having to check each buyer individually.
A grade with no active quotes yet shows "ยังไม่มีผู้รับซื้อประกาศราคาสำหรับข้าวชนิดนี้"
rather than an empty or broken-looking card.

## Page — ตลาดปัจจัยการผลิต / Input Marketplace (`marketplace.html`)

Same shape as `rice-prices.html` — lives at the Farmer Portal's own top
level, reuses `AgroLinkAPI`/`agrolink_farmer_session`, no login of its own.
Linked from a new "ตลาดปัจจัยการผลิต" button in `dashboard.html`'s header,
next to the rice-price comparison link. This is the farmer-facing half of
the InputSupplier product catalog (see the backend README's "Farmer
ordering flow" section) — the catalog existed and was fully manageable by
suppliers before this, but nothing let a farmer see or buy from it.

- A category + supplier filter bar (`GET /farmer/input-suppliers` populates
  the supplier dropdown with each org's name and current active-product
  count, so a farmer can browse "by supplier" as well as "by category").
- A product list (`GET /farmer/products?category=&org_id=`) — each card
  shows the product, its supplier's name, price, and a quantity input +
  "สั่งซื้อ" button that calls `POST /farmer/orders`.
- An order-history section (`GET /farmer/orders`) below the product list —
  every order this farmer has ever placed, across every supplier, with its
  current status (รอการยืนยันจากผู้จำหน่าย / ยืนยันแล้ว (รอส่งมอบ) /
  ส่งมอบแล้ว / ผู้จำหน่ายปฏิเสธ, with the supplier's reason if given /
  ยกเลิกแล้ว) and, only while an order is still `requested`, a "ยกเลิกคำสั่งซื้อ"
  button (`POST /farmer/orders/:id/cancel`) — once a supplier confirms an
  order the farmer can no longer cancel it themselves, matching the
  backend's own state-machine rules (see the backend README).

## Page — Service-Provider Registration (`register-provider.html`)

A single standalone page (not inside any one portal's folder, same level
as the Farmer Portal's own `register.html`) backing `POST
/auth/org-register` — the org-facing counterpart to farmer
self-registration. Three fields: organization/business name, tax ID (13
digits), and a business-type dropdown covering nine self-registerable
`org_type` values — `Lender`/`Buyer`/`InputSupplier`/`Logistics`, plus the
five farm-machinery/drying-yard service categories that share the unified
Machinery/Drying-Yard Portal above: บริการรถไถ (`TractorService`),
บริการโดรน/ฉีดพ่นสารเคมี (`DroneService`), บริการรถเกี่ยวข้าว
(`HarvesterService`), บริการรถบรรทุก (`TruckService`), and บริการลานตากข้าว
(`DryingYardService`). **`Cooperative` (สหกรณ์) and `Mill` (โรงสี) were
removed from this dropdown on 2026-07-24** per an explicit product decision
— see the backend README's "what's mocked" section; both values still exist
in the underlying `org_type` domain, they just aren't offered on this form
anymore.

What happens after a successful submission depends on the chosen
`org_type`, since not every organization type has a dedicated portal yet:
- **Lender**, **Buyer**, **InputSupplier**, or any of the **five
  machinery/drying-yard types** — the returned session is stored under that
  portal's own `localStorage` key and the page redirects straight to
  `lender/dashboard.html`, `buyer/dashboard.html`,
  `inputsupplier/dashboard.html`, or `machinery/dashboard.html`. Since the
  new organization's `kyb_status` is always `Pending` at this point, that
  dashboard shows a "your application is under review" notice instead of
  live data (see the pending-KYB-state section below) — refreshing the
  same page after Platform Ops approves it shows the real dashboard, no
  re-login needed.
- **Logistics** — the only remaining self-registerable type with no
  dedicated portal — there's nowhere to redirect to yet, so the page just
  replaces the form with a plain "ส่งใบสมัครเรียบร้อยแล้ว" (application
  received) confirmation showing the org name and type.

Linked from: the root marketing homepage's `#contact` call-to-action
banner (previously a dead `href="#"` placeholder — now a real link,
relabeled "สมัครเป็นผู้ให้บริการ"), and a "ยังไม่มีบัญชีองค์กร?"/"มีบัญชีอยู่แล้ว?"
link on `lender/index.html`, `buyer/index.html`, and `machinery/index.html`'s
login pages.

## Lender/Buyer/Machinery Portal update — pending-KYB and pending-role states

`lender/js/dashboard.js`, `buyer/js/dashboard.js`, and
`machinery/js/dashboard.js` all open with a gate check against their own
`GET .../dashboard` call. If the backend reports `kyb_not_verified` (a real
org token, just not yet approved by Platform Ops — the case a fresh
`register-provider.html` submission always starts in), the whole dashboard
body is replaced with a centered "your KYB application is under review"
notice (`showKybPendingNotice`) instead of attempting to load a review
queue, application/delivery list and contracts (or, for the Machinery
Portal, a rate card and photo gallery) that would all fail the same way.

A second, distinct notice (`showRolePendingNotice`, added for multi-role
support) handles `role_not_verified`: the org has cleared entity KYB but
doesn't (yet) hold a Verified role for *this specific portal* — e.g. a
Lender org that hasn't requested a Buyer role, or has requested one but
it's still `Pending`/`Rejected`. This case is reachable two ways now: a
brand-new org whose entity KYB happens to already be Verified but whose
primary role sync raced oddly (defensive, shouldn't normally happen), and —
the real, common case — an existing org visiting a portal for a role it
requested via `manage-roles.html` but Platform Ops hasn't decided yet. Both
notices link out (KYB notice: nowhere, just "refresh later"; role notice: a
CTA link to `../manage-roles.html`, so the user can see exactly which role
is pending and request others).

In both cases the session is deliberately NOT cleared (unlike a genuine
wrong-subject-type `403`) — the same login persists across the approval, so
the user only ever needs to refresh once approved, not log in again.
`lender/js/api.js`, `buyer/js/api.js`, and `machinery/js/api.js` all
special-case both `403` reasons (`kyb_not_verified` AND `role_not_verified`)
to keep the session alive; every other `403` still bounces to login as
before.

## Multi-role organizations — managing more than one business role

New page: `manage-roles.html` + `js/manage-roles.js`, backing `GET`/`POST
/organization/roles`. See `../backend/README.md`'s "Multi-role
organizations" section for the full backend design (two-layer KYB/role
verification, why every new role needs its own approval, the schema).

Unlike every other page in this project, this one is deliberately **not**
tied to one portal's own `localStorage` session key — an organization's JWT
is the same underlying token regardless of which portal it was issued from
(`POST /auth/login` is shared across all organization portals), so
`findSession()` tries `agrolink_lender_session`,
`agrolink_buyer_session`, and `agrolink_machinery_session` in that fixed
order and uses whichever is present. This lets a Lender who has never
opened the Buyer or Machinery portal still reach this page (via the "จัดการ
บทบาทธุรกิจ" link now on every organization dashboard's header) and request
a Buyer role without logging in again anywhere. If no session is found in
any of the three keys, the page shows a "not logged in" state with links
into all three portal logins instead of erroring.

The page shows three things: the org's own info (name, primary role from
registration, entity KYB status), every role it currently holds as a card
with a status badge (reusing the existing `.badge.status-active/pending/
declined` CSS classes — green/gold/red already meant "approved/pending/
declined" elsewhere in this project, so no new color vocabulary was
introduced), and a form to request one new role from a dropdown of
whatever it doesn't already hold. The dropdown and submit button are
disabled with an explanatory placeholder if entity KYB isn't Verified yet,
or if the org already holds every requestable role type.

The admin side: `admin/dashboard.html` gained a new "🧩 คำขอเพิ่มบทบาทธุรกิจ
ที่รออนุมัติ" section, separate from the existing KYB queue above it, backed
by `GET /admin/role-requests?status=Pending` filtered client-side to
`role_type !== primary_org_type` (so an org's very first/primary role,
already handled by the KYB queue, doesn't show up twice). Each card has its
own approve/reject buttons and an optional reason field, posting to `POST
/admin/organizations/:id/roles/:role_type/status`.

## Running

The backend must already be running on `http://localhost:4000` (see
`../backend/README.md`). Then, from this directory:

```
node serve.js          # serves this directory at http://localhost:5173
```

No `npm install` needed — `serve.js` is a zero-dependency static file
server (`http`/`fs` from Node's standard library only) and serves any
subpath, so all portals are reachable at the same server, no separate
process needed:

- Farmer Portal: `http://localhost:5173/index.html`
- Lender Portal: `http://localhost:5173/lender/index.html`
- Buyer Portal: `http://localhost:5173/buyer/index.html`
- Platform Ops / Admin Portal: `http://localhost:5173/admin/index.html`
- Machinery/Drying-Yard Portal: `http://localhost:5173/machinery/index.html`
- Service-Provider Registration: `http://localhost:5173/register-provider.html`

If the API runs somewhere other than `localhost:4000`, change `API_BASE` at
the top of `js/api.js` (Farmer Portal), `lender/js/api.js` (Lender Portal),
`buyer/js/api.js` (Buyer Portal), `admin/js/api.js` (Admin Portal),
`machinery/js/api.js` (Machinery/Drying-Yard Portal), AND
`js/register-provider.js` (Service-Provider Registration) — they're six
separate copies, not shared, on purpose (see above).

## How it talks to the backend

`js/api.js` and its Lender/Buyer/Admin/Machinery/InputSupplier Portal
counterparts (`lender/js/api.js`, `buyer/js/api.js`, `admin/js/api.js`,
`machinery/js/api.js`, `inputsupplier/js/api.js`) are the only files in
each app that know about HTTP — each wraps `fetch()`, attaches the
`Authorization: Bearer <token>` header once logged in, and centralizes
both 401 handling (expired/invalid token) and 403 handling (a
structurally-valid token for the wrong kind of subject — e.g. a farmer
token used against `/lender/*`, `/buyer/*`, `/admin/*`, `/machinery/*`, or
`/inputsupplier/*`): either way, it clears the stored session and bounces
back to that app's own login page rather than the page just silently
failing. The JWT is kept in `localStorage` under `agrolink_farmer_session`,
`agrolink_lender_session`, `agrolink_buyer_session`,
`agrolink_admin_session`, `agrolink_machinery_session`, or
`agrolink_inputsupplier_session` respectively — normal practice for a real
single-page app; logging out clears it. `buyer/js/api.js` also has a `put()`
helper (added while building this feature — see below) for `PUT
/buyer/price-quotes`, the first Buyer Portal request that ever needed a
verb other than GET/POST.

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
- **Buyer Portal**, tested the same way: logged in as the seeded Buyer org;
  the dashboard showed correct delivery counts and the review queue showed
  exactly the deliveries actually awaiting action. Confirmed a `delivered`
  card's inline quality form ("ผ่านคุณภาพ" with a grade and inspector name
  typed in) correctly moved a real delivery to `accepted`, after which
  clicking "ชำระเงิน (Settle)" on it surfaced a real, specific error toast
  when the buyer's settlement account genuinely didn't have enough balance
  — not a generic failure — and correctly succeeded for a smaller delivery
  within the actual available balance, updating the summary counts without
  a page reload. Recorded a brand-new Spot Sale delivery through the
  on-page form (unit and commodity from live dropdowns, auto-matching the
  commodity to the selected unit). Switching the "ทั้งหมด" status filter to
  `settled` showed the right deliveries; the contracts section showed the
  real forward-purchase contract. Logout returned to the login page.
  Separately confirmed a farmer JWT and a Lender-org JWT are both correctly
  bounced from the Buyer Portal with "บัญชีนี้ไม่ใช่บัญชีผู้รับซื้อผลผลิต" shown.
- **Platform Ops / Admin Portal**, tested the same way: the login page
  correctly showed a Thai error for a wrong passcode and logged straight in
  with the real one; the dashboard rendered the overview cards, the system
  health panel (ledger-balanced and Go-Live-ready badges, one real active
  alert shown with its message and observed value), the KYC queue (one real
  `pending_kyc` farmer), and the KYB queue (a temporary test organization
  inserted specifically for this UI test, removed afterward — not left in
  seed data). Clicking "อนุมัติ KYC" on the real farmer's card moved them to
  `active` and they disappeared from the queue with a success toast, and
  the same farmer then showed up correctly as "ใช้งานได้" in the filterable
  all-farmers list. Clicking "อนุมัติ KYB" on the test organization's card
  approved it and correctly reported no vendor-activation (it had no
  `partner.vendor_profile` row), disappearing from the KYB queue.
  Filtering the all-farmers list to `closed` correctly showed only the
  farmer rejected earlier during backend testing. Logout returned to the
  login page. Screenshots were taken at every step to visually confirm
  correct rendering, not just successful API calls.
- **Service-Provider Registration**, tested with Playwright covering all
  three real code paths: registered a brand-new `TractorService` provider
  (an org_type with no dedicated portal) and confirmed the plain
  "ส่งใบสมัครเรียบร้อยแล้ว" confirmation rendered with the correct org name
  and Thai type label; registered a brand-new `Lender` and confirmed it
  redirected to `lender/dashboard.html`, which correctly showed the
  "รอตรวจสอบ (KYB)" pending notice rather than a broken/empty dashboard;
  re-submitted a duplicate tax ID and confirmed the inline
  "เลขประจำตัวผู้เสียภาษีนี้ถูกใช้สมัครไปแล้ว" error. Separately confirmed, via
  the API directly, that once Platform Ops approves a self-registered
  Lender's KYB, the *same* browser session (no re-login) then sees the real
  dashboard on the next load — and that an existing already-`Verified`
  seeded Lender org (`oidc|org-001`) still loads its full real dashboard
  exactly as before, confirming the new pending-KYB gate didn't regress
  any previously-working login. All test organizations were deleted
  afterward, not left in seed data.
- **Machinery/Drying-Yard Portal**, tested with Playwright: registered a
  brand-new `TractorService` provider through `register-provider.html`,
  confirmed it landed on `machinery/dashboard.html` showing the
  "รอตรวจสอบ (KYB)" pending notice; approved that org's KYB directly via the
  admin API (simulating a Platform Ops action in a separate session) and
  reloaded the page with no re-login, confirming the real dashboard
  (org type, KYB status, `0 / 7` priced items, `0` photos) now rendered
  instead of the pending notice; filled in three of the seven rate-card
  fields (ไถดะ 480, ไถแปรและหว่าน 380, ขนส่งด้วยรถบรรทุก 9.5) and saved,
  confirming the summary card updated to `3 / 7` with a success toast, no
  page reload; uploaded a real image file through the file input with a
  photo-type selection and caption, confirming it appeared in the gallery
  grid immediately and the summary card's photo count updated to `1`; and
  reloaded the whole page from scratch afterward, confirming both the
  rate-card values and the uploaded photo persisted server-side (not just
  held in browser state). Screenshots were taken at each step. One real
  bug was found and fixed via this same testing before the UI pass even
  ran (see the backend README's verification section — the `ON CONFLICT`
  partial-index arbiter mismatch). The temporary test organizations were
  deleted afterward, not left in seed data.
- **Multi-role organizations**, tested with Playwright end-to-end through
  the real UI: registered a brand-new org as `Buyer` via
  `register-provider.html`, approved its primary KYB via the admin API,
  reloaded and confirmed the real Buyer dashboard rendered (regression
  check: an org's original single-role flow is completely unchanged);
  clicked the new "จัดการบทบาทธุรกิจ" link on the Buyer dashboard's header
  and landed on `manage-roles.html`, which correctly auto-detected the
  Buyer session (no separate login) and showed the one held role
  (`ผู้รับซื้อผลผลิต · อนุมัติแล้ว`); requested an additional `TractorService`
  role through the on-page dropdown+button and confirmed it appeared
  immediately as `บริการรถไถ · รอตรวจสอบ` with no page reload; opened the
  Machinery Portal in a second tab with the same underlying session token
  and confirmed it correctly showed the new role-pending notice (not the
  KYB-pending notice, and not a broken dashboard) rather than blocking
  access entirely; on the Admin dashboard's new "🧩 คำขอเพิ่มบทบาทธุรกิจที่รอ
  อนุมัติ" section, confirmed the pending `TractorService` request appeared
  as its own card (correctly distinct from the KYB queue above it) with the
  requesting org's name and its primary role shown for context; clicked
  "อนุมัติบทบาท" on that card and confirmed the machinery tab, on reload,
  now showed the real machinery dashboard with the same session token — no
  re-login anywhere in the whole flow. Screenshots were taken at every
  step. One real bug was found and fixed via this same testing: the
  machinery dashboard's "ประเภทบริการ" (service type) card was echoing the
  org's entity-level primary `org_type` (in this test, literally "Buyer",
  untranslated) instead of the machinery role it actually holds — fixed on
  both backend (`GET /machinery/dashboard` now returns `service_types`, the
  Verified machinery role(s) held) and frontend (renders Thai labels for
  those, joined with " · " for an org holding more than one). The temporary
  test organizations were deleted afterward, not left in seed data.
- **InputSupplier product catalog + Buyer daily rice-price announcements**,
  tested with Playwright end-to-end through the real UI: registered a
  brand-new org as `InputSupplier` via `register-provider.html`, confirmed
  it landed on `inputsupplier/dashboard.html` showing the "รอตรวจสอบ (KYB)"
  pending notice; approved its KYB directly via the admin API and reloaded
  with no re-login, confirming the real dashboard rendered; added two
  products through the on-page form in two different categories (ปุ๋ย/ฮอร์โมน
  and อุปกรณ์การเกษตร), confirming both appeared in the catalog list
  immediately with no page reload; uploaded a real image file to the first
  product's mini-gallery and confirmed it appeared; filtered the catalog to
  just อุปกรณ์การเกษตร and confirmed only the matching product showed;
  clicked "แก้ไข" on the first product, changed its price, saved, and
  confirmed the update applied in place (not a duplicate row); deleted the
  second product and confirmed the summary count dropped accordingly;
  reloaded the whole page from scratch afterward and confirmed the surviving
  product, its edited price, and its uploaded photo all persisted
  server-side. Separately logged into the seeded Buyer org, filled in the
  new "📢 ประกาศราคารับซื้อข้าวเปลือกประจำวัน" form with real prices for two
  grades, saved, reloaded, and confirmed the values persisted; then logged
  in as a seeded farmer, clicked through to the new `rice-prices.html` page
  from the dashboard header, and confirmed the buyer's real saved prices
  appeared there under the correct grade names. **One real bug was found
  and fixed via this testing**: the price-quote form's save button did
  nothing at all — no error, no network request — traced to
  `buyer/js/api.js` never having had a `put()` helper (every prior Buyer
  Portal feature only ever needed `get`/`post`), so the form's own
  `try/catch` was silently swallowing a `TypeError` thrown when calling a
  method that didn't exist. Fixed by adding the missing `put()` helper to
  `buyer/js/api.js`; re-ran the whole suite afterward to confirm the fix
  actually worked, not just that the error went away. Screenshots were
  taken at every step. The five temporary test organizations were deleted
  afterward via a single FK-safe cleanup transaction, not left in seed
  data; the seeded Buyer org's real price quotes from this testing were
  deliberately left in place, matching how other seeded-org feature-testing
  data (e.g. the seeded Lender's loan applications) has been left in place
  elsewhere in this project.
- **Farmer ordering flow against the InputSupplier catalog**, tested with
  Playwright end-to-end through the real UI: registered a fresh
  InputSupplier org via `register-provider.html`, admin-approved it via a
  direct API call, and added three real products through the on-page form
  (three different categories, for the confirm/reject/cancel paths below).
  As a seeded farmer, clicked the new "ตลาดปัจจัยการผลิต" link from the
  dashboard header, landed on `marketplace.html`, filtered the supplier
  dropdown down to the one test supplier, and placed three real orders
  through the on-page quantity input + "สั่งซื้อ" button — confirmed all
  three appeared in the "คำสั่งซื้อของท่าน" section as "รอการยืนยันจากผู้จำหน่าย"
  immediately, no page reload needed. On the supplier side, reloaded
  `inputsupplier/dashboard.html` and confirmed all three orders appeared in
  the new order-review-queue with the correct farmer name, quantities, and
  computed totals; clicked "ยืนยันคำสั่งซื้อ" on one, typed a reason and
  clicked "ปฏิเสธ" on a second, then clicked "บันทึกว่าส่งมอบสินค้าแล้ว" on
  the now-confirmed first order — each action updated the review queue and
  order-history sections immediately. Back on the farmer's side, reloaded
  `marketplace.html` from scratch and confirmed the order history showed
  all three final states correctly: "ส่งมอบแล้ว" for the fulfilled one,
  "ผู้จำหน่ายปฏิเสธ" with the supplier's typed reason visible for the
  rejected one, and — after clicking the third order's own
  "ยกเลิกคำสั่งซื้อ" button and reloading again — "ยกเลิกแล้ว" for the one the
  farmer cancelled themselves. Screenshots were taken at every step.
  Separately verified via curl that a second farmer account cannot see or
  cancel the first farmer's orders, and a second InputSupplier org cannot
  read the first org's order by its real `order_id` — both `404`, not a
  confusing `403`. Regression-checked the seeded Lender/Buyer dashboards
  and the rice-price comparison page still work unaffected. All test
  organizations and their orders/listings/photos were deleted afterward via
  a single FK-safe cleanup transaction, not left in seed data.

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
- The entire `/buyer/*` slice (in `../backend/src/routes/buyer.js`) — backs
  `buyer/dashboard.html`. See the backend README for what it does and the
  real gaps building it surfaced, including a subtle deferred-database-
  trigger bug that only a real committed settlement (not a rolled-back
  test transaction) could have caught.
- `POST /auth/admin-login` and the entire `/admin/*` slice (in
  `../backend/src/routes/auth.js` and `../backend/src/routes/admin.js`) —
  backs `admin/index.html` and `admin/dashboard.html`. See the backend
  README for what it does and a real, non-obvious grant gap building it
  surfaced (`RETURNING` needing `SELECT` privilege in addition to
  `INSERT`, not just a plain missing-grant problem).
- `POST /auth/org-register` (in `../backend/src/routes/auth.js`) — backs
  `register-provider.html`. See the backend README for the widened
  `org_type` database constraint and new grants this surfaced.
- A `kyb_status = 'Verified'` gate added to `requireLenderOrg`/
  `requireBuyerOrg` (in `../backend/src/routes/lender.js` /
  `buyer.js`) — backs the pending-KYB notice in `lender/dashboard.html` /
  `buyer/dashboard.html`. See the backend README for why this became
  necessary once organizations could self-register.
- The entire `/machinery/*` slice (in `../backend/src/routes/machinery.js`)
  — backs `machinery/dashboard.html`. See the backend README for what it
  does, the `service_key`/`vendor_photo` schema changes and grants this
  needed (`marketplace.service_listing` had zero grants at all before
  this), and a real `ON CONFLICT`-vs-partial-index bug building it
  surfaced. Also added `DryingYardService` to `ORG_SELF_REGISTER_TYPES`
  and widened `identity.organization.org_type` to allow it.
- The entire `/organization/*` slice (new file,
  `../backend/src/routes/organization.js`) — backs the new
  `manage-roles.html`. `GET/POST /admin/role-requests` and `POST
  /admin/organizations/:id/roles/:role_type/status` (in
  `../backend/src/routes/admin.js`) — back the admin dashboard's new role-
  request queue. `requireLenderOrg`/`requireBuyerOrg`/`requireMachineryOrg`
  all rewritten to the two-layer entity-KYB + per-role check. See the
  backend README's "Multi-role organizations" section for the full design
  and the new `identity.organization_role` schema
  (`backend/db/grant_organization_roles.sql`).
- The entire `/inputsupplier/*` slice (new file,
  `../backend/src/routes/inputsupplier.js`) — backs
  `inputsupplier/dashboard.html`. See the backend README's "Product catalog
  vs. rate card" section for why this is an open-ended CRUD list rather
  than a fixed-key rate card, and the new `marketplace.product_listing`/
  `marketplace.product_photo` schema
  (`backend/db/grant_input_supplier_and_buy_prices.sql`).
- `GET`/`PUT /buyer/price-quotes` (in `../backend/src/routes/buyer.js`) —
  backs the new price-quote section in `buyer/dashboard.html`.
- `GET /farmer/rice-prices` (in `../backend/src/routes/farmer.js`) — backs
  the new `rice-prices.html` page. See the backend README's "Daily
  rice-buying-price announcements" section for the new
  `registry.rice_grade_ref`/`marketplace.buy_price_quote` schema and why the
  composite primary key was chosen deliberately to avoid a class of bug
  fixed once already elsewhere in this project.
- `GET /farmer/input-suppliers`, `GET /farmer/products`, `GET`/`POST
  /farmer/orders`, `POST /farmer/orders/:id/cancel` (in
  `../backend/src/routes/farmer.js`) and `GET /inputsupplier/orders`,
  `GET /inputsupplier/orders/:id`, `POST /inputsupplier/orders/:id/confirm`
  /`reject`/`fulfill` (in `../backend/src/routes/inputsupplier.js`) — back
  the new `marketplace.html` page and the InputSupplier dashboard's new
  order-review-queue/order-history sections. See the backend README's
  "Farmer ordering flow" section for the new `marketplace.product_order`
  schema (`backend/db/grant_farmer_product_orders.sql`) and why `DELETE
  /inputsupplier/products/:id` switched from a real delete to a deactivate.

## What's next

- Real OIDC login redirect in place of the claim-entry form (once an IdP is
  connected) — see the backend README's mocked/simplified section, since
  this is the same underlying gap.
- Map rendering for production unit boundaries (`gps_boundary` is already
  returned as GeoJSON by the API; this page currently shows it as plain
  attributes only).
- Pagination/filtering once contract and loan-application volumes grow
  beyond what fits comfortably on one page.
- A way to create a brand-new forward-purchase contract through the Buyer
  Portal itself, rather than only recording deliveries against contracts
  that already exist (or as a Spot Sale) — see the backend README.
- Real per-admin accounts for Platform Ops, replacing the single shared
  passcode — see the backend README's "what's mocked" section.
- A self-service onboarding path for `Bank` and `VillageFund` organizations,
  currently excluded from `register-provider.html`'s dropdown — see the
  backend README.
- A dedicated portal for `Logistics` — the one remaining organization type
  `register-provider.html` can already register but that has no dashboard
  of its own yet; right now it just gets a confirmation screen with nowhere
  to log into afterward.
- An onboarding path for `Bank`, `VillageFund`, `Cooperative`, and `Mill` —
  all four excluded from `register-provider.html`'s dropdown entirely, with
  no alternative sign-up path built yet. See the backend README.
- A farmer-facing way to actually browse Machinery/Drying-Yard Portal rate
  cards and photos and book a service — `marketplace.service_request`
  exists in the schema but nothing on either the farmer or machinery side
  reads/writes it yet. See the backend README.
- A historical price archive/chart for the daily rice-buying-price
  announcements — today only the current live quote per grade is stored.
  See the backend README.
- Payment/settlement for `marketplace.product_order` — `POST
  /inputsupplier/orders/:id/fulfill` today is just a status label, no money
  actually moves through the `ledger` schema the way
  `POST /buyer/deliveries/:id/settle` does. See the backend README's
  "Farmer ordering flow" section.
- Stock/quantity awareness on `marketplace.html` and
  `inputsupplier/dashboard.html` — a supplier can be ordered past what they
  can actually supply; there's no inventory count anywhere yet. See the
  backend README.
- An order-quantity edit for a farmer before a supplier confirms — today
  the only actions on a `requested` order are placing it (fixed quantity)
  or cancelling it outright; there's no "change the quantity" step.
- Object storage/CDN for the Machinery/Drying-Yard Portal's photo gallery,
  replacing the base64 `data:` URLs it stores directly in Postgres today.
- Farmer, Lender, Buyer, Platform Ops, and Machinery/Drying-Yard Portals
  are all now built end-to-end (backend + frontend, tested), and
  organizations can now self-register and get approved through the API and
  UI — closing the submit-then-approve loop that was the previous headline
  gap here. The natural next candidates are the gaps just above, or a
  fresh vertical slice (e.g. Logistics, VillageFund) reusing the same
  patterns established here.
