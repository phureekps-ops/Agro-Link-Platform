/**
 * พอร์ทัลสหกรณ์ออมทรัพย์ / เครดิตยูเนี่ยน — ตลาดสินเชื่อระหว่างสหกรณ์ (ผู้ให้กู้)
 * Backend: /savings/market/* (backend/src/routes/coopMarket.js)
 *   ค้นหาโครงการ (กรองตามประเภท พื้นที่ วงเงิน ระยะเวลา ชนิดพืช ระดับความเสี่ยง หรือเฉพาะที่ตรงนโยบาย) · ดูข้อมูลผู้ขอกู้โดยละเอียด
 *   · ถาม–ตอบ/ขอเอกสาร/นัดเยี่ยม · ยื่น/แก้/ถอนข้อเสนอ (แจ้งเตือนเพดาน) · ยืนยันตามอำนาจอนุมัติ · ดาวน์โหลดและลงนามสัญญา
 */
/* global CL */
window.LenderMarket = (function () {
  const { esc, baht, date, dt, pill, num } = CL;
  let ctx = null; // { view, refresh, isStaff }
  let detailId = null;
  let filters = { match_only: "" };
  const n0 = (v) => (v == null || v === "" ? "" : v);
  const optList = (pairs, sel) => pairs.map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(v)}</option>`).join("");
  const provName = (code) => (CL.PROVINCES.find((p) => p[0] === code) || [code, code || "-"])[1];

  // ======================================================== ค้นหาโครงการ
  async function renderBrowse(c) {
    ctx = c;
    if (detailId) return renderDetail();
    const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
    const d = await CL.get(`/savings/market/listings${qs ? `?${qs}` : ""}`);
    ctx.view.innerHTML = `
      ${d.has_profile ? "" : '<div class="cl-card cl-flag">ยังไม่ได้กรอกข้อมูลและนโยบายสินเชื่อของสหกรณ์ — กรอกที่แท็บ "ข้อมูลและนโยบายสินเชื่อ" ก่อนยื่นข้อเสนอ และเพื่อให้ระบบแจ้งเตือนโครงการที่ตรงนโยบาย</div>'}
      <div class="cl-card"><form id="flt" class="cl-form">
        <div><label>ประเภทโครงการ</label><select name="type"><option value="">ทั้งหมด</option>${optList(Object.entries(CL.PTYPE), filters.type)}</select></div>
        <div><label>จังหวัด</label><select name="province"><option value="">ทั้งหมด</option>${optList(CL.PROVINCES, filters.province)}</select></div>
        <div><label>วงเงินตั้งแต่</label><input name="min" type="number" value="${esc(n0(filters.min))}"></div>
        <div><label>วงเงินไม่เกิน</label><input name="max" type="number" value="${esc(n0(filters.max))}"></div>
        <div><label>ระยะเวลาไม่เกิน (เดือน)</label><input name="tenor_max" type="number" value="${esc(n0(filters.tenor_max))}"></div>
        <div><label>ชนิดพืช</label><input name="commodity" value="${esc(n0(filters.commodity))}" placeholder="RICE_JASMINE"></div>
        <div><label>ระดับความเสี่ยงไม่ต่ำกว่า</label><select name="grade"><option value="">ทั้งหมด</option>${optList(["A", "B", "C", "D"].map((g) => [g, `เกรด ${g} ขึ้นไป`]), filters.grade)}</select></div>
        <div><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="match_only" value="1" ${filters.match_only ? "checked" : ""} style="width:auto"> เฉพาะที่ตรงนโยบายของเรา</label><button class="cl-btn" type="submit">ค้นหา</button></div>
      </form></div>
      <div class="section-title">โครงการ (${d.listings.length})</div>
      ${d.listings.map((l) => `<div class="cl-card" data-open="${l.listing_id}" style="cursor:pointer">
        <div class="cl-row"><div><b>${esc(l.title)}</b></div><div>${CL.gradeBadge(l.grade, l.score_value)} ${l.policy.match ? '<span class="cl-pill" style="background:#ddf3e4;color:#1f6b38">ตรงนโยบาย</span>' : `<span class="cl-pill" style="background:#eef1ee;color:#6b7a70" title="${esc(l.policy.mismatches.join(", "))}">ไม่ตรง: ${esc(l.policy.mismatches.slice(0, 2).join(", "))}</span>`}</div></div>
        <div class="cl-line">${esc(l.borrower_name)} · ${esc(l.province_name_th || provName(l.province_code))} · ${esc(CL.PTYPE[l.project_type])}</div>
        <div class="cl-line">ขอกู้ <b>${baht(l.amount_requested)}</b>${l.min_amount ? ` (รับบางส่วนขั้นต่ำ ${baht(l.min_amount)})` : ""} · ${l.tenor_months} เดือน · ข้อเสนอแล้ว ${l.live_offers} ราย · ถาม–ตอบ ${l.questions}
          ${l.offers_close_on ? ` · รับข้อเสนอถึง ${esc(date(l.offers_close_on))}` : ""} ${["Listed", "Offered"].includes(l.status) ? "" : pill(CL.LISTING_ST[l.status])}
          ${l.my_offer ? ` · ข้อเสนอของเรา: ${pill(CL.OFFER_ST[l.my_offer.status])}` : ""}</div></div>`).join("") || '<div class="cl-empty">ไม่พบโครงการตามเงื่อนไข</div>'}`;
    document.getElementById("flt").onsubmit = (e) => { e.preventDefault(); filters = CL.formData(e.target); filters.match_only = e.target.match_only.checked ? "1" : ""; renderBrowse(ctx); };
    ctx.view.onclick = (e) => { const o = e.target.closest("[data-open]"); if (o) { detailId = o.dataset.open; renderBrowse(ctx); } };
  }

  function finTable(fin) {
    const F = [["total_assets", "สินทรัพย์รวม"], ["total_liabilities", "หนี้สินรวม"], ["equity", "ทุนของสหกรณ์"], ["current_assets", "สินทรัพย์หมุนเวียน"], ["current_liabilities", "หนี้สินหมุนเวียน"], ["revenue", "รายได้"], ["net_income", "กำไรสุทธิ"]];
    const ys = [...(fin || [])].sort((a, b) => b.year - a.year);
    if (!ys.length) return '<div class="cl-muted">ไม่มีงบการเงิน</div>';
    const AO = { unqualified: "ไม่มีเงื่อนไข", qualified: "มีเงื่อนไข", adverse: "ไม่ถูกต้อง", disclaimer: "ไม่แสดงความเห็น" };
    return `<table class="cl-table"><tr><th>รายการ (บาท)</th>${ys.map((y) => `<th class="r">${y.year}</th>`).join("")}</tr>
      ${F.map(([k, l]) => `<tr><td>${l}</td>${ys.map((y) => `<td class="r">${y[k] != null ? num(y[k], 0) : "-"}</td>`).join("")}</tr>`).join("")}
      <tr><td>ความเห็นผู้สอบบัญชี</td>${ys.map((y) => `<td class="r">${esc(AO[y.audit_opinion] || "-")}</td>`).join("")}</tr></table>`;
  }

  async function renderDetail() {
    const d = await CL.get(`/savings/market/listings/${detailId}`);
    const l = d.listing;
    const det = l.details || {};
    const bp = d.borrower.profile;
    const open = ["Listed", "Offered"].includes(l.status);
    const live = d.my_offers.find((o) => ["Submitted", "Countered", "Accepted", "Confirmed"].includes(o.status));
    const ag = d.agreement;
    const myParty = ag && ag.parties.find((p) => d.my_offers.some((o) => o.offer_id === p.offer_id));
    const ex = d.exposure;
    const prof = d.lender_profile || {};
    const typeInfo = l.project_type === "member_onlending"
      ? [["สมาชิกผู้กู้", det.members_count], ["วงเงินต่อราย", det.per_member_limit && baht(det.per_member_limit)], ["ผลชำระสมาชิกย้อนหลัง", det.member_repayment_pct != null && `${det.member_repayment_pct}%`], ["แปลง/พื้นที่", det.plots_count && `${det.plots_count} แปลง ${n0(det.area_rai)} ไร่`], ["แผนการผลิต", det.production_plan]]
      : l.project_type === "procurement"
        ? [["ผลผลิต", det.commodity], ["ปริมาณ", det.volume_t && `${num(det.volume_t, 0)} ตัน`], ["ช่วงรับซื้อ", det.period_from && `${date(det.period_from)} – ${date(det.period_to)}`], ["ราคาอ้างอิง", det.reference_price && `${det.reference_price} บาท/กก.`], ["ผู้ซื้อปลายทาง", det.end_buyers], ["ประวัติธุรกิจรวบรวม", det.history]]
        : [["แผนธุรกิจ", det.business_plan], ["ผู้ขาย/ผู้รับจ้าง", det.vendor], ["ใบเสนอราคา", det.quotation_total && baht(det.quotation_total)], ["คืนทุน", det.payback_years && `${det.payback_years} ปี`]];
    ctx.view.innerHTML = `
      <div class="cl-card"><div class="cl-row"><button class="cl-btn ghost" data-back="1">← ตลาดโครงการ</button><div>${pill(CL.LISTING_ST[l.status])} ${CL.gradeBadge(d.score.grade, d.score.score)}</div></div>
        <h3 style="margin-top:10px">${esc(l.title)}</h3>
        <div class="cl-line">${esc(d.borrower.org_name)} · ${esc(d.borrower.province_name_th || "")} · ${esc(CL.PTYPE[l.project_type])}</div>
        <div class="cl-line">ขอกู้ <b>${baht(l.amount_requested)}</b>${l.min_amount ? ` (รับบางส่วนขั้นต่ำ ${baht(l.min_amount)})` : ""} · ${l.tenor_months} เดือน${l.grace_months ? ` · ปลอดเงินต้น ${l.grace_months} เดือน` : ""}${l.offers_close_on ? ` · รับข้อเสนอถึง ${esc(date(l.offers_close_on))}` : ""}
          · ผู้ให้กู้รายอื่นเสนอแล้ว ${d.other_offers.n} ราย ${baht(d.other_offers.amount)}</div>
        ${d.policy.match ? '<div class="cl-line" style="color:#1f6b38">✅ ตรงนโยบายสินเชื่อของสหกรณ์</div>' : `<div class="cl-flag">ไม่ตรงนโยบาย: ${esc(d.policy.mismatches.join(", "))}</div>`}
        ${l.objective ? `<div class="cl-line">${esc(l.objective)}</div>` : ""}</div>

      <div class="cl-card"><h3>รายละเอียดโครงการ</h3>
        <table class="cl-table">${typeInfo.filter(([, v]) => v).map(([k, v]) => `<tr><td style="width:180px">${k}</td><td>${esc(v)}</td></tr>`).join("")}
          <tr><td>แผนชำระคืน</td><td>${esc(l.repayment_plan || "-")}${l.repayment_source ? `<div class="cl-muted">แหล่งชำระคืน: ${esc(l.repayment_source)}</div>` : ""}</td></tr></table>
        <div class="cl-line" style="margin-top:8px"><b>แผนการใช้เงิน</b></div>
        <table class="cl-table">${(l.use_plan || []).map((u) => `<tr><td>${esc(u.item)}</td><td class="r">${baht(u.amount)}</td><td>${esc(u.timing || "")}</td></tr>`).join("")}</table>
        ${(det.projections || []).length ? `<div class="cl-line" style="margin-top:8px"><b>ประมาณการกระแสเงินสด</b></div><table class="cl-table"><tr><th>ปี</th><th class="r">รายได้</th><th class="r">ค่าใช้จ่าย</th><th class="r">กระแสเงินสดสุทธิ</th></tr>${det.projections.map((p) => `<tr><td>${esc(p.year)}</td><td class="r">${p.revenue != null ? num(p.revenue, 0) : "-"}</td><td class="r">${p.cost != null ? num(p.cost, 0) : "-"}</td><td class="r">${p.net_cash != null ? num(p.net_cash, 0) : "-"}</td></tr>`).join("")}</table>` : ""}
        <div class="cl-line" style="margin-top:8px"><b>หลักประกันที่เสนอ</b></div>
        ${(l.collateral || []).length ? `<table class="cl-table">${l.collateral.map((x) => `<tr><td>${esc(x.kind)}</td><td>${esc(x.description || "")}</td><td class="r">${x.value != null ? baht(x.value) : "-"}</td></tr>`).join("")}</table>` : '<div class="cl-muted">ไม่มี</div>'}
        <div style="margin-top:8px">${CL.riskPanel(d.risk)}</div>
        <div class="cl-ev" style="margin-top:8px">${d.documents.map((x) => `<a href="#" data-doc="${x.doc_id}">📎 ${esc(x.title)}</a>`).join("") || '<span class="miss">ไม่มีเอกสารแนบ</span>'}</div></div>

      <div class="cl-card"><h3>ข้อมูลผู้ขอกู้</h3>${CL.scorePanel(d.score)}
        ${bp ? `<div class="cl-line" style="margin-top:10px">เลขทะเบียน ${esc(bp.registration_no || "-")} · จัดตั้ง ${esc(bp.established_year || "-")} · สมาชิก ${esc(bp.member_count ?? "-")} คน · สมาชิกในระบบ ${d.borrower.platform.members_on_platform} ราย ${d.borrower.platform.plots} แปลง ${num(d.borrower.platform.area_rai, 0)} ไร่</div>
          <div class="cl-line">ผู้มีอำนาจลงนาม: ${esc(bp.signatories || "-")}</div>
          <div style="margin-top:8px">${finTable(bp.financials)}</div>
          <div class="cl-line" style="margin-top:8px"><b>ธุรกิจ</b> ${Object.entries(bp.businesses || {}).filter(([, v]) => v && (v.volume || v.value)).map(([k, v]) => `${{ credit: "สินเชื่อ", supply: "จัดหาสินค้า", collection: "รวบรวมผลผลิต", processing: "แปรรูป", service: "บริการ" }[k]}: ${esc(v.volume || "")} ${v.value ? baht(v.value) : ""}`).join(" · ") || "-"}</div>
          <div class="cl-line"><b>หนี้สินเดิม</b> ${(bp.debts || []).map((x) => `${esc(x.creditor)} ${x.outstanding != null ? baht(x.outstanding) : ""} (${{ current: "ปกติ", late: "ค้างชำระ", restructured: "ปรับโครงสร้าง", default: "ผิดนัด" }[x.status]})`).join(" · ") || "ไม่มี"}</div>
          <div class="cl-line"><b>ทรัพย์สิน</b> ${(bp.assets || []).map((x) => `${esc(x.kind)} ${x.value != null ? baht(x.value) : ""}${x.pledged ? " (ติดภาระ)" : ""}`).join(" · ") || "-"}</div>
          <div class="cl-line"><b>การกำกับดูแล</b> ${esc({ excellent: "ดีเลิศ", very_good: "ดีมาก", good: "ดี", pass: "ผ่าน", fail: "ไม่ผ่าน" }[(bp.governance || {}).standard_grade] || "-")} ${(bp.governance || {}).unresolved_issues ? `<span class="cl-late">ข้อบกพร่องค้าง: ${esc(bp.governance.unresolved_issues)}</span>` : ""}</div>`
    : '<div class="cl-muted">ผู้ขอกู้ยังไม่ได้ให้ความยินยอมเปิดเผยข้อมูลโดยละเอียด</div>'}</div>

      <div class="cl-card"><h3>ถาม–ตอบ</h3>${d.questions.map((q) => `<div class="cl-line" style="border-top:1px solid #eef1ee;padding-top:6px">${q.mine ? "<b>เรา</b>" : "ผู้ให้กู้รายหนึ่ง"}: ${esc(q.question)} <span class="cl-muted">${esc(dt(q.created_at))}</span>${q.answer ? `<div>↳ ${esc(q.answer)}</div>` : '<div class="cl-muted">รอผู้ขอกู้ตอบ</div>'}</div>`).join("") || '<div class="cl-muted">ยังไม่มี</div>'}
        ${open ? `<div class="cl-actions cl-inline"><select id="qKind">${optList([["question", "คำถาม"], ["document_request", "ขอเอกสารเพิ่มเติม"], ["visit_request", "ขอนัดเยี่ยมชมสหกรณ์"]], "question")}</select><input id="qText" style="min-width:340px" placeholder="พิมพ์คำถาม"><button class="cl-btn ghost" data-a="ask">ส่ง</button></div>` : ""}</div>

      <div class="cl-card"><h3>ข้อเสนอของเรา</h3>
        <div class="cl-muted">ยอดผูกพันของเรา (วงเงินที่เปิดแล้ว + ข้อเสนอที่ยังมีผล): รวม ${baht(ex.total)} · กับผู้กู้รายนี้ ${baht(ex.borrower)} · จังหวัดนี้ ${baht(ex.province)} · ประเภทนี้ ${baht(ex.type)}${prof.allocatable_amount != null ? ` · เงินที่จัดสรรได้ ${baht(prof.allocatable_amount)}` : ""}</div>
        ${d.my_offers.map((o) => `<div class="cl-line" style="border-top:1px solid #eef1ee;padding-top:6px" data-o="${o.offer_id}">${pill(CL.OFFER_ST[o.status])} ${baht(o.amount)} · ${Number(o.rate_pct)}% · ${o.tenor_months} เดือน · ${o.repayment_type === "bullet" ? "ต้นครั้งเดียว" : `ผ่อนทุก ${o.interval_months} ด.`}
          ${o.counter ? `<div style="color:#8a5a00">ผู้ขอกู้โต้ตอบ: ${[o.counter.amount ? baht(o.counter.amount) : "", o.counter.rate_pct != null ? `${o.counter.rate_pct}%` : "", o.counter.tenor_months ? `${o.counter.tenor_months} เดือน` : "", o.counter.note || ""].filter(Boolean).map(esc).join(" · ")}</div>` : ""}
          ${(o.warnings || []).map((w) => `<div class="cl-flag">⚠️ ${esc(w.message)}</div>`).join("")}
          ${o.status === "Accepted" ? `<div class="cl-actions cl-inline">ผู้ขอกู้เลือกข้อเสนอนี้ — ยืนยันตามอำนาจอนุมัติ (ต้องเป็นคนละคนกับผู้ยื่น): <input class="ap-ref" placeholder="เลขที่มติ/บันทึกอนุมัติ"><button class="cl-btn" data-a="confirm">ยืนยัน</button><button class="cl-btn bad" data-a="withdraw">ถอน</button></div>` : ""}
          ${["Submitted", "Countered"].includes(o.status) && open ? '<div class="cl-actions"><button class="cl-btn ghost" data-a="revise">แก้ไขข้อเสนอ</button><button class="cl-btn bad" data-a="withdraw">ถอนข้อเสนอ</button></div>' : ""}</div>`).join("")}
        ${open && (!live || ["Submitted", "Countered"].includes(live.status)) ? `<form id="offerForm" class="cl-form" style="margin-top:10px;${live ? "display:none" : ""}">
          <div><label>วงเงินที่เสนอ (บาท)</label><input name="amount" type="number" required value="${esc(live ? live.amount : l.amount_requested)}"></div>
          <div><label>ดอกเบี้ย (% ต่อปี)</label><input name="rate_pct" type="number" step="0.01" required value="${esc(live ? live.rate_pct : n0((prof.policy || {}).rate_min))}"></div>
          <div><label>ระยะเวลา (เดือน)</label><input name="tenor_months" type="number" required value="${esc(live ? live.tenor_months : l.tenor_months)}"></div>
          <div><label>การชำระ</label><select name="repayment_type">${optList([["installment", "ผ่อนเงินต้นพร้อมดอกเบี้ย"], ["bullet", "ดอกเบี้ยเป็นงวด ต้นครั้งเดียว"]], live ? live.repayment_type : (l.project_type === "investment" ? "installment" : "bullet"))}</select></div>
          <div><label>ทุกกี่เดือน</label><select name="interval_months">${optList([["1", "1"], ["3", "3"], ["6", "6"], ["12", "12"]], String(live ? live.interval_months : 6))}</select></div>
          <div><label>ปลอดเงินต้น (เดือน)</label><input name="grace_months" type="number" value="${esc(live ? live.grace_months : l.grace_months || 0)}"></div>
          <div><label>ยืนข้อเสนอถึง</label><input name="valid_until" type="date" value="${esc(live && live.valid_until ? live.valid_until : n0(l.offers_close_on))}"></div>
          <div class="wide"><label>หลักประกันที่ต้องการ</label><input name="collateral_required" value="${esc(live ? n0(live.collateral_required) : "")}"></div>
          <div class="wide"><label>เงื่อนไขอื่น</label><input name="conditions" value="${esc(live ? n0(live.conditions) : "")}" placeholder="เช่น รายงานผลผลิตทุกเดือน รักษาอัตราส่วนสภาพคล่อง ≥ 1"></div>
          <div class="wide cl-actions"><button class="cl-btn" type="submit">${live ? "บันทึกการแก้ไข" : "ยื่นข้อเสนอ"}</button><span class="cl-muted">ข้อเสนอเป็นการแสดงเจตนาเบื้องต้น — ผูกพันเมื่อผู้มีอำนาจอนุมัติของสหกรณ์ยืนยันหลังผู้ขอกู้เลือก</span></div></form>` : ""}</div>

      ${ag && myParty ? `<div class="cl-card"><h3>สัญญาเลขที่ ${esc(ag.agreement_no)}</h3>
        <div class="cl-line">วงเงินรวม ${baht(ag.total_amount)} · ส่วนของเรา ${baht(myParty.amount)} (${num(myParty.share_pct)}%) · ผู้กู้ลงนาม ${ag.borrower_signed ? "✅" : "⏳"} · ${ag.parties.map((p) => `${esc(p.org_name)} ${p.signed ? "✅" : "⏳"}`).join(" · ")}</div>
        <div class="cl-actions"><button class="cl-btn blue" data-a="docx" data-ag="${ag.agreement_id}">⬇️ ดาวน์โหลดชุดเอกสารสัญญา (.docx)</button></div>
        ${ag.status === "Drafted" && !myParty.signed ? `<div class="cl-actions cl-inline">ฉบับลงนามของเรา <input type="file" id="signFile" accept="application/pdf,image/*"><button class="cl-btn" data-a="sign" data-ag="${ag.agreement_id}">อัปโหลดฉบับลงนาม</button></div>` : ""}
        ${ag.status === "Signed" ? `<div class="cl-line">✅ ลงนามครบ — วงเงินเปิดแล้ว ติดตามรายการเบิกที่แท็บ "รายการรอโอน" และ "วงเงินที่อนุมัติ"</div>` : ""}
        ${d.reports.length ? `<div class="cl-line" style="margin-top:8px"><b>รายงานผลจากผู้กู้</b></div><table class="cl-table"><tr><th>งวด</th><th class="r">รายได้จริง</th><th class="r">ตามแผน</th><th>หมายเหตุ</th></tr>${d.reports.map((r) => `<tr><td>${esc(r.period_label)}</td><td class="r">${r.revenue != null ? num(r.revenue) : "-"}</td><td class="r">${r.planned_revenue != null ? num(r.planned_revenue) : "-"}</td><td>${esc(r.note || "")}</td></tr>`).join("")}</table>` : ""}</div>` : ""}`;

    const of = document.getElementById("offerForm");
    if (of) {
      of.onsubmit = async (e) => {
        e.preventDefault();
        const body = CL.formData(of);
        const r = await CL.act(e.submitter, () => (live ? CL.post(`/savings/market/offers/${live.offer_id}/revise`, body) : CL.post(`/savings/market/listings/${l.listing_id}/offers`, body)),
          (x) => ((x.warnings || []).length ? `บันทึกแล้ว — มีแจ้งเตือนเพดาน ${x.warnings.length} รายการ` : "ยื่นข้อเสนอแล้ว"));
        if (r) renderDetail();
      };
    }
    ctx.view.onclick = async (e) => {
      if (e.target.closest("[data-back]")) { detailId = null; renderBrowse(ctx); return; }
      const doc = e.target.closest("[data-doc]");
      if (doc) { e.preventDefault(); CL.openFile(`/savings/market/listings/${l.listing_id}/documents/${doc.dataset.doc}/file`); return; }
      const b = e.target.closest("[data-a]");
      if (!b) return;
      const a = b.dataset.a;
      const oid = (b.closest("[data-o]") || {}).dataset;
      let r = null;
      if (a === "ask") r = await CL.act(b, () => CL.post(`/savings/market/listings/${l.listing_id}/questions`, { kind: document.getElementById("qKind").value, question: document.getElementById("qText").value }), "ส่งแล้ว");
      if (a === "revise") { document.getElementById("offerForm").style.display = ""; return; }
      if (a === "withdraw") { if (!window.confirm("ถอนข้อเสนอนี้?")) return; r = await CL.act(b, () => CL.post(`/savings/market/offers/${oid.o}/withdraw`), "ถอนแล้ว"); }
      if (a === "confirm") r = await CL.act(b, () => CL.post(`/savings/market/offers/${oid.o}/confirm`, { approval_ref: b.parentElement.querySelector(".ap-ref").value }), "ยืนยันแล้ว — รอผู้ขอกู้จับคู่และจัดทำสัญญา");
      if (a === "docx") { await CL.download(`/savings/market/agreements/${b.dataset.ag}/docx`, `สัญญา-${ag.agreement_no}.docx`); return; }
      if (a === "sign") {
        const f = document.getElementById("signFile").files[0];
        if (!f) { CL.toast("แนบไฟล์สัญญาที่ลงนามแล้วก่อน", true); return; }
        r = await CL.act(b, async () => CL.post(`/savings/market/agreements/${b.dataset.ag}/sign`, { file_id: await CL.upload(f) }), (x) => (x.status === "Signed" ? "ลงนามครบทุกฝ่าย — เปิดวงเงินแล้ว" : "บันทึกแล้ว — รอคู่สัญญาอื่นลงนาม"));
      }
      if (r) renderDetail();
    };
  }

  // ======================================================== ข้อเสนอของเรา
  async function renderOffers(c) {
    ctx = c;
    const rows = await CL.get("/savings/market/offers");
    ctx.view.innerHTML = `<div class="cl-card"><table class="cl-table"><tr><th>โครงการ</th><th>ผู้ขอกู้</th><th class="r">วงเงิน</th><th class="r">ดอกเบี้ย</th><th>สถานะข้อเสนอ</th><th>สัญญา</th></tr>
      ${rows.map((o) => `<tr data-open="${o.listing_id}" style="cursor:pointer"><td>${esc(o.title)}<div class="cl-muted">${esc(CL.PTYPE[o.project_type])}</div></td><td>${esc(o.borrower_name)}</td><td class="r">${baht(o.amount)}</td><td class="r">${Number(o.rate_pct)}%</td>
        <td>${pill(CL.OFFER_ST[o.status])}${o.status === "Accepted" ? '<div class="cl-late">รอผู้มีอำนาจอนุมัติยืนยัน</div>' : ""}${o.status === "Countered" ? '<div class="cl-late">ผู้ขอกู้โต้ตอบ</div>' : ""}</td>
        <td>${o.agreement_no ? `${esc(o.agreement_no)} · ${o.agreement_status === "Signed" ? "✅ ลงนามครบ" : o.i_signed ? "เราลงนามแล้ว" : '<span class="cl-late">รอเราลงนาม</span>'}` : "-"}</td></tr>`).join("") || '<tr><td colspan="6" class="cl-empty">ยังไม่มีข้อเสนอ</td></tr>'}</table></div>`;
    ctx.view.onclick = (e) => { const o = e.target.closest("[data-open]"); if (o) { detailId = o.dataset.open; ctx.gotoTab("market"); } };
  }

  // ======================================================== ข้อมูลและนโยบายสินเชื่อ
  async function renderProfile(c) {
    ctx = c;
    const d = await CL.get("/savings/market/profile");
    const p = d.profile || {};
    const pol = p.policy || {};
    const f = (p.financials || [])[0] || {};
    const thisYear = new Date().getFullYear() + 543 - 1;
    ctx.view.innerHTML = `<form id="lpForm">
      <div class="cl-card" style="background:#f4faf5">ข้อมูลนี้ใช้ (1) ให้ผู้ขอกู้ทราบนโยบายสินเชื่อของสหกรณ์ (2) แจ้งเตือนเมื่อมีโครงการตรงนโยบาย (3) เตือนเมื่อข้อเสนอเกินเงินที่จัดสรรได้หรือเกินเพดาน
        · วงเงินผูกพันปัจจุบัน ${baht(d.committed)} · ข้อเสนอที่ยังมีผล ${baht(d.offered)}</div>
      <div class="cl-card"><h3>ข้อมูลทั่วไปและฐานะการเงิน (${esc(d.org.org_type === "CreditUnion" ? "สหกรณ์เครดิตยูเนี่ยน" : "สหกรณ์ออมทรัพย์")})</h3><div class="cl-form">
        <div><label>เลขทะเบียน</label><input name="registration_no" value="${esc(n0(p.registration_no))}"></div>
        <div><label>จังหวัด</label><select name="province_code"><option value=""></option>${optList(CL.PROVINCES, p.province_code)}</select></div>
        <div><label>จำนวนสมาชิก</label><input name="member_count" type="number" value="${esc(n0(p.member_count))}"></div>
        <div class="wide"><label>ผู้มีอำนาจลงนาม</label><input name="signatories" value="${esc(n0(p.signatories))}"></div>
        <div class="wide"><label>ผู้ติดต่อ</label><input name="contact" value="${esc(n0(p.contact))}"></div>
        <div><label>ปีบัญชี</label><input name="f_year" type="number" value="${esc(f.year || thisYear)}"></div>
        ${[["total_assets", "สินทรัพย์รวม"], ["share_capital", "ทุนเรือนหุ้น"], ["deposits", "เงินรับฝาก"], ["reserve", "ทุนสำรอง"], ["loans", "เงินให้กู้"], ["investments", "เงินลงทุน"], ["net_income", "กำไรสุทธิ"]].map(([k, l]) => `<div><label>${l}</label><input name="f_${k}" type="number" value="${esc(n0(f[k]))}"></div>`).join("")}
        <div><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="f_audited" ${f.audited ? "checked" : ""} style="width:auto"> ผ่านการสอบบัญชีแล้ว</label></div></div></div>
      <div class="cl-card"><h3>สภาพคล่องและเงินทุนที่จัดสรรได้</h3><div class="cl-form">
        <div><label>วงเงินที่พร้อมให้สหกรณ์อื่นกู้ (บาท) — กำหนดโดยสหกรณ์</label><input name="allocatable_amount" type="number" value="${esc(n0(p.allocatable_amount))}"></div>
        <div class="wide"><label>เงินที่ต้องกันสำรองตามระเบียบ / ภาระผูกพัน</label><input name="liquidity_note" value="${esc(n0(p.liquidity_note))}"></div>
        <div class="wide"><label>อำนาจอนุมัติ (ข้อบังคับ ระเบียบ ลำดับขั้นการอนุมัติ)</label><input name="approval_authority" value="${esc(n0(p.approval_authority))}"></div>
        <div><label>มติที่ประชุมที่อนุญาตให้กู้แก่สหกรณ์อื่น</label><input type="file" id="resFile" accept="application/pdf,image/*">${p.resolution_file_id ? '<div class="cl-muted">✅ มีในระบบแล้ว</div>' : ""}</div></div></div>
      <div class="cl-card"><h3>นโยบายสินเชื่อ</h3><div class="cl-form">
        <div class="wide"><label>ประเภทโครงการที่สนใจ</label><div class="cl-inline">${Object.entries(CL.PTYPE).map(([k, v]) => `<label style="font-weight:400;display:inline-flex;gap:6px"><input type="checkbox" name="pt_${k}" ${(pol.project_types || []).includes(k) ? "checked" : ""} style="width:auto">${esc(v)}</label>`).join("")}</div></div>
        <div><label>วงเงินต่อรายต่ำสุด</label><input name="min_amount" type="number" value="${esc(n0(pol.min_amount))}"></div><div><label>วงเงินต่อรายสูงสุด</label><input name="max_amount" type="number" value="${esc(n0(pol.max_amount))}"></div>
        <div><label>ระยะเวลาสั้นสุด (เดือน)</label><input name="min_tenor_months" type="number" value="${esc(n0(pol.min_tenor_months))}"></div><div><label>ระยะเวลายาวสุด (เดือน)</label><input name="max_tenor_months" type="number" value="${esc(n0(pol.max_tenor_months))}"></div>
        <div><label>ดอกเบี้ยต่ำสุด (%)</label><input name="rate_min" type="number" step="0.01" value="${esc(n0(pol.rate_min))}"></div><div><label>ดอกเบี้ยสูงสุด (%)</label><input name="rate_max" type="number" step="0.01" value="${esc(n0(pol.rate_max))}"></div>
        <div><label>ระดับความเสี่ยงที่รับได้</label><select name="max_risk_grade"><option value="">ไม่จำกัด</option>${optList(["A", "B", "C", "D", "E"].map((g) => [g, `เกรด ${g} ขึ้นไป`]), pol.max_risk_grade)}</select></div>
        <div class="wide"><label>จังหวัดที่สนใจ (ไม่เลือก = ทั้งประเทศ)</label><select name="provinces" multiple size="5">${optList(CL.PROVINCES, null).replace(/<option value="([^"]+)"/g, (m, code) => ((pol.provinces || []).includes(code) ? `<option value="${code}" selected` : m))}</select></div>
        <div><label>ชนิดพืช (คั่นด้วย ,)</label><input name="commodities" value="${esc((pol.commodities || []).join(", "))}"></div>
        <div><label>หลักประกันที่ยอมรับ (คั่นด้วย ,)</label><input name="collateral" value="${esc((pol.collateral || []).join(", "))}" placeholder="ที่ดิน, เครื่องจักร, ผู้ค้ำประกัน"></div></div></div>
      <div class="cl-card"><h3>เพดานการให้กู้ (ระบบแจ้งเตือนเมื่อเกิน)</h3><div class="cl-form">
        <div><label>ต่อผู้กู้หนึ่งราย</label><input name="limit_per_borrower" type="number" value="${esc(n0(pol.limit_per_borrower))}"></div>
        <div><label>ต่อจังหวัด</label><input name="limit_per_province" type="number" value="${esc(n0(pol.limit_per_province))}"></div>
        ${Object.entries(CL.PTYPE).map(([k, v]) => `<div><label>${esc(v)}</label><input name="lt_${k}" type="number" value="${esc(n0((pol.limit_per_type || {})[k]))}"></div>`).join("")}
        <div><label>ข้อมูล ณ วันที่</label><input name="data_as_of" type="date" value="${esc(p.data_as_of ? String(p.data_as_of).slice(0, 10) : new Date().toISOString().slice(0, 10))}"></div>
        <div><button class="cl-btn" type="submit">บันทึก</button></div></div></div></form>`;
    document.getElementById("lpForm").onsubmit = async (e) => {
      e.preventDefault();
      const fm = e.target;
      const v = (k) => (fm[k] ? fm[k].value : "");
      const rf = document.getElementById("resFile").files[0];
      const body = {
        registration_no: v("registration_no"), province_code: v("province_code"), member_count: v("member_count"), signatories: v("signatories"), contact: v("contact"),
        financials: [{ year: v("f_year"), audited: fm.f_audited.checked, ...Object.fromEntries(["total_assets", "share_capital", "deposits", "reserve", "loans", "investments", "net_income"].map((k) => [k, v(`f_${k}`)])) }],
        allocatable_amount: v("allocatable_amount"), liquidity_note: v("liquidity_note"), approval_authority: v("approval_authority"), data_as_of: v("data_as_of"),
        policy: {
          project_types: Object.keys(CL.PTYPE).filter((k) => fm[`pt_${k}`].checked), min_amount: v("min_amount"), max_amount: v("max_amount"), min_tenor_months: v("min_tenor_months"), max_tenor_months: v("max_tenor_months"),
          rate_min: v("rate_min"), rate_max: v("rate_max"), max_risk_grade: v("max_risk_grade"), provinces: [...fm.provinces.selectedOptions].map((o) => o.value),
          commodities: v("commodities").split(",").map((s) => s.trim()).filter(Boolean), collateral: v("collateral").split(",").map((s) => s.trim()).filter(Boolean),
          limit_per_borrower: v("limit_per_borrower"), limit_per_province: v("limit_per_province"), limit_per_type: Object.fromEntries(Object.keys(CL.PTYPE).map((k) => [k, v(`lt_${k}`)])),
        },
      };
      const r = await CL.act(e.submitter, async () => CL.put("/savings/market/profile", { ...body, resolution_file_id: rf ? await CL.upload(rf) : undefined }), "บันทึกแล้ว");
      if (r) renderProfile(ctx);
    };
  }

  return {
    renderBrowse, renderOffers, renderProfile,
    reset() { detailId = null; },
  };
}());
