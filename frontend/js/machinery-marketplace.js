/**
 * AgroLink — บริการเครื่องจักรกล/ลานตาก (machinery-marketplace.html).
 *
 * Backs GET /farmer/machinery-providers, POST/GET /farmer/machinery-bookings,
 * and POST /farmer/machinery-bookings/:id/cancel. Same pattern as
 * venue-marketplace.js (the selling-space browse+book page) — lives at the
 * Farmer Portal's top level, reuses AgroLinkAPI/agrolink_farmer_session, no
 * login of its own.
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

// Same seven fixed rate-card items as backend/src/routes/machinery.js's
// RATE_CARD_ITEMS — duplicated locally, matching this project's established
// pattern of small local constant duplicates across plain <script> files
// with no shared module bundler (see SERVICE_TYPE_LABEL_TH in
// frontend/machinery/js/dashboard.js).
const SERVICE_KEY_LABEL_TH = {
  plow_rough: "ไถดะ",
  plow_secondary_seed: "ไถแปรและหว่าน",
  rotary_till: "ปั่นดิน",
  spraying: "ฉีดพ่นสารเคมี (โดรน/รถฉีดพ่น)",
  harvesting: "เกี่ยวข้าว",
  trucking: "ขนส่งด้วยรถบรรทุก",
  drying: "ลานตากข้าว/ตากผลผลิต",
};

const BOOKING_STATUS_LABEL_TH = {
  Requested: "รอการยืนยันจากผู้ให้บริการ",
  Accepted: "รับคำขอแล้ว",
  Declined: "ผู้ให้บริการปฏิเสธ",
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

function provinceName(code) {
  const found = TH_PROVINCES.find((p) => p[0] === code);
  return found ? found[1] : code;
}

// ---------- ผู้ให้บริการ ----------
function listingCard(l) {
  const regions = (l.service_regions || []).map(provinceName).join(", ");
  return `
    <div class="item-card" data-listing-id="${l.listing_id}">
      <div class="row">
        <span class="title">${escapeHtml(l.org_name)}</span>
        <span class="badge status-active">${escapeHtml(SERVICE_KEY_LABEL_TH[l.service_key] || l.service_key)}</span>
      </div>
      ${regions ? `<div class="detail-line muted">พื้นที่ให้บริการ: ${escapeHtml(regions)}</div>` : ""}
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">${Number(l.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(l.price_unit || "")} (ชำระหน้างานโดยตรง)</div>
      <div class="action-row">
        <button type="button" class="btn btn-primary btn-sm" data-request-booking="${l.listing_id}"
                data-label="${escapeHtml((SERVICE_KEY_LABEL_TH[l.service_key] || l.service_key) + ' — ' + l.org_name)}">
          ขอใช้บริการนี้
        </button>
      </div>
    </div>
  `;
}

async function loadListings() {
  const el = document.getElementById("listingListSection");
  const serviceKey = document.getElementById("serviceKeyFilter").value;
  const provinceCode = document.getElementById("provinceFilter").value;
  try {
    const params = new URLSearchParams();
    if (serviceKey) params.set("service_key", serviceKey);
    if (provinceCode) params.set("province_code", provinceCode);
    const query = params.toString() ? `?${params.toString()}` : "";
    const listings = await AgroLinkAPI.get(`/farmer/machinery-providers${query}`);
    if (listings.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่พบผู้ให้บริการตามเงื่อนไขที่เลือก</div>`;
      return;
    }
    el.innerHTML = listings.map(listingCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดผู้ให้บริการไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("serviceKeyFilter").addEventListener("change", () => loadListings());
document.getElementById("provinceFilter").addEventListener("change", () => loadListings());

// ---------- แบบฟอร์มขอใช้บริการ ----------
const bookingForm = document.getElementById("bookingForm");
const bookingFormTitle = document.getElementById("bookingFormTitle");
const bookingListingIdInput = document.getElementById("bookingListingId");
const bookingLabel = document.getElementById("bookingLabel");

function openBookingForm(listingId, label) {
  bookingListingIdInput.value = listingId;
  bookingLabel.textContent = `บริการ: ${label}`;
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
  openBookingForm(btn.dataset.requestBooking, btn.dataset.label);
});

document.getElementById("bookingCancelBtn").addEventListener("click", () => closeBookingForm());

bookingForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    listing_id: bookingListingIdInput.value,
    quantity_note: document.getElementById("bookingQuantityNote").value.trim() || null,
    preferred_date: document.getElementById("bookingPreferredDate").value,
    farmer_note: document.getElementById("bookingFarmerNote").value.trim() || null,
  };

  if (!payload.preferred_date) {
    toast("กรุณาเลือกวันที่ต้องการใช้บริการ", true);
    return;
  }

  const submitBtn = document.getElementById("bookingSubmitBtn");
  submitBtn.disabled = true;
  try {
    await AgroLinkAPI.post("/farmer/machinery-bookings", payload);
    toast("ส่งคำขอใช้บริการเรียบร้อยแล้ว รอผู้ให้บริการยืนยัน");
    closeBookingForm();
    await loadBookingHistory();
  } catch (err) {
    toast("ส่งคำขอไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- คำขอใช้บริการของท่าน ----------
function bookingCard(b) {
  const badgeClass = BOOKING_STATUS_BADGE_CLASS[b.status] || "status-pending";
  const badge = `<span class="badge ${badgeClass}">${escapeHtml(BOOKING_STATUS_LABEL_TH[b.status] || b.status)}</span>`;
  const cancelBtn = b.status === "Requested"
    ? `<div class="action-row"><button type="button" class="btn btn-decline btn-sm" data-cancel-booking="${b.booking_id}">ยกเลิกคำขอ</button></div>`
    : "";

  return `
    <div class="item-card" data-booking-id="${b.booking_id}">
      <div class="row"><span class="title">${escapeHtml(b.label_th)} — ${escapeHtml(b.org_name)}</span>${badge}</div>
      ${b.quantity_note ? `<div class="detail-line">พื้นที่/ปริมาณโดยประมาณ: ${escapeHtml(b.quantity_note)}</div>` : ""}
      <div class="detail-line">วันที่ต้องการใช้บริการ: ${escapeHtml(b.preferred_date)}</div>
      <div class="detail-line muted">ค่าบริการ (ชำระหน้างาน): ${Number(b.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(b.price_unit || "")}</div>
      ${b.farmer_note ? `<div class="detail-line muted">หมายเหตุของท่าน: ${escapeHtml(b.farmer_note)}</div>` : ""}
      ${b.decided_reason ? `<div class="detail-line muted">เหตุผลจากผู้ให้บริการ: ${escapeHtml(b.decided_reason)}</div>` : ""}
      <div class="detail-line muted">ขอใช้บริการเมื่อ ${thaiDate(b.requested_at)}</div>
      ${cancelBtn}
    </div>
  `;
}

async function loadBookingHistory() {
  const el = document.getElementById("bookingHistorySection");
  try {
    const bookings = await AgroLinkAPI.get("/farmer/machinery-bookings");
    if (bookings.length === 0) {
      el.innerHTML = `<div class="empty-state">ท่านยังไม่เคยขอใช้บริการเครื่องจักรกล/ลานตาก</div>`;
      return;
    }
    el.innerHTML = bookings.map(bookingCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำขอใช้บริการไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("bookingHistorySection").addEventListener("click", async (e) => {
  const cancelBtn = e.target.closest("[data-cancel-booking]");
  if (!cancelBtn) return;

  const bookingId = cancelBtn.dataset.cancelBooking;
  cancelBtn.disabled = true;
  try {
    await AgroLinkAPI.post(`/farmer/machinery-bookings/${bookingId}/cancel`, {});
    toast("ยกเลิกคำขอใช้บริการเรียบร้อยแล้ว");
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
