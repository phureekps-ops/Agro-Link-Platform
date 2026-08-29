const session = AgroLinkAdminAPI.requireSessionOrRedirect();

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

function thaiDateTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("th-TH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const PRODUCT_CATEGORY_LABEL = {
  fertilizer_hormone: "ปุ๋ย/ฮอร์โมน",
  chemical_pesticide: "สารเคมี/ยาปราบศัตรูพืช",
  equipment: "อุปกรณ์การเกษตร",
  produce: "ผลผลิตทางการเกษตร (สหกรณ์)",
  processed_good: "สินค้าแปรรูป (สหกรณ์)",
  other: "อื่นๆ",
};
const SERVICE_TYPE_LABEL = {
  land_preparation: "เตรียมดิน", harvesting: "เก็บเกี่ยว", pest_control: "พ่นยา/กำจัดศัตรูพืช",
  transport: "ขนส่ง", drying_storage: "ลานตาก/จัดเก็บ", straw_processing: "อัดเม็ด/อัดก้อนฟางข้าว",
  other: "อื่นๆ",
};

// A listing is "currently featured" only if is_featured AND (no expiry OR
// expiry still in the future) — same live-expiry logic as the backend's
// GET /farmer/products / GET /farmer/machinery-providers, so this admin
// view never shows a stale "แนะนำ" badge for something that already
// silently stopped being featured.
function isCurrentlyFeatured(row) {
  if (!row.is_featured) return false;
  if (!row.featured_until) return true;
  return new Date(row.featured_until).getTime() > Date.now();
}

function featuredActionsHtml(kind, row) {
  const featured = isCurrentlyFeatured(row);
  if (featured) {
    return `
      <div class="detail-line muted">แนะนำถึง: ${row.featured_until ? thaiDateTime(row.featured_until) : "ไม่มีกำหนด"}</div>
      <button type="button" class="btn btn-decline btn-sm" data-unfeature="${kind}" data-id="${row.listing_id}">ยกเลิกแนะนำ</button>
    `;
  }
  return `
    <div class="detail-line" style="display:flex; gap:8px; align-items:center;">
      <label for="days-${kind}-${row.listing_id}" style="font-size:12px; color:var(--gray-500);">จำนวนวัน</label>
      <input type="number" id="days-${kind}-${row.listing_id}" value="30" min="1" step="1" style="width:80px; padding:6px 8px;" />
      <button type="button" class="btn btn-approve btn-sm" data-feature="${kind}" data-id="${row.listing_id}">ตั้งเป็นแนะนำ</button>
    </div>
  `;
}

function productCard(row) {
  const featured = isCurrentlyFeatured(row);
  return `
    <div class="item-card" data-listing-id="${row.listing_id}">
      <div class="row">
        <span class="title">${escapeHtml(row.product_name)}${row.brand ? " — " + escapeHtml(row.brand) : ""}</span>
        <span class="badge ${featured ? "status-active" : "status-pending"}">${featured ? "⭐ แนะนำอยู่" : "ยังไม่แนะนำ"}</span>
      </div>
      <div class="detail-line muted">${escapeHtml(row.org_name)} (${escapeHtml(row.org_type)}) · ${escapeHtml(PRODUCT_CATEGORY_LABEL[row.category] || row.category)}</div>
      <div class="detail-line">ราคา ${Number(row.unit_price).toLocaleString("th-TH")} ${escapeHtml(row.price_unit)} · ${row.is_active ? "ยังขายอยู่" : "ปิดการขายแล้ว"}</div>
      ${featuredActionsHtml("product", row)}
    </div>
  `;
}

function serviceCard(row) {
  const featured = isCurrentlyFeatured(row);
  return `
    <div class="item-card" data-listing-id="${row.listing_id}">
      <div class="row">
        <span class="title">${escapeHtml(row.description || row.service_key || row.service_type)}</span>
        <span class="badge ${featured ? "status-active" : "status-pending"}">${featured ? "⭐ แนะนำอยู่" : "ยังไม่แนะนำ"}</span>
      </div>
      <div class="detail-line muted">${escapeHtml(row.org_name)} (${escapeHtml(row.org_type)}) · ${escapeHtml(SERVICE_TYPE_LABEL[row.service_type] || row.service_type)}</div>
      <div class="detail-line">ราคา ${Number(row.unit_price).toLocaleString("th-TH")} ${escapeHtml(row.price_unit)} · ${row.is_active ? "ให้บริการอยู่" : "ปิดให้บริการแล้ว"}</div>
      ${featuredActionsHtml("service", row)}
    </div>
  `;
}

async function loadProductListings() {
  const el = document.getElementById("productListingsSection");
  const category = document.getElementById("productCategoryFilter").value;
  const featured = document.getElementById("productFeaturedFilter").value;
  el.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (featured) params.set("featured", featured);
    const qs = params.toString();
    const rows = await AgroLinkAdminAPI.get(`/admin/product-listings${qs ? "?" + qs : ""}`);
    el.innerHTML = rows.length === 0
      ? `<div class="empty-state">ไม่พบสินค้าตามเงื่อนไขที่เลือก</div>`
      : rows.map(productCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadServiceListings() {
  const el = document.getElementById("serviceListingsSection");
  const serviceType = document.getElementById("serviceTypeFilter").value;
  const featured = document.getElementById("serviceFeaturedFilter").value;
  el.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const params = new URLSearchParams();
    if (serviceType) params.set("service_type", serviceType);
    if (featured) params.set("featured", featured);
    const qs = params.toString();
    const rows = await AgroLinkAdminAPI.get(`/admin/service-listings${qs ? "?" + qs : ""}`);
    el.innerHTML = rows.length === 0
      ? `<div class="empty-state">ไม่พบบริการตามเงื่อนไขที่เลือก</div>`
      : rows.map(serviceCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("productCategoryFilter").addEventListener("change", loadProductListings);
document.getElementById("productFeaturedFilter").addEventListener("change", loadProductListings);
document.getElementById("serviceTypeFilter").addEventListener("change", loadServiceListings);
document.getElementById("serviceFeaturedFilter").addEventListener("change", loadServiceListings);

document.getElementById("productListingsSection").addEventListener("click", async (e) => {
  const featureBtn = e.target.closest("[data-feature]");
  const unfeatureBtn = e.target.closest("[data-unfeature]");
  if (featureBtn) {
    const id = featureBtn.dataset.id;
    const daysInput = document.getElementById(`days-product-${id}`);
    const days = Number(daysInput.value) || 30;
    featureBtn.disabled = true;
    try {
      await AgroLinkAdminAPI.post(`/admin/product-listings/${id}/feature`, { days });
      toast("ตั้งเป็นสินค้าแนะนำเรียบร้อยแล้ว");
      await loadProductListings();
    } catch (err) {
      toast("ทำรายการไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      featureBtn.disabled = false;
    }
  } else if (unfeatureBtn) {
    const id = unfeatureBtn.dataset.id;
    unfeatureBtn.disabled = true;
    try {
      await AgroLinkAdminAPI.post(`/admin/product-listings/${id}/unfeature`, {});
      toast("ยกเลิกการแนะนำแล้ว");
      await loadProductListings();
    } catch (err) {
      toast("ทำรายการไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      unfeatureBtn.disabled = false;
    }
  }
});

document.getElementById("serviceListingsSection").addEventListener("click", async (e) => {
  const featureBtn = e.target.closest("[data-feature]");
  const unfeatureBtn = e.target.closest("[data-unfeature]");
  if (featureBtn) {
    const id = featureBtn.dataset.id;
    const daysInput = document.getElementById(`days-service-${id}`);
    const days = Number(daysInput.value) || 30;
    featureBtn.disabled = true;
    try {
      await AgroLinkAdminAPI.post(`/admin/service-listings/${id}/feature`, { days });
      toast("ตั้งเป็นบริการแนะนำเรียบร้อยแล้ว");
      await loadServiceListings();
    } catch (err) {
      toast("ทำรายการไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      featureBtn.disabled = false;
    }
  } else if (unfeatureBtn) {
    const id = unfeatureBtn.dataset.id;
    unfeatureBtn.disabled = true;
    try {
      await AgroLinkAdminAPI.post(`/admin/service-listings/${id}/unfeature`, {});
      toast("ยกเลิกการแนะนำแล้ว");
      await loadServiceListings();
    } catch (err) {
      toast("ทำรายการไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      unfeatureBtn.disabled = false;
    }
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkAdminAPI.logout());

async function init() {
  await Promise.all([loadProductListings(), loadServiceListings()]);
}

init();
