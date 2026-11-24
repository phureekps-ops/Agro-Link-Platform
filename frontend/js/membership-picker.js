/**
 * AgroLink — ตัวเลือก "เป็นสมาชิกสหกรณ์/หน่วยงาน" (ใช้ในหน้าสมัคร register.html และหน้า สมาชิกภาพของฉัน)
 *
 * ค้นหาหน่วยงานจาก GET /auth/member-organizations (ไม่ต้อง login — ชื่อ ประเภท จังหวัดเท่านั้น)
 * เลือกได้หลายแห่ง (สูงสุด max) ใส่เลขสมาชิกแต่ละแห่ง → value() คืน [{ org_id, member_no }]
 * หน่วยงานต้องยืนยันก่อนจึงจะเป็นสมาชิกจริง (backend/src/lib/membershipClaim.js)
 * ต้องโหลดหลัง js/api.js (ใช้ API_BASE)
 */
/* global API_BASE */
const MembershipPicker = (() => {
  const TYPES = [
    ["", "ทุกประเภท"], ["Cooperative", "สหกรณ์"], ["AgriCommunityEnterprise", "วิสาหกิจชุมชน"], ["VillageFund", "กองทุนหมู่บ้าน"],
    ["FarmerAidFund", "กองทุนช่วยเหลือเกษตรกร"], ["Bank", "ธนาคาร"], ["Lender", "ผู้ให้สินเชื่อ"],
  ];
  const TYPE_TH = Object.fromEntries(TYPES.filter(([k]) => k));
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  /* global TH_PROVINCES */
  const provName = (code) => {
    if (!code || typeof TH_PROVINCES === "undefined") return "";
    const hit = TH_PROVINCES.find(([k]) => k === code);
    return hit ? hit[1] : "";
  };
  let styled = false;
  function style() {
    if (styled) return;
    styled = true;
    const s = document.createElement("style");
    s.textContent = `
      .mp-pick input, .mp-pick select { padding:10px 12px; border:1px solid var(--gray-300,#d7ddd8); border-radius:10px; font:inherit; font-size:14.5px; background:var(--gray-50,#f7f8f7); box-sizing:border-box; }
      .mp-pick .mp-row { display:flex; gap:8px; flex-wrap:wrap; }
      .mp-pick .mp-row input { flex:1 1 180px; } .mp-pick .mp-row select { flex:0 1 170px; }
      .mp-pick .mp-hits { border:1px solid var(--gray-300,#d7ddd8); border-radius:10px; margin-top:6px; max-height:220px; overflow:auto; background:#fff; }
      .mp-pick .mp-hits:empty { display:none; }
      .mp-pick .mp-hit { display:block; width:100%; text-align:left; border:0; border-bottom:1px solid var(--gray-100,#eef1ee); background:#fff; padding:9px 11px; font:inherit; font-size:14px; cursor:pointer; }
      .mp-pick .mp-hit:hover { background:var(--green-50,#f1f8f3); } .mp-pick .mp-hit small { color:var(--gray-500,#8a938a); }
      .mp-pick .mp-sel { margin-top:10px; display:flex; flex-direction:column; gap:8px; }
      .mp-pick .mp-item { border:1px solid var(--green-200,#cfe8d6); background:var(--green-50,#f1f8f3); border-radius:10px; padding:9px 11px; }
      .mp-pick .mp-item-top { display:flex; justify-content:space-between; gap:8px; align-items:center; font-weight:600; font-size:14px; }
      .mp-pick .mp-item input { margin-top:6px; width:100%; box-sizing:border-box; }
      .mp-pick .mp-x { border:0; background:none; color:#a1261d; font:inherit; font-size:13px; cursor:pointer; }
      .mp-pick .mp-note { font-size:12.5px; color:var(--gray-500,#8a938a); margin-top:6px; }`;
    document.head.appendChild(s);
  }

  function mount(el, opts = {}) {
    style();
    const max = opts.max || 5;
    const getProvince = opts.getProvince || (() => "");  // รหัส ISO เช่น TH-30 (จาก TH_PROVINCES)
    const exclude = opts.exclude || (() => []);
    const chosen = [];
    el.classList.add("mp-pick");
    el.innerHTML = `
      <div class="mp-row"><input type="text" class="mp-q" placeholder="พิมพ์ชื่อหน่วยงาน เช่น สหกรณ์การเกษตร…" autocomplete="off">
        <select class="mp-type">${TYPES.map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
      <div class="mp-hits"></div><div class="mp-sel"></div>
      <div class="mp-note">หน่วยงานจะตรวจกับทะเบียนสมาชิกก่อนยืนยัน — ไม่พบหน่วยงานของท่าน แสดงว่ายังไม่ได้ลงทะเบียนในแพลตฟอร์ม</div>`;
    const q = el.querySelector(".mp-q");
    const type = el.querySelector(".mp-type");
    const hits = el.querySelector(".mp-hits");
    const sel = el.querySelector(".mp-sel");
    let timer = null;
    let seq = 0;

    function renderSel() {
      sel.innerHTML = chosen.map((c, i) => `<div class="mp-item"><div class="mp-item-top"><span>${esc(c.org_name)} <small style="font-weight:400">(${esc(TYPE_TH[c.org_type] || c.org_type)})</small></span>
        <button type="button" class="mp-x" data-rm="${i}">ลบ</button></div>
        <input type="text" maxlength="40" data-no="${i}" value="${esc(c.member_no)}" placeholder="เลขทะเบียนสมาชิก/เลขลูกค้า (ถ้ามี)"></div>`).join("");
    }
    async function search() {
      const text = q.value.trim();
      const province = getProvince();
      if (text.length < 2 && !province) { hits.innerHTML = ""; return; }
      const my = ++seq;
      const params = new URLSearchParams();
      if (text.length >= 2) params.set("q", text);
      else if (province) {
        params.set("province", province);
        const name = provName(province);
        if (name) params.set("province_name", name);
      }
      if (type.value) params.set("type", type.value);
      try {
        const res = await fetch(`${API_BASE}/auth/member-organizations?${params}`);
        const rows = res.ok ? await res.json() : [];
        if (my !== seq) return;
        const skip = new Set([...chosen.map((c) => c.org_id), ...exclude()]);
        const list = rows.filter((r) => !skip.has(r.org_id));
        hits.innerHTML = list.length
          ? list.map((r) => `<button type="button" class="mp-hit" data-org='${esc(JSON.stringify(r))}'>${esc(r.org_name)} <small>· ${esc(TYPE_TH[r.org_type] || r.org_type)}${r.province_name_th || provName(r.region_code) ? ` · ${esc(r.province_name_th || provName(r.region_code))}` : ""}</small></button>`).join("")
          : `<div class="mp-hit" style="cursor:default"><small>ไม่พบหน่วยงาน${text.length < 2 ? "ในจังหวัดนี้ — ลองพิมพ์ชื่อ" : ""}</small></div>`;
      } catch (e) {
        hits.innerHTML = `<div class="mp-hit" style="cursor:default"><small>ค้นหาไม่สำเร็จ ลองใหม่อีกครั้ง</small></div>`;
      }
    }
    const later = () => { clearTimeout(timer); timer = setTimeout(search, 250); };
    q.addEventListener("input", later);
    q.addEventListener("focus", later);
    type.addEventListener("change", search);
    hits.addEventListener("click", (e) => {
      const b = e.target.closest("[data-org]");
      if (!b) return;
      if (chosen.length >= max) { hits.innerHTML = `<div class="mp-hit" style="cursor:default"><small>เลือกได้สูงสุด ${max} หน่วยงาน</small></div>`; return; }
      const r = JSON.parse(b.dataset.org);
      chosen.push({ ...r, member_no: "" });
      q.value = "";
      hits.innerHTML = "";
      renderSel();
      const inp = sel.querySelector(`[data-no="${chosen.length - 1}"]`);
      if (inp) inp.focus();
    });
    sel.addEventListener("click", (e) => {
      const b = e.target.closest("[data-rm]");
      if (!b) return;
      chosen.splice(Number(b.dataset.rm), 1);
      renderSel();
    });
    sel.addEventListener("input", (e) => {
      const i = e.target.dataset.no;
      if (i !== undefined) chosen[Number(i)].member_no = e.target.value;
    });
    return {
      value: () => chosen.map((c) => ({ org_id: c.org_id, member_no: c.member_no.trim() || undefined })),
      names: () => chosen.map((c) => c.org_name),
      clear: () => { chosen.length = 0; renderSel(); hits.innerHTML = ""; q.value = ""; },
      refresh: search,
    };
  }
  return { mount, TYPE_TH };
})();
