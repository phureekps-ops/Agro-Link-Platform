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
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function thb(n) {
  return Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2 });
}

/**
 * Replaces the whole dashboard body with a "your KYB application is under
 * review" notice — same shape/reasoning as every other portal's own copy
 * (see inputsupplier/js/dashboard.js's showKybPendingNotice doc comment).
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
        เมื่อได้รับการอนุมัติแล้ว ท่านจะสามารถพิจารณาคำขอสินเชื่อได้เต็มรูปแบบ —
        ลองเข้าสู่ระบบใหม่อีกครั้งในภายหลัง หรือรีเฟรชหน้านี้
      </div>
    </div>
  `;
}

/**
 * Same shape as inputsupplier/js/dashboard.js's showRolePendingNotice — the
 * org has cleared entity KYB but doesn't (yet) hold a Verified 'Lender' role.
 */
function showRolePendingNotice(orgName, roleStatus) {
  document.getElementById("orgName").textContent = orgName || "-";
  const body = !roleStatus
    ? {
        title: "องค์กรของท่านยังไม่มีบทบาทผู้ปล่อยกู้",
        detail: "หากต้องการเปิดใช้งานพอร์ทัลนี้ ท่านสามารถส่งคำขอเพิ่มบทบาทได้จากหน้า \"จัดการบทบาทธุรกิจ\"",
      }
    : roleStatus === "Rejected"
    ? { title: "คำขอบทบาทผู้ปล่อยกู้ของท่านถูกปฏิเสธ", detail: "กรุณาติดต่อเจ้าหน้าที่ผู้ดูแลระบบสำหรับข้อมูลเพิ่มเติม" }
    : { title: "คำขอบทบาทผู้ปล่อยกู้ของท่านอยู่ระหว่างการตรวจสอบ", detail: "เจ้าหน้าที่ผู้ดูแลระบบ (Platform Ops) กำลังตรวจสอบคำขอนี้ — ลองรีเฟรชหน้านี้อีกครั้งภายหลัง" };

  document.getElementById("mainContainer").innerHTML = `
    <div class="empty-state" style="padding:60px 24px;">
      <div style="font-size:40px; margin-bottom:14px;">🧩</div>
      <div style="font-size:17px; font-weight:700; color:var(--green-900); margin-bottom:8px;">${escapeHtml(body.title)}</div>
      <div style="font-size:14px; margin-bottom:20px;">${escapeHtml(body.detail)}</div>
      <a href="../manage-roles.html" class="btn btn-primary" style="max-width:260px; margin:0 auto; display:block;">ไปที่หน้าจัดการบทบาทธุรกิจ</a>
    </div>
  `;
}

// ---------- ภาพรวม ----------
function renderSummary(d) {
  document.getElementById("orgName").textContent = d.org_name || "-";
  const byStatus = d.applications_by_status || {};
  document.getElementById("summarySection").innerHTML = `
    <div class="stat-card"><div class="label">สถานะ KYB</div><div class="value" style="font-size:16px;">${escapeHtml(d.kyb_status)}</div></div>
    <div class="stat-card"><div class="label">รอตรวจสอบ</div><div class="value">${byStatus.manual_review || 0}</div></div>
    <div class="stat-card"><div class="label">อนุมัติเบื้องต้นแล้ว</div><div class="value">${byStatus.approved || 0}</div></div>
    <div class="stat-card"><div class="label">แปลงเป็นสัญญาแล้ว</div><div class="value">${byStatus.converted || 0}</div></div>
    <div class="stat-card"><div class="label">สัญญาที่ยังดำเนินอยู่</div><div class="value">${d.active_contracts}</div></div>
    <div class="stat-card"><div class="label">เงินต้นคงค้างรวม</div><div class="value" style="font-size:16px;">${thb(d.total_principal_outstanding)}</div></div>
  `;
}

async function refreshSummary() {
  try {
    const d = await AgroLinkLenderAPI.get("/lender/dashboard");
    renderSummary(d);
  } catch (err) {
    // Dashboard already loaded once successfully to get this far — a
    // transient failure on refresh isn't worth interrupting the user.
  }
}

// ---------- คำขอสินเชื่อ ----------
const APPLICATION_STATUS_LABEL_TH = {
  pending: "รอการประเมินอัตโนมัติ",
  manual_review: "รอตรวจสอบโดยผู้ปล่อยกู้",
  approved: "อนุมัติเบื้องต้นแล้ว (รอแปลงเป็นสัญญา)",
  declined: "ปฏิเสธแล้ว",
  converted: "แปลงเป็นสัญญาแล้ว",
};
const APPLICATION_STATUS_BADGE_CLASS = {
  pending: "status-pending",
  manual_review: "status-manual_review",
  approved: "status-approved",
  declined: "status-declined",
  converted: "status-converted",
};

function applicationCard(a) {
  const badgeClass = APPLICATION_STATUS_BADGE_CLASS[a.status] || "status-pending";
  const badge = `<span class="badge ${badgeClass}">${escapeHtml(APPLICATION_STATUS_LABEL_TH[a.status] || a.status)}</span>`;

  let actions = "";
  if (a.status === "manual_review" || a.status === "approved") {
    actions = `
      <div class="action-row">
        <input type="number" min="0" step="0.01" class="reject-reason-input" data-final-amount-for="${a.application_id}" placeholder="วงเงินอนุมัติสุดท้าย (ไม่บังคับ)" />
        <button type="button" class="btn btn-approve btn-sm" data-approve-application="${a.application_id}">อนุมัติ / แปลงเป็นสัญญา</button>
      </div>
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-decline-reason-for="${a.application_id}" placeholder="เหตุผลการปฏิเสธ (ไม่บังคับ)" />
        <button type="button" class="btn btn-decline btn-sm" data-decline-application="${a.application_id}">ปฏิเสธ</button>
      </div>
    `;
  }

  return `
    <div class="item-card" data-application-id="${a.application_id}">
      <div class="row"><span class="title">${escapeHtml(a.farmer_name)} — ${escapeHtml(a.purpose || "ไม่ระบุวัตถุประสงค์")}</span>${badge}</div>
      <div class="detail-line">ขอสินเชื่อ ${thb(a.requested_amount)} บาท${a.approved_amount ? ` · อนุมัติจริง ${thb(a.approved_amount)} บาท` : ""}</div>
      ${a.latest_score_value !== null && a.latest_score_value !== undefined ? `<div class="detail-line">คะแนนเครดิตล่าสุด: ${a.latest_score_value} <span class="badge tier-${escapeHtml(a.latest_risk_tier || "")}">${escapeHtml(a.latest_risk_tier || "-")}</span></div>` : ""}
      ${a.decision_reason ? `<div class="detail-line muted">เหตุผล: ${escapeHtml(a.decision_reason)}</div>` : ""}
      <div class="detail-line muted">ยื่นคำขอเมื่อ ${thaiDate(a.created_at)}${a.decided_at ? " · ตัดสินใจเมื่อ " + thaiDate(a.decided_at) : ""}</div>
      ${actions}
    </div>
  `;
}

async function loadApplicationReviewQueue() {
  const el = document.getElementById("applicationReviewQueueSection");
  try {
    const apps = await AgroLinkLenderAPI.get("/lender/loan-applications?status=action_needed");
    if (apps.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีคำขอสินเชื่อที่ต้องดำเนินการในขณะนี้</div>`;
      return;
    }
    el.innerHTML = apps.map(applicationCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำขอสินเชื่อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadApplicationHistory() {
  const el = document.getElementById("applicationHistorySection");
  const status = document.getElementById("applicationStatusFilter").value;
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const apps = await AgroLinkLenderAPI.get(`/lender/loan-applications${query}`);
    if (apps.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีคำขอสินเชื่อ</div>`;
      return;
    }
    el.innerHTML = apps.map(applicationCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประวัติคำขอสินเชื่อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function refreshApplicationsAndSummary() {
  await Promise.all([loadApplicationReviewQueue(), loadApplicationHistory(), refreshSummary()]);
}

document.getElementById("applicationStatusFilter").addEventListener("change", () => loadApplicationHistory());

function handleApplicationActionClick(container) {
  container.addEventListener("click", async (e) => {
    const approveBtn = e.target.closest("[data-approve-application]");
    const declineBtn = e.target.closest("[data-decline-application]");

    if (approveBtn) {
      const applicationId = approveBtn.dataset.approveApplication;
      const amountInput = container.querySelector(`[data-final-amount-for="${applicationId}"]`);
      const rawAmount = amountInput ? amountInput.value.trim() : "";
      approveBtn.disabled = true;
      try {
        await AgroLinkLenderAPI.post(`/lender/loan-applications/${applicationId}/approve`, {
          final_amount: rawAmount ? Number(rawAmount) : undefined,
        });
        toast("อนุมัติคำขอสินเชื่อและแปลงเป็นสัญญาเรียบร้อยแล้ว");
        await refreshApplicationsAndSummary();
        await loadContracts();
      } catch (err) {
        toast("ดำเนินการไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
        approveBtn.disabled = false;
      }
      return;
    }

    if (declineBtn) {
      const applicationId = declineBtn.dataset.declineApplication;
      const reasonInput = container.querySelector(`[data-decline-reason-for="${applicationId}"]`);
      declineBtn.disabled = true;
      try {
        await AgroLinkLenderAPI.post(`/lender/loan-applications/${applicationId}/decline`, {
          reason: (reasonInput && reasonInput.value.trim()) || null,
        });
        toast("ปฏิเสธคำขอสินเชื่อเรียบร้อยแล้ว");
        await refreshApplicationsAndSummary();
      } catch (err) {
        toast("ดำเนินการไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
        declineBtn.disabled = false;
      }
    }
  });
}

handleApplicationActionClick(document.getElementById("applicationReviewQueueSection"));
handleApplicationActionClick(document.getElementById("applicationHistorySection"));

// ---------- พอร์ตสัญญาเงินกู้ ----------
const CONTRACT_STATUS_LABEL_TH = {
  draft: "ร่าง", pending_signature: "รอลงนาม", active: "ดำเนินอยู่",
  completed: "เสร็จสิ้น", terminated: "ยกเลิก", breached: "ผิดสัญญา",
};

function contractCard(c) {
  return `
    <div class="item-card" data-contract-id="${c.contract_id}">
      <div class="row">
        <span class="title">สัญญา ${escapeHtml(c.contract_type || "-")}</span>
        <span class="badge status-${escapeHtml(c.status)}">${escapeHtml(CONTRACT_STATUS_LABEL_TH[c.status] || c.status)}</span>
      </div>
      <div class="detail-line">เงินต้น ${thb(c.principal_amount)} ${escapeHtml(c.currency || "THB")}</div>
      <div class="detail-line muted">มีผล ${thaiDate(c.effective_date)} ถึง ${thaiDate(c.expiry_date)}</div>
      ${c.terms_summary ? `<div class="detail-line muted">${escapeHtml(c.terms_summary)}</div>` : ""}
      <div class="detail-line muted">สร้างเมื่อ ${thaiDate(c.created_at)}</div>
    </div>
  `;
}

async function loadContracts() {
  const el = document.getElementById("contractListSection");
  try {
    const contracts = await AgroLinkLenderAPI.get("/lender/contracts");
    if (contracts.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีสัญญาเงินกู้</div>`;
      return;
    }
    el.innerHTML = contracts.map(contractCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดสัญญาเงินกู้ไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkLenderAPI.logout());

/**
 * GET /lender/dashboard doubles as the KYB/role gate check here — same
 * pattern as every other portal's init().
 */
async function init() {
  const session = AgroLinkLenderAPI.requireSessionOrRedirect();
  if (!session) return;

  try {
    const d = await AgroLinkLenderAPI.get("/lender/dashboard");
    renderSummary(d);
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

  loadApplicationReviewQueue();
  loadApplicationHistory();
  loadContracts();
}

init();
