const session = AgroLinkAdminAPI.requireSessionOrRedirect();

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
  return new Date(iso).toLocaleString("th-TH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const GROUP_BUY_CATEGORY_LABEL_TH = {
  input_product: "ปัจจัยการผลิต",
  produce: "ผลผลิตทางการเกษตร",
  processed_good: "สินค้าแปรรูป",
  machinery_service: "บริการเครื่องจักรกล",
  other: "อื่นๆ",
};
const GROUP_BUY_STATUS_LABEL_TH = {
  collecting: "กำลังรวบรวมความต้องการ",
  converted: "แปลงเป็นประมูลแล้ว",
  cancelled: "ยกเลิกแล้ว",
};
const GROUP_BUY_STATUS_BADGE_CLASS = {
  collecting: "status-active",
  converted: "status-approved",
  cancelled: "status-declined",
};

function groupBuyProgressLine(gb) {
  const total = Number(gb.total_requested_qty || 0).toLocaleString("th-TH");
  const unit = escapeHtml(gb.target_unit || "หน่วย");
  if (gb.min_total_qty) {
    const min = Number(gb.min_total_qty).toLocaleString("th-TH");
    return `ยอดรวมตอนนี้ ${total} / ขั้นต่ำที่ตั้งไว้ ${min} ${unit}`;
  }
  return `ยอดรวมตอนนี้ ${total} ${unit}`;
}

function groupBuyCard(gb) {
  const badgeClass = GROUP_BUY_STATUS_BADGE_CLASS[gb.status] || "status-pending";
  const readyToConvert = gb.status === "collecting"
    && (new Date(gb.closes_at).getTime() <= Date.now() || (gb.min_total_qty && Number(gb.total_requested_qty) >= Number(gb.min_total_qty)));

  return `
    <div class="item-card" data-group-buy-id="${gb.group_buy_id}">
      <div class="row">
        <span class="title">${escapeHtml(gb.product_description)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(GROUP_BUY_STATUS_LABEL_TH[gb.status] || gb.status)}</span>
      </div>
      <div class="detail-line muted">${escapeHtml(GROUP_BUY_CATEGORY_LABEL_TH[gb.category] || gb.category)} · เปิดโดย ${escapeHtml(gb.initiator_org_name || "-")} · ${gb.participant_count || 0} สหกรณ์เข้าร่วม</div>
      <div class="detail-line" style="font-weight:700;">${groupBuyProgressLine(gb)}</div>
      <div class="detail-line muted">ปิดรับสมัครภายใน ${thaiDateTime(gb.closes_at)}${readyToConvert ? " — พร้อมแปลงเป็นประมูลแล้ว" : ""}</div>
      ${gb.status === "converted" ? `<div class="detail-line muted">สหกรณ์หัวขบวน: ${escapeHtml(gb.lead_org_name || "-")}</div>` : ""}
      ${gb.status === "collecting" ? `
        <div class="action-row">
          <button type="button" class="btn btn-approve btn-sm" data-toggle-convert-form="${gb.group_buy_id}">แปลงเป็นประมูล (เลือกสหกรณ์หัวขบวน)</button>
        </div>
        <div data-convert-form-container="${gb.group_buy_id}" style="display:none; margin-top:10px;"></div>
      ` : ""}
    </div>
  `;
}

async function loadGroupBuys() {
  const el = document.getElementById("groupBuyListSection");
  const status = document.getElementById("groupBuyStatusFilter").value;
  el.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const qs = status ? `?status=${status}` : "";
    const rows = await AgroLinkAdminAPI.get(`/admin/group-buys${qs}`);
    el.innerHTML = rows.length === 0
      ? `<div class="empty-state">ไม่พบรอบตามเงื่อนไขที่เลือก</div>`
      : rows.map(groupBuyCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

function convertFormHtml(groupBuyId, participants) {
  const options = participants
    .filter((p) => p.status === "joined")
    .map((p) => `<option value="${p.org_id}">${escapeHtml(p.org_name)} (${Number(p.requested_qty).toLocaleString("th-TH")})</option>`)
    .join("");
  return `
    <div class="panel">
      <div class="form-grid" style="margin-bottom:12px;">
        <div class="field full">
          <label for="leadOrgSelect-${groupBuyId}">สหกรณ์หัวขบวน (ผู้เซ็นสัญญา/รับของ/จ่ายเงินก่อน)</label>
          <select id="leadOrgSelect-${groupBuyId}">${options}</select>
        </div>
        <div class="field">
          <label for="convertClosesAt-${groupBuyId}">วัน-เวลาปิดรับราคา (e-Auction)</label>
          <input type="datetime-local" id="convertClosesAt-${groupBuyId}" />
        </div>
        <div class="field">
          <label for="convertBidVisibility-${groupBuyId}">รูปแบบการประมูล</label>
          <select id="convertBidVisibility-${groupBuyId}">
            <option value="sealed">ปิดราคาทั้งหมดจนกว่าจะปิดประมูล (แนะนำ)</option>
            <option value="live">เห็นราคาต่ำสุดปัจจุบันแบบเรียลไทม์</option>
          </select>
        </div>
      </div>
      <button type="button" class="btn btn-primary btn-sm" data-submit-convert="${groupBuyId}">ยืนยันแปลงเป็นประมูล</button>
    </div>
  `;
}

document.getElementById("groupBuyStatusFilter").addEventListener("change", loadGroupBuys);

document.getElementById("groupBuyListSection").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-toggle-convert-form]");
  const submitBtn = e.target.closest("[data-submit-convert]");

  if (toggleBtn) {
    const groupBuyId = toggleBtn.dataset.toggleConvertForm;
    const container = document.querySelector(`[data-convert-form-container="${groupBuyId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    if (!isHidden) {
      container.style.display = "none";
      toggleBtn.textContent = "แปลงเป็นประมูล (เลือกสหกรณ์หัวขบวน)";
      return;
    }
    container.style.display = "block";
    toggleBtn.textContent = "ยกเลิก";
    container.innerHTML = `<div class="loading-line">กำลังโหลดรายชื่อผู้เข้าร่วม…</div>`;
    try {
      const detail = await AgroLinkAdminAPI.get(`/admin/group-buys/${groupBuyId}`);
      if (!detail.participants.some((p) => p.status === "joined")) {
        container.innerHTML = `<div class="empty-state">ยังไม่มีสหกรณ์เข้าร่วมรอบนี้ — ยังแปลงเป็นประมูลไม่ได้</div>`;
        return;
      }
      container.innerHTML = convertFormHtml(groupBuyId, detail.participants);
    } catch (err) {
      container.innerHTML = `<div class="empty-state">โหลดรายชื่อผู้เข้าร่วมไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    }
    return;
  }

  if (submitBtn) {
    const groupBuyId = submitBtn.dataset.submitConvert;
    const leadOrgId = document.getElementById(`leadOrgSelect-${groupBuyId}`).value;
    const closesAtValue = document.getElementById(`convertClosesAt-${groupBuyId}`).value;
    const bidVisibility = document.getElementById(`convertBidVisibility-${groupBuyId}`).value;
    if (!leadOrgId) {
      toast("กรุณาเลือกสหกรณ์หัวขบวน", true);
      return;
    }
    if (!closesAtValue) {
      toast("กรุณาเลือกวัน-เวลาปิดรับราคา", true);
      return;
    }
    const closesAtDate = new Date(closesAtValue);
    if (Number.isNaN(closesAtDate.getTime()) || closesAtDate.getTime() <= Date.now()) {
      toast("วัน-เวลาปิดรับราคาต้องเป็นเวลาในอนาคต", true);
      return;
    }
    if (!confirm("ยืนยันแปลงรอบนี้เป็นการประมูลซื้อ? หลังจากนี้จะไม่มีสหกรณ์เข้าร่วมเพิ่มได้อีก")) return;
    submitBtn.disabled = true;
    try {
      await AgroLinkAdminAPI.post(`/admin/group-buys/${groupBuyId}/convert`, {
        lead_org_id: leadOrgId,
        closes_at: closesAtDate.toISOString(),
        bid_visibility: bidVisibility,
      });
      toast("แปลงเป็นประมูลเรียบร้อยแล้ว");
      await loadGroupBuys();
    } catch (err) {
      toast("แปลงเป็นประมูลไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      submitBtn.disabled = false;
    }
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkAdminAPI.logout());

async function init() {
  await loadGroupBuys();
}

init();
