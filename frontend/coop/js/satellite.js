/**
 * AgroLink — พอร์ทัลสหกรณ์: ดาวเทียมแปลงสมาชิก (GET /coop/satellite/units +
 * ../js/satellite-viewer.js). ขอบเขตแปลงเหมือน GET /coop/production-units.
 */
(function () {
  "use strict";
  const API = AgroLinkCoopAPI;
  if (!API.requireSessionOrRedirect()) return;
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const thDate = (v) => { if (!v) return "-"; const s = String(v).slice(0, 10); const [y, m, d] = s.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y + 543}`; };
  const session = API.getSession() || {};
  document.getElementById("orgName").textContent = session.org_name || (session.organization && session.organization.org_name) || "";
  document.getElementById("logoutBtn").addEventListener("click", () => API.logout());

  let selected = null;
  async function load() {
    const host = document.getElementById("unitList");
    try {
      const rows = await API.get("/coop/satellite/units");
      if (!rows.length) { host.innerHTML = '<div class="sat-note">ยังไม่มีแปลงที่ลงทะเบียน</div>'; return; }
      host.innerHTML = `<table class="sat-table"><thead><tr><th>เกษตรกร</th><th>พืช</th><th class="num">ไร่</th><th class="num">จำนวนภาพ</th><th class="num">NDVI ล่าสุด</th><th>วันที่ภาพล่าสุด</th></tr></thead><tbody>${
        rows.map((r) => `<tr class="pick" data-id="${esc(r.unit_id)}"><td>${esc(r.farmer_name)}</td><td>${esc(r.commodity_name_th || r.commodity_code)}${r.season_id ? ` <span class="sat-note">(${esc(r.season_id)})</span>` : ""}</td>
          <td class="num">${Number(r.area_rai).toLocaleString("th-TH")}</td><td class="num">${r.ndvi_points}</td>
          <td class="num">${r.last_ndvi != null ? Number(r.last_ndvi).toFixed(2) : "-"}</td><td>${thDate(r.last_date)}</td></tr>`).join("")
      }</tbody></table>`;
      host.querySelectorAll("tr.pick").forEach((tr) => tr.addEventListener("click", () => open(tr.dataset.id)));
      const first = rows.find((r) => r.ndvi_points > 0);
      if (first) open(first.unit_id);
    } catch (err) {
      host.innerHTML = `<div class="sat-note">โหลดรายการแปลงไม่สำเร็จ: ${esc(err.message)}</div>`;
    }
  }
  function open(id) {
    selected = id;
    document.querySelectorAll("tr.pick").forEach((tr) => tr.classList.toggle("on", tr.dataset.id === id));
    document.getElementById("viewerCard").style.display = "block";
    AgroLinkSatViewer.mount(document.getElementById("viewer"), {
      get: API.get, base: "/coop", unitId: id,
      emptyHint: "ผู้ดูแลระบบ AgroLink ต้องกดดึง NDVI ย้อนหลังของแปลงนี้ก่อน",
    });
    document.getElementById("viewerCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  load();
})();
