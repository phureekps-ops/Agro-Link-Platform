/**
 * AgroLink Government Officer Portal — shared API client.
 *
 * Same shape as ../../lender/js/api.js and every other portal's own copy —
 * own storage key so a government officer session never collides with any
 * other subject type's session in the same browser, and redirect targets
 * point at this folder's own pages. Talks to backend/src/routes/
 * government.js under the /gov/* prefix (see grant_staff_and_government_
 * access.sql for how a government_officer identity is created and how it
 * logs in — the SAME POST /auth/login every other subject type uses).
 */
const API_BASE = (["localhost", "127.0.0.1"].includes(window.location.hostname))
  ? "http://localhost:4000"
  : "https://agrolink-backend-vhv6.onrender.com";

const AUTH_STORAGE_KEY = "agrolink_gov_session";

const AgroLinkGovAPI = (() => {
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
   * Authenticated GET helper (government.js is read-only, so no post()
   * export is needed — see that route file's own doc comment). On 401,
   * bounces to login. On 403 there are THREE distinct cases the backend
   * tells apart, and only one of them should ever log the officer out:
   *   - 'government_officer_subject_required': not a government_officer
   *     token at all (e.g. a farmer/org token) — bounce to login.
   *   - 'officer_not_found_or_inactive': a REAL government_officer token,
   *     but the officer record was deactivated by Platform Ops — keep the
   *     session (so the error message can be shown in place) but throw a
   *     normal, non-redirecting error.
   *   - 'cooperative_out_of_scope': a perfectly valid, active officer
   *     session; they just asked for a cooperative outside their own
   *     province scope. This is an ordinary in-app denial, NOT a login
   *     problem — must never clear the session or redirect.
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
      if (body.error === "officer_not_found_or_inactive" || body.error === "cooperative_out_of_scope") {
        const err = new Error(body.error);
        err.status = 403;
        err.body = body;
        throw err;
      }
      clearSession();
      window.location.href = "index.html?reason=not_a_government_officer";
      throw new Error("not_a_government_officer");
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

  return {
    getSession,
    requireSessionOrRedirect,
    login,
    logout,
    get,
  };
})();
