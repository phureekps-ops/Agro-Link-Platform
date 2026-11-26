/**
 * พอร์ทัลสหกรณ์ออมทรัพย์ — สินเชื่อระหว่างสหกรณ์ (backend/src/routes/coopLending.js /savings/*)
 */
/* global AgroLinkSavingsCoopAPI, CL, LenderMarket */
(function () {
  const API = AgroLinkSavingsCoopAPI;
  if (!API.requireSessionOrRedirect()) return;
  CL.init(API);
  const { esc, baht, date, dt, pill } = CL;
  const view = document.getElementById("view");
  let ov = null;
  let accounts = [];
  let tab = "market";

  document.getElementById("logoutBtn").addEventListener("click", () => API.logout());
  document.getElementById("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    if (tab === "market") LenderMarket.reset();
    document.querySelectorAll(".cl-tab").forEach((x) => x.classList.toggle("active", x === b));
    render();
  });

  async function loadOverview() {
    try {
      ov = await CL.get("/savings/overview");
    } catch (err) {
      if (err.message === "kyb_not_verified") {
        document.getElementById("kybBox").innerHTML = `<div class="cl-card"><h3>⏳ รอการยืนยันตัวตนองค์กร</h3><div class="cl-line">ผู้ดูแลแพลตฟอร์มกำลังตรวจเอกสารของ ${esc(err.body.org_name || "")} — เมื่ออนุมัติแล้วพอร์ทัลนี้จะใช้งานได้ทันที</div></div>`;
        document.getElementById("orgName").textContent = err.body.org_name || "";
        document.getElementById("tabs").style.display = "none";
        return false;
      }
      throw err;
    }
    document.getElementById("orgName").textContent = `${ov.org.org_name}${ov.acting_staff ? " · เจ้าหน้าที่" : ""}`;
    document.getElementById("sandboxBox").innerHTML = CL.sandboxBanner(ov.bank);
    const st = (v, l, warn) => `<div class="cl-stat${warn ? " warn" : ""}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    document.getElementById("statsBox").innerHTML = [
      st(baht(ov.open_limit), "วงเงินโครงการที่เปิดรับ"),
      st(baht(ov.approved), `วงเงินที่อนุมัติ (${ov.facilities} สหกรณ์)`),
      st(baht(ov.tranche_outstanding + ov.asset_outstanding), "เงินต้นคงค้าง"),
      st(ov.queue, `รายการหลักฐานครบ รอโอน (ภายใน ${ov.settings.sc_sla_days} วันทำการ)`),
      st(ov.late, "เลยกำหนดโอน — ถูกปรับ " + ov.settings.late_penalty_pct + "% ต่อปี", ov.late > 0),
      st(ov.pending_transfers, "คำสั่งโอนรอผู้อนุมัติ", ov.pending_transfers > 0),
      st(ov.pending_asset_loans, "สินเชื่อเครื่องจักรรอพิจารณา"),
    ].join("");
    const badge = (t, n) => {
      const b = document.querySelector(`[data-tab="${t}"]`);
      const old = b.querySelector(".cl-count"); if (old) old.remove();
      if (n > 0) b.insertAdjacentHTML("beforeend", `<span class="cl-count">${n}</span>`);
    };
    badge("queue", ov.queue); badge("transfers", ov.pending_transfers);
    badge("assets", ov.pending_asset_loans); badge("notices", ov.unread_notices);
    CL.get("/savings/market/offers").then((os) => badge("offers", os.filter((o) => ["Accepted", "Countered"].includes(o.status) || (o.agreement_status === "Drafted" && !o.i_signed)).length)).catch(() => {});
    CL.get("/savings/market/listings?match_only=1").then((d) => badge("market", d.listings.filter((l) => ["Listed", "Offered"].includes(l.status) && !l.my_offer).length)).catch(() => {});
    CL.get("/savings/crop-plans").then((ps) => badge("plans", ps.filter((p) => p.status === "Submitted" || p.stages.some((x) => x.status === "CheckSubmitted")).length)).catch(() => {});
    return true;
  }
  async function loadAccounts() { accounts = await CL.get("/savings/bank-accounts"); }
  const verifiedOps = () => accounts.filter((a) => a.verification_status === "Verified" && a.purpose === "operating");
  const accSelect = (name) => {
    const ops = verifiedOps();
    if (!ops.length) return `<span class="cl-late">ยังไม่มีบัญชีธนาคารที่ตรวจแล้ว — เพิ่มที่แท็บ "บัญชีธนาคาร &amp; เจ้าหน้าที่"</span>`;
    return `<select name="${name}">${ops.map((a) => `<option value="${a.account_id}">${esc(CL.accLabel(a))}</option>`).join("")}</select>`;
  };

  function gotoTab(t) {
    tab = t;
    document.querySelectorAll(".cl-tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === t));
    render();
  }
  const mctx = () => ({ view, refresh: async () => { await loadOverview(); await render(); }, gotoTab });
  async function render() {
    view.innerHTML = '<div class="cl-empty">กำลังโหลด…</div>';
    try {
      await ({
        market: () => LenderMarket.renderBrowse(mctx()), offers: () => LenderMarket.renderOffers(mctx()), lprofile: () => LenderMarket.renderProfile(mctx()),
        queue: renderQueue, plans: renderPlans, transfers: renderTransfers, applications: renderApplications, assets: renderAssets, facilities: renderFacilities,
        programs: renderPrograms, money: renderMoney, setup: renderSetup, notices: renderNotices,
      }[tab])();
    } catch (err) {
      view.innerHTML = `<div class="cl-card cl-late">โหลดข้อมูลไม่สำเร็จ: ${esc(CL.errText(err))}</div>`;
    }
  }
  const refresh = async () => { await loadOverview(); await render(); };

  // ----- รายการรอโอน -----------------------------------------------------
  function itemCard(i, selectable) {
    const late = i.status !== "EvidenceComplete" ? "" : i.sc_late ? `<span class="cl-late">เลยกำหนดโอน ${esc(date(i.sc_due_date))} — มีค่าปรับ</span>` : `ต้องโอนภายใน <b>${esc(date(i.sc_due_date))}</b>`;
    const sat = i.satellite_result ? pill(CL.SAT[i.satellite_result]) : "";
    const flags = (i.satellite_detail && i.satellite_detail.flags || []).filter((f) => f.severity === "high" || f.severity === "medium")
      .map((f) => `<div class="cl-flag">🛰️ ${esc(f.message_th || f.code)}</div>`).join("");
    const ev = (i.evidence || []).map((e) => `<a href="#" data-file="${e.evidence_id}">📎 ${esc(CL.EVIDENCE[e.kind] || e.kind)}${e.doc_no ? ` ${esc(e.doc_no)}` : ""}</a>`).join("");
    const needAck = i.status === "EvidenceComplete" && i.satellite_result === "review" && !i.satellite_ack_by;
    return `<div class="cl-card" data-item="${i.item_id}">
      <div class="cl-row"><div>${selectable && i.status === "EvidenceComplete" ? `<input type="checkbox" class="pick" value="${i.item_id}" data-fac="${i.facility_id}" ${needAck ? "disabled title=\"ต้องรับทราบผลดาวเทียมก่อน\"" : ""}> ` : ""}
        <b>${esc(i.borrower_name)}</b> → ${esc(i.seller_name)} · ${esc(CL.PURPOSE[i.purpose])}</div>
        <div>${pill(CL.ITEM_ST[i.status])} ${sat}</div></div>
      <div class="cl-line">${esc(i.description)} · <b>${baht(i.amount)}</b>${i.farmer_name ? ` · เกษตรกร ${esc(i.farmer_name)}${i.farmer_confirmed_at ? " ✅ ยืนยันแล้ว" : ""}` : ""}${i.doc_no ? ` · เอกสาร ${esc(i.doc_no)}` : ""}</div>
      <div class="cl-line">บัญชีรับเงินผู้ขาย: ${esc(CL.bankName(i.payout_bank))} xxx-${esc(i.payout_tail || "")} ${esc(i.payout_name || "")}${late ? ` · ${late}` : ""}${i.status === "Funded" ? ` · สหกรณ์การเกษตรต้องจ่ายผู้ขายภายใน ${esc(date(i.ac_due_date))}` : ""}</div>
      ${i.plots && i.plots.length ? `<div class="cl-line cl-muted">แปลง: ${i.plots.map((p) => `${esc(p.commodity_code)} ${p.area_rai} ไร่`).join(", ")}</div>` : ""}
      ${flags}
      <div class="cl-ev">${ev}</div>
      ${["EvidencePending", "EvidenceComplete", "Disputed"].includes(i.status) ? `<div class="cl-actions">
        ${needAck ? '<button class="cl-btn blue" data-act="ack-satellite">รับทราบผลดาวเทียมแล้ว</button>' : ""}
        <input class="reason" placeholder="เหตุผล (ส่งกลับ/ปฏิเสธ)" style="padding:7px 9px;border:1px solid #d7ddd8;border-radius:8px;min-width:220px">
        <button class="cl-btn ghost" data-act="return">ส่งกลับให้แก้</button>
        <button class="cl-btn bad" data-act="reject">ปฏิเสธรายการ</button>
        <button class="cl-btn ghost" data-act="events">ประวัติ</button></div>` : ""}
      ${i.disputed_reason ? `<div class="cl-flag">เกษตรกรแจ้งว่าไม่ตรง: ${esc(i.disputed_reason)}</div>` : ""}
      <div class="ev-log"></div>
    </div>`;
  }
  async function renderQueue() {
    const [items] = await Promise.all([CL.get("/savings/items"), loadAccounts()]);
    const ready = items.filter((i) => i.status === "EvidenceComplete");
    const other = items.filter((i) => i.status !== "EvidenceComplete");
    view.innerHTML = `
      <div class="cl-card"><h3>เตรียมโอนเข้าบัญชีเฉพาะของสหกรณ์การเกษตร</h3>
        <div class="cl-muted">เลือกรายการที่หลักฐานครบ (วงเงินเดียวกันโอนรวมครั้งเดียวได้) → ผู้จัดทำกด "เตรียมโอน" → ผู้อนุมัติอีกคนกดอนุมัติในแท็บ "คำสั่งโอน" ระบบจึงส่งคำสั่งไปธนาคาร
        · ถ้าเลยกำหนดโอน ค่าปรับ ${ov.settings.late_penalty_pct}% ต่อปีจะบวกเข้ายอดโอนและส่งต่อถึงผู้ขาย</div>
        <div class="cl-actions">จากบัญชี ${accSelect("from")} <button class="cl-btn" id="prepBtn" ${ready.length ? "" : "disabled"}>เตรียมโอนรายการที่เลือก</button></div>
      </div>
      <div class="section-title">หลักฐานครบ — รอโอน (${ready.length})</div>
      ${ready.map((i) => itemCard(i, true)).join("") || '<div class="cl-empty">ไม่มีรายการรอโอน</div>'}
      <div class="section-title">ระหว่างดำเนินการ (${other.length})</div>
      ${other.map((i) => itemCard(i, false)).join("") || '<div class="cl-empty">ไม่มี</div>'}`;
    const prep = document.getElementById("prepBtn");
    if (prep) prep.onclick = async () => {
      const ids = [...view.querySelectorAll(".pick:checked")].map((x) => x.value);
      if (!ids.length) { CL.toast("เลือกรายการก่อน", true); return; }
      const from = view.querySelector('[name="from"]');
      const r = await CL.act(prep, () => CL.post("/savings/transfers/prepare", { item_ids: ids, from_account_id: from && from.value }),
        (t) => `เตรียมโอน ${baht(t.amount)} แล้ว — รอผู้อนุมัติอีกคน`);
      if (r) refresh();
    };
    bindItemActions();
  }
  function bindItemActions() {
    view.onclick = async (e) => {
      const f = e.target.closest("[data-file]");
      if (f) { e.preventDefault(); CL.openFile(`/savings/evidence/${f.dataset.file}/file`); return; }
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const card = b.closest("[data-item]");
      const id = card.dataset.item;
      const act = b.dataset.act;
      if (act === "events") {
        const evs = await CL.get(`/savings/items/${id}/events`);
        card.querySelector(".ev-log").innerHTML = `<table class="cl-table" style="margin-top:8px">${evs.map((x) => `<tr><td>${esc(dt(x.created_at))}</td><td>${esc(x.action)}</td><td class="cl-muted">${esc(x.actor)}</td></tr>`).join("")}</table>`;
        return;
      }
      const reason = card.querySelector(".reason") ? card.querySelector(".reason").value.trim() : "";
      if ((act === "return" || act === "reject") && reason.length < 3) { CL.toast("กรุณาระบุเหตุผล", true); return; }
      if (act === "reject" && !window.confirm("ปฏิเสธรายการนี้? (ยกเลิกไม่ได้)")) return;
      const r = await CL.act(b, () => CL.post(`/savings/items/${id}/${act}`, { reason }), { "ack-satellite": "รับทราบแล้ว", return: "ส่งกลับแล้ว", reject: "ปฏิเสธแล้ว" }[act]);
      if (r) refresh();
    };
  }

  // ----- คำสั่งโอน ---------------------------------------------------------
  function transferCard(t, canAct) {
    const items = (t.items || []).map((x) => `<div class="cl-line cl-muted">• ${esc(x.description)} → ${esc(x.seller_name)} ${baht(x.amount)}${Number(x.penalty) ? ` + ค่าปรับ ${baht(x.penalty)}` : ""}</div>`).join("");
    return `<div class="cl-card" data-tr="${t.transfer_id}">
      <div class="cl-row"><div><b>${esc(CL.TR_KIND[t.kind])}</b> · ${baht(t.amount)}${Number(t.penalty_amount) ? ` <span class="cl-late">(รวมค่าปรับ ${baht(t.penalty_amount)})</span>` : ""}${Number(t.fee_amount) ? ` · ค่าธรรมเนียมแพลตฟอร์ม ${baht(t.fee_amount)}` : ""}</div><div>${pill(CL.TR_ST[t.status])}</div></div>
      <div class="cl-line">จาก ${esc(CL.bankName(t.from_bank))} xxx-${esc(t.from_tail)} ${esc(t.from_name)} → ${esc(CL.bankName(t.to_bank))} xxx-${esc(t.to_tail)} ${esc(t.to_name)}</div>
      <div class="cl-line cl-muted">${esc(t.memo)} · ผู้จัดทำ: ${esc(t.prepared_by_label)} ${esc(dt(t.created_at))}${t.approved_by_label ? ` · ผู้อนุมัติ: ${esc(t.approved_by_label)} ${esc(dt(t.approved_at))}` : ""}${t.bank_ref ? ` · อ้างอิงธนาคาร ${esc(t.bank_ref)}` : ""}</div>
      ${t.failure_reason ? `<div class="cl-flag">${esc(t.failure_reason)}</div>` : ""}
      ${items}
      ${canAct && t.status === "PendingApproval" ? `<div class="cl-actions"><button class="cl-btn" data-tact="approve">อนุมัติและสั่งโอน</button><button class="cl-btn ghost" data-tact="cancel">ยกเลิก</button>
        <span class="cl-muted">ผู้อนุมัติต้องไม่ใช่ ${esc(t.prepared_by_label)}</span></div>` : ""}
    </div>`;
  }
  // ----- แผนสินเชื่อการผลิตแบบแบ่งงวด ------------------------------------------
  async function renderPlans() {
    const plans = await CL.get("/savings/crop-plans");
    const todo = plans.filter((p) => p.status === "Submitted" || (p.status === "Active" && p.stages.some((x) => x.status === "CheckSubmitted")));
    const running = plans.filter((p) => !todo.includes(p) && ["Active", "Suspended"].includes(p.status));
    const rest = plans.filter((p) => !todo.includes(p) && !running.includes(p));
    view.innerHTML = `<div class="cl-card" style="background:#f4faf5">เงินออกตามรอบการผลิตจริง — อนุมัติแผนแล้วงวดที่ 1 เปิดให้เบิก · งวดถัดไปเปิดเมื่อท่าน<b>ผ่าน</b>ผลตรวจแปลงของงวดก่อน
        (ภาพหน้างานจากสหกรณ์การเกษตร + ผลภาพถ่ายดาวเทียมที่ระบบแนบ) · พบความผิดปกติกด<b>ระงับ</b> แผนทั้งแผนจะหยุดเบิกและหยุดโอนทันที</div>
      <div class="section-title">รอท่านพิจารณา (${todo.length})</div>${todo.map(planCard).join("") || '<div class="cl-empty">ไม่มี</div>'}
      <div class="section-title">กำลังดำเนินการ / ระงับ (${running.length})</div>${running.map(planCard).join("") || '<div class="cl-empty">ไม่มี</div>'}
      ${rest.length ? `<details class="cl-more"><summary>จบแล้ว / ไม่อนุมัติ / ยกเลิก (${rest.length})</summary>${rest.map(planCard).join("")}</details>` : ""}`;
    view.onclick = planClick;
  }
  function planCard(p) {
    const chk = p.stages.find((x) => x.status === "CheckSubmitted");
    const held = p.stages.find((x) => x.status === "Held");
    let act = "";
    if (p.status === "Submitted") {
      act = `<table class="cl-table" style="margin-top:8px"><tr><th>งวด</th><th>กิจกรรม</th><th>ช่วงเวลา</th><th>วิธีตรวจ</th><th class="r">ยอด</th></tr>
        ${p.stages.map((st) => `<tr><td>${st.seq}</td><td>${esc(st.name_th)}</td><td>${esc(date(st.window_start))} – ${esc(date(st.window_end))}</td><td class="cl-muted">${esc(st.check_method_th)}</td><td class="r">${baht(st.planned_amount)}</td></tr>`).join("")}</table>
        <div class="cl-actions cl-inline"><button class="cl-btn" data-pact="approve">อนุมัติแผน (เปิดงวดที่ 1)</button><input class="p-reason" placeholder="เหตุผลกรณีไม่อนุมัติ"><button class="cl-btn bad" data-pact="reject">ไม่อนุมัติ</button></div>`;
    } else if (chk) {
      act = `<div class="cl-card" style="background:#fffaf0;margin:8px 0 0;box-shadow:none;border:1px solid #f0c36d">
          <b>ผลตรวจแปลงงวดที่ ${chk.seq}: ${esc(chk.name_th)}</b> · ส่งเมื่อ ${esc(dt(chk.check_submitted_at))}
          <div class="cl-line">${pill(CL.SAT[chk.satellite_result])} ${CL.satNotes(chk.satellite_detail)}</div>
          ${chk.check_note ? `<div class="cl-line">บันทึกจากสหกรณ์: ${esc(chk.check_note)}</div>` : ""}
          <div class="cl-line">เบิกในงวดนี้แล้ว ${baht(chk.disbursed)} จาก ${baht(chk.planned_amount)} (${chk.items} รายการ)</div>
          <div class="cl-ev">${chk.has_check_file ? `<a href="#" data-sfile="${chk.seq}">📷 เปิดภาพหน้างาน</a>` : ""}</div>
          <div class="cl-actions cl-inline" data-stage="${chk.seq}"><input class="p-note" placeholder="${chk.satellite_result === "review" ? "ต้องระบุเหตุผลที่ให้ผ่าน" : "หมายเหตุ (ถ้ามี)"}" style="min-width:260px">
            <button class="cl-btn" data-pact="pass">ผ่าน — เปิดงวดถัดไป</button><button class="cl-btn bad" data-pact="hold">ระงับแผน</button></div></div>`;
    } else if (p.status === "Active") {
      const cur = p.stages.find((x) => x.status === "Open");
      act = cur ? `<div class="cl-actions cl-inline" data-stage="${cur.seq}"><span class="cl-line">งวดที่ ${cur.seq} เปิดอยู่ — รอสหกรณ์การเกษตรส่งผลตรวจ</span>
        <input class="p-note" placeholder="เหตุผลที่ระงับ"><button class="cl-btn bad" data-pact="hold">ระงับแผน</button></div>` : "";
    } else if (p.status === "Suspended") {
      act = `<div class="cl-flag">ระงับอยู่: ${esc(p.suspended_reason || "")}</div>${held && held.has_check_file ? `<div class="cl-ev"><a href="#" data-sfile="${held.seq}">📷 ภาพหน้างานงวดที่ ${held.seq}</a></div>` : ""}
        <div class="cl-actions"><button class="cl-btn" data-pact="resume">ยกเลิกการระงับ (เปิดงวดเดิมให้ส่งผลตรวจใหม่)</button></div>`;
    }
    return `<div class="cl-card" data-plan="${p.plan_id}">
      <div class="cl-row"><div><b>${esc(p.borrower_name)}</b> → สมาชิก ${esc(p.farmer_name)} · ${esc(p.commodity_name || p.commodity_code)} ${p.area_rai} ไร่ · ${esc(p.season_label)}</div><div>${pill(CL.PLAN_ST[p.status])}</div></div>
      <div class="cl-line">วงเงินทั้งแผน <b>${baht(p.total_amount)}</b> (${baht(Number(p.total_amount) / Number(p.area_rai))}/ไร่) · ปลูก ${esc(date(p.planting_date))}${p.note ? ` · ${esc(p.note)}` : ""}</div>
      ${CL.planTrack(p)}${act}</div>`;
  }
  async function planClick(e) {
    const card = e.target.closest("[data-plan]");
    if (!card) return;
    const id = card.dataset.plan;
    const f = e.target.closest("[data-sfile]");
    if (f) { e.preventDefault(); CL.openFile(`/savings/crop-plans/${id}/stages/${f.dataset.sfile}/file`); return; }
    const b = e.target.closest("[data-pact]");
    if (!b) return;
    const a = b.dataset.pact;
    const row = b.closest("[data-stage]");
    let r = null;
    if (a === "approve") r = await CL.act(b, () => CL.post(`/savings/crop-plans/${id}/approve`), "อนุมัติแล้ว — งวดที่ 1 เปิดให้เบิก");
    else if (a === "reject") r = await CL.act(b, () => CL.post(`/savings/crop-plans/${id}/reject`, { reason: card.querySelector(".p-reason").value }), "แจ้งไม่อนุมัติแล้ว");
    else if (a === "resume") r = await CL.act(b, () => CL.post(`/savings/crop-plans/${id}/resume`), "ยกเลิกการระงับแล้ว");
    else if (a === "pass") r = await CL.act(b, () => CL.post(`/savings/crop-plans/${id}/stages/${row.dataset.stage}/pass`, { note: row.querySelector(".p-note").value || undefined }),
      (x) => (x.completed ? "ผ่านงวดสุดท้าย — แผนครบทุกงวด" : `ผ่านแล้ว — เปิดงวดที่ ${x.opened.seq} ${x.opened.name_th}`));
    else if (a === "hold") {
      if (!window.confirm("ระงับแผนนี้? การเบิกและการโอนของแผนจะหยุดทันที")) return;
      r = await CL.act(b, () => CL.post(`/savings/crop-plans/${id}/stages/${row.dataset.stage}/hold`, { note: row.querySelector(".p-note").value }), "ระงับแผนแล้ว — แจ้งสหกรณ์การเกษตรแล้ว");
    }
    if (r) { await loadOverview(); await render(); }
  }

  async function renderTransfers() {
    const list = await CL.get("/savings/transfers");
    const pend = list.filter((t) => t.status === "PendingApproval");
    view.innerHTML = `<div class="section-title">รออนุมัติ (${pend.length})</div>${pend.map((t) => transferCard(t, true)).join("") || '<div class="cl-empty">ไม่มี</div>'}
      <div class="section-title">ประวัติ</div>${list.filter((t) => t.status !== "PendingApproval").map((t) => transferCard(t, false)).join("") || '<div class="cl-empty">ยังไม่มี</div>'}`;
    view.onclick = async (e) => {
      const b = e.target.closest("[data-tact]");
      if (!b) return;
      const id = b.closest("[data-tr]").dataset.tr;
      if (b.dataset.tact === "approve" && !window.confirm("ยืนยันอนุมัติและส่งคำสั่งโอนไปธนาคาร?")) return;
      const r = await CL.act(b, () => CL.post(`/savings/transfers/${id}/${b.dataset.tact}`), (t) => (t.status === "Succeeded" ? `โอนสำเร็จ อ้างอิง ${t.bank_ref}` : t.status === "Failed" ? `ธนาคารแจ้งโอนไม่สำเร็จ: ${t.failure_reason}` : "ยกเลิกแล้ว"));
      if (r) refresh();
    };
  }

  // ----- คำขอกู้ -----------------------------------------------------------
  async function renderApplications() {
    const apps = await CL.get("/savings/applications");
    const ST = { Submitted: ["รอพิจารณา", "#8a5a00", "#fff2cc"], Approved: ["อนุมัติแล้ว", "#1f6b38", "#ddf3e4"], Rejected: ["ปฏิเสธ", "#a1261d", "#fde8e6"], Withdrawn: ["ถอนคำขอ", "#6b7a70", "#eef1ee"] };
    view.innerHTML = apps.map((a) => `<div class="cl-card" data-app="${a.application_id}">
      <div class="cl-row"><div><b>${esc(a.borrower_name)}</b> · ${esc(a.province_name_th || a.region_code || "")} · โครงการ ${esc(a.program_name)}</div><div>${pill(ST[a.status])}</div></div>
      <div class="cl-line">ขอวงเงิน <b>${baht(a.requested_amount)}</b> · สมาชิกที่แจ้ง ${a.member_count ?? "-"} ราย · สมาชิกที่ยืนยันในระบบ <b>${a.verified_members}</b> ราย
        · วงเงินกับทุกสหกรณ์ออมทรัพย์ ${baht(a.other_facilities_total)}${a.suspended_facilities ? ` · <span class="cl-late">มีวงเงินถูกระงับ ${a.suspended_facilities} รายการ</span>` : ""}</div>
      ${Object.keys(a.purpose_amounts || {}).length ? `<div class="cl-line cl-muted">แผนใช้เงิน: ${Object.entries(a.purpose_amounts).map(([k, v]) => `${esc(CL.PURPOSE[k] || k)} ${baht(v)}`).join(" · ")}</div>` : ""}
      ${a.plan_note ? `<div class="cl-line">${esc(a.plan_note)}</div>` : ""}
      ${a.decided_reason ? `<div class="cl-line cl-muted">เหตุผล: ${esc(a.decided_reason)}</div>` : ""}
      ${a.status === "Submitted" ? `<div class="cl-actions cl-inline">
        วงเงินที่อนุมัติ <input type="number" class="lim" value="${a.requested_amount}" min="1000" step="1000">
        เบิกได้ถึง <input type="date" class="until">
        <button class="cl-btn" data-aact="approve">อนุมัติวงเงิน</button>
        <input class="reason" placeholder="เหตุผลที่ปฏิเสธ"><button class="cl-btn bad" data-aact="reject">ปฏิเสธ</button></div>` : ""}
    </div>`).join("") || '<div class="cl-empty">ยังไม่มีคำขอกู้</div>';
    view.onclick = async (e) => {
      const b = e.target.closest("[data-aact]");
      if (!b) return;
      const card = b.closest("[data-app]");
      const id = card.dataset.app;
      const body = b.dataset.aact === "approve"
        ? { limit_amount: card.querySelector(".lim").value, available_until: card.querySelector(".until").value || undefined }
        : { reason: card.querySelector(".reason").value };
      const r = await CL.act(b, () => CL.post(`/savings/applications/${id}/${b.dataset.aact}`, body), b.dataset.aact === "approve" ? "อนุมัติวงเงินแล้ว" : "ปฏิเสธแล้ว");
      if (r) refresh();
    };
  }

  // ----- สินเชื่อเครื่องจักร -----------------------------------------------
  async function renderAssets() {
    const list = await CL.get("/savings/asset-loans");
    const ST = { Submitted: ["รอพิจารณา", "#8a5a00", "#fff2cc"], Approved: ["อนุมัติ — รอหลักฐานการซื้อ", "#0b5394", "#e3eefb"], Active: ["ผ่อนชำระอยู่", "#6a1b9a", "#f3e5f5"], Closed: ["ปิดแล้ว", "#1f6b38", "#ddf3e4"], Rejected: ["ปฏิเสธ", "#a1261d", "#fde8e6"], Cancelled: ["ยกเลิก", "#6b7a70", "#eef1ee"] };
    view.innerHTML = list.map((a) => `<div class="cl-card" data-asset="${a.asset_loan_id}">
      <div class="cl-row"><div><b>${esc(a.asset_kind)} ${esc(a.brand_model)}</b> · ${esc(a.borrower_name)}${a.farmer_name ? ` (ให้สมาชิก ${esc(a.farmer_name)})` : " (ศูนย์บริการของสหกรณ์)"}</div><div>${pill(ST[a.status])}</div></div>
      <div class="cl-line">ราคา ${baht(a.price)} · ดาวน์ ${baht(a.down_payment)} · กู้ <b>${baht(a.loan_amount)}</b> · ${Number(a.rate_pct)}% ต่อปี · ${a.term_months} เดือน ผ่อนทุก ${a.interval_months} เดือน${a.grace_periods ? ` ปลอดเงินต้น ${a.grace_periods} งวด` : ""}</div>
      <div class="cl-line">ค่างวด ${baht(a.installment)} = <b>${Number(a.income_ratio_pct)}%</b> ของรายได้ต่องวดที่ประมาณ ${baht(a.income_per_period)} · ผู้ขาย ${esc(a.seller_name)}${a.serial_no ? ` · เลขเครื่อง ${esc(a.serial_no)}` : ""}</div>
      <div class="cl-line cl-muted">ที่มาของรายได้: ${esc(a.income_basis)}</div>
      ${a.schedule ? `<details class="cl-more"><summary>ตารางผ่อน ${a.schedule.length} งวด</summary><table class="cl-table"><tr><th>งวด</th><th>ครบกำหนด</th><th class="r">เงินต้น</th><th class="r">ดอกเบี้ย</th><th class="r">ค่างวด</th><th class="r">ชำระแล้ว</th></tr>
        ${a.schedule.map((r) => `<tr><td>${r.seq}</td><td>${esc(date(r.due_date))}</td><td class="r">${CL.num(r.principal)}</td><td class="r">${CL.num(r.interest)}</td><td class="r">${CL.num(r.installment)}</td><td class="r">${CL.num(r.paid_amount)}</td></tr>`).join("")}</table></details>` : ""}
      ${a.status === "Submitted" ? `<div class="cl-actions"><button class="cl-btn" data-xact="approve">อนุมัติ (โอนเมื่อหลักฐานการซื้อครบ)</button><input class="reason" placeholder="เหตุผลที่ปฏิเสธ" style="padding:7px 9px;border:1px solid #d7ddd8;border-radius:8px"><button class="cl-btn bad" data-xact="reject">ปฏิเสธ</button></div>` : ""}
    </div>`).join("") || '<div class="cl-empty">ยังไม่มีคำขอสินเชื่อเครื่องจักร</div>';
    view.onclick = async (e) => {
      const b = e.target.closest("[data-xact]");
      if (!b) return;
      const card = b.closest("[data-asset]");
      const r = await CL.act(b, () => CL.post(`/savings/asset-loans/${card.dataset.asset}/${b.dataset.xact}`, { reason: (card.querySelector(".reason") || {}).value }), "บันทึกแล้ว");
      if (r) refresh();
    };
  }

  // ----- วงเงิน -------------------------------------------------------------
  async function renderFacilities() {
    const list = await CL.get("/savings/facilities");
    view.innerHTML = `<table class="cl-table cl-card"><tr><th>สหกรณ์ผู้กู้</th><th>โครงการ</th><th class="r">วงเงิน</th><th class="r">เงินต้นคงค้าง</th><th class="r">ดอกเบี้ยค้าง*</th><th>เบิกได้ถึง</th><th>สถานะ</th><th></th></tr>
      ${list.map((f) => `<tr data-fac="${f.facility_id}"><td>${esc(f.borrower_name)}</td><td>${esc(f.program_name)}</td><td class="r">${CL.num(f.limit_amount)}</td><td class="r">${CL.num(f.tranche_outstanding)}</td><td class="r">${CL.num(f.interest_unpaid)}</td>
        <td>${esc(date(f.available_until))}</td><td>${f.status === "Active" ? "ใช้งาน" : f.status === "Suspended" ? `<span class="cl-late">ระงับ</span><div class="cl-muted">${esc(f.suspended_reason || "")}</div>` : "ปิด"}</td>
        <td>${f.status === "Active" ? '<button class="cl-btn bad" data-fact="suspend">ระงับ</button>' : f.status === "Suspended" ? '<button class="cl-btn" data-fact="reactivate">เปิดใช้อีกครั้ง</button>' : ""}</td></tr>`).join("") || '<tr><td colspan="8" class="cl-empty">ยังไม่มีวงเงิน</td></tr>'}</table>
      <div class="cl-muted">* ดอกเบี้ยที่บันทึกถึงการชำระครั้งล่าสุด (คิดรายวันจากเงินที่โอนจริง วันที่เลยกำหนดคิด ${ov.settings.late_penalty_pct}% ต่อปีแทนอัตราปกติ)</div>`;
    view.onclick = async (e) => {
      const b = e.target.closest("[data-fact]");
      if (!b) return;
      const reason = b.dataset.fact === "suspend" ? window.prompt("เหตุผลที่ระงับวงเงิน") : "";
      if (b.dataset.fact === "suspend" && !reason) return;
      const r = await CL.act(b, () => CL.post(`/savings/facilities/${b.closest("[data-fac]").dataset.fac}/${b.dataset.fact}`, { reason }), "บันทึกแล้ว");
      if (r) refresh();
    };
  }

  // ----- โครงการ -------------------------------------------------------------
  async function renderPrograms() {
    const list = await CL.get("/savings/programs");
    const PST = { Draft: "ร่าง", Open: "เปิดรับ", Paused: "ปิดรับชั่วคราว", Closed: "ปิด" };
    view.innerHTML = `
      <div class="cl-card"><h3>สร้างโครงการให้กู้</h3>
      <form id="progForm" class="cl-form">
        <div class="wide"><label>ชื่อโครงการ</label><input name="name" required placeholder="เช่น สินเชื่อปัจจัยการผลิตฤดูนาปี 2570"></div>
        <div class="wide"><label>วัตถุประสงค์ที่รับ</label>${Object.entries(CL.PURPOSE).map(([k, v]) => `<label style="display:inline-flex;gap:6px;margin-right:14px;font-weight:400"><input type="checkbox" name="purpose" value="${k}" style="width:auto" checked> ${esc(v)}</label>`).join("")}</div>
        <div><label>วงเงินรวมของโครงการ (บาท)</label><input name="total_limit" type="number" min="1000" step="1000" required></div>
        <div><label>เพดานต่อสหกรณ์ผู้กู้ (บาท)</label><input name="per_borrower_limit" type="number" min="1000" step="1000" required></div>
        <div><label>อัตราดอกเบี้ยต่อปี (%)</label><input name="rate_pct" type="number" min="0" max="30" step="0.01" required></div>
        <div><label>ระยะเวลาคืนต่อรายการเบิก (วัน)</label><input name="tranche_tenor_days" type="number" value="180" min="7" max="730"></div>
        <div><label>วันผ่อนผันก่อนระงับวงเงิน</label><input name="grace_days" type="number" value="15" min="0" max="120"></div>
        <div><label>เพดานต่อเกษตรกร (ไม่บังคับ)</label><input name="per_farmer_limit" type="number" min="1"></div>
        <div><label>เพดานต่อผู้ขาย (ไม่บังคับ)</label><input name="per_seller_limit" type="number" min="1"></div>
        <div><label>สินเชื่อเครื่องจักร: ดาวน์ขั้นต่ำ (%)</label><input name="asset_min_down_pct" type="number" value="10" min="0" max="90"></div>
        <div><label>สินเชื่อเครื่องจักร: ผ่อนนานสุด (เดือน)</label><input name="asset_max_months" type="number" value="60" min="3" max="120"></div>
        <div><label>ค่างวดสูงสุด (% ของรายได้ต่องวด)</label><input name="asset_max_income_ratio_pct" type="number" value="50" min="5" max="100"></div>
        <div class="wide"><label>เงื่อนไขอื่น (หลักประกัน ผู้ค้ำ ประกันภัย เอกสาร)</label><textarea name="conditions" rows="2"></textarea></div>
        <div><button class="cl-btn" type="submit">เปิดโครงการ</button></div>
      </form></div>
      ${list.map((p) => `<div class="cl-card" data-prog="${p.program_id}"><div class="cl-row"><div><b>${esc(p.name)}</b> · ${p.purposes.map((x) => esc(CL.PURPOSE[x])).join(", ")}</div><div>${esc(PST[p.status])}</div></div>
        <div class="cl-line">วงเงิน ${baht(p.total_limit)} (อนุมัติไปแล้ว ${baht(p.committed)}) · เพดานต่อสหกรณ์ ${baht(p.per_borrower_limit)} · ${Number(p.rate_pct)}% ต่อปี · คืนภายใน ${p.tranche_tenor_days} วัน · ผ่อนผัน ${p.grace_days} วัน</div>
        <div class="cl-actions">${p.status === "Open" ? '<button class="cl-btn ghost" data-pst="Paused">ปิดรับชั่วคราว</button>' : '<button class="cl-btn" data-pst="Open">เปิดรับ</button>'}<button class="cl-btn bad" data-pst="Closed">ปิดโครงการ</button></div></div>`).join("")}`;
    document.getElementById("progForm").onsubmit = async (e) => {
      e.preventDefault();
      const d = CL.formData(e.target);
      d.purposes = [...e.target.querySelectorAll('[name="purpose"]:checked')].map((x) => x.value);
      delete d.purpose;
      Object.keys(d).forEach((k) => { if (d[k] === "") delete d[k]; });
      const r = await CL.act(e.submitter, () => CL.post("/savings/programs", d), "เปิดโครงการแล้ว");
      if (r) refresh();
    };
    view.onclick = async (e) => {
      const b = e.target.closest("[data-pst]");
      if (!b) return;
      const r = await CL.act(b, () => CL.patch(`/savings/programs/${b.closest("[data-prog]").dataset.prog}`, { status: b.dataset.pst }), "บันทึกแล้ว");
      if (r) refresh();
    };
  }

  // ----- รับชำระ & ค่าธรรมเนียม --------------------------------------------
  async function renderMoney() {
    const [reps, fees] = await Promise.all([CL.get("/savings/repayments"), CL.get("/savings/fees"), loadAccounts()]);
    view.innerHTML = `
      <div class="cl-card"><h3>ค่าธรรมเนียมแพลตฟอร์ม (${Number(fees.fee_pct)}% ของยอดที่โอนแต่ละงวด)</h3>
        <table class="cl-table"><tr><th>เดือน</th><th class="r">ยอดเบิก</th><th class="r">ค่าธรรมเนียม</th></tr>
        ${fees.months.map((m) => `<tr><td>${esc(m.month)}</td><td class="r">${CL.num(m.disbursed)}</td><td class="r">${CL.num(m.fee)}</td></tr>`).join("") || '<tr><td colspan="3" class="cl-empty">ยังไม่มี</td></tr>'}</table>
        <div class="cl-line">รวม ${baht(fees.total_fee)} · ชำระแล้ว ${baht(fees.paid)} · <b>ค้าง ${baht(fees.outstanding)}</b></div>
        ${fees.outstanding > 0 ? (fees.platform_account_ready ? `<div class="cl-actions">จากบัญชี ${accSelect("feeFrom")} <button class="cl-btn" id="feeBtn">เตรียมชำระค่าธรรมเนียม ${baht(fees.outstanding)}</button></div>` : '<div class="cl-muted">ผู้ดูแลแพลตฟอร์มยังไม่ได้ตั้งบัญชีรับค่าธรรมเนียม</div>') : ""}
      </div>
      <div class="cl-card"><h3>เงินที่ได้รับชำระคืน</h3><table class="cl-table"><tr><th>วันที่</th><th>สหกรณ์</th><th class="r">ยอด</th><th class="r">ดอกเบี้ย</th><th class="r">ดอกเบี้ยผิดนัด</th><th class="r">เงินต้น</th><th>อ้างอิง</th></tr>
        ${reps.map((r) => `<tr><td>${esc(date(r.paid_on))}</td><td>${esc(r.borrower_name)}${r.asset_loan_id ? " (ค่างวดเครื่องจักร)" : ""}</td><td class="r">${CL.num(r.amount)}</td><td class="r">${CL.num(r.interest_part)}</td><td class="r">${CL.num(r.penalty_part)}</td><td class="r">${CL.num(r.principal_part)}</td><td>${esc(r.bank_ref || "")}</td></tr>`).join("") || '<tr><td colspan="7" class="cl-empty">ยังไม่มี</td></tr>'}</table></div>`;
    const fb = document.getElementById("feeBtn");
    if (fb) fb.onclick = async () => {
      const r = await CL.act(fb, () => CL.post("/savings/fees/prepare", { amount: fees.outstanding, from_account_id: view.querySelector('[name="feeFrom"]').value }), "เตรียมชำระแล้ว — รอผู้อนุมัติอีกคนในแท็บคำสั่งโอน");
      if (r) refresh();
    };
  }

  // ----- บัญชีธนาคาร & เจ้าหน้าที่ ------------------------------------------
  async function renderSetup() {
    const [staff] = await Promise.all([CL.get("/savings/staff"), loadAccounts()]);
    view.innerHTML = `
      <div class="cl-card"><h3>บัญชีธนาคารของสหกรณ์ (ใช้โอนเงินกู้และรับชำระคืน)</h3>
        <div class="cl-muted">ระบบตรวจชื่อบัญชีกับธนาคาร — ชื่อต้องตรงกับชื่อองค์กร "${esc(ov.org.org_name)}"</div>
        <table class="cl-table">${accounts.map((a) => `<tr><td>${esc(CL.accLabel(a))}</td><td>${a.verification_status === "Verified" ? "✅ ตรวจแล้ว" : `<span class="cl-late">ไม่ผ่าน</span> <span class="cl-muted">${esc(a.verification_note || "")}</span>`}</td></tr>`).join("") || '<tr><td class="cl-empty">ยังไม่มีบัญชี</td></tr>'}</table>
        <form id="accForm" class="cl-form" style="margin-top:10px">
          <div><label>ธนาคาร</label><select name="bank_code">${CL.bankOptions()}</select></div>
          <div><label>เลขที่บัญชี</label><input name="account_no" required inputmode="numeric" placeholder="ตัวเลข 10-15 หลัก"></div>
          <div><label>ชื่อบัญชี</label><input name="account_name" required value="${esc(ov.org.org_name)}"></div>
          <div><button class="cl-btn" type="submit">เพิ่มและตรวจบัญชี</button></div>
        </form></div>
      <div class="cl-card"><h3>เจ้าหน้าที่ (ผู้จัดทำ/ผู้อนุมัติการโอน)</h3>
        <div class="cl-muted">การโอนทุกครั้งต้องมี 2 คน: บัญชีหลักขององค์กรนับเป็น 1 คน เจ้าหน้าที่แต่ละคนนับเป็นอีก 1 คน — รหัสเข้าระบบของเจ้าหน้าที่จะแสดงครั้งเดียวหลังสร้าง ให้ส่งต่อด้วยช่องทางที่ปลอดภัย</div>
        <table class="cl-table">${staff.map((m) => `<tr data-mem="${m.member_id}"><td>${esc(m.full_name)}</td><td>${esc(m.role_code || "")}</td><td>${m.status === "Active" ? "ใช้งาน" : "ปิดแล้ว"}</td><td>${m.status === "Active" ? '<button class="cl-btn bad" data-deact="1">ปิดบัญชี</button>' : ""}</td></tr>`).join("") || '<tr><td class="cl-empty">ยังไม่มีเจ้าหน้าที่</td></tr>'}</table>
        <form id="staffForm" class="cl-form" style="margin-top:10px">
          <div><label>ชื่อ-นามสกุล</label><input name="full_name" required></div>
          <div><label>เลขบัตรประชาชน (เก็บเป็นค่าแฮช)</label><input name="national_id" required inputmode="numeric" maxlength="13"></div>
          <div><label>บทบาท</label><select name="role_code"><option value="coop.credit_officer">เจ้าหน้าที่สินเชื่อ</option><option value="coop.manager">ผู้จัดการ</option><option value="coop.admin">ผู้ดูแลระบบของสหกรณ์</option></select></div>
          <div><button class="cl-btn" type="submit">สร้างบัญชีเจ้าหน้าที่</button></div>
        </form><div id="staffOut"></div></div>`;
    document.getElementById("accForm").onsubmit = async (e) => {
      e.preventDefault();
      const r = await CL.act(e.submitter, () => CL.post("/savings/bank-accounts", CL.formData(e.target)), (a) => (a.verification_status === "Verified" ? "ตรวจบัญชีผ่านแล้ว" : `ตรวจไม่ผ่าน: ${a.verification_note}`));
      if (r) render();
    };
    document.getElementById("staffForm").onsubmit = async (e) => {
      e.preventDefault();
      const r = await CL.act(e.submitter, () => CL.post("/savings/staff", CL.formData(e.target)), "สร้างบัญชีแล้ว");
      if (r) {
        await render();
        document.getElementById("staffOut").innerHTML = `<div class="cl-sandbox">รหัสเข้าระบบของเจ้าหน้าที่ (แสดงครั้งเดียว): <code>${esc(r.auth_subject_id)}</code></div>`;
      }
    };
    view.onclick = async (e) => {
      const b = e.target.closest("[data-deact]");
      if (!b || !window.confirm("ปิดบัญชีเจ้าหน้าที่คนนี้?")) return;
      const r = await CL.act(b, () => CL.post(`/savings/staff/${b.closest("[data-mem]").dataset.mem}/deactivate`), "ปิดบัญชีแล้ว");
      if (r) render();
    };
  }

  async function renderNotices() {
    const list = await CL.get("/savings/notices");
    view.innerHTML = `<div class="cl-card"><h3>การทวงถาม/แจ้งเตือน</h3>${list.map((n) => `<div class="cl-line" style="padding:6px 0;border-bottom:1px solid #eef1ee">${n.read_at ? "" : "🔴 "}${esc(date(n.notice_date))} · ${esc(n.message)}</div>`).join("") || '<div class="cl-empty">ไม่มีการทวงถาม</div>'}</div>`;
    if (list.some((n) => !n.read_at)) { await CL.post("/savings/notices/read"); loadOverview(); }
  }

  (async () => {
    try {
      if (await loadOverview()) await render();
    } catch (err) {
      view.innerHTML = `<div class="cl-card cl-late">โหลดข้อมูลไม่สำเร็จ: ${esc(CL.errText(err))}</div>`;
    }
  })();
}());
