/**
 * พอร์ทัลคู่ค้าโคนม — backend/src/routes/dairypartner.js.
 * Own session key (agrolink_dairy_partner_session) so it never collides
 * with the same organization's other portal sessions in this browser.
 */
(function () {
  "use strict";
  const API_BASE = ["localhost", "127.0.0.1"].includes(window.location.hostname) ? "http://localhost:4000" : "https://agrolink-backend-vhv6.onrender.com";
  const KEY = "agrolink_dairy_partner_session";
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const n2 = (v) => (v == null ? "-" : Number(v).toLocaleString("th-TH", { maximumFractionDigits: 2 }));
  const baht = (v) => Number(v || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const d = (v) => (v ? new Date(String(v).length === 10 ? v + "T00:00:00" : v).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" }) : "-");
  const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const PT = { processor: "โรงงานแปรรูปนม", feed_supplier: "ผู้ขายอาหารสัตว์/ปัจจัย", vet: "สัตวแพทย์/ผสมเทียม", product_buyer: "ผู้ซื้อผลิตภัณฑ์", transporter: "ผู้ขนส่ง" };
  const ST = { Ordered: "รอยืนยัน", Confirmed: "ยืนยันแล้ว", Delivered: "ส่งมอบแล้ว", Cancelled: "ยกเลิก", Sent: "รอยืนยันรับ", Received: "รับแล้ว", Rejected: "ปฏิเสธ", Pending: "รอตอบ", Accepted: "ตกลง", Withdrawn: "ถอน", Assigned: "รอดำเนินการ", Done: "เสร็จ", Open: "เปิด", Active: "ใช้งาน", Ended: "สิ้นสุด", Matched: "จับคู่แล้ว" };
  const pill = (s) => `<span class="mp-pill ${["Delivered", "Received", "Accepted", "Done", "Confirmed", "Active", "Matched"].includes(s) ? "ok" : ["Rejected", "Cancelled", "Withdrawn"].includes(s) ? "bad" : "warn"}">${ST[s] || s}</span>`;
  const table = (heads, rows) => (rows.length ? `<div class="mp-scroll"><table class="mp-table"><thead><tr>${heads.map((h) => `<th${h[0] === "#" ? ' class="num"' : ""}>${h.replace(/^#/, "")}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` : '<div class="mp-empty">ยังไม่มีข้อมูล</div>');
  const ERR = { processor_profile_required: "ลงทะเบียนโปรไฟล์โรงงานก่อน", below_min_price: "ต่ำกว่าราคาขั้นต่ำของประกาศ", more_than_offered: "มากกว่าปริมาณที่ประกาศ", proposal_exists: "มีข้อเสนอค้างอยู่แล้ว", received_more_than_sent: "รับมากกว่าที่สหกรณ์ส่ง", missing_reject_reason: "ต้องระบุเหตุผล", offer_not_open: "ประกาศปิดแล้ว", waiting_for_coop: "รอสหกรณ์ตอบ", kyb_not_verified: "องค์กรยังไม่ผ่านการยืนยันตัวตน", invalid_dates: "วันที่ไม่ถูกต้อง", female_only: "ใช้ได้กับโคเพศเมีย", no_insemination_record: "ยังไม่มีบันทึกการผสม" };
  const errText = (e) => ERR[(e.body || {}).error] || (e.body && e.body.error) || e.message;

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
  const put = (p, b) => req(p, { method: "PUT", body: JSON.stringify(b || {}) });
  function msg(t, err) { const m = $("#msg"); m.textContent = t; m.className = "mp-msg " + (err ? "err" : "ok"); window.scrollTo(0, 0); }
  const fd = (f) => { const o = {}; new FormData(f).forEach((v, k) => { if (v !== "") o[k] = v; }); return o; };

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
    const { links, processor_profile: prof } = await get("/dairy-partner/links");
    const types = new Set(links.map((l) => l.partner_type));
    get("/auth/session/current").then((me) => { $("#whoName").textContent = me.display_name || ""; }).catch(() => {});
    let html = `<div class="mp-card"><h3>สหกรณ์ที่เป็นคู่ค้า</h3>${links.length ? links.map((l) => `<span class="mp-pill ok">${esc(l.coop_name)} — ${PT[l.partner_type]}</span>`).join(" ")
      : '<div class="mp-empty">ยังไม่ถูกผูกเป็นคู่ค้าของสหกรณ์ใด — โรงงานแปรรูปเข้าร่วมตลาดนมส่วนเกินด้านล่างได้เลย ส่วนบทบาทอื่นให้สหกรณ์เพิ่มองค์กรของท่านในหน้า "คู่ค้า"</div>'}</div>`;

    // --- ตลาดนมส่วนเกิน (โรงงานใดก็ได้ที่ผ่าน KYB) ---
    const mk = await get("/dairy-partner/market");
    const showMarket = prof || types.has("processor") || !links.length;
    html += `<${showMarket ? "div" : "details"} class="mp-card">${showMarket ? "<h3>" : '<summary style="cursor:pointer;font-weight:700">'}🔁 ตลาดนมส่วนเกิน — โปรไฟล์โรงงาน${showMarket ? "</h3>" : " (สำหรับโรงงานแปรรูปนม)</summary>"}
      <form data-f="profile" class="mp-form"><div><label>ชื่อที่แสดง</label><input name="display_name" value="${esc(prof ? prof.display_name : "")}"></div>
        <div><label>รหัสจังหวัด</label><input name="province_code" value="${esc(prof ? prof.province_code || "" : "")}" placeholder="เช่น SARABURI"></div>
        <div><label>ผลิตภัณฑ์ที่ผลิต</label><input name="products" value="${esc(prof ? prof.products || "" : "")}"></div><div><label>โทรติดต่อ</label><input name="contact_phone" value="${esc(prof ? prof.contact_phone || "" : "")}"></div>
        <div><button class="mp-btn">${prof ? "บันทึก" : "ลงทะเบียนเข้าตลาด"}</button></div></form></${showMarket ? "div" : "details"}>`;
    if (prof) {
      const caps = await get("/dairy-partner/processor/capacities");
      html += `<div class="mp-card"><h3>ประกาศกำลังรับนมว่าง</h3>
        <form data-f="capacity" class="mp-form"><div><label>ตั้งแต่</label><input type="date" name="available_from" value="${today()}"></div><div><label>ถึง</label><input type="date" name="available_to" required></div>
          <div><label>รับได้ (กก./วัน)</label><input type="number" name="kg_per_day" required></div><div><label>ราคา (บาท/กก.)</label><input type="number" step="0.01" name="price_per_kg" required></div>
          <div><label>หมายเหตุ</label><input name="note"></div><div><button class="mp-btn">ประกาศ</button></div></form>
        ${table(["ช่วง", "#กก./วัน", "#ราคา", "สถานะ", ""], caps.map((k) => `<tr><td>${d(k.available_from)} – ${d(k.available_to)}</td><td class="num">${n2(k.kg_per_day)}</td><td class="num">${baht(k.price_per_kg)}</td>
          <td>${k.active ? pill("Open") : "ปิด"}</td><td>${k.active ? `<button class="mp-btn ghost" data-a="capClose" data-id="${k.capacity_id}">ปิด</button>` : ""}</td></tr>`))}</div>
      <div class="mp-card"><h3>ประกาศนมส่วนเกินจากสหกรณ์</h3>
        ${table(["สหกรณ์", "จังหวัด", "ช่วง", "#กก./วัน", "#ขั้นต่ำ", "ไขมัน/SNF เฉลี่ย", "เสนอรับ"], mk.offers.map((o) => `<tr><td>${esc(o.coop_name)}</td><td>${esc(o.province_name_th || "-")}</td>
          <td>${d(o.start_date)} · ${o.days} วัน</td><td class="num">${n2(o.kg_per_day)}</td><td class="num">${baht(o.min_price)}</td><td>${n2(o.avg_fat_pct)} / ${n2(o.avg_snf_pct)}${o.note ? `<br><small>${esc(o.note)}</small>` : ""}</td>
          <td><form data-f="propose" data-id="${o.offer_id}" class="mp-form" style="grid-template-columns:90px 90px auto"><input type="number" name="kg_per_day" placeholder="กก./วัน" max="${Number(o.kg_per_day)}" required><input type="number" step="0.01" name="price_per_kg" placeholder="บาท/กก." min="${Number(o.min_price)}" required><button class="mp-btn">เสนอ</button></form></td></tr>`))}</div>
      <div class="mp-card"><h3>ข้อเสนอของฉัน</h3>
        ${table(["สหกรณ์", "ช่วง", "#กก./วัน", "#ราคา", "ใครเสนอ", "สถานะ", ""], mk.proposals.map((p) => `<tr><td>${esc(p.coop_name)}</td><td>${d(p.start_date)} · ${p.days} วัน</td><td class="num">${n2(p.kg_per_day)}</td><td class="num">${baht(p.price_per_kg)}</td>
          <td>${p.proposed_by === "coop" ? "สหกรณ์เสนอมา" : "เราเสนอ"}</td><td>${pill(p.status)}</td>
          <td>${p.status === "Pending" ? (p.proposed_by === "coop" ? `<button class="mp-btn" data-a="propAccept" data-id="${p.proposal_id}">ตอบรับ</button> <button class="mp-btn ghost" data-a="propReject" data-id="${p.proposal_id}">ปฏิเสธ</button>` : `<button class="mp-btn ghost" data-a="propReject" data-id="${p.proposal_id}">ถอน</button>`) : ""}</td></tr>`))}</div>`;
    }

    if (types.has("processor")) {
      const [ships, contracts] = await Promise.all([get("/dairy-partner/shipments"), get("/dairy-partner/contracts")]);
      html += `<div class="mp-card"><h3>🥛 นมดิบที่สหกรณ์ส่งมา</h3>
        ${table(["วันที่", "สหกรณ์", "อ้างอิง", "#ส่ง (กก.)", "#อุณหภูมิ", "ผลรับ", "#ยอดเงิน", "สถานะ"], ships.map((s) => `<tr><td>${d(s.ship_date)}<br><small>${esc(s.vehicle || "")}</small></td><td>${esc(s.coop_name)}</td>
          <td>${s.contract_no ? "สัญญา " + esc(s.contract_no) : s.is_surplus ? "ตลาดส่วนเกิน" : "-"}<br><small>ราคา ${baht(s.contract_price || s.deal_price || 0)}</small></td><td class="num">${n2(s.sent_kg)}</td><td class="num">${s.tank_temp_c == null ? "-" : n2(s.tank_temp_c) + "°C"}</td>
          <td>${s.status === "Sent" ? `<form data-f="receive" data-id="${s.shipment_id}" class="mp-form mp-sub">
              <div><label>ผล</label><select name="status"><option value="Received">รับ</option><option value="Rejected">ปฏิเสธทั้งเที่ยว</option></select></div>
              <div><label>รับจริง (กก.)</label><input type="number" step="0.1" name="received_kg" value="${Number(s.sent_kg)}"></div><div><label>ราคา (ว่าง=ตามสัญญา)</label><input type="number" step="0.01" name="price_per_kg"></div>
              <div><label>ไขมัน %</label><input type="number" step="0.01" name="fat_pct"></div><div><label>SNF %</label><input type="number" step="0.01" name="snf_pct"></div><div><label>SCC (พัน)</label><input type="number" name="scc_k"></div>
              <div><label>เหตุผลถ้าปฏิเสธ</label><input name="reject_reason"></div><div><button class="mp-btn">ยืนยัน</button></div></form>`
    : `${n2(s.received_kg)} กก. ${s.fat_pct ? `F ${n2(s.fat_pct)} S ${n2(s.snf_pct)}` : ""}${s.reject_reason ? esc(s.reject_reason) : ""}`}</td>
          <td class="num">${s.amount ? baht(s.amount) : "-"}</td><td>${pill(s.status)}${s.paid_at ? ' <span class="mp-pill ok">สหกรณ์ได้รับเงิน</span>' : ""}</td></tr>`))}</div>
      <div class="mp-card"><h3>สัญญารับซื้อ</h3>${table(["เลขที่", "สหกรณ์", "ช่วง", "#กก./วัน", "#ราคา", "สถานะ"], contracts.map((k) => `<tr><td>${esc(k.contract_no || "-")}</td><td>${esc(k.coop_name)}</td><td>${d(k.start_date)} – ${d(k.end_date)}</td><td class="num">${n2(k.daily_kg)}</td><td class="num">${baht(k.price_per_kg)}</td><td>${pill(k.status)}</td></tr>`))}</div>`;
    }
    if (types.has("feed_supplier")) {
      const pos = await get("/dairy-partner/purchase-orders");
      html += `<div class="mp-card"><h3>🌾 ใบสั่งซื้อจากสหกรณ์</h3>${table(["วันที่", "สหกรณ์", "รายการ", "#ยอด", "#ค่าบริการ AgroLink (ผู้ขายจ่าย)", "สถานะ", ""], pos.map((p) => `<tr>
        <td>${d(p.ordered_at)}<br><small>ต้องการ ${d(p.expected_date)}</small></td><td>${esc(p.coop_name)}</td><td>${p.lines.map((l) => `${esc(l.name)} ${n2(l.qty)} ${esc(l.unit)} × ${baht(l.unit_price)}`).join("<br>")}</td>
        <td class="num">${baht(p.total_amount)}</td><td class="num">${p.fee_amount != null ? `${baht(p.fee_amount)} (${n2(p.fee_rate_pct)}%)` : "-"}</td><td>${pill(p.status)}${p.paid_at ? ' <span class="mp-pill ok">สหกรณ์จ่ายแล้ว</span>' : ""}</td>
        <td>${p.status === "Ordered" ? `<button class="mp-btn" data-a="poConfirm" data-id="${p.po_id}">ยืนยัน</button>` : ""}</td></tr>`))}</div>`;
    }
    if (types.has("vet")) {
      const vr = await get("/dairy-partner/vet/requests");
      html += `<div class="mp-card"><h3>🩺 งานสัตวแพทย์/ผสมเทียมที่ได้รับมอบหมาย</h3>${table(["วันที่", "สหกรณ์", "สมาชิก", "โค", "รายละเอียด", "สถานะ / บันทึกผล"], vr.map((r) => `<tr>
        <td>${d(r.created_at)}</td><td>${esc(r.coop_name)}</td><td>${esc(r.member_name)}<br><small>${esc(r.member_phone || "")} ${esc(r.address || "")}</small></td>
        <td>${esc(r.ear_tag || "-")}</td><td>${r.request_type === "ai" ? "ผสมเทียม" : "สัตวแพทย์"}: ${esc(r.description || "")}${r.has_photo ? `<br><a href="#" data-a="photo" data-id="${r.request_id}">ดูรูป</a><div id="ph-${r.request_id}"></div>` : ""}</td>
        <td>${r.status === "Assigned" && r.animal_id ? `<form data-f="vetRecord" data-id="${r.request_id}" class="mp-form mp-sub">
            <div><label>งาน</label><select name="event_type"><option value="${r.request_type === "ai" ? "insemination" : "treatment"}">${r.request_type === "ai" ? "ผสมเทียม" : "รักษา"}</option><option value="vaccination">วัคซีน</option><option value="pregnancy_check">ตรวจท้อง</option><option value="treatment">รักษา</option><option value="insemination">ผสมเทียม</option></select></div>
            <div><label>ยา / น้ำเชื้อ</label><input name="drug"></div><div><label>หยุดยา (วัน)</label><input type="number" min="0" name="withdrawal_days"></div>
            <div><label>ผลตรวจท้อง</label><select name="result"><option value="">-</option><option value="positive">ท้อง</option><option value="negative">ไม่ท้อง</option></select></div>
            <div><label>ค่าบริการ (หักจากสมาชิก)</label><input type="number" min="0" name="cost"></div><div><button class="mp-btn">บันทึก</button></div></form>`
    : r.status === "Assigned" ? "ไม่ได้ระบุโค — แจ้งสหกรณ์" : pill(r.status)}</td></tr>`))}</div>`;
    }
    if (types.has("product_buyer")) {
      const pp = await get("/dairy-partner/product-purchases");
      html += `<div class="mp-card"><h3>🧃 ผลิตภัณฑ์ที่ซื้อจากสหกรณ์</h3>${table(["วันที่", "สหกรณ์", "ผลิตภัณฑ์/ล็อต", "หมดอายุ", "#จำนวน", "#ยอด"], pp.map((s) => `<tr><td>${d(s.sold_on)}</td><td>${esc(s.coop_name)}</td><td>${esc(s.product_name)} <small>${esc(s.lot_code)}</small></td><td>${d(s.expires_on)}</td><td class="num">${s.units} ${esc(s.unit)}</td><td class="num">${baht(s.amount)}</td></tr>`))}</div>`;
    }
    $("#content").innerHTML = html;
  }

  const ACT = {
    capClose: (el) => post(`/dairy-partner/processor/capacities/${el.dataset.id}/close`).then(() => { msg("ปิดประกาศแล้ว"); render(); }),
    propAccept: (el) => post(`/dairy-partner/market/proposals/${el.dataset.id}/accept`).then(() => { msg("ตกลงรับนมแล้ว — สหกรณ์จะบันทึกเที่ยวส่ง"); render(); }),
    propReject: (el) => post(`/dairy-partner/market/proposals/${el.dataset.id}/reject`).then(() => { msg("บันทึกแล้ว"); render(); }),
    poConfirm: (el) => post(`/dairy-partner/purchase-orders/${el.dataset.id}/confirm`).then(() => { msg("ยืนยันใบสั่งซื้อแล้ว"); render(); }),
    photo: (el) => get(`/dairy-partner/vet/requests/${el.dataset.id}/photo`).then((r) => { if (r.photo_data_url) $(`#ph-${el.dataset.id}`).innerHTML = `<img src="${esc(r.photo_data_url)}" alt="รูปประกอบ" style="max-width:220px;border-radius:8px">`; }),
  };
  const FORMS = {
    profile: (f) => put("/dairy-partner/processor/profile", fd(f)).then(() => msg("บันทึกโปรไฟล์โรงงานแล้ว")),
    capacity: (f) => post("/dairy-partner/processor/capacities", fd(f)).then(() => msg("ประกาศกำลังรับแล้ว")),
    propose: (f) => post(`/dairy-partner/market/offers/${f.dataset.id}/propose`, fd(f)).then(() => msg("ส่งข้อเสนอแล้ว รอสหกรณ์ตอบรับ")),
    receive: (f) => post(`/dairy-partner/shipments/${f.dataset.id}/receive`, fd(f)).then((r) => msg(r.status === "Received" ? `ยืนยันรับ ${n2(r.received_kg)} กก. ยอด ${baht(r.amount)} บาท` : "บันทึกการปฏิเสธแล้ว")),
    vetRecord: (f) => {
      const b = fd(f);
      const details = {};
      ["drug", "result"].forEach((k) => { if (b[k]) details[k] = b[k]; });
      if (b.withdrawal_days) details.withdrawal_days = Number(b.withdrawal_days);
      return post(`/dairy-partner/vet/requests/${f.dataset.id}/record`, { event_type: b.event_type, cost: b.cost || 0, details }).then((r) => msg(`บันทึกแล้ว${r.charged ? ` ค่าบริการ ${baht(r.charged)} บาท หักจากบัญชีสมาชิก` : ""}`));
    },
  };
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-a]");
    if (!el || !ACT[el.dataset.a]) return;
    e.preventDefault();
    ACT[el.dataset.a](el).catch((err) => msg(errText(err), true));
  });
  document.addEventListener("submit", (e) => {
    const f = e.target.closest("form[data-f]");
    if (!f || !FORMS[f.dataset.f]) return;
    e.preventDefault();
    FORMS[f.dataset.f](f).then(render).catch((err) => msg(errText(err), true));
  });

  function start() {
    $("#loginView").hidden = true;
    $("#loginView").style.display = "none";
    $("#appView").hidden = false;
    render().catch((e) => { if (e.message !== "session") $("#content").innerHTML = `<div class="mp-card">โหลดไม่สำเร็จ: ${esc(errText(e))}</div>`; });
  }
  if (session()) start();
})();
