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

// node-pg returns a plain `date` column (preferred_date has no time
// component) as a full ISO timestamp string once JSON-serialized (e.g.
// "2026-09-01T00:00:00.000Z") — this trims it back to just the date so the
// card doesn't show a confusing midnight-UTC timestamp for a date-only field.
function dateOnly(value) {
  if (!value) return "-";
  return String(value).slice(0, 10);
}

const BOOKING_STATUS_LABEL_TH = {
  Requested: "รอการยืนยัน",
  Accepted: "รับจองแล้ว",
  Declined: "ปฏิเสธแล้ว",
  Cancelled: "ยกเลิกแล้ว",
};
const BOOKING_STATUS_BADGE_CLASS = {
  Requested: "status-pending",
  Accepted: "status-active",
  Declined: "status-declined",
  Cancelled: "status-declined",
};

// ---------- ผู้ให้บริการ ----------
// Backend (GET /farmer/machinery-providers) already sorts featured
// listings first — this just renders the "⭐ แนะนำ" badge, it does not
// re-sort anything client-side.
function providerCard(p) {
  return `
    <div class="item-card" data-listing-id="${p.listing_id}">
      <div class="row"><span class="title">${p.featured ? "⭐ " : ""}${escapeHtml(p.org_name)}</span></div>
      ${p.featured ? `<div class="detail-line"><span class="badge status-approved">⭐ แนะนำ</span></div>` : ""}
      <div class="detail-line">${escapeHtml(p.label_th)}</div>
      <div class="detail-line muted">ราคา: ${Number(p.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(p.price_unit || "")}</div>
      <div class="action-row">
        <button type="button" class="btn btn-primary btn-sm" data-book-from="${p.listing_id}" data-org-name="${escapeHtml(p.org_name)}" data-label-th="${escapeHtml(p.label_th)}">จองบริการนี้</button>
      </div>
    </div>
  `;
}

async function loadProviders() {
  const el = document.getElementById("providerListSection");
  const serviceType = document.getElementById("serviceTypeFilter").value;
  try {
    const query = serviceType ? `?service_type=${encodeURIComponent(serviceType)}` : "";
    const providers = await AgroLinkAPI.get(`/farmer/machinery-providers${query}`);
    if (providers.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีผู้ให้บริการเครื่องจักรกล/ลานตากที่เปิดรับในขณะนี้</div>`;
      return;
    }
    el.innerHTML = providers.map(providerCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดผู้ให้บริการไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("serviceTypeFilter").addEventListener("change", () => loadProviders());

document.getElementById("providerListSection").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-book-from]");
  if (!btn) return;
  document.getElementById("bookingListingId").value = btn.dataset.bookFrom;
  document.getElementById("bookingLabel").textContent = `${btn.dataset.orgName} — ${btn.dataset.labelTh}`;
  document.getElementById("bookingFormTitle").style.display = "block";
  document.getElementById("bookingForm").style.display = "block";
  document.getElementById("bookingForm").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.getElementById("bookingCancelBtn").addEventListener("click", () => {
  document.getElementById("bookingFormTitle").style.display = "none";
  document.getElementById("bookingForm").style.display = "none";
  document.getElementById("bookingForm").reset();
});

// ---------- ส่งคำขอจอง ----------
document.getElementById("bookingForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const listingId = document.getElementById("bookingListingId").value;
  const preferredDate = document.getElementById("bookingPreferredDate").value;

  if (!preferredDate) {
    toast("กรุณาเลือกวันที่ต้องการใช้บริการ", true);
    return;
  }

  const payload = {
    listing_id: listingId,
    preferred_date: preferredDate,
    quantity_note: document.getElementById("bookingQuantityNote").value.trim() || undefined,
    farmer_note: document.getElementById("bookingFarmerNote").value.trim() || undefined,
  };

  const btn = document.getElementById("bookingSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkAPI.post("/farmer/machinery-bookings", payload);
    toast("ส่งคำขอจองเรียบร้อยแล้ว");
    document.getElementById("bookingForm").reset();
    document.getElementById("bookingFormTitle").style.display = "none";
    document.getElementById("bookingForm").style.display = "none";
    await loadBookingHistory();
  } catch (err) {
    toast("ส่งคำขอจองไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- คำขอจองของท่าน ----------
function bookingCard(b) {
  const badgeClass = BOOKING_STATUS_BADGE_CLASS[b.status] || "status-pending";
  const badge = `<span class="badge ${badgeClass}">${escapeHtml(BOOKING_STATUS_LABEL_TH[b.status] || b.status)}</span>`;
  let actions = "";
  if (b.status === "Requested") {
    actions = `
      <div class="action-row">
        <button type="button" class="btn btn-decline btn-sm" data-cancel-booking="${b.booking_id}">ยกเลิกคำขอ</button>
      </div>
    `;
  }
  return `
    <div class="item-card" data-booking-id="${b.booking_id}">
      <div class="row"><span class="title">${escapeHtml(b.org_name)} — ${escapeHtml(b.label_th)}</span>${badge}</div>
      <div class="detail-line">วันที่ต้องการใช้บริการ: ${escapeHtml(dateOnly(b.preferred_date))}${b.quantity_note ? " · ปริมาณโดยประมาณ: " + escapeHtml(b.quantity_note) : ""}</div>
      <div class="detail-line muted">ค่าบริการ (จ่ายหน้างานโดยตรง): ${Number(b.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(b.price_unit || "")}</div>
      ${b.farmer_note ? `<div class="detail-line muted">หมายเหตุ: ${escapeHtml(b.farmer_note)}</div>` : ""}
      ${b.decided_reason ? `<div class="detail-line muted">เหตุผล: ${escapeHtml(b.decided_reason)}</div>` : ""}
      <div class="detail-line muted">ขอจองเมื่อ ${thaiDate(b.requested_at)}</div>
      ${actions}
    </div>
  `;
}

async function loadBookingHistory() {
  const el = document.getElementById("bookingHistorySection");
  try {
    const bookings = await AgroLinkAPI.get("/farmer/machinery-bookings");
    if (bookings.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีคำขอจอง</div>`;
      return;
    }
    el.innerHTML = bookings.map(bookingCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำขอจองไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("bookingHistorySection").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-cancel-booking]");
  if (!btn) return;
  const bookingId = btn.dataset.cancelBooking;
  btn.disabled = true;
  try {
    await AgroLinkAPI.post(`/farmer/machinery-bookings/${bookingId}/cancel`, {});
    toast("ยกเลิกคำขอจองเรียบร้อยแล้ว");
    await loadBookingHistory();
  } catch (err) {
    toast("ยกเลิกไม่สำเร็จ: " + err.message, true);
    btn.disabled = false;
  }
});

// ---------- เริ่มต้น ----------
async function init() {
  await loadProviders();
  await loadBookingHistory();
}

init();
