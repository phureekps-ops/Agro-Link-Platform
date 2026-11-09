/**
 * AgroLink — พอร์ทัลสหกรณ์โคนม (โปรแกรมบริหารธุรกิจโคนมครบวงจร) ฝั่งสหกรณ์.
 * Talks to backend/src/routes/dairy.js (/dairy/*) with the cooperative
 * session from js/api.js. Same structure as js/mushroom.js: each tab renders
 * itself from the API on open; buttons use data-act (ACT), forms data-form (FORM).
 */
(function () {
  "use strict";
  const API = AgroLinkCoopAPI;
  if (!API.requireSessionOrRedirect()) return;
  const API_BASE = ["localhost", "127.0.0.1"].includes(window.location.hostname) ? "http://localhost:4000" : "https://agrolink-backend-vhv6.onrender.com";

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const n2 = (v) => (v == null || v === "" ? "-" : Number(v).toLocaleString("th-TH", { maximumFractionDigits: 2 }));
  const baht = (v) => (v == null ? "-" : Number(v).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const d = (v) => (v ? new Date(String(v).length === 10 ? v + "T00:00:00" : v).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" }) : "-");
  const dt = (v) => (v ? new Date(v).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "-");
  const iso = (v) => (v ? String(v).slice(0, 10) : "");
  const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const addDays = (s, n) => new Date(Date.parse(s + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
  const opt = (rows, val, label, sel) => rows.map((r) => `<option value="${esc(r[val])}"${sel === r[val] ? " selected" : ""}>${esc(typeof label === "function" ? label(r) : r[label])}</option>`).join("");
  const table = (heads, rows) => rows.length
    ? `<div class="mh-scroll"><table class="mh-table"><thead><tr>${heads.map((h) => `<th${h.startsWith("#") ? ' class="num"' : ""}>${esc(h.replace(/^#/, ""))}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : '<div class="mh-empty">ยังไม่มีข้อมูล</div>';
  const pill = (txt, cls) => `<span class="mh-pill ${cls || ""}">${esc(txt)}</span>`;
  const lvl = (l) => `<span class="mh-lvl ${l}"></span>${{ green: "ปกติ", yellow: "เฝ้าระวัง", orange: "เตรียมระบาย", red: "วิกฤต" }[l] || l}`;

  const ERR = {
    base_price_not_set: "ยังไม่ได้ตั้งราคาฐาน — ไปที่แท็บตั้งค่า", member_not_approved: "สมาชิกยังไม่ได้รับอนุมัติ", round_closed: "รอบนี้ปิดแล้ว",
    member_has_withdrawal_animals: "สมาชิกมีโคอยู่ในระยะหยุดยา", insufficient_stock: "สต็อกไม่พอ", over_credit_limit: "เกินวงเงินเชื่อของสมาชิก",
    item_price_not_set: "ยังไม่ได้ตั้งราคาขายของรายการนี้", missing_baac_account: "สมาชิกบางรายยังไม่มีเลขบัญชี ธ.ก.ส.", nothing_to_settle: "ไม่มียอดค้างสำหรับรอบนี้",
    draft_run_exists: "มีรอบจ่ายที่ยังเป็นฉบับร่างอยู่", open_rounds_in_period: "ยังมีรอบรับนมที่ยังไม่ปิดในช่วงนี้", period_already_settled: "ช่วงนี้จ่ายไปแล้ว",
    no_insemination_record: "ยังไม่มีบันทึกการผสมพันธุ์", female_only: "ใช้ได้กับโคเพศเมียเท่านั้น", ear_tag_exists: "เบอร์หูนี้มีอยู่แล้ว",
    animal_not_active: "โคตัวนี้ไม่อยู่ในฝูงแล้ว", contract_not_active: "สัญญาไม่อยู่ในสถานะใช้งาน", outside_contract_period: "วันที่อยู่นอกช่วงสัญญา",
    received_more_than_sent: "รับมากกว่าที่ส่ง", missing_price: "ต้องระบุราคา", offer_not_open: "ประกาศนี้ไม่เปิดแล้ว", proposal_exists: "มีข้อเสนอค้างอยู่แล้ว",
    waiting_for_processor: "รอโรงงานตอบรับ", batch_expired: "ล็อตนี้หมดอายุแล้ว", member_needs_center: "ต้องกำหนดศูนย์รวบรวมก่อนอนุมัติ",
    invalid_deduction_order: "ลำดับการหักไม่ถูกต้อง", invalid_alert_thresholds: "เกณฑ์เตือนต้องเรียง เหลือง ≤ ส้ม ≤ แดง", device_needs_center: "อุปกรณ์นี้ต้องผูกกับศูนย์รวบรวม",
    partner_type_mismatch: "ประเภทคู่ค้าไม่ตรง", missing_reject_reason: "ต้องระบุเหตุผลที่ปฏิเสธ", invalid_range: "ช่วงค่าไม่ถูกต้อง",
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
    if (b.field) m += ` (${b.field})`;
    if (b.available !== undefined && b.needed !== undefined) m += ` (มี ${n2(b.available)} ต้องการ ${n2(b.needed)})`;
    if (b.members) m += ": " + b.members.join(", ");
    if (b.ear_tags) m += ": " + b.ear_tags.join(", ");
    if (b.credit_limit !== undefined) m += ` (ยอดคงค้าง ${baht(b.balance)} วงเงิน ${baht(b.credit_limit)})`;
    if (b.detail) m += ` — ${b.detail}`;
    return m;
  }
  const fd = (form) => {
    const o = {};
    new FormData(form).forEach((v, k) => { o[k] = typeof v === "string" ? v.trim() : v; });
    form.querySelectorAll("input[type=checkbox]").forEach((c) => { o[c.name] = c.checked; });
    return o;
  };
  const clean = (o) => { Object.keys(o).forEach((k) => { if (o[k] === "") delete o[k]; }); return o; };
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
    Pending: "รออนุมัติ", Approved: "อนุมัติแล้ว", Suspended: "ระงับ", Open: "เปิด", Closed: "ปิดแล้ว", Accepted: "รับ", Rejected: "ปฏิเสธ",
    Ordered: "สั่งแล้ว", Confirmed: "ยืนยันแล้ว", Delivered: "ส่งมอบแล้ว", Cancelled: "ยกเลิก", Assigned: "มอบหมายแล้ว", Done: "เสร็จ",
    Active: "ใช้งาน", Ended: "สิ้นสุด", Sent: "ส่งแล้ว รอโรงงาน", Received: "โรงงานรับแล้ว", Matched: "จับคู่แล้ว", Withdrawn: "ถอน",
    Planned: "วางแผน", Issue: "มีปัญหา", Draft: "ฉบับร่าง", Submitted: "ส่ง ธ.ก.ส. แล้ว", Paid: "จ่ายแล้ว",
    Calf: "ลูกโค", Heifer: "โคสาว", Milking: "รีดนม", Dry: "พักท้อง/หยุดรีด", Bull: "โคตัวผู้", Sold: "ขายแล้ว", Dead: "ตาย", Culled: "คัดทิ้ง",
  };
  const st = (s) => pill(STATUS_TH[s] || s, ["Approved", "Accepted", "Confirmed", "Delivered", "Done", "Active", "Received", "Matched", "Paid", "Milking", "Closed"].includes(s) ? "ok"
    : ["Pending", "Open", "Ordered", "Assigned", "Sent", "Planned", "Draft", "Submitted", "Dry"].includes(s) ? "warn"
      : ["Rejected", "Cancelled", "Suspended", "Issue", "Dead", "Culled"].includes(s) ? "bad" : "");
  const PTYPE = { processor: "โรงงานแปรรูปนม", feed_supplier: "ผู้ขายอาหารสัตว์/ปัจจัย", vet: "สัตวแพทย์/ผสมเทียม", product_buyer: "ผู้ซื้อผลิตภัณฑ์", transporter: "ผู้ขนส่ง" };
  const EVENT = { heat: "เป็นสัด", insemination: "ผสมเทียม", pregnancy_check: "ตรวจท้อง", calving: "คลอด", dry_off: "หยุดรีด", treatment: "รักษา", vaccination: "วัคซีน", sold: "ขาย", dead: "ตาย", culled: "คัดทิ้ง", note: "บันทึก" };
  const REJ = { antibiotic: "ตกค้างยาปฏิชีวนะ", temperature: "อุณหภูมิไม่ผ่าน", smell: "กลิ่นผิดปกติ", clot: "นมเป็นตะกอน/จับตัว", other: "อื่น ๆ" };
  const LEDGER = { milk_sale: "ค่าน้ำนม", feed: "อาหาร/ปัจจัย", vet_service: "ค่าสัตวแพทย์", ai_service: "ค่าผสมเทียม", loan_repayment: "ชำระสินเชื่อ", share: "ค่าหุ้น", adjustment: "ปรับปรุง" };
  const FEE = { feed_purchase: "ซื้ออาหารสัตว์ (ผู้ขายจ่าย)", raw_milk_sale: "ขายนมดิบให้โรงงาน", surplus_sale: "ขายนมส่วนเกินผ่านตลาด", product_sale: "ขายผลิตภัณฑ์นม" };
  const CAT = { concentrate: "อาหารข้น", roughage: "อาหารหยาบ", mineral: "แร่ธาตุ", medicine: "ยา/เวชภัณฑ์", semen: "น้ำเชื้อ", other: "อื่น ๆ" };
  const PROD = { pasteurized: "พาสเจอร์ไรส์", uht: "UHT", yogurt: "โยเกิร์ต", cheese: "ชีส", butter: "เนย", powder: "นมผง", other: "อื่น ๆ" };
  const REQ = { feed: "เบิกอาหาร/ปัจจัย", vet: "เรียกสัตวแพทย์", ai: "เรียกผสมเทียม" };
  const DEV = { cooling_tank: "ถังเย็น", milk_scale: "เครื่องชั่งนม", vehicle: "รถขนนม", biogas: "บ่อไบโอแก๊ส", barn: "โรงเรือน" };
  const PARAM = { fat: "ไขมัน (%)", snf: "ของแข็งไม่รวมไขมัน SNF (%)", scc: "เซลล์โซมาติก SCC (พัน/มล.)", tbc: "แบคทีเรีย TBC (พัน/มล.)" };
  const WD = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

  const cache = {};
  async function load(key, path) { cache[key] = await API.get(path); return cache[key]; }
  const members = async () => cache.membersList || load("membersList", "/dairy/members");
  const partners = async (type) => (await API.get(`/dairy/partners?type=${type}`)).filter((p) => p.active);

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
    delete cache.membersList;
    try {
      await PAGES[current](sec);
    } catch (e) {
      if (e.body && (e.body.error === "kyb_not_verified" || e.body.error === "role_not_verified")) {
        sec.innerHTML = '<div class="mh-card">บัญชีนี้ยังไม่ได้รับอนุมัติบทบาทสหกรณ์ จึงยังใช้พอร์ทัลโคนมไม่ได้</div>';
      } else if (e.message !== "session_expired") sec.innerHTML = `<div class="mh-card error-box show">โหลดข้อมูลไม่สำเร็จ: ${esc(errMsg(e))}</div>`;
    }
  }
  document.querySelectorAll("#mhNav [data-tab]").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
  $("#logoutBtn").addEventListener("click", () => API.logout());

  async function badges() {
    try {
      const o = await API.get("/dairy/overview");
      cache.overview = o;
      $("#orgName").textContent = o.org_name;
      const set = (id, n) => { const e = $(id); e.hidden = !n; e.textContent = n; };
      set("#cntMembers", o.members_pending);
      set("#cntRequests", o.open_requests);
      set("#cntRounds", o.open_rounds);
      set("#cntShip", o.shipments_pending);
      set("#cntSurplus", o.proposals_waiting);
      set("#cntAlerts", o.open_alerts);
    } catch (e) { /* page shows its own error */ }
  }

  // ---------- pages ----------
  const PAGES = {};

  PAGES.overview = async (sec) => {
    await badges();
    const o = cache.overview;
    const f = o.forecast30;
    sec.innerHTML = `
      ${o.settings_incomplete ? '<div class="mh-card" style="background:var(--gold-100)">⚠️ ยังไม่ได้ตั้งราคาฐานน้ำนมและค่าบริการ — ไปที่ <a href="#settings" data-act="go" data-tab="settings">ตั้งค่า</a> (ปิดรอบรับนมไม่ได้จนกว่าจะตั้งราคาฐาน)</div>' : ""}
      <div class="mh-grid">
        <div class="mh-stat"><small>น้ำนมรับวันนี้ (${d(o.today)})</small><b>${n2(o.today_accepted_kg)}</b> <small>กก. · ปฏิเสธ ${n2(o.today_rejected_kg)}</small></div>
        <div class="mh-stat"><small>ส่งโรงงาน / แปรรูป วันนี้</small><b>${n2(o.today_shipped_kg)}</b> <small>/ ${n2(o.today_processed_kg)} กก.</small></div>
        <div class="mh-stat"><small>สัญญารับซื้อ (MOU) ต่อวัน</small><b>${n2(o.contracted_kg_day)}</b> <small>กก./วัน</small></div>
        <div class="mh-stat"><small>เฉลี่ย 14 วันล่าสุด</small><b>${o.recent_avg_kg_day == null ? "-" : n2(o.recent_avg_kg_day)}</b> <small>กก./วัน</small></div>
        <div class="mh-stat"><small>สมาชิก</small><b>${o.members_total}</b> <small>รออนุมัติ ${o.members_pending}</small></div>
        <div class="mh-stat"><small>โครีดนม / พักท้อง / ตั้งท้อง</small><b>${o.milking}</b> <small>/ ${o.dry} / ${o.pregnant}</small></div>
        <div class="mh-stat ${o.withdrawal ? "warn" : ""}"><small>โคในระยะหยุดยา</small><b>${o.withdrawal}</b> <small>ตัว</small></div>
        <div class="mh-stat"><small>ยอดรอจ่ายสมาชิก (สุทธิ)</small><b>${baht(o.unsettled_net)}</b></div>
      </div>
      <div class="mh-card" style="margin-top:16px"><h3>สัญญาณนมส่วนเกิน 30 วันข้างหน้า</h3>
        ${f ? `<p style="font-size:16px;margin:0">${lvl(f.level)} — คาดการณ์เฉลี่ย <b>${n2(f.avg_forecast_kg)}</b> กก./วัน เทียบตลาดรองรับ <b>${n2(f.avg_committed_kg)}</b> กก./วัน
          ${f.surplus_pct == null ? "(ยังไม่มีสัญญารองรับ)" : `(ส่วนต่าง ${n2(f.surplus_pct)}%)`}</p>
          <p class="mh-note"><a href="#forecast" data-act="go" data-tab="forecast">ดูพยากรณ์ 30/60/90 วัน</a>${["orange", "red"].includes(f.level) ? ' · <a href="#surplus" data-act="go" data-tab="surplus">ประกาศนมส่วนเกิน</a>' : ""}</p>` : '<div class="mh-empty">ยังไม่มีข้อมูลพอสำหรับพยากรณ์</div>'}
      </div>
      <div class="mh-card"><h3>งานที่รออยู่</h3><div class="mh-row">
        ${[[o.open_rounds, "รอบรับนมที่ยังไม่ปิด", "intake"], [o.open_requests, "คำขอจากสมาชิก", "services"], [o.shipments_pending, "เที่ยวส่งนมรอโรงงานยืนยัน", "factory"],
    [o.proposals_waiting, "ข้อเสนอรับนมส่วนเกินจากโรงงาน", "surplus"], [o.school_today, "ส่งนมโรงเรียนวันนี้", "school"], [o.expiring_batches, "ล็อตผลิตภัณฑ์ใกล้หมดอายุ (≤3 วัน)", "processing"],
    [o.open_alerts, "แจ้งเตือน IoT", "iot"]].map(([n, t, tab]) => `<a href="#${tab}" data-act="go" data-tab="${tab}" class="mh-pill ${n ? "warn" : ""}">${t}: ${n}</a>`).join("")}
      </div></div>`;
  };

  // ---- สมาชิก ----
  PAGES.members = async (sec) => {
    const [rows, centers] = await Promise.all([load("membersList", "/dairy/members"), API.get("/dairy/centers")]);
    cache.centers = centers;
    sec.innerHTML = `
      <details class="mh-card"><summary>➕ เพิ่มสมาชิกผู้เลี้ยงโคนม</summary>
        <form data-form="lookup" class="mh-form" style="margin-top:12px">
          <div><label>ค้นหาเกษตรกรที่มีบัญชี AgroLink ด้วยเบอร์โทร</label><input name="phone" placeholder="08xxxxxxxx"></div>
          <div><button class="mh-btn ghost">ค้นหา</button></div><div class="full" id="lookupResult"></div>
        </form>
        <form data-form="addMember" class="mh-form" style="margin-top:12px">
          <input type="hidden" name="farmer_id">
          <div><label>ชื่อ-สกุล</label><input name="full_name"></div><div><label>โทร</label><input name="phone"></div>
          <div><label>ชื่อฟาร์ม</label><input name="farm_name"></div><div><label>เลขทะเบียนฟาร์ม (ปศุสัตว์)</label><input name="farm_registration_no"></div>
          <div><label>ศูนย์รวบรวม</label><select name="center_id">${opt(centers.filter((c) => c.active), "center_id", "name")}</select></div>
          <div><label>ระยะทาง (กม.)</label><input name="distance_km" type="number" step="0.1"></div>
          <div><label>เลขบัญชี ธ.ก.ส.</label><input name="baac_account_no"></div><div><label>ชื่อบัญชี</label><input name="baac_account_name"></div>
          <div><label>วงเงินเชื่อ (บาท, ว่าง=ไม่จำกัด)</label><input name="credit_limit" type="number" min="0"></div>
          <div><label>ค่าหุ้นหักต่อรอบ (บาท)</label><input name="share_deduct_per_round" type="number" min="0" value="0"></div>
          <div><label><input type="checkbox" name="gap_certified"> ได้มาตรฐาน GAP ฟาร์มโคนม</label></div>
          <div class="full"><label>ที่อยู่</label><input name="address"></div>
          <div><button class="mh-btn">บันทึกสมาชิก</button></div>
        </form></details>
      <div class="mh-card"><h3>สมาชิก ${rows.length} ราย</h3>
        ${table(["รหัส", "ชื่อ / ฟาร์ม", "ศูนย์", "#โครีด/ฝูง", "#นมเฉลี่ย 14 วัน (กก./วัน)", "คุณภาพล่าสุด", "#ยอดค้าง", "บัญชี ธ.ก.ส.", "สถานะ", ""], rows.map((m) => `<tr>
          <td>${esc(m.member_code)}</td><td>${esc(m.full_name)}${m.farm_name ? `<br><small>${esc(m.farm_name)}</small>` : ""}${m.farmer_id ? ' <span class="mh-pill ok">มีแอป</span>' : ""}${m.gap_certified ? ' <span class="mh-pill ok">GAP</span>' : ""}</td>
          <td>${esc(m.center_name || "-")}</td><td class="num">${m.milking}/${m.herd}</td><td class="num">${n2(m.avg_kg_day_14)}</td>
          <td>${m.last_test ? `<small>${d(m.last_test.sample_date)} F ${n2(m.last_test.fat_pct)} S ${n2(m.last_test.snf_pct)} SCC ${n2(m.last_test.scc_k)}</small>` : "-"}</td>
          <td class="num">${baht(m.unsettled_net)}</td><td>${m.baac_account_no ? "✓" : pill("ไม่มี", "bad")}</td><td>${st(m.status)}</td>
          <td class="mh-row">${m.status !== "Approved" ? `<button class="mh-btn sm" data-act="memberStatus" data-id="${m.member_id}" data-status="Approved">อนุมัติ</button>` : `<button class="mh-btn sm ghost" data-act="memberStatus" data-id="${m.member_id}" data-status="Suspended">ระงับ</button>`}
            <button class="mh-btn sm ghost" data-act="editMember" data-id="${m.member_id}">แก้ไข</button></td></tr>
          <tr id="edit-${m.member_id}" hidden><td colspan="10"></td></tr>`))}
      </div>
      <div class="mh-card"><h3>คู่ค้า</h3><div id="partnerBox"></div></div>`;
    await renderPartners();
  };
  async function renderPartners() {
    const rows = await API.get("/dairy/partners");
    $("#partnerBox").innerHTML = `
      <form data-form="addPartner" class="mh-form">
        <div><label>ประเภท</label><select name="partner_type">${Object.entries(PTYPE).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
        <div><label>ชื่อ</label><input name="name" required></div><div><label>ผู้ติดต่อ</label><input name="contact_name"></div><div><label>โทร</label><input name="phone"></div>
        <div><label>ค้นหาบัญชีองค์กร AgroLink (ผูกให้ใช้พอร์ทัลคู่ค้า)</label><input name="org_q" placeholder="พิมพ์ชื่อ 2 ตัวขึ้นไป" data-act-input="orgSearch"></div>
        <div><label>บัญชีที่ผูก</label><select name="linked_org_id"><option value="">— ไม่ผูก —</option></select></div>
        <div><button class="mh-btn">เพิ่มคู่ค้า</button></div></form>
      ${table(["ประเภท", "ชื่อ", "ติดต่อ", "บัญชี AgroLink", "สถานะ", ""], rows.map((p) => `<tr><td>${PTYPE[p.partner_type]}</td><td>${esc(p.name)}</td><td>${esc(p.contact_name || "")} ${esc(p.phone || "")}</td>
        <td>${p.linked_org_name ? pill(p.linked_org_name, "ok") : "-"}</td><td>${p.active ? pill("ใช้งาน", "ok") : pill("ปิด", "bad")}</td>
        <td><button class="mh-btn sm ghost" data-act="togglePartner" data-id="${p.partner_id}" data-active="${p.active ? "0" : "1"}">${p.active ? "ปิด" : "เปิด"}</button></td></tr>`))}
      <p class="mh-note">โรงงาน/ผู้ขายอาหาร/สัตวแพทย์ที่ผูกบัญชีแล้ว เข้าพอร์ทัลคู่ค้าโคนม (dairy-partner.html) เพื่อยืนยันรับนม ยืนยันใบสั่งซื้อ หรือบันทึกงานรักษาได้เอง</p>`;
  }

  // ---- ฝูงโค ----
  PAGES.herd = async (sec) => {
    const ms = await members();
    const q = cache.herdFilter || {};
    const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
    const [animals, cal] = await Promise.all([API.get(`/dairy/animals${params ? "?" + params : ""}`), API.get("/dairy/herd/calendar")]);
    cache.animals = animals;
    const list = (rows, f) => (rows.length ? rows.map((a) => `<div><a href="#" data-act="animal" data-id="${a.animal_id}">${esc(a.ear_tag)}</a> ${esc(a.member_name)} — ${f(a)}</div>`).join("") : '<div class="mh-empty">-</div>');
    sec.innerHTML = `
      <div class="mh-grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
        <div class="mh-card"><h3>🐄 ใกล้คลอด (30 วัน)</h3>${list(cal.calving_soon, (a) => d(a.expected_calving_date))}</div>
        <div class="mh-card"><h3>⏸ ถึงกำหนดหยุดรีด (14 วัน)</h3>${list(cal.dry_off_due, (a) => d(a.dry_off_due_date))}</div>
        <div class="mh-card"><h3>🔍 ควรตรวจท้อง (ผสม 35–90 วัน)</h3>${list(cal.pregnancy_check_due, (a) => "ผสม " + d(a.last_insemination_date))}</div>
        <div class="mh-card"><h3>♥ คาดว่าเป็นสัด (รอบ 21 วัน)</h3>${list(cal.heat_expected, (a) => "ครั้งก่อน " + d(a.last_heat))}</div>
        <div class="mh-card" style="${cal.withdrawal.length ? "background:var(--red-100)" : ""}"><h3>🚫 ระยะหยุดยา (ห้ามส่งนม)</h3>${list(cal.withdrawal, (a) => "ถึง " + d(a.withdrawal_until))}</div>
      </div>
      <details class="mh-card"><summary>➕ ขึ้นทะเบียนโค</summary>
        <form data-form="addAnimal" class="mh-form" style="margin-top:12px">
          <div><label>สมาชิก</label><select name="member_id">${opt(ms, "member_id", (m) => `${m.member_code} ${m.full_name}`)}</select></div>
          <div><label>เบอร์หู</label><input name="ear_tag" required></div><div><label>ชื่อ</label><input name="name"></div>
          <div><label>สายพันธุ์</label><input name="breed" placeholder="เช่น โฮลสไตน์ฟรีเชียน"></div>
          <div><label>เพศ</label><select name="sex"><option value="F">เมีย</option><option value="M">ผู้</option></select></div>
          <div><label>สถานะ</label><select name="status">${["Milking", "Dry", "Heifer", "Calf", "Bull"].map((s) => `<option value="${s}">${STATUS_TH[s]}</option>`).join("")}</select></div>
          <div><label>วันเกิด</label><input name="birth_date" type="date"></div><div><label>ท้องที่ (ลำดับการให้นม)</label><input name="lactation_no" type="number" min="0" value="0"></div>
          <div><label>คลอดครั้งล่าสุด</label><input name="last_calving_date" type="date"></div><div><label>แม่ (เบอร์หู)</label><input name="dam_ear_tag"></div><div><label>พ่อพันธุ์/รหัสน้ำเชื้อ</label><input name="sire_code"></div>
          <div><button class="mh-btn">บันทึก</button></div></form></details>
      <div class="mh-card"><h3>ทะเบียนโค ${animals.length} ตัว</h3>
        <form data-form="herdFilter" class="mh-form" style="margin-bottom:10px">
          <div><label>สมาชิก</label><select name="member_id"><option value="">ทั้งหมด</option>${opt(ms, "member_id", (m) => `${m.member_code} ${m.full_name}`, q.member_id)}</select></div>
          <div><label>สถานะ</label><select name="status"><option value="">ในฝูง</option>${Object.keys(STATUS_TH).filter((s) => ["Calf", "Heifer", "Milking", "Dry", "Bull", "Sold", "Dead", "Culled"].includes(s)).map((s) => `<option value="${s}"${q.status === s ? " selected" : ""}>${STATUS_TH[s]}</option>`).join("")}</select></div>
          <div><label>ค้นหาเบอร์หู/ชื่อ</label><input name="q" value="${esc(q.q || "")}"></div><div><button class="mh-btn ghost">กรอง</button></div></form>
        ${table(["เบอร์หู", "ชื่อ/พันธุ์", "สมาชิก", "สถานะ", "#ท้องที่", "คลอดล่าสุด", "ผสม/ตั้งท้อง", "กำหนดคลอด", "หยุดยาถึง", ""], animals.map((a) => `<tr>
          <td><b>${esc(a.ear_tag)}</b></td><td>${esc(a.name || "")}<br><small>${esc(a.breed || "")} ${a.sex === "M" ? "♂" : "♀"}</small></td><td>${esc(a.member_code)} ${esc(a.member_name)}</td>
          <td>${st(a.status)}</td><td class="num">${a.lactation_no}</td><td>${d(a.last_calving_date)}</td>
          <td>${a.last_insemination_date ? d(a.last_insemination_date) : "-"} ${a.pregnant ? pill("ท้อง", "ok") : ""}</td><td>${d(a.expected_calving_date)}</td>
          <td>${a.withdrawal_until && iso(a.withdrawal_until) >= today() ? pill(d(a.withdrawal_until), "bad") : "-"}</td>
          <td><button class="mh-btn sm ghost" data-act="animal" data-id="${a.animal_id}">ประวัติ/บันทึก</button></td></tr>`))}
      </div>
      <div id="animalDetail"></div>`;
  };
  function eventFields(type) {
    const f = {
      insemination: '<div><label>รหัสน้ำเชื้อ/พ่อพันธุ์</label><input name="semen_code"></div><div><label>ผู้ผสม</label><input name="technician"></div>',
      pregnancy_check: '<div><label>ผล</label><select name="result"><option value="positive">ท้อง</option><option value="negative">ไม่ท้อง</option></select></div><div><label>วันที่ผสม (ถ้าไม่ใช่ครั้งล่าสุด)</label><input type="date" name="insemination_date"></div>',
      calving: '<div><label>เบอร์หูลูก</label><input name="calf_ear_tag"></div><div><label>เพศลูก</label><select name="calf_sex"><option value="F">เมีย</option><option value="M">ผู้</option></select></div>',
      treatment: '<div><label>อาการ/โรค</label><input name="diagnosis"></div><div><label>ยา</label><input name="drug"></div><div><label>ระยะหยุดยา (วัน)</label><input type="number" min="0" name="withdrawal_days"></div>',
      vaccination: '<div><label>วัคซีน</label><input name="vaccine"></div>',
      sold: '<div><label>ราคาขาย</label><input type="number" name="price"></div>',
    };
    return (f[type] || "") + '<div class="full"><label>หมายเหตุ</label><input name="note"></div>';
  }
  async function animalDetail(id, requestId) {
    const [a, vets] = await Promise.all([API.get(`/dairy/animals/${id}`), partners("vet")]);
    const box = $("#animalDetail") || $(`#reqRecord-${requestId}`);
    const type = requestId ? "treatment" : "heat";
    box.innerHTML = `<div class="mh-card"><h3>โค ${esc(a.ear_tag)} ${esc(a.name || "")} — ${STATUS_TH[a.status]}, ท้องที่ ${a.lactation_no}${a.pregnant ? `, ท้อง กำหนดคลอด ${d(a.expected_calving_date)}` : ""}</h3>
      <form data-form="event" data-id="${a.animal_id}" data-request="${requestId || ""}" class="mh-form">
        <div><label>เหตุการณ์</label><select name="event_type" data-act-change="eventType">${Object.entries(EVENT).map(([k, v]) => `<option value="${k}"${k === type ? " selected" : ""}>${v}</option>`).join("")}</select></div>
        <div><label>วันที่</label><input type="date" name="event_date" value="${today()}" max="${today()}"></div>
        <div><label>ค่าบริการ (บาท)</label><input type="number" min="0" name="cost" value="0"></div>
        <div><label>สัตวแพทย์</label><select name="vet_partner_id"><option value="">-</option>${opt(vets, "partner_id", "name")}</select></div>
        <div><label><input type="checkbox" name="charge_member" checked> หักค่าบริการจากบัญชีสมาชิก</label></div>
        <div class="full mh-form" id="evFields-${a.animal_id}" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">${eventFields(type)}</div>
        <div><button class="mh-btn">บันทึกเหตุการณ์</button></div></form>
      ${table(["วันที่", "เหตุการณ์", "รายละเอียด", "#ค่าบริการ", "สัตวแพทย์", "ผู้บันทึก"], a.events.map((e) => `<tr><td>${d(e.event_date)}</td><td>${EVENT[e.event_type]}</td>
        <td><small>${esc(Object.entries(e.details || {}).map(([k, v]) => `${k}: ${v}`).join(", "))}</small></td><td class="num">${Number(e.cost) ? baht(e.cost) : "-"}</td><td>${esc(e.vet_name || "")}</td><td><small>${esc(e.recorded_by || "")}</small></td></tr>`))}
    </div>`;
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---- คำขอสมาชิก ----
  PAGES.services = async (sec) => {
    const [rows, vets] = await Promise.all([API.get("/dairy/requests"), partners("vet")]);
    sec.innerHTML = `<div class="mh-card"><h3>คำขอจากสมาชิก (เบิกอาหาร เรียกสัตวแพทย์ ผสมเทียม)</h3>
      ${table(["วันที่", "สมาชิก", "ประเภท", "รายละเอียด", "สถานะ", "ดำเนินการ"], rows.map((r) => `<tr>
        <td>${dt(r.created_at)}</td><td>${esc(r.member_code)} ${esc(r.full_name)}</td><td>${REQ[r.request_type]}</td>
        <td>${r.request_type === "feed" ? `${esc(r.item_name)} ${n2(r.qty)} ${esc(r.unit || "")}` : `${r.ear_tag ? "โค " + esc(r.ear_tag) + " — " : ""}${esc(r.description || "")}`}
          ${r.has_photo ? `<br><a href="#" data-act="reqPhoto" data-id="${r.request_id}">ดูรูป</a><div id="photo-${r.request_id}"></div>` : ""}</td>
        <td>${st(r.status)}${r.partner_name ? `<br><small>${esc(r.partner_name)}</small>` : ""}</td>
        <td>${!["Open", "Assigned"].includes(r.status) ? "" : r.request_type === "feed"
    ? `<button class="mh-btn sm" data-act="fulfil" data-id="${r.request_id}">จ่ายของ (หักบัญชี)</button>`
    : `<form data-form="assign" data-id="${r.request_id}" class="mh-row"><select name="partner_id">${opt(vets, "partner_id", "name", r.assigned_partner_id)}</select><button class="mh-btn sm ghost">มอบหมาย</button></form>
            ${r.animal_id ? `<button class="mh-btn sm" data-act="recordReq" data-id="${r.request_id}" data-animal="${r.animal_id}">บันทึกผลเอง</button>` : ""}`}
          ${["Open", "Assigned"].includes(r.status) ? `<button class="mh-btn sm danger" data-act="cancelReq" data-id="${r.request_id}">ยกเลิก</button>` : ""}</td></tr>
        <tr><td colspan="6" id="reqRecord-${r.request_id}" style="padding:0;border:0"></td></tr>`))}
      ${vets.length ? "" : '<p class="mh-note">ยังไม่มีคู่ค้าประเภทสัตวแพทย์ — เพิ่มในแท็บสมาชิกและฟาร์ม › คู่ค้า</p>'}</div>`;
  };

  // ---- รับน้ำนม ----
  PAGES.intake = async (sec) => {
    const [rounds, centers] = await Promise.all([API.get("/dairy/rounds"), API.get("/dairy/centers")]);
    const hour = new Date(Date.now() + 7 * 3600e3).getUTCHours();
    sec.innerHTML = `
      <div class="mh-card"><h3>เปิดรอบรับนม</h3>
        <form data-form="openRound" class="mh-form">
          <div><label>ศูนย์รวบรวม</label><select name="center_id">${opt(centers.filter((c) => c.active), "center_id", "name")}</select></div>
          <div><label>วันที่</label><input type="date" name="round_date" value="${today()}" max="${today()}"></div>
          <div><label>รอบ</label><select name="shift"><option value="AM"${hour < 12 ? " selected" : ""}>เช้า</option><option value="PM"${hour >= 12 ? " selected" : ""}>เย็น</option></select></div>
          <div><button class="mh-btn">เปิด/ไปที่รอบ</button></div></form></div>
      <div id="roundBox"></div>
      <div class="mh-card"><h3>รอบล่าสุด</h3>
        ${table(["วันที่", "รอบ", "ศูนย์", "#ราย", "#รับ (กก.)", "#ปฏิเสธ", "#อุณหภูมิถัง", "#ยอดเงิน", "สถานะ", ""], rounds.map((r) => `<tr>
          <td>${d(r.round_date)}</td><td>${r.shift === "AM" ? "เช้า" : "เย็น"}</td><td>${esc(r.center_name)}</td><td class="num">${r.intakes}</td>
          <td class="num">${n2(r.status === "Open" ? r.live_accepted_kg : r.accepted_kg)}</td><td class="num">${n2(r.rejected_kg)}</td><td class="num">${r.tank_temp_c == null ? "-" : n2(r.tank_temp_c) + "°C"}</td>
          <td class="num">${r.status === "Closed" ? baht(r.amount) : "-"}</td><td>${st(r.status)}</td>
          <td><button class="mh-btn sm ghost" data-act="round" data-id="${r.round_id}">${r.status === "Open" ? "บันทึก" : "ดู"}</button></td></tr>`))}
      </div>`;
    if (cache.roundId) await renderRound(cache.roundId);
  };
  async function renderRound(id) {
    cache.roundId = id;
    const r = await API.get(`/dairy/rounds/${id}`);
    cache.round = r;
    const box = $("#roundBox");
    if (!box) return;
    const acc = r.intakes.filter((i) => i.status === "Accepted").reduce((a, i) => a + Number(i.weight_kg), 0);
    box.innerHTML = `<div class="mh-card"><h3>รอบ${r.shift === "AM" ? "เช้า" : "เย็น"} ${d(r.round_date)} — ${st(r.status)} รับแล้ว ${n2(acc)} กก. (${r.intakes.length} ราย) ค้าง ${r.pending.length} ราย</h3>
      ${r.status === "Open" ? `<form data-form="intake" class="mh-quick" autocomplete="off">
        <div><label>สมาชิก (รหัสหรือเลือก)</label><input name="member_code" list="memberCodes" placeholder="D0001" required>
          <datalist id="memberCodes">${r.pending.map((m) => `<option value="${esc(m.member_code)}">${esc(m.full_name)}${m.withdrawal_cows ? " ⚠ หยุดยา" : ""}</option>`).join("")}</datalist></div>
        <div><label>น้ำหนัก (กก.)</label><input name="weight_kg" type="number" step="0.1" min="0.1" required></div>
        <div><button class="mh-btn" style="padding:13px 18px">บันทึก ↵</button></div>
        <div class="rej"><label><input type="checkbox" name="reject">ปฏิเสธนม เพราะ</label><select name="reject_reason">${Object.entries(REJ).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
        <div><input name="sample_no" placeholder="เลขตัวอย่าง (ถ้ามี)" style="font-size:15px;padding:9px"></div>
      </form>` : ""}
      ${table(["รหัส", "สมาชิก", "#กก.", "ผล", "#ราคา/กก.", "#เงิน", "ที่มา", ""], r.intakes.map((i) => `<tr><td>${esc(i.member_code)}</td><td>${esc(i.full_name)}</td><td class="num">${n2(i.weight_kg)}</td>
        <td>${i.status === "Accepted" ? pill("รับ", "ok") : pill("ปฏิเสธ: " + (REJ[i.reject_reason] || ""), "bad")}</td>
        <td class="num">${i.price_per_kg == null ? "-" : baht(i.price_per_kg)}${i.price_detail && i.price_detail.no_test ? ' <small title="ยังไม่มีผลตรวจ">*</small>' : ""}</td><td class="num">${i.amount == null ? "-" : baht(i.amount)}</td>
        <td><small>${i.source === "scale" ? "เครื่องชั่ง" : "บันทึกมือ"}</small></td>
        <td>${r.status === "Open" ? `<button class="mh-btn sm danger" data-act="delIntake" data-id="${i.intake_id}">ลบ</button>` : ""}</td></tr>`))}
      ${r.pending.length && r.status === "Open" ? `<p class="mh-note">ยังไม่ส่งนม: ${r.pending.map((m) => `${esc(m.member_code)} ${esc(m.full_name)}${m.withdrawal_cows ? " ⚠️" : ""}`).join(", ")}</p>` : ""}
      ${r.status === "Open" ? `<form data-form="closeRound" class="mh-form" style="margin-top:12px"><div><label>อุณหภูมิถังเย็นตอนปิดรอบ (°C)</label><input name="tank_temp_c" type="number" step="0.1"></div>
        <div><button class="mh-btn warn">ปิดรอบและคำนวณเงิน</button></div><div class="full mh-note">ปิดแล้วระบบคิดราคาตามผลตรวจคุณภาพล่าสุดของสมาชิกแต่ละราย และบันทึกค่าน้ำนมเข้าบัญชีสมาชิก</div></form>` : ""}
    </div>`;
    const inp = box.querySelector('[name="member_code"]');
    if (inp) inp.focus();
  }

  // ---- คุณภาพและราคา ----
  PAGES.quality = async (sec) => {
    const [ms, sum, s] = await Promise.all([members(), API.get("/dairy/quality/summary"), API.get("/dairy/settings")]);
    sec.innerHTML = `
      <div class="mh-card"><h3>บันทึกผลตรวจคุณภาพน้ำนม</h3>
        <form data-form="test" class="mh-form">
          <div><label>สมาชิก</label><select name="member_id">${opt(ms.filter((m) => m.status === "Approved"), "member_id", (m) => `${m.member_code} ${m.full_name}`)}</select></div>
          <div><label>วันที่เก็บตัวอย่าง</label><input type="date" name="sample_date" value="${today()}"></div>
          <div><label>ไขมัน (%)</label><input type="number" step="0.01" name="fat_pct"></div><div><label>SNF (%)</label><input type="number" step="0.01" name="snf_pct"></div>
          <div><label>โปรตีน (%)</label><input type="number" step="0.01" name="protein_pct"></div><div><label>SCC (พัน/มล.)</label><input type="number" name="scc_k"></div>
          <div><label>TBC (พัน/มล.)</label><input type="number" name="tbc_k"></div><div><label>แล็บ</label><input name="lab_name"></div>
          <div><label><input type="checkbox" name="antibiotic_pos"> พบยาปฏิชีวนะ</label></div><div><button class="mh-btn">บันทึก</button></div></form>
        <details style="margin-top:10px"><summary>นำเข้าผลแล็บหลายรายการ (วางข้อความ)</summary>
          <form data-form="testBulk" class="mh-form" style="margin-top:8px"><div class="full"><label>หนึ่งบรรทัดต่อราย: รหัสสมาชิก, ไขมัน, SNF, SCC, TBC</label>
            <textarea name="rows" rows="5" placeholder="D0001, 3.9, 8.6, 250, 80"></textarea></div><div><label>วันที่</label><input type="date" name="sample_date" value="${today()}"></div><div><button class="mh-btn">นำเข้า</button></div></form></details></div>
      <div class="mh-card"><h3>ราคาที่สมาชิกจะได้ (ราคาฐาน ${baht(sum.base_price_per_kg)} บาท/กก. ± ตารางคุณภาพ)</h3>
        ${table(["รหัส", "สมาชิก", "ตรวจล่าสุด", "#ไขมัน", "#SNF", "#SCC", "#TBC", "การปรับ", "#ราคา/กก."], sum.members.map((m) => `<tr><td>${esc(m.member_code)}</td><td>${esc(m.full_name)}</td>
          <td>${m.sample_date ? d(m.sample_date) : pill("ยังไม่มีผล", "warn")}${m.antibiotic_pos ? " " + pill("ยาตกค้าง", "bad") : ""}</td><td class="num">${n2(m.fat_pct)}</td><td class="num">${n2(m.snf_pct)}</td><td class="num">${n2(m.scc_k)}</td><td class="num">${n2(m.tbc_k)}</td>
          <td><small>${m.detail.adjustments.map((a) => `${a.param} ${a.adjust > 0 ? "+" : ""}${a.adjust}`).join(", ") || "-"}</small></td><td class="num"><b>${baht(m.price)}</b></td></tr>`))}</div>
      <div class="mh-card"><h3>ตารางบวก/หักราคาตามคุณภาพ</h3>
        <form data-form="rule" class="mh-form">
          <div><label>ค่าที่ใช้</label><select name="param">${Object.entries(PARAM).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
          <div><label>ตั้งแต่ (≥) ว่าง=ไม่จำกัด</label><input type="number" step="0.01" name="min_value"></div><div><label>ต่ำกว่า (&lt;) ว่าง=ไม่จำกัด</label><input type="number" step="0.01" name="max_value"></div>
          <div><label>บวก/หัก (บาท/กก.)</label><input type="number" step="0.01" name="adjust_per_kg" required></div><div><button class="mh-btn">เพิ่มเกณฑ์</button></div></form>
        ${table(["ค่าที่ใช้", "ช่วง", "#บาท/กก.", "สถานะ", ""], s.quality_rules.map((r) => `<tr><td>${PARAM[r.param]}</td><td>${r.min_value == null ? "" : "≥ " + n2(r.min_value)} ${r.max_value == null ? "" : "< " + n2(r.max_value)}</td>
          <td class="num">${Number(r.adjust_per_kg) > 0 ? "+" : ""}${baht(r.adjust_per_kg)}</td><td>${r.active ? pill("ใช้", "ok") : pill("ปิด", "bad")}</td>
          <td><button class="mh-btn sm ghost" data-act="toggleRule" data-id="${r.rule_id}" data-active="${r.active ? "0" : "1"}">${r.active ? "ปิด" : "เปิด"}</button></td></tr>`))}
        <p class="mh-note">ระบบใช้ผลตรวจล่าสุด ณ วันที่รับนมกับทุกรอบจนกว่าจะมีผลใหม่ การแก้เกณฑ์ถูกเก็บประวัติในแท็บตั้งค่า</p></div>`;
  };

  // ---- สัญญาและส่งโรงงาน ----
  PAGES.factory = async (sec) => {
    const [procs, contracts, ships, centers, sur] = await Promise.all([partners("processor"), API.get("/dairy/contracts"), API.get("/dairy/shipments"), API.get("/dairy/centers"), API.get("/dairy/surplus")]);
    const deals = sur.offers.flatMap((o) => o.proposals.filter((p) => p.status === "Accepted").map((p) => ({ ...p, label: `${p.processor} ${n2(p.kg_per_day)} กก./วัน @${baht(p.price_per_kg)}` })));
    cache.deals = deals;
    const active = contracts.filter((k) => k.status === "Active");
    sec.innerHTML = `
      <div class="mh-card"><h3>บันทึกเที่ยวส่งนมดิบ</h3>
        <form data-form="ship" class="mh-form">
          <div><label>ส่งตาม</label><select name="ref">${active.map((k) => `<option value="contract:${k.contract_id}">สัญญา ${esc(k.contract_no || "")} ${esc(k.partner_name)}</option>`).join("")}
            ${deals.map((p) => `<option value="proposal:${p.proposal_id}">ตลาดส่วนเกิน: ${esc(p.label)}</option>`).join("")}${procs.map((p) => `<option value="partner:${p.partner_id}">ขายครั้งเดียว: ${esc(p.name)}</option>`).join("")}</select></div>
          <div><label>วันที่</label><input type="date" name="ship_date" value="${today()}"></div>
          <div><label>ศูนย์</label><select name="center_id">${opt(centers, "center_id", "name")}</select></div>
          <div><label>น้ำหนักส่ง (กก.)</label><input type="number" step="0.1" name="sent_kg" required></div><div><label>อุณหภูมิถังรถ (°C)</label><input type="number" step="0.1" name="tank_temp_c"></div>
          <div><label>ทะเบียนรถ</label><input name="vehicle"></div><div><label>คนขับ</label><input name="driver_name"></div><div><button class="mh-btn">บันทึก</button></div></form></div>
      <div class="mh-card"><h3>เที่ยวส่งนม</h3>
        ${table(["วันที่", "โรงงาน", "อ้างอิง", "#ส่ง (กก.)", "#รับ (กก.)", "คุณภาพปลายทาง", "#ราคา", "#ยอดเงิน", "สถานะ", ""], ships.map((s) => `<tr>
          <td>${d(s.ship_date)}</td><td>${esc(s.partner_name)}</td><td>${s.contract_no ? "สัญญา " + esc(s.contract_no) : s.proposal_id ? pill("ส่วนเกิน", "warn") : "-"}</td>
          <td class="num">${n2(s.sent_kg)}</td><td class="num">${n2(s.received_kg)}</td><td><small>${s.fat_pct ? `F ${n2(s.fat_pct)} S ${n2(s.snf_pct)} SCC ${n2(s.scc_k)}` : ""}${s.reject_reason ? esc(s.reject_reason) : ""}</small></td>
          <td class="num">${s.price_per_kg ? baht(s.price_per_kg) : "-"}</td><td class="num">${s.amount ? baht(s.amount) : "-"}</td><td>${st(s.status)}${s.paid_at ? " " + pill("ได้รับเงิน", "ok") : ""}</td>
          <td class="mh-row">${s.status === "Sent" ? `<button class="mh-btn sm" data-act="receiveForm" data-id="${s.shipment_id}">บันทึกผลโรงงาน</button><button class="mh-btn sm danger" data-act="cancelShip" data-id="${s.shipment_id}">ยกเลิก</button>` : ""}
            ${s.status === "Received" && !s.paid_at ? `<button class="mh-btn sm ghost" data-act="shipPaid" data-id="${s.shipment_id}">ได้รับเงินแล้ว</button>` : ""}</td></tr>
          <tr><td colspan="10" id="recv-${s.shipment_id}" style="padding:0;border:0"></td></tr>`))}
        <p class="mh-note">โรงงานที่ผูกบัญชีไว้ยืนยันน้ำหนักและผลตรวจเองได้ในพอร์ทัลคู่ค้า</p></div>
      <div class="mh-card"><h3>สัญญารับซื้อ (MOU)</h3>
        <form data-form="contract" class="mh-form">
          <div><label>โรงงาน</label><select name="partner_id">${opt(procs, "partner_id", "name")}</select></div><div><label>เลขที่สัญญา</label><input name="contract_no"></div>
          <div><label>เริ่ม</label><input type="date" name="start_date" required></div><div><label>สิ้นสุด</label><input type="date" name="end_date" required></div>
          <div><label>ปริมาณ (กก./วัน)</label><input type="number" name="daily_kg" required></div><div><label>ราคา (บาท/กก.)</label><input type="number" step="0.01" name="price_per_kg" required></div>
          <div><label>ชำระเงินภายใน (วัน)</label><input type="number" name="payment_days" value="15"></div><div><button class="mh-btn">บันทึกสัญญา</button></div></form>
        ${table(["เลขที่", "โรงงาน", "ช่วง", "#กก./วัน", "#ราคา", "#ส่งแล้ว (กก.)", "สถานะ", ""], contracts.map((k) => `<tr><td>${esc(k.contract_no || "-")}</td><td>${esc(k.partner_name)}</td>
          <td>${d(k.start_date)} – ${d(k.end_date)}</td><td class="num">${n2(k.daily_kg)}</td><td class="num">${baht(k.price_per_kg)}</td><td class="num">${n2(k.delivered_kg)}</td><td>${st(k.status)}</td>
          <td>${k.status === "Active" ? `<button class="mh-btn sm ghost" data-act="endContract" data-id="${k.contract_id}">สิ้นสุด</button>` : ""}</td></tr>`))}</div>`;
  };

  // ---- ตลาดนมส่วนเกิน ----
  PAGES.surplus = async (sec) => {
    const s = await API.get("/dairy/surplus");
    const open = s.offers.filter((o) => o.status === "Open");
    sec.innerHTML = `
      <div class="mh-card"><h3>ประกาศน้ำนมส่วนเกิน</h3>
        <form data-form="offer" class="mh-form">
          <div><label>เริ่มวันที่</label><input type="date" name="start_date" value="${today()}" min="${today()}"></div><div><label>จำนวนวัน</label><input type="number" name="days" min="1" max="90" value="7"></div>
          <div><label>ปริมาณ (กก./วัน)</label><input type="number" name="kg_per_day" required></div><div><label>ราคาขั้นต่ำ (บาท/กก.)</label><input type="number" step="0.01" name="min_price"></div>
          <div class="full"><label>หมายเหตุ (เช่น ระยะทาง เงื่อนไขขนส่ง)</label><input name="note"></div><div><button class="mh-btn">ประกาศ</button></div></form>
        <p class="mh-note">โรงงานที่ลงทะเบียนในตลาดเห็นประกาศ (ชื่อสหกรณ์ จังหวัด ปริมาณ ไขมัน/SNF เฉลี่ย 30 วัน) แล้วเสนอราคา — เลือกตอบรับได้ข้อเสนอเดียว</p></div>
      <div class="mh-card"><h3>ประกาศของสหกรณ์</h3>
        ${s.offers.length ? s.offers.map((o) => `<div style="border-bottom:1px solid var(--gray-100);padding:10px 0">
          <b>${d(o.start_date)} · ${o.days} วัน · ${n2(o.kg_per_day)} กก./วัน</b> ขั้นต่ำ ${baht(o.min_price)} ${st(o.status)}
          ${o.status === "Open" ? `<button class="mh-btn sm danger" data-act="offerEnd" data-id="${o.offer_id}" data-action="cancel">ยกเลิก</button>` : ""}${o.status === "Matched" ? `<button class="mh-btn sm ghost" data-act="offerEnd" data-id="${o.offer_id}" data-action="close">ปิดประกาศ</button>` : ""}
          ${o.proposals.length ? table(["โรงงาน", "#กก./วัน", "#ราคา", "เสนอโดย", "สถานะ", ""], o.proposals.map((p) => `<tr><td>${esc(p.processor)}</td><td class="num">${n2(p.kg_per_day)}</td><td class="num">${baht(p.price_per_kg)}</td>
            <td>${p.proposed_by === "coop" ? "สหกรณ์ (รอโรงงาน)" : "โรงงาน"}</td><td>${st(p.status)}</td>
            <td>${p.status === "Pending" && p.proposed_by === "processor" ? `<button class="mh-btn sm" data-act="proposal" data-id="${p.proposal_id}" data-action="accept">ตอบรับ</button> <button class="mh-btn sm ghost" data-act="proposal" data-id="${p.proposal_id}" data-action="reject">ปฏิเสธ</button>` : ""}</td></tr>`)) : '<div class="mh-empty">ยังไม่มีข้อเสนอ</div>'}</div>`).join("") : '<div class="mh-empty">ยังไม่มีประกาศ</div>'}</div>
      <div class="mh-card"><h3>กำลังรับนมว่างของโรงงาน</h3>
        ${table(["โรงงาน", "จังหวัด", "ผลิตภัณฑ์", "ช่วง", "#กก./วัน", "#ราคา", "เสนอขาย"], s.capacities.map((k) => `<tr><td>${esc(k.display_name)}</td><td>${esc(k.province_name_th || "-")}</td><td><small>${esc(k.products || "")}</small></td>
          <td>${d(k.available_from)} – ${d(k.available_to)}</td><td class="num">${n2(k.kg_per_day)}</td><td class="num">${baht(k.price_per_kg)}</td>
          <td>${open.length ? `<form data-form="proposeCap" data-cap="${k.capacity_id}" class="mh-row"><select name="offer_id">${opt(open, "offer_id", (o) => `${d(o.start_date)} ${n2(o.kg_per_day)} กก.`)}</select><button class="mh-btn sm">เสนอ</button></form>` : '<small>ประกาศส่วนเกินก่อน</small>'}</td></tr>`))}</div>`;
  };

  // ---- อาหารสัตว์ ----
  PAGES.feed = async (sec) => {
    const [items, pos, issues, sups, ms] = await Promise.all([API.get("/dairy/items"), API.get("/dairy/purchase-orders"), API.get("/dairy/issues"), partners("feed_supplier"), members()]);
    cache.items = items;
    sec.innerHTML = `
      <div class="mh-card"><h3>สต็อกคลังสหกรณ์</h3>
        ${table(["รายการ", "หมวด", "#คงเหลือ", "#ต้นทุนเฉลี่ย", "ราคาขายสมาชิก", ""], items.map((i) => `<tr${Number(i.stock) < Number(i.reorder_level) ? ' style="background:var(--gold-100)"' : ""}>
          <td>${esc(i.name)}</td><td>${CAT[i.category]}</td><td class="num">${n2(i.stock)} ${esc(i.unit)}</td><td class="num">${baht(i.avg_cost)}</td>
          <td><form data-form="itemPrice" data-id="${i.item_id}" class="mh-row"><input type="number" step="0.01" name="sell_price" value="${Number(i.sell_price)}" style="width:90px"><button class="mh-btn sm ghost">บันทึก</button></form></td>
          <td>${Number(i.sell_price) ? "" : pill("ยังไม่ตั้งราคา", "warn")}</td></tr>`))}
        <details style="margin-top:8px"><summary>➕ เพิ่มรายการ</summary><form data-form="item" class="mh-form" style="margin-top:8px">
          <div><label>ชื่อ</label><input name="name" required></div><div><label>หมวด</label><select name="category">${Object.entries(CAT).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
          <div><label>หน่วย</label><input name="unit" value="กก."></div><div><label>ราคาขายสมาชิก</label><input type="number" step="0.01" name="sell_price"></div><div><label>จุดสั่งซื้อ</label><input type="number" name="reorder_level"></div>
          <div><button class="mh-btn">เพิ่ม</button></div></form></details></div>
      <div class="mh-card"><h3>สมาชิกเบิก (เชื่อ หักจากค่านม)</h3>
        <form data-form="issue" class="mh-form">
          <div><label>สมาชิก</label><select name="member_id">${opt(ms.filter((m) => m.status === "Approved"), "member_id", (m) => `${m.member_code} ${m.full_name}`)}</select></div>
          <div><label>รายการ</label><select name="item_id">${opt(items.filter((i) => i.active), "item_id", (i) => `${i.name} (${n2(i.stock)} ${i.unit})`)}</select></div>
          <div><label>จำนวน</label><input type="number" step="0.01" name="qty" required></div><div><label>ราคา/หน่วย (ว่าง = ราคาขาย)</label><input type="number" step="0.01" name="unit_price"></div>
          <div><button class="mh-btn">บันทึกการเบิก</button></div></form>
        ${table(["วันที่", "สมาชิก", "รายการ", "#จำนวน", "#เงิน"], issues.slice(0, 50).map((x) => `<tr><td>${dt(x.issued_at)}</td><td>${esc(x.member_code)} ${esc(x.full_name)}</td><td>${esc(x.item_name)}</td><td class="num">${n2(x.qty)} ${esc(x.unit)}</td><td class="num">${baht(x.amount)}</td></tr>`))}</div>
      <div class="mh-card"><h3>ใบสั่งซื้อจากผู้ขาย</h3>
        <form data-form="po" class="mh-form">
          <div><label>ผู้ขาย</label><select name="partner_id">${opt(sups, "partner_id", "name")}</select></div><div><label>ต้องการวันที่</label><input type="date" name="expected_date"></div>
          <div class="full" id="poLines"></div><div><button type="button" class="mh-btn ghost" data-act="addPoLine">+ รายการ</button></div><div><button class="mh-btn">สร้างใบสั่งซื้อ</button></div></form>
        ${sups.length ? "" : '<p class="mh-note">ยังไม่มีคู่ค้าประเภทผู้ขายอาหารสัตว์ — เพิ่มในแท็บสมาชิกและฟาร์ม</p>'}
        ${table(["วันที่", "ผู้ขาย", "รายการ", "#ยอด", "#ค่าบริการ (ผู้ขายจ่าย)", "สถานะ", ""], pos.map((p) => `<tr><td>${dt(p.ordered_at)}</td><td>${esc(p.partner_name)}</td>
          <td><small>${p.lines.map((l) => `${esc(l.name)} ${n2(l.qty)} ${esc(l.unit)} × ${baht(l.unit_price)}`).join("<br>")}</small></td><td class="num">${baht(p.total_amount)}</td>
          <td class="num">${p.fee_amount != null ? baht(p.fee_amount) : "-"}</td><td>${st(p.status)}${p.paid_at ? " " + pill("จ่ายแล้ว", "ok") : ""}</td>
          <td class="mh-row">${["Ordered", "Confirmed"].includes(p.status) ? `<button class="mh-btn sm" data-act="poDeliver" data-id="${p.po_id}">รับของเข้าคลัง</button><button class="mh-btn sm danger" data-act="poCancel" data-id="${p.po_id}">ยกเลิก</button>` : ""}
            ${p.status === "Delivered" && !p.paid_at ? `<button class="mh-btn sm ghost" data-act="poPaid" data-id="${p.po_id}">จ่ายเงินแล้ว</button>` : ""}</td></tr>`))}</div>`;
    addPoLine();
  };
  function addPoLine() {
    const box = $("#poLines");
    if (!box) return;
    const div = document.createElement("div");
    div.className = "mh-form";
    div.style.marginBottom = "6px";
    div.innerHTML = `<div><select data-line="item_id">${opt(cache.items || [], "item_id", "name")}</select></div><div><input type="number" step="0.01" placeholder="จำนวน" data-line="qty"></div><div><input type="number" step="0.01" placeholder="ราคา/หน่วย" data-line="unit_price"></div>`;
    box.appendChild(div);
  }

  // ---- แปรรูป ----
  PAGES.processing = async (sec) => {
    const [products, batches, sales, buyers] = await Promise.all([API.get("/dairy/products"), API.get("/dairy/batches"), API.get("/dairy/product-sales"), partners("product_buyer")]);
    const live = batches.filter((b) => b.units_left > 0 && !b.expired);
    sec.innerHTML = `
      ${cache.overview && !cache.overview.has_processing_plant ? '<div class="mh-card" style="background:var(--gold-100)">สหกรณ์ยังไม่ได้ระบุว่ามีโรงนมแปรรูป — เปิดได้ที่แท็บตั้งค่า (ใช้แท็บนี้ได้ตามปกติ)</div>' : ""}
      <div class="mh-card"><h3>ผลิตภัณฑ์</h3>
        <form data-form="product" class="mh-form">
          <div><label>ชื่อ</label><input name="name" required placeholder="นมพาสเจอร์ไรส์ 200 มล."></div><div><label>ประเภท</label><select name="product_type">${Object.entries(PROD).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
          <div><label>หน่วย</label><input name="unit" value="ถุง"></div><div><label>นมดิบต่อหน่วย (กก.)</label><input type="number" step="0.001" name="milk_kg_per_unit" required></div>
          <div><label>อายุสินค้า (วัน)</label><input type="number" name="shelf_life_days" required></div><div><label>ราคาขาย/หน่วย</label><input type="number" step="0.01" name="sell_price"></div><div><button class="mh-btn">เพิ่ม</button></div></form>
        ${table(["ผลิตภัณฑ์", "ประเภท", "#นมดิบ/หน่วย", "#อายุ (วัน)", "#ราคา", "#คงเหลือ"], products.map((p) => `<tr><td>${esc(p.name)}</td><td>${PROD[p.product_type]}</td><td class="num">${n2(p.milk_kg_per_unit)}</td><td class="num">${p.shelf_life_days}</td><td class="num">${baht(p.sell_price)}</td><td class="num">${n2(p.units_in_stock)} ${esc(p.unit)}</td></tr>`))}</div>
      <div class="mh-card"><h3>บันทึกการผลิต</h3>
        <form data-form="batch" class="mh-form">
          <div><label>ผลิตภัณฑ์</label><select name="product_id">${opt(products.filter((p) => p.active), "product_id", "name")}</select></div><div><label>วันที่ผลิต</label><input type="date" name="produced_on" value="${today()}" max="${today()}"></div>
          <div><label>จำนวนหน่วย</label><input type="number" name="units" required></div><div><label>นมดิบที่ใช้ (กก., ว่าง=คำนวณ)</label><input type="number" step="0.1" name="milk_used_kg"></div><div><button class="mh-btn">บันทึก</button></div></form>
        ${table(["ล็อต", "ผลิตภัณฑ์", "ผลิต", "หมดอายุ", "#ผลิต", "#คงเหลือ", "#นมดิบ (กก.)"], batches.map((b) => `<tr${b.units_left && b.days_left <= 3 ? ' style="background:var(--gold-100)"' : ""}>
          <td>${esc(b.lot_code)}</td><td>${esc(b.product_name)}</td><td>${d(b.produced_on)}</td><td>${d(b.expires_on)} ${b.expired ? pill("หมดอายุ", "bad") : b.units_left && b.days_left <= 3 ? pill(`อีก ${b.days_left} วัน`, "warn") : ""}</td>
          <td class="num">${b.units}</td><td class="num">${b.units_left}</td><td class="num">${n2(b.milk_used_kg)}</td></tr>`))}</div>
      <div class="mh-card"><h3>ขายผลิตภัณฑ์</h3>
        <form data-form="sale" class="mh-form">
          <div><label>ล็อต</label><select name="batch_id">${opt(live, "batch_id", (b) => `${b.lot_code} ${b.product_name} (เหลือ ${b.units_left})`)}</select></div>
          <div><label>ผู้ซื้อ (คู่ค้า)</label><select name="partner_id"><option value="">— ระบุชื่อเอง —</option>${opt(buyers, "partner_id", "name")}</select></div><div><label>ชื่อผู้ซื้อ</label><input name="buyer_name"></div>
          <div><label>จำนวน</label><input type="number" name="units" required></div><div><label>ราคา/หน่วย (ว่าง=ราคาขาย)</label><input type="number" step="0.01" name="unit_price"></div><div><button class="mh-btn">บันทึกการขาย</button></div></form>
        ${table(["วันที่", "ผู้ซื้อ", "ผลิตภัณฑ์/ล็อต", "#จำนวน", "#ยอด", "#ค่าบริการ"], sales.slice(0, 60).map((s) => `<tr><td>${d(s.sold_on)}</td><td>${esc(s.buyer || "")}</td><td>${esc(s.product_name)} <small>${esc(s.lot_code)}</small></td>
          <td class="num">${s.units} ${esc(s.unit)}</td><td class="num">${baht(s.amount)}</td><td class="num">${baht(s.fee_amount)}</td></tr>`))}</div>`;
  };

  // ---- นมโรงเรียน ----
  PAGES.school = async (sec) => {
    const [schools, terms, dels, products, batches] = await Promise.all([API.get("/dairy/schools"), API.get("/dairy/school-terms"), API.get("/dairy/school-deliveries"), API.get("/dairy/products"), API.get("/dairy/batches")]);
    const live = batches.filter((b) => b.units_left > 0 && !b.expired);
    const confirmUrl = (t) => `${location.origin}${location.pathname.replace(/coop\/dairy\.html$/, "")}dairy-school-confirm.html?t=${t}`;
    sec.innerHTML = `
      <div class="mh-card"><h3>ส่งนมโรงเรียน (−7 ถึง +14 วัน)</h3>
        <form data-form="planSchool" class="mh-form"><div><label>วางแผนตั้งแต่</label><input type="date" name="from" value="${today()}"></div><div><label>ถึง</label><input type="date" name="to" value="${addDays(today(), 13)}"></div>
          <div><button class="mh-btn">สร้างแผนส่งตามภาคเรียน</button></div></form>
        ${table(["วันที่", "โรงเรียน", "#หน่วย", "ล็อต", "สถานะ", "ยืนยันรับ", ""], dels.map((x) => `<tr><td>${d(x.delivery_date)}</td><td>${esc(x.school_name)}</td><td class="num">${x.units} ${esc(x.unit || "")}</td>
          <td>${esc(x.lot_code || "")}</td><td>${st(x.status)}${x.issue_note ? `<br><small>${esc(x.issue_note)}</small>` : ""}</td>
          <td>${x.received_units != null ? `${x.received_units} ${esc(x.unit || "")}` : x.status === "Delivered" ? `<a href="${esc(confirmUrl(x.confirm_token))}" target="_blank" rel="noopener">ลิงก์ QR ให้โรงเรียน</a>` : ""}</td>
          <td>${x.status === "Planned" ? `<form data-form="deliverSchool" data-id="${x.delivery_id}" class="mh-row"><select name="batch_id">${opt(live, "batch_id", (b) => `${b.lot_code} (${b.units_left})`)}</select><button class="mh-btn sm">ส่งแล้ว</button></form><button class="mh-btn sm danger" data-act="cancelSchool" data-id="${x.delivery_id}">ยกเลิก</button>` : ""}</td></tr>`))}
        <p class="mh-note">เมื่อกด "ส่งแล้ว" ระบบตัดสต็อกล็อตและบันทึกยอดขาย จากนั้นให้โรงเรียนสแกน QR (ลิงก์) เพื่อยืนยันจำนวนที่ได้รับจริง</p></div>
      <div class="mh-card"><h3>โรงเรียน</h3>
        <form data-form="schoolAdd" class="mh-form">
          <div><label>ชื่อโรงเรียน</label><input name="name" required></div><div><label>อำเภอ</label><input name="district"></div><div><label>จังหวัด</label><input name="province"></div>
          <div><label>จำนวนนักเรียน</label><input type="number" name="students" required></div><div><label>ผลิตภัณฑ์</label><select name="product_id">${opt(products, "product_id", "name")}</select></div>
          <div><label>หน่วยต่อคนต่อวัน</label><input type="number" step="0.5" name="units_per_student_day" value="1"></div>
          <div><label>วันส่ง</label><div class="mh-row">${WD.map((w, i) => `<label style="font-weight:400"><input type="checkbox" data-wd="${i}"${i >= 1 && i <= 5 ? " checked" : ""}> ${w}</label>`).join("")}</div></div>
          <div><label>ผู้ติดต่อ</label><input name="contact_name"></div><div><label>โทร</label><input name="phone"></div><div><button class="mh-btn">เพิ่มโรงเรียน</button></div></form>
        ${table(["โรงเรียน", "พื้นที่", "#นักเรียน", "ผลิตภัณฑ์", "วันส่ง", "#ยืนยันรับ", "#มีปัญหา"], schools.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.district || "")} ${esc(s.province || "")}</td>
          <td class="num">${s.students}</td><td>${esc(s.product_name || "-")}</td><td>${s.delivery_weekdays.map((w) => WD[w]).join(" ")}</td><td class="num">${s.confirmed}</td><td class="num">${s.issues}</td></tr>`))}</div>
      <div class="mh-card"><h3>ภาคเรียน (ไม่มีภาคเรียน = ไม่วางแผนส่ง)</h3>
        <form data-form="term" class="mh-form"><div><label>ชื่อ</label><input name="name" placeholder="ภาคเรียนที่ 2/2569" required></div><div><label>เริ่ม</label><input type="date" name="start_date" required></div>
          <div><label>สิ้นสุด</label><input type="date" name="end_date" required></div><div><label>เฉพาะโรงเรียน (ว่าง=ทุกโรงเรียน)</label><select name="school_id"><option value="">ทุกโรงเรียน</option>${opt(schools, "school_id", "name")}</select></div>
          <div><button class="mh-btn">เพิ่มภาคเรียน</button></div></form>
        ${table(["ภาคเรียน", "โรงเรียน", "ช่วง"], terms.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.school_name || "ทุกโรงเรียน")}</td><td>${d(t.start_date)} – ${d(t.end_date)}</td></tr>`))}</div>`;
  };

  // ---- ไบโอแก๊ส ----
  PAGES.biogas = async (sec) => {
    const [g, ms] = await Promise.all([API.get("/dairy/biogas"), members()]);
    const t = g.totals_90d;
    sec.innerHTML = `
      <div class="mh-grid">
        <div class="mh-stat"><small>มูลโคเข้าบ่อ 90 วัน</small><b>${n2(Number(t.manure_kg) / 1000)}</b> <small>ตัน</small></div>
        <div class="mh-stat"><small>ก๊าซชีวภาพ</small><b>${n2(t.gas_m3)}</b> <small>ลบ.ม.</small></div>
        <div class="mh-stat"><small>ไฟฟ้าที่ผลิต</small><b>${n2(t.electricity_kwh)}</b> <small>kWh</small></div>
        <div class="mh-stat"><small>ขายกากเป็นปุ๋ย</small><b>${n2(t.digestate_sold_kg)}</b> <small>กก. · ${baht(t.digestate_revenue)} บาท</small></div>
      </div>
      <div class="mh-card" style="margin-top:16px"><h3>บันทึกบ่อหมัก</h3>
        <form data-form="biogas" class="mh-form">
          <div><label>ชื่อบ่อ/ที่ตั้ง</label><input name="site_name" required></div><div><label>ฟาร์มสมาชิก</label><select name="member_id"><option value="">บ่อรวมของสหกรณ์</option>${opt(ms, "member_id", (m) => `${m.member_code} ${m.full_name}`)}</select></div>
          <div><label>วันที่</label><input type="date" name="log_date" value="${today()}" max="${today()}"></div><div><label>มูลโค (กก.)</label><input type="number" name="manure_kg"></div>
          <div><label>ก๊าซ (ลบ.ม.)</label><input type="number" step="0.1" name="gas_m3"></div><div><label>ไฟฟ้า (kWh)</label><input type="number" step="0.1" name="electricity_kwh"></div>
          <div><label>กากที่ได้ (กก.)</label><input type="number" name="digestate_kg"></div><div><label>กากที่ขาย (กก.)</label><input type="number" name="digestate_sold_kg"></div><div><label>รายได้จากกาก (บาท)</label><input type="number" name="digestate_revenue"></div>
          <div><button class="mh-btn">บันทึก</button></div></form>
        <p class="mh-note">ข้อมูลบ่อหมักใช้เป็นหลักฐานประกอบโครงการคาร์บอนระดับสหกรณ์ในโมดูลคาร์บอนของ AgroLink ได้ (ระบบไม่คำนวณคาร์บอนเครดิตให้เองในหน้านี้)</p></div>
      <div class="mh-card">${table(["วันที่", "บ่อ", "ฟาร์ม", "#มูลโค", "#ก๊าซ", "#kWh", "#กาก", "#ขาย", "#รายได้"], g.logs.map((x) => `<tr><td>${d(x.log_date)}</td><td>${esc(x.site_name)}</td><td>${esc(x.member_name || "สหกรณ์")}</td>
        <td class="num">${n2(x.manure_kg)}</td><td class="num">${n2(x.gas_m3)}</td><td class="num">${n2(x.electricity_kwh)}</td><td class="num">${n2(x.digestate_kg)}</td><td class="num">${n2(x.digestate_sold_kg)}</td><td class="num">${baht(x.digestate_revenue)}</td></tr>`))}</div>`;
  };

  // ---- การเงิน ----
  PAGES.finance = async (sec) => {
    const [st0, ledger, fees, ms] = await Promise.all([API.get("/dairy/settlements"), API.get("/dairy/ledger"), API.get("/dairy/fees"), members()]);
    sec.innerHTML = `
      <div class="mh-card"><h3>รอบจ่ายเงินสมาชิก (ทุก ${st0.settlement_days} วัน)</h3>
        <form data-form="newRun" class="mh-form"><div><label>สรุปยอดถึงวันที่</label><input type="date" name="period_end" value="${st0.suggested_period_end > today() ? today() : st0.suggested_period_end}" max="${today()}"></div>
          <div><button class="mh-btn">สร้างรอบจ่าย (ฉบับร่าง)</button></div>
          <div class="full mh-note">รอบล่าสุดถึง ${st0.last_period_end ? d(st0.last_period_end) : "-"} · ระบบรวมค่าน้ำนม แล้วหักตามลำดับที่ตั้งไว้ รายการที่หักไม่พอ (และรายการหลังจากนั้น) ยกไปรอบถัดไป ไม่จ่ายติดลบ</div></form>
        ${table(["ช่วง", "#สมาชิกได้รับเงิน", "#ยอดโอนรวม", "อ้างอิง ธ.ก.ส.", "สถานะ", ""], st0.runs.map((r) => `<tr><td>${d(r.period_start)} – ${d(r.period_end)}</td><td class="num">${r.member_count}</td>
          <td class="num">${baht(r.total_net)}</td><td>${esc(r.baac_batch_ref || "")}</td><td>${st(r.status)}</td>
          <td class="mh-row"><button class="mh-btn sm ghost" data-act="runDetail" data-id="${r.run_id}">รายละเอียด</button>
            ${r.status === "Draft" ? `<button class="mh-btn sm" data-act="runSubmit" data-id="${r.run_id}">ยืนยันส่ง ธ.ก.ส.</button>` : ""}
            ${["Submitted", "Paid"].includes(r.status) ? `<button class="mh-btn sm ghost" data-act="runExport" data-id="${r.run_id}" data-ref="${esc(r.baac_batch_ref)}">ไฟล์โอน (CSV)</button>` : ""}
            ${r.status === "Submitted" ? `<button class="mh-btn sm" data-act="runPaid" data-id="${r.run_id}">โอนแล้ว</button>` : ""}
            ${["Draft", "Submitted"].includes(r.status) ? `<button class="mh-btn sm danger" data-act="runCancel" data-id="${r.run_id}">ยกเลิก</button>` : ""}</td></tr>
          <tr><td colspan="6" id="run-${r.run_id}" style="padding:0;border:0"></td></tr>`))}
        <p class="mh-note">รูปแบบไฟล์ CSV เป็นรูปแบบกลาง ต้องยืนยันรูปแบบ Bulk Payment จริงกับ ธ.ก.ส. ก่อนใช้งาน</p></div>
      <div class="mh-card"><h3>รายการหักอื่น ๆ</h3>
        <form data-form="ledgerEntry" class="mh-form">
          <div><label>สมาชิก</label><select name="member_id">${opt(ms, "member_id", (m) => `${m.member_code} ${m.full_name}`)}</select></div>
          <div><label>ประเภท</label><select name="entry_type"><option value="loan_repayment">ชำระสินเชื่อ</option><option value="share">ค่าหุ้น</option><option value="adjustment">ปรับปรุง (+/−)</option></select></div>
          <div><label>จำนวนเงิน</label><input type="number" step="0.01" name="amount" required></div><div><label>หมายเหตุ</label><input name="note" required></div><div><button class="mh-btn">บันทึก</button></div></form></div>
      <div class="mh-card"><h3>บัญชีสมาชิก (ล่าสุด)</h3>
        ${table(["วันที่", "สมาชิก", "รายการ", "#จำนวน", "รอบ", "หมายเหตุ"], ledger.slice(0, 150).map((l) => `<tr><td>${d(l.entry_date)}</td><td>${esc(l.member_code)} ${esc(l.member_name)}</td><td>${LEDGER[l.entry_type]}</td>
          <td class="num" style="color:${Number(l.amount) < 0 ? "var(--red-600)" : "inherit"}">${baht(l.amount)}</td><td>${l.run_id ? "✓" : pill("ค้าง", "warn")}</td><td><small>${esc(l.note || "")}</small></td></tr>`))}</div>
      <div class="mh-card"><h3>ค่าบริการ AgroLink</h3>
        ${table(["ประเภท", "ผู้จ่าย", "#รายการ", "#ยอดฐาน", "#ค่าบริการ"], fees.map((f) => `<tr><td>${FEE[f.fee_type]}</td><td>${f.payer_type === "partner" ? "คู่ค้า (ผู้ขาย)" : "สหกรณ์ (ผู้ขาย)"}</td><td class="num">${f.n}</td><td class="num">${baht(f.base)}</td><td class="num">${baht(f.fee)}</td></tr>`))}
        <p class="mh-note">สมาชิกไม่ต้องจ่ายค่าบริการ อัตรา % ตั้งได้ในแท็บตั้งค่า</p></div>`;
  };

  // ---- พยากรณ์ ----
  function forecastChart(days) {
    const W = 760, H = 260, L = 56, R = 16, T = 16, B = 34;
    const max = Math.max(1, ...days.map((x) => Math.max(x.forecast_kg, x.committed_kg))) * 1.1;
    const X = (i) => L + (i / (days.length - 1 || 1)) * (W - L - R);
    const Y = (v) => T + (1 - v / max) * (H - T - B);
    const path = (k) => days.map((x, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(x[k]).toFixed(1)}`).join("");
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f / 1.1);
    const months = days.map((x, i) => ({ i, x })).filter(({ x }, i) => i === 0 || x.date.slice(8) === "01");
    const last = days[days.length - 1];
    // ป้ายท้ายเส้น: วางเหนือเส้นที่สูงกว่า ใต้เส้นที่ต่ำกว่า และไม่ให้ตกลงไปทับป้ายแกนเวลา
    const fUp = last.forecast_kg >= last.committed_kg;
    const clampY = (y) => Math.min(Math.max(y, T + 12), H - B - 6);
    const labY = { f: clampY(Y(last.forecast_kg) + (fUp ? -6 : 16)), c: clampY(Y(last.committed_kg) + (fUp ? 16 : -6)) };
    if (Math.abs(labY.f - labY.c) < 14) { if (fUp) labY.f = labY.c - 14; else labY.c = labY.f - 14; }
    return `<svg class="mh-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="พยากรณ์น้ำนมเทียบตลาดรองรับ 90 วัน">
      ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e5e7eb"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="#6b7280">${n2(Math.round(v))}</text>`).join("")}
      ${months.map(({ i, x }) => `<text x="${X(i)}" y="${H - 12}" font-size="11" fill="#6b7280" text-anchor="${i ? "middle" : "start"}">${new Date(x.date + "T00:00:00").toLocaleDateString("th-TH", { day: "numeric", month: "short" })}</text>`).join("")}
      <path d="${path("committed_kg")}" fill="none" stroke="#9a6b00" stroke-width="2" stroke-dasharray="6 4"/>
      <path d="${path("forecast_kg")}" fill="none" stroke="#1f6fd1" stroke-width="2"/>
      <text x="${W - R}" y="${labY.f}" text-anchor="end" font-size="12" fill="#1f6fd1" stroke="#fff" stroke-width="3" paint-order="stroke">คาดการณ์ ${n2(last.forecast_kg)}</text>
      <text x="${W - R}" y="${labY.c}" text-anchor="end" font-size="12" fill="#9a6b00" stroke="#fff" stroke-width="3" paint-order="stroke">ตลาดรองรับ ${n2(last.committed_kg)}</text>
      ${days.map((x, i) => `<rect x="${X(i) - 4}" y="${T}" width="8" height="${H - T - B}" fill="transparent"><title>${x.date}: คาดการณ์ ${n2(x.forecast_kg)} กก. · รองรับ ${n2(x.committed_kg)} กก. (นมโรงเรียน ${n2(x.school_kg)})</title></rect>`).join("")}
    </svg>
    <div class="mh-row" style="font-size:12.5px"><span><span style="display:inline-block;width:18px;border-top:2px solid #1f6fd1;vertical-align:middle"></span> น้ำนมคาดการณ์ (กก./วัน)</span>
      <span><span style="display:inline-block;width:18px;border-top:2px dashed #9a6b00;vertical-align:middle"></span> ตลาดรองรับ: สัญญา + ดีลส่วนเกิน + นมโรงเรียน (กก./วัน)</span></div>`;
  }
  PAGES.forecast = async (sec) => {
    const f = await API.get("/dairy/forecast");
    const weeks = [];
    for (let i = 0; i < f.days.length; i += 7) {
      const w = f.days.slice(i, i + 7);
      weeks.push({ from: w[0].date, to: w[w.length - 1].date, f: w.reduce((a, x) => a + x.forecast_kg, 0) / w.length, c: w.reduce((a, x) => a + x.committed_kg, 0) / w.length, s: w.reduce((a, x) => a + x.school_kg, 0) / w.length });
    }
    sec.innerHTML = `
      <div class="mh-grid">${f.windows.map((w) => `<div class="mh-stat ${["orange", "red"].includes(w.level) ? "warn" : ""}"><small>${w.days} วันข้างหน้า</small><b>${lvl(w.level)}</b>
        <small>คาดการณ์ ${n2(w.avg_forecast_kg)} / รองรับ ${n2(w.avg_committed_kg)} กก./วัน${w.surplus_pct == null ? "" : ` (${w.surplus_pct > 0 ? "+" : ""}${n2(w.surplus_pct)}%)`}</small></div>`).join("")}</div>
      <div class="mh-card" style="margin-top:16px"><h3>น้ำนมคาดการณ์เทียบตลาดรองรับรายวัน</h3>${f.days.length ? forecastChart(f.days) : ""}
        <p class="mh-note">${f.history_days ? `คำนวณจากน้ำนมจริง ${f.history_days} วันล่าสุด (เฉลี่ย ${n2(f.recent_avg_kg_day)} กก./วัน) × จำนวนโครีดนมรายวัน — โคถึงกำหนดหยุดรีดออกจากการคำนวณ โคตั้งท้องเข้าเมื่อถึงกำหนดคลอด` : "ยังไม่มีข้อมูลรับนมใน 14 วันล่าสุด"}
          · เกณฑ์สี: เหลือง > ${f.thresholds.yellow}% ส้ม > ${f.thresholds.orange}% แดง > ${f.thresholds.red}% (ปรับได้ในตั้งค่า)</p></div>
      <div class="mh-card"><h3>รายสัปดาห์</h3>${table(["สัปดาห์", "#คาดการณ์ (กก./วัน)", "#รองรับ (กก./วัน)", "#ในนั้นนมโรงเรียน", "#ส่วนต่าง"], weeks.map((w) => `<tr><td>${d(w.from)} – ${d(w.to)}</td>
        <td class="num">${n2(w.f)}</td><td class="num">${n2(w.c)}</td><td class="num">${n2(w.s)}</td><td class="num" style="color:${w.f > w.c ? "var(--red-600)" : "inherit"}">${n2(w.f - w.c)}</td></tr>`))}</div>`;
  };

  // ---- IoT ----
  function spark(rows) {
    const W = 600, H = 80;
    const vals = rows.filter((r) => r.temp_c != null);
    if (!vals.length) return '<div class="mh-empty">ไม่มีค่าอุณหภูมิ</div>';
    const ts = vals.map((r) => new Date(r.recorded_at).getTime());
    const t0 = Math.min(...ts), t1 = Math.max(...ts);
    const v = vals.map((r) => Number(r.temp_c));
    const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
    const pts = vals.map((r, i) => `${((ts[i] - t0) / (t1 - t0 || 1)) * W},${H - 6 - ((v[i] - lo) / span) * (H - 12)}`).join(" ");
    return `<svg class="mh-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="อุณหภูมิ"><polyline fill="none" stroke="#c0392b" stroke-width="2" points="${pts}"/></svg>
      <small>อุณหภูมิ ${n2(lo)}–${n2(hi)}°C · ล่าสุด ${n2(v[v.length - 1])}°C · ${vals.length} ค่า</small>`;
  }
  PAGES.iot = async (sec) => {
    const [devs, alerts, centers, ms] = await Promise.all([API.get("/dairy/iot/devices"), API.get("/dairy/iot/alerts"), API.get("/dairy/centers"), members()]);
    sec.innerHTML = `
      <div class="mh-card"><h3>แจ้งเตือน</h3>${table(["เวลา", "อุปกรณ์", "ข้อความ", ""], alerts.slice(0, 50).map((a) => `<tr${a.acknowledged_at ? "" : ' style="background:var(--red-100)"'}><td>${dt(a.created_at)}</td><td>${esc(a.device_name)}</td><td>${esc(a.message)}</td>
        <td>${a.acknowledged_at ? "รับทราบแล้ว" : `<button class="mh-btn sm" data-act="ackAlert" data-id="${a.alert_id}">รับทราบ</button>`}</td></tr>`))}</div>
      <div class="mh-card"><h3>อุปกรณ์</h3>
        ${table(["ชื่อ", "ชนิด", "ที่ตั้ง", "เกณฑ์ (°C)", "ค่าล่าสุด", "ออนไลน์ล่าสุด", ""], devs.map((x) => `<tr><td>${esc(x.name)}</td><td>${DEV[x.device_type]}</td><td>${esc(x.center_name || x.member_name || "")}</td>
          <td>${x.temp_min != null ? n2(x.temp_min) : ""}–${x.temp_max != null ? n2(x.temp_max) : ""}</td>
          <td>${x.last_reading ? `${x.last_reading.temp_c != null ? n2(x.last_reading.temp_c) + "°C " : ""}${x.last_reading.level_kg != null ? n2(x.last_reading.level_kg) + " กก." : ""}${x.last_reading.gas_m3 != null ? n2(x.last_reading.gas_m3) + " ลบ.ม." : ""}` : "-"}</td>
          <td>${dt(x.last_seen_at)}</td><td><button class="mh-btn sm ghost" data-act="readings" data-id="${x.device_id}">กราฟ 24 ชม.</button></td></tr><tr><td colspan="7" id="rd-${x.device_id}" style="padding:0;border:0"></td></tr>`))}
        <form data-form="device" class="mh-form" style="margin-top:12px">
          <div><label>ชื่อ</label><input name="name" required></div><div><label>ชนิด</label><select name="device_type">${Object.entries(DEV).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
          <div><label>ศูนย์ (ถังเย็น/เครื่องชั่ง)</label><select name="center_id"><option value="">-</option>${opt(centers, "center_id", "name")}</select></div>
          <div><label>ฟาร์มสมาชิก</label><select name="member_id"><option value="">-</option>${opt(ms, "member_id", (m) => `${m.member_code} ${m.full_name}`)}</select></div>
          <div><label>อุณหภูมิต่ำสุด</label><input type="number" step="0.1" name="temp_min"></div><div><label>อุณหภูมิสูงสุด (ถังเย็นค่าเริ่ม = ตั้งค่า)</label><input type="number" step="0.1" name="temp_max"></div>
          <div><button class="mh-btn">เพิ่มอุปกรณ์</button></div><div class="full" id="newKey"></div></form>
        <p class="mh-note">อุปกรณ์ส่งค่าไปที่ POST /dairy-iot/readings และเครื่องชั่งนมส่งที่ POST /dairy-iot/intake { member_code, weight_kg } พร้อม header X-Device-Key</p></div>`;
  };

  // ---- รายงาน ----
  PAGES.reports = async (sec) => {
    const r = await API.get(`/dairy/reports/summary${cache.repFrom ? `?from=${cache.repFrom}&to=${cache.repTo}` : ""}`);
    sec.innerHTML = `
      <form data-form="report" class="mh-form mh-card"><div><label>ตั้งแต่</label><input type="date" name="from" value="${r.from}"></div><div><label>ถึง</label><input type="date" name="to" value="${r.to}"></div><div><button class="mh-btn">ดูรายงาน</button></div></form>
      <div class="mh-grid">
        <div class="mh-stat"><small>น้ำนมรับ</small><b>${n2(r.milk.accepted_kg)}</b> <small>กก. · เฉลี่ย ${n2(r.milk.avg_kg_day)}/วัน</small></div>
        <div class="mh-stat"><small>ปฏิเสธที่ศูนย์</small><b>${n2(r.milk.rejected_kg)}</b> <small>กก.</small></div>
        <div class="mh-stat"><small>จ่ายค่านมสมาชิก</small><b>${baht(r.milk.paid_to_members)}</b></div>
        <div class="mh-stat"><small>ส่งโรงงาน / รับ</small><b>${n2(r.shipments.sent_kg)}</b> <small>/ ${n2(r.shipments.received_kg)} กก. (ส่วนเกิน ${n2(r.shipments.surplus_kg)})</small></div>
        <div class="mh-stat"><small>รายได้ขายนมดิบ</small><b>${baht(r.shipments.sales_amount)}</b></div>
        <div class="mh-stat"><small>แปรรูป (นมดิบ) / ขายผลิตภัณฑ์</small><b>${n2(r.processing.milk_used_kg)}</b> <small>กก. · ${baht(r.product_sales.amount)} บาท (โรงเรียน ${baht(r.product_sales.school_amount)})</small></div>
        <div class="mh-stat"><small>ขายอาหาร/ปัจจัยให้สมาชิก</small><b>${baht(r.feed_sold)}</b></div>
        <div class="mh-stat ${Math.abs(r.milk_balance_kg) > 0.5 ? "warn" : ""}"><small>ส่วนต่างน้ำนม (รับ − ส่ง − แปรรูป)</small><b>${n2(r.milk_balance_kg)}</b> <small>กก.</small></div>
        <div class="mh-stat"><small>ฝูง: คลอด / ผสม / ท้องยืนยัน / รักษา</small><b>${r.herd.calvings}</b> <small>/ ${r.herd.inseminations} / ${r.herd.pregnancies} / ${r.herd.treatments}</small></div>
        <div class="mh-stat"><small>ไบโอแก๊ส</small><b>${n2(r.biogas.gas_m3)}</b> <small>ลบ.ม. · ${n2(r.biogas.electricity_kwh)} kWh</small></div>
      </div>
      <div class="mh-card" style="margin-top:16px"><h3>รายสมาชิก</h3>${table(["รหัส", "สมาชิก", "#น้ำนม (กก.)", "#ยอดเงิน", "#ราคาเฉลี่ย", "#ปฏิเสธ", "#ไขมัน", "#SNF", "#SCC"], r.members.map((m) => `<tr>
        <td>${esc(m.member_code)}</td><td>${esc(m.full_name)}</td><td class="num">${n2(m.kg)}</td><td class="num">${baht(m.amount)}</td><td class="num">${n2(m.avg_price)}</td><td class="num">${n2(m.rejected_kg)}</td>
        <td class="num">${n2(m.avg_fat)}</td><td class="num">${n2(m.avg_snf)}</td><td class="num">${n2(m.avg_scc)}</td></tr>`))}</div>
      <div class="mh-card"><h3>เหตุผลที่ปฏิเสธนม</h3>${table(["เหตุผล", "#ครั้ง", "#กก."], r.rejects.map((x) => `<tr><td>${REJ[x.reject_reason] || x.reject_reason}</td><td class="num">${x.n}</td><td class="num">${n2(x.kg)}</td></tr>`))}</div>`;
  };

  // ---- ตั้งค่า ----
  PAGES.settings = async (sec) => {
    const s = await API.get("/dairy/settings");
    const v = s.settings;
    const f = (name, label, step) => `<div><label>${label}</label><input type="number" step="${step || "0.01"}" name="${name}" value="${Number(v[name])}"></div>`;
    sec.innerHTML = `
      <form data-form="settings" class="mh-card"><h3>ราคาและรอบจ่าย</h3><div class="mh-form">
        ${f("base_price_per_kg", "ราคาฐานน้ำนม (บาท/กก.)")}${f("settlement_days", "รอบจ่ายเงินทุก (วัน)", 1)}
        <div class="full"><label>ลำดับการหักจากค่านม (ลากเรียงด้วยการพิมพ์ คั่นด้วย ,)</label><input name="deduction_order" value="${esc(v.deduction_order.join(","))}">
          <small class="mh-note">${v.deduction_order.map((t) => LEDGER[t]).join(" → ")}</small></div>
        </div><h3 style="margin-top:14px">ค่าบริการ AgroLink (% ผู้ขายจ่าย)</h3><div class="mh-form">
        ${f("fee_rate_feed_pct", "ผู้ขายอาหารสัตว์ขายให้สหกรณ์")}${f("fee_rate_raw_milk_pct", "สหกรณ์ขายนมดิบให้โรงงาน")}${f("fee_rate_surplus_pct", "ขายนมส่วนเกินผ่านตลาด")}${f("fee_rate_product_pct", "สหกรณ์ขายผลิตภัณฑ์นม")}
        </div><h3 style="margin-top:14px">ฝูงโคและคุณภาพ</h3><div class="mh-form">
        ${f("tank_temp_max", "อุณหภูมิถังเย็นสูงสุด (°C)", "0.1")}${f("gestation_days", "ระยะตั้งท้อง (วัน)", 1)}${f("dry_period_days", "ระยะพักท้องก่อนคลอด (วัน)", 1)}
        </div><h3 style="margin-top:14px">เกณฑ์เตือนนมส่วนเกิน (% เกินตลาดรองรับ)</h3><div class="mh-form">
        ${f("alert_yellow_pct", "เหลือง >")}${f("alert_orange_pct", "ส้ม >")}${f("alert_red_pct", "แดง >")}
        <div><label><input type="checkbox" name="has_processing_plant"${v.has_processing_plant ? " checked" : ""}> สหกรณ์มีโรงนมแปรรูป</label></div>
        <div class="full"><label><input type="checkbox" name="gov_data_consent"${v.gov_data_consent ? " checked" : ""}> ยินยอมให้หน่วยงานรัฐเห็นข้อมูลรายสหกรณ์ใน Dashboard นโยบาย (ปริมาณนม สัญญารวม ระดับเตือน — ไม่รวมราคาสัญญาและข้อมูลสมาชิกรายคน)</label></div>
        <div><button class="mh-btn">บันทึกการตั้งค่า</button></div></div></form>
      <div class="mh-card"><h3>ศูนย์รวบรวมน้ำนม</h3>
        <form data-form="center" class="mh-form"><div><label>ชื่อศูนย์</label><input name="name" required></div><div><label>ที่อยู่</label><input name="address"></div><div><label>ความจุถัง (กก.)</label><input type="number" name="tank_capacity_kg"></div><div><button class="mh-btn">เพิ่มศูนย์</button></div></form>
        ${table(["ศูนย์", "ที่อยู่", "#ความจุถัง", "#สมาชิก"], s.centers.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.address || "")}</td><td class="num">${n2(c.tank_capacity_kg)}</td><td class="num">${c.members ?? ""}</td></tr>`))}</div>
      <div class="mh-card"><h3>ประวัติการแก้ไข</h3>${table(["เวลา", "รายการ", "เดิม", "ใหม่", "โดย"], s.history.map((h) => `<tr><td>${dt(h.changed_at)}</td><td>${esc(h.field_name)}</td><td>${esc(h.old_value ?? "")}</td><td>${esc(h.new_value ?? "")}</td><td><small>${esc(h.changed_by || "")}</small></td></tr>`))}</div>`;
  };

  // ---------- actions ----------
  const ACT = {
    go: (el) => show(el.dataset.tab),
    memberStatus: async (el) => { if (await run(() => API.post(`/dairy/members/${el.dataset.id}/status`, { status: el.dataset.status }), "บันทึกสถานะแล้ว")) { refresh(); badges(); } },
    editMember: async (el) => {
      const ms = await members();
      const m = ms.find((x) => x.member_id === el.dataset.id);
      const row = $(`#edit-${m.member_id}`);
      row.hidden = !row.hidden;
      row.firstElementChild.innerHTML = `<form data-form="editMember" data-id="${m.member_id}" class="mh-form">
        <div><label>ชื่อ</label><input name="full_name" value="${esc(m.full_name)}"></div><div><label>โทร</label><input name="phone" value="${esc(m.phone || "")}"></div>
        <div><label>ฟาร์ม</label><input name="farm_name" value="${esc(m.farm_name || "")}"></div><div><label>ศูนย์</label><select name="center_id">${opt(cache.centers || [], "center_id", "name", m.center_id)}</select></div>
        <div><label>เลขบัญชี ธ.ก.ส.</label><input name="baac_account_no" value="${esc(m.baac_account_no || "")}"></div><div><label>ชื่อบัญชี</label><input name="baac_account_name" value="${esc(m.baac_account_name || "")}"></div>
        <div><label>วงเงินเชื่อ (ว่าง=ไม่จำกัด)</label><input type="number" name="credit_limit" value="${m.credit_limit != null ? Number(m.credit_limit) : ""}"></div>
        <div><label>ค่าหุ้นต่อรอบ</label><input type="number" name="share_deduct_per_round" value="${Number(m.share_deduct_per_round)}"></div>
        <div><label><input type="checkbox" name="gap_certified"${m.gap_certified ? " checked" : ""}> GAP</label></div><div><button class="mh-btn">บันทึก</button></div></form>`;
    },
    togglePartner: async (el) => { if (await run(() => API.put(`/dairy/partners/${el.dataset.id}`, { active: el.dataset.active === "1" }), "บันทึกแล้ว")) refresh(); },
    animal: (el) => { if (current !== "herd") { show("herd"); setTimeout(() => animalDetail(el.dataset.id), 600); } else animalDetail(el.dataset.id); },
    recordReq: (el) => animalDetail(el.dataset.animal, el.dataset.id),
    reqPhoto: async (el) => { const r = await run(() => API.get(`/dairy/requests/${el.dataset.id}/photo`)); if (r && r.photo_data_url) $(`#photo-${el.dataset.id}`).innerHTML = `<img src="${esc(r.photo_data_url)}" alt="รูปประกอบคำขอ" style="max-width:260px;border-radius:8px">`; },
    fulfil: async (el) => { const r = await run(() => API.post(`/dairy/requests/${el.dataset.id}/fulfil`, {})); if (r) { toast(`จ่าย ${r.item_name} ${n2(r.qty)} ให้ ${r.member_name} ${baht(r.amount)} บาท`); refresh(); badges(); } },
    cancelReq: async (el) => { if (confirm("ยกเลิกคำขอนี้?") && await run(() => API.post(`/dairy/requests/${el.dataset.id}/cancel`, {}), "ยกเลิกแล้ว")) { refresh(); badges(); } },
    round: (el) => renderRound(el.dataset.id),
    delIntake: async (el) => { if (await run(() => API.del(`/dairy/rounds/${cache.roundId}/intakes/${el.dataset.id}`), "ลบแล้ว")) renderRound(cache.roundId); },
    toggleRule: async (el) => { if (await run(() => API.put(`/dairy/quality-rules/${el.dataset.id}`, { active: el.dataset.active === "1" }), "บันทึกแล้ว")) refresh(); },
    receiveForm: (el) => {
      $(`#recv-${el.dataset.id}`).innerHTML = `<form data-form="receive" data-id="${el.dataset.id}" class="mh-form" style="padding:10px;background:var(--gray-50)">
        <div><label>ผล</label><select name="status"><option value="Received">โรงงานรับ</option><option value="Rejected">โรงงานปฏิเสธทั้งเที่ยว</option></select></div>
        <div><label>น้ำหนักรับ (กก.)</label><input type="number" step="0.1" name="received_kg"></div><div><label>ราคา (ว่าง=ตามสัญญา/ดีล)</label><input type="number" step="0.01" name="price_per_kg"></div>
        <div><label>ไขมัน</label><input type="number" step="0.01" name="fat_pct"></div><div><label>SNF</label><input type="number" step="0.01" name="snf_pct"></div><div><label>SCC</label><input type="number" name="scc_k"></div>
        <div><label>เหตุผลถ้าปฏิเสธ</label><input name="reject_reason"></div><div><button class="mh-btn">บันทึก</button></div></form>`;
    },
    cancelShip: async (el) => { if (await run(() => API.post(`/dairy/shipments/${el.dataset.id}/cancel`, {}), "ยกเลิกแล้ว")) refresh(); },
    shipPaid: async (el) => { if (await run(() => API.post(`/dairy/shipments/${el.dataset.id}/paid`, {}), "บันทึกแล้ว")) refresh(); },
    endContract: async (el) => { if (confirm("สิ้นสุดสัญญานี้?") && await run(() => API.post(`/dairy/contracts/${el.dataset.id}/end`, {}), "สิ้นสุดสัญญาแล้ว")) refresh(); },
    offerEnd: async (el) => { if (await run(() => API.post(`/dairy/surplus/offers/${el.dataset.id}/${el.dataset.action}`, {}), "บันทึกแล้ว")) refresh(); },
    proposal: async (el) => { if (await run(() => API.post(`/dairy/surplus/proposals/${el.dataset.id}/${el.dataset.action}`, {}), el.dataset.action === "accept" ? "ตอบรับแล้ว — บันทึกเที่ยวส่งได้ในแท็บสัญญาและส่งโรงงาน" : "ปฏิเสธแล้ว")) { refresh(); badges(); } },
    addPoLine: () => addPoLine(),
    poDeliver: async (el) => { const r = await run(() => API.post(`/dairy/purchase-orders/${el.dataset.id}/deliver`, {})); if (r) { toast(`รับเข้าคลังแล้ว ค่าบริการ ${baht(r.fee_amount)} บาท`); refresh(); } },
    poCancel: async (el) => { if (await run(() => API.post(`/dairy/purchase-orders/${el.dataset.id}/cancel`, {}), "ยกเลิกแล้ว")) refresh(); },
    poPaid: async (el) => { if (await run(() => API.post(`/dairy/purchase-orders/${el.dataset.id}/paid`, {}), "บันทึกแล้ว")) refresh(); },
    cancelSchool: async (el) => { if (await run(() => API.post(`/dairy/school-deliveries/${el.dataset.id}/cancel`, {}), "ยกเลิกแล้ว")) refresh(); },
    runDetail: async (el) => {
      const r = await run(() => API.get(`/dairy/settlements/${el.dataset.id}`));
      if (!r) return;
      $(`#run-${r.run_id}`).innerHTML = `<div style="padding:10px;background:var(--gray-50)"><p class="mh-note">${r.by_type.map((t) => `${LEDGER[t.entry_type]} ${baht(t.amount)}`).join(" · ")}${r.missing_account ? ` · ${pill(`ไม่มีเลขบัญชี ${r.missing_account} ราย`, "bad")}` : ""}</p>
        ${table(["รหัส", "สมาชิก", "#รายรับ", "#หัก", "#สุทธิ", "#ยกไปรอบหน้า", "บัญชี"], r.lines.map((l) => `<tr><td>${esc(l.member_code)}</td><td>${esc(l.full_name)}</td><td class="num">${baht(l.total_credit)}</td>
          <td class="num">${baht(l.total_debit)}</td><td class="num"><b>${baht(l.net_amount)}</b></td><td class="num">${Number(l.carried_debit) ? baht(l.carried_debit) : "-"}</td><td>${esc(l.baac_account_no || "-")}</td></tr>`))}</div>`;
    },
    runSubmit: async (el) => { if (await run(() => API.post(`/dairy/settlements/${el.dataset.id}/submit`, {}), "ยืนยันแล้ว — ดาวน์โหลดไฟล์โอนได้")) refresh(); },
    runPaid: async (el) => { if (await run(() => API.post(`/dairy/settlements/${el.dataset.id}/paid`, {}), "บันทึกว่าโอนแล้ว")) refresh(); },
    runCancel: async (el) => { if (confirm("ยกเลิกรอบนี้? รายการจะกลับไปเป็นยอดค้าง") && await run(() => API.post(`/dairy/settlements/${el.dataset.id}/cancel`, {}), "ยกเลิกแล้ว")) refresh(); },
    runExport: async (el) => {
      try {
        const res = await fetch(`${API_BASE}/dairy/settlements/${el.dataset.id}/baac-export`, { headers: { Authorization: `Bearer ${API.getSession().access_token}` } });
        if (!res.ok) throw new Error("export_failed");
        const blob = await res.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${el.dataset.ref || "baac"}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (e) { toast("ดาวน์โหลดไม่สำเร็จ", true); }
    },
    ackAlert: async (el) => { if (await run(() => API.post(`/dairy/iot/alerts/${el.dataset.id}/ack`, {}), "รับทราบแล้ว")) { refresh(); badges(); } },
    readings: async (el) => { const r = await run(() => API.get(`/dairy/iot/devices/${el.dataset.id}/readings?hours=24`)); if (r) $(`#rd-${el.dataset.id}`).innerHTML = `<div style="padding:8px">${r.length ? spark(r) : '<div class="mh-empty">ไม่มีข้อมูล 24 ชม.</div>'}</div>`; },
  };
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || !ACT[el.dataset.act]) return;
    e.preventDefault();
    ACT[el.dataset.act](el);
  });
  document.addEventListener("change", (e) => {
    if (e.target.matches('[data-act-change="eventType"]')) {
      const form = e.target.closest("form");
      $(`#evFields-${form.dataset.id}`).innerHTML = eventFields(e.target.value);
    }
  });
  let orgTimer = null;
  document.addEventListener("input", (e) => {
    if (!e.target.matches('[data-act-input="orgSearch"]')) return;
    clearTimeout(orgTimer);
    const q = e.target.value.trim();
    const sel = e.target.closest("form").linked_org_id;
    if (q.length < 2) return;
    orgTimer = setTimeout(async () => {
      try {
        const rows = await API.get(`/dairy/linkable-orgs?q=${encodeURIComponent(q)}`);
        sel.innerHTML = '<option value="">— ไม่ผูก —</option>' + opt(rows, "org_id", (o) => `${o.org_name} (${o.org_type})`);
      } catch (err) { /* ignore */ }
    }, 300);
  });

  const EVENT_DETAIL_KEYS = ["semen_code", "technician", "result", "insemination_date", "calf_ear_tag", "calf_sex", "diagnosis", "drug", "withdrawal_days", "vaccine", "price", "note"];
  const FORM = {
    lookup: async (f) => {
      const rows = await run(() => API.get(`/dairy/farmers/lookup?phone=${encodeURIComponent(f.phone.value)}`));
      if (!rows) return;
      $("#lookupResult").innerHTML = rows.length ? rows.map((r) => `<button type="button" class="mh-btn sm ghost" data-pick='${esc(JSON.stringify(r))}'>${esc(r.full_name)} ${esc(r.phone)}</button>`).join(" ") : '<span class="mh-empty">ไม่พบ — กรอกข้อมูลเองด้านล่าง</span>';
      document.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
        const r = JSON.parse(b.dataset.pick);
        const af = $('form[data-form="addMember"]');
        af.farmer_id.value = r.farmer_id; af.full_name.value = r.full_name; af.phone.value = r.phone;
        toast("เลือกเกษตรกรแล้ว — กรอกข้อมูลฟาร์มต่อ");
      }));
    },
    addMember: async (f) => { if (await run(() => API.post("/dairy/members", clean(fd(f))), "เพิ่มสมาชิกแล้ว")) { refresh(); badges(); } },
    editMember: async (f) => { const b = fd(f); if (b.credit_limit === "") b.credit_limit = null; if (await run(() => API.put(`/dairy/members/${f.dataset.id}`, b), "บันทึกแล้ว")) refresh(); },
    addPartner: async (f) => { const b = clean(fd(f)); delete b.org_q; if (await run(() => API.post("/dairy/partners", b), "เพิ่มคู่ค้าแล้ว")) refresh(); },
    addAnimal: async (f) => { if (await run(() => API.post("/dairy/animals", clean(fd(f))), "ขึ้นทะเบียนแล้ว")) refresh(); },
    herdFilter: (f) => { cache.herdFilter = clean(fd(f)); refresh(); },
    event: async (f) => {
      const b = fd(f);
      const details = {};
      EVENT_DETAIL_KEYS.forEach((k) => { if (b[k] !== undefined && b[k] !== "") details[k] = k === "withdrawal_days" ? Number(b[k]) : b[k]; delete b[k]; });
      const body = { event_type: b.event_type, event_date: b.event_date, cost: b.cost || 0, charge_member: b.charge_member, details };
      if (b.vet_partner_id) body.vet_partner_id = b.vet_partner_id;
      if (f.dataset.request) body.request_id = f.dataset.request;
      const r = await run(() => API.post(`/dairy/animals/${f.dataset.id}/events`, body));
      if (r) { toast(`บันทึก${EVENT[r.event.event_type]}แล้ว${r.charged ? ` หักบัญชีสมาชิก ${baht(r.charged)} บาท` : ""}${r.calf ? ` ขึ้นทะเบียนลูกโค ${r.calf.ear_tag}` : ""}`); if (f.dataset.request) { refresh(); badges(); } else animalDetail(f.dataset.id); }
    },
    assign: async (f) => { if (await run(() => API.post(`/dairy/requests/${f.dataset.id}/assign`, fd(f)), "มอบหมายแล้ว")) refresh(); },
    openRound: async (f) => { const r = await run(() => API.post("/dairy/rounds", fd(f))); if (r) { cache.roundId = r.round_id; refresh(); badges(); } },
    intake: async (f, opts = {}) => {
      const b = fd(f);
      const body = { member_code: b.member_code, weight_kg: b.weight_kg, sample_no: b.sample_no || undefined };
      if (b.reject) { body.status = "Rejected"; body.reject_reason = b.reject_reason; }
      if (opts.confirm) body.confirm_withdrawal = true;
      try {
        const r = await API.post(`/dairy/rounds/${cache.roundId}/intakes`, body);
        toast(`${r.member_code} ${r.full_name}: ${n2(r.weight_kg)} กก. ${r.status === "Accepted" ? "รับ" : "ปฏิเสธ"}`);
        await renderRound(cache.roundId);
      } catch (e) {
        if (e.body && e.body.error === "member_has_withdrawal_animals") {
          if (confirm(`${errMsg(e)}\n\nยืนยันรับนม (ไม่ได้ปนน้ำนมจากโคที่หยุดยา)?`)) return FORM.intake(f, { confirm: true });
          return undefined;
        }
        toast(errMsg(e), true);
      }
      return undefined;
    },
    closeRound: async (f) => {
      const b = clean(fd(f));
      const r = await run(() => API.post(`/dairy/rounds/${cache.roundId}/close`, b));
      if (r) { toast(`ปิดรอบแล้ว รับ ${n2(r.accepted_kg)} กก. ${baht(r.amount)} บาท${r.warning ? " ⚠️ อุณหภูมิถังสูงกว่าเกณฑ์" : ""}`, !!r.warning); refresh(); badges(); }
    },
    test: async (f) => { if (await run(() => API.post("/dairy/quality-tests", clean(fd(f))), "บันทึกผลตรวจแล้ว")) refresh(); },
    testBulk: async (f) => {
      const date = f.sample_date.value;
      const tests = f.rows.value.split("\n").map((l) => l.split(/[,\t]/).map((x) => x.trim())).filter((x) => x[0]).map(([code, fat, snf, scc, tbc]) => clean({ member_code: code, sample_date: date, fat_pct: fat, snf_pct: snf, scc_k: scc, tbc_k: tbc }));
      const r = await run(() => API.post("/dairy/quality-tests", { tests }));
      if (r) { toast(`นำเข้า ${r.saved} รายการ`); refresh(); }
    },
    rule: async (f) => { if (await run(() => API.post("/dairy/quality-rules", clean(fd(f))), "เพิ่มเกณฑ์แล้ว")) refresh(); },
    ship: async (f) => {
      const b = clean(fd(f));
      const [kind, id] = b.ref.split(":");
      delete b.ref;
      b[`${kind}_id`] = id;
      if (await run(() => API.post("/dairy/shipments", b), "บันทึกเที่ยวส่งนมแล้ว")) { refresh(); badges(); }
    },
    receive: async (f) => { const r = await run(() => API.post(`/dairy/shipments/${f.dataset.id}/receive`, clean(fd(f)))); if (r) { toast(r.status === "Received" ? `โรงงานรับ ${n2(r.received_kg)} กก. ${baht(r.amount)} บาท` : "บันทึกการปฏิเสธแล้ว"); refresh(); badges(); } },
    contract: async (f) => { if (await run(() => API.post("/dairy/contracts", clean(fd(f))), "บันทึกสัญญาแล้ว")) refresh(); },
    offer: async (f) => { if (await run(() => API.post("/dairy/surplus/offers", clean(fd(f))), "ประกาศแล้ว")) refresh(); },
    proposeCap: async (f) => { if (await run(() => API.post(`/dairy/surplus/offers/${f.offer_id.value}/propose`, { capacity_id: f.dataset.cap }), "ส่งข้อเสนอแล้ว รอโรงงานตอบรับ")) refresh(); },
    item: async (f) => { if (await run(() => API.post("/dairy/items", clean(fd(f))), "เพิ่มรายการแล้ว")) refresh(); },
    itemPrice: async (f) => { if (await run(() => API.put(`/dairy/items/${f.dataset.id}`, fd(f)), "บันทึกราคาแล้ว")) refresh(); },
    issue: async (f) => { const r = await run(() => API.post("/dairy/issues", clean(fd(f)))); if (r) { toast(`${r.member_name}: ${r.item_name} ${baht(r.amount)} บาท`); refresh(); } },
    po: async (f) => {
      const lines = [...f.querySelectorAll("#poLines > div")].map((row) => ({ item_id: row.querySelector('[data-line="item_id"]').value, qty: row.querySelector('[data-line="qty"]').value, unit_price: row.querySelector('[data-line="unit_price"]').value })).filter((l) => l.qty);
      if (await run(() => API.post("/dairy/purchase-orders", { partner_id: f.partner_id.value, expected_date: f.expected_date.value || undefined, lines }), "สร้างใบสั่งซื้อแล้ว")) refresh();
    },
    product: async (f) => { if (await run(() => API.post("/dairy/products", clean(fd(f))), "เพิ่มผลิตภัณฑ์แล้ว")) refresh(); },
    batch: async (f) => { const r = await run(() => API.post("/dairy/batches", clean(fd(f)))); if (r) { toast(`ล็อต ${r.lot_code} ใช้นมดิบ ${n2(r.milk_used_kg)} กก. หมดอายุ ${d(r.expires_on)}`); refresh(); } },
    sale: async (f) => { const r = await run(() => API.post("/dairy/product-sales", clean(fd(f)))); if (r) { toast(`ขาย ${r.units} หน่วย ${baht(r.amount)} บาท`); refresh(); } },
    planSchool: async (f) => { const r = await run(() => API.post("/dairy/school-deliveries/plan", fd(f))); if (r) { toast(`สร้างแผนส่ง ${r.created} รายการ`); refresh(); } },
    deliverSchool: async (f) => { const r = await run(() => API.post(`/dairy/school-deliveries/${f.dataset.id}/deliver`, fd(f))); if (r) { toast(`ส่ง ${r.units} หน่วยแล้ว — ส่งลิงก์ QR ให้โรงเรียนยืนยัน`); refresh(); } },
    schoolAdd: async (f) => {
      const b = clean(fd(f));
      Object.keys(b).forEach((k) => { if (k.startsWith("wd")) delete b[k]; });
      b.delivery_weekdays = [...f.querySelectorAll("[data-wd]")].filter((c) => c.checked).map((c) => Number(c.dataset.wd));
      if (await run(() => API.post("/dairy/schools", b), "เพิ่มโรงเรียนแล้ว")) refresh();
    },
    term: async (f) => { if (await run(() => API.post("/dairy/school-terms", clean(fd(f))), "เพิ่มภาคเรียนแล้ว")) refresh(); },
    biogas: async (f) => { if (await run(() => API.post("/dairy/biogas", clean(fd(f))), "บันทึกแล้ว")) refresh(); },
    newRun: async (f) => { const r = await run(() => API.post("/dairy/settlements", fd(f))); if (r) { toast(`สร้างรอบแล้ว ${r.member_count} ราย ${baht(r.total_net)} บาท${r.members_with_carried_debit ? ` (มียอดหักยกไป ${r.members_with_carried_debit} ราย)` : ""}`); refresh(); } },
    ledgerEntry: async (f) => { if (await run(() => API.post("/dairy/ledger/entry", fd(f)), "บันทึกแล้ว")) refresh(); },
    device: async (f) => {
      const r = await run(() => API.post("/dairy/iot/devices", clean(fd(f))));
      if (r) { await refresh(); $("#newKey").innerHTML = `<p><b>คีย์อุปกรณ์ (แสดงครั้งเดียว):</b></p><div class="mh-key">${esc(r.api_key)}</div>`; toast("สร้างอุปกรณ์แล้ว — คัดลอกคีย์ไปตั้งในอุปกรณ์"); }
    },
    report: (f) => { cache.repFrom = f.from.value; cache.repTo = f.to.value; refresh(); },
    settings: async (f) => {
      const b = fd(f);
      b.deduction_order = String(b.deduction_order).split(",").map((x) => x.trim()).filter(Boolean);
      const r = await run(() => API.put("/dairy/settings", b));
      if (r) { toast(r.updated.length ? `บันทึก ${r.updated.length} รายการ` : "ไม่มีการเปลี่ยนแปลง"); refresh(); badges(); }
    },
    center: async (f) => { if (await run(() => API.post("/dairy/centers", clean(fd(f))), "เพิ่มศูนย์แล้ว")) refresh(); },
  };
  document.addEventListener("submit", (e) => {
    const f = e.target.closest("form[data-form]");
    if (!f || !FORM[f.dataset.form]) return;
    e.preventDefault();
    const btn = f.querySelector("button:not([type=button])");
    if (btn) btn.disabled = true;
    Promise.resolve(FORM[f.dataset.form](f)).finally(() => {
      if (btn && btn.isConnected) btn.disabled = false;
      if (f.dataset.form === "intake" && f.isConnected) { f.reset(); f.member_code.focus(); }
    });
  });

  window.addEventListener("hashchange", () => {
    const t = (location.hash || "").slice(1);
    if (PAGES[t] && t !== current) show(t);
  });
  const start = (location.hash || "").slice(1);
  badges();
  show(PAGES[start] ? start : "overview");
})();
