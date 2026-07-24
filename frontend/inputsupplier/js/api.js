/**
 * AgroLink InputSupplier (ผู้จำหน่ายปัจจัยการผลิต) Portal — shared API client.
 *
 * Same shape as ../../machinery/js/api.js and the other organization
 * portals' own copies — its own localStorage key so a lender/buyer/
 * machinery/inputsupplier session in the same browser never collide, and
 * redirect targets point at this folder's own pages.
 */
const API_BASE = (["localhost", "127.0.0.1"].includes(window.location.hostname))
  ? "http://localhost:4000"
  : "https://agrolink-backend.onrender.com";
// Local dev talks to the backend on localhost:4000. Any other hostname
// (i.e. once this file is served from a Render Static Site) talks to the
// deployed backend instead -- update the URL above if the Render backend
// Web Service ends up named something other than "agrolink-backend".

const AUTH_STORAGE_KEY = "agrolink_inputsupplier_session";

const AgroLinkInputSupplierAPI = (() => {
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
   * uses (security.resolve_subject_from_external_claim() already resolves
   * claims to either a farmer or an organization).
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
   * Authenticated GET/PUT/POST/DELETE helper. On 401, clears the session
   * and bounces back to login. On 403, kyb_not_verified / role_not_verified
   * are a REAL inputsupplier-org token just not (yet) approved — keeps the
   * session alive so dashboard.js can render a pending notice instead of
   * bouncing out; any other 403 is treated as a wrong-subject-type token.
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
      window.location.href = "index.html?reason=not_an_input_supplier_org";
      throw new Error("not_an_input_supplier_org");
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
