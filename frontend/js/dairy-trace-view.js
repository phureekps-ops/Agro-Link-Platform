/**
 * AgroLink โคนม — หน้าตรวจสอบย้อนกลับล็อตน้ำนม (ใช้ร่วมกัน: สหกรณ์ / โรงงานคู่ค้า / เจ้าหน้าที่รัฐ)
 * window.AgroDairyTraceView.render(trace, view) → HTML; view = "coop" | "partner" | "gov"
 * ข้อมูลมาจาก backend/src/lib/dairyTrace.js (ฝั่งเซิร์ฟเวอร์ตัดชื่อ/รหัสสมาชิกออกตาม view แล้ว)
 */
(function () {
  "use strict";
  const CSS = `
  .dtv-card { background: #fff; border-radius: var(--radius, 12px); box-shadow: var(--shadow, 0 2px 8px rgba(0,0,0,.06)); padding: 18px; margin-bottom: 16px; }
  .dtv-card h3 { margin: 0 0 12px; font-size: 15.5px; color: var(--green-900, #123); }
  .dtv-card h4 { margin: 14px 0 6px; font-size: 14px; color: var(--green-900, #123); }
  .dtv-note { font-size: 12.5px; color: var(--gray-500, #667); margin: 4px 0 0; }
  .dtv-pill { display: inline-block; border-radius: 20px; padding: 2px 9px; font-size: 11.5px; font-weight: 700; background: var(--gray-100, #eee); color: var(--gray-700, #444); white-space: nowrap; }
  .dtv-pill.ok { background: var(--green-100, #e3f4e8); color: var(--green-700, #1d6b3a); }
  .dtv-pill.warn { background: var(--gold-100, #fff3d6); color: #8a5a00; }
  .dtv-pill.bad { background: var(--red-100, #fde4e4); color: var(--red-600, #c0392b); }
  .dtv-flow { display: grid; grid-template-columns: repeat(5, 1fr); margin: 10px 0 6px; }
  .dtv-flow > div { position: relative; background: var(--gray-50, #f7f8f9); border: 1px solid var(--gray-300, #ccd); border-radius: 10px; padding: 10px 12px; margin-right: 22px; font-size: 12.5px; color: var(--gray-500, #667); }
  .dtv-flow > div:not(:last-child)::after { content: "→"; position: absolute; right: -18px; top: 50%; transform: translateY(-50%); color: var(--gray-500, #667); font-size: 16px; }
  .dtv-flow > div:last-child { margin-right: 0; }
  .dtv-flow b { display: block; font-size: 16px; color: var(--green-900, #123); margin: 2px 0; }
  .dtv-flow .ok { border-color: #2e9e5b; } .dtv-flow .warning { border-color: #ee8a22; background: #fff8ec; } .dtv-flow .critical { border-color: #d64040; background: #fdf0f0; }
  .dtv-chk { display: flex; gap: 8px; align-items: baseline; padding: 6px 0; border-bottom: 1px solid var(--gray-100, #eee); font-size: 13.5px; }
  .dtv-scroll { overflow-x: auto; }
  .dtv-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  .dtv-table th { text-align: left; font-size: 12px; color: var(--gray-500, #667); font-weight: 600; padding: 8px; border-bottom: 1px solid var(--gray-300, #ccd); white-space: nowrap; }
  .dtv-table td { padding: 8px; border-bottom: 1px solid var(--gray-100, #eee); vertical-align: top; }
  .dtv-table .num { text-align: right; }
  .dtv-spark { display: block; width: 100%; height: 70px; }
  .dtv-btn { border: 0; border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; background: var(--gray-100, #eee); color: var(--gray-900, #111); }
  @media (max-width: 860px) { .dtv-flow { grid-template-columns: 1fr; } .dtv-flow > div { margin: 0 0 20px; } .dtv-flow > div:not(:last-child)::after { content: "↓"; right: auto; left: 50%; top: auto; bottom: -19px; transform: none; } }
  @media print { .dtv-noprint, header, nav, aside, .mh-side, .mh-noprint { display: none !important; } .dtv-card { box-shadow: none; border: 1px solid #ddd; break-inside: avoid; } }`;
  if (!document.getElementById("dtv-css")) {
    const st = document.createElement("style");
    st.id = "dtv-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const n2 = (v) => (v == null || v === "" ? "-" : Number(v).toLocaleString("th-TH", { maximumFractionDigits: 2 }));
  const d = (v) => (v ? new Date(String(v).length === 10 ? v + "T00:00:00" : v).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" }) : "-");
  const dt = (v) => (v ? new Date(v).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "-");
  const pill = (t, c) => `<span class="dtv-pill ${c || ""}">${esc(t)}</span>`;
  const table = (heads, rows) => (rows.length
    ? `<div class="dtv-scroll"><table class="dtv-table"><thead><tr>${heads.map((h) => `<th${h[0] === "#" ? ' class="num"' : ""}>${esc(h.replace(/^#/, ""))}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : '<div class="dtv-note">ไม่มีข้อมูล</div>');
  const shiftTh = (s) => (s === "AM" ? "เช้า" : s === "PM" ? "เย็น" : "-");
  const SOURCE = { manual: "บันทึกมือ", scale: "เครื่องชั่ง", gateway: "Gateway", file: "ไฟล์", api: "API" };
  const REJ = { antibiotic: "ยาปฏิชีวนะ", temperature: "อุณหภูมิ", smell: "กลิ่นผิดปกติ", clot: "จับตัว/ตะกอน", other: "อื่น ๆ" };
  const STATUS = { Collecting: ["กำลังรวบรวมในถัง", "warn"], Shipped: ["ส่งแล้ว รอโรงงาน", "warn"], Received: ["โรงงานรับแล้ว", "ok"], Rejected: ["โรงงานปฏิเสธ", "bad"] };
  const status = (s) => pill(...(STATUS[s] || [s, ""]));
  const sgn = (v) => `${v > 0 ? "+" : ""}${n2(v)}`;
  const CHECK = {
    sent_vs_collected: (c) => `ส่งออก ${n2(c.sent_kg)} กก. เทียบกับที่รวบรวมจากฟาร์ม ${n2(c.collected_kg)} กก. (${sgn(c.diff_pct)}%)`,
    received_vs_sent: (c) => `โรงงานรับ ${n2(c.received_kg)} กก. จากที่ส่ง ${n2(c.sent_kg)} กก. (${sgn(c.diff_pct)}%)`,
    factory_rejected: (c) => `โรงงานปฏิเสธล็อตนี้: ${esc(c.reason || "")}`,
    truck_temp_high: (c) => `อุณหภูมิถังรถ ${n2(c.value)}°C เกินเกณฑ์ ${n2(c.max)}°C`,
    round_tank_temp_high: (c) => `${c.rounds} รอบ อุณหภูมิถังตอนปิดรอบเกิน ${n2(c.max)}°C`,
    no_tank_temperature: (c) => `ไม่มีข้อมูลอุณหภูมิถังเย็น (${c.rounds} รอบไม่ได้บันทึก และศูนย์ไม่มีเซนเซอร์)`,
    tank_sensor_over_limit: (c) => `เซนเซอร์ถังเย็นวัดได้เกิน ${n2(c.max)}°C จำนวน ${c.readings} ครั้ง`,
    farm_antibiotic_positive: (c) => `${c.farms} ฟาร์ม ผลตรวจล่าสุดพบยาปฏิชีวนะ`,
    farm_recent_withdrawal: (c) => `${c.farms} ฟาร์ม มีโคอยู่ในระยะหยุดยาช่วงนี้`,
    farm_without_quality_test: (c) => `${c.farms} ฟาร์ม ยังไม่มีผลตรวจคุณภาพ`,
    over_tank_capacity: (c) => `ปริมาณ ${n2(c.kg)} กก. เกินความจุถัง ${n2(c.capacity)} กก.`,
  };
  const ICON = { ok: "✅", info: "ℹ️", warning: "⚠️", critical: "⛔" };
  const EV = { round_closed: "ปิดรอบรับนม", shipped: "รถออกจากศูนย์", factory_received: "โรงงานรับ", factory_rejected: "โรงงานปฏิเสธ" };

  function spark(series, max) {
    if (!series || !series.length) return "";
    const W = 600; const H = 70;
    const v = series.map((p) => Number(p.c));
    const lo = Math.min(...v, max - 1); const hi = Math.max(...v, max + 0.5); const sp = hi - lo || 1;
    const y = (c) => (H - 6 - ((c - lo) / sp) * (H - 12)).toFixed(1);
    const pts = v.map((c, i) => `${((i / Math.max(1, v.length - 1)) * W).toFixed(1)},${y(c)}`).join(" ");
    return `<svg class="dtv-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="อุณหภูมิถังเย็นรายชั่วโมง เทียบเกณฑ์ ${max} องศา">
      <line x1="0" x2="${W}" y1="${y(max)}" y2="${y(max)}" stroke="#d64040" stroke-dasharray="6 4" stroke-width="1"/>
      <polyline fill="none" stroke="#1f6fb2" stroke-width="2" points="${pts}"/></svg>`;
  }

  function render(t, view) {
    const b = t.batch;
    const s = t.shipment;
    const lvlOf = (codes) => {
      const hit = t.checks.filter((c) => codes.includes(c.code));
      return hit.some((c) => c.level === "critical") ? "critical" : hit.some((c) => c.level === "warning") ? "warning" : "ok";
    };
    const farmsKg = t.farms.reduce((a, f) => a + f.accepted_kg, 0);
    const tankTxt = t.tank.filter((x) => x.readings).map((x) => `${n2(x.min_c)}–${n2(x.max_c)}°C`).join(", ");
    const shippedAt = b.shipped_at ? new Date(b.shipped_at).getTime() : null;
    const isLate = (r) => shippedAt && r.closed_at && new Date(r.closed_at).getTime() > shippedAt;
    const late = t.rounds.filter(isLate).length;
    const range = `${d(b.first_round_date)}${b.last_round_date && b.last_round_date !== b.first_round_date ? " – " + d(b.last_round_date) : ""}`;
    const flow = `<div class="dtv-flow" role="list" aria-label="เส้นทางน้ำนม">
      <div role="listitem" class="${lvlOf(["farm_antibiotic_positive", "farm_recent_withdrawal"])}">ฟาร์ม<b>${b.farm_count} ราย</b>${n2(farmsKg)} กก.</div>
      <div role="listitem" class="${lvlOf(["round_tank_temp_high"])}">รอบรับนม<b>${b.rounds} รอบ</b>${range}</div>
      <div role="listitem" class="${lvlOf(["tank_sensor_over_limit", "over_tank_capacity"])}">ถังเย็น${t.center ? " " + esc(t.center.name) : ""}<b>${n2(b.accepted_kg)} กก.</b>${tankTxt || "ไม่มีเซนเซอร์"}</div>
      <div role="listitem" class="${s ? lvlOf(["sent_vs_collected", "truck_temp_high"]) : ""}">เที่ยวรถ<b>${s ? `${n2(s.sent_kg)} กก.` : "ยังไม่ส่ง"}</b>${s ? `${d(s.ship_date)} ${esc(s.vehicle || "")}${s.tank_temp_c != null ? ` · ${n2(s.tank_temp_c)}°C` : ""}` : ""}</div>
      <div role="listitem" class="${s ? lvlOf(["received_vs_sent", "factory_rejected"]) : ""}">โรงงาน<b>${s ? (s.status === "Received" ? `${n2(s.received_kg)} กก.` : s.status === "Rejected" ? "ปฏิเสธ" : "รอรับ") : "-"}</b>${s ? esc(s.partner_name || "") : ""}</div></div>`;
    const checks = [
      ...t.checks.map((c) => `<div class="dtv-chk"><span aria-hidden="true">${ICON[c.level] || ""}</span><span>${CHECK[c.code] ? CHECK[c.code](c) : esc(c.code)}</span></div>`),
      late ? `<div class="dtv-chk"><span aria-hidden="true">ℹ️</span><span>${late} รอบบันทึกหลังรถออกจากศูนย์ (ข้อมูลย้อนหลัง)</span></div>` : "",
    ].join("");
    const named = view === "coop";
    const coded = view !== "gov";
    const farms = table([...(coded ? ["รหัส"] : []), ...(named ? ["สมาชิก"] : []), "ทะเบียนฟาร์ม", "#รับ (กก.)", "#ไม่รับ (กก.)", "#ครั้ง", "ที่มา", "ผลตรวจล่าสุด", "หมายเหตุ"],
      t.farms.map((f) => `<tr>${coded ? `<td>${esc(f.member_code)}</td>` : ""}${named ? `<td>${esc(f.full_name)}</td>` : ""}<td>${esc(f.farm_registration_no || "-")}</td>
        <td class="num">${n2(f.accepted_kg)}</td><td class="num">${f.rejected_kg ? n2(f.rejected_kg) : "-"}</td><td class="num">${f.deliveries}</td>
        <td><small>${f.sources.map((x) => SOURCE[x] || x).join(", ")}</small></td>
        <td>${f.quality ? `<small>${d(f.quality.sample_date)} · F ${n2(f.quality.fat_pct)} S ${n2(f.quality.snf_pct)} SCC ${n2(f.quality.scc_k)}</small>${f.quality.antibiotic_pos ? " " + pill("ยาตกค้าง", "bad") : ""}` : pill("ไม่มีผล", "warn")}</td>
        <td>${f.reject_reasons.length ? `<small>ไม่รับ: ${f.reject_reasons.map((x) => REJ[x] || x).join(", ")}</small> ` : ""}${f.recent_withdrawal_cows ? pill("โคระยะหยุดยา", "warn") : ""}</td></tr>`));
    const rounds = table(["วันที่", "รอบ", "#รับ (กก.)", "#ไม่รับ", "#ถังตอนปิด", "ปิดเมื่อ", ""], t.rounds.map((r) => `<tr><td>${d(r.round_date)}</td><td>${shiftTh(r.shift)}</td>
      <td class="num">${n2(r.accepted_kg)}</td><td class="num">${n2(r.rejected_kg)}</td><td class="num">${r.tank_temp_c == null ? "-" : n2(r.tank_temp_c) + "°C"}</td><td>${dt(r.closed_at)}</td>
      <td>${isLate(r) ? pill("บันทึกหลังส่ง", "warn") : ""}</td></tr>`));
    const tank = t.tank.length ? t.tank.map((x) => `<div style="margin-bottom:12px"><b>${esc(x.name)}</b>
        <small>${x.readings ? ` ${x.readings} ค่า · ต่ำสุด ${n2(x.min_c)} สูงสุด ${n2(x.max_c)} เฉลี่ย ${n2(x.avg_c)}°C · เกินเกณฑ์ ${x.over_limit} ครั้ง` : " ไม่มีข้อมูลช่วงนี้"}</small>
        ${spark(x.series, Number(x.limit_c != null ? x.limit_c : t.tank_temp_max))}${x.series && x.series.length ? `<small class="dtv-note">ค่าสูงสุดรายชั่วโมง · เส้นประสีแดง = เกณฑ์ของถัง ${n2(x.limit_c != null ? x.limit_c : t.tank_temp_max)}°C</small>` : ""}</div>`).join("")
      : '<div class="dtv-note">ศูนย์นี้ยังไม่มีเซนเซอร์ถังเย็น</div>';
    const timeline = t.timeline.map((e) => `<div class="dtv-chk"><span style="min-width:120px">${dt(e.at)}</span><span><b>${EV[e.event] || esc(e.event)}</b> ${e.round_date ? `${d(e.round_date)} ${shiftTh(e.shift)}` : esc(e.label || "")}${e.kg != null ? ` · ${n2(e.kg)} กก.` : ""}</span></div>`).join("");
    return `<div class="dtv-card"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
        <h3 style="margin:0">ล็อตน้ำนม ${esc(b.batch_code)} ${status(b.status)}</h3>
        <div class="dtv-noprint" style="display:flex;gap:6px"><button type="button" class="dtv-btn" data-dtv="print">🖨 พิมพ์</button><button type="button" class="dtv-btn" data-dtv="close">ปิด</button></div></div>
      <p class="dtv-note">${esc(t.coop_name || "")}${t.center ? " · " + esc(t.center.name) : ""}${s && s.contract_no ? ` · สัญญา ${esc(s.contract_no)}` : ""}${s && s.is_surplus ? " · ตลาดนมส่วนเกิน" : ""}</p>
      ${flow}
      <h4>จุดตรวจ</h4>${checks || '<div class="dtv-note">-</div>'}</div>
    <div class="dtv-card"><h3>ฟาร์มที่ส่งนมเข้าล็อตนี้ (${t.farms.length})</h3>${farms}
      ${view === "partner" ? '<p class="dtv-note">แสดงรหัสสมาชิกและเลขทะเบียนฟาร์มสำหรับการเรียกคืนสินค้า โดยไม่แสดงชื่อบุคคล</p>' : ""}
      ${view === "gov" ? '<p class="dtv-note">แสดงเฉพาะเลขทะเบียนฟาร์ม (ทะเบียนของกรมปศุสัตว์) ไม่แสดงชื่อหรือรหัสสมาชิก</p>' : ""}</div>
    <div class="dtv-card"><h3>รอบรับนม</h3>${rounds}</div>
    <div class="dtv-card"><h3>อุณหภูมิถังเย็นระหว่างเก็บนมล็อตนี้</h3>${tank}</div>
    <div class="dtv-card"><h3>ลำดับเหตุการณ์</h3>${timeline || '<div class="dtv-note">-</div>'}</div>`;
  }

  /** แสดงผลใน container และผูกปุ่มพิมพ์/ปิด */
  function mount(el, t, view, onClose) {
    el.innerHTML = render(t, view);
    el.querySelectorAll("[data-dtv]").forEach((btn) => btn.addEventListener("click", () => {
      if (btn.dataset.dtv === "print") window.print();
      else { el.innerHTML = ""; if (onClose) onClose(); }
    }));
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  window.AgroDairyTraceView = { render, mount, status };
})();
