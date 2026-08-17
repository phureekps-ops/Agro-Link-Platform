const toastEl = document.getElementById("toast");
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = "toast show" + (isError ? " error" : "");
  setTimeout(() => { toastEl.className = "toast"; }, 3200);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function thaiDate(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function thb(n) {
  return Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2 });
}

/**
 * Replaces the whole dashboard body with a "your KYB application is under
 * review" notice — same shape/reasoning as every other portal's own copy
 * (see lender/js/dashboard.js's showKybPendingNotice doc comment).
 */
function showKybPendingNotice(orgName, kybStatus) {
  document.getElementById("orgName").textContent = orgName || "-";
  const statusLabel = kybStatus === "Rejected" ? "ถูกปฏิเสธ" : "รอตรวจสอบ (KYB)";
  document.getElementById("mainContainer").innerHTML = `
    <div class="empty-state" style="padding:60px 24px;">
      <div style="font-size:40px; margin-bottom:14px;">⏳</div>
      <div style="font-size:17px; font-weight:700; color:var(--green-900); margin-bottom:8px;">
        ใบสมัครขององค์กรของท่านอยู่ในสถานะ: ${escapeHtml(statusLabel)}
      </div>
      <div style="font-size:14px;">
        เจ้าหน้าที่ผู้ดูแลระบบ (Platform Ops) กำลังตรวจสอบข้อมูลธุรกิจ (KYB) ของท่าน
        เมื่อได้รับการอนุมัติแล้ว ท่านจะสามารถใช้งานพอร์ทัลนี้ได้เต็มรูปแบบ —
        ลองเข้าสู่ระบบใหม่อีกครั้งในภายหลัง หรือรีเฟรชหน้านี้
      </div>
    </div>
  `;
}

/**
 * Same shape as lender/js/dashboard.js's showRolePendingNotice — the org
 * has cleared entity KYB but doesn't (yet) hold a Verified 'VillageFund' role.
 */
function showRolePendingNotice(orgName, roleStatus) {
  document.getElementById("orgName").textContent = orgName || "-";
  const body = !roleStatus
    ? {
        title: "องค์กรของท่านยังไม่มีบทบาทกองทุนหมู่บ้าน",
        detail: "หากต้องการเปิดใช้งานพอร์ทัลนี้ ท่านสามารถส่งคำขอเพิ่มบทบาทได้จากหน้า \"จัดการบทบาทธุรกิจ\"",
      }
    : roleStatus === "Rejected"
    ? { title: "คำขอบทบาทกองทุนหมู่บ้านของท่านถูกปฏิเสธ", detail: "กรุณาติดต่อเจ้าหน้าที่ผู้ดูแลระบบสำหรับข้อมูลเพิ่มเติม" }
    : { title: "คำขอบทบาทกองทุนหมู่บ้านของท่านอยู่ระหว่างการตรวจสอบ", detail: "เจ้าหน้าที่ผู้ดูแลระบบ (Platform Ops) กำลังตรวจสอบคำขอนี้ — ลองรีเฟรชหน้านี้อีกครั้งภายหลัง" };

  document.getElementById("mainContainer").innerHTML = `
    <div class="empty-state" style="padding:60px 24px;">
      <div style="font-size:40px; margin-bottom:14px;">🧩</div>
      <div style="font-size:17px; font-weight:700; color:var(--green-900); margin-bottom:8px;">${escapeHtml(body.title)}</div>
      <div style="font-size:14px; margin-bottom:20px;">${escapeHtml(body.detail)}</div>
      <a href="../manage-roles.html" class="btn btn-primary" style="max-width:260px; margin:0 auto; display:block;">ไปที่หน้าจัดการบทบาทธุรกิจ</a>
    </div>
  `;
}

// ---------- ภาพรวม ----------
function renderSummary(d) {
  document.getElementById("orgName").textContent = d.org_name || "-";
  document.getElementById("summarySection").innerHTML = `
    <div class="stat-card"><div class="label">สถานะ KYB</div><div class="value" style="font-size:16px;">${escapeHtml(d.kyb_status)}</div></div>
    <div class="stat-card"><div class="label">จำนวนสมาชิก (เกษตรกร)</div><div class="value">${d.member_count}</div></div>
  `;
}

// ---------- Farmer 360° View ----------
// See FARMER_360_ARCHITECTURE.md §4 (visibility model) and
// backend/src/routes/farmer360.js for exactly what each response field
// means and why. This MVP round is membership + land + transactions only
// — no consent workflow, no credit score (both explicitly deferred). This
// portal was built solely to host this feature (see architecture doc §6).
const RELATIONSHIP_TYPE_LABEL_TH = {
  CooperativeMember: "สมาชิกสหกรณ์",
  VillageFundMember: "สมาชิกกองทุนหมู่บ้าน",
  LoanCustomer: "ลูกค้าสินเชื่อ",
  Other: "อื่น ๆ",
};

function relationshipTypeLabel(t) {
  return RELATIONSHIP_TYPE_LABEL_TH[t] || t || "-";
}

function farmer360SearchResultCard(f) {
  return `
    <div class="item-card" data-search-farmer-id="${f.farmer_id}">
      <div class="row"><span class="title">${escapeHtml(f.full_name)}</span><span class="badge">${escapeHtml(f.farmer_code)}</span></div>
      <div class="action-row">
        <button type="button" class="btn btn-primary btn-sm" data-add-farmer="${f.farmer_id}">เพิ่มเป็นสมาชิก</button>
      </div>
    </div>
  `;
}

async function handleFarmer360Search() {
  const codeInput = document.getElementById("farmer360SearchCode");
  const phoneInput = document.getElementById("farmer360SearchPhone");
  const el = document.getElementById("farmer360SearchResultSection");
  const code = codeInput.value.trim();
  const phone = phoneInput.value.trim();
  if (!code && !phone) {
    toast("กรุณากรอกรหัส AgroLink ID หรือเบอร์โทร", true);
    return;
  }
  const query = code ? `code=${encodeURIComponent(code)}` : `phone=${encodeURIComponent(phone)}`;
  el.innerHTML = `<div class="loading-line">กำลังค้นหา…</div>`;
  try {
    const farmer = await AgroLinkVillageFundAPI.get(`/farmer360/search?${query}`);
    el.innerHTML = farmer360SearchResultCard(farmer);
  } catch (err) {
    if (err.status === 404) {
      el.innerHTML = `<div class="empty-state">ไม่พบเกษตรกรที่ตรงกับข้อมูลที่ค้นหา</div>`;
    } else {
      el.innerHTML = `<div class="empty-state">ค้นหาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    }
  }
}

document.getElementById("farmer360SearchBtn").addEventListener("click", handleFarmer360Search);

document.getElementById("farmer360SyncBtn").addEventListener("click", async () => {
  const btn = document.getElementById("farmer360SyncBtn");
  btn.disabled = true;
  try {
    const result = await AgroLinkVillageFundAPI.post("/farmer360/relationships/sync");
    toast(`ซิงค์สำเร็จ — เพิ่มสมาชิกใหม่ ${result.linked_count} ราย`);
    await loadFarmer360Roster();
    await refreshSummary();
  } catch (err) {
    toast("ซิงค์ไม่สำเร็จ: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("farmer360SearchResultSection").addEventListener("click", async (e) => {
  const addBtn = e.target.closest("[data-add-farmer]");
  if (!addBtn) return;
  const farmerId = addBtn.dataset.addFarmer;
  addBtn.disabled = true;
  try {
    await AgroLinkVillageFundAPI.post("/farmer360/relationships", { farmer_id: farmerId });
    toast("เพิ่มเกษตรกรเป็นสมาชิกเรียบร้อยแล้ว");
    document.getElementById("farmer360SearchResultSection").innerHTML = "";
    document.getElementById("farmer360SearchCode").value = "";
    document.getElementById("farmer360SearchPhone").value = "";
    await loadFarmer360Roster();
    await refreshSummary();
  } catch (err) {
    toast("เพิ่มสมาชิกไม่สำเร็จ: " + err.message, true);
    addBtn.disabled = false;
  }
});

function farmer360TransactionLine(label, tx) {
  if (!tx) return "";
  const amountPart = tx.total_amount !== undefined ? ` — ${thb(tx.total_amount)} บาท` : "";
  return `<div class="detail-line">${label}: ${tx.count} รายการ${amountPart}</div>`;
}

function render360Detail(view) {
  const membershipsHtml = view.memberships.length
    ? view.memberships.map((m) => `<span class="badge">${escapeHtml(m.org_name)} (${relationshipTypeLabel(m.relationship_type)})</span>`).join(" ")
    : `<span class="detail-line muted">ไม่มีข้อมูลสมาชิกภาพอื่น</span>`;

  const landHtml = view.land.length
    ? view.land.map((l) => `<div class="detail-line">${escapeHtml(l.commodity_name)} — ${l.area_rai} ไร่ (${escapeHtml(l.unit_type)})</div>`).join("")
    : `<div class="detail-line muted">ไม่มีข้อมูลที่ดิน/แปลง</div>`;

  return `
    <div class="item-card" style="margin-top:8px; background:var(--gray-50);">
      <div class="row"><span class="title">👤 ${escapeHtml(view.farmer.full_name)}</span><span class="badge">${escapeHtml(view.farmer.farmer_code)}</span></div>
      <div class="detail-line muted">โทร ${escapeHtml(view.farmer.phone || "-")} · พื้นที่ ${escapeHtml(view.farmer.region_code || "-")}</div>

      <div class="detail-line" style="margin-top:10px; font-weight:600;">🏞️ ที่ดิน/แปลงปลูก</div>
      ${landHtml}

      <div class="detail-line" style="margin-top:10px; font-weight:600;">🏷️ สมาชิกภาพกับหน่วยงานอื่น</div>
      <div class="detail-line">${membershipsHtml}</div>

      <div class="detail-line" style="margin-top:10px; font-weight:600;">💳 ธุรกรรมกับท่าน</div>
      ${farmer360TransactionLine("ขายผลผลิต", view.transactions.produce_sales)}
      ${farmer360TransactionLine("คำขอสินเชื่อ", view.transactions.loans)}
      ${farmer360TransactionLine("ซื้อปัจจัยการผลิต", view.transactions.input_purchases)}
      ${farmer360TransactionLine("เช่าเครื่องจักร", view.transactions.machinery_rental)}

      <div class="detail-line muted" style="margin-top:10px;">
        คะแนนเครดิต: ยังไม่แสดงในรอบนี้ — รอระบบยินยอม (consent) ในรอบถัดไป
      </div>
    </div>
  `;
}

function farmer360RosterCard(r) {
  return `
    <div class="item-card" data-roster-farmer-id="${r.farmer_id}">
      <div class="row">
        <span class="title">${escapeHtml(r.full_name)}</span>
        <span class="badge">${escapeHtml(r.farmer_code)}</span>
      </div>
      <div class="detail-line muted">${relationshipTypeLabel(r.relationship_type)} · เป็นสมาชิกตั้งแต่ ${thaiDate(r.joined_at)}</div>
      <div class="action-row">
        <button type="button" class="btn btn-ghost btn-sm" data-view360="${r.farmer_id}">ดูข้อมูล 360°</button>
        <button type="button" class="btn btn-decline btn-sm" data-unlink-farmer="${r.farmer_id}">เลิกเป็นสมาชิก</button>
      </div>
      <div data-detail-for="${r.farmer_id}"></div>
    </div>
  `;
}

async function loadFarmer360Roster() {
  const el = document.getElementById("farmer360RosterSection");
  try {
    const roster = await AgroLinkVillageFundAPI.get("/farmer360/relationships/mine");
    if (roster.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีเกษตรกรที่เป็นสมาชิก — ค้นหาและเพิ่ม หรือกด "ซิงค์สมาชิกจากธุรกรรมเดิมอัตโนมัติ" ด้านบน</div>`;
      return;
    }
    el.innerHTML = roster.map(farmer360RosterCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายชื่อสมาชิกไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("farmer360RosterSection").addEventListener("click", async (e) => {
  const viewBtn = e.target.closest("[data-view360]");
  const unlinkBtn = e.target.closest("[data-unlink-farmer]");

  if (viewBtn) {
    const farmerId = viewBtn.dataset.view360;
    const detailEl = document.querySelector(`[data-detail-for="${farmerId}"]`);
    if (detailEl.dataset.expanded === "true") {
      detailEl.innerHTML = "";
      detailEl.dataset.expanded = "false";
      viewBtn.textContent = "ดูข้อมูล 360°";
      return;
    }
    viewBtn.disabled = true;
    try {
      const view = await AgroLinkVillageFundAPI.get(`/farmer360/${farmerId}`);
      detailEl.innerHTML = render360Detail(view);
      detailEl.dataset.expanded = "true";
      viewBtn.textContent = "ซ่อนข้อมูล 360°";
    } catch (err) {
      toast("โหลดข้อมูล 360° ไม่สำเร็จ: " + err.message, true);
    } finally {
      viewBtn.disabled = false;
    }
    return;
  }

  if (unlinkBtn) {
    const farmerId = unlinkBtn.dataset.unlinkFarmer;
    unlinkBtn.disabled = true;
    try {
      await AgroLinkVillageFundAPI.del(`/farmer360/relationships/${farmerId}`);
      toast("เลิกเป็นสมาชิกเรียบร้อยแล้ว");
      await loadFarmer360Roster();
      await refreshSummary();
    } catch (err) {
      toast("ดำเนินการไม่สำเร็จ: " + err.message, true);
      unlinkBtn.disabled = false;
    }
  }
});

async function refreshSummary() {
  try {
    const d = await AgroLinkVillageFundAPI.get("/villagefund/dashboard");
    renderSummary(d);
  } catch (err) {
    // Dashboard already loaded once successfully to get this far — a
    // transient failure on refresh isn't worth interrupting the user.
  }
}

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkVillageFundAPI.logout());

/**
 * GET /villagefund/dashboard doubles as the KYB/role gate check here —
 * same pattern as every other portal's init().
 */
async function init() {
  const session = AgroLinkVillageFundAPI.requireSessionOrRedirect();
  if (!session) return;

  try {
    const d = await AgroLinkVillageFundAPI.get("/villagefund/dashboard");
    renderSummary(d);
  } catch (err) {
    if (err.message === "kyb_not_verified") {
      showKybPendingNotice(err.body.org_name, err.body.kyb_status);
      return;
    }
    if (err.message === "role_not_verified") {
      showRolePendingNotice(err.body.org_name, err.body.role_status);
      return;
    }
    document.getElementById("summarySection").innerHTML = `<div class="empty-state">โหลดข้อมูลภาพรวมไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    return;
  }

  loadFarmer360Roster();
}

init();
