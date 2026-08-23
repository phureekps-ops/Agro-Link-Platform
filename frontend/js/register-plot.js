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

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkAPI.logout());

// ---------- คำนวณพื้นที่โดยประมาณจากจุดขอบเขต (ไร่) ----------
// Flat-earth (equirectangular) approximation projected around the polygon's
// first point — accurate enough at farm-plot scale (a few hundred metres
// across at most), not meant for anything requiring survey-grade precision.
function computeAreaRai(latlngs) {
  if (latlngs.length < 3) return 0;
  const R = 6378137; // WGS84 equatorial radius, metres
  const lat0Rad = (latlngs[0].lat * Math.PI) / 180;
  const pts = latlngs.map((p) => ({
    x: R * ((p.lng * Math.PI) / 180) * Math.cos(lat0Rad),
    y: R * ((p.lat * Math.PI) / 180),
  }));
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area2 += a.x * b.y - b.x * a.y;
  }
  const areaM2 = Math.abs(area2) / 2;
  return areaM2 / 1600; // 1 ไร่ = 1600 ตร.ม.
}

function toGeoJSONPolygon(latlngs) {
  const coords = latlngs.map((p) => [p.lng, p.lat]);
  coords.push(coords[0]); // GeoJSON ring must close (first point repeated at end)
  return { type: "Polygon", coordinates: [coords] };
}

// ---------- แผนที่ ----------
const map = L.map("plotMap").setView([15.87, 100.99], 6); // ศูนย์กลางประเทศไทย

// ภาพถ่ายดาวเทียม/มุมสูง (Esri World Imagery) — ฟรี ไม่ต้องมี API key/บัญชี
// ผูกบัตร ต่างจาก Google Maps ตรงที่ไม่มีโควตา/ค่าใช้จ่ายให้ต้องจัดการ
L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19,
  attribution: "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
}).addTo(map);

// ชั้นป้ายชื่อสถานที่/ถนน/เขตแดน ซ้อนทับบนภาพถ่ายดาวเทียม ให้ได้อารมณ์คล้ายโหมด
// "ไฮบริด" (satellite + labels) ของ Google Maps โดยไม่ต้องพึ่ง Google เลย
L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19,
  attribution: "Esri",
}).addTo(map);

let points = []; // array of L.LatLng, while still drawing
let markers = [];
let previewLine = null;
let finalPolygon = null;
let closed = false;

const mapStatusEl = document.getElementById("mapStatus");
const undoBtn = document.getElementById("undoPointBtn");
const clearBtn = document.getElementById("clearAllBtn");
const closeBtn = document.getElementById("closePolygonBtn");
const redrawBtn = document.getElementById("redrawBtn");
const submitBtn = document.getElementById("submitBtn");
const areaRaiInput = document.getElementById("areaRai");

function updateStatus() {
  if (closed) {
    mapStatusEl.innerHTML = `ปิดรูปหลายเหลี่ยมแล้ว (<strong>${points.length}</strong> จุด) — พื้นที่โดยประมาณ <strong>${computeAreaRai(points).toLocaleString("th-TH", { maximumFractionDigits: 2 })}</strong> ไร่`;
  } else if (points.length === 0) {
    mapStatusEl.textContent = "ยังไม่ได้ปักจุด — คลิกบนแผนที่เพื่อเริ่มปักขอบเขต";
  } else {
    mapStatusEl.innerHTML = `ปักแล้ว <strong>${points.length}</strong> จุด${points.length < 3 ? " (ต้องมีอย่างน้อย 3 จุดจึงจะปิดรูปได้)" : " — คลิกต่อ หรือกด \"ปิดรูปหลายเหลี่ยม\""}`;
  }
  closeBtn.disabled = points.length < 3 || closed;
  undoBtn.disabled = points.length === 0 || closed;
}

function redrawPreview() {
  if (previewLine) { map.removeLayer(previewLine); previewLine = null; }
  if (points.length > 0) {
    previewLine = L.polyline(points, { color: "#2e7d32", weight: 3, dashArray: "6,6" }).addTo(map);
  }
}

function resetDrawing() {
  markers.forEach((m) => map.removeLayer(m));
  markers = [];
  if (previewLine) { map.removeLayer(previewLine); previewLine = null; }
  if (finalPolygon) { map.removeLayer(finalPolygon); finalPolygon = null; }
  points = [];
  closed = false;
  submitBtn.disabled = true;
  areaRaiInput.value = "";
  closeBtn.style.display = "";
  undoBtn.style.display = "";
  clearBtn.style.display = "";
  redrawBtn.style.display = "none";
  updateStatus();
}

map.on("click", (e) => {
  if (closed) return;
  points.push(e.latlng);
  const marker = L.circleMarker(e.latlng, { radius: 6, color: "#1b3a1f", fillColor: "#2e7d32", fillOpacity: 1 }).addTo(map);
  markers.push(marker);
  redrawPreview();
  updateStatus();
});

undoBtn.addEventListener("click", () => {
  if (closed || points.length === 0) return;
  points.pop();
  const marker = markers.pop();
  if (marker) map.removeLayer(marker);
  redrawPreview();
  updateStatus();
});

clearBtn.addEventListener("click", () => resetDrawing());

closeBtn.addEventListener("click", () => {
  if (points.length < 3) return;
  closed = true;
  if (previewLine) { map.removeLayer(previewLine); previewLine = null; }
  finalPolygon = L.polygon(points, { color: "#1b3a1f", fillColor: "#66bb6a", fillOpacity: 0.35, weight: 3 }).addTo(map);
  map.fitBounds(finalPolygon.getBounds(), { padding: [24, 24] });

  const areaRai = computeAreaRai(points);
  areaRaiInput.value = areaRai > 0 ? areaRai.toFixed(2) : "";

  closeBtn.style.display = "none";
  undoBtn.style.display = "none";
  clearBtn.style.display = "none";
  redrawBtn.style.display = "";
  submitBtn.disabled = false;
  updateStatus();
});

redrawBtn.addEventListener("click", () => resetDrawing());

updateStatus();

// ---------- พืช/สัตว์เศรษฐกิจ ----------
async function loadCommodities() {
  const select = document.getElementById("commodityCode");
  try {
    const rows = await AgroLinkAPI.get("/farmer/commodities");
    if (rows.length === 0) {
      select.innerHTML = `<option value="">ไม่มีข้อมูล</option>`;
      return;
    }
    select.innerHTML = rows.map((c) => `<option value="${escapeHtml(c.commodity_code)}">${escapeHtml(c.name_th)}</option>`).join("");
  } catch (err) {
    select.innerHTML = `<option value="">โหลดรายการไม่สำเร็จ</option>`;
    toast(`โหลดรายการพืช/สัตว์เศรษฐกิจไม่สำเร็จ: ${err.message}`, true);
  }
}
loadCommodities();

// ---------- บันทึก ----------
document.getElementById("plotForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!closed || points.length < 3) {
    toast("กรุณาปักขอบเขตแปลงบนแผนที่และกด \"ปิดรูปหลายเหลี่ยม\" ก่อนบันทึก", true);
    return;
  }

  const unitType = document.getElementById("unitType").value;
  const commodityCode = document.getElementById("commodityCode").value;
  const seasonId = document.getElementById("seasonId").value.trim();
  const areaRai = Number(areaRaiInput.value);

  if (!commodityCode) {
    toast("กรุณาเลือกพืช/สัตว์เศรษฐกิจ", true);
    return;
  }
  if (!seasonId) {
    toast("กรุณาระบุฤดูกาล/รอบปลูก", true);
    return;
  }
  if (!Number.isFinite(areaRai) || areaRai <= 0) {
    toast("กรุณาระบุพื้นที่ (ไร่) ให้ถูกต้อง", true);
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "กำลังบันทึก…";
  try {
    await AgroLinkAPI.post("/farmer/production-units", {
      unit_type: unitType,
      gps_boundary: toGeoJSONPolygon(points),
      area_rai: areaRai,
      commodity_code: commodityCode,
      season_id: seasonId,
    });
    toast("บันทึกแปลง/หน่วยผลิตสำเร็จ กำลังกลับไปหน้าหลัก…");
    setTimeout(() => { window.location.href = "dashboard.html"; }, 1200);
  } catch (err) {
    const message = (err.body && err.body.message) || err.message;
    toast(`บันทึกไม่สำเร็จ: ${message}`, true);
    submitBtn.disabled = false;
    submitBtn.textContent = "บันทึกแปลง/หน่วยผลิต";
  }
});
