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

// ---------- คำสั่งซื้อจากเกษตรกร ----------
const ORDER_STATUS_LABEL_TH = {
  requested: "รอการยืนยัน",
  confirmed: "ยืนยันแล้ว (รอส่งมอบ)",
  fulfilled: "ส่งมอบแล้ว",
  rejected: "ปฏิเสธแล้ว",
  cancelled: "ยกเลิกโดยเกษตรกร",
};
const ORDER_STATUS_BADGE_CLASS = {
  requested: "status-pending",
  confirmed: "status-approved",
  fulfilled: "status-completed",
  rejected: "status-declined",
  cancelled: "status-declined",
};

function thaiDate(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function orderCard(o) {
  const badgeClass = ORDER_STATUS_BADGE_CLASS[o.status] || "status-pending";
  const badge = `<span class="badge ${badgeClass}">${escapeHtml(ORDER_STATUS_LABEL_TH[o.status] || o.status)}</span>`;

  let actions = "";
  if (o.status === "requested") {
    actions = `
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm" data-confirm-order="${o.order_id}">ยืนยันคำสั่งซื้อ</button>
      </div>
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-reject-reason-for="${o.order_id}" placeholder="เหตุผลการปฏิเสธ (ไม่บังคับ)" />
        <button type="button" class="btn btn-decline btn-sm" data-reject-order="${o.order_id}">ปฏิเสธ</button>
      </div>
    `;
  } else if (o.status === "confirmed") {
    actions = `
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm" data-fulfill-order="${o.order_id}">บันทึกว่าส่งมอบสินค้าแล้ว</button>
      </div>
    `;
  }

  return `
    <div class="item-card" data-order-id="${o.order_id}">
      <div class="row"><span class="title">${escapeHtml(o.farmer_name)} — ${escapeHtml(o.product_name)}</span>${badge}</div>
      <div class="detail-line">${escapeHtml(CATEGORY_LABEL_TH[o.category] || o.category)} · จำนวน ${Number(o.quantity).toLocaleString("th-TH")} x ${Number(o.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(o.price_unit)}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">รวม ${Number(o.total_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท</div>
      ${o.decided_reason ? `<div class="detail-line muted">เหตุผล: ${escapeHtml(o.decided_reason)}</div>` : ""}
      <div class="detail-line muted">สั่งซื้อเมื่อ ${thaiDate(o.requested_at)}</div>
      ${actions}
    </div>
  `;
}

async function loadOrderReviewQueue() {
  const el = document.getElementById("orderReviewQueueSection");
  try {
    const orders = await AgroLinkInputSupplierAPI.get("/inputsupplier/orders?status=action_needed");
    if (orders.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีคำสั่งซื้อที่ต้องดำเนินการในขณะนี้</div>`;
      return;
    }
    el.innerHTML = orders.map(orderCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำสั่งซื้อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadOrderHistory() {
  const el = document.getElementById("orderHistorySection");
  const status = document.getElementById("orderStatusFilter").value;
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const orders = await AgroLinkInputSupplierAPI.get(`/inputsupplier/orders${query}`);
    if (orders.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีคำสั่งซื้อ</div>`;
      return;
    }
    el.innerHTML = orders.map(orderCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประวัติคำสั่งซื้อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function refreshOrdersAndSummary() {
  await Promise.all([loadOrderReviewQueue(), loadOrderHistory(), refreshSummary()]);
}

document.getElementById("orderStatusFilter").addEventListener("change", () => loadOrderHistory());

function handleOrderActionClick(container) {
  container.addEventListener("click", async (e) => {
    const confirmBtn = e.target.closest("[data-confirm-order]");
    const rejectBtn = e.target.closest("[data-reject-order]");
    const fulfillBtn = e.target.closest("[data-fulfill-order]");

    if (confirmBtn) {
      const orderId = confirmBtn.dataset.confirmOrder;
      confirmBtn.disabled = true;
      try {
        await AgroLinkInputSupplierAPI.post(`/inputsupplier/orders/${orderId}/confirm`, {});
        toast("ยืนยันคำสั่งซื้อเรียบร้อยแล้ว");
        await refreshOrdersAndSummary();
      } catch (err) {
        toast("ยืนยันคำสั่งซื้อไม่สำเร็จ: " + err.message, true);
        confirmBtn.disabled = false;
      }
      return;
    }

    if (rejectBtn) {
      const orderId = rejectBtn.dataset.rejectOrder;
      const reasonInput = container.querySelector(`[data-reject-reason-for="${orderId}"]`);
      rejectBtn.disabled = true;
      try {
        await AgroLinkInputSupplierAPI.post(`/inputsupplier/orders/${orderId}/reject`, {
          reason: (reasonInput && reasonInput.value.trim()) || null,
        });
        toast("ปฏิเสธคำสั่งซื้อเรียบร้อยแล้ว");
        await refreshOrdersAndSummary();
      } catch (err) {
        toast("ปฏิเสธคำสั่งซื้อไม่สำเร็จ: " + err.message, true);
        rejectBtn.disabled = false;
      }
      return;
    }

    if (fulfillBtn) {
      const orderId = fulfillBtn.dataset.fulfillOrder;
      fulfillBtn.disabled = true;
      try {
        await AgroLinkInputSupplierAPI.post(`/inputsupplier/orders/${orderId}/fulfill`, {});
        toast("บันทึกการส่งมอบสินค้าเรียบร้อยแล้ว");
        await refreshOrdersAndSummary();
      } catch (err) {
        toast("บันทึกการส่งมอบไม่สำเร็จ: " + err.message, true);
        fulfillBtn.disabled = false;
      }
    }
  });
}

handleOrderActionClick(document.getElementById("orderReviewQueueSection"));
handleOrderActionClick(document.getElementById("orderHistorySection"));

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
// ============================================================
// RFP/RFQ (Request for Proposal / Request for Quote) — cross-portal
// marketplace (see backend/src/routes/procurement.js and backend/db/
// grant_rfq_marketplace.sql). ANY subject (farmer or organization) can
// post/browse/cancel/accept an RFQ; only ORGANIZATIONS can submit/withdraw
// quotes (see procurement.js's own doc comment for the design rationale —
// farmer-to-farmer quoting was judged out of scope for this round). This
// portal is always an organization, so the quoting UI is always shown
// here; the farmer-facing standalone rfq.html hides it instead.
// ============================================================
const RFQ_CATEGORY_LABEL_TH = {
  input_product: "ปัจจัยการผลิต",
  produce: "ผลผลิตทางการเกษตร",
  processed_good: "สินค้าแปรรูป",
  machinery_service: "บริการเครื่องจักรกล",
  other: "อื่นๆ",
};
const RFQ_STATUS_LABEL_TH = {
  open: "เปิดรับใบเสนอราคา",
  awarded: "ตกลงแล้ว",
  cancelled: "ยกเลิกแล้ว",
  closed: "ปิดแล้ว",
};
const RFQ_STATUS_BADGE_CLASS = {
  open: "status-active",
  awarded: "status-approved",
  cancelled: "status-declined",
  closed: "status-pending",
};
const RFQ_QUOTE_STATUS_LABEL_TH = {
  submitted: "รอผลพิจารณา",
  accepted: "ได้รับเลือก",
  rejected: "ไม่ได้รับเลือก",
  withdrawn: "ถอนแล้ว",
};
const RFQ_QUOTE_STATUS_BADGE_CLASS = {
  submitted: "status-pending",
  accepted: "status-approved",
  rejected: "status-declined",
  withdrawn: "status-declined",
};

let rfqMineCache = [];
let rfqIsOrganization = false;

function rfqMoney(n) {
  return Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2 });
}

function rfqThaiDateOnly(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

function rfqMetaLine(r) {
  const parts = [];
  if (r.quantity) parts.push(`จำนวน ${rfqMoney(r.quantity)} ${escapeHtml(r.quantity_unit || "")}`);
  if (r.target_price) parts.push(`ราคาเป้าหมาย ${rfqMoney(r.target_price)} บาท`);
  if (r.delivery_location) parts.push(`ส่งที่ ${escapeHtml(r.delivery_location)}`);
  if (r.needed_by_date) parts.push(`ต้องการภายใน ${rfqThaiDateOnly(r.needed_by_date)}`);
  return parts.join(" · ");
}

function rfqQuoteRow(q, rfqId, rfqStatus) {
  const badgeClass = RFQ_QUOTE_STATUS_BADGE_CLASS[q.status] || "status-pending";
  const canAccept = q.status === "submitted" && rfqStatus === "open";
  return `
    <div class="item-card" style="margin-top:8px;" data-quote-id="${q.quote_id}">
      <div class="row">
        <span class="title">${escapeHtml(q.responder_org_name)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(RFQ_QUOTE_STATUS_LABEL_TH[q.status] || q.status)}</span>
      </div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">
        ${rfqMoney(q.quoted_price)} ${escapeHtml(q.price_unit)}${q.quoted_quantity ? ` · จำนวน ${rfqMoney(q.quoted_quantity)}` : ""}
      </div>
      ${q.message ? `<div class="detail-line muted">${escapeHtml(q.message)}</div>` : ""}
      <div class="detail-line muted">เสนอเมื่อ ${thaiDate(q.submitted_at)}</div>
      ${canAccept ? `
        <div class="action-row">
          <button type="button" class="btn btn-approve btn-sm" data-rfq-accept-quote="${q.quote_id}" data-rfq-accept-rfq="${rfqId}">ยอมรับใบเสนอราคานี้</button>
        </div>
      ` : ""}
    </div>
  `;
}

function rfqMineCard(r) {
  const badgeClass = RFQ_STATUS_BADGE_CLASS[r.status] || "status-pending";
  return `
    <div class="item-card" data-rfq-id="${r.rfq_id}">
      <div class="row">
        <span class="title">${escapeHtml(r.title)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(RFQ_STATUS_LABEL_TH[r.status] || r.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(RFQ_CATEGORY_LABEL_TH[r.category] || r.category)}</div>
      ${r.description ? `<div class="detail-line muted">${escapeHtml(r.description)}</div>` : ""}
      <div class="detail-line muted">${rfqMetaLine(r)}</div>
      <div class="detail-line muted">ประกาศเมื่อ ${thaiDate(r.created_at)}</div>
      <div class="action-row">
        <button type="button" class="btn btn-ghost btn-sm" data-rfq-toggle-quotes="${r.rfq_id}">ดูใบเสนอราคา</button>
        ${r.status === "open" ? `<button type="button" class="btn btn-decline btn-sm" data-rfq-cancel="${r.rfq_id}">ยกเลิกประกาศ</button>` : ""}
      </div>
      <div data-rfq-quotes-container="${r.rfq_id}" style="display:none;"></div>
    </div>
  `;
}

async function loadRfqMine() {
  const el = document.getElementById("rfqMineSection");
  try {
    const list = await AgroLinkInputSupplierAPI.get("/procurement/rfqs/mine");
    rfqMineCache = list;
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ยังไม่มีประกาศของท่าน — ประกาศความต้องการแรกได้ด้านบน</div>`
      : list.map(rfqMineCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประกาศของฉันไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("rfqMineSection").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-rfq-toggle-quotes]");
  const cancelBtn = e.target.closest("[data-rfq-cancel]");
  const acceptBtn = e.target.closest("[data-rfq-accept-quote]");

  if (toggleBtn) {
    const rfqId = toggleBtn.dataset.rfqToggleQuotes;
    const container = document.querySelector(`[data-rfq-quotes-container="${rfqId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    if (!isHidden) {
      container.style.display = "none";
      toggleBtn.textContent = "ดูใบเสนอราคา";
      return;
    }
    container.style.display = "block";
    toggleBtn.textContent = "ซ่อนใบเสนอราคา";
    container.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
    try {
      const quotes = await AgroLinkInputSupplierAPI.get(`/procurement/rfqs/${rfqId}/quotes`);
      const rfq = rfqMineCache.find((r) => r.rfq_id === rfqId);
      const rfqStatus = rfq ? rfq.status : "open";
      container.innerHTML = quotes.length === 0
        ? `<div class="muted" style="font-size:12px; padding:8px 0;">ยังไม่มีใบเสนอราคา</div>`
        : quotes.map((q) => rfqQuoteRow(q, rfqId, rfqStatus)).join("");
    } catch (err) {
      container.innerHTML = `<div class="muted" style="font-size:12px;">โหลดใบเสนอราคาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    }
    return;
  }

  if (cancelBtn) {
    const rfqId = cancelBtn.dataset.rfqCancel;
    if (!confirm("ยืนยันยกเลิกประกาศนี้?")) return;
    cancelBtn.disabled = true;
    try {
      await AgroLinkInputSupplierAPI.post(`/procurement/rfqs/${rfqId}/cancel`, {});
      toast("ยกเลิกประกาศเรียบร้อยแล้ว");
      await loadRfqMine();
    } catch (err) {
      toast("ยกเลิกไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      cancelBtn.disabled = false;
    }
    return;
  }

  if (acceptBtn) {
    const quoteId = acceptBtn.dataset.rfqAcceptQuote;
    const rfqId = acceptBtn.dataset.rfqAcceptRfq;
    if (!confirm("ยืนยันยอมรับใบเสนอราคานี้? ใบเสนอราคาอื่นสำหรับประกาศนี้จะถูกปฏิเสธโดยอัตโนมัติ")) return;
    acceptBtn.disabled = true;
    try {
      await AgroLinkInputSupplierAPI.post(`/procurement/rfqs/${rfqId}/quotes/${quoteId}/accept`, {});
      toast("ยอมรับใบเสนอราคาเรียบร้อยแล้ว");
      await loadRfqMine();
    } catch (err) {
      toast("ยอมรับไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      acceptBtn.disabled = false;
    }
  }
});

document.getElementById("rfqPostForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("rfqPostSubmitBtn");
  const payload = {
    category: document.getElementById("rfqCategorySelect").value,
    title: document.getElementById("rfqTitleInput").value.trim(),
    description: document.getElementById("rfqDescriptionInput").value.trim() || null,
    quantity: document.getElementById("rfqQuantityInput").value ? Number(document.getElementById("rfqQuantityInput").value) : null,
    quantity_unit: document.getElementById("rfqQuantityUnitInput").value.trim() || null,
    target_price: document.getElementById("rfqTargetPriceInput").value ? Number(document.getElementById("rfqTargetPriceInput").value) : null,
    delivery_location: document.getElementById("rfqDeliveryLocationInput").value.trim() || null,
    needed_by_date: document.getElementById("rfqNeededByInput").value || null,
  };
  if (!payload.title) {
    toast("กรุณากรอกหัวข้อ", true);
    return;
  }
  btn.disabled = true;
  try {
    await AgroLinkInputSupplierAPI.post("/procurement/rfqs", payload);
    toast("ประกาศความต้องการเรียบร้อยแล้ว");
    document.getElementById("rfqPostForm").reset();
    await loadRfqMine();
  } catch (err) {
    toast("ประกาศไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
  } finally {
    btn.disabled = false;
  }
});

function rfqBrowseCard(r) {
  const badgeClass = RFQ_STATUS_BADGE_CLASS[r.status] || "status-pending";
  const showQuoteForm = rfqIsOrganization && r.status === "open";
  return `
    <div class="item-card" data-rfq-id="${r.rfq_id}">
      <div class="row">
        <span class="title">${escapeHtml(r.title)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(RFQ_STATUS_LABEL_TH[r.status] || r.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(RFQ_CATEGORY_LABEL_TH[r.category] || r.category)} · โดย ${escapeHtml(r.requester_name || "-")}</div>
      ${r.description ? `<div class="detail-line muted">${escapeHtml(r.description)}</div>` : ""}
      <div class="detail-line muted">${rfqMetaLine(r)}</div>
      ${showQuoteForm ? `
        <div class="action-row">
          <button type="button" class="btn btn-ghost btn-sm" data-rfq-toggle-quote-form="${r.rfq_id}">เสนอราคา</button>
        </div>
        <div data-rfq-quote-form-container="${r.rfq_id}" style="display:none; margin-top:8px;">
          <div class="form-grid">
            <div class="field">
              <label>ราคาที่เสนอ (บาท)</label>
              <input type="number" min="0.01" step="0.01" data-rfq-quote-price="${r.rfq_id}" />
            </div>
            <div class="field">
              <label>จำนวนที่เสนอ (ถ้ามี)</label>
              <input type="number" min="0.01" step="0.01" data-rfq-quote-qty="${r.rfq_id}" />
            </div>
            <div class="field full">
              <label>ข้อความเพิ่มเติม</label>
              <input type="text" data-rfq-quote-message="${r.rfq_id}" />
            </div>
          </div>
          <div class="action-row">
            <button type="button" class="btn btn-primary btn-sm" data-rfq-submit-quote="${r.rfq_id}">ส่งใบเสนอราคา</button>
          </div>
        </div>
      ` : ""}
    </div>
  `;
}

async function loadRfqBrowse() {
  const el = document.getElementById("rfqBrowseSection");
  const category = document.getElementById("rfqBrowseCategoryFilter").value;
  el.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const query = category ? `?category=${encodeURIComponent(category)}` : "";
    const list = await AgroLinkInputSupplierAPI.get(`/procurement/rfqs${query}`);
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ไม่มีประกาศที่เปิดอยู่ในขณะนี้</div>`
      : list.map(rfqBrowseCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประกาศไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("rfqBrowseCategoryFilter").addEventListener("change", () => loadRfqBrowse());

document.getElementById("rfqBrowseSection").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-rfq-toggle-quote-form]");
  const submitBtn = e.target.closest("[data-rfq-submit-quote]");

  if (toggleBtn) {
    const rfqId = toggleBtn.dataset.rfqToggleQuoteForm;
    const container = document.querySelector(`[data-rfq-quote-form-container="${rfqId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    container.style.display = isHidden ? "block" : "none";
    toggleBtn.textContent = isHidden ? "ยกเลิก" : "เสนอราคา";
    return;
  }

  if (submitBtn) {
    const rfqId = submitBtn.dataset.rfqSubmitQuote;
    const priceInput = document.querySelector(`[data-rfq-quote-price="${rfqId}"]`);
    const qtyInput = document.querySelector(`[data-rfq-quote-qty="${rfqId}"]`);
    const messageInput = document.querySelector(`[data-rfq-quote-message="${rfqId}"]`);
    const price = priceInput ? Number(priceInput.value) : NaN;
    if (!Number.isFinite(price) || price <= 0) {
      toast("กรุณากรอกราคาที่เสนอให้ถูกต้อง", true);
      return;
    }
    submitBtn.disabled = true;
    try {
      await AgroLinkInputSupplierAPI.post(`/procurement/rfqs/${rfqId}/quotes`, {
        quoted_price: price,
        quoted_quantity: qtyInput && qtyInput.value ? Number(qtyInput.value) : null,
        message: messageInput && messageInput.value.trim() ? messageInput.value.trim() : null,
      });
      toast("ส่งใบเสนอราคาเรียบร้อยแล้ว");
      await loadRfqBrowse();
      await loadRfqMyQuotes();
    } catch (err) {
      toast("ส่งใบเสนอราคาไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      submitBtn.disabled = false;
    }
  }
});

function rfqMyQuoteCard(q) {
  const badgeClass = RFQ_QUOTE_STATUS_BADGE_CLASS[q.status] || "status-pending";
  return `
    <div class="item-card" data-quote-id="${q.quote_id}">
      <div class="row">
        <span class="title">${escapeHtml(q.rfq_title)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(RFQ_QUOTE_STATUS_LABEL_TH[q.status] || q.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(RFQ_CATEGORY_LABEL_TH[q.rfq_category] || q.rfq_category)} · ผู้ประกาศ ${escapeHtml(q.rfq_requester_name || "-")}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">
        เสนอ ${rfqMoney(q.quoted_price)} ${escapeHtml(q.price_unit)}${q.quoted_quantity ? ` · จำนวน ${rfqMoney(q.quoted_quantity)}` : ""}
      </div>
      ${q.message ? `<div class="detail-line muted">${escapeHtml(q.message)}</div>` : ""}
      <div class="detail-line muted">เสนอเมื่อ ${thaiDate(q.submitted_at)}</div>
      ${q.status === "submitted" ? `
        <div class="action-row">
          <button type="button" class="btn btn-decline btn-sm" data-rfq-withdraw-quote="${q.quote_id}">ถอนใบเสนอราคา</button>
        </div>
      ` : ""}
    </div>
  `;
}

async function loadRfqMyQuotes() {
  if (!rfqIsOrganization) return;
  const el = document.getElementById("rfqMyQuotesSection");
  const status = document.getElementById("rfqMyQuotesStatusFilter").value;
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const list = await AgroLinkInputSupplierAPI.get(`/procurement/quotes/mine${query}`);
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ท่านยังไม่เคยเสนอราคา</div>`
      : list.map(rfqMyQuoteCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดใบเสนอราคาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("rfqMyQuotesStatusFilter").addEventListener("change", () => loadRfqMyQuotes());

document.getElementById("rfqMyQuotesSection").addEventListener("click", async (e) => {
  const withdrawBtn = e.target.closest("[data-rfq-withdraw-quote]");
  if (withdrawBtn) {
    const quoteId = withdrawBtn.dataset.rfqWithdrawQuote;
    if (!confirm("ยืนยันถอนใบเสนอราคานี้?")) return;
    withdrawBtn.disabled = true;
    try {
      await AgroLinkInputSupplierAPI.post(`/procurement/quotes/${quoteId}/withdraw`, {});
      toast("ถอนใบเสนอราคาเรียบร้อยแล้ว");
      await loadRfqMyQuotes();
    } catch (err) {
      toast("ถอนไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      withdrawBtn.disabled = false;
    }
  }
});

async function refreshRfq() {
  const session = AgroLinkInputSupplierAPI.getSession();
  rfqIsOrganization = !!(session && session.subject_type === "organization");
  if (!rfqIsOrganization) {
    document.getElementById("rfqMyQuotesTitle").style.display = "none";
    document.getElementById("rfqMyQuotesFilterRow").style.display = "none";
    document.getElementById("rfqMyQuotesSection").style.display = "none";
  }
  await Promise.all([loadRfqMine(), loadRfqBrowse()]);
  if (rfqIsOrganization) await loadRfqMyQuotes();
}

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
  loadOrderReviewQueue();
  loadOrderHistory();
  refreshRfq();
}

init();
