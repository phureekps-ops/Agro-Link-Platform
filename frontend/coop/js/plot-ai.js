/**
 * AgroLink — พอร์ทัลสหกรณ์: AI ติดตามแปลง & พยากรณ์ผลผลิต (AgroLink SatAI กลุ่มที่ 1)
 * แผงหลักอยู่ที่ ../js/plot-ai-panel.js · API: GET/POST /coop/plot-ai/* (backend/src/routes/plotai.js)
 * ขอบเขตแปลงเหมือน GET /coop/satellite/units
 */
(function () {
  "use strict";
  const API = AgroLinkCoopAPI;
  if (!API.requireSessionOrRedirect()) return;
  const session = API.getSession() || {};
  document.getElementById("orgName").textContent = session.org_name || (session.organization && session.organization.org_name) || "";
  document.getElementById("logoutBtn").addEventListener("click", () => API.logout());

  AgroLinkPlotAI.mount(document.getElementById("plotAiHost"), {
    api: API, base: "/coop/plot-ai", admin: false,
    onOpenPlot: (unitId) => {
      const card = document.getElementById("viewerCard");
      card.style.display = "block";
      AgroLinkSatViewer.mount(document.getElementById("viewer"), {
        get: API.get, base: "/coop", unitId,
        emptyHint: "ผู้ดูแลระบบ AgroLink ต้องกดดึง NDVI ย้อนหลังของแปลงนี้ก่อน",
      });
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    },
  });
})();
