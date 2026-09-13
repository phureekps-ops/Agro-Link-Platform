/**
 * AgroLink Farmer Aid Fund Portal (กองทุนสงเคราะห์เกษตรกร) — shared API
 * client.
 *
 * Same shape/copy-per-portal convention as every other org portal's own
 * js/api.js (lender/, buyer/, machinery/, inputsupplier/, ...) — own
 * localStorage key so sessions never collide across portals in the same
 * browser.
 *
 * The one thing THIS portal's login() does differently: 'FarmerAidFund'
 * is a "bundle" org_type (see MULTI_ROLE_ORGANIZATION_ARCHITECTURE.md +
 * grant_farmer_aid_fund_community_enterprise.sql) — once KYB is approved,
 * the same org holds Verified Lender + MachineryService + InputSupplier +
 * Buyer roles all at once. This dashboard's Loans/Machinery/Inputs/Buyer
 * tabs each embed the REAL existing lender/machinery/inputsupplier/buyer
 * portal dashboards (unmodified) via <iframe> rather than re-implementing
 * their UI — and since those portals authenticate purely from their OWN
 * localStorage session key (independent of which frontend URL issued the
 * token), login() here also mirrors the exact same session payload into
 * each sibling portal's key. The backend doesn't care which portal a
 * request "came from" either way — every route only checks the JWT's
 * organization identity plus organization_role rows.
 */
const API_BASE = (["localhost", "127.0.0.1"].includes(window.location.hostname))
  ? "http://localhost:4000"
  : "https://agrolink-backend-vhv6.onrender.com";
// Local dev talks to the backend on localhost:4000. Any other hostname
// (i.e. once this file is served from a Render Static Site) talks to the
// deployed backend instead. Render appends a random suffix to every
// *.onrender.com URL regardless of service name (e.g. "-vhv6" here) --
// if the backend gets redeployed under a new URL, update it above to
// match exactly what's shown on the service's page in the Render
// Dashboard, not just the service name.

const AUTH_STORAGE_KEY = "agrolink_farmeraidfund_session";

// The 4 sibling portals whose real dashboards this portal's own dashboard
// embeds via <iframe> — keyed by the SAME localStorage AUTH_STORAGE_KEY
// each of those portals' own js/api.js reads from.
const SIBLING_SESSION_KEYS = [
  "agrolink_lender_session",
  "agrolink_machinery_session",
  "agrolink_inputsupplier_session",
  "agrolink_buyer_session",
];

const AgroLinkFarmerAidFundAPI = (() => {
  function getSession() {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function setSession(session) {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    // Mirror into every sibling portal's own key too, so their unmodified
    // dashboard.html/js/api.js (loaded here via <iframe>) see a valid
    // session immediately without a second login step.
    SIBLING_SESSION_KEYS.forEach((key) => {
      try {
        localStorage.setItem(key, JSON.stringify(session));
      } catch (e) {
        // Best-effort — a private-browsing quota error here shouldn't break
        // this portal's own login.
      }
    });
  }

  function clearSession() {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    SIBLING_SESSION_KEYS.forEach((key) => {
      try {
        localStorage.removeItem(key);
      } catch (e) {
        // no-op
      }
    });
  }

  function requireSessionOrRedirect() {
    const session = getSession();
    if (!session || !session.access_token) {
      window.location.href = "index.html";
      return null;
    }
    return session;
  }

  /**
   * Login against POST /auth/login — the SAME endpoint every other portal
   * uses. security.resolve_subject_from_external_claim() already resolves
   * claims to whichever subject they belong to, so no separate login
   * endpoint was needed here either.
   */
  async function login(externalSubjectClaim) {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ external_subject_claim: externalSubjectClaim }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `login_failed_${res.status}`);
      err.status = res.status;
      throw err;
    }
    setSession(body);
    return body;
  }

  function logout() {
    clearSession();
    window.location.href = "index.html";
  }

  /**
   * Authenticated GET/POST helper — used by this portal's OWN endpoints
   * only (e.g. GET /organization/roles for the overview tab). The 4
   * embedded iframes make their own requests through their own unmodified
   * api.js files, independent of this one.
   */
  async function request(path, options = {}) {
    const session = getSession();
    const headers = Object.assign({}, options.headers || {});
    if (session && session.access_token) {
      headers["Authorization"] = `Bearer ${session.access_token}`;
    }
    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${API_BASE}${path}`, Object.assign({}, options, { headers }));

    if (res.status === 401) {
      clearSession();
      window.location.href = "index.html?reason=session_expired";
      throw new Error("session_expired");
    }

    const isJson = (res.headers.get("content-type") || "").includes("application/json");
    const body = isJson ? await res.json().catch(() => null) : null;

    if (!res.ok) {
      const err = new Error((body && body.error) || `request_failed_${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  const get = (path) => request(path, { method: "GET" });
  const post = (path, data) => request(path, { method: "POST", body: JSON.stringify(data) });

  return {
    getSession,
    requireSessionOrRedirect,
    login,
    logout,
    get,
    post,
  };
})();
