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

// Lookup maps filled in once /farmer/lenders and /farmer/production-units
// have loaded, so loan-application cards (which only carry raw
// lender_org_id / related_unit_id from the backend) can still show a
// human-readable name instead of a bare UUID.
let lenderNameById = {};
let unitLabelById = {};

// ---------- ภาพรวมบัญชี (reporting.v_farmer_360) ----------
function renderSummary(d) {
  document.getElementById("farmerName").textContent = d.full_name || "-";
  document.getElementById("summarySection").innerHTML = `
    <div class="stat-card"><div class="label">แปลง / หน่วยผลิต</div><div class="value">${d.production_units_count || 0}</div></div>
    <div class="stat-card"><div class="label">สัญญาทั้งหมด</div><div class="value">${d.contracts_total || 0}</div><div class="sub">เสร็จสิ้นแล้ว ${d.contracts_completed || 0} สัญญา</div></div>
    <div class="stat-card"><div class="label">คะแนนสินเชื่อล่าสุด</div><div class="value">${d.latest_credit_score !== null && d.latest_credit_score !== undefined ? d.latest_credit_score : "-"} ${d.latest_risk_tier ? `<span class="badge tier-${escapeHtml(d.latest_risk_tier)}">${escapeHtml(d.latest_risk_tier)}</span>` : ""}</div></div>
    <div class="stat-card"><div class="label">ยอดชำระคืนเงินกู้สะสม</div><div class="value" style="font-size:16px;">${thb(d.total_loan_repaid)}</div></div>
    <div class="stat-card"><div class="label">ใบรับรองที่ได้รับ</div><div class="value">${d.certificates_count || 0}</div></div>
    <div class="stat-card"><div class="label">การส่งมอบที่ชำระเงินแล้ว</div><div class="value">${d.deliveries_settled_count || 0}</div></div>
  `;
}

async function refreshSummary() {
  try {
    const d = await AgroLinkAPI.get("/farmer/dashboard");
    renderSummary(d);
  } catch (err) {
    // Dashboard already loaded once successfully to get this far — a
    // transient failure on refresh isn't worth interrupting the user.
  }
}

// ---------- คะแนนความน่าเชื่อถือทางสินเชื่อ (risk.v_farmer_latest_score) ----------
const FACTOR_META = {
  production_reliability: { label: "ความสม่ำเสมอของการผลิต (ส่งมอบตรงเวลา)", numKey: "on_time" },
  contract_fulfillment: { label: "การปฏิบัติตามสัญญา (สัญญาที่เสร็จสมบูรณ์)", numKey: "completed" },
  loan_repayment: { label: "การชำระคืนเงินกู้ตรงเวลา", numKey: "on_time" },
  delivery_quality: { label: "คุณภาพการส่งมอบผลผลิต (ชำระเงินแล้ว)", numKey: "settled" },
};

function renderFactors(factors) {
  if (!factors) return "";
  const rows = Object.keys(FACTOR_META)
    .filter((key) => factors[key])
    .map((key) => {
      const meta = FACTOR_META[key];
      const f = factors[key];
      const score = Math.round(Number(f.factor_score || 0));
      return `
        <div class="factor-row">
          <div class="factor-label"><span>${escapeHtml(meta.label)}</span><span>${score}%</span></div>
          <div class="factor-bar-track"><div class="factor-bar-fill" style="width:${score}%;"></div></div>
          <div class="detail-line muted">${f[meta.numKey] || 0} จาก ${f.total || 0} รายการ</div>
        </div>
      `;
    })
    .join("");
  const note = factors.insufficient_data
    ? `<div class="detail-line muted">หมายเหตุ: ยังไม่มีข้อมูลกิจกรรมเพียงพอสำหรับบางปัจจัย คะแนนเริ่มต้นจึงถูกตั้งเป็นค่ากลาง</div>`
    : "";
  return rows + note;
}

function renderScoreLatest(latest) {
  const el = document.getElementById("scoreLatestPanel");
  if (!latest) {
    el.innerHTML = `<div class="empty-state">ยังไม่มีคะแนนสินเชื่อ — ระบบจะคำนวณคะแนนเมื่อมีข้อมูลกิจกรรม (แปลง/สัญญา/การชำระเงิน) เพียงพอ</div>`;
    return;
  }
  el.innerHTML = `
    <div style="display:flex; align-items:baseline; gap:10px; margin-bottom:6px;">
      <div style="font-size:32px; font-weight:700; color:var(--green-900);">${latest.score_value}</div>
      <span class="badge tier-${escapeHtml(latest.risk_tier)}">ระดับความเสี่ยง ${escapeHtml(latest.risk_tier)}</span>
    </div>
    <div class="detail-line muted" style="margin-bottom:14px;">คำนวณล่าสุดเมื่อ ${thaiDate(latest.computed_at)}</div>
    ${renderFactors(latest.factors)}
  `;
}

function renderScoreHistory(history) {
  const el = document.getElementById("scoreHistoryPanel");
  if (!history || history.length === 0) {
    el.innerHTML = `<div class="empty-state">ยังไม่มีประวัติคะแนนสินเชื่อ</div>`;
    return;
  }
  el.innerHTML = history
    .map(
      (h) => `
        <div class="item-card">
          <div class="row">
            <span class="title">คะแนน ${h.score_value}</span>
            <span class="badge tier-${escapeHtml(h.risk_tier)}">${escapeHtml(h.risk_tier)}</span>
          </div>
          <div class="detail-line muted">คำนวณเมื่อ ${thaiDate(h.computed_at)}${h.model_version ? ` · รุ่นโมเดล ${escapeHtml(h.model_version)}` : ""}</div>
        </div>
      `
    )
    .join("");
}

async function loadCreditScore() {
  try {
    const { latest, history } = await AgroLinkAPI.get("/farmer/credit-score");
    renderScoreLatest(latest);
    renderScoreHistory(history);
  } catch (err) {
    document.getElementById("scoreLatestPanel").innerHTML = `<div class="empty-state">โหลดคะแนนสินเชื่อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    document.getElementById("scoreHistoryPanel").innerHTML = "";
  }
}

// ---------- แปลง / หน่วยผลิต (registry.production_unit) ----------
const UNIT_TYPE_LABEL_TH = { Plot: "แปลงนา/ไร่นา", Pen: "คอกเลี้ยงสัตว์", Pond: "บ่อเลี้ยง", Orchard: "สวนผลไม้" };
const UNIT_STATUS_LABEL_TH = { active: "ใช้งานอยู่", inactive: "ไม่ได้ใช้งาน", under_review: "อยู่ระหว่างตรวจสอบ" };
// under_review has no dedicated badge color in style.css's status- palette —
// falls back to the plain default badge look, which is fine (neutral, not
// alarming, for a state that isn't success or failure).

function unitCard(u) {
  return `
    <div class="item-card" data-unit-id="${u.unit_id}">
      <div class="row">
        <span class="title">${escapeHtml(UNIT_TYPE_LABEL_TH[u.unit_type] || u.unit_type)} — ${escapeHtml(u.commodity_code || "ไม่ระบุพืช/สัตว์")}</span>
        <span class="badge status-${escapeHtml(u.status)}">${escapeHtml(UNIT_STATUS_LABEL_TH[u.status] || u.status)}</span>
      </div>
      <div class="detail-line">พื้นที่ ${Number(u.area_rai || 0).toLocaleString("th-TH")} ไร่</div>
      <div class="detail-line muted">ขึ้นทะเบียนเมื่อ ${thaiDate(u.registration_date)}</div>
    </div>
  `;
}

let farmerUnits = [];

function populateLoanUnitSelect() {
  const select = document.getElementById("loanUnit");
  if (farmerUnits.length === 0) {
    select.innerHTML = `<option value="">-- ยังไม่มีแปลง/หน่วยผลิตที่ลงทะเบียนไว้ --</option>`;
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML =
    `<option value="">-- เลือกแปลง/หน่วยผลิต --</option>` +
    farmerUnits
      .map(
        (u) =>
          `<option value="${u.unit_id}">${escapeHtml(UNIT_TYPE_LABEL_TH[u.unit_type] || u.unit_type)} — ${escapeHtml(u.commodity_code || "ไม่ระบุพืช/สัตว์")} (${Number(u.area_rai || 0).toLocaleString("th-TH")} ไร่)</option>`
      )
      .join("");
}

async function loadUnits() {
  const el = document.getElementById("unitsSection");
  try {
    farmerUnits = await AgroLinkAPI.get("/farmer/production-units");
    unitLabelById = Object.fromEntries(
      farmerUnits.map((u) => [u.unit_id, `${UNIT_TYPE_LABEL_TH[u.unit_type] || u.unit_type} — ${u.commodity_code || "ไม่ระบุพืช/สัตว์"}`])
    );
    if (farmerUnits.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีแปลง/หน่วยผลิตที่ลงทะเบียนไว้</div>`;
    } else {
      el.innerHTML = farmerUnits.map(unitCard).join("");
    }
    populateLoanUnitSelect();
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดข้อมูลแปลง/หน่วยผลิตไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- สัญญา (contract.contract) ----------
const CONTRACT_STATUS_LABEL_TH = {
  draft: "ร่าง", pending_signature: "รอลงนาม", active: "ดำเนินอยู่",
  completed: "เสร็จสิ้น", terminated: "ยกเลิก", breached: "ผิดสัญญา",
};

function contractCard(c) {
  const money = c.principal_amount !== null && c.principal_amount !== undefined
    ? `เงินต้น ${thb(c.principal_amount)} ${escapeHtml(c.currency || "THB")}`
    : c.agreed_quantity !== null && c.agreed_quantity !== undefined
    ? `ปริมาณ ${Number(c.agreed_quantity).toLocaleString("th-TH")} ${escapeHtml(c.quantity_unit || "")} @ ${thb(c.agreed_unit_price)} ${escapeHtml(c.currency || "THB")}`
    : "";
  return `
    <div class="item-card" data-contract-id="${c.contract_id}">
      <div class="row">
        <span class="title">สัญญา ${escapeHtml(c.contract_type || "-")}</span>
        <span class="badge status-${escapeHtml(c.status)}">${escapeHtml(CONTRACT_STATUS_LABEL_TH[c.status] || c.status)}</span>
      </div>
      ${money ? `<div class="detail-line">${money}</div>` : ""}
      <div class="detail-line muted">มีผล ${thaiDate(c.effective_date)} ถึง ${thaiDate(c.expiry_date)}</div>
      ${c.terms_summary ? `<div class="detail-line muted">${escapeHtml(c.terms_summary)}</div>` : ""}
      <div class="detail-line muted">สร้างเมื่อ ${thaiDate(c.created_at)}</div>
    </div>
  `;
}

async function loadContracts() {
  const el = document.getElementById("contractsSection");
  try {
    const contracts = await AgroLinkAPI.get("/farmer/contracts");
    if (contracts.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีสัญญา</div>`;
      return;
    }
    el.innerHTML = contracts.map(contractCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดสัญญาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- คำขอสินเชื่อ (underwriting.loan_application) ----------
const APPLICATION_STATUS_LABEL_TH = {
  pending: "รอการประเมินอัตโนมัติ",
  manual_review: "รอตรวจสอบโดยผู้ปล่อยกู้",
  approved: "อนุมัติเบื้องต้นแล้ว (รอแปลงเป็นสัญญา)",
  declined: "ปฏิเสธแล้ว",
  converted: "แปลงเป็นสัญญาแล้ว",
};

function applicationCard(a) {
  const lenderName = lenderNameById[a.lender_org_id] || a.lender_org_id;
  const unitLabel = unitLabelById[a.related_unit_id] || a.related_unit_id;
  return `
    <div class="item-card" data-application-id="${a.application_id}">
      <div class="row">
        <span class="title">${escapeHtml(lenderName)} — ${escapeHtml(a.purpose || "ไม่ระบุวัตถุประสงค์")}</span>
        <span class="badge status-${escapeHtml(a.status)}">${escapeHtml(APPLICATION_STATUS_LABEL_TH[a.status] || a.status)}</span>
      </div>
      <div class="detail-line">ขอสินเชื่อ ${thb(a.requested_amount)} บาท${a.approved_amount ? ` · อนุมัติจริง ${thb(a.approved_amount)} บาท` : ""}</div>
      <div class="detail-line muted">สำหรับ: ${escapeHtml(unitLabel)}</div>
      ${a.risk_tier_at_decision ? `<div class="detail-line">ระดับความเสี่ยง ณ วันตัดสินใจ: <span class="badge tier-${escapeHtml(a.risk_tier_at_decision)}">${escapeHtml(a.risk_tier_at_decision)}</span></div>` : ""}
      ${a.decision_reason ? `<div class="detail-line muted">เหตุผล: ${escapeHtml(a.decision_reason)}</div>` : ""}
      ${a.contract_id ? `<div class="detail-line muted">แปลงเป็นสัญญาแล้ว (ดูรายละเอียดในส่วน "สัญญา" ด้านบน)</div>` : ""}
      <div class="detail-line muted">ยื่นคำขอเมื่อ ${thaiDate(a.created_at)}${a.decided_at ? " · ตัดสินใจเมื่อ " + thaiDate(a.decided_at) : ""}</div>
    </div>
  `;
}

async function loadLoanApplications() {
  const el = document.getElementById("loansSection");
  try {
    const apps = await AgroLinkAPI.get("/farmer/loan-applications");
    if (apps.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีคำขอสินเชื่อ</div>`;
      return;
    }
    el.innerHTML = apps.map(applicationCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำขอสินเชื่อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadLenders() {
  const select = document.getElementById("loanLender");
  try {
    const lenders = await AgroLinkAPI.get("/farmer/lenders");
    lenderNameById = Object.fromEntries(lenders.map((l) => [l.org_id, l.org_name]));
    if (lenders.length === 0) {
      select.innerHTML = `<option value="">-- ยังไม่มีผู้ให้สินเชื่อในระบบ --</option>`;
      select.disabled = true;
      return;
    }
    select.disabled = false;
    select.innerHTML =
      `<option value="">-- เลือกผู้ให้สินเชื่อ --</option>` +
      lenders.map((l) => `<option value="${l.org_id}">${escapeHtml(l.org_name)}</option>`).join("");
  } catch (err) {
    select.innerHTML = `<option value="">-- โหลดรายชื่อผู้ให้สินเชื่อไม่สำเร็จ --</option>`;
    select.disabled = true;
  }
}

const loanForm = document.getElementById("loanForm");
const loanUnitSelect = document.getElementById("loanUnit");
const loanLenderSelect = document.getElementById("loanLender");
const loanAmountInput = document.getElementById("loanAmount");
const loanPurposeInput = document.getElementById("loanPurpose");
const loanSubmitBtn = document.getElementById("loanSubmitBtn");

const LOAN_SUBMIT_ERROR_TH = {
  missing_required_fields: "กรุณาเลือกแปลง/หน่วยผลิต ผู้ให้สินเชื่อ และระบุวงเงินที่ขอ",
};

loanForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const relatedUnitId = loanUnitSelect.value;
  const lenderOrgId = loanLenderSelect.value;
  const requestedAmount = Number(loanAmountInput.value);
  const purpose = loanPurposeInput.value.trim();

  if (!relatedUnitId || !lenderOrgId || !requestedAmount || requestedAmount <= 0) {
    toast("กรุณาเลือกแปลง/หน่วยผลิต ผู้ให้สินเชื่อ และระบุวงเงินที่ขอให้ครบถ้วน", true);
    return;
  }

  loanSubmitBtn.disabled = true;
  try {
    const decision = await AgroLinkAPI.post("/farmer/loan-applications", {
      lender_org_id: lenderOrgId,
      related_unit_id: relatedUnitId,
      requested_amount: requestedAmount,
      purpose: purpose || undefined,
    });
    const statusLabel = APPLICATION_STATUS_LABEL_TH[decision.status] || decision.status;
    toast(`ส่งคำขอสินเชื่อเรียบร้อยแล้ว — สถานะ: ${statusLabel}`);
    loanForm.reset();
    await Promise.all([loadLoanApplications(), refreshSummary()]);
  } catch (err) {
    toast(LOAN_SUBMIT_ERROR_TH[err.message] || "ส่งคำขอสินเชื่อไม่สำเร็จ: " + err.message, true);
  } finally {
    loanSubmitBtn.disabled = false;
  }
});

// ---------- การแจ้งเตือนที่ยังไม่อ่าน (notification.v_unread_notifications) ----------
const SEVERITY_LABEL_TH = { critical: "วิกฤต", warning: "คำเตือน", info: "แจ้งเพื่อทราบ" };

function notificationCard(n) {
  return `
    <div class="item-card">
      <div class="row">
        <span class="title">${escapeHtml(n.event_type)}</span>
        <span class="badge sev-${escapeHtml(n.severity || "info")}">${escapeHtml(SEVERITY_LABEL_TH[n.severity] || n.severity || "-")}</span>
      </div>
      <div class="detail-line">${escapeHtml(n.message)}</div>
      <div class="detail-line muted">${thaiDate(n.created_at)}</div>
    </div>
  `;
}

async function loadNotifications() {
  const el = document.getElementById("notificationsSection");
  try {
    const notifications = await AgroLinkAPI.get("/farmer/notifications");
    if (notifications.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีการแจ้งเตือนที่ยังไม่อ่าน</div>`;
      return;
    }
    el.innerHTML = notifications.map(notificationCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดการแจ้งเตือนไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkAPI.logout());

/**
 * GET /farmer/dashboard doubles as the session/existence gate check here —
 * same init() pattern as every other portal, though a farmer session never
 * has a KYB/role-pending state the way an organization session does (a
 * farmer's own account is either there or it isn't).
 */
async function init() {
  const session = AgroLinkAPI.requireSessionOrRedirect();
  if (!session) return;

  try {
    const d = await AgroLinkAPI.get("/farmer/dashboard");
    renderSummary(d);
  } catch (err) {
    document.getElementById("summarySection").innerHTML = `<div class="empty-state">โหลดข้อมูลภาพรวมไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    return;
  }

  loadCreditScore();
  loadContracts();
  loadNotifications();

  // Units and lenders both feed the loan-application form's dropdowns AND
  // the name lookups applicationCard() needs, so load them before the
  // applications list to avoid a flash of raw UUIDs.
  await Promise.all([loadUnits(), loadLenders()]);
  loadLoanApplications();
}

init();
