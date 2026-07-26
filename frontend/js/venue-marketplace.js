/**
 * AgroLink — หาที่ขายสินค้า (venue-marketplace.html).
 *
 * Backs GET /farmer/venue-listings, POST/GET /farmer/venue-bookings, and
 * POST /farmer/venue-bookings/:id/cancel. Same pattern as marketplace.js
 * (the InputSupplier browse+order page) — lives at the Farmer Portal's top
 * level, reuses AgroLinkAPI/agrolink_farmer_session, no login of its own.
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

const VENUE_TYPE_LABEL_TH = {
  wholesale_market: "ตลาดค้าส่ง",
  fresh_market: "ตลาดสด",
  popup_market: "ตลาดนัด/ตลาดชั่วคราว",
  other: "อื่นๆ",
};

const BOOKING_STATUS_LABEL_TH = {
  Requested: "รอการยืนยันจากเจ้าของสถานที่",
  Accepted: "รับจองแล้ว",
  Declined: "เจ้าของสถานที่ปฏิเสธ",
  Cancelled: "ยกเลิกแล้ว",
};
const BOOKING_STATUS_BADGE_CLASS = {
  Requested: "status-pending",
  Accepted: "status-active",
  Declined: "status-declined",
  Cancelled: "status-declined",
};

// Populate the province filter from TH_PROVINCES (frontend/js/provinces.js).
const provinceFilter = document.getElementById("provinceFilter");
TH_PROVINCES.forEach(([code, name]) => {
  const opt = document.createElement("option");
  opt.value = code;
  opt.textContent = name;
  provinceFilter.appendChild(opt);
});

// ---------- พื้นที่ขายสินค้า ----------
function listingCard(l) {
  return `
    <div class="item-card" data-listing-id="${l.listing_id}">
      <div class="row">
        <span class="title">${escapeHtml(l.venue_name)}</span>
        <span class="badge status-active">${escapeHtml(VENUE_TYPE_LABEL_TH[l.venue_type] || l.venue_type)}</span>
      </div>
      <div class="detail-line">ผู้ดูแล: ${escapeHtml(l.org_name)}</div>
      ${l.address_detail ? `<div class="detail-line muted">${escapeHtml(l.address_detail)}</div>` : ""}
      ${l.space_description ? `<div class="detail-line muted">${escapeHtml(l.space_description)}</div>` : ""}
      ${l.accepted_products ? `<div class="detail-line muted">รับสินค้า: ${escapeHtml(l.accepted_products)}</div>` : ""}
      ${l.schedule_note ? `<div class="detail-line muted">ช่วงเวลา: ${escapeHtml(l.schedule_note)}</div>` : ""}
      ${l.fee_amount ? `<div class="detail-line" style="font-weight:700; color:var(--green-900);">${Number(l.fee_amount).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(l.fee_unit || "")} (ชำระหน้างานโดยตรง)</div>` : `<div class="detail-line muted">ไม่มีค่าบริการ</div>`}
      <div class="action-row">
        <button type="button" class="btn btn-primary btn-sm" data-request-booking="${l.listing_id}" data-venue-name="${escapeHtml(l.venue_name)}">ขอจองพื้นที่นี้</button>
      </div>
    </div>
  `;
}

async function loadListings() {
  const el = document.getElementById("listingListSection");
  const venueType = document.getElementById("venueTypeFilter").value;
  const provinceCode = document.getElementById("provinceFilter").value;
  try {
    const params = new URLSearchParams();
    if (venueType) params.set("venue_type", venueType);
    if (provinceCode) params.set("province_code", provinceCode);
    const query = params.toString() ? `?${params.toString()}` : "";
    const listings = await AgroLinkAPI.get(`/farmer/venue-listings${query}`);
    if (listings.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่พบพื้นที่ขายสินค้าตามเงื่อนไขที่เลือก</div>`;
      return;
    }
    el.innerHTML = listings.map(listingCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดพื้นที่ขายสินค้าไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("venueTypeFilter").addEventListener("change", () => loadListings());
document.getElementById("provinceFilter").addEventListener("change", () => loadListings());

// ---------- แบบฟอร์มขอจอง ----------
const bookingForm = document.getElementById("bookingForm");
const bookingFormTitle = document.getElementById("bookingFormTitle");
const bookingListingIdInput = document.getElementById("bookingListingId");
const bookingVenueNameLabel = document.getElementById("bookingVenueNameLabel");

function openBookingForm(listingId, venueName) {
  bookingListingIdInput.value = listingId;
  bookingVenueNameLabel.textContent = `สถานที่: ${venueName}`;
  bookingFormTitle.style.display = "flex";
  bookingForm.style.display = "block";
  bookingForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeBookingForm() {
  bookingForm.reset();
  bookingListingIdInput.value = "";
  bookingFormTitle.style.display = "none";
  bookingForm.style.display = "none";
}

document.getElementById("listingListSection").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-request-booking]");
  if (!btn) return;
  openBookingForm(btn.dataset.requestBooking, btn.dataset.venueName);
});

document.getElementById("bookingCancelBtn").addEventListener("click", () => closeBookingForm());

bookingForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    listing_id: bookingListingIdInput.value,
    product_type: document.getElementById("bookingProductType").value.trim(),
    quantity_note: document.getElementById("bookingQuantityNote").value.trim() || null,
    preferred_date: document.getElementById("bookingPreferredDate").value,
    farmer_note: document.getElementById("bookingFarmerNote").value.trim() || null,
  };

  if (!payload.product_type || !payload.preferred_date) {
    toast("กรุณากรอกชนิดสินค้าและวันที่ให้ครบถ้วน", true);
    return;
  }

  const submitBtn = document.getElementById("bookingSubmitBtn");
  submitBtn.disabled = true;
  try {
    await AgroLinkAPI.post("/farmer/venue-bookings", payload);
    toast("ส่งคำขอจองเรียบร้อยแล้ว รอเจ้าของสถานที่ยืนยัน");
    closeBookingForm();
    await loadBookingHistory();
  } catch (err) {
    toast("ส่งคำขอไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- คำขอจองของท่าน ----------
function bookingCard(b) {
  const badgeClass = BOOKING_STATUS_BADGE_CLASS[b.status] || "status-pending";
  const badge = `<span class="badge ${badgeClass}">${escapeHtml(BOOKING_STATUS_LABEL_TH[b.status] || b.status)}</span>`;
  const cancelBtn = b.status === "Requested"
    ? `<div class="action-row"><button type="button" class="btn btn-decline btn-sm" data-cancel-booking="${b.booking_id}">ยกเลิกคำขอ</button></div>`
    : "";

  return `
    <div class="item-card" data-booking-id="${b.booking_id}">
      <div class="row"><span class="title">${escapeHtml(b.venue_name)} — ${escapeHtml(b.org_name)}</span>${badge}</div>
      <div class="detail-line">${escapeHtml(VENUE_TYPE_LABEL_TH[b.venue_type] || b.venue_type)} · สินค้า: ${escapeHtml(b.product_type)}</div>
      <div class="detail-line">วันที่ต้องการใช้พื้นที่: ${escapeHtml(b.preferred_date)}</div>
      ${b.fee_amount ? `<div class="detail-line muted">ค่าบริการ (ชำระหน้างาน): ${Number(b.fee_amount).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(b.fee_unit || "")}</div>` : ""}
      ${b.decided_reason ? `<div class="detail-line muted">เหตุผลจากเจ้าของสถานที่: ${escapeHtml(b.decided_reason)}</div>` : ""}
      <div class="detail-line muted">ขอจองเมื่อ ${thaiDate(b.requested_at)}</div>
      ${cancelBtn}
    </div>
  `;
}

async function loadBookingHistory() {
  const el = document.getElementById("bookingHistorySection");
  try {
    const bookings = await AgroLinkAPI.get("/farmer/venue-bookings");
    if (bookings.length === 0) {
      el.innerHTML = `<div class="empty-state">ท่านยังไม่เคยขอจองพื้นที่ขายสินค้า</div>`;
      return;
    }
    el.innerHTML = bookings.map(bookingCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำขอจองไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("bookingHistorySection").addEventListener("click", async (e) => {
  const cancelBtn = e.target.closest("[data-cancel-booking]");
  if (!cancelBtn) return;

  const bookingId = cancelBtn.dataset.cancelBooking;
  cancelBtn.disabled = true;
  try {
    await AgroLinkAPI.post(`/farmer/venue-bookings/${bookingId}/cancel`, {});
    toast("ยกเลิกคำขอจองเรียบร้อยแล้ว");
    await loadBookingHistory();
  } catch (err) {
    toast("ยกเลิกไม่สำเร็จ: " + err.message, true);
    cancelBtn.disabled = false;
  }
});

async function init() {
  await Promise.all([loadListings(), loadBookingHistory()]);
}

init();
