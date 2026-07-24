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

// ---------- ผู้จำหน่าย (สำหรับตัวกรอง) ----------
async function loadSuppliersIntoFilter() {
  const select = document.getElementById("supplierFilter");
  try {
    const suppliers = await AgroLinkAPI.get("/farmer/input-suppliers");
    suppliers.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.org_id;
      opt.textContent = `${s.org_name} (${s.active_product_count} รายการ)`;
      select.appendChild(opt);
    });
  } catch (err) {
    // Non-fatal — the "ทั้งหมด" option still works without the list.
  }
}

// ---------- รายการสินค้า ----------
function productCard(p) {
  return `
    <div class="item-card" data-listing-id="${p.listing_id}">
      <div class="row">
        <span class="title">${escapeHtml(p.product_name)}${p.brand ? " · " + escapeHtml(p.brand) : ""}</span>
        <span class="badge status-active">${escapeHtml(CATEGORY_LABEL_TH[p.category] || p.category)}</span>
      </div>
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

async function loadProducts() {
  const el = document.getElementById("productListSection");
  const category = document.getElementById("categoryFilter").value;
  const orgId = document.getElementById("supplierFilter").value;
  try {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (orgId) params.set("org_id", orgId);
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

document.getElementById("productListSection").addEventListener("click", async (e) => {
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
});

// ---------- คำสั่งซื้อของท่าน ----------
function orderCard(o) {
  const badgeClass = ORDER_STATUS_BADGE_CLASS[o.status] || "status-pending";
  const badge = `<span class="badge ${badgeClass}">${escapeHtml(ORDER_STATUS_LABEL_TH[o.status] || o.status)}</span>`;
  const cancelBtn = o.status === "requested"
    ? `<div class="action-row"><button type="button" class="btn btn-decline btn-sm" data-cancel-order="${o.order_id}">ยกเลิกคำสั่งซื้อ</button></div>`
    : "";

  return `
    <div class="item-card" data-order-id="${o.order_id}">
      <div class="row"><span class="title">${escapeHtml(o.product_name)} — ${escapeHtml(o.org_name)}</span>${badge}</div>
      <div class="detail-line">${escapeHtml(CATEGORY_LABEL_TH[o.category] || o.category)} · จำนวน ${Number(o.quantity).toLocaleString("th-TH")} x ${Number(o.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(o.price_unit)}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">รวม ${Number(o.total_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท</div>
      ${o.decided_reason ? `<div class="detail-line muted">เหตุผลจากผู้จำหน่าย: ${escapeHtml(o.decided_reason)}</div>` : ""}
      <div class="detail-line muted">สั่งซื้อเมื่อ ${thaiDate(o.requested_at)}</div>
      ${cancelBtn}
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
  if (!cancelBtn) return;

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
});

async function init() {
  await loadSuppliersIntoFilter();
  await Promise.all([loadProducts(), loadOrderHistory()]);
}

init();
