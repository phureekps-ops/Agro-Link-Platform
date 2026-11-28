/**
 * พอร์ทัลภาครัฐ — กรมส่งเสริมสหกรณ์ติดตามการเชื่อมโยงเงินทุน สหกรณ์ออมทรัพย์ → สหกรณ์การเกษตร (อ่านอย่างเดียว)
 * Backend: GET /gov/coop-lending/overview, /gov/coop-lending/transactions.csv (backend/src/routes/coopLending.js)
 * เจ้าหน้าที่ระดับจังหวัดเห็นเฉพาะสหกรณ์ผู้กู้ในจังหวัดของตน · ระดับประเทศเลือกจังหวัดได้
 */
/* global AgroLinkGovAPI, CL, API_BASE */
(function () {
  const API = AgroLinkGovAPI;
  if (!API.requireSessionOrRedirect()) return;
  CL.init(API);
  const { esc, baht, date, dt } = CL;
  const body = document.getElementById("body");
  let province = new URLSearchParams(window.location.search).get("province") || "";
  document.getElementById("logoutBtn").addEventListener("click", () => API.logout());

  const pctTxt = (v) => (v == null ? "—" : `${v}%`);
  const meter = (v) => (v == null ? "" : `<div class="g-meter"><i style="width:${Math.max(0, Math.min(100, v))}%;background:${v >= 90 ? "#2e7d32" : v >= 70 ? "#c98a00" : "#c0392b"}"></i></div>`);
  const ACTION = {
    farmer_disputed: "เกษตรกรแจ้งว่ารายการไม่ตรงความจริง", sc_reject: "สหกรณ์ออมทรัพย์ปฏิเสธรายการเบิก", sc_return: "สหกรณ์ออมทรัพย์ส่งรายการกลับให้แก้",
    facility_suspended: "วงเงินถูกระงับ (ค้างชำระ)", plan_held: "ระงับแผนสินเชื่อการผลิต", settle_error: "บันทึกผลโอนผิดพลาด", stage_check_submitted: "ผลดาวเทียมของงวดต้องตรวจเพิ่ม",
  };
  const SATC = { pass: "#2e7d32", review: "#c0392b", insufficient: "#d99a00", na: "#a9b3ac" };
  const SATL = { pass: "ผ่าน", review: "ต้องตรวจเพิ่ม", insufficient: "ข้อมูลไม่พอ (เมฆ/ยังไม่ประเมิน)", na: "ไม่ได้ผูกแปลง" };

  async function load() {
    body.innerHTML = '<div class="cl-empty">กำลังโหลด…</div>';
    let d;
    try {
      d = await CL.get(`/gov/coop-lending/overview${province ? `?province=${encodeURIComponent(province)}` : ""}`);
    } catch (err) {
      body.innerHTML = `<div class="cl-card cl-late">โหลดข้อมูลไม่สำเร็จ: ${esc(CL.errText(err))}</div>`;
      return;
    }
    const o = d.officer;
    document.getElementById("officerName").textContent = o.full_name;
    document.getElementById("sandboxBox").innerHTML = CL.sandboxBanner(d.bank);
    const scopeName = o.scope_type === "Province" ? `จังหวัด${o.province_name_th || o.province_code}` : (province ? (d.provinces.find((p) => p.province_code === province) || {}).name_th || province : "ทั่วประเทศ");
    document.getElementById("scopeBox").innerHTML = `
      <div><b>ขอบเขตข้อมูล: ${esc(scopeName)}</b><div class="cl-muted">${o.scope_type === "Province" ? "เจ้าหน้าที่ระดับจังหวัด — เห็นเฉพาะสหกรณ์การเกษตรผู้กู้ในจังหวัดของท่าน" : "เจ้าหน้าที่ระดับประเทศ"} · ข้อมูล ณ ${esc(date(d.as_of))} · อ่านอย่างเดียว</div></div>
      <div class="cl-inline">${o.scope_type === "National" ? `<select id="provSel"><option value="">ทั่วประเทศ</option>${d.provinces.map((p) => `<option value="${esc(p.province_code)}" ${p.province_code === province ? "selected" : ""}>${esc(p.name_th)}</option>`).join("")}</select>` : ""}
        <button class="cl-btn ghost" id="csvBtn">⬇️ ส่งออกรายการเบิกทั้งหมด (CSV)</button></div>`;
    const sel = document.getElementById("provSel");
    if (sel) sel.onchange = () => { province = sel.value; const u = new URL(window.location.href); if (province) u.searchParams.set("province", province); else u.searchParams.delete("province"); window.history.replaceState(null, "", u); load(); };
    document.getElementById("csvBtn").onclick = (e) => downloadCsv(e.target);

    const t = d.totals; const k = d.kpi;
    const st = (v, l, warn) => `<div class="cl-stat${warn ? " warn" : ""}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    const planN = (s) => (d.plans.find((p) => p.status === s) || { n: 0, amount: 0, rai: 0 });
    const planAll = d.plans.filter((p) => ["Active", "Suspended", "Completed"].includes(p.status));
    const planRai = planAll.reduce((a, p) => a + p.rai, 0);
    const planAmt = planAll.reduce((a, p) => a + p.amount, 0);
    const satTotal = Object.values(k.satellite).reduce((a, b) => a + b, 0);
    const maxStage = Math.max(1, ...d.stages.map((s) => s.passed + s.current + s.held));

    body.innerHTML = `
      <div class="cl-stats">
        ${st(`${t.lenders} → ${t.borrowers}`, "สหกรณ์ออมทรัพย์ผู้ให้กู้ → สหกรณ์การเกษตรผู้กู้")}
        ${st(baht(t.limit_total), `วงเงินที่อนุมัติ (${t.facilities} วงเงิน${t.suspended ? `, ระงับ ${t.suspended}` : ""})`)}
        ${st(baht(t.disbursed), `เบิกจ่ายแล้ว (${k.funded_n} รายการ)`)}
        ${st(baht(t.paid_to_sellers), "ถึงมือผู้ขายปัจจัย/ผู้ให้บริการแล้ว")}
        ${st(baht(t.outstanding + t.asset_remaining), `ยอดหนี้คงค้าง · ชำระคืนแล้ว ${baht(t.repaid)}`)}
        ${st(baht(t.overdue_amount), `ค้างชำระเกินกำหนด${t.overdue_n ? ` (${t.overdue_n} รายการ)` : ""}`, t.overdue_amount > 0)}
      </div>

      <div id="marketBox"></div>
      <h2>🌾 สินเชื่อการผลิตแบบแบ่งงวดตามรอบการเพาะปลูก</h2>
      <div class="g-grid2">
        <div class="cl-card">
          <div class="g-kpi"><span>แผนที่กำลังดำเนินการ</span><b>${planN("Active").n}</b></div>
          <div class="g-kpi"><span>แผนที่ถูกระงับเพราะพบความผิดปกติ</span><b class="${planN("Suspended").n ? "bad" : ""}">${planN("Suspended").n}</b></div>
          <div class="g-kpi"><span>แผนที่ครบทุกงวด</span><b>${planN("Completed").n}</b></div>
          <div class="g-kpi"><span>รอสหกรณ์ออมทรัพย์อนุมัติ</span><b>${planN("Submitted").n}</b></div>
          <div class="g-kpi"><span>พื้นที่เพาะปลูกที่ได้รับสินเชื่อ</span><b>${CL.num(planRai, 0)} ไร่</b></div>
          <div class="g-kpi"><span>วงเงินตามแผน (เฉลี่ยต่อไร่)</span><b>${baht(planAmt)}${planRai ? ` <span class="cl-muted">(${baht(planAmt / planRai)}/ไร่)</span>` : ""}</b></div>
          <div class="g-note">เงินออกเป็นงวดตามกิจกรรมจริงในแปลง — งวดถัดไปเปิดเมื่อสหกรณ์ออมทรัพย์ตรวจผลแปลง (ภาพหน้างาน + ภาพถ่ายดาวเทียม) ของงวดก่อนแล้ว</div>
        </div>
        <div class="cl-card"><b>ความคืบหน้ารายงวด (จำนวนแผน)</b>
          ${d.stages.length ? `<table class="cl-table g-funnel">${d.stages.map((s) => `<tr><td>${s.seq}. ${esc(s.name_th)}</td>
            <td class="bar"><div class="g-stack" style="width:${((s.passed + s.current + s.held) / maxStage) * 100}%">${s.passed ? `<i style="flex:${s.passed};background:#2e7d32"></i>` : ""}${s.current ? `<i style="flex:${s.current};background:#4a86c5"></i>` : ""}${s.held ? `<i style="flex:${s.held};background:#c0392b"></i>` : ""}</div></td>
            <td class="r">${s.passed} / ${s.current}${s.held ? ` / <span class="cl-late">${s.held}</span>` : ""}</td></tr>`).join("")}</table>
            <div class="g-legend"><span style="--c:#2e7d32">ผ่านแล้ว</span><span style="--c:#4a86c5">กำลังดำเนินการ</span><span style="--c:#c0392b">ระงับ</span></div>`
            : '<div class="cl-empty">ยังไม่มีแผนที่อนุมัติ</div>'}
        </div>
      </div>

      <h2>🔎 ความโปร่งใสของการเบิกจ่าย</h2>
      <div class="g-grid2">
        <div class="cl-card">
          <div class="g-kpi"><span>รายการที่โอนแล้วมีหลักฐานครบ + เกษตรกรยืนยันเอง</span><b>${pctTxt(k.evidence_complete_pct)}</b></div>${meter(k.evidence_complete_pct)}
          <div class="g-kpi"><span>สหกรณ์ออมทรัพย์โอนภายในกำหนด</span><b>${pctTxt(k.sc_ontime_pct)}</b></div>${meter(k.sc_ontime_pct)}
          <div class="g-kpi"><span>สหกรณ์การเกษตรจ่ายผู้ขายภายในกำหนด</span><b>${pctTxt(k.ac_ontime_pct)}</b></div>${meter(k.ac_ontime_pct)}
          <div class="g-kpi"><span>เกษตรกรแจ้งว่าไม่ตรงความจริง / ถูกปฏิเสธ</span><b class="${k.disputed ? "bad" : ""}">${k.disputed} / ${k.rejected}</b></div>
          <div class="g-kpi"><span>ค่าปรับจากการโอน/จ่ายล่าช้า (จ่ายให้ผู้เสียหาย)</span><b>${baht(t.penalties)}</b></div>
        </div>
        <div class="cl-card"><b>ผลตรวจด้วยภาพถ่ายดาวเทียม (${satTotal} รายการเบิก)</b>
          ${satTotal ? `<div class="g-stack">${Object.entries(k.satellite).filter(([, v]) => v).map(([key, v]) => `<i style="flex:${v};background:${SATC[key]}" title="${SATL[key]} ${v}"></i>`).join("")}</div>
            <div class="g-legend">${Object.entries(k.satellite).map(([key, v]) => `<span style="--c:${SATC[key]}">${SATL[key]} ${v}</span>`).join("")}</div>` : '<div class="cl-empty">ยังไม่มีรายการ</div>'}
          <div class="g-note">"ต้องตรวจเพิ่ม" ไม่ใช่การปฏิเสธ — สหกรณ์ออมทรัพย์ต้องเปิดดูและบันทึกเหตุผลก่อนโอน · "ข้อมูลไม่พอ" มักเกิดจากเมฆในฤดูฝน ใช้ภาพหน้างานประกอบ</div>
        </div>
      </div>

      <h2>📍 แยกตามจังหวัด</h2>
      <div class="cl-card" style="overflow-x:auto">${d.by_province.length ? `<table class="cl-table"><tr><th>จังหวัด</th><th class="r">สหกรณ์ผู้กู้</th><th class="r">ผู้ให้กู้</th><th class="r">วงเงิน</th><th class="r">คงค้าง</th><th class="r">เกินกำหนด</th><th class="r">พื้นที่ตามแผน (ไร่)</th></tr>
        ${d.by_province.map((r) => `<tr><td>${o.scope_type === "National" ? `<a href="#" data-prov="${esc(r.province_code)}">${esc(r.province)}</a>` : esc(r.province)}</td><td class="r">${r.borrowers}</td><td class="r">${r.lenders}</td><td class="r">${baht(r.limit_total)}</td><td class="r">${baht(r.outstanding)}</td>
          <td class="r ${r.overdue > 0 ? "cl-late" : ""}">${baht(r.overdue)}</td><td class="r">${CL.num(r.plan_rai, 0)}</td></tr>`).join("")}</table>` : '<div class="cl-empty">ยังไม่มีวงเงินในขอบเขตนี้</div>'}</div>

      <h2>🤝 รายคู่สหกรณ์</h2>
      <div class="cl-card" style="overflow-x:auto">${d.facilities.length ? `<table class="cl-table"><tr><th>สหกรณ์ออมทรัพย์ → สหกรณ์การเกษตร</th><th>จังหวัด</th><th class="r">สมาชิก</th><th class="r">วงเงิน</th><th class="r">ดอกเบี้ย</th><th class="r">เบิกแล้ว</th><th class="r">คงค้าง</th><th class="r">เกินกำหนด</th><th class="r">จ่ายผู้ขายตรงเวลา</th><th class="r">แผนผลิต</th><th>สถานะ</th></tr>
        ${d.facilities.map((f) => `<tr><td>${esc(f.lender_name)}<br>→ <b>${esc(f.borrower_name)}</b></td><td>${esc(f.province)}</td><td class="r">${f.members}</td><td class="r">${baht(f.limit_amount)}</td><td class="r">${Number(f.rate_pct)}%</td>
          <td class="r">${baht(f.disbursed)}</td><td class="r">${baht(f.outstanding)}</td><td class="r ${Number(f.overdue) > 0 ? "cl-late" : ""}">${baht(f.overdue)}</td><td class="r">${pctTxt(f.ontime_pct)}</td><td class="r">${f.plans_active}</td>
          <td style="white-space:nowrap">${f.status === "Active" ? "ใช้งาน" : `<span class="cl-late">${esc(f.status === "Suspended" ? "ระงับ" : f.status)}</span>${f.suspended_reason ? `<div class="cl-muted">${esc(f.suspended_reason)}</div>` : ""}`}</td></tr>`).join("")}</table>` : '<div class="cl-empty">ไม่มี</div>'}</div>

      <h2>⚠️ ต้องติดตาม</h2>
      <div class="g-grid2">
        <div class="cl-card"><b>เลยกำหนดโอน/จ่าย ณ วันนี้ (${d.late.length})</b>
          ${d.late.length ? `<table class="cl-table">${d.late.map((r) => `<tr><td>${r.who === "sc" ? "สหกรณ์ออมทรัพย์ยังไม่โอน" : "สหกรณ์การเกษตรยังไม่จ่ายผู้ขาย"}<div class="cl-muted">${esc(r.party)}${r.who === "sc" ? ` → ${esc(r.borrower_name)}` : ""} · ${esc(r.description)}</div></td><td class="r">${baht(r.amount)}<div class="cl-late">กำหนด ${esc(date(r.due))}</div></td></tr>`).join("")}</table>` : '<div class="cl-empty">ไม่มี 👍</div>'}
        </div>
        <div class="cl-card"><b>เหตุการณ์ผิดปกติล่าสุด</b>
          ${d.alerts.length ? `<table class="cl-table">${d.alerts.map((a) => `<tr><td>${esc(ACTION[a.action] || a.action)}<div class="cl-muted">${esc(a.lender_name)} → ${esc(a.borrower_name)}${a.detail && a.detail.reason ? ` · ${esc(a.detail.reason)}` : ""}</div></td><td class="r cl-muted">${esc(dt(a.created_at))}</td></tr>`).join("")}</table>` : '<div class="cl-empty">ไม่มี</div>'}
        </div>
      </div>
      <div class="g-note" style="margin-top:14px">ทุกการเปิดดูหน้านี้และการส่งออกข้อมูลถูกบันทึกในบันทึกการเข้าถึงข้อมูล · ไม่แสดงเลขบัญชีธนาคารหรือข้อมูลส่วนบุคคลเกินจำเป็น</div>`;
    body.querySelectorAll("[data-prov]").forEach((a) => { a.onclick = (e) => { e.preventDefault(); province = a.dataset.prov; load(); }; });
    loadMarket();
  }

  const LST = { Review: "รอตรวจ", Returned: "ส่งกลับแก้", Listed: "ประกาศ", Offered: "มีข้อเสนอ", Matched: "จับคู่แล้ว", Signed: "ลงนามแล้ว", Active: "เบิกจ่าย/ชำระคืน", Closed: "ปิด", Withdrawn: "ถอน" };
  const PT = { member_onlending: "ปล่อยกู้ต่อสมาชิก", procurement: "ทุนรับซื้อผลผลิต", investment: "ลงทุนโครงการใหม่" };
  async function loadMarket() {
    const box = document.getElementById("marketBox");
    if (!box) return;
    let m;
    try { m = await CL.get(`/gov/coop-lending/market${province ? `?province=${encodeURIComponent(province)}` : ""}`); } catch (err) { box.innerHTML = ""; return; }
    // เตือนภัยล่วงหน้า (9.3) / สัญญาณทุจริต (10.3) — ยังไม่ได้รัน grant_coop_lending_risk.sql ก็แสดงส่วนอื่นได้ตามปกติ
    const rs = await CL.get(`/gov/coop-lending/market/risk-summary${province ? `?province=${encodeURIComponent(province)}` : ""}`).catch(() => null);
    const rsum = (cat, sts) => (rs || []).filter((x) => x.category === cat && sts.includes(x.status)).reduce((a, x) => a + x.n, 0);
    const rx = await CL.get(`/gov/coop-lending/market/restructure-summary${province ? `?province=${encodeURIComponent(province)}` : ""}`).catch(() => null);
    const rxOf = (st) => (rx || []).find((x) => x.status === st) || { n: 0, outstanding: 0 };
    const r = m.registry; const f = m.flow; const nc = m.national_counts;
    const cmeter = (v) => `<div class="g-meter"><i style="width:${Math.max(1, Math.min(100, v))}%;background:#4a86c5"></i></div>`;
    const cov = (a, b) => `${a.toLocaleString("th-TH")} / ${b.toLocaleString("th-TH")} แห่ง (${b ? Math.round((a / b) * 1000) / 10 : 0}%)`;
    const st = (k) => m.by_status.filter((x) => x.status === k).reduce((a, x) => a + x.n, 0);
    const funnel = [["ประกาศ", f.listed], ["มีข้อเสนอ", m.offers.listings_with_offers], ["จับคู่", f.matched], ["ลงนาม", f.signed]];
    const max = Math.max(1, ...funnel.map((x) => x[1]));
    const GC = { A: "#1f6b38", B: "#4a8a2e", C: "#c98a00", D: "#b35a00", E: "#a1261d" };
    const gTot = m.grades.reduce((a, g) => a + g.n, 0);
    box.innerHTML = `<h2>📣 ตลาดสินเชื่อระหว่างสหกรณ์ (ผู้ขอกู้ประกาศ ผู้ให้กู้แข่งกันเสนอ)</h2>
      <div class="g-grid2">
        <div class="cl-card"><b>ฐานข้อมูลสหกรณ์ในระบบ เทียบจำนวนทั้งประเทศ</b>
          <div class="g-kpi"><span>สหกรณ์ออมทรัพย์</span><b style="font-size:15px">${cov(r.savings, nc.savings)}</b></div>${cmeter((r.savings / nc.savings) * 100)}
          <div class="g-kpi"><span>สหกรณ์เครดิตยูเนี่ยน</span><b style="font-size:15px">${cov(r.credit_unions, nc.credit_unions)}</b></div>${cmeter((r.credit_unions / nc.credit_unions) * 100)}
          <div class="g-kpi"><span>สหกรณ์การเกษตรที่มีข้อมูลผู้ขอกู้${province ? " (จังหวัดนี้)" : ""}</span><b style="font-size:15px">${province ? `${r.borrower_profiles} แห่ง` : cov(r.borrower_profiles, nc.agri)}</b></div>${province ? "" : cmeter((r.borrower_profiles / nc.agri) * 100)}
          <div class="g-kpi"><span>ผู้ให้กู้ที่กำหนดนโยบายสินเชื่อแล้ว · เงินที่ประกาศว่าจัดสรรได้</span><b style="font-size:15px">${r.lender_profiles} แห่ง · ${baht(r.allocatable)}</b></div>
          <div class="g-note">${esc(nc.source)} — ตัวเลขตามทะเบียนรวมสหกรณ์ที่ยังไม่เริ่มดำเนินการ</div></div>
        <div class="cl-card"><b>การจับคู่</b>
          <table class="cl-table g-funnel">${funnel.map(([k, v]) => `<tr><td style="width:90px">${k}</td><td class="bar"><div class="g-stack" style="width:${(v / max) * 100}%"><i style="flex:1;background:#2e7d32"></i></div></td><td class="r">${v}</td></tr>`).join("")}</table>
          <div class="g-kpi"><span>อัตราการจับคู่สำเร็จ</span><b>${pctTxt(f.match_rate_pct)}</b></div>
          <div class="g-kpi"><span>ข้อเสนอเฉลี่ยต่อโครงการ · ดอกเบี้ยเฉลี่ย</span><b>${m.offers.per_listing ?? "—"} · ${m.offers.avg_rate != null ? `${m.offers.avg_rate}%` : "—"}</b></div>
          <div class="g-kpi"><span>ระยะเวลาประกาศ → ลงนาม (เฉลี่ย)</span><b>${f.avg_days_to_sign != null ? `${f.avg_days_to_sign} วัน` : "—"}</b></div>
          <div class="g-kpi"><span>วงเงินตามสัญญาที่ลงนาม · ผู้ให้กู้ร่วมหลายราย</span><b>${baht(f.signed_amount)} · ${f.syndicated} สัญญา</b></div>
          ${gTot ? `<div style="margin-top:8px"><b>ระดับความเสี่ยงของโครงการที่ยื่น</b><div class="g-stack">${m.grades.map((g) => `<i style="flex:${g.n};background:${GC[g.grade] || "#999"}" title="เกรด ${g.grade}: ${g.n}"></i>`).join("")}</div>
            <div class="g-legend">${m.grades.map((g) => `<span style="--c:${GC[g.grade] || "#999"}">เกรด ${g.grade} ${g.n}</span>`).join("")}</div></div>` : ""}
          <div class="g-note">รอตรวจ ${st("Review")} · ประกาศ/มีข้อเสนอ ${st("Listed") + st("Offered")} · รอลงนาม ${st("Matched")}</div></div>
        ${m.controls ? `<div class="cl-card"><b>การควบคุมการใช้เงิน (No Verification, No Disbursement)</b>
          <div class="g-kpi"><span>งวดเบิกที่ผู้ให้กู้ตรวจปิดยอดแล้ว</span><b>${m.controls.tranches_verified} / ${m.controls.tranches} งวด</b></div>
          <div class="g-kpi"><span>รายการจ่ายผู้ขายที่มีหลักฐาน · ระดับหลักฐานเฉลี่ย (1–5)</span><b>${pctTxt(m.controls.evidenced_pct)} · ${m.controls.avg_level ?? "—"}</b></div>
          <div class="g-kpi"><span>รายการถูกปฏิเสธ/โต้แย้ง (สัญญาณใช้เงินผิดวัตถุประสงค์)</span><b>${m.controls.misuse_flags}</b></div>
          <div class="g-kpi"><span>Go-live Gate ที่ผ่าน (ทั้งแพลตฟอร์ม)</span><b>${m.controls.gates_passed} / 8</b></div>
          ${rs ? `<div class="g-kpi"><span>เตือนภัยล่วงหน้าที่เปิดอยู่ (ยอดรับซื้อ/ราคา/รายงาน/รายได้/การโอน)</span><b>${rsum("early_warning", ["Open", "Investigating"])} เรื่อง</b></div>
          <div class="g-kpi"><span>สัญญาณที่ต้องตรวจสอบ: รอตรวจ · กำลังสอบสวน · ปิดแล้ว</span><b>${rsum("fraud", ["Open"])} · ${rsum("fraud", ["Investigating"])} · ${rsum("fraud", ["Resolved", "Dismissed"])}</b></div>
          <div class="g-note">${esc(CL.ALERT_NOTE)}</div>` : ""}
          ${rx ? `<div class="g-kpi"><span>สัญญาที่ปรับโครงสร้างหนี้แล้ว · รอพิจารณา</span><b>${rxOf("Approved").n} (${baht(rxOf("Approved").outstanding)}) · ${rxOf("Pending").n}</b></div>` : ""}
          <div class="g-note">ระดับหลักฐาน: 1 เอกสาร · 2 ยืนยันกับคู่ค้า/สมาชิก · 3 ธุรกรรมธนาคาร · 4 IoT/ภาคสนาม/ดาวเทียม/ระบบโคนม · 5 ผู้ตรวจอิสระ</div></div>` : ""}
      </div>
      <div class="cl-card" style="overflow-x:auto">${m.listings.length ? `<table class="cl-table"><tr><th>โครงการ</th><th>ผู้ขอกู้</th><th>ประเภท</th><th class="r">วงเงิน</th><th>เกรด</th><th class="r">ข้อเสนอ</th><th>สถานะ</th><th>ผู้ให้กู้ตามสัญญา</th></tr>
        ${m.listings.map((l) => `<tr><td>${esc(l.title)}</td><td>${esc(l.borrower_name)}<div class="cl-muted">${esc(l.province_name_th || "")}</div></td><td>${esc(PT[l.project_type])}</td><td class="r">${baht(l.amount_requested)}</td>
          <td>${esc(l.grade || "-")}</td><td class="r">${l.offers}</td><td>${esc(LST[l.status] || l.status)}</td><td>${esc(l.lenders || "-")}</td></tr>`).join("")}</table>` : '<div class="cl-empty">ยังไม่มีโครงการที่ประกาศ</div>'}</div>`;
    // ทะเบียนสหกรณ์ล่วงหน้า: สหกรณ์ในจังหวัดที่เข้าร่วม/ยังไม่เข้าร่วม (เมื่อผู้ดูแลนำเข้าทะเบียนแล้ว)
    const cv = await CL.get(`/gov/coop-lending/registry/coverage${province ? `?province=${encodeURIComponent(province)}` : ""}`).catch(() => null);
    if (cv && cv.installed && cv.by_type.length) {
      const el = document.createElement("div");
      el.className = "cl-card";
      const ORDER = ["agriculture", "fisheries", "settlement", "savings", "credit_union", "store", "service"];
      const rows = ORDER.map((k) => cv.by_type.find((x) => x.coop_type === k)).filter(Boolean);
      el.innerHTML = `<b>ความครอบคลุมเทียบทะเบียนสหกรณ์${province ? " (จังหวัดนี้)" : " (ทั้งประเทศ)"}</b>${cv.source ? `<div class="g-note">ทะเบียน: ${esc(cv.source.source_label)}</div>` : ""}
        <table class="cl-table" style="margin-top:6px"><tr><th>ประเภท</th><th class="r">ดำเนินการ</th><th class="r">มีบัญชีใน AgroLink</th><th class="r">อยู่ในตลาดสินเชื่อ</th><th style="width:30%"></th></tr>
        ${rows.map((x) => `<tr><td>${esc(CL.COOP_TYPE[x.coop_type])}</td><td class="r">${x.active.toLocaleString("th-TH")}</td><td class="r">${x.linked.toLocaleString("th-TH")}</td><td class="r">${x.in_market.toLocaleString("th-TH")}</td>
          <td>${cmeter(x.active ? (x.linked / x.active) * 100 : 0)}</td></tr>`).join("")}</table>
        ${cv.not_joined.length ? `<details class="cl-more"><summary>สหกรณ์ที่ยังไม่เข้าร่วม (${cv.not_joined.length}${cv.not_joined.length >= 300 ? "+" : ""} แห่ง เรียงตามจำนวนสมาชิก) — ใช้ประชาสัมพันธ์/ชวนเข้าร่วม</summary>
          <table class="cl-table">${cv.not_joined.map((x) => `<tr><td>${esc(x.coop_name)}<div class="cl-muted">${esc(x.registration_no || "-")}</div></td><td>${esc(CL.COOP_TYPE[x.coop_type])}</td><td>${esc(x.province_name_th || "")}${x.district ? ` อ.${esc(x.district)}` : ""}</td><td class="r">${x.member_count != null ? `${x.member_count.toLocaleString("th-TH")} คน` : "-"}</td></tr>`).join("")}</table></details>` : ""}`;
      box.appendChild(el);
    }
  }
  async function downloadCsv(btn) {
    btn.disabled = true;
    try {
      const s = API.getSession();
      const res = await fetch(`${API_BASE}/gov/coop-lending/transactions.csv${province ? `?province=${encodeURIComponent(province)}` : ""}`, { headers: { Authorization: `Bearer ${s.access_token}` } });
      if (!res.ok) throw new Error("ส่งออกไม่สำเร็จ");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await res.blob());
      a.download = `coop-lending-${province || "all"}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
    } catch (err) { CL.toast(err.message, true); } finally { btn.disabled = false; }
  }
  load();
}());
