/**
 * พอร์ทัลสหกรณ์การเกษตร — สินเชื่อจากสหกรณ์ออมทรัพย์ (backend/src/routes/coopLending.js /coop-lending/*)
 */
/* global AgroLinkCoopAPI, CL */
(function () {
  const API = AgroLinkCoopAPI;
  if (!API.requireSessionOrRedirect()) return;
  CL.init(API);
  const { esc, baht, date, dt, pill } = CL;
  const view = document.getElementById("view");
  let ov = null;
  let tab = "items";
  let facilities = [];
  let accounts = [];
  let members = null;

  document.getElementById("logoutBtn").addEventListener("click", () => API.logout());
  document.getElementById("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    document.querySelectorAll(".cl-tab").forEach((x) => x.classList.toggle("active", x === b));
    render();
  });

  async function loadOverview() {
    ov = await CL.get("/coop-lending/overview");
    document.getElementById("orgName").textContent = `${ov.org.org_name}${ov.acting_staff ? " · เจ้าหน้าที่" : ""}`;
    document.getElementById("sandboxBox").innerHTML = CL.sandboxBanner(ov.bank);
    document.getElementById("scDays").textContent = ov.settings.sc_sla_days;
    document.getElementById("acDays").textContent = ov.settings.ac_sla_days;
    document.getElementById("penPct").textContent = ov.settings.late_penalty_pct;
    const st = (v, l, warn) => `<div class="cl-stat${warn ? " warn" : ""}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    document.getElementById("statsBox").innerHTML = [
      st(baht(ov.limit_total), `วงเงินที่ได้รับ (${ov.facilities} วงเงิน)`),
      st(baht(ov.outstanding), "เงินต้นคงค้าง"),
      st(ov.drafts, "รายการร่าง/รอเกษตรกรยืนยัน"),
      st(ov.waiting_sc, "หลักฐานครบ รอสหกรณ์ออมทรัพย์โอน"),
      st(ov.to_pay, `เงินเข้าแล้ว ต้องจ่ายผู้ขาย (ภายใน ${ov.settings.ac_sla_days} วันทำการ)`, ov.to_pay > 0),
      st(ov.late, "เลยกำหนดจ่ายผู้ขาย", ov.late > 0),
      st(ov.pending_transfers, "คำสั่งโอนรอผู้อนุมัติ", ov.pending_transfers > 0),
    ].join("");
    const badge = (t, n) => {
      const b = document.querySelector(`[data-tab="${t}"]`);
      const old = b.querySelector(".cl-count"); if (old) old.remove();
      if (n > 0) b.insertAdjacentHTML("beforeend", `<span class="cl-count">${n}</span>`);
    };
    badge("items", ov.to_pay + ov.drafts); badge("transfers", ov.pending_transfers); badge("notices", ov.unread_notices);
  }
  async function loadCommon() {
    [facilities, accounts] = await Promise.all([CL.get("/coop-lending/facilities"), CL.get("/coop-lending/bank-accounts")]);
  }
  const own = (purposes) => accounts.filter((a) => a.owner_type === "organization" && a.owner_id === ov.org.org_id && purposes.includes(a.purpose) && a.verification_status === "Verified");
  const accSel = (name, purposes) => {
    const list = own(purposes);
    if (!list.length) return '<span class="cl-late">ยังไม่มีบัญชีที่ตรวจแล้ว (เพิ่มที่แท็บ "บัญชีธนาคาร")</span>';
    return `<select name="${name}">${list.map((a) => `<option value="${a.account_id}">${esc(CL.accLabel(a))}${a.purpose === "loan_dedicated" ? " (บัญชีเฉพาะ)" : ""}</option>`).join("")}</select>`;
  };

  async function render() {
    view.innerHTML = '<div class="cl-empty">กำลังโหลด…</div>';
    try {
      await loadCommon();
      await ({
        items: renderItems, transfers: renderTransfers, facilities: renderFacilities, assets: renderAssets, programs: renderPrograms, accounts: renderAccounts, notices: renderNotices,
      }[tab])();
    } catch (err) {
      view.innerHTML = `<div class="cl-card cl-late">โหลดข้อมูลไม่สำเร็จ: ${esc(CL.errText(err))}</div>`;
    }
  }
  const refresh = async () => { await loadOverview(); await render(); };

  // ----- รายการเบิก --------------------------------------------------------
  function missingText(m) {
    const parts = [...(m.missingKinds || []).map((k) => CL.EVIDENCE[k] || k), ...(m.missingFields || []).map((f) => ({ service_date: "วันที่ทำงาน", service_area_rai: "พื้นที่ (ไร่)" }[f]))];
    if (m.needPayout) parts.push("บัญชีรับเงินผู้ขาย");
    return parts;
  }
  function itemCard(i) {
    const miss = missingText(i.missing || {});
    const ev = (i.evidence || []).map((e) => `<a href="#" data-file="${e.evidence_id}">📎 ${esc(CL.EVIDENCE[e.kind] || e.kind)}${e.doc_no ? ` ${esc(e.doc_no)}` : ""}</a>`).join("")
      + miss.map((m) => `<span class="miss">ยังขาด: ${esc(m)}</span>`).join("");
    const sat = i.satellite_result ? pill(CL.SAT[i.satellite_result]) : "";
    const editable = ["Draft", "EvidencePending"].includes(i.status);
    const kinds = Object.entries(CL.EVIDENCE).map(([k, v]) => `<option value="${k}" ${(i.missing && i.missing.missingKinds || [])[0] === k ? "selected" : ""}>${esc(v)}</option>`).join("");
    return `<div class="cl-card" data-item="${i.item_id}">
      <div class="cl-row"><div><b>${esc(i.description)}</b> · ${esc(CL.PURPOSE[i.purpose])} · ${baht(i.amount)}</div><div>${pill(CL.ITEM_ST[i.status])} ${sat}</div></div>
      <div class="cl-line">ผู้ขาย ${esc(i.seller_name)} → บัญชี ${i.payout_tail ? `${esc(CL.bankName(i.payout_bank))} xxx-${esc(i.payout_tail)} ${esc(i.payout_name)}` : '<span class="cl-late">ยังไม่ได้เลือก</span>'}
        ${i.farmer_name ? ` · เกษตรกร ${esc(i.farmer_name)} ${i.farmer_confirmed_at ? "✅ ยืนยันแล้ว" : "⏳ รอยืนยันในแอปของเกษตรกร"}` : ""} · ผู้ให้กู้ ${esc(i.lender_name)}</div>
      ${i.sc_due_date && i.status === "EvidenceComplete" ? `<div class="cl-line">สหกรณ์ออมทรัพย์ต้องโอนภายใน <b>${esc(date(i.sc_due_date))}</b>${i.sc_late ? ' <span class="cl-late">— เลยกำหนดแล้ว</span>' : ""}</div>` : ""}
      ${i.status === "Funded" ? `<div class="cl-line ${i.ac_late ? "cl-late" : ""}">เงินเข้าบัญชีเฉพาะแล้ว — ต้องจ่ายผู้ขายภายใน <b>${esc(date(i.ac_due_date))}</b>${i.ac_late ? " (เลยกำหนด มีค่าปรับให้ผู้ขาย)" : ""}${Number(i.sc_penalty) ? ` · ค่าปรับจากสหกรณ์ออมทรัพย์ที่ต้องส่งต่อให้ผู้ขาย ${baht(i.sc_penalty)}` : ""}</div>` : ""}
      ${i.returned_reason ? `<div class="cl-flag">ส่งกลับให้แก้: ${esc(i.returned_reason)}</div>` : ""}
      ${i.rejected_reason ? `<div class="cl-flag">ปฏิเสธ: ${esc(i.rejected_reason)}</div>` : ""}
      ${i.disputed_reason ? `<div class="cl-flag">เกษตรกรแจ้งว่าไม่ตรง: ${esc(i.disputed_reason)}</div>` : ""}
      ${(i.satellite_detail && i.satellite_detail.flags || []).filter((f) => f.severity !== "info").map((f) => `<div class="cl-flag">🛰️ ${esc(f.message_th || f.code)}</div>`).join("")}
      <div class="cl-ev">${ev}</div>
      ${editable ? `<div class="cl-actions cl-inline">
          <select class="ev-kind">${kinds}</select><input type="file" class="ev-file" accept="image/*,application/pdf"><input class="ev-doc" placeholder="เลขเอกสาร (ถ้ามี)" style="min-width:120px">
          <button class="cl-btn ghost" data-iact="evidence">แนบหลักฐาน</button>
          ${i.status === "Draft" ? '<button class="cl-btn" data-iact="submit">ส่งตรวจ</button>' : ""}
          <button class="cl-btn bad" data-iact="cancel">ยกเลิกรายการ</button></div>
        ${i.status === "Draft" && i.purpose === "machinery_service" ? `<div class="cl-actions cl-inline">วันที่ทำงาน <input type="date" class="svc-date" value="${esc(i.service_date ? String(i.service_date).slice(0, 10) : "")}"> พื้นที่ (ไร่) <input type="number" step="0.01" class="svc-area" value="${esc(i.service_area_rai || "")}"><button class="cl-btn ghost" data-iact="svc">บันทึก</button></div>` : ""}` : ""}
      ${i.status === "Funded" ? '<div class="cl-actions"><button class="cl-btn" data-iact="pay">เตรียมจ่ายผู้ขาย (รออนุมัติอีกคน)</button></div>' : ""}
    </div>`;
  }
  async function renderItems() {
    const items = await CL.get("/coop-lending/items");
    const active = facilities.filter((f) => f.status === "Active");
    const groups = [["ต้องจ่ายผู้ขาย", items.filter((i) => i.status === "Funded")], ["ร่าง / รอหลักฐาน / รอเกษตรกร", items.filter((i) => ["Draft", "EvidencePending"].includes(i.status))],
      ["รอสหกรณ์ออมทรัพย์โอน", items.filter((i) => i.status === "EvidenceComplete")], ["เสร็จสิ้น / อื่นๆ", items.filter((i) => ["Paid", "Rejected", "Disputed", "Cancelled"].includes(i.status))]];
    view.innerHTML = `
      <div class="cl-card"><h3>สร้างรายการเบิกใหม่</h3>
        ${active.length ? `<form id="newItem" class="cl-form">
          <div><label>วงเงิน</label><select name="facility_id">${active.map((f) => `<option value="${f.facility_id}">${esc(f.lender_name)} — คงเหลือ ${baht(f.available)}</option>`).join("")}</select></div>
          <div><label>วัตถุประสงค์</label><select name="purpose"></select></div>
          <div><label>ที่มา</label><select name="source_type"></select></div>
          <div class="wide" id="srcBox"></div>
          <div class="wide" id="extraBox"></div>
          <div class="wide"><label>รายละเอียด</label><input name="description" required placeholder="เช่น ปุ๋ย 16-16-8 จำนวน 100 กระสอบ"></div>
          <div><label>เลขใบกำกับ/ใบแจ้งหนี้ (ถ้ามี)</label><input name="doc_no"></div>
          <div><button class="cl-btn" type="submit">สร้างรายการ</button></div>
        </form>` : '<div class="cl-muted">ยังไม่มีวงเงินที่ใช้งานได้ — ยื่นขอกู้ที่แท็บ "ขอกู้"</div>'}
      </div>
      ${groups.map(([t, list]) => `<div class="section-title">${esc(t)} (${list.length})</div>${list.map(itemCard).join("") || '<div class="cl-empty">ไม่มี</div>'}`).join("")}`;
    if (active.length) bindNewItem(active);
    view.onclick = itemClick;
  }
  function bindNewItem(active) {
    const form = document.getElementById("newItem");
    const fSel = form.facility_id; const pSel = form.purpose; const sSel = form.source_type;
    const srcBox = document.getElementById("srcBox"); const extra = document.getElementById("extraBox");
    let sources = [];
    const SRC = { inputs: [["product_order", "คำสั่งซื้อในตลาดปัจจัย"], ["manual", "ใบแจ้งหนี้จากผู้ขาย (นอกตลาด)"]], machinery_service: [["machinery_booking", "การจองเครื่องจักรในระบบ"], ["manual", "ใบแจ้งหนี้จากผู้ให้บริการ"]], procurement: [["produce_delivery", "การรับซื้อ/ชั่งผลผลิตในระบบ"]], asset: [["asset_loan", "สินเชื่อเครื่องจักรที่อนุมัติแล้ว"]] };
    const fillPurpose = () => {
      const f = active.find((x) => x.facility_id === fSel.value);
      pSel.innerHTML = f.purposes.map((p) => `<option value="${p}">${esc(CL.PURPOSE[p])}</option>`).join("");
      fillSource();
    };
    const fillSource = () => { sSel.innerHTML = SRC[pSel.value].map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join(""); loadSources(); };
    async function ensureMembers() { if (!members) members = await CL.get("/coop-lending/members"); return members; }
    const payoutSel = (sellerType, sellerId) => {
      const list = accounts.filter((a) => a.purpose === "payout" && a.owner_type === sellerType && a.owner_id === sellerId && a.verification_status === "Verified");
      return `<div><label>บัญชีรับเงินของผู้ขาย</label>${list.length ? `<select name="payout_account_id">${list.map((a) => `<option value="${a.account_id}">${esc(CL.accLabel(a))}</option>`).join("")}</select>`
        : '<div class="cl-muted">ยังไม่มี — เพิ่มที่แท็บ "บัญชีธนาคาร" (เพิ่มภายหลังได้ ก่อนส่งตรวจ)</div>'}</div>`;
    };
    const plotPick = async (farmerId) => {
      if (!farmerId) return "";
      const m = (await ensureMembers()).find((x) => x.farmer_id === farmerId);
      if (!m || !m.plots.length) return '<div class="cl-muted">เกษตรกรยังไม่มีแปลงที่ลงทะเบียน — ตรวจด้วยภาพดาวเทียมไม่ได้ (ใช้ภาพหน้างานแทน)</div>';
      return `<div><label>แปลงที่ใช้ (ตรวจด้วยภาพดาวเทียม)</label>${m.plots.map((p) => `<label style="display:inline-flex;gap:6px;margin-right:12px;font-weight:400"><input type="checkbox" name="unit_ids" value="${p.unit_id}" style="width:auto" checked>${esc(p.commodity_code)} ${p.area_rai} ไร่</label>`).join("")}</div>`;
    };
    async function loadSources() {
      extra.innerHTML = "";
      if (sSel.value === "manual") {
        await ensureMembers();
        srcBox.innerHTML = `<div class="cl-form"><div><label>ผู้ขาย/ผู้ให้บริการ (ค้นชื่อ)</label><input id="sellerQ" placeholder="พิมพ์อย่างน้อย 2 ตัวอักษร"><select name="seller_id" id="sellerSel"></select></div>
          <div><label>เกษตรกรที่ได้รับ</label><select name="farmer_id"><option value="">— ใช้ในนามสหกรณ์ —</option>${members.map((m) => `<option value="${m.farmer_id}">${esc(m.full_name)}${m.member_no ? ` (${esc(m.member_no)})` : ""}</option>`).join("")}</select></div>
          <div><label>ยอดเงิน (บาท)</label><input name="amount" type="number" min="1" step="0.01" required></div></div>`;
        const q = document.getElementById("sellerQ"); const sel = document.getElementById("sellerSel");
        let timer;
        q.oninput = () => { clearTimeout(timer); timer = setTimeout(async () => {
          const list = await CL.get(`/coop-lending/sellers?q=${encodeURIComponent(q.value)}`);
          sel.innerHTML = list.map((o) => `<option value="${o.org_id}">${esc(o.org_name)}</option>`).join("");
          sel.onchange();
        }, 300); };
        sel.onchange = async () => { extra.innerHTML = `<div class="cl-form">${payoutSel("organization", sel.value)}${await plotPick(form.farmer_id.value)}${pSel.value === "machinery_service" ? '<div><label>วันที่ทำงาน</label><input type="date" name="service_date"></div><div><label>พื้นที่ (ไร่)</label><input type="number" step="0.01" name="service_area_rai"></div>' : ""}</div>`; };
        form.farmer_id.onchange = () => sel.onchange();
        return;
      }
      srcBox.innerHTML = '<div class="cl-empty">กำลังโหลด…</div>';
      sources = await CL.get(`/coop-lending/sources?purpose=${pSel.value}`);
      if (pSel.value === "asset") sources = sources.filter((s) => s.facility_id === fSel.value);
      srcBox.innerHTML = sources.length ? `<label>เลือกรายการต้นทาง (ยอดและผู้ขายดึงจากระบบ)</label><select name="source_id">${sources.map((s) => `<option value="${s.id}">${esc(s.label)} · ${esc(s.seller_name || s.farmer_name || "")}${s.farmer_name && s.seller_name ? ` → ${esc(s.farmer_name)}` : ""}${s.amount ? ` · ${baht(s.amount)}` : ` · ${esc(s.unit_price || "")} ${esc(s.price_unit || "")}`} · ${esc(date(s.at))}</option>`).join("")}</select>`
        : '<div class="cl-muted">ไม่มีรายการต้นทางที่ยังไม่เคยเบิก</div>';
      const srcSel = form.source_id;
      const onSrc = async () => {
        const s = sources.find((x) => x.id === srcSel.value);
        if (!s) return;
        if (!form.description.value) form.description.value = s.label || "";
        const sellerType = pSel.value === "procurement" ? "farmer" : "organization";
        const sellerId = pSel.value === "procurement" ? s.farmer_id : s.seller_id;
        extra.innerHTML = `<div class="cl-form">${payoutSel(sellerType, sellerId)}${pSel.value === "procurement" ? "" : await plotPick(s.farmer_id)}
          ${pSel.value === "machinery_service" ? '<div><label>ยอดค่าบริการ (บาท)</label><input type="number" name="amount" min="1" step="0.01" required></div><div><label>วันที่ทำงาน</label><input type="date" name="service_date"></div><div><label>พื้นที่ (ไร่)</label><input type="number" step="0.01" name="service_area_rai"></div>' : ""}</div>`;
      };
      if (srcSel) { srcSel.onchange = onSrc; onSrc(); }
    }
    fSel.onchange = fillPurpose; pSel.onchange = fillSource; sSel.onchange = loadSources;
    fillPurpose();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const d = CL.formData(form);
      d.unit_ids = [...form.querySelectorAll('[name="unit_ids"]:checked')].map((x) => x.value);
      if (sSel.value === "manual") d.seller_type = "organization";
      Object.keys(d).forEach((k) => { if (d[k] === "") delete d[k]; });
      const r = await CL.act(e.submitter, () => CL.post("/coop-lending/items", d), "สร้างรายการแล้ว — แนบหลักฐานแล้วกด \"ส่งตรวจ\"");
      if (r) refresh();
    };
  }
  async function itemClick(e) {
    const f = e.target.closest("[data-file]");
    if (f) { e.preventDefault(); CL.openFile(`/coop-lending/evidence/${f.dataset.file}/file`); return; }
    const b = e.target.closest("[data-iact]");
    if (!b) return;
    const card = b.closest("[data-item]");
    const id = card.dataset.item;
    const a = b.dataset.iact;
    let r = null;
    if (a === "evidence") {
      const file = card.querySelector(".ev-file").files[0];
      if (!file) { CL.toast("เลือกไฟล์ก่อน", true); return; }
      r = await CL.act(b, async () => {
        const fileId = await CL.upload(file);
        return CL.post(`/coop-lending/items/${id}/evidence`, { kind: card.querySelector(".ev-kind").value, file_id: fileId, doc_no: card.querySelector(".ev-doc").value || undefined });
      }, "แนบหลักฐานแล้ว");
    } else if (a === "submit") {
      r = await CL.act(b, () => CL.post(`/coop-lending/items/${id}/submit`), (x) => (x.status === "EvidenceComplete" ? "หลักฐานครบ — ส่งให้สหกรณ์ออมทรัพย์แล้ว" : "ส่งแล้ว — รอเกษตรกรยืนยันในแอปของตนเอง"));
    } else if (a === "cancel") {
      if (!window.confirm("ยกเลิกรายการนี้?")) return;
      r = await CL.act(b, () => CL.post(`/coop-lending/items/${id}/cancel`), "ยกเลิกแล้ว");
    } else if (a === "svc") {
      r = await CL.act(b, () => CL.patch(`/coop-lending/items/${id}`, { service_date: card.querySelector(".svc-date").value, service_area_rai: card.querySelector(".svc-area").value || null }), "บันทึกแล้ว");
    } else if (a === "pay") {
      r = await CL.act(b, () => CL.post("/coop-lending/transfers/prepare-seller", { item_id: id }), (t) => `เตรียมจ่าย ${baht(t.amount)} แล้ว — ให้ผู้อนุมัติอีกคนกดอนุมัติในแท็บคำสั่งโอน`);
    }
    if (r) refresh();
  }

  // ----- คำสั่งโอน -----------------------------------------------------------
  async function renderTransfers() {
    const list = await CL.get("/coop-lending/transfers");
    const card = (t, canAct) => `<div class="cl-card" data-tr="${t.transfer_id}">
      <div class="cl-row"><div><b>${esc(CL.TR_KIND[t.kind])}</b> · ${baht(t.amount)}${Number(t.penalty_amount) ? ` <span class="cl-late">(รวมค่าปรับ ${baht(t.penalty_amount)})</span>` : ""}</div><div>${pill(CL.TR_ST[t.status])}</div></div>
      <div class="cl-line">จาก ${esc(CL.bankName(t.from_bank))} xxx-${esc(t.from_tail)} ${esc(t.from_name)} → ${esc(CL.bankName(t.to_bank))} xxx-${esc(t.to_tail)} ${esc(t.to_name)}</div>
      <div class="cl-line cl-muted">${esc(t.memo)} · ผู้จัดทำ ${esc(t.prepared_by_label)} ${esc(dt(t.created_at))}${t.approved_by_label ? ` · ผู้อนุมัติ ${esc(t.approved_by_label)}` : ""}${t.bank_ref ? ` · อ้างอิง ${esc(t.bank_ref)}` : ""}</div>
      ${t.failure_reason ? `<div class="cl-flag">${esc(t.failure_reason)}</div>` : ""}
      ${canAct ? `<div class="cl-actions"><button class="cl-btn" data-tact="approve">อนุมัติและสั่งโอน</button><button class="cl-btn ghost" data-tact="cancel">ยกเลิก</button><span class="cl-muted">ผู้อนุมัติต้องไม่ใช่ ${esc(t.prepared_by_label)}</span></div>` : ""}</div>`;
    const pend = list.filter((t) => t.status === "PendingApproval");
    view.innerHTML = `<div class="section-title">รออนุมัติ (${pend.length})</div>${pend.map((t) => card(t, true)).join("") || '<div class="cl-empty">ไม่มี</div>'}
      <div class="section-title">ประวัติ</div>${list.filter((t) => t.status !== "PendingApproval").map((t) => card(t, false)).join("") || '<div class="cl-empty">ยังไม่มี</div>'}`;
    view.onclick = async (e) => {
      const b = e.target.closest("[data-tact]");
      if (!b) return;
      if (b.dataset.tact === "approve" && !window.confirm("ยืนยันอนุมัติและส่งคำสั่งโอนไปธนาคาร?")) return;
      const r = await CL.act(b, () => CL.post(`/coop-lending/transfers/${b.closest("[data-tr]").dataset.tr}/${b.dataset.tact}`),
        (t) => (t.status === "Succeeded" ? `โอนสำเร็จ อ้างอิง ${t.bank_ref}` : t.status === "Failed" ? `ธนาคารแจ้งโอนไม่สำเร็จ: ${t.failure_reason}` : "ยกเลิกแล้ว"));
      if (r) refresh();
    };
  }

  // ----- วงเงิน & ชำระคืน ----------------------------------------------------
  async function renderFacilities() {
    const ded = own(["loan_dedicated"]);
    view.innerHTML = facilities.map((f) => `<div class="cl-card" data-fac="${f.facility_id}">
      <div class="cl-row"><div><b>${esc(f.lender_name)}</b> · ${esc(f.program_name)} · ${Number(f.rate_pct)}% ต่อปี</div><div>${f.status === "Active" ? pill(["ใช้งาน", "#1f6b38", "#ddf3e4"]) : pill(["ระงับ", "#a1261d", "#fde8e6"])}</div></div>
      ${f.suspended_reason ? `<div class="cl-flag">${esc(f.suspended_reason)}</div>` : ""}
      <div class="cl-line">วงเงิน ${baht(f.limit_amount)} · คงเหลือ <b>${baht(f.available)}</b> · เงินต้นค้าง ${baht(f.outstanding)} · สินเชื่อเครื่องจักร ${baht(f.asset_committed)} · เบิกได้ถึง ${esc(date(f.available_until))} · คืนภายใน ${f.tranche_tenor_days} วันต่อรายการ</div>
      <div class="cl-actions cl-inline">บัญชีเฉพาะเงินกู้:
        ${ded.length ? `<select class="ded">${ded.map((a) => `<option value="${a.account_id}" ${a.account_id === f.dedicated_account_id ? "selected" : ""}>${esc(CL.accLabel(a))}</option>`).join("")}</select>` : '<span class="cl-late">ยังไม่มี — เพิ่มที่แท็บบัญชีธนาคาร</span>'}
        ดอกเบี้ยที่สหกรณ์คิดกับสมาชิก (% ต่อปี) <input type="number" class="mrate" step="0.01" min="0" max="30" value="${f.member_rate_pct ?? ""}" style="min-width:90px">
        <button class="cl-btn ghost" data-fact="save">บันทึก</button>
        <button class="cl-btn blue" data-fact="debt">ดูยอดหนี้ & ชำระคืน</button></div>
      <div class="debt"></div></div>`).join("") || '<div class="cl-empty">ยังไม่มีวงเงิน — ยื่นขอกู้ที่แท็บ "ขอกู้"</div>';
    view.onclick = async (e) => {
      const b = e.target.closest("[data-fact]");
      if (!b) return;
      const card = b.closest("[data-fac]");
      const id = card.dataset.fac;
      if (b.dataset.fact === "save") {
        const body = { member_rate_pct: card.querySelector(".mrate").value || null };
        if (card.querySelector(".ded")) body.dedicated_account_id = card.querySelector(".ded").value;
        if (await CL.act(b, () => CL.patch(`/coop-lending/facilities/${id}`, body), "บันทึกแล้ว")) render();
      } else if (b.dataset.fact === "debt") {
        const d = await CL.act(b, () => CL.get(`/coop-lending/facilities/${id}/debt`));
        if (!d) return;
        card.querySelector(".debt").innerHTML = `<table class="cl-table" style="margin-top:10px"><tr><th>รายการ</th><th>ครบกำหนด</th><th class="r">เงินต้น</th><th class="r">ดอกเบี้ยถึงวันนี้</th></tr>
          ${d.items.map((x) => `<tr><td>${esc(x.description)}</td><td class="${x.overdue ? "cl-late" : ""}">${esc(date(x.loan_due_date))}${x.overdue ? " (เลยกำหนด — ดอกเบี้ยผิดนัด)" : ""}</td><td class="r">${CL.num(x.principal)}</td><td class="r">${CL.num(x.interest)}</td></tr>`).join("") || '<tr><td colspan="4" class="cl-empty">ไม่มีหนี้คงค้าง</td></tr>'}
          <tr><th colspan="2">รวม ณ ${esc(date(d.as_of))}</th><th class="r">${CL.num(d.principal)}</th><th class="r">${CL.num(d.interest)}</th></tr></table>
          ${d.total > 0 ? `<div class="cl-actions cl-inline">ชำระ <input type="number" class="ramt" value="${d.total}" min="1" max="${d.total}" step="0.01"> บาท จากบัญชี ${accSel("rfrom", ["operating", "loan_dedicated"])}
            <button class="cl-btn" data-fact="repay">เตรียมชำระคืน</button><span class="cl-muted">ตัดดอกเบี้ยค้างก่อน แล้วเงินต้นรายการที่ครบกำหนดก่อน</span></div>` : ""}`;
      } else if (b.dataset.fact === "repay") {
        const r = await CL.act(b, () => CL.post("/coop-lending/transfers/prepare-repayment", { facility_id: id, amount: card.querySelector(".ramt").value, from_account_id: card.querySelector('[name="rfrom"]').value }),
          "เตรียมชำระแล้ว — รอผู้อนุมัติอีกคนในแท็บคำสั่งโอน");
        if (r) refresh();
      }
    };
  }

  // ----- สินเชื่อเครื่องจักร -------------------------------------------------
  async function renderAssets() {
    const list = await CL.get("/coop-lending/asset-loans");
    const af = facilities.filter((f) => f.status === "Active" && f.purposes.includes("asset"));
    await (members ? Promise.resolve() : CL.get("/coop-lending/members").then((m) => { members = m; }));
    const ST = { Submitted: ["รอสหกรณ์ออมทรัพย์พิจารณา", "#8a5a00", "#fff2cc"], Approved: ["อนุมัติ — สร้างรายการเบิกพร้อมหลักฐานการซื้อ", "#0b5394", "#e3eefb"], Active: ["ผ่อนชำระอยู่", "#6a1b9a", "#f3e5f5"], Closed: ["ผ่อนครบแล้ว", "#1f6b38", "#ddf3e4"], Rejected: ["ปฏิเสธ", "#a1261d", "#fde8e6"], Cancelled: ["ยกเลิก", "#6b7a70", "#eef1ee"] };
    view.innerHTML = `
      <div class="cl-card"><h3>ขอสินเชื่อซื้อเครื่องจักร/อุปกรณ์</h3>
        <div class="cl-muted">โอนเงินตรงถึงผู้ขายเมื่อมีสัญญาซื้อขาย หลักฐานจ่ายเงินดาวน์ ภาพเลขเครื่อง และใบกำกับภาษีครบ · ค่างวดต้องไม่เกินสัดส่วนรายได้ที่โครงการกำหนด</div>
        ${af.length ? `<form id="assetForm" class="cl-form" style="margin-top:10px">
          <div><label>วงเงิน</label><select name="facility_id">${af.map((f) => `<option value="${f.facility_id}">${esc(f.lender_name)} (ดาวน์ขั้นต่ำ ${Number(f.asset_min_down_pct)}%, สูงสุด ${f.asset_max_months} เดือน, ค่างวด ≤ ${Number(f.asset_max_income_ratio_pct)}% ของรายได้)</option>`).join("")}</select></div>
          <div><label>ผู้ซื้อ</label><select name="buyer_type"><option value="cooperative">สหกรณ์ (ศูนย์บริการ)</option><option value="member">สมาชิกซื้อผ่านสหกรณ์</option></select></div>
          <div><label>สมาชิก (ถ้าสมาชิกซื้อ)</label><select name="farmer_id"><option value="">—</option>${members.map((m) => `<option value="${m.farmer_id}">${esc(m.full_name)}</option>`).join("")}</select></div>
          <div><label>ประเภท</label><input name="asset_kind" required placeholder="รถแทรกเตอร์ / ถังทำความเย็นนม"></div>
          <div><label>ยี่ห้อ/รุ่น</label><input name="brand_model" required></div>
          <div><label>ผู้ขาย (ค้นชื่อ)</label><input id="aSellerQ" placeholder="พิมพ์ชื่อ"><select name="seller_org_id" id="aSellerSel" required></select></div>
          <div><label>เลขใบเสนอราคา</label><input name="quotation_no"></div>
          <div><label>เลขเครื่อง/เลขตัวถัง (ถ้าทราบ)</label><input name="serial_no"></div>
          <div><label>ราคา (บาท)</label><input name="price" type="number" min="1000" step="0.01" required></div>
          <div><label>เงินดาวน์ (บาท)</label><input name="down_payment" type="number" min="0" step="0.01" required></div>
          <div><label>ระยะผ่อน (เดือน)</label><input name="term_months" type="number" min="3" max="120" value="36" required></div>
          <div><label>ผ่อนทุก</label><select name="interval_months"><option value="1">1 เดือน (ค่านม)</option><option value="3">3 เดือน</option><option value="6" selected>6 เดือน (หลังเก็บเกี่ยว)</option><option value="12">12 เดือน</option></select></div>
          <div><label>ปลอดเงินต้น (งวด)</label><input name="grace_periods" type="number" min="0" max="4" value="0"></div>
          <div><label>รายได้ที่ใช้จ่ายค่างวด ต่องวด (บาท)</label><input name="income_per_period" type="number" min="1" step="0.01" required></div>
          <div class="wide"><label>ที่มาของรายได้ (เช่น รับจ้างไถ 1,500 ไร่/ฤดู × 150 บาท หรือค่านมเฉลี่ย 12 เดือน)</label><input name="income_basis" required></div>
          <div><button class="cl-btn ghost" type="button" id="previewBtn">คำนวณตารางผ่อน</button> <button class="cl-btn" type="submit">ยื่นขอสินเชื่อ</button></div>
          <div class="wide" id="previewBox"></div>
        </form>` : '<div class="cl-muted">ยังไม่มีวงเงินที่รับวัตถุประสงค์ "ซื้อเครื่องจักร/อุปกรณ์"</div>'}
      </div>
      ${list.map((a) => `<div class="cl-card" data-asset="${a.asset_loan_id}">
        <div class="cl-row"><div><b>${esc(a.asset_kind)} ${esc(a.brand_model)}</b> · ${esc(a.seller_name)}${a.farmer_name ? ` · สมาชิก ${esc(a.farmer_name)}` : ""}</div><div>${pill(ST[a.status])}</div></div>
        <div class="cl-line">กู้ ${baht(a.loan_amount)} · ${Number(a.rate_pct)}% · ${a.term_months} เดือน · ค่างวด ${baht(a.installment)} (${Number(a.income_ratio_pct)}% ของรายได้) · ผู้ให้กู้ ${esc(a.lender_name)}</div>
        ${a.decided_reason ? `<div class="cl-flag">${esc(a.decided_reason)}</div>` : ""}
        ${a.status === "Approved" ? '<div class="cl-line">➡️ ไปที่แท็บ "รายการเบิก" → วัตถุประสงค์ "ซื้อเครื่องจักร/อุปกรณ์" เพื่อแนบหลักฐานการซื้อ</div>' : ""}
        ${a.due && a.due.length ? `<table class="cl-table"><tr><th>งวด</th><th>ครบกำหนด</th><th class="r">ค่างวด</th><th class="r">ชำระแล้ว</th><th class="r">ดอกเบี้ยผิดนัด</th></tr>${a.due.map((d) => `<tr><td>${d.seq}</td><td class="${d.overdue ? "cl-late" : ""}">${esc(date(d.due_date))}</td><td class="r">${CL.num(d.installment)}</td><td class="r">${CL.num(d.paid_amount)}</td><td class="r">${d.penalty ? CL.num(d.penalty) : "-"}</td></tr>`).join("")}</table>` : ""}
        ${a.status === "Active" ? `<div class="cl-actions cl-inline">ชำระ <input type="number" class="iamt" value="${a.due_now || ""}" step="0.01" min="1"> บาท จากบัญชี ${accSel("ifrom", ["operating", "loan_dedicated"])}<button class="cl-btn" data-xact="pay">เตรียมชำระค่างวด</button></div>` : ""}
      </div>`).join("")}`;
    const form = document.getElementById("assetForm");
    if (form) {
      const q = document.getElementById("aSellerQ"); const sel = document.getElementById("aSellerSel");
      let timer;
      q.oninput = () => { clearTimeout(timer); timer = setTimeout(async () => { const l = await CL.get(`/coop-lending/sellers?q=${encodeURIComponent(q.value)}`); sel.innerHTML = l.map((o) => `<option value="${o.org_id}">${esc(o.org_name)}</option>`).join(""); }, 300); };
      const body = () => { const d = CL.formData(form); Object.keys(d).forEach((k) => { if (d[k] === "") delete d[k]; }); return d; };
      document.getElementById("previewBtn").onclick = async (e) => {
        const p = await CL.act(e.target, () => CL.post("/coop-lending/asset-loans/preview", body()));
        if (!p) return;
        document.getElementById("previewBox").innerHTML = `<div class="${p.ok ? "" : "cl-flag"}">กู้ ${baht(p.loan_amount)} · ${Number(p.rate_pct)}% · ค่างวดสูงสุด <b>${baht(p.installment)}</b> = <b>${Number(p.ratio_pct)}%</b> ของรายได้ (เกณฑ์ ≤ ${Number(p.max_ratio_pct)}%) ${p.ok ? "✅ ผ่าน" : "❌ เกินเกณฑ์ — เพิ่มดาวน์ ยืดระยะ หรือเลือกเครื่องที่ถูกลง"} · ดอกเบี้ยรวม ${baht(p.total_interest)}</div>
          <table class="cl-table"><tr><th>งวด</th><th>ครบกำหนด (ถ้าโอนวันนี้)</th><th class="r">เงินต้น</th><th class="r">ดอกเบี้ย</th><th class="r">ค่างวด</th><th class="r">คงเหลือ</th></tr>
          ${p.schedule.map((r) => `<tr><td>${r.seq}</td><td>${esc(date(r.due_date))}</td><td class="r">${CL.num(r.principal)}</td><td class="r">${CL.num(r.interest)}</td><td class="r">${CL.num(r.installment)}</td><td class="r">${CL.num(r.balance)}</td></tr>`).join("")}</table>`;
      };
      form.onsubmit = async (e) => {
        e.preventDefault();
        const r = await CL.act(e.submitter, () => CL.post("/coop-lending/asset-loans", body()), "ยื่นแล้ว — รอสหกรณ์ออมทรัพย์พิจารณา");
        if (r) render();
      };
    }
    view.onclick = async (e) => {
      const b = e.target.closest("[data-xact]");
      if (!b) return;
      const card = b.closest("[data-asset]");
      const r = await CL.act(b, () => CL.post("/coop-lending/transfers/prepare-installment", { asset_loan_id: card.dataset.asset, amount: card.querySelector(".iamt").value, from_account_id: card.querySelector('[name="ifrom"]').value }),
        "เตรียมชำระแล้ว — รอผู้อนุมัติอีกคนในแท็บคำสั่งโอน");
      if (r) refresh();
    };
  }

  // ----- ขอกู้ -----------------------------------------------------------------
  async function renderPrograms() {
    const [progs, apps] = await Promise.all([CL.get("/coop-lending/programs"), CL.get("/coop-lending/applications")]);
    const AST = { Submitted: ["รอพิจารณา", "#8a5a00", "#fff2cc"], Approved: ["อนุมัติแล้ว", "#1f6b38", "#ddf3e4"], Rejected: ["ปฏิเสธ", "#a1261d", "#fde8e6"], Withdrawn: ["ถอนแล้ว", "#6b7a70", "#eef1ee"] };
    view.innerHTML = `<div class="section-title">โครงการที่เปิดรับ</div>
      ${progs.map((p) => `<div class="cl-card" data-prog="${p.program_id}">
        <div class="cl-row"><div><b>${esc(p.name)}</b> · ${esc(p.lender_name)}</div><div><b>${Number(p.rate_pct)}%</b> ต่อปี</div></div>
        <div class="cl-line">${p.purposes.map((x) => esc(CL.PURPOSE[x])).join(", ")} · เพดานต่อสหกรณ์ ${baht(p.per_borrower_limit)} · วงเงินโครงการคงเหลือ ${baht(p.available)} · คืนภายใน ${p.tranche_tenor_days} วันต่อรายการ</div>
        ${p.conditions ? `<div class="cl-line cl-muted">${esc(p.conditions)}</div>` : ""}
        ${p.my_status === "Submitted" ? '<div class="cl-line">⏳ ยื่นแล้ว รอพิจารณา</div>' : `<form class="cl-form applyForm" style="margin-top:10px">
          <div><label>วงเงินที่ขอ (บาท)</label><input name="requested_amount" type="number" min="1000" step="1000" required></div>
          <div><label>จำนวนสมาชิกที่จะใช้</label><input name="member_count" type="number" min="0"></div>
          ${p.purposes.map((x) => `<div><label>แผนใช้เงิน: ${esc(CL.PURPOSE[x])}</label><input name="pa_${x}" type="number" min="0" step="1000"></div>`).join("")}
          <div class="wide"><label>แผนการใช้เงินรายเดือนและแหล่งชำระคืน</label><textarea name="plan_note" rows="2"></textarea></div>
          <div><button class="cl-btn" type="submit">ยื่นขอกู้</button></div></form>`}
      </div>`).join("") || '<div class="cl-empty">ยังไม่มีโครงการที่เปิดรับในพื้นที่ของท่าน</div>'}
      <div class="section-title">คำขอของสหกรณ์</div>
      ${apps.map((a) => `<div class="cl-card" data-app="${a.application_id}"><div class="cl-row"><div>${esc(a.program_name)} · ${esc(a.lender_name)} · ${baht(a.requested_amount)}</div><div>${pill(AST[a.status])}</div></div>
        ${a.decided_reason ? `<div class="cl-line cl-muted">${esc(a.decided_reason)}</div>` : ""}${a.status === "Submitted" ? '<div class="cl-actions"><button class="cl-btn ghost" data-wd="1">ถอนคำขอ</button></div>' : ""}</div>`).join("") || '<div class="cl-empty">ยังไม่มี</div>'}`;
    view.querySelectorAll(".applyForm").forEach((form) => {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const d = CL.formData(form);
        const pa = {};
        Object.keys(d).filter((k) => k.startsWith("pa_")).forEach((k) => { if (d[k]) pa[k.slice(3)] = d[k]; delete d[k]; });
        const r = await CL.act(e.submitter, () => CL.post("/coop-lending/applications", { ...d, purpose_amounts: pa, program_id: form.closest("[data-prog]").dataset.prog }), "ยื่นคำขอแล้ว");
        if (r) render();
      };
    });
    view.onclick = async (e) => {
      const b = e.target.closest("[data-wd]");
      if (!b) return;
      if (await CL.act(b, () => CL.post(`/coop-lending/applications/${b.closest("[data-app]").dataset.app}/withdraw`), "ถอนแล้ว")) render();
    };
  }

  // ----- บัญชีธนาคาร -------------------------------------------------------------
  async function renderAccounts() {
    const mine = accounts.filter((a) => a.owner_type === "organization" && a.owner_id === ov.org.org_id);
    const payouts = accounts.filter((a) => a.purpose === "payout");
    await (members ? Promise.resolve() : CL.get("/coop-lending/members").then((m) => { members = m; }));
    const row = (a) => `<tr><td>${esc(CL.accLabel(a))}</td><td>${{ operating: "บัญชีดำเนินงาน", loan_dedicated: "บัญชีเฉพาะเงินกู้", payout: `รับเงินของ ${esc(a.owner_name || "")}` }[a.purpose]}</td><td>${a.verification_status === "Verified" ? "✅ ตรวจแล้ว" : `<span class="cl-late">ไม่ผ่าน</span> <span class="cl-muted">${esc(a.verification_note || "")}</span>`}</td></tr>`;
    view.innerHTML = `
      <div class="cl-card"><h3>บัญชีของสหกรณ์</h3>
        <div class="cl-muted">ต้องมี <b>บัญชีเฉพาะเงินกู้</b> (แยกจากบัญชีดำเนินงาน) เพื่อรับเงินจากสหกรณ์ออมทรัพย์และจ่ายต่อให้ผู้ขาย — ชื่อบัญชีต้องตรงกับ "${esc(ov.org.org_name)}"</div>
        <table class="cl-table">${mine.map(row).join("") || '<tr><td class="cl-empty">ยังไม่มี</td></tr>'}</table>
        <form id="ownAcc" class="cl-form" style="margin-top:10px">
          <div><label>ประเภท</label><select name="purpose"><option value="loan_dedicated">บัญชีเฉพาะเงินกู้</option><option value="operating">บัญชีดำเนินงาน (ใช้ชำระคืน)</option></select></div>
          <div><label>ธนาคาร</label><select name="bank_code">${CL.bankOptions()}</select></div>
          <div><label>เลขที่บัญชี</label><input name="account_no" required inputmode="numeric"></div>
          <div><label>ชื่อบัญชี</label><input name="account_name" required value="${esc(ov.org.org_name)}"></div>
          <div><button class="cl-btn" type="submit">เพิ่มและตรวจบัญชี</button></div></form></div>
      <div class="cl-card"><h3>บัญชีรับเงินของผู้ขาย</h3>
        <div class="cl-muted">ระบบโอนให้ผู้ขายได้เฉพาะบัญชีที่ชื่อตรงกับชื่อผู้ขายในระบบ (องค์กรที่ผ่าน KYB หรือสมาชิกที่ยืนยันแล้วกรณีรับซื้อผลผลิต)</div>
        <table class="cl-table">${payouts.map(row).join("") || '<tr><td class="cl-empty">ยังไม่มี</td></tr>'}</table>
        <form id="payAcc" class="cl-form" style="margin-top:10px">
          <div><label>ผู้ขายเป็น</label><select name="seller_type"><option value="organization">องค์กร/ร้านค้า</option><option value="farmer">เกษตรกรสมาชิก (ขายผลผลิต)</option></select></div>
          <div id="payWho"></div>
          <div><label>ธนาคาร</label><select name="bank_code">${CL.bankOptions()}</select></div>
          <div><label>เลขที่บัญชี</label><input name="account_no" required inputmode="numeric"></div>
          <div><label>ชื่อบัญชี</label><input name="account_name" required></div>
          <div><button class="cl-btn" type="submit">เพิ่มและตรวจบัญชี</button></div></form></div>`;
    document.getElementById("ownAcc").onsubmit = async (e) => {
      e.preventDefault();
      if (await CL.act(e.submitter, () => CL.post("/coop-lending/bank-accounts", CL.formData(e.target)), (a) => (a.verification_status === "Verified" ? "ตรวจบัญชีผ่าน" : `ไม่ผ่าน: ${a.verification_note}`))) render();
    };
    const pf = document.getElementById("payAcc");
    const who = document.getElementById("payWho");
    const fillWho = () => {
      if (pf.seller_type.value === "farmer") {
        who.innerHTML = `<label>สมาชิก</label><select name="seller_id">${members.map((m) => `<option value="${m.farmer_id}" data-name="${esc(m.full_name)}">${esc(m.full_name)}</option>`).join("")}</select>`;
      } else {
        who.innerHTML = '<label>ผู้ขาย (ค้นชื่อ)</label><input id="pq" placeholder="พิมพ์ชื่อ"><select name="seller_id" id="psel"></select>';
        let timer;
        document.getElementById("pq").oninput = (e) => { clearTimeout(timer); timer = setTimeout(async () => { const l = await CL.get(`/coop-lending/sellers?q=${encodeURIComponent(e.target.value)}`); document.getElementById("psel").innerHTML = l.map((o) => `<option value="${o.org_id}" data-name="${esc(o.org_name)}">${esc(o.org_name)}</option>`).join(""); document.getElementById("psel").onchange(); }, 300); };
      }
      const s = who.querySelector("select");
      s.onchange = () => { const o = s.selectedOptions[0]; if (o) pf.account_name.value = o.dataset.name; };
      s.onchange();
    };
    pf.seller_type.onchange = fillWho;
    fillWho();
    pf.onsubmit = async (e) => {
      e.preventDefault();
      if (await CL.act(e.submitter, () => CL.post("/coop-lending/payout-accounts", CL.formData(pf)), (a) => (a.verification_status === "Verified" ? "ตรวจบัญชีผ่าน" : `ไม่ผ่าน: ${a.verification_note}`))) render();
    };
  }

  async function renderNotices() {
    const list = await CL.get("/coop-lending/notices");
    view.innerHTML = `<div class="cl-card"><h3>การทวงถาม/แจ้งเตือน</h3>${list.map((n) => `<div class="cl-line" style="padding:6px 0;border-bottom:1px solid #eef1ee">${n.read_at ? "" : "🔴 "}${esc(date(n.notice_date))} · ${esc(n.message)}</div>`).join("") || '<div class="cl-empty">ไม่มีการทวงถาม</div>'}</div>`;
    if (list.some((n) => !n.read_at)) { await CL.post("/coop-lending/notices/read"); loadOverview(); }
  }

  (async () => {
    try {
      await loadOverview();
      await render();
    } catch (err) {
      view.innerHTML = `<div class="cl-card cl-late">โหลดข้อมูลไม่สำเร็จ: ${esc(CL.errText(err))}${err.message === "wrong_org_type" ? " — หน้านี้สำหรับสหกรณ์การเกษตรเท่านั้น" : ""}</div>`;
    }
  })();
}());
