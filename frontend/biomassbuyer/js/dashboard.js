// ============================================================
// การนำทางแบบแถบข้าง (Sidebar) — UI-only, เหมือนกับ buyer/js/dashboard.js
// และ admin/js/dashboard.js ทุกประการ: ทุก section เดิมยังคงถูกโหลดข้อมูล
// ตามปกติตอนเปิดหน้า ปุ่มด้านข้างแค่ show/hide ว่าจะให้ page ไหนแสดงอยู่
// บนจอเท่านั้น
// ============================================================
const BBUYER_PAGE_BREADCRUMB_TH = {
  overview: "ภาพรวม",
  registration: "ข้อมูลลงทะเบียนสมาชิก",
  "biomass-types": "ชนิดชีวมวลที่ใช้",
};

function showBbuyerPage(pageKey) {
  document.querySelectorAll("[data-page-content]").forEach((el) => {
    el.style.display = el.dataset.pageContent === pageKey ? "" : "none";
  });
  document.querySelectorAll("[data-page]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === pageKey);
  });
  const crumb = document.getElementById("bbuyerBreadcrumbCurrent");
  if (crumb) crumb.innerHTML = BBUYER_PAGE_BREADCRUMB_TH[pageKey] || pageKey;
  const mainEl = document.querySelector(".bbuyer-main");
  if (mainEl) mainEl.scrollTop = 0;
  window.scrollTo(0, 0);
}

document.querySelectorAll("[data-page]").forEach((btn) => {
  btn.addEventListener("click", () => showBbuyerPage(btn.dataset.page));
});

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

/**
 * Replaces the whole dashboard body with a "your KYB application is under
 * review" notice — same shape as every other portal's own copy (see
 * biomassproducer/js/dashboard.js's showKybPendingNotice doc comment).
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
        เมื่อได้รับการอนุมัติแล้ว ท่านจะสามารถลงทะเบียนสมาชิกผู้รับซื้อชีวมวลได้เต็มรูปแบบ —
        ลองเข้าสู่ระบบใหม่อีกครั้งในภายหลัง หรือรีเฟรชหน้านี้
      </div>
    </div>
  `;
}

/**
 * Same shape as showRolePendingNotice in biomassproducer/js/dashboard.js
 * (and every other multi-role portal).
 */
function showRolePendingNotice(orgName, roleStatus) {
  document.getElementById("orgName").textContent = orgName || "-";
  const body = !roleStatus
    ? {
        title: "องค์กรของท่านยังไม่มีบทบาทผู้รับซื้อชีวมวล",
        detail: "หากต้องการเปิดใช้งานพอร์ทัลนี้ ท่านสามารถส่งคำขอเพิ่มบทบาท \"ผู้รับซื้อชีวมวล\" ได้จากหน้า \"จัดการบทบาทธุรกิจ\"",
      }
    : roleStatus === "Rejected"
    ? { title: "คำขอบทบาทผู้รับซื้อชีวมวลของท่านถูกปฏิเสธ", detail: "กรุณาติดต่อเจ้าหน้าที่ผู้ดูแลระบบสำหรับข้อมูลเพิ่มเติม" }
    : { title: "คำขอบทบาทผู้รับซื้อชีวมวลของท่านอยู่ระหว่างการตรวจสอบ", detail: "เจ้าหน้าที่ผู้ดูแลระบบ (Platform Ops) กำลังตรวจสอบคำขอนี้ — ลองรีเฟรชหน้านี้อีกครั้งภายหลัง" };

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
  const selectedCount = (d.biomass_types || []).filter((t) => t.selected).length;
  document.getElementById("summarySection").innerHTML = `
    <div class="stat-card"><div class="label">สถานะการลงทะเบียน</div><div class="value" style="font-size:16px;">${d.registration_complete ? "✅ ลงทะเบียนแล้ว" : "⛔ ยังไม่ได้กรอกข้อมูลบริษัท"}</div></div>
    <div class="stat-card"><div class="label">ชนิดชีวมวลที่เลือก</div><div class="value">${selectedCount} / ${(d.biomass_types || []).length}</div></div>
    <div class="stat-card"><div class="label">ชื่อบริษัท</div><div class="value" style="font-size:14px;">${escapeHtml((d.profile && d.profile.company_name) || "ยังไม่ได้ระบุ")}</div></div>
  `;
}

// ---------- ข้อมูลลงทะเบียนสมาชิก ----------
function fillRegistrationForm(profile) {
  const p = profile || {};
  document.getElementById("companyNameInput").value = p.company_name || "";
  document.getElementById("addressDetailInput").value = p.address_detail || "";
  document.getElementById("monthlyUsageInput").value = p.monthly_usage_note || "";
  document.getElementById("usagePurposeInput").value = p.usage_purpose || "";
  document.getElementById("desiredSpecInput").value = p.desired_spec || "";
  document.getElementById("contactPhoneInput").value = p.contact_phone || "";
}

// ---------- ชนิดชีวมวลที่ใช้ ----------
function biomassTypeGridHtml(biomassTypes) {
  return biomassTypes.map((t) => `
    <label class="biomass-type-check${t.selected ? " checked" : ""}" data-biomass-type-check>
      <input type="checkbox" value="${escapeHtml(t.biomass_type)}" ${t.selected ? "checked" : ""} />
      ${escapeHtml(t.label_th)}
    </label>
  `).join("");
}

function wireBiomassTypeCheckboxStyling() {
  document.querySelectorAll("#biomassTypeGrid [data-biomass-type-check]").forEach((label) => {
    const input = label.querySelector("input");
    input.addEventListener("change", () => {
      label.classList.toggle("checked", input.checked);
    });
  });
}

async function loadDashboard() {
  const d = await AgroLinkBiomassBuyerAPI.get("/biomassbuyer/dashboard");
  renderSummary(d);
  fillRegistrationForm(d.profile);

  document.getElementById("biomassTypeGrid").innerHTML = biomassTypeGridHtml(d.biomass_types || []);
  wireBiomassTypeCheckboxStyling();

  return d;
}

document.getElementById("profileSaveBtn").addEventListener("click", async () => {
  const companyName = document.getElementById("companyNameInput").value.trim();
  if (!companyName) {
    toast("กรุณากรอกชื่อบริษัท", true);
    document.getElementById("companyNameInput").focus();
    return;
  }
  const btn = document.getElementById("profileSaveBtn");
  btn.disabled = true;
  try {
    await AgroLinkBiomassBuyerAPI.put("/biomassbuyer/profile", {
      company_name: companyName,
      address_detail: document.getElementById("addressDetailInput").value.trim() || null,
      monthly_usage_note: document.getElementById("monthlyUsageInput").value.trim() || null,
      usage_purpose: document.getElementById("usagePurposeInput").value.trim() || null,
      desired_spec: document.getElementById("desiredSpecInput").value.trim() || null,
      contact_phone: document.getElementById("contactPhoneInput").value.trim() || null,
    });
    toast("บันทึกข้อมูลลงทะเบียนเรียบร้อยแล้ว");
    refreshSummary();
  } catch (err) {
    toast("บันทึกไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("biomassTypeSaveBtn").addEventListener("click", async () => {
  const checked = Array.from(
    document.querySelectorAll('#biomassTypeGrid input[type="checkbox"]:checked'),
  ).map((cb) => cb.value);
  const btn = document.getElementById("biomassTypeSaveBtn");
  btn.disabled = true;
  try {
    const result = await AgroLinkBiomassBuyerAPI.put("/biomassbuyer/biomass-types", { biomass_types: checked });
    document.getElementById("biomassTypeGrid").innerHTML = biomassTypeGridHtml(result.biomass_types || []);
    wireBiomassTypeCheckboxStyling();
    toast("บันทึกชนิดชีวมวลเรียบร้อยแล้ว");
    refreshSummary();
  } catch (err) {
    toast("บันทึกไม่สำเร็จ: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

async function refreshSummary() {
  try {
    const d = await AgroLinkBiomassBuyerAPI.get("/biomassbuyer/dashboard");
    renderSummary(d);
  } catch (err) {
    // Non-fatal — the dashboard already rendered once; a transient
    // refresh failure shouldn't disrupt the page.
  }
}

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkBiomassBuyerAPI.logout());

/**
 * GET /biomassbuyer/dashboard doubles as the KYB/role gate check here —
 * same pattern as every other portal's own init().
 */
async function init() {
  const session = AgroLinkBiomassBuyerAPI.requireSessionOrRedirect();
  if (!session) return;

  try {
    await loadDashboard();
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
  }
}

init();
