/**
 * AgroLink Cooperative Collection Station — shared API client.
 *
 * Same shape as ../../buyer/js/api.js (Buyer Portal) and every other
 * portal's own copy — kept as its own file for the same reason: a
 * distinct localStorage key so a farmer/buyer/cooperative session in the
 * same browser never collide, and redirect targets that point at this
 * folder's own pages. Talks to the SAME backend routes as buyer.js talks
 * to for /buyer/*, just under the /coop/* prefix (see backend/src/routes/
 * coopcollection.js).
 */
const API_BASE = (["localhost", "127.0.0.1"].includes(window.location.hostname))
  ? "http://localhost:4000"
  : "https://agrolink-backend-vhv6.onrender.com";

const AUTH_STORAGE_KEY = "agrolink_coop_session";

const AgroLinkCoopAPI = (() => {
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
   * uses. A cooperative provisioned via POST /admin/cooperatives logs in
   * with its auth_subject_id (shown in the Platform Ops "รายละเอียดสหกรณ์"
   * detail view), the same mock-OIDC-claim convention as every other
   * organization type.
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
   * Authenticated GET/POST helper — same 401/403 handling shape as
   * ../../buyer/js/api.js's request(). 'kyb_not_verified' and
   * 'role_not_verified' keep the session alive (a real cooperative token,
   * just not yet approved for the Cooperative role) — everything else
   * bounces back to login.
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
      if (body.error === "kyb_not_verified" || body.error === "role_not_verified") {
        const err = new Error(body.error);
        err.status = 403;
        err.body = body;
        throw err;
      }
      clearSession();
      window.location.href = "index.html?reason=not_a_cooperative";
      throw new Error("not_a_cooperative");
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
