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
  // eventually removed from) a lot.
  await Promise.all([loadOpenLots(), loadLotList(), loadDeliveryReviewQueue(), loadDeliveryHistory(), refreshSummary()]);
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
  try {
    commodityCache = await AgroLinkCoopAPI.get("/coop/commodities");
    const options = `<option value="">-- เลือกชนิดผลผลิต --</option>` +
      commodityCache.map((c) => `<option value="${c.commodity_code}">${escapeHtml(c.name_th)}</option>`).join("");
    el.innerHTML = options;
    lotEl.innerHTML = options;
  } catch (err) {
    el.innerHTML = `<option value="">โหลดชนิดผลผลิตไม่สำเร็จ</option>`;
    lotEl.innerHTML = el.innerHTML;
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
    if (lots.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีล็อต — ใช้ฟอร์มด้านบนเพื่อเปิดล็อตแรก</div>`;
      return;
    }
    el.innerHTML = lots.map(lotCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการล็อตไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
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

// NOTE: unlike buyer.js, this M09 slice does NOT expose GET /coop/contracts
// — a cooperative's collection flow is spot-sale-first (see the scope note
// in the dashboard's own HTML). contractSelect therefore always stays at
// its default "no contract / spot sale" option; POST /coop/deliveries
// still accepts a contract_id if one is ever wired in from elsewhere.

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkCoopAPI.logout());

/**
 * GET /coop/dashboard doubles as the KYB/role gate check here — same
 * pattern as every other portal's init().
 */
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
}

init();
