/**
 * AgroLink — เกษตรกรยืนยันรายการเบิกเงินกู้ของสหกรณ์ (สินเชื่อระหว่างสหกรณ์)
 *
 * สหกรณ์ขอเบิกเงินกู้จากสหกรณ์ออมทรัพย์เพื่อจ่ายค่าปัจจัย/ค่าบริการ/ค่าผลผลิตแทนสมาชิก —
 * เงินจะออกได้ต่อเมื่อเกษตรกร "ยืนยันจากบัญชีของตนเอง" ว่าได้รับของ/งานเสร็จ/ขายผลผลิตจริง
 * (เจ้าหน้าที่สหกรณ์กดแทนไม่ได้) หรือกด "ไม่ตรง" เพื่อหยุดรายการ
 * Backend: GET/POST /farmer-lending/items (backend/src/routes/coopLending.js)
 * วาง <div id="coopLendingFarmerWidget"></div> แล้วโหลดหลัง js/api.js — ซ่อนตัวเองถ้าไม่มีรายการ
 */
/* global AgroLinkAPI, API_BASE */
(function () {
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const baht = (n) => `${Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`;
  const PURPOSE = { inputs: "ปัจจัยการผลิต", machinery_service: "ค่าบริการเครื่องจักร", procurement: "ขายผลผลิตให้สหกรณ์", asset: "ซื้อเครื่องจักร/อุปกรณ์" };
  const ST = { Draft: "สหกรณ์กำลังเตรียม", EvidencePending: "รอท่านยืนยัน", EvidenceComplete: "รอโอนเงิน", Funded: "เงินเข้าสหกรณ์แล้ว รอจ่ายผู้ขาย", Paid: "จ่ายผู้ขายแล้ว", Rejected: "ไม่อนุมัติ", Disputed: "ท่านแจ้งว่าไม่ตรง" };
  async function call(method, path, body) {
    const s = AgroLinkAPI.getSession();
    const res = await fetch(`${API_BASE}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${s && s.access_token}` }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `request_failed_${res.status}`);
    return j;
  }
  function init() {
    const mount = document.getElementById("coopLendingFarmerWidget");
    if (!mount || typeof AgroLinkAPI === "undefined") return;
    async function load() {
      let rows;
      try { rows = await call("GET", "/farmer-lending/items"); } catch (e) { mount.innerHTML = ""; return; }
      if (!rows.length) { mount.innerHTML = ""; return; }
      const waiting = rows.filter((r) => r.status === "EvidencePending" && !r.farmer_confirmed_at);
      const card = (r) => {
        const ask = r.status === "EvidencePending" && !r.farmer_confirmed_at;
        const what = r.i_am_seller ? `ท่านขายผลผลิตให้ ${esc(r.coop_name)}` : `${esc(r.seller_name)} ${r.purpose === "machinery_service" ? "ให้บริการท่าน" : "ส่งของให้ท่าน"}`;
        return `<div class="panel" data-cli="${r.item_id}" style="margin-bottom:10px;${ask ? "border:2px solid #f0b429;" : ""}">
          <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>${esc(r.description)}</b><span style="font-size:12.5px;font-weight:700">${esc(ST[r.status] || r.status)}</span></div>
          <div style="font-size:13.5px;margin-top:4px">${esc(PURPOSE[r.purpose])} · ${what} · <b>${baht(r.amount)}</b>${r.doc_no ? ` · เอกสาร ${esc(r.doc_no)}` : ""}${r.service_area_rai ? ` · ${r.service_area_rai} ไร่` : ""}</div>
          ${!r.i_am_seller && r.member_rate_pct != null ? `<div style="font-size:12.5px;color:var(--gray-500);margin-top:2px">เป็นหนี้กับ ${esc(r.coop_name)} อัตราดอกเบี้ย ${Number(r.member_rate_pct)}% ต่อปี (ตามที่สหกรณ์กำหนด)</div>` : ""}
          ${ask ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center">
            <button type="button" class="btn btn-primary btn-sm" data-cla="confirm" style="width:auto">✅ ${r.i_am_seller ? "ยืนยันน้ำหนักและราคาถูกต้อง" : r.purpose === "machinery_service" ? "ยืนยันว่างานเสร็จจริง" : "ยืนยันว่าได้รับของครบ"}</button>
            <input class="cl-reason" placeholder="ถ้าไม่ตรง บอกเหตุผล" style="padding:7px 9px;border:1px solid #d7ddd8;border-radius:8px;min-width:200px">
            <button type="button" class="btn btn-ghost btn-sm" data-cla="dispute" style="width:auto">❌ ไม่ตรง</button>
            <span class="cl-msg" style="font-size:13px"></span></div>` : ""}
        </div>`;
      };
      mount.innerHTML = `<div class="section-title">🏦 รายการเงินกู้ของสหกรณ์ที่เกี่ยวกับท่าน${waiting.length ? ` <span style="background:#f0b429;border-radius:20px;padding:1px 9px;font-size:12px">${waiting.length} รอยืนยัน</span>` : ""}</div>
        <p style="font-size:13px;color:var(--gray-500);margin:-10px 0 12px">สหกรณ์จ่ายเงินให้ผู้ขายแทนท่านด้วยเงินกู้จากสหกรณ์ออมทรัพย์ — เงินจะออกต่อเมื่อท่านยืนยันว่าเป็นความจริงเท่านั้น</p>
        ${rows.slice(0, 20).map(card).join("")}`;
    }
    mount.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-cla]");
      if (!b) return;
      const box = b.closest("[data-cli]");
      const msg = box.querySelector(".cl-msg");
      const reason = box.querySelector(".cl-reason").value.trim();
      if (b.dataset.cla === "dispute" && reason.length < 3) { msg.textContent = "กรุณาบอกเหตุผล"; msg.style.color = "#a1261d"; return; }
      box.querySelectorAll("button").forEach((x) => { x.disabled = true; });
      try {
        await call("POST", `/farmer-lending/items/${box.dataset.cli}/${b.dataset.cla}`, b.dataset.cla === "dispute" ? { reason } : {});
        load();
      } catch (err) {
        msg.textContent = "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง"; msg.style.color = "#a1261d";
        box.querySelectorAll("button").forEach((x) => { x.disabled = false; });
      }
    });
    load();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
}());
