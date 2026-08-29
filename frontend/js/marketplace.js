/**
 * AgroLink — ตลาดปัจจัยการผลิต (marketplace.html).
 *
 * Backs GET /farmer/input-suppliers, GET /farmer/products, POST/GET
 * /farmer/orders, and POST /farmer/orders/:id/cancel. Same pattern as
 * rice-prices.html — lives at the Farmer Portal's top level (not its own
 * mini-app), reuses AgroLinkAPI/agrolink_farmer_session, no login of its
 * own. Unlike rice-prices.html (read-only comparison), this page also
 * writes (placing/cancelling orders), so it needs AgroLinkAPI.post — which
 * js/api.js already has (added for POST /farmer/loan-applications).
 */
const session = AgroLinkAPI.requireSessionOrRedirect();

const toastEl = document.getElementById("toast");
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = "toast show" + (isError ? " error" : "");
  setTimeout(() => { toastEl.className = "toast"; }, 3200);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function thaiDate(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function thaiDateOnly(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

function thb(n) {
  return Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2 });
}

const CATEGORY_LABEL_TH = {
  fertilizer_hormone: "ปุ๋ย/ฮอร์โมน",
  chemical_pesticide: "สารเคมีและยาปราบศัตรูพืช",
  equipment: "อุปกรณ์การเกษตร",
  other: "อื่นๆ",
};

const ORDER_STATUS_LABEL_TH = {
  requested: "รอการยืนยันจากผู้จำหน่าย",
  confirmed: "ยืนยันแล้ว (รอส่งมอบ)",
  fulfilled: "ส่งมอบแล้ว",
  rejected: "ผู้จำหน่ายปฏิเสธ",
  cancelled: "ยกเลิกแล้ว",
};
const ORDER_STATUS_BADGE_CLASS = {
  requested: "status-pending",
  confirmed: "status-approved",
  fulfilled: "status-completed",
  rejected: "status-declined",
  cancelled: "status-declined",
};

// ---------- วงเงินสินเชื่อหมุนเวียน (Trade Credit) ----------
// See grant_input_credit_line.sql / backend/src/routes/farmer.js. A farmer
// only ever sees credit lines a Lender has already extended to them (this
// portal never lets a farmer request one) — creditLinesCache holds the
// ACTIVE ones only, used to decide whether to show "จ่ายด้วยเครดิต" on an
// order and to populate its lender picker. productionUnitsCache backs the
// "pay from which unit" selector on the repayment screen.
const CREDIT_LINE_STATUS_LABEL_TH = {
  active: "ใช้งานอยู่",
  suspended: "ระงับชั่วคราว",
  closed: "ปิดแล้ว",
};
let creditLinesCache = [];
let productionUnitsCache = [];

function creditLineSummaryCard(cl) {
  const badgeClass = cl.status === "active" ? "status-active" : "status-declined";
  return `
    <div class="item-card">
      <div class="row">
        <span class="title">${escapeHtml(cl.lender_name)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(CREDIT_LINE_STATUS_LABEL_TH[cl.status] || cl.status)}</span>
      </div>
      <div class="detail-line">วงเงิน ${thb(cl.credit_limit)} บาท · ดอกเบี้ย ${(cl.interest_rate_daily_bps / 100).toFixed(3)}% ต่อวัน</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">ใช้ไปแล้ว ${thb(cl.outstanding_total)} บาท · คงเหลือให้ใช้ ${thb(cl.available_credit)} บาท</div>
    </div>
  `;
}

async function loadCreditLines() {
  const el = document.getElementById("creditLineSummarySection");
  try {
    const lines = await AgroLinkAPI.get("/farmer/credit-lines");
    creditLinesCache = lines.filter((l) => l.status === "active");
    el.innerHTML = lines.length === 0
      ? `<div class="empty-state">ท่านยังไม่มีวงเงินสินเชื่อหมุนเวียน — ติดต่อผู้ให้บริการสินเชื่อ (Lender) ที่ท่านเป็นลูกค้าอยู่เพื่อขอวงเงิน</div>`
      : lines.map(creditLineSummaryCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดวงเงินสินเชื่อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadProductionUnits() {
  try {
    productionUnitsCache = await AgroLinkAPI.get("/farmer/production-units");
  } catch (err) {
    productionUnitsCache = [];
  }
}

function unitOptionsHtml() {
  if (productionUnitsCache.length === 0) {
    return `<option value="">ยังไม่มีหน่วยผลิตที่ลงทะเบียนไว้</option>`;
  }
  return `<option value="">เลือกหน่วยผลิตที่จะใช้จ่าย</option>` +
    productionUnitsCache.map((u) => `<option value="${u.unit_id}">${escapeHtml(u.unit_type)}${u.commodity_code ? " · " + escapeHtml(u.commodity_code) : ""} (${Number(u.area_rai).toLocaleString("th-TH")} ไร่)</option>`).join("");
}

function drawdownCard(d) {
  const isOutstanding = d.status === "outstanding";
  return `
    <div class="item-card" data-drawdown-id="${d.drawdown_id}">
      <div class="row">
        <span class="title">${escapeHtml(d.product_name || "รายการเบิกใช้")} — ${escapeHtml(d.lender_name)}</span>
        <span class="badge ${isOutstanding ? "status-pending" : "status-approved"}">${isOutstanding ? "ค้างชำระ" : "ชำระแล้ว"}</span>
      </div>
      <div class="detail-line">เงินต้น ${thb(d.principal_amount)} บาท · ดอกเบี้ยสะสมถึงวันนี้ ${thb(d.interest_accrued_to_date)} บาท</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">ยอดที่ต้องชำระวันนี้ ${thb(d.total_due_today)} บาท</div>
      <div class="detail-line muted">เบิกเมื่อ ${thaiDate(d.drawn_at)} · ครบกำหนด ${thaiDateOnly(d.due_date)}</div>
      ${isOutstanding ? `
        <div class="action-row">
          <select data-repay-unit-id-for="${d.drawdown_id}" style="max-width:260px;">
            ${unitOptionsHtml()}
          </select>
          <button type="button" class="btn btn-approve btn-sm" data-repay-drawdown="${d.drawdown_id}">ชำระคืนเต็มจำนวน</button>
        </div>
      ` : `<div class="detail-line muted">ชำระแล้ว ${thb(d.repaid_amount)} บาท เมื่อ ${thaiDate(d.repaid_at)}</div>`}
    </div>
  `;
}

async function loadCreditLineDrawdowns() {
  const el = document.getElementById("creditLineDrawdownsSection");
  try {
    const drawdowns = await AgroLinkAPI.get("/farmer/credit-line-drawdowns?status=outstanding");
    el.innerHTML = drawdowns.length === 0
      ? `<div class="empty-state">ไม่มียอดค้างชำระผ่านวงเงินสินเชื่อในขณะนี้</div>`
      : drawdowns.map(drawdownCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดยอดค้างชำระไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("creditLineDrawdownsSection").addEventListener("click", async (e) => {
  const repayBtn = e.target.closest("[data-repay-drawdown]");
  if (!repayBtn) return;

  const drawdownId = repayBtn.dataset.repayDrawdown;
  const unitSelect = document.querySelector(`[data-repay-unit-id-for="${drawdownId}"]`);
  const unitId = unitSelect ? unitSelect.value : "";
  if (!unitId) {
    toast("กรุณาเลือกหน่วยผลิตที่จะใช้จ่าย", true);
    return;
  }
  if (!confirm("ยืนยันชำระคืนยอดค้างนี้เต็มจำนวน (เงินต้น + ดอกเบี้ยสะสมถึงวันนี้)?")) return;

  repayBtn.disabled = true;
  try {
    await AgroLinkAPI.post(`/farmer/credit-line-drawdowns/${drawdownId}/repay`, { unit_id: unitId });
    toast("ชำระคืนเรียบร้อยแล้ว");
    await Promise.all([loadCreditLineDrawdowns(), loadCreditLines()]);
  } catch (err) {
    toast("ชำระคืนไม่สำเร็จ: " + ((err.body && err.body.detail) || err.message), true);
    repayBtn.disabled = false;
  }
});

// ---------- จังหวัด (สำหรับตัวกรอง) ----------
// Populate the province filter from TH_PROVINCES (frontend/js/
// provinces.js) — same pattern as frontend/js/venue-marketplace.js's own
// provinceFilter. This dropdown existed in the HTML long before this, but
// was never wired to anything (no options, no listener, no query param) —
// this closes that gap end-to-end together with GET /farmer/products?
// province_code= and GET /farmer/input-suppliers?province_code= on the
// backend (see those routes' doc comments in farmer.js) and the new
// "พื้นที่ให้บริการ" section on the InputSupplier dashboard that lets a
// provider actually declare which provinces they serve.
const provinceFilterEl = document.getElementById("provinceFilter");
TH_PROVINCES.forEach(([code, name]) => {
  const opt = document.createElement("option");
  opt.value = code;
  opt.textContent = name;
  provinceFilterEl.appendChild(opt);
});

// ---------- อำเภอ (สำหรับตัวกรอง) ----------
// Populated based on the selected province, from TH_DISTRICTS (frontend/
// js/districts.js) — see that file's own doc comment for an important
// caveat: this district list and its district_code scheme were compiled
// from general knowledge, not fetched from a live-verified government
// dataset (web-fetch tools could not reach the known open datasets — see
// DEPLOY.md's 2026-08-29 note for this feature). Reset to "ทั้งหมด"
// whenever the province filter changes.
const districtFilterEl = document.getElementById("districtFilter");
function populateDistrictOptions(provinceCode) {
  districtFilterEl.innerHTML = `<option value="">ทั้งหมด</option>`;
  if (!provinceCode) return;
  TH_DISTRICTS.filter(([, , pCode]) => pCode === provinceCode).forEach(([code, name]) => {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = name;
    districtFilterEl.appendChild(opt);
  });
}

// ---------- ผู้จำหน่าย (สำหรับตัวกรอง) ----------
// Re-populated whenever the province filter changes, so the "ผู้จำหน่าย"
// dropdown only ever lists suppliers that actually serve the selected
// province (an org with no declared service_regions always shows, per the
// "serves everywhere" convention — see GET /farmer/input-suppliers).
async function loadSuppliersIntoFilter(provinceCode, districtCode) {
  const select = document.getElementById("supplierFilter");
  const previouslySelected = select.value;
  select.innerHTML = `<option value="">ทั้งหมด</option>`;
  try {
    const params = new URLSearchParams();
    if (provinceCode) params.set("province_code", provinceCode);
    if (districtCode) params.set("district_code", districtCode);
    const query = params.toString() ? `?${params.toString()}` : "";
    const suppliers = await AgroLinkAPI.get(`/farmer/input-suppliers${query}`);
    suppliers.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.org_id;
      opt.textContent = `${s.org_name} (${s.active_product_count} รายการ)`;
      select.appendChild(opt);
    });
    // Keep the previous selection only if it's still a valid option after
    // the province change narrowed (or widened) the list.
    if (previouslySelected && Array.from(select.options).some((o) => o.value === previouslySelected)) {
      select.value = previouslySelected;
    }
  } catch (err) {
    // Non-fatal — the "ทั้งหมด" option still works without the list.
  }
}

// ---------- รายการสินค้า ----------
// Backend (GET /farmer/products) already sorts featured listings first —
// this just renders the "⭐ แนะนำ" badge, it does not re-sort anything
// client-side.
function productCard(p) {
  const coverPhotoHtml = p.cover_photo_url
    ? `<img class="product-cover-photo" src="${p.cover_photo_url}" alt="${escapeHtml(p.product_name)}" />`
    : "";
  const matchBadge = p.match_score !== undefined && p.match_score !== null
    ? `<span class="badge status-active" style="background:var(--gold-100, #fff6dd); color:var(--gold-700, #8a6d1a);">ตรงกับท่าน ${Math.round(p.match_score * 100)}%</span>`
    : "";
  return `
    <div class="item-card" data-listing-id="${p.listing_id}">
      ${coverPhotoHtml}
      <div class="row">
        <span class="title">${p.featured ? "⭐ " : ""}${escapeHtml(p.product_name)}${p.brand ? " · " + escapeHtml(p.brand) : ""}</span>
        <span class="badge status-active">${escapeHtml(CATEGORY_LABEL_TH[p.category] || p.category)}</span>
        ${matchBadge}
      </div>
      ${p.featured ? `<div class="detail-line"><span class="badge status-approved">⭐ แนะนำ</span></div>` : ""}
      <div class="detail-line">ผู้จำหน่าย: ${escapeHtml(p.org_name)}</div>
      ${p.description ? `<div class="detail-line muted">${escapeHtml(p.description)}</div>` : ""}
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">
        ${Number(p.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(p.price_unit)}
      </div>
      <div class="action-row">
        <input type="number" class="order-qty-input" data-qty-for="${p.listing_id}" min="0.01" step="0.01" value="1" style="max-width:120px;" />
        <button type="button" class="btn btn-primary btn-sm" data-order="${p.listing_id}">สั่งซื้อ</button>
      </div>
    </div>
  `;
}

/**
 * "แนะนำสำหรับท่าน" — GET /farmer/products/recommended. Same productCard
 * renderer as the main browse list (now match_score-aware), same order
 * button wiring reused via handleOrderClick below, so a farmer can order
 * directly from a recommended card.
 */
async function loadRecommendedProducts() {
  const el = document.getElementById("recommendedProductsSection");
  try {
    const products = await AgroLinkAPI.get("/farmer/products/recommended?limit=6");
    if (products.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีคำแนะนำในขณะนี้</div>`;
      return;
    }
    el.innerHTML = products.map(productCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำแนะนำไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadProducts() {
  const el = document.getElementById("productListSection");
  const category = document.getElementById("categoryFilter").value;
  const orgId = document.getElementById("supplierFilter").value;
  const provinceCode = document.getElementById("provinceFilter").value;
  const districtCode = document.getElementById("districtFilter").value;
  try {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (orgId) params.set("org_id", orgId);
    if (provinceCode) params.set("province_code", provinceCode);
    if (districtCode) params.set("district_code", districtCode);
    const query = params.toString() ? `?${params.toString()}` : "";
    const products = await AgroLinkAPI.get(`/farmer/products${query}`);
    if (products.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่พบสินค้าตามเงื่อนไขที่เลือก</div>`;
      return;
    }
    el.innerHTML = products.map(productCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดสินค้าไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("categoryFilter").addEventListener("change", () => loadProducts());
document.getElementById("supplierFilter").addEventListener("change", () => loadProducts());
document.getElementById("provinceFilter").addEventListener("change", () => {
  // Changing province narrows/widens both the supplier list AND the
  // product list — re-run both rather than just loadProducts(). Also
  // repopulate the district dropdown for the newly-selected province and
  // reset it, since a district from the old province no longer applies.
  const provinceCode = document.getElementById("provinceFilter").value;
  populateDistrictOptions(provinceCode);
  loadSuppliersIntoFilter(provinceCode, "");
  loadProducts();
});
document.getElementById("districtFilter").addEventListener("change", () => {
  loadSuppliersIntoFilter(document.getElementById("provinceFilter").value, document.getElementById("districtFilter").value);
  loadProducts();
});

async function handleOrderClick(e) {
  const orderBtn = e.target.closest("[data-order]");
  if (!orderBtn) return;

  const listingId = orderBtn.dataset.order;
  const qtyInput = document.querySelector(`[data-qty-for="${listingId}"]`);
  const quantity = Number(qtyInput ? qtyInput.value : 0);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    toast("กรุณาระบุจำนวนที่มากกว่า 0", true);
    return;
  }

  orderBtn.disabled = true;
  try {
    await AgroLinkAPI.post("/farmer/orders", { listing_id: listingId, quantity });
    toast("สั่งซื้อเรียบร้อยแล้ว รอผู้จำหน่ายยืนยัน");
    await loadOrderHistory();
  } catch (err) {
    toast("สั่งซื้อไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    orderBtn.disabled = false;
  }
}
document.getElementById("productListSection").addEventListener("click", handleOrderClick);
document.getElementById("recommendedProductsSection").addEventListener("click", handleOrderClick);

// ---------- คำสั่งซื้อของท่าน ----------
function orderCard(o) {
  const badgeClass = ORDER_STATUS_BADGE_CLASS[o.status] || "status-pending";
  const badge = `<span class="badge ${badgeClass}">${escapeHtml(ORDER_STATUS_LABEL_TH[o.status] || o.status)}</span>`;
  const cancelBtn = o.status === "requested"
    ? `<div class="action-row"><button type="button" class="btn btn-decline btn-sm" data-cancel-order="${o.order_id}">ยกเลิกคำสั่งซื้อ</button></div>`
    : "";

  const paidBadge = o.payment_status === "paid_via_credit_line"
    ? `<div class="detail-line"><span class="badge status-approved">💳 ชำระผ่านวงเงินสินเชื่อแล้ว</span></div>`
    : "";
  const canPayWithCredit = ["confirmed", "fulfilled"].includes(o.status)
    && o.payment_status === "unpaid" && creditLinesCache.length > 0;
  const payWithCreditBlock = canPayWithCredit ? `
    <div class="action-row">
      <select data-pay-credit-line-for="${o.order_id}" style="max-width:240px;">
        ${creditLinesCache.map((cl) => `<option value="${cl.credit_line_id}">${escapeHtml(cl.lender_name)} (คงเหลือ ${thb(cl.available_credit)} บาท)</option>`).join("")}
      </select>
      <button type="button" class="btn btn-primary btn-sm" data-pay-with-credit="${o.order_id}">💳 จ่ายด้วยเครดิต</button>
    </div>
  ` : "";

  return `
    <div class="item-card" data-order-id="${o.order_id}">
      <div class="row"><span class="title">${escapeHtml(o.product_name)} — ${escapeHtml(o.org_name)}</span>${badge}</div>
      <div class="detail-line">${escapeHtml(CATEGORY_LABEL_TH[o.category] || o.category)} · จำนวน ${Number(o.quantity).toLocaleString("th-TH")} x ${Number(o.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(o.price_unit)}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">รวม ${Number(o.total_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท</div>
      ${paidBadge}
      ${o.decided_reason ? `<div class="detail-line muted">เหตุผลจากผู้จำหน่าย: ${escapeHtml(o.decided_reason)}</div>` : ""}
      <div class="detail-line muted">สั่งซื้อเมื่อ ${thaiDate(o.requested_at)}</div>
      ${cancelBtn}
      ${payWithCreditBlock}
    </div>
  `;
}

async function loadOrderHistory() {
  const el = document.getElementById("orderHistorySection");
  try {
    const orders = await AgroLinkAPI.get("/farmer/orders");
    if (orders.length === 0) {
      el.innerHTML = `<div class="empty-state">ท่านยังไม่เคยสั่งซื้อสินค้า</div>`;
      return;
    }
    el.innerHTML = orders.map(orderCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำสั่งซื้อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("orderHistorySection").addEventListener("click", async (e) => {
  const cancelBtn = e.target.closest("[data-cancel-order]");
  const payBtn = e.target.closest("[data-pay-with-credit]");

  if (cancelBtn) {
    const orderId = cancelBtn.dataset.cancelOrder;
    cancelBtn.disabled = true;
    try {
      await AgroLinkAPI.post(`/farmer/orders/${orderId}/cancel`, {});
      toast("ยกเลิกคำสั่งซื้อเรียบร้อยแล้ว");
      await loadOrderHistory();
    } catch (err) {
      toast("ยกเลิกไม่สำเร็จ: " + err.message, true);
      cancelBtn.disabled = false;
    }
    return;
  }

  if (payBtn) {
    const orderId = payBtn.dataset.payWithCredit;
    const select = document.querySelector(`[data-pay-credit-line-for="${orderId}"]`);
    const creditLineId = select ? select.value : "";
    if (!creditLineId) {
      toast("กรุณาเลือกวงเงินสินเชื่อที่จะใช้จ่าย", true);
      return;
    }
    if (!confirm("ยืนยันจ่ายค่าสินค้านี้ด้วยวงเงินสินเชื่อ? ท่านจะเป็นหนี้ผู้ให้สินเชื่อยอดเต็มของคำสั่งซื้อนี้บวกดอกเบี้ยเมื่อครบกำหนด")) return;
    payBtn.disabled = true;
    try {
      await AgroLinkAPI.post(`/farmer/orders/${orderId}/pay-with-credit-line`, { credit_line_id: creditLineId });
      toast("จ่ายด้วยเครดิตเรียบร้อยแล้ว");
      await Promise.all([loadOrderHistory(), loadCreditLines(), loadCreditLineDrawdowns()]);
    } catch (err) {
      toast("จ่ายด้วยเครดิตไม่สำเร็จ: " + ((err.body && err.body.detail) || err.message), true);
      payBtn.disabled = false;
    }
  }
});

async function init() {
  await loadSuppliersIntoFilter(document.getElementById("provinceFilter").value, document.getElementById("districtFilter").value);
  // creditLinesCache must be populated BEFORE orderCard() renders (it
  // decides whether the "จ่ายด้วยเครดิต" button shows), same
  // load-then-render-dependents ordering used elsewhere in this project
  // (e.g. lender/js/dashboard.js loading auctionMineByRfqId before rfqMine).
  await loadCreditLines();
  await loadProductionUnits();
  await Promise.all([loadProducts(), loadOrderHistory(), loadCreditLineDrawdowns(), loadRecommendedProducts()]);
}

init();
