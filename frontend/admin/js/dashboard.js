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

const FARMER_STATUS_LABEL = {
  pending_kyc: "รอตรวจสอบ KYC", active: "ใช้งานได้", suspended: "ถูกระงับ", closed: "ปิดบัญชี/ถูกปฏิเสธ",
};
const KYB_STATUS_LABEL = { Pending: "รอตรวจสอบ", Verified: "ผ่านการตรวจสอบแล้ว", Rejected: "ถูกปฏิเสธ" };
const ORG_TYPE_LABEL = {
  Cooperative: "สหกรณ์", Mill: "โรงสี", Bank: "ธนาคาร", InputSupplier: "ผู้จำหน่ายปัจจัยการผลิต",
  Lender: "ผู้ปล่อยกู้", Logistics: "โลจิสติกส์", Buyer: "ผู้รับซื้อผลผลิต", VillageFund: "กองทุนหมู่บ้าน",
  TractorService: "บริการรถไถ", DroneService: "บริการโดรน/ฉีดพ่นสารเคมี", HarvesterService: "บริการรถเกี่ยวข้าว",
  TruckService: "บริการรถบรรทุก", DryingYardService: "บริการลานตากข้าว",
};

// Farmer statuses reuse the same generic badge palette as everywhere else:
// active -> green, pending_kyc/suspended -> gold (needs attention),
// closed -> red. KYB statuses map the same way (Verified/Pending/Rejected).
function farmerStatusBadge(status) {
  const cssClass = { pending_kyc: "status-pending", active: "status-active", suspended: "status-pending", closed: "status-declined" }[status] || `status-${status}`;
  return `<span class="badge ${cssClass}">${escapeHtml(FARMER_STATUS_LABEL[status] || status)}</span>`;
}
function kybStatusBadge(status) {
  const cssClass = { Pending: "status-pending", Verified: "status-active", Rejected: "status-declined" }[status] || `status-${status}`;
  return `<span class="badge ${cssClass}">${escapeHtml(KYB_STATUS_LABEL[status] || status)}</span>`;
}

// ---------- ภาพรวม + สุขภาพระบบ ----------
async function loadSummaryAndHealth() {
  const summaryEl = document.getElementById("summarySection");
  const healthEl = document.getElementById("healthSection");
  try {
    const d = await AgroLinkAdminAPI.get("/admin/dashboard");
    summaryEl.innerHTML = `
      <div class="stat-card"><div class="label">เกษตรกรรอ KYC</div><div class="value">${d.pending_kyc_count}</div></div>
      <div class="stat-card"><div class="label">องค์กรรอ KYB</div><div class="value">${d.pending_kyb_count}</div></div>
      <div class="stat-card"><div class="label">เกษตรกรใช้งานได้</div><div class="value">${d.farmers_by_status.active}</div></div>
      <div class="stat-card"><div class="label">เกษตรกรถูกระงับ/ปิดบัญชี</div><div class="value">${d.farmers_by_status.suspended + d.farmers_by_status.closed}</div></div>
      <div class="stat-card"><div class="label">องค์กรผ่านการตรวจสอบแล้ว</div><div class="value">${d.organizations_by_kyb_status.Verified}</div></div>
    `;

    const h = d.system_health;
    const balancedBadge = h.ledger_balanced
      ? `<span class="badge status-active">สมดุล</span>` : `<span class="badge status-declined">ไม่สมดุล!</span>`;
    const readyBadge = h.go_live_ready
      ? `<span class="badge status-active">พร้อม</span>` : `<span class="badge status-pending">ยังไม่พร้อม</span>`;
    healthEl.innerHTML = `
      <div class="stat-card"><div class="label">งบบัญชีคงเหลือ (Ledger)</div><div class="value" style="font-size:16px;">${balancedBadge}</div><div class="sub">เดบิตรวม ${Number(h.integrity.total_debit).toLocaleString("th-TH", {minimumFractionDigits:2})} = เครดิตรวม ${Number(h.integrity.total_credit).toLocaleString("th-TH", {minimumFractionDigits:2})}</div></div>
      <div class="stat-card"><div class="label">ความพร้อม Go-Live</div><div class="value" style="font-size:16px;">${readyBadge}</div><div class="sub">${h.go_live_readiness.passed_items}/${h.go_live_readiness.total_items} รายการผ่าน</div></div>
      <div class="stat-card"><div class="label">การแจ้งเตือนที่ยังทำงานอยู่</div><div class="value">${h.active_alerts_count}</div></div>
      <div class="stat-card"><div class="label">เกษตรกร / องค์กรในระบบ</div><div class="value" style="font-size:16px;">${h.integrity.farmer_count} / ${h.integrity.organization_count}</div></div>
    `;

    await loadAlertsIfAny(h.active_alerts_count);
  } catch (err) {
    summaryEl.innerHTML = `<div class="empty-state">โหลดข้อมูลภาพรวมไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    healthEl.innerHTML = "";
  }
}

async function loadAlertsIfAny(count) {
  const el = document.getElementById("alertsSection");
  if (!count) {
    el.innerHTML = "";
    return;
  }
  try {
    const health = await AgroLinkAdminAPI.get("/admin/system-health");
    el.innerHTML = health.active_alerts.map((a) => `
      <div class="item-card">
        <div class="row"><span class="title">${escapeHtml(a.metric_name || a.source || "แจ้งเตือน")}</span><span class="badge sev-${a.severity}">${escapeHtml(a.severity)}</span></div>
        <div class="detail-line">${escapeHtml(a.message || "-")}</div>
        <div class="detail-line muted">เกิดเมื่อ ${thaiDate(a.fired_at)}${a.observed_value !== null && a.observed_value !== undefined ? " · ค่าที่พบ: " + a.observed_value : ""}</div>
      </div>
    `).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการแจ้งเตือนไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- คิว KYC เกษตรกร ----------
function kycCard(f) {
  return `
    <div class="item-card" data-farmer-id="${f.farmer_id}">
      <div class="row"><span class="title">${escapeHtml(f.full_name)}</span>${farmerStatusBadge(f.status)}</div>
      <div class="detail-line">โทร ${escapeHtml(f.phone || "-")} · พื้นที่ ${escapeHtml(f.region_code || "-")}</div>
      <div class="detail-line muted">คะแนนความน่าเชื่อถือ: ${f.trust_score !== null && f.trust_score !== undefined ? f.trust_score : "-"} · สมัครเมื่อ ${thaiDate(f.created_at)}</div>
      <div class="action-row">
        <input type="text" class="reason-input" placeholder="เหตุผล (ถ้าปฏิเสธ)" />
      </div>
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm approve-kyc-btn">อนุมัติ KYC</button>
        <button type="button" class="btn btn-decline btn-sm reject-kyc-btn">ปฏิเสธ</button>
      </div>
    </div>
  `;
}

async function loadKycQueue() {
  const el = document.getElementById("kycQueueSection");
  try {
    const farmers = await AgroLinkAdminAPI.get("/admin/farmers?status=pending_kyc");
    if (farmers.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีคำขอ KYC ที่รออนุมัติในขณะนี้</div>`;
      return;
    }
    el.innerHTML = farmers.map(kycCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำขอ KYC ไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("kycQueueSection").addEventListener("click", async (e) => {
  const card = e.target.closest(".item-card");
  if (!card) return;
  const farmerId = card.dataset.farmerId;
  const reason = card.querySelector(".reason-input") ? card.querySelector(".reason-input").value.trim() : "";

  if (e.target.classList.contains("approve-kyc-btn") || e.target.classList.contains("reject-kyc-btn")) {
    const approve = e.target.classList.contains("approve-kyc-btn");
    e.target.disabled = true;
    try {
      await AgroLinkAdminAPI.post(`/admin/farmers/${farmerId}/status`, {
        status: approve ? "active" : "closed",
        reason: reason || undefined,
      });
      toast(approve ? "อนุมัติ KYC เรียบร้อยแล้ว" : "ปฏิเสธ KYC เรียบร้อยแล้ว");
      await refreshAll();
    } catch (err) {
      toast("ดำเนินการไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      e.target.disabled = false;
    }
  }
});

// ---------- คิว KYB องค์กร ----------
function kybCard(o) {
  return `
    <div class="item-card" data-org-id="${o.org_id}">
      <div class="row"><span class="title">${escapeHtml(o.org_name)}</span>${kybStatusBadge(o.kyb_status)}</div>
      <div class="detail-line">ประเภท: ${escapeHtml(ORG_TYPE_LABEL[o.org_type] || o.org_type)}</div>
      <div class="detail-line muted">สมัครเมื่อ ${thaiDate(o.created_at)}</div>
      <div class="action-row">
        <input type="text" class="reason-input" placeholder="เหตุผล (ถ้าปฏิเสธ)" />
      </div>
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm approve-kyb-btn">อนุมัติ KYB</button>
        <button type="button" class="btn btn-decline btn-sm reject-kyb-btn">ปฏิเสธ</button>
      </div>
    </div>
  `;
}

async function loadKybQueue() {
  const el = document.getElementById("kybQueueSection");
  try {
    const orgs = await AgroLinkAdminAPI.get("/admin/organizations?kyb_status=Pending");
    if (orgs.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีคำขอ KYB ที่รออนุมัติในขณะนี้</div>`;
      return;
    }
    el.innerHTML = orgs.map(kybCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำขอ KYB ไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("kybQueueSection").addEventListener("click", async (e) => {
  const card = e.target.closest(".item-card");
  if (!card) return;
  const orgId = card.dataset.orgId;
  const reason = card.querySelector(".reason-input") ? card.querySelector(".reason-input").value.trim() : "";

  if (e.target.classList.contains("approve-kyb-btn") || e.target.classList.contains("reject-kyb-btn")) {
    const approve = e.target.classList.contains("approve-kyb-btn");
    e.target.disabled = true;
    try {
      const result = await AgroLinkAdminAPI.post(`/admin/organizations/${orgId}/kyb-status`, {
        kyb_status: approve ? "Verified" : "Rejected",
        reason: reason || undefined,
      });
      toast(approve
        ? "อนุมัติ KYB เรียบร้อยแล้ว" + (result.vendor_activated ? " (เปิดใช้งานบัญชีธุรกิจแล้ว)" : "")
        : "ปฏิเสธ KYB เรียบร้อยแล้ว");
      await refreshAll();
    } catch (err) {
      toast("ดำเนินการไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      e.target.disabled = false;
    }
  }
});

// ---------- คิวคำขอเพิ่มบทบาทธุรกิจ ----------
/**
 * GET /admin/role-requests?status=Pending returns EVERY organization_role
 * row with that status — including a brand-new org's PRIMARY role, which
 * is already covered by the KYB queue above (kept in sync automatically,
 * see admin.js). Filtering those out here (role_type === primary_org_type)
 * keeps this queue showing only genuinely separate, later-requested roles
 * — see the doc comment on GET /admin/role-requests in src/routes/admin.js.
 */
function roleRequestCard(r) {
  return `
    <div class="item-card" data-org-id="${r.org_id}" data-role-type="${escapeHtml(r.role_type)}">
      <div class="row"><span class="title">${escapeHtml(r.org_name)} — ${escapeHtml(ORG_TYPE_LABEL[r.role_type] || r.role_type)}</span>${kybStatusBadge(r.status)}</div>
      <div class="detail-line">บทบาทหลักเดิม: ${escapeHtml(ORG_TYPE_LABEL[r.primary_org_type] || r.primary_org_type)}</div>
      <div class="detail-line muted">ขอเพิ่มเมื่อ ${thaiDate(r.requested_at)}</div>
      <div class="action-row">
        <input type="text" class="reason-input" placeholder="เหตุผล (ถ้าปฏิเสธ)" />
      </div>
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm approve-role-btn">อนุมัติบทบาท</button>
        <button type="button" class="btn btn-decline btn-sm reject-role-btn">ปฏิเสธ</button>
      </div>
    </div>
  `;
}

async function loadRoleRequestQueue() {
  const el = document.getElementById("roleRequestQueueSection");
  try {
    const requests = await AgroLinkAdminAPI.get("/admin/role-requests?status=Pending");
    const secondaryOnly = requests.filter((r) => r.role_type !== r.primary_org_type);
    if (secondaryOnly.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีคำขอเพิ่มบทบาทธุรกิจที่รออนุมัติในขณะนี้</div>`;
      return;
    }
    el.innerHTML = secondaryOnly.map(roleRequestCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำขอเพิ่มบทบาทธุรกิจไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("roleRequestQueueSection").addEventListener("click", async (e) => {
  const card = e.target.closest(".item-card");
  if (!card) return;
  const orgId = card.dataset.orgId;
  const roleType = card.dataset.roleType;
  const reason = card.querySelector(".reason-input") ? card.querySelector(".reason-input").value.trim() : "";

  if (e.target.classList.contains("approve-role-btn") || e.target.classList.contains("reject-role-btn")) {
    const approve = e.target.classList.contains("approve-role-btn");
    e.target.disabled = true;
    try {
      const result = await AgroLinkAdminAPI.post(`/admin/organizations/${orgId}/roles/${roleType}/status`, {
        status: approve ? "Verified" : "Rejected",
        reason: reason || undefined,
      });
      toast(approve
        ? "อนุมัติบทบาทเรียบร้อยแล้ว" + (result.vendor_activated ? " (เปิดใช้งานบัญชีธุรกิจแล้ว)" : "")
        : "ปฏิเสธคำขอบทบาทเรียบร้อยแล้ว");
      await refreshAll();
    } catch (err) {
      toast("ดำเนินการไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      e.target.disabled = false;
    }
  }
});

// ---------- เกษตรกรทั้งหมด (อ่านอย่างเดียว) ----------
async function loadAllFarmers() {
  const el = document.getElementById("allFarmersSection");
  const status = document.getElementById("farmerStatusFilter").value;
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  try {
    const farmers = await AgroLinkAdminAPI.get(`/admin/farmers${query}`);
    if (farmers.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีเกษตรกรในสถานะนี้</div>`;
      return;
    }
    el.innerHTML = farmers.map((f) => `
      <div class="item-card">
        <div class="row"><span class="title">${escapeHtml(f.full_name)}</span>${farmerStatusBadge(f.status)}</div>
        <div class="detail-line">โทร ${escapeHtml(f.phone || "-")} · พื้นที่ ${escapeHtml(f.region_code || "-")}</div>
        <div class="detail-line muted">คะแนนความน่าเชื่อถือ: ${f.trust_score !== null && f.trust_score !== undefined ? f.trust_score : "-"} · สมัครเมื่อ ${thaiDate(f.created_at)}</div>
      </div>
    `).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายชื่อเกษตรกรไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}
document.getElementById("farmerStatusFilter").addEventListener("change", () => loadAllFarmers());

// ---------- องค์กรทั้งหมด (อ่านอย่างเดียว) ----------
async function loadAllOrgs() {
  const el = document.getElementById("allOrgsSection");
  const kybStatus = document.getElementById("orgKybFilter").value;
  const query = kybStatus ? `?kyb_status=${encodeURIComponent(kybStatus)}` : "";
  try {
    const orgs = await AgroLinkAdminAPI.get(`/admin/organizations${query}`);
    if (orgs.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีองค์กรในสถานะนี้</div>`;
      return;
    }
    el.innerHTML = orgs.map((o) => `
      <div class="item-card">
        <div class="row"><span class="title">${escapeHtml(o.org_name)}</span>${kybStatusBadge(o.kyb_status)}</div>
        <div class="detail-line">ประเภท: ${escapeHtml(ORG_TYPE_LABEL[o.org_type] || o.org_type)}${o.verified_badge ? " · ✅ ยืนยันแล้ว" : ""}</div>
        <div class="detail-line muted">
          สถานะธุรกิจ: ${escapeHtml(o.commercial_status || "ยังไม่เปิดใช้งาน")}${o.activated_at ? " · เปิดใช้งานเมื่อ " + thaiDate(o.activated_at) : ""}
        </div>
      </div>
    `).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายชื่อองค์กรไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}
document.getElementById("orgKybFilter").addEventListener("change", () => loadAllOrgs());

// ---------- เนื้อหา "เกี่ยวกับเรา" (about.html) ----------
function aboutSectionCard(s) {
  return `
    <div class="item-card" data-section-id="${s.section_id}">
      <div class="form-grid">
        <div class="field">
          <label>ชื่อหัวข้อที่แสดงบนเว็บ</label>
          <input type="text" class="about-title-input" value="${escapeHtml(s.title)}" />
        </div>
        <div class="field">
          <label>ลำดับการแสดงผล</label>
          <input type="number" class="about-order-input" value="${s.display_order}" />
        </div>
        <div class="field full">
          <label>เนื้อหา/คำอธิบาย</label>
          <textarea class="about-body-input" rows="4">${escapeHtml(s.body)}</textarea>
        </div>
        <div class="field">
          <label>สถานะการแสดงผล</label>
          <select class="about-active-select">
            <option value="true" ${s.is_active ? "selected" : ""}>แสดงบนเว็บ</option>
            <option value="false" ${!s.is_active ? "selected" : ""}>ซ่อนไว้ก่อน (ยังไม่ลบ)</option>
          </select>
        </div>
      </div>
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm save-about-btn">บันทึกการแก้ไข</button>
        <button type="button" class="btn btn-decline btn-sm delete-about-btn">ลบหัวข้อนี้ทิ้ง</button>
      </div>
    </div>
  `;
}

async function loadAboutSections() {
  const el = document.getElementById("aboutSectionsList");
  try {
    const sections = await AgroLinkAdminAPI.get("/admin/about-sections");
    if (sections.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีเนื้อหา — เพิ่มหัวข้อแรกได้ที่ฟอร์มด้านล่าง</div>`;
      return;
    }
    el.innerHTML = sections.map(aboutSectionCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดเนื้อหาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("aboutSectionsList").addEventListener("click", async (e) => {
  const card = e.target.closest(".item-card");
  if (!card) return;
  const sectionId = card.dataset.sectionId;

  if (e.target.classList.contains("save-about-btn")) {
    const title = card.querySelector(".about-title-input").value.trim();
    const body = card.querySelector(".about-body-input").value.trim();
    const displayOrder = Number(card.querySelector(".about-order-input").value);
    const isActive = card.querySelector(".about-active-select").value === "true";
    if (!title || !body) {
      toast("กรุณากรอกชื่อหัวข้อและเนื้อหาให้ครบ", true);
      return;
    }
    e.target.disabled = true;
    try {
      await AgroLinkAdminAPI.put(`/admin/about-sections/${sectionId}`, {
        title, body, display_order: Number.isFinite(displayOrder) ? displayOrder : 0, is_active: isActive,
      });
      toast("บันทึกการแก้ไขเรียบร้อยแล้ว");
      await loadAboutSections();
    } catch (err) {
      toast("บันทึกไม่สำเร็จ: " + err.message, true);
      e.target.disabled = false;
    }
  }

  if (e.target.classList.contains("delete-about-btn")) {
    e.target.disabled = true;
    try {
      await AgroLinkAdminAPI.del(`/admin/about-sections/${sectionId}`);
      toast("ลบหัวข้อเรียบร้อยแล้ว");
      await loadAboutSections();
    } catch (err) {
      toast("ลบไม่สำเร็จ: " + err.message, true);
      e.target.disabled = false;
    }
  }
});

document.getElementById("addAboutSectionBtn").addEventListener("click", async () => {
  const btn = document.getElementById("addAboutSectionBtn");
  const title = document.getElementById("newAboutTitle").value.trim();
  const body = document.getElementById("newAboutBody").value.trim();
  const displayOrder = Number(document.getElementById("newAboutOrder").value);
  if (!title || !body) {
    toast("กรุณากรอกชื่อหัวข้อและเนื้อหาให้ครบ", true);
    return;
  }
  btn.disabled = true;
  try {
    await AgroLinkAdminAPI.post("/admin/about-sections", {
      title, body, display_order: Number.isFinite(displayOrder) ? displayOrder : 0, is_active: true,
    });
    toast("เพิ่มหัวข้อใหม่เรียบร้อยแล้ว");
    document.getElementById("newAboutTitle").value = "";
    document.getElementById("newAboutBody").value = "";
    document.getElementById("newAboutOrder").value = "100";
    await loadAboutSections();
  } catch (err) {
    toast("เพิ่มหัวข้อไม่สำเร็จ: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- จัดการสินค้า/บริการแนะนำ (Featured Listings) ----------
// Local duplicates of category/service-key labels used elsewhere (e.g.
// frontend/js/marketplace.js's CATEGORY_LABEL_TH, frontend/machinery/js/
// dashboard.js's SERVICE_KEY_LABEL_TH) — kept as a local copy per this
// project's established no-shared-bundler convention. Backs GET/POST
// /admin/product-listings* and /admin/service-listings* (src/routes/
// admin.js) — see grant_featured_listings.sql's doc comment on why this
// is admin-toggled (offline payment) rather than self-serve.
const FEATURED_CATEGORY_LABEL_TH = {
  fertilizer_hormone: "ปุ๋ย/ฮอร์โมน",
  chemical_pesticide: "สารเคมีและยาปราบศัตรูพืช",
  equipment: "อุปกรณ์การเกษตร",
  other: "อื่นๆ",
};
const FEATURED_SERVICE_KEY_LABEL_TH = {
  plow_rough: "ไถดะ",
  plow_secondary_seed: "ไถแปรและหว่าน",
  rotary_till: "ปั่นดิน",
  spraying: "ฉีดพ่นสารเคมี (โดรน/รถฉีดพ่น)",
  harvesting: "เกี่ยวข้าว",
  trucking: "ขนส่งด้วยรถบรรทุก",
  drying: "ลานตากข้าว/ตากผลผลิต",
};

function isEffectivelyFeatured(item) {
  if (!item.is_featured) return false;
  if (!item.featured_until) return true;
  return new Date(item.featured_until) > new Date();
}

function featuredListingCard(item, type) {
  const label = type === "product"
    ? escapeHtml(item.product_name) + (item.brand ? " · " + escapeHtml(item.brand) : "")
    : escapeHtml(item.label_th || FEATURED_SERVICE_KEY_LABEL_TH[item.service_key] || item.service_key);
  const subLabel = type === "product"
    ? escapeHtml(FEATURED_CATEGORY_LABEL_TH[item.category] || item.category)
    : escapeHtml(item.service_type || "");
  const effectivelyFeatured = isEffectivelyFeatured(item);
  const badge = effectivelyFeatured
    ? `<span class="badge status-active">⭐ แนะนำ (ถึง ${thaiDate(item.featured_until)})</span>`
    : `<span class="badge status-pending">ไม่ได้แนะนำ</span>`;

  const typePath = type === "product" ? "product-listings" : "service-listings";

  return `
    <div class="item-card" data-listing-id="${item.listing_id}">
      <div class="row"><span class="title">${label} — ${escapeHtml(item.org_name)}</span>${badge}</div>
      <div class="detail-line muted">${subLabel} · ${Number(item.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(item.price_unit || "")}</div>
      <div class="action-row">
        <input type="number" class="feature-days-input" data-days-for="${item.listing_id}" min="1" step="1" value="30" style="max-width:100px;" />
        <button type="button" class="btn btn-approve btn-sm" data-feature-listing="${item.listing_id}" data-type="${typePath}">ตั้งเป็นแนะนำ (วัน)</button>
        ${effectivelyFeatured ? `<button type="button" class="btn btn-decline btn-sm" data-unfeature-listing="${item.listing_id}" data-type="${typePath}">ยกเลิกแนะนำ</button>` : ""}
      </div>
    </div>
  `;
}

async function loadFeaturedListings() {
  const el = document.getElementById("featuredListingsSection");
  const type = document.getElementById("featuredListingTypeFilter").value;
  const path = type === "product" ? "/admin/product-listings" : "/admin/service-listings";
  try {
    const items = await AgroLinkAdminAPI.get(path);
    if (items.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่พบรายการที่ใช้งานอยู่ในหมวดนี้</div>`;
      return;
    }
    el.innerHTML = items.map((item) => featuredListingCard(item, type)).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("featuredListingTypeFilter").addEventListener("change", () => loadFeaturedListings());

document.getElementById("featuredListingsSection").addEventListener("click", async (e) => {
  const featureBtn = e.target.closest("[data-feature-listing]");
  const unfeatureBtn = e.target.closest("[data-unfeature-listing]");

  if (featureBtn) {
    const listingId = featureBtn.dataset.featureListing;
    const typePath = featureBtn.dataset.type;
    const daysInput = document.querySelector(`[data-days-for="${listingId}"]`);
    const days = Number(daysInput ? daysInput.value : 0);
    if (!Number.isFinite(days) || days <= 0) {
      toast("กรุณาระบุจำนวนวันที่มากกว่า 0", true);
      return;
    }
    featureBtn.disabled = true;
    try {
      await AgroLinkAdminAPI.post(`/admin/${typePath}/${listingId}/feature`, { days });
      toast("ตั้งเป็นรายการแนะนำเรียบร้อยแล้ว");
      await loadFeaturedListings();
    } catch (err) {
      toast("ตั้งเป็นแนะนำไม่สำเร็จ: " + err.message, true);
      featureBtn.disabled = false;
    }
    return;
  }

  if (unfeatureBtn) {
    const listingId = unfeatureBtn.dataset.unfeatureListing;
    const typePath = unfeatureBtn.dataset.type;
    unfeatureBtn.disabled = true;
    try {
      await AgroLinkAdminAPI.post(`/admin/${typePath}/${listingId}/unfeature`, {});
      toast("ยกเลิกรายการแนะนำเรียบร้อยแล้ว");
      await loadFeaturedListings();
    } catch (err) {
      toast("ยกเลิกไม่สำเร็จ: " + err.message, true);
      unfeatureBtn.disabled = false;
    }
  }
});

async function refreshAll() {
  await Promise.all([
    loadSummaryAndHealth(), loadKycQueue(), loadKybQueue(), loadRoleRequestQueue(), loadAllFarmers(), loadAllOrgs(),
  ]);
}

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkAdminAPI.logout());

// Kick off all sections concurrently — independent panels, one broken
// panel doesn't take down the rest of the page.
loadSummaryAndHealth();
loadKycQueue();
loadKybQueue();
loadRoleRequestQueue();
loadAllFarmers();
loadAllOrgs();
loadAboutSections();
loadFeaturedListings();
