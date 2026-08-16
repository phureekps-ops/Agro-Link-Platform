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
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

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

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkAdminAPI.logout());

async function init() {
  await loadUnits();
}

init();
