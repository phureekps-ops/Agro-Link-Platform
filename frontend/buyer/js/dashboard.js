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
        เมื่อได้รับการอนุมัติแล้ว ท่านจะสามารถบันทึกการส่งมอบและประกาศราคารับซื้อได้เต็มรูปแบบ —
        ลองเข้าสู่ระบบใหม่อีกครั้งในภายหลัง หรือรีเฟรชหน้านี้
      </div>
    </div>
  `;
}

/**
 * Same shape as inputsupplier/js/dashboard.js's showRolePendingNotice — the
 * org has cleared entity KYB but doesn't (yet) hold a Verified 'Buyer' role.
 */
function showRolePendingNotice(orgName, roleStatus) {
  document.getElementById("orgName").textContent = orgName || "-";
  const body = !roleStatus
    ? {
        title: "องค์กรของท่านยังไม่มีบทบาทผู้รับซื้อผลผลิต",
        detail: "หากต้องการเปิดใช้งานพอร์ทัลนี้ ท่านสามารถส่งคำขอเพิ่มบทบาทได้จากหน้า \"จัดการบทบาทธุรกิจ\"",
      }
    : roleStatus === "Rejected"
    ? { title: "คำขอบทบาทผู้รับซื้อผลผลิตของท่านถูกปฏิเสธ", detail: "กรุณาติดต่อเจ้าหน้าที่ผู้ดูแลระบบสำหรับข้อมูลเพิ่มเติม" }
    : { title: "คำขอบทบาทผู้รับซื้อผลผลิตของท่านอยู่ระหว่างการตรวจสอบ", detail: "เจ้าหน้าที่ผู้ดูแลระบบ (Platform Ops) กำลังตรวจสอบคำขอนี้ — ลองรีเฟรชหน้านี้อีกครั้งภายหลัง" };

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
  const byStatus = d.deliveries_by_status || {};
  document.getElementById("summarySection").innerHTML = `
    <div class="stat-card"><div class="label">สถานะ KYB</div><div class="value" style="font-size:16px;">${escapeHtml(d.kyb_status)}</div></div>
    <div class="stat-card"><div class="label">รอตรวจคุณภาพ</div><div class="value">${byStatus.delivered || 0}</div></div>
    <div class="stat-card"><div class="label">รอชำระเงิน</div><div class="value">${byStatus.accepted || 0}</div></div>
    <div class="stat-card"><div class="label">ชำระเงินแล้ว</div><div class="value">${byStatus.settled || 0}</div></div>
    <div class="stat-card"><div class="label">ยอดชำระสะสม</div><div class="value" style="font-size:16px;">${thb(d.total_settled_amount)}</div></div>
    <div class="stat-card"><div class="label">สัญญาที่ยังดำเนินอยู่</div><div class="value">${d.active_contracts}</div></div>
  `;
}

async function refreshSummary() {
  try {
    const d = await AgroLinkBuyerAPI.get("/buyer/dashboard");
    renderSummary(d);
  } catch (err) {
    // Dashboard already loaded once successfully to get this far — a
    // transient failure on refresh isn't worth interrupting the user.
  }
}

// ---------- การส่งมอบ ----------
const DELIVERY_STATUS_LABEL_TH = {
  delivered: "ส่งมอบแล้ว (รอตรวจคุณภาพ)",
  accepted: "ตรวจคุณภาพผ่านแล้ว (รอชำระเงิน)",
  rejected: "ไม่ผ่านการตรวจคุณภาพ",
  settled: "ชำระเงินแล้ว",
};
const DELIVERY_STATUS_BADGE_CLASS = {
  delivered: "status-pending",
  accepted: "status-approved",
  rejected: "status-declined",
  settled: "status-completed",
};

function deliveryCard(d) {
  const badgeClass = DELIVERY_STATUS_BADGE_CLASS[d.status] || "status-pending";
  const badge = `<span class="badge ${badgeClass}">${escapeHtml(DELIVERY_STATUS_LABEL_TH[d.status] || d.status)}</span>`;

  let actions = "";
  if (d.status === "delivered") {
    actions = `
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-grade-for="${d.delivery_id}" placeholder="เกรดคุณภาพ (เช่น A, B, เกรด 1)" />
        <input type="text" class="reject-reason-input" data-inspector-for="${d.delivery_id}" placeholder="ชื่อผู้ตรวจสอบ" />
      </div>
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm" data-accept-quality="${d.delivery_id}">ผ่านคุณภาพ</button>
        <button type="button" class="btn btn-decline btn-sm" data-reject-quality="${d.delivery_id}">ไม่ผ่านคุณภาพ</button>
      </div>
    `;
  } else if (d.status === "accepted") {
    actions = `
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm" data-settle-delivery="${d.delivery_id}">ชำระเงิน (Settle)</button>
      </div>
    `;
  }

  return `
    <div class="item-card" data-delivery-id="${d.delivery_id}">
      <div class="row"><span class="title">${escapeHtml(d.farmer_name || "-")} — ${escapeHtml(d.commodity_code)}</span>${badge}</div>
      <div class="detail-line">น้ำหนัก ${Number(d.quantity_ton).toLocaleString("th-TH")} ตัน${d.unit_price ? ` × ${thb(d.unit_price)} บาท/ตัน` : ""}</div>
      ${d.total_amount ? `<div class="detail-line" style="font-weight:700; color:var(--green-900);">รวม ${thb(d.total_amount)} บาท</div>` : ""}
      ${d.quality_grade ? `<div class="detail-line">เกรดคุณภาพ: ${escapeHtml(d.quality_grade)}${d.inspected_by ? " · ผู้ตรวจ: " + escapeHtml(d.inspected_by) : ""}</div>` : ""}
      <div class="detail-line muted">ส่งมอบเมื่อ ${thaiDate(d.delivered_at)}${d.settled_at ? " · ชำระเงินเมื่อ " + thaiDate(d.settled_at) : ""}</div>
      ${actions}
    </div>
  `;
}

async function loadDeliveryReviewQueue() {
  const el = document.getElementById("deliveryReviewQueueSection");
  try {
    const deliveries = await AgroLinkBuyerAPI.get("/buyer/deliveries?status=action_needed");
    if (deliveries.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีการส่งมอบที่ต้องดำเนินการในขณะนี้</div>`;
      return;
    }
    el.innerHTML = deliveries.map(deliveryCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการส่งมอบไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadDeliveryHistory() {
  const el = document.getElementById("deliveryHistorySection");
  const status = document.getElementById("deliveryStatusFilter").value;
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const deliveries = await AgroLinkBuyerAPI.get(`/buyer/deliveries${query}`);
    if (deliveries.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีการส่งมอบ</div>`;
      return;
    }
    el.innerHTML = deliveries.map(deliveryCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประวัติการส่งมอบไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function refreshDeliveriesAndSummary() {
  await Promise.all([loadDeliveryReviewQueue(), loadDeliveryHistory(), refreshSummary()]);
}

document.getElementById("deliveryStatusFilter").addEventListener("change", () => loadDeliveryHistory());

function handleDeliveryActionClick(container) {
  container.addEventListener("click", async (e) => {
    const acceptBtn = e.target.closest("[data-accept-quality]");
    const rejectBtn = e.target.closest("[data-reject-quality]");
    const settleBtn = e.target.closest("[data-settle-delivery]");

    if (acceptBtn || rejectBtn) {
      const deliveryId = (acceptBtn || rejectBtn).dataset.acceptQuality || (acceptBtn || rejectBtn).dataset.rejectQuality;
      const accepted = !!acceptBtn;
      const gradeInput = container.querySelector(`[data-grade-for="${deliveryId}"]`);
      const inspectorInput = container.querySelector(`[data-inspector-for="${deliveryId}"]`);
      const qualityGrade = gradeInput ? gradeInput.value.trim() : "";
      const inspectedBy = inspectorInput ? inspectorInput.value.trim() : "";
      if (!qualityGrade || !inspectedBy) {
        toast("กรุณากรอกเกรดคุณภาพและชื่อผู้ตรวจสอบ", true);
        return;
      }
      const btn = acceptBtn || rejectBtn;
      btn.disabled = true;
      try {
        await AgroLinkBuyerAPI.post(`/buyer/deliveries/${deliveryId}/confirm-quality`, {
          quality_grade: qualityGrade,
          accepted,
          inspected_by: inspectedBy,
        });
        toast(accepted ? "บันทึกผลตรวจคุณภาพ (ผ่าน) เรียบร้อยแล้ว" : "บันทึกผลตรวจคุณภาพ (ไม่ผ่าน) เรียบร้อยแล้ว");
        await refreshDeliveriesAndSummary();
      } catch (err) {
        toast("ดำเนินการไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
        btn.disabled = false;
      }
      return;
    }

    if (settleBtn) {
      const deliveryId = settleBtn.dataset.settleDelivery;
      settleBtn.disabled = true;
      try {
        await AgroLinkBuyerAPI.post(`/buyer/deliveries/${deliveryId}/settle`, {});
        toast("ชำระเงินเรียบร้อยแล้ว");
        await refreshDeliveriesAndSummary();
      } catch (err) {
        toast("ชำระเงินไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
        settleBtn.disabled = false;
      }
    }
  });
}

handleDeliveryActionClick(document.getElementById("deliveryReviewQueueSection"));
handleDeliveryActionClick(document.getElementById("deliveryHistorySection"));

// ---------- แบบฟอร์มบันทึกการส่งมอบใหม่ ----------
const deliveryForm = document.getElementById("deliveryForm");
const contractSelect = document.getElementById("contractSelect");
const unitPriceInput = document.getElementById("unitPriceInput");
let contractsCache = [];

function updateUnitPriceRequirement() {
  const hasContract = !!contractSelect.value;
  unitPriceInput.required = !hasContract;
  unitPriceInput.placeholder = hasContract ? "ใช้ราคาตามสัญญาโดยอัตโนมัติ" : "เช่น 12500";
  unitPriceInput.disabled = hasContract;
  if (hasContract) unitPriceInput.value = "";
}
contractSelect.addEventListener("change", updateUnitPriceRequirement);

async function loadProductionUnits() {
  const el = document.getElementById("unitSelect");
  try {
    const units = await AgroLinkBuyerAPI.get("/buyer/production-units");
    el.innerHTML = `<option value="">-- เลือกแปลง --</option>` +
      units.map((u) => `<option value="${u.unit_id}">${escapeHtml(u.farmer_name)} — ${escapeHtml(u.commodity_code)} (${Number(u.area_rai).toLocaleString("th-TH")} ไร่)</option>`).join("");
  } catch (err) {
    el.innerHTML = `<option value="">โหลดรายชื่อแปลงไม่สำเร็จ</option>`;
  }
}

async function loadCommodities() {
  const el = document.getElementById("commoditySelect");
  try {
    const commodities = await AgroLinkBuyerAPI.get("/buyer/commodities");
    el.innerHTML = `<option value="">-- เลือกชนิดผลผลิต --</option>` +
      commodities.map((c) => `<option value="${c.commodity_code}">${escapeHtml(c.name_th)}</option>`).join("");
  } catch (err) {
    el.innerHTML = `<option value="">โหลดชนิดผลผลิตไม่สำเร็จ</option>`;
  }
}

deliveryForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const unitId = document.getElementById("unitSelect").value;
  const commodityCode = document.getElementById("commoditySelect").value;
  const quantityTon = Number(document.getElementById("quantityInput").value);
  const contractId = contractSelect.value || null;
  const unitPriceRaw = unitPriceInput.value;

  if (!unitId || !commodityCode) {
    toast("กรุณาเลือกแปลงและชนิดผลผลิต", true);
    return;
  }
  if (!Number.isFinite(quantityTon) || quantityTon <= 0) {
    toast("กรุณากรอกน้ำหนักที่มากกว่า 0", true);
    return;
  }
  if (!contractId && !unitPriceRaw) {
    toast("กรุณากรอกราคาต่อหน่วยเมื่อไม่มีสัญญา", true);
    return;
  }

  const submitBtn = document.getElementById("deliverySubmitBtn");
  submitBtn.disabled = true;
  try {
    await AgroLinkBuyerAPI.post("/buyer/deliveries", {
      unit_id: unitId,
      commodity_code: commodityCode,
      quantity_ton: quantityTon,
      contract_id: contractId,
      unit_price: unitPriceRaw ? Number(unitPriceRaw) : undefined,
    });
    toast("บันทึกการส่งมอบเรียบร้อยแล้ว");
    deliveryForm.reset();
    updateUnitPriceRequirement();
    await refreshDeliveriesAndSummary();
  } catch (err) {
    toast("บันทึกไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- ราคารับซื้อข้าวประจำวัน ----------
async function loadPriceQuotes() {
  const el = document.getElementById("priceQuoteFormSection");
  try {
    const d = await AgroLinkBuyerAPI.get("/buyer/price-quotes");
    el.innerHTML = d.items.map((item) => `
      <div class="field">
        <label for="grade-${escapeHtml(item.grade_code)}">${escapeHtml(item.name_th)} (${escapeHtml(item.price_unit)})</label>
        <input type="number" min="0" step="0.01" id="grade-${escapeHtml(item.grade_code)}" data-grade-code="${escapeHtml(item.grade_code)}" value="${item.quoted_price !== null ? item.quoted_price : ""}" placeholder="ยังไม่ประกาศราคา" />
      </div>
    `).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดราคารับซื้อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("priceQuoteSubmitBtn").addEventListener("click", async () => {
  const inputs = document.querySelectorAll("#priceQuoteFormSection [data-grade-code]");
  const quotes = {};
  inputs.forEach((input) => {
    const raw = input.value.trim();
    quotes[input.dataset.gradeCode] = raw === "" ? null : Number(raw);
  });

  const btn = document.getElementById("priceQuoteSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkBuyerAPI.put("/buyer/price-quotes", { quotes });
    toast("บันทึกราคารับซื้อเรียบร้อยแล้ว");
    await loadPriceQuotes();
  } catch (err) {
    toast("บันทึกไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- พอร์ตสัญญารับซื้อ ----------
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
      ${c.agreed_quantity ? `<div class="detail-line">ปริมาณตามสัญญา ${Number(c.agreed_quantity).toLocaleString("th-TH")} ${escapeHtml(c.quantity_unit || "")} × ${thb(c.agreed_unit_price)} บาท</div>` : ""}
      <div class="detail-line muted">มีผล ${thaiDate(c.effective_date)} ถึง ${thaiDate(c.expiry_date)}</div>
      ${c.terms_summary ? `<div class="detail-line muted">${escapeHtml(c.terms_summary)}</div>` : ""}
      <div class="detail-line muted">สร้างเมื่อ ${thaiDate(c.created_at)}</div>
    </div>
  `;
}

async function loadContracts() {
  const el = document.getElementById("contractListSection");
  try {
    const contracts = await AgroLinkBuyerAPI.get("/buyer/contracts");
    contractsCache = contracts;
    contractSelect.innerHTML = `<option value="">-- ไม่มีสัญญา (ซื้อขายทันที/Spot Sale) --</option>` +
      contracts.filter((c) => c.status === "active").map((c) => `<option value="${c.contract_id}">สัญญา ${escapeHtml(c.contract_type || "-")} (${thaiDate(c.effective_date)})</option>`).join("");

    if (contracts.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีสัญญารับซื้อ</div>`;
      return;
    }
    el.innerHTML = contracts.map(contractCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดสัญญารับซื้อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkBuyerAPI.logout());

/**
 * GET /buyer/dashboard doubles as the KYB/role gate check here — same
 * pattern as every other portal's init().
 */
// ============================================================
// แค็ตตาล็อกผลผลิต/สินค้าแปรรูปจากสหกรณ์ (M14.1) — buyer-facing browse +
// order + cancel against GET/POST /buyer/coop-products* and
// /buyer/coop-directory. Mirrors frontend/js/marketplace.js's shape (the
// farmer-facing InputSupplier catalog browser) — same card/order pattern,
// just a different seller audience (Cooperative orgs, not InputSupplier).
// ============================================================

const COOP_CATALOG_CATEGORY_LABEL_TH = {
  produce: "ผลผลิตทางการเกษตร",
  processed_good: "สินค้าแปรรูป",
  other: "อื่นๆ",
};

const COOP_ORDER_STATUS_LABEL_TH = {
  requested: "รอสหกรณ์ยืนยัน",
  confirmed: "ยืนยันแล้ว (รอส่งมอบ)",
  fulfilled: "ส่งมอบแล้ว",
  rejected: "สหกรณ์ปฏิเสธ",
  cancelled: "ยกเลิกแล้ว",
};
const COOP_ORDER_STATUS_BADGE_CLASS = {
  requested: "status-pending",
  confirmed: "status-approved",
  fulfilled: "status-completed",
  rejected: "status-declined",
  cancelled: "status-declined",
};

async function loadCoopSuppliersIntoFilter() {
  const select = document.getElementById("coopCatalogSupplierFilter");
  try {
    const coops = await AgroLinkBuyerAPI.get("/buyer/coop-directory");
    coops.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.org_id;
      opt.textContent = `${c.org_name} (${c.active_product_count} รายการ)`;
      select.appendChild(opt);
    });
  } catch (err) {
    // Non-fatal — "ทั้งหมด" still works without the supplier list.
  }
}

function coopCatalogCard(p) {
  return `
    <div class="item-card" data-listing-id="${p.listing_id}">
      <div class="row">
        <span class="title">${p.featured ? "⭐ " : ""}${escapeHtml(p.product_name)}${p.brand ? " · " + escapeHtml(p.brand) : ""}</span>
        <span class="badge status-active">${escapeHtml(COOP_CATALOG_CATEGORY_LABEL_TH[p.category] || p.category)}</span>
      </div>
      ${p.featured ? `<div class="detail-line"><span class="badge status-approved">⭐ แนะนำ</span></div>` : ""}
      <div class="detail-line">สหกรณ์: ${escapeHtml(p.org_name)}</div>
      ${p.description ? `<div class="detail-line muted">${escapeHtml(p.description)}</div>` : ""}
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">
        ${Number(p.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(p.price_unit)}
      </div>
      <div class="action-row">
        <input type="number" class="order-qty-input" data-coop-qty-for="${p.listing_id}" min="0.01" step="0.01" value="1" style="max-width:120px;" />
        <button type="button" class="btn btn-primary btn-sm" data-coop-order="${p.listing_id}">สั่งซื้อ</button>
      </div>
    </div>
  `;
}

async function loadCoopCatalog() {
  const el = document.getElementById("coopCatalogSection");
  const category = document.getElementById("coopCatalogCategoryFilter").value;
  const orgId = document.getElementById("coopCatalogSupplierFilter").value;
  el.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (orgId) params.set("org_id", orgId);
    const qs = params.toString();
    const products = await AgroLinkBuyerAPI.get(`/buyer/coop-products${qs ? "?" + qs : ""}`);
    el.innerHTML = products.length === 0
      ? `<div class="empty-state">ยังไม่มีสินค้าจากสหกรณ์ตามเงื่อนไขที่เลือก</div>`
      : products.map(coopCatalogCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดแค็ตตาล็อกไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("coopCatalogCategoryFilter").addEventListener("change", () => loadCoopCatalog());
document.getElementById("coopCatalogSupplierFilter").addEventListener("change", () => loadCoopCatalog());

document.getElementById("coopCatalogSection").addEventListener("click", async (e) => {
  const orderBtn = e.target.closest("[data-coop-order]");
  if (!orderBtn) return;
  const listingId = orderBtn.dataset.coopOrder;
  const qtyInput = document.querySelector(`[data-coop-qty-for="${listingId}"]`);
  const quantity = Number(qtyInput && qtyInput.value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    toast("กรุณากรอกจำนวนที่ต้องการสั่งซื้อ", true);
    return;
  }
  orderBtn.disabled = true;
  try {
    await AgroLinkBuyerAPI.post("/buyer/coop-products/orders", { listing_id: listingId, quantity });
    toast("สั่งซื้อเรียบร้อยแล้ว — รอสหกรณ์ยืนยัน");
    await loadCoopOrderHistory();
  } catch (err) {
    toast("สั่งซื้อไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
  } finally {
    orderBtn.disabled = false;
  }
});

// ---------- ประวัติคำสั่งซื้อของฉัน ----------
function coopOrderCard(o) {
  const badgeClass = COOP_ORDER_STATUS_BADGE_CLASS[o.status] || "status-pending";
  const badge = `<span class="badge ${badgeClass}">${escapeHtml(COOP_ORDER_STATUS_LABEL_TH[o.status] || o.status)}</span>`;
  const canCancel = o.status === "requested";
  return `
    <div class="item-card" data-order-id="${o.order_id}">
      <div class="row"><span class="title">${escapeHtml(o.coop_org_name)} — ${escapeHtml(o.product_name)}</span>${badge}</div>
      <div class="detail-line">${escapeHtml(COOP_CATALOG_CATEGORY_LABEL_TH[o.category] || o.category)} · จำนวน ${Number(o.quantity).toLocaleString("th-TH")} x ${Number(o.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(o.price_unit)}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">รวม ${Number(o.total_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท</div>
      ${o.decided_reason ? `<div class="detail-line muted">เหตุผล: ${escapeHtml(o.decided_reason)}</div>` : ""}
      <div class="detail-line muted">สั่งซื้อเมื่อ ${thaiDate(o.requested_at)}</div>
      ${canCancel ? `<div class="action-row"><button type="button" class="btn btn-decline btn-sm" data-coop-cancel-order="${o.order_id}">ยกเลิกคำสั่งซื้อ</button></div>` : ""}
    </div>
  `;
}

async function loadCoopOrderHistory() {
  const el = document.getElementById("coopOrderHistorySection");
  const status = document.getElementById("coopOrderStatusFilter").value;
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const orders = await AgroLinkBuyerAPI.get(`/buyer/coop-products/orders${query}`);
    el.innerHTML = orders.length === 0
      ? `<div class="empty-state">ยังไม่มีคำสั่งซื้อ</div>`
      : orders.map(coopOrderCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประวัติคำสั่งซื้อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("coopOrderStatusFilter").addEventListener("change", () => loadCoopOrderHistory());

document.getElementById("coopOrderHistorySection").addEventListener("click", async (e) => {
  const cancelBtn = e.target.closest("[data-coop-cancel-order]");
  if (!cancelBtn) return;
  const orderId = cancelBtn.dataset.coopCancelOrder;
  cancelBtn.disabled = true;
  try {
    await AgroLinkBuyerAPI.post(`/buyer/coop-products/orders/${orderId}/cancel`, {});
    toast("ยกเลิกคำสั่งซื้อเรียบร้อยแล้ว");
    await loadCoopOrderHistory();
  } catch (err) {
    toast("ยกเลิกไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
    cancelBtn.disabled = false;
  }
});

// ============================================================
// RFP/RFQ (Request for Proposal / Request for Quote) — cross-portal
// marketplace (see backend/src/routes/procurement.js and backend/db/
// grant_rfq_marketplace.sql). ANY subject (farmer or organization) can
// post/browse/cancel/accept an RFQ; only ORGANIZATIONS can submit/withdraw
// quotes (see procurement.js's own doc comment for the design rationale —
// farmer-to-farmer quoting was judged out of scope for this round). This
// portal is always an organization, so the quoting UI is always shown
// here; the farmer-facing standalone rfq.html hides it instead.
// ============================================================
const RFQ_CATEGORY_LABEL_TH = {
  input_product: "ปัจจัยการผลิต",
  produce: "ผลผลิตทางการเกษตร",
  processed_good: "สินค้าแปรรูป",
  machinery_service: "บริการเครื่องจักรกล",
  other: "อื่นๆ",
};
const RFQ_STATUS_LABEL_TH = {
  open: "เปิดรับใบเสนอราคา",
  awarded: "ตกลงแล้ว",
  cancelled: "ยกเลิกแล้ว",
  closed: "ปิดแล้ว",
};
const RFQ_STATUS_BADGE_CLASS = {
  open: "status-active",
  awarded: "status-approved",
  cancelled: "status-declined",
  closed: "status-pending",
};
const RFQ_QUOTE_STATUS_LABEL_TH = {
  submitted: "รอผลพิจารณา",
  accepted: "ได้รับเลือก",
  rejected: "ไม่ได้รับเลือก",
  withdrawn: "ถอนแล้ว",
};
const RFQ_QUOTE_STATUS_BADGE_CLASS = {
  submitted: "status-pending",
  accepted: "status-approved",
  rejected: "status-declined",
  withdrawn: "status-declined",
};

let rfqMineCache = [];
let rfqIsOrganization = false;

// ============================================================
// AgroLink B2B Commerce Engine — e-Auction + Contract + Purchase Order
// (see backend/db/grant_b2b_commerce_engine.sql and
// B2B_COMMERCE_ENGINE_ARCHITECTURE.md). Sits directly on top of the RFQ
// section above: an auction is opened FROM one of this org's own open
// RFQs, awarding it (by closing the auction, or by accepting a direct
// quote above) auto-creates a real contract.contract row, and a contract
// can then have a Purchase Order issued against it. auctionMineByRfqId is
// populated before rfqMineCard() renders so each RFQ card can show
// whether it already has a live auction instead of offering to open a
// duplicate one (the backend would reject that with 409
// auction_already_exists, but catching it client-side is better UX).
// ============================================================
const AUCTION_STATUS_LABEL_TH = {
  open: "เปิดประมูล",
  closed: "ปิดแล้ว (ไม่มีผู้เสนอราคา)",
  awarded: "ปิดประมูล — มีผู้ชนะ",
  cancelled: "ยกเลิกแล้ว",
};
const AUCTION_STATUS_BADGE_CLASS = {
  open: "status-active",
  closed: "status-pending",
  awarded: "status-approved",
  cancelled: "status-declined",
};
const CONTRACT_TYPE_LABEL_TH = {
  forward_purchase: "สัญญาซื้อขายล่วงหน้า",
  service_agreement: "สัญญาจ้างบริการ",
  input_supply_agreement: "สัญญาจัดหาปัจจัยการผลิต",
  loan_agreement: "สัญญาสินเชื่อ",
};
const CONTRACT_ROLE_LABEL_TH = {
  buyer: "ผู้ซื้อ",
  farmer: "เกษตรกร",
  seller: "ผู้ขาย",
  input_supplier: "ผู้จัดหาปัจจัยการผลิต",
  service_provider: "ผู้ให้บริการ",
  lender: "ผู้ให้สินเชื่อ",
  platform: "แพลตฟอร์ม",
};
const PO_STATUS_LABEL_TH = {
  issued: "ออกแล้ว รอตอบรับ",
  acknowledged: "ผู้ขายตอบรับแล้ว",
  in_fulfillment: "อยู่ระหว่างส่งมอบ",
  completed: "เสร็จสมบูรณ์",
  cancelled: "ยกเลิกแล้ว",
};
const PO_STATUS_BADGE_CLASS = {
  issued: "status-pending",
  acknowledged: "status-approved",
  in_fulfillment: "status-active",
  completed: "status-approved",
  cancelled: "status-declined",
};
const INVOICE_STATUS_LABEL_TH = {
  issued: "ออกแล้ว รอชำระ",
  paid: "ชำระแล้ว",
  disputed: "มีข้อโต้แย้ง",
  cancelled: "ยกเลิกแล้ว",
};
const INVOICE_STATUS_BADGE_CLASS = {
  issued: "status-pending",
  paid: "status-approved",
  disputed: "status-declined",
  cancelled: "status-declined",
};
// Mirrors backend PO_ISSUER_ROLES (procurement.js) — only the "wants the
// goods" contract party may issue a PO; used here purely to decide
// whether to show the "ออกใบสั่งซื้อ" button, never as a security check
// (the server re-validates this on every write regardless).
const PO_ISSUER_ROLES_CLIENT = ["farmer", "buyer"];

let auctionMineCache = [];
let auctionMineByRfqId = new Map();
let contractsMineCache = [];

function rfqMoney(n) {
  return Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2 });
}

function rfqThaiDateOnly(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

function rfqMetaLine(r) {
  const parts = [];
  if (r.quantity) parts.push(`จำนวน ${rfqMoney(r.quantity)} ${escapeHtml(r.quantity_unit || "")}`);
  if (r.target_price) parts.push(`ราคาเป้าหมาย ${rfqMoney(r.target_price)} บาท`);
  if (r.delivery_location) parts.push(`ส่งที่ ${escapeHtml(r.delivery_location)}`);
  if (r.needed_by_date) parts.push(`ต้องการภายใน ${rfqThaiDateOnly(r.needed_by_date)}`);
  return parts.join(" · ");
}

function rfqQuoteRow(q, rfqId, rfqStatus) {
  const badgeClass = RFQ_QUOTE_STATUS_BADGE_CLASS[q.status] || "status-pending";
  const canAccept = q.status === "submitted" && rfqStatus === "open";
  return `
    <div class="item-card" style="margin-top:8px;" data-quote-id="${q.quote_id}">
      <div class="row">
        <span class="title">${escapeHtml(q.responder_org_name)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(RFQ_QUOTE_STATUS_LABEL_TH[q.status] || q.status)}</span>
      </div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">
        ${rfqMoney(q.quoted_price)} ${escapeHtml(q.price_unit)}${q.quoted_quantity ? ` · จำนวน ${rfqMoney(q.quoted_quantity)}` : ""}
      </div>
      ${q.message ? `<div class="detail-line muted">${escapeHtml(q.message)}</div>` : ""}
      <div class="detail-line muted">เสนอเมื่อ ${thaiDate(q.submitted_at)}</div>
      ${canAccept ? `
        <div class="action-row">
          <button type="button" class="btn btn-approve btn-sm" data-rfq-accept-quote="${q.quote_id}" data-rfq-accept-rfq="${rfqId}">ยอมรับใบเสนอราคานี้</button>
        </div>
      ` : ""}
    </div>
  `;
}

function rfqMineCard(r) {
  const badgeClass = RFQ_STATUS_BADGE_CLASS[r.status] || "status-pending";
  const auction = auctionMineByRfqId.get(r.rfq_id);
  let auctionBadgeOrButton = "";
  if (r.status === "open") {
    if (auction) {
      const aBadgeClass = AUCTION_STATUS_BADGE_CLASS[auction.status] || "status-pending";
      auctionBadgeOrButton = `<span class="badge ${aBadgeClass}">🏆 ประมูล: ${escapeHtml(AUCTION_STATUS_LABEL_TH[auction.status] || auction.status)}</span>`;
    } else {
      auctionBadgeOrButton = `<button type="button" class="btn btn-ghost btn-sm" data-rfq-toggle-auction-form="${r.rfq_id}">🏆 เปิดประมูล (e-Auction)</button>`;
    }
  }
  return `
    <div class="item-card" data-rfq-id="${r.rfq_id}">
      <div class="row">
        <span class="title">${escapeHtml(r.title)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(RFQ_STATUS_LABEL_TH[r.status] || r.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(RFQ_CATEGORY_LABEL_TH[r.category] || r.category)}</div>
      ${r.description ? `<div class="detail-line muted">${escapeHtml(r.description)}</div>` : ""}
      <div class="detail-line muted">${rfqMetaLine(r)}</div>
      <div class="detail-line muted">ประกาศเมื่อ ${thaiDate(r.created_at)}</div>
      <div class="action-row">
        <button type="button" class="btn btn-ghost btn-sm" data-rfq-toggle-quotes="${r.rfq_id}">ดูใบเสนอราคา</button>
        ${r.status === "open" ? `<button type="button" class="btn btn-decline btn-sm" data-rfq-cancel="${r.rfq_id}">ยกเลิกประกาศ</button>` : ""}
        ${auctionBadgeOrButton}
      </div>
      ${(!auction && r.status === "open") ? `
        <div data-rfq-auction-form-container="${r.rfq_id}" style="display:none; margin-top:8px;">
          <div class="form-grid">
            <div class="field full">
              <label>ปิดรับราคาเมื่อ (วัน-เวลา)</label>
              <input type="datetime-local" data-rfq-auction-closes-at="${r.rfq_id}" />
            </div>
          </div>
          <div class="action-row">
            <button type="button" class="btn btn-primary btn-sm" data-rfq-submit-auction="${r.rfq_id}">เริ่มการประมูล</button>
          </div>
        </div>
      ` : ""}
      <div data-rfq-quotes-container="${r.rfq_id}" style="display:none;"></div>
    </div>
  `;
}

async function loadRfqMine() {
  const el = document.getElementById("rfqMineSection");
  try {
    const list = await AgroLinkBuyerAPI.get("/procurement/rfqs/mine");
    rfqMineCache = list;
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ยังไม่มีประกาศของท่าน — ประกาศความต้องการแรกได้ด้านบน</div>`
      : list.map(rfqMineCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประกาศของฉันไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("rfqMineSection").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-rfq-toggle-quotes]");
  const cancelBtn = e.target.closest("[data-rfq-cancel]");
  const acceptBtn = e.target.closest("[data-rfq-accept-quote]");
  const toggleAuctionBtn = e.target.closest("[data-rfq-toggle-auction-form]");
  const submitAuctionBtn = e.target.closest("[data-rfq-submit-auction]");

  if (toggleAuctionBtn) {
    const rfqId = toggleAuctionBtn.dataset.rfqToggleAuctionForm;
    const container = document.querySelector(`[data-rfq-auction-form-container="${rfqId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    container.style.display = isHidden ? "block" : "none";
    toggleAuctionBtn.textContent = isHidden ? "ยกเลิก" : "🏆 เปิดประมูล (e-Auction)";
    return;
  }

  if (toggleBtn) {
    const rfqId = toggleBtn.dataset.rfqToggleQuotes;
    const container = document.querySelector(`[data-rfq-quotes-container="${rfqId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    if (!isHidden) {
      container.style.display = "none";
      toggleBtn.textContent = "ดูใบเสนอราคา";
      return;
    }
    container.style.display = "block";
    toggleBtn.textContent = "ซ่อนใบเสนอราคา";
    container.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
    try {
      const quotes = await AgroLinkBuyerAPI.get(`/procurement/rfqs/${rfqId}/quotes`);
      const rfq = rfqMineCache.find((r) => r.rfq_id === rfqId);
      const rfqStatus = rfq ? rfq.status : "open";
      container.innerHTML = quotes.length === 0
        ? `<div class="muted" style="font-size:12px; padding:8px 0;">ยังไม่มีใบเสนอราคา</div>`
        : quotes.map((q) => rfqQuoteRow(q, rfqId, rfqStatus)).join("");
    } catch (err) {
      container.innerHTML = `<div class="muted" style="font-size:12px;">โหลดใบเสนอราคาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    }
    return;
  }

  if (cancelBtn) {
    const rfqId = cancelBtn.dataset.rfqCancel;
    if (!confirm("ยืนยันยกเลิกประกาศนี้?")) return;
    cancelBtn.disabled = true;
    try {
      await AgroLinkBuyerAPI.post(`/procurement/rfqs/${rfqId}/cancel`, {});
      toast("ยกเลิกประกาศเรียบร้อยแล้ว");
      await loadRfqMine();
    } catch (err) {
      toast("ยกเลิกไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      cancelBtn.disabled = false;
    }
    return;
  }

  if (acceptBtn) {
    const quoteId = acceptBtn.dataset.rfqAcceptQuote;
    const rfqId = acceptBtn.dataset.rfqAcceptRfq;
    if (!confirm("ยืนยันยอมรับใบเสนอราคานี้? ใบเสนอราคาอื่นสำหรับประกาศนี้จะถูกปฏิเสธโดยอัตโนมัติ และระบบจะสร้างสัญญาอัตโนมัติทันที")) return;
    acceptBtn.disabled = true;
    try {
      await AgroLinkBuyerAPI.post(`/procurement/rfqs/${rfqId}/quotes/${quoteId}/accept`, {});
      toast("ยอมรับใบเสนอราคาเรียบร้อยแล้ว — สร้างสัญญาอัตโนมัติแล้ว");
      await loadRfqMine();
      await loadContractsMine();
    } catch (err) {
      toast("ยอมรับไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      acceptBtn.disabled = false;
    }
    return;
  }

  if (submitAuctionBtn) {
    const rfqId = submitAuctionBtn.dataset.rfqSubmitAuction;
    const closesAtInput = document.querySelector(`[data-rfq-auction-closes-at="${rfqId}"]`);
    const closesAtValue = closesAtInput ? closesAtInput.value : "";
    if (!closesAtValue) {
      toast("กรุณาเลือกวัน-เวลาปิดรับราคา", true);
      return;
    }
    const closesAtDate = new Date(closesAtValue);
    if (Number.isNaN(closesAtDate.getTime()) || closesAtDate.getTime() <= Date.now()) {
      toast("วัน-เวลาปิดรับราคาต้องเป็นเวลาในอนาคต", true);
      return;
    }
    submitAuctionBtn.disabled = true;
    try {
      await AgroLinkBuyerAPI.post("/procurement/auctions", {
        rfq_id: rfqId,
        closes_at: closesAtDate.toISOString(),
      });
      toast("เปิดการประมูลเรียบร้อยแล้ว");
      await loadAuctionsMine();
      await loadRfqMine();
    } catch (err) {
      toast("เปิดประมูลไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      submitAuctionBtn.disabled = false;
    }
  }
});

document.getElementById("rfqPostForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("rfqPostSubmitBtn");
  const payload = {
    category: document.getElementById("rfqCategorySelect").value,
    title: document.getElementById("rfqTitleInput").value.trim(),
    description: document.getElementById("rfqDescriptionInput").value.trim() || null,
    quantity: document.getElementById("rfqQuantityInput").value ? Number(document.getElementById("rfqQuantityInput").value) : null,
    quantity_unit: document.getElementById("rfqQuantityUnitInput").value.trim() || null,
    target_price: document.getElementById("rfqTargetPriceInput").value ? Number(document.getElementById("rfqTargetPriceInput").value) : null,
    delivery_location: document.getElementById("rfqDeliveryLocationInput").value.trim() || null,
    needed_by_date: document.getElementById("rfqNeededByInput").value || null,
  };
  if (!payload.title) {
    toast("กรุณากรอกหัวข้อ", true);
    return;
  }
  btn.disabled = true;
  try {
    await AgroLinkBuyerAPI.post("/procurement/rfqs", payload);
    toast("ประกาศความต้องการเรียบร้อยแล้ว");
    document.getElementById("rfqPostForm").reset();
    await loadRfqMine();
  } catch (err) {
    toast("ประกาศไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
  } finally {
    btn.disabled = false;
  }
});

function rfqBrowseCard(r) {
  const badgeClass = RFQ_STATUS_BADGE_CLASS[r.status] || "status-pending";
  const showQuoteForm = rfqIsOrganization && r.status === "open";
  return `
    <div class="item-card" data-rfq-id="${r.rfq_id}">
      <div class="row">
        <span class="title">${escapeHtml(r.title)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(RFQ_STATUS_LABEL_TH[r.status] || r.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(RFQ_CATEGORY_LABEL_TH[r.category] || r.category)} · โดย ${escapeHtml(r.requester_name || "-")}</div>
      ${r.description ? `<div class="detail-line muted">${escapeHtml(r.description)}</div>` : ""}
      <div class="detail-line muted">${rfqMetaLine(r)}</div>
      ${showQuoteForm ? `
        <div class="action-row">
          <button type="button" class="btn btn-ghost btn-sm" data-rfq-toggle-quote-form="${r.rfq_id}">เสนอราคา</button>
        </div>
        <div data-rfq-quote-form-container="${r.rfq_id}" style="display:none; margin-top:8px;">
          <div class="form-grid">
            <div class="field">
              <label>ราคาที่เสนอ (บาท)</label>
              <input type="number" min="0.01" step="0.01" data-rfq-quote-price="${r.rfq_id}" />
            </div>
            <div class="field">
              <label>จำนวนที่เสนอ (ถ้ามี)</label>
              <input type="number" min="0.01" step="0.01" data-rfq-quote-qty="${r.rfq_id}" />
            </div>
            <div class="field full">
              <label>ข้อความเพิ่มเติม</label>
              <input type="text" data-rfq-quote-message="${r.rfq_id}" />
            </div>
          </div>
          <div class="action-row">
            <button type="button" class="btn btn-primary btn-sm" data-rfq-submit-quote="${r.rfq_id}">ส่งใบเสนอราคา</button>
          </div>
        </div>
      ` : ""}
    </div>
  `;
}

async function loadRfqBrowse() {
  const el = document.getElementById("rfqBrowseSection");
  const category = document.getElementById("rfqBrowseCategoryFilter").value;
  el.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const query = category ? `?category=${encodeURIComponent(category)}` : "";
    const list = await AgroLinkBuyerAPI.get(`/procurement/rfqs${query}`);
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ไม่มีประกาศที่เปิดอยู่ในขณะนี้</div>`
      : list.map(rfqBrowseCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประกาศไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("rfqBrowseCategoryFilter").addEventListener("change", () => loadRfqBrowse());

document.getElementById("rfqBrowseSection").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-rfq-toggle-quote-form]");
  const submitBtn = e.target.closest("[data-rfq-submit-quote]");

  if (toggleBtn) {
    const rfqId = toggleBtn.dataset.rfqToggleQuoteForm;
    const container = document.querySelector(`[data-rfq-quote-form-container="${rfqId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    container.style.display = isHidden ? "block" : "none";
    toggleBtn.textContent = isHidden ? "ยกเลิก" : "เสนอราคา";
    return;
  }

  if (submitBtn) {
    const rfqId = submitBtn.dataset.rfqSubmitQuote;
    const priceInput = document.querySelector(`[data-rfq-quote-price="${rfqId}"]`);
    const qtyInput = document.querySelector(`[data-rfq-quote-qty="${rfqId}"]`);
    const messageInput = document.querySelector(`[data-rfq-quote-message="${rfqId}"]`);
    const price = priceInput ? Number(priceInput.value) : NaN;
    if (!Number.isFinite(price) || price <= 0) {
      toast("กรุณากรอกราคาที่เสนอให้ถูกต้อง", true);
      return;
    }
    submitBtn.disabled = true;
    try {
      await AgroLinkBuyerAPI.post(`/procurement/rfqs/${rfqId}/quotes`, {
        quoted_price: price,
        quoted_quantity: qtyInput && qtyInput.value ? Number(qtyInput.value) : null,
        message: messageInput && messageInput.value.trim() ? messageInput.value.trim() : null,
      });
      toast("ส่งใบเสนอราคาเรียบร้อยแล้ว");
      await loadRfqBrowse();
      await loadRfqMyQuotes();
    } catch (err) {
      toast("ส่งใบเสนอราคาไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      submitBtn.disabled = false;
    }
  }
});

function rfqMyQuoteCard(q) {
  const badgeClass = RFQ_QUOTE_STATUS_BADGE_CLASS[q.status] || "status-pending";
  return `
    <div class="item-card" data-quote-id="${q.quote_id}">
      <div class="row">
        <span class="title">${escapeHtml(q.rfq_title)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(RFQ_QUOTE_STATUS_LABEL_TH[q.status] || q.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(RFQ_CATEGORY_LABEL_TH[q.rfq_category] || q.rfq_category)} · ผู้ประกาศ ${escapeHtml(q.rfq_requester_name || "-")}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">
        เสนอ ${rfqMoney(q.quoted_price)} ${escapeHtml(q.price_unit)}${q.quoted_quantity ? ` · จำนวน ${rfqMoney(q.quoted_quantity)}` : ""}
      </div>
      ${q.message ? `<div class="detail-line muted">${escapeHtml(q.message)}</div>` : ""}
      <div class="detail-line muted">เสนอเมื่อ ${thaiDate(q.submitted_at)}</div>
      ${q.status === "submitted" ? `
        <div class="action-row">
          <button type="button" class="btn btn-decline btn-sm" data-rfq-withdraw-quote="${q.quote_id}">ถอนใบเสนอราคา</button>
        </div>
      ` : ""}
    </div>
  `;
}

async function loadRfqMyQuotes() {
  if (!rfqIsOrganization) return;
  const el = document.getElementById("rfqMyQuotesSection");
  const status = document.getElementById("rfqMyQuotesStatusFilter").value;
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const list = await AgroLinkBuyerAPI.get(`/procurement/quotes/mine${query}`);
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ท่านยังไม่เคยเสนอราคา</div>`
      : list.map(rfqMyQuoteCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดใบเสนอราคาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("rfqMyQuotesStatusFilter").addEventListener("change", () => loadRfqMyQuotes());

document.getElementById("rfqMyQuotesSection").addEventListener("click", async (e) => {
  const withdrawBtn = e.target.closest("[data-rfq-withdraw-quote]");
  if (withdrawBtn) {
    const quoteId = withdrawBtn.dataset.rfqWithdrawQuote;
    if (!confirm("ยืนยันถอนใบเสนอราคานี้?")) return;
    withdrawBtn.disabled = true;
    try {
      await AgroLinkBuyerAPI.post(`/procurement/quotes/${quoteId}/withdraw`, {});
      toast("ถอนใบเสนอราคาเรียบร้อยแล้ว");
      await loadRfqMyQuotes();
    } catch (err) {
      toast("ถอนไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      withdrawBtn.disabled = false;
    }
  }
});

function auctionBidRow(b, isWinner) {
  return `
    <div class="item-card" style="margin-top:8px;${isWinner ? " border-color:var(--green-700);" : ""}">
      <div class="row">
        <span class="title">${escapeHtml(b.bidder_org_name)}${isWinner ? " 🏆 ผู้ชนะ" : ""}</span>
        <span style="font-weight:700; color:var(--green-900);">${rfqMoney(b.bid_price)} บาท</span>
      </div>
      ${b.bid_quantity ? `<div class="detail-line muted">จำนวนที่เสนอ ${rfqMoney(b.bid_quantity)}</div>` : ""}
      ${b.message ? `<div class="detail-line muted">${escapeHtml(b.message)}</div>` : ""}
      <div class="detail-line muted">เสนอเมื่อ ${thaiDate(b.submitted_at)}</div>
    </div>
  `;
}

function auctionMineCard(a) {
  const badgeClass = AUCTION_STATUS_BADGE_CLASS[a.status] || "status-pending";
  const lowestText = a.current_lowest_bid
    ? `ราคาต่ำสุดขณะนี้ ${rfqMoney(a.current_lowest_bid)} บาท (มีผู้เสนอราคา ${a.bid_count} ราย)`
    : "ยังไม่มีผู้เสนอราคา";
  return `
    <div class="item-card" data-auction-id="${a.auction_id}">
      <div class="row">
        <span class="title">${escapeHtml(a.title)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(AUCTION_STATUS_LABEL_TH[a.status] || a.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(RFQ_CATEGORY_LABEL_TH[a.category] || a.category)}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">${lowestText}</div>
      <div class="detail-line muted">${a.status === "open" ? "ปิดรับราคาภายใน" : "ปิดเมื่อ"} ${thaiDate(a.status === "open" ? a.closes_at : a.closed_at)}</div>
      <div class="action-row">
        <button type="button" class="btn btn-ghost btn-sm" data-auction-toggle-bids="${a.auction_id}">ดูผู้เสนอราคาทั้งหมด</button>
        ${a.status === "open" ? `<button type="button" class="btn btn-decline btn-sm" data-auction-close="${a.auction_id}">ปิดประมูลตอนนี้</button>` : ""}
      </div>
      <div data-auction-bids-container="${a.auction_id}" style="display:none;"></div>
    </div>
  `;
}

async function loadAuctionsMine() {
  const el = document.getElementById("auctionMineSection");
  try {
    const list = await AgroLinkBuyerAPI.get("/procurement/auctions/mine");
    auctionMineCache = list;
    auctionMineByRfqId = new Map(list.map((a) => [a.rfq_id, a]));
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ท่านยังไม่เคยเปิดประมูล — เปิดได้จากปุ่ม "เปิดประมูล (e-Auction)" บนประกาศ RFQ ของท่านด้านบน (ต้องมีสถานะ "เปิดรับใบเสนอราคา")</div>`
      : list.map(auctionMineCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการประมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("auctionMineSection").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-auction-toggle-bids]");
  const closeBtn = e.target.closest("[data-auction-close]");

  if (toggleBtn) {
    const auctionId = toggleBtn.dataset.auctionToggleBids;
    const container = document.querySelector(`[data-auction-bids-container="${auctionId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    if (!isHidden) {
      container.style.display = "none";
      toggleBtn.textContent = "ดูผู้เสนอราคาทั้งหมด";
      return;
    }
    container.style.display = "block";
    toggleBtn.textContent = "ซ่อนผู้เสนอราคา";
    container.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
    try {
      const bids = await AgroLinkBuyerAPI.get(`/procurement/auctions/${auctionId}/bids`);
      const auction = auctionMineCache.find((a) => a.auction_id === auctionId);
      const winningBidId = auction ? auction.winning_bid_id : null;
      container.innerHTML = bids.length === 0
        ? `<div class="muted" style="font-size:12px; padding:8px 0;">ยังไม่มีผู้เสนอราคา</div>`
        : bids.map((b) => auctionBidRow(b, b.bid_id === winningBidId)).join("");
    } catch (err) {
      container.innerHTML = `<div class="muted" style="font-size:12px;">โหลดผู้เสนอราคาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    }
    return;
  }

  if (closeBtn) {
    const auctionId = closeBtn.dataset.auctionClose;
    if (!confirm("ยืนยันปิดประมูลตอนนี้? ผู้เสนอราคาต่ำสุด ณ ขณะนี้จะได้รับเลือกทันทีและระบบจะสร้างสัญญาอัตโนมัติ")) return;
    closeBtn.disabled = true;
    try {
      await AgroLinkBuyerAPI.post(`/procurement/auctions/${auctionId}/close`, {});
      toast("ปิดประมูลเรียบร้อยแล้ว");
      await loadAuctionsMine();
      await loadRfqMine();
      await loadContractsMine();
    } catch (err) {
      toast("ปิดประมูลไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      closeBtn.disabled = false;
    }
  }
});

function auctionBrowseCard(a) {
  const badgeClass = AUCTION_STATUS_BADGE_CLASS[a.status] || "status-pending";
  const lowestText = a.current_lowest_bid
    ? `ราคาต่ำสุดขณะนี้ ${rfqMoney(a.current_lowest_bid)} บาท (มีผู้เสนอราคา ${a.bid_count} ราย) — ต้องเสนอราคาต่ำกว่านี้`
    : "ยังไม่มีผู้เสนอราคา — เสนอราคาใดก็ได้ที่มากกว่า 0";
  const showBidForm = rfqIsOrganization && a.status === "open";
  return `
    <div class="item-card" data-auction-id="${a.auction_id}">
      <div class="row">
        <span class="title">${escapeHtml(a.title)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(AUCTION_STATUS_LABEL_TH[a.status] || a.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(RFQ_CATEGORY_LABEL_TH[a.category] || a.category)} · โดย ${escapeHtml(a.requester_name || "-")}</div>
      ${a.quantity ? `<div class="detail-line muted">จำนวน ${rfqMoney(a.quantity)} ${escapeHtml(a.quantity_unit || "")}</div>` : ""}
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">${lowestText}</div>
      <div class="detail-line muted">ปิดรับราคาภายใน ${thaiDate(a.closes_at)}</div>
      ${showBidForm ? `
        <div class="action-row">
          <button type="button" class="btn btn-ghost btn-sm" data-toggle-bid-form="${a.auction_id}">เสนอราคาแข่งขัน</button>
        </div>
        <div data-bid-form-container="${a.auction_id}" style="display:none; margin-top:8px;">
          <div class="form-grid">
            <div class="field">
              <label>ราคาที่เสนอ (บาท) — ต้องต่ำกว่าราคาต่ำสุดปัจจุบัน</label>
              <input type="number" min="0.01" step="0.01" data-bid-price="${a.auction_id}" />
            </div>
            <div class="field">
              <label>จำนวนที่เสนอ (ถ้ามี)</label>
              <input type="number" min="0.01" step="0.01" data-bid-qty="${a.auction_id}" />
            </div>
            <div class="field full">
              <label>ข้อความเพิ่มเติม</label>
              <input type="text" data-bid-message="${a.auction_id}" />
            </div>
          </div>
          <div class="action-row">
            <button type="button" class="btn btn-primary btn-sm" data-submit-bid="${a.auction_id}">ส่งราคาเสนอ</button>
          </div>
        </div>
      ` : ""}
    </div>
  `;
}

async function loadAuctionsBrowse() {
  const el = document.getElementById("auctionBrowseSection");
  el.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const list = await AgroLinkBuyerAPI.get("/procurement/auctions?status=open");
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ไม่มีการประมูลที่เปิดอยู่ในขณะนี้</div>`
      : list.map(auctionBrowseCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการประมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("auctionBrowseSection").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-toggle-bid-form]");
  const submitBtn = e.target.closest("[data-submit-bid]");

  if (toggleBtn) {
    const auctionId = toggleBtn.dataset.toggleBidForm;
    const container = document.querySelector(`[data-bid-form-container="${auctionId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    container.style.display = isHidden ? "block" : "none";
    toggleBtn.textContent = isHidden ? "ยกเลิก" : "เสนอราคาแข่งขัน";
    return;
  }

  if (submitBtn) {
    const auctionId = submitBtn.dataset.submitBid;
    const priceInput = document.querySelector(`[data-bid-price="${auctionId}"]`);
    const qtyInput = document.querySelector(`[data-bid-qty="${auctionId}"]`);
    const messageInput = document.querySelector(`[data-bid-message="${auctionId}"]`);
    const price = priceInput ? Number(priceInput.value) : NaN;
    if (!Number.isFinite(price) || price <= 0) {
      toast("กรุณากรอกราคาที่เสนอให้ถูกต้อง", true);
      return;
    }
    submitBtn.disabled = true;
    try {
      await AgroLinkBuyerAPI.post(`/procurement/auctions/${auctionId}/bids`, {
        bid_price: price,
        bid_quantity: qtyInput && qtyInput.value ? Number(qtyInput.value) : null,
        message: messageInput && messageInput.value.trim() ? messageInput.value.trim() : null,
      });
      toast("ส่งราคาเสนอเรียบร้อยแล้ว");
      await loadAuctionsBrowse();
    } catch (err) {
      const errCode = (err.body && err.body.error) || err.message;
      let msg = errCode;
      if (errCode === "bid_not_competitive") {
        msg = `ราคาที่เสนอต้องต่ำกว่า ${rfqMoney(err.body.current_lowest_bid)} บาท`;
      } else if (errCode === "kyb_not_verified") {
        msg = "องค์กรของท่านยังไม่ผ่านการยืนยัน KYB จึงยังเสนอราคาไม่ได้";
      } else if (errCode === "auction_not_open") {
        msg = "การประมูลนี้ปิดรับราคาแล้ว";
      }
      toast("เสนอราคาไม่สำเร็จ: " + msg, true);
      submitBtn.disabled = false;
    }
  }
});

// -- Purchase Order (issued against an active contract — see
// procurement.create_contract_from_award) --

function contractPoCard(c) {
  const canIssue = c.status === "active" && PO_ISSUER_ROLES_CLIENT.includes(c.party_role);
  return `
    <div class="item-card" data-contract-id="${c.contract_id}">
      <div class="row">
        <span class="title">${escapeHtml(c.rfq_title || CONTRACT_TYPE_LABEL_TH[c.contract_type] || c.contract_type)}</span>
        <span class="badge ${c.status === "active" ? "status-approved" : "status-pending"}">${escapeHtml(c.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(CONTRACT_TYPE_LABEL_TH[c.contract_type] || c.contract_type)} · บทบาทของท่าน: ${escapeHtml(CONTRACT_ROLE_LABEL_TH[c.party_role] || c.party_role)}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">
        จำนวน ${rfqMoney(c.agreed_quantity)} ${escapeHtml(c.quantity_unit || "")} · ราคาต่อหน่วย ${rfqMoney(c.agreed_unit_price)} บาท
      </div>
      ${c.terms_summary ? `<div class="detail-line muted">${escapeHtml(c.terms_summary)}</div>` : ""}
      <div class="detail-line muted">เริ่มมีผลเมื่อ ${rfqThaiDateOnly(c.effective_date)}</div>
      ${canIssue ? `
        <div class="action-row">
          <button type="button" class="btn btn-primary btn-sm" data-toggle-po-form="${c.contract_id}">ออกใบสั่งซื้อ (PO)</button>
        </div>
        <div data-po-form-container="${c.contract_id}" style="display:none; margin-top:8px;">
          <div class="form-grid">
            <div class="field">
              <label>จำนวน</label>
              <input type="number" min="0.01" step="0.01" data-po-quantity="${c.contract_id}" value="${c.agreed_quantity || ""}" />
            </div>
            <div class="field">
              <label>หน่วยนับ</label>
              <input type="text" data-po-qty-unit="${c.contract_id}" value="${escapeHtml(c.quantity_unit || "")}" />
            </div>
            <div class="field">
              <label>ราคาต่อหน่วย (บาท)</label>
              <input type="number" min="0.01" step="0.01" data-po-unit-price="${c.contract_id}" value="${c.agreed_unit_price || ""}" />
            </div>
            <div class="field">
              <label>สถานที่ส่งมอบ</label>
              <input type="text" data-po-delivery="${c.contract_id}" />
            </div>
            <div class="field">
              <label>ต้องการภายในวันที่</label>
              <input type="date" data-po-needed-by="${c.contract_id}" />
            </div>
            <div class="field full">
              <label>หมายเหตุ</label>
              <input type="text" data-po-notes="${c.contract_id}" />
            </div>
          </div>
          <div class="action-row">
            <button type="button" class="btn btn-primary btn-sm" data-submit-po="${c.contract_id}">ยืนยันออกใบสั่งซื้อ</button>
          </div>
        </div>
      ` : ""}
    </div>
  `;
}

async function loadContractsMine() {
  const el = document.getElementById("contractsMineSection");
  try {
    const list = await AgroLinkBuyerAPI.get("/procurement/contracts/mine");
    contractsMineCache = list;
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ยังไม่มีสัญญา — สัญญาจะถูกสร้างอัตโนมัติเมื่อประกาศ RFQ ของท่านได้รับการตกลง (ยอมรับใบเสนอราคา หรือ ปิดประมูล e-Auction)</div>`
      : list.map(contractPoCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการสัญญาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("contractsMineSection").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-toggle-po-form]");
  const submitBtn = e.target.closest("[data-submit-po]");

  if (toggleBtn) {
    const contractId = toggleBtn.dataset.togglePoForm;
    const container = document.querySelector(`[data-po-form-container="${contractId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    container.style.display = isHidden ? "block" : "none";
    toggleBtn.textContent = isHidden ? "ยกเลิก" : "ออกใบสั่งซื้อ (PO)";
    return;
  }

  if (submitBtn) {
    const contractId = submitBtn.dataset.submitPo;
    const qty = Number(document.querySelector(`[data-po-quantity="${contractId}"]`).value);
    const unitPrice = Number(document.querySelector(`[data-po-unit-price="${contractId}"]`).value);
    const qtyUnit = document.querySelector(`[data-po-qty-unit="${contractId}"]`).value.trim();
    const delivery = document.querySelector(`[data-po-delivery="${contractId}"]`).value.trim();
    const neededBy = document.querySelector(`[data-po-needed-by="${contractId}"]`).value;
    const notes = document.querySelector(`[data-po-notes="${contractId}"]`).value.trim();
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitPrice) || unitPrice <= 0) {
      toast("กรุณากรอกจำนวนและราคาต่อหน่วยให้ถูกต้อง", true);
      return;
    }
    submitBtn.disabled = true;
    try {
      await AgroLinkBuyerAPI.post("/procurement/purchase-orders", {
        contract_id: contractId,
        quantity: qty,
        quantity_unit: qtyUnit || null,
        unit_price: unitPrice,
        delivery_location: delivery || null,
        needed_by_date: neededBy || null,
        notes: notes || null,
      });
      toast("ออกใบสั่งซื้อเรียบร้อยแล้ว");
      await loadPurchaseOrdersMine();
    } catch (err) {
      toast("ออกใบสั่งซื้อไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
    } finally {
      submitBtn.disabled = false;
    }
  }
});

// Keyed by po_id — populated by loadPurchaseOrdersMine() alongside the PO
// list itself, so poCard() can render each PO's GRN and Invoice state
// inline without a per-card round trip. No revenue-share section on this
// portal — that's cooperative-only (only a coop has member farmers to
// split sale proceeds back to); a Buyer org just pays invoices.
let grnByPoCache = {};
let invoiceByPoCache = {};

function grnAndInvoiceSectionHtml(p, isIssuer) {
  const grn = grnByPoCache[p.po_id];
  const invoice = invoiceByPoCache[p.po_id];
  const parts = [];

  // GRN: recorded by whoever ISSUED the PO, once it's been acknowledged.
  if (!grn) {
    if (isIssuer && p.status === "acknowledged") {
      parts.push(`
        <div class="sub-panel" style="margin-top:8px; padding:10px; border:1px dashed var(--gray-300); border-radius:8px;">
          <div class="detail-line" style="font-weight:700;">บันทึกการรับสินค้า (GRN)</div>
          <div class="form-grid">
            <div class="field">
              <label>จำนวนที่ได้รับจริง</label>
              <input type="number" min="0.01" step="0.01" data-grn-received="${p.po_id}" value="${p.quantity}" />
            </div>
            <div class="field">
              <label>จำนวนที่ยอมรับ</label>
              <input type="number" min="0" step="0.01" data-grn-accepted="${p.po_id}" value="${p.quantity}" />
            </div>
            <div class="field">
              <label>จำนวนที่ปฏิเสธ (ถ้ามี)</label>
              <input type="number" min="0" step="0.01" data-grn-rejected="${p.po_id}" value="0" />
            </div>
            <div class="field full">
              <label>เหตุผลที่ปฏิเสธ (ถ้ามี)</label>
              <input type="text" data-grn-rejection-reason="${p.po_id}" />
            </div>
          </div>
          <div class="action-row">
            <button type="button" class="btn btn-primary btn-sm" data-grn-submit="${p.po_id}">บันทึกการรับสินค้า</button>
          </div>
        </div>
      `);
    }
    return parts.join("");
  }

  parts.push(`
    <div class="detail-line" style="margin-top:6px;">
      📥 รับสินค้าแล้ว: ยอมรับ ${rfqMoney(grn.accepted_quantity)}${grn.rejected_quantity > 0 ? ` · ปฏิเสธ ${rfqMoney(grn.rejected_quantity)}` : ""}
      จากที่ส่งมอบ ${rfqMoney(grn.received_quantity)} (${thaiDate(grn.received_at)})
      ${grn.rejection_reason ? `<br/><span class="muted">เหตุผล: ${escapeHtml(grn.rejection_reason)}</span>` : ""}
    </div>
  `);

  // Invoice: issued by the SELLER side (the non-issuer party), once a GRN
  // with some accepted quantity exists.
  if (!invoice) {
    if (!isIssuer && Number(grn.accepted_quantity) > 0) {
      const previewAmount = Number(grn.accepted_quantity) * Number(p.unit_price);
      parts.push(`
        <div class="sub-panel" style="margin-top:8px; padding:10px; border:1px dashed var(--gray-300); border-radius:8px;">
          <div class="detail-line">ยอดใบแจ้งหนี้โดยประมาณ: <strong>${rfqMoney(previewAmount)} บาท</strong> (${rfqMoney(grn.accepted_quantity)} × ${rfqMoney(p.unit_price)})</div>
          <div class="action-row">
            <button type="button" class="btn btn-primary btn-sm" data-invoice-issue="${p.po_id}">ออกใบแจ้งหนี้</button>
          </div>
        </div>
      `);
    }
    return parts.join("");
  }

  const invBadge = INVOICE_STATUS_BADGE_CLASS[invoice.status] || "status-pending";
  parts.push(`
    <div class="detail-line" style="margin-top:6px; font-weight:700;">
      🧾 ${escapeHtml(invoice.invoice_no)}
      <span class="badge ${invBadge}">${escapeHtml(INVOICE_STATUS_LABEL_TH[invoice.status] || invoice.status)}</span>
      — ${rfqMoney(invoice.amount)} บาท
    </div>
    ${invoice.dispute_reason ? `<div class="detail-line muted">ข้อโต้แย้ง: ${escapeHtml(invoice.dispute_reason)}</div>` : ""}
  `);

  if (invoice.status === "issued") {
    if (isIssuer) {
      parts.push(`
        <div class="action-row">
          <button type="button" class="btn btn-approve btn-sm" data-invoice-pay="${invoice.invoice_id}">ชำระเงิน</button>
          <button type="button" class="btn btn-decline btn-sm" data-invoice-dispute="${invoice.invoice_id}">โต้แย้งใบแจ้งหนี้</button>
        </div>
      `);
    } else {
      parts.push(`
        <div class="action-row">
          <button type="button" class="btn btn-decline btn-sm" data-invoice-cancel="${invoice.invoice_id}">ยกเลิกใบแจ้งหนี้</button>
        </div>
      `);
    }
  }

  return parts.join("");
}

function poCard(p) {
  const badgeClass = PO_STATUS_BADGE_CLASS[p.status] || "status-pending";
  const session = AgroLinkBuyerAPI.getSession();
  const isIssuer = !!(session && p.issued_by_subject_type === session.subject_type && p.issued_by_subject_id === session.subject_id);
  const canAcknowledge = !isIssuer && p.status === "issued";
  const canCancel = ["issued", "acknowledged"].includes(p.status);
  return `
    <div class="item-card" data-po-id="${p.po_id}">
      <div class="row">
        <span class="title">${escapeHtml(p.po_number)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(PO_STATUS_LABEL_TH[p.status] || p.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(CONTRACT_TYPE_LABEL_TH[p.contract_type] || p.contract_type)}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">
        ${rfqMoney(p.quantity)} ${escapeHtml(p.quantity_unit || "")} × ${rfqMoney(p.unit_price)} บาท = ${rfqMoney(p.total_amount)} บาท
      </div>
      ${p.delivery_location ? `<div class="detail-line muted">ส่งที่ ${escapeHtml(p.delivery_location)}</div>` : ""}
      ${p.needed_by_date ? `<div class="detail-line muted">ต้องการภายใน ${rfqThaiDateOnly(p.needed_by_date)}</div>` : ""}
      ${p.notes ? `<div class="detail-line muted">${escapeHtml(p.notes)}</div>` : ""}
      <div class="detail-line muted">ออกเมื่อ ${thaiDate(p.issued_at)}${p.acknowledged_at ? ` · ตอบรับเมื่อ ${thaiDate(p.acknowledged_at)}` : ""}</div>
      ${(canAcknowledge || canCancel) ? `
        <div class="action-row">
          ${canAcknowledge ? `<button type="button" class="btn btn-approve btn-sm" data-po-acknowledge="${p.po_id}">รับทราบใบสั่งซื้อ</button>` : ""}
          ${canCancel ? `<button type="button" class="btn btn-decline btn-sm" data-po-cancel="${p.po_id}">ยกเลิกใบสั่งซื้อ</button>` : ""}
        </div>
      ` : ""}
      ${["acknowledged", "in_fulfillment", "completed"].includes(p.status) ? grnAndInvoiceSectionHtml(p, isIssuer) : ""}
    </div>
  `;
}

async function loadPurchaseOrdersMine() {
  const el = document.getElementById("purchaseOrdersMineSection");
  try {
    const [list, grns, invoices] = await Promise.all([
      AgroLinkBuyerAPI.get("/procurement/purchase-orders/mine"),
      AgroLinkBuyerAPI.get("/procurement/goods-receipts/mine"),
      AgroLinkBuyerAPI.get("/procurement/invoices/mine"),
    ]);
    grnByPoCache = Object.fromEntries(grns.map((g) => [g.po_id, g]));
    invoiceByPoCache = Object.fromEntries(invoices.map((i) => [i.po_id, i]));
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ยังไม่มีใบสั่งซื้อ</div>`
      : list.map(poCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดใบสั่งซื้อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("purchaseOrdersMineSection").addEventListener("click", async (e) => {
  const ackBtn = e.target.closest("[data-po-acknowledge]");
  const cancelBtn = e.target.closest("[data-po-cancel]");
  const grnSubmitBtn = e.target.closest("[data-grn-submit]");
  const invoiceIssueBtn = e.target.closest("[data-invoice-issue]");
  const invoicePayBtn = e.target.closest("[data-invoice-pay]");
  const invoiceDisputeBtn = e.target.closest("[data-invoice-dispute]");
  const invoiceCancelBtn = e.target.closest("[data-invoice-cancel]");

  if (ackBtn) {
    const poId = ackBtn.dataset.poAcknowledge;
    if (!confirm("ยืนยันรับทราบใบสั่งซื้อนี้?")) return;
    ackBtn.disabled = true;
    try {
      await AgroLinkBuyerAPI.post(`/procurement/purchase-orders/${poId}/acknowledge`, {});
      toast("รับทราบใบสั่งซื้อเรียบร้อยแล้ว");
      await loadPurchaseOrdersMine();
    } catch (err) {
      toast("รับทราบไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      ackBtn.disabled = false;
    }
    return;
  }

  if (cancelBtn) {
    const poId = cancelBtn.dataset.poCancel;
    if (!confirm("ยืนยันยกเลิกใบสั่งซื้อนี้?")) return;
    cancelBtn.disabled = true;
    try {
      await AgroLinkBuyerAPI.post(`/procurement/purchase-orders/${poId}/cancel`, {});
      toast("ยกเลิกใบสั่งซื้อเรียบร้อยแล้ว");
      await loadPurchaseOrdersMine();
    } catch (err) {
      toast("ยกเลิกไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      cancelBtn.disabled = false;
    }
    return;
  }

  if (grnSubmitBtn) {
    const poId = grnSubmitBtn.dataset.grnSubmit;
    const received = Number(document.querySelector(`[data-grn-received="${poId}"]`).value);
    const accepted = Number(document.querySelector(`[data-grn-accepted="${poId}"]`).value);
    const rejected = Number(document.querySelector(`[data-grn-rejected="${poId}"]`).value || 0);
    const reason = document.querySelector(`[data-grn-rejection-reason="${poId}"]`).value.trim();
    if (!Number.isFinite(received) || received <= 0 || !Number.isFinite(accepted) || accepted < 0) {
      toast("กรุณากรอกจำนวนที่รับและยอมรับให้ถูกต้อง", true);
      return;
    }
    grnSubmitBtn.disabled = true;
    try {
      await AgroLinkBuyerAPI.post("/procurement/goods-receipts", {
        po_id: poId, received_quantity: received, accepted_quantity: accepted,
        rejected_quantity: rejected, rejection_reason: reason || null,
      });
      toast("บันทึกการรับสินค้าเรียบร้อยแล้ว");
      await loadPurchaseOrdersMine();
    } catch (err) {
      toast("บันทึกไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      grnSubmitBtn.disabled = false;
    }
    return;
  }

  if (invoiceIssueBtn) {
    const poId = invoiceIssueBtn.dataset.invoiceIssue;
    invoiceIssueBtn.disabled = true;
    try {
      await AgroLinkBuyerAPI.post("/procurement/invoices", { po_id: poId });
      toast("ออกใบแจ้งหนี้เรียบร้อยแล้ว");
      await loadPurchaseOrdersMine();
    } catch (err) {
      toast("ออกใบแจ้งหนี้ไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      invoiceIssueBtn.disabled = false;
    }
    return;
  }

  if (invoicePayBtn) {
    const invoiceId = invoicePayBtn.dataset.invoicePay;
    if (!confirm("ยืนยันชำระเงินใบแจ้งหนี้นี้?")) return;
    invoicePayBtn.disabled = true;
    try {
      await AgroLinkBuyerAPI.post(`/procurement/invoices/${invoiceId}/pay`, {});
      toast("ชำระเงินเรียบร้อยแล้ว");
      await loadPurchaseOrdersMine();
    } catch (err) {
      toast("ชำระเงินไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      invoicePayBtn.disabled = false;
    }
    return;
  }

  if (invoiceDisputeBtn) {
    const invoiceId = invoiceDisputeBtn.dataset.invoiceDispute;
    const reason = prompt("เหตุผลในการโต้แย้งใบแจ้งหนี้นี้ (ถ้ามี):") || "";
    invoiceDisputeBtn.disabled = true;
    try {
      await AgroLinkBuyerAPI.post(`/procurement/invoices/${invoiceId}/dispute`, { reason: reason.trim() || null });
      toast("บันทึกข้อโต้แย้งเรียบร้อยแล้ว");
      await loadPurchaseOrdersMine();
    } catch (err) {
      toast("บันทึกไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      invoiceDisputeBtn.disabled = false;
    }
    return;
  }

  if (invoiceCancelBtn) {
    const invoiceId = invoiceCancelBtn.dataset.invoiceCancel;
    if (!confirm("ยืนยันยกเลิกใบแจ้งหนี้นี้?")) return;
    invoiceCancelBtn.disabled = true;
    try {
      await AgroLinkBuyerAPI.post(`/procurement/invoices/${invoiceId}/cancel`, {});
      toast("ยกเลิกใบแจ้งหนี้เรียบร้อยแล้ว");
      await loadPurchaseOrdersMine();
    } catch (err) {
      toast("ยกเลิกไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      invoiceCancelBtn.disabled = false;
    }
  }
});

async function refreshRfq() {
  const session = AgroLinkBuyerAPI.getSession();
  rfqIsOrganization = !!(session && session.subject_type === "organization");
  if (!rfqIsOrganization) {
    document.getElementById("rfqMyQuotesTitle").style.display = "none";
    document.getElementById("rfqMyQuotesFilterRow").style.display = "none";
    document.getElementById("rfqMyQuotesSection").style.display = "none";
  }
  // auctionMineByRfqId must be populated BEFORE rfqMineCard() renders, so
  // load it first rather than folding it into the Promise.all below.
  await loadAuctionsMine();
  await Promise.all([
    loadRfqMine(),
    loadRfqBrowse(),
    loadAuctionsBrowse(),
    loadContractsMine(),
    loadPurchaseOrdersMine(),
  ]);
  if (rfqIsOrganization) await loadRfqMyQuotes();
}

async function init() {
  const session = AgroLinkBuyerAPI.requireSessionOrRedirect();
  if (!session) return;

  try {
    const d = await AgroLinkBuyerAPI.get("/buyer/dashboard");
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

  loadDeliveryReviewQueue();
  loadDeliveryHistory();
  loadProductionUnits();
  loadCommodities();
  loadPriceQuotes();
  loadContracts();
  loadCoopSuppliersIntoFilter();
  loadCoopCatalog();
  loadCoopOrderHistory();
  refreshRfq();
}

init();
