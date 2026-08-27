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
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function thb(n) {
  return Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2 });
}

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
      <div class="detail-line muted">ยื่นเมื่อ ${thaiDate(a.submitted_at)}${a.decided_at ? ` · ตัดสินใจเมื่อ ${thaiDate(a.decided_at)}` : ""}</div>
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
      <div class="detail-line muted">เพิ่มเมื่อ ${thaiDate(s.created_at)}</div>
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

// ---------- เริ่มต้น ----------
document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkAdminAPI.logout());

async function init() {
  await loadApplications();
  await loadFundingSources();
}

init();
