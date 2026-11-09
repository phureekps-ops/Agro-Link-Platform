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
      <p class="dg-note">ข้อมูล ณ ${esc(g.as_of)} จากสหกรณ์ที่ใช้พอร์ทัลสหกรณ์โคนมของ AgroLink — ไม่ใช่สถิติทางการทั้งประเทศ เกณฑ์สีเป็นข้อเสนอเพื่อออกแบบระบบ (เหลือง &gt;1% ส้ม &gt;3% แดง &gt;5% ของตลาดรองรับ) ต้องปรับเทียบกับข้อมูลจริง</p>
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
  }).catch((e) => { if (e.message !== "session_expired") $("#content").innerHTML = `<div class="dg-card">โหลดไม่สำเร็จ: ${esc(e.message)}</div>`; });
})();
