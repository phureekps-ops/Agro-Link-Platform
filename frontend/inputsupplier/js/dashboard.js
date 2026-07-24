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

const CATEGORY_LABEL_TH = {
  fertilizer_hormone: "ปุ๋ย/ฮอร์โมน",
  chemical_pesticide: "สารเคมีและยาปราบศัตรูพืช",
  equipment: "อุปกรณ์การเกษตร",
  other: "อื่นๆ",
};

/**
 * Replaces the whole dashboard body with a "your KYB application is under
 * review" notice — same shape/reasoning as every other portal's own copy
 * (see machinery/js/dashboard.js's showKybPendingNotice doc comment).
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
        เมื่อได้รับการอนุมัติแล้ว ท่านจะสามารถลงแค็ตตาล็อกสินค้าได้เต็มรูปแบบ —
        ลองเข้าสู่ระบบใหม่อีกครั้งในภายหลัง หรือรีเฟรชหน้านี้
      </div>
    </div>
  `;
}

/**
 * Same shape as machinery/js/dashboard.js's showRolePendingNotice — the
 * org has cleared entity KYB but doesn't (yet) hold a Verified
 * 'InputSupplier' role.
 */
function showRolePendingNotice(orgName, roleStatus) {
  document.getElementById("orgName").textContent = orgName || "-";
  const body = !roleStatus
    ? {
        title: "องค์กรของท่านยังไม่มีบทบาทผู้จำหน่ายปัจจัยการผลิต",
        detail: "หากต้องการเปิดใช้งานพอร์ทัลนี้ ท่านสามารถส่งคำขอเพิ่มบทบาทได้จากหน้า \"จัดการบทบาทธุรกิจ\"",
      }
    : roleStatus === "Rejected"
    ? { title: "คำขอบทบาทผู้จำหน่ายปัจจัยการผลิตของท่านถูกปฏิเสธ", detail: "กรุณาติดต่อเจ้าหน้าที่ผู้ดูแลระบบสำหรับข้อมูลเพิ่มเติม" }
    : { title: "คำขอบทบาทผู้จำหน่ายปัจจัยการผลิตของท่านอยู่ระหว่างการตรวจสอบ", detail: "เจ้าหน้าที่ผู้ดูแลระบบ (Platform Ops) กำลังตรวจสอบคำขอนี้ — ลองรีเฟรชหน้านี้อีกครั้งภายหลัง" };

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
  const byCat = d.products_by_category || {};
  document.getElementById("summarySection").innerHTML = `
    <div class="stat-card"><div class="label">สถานะ KYB</div><div class="value" style="font-size:16px;">${escapeHtml(d.kyb_status)}</div></div>
    <div class="stat-card"><div class="label">สินค้าที่ลงขายทั้งหมด</div><div class="value">${d.total_active_products}</div></div>
    <div class="stat-card"><div class="label">ปุ๋ย/ฮอร์โมน</div><div class="value">${byCat.fertilizer_hormone || 0}</div></div>
    <div class="stat-card"><div class="label">สารเคมี/ยาปราบศัตรูพืช</div><div class="value">${byCat.chemical_pesticide || 0}</div></div>
    <div class="stat-card"><div class="label">อุปกรณ์การเกษตร</div><div class="value">${byCat.equipment || 0}</div></div>
    <div class="stat-card"><div class="label">รูปภาพที่อัปโหลด</div><div class="value">${d.photo_count}</div></div>
  `;
}

async function refreshSummary() {
  try {
    const d = await AgroLinkInputSupplierAPI.get("/inputsupplier/dashboard");
    renderSummary(d);
  } catch (err) {
    // Dashboard already loaded once successfully to get this far — a
    // transient failure on refresh isn't worth interrupting the user.
  }
}

// ---------- แบบฟอร์มเพิ่ม/แก้ไขสินค้า ----------
const productForm = document.getElementById("productForm");
const editingListingIdInput = document.getElementById("editingListingId");
const productSubmitBtn = document.getElementById("productSubmitBtn");
const productCancelEditBtn = document.getElementById("productCancelEditBtn");

function resetProductForm() {
  productForm.reset();
  document.getElementById("priceUnitInput").value = "บาท/หน่วย";
  editingListingIdInput.value = "";
  productSubmitBtn.textContent = "เพิ่มสินค้า";
  productCancelEditBtn.style.display = "none";
}

function startEditingProduct(p) {
  editingListingIdInput.value = p.listing_id;
  document.getElementById("categorySelect").value = p.category;
  document.getElementById("productNameInput").value = p.product_name;
  document.getElementById("brandInput").value = p.brand || "";
  document.getElementById("priceInput").value = p.unit_price;
  document.getElementById("priceUnitInput").value = p.price_unit;
  document.getElementById("descriptionInput").value = p.description || "";
  productSubmitBtn.textContent = "บันทึกการแก้ไข";
  productCancelEditBtn.style.display = "inline-block";
  productForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

productCancelEditBtn.addEventListener("click", () => resetProductForm());

productForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const listingId = editingListingIdInput.value;
  const payload = {
    category: document.getElementById("categorySelect").value,
    product_name: document.getElementById("productNameInput").value.trim(),
    brand: document.getElementById("brandInput").value.trim() || null,
    description: document.getElementById("descriptionInput").value.trim() || null,
    unit_price: Number(document.getElementById("priceInput").value),
    price_unit: document.getElementById("priceUnitInput").value.trim() || "บาท/หน่วย",
  };

  if (!payload.product_name) {
    toast("กรุณากรอกชื่อสินค้า", true);
    return;
  }
  if (!Number.isFinite(payload.unit_price) || payload.unit_price <= 0) {
    toast("กรุณากรอกราคาที่มากกว่า 0", true);
    return;
  }

  productSubmitBtn.disabled = true;
  try {
    if (listingId) {
      await AgroLinkInputSupplierAPI.put(`/inputsupplier/products/${listingId}`, payload);
      toast("บันทึกการแก้ไขสินค้าเรียบร้อยแล้ว");
    } else {
      await AgroLinkInputSupplierAPI.post("/inputsupplier/products", payload);
      toast("เพิ่มสินค้าเรียบร้อยแล้ว");
    }
    resetProductForm();
    await Promise.all([loadProducts(), refreshSummary()]);
  } catch (err) {
    toast("บันทึกไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
  } finally {
    productSubmitBtn.disabled = false;
  }
});

// ---------- แค็ตตาล็อกสินค้า ----------
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

function productPhotoThumb(photo, listingId) {
  return `
    <div class="photo-card" data-photo-id="${photo.photo_id}" style="width:80px; height:80px;">
      <img src="${photo.photo_data_url}" alt="${escapeHtml(photo.caption || "")}" />
      <button type="button" class="photo-remove" title="ลบรูปภาพ" data-listing-id="${listingId}" data-photo-id="${photo.photo_id}">✕</button>
    </div>
  `;
}

function productCard(p) {
  const photosHtml = (p.photos || [])
    .map((photo) => productPhotoThumb(photo, p.listing_id))
    .join("");
  return `
    <div class="item-card" data-listing-id="${p.listing_id}">
      <div class="row">
        <span class="title">${escapeHtml(p.product_name)}${p.brand ? " · " + escapeHtml(p.brand) : ""}</span>
        <span class="badge ${p.is_active ? "status-active" : "status-declined"}">${p.is_active ? "กำลังขาย" : "ปิดการขาย"}</span>
      </div>
      <div class="detail-line">${escapeHtml(CATEGORY_LABEL_TH[p.category] || p.category)}</div>
      <div class="detail-line muted">${escapeHtml(p.description || "")}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">
        ${Number(p.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(p.price_unit)}
      </div>

      <div class="photo-grid" style="grid-template-columns:repeat(auto-fill, minmax(80px, 1fr)); margin:10px 0;" data-photo-grid="${p.listing_id}">
        ${photosHtml || `<div class="muted" style="font-size:12px;">ยังไม่มีรูปภาพสินค้านี้</div>`}
      </div>
      <div class="action-row">
        <input type="file" accept="image/*" data-photo-file="${p.listing_id}" style="max-width:220px;" />
        <button type="button" class="btn btn-sm btn-ghost" data-upload-photo="${p.listing_id}">อัปโหลดรูป</button>
      </div>

      <div class="action-row">
        <button type="button" class="btn btn-sm btn-ghost" data-edit="${p.listing_id}">แก้ไข</button>
        <button type="button" class="btn btn-sm btn-decline" data-delete="${p.listing_id}">ลบสินค้า</button>
      </div>
    </div>
  `;
}

let productsCache = [];

async function loadProductPhotos(listingId) {
  try {
    return await AgroLinkInputSupplierAPI.get(`/inputsupplier/products/${listingId}/photos`);
  } catch (err) {
    return [];
  }
}

async function loadProducts() {
  const el = document.getElementById("productListSection");
  const category = document.getElementById("categoryFilter").value;
  try {
    const query = category ? `?category=${encodeURIComponent(category)}` : "";
    const products = await AgroLinkInputSupplierAPI.get(`/inputsupplier/products${query}`);
    if (products.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีสินค้าในแค็ตตาล็อก — เพิ่มสินค้าแรกของท่านได้ด้านบน</div>`;
      productsCache = [];
      return;
    }
    // Fetch each product's photos in parallel so the gallery renders in
    // one pass rather than a second per-card round trip after the fact.
    const withPhotos = await Promise.all(
      products.map(async (p) => ({ ...p, photos: await loadProductPhotos(p.listing_id) })),
    );
    productsCache = withPhotos;
    el.innerHTML = withPhotos.map(productCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดแค็ตตาล็อกสินค้าไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("categoryFilter").addEventListener("change", () => loadProducts());

document.getElementById("productListSection").addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit]");
  const deleteBtn = e.target.closest("[data-delete]");
  const uploadBtn = e.target.closest("[data-upload-photo]");
  const removePhotoBtn = e.target.closest(".photo-remove");

  if (editBtn) {
    const listingId = editBtn.dataset.edit;
    const product = productsCache.find((p) => p.listing_id === listingId);
    if (product) startEditingProduct(product);
    return;
  }

  if (deleteBtn) {
    const listingId = deleteBtn.dataset.delete;
    deleteBtn.disabled = true;
    try {
      await AgroLinkInputSupplierAPI.del(`/inputsupplier/products/${listingId}`);
      toast("ลบสินค้าเรียบร้อยแล้ว");
      if (editingListingIdInput.value === listingId) resetProductForm();
      await Promise.all([loadProducts(), refreshSummary()]);
    } catch (err) {
      toast("ลบสินค้าไม่สำเร็จ: " + err.message, true);
      deleteBtn.disabled = false;
    }
    return;
  }

  if (uploadBtn) {
    const listingId = uploadBtn.dataset.uploadPhoto;
    const fileInput = document.querySelector(`input[data-photo-file="${listingId}"]`);
    const file = fileInput && fileInput.files && fileInput.files[0];
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
    uploadBtn.disabled = true;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      await AgroLinkInputSupplierAPI.post(`/inputsupplier/products/${listingId}/photos`, {
        photo_data_url: dataUrl,
        caption: null,
      });
      toast("อัปโหลดรูปภาพเรียบร้อยแล้ว");
      await Promise.all([loadProducts(), refreshSummary()]);
    } catch (err) {
      toast("อัปโหลดรูปภาพไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
    } finally {
      uploadBtn.disabled = false;
    }
    return;
  }

  if (removePhotoBtn) {
    const listingId = removePhotoBtn.dataset.listingId;
    const photoId = removePhotoBtn.dataset.photoId;
    removePhotoBtn.disabled = true;
    try {
      await AgroLinkInputSupplierAPI.del(`/inputsupplier/products/${listingId}/photos/${photoId}`);
      toast("ลบรูปภาพเรียบร้อยแล้ว");
      await Promise.all([loadProducts(), refreshSummary()]);
    } catch (err) {
      toast("ลบรูปภาพไม่สำเร็จ: " + err.message, true);
      removePhotoBtn.disabled = false;
    }
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkInputSupplierAPI.logout());

/**
 * GET /inputsupplier/dashboard doubles as the KYB/role gate check here —
 * same pattern as every other portal's init().
 */
async function init() {
  const session = AgroLinkInputSupplierAPI.requireSessionOrRedirect();
  if (!session) return;

  try {
    const d = await AgroLinkInputSupplierAPI.get("/inputsupplier/dashboard");
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

  loadProducts();
}

init();
