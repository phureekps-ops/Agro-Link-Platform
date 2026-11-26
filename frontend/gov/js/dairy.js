/**
 * Dashboard นโยบายโคนม (ภาครัฐ) — backend/src/routes/dairygov.js (/dairy-gov).
 * อ่านอย่างเดียว ตามขอบเขตจังหวัด/ประเทศของเจ้าหน้าที่. รายสหกรณ์แสดงเฉพาะ
 * สหกรณ์ที่ยินยอมแบ่งปันข้อมูล (dairy.setting.gov_data_consent).
 */
(function () {
  "use strict";
  const API = AgroLinkGovAPI;
  if (!API.requireSessionOrRedirect()) return;
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const n2 = (v) => (v == null ? "-" : Number(v).toLocaleString("th-TH", { maximumFractionDigits: 1 }));
  const LV = { green: "ปกติ", yellow: "เฝ้าระวัง", orange: "เตรียมระบาย", red: "วิกฤต" };
  const lvl = (a) => `<span class="dg-lvl ${a.level}"></span>${LV[a.level]}${a.surplus_pct == null ? (a.level === "red" ? " (ไม่มีสัญญารองรับ)" : "") : ` (${a.surplus_pct > 0 ? "+" : ""}${n2(a.surplus_pct)}%)`}`;
  const table = (heads, rows) => (rows.length ? `<div class="dg-scroll"><table class="dg-table"><thead><tr>${heads.map((h) => `<th${h[0] === "#" ? ' class="num"' : ""}>${h.replace(/^#/, "")}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` : '<p class="dg-note">ยังไม่มีข้อมูล</p>');
  $("#logoutBtn").addEventListener("click", () => API.logout());

  API.get("/dairy-gov/overview").then((g) => {
    $("#officerName").textContent = `${g.officer.full_name} (${g.officer.scope_type === "National" ? "ระดับประเทศ" : "จังหวัด " + g.officer.province_code})`;
    const t = g.totals;
    const fw = (c, days) => (c.forecast.find((w) => w.days === days) || null);
    $("#content").innerHTML = `
      <p class="dg-note">ข้อมูล ณ ${esc(g.as_of)} จากสหกรณ์ที่ใช้แพลตฟอร์มบริหารโคนมแห่งชาติ (National Dairy Management Platform) ของ AgroLink — ไม่ใช่สถิติทางการทั้งประเทศ เกณฑ์สีเป็นข้อเสนอเพื่อออกแบบระบบ (เหลือง &gt;1% ส้ม &gt;3% แดง &gt;5% ของตลาดรองรับ) ต้องปรับเทียบกับข้อมูลจริง</p>
      <div class="dg-grid">
        <div class="dg-stat"><small>สหกรณ์ที่ใช้ระบบ</small><b>${t.coops || 0}</b></div>
        <div class="dg-stat"><small>สมาชิก / โครีดนม</small><b>${n2(t.members)}</b> <small>/ ${n2(t.milking_cows)} ตัว</small></div>
        <div class="dg-stat"><small>น้ำนมจริงเฉลี่ย 30 วัน</small><b>${n2(t.milk_kg_day)}</b> <small>กก./วัน</small></div>
        <div class="dg-stat"><small>สัญญารับซื้อ (MOU)</small><b>${n2(t.contracted_kg_day)}</b> <small>กก./วัน</small></div>
        <div class="dg-stat"><small>สัญญาณ 30 วัน</small><b style="font-size:17px">${lvl(t.alert30)}</b></div>
        <div class="dg-stat"><small>ประกาศนมส่วนเกินที่เปิดอยู่</small><b>${n2(t.open_surplus_kg_day)}</b> <small>กก./วัน</small></div>
        <div class="dg-stat"><small>กำลังรับว่างของโรงงาน (30 วัน)</small><b>${n2(g.processor_capacity_30d.kg_per_day)}</b> <small>กก./วัน · ${g.processor_capacity_30d.processors} โรงงาน</small></div>
        <div class="dg-stat"><small>นมโรงเรียน 30 วัน: ส่ง / ยืนยันรับ</small><b>${n2(g.school_milk_30d.units)}</b> <small>/ ${n2(g.school_milk_30d.received_units)} หน่วย · มีปัญหา ${g.school_milk_30d.issues}</small></div>
      </div>
      <div class="dg-card"><h3>🔎 ตรวจสอบย้อนกลับล็อตน้ำนม</h3>
        <form id="traceForm" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end"><div><label class="dg-note" for="traceCode">รหัสล็อต (จากใบส่งนมหรือโรงงาน)</label><br>
          <input id="traceCode" placeholder="MB-261126-…" required style="padding:9px;border:1px solid var(--gray-300);border-radius:8px;font:inherit;min-width:240px"></div>
          <button class="btn btn-primary" style="width:auto">ดูเส้นทาง</button></form>
        <p class="dg-note">เฉพาะสหกรณ์ในขอบเขตของท่านที่ยินยอมแบ่งปันข้อมูล · แสดงเลขทะเบียนฟาร์มโดยไม่มีชื่อหรือรหัสสมาชิก</p></div>
      <div id="traceBox"></div>
      <div id="dqBox"></div>
      <div id="surplusBox"></div>
      <div id="quotaBox"></div>
      <div class="dg-card"><h3>รายจังหวัด (เรียงจากความเสี่ยง)</h3>
        ${table(["จังหวัด", "#สหกรณ์", "#โครีด", "#นมจริง (กก./วัน)", "#MOU", "#คาดการณ์ 30 วัน", "#รองรับ 30 วัน", "สัญญาณ 30 วัน", "สัญญาณ 90 วัน", "#ส่วนเกินที่ประกาศ"], g.provinces.map((p) => `<tr>
          <td>${esc(p.province_name_th)}</td><td class="num">${p.coops}</td><td class="num">${n2(p.milking_cows)}</td><td class="num">${n2(p.milk_kg_day)}</td><td class="num">${n2(p.contracted_kg_day)}</td>
          <td class="num">${n2(p.forecast30_kg_day)}</td><td class="num">${n2(p.committed30_kg_day)}</td><td>${lvl(p.alert30)}</td><td>${lvl(p.alert90)}</td><td class="num">${n2(p.open_surplus_kg_day)}</td></tr>`))}</div>
      <div class="dg-card"><h3>รายสหกรณ์ที่ยินยอมแบ่งปันข้อมูล</h3>
        ${table(["สหกรณ์", "จังหวัด", "#สมาชิก", "#โครีด", "#นม (กก./วัน)", "#MOU", "#ขายโรงงาน 30 วัน", "#ถูกปฏิเสธ 30 วัน", "คุณภาพเฉลี่ย", "30 วัน", "90 วัน"], g.cooperatives.map((c) => `<tr>
          <td>${esc(c.org_name)}</td><td>${esc(c.province_name_th)}</td><td class="num">${c.members}</td><td class="num">${c.milking_cows}</td><td class="num">${n2(c.milk_kg_day)}</td><td class="num">${n2(c.contracted_kg_day)}</td>
          <td class="num">${n2(c.sold_30d_kg)}</td><td class="num">${n2(c.rejected_30d_kg)}</td><td><small>F ${n2(c.avg_fat)} S ${n2(c.avg_snf)} SCC ${n2(c.avg_scc_k)}</small></td>
          <td>${fw(c, 30) ? lvl(fw(c, 30)) : "-"}</td><td>${fw(c, 90) ? lvl(fw(c, 90)) : "-"}</td></tr>`))}
        <p class="dg-note">อีก ${g.coops_not_sharing} สหกรณ์ยังไม่เปิดให้เห็นข้อมูลรายสหกรณ์ (รวมอยู่ในตัวเลขรายจังหวัดแล้ว) · ไม่แสดงราคาสัญญารายบริษัทและข้อมูลสมาชิกรายคน</p></div>`;
    loadSurplus();
    loadQuota();
    loadDataQuality();
    $("#traceForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const code = $("#traceCode").value.trim().toUpperCase();
      const box = $("#traceBox");
      API.get(`/dairy-gov/trace/${encodeURIComponent(code)}`).then((t) => window.AgroDairyTraceView.mount(box, t, "gov"))
        .catch((err) => {
          const e2 = (err.body && err.body.error) || err.message;
          box.innerHTML = `<div class="dg-card">${esc({ batch_not_found: "ไม่พบล็อตนี้ในขอบเขตของท่าน", coop_no_gov_consent: "สหกรณ์เจ้าของล็อตยังไม่ยินยอมแบ่งปันข้อมูลกับภาครัฐ" }[e2] || e2)}</div>`;
        });
    });
  }).catch((e) => { if (e.message !== "session_expired") $("#content").innerHTML = `<div class="dg-card">โหลดไม่สำเร็จ: ${esc(e.message)}</div>`; });

  // ---- คุณภาพข้อมูลและการตรวจสอบย้อนกลับรายสหกรณ์ (/dairy-gov/data-quality) ----
  function loadDataQuality() {
    API.get("/dairy-gov/data-quality").then((q) => {
      const box = $("#dqBox");
      if (!box || !q.coops.length) return;
      const pct = (v) => (v == null ? "-" : `${n2(v)}%`);
      box.innerHTML = `<div class="dg-card"><h3>✅ คุณภาพข้อมูลรายสหกรณ์ (30 วัน)</h3>
        ${table(["สหกรณ์", "จังหวัด", "#รายการรับนม", "#บันทึกอัตโนมัติ", "#จากไฟล์", "#เที่ยวส่ง", "#ตรวจย้อนกลับได้", "#ล็อตยอดไม่ตรง", "#รอบค้างไม่ปิด", "ล็อตล่าสุด"], q.coops.map((c) => `<tr>
          <td>${esc(c.org_name)}</td><td>${esc(c.province_name_th)}</td><td class="num">${n2(c.intakes)}</td><td class="num">${pct(c.automated_pct)}</td><td class="num">${n2(c.from_file)}</td>
          <td class="num">${n2(c.shipments)}</td><td class="num">${pct(c.traced_pct)}</td><td class="num">${c.mismatched || "-"}</td><td class="num">${c.open_old_rounds || "-"}</td>
          <td style="white-space:nowrap">${c.latest_batch ? `<a href="#" data-trace="${esc(c.latest_batch)}">${esc(c.latest_batch)}</a>` : "-"}</td></tr>`))}
        <p class="dg-note">บันทึกอัตโนมัติ = เครื่องชั่ง/Gateway/API · ตรวจย้อนกลับได้ = เที่ยวส่งที่ผูกกับล็อตน้ำนม (ฟาร์ม → รอบ → ถัง → รถ → โรงงาน) · ล็อตยอดไม่ตรง = ส่งออกต่างจากที่รวบรวมเกิน 3%</p></div>`;
      box.querySelectorAll("[data-trace]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); $("#traceCode").value = a.dataset.trace; $("#traceForm").requestSubmit(); }));
    }).catch(() => {});
  }

  // ---- กรณีนมเกินกำลังรับซื้อ (/dairy-gov/surplus, grant_dairy_surplus_cases.sql) ----
  const HZ = { today: "วันนี้", "7d": "7 วัน", "30d": "30 วันข้างหน้า", "60d": "60 วันข้างหน้า", "90d": "90 วันข้างหน้า" };
  const CST = { Open: "รอสหกรณ์ตัดสินใจ", Acting: "สหกรณ์กำลังแก้ไข", Escalated: "ขอความช่วยเหลือ" };
  const KIND = {
    buyer_extra: "ผู้ซื้อตามสัญญารับเพิ่ม", transfer_center: "ย้ายไปศูนย์อื่น", processor_match: "โรงงานที่ประกาศรับว่าง", directory_buyer: "ผู้รับซื้อในทะเบียน",
    own_plant: "แปรรูปเอง", herd_plan: "วางแผนฝูง", quota_holder: "ผู้ถือโควตานำเข้า (ตามมาตรการ)",
  };
  const dt = (v) => (v ? new Date(v).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "-");
  function loadSurplus() {
    API.get("/dairy-gov/surplus").then((s) => {
      const t = s.totals;
      const box = $("#surplusBox");
      if (!box) return;
      box.innerHTML = `<div class="dg-card"><h3>🚨 กรณีนมเกินกำลังรับซื้อ (จากระบบแนะนำของสหกรณ์)</h3>
        <div class="dg-grid">
          <div class="dg-stat"><small>กรณีที่เปิดอยู่ / วิกฤต</small><b>${t.active_cases || 0}</b> <small>/ ${t.red_cases || 0} กรณี · ${t.coops_affected || 0} สหกรณ์</small></div>
          <div class="dg-stat"><small>สหกรณ์ขอความช่วยเหลือ</small><b>${t.escalated_cases || 0}</b> <small>กรณี</small></div>
          <div class="dg-stat"><small>นมเกินตอนนี้ (วันนี้ + 7 วัน)</small><b>${n2(t.surplus_now_kg_day)}</b> <small>กก./วัน</small></div>
          <div class="dg-stat"><small>นมเกินที่คาดล่วงหน้า (30–90 วัน)</small><b>${n2(t.surplus_ahead_kg_day)}</b> <small>กก./วัน</small></div>
          <div class="dg-stat"><small>30 วัน: ระบายได้ / ต้องทิ้ง</small><b>${n2(t.handled_30d_kg)}</b> <small>/ ${n2(t.discarded_30d_kg)} กก.</small></div>
          <div class="dg-stat"><small>โรงงานประกาศรับว่าง 7 วัน</small><b>${n2(s.processor_capacity_7d.kg_per_day)}</b> <small>กก./วัน · ${s.processor_capacity_7d.processors} โรงงาน</small></div>
        </div>
        ${table(["จังหวัด", "#กรณีเปิด", "#วิกฤต", "#ขอช่วย", "#นมเกินตอนนี้ (กก./วัน)", "#ล่วงหน้า (กก./วัน)", "#ทิ้ง 30 วัน (กก.)"], s.provinces.map((p) => `<tr>
          <td>${esc(p.province_name_th)}</td><td class="num">${p.active_cases}</td><td class="num">${p.red_cases}</td><td class="num">${p.escalated_cases}</td>
          <td class="num">${n2(p.surplus_now_kg_day)}</td><td class="num">${n2(p.surplus_ahead_kg_day)}</td><td class="num">${n2(p.discarded_30d_kg)}</td></tr>`))}
        <h3 style="margin-top:16px">รายกรณี (สหกรณ์ที่ขอความช่วยเหลือหรือยินยอมแบ่งปันข้อมูล)</h3>
        ${table(["สหกรณ์", "จุด", "ช่วง", "ระดับ", "#นมเกิน (กก./วัน)", "สถานะ", "กำหนด", "สิ่งที่ขอ / ทางเลือกของสหกรณ์"], s.cases.map((k) => `<tr>
          <td>${esc(k.org_name)}<br><small>${esc(k.province_name_th)}</small></td><td>${k.scope === "center" ? "ศูนย์ " + esc(k.center_name || "") : "ทั้งสหกรณ์"}</td>
          <td>${HZ[k.horizon] || esc(k.horizon)}</td><td>${lvl({ level: k.alert_level, surplus_pct: k.surplus_pct == null ? null : Number(k.surplus_pct) })}</td>
          <td class="num">${n2(k.surplus_kg_day)}</td><td>${CST[k.status] || esc(k.status)}</td><td>${dt(k.deadline_at)}</td>
          <td>${k.escalation_note ? `<b>${esc(k.escalation_note)}</b><br>` : ""}<small>${(k.options || []).map((o) => `${esc(KIND[o.kind] || o.kind)}${o.target_name ? " " + esc(o.target_name) : ""} ${n2(o.kg_per_day)} กก.${o.status !== "Suggested" ? " (" + esc(o.status) + ")" : ""}`).join(" · ") || "-"}</small></td></tr>`))}
        <p class="dg-note">อีก ${s.cases_not_shared} กรณียังไม่ได้แชร์รายละเอียด (รวมอยู่ในตัวเลขรายจังหวัดแล้ว) · ไม่แสดงราคาที่ตกลงกับโรงงานและข้อมูลสมาชิก</p></div>`;
    }).catch(() => { /* ยังไม่ได้ติดตั้ง grant_dairy_surplus_cases.sql — ไม่แสดงส่วนนี้ */ });
  }

  // ---- โควตานำเข้านม × นมล้น (/dairy-gov/import-quota, grant_dairy_import_quota.sql) ----
  const AGR = { WTO: "WTO", TAFTA: "TAFTA", TNZCEP: "TNZCEP", TAFTA_TNZCEP: "TAFTA/TNZCEP", AFTA: "AFTA", ALL: "รวมทุกความตกลง" };
  const TST = { Planned: "รอเปิด", Open: "เปิดแล้ว", DeferProposed: "เสนอชะลอ", Deferred: "ชะลอแล้ว", Closed: "ปิด" };
  const BASIS = { measure: "ปริมาณตามมาตรการที่มีผลอยู่", detected_now: "นมเกินที่ระบบตรวจพบตอนนี้", detected_ahead: "นมเกินที่คาดล่วงหน้า (สูงสุด)" };
  const ton = (kg) => n2(Number(kg) / 1000);
  const dd = (v) => (v ? new Date(`${v}T00:00:00`).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" }) : "-");
  function loadQuota(year) {
    API.get(`/dairy-gov/import-quota${year ? `?year=${year}` : ""}`).then((q) => {
      const box = $("#quotaBox");
      if (!box) return;
      const p = q.platform;
      const opt = (k) => q.options.find((o) => o.kind === k);
      const ab = opt("absorb_by_quota_holders");
      const df = opt("defer_import");
      const pw = opt("domestic_powder");
      const scopeNote = q.officer.scope_type === "Province" ? `นมเกินเฉพาะจังหวัด ${esc(q.officer.province_name_th || q.officer.province_code)} — โควตาเป็นระดับประเทศ` : "ทั้งประเทศ (สหกรณ์ที่ใช้ระบบ)";
      box.innerHTML = `<div class="dg-card"><h3>📦 โควตานำเข้าสินค้านม × สถานการณ์นมล้น — ปี ${q.quota_year}
          ${q.years.length > 1 ? `<select id="quotaYear" style="margin-left:8px">${q.years.map((y) => `<option ${y === q.quota_year ? "selected" : ""}>${y}</option>`).join("")}</select>` : ""}</h3>
        <div class="dg-grid">
          <div class="dg-stat"><small>นำเข้าทั้งปี (สุทธิหลังชะลอ) เทียบน้ำนมดิบ</small><b>${ton(q.year_raw_milk_kg)}</b> <small>ตัน · ≈ ${n2(q.year_raw_milk_kg_day)} กก./วัน</small></div>
          <div class="dg-stat"><small>น้ำนมที่สหกรณ์ในระบบรับจริง (เฉลี่ย 30 วัน)</small><b>${n2(p.milk_kg_day)}</b> <small>กก./วัน · เฉพาะสหกรณ์ที่ใช้ระบบ</small></div>
          <div class="dg-stat"><small>นมเกินที่ระบบตรวจพบ ตอนนี้ / ล่วงหน้า</small><b>${n2(p.surplus_now_kg_day)}</b> <small>/ ${n2(p.surplus_ahead_kg_day)} กก./วัน · ${p.coops_in_surplus} สหกรณ์</small></div>
          <div class="dg-stat"><small>ฐานคำนวณทางเลือก</small><b>${n2(q.basis_kg_day)}</b> <small>กก./วัน · ${esc(BASIS[q.basis])}</small></div>
        </div>
        <p class="dg-note">ขอบเขตนมเกิน: ${scopeNote} · ค่าแปลงเป็นน้ำนมดิบ: ${q.products.map((x) => `${esc(x.name_th)} ×${Number(x.raw_milk_factor)}`).join(", ")} (ค่าตั้งต้นเพื่อการวางแผน)</p>
        ${table(["สินค้า", "ความตกลง", "กลุ่ม", "งวด", "#ปริมาณ (ตัน)", "#ชะลอแล้ว (ตัน)", "#เทียบน้ำนมดิบ (ตัน)", "ลงระบบ", "สถานะ"], q.tranches.map((t) => `<tr>
          <td>${esc(t.name_th)}</td><td>${esc(AGR[t.agreement] || t.agreement)}</td><td>${t.entity_group ? `นิติบุคคล ${t.entity_group}` : "-"}</td><td>${t.tranche_no}</td>
          <td class="num">${n2(t.quantity_t)}</td><td class="num">${t.deferred_t ? n2(t.deferred_t) : "-"}</td><td class="num">${ton(t.raw_milk_kg)}</td>
          <td>${dd(t.opens_on)}${t.days_to_open > 0 ? `<br><small>อีก ${t.days_to_open} วัน</small>` : ""}</td><td>${esc(TST[t.status] || t.status)}</td></tr>`))}
        ${q.active_measure ? `<p style="margin:14px 0 4px"><b>มาตรการที่มีผล:</b> ${esc(q.active_measure.title)} — ${n2(q.active_measure.total_kg_day)} กก./วัน ${q.active_measure.days} วัน
          (${dd(q.active_measure.start_date)} – ${dd(q.active_measure.end_date)}) · สหกรณ์ตกลงส่งให้ผู้ถือโควตาแล้ว ${n2(q.progress.approved_kg_day)} กก./วัน · ส่งจริง ${n2(q.progress.delivered_kg)} กก.</p>` : ""}
        ${q.options.length ? `<h3 style="margin-top:16px">ทางเลือกเชิงนโยบายที่ใช้โควตานำเข้าเป็นปัจจัย</h3>
          ${ab ? `<div style="border:1px solid var(--gray-100);border-radius:10px;padding:12px;margin-bottom:10px"><b>1. ${esc(ab.title_th)}</b> — ${n2(ab.kg_per_day)} กก./วัน × ${ab.days} วัน
            <div class="dg-note">${ab.groups.map((g) => `กลุ่มนิติบุคคลที่ ${g.entity_group}: ${g.pct}% = ${n2(g.kg_per_day)} กก./วัน (${g.holders} ราย, โควตา ${n2(g.quota_t)} ตัน)`).join(" · ")}</div>
            ${ab.holders.length ? table(["ผู้ถือโควตา", "กลุ่ม", "#โควตา (ตัน)", "#สัดส่วนในกลุ่ม", "#ต้องรับ (กก./วัน)", "อยู่ในระบบ", "#สหกรณ์ตกลงส่ง (กก./วัน)", "#ส่งจริง (กก.)"], ab.holders.map((h) => `<tr>
              <td>${esc(h.holder_name)}</td><td>${h.entity_group}</td><td class="num">${n2(h.quantity_t)}</td><td class="num">${n2(h.share_pct_in_group)}%</td><td class="num"><b>${n2(h.kg_per_day)}</b></td>
              <td>${h.on_platform ? "✅ เป็นทางเลือกให้สหกรณ์อัตโนมัติ" : "—"}</td><td class="num">${h.approved_kg_day == null ? "-" : n2(h.approved_kg_day)}</td><td class="num">${h.delivered_kg == null ? "-" : n2(h.delivered_kg)}</td></tr>`)) : ""}
            <div class="dg-note">${ab.notes.map(esc).join(" · ")}</div></div>` : ""}
          ${df ? `<div style="border:1px solid var(--gray-100);border-radius:10px;padding:12px;margin-bottom:10px"><b>2. ${esc(df.title_th)}</b>
            — ควรชะลอ <b>${n2(df.propose_t)} ตัน</b> = น้ำนมดิบ ${ton(df.raw_milk_kg)} ตัน รองรับนมเกินได้ ${n2(df.covers_days)} วัน
            ${df.decide_by ? `<div class="dg-note" style="color:${df.days_to_decide <= 30 ? "#a1261d" : "inherit"};font-weight:600">ต้องมีมติภายใน ${dd(df.decide_by)} (อีก ${df.days_to_decide} วัน)</div>` : '<div class="dg-note" style="color:#a1261d">ไม่มีงวดนมผงที่ยังทันออกมติ</div>'}
            ${table(["งวดนมผงที่ยังไม่เปิด", "ลงระบบ", "ต้องมีมติภายใน", "#คงเหลือ (ตัน)", "#เสนอชะลอ (ตัน)", "หมายเหตุ"], df.candidates.map((c) => `<tr${c.defer_t > 0 ? ' style="background:#f4faf5"' : ""}>
              <td>${esc(c.label)}</td><td>${dd(c.opens_on)}</td><td>${dd(c.decide_by)}</td><td class="num">${n2(c.remaining_t)}</td><td class="num">${c.defer_t > 0 ? `<b>${n2(c.defer_t)}</b>` : "-"}</td>
              <td><small>${c.decidable ? (c.defer_t > 0 ? "✅ แนะนำ" : "ทางเลือกสำรอง") : `ไม่ทันออกมติ (เหลือ ${Math.max(0, c.days_to_decide)} วัน)`}${c.status === "DeferProposed" ? " · อยู่ระหว่างเสนอชะลอ" : ""}</small></td></tr>`))}
            <div class="dg-note">${df.notes.map(esc).join(" · ")}</div></div>` : ""}
          ${pw ? `<div style="border:1px solid var(--gray-100);border-radius:10px;padding:12px;margin-bottom:10px"><b>${df ? 3 : 2}. ${esc(pw.title_th)}</b>
            — น้ำนมดิบ ${ton(pw.raw_milk_kg)} ตัน → นมผงประมาณ <b>${n2(pw.powder_t)} ตัน</b>${pw.substitutes_pct != null ? ` (${n2(pw.substitutes_pct)}% ของโควตานมผงที่ยังไม่นำเข้า ${n2(pw.not_yet_imported_t)} ตัน)` : ""}
            <div class="dg-note">${pw.notes.map(esc).join(" · ")}</div></div>` : ""}`
          : '<p class="dg-note">ยังไม่มีนมเกินที่ต้องใช้ทางเลือกด้านโควตา</p>'}
        <p class="dg-note">ระบบคำนวณเพื่อประกอบการพิจารณาเท่านั้น — การจัดสรรและการชะลอนำเข้าเป็นอำนาจของคณะกรรมการโคนมและผลิตภัณฑ์นม · ข้อมูลโควตาบันทึกโดยผู้ดูแลระบบตามมติ (ตรวจกับประกาศทางการ) · ไม่แสดงราคา</p></div>`;
      const ys = $("#quotaYear");
      if (ys) ys.onchange = () => loadQuota(ys.value);
    }).catch(() => { /* ยังไม่ได้ติดตั้ง grant_dairy_import_quota.sql — ไม่แสดงส่วนนี้ */ });
  }
})();
