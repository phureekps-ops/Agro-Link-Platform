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

// ---------- Farmer 360° View ----------
// See FARMER_360_ARCHITECTURE.md §4 (visibility model) and
// backend/src/routes/farmer360.js for exactly what each response field
// means and why. This MVP round is membership + land + transactions only
// — no consent workflow, no credit score (both explicitly deferred).
const RELATIONSHIP_TYPE_LABEL_TH = {
  CooperativeMember: "สมาชิกสหกรณ์",
  VillageFundMember: "สมาชิกกองทุนหมู่บ้าน",
  LoanCustomer: "ลูกค้าสินเชื่อ",
  Other: "อื่น ๆ",
};

function relationshipTypeLabel(t) {
  return RELATIONSHIP_TYPE_LABEL_TH[t] || t || "-";
}

function farmer360SearchResultCard(f) {
  return `
    <div class="item-card" data-search-farmer-id="${f.farmer_id}">
      <div class="row"><span class="title">${escapeHtml(f.full_name)}</span><span class="badge">${escapeHtml(f.farmer_code)}</span></div>
      <div class="action-row">
        <button type="button" class="btn btn-primary btn-sm" data-add-farmer="${f.farmer_id}">เพิ่มเป็นลูกค้า</button>
      </div>
    </div>
  `;
}

async function handleFarmer360Search() {
  const codeInput = document.getElementById("farmer360SearchCode");
  const phoneInput = document.getElementById("farmer360SearchPhone");
  const el = document.getElementById("farmer360SearchResultSection");
  const code = codeInput.value.trim();
  const phone = phoneInput.value.trim();
  if (!code && !phone) {
    toast("กรุณากรอกรหัส AgroLink ID หรือเบอร์โทร", true);
    return;
  }
  const query = code ? `code=${encodeURIComponent(code)}` : `phone=${encodeURIComponent(phone)}`;
  el.innerHTML = `<div class="loading-line">กำลังค้นหา…</div>`;
  try {
    const farmer = await AgroLinkLenderAPI.get(`/farmer360/search?${query}`);
    el.innerHTML = farmer360SearchResultCard(farmer);
  } catch (err) {
    if (err.status === 404) {
      el.innerHTML = `<div class="empty-state">ไม่พบเกษตรกรที่ตรงกับข้อมูลที่ค้นหา</div>`;
    } else {
      el.innerHTML = `<div class="empty-state">ค้นหาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    }
  }
}

document.getElementById("farmer360SearchBtn").addEventListener("click", handleFarmer360Search);

document.getElementById("farmer360SyncBtn").addEventListener("click", async () => {
  const btn = document.getElementById("farmer360SyncBtn");
  btn.disabled = true;
  try {
    const result = await AgroLinkLenderAPI.post("/farmer360/relationships/sync");
    toast(`ซิงค์สำเร็จ — เพิ่มลูกค้าใหม่ ${result.linked_count} ราย`);
    await loadFarmer360Roster();
  } catch (err) {
    toast("ซิงค์ไม่สำเร็จ: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("farmer360SearchResultSection").addEventListener("click", async (e) => {
  const addBtn = e.target.closest("[data-add-farmer]");
  if (!addBtn) return;
  const farmerId = addBtn.dataset.addFarmer;
  addBtn.disabled = true;
  try {
    await AgroLinkLenderAPI.post("/farmer360/relationships", { farmer_id: farmerId });
    toast("เพิ่มเกษตรกรเป็นลูกค้าเรียบร้อยแล้ว");
    document.getElementById("farmer360SearchResultSection").innerHTML = "";
    document.getElementById("farmer360SearchCode").value = "";
    document.getElementById("farmer360SearchPhone").value = "";
    await loadFarmer360Roster();
  } catch (err) {
    toast("เพิ่มลูกค้าไม่สำเร็จ: " + err.message, true);
    addBtn.disabled = false;
  }
});

function farmer360TransactionLine(label, tx) {
  if (!tx) return "";
  const amountPart = tx.total_amount !== undefined ? ` — ${thb(tx.total_amount)} บาท` : "";
  return `<div class="detail-line">${label}: ${tx.count} รายการ${amountPart}</div>`;
}

function render360Detail(view) {
  const membershipsHtml = view.memberships.length
    ? view.memberships.map((m) => `<span class="badge">${escapeHtml(m.org_name)} (${relationshipTypeLabel(m.relationship_type)})</span>`).join(" ")
    : `<span class="detail-line muted">ไม่มีข้อมูลสมาชิกภาพอื่น</span>`;

  const landHtml = view.land.length
    ? view.land.map((l) => `<div class="detail-line">${escapeHtml(l.commodity_name)} — ${l.area_rai} ไร่ (${escapeHtml(l.unit_type)})</div>`).join("")
    : `<div class="detail-line muted">ไม่มีข้อมูลที่ดิน/แปลง</div>`;

  return `
    <div class="item-card" style="margin-top:8px; background:var(--gray-50);">
      <div class="row"><span class="title">👤 ${escapeHtml(view.farmer.full_name)}</span><span class="badge">${escapeHtml(view.farmer.farmer_code)}</span></div>
      <div class="detail-line muted">โทร ${escapeHtml(view.farmer.phone || "-")} · พื้นที่ ${escapeHtml(view.farmer.region_code || "-")}</div>

      <div class="detail-line" style="margin-top:10px; font-weight:600;">🏞️ ที่ดิน/แปลงปลูก</div>
      ${landHtml}

      <div class="detail-line" style="margin-top:10px; font-weight:600;">🏷️ สมาชิกภาพกับหน่วยงานอื่น</div>
      <div class="detail-line">${membershipsHtml}</div>

      <div class="detail-line" style="margin-top:10px; font-weight:600;">💳 ธุรกรรมกับท่าน</div>
      ${farmer360TransactionLine("ขายผลผลิต", view.transactions.produce_sales)}
      ${farmer360TransactionLine("คำขอสินเชื่อ", view.transactions.loans)}
      ${farmer360TransactionLine("ซื้อปัจจัยการผลิต", view.transactions.input_purchases)}
      ${farmer360TransactionLine("เช่าเครื่องจักร", view.transactions.machinery_rental)}

      <div class="detail-line muted" style="margin-top:10px;">
        คะแนนเครดิต: ยังไม่แสดงในรอบนี้ — รอระบบยินยอม (consent) ในรอบถัดไป
      </div>
    </div>
  `;
}

function farmer360RosterCard(r) {
  return `
    <div class="item-card" data-roster-farmer-id="${r.farmer_id}">
      <div class="row">
        <span class="title">${escapeHtml(r.full_name)}</span>
        <span class="badge">${escapeHtml(r.farmer_code)}</span>
      </div>
      <div class="detail-line muted">${relationshipTypeLabel(r.relationship_type)} · เป็นลูกค้าตั้งแต่ ${thaiDate(r.joined_at)}</div>
      <div class="action-row">
        <button type="button" class="btn btn-ghost btn-sm" data-view360="${r.farmer_id}">ดูข้อมูล 360°</button>
        <button type="button" class="btn btn-primary btn-sm" data-toggle-issue-credit-line="${r.farmer_id}">🏦 ออกวงเงินสินเชื่อ</button>
        <button type="button" class="btn btn-decline btn-sm" data-unlink-farmer="${r.farmer_id}">เลิกเป็นลูกค้า</button>
      </div>
      <div data-issue-credit-line-form-container="${r.farmer_id}" style="display:none; margin-top:8px;">
        <div class="form-grid">
          <div class="field">
            <label>วงเงินสูงสุด (บาท)</label>
            <input type="number" min="1" step="0.01" data-cl-limit="${r.farmer_id}" placeholder="เช่น 20000" />
          </div>
          <div class="field">
            <label>ดอกเบี้ยต่อวัน (% ต่อวัน)</label>
            <input type="number" min="0.001" step="0.001" value="0.05" data-cl-interest="${r.farmer_id}" />
          </div>
          <div class="field">
            <label>ระยะเวลาเบิกแต่ละครั้ง (วัน)</label>
            <input type="number" min="1" step="1" value="30" data-cl-tenor="${r.farmer_id}" />
          </div>
        </div>
        <div class="action-row">
          <button type="button" class="btn btn-primary btn-sm" data-submit-issue-credit-line="${r.farmer_id}">ยืนยันออกวงเงิน</button>
        </div>
      </div>
      <div data-detail-for="${r.farmer_id}"></div>
    </div>
  `;
}

async function loadFarmer360Roster() {
  const el = document.getElementById("farmer360RosterSection");
  try {
    const roster = await AgroLinkLenderAPI.get("/farmer360/relationships/mine");
    if (roster.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีเกษตรกรที่เป็นลูกค้า — ค้นหาและเพิ่ม หรือกด "ซิงค์ลูกค้าจากธุรกรรมเดิมอัตโนมัติ" ด้านบน</div>`;
      return;
    }
    el.innerHTML = roster.map(farmer360RosterCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายชื่อลูกค้าไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("farmer360RosterSection").addEventListener("click", async (e) => {
  const viewBtn = e.target.closest("[data-view360]");
  const unlinkBtn = e.target.closest("[data-unlink-farmer]");
  const toggleCreditBtn = e.target.closest("[data-toggle-issue-credit-line]");
  const submitCreditBtn = e.target.closest("[data-submit-issue-credit-line]");

  if (toggleCreditBtn) {
    const farmerId = toggleCreditBtn.dataset.toggleIssueCreditLine;
    const container = document.querySelector(`[data-issue-credit-line-form-container="${farmerId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    container.style.display = isHidden ? "block" : "none";
    toggleCreditBtn.textContent = isHidden ? "ยกเลิก" : "🏦 ออกวงเงินสินเชื่อ";
    return;
  }

  if (submitCreditBtn) {
    const farmerId = submitCreditBtn.dataset.submitIssueCreditLine;
    const limitInput = document.querySelector(`[data-cl-limit="${farmerId}"]`);
    const interestInput = document.querySelector(`[data-cl-interest="${farmerId}"]`);
    const tenorInput = document.querySelector(`[data-cl-tenor="${farmerId}"]`);
    const creditLimit = Number(limitInput ? limitInput.value : 0);
    const interestPercent = Number(interestInput ? interestInput.value : 0);
    const tenorDays = Number(tenorInput ? tenorInput.value : 0);

    if (!Number.isFinite(creditLimit) || creditLimit <= 0) {
      toast("กรุณากรอกวงเงินสูงสุดที่มากกว่า 0", true);
      return;
    }
    if (!Number.isFinite(interestPercent) || interestPercent <= 0) {
      toast("กรุณากรอกอัตราดอกเบี้ยต่อวันที่มากกว่า 0", true);
      return;
    }
    // Backend stores interest as integer basis-points/day — 1% = 100 bps —
    // so the human-friendly "% ต่อวัน" input is converted here, once, right
    // before it leaves the browser.
    const interestRateDailyBps = Math.round(interestPercent * 100);

    submitCreditBtn.disabled = true;
    try {
      await AgroLinkLenderAPI.post("/lender/credit-lines", {
        farmer_id: farmerId,
        credit_limit: creditLimit,
        interest_rate_daily_bps: interestRateDailyBps,
        tenor_days: Number.isFinite(tenorDays) && tenorDays > 0 ? tenorDays : undefined,
      });
      toast("ออกวงเงินสินเชื่อเรียบร้อยแล้ว");
      const container = document.querySelector(`[data-issue-credit-line-form-container="${farmerId}"]`);
      if (container) container.style.display = "none";
      await loadCreditLinePortfolio();
    } catch (err) {
      toast("ออกวงเงินไม่สำเร็จ: " + ((err.body && err.body.detail) || err.message), true);
    } finally {
      submitCreditBtn.disabled = false;
    }
    return;
  }

  if (viewBtn) {
    const farmerId = viewBtn.dataset.view360;
    const detailEl = document.querySelector(`[data-detail-for="${farmerId}"]`);
    if (detailEl.dataset.expanded === "true") {
      detailEl.innerHTML = "";
      detailEl.dataset.expanded = "false";
      viewBtn.textContent = "ดูข้อมูล 360°";
      return;
    }
    viewBtn.disabled = true;
    try {
      const view = await AgroLinkLenderAPI.get(`/farmer360/${farmerId}`);
      detailEl.innerHTML = render360Detail(view);
      detailEl.dataset.expanded = "true";
      viewBtn.textContent = "ซ่อนข้อมูล 360°";
    } catch (err) {
      toast("โหลดข้อมูล 360° ไม่สำเร็จ: " + err.message, true);
    } finally {
      viewBtn.disabled = false;
    }
    return;
  }

  if (unlinkBtn) {
    const farmerId = unlinkBtn.dataset.unlinkFarmer;
    unlinkBtn.disabled = true;
    try {
      await AgroLinkLenderAPI.del(`/farmer360/relationships/${farmerId}`);
      toast("เลิกเป็นลูกค้าเรียบร้อยแล้ว");
      await loadFarmer360Roster();
    } catch (err) {
      toast("ดำเนินการไม่สำเร็จ: " + err.message, true);
      unlinkBtn.disabled = false;
    }
  }
});

// ---------- วงเงินสินเชื่อหมุนเวียน (Trade Credit) ----------
// See grant_input_credit_line.sql — a standing, pre-approved revolving line
// this lender extends to one of its farmer "customers" (roster above). A
// farmer draws it down one purchase at a time from the marketplace; this
// lender only ever sees the resulting exposure/portfolio here, it never
// initiates a drawdown itself.
const CREDIT_LINE_STATUS_LABEL_TH = {
  active: "ใช้งานอยู่",
  suspended: "ระงับชั่วคราว",
  closed: "ปิดแล้ว",
};
const CREDIT_LINE_STATUS_BADGE_CLASS = {
  active: "status-active",
  suspended: "status-pending",
  closed: "status-declined",
};
const CREDIT_DRAWDOWN_STATUS_LABEL_TH = {
  outstanding: "ค้างชำระ",
  repaid: "ชำระแล้ว",
};

function thaiDateOnly(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

function creditLineCard(cl) {
  const badgeClass = CREDIT_LINE_STATUS_BADGE_CLASS[cl.status] || "status-pending";
  return `
    <div class="item-card" data-credit-line-id="${cl.credit_line_id}">
      <div class="row">
        <span class="title">${escapeHtml(cl.farmer_name)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(CREDIT_LINE_STATUS_LABEL_TH[cl.status] || cl.status)}</span>
      </div>
      <div class="detail-line">วงเงิน ${thb(cl.credit_limit)} บาท · ดอกเบี้ย ${(cl.interest_rate_daily_bps / 100).toFixed(3)}% ต่อวัน · เบิกได้ครั้งละไม่เกิน ${cl.tenor_days} วัน</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">เบิกใช้แล้ว ${thb(cl.outstanding_total)} บาท · คงเหลือให้เบิก ${thb(cl.available_credit)} บาท</div>
      <div class="detail-line muted">ออกวงเงินเมื่อ ${thaiDate(cl.created_at)}</div>
      <div class="action-row">
        <button type="button" class="btn btn-ghost btn-sm" data-toggle-drawdowns="${cl.credit_line_id}">ดูรายการเบิกใช้</button>
      </div>
      <div data-drawdowns-container="${cl.credit_line_id}" style="display:none;"></div>
    </div>
  `;
}

function lenderDrawdownRow(d) {
  const isOutstanding = d.status === "outstanding";
  return `
    <div class="item-card" style="margin-top:8px;">
      <div class="row">
        <span class="title">${escapeHtml(d.product_name || "รายการเบิกใช้")}${d.supplier_name ? " · " + escapeHtml(d.supplier_name) : ""}</span>
        <span class="badge ${isOutstanding ? "status-pending" : "status-approved"}">${escapeHtml(CREDIT_DRAWDOWN_STATUS_LABEL_TH[d.status] || d.status)}</span>
      </div>
      <div class="detail-line">เงินต้น ${thb(d.principal_amount)} บาท · ค่าธรรมเนียมแพลตฟอร์ม ${thb(d.platform_fee_amount)} บาท · โอนให้ผู้ขาย ${thb(d.net_amount_to_supplier)} บาท</div>
      <div class="detail-line muted">เบิกเมื่อ ${thaiDate(d.drawn_at)} · ครบกำหนด ${thaiDateOnly(d.due_date)}</div>
      ${!isOutstanding ? `<div class="detail-line muted">ชำระแล้ว ${thb(d.repaid_amount)} บาท เมื่อ ${thaiDate(d.repaid_at)}</div>` : ""}
    </div>
  `;
}

async function loadCreditLinePortfolio() {
  const el = document.getElementById("creditLinePortfolioSection");
  try {
    const lines = await AgroLinkLenderAPI.get("/lender/credit-lines");
    el.innerHTML = lines.length === 0
      ? `<div class="empty-state">ยังไม่มีวงเงินสินเชื่อที่ออกให้ — ออกวงเงินแรกได้จากปุ่ม "🏦 ออกวงเงินสินเชื่อ" บนการ์ดของเกษตรกรที่เป็นลูกค้าของท่านด้านบน</div>`
      : lines.map(creditLineCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดวงเงินสินเชื่อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("creditLinePortfolioSection").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-toggle-drawdowns]");
  if (!toggleBtn) return;
  const creditLineId = toggleBtn.dataset.toggleDrawdowns;
  const container = document.querySelector(`[data-drawdowns-container="${creditLineId}"]`);
  if (!container) return;
  const isHidden = container.style.display === "none";
  if (!isHidden) {
    container.style.display = "none";
    toggleBtn.textContent = "ดูรายการเบิกใช้";
    return;
  }
  container.style.display = "block";
  toggleBtn.textContent = "ซ่อนรายการเบิกใช้";
  container.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const drawdowns = await AgroLinkLenderAPI.get(`/lender/credit-lines/${creditLineId}/drawdowns`);
    container.innerHTML = drawdowns.length === 0
      ? `<div class="muted" style="font-size:12px; padding:8px 0;">ยังไม่มีรายการเบิกใช้</div>`
      : drawdowns.map(lenderDrawdownRow).join("");
  } catch (err) {
    container.innerHTML = `<div class="muted" style="font-size:12px;">โหลดรายการเบิกใช้ไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
});

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
  loadFarmer360Roster();
  loadCreditLinePortfolio();
}

init();
