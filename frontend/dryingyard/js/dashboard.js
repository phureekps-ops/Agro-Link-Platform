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

// ---------- พื้นที่ให้บริการ (จังหวัด/อำเภอ) ----------
// See GET/PUT /machinery/service-regions (backend/src/routes/
// machinery.js) — this portal shares that same backend endpoint with the
// machinery portal (see js/api.js's doc comment for why: DryingYardService
// is one of the five org_types requireMachineryOrg already accepts).
function serviceRegionsCheckboxesHtml(selected) {
  const selectedSet = new Set(selected || []);
  const districtsByProvince = {};
  TH_DISTRICTS.forEach(([code, name, provinceCode]) => {
    if (!districtsByProvince[provinceCode]) districtsByProvince[provinceCode] = [];
    districtsByProvince[provinceCode].push([code, name]);
  });
  return TH_PROVINCES.map(([provinceCode, provinceName]) => {
    const districts = districtsByProvince[provinceCode] || [];
    const districtCheckboxesHtml = districts.map(([code, name]) => `
      <label style="display:inline-flex; align-items:center; gap:6px; width:45%; min-width:130px; margin:0 0 6px; font-size:12px; font-weight:400; vertical-align:top;">
        <input type="checkbox" value="${code}" ${selectedSet.has(code) ? "checked" : ""} />
        ${escapeHtml(name)}
      </label>
    `).join("");
    return `
      <details style="margin-bottom:4px; border-bottom:1px solid #eee; padding-bottom:4px;">
        <summary style="cursor:pointer; display:flex; align-items:center; gap:6px; font-size:13px; font-weight:600; padding:4px 0;">
          <input type="checkbox" value="${provinceCode}" ${selectedSet.has(provinceCode) ? "checked" : ""} onclick="event.stopPropagation()" />
          <span>${escapeHtml(provinceName)}</span>
          ${districts.length ? `<span style="font-weight:400; color:#888; font-size:11px;">(${districts.length} อำเภอ)</span>` : ""}
        </summary>
        ${districts.length ? `<div style="padding:4px 0 4px 24px;">${districtCheckboxesHtml}</div>` : ""}
      </details>
    `;
  }).join("");
}

async function loadServiceRegions() {
  const el = document.getElementById("serviceRegionsCheckboxes");
  try {
    const { service_regions: regions } = await AgroLinkMachineryAPI.get("/machinery/service-regions");
    el.innerHTML = serviceRegionsCheckboxesHtml(regions);
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดพื้นที่ให้บริการไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("serviceRegionsSaveBtn").addEventListener("click", async () => {
  const checked = Array.from(
    document.querySelectorAll('#serviceRegionsCheckboxes input[type="checkbox"]:checked'),
  ).map((cb) => cb.value);
  const btn = document.getElementById("serviceRegionsSaveBtn");
  btn.disabled = true;
  try {
    await AgroLinkMachineryAPI.put("/machinery/service-regions", { service_regions: checked });
    toast("บันทึกพื้นที่ให้บริการเรียบร้อยแล้ว");
  } catch (err) {
    toast("บันทึกไม่สำเร็จ: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// node-pg returns a plain `date` column (preferred_date has no time
// component) as a full ISO timestamp string once JSON-serialized (e.g.
// "2026-09-01T00:00:00.000Z") — this trims it back to just the date so the
// card doesn't show a confusing midnight-UTC timestamp for a date-only field.
function dateOnly(value) {
  if (!value) return "-";
  return String(value).slice(0, 10);
}

const SERVICE_TYPE_LABEL_TH = {
  MachineryService: "ผู้ให้บริการเครื่องจักรกล",
  TractorService: "บริการรถไถ",
  DroneService: "บริการโดรน/ฉีดพ่นสารเคมี",
  HarvesterService: "บริการรถเกี่ยวข้าว",
  TruckService: "บริการรถบรรทุก",
  DryingYardService: "บริการลานตากข้าว/โกดังและไซโล",
};

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
        เมื่อได้รับการอนุมัติแล้ว ท่านจะสามารถตั้งราคาค่าบริการและลงรูปภาพได้เต็มรูปแบบ —
        ลองเข้าสู่ระบบใหม่อีกครั้งในภายหลัง หรือรีเฟรชหน้านี้
      </div>
    </div>
  `;
}

/**
 * Split out of the combined machinery/drying-yard portal on 2026-09-12 —
 * this copy's wording only ever talks about the "ลานตาก" role, even
 * though the backend still reports role_type as the generic 'machinery'
 * (holding ANY ONE of its five recognized org_types is enough — see
 * requireMachineryOrg's doc comment in src/routes/machinery.js). An org
 * that holds a machinery-only role rather than DryingYardService can still
 * technically pass this gate — see js/api.js's doc comment for why that
 * tradeoff was accepted for this split.
 */
function showRolePendingNotice(orgName, roleStatus) {
  document.getElementById("orgName").textContent = orgName || "-";
  const body = !roleStatus
    ? {
        title: "องค์กรของท่านยังไม่มีบทบาทผู้ให้บริการลานตาก/โกดังและไซโล",
        detail: "หากต้องการเปิดใช้งานพอร์ทัลนี้ ท่านสามารถส่งคำขอเพิ่มบทบาท \"บริการลานตากข้าว/โกดังและไซโล\" ได้จากหน้า \"จัดการบทบาทธุรกิจ\"",
      }
    : roleStatus === "Rejected"
    ? { title: "คำขอบทบาทผู้ให้บริการลานตาก/โกดังและไซโลของท่านถูกปฏิเสธ", detail: "กรุณาติดต่อเจ้าหน้าที่ผู้ดูแลระบบสำหรับข้อมูลเพิ่มเติม" }
    : { title: "คำขอบทบาทผู้ให้บริการลานตาก/โกดังและไซโลของท่านอยู่ระหว่างการตรวจสอบ", detail: "เจ้าหน้าที่ผู้ดูแลระบบ (Platform Ops) กำลังตรวจสอบคำขอนี้ — ลองรีเฟรชหน้านี้อีกครั้งภายหลัง" };

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
// "รายการที่ตั้งราคาแล้ว" is intentionally NOT d.priced_items_count /
// d.total_rate_card_items here — those two numbers still count across all
// 9 shared machinery/drying-yard rate-card keys (see src/routes/
// machinery.js's RATE_CARD_ITEMS), because splitting that count out
// per-portal would need a backend change. This portal only ever shows/
// edits the single 'drying' key (see loadRateCard below), so the stat card
// is instead filled in by loadRateCard once it knows that key's own price
// — see id="pricedItemsStat" below.
function renderSummary(d) {
  document.getElementById("orgName").textContent = d.org_name || "-";
  const serviceTypesLabel = (d.service_types || []).map((t) => SERVICE_TYPE_LABEL_TH[t] || t).join(", ") || "-";
  document.getElementById("summarySection").innerHTML = `
    <div class="stat-card"><div class="label">สถานะ KYB</div><div class="value" style="font-size:16px;">${escapeHtml(d.kyb_status)}</div></div>
    <div class="stat-card"><div class="label">บทบาทที่ผ่านการตรวจสอบ</div><div class="value" style="font-size:14px;">${escapeHtml(serviceTypesLabel)}</div></div>
    <div class="stat-card"><div class="label">ราคาค่าบริการลานตาก</div><div class="value" id="pricedItemsStat">–</div></div>
    <div class="stat-card"><div class="label">รูปภาพที่อัปโหลด</div><div class="value">${d.photo_count}</div></div>
    <div class="stat-card"><div class="label">คำขอจองที่รอดำเนินการ</div><div class="value">${d.pending_bookings_count || 0}</div></div>
  `;
}

// ---------- คำขอจองบริการ ----------
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
      <div class="row"><span class="title">${escapeHtml(b.farmer_name)} — ${escapeHtml(b.label_th)}</span>${badge}</div>
      <div class="detail-line">วันที่ต้องการใช้บริการ: ${escapeHtml(dateOnly(b.preferred_date))}${b.quantity_note ? " · ปริมาณโดยประมาณ: " + escapeHtml(b.quantity_note) : ""}</div>
      <div class="detail-line muted">ราคา: ${Number(b.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(b.price_unit || "")}</div>
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
    const bookings = await AgroLinkMachineryAPI.get("/machinery/bookings?status=action_needed");
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
    const bookings = await AgroLinkMachineryAPI.get(`/machinery/bookings${query}`);
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
        await AgroLinkMachineryAPI.post(`/machinery/bookings/${bookingId}/accept`, {});
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
        await AgroLinkMachineryAPI.post(`/machinery/bookings/${bookingId}/decline`, {
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

async function refreshSummary() {
  try {
    const d = await AgroLinkMachineryAPI.get("/machinery/dashboard");
    renderSummary(d);
  } catch (err) {
    // Dashboard already loaded once successfully to get this far — a
    // transient failure on refresh isn't worth interrupting the user.
  }
}

// ---------- ราคาค่าบริการลานตาก ----------
// This portal only shows/edits the single 'drying' rate-card key (see the
// doc comment on renderSummary above) — the other 8 keys in the shared
// RATE_CARD_ITEMS table belong to the machinery portal instead.
const DRYING_YARD_SERVICE_KEY = "drying";

async function loadRateCard() {
  const el = document.getElementById("rateCardFormSection");
  try {
    const d = await AgroLinkMachineryAPI.get("/machinery/rate-card");
    const dryingItem = d.items.find((item) => item.service_key === DRYING_YARD_SERVICE_KEY);
    const pricedStat = document.getElementById("pricedItemsStat");
    if (pricedStat) {
      pricedStat.textContent = dryingItem && dryingItem.unit_price !== null ? "ตั้งราคาแล้ว" : "ยังไม่ตั้งราคา";
    }
    if (!dryingItem) {
      el.innerHTML = `<div class="empty-state">ไม่พบรายการราคาค่าบริการลานตาก</div>`;
      return;
    }
    el.innerHTML = `
      <div class="field">
        <label for="rate-${escapeHtml(dryingItem.service_key)}">${escapeHtml(dryingItem.label_th)} (${escapeHtml(dryingItem.price_unit)})</label>
        <input type="number" min="0" step="0.01" id="rate-${escapeHtml(dryingItem.service_key)}" data-service-key="${escapeHtml(dryingItem.service_key)}" value="${dryingItem.unit_price !== null ? dryingItem.unit_price : ""}" placeholder="ยังไม่ตั้งราคา" />
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดตารางราคาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("rateCardSubmitBtn").addEventListener("click", async () => {
  const inputs = document.querySelectorAll("#rateCardFormSection [data-service-key]");
  const prices = {};
  inputs.forEach((input) => {
    const raw = input.value.trim();
    prices[input.dataset.serviceKey] = raw === "" ? null : Number(raw);
  });

  const btn = document.getElementById("rateCardSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkMachineryAPI.put("/machinery/rate-card", { prices });
    toast("บันทึกราคาเรียบร้อยแล้ว");
    await Promise.all([loadRateCard(), refreshSummary()]);
  } catch (err) {
    toast("บันทึกไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- รูปภาพ ----------
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

function photoCard(photo) {
  return `
    <div class="photo-card" data-photo-id="${photo.photo_id}">
      <img src="${photo.photo_data_url}" alt="${escapeHtml(photo.caption || "")}" />
      <button type="button" class="photo-remove" title="ลบรูปภาพ" data-photo-id="${photo.photo_id}">✕</button>
      <div class="photo-meta">
        ${photo.caption ? `<div class="photo-caption">${escapeHtml(photo.caption)}</div>` : ""}
        <div class="detail-line muted">${photo.photo_type === "machinery" ? "ลาน/สิ่งอำนวยความสะดวก" : "การให้บริการ"} · ${thaiDate(photo.created_at)}</div>
      </div>
    </div>
  `;
}

async function loadPhotos() {
  const el = document.getElementById("photoGallerySection");
  try {
    const photos = await AgroLinkMachineryAPI.get("/machinery/photos");
    if (photos.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีรูปภาพ — เพิ่มรูปแรกของท่านได้ด้านบน</div>`;
      return;
    }
    el.innerHTML = photos.map(photoCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรูปภาพไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("photoUploadBtn").addEventListener("click", async () => {
  const fileInput = document.getElementById("photoFileInput");
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    toast("กรุณาเลือกไฟล์รูปภาพ", true);
    return;
  }
  if (!file.type.startsWith("image/")) {
    toast("กรุณาเลือกไฟล์รูปภาพเท่านั้น", true);
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    toast("ไฟล์รูปภาพใหญ่เกินไป (สูงสุด 2MB)", true);
    return;
  }

  const btn = document.getElementById("photoUploadBtn");
  btn.disabled = true;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    await AgroLinkMachineryAPI.post("/machinery/photos", {
      photo_type: document.getElementById("photoTypeSelect").value,
      photo_data_url: dataUrl,
      caption: document.getElementById("photoCaptionInput").value.trim() || null,
    });
    toast("อัปโหลดรูปภาพเรียบร้อยแล้ว");
    fileInput.value = "";
    document.getElementById("photoCaptionInput").value = "";
    await Promise.all([loadPhotos(), refreshSummary()]);
  } catch (err) {
    toast("อัปโหลดรูปภาพไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("photoGallerySection").addEventListener("click", async (e) => {
  const removeBtn = e.target.closest(".photo-remove");
  if (!removeBtn) return;
  const photoId = removeBtn.dataset.photoId;
  removeBtn.disabled = true;
  try {
    await AgroLinkMachineryAPI.del(`/machinery/photos/${photoId}`);
    toast("ลบรูปภาพเรียบร้อยแล้ว");
    await Promise.all([loadPhotos(), refreshSummary()]);
  } catch (err) {
    toast("ลบรูปภาพไม่สำเร็จ: " + err.message, true);
    removeBtn.disabled = false;
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkMachineryAPI.logout());

/**
 * GET /machinery/dashboard doubles as the KYB/role gate check here — same
 * pattern as every other portal's init().
 */
async function init() {
  const session = AgroLinkMachineryAPI.requireSessionOrRedirect();
  if (!session) return;

  try {
    const d = await AgroLinkMachineryAPI.get("/machinery/dashboard");
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

  loadServiceRegions();
  loadBookingReviewQueue();
  loadBookingHistory();
  loadRateCard();
  loadPhotos();
}

init();
