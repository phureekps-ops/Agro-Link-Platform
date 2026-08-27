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

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkAdminAPI.logout());

// Kick off all sections concurrently — independent panels, one broken
// panel doesn't take down the rest of the page.
loadSummaryAndHealth();
loadKycQueue();
loadKybQueue();
loadRoleRequestQueue();
loadAwdQueue();
loadAwdConfig();
loadAllFarmers();
loadAllOrgs();
loadCreditModelStatus();
