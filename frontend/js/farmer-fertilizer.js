/**
 * พอร์ทัลเกษตรกร › 🧪 ปุ๋ยสั่งตัด (ข้อมูลดิน กพด.)
 * ค่าดินของแปลงได้ 3 ทาง: (1) ผลวิเคราะห์ดินสาธารณะของกรมพัฒนาที่ดินจุดที่ใกล้แปลง
 * (GET /farmer/ldd/soil-nearby) (2) กรอกจากใบรายงานแล็บ กพด. (3) กรอกจาก LDD Test Kit
 * แล้วคำนวณสูตรปุ๋ยด้วย POST /farmer/fertilizer-formula/calculate (routes/fertilizer.js)
 * AgroLinkFarmerFertilizer.mount(host)
 */
(function () {
  "use strict";
  const API = AgroLinkAPI; // js/api.js (top-level const, not on window)
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const thDate = (v) => { if (!v) return "-"; const [y, m, d] = String(v).slice(0, 10).split("-").map(Number); return y ? `${d} ${MONTHS[m - 1]} ${y + 543}` : "-"; };
  const n2 = (v) => (v == null || v === "" ? "-" : Number(v).toLocaleString("th-TH", { maximumFractionDigits: 2 }));
  const LEVEL = { low: "ต่ำ", medium: "ปานกลาง", high: "สูง" };
  const SOURCE = { manual: "บันทึกเอง", ldd_baseline: "ข้อมูล กพด.", ldd_lab: "ใบรายงานแล็บ กพด.", ldd_testkit: "LDD Test Kit", ldd_nearby: "ค่าดิน กพด. ใกล้แปลง (ประมาณการ)" };
  const UNIT_TYPE = { Plot: "แปลง", Pen: "คอก", Pond: "บ่อ", Orchard: "สวน" };
  const ERR = {
    production_unit_not_found: "ไม่พบแปลงนี้", province_required: "เลือกจังหวัดของแปลงก่อน", ldd_not_installed: "ระบบข้อมูลดิน กพด. ยังไม่ได้ติดตั้งบนเซิร์ฟเวอร์",
    unsupported_commodity: "ตัวคำนวณยังไม่รองรับพืชของแปลงนี้ (รองรับ ข้าว/ข้าวหอมมะลิ/มันสำปะหลัง)",
  };
  // same cut-offs as backend/src/lib/lddSoil.js CRITERIA
  const CUT = { om: [1.5, 3.5], p: [10, 25], k: [60, 90] };
  const levelOf = (kind, v) => { if (v === "" || v == null || !Number.isFinite(Number(v))) return ""; const [lo, hi] = CUT[kind]; const x = Number(v); return x < lo ? "low" : x > hi ? "high" : "medium"; };
  const levelSel = (name, val) => `<select name="${name}">${["low", "medium", "high"].map((l) => `<option value="${l}"${l === (val || "medium") ? " selected" : ""}>${LEVEL[l]}</option>`).join("")}</select>`;
  const errText = (e) => ERR[(e.body || {}).error] || (e.body && (e.body.detail || e.body.error)) || e.message;

  function css() {
    if (document.getElementById("ff-css")) return;
    const s = document.createElement("style"); s.id = "ff-css";
    s.textContent = `
      .ff-card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);padding:16px 18px;margin-bottom:16px}
      .ff-card h3{margin:0 0 8px;font-size:16px;color:#123d2b}
      .ff-note{font-size:13px;color:#667085;margin:0 0 10px;line-height:1.6}
      .ff-row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
      .ff-row label{display:flex;flex-direction:column;font-size:13px;font-weight:600;gap:4px;min-width:140px;flex:1}
      .ff-row input,.ff-row select{font:inherit;font-size:14px;padding:8px 10px;border:1px solid #d0d5dd;border-radius:8px}
      .ff-btn{font:inherit;font-size:14px;font-weight:700;border:0;border-radius:8px;padding:9px 16px;background:#1b6b4a;color:#fff;cursor:pointer}
      .ff-btn.ghost{background:#f2f4f7;color:#1d2939}.ff-btn.gold{background:#c9a227;color:#123d2b}
      .ff-btn:disabled{opacity:.6;cursor:wait}
      .ff-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
      .ff-tabs button{font:inherit;font-size:13.5px;border:1px solid #d0d5dd;background:#fff;border-radius:999px;padding:6px 14px;cursor:pointer}
      .ff-tabs button.on{background:#1b6b4a;color:#fff;border-color:#1b6b4a}
      .ff-tbl{width:100%;border-collapse:collapse;font-size:13.5px}
      .ff-tbl th,.ff-tbl td{padding:8px;border-bottom:1px solid #eaecf0;text-align:left;vertical-align:top}
      .ff-tbl th{background:#f0f7f3;color:#123d2b}
      .ff-chip{display:inline-block;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:700;background:#f2f4f7;color:#344054}
      .ff-chip.low{background:#fef3f2;color:#b42318}.ff-chip.medium{background:#fffaeb;color:#b54708}.ff-chip.high{background:#ecfdf3;color:#067647}
      .ff-chip.src{background:#eff8ff;color:#175cd3}
      .ff-links{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
      .ff-link{border:1px solid #eaecf0;border-left:4px solid #c9a227;border-radius:10px;padding:12px 14px;text-decoration:none;color:inherit;display:block}
      .ff-link b{display:block;color:#123d2b;margin-bottom:4px}.ff-link span{font-size:13px;color:#475467}
      .ff-kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:8px 0 12px}
      .ff-kpi div{background:#f0f7f3;border-radius:10px;padding:10px;text-align:center}.ff-kpi b{display:block;font-size:20px;color:#123d2b}.ff-kpi small{color:#475467}
      .ff-msg{padding:10px 12px;border-radius:8px;font-size:13.5px;margin-top:10px}
      .ff-msg.err{background:#fef3f2;color:#b42318}.ff-msg.ok{background:#ecfdf3;color:#067647}.ff-msg.warn{background:#fffaeb;color:#b54708}
    `;
    document.head.appendChild(s);
  }

  async function mount(host) {
    css();
    host.innerHTML = '<div class="loading-line">กำลังโหลดแปลงของท่าน…</div>';
    let units = [];
    try { units = await API.get("/farmer/production-units"); } catch (e) { host.innerHTML = `<div class="empty-state">โหลดแปลงไม่สำเร็จ: ${esc(errText(e))}</div>`; return; }
    const provinces = typeof TH_PROVINCES !== "undefined" ? TH_PROVINCES : []; // js/provinces.js
    host.innerHTML = `
      <div class="section-title">🧪 ปุ๋ยสั่งตัด — ใช้ข้อมูลดินจากกรมพัฒนาที่ดิน</div>
      <p class="ff-note">ใส่ปุ๋ยตามที่ดินขาดจริงช่วยลดต้นทุนปุ๋ย ขั้นตอน: เลือกแปลง → หาค่าดินของแปลง (จากจุดตรวจดินของ กพด. ใกล้แปลง หรือผลตรวจดินของแปลงเอง) → คำนวณสูตรปุ๋ย</p>

      <div class="ff-card"><h3>1. เลือกแปลง</h3>
        ${units.length ? `<div class="ff-row">
          <label>แปลง<select id="ffUnit">${units.map((u) => `<option value="${esc(u.unit_id)}">${esc(UNIT_TYPE[u.unit_type] || u.unit_type)} — ${esc(u.commodity_code || "")} · ${n2(u.area_rai)} ไร่</option>`).join("")}</select></label>
          <label>จังหวัดของแปลง<select id="ffProv"><option value="">ใช้จังหวัดในโปรไฟล์ของฉัน</option>${provinces.map(([c, n]) => `<option value="${esc(c)}">${esc(n)}</option>`).join("")}</select></label>
        </div><div id="ffLatest" style="margin-top:12px"></div>` : '<div class="empty-state">ยังไม่มีแปลง — ลงทะเบียนแปลงก่อนที่เมนู "แปลง / หน่วยผลิต"</div>'}
      </div>

      ${units.length ? `<div class="ff-card"><h3>2. หาค่าดินของแปลง</h3>
        <div class="ff-tabs" id="ffTabs">
          <button type="button" class="on" data-t="nearby">ค่าดิน กพด. ใกล้แปลง</button>
          <button type="button" data-t="lab">กรอกจากใบรายงานแล็บ กพด.</button>
          <button type="button" data-t="kit">กรอกจาก LDD Test Kit</button>
        </div>
        <div id="ffTab"></div>
      </div>

      <div class="ff-card"><h3>3. คำนวณสูตรปุ๋ย</h3>
        <p class="ff-note">ระบบใช้ผลตรวจดินล่าสุดของแปลงที่บันทึกไว้ในขั้นที่ 2</p>
        <button type="button" class="ff-btn gold" id="ffCalc">คำนวณสูตรปุ๋ยของแปลงนี้</button>
        <div id="ffCalcOut"></div>
      </div>` : ""}

      <div class="ff-card"><h3>บริการของกรมพัฒนาที่ดิน</h3>
        <div class="ff-links">
          <a class="ff-link" href="https://osd101.ldd.go.th" target="_blank" rel="noopener"><b>ส่งตัวอย่างดินตรวจที่แล็บ กพด. (e-Service)</b><span>ลงทะเบียนแปลง เลือกห้องปฏิบัติการ ส่งดิน 0.5–1 กก. ดูผลและคำแนะนำปุ๋ยออนไลน์ แล้วนำผลมากรอกในแท็บ "ใบรายงานแล็บ กพด."</span></a>
          <a class="ff-link" href="http://iddindee.ldd.go.th" target="_blank" rel="noopener"><b>บัตรดินดี / LDD Test Kit</b><span>ผลตรวจดินแบบรวดเร็ว (N P K pH) จากสถานีพัฒนาที่ดินหรือหมอดินอาสา</span></a>
          <a class="ff-link" href="https://lddcatalog.ldd.go.th/en/dataset/osd01" target="_blank" rel="noopener"><b>ข้อมูลเปิด: การตรวจวิเคราะห์ดิน</b><span>แหล่งของค่าดินใกล้แปลงในหน้านี้ (กรมพัฒนาที่ดิน, Creative Commons Attributions)</span></a>
        </div>
      </div>`;
    if (!units.length) return;

    const $ = (s) => host.querySelector(s);
    const unitId = () => $("#ffUnit").value;

    async function loadLatest() {
      const el = $("#ffLatest");
      el.innerHTML = '<span class="ff-note">กำลังโหลดผลตรวจดิน…</span>';
      try {
        const tests = await API.get(`/farmer/soil-tests?unit_id=${encodeURIComponent(unitId())}`);
        const t = tests[0];
        el.innerHTML = t ? `<div class="ff-note" style="margin:0">ผลตรวจดินล่าสุด ${thDate(t.tested_at)} <span class="ff-chip src">${esc(SOURCE[t.source] || t.source)}</span>
          · N <span class="ff-chip ${t.n_level}">${LEVEL[t.n_level]}</span> P <span class="ff-chip ${t.p_level}">${LEVEL[t.p_level]}</span> K <span class="ff-chip ${t.k_level}">${LEVEL[t.k_level]}</span>
          ${t.ph_value != null ? ` · pH ${n2(t.ph_value)}` : ""}${t.organic_matter_pct != null ? ` · OM ${n2(t.organic_matter_pct)}%` : ""}</div>`
          : '<div class="ff-msg warn" style="margin:0">แปลงนี้ยังไม่มีผลตรวจดิน — เลือกวิธีหาค่าดินในขั้นที่ 2</div>';
      } catch (e) { el.innerHTML = `<div class="ff-msg err">${esc(errText(e))}</div>`; }
    }

    async function save(payload, okText) {
      await API.post("/farmer/soil-tests", { unit_id: unitId(), ...payload });
      await loadLatest();
      return okText;
    }

    const TABS = {
      nearby(el) {
        el.innerHTML = `<p class="ff-note">ค้นหาผลวิเคราะห์ดินของกรมพัฒนาที่ดินจุดที่ใกล้แปลงที่สุด (ภายใน 50 กม.) ใช้เป็นค่าประมาณเมื่อแปลงยังไม่เคยตรวจดิน</p>
          <button type="button" class="ff-btn" id="ffNear">ค้นหาค่าดินใกล้แปลง</button><div id="ffNearOut"></div>`;
        el.querySelector("#ffNear").addEventListener("click", async (ev) => {
          const btn = ev.currentTarget; const out = el.querySelector("#ffNearOut");
          btn.disabled = true; out.innerHTML = '<p class="ff-note">กำลังดึงข้อมูลจากกรมพัฒนาที่ดิน… (ครั้งแรกของจังหวัดอาจใช้เวลาครึ่งนาที)</p>';
          try {
            const prov = $("#ffProv").value;
            const d = await API.get(`/farmer/ldd/soil-nearby?unit_id=${encodeURIComponent(unitId())}${prov ? `&province_code=${encodeURIComponent(prov)}` : ""}`);
            const warn = d.sync && d.sync.status === "error" ? `<div class="ff-msg warn">เชื่อมต่อกรมพัฒนาที่ดินไม่สำเร็จ (${esc(d.sync.error)}) — แสดงข้อมูลที่เคยดึงไว้ล่าสุด (ถ้ามี)</div>` : "";
            if (!d.samples.length) { out.innerHTML = `${warn}<div class="ff-msg warn">ไม่พบจุดตรวจดินของ กพด. ใน${esc(d.province)} ภายใน 50 กม. จากแปลงนี้ — แนะนำส่งตัวอย่างดินตรวจผ่าน e-Service ของ กพด.</div>`; return; }
            out.innerHTML = `${warn}<div style="overflow-x:auto;margin-top:10px"><table class="ff-tbl"><thead><tr><th>ระยะห่าง</th><th>ที่ตั้ง / วันที่ตรวจ</th><th>pH</th><th>OM %</th><th>P (mg/kg)</th><th>K (mg/kg)</th><th>ระดับ N / P / K</th><th></th></tr></thead><tbody>
              ${d.samples.map((s, i) => `<tr><td>${n2(s.distance_km)} กม.</td><td>${esc([s.district && `ต.${s.district}`, s.amphur && `อ.${s.amphur}`].filter(Boolean).join(" ") || d.province)}<br><span class="ff-note">${thDate(s.sampled_on)}</span></td>
                <td>${n2(s.ph)}</td><td>${n2(s.om_pct)}</td><td>${n2(s.p_ppm)}</td><td>${n2(s.k_ppm)}</td>
                <td>${["n_level", "p_level", "k_level"].map((k) => (s.levels[k] ? `<span class="ff-chip ${s.levels[k]}">${LEVEL[s.levels[k]]}</span>` : '<span class="ff-chip">ไม่มีข้อมูล</span>')).join(" ")}</td>
                <td><button type="button" class="ff-btn ghost" data-use="${i}">ใช้ค่านี้</button></td></tr>`).join("")}
              </tbody></table></div>
              <p class="ff-note" style="margin-top:8px">${esc(d.note)} ระดับที่ไม่มีข้อมูลจะบันทึกเป็น "ปานกลาง" (ไม่ปรับสูตร) · ที่มา: <a href="${esc(d.source.url)}" target="_blank" rel="noopener">${esc(d.source.name)}</a></p><div id="ffNearMsg"></div>`;
            out.querySelectorAll("[data-use]").forEach((b) => b.addEventListener("click", async () => {
              const s = d.samples[Number(b.dataset.use)];
              const msg = out.querySelector("#ffNearMsg");
              try {
                msg.innerHTML = `<div class="ff-msg ok">${esc(await save({
                  n_level: s.levels.n_level || "medium", p_level: s.levels.p_level || "medium", k_level: s.levels.k_level || "medium",
                  ph_value: s.ph, organic_matter_pct: s.om_pct, p_ppm: s.p_ppm, k_ppm: s.k_ppm, source: "ldd_nearby",
                  source_detail: { sample_key: s.sample_key, distance_km: s.distance_km, sampled_on: s.sampled_on, province: d.province, amphur: s.amphur, district: s.district },
                  notes: `ค่าดินจากจุดตรวจของกรมพัฒนาที่ดิน ห่างแปลง ${s.distance_km} กม. (${s.sampled_on || "ไม่ทราบวันที่"})`,
                }, "บันทึกค่าดินแล้ว — คำนวณสูตรปุ๋ยในขั้นที่ 3 ได้เลย"))}</div>`;
              } catch (e) { msg.innerHTML = `<div class="ff-msg err">${esc(errText(e))}</div>`; }
            }));
          } catch (e) { out.innerHTML = `<div class="ff-msg err">${esc(errText(e))}</div>`; } finally { btn.disabled = false; }
        });
      },
      lab(el) {
        el.innerHTML = `<p class="ff-note">กรอกตัวเลขจากใบรายงานผลวิเคราะห์ดินของกรมพัฒนาที่ดิน ระบบจะเลือกระดับให้อัตโนมัติ ถ้าในใบรายงานระบุระดับไว้ต่างจากนี้ ให้เลือกตามใบรายงาน</p>
          <form id="ffLab"><div class="ff-row">
            <label>เลขที่รายงาน / คำขอ<input name="report_no"></label>
            <label>วันที่เก็บตัวอย่าง<input type="date" name="sampled_on"></label>
            <label>pH<input name="ph" inputmode="decimal"></label>
            <label>อินทรียวัตถุ (%)<input name="om" inputmode="decimal"></label>
            <label>ฟอสฟอรัส P (mg/kg)<input name="p" inputmode="decimal"></label>
            <label>โพแทสเซียม K (mg/kg)<input name="k" inputmode="decimal"></label>
          </div><div class="ff-row" style="margin-top:10px">
            <label>ระดับ N (จากอินทรียวัตถุ)${levelSel("n_level")}</label><label>ระดับ P${levelSel("p_level")}</label><label>ระดับ K${levelSel("k_level")}</label>
          </div><button class="ff-btn" style="margin-top:12px">บันทึกผลตรวจดิน</button><div id="ffLabMsg"></div></form>`;
        const f = el.querySelector("#ffLab");
        const auto = () => {
          [["om", "n_level"], ["p", "p_level"], ["k", "k_level"]].forEach(([k, sel]) => { const l = levelOf(k, f[k].value); if (l) f[sel].value = l; });
        };
        ["om", "p", "k"].forEach((k) => f[k].addEventListener("input", auto));
        f.addEventListener("submit", async (e) => {
          e.preventDefault();
          const num = (v) => (v === "" ? null : Number(v));
          const msg = el.querySelector("#ffLabMsg");
          try {
            msg.innerHTML = `<div class="ff-msg ok">${esc(await save({
              n_level: f.n_level.value, p_level: f.p_level.value, k_level: f.k_level.value,
              ph_value: num(f.ph.value), organic_matter_pct: num(f.om.value), p_ppm: num(f.p.value), k_ppm: num(f.k.value), source: "ldd_lab",
              source_detail: { report_no: f.report_no.value || null, sampled_on: f.sampled_on.value || null },
              notes: f.report_no.value ? `ใบรายงานแล็บ กพด. เลขที่ ${f.report_no.value}` : "ใบรายงานแล็บ กพด.",
            }, "บันทึกผลตรวจดินแล้ว"))}</div>`;
          } catch (err) { msg.innerHTML = `<div class="ff-msg err">${esc(errText(err))}</div>`; }
        });
      },
      kit(el) {
        el.innerHTML = `<p class="ff-note">เลือกระดับตามแถบสีของชุดตรวจดิน LDD Test Kit หรือตามบัตรดินดี</p>
          <form id="ffKit"><div class="ff-row">
            <label>ไนโตรเจน (N)${levelSel("n_level")}</label><label>ฟอสฟอรัส (P)${levelSel("p_level")}</label><label>โพแทสเซียม (K)${levelSel("k_level")}</label><label>pH (ถ้ามี)<input name="ph" inputmode="decimal"></label>
          </div><button class="ff-btn" style="margin-top:12px">บันทึกผลตรวจดิน</button><div id="ffKitMsg"></div></form>`;
        const f = el.querySelector("#ffKit");
        f.addEventListener("submit", async (e) => {
          e.preventDefault();
          const msg = el.querySelector("#ffKitMsg");
          try {
            msg.innerHTML = `<div class="ff-msg ok">${esc(await save({
              n_level: f.n_level.value, p_level: f.p_level.value, k_level: f.k_level.value, ph_value: f.ph.value === "" ? null : Number(f.ph.value),
              source: "ldd_testkit", notes: "LDD Test Kit",
            }, "บันทึกผลตรวจดินแล้ว"))}</div>`;
          } catch (err) { msg.innerHTML = `<div class="ff-msg err">${esc(errText(err))}</div>`; }
        });
      },
    };
    function showTab(t) {
      host.querySelectorAll("#ffTabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
      TABS[t]($("#ffTab"));
    }
    host.querySelectorAll("#ffTabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.t)));

    $("#ffCalc").addEventListener("click", async (ev) => {
      const btn = ev.currentTarget; const out = $("#ffCalcOut");
      btn.disabled = true;
      try {
        const c = await API.post("/farmer/fertilizer-formula/calculate", { unit_id: unitId() });
        out.innerHTML = `
          ${c.soil_test_missing_note ? `<div class="ff-msg warn">${esc(c.soil_test_missing_note.split(" (POST")[0])}</div>` : ""}
          <p class="ff-note" style="margin-top:10px">${esc(c.commodity_name_th)} · ${n2(c.area_rai)} ไร่ — ธาตุอาหารที่ต้องใส่ทั้งแปลง</p>
          <div class="ff-kpi"><div><small>ไนโตรเจน N</small><b>${n2(c.n_required_kg)}</b><small>กก.</small></div><div><small>ฟอสเฟต P₂O₅</small><b>${n2(c.p2o5_required_kg)}</b><small>กก.</small></div><div><small>โพแทช K₂O</small><b>${n2(c.k2o_required_kg)}</b><small>กก.</small></div></div>
          <table class="ff-tbl"><thead><tr><th>แม่ปุ๋ย</th><th>ปริมาณ (กก.)</th><th>ราคาต่ำสุดบน AgroLink</th></tr></thead><tbody>
            ${c.fertilizer_breakdown.map((b) => `<tr><td>${esc(b.label_th)} (${esc(b.grade)})</td><td>${n2(b.kg)}</td><td>${b.subtotal != null ? `${n2(b.subtotal)} บาท` : "ยังไม่มีราคา"}</td></tr>`).join("")}
          </tbody></table>
          ${c.estimated_cost != null ? `<p style="margin:10px 0 0"><b>ประมาณการค่าปุ๋ย ${n2(c.estimated_cost)} บาท</b></p>` : ""}
          <p class="ff-note" style="margin-top:8px">${esc(c.disclaimer)}</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap"><a class="ff-btn" style="text-decoration:none" href="fertilizer-mixing-marketplace.html">สั่งผสมปุ๋ยตามสูตรนี้</a><a class="ff-btn ghost" style="text-decoration:none" href="fertilizer-calculator.html">ดูประวัติการคำนวณ</a></div>`;
      } catch (e) { out.innerHTML = `<div class="ff-msg err">${esc(errText(e))}</div>`; } finally { btn.disabled = false; }
    });

    $("#ffUnit").addEventListener("change", () => { loadLatest(); $("#ffCalcOut").innerHTML = ""; showTab("nearby"); });
    showTab("nearby");
    loadLatest();
  }

  window.AgroLinkFarmerFertilizer = { mount };
})();
