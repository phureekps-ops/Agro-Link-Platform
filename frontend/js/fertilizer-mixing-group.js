const session = AgroLinkAPI.requireSessionOrRedirect();

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

function thaiDateTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtKg(n) {
  return Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const UNIT_TYPE_LABEL = { Plot: "แปลงนา/ไร่", Pen: "คอกปศุสัตว์", Pond: "บ่อเลี้ยง", Orchard: "สวนผลไม้" };
const DELIVERY_OPTION_LABEL_TH = { pickup: "รับเองที่ร้าน", delivery: "จัดส่งถึงแปลง" };
const GROUP_STATUS_LABEL_TH = { Open: "เปิดรับสมาชิก", Submitted: "ส่งคำขอแล้ว", Cancelled: "ยกเลิกกลุ่มแล้ว" };
const GROUP_STATUS_BADGE_CLASS = { Open: "status-pending", Submitted: "status-active", Cancelled: "status-declined" };

let unitsCache = null;
async function loadUnitsCache() {
  if (unitsCache) return unitsCache;
  try {
    unitsCache = await AgroLinkAPI.get("/farmer/production-units");
  } catch (err) {
    unitsCache = [];
  }
  return unitsCache;
}

function unitOptionsHtml(units, selectedUnitId) {
  if (units.length === 0) return `<option value="">ยังไม่มีแปลง/หน่วยผลิต</option>`;
  return units.map((u) =>
    `<option value="${u.unit_id}" ${u.unit_id === selectedUnitId ? "selected" : ""}>${escapeHtml(UNIT_TYPE_LABEL[u.unit_type] || u.unit_type)} — ${escapeHtml(u.commodity_code)} (${u.area_rai} ไร่)</option>`
  ).join("");
}

// ---------- เริ่มกลุ่มใหม่ ----------
function providerCard(p) {
  return `
    <div class="item-card" data-listing-id="${p.listing_id}">
      <div class="row"><span class="title">${escapeHtml(p.org_name)}</span></div>
      <div class="detail-line">${escapeHtml(p.label_th)}</div>
      <div class="detail-line muted">ราคาปกติ: ${Number(p.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(p.price_unit || "")}</div>
      <div class="action-row">
        <button type="button" class="btn btn-primary btn-sm" data-start-group-from="${p.listing_id}" data-org-name="${escapeHtml(p.org_name)}" data-label-th="${escapeHtml(p.label_th)}">เริ่มกลุ่มกับผู้ให้บริการนี้</button>
      </div>
    </div>
  `;
}

async function loadProviders() {
  const el = document.getElementById("providerListSection");
  try {
    const providers = await AgroLinkAPI.get("/farmer/fertilizer-mixing-providers");
    if (providers.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีผู้ให้บริการผสมปุ๋ยสั่งตัดที่เปิดรับในขณะนี้</div>`;
      return;
    }
    el.innerHTML = providers.map(providerCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดผู้ให้บริการไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("providerListSection").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-start-group-from]");
  if (!btn) return;
  document.getElementById("createListingId").value = btn.dataset.startGroupFrom;
  document.getElementById("createGroupLabel").textContent = `${btn.dataset.orgName} — ${btn.dataset.labelTh}`;
  document.getElementById("createGroupDiscountNotice").textContent = "";
  const units = await loadUnitsCache();
  document.getElementById("createUnitSelect").innerHTML = unitOptionsHtml(units);
  // Default deadline suggestion: 3 days from now, local time, trimmed to
  // minute precision for the datetime-local input's expected format.
  const suggested = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  suggested.setSeconds(0, 0);
  document.getElementById("createJoinDeadline").value = new Date(suggested.getTime() - suggested.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16);
  document.getElementById("createGroupForm").style.display = "block";
  document.getElementById("createGroupForm").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.getElementById("createGroupCancelBtn").addEventListener("click", () => {
  document.getElementById("createGroupForm").style.display = "none";
  document.getElementById("createGroupForm").reset();
});

document.getElementById("createDeliveryOption").addEventListener("change", (e) => {
  document.getElementById("createDeliveryAddressField").style.display = e.target.value === "delivery" ? "block" : "none";
});

document.getElementById("createGroupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const listingId = document.getElementById("createListingId").value;
  const unitId = document.getElementById("createUnitSelect").value;
  const joinDeadlineLocal = document.getElementById("createJoinDeadline").value;
  const preferredDate = document.getElementById("createPreferredDate").value;
  const deliveryOption = document.getElementById("createDeliveryOption").value;
  const deliveryAddress = document.getElementById("createDeliveryAddress").value.trim();

  if (!unitId) { toast("กรุณาเลือกแปลง/หน่วยผลิต", true); return; }
  if (!joinDeadlineLocal) { toast("กรุณาระบุเวลาปิดรับสมาชิกกลุ่ม", true); return; }
  if (!preferredDate) { toast("กรุณาเลือกวันที่ต้องการรับ/จัดส่ง", true); return; }
  if (deliveryOption === "delivery" && !deliveryAddress) { toast("กรุณากรอกที่อยู่จัดส่ง", true); return; }

  const payload = {
    listing_id: listingId,
    join_deadline: new Date(joinDeadlineLocal).toISOString(),
    unit_id: unitId,
    requested_urea_kg: document.getElementById("createUreaKg").value ? Number(document.getElementById("createUreaKg").value) : undefined,
    requested_dap_kg: document.getElementById("createDapKg").value ? Number(document.getElementById("createDapKg").value) : undefined,
    requested_mop_kg: document.getElementById("createMopKg").value ? Number(document.getElementById("createMopKg").value) : undefined,
    delivery_option: deliveryOption,
    delivery_address: deliveryOption === "delivery" ? deliveryAddress : undefined,
    preferred_date: preferredDate,
    farmer_note: document.getElementById("createFarmerNote").value.trim() || undefined,
  };

  const btn = document.getElementById("createGroupSubmitBtn");
  btn.disabled = true;
  try {
    const group = await AgroLinkAPI.post("/farmer/fertilizer-mixing-groups", payload);
    toast(`เริ่มกลุ่มเรียบร้อยแล้ว รหัสกลุ่มของท่านคือ ${group.group_code} — แชร์รหัสนี้ให้เกษตรกรคนอื่นเพื่อเชิญเข้าร่วม`);
    document.getElementById("createGroupForm").reset();
    document.getElementById("createGroupForm").style.display = "none";
    await loadMyGroups();
  } catch (err) {
    toast("เริ่มกลุ่มไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- ค้นหากลุ่มด้วยรหัสเชิญ ----------
function lookupResultHtml(g) {
  const progressPct = g.bulk_discount_min_kg
    ? Math.min(100, Math.round((g.current_total_kg / Number(g.bulk_discount_min_kg)) * 100))
    : null;
  const discountLine = g.bulk_discount_min_kg && g.bulk_discount_percent
    ? `<div class="detail-line">ส่วนลดกลุ่ม: ลด ${Number(g.bulk_discount_percent)}% เมื่อยอดรวมถึง ${fmtKg(g.bulk_discount_min_kg)} กก. (ตอนนี้ ${fmtKg(g.current_total_kg)} กก. จาก ${g.current_participant_count} คน)</div>
       <div class="progress-track"><div class="progress-fill" style="width:${progressPct}%;"></div></div>`
    : `<div class="detail-line muted">กลุ่มนี้ยังไม่มีนโยบายส่วนลด — รวมกลุ่มเพื่อความสะดวกในการนัดรับ/ส่งเท่านั้น (ตอนนี้ ${g.current_participant_count} คน รวม ${fmtKg(g.current_total_kg)} กก.)</div>`;

  const joinBlock = g.status !== "Open"
    ? `<div class="empty-state">กลุ่มนี้${g.status === "Submitted" ? "ส่งคำขอไปยังผู้ให้บริการแล้ว" : "ถูกยกเลิกแล้ว"} ไม่สามารถเข้าร่วมได้อีก</div>`
    : g.my_status
    ? `<div class="empty-state">ท่าน${g.my_status === "Withdrawn" ? "เคยออกจากกลุ่มนี้แล้ว" : "เข้าร่วมกลุ่มนี้อยู่แล้ว"} — ดูรายละเอียดที่ "กลุ่มของฉัน" ด้านล่าง</div>`
    : `
      <form id="joinGroupForm" style="margin-top:12px;">
        <input type="hidden" id="joinGroupCode" value="${escapeHtml(g.group_code)}" />
        <div class="form-grid">
          <div class="field">
            <label for="joinUnitSelect">แปลง/หน่วยผลิต</label>
            <select id="joinUnitSelect"></select>
          </div>
          <div class="field">
            <label for="joinUreaKg">ยูเรีย (46-0-0) ที่ต้องการ (กก.)</label>
            <input type="number" id="joinUreaKg" min="0" step="0.01" placeholder="0" />
          </div>
          <div class="field">
            <label for="joinDapKg">DAP (18-46-0) ที่ต้องการ (กก.)</label>
            <input type="number" id="joinDapKg" min="0" step="0.01" placeholder="0" />
          </div>
          <div class="field">
            <label for="joinMopKg">MOP (0-0-60) ที่ต้องการ (กก.)</label>
            <input type="number" id="joinMopKg" min="0" step="0.01" placeholder="0" />
          </div>
          <div class="field">
            <label for="joinDeliveryOption">วิธีรับปุ๋ย</label>
            <select id="joinDeliveryOption">
              <option value="pickup">รับเองที่ร้าน</option>
              <option value="delivery">จัดส่งถึงแปลง</option>
            </select>
          </div>
          <div class="field full" id="joinDeliveryAddressField" style="display:none;">
            <label for="joinDeliveryAddress">ที่อยู่จัดส่ง</label>
            <input type="text" id="joinDeliveryAddress" placeholder="ที่อยู่สำหรับจัดส่งถึงแปลง" />
          </div>
          <div class="field">
            <label for="joinPreferredDate">วันที่ต้องการรับ/จัดส่ง</label>
            <input type="date" id="joinPreferredDate" required />
          </div>
          <div class="field full">
            <label for="joinFarmerNote">หมายเหตุถึงผู้ให้บริการ (ถ้ามี)</label>
            <input type="text" id="joinFarmerNote" placeholder="เช่น มีปุ๋ยยูเรียอยู่แล้วบางส่วน" />
          </div>
        </div>
        <button type="submit" class="btn btn-primary" id="joinGroupSubmitBtn" style="max-width:160px;">เข้าร่วมกลุ่ม</button>
      </form>
    `;

  return `
    <div class="item-card">
      <div class="row">
        <span class="title">${escapeHtml(g.org_name)} — ${escapeHtml(g.label_th)}</span>
        <span class="badge ${GROUP_STATUS_BADGE_CLASS[g.status] || ""}">${escapeHtml(GROUP_STATUS_LABEL_TH[g.status] || g.status)}</span>
      </div>
      <div class="detail-line">รหัสกลุ่ม: <span class="group-code-box">${escapeHtml(g.group_code)}</span></div>
      <div class="detail-line">ราคาปกติ: ${Number(g.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(g.price_unit || "")}</div>
      ${discountLine}
      <div class="detail-line muted">ปิดรับสมาชิกกลุ่ม: ${thaiDateTime(g.join_deadline)}</div>
      ${joinBlock}
    </div>
  `;
}

async function runLookup(code) {
  const el = document.getElementById("lookupResultSection");
  el.innerHTML = `<div class="loading-line">กำลังค้นหากลุ่ม…</div>`;
  try {
    const g = await AgroLinkAPI.get(`/farmer/fertilizer-mixing-groups/${encodeURIComponent(code)}`);
    el.innerHTML = lookupResultHtml(g);
    if (g.status === "Open" && !g.my_status) {
      const units = await loadUnitsCache();
      document.getElementById("joinUnitSelect").innerHTML = unitOptionsHtml(units);
    }
  } catch (err) {
    el.innerHTML = `<div class="empty-state">ไม่พบกลุ่มรหัสนี้ — กรุณาตรวจสอบรหัสอีกครั้ง</div>`;
  }
}

document.getElementById("lookupCodeBtn").addEventListener("click", () => {
  const code = document.getElementById("lookupCodeInput").value.trim();
  if (!code) { toast("กรุณากรอกรหัสกลุ่ม", true); return; }
  runLookup(code);
});

document.getElementById("lookupResultSection").addEventListener("change", (e) => {
  if (e.target.id === "joinDeliveryOption") {
    document.getElementById("joinDeliveryAddressField").style.display = e.target.value === "delivery" ? "block" : "none";
  }
});

document.getElementById("lookupResultSection").addEventListener("submit", async (e) => {
  if (e.target.id !== "joinGroupForm") return;
  e.preventDefault();
  const code = document.getElementById("joinGroupCode").value;
  const unitId = document.getElementById("joinUnitSelect").value;
  const preferredDate = document.getElementById("joinPreferredDate").value;
  const deliveryOption = document.getElementById("joinDeliveryOption").value;
  const deliveryAddress = document.getElementById("joinDeliveryAddress").value.trim();

  if (!unitId) { toast("กรุณาเลือกแปลง/หน่วยผลิต", true); return; }
  if (!preferredDate) { toast("กรุณาเลือกวันที่ต้องการรับ/จัดส่ง", true); return; }
  if (deliveryOption === "delivery" && !deliveryAddress) { toast("กรุณากรอกที่อยู่จัดส่ง", true); return; }

  const payload = {
    unit_id: unitId,
    requested_urea_kg: document.getElementById("joinUreaKg").value ? Number(document.getElementById("joinUreaKg").value) : undefined,
    requested_dap_kg: document.getElementById("joinDapKg").value ? Number(document.getElementById("joinDapKg").value) : undefined,
    requested_mop_kg: document.getElementById("joinMopKg").value ? Number(document.getElementById("joinMopKg").value) : undefined,
    delivery_option: deliveryOption,
    delivery_address: deliveryOption === "delivery" ? deliveryAddress : undefined,
    preferred_date: preferredDate,
    farmer_note: document.getElementById("joinFarmerNote").value.trim() || undefined,
  };

  const btn = document.getElementById("joinGroupSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkAPI.post(`/farmer/fertilizer-mixing-groups/${encodeURIComponent(code)}/join`, payload);
    toast("เข้าร่วมกลุ่มเรียบร้อยแล้ว");
    await runLookup(code);
    await loadMyGroups();
  } catch (err) {
    const messages = {
      group_not_open: "กลุ่มนี้ไม่เปิดรับสมาชิกแล้ว",
      join_deadline_passed: "หมดเวลาเข้าร่วมกลุ่มนี้แล้ว",
      already_participant: "ท่านเข้าร่วม (หรือเคยออกจาก) กลุ่มนี้ไปแล้ว",
      production_unit_not_found: "ไม่พบแปลง/หน่วยผลิตที่เลือก",
    };
    toast("เข้าร่วมกลุ่มไม่สำเร็จ: " + (messages[err.body && err.body.error] || err.message), true);
    btn.disabled = false;
  }
});

// ---------- กลุ่มของฉัน ----------
function myGroupCard(g) {
  const progressPct = g.bulk_discount_min_kg
    ? Math.min(100, Math.round((Number(g.current_total_kg) / Number(g.bulk_discount_min_kg)) * 100))
    : null;

  let statusDetail = "";
  if (g.status === "Open") {
    statusDetail = g.bulk_discount_min_kg
      ? `
        <div class="detail-line">ยอดรวมตอนนี้: ${fmtKg(g.current_total_kg)} / ${fmtKg(g.bulk_discount_min_kg)} กก. เพื่อรับส่วนลด ${Number(g.bulk_discount_percent)}% (${g.current_participant_count} คน)</div>
        <div class="progress-track"><div class="progress-fill" style="width:${progressPct}%;"></div></div>
      `
      : `<div class="detail-line muted">ยอดรวมตอนนี้: ${fmtKg(g.current_total_kg)} กก. (${g.current_participant_count} คน) — กลุ่มนี้ไม่มีนโยบายส่วนลด</div>`;
  } else if (g.status === "Submitted") {
    statusDetail = `
      <div class="detail-line">ยอดรวมสุดท้าย: ${fmtKg(g.final_total_kg)} กก.</div>
      <div class="detail-line">ราคาที่ใช้จริง: ${Number(g.final_unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(g.price_unit || "")}
        ${g.discount_applied ? " (ได้รับส่วนลดกลุ่มแล้ว ✅)" : " (ไม่ถึงเกณฑ์ส่วนลด — ราคาปกติ)"}</div>
      <div class="detail-line muted">ทุกคำสั่งซื้อในกลุ่มนี้ถูกส่งไปยังผู้ให้บริการแล้ว — ดูสถานะได้ที่หน้า "บริการผสมปุ๋ยสั่งตัด"</div>
    `;
  } else {
    statusDetail = `<div class="detail-line muted">กลุ่มนี้ถูกยกเลิกก่อนส่งคำขอ — ไม่มีคำสั่งซื้อจริงเกิดขึ้น</div>`;
  }

  let actions = "";
  if (g.status === "Open") {
    if (g.is_organizer) {
      actions = `
        <div class="action-row">
          <button type="button" class="btn btn-approve btn-sm" data-submit-group="${g.group_id}">ยืนยันส่งคำขอกลุ่ม</button>
          <button type="button" class="btn btn-decline btn-sm" data-cancel-group="${g.group_id}">ยกเลิกกลุ่ม</button>
        </div>
      `;
    } else {
      actions = `
        <div class="action-row">
          <button type="button" class="btn btn-decline btn-sm" data-withdraw-group="${g.group_id}">ออกจากกลุ่ม</button>
        </div>
      `;
    }
  }

  return `
    <div class="item-card" data-group-id="${g.group_id}">
      <div class="row">
        <span class="title">${escapeHtml(g.org_name)} — ${escapeHtml(g.label_th)} ${g.is_organizer ? "(ผู้เริ่มกลุ่ม)" : ""}</span>
        <span class="badge ${GROUP_STATUS_BADGE_CLASS[g.status] || ""}">${escapeHtml(GROUP_STATUS_LABEL_TH[g.status] || g.status)}</span>
      </div>
      <div class="detail-line">รหัสกลุ่ม (แชร์ให้เพื่อนเกษตรกร): <span class="group-code-box">${escapeHtml(g.group_code)}</span></div>
      ${statusDetail}
      <div class="detail-line muted">เริ่มกลุ่มเมื่อ ${thaiDateTime(g.created_at)} · ปิดรับสมาชิก ${thaiDateTime(g.join_deadline)}</div>
      ${actions}
    </div>
  `;
}

async function loadMyGroups() {
  const el = document.getElementById("myGroupsSection");
  try {
    const groups = await AgroLinkAPI.get("/farmer/fertilizer-mixing-groups");
    if (groups.length === 0) {
      el.innerHTML = `<div class="empty-state">ท่านยังไม่ได้เริ่มหรือเข้าร่วมกลุ่มรวมสั่งซื้อใด ๆ</div>`;
      return;
    }
    el.innerHTML = groups.map(myGroupCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดกลุ่มของท่านไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("myGroupsSection").addEventListener("click", async (e) => {
  const submitBtn = e.target.closest("[data-submit-group]");
  const cancelBtn = e.target.closest("[data-cancel-group]");
  const withdrawBtn = e.target.closest("[data-withdraw-group]");

  if (submitBtn) {
    if (!window.confirm("ยืนยันส่งคำขอกลุ่มไปยังผู้ให้บริการ? หลังจากนี้จะไม่สามารถเพิ่ม/ถอนสมาชิกได้อีก")) return;
    const groupId = submitBtn.dataset.submitGroup;
    submitBtn.disabled = true;
    try {
      const result = await AgroLinkAPI.post(`/farmer/fertilizer-mixing-groups/${groupId}/submit`, {});
      toast(result.discount_applied ? "ส่งคำขอกลุ่มสำเร็จ — ยอดรวมถึงเกณฑ์ ได้รับส่วนลดแล้ว! 🎉" : "ส่งคำขอกลุ่มสำเร็จ (ยอดรวมยังไม่ถึงเกณฑ์ส่วนลด ใช้ราคาปกติ)");
      await loadMyGroups();
    } catch (err) {
      const messages = { no_participants: "กลุ่มนี้ไม่มีสมาชิก ไม่สามารถส่งคำขอได้", group_not_open: "กลุ่มนี้ถูกส่งหรือยกเลิกไปแล้ว" };
      toast("ส่งคำขอกลุ่มไม่สำเร็จ: " + (messages[err.body && err.body.error] || err.message), true);
      submitBtn.disabled = false;
    }
    return;
  }

  if (cancelBtn) {
    if (!window.confirm("ยืนยันยกเลิกกลุ่มนี้? สมาชิกทุกคนจะต้องเริ่ม/เข้าร่วมกลุ่มใหม่หากต้องการรวมกลุ่มอีกครั้ง")) return;
    const groupId = cancelBtn.dataset.cancelGroup;
    cancelBtn.disabled = true;
    try {
      await AgroLinkAPI.post(`/farmer/fertilizer-mixing-groups/${groupId}/cancel`, {});
      toast("ยกเลิกกลุ่มเรียบร้อยแล้ว");
      await loadMyGroups();
    } catch (err) {
      toast("ยกเลิกกลุ่มไม่สำเร็จ: " + err.message, true);
      cancelBtn.disabled = false;
    }
    return;
  }

  if (withdrawBtn) {
    const groupId = withdrawBtn.dataset.withdrawGroup;
    withdrawBtn.disabled = true;
    try {
      await AgroLinkAPI.post(`/farmer/fertilizer-mixing-groups/${groupId}/withdraw`, {});
      toast("ออกจากกลุ่มเรียบร้อยแล้ว");
      await loadMyGroups();
    } catch (err) {
      toast("ออกจากกลุ่มไม่สำเร็จ: " + err.message, true);
      withdrawBtn.disabled = false;
    }
  }
});

// ---------- เริ่มต้น ----------
// A farmer arriving via a shared invite link (?code=XXXX, e.g. from
// another farmer's LINE/social share) gets the lookup auto-run and
// scrolled into view, same prefill spirit as fertilizer-mixing-marketplace
// .js's calc_id handling.
const params = new URLSearchParams(window.location.search);
const codeFromUrl = params.get("code");

async function init() {
  await loadProviders();
  await loadMyGroups();
  if (codeFromUrl) {
    document.getElementById("lookupCodeInput").value = codeFromUrl.toUpperCase();
    await runLookup(codeFromUrl);
    document.getElementById("lookupResultSection").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

init();
