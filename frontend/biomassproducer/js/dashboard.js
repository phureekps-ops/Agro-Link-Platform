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

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

/**
 * Replaces the whole dashboard body with a "your KYB application is under
 * review" notice — same shape as every other portal's own copy (see
 * inputsupplier/js/dashboard.js's showKybPendingNotice doc comment).
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
        เมื่อได้รับการอนุมัติแล้ว ท่านจะสามารถตั้งค่าโปรไฟล์และประเภทสินค้าได้เต็มรูปแบบ —
        ลองเข้าสู่ระบบใหม่อีกครั้งในภายหลัง หรือรีเฟรชหน้านี้
      </div>
    </div>
  `;
}

/**
 * Same shape as showRolePendingNotice in every other multi-role portal
 * (dryingyard/lender/machinery) — see those files' own doc comments.
 */
function showRolePendingNotice(orgName, roleStatus) {
  document.getElementById("orgName").textContent = orgName || "-";
  const body = !roleStatus
    ? {
        title: "องค์กรของท่านยังไม่มีบทบาทผู้ผลิตสินค้าจากชีวมวล",
        detail: "หากต้องการเปิดใช้งานพอร์ทัลนี้ ท่านสามารถส่งคำขอเพิ่มบทบาท \"ผู้ผลิตสินค้าจากชีวมวล\" ได้จากหน้า \"จัดการบทบาทธุรกิจ\"",
      }
    : roleStatus === "Rejected"
    ? { title: "คำขอบทบาทผู้ผลิตสินค้าจากชีวมวลของท่านถูกปฏิเสธ", detail: "กรุณาติดต่อเจ้าหน้าที่ผู้ดูแลระบบสำหรับข้อมูลเพิ่มเติม" }
    : { title: "คำขอบทบาทผู้ผลิตสินค้าจากชีวมวลของท่านอยู่ระหว่างการตรวจสอบ", detail: "เจ้าหน้าที่ผู้ดูแลระบบ (Platform Ops) กำลังตรวจสอบคำขอนี้ — ลองรีเฟรชหน้านี้อีกครั้งภายหลัง" };

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
  const selectedCount = (d.product_types || []).filter((p) => p.selected).length;
  const locationLabel = d.region_code ? `${escapeHtml(d.region_code)}${d.district_code ? " / " + escapeHtml(d.district_code) : ""}` : "ยังไม่ได้ระบุ";
  document.getElementById("summarySection").innerHTML = `
    <div class="stat-card"><div class="label">การแสดงผลการ์ด</div><div class="value" style="font-size:16px;">${d.card_visible ? "✅ แสดงอยู่" : "⛔ ซ่อนอยู่/ยังไม่กรอกโปรไฟล์"}</div></div>
    <div class="stat-card"><div class="label">ประเภทสินค้าที่เลือก</div><div class="value">${selectedCount} / ${(d.product_types || []).length}</div></div>
    <div class="stat-card"><div class="label">จังหวัด/อำเภอขององค์กร</div><div class="value" style="font-size:14px;">${locationLabel}</div></div>
  `;
}

// ---------- ประเภทสินค้าที่ผลิต ----------
function productTypeGridHtml(productTypes) {
  return productTypes.map((p) => `
    <label class="product-check${p.selected ? " checked" : ""}" data-product-check>
      <input type="checkbox" value="${escapeHtml(p.product_type)}" ${p.selected ? "checked" : ""} />
      ${escapeHtml(p.label_th)}
    </label>
  `).join("");
}

function wireProductCheckboxStyling() {
  document.querySelectorAll("#productTypeGrid [data-product-check]").forEach((label) => {
    const input = label.querySelector("input");
    input.addEventListener("change", () => {
      label.classList.toggle("checked", input.checked);
    });
  });
}

async function loadDashboard() {
  const d = await AgroLinkBiomassProducerAPI.get("/biomass/dashboard");
  renderSummary(d);

  document.getElementById("productTypeGrid").innerHTML = productTypeGridHtml(d.product_types || []);
  wireProductCheckboxStyling();

  const profile = d.profile || {};
  document.getElementById("descriptionInput").value = profile.description || "";
  document.getElementById("capacityNoteInput").value = profile.capacity_note || "";
  document.getElementById("contactPhoneInput").value = profile.contact_phone || "";
  document.getElementById("isActiveSelect").value = String(profile.is_active !== false);
  if (profile.cover_photo_data_url) {
    document.getElementById("coverPhotoPreview").src = profile.cover_photo_data_url;
    document.getElementById("coverPhotoPreviewWrap").style.display = "block";
  }
  // Keep the already-uploaded photo unless the org picks a new file —
  // stashed here so profileSaveBtn's handler can fall back to it.
  window.__currentCoverPhotoDataUrl = profile.cover_photo_data_url || null;

  return d;
}

document.getElementById("productTypeSaveBtn").addEventListener("click", async () => {
  const checked = Array.from(
    document.querySelectorAll('#productTypeGrid input[type="checkbox"]:checked'),
  ).map((cb) => cb.value);
  const btn = document.getElementById("productTypeSaveBtn");
  btn.disabled = true;
  try {
    const result = await AgroLinkBiomassProducerAPI.put("/biomass/products", { product_types: checked });
    document.getElementById("productTypeGrid").innerHTML = productTypeGridHtml(result.product_types || []);
    wireProductCheckboxStyling();
    toast("บันทึกประเภทสินค้าเรียบร้อยแล้ว");
    refreshSummary();
  } catch (err) {
    toast("บันทึกไม่สำเร็จ: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("coverPhotoFileInput").addEventListener("change", async () => {
  const fileInput = document.getElementById("coverPhotoFileInput");
  const file = fileInput.files[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    toast("กรุณาเลือกไฟล์รูปภาพเท่านั้น", true);
    fileInput.value = "";
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    toast("ไฟล์รูปภาพใหญ่เกินไป (สูงสุด 2MB)", true);
    fileInput.value = "";
    return;
  }
  const dataUrl = await readFileAsDataUrl(file);
  window.__currentCoverPhotoDataUrl = dataUrl;
  document.getElementById("coverPhotoPreview").src = dataUrl;
  document.getElementById("coverPhotoPreviewWrap").style.display = "block";
});

document.getElementById("profileSaveBtn").addEventListener("click", async () => {
  const btn = document.getElementById("profileSaveBtn");
  btn.disabled = true;
  try {
    await AgroLinkBiomassProducerAPI.put("/biomass/profile", {
      description: document.getElementById("descriptionInput").value.trim() || null,
      capacity_note: document.getElementById("capacityNoteInput").value.trim() || null,
      contact_phone: document.getElementById("contactPhoneInput").value.trim() || null,
      cover_photo_data_url: window.__currentCoverPhotoDataUrl || null,
      is_active: document.getElementById("isActiveSelect").value === "true",
    });
    toast("บันทึกโปรไฟล์เรียบร้อยแล้ว");
    refreshSummary();
  } catch (err) {
    toast("บันทึกไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

async function refreshSummary() {
  try {
    const d = await AgroLinkBiomassProducerAPI.get("/biomass/dashboard");
    renderSummary(d);
  } catch (err) {
    // Non-fatal — the dashboard already rendered once; a transient
    // refresh failure shouldn't disrupt the page.
  }
}

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkBiomassProducerAPI.logout());

/**
 * GET /biomass/dashboard doubles as the KYB/role gate check here — same
 * pattern as every other portal's own init().
 */
async function init() {
  const session = AgroLinkBiomassProducerAPI.requireSessionOrRedirect();
  if (!session) return;

  try {
    await loadDashboard();
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
  }
}

init();
