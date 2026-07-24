const session = AgroLinkLenderAPI.requireSessionOrRedirect();

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

function thb(amount) {
  if (amount === null || amount === undefined) return "-";
  const n = Number(amount);
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " บาท";
}

function thaiDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

const STATUS_LABEL = {
  pending: "รอประเมิน", approved: "อนุมัติแล้ว (รอแปลงเป็นสัญญา)", manual_review: "รอตรวจสอบเพิ่มเติม",
  declined: "ปฏิเสธ", converted: "แปลงเป็นสัญญาแล้ว",
  draft: "ร่าง", pending_signature: "รอลงนาม", active: "ใช้งานอยู่",
  completed: "เสร็จสิ้น", terminated: "ยกเลิก", breached: "ผิดสัญญา",
};
const TIER_LABEL = { A: "ความเสี่ยงต่ำ (A)", B: "ความเสี่ยงปานกลาง-ต่ำ (B)", C: "ความเสี่ยงปานกลาง-สูง (C)", D: "ความเสี่ยงสูง (D)" };
const CONTRACT_TYPE_LABEL = {
  loan_agreement: "สัญญาสินเชื่อ", forward_purchase: "สัญญาซื้อขายล่วงหน้า",
  service_agreement: "สัญญาบริการ", input_supply_agreement: "สัญญาจัดหาปัจจัยการผลิต",
};

function statusBadge(status) {
  return `<span class="badge status-${escapeHtml(status)}">${escapeHtml(STATUS_LABEL[status] || status)}</span>`;
}
function tierBadge(tier) {
  if (!tier) return "";
  return `<span class="badge tier-${escapeHtml(tier)}">${escapeHtml(TIER_LABEL[tier] || tier)}</span>`;
}

// ---------- ภาพรวม ----------
async function loadSummary() {
  const el = document.getElementById("summarySection");
  try {
    const d = await AgroLinkLenderAPI.get("/lender/dashboard");
    document.getElementById("orgName").textContent = d.org_name || "-";
    el.innerHTML = `
      <div class="stat-card"><div class="label">รายการที่ต้องพิจารณา</div><div class="value">${d.needs_action_count}</div></div>
      <div class="stat-card"><div class="label">รอประเมินอัตโนมัติ</div><div class="value">${d.applications_by_status.pending}</div></div>
      <div class="stat-card"><div class="label">ปฏิเสธแล้ว</div><div class="value">${d.applications_by_status.declined}</div></div>
      <div class="stat-card"><div class="label">แปลงเป็นสัญญาแล้ว</div><div class="value">${d.applications_by_status.converted}</div></div>
      <div class="stat-card"><div class="label">สัญญาที่ใช้งานอยู่</div><div class="value">${d.active_contracts}</div></div>
      <div class="stat-card"><div class="label">วงเงินคงค้าง (สัญญา active)</div><div class="value" style="font-size:18px;">${thb(d.total_principal_outstanding)}</div></div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดข้อมูลภาพรวมไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

/**
 * Replaces the whole dashboard body with a "your KYB application is under
 * review" notice — used only when GET /lender/dashboard itself reports
 * kyb_not_verified (a real Lender-org token, just not yet approved by
 * Platform Ops, e.g. right after registering via register-provider.html).
 * Deliberately does NOT log the user out — refreshing this same page after
 * approval will show the real dashboard with no need to log in again.
 */
function showKybPendingNotice(orgName, kybStatus) {
  document.getElementById("orgName").textContent = orgName || "-";
  const statusLabel = kybStatus === "Rejected" ? "ถูกปฏิเสธ" : "รอตรวจสอบ (KYB)";
  document.getElementById("mainContainer").innerHTML = `
    <div class="empty-state" style="padding:60px 24px;">
      <div style="font-size:40px; margin-bottom:14px;">⏳</div>
      <div style="font-size:17px; font-weight:700; color:var(--green-900); margin-bottom:8px;">
        ใบสมัครขององค์กรของท่านอยู่ในสถานะ: ${escapeHtml(statusLabel)}
      </div>
      <div style="font-size:14px;">
        เจ้าหน้าที่ผู้ดูแลระบบ (Platform Ops) กำลังตรวจสอบข้อมูลธุรกิจ (KYB) ของท่าน
        เมื่อได้รับการอนุมัติแล้ว ท่านจะสามารถเข้าใช้งานพอร์ทัลผู้ปล่อยกู้ได้เต็มรูปแบบ —
        ลองเข้าสู่ระบบใหม่อีกครั้งในภายหลัง หรือรีเฟรชหน้านี้
      </div>
    </div>
  `;
}

/**
 * Replaces the whole dashboard body with a "your Lender ROLE is not
 * approved" notice — distinct from showKybPendingNotice above. Used when
 * GET /lender/dashboard reports role_not_verified: the organization's
 * entity-level KYB is fine (otherwise kyb_not_verified would have fired
 * first — see requireLenderOrg in src/routes/lender.js), but this specific
 * org never requested the Lender role at all, or requested it and it's
 * still Pending/Rejected. Introduced by multi-role support — this is the
 * case for an org whose PRIMARY role is something else (e.g. Buyer) that
 * either hasn't asked for the Lender role yet (roleStatus is null — points
 * them at manage-roles.html to request it) or has and is waiting/was
 * turned down.
 */
function showRolePendingNotice(orgName, roleStatus) {
  document.getElementById("orgName").textContent = orgName || "-";
  const body = !roleStatus
    ? {
        title: "องค์กรของท่านยังไม่มีบทบาท \"ผู้ปล่อยกู้\"",
        detail: "หากต้องการเปิดใช้งานพอร์ทัลผู้ปล่อยกู้ ท่านสามารถส่งคำขอเพิ่มบทบาทนี้ได้จากหน้า \"จัดการบทบาทธุรกิจ\"",
      }
    : roleStatus === "Rejected"
    ? { title: "คำขอบทบาท \"ผู้ปล่อยกู้\" ของท่านถูกปฏิเสธ", detail: "กรุณาติดต่อเจ้าหน้าที่ผู้ดูแลระบบสำหรับข้อมูลเพิ่มเติม" }
    : { title: "คำขอบทบาท \"ผู้ปล่อยกู้\" ของท่านอยู่ระหว่างการตรวจสอบ", detail: "เจ้าหน้าที่ผู้ดูแลระบบ (Platform Ops) กำลังตรวจสอบคำขอนี้ — ลองรีเฟรชหน้านี้อีกครั้งภายหลัง" };

  document.getElementById("mainContainer").innerHTML = `
    <div class="empty-state" style="padding:60px 24px;">
      <div style="font-size:40px; margin-bottom:14px;">🧩</div>
      <div style="font-size:17px; font-weight:700; color:var(--green-900); margin-bottom:8px;">${escapeHtml(body.title)}</div>
      <div style="font-size:14px; margin-bottom:20px;">${escapeHtml(body.detail)}</div>
      <a href="../manage-roles.html" class="btn btn-primary" style="max-width:260px; margin:0 auto; display:block;">ไปที่หน้าจัดการบทบาทธุรกิจ</a>
    </div>
  `;
}

// ---------- รายการที่ต้องพิจารณา ----------
function reviewCard(a) {
  const defaultAmount = a.approved_amount || a.requested_amount;
  return `
    <div class="item-card" data-app-id="${a.application_id}">
      <div class="row"><span class="title">${escapeHtml(a.farmer_name)} — ${thb(a.requested_amount)}</span>${statusBadge(a.status)}</div>
      <div class="detail-line">คะแนนสินเชื่อล่าสุด: ${a.latest_score_value ?? "ไม่มีข้อมูล"} ${tierBadge(a.latest_risk_tier)}</div>
      ${a.purpose ? `<div class="detail-line">วัตถุประสงค์: ${escapeHtml(a.purpose)}</div>` : ""}
      <div class="detail-line muted">${escapeHtml(a.decision_reason || "")}</div>
      ${a.approved_amount ? `<div class="detail-line">วงเงินที่เสนอโดยระบบ: ${thb(a.approved_amount)}</div>` : ""}
      <div class="detail-line muted">ยื่นเมื่อ ${thaiDate(a.created_at)}</div>
      <div class="action-row">
        <input type="number" class="approve-amount-input" min="1" step="0.01" value="${defaultAmount}" title="วงเงินอนุมัติสุดท้าย" />
        <button type="button" class="btn btn-approve btn-sm approve-btn" data-id="${a.application_id}">อนุมัติ / แปลงเป็นสัญญา</button>
      </div>
      <div class="action-row">
        <input type="text" class="decline-reason-input" placeholder="เหตุผลการปฏิเสธ (ไม่บังคับ)" />
        <button type="button" class="btn btn-decline btn-sm decline-btn" data-id="${a.application_id}">ปฏิเสธ</button>
      </div>
    </div>
  `;
}

async function loadReviewQueue() {
  const el = document.getElementById("reviewQueueSection");
  try {
    const apps = await AgroLinkLenderAPI.get("/lender/loan-applications?status=action_needed");
    if (apps.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีรายการที่ต้องพิจารณาในขณะนี้</div>`;
      return;
    }
    el.innerHTML = apps.map(reviewCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการที่ต้องพิจารณาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function refreshAllAfterAction() {
  await Promise.all([loadSummary(), loadReviewQueue(), loadAllApplications(), loadContracts()]);
}

document.getElementById("reviewQueueSection").addEventListener("click", async (e) => {
  const card = e.target.closest(".item-card");
  if (!card) return;
  const applicationId = card.dataset.appId;

  if (e.target.classList.contains("approve-btn")) {
    const amountInput = card.querySelector(".approve-amount-input");
    const finalAmount = Number(amountInput.value);
    if (!finalAmount || finalAmount <= 0) {
      toast("กรุณาระบุวงเงินอนุมัติที่มากกว่า 0", true);
      return;
    }
    e.target.disabled = true;
    try {
      await AgroLinkLenderAPI.post(`/lender/loan-applications/${applicationId}/approve`, { final_amount: finalAmount });
      toast("อนุมัติและแปลงเป็นสัญญาเรียบร้อยแล้ว");
      await refreshAllAfterAction();
    } catch (err) {
      toast("อนุมัติไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      e.target.disabled = false;
    }
  } else if (e.target.classList.contains("decline-btn")) {
    const reasonInput = card.querySelector(".decline-reason-input");
    e.target.disabled = true;
    try {
      await AgroLinkLenderAPI.post(`/lender/loan-applications/${applicationId}/decline`, { reason: reasonInput.value || undefined });
      toast("ปฏิเสธคำขอเรียบร้อยแล้ว");
      await refreshAllAfterAction();
    } catch (err) {
      toast("ปฏิเสธไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      e.target.disabled = false;
    }
  }
});

// ---------- คำขอสินเชื่อทั้งหมด (อ่านอย่างเดียว) ----------
async function loadAllApplications() {
  const el = document.getElementById("allApplicationsSection");
  const status = document.getElementById("statusFilter").value;
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  try {
    const apps = await AgroLinkLenderAPI.get(`/lender/loan-applications${query}`);
    if (apps.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีคำขอสินเชื่อในสถานะนี้</div>`;
      return;
    }
    el.innerHTML = apps.map((a) => `
      <div class="item-card">
        <div class="row"><span class="title">${escapeHtml(a.farmer_name)} — ${thb(a.requested_amount)}</span>${statusBadge(a.status)}</div>
        <div class="detail-line">คะแนนสินเชื่อล่าสุด: ${a.latest_score_value ?? "ไม่มีข้อมูล"} ${tierBadge(a.latest_risk_tier)}</div>
        ${a.purpose ? `<div class="detail-line">${escapeHtml(a.purpose)}</div>` : ""}
        ${a.decision_reason ? `<div class="detail-line muted">${escapeHtml(a.decision_reason)}</div>` : ""}
        ${a.approved_amount ? `<div class="detail-line">วงเงินอนุมัติ: ${thb(a.approved_amount)}</div>` : ""}
        <div class="detail-line muted">ยื่นเมื่อ ${thaiDate(a.created_at)}${a.decided_at ? " · ตัดสินใจเมื่อ " + thaiDate(a.decided_at) : ""}</div>
      </div>
    `).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำขอสินเชื่อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("statusFilter").addEventListener("change", () => loadAllApplications());

// ---------- พอร์ตสัญญาสินเชื่อ ----------
async function loadContracts() {
  const el = document.getElementById("contractsSection");
  try {
    const contracts = await AgroLinkLenderAPI.get("/lender/contracts");
    if (contracts.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีสัญญาในพอร์ต</div>`;
      return;
    }
    el.innerHTML = contracts.map((c) => `
      <div class="item-card">
        <div class="row"><span class="title">${escapeHtml(CONTRACT_TYPE_LABEL[c.contract_type] || c.contract_type)}</span>${statusBadge(c.status)}</div>
        ${c.principal_amount ? `<div class="detail-line">วงเงินต้น: ${thb(c.principal_amount)}</div>` : ""}
        ${c.terms_summary ? `<div class="detail-line muted">${escapeHtml(c.terms_summary)}</div>` : ""}
        <div class="detail-line muted">เริ่ม ${thaiDate(c.effective_date)}${c.expiry_date ? " · สิ้นสุด " + thaiDate(c.expiry_date) : ""}</div>
      </div>
    `).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดพอร์ตสัญญาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkLenderAPI.logout());

/**
 * GET /lender/dashboard doubles as the KYB gate check here: if it reports
 * kyb_not_verified, none of the other endpoints would succeed either (same
 * requireLenderOrg middleware guards all of them), so there's no point
 * firing them — just show the pending notice and stop.
 */
async function init() {
  try {
    await AgroLinkLenderAPI.get("/lender/dashboard").then((d) => {
      document.getElementById("orgName").textContent = d.org_name || "-";
      document.getElementById("summarySection").innerHTML = `
        <div class="stat-card"><div class="label">รายการที่ต้องพิจารณา</div><div class="value">${d.needs_action_count}</div></div>
        <div class="stat-card"><div class="label">รอประเมินอัตโนมัติ</div><div class="value">${d.applications_by_status.pending}</div></div>
        <div class="stat-card"><div class="label">ปฏิเสธแล้ว</div><div class="value">${d.applications_by_status.declined}</div></div>
        <div class="stat-card"><div class="label">แปลงเป็นสัญญาแล้ว</div><div class="value">${d.applications_by_status.converted}</div></div>
        <div class="stat-card"><div class="label">สัญญาที่ใช้งานอยู่</div><div class="value">${d.active_contracts}</div></div>
        <div class="stat-card"><div class="label">วงเงินคงค้าง (สัญญา active)</div><div class="value" style="font-size:18px;">${thb(d.total_principal_outstanding)}</div></div>
      `;
    });
  } catch (err) {
    if (err.message === "kyb_not_verified") {
      showKybPendingNotice(err.body.org_name, err.body.kyb_status);
      return;
    }
    if (err.message === "role_not_verified") {
      showRolePendingNotice(err.body.org_name, err.body.role_status);
      return;
    }
    document.getElementById("summarySection").innerHTML = `<div class="empty-state">โหลดข้อมูลภาพรวมไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    return;
  }

  // Only reached once KYB AND the Lender role are both confirmed Verified —
  // independent panels below, one broken panel doesn't take down the rest
  // of the page.
  loadReviewQueue();
  loadAllApplications();
  loadContracts();
}

init();
