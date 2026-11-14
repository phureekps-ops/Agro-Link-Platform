/**
 * AgroLink — plot satellite viewer (NDVI chart + Sentinel-2 image of the plot).
 * Shared by the admin portal (admin/dashboard.html → 🛰️ ข้อมูลดาวเทียม) and the
 * cooperative portal (coop/satellite.html). The caller passes its own API GET
 * function and route prefix, so each portal keeps its own login/session:
 *
 *   AgroLinkSatViewer.mount(el, { get: AgroLinkCoopAPI.get, base: "/coop", unitId })
 *
 * Backend: GET {base}/production-units/:id/satellite and .../satellite/image
 * (backend/src/lib/plotSatellite.js).
 */
(function () {
  const CSS = `
  .sv { font-size: 13.5px; }
  .sv-head { display:flex; flex-wrap:wrap; gap:6px 16px; align-items:baseline; margin-bottom:8px; }
  .sv-head b { font-size:15px; color:#1b3a1f; }
  .sv-muted { color:#8a938a; font-size:12.5px; }
  .sv-grid { display:grid; grid-template-columns: minmax(0,1.35fr) minmax(0,1fr); gap:16px; align-items:start; }
  @media (max-width: 900px) { .sv-grid { grid-template-columns: 1fr; } }
  .sv-box { background:#fff; border:1px solid #e3e8e3; border-radius:12px; padding:12px; }
  .sv-box h4 { margin:0 0 6px; font-size:14px; color:#1b3a1f; }
  .sv-chart svg { width:100%; height:auto; display:block; }
  .sv-pt { cursor:pointer; }
  .sv-tabs { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px; align-items:center; }
  .sv-tabs button { border:1px solid #d6dcd6; background:#fff; border-radius:20px; padding:5px 12px; font:inherit; font-size:12.5px; cursor:pointer; }
  .sv-tabs button.on { background:#2e7d32; border-color:#2e7d32; color:#fff; }
  .sv-tabs .sv-nav { border-radius:8px; padding:5px 9px; }
  .sv-img { position:relative; width:100%; background:#eef1ee; border-radius:8px; overflow:hidden; }
  .sv-img img, .sv-img svg { position:absolute; inset:0; width:100%; height:100%; }
  .sv-img img { image-rendering: pixelated; }
  .sv-img .sv-msg { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center; padding:16px; color:#4a524a; }
  .sv-legend { display:flex; align-items:center; gap:6px; margin-top:6px; font-size:11.5px; color:#4a524a; }
  .sv-ramp { flex:1; height:8px; border-radius:4px; background:linear-gradient(90deg,#9e6b40,#dbc778,#b3d66e,#4da645,#0f6629); }
  .sv-credit { font-size:11px; color:#8a938a; margin-top:6px; }
  .sv-empty { padding:16px; background:#f7f8f6; border-radius:10px; color:#4a524a; }
  `;
  function injectCss() {
    if (document.getElementById("sv-css")) return;
    const st = document.createElement("style"); st.id = "sv-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const thDate = iso => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y + 543}`; };
  const t = iso => Date.parse(iso + "T00:00:00Z");

  function chartSvg(points, selected) {
    const W = 760, H = 300, L = 52, R = 16, T = 22, B = 40;
    const t0 = t(points[0].date), t1 = Math.max(t(points[points.length - 1].date), t0 + 86400000);
    const X = v => L + (t(v) - t0) / (t1 - t0) * (W - L - R);
    const Y = v => T + (1 - Math.max(0, Math.min(1, v))) * (H - T - B);
    let g = "";
    [0, 0.25, 0.5, 0.75, 1].forEach(v => {
      g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e3e8e3"/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="14" fill="#8a938a">${v.toFixed(2)}</text>`;
    });
    // month ticks: first of each month inside range, labelled every 2nd month when long
    const start = new Date(t0), months = [];
    for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)); d.getTime() <= t1; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push(d);
    const step = months.length > 8 ? 2 : 1;
    months.forEach((d, i) => {
      const x = L + (d.getTime() - t0) / (t1 - t0) * (W - L - R);
      g += `<line x1="${x}" x2="${x}" y1="${H - B}" y2="${H - B + 4}" stroke="#8a938a"/>`;
      if (i % step === 0) g += `<text x="${x}" y="${H - B + 21}" text-anchor="middle" font-size="14" fill="#8a938a">${MONTHS[d.getUTCMonth()]}${d.getUTCMonth() === 0 ? " " + String(d.getUTCFullYear() + 543).slice(2) : ""}</text>`;
    });
    g += `<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#8a938a"/>`;
    g += `<text x="${L}" y="${T - 6}" font-size="14" fill="#8a938a">NDVI</text>`;
    const path = points.map((p, i) => `${i ? "L" : "M"}${X(p.date).toFixed(1)} ${Y(p.ndvi).toFixed(1)}`).join("");
    g += `<path d="${path}" fill="none" stroke="#2e7d32" stroke-width="2.5"/>`;
    points.forEach((p, i) => {
      const sel = p.date === selected;
      g += `<g class="sv-pt" data-i="${i}"><circle cx="${X(p.date)}" cy="${Y(p.ndvi)}" r="10" fill="transparent"/>` +
        `<circle cx="${X(p.date)}" cy="${Y(p.ndvi)}" r="${sel ? 7 : 4}" fill="${sel ? "#f0a500" : "#2e7d32"}" stroke="#fff" stroke-width="${sel ? 2 : 1}"/>` +
        `<title>${thDate(p.date)} · NDVI ${p.ndvi.toFixed(3)}${p.clear_pct != null ? ` · ปลอดเมฆ ${p.clear_pct}%` : ""}</title></g>`;
    });
    const sp = points.find(p => p.date === selected);
    if (sp) {
      const x = X(sp.date), y = Y(sp.ndvi), right = x > W - 190;
      g += `<text x="${right ? x - 10 : x + 10}" y="${y - 10}" text-anchor="${right ? "end" : "start"}" font-size="15" font-weight="600" fill="#1b3a1f" stroke="#fff" stroke-width="3" paint-order="stroke">${thDate(sp.date)} · ${sp.ndvi.toFixed(2)}</text>`;
    }
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="กราฟ NDVI ของแปลงตามวันที่ถ่ายภาพ">${g}</svg>`;
  }

  async function mount(el, opts) {
    injectCss();
    const { get, base, unitId, emptyHint } = opts;
    el.innerHTML = `<div class="sv-empty">กำลังโหลดข้อมูลดาวเทียมของแปลง…</div>`;
    let data;
    try {
      data = await get(`${base}/production-units/${unitId}/satellite`);
    } catch (err) {
      el.innerHTML = `<div class="sv-empty">โหลดข้อมูลดาวเทียมไม่สำเร็จ: ${esc(err.message)}</div>`;
      return;
    }
    const u = data.unit, pts = data.points;
    const head = `<div class="sv-head"><b>${esc(u.farmer_name)} — ${esc(u.commodity_name_th || u.commodity_code)}</b>
      <span class="sv-muted">${u.area_rai.toLocaleString("th-TH")} ไร่${u.season_id ? " · ฤดู " + esc(u.season_id) : ""} · NDVI ปลอดเมฆ ${pts.length} วันที่</span></div>`;
    if (!pts.length) {
      el.innerHTML = `<div class="sv">${head}<div class="sv-empty">ยังไม่มีค่า NDVI จาก Sentinel-2 ของแปลงนี้${emptyHint ? " — " + esc(emptyHint) : ""}</div></div>`;
      return;
    }
    const state = { i: pts.length - 1, kind: "truecolor", reqId: 0 };
    const v = data.view;
    el.innerHTML = `<div class="sv">${head}
      <div class="sv-grid">
        <div class="sv-box sv-chart"><h4>ค่าความเขียวของพืช (NDVI) ตามวันที่ถ่ายภาพ</h4>
          <div class="sv-muted" style="margin-bottom:4px">คลิกจุดบนกราฟเพื่อดูภาพดาวเทียมของวันนั้น · 0 = ดิน/น้ำ, 0.3 = พืชบาง, 0.6+ = พืชหนาแน่น</div>
          <div class="sv-chart-host"></div></div>
        <div class="sv-box"><h4>ภาพดาวเทียม Sentinel-2 ของแปลง</h4>
          <div class="sv-tabs">
            <button type="button" class="sv-nav" data-nav="-1" title="ภาพก่อนหน้า">‹</button>
            <span class="sv-date" style="font-weight:600;min-width:110px;text-align:center"></span>
            <button type="button" class="sv-nav" data-nav="1" title="ภาพถัดไป">›</button>
            <span style="flex:1"></span>
            <button type="button" data-kind="truecolor">ภาพสีจริง</button>
            <button type="button" data-kind="ndvi">ภาพ NDVI</button>
          </div>
          <div class="sv-img" style="aspect-ratio:${v.width}/${v.height}"><div class="sv-msg"></div></div>
          <div class="sv-legend sv-leg-ndvi" style="display:none"><span>ดินเปล่า</span><span class="sv-ramp"></span><span>พืชหนาแน่น</span></div>
          <div class="sv-credit">เส้นสีเหลือง = ขอบเขตแปลงที่ลงทะเบียน · ความละเอียด 10 ม./พิกเซล · Contains modified Copernicus Sentinel data ${new Date().getFullYear()}</div>
        </div>
      </div></div>`;
    const chartHost = el.querySelector(".sv-chart-host"), imgBox = el.querySelector(".sv-img");
    const ring = u.boundary, [minx, miny, maxx, maxy] = v.bbox;
    const poly = ring.map(([x, y]) => `${((x - minx) / (maxx - minx) * v.width).toFixed(1)},${((maxy - y) / (maxy - miny) * v.height).toFixed(1)}`).join(" ");

    function drawChart() {
      chartHost.innerHTML = chartSvg(pts, pts[state.i].date);
      chartHost.querySelectorAll(".sv-pt").forEach(n => n.addEventListener("click", () => { state.i = Number(n.dataset.i); refresh(); }));
    }
    async function loadImage() {
      const p = pts[state.i], my = ++state.reqId;
      el.querySelector(".sv-date").textContent = thDate(p.date);
      el.querySelectorAll("[data-kind]").forEach(b => b.classList.toggle("on", b.dataset.kind === state.kind));
      el.querySelector(".sv-leg-ndvi").style.display = state.kind === "ndvi" ? "flex" : "none";
      imgBox.innerHTML = `<div class="sv-msg">กำลังโหลดภาพวันที่ ${thDate(p.date)} จาก Copernicus…</div>`;
      try {
        const r = await get(`${base}/production-units/${unitId}/satellite/image?date=${p.date}&kind=${state.kind}`);
        if (my !== state.reqId) return;
        imgBox.innerHTML = `<img alt="ภาพดาวเทียมแปลงวันที่ ${thDate(p.date)}" src="data:image/png;base64,${r.png_base64}">
          <svg viewBox="0 0 ${v.width} ${v.height}" preserveAspectRatio="none" aria-hidden="true"><polygon points="${poly}" fill="none" stroke="#ffd400" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
      } catch (err) {
        if (my !== state.reqId) return;
        const code = err.body && err.body.error;
        const msg = code === "sentinelhub_not_configured" ? "ยังไม่ได้ตั้งค่าการเชื่อมต่อ Copernicus บน Render"
          : code === "sentinelhub_request_failed" ? "ดึงภาพจาก Copernicus ไม่สำเร็จ ลองใหม่อีกครั้ง" : (err.message || "โหลดภาพไม่สำเร็จ");
        imgBox.innerHTML = `<div class="sv-msg">${esc(msg)}</div>`;
      }
    }
    function refresh() { drawChart(); loadImage(); }
    el.querySelectorAll("[data-kind]").forEach(b => b.addEventListener("click", () => { state.kind = b.dataset.kind; loadImage(); }));
    el.querySelectorAll("[data-nav]").forEach(b => b.addEventListener("click", () => {
      const n = state.i + Number(b.dataset.nav); if (n < 0 || n >= pts.length) return; state.i = n; refresh();
    }));
    refresh();
  }

  window.AgroLinkSatViewer = { mount };
})();
