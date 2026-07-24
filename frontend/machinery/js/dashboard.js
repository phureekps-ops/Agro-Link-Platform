const session = AgroLinkMachineryAPI.requireSessionOrRedirect();

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

const PHOTO_TYPE_LABEL = { machinery: "รูปเครื่องจักรกล", service: "รูปการให้บริการ" };

/**
 * Replaces the whole dashboard body with a "your KYB application is under
 * review" notice — used only when GET /machinery/dashboard itself reports
 * kyb_not_verified (a real machinery/drying-yard-org token, just not yet
 * approved by Platform Ops, e.g. right after registering via
 * register-provider.html). Deliberately does NOT log the user out —
 * refreshing this same page after approval will show the real dashboard
 * with no need to log in again. Same pattern as lender/buyer.
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
        เมื่อได้รับการอนุมัติแล้ว ท่านจะสามารถเข้าใช้งานพอร์ทัลผู้ให้บริการเครื่องจักรกล/ลานตากได้เต็มรูปแบบ —
        ลองเข้าสู่ระบบใหม่อีกครั้งในภายหลัง หรือรีเฟรชหน้านี้
      </div>
    </div>
  `;
}

// ---------- ภาพรวม ----------
function renderSummary(d) {
  document.getElementById("orgName").textContent = d.org_name || "-";
  document.getElementById("summarySection").innerHTML = `
    <div class="stat-card"><div class="label">ประเภทบริการ</div><div class="value" style="font-size:16px;">${escapeHtml(d.org_type)}</div></div>
    <div class="stat-card"><div class="label">สถานะ KYB</div><div class="value" style="font-size:16px;">${escapeHtml(d.kyb_status)}</div></div>
    <div class="stat-card"><div class="label">บริการที่ตั้งราคาแล้ว</div><div class="value">${d.priced_items_count} / ${d.total_rate_card_items}</div></div>
    <div class="stat-card"><div class="label">รูปภาพที่อัปโหลด</div><div class="value">${d.photo_count}</div></div>
  `;
}

// ---------- ราคาบริการ (Rate Card) ----------
function rateCardFieldRow(item) {
  return `
    <div class="field">
      <label for="price_${item.service_key}">${escapeHtml(item.label_th)} (${escapeHtml(item.price_unit)})</label>
      <input type="number" id="price_${item.service_key}" data-service-key="${item.service_key}"
             min="0" step="0.01" placeholder="ไม่ได้ให้บริการนี้"
             value="${item.unit_price !== null ? item.unit_price : ""}" />
    </div>
  `;
}

async function loadRateCard() {
  const el = document.getElementById("rateCardFields");
  try {
    const { items } = await AgroLinkMachineryAPI.get("/machinery/rate-card");
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
    await AgroLinkMachineryAPI.put("/machinery/rate-card", { prices });
    toast("บันทึกราคาบริการเรียบร้อยแล้ว");
    await Promise.all([loadRateCard(), refreshSummary()]);
  } catch (err) {
    toast("บันทึกราคาบริการไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

async function refreshSummary() {
  try {
    const d = await AgroLinkMachineryAPI.get("/machinery/dashboard");
    renderSummary(d);
  } catch (err) {
    // Dashboard already loaded once successfully to get this far — a
    // transient failure on refresh isn't worth interrupting the user.
  }
}

// ---------- รูปภาพบริการ/เครื่องจักรกล ----------
function photoCard(p) {
  return `
    <div class="photo-card" data-photo-id="${p.photo_id}">
      <img src="${p.photo_data_url}" alt="${escapeHtml(p.caption || PHOTO_TYPE_LABEL[p.photo_type] || "")}" />
      <button type="button" class="photo-remove" title="ลบรูปภาพ" data-photo-id="${p.photo_id}">✕</button>
      <div class="photo-meta">
        <div class="photo-caption">${escapeHtml(p.caption || PHOTO_TYPE_LABEL[p.photo_type] || "")}</div>
        <div style="font-size:11px; color:var(--gray-500);">${escapeHtml(PHOTO_TYPE_LABEL[p.photo_type] || p.photo_type)}</div>
      </div>
    </div>
  `;
}

async function loadPhotos() {
  const el = document.getElementById("photoGallery");
  try {
    const photos = await AgroLinkMachineryAPI.get("/machinery/photos");
    if (photos.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีรูปภาพ — อัปโหลดรูปเครื่องจักรกลหรือรูปการให้บริการของท่านได้ด้านบน</div>`;
      return;
    }
    el.innerHTML = photos.map(photoCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรูปภาพไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

document.getElementById("photoUploadBtn").addEventListener("click", async () => {
  const btn = document.getElementById("photoUploadBtn");
  const fileInput = document.getElementById("photoFileInput");
  const photoType = document.getElementById("photoTypeSelect").value;
  const caption = document.getElementById("photoCaptionInput").value.trim();
  const file = fileInput.files && fileInput.files[0];

  if (!file) {
    toast("กรุณาเลือกไฟล์รูปภาพ", true);
    return;
  }
  if (!file.type.startsWith("image/")) {
    toast("กรุณาเลือกไฟล์รูปภาพเท่านั้น", true);
    return;
  }
  // Matches the backend's ~3MB data: URL cap (base64 inflates size ~33%,
  // so a comfortable margin under the raw file size is used here).
  if (file.size > 2 * 1024 * 1024) {
    toast("ไฟล์รูปภาพใหญ่เกินไป (สูงสุด 2MB)", true);
    return;
  }

  btn.disabled = true;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    await AgroLinkMachineryAPI.post("/machinery/photos", {
      photo_type: photoType,
      photo_data_url: dataUrl,
      caption: caption || null,
    });
    toast("อัปโหลดรูปภาพเรียบร้อยแล้ว");
    fileInput.value = "";
    document.getElementById("photoCaptionInput").value = "";
    await Promise.all([loadPhotos(), refreshSummary()]);
  } catch (err) {
    toast("อัปโหลดรูปภาพไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("photoGallery").addEventListener("click", async (e) => {
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
 * GET /machinery/dashboard doubles as the KYB gate check here: if it
 * reports kyb_not_verified, none of the other endpoints would succeed
 * either (same requireMachineryOrg middleware guards all of them), so
 * there's no point firing them — just show the pending notice and stop.
 * Same pattern as lender/js/dashboard.js and buyer/js/dashboard.js.
 */
async function init() {
  try {
    const d = await AgroLinkMachineryAPI.get("/machinery/dashboard");
    renderSummary(d);
  } catch (err) {
    if (err.message === "kyb_not_verified") {
      showKybPendingNotice(err.body.org_name, err.body.kyb_status);
      return;
    }
    document.getElementById("summarySection").innerHTML = `<div class="empty-state">โหลดข้อมูลภาพรวมไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    return;
  }

  // Only reached once KYB is confirmed Verified — independent panels below,
  // one broken panel doesn't take down the rest of the page.
  loadRateCard();
  loadPhotos();
}

init();
