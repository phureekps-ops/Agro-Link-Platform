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

const UNIT_TYPE_LABEL = { Plot: "แปลงนา/ไร่", Pen: "คอกปศุสัตว์", Pond: "บ่อเลี้ยง", Orchard: "สวนผลไม้" };
const SOIL_LEVEL_LABEL = { low: "ต่ำ", medium: "ปานกลาง", high: "สูง" };

document.getElementById("farmerName") && (document.getElementById("farmerName").textContent = "");
document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkAPI.logout());

// ---------- แปลง/หน่วยผลิต + พืช ----------
let unitsCache = [];
let cropsCache = [];

function selectedUnitId() {
  return document.getElementById("calcUnitSelect").value;
}

async function loadUnits() {
  const sel = document.getElementById("calcUnitSelect");
  try {
    const units = await AgroLinkAPI.get("/farmer/production-units");
    unitsCache = units;
    if (units.length === 0) {
      sel.innerHTML = `<option value="">ยังไม่มีแปลง/หน่วยผลิต</option>`;
      return;
    }
    sel.innerHTML = units.map((u) =>
      `<option value="${u.unit_id}" data-commodity="${escapeHtml(u.commodity_code)}">${escapeHtml(UNIT_TYPE_LABEL[u.unit_type] || u.unit_type)} — ${escapeHtml(u.commodity_code)} (${u.area_rai} ไร่)</option>`
    ).join("");
  } catch (err) {
    sel.innerHTML = `<option value="">โหลดแปลงไม่สำเร็จ</option>`;
    toast("โหลดรายชื่อแปลงไม่สำเร็จ: " + err.message, true);
  }
}

async function loadCrops() {
  const sel = document.getElementById("calcCropSelect");
  try {
    const crops = await AgroLinkAPI.get("/farmer/fertilizer-formula/crops");
    cropsCache = crops;
    if (crops.length === 0) {
      sel.innerHTML = `<option value="">ยังไม่รองรับพืชชนิดใดในขณะนี้</option>`;
      return;
    }
    sel.innerHTML = crops.map((c) =>
      `<option value="${escapeHtml(c.commodity_code)}">${escapeHtml(c.name_th)}</option>`
    ).join("");
  } catch (err) {
    sel.innerHTML = `<option value="">โหลดรายชื่อพืชไม่สำเร็จ</option>`;
    toast("โหลดรายชื่อพืชที่รองรับไม่สำเร็จ: " + err.message, true);
  }
}

function preselectCropFromUnit() {
  const unitSel = document.getElementById("calcUnitSelect");
  const opt = unitSel.selectedOptions[0];
  if (!opt) return;
  const commodityCode = opt.getAttribute("data-commodity");
  const cropSel = document.getElementById("calcCropSelect");
  const match = Array.from(cropSel.options).find((o) => o.value === commodityCode);
  if (match) cropSel.value = commodityCode;
}

function onUnitChanged() {
  preselectCropFromUnit();
  const unitId = selectedUnitId();
  document.getElementById("calcResultSection").innerHTML = "";
  if (!unitId) return;
  loadSoilTests(unitId);
  loadCalcHistory(unitId);
}

document.getElementById("calcUnitSelect").addEventListener("change", onUnitChanged);

// ---------- ผลตรวจดิน ----------
function soilTestCard(t) {
  return `
    <div class="item-card">
      <div class="row"><span class="title">ตรวจเมื่อ ${thaiDate(t.tested_at)}</span><span class="badge status-active">${t.source === "ldd_baseline" ? "ข้อมูล LDD" : "บันทึกเอง"}</span></div>
      <div class="detail-line">N: ${escapeHtml(SOIL_LEVEL_LABEL[t.n_level] || t.n_level)} · P: ${escapeHtml(SOIL_LEVEL_LABEL[t.p_level] || t.p_level)} · K: ${escapeHtml(SOIL_LEVEL_LABEL[t.k_level] || t.k_level)}</div>
      ${t.organic_matter_pct !== null && t.organic_matter_pct !== undefined ? `<div class="detail-line">อินทรียวัตถุ: ${Number(t.organic_matter_pct).toLocaleString("th-TH")}%</div>` : ""}
      ${t.ph_value !== null && t.ph_value !== undefined ? `<div class="detail-line">pH: ${Number(t.ph_value).toLocaleString("th-TH")}</div>` : ""}
      ${t.notes ? `<div class="detail-line muted">${escapeHtml(t.notes)}</div>` : ""}
    </div>
  `;
}

async function loadSoilTests(unitId) {
  const el = document.getElementById("soilTestListSection");
  el.innerHTML = `<div class="loading-line">กำลังโหลดผลตรวจดิน…</div>`;
  try {
    const tests = await AgroLinkAPI.get(`/farmer/soil-tests?unit_id=${encodeURIComponent(unitId)}`);
    if (tests.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีผลตรวจดินสำหรับแปลงนี้ — บันทึกผลแรกได้ทางขวา</div>`;
      return;
    }
    el.innerHTML = tests.map(soilTestCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดผลตรวจดินไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("soilTestForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const unitId = selectedUnitId();
  if (!unitId) {
    toast("กรุณาเลือกแปลง/หน่วยผลิตก่อน", true);
    return;
  }
  const btn = document.getElementById("soilTestSubmitBtn");
  const organicMatterRaw = document.getElementById("soilOrganicMatter").value.trim();
  const phRaw = document.getElementById("soilPh").value.trim();
  const payload = {
    unit_id: unitId,
    n_level: document.getElementById("soilNLevel").value,
    p_level: document.getElementById("soilPLevel").value,
    k_level: document.getElementById("soilKLevel").value,
    organic_matter_pct: organicMatterRaw ? Number(organicMatterRaw) : undefined,
    ph_value: phRaw ? Number(phRaw) : undefined,
    notes: document.getElementById("soilNotes").value.trim() || undefined,
  };

  btn.disabled = true;
  try {
    await AgroLinkAPI.post("/farmer/soil-tests", payload);
    toast("บันทึกผลตรวจดินเรียบร้อยแล้ว");
    document.getElementById("soilTestForm").reset();
    document.getElementById("soilNLevel").value = "medium";
    document.getElementById("soilPLevel").value = "medium";
    document.getElementById("soilKLevel").value = "medium";
    await loadSoilTests(unitId);
  } catch (err) {
    toast("บันทึกผลตรวจดินไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- คำนวณสูตรปุ๋ย ----------
function fertilizerBreakdownHtml(breakdown) {
  return breakdown.map((item) => `
    <div class="detail-line">
      <strong>${escapeHtml(item.label_th)}</strong>: ${Number(item.kg).toLocaleString("th-TH", { minimumFractionDigits: 2 })} กก.
      ${item.subtotal !== null
        ? ` · ${thb(item.price_per_kg)}/กก. (จาก ${escapeHtml(item.cheapest_listing.org_name)}) รวม ${thb(item.subtotal)}`
        : ` · <span class="muted">ยังไม่มีข้อมูลราคาในระบบสำหรับเกรดนี้</span>`}
    </div>
  `).join("");
}

function fertilizerMixingOrderUrl(calc) {
  const kgByGrade = {};
  (calc.fertilizer_breakdown || []).forEach((item) => {
    kgByGrade[item.grade] = item.kg;
  });
  const params = new URLSearchParams();
  if (calc.calc_id) params.set("calc_id", calc.calc_id);
  if (calc.unit_id) params.set("unit_id", calc.unit_id);
  if (kgByGrade["46-0-0"] !== undefined) params.set("urea_kg", kgByGrade["46-0-0"]);
  if (kgByGrade["18-46-0"] !== undefined) params.set("dap_kg", kgByGrade["18-46-0"]);
  if (kgByGrade["0-0-60"] !== undefined) params.set("mop_kg", kgByGrade["0-0-60"]);
  return `fertilizer-mixing-marketplace.html?${params.toString()}`;
}

function renderCalcResult(calc) {
  const el = document.getElementById("calcResultSection");
  el.innerHTML = `
    <div class="section-title">📋 ผลการคำนวณ — ${escapeHtml(calc.commodity_name_th)} (${calc.area_rai} ไร่)</div>
    <div class="panel">
      ${calc.soil_test_used
        ? `<div class="detail-line">ใช้ผลตรวจดินเมื่อ ${thaiDate(calc.soil_test_used.tested_at)} (N: ${escapeHtml(SOIL_LEVEL_LABEL[calc.soil_test_used.n_level] || calc.soil_test_used.n_level)} · P: ${escapeHtml(SOIL_LEVEL_LABEL[calc.soil_test_used.p_level] || calc.soil_test_used.p_level)} · K: ${escapeHtml(SOIL_LEVEL_LABEL[calc.soil_test_used.k_level] || calc.soil_test_used.k_level)})</div>`
        : `<div class="detail-line muted">${escapeHtml(calc.soil_test_missing_note || "")}</div>`}
      <div class="detail-line" style="margin-top:10px; font-weight:700;">ธาตุอาหารที่ต้องการทั้งหมด</div>
      <div class="detail-line">N (ไนโตรเจน): ${Number(calc.n_required_kg).toLocaleString("th-TH", { minimumFractionDigits: 2 })} กก.</div>
      <div class="detail-line">P2O5 (ฟอสฟอรัส): ${Number(calc.p2o5_required_kg).toLocaleString("th-TH", { minimumFractionDigits: 2 })} กก.</div>
      <div class="detail-line">K2O (โพแทสเซียม): ${Number(calc.k2o_required_kg).toLocaleString("th-TH", { minimumFractionDigits: 2 })} กก.</div>
      <div class="detail-line" style="margin-top:10px; font-weight:700;">สูตรปุ๋ยที่แนะนำ (ยูเรีย + DAP + MOP)</div>
      ${fertilizerBreakdownHtml(calc.fertilizer_breakdown)}
      <div class="detail-line" style="margin-top:10px; font-weight:700; color:var(--green-900);">
        ${calc.price_data_complete
          ? "ประมาณการต้นทุนรวม: " + thb(calc.estimated_cost)
          : "ไม่สามารถประเมินต้นทุนรวมได้ครบทุกรายการ (ยังไม่มีสินค้าในระบบที่ระบุเกรด N-P-K และน้ำหนักต่อหน่วยครบทุกชนิด)"}
      </div>
      <div class="detail-line muted" style="margin-top:14px; font-size:12px;">${escapeHtml(calc.disclaimer)}</div>
      <a href="${fertilizerMixingOrderUrl(calc)}" class="btn btn-primary" style="max-width:280px; margin-top:14px; text-decoration:none; display:inline-block; text-align:center;">สั่งบริการผสมปุ๋ยตามสูตรนี้</a>
    </div>
  `;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

document.getElementById("calcForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const unitId = selectedUnitId();
  const commodityCode = document.getElementById("calcCropSelect").value;
  if (!unitId) {
    toast("กรุณาเลือกแปลง/หน่วยผลิต", true);
    return;
  }
  if (!commodityCode) {
    toast("กรุณาเลือกพืชที่ต้องการคำนวณ", true);
    return;
  }

  const btn = document.getElementById("calcSubmitBtn");
  btn.disabled = true;
  try {
    const calc = await AgroLinkAPI.post("/farmer/fertilizer-formula/calculate", {
      unit_id: unitId,
      commodity_code: commodityCode,
    });
    renderCalcResult(calc);
    toast("คำนวณสูตรปุ๋ยเรียบร้อยแล้ว");
    await loadCalcHistory(unitId);
  } catch (err) {
    if (err.body && err.body.error === "unsupported_commodity") {
      toast("ยังไม่รองรับพืชชนิดนี้ในขณะนี้", true);
    } else {
      toast("คำนวณไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
    }
  } finally {
    btn.disabled = false;
  }
});

// ---------- ประวัติการคำนวณ ----------
function calcHistoryCard(c) {
  return `
    <div class="item-card">
      <div class="row"><span class="title">คำนวณเมื่อ ${thaiDate(c.calculated_at)}</span></div>
      <div class="detail-line">${escapeHtml(c.commodity_code)} · ${c.area_rai} ไร่</div>
      <div class="detail-line">ยูเรีย ${Number(c.urea_kg).toLocaleString("th-TH")} กก. · DAP ${Number(c.dap_kg).toLocaleString("th-TH")} กก. · MOP ${Number(c.mop_kg).toLocaleString("th-TH")} กก.</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">
        ${c.price_data_complete ? thb(c.estimated_cost) : "ประเมินต้นทุนไม่ครบทุกรายการ"}
      </div>
    </div>
  `;
}

async function loadCalcHistory(unitId) {
  const el = document.getElementById("calcHistorySection");
  el.innerHTML = `<div class="loading-line">กำลังโหลดประวัติการคำนวณ…</div>`;
  try {
    const history = await AgroLinkAPI.get(`/farmer/fertilizer-formula/history?unit_id=${encodeURIComponent(unitId)}`);
    if (history.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่เคยคำนวณสูตรปุ๋ยสำหรับแปลงนี้</div>`;
      return;
    }
    el.innerHTML = history.map(calcHistoryCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประวัติการคำนวณไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function init() {
  await Promise.all([loadUnits(), loadCrops()]);
  onUnitChanged();
}

init();
