/**
 * AgroLink — โปรแกรมเห็ดฟางครบวงจร ฝั่งสหกรณ์ (ศูนย์ผลิตกล่องเพาะ).
 * Talks to backend/src/routes/mushroom.js (/mushroom/*) with the cooperative
 * session from js/api.js. Each tab renders itself from the API on open;
 * buttons use data-act (see ACT) and forms use data-form (see FORM).
 */
(function () {
  "use strict";
  const API = AgroLinkCoopAPI;
  if (!API.requireSessionOrRedirect()) return;

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const n2 = (v) => (v == null || v === "" ? "-" : Number(v).toLocaleString("th-TH", { maximumFractionDigits: 2 }));
  const baht = (v) => (v == null ? "-" : Number(v).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const d = (v) => (v ? new Date(v).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" }) : "-");
  const dt = (v) => (v ? new Date(v).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "-");
  const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const opt = (rows, val, label, sel) => rows.map((r) => `<option value="${esc(r[val])}"${sel === r[val] ? " selected" : ""}>${esc(typeof label === "function" ? label(r) : r[label])}</option>`).join("");
  const table = (heads, rows) => rows.length
    ? `<div class="mh-scroll"><table class="mh-table"><thead><tr>${heads.map((h) => `<th${h.startsWith("#") ? ' class="num"' : ""}>${esc(h.replace(/^#/, ""))}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : '<div class="mh-empty">ยังไม่มีข้อมูล</div>';
  const pill = (txt, cls) => `<span class="mh-pill ${cls || ""}">${esc(txt)}</span>`;

  const ERR = {
    insufficient_material: "วัสดุในคลังไม่พอสำหรับรุ่นนี้", not_enough_boxes: "กล่องว่างไม่พอ", insufficient_spawn: "เชื้อในล็อตนี้ไม่พอ",
    price_not_announced: "ยังไม่ได้ประกาศราคาของวันนี้สำหรับเกรดนี้", member_not_approved: "สมาชิกยังไม่ได้รับอนุมัติ",
    over_member_capacity: "เกินความจุจุดเปิดดอกของสมาชิก", site_not_ready: "จุดเปิดดอกต้องกันลมและมีน้ำก่อนอนุมัติ",
    missing_baac_account: "สมาชิกบางรายยังไม่มีเลขบัญชี ธ.ก.ส.", nothing_to_settle: "ไม่มียอดค้างจ่ายสำหรับรอบนี้",
    draft_run_exists: "มีรอบหักกลบที่ยังเป็นฉบับร่างอยู่", pct_must_total_100: "สัดส่วนวัสดุต้องรวมได้ 100%", insufficient_stock: "สต็อกสินค้าไม่พอ",
    boxes_not_returned: "ยังมีกล่องอยู่ที่สมาชิก", box_not_with_member: "กล่องนี้ไม่ได้อยู่ที่สมาชิก", missing_spawn_lot_no: "ต้องระบุเลขล็อตเชื้อ",
    no_unlotted_harvest: "ไม่มีการรับซื้อที่ยังไม่เข้าล็อตในวันนั้น", batch_not_ready: "รุ่นนี้ยังไม่พร้อมแจก", not_enough_boxes_in_batch: "กล่องในรุ่นไม่พอ",
  };
  function toast(msg, isErr) {
    const t = $("#mhToast");
    t.textContent = msg;
    t.className = "mh-toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast.h);
    toast.h = setTimeout(() => { t.style.display = "none"; }, isErr ? 7000 : 3500);
  }
  function errMsg(e) {
    const b = e.body || {};
    let m = ERR[b.error] || b.error || e.message;
    if (b.shortages) m += ": " + b.shortages.map((s) => `${s.material} ต้องใช้ ${n2(s.need_kg)} มี ${n2(s.stock_kg)} กก.`).join(", ");
    if (b.field) m += ` (${b.field})`;
    if (b.available !== undefined && b.needed !== undefined) m += ` (มี ${b.available} ต้องการ ${b.needed})`;
    if (b.members) m += ": " + b.members.join(", ");
    if (b.total !== undefined) m += ` (รวม ${b.total}%)`;
    if (b.detail) m += ` — ${b.detail}`;
    return m;
  }
  const fd = (form) => {
    const o = {};
    new FormData(form).forEach((v, k) => { o[k] = typeof v === "string" ? v.trim() : v; });
    form.querySelectorAll("input[type=checkbox]").forEach((c) => { o[c.name] = c.checked; });
    return o;
  };
  async function run(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      if (e.message !== "session_expired") toast(errMsg(e), true);
      return null;
    }
  }

  const STATUS_TH = {
    Pending: "รออนุมัติ", Approved: "อนุมัติแล้ว", Suspended: "ระงับ", Available: "ว่าง", InBatch: "อยู่ในรุ่นผลิต", WithMember: "ฝากเลี้ยงที่สมาชิก",
    Lost: "สูญหาย", Broken: "แตกหัก", Retired: "ปลดระวาง", Composting: "หมักกอง", Pasteurized: "อบไอน้ำแล้ว", SpawnRun: "บ่มเส้นใย", Ready: "พร้อมแจก",
    Distributed: "แจกครบแล้ว", Closed: "ปิดรุ่น", Failed: "เสีย/ยกเลิก", Ordered: "สั่งแล้ว", Confirmed: "ยืนยันแล้ว", Delivered: "ส่งมอบแล้ว",
    Cancelled: "ยกเลิก", Requested: "รอยืนยัน", Paid: "ชำระแล้ว", Allocated: "จัดรุ่นแล้ว", Open: "รอดำเนินการ", Resolved: "แก้ไขแล้ว",
    Planned: "วางแผน", InProgress: "กำลังวิ่ง", Done: "เสร็จ", Skipped: "ข้าม", Draft: "ฉบับร่าง", Submitted: "ส่ง ธ.ก.ส. แล้ว", Returned: "คืนแล้ว",
  };
  const st = (s) => pill(STATUS_TH[s] || s, ["Approved", "Available", "Ready", "Done", "Paid", "Delivered", "Closed", "Resolved", "Returned"].includes(s) ? "ok"
    : ["Pending", "Requested", "Draft", "Open", "Ordered", "Submitted", "SpawnRun", "Composting", "Pasteurized", "InProgress"].includes(s) ? "warn"
      : ["Lost", "Broken", "Failed", "Cancelled", "Suspended"].includes(s) ? "bad" : "");
  const PTYPE = { biomass_seller: "ผู้ขายเศษวัสดุชีวมวล", spawn_seller: "ผู้ขายเชื้อเห็ดฟาง", buyer: "ผู้ซื้อ", transporter: "ผู้ขนส่ง" };
  const PROD = { fresh: "เห็ดสด", blanched_frozen: "ลวกแช่แข็ง", soy_pickled: "ดองซีอิ๊ว", canned: "บรรจุกระป๋อง" };
  const GRADE = { A: "A ดอกตูม", B: "B ดอกบาน", C: "C ตกเกรด" };
  const LEDGER = { straw_sale: "ขายฟาง", mushroom_sale: "ขายเห็ด", sale_fee: "ค่าบริการ AgroLink", box_liability: "ค่ากล่องหาย/แตก", adjustment: "ปรับปรุง" };
  const FEE = { spawn_purchase: "ซื้อเชื้อเห็ด", substrate_purchase: "ซื้อวัสดุเพาะ", member_sale: "สมาชิกขายเห็ดให้สหกรณ์", external_sale: "สหกรณ์ขายให้ผู้ซื้อภายนอก" };
  const LOC = { steam_room: "ห้องอบไอน้ำ", spawn_room: "ห้องบ่มเส้นใย", fruiting_site: "จุดเปิดดอกสมาชิก", cold_storage: "ห้องเย็น" };
  const EVENT = { create: "ตั้งกองหมัก", turn: "กลับกอง", pasteurize: "อบไอน้ำ", spawn: "ใส่เชื้อ", ready: "ผ่าน QC", qc: "ตรวจ QC", distribute: "แจกกล่อง", close: "ปิดรุ่น", fail: "รุ่นเสีย", note: "บันทึก" };
  const COST = { material: "วัสดุ", spawn: "เชื้อเห็ด", energy: "พลังงาน", labor: "แรงงาน", other: "อื่น ๆ" };
  const ISSUE = { no_mycelium: "เชื้อไม่เดิน", mold: "ราแข่ง", pest: "แมลง/ศัตรู", box_damaged: "กล่องเสียหาย", other: "อื่น ๆ" };

  const cache = {};
  async function load(key, path) { cache[key] = await API.get(path); return cache[key]; }

  // ---------- navigation ----------
  let current = "overview";
  function show(tab) {
    current = tab;
    document.querySelectorAll(".mh-page").forEach((p) => p.classList.toggle("active", p.dataset.page === tab));
    document.querySelectorAll("#mhNav [data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    $("#mhTitle").textContent = $(`#mhNav [data-tab="${tab}"]`).childNodes[0].textContent.trim();
    refresh();
    try { history.replaceState(null, "", "#" + tab); } catch (e) { /* ignore */ }
  }
  async function refresh() {
    const sec = $(`.mh-page[data-page="${current}"]`);
    if (!sec.innerHTML) sec.innerHTML = '<div class="loading-line">กำลังโหลด…</div>';
    try {
      await PAGES[current](sec);
    } catch (e) {
      if (e.body && (e.body.error === "kyb_not_verified" || e.body.error === "role_not_verified")) {
        sec.innerHTML = '<div class="mh-card">บัญชีนี้ยังไม่ได้รับอนุมัติบทบาทสหกรณ์ จึงยังใช้โปรแกรมเห็ดฟางไม่ได้</div>';
      } else if (e.message !== "session_expired") sec.innerHTML = `<div class="mh-card error-box show">โหลดข้อมูลไม่สำเร็จ: ${esc(errMsg(e))}</div>`;
    }
  }
  document.querySelectorAll("#mhNav [data-tab]").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
  $("#logoutBtn").addEventListener("click", () => API.logout());

  async function badges() {
    try {
      const o = await API.get("/mushroom/overview");
      cache.overview = o;
      $("#orgName").textContent = o.org_name;
      const set = (id, n) => { const e = $(id); e.hidden = !n; e.textContent = n; };
      set("#cntMembers", o.members.pending);
      set("#cntFarming", o.pending_bookings + o.open_issues);
      set("#cntOrders", o.open_orders);
      set("#cntAlerts", o.open_iot_alerts);
    } catch (e) { /* page shows its own error */ }
  }

  // ---------- pages ----------
  const PAGES = {};

  PAGES.overview = async (sec) => {
    await badges();
    const o = cache.overview;
    const f = await API.get("/mushroom/forecast");
    const box = o.boxes_by_status;
    sec.innerHTML = `
      ${o.settings_incomplete ? '<div class="mh-card" style="background:var(--gold-100)">⚠️ ยังไม่ได้ตั้งอัตราค่าบริการและราคากล่อง — ไปที่ <a href="#settings" data-act="go" data-tab="settings">ตั้งค่า</a></div>' : ""}
      <div class="mh-grid">
        <div class="mh-stat"><small>สมาชิกอนุมัติแล้ว</small><b>${o.members.approved}</b> <small>รออนุมัติ ${o.members.pending}</small></div>
        <div class="mh-stat"><small>กล่องฝากเลี้ยงที่สมาชิก</small><b>${box.WithMember || 0}</b> <small>ว่าง ${box.Available || 0} · ในรุ่น ${box.InBatch || 0}</small></div>
        <div class="mh-stat"><small>รุ่นที่กำลังผลิต</small><b>${Object.values(o.batches_by_status).reduce((a, b) => a + b, 0)}</b></div>
        <div class="mh-stat"><small>รับซื้อเห็ด 7 วัน</small><b>${n2(o.harvest_7d.kg)}</b> <small>กก. · ${baht(o.harvest_7d.amount)} บาท</small></div>
        <div class="mh-stat"><small>ยอดรอหักกลบ/จ่ายสมาชิก</small><b>${baht(o.unsettled_net)}</b></div>
        <div class="mh-stat ${o.open_issues || o.open_iot_alerts ? "warn" : ""}"><small>ปัญหาจากสมาชิก / แจ้งเตือน IoT</small><b>${o.open_issues} / ${o.open_iot_alerts}</b></div>
      </div>
      <div class="mh-card" style="margin-top:16px"><h3>ราคารับซื้อวันนี้ (${d(o.today)})</h3>
        ${Object.keys(o.prices_today).length ? `<div class="mh-row">${["A", "B", "C"].map((g) => `<span class="mh-pill ok">${GRADE[g]}: ${o.prices_today[g] != null ? baht(o.prices_today[g]) + " บ./กก." : "ยังไม่ประกาศ"}</span>`).join("")}</div>`
    : '<div class="mh-empty">ยังไม่ประกาศราคาวันนี้ — <a href="#harvest" data-act="go" data-tab="harvest">ประกาศราคา</a></div>'}
      </div>
      <div class="mh-card"><h3>คาดการณ์ผลผลิตและสต็อก</h3>
        <div class="mh-grid">
          <div class="mh-stat"><small>กล่องที่อยู่กับสมาชิก</small><b>${f.boxes_with_members}</b></div>
          <div class="mh-stat"><small>ผลผลิตเฉลี่ยต่อกล่อง (จากรุ่นที่ปิดแล้ว)</small><b>${f.avg_kg_per_box_history == null ? "-" : n2(f.avg_kg_per_box_history)}</b> <small>กก.</small></div>
          <div class="mh-stat"><small>คาดว่าจะเก็บได้อีก</small><b>${f.expected_remaining_kg == null ? "-" : n2(f.expected_remaining_kg)}</b> <small>กก.</small></div>
        </div>
        ${f.avg_kg_per_box_history == null ? '<p class="mh-note">ยังไม่มีรุ่นที่ปิดแล้ว จึงยังคาดการณ์จากประวัติจริงไม่ได้</p>' : ""}
        <h3 style="margin-top:14px">สต็อกพร้อมขาย</h3>
        ${table(["สินค้า", "เกรด", "#กก."], f.stock_available.map((s) => `<tr><td>${PROD[s.product_type]}</td><td>${esc(s.grade || "-")}</td><td class="num">${n2(s.kg)}</td></tr>`))}
      </div>
      ${o.low_stock.length ? `<div class="mh-card" style="background:var(--gold-100)"><h3>วัตถุดิบต่ำกว่าจุดสั่งซื้อ</h3>${o.low_stock.map((m) => `${esc(m.name)}: ${n2(m.stock_kg)} / ${n2(m.reorder_level_kg)} กก.`).join("<br>")}</div>` : ""}`;
  };

  PAGES.members = async (sec) => {
    const rows = await load("members", "/mushroom/members");
    sec.innerHTML = `
      <details class="mh-card"><summary>➕ เพิ่มสมาชิกผู้เปิดดอก</summary>
        <form data-form="lookup" class="mh-form" style="margin-top:12px">
          <div><label>ค้นหาเกษตรกรที่มีบัญชี AgroLink ด้วยเบอร์โทร</label><input name="phone" placeholder="08xxxxxxxx"></div>
          <div><button class="mh-btn ghost">ค้นหา</button></div><div class="full" id="lookupResult"></div>
        </form>
        <form data-form="addMember" class="mh-form" style="margin-top:12px">
          <input type="hidden" name="farmer_id">
          <div><label>ชื่อ-สกุล</label><input name="full_name" required></div>
          <div><label>เบอร์โทร</label><input name="phone"></div>
          <div><label>ความจุจุดเปิดดอก (กล่อง)</label><input name="capacity_boxes" type="number" min="0" value="0"></div>
          <div><label>ระยะทางจากศูนย์ (กม.)</label><input name="distance_km" type="number" step="0.1" min="0"></div>
          <div class="full"><label>ที่อยู่จุดเปิดดอก</label><input name="address"></div>
          <div><label>เลขบัญชี ธ.ก.ส.</label><input name="baac_account_no" inputmode="numeric"></div>
          <div><label>ชื่อบัญชี</label><input name="baac_account_name"></div>
          <div><label><input type="checkbox" name="wind_protected"> กันลมได้</label><label><input type="checkbox" name="water_available"> มีน้ำ</label></div>
          <div><button class="mh-btn">บันทึกสมาชิก</button></div>
        </form>
        <p class="mh-note">สมาชิกที่มีบัญชีเกษตรกรใน AgroLink จะเปิดหน้ามือถือ "เห็ดฟางของฉัน" เพื่อดูราคา จองกล่อง แจ้งปัญหา และดูยอดเงินได้เอง</p>
      </details>
      <div class="mh-card"><h3>สมาชิก (${rows.length})</h3>
        ${table(["รหัส", "ชื่อ", "จุดเปิดดอก", "#ความจุ", "#กล่องที่ถือ", "บัญชี ธ.ก.ส.", "#ยอดรอจ่าย", "สถานะ", ""], rows.map((m) => `<tr>
          <td>${esc(m.member_code)}</td><td>${esc(m.full_name)}<br><small>${esc(m.phone || "")}${m.farmer_id ? " · มีบัญชีแอป" : ""}</small></td>
          <td>${m.wind_protected ? "✅กันลม" : "❌กันลม"} ${m.water_available ? "✅น้ำ" : "❌น้ำ"}<br><small>${m.distance_km != null ? n2(m.distance_km) + " กม." : ""}</small></td>
          <td class="num">${m.capacity_boxes}</td><td class="num">${m.boxes_on_hand}</td><td>${esc(m.baac_account_no || "-")}</td>
          <td class="num">${baht(m.unsettled_net)}</td><td>${st(m.status)}</td>
          <td><div class="mh-row">${m.status !== "Approved" ? `<button class="mh-btn sm" data-act="memberStatus" data-id="${m.member_id}" data-status="Approved">อนุมัติ</button>` : `<button class="mh-btn sm danger" data-act="memberStatus" data-id="${m.member_id}" data-status="Suspended">ระงับ</button>`}
            <button class="mh-btn sm ghost" data-act="editMember" data-id="${m.member_id}">แก้ไข</button></div></td></tr>
          <tr id="edit-${m.member_id}" hidden><td colspan="9"></td></tr>`))}
      </div>`;
  };

  PAGES.partners = async (sec) => {
    const rows = await load("partners", "/mushroom/partners");
    sec.innerHTML = `
      <details class="mh-card"><summary>➕ เพิ่มคู่ค้า</summary>
        <form data-form="addPartner" class="mh-form" style="margin-top:12px">
          <div><label>ประเภท</label><select name="partner_type">${Object.entries(PTYPE).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
          <div><label>ชื่อ</label><input name="name" required></div>
          <div><label>ผู้ติดต่อ</label><input name="contact_name"></div>
          <div><label>โทร</label><input name="phone"></div>
          <div class="full"><label>ที่อยู่</label><input name="address"></div>
          <div class="full"><label>ผูกกับบัญชีองค์กรบน AgroLink (ไม่บังคับ) — ให้คู่ค้าเข้าพอร์ทัลคู่ค้าเห็ดฟางได้</label>
            <div class="mh-row"><input name="org_q" placeholder="พิมพ์ชื่อองค์กรอย่างน้อย 2 ตัวอักษร" style="flex:1"><button type="button" class="mh-btn ghost" data-act="findOrg">ค้นหา</button></div>
            <select name="linked_org_id" style="margin-top:6px"><option value="">— ไม่ผูก —</option></select></div>
          <div><button class="mh-btn">บันทึก</button></div>
        </form>
      </details>
      <div class="mh-card"><h3>คู่ค้า</h3>${table(["ประเภท", "ชื่อ", "ติดต่อ", "บัญชี AgroLink", ""], rows.map((p) => `<tr>
        <td>${PTYPE[p.partner_type]}</td><td>${esc(p.name)} ${p.active ? "" : pill("ปิดใช้", "bad")}</td><td>${esc(p.contact_name || "")} ${esc(p.phone || "")}</td>
        <td>${p.linked_org_name ? pill(p.linked_org_name, "ok") : "-"}</td>
        <td><button class="mh-btn sm ghost" data-act="togglePartner" data-id="${p.partner_id}" data-active="${p.active}">${p.active ? "ปิดใช้" : "เปิดใช้"}</button></td></tr>`))}
        <p class="mh-note">คู่ค้าที่ผูกบัญชีแล้วเข้าใช้ที่ <a href="../mushroom-partner.html" target="_blank">พอร์ทัลคู่ค้าเห็ดฟาง</a>: ผู้ขายเชื้อยืนยันใบสั่งซื้อพร้อมเลขล็อต ผู้ซื้อดูคาดการณ์และส่งคำขอซื้อ ผู้ขนส่งดูเที่ยวรถ</p>
      </div>`;
  };

  PAGES.materials = async (sec) => {
    const [mats, pos, lots, partners, members] = await Promise.all([
      API.get("/mushroom/materials"), API.get("/mushroom/purchase-orders"), API.get("/mushroom/spawn-lots"),
      load("partners", "/mushroom/partners"), load("members", "/mushroom/members")]);
    cache.materials = mats;
    const sellers = partners.filter((p) => p.active && p.partner_type === "biomass_seller");
    const spawners = partners.filter((p) => p.active && p.partner_type === "spawn_seller");
    const approved = members.filter((m) => m.status !== "Pending");
    sec.innerHTML = `
      <div class="mh-card"><h3>คลังวัตถุดิบชีวมวล</h3>${table(["วัสดุ", "ประเภท", "#คงเหลือ (กก.)", "#ต้นทุนเฉลี่ย (บ./กก.)", "#จุดสั่งซื้อ (กก.)", ""], mats.map((m) => `<tr>
        <td>${esc(m.name)}</td><td>${{ main: "วัสดุหลัก", mix: "ใช้ผสม", supplement: "อาหารเสริม" }[m.category]}</td>
        <td class="num">${Number(m.stock_kg) < Number(m.reorder_level_kg) && Number(m.reorder_level_kg) > 0 ? `<b style="color:var(--red-600)">${n2(m.stock_kg)}</b>` : n2(m.stock_kg)}</td>
        <td class="num">${baht(m.avg_cost_per_kg)}</td>
        <td class="num"><input type="number" min="0" value="${Number(m.reorder_level_kg)}" style="width:90px" data-reorder="${m.material_id}"></td>
        <td><button class="mh-btn sm ghost" data-act="saveReorder" data-id="${m.material_id}">บันทึก</button></td></tr>`))}</div>
      <div class="mh-card"><h3>รับฟางจากสมาชิก</h3>
        <form data-form="straw" class="mh-form">
          <div><label>สมาชิก</label><select name="member_id" required>${opt(approved, "member_id", (m) => `${m.member_code} ${m.full_name}`)}</select></div>
          <div><label>น้ำหนัก (กก.)</label><input name="qty_kg" type="number" step="0.01" min="0" required></div>
          <div><label>ความชื้น (%)</label><input name="moisture_pct" type="number" step="0.1" min="0" max="100"></div>
          <div><label>ราคา/กก. (ว่าง = ตามตั้งค่า)</label><input name="price_per_kg" type="number" step="0.01" min="0"></div>
          <div><button class="mh-btn">บันทึกรับฟาง</button></div>
        </form><p class="mh-note">เงินค่าฟางเข้าบัญชีสมาชิก และจ่ายในรอบหักกลบรายสัปดาห์</p></div>
      <div class="mh-card"><h3>สั่งซื้อวัสดุเพาะ / เชื้อเห็ด</h3>
        <form data-form="po" class="mh-form">
          <div><label>ประเภท</label><select name="po_type" data-act-change="poType"><option value="substrate">วัสดุเพาะ</option><option value="spawn">เชื้อเห็ดฟาง</option></select></div>
          <div><label>ผู้ขาย</label><select name="partner_id" required data-sellers='${esc(JSON.stringify(sellers.map((p) => [p.partner_id, p.name])))}' data-spawners='${esc(JSON.stringify(spawners.map((p) => [p.partner_id, p.name])))}'>${opt(sellers, "partner_id", "name")}</select></div>
          <div><label>วันที่คาดว่าจะได้รับ</label><input name="expected_date" type="date"></div>
          <div class="full mh-lines" id="poLines"></div>
          <div><button type="button" class="mh-btn ghost" data-act="addPoLine">+ รายการ</button></div>
          <div><button class="mh-btn">ออกใบสั่งซื้อ</button></div>
        </form></div>
      <div class="mh-card"><h3>ใบสั่งซื้อ</h3>${table(["วันที่", "ผู้ขาย", "ประเภท", "รายการ", "#ยอด", "#ค่าบริการ (ผู้ขายจ่าย)", "สถานะ", ""], pos.map((p) => `<tr>
        <td>${d(p.ordered_at)}</td><td>${esc(p.partner_name)}</td><td>${p.po_type === "spawn" ? "เชื้อเห็ด" : "วัสดุเพาะ"}</td>
        <td>${p.lines.map((l) => `${esc(l.item_name)} ${n2(l.qty)} ${esc(l.unit)} × ${baht(l.unit_price)}${l.spawn_lot_no ? ` <small>(ล็อต ${esc(l.spawn_lot_no)})</small>` : ""}`).join("<br>")}</td>
        <td class="num">${baht(p.total_amount)}</td><td class="num">${p.status === "Delivered" ? baht(p.fee_amount) + ` <small>(${n2(p.fee_rate_pct)}%)</small>` : "-"}</td>
        <td>${st(p.status)}${p.paid_at ? " " + pill("จ่ายแล้ว", "ok") : ""}</td>
        <td><div class="mh-row">${["Ordered", "Confirmed"].includes(p.status) ? `<button class="mh-btn sm" data-act="poDeliver" data-id="${p.po_id}" data-type="${p.po_type}" data-lines='${esc(JSON.stringify(p.lines.map((l) => [l.line_id, l.item_name, l.spawn_lot_no || ""])))}'>รับของ</button><button class="mh-btn sm danger" data-act="poCancel" data-id="${p.po_id}">ยกเลิก</button>` : ""}
          ${p.status === "Delivered" && !p.paid_at ? `<button class="mh-btn sm ghost" data-act="poPaid" data-id="${p.po_id}">จ่ายแล้ว</button>` : ""}</div></td></tr>`))}</div>
      <div class="mh-card"><h3>ล็อตเชื้อเห็ด</h3>${table(["เลขล็อต", "ผู้ขาย", "วันผลิต", "#ถุงรับ", "#คงเหลือ", "#ราคา/ถุง"], lots.map((l) => `<tr>
        <td>${esc(l.lot_no)}</td><td>${esc(l.partner_name || "-")}</td><td>${d(l.produced_on)}</td><td class="num">${n2(l.qty_bags)}</td><td class="num">${n2(l.remaining_bags)}</td><td class="num">${baht(l.unit_cost)}</td></tr>`))}</div>
      <details class="mh-card"><summary>ปรับปรุงสต็อก (นับจริง/สูญเสีย)</summary>
        <form data-form="adjust" class="mh-form" style="margin-top:12px">
          <div><label>วัสดุ</label><select name="material_id">${opt(mats, "material_id", "name")}</select></div>
          <div><label>ทิศทาง</label><select name="direction"><option value="out">ลดลง</option><option value="in">เพิ่มขึ้น</option></select></div>
          <div><label>กก.</label><input name="qty_kg" type="number" step="0.01" min="0" required></div>
          <div class="full"><label>เหตุผล</label><input name="note" required></div>
          <div><button class="mh-btn ghost">บันทึก</button></div>
        </form></details>`;
    addPoLine();
  };

  function addPoLine() {
    const form = $('form[data-form="po"]');
    if (!form) return;
    const isSpawn = form.po_type.value === "spawn";
    const mats = cache.materials || [];
    const div = document.createElement("div");
    div.className = "mh-form";
    div.innerHTML = isSpawn
      ? `<div><label>รายการ</label><input data-line="item_name" value="เชื้อเห็ดฟางถุง"></div><div><label>จำนวน (ถุง)</label><input data-line="qty" type="number" min="0" step="1"></div><div><label>ราคา/ถุง</label><input data-line="unit_price" type="number" min="0" step="0.01"></div>`
      : `<div><label>วัสดุ</label><select data-line="material_id">${opt(mats, "material_id", "name")}</select></div><div><label>กก.</label><input data-line="qty" type="number" min="0" step="0.01"></div><div><label>ราคา/กก.</label><input data-line="unit_price" type="number" min="0" step="0.01"></div>`;
    $("#poLines").appendChild(div);
  }

  PAGES.production = async (sec) => {
    const [recipes, batches, lots, mats, settings] = await Promise.all([
      API.get("/mushroom/recipes"), API.get("/mushroom/batches"), API.get("/mushroom/spawn-lots"), API.get("/mushroom/materials"),
      API.get("/mushroom/settings")]);
    cache.materials = mats;
    const activeR = recipes.filter((r) => r.active);
    const lotsLeft = lots.filter((l) => Number(l.remaining_bags) > 0);
    sec.innerHTML = `
      <div class="mh-card"><h3>เริ่มรุ่นการผลิตใหม่</h3>
        ${activeR.length ? `<form data-form="batch" class="mh-form">
          <div><label>สูตรวัสดุ</label><select name="recipe_id">${opt(activeR, "recipe_id", (r) => `${r.name} (${n2(r.kg_per_box)} กก./กล่อง)`)}</select></div>
          <div><label>จำนวนกล่อง</label><input name="boxes_planned" type="number" min="1" required></div>
          <div><label>ชนิดกล่อง</label><select name="box_type_id"><option value="">ทุกชนิด</option>${opt(settings.box_types.filter((t) => t.active), "box_type_id", "name")}</select></div>
          <div><label>วันเริ่มหมัก</label><input name="compost_started_on" type="date" value="${today()}"></div>
          <div><button class="mh-btn">ตั้งกองหมัก</button></div></form>
          <p class="mh-note">ระบบตัดวัสดุตามสูตรจากคลัง (คิดต้นทุนที่ราคาเฉลี่ย) และจองกล่องว่างให้รุ่นนี้</p>` : '<div class="mh-empty">สร้างสูตรวัสดุก่อน (ด้านล่าง)</div>'}
      </div>
      <div class="mh-card"><h3>รุ่นการผลิต</h3>${table(["รุ่น", "สูตร", "#กล่อง", "สถานะ", "เชื้อ", "#ต้นทุน", "#แจกแล้ว", "#เห็ด (กก.)", "ขั้นถัดไป"], batches.map((b) => `<tr>
        <td><a href="#" data-act="batchDetail" data-id="${b.batch_id}">${esc(b.batch_code)}</a><br><small>${d(b.compost_started_on)} · กลับกอง ${b.turn_count}</small></td>
        <td>${esc(b.recipe_name)}</td><td class="num">${b.boxes_planned}${b.boxes_bad ? `<br><small>เสีย ${b.boxes_bad}</small>` : ""}</td><td>${st(b.status)}</td>
        <td>${esc(b.spawn_lot_no || "-")}</td><td class="num">${baht(b.total_cost)}</td><td class="num">${b.boxes_distributed}</td><td class="num">${n2(b.harvest_kg)}</td>
        <td>${batchActions(b, lotsLeft)}</td></tr><tr id="bd-${b.batch_id}" hidden><td colspan="9"></td></tr>`))}
        <p class="mh-note">แนวทางของ อ.อานนท์: หมักกลางแจ้ง กลับกองด้วยเครื่องจักร · อบไอน้ำ ~65–72°C 4–6 ชม. · บ่มเส้นใย ${n2(settings.settings.spawn_run_temp_min)}–${n2(settings.settings.spawn_run_temp_max)}°C ${settings.settings.spawn_run_days} วัน</p></div>
      <details class="mh-card"><summary>สูตรวัสดุ (${recipes.length})</summary>
        ${table(["สูตร", "กก./กล่อง", "เชื้อ ถุง/กล่อง", "ส่วนผสม", "อนุมัติโดย", ""], recipes.map((r) => `<tr><td>${esc(r.name)} ${r.active ? "" : pill("ปิดใช้", "bad")}</td>
          <td>${n2(r.kg_per_box)}</td><td>${n2(r.spawn_bags_per_box)}</td><td>${r.items.map((i) => `${esc(i.name)} ${n2(i.pct)}%`).join(", ")}</td><td>${esc(r.approved_by || "-")}</td>
          <td><button class="mh-btn sm ghost" data-act="toggleRecipe" data-id="${r.recipe_id}" data-active="${r.active}">${r.active ? "ปิดใช้" : "เปิดใช้"}</button></td></tr>`))}
        <form data-form="recipe" class="mh-form" style="margin-top:14px">
          <div><label>ชื่อสูตร</label><input name="name" required></div>
          <div><label>วัสดุต่อกล่อง (กก.)</label><input name="kg_per_box" type="number" step="0.01" min="0" required></div>
          <div><label>เชื้อ (ถุง/กล่อง)</label><input name="spawn_bags_per_box" type="number" step="0.001" min="0" value="0"></div>
          <div><label>อนุมัติสูตรโดย</label><input name="approved_by" placeholder="เช่น ที่ปรึกษา"></div>
          <div class="full"><label>สัดส่วนวัสดุ (% รวม 100)</label><div class="mh-grid">${mats.map((m) => `<div><small>${esc(m.name)}</small><input type="number" min="0" max="100" step="0.1" data-pct="${m.material_id}" placeholder="%"></div>`).join("")}</div></div>
          <div><button class="mh-btn">บันทึกสูตร</button></div>
        </form></details>`;
  };

  function batchActions(b, lots) {
    const id = b.batch_id;
    if (b.status === "Composting") return `<div class="mh-row"><button class="mh-btn sm ghost" data-act="turn" data-id="${id}">กลับกอง</button>
      <input type="number" placeholder="°C" style="width:60px" id="pt-${id}"><input type="number" placeholder="ชม." style="width:55px" id="ph-${id}">
      <button class="mh-btn sm" data-act="pasteurize" data-id="${id}">อบไอน้ำ</button></div>`;
    if (b.status === "Pasteurized") return lots.length ? `<div class="mh-row"><select id="sl-${id}">${opt(lots, "spawn_lot_id", (l) => `${l.lot_no} (เหลือ ${n2(l.remaining_bags)})`)}</select><button class="mh-btn sm" data-act="spawn" data-id="${id}">ใส่เชื้อ</button></div>` : '<small>ยังไม่มีล็อตเชื้อ</small>';
    if (b.status === "SpawnRun") return `<div class="mh-row"><input type="number" min="0" placeholder="กล่องเสีย" style="width:85px" id="bad-${id}"><button class="mh-btn sm" data-act="ready" data-id="${id}">ผ่าน QC พร้อมแจก</button></div>`;
    if (b.status === "Ready") return `<a href="#farming" data-act="go" data-tab="farming">แจกกล่อง →</a>`;
    if (b.status === "Distributed") return `<button class="mh-btn sm ghost" data-act="closeBatch" data-id="${id}">ปิดรุ่น</button>`;
    return "";
  }

  PAGES.boxes = async (sec) => {
    const [sum, settings, list] = await Promise.all([API.get("/mushroom/boxes/summary"), API.get("/mushroom/settings"), API.get("/mushroom/boxes")]);
    const types = settings.box_types.filter((t) => t.active);
    sec.innerHTML = `
      <div class="mh-card"><h3>สรุปกล่อง (ทรัพย์สินสหกรณ์)</h3>${table(["ชนิด", "สถานะ", "#จำนวน"], sum.map((s) => `<tr><td>${esc(s.box_type)}</td><td>${st(s.status)}</td><td class="num">${s.n}</td></tr>`))}</div>
      <div class="mh-card"><h3>ลงทะเบียนกล่องใหม่ + พิมพ์ QR</h3>
        <form data-form="bulkBoxes" class="mh-form">
          <div><label>ชนิด</label><select name="box_type_id">${opt(types, "box_type_id", (t) => `${t.name} (ราคาชดใช้ ${baht(t.replacement_price)})`)}</select></div>
          <div><label>จำนวน</label><input name="count" type="number" min="1" max="2000" required></div>
          <div><label>อักษรนำหน้า</label><input name="prefix" value="BX" maxlength="6"></div>
          <div><button class="mh-btn">ลงทะเบียน</button></div></form>
        <div id="newCodes"></div></div>
      <div class="mh-card"><h3>ค้นหากล่องด้วย QR</h3>
        <form data-form="findBox" class="mh-form"><div><label>รหัส QR</label><input name="qr" required></div><div><button class="mh-btn ghost">ค้นหา</button></div></form>
        <div id="boxInfo"></div></div>
      <div class="mh-card"><h3>รับกล่องคืน</h3>
        <form data-form="returnBoxes" class="mh-form">
          <div class="full"><label>รหัส QR (บรรทัดละ 1 กล่อง — สแกนต่อกันได้)</label><textarea name="qrs" rows="4"></textarea></div>
          <div><label>ผลการคืน</label><select name="outcome"><option value="Returned">คืนปกติ</option><option value="Broken">แตกหัก (หักบัญชีสมาชิก)</option><option value="Lost">สูญหาย (หักบัญชีสมาชิก)</option></select></div>
          <div><button class="mh-btn">บันทึกการคืน</button></div></form>
        <p class="mh-note">กล่องสูญหาย/แตกหัก สมาชิกรับผิดชอบตามราคาที่ตั้งไว้ในหน้า "ตั้งค่า" และหักในรอบจ่ายเงิน</p></div>
      <details class="mh-card"><summary>รายการกล่องทั้งหมด (${list.length})</summary>${table(["QR", "ชนิด", "สถานะ", "รุ่น", "สมาชิก", ""], list.map((b) => `<tr>
        <td>${esc(b.qr_code)}</td><td>${esc(b.box_type)}</td><td>${st(b.status)}</td><td>${esc(b.batch_code || "")}</td><td>${esc(b.member_name || "")}</td>
        <td>${b.status === "Available" || b.status === "Broken" ? `<button class="mh-btn sm ghost" data-act="retireBox" data-id="${b.box_id}">ปลดระวาง</button>` : ""}
          ${["Lost", "Broken"].includes(b.status) ? `<button class="mh-btn sm ghost" data-act="restoreBox" data-id="${b.box_id}">ได้คืน/ซ่อมแล้ว</button>` : ""}</td></tr>`))}</details>`;
  };

  function printQr(codes, typeName) {
    const w = window.open("", "_blank");
    if (!w) { toast("เบราว์เซอร์บล็อกหน้าต่างใหม่", true); return; }
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>QR กล่องเพาะ</title><style>body{font-family:sans-serif}
      .g{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.c{border:1px dashed #999;padding:8px;text-align:center;font-size:11px;page-break-inside:avoid}.q{display:inline-block}</style></head>
      <body><p>${esc(typeName)} — ${codes.length} กล่อง</p><div class="g">${codes.map((c, i) => `<div class="c"><div class="q" id="q${i}"></div><div>${esc(c)}</div></div>`).join("")}</div>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
      <script>var codes=${JSON.stringify(codes)};window.onload=function(){codes.forEach(function(c,i){new QRCode(document.getElementById('q'+i),{text:c,width:96,height:96});});setTimeout(function(){window.print();},400);};<\/script></body></html>`);
    w.document.close();
  }

  PAGES.farming = async (sec) => {
    const [bookings, issues, batches, members, trips] = await Promise.all([
      API.get("/mushroom/bookings"), API.get("/mushroom/issues"), API.get("/mushroom/batches"), load("members", "/mushroom/members"), API.get("/mushroom/trips")]);
    const ready = batches.filter((b) => ["Ready", "Distributed", "SpawnRun"].includes(b.status) && b.boxes_in_center > 0);
    const approved = members.filter((m) => m.status === "Approved");
    const openTrips = trips.filter((t) => ["Planned", "InProgress"].includes(t.status));
    sec.innerHTML = `
      <div class="mh-card"><h3>แจกกล่องฝากเลี้ยง</h3>
        ${ready.filter((b) => b.status !== "SpawnRun").length ? `<form data-form="distribute" class="mh-form">
          <div><label>รุ่น (พร้อมแจก)</label><select name="batch_id">${opt(ready.filter((b) => b.status !== "SpawnRun"), "batch_id", (b) => `${b.batch_code} (เหลือ ${b.boxes_in_center} กล่อง)`)}</select></div>
          <div><label>สมาชิก</label><select name="member_id">${opt(approved, "member_id", (m) => `${m.member_code} ${m.full_name} (ถือ ${m.boxes_on_hand}/${m.capacity_boxes || "∞"})`)}</select></div>
          <div><label>จำนวนกล่อง</label><input name="count" type="number" min="1"></div>
          <div><label>หรือสแกน QR (บรรทัดละ 1)</label><textarea name="qrs" rows="1"></textarea></div>
          <div><label>เที่ยวรถ</label><select name="trip_id"><option value="">-</option>${opt(openTrips, "trip_id", (t) => `${d(t.trip_date)} ${t.vehicle || ""}`)}</select></div>
          <div><button class="mh-btn">บันทึกการแจก</button></div></form>` : '<div class="mh-empty">ยังไม่มีรุ่นที่ผ่าน QC พร้อมแจก</div>'}
      </div>
      <div class="mh-card"><h3>การจองกล่องจากสมาชิก</h3>${table(["วันที่ต้องการ", "สมาชิก", "#กล่อง", "สถานะ", "รุ่น", ""], bookings.map((k) => `<tr>
        <td>${d(k.wanted_date)}</td><td>${esc(k.member_code)} ${esc(k.member_name)}</td><td class="num">${k.requested_boxes}</td><td>${st(k.status)}</td><td>${esc(k.batch_code || "-")}</td>
        <td>${k.status === "Requested" ? `<div class="mh-row">${ready.length ? `<select id="kb-${k.booking_id}">${opt(ready, "batch_id", "batch_code")}</select><button class="mh-btn sm" data-act="allocate" data-id="${k.booking_id}">จัดรุ่น</button>` : ""}
          <button class="mh-btn sm danger" data-act="cancelBooking" data-id="${k.booking_id}">ยกเลิก</button></div>` : ""}</td></tr>`))}</div>
      <div class="mh-card"><h3>ปัญหาที่สมาชิกแจ้ง</h3>${table(["วันที่", "สมาชิก", "ปัญหา", "รายละเอียด", "สถานะ", ""], issues.map((i) => `<tr>
        <td>${dt(i.created_at)}</td><td>${esc(i.member_name)}<br><small>${esc(i.phone || "")}</small></td><td>${ISSUE[i.issue_type]}${i.batch_code ? `<br><small>รุ่น ${esc(i.batch_code)}</small>` : ""}</td>
        <td>${esc(i.note || "")}${i.photo_url ? `<br><a href="${esc(i.photo_url)}" target="_blank">ดูรูป</a>` : ""}${i.resolution ? `<br><small>แก้: ${esc(i.resolution)}</small>` : ""}</td><td>${st(i.status)}</td>
        <td>${i.status === "Open" ? `<div class="mh-row"><input id="res-${i.report_id}" placeholder="วิธีแก้" style="width:140px"><button class="mh-btn sm" data-act="resolveIssue" data-id="${i.report_id}">ปิดเรื่อง</button></div>` : ""}</td></tr>`))}</div>`;
  };

  PAGES.harvest = async (sec) => {
    const [prices, harvests, lots, members] = await Promise.all([
      API.get("/mushroom/prices"), API.get(`/mushroom/harvests?from=${today()}`), API.get("/mushroom/lots"), load("members", "/mushroom/members")]);
    const todayP = Object.fromEntries(prices.filter((p) => String(p.price_date).slice(0, 10) === today()).map((p) => [p.grade, p.price_per_kg]));
    const fresh = lots.filter((l) => l.product_type === "fresh" && Number(l.qty_available_kg) > 0);
    sec.innerHTML = `
      <div class="mh-card"><h3>ประกาศราคารับซื้อรายวัน (บาท/กก.)</h3>
        <form data-form="prices" class="mh-form">
          <div><label>วันที่</label><input name="price_date" type="date" value="${today()}"></div>
          ${["A", "B", "C"].map((g) => `<div><label>${GRADE[g]}</label><input name="${g}" type="number" step="0.01" min="0" value="${todayP[g] != null ? Number(todayP[g]) : ""}"></div>`).join("")}
          <div><button class="mh-btn">ประกาศราคา</button></div></form>
        <p class="mh-note">สมาชิกเห็นราคาบนมือถือทันที · จ่ายตามน้ำหนักเห็ดอย่างเดียวตามราคาที่ประกาศของวันรับซื้อ</p></div>
      <div class="mh-card"><h3>รับซื้อเห็ดจากสมาชิก</h3>
        <form data-form="harvest" class="mh-form">
          <div><label>สมาชิก</label><select name="member_id">${opt(members.filter((m) => m.status !== "Pending"), "member_id", (m) => `${m.member_code} ${m.full_name}`)}</select></div>
          <div><label>เกรด</label><select name="grade">${Object.entries(GRADE).map(([k, v]) => `<option value="${k}">${v}${todayP[k] != null ? ` — ${baht(todayP[k])}` : ""}</option>`).join("")}</select></div>
          <div><label>น้ำหนัก (กก.)</label><input name="weight_kg" type="number" step="0.01" min="0" required></div>
          <div><button class="mh-btn">บันทึกรับซื้อ</button></div></form>
        <h3 style="margin-top:16px">รับซื้อวันนี้</h3>${table(["เวลา", "สมาชิก", "เกรด", "#กก.", "#ราคา", "#เป็นเงิน", "#ค่าบริการ", "ล็อต"], harvests.map((h) => `<tr>
          <td>${dt(h.collected_at)}</td><td>${esc(h.member_name)}</td><td>${h.grade}</td><td class="num">${n2(h.weight_kg)}</td><td class="num">${baht(h.price_per_kg)}</td>
          <td class="num">${baht(h.amount)}</td><td class="num">${baht(h.fee_amount)}</td><td>${esc(h.lot_code || "-")}</td></tr>`))}
      </div>
      <div class="mh-card"><h3>จัดล็อตสินค้า / แปรรูป</h3>
        <form data-form="freshLot" class="mh-form">
          <div><label>รวมรับซื้อของวันที่</label><input name="from_date" type="date" value="${today()}"></div>
          <div><label>เกรด</label><select name="grade"><option value="">ทุกเกรด</option>${Object.entries(GRADE).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
          <div><label>ที่เก็บ</label><input name="storage_location" placeholder="เช่น ห้องเย็น 1"></div>
          <div><button class="mh-btn ghost">สร้างล็อตเห็ดสด</button></div></form>
        <form data-form="processLot" class="mh-form" style="margin-top:12px">
          <div><label>แปรรูปเป็น</label><select name="product_type"><option value="blanched_frozen">ลวกแช่แข็ง</option><option value="soy_pickled">ดองซีอิ๊ว</option><option value="canned">บรรจุกระป๋อง</option></select></div>
          <div><label>จากล็อตเห็ดสด</label><select name="source_lot_id">${opt(fresh, "lot_id", (l) => `${l.lot_code} (${n2(l.qty_available_kg)} กก.)`)}</select></div>
          <div><label>ใช้เห็ดสด (กก.)</label><input name="input_fresh_kg" type="number" step="0.01" min="0"></div>
          <div><label>ได้ผลิตภัณฑ์ (กก.)</label><input name="qty_kg" type="number" step="0.01" min="0"></div>
          <div><label>หมดอายุ</label><input name="expires_on" type="date"></div>
          <div><button class="mh-btn ghost">บันทึกการแปรรูป</button></div></form>
        <h3 style="margin-top:16px">ล็อตสินค้า</h3>${table(["ล็อต", "สินค้า", "เกรด", "#ผลิต (กก.)", "#คงเหลือ", "วันผลิต", "หมดอายุ", "ที่เก็บ"], lots.map((l) => `<tr>
          <td>${esc(l.lot_code)}</td><td>${PROD[l.product_type]}</td><td>${esc(l.grade || "-")}</td><td class="num">${n2(l.qty_kg)}</td><td class="num">${n2(l.qty_available_kg)}</td>
          <td>${d(l.produced_on)}</td><td>${d(l.expires_on)}</td><td>${esc(l.storage_location || "")}</td></tr>`))}
        <p class="mh-note">อ.อานนท์แนะนำ: เห็ดสดเก็บข้ามคืนได้ยาก ลวกแช่แข็งเก็บได้ราว 1 ปี หรือดองซีอิ๊ว ช่วยรองรับผลผลิตส่วนเกิน</p></div>`;
  };

  PAGES.market = async (sec) => {
    const [orders, partners, f] = await Promise.all([API.get("/mushroom/sales-orders"), load("partners", "/mushroom/partners"), API.get("/mushroom/forecast")]);
    const buyers = partners.filter((p) => p.active && p.partner_type === "buyer");
    sec.innerHTML = `
      <div class="mh-card"><h3>สต็อกพร้อมขาย และงานที่รับไว้</h3>
        ${table(["สินค้า", "เกรด", "#พร้อมขาย (กก.)"], f.stock_available.map((s) => `<tr><td>${PROD[s.product_type]}</td><td>${esc(s.grade || "-")}</td><td class="num">${n2(s.kg)}</td></tr>`))}
        <p class="mh-note">คำสั่งซื้อที่ยังไม่ส่ง: ${f.open_order_commitments.map((c) => `${PROD[c.product_type]} ${n2(c.kg)} กก.`).join(", ") || "-"} · คาดว่าจะเก็บเห็ดได้อีก ${f.expected_remaining_kg == null ? "- (ยังไม่มีประวัติ)" : n2(f.expected_remaining_kg) + " กก."}</p></div>
      <details class="mh-card"><summary>➕ บันทึกคำสั่งซื้อ / สัญญาซื้อขาย</summary>
        ${buyers.length ? `<form data-form="order" class="mh-form" style="margin-top:12px">
          <div><label>ผู้ซื้อ</label><select name="partner_id">${opt(buyers, "partner_id", "name")}</select></div>
          <div><label>ประเภท</label><select name="order_kind"><option value="spot">ครั้งเดียว</option><option value="contract">สัญญาล่วงหน้า</option></select></div>
          <div><label>สินค้า</label><select name="product_type">${Object.entries(PROD).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
          <div><label>เกรด</label><select name="grade"><option value="">-</option>${Object.entries(GRADE).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
          <div><label>กก.</label><input name="qty_kg" type="number" step="0.01" min="0" required></div>
          <div><label>ราคา/กก.</label><input name="price_per_kg" type="number" step="0.01" min="0" required></div>
          <div><label>ส่งวันที่</label><input name="deliver_on" type="date"></div>
          <div><label>สิ้นสุดสัญญา</label><input name="contract_end" type="date"></div>
          <div><button class="mh-btn">บันทึก</button></div></form>` : '<div class="mh-empty" style="margin-top:10px">เพิ่มคู่ค้าประเภทผู้ซื้อก่อน</div>'}</details>
      <div class="mh-card"><h3>คำสั่งซื้อ</h3>${table(["วันที่", "ผู้ซื้อ", "สินค้า", "#กก.", "#ราคา", "#ยอด", "#ค่าบริการ (สหกรณ์จ่าย)", "สถานะ", ""], orders.map((o) => `<tr>
        <td>${d(o.created_at)}<br><small>${o.created_by === "buyer" ? "ผู้ซื้อส่งคำขอ" : "สหกรณ์บันทึก"}${o.order_kind === "contract" ? " · สัญญา" : ""}</small></td>
        <td>${esc(o.buyer_name)}</td><td>${PROD[o.product_type]} ${esc(o.grade || "")}<br><small>ส่ง ${d(o.deliver_on)}</small></td><td class="num">${n2(o.qty_kg)}</td>
        <td class="num">${baht(o.price_per_kg)}</td><td class="num">${baht(o.amount)}</td><td class="num">${["Delivered", "Paid"].includes(o.status) ? baht(o.fee_amount) : "-"}</td>
        <td>${st(o.status)}${o.invoice_no ? `<br><small>${esc(o.invoice_no)}</small>` : ""}</td>
        <td><div class="mh-row">${o.status === "Requested" ? `<button class="mh-btn sm" data-act="orderAct" data-act2="confirm" data-id="${o.order_id}">ยืนยัน</button>` : ""}
          ${o.status === "Confirmed" ? `<button class="mh-btn sm" data-act="orderAct" data-act2="deliver" data-id="${o.order_id}">ส่งมอบ (ตัดสต็อก FIFO)</button>` : ""}
          ${o.status === "Delivered" ? `<button class="mh-btn sm ghost" data-act="orderAct" data-act2="paid" data-id="${o.order_id}">รับเงินแล้ว</button>` : ""}
          ${["Requested", "Confirmed"].includes(o.status) ? `<button class="mh-btn sm danger" data-act="orderAct" data-act2="cancel" data-id="${o.order_id}">ยกเลิก</button>` : ""}</div></td></tr>`))}</div>`;
  };

  PAGES.trips = async (sec) => {
    const [trips, partners] = await Promise.all([API.get("/mushroom/trips"), load("partners", "/mushroom/partners")]);
    const trans = partners.filter((p) => p.active && p.partner_type === "transporter");
    sec.innerHTML = `
      <div class="mh-card"><h3>วางแผนเที่ยวรถ (ส่งกล่อง + รับเห็ด + รับฟาง ในรอบเดียว)</h3>
        <form data-form="suggest" class="mh-form"><div><label>วันที่</label><input name="date" type="date" value="${today()}"></div><div><button class="mh-btn ghost">ดึงจุดแวะที่ควรไป</button></div></form>
        <div id="tripPlan"></div></div>
      <div class="mh-card"><h3>เที่ยวรถ</h3>${table(["วันที่", "รถ/คนขับ", "ผู้ขนส่ง", "#จุดแวะ", "สถานะ", "#ระยะ/ค่าใช้จ่าย", ""], trips.map((t) => `<tr>
        <td>${d(t.trip_date)}</td><td>${esc(t.vehicle || "")} ${esc(t.driver_name || "")}</td><td>${esc(t.transporter_name || "รถสหกรณ์")}</td>
        <td class="num">${t.stops_done}/${t.stops}</td><td>${st(t.status)}</td><td class="num">${t.distance_km != null ? n2(t.distance_km) + " กม." : ""} ${Number(t.cost) ? baht(t.cost) : ""}</td>
        <td><button class="mh-btn sm ghost" data-act="tripDetail" data-id="${t.trip_id}">เปิด</button></td></tr><tr id="td-${t.trip_id}" hidden><td colspan="7"></td></tr>`))}</div>`;
    cache.trans = trans;
  };

  PAGES.finance = async (sec) => {
    const [runs, ledger, fees, members] = await Promise.all([
      API.get("/mushroom/settlements"), API.get("/mushroom/ledger?unsettled=1"), API.get("/mushroom/fees"), load("members", "/mushroom/members")]);
    const net = ledger.reduce((s, l) => s + Number(l.amount), 0);
    sec.innerHTML = `
      <div class="mh-card"><h3>รอบหักกลบรายสัปดาห์ (ผ่าน ธ.ก.ส.)</h3>
        <form data-form="newRun" class="mh-form"><div><label>ตัดยอดถึงวันที่</label><input name="period_end" type="date" value="${today()}"></div>
          <div><button class="mh-btn">สร้างรอบหักกลบ</button></div></form>
        <p class="mh-note">รวมค่าฟาง + ค่าเห็ด หักค่าบริการส่วนที่สมาชิกเป็นผู้ขาย และค่ากล่องหาย/แตก · สมาชิกที่ยอดสุทธิติดลบจะยกไปรอบถัดไป · ส่งไฟล์โอนให้ ธ.ก.ส. แล้วกด "จ่ายแล้ว"</p>
        ${table(["ช่วง", "#สมาชิก", "#ยอดสุทธิ", "สถานะ", "อ้างอิง ธ.ก.ส.", ""], runs.map((r) => `<tr>
          <td>${d(r.period_start)} – ${d(r.period_end)}</td><td class="num">${r.member_count}</td><td class="num">${baht(r.total_net)}</td><td>${st(r.status)}</td><td>${esc(r.baac_batch_ref || "-")}</td>
          <td><div class="mh-row"><button class="mh-btn sm ghost" data-act="runDetail" data-id="${r.run_id}">รายละเอียด</button>
            ${r.status === "Draft" ? `<button class="mh-btn sm" data-act="runAct" data-act2="submit" data-id="${r.run_id}">ส่ง ธ.ก.ส.</button>` : ""}
            ${["Submitted", "Paid"].includes(r.status) ? `<button class="mh-btn sm ghost" data-act="runExport" data-id="${r.run_id}" data-ref="${esc(r.baac_batch_ref)}">ไฟล์โอน CSV</button>` : ""}
            ${r.status === "Submitted" ? `<button class="mh-btn sm" data-act="runAct" data-act2="paid" data-id="${r.run_id}">จ่ายแล้ว</button>` : ""}
            ${["Draft", "Submitted"].includes(r.status) ? `<button class="mh-btn sm danger" data-act="runAct" data-act2="cancel" data-id="${r.run_id}">ยกเลิกรอบ</button>` : ""}</div></td></tr>
          <tr id="rd-${r.run_id}" hidden><td colspan="6"></td></tr>`))}</div>
      <div class="mh-card"><h3>รายการที่ยังไม่เข้ารอบ (สุทธิ ${baht(net)} บาท)</h3>${table(["วันที่", "สมาชิก", "รายการ", "#จำนวนเงิน", "หมายเหตุ"], ledger.map((l) => `<tr>
        <td>${d(l.entry_date)}</td><td>${esc(l.member_code)} ${esc(l.member_name)}</td><td>${LEDGER[l.entry_type]}</td>
        <td class="num" style="color:${Number(l.amount) < 0 ? "var(--red-600)" : "inherit"}">${baht(l.amount)}</td><td><small>${esc(l.note || "")}</small></td></tr>`))}
        <details style="margin-top:12px"><summary>ปรับปรุงบัญชีสมาชิก</summary>
          <form data-form="ledgerAdjust" class="mh-form" style="margin-top:10px">
            <div><label>สมาชิก</label><select name="member_id">${opt(members, "member_id", (m) => `${m.member_code} ${m.full_name}`)}</select></div>
            <div><label>จำนวนเงิน (+เพิ่ม / −หัก)</label><input name="amount" type="number" step="0.01" required></div>
            <div class="full"><label>เหตุผล</label><input name="note" required></div><div><button class="mh-btn ghost">บันทึก</button></div></form></details></div>
      <div class="mh-card"><h3>ค่าบริการ AgroLink (ผู้ขายเป็นผู้จ่าย)</h3>${table(["ประเภท", "ผู้จ่าย", "#รายการ", "#ฐาน", "#ค่าบริการ"], fees.map((f) => `<tr>
        <td>${FEE[f.fee_type]}</td><td>${{ partner: "ผู้ขายวัสดุ/เชื้อ", member: "สมาชิก", coop: "สหกรณ์" }[f.payer_type]}</td><td class="num">${f.n}</td><td class="num">${baht(f.base)}</td><td class="num">${baht(f.fee)}</td></tr>`))}</div>`;
  };

  PAGES.iot = async (sec) => {
    const [devices, alerts, members] = await Promise.all([API.get("/mushroom/iot/devices"), API.get("/mushroom/iot/alerts"), load("members", "/mushroom/members")]);
    sec.innerHTML = `
      <div class="mh-card"><h3>อุปกรณ์</h3>${table(["ชื่อ", "ที่ตั้ง", "ค่าล่าสุด", "เกณฑ์", "สถานะ", ""], devices.map((v) => {
    const off = !v.last_seen_at || Date.now() - new Date(v.last_seen_at).getTime() > 30 * 60e3;
    return `<tr><td>${esc(v.name)}</td><td>${LOC[v.location_type]}${v.member_name ? `<br><small>${esc(v.member_name)}</small>` : ""}</td>
        <td>${v.last_reading ? `${n2(v.last_reading.temp_c)}°C · ${n2(v.last_reading.rh_pct)}%<br><small>${dt(v.last_reading.recorded_at)}</small>` : "-"}</td>
        <td><small>${v.temp_min != null ? n2(v.temp_min) : "-"}–${v.temp_max != null ? n2(v.temp_max) : "-"}°C · RH ${v.rh_min != null ? n2(v.rh_min) : "-"}–${v.rh_max != null ? n2(v.rh_max) : "-"}%${v.auto_mist ? " · พ่นหมอกอัตโนมัติ" : ""}</small></td>
        <td>${off ? pill("ออฟไลน์", "bad") : pill("ออนไลน์", "ok")} ${v.open_alerts ? pill(v.open_alerts + " แจ้งเตือน", "warn") : ""}</td>
        <td><div class="mh-row"><button class="mh-btn sm ghost" data-act="readings" data-id="${v.device_id}">กราฟ 24 ชม.</button>
          <button class="mh-btn sm ghost" data-act="mist" data-cmd="mist_on" data-id="${v.device_id}">พ่นหมอก</button><button class="mh-btn sm ghost" data-act="mist" data-cmd="mist_off" data-id="${v.device_id}">หยุด</button></div></td></tr>
        <tr id="rv-${v.device_id}" hidden><td colspan="6"></td></tr>`;
  }))}</div>
      <details class="mh-card"><summary>➕ เพิ่มอุปกรณ์</summary>
        <form data-form="device" class="mh-form" style="margin-top:12px">
          <div><label>ชื่อ</label><input name="name" required></div>
          <div><label>ที่ตั้ง</label><select name="location_type">${Object.entries(LOC).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
          <div><label>สมาชิก (ถ้าติดที่จุดเปิดดอก)</label><select name="member_id"><option value="">-</option>${opt(members, "member_id", "full_name")}</select></div>
          <div><label>อุณหภูมิต่ำสุด</label><input name="temp_min" type="number" step="0.1"></div><div><label>อุณหภูมิสูงสุด</label><input name="temp_max" type="number" step="0.1"></div>
          <div><label>ความชื้นต่ำสุด</label><input name="rh_min" type="number" step="0.1"></div><div><label>ความชื้นสูงสุด</label><input name="rh_max" type="number" step="0.1"></div>
          <div><label><input type="checkbox" name="auto_mist"> พ่นหมอกอัตโนมัติเมื่อความชื้นต่ำ</label></div>
          <div><button class="mh-btn">สร้างอุปกรณ์</button></div></form>
        <div id="newKey"></div>
        <p class="mh-note">อุปกรณ์ส่งค่า: POST /mushroom-iot/readings พร้อม header X-Device-Key · ดึงคำสั่งพ่นหมอก: GET /mushroom-iot/commands · ห้องบ่มใช้เกณฑ์ ${"32–36"}°C ตามค่าตั้งต้นของสหกรณ์ถ้าไม่ระบุ</p></details>
      <div class="mh-card"><h3>แจ้งเตือน</h3>${table(["เวลา", "อุปกรณ์", "ข้อความ", ""], alerts.map((a) => `<tr>
        <td>${dt(a.created_at)}</td><td>${esc(a.device_name)}</td><td>${esc(a.message)}</td>
        <td>${a.acknowledged_at ? pill("รับทราบแล้ว", "ok") : `<button class="mh-btn sm" data-act="ackAlert" data-id="${a.alert_id}">รับทราบ</button>`}</td></tr>`))}</div>`;
  };

  PAGES.reports = async (sec) => {
    const from = cache.repFrom || new Date(Date.now() + 7 * 3600e3 - 29 * 86400e3).toISOString().slice(0, 10);
    const to = cache.repTo || today();
    const r = await API.get(`/mushroom/reports/summary?from=${from}&to=${to}`);
    const t = r.totals;
    const grp = (rows, key, label) => table([label, "#รุ่น", "#กล่องที่แจก", "#เห็ด (กก.)", "#กก./กล่อง", "#ต้นทุน/กล่อง"], rows.map((g) => `<tr>
      <td>${esc(g[key])}</td><td class="num">${g.batches}</td><td class="num">${g.boxes_distributed}</td><td class="num">${n2(g.harvest_kg)}</td><td class="num">${n2(g.kg_per_box)}</td><td class="num">${baht(g.cost_per_box)}</td></tr>`));
    sec.innerHTML = `
      <div class="mh-card"><form data-form="report" class="mh-form"><div><label>ตั้งแต่</label><input name="from" type="date" value="${from}"></div>
        <div><label>ถึง</label><input name="to" type="date" value="${to}"></div><div><button class="mh-btn ghost">แสดงรายงาน</button></div></form></div>
      <div class="mh-grid">
        <div class="mh-stat"><small>ฟางจากสมาชิก (ไม่ถูกเผา)</small><b>${n2(t.straw_not_burned_ton)}</b> <small>ตัน</small></div>
        <div class="mh-stat"><small>เศษวัสดุชีวมวลเข้าศูนย์</small><b>${n2(Number(t.biomass_in_kg) / 1000)}</b> <small>ตัน</small></div>
        <div class="mh-stat"><small>วัสดุเพาะเก่า → ปุ๋ยหมัก</small><b>${n2(Number(t.spent_substrate_kg) / 1000)}</b> <small>ตัน</small></div>
        <div class="mh-stat"><small>รับซื้อเห็ด</small><b>${n2(t.harvest_kg)}</b> <small>กก. · จ่ายสมาชิก ${baht(t.paid_to_members)}</small></div>
        <div class="mh-stat"><small>ขายให้ผู้ซื้อ</small><b>${baht(t.sales_amount)}</b> <small>บาท</small></div>
        <div class="mh-stat"><small>สัดส่วนผลผลิตที่มีผู้ซื้อรองรับ</small><b>${t.presold_share_pct == null ? "-" : n2(t.presold_share_pct) + "%"}</b>${t.presold_share_pct > 100 ? " <small>คำสั่งซื้อมากกว่าผลผลิต</small>" : ""}</div>
        <div class="mh-stat"><small>ค่าขนส่ง</small><b>${baht(t.transport_cost)}</b></div>
      </div>
      <div class="mh-card" style="margin-top:16px"><h3>ต้นทุนและผลผลิตรายรุ่น</h3>${table(["รุ่น", "สถานะ", "สูตร", "เชื้อ", "#กล่อง", "#อัตราเสีย", "#ต้นทุน/กล่อง", "#กก./กล่อง", "#เห็ด (กก.)"], r.batches.map((b) => `<tr>
        <td>${esc(b.batch_code)}</td><td>${st(b.status)}</td><td>${esc(b.recipe_name)}</td><td>${esc(b.spawn_lot_no || "-")}</td><td class="num">${b.boxes_planned}</td>
        <td class="num">${n2(b.loss_rate_pct)}%</td><td class="num">${baht(b.cost_per_box)}</td><td class="num">${n2(b.kg_per_box)}</td><td class="num">${n2(b.harvest_kg)}</td></tr>`))}</div>
      <div class="mh-card"><h3>เปรียบเทียบตามสูตรวัสดุ</h3>${grp(r.by_recipe, "recipe_name", "สูตร")}</div>
      <div class="mh-card"><h3>เปรียบเทียบตามล็อตเชื้อ</h3>${grp(r.by_spawn_lot, "spawn_lot_no", "ล็อตเชื้อ")}</div>
      <div class="mh-card"><h3>รายได้สุทธิสมาชิก</h3>${table(["สมาชิก", "#กล่องที่รับ", "#เห็ด (กก.)", "#กก./กล่อง", "#กล่องหาย/แตก", "#รายได้สุทธิ"], r.members.map((m) => `<tr>
        <td>${esc(m.member_code)} ${esc(m.full_name)}</td><td class="num">${m.boxes_received}</td><td class="num">${n2(m.harvest_kg)}</td><td class="num">${n2(m.kg_per_box)}</td>
        <td class="num">${m.boxes_lost_broken}</td><td class="num">${baht(m.net_income)}</td></tr>`))}</div>
      <div class="mh-card"><h3>ค่าบริการ AgroLink ในช่วงนี้</h3>${table(["ประเภท", "#ค่าบริการ"], r.fees.map((f) => `<tr><td>${FEE[f.fee_type]}</td><td class="num">${baht(f.fee)}</td></tr>`))}</div>`;
  };

  PAGES.settings = async (sec) => {
    const s = await API.get("/mushroom/settings");
    const v = s.settings;
    const F = (name, label, step = "0.01", extra = "") => `<div><label>${label}</label><input name="${name}" type="number" step="${step}" value="${Number(v[name])}" ${extra}></div>`;
    const days = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
    sec.innerHTML = `
      <div class="mh-card"><h3>อัตราค่าบริการ AgroLink (% — ผู้ขายเป็นผู้จ่าย)</h3>
        <form data-form="settings" class="mh-form">
          ${F("fee_rate_spawn_pct", "ซื้อเชื้อเห็ด (ผู้ขายเชื้อจ่าย)", "0.001", 'min="0" max="100"')}
          ${F("fee_rate_substrate_pct", "ซื้อวัสดุเพาะ (ผู้ขายวัสดุจ่าย)", "0.001", 'min="0" max="100"')}
          ${F("fee_rate_member_sale_pct", "สมาชิกขายเห็ดให้สหกรณ์ (สมาชิกจ่าย)", "0.001", 'min="0" max="100"')}
          ${F("fee_rate_external_sale_pct", "สหกรณ์ขายให้ผู้ซื้อภายนอก (สหกรณ์จ่าย)", "0.001", 'min="0" max="100"')}
          ${F("straw_price_per_kg", "ราคารับซื้อฟางจากสมาชิก (บาท/กก.)")}
          <div><label>วันตัดรอบจ่ายเงินประจำสัปดาห์</label><select name="settlement_weekday">${days.map((x, i) => `<option value="${i}"${i === Number(v.settlement_weekday) ? " selected" : ""}>${x}</option>`).join("")}</select></div>
          ${F("spawn_run_temp_min", "อุณหภูมิบ่มเส้นใยต่ำสุด (°C)", "0.1")}${F("spawn_run_temp_max", "อุณหภูมิบ่มเส้นใยสูงสุด (°C)", "0.1")}
          ${F("spawn_run_days", "จำนวนวันบ่มเส้นใย", "1")}${F("max_delivery_km", "ระยะส่งกล่องสูงสุด (กม.)", "1")}
          <div><button class="mh-btn">บันทึกการตั้งค่า</button></div></form></div>
      <div class="mh-card"><h3>ราคากล่อง (ใช้คิดเมื่อสมาชิกทำกล่องหาย/แตกหัก)</h3>
        ${table(["ชนิดกล่อง", "#ราคาชดใช้ (บาท)", ""], s.box_types.map((t) => `<tr><td>${esc(t.name)}</td>
          <td class="num"><input type="number" step="0.01" min="0" value="${Number(t.replacement_price)}" data-bprice="${t.box_type_id}" style="width:110px"></td>
          <td><button class="mh-btn sm" data-act="saveBoxPrice" data-id="${t.box_type_id}">บันทึก</button></td></tr>`))}
        <form data-form="boxType" class="mh-form" style="margin-top:12px"><div><label>ชนิดกล่องใหม่</label><input name="name" required></div>
          <div><label>ราคาชดใช้</label><input name="replacement_price" type="number" step="0.01" min="0" value="0"></div><div><button class="mh-btn ghost">เพิ่ม</button></div></form></div>
      <div class="mh-card"><h3>ประวัติการแก้ไข</h3>${table(["เวลา", "รายการ", "ค่าเดิม", "ค่าใหม่", "โดย"], s.history.map((h) => `<tr>
        <td>${dt(h.changed_at)}</td><td>${esc(h.field_name)}</td><td>${esc(h.old_value || "-")}</td><td>${esc(h.new_value)}</td><td><small>${esc(h.changed_by || "")}</small></td></tr>`))}</div>`;
  };

  // ---------- actions ----------
  const ACT = {
    go: (el) => show(el.dataset.tab),
    memberStatus: async (el) => { if (await run(() => API.post(`/mushroom/members/${el.dataset.id}/status`, { status: el.dataset.status }), "บันทึกสถานะแล้ว")) refresh(); },
    editMember: (el) => {
      const m = cache.members.find((x) => x.member_id === el.dataset.id);
      const row = $(`#edit-${m.member_id}`);
      row.hidden = !row.hidden;
      row.firstElementChild.innerHTML = `<form data-form="editMember" data-id="${m.member_id}" class="mh-form">
        <div><label>ชื่อ</label><input name="full_name" value="${esc(m.full_name)}"></div><div><label>โทร</label><input name="phone" value="${esc(m.phone || "")}"></div>
        <div><label>ความจุ (กล่อง)</label><input name="capacity_boxes" type="number" min="0" value="${m.capacity_boxes}"></div>
        <div><label>ระยะทาง (กม.)</label><input name="distance_km" type="number" step="0.1" value="${m.distance_km != null ? Number(m.distance_km) : ""}"></div>
        <div class="full"><label>ที่อยู่</label><input name="address" value="${esc(m.address || "")}"></div>
        <div><label>เลขบัญชี ธ.ก.ส.</label><input name="baac_account_no" value="${esc(m.baac_account_no || "")}"></div><div><label>ชื่อบัญชี</label><input name="baac_account_name" value="${esc(m.baac_account_name || "")}"></div>
        <div><label><input type="checkbox" name="wind_protected"${m.wind_protected ? " checked" : ""}> กันลมได้</label><label><input type="checkbox" name="water_available"${m.water_available ? " checked" : ""}> มีน้ำ</label>
          <label><input type="checkbox" name="consent_finance_share"${m.consent_finance_share ? " checked" : ""}> ยินยอมให้แบ่งปันข้อมูลกับสถาบันการเงิน</label></div>
        <div><button class="mh-btn">บันทึก</button></div></form>`;
    },
    findOrg: async (el) => {
      const form = el.closest("form");
      const rows = await run(() => API.get(`/mushroom/linkable-orgs?q=${encodeURIComponent(form.org_q.value)}`));
      if (rows) form.linked_org_id.innerHTML = '<option value="">— ไม่ผูก —</option>' + opt(rows, "org_id", (o) => `${o.org_name} (${o.org_type})`);
      if (rows && !rows.length) toast("ไม่พบองค์กรที่ยืนยันตัวตนแล้วชื่อนี้", true);
    },
    togglePartner: async (el) => { if (await run(() => API.put(`/mushroom/partners/${el.dataset.id}`, { active: el.dataset.active !== "true" }))) refresh(); },
    saveReorder: async (el) => { await run(() => API.put(`/mushroom/materials/${el.dataset.id}`, { reorder_level_kg: $(`[data-reorder="${el.dataset.id}"]`).value || 0 }), "บันทึกจุดสั่งซื้อแล้ว"); },
    addPoLine: () => addPoLine(),
    poDeliver: async (el) => {
      let body = {};
      if (el.dataset.type === "spawn") {
        const lines = JSON.parse(el.dataset.lines);
        const missing = lines.filter((l) => !l[2]);
        if (missing.length) {
          const lotNo = window.prompt(`เลขล็อตเชื้อสำหรับ "${missing[0][1]}" (ผู้ขายยังไม่ได้แจ้ง)`);
          if (!lotNo) return;
          body = { spawn_lots: missing.map((l) => ({ line_id: l[0], lot_no: lotNo })) };
        }
      }
      if (await run(() => API.post(`/mushroom/purchase-orders/${el.dataset.id}/deliver`, body), "รับของเข้าคลังแล้ว")) refresh();
    },
    poCancel: async (el) => { if (await run(() => API.post(`/mushroom/purchase-orders/${el.dataset.id}/cancel`, {}), "ยกเลิกแล้ว")) refresh(); },
    poPaid: async (el) => { if (await run(() => API.post(`/mushroom/purchase-orders/${el.dataset.id}/paid`, {}), "บันทึกการจ่ายแล้ว")) refresh(); },
    batchDetail: async (el) => {
      const row = $(`#bd-${el.dataset.id}`);
      row.hidden = !row.hidden;
      if (row.hidden) return;
      const b = await run(() => API.get(`/mushroom/batches/${el.dataset.id}`));
      if (!b) return;
      row.firstElementChild.innerHTML = `<div class="mh-grid"><div><b>บันทึกขั้นตอน</b><br>${b.events.map((e) => `${dt(e.at)} · ${EVENT[e.event_type] || esc(e.event_type)}${e.temp_c != null ? ` ${n2(e.temp_c)}°C` : ""}${e.hours != null ? ` ${n2(e.hours)} ชม.` : ""} ${esc(e.note || "")}`).join("<br>")}</div>
        <div><b>ต้นทุน</b><br>${b.costs.map((x) => `${COST[x.cost_type] || esc(x.cost_type)} ${baht(x.amount)} <small>${esc(x.note || "")}</small>`).join("<br>")}
          <form data-form="batchCost" data-id="${b.batch_id}" class="mh-form" style="margin-top:8px"><div><select name="cost_type"><option value="energy">พลังงาน</option><option value="labor">แรงงาน</option><option value="other">อื่น ๆ</option></select></div>
          <div><input name="amount" type="number" step="0.01" min="0" placeholder="บาท" required></div><div><input name="note" placeholder="หมายเหตุ"></div><div><button class="mh-btn sm">เพิ่มต้นทุน</button></div></form></div>
        <div><b>วัสดุที่ใช้</b><br>${b.materials.map((m) => `${esc(m.name)} ${n2(m.qty_kg)} กก.`).join("<br>")}<br><b>ผลผลิต</b><br>${b.harvest.map((h) => `${h.grade}: ${n2(h.kg)} กก.`).join("<br>") || "-"}</div></div>
        <form data-form="batchNote" data-id="${b.batch_id}" class="mh-form" style="margin-top:8px"><div class="full"><input name="note" placeholder="บันทึก/ผลตรวจ QC"></div><div><input name="temp_c" type="number" step="0.1" placeholder="°C"></div><div><button class="mh-btn sm ghost">บันทึก</button></div></form>
        ${!["Distributed", "Closed", "Failed"].includes(b.status) ? `<button class="mh-btn sm danger" data-act="failBatch" data-id="${b.batch_id}" style="margin-top:8px">แจ้งรุ่นเสียทั้งรุ่น</button>` : ""}`;
    },
    turn: async (el) => { if (await run(() => API.post(`/mushroom/batches/${el.dataset.id}/turn`, {}), "บันทึกการกลับกองแล้ว")) refresh(); },
    pasteurize: async (el) => {
      const r = await run(() => API.post(`/mushroom/batches/${el.dataset.id}/pasteurize`, { temp_c: $(`#pt-${el.dataset.id}`).value, hours: $(`#ph-${el.dataset.id}`).value }));
      if (r) { toast(r.warning ? "บันทึกแล้ว — อุณหภูมิ/เวลาอยู่นอกแนวทาง 65–72°C 4–6 ชม." : "บันทึกการอบไอน้ำแล้ว", !!r.warning); refresh(); }
    },
    spawn: async (el) => { if (await run(() => API.post(`/mushroom/batches/${el.dataset.id}/spawn`, { spawn_lot_id: $(`#sl-${el.dataset.id}`).value }), "ใส่เชื้อแล้ว เริ่มบ่มเส้นใย")) refresh(); },
    ready: async (el) => { if (await run(() => API.post(`/mushroom/batches/${el.dataset.id}/ready`, { boxes_bad: $(`#bad-${el.dataset.id}`).value || 0 }), "ผ่าน QC พร้อมแจกกล่อง")) refresh(); },
    closeBatch: async (el) => { if (await run(() => API.post(`/mushroom/batches/${el.dataset.id}/close`, {}), "ปิดรุ่นแล้ว")) refresh(); },
    failBatch: async (el) => { if (await run(() => API.post(`/mushroom/batches/${el.dataset.id}/fail`, {}), "บันทึกรุ่นเสียแล้ว กล่องกลับเป็นว่าง")) refresh(); },
    toggleRecipe: async (el) => { if (await run(() => API.put(`/mushroom/recipes/${el.dataset.id}`, { active: el.dataset.active !== "true" }))) refresh(); },
    retireBox: async (el) => { if (await run(() => API.post(`/mushroom/boxes/${el.dataset.id}/retire`, {}), "ปลดระวางแล้ว")) refresh(); },
    restoreBox: async (el) => { if (await run(() => API.post(`/mushroom/boxes/${el.dataset.id}/restore`, {}), "กล่องกลับเป็นว่าง")) refresh(); },
    printCodes: () => printQr(cache.newCodes.qr_codes, cache.newCodes.box_type),
    allocate: async (el) => { if (await run(() => API.post(`/mushroom/bookings/${el.dataset.id}/allocate`, { batch_id: $(`#kb-${el.dataset.id}`).value }), "จัดรุ่นแล้ว")) refresh(); },
    cancelBooking: async (el) => { if (await run(() => API.post(`/mushroom/bookings/${el.dataset.id}/cancel`, {}), "ยกเลิกการจองแล้ว")) refresh(); },
    resolveIssue: async (el) => { if (await run(() => API.post(`/mushroom/issues/${el.dataset.id}/resolve`, { resolution: $(`#res-${el.dataset.id}`).value }), "ปิดเรื่องแล้ว")) refresh(); },
    orderAct: async (el) => {
      const msg = { confirm: "ยืนยันคำสั่งซื้อแล้ว", deliver: "ส่งมอบและออกใบกำกับแล้ว", paid: "บันทึกรับเงินแล้ว", cancel: "ยกเลิกแล้ว" }[el.dataset.act2];
      if (await run(() => API.post(`/mushroom/sales-orders/${el.dataset.id}/${el.dataset.act2}`, {}), msg)) refresh();
    },
    tripDetail: async (el) => {
      const row = $(`#td-${el.dataset.id}`);
      row.hidden = !row.hidden;
      if (row.hidden) return;
      const [t, batches] = await Promise.all([API.get(`/mushroom/trips/${el.dataset.id}`), API.get("/mushroom/batches")]);
      const ready = batches.filter((b) => ["Ready", "Distributed"].includes(b.status) && b.boxes_in_center > 0);
      const open = ["Planned", "InProgress"].includes(t.status);
      row.firstElementChild.innerHTML = `${t.stops.map((s) => `<div class="mh-card" style="box-shadow:none;border:1px solid var(--gray-100)">
        <b>${s.seq}. ${esc(s.full_name)}</b> ${st(s.status)} <small>${esc(s.phone || "")} · ${esc(s.address || "")} · ถือกล่อง ${s.boxes_on_hand}</small>
        <div><small>ส่งกล่อง ${s.drop_boxes} · ${s.collect_mushroom ? "รับเห็ด" : ""} ${s.collect_straw ? "· รับฟาง" : ""}</small></div>
        ${open && s.status === "Pending" ? `<form data-form="stopDone" data-trip="${t.trip_id}" data-stop="${s.stop_id}" class="mh-form" style="margin-top:8px">
          ${s.drop_boxes ? `<div><label>รุ่นที่แจก</label><select name="batch_id">${opt(ready, "batch_id", (b) => `${b.batch_code} (เหลือ ${b.boxes_in_center})`)}</select></div><div><label>จำนวนกล่อง</label><input name="drop_count" type="number" min="0" value="${s.drop_boxes}"></div>` : ""}
          ${["A", "B", "C"].map((g) => `<div><label>เห็ด ${GRADE[g]} (กก.)</label><input name="kg_${g}" type="number" step="0.01" min="0"></div>`).join("")}
          <div><label>ฟาง (กก.)</label><input name="straw_kg" type="number" step="0.01" min="0"></div>
          <div class="full"><label>กล่องคืน (QR บรรทัดละ 1)</label><textarea name="returns" rows="1"></textarea></div>
          <div><label><input type="checkbox" name="skipped"> ข้ามจุดนี้</label></div>
          <div><button class="mh-btn">ปิดจุดแวะ</button></div></form>` : ""}</div>`).join("")}
        <div class="mh-row"><span>เห็ดที่รับในเที่ยวนี้: ${n2(t.harvest.kg)} กก.</span>
        ${open ? `<form data-form="tripComplete" data-id="${t.trip_id}" class="mh-row"><input name="distance_km" type="number" step="0.1" placeholder="ระยะทาง กม." style="width:120px"><input name="cost" type="number" step="0.01" placeholder="ค่าใช้จ่าย" style="width:110px"><button class="mh-btn sm">จบเที่ยวรถ</button></form>` : ""}</div>`;
    },
    runDetail: async (el) => {
      const row = $(`#rd-${el.dataset.id}`);
      row.hidden = !row.hidden;
      if (row.hidden) return;
      const r = await run(() => API.get(`/mushroom/settlements/${el.dataset.id}`));
      if (!r) return;
      row.firstElementChild.innerHTML = (r.missing_account ? `<div class="error-box show">สมาชิก ${r.missing_account} รายยังไม่มีเลขบัญชี ธ.ก.ส. — แก้ที่หน้าสมาชิกก่อนส่ง</div>` : "")
        + table(["สมาชิก", "#รับ", "#หัก", "#สุทธิ", "บัญชี ธ.ก.ส."], r.lines.map((l) => `<tr><td>${esc(l.member_code)} ${esc(l.full_name)}</td><td class="num">${baht(l.total_credit)}</td>
          <td class="num">${baht(l.total_debit)}</td><td class="num"><b>${baht(l.net_amount)}</b></td><td>${esc(l.baac_account_no || "—")}</td></tr>`));
    },
    runAct: async (el) => {
      const msg = { submit: "ส่งรอบให้ ธ.ก.ส. แล้ว — ดาวน์โหลดไฟล์โอนได้", paid: "บันทึกการจ่ายแล้ว", cancel: "ยกเลิกรอบแล้ว รายการกลับเป็นค้างจ่าย" }[el.dataset.act2];
      if (await run(() => API.post(`/mushroom/settlements/${el.dataset.id}/${el.dataset.act2}`, {}), msg)) refresh();
    },
    runExport: async (el) => {
      try {
        const res = await fetch(`${API_BASE}/mushroom/settlements/${el.dataset.id}/baac-export`, { headers: { Authorization: `Bearer ${API.getSession().access_token}` } });
        if (!res.ok) throw Object.assign(new Error("export_failed"), { body: await res.json().catch(() => ({})) });
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement("a");
        a.href = url; a.download = `${el.dataset.ref || "baac"}.csv`; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch (e) { toast(errMsg(e), true); }
    },
    readings: async (el) => {
      const row = $(`#rv-${el.dataset.id}`);
      row.hidden = !row.hidden;
      if (row.hidden) return;
      const rows = await run(() => API.get(`/mushroom/iot/devices/${el.dataset.id}/readings?hours=24`));
      if (!rows) return;
      row.firstElementChild.innerHTML = rows.length ? spark(rows) : '<div class="mh-empty">ยังไม่มีข้อมูลใน 24 ชม.</div>';
    },
    mist: async (el) => { await run(() => API.post(`/mushroom/iot/devices/${el.dataset.id}/command`, { command: el.dataset.cmd }), "ส่งคำสั่งแล้ว อุปกรณ์จะรับเมื่อดึงคำสั่งรอบถัดไป"); },
    ackAlert: async (el) => { if (await run(() => API.post(`/mushroom/iot/alerts/${el.dataset.id}/ack`, {}))) { refresh(); badges(); } },
    saveBoxPrice: async (el) => { if (await run(() => API.put(`/mushroom/box-types/${el.dataset.id}`, { replacement_price: $(`[data-bprice="${el.dataset.id}"]`).value }), "บันทึกราคากล่องแล้ว")) refresh(); },
  };

  function spark(rows) {
    const W = 600, H = 80;
    const ts = rows.map((r) => new Date(r.recorded_at).getTime());
    const t0 = Math.min(...ts), t1 = Math.max(...ts) || t0 + 1;
    const line = (key, color) => {
      const vals = rows.map((r) => (r[key] == null ? null : Number(r[key]))).filter((v) => v != null);
      if (!vals.length) return "";
      const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
      const pts = rows.filter((r) => r[key] != null).map((r) => `${((new Date(r.recorded_at).getTime() - t0) / (t1 - t0 || 1)) * W},${H - 6 - ((Number(r[key]) - lo) / span) * (H - 12)}`).join(" ");
      return `<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/>`;
    };
    const last = rows[rows.length - 1];
    return `<svg class="mh-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="อุณหภูมิและความชื้น 24 ชม.">${line("temp_c", "#c0392b")}${line("rh_pct", "#2563eb")}</svg>
      <small><span style="color:#c0392b">■ อุณหภูมิ</span> <span style="color:#2563eb">■ ความชื้น</span> · ล่าสุด ${n2(last.temp_c)}°C ${n2(last.rh_pct)}% · ${rows.length} ค่า</small>`;
  }

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || !ACT[el.dataset.act]) return;
    e.preventDefault();
    ACT[el.dataset.act](el);
  });
  document.addEventListener("change", (e) => {
    if (e.target.matches('[data-act-change="poType"]')) {
      const form = e.target.closest("form");
      const list = JSON.parse(form.partner_id.dataset[e.target.value === "spawn" ? "spawners" : "sellers"]);
      form.partner_id.innerHTML = list.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join("");
      $("#poLines").innerHTML = "";
      addPoLine();
    }
  });

  // ---------- forms ----------
  const lines = (txt) => String(txt || "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const FORM = {
    lookup: async (f) => {
      const rows = await run(() => API.get(`/mushroom/farmers/lookup?phone=${encodeURIComponent(f.phone.value)}`));
      if (!rows) return;
      $("#lookupResult").innerHTML = rows.length ? rows.map((r) => `<button type="button" class="mh-btn sm ghost" data-pick='${esc(JSON.stringify(r))}'>ใช้ ${esc(r.full_name)} (${esc(r.phone)})</button>`).join(" ")
        : '<span class="mh-note">ไม่พบบัญชีเกษตรกร — กรอกข้อมูลด้านล่างเพื่อเพิ่มเป็นสมาชิกที่ไม่มีแอป</span>';
      $("#lookupResult").querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
        const r = JSON.parse(b.dataset.pick);
        const add = $('form[data-form="addMember"]');
        add.farmer_id.value = r.farmer_id; add.full_name.value = r.full_name; add.phone.value = r.phone;
        toast("ผูกบัญชีเกษตรกรแล้ว กรอกข้อมูลจุดเปิดดอกต่อ");
      }));
    },
    addMember: async (f) => { const b = fd(f); if (!b.farmer_id) delete b.farmer_id; Object.keys(b).forEach((k) => { if (b[k] === "") delete b[k]; }); if (await run(() => API.post("/mushroom/members", b), "เพิ่มสมาชิกแล้ว")) refresh(); },
    editMember: async (f) => { const b = fd(f); if (b.distance_km === "") b.distance_km = null; if (await run(() => API.put(`/mushroom/members/${f.dataset.id}`, b), "บันทึกแล้ว")) refresh(); },
    addPartner: async (f) => { const b = fd(f); delete b.org_q; if (!b.linked_org_id) delete b.linked_org_id; if (await run(() => API.post("/mushroom/partners", b), "เพิ่มคู่ค้าแล้ว")) refresh(); },
    straw: async (f) => { const b = fd(f); if (!b.moisture_pct) delete b.moisture_pct; if (await run(() => API.post("/mushroom/straw-receipts", b), "รับฟางเข้าคลังแล้ว")) refresh(); },
    po: async (f) => {
      const b = fd(f);
      const ls = [...$("#poLines").children].map((row) => { const o = {}; row.querySelectorAll("[data-line]").forEach((i) => { o[i.dataset.line] = i.value; }); return o; }).filter((l) => Number(l.qty) > 0);
      if (!b.expected_date) delete b.expected_date;
      if (await run(() => API.post("/mushroom/purchase-orders", { partner_id: b.partner_id, po_type: b.po_type, expected_date: b.expected_date, lines: ls }), "ออกใบสั่งซื้อแล้ว")) refresh();
    },
    adjust: async (f) => { if (await run(() => API.post("/mushroom/material-adjust", fd(f)), "ปรับสต็อกแล้ว")) refresh(); },
    recipe: async (f) => {
      const b = fd(f);
      b.items = [...f.querySelectorAll("[data-pct]")].filter((i) => Number(i.value) > 0).map((i) => ({ material_id: i.dataset.pct, pct: i.value }));
      if (await run(() => API.post("/mushroom/recipes", b), "บันทึกสูตรแล้ว")) refresh();
    },
    batch: async (f) => {
      const b = fd(f); if (!b.box_type_id) delete b.box_type_id;
      const r = await run(() => API.post("/mushroom/batches", b));
      if (r) { toast(`ตั้งกอง ${r.batch_code}: วัสดุ ${n2(r.material_kg)} กก. ต้นทุนวัสดุ ${baht(r.material_cost)} บาท`); refresh(); }
    },
    batchCost: async (f) => { if (await run(() => API.post(`/mushroom/batches/${f.dataset.id}/costs`, fd(f)), "เพิ่มต้นทุนแล้ว")) refresh(); },
    batchNote: async (f) => { const b = fd(f); if (!b.temp_c) delete b.temp_c; if (await run(() => API.post(`/mushroom/batches/${f.dataset.id}/note`, b), "บันทึกแล้ว")) f.reset(); },
    bulkBoxes: async (f) => {
      const r = await run(() => API.post("/mushroom/boxes/bulk", fd(f)));
      if (!r) return;
      cache.newCodes = r;
      toast(`ลงทะเบียน ${r.created} กล่องแล้ว`);
      await refresh();
      $("#newCodes").innerHTML = `<p>${r.qr_codes[0]} … ${r.qr_codes[r.qr_codes.length - 1]}</p><button class="mh-btn ghost" data-act="printCodes">🖨️ พิมพ์ป้าย QR</button>`;
    },
    findBox: async (f) => {
      const b = await run(() => API.get(`/mushroom/boxes/by-qr/${encodeURIComponent(f.qr.value)}`));
      if (!b) return;
      $("#boxInfo").innerHTML = `<p><b>${esc(b.qr_code)}</b> ${esc(b.box_type)} ${st(b.status)} ${b.batch_code ? "รุ่น " + esc(b.batch_code) : ""} ${b.member_name ? "ที่ " + esc(b.member_name) : ""}</p>`
        + table(["รับ", "คืน", "สมาชิก", "รุ่น", "ผล", "#ค่าชดใช้"], b.history.map((h) => `<tr><td>${d(h.delivered_at)}</td><td>${d(h.returned_at)}</td><td>${esc(h.member_name)}</td><td>${esc(h.batch_code)}</td><td>${h.outcome ? st(h.outcome) : "-"}</td><td class="num">${baht(h.liability_amount)}</td></tr>`));
    },
    returnBoxes: async (f) => {
      const items = lines(f.qrs.value).map((q) => ({ qr_code: q, outcome: f.outcome.value }));
      const r = await run(() => API.post("/mushroom/boxes/return", { items }));
      if (r) { toast(`รับคืน ${r.returned.length} กล่อง${r.returned.some((x) => x.liability) ? " (มีค่าชดใช้)" : ""}`); refresh(); }
    },
    distribute: async (f) => {
      const b = fd(f);
      const qrs = lines(b.qrs);
      const body = { batch_id: b.batch_id, member_id: b.member_id, trip_id: b.trip_id || undefined };
      if (qrs.length) body.qr_codes = qrs; else body.count = b.count;
      const r = await run(() => API.post("/mushroom/distribute", body));
      if (r) { toast(`ฝากเลี้ยง ${r.boxes.length} กล่องให้ ${r.member}`); refresh(); }
    },
    prices: async (f) => { if (await run(() => API.post("/mushroom/prices", fd(f)), "ประกาศราคาแล้ว")) { refresh(); badges(); } },
    harvest: async (f) => {
      const r = await run(() => API.post("/mushroom/harvests", fd(f)));
      if (r) { toast(`${r.member_name}: ${n2(r.weight_kg)} กก. = ${baht(r.amount)} บาท`); refresh(); }
    },
    freshLot: async (f) => { const b = fd(f); b.product_type = "fresh"; if (!b.grade) delete b.grade; const r = await run(() => API.post("/mushroom/lots", b)); if (r) { toast(`สร้างล็อต ${r.lot_code} ${n2(r.qty_kg)} กก.`); refresh(); } },
    processLot: async (f) => { const b = fd(f); if (!b.expires_on) delete b.expires_on; const r = await run(() => API.post("/mushroom/lots", b)); if (r) { toast(`แปรรูปแล้ว ล็อต ${r.lot_code}`); refresh(); } },
    order: async (f) => { const b = fd(f); ["grade", "deliver_on", "contract_end"].forEach((k) => { if (!b[k]) delete b[k]; }); if (await run(() => API.post("/mushroom/sales-orders", b), "บันทึกคำสั่งซื้อแล้ว")) refresh(); },
    suggest: async (f) => {
      const s = await run(() => API.get(`/mushroom/trips/suggest?date=${f.date.value}`));
      if (!s) return;
      const trans = cache.trans || [];
      $("#tripPlan").innerHTML = s.stops.length ? `<form data-form="newTrip" class="mh-form" style="margin-top:12px" data-date="${s.date}">
        <div class="full">${table(["ไป", "สมาชิก", "#ระยะ (กม.)", "#ส่งกล่อง", "#ถือกล่อง", "รับเห็ด", "รับฟาง"], s.stops.map((x, i) => `<tr>
          <td><input type="checkbox" data-stop="${i}" checked></td><td>${esc(x.member_code)} ${esc(x.full_name)}${x.over_max_distance ? " " + pill("ไกลเกิน " + n2(s.max_delivery_km) + " กม.", "bad") : ""}</td>
          <td class="num">${n2(x.distance_km)}</td><td class="num"><input type="number" min="0" value="${x.boxes_to_drop}" data-drop="${i}" style="width:70px"></td><td class="num">${x.boxes_on_hand}</td>
          <td><input type="checkbox" data-mush="${i}"${x.boxes_on_hand ? " checked" : ""}></td><td><input type="checkbox" data-straw="${i}"></td></tr>`))}</div>
        <div><label>ทะเบียนรถ</label><input name="vehicle"></div><div><label>คนขับ</label><input name="driver_name"></div>
        <div><label>ผู้ขนส่ง</label><select name="partner_id"><option value="">รถสหกรณ์</option>${opt(trans, "partner_id", "name")}</select></div>
        <div><button class="mh-btn">สร้างเที่ยวรถ</button></div></form>` : '<div class="mh-empty">ไม่มีจุดที่ต้องไปในวันนั้น</div>';
      cache.suggest = s;
    },
    newTrip: async (f) => {
      const s = cache.suggest;
      const stops = s.stops.map((x, i) => ({ x, i })).filter(({ i }) => f.querySelector(`[data-stop="${i}"]`).checked).map(({ x, i }) => ({
        member_id: x.member_id, drop_boxes: f.querySelector(`[data-drop="${i}"]`).value || 0, booking_id: x.booking_id || undefined,
        collect_mushroom: f.querySelector(`[data-mush="${i}"]`).checked, collect_straw: f.querySelector(`[data-straw="${i}"]`).checked,
      }));
      const b = fd(f);
      if (await run(() => API.post("/mushroom/trips", { trip_date: f.dataset.date, vehicle: b.vehicle, driver_name: b.driver_name, partner_id: b.partner_id || undefined, stops }), "สร้างเที่ยวรถแล้ว")) refresh();
    },
    stopDone: async (f) => {
      const b = fd(f);
      const body = { skipped: b.skipped };
      if (b.batch_id && Number(b.drop_count) > 0) { body.batch_id = b.batch_id; body.drop_count = b.drop_count; }
      body.harvests = ["A", "B", "C"].filter((g) => Number(b["kg_" + g]) > 0).map((g) => ({ grade: g, weight_kg: b["kg_" + g] }));
      if (Number(b.straw_kg) > 0) body.straw_kg = b.straw_kg;
      const rq = lines(b.returns);
      if (rq.length) body.returns = rq.map((q) => ({ qr_code: q, outcome: "Returned" }));
      if (await run(() => API.post(`/mushroom/trips/${f.dataset.trip}/stops/${f.dataset.stop}/done`, body), "ปิดจุดแวะแล้ว")) refresh();
    },
    tripComplete: async (f) => { const b = fd(f); if (!b.distance_km) delete b.distance_km; if (await run(() => API.post(`/mushroom/trips/${f.dataset.id}/complete`, b), "จบเที่ยวรถแล้ว")) refresh(); },
    newRun: async (f) => { const r = await run(() => API.post("/mushroom/settlements", fd(f))); if (r) { toast(`สร้างรอบแล้ว ${r.member_count} ราย ${baht(r.total_net)} บาท${r.carried_forward_members ? ` (ยกยอด ${r.carried_forward_members} ราย)` : ""}`); refresh(); } },
    ledgerAdjust: async (f) => { if (await run(() => API.post("/mushroom/ledger/adjust", fd(f)), "บันทึกการปรับปรุงแล้ว")) refresh(); },
    device: async (f) => {
      const b = fd(f);
      ["member_id", "temp_min", "temp_max", "rh_min", "rh_max"].forEach((k) => { if (b[k] === "") delete b[k]; });
      const r = await run(() => API.post("/mushroom/iot/devices", b));
      if (r) { await refresh(); $("#newKey") && ($("#newKey").innerHTML = `<p><b>คีย์อุปกรณ์ (แสดงครั้งเดียว):</b></p><div class="mh-key">${esc(r.api_key)}</div>`); toast("สร้างอุปกรณ์แล้ว — คัดลอกคีย์ไปตั้งในอุปกรณ์"); }
    },
    report: async (f) => { cache.repFrom = f.from.value; cache.repTo = f.to.value; refresh(); },
    settings: async (f) => { const r = await run(() => API.put("/mushroom/settings", fd(f))); if (r) { toast(r.updated.length ? `บันทึก ${r.updated.length} รายการ` : "ไม่มีการเปลี่ยนแปลง"); refresh(); } },
    boxType: async (f) => { if (await run(() => API.post("/mushroom/box-types", fd(f)), "เพิ่มชนิดกล่องแล้ว")) refresh(); },
  };
  document.addEventListener("submit", (e) => {
    const f = e.target.closest("form[data-form]");
    if (!f || !FORM[f.dataset.form]) return;
    e.preventDefault();
    const btn = f.querySelector("button:not([type=button])");
    if (btn) btn.disabled = true;
    Promise.resolve(FORM[f.dataset.form](f)).finally(() => { if (btn && btn.isConnected) btn.disabled = false; });
  });

  window.addEventListener("hashchange", () => {
    const t = (location.hash || "").slice(1);
    if (PAGES[t] && t !== current) show(t);
  });
  const start = (location.hash || "").slice(1);
  badges();
  show(PAGES[start] ? start : "overview");
})();
