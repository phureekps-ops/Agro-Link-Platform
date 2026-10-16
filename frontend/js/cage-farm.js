/**
 * AgroLink — ฟาร์ม/กระชังเลี้ยงปลา, farmer-facing page (cage-farm.html).
 * Backs GET/POST /aquaculture/farm-profile and GET/POST /aquaculture/cages
 * (see backend/src/routes/aquaculture.js and grant_cage_fish_farm_
 * management.sql). P4 scope only — registration + farm profile, no
 * sampling/auction/settlement for these 4 species in this pass (that stays
 * shrimp-only, see the migration's header comment for why).
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

const CAGE_SPECIES_LABEL_TH = {
  TILAPIA_CAGE: "ปลานิลกระชัง",
  TILAPIA_RED_CAGE: "ปลาทับทิมกระชัง",
  SEABASS_CAGE: "ปลากระพงกระชัง",
  GROUPER_CAGE: "ปลาเก๋ากระชัง",
};

// ============================================================
// Farm profile (shared with the shrimp Auction Place page — same
// aquaculture.farm_profile row either way)
// ============================================================
async function loadFarmProfile() {
  const profile = await AgroLinkAPI.get("/aquaculture/farm-profile");
  if (profile) {
    document.getElementById("farmNameInput").value = profile.farm_name || "";
    document.getElementById("farmProvinceInput").value = profile.province || "";
    document.getElementById("farmDistrictInput").value = profile.district || "";
    document.getElementById("farmPhoneInput").value = profile.phone || "";
  }
}

document.getElementById("farmProfileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("farmProfileSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkAPI.post("/aquaculture/farm-profile", {
      farm_name: document.getElementById("farmNameInput").value.trim(),
      province: document.getElementById("farmProvinceInput").value.trim(),
      district: document.getElementById("farmDistrictInput").value.trim() || null,
      phone: document.getElementById("farmPhoneInput").value.trim() || null,
    });
    toast("บันทึกข้อมูลฟาร์มแล้ว");
  } catch (err) {
    toast(err.message || "บันทึกไม่สำเร็จ", true);
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// Cages
// ============================================================
function cageCard(c) {
  return `
    <div class="item-card">
      <div class="row">
        <span class="title">${escapeHtml(CAGE_SPECIES_LABEL_TH[c.commodity_code] || c.commodity_code)}</span>
        <span class="badge status-active">${escapeHtml(c.status || "active")}</span>
      </div>
      <div class="detail-line">ปริมาตร ${escapeHtml(c.area_rai)} ลบ.ม. · รอบเลี้ยง ${escapeHtml(c.season_id)}</div>
      <div class="detail-line muted">ลงทะเบียนเมื่อ ${thaiDate(c.registration_date)}</div>
    </div>
  `;
}

async function loadCages() {
  const cages = await AgroLinkAPI.get("/aquaculture/cages");
  const section = document.getElementById("cagesSection");
  section.innerHTML = cages.length
    ? cages.map(cageCard).join("")
    : `<div class="empty-state">ยังไม่มีกระชังที่ลงทะเบียน</div>`;
}

document.getElementById("cageForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("cageSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkAPI.post("/aquaculture/cages", {
      species: document.getElementById("cageSpeciesSelect").value,
      volume_cubic_meters: Number(document.getElementById("cageVolumeInput").value),
      season_id: document.getElementById("cageSeasonInput").value.trim(),
      lat: Number(document.getElementById("cageLatInput").value),
      lng: Number(document.getElementById("cageLngInput").value),
    });
    toast("เพิ่มกระชังแล้ว");
    document.getElementById("cageForm").reset();
    await loadCages();
  } catch (err) {
    toast(err.message || "เพิ่มกระชังไม่สำเร็จ", true);
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// Init
// ============================================================
(async function init() {
  try {
    await loadFarmProfile();
  } catch (err) { /* no profile yet */ }
  try {
    await loadCages();
  } catch (err) {
    toast(err.message || "โหลดข้อมูลกระชังไม่สำเร็จ", true);
  }
})();
