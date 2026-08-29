const session = AgroLinkAdminAPI.requireSessionOrRedirect();

const toastEl = document.getElementById("toast");
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = "toast show" + (isError ? " error" : "");
  setTimeout(() => { toastEl.className = "toast"; }, 3200);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function thaiDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

const OFFICER_STATUS_LABEL = { Active: "ใช้งานอยู่", Inactive: "ปิดใช้งานแล้ว" };
function officerStatusBadge(status) {
  const cssClass = status === "Active" ? "status-active" : "status-declined";
  return `<span class="badge ${cssClass}">${escapeHtml(OFFICER_STATUS_LABEL[status] || status)}</span>`;
}

const SCOPE_LABEL = { National: "ระดับประเทศ (National)", Province: "ระดับจังหวัด (Province)" };

let provinceCache = [];

// ---------- จังหวัด (สำหรับฟอร์มสร้างเจ้าหน้าที่ระดับจังหวัด) — reuses the SAME
// GET /admin/provinces endpoint cooperatives.js already uses. ----------
async function loadProvinces() {
  const select = document.getElementById("officerProvinceSelect");
  try {
    provinceCache = await AgroLinkAdminAPI.get("/admin/provinces");
    select.innerHTML = provinceCache.length === 0
      ? `<option value="">ไม่มีจังหวัดในระบบ</option>`
      : `<option value="">-- เลือกจังหวัด --</option>` +
        provinceCache.map((p) => `<option value="${p.province_code}">${escapeHtml(p.province_name_th)} (${escapeHtml(p.region_th)})</option>`).join("");
  } catch (err) {
    select.innerHTML = `<option value="">โหลดจังหวัดไม่สำเร็จ</option>`;
  }
}

// ---------- บทบาท gov.* (จาก GET /admin/roles ตัวเดิมที่มีอยู่แล้ว กรองเฉพาะ gov.* ฝั่ง frontend) ----------
async function loadGovRoles() {
  const select = document.getElementById("officerRoleSelect");
  try {
    const roles = await AgroLinkAdminAPI.get("/admin/roles");
    const govRoles = roles.filter((r) => r.role_code.startsWith("gov."));
    select.innerHTML = `<option value="">-- เลือกบทบาท --</option>` +
      govRoles.map((r) => `<option value="${escapeHtml(r.role_code)}">${escapeHtml(r.description || r.role_code)}</option>`).join("");
  } catch (err) {
    select.innerHTML = `<option value="">โหลดบทบาทไม่สำเร็จ</option>`;
  }
}

document.getElementById("officerScopeSelect").addEventListener("change", (e) => {
  document.getElementById("officerProvinceField").style.display = e.target.value === "Province" ? "flex" : "none";
});

// ---------- สร้างเจ้าหน้าที่ใหม่ ----------
document.getElementById("createOfficerBtn").addEventListener("click", async () => {
  const fullName = document.getElementById("officerFullName").value.trim();
  const nationalId = document.getElementById("officerNationalId").value.trim();
  const scopeType = document.getElementById("officerScopeSelect").value;
  const provinceCode = document.getElementById("officerProvinceSelect").value;
  const roleCode = document.getElementById("officerRoleSelect").value;
  const createdBy = document.getElementById("officerCreatedBy").value.trim();

  if (!fullName || !nationalId || !scopeType || !roleCode || !createdBy) {
    toast("กรุณากรอกข้อมูลให้ครบทุกช่อง", true);
    return;
  }
  if (scopeType === "Province" && !provinceCode) {
    toast("กรุณาเลือกจังหวัดที่รับผิดชอบสำหรับเจ้าหน้าที่ระดับจังหวัด", true);
    return;
  }

  const payload = {
    full_name: fullName,
    national_id: nationalId,
    scope_type: scopeType,
    province_code: scopeType === "Province" ? provinceCode : undefined,
    role_code: roleCode,
    created_by: createdBy,
  };

  const btn = document.getElementById("createOfficerBtn");
  btn.disabled = true;
  try {
    const result = await AgroLinkAdminAPI.post("/admin/government-officers", payload);
    toast(`สร้างบัญชีเรียบร้อยแล้ว — รหัสเข้าสู่ระบบ: ${result.auth_subject_id} (กรุณาคัดลอกไว้แจ้งเจ้าหน้าที่)`);
    document.getElementById("createOfficerForm").reset();
    document.getElementById("officerProvinceField").style.display = "none";
    await loadOfficers();
  } catch (err) {
    const reason = (err.body && err.body.error) || err.message;
    toast("สร้างบัญชีไม่สำเร็จ: " + reason, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- รายชื่อเจ้าหน้าที่ ----------
function officerCard(o) {
  const scopeLine = o.scope_type === "Province"
    ? `ระดับจังหวัด: ${escapeHtml(o.province_name_th || o.province_code || "-")}`
    : "ระดับประเทศ (เห็นทุกจังหวัด)";
  return `
    <div class="item-card" data-officer-id="${o.officer_id}">
      <div class="row">
        <span class="title">${escapeHtml(o.full_name)}</span>
        ${officerStatusBadge(o.status)}
      </div>
      <div class="detail-line">${scopeLine}</div>
      <div class="detail-line muted">บทบาท: ${escapeHtml(o.role_description || o.role_code || "-")}</div>
      <div class="detail-line muted">สร้างเมื่อ ${thaiDate(o.created_at)} โดย ${escapeHtml(o.created_by)}</div>
      <div class="action-row">
        <button type="button" class="btn btn-ghost btn-sm" data-view-officer="${o.officer_id}">ดูรายละเอียด</button>
      </div>
    </div>
  `;
}

async function loadOfficers() {
  const el = document.getElementById("officersSection");
  try {
    const officers = await AgroLinkAdminAPI.get("/admin/government-officers");
    el.innerHTML = officers.length === 0
      ? `<div class="empty-state">ยังไม่มีเจ้าหน้าที่ภาครัฐในระบบ — ใช้ฟอร์มด้านบนเพื่อสร้างรายการแรก</div>`
      : officers.map(officerCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายชื่อเจ้าหน้าที่ไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("officersSection").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-view-officer]");
  if (!btn) return;
  await loadOfficerDetail(btn.dataset.viewOfficer);
});

// ---------- รายละเอียดเจ้าหน้าที่ ----------
async function loadOfficerDetail(officerId) {
  const titleEl = document.getElementById("detailSectionTitle");
  const el = document.getElementById("officerDetailSection");
  titleEl.style.display = "block";
  el.style.display = "block";
  el.innerHTML = `<div class="loading-line">กำลังโหลดรายละเอียด…</div>`;
  el.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const data = await AgroLinkAdminAPI.get(`/admin/government-officers/${officerId}`);
    const o = data.officer;
    const scopeLine = o.scope_type === "Province"
      ? `ระดับจังหวัด: ${escapeHtml(o.province_name_th || o.province_code || "-")}`
      : "ระดับประเทศ (เห็นทุกจังหวัด)";
    const rolesHtml = data.roles
      .map((r) => `<div class="detail-line">• <strong>${escapeHtml(r.role_code)}</strong> — ${escapeHtml(r.description)} <span class="muted">(มอบสิทธิ์เมื่อ ${thaiDate(r.granted_at)})</span></div>`)
      .join("");

    const deactivateBtn = o.status === "Active"
      ? `<button type="button" class="btn btn-decline btn-sm" data-deactivate-officer="${o.officer_id}" style="margin-top:10px;">ปิดใช้งานบัญชี</button>`
      : "";

    el.innerHTML = `
      <div class="panel">
        <div style="font-weight:700; font-size:16px; margin-bottom:10px;">${escapeHtml(o.full_name)} ${officerStatusBadge(o.status)}</div>
        <div class="detail-line">${scopeLine}</div>
        <div class="detail-line muted">Auth Subject (สำหรับเข้าสู่ระบบ): ${escapeHtml(o.auth_subject_id)}</div>
        <div class="detail-line muted">สร้างเมื่อ ${thaiDate(o.created_at)} โดย ${escapeHtml(o.created_by)}</div>
        <div class="detail-line" style="margin-top:6px;">
          <a href="../gov/index.html" target="_blank" rel="noopener">เปิดพอร์ทัลเจ้าหน้าที่ภาครัฐ &rarr;</a>
          — ใช้ Auth Subject ด้านบนเพื่อเข้าสู่ระบบในนามเจ้าหน้าที่ท่านนี้
        </div>
        <div style="font-weight:700; margin-top:16px; margin-bottom:8px;">สิทธิ์การเข้าถึงที่มอบให้</div>
        ${rolesHtml || `<div class="detail-line muted">ยังไม่มีสิทธิ์ที่มอบให้</div>`}
        ${deactivateBtn}
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายละเอียดไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("officerDetailSection").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-deactivate-officer]");
  if (!btn) return;
  const officerId = btn.dataset.deactivateOfficer;
  if (!confirm("ยืนยันปิดใช้งานบัญชีเจ้าหน้าที่ท่านนี้?")) return;
  btn.disabled = true;
  try {
    await AgroLinkAdminAPI.post(`/admin/government-officers/${officerId}/deactivate`, {});
    toast("ปิดใช้งานบัญชีเรียบร้อยแล้ว");
    await loadOfficerDetail(officerId);
    await loadOfficers();
  } catch (err) {
    toast("ปิดใช้งานไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
    btn.disabled = false;
  }
});

// ---------- เริ่มต้น ----------
document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkAdminAPI.logout());

async function init() {
  await Promise.all([loadProvinces(), loadGovRoles()]);
  await loadOfficers();
}

init();
