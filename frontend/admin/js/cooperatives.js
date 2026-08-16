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

const KYB_STATUS_LABEL = { Pending: "รอตรวจสอบ", Verified: "ผ่านการตรวจสอบแล้ว", Rejected: "ถูกปฏิเสธ" };
function kybStatusBadge(status) {
  const cssClass = { Pending: "status-pending", Verified: "status-active", Rejected: "status-declined" }[status] || `status-${status}`;
  return `<span class="badge ${cssClass}">${escapeHtml(KYB_STATUS_LABEL[status] || status)}</span>`;
}

let provinceCache = [];

// ---------- จังหวัด (สำหรับฟอร์มจัดตั้งสหกรณ์) ----------
async function loadProvinces() {
  const select = document.getElementById("provinceSelect");
  try {
    provinceCache = await AgroLinkAdminAPI.get("/admin/provinces");
    if (provinceCache.length === 0) {
      select.innerHTML = `<option value="">ไม่มีจังหวัดในระบบ</option>`;
      return;
    }
    select.innerHTML = provinceCache
      .map((p) => `<option value="${p.province_code}">${escapeHtml(p.province_name_th)} (${escapeHtml(p.region_th)})</option>`)
      .join("");
  } catch (err) {
    select.innerHTML = `<option value="">โหลดจังหวัดไม่สำเร็จ</option>`;
    toast("โหลดรายชื่อจังหวัดไม่สำเร็จ: " + err.message, true);
  }
}

// ---------- จัดตั้งสหกรณ์ใหม่ ----------
document.getElementById("createCoopBtn").addEventListener("click", async () => {
  const orgName = document.getElementById("orgName").value.trim();
  const taxId = document.getElementById("taxId").value.trim();
  const provinceCode = document.getElementById("provinceSelect").value;
  const coopRegNo = document.getElementById("coopRegNo").value.trim();
  const establishedYear = document.getElementById("establishedYear").value;
  const memberCountReported = document.getElementById("memberCountReported").value;
  const notes = document.getElementById("notes").value.trim();

  if (!orgName || !taxId || !provinceCode) {
    toast("กรุณากรอกชื่อสหกรณ์ เลขทะเบียนนิติบุคคล และเลือกจังหวัด", true);
    return;
  }

  const payload = {
    org_name: orgName,
    tax_id: taxId,
    province_code: provinceCode,
    cooperative_registration_no: coopRegNo || undefined,
    established_year: establishedYear ? Number(establishedYear) : undefined,
    member_count_reported: memberCountReported ? Number(memberCountReported) : undefined,
    notes: notes || undefined,
  };

  const btn = document.getElementById("createCoopBtn");
  btn.disabled = true;
  try {
    await AgroLinkAdminAPI.post("/admin/cooperatives", payload);
    toast("จัดตั้งสหกรณ์เรียบร้อยแล้ว");
    document.getElementById("createCoopForm").reset();
    await loadProvinces();
    await loadCooperatives();
  } catch (err) {
    const reason = (err.body && err.body.error) || err.message;
    toast("จัดตั้งสหกรณ์ไม่สำเร็จ: " + reason, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- รายชื่อสหกรณ์ ----------
function cooperativeCard(c) {
  return `
    <div class="item-card" data-coop-id="${c.org_id}">
      <div class="row">
        <span class="title">${escapeHtml(c.org_name)}</span>
        ${kybStatusBadge(c.kyb_status)}
      </div>
      <div class="detail-line">จังหวัด: ${escapeHtml(c.province_name_th)} (ภาค${escapeHtml(c.region_th)})</div>
      <div class="detail-line muted">
        เลขทะเบียนสหกรณ์: ${escapeHtml(c.cooperative_registration_no || "-")}
        ${c.established_year ? " · จัดตั้งปี " + escapeHtml(c.established_year) : ""}
        ${c.member_count_reported !== null && c.member_count_reported !== undefined ? " · สมาชิกที่แจ้ง " + Number(c.member_count_reported).toLocaleString("th-TH") + " คน" : ""}
      </div>
      <div class="detail-line muted">จัดตั้งเมื่อ ${thaiDate(c.created_at)}</div>
      <div class="action-row">
        <button type="button" class="btn btn-ghost btn-sm" data-view-coop="${c.org_id}">ดูรายละเอียด &amp; สิทธิ์การเข้าถึง</button>
      </div>
    </div>
  `;
}

async function loadCooperatives() {
  const el = document.getElementById("cooperativesSection");
  try {
    const coops = await AgroLinkAdminAPI.get("/admin/cooperatives");
    if (coops.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีสหกรณ์ในระบบ — ใช้ฟอร์มด้านบนเพื่อจัดตั้งสหกรณ์แรก</div>`;
      return;
    }
    el.innerHTML = coops.map(cooperativeCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายชื่อสหกรณ์ไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("cooperativesSection").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-view-coop]");
  if (!btn) return;
  await loadCooperativeDetail(btn.dataset.viewCoop);
});

// Platform Ops viewing a cooperative's registration document — same
// authenticated-blob-fetch pattern as coop/js/dashboard.js's own viewer
// (GET /storage/:id requires a Bearer token, so a plain <a href> can't be
// used). Allowed because storage.js's ownership check treats a 'platform'
// subject as always authorized, regardless of who originally uploaded it.
document.getElementById("cooperativeDetailSection").addEventListener("click", async (e) => {
  const btn = e.target.closest("#viewRegistrationDocumentBtn");
  if (!btn) return;
  const fileId = btn.dataset.fileId;
  btn.disabled = true;
  try {
    const session = AgroLinkAdminAPI.getSession();
    const res = await fetch(`${API_BASE}/storage/${fileId}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
    if (!res.ok) throw new Error(`download_failed_${res.status}`);
    const blob = await res.blob();
    window.open(URL.createObjectURL(blob), "_blank");
  } catch (err) {
    toast("เปิดเอกสารไม่สำเร็จ: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- รายละเอียดสหกรณ์ + สิทธิ์การเข้าถึง ----------
async function loadCooperativeDetail(orgId) {
  const titleEl = document.getElementById("detailSectionTitle");
  const el = document.getElementById("cooperativeDetailSection");
  titleEl.style.display = "block";
  el.style.display = "block";
  el.innerHTML = `<div class="loading-line">กำลังโหลดรายละเอียด…</div>`;
  el.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const data = await AgroLinkAdminAPI.get(`/admin/cooperatives/${orgId}`);
    const c = data.cooperative;
    const rolesHtml = data.roles
      .map((r) => `<div class="detail-line">• <strong>${escapeHtml(r.role_code)}</strong> — ${escapeHtml(r.description)} <span class="muted">(มอบสิทธิ์เมื่อ ${thaiDate(r.granted_at)})</span></div>`)
      .join("");

    el.innerHTML = `
      <div class="panel">
        <div style="font-weight:700; font-size:16px; margin-bottom:10px;">${escapeHtml(c.org_name)} ${kybStatusBadge(c.kyb_status)}</div>
        <div class="detail-line">จังหวัด: ${escapeHtml(c.province_name_th)} (ภาค${escapeHtml(c.region_th)})</div>
        <div class="detail-line">เลขทะเบียนนิติบุคคล: ${escapeHtml(c.tax_id)}</div>
        <div class="detail-line">เลขทะเบียนสหกรณ์: ${escapeHtml(c.cooperative_registration_no || "-")}</div>
        <div class="detail-line">ปีที่จัดตั้ง: ${escapeHtml(c.established_year || "-")}</div>
        <div class="detail-line">จำนวนสมาชิกที่แจ้ง: ${c.member_count_reported !== null && c.member_count_reported !== undefined ? Number(c.member_count_reported).toLocaleString("th-TH") + " คน" : "-"}</div>
        ${c.notes ? `<div class="detail-line muted">หมายเหตุ: ${escapeHtml(c.notes)}</div>` : ""}
        <div class="detail-line muted">Auth Subject (สำหรับเข้าสู่ระบบ): ${escapeHtml(c.auth_subject_id)}</div>
        <div class="detail-line muted">จัดตั้งเมื่อ ${thaiDate(c.created_at)}</div>
        <div class="detail-line">
          เอกสารจดทะเบียน:
          ${c.registration_document_file_id
            ? `<button type="button" class="btn btn-ghost btn-sm" id="viewRegistrationDocumentBtn" data-file-id="${c.registration_document_file_id}" style="margin-left:6px;">${escapeHtml(c.registration_document_filename)} — เปิดดู</button>`
            : `<span class="muted">ยังไม่มีเอกสารแนบ (สหกรณ์ยังไม่ได้อัปโหลด)</span>`}
        </div>
        <div class="detail-line" style="margin-top:6px;">
          <a href="../coop/index.html" target="_blank" rel="noopener">เปิดพอร์ทัลสหกรณ์ (จุดรับซื้อผลผลิต) &rarr;</a>
          — ใช้ Auth Subject ด้านบนเพื่อเข้าสู่ระบบในนามสหกรณ์นี้
        </div>
        <div style="font-weight:700; margin-top:16px; margin-bottom:8px;">สิทธิ์การเข้าถึงที่มอบให้ (ระดับองค์กร)</div>
        ${rolesHtml || `<div class="detail-line muted">ยังไม่มีสิทธิ์ที่มอบให้</div>`}
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายละเอียดไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- เริ่มต้น ----------
document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkAdminAPI.logout());

async function init() {
  await loadProvinces();
  await loadCooperatives();
}

init();
