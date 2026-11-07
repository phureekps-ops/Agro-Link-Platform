/**
 * พอร์ทัลคู่ค้าเห็ดฟาง — backend/src/routes/mushroompartner.js.
 * Own session key (agrolink_mushroom_partner_session) so it never collides
 * with the same organization's other portal sessions in this browser.
 */
(function () {
  "use strict";
  const API_BASE = ["localhost", "127.0.0.1"].includes(window.location.hostname) ? "http://localhost:4000" : "https://agrolink-backend-vhv6.onrender.com";
  const KEY = "agrolink_mushroom_partner_session";
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const n2 = (v) => (v == null ? "-" : Number(v).toLocaleString("th-TH", { maximumFractionDigits: 2 }));
  const baht = (v) => Number(v || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const d = (v) => (v ? new Date(v).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" }) : "-");
  const PROD = { fresh: "เห็ดสด", blanched_frozen: "ลวกแช่แข็ง", soy_pickled: "ดองซีอิ๊ว", canned: "บรรจุกระป๋อง" };
  const PT = { biomass_seller: "ผู้ขายเศษวัสดุชีวมวล", spawn_seller: "ผู้ขายเชื้อเห็ดฟาง", buyer: "ผู้ซื้อ", transporter: "ผู้ขนส่ง" };
  const ST = { Ordered: "รอยืนยัน", Confirmed: "ยืนยันแล้ว", Delivered: "ส่งมอบแล้ว", Cancelled: "ยกเลิก", Requested: "รอสหกรณ์ยืนยัน", Paid: "ชำระแล้ว", Planned: "วางแผน", InProgress: "กำลังวิ่ง", Done: "เสร็จ", Pending: "รอ", Skipped: "ข้าม" };
  const pill = (s) => `<span class="mp-pill ${["Delivered", "Paid", "Done", "Confirmed"].includes(s) ? "ok" : "warn"}">${ST[s] || s}</span>`;
  const table = (heads, rows) => (rows.length ? `<div class="mp-scroll"><table class="mp-table"><thead><tr>${heads.map((h) => `<th${h[0] === "#" ? ' class="num"' : ""}>${h.replace(/^#/, "")}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` : '<div class="mp-empty">ยังไม่มีข้อมูล</div>');

  const session = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } };
  async function req(path, opts = {}) {
    const s = session();
    const res = await fetch(API_BASE + path, Object.assign({}, opts, { headers: Object.assign({ "Content-Type": "application/json" }, s ? { Authorization: `Bearer ${s.access_token}` } : {}) }));
    const body = await res.json().catch(() => null);
    if (res.status === 401 || (res.status === 403 && body && body.error === "organization_subject_required")) { localStorage.removeItem(KEY); location.reload(); throw new Error("session"); }
    if (!res.ok) throw Object.assign(new Error((body && body.error) || "request_failed"), { body });
    return body;
  }
  const get = (p) => req(p);
  const post = (p, b) => req(p, { method: "POST", body: JSON.stringify(b || {}) });
  function msg(t, err) { const m = $("#msg"); m.textContent = t; m.className = "mp-msg " + (err ? "err" : "ok"); window.scrollTo(0, 0); }

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const box = $("#errorBox");
    box.classList.remove("show");
    try {
      const res = await fetch(API_BASE + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ external_subject_claim: $("#claimInput").value.trim() }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      if (body.subject_type && body.subject_type !== "organization") throw new Error("ต้องเป็นบัญชีองค์กร");
      localStorage.setItem(KEY, JSON.stringify(body));
      start();
    } catch (err) { box.textContent = "เข้าสู่ระบบไม่สำเร็จ: " + err.message; box.classList.add("show"); }
  });
  $("#logoutBtn").addEventListener("click", () => { localStorage.removeItem(KEY); location.reload(); });

  async function render() {
    const links = await get("/mushroom-partner/links");
    const types = new Set(links.map((l) => l.partner_type));
    get("/auth/session/current").then((me) => { $("#whoName").textContent = me.display_name || ""; }).catch(() => {});
    if (!links.length) { $("#content").innerHTML = '<div class="mp-card">บัญชีนี้ยังไม่ถูกผูกเป็นคู่ค้าของสหกรณ์ใด — ติดต่อสหกรณ์ให้เพิ่มองค์กรของท่านในหน้า "คู่ค้า" ของโปรแกรมเห็ดฟาง</div>'; return; }
    let html = `<div class="mp-card"><h3>สหกรณ์ที่เป็นคู่ค้า</h3>${links.map((l) => `<span class="mp-pill ok">${esc(l.coop_name)} — ${PT[l.partner_type]}</span>`).join(" ")}</div>`;
    if (types.has("spawn_seller") || types.has("biomass_seller")) {
      const pos = await get("/mushroom-partner/purchase-orders");
      html += `<div class="mp-card"><h3>ใบสั่งซื้อจากสหกรณ์</h3>${table(["วันที่", "สหกรณ์", "รายการ", "#ยอด", "#ค่าบริการ AgroLink (ผู้ขายจ่าย)", "สถานะ", ""], pos.map((p) => `<tr>
        <td>${d(p.ordered_at)}<br><small>ต้องการ ${d(p.expected_date)}</small></td><td>${esc(p.coop_name)}</td>
        <td>${p.lines.map((l) => `${esc(l.item_name)} ${n2(l.qty)} ${esc(l.unit)} × ${baht(l.unit_price)}${l.spawn_lot_no ? ` <small>ล็อต ${esc(l.spawn_lot_no)}</small>` : ""}`).join("<br>")}</td>
        <td class="num">${baht(p.total_amount)}</td><td class="num">${p.status === "Delivered" ? `${baht(p.fee_amount)} (${n2(p.fee_rate_pct)}%)` : "-"}</td><td>${pill(p.status)}${p.paid_at ? ' <span class="mp-pill ok">สหกรณ์จ่ายแล้ว</span>' : ""}</td>
        <td>${p.status === "Ordered" ? `<form class="mp-form" data-po="${p.po_id}" data-type="${p.po_type}">${p.po_type === "spawn" ? p.lines.map((l) => `<div><label>เลขล็อต ${esc(l.item_name)}</label><input data-line="${l.line_id}" required></div><div><label>วันผลิต</label><input type="date" data-prod="${l.line_id}"></div>`).join("") : ""}
          <div><label>ส่งได้วันที่</label><input type="date" name="expected_date"></div><div><button class="mp-btn">ยืนยันใบสั่งซื้อ</button></div></form>` : ""}</td></tr>`))}</div>`;
      if (types.has("spawn_seller")) {
        const perf = await get("/mushroom-partner/spawn-performance");
        html += `<div class="mp-card"><h3>ผลผลิตจากเชื้อของท่าน (ข้อมูลรวม)</h3>${table(["ล็อต", "วันผลิต", "สหกรณ์", "#รุ่น", "#กล่อง", "#เห็ด (กก.)", "#กก./กล่อง"], perf.map((p) => `<tr>
          <td>${esc(p.lot_no)}</td><td>${d(p.produced_on)}</td><td>${esc(p.coop_name)}</td><td class="num">${p.batches}</td><td class="num">${p.boxes}</td><td class="num">${n2(p.harvest_kg)}</td><td class="num">${n2(p.kg_per_box)}</td></tr>`))}</div>`;
      }
    }
    if (types.has("buyer")) {
      const buyerLinks = links.filter((l) => l.partner_type === "buyer");
      const [orders, ...fcs] = await Promise.all([get("/mushroom-partner/sales-orders"), ...buyerLinks.map((l) => get(`/mushroom-partner/forecast?partner_id=${l.partner_id}`))]);
      html += fcs.map((f) => `<div class="mp-card"><h3>${esc(f.coop_name)}: สต็อกและคาดการณ์</h3>
        ${table(["สินค้า", "เกรด", "#พร้อมขาย (กก.)"], f.stock_available.map((s) => `<tr><td>${PROD[s.product_type]}</td><td>${esc(s.grade || "-")}</td><td class="num">${n2(s.kg)}</td></tr>`))}
        <p class="mp-empty">กล่องที่กำลังออกดอก ${f.boxes_with_members} กล่อง · คาดว่าจะเก็บได้อีก ${f.expected_remaining_kg == null ? "- (สหกรณ์ยังไม่มีประวัติพอ)" : n2(f.expected_remaining_kg) + " กก."}</p></div>`).join("");
      html += `<div class="mp-card"><h3>ส่งคำขอซื้อ</h3><form class="mp-form" id="orderForm">
        <div><label>สหกรณ์</label><select name="partner_id">${buyerLinks.map((l) => `<option value="${esc(l.partner_id)}">${esc(l.coop_name)}</option>`).join("")}</select></div>
        <div><label>ประเภท</label><select name="order_kind"><option value="spot">ครั้งเดียว</option><option value="contract">สัญญาล่วงหน้า</option></select></div>
        <div><label>สินค้า</label><select name="product_type">${Object.entries(PROD).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
        <div><label>เกรด</label><select name="grade"><option value="">-</option><option value="A">A ดอกตูม</option><option value="B">B ดอกบาน</option><option value="C">C ตกเกรด</option></select></div>
        <div><label>กก.</label><input name="qty_kg" type="number" step="0.01" min="0" required></div>
        <div><label>ราคาเสนอ/กก.</label><input name="price_per_kg" type="number" step="0.01" min="0" required></div>
        <div><label>ต้องการรับวันที่</label><input name="deliver_on" type="date"></div>
        <div><button class="mp-btn">ส่งคำขอซื้อ</button></div></form></div>`;
      html += `<div class="mp-card"><h3>คำสั่งซื้อของท่าน</h3>${table(["วันที่", "สหกรณ์", "สินค้า", "#กก.", "#ราคา", "#ยอด", "สถานะ", ""], orders.map((o) => `<tr>
        <td>${d(o.created_at)}</td><td>${esc(o.coop_name)}</td><td>${PROD[o.product_type]} ${esc(o.grade || "")}${o.order_kind === "contract" ? " · สัญญา" : ""}</td>
        <td class="num">${n2(o.qty_kg)}</td><td class="num">${baht(o.price_per_kg)}</td><td class="num">${baht(o.amount)}</td><td>${pill(o.status)}${o.invoice_no ? `<br><small>${esc(o.invoice_no)}</small>` : ""}</td>
        <td>${o.status === "Requested" ? `<button class="mp-btn ghost" data-cancel="${o.order_id}">ยกเลิก</button>` : ""}</td></tr>`))}</div>`;
    }
    if (types.has("transporter")) {
      const trips = await get("/mushroom-partner/trips");
      html += `<div class="mp-card"><h3>เที่ยวรถที่ได้รับมอบหมาย</h3>${trips.length ? trips.map((t) => `<div style="margin-bottom:14px"><b>${d(t.trip_date)} · ${esc(t.coop_name)}</b> ${pill(t.status)} <small>${esc(t.vehicle || "")} ${esc(t.driver_name || "")}</small>
        ${table(["#", "สมาชิก", "โทร", "ที่อยู่", "งาน", "สถานะ"], t.stops.map((s) => `<tr><td>${s.seq}</td><td>${esc(s.member)}</td><td>${esc(s.phone || "")}</td><td>${esc(s.address || "")}</td>
          <td>${s.drop_boxes ? `ส่ง ${s.drop_boxes} กล่อง ` : ""}${s.collect_mushroom ? "รับเห็ด " : ""}${s.collect_straw ? "รับฟาง" : ""}</td><td>${pill(s.status)}</td></tr>`))}</div>`).join("") : '<div class="mp-empty">ไม่มีเที่ยวรถใน 14 วัน</div>'}</div>`;
    }
    $("#content").innerHTML = html;
    document.querySelectorAll("form[data-po]").forEach((f) => f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const lots = [...f.querySelectorAll("[data-line]")].map((i) => ({ line_id: i.dataset.line, lot_no: i.value, produced_on: (f.querySelector(`[data-prod="${i.dataset.line}"]`) || {}).value || undefined }));
      try { await post(`/mushroom-partner/purchase-orders/${f.dataset.po}/confirm`, { spawn_lots: lots, expected_date: f.expected_date.value || undefined }); msg("ยืนยันใบสั่งซื้อแล้ว"); render(); } catch (err) { msg("ไม่สำเร็จ: " + err.message, true); }
    }));
    const of = $("#orderForm");
    if (of) of.addEventListener("submit", async (e) => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(of));
      ["grade", "deliver_on"].forEach((k) => { if (!b[k]) delete b[k]; });
      try { await post("/mushroom-partner/sales-orders", b); msg("ส่งคำขอซื้อแล้ว รอสหกรณ์ยืนยัน"); render(); } catch (err) { msg("ไม่สำเร็จ: " + err.message, true); }
    });
    document.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", async () => {
      try { await post(`/mushroom-partner/sales-orders/${b.dataset.cancel}/cancel`); msg("ยกเลิกแล้ว"); render(); } catch (err) { msg("ไม่สำเร็จ: " + err.message, true); }
    }));
  }

  function start() {
    if (!session()) { $("#loginView").hidden = false; $("#appView").hidden = true; return; }
    $("#loginView").hidden = true;
    $("#loginView").style.display = "none";
    $("#appView").hidden = false;
    render().catch((e) => { if (e.message !== "session") $("#content").innerHTML = `<div class="mp-card error-box show">โหลดไม่สำเร็จ: ${esc(e.message)}</div>`; });
  }
  start();
})();
