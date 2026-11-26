/**
 * AgroLink โคนม — ส่วนต่อขยายฝั่งสหกรณ์: นำเข้าไฟล์ (ตรวจก่อนบันทึก), ล็อตน้ำนมและการตรวจสอบย้อนกลับ, คุณภาพข้อมูล
 * โหลดก่อน js/dairy.js; dairy.js เรียก window.AgroDairyExt(ctx) แล้วแท็บ import / trace / dataquality ใช้ helper ชุดเดียวกัน
 * API: backend/src/routes/dairyData.js
 */
(function () {
  "use strict";
  window.AgroDairyExt = function (X) {
    const { API, API_BASE, PAGES, ACT, FORM, $, esc, n2, d, dt, table, pill, toast, run, fd, clean, opt, ERR, REJ, SOURCE_TH } = X;

    Object.assign(ERR, {
      missing_file: "ยังไม่ได้เลือกไฟล์", file_too_large: "ไฟล์ใหญ่เกิน 3 MB — แบ่งเป็นหลายไฟล์", xls_not_supported: "ไฟล์ .xls รุ่นเก่า — เปิดใน Excel แล้วบันทึกเป็น .xlsx หรือ CSV UTF-8",
      invalid_xlsx: "อ่านไฟล์ Excel ไม่ได้", invalid_json: "ไฟล์ JSON ต้องเป็นรายการของแถว", empty_file: "ไฟล์ว่าง", no_data_rows: "มีแต่หัวตาราง ไม่มีข้อมูล",
      too_many_rows: "เกิน 5,000 แถวต่อไฟล์ — แบ่งเป็นหลายไฟล์", missing_columns: "ไม่พบคอลัมน์ที่จำเป็น", import_not_previewed: "ไฟล์นี้บันทึกหรือยกเลิกไปแล้ว",
      batch_not_found: "ไม่พบรหัสล็อตนี้",
    });
    const FIELD_TH = {
      member_code: "รหัสสมาชิก", round_date: "วันที่", shift: "รอบ", center: "ศูนย์", weight_kg: "น้ำหนัก", status: "สถานะ", reject_reason: "สาเหตุที่ไม่รับ", sample_no: "เลขตัวอย่าง",
      sample_date: "วันที่เก็บตัวอย่าง", fat_pct: "ไขมัน", snf_pct: "SNF", protein_pct: "โปรตีน", scc_k: "SCC", tbc_k: "TBC", antibiotic_pos: "ยาปฏิชีวนะ", lab_name: "ห้องปฏิบัติการ",
    };
    const ISSUE_TH = {
      missing_member_code: () => "ไม่มีรหัสสมาชิก", member_not_found: (i) => `ไม่พบรหัสสมาชิก ${i.value || ""}`, member_not_approved: () => "สมาชิกยังไม่อนุมัติหรือถูกระงับ",
      missing_date: () => "ไม่มีวันที่", invalid_date: (i) => `อ่านวันที่ไม่ได้ "${i.value}"`, future_date: () => "วันที่ยังมาไม่ถึง", date_defaulted: () => "ใช้วันที่ที่กำหนดไว้",
      missing_shift: () => "ไม่ระบุรอบเช้า/เย็น", invalid_shift: (i) => `รอบ "${i.value}" ไม่ถูกต้อง (ใช้ เช้า/เย็น)`, shift_defaulted: (i) => `ใช้รอบ${i.value === "AM" ? "เช้า" : "เย็น"}ที่กำหนดไว้`,
      missing_weight: () => "ไม่มีน้ำหนัก", invalid_number: (i) => `${FIELD_TH[i.field] || ""} "${i.value}" ไม่ใช่ตัวเลข`, weight_not_positive: () => "น้ำหนักต้องมากกว่า 0",
      weight_too_high: () => "น้ำหนักเกิน 5,000 กก. ต่อรายต่อรอบ", invalid_status: (i) => `สถานะ "${i.value}" ไม่ถูกต้อง (ใช้ รับ/ไม่รับ)`, missing_reject_reason: () => "ไม่รับนมต้องระบุสาเหตุ",
      status_inferred_rejected: () => "มีสาเหตุที่ไม่รับ จึงถือว่าไม่รับนม", center_not_found: (i) => `ไม่พบศูนย์ "${i.value}"`, missing_center: () => "ไม่รู้ศูนย์รับนม (สมาชิกไม่ได้ผูกศูนย์) — เลือกศูนย์ในตัวเลือก",
      center_differs_from_member: () => "ต่างจากศูนย์ประจำของสมาชิก", center_defaulted: () => "ใช้ศูนย์ที่กำหนดไว้", period_settled: () => "อยู่ในงวดที่จ่ายเงินสมาชิกแล้ว",
      duplicate_in_file: (i) => `ซ้ำกับแถว ${i.first_row} ในไฟล์`, round_closed: (i) => `รอบนี้ปิดแล้ว${i.existing_kg != null ? ` (ในระบบ ${n2(i.existing_kg)} กก.)` : ""} — แก้ไม่ได้`,
      will_replace: (i) => `จะแทนค่าเดิม ${n2(i.existing_kg)} กก.`, also_delivered_other_center: (i) => `ส่งที่${i.center}ในรอบเดียวกันด้วย`,
      weight_outlier: (i) => `ต่างจากปกติมาก (เฉลี่ย 30 วัน ${n2(i.avg_kg)} กก.)`, withdrawal_animals: (i) => `มีโคระยะหยุดยา ${(i.ear_tags || []).join(", ")}`,
      out_of_range: (i) => `${FIELD_TH[i.field]} ${n2(i.value)} นอกช่วง ${i.min}–${i.max}`, empty_test: () => "ไม่มีค่าผลตรวจ", invalid_boolean: (i) => `ยาปฏิชีวนะ "${i.value}" (ใช้ พบ/ไม่พบ)`,
      unit_converted: (i) => `${FIELD_TH[i.field]} แปลงเป็นพันต่อมล. = ${n2(i.value)}`, fat_below_standard: () => "ไขมันต่ำกว่า 3.2%", snf_below_standard: () => "SNF ต่ำกว่า 8.25%",
      scc_high: () => "SCC สูงกว่า 500 พัน/มล.", antibiotic_positive: () => "พบยาปฏิชีวนะ — ระบบจะแจ้งสมาชิก", test_exists_same_date: () => "มีผลตรวจวันเดียวกันอยู่แล้ว (จะเพิ่มอีกรายการ)",
    };
    const ISSUE_SHORT = {
      missing_member_code: "ไม่มีรหัสสมาชิก", member_not_found: "ไม่พบสมาชิก", member_not_approved: "สมาชิกไม่อนุมัติ", missing_date: "ไม่มีวันที่", invalid_date: "วันที่ผิด",
      future_date: "วันที่อนาคต", date_defaulted: "ใช้วันที่ที่กำหนด", missing_shift: "ไม่มีรอบ", invalid_shift: "รอบผิด", shift_defaulted: "ใช้รอบที่กำหนด", missing_weight: "ไม่มีน้ำหนัก",
      invalid_number: "ตัวเลขผิด", weight_not_positive: "น้ำหนัก ≤ 0", weight_too_high: "น้ำหนักเกิน", invalid_status: "สถานะผิด", missing_reject_reason: "ไม่ระบุสาเหตุที่ไม่รับ",
      status_inferred_rejected: "ถือว่าไม่รับ", center_not_found: "ไม่พบศูนย์", missing_center: "ไม่รู้ศูนย์", center_differs_from_member: "ต่างศูนย์ประจำ", center_defaulted: "ใช้ศูนย์ที่กำหนด",
      period_settled: "งวดจ่ายแล้ว", duplicate_in_file: "ซ้ำในไฟล์", round_closed: "รอบปิดแล้ว", will_replace: "แทนค่าเดิม", also_delivered_other_center: "ส่งหลายศูนย์",
      weight_outlier: "น้ำหนักผิดปกติ", withdrawal_animals: "โคระยะหยุดยา", out_of_range: "ค่านอกช่วง", empty_test: "ไม่มีค่าผลตรวจ", invalid_boolean: "ค่ายาปฏิชีวนะผิด",
      unit_converted: "แปลงหน่วย", fat_below_standard: "ไขมันต่ำ", snf_below_standard: "SNF ต่ำ", scc_high: "SCC สูง", antibiotic_positive: "พบยาปฏิชีวนะ", test_exists_same_date: "มีผลวันเดียวกัน",
    };
    const issueText = (i) => (ISSUE_TH[i.code] ? ISSUE_TH[i.code](i) : i.code);
    const VERDICT = { ok: ["ผ่าน", "ok"], warning: ["เตือน", "warn"], error: ["ผิด ไม่บันทึก", "bad"], duplicate: ["ซ้ำ ข้าม", ""] };
    const OUTCOME_TH = {
      inserted: "เพิ่มใหม่", replaced: "แทนค่าเดิม", rounds_created: "รอบที่เปิดใหม่", rounds_closed: "รอบที่ปิดและคิดเงิน", skipped_error: "ข้าม: ข้อมูลผิด",
      skipped_duplicate: "ข้าม: ซ้ำ", skipped_warning: "ข้าม: มีคำเตือน", skipped_withdrawal: "ข้าม: โคระยะหยุดยา (ยังไม่ยืนยัน)", skipped_round_closed: "ข้าม: รอบถูกปิดระหว่างนั้น", excluded: "ไม่เลือก",
    };
    const shiftTh = (s) => (s === "AM" ? "เช้า" : s === "PM" ? "เย็น" : "-");
    const LIMIT = 300;

    // ======================================================================
    // 📥 นำเข้าไฟล์
    // ======================================================================
    let cur = null; // ผลตรวจไฟล์ล่าสุด
    let filter = "all";
    let done = null; // ผลการบันทึกล่าสุด

    PAGES.import = async (sec) => {
      const [centers, hist] = await Promise.all([API.get("/dairy/centers"), API.get("/dairy/imports")]);
      sec.innerHTML = `
        <div class="mh-card"><h3>นำเข้าข้อมูลจากไฟล์ (Excel / CSV / JSON)</h3>
          <p class="mh-note" style="margin:0 0 10px">ระบบอ่านทุกแถวและตรวจกับข้อมูลในระบบก่อน (สมาชิก ศูนย์ รอบที่ปิดแล้ว ข้อมูลซ้ำ น้ำหนักผิดปกติ โคระยะหยุดยา งวดที่จ่ายแล้ว)
            — <b>ยังไม่บันทึกจนกว่าจะกดยืนยัน</b>. วันที่ใช้ได้ทั้ง พ.ศ. ค.ศ. และวันที่ของ Excel; หัวคอลัมน์ไทยหรืออังกฤษก็ได้</p>
          <form data-form="impPreview" class="mh-form">
            <div><label>ข้อมูลในไฟล์</label><select name="kind"><option value="intake">รับน้ำนมรายสมาชิก</option><option value="quality">ผลตรวจคุณภาพจากแล็บ</option></select></div>
            <div class="full"><label>ไฟล์ (.xlsx .csv .json ไม่เกิน 3 MB / 5,000 แถว)</label><input type="file" name="file" accept=".xlsx,.csv,.txt,.json" required></div>
            <div><label>รอบ (ถ้าไฟล์ไม่มีคอลัมน์รอบ)</label><select name="default_shift"><option value="">— ต้องมีในไฟล์ —</option><option value="AM">เช้า</option><option value="PM">เย็น</option></select></div>
            <div><label>วันที่ (ถ้าไฟล์ไม่มีคอลัมน์วันที่)</label><input type="date" name="default_date"></div>
            <div><label>ศูนย์ (สมาชิกที่ไม่ได้ผูกศูนย์)</label><select name="center_id"><option value="">— ไม่กำหนด —</option>${opt(centers.filter((c) => c.active), "center_id", "name")}</select></div>
            <div><label>ห้องปฏิบัติการ (ผลตรวจ)</label><input name="lab_name" placeholder="เช่น แล็บสหกรณ์"></div>
            <div><button class="mh-btn">ตรวจไฟล์</button></div></form>
          <div class="mh-row" style="margin-top:10px;gap:8px;display:flex;flex-wrap:wrap">
            <button class="mh-btn sm ghost" data-act="impTemplate" data-kind="intake">⬇ แบบฟอร์มรับน้ำนม (CSV)</button>
            <button class="mh-btn sm ghost" data-act="impTemplate" data-kind="quality">⬇ แบบฟอร์มผลตรวจคุณภาพ (CSV)</button></div></div>
        <div id="impBox"></div>
        <div class="mh-card"><h3>ประวัติการนำเข้า</h3>
          ${table(["เวลา", "ไฟล์", "ข้อมูล", "#แถว", "#ผ่าน", "#เตือน", "#ผิด", "#ซ้ำ", "#บันทึก", "สถานะ", "โดย"], hist.map((h) => `<tr>
            <td>${dt(h.created_at)}</td><td>${esc(h.filename)} <small>${esc(h.file_format)}</small></td><td>${h.kind === "intake" ? "รับนม" : "ผลตรวจ"}</td>
            <td class="num">${h.row_count}</td><td class="num">${h.ok_count}</td><td class="num">${h.warning_count}</td><td class="num">${h.error_count}</td><td class="num">${h.duplicate_count}</td>
            <td class="num">${h.result_counts ? n2((h.result_counts.inserted || 0) + (h.result_counts.replaced || 0)) : "-"}</td>
            <td>${h.status === "Committed" ? pill("บันทึกแล้ว", "ok") : h.status === "Discarded" ? pill("ยกเลิก", "") : `<button class="mh-btn sm ghost" data-act="impOpen" data-id="${h.import_id}">รอยืนยัน — เปิด</button>`}</td>
            <td><small>${esc(h.committed_by || h.created_by)}</small></td></tr>`))}</div>`;
      renderImport();
    };

    function renderImport() {
      const box = $("#impBox");
      if (!box) return;
      if (done) { box.innerHTML = renderDone(done); return; }
      if (!cur) { box.innerHTML = ""; return; }
      const s = cur.summary;
      const rows = cur.rows.filter((r) => filter === "all" || r.verdict === filter);
      const hasWd = cur.rows.some((r) => r.withdrawal && r.verdict !== "error");
      const issues = Object.entries(s.issues || {}).sort((a, b) => b[1] - a[1]);
      const intake = cur.kind === "intake";
      const head = intake ? ["แถว", "ผล", "สมาชิก", "วันที่ / รอบ", "ศูนย์", "#กก.", "สถานะ", "ปัญหาที่พบ"]
        : ["แถว", "ผล", "สมาชิก", "วันที่", "#ไขมัน", "#SNF", "#SCC", "#TBC", "ยา", "ปัญหาที่พบ"];
      const issueCell = (r) => [...r.errors.map((i) => `<span class="mh-iss e">✕ ${esc(issueText(i))}</span>`), ...r.warnings.map((i) => `<span class="mh-iss w">! ${esc(issueText(i))}</span>`)].join("")
        || (r.verdict === "duplicate" ? '<span class="mh-iss">มีข้อมูลเดียวกันในระบบแล้ว</span>' : "");
      const v = (r) => r.values || {};
      const member = (r) => `${esc(v(r).member_code || "-")}<br><small>${esc(v(r).full_name || "")}</small>`;
      const body = rows.slice(0, LIMIT).map((r) => {
        const [t, c] = VERDICT[r.verdict];
        return intake
          ? `<tr><td class="num">${r.row_no}</td><td>${pill(t, c)}</td><td>${member(r)}</td><td>${d(v(r).round_date)} ${shiftTh(v(r).shift)}</td><td>${esc(v(r).center_name || v(r).center || "-")}</td>
            <td class="num">${n2(v(r).weight_kg)}</td><td>${v(r).status === "Rejected" ? pill("ไม่รับ: " + (REJ[v(r).reject_reason] || ""), "bad") : v(r).status ? "รับ" : "-"}</td><td>${issueCell(r)}</td></tr>`
          : `<tr><td class="num">${r.row_no}</td><td>${pill(t, c)}</td><td>${member(r)}</td><td>${d(v(r).sample_date)}</td><td class="num">${n2(v(r).fat_pct)}</td><td class="num">${n2(v(r).snf_pct)}</td>
            <td class="num">${n2(v(r).scc_k)}</td><td class="num">${n2(v(r).tbc_k)}</td><td>${v(r).antibiotic_pos ? pill("พบ", "bad") : "-"}</td><td>${issueCell(r)}</td></tr>`;
      });
      const fb = (k, label, n) => `<button type="button" class="mh-btn sm ghost${filter === k ? " on" : ""}" data-act="impFilter" data-f="${k}">${label} ${n}</button>`;
      box.innerHTML = `<div class="mh-card"><h3>ผลตรวจไฟล์: ${esc(cur.filename)} <small>(${esc(cur.format)}, ${intake ? "รับน้ำนม" : "ผลตรวจคุณภาพ"})</small></h3>
        ${cur.same_file_committed_at ? `<p class="mh-note" style="color:#8a5a00">⚠ ไฟล์เดียวกันนี้ถูกบันทึกไปแล้วเมื่อ ${dt(cur.same_file_committed_at)} — แถวที่ซ้ำจะถูกข้ามอัตโนมัติ</p>` : ""}
        <div class="mh-grid" style="margin-bottom:12px">
          <div class="mh-stat"><small>แถวข้อมูล</small><b>${n2(s.row_count)}</b></div>
          <div class="mh-stat"><small>ผ่าน</small><b>${n2(s.ok_count)}</b></div>
          <div class="mh-stat${s.warning_count ? " warn" : ""}"><small>มีคำเตือน (บันทึกได้)</small><b>${n2(s.warning_count)}</b></div>
          <div class="mh-stat"><small>ผิด — จะไม่บันทึก</small><b style="color:${s.error_count ? "var(--red-600)" : "inherit"}">${n2(s.error_count)}</b></div>
          <div class="mh-stat"><small>ซ้ำกับในระบบ — ข้าม</small><b>${n2(s.duplicate_count)}</b></div></div>
        <p class="mh-note">คอลัมน์ที่อ่านได้: ${Object.entries(cur.columns).map(([f, h]) => `${FIELD_TH[f] || f} ← “${esc(h)}”`).join(" · ")}
          ${cur.unknown_columns && cur.unknown_columns.length ? `<br>ไม่ได้ใช้: ${cur.unknown_columns.map(esc).join(", ")}` : ""}</p>
        ${issues.length ? `<p class="mh-note">ปัญหาที่พบ: ${issues.map(([k, n]) => `${esc(ISSUE_SHORT[k] || k)} ${n}`).join(" · ")}</p>` : ""}
        <div class="mh-filter">${fb("all", "ทั้งหมด", s.row_count)}${fb("error", "ผิด", s.error_count)}${fb("warning", "เตือน", s.warning_count)}${fb("duplicate", "ซ้ำ", s.duplicate_count)}${fb("ok", "ผ่าน", s.ok_count)}</div>
        ${table(head, body)}
        ${rows.length > LIMIT ? `<p class="mh-note">แสดง ${LIMIT} จาก ${rows.length} แถว — แก้แถวที่ผิดในไฟล์แล้วนำเข้าใหม่ได้ แถวที่บันทึกไปแล้วจะถูกข้ามเป็นข้อมูลซ้ำ</p>` : ""}
        ${cur.status && cur.status !== "Previewed" ? "" : `<form data-form="impCommit" class="mh-form" style="margin-top:14px;border-top:1px solid var(--gray-100);padding-top:12px">
          <div class="full"><label><input type="checkbox" name="include_warnings" checked style="width:auto"> บันทึกแถวที่มีคำเตือนด้วย (${n2(s.warning_count)} แถว)</label>
            ${intake ? `<label><input type="checkbox" name="close_rounds" style="width:auto"> ปิดรอบที่นำเข้าทันที — คิดเงินตามผลคุณภาพ และจัดเข้าล็อตน้ำนมของศูนย์</label>` : ""}
            ${hasWd ? `<label style="color:var(--red-600)"><input type="checkbox" name="confirm_withdrawal" style="width:auto"> ยืนยันว่านมจากสมาชิกที่มีโคระยะหยุดยาไม่ได้ปนนมจากโคตัวนั้น (ถ้าไม่ติ๊ก แถวเหล่านี้จะถูกข้าม)</label>` : ""}</div>
          <div><button class="mh-btn"${s.ok_count + s.warning_count ? "" : " disabled"}>ยืนยันบันทึก ${n2(s.ok_count + s.warning_count)} แถว</button></div>
          <div><button type="button" class="mh-btn ghost" data-act="impDiscard">ยกเลิกไฟล์นี้</button></div>
          <div class="full mh-note">แถวที่ผิดจะไม่ถูกบันทึก ทั้งไฟล์บันทึกในครั้งเดียว — ถ้าเกิดข้อผิดพลาดกลางทางจะไม่มีข้อมูลใดถูกบันทึก</div></form>`}</div>`;
    }

    function renderDone(r) {
      const batches = [...new Set((r.rows || []).map((x) => x.batch_code).filter(Boolean))];
      return `<div class="mh-card"><h3>✅ บันทึกแล้ว</h3>
        <div class="mh-grid">${Object.entries(r.counts).filter(([, n]) => n).map(([k, n]) => `<div class="mh-stat"><small>${esc(OUTCOME_TH[k] || k)}</small><b>${n2(n)}</b></div>`).join("")}</div>
        ${batches.length ? `<p style="margin-top:12px">รอบที่ปิดเข้าล็อตน้ำนม: ${batches.map((b) => `<a href="#trace" data-act="traceOpen" data-code="${esc(b)}">🔎 ${esc(b)}</a>`).join(" · ")}</p>` : ""}
        <p class="mh-note">${r.options && r.options.close_rounds ? "" : "รอบที่นำเข้ายังเปิดอยู่ — ตรวจและปิดรอบได้ที่แท็บรับน้ำนม "}ข้อมูลที่มาจากไฟล์แสดงที่มาว่า “ไฟล์” ในรอบรับนม</p>
        <button class="mh-btn ghost" data-act="impReset">นำเข้าไฟล์อื่น</button></div>`;
    }

    const readB64 = (file) => new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ""));
      r.onerror = () => rej(new Error("read_failed"));
      r.readAsDataURL(file);
    });

    FORM.impPreview = async (f) => {
      const file = f.file.files[0];
      if (!file) return;
      if (file.size > 3 * 1024 * 1024) { toast(ERR.file_too_large, true); return; }
      const content = await readB64(file);
      const b = clean(fd(f));
      const r = await API.post("/dairy/imports/preview", {
        kind: b.kind, filename: file.name, content_base64: content,
        options: { default_shift: b.default_shift, default_date: b.default_date, center_id: b.center_id, lab_name: b.lab_name },
      }).catch((e) => {
        const body = e.body || {};
        if (body.error === "missing_columns") {
          toast(`ไม่พบคอลัมน์: ${body.missing.map((m) => FIELD_TH[m] || m).join(", ")} — หัวตารางในไฟล์: ${(body.header || []).join(", ")}`, true);
        } else run(() => Promise.reject(e));
        return null;
      });
      if (!r) return;
      cur = r; filter = r.summary.error_count ? "error" : "all"; done = null;
      renderImport();
      $("#impBox").scrollIntoView({ behavior: "smooth", block: "start" });
    };
    FORM.impCommit = async (f) => {
      const b = fd(f);
      const r = await run(() => API.post(`/dairy/imports/${cur.import_id}/commit`, {
        include_warnings: !!b.include_warnings, close_rounds: !!b.close_rounds, confirm_withdrawal: !!b.confirm_withdrawal,
      }));
      if (!r) return;
      done = r; cur = null;
      X.refresh();
    };
    ACT.impFilter = (el) => { filter = el.dataset.f; renderImport(); };
    ACT.impReset = () => { done = null; cur = null; renderImport(); };
    ACT.impDiscard = async () => {
      if (cur && await run(() => API.post(`/dairy/imports/${cur.import_id}/discard`, {}), "ยกเลิกไฟล์แล้ว")) { cur = null; X.refresh(); }
    };
    ACT.impOpen = async (el) => {
      const r = await run(() => API.get(`/dairy/imports/${el.dataset.id}`));
      if (!r) return;
      cur = { ...r, import_id: r.import_id, columns: r.columns || {}, unknown_columns: [], same_file_committed_at: null };
      filter = "all"; done = null;
      renderImport();
    };
    ACT.impTemplate = async (el) => {
      try {
        const res = await fetch(`${API_BASE}/dairy/imports/template?kind=${el.dataset.kind}`, { headers: { Authorization: `Bearer ${API.getSession().access_token}` } });
        if (!res.ok) throw new Error(String(res.status));
        const a = document.createElement("a");
        a.href = URL.createObjectURL(await res.blob());
        a.download = el.dataset.kind === "quality" ? "แบบฟอร์มผลตรวจคุณภาพ.csv" : "แบบฟอร์มรับน้ำนม.csv";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      } catch (e) { toast("ดาวน์โหลดแบบฟอร์มไม่สำเร็จ", true); }
    };

    // ======================================================================
    // 🔎 ล็อตน้ำนม / ตรวจสอบย้อนกลับ
    // ======================================================================
    const BATCH_TH = { Collecting: ["กำลังรวบรวมในถัง", "warn"], Shipped: ["ส่งแล้ว รอโรงงาน", "warn"], Received: ["โรงงานรับแล้ว", "ok"], Rejected: ["โรงงานปฏิเสธ", "bad"] };
    const bst = (v) => pill(...(BATCH_TH[v] || [v, ""]));
    let traceCode = null;
    let batchStatus = "";
    ACT.traceOpen = (el) => { traceCode = el.dataset.code; if (X.show) X.show("trace"); };

    PAGES.trace = async (sec) => {
      const list = await API.get(`/dairy/milk-batches${batchStatus ? `?status=${batchStatus}` : ""}`);
      sec.innerHTML = `
        <div class="mh-card mh-noprint"><h3>ค้นหาล็อตน้ำนม</h3>
          <form data-form="traceFind" class="mh-form"><div><label>รหัสล็อต (พิมพ์บางส่วนได้)</label><input name="q" placeholder="MB-261126-…" value="${esc(traceCode || "")}"></div>
            <div><label>สถานะ</label><select name="status"><option value="">ทั้งหมด</option>${Object.entries(BATCH_TH).map(([k, [t]]) => `<option value="${k}"${batchStatus === k ? " selected" : ""}>${t}</option>`).join("")}</select></div>
            <div><button class="mh-btn">ค้นหา</button></div></form>
          <p class="mh-note">ระบบสร้างรหัสล็อตให้อัตโนมัติ: ปิดรอบรับนม → รอบเข้าล็อตที่กำลังรวบรวมของศูนย์ (นมในถังเย็น) → บันทึกเที่ยวส่งจากศูนย์ → ล็อตปิดและผูกกับเที่ยวรถ → โรงงานรับ/ปฏิเสธ</p></div>
        <div id="traceBox"></div>
        <div class="mh-card mh-noprint"><h3>ล็อตล่าสุด</h3>
          ${table(["รหัสล็อต", "ศูนย์", "รอบนม", "#รอบ", "#ฟาร์ม", "#รวบรวม (กก.)", "เที่ยวส่ง", "#ส่ง (กก.)", "#ต่าง %", "#โรงงานรับ", "สถานะ", ""], list.map((b) => `<tr>
            <td><b>${esc(b.batch_code)}</b></td><td>${esc(b.center_name)}</td><td>${d(b.first_round_date)}${b.last_round_date !== b.first_round_date ? " – " + d(b.last_round_date) : ""}</td>
            <td class="num">${b.rounds}</td><td class="num">${b.farm_count}</td><td class="num">${n2(b.accepted_kg)}</td>
            <td>${b.ship_date ? `${d(b.ship_date)} ${esc(b.vehicle || "")}<br><small>${esc(b.partner_name || "")}</small>` : "-"}</td><td class="num">${n2(b.sent_kg)}</td>
            <td class="num">${b.sent_diff_pct == null ? "-" : `<span style="color:${Math.abs(b.sent_diff_pct) > 3 ? "var(--red-600)" : "inherit"}">${b.sent_diff_pct > 0 ? "+" : ""}${n2(b.sent_diff_pct)}</span>`}</td>
            <td class="num">${n2(b.received_kg)}</td><td>${bst(b.status)}</td>
            <td><button class="mh-btn sm ghost" data-act="traceOpen" data-code="${esc(b.batch_code)}">ดูเส้นทาง</button></td></tr>`))}</div>`;
      if (traceCode) {
        const box = $("#traceBox");
        try {
          window.AgroDairyTraceView.mount(box, await API.get(`/dairy/milk-batches/${encodeURIComponent(traceCode)}/trace`), "coop", () => { traceCode = null; });
        } catch (e) { box.innerHTML = `<div class="mh-card error-box show">${esc(X.errMsg(e))}</div>`; }
      }
    };
    FORM.traceFind = async (f) => {
      const b = fd(f);
      batchStatus = b.status || "";
      const q = (b.q || "").trim().toUpperCase();
      if (!q) { traceCode = null; X.refresh(); return; }
      const hits = await run(() => API.get(`/dairy/milk-batches?q=${encodeURIComponent(q)}`));
      if (!hits) return;
      if (!hits.length) { toast(ERR.batch_not_found, true); return; }
      traceCode = hits[0].batch_code;
      X.refresh();
    };

    // ======================================================================
    // ✅ คุณภาพข้อมูล
    // ======================================================================
    let dqDays = 30;
    ACT.dqDays = (el) => { dqDays = Number(el.dataset.days); X.refresh(); };
    const SRC_COLOR = { manual: "#8a94a6", scale: "#2e7d5b", gateway: "#1f6fb2", file: "#c58a00", api: "#7b4fb3" };
    PAGES.dataquality = async (sec) => {
      const q = await API.get(`/dairy/data-quality?days=${dqDays}`);
      const total = q.intake_by_source.reduce((a, r) => a + r.records, 0);
      const bar = total ? `<div class="mh-bar" role="img" aria-label="สัดส่วนที่มาของข้อมูลรับนม">${q.intake_by_source.map((r) => `<span style="width:${(r.records / total) * 100}%;background:${SRC_COLOR[r.source] || "#999"}" title="${esc(SOURCE_TH[r.source] || r.source)} ${r.records}"></span>`).join("")}</div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px">${q.intake_by_source.map((r) => `<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${SRC_COLOR[r.source] || "#999"};margin-right:4px"></span>${esc(SOURCE_TH[r.source] || r.source)} ${n2(r.records)} รายการ (${n2((r.records / total) * 100)}%) · ${n2(r.kg)} กก.</span>`).join("")}</div>` : '<div class="mh-empty">ไม่มีข้อมูลรับนมในช่วงนี้</div>';
      const sh = q.shipments;
      const tracedPct = sh.shipments ? (sh.with_batch / sh.shipments) * 100 : null;
      const stat = (label, val, warn, hint) => `<div class="mh-stat${warn ? " warn" : ""}"><small>${label}</small><b>${val}</b>${hint ? `<small>${hint}</small>` : ""}</div>`;
      sec.innerHTML = `
        <div class="mh-card"><div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:center"><h3 style="margin:0">ตรวจคุณภาพข้อมูล ${d(q.from)} – ${d(q.to)}</h3>
          <div class="mh-filter" style="margin:0">${[7, 30, 90].map((n) => `<button class="mh-btn sm ghost${dqDays === n ? " on" : ""}" data-act="dqDays" data-days="${n}">${n} วัน</button>`).join("")}</div></div>
          <div class="mh-grid" style="margin-top:12px">
            ${stat("บันทึกโดยอุปกรณ์อัตโนมัติ", q.automated_pct == null ? "-" : n2(q.automated_pct) + "%", false, "เครื่องชั่ง/Gateway/API")}
            ${stat("รอบรับนมค้างไม่ปิด", n2(q.open_rounds.length), q.open_rounds.length > 0, "รอบก่อนวันนี้")}
            ${stat("น้ำหนักผิดปกติ", n2(q.outliers.length), q.outliers.length > 0, "> 3 เท่า หรือ < 0.2 เท่าของค่าเฉลี่ย")}
            ${stat("ส่งนมหลายศูนย์ในรอบเดียว", n2(q.multi_center.length), q.multi_center.length > 0)}
            ${stat("สมาชิกขาดผลตรวจ > 30 วัน", n2(q.members_without_recent_test.length), q.members_without_recent_test.length > 0)}
            ${stat("เที่ยวส่งที่ตรวจย้อนกลับได้", tracedPct == null ? "-" : n2(tracedPct) + "%", tracedPct != null && tracedPct < 100, `${sh.with_batch}/${sh.shipments} เที่ยว${sh.without_center ? ` · ${sh.without_center} เที่ยวไม่ระบุศูนย์` : ""}`)}
            ${stat("ล็อตที่ยอดส่งไม่ตรง (> 3%)", n2(q.batch_mismatches.length), q.batch_mismatches.length > 0)}
            ${stat("รอบที่ไม่บันทึกอุณหภูมิถัง", `${n2(q.rounds.closed_without_temp)}/${n2(q.rounds.closed)}`, q.rounds.closed_without_temp > 0)}
          </div></div>
        <div class="mh-card"><h3>ที่มาของข้อมูลรับน้ำนม</h3>${bar}
          <p class="mh-note">ผลตรวจคุณภาพ: ${q.tests_by_source.map((r) => `${esc(SOURCE_TH[r.source] || r.source)} ${n2(r.records)}`).join(" · ") || "-"}</p></div>
        ${q.open_rounds.length ? `<div class="mh-card"><h3>รอบรับนมที่ยังไม่ปิด</h3>${table(["วันที่", "รอบ", "ศูนย์", "#ราย"], q.open_rounds.map((r) => `<tr><td>${d(r.round_date)}</td><td>${shiftTh(r.shift)}</td><td>${esc(r.center_name)}</td><td class="num">${r.intakes}</td></tr>`))}
          <p class="mh-note">ปิดรอบที่แท็บรับน้ำนม — รอบที่ยังไม่ปิดยังไม่คิดเงินและยังไม่เข้าล็อตน้ำนม</p></div>` : ""}
        ${q.outliers.length ? `<div class="mh-card"><h3>น้ำหนักผิดปกติ</h3>${table(["วันที่", "รอบ", "สมาชิก", "#กก.", "#เฉลี่ย", "ที่มา"], q.outliers.map((r) => `<tr><td>${d(r.round_date)}</td><td>${shiftTh(r.shift)}</td><td>${esc(r.member_code)} ${esc(r.full_name)}</td><td class="num"><b>${n2(r.weight_kg)}</b></td><td class="num">${n2(r.avg_kg)}</td><td>${esc(SOURCE_TH[r.source] || r.source)}</td></tr>`))}</div>` : ""}
        ${q.multi_center.length ? `<div class="mh-card"><h3>สมาชิกที่มีข้อมูลรับนมหลายศูนย์ในรอบเดียวกัน</h3>${table(["วันที่", "รอบ", "สมาชิก", "ศูนย์", "#กก."], q.multi_center.map((r) => `<tr><td>${d(r.round_date)}</td><td>${shiftTh(r.shift)}</td><td>${esc(r.member_code)} ${esc(r.full_name)}</td><td>${esc(r.centers)}</td><td class="num">${n2(r.kg)}</td></tr>`))}</div>` : ""}
        ${q.batch_mismatches.length ? `<div class="mh-card"><h3>ล็อตที่ยอดส่งไม่ตรงกับที่รวบรวม</h3>${table(["ล็อต", "วันที่ส่ง", "#รวบรวม", "#ส่ง", "#ต่าง %", "#โรงงานรับ", ""], q.batch_mismatches.map((r) => `<tr><td>${esc(r.batch_code)}</td><td>${d(r.ship_date)}</td><td class="num">${n2(r.accepted_kg)}</td><td class="num">${n2(r.sent_kg)}</td><td class="num">${n2(r.diff_pct)}</td><td class="num">${n2(r.received_kg)}</td><td><button class="mh-btn sm ghost" data-act="traceOpen" data-code="${esc(r.batch_code)}">ดูเส้นทาง</button></td></tr>`))}</div>` : ""}
        ${q.members_without_recent_test.length ? `<div class="mh-card"><h3>สมาชิกที่ส่งนมแต่ไม่มีผลตรวจใน 30 วัน (${q.members_without_recent_test.length})</h3>
          <p>${q.members_without_recent_test.map((m) => `${esc(m.member_code)} ${esc(m.full_name)}${m.last_test ? ` <small>(${d(m.last_test)})</small>` : ""}`).join(" · ")}</p>
          <p class="mh-note">ไม่มีผลตรวจ ระบบคิดราคาฐานโดยไม่บวก/หักคุณภาพ — นำเข้าผลแล็บได้ที่แท็บนำเข้าไฟล์</p></div>` : ""}
        <div class="mh-card"><h3>นำเข้าไฟล์ล่าสุด</h3>${table(["เวลา", "ไฟล์", "#แถว", "#ผิด", "#เตือน", "สถานะ"], q.recent_imports.map((h) => `<tr><td>${dt(h.created_at)}</td><td>${esc(h.filename)}</td><td class="num">${h.row_count}</td><td class="num">${h.error_count}</td><td class="num">${h.warning_count}</td><td>${h.status === "Committed" ? pill("บันทึกแล้ว", "ok") : h.status === "Discarded" ? pill("ยกเลิก", "") : pill("รอยืนยัน", "warn")}</td></tr>`))}</div>`;
    };
  };
})();
