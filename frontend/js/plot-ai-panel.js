/**
 * AgroLink SatAI — แผงวิเคราะห์แปลงด้วย AI (ใช้ร่วมกันระหว่างแอดมินและพอร์ทัลสหกรณ์)
 * AgroLinkPlotAI.mount(host, { api, base, admin, onOpenPlot })
 *   api   — AgroLinkAdminAPI หรือ AgroLinkCoopAPI (ต้องมี get/post/put)
 *   base  — "/admin/plot-ai" หรือ "/coop/plot-ai"
 *   admin — true = แสดงส่วนโมเดลและค่าอ้างอิงพืช (แอดมินเท่านั้น)
 *   onOpenPlot(unitId) — เปิดกราฟ NDVI ของแปลง (ไม่บังคับ)
 * Backend: backend/src/routes/plotai.js
 */
(function () {
  "use strict";
  const CROP_TH = {
    rice: "ข้าว", maize: "ข้าวโพด", cassava: "มันสำปะหลัง", sugarcane: "อ้อย",
    vegetable: "ผัก/พืชอายุสั้น", perennial: "ไม้ยืนต้น/ไม้ผล", fallow: "ไม่มีพืชปลูก/พื้นที่ว่าง",
  };
  const RISK = {
    high: ["สูง", "#b42318", "#fee4e2"], medium: ["ปานกลาง", "#b54708", "#fef0c7"],
    low: ["ปกติ", "#067647", "#dcfae6"], unknown: ["ข้อมูลไม่พอ", "#475467", "#f2f4f7"],
  };
  const STATUS = {
    growing: "กำลังเจริญเติบโต", harvested: "เก็บเกี่ยวแล้ว", new_season_starting: "เก็บเกี่ยวแล้ว · เริ่มรอบใหม่",
    no_season: "ไม่พบรอบปลูก", unknown_gap: "ข้อมูลภาพขาดช่วง",
  };
  const FLAG_TH = {
    LOW_DATA: "ภาพดาวเทียมไม่พอ", AREA_MISMATCH: "พื้นที่ไม่ตรง", CROP_MISMATCH: "ชนิดพืชไม่ตรง",
    NO_CROP_CYCLE: "ไม่พบรอบปลูก", DELIVERY_BEFORE_HARVEST: "ส่งผลผลิตก่อนเก็บเกี่ยว",
    DELIVERY_WITHOUT_HARVEST: "ส่งผลผลิตโดยไม่พบการเก็บเกี่ยว", YIELD_OUTLIER: "ผลผลิตสูงผิดปกติ",
    HARVEST_DATE_MISMATCH: "วันเก็บเกี่ยวไม่ตรง",
  };
  const METHOD_TH = {
    rule_based_phenology: "กฎทางพืชศาสตร์จากกราฟ NDVI (ยังไม่ได้เรียนรู้จากข้อมูลจริง)",
    ml_softmax: "โมเดลที่เรียนรู้จากแปลงที่ยืนยันแล้ว",
    insufficient_data: "ข้อมูลภาพไม่พอ",
    baseline_ndvi_scaled: "ค่าเฉลี่ยของพืช ปรับตามความเขียวสูงสุดของฤดู",
    ml_ridge: "โมเดลที่เรียนรู้จากน้ำหนักรับซื้อจริง",
  };
  const MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const thDate = (v) => { if (!v) return "-"; const [y, m, d] = String(v).slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y + 543}`; };
  const thMonth = (v) => { if (!v) return "-"; const [y, m] = v.split("-").map(Number); return `${MONTHS[m - 1]} ${y + 543}`; };
  const num = (v, d = 1) => (v == null ? "-" : Number(v).toLocaleString("th-TH", { maximumFractionDigits: d, minimumFractionDigits: d }));
  const crop = (c) => (c ? CROP_TH[c] || c : "-");
  const badge = (risk) => { const [t, fg, bg] = RISK[risk] || ["ยังไม่วิเคราะห์", "#475467", "#f2f4f7"]; return `<span class="pai-badge" style="color:${fg};background:${bg}">${t}</span>`; };

  function injectCss() {
    if (document.getElementById("pai-css")) return;
    const s = document.createElement("style");
    s.id = "pai-css";
    s.textContent = `
      .pai-card{background:#fff;border-radius:var(--radius,12px);box-shadow:var(--shadow,0 1px 3px rgba(0,0,0,.08));padding:18px;margin-bottom:16px}
      .pai-card h3{margin:0 0 4px;font-size:16px;color:var(--green-900,#14532d)}
      .pai-note{font-size:12.5px;color:var(--gray-500,#667085);margin:0 0 10px;line-height:1.55}
      .pai-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
      .pai-btn{border:1px solid var(--gray-300,#d0d5dd);background:#fff;border-radius:8px;padding:7px 12px;font:inherit;font-size:13px;cursor:pointer}
      .pai-btn.primary{background:var(--green-700,#15803d);color:#fff;border-color:transparent}
      .pai-btn:disabled{opacity:.55;cursor:wait}
      .pai-table{width:100%;border-collapse:collapse;font-size:13.5px}
      .pai-table th{text-align:left;font-size:12px;color:var(--gray-500,#667085);font-weight:600;padding:7px 8px;border-bottom:1px solid var(--gray-300,#d0d5dd);white-space:nowrap}
      .pai-table td{padding:7px 8px;border-bottom:1px solid var(--gray-100,#f2f4f7);vertical-align:top}
      .pai-table .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
      .pai-table tr.pick{cursor:pointer}.pai-table tr.pick:hover td{background:var(--green-100,#ecfdf3)}
      .pai-table tr.on td{background:var(--gold-100,#fef7e0)}
      .pai-scroll{overflow-x:auto}
      .pai-badge{display:inline-block;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:600;white-space:nowrap}
      .pai-chip{display:inline-block;border-radius:6px;padding:1px 6px;margin:1px 2px 1px 0;font-size:11.5px;background:#f2f4f7;color:#344054;white-space:nowrap}
      .pai-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:8px 0 14px}
      .pai-stat{border:1px solid var(--gray-100,#f2f4f7);border-radius:10px;padding:10px 12px}
      .pai-stat b{display:block;font-size:12px;color:var(--gray-500,#667085);font-weight:600;margin-bottom:3px}
      .pai-stat span{font-size:15px;font-weight:600;color:#101828}
      .pai-stat small{display:block;font-size:11.5px;color:var(--gray-500,#667085);margin-top:2px}
      .pai-flag{border-left:4px solid;border-radius:6px;padding:8px 10px;margin:6px 0;font-size:13.5px;line-height:1.5}
      .pai-bar{height:8px;border-radius:4px;background:var(--green-600,#16a34a)}
      .pai-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;align-items:end}
      .pai-form label{font-size:12px;color:var(--gray-500,#667085);display:block;margin-bottom:3px}
      .pai-form select,.pai-form input{width:100%;box-sizing:border-box;padding:7px 8px;border:1px solid var(--gray-300,#d0d5dd);border-radius:8px;font:inherit;font-size:13.5px}
      .pai-small-input{width:80px;padding:4px 6px;border:1px solid var(--gray-300,#d0d5dd);border-radius:6px;font:inherit;font-size:13px;text-align:right}
    `;
    document.head.appendChild(s);
  }

  function mount(host, opts) {
    injectCss();
    const { api, base, admin, onOpenPlot } = opts;
    let selected = null;
    host.innerHTML = `
      ${admin ? '<div class="pai-card" id="paiModels"><div class="pai-note">กำลังโหลดสถานะโมเดล…</div></div>' : ""}
      <div class="pai-card">
        <h3>🌾 พยากรณ์ผลผลิตที่จะเข้าสหกรณ์</h3>
        <p class="pai-note">รวมเฉพาะแปลงที่พืชยังเจริญเติบโตอยู่ จัดตามเดือนที่คาดว่าจะเก็บเกี่ยว ช่วงต่ำ–สูงคือช่วงที่ผลผลิตจริงน่าจะอยู่ (ประมาณ 80%)</p>
        <div id="paiForecast" class="pai-scroll">กำลังโหลด…</div>
      </div>
      <div class="pai-card">
        <h3>🤖 ผลวิเคราะห์รายแปลง</h3>
        <p class="pai-note">AI อ่านกราฟ NDVI ของแต่ละแปลงจากภาพ Sentinel-2 แล้วบอกชนิดพืช วันปลูก วันเก็บเกี่ยว ผลผลิตคาดการณ์
          และเทียบกับข้อมูลที่บันทึกในระบบ (ชนิดพืชที่ขึ้นทะเบียน พื้นที่ การส่งผลผลิต งวดเก็บเกี่ยว) ว่ามีจุดไหนไม่ตรงกัน
          คลิกแปลงเพื่อดูรายละเอียดและยืนยันชนิดพืช — ทุกการยืนยันคือข้อมูลสอน AI ให้แม่นขึ้น</p>
        <div class="pai-row">
          <button class="pai-btn primary" id="paiAssessAll">วิเคราะห์ทุกแปลงใหม่</button>
          <select id="paiRisk" class="pai-btn"><option value="">ทุกระดับความเสี่ยง</option><option value="high">เสี่ยงสูง</option>
            <option value="medium">ปานกลาง</option><option value="low">ปกติ</option><option value="unknown">ข้อมูลไม่พอ</option></select>
          <span class="pai-note" id="paiAssessMsg" style="margin:0"></span>
        </div>
        <div id="paiList" class="pai-scroll">กำลังโหลด…</div>
      </div>
      <div class="pai-card" id="paiDetail" style="display:none"></div>
      ${admin ? '<div class="pai-card" id="paiProfiles"></div>' : ""}`;

    async function loadForecast() {
      const el = host.querySelector("#paiForecast");
      try {
        const f = await api.get(`${base}/forecast`);
        if (!f.rows.length) {
          el.innerHTML = `<div class="pai-note">ยังไม่มีแปลงที่พยากรณ์ได้ (แปลงที่ยังไม่วิเคราะห์หรือยังพยากรณ์ไม่ได้ ${f.plots_without_forecast} แปลง)</div>`;
          return;
        }
        el.innerHTML = `<table class="pai-table"><thead><tr><th>เดือนที่คาดว่าจะเก็บเกี่ยว</th><th>พืช</th><th class="num">แปลง</th><th class="num">ไร่</th>
          <th class="num">ผลผลิตคาดการณ์ (ตัน)</th><th class="num">ช่วงต่ำ–สูง (ตัน)</th></tr></thead><tbody>${
          f.rows.map((r) => `<tr><td>${thMonth(r.harvest_month)}</td><td>${crop(r.crop)}</td><td class="num">${r.plots}</td><td class="num">${num(r.area_rai, 2)}</td>
            <td class="num"><b>${num(r.tons)}</b></td><td class="num">${num(r.tons_low)}–${num(r.tons_high)}</td></tr>`).join("")
        }</tbody></table><div class="pai-note" style="margin-top:8px">ยังพยากรณ์ไม่ได้ ${f.plots_without_forecast} แปลง (เช่น ยังไม่พบรอบปลูก ชนิดพืชยังไม่ยืนยัน หรือยังไม่ได้วิเคราะห์)</div>`;
      } catch (err) { el.innerHTML = `<div class="pai-note">${esc(errText(err))}</div>`; }
    }

    async function loadList() {
      const el = host.querySelector("#paiList");
      const risk = host.querySelector("#paiRisk").value;
      try {
        const rows = await api.get(`${base}/units${risk ? `?risk=${risk}` : ""}`);
        if (!rows.length) { el.innerHTML = '<div class="pai-note">ไม่มีแปลงในเงื่อนไขนี้</div>'; return; }
        el.innerHTML = `<table class="pai-table"><thead><tr><th>เกษตรกร</th><th>พืชในทะเบียน</th><th>AI อ่านได้ว่า</th><th>สถานะฤดู</th>
          <th>เก็บเกี่ยว</th><th class="num">คาดการณ์ (ตัน)</th><th>ความเสี่ยง</th><th>สิ่งที่พบ</th></tr></thead><tbody>${
          rows.map((r) => {
            const flags = (r.flags || []).filter((f) => f.severity !== "info" || f.code === "LOW_DATA");
            const aiCrop = r.confirmed_crop ? `${crop(r.confirmed_crop)} <span class="pai-chip">ยืนยันแล้ว</span>`
              : (r.predicted_crop ? `${crop(r.predicted_crop)} <span class="pai-note">${Math.round((r.crop_confidence || 0) * 100)}%${r.crop_ambiguous ? " · แยกข้าว/ข้าวโพดยังไม่ได้" : ""}</span>` : (r.assessment_id ? "ยังสรุปไม่ได้" : "-"));
            const harvest = r.harvest_date ? `${thDate(r.harvest_date)}` : (r.expected_harvest_date ? `คาด ${thDate(r.expected_harvest_date)}` : "-");
            return `<tr class="pick${selected === r.unit_id ? " on" : ""}" data-id="${esc(r.unit_id)}"><td>${esc(r.farmer_name)}<div class="pai-note" style="margin:0">${num(r.area_rai, 2)} ไร่ · ภาพ ${r.ndvi_points}</div></td>
              <td>${esc(r.commodity_name_th || r.commodity_code)}</td><td>${aiCrop}</td><td>${r.assessment_id ? STATUS[r.season_status] || "-" : "ยังไม่วิเคราะห์"}</td>
              <td>${harvest}</td><td class="num">${r.forecast_tons != null ? `${num(r.forecast_tons)}${r.season_status !== "growing" ? '<div class="pai-note" style="margin:0">ฤดูที่แล้ว</div>' : ""}` : "-"}</td><td>${r.assessment_id ? badge(r.risk_level) : badge(null)}</td>
              <td>${flags.map((f) => `<span class="pai-chip">${esc(FLAG_TH[f.code] || f.code)}</span>`).join("")}</td></tr>`;
          }).join("")
        }</tbody></table>`;
        el.querySelectorAll("tr.pick").forEach((tr) => tr.addEventListener("click", () => openDetail(tr.dataset.id)));
      } catch (err) { el.innerHTML = `<div class="pai-note">${esc(errText(err))}</div>`; }
    }

    async function openDetail(id) {
      selected = id;
      host.querySelectorAll("#paiList tr.pick").forEach((tr) => tr.classList.toggle("on", tr.dataset.id === id));
      const el = host.querySelector("#paiDetail");
      el.style.display = "block";
      el.innerHTML = '<div class="pai-note">กำลังโหลด…</div>';
      try {
        const d = await api.get(`${base}/units/${id}`);
        const r = d.result;
        const fc = r && r.forecast;
        const scores = r ? Object.entries(r.crop_scores || {}).sort((a, b) => b[1] - a[1]).slice(0, 4) : [];
        const sev = { high: "#d92d20", medium: "#f79009", info: "#98a2b3" };
        el.innerHTML = `
          <div class="pai-row" style="justify-content:space-between">
            <h3 style="margin:0">${esc(d.farmer_name)} · ${esc(d.commodity_name_th || d.commodity_code)} · ${num(d.area_rai, 2)} ไร่</h3>
            <div>${onOpenPlot ? '<button class="pai-btn" id="paiNdvi">ดูกราฟ NDVI และภาพดาวเทียม</button> ' : ""}<button class="pai-btn" id="paiReassess">วิเคราะห์แปลงนี้ใหม่</button></div>
          </div>
          ${!r ? '<div class="pai-note">ยังไม่ได้วิเคราะห์แปลงนี้ — กด "วิเคราะห์แปลงนี้ใหม่"</div>' : `
          <div class="pai-note">วิเคราะห์เมื่อ ${thDate(r.as_of)} · ${badge(r.risk_level)}</div>
          <div class="pai-stats">
            <div class="pai-stat"><b>ชนิดพืช</b><span>${r.confirmed_crop ? crop(r.confirmed_crop) + " (ยืนยันแล้ว)" : crop(r.predicted_crop)}</span>
              <small>${r.confirmed_crop ? `AI อ่านได้ ${crop(r.predicted_crop)}` : `ความมั่นใจ ${Math.round((r.crop_confidence || 0) * 100)}% · ${esc(METHOD_TH[r.crop_method] || r.crop_method)}`}${r.crop_ambiguous ? " · กราฟ NDVI ของข้าวและข้าวโพดใกล้กันมาก" : ""}</small></div>
            <div class="pai-stat"><b>สถานะฤดู</b><span>${STATUS[r.season_status] || "-"}</span><small>ความเขียวสูงสุด ${r.peak_ndvi != null ? num(r.peak_ndvi, 2) : "-"} เมื่อ ${thDate(r.peak_date)}</small></div>
            <div class="pai-stat"><b>วันปลูก (ประมาณ)</b><span>${thDate(r.planting_date)}</span><small>${esc(r.planting_date_note || "จากจุดที่ NDVI เริ่มสูงขึ้น")}</small></div>
            <div class="pai-stat"><b>${r.harvest_date ? "เก็บเกี่ยว (จากภาพ)" : "คาดว่าจะเก็บเกี่ยว"}</b><span>${thDate(r.harvest_date || r.expected_harvest_date)}</span>${r.expected_harvest_note ? `<small>${esc(r.expected_harvest_note)}</small>` : ""}</div>
            <div class="pai-stat"><b>ผลผลิตคาดการณ์</b><span>${fc ? `${num(fc.tons)} ตัน` : "-"}</span>
              <small>${fc ? `${num(fc.tons_low)}–${num(fc.tons_high)} ตัน · ${num(fc.yield_t_per_rai, 2)} ตัน/ไร่ · ${esc(METHOD_TH[fc.method] || fc.method)}` : esc(r.forecast_note || "")}</small></div>
          </div>
          <div style="font-weight:600;font-size:14px;margin:4px 0">สิ่งที่พบ</div>
          ${(r.flags || []).length ? r.flags.map((f) => `<div class="pai-flag" style="border-color:${sev[f.severity] || "#98a2b3"};background:#fcfcfd"><b>${esc(FLAG_TH[f.code] || f.code)}</b> — ${esc(f.message_th)}</div>`).join("")
            : '<div class="pai-note">ไม่พบความผิดปกติ ข้อมูลในระบบสอดคล้องกับภาพดาวเทียม</div>'}
          ${scores.length ? `<div style="font-weight:600;font-size:14px;margin:12px 0 4px">ความเข้ากันของกราฟ NDVI กับพืชแต่ละชนิด</div>
            <table class="pai-table" style="max-width:520px">${scores.map(([c, v]) => `<tr><td style="width:150px">${crop(c)}</td><td><div class="pai-bar" style="width:${Math.round(v * 100)}%"></div></td><td class="num" style="width:50px">${Math.round(v * 100)}%</td></tr>`).join("")}</table>` : ""}`}
          <div style="font-weight:600;font-size:14px;margin:16px 0 4px">ยืนยันชนิดพืชของแปลงนี้</div>
          <p class="pai-note">ใส่สิ่งที่ปลูกจริงจากการลงพื้นที่หรือสอบถามเจ้าของแปลง ระบบจะใช้แทนการเดาของ AI และเก็บเป็นข้อมูลสอนโมเดล</p>
          <form class="pai-form" id="paiGtForm">
            <div><label>พืชที่ปลูกจริง</label><select name="crop_code" required>${Object.entries(CROP_TH).map(([k, v]) => `<option value="${k}"${(r && (r.confirmed_crop || r.predicted_crop)) === k ? " selected" : ""}>${v}</option>`).join("")}</select></div>
            <div><label>วันปลูก (ถ้าทราบ)</label><input type="date" name="planting_date"></div>
            <div><label>วันเก็บเกี่ยว (ถ้าเก็บแล้ว)</label><input type="date" name="harvest_date"></div>
            <div style="grid-column:1/-1"><label>หมายเหตุ</label><input name="note" maxlength="500" placeholder="เช่น ผักบุ้งฝั่งเหนือ 5.8 ไร่ ที่เหลือเป็นบ่อน้ำ"></div>
            <div><button class="pai-btn primary" type="submit">บันทึกการยืนยัน</button></div>
          </form>
          ${d.ground_truth.length ? `<table class="pai-table" style="margin-top:10px"><thead><tr><th>ยืนยันเมื่อ</th><th>พืช</th><th>ปลูก</th><th>เก็บเกี่ยว</th><th>โดย</th><th>หมายเหตุ</th></tr></thead><tbody>${
            d.ground_truth.map((g) => `<tr><td>${thDate(g.created_at)}</td><td>${crop(g.crop_code)}</td><td>${thDate(g.planting_date)}</td><td>${thDate(g.harvest_date)}</td>
              <td>${{ cooperative: "สหกรณ์", platform: "AgroLink", farmer: "เกษตรกร", field_survey: "สำรวจภาคสนาม" }[g.source] || esc(g.source)}</td><td>${esc(g.note)}</td></tr>`).join("")}</tbody></table>` : ""}`;
        const ndvi = el.querySelector("#paiNdvi");
        if (ndvi) ndvi.addEventListener("click", () => onOpenPlot(id));
        el.querySelector("#paiReassess").addEventListener("click", async (e) => {
          e.target.disabled = true;
          try { await api.post(`${base}/assess`, { unit_id: id }); await Promise.all([loadList(), loadForecast()]); openDetail(id); } catch (err) { alert(errText(err)); e.target.disabled = false; }
        });
        el.querySelector("#paiGtForm").addEventListener("submit", async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const body = { unit_id: id, crop_code: fd.get("crop_code") };
          ["planting_date", "harvest_date", "note"].forEach((k) => { if (fd.get(k)) body[k] = fd.get(k); });
          const btn = e.target.querySelector("button"); btn.disabled = true;
          try { await api.post(`${base}/ground-truth`, body); await Promise.all([loadList(), loadForecast()]); openDetail(id); } catch (err) { alert(errText(err)); btn.disabled = false; }
        });
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (err) { el.innerHTML = `<div class="pai-note">${esc(errText(err))}</div>`; }
    }

    async function loadModels() {
      const el = host.querySelector("#paiModels");
      try {
        const s = await api.get(`${base}/summary`);
        const active = (kind, cropCode) => s.active_models.find((m) => m.model_kind === kind && (m.crop_code || null) === (cropCode || null));
        const latest = (kind, cropCode) => s.models.find((m) => m.model_kind === kind && (m.crop_code || null) === (cropCode || null));
        const why = { insufficient_data: "ข้อมูลยังไม่พอ", not_better_than_rules: "ยังไม่แม่นกว่าวิธีพื้นฐาน", not_better_than_baseline: "ยังไม่แม่นกว่าวิธีพื้นฐาน", below_min_accuracy: "ความแม่นยำยังไม่ถึงเกณฑ์", beats_rule_baseline: "แม่นกว่าวิธีพื้นฐาน", beats_baseline: "แม่นกว่าวิธีพื้นฐาน" };
        const row = (label, kind, cropCode, need) => {
          const a = active(kind, cropCode); const l = latest(kind, cropCode);
          const m = (a || l || {}).metrics || {};
          const metric = kind === "crop_classifier"
            ? (m.cv_accuracy != null ? `แม่น ${Math.round(m.cv_accuracy * 100)}% (กฎพื้นฐาน ${Math.round(m.rule_accuracy * 100)}%)` : "-")
            : (m.cv_mape != null ? `คลาดเคลื่อน ${Math.round(m.cv_mape * 100)}% (พื้นฐาน ${Math.round(m.baseline_mape * 100)}%)` : "-");
          return `<tr><td>${label}</td><td>${a ? '<span class="pai-badge" style="color:#067647;background:#dcfae6">ใช้งานอยู่</span>' : '<span class="pai-badge" style="color:#475467;background:#f2f4f7">ใช้วิธีพื้นฐาน</span>'}</td>
            <td>${l ? `${thDate(l.trained_at)} · ${l.sample_size} ตัวอย่าง · ${why[l.reason] || esc(l.reason)}` : "ยังไม่เคยเทรน"}</td><td>${metric}</td><td class="pai-note">${need}</td></tr>`;
        };
        const gt = s.ground_truth.map((g) => `${crop(g.crop_code)} ${g.plots}`).join(" · ") || "ยังไม่มี";
        const rc = s.risk_counts;
        el.innerHTML = `<h3>🧠 สถานะโมเดล AI (AgroLink SatAI)</h3>
          <p class="pai-note">โมเดลที่เรียนรู้จากข้อมูลจะถูกเปิดใช้ก็ต่อเมื่อทดสอบไขว้ (5-fold cross-validation) แล้วแม่นกว่าวิธีพื้นฐานเท่านั้น
            ระหว่างนี้ระบบใช้กฎทางพืชศาสตร์และค่าเฉลี่ยของพืช ซึ่งบอกไว้ในผลทุกแปลงว่ามาจากวิธีไหน</p>
          <div class="pai-stats">
            <div class="pai-stat"><b>แปลงเสี่ยงสูง / ปานกลาง</b><span>${rc.high || 0} / ${rc.medium || 0}</span><small>ปกติ ${rc.low || 0} · ข้อมูลไม่พอ ${rc.unknown || 0} · ยังไม่วิเคราะห์ ${rc.not_assessed || 0}</small></div>
            <div class="pai-stat"><b>แปลงที่ยืนยันพืชแล้ว</b><span>${s.ground_truth.reduce((a, g) => a + g.plots, 0)}</span><small>${gt}</small></div>
            <div class="pai-stat"><b>วิเคราะห์ล่าสุด</b><span>${s.last_assessed_at ? thDate(s.last_assessed_at) : "-"}</span></div>
          </div>
          <div class="pai-scroll"><table class="pai-table"><thead><tr><th>โมเดล</th><th>สถานะ</th><th>เทรนล่าสุด</th><th>ผลทดสอบ</th><th>ต้องการ</th></tr></thead><tbody>
            ${row("จำแนกชนิดพืช", "crop_classifier", null, `แปลงที่ยืนยันแล้ว ≥ ${s.thresholds.crop_min_samples} แปลง และ ≥ ${s.thresholds.crop_min_per_class} แปลงต่อชนิด อย่างน้อย 2 ชนิด`)}
            ${["rice", "maize", "cassava", "sugarcane"].map((c) => row(`พยากรณ์ผลผลิต${crop(c)}`, "yield_forecaster", c, `ฤดูที่เก็บเกี่ยวแล้วและมีน้ำหนักรับซื้อ ≥ ${s.thresholds.yield_min_samples} ฤดู`)).join("")}
          </tbody></table></div>
          <div class="pai-row" style="margin-top:10px"><button class="pai-btn primary" id="paiRetrain">เทรนโมเดลใหม่จากข้อมูลล่าสุด</button><span class="pai-note" id="paiRetrainMsg" style="margin:0"></span></div>`;
        el.querySelector("#paiRetrain").addEventListener("click", async (e) => {
          e.target.disabled = true;
          const msg = el.querySelector("#paiRetrainMsg");
          msg.textContent = "กำลังเทรน…";
          try {
            const r = await api.post(`${base}/retrain`, {});
            const on = r.runs.filter((x) => x.activated).length;
            msg.textContent = `เสร็จแล้ว — ใช้ตัวอย่างจำแนกพืช ${r.crop_samples} แปลง · เปิดใช้โมเดลใหม่ ${on} ตัว`;
            await loadModels();
          } catch (err) { msg.textContent = errText(err); e.target.disabled = false; }
        });
      } catch (err) { el.innerHTML = `<div class="pai-note">${esc(errText(err))}</div>`; }
    }

    async function loadProfiles() {
      const el = host.querySelector("#paiProfiles");
      try {
        const order = ["rice", "maize", "cassava", "sugarcane"];
        const rows = (await api.get(`${base}/crop-profiles`)).filter((p) => order.includes(p.crop_code)).sort((a, b) => order.indexOf(a.crop_code) - order.indexOf(b.crop_code));
        el.innerHTML = `<h3>📏 ค่าอ้างอิงของพืช (ใช้พยากรณ์ผลผลิตแบบพื้นฐานและตรวจผลผลิตที่เป็นไปไม่ได้)</h3>
          <p class="pai-note">ค่าที่ติดตั้งมาเป็นค่าเฉลี่ยโดยประมาณ ควรตรวจสอบกับข้อมูล สศก. หรือข้อมูลของสหกรณ์แล้วแก้ไขให้ตรงพื้นที่</p>
          <div class="pai-scroll"><table class="pai-table"><thead><tr><th>พืช</th><th class="num">ผลผลิตเฉลี่ย (ตัน/ไร่)</th><th class="num">สูงสุดที่เป็นไปได้ (ตัน/ไร่)</th>
            <th class="num">NDVI สูงสุดอ้างอิง</th><th class="num">วันจาก NDVI สูงสุดถึงเก็บเกี่ยว</th><th>ที่มา</th><th></th></tr></thead><tbody>${
          rows.map((p) => `<tr data-crop="${p.crop_code}"><td>${crop(p.crop_code)}</td>
            <td class="num"><input class="pai-small-input" name="typical_yield_t_per_rai" value="${p.typical_yield_t_per_rai ?? ""}"></td>
            <td class="num"><input class="pai-small-input" name="max_yield_t_per_rai" value="${p.max_yield_t_per_rai ?? ""}"></td>
            <td class="num"><input class="pai-small-input" name="reference_peak_ndvi" value="${p.reference_peak_ndvi ?? ""}"></td>
            <td class="num"><input class="pai-small-input" name="peak_to_harvest_days" value="${p.peak_to_harvest_days ?? ""}"></td>
            <td class="pai-note">${esc(p.source_note)}</td><td><button class="pai-btn">บันทึก</button></td></tr>`).join("")
        }</tbody></table></div>`;
        el.querySelectorAll("tr[data-crop] button").forEach((b) => b.addEventListener("click", async () => {
          const tr = b.closest("tr"); const body = {};
          tr.querySelectorAll("input").forEach((i) => { body[i.name] = i.value === "" ? null : Number(i.value); });
          b.disabled = true;
          try { await api.put(`${base}/crop-profiles/${tr.dataset.crop}`, body); b.textContent = "บันทึกแล้ว"; } catch (err) { alert(errText(err)); }
          b.disabled = false;
        }));
      } catch (err) { el.innerHTML = `<div class="pai-note">${esc(errText(err))}</div>`; }
    }

    host.querySelector("#paiRisk").addEventListener("change", loadList);
    host.querySelector("#paiAssessAll").addEventListener("click", async (e) => {
      const msg = host.querySelector("#paiAssessMsg");
      e.target.disabled = true; msg.textContent = "กำลังวิเคราะห์…";
      try {
        const r = await api.post(`${base}/assess`, {});
        msg.textContent = `วิเคราะห์แล้ว ${r.assessed} แปลง${r.truncated ? ` (จาก ${r.total_plots} — กดอีกครั้งเพื่อทำต่อ)` : ""}`;
        await Promise.all([loadList(), loadForecast(), admin ? loadModels() : null]);
      } catch (err) { msg.textContent = errText(err); }
      e.target.disabled = false;
    });

    loadForecast(); loadList();
    if (admin) { loadModels(); loadProfiles(); }
  }

  function errText(err) {
    const m = (err && (err.message || err.error)) || String(err);
    if (/plot_ai_not_installed/.test(m)) return "ยังไม่ได้ติดตั้งตารางของ AI ในฐานข้อมูล — ต้องรัน backend/db/grant_plot_ai.sql ก่อน (ดู DEPLOY.md)";
    return `เกิดข้อผิดพลาด: ${m}`;
  }

  window.AgroLinkPlotAI = { mount };
})();
