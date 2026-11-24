/**
 * AgroLink — คำแจ้งเป็นสมาชิกจากเกษตรกร (Membership Claims Widget)
 *
 * เกษตรกรแจ้งว่าเป็นสมาชิก/ลูกค้าของหน่วยงาน (ตอนสมัคร หรือในหน้า "สมาชิกภาพของฉัน") →
 * หน่วยงานตรวจกับทะเบียนของตนแล้วกด ยืนยัน (ใส่/แก้เลขสมาชิกได้) หรือ ปฏิเสธ (ต้องมีเหตุผล)
 * ยืนยันแล้ว = เพิ่มเข้าทะเบียน "เกษตรกรที่เป็นสมาชิกของฉัน" (Farmer 360°) ทันที
 * Backend: GET/POST /farmer360/membership-claims (backend/src/lib/membershipClaim.js)
 *
 * ใช้ได้ทุกพอร์ทัลหน่วยงาน (สหกรณ์ วิสาหกิจชุมชน กองทุนหมู่บ้าน กองทุนช่วยเหลือเกษตรกร ผู้ให้สินเชื่อ):
 * วาง <div id="membershipClaimsWidget"></div> แล้วโหลดสคริปต์นี้หลัง js/api.js ของพอร์ทัล
 * สไตล์อยู่ในไฟล์นี้เอง (เหมือน group-order-widget.js) เมื่อยืนยันแล้วจะส่ง event
 * "membership-claims:approved" ให้หน้าเดิมโหลดทะเบียนสมาชิกใหม่
 */
(function () {
  function pickApi() {
    /* global AgroLinkCoopAPI, AgroLinkVillageFundAPI, AgroLinkLenderAPI, AgroLinkCommunityEnterpriseAPI, AgroLinkFarmerAidFundAPI */
    if (typeof AgroLinkCoopAPI !== "undefined") return AgroLinkCoopAPI;
    if (typeof AgroLinkVillageFundAPI !== "undefined") return AgroLinkVillageFundAPI;
    if (typeof AgroLinkLenderAPI !== "undefined") return AgroLinkLenderAPI;
    if (typeof AgroLinkCommunityEnterpriseAPI !== "undefined") return AgroLinkCommunityEnterpriseAPI;
    if (typeof AgroLinkFarmerAidFundAPI !== "undefined") return AgroLinkFarmerAidFundAPI;
    return null;
  }
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const d = (v) => (v ? new Date(v).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" }) : "-");
  const ERR = {
    claim_not_found: "ไม่พบคำแจ้งนี้", claim_already_decided: "คำแจ้งนี้ตัดสินแล้ว", claim_not_found_or_decided: "คำแจ้งนี้ตัดสินแล้ว",
    reason_required: "กรุณาระบุเหตุผลที่ปฏิเสธ", field_too_long: "ข้อความยาวเกินไป", kyb_not_verified: "หน่วยงานยังไม่ผ่านการยืนยันตัวตน",
  };
  const SRC = { registration: "แจ้งตอนสมัคร", portal: "แจ้งภายหลัง" };
  const ST = { Pending: ["รอยืนยัน", "#8a5a00", "#fff2cc"], Approved: ["ยืนยันแล้ว", "#1f6b38", "#ddf3e4"], Rejected: ["ปฏิเสธ", "#a1261d", "#fde8e6"], Withdrawn: ["เกษตรกรถอน", "#6b7a70", "#eef1ee"] };

  function init() {
    const mount = document.getElementById("membershipClaimsWidget");
    const api = pickApi();
    if (!mount || !api) return;
    const style = document.createElement("style");
    style.textContent = `
      .mc-panel { background:#fff; border-radius:var(--radius,14px); box-shadow:var(--shadow,0 2px 10px rgba(27,58,31,.08)); padding:18px; margin-bottom:18px; }
      .mc-head { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }
      .mc-head h3 { margin:0; font-size:16px; color:var(--green-900,#1b3a1f); }
      .mc-desc { font-size:13px; color:var(--gray-500,#8a938a); margin:6px 0 12px; }
      .mc-count { background:#f0b429; color:#1b3a1f; border-radius:20px; padding:1px 9px; font-size:12px; font-weight:700; margin-left:6px; }
      .mc-card { border:1px solid var(--gray-100,#eef1ee); border-radius:12px; padding:12px 14px; margin-bottom:10px; }
      .mc-row { display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:center; }
      .mc-name { font-weight:700; font-size:15px; }
      .mc-line { font-size:13px; color:#4a554d; margin-top:3px; }
      .mc-pill { border-radius:20px; padding:2px 9px; font-size:12px; font-weight:700; }
      .mc-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:10px; }
      .mc-actions input { padding:7px 9px; border:1px solid var(--gray-300,#cfd6d0); border-radius:8px; font:inherit; font-size:13.5px; min-width:140px; }
      .mc-btn { border:0; border-radius:8px; padding:7px 13px; font:inherit; font-size:13px; font-weight:700; cursor:pointer; background:var(--green-700,#2c7a45); color:#fff; }
      .mc-btn.ghost { background:var(--gray-100,#eef1ee); color:#1d2b22; } .mc-btn.bad { background:#fde8e6; color:#a1261d; }
      .mc-btn:disabled { opacity:.6; cursor:not-allowed; }
      .mc-msg { font-size:13px; font-weight:600; } .mc-msg.err { color:#a1261d; } .mc-msg.ok { color:#1f6b38; }
      .mc-empty { color:var(--gray-500,#8a938a); font-size:13.5px; padding:6px 0; }`;
    document.head.appendChild(style);
    let showAll = false;

    function card(c) {
      const [t, fg, bg] = ST[c.status] || [c.status, "#333", "#eee"];
      const pending = c.status === "Pending";
      return `<div class="mc-card" data-claim="${esc(c.claim_id)}">
        <div class="mc-row"><span class="mc-name">${esc(c.full_name)} <span style="font-weight:400;color:#6b7a70">${esc(c.farmer_code || "")}</span></span>
          <span class="mc-pill" style="color:${fg};background:${bg}">${t}</span></div>
        <div class="mc-line">โทร ${esc(c.phone || "-")} · พื้นที่ ${esc([c.region_code, c.district_code].filter(Boolean).join(" / ") || "-")} · ${SRC[c.source] || esc(c.source)} ${d(c.created_at)}</div>
        <div class="mc-line">เลขสมาชิกที่เกษตรกรแจ้ง: <b>${esc(c.member_no || "ไม่ได้ระบุ")}</b>${c.farmer_note ? ` · หมายเหตุ: ${esc(c.farmer_note)}` : ""}</div>
        ${c.status === "Rejected" ? `<div class="mc-line">เหตุผลที่ปฏิเสธ: ${esc(c.reject_reason)}</div>` : ""}
        ${pending ? `<div class="mc-actions">
            <input data-f="member_no" placeholder="เลขสมาชิกในทะเบียน" value="${esc(c.member_no || "")}" maxlength="40">
            <button type="button" class="mc-btn" data-act="approve">ยืนยันเป็นสมาชิก</button>
            <input data-f="reason" placeholder="เหตุผล (ถ้าปฏิเสธ)" maxlength="300">
            <button type="button" class="mc-btn bad" data-act="reject">ปฏิเสธ</button>
            <span class="mc-msg"></span></div>` : ""}
      </div>`;
    }

    async function load() {
      let rows;
      try {
        rows = await api.get(`/farmer360/membership-claims${showAll ? "?status=all" : ""}`);
      } catch (err) {
        mount.innerHTML = `<div class="mc-panel"><div class="mc-empty">โหลดคำแจ้งสมาชิกภาพไม่สำเร็จ: ${esc(err.message)}</div></div>`;
        return;
      }
      const pending = rows.filter((r) => r.status === "Pending").length;
      mount.innerHTML = `<div class="mc-panel">
        <div class="mc-head"><h3>📨 คำแจ้งเป็นสมาชิกจากเกษตรกร${pending ? `<span class="mc-count">${pending}</span>` : ""}</h3>
          <button type="button" class="mc-btn ghost" data-act="toggle">${showAll ? "ดูเฉพาะที่รอยืนยัน" : "ดูประวัติทั้งหมด"}</button></div>
        <p class="mc-desc">เกษตรกรแจ้งว่าเป็นสมาชิก/ลูกค้าของหน่วยงานท่าน ตรวจกับทะเบียนของท่านก่อนยืนยัน — ยืนยันแล้วเกษตรกรจะอยู่ในทะเบียน "เกษตรกรที่เป็นสมาชิกของฉัน"
          และใช้เป็นข้อมูลสมาชิกต้นสังกัดของแพลตฟอร์ม (ปฏิเสธต้องระบุเหตุผล เกษตรกรจะเห็นเหตุผลนี้)</p>
        ${rows.length ? rows.map(card).join("") : `<div class="mc-empty">${showAll ? "ยังไม่มีคำแจ้ง" : "ไม่มีคำแจ้งที่รอยืนยัน"}</div>`}
      </div>`;
    }

    mount.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "toggle") { showAll = !showAll; load(); return; }
      const box = btn.closest("[data-claim]");
      const msg = box.querySelector(".mc-msg");
      const id = box.dataset.claim;
      const body = btn.dataset.act === "approve"
        ? { member_no: box.querySelector('[data-f="member_no"]').value.trim() }
        : { reason: box.querySelector('[data-f="reason"]').value.trim() };
      if (btn.dataset.act === "reject" && !body.reason) { msg.className = "mc-msg err"; msg.textContent = ERR.reason_required; return; }
      box.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      try {
        await api.post(`/farmer360/membership-claims/${encodeURIComponent(id)}/${btn.dataset.act}`, body);
        msg.className = "mc-msg ok";
        msg.textContent = btn.dataset.act === "approve" ? "ยืนยันแล้ว" : "ปฏิเสธแล้ว";
        if (btn.dataset.act === "approve") document.dispatchEvent(new CustomEvent("membership-claims:approved"));
        setTimeout(load, 700);
      } catch (err) {
        msg.className = "mc-msg err";
        msg.textContent = ERR[err.message] || err.message;
        box.querySelectorAll("button").forEach((b) => { b.disabled = false; });
      }
    });
    load();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
