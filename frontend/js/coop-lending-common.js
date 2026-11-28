/**
 * AgroLink — สินเชื่อระหว่างสหกรณ์: ตัวช่วยที่ใช้ร่วมกันระหว่าง
 *   savingscoop/ (พอร์ทัลสหกรณ์ออมทรัพย์) และ coop/lending.html (สหกรณ์การเกษตรผู้กู้)
 * Backend: backend/src/routes/coopLending.js
 * ต้องโหลดหลัง js/api.js ของพอร์ทัลนั้น (ใช้ API_BASE และ getSession())
 */
/* global API_BASE */
const CL = (() => {
  let api = null;
  function init(portalApi) { api = portalApi; style(); }

  async function request(method, path, body) {
    const s = api.getSession();
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(s && s.access_token ? { Authorization: `Bearer ${s.access_token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) { api.logout(); throw new Error("session_expired"); }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((json && json.error) || `request_failed_${res.status}`);
      err.status = res.status; err.body = json || {};
      throw err;
    }
    return json;
  }
  const get = (p) => request("GET", p);
  const post = (p, b) => request("POST", p, b || {});
  const patch = (p, b) => request("PATCH", p, b || {});
  const put = (p, b) => request("PUT", p, b || {});

  /** อัปโหลดไฟล์หลักฐานผ่าน /storage/upload → file_id */
  async function upload(file) {
    if (file.size > 5 * 1024 * 1024) throw new Error("file_too_large");
    const b64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1]);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    const out = await post("/storage/upload", {
      purpose: "coop_lending_evidence", filename: file.name, content_type: file.type || "application/octet-stream", file_base64: b64, uploaded_by: "coop-lending",
    });
    return out.file_id;
  }

  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const baht = (n) => (n == null || n === "" ? "-" : `${Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`);
  const num = (n, d = 2) => Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: d, maximumFractionDigits: d });
  const date = (v) => (v ? new Date(String(v).length === 10 ? `${v}T00:00:00+07:00` : v).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit", timeZone: "Asia/Bangkok" }) : "-");
  const dt = (v) => (v ? new Date(v).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "-");

  const PURPOSE = { inputs: "ปัจจัยการผลิต", machinery_service: "ค่าบริการเครื่องจักร", procurement: "รับซื้อผลผลิต", asset: "ซื้อเครื่องจักร/อุปกรณ์" };
  const ITEM_ST = {
    Draft: ["ร่าง — รอแนบหลักฐาน", "#6b7a70", "#eef1ee"],
    EvidencePending: ["รอเกษตรกรยืนยัน", "#8a5a00", "#fff2cc"],
    EvidenceComplete: ["หลักฐานครบ — รอสหกรณ์ออมทรัพย์โอน", "#0b5394", "#e3eefb"],
    Funded: ["เงินเข้าบัญชีเฉพาะ — รอจ่ายผู้ขาย", "#6a1b9a", "#f3e5f5"],
    Paid: ["จ่ายผู้ขายแล้ว", "#1f6b38", "#ddf3e4"],
    Rejected: ["ปฏิเสธ", "#a1261d", "#fde8e6"],
    Disputed: ["เกษตรกรแจ้งไม่ตรง", "#a1261d", "#fde8e6"],
    Cancelled: ["ยกเลิก", "#6b7a70", "#eef1ee"],
  };
  const TR_ST = { PendingApproval: ["รอผู้อนุมัติ", "#8a5a00", "#fff2cc"], Submitted: ["ส่งธนาคารแล้ว", "#0b5394", "#e3eefb"], Succeeded: ["โอนสำเร็จ", "#1f6b38", "#ddf3e4"], Failed: ["โอนไม่สำเร็จ", "#a1261d", "#fde8e6"], Cancelled: ["ยกเลิก", "#6b7a70", "#eef1ee"] };
  const TR_KIND = { disbursement: "เบิกเงินกู้เข้าบัญชีเฉพาะ", seller_payment: "จ่ายผู้ขาย", repayment: "ชำระคืนเงินกู้", installment: "ค่างวดเครื่องจักร", platform_fee: "ค่าธรรมเนียมแพลตฟอร์ม" };
  const SAT = { pass: ["ดาวเทียม: ผ่าน", "#1f6b38", "#ddf3e4"], review: ["ดาวเทียม: ต้องตรวจเพิ่ม", "#a1261d", "#fde8e6"], insufficient: ["ดาวเทียม: ข้อมูลไม่พอ", "#8a5a00", "#fff2cc"], na: ["ไม่ได้ระบุแปลง", "#6b7a70", "#eef1ee"] };
  const EVIDENCE = {
    invoice: "ใบกำกับภาษี/ใบเสร็จ", delivery_note: "ใบส่งของ", work_photo: "ภาพหน้างาน", weighing_slip: "ใบชั่งน้ำหนัก", quality_slip: "ใบตรวจคุณภาพ", purchase_receipt: "ใบรับซื้อ", acceptance_report: "ใบตรวจรับงาน/ส่งมอบ", contract: "สัญญาซื้อขาย",
    down_payment_slip: "หลักฐานจ่ายเงินดาวน์", serial_photo: "ภาพเลขเครื่อง/เลขตัวถัง", ownership_doc: "เอกสารกรรมสิทธิ์", insurance: "กรมธรรม์", other: "อื่นๆ",
  };
  const BANKS = [["002", "กรุงเทพ"], ["004", "กสิกรไทย"], ["006", "กรุงไทย"], ["011", "ทหารไทยธนชาต"], ["014", "ไทยพาณิชย์"], ["025", "กรุงศรีอยุธยา"], ["030", "ออมสิน"], ["033", "อาคารสงเคราะห์"], ["034", "ธ.ก.ส."], ["069", "เกียรตินาคินภัทร"], ["022", "ซีไอเอ็มบี"], ["024", "ยูโอบี"], ["073", "แลนด์ แอนด์ เฮ้าส์"]];
  const bankName = (c) => (BANKS.find(([k]) => k === c) || [c, c])[1];
  const pill = ([t, fg, bg]) => `<span class="cl-pill" style="color:${fg};background:${bg}">${esc(t)}</span>`;

  const ERR = {
    approver_must_differ_from_preparer: "ผู้อนุมัติต้องเป็นคนละคนกับผู้จัดทำ — ให้เจ้าหน้าที่อีกคน (หรือบัญชีหลักขององค์กร) เข้าสู่ระบบแล้วกดอนุมัติ",
    satellite_review_not_acknowledged: "มีรายการที่ภาพดาวเทียมต้องตรวจเพิ่ม — เปิดดูรายละเอียดแล้วกด \"รับทราบผลดาวเทียม\" ก่อน",
    account_not_verified: "บัญชีธนาคารยังไม่ผ่านการตรวจชื่อ", account_not_found: "ไม่พบบัญชีธนาคาร", account_required: "กรุณาเลือกบัญชีธนาคาร",
    borrower_dedicated_account_missing: "สหกรณ์การเกษตรยังไม่ได้ผูกบัญชีเฉพาะเงินกู้กับวงเงินนี้",
    evidence_incomplete: "หลักฐานยังไม่ครบ", evidence_file_already_used: "ไฟล์นี้เคยใช้เป็นหลักฐานแล้ว (ใช้ได้ครั้งเดียวทั้งแพลตฟอร์ม)",
    source_already_used: "รายการต้นทางนี้เคยใช้เบิกแล้ว", doc_no_already_used: "เลขเอกสารนี้ของผู้ขายรายนี้เคยใช้เบิกแล้ว",
    over_facility_limit: "เกินวงเงินคงเหลือ", over_purpose_limit: "เกินวงเงินของวัตถุประสงค์นี้", over_per_farmer_limit: "เกินเพดานต่อเกษตรกร", over_per_seller_limit: "เกินเพดานต่อผู้ขาย",
    facility_not_active: "วงเงินถูกระงับหรือปิดแล้ว", farmer_not_verified_member: "เกษตรกรยังไม่ใช่สมาชิกที่ยืนยันแล้วของสหกรณ์",
    seller_not_verified: "ผู้ขายยังไม่ผ่านการยืนยันตัวตน (KYB)", installment_exceeds_income_ratio: "ค่างวดสูงเกินสัดส่วนรายได้ที่โครงการกำหนด",
    down_payment_too_low: "เงินดาวน์ต่ำกว่าที่โครงการกำหนด", serial_no_already_financed: "เลขเครื่องนี้ค้ำสินเชื่ออื่นอยู่แล้ว",
    repayment_exceeds_debt: "ยอดชำระเกินยอดหนี้", payment_exceeds_installments: "ยอดเกินค่างวดที่ค้าง", lender_account_missing: "สหกรณ์ออมทรัพย์ยังไม่มีบัญชีรับเงินที่ตรวจแล้ว",
    transfer_already_pending: "มีคำสั่งโอนของรายการนี้รออนุมัติอยู่แล้ว", item_state_changed: "สถานะรายการเปลี่ยนไปแล้ว กรุณาโหลดใหม่",
    application_already_open: "มีคำขอที่รอพิจารณาอยู่แล้ว", program_limit_exhausted: "วงเงินโครงการไม่พอ", over_per_borrower_limit: "เกินเพดานต่อสหกรณ์ผู้กู้",
    platform_account_not_set: "ผู้ดูแลแพลตฟอร์มยังไม่ได้ตั้งบัญชีรับค่าธรรมเนียม", file_too_large: "ไฟล์ใหญ่เกิน 5 MB",
    plan_not_active: "แผนการผลิตยังไม่อนุมัติหรือถูกระงับอยู่", no_open_stage: "แผนนี้ยังไม่มีงวดที่เปิดให้เบิก", over_stage_amount: "เกินเงินของงวดนี้",
    purpose_not_in_stage: "วัตถุประสงค์นี้ไม่อยู่ในงวดปัจจุบัน", farmer_not_in_plan: "เกษตรกรไม่ตรงกับแผน", stage_not_open: "งวดนี้ยังไม่เปิด (ต้องผ่านงวดก่อนหน้า)",
    stage_check_not_submitted: "ยังไม่ได้ส่งผลตรวจแปลงของงวดนี้", satellite_review_needs_reason: "ผลดาวเทียมต้องตรวจเพิ่ม — ระบุเหตุผลที่ให้ผ่าน (อย่างน้อย 5 ตัวอักษร)",
    plan_suspended: "แผนการผลิตของรายการนี้ถูกระงับอยู่", plan_already_decided: "แผนนี้พิจารณาไปแล้ว", plan_not_suspended: "แผนนี้ไม่ได้ถูกระงับ",
    plan_not_cancellable: "ยกเลิกได้เฉพาะแผนที่ยังไม่อนุมัติ", crop_not_supported: "พืชของแปลงนี้ยังไม่มีแบบงวด (รองรับข้าว ข้าวโพดเลี้ยงสัตว์ มันสำปะหลัง)",
    plot_not_found_or_not_member: "ไม่พบแปลง หรือเจ้าของแปลงไม่ใช่สมาชิกของสหกรณ์", program_has_no_production_purpose: "โครงการนี้ไม่ได้ให้กู้เพื่อปัจจัยการผลิต",
    stage_amounts_must_sum_to_total: "ยอดรายงวดรวมกันต้องเท่ากับยอดทั้งแผน", stage_not_holdable: "ระงับได้เฉพาะงวดที่เปิดอยู่หรือรอตรวจ", facility_expired: "วงเงินหมดอายุแล้ว",
    duplicate_open_plan: "แปลงนี้มีแผนที่ยังไม่จบอยู่แล้ว", check_file_already_used: "ภาพนี้เคยใช้ตรวจแปลงแล้ว",
    listing_incomplete: "ข้อมูลโครงการยังไม่ครบ", listing_not_editable: "แก้ไขได้เฉพาะโครงการที่เป็นร่างหรือถูกส่งกลับ", listing_not_open: "โครงการนี้ไม่ได้เปิดรับข้อเสนอแล้ว",
    offers_closed: "ปิดรับข้อเสนอแล้ว", offer_over_requested: "เกินวงเงินที่ขอ", over_requested_amount: "ข้อเสนอที่เลือกรวมกันเกินวงเงินที่ขอ", no_confirmed_offer: "ยังไม่มีข้อเสนอที่ผู้ให้กู้ยืนยันตามอำนาจอนุมัติ",
    confirmed_below_minimum: "ข้อเสนอที่ยืนยันแล้วรวมกันยังไม่ถึงวงเงินขั้นต่ำ", offer_not_counterable: "โต้ตอบได้เฉพาะข้อเสนอที่รอพิจารณา", offer_not_acceptable: "เลือกได้เฉพาะข้อเสนอที่รอพิจารณา (ถ้าโต้ตอบไว้ ต้องรอผู้ให้กู้ตอบก่อน)",
    offer_not_accepted: "ข้อเสนอนี้ยังไม่ถูกผู้ขอกู้เลือก", lender_profile_required: "กรอกข้อมูลและนโยบายสินเชื่อของสหกรณ์ก่อนยื่นข้อเสนอ", agreement_not_signable: "สัญญานี้ลงนามครบแล้วหรือถูกยกเลิก",
    price_check_not_acknowledged: "ราคารับซื้อต่างจากราคาอ้างอิงเกิน 15% — เปิดดูแล้วกด \"รับทราบ\" ก่อน", counter_empty: "ระบุเงื่อนไขที่ต้องการอย่างน้อยหนึ่งข้อ", invalid_project_type: "เลือกประเภทโครงการ",
    listing_not_in_review: "โครงการไม่ได้อยู่ในสถานะรอตรวจสอบ",
    compliance_not_passed: "สหกรณ์ยังไม่ผ่านการตรวจคุณสมบัติผู้ให้กู้", no_open_tranche: "สัญญานี้ยังไม่มีงวดที่เปิดให้เบิก — งวดก่อนหน้ารอผู้ให้กู้ตรวจปิดยอด",
    over_tranche_amount: "เกินเงินของงวดนี้", tranche_not_ready: "ยังปิดยอดงวดไม่ได้", tranche_not_open: "งวดนี้ไม่ได้เปิดอยู่", tranche_not_submitted: "งวดนี้ยังไม่ได้ส่งปิดยอด",
    tranche_not_checked: "งวดนี้ยังไม่ผ่านผู้ตรวจสอบ", approver_must_differ_from_checker: "ผู้อนุมัติต้องเป็นคนละคนกับผู้ตรวจสอบงวดนี้", not_lead_lender: "เฉพาะผู้ให้กู้หลักของสัญญาเป็นผู้ตรวจปิดยอดงวด",
    agreement_not_signed: "สัญญายังลงนามไม่ครบ", below_verification_level: "หลักฐานของรายการนี้ยังไม่ถึงระดับที่ผู้ให้กู้กำหนด",
    golive_gate_not_passed: "ยังไม่ผ่านเงื่อนไขก่อนเปิดใช้งานจริง (Go-live Gate) — ระบบไม่สั่งโอนผ่านธนาคารจริง", check_not_found: "ไม่พบรายการตรวจ",
    alert_not_found: "ไม่พบเรื่องนี้ หรือยังไม่เปิดให้ชี้แจง", parties_required: "ระบุรายชื่อผู้เกี่ยวข้อง", invalid_tax_id: "เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก",
    invalid_text: "ข้อความสั้นหรือยาวเกินไป", invalid_number: "ตัวเลขไม่ถูกต้อง", only_admin_can_manage_staff: "เฉพาะผู้ดูแลหรือผู้จัดการเท่านั้นที่จัดการเจ้าหน้าที่ได้",
  };
  function errText(err) {
    const b = err.body || {};
    let msg = ERR[err.message] || err.message;
    if (b.available !== undefined) msg += ` (คงเหลือ ${baht(b.available)})`;
    if (b.missing) {
      const m = b.missing;
      const parts = [...(m.missingKinds || []).map((k) => EVIDENCE[k] || k), ...(m.missingFields || []).map((f) => ({ service_date: "วันที่ทำงาน", service_area_rai: "พื้นที่ (ไร่)" }[f] || f))];
      if (m.needPayout) parts.push("บัญชีรับเงินของผู้ขาย");
      if (parts.length) msg += `: ${parts.join(", ")}`;
    }
    if (b.ratio_pct !== undefined) msg += ` (${b.ratio_pct}% เกิน ${b.max_ratio_pct}%)`;
    if (b.field) msg += ` [${b.field}]`;
    if (Array.isArray(b.missing)) msg += `: ${b.missing.map((m) => m.label).join(", ")}`;
    if (Array.isArray(b.blockers)) msg += `: ${b.blockers.join(" · ")}`;
    if (Array.isArray(b.checks)) msg += `: ${b.checks.map((c) => `${c.label} (${c.detail})`).join(" · ")}`;
    if (b.required_level !== undefined) msg += ` (ต้องการระดับ ${b.required_level} ปัจจุบัน ${b.level})`;
    return msg;
  }
  function toast(msg, bad) {
    let el = document.getElementById("clToast");
    if (!el) { el = document.createElement("div"); el.id = "clToast"; el.className = "cl-toast"; document.body.appendChild(el); }
    el.textContent = msg;
    el.style.background = bad ? "#a1261d" : "#1f6b38";
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), bad ? 6000 : 3000);
  }
  /** ปุ่มที่เรียก API: ปิดปุ่มระหว่างทำงาน แสดงผลด้วย toast */
  async function act(btn, fn, okMsg) {
    if (btn) btn.disabled = true;
    try {
      const r = await fn();
      if (okMsg) toast(typeof okMsg === "function" ? okMsg(r) : okMsg);
      return r;
    } catch (err) {
      toast(errText(err), true);
      return null;
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  const formData = (form) => Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]));
  const bankOptions = () => BANKS.map(([k, v]) => `<option value="${k}">${k} ${esc(v)}</option>`).join("");
  const accLabel = (a) => `${bankName(a.bank_code)} ${a.account_no_masked || `xxx-x-${a.from_tail || a.to_tail || ""}`} ${a.account_name}`;

  function sandboxBanner(bank) {
    if (!bank || bank.live) return "";
    return `<div class="cl-sandbox">⚠️ ${esc(bank.label_th)} — ใช้ทดลองกระบวนการได้ แต่เงินจะไม่ถูกโอนจริงจนกว่าจะเชื่อมธนาคารคู่ค้า</div>`;
  }

  let styled = false;
  function style() {
    if (styled) return;
    styled = true;
    const s = document.createElement("style");
    s.textContent = `
      .cl-wrap { max-width: 1180px; margin: 0 auto; padding: 18px 16px 48px; box-sizing: border-box; }
      .cl-tabs { display:flex; flex-wrap:wrap; gap:6px; margin: 4px 0 16px; }
      .cl-tab { border:1px solid var(--gray-300,#d7ddd8); background:#fff; border-radius:20px; padding:7px 14px; font:inherit; font-size:14px; cursor:pointer; }
      .cl-tab.active { background: var(--green-700,#2e7d32); color:#fff; border-color: var(--green-700,#2e7d32); font-weight:600; }
      .cl-tab .cl-count { background:#f0b429; color:#1b3a1f; border-radius:20px; padding:0 7px; font-size:12px; font-weight:700; margin-left:4px; }
      .cl-card { background:#fff; border-radius: var(--radius,14px); box-shadow: var(--shadow, 0 2px 10px rgba(27,58,31,.08)); padding:16px 18px; margin-bottom:14px; }
      .cl-card h3 { margin:0 0 6px; font-size:16px; }
      .cl-row { display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:flex-start; }
      .cl-muted { color: var(--gray-500,#7b867e); font-size:13px; }
      .cl-line { font-size:13.5px; color:#3a463e; margin-top:4px; }
      .cl-pill { border-radius:20px; padding:2px 10px; font-size:12px; font-weight:700; white-space:nowrap; display:inline-block; }
      .cl-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; align-items:center; }
      .cl-btn { border:0; border-radius:9px; padding:8px 14px; font:inherit; font-size:13.5px; font-weight:700; cursor:pointer; background: var(--green-700,#2e7d32); color:#fff; }
      .cl-btn.ghost { background: var(--gray-100,#eef1ee); color:#1d2b22; } .cl-btn.bad { background:#fde8e6; color:#a1261d; } .cl-btn.blue { background:#0b5394; }
      .cl-btn:disabled { opacity:.55; cursor:not-allowed; }
      .cl-form { display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:10px 14px; align-items:end; }
      .cl-form label { display:block; font-size:12.5px; color:#4a554d; margin-bottom:4px; font-weight:600; }
      .cl-form input, .cl-form select, .cl-form textarea, .cl-inline input, .cl-inline select { width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid var(--gray-300,#d7ddd8); border-radius:9px; font:inherit; font-size:14px; background:#fff; }
      .cl-form .wide { grid-column: 1 / -1; }
      .cl-inline { display:flex; gap:8px; flex-wrap:wrap; align-items:center; } .cl-inline input, .cl-inline select { width:auto; min-width:140px; }
      .cl-table { width:100%; border-collapse:collapse; font-size:13.5px; } .cl-table th, .cl-table td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--gray-100,#eef1ee); vertical-align:top; }
      .cl-table th { color:#55605a; font-weight:600; font-size:12.5px; } .cl-table td.r, .cl-table th.r { text-align:right; }
      .cl-stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap:12px; margin-bottom:14px; }
      .cl-stat { background:#fff; border-radius: var(--radius,14px); box-shadow: var(--shadow, 0 2px 10px rgba(27,58,31,.08)); padding:14px 16px; }
      .cl-stat .v { font-size:18px; font-weight:700; color: var(--green-900,#1b3a1f); } .cl-stat .l { font-size:12.5px; color:#6b7a70; } .cl-stat.warn .v { color:#a1261d; }
      .cl-sandbox { background:#fff4e0; border:1px solid #f0c36d; color:#6b4a00; padding:10px 14px; border-radius:10px; font-size:13.5px; margin-bottom:14px; }
      .cl-late { color:#a1261d; font-weight:700; }
      .cl-flag { background:#fde8e6; color:#7a1d16; border-radius:8px; padding:6px 10px; font-size:13px; margin-top:6px; }
      .cl-ev { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; } .cl-ev a, .cl-ev span { font-size:12.5px; background:#eef6f0; border-radius:8px; padding:3px 9px; color:#1f4f2c; text-decoration:none; }
      .cl-ev .miss { background:#fff2cc; color:#6b4a00; }
      .cl-kpis { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:8px; } .cl-kpi { background:#f4f7f4; border-radius:10px; padding:8px 10px; }
      .cl-kpi b { display:block; font-size:17px; color:#1f4f2c; } .cl-kpi span { font-size:12px; color:#6b7a70; }
      .cl-toast { position:fixed; left:50%; bottom:22px; transform:translateX(-50%) translateY(30px); opacity:0; color:#fff; padding:11px 18px; border-radius:12px; font-size:14px; max-width:92vw; transition:all .25s; z-index:50; box-shadow:0 6px 24px rgba(0,0,0,.2); }
      .cl-toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
      .cl-empty { color:#7b867e; font-size:14px; padding:6px 0; }
      .cl-track { display:flex; gap:4px; margin:10px 0 4px; } .cl-track > div { flex:1; min-width:0; border-radius:8px; padding:6px 7px; font-size:11.5px; line-height:1.3; border:1px solid transparent; }
      .cl-track .Locked { background:#f3f5f3; color:#8a948d; } .cl-track .Open { background:#e3eefb; color:#0b5394; border-color:#9cc0e8; font-weight:700; }
      .cl-track .CheckSubmitted { background:#fff2cc; color:#6b4a00; border-color:#f0c36d; font-weight:700; } .cl-track .Passed { background:#ddf3e4; color:#1f6b38; }
      .cl-track .Held { background:#fde8e6; color:#a1261d; border-color:#f1a59e; font-weight:700; } .cl-track b { display:block; font-size:12px; }
      .cl-bar { height:8px; background:#eef1ee; border-radius:8px; overflow:hidden; } .cl-bar > i { display:block; height:100%; background: var(--green-700,#2e7d32); }
      details.cl-more summary { cursor:pointer; font-size:13px; color:#0b5394; margin-top:8px; }
    `;
    document.head.appendChild(s);
  }

  /** เปิดไฟล์หลักฐาน (path เช่น /savings/evidence/<id>/file) ด้วย token ของพอร์ทัล */
  async function openFile(path) {
    const s = api.getSession();
    const w = window.open("", "_blank");
    const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${s.access_token}` } });
    if (!res.ok) { if (w) w.close(); toast("เปิดไฟล์ไม่ได้ (สิทธิ์ไม่พอหรือไฟล์ไม่พบ)", true); return; }
    const url = URL.createObjectURL(await res.blob());
    if (w) w.location.href = url; else window.open(url, "_blank");
  }

  const PLAN_ST = { Submitted: ["รอสหกรณ์ออมทรัพย์อนุมัติ", "#8a5a00", "#fff2cc"], Active: ["กำลังดำเนินการ", "#0b5394", "#e3eefb"], Suspended: ["ระงับชั่วคราว", "#a1261d", "#fde8e6"],
    Completed: ["ครบทุกงวด", "#1f6b38", "#ddf3e4"], Rejected: ["ไม่อนุมัติ", "#a1261d", "#fde8e6"], Cancelled: ["ยกเลิก", "#6b7a70", "#eef1ee"] };
  const STAGE_ST = { Locked: "ยังไม่ถึง", Open: "เปิดให้เบิก", CheckSubmitted: "รอตรวจผลแปลง", Passed: "ผ่านแล้ว", Held: "ระงับ" };
  /** แถบความคืบหน้ารายงวดของแผนสินเชื่อการผลิต */
  function planTrack(p) {
    return `<div class="cl-track">${(p.stages || []).map((st) => `<div class="${st.status}" title="${esc(st.check_method_th)}"><b>${st.seq}. ${esc(st.name_th)}</b>${esc(STAGE_ST[st.status])} · ${baht(st.planned_amount)}${Number(st.disbursed) ? `<br>เบิกแล้ว ${baht(st.disbursed)}` : ""}</div>`).join("")}</div>`;
  }
  function satNotes(d) {
    if (!d) return "";
    return `${(d.notes || []).map((n) => esc(n)).join(" · ")}${d.season_status ? ` <span class="cl-muted">(สถานะฤดู: ${esc(d.season_status)}${d.planting_date ? `, ปลูก ${esc(date(d.planting_date))}` : ""}${d.assessed_at ? `, ประเมิน ${esc(date(d.assessed_at))}` : ""})</span>` : ""}`;
  }

  // ---- ตลาดสินเชื่อระหว่างสหกรณ์ ----
  const PTYPE = { member_onlending: "กู้เพื่อปล่อยกู้ต่อแก่สมาชิก", procurement: "ทุนหมุนเวียนรับซื้อผลผลิต", investment: "ลงทุนโครงการใหม่ของสหกรณ์" };
  const LISTING_ST = {
    Draft: ["ร่าง", "#6b7a70", "#eef1ee"], Review: ["รอตรวจสอบ", "#8a5a00", "#fff2cc"], Returned: ["ส่งกลับให้แก้", "#a1261d", "#fde8e6"], Listed: ["ประกาศแล้ว", "#0b5394", "#e3eefb"],
    Offered: ["มีข้อเสนอ", "#0b5394", "#d6e6fa"], Matched: ["จับคู่แล้ว รอลงนาม", "#6b3fa0", "#efe6fa"], Signed: ["ลงนามแล้ว · เบิกจ่าย/ชำระคืน", "#1f6b38", "#ddf3e4"],
    Active: ["ระหว่างเบิกจ่าย/ชำระคืน", "#1f6b38", "#ddf3e4"], Closed: ["ปิดโครงการ", "#6b7a70", "#eef1ee"], Withdrawn: ["ถอนแล้ว", "#6b7a70", "#eef1ee"],
  };
  const OFFER_ST = {
    Submitted: ["รอผู้ขอกู้พิจารณา", "#0b5394", "#e3eefb"], Countered: ["ผู้ขอกู้โต้ตอบ — รอผู้ให้กู้", "#8a5a00", "#fff2cc"], Accepted: ["ผู้ขอกู้เลือกแล้ว — รอผู้ให้กู้ยืนยัน", "#6b3fa0", "#efe6fa"],
    Confirmed: ["ผู้ให้กู้ยืนยันแล้ว", "#1f6b38", "#ddf3e4"], Declined: ["ไม่ถูกเลือก", "#6b7a70", "#eef1ee"], Withdrawn: ["ถอนแล้ว", "#6b7a70", "#eef1ee"],
    Expired: ["สิ้นผล", "#6b7a70", "#eef1ee"], Superseded: ["จับคู่กับรายอื่นแล้ว", "#6b7a70", "#eef1ee"],
  };
  const GRADE_C = { A: "#1f6b38", B: "#4a8a2e", C: "#8a5a00", D: "#a1261d", E: "#a1261d" };
  const gradeBadge = (g, sc) => (g ? `<span class="cl-pill" style="color:#fff;background:${GRADE_C[g]}">เกรด ${g}${sc != null ? ` · ${sc}` : ""}</span>` : '<span class="cl-pill" style="background:#eef1ee;color:#6b7a70">ยังไม่มีคะแนน</span>');
  function scorePanel(sc) {
    if (!sc) return "";
    return `<div class="cl-row"><div><b>คะแนนความน่าเชื่อถือ</b> ${gradeBadge(sc.grade, sc.score)}</div><div class="cl-muted">ข้อมูล ณ ${esc(date(sc.data_as_of))} · ความครบถ้วนของข้อมูล ${sc.completeness_pct}%</div></div>
      ${sc.note ? `<div class="cl-flag">${esc(sc.note)}</div>` : ""}
      ${sc.guidance ? `<div class="cl-line">${esc(sc.guidance)}</div>` : ""}
      ${sc.groups ? `<div class="cl-kpis" style="margin-top:6px">${sc.groups.map((g) => `<div class="cl-kpi"><b>${g.points}/${g.max}</b><span>${esc(g.label)}</span></div>`).join("")}</div>` : ""}
      <table class="cl-table" style="margin-top:6px"><tr><th>ปัจจัย</th><th>ค่า</th><th class="r">คะแนน</th><th>หมายเหตุ</th></tr>
      ${sc.factors.map((f) => `<tr><td>${esc(f.label)}</td><td>${esc(f.value ?? "—")}</td><td class="r"><b>${f.points}</b>/${f.max}</td><td class="cl-muted">${esc(f.note || "")}</td></tr>`).join("")}</table>
      <div class="cl-muted">เกรด A ≥ 85 · B 70–84 · C 55–69 · D < 55 — คำนวณจากข้อมูลที่สหกรณ์บันทึกและประวัติในระบบ เป็นข้อมูลประกอบ ผู้ให้กู้ตัดสินใจตามระเบียบของตน</div>`;
  }
  /** Project Credit Score / Activity Performance Score: { score, grade, guidance, factors } */
  function factorPanel(title, sc, foot) {
    if (!sc) return "";
    return `<div class="cl-row"><div><b>${esc(title)}</b> ${gradeBadge(sc.grade, sc.score)}</div><div class="cl-muted">${esc(sc.guidance || "")}</div></div>
      <table class="cl-table" style="margin-top:6px"><tr><th>ปัจจัย</th><th class="r">คะแนน</th><th>ที่มา</th></tr>
      ${sc.factors.map((f) => `<tr><td>${esc(f.label)}</td><td class="r"><b>${f.points}</b>/${f.max}</td><td class="cl-muted">${esc(f.note || "")}</td></tr>`).join("")}</table>${foot ? `<div class="cl-muted">${esc(foot)}</div>` : ""}`;
  }
  const LEVEL_C = ["#a1261d", "#8a5a00", "#4a8a2e", "#1f6b38", "#0b5394", "#6b3fa0"];
  const LEVEL_TH = ["ยังไม่มีหลักฐาน", "เอกสารที่สหกรณ์ส่ง", "ยืนยันกับคู่ค้า/สมาชิก", "ธุรกรรมธนาคาร", "IoT/ภาคสนาม", "ผู้ตรวจอิสระ"];
  const levelBadge = (lv) => { const v = Number(lv) || 0; return `<span class="cl-pill" title="ระดับความน่าเชื่อถือของหลักฐาน" style="color:#fff;background:${LEVEL_C[v]}">หลักฐาน L${v} · ${LEVEL_TH[v]}</span>`; };
  const CHK_ICON = { pass: "✅", fail: "❌", pending: "⏳" };
  function compliancePanel(st) {
    if (!st) return "";
    return `<div class="cl-row"><div><b>คุณสมบัติผู้ให้กู้</b> ${st.ok ? '<span class="cl-pill" style="background:#ddf3e4;color:#1f6b38">ผ่านครบ</span>' : `<span class="cl-pill" style="background:#fde8e6;color:#a1261d">ผ่าน ${st.passed}/${st.checks.length}</span>`}</div></div>
      <table class="cl-table" style="margin-top:6px">${st.checks.map((c) => `<tr><td>${CHK_ICON[c.status]} ${esc(c.label)}</td><td class="cl-muted">${esc(c.detail || "")}</td></tr>`).join("")}</table>`;
  }
  function dairyPanel(d) {
    if (!d) return "";
    return `<div class="cl-row"><div><b>🥛 ข้อมูลจริงจาก${esc(d.source)}</b> <span class="cl-pill" style="background:#e3eefb;color:#0b5394">หลักฐานระดับ 4</span></div><div class="cl-muted">${esc(date(d.from))} – ${esc(date(d.to))} (${d.days} วัน)</div></div>
      <div class="cl-kpis" style="margin-top:6px">
        <div class="cl-kpi"><b>${num(d.accepted_kg, 0)}</b><span>กก. รับจากสมาชิก (${d.rounds} รอบ)</span></div>
        <div class="cl-kpi"><b>${num(d.farms, 0)}</b><span>ฟาร์มที่ส่งนม</span></div>
        <div class="cl-kpi"><b>${num(d.factory_received_kg, 0)}</b><span>กก. โรงงานรับ (${d.shipments} เที่ยว${d.rejected_shipments ? ` · ถูกปฏิเสธ ${d.rejected_shipments}` : ""})</span></div>
        <div class="cl-kpi"><b>${baht(d.factory_value)}</b><span>มูลค่าขายโรงงาน</span></div>
        <div class="cl-kpi"><b>${d.automated_pct == null ? "—" : `${num(d.automated_pct, 1)}%`}</b><span>รายการจากเครื่องชั่ง/Gateway</span></div>
        <div class="cl-kpi"><b>${d.settlements_paid}</b><span>งวดจ่ายค่านมสมาชิกแล้ว</span></div></div>`;
  }
  const TRANCHE_ST = { Locked: ["ยังไม่เปิด", "#6b7a70", "#eef1ee"], Open: ["เปิดให้เบิก", "#0b5394", "#e3eefb"], Submitted: ["ส่งปิดยอด — รอผู้ตรวจ", "#8a5a00", "#fff2cc"],
    Checked: ["ตรวจแล้ว — รอผู้อนุมัติ", "#6b3fa0", "#efe6fa"], Verified: ["ปิดยอดแล้ว", "#1f6b38", "#ddf3e4"] };
  /** ตารางงวด + สรุปปิดยอด; actions(t) คืน HTML ปุ่ม/ฟอร์มของแต่ละงวด */
  function tranchePanel(trs, actions) {
    if (!trs || !trs.length) return "";
    return `<h3>งวดเบิกตามกิจกรรม</h3><div class="cl-muted">เบิกได้ทีละงวด — งวดถัดไปเปิดเมื่อผู้ให้กู้หลักตรวจปิดยอดงวดก่อน (ผู้ตรวจสอบและผู้อนุมัติคนละคน) · ผู้ให้กู้หลัก: ${esc(trs[0].lead_lender_name)}</div>
      ${trs.map((t) => {
    const r = t.reconciliation || (t.preview && t.preview.summary);
    const blk = t.preview && t.status === "Open" ? t.preview.blockers : [];
    return `<div class="cl-card" style="margin:8px 0 0;background:#fafcfa" data-seq="${t.seq}"><div class="cl-row"><div><b>งวดที่ ${t.seq}</b> ${esc(t.name)} · ${baht(t.amount)}${t.timing ? ` · ${esc(t.timing)}` : ""}</div><div>${pill(TRANCHE_ST[t.status])}</div></div>
      <div class="cl-line">เบิกแล้ว ${baht(t.used)} · คงเหลือ ${baht(t.available)} · ${t.item_count} รายการ${r ? ` · จ่ายผู้ขายแล้ว ${r.paid_items}/${r.items} · ผู้ขาย ${r.sellers} ราย${r.weighed_kg ? ` · รับซื้อ ${num(r.weighed_kg, 0)} กก.` : ""} · ระดับหลักฐานต่ำสุด L${r.min_level} เฉลี่ย ${r.avg_level}` : ""}</div>
      ${r && (r.inventory_kg != null || r.sales_amount != null) ? `<div class="cl-line">ผู้กู้รายงาน: สินค้าคงเหลือ ${r.inventory_kg != null ? `${num(r.inventory_kg, 0)} กก.` : "-"}${r.inventory_value != null ? ` (${baht(r.inventory_value)})` : ""} · ยอดขาย ${r.sales_amount != null ? baht(r.sales_amount) : "-"}</div>` : ""}
      ${r && r.dairy ? `<div class="cl-line">🥛 ระหว่างงวด: รับนม ${num(r.dairy.accepted_kg, 0)} กก. · โรงงานรับ ${num(r.dairy.factory_received_kg, 0)} กก. · ${baht(r.dairy.factory_value)}</div>` : ""}
      ${t.borrower_input && t.borrower_input.note ? `<div class="cl-muted">หมายเหตุผู้กู้: ${esc(t.borrower_input.note)}</div>` : ""}
      ${t.check_note ? `<div class="cl-muted">ผู้ตรวจสอบ: ${esc(t.check_note)}</div>` : ""}
      ${t.returned_note && t.status === "Open" ? `<div class="cl-flag">ผู้ให้กู้ส่งกลับ: ${esc(t.returned_note)}</div>` : ""}
      ${blk.length ? `<div class="cl-ev">${blk.map((b) => `<span class="miss">${esc(b)}</span>`).join("")}</div>` : ""}
      ${actions ? actions(t) : ""}</div>`;
  }).join("")}`;
  }
  function riskPanel(r) {
    if (!r || !r.indicators.length) return "";
    return `<table class="cl-table"><tr><th>ตัวชี้วัดโครงการ</th><th>ค่า</th><th></th><th>เกณฑ์</th></tr>${r.indicators.map((i) => `<tr><td>${esc(i.label)}</td><td>${esc(typeof i.value === "number" ? num(i.value) : i.value ?? "—")}</td><td>${i.ok ? "✅" : "⚠️"}</td><td class="cl-muted">${esc(i.note)}</td></tr>`).join("")}</table>`;
  }
  // ---- เตือนภัยล่วงหน้า (Blueprint 9.3) และสัญญาณทุจริต (10.3) ----
  const ALERT_ST = { Open: ["รอตรวจสอบ", "#8a5a00", "#fff2cc"], Investigating: ["กำลังสอบสวน", "#a1261d", "#fde8e6"], Resolved: ["ดำเนินการแล้ว", "#1f6b38", "#ddf3e4"], Dismissed: ["ตรวจแล้วไม่พบปัญหา", "#6b7a70", "#eef1ee"] };
  const ALERT_CAT = { early_warning: "⚠️ เตือนภัยล่วงหน้า", fraud: "🔎 สัญญาณที่ต้องตรวจสอบ" };
  const ALERT_NOTE = "ทุกรายการเป็นสัญญาณที่ระบบตรวจพบและต้องตรวจสอบ ไม่ใช่ข้อสรุปว่ามีการทุจริต — ผู้ดูแลแพลตฟอร์มสอบสวน สหกรณ์ผู้กู้ชี้แจงได้ทุกเรื่อง";
  /** alerts จาก GET .../market/risk · actions(a) คืน HTML ปุ่ม/ฟอร์มต่อรายการ (ผู้ดูแล/ผู้กู้) */
  function alertsPanel(alerts, { title = "เตือนภัยล่วงหน้าและสัญญาณที่ต้องตรวจสอบ", actions, showBorrower = false, empty = "ไม่พบสัญญาณความเสี่ยง" } = {}) {
    const list = alerts || [];
    const open = list.filter((a) => ["Open", "Investigating"].includes(a.status) && a.active !== false);
    const row = (a) => `<div class="cl-card" style="margin:8px 0 0;background:${a.severity === "high" && open.includes(a) ? "#fff7f6" : "#fafcfa"}" data-alert="${a.alert_id}">
      <div class="cl-row"><div>${a.severity === "high" ? "🔴" : "🟠"} <b>${esc(a.title)}</b> <span class="cl-muted">· ${esc(ALERT_CAT[a.category] || "")}${showBorrower ? ` · ${esc(a.borrower_name)}` : ""}${a.listing_title ? ` · ${esc(a.listing_title)}` : ""}</span></div>
        <div>${pill(ALERT_ST[a.status])}${a.active === false ? ' <span class="cl-pill" style="background:#eef1ee;color:#6b7a70">ไม่พบเงื่อนไขแล้ว</span>' : ""}</div></div>
      <div class="cl-line">${esc(a.detail)}</div>
      ${a.extra && a.extra.changes ? `<table class="cl-table">${a.extra.changes.map((x) => `<tr><td>ปี ${esc(x.year)}</td><td>${esc(x.label || x.field)}</td><td class="r">${num(x.from, 0)} → ${num(x.to, 0)}</td><td class="r">${num(x.pct, 1)}%</td></tr>`).join("")}</table>` : ""}
      <div class="cl-muted">พบครั้งแรก ${esc(dt(a.first_seen_at))} · ล่าสุด ${esc(dt(a.last_seen_at))}</div>
      ${a.borrower_note ? `<div class="cl-line">💬 ผู้กู้ชี้แจง (${esc(dt(a.borrower_note_at))}): ${esc(a.borrower_note)}</div>` : ""}
      ${a.decision_note ? `<div class="cl-line">🏛️ ผู้ดูแลแพลตฟอร์ม: ${esc(a.decision_note)}</div>` : ""}
      ${actions ? actions(a) : ""}</div>`;
    const closed = list.filter((a) => !open.includes(a));
    return `<h3>🚨 ${esc(title)} ${open.length ? `(${open.length} เรื่องเปิดอยู่)` : ""}</h3><div class="cl-muted">${esc(ALERT_NOTE)}</div>
      ${open.map(row).join("") || `<div class="cl-empty">${esc(empty)}</div>`}
      ${closed.length ? `<details class="cl-more"><summary>เรื่องที่ปิดแล้วหรือไม่พบเงื่อนไขแล้ว (${closed.length})</summary>${closed.map(row).join("")}</details>` : ""}`;
  }
  /** ดาวน์โหลดไฟล์จาก API ด้วย token ของพอร์ทัล */
  async function download(path, filename) {
    const s = api.getSession();
    const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${s.access_token}` } });
    if (!res.ok) { toast("ดาวน์โหลดไม่สำเร็จ", true); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await res.blob());
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }
  const PROVINCES = [["BANGKOK", "กรุงเทพมหานคร"], ["NAKHON_RATCHASIMA", "นครราชสีมา"], ["KHON_KAEN", "ขอนแก่น"], ["UBON_RATCHATHANI", "อุบลราชธานี"], ["SURIN", "สุรินทร์"], ["BURIRAM", "บุรีรัมย์"],
    ["ROI_ET", "ร้อยเอ็ด"], ["UDON_THANI", "อุดรธานี"], ["CHAIYAPHUM", "ชัยภูมิ"], ["SISAKET", "ศรีสะเกษ"], ["CHIANG_MAI", "เชียงใหม่"], ["CHIANG_RAI", "เชียงราย"], ["NAKHON_SAWAN", "นครสวรรค์"],
    ["PHITSANULOK", "พิษณุโลก"], ["SUPHAN_BURI", "สุพรรณบุรี"], ["AYUTTHAYA", "พระนครศรีอยุธยา"], ["SARABURI", "สระบุรี"], ["RATCHABURI", "ราชบุรี"], ["CHANTHABURI", "จันทบุรี"], ["SURAT_THANI", "สุราษฎร์ธานี"], ["SONGKHLA", "สงขลา"]];

  return {
    PTYPE, LISTING_ST, OFFER_ST, gradeBadge, scorePanel, riskPanel, download, PROVINCES,
    factorPanel, levelBadge, compliancePanel, dairyPanel, tranchePanel, TRANCHE_ST, alertsPanel, ALERT_ST, ALERT_CAT, ALERT_NOTE,
    PLAN_ST, STAGE_ST, planTrack, satNotes,
    init, get, post, patch, put, upload, esc, baht, num, date, dt, PURPOSE, ITEM_ST, TR_ST, TR_KIND, SAT, EVIDENCE, BANKS, bankName, pill,
    errText, toast, act, formData, bankOptions, accLabel, sandboxBanner, openFile,
  };
})();
