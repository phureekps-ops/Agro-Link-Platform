const session = AgroLinkFertilizerMixingAPI.requireSessionOrRedirect();

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

const DELIVERY_OPTION_LABEL_TH = { pickup: "รับเองที่ร้าน", delivery: "จัดส่งถึงแปลง" };

/**
 * Replaces the whole dashboard body with a "your KYB application is under
 * review" notice — used only when GET /fertilizermixing/dashboard itself
 * reports kyb_not_verified (a real fertilizer-mixing-org token, just not
 * yet approved by Platform Ops, e.g. right after registering via
 * register-provider.html). Deliberately does NOT log the user out —
 * refreshing this same page after approval will show the real dashboard
 * with no need to log in again. Same pattern as machinery/js/dashboard.js.
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
        เมื่อได้รับการอนุมัติแล้ว ท่านจะสามารถเข้าใช้งานพอร์ทัลผู้ให้บริการผสมปุ๋ยสั่งตัดได้เต็มรูปแบบ —
        ลองเข้าสู่ระบบใหม่อีกครั้งในภายหลัง หรือรีเฟรชหน้านี้
      </div>
    </div>
  `;
}

/**
 * Replaces the whole dashboard body with a "you don't hold this role" —
 * same shape as machinery/js/dashboard.js's showRolePendingNotice.
 */
function showRolePendingNotice(orgName, roleStatus) {
  document.getElementById("orgName").textContent = orgName || "-";
  const body = !roleStatus
    ? {
        title: "องค์กรของท่านยังไม่มีบทบาทผู้ให้บริการผสมปุ๋ยสั่งตัด",
        detail: "หากต้องการเปิดใช้งานพอร์ทัลนี้ ท่านสามารถส่งคำขอเพิ่มบทบาทได้จากหน้า \"จัดการบทบาทธุรกิจ\"",
      }
    : roleStatus === "Rejected"
    ? { title: "คำขอบทบาทผู้ให้บริการผสมปุ๋ยสั่งตัดของท่านถูกปฏิเสธ", detail: "กรุณาติดต่อเจ้าหน้าที่ผู้ดูแลระบบสำหรับข้อมูลเพิ่มเติม" }
    : { title: "คำขอบทบาทผู้ให้บริการผสมปุ๋ยสั่งตัดของท่านอยู่ระหว่างการตรวจสอบ", detail: "เจ้าหน้าที่ผู้ดูแลระบบ (Platform Ops) กำลังตรวจสอบคำขอนี้ — ลองรีเฟรชหน้านี้อีกครั้งภายหลัง" };

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
  const byStatus = d.orders_by_status || {};
  document.getElementById("summarySection").innerHTML = `
    <div class="stat-card"><div class="label">สถานะ KYB</div><div class="value" style="font-size:16px;">${escapeHtml(d.kyb_status)}</div></div>
    <div class="stat-card"><div class="label">บริการที่ตั้งราคาแล้ว</div><div class="value">${d.priced_items_count} / ${d.total_rate_card_items}</div></div>
    <div class="stat-card"><div class="label">คำสั่งที่รอตอบ</div><div class="value">${byStatus.Requested || 0}</div></div>
    <div class="stat-card"><div class="label">กำลังผสม (รับแล้ว)</div><div class="value">${byStatus.Accepted || 0}</div></div>
    <div class="stat-card"><div class="label">ผสมเสร็จแล้ว</div><div class="value">${byStatus.Completed || 0}</div></div>
  `;
}

async function refreshSummary() {
  try {
    const d = await AgroLinkFertilizerMixingAPI.get("/fertilizermixing/dashboard");
    renderSummary(d);
  } catch (err) {
    // Dashboard already loaded once successfully to get this far — a
    // transient failure on refresh isn't worth interrupting the user.
  }
}

// ---------- คำสั่งผสมปุ๋ยจากเกษตรกร ----------
const ORDER_STATUS_LABEL_TH = {
  Requested: "รอการยืนยัน",
  Accepted: "รับคำสั่งแล้ว (กำลังผสม)",
  Completed: "ผสมเสร็จแล้ว",
  Declined: "ปฏิเสธแล้ว",
  Cancelled: "ยกเลิกโดยเกษตรกร",
};
const ORDER_STATUS_BADGE_CLASS = {
  Requested: "status-pending",
  Accepted: "status-active",
  Completed: "status-active",
  Declined: "status-declined",
  Cancelled: "status-declined",
};

function requestedMixLine(o) {
  const parts = [];
  if (o.requested_urea_kg !== null && o.requested_urea_kg !== undefined) parts.push(`ยูเรีย ${Number(o.requested_urea_kg).toLocaleString("th-TH", { minimumFractionDigits: 2 })} กก.`);
  if (o.requested_dap_kg !== null && o.requested_dap_kg !== undefined) parts.push(`DAP ${Number(o.requested_dap_kg).toLocaleString("th-TH", { minimumFractionDigits: 2 })} กก.`);
  if (o.requested_mop_kg !== null && o.requested_mop_kg !== undefined) parts.push(`MOP ${Number(o.requested_mop_kg).toLocaleString("th-TH", { minimumFractionDigits: 2 })} กก.`);
  return parts.length > 0 ? parts.join(" · ") : "ไม่ได้ระบุสูตรมา — กรุณาติดต่อเกษตรกรเพื่อสอบถามสูตรที่ต้องการ";
}

function orderCard(o) {
  const badgeClass = ORDER_STATUS_BADGE_CLASS[o.status] || "status-pending";
  const badge = `<span class="badge ${badgeClass}">${escapeHtml(ORDER_STATUS_LABEL_TH[o.status] || o.status)}</span>`;

  let actions = "";
  if (o.status === "Requested") {
    actions = `
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm" data-accept-order="${o.order_id}">รับคำสั่ง</button>
      </div>
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-decline-reason-for="${o.order_id}" placeholder="เหตุผลการปฏิเสธ (ไม่บังคับ)" />
        <button type="button" class="btn btn-decline btn-sm" data-decline-order="${o.order_id}">ปฏิเสธ</button>
      </div>
    `;
  } else if (o.status === "Accepted") {
    actions = `
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm" data-complete-order="${o.order_id}">ผสมเสร็จแล้ว (พร้อมรับ/ส่ง)</button>
      </div>
    `;
  }

  return `
    <div class="item-card" data-order-id="${o.order_id}">
      <div class="row"><span class="title">${escapeHtml(o.farmer_name)} — ${escapeHtml(o.label_th)}</span>${badge}</div>
      <div class="detail-line">สูตรที่ต้องการ: ${requestedMixLine(o)}</div>
      <div class="detail-line">วิธีรับปุ๋ย: ${escapeHtml(DELIVERY_OPTION_LABEL_TH[o.delivery_option] || o.delivery_option)}${o.delivery_address ? ` — ${escapeHtml(o.delivery_address)}` : ""}</div>
      <div class="detail-line">วันที่ต้องการรับ/จัดส่ง: ${escapeHtml(o.preferred_date)}</div>
      <div class="detail-line muted">ค่าบริการ (จ่ายหน้างานโดยตรง): ${Number(o.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(o.price_unit || "")}</div>
      ${o.farmer_note ? `<div class="detail-line muted">หมายเหตุจากเกษตรกร: ${escapeHtml(o.farmer_note)}</div>` : ""}
      <div class="detail-line muted">โทร: ${escapeHtml(o.farmer_phone || "-")}</div>
      ${o.decided_reason ? `<div class="detail-line muted">เหตุผล: ${escapeHtml(o.decided_reason)}</div>` : ""}
      <div class="detail-line muted">สั่งเมื่อ ${thaiDate(o.requested_at)}</div>
      ${actions}
    </div>
  `;
}

async function loadOrderReviewQueue() {
  const el = document.getElementById("orderReviewQueueSection");
  try {
    const orders = await AgroLinkFertilizerMixingAPI.get("/fertilizermixing/orders?status=action_needed");
    if (orders.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีคำสั่งผสมปุ๋ยที่ต้องดำเนินการในขณะนี้</div>`;
      return;
    }
    el.innerHTML = orders.map(orderCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำสั่งผสมปุ๋ยไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadOrderHistory() {
  const el = document.getElementById("orderHistorySection");
  const status = document.getElementById("orderStatusFilter").value;
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const orders = await AgroLinkFertilizerMixingAPI.get(`/fertilizermixing/orders${query}`);
    if (orders.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีคำสั่งผสมปุ๋ย</div>`;
      return;
    }
    el.innerHTML = orders.map(orderCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประวัติคำสั่งผสมปุ๋ยไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function refreshOrdersAndSummary() {
  await Promise.all([loadOrderReviewQueue(), loadOrderHistory(), refreshSummary()]);
}

document.getElementById("orderStatusFilter").addEventListener("change", () => loadOrderHistory());

function handleOrderActionClick(container) {
  container.addEventListener("click", async (e) => {
    const acceptBtn = e.target.closest("[data-accept-order]");
    const declineBtn = e.target.closest("[data-decline-order]");
    const completeBtn = e.target.closest("[data-complete-order]");

    if (acceptBtn) {
      const orderId = acceptBtn.dataset.acceptOrder;
      acceptBtn.disabled = true;
      try {
        await AgroLinkFertilizerMixingAPI.post(`/fertilizermixing/orders/${orderId}/accept`, {});
        toast("รับคำสั่งผสมปุ๋ยเรียบร้อยแล้ว");
        await refreshOrdersAndSummary();
      } catch (err) {
        toast("รับคำสั่งไม่สำเร็จ: " + err.message, true);
        acceptBtn.disabled = false;
      }
      return;
    }

    if (declineBtn) {
      const orderId = declineBtn.dataset.declineOrder;
      const reasonInput = container.querySelector(`[data-decline-reason-for="${orderId}"]`);
      declineBtn.disabled = true;
      try {
        await AgroLinkFertilizerMixingAPI.post(`/fertilizermixing/orders/${orderId}/decline`, {
          reason: (reasonInput && reasonInput.value.trim()) || null,
        });
        toast("ปฏิเสธคำสั่งผสมปุ๋ยเรียบร้อยแล้ว");
        await refreshOrdersAndSummary();
      } catch (err) {
        toast("ปฏิเสธคำสั่งไม่สำเร็จ: " + err.message, true);
        declineBtn.disabled = false;
      }
      return;
    }

    if (completeBtn) {
      const orderId = completeBtn.dataset.completeOrder;
      completeBtn.disabled = true;
      try {
        await AgroLinkFertilizerMixingAPI.post(`/fertilizermixing/orders/${orderId}/complete`, {});
        toast("บันทึกว่าผสมปุ๋ยเสร็จแล้วเรียบร้อย");
        await refreshOrdersAndSummary();
      } catch (err) {
        toast("บันทึกไม่สำเร็จ: " + err.message, true);
        completeBtn.disabled = false;
      }
    }
  });
}

handleOrderActionClick(document.getElementById("orderReviewQueueSection"));
handleOrderActionClick(document.getElementById("orderHistorySection"));

// ---------- ราคาบริการ (Rate Card) ----------
function rateCardFieldRow(item) {
  return `
    <div class="field">
      <label for="price_${item.service_key}">${escapeHtml(item.label_th)} (${escapeHtml(item.price_unit)})</label>
      <input type="number" id="price_${item.service_key}" data-service-key="${item.service_key}"
             min="0" step="0.01" placeholder="ยังไม่ได้ตั้งราคา"
             value="${item.unit_price !== null ? item.unit_price : ""}" />
    </div>
  `;
}

async function loadRateCard() {
  const el = document.getElementById("rateCardFields");
  try {
    const { items } = await AgroLinkFertilizerMixingAPI.get("/fertilizermixing/rate-card");
    el.innerHTML = items.map(rateCardFieldRow).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดราคาบริการไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("rateCardForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("rateCardSubmitBtn");
  const inputs = document.querySelectorAll("#rateCardFields input[data-service-key]");
  const prices = {};
  let hasInvalid = false;
  inputs.forEach((input) => {
    const key = input.dataset.serviceKey;
    if (input.value === "") {
      prices[key] = null;
    } else {
      const num = Number(input.value);
      if (!Number.isFinite(num) || num < 0) hasInvalid = true;
      prices[key] = num;
    }
  });
  if (hasInvalid) {
    toast("กรุณากรอกราคาเป็นตัวเลขที่มากกว่าหรือเท่ากับ 0", true);
    return;
  }

  btn.disabled = true;
  try {
    await AgroLinkFertilizerMixingAPI.put("/fertilizermixing/rate-card", { prices });
    toast("บันทึกราคาบริการเรียบร้อยแล้ว");
    await Promise.all([loadRateCard(), refreshSummary()]);
  } catch (err) {
    toast("บันทึกราคาบริการไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkFertilizerMixingAPI.logout());

/**
 * GET /fertilizermixing/dashboard doubles as the KYB gate check here: if
 * it reports kyb_not_verified, none of the other endpoints would succeed
 * either (same requireFertilizerMixingOrg middleware guards all of them),
 * so there's no point firing them — just show the pending notice and
 * stop. Same pattern as machinery/js/dashboard.js.
 */
async function init() {
  try {
    const d = await AgroLinkFertilizerMixingAPI.get("/fertilizermixing/dashboard");
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

  loadOrderReviewQueue();
  loadOrderHistory();
  loadRateCard();
}

init();
