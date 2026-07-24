/**
 * AgroLink Machinery/Drying-Yard Portal — shared API client.
 *
 * Same shape as ../../lender/js/api.js and ../../buyer/js/api.js, kept as
 * its own copy for the same reason those two are separate from each other:
 * the storage key must be different so a lender/buyer/machinery session in
 * the same browser never collide, and the redirect targets point at this
 * folder's own pages.
 */
const API_BASE = "http://localhost:4000";

const AUTH_STORAGE_KEY = "agrolink_machinery_session";

const AgroLinkMachineryAPI = (() => {
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
   * Login against POST /auth/login — the SAME endpoint every other portal
   * uses. security.resolve_subject_from_external_claim() already resolves
   * claims to either a farmer or an organization, so no separate machinery
   * login endpoint was needed on the backend.
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
   * Authenticated GET/PUT/POST/DELETE helper. On 401 (expired/invalid
   * token), clears the session and bounces back to login. On 403, there
   * are two distinct cases the backend tells apart:
   *   - 'kyb_not_verified': a REAL machinery/drying-yard-org token, just
   *     not yet approved (e.g. freshly self-registered via
   *     register-provider.html). The session is kept — no need to log in
   *     again once approved — and a normal (non-redirecting) error is
   *     thrown so dashboard.js can render a "your application is under
   *     review" state instead.
   *   - anything else (e.g. a farmer token, or a non-machinery organization):
   *     same "get out of here" treatment as an expired token, bounced back
   *     to login with a reason shown inline.
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
      const body = await res.json().catch(() => ({}));
      if (body.error === "kyb_not_verified") {
        const err = new Error("kyb_not_verified");
        err.status = 403;
        err.body = body;
        throw err;
      }
      clearSession();
      window.location.href = "index.html?reason=not_a_machinery_org";
      throw new Error("not_a_machinery_org");
    }

    if (res.status === 204) return null;

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
  const put = (path, data) => request(path, { method: "PUT", body: JSON.stringify(data) });
  const del = (path) => request(path, { method: "DELETE" });

  return {
    getSession,
    requireSessionOrRedirect,
    login,
    logout,
    get,
    post,
    put,
    del,
  };
})();
