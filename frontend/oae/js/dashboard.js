// ============================================================
// Sidebar navigation — same "UI-only show/hide" pattern as
// frontend/communityenterprise/js/dashboard.js's showHubPage().
// ============================================================
const HUB_PAGE_BREADCRUMB_TH = {
  overview: "ภาพรวม",
  catalog: "บัญชีข้อมูล (Data Catalog)",
  prices: "ราคาสินค้าโภคภัณฑ์",
  "usage-log": "บันทึกการเข้าถึงข้อมูล",
};

function showHubPage(pageKey) {
  document.querySelectorAll("[data-page-content]").forEach((el) => {
    el.style.display = el.dataset.pageContent === pageKey ? "" : "none";
  });
  document.querySelectorAll("[data-page]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === pageKey);
  });
  const crumb = document.getElementById("hubBreadcrumbCurrent");
  if (crumb) crumb.textContent = HUB_PAGE_BREADCRUMB_TH[pageKey] || pageKey;
  window.scrollTo(0, 0);
}

document.querySelectorAll("[data-page]").forEach((btn) => {
  btn.addEventListener("click", () => showHubPage(btn.dataset.page));
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

function thaiDate(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

function thaiDateTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Same "account inactive / not an OAE officer" notice shape as every
 * other portal's own version of this (see gov/js/dashboard.js's
 * showInactiveNotice) — happens if Platform Ops deactivates this officer's
 * account, or if a non-OAE government officer's token somehow reaches
 * this page.
 */
function showInactiveNotice() {
  document.querySelector(".hub-shell").innerHTML = `
    <div class="empty-state" style="padding:60px 24px; width:100%;">
      <div style="font-size:40px; margin-bottom:14px;">⏳</div>
      <div style="font-size:17px; font-weight:700; color:var(--green-900); margin-bottom:8px;">
        บัญชีของท่านถูกปิดใช้งาน หรือไม่ใช่บัญชีเจ้าหน้าที่ สศก.
      </div>
      <div style="font-size:14px;">กรุณาติดต่อผู้ดูแลระบบ (Platform Ops)</div>
    </div>
  `;
}

// ---------- ข้อมูลของท่าน ----------
async function loadProfile() {
  try {
    const d = await AgroLinkOaeAPI.get("/oae/me");
    document.getElementById("officerName").textContent = d.officer.full_name || "-";
    const rolesHtml = d.roles.map((r) => escapeHtml(r.description)).join(", ") || "-";
    document.getElementById("profileSection").innerHTML = `
      <div class="stat-card"><div class="label">ชื่อ-นามสกุล</div><div class="value" style="font-size:16px;">${escapeHtml(d.officer.full_name)}</div></div>
      <div class="stat-card"><div class="label">หน่วยงาน</div><div class="value" style="font-size:15px;">สำนักงานเศรษฐกิจการเกษตร (สศก.)</div></div>
      <div class="stat-card"><div class="label">บทบาท</div><div class="value" style="font-size:14px;">${rolesHtml}</div></div>
    `;
    return true;
  } catch (err) {
    if (err.message === "oae_officer_not_found_or_inactive") {
      showInactiveNotice();
      return false;
    }
    document.getElementById("profileSection").innerHTML = `<div class="empty-state">โหลดข้อมูลเจ้าหน้าที่ไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    return false;
  }
}

// ---------- รายการข้อมูลและการแบ่งปัน ----------
let datasetCache = [];

function datasetCard(d) {
  return `
    <div class="item-card" data-dataset-id="${d.dataset_id}">
      <div class="row"><span class="title">${escapeHtml(d.dataset_name_th)}</span></div>
      ${d.description ? `<div class="detail-line muted">${escapeHtml(d.description)}</div>` : ""}
      <div class="detail-line muted">ความถี่ในการอัปเดต: ${escapeHtml(d.update_frequency_th || "-")} · บันทึกราคาแล้ว ${Number(d.price_entry_count || 0).toLocaleString("th-TH")} รายการ</div>
      <div class="action-row" style="flex-wrap:wrap; gap:14px;">
        <label style="display:flex; align-items:center; gap:6px; font-size:13.5px; cursor:pointer;">
          <input type="checkbox" data-toggle-sharing="${d.dataset_id}" data-audience="cooperative" ${d.shared_with_cooperatives ? "checked" : ""} />
          แบ่งปันให้พอร์ทัลสหกรณ์
        </label>
        <label style="display:flex; align-items:center; gap:6px; font-size:13.5px; cursor:pointer;">
          <input type="checkbox" data-toggle-sharing="${d.dataset_id}" data-audience="farmer" ${d.shared_with_farmers ? "checked" : ""} />
          แบ่งปันให้พอร์ทัลเกษตรกร
        </label>
      </div>
    </div>
  `;
}

function populatePriceDatasetSelect() {
  const select = document.getElementById("priceDatasetSelect");
  select.innerHTML = `<option value="">-- เลือกหมวดหมู่ --</option>` +
    datasetCache.map((d) => `<option value="${d.dataset_id}">${escapeHtml(d.dataset_name_th)}</option>`).join("");
}

async function loadDatasets() {
  const el = document.getElementById("datasetsSection");
  try {
    const d = await AgroLinkOaeAPI.get("/oae/datasets");
    datasetCache = d.datasets;
    el.innerHTML = datasetCache.length === 0
      ? `<div class="empty-state">ยังไม่มีหมวดหมู่ข้อมูลในระบบ</div>`
      : datasetCache.map(datasetCard).join("");
    populatePriceDatasetSelect();
    renderOverviewStats();
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการข้อมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("datasetsSection").addEventListener("change", async (e) => {
  const checkbox = e.target.closest("[data-toggle-sharing]");
  if (!checkbox) return;
  const datasetId = checkbox.dataset.toggleSharing;
  const audience = checkbox.dataset.audience;
  const isEnabled = checkbox.checked;
  checkbox.disabled = true;
  try {
    await AgroLinkOaeAPI.post(`/oae/datasets/${datasetId}/sharing`, { audience, is_enabled: isEnabled });
    const audienceLabel = audience === "cooperative" ? "พอร์ทัลสหกรณ์" : "พอร์ทัลเกษตรกร";
    toast(isEnabled ? `เปิดแบ่งปันให้${audienceLabel}แล้ว` : `ปิดแบ่งปันให้${audienceLabel}แล้ว`);
    // Keep the local cache (and therefore the overview KPI tiles) in sync
    // with the toggle the officer just flipped, without a full re-fetch.
    const ds = datasetCache.find((x) => String(x.dataset_id) === String(datasetId));
    if (ds) {
      if (audience === "cooperative") ds.shared_with_cooperatives = isEnabled;
      else ds.shared_with_farmers = isEnabled;
      renderOverviewStats();
    }
  } catch (err) {
    checkbox.checked = !isEnabled;
    toast("เปลี่ยนสถานะการแบ่งปันไม่สำเร็จ: " + ((err.body && err.body.detail) || err.message), true);
  } finally {
    checkbox.disabled = false;
  }
});

// ---------- บันทึกราคาสินค้าเกษตร ----------
function priceCard(p) {
  return `
    <div class="item-card">
      <div class="row"><span class="title">${escapeHtml(p.commodity_name_th)}</span></div>
      <div class="detail-line muted">${escapeHtml(p.dataset_name_th)}</div>
      <div class="detail-line">${Number(p.price_value).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(p.unit)} — ณ วันที่ ${thaiDate(p.price_date)}</div>
      ${p.source_note ? `<div class="detail-line muted">ที่มา: ${escapeHtml(p.source_note)}</div>` : ""}
      <div class="detail-line muted">บันทึกโดย ${escapeHtml(p.recorded_by)} เมื่อ ${thaiDateTime(p.created_at)}</div>
    </div>
  `;
}

async function loadPrices() {
  const el = document.getElementById("pricesSection");
  try {
    const d = await AgroLinkOaeAPI.get("/oae/commodity-prices");
    el.innerHTML = d.prices.length === 0
      ? `<div class="empty-state">ยังไม่มีราคาที่บันทึกไว้ — ใช้ฟอร์มด้านบนเพื่อบันทึกรายการแรก</div>`
      : d.prices.map(priceCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการราคาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("priceSubmitBtn").addEventListener("click", async () => {
  const datasetId = document.getElementById("priceDatasetSelect").value;
  const commodityNameTh = document.getElementById("priceCommodityInput").value.trim();
  const priceDate = document.getElementById("priceDateInput").value;
  const priceValue = Number(document.getElementById("priceValueInput").value);
  const unit = document.getElementById("priceUnitInput").value.trim();
  const sourceNote = document.getElementById("priceSourceNoteInput").value.trim();
  const recordedBy = document.getElementById("priceRecordedByInput").value.trim();

  if (!datasetId || !commodityNameTh || !priceDate || !unit || !recordedBy || priceValue < 0 || Number.isNaN(priceValue)) {
    toast("กรุณากรอกข้อมูลให้ครบทุกช่องที่จำเป็น", true);
    return;
  }

  const btn = document.getElementById("priceSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkOaeAPI.post("/oae/commodity-prices", {
      dataset_id: datasetId,
      commodity_name_th: commodityNameTh,
      price_date: priceDate,
      price_value: priceValue,
      unit,
      source_note: sourceNote || undefined,
      recorded_by: recordedBy,
    });
    toast("บันทึกราคาเรียบร้อยแล้ว");
    document.getElementById("priceForm").reset();
    await Promise.all([loadPrices(), loadDatasets()]);
  } catch (err) {
    toast("บันทึกราคาไม่สำเร็จ: " + ((err.body && err.body.detail) || err.message), true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- ประวัติการใช้ข้อมูล ----------
const USAGE_VIEWER_LABEL_TH = { organization: "สหกรณ์", farmer: "เกษตรกร" };
let usageCache = [];

function usageCard(u) {
  return `
    <div class="item-card">
      <div class="row">
        <span class="title">${escapeHtml(u.dataset_name_th)}</span>
        <span class="badge">${escapeHtml(USAGE_VIEWER_LABEL_TH[u.viewer_subject_type] || u.viewer_subject_type)}</span>
      </div>
      <div class="detail-line">${escapeHtml(u.viewer_name || "-")}</div>
      <div class="detail-line muted">เข้าดูเมื่อ ${thaiDateTime(u.viewed_at)}</div>
    </div>
  `;
}

async function loadUsageLog() {
  const el = document.getElementById("usageLogSection");
  try {
    const d = await AgroLinkOaeAPI.get("/oae/usage-log");
    usageCache = d.usage;
    el.innerHTML = usageCache.length === 0
      ? `<div class="empty-state">ยังไม่มีการเข้าดูข้อมูลที่แบ่งปัน</div>`
      : usageCache.map(usageCard).join("");
    renderOverviewStats();
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประวัติการใช้ข้อมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- ภาพรวม (Overview KPI tiles) ----------
// Every number here is derived from datasetCache/usageCache — the same
// data already fetched for the Data Catalog and Usage Log pages — never a
// fabricated figure. GET /oae/usage-log caps at 200 rows (see oae.js), so
// anything built from usageCache is explicitly labelled as coming from
// "the latest 200 log entries," not a true all-time total.
function renderOverviewStats() {
  const el = document.getElementById("overviewStatsSection");
  if (!el) return;
  // Wait until both the dataset catalog and the usage log have loaded at
  // least once, so the tiles never flash a false "0" before data arrives.
  if (!loadDatasets.hasLoadedOnce || !loadUsageLog.hasLoadedOnce) return;

  const totalDatasets = datasetCache.length;
  const sharedDatasets = datasetCache.filter((d) => d.shared_with_cooperatives || d.shared_with_farmers).length;
  const totalPriceEntries = datasetCache.reduce((sum, d) => sum + Number(d.price_entry_count || 0), 0);
  const uniqueViewers = new Set(usageCache.map((u) => `${u.viewer_subject_type}:${u.viewer_name}`)).size;

  el.innerHTML = `
    <div class="stat-card">
      <div class="label">ชุดข้อมูลทั้งหมด</div>
      <div class="value">${totalDatasets.toLocaleString("th-TH")} ชุด</div>
    </div>
    <div class="stat-card">
      <div class="label">ชุดข้อมูลที่เปิดแบ่งปันอยู่</div>
      <div class="value">${sharedDatasets.toLocaleString("th-TH")} / ${totalDatasets.toLocaleString("th-TH")} ชุด</div>
    </div>
    <div class="stat-card">
      <div class="label">รายการราคาที่บันทึกสะสม</div>
      <div class="value">${totalPriceEntries.toLocaleString("th-TH")} รายการ</div>
    </div>
    <div class="stat-card">
      <div class="label">ผู้เข้าถึงข้อมูลที่ไม่ซ้ำกัน</div>
      <div class="value">${uniqueViewers.toLocaleString("th-TH")} ราย</div>
      <div class="sub">จาก log ล่าสุดสูงสุด 200 รายการ</div>
    </div>
  `;
}

// ---------- เริ่มต้น ----------
document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkOaeAPI.logout());

async function init() {
  const session = AgroLinkOaeAPI.requireSessionOrRedirect();
  if (!session) return;

  const ok = await loadProfile();
  if (!ok) return;

  await loadDatasets();
  loadDatasets.hasLoadedOnce = true;
  await Promise.all([loadPrices(), loadUsageLog()]);
  loadUsageLog.hasLoadedOnce = true;
  renderOverviewStats();
}

init();
