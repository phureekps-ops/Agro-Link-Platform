/**
 * แอดมิน › 🧪 ข้อมูลดิน กพด. — สถานะการดึงผลวิเคราะห์ดินสาธารณะของกรมพัฒนาที่ดิน
 * API: /admin/ldd/status, /admin/ldd/sync (backend/src/routes/ldd.js)
 * ใช้ตรวจว่าเชื่อม osd101.ldd.go.th ได้จริง และชื่อรายการวิเคราะห์ใดที่ระบบยังแปลงเป็น pH/OM/N/P/K ไม่ได้
 * AgroLinkLddSoil.mount(host, { api })
 */
(function () {
  "use strict";
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const when = (v) => (v ? new Date(v).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }) : "-");
  const n = (v) => (v == null ? "-" : Number(v).toLocaleString("th-TH"));

  function mount(host, { api }) {
    const provinces = typeof TH_PROVINCES !== "undefined" ? TH_PROVINCES : []; // ../js/provinces.js
    host.innerHTML = `
      <p style="font-size:13px;color:#667085;margin:-6px 0 14px;line-height:1.6">ค่าดินใกล้แปลงในเมนู "ปุ๋ยสั่งตัด" ของเกษตรกรมาจากชุดข้อมูลเปิด
        <a href="https://lddcatalog.ldd.go.th/en/dataset/osd01" target="_blank" rel="noopener">การตรวจวิเคราะห์ดิน (osd01)</a> ของกรมพัฒนาที่ดิน
        ระบบดึงรายจังหวัดเมื่อมีเกษตรกรขอครั้งแรก และดึงใหม่เมื่อเก่ากว่า 7 วัน กด "ดึงข้อมูลตอนนี้" เพื่อทดสอบการเชื่อมต่อ</p>
      <div style="background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);padding:16px 18px;margin-bottom:16px">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <label style="display:flex;flex-direction:column;font-size:13px;font-weight:600;gap:4px">จังหวัด
            <select id="lddProv" style="font:inherit;padding:8px;border-radius:8px;border:1px solid #d0d5dd">${provinces.map(([c, nm]) => `<option value="${esc(c)}">${esc(nm)}</option>`).join("")}</select></label>
          <button type="button" id="lddSync" class="btn btn-primary" style="padding:9px 16px">ดึงข้อมูลตอนนี้</button>
        </div>
        <div id="lddSyncOut" style="margin-top:10px;font-size:13.5px"></div>
      </div>
      <div style="background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);padding:16px 18px;margin-bottom:16px">
        <b style="font-size:15px">นำเข้าไฟล์ข้อมูลดิน (ใช้เมื่อเซิร์ฟเวอร์ดึงจาก กพด. เองไม่ได้)</b>
        <p style="font-size:13px;color:#667085;margin:6px 0 10px;line-height:1.6">1) เปิดลิงก์ด้านล่างในเบราว์เซอร์บนเครื่องของท่าน 2) กด Ctrl+S บันทึกเป็นไฟล์ .json 3) เลือกไฟล์แล้วกดนำเข้า
          — แถวที่ไม่มีชื่อจังหวัดจะนับเป็นจังหวัดที่เลือกไว้ด้านบน<br><a id="lddOpenUrl" href="#" target="_blank" rel="noopener">เปิดข้อมูลของจังหวัดที่เลือกจากกรมพัฒนาที่ดิน</a></p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <input type="file" id="lddFile" accept=".json,application/json">
          <button type="button" id="lddImport" class="btn btn-primary" style="padding:9px 16px">นำเข้า</button>
        </div>
        <div id="lddImportOut" style="margin-top:10px;font-size:13.5px"></div>
      </div>
      <div id="lddStatus"></div>`;
    const $ = (s) => host.querySelector(s);

    async function load() {
      const el = $("#lddStatus");
      try {
        const d = await api.get("/admin/ldd/status");
        urlTpl.v = d.api_url_template; setOpenUrl();
        el.innerHTML = `<p style="font-size:12.5px;color:#667085">URL ที่ใช้: <code>${esc(d.api_url_template)}</code> (เปลี่ยนได้ด้วยตัวแปร LDD_SOIL_API_URL บน Render)</p>
          ${d.provinces.length ? `<div style="overflow-x:auto"><table class="data-table" style="width:100%;font-size:13px"><thead><tr><th>จังหวัด</th><th>ดึงล่าสุด</th><th>สถานะ</th><th>แถวที่ได้</th><th>ใช้ได้</th><th>จุดเก็บตัวอย่าง</th><th>ชื่อรายการที่ยังแปลงไม่ได้</th></tr></thead><tbody>
          ${d.provinces.map((p) => `<tr><td>${esc(p.province)}</td><td>${when(p.fetched_at)}</td><td>${p.status === "ok" ? "✅ สำเร็จ" : `❌ ${esc(p.error)}`}</td>
            <td>${n(p.rows_received)}</td><td>${n(p.rows_used)}</td><td>${n(p.cached_samples)}</td>
            <td>${p.unmapped && Object.keys(p.unmapped).length ? Object.entries(p.unmapped).map(([k, v]) => `${esc(k)} (${n(v)})`).join(", ") : "-"}</td></tr>`).join("")}
          </tbody></table></div>` : '<div class="empty-state">ยังไม่เคยดึงข้อมูลจังหวัดใด</div>'}`;
      } catch (e) {
        el.innerHTML = `<div class="empty-state">${e.body && e.body.error === "ldd_not_installed" ? "ยังไม่ได้รัน grant_fertilizer_ldd.sql บนฐานข้อมูล" : esc(e.message)}</div>`;
      }
    }

    const urlTpl = { v: "https://osd101.ldd.go.th/api/data.php?province={province}" };
    const nameOf = (code) => (provinces.find(([c]) => c === code) || [, ""])[1];
    const setOpenUrl = () => { $("#lddOpenUrl").href = urlTpl.v.replace("{province}", encodeURIComponent(nameOf($("#lddProv").value))); };
    $("#lddProv").addEventListener("change", setOpenUrl);
    const normProv = (p) => String(p || "").replace(/<[^>]*>/g, "").replace(/^จังหวัด|^จ\.\s*/, "").replace(/\s+/g, "");

    $("#lddImport").addEventListener("click", async (ev) => {
      const btn = ev.currentTarget; const out = $("#lddImportOut");
      const file = $("#lddFile").files[0];
      if (!file) { out.textContent = "เลือกไฟล์ก่อน"; return; }
      btn.disabled = true; out.textContent = "กำลังอ่านไฟล์…";
      try {
        let json;
        try { json = JSON.parse((await file.text()).replace(/^\uFEFF/, "")); } catch (e) { throw new Error("ไฟล์ไม่ใช่ JSON"); }
        const rows = Array.isArray(json) ? json : (["data", "result", "results", "records", "items", "rows"].map((k) => json && json[k]).find(Array.isArray));
        if (!rows || !rows.length) throw new Error("ไม่พบรายการข้อมูลในไฟล์");
        // number repeated samples at the same point before splitting into chunks (see groupSamples in lddSoil.js)
        const seen = new Map();
        rows.forEach((r) => {
          if (!r || typeof r !== "object") return;
          const k = [r.latitude, r.longitude, r.date, r.address, r.village, r.district, r.amphur, r.parameter].join("|");
          const c = seen.get(k) || 0; seen.set(k, c + 1); r._occ = c;
        });
        const fallback = nameOf($("#lddProv").value);
        const groups = new Map();
        rows.forEach((r) => { const p = normProv(r && (r.province || r.province_name || r.changwat)) || fallback; if (!groups.has(p)) groups.set(p, []); groups.get(p).push(r); });
        const lines = [];
        for (const [prov, list] of groups) {
          for (let i = 0; i < list.length; i += 8000) {
            out.textContent = `กำลังนำเข้า ${prov} (${Math.min(i + 8000, list.length).toLocaleString("th-TH")}/${list.length.toLocaleString("th-TH")} แถว)…`;
            const r = await api.post("/admin/ldd/import", { province: prov, rows: list.slice(i, i + 8000), append: i > 0 });
            if (i + 8000 >= list.length) { const p = r.provinces[0]; lines.push(p ? `✅ ${esc(p.province)}: ${n(p.samples)} จุดเก็บตัวอย่าง` : `⚠️ ${esc(prov)}: ไม่มีแถวที่ใช้ได้`); }
          }
        }
        out.innerHTML = lines.join("<br>");
      } catch (e) { out.textContent = `❌ ${e.body && e.body.error ? e.body.error : e.message}`; }
      btn.disabled = false;
      load();
    });

    $("#lddSync").addEventListener("click", async (ev) => {
      const btn = ev.currentTarget; const out = $("#lddSyncOut");
      btn.disabled = true; out.textContent = "กำลังดึงข้อมูลจากกรมพัฒนาที่ดิน…";
      try {
        const r = await api.post("/admin/ldd/sync", { province_code: $("#lddProv").value });
        out.innerHTML = r.status === "ok"
          ? `✅ ${esc(r.province)}: ได้ ${n(r.rows_received)} แถว ใช้ได้ ${n(r.rows_used)} แถว รวมเป็น ${n(r.samples)} จุดเก็บตัวอย่าง`
          : r.error === "no_rows_for_province"
            ? `⚠️ เชื่อม กพด. ได้ (${n(r.rows_received)} แถว) แต่ไม่มีข้อมูลของ${esc(r.province)} — บันทึกข้อมูลจังหวัดที่มีไว้แล้ว: ${esc((r.other_provinces || []).join(", "))}`
            : `❌ ${esc(r.province)}: ${esc(r.error)} — URL ${esc(r.url)}`;
      } catch (e) { out.textContent = `❌ ${e.body && e.body.error ? e.body.error : e.message}`; }
      btn.disabled = false;
      load();
    });
    load();
  }

  window.AgroLinkLddSoil = { mount };
})();
