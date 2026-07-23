/**
 * AgroLink Buyer Portal — shared API client.
 *
 * Same shape as ../../js/api.js (Farmer Portal) and ../../lender/js/api.js
 * (Lender Portal), kept as its own copy for the same reason: a distinct
 * localStorage key so a farmer/lender/buyer session in the same browser
 * never collide, and redirect targets that point at this folder's own
 * pages.
 */
const API_BASE = "http://localhost:4000";

const AUTH_STORAGE_KEY = "agrolink_buyer_session";

const AgroLinkBuyerAPI = (() => {
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
   * Login against POST /auth/login — the SAME endpoint the Farmer and
   * Lender Portals both use. security.resolve_subject_from_external_claim()
   * already resolves a claim to either a farmer or an organization
   * (regardless of org_type), so no separate buyer-login endpoint exists.
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
   * Authenticated GET/POST helper. On 401 (expired/invalid token) OR 403
   * (valid token, but not a Buyer-org subject — e.g. a farmer or a
   * different kind of organization), clears the session and bounces back
   * to login rather than rendering a confusing broken dashboard.
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
      window.location.href = "index.html?reason=not_a_buyer";
      throw new Error("not_a_buyer");
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
