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

const VENUE_TYPE_LABEL_TH = {
  wholesale_market: "ตลาดค้าส่ง",
  fresh_market: "ตลาดสด",
  popup_market: "ตลาดนัด/ตลาดชั่วคราว",
  other: "อื่นๆ",
};

// Populate the province dropdown from TH_PROVINCES (frontend/js/provinces.js)
// — same lookup used by the farmer registration form.
const provinceSelect = document.getElementById("provinceSelect");
provinceSelect.innerHTML = TH_PROVINCES.map(([code, name]) => `<option value="${code}">${escapeHtml(name)}</option>`).join("");

function provinceName(code) {
  const found = TH_PROVINCES.find((p) => p[0] === code);
  return found ? found[1] : code;
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
        เมื่อได้รับการอนุมัติแล้ว ท่านจะสามารถประกาศพื้นที่จำหน่ายสินค้าได้เต็มรูปแบบ —
        ลองเข้าสู่ระบบใหม่อีกครั้งในภายหลัง หรือรีเฟรชหน้านี้
      </div>
    </div>
  `;
}

function showRolePendingNotice(orgName, roleStatus) {
  document.getElementById("orgName").textContent = orgName || "-";
  const body = !roleStatus
    ? {
        title: "องค์กรของท่านยังไม่มีบทบาทเจ้าของสถานที่จำหน่ายสินค้า",
        detail: "หากต้องการเปิดใช้งานพอร์ทัลนี้ ท่านสามารถส่งคำขอเพิ่มบทบาทได้จากหน้า \"จัดการบทบาทธุรกิจ\"",
      }
    : roleStatus === "Rejected"
    ? { title: "คำขอบทบาทเจ้าของสถานที่จำหน่ายสินค้าของท่านถูกปฏิเสธ", detail: "กรุณาติดต่อเจ้าหน้าที่ผู้ดูแลระบบสำหรับข้อมูลเพิ่มเติม" }
    : { title: "คำขอบทบาทเจ้าของสถานที่จำหน่ายสินค้าของท่านอยู่ระหว่างการตรวจสอบ", detail: "เจ้าหน้าที่ผู้ดูแลระบบ (Platform Ops) กำลังตรวจสอบคำขอนี้ — ลองรีเฟรชหน้านี้อีกครั้งภายหลัง" };

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
  const byStatus = d.bookings_by_status || {};
  document.getElementById("summarySection").innerHTML = `
    <div class="stat-card"><div class="label">สถานะ KYB</div><div class="value" style="font-size:16px;">${escapeHtml(d.kyb_status)}</div></div>
    <div class="stat-card"><div class="label">พื้นที่ประกาศที่เปิดอยู่</div><div class="value">${d.active_listing_count}</div></div>
    <div class="stat-card"><div class="label">พื้นที่ประกาศทั้งหมด</div><div class="value">${d.total_listing_count}</div></div>
    <div class="stat-card"><div class="label">คำขอจองที่รอตอบ</div><div class="value">${byStatus.Requested || 0}</div></div>
    <div class="stat-card"><div class="label">รับจองแล้ว</div><div class="value">${byStatus.Accepted || 0}</div></div>
  `;
}

async function refreshSummary() {
  try {
    const d = await AgroLinkMarketVenueAPI.get("/marketvenue/dashboard");
    renderSummary(d);
  } catch (err) {
    // Dashboard already loaded once successfully to get this far — a
    // transient failure on refresh isn't worth interrupting the user.
  }
}

// ---------- คำขอจองจากเกษตรกร ----------
const BOOKING_STATUS_LABEL_TH = {
  Requested: "รอการยืนยัน",
  Accepted: "รับจองแล้ว",
  Declined: "ปฏิเสธแล้ว",
  Cancelled: "ยกเลิกโดยเกษตรกร",
};
const BOOKING_STATUS_BADGE_CLASS = {
  Requested: "status-pending",
  Accepted: "status-active",
  Declined: "status-declined",
  Cancelled: "status-declined",
};

function bookingCard(b) {
  const badgeClass = BOOKING_STATUS_BADGE_CLASS[b.status] || "status-pending";
  const badge = `<span class="badge ${badgeClass}">${escapeHtml(BOOKING_STATUS_LABEL_TH[b.status] || b.status)}</span>`;

  let actions = "";
  if (b.status === "Requested") {
    actions = `
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm" data-accept-booking="${b.booking_id}">รับจอง</button>
      </div>
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-decline-reason-for="${b.booking_id}" placeholder="เหตุผลการปฏิเสธ (ไม่บังคับ)" />
        <button type="button" class="btn btn-decline btn-sm" data-decline-booking="${b.booking_id}">ปฏิเสธ</button>
      </div>
    `;
  }

  return `
    <div class="item-card" data-booking-id="${b.booking_id}">
      <div class="row"><span class="title">${escapeHtml(b.farmer_name)} — ${escapeHtml(b.venue_name)}</span>${badge}</div>
      <div class="detail-line">สินค้า: ${escapeHtml(b.product_type)}${b.quantity_note ? " · ปริมาณโดยประมาณ: " + escapeHtml(b.quantity_note) : ""}</div>
      <div class="detail-line">วันที่ต้องการใช้พื้นที่: ${escapeHtml(b.preferred_date)}</div>
      ${b.fee_amount ? `<div class="detail-line muted">ค่าบริการ (จ่ายหน้างานโดยตรง): ${Number(b.fee_amount).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(b.fee_unit || "")}</div>` : ""}
      ${b.farmer_note ? `<div class="detail-line muted">หมายเหตุจากเกษตรกร: ${escapeHtml(b.farmer_note)}</div>` : ""}
      <div class="detail-line muted">โทร: ${escapeHtml(b.farmer_phone || "-")}</div>
      ${b.decided_reason ? `<div class="detail-line muted">เหตุผล: ${escapeHtml(b.decided_reason)}</div>` : ""}
      <div class="detail-line muted">ขอจองเมื่อ ${thaiDate(b.requested_at)}</div>
      ${actions}
    </div>
  `;
}

async function loadBookingReviewQueue() {
  const el = document.getElementById("bookingReviewQueueSection");
  try {
    const bookings = await AgroLinkMarketVenueAPI.get("/marketvenue/bookings?status=action_needed");
    if (bookings.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีคำขอจองที่ต้องดำเนินการในขณะนี้</div>`;
      return;
    }
    el.innerHTML = bookings.map(bookingCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำขอจองไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadBookingHistory() {
  const el = document.getElementById("bookingHistorySection");
  const status = document.getElementById("bookingStatusFilter").value;
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const bookings = await AgroLinkMarketVenueAPI.get(`/marketvenue/bookings${query}`);
    if (bookings.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีคำขอจอง</div>`;
      return;
    }
    el.innerHTML = bookings.map(bookingCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประวัติคำขอจองไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function refreshBookingsAndSummary() {
  await Promise.all([loadBookingReviewQueue(), loadBookingHistory(), refreshSummary()]);
}

document.getElementById("bookingStatusFilter").addEventListener("change", () => loadBookingHistory());

function handleBookingActionClick(container) {
  container.addEventListener("click", async (e) => {
    const acceptBtn = e.target.closest("[data-accept-booking]");
    const declineBtn = e.target.closest("[data-decline-booking]");

    if (acceptBtn) {
      const bookingId = acceptBtn.dataset.acceptBooking;
      acceptBtn.disabled = true;
      try {
        await AgroLinkMarketVenueAPI.post(`/marketvenue/bookings/${bookingId}/accept`, {});
        toast("รับจองเรียบร้อยแล้ว");
        await refreshBookingsAndSummary();
      } catch (err) {
        toast("รับจองไม่สำเร็จ: " + err.message, true);
        acceptBtn.disabled = false;
      }
      return;
    }

    if (declineBtn) {
      const bookingId = declineBtn.dataset.declineBooking;
      const reasonInput = container.querySelector(`[data-decline-reason-for="${bookingId}"]`);
      declineBtn.disabled = true;
      try {
        await AgroLinkMarketVenueAPI.post(`/marketvenue/bookings/${bookingId}/decline`, {
          reason: (reasonInput && reasonInput.value.trim()) || null,
        });
        toast("ปฏิเสธคำขอจองเรียบร้อยแล้ว");
        await refreshBookingsAndSummary();
      } catch (err) {
        toast("ปฏิเสธคำขอจองไม่สำเร็จ: " + err.message, true);
        declineBtn.disabled = false;
      }
    }
  });
}

handleBookingActionClick(document.getElementById("bookingReviewQueueSection"));
handleBookingActionClick(document.getElementById("bookingHistorySection"));

// ---------- แบบฟอร์มเพิ่ม/แก้ไขพื้นที่ประกาศ ----------
const listingForm = document.getElementById("listingForm");
const editingListingIdInput = document.getElementById("editingListingId");
const listingSubmitBtn = document.getElementById("listingSubmitBtn");
const listingCancelEditBtn = document.getElementById("listingCancelEditBtn");

function resetListingForm() {
  listingForm.reset();
  editingListingIdInput.value = "";
  listingSubmitBtn.textContent = "เพิ่มพื้นที่ประกาศ";
  listingCancelEditBtn.style.display = "none";
}

function startEditingListing(l) {
  editingListingIdInput.value = l.listing_id;
  document.getElementById("venueNameInput").value = l.venue_name;
  document.getElementById("venueTypeSelect").value = l.venue_type;
  document.getElementById("provinceSelect").value = l.province_code;
  document.getElementById("feeAmountInput").value = l.fee_amount || "";
  document.getElementById("feeUnitInput").value = l.fee_unit || "";
  document.getElementById("addressDetailInput").value = l.address_detail || "";
  document.getElementById("acceptedProductsInput").value = l.accepted_products || "";
  document.getElementById("spaceDescriptionInput").value = l.space_description || "";
  document.getElementById("scheduleNoteInput").value = l.schedule_note || "";
  listingSubmitBtn.textContent = "บันทึกการแก้ไข";
  listingCancelEditBtn.style.display = "inline-block";
  listingForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

listingCancelEditBtn.addEventListener("click", () => resetListingForm());

listingForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const listingId = editingListingIdInput.value;
  const feeAmountRaw = document.getElementById("feeAmountInput").value;
  const payload = {
    venue_name: document.getElementById("venueNameInput").value.trim(),
    venue_type: document.getElementById("venueTypeSelect").value,
    province_code: document.getElementById("provinceSelect").value,
    fee_amount: feeAmountRaw === "" ? null : Number(feeAmountRaw),
    fee_unit: document.getElementById("feeUnitInput").value.trim() || null,
    address_detail: document.getElementById("addressDetailInput").value.trim() || null,
    accepted_products: document.getElementById("acceptedProductsInput").value.trim() || null,
    space_description: document.getElementById("spaceDescriptionInput").value.trim() || null,
    schedule_note: document.getElementById("scheduleNoteInput").value.trim() || null,
  };

  if (!payload.venue_name) {
    toast("กรุณากรอกชื่อสถานที่/ตลาด", true);
    return;
  }

  listingSubmitBtn.disabled = true;
  try {
    if (listingId) {
      await AgroLinkMarketVenueAPI.put(`/marketvenue/listings/${listingId}`, payload);
      toast("บันทึกการแก้ไขพื้นที่ประกาศเรียบร้อยแล้ว");
    } else {
      await AgroLinkMarketVenueAPI.post("/marketvenue/listings", payload);
      toast("เพิ่มพื้นที่ประกาศเรียบร้อยแล้ว");
    }
    resetListingForm();
    await Promise.all([loadListings(), refreshSummary()]);
  } catch (err) {
    toast("บันทึกไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    listingSubmitBtn.disabled = false;
  }
});

// ---------- พื้นที่ประกาศของท่าน ----------
function listingCard(l) {
  return `
    <div class="item-card" data-listing-id="${l.listing_id}">
      <div class="row">
        <span class="title">${escapeHtml(l.venue_name)}</span>
        <span class="badge ${l.is_active ? "status-active" : "status-declined"}">${l.is_active ? "เปิดประกาศ" : "ปิดประกาศ"}</span>
      </div>
      <div class="detail-line">${escapeHtml(VENUE_TYPE_LABEL_TH[l.venue_type] || l.venue_type)} · ${escapeHtml(provinceName(l.province_code))}</div>
      ${l.address_detail ? `<div class="detail-line muted">${escapeHtml(l.address_detail)}</div>` : ""}
      ${l.space_description ? `<div class="detail-line muted">${escapeHtml(l.space_description)}</div>` : ""}
      ${l.accepted_products ? `<div class="detail-line muted">รับสินค้า: ${escapeHtml(l.accepted_products)}</div>` : ""}
      ${l.schedule_note ? `<div class="detail-line muted">ช่วงเวลา: ${escapeHtml(l.schedule_note)}</div>` : ""}
      ${l.fee_amount ? `<div class="detail-line" style="font-weight:700; color:var(--green-900);">${Number(l.fee_amount).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(l.fee_unit || "")}</div>` : `<div class="detail-line muted">ไม่มีค่าบริการ</div>`}

      <div class="action-row">
        <button type="button" class="btn btn-sm btn-ghost" data-edit="${l.listing_id}">แก้ไข</button>
        <button type="button" class="btn btn-sm btn-decline" data-deactivate="${l.listing_id}">${l.is_active ? "ปิดประกาศ" : "ลบออกจากรายการ"}</button>
      </div>
    </div>
  `;
}

let listingsCache = [];

async function loadListings() {
  const el = document.getElementById("listingListSection");
  try {
    const listings = await AgroLinkMarketVenueAPI.get("/marketvenue/listings");
    listingsCache = listings;
    if (listings.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีพื้นที่ประกาศ — เพิ่มพื้นที่แรกของท่านได้ด้านบน</div>`;
      return;
    }
    el.innerHTML = listings.map(listingCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดพื้นที่ประกาศไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("listingListSection").addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit]");
  const deactivateBtn = e.target.closest("[data-deactivate]");

  if (editBtn) {
    const listingId = editBtn.dataset.edit;
    const listing = listingsCache.find((l) => l.listing_id === listingId);
    if (listing) startEditingListing(listing);
    return;
  }

  if (deactivateBtn) {
    const listingId = deactivateBtn.dataset.deactivate;
    deactivateBtn.disabled = true;
    try {
      await AgroLinkMarketVenueAPI.del(`/marketvenue/listings/${listingId}`);
      toast("ปิดพื้นที่ประกาศเรียบร้อยแล้ว");
      if (editingListingIdInput.value === listingId) resetListingForm();
      await Promise.all([loadListings(), refreshSummary()]);
    } catch (err) {
      toast("ดำเนินการไม่สำเร็จ: " + err.message, true);
      deactivateBtn.disabled = false;
    }
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkMarketVenueAPI.logout());

/**
 * GET /marketvenue/dashboard doubles as the KYB/role gate check here —
 * same pattern as every other portal's init().
 */
async function init() {
  const session = AgroLinkMarketVenueAPI.requireSessionOrRedirect();
  if (!session) return;

  try {
    const d = await AgroLinkMarketVenueAPI.get("/marketvenue/dashboard");
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

  loadBookingReviewQueue();
  loadBookingHistory();
  loadListings();
}

init();
