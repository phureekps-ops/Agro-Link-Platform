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
 * Same "under review" notice shape as every other portal's dashboard.js
 * (see buyer/js/dashboard.js's showKybPendingNotice / showRolePendingNotice
 * doc comments) — a cooperative provisioned via POST /admin/cooperatives
 * always lands with both already Verified, so this mainly matters if
 * Platform Ops later revokes the role.
 */
function showKybPendingNotice(orgName, kybStatus) {
  document.getElementById("orgName").textContent = orgName || "-";
  const statusLabel = kybStatus === "Rejected" ? "ถูกปฏิเสธ" : "รอตรวจสอบ (KYB)";
  document.getElementById("mainContainer").innerHTML = `
    <div class="empty-state" style="padding:60px 24px;">
      <div style="font-size:40px; margin-bottom:14px;">⏳</div>
      <div style="font-size:17px; font-weight:700; color:var(--green-900); margin-bottom:8px;">
        สถานะสหกรณ์ของท่าน: ${escapeHtml(statusLabel)}
      </div>
      <div style="font-size:14px;">กรุณาติดต่อผู้ดูแลระบบ (Platform Ops)</div>
    </div>
  `;
}

function showRolePendingNotice(orgName, roleStatus) {
  document.getElementById("orgName").textContent = orgName || "-";
  const body = !roleStatus
    ? { title: "องค์กรของท่านยังไม่มีบทบาทสหกรณ์", detail: "กรุณาติดต่อเจ้าหน้าที่ผู้ดูแลระบบ" }
    : roleStatus === "Rejected"
    ? { title: "บทบาทสหกรณ์ของท่านถูกปฏิเสธ", detail: "กรุณาติดต่อเจ้าหน้าที่ผู้ดูแลระบบสำหรับข้อมูลเพิ่มเติม" }
    : { title: "บทบาทสหกรณ์ของท่านอยู่ระหว่างการตรวจสอบ", detail: "ลองรีเฟรชหน้านี้อีกครั้งภายหลัง" };

  document.getElementById("mainContainer").innerHTML = `
    <div class="empty-state" style="padding:60px 24px;">
      <div style="font-size:40px; margin-bottom:14px;">🧩</div>
      <div style="font-size:17px; font-weight:700; color:var(--green-900); margin-bottom:8px;">${escapeHtml(body.title)}</div>
      <div style="font-size:14px;">${escapeHtml(body.detail)}</div>
    </div>
  `;
}

// ---------- ภาพรวม ----------
function renderSummary(d) {
  document.getElementById("orgName").textContent = d.org_name || "-";
  const byStatus = d.deliveries_by_status || {};
  document.getElementById("summarySection").innerHTML = `
    <div class="stat-card"><div class="label">สถานะ KYB</div><div class="value" style="font-size:16px;">${escapeHtml(d.kyb_status)}</div></div>
    <div class="stat-card"><div class="label">รอตรวจคุณภาพ</div><div class="value">${byStatus.delivered || 0}</div></div>
    <div class="stat-card"><div class="label">รอชำระเงิน</div><div class="value">${byStatus.accepted || 0}</div></div>
    <div class="stat-card"><div class="label">ชำระเงินแล้ว</div><div class="value">${byStatus.settled || 0}</div></div>
    <div class="stat-card"><div class="label">ยอดชำระสะสม</div><div class="value" style="font-size:16px;">${thb(d.total_settled_amount)}</div></div>
    <div class="stat-card"><div class="label">ล็อตที่เปิดอยู่</div><div class="value">${d.open_lots || 0}</div></div>
  `;
}

async function refreshSummary() {
  try {
    const d = await AgroLinkCoopAPI.get("/coop/dashboard");
    renderSummary(d);
  } catch (err) {
    // Non-fatal on refresh — dashboard already rendered once successfully.
  }
}

// ---------- แดชบอร์ดการเงิน (M04) ----------
/**
 * cash_account_status arrives as NULL when the cooperative has never had
 * POST /admin/cooperatives/:id/activate-settlement called on it (see
 * grant_cooperative_finance_dashboard.sql's COMMENT ON FUNCTION) — shown
 * as an explicit "not yet activated" state rather than a misleading ฿0.00,
 * since those two things mean very different things to a coop manager.
 */
function renderFinanceSummary(s) {
  const el = document.getElementById("financeSummarySection");
  const cashValue = s.cash_account_status
    ? `${thb(s.cash_balance)} บาท`
    : "ยังไม่เปิดใช้งานบัญชีชำระเงิน";
  el.innerHTML = `
    <div class="stat-card"><div class="label">เงินสดคงเหลือ (บัญชีชำระเงิน)</div><div class="value" style="font-size:${s.cash_account_status ? "20px" : "14px"};">${escapeHtml(cashValue)}</div></div>
    <div class="stat-card"><div class="label">ค้างชำระสมาชิก</div><div class="value" style="font-size:20px;">${thb(s.accounts_payable_to_members)}</div><div class="sub">${s.deliveries_pending_settlement_count} รายการรอชำระ</div></div>
    <div class="stat-card"><div class="label">ชำระให้สมาชิกสะสม</div><div class="value" style="font-size:20px;">${thb(s.total_paid_to_members_alltime)}</div><div class="sub">${s.deliveries_settled_count} รายการชำระแล้ว</div></div>
    <div class="stat-card"><div class="label">ยอดรับซื้อสะสม</div><div class="value" style="font-size:20px;">${thb(s.total_collected_value_alltime)}</div></div>
    <div class="stat-card"><div class="label">สต็อกในคลัง</div><div class="value">${Number(s.inventory_tons_in_storage || 0).toLocaleString("th-TH")} ตัน</div></div>
    <div class="stat-card"><div class="label">ล็อตที่เปิดอยู่</div><div class="value">${s.open_lots_count || 0}</div></div>
  `;
}

async function loadFinanceSummary() {
  const el = document.getElementById("financeSummarySection");
  try {
    const s = await AgroLinkCoopAPI.get("/coop/finance/summary");
    renderFinanceSummary(s);
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดข้อมูลการเงินไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

const MONTH_LABEL_TH = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
function monthLabel(iso) {
  const d = new Date(iso);
  return `${MONTH_LABEL_TH[d.getMonth()]} ${d.getFullYear() + 543}`;
}

async function loadFinanceMonthly() {
  const el = document.getElementById("financeMonthlySection");
  try {
    const rows = await AgroLinkCoopAPI.get("/coop/finance/monthly");
    if (rows.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีข้อมูลการรับซื้อ</div>`;
      return;
    }
    el.innerHTML = rows.map((r) => `
      <div class="item-card">
        <div class="row"><span class="title">${escapeHtml(monthLabel(r.month))}</span></div>
        <div class="detail-line">รับซื้อ ${r.delivery_count} รายการ · มูลค่ารวม ${thb(r.collected_value)} บาท</div>
        <div class="detail-line muted">ชำระแล้ว ${thb(r.settled_value)} บาท</div>
      </div>
    `).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดแนวโน้มไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

const TXN_DIRECTION_LABEL_TH = { credit: "เข้า (Credit)", debit: "ออก (Debit)" };
function transactionCard(t) {
  const isCredit = t.direction === "credit";
  return `
    <div class="item-card">
      <div class="row">
        <span class="title">${escapeHtml(t.entry_type)}</span>
        <span class="badge ${isCredit ? "status-active" : "status-declined"}">${escapeHtml(TXN_DIRECTION_LABEL_TH[t.direction] || t.direction)}</span>
      </div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">${thb(t.amount)} ${escapeHtml(t.currency)}</div>
      ${t.description ? `<div class="detail-line">${escapeHtml(t.description)}</div>` : ""}
      <div class="detail-line muted">${thaiDate(t.posted_at)}</div>
    </div>
  `;
}

async function loadFinanceTransactions() {
  const el = document.getElementById("financeTransactionsSection");
  try {
    const rows = await AgroLinkCoopAPI.get("/coop/finance/transactions");
    if (rows.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีรายการเดินบัญชี</div>`;
      return;
    }
    el.innerHTML = rows.map(transactionCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการเดินบัญชีไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function refreshFinance() {
  await Promise.all([loadFinanceSummary(), loadFinanceMonthly(), loadFinanceTransactions()]);
}

// ---------- การรับซื้อ ----------
const DELIVERY_STATUS_LABEL_TH = {
  delivered: "รับซื้อแล้ว (รอตรวจคุณภาพ)",
  accepted: "ตรวจคุณภาพผ่านแล้ว (รอชำระเงิน)",
  rejected: "ไม่ผ่านการตรวจคุณภาพ",
  settled: "ชำระเงินแล้ว",
};
const DELIVERY_STATUS_BADGE_CLASS = {
  delivered: "status-pending",
  accepted: "status-approved",
  rejected: "status-declined",
  settled: "status-completed",
};

let openLotsCache = [];
// All lots (any status), refreshed by loadLotList() — reused by the
// "submit a quote" / "place a bid" forms on RFQ Browse / Auction Browse
// below, so a cooperative offering to fulfill someone else's produce RFQ
// can tag its offer as fulfilling from a specific collected lot (see
// procurement.rfq_quote.lot_id / procurement.auction_bid.lot_id, B2B
// Commerce Engine Phase 3 — deliberately NOT on the RFQ itself; see that
// migration's design note 8 for why). Kept separate from openLotsCache
// above (which is status=Open only, used elsewhere for assigning NEW
// deliveries) since reselling makes just as much sense for an
// already-Closed lot.
let allLotsCache = [];

function lotAssignControl(d) {
  if (d.lot_id) {
    return `<div class="detail-line muted">อยู่ในล็อต: ${escapeHtml(d.lot_id.slice(0, 8))}…</div>`;
  }
  if (d.status !== "delivered" && d.status !== "accepted") return "";
  const matching = openLotsCache.filter((l) => l.commodity_code === d.commodity_code);
  if (matching.length === 0) return "";
  return `
    <div class="action-row">
      <select class="reject-reason-input" data-lot-select-for="${d.delivery_id}">
        <option value="">-- เพิ่มเข้าล็อต (ไม่บังคับ) --</option>
        ${matching.map((l) => `<option value="${l.lot_id}">${escapeHtml(l.lot_note || l.lot_id.slice(0, 8))}</option>`).join("")}
      </select>
      <button type="button" class="btn btn-ghost btn-sm" data-assign-lot="${d.delivery_id}">เพิ่มเข้าล็อต</button>
    </div>
  `;
}

function deliveryCard(d) {
  const badgeClass = DELIVERY_STATUS_BADGE_CLASS[d.status] || "status-pending";
  const badge = `<span class="badge ${badgeClass}">${escapeHtml(DELIVERY_STATUS_LABEL_TH[d.status] || d.status)}</span>`;

  let actions = "";
  if (d.status === "delivered") {
    actions = `
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-grade-for="${d.delivery_id}" placeholder="เกรดคุณภาพ (เช่น A, B, เกรด 1)" />
        <input type="text" class="reject-reason-input" data-inspector-for="${d.delivery_id}" placeholder="ชื่อผู้ตรวจสอบ" />
        <input type="number" min="0" max="100" step="0.1" class="reject-reason-input" data-moisture-for="${d.delivery_id}" placeholder="ความชื้น % (ไม่บังคับ)" />
      </div>
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm" data-accept-quality="${d.delivery_id}">ผ่านคุณภาพ</button>
        <button type="button" class="btn btn-decline btn-sm" data-reject-quality="${d.delivery_id}">ไม่ผ่านคุณภาพ</button>
      </div>
    `;
  } else if (d.status === "accepted") {
    actions = `
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm" data-settle-delivery="${d.delivery_id}">ชำระเงิน (Settle)</button>
      </div>
    `;
  }

  return `
    <div class="item-card" data-delivery-id="${d.delivery_id}">
      <div class="row"><span class="title">${escapeHtml(d.farmer_name || "-")} — ${escapeHtml(d.commodity_code)}</span>${badge}</div>
      <div class="detail-line">น้ำหนัก ${Number(d.quantity_ton).toLocaleString("th-TH")} ตัน${d.unit_price ? ` × ${thb(d.unit_price)} บาท/ตัน` : ""}</div>
      ${d.total_amount ? `<div class="detail-line" style="font-weight:700; color:var(--green-900);">รวม ${thb(d.total_amount)} บาท</div>` : ""}
      ${d.quality_grade ? `<div class="detail-line">เกรดคุณภาพ: ${escapeHtml(d.quality_grade)}${d.inspected_by ? " · ผู้ตรวจ: " + escapeHtml(d.inspected_by) : ""}${d.moisture_pct !== null && d.moisture_pct !== undefined ? " · ความชื้น: " + Number(d.moisture_pct).toLocaleString("th-TH") + "%" : ""}</div>` : ""}
      <div class="detail-line muted">รับซื้อเมื่อ ${thaiDate(d.delivered_at)}${d.settled_at ? " · ชำระเงินเมื่อ " + thaiDate(d.settled_at) : ""}</div>
      ${lotAssignControl(d)}
      ${actions}
    </div>
  `;
}

async function loadDeliveryReviewQueue() {
  const el = document.getElementById("deliveryReviewQueueSection");
  try {
    const deliveries = await AgroLinkCoopAPI.get("/coop/deliveries?status=action_needed");
    if (deliveries.length === 0) {
      el.innerHTML = `<div class="empty-state">ไม่มีการรับซื้อที่ต้องดำเนินการในขณะนี้</div>`;
      return;
    }
    el.innerHTML = deliveries.map(deliveryCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการรับซื้อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadDeliveryHistory() {
  const el = document.getElementById("deliveryHistorySection");
  const status = document.getElementById("deliveryStatusFilter").value;
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const deliveries = await AgroLinkCoopAPI.get(`/coop/deliveries${query}`);
    if (deliveries.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีการรับซื้อ</div>`;
      return;
    }
    el.innerHTML = deliveries.map(deliveryCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประวัติการรับซื้อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function refreshDeliveriesAndSummary() {
  // loadLotList() is included here (not just loadOpenLots()) because
  // assign-lot changes a lot's delivery_count/total_quantity_ton — without
  // this, the "ล็อตรวบรวมผลผลิต" list below would keep showing stale
  // counts after a delivery is assigned to (or, once that exists,
  // eventually removed from) a lot. refreshWarehouse() is included for the
  // same reason: opening a new lot here should immediately appear in the
  // M10 "ล็อตในคลัง" list below (as "ยังไม่เข้าคลัง", ready to receive).
  // refreshFinance() (M04) is included because confirm-quality/settle/
  // assign-lot can all change payables, cash balance, or inventory tons —
  // the finance dashboard above must not go stale after any of them.
  // refreshProcessing() (M11) is included because assign-lot changes how
  // much of a lot is available to commit to a processing batch (see
  // processing.v_lot_processing_availability) — the "เลือกล็อตที่จะนำเข้า"
  // dropdowns below must reflect that immediately.
  // refreshLogistics() (M13) is included for the same reason one level
  // further down the chain — a lot's shipping availability
  // (logistics.v_lot_shipping_availability) also depends on assign-lot.
  await Promise.all([loadOpenLots(), loadLotList(), loadDeliveryReviewQueue(), loadDeliveryHistory(), refreshSummary(), refreshWarehouse(), refreshFinance(), refreshProcessing(), refreshLogistics()]);
}

document.getElementById("deliveryStatusFilter").addEventListener("change", () => loadDeliveryHistory());

function handleDeliveryActionClick(container) {
  container.addEventListener("click", async (e) => {
    const acceptBtn = e.target.closest("[data-accept-quality]");
    const rejectBtn = e.target.closest("[data-reject-quality]");
    const settleBtn = e.target.closest("[data-settle-delivery]");
    const assignLotBtn = e.target.closest("[data-assign-lot]");

    if (acceptBtn || rejectBtn) {
      const deliveryId = (acceptBtn || rejectBtn).dataset.acceptQuality || (acceptBtn || rejectBtn).dataset.rejectQuality;
      const accepted = !!acceptBtn;
      const gradeInput = container.querySelector(`[data-grade-for="${deliveryId}"]`);
      const inspectorInput = container.querySelector(`[data-inspector-for="${deliveryId}"]`);
      const moistureInput = container.querySelector(`[data-moisture-for="${deliveryId}"]`);
      const qualityGrade = gradeInput ? gradeInput.value.trim() : "";
      const inspectedBy = inspectorInput ? inspectorInput.value.trim() : "";
      const moistureRaw = moistureInput ? moistureInput.value.trim() : "";
      if (!qualityGrade || !inspectedBy) {
        toast("กรุณากรอกเกรดคุณภาพและชื่อผู้ตรวจสอบ", true);
        return;
      }
      const btn = acceptBtn || rejectBtn;
      btn.disabled = true;
      try {
        await AgroLinkCoopAPI.post(`/coop/deliveries/${deliveryId}/confirm-quality`, {
          quality_grade: qualityGrade,
          accepted,
          inspected_by: inspectedBy,
          moisture_pct: moistureRaw === "" ? undefined : Number(moistureRaw),
        });
        toast(accepted ? "บันทึกผลตรวจคุณภาพ (ผ่าน) เรียบร้อยแล้ว" : "บันทึกผลตรวจคุณภาพ (ไม่ผ่าน) เรียบร้อยแล้ว");
        await refreshDeliveriesAndSummary();
      } catch (err) {
        toast("ดำเนินการไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
        btn.disabled = false;
      }
      return;
    }

    if (settleBtn) {
      const deliveryId = settleBtn.dataset.settleDelivery;
      settleBtn.disabled = true;
      try {
        await AgroLinkCoopAPI.post(`/coop/deliveries/${deliveryId}/settle`, {});
        toast("ชำระเงินเรียบร้อยแล้ว");
        await refreshDeliveriesAndSummary();
      } catch (err) {
        toast("ชำระเงินไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
        settleBtn.disabled = false;
      }
      return;
    }

    if (assignLotBtn) {
      const deliveryId = assignLotBtn.dataset.assignLot;
      const select = container.querySelector(`[data-lot-select-for="${deliveryId}"]`);
      const lotId = select ? select.value : "";
      if (!lotId) {
        toast("กรุณาเลือกล็อตที่จะเพิ่มเข้า", true);
        return;
      }
      assignLotBtn.disabled = true;
      try {
        await AgroLinkCoopAPI.post(`/coop/deliveries/${deliveryId}/assign-lot`, { lot_id: lotId });
        toast("เพิ่มเข้าล็อตเรียบร้อยแล้ว");
        await refreshDeliveriesAndSummary();
      } catch (err) {
        toast("เพิ่มเข้าล็อตไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
        assignLotBtn.disabled = false;
      }
    }
  });
}

handleDeliveryActionClick(document.getElementById("deliveryReviewQueueSection"));
handleDeliveryActionClick(document.getElementById("deliveryHistorySection"));

// ---------- แบบฟอร์มบันทึกการรับซื้อใหม่ ----------
const deliveryForm = document.getElementById("deliveryForm");
const contractSelect = document.getElementById("contractSelect");
const unitPriceInput = document.getElementById("unitPriceInput");

function updateUnitPriceRequirement() {
  const hasContract = !!contractSelect.value;
  unitPriceInput.required = !hasContract;
  unitPriceInput.placeholder = hasContract ? "ใช้ราคาตามสัญญาโดยอัตโนมัติ" : "เช่น 12000";
  unitPriceInput.disabled = hasContract;
  if (hasContract) unitPriceInput.value = "";
}
contractSelect.addEventListener("change", updateUnitPriceRequirement);

async function loadProductionUnits() {
  const el = document.getElementById("unitSelect");
  try {
    const units = await AgroLinkCoopAPI.get("/coop/production-units");
    el.innerHTML = `<option value="">-- เลือกแปลง --</option>` +
      units.map((u) => `<option value="${u.unit_id}">${escapeHtml(u.farmer_name)} — ${escapeHtml(u.commodity_code)} (${Number(u.area_rai).toLocaleString("th-TH")} ไร่)</option>`).join("");
  } catch (err) {
    el.innerHTML = `<option value="">โหลดรายชื่อแปลงไม่สำเร็จ</option>`;
  }
}

let commodityCache = [];
async function loadCommodities() {
  const el = document.getElementById("commoditySelect");
  const lotEl = document.getElementById("lotCommoditySelect");
  const batchEl = document.getElementById("batchCommoditySelect");
  try {
    commodityCache = await AgroLinkCoopAPI.get("/coop/commodities");
    const options = `<option value="">-- เลือกชนิดผลผลิต --</option>` +
      commodityCache.map((c) => `<option value="${c.commodity_code}">${escapeHtml(c.name_th)}</option>`).join("");
    el.innerHTML = options;
    lotEl.innerHTML = options;
    batchEl.innerHTML = options;
  } catch (err) {
    el.innerHTML = `<option value="">โหลดชนิดผลผลิตไม่สำเร็จ</option>`;
    lotEl.innerHTML = el.innerHTML;
    batchEl.innerHTML = el.innerHTML;
  }
}

deliveryForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const unitId = document.getElementById("unitSelect").value;
  const commodityCode = document.getElementById("commoditySelect").value;
  const quantityTon = Number(document.getElementById("quantityInput").value);
  const contractId = contractSelect.value || null;
  const unitPriceRaw = unitPriceInput.value;

  if (!unitId || !commodityCode) {
    toast("กรุณาเลือกแปลงและชนิดผลผลิต", true);
    return;
  }
  if (!Number.isFinite(quantityTon) || quantityTon <= 0) {
    toast("กรุณากรอกน้ำหนักที่มากกว่า 0", true);
    return;
  }
  if (!contractId && !unitPriceRaw) {
    toast("กรุณากรอกราคาต่อหน่วยเมื่อไม่มีสัญญา", true);
    return;
  }

  const submitBtn = document.getElementById("deliverySubmitBtn");
  submitBtn.disabled = true;
  try {
    await AgroLinkCoopAPI.post("/coop/deliveries", {
      unit_id: unitId,
      commodity_code: commodityCode,
      quantity_ton: quantityTon,
      contract_id: contractId,
      unit_price: unitPriceRaw ? Number(unitPriceRaw) : undefined,
    });
    toast("บันทึกการรับซื้อเรียบร้อยแล้ว");
    deliveryForm.reset();
    updateUnitPriceRequirement();
    await refreshDeliveriesAndSummary();
  } catch (err) {
    toast("บันทึกไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- ล็อตรวบรวมผลผลิต ----------
function lotCard(l) {
  const badgeClass = l.status === "Open" ? "status-active" : "status-completed";
  const badge = `<span class="badge ${badgeClass}">${l.status === "Open" ? "เปิดอยู่" : "ปิดแล้ว"}</span>`;
  return `
    <div class="item-card" data-lot-id="${l.lot_id}">
      <div class="row"><span class="title">${escapeHtml(l.lot_note || ("ล็อต " + l.lot_id.slice(0, 8)))}</span>${badge}</div>
      <div class="detail-line">สินค้า: ${escapeHtml(l.commodity_code)}${l.quality_grade ? " · เกรด " + escapeHtml(l.quality_grade) : ""}</div>
      <div class="detail-line">จำนวนรายการ: ${l.delivery_count} รายการ · น้ำหนักรวม ${Number(l.total_quantity_ton).toLocaleString("th-TH")} ตัน</div>
      <div class="detail-line muted">เปิดเมื่อ ${thaiDate(l.created_at)}${l.closed_at ? " · ปิดเมื่อ " + thaiDate(l.closed_at) : ""}</div>
      ${l.status === "Open" ? `<div class="action-row"><button type="button" class="btn btn-ghost btn-sm" data-close-lot="${l.lot_id}">ปิดล็อต</button></div>` : ""}
    </div>
  `;
}

async function loadOpenLots() {
  try {
    openLotsCache = await AgroLinkCoopAPI.get("/coop/lots?status=Open");
  } catch (err) {
    openLotsCache = [];
  }
}

async function loadLotList() {
  const el = document.getElementById("lotListSection");
  try {
    const lots = await AgroLinkCoopAPI.get("/coop/lots");
    allLotsCache = lots;
    if (lots.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีล็อต — ใช้ฟอร์มด้านบนเพื่อเปิดล็อตแรก</div>`;
      return;
    }
    el.innerHTML = lots.map(lotCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการล็อตไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

// Renders the optional lot-selection <select> for a produce-category
// quote/bid form (see allLotsCache's doc comment above). formType/id form
// the data-attribute the submit handler reads back
// (data-rfq-quote-lot="<rfqId>" or data-bid-lot="<auctionId>").
function lotSelectFieldHtml(attrName, id) {
  const options = allLotsCache
    .map((l) => `<option value="${l.lot_id}">${escapeHtml(l.commodity_code)} · ${escapeHtml(l.status)} · ${rfqMoney(l.total_quantity_ton)} ตัน (${l.delivery_count} รายการ)</option>`)
    .join("");
  return `
    <div class="field full">
      <label>ล็อตที่จะขาย (ถ้าข้อเสนอนี้คือการขายผลผลิตจากล็อตของสหกรณ์)</label>
      <select ${attrName}="${id}">
        <option value="">— ไม่ระบุ (ไม่ใช่การขายจากล็อต) —</option>
        ${options}
      </select>
      <p style="font-size:12px; color:var(--gray-500); margin:4px 0 0;">
        เลือกล็อตเพื่อให้ระบบคำนวณสัดส่วนกระจายรายได้คืนสมาชิกอัตโนมัติหลังขายสำเร็จและได้รับเงินแล้ว
        (ดูหัวข้อ "กระจายรายได้คืนสมาชิก")
      </p>
    </div>
  `;
}

document.getElementById("lotForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const commodityCode = document.getElementById("lotCommoditySelect").value;
  const qualityGrade = document.getElementById("lotGradeInput").value.trim();
  const lotNote = document.getElementById("lotNoteInput").value.trim();

  if (!commodityCode) {
    toast("กรุณาเลือกชนิดผลผลิต", true);
    return;
  }

  const btn = document.getElementById("lotSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkCoopAPI.post("/coop/lots", {
      commodity_code: commodityCode,
      quality_grade: qualityGrade || undefined,
      lot_note: lotNote || undefined,
    });
    toast("เปิดล็อตใหม่เรียบร้อยแล้ว");
    document.getElementById("lotForm").reset();
    await refreshDeliveriesAndSummary();
  } catch (err) {
    toast("เปิดล็อตไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("lotListSection").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-close-lot]");
  if (!btn) return;
  const lotId = btn.dataset.closeLot;
  btn.disabled = true;
  try {
    await AgroLinkCoopAPI.post(`/coop/lots/${lotId}/close`, {});
    toast("ปิดล็อตเรียบร้อยแล้ว");
    await refreshDeliveriesAndSummary();
  } catch (err) {
    toast("ปิดล็อตไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
    btn.disabled = false;
  }
});

// ---------- คลังสินค้า/ลานตาก (M10) ----------
let binsCache = []; // flat list across all facilities, for the receive/transfer bin dropdowns

function staffName() {
  return document.getElementById("warehouseStaffInput").value.trim();
}
function requireStaffName() {
  const name = staffName();
  if (!name) toast("กรุณากรอกชื่อเจ้าหน้าที่คลังผู้บันทึกก่อน", true);
  return name;
}

function utilizationBar(pct) {
  if (pct === null || pct === undefined) return "";
  const clamped = Math.max(0, Math.min(100, Number(pct)));
  const color = clamped >= 90 ? "#c0392b" : clamped >= 70 ? "#d68910" : "#1B5E20";
  return `
    <div style="background:#e8e8e0; border-radius:6px; height:8px; overflow:hidden; margin:4px 0;">
      <div style="background:${color}; width:${clamped}%; height:100%;"></div>
    </div>
  `;
}

function facilityCard(f, bins) {
  const binsHtml = bins.length === 0
    ? `<div class="detail-line muted">ยังไม่มีตำแหน่งจัดเก็บ</div>`
    : bins.map((b) => `
        <div class="detail-line">
          ${escapeHtml(b.bin_code)}: ${Number(b.current_quantity_ton).toLocaleString("th-TH")}${b.capacity_ton ? " / " + Number(b.capacity_ton).toLocaleString("th-TH") : ""} ตัน
          ${b.capacity_ton ? " (" + b.utilization_pct + "%)" : ""}
          ${utilizationBar(b.utilization_pct)}
        </div>
      `).join("");

  return `
    <div class="item-card" data-facility-id="${f.facility_id}">
      <div class="row">
        <span class="title">${escapeHtml(f.facility_name)}</span>
        <span class="badge status-active">${escapeHtml({ Warehouse: "คลังสินค้า", DryingYard: "ลานตาก", Silo: "ไซโล", ProcessingPlant: "โรงสี/โรงงานแปรรูป" }[f.facility_type] || f.facility_type)}</span>
      </div>
      ${f.capacity_ton ? `<div class="detail-line muted">ความจุรวม ${Number(f.capacity_ton).toLocaleString("th-TH")} ตัน</div>` : ""}
      ${binsHtml}
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-bin-code-for="${f.facility_id}" placeholder="รหัสตำแหน่งใหม่ เช่น A1" />
        <input type="number" min="0.01" step="0.01" class="reject-reason-input" data-bin-capacity-for="${f.facility_id}" placeholder="ความจุ (ตัน) ไม่บังคับ" />
        <button type="button" class="btn btn-ghost btn-sm" data-add-bin="${f.facility_id}">เพิ่มตำแหน่งจัดเก็บ</button>
      </div>
    </div>
  `;
}

let facilitiesCache = []; // flat list of facility records (all types), for the M11 batch-form facility picker

function renderBatchFacilityOptions() {
  const el = document.getElementById("batchFacilitySelect");
  if (!el) return;
  el.innerHTML = `<option value="">-- ไม่ระบุ --</option>` +
    facilitiesCache.filter((f) => f.status === "active").map((f) => `<option value="${f.facility_id}">${escapeHtml(f.facility_name)}</option>`).join("");
}

async function loadFacilities() {
  const el = document.getElementById("facilityListSection");
  try {
    const facilities = await AgroLinkCoopAPI.get("/coop/warehouse/facilities");
    if (facilities.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีคลัง/ลานตาก — ใช้ฟอร์มด้านบนเพื่อเปิดแห่งแรก</div>`;
      binsCache = [];
      facilitiesCache = [];
      renderBatchFacilityOptions();
      return;
    }
    const details = await Promise.all(facilities.map((f) => AgroLinkCoopAPI.get(`/coop/warehouse/facilities/${f.facility_id}`)));
    binsCache = details.flatMap((d) => d.bins.map((b) => ({ ...b, facility_id: d.facility.facility_id, facility_name: d.facility.facility_name })));
    facilitiesCache = details.map((d) => d.facility);
    renderBatchFacilityOptions();
    el.innerHTML = details.map((d) => facilityCard(d.facility, d.bins)).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายชื่อคลัง/ลานตากไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("facilityForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const facilityName = document.getElementById("facilityNameInput").value.trim();
  const facilityType = document.getElementById("facilityTypeSelect").value;
  const capacityRaw = document.getElementById("facilityCapacityInput").value;

  if (!facilityName) {
    toast("กรุณากรอกชื่อคลัง/ลานตาก", true);
    return;
  }

  const btn = document.getElementById("facilitySubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkCoopAPI.post("/coop/warehouse/facilities", {
      facility_name: facilityName,
      facility_type: facilityType,
      capacity_ton: capacityRaw ? Number(capacityRaw) : undefined,
    });
    toast("เปิดคลัง/ลานตากใหม่เรียบร้อยแล้ว");
    document.getElementById("facilityForm").reset();
    await refreshWarehouse();
  } catch (err) {
    toast("เปิดคลัง/ลานตากไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("facilityListSection").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-add-bin]");
  if (!btn) return;
  const facilityId = btn.dataset.addBin;
  const codeInput = document.querySelector(`[data-bin-code-for="${facilityId}"]`);
  const capacityInput = document.querySelector(`[data-bin-capacity-for="${facilityId}"]`);
  const binCode = codeInput.value.trim();
  const capacityRaw = capacityInput.value;

  if (!binCode) {
    toast("กรุณากรอกรหัสตำแหน่งจัดเก็บ", true);
    return;
  }

  btn.disabled = true;
  try {
    await AgroLinkCoopAPI.post(`/coop/warehouse/facilities/${facilityId}/bins`, {
      bin_code: binCode,
      capacity_ton: capacityRaw ? Number(capacityRaw) : undefined,
    });
    toast("เพิ่มตำแหน่งจัดเก็บเรียบร้อยแล้ว");
    // refreshWarehouse() (not just loadFacilities()) — the "ล็อตในคลัง"
    // list's receive/transfer bin dropdowns are rendered from binsCache at
    // the time loadWarehouseLots() last ran, so a newly added bin wouldn't
    // show up there until this also re-renders that list.
    await refreshWarehouse();
  } catch (err) {
    toast("เพิ่มตำแหน่งจัดเก็บไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

/**
 * opts.onlyFacilityId — restrict to bins in one facility (used for the
 * transfer dropdown: warehouse.transfer_lot() rejects cross-facility moves,
 * see grant_cooperative_warehouse.sql, so the UI only offers valid targets
 * in the first place rather than letting the user hit that 409).
 * opts.excludeBinId — drop one bin (the lot's current bin, so "transfer to
 * itself" isn't offered).
 */
function binOptions(opts = {}) {
  return binsCache
    .filter((b) => b.status === "active")
    .filter((b) => !opts.onlyFacilityId || b.facility_id === opts.onlyFacilityId)
    .filter((b) => !opts.excludeBinId || b.bin_id !== opts.excludeBinId)
    .map((b) => `<option value="${b.bin_id}">${escapeHtml(b.facility_name)} — ${escapeHtml(b.bin_code)}</option>`)
    .join("");
}

const WAREHOUSE_STATUS_LABEL_TH = {
  in_storage: "อยู่ในคลัง", released: "นำออกจากคลังแล้ว", not_in_warehouse: "ยังไม่เข้าคลัง",
};

function warehouseLotCard(l) {
  const badgeClass = l.warehouse_status === "in_storage" ? "status-active" : l.warehouse_status === "released" ? "status-completed" : "status-pending";
  const badge = `<span class="badge ${badgeClass}">${escapeHtml(WAREHOUSE_STATUS_LABEL_TH[l.warehouse_status] || l.warehouse_status)}</span>`;

  let locationLine = "";
  if (l.warehouse_status === "in_storage") {
    locationLine = `<div class="detail-line">ตำแหน่งปัจจุบัน: ${escapeHtml(l.facility_name)} — ${escapeHtml(l.bin_code)}${l.age_days !== null ? ` · เก็บมาแล้ว ${l.age_days} วัน` : ""}</div>`;
  } else if (l.warehouse_status === "released" && l.age_days !== null) {
    locationLine = `<div class="detail-line muted">เคยเก็บในคลังมาแล้ว ${l.age_days} วัน ก่อนนำออก</div>`;
  }

  let actions = "";
  if (l.warehouse_status === "not_in_warehouse" || l.warehouse_status === "released") {
    actions = `
      <div class="action-row">
        <select class="reject-reason-input" data-receive-bin-for="${l.lot_id}">
          <option value="">-- เลือกตำแหน่งจัดเก็บที่จะรับเข้า --</option>
          ${binOptions()}
        </select>
        <input type="number" min="0.01" step="0.01" class="reject-reason-input" data-receive-qty-for="${l.lot_id}" placeholder="น้ำหนัก (ตัน)" />
        <input type="number" min="0" max="100" step="0.1" class="reject-reason-input" data-receive-moisture-for="${l.lot_id}" placeholder="ความชื้น % (ไม่บังคับ)" />
      </div>
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm" data-receive-lot="${l.lot_id}">รับเข้าคลัง</button>
      </div>
    `;
  } else if (l.warehouse_status === "in_storage") {
    actions = `
      <div class="action-row">
        <input type="number" min="0" max="100" step="0.1" class="reject-reason-input" data-moisture-reading-for="${l.lot_id}" placeholder="ความชื้นล่าสุด %" />
        <button type="button" class="btn btn-ghost btn-sm" data-record-moisture="${l.lot_id}" data-bin-id="${l.current_bin_id}">บันทึกความชื้น</button>
      </div>
      <div class="action-row">
        <select class="reject-reason-input" data-transfer-bin-for="${l.lot_id}">
          <option value="">-- ย้ายไปตำแหน่ง (คลังเดียวกันเท่านั้น) --</option>
          ${binOptions({ onlyFacilityId: (binsCache.find((b) => b.bin_id === l.current_bin_id) || {}).facility_id, excludeBinId: l.current_bin_id })}
        </select>
        <input type="number" min="0.01" step="0.01" class="reject-reason-input" data-transfer-qty-for="${l.lot_id}" placeholder="น้ำหนัก (ตัน)" />
        <button type="button" class="btn btn-ghost btn-sm" data-transfer-lot="${l.lot_id}" data-from-bin-id="${l.current_bin_id}">ย้าย</button>
      </div>
      <div class="action-row">
        <input type="number" min="0.01" step="0.01" class="reject-reason-input" data-release-qty-for="${l.lot_id}" placeholder="น้ำหนักที่นำออก (ตัน)" />
        <button type="button" class="btn btn-decline btn-sm" data-release-lot="${l.lot_id}" data-from-bin-id="${l.current_bin_id}">นำออกจากคลัง</button>
      </div>
    `;
  }

  return `
    <div class="item-card" data-warehouse-lot-id="${l.lot_id}">
      <div class="row"><span class="title">${escapeHtml(l.lot_note || ("ล็อต " + l.lot_id.slice(0, 8)))} — ${escapeHtml(l.commodity_code)}</span>${badge}</div>
      <div class="detail-line muted">สถานะล็อต: ${l.lot_status === "Open" ? "เปิดอยู่" : "ปิดแล้ว"}${l.quality_grade ? " · เกรด " + escapeHtml(l.quality_grade) : ""}</div>
      ${locationLine}
      ${actions}
    </div>
  `;
}

async function loadWarehouseLots() {
  const el = document.getElementById("warehouseLotsSection");
  try {
    const lots = await AgroLinkCoopAPI.get("/coop/warehouse/lots");
    if (lots.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีล็อต — เปิดล็อตในส่วน "ล็อตรวบรวมผลผลิต" ด้านบนก่อน</div>`;
      return;
    }
    el.innerHTML = lots.map(warehouseLotCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดล็อตในคลังไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function refreshWarehouse() {
  await loadFacilities();
  await loadWarehouseLots();
}

document.getElementById("warehouseLotsSection").addEventListener("click", async (e) => {
  const receiveBtn = e.target.closest("[data-receive-lot]");
  const transferBtn = e.target.closest("[data-transfer-lot]");
  const releaseBtn = e.target.closest("[data-release-lot]");
  const moistureBtn = e.target.closest("[data-record-moisture]");

  if (receiveBtn) {
    const lotId = receiveBtn.dataset.receiveLot;
    const binId = document.querySelector(`[data-receive-bin-for="${lotId}"]`).value;
    const qty = document.querySelector(`[data-receive-qty-for="${lotId}"]`).value;
    const moisture = document.querySelector(`[data-receive-moisture-for="${lotId}"]`).value;
    const recordedBy = requireStaffName();
    if (!recordedBy) return;
    if (!binId || !qty) {
      toast("กรุณาเลือกตำแหน่งจัดเก็บและกรอกน้ำหนัก", true);
      return;
    }
    receiveBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post("/coop/warehouse/receive", {
        lot_id: lotId, bin_id: binId, quantity_ton: Number(qty), recorded_by: recordedBy,
        moisture_pct: moisture === "" ? undefined : Number(moisture),
      });
      toast("รับเข้าคลังเรียบร้อยแล้ว");
      await refreshWarehouse();
    } catch (err) {
      toast("รับเข้าคลังไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      receiveBtn.disabled = false;
    }
    return;
  }

  if (transferBtn) {
    const lotId = transferBtn.dataset.transferLot;
    const fromBinId = transferBtn.dataset.fromBinId;
    const toBinId = document.querySelector(`[data-transfer-bin-for="${lotId}"]`).value;
    const qty = document.querySelector(`[data-transfer-qty-for="${lotId}"]`).value;
    const recordedBy = requireStaffName();
    if (!recordedBy) return;
    if (!toBinId || !qty) {
      toast("กรุณาเลือกตำแหน่งปลายทางและกรอกน้ำหนัก", true);
      return;
    }
    transferBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post("/coop/warehouse/transfer", {
        lot_id: lotId, from_bin_id: fromBinId, to_bin_id: toBinId, quantity_ton: Number(qty), recorded_by: recordedBy,
      });
      toast("ย้ายตำแหน่งเรียบร้อยแล้ว");
      await refreshWarehouse();
    } catch (err) {
      toast("ย้ายตำแหน่งไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      transferBtn.disabled = false;
    }
    return;
  }

  if (releaseBtn) {
    const lotId = releaseBtn.dataset.releaseLot;
    const fromBinId = releaseBtn.dataset.fromBinId;
    const qty = document.querySelector(`[data-release-qty-for="${lotId}"]`).value;
    const recordedBy = requireStaffName();
    if (!recordedBy) return;
    if (!qty) {
      toast("กรุณากรอกน้ำหนักที่นำออก", true);
      return;
    }
    releaseBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post("/coop/warehouse/release", {
        lot_id: lotId, from_bin_id: fromBinId, quantity_ton: Number(qty), recorded_by: recordedBy,
      });
      toast("นำออกจากคลังเรียบร้อยแล้ว");
      await refreshWarehouse();
    } catch (err) {
      toast("นำออกจากคลังไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      releaseBtn.disabled = false;
    }
    return;
  }

  if (moistureBtn) {
    const lotId = moistureBtn.dataset.recordMoisture;
    const binId = moistureBtn.dataset.binId;
    const moisture = document.querySelector(`[data-moisture-reading-for="${lotId}"]`).value;
    const recordedBy = requireStaffName();
    if (!recordedBy) return;
    if (moisture === "") {
      toast("กรุณากรอกค่าความชื้น", true);
      return;
    }
    moistureBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post("/coop/warehouse/drying-readings", {
        lot_id: lotId, bin_id: binId, moisture_pct: Number(moisture), recorded_by: recordedBy,
      });
      toast("บันทึกความชื้นเรียบร้อยแล้ว");
      await refreshWarehouse();
    } catch (err) {
      toast("บันทึกความชื้นไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
      moistureBtn.disabled = false;
    }
  }
});

// ---------- การแปรรูปผลผลิต (M11) ----------
let lotsAvailableCache = []; // from GET /coop/processing/lots-available, filtered client-side per batch's source commodity

function lotAvailableOptions(commodityCode) {
  return lotsAvailableCache
    .filter((l) => l.commodity_code === commodityCode)
    .map((l) => `<option value="${l.lot_id}">${escapeHtml(l.lot_note || l.lot_id.slice(0, 8))} (เหลือ ${Number(l.available_quantity_ton).toLocaleString("th-TH")} ตัน)</option>`)
    .join("");
}

async function loadLotsAvailable() {
  try {
    lotsAvailableCache = await AgroLinkCoopAPI.get("/coop/processing/lots-available");
  } catch (err) {
    lotsAvailableCache = [];
  }
}

const BATCH_STATUS_LABEL_TH = { InProgress: "กำลังดำเนินการ", Completed: "เสร็จสิ้น", Cancelled: "ยกเลิกแล้ว" };
const BATCH_STATUS_BADGE_CLASS = { InProgress: "status-pending", Completed: "status-completed", Cancelled: "status-declined" };
const PROCESS_TYPE_LABEL_TH = { Milling: "สี/โม่", Drying: "อบแห้ง", Sorting: "คัดแยก", Packaging: "บรรจุภัณฑ์", Other: "อื่นๆ" };

/**
 * d is one full batch-detail object ({ batch, inputs, finished_goods,
 * contributing_farmers }) from GET /coop/processing/batches/:id — the list
 * view is loaded once, then every batch's detail is fetched in parallel
 * (same "list -> Promise.all(detail)" shape as M10's loadFacilities()) so
 * this card can show inputs/outputs/traceability without extra clicks.
 */
function processingBatchCard(d) {
  const b = d.batch;
  const badge = `<span class="badge ${BATCH_STATUS_BADGE_CLASS[b.status] || "status-pending"}">${escapeHtml(BATCH_STATUS_LABEL_TH[b.status] || b.status)}</span>`;

  const inputsHtml = d.inputs.length === 0
    ? `<div class="detail-line muted">ยังไม่มีวัตถุดิบนำเข้า</div>`
    : d.inputs.map((i) => `<div class="detail-line">นำเข้า: ${escapeHtml(i.lot_note || i.lot_id.slice(0, 8))} — ${Number(i.quantity_ton).toLocaleString("th-TH")} ตัน</div>`).join("");

  const outputsHtml = d.finished_goods.length === 0
    ? `<div class="detail-line muted">ยังไม่มีผลผลิตที่บันทึก</div>`
    : d.finished_goods.map((fg) => `<div class="detail-line">${fg.is_primary_product ? "🌾" : "•"} ${escapeHtml(fg.product_name)}: ${Number(fg.quantity_ton).toLocaleString("th-TH")} ตัน (คงเหลือ ${Number(fg.quantity_on_hand_ton).toLocaleString("th-TH")} ตัน)</div>`).join("");

  const farmersHtml = d.contributing_farmers.length === 0 ? "" :
    `<div class="detail-line muted">แหล่งที่มา: ${d.contributing_farmers.map((f) => escapeHtml(f.farmer_name)).join(", ")}</div>`;

  let actions = "";
  if (b.status === "InProgress") {
    actions = `
      <div class="action-row">
        <select class="reject-reason-input" data-commit-lot-select-for="${b.batch_id}">
          <option value="">-- เลือกล็อตที่จะนำเข้า --</option>
          ${lotAvailableOptions(b.source_commodity_code)}
        </select>
        <input type="number" min="0.001" step="0.001" class="reject-reason-input" data-commit-qty-for="${b.batch_id}" placeholder="ปริมาณ (ตัน)" />
        <button type="button" class="btn btn-ghost btn-sm" data-commit-lot="${b.batch_id}">นำเข้าวัตถุดิบ</button>
      </div>
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-fg-name-for="${b.batch_id}" placeholder="ชื่อผลผลิต เช่น ข้าวสารหอมมะลิ 5%" />
        <input type="number" min="0.001" step="0.001" class="reject-reason-input" data-fg-qty-for="${b.batch_id}" placeholder="ปริมาณ (ตัน)" />
        <label style="display:flex; align-items:center; gap:4px; font-size:13px; white-space:nowrap;">
          <input type="checkbox" data-fg-primary-for="${b.batch_id}" checked /> ผลผลิตหลัก
        </label>
        <button type="button" class="btn btn-ghost btn-sm" data-add-fg="${b.batch_id}">บันทึกผลผลิต</button>
      </div>
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-complete-by-for="${b.batch_id}" placeholder="ชื่อผู้ปิดชุด" />
        <button type="button" class="btn btn-approve btn-sm" data-complete-batch="${b.batch_id}">ปิดชุด (เสร็จสิ้น)</button>
      </div>
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-cancel-by-for="${b.batch_id}" placeholder="ชื่อผู้ยกเลิก" />
        <input type="text" class="reject-reason-input" data-cancel-reason-for="${b.batch_id}" placeholder="เหตุผลที่ยกเลิก" />
        <button type="button" class="btn btn-decline btn-sm" data-cancel-batch="${b.batch_id}">ยกเลิกชุด</button>
      </div>
    `;
  } else if (b.status === "Cancelled") {
    actions = `<div class="detail-line muted">เหตุผลที่ยกเลิก: ${escapeHtml(b.cancel_reason || "-")} · โดย ${escapeHtml(b.cancelled_by || "-")}</div>`;
  }

  return `
    <div class="item-card" data-batch-id="${b.batch_id}">
      <div class="row"><span class="title">${escapeHtml(b.output_product_name)} — ${escapeHtml(PROCESS_TYPE_LABEL_TH[b.process_type] || b.process_type)}</span>${badge}</div>
      <div class="detail-line muted">วัตถุดิบ: ${escapeHtml(b.source_commodity_name || b.source_commodity_code)}${b.facility_name ? " · ที่: " + escapeHtml(b.facility_name) : ""}</div>
      <div class="detail-line">นำเข้ารวม ${Number(b.input_quantity_ton).toLocaleString("th-TH")} ตัน · ผลผลิตรวม ${Number(b.output_quantity_ton).toLocaleString("th-TH")} ตัน${b.yield_pct !== null && b.yield_pct !== undefined ? ` · yield ${b.yield_pct}%` : ""}</div>
      ${inputsHtml}
      ${outputsHtml}
      ${farmersHtml}
      <div class="detail-line muted">เริ่มเมื่อ ${thaiDate(b.started_at)} โดย ${escapeHtml(b.started_by)}${b.completed_at ? " · เสร็จสิ้นเมื่อ " + thaiDate(b.completed_at) : ""}</div>
      ${b.batch_note ? `<div class="detail-line muted">หมายเหตุ: ${escapeHtml(b.batch_note)}</div>` : ""}
      ${actions}
    </div>
  `;
}

async function loadProcessingBatches() {
  const el = document.getElementById("processingBatchesSection");
  try {
    const batches = await AgroLinkCoopAPI.get("/coop/processing/batches");
    if (batches.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีชุดการแปรรูป — ใช้ฟอร์มด้านบนเพื่อเริ่มชุดแรก</div>`;
      return;
    }
    const details = await Promise.all(batches.map((b) => AgroLinkCoopAPI.get(`/coop/processing/batches/${b.batch_id}`)));
    el.innerHTML = details.map(processingBatchCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการชุดแปรรูปไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

function finishedGoodCard(fg) {
  return `
    <div class="item-card" data-finished-good-id="${fg.finished_good_id}">
      <div class="row">
        <span class="title">${fg.is_primary_product ? "🌾" : "•"} ${escapeHtml(fg.product_name)}</span>
        <span class="badge status-active">คงเหลือ ${Number(fg.quantity_on_hand_ton).toLocaleString("th-TH")} ตัน</span>
      </div>
      <div class="detail-line muted">จากชุด: ${escapeHtml(fg.batch_output_product_name)}${fg.batch_status !== "Completed" ? " (" + escapeHtml(BATCH_STATUS_LABEL_TH[fg.batch_status] || fg.batch_status) + ")" : ""}</div>
      <div class="detail-line">ผลิตแล้ว ${Number(fg.produced_quantity_ton).toLocaleString("th-TH")} ตัน · นำออกแล้ว ${Number(fg.dispatched_quantity_ton).toLocaleString("th-TH")} ตัน</div>
      ${fg.quantity_on_hand_ton > 0 ? `
        <div class="action-row">
          <input type="number" min="0.001" step="0.001" class="reject-reason-input" data-dispatch-qty-for="${fg.finished_good_id}" placeholder="ปริมาณที่นำออก (ตัน)" />
          <input type="text" class="reject-reason-input" data-dispatch-by-for="${fg.finished_good_id}" placeholder="ชื่อผู้บันทึก" />
          <input type="text" class="reject-reason-input" data-dispatch-note-for="${fg.finished_good_id}" placeholder="หมายเหตุ (ไม่บังคับ)" />
          <button type="button" class="btn btn-ghost btn-sm" data-dispatch-fg="${fg.finished_good_id}">นำออกจากสต็อก</button>
        </div>
      ` : ""}
    </div>
  `;
}

async function loadFinishedGoods() {
  const el = document.getElementById("finishedGoodsSection");
  try {
    const rows = await AgroLinkCoopAPI.get("/coop/processing/finished-goods");
    if (rows.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีสินค้าสำเร็จรูป — ปิดชุดการแปรรูปด้านบนเพื่อบันทึกผลผลิต</div>`;
      return;
    }
    el.innerHTML = rows.map(finishedGoodCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดสินค้าสำเร็จรูปไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function refreshProcessing() {
  await loadLotsAvailable();
  await loadProcessingBatches();
  await loadFinishedGoods();
}

document.getElementById("batchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const facilityId = document.getElementById("batchFacilitySelect").value;
  const sourceCommodityCode = document.getElementById("batchCommoditySelect").value;
  const processType = document.getElementById("batchProcessTypeSelect").value;
  const outputProductName = document.getElementById("batchOutputNameInput").value.trim();
  const startedBy = document.getElementById("batchStartedByInput").value.trim();
  const batchNote = document.getElementById("batchNoteInput").value.trim();

  if (!sourceCommodityCode || !outputProductName || !startedBy) {
    toast("กรุณากรอกชนิดผลผลิต ชื่อผลผลิตที่คาดว่าจะได้ และชื่อผู้เริ่มดำเนินการ", true);
    return;
  }

  const btn = document.getElementById("batchSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkCoopAPI.post("/coop/processing/batches", {
      facility_id: facilityId || undefined,
      source_commodity_code: sourceCommodityCode,
      process_type: processType,
      output_product_name: outputProductName,
      started_by: startedBy,
      batch_note: batchNote || undefined,
    });
    toast("เริ่มชุดการแปรรูปใหม่เรียบร้อยแล้ว");
    document.getElementById("batchForm").reset();
    await refreshProcessing();
  } catch (err) {
    toast("เริ่มชุดการแปรรูปไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("processingBatchesSection").addEventListener("click", async (e) => {
  const commitBtn = e.target.closest("[data-commit-lot]");
  const addFgBtn = e.target.closest("[data-add-fg]");
  const completeBtn = e.target.closest("[data-complete-batch]");
  const cancelBtn = e.target.closest("[data-cancel-batch]");

  if (commitBtn) {
    const batchId = commitBtn.dataset.commitLot;
    const lotId = document.querySelector(`[data-commit-lot-select-for="${batchId}"]`).value;
    const qty = document.querySelector(`[data-commit-qty-for="${batchId}"]`).value;
    if (!lotId || !qty) {
      toast("กรุณาเลือกล็อตและกรอกปริมาณ", true);
      return;
    }
    commitBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/coop/processing/batches/${batchId}/commit-lot`, { lot_id: lotId, quantity_ton: Number(qty) });
      toast("นำเข้าวัตถุดิบเรียบร้อยแล้ว");
      await refreshProcessing();
    } catch (err) {
      toast("นำเข้าวัตถุดิบไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      commitBtn.disabled = false;
    }
    return;
  }

  if (addFgBtn) {
    const batchId = addFgBtn.dataset.addFg;
    const nameInput = document.querySelector(`[data-fg-name-for="${batchId}"]`);
    const qtyInput = document.querySelector(`[data-fg-qty-for="${batchId}"]`);
    const primaryInput = document.querySelector(`[data-fg-primary-for="${batchId}"]`);
    const productName = nameInput.value.trim();
    const qty = qtyInput.value;
    if (!productName || !qty) {
      toast("กรุณากรอกชื่อผลผลิตและปริมาณ", true);
      return;
    }
    addFgBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/coop/processing/batches/${batchId}/finished-goods`, {
        product_name: productName, quantity_ton: Number(qty), is_primary_product: primaryInput.checked,
      });
      toast("บันทึกผลผลิตเรียบร้อยแล้ว");
      await refreshProcessing();
    } catch (err) {
      toast("บันทึกผลผลิตไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      addFgBtn.disabled = false;
    }
    return;
  }

  if (completeBtn) {
    const batchId = completeBtn.dataset.completeBatch;
    const completedBy = document.querySelector(`[data-complete-by-for="${batchId}"]`).value.trim();
    if (!completedBy) {
      toast("กรุณากรอกชื่อผู้ปิดชุด", true);
      return;
    }
    completeBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/coop/processing/batches/${batchId}/complete`, { completed_by: completedBy });
      toast("ปิดชุดการแปรรูปเรียบร้อยแล้ว");
      await refreshProcessing();
    } catch (err) {
      toast("ปิดชุดไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      completeBtn.disabled = false;
    }
    return;
  }

  if (cancelBtn) {
    const batchId = cancelBtn.dataset.cancelBatch;
    const cancelledBy = document.querySelector(`[data-cancel-by-for="${batchId}"]`).value.trim();
    const reason = document.querySelector(`[data-cancel-reason-for="${batchId}"]`).value.trim();
    if (!cancelledBy || !reason) {
      toast("กรุณากรอกชื่อผู้ยกเลิกและเหตุผล", true);
      return;
    }
    cancelBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/coop/processing/batches/${batchId}/cancel`, { cancelled_by: cancelledBy, reason });
      toast("ยกเลิกชุดการแปรรูปเรียบร้อยแล้ว");
      await refreshProcessing();
    } catch (err) {
      toast("ยกเลิกชุดไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      cancelBtn.disabled = false;
    }
  }
});

document.getElementById("finishedGoodsSection").addEventListener("click", async (e) => {
  const dispatchBtn = e.target.closest("[data-dispatch-fg]");
  if (!dispatchBtn) return;
  const fgId = dispatchBtn.dataset.dispatchFg;
  const qty = document.querySelector(`[data-dispatch-qty-for="${fgId}"]`).value;
  const recordedBy = document.querySelector(`[data-dispatch-by-for="${fgId}"]`).value.trim();
  const note = document.querySelector(`[data-dispatch-note-for="${fgId}"]`).value.trim();
  if (!qty || !recordedBy) {
    toast("กรุณากรอกปริมาณและชื่อผู้บันทึก", true);
    return;
  }
  dispatchBtn.disabled = true;
  try {
    await AgroLinkCoopAPI.post(`/coop/processing/finished-goods/${fgId}/dispatch`, {
      quantity_ton: Number(qty), recorded_by: recordedBy, note: note || undefined,
    });
    toast("บันทึกการนำออกจากสต็อกเรียบร้อยแล้ว");
    await refreshProcessing();
  } catch (err) {
    toast("บันทึกการนำออกไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
    dispatchBtn.disabled = false;
  }
});

// ---------- การขนส่ง (M13) ----------
let carriersCache = []; // flat carrier list (active + inactive), for the shipment form's carrier picker
let vehiclesCache = []; // flat vehicle list across all carriers, for the shipment form's vehicle picker
let linkableOrgsCache = []; // GET /coop/logistics/linkable-orgs — Verified 'Logistics' orgs a carrier record can be linked to (see grant_logistics_portal.sql)
let shipLotsAvailableCache = []; // from GET /coop/logistics/lots-available — already nets out processing AND other shipments
let shipFinishedGoodsCache = []; // GET /coop/processing/finished-goods, filtered client-side to quantity_on_hand_ton > 0

const CARRIER_TYPE_LABEL_TH = { Internal: "รถของสหกรณ์เอง", ThirdParty: "ผู้รับจ้างขนส่ง" };
const VEHICLE_TYPE_LABEL_TH = { Truck: "รถบรรทุก", Pickup: "รถกระบะ", Trailer: "รถพ่วง", Other: "อื่นๆ" };
const SHIPMENT_STATUS_LABEL_TH = { Pending: "รอดำเนินการ", InTransit: "กำลังเดินทาง", Delivered: "ส่งมอบแล้ว", Cancelled: "ยกเลิกแล้ว" };
const SHIPMENT_STATUS_BADGE_CLASS = { Pending: "status-pending", InTransit: "status-active", Delivered: "status-completed", Cancelled: "status-declined" };
const EXCEPTION_TYPE_LABEL_TH = { Damage: "สินค้าเสียหาย", Shortage: "ขาดหาย", Delay: "ล่าช้า", Rejected: "ถูกปฏิเสธรับสินค้า", Other: "อื่นๆ" };

let govEndpointsCache = []; // GET /coop/gov/endpoints — platform-wide reference catalog, used to populate every endpoint dropdown in the M15 section
const GOV_CONSENT_STATUS_LABEL_TH = { Active: "ใช้งานอยู่", Revoked: "ถูกเพิกถอนแล้ว" };
const GOV_CONSENT_STATUS_BADGE_CLASS = { Active: "status-active", Revoked: "status-declined" };
const GOV_CREDENTIAL_STATUS_LABEL_TH = { Requested: "รอเปิดใช้งาน", Active: "ใช้งานอยู่", Expiring: "ใกล้หมดอายุ", Revoked: "ถูกเพิกถอนแล้ว", Expired: "หมดอายุแล้ว" };
const GOV_CREDENTIAL_STATUS_BADGE_CLASS = { Requested: "status-pending", Active: "status-active", Expiring: "status-pending", Revoked: "status-declined", Expired: "status-declined" };
const GOV_SUBMISSION_STATUS_LABEL_TH = { Queued: "อยู่ในคิว", Sent: "ส่งแล้ว (รอตอบรับ)", Acknowledged: "ตอบรับแล้ว", DeadLettered: "Dead-letter", Cancelled: "ยกเลิกแล้ว" };
const GOV_SUBMISSION_STATUS_BADGE_CLASS = { Queued: "status-pending", Sent: "status-active", Acknowledged: "status-completed", DeadLettered: "status-declined", Cancelled: "status-declined" };

function carrierCard(c) {
  const badge = `<span class="badge status-active">${escapeHtml(CARRIER_TYPE_LABEL_TH[c.carrier_type] || c.carrier_type)}</span>`;
  const vehiclesHtml = c.vehicles.length === 0
    ? `<div class="detail-line muted">ยังไม่มียานพาหนะ</div>`
    : c.vehicles.map((v) => `<div class="detail-line">${escapeHtml(VEHICLE_TYPE_LABEL_TH[v.vehicle_type] || v.vehicle_type)} — ทะเบียน ${escapeHtml(v.license_plate)}${v.capacity_ton ? ` (${Number(v.capacity_ton).toLocaleString("th-TH")} ตัน)` : ""}</div>`).join("");

  // Whether/who this carrier is linked to — see grant_logistics_portal.sql.
  // A linked carrier's org can log into frontend/logistics/ and see/act on
  // shipments this cooperative assigns to it.
  const linkStatusHtml = c.linked_org_id
    ? `<div class="detail-line">🔗 ผูกกับบัญชี: ${escapeHtml(c.linked_org_name || c.linked_org_id)}</div>`
    : `<div class="detail-line muted">ยังไม่ได้ผูกกับบัญชีองค์กรขนส่งใด (ผู้ขนส่งนี้ยังเข้าพอร์ทัลของตัวเองไม่ได้)</div>`;
  const linkOrgOptions = linkableOrgsCache
    .map((o) => `<option value="${o.org_id}" ${o.org_id === c.linked_org_id ? "selected" : ""}>${escapeHtml(o.org_name)}</option>`).join("");
  const linkActionRow = `
    <div class="action-row">
      <select class="reject-reason-input" data-link-org-select-for="${c.carrier_id}">
        <option value="">-- ไม่ผูก --</option>
        ${linkOrgOptions}
      </select>
      <button type="button" class="btn btn-ghost btn-sm" data-link-carrier="${c.carrier_id}">${c.linked_org_id ? "เปลี่ยน/ยกเลิกการผูกบัญชี" : "ผูกบัญชี"}</button>
    </div>
  `;

  return `
    <div class="item-card" data-carrier-id="${c.carrier_id}">
      <div class="row"><span class="title">${escapeHtml(c.carrier_name)}</span>${badge}</div>
      ${c.contact_phone ? `<div class="detail-line muted">เบอร์ติดต่อ: ${escapeHtml(c.contact_phone)}</div>` : ""}
      ${linkStatusHtml}
      ${vehiclesHtml}
      <div class="action-row">
        <select class="reject-reason-input" data-vehicle-type-for="${c.carrier_id}">
          <option value="Truck">รถบรรทุก</option>
          <option value="Pickup">รถกระบะ</option>
          <option value="Trailer">รถพ่วง</option>
          <option value="Other">อื่นๆ</option>
        </select>
        <input type="text" class="reject-reason-input" data-vehicle-plate-for="${c.carrier_id}" placeholder="ทะเบียนรถ เช่น กท-1234" />
        <input type="number" min="0.01" step="0.01" class="reject-reason-input" data-vehicle-capacity-for="${c.carrier_id}" placeholder="ความจุ (ตัน) ไม่บังคับ" />
        <button type="button" class="btn btn-ghost btn-sm" data-add-vehicle="${c.carrier_id}">เพิ่มยานพาหนะ</button>
      </div>
      ${linkActionRow}
    </div>
  `;
}

/** Loads Verified 'Logistics' orgs a carrier can be linked to. Called once
 * up front (see refreshLogistics) and re-used by both the "add carrier"
 * form's own select and every carrier card's link/unlink select. */
async function loadLinkableOrgs() {
  try {
    linkableOrgsCache = await AgroLinkCoopAPI.get("/coop/logistics/linkable-orgs");
  } catch (err) {
    linkableOrgsCache = [];
  }
  const select = document.getElementById("carrierLinkedOrgSelect");
  select.innerHTML = `<option value="">-- ไม่ผูก (พิมพ์ชื่อเองด้านบน) --</option>` +
    linkableOrgsCache.map((o) => `<option value="${o.org_id}">${escapeHtml(o.org_name)}</option>`).join("");
}

async function loadCarriers() {
  const el = document.getElementById("carrierListSection");
  try {
    const carriers = await AgroLinkCoopAPI.get("/coop/logistics/carriers");
    if (carriers.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีผู้ขนส่ง — ใช้ฟอร์มด้านบนเพื่อเพิ่มรายแรก</div>`;
      carriersCache = [];
      vehiclesCache = [];
    } else {
      const details = await Promise.all(carriers.map((c) => AgroLinkCoopAPI.get(`/coop/logistics/carriers/${c.carrier_id}`)));
      carriersCache = details.map((d) => d.carrier);
      vehiclesCache = details.flatMap((d) => d.vehicles.map((v) => ({ ...v, carrier_id: d.carrier.carrier_id })));
      el.innerHTML = details.map((d) => carrierCard({ ...d.carrier, vehicles: d.vehicles })).join("");
    }

    const carrierSelect = document.getElementById("shipmentCarrierSelect");
    carrierSelect.innerHTML = `<option value="">-- เลือกผู้ขนส่ง --</option>` +
      carriersCache.filter((c) => c.status === "active").map((c) => `<option value="${c.carrier_id}">${escapeHtml(c.carrier_name)}</option>`).join("");
    updateShipmentVehicleOptions();
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายชื่อผู้ขนส่งไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

function updateShipmentVehicleOptions() {
  const carrierId = document.getElementById("shipmentCarrierSelect").value;
  const vehicleSelect = document.getElementById("shipmentVehicleSelect");
  vehicleSelect.innerHTML = `<option value="">-- ไม่ระบุ --</option>` +
    vehiclesCache.filter((v) => v.status === "active" && v.carrier_id === carrierId)
      .map((v) => `<option value="${v.vehicle_id}">${escapeHtml(v.license_plate)}</option>`).join("");
}
document.getElementById("shipmentCarrierSelect").addEventListener("change", updateShipmentVehicleOptions);

document.getElementById("carrierForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const carrierName = document.getElementById("carrierNameInput").value.trim();
  const carrierType = document.getElementById("carrierTypeSelect").value;
  const contactPhone = document.getElementById("carrierPhoneInput").value.trim();
  const linkedOrgId = document.getElementById("carrierLinkedOrgSelect").value;

  if (!carrierName) {
    toast("กรุณากรอกชื่อผู้ขนส่ง", true);
    return;
  }

  const btn = document.getElementById("carrierSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkCoopAPI.post("/coop/logistics/carriers", {
      carrier_name: carrierName, carrier_type: carrierType, contact_phone: contactPhone || undefined,
      linked_org_id: linkedOrgId || undefined,
    });
    toast("เพิ่มผู้ขนส่งเรียบร้อยแล้ว");
    document.getElementById("carrierForm").reset();
    await loadCarriers();
  } catch (err) {
    toast("เพิ่มผู้ขนส่งไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("carrierListSection").addEventListener("click", async (e) => {
  const linkBtn = e.target.closest("[data-link-carrier]");
  if (!linkBtn) return;

  const carrierId = linkBtn.dataset.linkCarrier;
  const linkedOrgId = document.querySelector(`[data-link-org-select-for="${carrierId}"]`).value;

  linkBtn.disabled = true;
  try {
    await AgroLinkCoopAPI.post(`/coop/logistics/carriers/${carrierId}/link`, { linked_org_id: linkedOrgId || null });
    toast(linkedOrgId ? "ผูกบัญชีเรียบร้อยแล้ว" : "ยกเลิกการผูกบัญชีเรียบร้อยแล้ว");
    await loadCarriers();
  } catch (err) {
    toast("ผูกบัญชีไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
    linkBtn.disabled = false;
  }
});

document.getElementById("carrierListSection").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-add-vehicle]");
  if (!btn) return;
  const carrierId = btn.dataset.addVehicle;
  const vehicleType = document.querySelector(`[data-vehicle-type-for="${carrierId}"]`).value;
  const licensePlate = document.querySelector(`[data-vehicle-plate-for="${carrierId}"]`).value.trim();
  const capacityTon = document.querySelector(`[data-vehicle-capacity-for="${carrierId}"]`).value;

  if (!licensePlate) {
    toast("กรุณากรอกทะเบียนรถ", true);
    return;
  }

  btn.disabled = true;
  try {
    await AgroLinkCoopAPI.post(`/coop/logistics/carriers/${carrierId}/vehicles`, {
      vehicle_type: vehicleType, license_plate: licensePlate, capacity_ton: capacityTon ? Number(capacityTon) : undefined,
    });
    toast("เพิ่มยานพาหนะเรียบร้อยแล้ว");
    await loadCarriers();
  } catch (err) {
    toast("เพิ่มยานพาหนะไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
    btn.disabled = false;
  }
});

async function loadShipLotsAvailable() {
  try {
    shipLotsAvailableCache = await AgroLinkCoopAPI.get("/coop/logistics/lots-available");
  } catch (err) {
    shipLotsAvailableCache = [];
  }
}

async function loadShipFinishedGoods() {
  try {
    const rows = await AgroLinkCoopAPI.get("/coop/processing/finished-goods");
    shipFinishedGoodsCache = rows.filter((fg) => Number(fg.quantity_on_hand_ton) > 0);
  } catch (err) {
    shipFinishedGoodsCache = [];
  }
}

function exceptionRow(exc) {
  const badge = exc.resolved
    ? `<span class="badge status-completed">แก้ไขแล้ว</span>`
    : `<span class="badge status-pending">ยังไม่ได้แก้ไข</span>`;
  return `
    <div class="detail-line">
      ⚠️ ${escapeHtml(EXCEPTION_TYPE_LABEL_TH[exc.exception_type] || exc.exception_type)}: ${escapeHtml(exc.description)} ${badge}
      <span class="muted"> — โดย ${escapeHtml(exc.reported_by)} เมื่อ ${thaiDate(exc.reported_at)}</span>
      ${exc.resolved ? ` — <span class="muted">แก้ไข: ${escapeHtml(exc.resolution_note || "-")}</span>` : ""}
    </div>
    ${!exc.resolved ? `
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-resolve-note-for="${exc.exception_id}" placeholder="บันทึกการแก้ไข" />
        <button type="button" class="btn btn-ghost btn-sm" data-resolve-exception="${exc.exception_id}">บันทึกว่าแก้ไขแล้ว</button>
      </div>
    ` : ""}
  `;
}

/** d is { shipment, items, proof_of_delivery, exceptions } from GET /coop/logistics/shipments/:id. */
function shipmentCard(d) {
  const s = d.shipment;
  const badge = `<span class="badge ${SHIPMENT_STATUS_BADGE_CLASS[s.status] || "status-pending"}">${escapeHtml(SHIPMENT_STATUS_LABEL_TH[s.status] || s.status)}</span>`;

  const itemsHtml = d.items.length === 0
    ? `<div class="detail-line muted">ยังไม่มีสินค้าในรถ</div>`
    : d.items.map((i) => i.item_type === "Lot"
        ? `<div class="detail-line">📦 ล็อต: ${escapeHtml(i.lot_note || "-")} (${escapeHtml(i.lot_commodity_code)}) — ${Number(i.quantity_ton).toLocaleString("th-TH")} ตัน</div>`
        : `<div class="detail-line">🏭 ${escapeHtml(i.finished_good_product_name || "-")} — ${Number(i.quantity_ton).toLocaleString("th-TH")} ตัน</div>`
      ).join("");

  const podHtml = d.proof_of_delivery
    ? `<div class="detail-line">✅ หลักฐานการส่งมอบ: รับโดย ${escapeHtml(d.proof_of_delivery.received_by)} — ได้รับจริง ${Number(d.proof_of_delivery.received_quantity_ton).toLocaleString("th-TH")} ตัน${d.proof_of_delivery.note ? " (" + escapeHtml(d.proof_of_delivery.note) + ")" : ""}</div>`
    : "";

  const exceptionsHtml = d.exceptions.length === 0 ? "" : d.exceptions.map(exceptionRow).join("");

  const lotOptions = shipLotsAvailableCache
    .map((l) => `<option value="${l.lot_id}">${escapeHtml(l.lot_note || l.lot_id.slice(0, 8))} — ${escapeHtml(l.commodity_code)} (เหลือ ${Number(l.available_quantity_ton).toLocaleString("th-TH")} ตัน)</option>`).join("");
  const fgOptions = shipFinishedGoodsCache
    .map((fg) => `<option value="${fg.finished_good_id}">${escapeHtml(fg.product_name)} (เหลือ ${Number(fg.quantity_on_hand_ton).toLocaleString("th-TH")} ตัน)</option>`).join("");

  let actions = "";
  if (s.status === "Pending") {
    actions = `
      <div class="action-row">
        <select class="reject-reason-input" data-add-lot-select-for="${s.shipment_id}">
          <option value="">-- เพิ่มล็อตดิบ --</option>
          ${lotOptions}
        </select>
        <input type="number" min="0.001" step="0.001" class="reject-reason-input" data-add-lot-qty-for="${s.shipment_id}" placeholder="ปริมาณ (ตัน)" />
        <button type="button" class="btn btn-ghost btn-sm" data-add-lot-item="${s.shipment_id}">เพิ่มล็อต</button>
      </div>
      <div class="action-row">
        <select class="reject-reason-input" data-add-fg-select-for="${s.shipment_id}">
          <option value="">-- เพิ่มสินค้าสำเร็จรูป --</option>
          ${fgOptions}
        </select>
        <input type="number" min="0.001" step="0.001" class="reject-reason-input" data-add-fg-qty-for="${s.shipment_id}" placeholder="ปริมาณ (ตัน)" />
        <button type="button" class="btn btn-ghost btn-sm" data-add-fg-item="${s.shipment_id}">เพิ่มสินค้าสำเร็จรูป</button>
      </div>
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-dispatch-by-for="${s.shipment_id}" placeholder="ชื่อผู้ให้ออกเดินทาง" />
        <button type="button" class="btn btn-approve btn-sm" data-dispatch-shipment="${s.shipment_id}">ออกเดินทาง</button>
      </div>
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-cancel-ship-by-for="${s.shipment_id}" placeholder="ชื่อผู้ยกเลิก" />
        <input type="text" class="reject-reason-input" data-cancel-ship-reason-for="${s.shipment_id}" placeholder="เหตุผลที่ยกเลิก" />
        <button type="button" class="btn btn-decline btn-sm" data-cancel-shipment="${s.shipment_id}">ยกเลิกการจัดส่ง</button>
      </div>
    `;
  } else if (s.status === "InTransit" || s.status === "Delivered") {
    if (s.status === "InTransit") {
      actions += `
        <div class="action-row">
          <input type="text" class="reject-reason-input" data-pod-received-by-for="${s.shipment_id}" placeholder="ชื่อผู้รับสินค้า" />
          <input type="number" min="0" step="0.001" class="reject-reason-input" data-pod-qty-for="${s.shipment_id}" placeholder="ปริมาณที่ได้รับจริง (ตัน)" />
          <input type="text" class="reject-reason-input" data-pod-recorded-by-for="${s.shipment_id}" placeholder="ชื่อผู้บันทึก" />
          <button type="button" class="btn btn-approve btn-sm" data-record-pod="${s.shipment_id}">บันทึกหลักฐานการส่งมอบ</button>
        </div>
      `;
    }
    actions += `
      <div class="action-row">
        <select class="reject-reason-input" data-exc-type-for="${s.shipment_id}">
          <option value="Damage">สินค้าเสียหาย</option>
          <option value="Shortage">ขาดหาย</option>
          <option value="Delay">ล่าช้า</option>
          <option value="Rejected">ถูกปฏิเสธรับสินค้า</option>
          <option value="Other">อื่นๆ</option>
        </select>
        <input type="text" class="reject-reason-input" data-exc-desc-for="${s.shipment_id}" placeholder="รายละเอียด" />
        <input type="text" class="reject-reason-input" data-exc-by-for="${s.shipment_id}" placeholder="ชื่อผู้รายงาน" />
        <button type="button" class="btn btn-ghost btn-sm" data-report-exception="${s.shipment_id}">รายงานข้อยกเว้น</button>
      </div>
    `;
  } else if (s.status === "Cancelled") {
    actions = `<div class="detail-line muted">เหตุผลที่ยกเลิก: ${escapeHtml(s.cancel_reason || "-")} · โดย ${escapeHtml(s.cancelled_by || "-")}</div>`;
  }

  return `
    <div class="item-card" data-shipment-id="${s.shipment_id}">
      <div class="row"><span class="title">${escapeHtml(s.destination_name)}</span>${badge}</div>
      <div class="detail-line muted">ผู้ขนส่ง: ${escapeHtml(s.carrier_name || "-")}${s.license_plate ? " · ทะเบียน " + escapeHtml(s.license_plate) : ""}${s.driver_name ? " · คนขับ " + escapeHtml(s.driver_name) : ""}</div>
      <div class="detail-line">สินค้ารวม ${s.item_count} รายการ — ${Number(s.total_quantity_ton).toLocaleString("th-TH")} ตัน</div>
      ${itemsHtml}
      ${podHtml}
      ${exceptionsHtml}
      <div class="detail-line muted">วางแผนโดย ${escapeHtml(s.created_by)} เมื่อ ${thaiDate(s.created_at)}${s.dispatched_at ? " · ออกเดินทางเมื่อ " + thaiDate(s.dispatched_at) : ""}${s.delivered_at ? " · ส่งมอบเมื่อ " + thaiDate(s.delivered_at) : ""}</div>
      ${actions}
    </div>
  `;
}

async function loadShipments() {
  const el = document.getElementById("shipmentsSection");
  try {
    const shipments = await AgroLinkCoopAPI.get("/coop/logistics/shipments");
    if (shipments.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีการจัดส่ง — ใช้ฟอร์มด้านบนเพื่อวางแผนรายการแรก</div>`;
      return;
    }
    const details = await Promise.all(shipments.map((s) => AgroLinkCoopAPI.get(`/coop/logistics/shipments/${s.shipment_id}`)));
    el.innerHTML = details.map(shipmentCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการจัดส่งไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function refreshLogistics() {
  await loadShipLotsAvailable();
  await loadShipFinishedGoods();
  await loadLinkableOrgs();
  await loadCarriers();
  await loadShipments();
  // A shipment mutation can change a lot's/finished-good's availability for
  // PROCESSING too (adding a raw Lot item competes with
  // processing.v_lot_processing_availability; adding a FinishedGood item
  // calls processing.record_dispatch() directly) — refresh M11's own
  // sections so they never show stale numbers after a logistics action.
  await refreshProcessing();
}

document.getElementById("shipmentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const carrierId = document.getElementById("shipmentCarrierSelect").value;
  const vehicleId = document.getElementById("shipmentVehicleSelect").value;
  const destinationName = document.getElementById("shipmentDestinationInput").value.trim();
  const driverName = document.getElementById("shipmentDriverInput").value.trim();
  const createdBy = document.getElementById("shipmentCreatedByInput").value.trim();

  if (!carrierId || !destinationName || !createdBy) {
    toast("กรุณาเลือกผู้ขนส่ง กรอกปลายทาง และชื่อผู้วางแผนจัดส่ง", true);
    return;
  }

  const btn = document.getElementById("shipmentSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkCoopAPI.post("/coop/logistics/shipments", {
      carrier_id: carrierId, vehicle_id: vehicleId || undefined, destination_name: destinationName,
      driver_name: driverName || undefined, created_by: createdBy,
    });
    toast("วางแผนการจัดส่งใหม่เรียบร้อยแล้ว");
    document.getElementById("shipmentForm").reset();
    await loadShipments();
  } catch (err) {
    toast("วางแผนการจัดส่งไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("shipmentsSection").addEventListener("click", async (e) => {
  const addLotBtn = e.target.closest("[data-add-lot-item]");
  const addFgBtn = e.target.closest("[data-add-fg-item]");
  const dispatchBtn = e.target.closest("[data-dispatch-shipment]");
  const cancelBtn = e.target.closest("[data-cancel-shipment]");
  const podBtn = e.target.closest("[data-record-pod]");
  const excBtn = e.target.closest("[data-report-exception]");
  const resolveBtn = e.target.closest("[data-resolve-exception]");

  if (addLotBtn) {
    const shipmentId = addLotBtn.dataset.addLotItem;
    const lotId = document.querySelector(`[data-add-lot-select-for="${shipmentId}"]`).value;
    const qty = document.querySelector(`[data-add-lot-qty-for="${shipmentId}"]`).value;
    if (!lotId || !qty) {
      toast("กรุณาเลือกล็อตและกรอกปริมาณ", true);
      return;
    }
    addLotBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/coop/logistics/shipments/${shipmentId}/items`, {
        item_type: "Lot", lot_id: lotId, quantity_ton: Number(qty), recorded_by: "เจ้าหน้าที่คลัง",
      });
      toast("เพิ่มล็อตเข้ารถขนส่งเรียบร้อยแล้ว");
      await refreshLogistics();
    } catch (err) {
      toast("เพิ่มล็อตไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      addLotBtn.disabled = false;
    }
    return;
  }

  if (addFgBtn) {
    const shipmentId = addFgBtn.dataset.addFgItem;
    const fgId = document.querySelector(`[data-add-fg-select-for="${shipmentId}"]`).value;
    const qty = document.querySelector(`[data-add-fg-qty-for="${shipmentId}"]`).value;
    if (!fgId || !qty) {
      toast("กรุณาเลือกสินค้าสำเร็จรูปและกรอกปริมาณ", true);
      return;
    }
    addFgBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/coop/logistics/shipments/${shipmentId}/items`, {
        item_type: "FinishedGood", finished_good_id: fgId, quantity_ton: Number(qty), recorded_by: "เจ้าหน้าที่คลัง",
      });
      toast("เพิ่มสินค้าสำเร็จรูปเข้ารถขนส่งเรียบร้อยแล้ว");
      await refreshLogistics();
    } catch (err) {
      toast("เพิ่มสินค้าไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      addFgBtn.disabled = false;
    }
    return;
  }

  if (dispatchBtn) {
    const shipmentId = dispatchBtn.dataset.dispatchShipment;
    const dispatchedBy = document.querySelector(`[data-dispatch-by-for="${shipmentId}"]`).value.trim();
    if (!dispatchedBy) {
      toast("กรุณากรอกชื่อผู้ให้ออกเดินทาง", true);
      return;
    }
    dispatchBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/coop/logistics/shipments/${shipmentId}/dispatch`, { dispatched_by: dispatchedBy });
      toast("บันทึกออกเดินทางเรียบร้อยแล้ว");
      await refreshLogistics();
    } catch (err) {
      toast("บันทึกออกเดินทางไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      dispatchBtn.disabled = false;
    }
    return;
  }

  if (cancelBtn) {
    const shipmentId = cancelBtn.dataset.cancelShipment;
    const cancelledBy = document.querySelector(`[data-cancel-ship-by-for="${shipmentId}"]`).value.trim();
    const reason = document.querySelector(`[data-cancel-ship-reason-for="${shipmentId}"]`).value.trim();
    if (!cancelledBy || !reason) {
      toast("กรุณากรอกชื่อผู้ยกเลิกและเหตุผล", true);
      return;
    }
    cancelBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/coop/logistics/shipments/${shipmentId}/cancel`, { cancelled_by: cancelledBy, reason });
      toast("ยกเลิกการจัดส่งเรียบร้อยแล้ว");
      await refreshLogistics();
    } catch (err) {
      toast("ยกเลิกไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      cancelBtn.disabled = false;
    }
    return;
  }

  if (podBtn) {
    const shipmentId = podBtn.dataset.recordPod;
    const receivedBy = document.querySelector(`[data-pod-received-by-for="${shipmentId}"]`).value.trim();
    const qty = document.querySelector(`[data-pod-qty-for="${shipmentId}"]`).value;
    const recordedBy = document.querySelector(`[data-pod-recorded-by-for="${shipmentId}"]`).value.trim();
    if (!receivedBy || qty === "" || !recordedBy) {
      toast("กรุณากรอกชื่อผู้รับสินค้า ปริมาณที่ได้รับจริง และชื่อผู้บันทึก", true);
      return;
    }
    podBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/coop/logistics/shipments/${shipmentId}/pod`, {
        received_by: receivedBy, received_quantity_ton: Number(qty), recorded_by: recordedBy,
      });
      toast("บันทึกหลักฐานการส่งมอบเรียบร้อยแล้ว");
      await refreshLogistics();
    } catch (err) {
      toast("บันทึกหลักฐานการส่งมอบไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      podBtn.disabled = false;
    }
    return;
  }

  if (excBtn) {
    const shipmentId = excBtn.dataset.reportException;
    const excType = document.querySelector(`[data-exc-type-for="${shipmentId}"]`).value;
    const desc = document.querySelector(`[data-exc-desc-for="${shipmentId}"]`).value.trim();
    const reportedBy = document.querySelector(`[data-exc-by-for="${shipmentId}"]`).value.trim();
    if (!desc || !reportedBy) {
      toast("กรุณากรอกรายละเอียดและชื่อผู้รายงาน", true);
      return;
    }
    excBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/coop/logistics/shipments/${shipmentId}/exceptions`, {
        exception_type: excType, description: desc, reported_by: reportedBy,
      });
      toast("รายงานข้อยกเว้นเรียบร้อยแล้ว");
      await refreshLogistics();
    } catch (err) {
      toast("รายงานข้อยกเว้นไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      excBtn.disabled = false;
    }
    return;
  }

  if (resolveBtn) {
    const exceptionId = resolveBtn.dataset.resolveException;
    const note = document.querySelector(`[data-resolve-note-for="${exceptionId}"]`).value.trim();
    if (!note) {
      toast("กรุณากรอกบันทึกการแก้ไข", true);
      return;
    }
    resolveBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/coop/logistics/exceptions/${exceptionId}/resolve`, { resolution_note: note });
      toast("บันทึกการแก้ไขเรียบร้อยแล้ว");
      await refreshLogistics();
    } catch (err) {
      toast("บันทึกการแก้ไขไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      resolveBtn.disabled = false;
    }
  }
});

// NOTE: unlike buyer.js, this M09 slice does NOT expose GET /coop/contracts
// — a cooperative's collection flow is spot-sale-first (see the scope note
// in the dashboard's own HTML). contractSelect therefore always stays at
// its default "no contract / spot sale" option; POST /coop/deliveries
// still accepts a contract_id if one is ever wired in from elsewhere.

/**
 * ============================================================================
 * M15 Government Integration Gateway — consent -> credential -> submission
 * (queue/attempt/acknowledge/retry/dead-letter). See
 * grant_cooperative_gov_gateway.sql for the full design rationale.
 * govEndpointsCache is loaded once and reused to populate all three
 * endpoint dropdowns (consent/credential/submission forms) — it is
 * platform-wide reference data, not something this cooperative can add to.
 * ============================================================================
 */

async function loadGovEndpoints() {
  try {
    govEndpointsCache = await AgroLinkCoopAPI.get("/coop/gov/endpoints");
  } catch (err) {
    govEndpointsCache = [];
  }
  const optionsHtml = govEndpointsCache
    .map((e) => `<option value="${e.endpoint_id}">${escapeHtml(e.endpoint_name)} (${escapeHtml(e.agency_name)})</option>`).join("");
  document.getElementById("govConsentEndpointSelect").innerHTML = `<option value="">-- ทุกช่องทาง (Blanket) --</option>` + optionsHtml;
  document.getElementById("govCredentialEndpointSelect").innerHTML = `<option value="">-- เลือกช่องทาง --</option>` + optionsHtml;
  document.getElementById("govSubmissionEndpointSelect").innerHTML = `<option value="">-- เลือกช่องทาง --</option>` + optionsHtml;
}

function govConsentCard(c) {
  const badge = `<span class="badge ${GOV_CONSENT_STATUS_BADGE_CLASS[c.status] || "status-pending"}">${escapeHtml(GOV_CONSENT_STATUS_LABEL_TH[c.status] || c.status)}</span>`;
  return `
    <div class="item-card" data-consent-id="${c.consent_id}">
      <div class="row"><span class="title">${escapeHtml(c.endpoint_name)}</span>${badge}</div>
      ${c.agency_name ? `<div class="detail-line muted">หน่วยงาน: ${escapeHtml(c.agency_name)}</div>` : ""}
      ${c.scope_note ? `<div class="detail-line">${escapeHtml(c.scope_note)}</div>` : ""}
      <div class="detail-line muted">อนุมัติโดย ${escapeHtml(c.granted_by)} เมื่อ ${thaiDate(c.granted_at)}</div>
      ${c.status === "Revoked"
        ? `<div class="detail-line muted">เพิกถอนโดย ${escapeHtml(c.revoked_by || "-")} เมื่อ ${thaiDate(c.revoked_at)} — เหตุผล: ${escapeHtml(c.revoke_reason || "-")}</div>`
        : `<div class="action-row">
            <input type="text" class="reject-reason-input" data-revoke-consent-by-for="${c.consent_id}" placeholder="ชื่อผู้เพิกถอน" />
            <input type="text" class="reject-reason-input" data-revoke-consent-reason-for="${c.consent_id}" placeholder="เหตุผล" />
            <button type="button" class="btn btn-decline btn-sm" data-revoke-consent="${c.consent_id}">เพิกถอนความยินยอม</button>
          </div>`}
    </div>
  `;
}

async function loadGovConsents() {
  const el = document.getElementById("govConsentsSection");
  try {
    const consents = await AgroLinkCoopAPI.get("/coop/gov/consents");
    el.innerHTML = consents.length === 0
      ? `<div class="empty-state">ยังไม่มีความยินยอม — ใช้ฟอร์มด้านบนเพื่อบันทึกรายการแรก</div>`
      : consents.map(govConsentCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดความยินยอมไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("govConsentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const endpointId = document.getElementById("govConsentEndpointSelect").value;
  const scopeNote = document.getElementById("govConsentScopeInput").value.trim();
  const grantedBy = document.getElementById("govConsentGrantedByInput").value.trim();
  if (!grantedBy) {
    toast("กรุณากรอกชื่อผู้อนุมัติ", true);
    return;
  }
  const btn = document.getElementById("govConsentSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkCoopAPI.post("/coop/gov/consents", {
      endpoint_id: endpointId || undefined, scope_note: scopeNote || undefined, granted_by: grantedBy,
    });
    toast("บันทึกความยินยอมเรียบร้อยแล้ว");
    document.getElementById("govConsentForm").reset();
    await loadGovConsents();
  } catch (err) {
    toast("บันทึกความยินยอมไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("govConsentsSection").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-revoke-consent]");
  if (!btn) return;
  const consentId = btn.dataset.revokeConsent;
  const revokedBy = document.querySelector(`[data-revoke-consent-by-for="${consentId}"]`).value.trim();
  const reason = document.querySelector(`[data-revoke-consent-reason-for="${consentId}"]`).value.trim();
  if (!revokedBy || !reason) {
    toast("กรุณากรอกชื่อผู้เพิกถอนและเหตุผล", true);
    return;
  }
  btn.disabled = true;
  try {
    await AgroLinkCoopAPI.post(`/coop/gov/consents/${consentId}/revoke`, { revoked_by: revokedBy, reason });
    toast("เพิกถอนความยินยอมเรียบร้อยแล้ว");
    await loadGovConsents();
  } catch (err) {
    toast("เพิกถอนไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
    btn.disabled = false;
  }
});

function govCredentialCard(cr) {
  const badge = `<span class="badge ${GOV_CREDENTIAL_STATUS_BADGE_CLASS[cr.status] || "status-pending"}">${escapeHtml(GOV_CREDENTIAL_STATUS_LABEL_TH[cr.status] || cr.status)}</span>`;
  const expiringBadge = cr.is_expiring_soon ? `<span class="badge status-pending">ใกล้หมดอายุ (30 วัน)</span>` : "";

  let actions = "";
  if (cr.status === "Requested") {
    actions = `
      <div class="action-row">
        <input type="datetime-local" class="reject-reason-input" data-activate-cred-expires-for="${cr.credential_id}" />
        <input type="text" class="reject-reason-input" data-activate-cred-by-for="${cr.credential_id}" placeholder="ชื่อผู้เปิดใช้งาน" />
        <button type="button" class="btn btn-approve btn-sm" data-activate-credential="${cr.credential_id}">เปิดใช้งาน</button>
      </div>
    `;
  } else if (cr.status === "Active" || cr.status === "Expiring") {
    actions = `
      <div class="action-row">
        <input type="datetime-local" class="reject-reason-input" data-rotate-cred-expires-for="${cr.credential_id}" />
        <input type="text" class="reject-reason-input" data-rotate-cred-by-for="${cr.credential_id}" placeholder="ชื่อผู้หมุนเวียน" />
        <button type="button" class="btn btn-ghost btn-sm" data-rotate-credential="${cr.credential_id}">หมุนเวียน (Rotate)</button>
      </div>
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-revoke-cred-by-for="${cr.credential_id}" placeholder="ชื่อผู้เพิกถอน" />
        <input type="text" class="reject-reason-input" data-revoke-cred-reason-for="${cr.credential_id}" placeholder="เหตุผล" />
        <button type="button" class="btn btn-decline btn-sm" data-revoke-credential="${cr.credential_id}">เพิกถอน</button>
      </div>
    `;
  }

  return `
    <div class="item-card" data-credential-id="${cr.credential_id}">
      <div class="row"><span class="title">${escapeHtml(cr.credential_label)}</span>${badge}${expiringBadge}</div>
      <div class="detail-line muted">ช่องทาง: ${escapeHtml(cr.endpoint_name)} (${escapeHtml(cr.agency_name)})</div>
      <div class="detail-line muted">ขอโดย ${escapeHtml(cr.requested_by)} เมื่อ ${thaiDate(cr.requested_at)}${cr.activated_at ? " · เปิดใช้งานเมื่อ " + thaiDate(cr.activated_at) : ""}${cr.expires_at ? " · หมดอายุ " + thaiDate(cr.expires_at) : ""}</div>
      ${cr.status === "Revoked" ? `<div class="detail-line muted">เพิกถอนโดย ${escapeHtml(cr.revoked_by || "-")} — เหตุผล: ${escapeHtml(cr.revoke_reason || "-")}</div>` : ""}
      ${actions}
    </div>
  `;
}

async function loadGovCredentials() {
  const el = document.getElementById("govCredentialsSection");
  try {
    const creds = await AgroLinkCoopAPI.get("/coop/gov/credentials");
    el.innerHTML = creds.length === 0
      ? `<div class="empty-state">ยังไม่มีบัญชี API — ใช้ฟอร์มด้านบนเพื่อขอรายการแรก (ต้องมีความยินยอมที่ใช้งานอยู่ก่อน)</div>`
      : creds.map(govCredentialCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดบัญชี API ไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("govCredentialForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const endpointId = document.getElementById("govCredentialEndpointSelect").value;
  const label = document.getElementById("govCredentialLabelInput").value.trim();
  const requestedBy = document.getElementById("govCredentialRequestedByInput").value.trim();
  if (!endpointId || !label || !requestedBy) {
    toast("กรุณาเลือกช่องทาง กรอกชื่อบัญชี และชื่อผู้ขอ", true);
    return;
  }
  const btn = document.getElementById("govCredentialSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkCoopAPI.post("/coop/gov/credentials", {
      endpoint_id: endpointId, credential_label: label, requested_by: requestedBy,
    });
    toast("ส่งคำขอบัญชี API เรียบร้อยแล้ว");
    document.getElementById("govCredentialForm").reset();
    await loadGovCredentials();
  } catch (err) {
    toast("ส่งคำขอไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("govCredentialsSection").addEventListener("click", async (e) => {
  const activateBtn = e.target.closest("[data-activate-credential]");
  const rotateBtn = e.target.closest("[data-rotate-credential]");
  const revokeBtn = e.target.closest("[data-revoke-credential]");

  if (activateBtn) {
    const credId = activateBtn.dataset.activateCredential;
    const expiresAt = document.querySelector(`[data-activate-cred-expires-for="${credId}"]`).value;
    const activatedBy = document.querySelector(`[data-activate-cred-by-for="${credId}"]`).value.trim();
    if (!expiresAt || !activatedBy) {
      toast("กรุณาระบุวันหมดอายุและชื่อผู้เปิดใช้งาน", true);
      return;
    }
    activateBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/coop/gov/credentials/${credId}/activate`, {
        activated_by: activatedBy, expires_at: new Date(expiresAt).toISOString(),
      });
      toast("เปิดใช้งานบัญชี API เรียบร้อยแล้ว");
      await loadGovCredentials();
    } catch (err) {
      toast("เปิดใช้งานไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      activateBtn.disabled = false;
    }
    return;
  }

  if (rotateBtn) {
    const credId = rotateBtn.dataset.rotateCredential;
    const newExpiresAt = document.querySelector(`[data-rotate-cred-expires-for="${credId}"]`).value;
    const rotatedBy = document.querySelector(`[data-rotate-cred-by-for="${credId}"]`).value.trim();
    if (!newExpiresAt || !rotatedBy) {
      toast("กรุณาระบุวันหมดอายุใหม่และชื่อผู้หมุนเวียน", true);
      return;
    }
    rotateBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/coop/gov/credentials/${credId}/rotate`, {
        rotated_by: rotatedBy, new_expires_at: new Date(newExpiresAt).toISOString(),
      });
      toast("หมุนเวียนบัญชี API เรียบร้อยแล้ว");
      await loadGovCredentials();
    } catch (err) {
      toast("หมุนเวียนไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      rotateBtn.disabled = false;
    }
    return;
  }

  if (revokeBtn) {
    const credId = revokeBtn.dataset.revokeCredential;
    const revokedBy = document.querySelector(`[data-revoke-cred-by-for="${credId}"]`).value.trim();
    const reason = document.querySelector(`[data-revoke-cred-reason-for="${credId}"]`).value.trim();
    if (!revokedBy || !reason) {
      toast("กรุณากรอกชื่อผู้เพิกถอนและเหตุผล", true);
      return;
    }
    revokeBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/coop/gov/credentials/${credId}/revoke`, { revoked_by: revokedBy, reason });
      toast("เพิกถอนบัญชี API เรียบร้อยแล้ว");
      await loadGovCredentials();
    } catch (err) {
      toast("เพิกถอนไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      revokeBtn.disabled = false;
    }
  }
});

function govSubmissionCard(s) {
  const badge = `<span class="badge ${GOV_SUBMISSION_STATUS_BADGE_CLASS[s.status] || "status-pending"}">${escapeHtml(GOV_SUBMISSION_STATUS_LABEL_TH[s.status] || s.status)}</span>`;
  const summary = s.payload && s.payload.summary ? s.payload.summary : "-";

  let actions = "";
  if (s.status === "Queued") {
    actions = `
      <div class="action-row">
        <select class="reject-reason-input" data-attempt-outcome-for="${s.submission_id}">
          <option value="Success">จำลองว่าส่งสำเร็จ</option>
          <option value="Failure">จำลองว่าส่งไม่สำเร็จ</option>
        </select>
        <input type="text" class="reject-reason-input" data-attempt-error-for="${s.submission_id}" placeholder="ข้อความ error (ถ้ามี)" />
        <input type="text" class="reject-reason-input" data-attempt-by-for="${s.submission_id}" placeholder="ชื่อผู้บันทึก" />
        <button type="button" class="btn btn-approve btn-sm" data-attempt-submission="${s.submission_id}">ลองส่ง</button>
      </div>
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-cancel-sub-by-for="${s.submission_id}" placeholder="ชื่อผู้ยกเลิก" />
        <input type="text" class="reject-reason-input" data-cancel-sub-reason-for="${s.submission_id}" placeholder="เหตุผล" />
        <button type="button" class="btn btn-decline btn-sm" data-cancel-submission="${s.submission_id}">ยกเลิก</button>
      </div>
    `;
  } else if (s.status === "Sent") {
    actions = `
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-ack-ref-for="${s.submission_id}" placeholder="เลขอ้างอิงการตอบรับจากหน่วยงาน" />
        <input type="text" class="reject-reason-input" data-ack-by-for="${s.submission_id}" placeholder="ชื่อผู้บันทึก" />
        <button type="button" class="btn btn-approve btn-sm" data-acknowledge-submission="${s.submission_id}">บันทึกการตอบรับ</button>
      </div>
    `;
  }

  return `
    <div class="item-card" data-submission-id="${s.submission_id}">
      <div class="row"><span class="title">${escapeHtml(s.endpoint_name)} — งวด ${escapeHtml(s.period_label)}</span>${badge}</div>
      <div class="detail-line muted">หน่วยงาน: ${escapeHtml(s.agency_name)}</div>
      <div class="detail-line">${escapeHtml(summary)}</div>
      <div class="detail-line muted">ลองส่งแล้ว ${s.attempt_count}/${s.max_attempts} ครั้ง${s.last_attempt_outcome ? " · ผลล่าสุด: " + escapeHtml(s.last_attempt_outcome) : ""}</div>
      ${s.ack_reference ? `<div class="detail-line">✅ เลขอ้างอิงการตอบรับ: ${escapeHtml(s.ack_reference)}</div>` : ""}
      ${s.last_error ? `<div class="detail-line muted">ข้อผิดพลาดล่าสุด: ${escapeHtml(s.last_error)}</div>` : ""}
      <div class="detail-line muted">จัดทำโดย ${escapeHtml(s.created_by)} เมื่อ ${thaiDate(s.created_at)}</div>
      ${actions}
    </div>
  `;
}

async function loadGovSubmissions() {
  const el = document.getElementById("govSubmissionsSection");
  try {
    const rows = await AgroLinkCoopAPI.get("/coop/gov/submissions");
    el.innerHTML = rows.length === 0
      ? `<div class="empty-state">ยังไม่มีรายการส่งข้อมูล — ใช้ฟอร์มด้านบนเพื่อเพิ่มรายการแรก (ต้องมีความยินยอมและบัญชี API ที่ใช้งานได้ก่อน)</div>`
      : rows.map(govSubmissionCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการส่งข้อมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

function govDeadLetterCard(s) {
  return `
    <div class="item-card" data-dead-letter-id="${s.submission_id}">
      <div class="row"><span class="title">${escapeHtml(s.endpoint_name)} — งวด ${escapeHtml(s.period_label)}</span><span class="badge status-declined">Dead-letter</span></div>
      <div class="detail-line">ลองส่งครบ ${s.attempt_count}/${s.max_attempts} ครั้งแล้ว — ${escapeHtml(s.last_error || "ไม่ทราบสาเหตุ")}</div>
      <div class="action-row">
        <input type="number" min="1" step="1" class="reject-reason-input" data-requeue-attempts-for="${s.submission_id}" placeholder="เพิ่มโควตากี่ครั้ง เช่น 3" />
        <input type="text" class="reject-reason-input" data-requeue-by-for="${s.submission_id}" placeholder="ชื่อผู้นำกลับเข้าคิว" />
        <button type="button" class="btn btn-ghost btn-sm" data-requeue-submission="${s.submission_id}">นำกลับเข้าคิว</button>
      </div>
    </div>
  `;
}

async function loadGovDeadLetter() {
  const el = document.getElementById("govDeadLetterSection");
  try {
    const rows = await AgroLinkCoopAPI.get("/coop/gov/dead-letter");
    el.innerHTML = rows.length === 0
      ? `<div class="empty-state">ไม่มีรายการใน Dead-letter Queue ในขณะนี้</div>`
      : rows.map(govDeadLetterCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลด Dead-letter Queue ไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function refreshGovGateway() {
  await loadGovEndpoints();
  await Promise.all([loadGovConsents(), loadGovCredentials(), loadGovSubmissions(), loadGovDeadLetter()]);
}

document.getElementById("govSubmissionForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const endpointId = document.getElementById("govSubmissionEndpointSelect").value;
  const periodLabel = document.getElementById("govSubmissionPeriodInput").value.trim();
  const createdBy = document.getElementById("govSubmissionCreatedByInput").value.trim();
  const summary = document.getElementById("govSubmissionSummaryInput").value.trim();
  if (!endpointId || !periodLabel || !createdBy || !summary) {
    toast("กรุณากรอกข้อมูลให้ครบถ้วน", true);
    return;
  }
  const btn = document.getElementById("govSubmissionSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkCoopAPI.post("/coop/gov/submissions", {
      endpoint_id: endpointId, period_label: periodLabel, created_by: createdBy, summary,
    });
    toast("เพิ่มเข้าคิวส่งข้อมูลเรียบร้อยแล้ว");
    document.getElementById("govSubmissionForm").reset();
    await loadGovSubmissions();
  } catch (err) {
    toast("เพิ่มเข้าคิวไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("govSubmissionsSection").addEventListener("click", async (e) => {
  const attemptBtn = e.target.closest("[data-attempt-submission]");
  const ackBtn = e.target.closest("[data-acknowledge-submission]");
  const cancelBtn = e.target.closest("[data-cancel-submission]");

  if (attemptBtn) {
    const subId = attemptBtn.dataset.attemptSubmission;
    const outcome = document.querySelector(`[data-attempt-outcome-for="${subId}"]`).value;
    const errorMessage = document.querySelector(`[data-attempt-error-for="${subId}"]`).value.trim();
    const recordedBy = document.querySelector(`[data-attempt-by-for="${subId}"]`).value.trim();
    if (!recordedBy) {
      toast("กรุณากรอกชื่อผู้บันทึก", true);
      return;
    }
    attemptBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/coop/gov/submissions/${subId}/attempt`, {
        outcome, error_message: errorMessage || undefined, recorded_by: recordedBy,
      });
      toast("บันทึกผลการลองส่งเรียบร้อยแล้ว");
      await Promise.all([loadGovSubmissions(), loadGovDeadLetter()]);
    } catch (err) {
      toast("บันทึกผลไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      attemptBtn.disabled = false;
    }
    return;
  }

  if (ackBtn) {
    const subId = ackBtn.dataset.acknowledgeSubmission;
    const ackRef = document.querySelector(`[data-ack-ref-for="${subId}"]`).value.trim();
    const recordedBy = document.querySelector(`[data-ack-by-for="${subId}"]`).value.trim();
    if (!ackRef || !recordedBy) {
      toast("กรุณากรอกเลขอ้างอิงและชื่อผู้บันทึก", true);
      return;
    }
    ackBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/coop/gov/submissions/${subId}/acknowledge`, { ack_reference: ackRef, recorded_by: recordedBy });
      toast("บันทึกการตอบรับเรียบร้อยแล้ว");
      await loadGovSubmissions();
    } catch (err) {
      toast("บันทึกไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      ackBtn.disabled = false;
    }
    return;
  }

  if (cancelBtn) {
    const subId = cancelBtn.dataset.cancelSubmission;
    const cancelledBy = document.querySelector(`[data-cancel-sub-by-for="${subId}"]`).value.trim();
    const reason = document.querySelector(`[data-cancel-sub-reason-for="${subId}"]`).value.trim();
    if (!cancelledBy || !reason) {
      toast("กรุณากรอกชื่อผู้ยกเลิกและเหตุผล", true);
      return;
    }
    cancelBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/coop/gov/submissions/${subId}/cancel`, { cancelled_by: cancelledBy, reason });
      toast("ยกเลิกรายการเรียบร้อยแล้ว");
      await loadGovSubmissions();
    } catch (err) {
      toast("ยกเลิกไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      cancelBtn.disabled = false;
    }
  }
});

document.getElementById("govDeadLetterSection").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-requeue-submission]");
  if (!btn) return;
  const subId = btn.dataset.requeueSubmission;
  const attempts = document.querySelector(`[data-requeue-attempts-for="${subId}"]`).value;
  const recordedBy = document.querySelector(`[data-requeue-by-for="${subId}"]`).value.trim();
  if (!attempts || !recordedBy) {
    toast("กรุณากรอกจำนวนครั้งที่เพิ่มและชื่อผู้นำกลับเข้าคิว", true);
    return;
  }
  btn.disabled = true;
  try {
    await AgroLinkCoopAPI.post(`/coop/gov/submissions/${subId}/requeue`, {
      additional_attempts: Number(attempts), recorded_by: recordedBy,
    });
    toast("นำกลับเข้าคิวเรียบร้อยแล้ว");
    await Promise.all([loadGovSubmissions(), loadGovDeadLetter()]);
  } catch (err) {
    toast("นำกลับเข้าคิวไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
    btn.disabled = false;
  }
});

// ---------- เอกสารจดทะเบียนสหกรณ์ (M01 Object Storage) ----------
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); // data: URL — matches lib/storage.js's decodeBase64Payload
    reader.onerror = () => reject(reader.error || new Error("read_failed"));
    reader.readAsDataURL(file);
  });
}

function formatBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadRegistrationDocument() {
  const el = document.getElementById("registrationDocumentSection");
  try {
    const { file } = await AgroLinkCoopAPI.get("/coop/registration-document");
    if (!file) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีเอกสารแนบ — ใช้ฟอร์มด้านล่างเพื่ออัปโหลดไฟล์แรก</div>`;
      return;
    }
    el.innerHTML = `
      <div class="detail-line"><strong>${escapeHtml(file.original_filename)}</strong> (${formatBytes(file.byte_size)})</div>
      <div class="detail-line muted">อัปโหลดโดย ${escapeHtml(file.uploaded_by)} เมื่อ ${thaiDate(file.created_at)}</div>
      <div class="action-row">
        <button type="button" class="btn btn-ghost btn-sm" id="viewRegistrationDocumentBtn" data-file-id="${file.file_id}">เปิดดูเอกสาร</button>
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดข้อมูลเอกสารไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("registrationDocumentSection").addEventListener("click", async (e) => {
  const btn = e.target.closest("#viewRegistrationDocumentBtn");
  if (!btn) return;
  const fileId = btn.dataset.fileId;
  btn.disabled = true;
  try {
    const session = AgroLinkCoopAPI.getSession();
    const res = await fetch(`${API_BASE}/storage/${fileId}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
    if (!res.ok) throw new Error(`download_failed_${res.status}`);
    const blob = await res.blob();
    window.open(URL.createObjectURL(blob), "_blank");
  } catch (err) {
    toast("เปิดเอกสารไม่สำเร็จ: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("registrationDocumentUploadBtn").addEventListener("click", async () => {
  const input = document.getElementById("registrationDocumentInput");
  const file = input.files[0];
  if (!file) {
    toast("กรุณาเลือกไฟล์ก่อน", true);
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    toast("ไฟล์มีขนาดใหญ่เกิน 5MB", true);
    return;
  }
  const btn = document.getElementById("registrationDocumentUploadBtn");
  btn.disabled = true;
  try {
    const dataUrl = await fileToBase64(file);
    const uploadResult = await AgroLinkCoopAPI.post("/storage/upload", {
      purpose: "cooperative_registration_document",
      filename: file.name,
      content_type: file.type,
      file_base64: dataUrl,
      uploaded_by: document.getElementById("orgName").textContent || "เจ้าหน้าที่สหกรณ์",
    });
    await AgroLinkCoopAPI.post("/coop/registration-document/link", { file_id: uploadResult.file_id });
    toast("อัปโหลดเอกสารเรียบร้อยแล้ว");
    input.value = "";
    await loadRegistrationDocument();
  } catch (err) {
    const reason = (err.body && err.body.error) || err.message;
    toast("อัปโหลดไม่สำเร็จ: " + reason, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- จัดการเจ้าหน้าที่สหกรณ์ (Staff Login, M01) ----------
const STAFF_STATUS_LABEL_TH = { Active: "ใช้งานอยู่", Inactive: "ปิดใช้งานแล้ว" };

async function loadStaffRoles() {
  const sel = document.getElementById("staffRoleSelect");
  try {
    const roles = await AgroLinkCoopAPI.get("/coop/staff/roles");
    sel.innerHTML = `<option value="">-- เลือกบทบาท --</option>` +
      roles.map((r) => `<option value="${escapeHtml(r.role_code)}">${escapeHtml(r.description || r.role_code)}</option>`).join("");
  } catch (err) {
    sel.innerHTML = `<option value="">โหลดบทบาทไม่สำเร็จ</option>`;
  }
}

function staffCard(m) {
  const badge = `<span class="badge ${m.status === "Active" ? "status-active" : "status-declined"}">${escapeHtml(STAFF_STATUS_LABEL_TH[m.status] || m.status)}</span>`;
  const actions = m.status === "Active"
    ? `<div class="action-row"><button type="button" class="btn btn-decline btn-sm" data-deactivate-staff="${m.member_id}">ปิดใช้งานบัญชี</button></div>`
    : "";
  return `
    <div class="item-card" data-staff-id="${m.member_id}">
      <div class="row"><span class="title">${escapeHtml(m.full_name)}</span>${badge}</div>
      <div class="detail-line muted">บทบาท: ${escapeHtml(m.role_description || m.role_code || "-")}</div>
      ${m.auth_subject_id ? `<div class="detail-line muted">Auth Subject (สำหรับเข้าสู่ระบบ): ${escapeHtml(m.auth_subject_id)}</div>` : ""}
      <div class="detail-line muted">สร้างเมื่อ ${thaiDate(m.created_at)}</div>
      ${actions}
    </div>
  `;
}

async function loadStaff() {
  const el = document.getElementById("staffListSection");
  try {
    const staff = await AgroLinkCoopAPI.get("/coop/staff");
    el.innerHTML = staff.length === 0
      ? `<div class="empty-state">ยังไม่มีบัญชีเจ้าหน้าที่ — ใช้ฟอร์มด้านบนเพื่อสร้างรายการแรก</div>`
      : staff.map(staffCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายชื่อเจ้าหน้าที่ไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("staffForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fullName = document.getElementById("staffFullNameInput").value.trim();
  const nationalId = document.getElementById("staffNationalIdInput").value.trim();
  const roleCode = document.getElementById("staffRoleSelect").value;
  const createdBy = document.getElementById("staffCreatedByInput").value.trim();
  if (!fullName || !nationalId || !roleCode || !createdBy) {
    toast("กรุณากรอกข้อมูลให้ครบทุกช่อง", true);
    return;
  }
  const btn = document.getElementById("staffSubmitBtn");
  btn.disabled = true;
  try {
    const result = await AgroLinkCoopAPI.post("/coop/staff", {
      full_name: fullName, national_id: nationalId, role_code: roleCode, created_by: createdBy,
    });
    toast(`สร้างบัญชีเรียบร้อยแล้ว — รหัสเข้าสู่ระบบ: ${result.auth_subject_id} (กรุณาคัดลอกไว้แจ้งเจ้าหน้าที่)`);
    document.getElementById("staffForm").reset();
    await loadStaff();
  } catch (err) {
    toast("สร้างบัญชีไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("staffListSection").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-deactivate-staff]");
  if (!btn) return;
  const memberId = btn.dataset.deactivateStaff;
  if (!confirm("ยืนยันปิดใช้งานบัญชีเจ้าหน้าที่รายนี้?")) return;
  btn.disabled = true;
  try {
    await AgroLinkCoopAPI.post(`/coop/staff/${memberId}/deactivate`, {});
    toast("ปิดใช้งานบัญชีเรียบร้อยแล้ว");
    await loadStaff();
  } catch (err) {
    toast("ปิดใช้งานไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
    btn.disabled = false;
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkCoopAPI.logout());

/**
 * GET /coop/dashboard doubles as the KYB/role gate check here — same
 * pattern as every other portal's init().
 */
// ============================================================
// แค็ตตาล็อกผลผลิต/สินค้าแปรรูป (M14.1) — /coop/products*, reusing the
// same marketplace.product_listing/product_photo/product_order machinery
// the InputSupplier Portal uses (see frontend/inputsupplier/js/dashboard.js
// for the pattern this mirrors), scoped to Cooperative sellers and Buyer
// orgs instead of InputSupplier sellers and farmers.
// ============================================================

const COOP_PRODUCT_CATEGORY_LABEL_TH = {
  produce: "ผลผลิตทางการเกษตร",
  processed_good: "สินค้าแปรรูป",
  other: "อื่นๆ",
};

const COOP_ORDER_STATUS_LABEL_TH = {
  requested: "รอการยืนยันจากสหกรณ์",
  confirmed: "ยืนยันแล้ว (รอส่งมอบ)",
  fulfilled: "ส่งมอบแล้ว",
  rejected: "สหกรณ์ปฏิเสธ",
  cancelled: "ผู้ซื้อยกเลิกแล้ว",
};
const COOP_ORDER_STATUS_BADGE_CLASS = {
  requested: "status-pending",
  confirmed: "status-approved",
  fulfilled: "status-completed",
  rejected: "status-declined",
  cancelled: "status-declined",
};

const coopProductForm = document.getElementById("coopProductForm");
const coopEditingListingIdInput = document.getElementById("coopEditingListingId");
const coopProductSubmitBtn = document.getElementById("coopProductSubmitBtn");
const coopProductCancelEditBtn = document.getElementById("coopProductCancelEditBtn");

function resetCoopProductForm() {
  coopProductForm.reset();
  document.getElementById("coopPriceUnitInput").value = "บาท/กก.";
  coopEditingListingIdInput.value = "";
  coopProductSubmitBtn.textContent = "เพิ่มสินค้า";
  coopProductCancelEditBtn.style.display = "none";
}

function startEditingCoopProduct(p) {
  coopEditingListingIdInput.value = p.listing_id;
  document.getElementById("coopCategorySelect").value = p.category;
  document.getElementById("coopProductNameInput").value = p.product_name;
  document.getElementById("coopBrandInput").value = p.brand || "";
  document.getElementById("coopPriceInput").value = p.unit_price;
  document.getElementById("coopPriceUnitInput").value = p.price_unit;
  document.getElementById("coopDescriptionInput").value = p.description || "";
  coopProductSubmitBtn.textContent = "บันทึกการแก้ไข";
  coopProductCancelEditBtn.style.display = "inline-block";
  coopProductForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

coopProductCancelEditBtn.addEventListener("click", () => resetCoopProductForm());

coopProductForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const listingId = coopEditingListingIdInput.value;
  const payload = {
    category: document.getElementById("coopCategorySelect").value,
    product_name: document.getElementById("coopProductNameInput").value.trim(),
    brand: document.getElementById("coopBrandInput").value.trim() || null,
    description: document.getElementById("coopDescriptionInput").value.trim() || null,
    unit_price: Number(document.getElementById("coopPriceInput").value),
    price_unit: document.getElementById("coopPriceUnitInput").value.trim() || "บาท/กก.",
  };

  if (!payload.product_name) {
    toast("กรุณากรอกชื่อสินค้า", true);
    return;
  }
  if (!Number.isFinite(payload.unit_price) || payload.unit_price <= 0) {
    toast("กรุณากรอกราคาที่มากกว่า 0", true);
    return;
  }

  coopProductSubmitBtn.disabled = true;
  try {
    if (listingId) {
      await AgroLinkCoopAPI.put(`/coop/products/${listingId}`, payload);
      toast("บันทึกการแก้ไขสินค้าเรียบร้อยแล้ว");
    } else {
      await AgroLinkCoopAPI.post("/coop/products", payload);
      toast("เพิ่มสินค้าเรียบร้อยแล้ว");
    }
    resetCoopProductForm();
    await loadCoopProducts();
  } catch (err) {
    toast("บันทึกไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
  } finally {
    coopProductSubmitBtn.disabled = false;
  }
});

function coopProductPhotoThumb(photo, listingId) {
  return `
    <div class="photo-card" data-photo-id="${photo.photo_id}" style="width:80px; height:80px;">
      <img src="${photo.photo_data_url}" alt="${escapeHtml(photo.caption || "")}" />
      <button type="button" class="photo-remove" title="ลบรูปภาพ" data-listing-id="${listingId}" data-photo-id="${photo.photo_id}">✕</button>
    </div>
  `;
}

function coopProductCard(p) {
  const photosHtml = (p.photos || []).map((photo) => coopProductPhotoThumb(photo, p.listing_id)).join("");
  const featured = p.is_featured && (!p.featured_until || new Date(p.featured_until).getTime() > Date.now());
  return `
    <div class="item-card" data-listing-id="${p.listing_id}">
      <div class="row">
        <span class="title">${featured ? "⭐ " : ""}${escapeHtml(p.product_name)}${p.brand ? " · " + escapeHtml(p.brand) : ""}</span>
        <span class="badge ${p.is_active ? "status-active" : "status-declined"}">${p.is_active ? "กำลังขาย" : "ปิดการขาย"}</span>
      </div>
      <div class="detail-line">${escapeHtml(COOP_PRODUCT_CATEGORY_LABEL_TH[p.category] || p.category)}</div>
      ${p.description ? `<div class="detail-line muted">${escapeHtml(p.description)}</div>` : ""}
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">
        ${Number(p.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(p.price_unit)}
      </div>

      <div class="photo-grid" style="grid-template-columns:repeat(auto-fill, minmax(80px, 1fr)); margin:10px 0;" data-photo-grid="${p.listing_id}">
        ${photosHtml || `<div class="muted" style="font-size:12px;">ยังไม่มีรูปภาพสินค้านี้</div>`}
      </div>
      <div class="action-row">
        <input type="file" accept="image/*" data-coop-photo-file="${p.listing_id}" style="max-width:220px;" />
        <button type="button" class="btn btn-sm btn-ghost" data-coop-upload-photo="${p.listing_id}">อัปโหลดรูป</button>
      </div>

      <div class="action-row">
        <button type="button" class="btn btn-sm btn-ghost" data-coop-edit="${p.listing_id}">แก้ไข</button>
        <button type="button" class="btn btn-sm btn-decline" data-coop-delete="${p.listing_id}">ปิดการขาย</button>
      </div>
    </div>
  `;
}

let coopProductsCache = [];

async function loadCoopProductPhotos(listingId) {
  try {
    return await AgroLinkCoopAPI.get(`/coop/products/${listingId}/photos`);
  } catch (err) {
    return [];
  }
}

async function loadCoopProducts() {
  const el = document.getElementById("coopProductListSection");
  const category = document.getElementById("coopCategoryFilter").value;
  el.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const query = category ? `?category=${encodeURIComponent(category)}` : "";
    const products = await AgroLinkCoopAPI.get(`/coop/products${query}`);
    if (products.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีสินค้าในแค็ตตาล็อก — เพิ่มสินค้าแรกของสหกรณ์ได้ด้านบน</div>`;
      coopProductsCache = [];
      return;
    }
    const withPhotos = await Promise.all(
      products.map(async (p) => ({ ...p, photos: await loadCoopProductPhotos(p.listing_id) })),
    );
    coopProductsCache = withPhotos;
    el.innerHTML = withPhotos.map(coopProductCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดแค็ตตาล็อกสินค้าไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("coopCategoryFilter").addEventListener("change", () => loadCoopProducts());

document.getElementById("coopProductListSection").addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-coop-edit]");
  const deleteBtn = e.target.closest("[data-coop-delete]");
  const uploadBtn = e.target.closest("[data-coop-upload-photo]");
  const removePhotoBtn = e.target.closest(".photo-remove");

  if (editBtn) {
    const listingId = editBtn.dataset.coopEdit;
    const product = coopProductsCache.find((p) => p.listing_id === listingId);
    if (product) startEditingCoopProduct(product);
    return;
  }

  if (deleteBtn) {
    const listingId = deleteBtn.dataset.coopDelete;
    deleteBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.del(`/coop/products/${listingId}`);
      toast("ปิดการขายสินค้าเรียบร้อยแล้ว");
      if (coopEditingListingIdInput.value === listingId) resetCoopProductForm();
      await loadCoopProducts();
    } catch (err) {
      toast("ปิดการขายไม่สำเร็จ: " + err.message, true);
      deleteBtn.disabled = false;
    }
    return;
  }

  if (uploadBtn) {
    const listingId = uploadBtn.dataset.coopUploadPhoto;
    const fileInput = document.querySelector(`input[data-coop-photo-file="${listingId}"]`);
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) {
      toast("กรุณาเลือกไฟล์รูปภาพ", true);
      return;
    }
    if (!file.type.startsWith("image/")) {
      toast("กรุณาเลือกไฟล์รูปภาพเท่านั้น", true);
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast("ไฟล์รูปภาพใหญ่เกินไป (สูงสุด 2MB)", true);
      return;
    }
    uploadBtn.disabled = true;
    try {
      const dataUrl = await fileToBase64(file);
      await AgroLinkCoopAPI.post(`/coop/products/${listingId}/photos`, {
        photo_data_url: dataUrl,
        caption: null,
      });
      toast("อัปโหลดรูปภาพเรียบร้อยแล้ว");
      await loadCoopProducts();
    } catch (err) {
      toast("อัปโหลดรูปภาพไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
    } finally {
      uploadBtn.disabled = false;
    }
    return;
  }

  if (removePhotoBtn) {
    const listingId = removePhotoBtn.dataset.listingId;
    const photoId = removePhotoBtn.dataset.photoId;
    removePhotoBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.del(`/coop/products/${listingId}/photos/${photoId}`);
      toast("ลบรูปภาพเรียบร้อยแล้ว");
      await loadCoopProducts();
    } catch (err) {
      toast("ลบรูปภาพไม่สำเร็จ: " + err.message, true);
      removePhotoBtn.disabled = false;
    }
  }
});

// ---------- คำสั่งซื้อจากผู้รับซื้อ ----------
function coopOrderCard(o) {
  const badgeClass = COOP_ORDER_STATUS_BADGE_CLASS[o.status] || "status-pending";
  const badge = `<span class="badge ${badgeClass}">${escapeHtml(COOP_ORDER_STATUS_LABEL_TH[o.status] || o.status)}</span>`;

  let actions = "";
  if (o.status === "requested") {
    actions = `
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm" data-coop-confirm-order="${o.order_id}">ยืนยันคำสั่งซื้อ</button>
      </div>
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-coop-reject-reason-for="${o.order_id}" placeholder="เหตุผลการปฏิเสธ (ไม่บังคับ)" />
        <button type="button" class="btn btn-decline btn-sm" data-coop-reject-order="${o.order_id}">ปฏิเสธ</button>
      </div>
    `;
  } else if (o.status === "confirmed") {
    actions = `
      <div class="action-row">
        <button type="button" class="btn btn-approve btn-sm" data-coop-fulfill-order="${o.order_id}">บันทึกว่าส่งมอบสินค้าแล้ว</button>
      </div>
    `;
  }

  return `
    <div class="item-card" data-order-id="${o.order_id}">
      <div class="row"><span class="title">${escapeHtml(o.buyer_org_name)} — ${escapeHtml(o.product_name)}</span>${badge}</div>
      <div class="detail-line">${escapeHtml(COOP_PRODUCT_CATEGORY_LABEL_TH[o.category] || o.category)} · จำนวน ${Number(o.quantity).toLocaleString("th-TH")} x ${Number(o.unit_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(o.price_unit)}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">รวม ${Number(o.total_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท</div>
      ${o.decided_reason ? `<div class="detail-line muted">เหตุผล: ${escapeHtml(o.decided_reason)}</div>` : ""}
      <div class="detail-line muted">สั่งซื้อเมื่อ ${thaiDate(o.requested_at)}</div>
      ${actions}
    </div>
  `;
}

async function loadCoopOrderReviewQueue() {
  const el = document.getElementById("coopOrderReviewQueueSection");
  try {
    const orders = await AgroLinkCoopAPI.get("/coop/products/orders?status=action_needed");
    el.innerHTML = orders.length === 0
      ? `<div class="empty-state">ไม่มีคำสั่งซื้อที่ต้องดำเนินการในขณะนี้</div>`
      : orders.map(coopOrderCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดคำสั่งซื้อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadCoopOrderHistory() {
  const el = document.getElementById("coopOrderHistorySection");
  const status = document.getElementById("coopOrderStatusFilter").value;
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const orders = await AgroLinkCoopAPI.get(`/coop/products/orders${query}`);
    el.innerHTML = orders.length === 0
      ? `<div class="empty-state">ยังไม่มีคำสั่งซื้อ</div>`
      : orders.map(coopOrderCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประวัติคำสั่งซื้อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function refreshCoopOrders() {
  await Promise.all([loadCoopOrderReviewQueue(), loadCoopOrderHistory()]);
}

document.getElementById("coopOrderStatusFilter").addEventListener("change", () => loadCoopOrderHistory());

function handleCoopOrderActionClick(container) {
  container.addEventListener("click", async (e) => {
    const confirmBtn = e.target.closest("[data-coop-confirm-order]");
    const rejectBtn = e.target.closest("[data-coop-reject-order]");
    const fulfillBtn = e.target.closest("[data-coop-fulfill-order]");

    if (confirmBtn) {
      const orderId = confirmBtn.dataset.coopConfirmOrder;
      confirmBtn.disabled = true;
      try {
        await AgroLinkCoopAPI.post(`/coop/products/orders/${orderId}/confirm`, {});
        toast("ยืนยันคำสั่งซื้อเรียบร้อยแล้ว");
        await refreshCoopOrders();
      } catch (err) {
        toast("ยืนยันคำสั่งซื้อไม่สำเร็จ: " + err.message, true);
        confirmBtn.disabled = false;
      }
      return;
    }

    if (rejectBtn) {
      const orderId = rejectBtn.dataset.coopRejectOrder;
      const reasonInput = container.querySelector(`[data-coop-reject-reason-for="${orderId}"]`);
      rejectBtn.disabled = true;
      try {
        await AgroLinkCoopAPI.post(`/coop/products/orders/${orderId}/reject`, {
          reason: (reasonInput && reasonInput.value.trim()) || null,
        });
        toast("ปฏิเสธคำสั่งซื้อเรียบร้อยแล้ว");
        await refreshCoopOrders();
      } catch (err) {
        toast("ปฏิเสธคำสั่งซื้อไม่สำเร็จ: " + err.message, true);
        rejectBtn.disabled = false;
      }
      return;
    }

    if (fulfillBtn) {
      const orderId = fulfillBtn.dataset.coopFulfillOrder;
      fulfillBtn.disabled = true;
      try {
        await AgroLinkCoopAPI.post(`/coop/products/orders/${orderId}/fulfill`, {});
        toast("บันทึกการส่งมอบสินค้าเรียบร้อยแล้ว");
        await refreshCoopOrders();
      } catch (err) {
        toast("บันทึกการส่งมอบไม่สำเร็จ: " + err.message, true);
        fulfillBtn.disabled = false;
      }
    }
  });
}

handleCoopOrderActionClick(document.getElementById("coopOrderReviewQueueSection"));
handleCoopOrderActionClick(document.getElementById("coopOrderHistorySection"));

// ============================================================
// RFP/RFQ (Request for Proposal / Request for Quote) — cross-portal
// marketplace (see backend/src/routes/procurement.js and backend/db/
// grant_rfq_marketplace.sql). ANY subject (farmer or organization) can
// post/browse/cancel/accept an RFQ; only ORGANIZATIONS can submit/withdraw
// quotes (see procurement.js's own doc comment for the design rationale —
// farmer-to-farmer quoting was judged out of scope for this round). This
// portal is always an organization, so the quoting UI is always shown
// here; the farmer-facing standalone rfq.html hides it instead.
// ============================================================
const RFQ_CATEGORY_LABEL_TH = {
  input_product: "ปัจจัยการผลิต",
  produce: "ผลผลิตทางการเกษตร",
  processed_good: "สินค้าแปรรูป",
  machinery_service: "บริการเครื่องจักรกล",
  other: "อื่นๆ",
};
const RFQ_STATUS_LABEL_TH = {
  open: "เปิดรับใบเสนอราคา",
  awarded: "ตกลงแล้ว",
  cancelled: "ยกเลิกแล้ว",
  closed: "ปิดแล้ว",
};
const RFQ_STATUS_BADGE_CLASS = {
  open: "status-active",
  awarded: "status-approved",
  cancelled: "status-declined",
  closed: "status-pending",
};
const RFQ_QUOTE_STATUS_LABEL_TH = {
  submitted: "รอผลพิจารณา",
  accepted: "ได้รับเลือก",
  rejected: "ไม่ได้รับเลือก",
  withdrawn: "ถอนแล้ว",
};
const RFQ_QUOTE_STATUS_BADGE_CLASS = {
  submitted: "status-pending",
  accepted: "status-approved",
  rejected: "status-declined",
  withdrawn: "status-declined",
};

let rfqMineCache = [];
let rfqIsOrganization = false;

// ============================================================
// AgroLink B2B Commerce Engine — e-Auction + Contract + Purchase Order
// (see backend/db/grant_b2b_commerce_engine.sql and
// B2B_COMMERCE_ENGINE_ARCHITECTURE.md). Sits directly on top of the RFQ
// section above: an auction is opened FROM one of this org's own open
// RFQs, awarding it (by closing the auction, or by accepting a direct
// quote above) auto-creates a real contract.contract row, and a contract
// can then have a Purchase Order issued against it. auctionMineByRfqId is
// populated before rfqMineCard() renders so each RFQ card can show
// whether it already has a live auction instead of offering to open a
// duplicate one (the backend would reject that with 409
// auction_already_exists, but catching it client-side is better UX).
// ============================================================
const AUCTION_STATUS_LABEL_TH = {
  open: "เปิดประมูล",
  closed: "ปิดแล้ว (ไม่มีผู้เสนอราคา)",
  awarded: "ปิดประมูล — มีผู้ชนะ",
  cancelled: "ยกเลิกแล้ว",
};
const AUCTION_STATUS_BADGE_CLASS = {
  open: "status-active",
  closed: "status-pending",
  awarded: "status-approved",
  cancelled: "status-declined",
};
const CONTRACT_TYPE_LABEL_TH = {
  forward_purchase: "สัญญาซื้อขายล่วงหน้า",
  service_agreement: "สัญญาจ้างบริการ",
  input_supply_agreement: "สัญญาจัดหาปัจจัยการผลิต",
  loan_agreement: "สัญญาสินเชื่อ",
};
const CONTRACT_ROLE_LABEL_TH = {
  buyer: "ผู้ซื้อ",
  farmer: "เกษตรกร",
  seller: "ผู้ขาย",
  input_supplier: "ผู้จัดหาปัจจัยการผลิต",
  service_provider: "ผู้ให้บริการ",
  lender: "ผู้ให้สินเชื่อ",
  platform: "แพลตฟอร์ม",
};
const PO_STATUS_LABEL_TH = {
  issued: "ออกแล้ว รอตอบรับ",
  acknowledged: "ผู้ขายตอบรับแล้ว",
  in_fulfillment: "อยู่ระหว่างส่งมอบ",
  completed: "เสร็จสมบูรณ์",
  cancelled: "ยกเลิกแล้ว",
};
const PO_STATUS_BADGE_CLASS = {
  issued: "status-pending",
  acknowledged: "status-approved",
  in_fulfillment: "status-active",
  completed: "status-approved",
  cancelled: "status-declined",
};
const INVOICE_STATUS_LABEL_TH = {
  issued: "ออกแล้ว รอชำระ",
  paid: "ชำระแล้ว",
  disputed: "มีข้อโต้แย้ง",
  cancelled: "ยกเลิกแล้ว",
};
const INVOICE_STATUS_BADGE_CLASS = {
  issued: "status-pending",
  paid: "status-approved",
  disputed: "status-declined",
  cancelled: "status-declined",
};
const REVSHARE_PLAN_STATUS_LABEL_TH = { pending: "รอกระจายเงิน", distributed: "กระจายเงินแล้ว" };
const REVSHARE_LINE_STATUS_LABEL_TH = { pending: "รอโอน", paid: "โอนแล้ว", failed: "โอนไม่สำเร็จ" };
// Mirrors backend PO_ISSUER_ROLES (procurement.js) — only the "wants the
// goods" contract party may issue a PO; used here purely to decide
// whether to show the "ออกใบสั่งซื้อ" button, never as a security check
// (the server re-validates this on every write regardless).
const PO_ISSUER_ROLES_CLIENT = ["farmer", "buyer"];

let auctionMineCache = [];
let auctionMineByRfqId = new Map();
let contractsMineCache = [];

function rfqMoney(n) {
  return Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2 });
}

function rfqThaiDateOnly(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

function rfqMetaLine(r) {
  const parts = [];
  if (r.quantity) parts.push(`จำนวน ${rfqMoney(r.quantity)} ${escapeHtml(r.quantity_unit || "")}`);
  if (r.target_price) parts.push(`ราคาเป้าหมาย ${rfqMoney(r.target_price)} บาท`);
  if (r.delivery_location) parts.push(`ส่งที่ ${escapeHtml(r.delivery_location)}`);
  if (r.needed_by_date) parts.push(`ต้องการภายใน ${rfqThaiDateOnly(r.needed_by_date)}`);
  return parts.join(" · ");
}

function rfqQuoteRow(q, rfqId, rfqStatus) {
  const badgeClass = RFQ_QUOTE_STATUS_BADGE_CLASS[q.status] || "status-pending";
  const canAccept = q.status === "submitted" && rfqStatus === "open";
  return `
    <div class="item-card" style="margin-top:8px;" data-quote-id="${q.quote_id}">
      <div class="row">
        <span class="title">${escapeHtml(q.responder_org_name)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(RFQ_QUOTE_STATUS_LABEL_TH[q.status] || q.status)}</span>
      </div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">
        ${rfqMoney(q.quoted_price)} ${escapeHtml(q.price_unit)}${q.quoted_quantity ? ` · จำนวน ${rfqMoney(q.quoted_quantity)}` : ""}
      </div>
      ${q.message ? `<div class="detail-line muted">${escapeHtml(q.message)}</div>` : ""}
      <div class="detail-line muted">เสนอเมื่อ ${thaiDate(q.submitted_at)}</div>
      ${canAccept ? `
        <div class="action-row">
          <button type="button" class="btn btn-approve btn-sm" data-rfq-accept-quote="${q.quote_id}" data-rfq-accept-rfq="${rfqId}">ยอมรับใบเสนอราคานี้</button>
        </div>
      ` : ""}
    </div>
  `;
}

function rfqMineCard(r) {
  const badgeClass = RFQ_STATUS_BADGE_CLASS[r.status] || "status-pending";
  const auction = auctionMineByRfqId.get(r.rfq_id);
  let auctionBadgeOrButton = "";
  if (r.status === "open") {
    if (auction) {
      const aBadgeClass = AUCTION_STATUS_BADGE_CLASS[auction.status] || "status-pending";
      auctionBadgeOrButton = `<span class="badge ${aBadgeClass}">🏆 ประมูล: ${escapeHtml(AUCTION_STATUS_LABEL_TH[auction.status] || auction.status)}</span>`;
    } else {
      auctionBadgeOrButton = `<button type="button" class="btn btn-ghost btn-sm" data-rfq-toggle-auction-form="${r.rfq_id}">🏆 เปิดประมูล (e-Auction)</button>`;
    }
  }
  return `
    <div class="item-card" data-rfq-id="${r.rfq_id}">
      <div class="row">
        <span class="title">${escapeHtml(r.title)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(RFQ_STATUS_LABEL_TH[r.status] || r.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(RFQ_CATEGORY_LABEL_TH[r.category] || r.category)}</div>
      ${r.description ? `<div class="detail-line muted">${escapeHtml(r.description)}</div>` : ""}
      <div class="detail-line muted">${rfqMetaLine(r)}</div>
      <div class="detail-line muted">ประกาศเมื่อ ${thaiDate(r.created_at)}</div>
      <div class="action-row">
        <button type="button" class="btn btn-ghost btn-sm" data-rfq-toggle-quotes="${r.rfq_id}">ดูใบเสนอราคา</button>
        ${r.status === "open" ? `<button type="button" class="btn btn-decline btn-sm" data-rfq-cancel="${r.rfq_id}">ยกเลิกประกาศ</button>` : ""}
        ${auctionBadgeOrButton}
      </div>
      ${(!auction && r.status === "open") ? `
        <div data-rfq-auction-form-container="${r.rfq_id}" style="display:none; margin-top:8px;">
          <div class="form-grid">
            <div class="field full">
              <label>ปิดรับราคาเมื่อ (วัน-เวลา)</label>
              <input type="datetime-local" data-rfq-auction-closes-at="${r.rfq_id}" />
            </div>
          </div>
          <div class="action-row">
            <button type="button" class="btn btn-primary btn-sm" data-rfq-submit-auction="${r.rfq_id}">เริ่มการประมูล</button>
          </div>
        </div>
      ` : ""}
      <div data-rfq-quotes-container="${r.rfq_id}" style="display:none;"></div>
    </div>
  `;
}

async function loadRfqMine() {
  const el = document.getElementById("rfqMineSection");
  try {
    const list = await AgroLinkCoopAPI.get("/procurement/rfqs/mine");
    rfqMineCache = list;
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ยังไม่มีประกาศของท่าน — ประกาศความต้องการแรกได้ด้านบน</div>`
      : list.map(rfqMineCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประกาศของฉันไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("rfqMineSection").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-rfq-toggle-quotes]");
  const cancelBtn = e.target.closest("[data-rfq-cancel]");
  const acceptBtn = e.target.closest("[data-rfq-accept-quote]");
  const toggleAuctionBtn = e.target.closest("[data-rfq-toggle-auction-form]");
  const submitAuctionBtn = e.target.closest("[data-rfq-submit-auction]");

  if (toggleAuctionBtn) {
    const rfqId = toggleAuctionBtn.dataset.rfqToggleAuctionForm;
    const container = document.querySelector(`[data-rfq-auction-form-container="${rfqId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    container.style.display = isHidden ? "block" : "none";
    toggleAuctionBtn.textContent = isHidden ? "ยกเลิก" : "🏆 เปิดประมูล (e-Auction)";
    return;
  }

  if (toggleBtn) {
    const rfqId = toggleBtn.dataset.rfqToggleQuotes;
    const container = document.querySelector(`[data-rfq-quotes-container="${rfqId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    if (!isHidden) {
      container.style.display = "none";
      toggleBtn.textContent = "ดูใบเสนอราคา";
      return;
    }
    container.style.display = "block";
    toggleBtn.textContent = "ซ่อนใบเสนอราคา";
    container.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
    try {
      const quotes = await AgroLinkCoopAPI.get(`/procurement/rfqs/${rfqId}/quotes`);
      const rfq = rfqMineCache.find((r) => r.rfq_id === rfqId);
      const rfqStatus = rfq ? rfq.status : "open";
      container.innerHTML = quotes.length === 0
        ? `<div class="muted" style="font-size:12px; padding:8px 0;">ยังไม่มีใบเสนอราคา</div>`
        : quotes.map((q) => rfqQuoteRow(q, rfqId, rfqStatus)).join("");
    } catch (err) {
      container.innerHTML = `<div class="muted" style="font-size:12px;">โหลดใบเสนอราคาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    }
    return;
  }

  if (cancelBtn) {
    const rfqId = cancelBtn.dataset.rfqCancel;
    if (!confirm("ยืนยันยกเลิกประกาศนี้?")) return;
    cancelBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/procurement/rfqs/${rfqId}/cancel`, {});
      toast("ยกเลิกประกาศเรียบร้อยแล้ว");
      await loadRfqMine();
    } catch (err) {
      toast("ยกเลิกไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      cancelBtn.disabled = false;
    }
    return;
  }

  if (acceptBtn) {
    const quoteId = acceptBtn.dataset.rfqAcceptQuote;
    const rfqId = acceptBtn.dataset.rfqAcceptRfq;
    if (!confirm("ยืนยันยอมรับใบเสนอราคานี้? ใบเสนอราคาอื่นสำหรับประกาศนี้จะถูกปฏิเสธโดยอัตโนมัติ และระบบจะสร้างสัญญาอัตโนมัติทันที")) return;
    acceptBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/procurement/rfqs/${rfqId}/quotes/${quoteId}/accept`, {});
      toast("ยอมรับใบเสนอราคาเรียบร้อยแล้ว — สร้างสัญญาอัตโนมัติแล้ว");
      await loadRfqMine();
      await loadContractsMine();
    } catch (err) {
      toast("ยอมรับไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      acceptBtn.disabled = false;
    }
    return;
  }

  if (submitAuctionBtn) {
    const rfqId = submitAuctionBtn.dataset.rfqSubmitAuction;
    const closesAtInput = document.querySelector(`[data-rfq-auction-closes-at="${rfqId}"]`);
    const closesAtValue = closesAtInput ? closesAtInput.value : "";
    if (!closesAtValue) {
      toast("กรุณาเลือกวัน-เวลาปิดรับราคา", true);
      return;
    }
    const closesAtDate = new Date(closesAtValue);
    if (Number.isNaN(closesAtDate.getTime()) || closesAtDate.getTime() <= Date.now()) {
      toast("วัน-เวลาปิดรับราคาต้องเป็นเวลาในอนาคต", true);
      return;
    }
    submitAuctionBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post("/procurement/auctions", {
        rfq_id: rfqId,
        closes_at: closesAtDate.toISOString(),
      });
      toast("เปิดการประมูลเรียบร้อยแล้ว");
      await loadAuctionsMine();
      await loadRfqMine();
    } catch (err) {
      toast("เปิดประมูลไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      submitAuctionBtn.disabled = false;
    }
  }
});

document.getElementById("rfqPostForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("rfqPostSubmitBtn");
  const payload = {
    category: document.getElementById("rfqCategorySelect").value,
    title: document.getElementById("rfqTitleInput").value.trim(),
    description: document.getElementById("rfqDescriptionInput").value.trim() || null,
    quantity: document.getElementById("rfqQuantityInput").value ? Number(document.getElementById("rfqQuantityInput").value) : null,
    quantity_unit: document.getElementById("rfqQuantityUnitInput").value.trim() || null,
    target_price: document.getElementById("rfqTargetPriceInput").value ? Number(document.getElementById("rfqTargetPriceInput").value) : null,
    delivery_location: document.getElementById("rfqDeliveryLocationInput").value.trim() || null,
    needed_by_date: document.getElementById("rfqNeededByInput").value || null,
  };
  if (!payload.title) {
    toast("กรุณากรอกหัวข้อ", true);
    return;
  }
  btn.disabled = true;
  try {
    await AgroLinkCoopAPI.post("/procurement/rfqs", payload);
    toast("ประกาศความต้องการเรียบร้อยแล้ว");
    document.getElementById("rfqPostForm").reset();
    await loadRfqMine();
  } catch (err) {
    toast("ประกาศไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
  } finally {
    btn.disabled = false;
  }
});

function rfqBrowseCard(r) {
  const badgeClass = RFQ_STATUS_BADGE_CLASS[r.status] || "status-pending";
  const showQuoteForm = rfqIsOrganization && r.status === "open";
  return `
    <div class="item-card" data-rfq-id="${r.rfq_id}">
      <div class="row">
        <span class="title">${escapeHtml(r.title)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(RFQ_STATUS_LABEL_TH[r.status] || r.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(RFQ_CATEGORY_LABEL_TH[r.category] || r.category)} · โดย ${escapeHtml(r.requester_name || "-")}</div>
      ${r.description ? `<div class="detail-line muted">${escapeHtml(r.description)}</div>` : ""}
      <div class="detail-line muted">${rfqMetaLine(r)}</div>
      ${showQuoteForm ? `
        <div class="action-row">
          <button type="button" class="btn btn-ghost btn-sm" data-rfq-toggle-quote-form="${r.rfq_id}">เสนอราคา</button>
        </div>
        <div data-rfq-quote-form-container="${r.rfq_id}" style="display:none; margin-top:8px;">
          <div class="form-grid">
            <div class="field">
              <label>ราคาที่เสนอ (บาท)</label>
              <input type="number" min="0.01" step="0.01" data-rfq-quote-price="${r.rfq_id}" />
            </div>
            <div class="field">
              <label>จำนวนที่เสนอ (ถ้ามี)</label>
              <input type="number" min="0.01" step="0.01" data-rfq-quote-qty="${r.rfq_id}" />
            </div>
            <div class="field full">
              <label>ข้อความเพิ่มเติม</label>
              <input type="text" data-rfq-quote-message="${r.rfq_id}" />
            </div>
            ${r.category === "produce" ? lotSelectFieldHtml("data-rfq-quote-lot", r.rfq_id) : ""}
          </div>
          <div class="action-row">
            <button type="button" class="btn btn-primary btn-sm" data-rfq-submit-quote="${r.rfq_id}">ส่งใบเสนอราคา</button>
          </div>
        </div>
      ` : ""}
    </div>
  `;
}

async function loadRfqBrowse() {
  const el = document.getElementById("rfqBrowseSection");
  const category = document.getElementById("rfqBrowseCategoryFilter").value;
  el.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const query = category ? `?category=${encodeURIComponent(category)}` : "";
    const list = await AgroLinkCoopAPI.get(`/procurement/rfqs${query}`);
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ไม่มีประกาศที่เปิดอยู่ในขณะนี้</div>`
      : list.map(rfqBrowseCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประกาศไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("rfqBrowseCategoryFilter").addEventListener("change", () => loadRfqBrowse());

document.getElementById("rfqBrowseSection").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-rfq-toggle-quote-form]");
  const submitBtn = e.target.closest("[data-rfq-submit-quote]");

  if (toggleBtn) {
    const rfqId = toggleBtn.dataset.rfqToggleQuoteForm;
    const container = document.querySelector(`[data-rfq-quote-form-container="${rfqId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    container.style.display = isHidden ? "block" : "none";
    toggleBtn.textContent = isHidden ? "ยกเลิก" : "เสนอราคา";
    return;
  }

  if (submitBtn) {
    const rfqId = submitBtn.dataset.rfqSubmitQuote;
    const priceInput = document.querySelector(`[data-rfq-quote-price="${rfqId}"]`);
    const qtyInput = document.querySelector(`[data-rfq-quote-qty="${rfqId}"]`);
    const messageInput = document.querySelector(`[data-rfq-quote-message="${rfqId}"]`);
    const lotInput = document.querySelector(`[data-rfq-quote-lot="${rfqId}"]`);
    const price = priceInput ? Number(priceInput.value) : NaN;
    if (!Number.isFinite(price) || price <= 0) {
      toast("กรุณากรอกราคาที่เสนอให้ถูกต้อง", true);
      return;
    }
    submitBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/procurement/rfqs/${rfqId}/quotes`, {
        quoted_price: price,
        quoted_quantity: qtyInput && qtyInput.value ? Number(qtyInput.value) : null,
        message: messageInput && messageInput.value.trim() ? messageInput.value.trim() : null,
        lot_id: lotInput && lotInput.value ? lotInput.value : null,
      });
      toast("ส่งใบเสนอราคาเรียบร้อยแล้ว");
      await loadRfqBrowse();
      await loadRfqMyQuotes();
    } catch (err) {
      toast("ส่งใบเสนอราคาไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      submitBtn.disabled = false;
    }
  }
});

function rfqMyQuoteCard(q) {
  const badgeClass = RFQ_QUOTE_STATUS_BADGE_CLASS[q.status] || "status-pending";
  return `
    <div class="item-card" data-quote-id="${q.quote_id}">
      <div class="row">
        <span class="title">${escapeHtml(q.rfq_title)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(RFQ_QUOTE_STATUS_LABEL_TH[q.status] || q.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(RFQ_CATEGORY_LABEL_TH[q.rfq_category] || q.rfq_category)} · ผู้ประกาศ ${escapeHtml(q.rfq_requester_name || "-")}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">
        เสนอ ${rfqMoney(q.quoted_price)} ${escapeHtml(q.price_unit)}${q.quoted_quantity ? ` · จำนวน ${rfqMoney(q.quoted_quantity)}` : ""}
      </div>
      ${q.message ? `<div class="detail-line muted">${escapeHtml(q.message)}</div>` : ""}
      <div class="detail-line muted">เสนอเมื่อ ${thaiDate(q.submitted_at)}</div>
      ${q.status === "submitted" ? `
        <div class="action-row">
          <button type="button" class="btn btn-decline btn-sm" data-rfq-withdraw-quote="${q.quote_id}">ถอนใบเสนอราคา</button>
        </div>
      ` : ""}
    </div>
  `;
}

async function loadRfqMyQuotes() {
  if (!rfqIsOrganization) return;
  const el = document.getElementById("rfqMyQuotesSection");
  const status = document.getElementById("rfqMyQuotesStatusFilter").value;
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const list = await AgroLinkCoopAPI.get(`/procurement/quotes/mine${query}`);
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ท่านยังไม่เคยเสนอราคา</div>`
      : list.map(rfqMyQuoteCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดใบเสนอราคาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("rfqMyQuotesStatusFilter").addEventListener("change", () => loadRfqMyQuotes());

document.getElementById("rfqMyQuotesSection").addEventListener("click", async (e) => {
  const withdrawBtn = e.target.closest("[data-rfq-withdraw-quote]");
  if (withdrawBtn) {
    const quoteId = withdrawBtn.dataset.rfqWithdrawQuote;
    if (!confirm("ยืนยันถอนใบเสนอราคานี้?")) return;
    withdrawBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/procurement/quotes/${quoteId}/withdraw`, {});
      toast("ถอนใบเสนอราคาเรียบร้อยแล้ว");
      await loadRfqMyQuotes();
    } catch (err) {
      toast("ถอนไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      withdrawBtn.disabled = false;
    }
  }
});

function auctionBidRow(b, isWinner) {
  return `
    <div class="item-card" style="margin-top:8px;${isWinner ? " border-color:var(--green-700);" : ""}">
      <div class="row">
        <span class="title">${escapeHtml(b.bidder_org_name)}${isWinner ? " 🏆 ผู้ชนะ" : ""}</span>
        <span style="font-weight:700; color:var(--green-900);">${rfqMoney(b.bid_price)} บาท</span>
      </div>
      ${b.bid_quantity ? `<div class="detail-line muted">จำนวนที่เสนอ ${rfqMoney(b.bid_quantity)}</div>` : ""}
      ${b.message ? `<div class="detail-line muted">${escapeHtml(b.message)}</div>` : ""}
      <div class="detail-line muted">เสนอเมื่อ ${thaiDate(b.submitted_at)}</div>
    </div>
  `;
}

function auctionMineCard(a) {
  const badgeClass = AUCTION_STATUS_BADGE_CLASS[a.status] || "status-pending";
  const lowestText = a.current_lowest_bid
    ? `ราคาต่ำสุดขณะนี้ ${rfqMoney(a.current_lowest_bid)} บาท (มีผู้เสนอราคา ${a.bid_count} ราย)`
    : "ยังไม่มีผู้เสนอราคา";
  return `
    <div class="item-card" data-auction-id="${a.auction_id}">
      <div class="row">
        <span class="title">${escapeHtml(a.title)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(AUCTION_STATUS_LABEL_TH[a.status] || a.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(RFQ_CATEGORY_LABEL_TH[a.category] || a.category)}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">${lowestText}</div>
      <div class="detail-line muted">${a.status === "open" ? "ปิดรับราคาภายใน" : "ปิดเมื่อ"} ${thaiDate(a.status === "open" ? a.closes_at : a.closed_at)}</div>
      <div class="action-row">
        <button type="button" class="btn btn-ghost btn-sm" data-auction-toggle-bids="${a.auction_id}">ดูผู้เสนอราคาทั้งหมด</button>
        ${a.status === "open" ? `<button type="button" class="btn btn-decline btn-sm" data-auction-close="${a.auction_id}">ปิดประมูลตอนนี้</button>` : ""}
      </div>
      <div data-auction-bids-container="${a.auction_id}" style="display:none;"></div>
    </div>
  `;
}

async function loadAuctionsMine() {
  const el = document.getElementById("auctionMineSection");
  try {
    const list = await AgroLinkCoopAPI.get("/procurement/auctions/mine");
    auctionMineCache = list;
    auctionMineByRfqId = new Map(list.map((a) => [a.rfq_id, a]));
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ท่านยังไม่เคยเปิดประมูล — เปิดได้จากปุ่ม "เปิดประมูล (e-Auction)" บนประกาศ RFQ ของท่านด้านบน (ต้องมีสถานะ "เปิดรับใบเสนอราคา")</div>`
      : list.map(auctionMineCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการประมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("auctionMineSection").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-auction-toggle-bids]");
  const closeBtn = e.target.closest("[data-auction-close]");

  if (toggleBtn) {
    const auctionId = toggleBtn.dataset.auctionToggleBids;
    const container = document.querySelector(`[data-auction-bids-container="${auctionId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    if (!isHidden) {
      container.style.display = "none";
      toggleBtn.textContent = "ดูผู้เสนอราคาทั้งหมด";
      return;
    }
    container.style.display = "block";
    toggleBtn.textContent = "ซ่อนผู้เสนอราคา";
    container.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
    try {
      const bids = await AgroLinkCoopAPI.get(`/procurement/auctions/${auctionId}/bids`);
      const auction = auctionMineCache.find((a) => a.auction_id === auctionId);
      const winningBidId = auction ? auction.winning_bid_id : null;
      container.innerHTML = bids.length === 0
        ? `<div class="muted" style="font-size:12px; padding:8px 0;">ยังไม่มีผู้เสนอราคา</div>`
        : bids.map((b) => auctionBidRow(b, b.bid_id === winningBidId)).join("");
    } catch (err) {
      container.innerHTML = `<div class="muted" style="font-size:12px;">โหลดผู้เสนอราคาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    }
    return;
  }

  if (closeBtn) {
    const auctionId = closeBtn.dataset.auctionClose;
    if (!confirm("ยืนยันปิดประมูลตอนนี้? ผู้เสนอราคาต่ำสุด ณ ขณะนี้จะได้รับเลือกทันทีและระบบจะสร้างสัญญาอัตโนมัติ")) return;
    closeBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/procurement/auctions/${auctionId}/close`, {});
      toast("ปิดประมูลเรียบร้อยแล้ว");
      await loadAuctionsMine();
      await loadRfqMine();
      await loadContractsMine();
    } catch (err) {
      toast("ปิดประมูลไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      closeBtn.disabled = false;
    }
  }
});

function auctionBrowseCard(a) {
  const badgeClass = AUCTION_STATUS_BADGE_CLASS[a.status] || "status-pending";
  const lowestText = a.current_lowest_bid
    ? `ราคาต่ำสุดขณะนี้ ${rfqMoney(a.current_lowest_bid)} บาท (มีผู้เสนอราคา ${a.bid_count} ราย) — ต้องเสนอราคาต่ำกว่านี้`
    : "ยังไม่มีผู้เสนอราคา — เสนอราคาใดก็ได้ที่มากกว่า 0";
  const showBidForm = rfqIsOrganization && a.status === "open";
  return `
    <div class="item-card" data-auction-id="${a.auction_id}">
      <div class="row">
        <span class="title">${escapeHtml(a.title)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(AUCTION_STATUS_LABEL_TH[a.status] || a.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(RFQ_CATEGORY_LABEL_TH[a.category] || a.category)} · โดย ${escapeHtml(a.requester_name || "-")}</div>
      ${a.quantity ? `<div class="detail-line muted">จำนวน ${rfqMoney(a.quantity)} ${escapeHtml(a.quantity_unit || "")}</div>` : ""}
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">${lowestText}</div>
      <div class="detail-line muted">ปิดรับราคาภายใน ${thaiDate(a.closes_at)}</div>
      ${showBidForm ? `
        <div class="action-row">
          <button type="button" class="btn btn-ghost btn-sm" data-toggle-bid-form="${a.auction_id}">เสนอราคาแข่งขัน</button>
        </div>
        <div data-bid-form-container="${a.auction_id}" style="display:none; margin-top:8px;">
          <div class="form-grid">
            <div class="field">
              <label>ราคาที่เสนอ (บาท) — ต้องต่ำกว่าราคาต่ำสุดปัจจุบัน</label>
              <input type="number" min="0.01" step="0.01" data-bid-price="${a.auction_id}" />
            </div>
            <div class="field">
              <label>จำนวนที่เสนอ (ถ้ามี)</label>
              <input type="number" min="0.01" step="0.01" data-bid-qty="${a.auction_id}" />
            </div>
            <div class="field full">
              <label>ข้อความเพิ่มเติม</label>
              <input type="text" data-bid-message="${a.auction_id}" />
            </div>
            ${a.category === "produce" ? lotSelectFieldHtml("data-bid-lot", a.auction_id) : ""}
          </div>
          <div class="action-row">
            <button type="button" class="btn btn-primary btn-sm" data-submit-bid="${a.auction_id}">ส่งราคาเสนอ</button>
          </div>
        </div>
      ` : ""}
    </div>
  `;
}

async function loadAuctionsBrowse() {
  const el = document.getElementById("auctionBrowseSection");
  el.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const list = await AgroLinkCoopAPI.get("/procurement/auctions?status=open");
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ไม่มีการประมูลที่เปิดอยู่ในขณะนี้</div>`
      : list.map(auctionBrowseCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการประมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("auctionBrowseSection").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-toggle-bid-form]");
  const submitBtn = e.target.closest("[data-submit-bid]");

  if (toggleBtn) {
    const auctionId = toggleBtn.dataset.toggleBidForm;
    const container = document.querySelector(`[data-bid-form-container="${auctionId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    container.style.display = isHidden ? "block" : "none";
    toggleBtn.textContent = isHidden ? "ยกเลิก" : "เสนอราคาแข่งขัน";
    return;
  }

  if (submitBtn) {
    const auctionId = submitBtn.dataset.submitBid;
    const priceInput = document.querySelector(`[data-bid-price="${auctionId}"]`);
    const qtyInput = document.querySelector(`[data-bid-qty="${auctionId}"]`);
    const messageInput = document.querySelector(`[data-bid-message="${auctionId}"]`);
    const lotInput = document.querySelector(`[data-bid-lot="${auctionId}"]`);
    const price = priceInput ? Number(priceInput.value) : NaN;
    if (!Number.isFinite(price) || price <= 0) {
      toast("กรุณากรอกราคาที่เสนอให้ถูกต้อง", true);
      return;
    }
    submitBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/procurement/auctions/${auctionId}/bids`, {
        bid_price: price,
        bid_quantity: qtyInput && qtyInput.value ? Number(qtyInput.value) : null,
        message: messageInput && messageInput.value.trim() ? messageInput.value.trim() : null,
        lot_id: lotInput && lotInput.value ? lotInput.value : null,
      });
      toast("ส่งราคาเสนอเรียบร้อยแล้ว");
      await loadAuctionsBrowse();
    } catch (err) {
      const errCode = (err.body && err.body.error) || err.message;
      let msg = errCode;
      if (errCode === "bid_not_competitive") {
        msg = `ราคาที่เสนอต้องต่ำกว่า ${rfqMoney(err.body.current_lowest_bid)} บาท`;
      } else if (errCode === "kyb_not_verified") {
        msg = "องค์กรของท่านยังไม่ผ่านการยืนยัน KYB จึงยังเสนอราคาไม่ได้";
      } else if (errCode === "auction_not_open") {
        msg = "การประมูลนี้ปิดรับราคาแล้ว";
      }
      toast("เสนอราคาไม่สำเร็จ: " + msg, true);
      submitBtn.disabled = false;
    }
  }
});

// -- Purchase Order (issued against an active contract — see
// procurement.create_contract_from_award) --

function contractPoCard(c) {
  const canIssue = c.status === "active" && PO_ISSUER_ROLES_CLIENT.includes(c.party_role);
  return `
    <div class="item-card" data-contract-id="${c.contract_id}">
      <div class="row">
        <span class="title">${escapeHtml(c.rfq_title || CONTRACT_TYPE_LABEL_TH[c.contract_type] || c.contract_type)}</span>
        <span class="badge ${c.status === "active" ? "status-approved" : "status-pending"}">${escapeHtml(c.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(CONTRACT_TYPE_LABEL_TH[c.contract_type] || c.contract_type)} · บทบาทของท่าน: ${escapeHtml(CONTRACT_ROLE_LABEL_TH[c.party_role] || c.party_role)}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">
        จำนวน ${rfqMoney(c.agreed_quantity)} ${escapeHtml(c.quantity_unit || "")} · ราคาต่อหน่วย ${rfqMoney(c.agreed_unit_price)} บาท
      </div>
      ${c.terms_summary ? `<div class="detail-line muted">${escapeHtml(c.terms_summary)}</div>` : ""}
      <div class="detail-line muted">เริ่มมีผลเมื่อ ${rfqThaiDateOnly(c.effective_date)}</div>
      ${canIssue ? `
        <div class="action-row">
          <button type="button" class="btn btn-primary btn-sm" data-toggle-po-form="${c.contract_id}">ออกใบสั่งซื้อ (PO)</button>
        </div>
        <div data-po-form-container="${c.contract_id}" style="display:none; margin-top:8px;">
          <div class="form-grid">
            <div class="field">
              <label>จำนวน</label>
              <input type="number" min="0.01" step="0.01" data-po-quantity="${c.contract_id}" value="${c.agreed_quantity || ""}" />
            </div>
            <div class="field">
              <label>หน่วยนับ</label>
              <input type="text" data-po-qty-unit="${c.contract_id}" value="${escapeHtml(c.quantity_unit || "")}" />
            </div>
            <div class="field">
              <label>ราคาต่อหน่วย (บาท)</label>
              <input type="number" min="0.01" step="0.01" data-po-unit-price="${c.contract_id}" value="${c.agreed_unit_price || ""}" />
            </div>
            <div class="field">
              <label>สถานที่ส่งมอบ</label>
              <input type="text" data-po-delivery="${c.contract_id}" />
            </div>
            <div class="field">
              <label>ต้องการภายในวันที่</label>
              <input type="date" data-po-needed-by="${c.contract_id}" />
            </div>
            <div class="field full">
              <label>หมายเหตุ</label>
              <input type="text" data-po-notes="${c.contract_id}" />
            </div>
          </div>
          <div class="action-row">
            <button type="button" class="btn btn-primary btn-sm" data-submit-po="${c.contract_id}">ยืนยันออกใบสั่งซื้อ</button>
          </div>
        </div>
      ` : ""}
    </div>
  `;
}

async function loadContractsMine() {
  const el = document.getElementById("contractsMineSection");
  try {
    const list = await AgroLinkCoopAPI.get("/procurement/contracts/mine");
    contractsMineCache = list;
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ยังไม่มีสัญญา — สัญญาจะถูกสร้างอัตโนมัติเมื่อประกาศ RFQ ของท่านได้รับการตกลง (ยอมรับใบเสนอราคา หรือ ปิดประมูล e-Auction)</div>`
      : list.map(contractPoCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการสัญญาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("contractsMineSection").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-toggle-po-form]");
  const submitBtn = e.target.closest("[data-submit-po]");

  if (toggleBtn) {
    const contractId = toggleBtn.dataset.togglePoForm;
    const container = document.querySelector(`[data-po-form-container="${contractId}"]`);
    if (!container) return;
    const isHidden = container.style.display === "none";
    container.style.display = isHidden ? "block" : "none";
    toggleBtn.textContent = isHidden ? "ยกเลิก" : "ออกใบสั่งซื้อ (PO)";
    return;
  }

  if (submitBtn) {
    const contractId = submitBtn.dataset.submitPo;
    const qty = Number(document.querySelector(`[data-po-quantity="${contractId}"]`).value);
    const unitPrice = Number(document.querySelector(`[data-po-unit-price="${contractId}"]`).value);
    const qtyUnit = document.querySelector(`[data-po-qty-unit="${contractId}"]`).value.trim();
    const delivery = document.querySelector(`[data-po-delivery="${contractId}"]`).value.trim();
    const neededBy = document.querySelector(`[data-po-needed-by="${contractId}"]`).value;
    const notes = document.querySelector(`[data-po-notes="${contractId}"]`).value.trim();
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitPrice) || unitPrice <= 0) {
      toast("กรุณากรอกจำนวนและราคาต่อหน่วยให้ถูกต้อง", true);
      return;
    }
    submitBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post("/procurement/purchase-orders", {
        contract_id: contractId,
        quantity: qty,
        quantity_unit: qtyUnit || null,
        unit_price: unitPrice,
        delivery_location: delivery || null,
        needed_by_date: neededBy || null,
        notes: notes || null,
      });
      toast("ออกใบสั่งซื้อเรียบร้อยแล้ว");
      await loadPurchaseOrdersMine();
    } catch (err) {
      toast("ออกใบสั่งซื้อไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
    } finally {
      submitBtn.disabled = false;
    }
  }
});

// Keyed by po_id / invoice_id — populated by loadPurchaseOrdersMine()
// alongside the PO list itself, so poCard() can render each PO's GRN and
// Invoice state inline without a per-card round trip.
let grnByPoCache = {};
let invoiceByPoCache = {};

function grnAndInvoiceSectionHtml(p, isIssuer, session) {
  const grn = grnByPoCache[p.po_id];
  const invoice = invoiceByPoCache[p.po_id];
  const parts = [];

  // GRN: recorded by whoever ISSUED the PO, once it's been acknowledged.
  if (!grn) {
    if (isIssuer && p.status === "acknowledged") {
      parts.push(`
        <div class="sub-panel" style="margin-top:8px; padding:10px; border:1px dashed var(--gray-300); border-radius:8px;">
          <div class="detail-line" style="font-weight:700;">บันทึกการรับสินค้า (GRN)</div>
          <div class="form-grid">
            <div class="field">
              <label>จำนวนที่ได้รับจริง</label>
              <input type="number" min="0.01" step="0.01" data-grn-received="${p.po_id}" value="${p.quantity}" />
            </div>
            <div class="field">
              <label>จำนวนที่ยอมรับ</label>
              <input type="number" min="0" step="0.01" data-grn-accepted="${p.po_id}" value="${p.quantity}" />
            </div>
            <div class="field">
              <label>จำนวนที่ปฏิเสธ (ถ้ามี)</label>
              <input type="number" min="0" step="0.01" data-grn-rejected="${p.po_id}" value="0" />
            </div>
            <div class="field full">
              <label>เหตุผลที่ปฏิเสธ (ถ้ามี)</label>
              <input type="text" data-grn-rejection-reason="${p.po_id}" />
            </div>
          </div>
          <div class="action-row">
            <button type="button" class="btn btn-primary btn-sm" data-grn-submit="${p.po_id}">บันทึกการรับสินค้า</button>
          </div>
        </div>
      `);
    }
    return parts.join("");
  }

  parts.push(`
    <div class="detail-line" style="margin-top:6px;">
      📥 รับสินค้าแล้ว: ยอมรับ ${rfqMoney(grn.accepted_quantity)}${grn.rejected_quantity > 0 ? ` · ปฏิเสธ ${rfqMoney(grn.rejected_quantity)}` : ""}
      จากที่ส่งมอบ ${rfqMoney(grn.received_quantity)} (${thaiDate(grn.received_at)})
      ${grn.rejection_reason ? `<br/><span class="muted">เหตุผล: ${escapeHtml(grn.rejection_reason)}</span>` : ""}
    </div>
  `);

  // Invoice: issued by the SELLER side (the non-issuer party), once a GRN
  // with some accepted quantity exists.
  if (!invoice) {
    if (!isIssuer && Number(grn.accepted_quantity) > 0) {
      const previewAmount = Number(grn.accepted_quantity) * Number(p.unit_price);
      parts.push(`
        <div class="sub-panel" style="margin-top:8px; padding:10px; border:1px dashed var(--gray-300); border-radius:8px;">
          <div class="detail-line">ยอดใบแจ้งหนี้โดยประมาณ: <strong>${rfqMoney(previewAmount)} บาท</strong> (${rfqMoney(grn.accepted_quantity)} × ${rfqMoney(p.unit_price)})</div>
          <div class="action-row">
            <button type="button" class="btn btn-primary btn-sm" data-invoice-issue="${p.po_id}">ออกใบแจ้งหนี้</button>
          </div>
        </div>
      `);
    }
    return parts.join("");
  }

  const invBadge = INVOICE_STATUS_BADGE_CLASS[invoice.status] || "status-pending";
  parts.push(`
    <div class="detail-line" style="margin-top:6px; font-weight:700;">
      🧾 ${escapeHtml(invoice.invoice_no)}
      <span class="badge ${invBadge}">${escapeHtml(INVOICE_STATUS_LABEL_TH[invoice.status] || invoice.status)}</span>
      — ${rfqMoney(invoice.amount)} บาท
    </div>
    ${invoice.dispute_reason ? `<div class="detail-line muted">ข้อโต้แย้ง: ${escapeHtml(invoice.dispute_reason)}</div>` : ""}
  `);

  if (invoice.status === "issued") {
    if (isIssuer) {
      const needsUnit = session && session.subject_type === "farmer";
      parts.push(`
        <div class="action-row">
          ${needsUnit ? `<select data-invoice-payer-unit="${invoice.invoice_id}" style="margin-right:6px;"><option value="">— เลือกแปลง/หน่วยผลิตที่จะใช้ชำระ —</option></select>` : ""}
          <button type="button" class="btn btn-approve btn-sm" data-invoice-pay="${invoice.invoice_id}">ชำระเงิน</button>
          <button type="button" class="btn btn-decline btn-sm" data-invoice-dispute="${invoice.invoice_id}">โต้แย้งใบแจ้งหนี้</button>
        </div>
      `);
    } else {
      parts.push(`
        <div class="action-row">
          <button type="button" class="btn btn-decline btn-sm" data-invoice-cancel="${invoice.invoice_id}">ยกเลิกใบแจ้งหนี้</button>
        </div>
      `);
    }
  } else if (invoice.status === "paid" && !isIssuer) {
    parts.push(`
      <div class="action-row">
        <button type="button" class="btn btn-primary btn-sm" data-revshare-create="${invoice.invoice_id}">สร้างแผนกระจายรายได้คืนสมาชิก</button>
      </div>
      <p style="font-size:12px; color:var(--gray-500); margin:4px 0 0;">
        ใช้ได้เฉพาะเมื่อข้อเสนอ/ราคาประมูลที่ชนะของ PO นี้ระบุล็อตผลผลิตไว้ — ถ้าไม่ได้ระบุไว้ ระบบจะแจ้งเหตุผลให้ทราบ
      </p>
    `);
  }

  return parts.join("");
}

function poCard(p) {
  const badgeClass = PO_STATUS_BADGE_CLASS[p.status] || "status-pending";
  const session = AgroLinkCoopAPI.getSession();
  const isIssuer = !!(session && p.issued_by_subject_type === session.subject_type && p.issued_by_subject_id === session.subject_id);
  const canAcknowledge = !isIssuer && p.status === "issued";
  const canCancel = ["issued", "acknowledged"].includes(p.status);
  return `
    <div class="item-card" data-po-id="${p.po_id}">
      <div class="row">
        <span class="title">${escapeHtml(p.po_number)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(PO_STATUS_LABEL_TH[p.status] || p.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(CONTRACT_TYPE_LABEL_TH[p.contract_type] || p.contract_type)}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">
        ${rfqMoney(p.quantity)} ${escapeHtml(p.quantity_unit || "")} × ${rfqMoney(p.unit_price)} บาท = ${rfqMoney(p.total_amount)} บาท
      </div>
      ${p.delivery_location ? `<div class="detail-line muted">ส่งที่ ${escapeHtml(p.delivery_location)}</div>` : ""}
      ${p.needed_by_date ? `<div class="detail-line muted">ต้องการภายใน ${rfqThaiDateOnly(p.needed_by_date)}</div>` : ""}
      ${p.notes ? `<div class="detail-line muted">${escapeHtml(p.notes)}</div>` : ""}
      <div class="detail-line muted">ออกเมื่อ ${thaiDate(p.issued_at)}${p.acknowledged_at ? ` · ตอบรับเมื่อ ${thaiDate(p.acknowledged_at)}` : ""}</div>
      ${(canAcknowledge || canCancel) ? `
        <div class="action-row">
          ${canAcknowledge ? `<button type="button" class="btn btn-approve btn-sm" data-po-acknowledge="${p.po_id}">รับทราบใบสั่งซื้อ</button>` : ""}
          ${canCancel ? `<button type="button" class="btn btn-decline btn-sm" data-po-cancel="${p.po_id}">ยกเลิกใบสั่งซื้อ</button>` : ""}
        </div>
      ` : ""}
      ${["acknowledged", "in_fulfillment", "completed"].includes(p.status) ? grnAndInvoiceSectionHtml(p, isIssuer, session) : ""}
    </div>
  `;
}

async function loadPurchaseOrdersMine() {
  const el = document.getElementById("purchaseOrdersMineSection");
  try {
    const [list, grns, invoices] = await Promise.all([
      AgroLinkCoopAPI.get("/procurement/purchase-orders/mine"),
      AgroLinkCoopAPI.get("/procurement/goods-receipts/mine"),
      AgroLinkCoopAPI.get("/procurement/invoices/mine"),
    ]);
    grnByPoCache = Object.fromEntries(grns.map((g) => [g.po_id, g]));
    invoiceByPoCache = Object.fromEntries(invoices.map((i) => [i.po_id, i]));
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ยังไม่มีใบสั่งซื้อ</div>`
      : list.map(poCard).join("");
    // Fill in the farmer-payer unit selects that grnAndInvoiceSectionHtml
    // left as placeholders — populated here rather than baked into the
    // HTML string since it needs the caller's own production units.
    if (session_isFarmer()) await populateInvoicePayerUnitSelects();
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดใบสั่งซื้อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

function session_isFarmer() {
  const session = AgroLinkCoopAPI.getSession();
  return !!(session && session.subject_type === "farmer");
}

// Cooperative dashboard sessions are organization-only in practice (the
// login flow never issues a farmer session here), so this stays a no-op
// today — kept for shape-parity with the same helper on the Buyer/
// InputSupplier dashboards, where a farmer session IS reachable.
async function populateInvoicePayerUnitSelects() {}

document.getElementById("purchaseOrdersMineSection").addEventListener("click", async (e) => {
  const ackBtn = e.target.closest("[data-po-acknowledge]");
  const cancelBtn = e.target.closest("[data-po-cancel]");
  const grnSubmitBtn = e.target.closest("[data-grn-submit]");
  const invoiceIssueBtn = e.target.closest("[data-invoice-issue]");
  const invoicePayBtn = e.target.closest("[data-invoice-pay]");
  const invoiceDisputeBtn = e.target.closest("[data-invoice-dispute]");
  const invoiceCancelBtn = e.target.closest("[data-invoice-cancel]");
  const revshareCreateBtn = e.target.closest("[data-revshare-create]");

  if (ackBtn) {
    const poId = ackBtn.dataset.poAcknowledge;
    if (!confirm("ยืนยันรับทราบใบสั่งซื้อนี้?")) return;
    ackBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/procurement/purchase-orders/${poId}/acknowledge`, {});
      toast("รับทราบใบสั่งซื้อเรียบร้อยแล้ว");
      await loadPurchaseOrdersMine();
    } catch (err) {
      toast("รับทราบไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      ackBtn.disabled = false;
    }
    return;
  }

  if (cancelBtn) {
    const poId = cancelBtn.dataset.poCancel;
    if (!confirm("ยืนยันยกเลิกใบสั่งซื้อนี้?")) return;
    cancelBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/procurement/purchase-orders/${poId}/cancel`, {});
      toast("ยกเลิกใบสั่งซื้อเรียบร้อยแล้ว");
      await loadPurchaseOrdersMine();
    } catch (err) {
      toast("ยกเลิกไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      cancelBtn.disabled = false;
    }
    return;
  }

  if (grnSubmitBtn) {
    const poId = grnSubmitBtn.dataset.grnSubmit;
    const received = Number(document.querySelector(`[data-grn-received="${poId}"]`).value);
    const accepted = Number(document.querySelector(`[data-grn-accepted="${poId}"]`).value);
    const rejected = Number(document.querySelector(`[data-grn-rejected="${poId}"]`).value || 0);
    const reason = document.querySelector(`[data-grn-rejection-reason="${poId}"]`).value.trim();
    if (!Number.isFinite(received) || received <= 0 || !Number.isFinite(accepted) || accepted < 0) {
      toast("กรุณากรอกจำนวนที่รับและยอมรับให้ถูกต้อง", true);
      return;
    }
    grnSubmitBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post("/procurement/goods-receipts", {
        po_id: poId, received_quantity: received, accepted_quantity: accepted,
        rejected_quantity: rejected, rejection_reason: reason || null,
      });
      toast("บันทึกการรับสินค้าเรียบร้อยแล้ว");
      await loadPurchaseOrdersMine();
    } catch (err) {
      toast("บันทึกไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      grnSubmitBtn.disabled = false;
    }
    return;
  }

  if (invoiceIssueBtn) {
    const poId = invoiceIssueBtn.dataset.invoiceIssue;
    invoiceIssueBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post("/procurement/invoices", { po_id: poId });
      toast("ออกใบแจ้งหนี้เรียบร้อยแล้ว");
      await loadPurchaseOrdersMine();
    } catch (err) {
      toast("ออกใบแจ้งหนี้ไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      invoiceIssueBtn.disabled = false;
    }
    return;
  }

  if (invoicePayBtn) {
    const invoiceId = invoicePayBtn.dataset.invoicePay;
    const unitSelect = document.querySelector(`[data-invoice-payer-unit="${invoiceId}"]`);
    if (!confirm("ยืนยันชำระเงินใบแจ้งหนี้นี้?")) return;
    invoicePayBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/procurement/invoices/${invoiceId}/pay`, {
        payer_unit_id: unitSelect && unitSelect.value ? unitSelect.value : null,
      });
      toast("ชำระเงินเรียบร้อยแล้ว");
      await loadPurchaseOrdersMine();
    } catch (err) {
      toast("ชำระเงินไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      invoicePayBtn.disabled = false;
    }
    return;
  }

  if (invoiceDisputeBtn) {
    const invoiceId = invoiceDisputeBtn.dataset.invoiceDispute;
    const reason = prompt("เหตุผลในการโต้แย้งใบแจ้งหนี้นี้ (ถ้ามี):") || "";
    invoiceDisputeBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/procurement/invoices/${invoiceId}/dispute`, { reason: reason.trim() || null });
      toast("บันทึกข้อโต้แย้งเรียบร้อยแล้ว");
      await loadPurchaseOrdersMine();
    } catch (err) {
      toast("บันทึกไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      invoiceDisputeBtn.disabled = false;
    }
    return;
  }

  if (invoiceCancelBtn) {
    const invoiceId = invoiceCancelBtn.dataset.invoiceCancel;
    if (!confirm("ยืนยันยกเลิกใบแจ้งหนี้นี้?")) return;
    invoiceCancelBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/procurement/invoices/${invoiceId}/cancel`, {});
      toast("ยกเลิกใบแจ้งหนี้เรียบร้อยแล้ว");
      await loadPurchaseOrdersMine();
    } catch (err) {
      toast("ยกเลิกไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      invoiceCancelBtn.disabled = false;
    }
    return;
  }

  if (revshareCreateBtn) {
    const invoiceId = revshareCreateBtn.dataset.revshareCreate;
    revshareCreateBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post("/procurement/revenue-share-plans", { invoice_id: invoiceId });
      toast("สร้างแผนกระจายรายได้เรียบร้อยแล้ว");
      await loadRevenueSharePlansMine();
    } catch (err) {
      toast("สร้างแผนไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
    } finally {
      revshareCreateBtn.disabled = false;
    }
  }
});

function revshareLineRow(l) {
  const badgeClass = l.status === "paid" ? "status-approved" : l.status === "failed" ? "status-declined" : "status-pending";
  return `
    <div class="item-card" style="margin-top:6px;">
      <div class="row">
        <span class="title">${escapeHtml(l.farmer_name || l.farmer_id.slice(0, 8))}</span>
        <span class="badge ${badgeClass}">${escapeHtml(REVSHARE_LINE_STATUS_LABEL_TH[l.status] || l.status)}</span>
      </div>
      <div class="detail-line muted">ส่งมอบ ${rfqMoney(l.contributed_quantity_ton)} ตัน (${rfqMoney(l.share_percent)}%)</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">${rfqMoney(l.amount)} บาท</div>
      ${l.failure_reason ? `<div class="detail-line muted">เหตุผลที่ไม่สำเร็จ: ${escapeHtml(l.failure_reason)}</div>` : ""}
    </div>
  `;
}

function revshareplanCard(p) {
  const badgeClass = p.status === "distributed" ? "status-approved" : "status-pending";
  return `
    <div class="item-card" data-plan-id="${p.plan_id}">
      <div class="row">
        <span class="title">แผนกระจายรายได้ — ${rfqMoney(p.total_amount)} บาท</span>
        <span class="badge ${badgeClass}">${escapeHtml(REVSHARE_PLAN_STATUS_LABEL_TH[p.status] || p.status)}</span>
      </div>
      <div class="detail-line muted">สร้างเมื่อ ${thaiDate(p.created_at)}${p.distributed_at ? ` · กระจายเงินเมื่อ ${thaiDate(p.distributed_at)}` : ""}</div>
      ${p.status === "pending" ? `
        <div class="action-row">
          <button type="button" class="btn btn-primary btn-sm" data-revshare-distribute="${p.plan_id}">กระจายเงินให้สมาชิก</button>
        </div>
      ` : ""}
      <div style="margin-top:8px;">
        ${(p.lines || []).map(revshareLineRow).join("")}
      </div>
    </div>
  `;
}

async function loadRevenueSharePlansMine() {
  const el = document.getElementById("revenueSharePlansMineSection");
  el.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const list = await AgroLinkCoopAPI.get("/procurement/revenue-share-plans/mine");
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ยังไม่มีแผนกระจายรายได้</div>`
      : list.map(revshareplanCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดแผนกระจายรายได้ไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("revenueSharePlansMineSection").addEventListener("click", async (e) => {
  const distributeBtn = e.target.closest("[data-revshare-distribute]");
  if (!distributeBtn) return;
  const planId = distributeBtn.dataset.revshareDistribute;
  if (!confirm("ยืนยันกระจายเงินให้สมาชิกตามแผนนี้? การโอนเงินแต่ละรายจะดำเนินการทันทีและไม่สามารถย้อนกลับได้")) return;
  distributeBtn.disabled = true;
  try {
    const result = await AgroLinkCoopAPI.post(`/procurement/revenue-share-plans/${planId}/distribute`, {});
    const failedCount = (result.lines || []).filter((l) => l.status === "failed").length;
    toast(failedCount > 0 ? `กระจายเงินเสร็จสิ้น แต่มี ${failedCount} รายการที่โอนไม่สำเร็จ` : "กระจายเงินให้สมาชิกเรียบร้อยแล้ว", failedCount > 0);
    await loadRevenueSharePlansMine();
  } catch (err) {
    toast("กระจายเงินไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
    distributeBtn.disabled = false;
  }
});

async function refreshRfq() {
  const session = AgroLinkCoopAPI.getSession();
  rfqIsOrganization = !!(session && session.subject_type === "organization");
  if (!rfqIsOrganization) {
    document.getElementById("rfqMyQuotesTitle").style.display = "none";
    document.getElementById("rfqMyQuotesFilterRow").style.display = "none";
    document.getElementById("rfqMyQuotesSection").style.display = "none";
  }
  // auctionMineByRfqId must be populated BEFORE rfqMineCard() renders, so
  // load it first rather than folding it into the Promise.all below.
  await loadAuctionsMine();
  await Promise.all([
    loadRfqMine(),
    loadRfqBrowse(),
    loadAuctionsBrowse(),
    loadContractsMine(),
    loadPurchaseOrdersMine(),
    loadRevenueSharePlansMine(),
  ]);
  if (rfqIsOrganization) await loadRfqMyQuotes();
}

// ---------- Farmer 360° View ----------
// See FARMER_360_ARCHITECTURE.md §4 (visibility model) and
// backend/src/routes/farmer360.js for exactly what each response field
// means and why. This MVP round is membership + land + transactions only
// — no consent workflow, no credit score (both explicitly deferred).
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
    const farmer = await AgroLinkCoopAPI.get(`/farmer360/search?${query}`);
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
    const result = await AgroLinkCoopAPI.post("/farmer360/relationships/sync");
    toast(`ซิงค์สำเร็จ — เพิ่มสมาชิกใหม่ ${result.linked_count} ราย`);
    await loadFarmer360Roster();
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
    await AgroLinkCoopAPI.post("/farmer360/relationships", { farmer_id: farmerId });
    toast("เพิ่มเกษตรกรเป็นสมาชิกเรียบร้อยแล้ว");
    document.getElementById("farmer360SearchResultSection").innerHTML = "";
    document.getElementById("farmer360SearchCode").value = "";
    document.getElementById("farmer360SearchPhone").value = "";
    await loadFarmer360Roster();
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
    const roster = await AgroLinkCoopAPI.get("/farmer360/relationships/mine");
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
      const view = await AgroLinkCoopAPI.get(`/farmer360/${farmerId}`);
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
      await AgroLinkCoopAPI.del(`/farmer360/relationships/${farmerId}`);
      toast("เลิกเป็นสมาชิกเรียบร้อยแล้ว");
      await loadFarmer360Roster();
    } catch (err) {
      toast("ดำเนินการไม่สำเร็จ: " + err.message, true);
      unlinkBtn.disabled = false;
    }
  }
});

// ============================================================
// Group Buy (รวมออเดอร์ประมูลร่วมของสหกรณ์) — see GROUP_BUY_ARCHITECTURE.md
// and backend/src/routes/groupbuy.js. Reuses RFQ_CATEGORY_LABEL_TH (defined
// above alongside the RFQ section) since group_buy.category shares the
// exact same domain as procurement.rfq.category.
// ============================================================
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

function groupBuyBrowseCard(gb) {
  const badgeClass = GROUP_BUY_STATUS_BADGE_CLASS[gb.status] || "status-pending";
  return `
    <div class="item-card" data-group-buy-id="${gb.group_buy_id}">
      <div class="row">
        <span class="title">${escapeHtml(gb.product_description)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(GROUP_BUY_STATUS_LABEL_TH[gb.status] || gb.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(RFQ_CATEGORY_LABEL_TH[gb.category] || gb.category)} · เปิดโดย ${escapeHtml(gb.initiator_org_name || "-")}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">${groupBuyProgressLine(gb)}</div>
      <div class="detail-line muted">ปิดรับสมัครเข้าร่วมภายใน ${thaiDate(gb.closes_at)} · ${gb.participant_count || 0} สหกรณ์เข้าร่วมแล้ว</div>
      <div class="action-row" style="display:flex; gap:8px; align-items:center;">
        <input type="number" min="0.01" step="0.01" placeholder="ปริมาณที่ต้องการ" data-group-buy-qty-input="${gb.group_buy_id}" style="max-width:160px;" />
        <button type="button" class="btn btn-primary btn-sm" data-group-buy-join="${gb.group_buy_id}">เข้าร่วม</button>
      </div>
    </div>
  `;
}

function groupBuyMineCard(gb) {
  const badgeClass = GROUP_BUY_STATUS_BADGE_CLASS[gb.status] || "status-pending";
  const roleTags = [
    gb.is_mine ? "เปิดโดยฉัน" : null,
    gb.is_lead ? "สหกรณ์หัวขบวน" : null,
    gb.my_participation_status === "joined" ? "เข้าร่วมแล้ว" : null,
    gb.my_participation_status === "withdrawn" ? "ถอนตัวแล้ว" : null,
  ].filter(Boolean).join(" · ");

  let actions = "";
  if (gb.status === "collecting" && gb.my_participation_status === "joined") {
    actions = `<div class="action-row"><button type="button" class="btn btn-decline btn-sm" data-group-buy-withdraw="${gb.group_buy_id}">ถอนตัว</button></div>`;
  } else if (gb.status === "converted" && gb.is_lead) {
    actions = `<div class="action-row"><button type="button" class="btn btn-primary btn-sm" data-group-buy-settle="${gb.group_buy_id}">แบ่งต้นทุนคืนสหกรณ์ผู้ร่วมรอบ</button></div>`;
  }

  return `
    <div class="item-card" data-group-buy-id="${gb.group_buy_id}">
      <div class="row">
        <span class="title">${escapeHtml(gb.product_description)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(GROUP_BUY_STATUS_LABEL_TH[gb.status] || gb.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(RFQ_CATEGORY_LABEL_TH[gb.category] || gb.category)}${roleTags ? " · " + escapeHtml(roleTags) : ""}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">${groupBuyProgressLine(gb)}</div>
      ${gb.my_requested_qty ? `<div class="detail-line muted">ปริมาณที่ฉันแจ้งไว้: ${Number(gb.my_requested_qty).toLocaleString("th-TH")} ${escapeHtml(gb.target_unit || "")}</div>` : ""}
      ${gb.status === "converted" ? `<div class="detail-line muted">สหกรณ์หัวขบวน: ${escapeHtml(gb.lead_org_name || "-")}</div>` : ""}
      <div class="detail-line muted">${gb.status === "collecting" ? "ปิดรับสมัครภายใน" : "เปิดเมื่อ"} ${thaiDate(gb.status === "collecting" ? gb.closes_at : gb.created_at)}</div>
      ${actions}
    </div>
  `;
}

async function loadGroupBuyBrowse() {
  const el = document.getElementById("groupBuyBrowseSection");
  try {
    const list = await AgroLinkCoopAPI.get("/procurement/group-buys?status=collecting");
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ยังไม่มีรอบที่เปิดอยู่ — เปิดรอบแรกได้ด้านบน</div>`
      : list.map(groupBuyBrowseCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรอบที่เปิดอยู่ไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadGroupBuyMine() {
  const el = document.getElementById("groupBuyMineSection");
  try {
    const list = await AgroLinkCoopAPI.get("/procurement/group-buys/mine");
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ยังไม่มีรอบของท่าน — เปิดรอบใหม่หรือเข้าร่วมรอบที่เปิดอยู่ด้านบน</div>`
      : list.map(groupBuyMineCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรอบของฉันไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function refreshGroupBuys() {
  await Promise.all([loadGroupBuyBrowse(), loadGroupBuyMine()]);
}

document.getElementById("groupBuyPostForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("groupBuyPostSubmitBtn");
  const closesAtValue = document.getElementById("groupBuyClosesAtInput").value;
  if (!closesAtValue) {
    toast("กรุณาเลือกวัน-เวลาปิดรับสมัคร", true);
    return;
  }
  const closesAtDate = new Date(closesAtValue);
  if (Number.isNaN(closesAtDate.getTime()) || closesAtDate.getTime() <= Date.now()) {
    toast("วัน-เวลาปิดรับสมัครต้องเป็นเวลาในอนาคต", true);
    return;
  }
  const payload = {
    category: document.getElementById("groupBuyCategorySelect").value,
    product_description: document.getElementById("groupBuyProductDescInput").value.trim(),
    target_unit: document.getElementById("groupBuyTargetUnitInput").value.trim() || null,
    min_total_qty: document.getElementById("groupBuyMinQtyInput").value ? Number(document.getElementById("groupBuyMinQtyInput").value) : null,
    closes_at: closesAtDate.toISOString(),
  };
  if (!payload.product_description) {
    toast("กรุณาระบุสินค้าที่ต้องการรวมซื้อ", true);
    return;
  }
  btn.disabled = true;
  try {
    await AgroLinkCoopAPI.post("/procurement/group-buys", payload);
    toast("เปิดรอบรวมออเดอร์เรียบร้อยแล้ว");
    document.getElementById("groupBuyPostForm").reset();
    await refreshGroupBuys();
  } catch (err) {
    toast("เปิดรอบไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("groupBuyBrowseSection").addEventListener("click", async (e) => {
  const joinBtn = e.target.closest("[data-group-buy-join]");
  if (!joinBtn) return;
  const groupBuyId = joinBtn.dataset.groupBuyJoin;
  const qtyInput = document.querySelector(`[data-group-buy-qty-input="${groupBuyId}"]`);
  const qty = qtyInput ? Number(qtyInput.value) : NaN;
  if (!Number.isFinite(qty) || qty <= 0) {
    toast("กรุณากรอกปริมาณที่ต้องการ", true);
    return;
  }
  joinBtn.disabled = true;
  try {
    await AgroLinkCoopAPI.post(`/procurement/group-buys/${groupBuyId}/join`, { requested_qty: qty });
    toast("เข้าร่วมรอบเรียบร้อยแล้ว");
    await refreshGroupBuys();
  } catch (err) {
    toast("เข้าร่วมไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
    joinBtn.disabled = false;
  }
});

document.getElementById("groupBuyMineSection").addEventListener("click", async (e) => {
  const withdrawBtn = e.target.closest("[data-group-buy-withdraw]");
  const settleBtn = e.target.closest("[data-group-buy-settle]");

  if (withdrawBtn) {
    const groupBuyId = withdrawBtn.dataset.groupBuyWithdraw;
    if (!confirm("ยืนยันถอนตัวจากรอบนี้?")) return;
    withdrawBtn.disabled = true;
    try {
      await AgroLinkCoopAPI.post(`/procurement/group-buys/${groupBuyId}/withdraw`, {});
      toast("ถอนตัวเรียบร้อยแล้ว");
      await refreshGroupBuys();
    } catch (err) {
      toast("ถอนตัวไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      withdrawBtn.disabled = false;
    }
    return;
  }

  if (settleBtn) {
    const groupBuyId = settleBtn.dataset.groupBuySettle;
    if (!confirm("ยืนยันแบ่งต้นทุนคืนสหกรณ์ผู้ร่วมรอบ? ระบบจะโอนเงินจากบัญชีของแต่ละสหกรณ์เข้าบัญชีของท่านทันทีตามสัดส่วนที่แจ้งไว้ — ต้องชำระใบแจ้งหนี้ให้ซัพพลายเออร์เรียบร้อยแล้วเท่านั้น")) return;
    settleBtn.disabled = true;
    try {
      const result = await AgroLinkCoopAPI.post(`/procurement/group-buys/${groupBuyId}/settle`, {});
      const paidCount = result.lines.filter((l) => l.status === "paid").length;
      const failedCount = result.lines.filter((l) => l.status === "failed").length;
      toast(`แบ่งต้นทุนสำเร็จ ${paidCount} ราย${failedCount > 0 ? ` (ล้มเหลว ${failedCount} ราย — ตรวจสอบบัญชีของสหกรณ์ที่ล้มเหลว)` : ""}`, failedCount > 0);
      await refreshGroupBuys();
    } catch (err) {
      toast("แบ่งต้นทุนไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      settleBtn.disabled = false;
    }
  }
});

async function init() {
  const session = AgroLinkCoopAPI.requireSessionOrRedirect();
  if (!session) return;

  try {
    const d = await AgroLinkCoopAPI.get("/coop/dashboard");
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

  await loadOpenLots();
  loadDeliveryReviewQueue();
  loadDeliveryHistory();
  loadProductionUnits();
  loadCommodities();
  loadLotList();
  refreshWarehouse();
  refreshFinance();
  refreshProcessing();
  refreshLogistics();
  refreshGovGateway();
  loadStaffRoles();
  loadStaff();
  loadRegistrationDocument();
  loadCoopProducts();
  refreshCoopOrders();
  refreshRfq();
  refreshGroupBuys();
  loadFarmer360Roster();
}

init();
