// ============================================================
// การนำทางแบบแถบข้าง (Sidebar) — UI-only, ไม่แตะตรรกะโหลดข้อมูลเดิมเลย
// เหมือนกับ coop/js/dashboard.js ทุกประการ: ทุก section เดิม (รวมทั้งที่
// เพิ่งรวมมาจาก cooperatives.html/government-officers.html/
// satellite-observations.html/featured-listings.html/group-buys.html/
// capital-topup.html) ยังคงถูกโหลดข้อมูลตามปกติตอนเปิดหน้าเหมือนเดิมทั้งหมด
// ปุ่มด้านข้างแค่ show/hide ว่าจะให้ page ไหนแสดงอยู่บนจอเท่านั้น
// ============================================================
const ADMIN_PAGE_BREADCRUMB_TH = {
  overview: "ภาพรวม &amp; สุขภาพระบบ",
  approvals: "KYC / KYB / บทบาทธุรกิจ",
  awd: "คาร์บอนเครดิต (AWD)",
  farmers: "เกษตรกรทั้งหมด",
  orgs: "องค์กรทั้งหมด",
  "credit-model": "โมเดลคะแนนเครดิต",
  cooperatives: "จัดการสหกรณ์",
  "gov-officers": "เจ้าหน้าที่ภาครัฐ",
  satellite: "ข้อมูลดาวเทียม",
  "featured-listings": "รายการแนะนำ",
  "group-buys": "รวมออเดอร์ประมูลร่วม",
  "capital-topup": "เติมทุนหมุนเวียนสหกรณ์",
};

function showAdminPage(pageKey) {
  document.querySelectorAll("[data-page-content]").forEach((el) => {
    el.style.display = el.dataset.pageContent === pageKey ? "" : "none";
  });
  document.querySelectorAll("[data-page]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === pageKey);
  });
  const crumb = document.getElementById("adminBreadcrumbCurrent");
  if (crumb) crumb.innerHTML = ADMIN_PAGE_BREADCRUMB_TH[pageKey] || pageKey;
  const mainEl = document.querySelector(".admin-main");
  if (mainEl) mainEl.scrollTop = 0;
  window.scrollTo(0, 0);
}

document.querySelectorAll("[data-page]").forEach((btn) => {
  btn.addEventListener("click", () => showAdminPage(btn.dataset.page));
});

// ============================================================
// ยูทิลิตีที่ใช้ร่วมกันทุกหน้า (เดิมแต่ละไฟล์ประกาศซ้ำกันเองตอนยังแยกเป็น
// คนละหน้า — ตอนนี้รวมเป็นไฟล์เดียวจึงเหลือไว้ชุดเดียว)
// ============================================================
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

// เดิมอยู่ใน featured-listings.js/group-buys.js (รูปแบบเดียวกันทุกไฟล์) —
// เก็บไว้ชุดเดียวเช่นกัน capital-topup.js เดิมมี thaiDate ของตัวเองที่จริงๆ
// format เหมือน thaiDateTime นี้ทุกประการ (มีชั่วโมง:นาทีด้วย) จึงรวมมาใช้
// ตัวนี้แทนแล้วไม่ประกาศซ้ำ
function thaiDateTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("th-TH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// เดิมอยู่ใน capital-topup.js เท่านั้น ไม่ชนกับไฟล์อื่น
function thb(n) {
  return Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2 });
}

const FARMER_STATUS_LABEL = {
  pending_kyc: "รอตรวจสอบ KYC", active: "ใช้งานได้", suspended: "ถูกระงับ", closed: "ปิดบัญชี/ถูกปฏิเสธ",
};
const KYB_STATUS_LABEL = { Pending: "รอตรวจสอบ", Verified: "ผ่านการตรวจสอบแล้ว", Rejected: "ถูกปฏิเสธ" };
// Kept covering the four legacy machine-type values (TractorService/
// DroneService/HarvesterService/TruckService) even though 2026-08-17
// onward every new request/self-registration uses 'MachineryService'
// instead (see organization.js's ORG_REQUESTABLE_ROLE_TYPES comment) — this
// map labels whatever org_type/role_type Platform Ops is looking at in the
// KYB/role queues below, including pre-consolidation rows that were never
// migrated.
const ORG_TYPE_LABEL = {
  Cooperative: "สหกรณ์", Mill: "โรงสี", Bank: "ธนาคาร", InputSupplier: "ผู้จำหน่ายปัจจัยการผลิต",
  Lender: "ผู้ปล่อยกู้", Logistics: "โลจิสติกส์", Buyer: "ผู้รับซื้อผลผลิต", VillageFund: "กองทุนหมู่บ้าน",
  MachineryService: "ผู้ให้บริการเครื่องจักรกล (รถไถ/โดรน/รถเกี่ยว/รถบรรทุก)",
  TractorService: "บริการรถไถ", DroneService: "บริการโดรน/ฉีดพ่นสารเคมี", HarvesterService: "บริการรถเกี่ยวข้าว",
  TruckService: "บริการรถบรรทุก", DryingYardService: "บริการลานตากข้าว",
  MarketVenue: "ผู้ให้บริการลานตลาด/พื้นที่ค้าขาย", FertilizerMixingService: "ผู้ให้บริการผสมปุ๋ยสั่งตัด",
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

// ---------- คิวตรวจสอบคาร์บอนเครดิต AWD ----------
function awdCard(a) {
  return `
    <div class="item-card" data-assessment-id="${a.assessment_id}">
      <div class="row"><span class="title">${escapeHtml(a.farmer_name)} — ${escapeHtml(a.commodity_name_th)}</span>
        <span class="badge ${a.is_eligible ? "status-active" : "status-pending"}">${a.is_eligible ? "เข้าเกณฑ์" : "ยังไม่เข้าเกณฑ์"}</span></span>
      </div>
      <div class="detail-line">พื้นที่ ${escapeHtml(a.area_rai)} ไร่ · รอบแห้งที่ผ่านเกณฑ์ ${a.qualifying_dry_events}/${a.min_dry_events_required} รอบ (รวม ${a.total_dry_days} วัน)</div>
      <div class="detail-line muted">ประเมินเครดิต: ${a.estimated_credit_tco2e} tCO2e · ส่งตรวจเมื่อ ${thaiDate(a.submitted_at)} · อ้างอิง ${escapeHtml(a.methodology_ref)}</div>
      <div class="action-row">
        <input type="text" class="reason-input" placeholder="เหตุผล (บังคับกรอกถ้าปฏิเสธ)" />
      </div>
      <div class="action-row">
        <a class="btn btn-ghost btn-sm" href="carbon-assessment-detail.html?id=${a.assessment_id}" target="_blank" rel="noopener">ดูข้อมูลระดับน้ำ/ดาวเทียม</a>
        <button type="button" class="btn btn-approve btn-sm approve-awd-btn">รับรอง</button>
        <button type="button" class="btn btn-decline btn-sm reject-awd-btn">ปฏิเสธ</button>
      </div>
    </div>
  `;
}

async function loadAwdQueue() {
  const el = document.getElementById("awdQueueSection");
  try {
    const assessments = await AgroLinkAdminAPI.get("/admin/carbon/assessments?status=pending_review");
    if (assessments.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีข้อมูล AWD ที่รอตรวจสอบในขณะนี้</div>`;
      return;
    }
    el.innerHTML = assessments.map(awdCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคิวตรวจสอบ AWD ไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("awdQueueSection").addEventListener("click", async (e) => {
  const card = e.target.closest(".item-card");
  if (!card) return;
  const assessmentId = card.dataset.assessmentId;
  const reason = card.querySelector(".reason-input") ? card.querySelector(".reason-input").value.trim() : "";

  if (e.target.classList.contains("approve-awd-btn")) {
    e.target.disabled = true;
    try {
      await AgroLinkAdminAPI.post(`/admin/carbon/assessments/${assessmentId}/verify`, { review_note: reason || undefined });
      toast("รับรองข้อมูล AWD เรียบร้อยแล้ว");
      await loadAwdQueue();
    } catch (err) {
      toast("ดำเนินการไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
      e.target.disabled = false;
    }
  } else if (e.target.classList.contains("reject-awd-btn")) {
    if (!reason) {
      toast("กรุณากรอกเหตุผลก่อนปฏิเสธ", true);
      return;
    }
    e.target.disabled = true;
    try {
      await AgroLinkAdminAPI.post(`/admin/carbon/assessments/${assessmentId}/reject`, { review_note: reason });
      toast("ปฏิเสธข้อมูล AWD เรียบร้อยแล้ว");
      await loadAwdQueue();
    } catch (err) {
      toast("ดำเนินการไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
      e.target.disabled = false;
    }
  }
});

// ---------- เกณฑ์การประเมิน AWD ----------
async function loadAwdConfig() {
  const el = document.getElementById("awdConfigCurrent");
  try {
    const versions = await AgroLinkAdminAPI.get("/admin/carbon/config");
    const active = versions.find((v) => v.is_active) || versions[0];
    if (!active) {
      el.textContent = "ยังไม่มีเกณฑ์การประเมิน";
      return;
    }
    el.innerHTML = `ปัจจุบันใช้: <strong>${active.emission_factor_tco2e_per_rai}</strong> tCO2e/ไร่ · ขั้นต่ำ <strong>${active.min_dry_events_required}</strong> รอบ ·
      รอบละอย่างน้อย <strong>${active.min_dry_period_days}</strong> วัน · ลึกอย่างน้อย <strong>${active.min_water_level_drop_cm}</strong> ซม.
      (${escapeHtml(active.methodology_ref)}, ใช้ตั้งแต่ ${thaiDate(active.effective_from)}) · มีทั้งหมด ${versions.length} เวอร์ชันในประวัติ`;
    document.getElementById("awdEmissionFactor").value = active.emission_factor_tco2e_per_rai;
    document.getElementById("awdMinDryEvents").value = active.min_dry_events_required;
    document.getElementById("awdMinDryDays").value = active.min_dry_period_days;
    document.getElementById("awdMinDropCm").value = active.min_water_level_drop_cm;
  } catch (err) {
    el.innerHTML = `<span style="color:var(--red-600,#c62828)">โหลดเกณฑ์การประเมินไม่สำเร็จ: ${escapeHtml(err.message)}</span>`;
  }
}

document.getElementById("awdConfigSaveBtn").addEventListener("click", async () => {
  const btn = document.getElementById("awdConfigSaveBtn");
  btn.disabled = true;
  try {
    await AgroLinkAdminAPI.post("/admin/carbon/config", {
      emission_factor_tco2e_per_rai: Number(document.getElementById("awdEmissionFactor").value),
      min_dry_events_required: Number(document.getElementById("awdMinDryEvents").value),
      min_dry_period_days: Number(document.getElementById("awdMinDryDays").value),
      min_water_level_drop_cm: Number(document.getElementById("awdMinDropCm").value),
      note: document.getElementById("awdConfigNote").value.trim() || undefined,
    });
    toast("บันทึกเกณฑ์การประเมินใหม่แล้ว — มีผลกับการคำนวณครั้งถัดไปเท่านั้น ไม่กระทบข้อมูลเก่า");
    document.getElementById("awdConfigNote").value = "";
    await loadAwdConfig();
  } catch (err) {
    toast("บันทึกไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
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

// ---------- โมเดลคะแนนเครดิต (Machine Learning) ----------
// Backs GET /admin/credit-model and POST /admin/credit-model/retrain
// (src/routes/admin.js) — see grant_credit_model.sql's doc comment for the
// full design: logistic regression trained on the same 4 factor ratios
// risk.compute_credit_score() already computes (production/contract/
// repayment/delivery), gated behind a minimum sample size so an early-
// stage pilot never activates an unreliable model — below that threshold
// every farmer keeps being scored by the original fixed-weight formula.

function creditModelStatusCard(active) {
  if (!active) {
    return `<div class="empty-state">ยังไม่มีโมเดลที่ฝึกสำเร็จ — เกษตรกรทุกคนยังคงใช้สูตรคำนวณคะแนนแบบเดิม (ถ่วงน้ำหนักคงที่ 30/25/25/20%)</div>`;
  }
  const accuracyText = active.training_accuracy !== null && active.training_accuracy !== undefined
    ? (Number(active.training_accuracy) * 100).toFixed(1) + "%"
    : "-";
  return `
    <div class="item-card">
      <div class="row"><span class="title">โมเดลที่ใช้งานอยู่ขณะนี้</span><span class="badge status-active">ใช้งานอยู่</span></div>
      <div class="detail-line">ฝึกเมื่อ ${thaiDate(active.trained_at)}</div>
      <div class="detail-line">จำนวนข้อมูลที่ใช้ฝึก: ${active.sample_size} ราย (กลุ่มดี ${active.positive_count} · กลุ่มเสี่ยง ${active.negative_count})</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">ความแม่นยำระหว่างฝึก: ${accuracyText}</div>
    </div>
  `;
}

function creditModelHistoryCard(m) {
  const badge = m.is_active
    ? `<span class="badge status-active">ใช้งานอยู่</span>`
    : `<span class="badge status-pending">ไม่ได้ใช้งาน</span>`;
  const accuracyText = m.training_accuracy !== null && m.training_accuracy !== undefined
    ? (Number(m.training_accuracy) * 100).toFixed(1) + "%"
    : "-";
  return `
    <div class="item-card">
      <div class="row"><span class="title">ฝึกเมื่อ ${thaiDate(m.trained_at)}</span>${badge}</div>
      <div class="detail-line">ข้อมูล ${m.sample_size} ราย (ดี ${m.positive_count} / เสี่ยง ${m.negative_count})</div>
      <div class="detail-line muted">ความแม่นยำ: ${accuracyText}${m.notes ? " · " + escapeHtml(m.notes) : ""}</div>
    </div>
  `;
}

async function loadCreditModelStatus() {
  const statusEl = document.getElementById("creditModelStatusSection");
  const historyEl = document.getElementById("creditModelHistorySection");
  try {
    const result = await AgroLinkAdminAPI.get("/admin/credit-model");
    statusEl.innerHTML = creditModelStatusCard(result.active);
    historyEl.innerHTML = result.history.length === 0
      ? `<div class="empty-state">ยังไม่เคยมีการฝึกโมเดล</div>`
      : result.history.map(creditModelHistoryCard).join("");
  } catch (err) {
    statusEl.innerHTML = `<div class="empty-state">โหลดสถานะโมเดลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    historyEl.innerHTML = "";
  }
}

document.getElementById("retrainCreditModelBtn").addEventListener("click", async () => {
  const btn = document.getElementById("retrainCreditModelBtn");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "กำลังฝึกโมเดล…";
  try {
    const result = await AgroLinkAdminAPI.post("/admin/credit-model/retrain", {});
    if (result.activated) {
      toast(`ฝึกโมเดลสำเร็จและเปิดใช้งานแล้ว (ข้อมูล ${result.sample_size} ราย)`);
    } else {
      toast(
        `ยังฝึกโมเดลไม่ได้: ข้อมูลไม่พอ (มี ${result.sample_size} ราย ต้องการอย่างน้อย ${result.min_training_samples} ราย `
        + `และอย่างน้อย ${result.min_per_class} รายต่อกลุ่ม) — ยังคงใช้สูตรเดิมต่อไป`,
        true,
      );
    }
    await loadCreditModelStatus();
  } catch (err) {
    toast("ฝึกโมเดลไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

async function refreshAll() {
  await Promise.all([
    loadSummaryAndHealth(), loadKycQueue(), loadKybQueue(), loadRoleRequestQueue(),
    loadAwdQueue(), loadAwdConfig(), loadAllFarmers(), loadAllOrgs(),
  ]);
}

// ============================================================
// จัดการสหกรณ์ (เดิมอยู่ที่ cooperatives.html/js/cooperatives.js แยกหน้า —
// รวมเข้ามาที่นี่ทั้งหมดตอนย้ายมาใช้ sidebar SPA เหมือนพอร์ทัลสหกรณ์)
// ============================================================
let coopProvinceCache = [];

// ---------- จังหวัด (สำหรับฟอร์มจัดตั้งสหกรณ์) ----------
async function loadCoopProvinces() {
  const select = document.getElementById("provinceSelect");
  try {
    coopProvinceCache = await AgroLinkAdminAPI.get("/admin/provinces");
    if (coopProvinceCache.length === 0) {
      select.innerHTML = `<option value="">ไม่มีจังหวัดในระบบ</option>`;
      return;
    }
    select.innerHTML = coopProvinceCache
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
    await loadCoopProvinces();
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
  const titleEl = document.getElementById("coopDetailSectionTitle");
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

      <div class="panel" style="margin-top:14px;">
        <div style="font-weight:700; margin-bottom:8px;">🌱 ผลประเมินธรรมาภิบาล (AgroLink Cooperative Credit Score)</div>
        <p style="font-size:12px; color:var(--gray-500); margin:0 0 10px;">
          ใช้เป็นหนึ่งใน 5 ปัจจัยของคะแนนความน่าเชื่อถือสหกรณ์ — ประเมินด้วยมือโดยเจ้าหน้าที่ AgroLink เท่านั้น
          (ยังไม่เชื่อมข้อมูลจริงจากกรมส่งเสริมสหกรณ์ รอข้อตกลงเชื่อมข้อมูลอย่างเป็นทางการ)
        </p>
        <div id="governanceAssessmentPanel"><div class="loading-line">กำลังโหลด…</div></div>
        <div class="form-grid" style="margin-top:12px;">
          <div class="field">
            <label for="governanceFindingsSelect-${c.org_id}">ผลการประเมิน</label>
            <select id="governanceFindingsSelect-${c.org_id}">
              <option value="true">ไม่พบข้อบกพร่องสำคัญ</option>
              <option value="false">พบข้อบกพร่องที่ต้องติดตาม</option>
            </select>
          </div>
          <div class="field full">
            <label for="governanceNotesInput-${c.org_id}">หมายเหตุประกอบการประเมิน</label>
            <textarea id="governanceNotesInput-${c.org_id}" rows="2"></textarea>
          </div>
        </div>
        <button type="button" class="btn btn-primary btn-sm" data-save-governance="${c.org_id}" style="max-width:260px;">บันทึกผลประเมิน</button>
      </div>
    `;
    await loadGovernanceAssessment(orgId);
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายละเอียดไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- ผลประเมินธรรมาภิบาล (ใช้ในคะแนนความน่าเชื่อถือสหกรณ์) ----------
async function loadGovernanceAssessment(orgId) {
  const el = document.getElementById("governanceAssessmentPanel");
  if (!el) return;
  try {
    const g = await AgroLinkAdminAPI.get(`/admin/cooperatives/${orgId}/governance-assessment`);
    if (!g) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีการประเมิน — ใช้ฟอร์มด้านล่างเพื่อบันทึกผลประเมินแรก</div>`;
      return;
    }
    el.innerHTML = `
      <div class="row" style="display:flex; align-items:center; gap:10px;">
        <span class="badge ${g.no_material_findings ? "status-active" : "status-declined"}">${g.no_material_findings ? "ไม่พบข้อบกพร่องสำคัญ" : "พบข้อบกพร่องที่ต้องติดตาม"}</span>
      </div>
      ${g.notes ? `<div class="detail-line" style="margin-top:6px;">${escapeHtml(g.notes)}</div>` : ""}
      <div class="detail-line muted" style="margin-top:4px;">ประเมินเมื่อ ${thaiDate(g.assessed_at)}</div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดผลประเมินไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("cooperativeDetailSection").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-save-governance]");
  if (!btn) return;
  const orgId = btn.dataset.saveGovernance;
  const noMaterialFindings = document.getElementById(`governanceFindingsSelect-${orgId}`).value === "true";
  const notes = document.getElementById(`governanceNotesInput-${orgId}`).value.trim();
  btn.disabled = true;
  try {
    await AgroLinkAdminAPI.post(`/admin/cooperatives/${orgId}/governance-assessment`, {
      no_material_findings: noMaterialFindings,
      notes: notes || undefined,
    });
    toast("บันทึกผลประเมินธรรมาภิบาลเรียบร้อยแล้ว");
    await loadGovernanceAssessment(orgId);
  } catch (err) {
    toast("บันทึกผลประเมินไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
  } finally {
    btn.disabled = false;
  }
});

async function initCooperatives() {
  await loadCoopProvinces();
  await loadCooperatives();
}

// ============================================================
// จัดการเจ้าหน้าที่ภาครัฐ (เดิมอยู่ที่ government-officers.html/
// js/government-officers.js แยกหน้า — รวมเข้ามาที่นี่)
// ============================================================
const OFFICER_STATUS_LABEL = { Active: "ใช้งานอยู่", Inactive: "ปิดใช้งานแล้ว" };
function officerStatusBadge(status) {
  const cssClass = status === "Active" ? "status-active" : "status-declined";
  return `<span class="badge ${cssClass}">${escapeHtml(OFFICER_STATUS_LABEL[status] || status)}</span>`;
}

const SCOPE_LABEL = { National: "ระดับประเทศ (National)", Province: "ระดับจังหวัด (Province)" };

let officerProvinceCache = [];

// ---------- จังหวัด (สำหรับฟอร์มสร้างเจ้าหน้าที่ระดับจังหวัด) — reuses the SAME
// GET /admin/provinces endpoint the cooperatives form above uses. ----------
async function loadOfficerProvinces() {
  const select = document.getElementById("officerProvinceSelect");
  try {
    officerProvinceCache = await AgroLinkAdminAPI.get("/admin/provinces");
    select.innerHTML = officerProvinceCache.length === 0
      ? `<option value="">ไม่มีจังหวัดในระบบ</option>`
      : `<option value="">-- เลือกจังหวัด --</option>` +
        officerProvinceCache.map((p) => `<option value="${p.province_code}">${escapeHtml(p.province_name_th)} (${escapeHtml(p.region_th)})</option>`).join("");
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
  const titleEl = document.getElementById("officerDetailSectionTitle");
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

async function initGovernmentOfficers() {
  await Promise.all([loadOfficerProvinces(), loadGovRoles()]);
  await loadOfficers();
}

// ============================================================
// ข้อมูลดาวเทียม/Remote Sensing (เดิมอยู่ที่ satellite-observations.html/
// js/satellite-observations.js แยกหน้า — รวมเข้ามาที่นี่)
// ============================================================
const OBSERVATION_TYPE_LABEL = {
  ndvi: "ค่าดัชนีพืชพรรณ (NDVI)", crop_health: "สุขภาพพืช", land_cover: "การใช้ที่ดิน",
  flood_extent: "พื้นที่น้ำท่วม", other: "อื่นๆ",
};
const SOURCE_PROVIDER_LABEL = {
  manual: "ป้อนด้วยมือ", sentinel1_sar: "Sentinel-1 SAR", sentinel2_optical: "Sentinel-2 Optical",
  landsat: "Landsat", gistda: "GISTDA", other: "อื่นๆ",
};

let unitCache = [];

async function loadUnits() {
  const select = document.getElementById("unitSelect");
  try {
    unitCache = await AgroLinkAdminAPI.get("/admin/production-units");
    select.innerHTML = unitCache.length === 0
      ? `<option value="">ไม่มีแปลงในระบบ</option>`
      : `<option value="">-- เลือกแปลง --</option>` +
        unitCache.map((u) => `<option value="${u.unit_id}">${escapeHtml(u.farmer_name)} — ${escapeHtml(u.commodity_name_th || u.commodity_code)} (${Number(u.area_rai).toLocaleString("th-TH")} ไร่)</option>`).join("");
  } catch (err) {
    select.innerHTML = `<option value="">โหลดรายชื่อแปลงไม่สำเร็จ</option>`;
    toast("โหลดรายชื่อแปลงไม่สำเร็จ: " + err.message, true);
  }
}

document.getElementById("unitSelect").addEventListener("change", (e) => {
  loadObservations(e.target.value);
});

function observationCard(o) {
  const valueLine = o.value_numeric !== null && o.value_numeric !== undefined
    ? `ค่า: <strong>${Number(o.value_numeric).toLocaleString("th-TH", { maximumFractionDigits: 4 })}</strong>`
    : `ค่า: <strong>${escapeHtml(o.value_label)}</strong>`;
  return `
    <div class="item-card" data-observation-id="${o.observation_id}">
      <div class="row">
        <span class="title">${escapeHtml(OBSERVATION_TYPE_LABEL[o.observation_type] || o.observation_type)}</span>
        <span class="badge status-active">${escapeHtml(SOURCE_PROVIDER_LABEL[o.source_provider] || o.source_provider)}</span>
      </div>
      <div class="detail-line">${valueLine}</div>
      <div class="detail-line muted">วันที่ ${thaiDate(o.observation_date)} · บันทึกโดย ${escapeHtml(o.recorded_by)}</div>
      ${o.note ? `<div class="detail-line muted">หมายเหตุ: ${escapeHtml(o.note)}</div>` : ""}
      ${o.image_ref ? `<div class="detail-line"><a href="${escapeHtml(o.image_ref)}" target="_blank" rel="noopener">ดูรูปภาพ/ไฟล์อ้างอิง</a></div>` : ""}
    </div>
  `;
}

async function loadObservations(unitId) {
  const el = document.getElementById("observationsSection");
  if (!unitId) {
    el.innerHTML = `<div class="loading-line">เลือกแปลงด้านบนเพื่อดูประวัติข้อมูล</div>`;
    return;
  }
  el.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const rows = await AgroLinkAdminAPI.get(`/admin/satellite-observations?unit_id=${unitId}`);
    el.innerHTML = rows.length === 0
      ? `<div class="empty-state">ยังไม่มีข้อมูลของแปลงนี้ — ใช้ฟอร์มด้านบนเพื่อบันทึกรายการแรก</div>`
      : rows.map(observationCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("observationSubmitBtn").addEventListener("click", async () => {
  const unitId = document.getElementById("unitSelect").value;
  const observationDate = document.getElementById("observationDateInput").value;
  const observationType = document.getElementById("observationTypeSelect").value;
  const sourceProvider = document.getElementById("sourceProviderSelect").value;
  const valueNumeric = document.getElementById("valueNumericInput").value;
  const valueLabel = document.getElementById("valueLabelInput").value.trim();
  const imageRef = document.getElementById("imageRefInput").value.trim();
  const recordedBy = document.getElementById("recordedByInput").value.trim();
  const note = document.getElementById("noteInput").value.trim();

  if (!unitId || !observationDate || !observationType || !recordedBy) {
    toast("กรุณาเลือกแปลง วันที่ ประเภทข้อมูล และกรอกชื่อผู้บันทึก", true);
    return;
  }
  if (!valueNumeric && !valueLabel) {
    toast("กรุณากรอกค่าตัวเลขหรือค่าป้ายกำกับอย่างน้อยหนึ่งอย่าง", true);
    return;
  }

  const payload = {
    unit_id: unitId,
    observation_date: observationDate,
    observation_type: observationType,
    source_provider: sourceProvider,
    value_numeric: valueNumeric ? Number(valueNumeric) : undefined,
    value_label: valueLabel || undefined,
    image_ref: imageRef || undefined,
    note: note || undefined,
    recorded_by: recordedBy,
  };

  const btn = document.getElementById("observationSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkAdminAPI.post("/admin/satellite-observations", payload);
    toast("บันทึกข้อมูลเรียบร้อยแล้ว");
    document.getElementById("valueNumericInput").value = "";
    document.getElementById("valueLabelInput").value = "";
    document.getElementById("imageRefInput").value = "";
    document.getElementById("noteInput").value = "";
    await loadObservations(unitId);
  } catch (err) {
    const reason = (err.body && err.body.error) || err.message;
    toast("บันทึกไม่สำเร็จ: " + reason, true);
  } finally {
    btn.disabled = false;
  }
});

async function initSatelliteObservations() {
  await loadUnits();
}

// ============================================================
// รายการสินค้า/บริการแนะนำ (เดิมอยู่ที่ featured-listings.html/
// js/featured-listings.js แยกหน้า — รวมเข้ามาที่นี่)
// ============================================================
const PRODUCT_CATEGORY_LABEL = {
  fertilizer_hormone: "ปุ๋ย/ฮอร์โมน",
  chemical_pesticide: "สารเคมี/ยาปราบศัตรูพืช",
  equipment: "อุปกรณ์การเกษตร",
  produce: "ผลผลิตทางการเกษตร (สหกรณ์)",
  processed_good: "สินค้าแปรรูป (สหกรณ์)",
  other: "อื่นๆ",
};
const SERVICE_TYPE_LABEL = {
  land_preparation: "เตรียมดิน", harvesting: "เก็บเกี่ยว", pest_control: "พ่นยา/กำจัดศัตรูพืช",
  transport: "ขนส่ง", drying_storage: "ลานตาก/จัดเก็บ", fertilizer_mixing: "ผสมปุ๋ยสั่งตัด",
  straw_processing: "อัดเม็ด/อัดก้อนฟางข้าว", other: "อื่นๆ",
};

// A listing is "currently featured" only if is_featured AND (no expiry OR
// expiry still in the future) — same live-expiry logic as the backend's
// GET /farmer/products / GET /farmer/machinery-providers, so this admin
// view never shows a stale "แนะนำ" badge for something that already
// silently stopped being featured.
function isCurrentlyFeatured(row) {
  if (!row.is_featured) return false;
  if (!row.featured_until) return true;
  return new Date(row.featured_until).getTime() > Date.now();
}

function featuredActionsHtml(kind, row) {
  const featured = isCurrentlyFeatured(row);
  if (featured) {
    return `
      <div class="detail-line muted">แนะนำถึง: ${row.featured_until ? thaiDateTime(row.featured_until) : "ไม่มีกำหนด"}</div>
      <button type="button" class="btn btn-decline btn-sm" data-unfeature="${kind}" data-id="${row.listing_id}">ยกเลิกแนะนำ</button>
    `;
  }
  return `
    <div class="detail-line" style="display:flex; gap:8px; align-items:center;">
      <label for="days-${kind}-${row.listing_id}" style="font-size:12px; color:var(--gray-500);">จำนวนวัน</label>
      <input type="number" id="days-${kind}-${row.listing_id}" value="30" min="1" step="1" style="width:80px; padding:6px 8px;" />
      <button type="button" class="btn btn-approve btn-sm" data-feature="${kind}" data-id="${row.listing_id}">ตั้งเป็นแนะนำ</button>
    </div>
  `;
}

function productCard(row) {
  const featured = isCurrentlyFeatured(row);
  return `
    <div class="item-card" data-listing-id="${row.listing_id}">
      <div class="row">
        <span class="title">${escapeHtml(row.product_name)}${row.brand ? " — " + escapeHtml(row.brand) : ""}</span>
        <span class="badge ${featured ? "status-active" : "status-pending"}">${featured ? "⭐ แนะนำอยู่" : "ยังไม่แนะนำ"}</span>
      </div>
      <div class="detail-line muted">${escapeHtml(row.org_name)} (${escapeHtml(row.org_type)}) · ${escapeHtml(PRODUCT_CATEGORY_LABEL[row.category] || row.category)}</div>
      <div class="detail-line">ราคา ${Number(row.unit_price).toLocaleString("th-TH")} ${escapeHtml(row.price_unit)} · ${row.is_active ? "ยังขายอยู่" : "ปิดการขายแล้ว"}</div>
      ${featuredActionsHtml("product", row)}
    </div>
  `;
}

function serviceCard(row) {
  const featured = isCurrentlyFeatured(row);
  return `
    <div class="item-card" data-listing-id="${row.listing_id}">
      <div class="row">
        <span class="title">${escapeHtml(row.description || row.service_key || row.service_type)}</span>
        <span class="badge ${featured ? "status-active" : "status-pending"}">${featured ? "⭐ แนะนำอยู่" : "ยังไม่แนะนำ"}</span>
      </div>
      <div class="detail-line muted">${escapeHtml(row.org_name)} (${escapeHtml(row.org_type)}) · ${escapeHtml(SERVICE_TYPE_LABEL[row.service_type] || row.service_type)}</div>
      <div class="detail-line">ราคา ${Number(row.unit_price).toLocaleString("th-TH")} ${escapeHtml(row.price_unit)} · ${row.is_active ? "ให้บริการอยู่" : "ปิดให้บริการแล้ว"}</div>
      ${featuredActionsHtml("service", row)}
    </div>
  `;
}

async function loadProductListings() {
  const el = document.getElementById("productListingsSection");
  const category = document.getElementById("productCategoryFilter").value;
  const featured = document.getElementById("productFeaturedFilter").value;
  el.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (featured) params.set("featured", featured);
    const qs = params.toString();
    const rows = await AgroLinkAdminAPI.get(`/admin/product-listings${qs ? "?" + qs : ""}`);
    el.innerHTML = rows.length === 0
      ? `<div class="empty-state">ไม่พบสินค้าตามเงื่อนไขที่เลือก</div>`
      : rows.map(productCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadServiceListings() {
  const el = document.getElementById("serviceListingsSection");
  const serviceType = document.getElementById("serviceTypeFilter").value;
  const featured = document.getElementById("serviceFeaturedFilter").value;
  el.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const params = new URLSearchParams();
    if (serviceType) params.set("service_type", serviceType);
    if (featured) params.set("featured", featured);
    const qs = params.toString();
    const rows = await AgroLinkAdminAPI.get(`/admin/service-listings${qs ? "?" + qs : ""}`);
    el.innerHTML = rows.length === 0
      ? `<div class="empty-state">ไม่พบบริการตามเงื่อนไขที่เลือก</div>`
      : rows.map(serviceCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("productCategoryFilter").addEventListener("change", loadProductListings);
document.getElementById("productFeaturedFilter").addEventListener("change", loadProductListings);
document.getElementById("serviceTypeFilter").addEventListener("change", loadServiceListings);
document.getElementById("serviceFeaturedFilter").addEventListener("change", loadServiceListings);

document.getElementById("productListingsSection").addEventListener("click", async (e) => {
  const featureBtn = e.target.closest("[data-feature]");
  const unfeatureBtn = e.target.closest("[data-unfeature]");
  if (featureBtn) {
    const id = featureBtn.dataset.id;
    const daysInput = document.getElementById(`days-product-${id}`);
    const days = Number(daysInput.value) || 30;
    featureBtn.disabled = true;
    try {
      await AgroLinkAdminAPI.post(`/admin/product-listings/${id}/feature`, { days });
      toast("ตั้งเป็นสินค้าแนะนำเรียบร้อยแล้ว");
      await loadProductListings();
    } catch (err) {
      toast("ทำรายการไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      featureBtn.disabled = false;
    }
  } else if (unfeatureBtn) {
    const id = unfeatureBtn.dataset.id;
    unfeatureBtn.disabled = true;
    try {
      await AgroLinkAdminAPI.post(`/admin/product-listings/${id}/unfeature`, {});
      toast("ยกเลิกการแนะนำแล้ว");
      await loadProductListings();
    } catch (err) {
      toast("ทำรายการไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      unfeatureBtn.disabled = false;
    }
  }
});

document.getElementById("serviceListingsSection").addEventListener("click", async (e) => {
  const featureBtn = e.target.closest("[data-feature]");
  const unfeatureBtn = e.target.closest("[data-unfeature]");
  if (featureBtn) {
    const id = featureBtn.dataset.id;
    const daysInput = document.getElementById(`days-service-${id}`);
    const days = Number(daysInput.value) || 30;
    featureBtn.disabled = true;
    try {
      await AgroLinkAdminAPI.post(`/admin/service-listings/${id}/feature`, { days });
      toast("ตั้งเป็นบริการแนะนำเรียบร้อยแล้ว");
      await loadServiceListings();
    } catch (err) {
      toast("ทำรายการไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      featureBtn.disabled = false;
    }
  } else if (unfeatureBtn) {
    const id = unfeatureBtn.dataset.id;
    unfeatureBtn.disabled = true;
    try {
      await AgroLinkAdminAPI.post(`/admin/service-listings/${id}/unfeature`, {});
      toast("ยกเลิกการแนะนำแล้ว");
      await loadServiceListings();
    } catch (err) {
      toast("ทำรายการไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      unfeatureBtn.disabled = false;
    }
  }
});

async function initFeaturedListings() {
  await Promise.all([loadProductListings(), loadServiceListings()]);
}

// ============================================================
// รวมออเดอร์ประมูลร่วมของสหกรณ์ (เดิมอยู่ที่ group-buys.html/
// js/group-buys.js แยกหน้า — รวมเข้ามาที่นี่)
// ============================================================
const GROUP_BUY_CATEGORY_LABEL_TH = {
  input_product: "ปัจจัยการผลิต",
  produce: "ผลผลิตทางการเกษตร",
  processed_good: "สินค้าแปรรูป",
  machinery_service: "บริการเครื่องจักรกล",
  other: "อื่นๆ",
};
const GROUP_BUY_STATUS_LABEL_TH = {
  collecting: "กำลังรวบรวมความต้องการ",
  converted: "แปลงเป็นประมูลแล้ว",
  cancelled: "ยกเลิกแล้ว",
};
const GROUP_BUY_STATUS_BADGE_CLASS = {
  collecting: "status-active",
  converted: "status-approved",
  cancelled: "status-declined",
};

function groupBuyProgressLine(gb) {
  const total = Number(gb.total_requested_qty || 0).toLocaleString("th-TH");
  const unit = escapeHtml(gb.target_unit || "หน่วย");
  if (gb.min_total_qty) {
    const min = Number(gb.min_total_qty).toLocaleString("th-TH");
    return `ยอดรวมตอนนี้ ${total} / ขั้นต่ำที่ตั้งไว้ ${min} ${unit}`;
  }
  return `ยอดรวมตอนนี้ ${total} ${unit}`;
}

function groupBuyCard(gb) {
  const badgeClass = GROUP_BUY_STATUS_BADGE_CLASS[gb.status] || "status-pending";
  const readyToConvert = gb.status === "collecting"
    && (new Date(gb.closes_at).getTime() <= Date.now() || (gb.min_total_qty && Number(gb.total_requested_qty) >= Number(gb.min_total_qty)));

  return `
    <div class="item-card" data-group-buy-id="${gb.group_buy_id}">
      <div class="row">
        <span class="title">${escapeHtml(gb.product_description)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(GROUP_BUY_STATUS_LABEL_TH[gb.status] || gb.status)}</span>
      </div>
      <div class="detail-line muted">${escapeHtml(GROUP_BUY_CATEGORY_LABEL_TH[gb.category] || gb.category)} · เปิดโดย ${escapeHtml(gb.initiator_org_name || "-")} · ${gb.participant_count || 0} สหกรณ์เข้าร่วม</div>
      <div class="detail-line" style="font-weight:700;">${groupBuyProgressLine(gb)}</div>
      <div class="detail-line muted">ปิดรับสมัครภายใน ${thaiDateTime(gb.closes_at)}${readyToConvert ? " — พร้อมแปลงเป็นประมูลแล้ว" : ""}</div>
      ${gb.status === "converted" ? `<div class="detail-line muted">สหกรณ์หัวขบวน: ${escapeHtml(gb.lead_org_name || "-")}</div>` : ""}
      ${gb.status === "collecting" ? `
        <div class="action-row">
          <button type="button" class="btn btn-approve btn-sm" data-toggle-convert-form="${gb.group_buy_id}">แปลงเป็นประมูล (เลือกสหกรณ์หัวขบวน)</button>
        </div>
        <div data-convert-form-container="${gb.group_buy_id}" style="display:none; margin-top:10px;"></div>
      ` : ""}
    </div>
  `;
}

async function loadGroupBuys() {
  const el = document.getElementById("groupBuyListSection");
  const status = document.getElementById("groupBuyStatusFilter").value;
  el.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const qs = status ? `?status=${status}` : "";
    const rows = await AgroLinkAdminAPI.get(`/admin/group-buys${qs}`);
    el.innerHTML = rows.length === 0
      ? `<div class="empty-state">ไม่พบรอบตามเงื่อนไขที่เลือก</div>`
      : rows.map(groupBuyCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

function convertFormHtml(groupBuyId, participants) {
  const options = participants
    .filter((p) => p.status === "joined")
    .map((p) => `<option value="${p.org_id}">${escapeHtml(p.org_name)} (${Number(p.requested_qty).toLocaleString("th-TH")})</option>`)
    .join("");
  return `
    <div class="panel">
      <div class="form-grid" style="margin-bottom:12px;">
        <div class="field full">
          <label for="leadOrgSelect-${groupBuyId}">สหกรณ์หัวขบวน (ผู้เซ็นสัญญา/รับของ/จ่ายเงินก่อน)</label>
          <select id="leadOrgSelect-${groupBuyId}">${options}</select>
        </div>
        <div class="field">
          <label for="convertClosesAt-${groupBuyId}">วัน-เวลาปิดรับราคา (e-Auction)</label>
          <input type="datetime-local" id="convertClosesAt-${groupBuyId}" />
        </div>
        <div class="field">
          <label for="convertBidVisibility-${groupBuyId}">รูปแบบการประมูล</label>
          <select id="convertBidVisibility-${groupBuyId}">
            <option value="sealed">ปิดราคาทั้งหมดจนกว่าจะปิดประมูล (แนะนำ)</option>
            <option value="live">เห็นราคาต่ำสุดปัจจุบันแบบเรียลไทม์</option>
          </select>
        </div>
      </div>
      <button type="button" class="btn btn-primary btn-sm" data-submit-convert="${groupBuyId}">ยืนยันแปลงเป็นประมูล</button>
    </div>
  `;
}

document.getElementById("groupBuyStatusFilter").addEventListener("change", loadGroupBuys);

document.getElementById("groupBuyListSection").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-toggle-convert-form]");
  const submitBtn = e.target.closest("[data-submit-convert]");

  if (toggleBtn) {
    const groupBuyId = toggleBtn.dataset.toggleConvertForm;
    const container = document.querySelector(`[data-convert-form-container="${groupBuyId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    if (!isHidden) {
      container.style.display = "none";
      toggleBtn.textContent = "แปลงเป็นประมูล (เลือกสหกรณ์หัวขบวน)";
      return;
    }
    container.style.display = "block";
    toggleBtn.textContent = "ยกเลิก";
    container.innerHTML = `<div class="loading-line">กำลังโหลดรายชื่อผู้เข้าร่วม…</div>`;
    try {
      const detail = await AgroLinkAdminAPI.get(`/admin/group-buys/${groupBuyId}`);
      if (!detail.participants.some((p) => p.status === "joined")) {
        container.innerHTML = `<div class="empty-state">ยังไม่มีสหกรณ์เข้าร่วมรอบนี้ — ยังแปลงเป็นประมูลไม่ได้</div>`;
        return;
      }
      container.innerHTML = convertFormHtml(groupBuyId, detail.participants);
    } catch (err) {
      container.innerHTML = `<div class="empty-state">โหลดรายชื่อผู้เข้าร่วมไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    }
    return;
  }

  if (submitBtn) {
    const groupBuyId = submitBtn.dataset.submitConvert;
    const leadOrgId = document.getElementById(`leadOrgSelect-${groupBuyId}`).value;
    const closesAtValue = document.getElementById(`convertClosesAt-${groupBuyId}`).value;
    const bidVisibility = document.getElementById(`convertBidVisibility-${groupBuyId}`).value;
    if (!leadOrgId) {
      toast("กรุณาเลือกสหกรณ์หัวขบวน", true);
      return;
    }
    if (!closesAtValue) {
      toast("กรุณาเลือกวัน-เวลาปิดรับราคา", true);
      return;
    }
    const closesAtDate = new Date(closesAtValue);
    if (Number.isNaN(closesAtDate.getTime()) || closesAtDate.getTime() <= Date.now()) {
      toast("วัน-เวลาปิดรับราคาต้องเป็นเวลาในอนาคต", true);
      return;
    }
    if (!confirm("ยืนยันแปลงรอบนี้เป็นการประมูลซื้อ? หลังจากนี้จะไม่มีสหกรณ์เข้าร่วมเพิ่มได้อีก")) return;
    submitBtn.disabled = true;
    try {
      await AgroLinkAdminAPI.post(`/admin/group-buys/${groupBuyId}/convert`, {
        lead_org_id: leadOrgId,
        closes_at: closesAtDate.toISOString(),
        bid_visibility: bidVisibility,
      });
      toast("แปลงเป็นประมูลเรียบร้อยแล้ว");
      await loadGroupBuys();
    } catch (err) {
      toast("แปลงเป็นประมูลไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      submitBtn.disabled = false;
    }
  }
});

async function initGroupBuys() {
  await loadGroupBuys();
}

// ============================================================
// ระบบเติมทุนหมุนเวียนสหกรณ์ (เดิมอยู่ที่ capital-topup.html/
// js/capital-topup.js แยกหน้า — รวมเข้ามาที่นี่)
// หมายเหตุ: ไฟล์เดิมมี thaiDate() ของตัวเองที่จริงๆ format เหมือนกับ
// thaiDateTime() ด้านบนทุกประการ (มีชั่วโมง:นาทีด้วย) — จึงใช้ thaiDateTime
// ที่ประกาศไว้ครั้งเดียวแทน ไม่ประกาศซ้ำ และเปลี่ยนจุดเรียกใช้ทุกจุดตามนั้น
// (thb() ก็ประกาศไว้ครั้งเดียวแล้วด้านบนเช่นกัน — ใช้ตัวเดิม)
// ============================================================

const CAPITAL_TOPUP_PURPOSE_LABEL_TH = {
  member_onlending: "ปล่อยกู้ต่อสมาชิก",
  procurement_working_capital: "ทุนหมุนเวียนรับซื้อผลผลิต",
};
const CAPITAL_TOPUP_STATUS_LABEL_TH = {
  Submitted: "ยื่นคำขอแล้ว",
  UnderReview: "อยู่ระหว่างพิจารณา",
  Approved: "อนุมัติแล้ว",
  Rejected: "ถูกปฏิเสธ",
  Withdrawn: "ถอนคำขอแล้ว",
};
const CAPITAL_TOPUP_STATUS_BADGE_CLASS = {
  Submitted: "status-pending",
  UnderReview: "status-manual_review",
  Approved: "status-approved",
  Rejected: "status-declined",
  Withdrawn: "status-declined",
};
const FUNDING_SOURCE_TYPE_LABEL_TH = {
  BAAC: "ธ.ก.ส.",
  CommercialBank: "ธนาคารพาณิชย์",
  SavingsCoop: "สหกรณ์ออมทรัพย์",
  CreditUnion: "สหกรณ์เครดิตยูเนี่ยน",
  Fintech: "Fintech",
  ImpactFund: "กองทุนเพื่อสังคม",
  Other: "อื่นๆ",
};

// ============================================================
// คิวคำขอวงเงินจากสหกรณ์
// ============================================================
function decideFormHtml(a) {
  return `
    <div class="panel" style="margin-top:10px;">
      <div class="form-grid" style="margin-bottom:12px;">
        <div class="field">
          <label for="approvedAmount-${a.application_id}">วงเงินที่อนุมัติ (บาท)</label>
          <input type="number" id="approvedAmount-${a.application_id}" min="0.01" step="0.01" value="${a.amount_requested}" />
        </div>
        <div class="field">
          <label for="approvedRate-${a.application_id}">ดอกเบี้ย (bps/วัน)</label>
          <input type="number" id="approvedRate-${a.application_id}" min="0" step="1" value="0" />
        </div>
        <div class="field">
          <label for="approvedTenor-${a.application_id}">ระยะเวลา (เดือน)</label>
          <input type="number" id="approvedTenor-${a.application_id}" min="1" step="1" value="${a.term_months}" />
        </div>
        <div class="field full">
          <label for="decisionNote-${a.application_id}">หมายเหตุการพิจารณา (เช่น เงื่อนไขจากแหล่งทุน)</label>
          <textarea id="decisionNote-${a.application_id}" rows="2"></textarea>
        </div>
      </div>
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm" data-decide="${a.application_id}" data-decision="Approved">อนุมัติ</button>
        <button type="button" class="btn btn-decline btn-sm" data-decide="${a.application_id}" data-decision="Rejected">ปฏิเสธ</button>
      </div>
    </div>
  `;
}

function applicationCard(a) {
  const badgeClass = CAPITAL_TOPUP_STATUS_BADGE_CLASS[a.status] || "status-pending";
  const decidable = ["Submitted", "UnderReview"].includes(a.status);
  return `
    <div class="item-card" data-application-id="${a.application_id}" data-amount-requested="${a.amount_requested}" data-term-months="${a.term_months}">
      <div class="row">
        <span class="title">${escapeHtml(a.org_name)} — ${escapeHtml(CAPITAL_TOPUP_PURPOSE_LABEL_TH[a.purpose] || a.purpose)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(CAPITAL_TOPUP_STATUS_LABEL_TH[a.status] || a.status)}</span>
      </div>
      <div class="detail-line">ยื่นไปยัง ${escapeHtml(a.source_name)} (${escapeHtml(FUNDING_SOURCE_TYPE_LABEL_TH[a.source_type] || a.source_type)})</div>
      <div class="detail-line" style="font-weight:700;">ขอวงเงิน ${thb(a.amount_requested)} บาท · ${a.term_months} เดือน</div>
      ${a.score_at_submission !== null && a.score_at_submission !== undefined
        ? `<div class="detail-line">คะแนน ณ วันที่ยื่น: <strong>${a.score_at_submission}/100 (เกรด ${escapeHtml(a.grade_at_submission)})</strong></div>`
        : `<div class="detail-line muted">ไม่มีคะแนน ณ วันที่ยื่น</div>`}
      ${a.score_reasons && a.score_reasons.length > 0 ? `
        <ul style="margin:4px 0 0; padding-left:18px; font-size:12px; color:var(--gray-500);">
          ${a.score_reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}
        </ul>
      ` : ""}
      ${a.purpose_note ? `<div class="detail-line muted">หมายเหตุจากสหกรณ์: ${escapeHtml(a.purpose_note)}</div>` : ""}
      ${a.status === "Approved" ? `<div class="detail-line" style="color:var(--green-900);">อนุมัติ ${thb(a.approved_amount)} บาท · ${a.approved_tenor_months || "-"} เดือน · ดอกเบี้ย ${a.approved_interest_rate_daily_bps || 0} bps/วัน</div>` : ""}
      ${a.decision_note ? `<div class="detail-line muted">หมายเหตุการพิจารณา: ${escapeHtml(a.decision_note)}</div>` : ""}
      <div class="detail-line muted">ยื่นเมื่อ ${thaiDateTime(a.submitted_at)}${a.decided_at ? ` · ตัดสินใจเมื่อ ${thaiDateTime(a.decided_at)}` : ""}</div>
      ${decidable ? `
        <div class="action-row">
          <button type="button" class="btn btn-ghost btn-sm" data-toggle-decide="${a.application_id}">พิจารณาคำขอ</button>
        </div>
        <div data-decide-form-container="${a.application_id}" style="display:none;"></div>
      ` : ""}
    </div>
  `;
}

async function loadApplications() {
  const el = document.getElementById("applicationQueueSection");
  const status = document.getElementById("applicationStatusFilter").value;
  el.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const qs = status ? `?status=${status}` : "";
    const rows = await AgroLinkAdminAPI.get(`/admin/capital-topup/applications${qs}`);
    el.innerHTML = rows.length === 0
      ? `<div class="empty-state">ไม่พบคำขอวงเงินตามเงื่อนไขที่เลือก</div>`
      : rows.map(applicationCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำขอวงเงินไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("applicationStatusFilter").addEventListener("change", loadApplications);

document.getElementById("applicationQueueSection").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-toggle-decide]");
  const decideBtn = e.target.closest("[data-decide]");

  if (toggleBtn) {
    const applicationId = toggleBtn.dataset.toggleDecide;
    const container = document.querySelector(`[data-decide-form-container="${applicationId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    if (!isHidden) {
      container.style.display = "none";
      toggleBtn.textContent = "พิจารณาคำขอ";
      return;
    }
    const card = toggleBtn.closest("[data-application-id]");
    container.innerHTML = decideFormHtml({
      application_id: applicationId,
      amount_requested: card.dataset.amountRequested || "",
      term_months: card.dataset.termMonths || "",
    });
    container.style.display = "block";
    toggleBtn.textContent = "ยกเลิก";
    return;
  }

  if (decideBtn) {
    const applicationId = decideBtn.dataset.decide;
    const decision = decideBtn.dataset.decision;
    const approvedAmount = document.getElementById(`approvedAmount-${applicationId}`).value;
    const approvedRate = document.getElementById(`approvedRate-${applicationId}`).value;
    const approvedTenor = document.getElementById(`approvedTenor-${applicationId}`).value;
    const decisionNote = document.getElementById(`decisionNote-${applicationId}`).value.trim();

    if (decision === "Approved" && !(Number(approvedAmount) > 0)) {
      toast("กรุณากรอกวงเงินที่อนุมัติให้ถูกต้อง", true);
      return;
    }
    if (decision === "Rejected" && !confirm("ยืนยันปฏิเสธคำขอนี้?")) return;
    if (decision === "Approved" && !confirm("ยืนยันอนุมัติคำขอนี้? ระบบจะสร้างวงเงินใช้งานจริงให้ทันที")) return;

    const btnGroup = decideBtn.closest(".action-row");
    Array.from(btnGroup.querySelectorAll("button")).forEach((b) => { b.disabled = true; });
    try {
      await AgroLinkAdminAPI.post(`/admin/capital-topup/applications/${applicationId}/decide`, {
        decision,
        approved_amount: decision === "Approved" ? Number(approvedAmount) : undefined,
        interest_rate_daily_bps: approvedRate ? Number(approvedRate) : 0,
        approved_tenor_months: approvedTenor ? Number(approvedTenor) : undefined,
        decision_note: decisionNote || undefined,
      });
      toast(decision === "Approved" ? "อนุมัติคำขอเรียบร้อยแล้ว" : "ปฏิเสธคำขอเรียบร้อยแล้ว");
      await loadApplications();
    } catch (err) {
      toast("บันทึกผลการพิจารณาไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      Array.from(btnGroup.querySelectorAll("button")).forEach((b) => { b.disabled = false; });
    }
  }
});

// ============================================================
// ไดเรกทอรีแหล่งทุนภายนอก
// ============================================================
function fundingSourceCard(s) {
  return `
    <div class="item-card" data-funding-source-id="${s.funding_source_id}">
      <div class="row">
        <span class="title">${escapeHtml(s.source_name)}</span>
        <span class="badge ${s.is_active ? "status-active" : "status-declined"}">${s.is_active ? "ใช้งานอยู่" : "ปิดใช้งานแล้ว"}</span>
      </div>
      <div class="detail-line">${escapeHtml(FUNDING_SOURCE_TYPE_LABEL_TH[s.source_type] || s.source_type)}</div>
      ${s.contact_note ? `<div class="detail-line muted">${escapeHtml(s.contact_note)}</div>` : ""}
      <div class="detail-line muted">เพิ่มเมื่อ ${thaiDateTime(s.created_at)}</div>
    </div>
  `;
}

async function loadFundingSources() {
  const el = document.getElementById("fundingSourceListSection");
  try {
    const rows = await AgroLinkAdminAPI.get("/admin/capital-topup/funding-sources");
    el.innerHTML = rows.length === 0
      ? `<div class="empty-state">ยังไม่มีแหล่งทุนในระบบ — ใช้ฟอร์มด้านบนเพื่อเพิ่มรายแรก</div>`
      : rows.map(fundingSourceCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดแหล่งทุนไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("createFundingSourceBtn").addEventListener("click", async () => {
  const sourceName = document.getElementById("fsNameInput").value.trim();
  const sourceType = document.getElementById("fsTypeSelect").value;
  const contactNote = document.getElementById("fsContactNoteInput").value.trim();

  if (!sourceName) {
    toast("กรุณากรอกชื่อแหล่งทุน", true);
    return;
  }

  const btn = document.getElementById("createFundingSourceBtn");
  btn.disabled = true;
  try {
    await AgroLinkAdminAPI.post("/admin/capital-topup/funding-sources", {
      source_name: sourceName,
      source_type: sourceType,
      contact_note: contactNote || undefined,
    });
    toast("เพิ่มแหล่งทุนเรียบร้อยแล้ว");
    document.getElementById("createFundingSourceForm").reset();
    await loadFundingSources();
  } catch (err) {
    toast("เพิ่มแหล่งทุนไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
  } finally {
    btn.disabled = false;
  }
});

async function initCapitalTopup() {
  await loadApplications();
  await loadFundingSources();
}

// ============================================================
// เริ่มต้น — ปุ่มออกจากระบบตัวเดียว (เดิมแต่ละหน้ามีของตัวเอง ตอนนี้เหลือ
// ปุ่มเดียวใน header จึงลงทะเบียน listener ครั้งเดียว) และเรียกโหลดข้อมูล
// ของทุก section พร้อมกันตอนเปิดหน้า — เหมือนกับที่ coop/js/dashboard.js
// ทำ (ดูคอมเมนต์บนสุดของไฟล์นี้): sidebar แค่ show/hide สิ่งที่อยู่บนจอ
// ไม่ได้ทำให้การโหลดข้อมูลกลายเป็นแบบ lazy-per-tab
// ============================================================
document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkAdminAPI.logout());

// เดิมของ dashboard.js (ภาพรวม/คิวอนุมัติ/AWD/เกษตรกร/องค์กร) — independent
// panels, one broken panel doesn't take down the rest of the page.
loadSummaryAndHealth();
loadKycQueue();
loadKybQueue();
loadRoleRequestQueue();
loadAwdQueue();
loadAwdConfig();
loadAllFarmers();
loadAllOrgs();
loadCreditModelStatus();

// รวมมาจาก 6 หน้าเดิม
initCooperatives();
initGovernmentOfficers();
initSatelliteObservations();
initFeaturedListings();
initGroupBuys();
initCapitalTopup();
