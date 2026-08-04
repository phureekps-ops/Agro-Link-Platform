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

function thaiDate(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const UNIT_TYPE_LABEL = { Plot: "แปลงนา/ไร่", Pen: "คอกปศุสัตว์", Pond: "บ่อเลี้ยง", Orchard: "สวนผลไม้" };
const DELIVERY_OPTION_LABEL_TH = { pickup: "รับเองที่ร้าน", delivery: "จัดส่งถึงแปลง" };
const ORDER_STATUS_LABEL_TH = {
  Requested: "รอการยืนยัน",
  Accepted: "รับคำสั่งแล้ว (กำลังผสม)",
  Completed: "ผสมเสร็จแล้ว",
  Declined: "ปฏิเสธแล้ว",
  Cancelled: "ยกเลิกแล้ว",
};
const ORDER_STATUS_BADGE_CLASS = {
  Requested: "status-pending",
  Accepted: "status-active",
  Completed: "status-active",
  Declined: "status-declined",
  Cancelled: "status-declined",
};

// Query params a farmer arrives with when clicking "สั่งบริการผสมปุ๋ยตามสูตรนี้"
// from fertilizer-calculator.html's result panel — see that page's
// renderCalcResult() for where these are set.
const params = new URLSearchParams(window.location.search);
const prefill = {
  calcId: params.get("calc_id") || "",
  unitId: params.get("unit_id") || "",
  ureaKg: params.get("urea_kg") || "",
  dapKg: params.get("dap_kg") || "",
  mopKg: params.get("mop_kg") || "",
};

if (prefill.calcId) {
  document.getElementById("fromCalcNoticeSection").innerHTML = `
    <div class="panel" style="background:#e8f5e9; border-color:#a5d6a7; margin-bottom:20px;">
      <div style="font-weight:700; margin-bottom:4px;">✅ กรอกสูตรจากผลการคำนวณปุ๋ยให้อัตโนมัติแล้ว</div>
      <div style="font-size:13px;">เลือกผู้ให้บริการด้านล่าง ระบบจะกรอกปริมาณยูเรีย/DAP/MOP ที่คำนวณไว้ให้ในแบบฟอร์มสั่งบริการ — ท่านสามารถแก้ไขตัวเลขได้ก่อนส่งคำสั่ง</div>
    </div>
  `;
}

// ---------- แปลง/หน่วยผลิต ----------
async function loadUnitsIntoSelect() {
  const sel = document.getElementById("orderUnitSelect");
  try {
    const units = await AgroLinkAPI.get("/farmer/production-units");
    if (units.length === 0) {
      sel.innerHTML = `<option value="">ยังไม่มีแปลง/หน่วยผลิต</option>`;
      return;
    }
    sel.innerHTML = units.map((u) =>
      `<option value="${u.unit_id}">${escapeHtml(UNIT_TYPE_LABEL[u.unit_type] || u.unit_type)} — ${escapeHtml(u.commodity_code)} (${u.area_rai} ไร่)</option>`
    ).join("");
    if (prefill.unitId && units.some((u) => u.unit_id === prefill.unitId)) {
      sel.value = prefill.unitId;
    }
  } catch (err) {
    sel.innerHTML = `<option value="">โหลดแปลงไม่สำเร็จ</option>`;
  }
}

// ---------- ผู้ให้บริการ ----------
function providerCard(p) {
  return `
    <div class="item-card" data-listing-id="${p.listing_id}">
      <div class="row"><span class="title">${escapeHtml(p.org_name)}</span></div>
      <div class="detail-line">${escapeHtml(p.label_th)}</div>
      <div class="detail-line muted">ราคา: ${Number(p.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(p.price_unit || "")}</div>
      <div class="action-row">
        <button type="button" class="btn btn-primary btn-sm" data-order-from="${p.listing_id}" data-org-name="${escapeHtml(p.org_name)}" data-label-th="${escapeHtml(p.label_th)}">สั่งบริการนี้</button>
      </div>
    </div>
  `;
}

async function loadProviders() {
  const el = document.getElementById("providerListSection");
  try {
    const providers = await AgroLinkAPI.get("/farmer/fertilizer-mixing-providers");
    if (providers.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีผู้ให้บริการผสมปุ๋ยสั่งตัดที่เปิดรับในขณะนี้</div>`;
      return;
    }
    el.innerHTML = providers.map(providerCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดผู้ให้บริการไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("providerListSection").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-order-from]");
  if (!btn) return;
  document.getElementById("orderListingId").value = btn.dataset.orderFrom;
  document.getElementById("orderLabel").textContent = `${btn.dataset.orgName} — ${btn.dataset.labelTh}`;
  document.getElementById("orderFormTitle").style.display = "block";
  document.getElementById("orderForm").style.display = "block";
  document.getElementById("orderForm").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.getElementById("orderCancelBtn").addEventListener("click", () => {
  document.getElementById("orderFormTitle").style.display = "none";
  document.getElementById("orderForm").style.display = "none";
  document.getElementById("orderForm").reset();
});

document.getElementById("orderDeliveryOption").addEventListener("change", (e) => {
  document.getElementById("orderDeliveryAddressField").style.display = e.target.value === "delivery" ? "block" : "none";
});

// ---------- ส่งคำสั่งผสมปุ๋ย ----------
document.getElementById("orderForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const listingId = document.getElementById("orderListingId").value;
  const unitId = document.getElementById("orderUnitSelect").value;
  const preferredDate = document.getElementById("orderPreferredDate").value;
  const deliveryOption = document.getElementById("orderDeliveryOption").value;
  const deliveryAddress = document.getElementById("orderDeliveryAddress").value.trim();

  if (!unitId) {
    toast("กรุณาเลือกแปลง/หน่วยผลิต", true);
    return;
  }
  if (!preferredDate) {
    toast("กรุณาเลือกวันที่ต้องการรับ/จัดส่ง", true);
    return;
  }
  if (deliveryOption === "delivery" && !deliveryAddress) {
    toast("กรุณากรอกที่อยู่จัดส่ง", true);
    return;
  }

  const ureaRaw = document.getElementById("orderUreaKg").value;
  const dapRaw = document.getElementById("orderDapKg").value;
  const mopRaw = document.getElementById("orderMopKg").value;

  const payload = {
    listing_id: listingId,
    unit_id: unitId,
    calc_id: prefill.calcId || undefined,
    requested_urea_kg: ureaRaw ? Number(ureaRaw) : undefined,
    requested_dap_kg: dapRaw ? Number(dapRaw) : undefined,
    requested_mop_kg: mopRaw ? Number(mopRaw) : undefined,
    delivery_option: deliveryOption,
    delivery_address: deliveryOption === "delivery" ? deliveryAddress : undefined,
    preferred_date: preferredDate,
    farmer_note: document.getElementById("orderFarmerNote").value.trim() || undefined,
  };

  const btn = document.getElementById("orderSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkAPI.post("/farmer/fertilizer-mixing-orders", payload);
    toast("ส่งคำสั่งผสมปุ๋ยเรียบร้อยแล้ว");
    document.getElementById("orderForm").reset();
    document.getElementById("orderFormTitle").style.display = "none";
    document.getElementById("orderForm").style.display = "none";
    await loadOrderHistory();
  } catch (err) {
    toast("ส่งคำสั่งไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- คำสั่งผสมปุ๋ยของท่าน ----------
function orderCard(o) {
  const badgeClass = ORDER_STATUS_BADGE_CLASS[o.status] || "status-pending";
  const badge = `<span class="badge ${badgeClass}">${escapeHtml(ORDER_STATUS_LABEL_TH[o.status] || o.status)}</span>`;
  let actions = "";
  if (o.status === "Requested") {
    actions = `
      <div class="action-row">
        <button type="button" class="btn btn-decline btn-sm" data-cancel-order="${o.order_id}">ยกเลิกคำสั่ง</button>
      </div>
    `;
  }
  return `
    <div class="item-card" data-order-id="${o.order_id}">
      <div class="row"><span class="title">${escapeHtml(o.org_name)} — ${escapeHtml(o.label_th)}</span>${badge}</div>
      <div class="detail-line">วิธีรับปุ๋ย: ${escapeHtml(DELIVERY_OPTION_LABEL_TH[o.delivery_option] || o.delivery_option)}${o.delivery_address ? ` — ${escapeHtml(o.delivery_address)}` : ""}</div>
      <div class="detail-line">วันที่ต้องการรับ/จัดส่ง: ${escapeHtml(o.preferred_date)}</div>
      <div class="detail-line muted">ค่าบริการ (จ่ายหน้างานโดยตรง): ${Number(o.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(o.price_unit || "")}</div>
      ${o.decided_reason ? `<div class="detail-line muted">เหตุผล: ${escapeHtml(o.decided_reason)}</div>` : ""}
      <div class="detail-line muted">สั่งเมื่อ ${thaiDate(o.requested_at)}</div>
      ${actions}
    </div>
  `;
}

async function loadOrderHistory() {
  const el = document.getElementById("orderHistorySection");
  try {
    const orders = await AgroLinkAPI.get("/farmer/fertilizer-mixing-orders");
    if (orders.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีคำสั่งผสมปุ๋ย</div>`;
      return;
    }
    el.innerHTML = orders.map(orderCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำสั่งผสมปุ๋ยไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("orderHistorySection").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-cancel-order]");
  if (!btn) return;
  const orderId = btn.dataset.cancelOrder;
  btn.disabled = true;
  try {
    await AgroLinkAPI.post(`/farmer/fertilizer-mixing-orders/${orderId}/cancel`, {});
    toast("ยกเลิกคำสั่งเรียบร้อยแล้ว");
    await loadOrderHistory();
  } catch (err) {
    toast("ยกเลิกไม่สำเร็จ: " + err.message, true);
    btn.disabled = false;
  }
});

// ---------- เริ่มต้น ----------
async function init() {
  await loadUnitsIntoSelect();
  await loadProviders();
  await loadOrderHistory();

  // If a farmer arrived from the calculator with a calc_id, pre-fill the
  // requested-kg fields — the order form itself only appears once they
  // pick a provider below, so these values just sit ready in the inputs.
  if (prefill.ureaKg) document.getElementById("orderUreaKg").value = prefill.ureaKg;
  if (prefill.dapKg) document.getElementById("orderDapKg").value = prefill.dapKg;
  if (prefill.mopKg) document.getElementById("orderMopKg").value = prefill.mopKg;
}

init();
