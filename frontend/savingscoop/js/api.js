/**
 * AgroLink — พอร์ทัลสหกรณ์ออมทรัพย์ (สินเชื่อระหว่างสหกรณ์) — API client
 * รูปแบบเดียวกับ lender/js/api.js: session แยก key ของพอร์ทัลนี้เอง, login ผ่าน POST /auth/login
 * (ทั้งบัญชีหลักขององค์กรและบัญชีเจ้าหน้าที่รายบุคคล — ผู้จัดทำ/ผู้อนุมัติการโอนต้องเป็นคนละคน)
 * Backend: backend/src/routes/coopLending.js (/savings/*)
 */
const API_BASE = (["localhost", "127.0.0.1"].includes(window.location.hostname))
  ? "http://localhost:4000"
  : "https://agrolink-backend-vhv6.onrender.com";

const AUTH_STORAGE_KEY = "agrolink_savingscoop_session";

const AgroLinkSavingsCoopAPI = (() => {
  function getSession() {
    try { return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)); } catch (e) { return null; }
  }
  function setSession(s) { localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(s)); }
  function clearSession() { localStorage.removeItem(AUTH_STORAGE_KEY); }
  function requireSessionOrRedirect() {
    const s = getSession();
    if (!s || !s.access_token) { window.location.href = "index.html"; return null; }
    return s;
  }
  async function login(claim) {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ external_subject_claim: claim }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(body.error || `login_failed_${res.status}`); err.status = res.status; throw err; }
    setSession(body);
    return body;
  }
  function logout() { clearSession(); window.location.href = "index.html"; }
  async function request(path, options = {}) {
    const s = getSession();
    const headers = { ...(options.headers || {}) };
    if (s && s.access_token) headers.Authorization = `Bearer ${s.access_token}`;
    if (options.body) headers["Content-Type"] = "application/json";
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    if (res.status === 401) { clearSession(); window.location.href = "index.html?reason=session_expired"; throw new Error("session_expired"); }
    const body = await res.json().catch(() => null);
    if (res.status === 403 && body && body.error === "kyb_not_verified") { const e = new Error("kyb_not_verified"); e.status = 403; e.body = body; throw e; }
    if (res.status === 403 && body && ["wrong_org_type", "organization_subject_required", "operational_role_does_not_cover_module"].includes(body.error)) {
      clearSession(); window.location.href = `index.html?reason=${body.error}`; throw new Error(body.error);
    }
    if (!res.ok) { const e = new Error((body && body.error) || `request_failed_${res.status}`); e.status = res.status; e.body = body; throw e; }
    return body;
  }
  return {
    getSession, requireSessionOrRedirect, login, logout,
    get: (p) => request(p, { method: "GET" }),
    post: (p, d) => request(p, { method: "POST", body: JSON.stringify(d || {}) }),
  };
})();
