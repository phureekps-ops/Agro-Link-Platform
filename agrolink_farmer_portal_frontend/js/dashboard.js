const session = AgroLinkAPI.requireSessionOrRedirect();

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
  pending: "รอพิจารณา", approved: "อนุมัติแล้ว", manual_review: "รอตรวจสอบเพิ่มเติม",
  declined: "ปฏิเสธ", converted: "แปลงเป็นสัญญาแล้ว",
  draft: "ร่าง", pending_signature: "รอลงนาม", active: "ใช้งานอยู่",
  completed: "เสร็จสิ้น", terminated: "ยกเลิก", breached: "ผิดสัญญา",
};
const TIER_LABEL = { A: "ความเสี่ยงต่ำ (A)", B: "ความเสี่ยงปานกลาง-ต่ำ (B)", C: "ความเสี่ยงปานกลาง-สูง (C)", D: "ความเสี่ยงสูง (D)" };
const SEVERITY_LABEL = { critical: "วิกฤต", warning: "เตือน", info: "แจ้งเพื่อทราบ" };
const CONTRACT_TYPE_LABEL = {
  loan_agreement: "สัญญาสินเชื่อ", forward_purchase: "สัญญาซื้อขายล่วงหน้า",
  service_agreement: "สัญญาบริการ", input_supply_agreement: "สัญญาจัดหาปัจจัยการผลิต",
};
const UNIT_TYPE_LABEL = { Plot: "แปลงนา/ไร่", Pen: "คอกปศุสัตว์", Pond: "บ่อเลี้ยง", Orchard: "สวนผลไม้" };

function statusBadge(status) {
  return `<span class="badge status-${escapeHtml(status)}">${escapeHtml(STATUS_LABEL[status] || status)}</span>`;
}

// ---------- ภาพรวมบัญชี ----------
async function loadSummary() {
  const el = document.getElementById("summarySection");
  try {
    const d = await AgroLinkAPI.get("/farmer/dashboard");
    document.getElementById("farmerName").textContent = d.full_name || "-";
    const tierBadge = d.latest_risk_tier ? `<span class="badge tier-${d.latest_risk_tier}">${escapeHtml(TIER_LABEL[d.latest_risk_tier] || d.latest_risk_tier)}</span>` : "-";
    el.innerHTML = `
      <div class="stat-card"><div class="label">จำนวนแปลง/หน่วยผลิต</div><div class="value">${d.production_units_count}</div></div>
      <div class="stat-card"><div class="label">สัญญาทั้งหมด</div><div class="value">${d.contracts_total}</div><div class="sub">เสร็จสิ้นแล้ว ${d.contracts_completed} สัญญา</div></div>
      <div class="stat-card"><div class="label">คะแนนสินเชื่อล่าสุด</div><div class="value">${d.latest_credit_score ?? "-"}</div><div class="sub">${tierBadge}</div></div>
      <div class="stat-card"><div class="label">ยอดชำระคืนสินเชื่อสะสม</div><div class="value" style="font-size:18px;">${thb(d.total_loan_repaid)}</div></div>
      <div class="stat-card"><div class="label">ใบรับรองที่ได้รับ</div><div class="value">${d.certificates_count}</div></div>
      <div class="stat-card"><div class="label">การส่งมอบที่ตัดยอดแล้ว</div><div class="value">${d.deliveries_settled_count}</div></div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดข้อมูลภาพรวมไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- คะแนนสินเชื่อ ----------
function factorLabel(key) {
  const map = {
    loan_repayment: "การชำระคืนสินเชื่อ",
    delivery_quality: "คุณภาพการส่งมอบผลผลิต",
    contract_fulfillment: "การปฏิบัติตามสัญญา",
    production_reliability: "ความสม่ำเสมอในการผลิต",
  };
  return map[key] || key;
}

async function loadCreditScore() {
  const latestEl = document.getElementById("scoreLatestPanel");
  const historyEl = document.getElementById("scoreHistoryPanel");
  try {
    const d = await AgroLinkAPI.get("/farmer/credit-score");
    if (!d.latest) {
      latestEl.innerHTML = `<div class="empty-state">ยังไม่มีการประเมินคะแนนสินเชื่อ</div>`;
    } else {
      const l = d.latest;
      const factors = l.factors && typeof l.factors === "object" ? l.factors : {};
      let factorsHtml = "";
      for (const [key, val] of Object.entries(factors)) {
        if (!val || typeof val !== "object" || val.factor_score === undefined) continue;
        // factor_score is legitimately null when there's not enough underlying
        // data yet (e.g. no deliveries settled) — show that plainly instead of
        // rendering the literal string "null".
        const hasScore = val.factor_score !== null;
        const scoreLabel = hasScore ? `${val.factor_score}/100` : "ไม่มีข้อมูลเพียงพอ";
        const barWidth = hasScore ? Math.max(0, Math.min(100, val.factor_score)) : 0;
        factorsHtml += `
          <div class="factor-row">
            <div class="factor-label"><span>${escapeHtml(factorLabel(key))}</span><span>${scoreLabel}</span></div>
            <div class="factor-bar-track"><div class="factor-bar-fill" style="width:${barWidth}%"></div></div>
          </div>`;
      }
      latestEl.innerHTML = `
        <div style="display:flex; align-items:baseline; gap:10px; margin-bottom:14px;">
          <div style="font-size:32px; font-weight:700; color:var(--green-900);">${l.score_value}</div>
          <span class="badge tier-${l.risk_tier}">${escapeHtml(TIER_LABEL[l.risk_tier] || l.risk_tier)}</span>
        </div>
        ${factorsHtml || '<div class="muted">ไม่มีรายละเอียดปัจจัยคะแนน</div>'}
        <div class="muted" style="margin-top:10px;">ประเมินล่าสุดเมื่อ ${thaiDate(l.computed_at)}</div>
      `;
    }

    if (!d.history || d.history.length === 0) {
      historyEl.innerHTML = `<div class="empty-state">ไม่มีประวัติคะแนน</div>`;
    } else {
      historyEl.innerHTML = `<div style="font-weight:700; margin-bottom:10px;">ประวัติคะแนนย้อนหลัง</div>` + d.history.map((h) => `
        <div class="item-card" style="box-shadow:none; border:1px solid var(--gray-100); margin-bottom:8px; padding:12px 14px;">
          <div class="row"><span class="title">${h.score_value} คะแนน</span><span class="badge tier-${h.risk_tier}">${escapeHtml(h.risk_tier)}</span></div>
          <div class="detail-line muted">${thaiDate(h.computed_at)} · โมเดล ${escapeHtml(h.model_version)}</div>
        </div>
      `).join("");
    }
  } catch (err) {
    latestEl.innerHTML = `<div class="empty-state">โหลดคะแนนสินเชื่อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    historyEl.innerHTML = "";
  }
}

// ---------- แปลง/หน่วยผลิต ----------
let productionUnitsCache = [];

async function loadProductionUnits() {
  const el = document.getElementById("unitsSection");
  try {
    const units = await AgroLinkAPI.get("/farmer/production-units");
    productionUnitsCache = units;
    populateLoanUnitSelect(units);
    if (units.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีข้อมูลแปลง/หน่วยผลิต</div>`;
      return;
    }
    el.innerHTML = units.map((u) => `
      <div class="item-card">
        <div class="row"><span class="title">${escapeHtml(UNIT_TYPE_LABEL[u.unit_type] || u.unit_type)}</span><span class="badge status-${escapeHtml(u.status)}">${u.status === "active" ? "ใช้งาน" : escapeHtml(u.status)}</span></div>
        <div class="detail-line">พืช/สินค้า: ${escapeHtml(u.commodity_code)}</div>
        <div class="detail-line">พื้นที่: ${u.area_rai} ไร่ · ฤดูกาล ${escapeHtml(u.season_id)}</div>
        <div class="detail-line muted">ขึ้นทะเบียนเมื่อ ${thaiDate(u.registration_date)}</div>
      </div>
    `).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดข้อมูลแปลงไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- สัญญา ----------
async function loadContracts() {
  const el = document.getElementById("contractsSection");
  try {
    const contracts = await AgroLinkAPI.get("/farmer/contracts");
    if (contracts.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีสัญญา</div>`;
      return;
    }
    el.innerHTML = contracts.map((c) => `
      <div class="item-card">
        <div class="row"><span class="title">${escapeHtml(CONTRACT_TYPE_LABEL[c.contract_type] || c.contract_type)}</span>${statusBadge(c.status)}</div>
        ${c.principal_amount ? `<div class="detail-line">วงเงินต้น: ${thb(c.principal_amount)}</div>` : ""}
        ${c.agreed_quantity ? `<div class="detail-line">ปริมาณตกลง: ${c.agreed_quantity} ${escapeHtml(c.quantity_unit || "")} @ ${thb(c.agreed_unit_price)}</div>` : ""}
        ${c.terms_summary ? `<div class="detail-line muted">${escapeHtml(c.terms_summary)}</div>` : ""}
        <div class="detail-line muted">เริ่ม ${thaiDate(c.effective_date)}${c.expiry_date ? " · สิ้นสุด " + thaiDate(c.expiry_date) : ""}</div>
      </div>
    `).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดสัญญาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- คำขอสินเชื่อ ----------
async function loadLoanApplications() {
  const el = document.getElementById("loansSection");
  try {
    const apps = await AgroLinkAPI.get("/farmer/loan-applications");
    if (apps.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีคำขอสินเชื่อ</div>`;
      return;
    }
    el.innerHTML = apps.map((a) => `
      <div class="item-card">
        <div class="row"><span class="title">${thb(a.requested_amount)}</span>${statusBadge(a.status)}</div>
        ${a.purpose ? `<div class="detail-line">${escapeHtml(a.purpose)}</div>` : ""}
        ${a.decision_reason ? `<div class="detail-line muted">${escapeHtml(a.decision_reason)}</div>` : ""}
        ${a.approved_amount ? `<div class="detail-line">วงเงินอนุมัติ: ${thb(a.approved_amount)}</div>` : ""}
        <div class="detail-line muted">ยื่นเมื่อ ${thaiDate(a.created_at)}</div>
      </div>
    `).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำขอสินเชื่อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

function populateLoanUnitSelect(units) {
  const sel = document.getElementById("loanUnit");
  sel.innerHTML = units.map((u) =>
    `<option value="${u.unit_id}">${escapeHtml(UNIT_TYPE_LABEL[u.unit_type] || u.unit_type)} — ${escapeHtml(u.commodity_code)} (${u.area_rai} ไร่)</option>`
  ).join("") || `<option value="">ไม่มีหน่วยผลิต</option>`;
}

async function loadLenders() {
  const sel = document.getElementById("loanLender");
  try {
    const lenders = await AgroLinkAPI.get("/farmer/lenders");
    sel.innerHTML = lenders.map((l) => `<option value="${l.org_id}">${escapeHtml(l.org_name)}</option>`).join("")
      || `<option value="">ไม่มีผู้ให้สินเชื่อในระบบ</option>`;
  } catch (err) {
    sel.innerHTML = `<option value="">โหลดรายชื่อผู้ให้สินเชื่อไม่สำเร็จ</option>`;
  }
}

document.getElementById("loanForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("loanSubmitBtn");
  const unitId = document.getElementById("loanUnit").value;
  const lenderId = document.getElementById("loanLender").value;
  const amount = document.getElementById("loanAmount").value;
  const purpose = document.getElementById("loanPurpose").value;

  if (!unitId || !lenderId || !amount) {
    toast("กรุณากรอกข้อมูลให้ครบถ้วน", true);
    return;
  }

  btn.disabled = true;
  try {
    await AgroLinkAPI.post("/farmer/loan-applications", {
      lender_org_id: lenderId,
      related_unit_id: unitId,
      requested_amount: Number(amount),
      purpose: purpose || undefined,
    });
    toast("ส่งคำขอสินเชื่อเรียบร้อยแล้ว");
    document.getElementById("loanForm").reset();
    await loadLoanApplications();
  } catch (err) {
    toast("ส่งคำขอไม่สำเร็จ: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- การแจ้งเตือน ----------
async function loadNotifications() {
  const el = document.getElementById("notificationsSection");
  try {
    const items = await AgroLinkAPI.get("/farmer/notifications");
    if (items.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีการแจ้งเตือนที่ยังไม่อ่าน</div>`;
      return;
    }
    el.innerHTML = items.map((n) => `
      <div class="item-card">
        <div class="row"><span class="badge sev-${escapeHtml(n.severity)}">${escapeHtml(SEVERITY_LABEL[n.severity] || n.severity)}</span><span class="muted">${thaiDate(n.created_at)}</span></div>
        <div class="detail-line">${escapeHtml(n.message)}</div>
      </div>
    `).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดการแจ้งเตือนไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkAPI.logout());

// Kick off all sections concurrently — independent panels, no reason to
// serialize the loading.
loadSummary();
loadCreditScore();
loadProductionUnits().then(loadLenders);
loadContracts();
loadLoanApplications();
loadNotifications();
