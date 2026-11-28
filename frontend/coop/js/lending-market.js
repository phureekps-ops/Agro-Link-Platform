/**
 * พอร์ทัลสหกรณ์การเกษตร — ตลาดสินเชื่อระหว่างสหกรณ์ (ผู้ขอกู้)
 * Backend: /coop-lending/market/* (backend/src/routes/coopMarket.js)
 *   ข้อมูลสหกรณ์ + คะแนนความน่าเชื่อถือ · จัดทำ/ประกาศโครงการขอกู้ 3 ประเภท · ตอบคำถาม · เปรียบเทียบ/โต้ตอบ/เลือกข้อเสนอ
 *   · จับคู่และดาวน์โหลดสัญญา (.docx) · อัปโหลดฉบับลงนาม · รายงานผลการดำเนินงาน
 *   · งวดเบิกตามกิจกรรม: ส่งปิดยอดงวด (สินค้าคงเหลือ ยอดขาย หลักฐานส่งมอบ) ให้ผู้ให้กู้หลักตรวจก่อนเปิดงวดถัดไป
 *   · สหกรณ์โคนม: ข้อมูลรับน้ำนมจริงจากระบบบริหารโคนมแห่งชาติใช้เป็นหลักฐานกิจกรรม (ผู้ให้กู้เห็นเมื่อให้ความยินยอม)
 */
/* global CL */
window.CoopMarket = (function () {
  const { esc, baht, date, dt, pill, num } = CL;
  let state = { mode: "list", id: null, editing: null };
  let ctx = null; // { view, refresh, accounts, orgId, gotoTab }

  const n0 = (v) => (v == null || v === "" ? "" : v);
  const optList = (pairs, sel) => pairs.map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(v)}</option>`).join("");
  const STEPS = ["Draft", "Review", "Listed", "Offered", "Matched", "Signed", "Closed"];
  function timeline(st) {
    const idx = STEPS.indexOf(st === "Returned" ? "Draft" : st === "Active" ? "Signed" : st);
    return `<div class="cl-track">${STEPS.map((s, i) => `<div class="${i < idx ? "Passed" : i === idx ? "Open" : "Locked"}"><b>${i + 1}</b>${esc(CL.LISTING_ST[s][0])}</div>`).join("")}</div>`;
  }

  // ======================================================== ข้อมูลสหกรณ์ (ฐานข้อมูลผู้ขอกู้)
  async function renderProfile(c) {
    ctx = c;
    const d = await CL.get("/coop-lending/market/profile");
    const p = d.profile || {};
    const fin = [...(p.financials || [])].sort((a, b) => b.year - a.year);
    const thisYear = new Date().getFullYear() + 543;
    const years = [0, 1, 2].map((i) => fin[i] || { year: thisYear - 2 - i });
    const F = [["total_assets", "สินทรัพย์รวม"], ["total_liabilities", "หนี้สินรวม"], ["equity", "ทุนของสหกรณ์"], ["share_capital", "ทุนเรือนหุ้น"], ["reserve", "ทุนสำรอง"],
      ["current_assets", "สินทรัพย์หมุนเวียน"], ["current_liabilities", "หนี้สินหมุนเวียน"], ["revenue", "รายได้รวม"], ["net_income", "กำไร(ขาดทุน)สุทธิ"]];
    const BUS = [["credit", "ธุรกิจสินเชื่อ"], ["supply", "ธุรกิจจัดหาสินค้า"], ["collection", "ธุรกิจรวบรวมผลผลิต"], ["processing", "ธุรกิจแปรรูป"], ["service", "ธุรกิจบริการ"]];
    const bus = p.businesses || {};
    const g = p.governance || {};
    ctx.view.innerHTML = `
      <div class="cl-card" id="riskAll"></div>
      <div class="cl-card" style="background:#f4faf5">ข้อมูลนี้ผู้ให้กู้ใช้ประกอบการพิจารณาทุกโครงการที่ท่านประกาศ (ฐานข้อมูลผู้ขอกู้) — ควรปรับปรุงอย่างน้อยทุกปีบัญชี และทุกครั้งก่อนประกาศโครงการใหม่
        · ทะเบียนจากกรมส่งเสริมสหกรณ์: ${d.registry ? `${esc(d.registry.province_name_th || d.registry.province_code || "")} ${d.registry.cooperative_registration_no ? `เลขทะเบียน ${esc(d.registry.cooperative_registration_no)}` : ""}` : "ยังไม่มี"}
        · สมาชิกในระบบ ${d.platform.members_on_platform} ราย ${d.platform.plots} แปลง ${num(d.platform.area_rai, 0)} ไร่</div>
      <div class="cl-card">${CL.scorePanel(d.score)}</div>
      ${d.dairy ? `<div class="cl-card">${CL.dairyPanel(d.dairy)}<div class="cl-muted">ผู้ให้กู้เห็นข้อมูลชุดนี้ประกอบโครงการเมื่อท่านให้ความยินยอมเปิดเผยข้อมูลด้านล่าง</div></div>` : ""}
      <form id="bpForm">
      <div class="cl-card"><h3>ข้อมูลทั่วไป</h3><div class="cl-form">
        <div><label>ประเภท</label><select name="coop_kind">${optList([["agriculture", "สหกรณ์การเกษตร"], ["dairy", "สหกรณ์โคนม"], ["settlement", "สหกรณ์นิคม"], ["fisheries", "สหกรณ์ประมง"], ["other", "สหกรณ์ประเภทอื่น"]], p.coop_kind)}</select></div>
        <div><label>เลขทะเบียนสหกรณ์</label><input name="registration_no" value="${esc(n0(p.registration_no))}"></div>
        <div><label>ปีที่จัดตั้ง (พ.ศ.)</label><input name="established_year" type="number" value="${esc(n0(p.established_year))}"></div>
        <div><label>จำนวนสมาชิก</label><input name="member_count" type="number" value="${esc(n0(p.member_count))}"></div>
        <div class="wide"><label>คณะกรรมการและผู้จัดการ</label><input name="board" value="${esc(n0(p.board))}"></div>
        <div class="wide"><label>ผู้มีอำนาจลงนาม (ชื่อ ตำแหน่ง)</label><input name="signatories" value="${esc(n0(p.signatories))}"></div>
        <div><label>วงเงินกู้ยืมที่ที่ประชุมใหญ่อนุมัติ (มาตรา 47)</label><input name="max_borrowing" type="number" value="${esc(n0(p.max_borrowing))}" placeholder="บาท"></div>
        <div><label>อ้างอิงมติ</label><input name="max_borrowing_ref" value="${esc(n0(p.max_borrowing_ref))}" placeholder="เช่น ประชุมใหญ่สามัญ 1/2569"></div>
        <div class="wide cl-muted">หนี้เดิมที่กรอกด้านล่าง + วงเงินบน AgroLink ที่ยังไม่ปิด (${baht(d.platform_debt || 0)}) + วงเงินที่ขอใหม่ ต้องไม่เกินวงเงินนี้</div>
        <div><label>ข้อมูล ณ วันที่</label><input name="data_as_of" type="date" value="${esc(p.data_as_of ? String(p.data_as_of).slice(0, 10) : new Date().toISOString().slice(0, 10))}"></div></div></div>
      <div class="cl-card"><h3>งบการเงินย้อนหลัง 3 ปี (บาท)</h3><div style="overflow-x:auto"><table class="cl-table cl-inline"><tr><th>รายการ</th>${years.map((y, i) => `<th><input name="fy${i}" type="number" value="${y.year}" style="width:90px"> </th>`).join("")}</tr>
        ${F.map(([k, l]) => `<tr><td>${l}</td>${years.map((y, i) => `<td><input name="f${i}_${k}" type="number" step="0.01" value="${esc(n0(y[k]))}" style="width:150px"></td>`).join("")}</tr>`).join("")}
        <tr><td>ความเห็นผู้สอบบัญชี</td>${years.map((y, i) => `<td><select name="f${i}_audit_opinion"><option value="">—</option>${optList([["unqualified", "ไม่มีเงื่อนไข"], ["qualified", "มีเงื่อนไข"], ["adverse", "ไม่ถูกต้อง"], ["disclaimer", "ไม่แสดงความเห็น"]], y.audit_opinion)}</select></td>`).join("")}</tr></table></div></div>
      <div class="cl-card"><h3>ธุรกิจของสหกรณ์ (ปีล่าสุด)</h3><table class="cl-table cl-inline"><tr><th>ธุรกิจ</th><th>ปริมาณ</th><th>มูลค่า (บาท)</th></tr>
        ${BUS.map(([k, l]) => `<tr><td>${l}</td><td><input name="b_${k}_volume" value="${esc(n0((bus[k] || {}).volume))}" placeholder="เช่น ข้าวเปลือก 3,000 ตัน"></td><td><input name="b_${k}_value" type="number" value="${esc(n0((bus[k] || {}).value))}"></td></tr>`).join("")}</table></div>
      <div class="cl-card"><h3>หนี้สินและประวัติการชำระ</h3><div id="debtRows"></div><button type="button" class="cl-btn ghost" data-add="debt">+ เพิ่มเจ้าหนี้</button></div>
      <div class="cl-card"><h3>ทรัพย์สินและหลักประกัน</h3><div id="assetRows"></div><button type="button" class="cl-btn ghost" data-add="asset">+ เพิ่มทรัพย์สิน</button></div>
      <div class="cl-card"><h3>ผลการกำกับดูแล</h3><div class="cl-form">
        <div><label>ผลการจัดระดับมาตรฐานสหกรณ์</label><select name="standard_grade"><option value="">—</option>${optList([["excellent", "ดีเลิศ"], ["very_good", "ดีมาก"], ["good", "ดี"], ["pass", "ผ่านมาตรฐาน"], ["fail", "ไม่ผ่านมาตรฐาน"]], g.standard_grade)}</select></div>
        <div class="wide"><label>ข้อสังเกตจากการตรวจการ/ผู้สอบบัญชี</label><input name="audit_findings" value="${esc(n0(g.audit_findings))}"></div>
        <div class="wide"><label>ข้อบกพร่องที่ยังไม่ได้แก้ไข (ถ้ามี)</label><input name="unresolved_issues" value="${esc(n0(g.unresolved_issues))}"></div></div></div>
      <div class="cl-card"><label style="display:flex;gap:8px;align-items:flex-start;font-size:14px"><input type="checkbox" name="consent_disclose" ${p.consent_disclose ? "checked" : ""} style="width:auto;margin-top:4px">
        สหกรณ์ยินยอมเปิดเผยข้อมูลในหน้านี้แก่สหกรณ์ผู้ให้กู้ที่ลงทะเบียนในระบบ เพื่อประกอบการพิจารณาโครงการขอกู้ของสหกรณ์ (ตามกฎหมายคุ้มครองข้อมูลส่วนบุคคล — ไม่เปิดเผยข้อมูลรายบุคคลของสมาชิก)</label>
        <div class="cl-actions"><button class="cl-btn" type="submit">บันทึกและคำนวณคะแนน</button></div></div></form>
      <div class="cl-card" id="rpBox"></div>`;
    const rows = { debt: p.debts || [], asset: p.assets || [] };
    const draw = () => {
      document.getElementById("debtRows").innerHTML = rows.debt.map((x, i) => `<div class="cl-inline" style="margin-bottom:6px" data-row="debt" data-i="${i}"><input class="r-creditor" placeholder="เจ้าหนี้ เช่น กองทุนพัฒนาสหกรณ์ ธ.ก.ส." value="${esc(n0(x.creditor))}" style="min-width:260px">
        <input class="r-out" type="number" placeholder="ยอดคงค้าง" value="${esc(n0(x.outstanding))}"><select class="r-st">${optList([["current", "ชำระปกติ"], ["late", "ค้างชำระ"], ["restructured", "ปรับโครงสร้างหนี้"], ["default", "ผิดนัด"]], x.status)}</select>
        <button type="button" class="cl-btn bad" data-del="debt">ลบ</button></div>`).join("") || '<div class="cl-muted">ไม่มีหนี้เดิม</div>';
      document.getElementById("assetRows").innerHTML = rows.asset.map((x, i) => `<div class="cl-inline" style="margin-bottom:6px" data-row="asset" data-i="${i}"><input class="r-kind" placeholder="ประเภท เช่น ที่ดิน โกดัง ลานตาก" value="${esc(n0(x.kind))}">
        <input class="r-desc" placeholder="รายละเอียด" value="${esc(n0(x.description))}" style="min-width:240px"><input class="r-val" type="number" placeholder="มูลค่า" value="${esc(n0(x.value))}">
        <label style="font-size:13px"><input type="checkbox" class="r-pl" ${x.pledged ? "checked" : ""} style="width:auto"> ติดภาระแล้ว</label><button type="button" class="cl-btn bad" data-del="asset">ลบ</button></div>`).join("") || '<div class="cl-muted">ยังไม่มี</div>';
    };
    const collect = () => {
      document.querySelectorAll('[data-row="debt"]').forEach((r) => { rows.debt[r.dataset.i] = { creditor: r.querySelector(".r-creditor").value, outstanding: r.querySelector(".r-out").value, status: r.querySelector(".r-st").value }; });
      document.querySelectorAll('[data-row="asset"]').forEach((r) => { rows.asset[r.dataset.i] = { kind: r.querySelector(".r-kind").value, description: r.querySelector(".r-desc").value, value: r.querySelector(".r-val").value, pledged: r.querySelector(".r-pl").checked }; });
    };
    draw();
    ctx.view.onclick = (e) => {
      const a = e.target.closest("[data-add]"); const dl = e.target.closest("[data-del]");
      if (a) { collect(); rows[a.dataset.add].push({}); draw(); }
      if (dl) { collect(); rows[dl.dataset.del].splice(Number(dl.closest("[data-i]").dataset.i), 1); draw(); }
    };
    document.getElementById("bpForm").onsubmit = async (e) => {
      e.preventDefault();
      collect();
      const f = e.target;
      const v = (k) => (f[k] ? f[k].value : "");
      const body = {
        coop_kind: v("coop_kind"), max_borrowing: v("max_borrowing"), max_borrowing_ref: v("max_borrowing_ref"), registration_no: v("registration_no"), established_year: v("established_year"), member_count: v("member_count"), board: v("board"), signatories: v("signatories"), data_as_of: v("data_as_of"),
        financials: [0, 1, 2].map((i) => ({ year: v(`fy${i}`), ...Object.fromEntries([...F.map(([k]) => k), "audit_opinion"].map((k) => [k, v(`f${i}_${k}`)])) })).filter((x) => F.some(([k]) => x[k] !== "")),
        businesses: Object.fromEntries(BUS.map(([k]) => [k, { volume: v(`b_${k}_volume`), value: v(`b_${k}_value`) }])),
        debts: rows.debt.filter((x) => x.creditor), assets: rows.asset.filter((x) => x.kind),
        governance: { standard_grade: v("standard_grade"), audit_findings: v("audit_findings"), unresolved_issues: v("unresolved_issues") }, consent_disclose: f.consent_disclose.checked,
      };
      const r = await CL.act(e.submitter, () => CL.put("/coop-lending/market/profile", body), (x) => `บันทึกแล้ว — คะแนน ${x.score.score} เกรด ${x.score.grade}`);
      if (r) renderProfile(ctx);
    };
    riskBox(document.getElementById("riskAll"), null);
    relatedParties(document.getElementById("rpBox"));
  }

  // ======================================================== เตือนภัยล่วงหน้า / สัญญาณที่ต้องตรวจสอบ (ผู้กู้ชี้แจงได้)
  async function riskBox(box, listingId) {
    if (!box) return;
    let list;
    try { list = await CL.get(`/coop-lending/market/risk${listingId ? `?listing_id=${listingId}` : ""}`); } catch (err) { box.remove(); return; }
    if (!list.length) { box.remove(); return; }
    box.innerHTML = CL.alertsPanel(list, {
      title: listingId ? "เตือนภัยล่วงหน้าของโครงการนี้" : "เตือนภัยล่วงหน้าและเรื่องที่ขอให้ชี้แจง",
      actions: (a) => (["Open", "Investigating"].includes(a.status) ? `<div class="cl-inline" style="margin-top:6px"><input class="rx-note" placeholder="ชี้แจงข้อเท็จจริง/แนวทางแก้ไข" style="min-width:320px" value="">
        <button class="cl-btn" data-rx="1">${a.borrower_note ? "ชี้แจงเพิ่ม" : "ส่งคำชี้แจง"}</button></div>` : ""),
    });
    box.onclick = async (e) => {
      const b = e.target.closest("[data-rx]");
      if (!b) return;
      e.stopPropagation();
      const card = b.closest("[data-alert]");
      if (await CL.act(b, () => CL.post(`/coop-lending/market/risk/${card.dataset.alert}/explain`, { note: card.querySelector(".rx-note").value }), "ส่งคำชี้แจงแล้ว — แจ้งผู้ให้กู้และผู้ดูแลแพลตฟอร์ม")) riskBox(box, listingId);
    };
  }
  /** ผู้มีผลประโยชน์ร่วม: กรรมการ/ผู้จัดการ และกิจการที่เกี่ยวข้อง — ใช้ตรวจการซื้อขายกับผู้เกี่ยวข้อง */
  async function relatedParties(box) {
    if (!box) return;
    let rows;
    try { rows = await CL.get("/coop-lending/market/related-parties"); } catch (err) { box.remove(); return; }
    const draw = () => {
      box.innerHTML = `<h3>ผู้มีผลประโยชน์ร่วม</h3><div class="cl-muted">แจ้งกรรมการ ผู้จัดการ และกิจการที่บุคคลเหล่านี้เป็นเจ้าของ/หุ้นส่วน — ระบบจะเตือนผู้ให้กู้เมื่อมีการซื้อขายกับผู้เกี่ยวข้อง เพื่อให้ตรวจว่าผ่านการอนุมัติและราคาเป็นธรรม (ไม่ได้ห้ามซื้อขาย)</div>
        ${rows.map((x, i) => `<div class="cl-inline" style="margin-top:6px" data-rp="${i}"><input class="p-name" placeholder="ชื่อ-สกุล" value="${esc(n0(x.person_name))}"><input class="p-role" placeholder="ตำแหน่ง" value="${esc(n0(x.role))}">
          <input class="p-org" placeholder="กิจการที่เกี่ยวข้อง (ชื่อร้าน/บริษัท)" value="${esc(n0(x.related_name))}" style="min-width:220px"><input class="p-tax" placeholder="เลขผู้เสียภาษี 13 หลัก" value="${esc(n0(x.related_tax_id))}">
          <button type="button" class="cl-btn bad" data-rpdel="${i}">ลบ</button></div>`).join("") || '<div class="cl-muted" style="margin-top:6px">ยังไม่ได้แจ้ง</div>'}
        <div class="cl-actions"><button type="button" class="cl-btn ghost" data-rpadd="1">+ เพิ่มรายชื่อ</button><button type="button" class="cl-btn" data-rpsave="1">บันทึกรายชื่อ</button></div>`;
    };
    const collect = () => { rows = [...box.querySelectorAll("[data-rp]")].map((r) => ({ person_name: r.querySelector(".p-name").value.trim(), role: r.querySelector(".p-role").value.trim() || null, related_name: r.querySelector(".p-org").value.trim() || null, related_tax_id: r.querySelector(".p-tax").value.trim() || null })); };
    draw();
    box.onclick = async (e) => {
      e.stopPropagation();
      if (e.target.closest("[data-rpadd]")) { collect(); rows.push({}); draw(); return; }
      const d = e.target.closest("[data-rpdel]");
      if (d) { collect(); rows.splice(Number(d.dataset.rpdel), 1); draw(); return; }
      const sv = e.target.closest("[data-rpsave]");
      if (sv) {
        collect();
        const r = await CL.act(sv, () => CL.put("/coop-lending/market/related-parties", { parties: rows.filter((x) => x.person_name) }), (x) => `บันทึกแล้ว ${x.length} รายชื่อ`);
        if (r) { rows = r; draw(); }
      }
    };
  }

  // ======================================================== โครงการขอกู้
  async function renderMarket(c) {
    ctx = c;
    if (state.mode === "detail" && state.id) return renderDetail();
    if (state.mode === "form") return renderForm(state.editing);
    const [list, prof] = await Promise.all([CL.get("/coop-lending/market/listings"), CL.get("/coop-lending/market/profile")]);
    ctx.view.innerHTML = `
      <div class="cl-card" style="background:#f4faf5"><b>ตลาดสินเชื่อระหว่างสหกรณ์:</b> สหกรณ์จัดทำโครงการขอกู้พร้อมข้อมูลประกอบ → ผู้ดูแลตรวจความครบถ้วน → ประกาศให้สหกรณ์ออมทรัพย์และสหกรณ์เครดิตยูเนี่ยนเห็น
        → ผู้ให้กู้ถาม–ตอบและยื่นข้อเสนอ (หลายรายร่วมกันได้) → ท่านเปรียบเทียบ โต้ตอบ และเลือก → ระบบจัดทำสัญญา → ลงนาม → เบิกจ่ายตามกิจกรรมจริง จ่ายตรงถึงผู้ขาย</div>
      <div class="cl-card"><div class="cl-row"><div>${CL.gradeBadge(prof.score.grade, prof.score.score)} <span class="cl-muted">ความครบถ้วนข้อมูลสหกรณ์ ${prof.score.completeness_pct}%${prof.profile && prof.profile.consent_disclose ? "" : " · ยังไม่ได้ให้ความยินยอมเปิดเผยข้อมูล"}</span></div>
        <div class="cl-inline"><button class="cl-btn ghost" data-m="profile">🏢 ปรับปรุงข้อมูลสหกรณ์</button><button class="cl-btn" data-m="new">+ จัดทำโครงการขอกู้</button></div></div></div>
      ${list.map((l) => `<div class="cl-card" data-open="${l.listing_id}" style="cursor:pointer">
        <div class="cl-row"><div><b>${esc(l.title)}</b> · ${esc(CL.PTYPE[l.project_type])}</div><div>${pill(CL.LISTING_ST[l.status])}</div></div>
        <div class="cl-line">ขอกู้ ${baht(l.amount_requested)}${l.min_amount ? ` (รับขั้นต่ำ ${baht(l.min_amount)})` : ""} · ${l.tenor_months} เดือน${l.listed_at ? ` · ประกาศ ${esc(date(l.listed_at))} รับข้อเสนอถึง ${esc(date(l.offers_close_on))}` : ""}
          · ข้อเสนอ ${l.live_offers} ราย${Number(l.confirmed_amount) ? ` · ยืนยันแล้ว ${baht(l.confirmed_amount)}` : ""}${l.open_questions ? ` · <span class="cl-late">คำถามรอตอบ ${l.open_questions}</span>` : ""}</div>
        ${l.review_note && l.status === "Returned" ? `<div class="cl-flag">ผู้ดูแลส่งกลับ: ${esc(l.review_note)}</div>` : ""}</div>`).join("") || '<div class="cl-empty">ยังไม่มีโครงการขอกู้</div>'}`;
    ctx.view.onclick = (e) => {
      const m = e.target.closest("[data-m]");
      if (m && m.dataset.m === "new") { state = { mode: "form", editing: null }; renderMarket(ctx); return; }
      if (m && m.dataset.m === "profile") { ctx.gotoTab("profile"); return; }
      const o = e.target.closest("[data-open]");
      if (o) { state = { mode: "detail", id: o.dataset.open }; renderMarket(ctx); }
    };
  }

  function renderForm(l) {
    const x = l || { project_type: "member_onlending", use_plan: [{}], collateral: [], details: {}, commodities: [] };
    const d = x.details || {};
    const plan = (x.use_plan || []).length ? x.use_plan : [{}];
    const col = x.collateral || [];
    const proj = (d.projections || []).length ? d.projections : [{ year: "ปีที่ 1" }, { year: "ปีที่ 2" }, { year: "ปีที่ 3" }];
    ctx.view.innerHTML = `<div class="cl-card"><div class="cl-row"><h3>${l ? "แก้ไขโครงการขอกู้" : "จัดทำโครงการขอกู้"}</h3><button class="cl-btn ghost" data-back="1">← กลับ</button></div>
      <form id="lf" class="cl-form">
        <div class="wide"><label>ประเภทโครงการ</label><div class="cl-inline">${Object.entries(CL.PTYPE).map(([k, v]) => `<label style="display:inline-flex;gap:6px;font-weight:400;border:1px solid #d7ddd8;border-radius:9px;padding:6px 10px"><input type="radio" name="project_type" value="${k}" ${k === x.project_type ? "checked" : ""} style="width:auto">${esc(v)}</label>`).join("")}</div></div>
        <div class="wide"><label>ชื่อโครงการ</label><input name="title" required value="${esc(n0(x.title))}" placeholder="เช่น สินเชื่อปัจจัยการผลิตข้าวนาปี 2570 สำหรับสมาชิก 120 ราย"></div>
        <div class="wide"><label>วัตถุประสงค์</label><textarea name="objective" rows="2">${esc(n0(x.objective))}</textarea></div>
        <div><label>วงเงินที่ขอ (บาท)</label><input name="amount_requested" type="number" min="10000" required value="${esc(n0(x.amount_requested))}"></div>
        <div><label>รับข้อเสนอบางส่วนขั้นต่ำ (บาท)</label><input name="min_amount" type="number" value="${esc(n0(x.min_amount))}" placeholder="ไม่ระบุ = ต้องเต็มวงเงิน"></div>
        <div><label>ระยะเวลา (เดือน)</label><input name="tenor_months" type="number" min="1" max="180" required value="${esc(n0(x.tenor_months) || 12)}"></div>
        <div><label>ปลอดชำระเงินต้น (เดือน)</label><input name="grace_months" type="number" min="0" value="${esc(n0(x.grace_months) || 0)}"></div>
        <div><label>จังหวัด</label><select name="province_code"><option value="">ตามทะเบียนสหกรณ์</option>${optList(CL.PROVINCES, x.province_code)}</select></div>
        <div><label>ชนิดพืช/ผลผลิต (คั่นด้วย ,)</label><input name="commodities" value="${esc((x.commodities || []).join(", "))}" placeholder="RICE_JASMINE, CASSAVA"></div>
        <div class="wide"><label>แผนการใช้เงิน</label><div id="planRows"></div><button type="button" class="cl-btn ghost" data-addr="plan">+ เพิ่มรายการ</button></div>
        <div class="wide"><label>แผนชำระคืน</label><textarea name="repayment_plan" rows="2">${esc(n0(x.repayment_plan))}</textarea></div>
        <div class="wide"><label>แหล่งเงินชำระคืน</label><input name="repayment_source" value="${esc(n0(x.repayment_source))}"></div>
        <div class="wide"><label>หลักประกันที่เสนอ</label><div id="colRows"></div><button type="button" class="cl-btn ghost" data-addr="col">+ เพิ่มหลักประกัน</button></div>
        <div class="wide" id="typeBox"></div>
        <div class="wide cl-actions"><button class="cl-btn" type="submit">บันทึกร่าง</button><span class="cl-muted">บันทึกแล้วแนบเอกสาร รับรองความถูกต้อง และส่งตรวจได้ที่หน้ารายละเอียดโครงการ</span></div>
      </form></div>`;
    const rows = { plan: plan.map((u) => ({ ...u })), col: col.map((u) => ({ ...u })), proj: proj.map((u) => ({ ...u })) };
    const draw = () => {
      document.getElementById("planRows").innerHTML = rows.plan.map((u, i) => `<div class="cl-inline" data-r="plan" data-i="${i}" style="margin-bottom:6px"><input class="u-item" placeholder="รายการ" value="${esc(n0(u.item))}" style="min-width:260px"><input class="u-amt" type="number" placeholder="จำนวนเงิน" value="${esc(n0(u.amount))}"><input class="u-time" placeholder="ช่วงเวลา" value="${esc(n0(u.timing))}"><button type="button" class="cl-btn bad" data-delr="plan">ลบ</button></div>`).join("")
        + `<div class="cl-muted" id="planSum"></div>`;
      document.getElementById("colRows").innerHTML = rows.col.map((u, i) => `<div class="cl-inline" data-r="col" data-i="${i}" style="margin-bottom:6px"><input class="c-kind" placeholder="ประเภท เช่น ที่ดิน" value="${esc(n0(u.kind))}"><input class="c-desc" placeholder="รายละเอียด" value="${esc(n0(u.description))}" style="min-width:260px"><input class="c-val" type="number" placeholder="มูลค่าประเมิน" value="${esc(n0(u.value))}"><button type="button" class="cl-btn bad" data-delr="col">ลบ</button></div>`).join("") || '<div class="cl-muted">ไม่มี</div>';
      const t = document.querySelector('[name="project_type"]:checked').value;
      const tb = document.getElementById("typeBox");
      if (t === "member_onlending") {
        tb.innerHTML = `<div class="cl-form"><div><label>จำนวนสมาชิกผู้กู้</label><input name="d_members_count" type="number" value="${esc(n0(d.members_count))}"></div>
          <div><label>วงเงินต่อราย (บาท)</label><input name="d_per_member_limit" type="number" value="${esc(n0(d.per_member_limit))}"></div>
          <div><label>ผลชำระหนี้สมาชิกย้อนหลัง (%)</label><input name="d_member_repayment_pct" type="number" step="0.1" value="${esc(n0(d.member_repayment_pct))}"></div>
          <div><label>จำนวนแปลง / พื้นที่ (ไร่)</label><div class="cl-inline"><input name="d_plots_count" type="number" value="${esc(n0(d.plots_count))}" style="min-width:80px"><input name="d_area_rai" type="number" value="${esc(n0(d.area_rai))}" style="min-width:80px"></div></div>
          <div class="wide"><label>แผนการผลิต</label><textarea name="d_production_plan" rows="2">${esc(n0(d.production_plan))}</textarea></div></div>
          <div class="cl-muted">เบิกจ่ายเป็นงวดตามกิจกรรมจริงในแปลง (แผนสินเชื่อการผลิตรายแปลง) จ่ายตรงร้านค้าและผู้ให้บริการ — แนบรายชื่อสมาชิกและข้อมูลแปลงเป็นเอกสารได้</div>`;
      } else if (t === "procurement") {
        tb.innerHTML = `<div class="cl-form"><div><label>ชนิดผลผลิต</label><input name="d_commodity" value="${esc(n0(d.commodity))}" placeholder="ข้าวเปลือก / มันสำปะหลัง"></div>
          <div><label>ปริมาณรับซื้อ (ตัน)</label><input name="d_volume_t" type="number" value="${esc(n0(d.volume_t))}"></div>
          <div><label>ช่วงรับซื้อ ตั้งแต่</label><input name="d_period_from" type="date" value="${esc(n0(d.period_from))}"></div><div><label>ถึง</label><input name="d_period_to" type="date" value="${esc(n0(d.period_to))}"></div>
          <div><label>ราคาอ้างอิง (บาท/กก.)</label><input name="d_reference_price" type="number" step="0.01" value="${esc(n0(d.reference_price))}"></div>
          <div class="wide"><label>ผู้ซื้อปลายทาง</label><input name="d_end_buyers" value="${esc(n0(d.end_buyers))}"></div>
          <div class="wide"><label>ประวัติธุรกิจรวบรวมผลผลิต</label><textarea name="d_history" rows="2">${esc(n0(d.history))}</textarea></div></div>
          <div class="cl-muted">ทุกรายการรับซื้อต้องมีใบชั่ง ใบตรวจคุณภาพ และใบรับซื้อ ระบบเทียบราคากับราคาอ้างอิง และโอนตรงเข้าบัญชีผู้ขาย</div>`;
      } else {
        tb.innerHTML = `<div class="cl-form"><div class="wide"><label>แผนธุรกิจ (สรุป)</label><textarea name="d_business_plan" rows="3">${esc(n0(d.business_plan))}</textarea></div>
          <div><label>ผู้ขาย/ผู้รับจ้าง</label><input name="d_vendor" value="${esc(n0(d.vendor))}"></div><div><label>ยอดตามใบเสนอราคา</label><input name="d_quotation_total" type="number" value="${esc(n0(d.quotation_total))}"></div>
          <div><label>ระยะเวลาคืนทุน (ปี)</label><input name="d_payback_years" type="number" step="0.1" value="${esc(n0(d.payback_years))}"></div>
          <div class="wide"><label>ประมาณการรายได้และกระแสเงินสด</label>${rows.proj.map((p, i) => `<div class="cl-inline" data-r="proj" data-i="${i}" style="margin-bottom:6px"><input class="p-year" value="${esc(n0(p.year))}" style="min-width:90px"><input class="p-rev" type="number" placeholder="รายได้" value="${esc(n0(p.revenue))}"><input class="p-cost" type="number" placeholder="ค่าใช้จ่าย" value="${esc(n0(p.cost))}"><input class="p-net" type="number" placeholder="กระแสเงินสดสุทธิ" value="${esc(n0(p.net_cash))}"></div>`).join("")}</div></div>
          <div class="cl-muted">จ่ายตรงผู้ขาย/ผู้รับจ้างตามงวดงานที่ตรวจรับแล้ว — แผนการใช้เงินด้านบนใช้เป็นงวดงาน และต้องแนบใบเสนอราคา</div>`;
      }
      const sum = rows.plan.reduce((a, u) => a + (Number(u.amount) || 0), 0);
      document.getElementById("planSum").textContent = `รวม ${num(sum)} บาท`;
    };
    const collect = () => {
      document.querySelectorAll('[data-r="plan"]').forEach((r) => { rows.plan[r.dataset.i] = { item: r.querySelector(".u-item").value, amount: r.querySelector(".u-amt").value, timing: r.querySelector(".u-time").value }; });
      document.querySelectorAll('[data-r="col"]').forEach((r) => { rows.col[r.dataset.i] = { kind: r.querySelector(".c-kind").value, description: r.querySelector(".c-desc").value, value: r.querySelector(".c-val").value }; });
      document.querySelectorAll('[data-r="proj"]').forEach((r) => { rows.proj[r.dataset.i] = { year: r.querySelector(".p-year").value, revenue: r.querySelector(".p-rev").value, cost: r.querySelector(".p-cost").value, net_cash: r.querySelector(".p-net").value }; });
    };
    draw();
    const form = document.getElementById("lf");
    form.addEventListener("change", (e) => { if (e.target.name === "project_type") { collect(); draw(); } });
    form.addEventListener("input", (e) => { if (e.target.classList.contains("u-amt")) { collect(); document.getElementById("planSum").textContent = `รวม ${num(rows.plan.reduce((a, u) => a + (Number(u.amount) || 0), 0))} บาท`; } });
    ctx.view.onclick = (e) => {
      if (e.target.closest("[data-back]")) { state = l ? { mode: "detail", id: l.listing_id } : { mode: "list" }; renderMarket(ctx); return; }
      const a = e.target.closest("[data-addr]"); const dl = e.target.closest("[data-delr]");
      if (a) { collect(); rows[a.dataset.addr].push({}); draw(); }
      if (dl) { collect(); rows[dl.dataset.delr].splice(Number(dl.closest("[data-i]").dataset.i), 1); draw(); }
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      collect();
      const fd = CL.formData(form);
      const details = {};
      Object.keys(fd).filter((k) => k.startsWith("d_")).forEach((k) => { if (fd[k] !== "") details[k.slice(2)] = fd[k]; });
      if (fd.project_type === "investment") details.projections = rows.proj.filter((p) => p.year && (p.revenue || p.net_cash));
      const body = {
        project_type: fd.project_type, title: fd.title, objective: fd.objective, amount_requested: fd.amount_requested, min_amount: fd.min_amount || null, tenor_months: fd.tenor_months,
        grace_months: fd.grace_months || 0, province_code: fd.province_code || undefined, commodities: (fd.commodities || "").split(",").map((s) => s.trim()).filter(Boolean),
        use_plan: rows.plan.filter((u) => u.item), repayment_plan: fd.repayment_plan, repayment_source: fd.repayment_source, collateral: rows.col.filter((u) => u.kind), details,
      };
      const r = await CL.act(e.submitter, () => (l ? CL.patch(`/coop-lending/market/listings/${l.listing_id}`, body) : CL.post("/coop-lending/market/listings", body)), "บันทึกร่างแล้ว");
      if (r) { state = { mode: "detail", id: r.listing_id }; renderMarket(ctx); }
    };
  }

  async function renderDetail() {
    const d = await CL.get(`/coop-lending/market/listings/${state.id}`);
    const l = d.listing;
    const editable = ["Draft", "Returned"].includes(l.status);
    const open = ["Listed", "Offered"].includes(l.status);
    const confirmed = d.offers.filter((o) => o.status === "Confirmed");
    const confSum = confirmed.reduce((a, o) => a + Number(o.amount), 0);
    const ag = d.agreement;
    const myAccounts = ctx.accounts.filter((a) => a.owner_type === "organization" && a.purpose === "loan_dedicated" && a.verification_status === "Verified");
    const DK = { resolution: "มติที่ประชุม", financial_statement: "งบการเงิน", business_plan: "แผนธุรกิจ", quotation: "ใบเสนอราคา", member_list: "รายชื่อสมาชิกผู้กู้", production_plan: "แผนการผลิต", buyer_contract: "สัญญาผู้ซื้อปลายทาง", collateral: "เอกสารหลักประกัน", other: "อื่น ๆ" };
    ctx.view.innerHTML = `
      <div class="cl-card"><div class="cl-row"><div><button class="cl-btn ghost" data-back="1">← โครงการทั้งหมด</button></div><div>${pill(CL.LISTING_ST[l.status])}</div></div>
        <h3 style="margin-top:10px">${esc(l.title)}</h3>
        <div class="cl-line">${esc(CL.PTYPE[l.project_type])} · ขอกู้ ${baht(l.amount_requested)}${l.min_amount ? ` (รับขั้นต่ำ ${baht(l.min_amount)})` : ""} · ${l.tenor_months} เดือน${l.grace_months ? ` ปลอดเงินต้น ${l.grace_months} เดือน` : ""}${l.offers_close_on ? ` · รับข้อเสนอถึง ${esc(date(l.offers_close_on))}` : ""}</div>
        ${timeline(l.status)}
        ${l.status === "Returned" && l.review_note ? `<div class="cl-flag">ผู้ดูแลส่งกลับ: ${esc(l.review_note)}</div>` : ""}</div>

      ${editable ? `<div class="cl-card"><h3>ก่อนส่งตรวจ</h3>
        ${d.checks.ok ? '<div class="cl-line">✅ ข้อมูลครบถ้วน</div>' : `<div class="cl-ev">${d.checks.missing.map((m) => `<span class="miss">ยังขาด: ${esc(m.label)}</span>`).join("")}</div>`}
        <div class="cl-actions"><button class="cl-btn ghost" data-a="edit">แก้ไขรายละเอียด</button>${l.certified_at ? '<span class="cl-muted">✅ รับรองความถูกต้องแล้ว</span>' : '<button class="cl-btn ghost" data-a="certify">รับรองว่าข้อมูลถูกต้องตามความเป็นจริง</button>'}
          <button class="cl-btn" data-a="submit">ส่งให้ผู้ดูแลตรวจ</button><button class="cl-btn bad" data-a="withdraw">ถอนโครงการ</button></div></div>` : ""}

      <div class="cl-card"><h3>เอกสารประกอบ</h3><div class="cl-ev">${d.documents.map((x) => `<a href="#" data-doc="${x.doc_id}">📎 ${esc(DK[x.kind] || x.kind)}: ${esc(x.title)}</a>${editable ? `<span><a href="#" data-deldoc="${x.doc_id}" style="background:none;color:#a1261d">ลบ</a></span>` : ""}`).join("") || '<span class="miss">ยังไม่มีเอกสาร</span>'}</div>
        ${["Matched", "Signed", "Closed", "Withdrawn"].includes(l.status) ? "" : `<div class="cl-actions cl-inline"><select id="docKind">${optList(Object.entries(DK), l.project_type === "investment" ? "quotation" : "resolution")}</select><input id="docTitle" placeholder="ชื่อเอกสาร เช่น มติที่ประชุมใหญ่ 2569"><input type="file" id="docFile" accept="image/*,application/pdf"><button class="cl-btn ghost" data-a="doc">แนบเอกสาร</button></div>`}</div>

      <div class="cl-card"><details class="cl-more"><summary>คะแนนสหกรณ์ ${CL.gradeBadge(d.score.grade, d.score.score)} · คะแนนโครงการ ${d.project_score ? CL.gradeBadge(d.project_score.grade, d.project_score.score) : ""} (ผู้ให้กู้เห็นชุดเดียวกัน)</summary>${CL.scorePanel(d.score)}
        <div style="margin-top:10px">${CL.factorPanel("Project Credit Score", d.project_score, "ความเป็นไปได้ 20 · ตลาด 20 · กระแสเงินสด 20 · หลักฐานกิจกรรมจริง 20 · หลักประกันและการควบคุม 10 · ความเสี่ยงด้านราคา 10")}</div>
        <div style="margin-top:8px">${CL.riskPanel(d.risk)}</div></details></div>
      ${d.dairy ? `<div class="cl-card">${CL.dairyPanel(d.dairy)}</div>` : ""}

      ${d.questions.length ? `<div class="cl-card"><h3>ถาม–ตอบกับผู้ให้กู้</h3>${d.questions.map((q) => `<div class="cl-line" style="border-top:1px solid #eef1ee;padding-top:6px" data-q="${q.question_id}">
          <b>${{ question: "คำถาม", document_request: "ขอเอกสารเพิ่ม", visit_request: "ขอนัดเยี่ยมชม" }[q.kind]}:</b> ${esc(q.question)} <span class="cl-muted">${esc(dt(q.created_at))}</span>
          ${q.answer ? `<div>↳ ${esc(q.answer)}</div>` : `<div class="cl-inline" style="margin-top:4px"><input class="q-ans" placeholder="คำตอบ" style="min-width:320px"><input type="file" class="q-file" accept="image/*,application/pdf"><button class="cl-btn" data-a="answer">ตอบ</button></div>`}</div>`).join("")}</div>` : ""}

      ${d.offers.length ? `<div class="cl-card"><h3>เปรียบเทียบข้อเสนอ (${d.offers.length})</h3><div style="overflow-x:auto"><table class="cl-table">
        <tr><th>ผู้ให้กู้</th><th class="r">วงเงิน</th><th class="r">ดอกเบี้ย</th><th>ระยะเวลา/การชำระ</th><th class="r">ดอกเบี้ยรวมโดยประมาณ</th><th>หลักประกัน/เงื่อนไข</th><th>สถานะ</th><th></th></tr>
        ${d.offers.map((o) => `<tr data-o="${o.offer_id}"><td><b>${esc(o.lender_name)}</b><div class="cl-muted">${o.lender_type === "CreditUnion" ? "เครดิตยูเนี่ยน" : "ออมทรัพย์"} · ให้กู้ในระบบ ${o.lender_facilities} ครั้ง</div></td>
          <td class="r">${baht(o.amount)}</td><td class="r"><b>${Number(o.rate_pct)}%</b></td>
          <td>${o.tenor_months} เดือน · ${o.repayment_type === "bullet" ? `ดอกเบี้ยทุก ${o.interval_months} ด. ต้นครั้งเดียว` : `ผ่อนทุก ${o.interval_months} ด.`}${o.grace_months ? ` · ปลอดต้น ${o.grace_months} ด.` : ""}${o.valid_until ? `<div class="cl-muted">ยืนราคาถึง ${esc(date(o.valid_until))}</div>` : ""}</td>
          <td class="r">${o.total_interest != null ? baht(o.total_interest) : "-"}</td>
          <td class="cl-muted">${esc(o.collateral_required || "")}${o.conditions ? `<div>${esc(o.conditions)}</div>` : ""}${o.counter ? `<div style="color:#8a5a00">ท่านโต้ตอบ: ${[o.counter.amount ? baht(o.counter.amount) : "", o.counter.rate_pct != null ? `${o.counter.rate_pct}%` : "", o.counter.tenor_months ? `${o.counter.tenor_months} เดือน` : "", o.counter.note || ""].filter(Boolean).map(esc).join(" · ")}</div>` : ""}</td>
          <td>${pill(CL.OFFER_ST[o.status])}${o.approval_ref ? `<div class="cl-muted">อนุมัติ ${esc(o.approval_ref)}</div>` : ""}</td>
          <td>${open && o.status === "Submitted" ? `<div class="cl-inline"><button class="cl-btn" data-a="accept">เลือก</button><button class="cl-btn ghost" data-a="counter">โต้ตอบ</button><button class="cl-btn bad" data-a="decline">ไม่เลือก</button></div>` : ""}
            ${open && o.status === "Accepted" ? '<button class="cl-btn bad" data-a="decline">ยกเลิกการเลือก</button>' : ""}</td></tr>
          <tr class="counter-row" data-for="${o.offer_id}" style="display:none"><td colspan="8"><div class="cl-inline">โต้ตอบ: <input class="c-amt" type="number" placeholder="วงเงิน"><input class="c-rate" type="number" step="0.01" placeholder="ดอกเบี้ย %"><input class="c-tenor" type="number" placeholder="เดือน"><input class="c-note" placeholder="หมายเหตุ" style="min-width:220px"><button class="cl-btn" data-a="sendcounter">ส่ง</button></div></td></tr>`).join("")}</table></div>
        ${open ? `<div class="cl-actions"><span class="cl-line">ผู้ให้กู้ยืนยันแล้ว ${confirmed.length} ราย รวม <b>${baht(confSum)}</b> ${Number(l.min_amount || l.amount_requested) > confSum ? `(ต้องการอย่างน้อย ${baht(l.min_amount || l.amount_requested)})` : ""}</span>
          <button class="cl-btn" data-a="match" ${confirmed.length && confSum >= Number(l.min_amount || l.amount_requested) ? "" : "disabled"}>จับคู่และจัดทำสัญญา</button></div>
          <div class="cl-muted">ขั้นตอน: เลือกข้อเสนอ → ผู้มีอำนาจอนุมัติของผู้ให้กู้ยืนยัน (คนละคนกับผู้ยื่น) → จับคู่ · เลือกได้หลายรายจนครบวงเงิน (ผู้ให้กู้ร่วม รับชำระตามสัดส่วน)</div>` : ""}</div>` : (open ? '<div class="cl-card cl-muted">ยังไม่มีข้อเสนอ — ระบบแจ้งเตือนผู้ให้กู้ที่นโยบายสินเชื่อตรงกับโครงการแล้ว</div>' : "")}

      ${ag ? `<div class="cl-card"><h3>สัญญาเลขที่ ${esc(ag.agreement_no)} · ${baht(ag.total_amount)}</h3>
        <table class="cl-table"><tr><th>คู่สัญญา</th><th class="r">วงเงิน</th><th class="r">สัดส่วน</th><th>ลงนาม</th></tr>
          <tr><td>${esc(ctx.orgName || "ผู้กู้")} (ผู้กู้)</td><td></td><td></td><td>${ag.borrower_signed ? `✅ ${esc(dt(ag.borrower_signed_at))}` : "⏳ รอ"}</td></tr>
          ${ag.parties.map((p) => `<tr><td>${esc(p.org_name)} (ผู้ให้กู้)</td><td class="r">${baht(p.amount)}</td><td class="r">${num(p.share_pct)}%</td><td>${p.signed ? `✅ ${esc(dt(p.signed_at))}` : "⏳ รอ"}</td></tr>`).join("")}</table>
        <div class="cl-actions"><button class="cl-btn blue" data-a="docx">⬇️ ดาวน์โหลดชุดเอกสารสัญญา (.docx)</button><span class="cl-muted">สัญญา ตารางเบิกจ่าย ตารางชำระคืน หลักประกัน ข้อตกลงบัญชีโครงการ หนังสือยินยอม — ให้ที่ปรึกษากฎหมายตรวจทานก่อนลงนาม</span></div>
        ${ag.status === "Drafted" && !ag.borrower_signed ? `<div class="cl-actions cl-inline">บัญชีโครงการ ${myAccounts.length ? `<select id="projAcc">${myAccounts.map((a) => `<option value="${a.account_id}">${esc(CL.accLabel(a))}</option>`).join("")}</select>` : '<span class="cl-late">เพิ่มบัญชี "เฉพาะเงินกู้" ที่แท็บบัญชีธนาคารก่อน</span>'}
          ฉบับลงนาม <input type="file" id="signFile" accept="application/pdf,image/*"><button class="cl-btn" data-a="sign" ${myAccounts.length ? "" : "disabled"}>อัปโหลดฉบับลงนามของผู้กู้</button></div>` : ""}
        ${ag.status === "Signed" ? `<div class="cl-line">✅ ลงนามครบ ${esc(dt(ag.signed_at))} — วงเงินเปิดแล้ว ${d.facilities.map((f) => `${esc(f.lender_name)} ${baht(f.limit_amount)}`).join(" · ")} · เบิกจ่ายได้ที่แท็บ ${l.project_type === "member_onlending" ? '"สินเชื่อการผลิตรายงวด" และ ' : ""}"รายการเบิก"${l.project_type === "investment" ? ' และ "สินเชื่อเครื่องจักร"' : ""}</div>` : ""}</div>` : ""}

      ${d.tranches && d.tranches.length ? `<div class="cl-card">${CL.tranchePanel(d.tranches, (t) => (t.status === "Open" ? `<form class="cl-form tr-form" data-seq="${t.seq}" style="margin-top:8px">
          <div><label>สินค้าคงเหลือ (กก.)</label><input name="inventory_kg" type="number" step="0.01"></div><div><label>มูลค่าคงเหลือ (บาท)</label><input name="inventory_value" type="number" step="0.01"></div>
          <div><label>ยอดขาย/ส่งมอบแล้ว (บาท)</label><input name="sales_amount" type="number" step="0.01"></div><div><label>หลักฐานส่งมอบ/รับสินค้า</label><input name="delivery_file" type="file" accept="image/*,application/pdf"></div>
          <div class="wide"><label>หมายเหตุ</label><input name="note" placeholder="เช่น แจกจ่ายปัจจัยการผลิตให้สมาชิกครบ 120 ราย"></div><div><button class="cl-btn" type="submit">ส่งปิดยอดงวดนี้</button></div></form>` : ""))}</div>` : ""}
      ${d.performance ? `<div class="cl-card">${CL.factorPanel("Activity Performance Score (ระหว่างสัญญา)", d.performance, "ผู้ให้กู้ใช้ติดตามและประกอบการพิจารณาเปิดงวดถัดไป")}</div>` : ""}

      ${["Signed", "Active", "Closed"].includes(l.status) ? `<div class="cl-card"><h3>รายงานผลการดำเนินงานเทียบแผน</h3>
        <table class="cl-table"><tr><th>งวดรายงาน</th><th class="r">รายได้จริง</th><th class="r">ตามแผน</th><th class="r">ค่าใช้จ่าย</th><th class="r">ผู้ซื้อค้างชำระ</th><th>หมายเหตุ</th></tr>${d.reports.map((r) => `<tr><td>${esc(r.period_label)}</td><td class="r">${r.revenue != null ? num(r.revenue) : "-"}</td><td class="r">${r.planned_revenue != null ? num(r.planned_revenue) : "-"}</td><td class="r">${r.cost != null ? num(r.cost) : "-"}</td><td class="r">${r.buyer_overdue != null ? num(r.buyer_overdue) : "-"}</td><td>${esc(r.note || "")}</td></tr>`).join("") || '<tr><td colspan="6" class="cl-empty">ยังไม่มี</td></tr>'}</table>
        <form id="repForm" class="cl-form" style="margin-top:8px"><div><label>งวด</label><input name="period_label" placeholder="ไตรมาส 1/2570" required></div><div><label>รายได้จริง</label><input name="revenue" type="number"></div><div><label>รายได้ตามแผน</label><input name="planned_revenue" type="number"></div><div><label>ค่าใช้จ่าย</label><input name="cost" type="number"></div><div><label>ผู้ซื้อค้างชำระ (บาท)</label><input name="buyer_overdue" type="number" min="0" step="0.01"></div><div class="wide"><label>หมายเหตุ</label><input name="note"></div><div><button class="cl-btn" type="submit">ส่งรายงาน</button></div></form></div>` : ""}
      <div class="cl-card" id="riskL"></div>`;

    ctx.view.querySelectorAll(".tr-form").forEach((tf) => {
      tf.onsubmit = async (e) => {
        e.preventDefault();
        const f = tf.delivery_file.files[0];
        const v = (k) => (tf[k].value === "" ? null : tf[k].value);
        const r = await CL.act(e.submitter, async () => CL.post(`/coop-lending/market/listings/${l.listing_id}/tranches/${tf.dataset.seq}/submit`, {
          inventory_kg: v("inventory_kg"), inventory_value: v("inventory_value"), sales_amount: v("sales_amount"), note: v("note"), delivery_file_id: f ? await CL.upload(f) : undefined,
        }), "ส่งปิดยอดแล้ว — รอผู้ให้กู้หลักตรวจและอนุมัติเปิดงวดถัดไป");
        if (r) renderDetail();
      };
    });
    riskBox(document.getElementById("riskL"), l.listing_id);
    const rep = document.getElementById("repForm");
    if (rep) rep.onsubmit = async (e) => { e.preventDefault(); if (await CL.act(e.submitter, () => CL.post(`/coop-lending/market/listings/${l.listing_id}/reports`, CL.formData(rep)), "ส่งรายงานแล้ว")) renderDetail(); };
    ctx.view.onclick = async (e) => {
      if (e.target.closest("[data-back]")) { state = { mode: "list" }; renderMarket(ctx); return; }
      const doc = e.target.closest("[data-doc]");
      if (doc) { e.preventDefault(); CL.openFile(`/coop-lending/market/listings/${l.listing_id}/documents/${doc.dataset.doc}/file`); return; }
      const dd = e.target.closest("[data-deldoc]");
      if (dd) { e.preventDefault(); if (await CL.act(dd, () => CL.post(`/coop-lending/market/listings/${l.listing_id}/documents/${dd.dataset.deldoc}/delete`), "ลบแล้ว")) renderDetail(); return; }
      const b = e.target.closest("[data-a]");
      if (!b) return;
      const a = b.dataset.a;
      const oid = (b.closest("[data-o]") || b.closest("[data-for]") || {}).dataset;
      const offerId = oid ? oid.o || oid.for : null;
      let r = null;
      if (a === "edit") { state = { mode: "form", editing: l }; renderForm(l); return; }
      if (a === "certify") r = await CL.act(b, () => CL.post(`/coop-lending/market/listings/${l.listing_id}/certify`), "รับรองแล้ว");
      if (a === "submit") r = await CL.act(b, () => CL.post(`/coop-lending/market/listings/${l.listing_id}/submit`), "ส่งตรวจแล้ว — ผู้ดูแลจะตรวจความครบถ้วนแล้วประกาศ");
      if (a === "withdraw") { if (!window.confirm("ถอนโครงการนี้? ข้อเสนอทั้งหมดจะสิ้นผล")) return; r = await CL.act(b, () => CL.post(`/coop-lending/market/listings/${l.listing_id}/withdraw`), "ถอนแล้ว"); }
      if (a === "doc") {
        const f = document.getElementById("docFile").files[0];
        if (!f) { CL.toast("เลือกไฟล์ก่อน", true); return; }
        r = await CL.act(b, async () => CL.post(`/coop-lending/market/listings/${l.listing_id}/documents`, { kind: document.getElementById("docKind").value, title: document.getElementById("docTitle").value || f.name, file_id: await CL.upload(f) }), "แนบแล้ว");
      }
      if (a === "answer") {
        const q = b.closest("[data-q]"); const f = q.querySelector(".q-file").files[0];
        r = await CL.act(b, async () => CL.post(`/coop-lending/market/questions/${q.dataset.q}/answer`, { answer: q.querySelector(".q-ans").value, file_id: f ? await CL.upload(f) : undefined }), "ตอบแล้ว");
      }
      if (a === "accept") r = await CL.act(b, () => CL.post(`/coop-lending/market/offers/${offerId}/accept`), "เลือกแล้ว — รอผู้มีอำนาจอนุมัติของผู้ให้กู้ยืนยัน");
      if (a === "decline") { if (!window.confirm("ไม่เลือกข้อเสนอนี้?")) return; r = await CL.act(b, () => CL.post(`/coop-lending/market/offers/${offerId}/decline`), "บันทึกแล้ว"); }
      if (a === "counter") { const row = ctx.view.querySelector(`.counter-row[data-for="${offerId}"]`); row.style.display = row.style.display === "none" ? "" : "none"; return; }
      if (a === "sendcounter") {
        const row = b.closest(".counter-row");
        r = await CL.act(b, () => CL.post(`/coop-lending/market/offers/${offerId}/counter`, { amount: row.querySelector(".c-amt").value || null, rate_pct: row.querySelector(".c-rate").value || null, tenor_months: row.querySelector(".c-tenor").value || null, note: row.querySelector(".c-note").value }), "ส่งข้อเสนอโต้ตอบแล้ว");
      }
      if (a === "match") { if (!window.confirm(`จับคู่กับผู้ให้กู้ที่ยืนยันแล้ว ${confirmed.length} ราย รวม ${num(confSum)} บาท และจัดทำสัญญา? ข้อเสนออื่นจะสิ้นผล`)) return; r = await CL.act(b, () => CL.post(`/coop-lending/market/listings/${l.listing_id}/match`), (x) => `จับคู่แล้ว — สัญญาเลขที่ ${x.agreement_no}`); }
      if (a === "docx") { await CL.download(`/coop-lending/market/listings/${l.listing_id}/agreement.docx`, `สัญญา-${ag.agreement_no}.docx`); return; }
      if (a === "sign") {
        const f = document.getElementById("signFile").files[0];
        if (!f) { CL.toast("แนบไฟล์สัญญาที่ลงนามแล้วก่อน", true); return; }
        r = await CL.act(b, async () => CL.post(`/coop-lending/market/listings/${l.listing_id}/agreement/sign`, { file_id: await CL.upload(f), project_account_id: document.getElementById("projAcc").value }), (x) => (x.status === "Signed" ? "ลงนามครบทุกฝ่าย — เปิดวงเงินแล้ว" : `บันทึกแล้ว — รอผู้ให้กู้ลงนาม ${x.pending.lenders.length} ราย`));
      }
      if (r) { await ctx.refresh(); }
    };
  }

  return {
    renderMarket, renderProfile,
    reset() { state = { mode: "list", id: null }; },
    open(id) { state = { mode: "detail", id }; },
  };
}());
