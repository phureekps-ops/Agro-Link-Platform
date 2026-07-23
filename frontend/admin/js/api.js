/**
 * AgroLink Platform Ops / Admin Portal — shared API client.
 *
 * Same shape as ../../js/api.js (Farmer Portal), ../../lender/js/api.js
 * (Lender Portal), and ../../buyer/js/api.js (Buyer Portal) — its own
 * localStorage key so an admin session never collides with a farmer/
 * lender/buyer session open in the same browser.
 *
 * The one real difference from the other three: login here is
 * passcode-based (POST /auth/admin-login), NOT claim-based
 * (POST /auth/login) — there is no per-admin identity table in this
 * sandbox, only a single shared ADMIN_PASSCODE. See index.html / login.js
 * for the full note on why.
 */
const API_BASE = "http://localhost:4000";

const AUTH_STORAGE_KEY = "agrolink_admin_session";

const AgroLinkAdminAPI = (() => {
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
  }

  function clearSession() {
    localStorage.removeItem(AUTH_STORAGE_KEY);
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
   * Login against POST /auth/admin-login — a passcode, not an external
   * subject claim. subject_id is always null for a platform session (see
   * that endpoint's own comments for why).
   */
  async function login(passcode) {
    const res = await fetch(`${API_BASE}/auth/admin-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode }),
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
   * Authenticated GET/POST helper. On 401 (expired/invalid token) OR 403
   * (valid token, but not a platform subject — e.g. a farmer or
   * organization token), clears the session and bounces back to login
   * rather than rendering a confusing broken dashboard.
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
    if (res.status === 403) {
      clearSession();
      window.location.href = "index.html?reason=not_an_admin";
      throw new Error("not_an_admin");
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
