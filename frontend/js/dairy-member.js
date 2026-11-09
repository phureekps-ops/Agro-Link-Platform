/**
 * โคนมของฉัน — หน้ามือถือสำหรับสมาชิกผู้เลี้ยงโคนม.
 * ใช้ session เกษตรกรจาก js/api.js และ backend/src/routes/dairymember.js.
 * ปุ่มใหญ่ ตัวอักษรใหญ่ งานหลักไม่เกิน 3 ครั้งแตะ.
 */
(function () {
  "use strict";
  const API = AgroLinkAPI;
  if (!API.requireSessionOrRedirect()) return;

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const baht = (v) => Number(v || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const n2 = (v) => (v == null ? "-" : Number(v).toLocaleString("th-TH", { maximumFractionDigits: 2 }));
  const d = (v) => (v ? new Date(String(v).length === 10 ? v + "T00:00:00" : v).toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short" }) : "-");
  const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const ENTRY = { milk_sale: "ค่าน้ำนม", feed: "อาหาร/ปัจจัย", vet_service: "ค่าสัตวแพทย์", ai_service: "ค่าผสมเทียม", loan_repayment: "ชำระสินเชื่อ", share: "ค่าหุ้น", adjustment: "ปรับปรุง" };
  const STATUS = { Pending: "รอสหกรณ์อนุมัติ", Approved: "อนุมัติแล้ว", Suspended: "ระงับชั่วคราว", Open: "รอสหกรณ์", Assigned: "มอบหมายสัตวแพทย์แล้ว", Done: "เสร็จแล้ว", Cancelled: "ยกเลิก", Draft: "กำลังสรุป", Submitted: "ส่งธนาคารแล้ว", Paid: "โอนแล้ว" };
  const COW = { Calf: "ลูกโค", Heifer: "โคสาว", Milking: "รีดนม", Dry: "หยุดรีด/พักท้อง", Bull: "โคตัวผู้" };
  const EVENT = { heat: "เป็นสัด", insemination: "ผสมเทียม", pregnancy_check: "ตรวจท้อง", calving: "คลอด", dry_off: "หยุดรีด", treatment: "รักษา", vaccination: "วัคซีน", note: "บันทึก" };
  const REJ = { antibiotic: "พบยาตกค้าง", temperature: "อุณหภูมิไม่ผ่าน", smell: "กลิ่นผิดปกติ", clot: "นมจับตัว", other: "อื่น ๆ" };
  const ERR = { member_not_approved: "สหกรณ์ยังไม่อนุมัติการเป็นสมาชิก", already_member: "เป็นสมาชิกสหกรณ์นี้แล้ว", photo_too_large: "รูปใหญ่เกินไป", ear_tag_exists: "เบอร์หูนี้มีในระบบแล้ว", female_only: "ใช้ได้กับโคเพศเมีย", animal_not_active: "โคตัวนี้ไม่อยู่ในฝูงแล้ว" };

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
    const h = await API.get(`/dairy-member/home?member_id=${memberId}`);
    $("#who").textContent = `${h.member.full_name} · ${h.member.coop_name}`;
    const t = h.test;
    const todayRows = h.recent.filter((r) => r.round_date === h.today);
    const kg7 = h.recent.filter((r) => r.status === "Accepted").reduce((a, r) => a + Number(r.weight_kg), 0);
    const herd = Object.fromEntries(h.herd.map((x) => [x.status, x.n]));
    sec.innerHTML = `
      ${h.member.status !== "Approved" ? `<div class="mm-card" style="background:var(--gold-100)">สถานะ: <b>${STATUS[h.member.status]}</b></div>` : ""}
      ${h.tasks.length ? `<div class="mm-card"><h2>ต้องทำ</h2>${h.tasks.map((x) => `<div class="mm-task">${({ withdrawal: "🚫", calving: "🐄", dry_off: "⏸" })[x.type]} <b>${esc(x.ear_tag)}</b>: ${({ withdrawal: "ห้ามส่งนมจากตัวนี้ถึง", calving: "ใกล้คลอด กำหนด", dry_off: "ถึงกำหนดหยุดรีด" })[x.type]} ${d(x.date)}${x.type === "withdrawal" ? " (ระยะหยุดยา)" : ""}</div>`).join("")}</div>` : ""}
      <div class="mm-card"><h2>น้ำนมวันนี้</h2>
        ${todayRows.length ? `<ul class="mm-list">${todayRows.map((r) => `<li><span>${r.shift === "AM" ? "รอบเช้า" : "รอบเย็น"} ${n2(r.weight_kg)} กก.</span>${r.status === "Accepted" ? '<span class="mm-chip ok">รับแล้ว</span>' : `<span class="mm-chip bad">ไม่รับ: ${REJ[r.reject_reason] || ""}</span>`}</li>`).join("")}</ul>` : '<div class="mm-muted">ยังไม่ได้ส่งนมวันนี้</div>'}
        <p class="mm-muted" style="margin:8px 0 0">7 วันที่ผ่านมา ส่งแล้ว ${n2(kg7)} กก.</p></div>
      <div class="mm-card"><h2>คุณภาพและราคาที่ได้</h2>
        <div class="mm-prices">
          <div class="mm-price"><small>ราคา (บาท/กก.)</small><b>${n2(h.price_now.price)}</b></div>
          <div class="mm-price"><small>ไขมัน %</small><b>${t ? n2(t.fat_pct) : "-"}</b></div>
          <div class="mm-price"><small>SCC (พัน)</small><b>${t ? n2(t.scc_k) : "-"}</b></div>
        </div>
        <p class="mm-muted" style="margin:8px 0 0">${t ? `ผลตรวจ ${d(t.sample_date)} · SNF ${n2(t.snf_pct)}%` : "ยังไม่มีผลตรวจ — ได้ราคาฐาน"} · ราคาฐาน ${n2(h.base_price_per_kg)}
          ${h.price_now.detail.adjustments.map((a) => ` · ${({ fat: "ไขมัน", snf: "SNF", scc: "SCC", tbc: "แบคทีเรีย" })[a.param]} ${a.adjust > 0 ? "+" : ""}${a.adjust}`).join("")}</p></div>
      <div class="mm-card"><h2>ยอดค้างรอบนี้</h2><div class="mm-big ${h.unsettled_net < 0 ? "mm-neg" : ""}">${baht(h.unsettled_net)} บาท</div>
        <p class="mm-muted">${h.next_pay_period_end ? `สหกรณ์สรุปรอบถัดไปถึง ${d(h.next_pay_period_end)} แล้วโอนเข้าบัญชี ธ.ก.ส.` : "สหกรณ์โอนเข้าบัญชี ธ.ก.ส. ทุกรอบจ่าย"}</p></div>
      <div class="mm-card"><h2>ฝูงของฉัน</h2><div class="mm-prices">
        <div class="mm-price"><small>รีดนม</small><b>${herd.Milking || 0}</b></div><div class="mm-price"><small>หยุดรีด</small><b>${herd.Dry || 0}</b></div>
        <div class="mm-price"><small>โคสาว/ลูก</small><b>${(herd.Heifer || 0) + (herd.Calf || 0)}</b></div></div></div>`;
    return undefined;
  };

  PAGES.cows = async (sec) => {
    const cows = await API.get(`/dairy-member/animals?member_id=${memberId}`);
    sec.innerHTML = `
      <div class="mm-card"><h2>บันทึกเหตุการณ์</h2>
        ${cows.length ? `<form id="evForm">
          <div class="mm-field"><label>โค</label><select name="animal_id">${cows.map((c) => `<option value="${esc(c.animal_id)}">${esc(c.ear_tag)} ${esc(c.name || "")} (${COW[c.status] || c.status})</option>`).join("")}</select></div>
          <div class="mm-field"><label>เหตุการณ์</label><select name="event_type"><option value="heat">เป็นสัด</option><option value="calving">คลอด</option><option value="dry_off">หยุดรีด</option><option value="note">บันทึกอื่น</option></select></div>
          <div class="mm-row2" id="calfBox" hidden><div class="mm-field"><label>เบอร์หูลูก</label><input name="calf_ear_tag"></div>
            <div class="mm-field"><label>เพศลูก</label><select name="calf_sex"><option value="F">เมีย</option><option value="M">ผู้</option></select></div></div>
          <div class="mm-field"><label>วันที่</label><input type="date" name="event_date" value="${today()}" max="${today()}"></div>
          <div class="mm-field"><label>หมายเหตุ</label><input name="note"></div>
          <button class="mm-btn">บันทึก</button>
          <p class="mm-muted">การรักษาและผสมเทียมให้กด "ขอบริการ" — สัตวแพทย์จะบันทึกให้</p></form>` : '<div class="mm-muted">ยังไม่มีโคในทะเบียน</div>'}</div>
      <div class="mm-card"><h2>โคของฉัน (${cows.length})</h2>
        ${cows.map((c) => `<div class="mm-cow"><b>${esc(c.ear_tag)}</b> ${esc(c.name || "")} <span class="mm-chip ${c.status === "Milking" ? "ok" : ""}">${COW[c.status] || c.status}</span>
          ${c.pregnant ? `<span class="mm-chip warn">ท้อง คลอด ${d(c.expected_calving_date)}</span>` : ""}
          ${c.withdrawal_until && String(c.withdrawal_until).slice(0, 10) >= today() ? `<span class="mm-chip bad">ห้ามส่งนมถึง ${d(c.withdrawal_until)}</span>` : ""}
          <div class="mm-muted">${(c.recent_events || []).map((e) => `${d(e.event_date)} ${EVENT[e.event_type] || e.event_type}`).join(" · ") || "ยังไม่มีบันทึก"}</div></div>`).join("")}
        <details><summary>➕ เพิ่มโคในทะเบียน</summary><form id="addCow" style="margin-top:10px">
          <div class="mm-row2"><div class="mm-field"><label>เบอร์หู</label><input name="ear_tag" required></div><div class="mm-field"><label>ชื่อ</label><input name="name"></div></div>
          <div class="mm-row2"><div class="mm-field"><label>สถานะ</label><select name="status"><option value="Milking">รีดนม</option><option value="Dry">หยุดรีด</option><option value="Heifer">โคสาว</option><option value="Calf">ลูกโค</option><option value="Bull">โคตัวผู้</option></select></div>
            <div class="mm-field"><label>เพศ</label><select name="sex"><option value="F">เมีย</option><option value="M">ผู้</option></select></div></div>
          <div class="mm-field"><label>สายพันธุ์</label><input name="breed"></div><button class="mm-btn ghost">เพิ่มโค</button></form></details></div>`;
    const ev = $("#evForm");
    if (ev) {
      ev.event_type.addEventListener("change", () => { $("#calfBox").hidden = ev.event_type.value !== "calving"; });
      ev.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await API.post(`/dairy-member/animals/${ev.animal_id.value}/events`, { member_id: memberId, event_type: ev.event_type.value, event_date: ev.event_date.value, note: ev.note.value, calf_ear_tag: ev.calf_ear_tag.value, calf_sex: ev.calf_sex.value });
          msg("บันทึกแล้ว"); show("cows");
        } catch (err) { msg(errText(err), true); }
      });
    }
    $("#addCow").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      try { await API.post("/dairy-member/animals", { member_id: memberId, ear_tag: f.ear_tag.value, name: f.name.value, status: f.status.value, sex: f.sex.value, breed: f.breed.value }); msg("เพิ่มโคแล้ว"); show("cows"); } catch (err) { msg(errText(err), true); }
    });
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

  PAGES.request = async (sec) => {
    const [items, cows, reqs] = await Promise.all([API.get(`/dairy-member/items?member_id=${memberId}`), API.get(`/dairy-member/animals?member_id=${memberId}`), API.get(`/dairy-member/requests?member_id=${memberId}`)]);
    const REQ = { feed: "เบิกอาหาร/ปัจจัย", vet: "สัตวแพทย์", ai: "ผสมเทียม" };
    sec.innerHTML = `
      <div class="mm-card"><h2>เบิกอาหารสัตว์ (หักจากค่านม)</h2>
        ${items.length ? `<form id="feedForm"><div class="mm-field"><label>รายการ</label><select name="item_id">${items.map((i) => `<option value="${esc(i.item_id)}">${esc(i.name)} — ${n2(i.sell_price)} บาท/${esc(i.unit)}</option>`).join("")}</select></div>
          <div class="mm-field"><label>จำนวน</label><input name="qty" type="number" inputmode="decimal" min="0.1" step="0.1" required></div><button class="mm-btn">ส่งคำขอเบิก</button></form>` : '<div class="mm-muted">สหกรณ์ยังไม่ได้ตั้งราคาสินค้า</div>'}</div>
      <div class="mm-card"><h2>เรียกสัตวแพทย์ / ผสมเทียม</h2>
        <form id="vetForm">
          <div class="mm-field"><label>บริการ</label><select name="request_type"><option value="vet">สัตวแพทย์ (ป่วย/บาดเจ็บ)</option><option value="ai">ผสมเทียม (โคเป็นสัด)</option></select></div>
          <div class="mm-field"><label>โค</label><select name="animal_id"><option value="">ไม่ระบุ</option>${cows.map((c) => `<option value="${esc(c.animal_id)}">${esc(c.ear_tag)} ${esc(c.name || "")}</option>`).join("")}</select></div>
          <div class="mm-field"><label>อาการ/รายละเอียด</label><textarea name="description" rows="2"></textarea></div>
          <div class="mm-field"><label>ถ่ายรูป</label><input name="photo" type="file" accept="image/*" capture="environment"><img class="mm-photo" id="photoPrev" alt="ตัวอย่างรูป"></div>
          <button class="mm-btn">ส่งคำขอ</button></form></div>
      <div class="mm-card"><h2>คำขอของฉัน</h2>${reqs.length ? `<ul class="mm-list">${reqs.map((r) => `<li><span>${d(r.created_at)} · ${REQ[r.request_type]}${r.item_name ? ` ${esc(r.item_name)} ${n2(r.qty)} ${esc(r.unit)}` : ""}${r.ear_tag ? ` โค ${esc(r.ear_tag)}` : ""}${r.partner_name ? `<br><span class="mm-muted">${esc(r.partner_name)}</span>` : ""}</span>
        <span class="mm-chip ${r.status === "Done" ? "ok" : "warn"}">${STATUS[r.status]}</span></li>`).join("")}</ul>` : '<div class="mm-muted">ยังไม่มีคำขอ</div>'}</div>`;
    const ff = $("#feedForm");
    if (ff) ff.addEventListener("submit", async (e) => {
      e.preventDefault();
      try { await API.post("/dairy-member/requests", { member_id: memberId, request_type: "feed", item_id: ff.item_id.value, qty: ff.qty.value }); msg("ส่งคำขอเบิกแล้ว รับของที่ศูนย์รวบรวม"); show("request"); } catch (err) { msg(errText(err), true); }
    });
    let photo = null;
    sec.querySelector("[name=photo]").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try { photo = await resizeImage(file); const p = $("#photoPrev"); p.src = photo; p.style.display = "block"; } catch (err) { msg("อ่านรูปไม่ได้", true); }
    });
    $("#vetForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await API.post("/dairy-member/requests", { member_id: memberId, request_type: f.request_type.value, animal_id: f.animal_id.value || undefined, description: f.description.value, photo_data_url: photo || undefined });
        msg("ส่งคำขอแล้ว สหกรณ์จะส่งเจ้าหน้าที่มา"); show("request");
      } catch (err) { msg(errText(err), true); }
    });
  };

  PAGES.money = async (sec) => {
    const s = await API.get(`/dairy-member/statement?member_id=${memberId}`);
    sec.innerHTML = `
      <div class="mm-card"><h2>รอบนี้ (ยังไม่โอน)</h2><div class="mm-big ${s.open_total < 0 ? "mm-neg" : ""}">${baht(s.open_total)} บาท</div>
        <ul class="mm-list">${s.open.map((e) => `<li><span>${d(e.entry_date)} ${ENTRY[e.entry_type]}<br><span class="mm-muted">${esc(e.note || "")}</span></span><b class="${Number(e.amount) < 0 ? "mm-neg" : ""}">${baht(e.amount)}</b></li>`).join("") || '<li class="mm-muted">ยังไม่มีรายการ</li>'}</ul></div>
      <div class="mm-card"><h2>รอบที่ผ่านมา</h2><p class="mm-muted">โอนเข้าบัญชี ธ.ก.ส. ${esc(s.baac_account_no || "(ยังไม่ได้แจ้งเลขบัญชีกับสหกรณ์)")}</p>
        <ul class="mm-list">${s.runs.map((r) => `<li><span>${d(r.period_start)} – ${d(r.period_end)}<br><span class="mm-muted">รายรับ ${baht(r.total_credit)} หัก ${baht(r.total_debit)}${Number(r.carried_debit) ? ` · ยกไปรอบหน้า ${baht(r.carried_debit)}` : ""}</span><br>
          <span class="mm-chip ${r.status === "Paid" ? "ok" : "warn"}">${STATUS[r.status]}</span></span><b>${baht(r.net_amount)}</b></li>`).join("") || '<li class="mm-muted">ยังไม่มีรอบจ่าย</li>'}</ul></div>`;
  };

  PAGES.join = async (sec) => {
    const coops = await API.get("/dairy-member/coops");
    const mine = new Set(memberships.map((m) => m.coop_org_id));
    const avail = coops.filter((c) => !mine.has(c.org_id));
    sec.innerHTML = `<div class="mm-card"><h2>สมัครเป็นสมาชิกสหกรณ์โคนม</h2>
      <p class="mm-muted">ส่งนมที่ศูนย์รวบรวมของสหกรณ์ ได้ราคาตามคุณภาพ ดูยอดเงิน เบิกอาหารสัตว์ และเรียกสัตวแพทย์ได้จากหน้านี้</p>
      ${avail.length ? `<form id="joinForm">
        <div class="mm-field"><label>สหกรณ์</label><select name="coop_org_id">${avail.map((c) => `<option value="${esc(c.org_id)}">${esc(c.org_name)}</option>`).join("")}</select></div>
        <div class="mm-field"><label>ชื่อฟาร์ม</label><input name="farm_name"></div>
        <div class="mm-field"><label>ที่อยู่ฟาร์ม</label><input name="address"></div>
        <button class="mm-btn">สมัคร</button></form>` : '<div class="mm-muted">ยังไม่มีสหกรณ์โคนมที่เปิดรับสมาชิกเพิ่ม</div>'}
      <a href="dashboard.html" class="mm-btn ghost" style="text-align:center;text-decoration:none;box-sizing:border-box">กลับหน้าเกษตรกร</a></div>`;
    const f = $("#joinForm");
    if (f) f.addEventListener("submit", async (e) => {
      e.preventDefault();
      try { await API.post("/dairy-member/join", { coop_org_id: f.coop_org_id.value, farm_name: f.farm_name.value, address: f.address.value }); msg("ส่งใบสมัครแล้ว รอสหกรณ์อนุมัติ"); await init(); } catch (err) { msg(errText(err), true); }
    });
  };

  async function init() {
    try { memberships = await API.get("/dairy-member/memberships"); } catch (e) { if (e.message !== "session_expired") msg(errText(e), true); return; }
    const sel = $("#memberSel");
    if (!memberships.length) { $("#who").textContent = "ยังไม่ได้เป็นสมาชิกสหกรณ์โคนม"; memberId = null; show("join"); return; }
    sel.innerHTML = memberships.map((m) => `<option value="${esc(m.member_id)}">${esc(m.coop_name)}</option>`).join("") + '<option value="__join">+ สมัครสหกรณ์อื่น</option>';
    sel.hidden = false;
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
