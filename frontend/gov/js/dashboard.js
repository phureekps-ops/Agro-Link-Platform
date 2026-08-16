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
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

function thb(n) {
  return Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2 });
}

const KYB_STATUS_LABEL = { Pending: "รอตรวจสอบ", Verified: "ผ่านการตรวจสอบแล้ว", Rejected: "ถูกปฏิเสธ" };
function kybStatusBadge(status) {
  const cssClass = { Pending: "status-pending", Verified: "status-active", Rejected: "status-declined" }[status] || `status-${status}`;
  return `<span class="badge ${cssClass}">${escapeHtml(KYB_STATUS_LABEL[status] || status)}</span>`;
}

/**
 * Same "account inactive" notice shape as every other portal's KYB-pending
 * notice (see coop/js/dashboard.js's showKybPendingNotice) — happens if
 * Platform Ops deactivates this officer's account after they last logged
 * in (the JWT is still valid until it expires, but security.
 * set_session_context() / GET /gov/me now reject it server-side).
 */
function showInactiveNotice() {
  document.getElementById("mainContainer").innerHTML = `
    <div class="empty-state" style="padding:60px 24px;">
      <div style="font-size:40px; margin-bottom:14px;">⏳</div>
      <div style="font-size:17px; font-weight:700; color:var(--green-900); margin-bottom:8px;">
        บัญชีของท่านถูกปิดใช้งาน
      </div>
      <div style="font-size:14px;">กรุณาติดต่อผู้ดูแลระบบ (Platform Ops)</div>
    </div>
  `;
}

// ---------- ข้อมูลของท่าน ----------
let currentOfficer = null;

function renderProfile(d) {
  currentOfficer = d.officer;
  document.getElementById("officerName").textContent = d.officer.full_name || "-";
  const scopeLabel = d.officer.scope_type === "Province"
    ? `ระดับจังหวัด: ${escapeHtml(d.officer.province_name_th || d.officer.province_code || "-")}`
    : "ระดับประเทศ (เห็นทุกจังหวัด)";
  const rolesHtml = d.roles.map((r) => escapeHtml(r.description)).join(", ") || "-";
  document.getElementById("profileSection").innerHTML = `
    <div class="stat-card"><div class="label">ชื่อ-นามสกุล</div><div class="value" style="font-size:16px;">${escapeHtml(d.officer.full_name)}</div></div>
    <div class="stat-card"><div class="label">ระดับสิทธิ์</div><div class="value" style="font-size:15px;">${scopeLabel}</div></div>
    <div class="stat-card"><div class="label">บทบาท</div><div class="value" style="font-size:14px;">${rolesHtml}</div></div>
  `;
}

async function loadProfile() {
  try {
    const d = await AgroLinkGovAPI.get("/gov/me");
    renderProfile(d);
    return true;
  } catch (err) {
    if (err.message === "officer_not_found_or_inactive") {
      showInactiveNotice();
      return false;
    }
    document.getElementById("profileSection").innerHTML = `<div class="empty-state">โหลดข้อมูลเจ้าหน้าที่ไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    return false;
  }
}

// ---------- สหกรณ์ในเขตความรับผิดชอบ ----------
function cooperativeCard(c) {
  return `
    <div class="item-card" data-coop-id="${c.org_id}">
      <div class="row">
        <span class="title">${escapeHtml(c.org_name)}</span>
        ${kybStatusBadge(c.kyb_status)}
      </div>
      <div class="detail-line">จังหวัด: ${escapeHtml(c.province_name_th)}</div>
      <div class="detail-line muted">
        ${c.established_year ? "จัดตั้งปี " + escapeHtml(c.established_year) : ""}
        ${c.member_count_reported !== null && c.member_count_reported !== undefined ? " · สมาชิกที่แจ้ง " + Number(c.member_count_reported).toLocaleString("th-TH") + " คน" : ""}
        · การรับซื้อ ${Number(c.delivery_count || 0).toLocaleString("th-TH")} รายการ
        · คลัง/ลานตาก ${Number(c.facility_count || 0).toLocaleString("th-TH")} แห่ง
      </div>
      <div class="action-row">
        <button type="button" class="btn btn-ghost btn-sm" data-view-coop="${c.org_id}">ดูรายละเอียด</button>
      </div>
    </div>
  `;
}

async function loadCooperatives() {
  const el = document.getElementById("cooperativesSection");
  try {
    const data = await AgroLinkGovAPI.get("/gov/cooperatives");
    el.innerHTML = data.cooperatives.length === 0
      ? `<div class="empty-state">ยังไม่มีสหกรณ์ในเขตความรับผิดชอบของท่าน</div>`
      : data.cooperatives.map(cooperativeCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายชื่อสหกรณ์ไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("cooperativesSection").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-view-coop]");
  if (!btn) return;
  await loadCooperativeDetail(btn.dataset.viewCoop);
});

async function loadCooperativeDetail(orgId) {
  const titleEl = document.getElementById("detailSectionTitle");
  const el = document.getElementById("cooperativeDetailSection");
  titleEl.style.display = "block";
  el.style.display = "block";
  el.innerHTML = `<div class="loading-line">กำลังโหลดรายละเอียด…</div>`;
  el.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const data = await AgroLinkGovAPI.get(`/gov/cooperatives/${orgId}`);
    const c = data.cooperative;
    const s = data.stats;
    el.innerHTML = `
      <div class="panel">
        <div style="font-weight:700; font-size:16px; margin-bottom:10px;">${escapeHtml(c.org_name)} ${kybStatusBadge(c.kyb_status)}</div>
        <div class="detail-line">จังหวัด: ${escapeHtml(c.province_name_th)}</div>
        <div class="detail-line">เลขทะเบียนสหกรณ์: ${escapeHtml(c.cooperative_registration_no || "-")}</div>
        <div class="detail-line">ปีที่จัดตั้ง: ${escapeHtml(c.established_year || "-")}</div>
        <div class="detail-line">จำนวนสมาชิกที่แจ้ง: ${c.member_count_reported !== null && c.member_count_reported !== undefined ? Number(c.member_count_reported).toLocaleString("th-TH") + " คน" : "-"}</div>
        ${c.notes ? `<div class="detail-line muted">หมายเหตุ: ${escapeHtml(c.notes)}</div>` : ""}
        <div class="detail-line muted">จัดตั้งเมื่อ ${thaiDate(c.created_at)}</div>
        <div style="font-weight:700; margin-top:16px; margin-bottom:8px;">สถิติการดำเนินงาน</div>
        <div class="summary-grid">
          <div class="stat-card"><div class="label">การรับซื้อทั้งหมด</div><div class="value">${Number(s.delivery_count).toLocaleString("th-TH")}</div></div>
          <div class="stat-card"><div class="label">ปริมาณที่ชำระเงินแล้ว (ตัน)</div><div class="value" style="font-size:16px;">${thb(s.settled_quantity_ton)}</div></div>
          <div class="stat-card"><div class="label">คลัง/ลานตาก</div><div class="value">${Number(s.facility_count).toLocaleString("th-TH")}</div></div>
          <div class="stat-card"><div class="label">ชุดการแปรรูป</div><div class="value">${Number(s.processing_batch_count).toLocaleString("th-TH")}</div></div>
          <div class="stat-card"><div class="label">การจัดส่ง</div><div class="value">${Number(s.shipment_count).toLocaleString("th-TH")}</div></div>
        </div>
      </div>
    `;
  } catch (err) {
    if (err.message === "cooperative_out_of_scope") {
      el.innerHTML = `<div class="empty-state">สหกรณ์นี้อยู่นอกเขตความรับผิดชอบของท่าน</div>`;
      return;
    }
    el.innerHTML = `<div class="empty-state">โหลดรายละเอียดไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- ภาพรวมเชิงสถิติ (M14+M15 Analytics, GET /gov/analytics) ----------
function renderMembership(rows) {
  const el = document.getElementById("membershipSection");
  const withData = rows.filter((r) => r.cooperative_count > 0);
  el.innerHTML = withData.length === 0
    ? `<div class="empty-state">ยังไม่มีข้อมูลสมาชิกสหกรณ์ในเขตของท่าน</div>`
    : withData.map((r) => `
      <div class="item-card">
        <div class="row"><span class="title">${escapeHtml(r.province_name_th)}</span></div>
        <div class="detail-line">สหกรณ์ ${Number(r.cooperative_count).toLocaleString("th-TH")} แห่ง · สมาชิกรวมที่แจ้ง ${Number(r.total_members_reported).toLocaleString("th-TH")} คน</div>
        ${r.avg_members_reported_per_coop !== null ? `<div class="detail-line muted">เฉลี่ย ${Number(r.avg_members_reported_per_coop).toLocaleString("th-TH")} คน/สหกรณ์</div>` : ""}
      </div>
    `).join("");
}

function renderDeliveryVolume(rows) {
  const el = document.getElementById("deliveryVolumeSection");
  el.innerHTML = rows.length === 0
    ? `<div class="empty-state">ยังไม่มีข้อมูลการรับซื้อในเขตของท่าน</div>`
    : rows.map((r) => `
      <div class="item-card">
        <div class="row"><span class="title">${escapeHtml(r.commodity_name_th || r.commodity_code)}</span></div>
        <div class="detail-line muted">จังหวัด: ${escapeHtml(r.province_name_th)}</div>
        <div class="detail-line">รับซื้อ ${Number(r.delivery_count).toLocaleString("th-TH")} รายการ · รวม ${Number(r.total_quantity_ton).toLocaleString("th-TH")} ตัน</div>
        ${r.settled_quantity_ton ? `<div class="detail-line muted">ชำระเงินแล้ว ${Number(r.settled_quantity_ton).toLocaleString("th-TH")} ตัน (${thb(r.settled_amount)} บาท)</div>` : ""}
      </div>
    `).join("");
}

function renderWarehouseUtilization(rows) {
  const el = document.getElementById("warehouseUtilizationSection");
  el.innerHTML = rows.length === 0
    ? `<div class="empty-state">ยังไม่มีข้อมูลคลัง/ลานตากในเขตของท่าน</div>`
    : rows.map((r) => `
      <div class="item-card">
        <div class="row"><span class="title">${escapeHtml(r.province_name_th)}</span></div>
        <div class="detail-line">คลัง/ลานตาก ${Number(r.facility_count).toLocaleString("th-TH")} แห่ง · ความจุรวม ${Number(r.total_capacity_ton).toLocaleString("th-TH")} ตัน</div>
        <div class="detail-line muted">ปริมาณคงคลังปัจจุบัน ${Number(r.total_current_quantity_ton).toLocaleString("th-TH")} ตัน ${r.utilization_pct !== null ? `(ใช้พื้นที่ ${r.utilization_pct}%)` : ""}</div>
      </div>
    `).join("");
}

function renderProcessingYield(rows) {
  const el = document.getElementById("processingYieldSection");
  el.innerHTML = rows.length === 0
    ? `<div class="empty-state">ยังไม่มีชุดการแปรรูปที่เสร็จสิ้นในเขตของท่าน</div>`
    : rows.map((r) => `
      <div class="item-card">
        <div class="row"><span class="title">${escapeHtml(r.org_name)} — ${escapeHtml(r.source_commodity_name_th || r.source_commodity_code)}</span></div>
        <div class="detail-line muted">จังหวัด: ${escapeHtml(r.province_name_th)} · ประเภท: ${escapeHtml(r.process_type)}</div>
        <div class="detail-line">ชุดที่เสร็จสิ้น ${Number(r.completed_batch_count).toLocaleString("th-TH")} ชุด · วัตถุดิบ ${Number(r.total_input_ton).toLocaleString("th-TH")} ตัน → ผลผลิต ${Number(r.total_output_ton).toLocaleString("th-TH")} ตัน ${r.yield_pct !== null ? `(${r.yield_pct}%)` : ""}</div>
      </div>
    `).join("");
}

async function loadAnalytics() {
  const sections = ["membershipSection", "deliveryVolumeSection", "warehouseUtilizationSection", "processingYieldSection"];
  try {
    const data = await AgroLinkGovAPI.get("/gov/analytics");
    renderMembership(data.membership);
    renderDeliveryVolume(data.delivery_volume);
    renderWarehouseUtilization(data.warehouse_utilization);
    renderProcessingYield(data.processing_yield);
  } catch (err) {
    sections.forEach((id) => {
      document.getElementById(id).innerHTML = `<div class="empty-state">โหลดข้อมูลสถิติไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    });
  }
}

// ---------- เริ่มต้น ----------
document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkGovAPI.logout());

async function init() {
  const session = AgroLinkGovAPI.requireSessionOrRedirect();
  if (!session) return;

  const ok = await loadProfile();
  if (!ok) return;

  await loadCooperatives();
  await loadAnalytics();
}

init();
