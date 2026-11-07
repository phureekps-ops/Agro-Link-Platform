/**
 * เห็ดฟางของฉัน — หน้ามือถือสำหรับสมาชิกผู้เปิดดอก (เกษตรกรรายย่อย).
 * ใช้ session เกษตรกรจาก js/api.js และ backend/src/routes/mushroommember.js.
 * ออกแบบให้ใช้ง่าย: ปุ่มใหญ่ ตัวอักษรใหญ่ ไม่เกิน 3 ครั้งต่องาน.
 */
(function () {
  "use strict";
  const API = AgroLinkAPI;
  if (!API.requireSessionOrRedirect()) return;

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const baht = (v) => Number(v || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const n2 = (v) => Number(v || 0).toLocaleString("th-TH", { maximumFractionDigits: 2 });
  const d = (v) => (v ? new Date(v).toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short" }) : "-");
  const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const GRADE = { A: "ดอกตูม", B: "ดอกบาน", C: "ตกเกรด" };
  const ENTRY = { straw_sale: "ขายฟาง", mushroom_sale: "ขายเห็ด", sale_fee: "ค่าบริการ", box_liability: "ค่ากล่องหาย/แตก", adjustment: "ปรับปรุง" };
  const STATUS = { Pending: "รอสหกรณ์ตรวจจุดเปิดดอก", Approved: "อนุมัติแล้ว", Suspended: "ระงับชั่วคราว", Requested: "รอจัดกล่อง", Allocated: "จัดรุ่นแล้ว", Delivered: "ส่งแล้ว", Cancelled: "ยกเลิก", Open: "รอดำเนินการ", Resolved: "แก้ไขแล้ว", Draft: "กำลังสรุป", Submitted: "ส่งธนาคารแล้ว", Paid: "โอนแล้ว" };
  const ERR = { over_member_capacity: "เกินจำนวนกล่องที่จุดเปิดดอกรับได้", member_not_approved: "สหกรณ์ยังไม่อนุมัติจุดเปิดดอก", invalid_wanted_date: "เลือกวันที่ตั้งแต่วันนี้เป็นต้นไป", already_member: "เป็นสมาชิกสหกรณ์นี้แล้ว", photo_too_large: "รูปใหญ่เกินไป" };
  const DAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

  let memberId = null;
  let memberships = [];
  function msg(text, isErr) {
    const m = $("#msg");
    m.textContent = text;
    m.className = "mm-msg " + (isErr ? "err" : "ok");
    window.scrollTo({ top: 0, behavior: "smooth" });
    clearTimeout(msg.h);
    msg.h = setTimeout(() => { m.className = "mm-msg"; }, 6000);
  }
  const errText = (e) => ERR[(e.body || {}).error] || (e.body && e.body.error) || e.message;

  function show(tab) {
    document.querySelectorAll(".mm-page").forEach((p) => p.classList.toggle("active", p.dataset.page === tab));
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    PAGES[tab]($(`.mm-page[data-page="${tab}"]`)).catch((e) => { if (e.message !== "session_expired") msg("โหลดข้อมูลไม่สำเร็จ: " + errText(e), true); });
  }
  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => {
    if (!memberId && b.dataset.tab !== "home") { show("join"); return; }
    show(b.dataset.tab);
  }));
  $("#logoutBtn").addEventListener("click", () => API.logout());

  const PAGES = {};

  PAGES.home = async (sec) => {
    if (!memberId) return PAGES.join($('.mm-page[data-page="join"]')).then(() => show("join"));
    const h = await API.get(`/mushroom-member/home?member_id=${memberId}`);
    $("#who").textContent = `${h.member.full_name} · ${h.member.coop_name}`;
    const p = Object.fromEntries(h.prices.map((x) => [x.grade, x.price_per_kg]));
    sec.innerHTML = `
      ${h.member.status !== "Approved" ? `<div class="mm-card" style="background:var(--gold-100)">สถานะ: <b>${STATUS[h.member.status]}</b><br><span class="mm-muted">สหกรณ์จะติดต่อเพื่อดูจุดเปิดดอก (ต้องกันลมและมีน้ำ)</span></div>` : ""}
      <div class="mm-card"><h2>ราคารับซื้อวันนี้ (บาท/กก.)</h2>
        ${h.prices.length ? `<div class="mm-prices">${["A", "B", "C"].map((g) => `<div class="mm-price"><small>${GRADE[g]}</small><b>${p[g] != null ? n2(p[g]) : "-"}</b></div>`).join("")}</div>`
    : '<div class="mm-muted">สหกรณ์ยังไม่ประกาศราคาวันนี้</div>'}
        <p class="mm-muted" style="margin:8px 0 0">จ่ายตามน้ำหนักเห็ดที่ส่ง ราคาตามวันที่รถมารับ</p></div>
      <div class="mm-card"><h2>กล่องที่ฝากเลี้ยงอยู่: ${h.boxes_on_hand} กล่อง</h2>
        ${h.tasks.length ? h.tasks.map((t) => `<div class="mm-task"><b>รุ่น ${esc(t.batch_code)} (${t.boxes} กล่อง) — วันที่ ${t.days_on_site + 1}</b><br>${esc(t.task)}</div>`).join("")
    : '<div class="mm-muted">ยังไม่มีกล่องที่บ้าน — กด "จองกล่อง" ด้านล่าง</div>'}
        ${h.boxes_on_hand ? `<form id="estForm"><div class="mm-field" style="margin-top:10px"><label>คาดว่าจะเก็บเห็ดได้ (กก.)</label><input name="est_kg" type="number" inputmode="decimal" step="0.1" min="0" required></div><button class="mm-btn ghost">แจ้งสหกรณ์</button></form>` : ""}
      </div>
      <div class="mm-card"><h2>ยอดรอรับรอบนี้</h2>
        <div class="mm-big">${baht(h.balance.unsettled_net)} บาท</div>
        <ul class="mm-list"><li><span>ขายเห็ด</span><b>${baht(h.balance.mushroom_sales)}</b></li><li><span>ขายฟาง</span><b>${baht(h.balance.straw_sales)}</b></li>
          <li><span>หักค่าบริการ/ค่ากล่อง</span><b class="mm-neg">${baht(h.balance.deductions)}</b></li></ul>
        <p class="mm-muted">โอนเข้าบัญชี ธ.ก.ส. ${esc(h.member.baac_account_no || "(ยังไม่ได้แจ้งเลขบัญชีกับสหกรณ์)")} ทุกวัน${h.settlement_weekday != null ? DAYS[h.settlement_weekday] : ""}</p></div>
      ${h.next_trip ? `<div class="mm-card"><h2>🚚 รถสหกรณ์รอบถัดไป</h2><b>${d(h.next_trip.trip_date)}</b><br>
        ${h.next_trip.drop_boxes ? `ส่งกล่อง ${h.next_trip.drop_boxes} กล่อง · ` : ""}${h.next_trip.collect_mushroom ? "รับเห็ด" : ""}${h.next_trip.collect_straw ? " · รับฟาง" : ""}</div>` : ""}`;
    const est = $("#estForm");
    if (est) {
      est.addEventListener("submit", async (e) => {
        e.preventDefault();
        try { await API.post("/mushroom-member/harvest-estimate", { member_id: memberId, est_kg: est.est_kg.value }); msg("แจ้งสหกรณ์แล้ว"); est.reset(); } catch (err) { msg(errText(err), true); }
      });
    }
    return undefined;
  };

  PAGES.boxes = async (sec) => {
    const [rows, home] = await Promise.all([API.get(`/mushroom-member/bookings?member_id=${memberId}`), API.get(`/mushroom-member/home?member_id=${memberId}`)]);
    const cap = home.member.capacity_boxes;
    sec.innerHTML = `
      <div class="mm-card"><h2>จองกล่องเพาะ (ฝากเลี้ยง)</h2>
        <p class="mm-muted">กล่องเป็นของสหกรณ์ หากกล่องหายหรือแตก ต้องชดใช้ตามราคาที่สหกรณ์กำหนด${cap ? ` · จุดเปิดดอกรับได้ ${cap} กล่อง (มีอยู่ ${home.boxes_on_hand})` : ""}</p>
        <form id="bookForm">
          <div class="mm-field"><label>จำนวนกล่อง</label><input name="requested_boxes" type="number" inputmode="numeric" min="1" required></div>
          <div class="mm-field"><label>อยากได้วันที่</label><input name="wanted_date" type="date" min="${today()}" value="${today()}" required></div>
          <button class="mm-btn">จองกล่อง</button></form></div>
      <div class="mm-card"><h2>การจองของฉัน</h2>
        ${rows.length ? `<ul class="mm-list">${rows.map((r) => `<li><span>${d(r.wanted_date)} · ${r.requested_boxes} กล่อง<br><span class="mm-chip ${r.status === "Delivered" ? "ok" : "warn"}">${STATUS[r.status] || r.status}</span></span>
          ${r.status === "Requested" ? `<button class="mm-btn ghost" style="width:auto;margin:0;font-size:14px;padding:8px 12px" data-cancel="${r.booking_id}">ยกเลิก</button>` : ""}</li>`).join("")}</ul>` : '<div class="mm-muted">ยังไม่มีการจอง</div>'}</div>`;
    $("#bookForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await API.post("/mushroom-member/bookings", { member_id: memberId, requested_boxes: f.requested_boxes.value, wanted_date: f.wanted_date.value });
        msg("จองแล้ว สหกรณ์จะจัดรถมาส่งกล่อง");
        show("boxes");
      } catch (err) { msg(errText(err), true); }
    });
    sec.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", async () => {
      try { await API.post(`/mushroom-member/bookings/${b.dataset.cancel}/cancel`, {}); msg("ยกเลิกแล้ว"); show("boxes"); } catch (err) { msg(errText(err), true); }
    }));
  };

  function resizeImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, 900 / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", 0.75));
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  PAGES.report = async (sec) => {
    const rows = await API.get(`/mushroom-member/issues?member_id=${memberId}`);
    sec.innerHTML = `
      <div class="mm-card"><h2>แจ้งปัญหาให้สหกรณ์</h2>
        <form id="issueForm">
          <div class="mm-field"><label>ปัญหา</label><select name="issue_type">
            <option value="no_mycelium">เชื้อไม่เดิน / ไม่ออกดอก</option><option value="mold">มีราแข่ง</option><option value="pest">แมลง/ศัตรู</option>
            <option value="box_damaged">กล่องเสียหาย</option><option value="other">อื่น ๆ</option></select></div>
          <div class="mm-field"><label>รายละเอียด</label><textarea name="note" rows="2"></textarea></div>
          <div class="mm-field"><label>ถ่ายรูป</label><input name="photo" type="file" accept="image/*" capture="environment"><img class="mm-photo" id="photoPrev" alt="ตัวอย่างรูป"></div>
          <button class="mm-btn">ส่งเรื่อง</button></form></div>
      <div class="mm-card"><h2>เรื่องที่แจ้ง</h2>${rows.length ? `<ul class="mm-list">${rows.map((r) => `<li><span>${d(r.created_at)} · ${esc(r.note || r.issue_type)}${r.resolution ? `<br><span class="mm-muted">สหกรณ์: ${esc(r.resolution)}</span>` : ""}</span><span class="mm-chip ${r.status === "Resolved" ? "ok" : "warn"}">${STATUS[r.status]}</span></li>`).join("")}</ul>` : '<div class="mm-muted">ยังไม่มีเรื่องที่แจ้ง</div>'}</div>`;
    let photo = null;
    sec.querySelector("[name=photo]").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try { photo = await resizeImage(file); const p = $("#photoPrev"); p.src = photo; p.style.display = "block"; } catch (err) { msg("อ่านรูปไม่ได้", true); }
    });
    $("#issueForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await API.post("/mushroom-member/issues", { member_id: memberId, issue_type: f.issue_type.value, note: f.note.value, photo_url: photo || undefined });
        msg("ส่งเรื่องให้สหกรณ์แล้ว");
        show("report");
      } catch (err) { msg(errText(err), true); }
    });
  };

  PAGES.money = async (sec) => {
    const [s, hv] = await Promise.all([API.get(`/mushroom-member/statement?member_id=${memberId}`), API.get(`/mushroom-member/harvests?member_id=${memberId}`)]);
    const net = s.open_entries.reduce((t, e) => t + Number(e.amount), 0);
    sec.innerHTML = `
      <div class="mm-card"><h2>รอบนี้ (ยังไม่โอน)</h2><div class="mm-big">${baht(net)} บาท</div>
        <ul class="mm-list">${s.open_entries.map((e) => `<li><span>${d(e.entry_date)} ${ENTRY[e.entry_type]}<br><span class="mm-muted">${esc(e.note || "")}</span></span><b class="${Number(e.amount) < 0 ? "mm-neg" : ""}">${baht(e.amount)}</b></li>`).join("") || '<li class="mm-muted">ยังไม่มีรายการ</li>'}</ul></div>
      <div class="mm-card"><h2>โอนแล้ว</h2><ul class="mm-list">${s.settlements.map((r) => `<li><span>${d(r.period_start)} – ${d(r.period_end)}<br><span class="mm-chip ${r.status === "Paid" ? "ok" : "warn"}">${STATUS[r.status]}</span></span><b>${baht(r.net_amount)}</b></li>`).join("") || '<li class="mm-muted">ยังไม่มีรอบที่โอน</li>'}</ul></div>
      <div class="mm-card"><h2>ส่งเห็ดล่าสุด</h2><ul class="mm-list">${hv.slice(0, 20).map((h) => `<li><span>${d(h.collected_at)} · ${GRADE[h.grade]} ${n2(h.weight_kg)} กก. × ${n2(h.price_per_kg)}</span><b>${baht(h.amount)}</b></li>`).join("") || '<li class="mm-muted">ยังไม่มี</li>'}</ul></div>`;
  };

  PAGES.join = async (sec) => {
    const coops = await API.get("/mushroom-member/coops");
    const mine = new Set(memberships.map((m) => m.coop_org_id));
    const avail = coops.filter((c) => !mine.has(c.org_id));
    sec.innerHTML = `<div class="mm-card"><h2>สมัครเป็นสมาชิกผู้เปิดดอก</h2>
      <p class="mm-muted">สหกรณ์เป็นศูนย์ผลิตกล่องเพาะ ท่านรับกล่องไปเปิดดอกที่บ้านแบบฝากเลี้ยง แล้วส่งเห็ดขายคืนให้สหกรณ์ตามราคาที่ประกาศรายวัน</p>
      ${avail.length ? `<form id="joinForm">
        <div class="mm-field"><label>สหกรณ์</label><select name="coop_org_id">${avail.map((c) => `<option value="${esc(c.org_id)}">${esc(c.org_name)}</option>`).join("")}</select></div>
        <div class="mm-field"><label>ที่อยู่จุดเปิดดอก</label><input name="address"></div>
        <div class="mm-field"><label>วางกล่องได้ประมาณ (กล่อง)</label><input name="capacity_boxes" type="number" inputmode="numeric" min="0"></div>
        <div class="mm-field"><label><input type="checkbox" name="wind_protected" style="width:auto"> พื้นที่กันลมได้</label><label><input type="checkbox" name="water_available" style="width:auto"> มีน้ำใช้</label></div>
        <button class="mm-btn">สมัคร</button></form>` : '<div class="mm-muted">ยังไม่มีสหกรณ์ที่เปิดรับสมาชิกเพิ่ม</div>'}
      <a href="dashboard.html" class="mm-btn ghost" style="text-align:center;text-decoration:none;box-sizing:border-box">กลับหน้าเกษตรกร</a></div>`;
    const f = $("#joinForm");
    if (f) {
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await API.post("/mushroom-member/join", { coop_org_id: f.coop_org_id.value, address: f.address.value, capacity_boxes: f.capacity_boxes.value || 0, wind_protected: f.wind_protected.checked, water_available: f.water_available.checked });
          msg("ส่งใบสมัครแล้ว รอสหกรณ์ตรวจจุดเปิดดอก");
          await init();
        } catch (err) { msg(errText(err), true); }
      });
    }
  };

  async function init() {
    try {
      memberships = await API.get("/mushroom-member/memberships");
    } catch (e) { if (e.message !== "session_expired") msg(errText(e), true); return; }
    const sel = $("#memberSel");
    if (!memberships.length) { $("#who").textContent = "ยังไม่ได้เป็นสมาชิกโปรแกรมเห็ดฟาง"; memberId = null; show("join"); return; }
    sel.innerHTML = memberships.map((m) => `<option value="${esc(m.member_id)}">${esc(m.coop_name)}</option>`).join("") + '<option value="__join">+ สมัครสหกรณ์อื่น</option>';
    sel.hidden = memberships.length < 1;
    memberId = memberId && memberships.some((m) => m.member_id === memberId) ? memberId : memberships[0].member_id;
    sel.value = memberId;
    show("home");
  }
  $("#memberSel").addEventListener("change", (e) => {
    if (e.target.value === "__join") { e.target.value = memberId; show("join"); return; }
    memberId = e.target.value;
    show("home");
  });
  init();
})();
