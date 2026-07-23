const session = AgroLinkBuyerAPI.requireSessionOrRedirect();

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
  delivered: "รอตรวจสอบคุณภาพ", accepted: "ผ่านคุณภาพ (รอชำระเงิน)",
  rejected: "ไม่ผ่านคุณภาพ", settled: "ชำระเงินแล้ว",
  draft: "ร่าง", pending_signature: "รอลงนาม", active: "ใช้งานอยู่",
  completed: "เสร็จสิ้น", terminated: "ยกเลิก", breached: "ผิดสัญญา",
};
const COMMODITY_LABEL = { RICE_JASMINE: "ข้าวหอมมะลิ", RICE_PADDY: "ข้าวเปลือกเจ้า", CASSAVA: "มันสำปะหลัง" };

function statusBadge(status) {
  // 'delivered' and 'accepted' both map to the gold "in-progress" palette
  // via CSS classes status-pending/status-manual_review — delivered/accepted
  // aren't in that CSS list by name, so map them onto the closest existing
  // class instead of adding new CSS rules for the same three colors.
  const cssClass = { delivered: "status-manual_review", accepted: "status-pending", rejected: "status-declined", settled: "status-converted" }[status] || `status-${status}`;
  return `<span class="badge ${cssClass}">${escapeHtml(STATUS_LABEL[status] || status)}</span>`;
}

// ---------- ภาพรวม ----------
async function loadSummary() {
  const el = document.getElementById("summarySection");
  try {
    const d = await AgroLinkBuyerAPI.get("/buyer/dashboard");
    document.getElementById("orgName").textContent = d.org_name || "-";
    el.innerHTML = `
      <div class="stat-card"><div class="label">รายการที่ต้องดำเนินการ</div><div class="value">${d.needs_action_count}</div></div>
      <div class="stat-card"><div class="label">รอตรวจสอบคุณภาพ</div><div class="value">${d.deliveries_by_status.delivered}</div></div>
      <div class="stat-card"><div class="label">ไม่ผ่านคุณภาพ</div><div class="value">${d.deliveries_by_status.rejected}</div></div>
      <div class="stat-card"><div class="label">ชำระเงินแล้ว</div><div class="value">${d.deliveries_by_status.settled}</div></div>
      <div class="stat-card"><div class="label">สัญญาที่ใช้งานอยู่</div><div class="value">${d.active_contracts}</div></div>
      <div class="stat-card"><div class="label">ยอดชำระสะสม</div><div class="value" style="font-size:18px;">${thb(d.total_settled_amount)}</div></div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดข้อมูลภาพรวมไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- รายการที่ต้องดำเนินการ ----------
function reviewCard(d) {
  const header = `
    <div class="row"><span class="title">${escapeHtml(d.farmer_name || "-")} — ${d.quantity_ton} ตัน ${escapeHtml(COMMODITY_LABEL[d.commodity_code] || d.commodity_code)}</span>${statusBadge(d.status)}</div>
    <div class="detail-line">ราคา ${thb(d.unit_price)}/ตัน · รวม ${thb(d.total_amount)}</div>
    <div class="detail-line muted">รับมอบเมื่อ ${thaiDate(d.delivered_at)}${d.contract_id ? " · ตามสัญญา" : " · ขายทันที (Spot Sale)"}</div>
  `;

  if (d.status === "delivered") {
    return `
      <div class="item-card" data-delivery-id="${d.delivery_id}" data-action="confirm">
        ${header}
        <div class="action-row">
          <input type="text" class="quality-grade-input" placeholder="เกรดคุณภาพ เช่น Grade A" />
          <input type="text" class="inspected-by-input" placeholder="ผู้ตรวจสอบ" />
        </div>
        <div class="action-row">
          <button type="button" class="btn btn-approve btn-sm accept-btn">ผ่านคุณภาพ</button>
          <button type="button" class="btn btn-decline btn-sm reject-btn">ไม่ผ่านคุณภาพ</button>
        </div>
      </div>
    `;
  }

  // status === 'accepted' — ready to settle
  return `
    <div class="item-card" data-delivery-id="${d.delivery_id}" data-action="settle">
      ${header}
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm settle-btn">ชำระเงิน (Settle)</button>
      </div>
    </div>
  `;
}

async function loadReviewQueue() {
  const el = document.getElementById("reviewQueueSection");
  try {
    const deliveries = await AgroLinkBuyerAPI.get("/buyer/deliveries?status=action_needed");
    if (deliveries.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีรายการที่ต้องดำเนินการในขณะนี้</div>`;
      return;
    }
    el.innerHTML = deliveries.map(reviewCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการที่ต้องดำเนินการไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function refreshAllAfterAction() {
  await Promise.all([loadSummary(), loadReviewQueue(), loadAllDeliveries(), loadContracts()]);
}

document.getElementById("reviewQueueSection").addEventListener("click", async (e) => {
  const card = e.target.closest(".item-card");
  if (!card) return;
  const deliveryId = card.dataset.deliveryId;

  if (e.target.classList.contains("accept-btn") || e.target.classList.contains("reject-btn")) {
    const accepted = e.target.classList.contains("accept-btn");
    const qualityGrade = card.querySelector(".quality-grade-input").value.trim();
    const inspectedBy = card.querySelector(".inspected-by-input").value.trim();
    if (!qualityGrade || !inspectedBy) {
      toast("กรุณากรอกเกรดคุณภาพและชื่อผู้ตรวจสอบ", true);
      return;
    }
    e.target.disabled = true;
    try {
      await AgroLinkBuyerAPI.post(`/buyer/deliveries/${deliveryId}/confirm-quality`, {
        quality_grade: qualityGrade,
        accepted,
        inspected_by: inspectedBy,
      });
      toast(accepted ? "บันทึกผลตรวจคุณภาพ: ผ่าน" : "บันทึกผลตรวจคุณภาพ: ไม่ผ่าน");
      await refreshAllAfterAction();
    } catch (err) {
      toast("บันทึกผลตรวจคุณภาพไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      e.target.disabled = false;
    }
  } else if (e.target.classList.contains("settle-btn")) {
    e.target.disabled = true;
    try {
      await AgroLinkBuyerAPI.post(`/buyer/deliveries/${deliveryId}/settle`, {});
      toast("ชำระเงินเรียบร้อยแล้ว");
      await refreshAllAfterAction();
    } catch (err) {
      toast("ชำระเงินไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      e.target.disabled = false;
    }
  }
});

// ---------- การรับมอบทั้งหมด (อ่านอย่างเดียว) ----------
async function loadAllDeliveries() {
  const el = document.getElementById("allDeliveriesSection");
  const status = document.getElementById("statusFilter").value;
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  try {
    const deliveries = await AgroLinkBuyerAPI.get(`/buyer/deliveries${query}`);
    if (deliveries.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีการรับมอบในสถานะนี้</div>`;
      return;
    }
    el.innerHTML = deliveries.map((d) => `
      <div class="item-card">
        <div class="row"><span class="title">${escapeHtml(d.farmer_name || "-")} — ${d.quantity_ton} ตัน ${escapeHtml(COMMODITY_LABEL[d.commodity_code] || d.commodity_code)}</span>${statusBadge(d.status)}</div>
        <div class="detail-line">ราคา ${thb(d.unit_price)}/ตัน · รวม ${thb(d.total_amount)}</div>
        ${d.quality_grade ? `<div class="detail-line">เกรด: ${escapeHtml(d.quality_grade)}</div>` : ""}
        <div class="detail-line muted">รับมอบเมื่อ ${thaiDate(d.delivered_at)}${d.settled_at ? " · ชำระเงินเมื่อ " + thaiDate(d.settled_at) : ""}</div>
      </div>
    `).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดการรับมอบไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("statusFilter").addEventListener("change", () => loadAllDeliveries());

// ---------- สัญญาซื้อขายล่วงหน้า ----------
async function loadContracts() {
  const el = document.getElementById("contractsSection");
  try {
    const contracts = await AgroLinkBuyerAPI.get("/buyer/contracts");
    if (contracts.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีสัญญาซื้อขายล่วงหน้า</div>`;
      return;
    }
    el.innerHTML = contracts.map((c) => `
      <div class="item-card">
        <div class="row"><span class="title">สัญญาซื้อขายล่วงหน้า</span>${statusBadge(c.status)}</div>
        <div class="detail-line">ปริมาณตกลง: ${c.agreed_quantity} ${escapeHtml(c.quantity_unit || "")} @ ${thb(c.agreed_unit_price)}</div>
        ${c.terms_summary ? `<div class="detail-line muted">${escapeHtml(c.terms_summary)}</div>` : ""}
        <div class="detail-line muted">เริ่ม ${thaiDate(c.effective_date)}${c.expiry_date ? " · สิ้นสุด " + thaiDate(c.expiry_date) : ""}</div>
      </div>
    `).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดสัญญาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- ฟอร์มบันทึกการรับมอบใหม่ ----------
let unitsCache = [];
let contractsCache = [];

async function loadUnitsAndCommodities() {
  const unitSelect = document.getElementById("unitSelect");
  const commoditySelect = document.getElementById("commoditySelect");
  try {
    const [units, commodities] = await Promise.all([
      AgroLinkBuyerAPI.get("/buyer/production-units"),
      AgroLinkBuyerAPI.get("/buyer/commodities"),
    ]);
    unitsCache = units;
    unitSelect.innerHTML = units.map((u) =>
      `<option value="${u.unit_id}" data-commodity="${u.commodity_code}">${escapeHtml(u.farmer_name)} — ${escapeHtml(COMMODITY_LABEL[u.commodity_code] || u.commodity_code)} (${u.area_rai} ไร่)</option>`
    ).join("") || `<option value="">ไม่มีหน่วยผลิต</option>`;
    commoditySelect.innerHTML = commodities.map((c) =>
      `<option value="${c.commodity_code}">${escapeHtml(c.name_th)}</option>`
    ).join("");
    // Auto-match the commodity dropdown to the first unit's own commodity.
    if (units.length > 0) commoditySelect.value = units[0].commodity_code;
  } catch (err) {
    unitSelect.innerHTML = `<option value="">โหลดหน่วยผลิตไม่สำเร็จ</option>`;
  }
}

document.getElementById("unitSelect").addEventListener("change", (e) => {
  const opt = e.target.selectedOptions[0];
  if (opt && opt.dataset.commodity) {
    document.getElementById("commoditySelect").value = opt.dataset.commodity;
  }
});

async function loadContractOptions() {
  const sel = document.getElementById("contractSelect");
  try {
    const contracts = await AgroLinkBuyerAPI.get("/buyer/contracts");
    const activeOnes = contracts.filter((c) => c.status === "active");
    contractsCache = activeOnes;
    sel.innerHTML = activeOnes.map((c) =>
      `<option value="${c.contract_id}">หน่วยผลิต ${c.related_unit_id.slice(0, 8)}… — ${c.agreed_quantity} ${escapeHtml(c.quantity_unit || "")} @ ${c.agreed_unit_price} บาท</option>`
    ).join("") || `<option value="">ไม่มีสัญญาที่ใช้งานอยู่</option>`;
  } catch (err) {
    sel.innerHTML = `<option value="">โหลดสัญญาไม่สำเร็จ</option>`;
  }
}

function updateSaleTypeVisibility() {
  const type = document.getElementById("saleType").value;
  document.getElementById("contractFields").style.display = type === "contract" ? "block" : "none";
  document.getElementById("spotFields").style.display = type === "spot" ? "block" : "none";
}
document.getElementById("saleType").addEventListener("change", updateSaleTypeVisibility);
updateSaleTypeVisibility();

document.getElementById("deliveryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("deliverySubmitBtn");
  const saleType = document.getElementById("saleType").value;
  const quantityTon = document.getElementById("quantityInput").value;

  if (!quantityTon || Number(quantityTon) <= 0) {
    toast("กรุณาระบุปริมาณที่มากกว่า 0", true);
    return;
  }

  const payload = { quantity_ton: Number(quantityTon) };

  if (saleType === "contract") {
    const contractId = document.getElementById("contractSelect").value;
    if (!contractId) {
      toast("กรุณาเลือกสัญญา", true);
      return;
    }
    const contract = contractsCache.find((c) => c.contract_id === contractId);
    const unit = unitsCache.find((u) => u.unit_id === (contract ? contract.related_unit_id : null));
    payload.contract_id = contractId;
    payload.unit_id = contract ? contract.related_unit_id : null;
    payload.commodity_code = unit ? unit.commodity_code : document.getElementById("commoditySelect").value;
    if (!payload.unit_id) {
      toast("ไม่พบหน่วยผลิตที่เชื่อมกับสัญญานี้", true);
      return;
    }
  } else {
    const unitId = document.getElementById("unitSelect").value;
    const commodityCode = document.getElementById("commoditySelect").value;
    const unitPrice = document.getElementById("unitPriceInput").value;
    if (!unitId || !commodityCode || !unitPrice) {
      toast("กรุณากรอกข้อมูลให้ครบถ้วน (หน่วยผลิต, สินค้า, ราคา)", true);
      return;
    }
    payload.unit_id = unitId;
    payload.commodity_code = commodityCode;
    payload.unit_price = Number(unitPrice);
  }

  btn.disabled = true;
  try {
    await AgroLinkBuyerAPI.post("/buyer/deliveries", payload);
    toast("บันทึกการรับมอบเรียบร้อยแล้ว รอตรวจสอบคุณภาพ");
    document.getElementById("deliveryForm").reset();
    updateSaleTypeVisibility();
    await refreshAllAfterAction();
  } catch (err) {
    toast("บันทึกการรับมอบไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkBuyerAPI.logout());

// Kick off all sections concurrently — independent panels, one broken
// panel doesn't take down the rest of the page.
loadSummary();
loadReviewQueue();
loadAllDeliveries();
loadContracts();
loadUnitsAndCommodities();
loadContractOptions();
