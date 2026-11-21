/**
 * แอดมิน › 🥛 ทะเบียนตลาดน้ำนม — AgroLink National Dairy โมดูล 04
 * API: /admin/dairy-directory/* (backend/src/routes/dairydirectory.js)
 * AgroLinkDairyDirectory.mount(host, { api })
 */
(function () {
  "use strict";
  const KIND = { dpo: "อ.ส.ค.", processor: "โรงงาน/ผู้รับซื้อเอกชน", school_milk_operator: "ผู้ประกอบการนมโรงเรียน", cooperative: "สหกรณ์โคนม", collection_center: "ศูนย์รวบรวมน้ำนม", other: "อื่น ๆ" };
  const STATUS = {
    unverified: ["ยังไม่ติดต่อ", "#475467", "#f2f4f7"], contacted: ["ติดต่อแล้ว", "#b54708", "#fef0c7"],
    verified: ["ยืนยันข้อมูลแล้ว", "#175cd3", "#d1e9ff"], onboarded: ["ใช้ AgroLink แล้ว", "#067647", "#dcfae6"],
    not_relevant: ["ไม่เกี่ยวข้อง", "#98a2b3", "#f9fafb"],
  };
  const BUYS = { unknown: "ยังไม่ทราบ", yes: "รับซื้อ", no: "ไม่รับซื้อ" };
  const CH = { phone: "โทรศัพท์", email: "อีเมล", line: "LINE", visit: "ลงพื้นที่", meeting: "ประชุม", other: "อื่น ๆ" };
  const MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const thDate = (v) => { if (!v) return "-"; const [y, m, d] = String(v).slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y + 543}`; };
  const num = (v) => (v == null ? "-" : Number(v).toLocaleString("th-TH"));
  const badge = (s) => { const [t, fg, bg] = STATUS[s] || [s, "#475467", "#f2f4f7"]; return `<span class="dd-badge" style="color:${fg};background:${bg}">${t}</span>`; };
  const opts = (map, sel, blank) => (blank ? `<option value="">${blank}</option>` : "") + Object.entries(map).map(([k, v]) => `<option value="${k}"${k === sel ? " selected" : ""}>${Array.isArray(v) ? v[0] : v}</option>`).join("");

  function css() {
    if (document.getElementById("dd-css")) return;
    const s = document.createElement("style"); s.id = "dd-css";
    s.textContent = `
      .dd-card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);padding:16px 18px;margin-bottom:16px}
      .dd-card h3{margin:0 0 6px;font-size:16px}
      .dd-note{font-size:12.5px;color:#667085;margin:0 0 8px;line-height:1.55}
      .dd-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
      .dd-stat{border:1px solid #eaecf0;border-radius:10px;padding:10px 12px;cursor:pointer}
      .dd-stat b{display:block;font-size:12px;color:#667085;font-weight:600}.dd-stat span{font-size:20px;font-weight:700}
      .dd-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
      .dd-row select,.dd-row input,.dd-form input,.dd-form select,.dd-form textarea{padding:7px 9px;border:1px solid #d0d5dd;border-radius:8px;font:inherit;font-size:13.5px;box-sizing:border-box}
      .dd-btn{border:1px solid #d0d5dd;background:#fff;border-radius:8px;padding:7px 12px;font:inherit;font-size:13px;cursor:pointer}
      .dd-btn.primary{background:#15803d;color:#fff;border-color:transparent}
      .dd-table{width:100%;border-collapse:collapse;font-size:13.5px}
      .dd-table th{text-align:left;font-size:12px;color:#667085;padding:7px 8px;border-bottom:1px solid #d0d5dd;white-space:nowrap}
      .dd-table td{padding:7px 8px;border-bottom:1px solid #f2f4f7;vertical-align:top}
      .dd-table tr.pick{cursor:pointer}.dd-table tr.pick:hover td{background:#ecfdf3}.dd-table tr.on td{background:#fef7e0}
      .dd-table .num{text-align:right}.dd-table td:first-child{white-space:nowrap}
      .dd-scroll{overflow-x:auto;max-height:560px;overflow-y:auto}
      .dd-badge{display:inline-block;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:600;white-space:nowrap}
      .dd-chip{display:inline-block;border-radius:6px;padding:1px 6px;font-size:11.5px;background:#f2f4f7;color:#344054;margin-left:4px}
      .dd-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:8px}
      .dd-form label{display:block;font-size:12px;color:#667085;margin-bottom:3px}
      .dd-form input,.dd-form select,.dd-form textarea{width:100%}
      .dd-form .wide{grid-column:1/-1}
      .dd-sec{font-weight:700;font-size:13.5px;margin:14px 0 6px;color:#1d2939}
      .dd-log{border-left:3px solid #d0d5dd;padding:6px 10px;margin:6px 0;font-size:13.5px}
    `;
    document.head.appendChild(s);
  }

  function mount(host, { api }) {
    css();
    let provinces = []; let rows = []; let selected = null;
    host.innerHTML = `
      <div class="dd-card">
        <p class="dd-note">รายชื่อผู้รับซื้อ อ.ส.ค. ผู้ประกอบการนมโรงเรียน สหกรณ์ และศูนย์รวบรวมน้ำนม สำหรับทีม AgroLink ติดต่อและยืนยันข้อมูล
          ข้อมูลตั้งต้นมาจากประกาศกรมปศุสัตว์และหน้าติดต่อ อ.ส.ค. — <b>รายชื่อในบัญชีนมโรงเรียนยังไม่ยืนยันว่ารับซื้อน้ำนมดิบโดยตรง</b>
          ปริมาณและราคาให้กรอกเมื่อได้จากฝ่ายจัดซื้อเท่านั้น พร้อมระบุแหล่งที่มา สหกรณ์จะเห็นเฉพาะรายที่ "ยืนยันข้อมูลแล้ว" และไม่เห็นปริมาณ ราคา หรือผู้ติดต่อรายบุคคล</p>
        <div class="dd-stats" id="ddStats"></div>
        <div id="ddDue" style="margin-top:10px"></div>
      </div>
      <div class="dd-card">
        <div class="dd-row">
          <input id="ddQ" placeholder="ค้นหาชื่อ/รหัส" style="min-width:200px">
          <select id="ddKind">${opts(KIND, "", "ทุกประเภท")}</select>
          <select id="ddStatus">${opts(STATUS, "", "ทุกสถานะ")}</select>
          <select id="ddProv"><option value="">ทุกจังหวัด</option></select>
          <label style="font-size:13px"><input type="checkbox" id="ddHideDup" checked> ซ่อนรายการที่น่าจะซ้ำ</label>
          <span style="flex:1"></span>
          <button class="dd-btn" id="ddCsv">ดาวน์โหลด CSV</button>
          <button class="dd-btn primary" id="ddNew">+ เพิ่มรายการ</button>
        </div>
        <div id="ddList" class="dd-scroll">กำลังโหลด…</div>
      </div>
      <div class="dd-card" id="ddDetail" style="display:none"></div>
      <div class="dd-card"><details><summary style="cursor:pointer;font-weight:700">🗺️ ความครอบคลุมรายจังหวัด (77 จังหวัด)</summary><div id="ddCov" class="dd-scroll" style="margin-top:10px"></div></details></div>`;
    const $ = (s) => host.querySelector(s);

    async function loadSummary() {
      const s = await api.get("/admin/dairy-directory/summary");
      provinces = s.by_province.slice().sort((a, b) => a.province_name_th.localeCompare(b.province_name_th, "th"));
      const cur = $("#ddProv").value;
      $("#ddProv").innerHTML = `<option value="">ทุกจังหวัด</option><option value="none">ไม่ระบุจังหวัด (${s.without_province})</option>` + provinces.map((p) => `<option value="${p.province_code}">${esc(p.province_name_th)}</option>`).join("");
      $("#ddProv").value = cur;
      const tot = {}; s.by_status.forEach((x) => { tot[x.status] = (tot[x.status] || 0) + x.n; });
      $("#ddStats").innerHTML = Object.keys(STATUS).map((k) => `<div class="dd-stat" data-s="${k}"><b>${STATUS[k][0]}</b><span>${tot[k] || 0}</span></div>`).join("");
      $("#ddStats").querySelectorAll(".dd-stat").forEach((el) => el.addEventListener("click", () => { $("#ddStatus").value = el.dataset.s; loadList(); }));
      $("#ddDue").innerHTML = s.follow_ups_due.length ? `<div class="dd-note"><b>นัดติดตามภายใน 7 วัน:</b> ${s.follow_ups_due.map((d) => `<a href="#" data-id="${d.entry_id}">${esc(d.name)}</a> (${thDate(d.next_step_on)} — ${esc(d.next_step || "")})`).join(" · ")}</div>` : "";
      $("#ddDue").querySelectorAll("a").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); openDetail(a.dataset.id); }));
      const sorted = s.by_province.slice().sort((a, b) => (b.buyers + b.cooperatives + b.centers) - (a.buyers + a.cooperatives + a.centers) || a.province_name_th.localeCompare(b.province_name_th, "th"));
      $("#ddCov").innerHTML = `<table class="dd-table"><thead><tr><th>จังหวัด</th><th>ภาค</th><th class="num">ผู้รับซื้อ</th><th class="num">สหกรณ์</th><th class="num">ศูนย์รวบรวม</th><th class="num">ยืนยันแล้ว</th></tr></thead><tbody>${
        sorted.map((p) => `<tr><td>${esc(p.province_name_th)}</td><td>${esc(p.region_th || "")}</td><td class="num">${p.buyers || "-"}</td><td class="num">${p.cooperatives || "-"}</td><td class="num">${p.centers || "-"}</td><td class="num">${p.verified || "-"}</td></tr>`).join("")}</tbody></table>
        <p class="dd-note" style="margin-top:6px">ไม่ระบุจังหวัด ${s.without_province} รายการ · นับเฉพาะรายการที่ไม่ใช่รายการซ้ำ</p>`;
    }

    async function loadList() {
      const p = new URLSearchParams();
      if ($("#ddQ").value.trim()) p.set("q", $("#ddQ").value.trim());
      if ($("#ddKind").value) p.set("kind", $("#ddKind").value);
      if ($("#ddStatus").value) p.set("status", $("#ddStatus").value);
      if ($("#ddProv").value) p.set("province", $("#ddProv").value);
      if ($("#ddHideDup").checked) p.set("hide_duplicates", "1");
      rows = await api.get(`/admin/dairy-directory?${p}`);
      $("#ddList").innerHTML = rows.length ? `<table class="dd-table"><thead><tr><th>รหัส</th><th>ชื่อ</th><th>ประเภท</th><th>จังหวัด</th><th>ติดต่อ</th><th>รับซื้อน้ำนมดิบ</th><th>สถานะ</th><th>ติดต่อล่าสุด</th><th>นัดถัดไป</th></tr></thead><tbody>${
        rows.map((r) => `<tr class="pick${r.entry_id === selected ? " on" : ""}" data-id="${r.entry_id}"><td>${esc(r.external_ref || "-")}</td>
          <td>${esc(r.name)}${r.possible_duplicate_of ? '<span class="dd-chip">น่าจะซ้ำ</span>' : ""}</td><td>${KIND[r.entry_kind] || r.entry_kind}</td>
          <td>${esc(r.province_name_th || "-")}${r.province_note ? ' <span class="dd-chip">ตรวจสอบ</span>' : ""}</td>
          <td>${esc(r.phone || r.email || "-")}</td><td>${BUYS[r.buys_raw_milk]}</td><td>${badge(r.status)}</td>
          <td>${r.last_contact_at ? thDate(r.last_contact_at) : "-"}</td><td>${thDate(r.next_step_on)}</td></tr>`).join("")
      }</tbody></table><p class="dd-note" style="margin-top:6px">${rows.length} รายการ</p>` : '<div class="dd-note">ไม่พบรายการ</div>';
      $("#ddList").querySelectorAll("tr.pick").forEach((tr) => tr.addEventListener("click", () => openDetail(tr.dataset.id)));
    }

    const field = (label, name, val, type = "text", extra = "") => `<div ${extra}><label>${label}</label><input name="${name}" type="${type}" value="${esc(val == null ? "" : val)}"${type === "number" ? ' step="any" min="0"' : ""}></div>`;

    async function openDetail(id) {
      selected = id;
      $("#ddList").querySelectorAll("tr.pick").forEach((tr) => tr.classList.toggle("on", tr.dataset.id === id));
      const el = $("#ddDetail"); el.style.display = "block";
      const isNew = id === "new";
      const d = isNew ? { entry_kind: "processor", status: "unverified", buys_raw_milk: "unknown", logs: [], duplicates: [] } : await api.get(`/admin/dairy-directory/${id}`);
      el.innerHTML = `
        <div class="dd-row" style="justify-content:space-between"><h3 style="margin:0">${isNew ? "เพิ่มรายการใหม่" : `${esc(d.name)} ${badge(d.status)}`}</h3>
          <span class="dd-note" style="margin:0">${esc(d.external_ref || "")}${d.updated_at ? ` · แก้ไขล่าสุด ${thDate(d.updated_at)}` : ""}</span></div>
        ${d.possible_duplicate_of ? `<p class="dd-note">⚠️ น่าจะซ้ำกับ <a href="#" id="ddDupLink">${esc(d.duplicate_of_ref || "")} ${esc(d.duplicate_of_name || "")}</a> — ตรวจแล้วถ้าไม่ซ้ำ กด "ไม่ใช่รายการซ้ำ"</p>` : ""}
        ${d.duplicates && d.duplicates.length ? `<p class="dd-note">รายการที่น่าจะซ้ำกับรายการนี้: ${d.duplicates.map((x) => esc(`${x.external_ref || ""} ${x.name}`)).join(" · ")}</p>` : ""}
        <form id="ddForm">
          <div class="dd-sec">ข้อมูลองค์กร</div>
          <div class="dd-form">
            ${field("ชื่อหน่วยงาน/บริษัท *", "name", d.name, "text", 'class="wide"')}
            <div><label>ประเภท</label><select name="entry_kind">${opts(KIND, d.entry_kind)}</select></div>
            ${field("ประเภทองค์กร (เอกชน/สหกรณ์/รัฐวิสาหกิจ)", "org_category", d.org_category)}
            <div><label>จังหวัด</label><select name="province_code"><option value="">ไม่ระบุ</option>${provinces.map((p) => `<option value="${p.province_code}"${p.province_code === d.province_code ? " selected" : ""}>${esc(p.province_name_th)}</option>`).join("")}</select></div>
            ${field("หมายเหตุจังหวัด", "province_note", d.province_note)}
            ${field("อำเภอ/เขต", "district", d.district)}
            ${field("กลุ่มพื้นที่นมโรงเรียน (1–7)", "school_milk_zone", d.school_milk_zone, "number")}
            ${field("ที่อยู่", "address", d.address, "text", 'class="wide"')}
            ${field("บทบาทในห่วงโซ่", "chain_role", d.chain_role, "text", 'class="wide"')}
          </div>
          <div class="dd-sec">ติดต่อ</div>
          <div class="dd-form">
            ${field("โทรศัพท์กลาง", "phone", d.phone)}${field("อีเมล", "email", d.email)}${field("เว็บไซต์", "website", d.website)}
            ${field("ชื่อผู้ติดต่อ (ทีมเท่านั้น)", "contact_name", d.contact_name)}${field("ตำแหน่ง/ฝ่าย", "contact_role", d.contact_role)}${field("โทรศัพท์ผู้ติดต่อ", "contact_phone", d.contact_phone)}
          </div>
          <div class="dd-sec">การรับซื้อ (กรอกเมื่อได้จากฝ่ายจัดซื้อเท่านั้น)</div>
          <div class="dd-form">
            <div><label>รับซื้อน้ำนมดิบโดยตรง</label><select name="buys_raw_milk">${opts(BUYS, d.buys_raw_milk)}</select></div>
            ${field("ปริมาณรับซื้อจริง (ลิตร/วัน)", "actual_volume_l_day", d.actual_volume_l_day, "number")}
            ${field("ปริมาณตามสัญญา (ลิตร/วัน)", "contract_volume_l_day", d.contract_volume_l_day, "number")}
            ${field("กำลังแปรรูป (ลิตร/วัน)", "processing_capacity_l_day", d.processing_capacity_l_day, "number")}
            ${field("ราคารับซื้อ (บาท/กก.)", "price_baht_per_kg", d.price_baht_per_kg, "number")}
            ${field("แหล่งที่มาของปริมาณ/ราคา (ใคร เมื่อไร) *ต้องกรอกถ้ามีตัวเลข", "volume_source", d.volume_source, "text", 'class="wide"')}
            ${field("มาตรฐาน/เกณฑ์คุณภาพ", "quality_standard", d.quality_standard)}${field("เงื่อนไขรับซื้อ/รอบชำระ", "purchase_terms", d.purchase_terms)}
          </div>
          <div class="dd-sec">สถานะและแหล่งข้อมูล</div>
          <div class="dd-form">
            <div><label>สถานะ</label><select name="status"${d.status === "onboarded" ? " disabled" : ""}>${opts(Object.fromEntries(Object.entries(STATUS).filter(([k]) => k !== "onboarded" || d.status === "onboarded")), d.status)}</select></div>
            ${field("ตรวจสอบล่าสุด", "last_verified_on", d.last_verified_on, "date")}
            ${field("ผู้รับผิดชอบ AgroLink", "owner_name", d.owner_name)}
            ${field("แหล่งข้อมูล", "source", d.source)}${field("URL แหล่งข้อมูล", "source_url", d.source_url, "text", 'class="wide"')}
            <div class="wide"><label>หมายเหตุ</label><textarea name="notes" rows="2">${esc(d.notes || "")}</textarea></div>
          </div>
          <div class="dd-row"><button class="dd-btn primary" type="submit">${isNew ? "เพิ่มรายการ" : "บันทึก"}</button>
            ${d.possible_duplicate_of ? '<button class="dd-btn" type="button" id="ddNotDup">ไม่ใช่รายการซ้ำ</button>' : ""}<span class="dd-note" id="ddMsg" style="margin:0"></span></div>
        </form>
        ${isNew ? "" : `
        <div class="dd-sec">ใช้ AgroLink แล้ว</div>
        <div class="dd-row">${d.linked_org_id ? `ผูกกับบัญชี <b>${esc(d.linked_org_name)}</b> <button class="dd-btn" id="ddUnlink">ยกเลิกการผูก</button>`
          : `<input id="ddOrgQ" placeholder="ค้นหาชื่อองค์กรที่สมัครแล้ว"><select id="ddOrgSel"></select><button class="dd-btn" id="ddLink">ผูกบัญชีและตั้งเป็น "ใช้ AgroLink แล้ว"</button>`}</div>
        <div class="dd-sec">บันทึกการติดต่อ</div>
        <form class="dd-form" id="ddLogForm">
          <div><label>ช่องทาง</label><select name="channel">${opts(CH, "phone")}</select></div>
          <div><label>ผู้บันทึก *</label><input name="logged_by" required></div>
          <div class="wide"><label>สรุปการติดต่อ *</label><input name="summary" required></div>
          <div><label>ผลลัพธ์</label><input name="outcome"></div>
          <div><label>สิ่งที่ต้องทำต่อ</label><input name="next_step"></div>
          <div><label>นัดติดตาม</label><input name="next_step_on" type="date"></div>
          <div><button class="dd-btn primary" type="submit">บันทึกการติดต่อ</button></div>
        </form>
        ${d.logs.map((l) => `<div class="dd-log"><b>${thDate(l.logged_at)} · ${CH[l.channel]} · ${esc(l.logged_by)}</b><br>${esc(l.summary)}${l.outcome ? `<br>ผล: ${esc(l.outcome)}` : ""}${l.next_step || l.next_step_on ? `<br>ต่อไป: ${esc(l.next_step || "")} ${l.next_step_on ? `(${thDate(l.next_step_on)})` : ""}` : ""}</div>`).join("") || '<p class="dd-note">ยังไม่มีบันทึก — บันทึกครั้งแรกจะเปลี่ยนสถานะเป็น "ติดต่อแล้ว" อัตโนมัติ</p>'}`}`;

      const msg = (t) => { const m = el.querySelector("#ddMsg"); if (m) m.textContent = t; };
      const dupLink = el.querySelector("#ddDupLink");
      if (dupLink) dupLink.addEventListener("click", (e) => { e.preventDefault(); openDetail(d.possible_duplicate_of); });
      el.querySelector("#ddForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const body = {};
        new FormData(e.target).forEach((v, k) => { body[k] = typeof v === "string" ? v.trim() : v; });
        if (d.status === "onboarded") delete body.status;
        try {
          if (isNew) { const r = await api.post("/admin/dairy-directory", body); await refreshAll(); openDetail(r.entry_id); }
          else { await api.put(`/admin/dairy-directory/${id}`, body); msg("บันทึกแล้ว"); await refreshAll(); }
        } catch (err) { msg(errText(err)); }
      });
      const notDup = el.querySelector("#ddNotDup");
      if (notDup) notDup.addEventListener("click", async () => { try { await api.put(`/admin/dairy-directory/${id}`, { possible_duplicate_of: null }); await refreshAll(); openDetail(id); } catch (err) { msg(errText(err)); } });
      if (isNew) { el.scrollIntoView({ behavior: "smooth" }); return; }
      const orgQ = el.querySelector("#ddOrgQ");
      if (orgQ) {
        let t;
        orgQ.addEventListener("input", () => { clearTimeout(t); t = setTimeout(async () => {
          const list = await api.get(`/admin/dairy-directory/orgs?q=${encodeURIComponent(orgQ.value.trim())}`);
          el.querySelector("#ddOrgSel").innerHTML = list.map((o) => `<option value="${o.org_id}">${esc(o.org_name)} (${esc(o.org_type)}${o.kyb_status !== "Verified" ? " · ยังไม่อนุมัติ" : ""})</option>`).join("");
        }, 300); });
        el.querySelector("#ddLink").addEventListener("click", async () => {
          const org = el.querySelector("#ddOrgSel").value;
          if (!org) return alert("ค้นหาและเลือกองค์กรก่อน");
          try { await api.post(`/admin/dairy-directory/${id}/link`, { org_id: org }); await refreshAll(); openDetail(id); } catch (err) { alert(errText(err)); }
        });
      }
      const unlink = el.querySelector("#ddUnlink");
      if (unlink) unlink.addEventListener("click", async () => { try { await api.post(`/admin/dairy-directory/${id}/link`, { org_id: null }); await refreshAll(); openDetail(id); } catch (err) { alert(errText(err)); } });
      el.querySelector("#ddLogForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const body = {}; new FormData(e.target).forEach((v, k) => { if (String(v).trim()) body[k] = String(v).trim(); });
        try { await api.post(`/admin/dairy-directory/${id}/logs`, body); await refreshAll(); openDetail(id); } catch (err) { alert(errText(err)); }
      });
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function downloadCsv() {
      const cols = [["external_ref", "รหัส"], ["name", "ชื่อ"], ["entry_kind", "ประเภท"], ["province_name_th", "จังหวัด"], ["phone", "โทรศัพท์"], ["email", "อีเมล"],
        ["website", "เว็บไซต์"], ["buys_raw_milk", "รับซื้อน้ำนมดิบ"], ["actual_volume_l_day", "ปริมาณจริง ลิตร/วัน"], ["contract_volume_l_day", "ปริมาณสัญญา ลิตร/วัน"],
        ["price_baht_per_kg", "ราคา บาท/กก."], ["status", "สถานะ"], ["last_verified_on", "ตรวจสอบล่าสุด"], ["owner_name", "ผู้รับผิดชอบ"], ["next_step_on", "นัดถัดไป"]];
      const val = (r, k) => (k === "entry_kind" ? KIND[r[k]] : k === "status" ? STATUS[r[k]][0] : k === "buys_raw_milk" ? BUYS[r[k]] : r[k]);
      const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
      const csv = "﻿" + [cols.map((c) => q(c[1])).join(","), ...rows.map((r) => cols.map((c) => q(val(r, c[0]))).join(","))].join("\r\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      a.download = `agrolink-dairy-directory-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    async function refreshAll() { await Promise.all([loadSummary(), loadList()]); }
    let qt;
    $("#ddQ").addEventListener("input", () => { clearTimeout(qt); qt = setTimeout(loadList, 300); });
    ["#ddKind", "#ddStatus", "#ddProv", "#ddHideDup"].forEach((s) => $(s).addEventListener("change", loadList));
    $("#ddNew").addEventListener("click", () => openDetail("new"));
    $("#ddCsv").addEventListener("click", downloadCsv);
    loadSummary().then(loadList).catch((err) => { $("#ddList").innerHTML = `<div class="dd-note">${esc(errText(err))}</div>`; });
  }

  function errText(err) {
    const m = (err && err.message) || String(err);
    const map = {
      dairy_directory_not_installed: "ยังไม่ได้ติดตั้งตารางในฐานข้อมูล — รัน backend/db/grant_dairy_market_directory.sql และไฟล์ seed ก่อน (ดู DEPLOY.md)",
      name_required: "ต้องกรอกชื่อ", unlink_before_changing_status: "ต้องยกเลิกการผูกบัญชีก่อนเปลี่ยนสถานะ",
      summary_required: "ต้องกรอกสรุปการติดต่อ", logged_by_required: "ต้องกรอกชื่อผู้บันทึก",
    };
    if (err && err.body && err.body.constraint === "market_directory_volume_source_check") return "ถ้ากรอกปริมาณหรือราคา ต้องกรอกแหล่งที่มา (ใครให้ข้อมูล เมื่อไร) ด้วย";
    return map[m] || `เกิดข้อผิดพลาด: ${m}`;
  }

  window.AgroLinkDairyDirectory = { mount };
})();
