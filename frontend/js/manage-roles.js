/**
 * AgroLink — Manage My Business Roles (multi-role organizations).
 *
 * Backs GET/POST /organization/roles. Unlike every other page in this
 * project, this one is deliberately NOT tied to one portal's own
 * localStorage session key — an organization's JWT is the same underlying
 * token regardless of which portal it was issued from (POST /auth/login is
 * shared), so this page tries every known organization-portal session key
 * in a fixed order and uses whichever is present. This lets a Lender who
 * has never opened the Buyer or Machinery portal still reach this page
 * (e.g. via the link on their Lender dashboard) and request a Buyer role
 * without needing to log in again anywhere.
 */
const API_BASE = (["localhost", "127.0.0.1"].includes(window.location.hostname))
  ? "http://localhost:4000"
  : "https://agrolink-backend.onrender.com";
// Local dev talks to the backend on localhost:4000. Any other hostname
// (i.e. once this file is served from a Render Static Site) talks to the
// deployed backend instead -- update the URL above if the Render backend
// Web Service ends up named something other than "agrolink-backend".
const SESSION_KEYS = ["agrolink_lender_session", "agrolink_buyer_session", "agrolink_machinery_session"];

function findSession() {
  for (const key of SESSION_KEYS) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const session = JSON.parse(raw);
      if (session && session.access_token) return session;
    } catch (e) {
      // ignore malformed entries and keep looking
    }
  }
  return null;
}

const toastEl = document.getElementById("toast");
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = "toast show" + (isError ? " error" : "");
  setTimeout(() => { toastEl.className = "toast"; }, 3200);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function thaiDate(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

// Reuses the existing badge.status-* CSS classes (green/gold/red already
// defined in css/style.css for other status vocab) rather than introducing
// a new color set just for role status.
const ROLE_STATUS_BADGE_CLASS = { Verified: "status-active", Pending: "status-pending", Rejected: "status-declined" };
const ROLE_STATUS_LABEL_TH = { Verified: "อนุมัติแล้ว", Pending: "รอตรวจสอบ", Rejected: "ถูกปฏิเสธ" };

let apiToken = null;

async function api(path, options = {}) {
  const headers = Object.assign({}, options.headers || {}, { Authorization: `Bearer ${apiToken}` });
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_BASE}${path}`, Object.assign({}, options, { headers }));
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

function roleCard(r) {
  const badgeClass = ROLE_STATUS_BADGE_CLASS[r.status] || "";
  const badgeLabel = ROLE_STATUS_LABEL_TH[r.status] || r.status;
  return `
    <div class="item-card">
      <div class="row"><span class="title">${escapeHtml(r.label_th)}</span><span class="badge ${badgeClass}">${escapeHtml(badgeLabel)}</span></div>
      <div class="detail-line muted">
        ขอเพิ่มเมื่อ ${thaiDate(r.requested_at)}
        ${r.decided_at ? " · ตัดสินใจเมื่อ " + thaiDate(r.decided_at) : ""}
        ${r.decided_reason ? " · เหตุผล: " + escapeHtml(r.decided_reason) : ""}
      </div>
    </div>
  `;
}

async function loadRoles() {
  try {
    const d = await api("/organization/roles");
    document.getElementById("orgName").textContent = d.org_name || "-";
    document.getElementById("orgInfoSection").innerHTML = `
      <div class="stat-card"><div class="label">ชื่อองค์กร</div><div class="value" style="font-size:16px;">${escapeHtml(d.org_name)}</div></div>
      <div class="stat-card"><div class="label">บทบาทหลัก (ตอนสมัคร)</div><div class="value" style="font-size:16px;">${escapeHtml(d.primary_org_type)}</div></div>
      <div class="stat-card"><div class="label">สถานะยืนยันตัวตนธุรกิจ (KYB)</div><div class="value" style="font-size:16px;">${escapeHtml(d.entity_kyb_status)}</div></div>
    `;

    const heldEl = document.getElementById("heldRolesSection");
    heldEl.innerHTML = d.roles.length > 0
      ? d.roles.map(roleCard).join("")
      : `<div class="empty-state">ยังไม่มีบทบาทธุรกิจ</div>`;

    const select = document.getElementById("roleTypeSelect");
    if (d.entity_kyb_status !== "Verified") {
      select.innerHTML = `<option value="">ต้องผ่านการยืนยันตัวตนธุรกิจ (KYB) พื้นฐานก่อน จึงจะขอเพิ่มบทบาทได้</option>`;
      document.getElementById("requestRoleBtn").disabled = true;
    } else if (d.requestable_roles.length === 0) {
      select.innerHTML = `<option value="">ท่านมีบทบาทธุรกิจครบทุกประเภทแล้ว</option>`;
      document.getElementById("requestRoleBtn").disabled = true;
    } else {
      select.innerHTML = d.requestable_roles.map((r) => `<option value="${r.role_type}">${escapeHtml(r.label_th)}</option>`).join("");
      document.getElementById("requestRoleBtn").disabled = false;
    }
  } catch (err) {
    document.getElementById("heldRolesSection").innerHTML = `<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("requestRoleBtn").addEventListener("click", async () => {
  const btn = document.getElementById("requestRoleBtn");
  const roleType = document.getElementById("roleTypeSelect").value;
  if (!roleType) return;

  btn.disabled = true;
  try {
    await api("/organization/roles", { method: "POST", body: JSON.stringify({ role_type: roleType }) });
    toast("ส่งคำขอเพิ่มบทบาทเรียบร้อยแล้ว รอการอนุมัติจากเจ้าหน้าที่ผู้ดูแลระบบ");
    await loadRoles();
  } catch (err) {
    const messages = {
      entity_kyb_not_verified: "องค์กรของท่านยังไม่ผ่านการยืนยันตัวตนธุรกิจ (KYB) พื้นฐาน",
      role_already_requested: "ท่านเคยขอบทบาทนี้ไปแล้ว",
    };
    toast(messages[err.body && err.body.error] || "ส่งคำขอไม่สำเร็จ: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

function init() {
  const session = findSession();
  if (!session) {
    document.getElementById("notLoggedInBox").style.display = "block";
    return;
  }
  apiToken = session.access_token;
  document.getElementById("rolesContent").style.display = "block";
  loadRoles();
}

init();
