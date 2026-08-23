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

// Same label/badge maps as ../../coop/js/dashboard.js's own — this portal
// shows the SAME shipment records (via logistics.v_shipment_summary), just
// scoped to carrier.linked_org_id instead of shipment.org_id, so the
// vocabulary must match exactly.
const SHIPMENT_STATUS_LABEL_TH = { Pending: "รอดำเนินการ", InTransit: "กำลังเดินทาง", Delivered: "ส่งมอบแล้ว", Cancelled: "ยกเลิกแล้ว" };
const SHIPMENT_STATUS_BADGE_CLASS = { Pending: "status-pending", InTransit: "status-active", Delivered: "status-completed", Cancelled: "status-declined" };
const EXCEPTION_TYPE_LABEL_TH = { Damage: "สินค้าเสียหาย", Shortage: "ขาดหาย", Delay: "ล่าช้า", Rejected: "ถูกปฏิเสธรับสินค้า", Other: "อื่นๆ" };

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
 * Same shape as villagefund/js/dashboard.js's showRolePendingNotice — the
 * org has cleared entity KYB but doesn't (yet) hold a Verified 'Logistics'
 * role.
 */
function showRolePendingNotice(orgName, roleStatus) {
  document.getElementById("orgName").textContent = orgName || "-";
  const body = !roleStatus
    ? {
        title: "องค์กรของท่านยังไม่มีบทบาทผู้ให้บริการขนส่ง",
        detail: "หากต้องการเปิดใช้งานพอร์ทัลนี้ ท่านสามารถส่งคำขอเพิ่มบทบาทได้จากหน้า \"จัดการบทบาทธุรกิจ\"",
      }
    : roleStatus === "Rejected"
    ? { title: "คำขอบทบาทผู้ให้บริการขนส่งของท่านถูกปฏิเสธ", detail: "กรุณาติดต่อเจ้าหน้าที่ผู้ดูแลระบบสำหรับข้อมูลเพิ่มเติม" }
    : { title: "คำขอบทบาทผู้ให้บริการขนส่งของท่านอยู่ระหว่างการตรวจสอบ", detail: "เจ้าหน้าที่ผู้ดูแลระบบ (Platform Ops) กำลังตรวจสอบคำขอนี้ — ลองรีเฟรชหน้านี้อีกครั้งภายหลัง" };

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
    <div class="stat-card"><div class="label">รอดำเนินการ</div><div class="value">${d.shipments_by_status.Pending}</div></div>
    <div class="stat-card"><div class="label">กำลังเดินทาง</div><div class="value">${d.shipments_by_status.InTransit}</div></div>
    <div class="stat-card"><div class="label">ส่งมอบแล้ว</div><div class="value">${d.shipments_by_status.Delivered}</div></div>
    <div class="stat-card"><div class="label">ข้อยกเว้นที่ยังไม่แก้ไข</div><div class="value">${d.open_exception_count}</div></div>
  `;
}

// ---------- งานขนส่งที่ได้รับมอบหมาย ----------
function exceptionRow(exc) {
  return `
    <div class="detail-line">
      ⚠️ ${escapeHtml(EXCEPTION_TYPE_LABEL_TH[exc.exception_type] || exc.exception_type)}: ${escapeHtml(exc.description)}
      ${exc.resolved ? `<span class="badge status-active" style="margin-left:6px;">แก้ไขแล้ว</span>` : `<span class="badge status-pending" style="margin-left:6px;">ยังไม่แก้ไข</span>`}
      <span class="muted"> — โดย ${escapeHtml(exc.reported_by)} เมื่อ ${thaiDate(exc.reported_at)}</span>
      ${exc.resolved ? ` — <span class="muted">แก้ไข: ${escapeHtml(exc.resolution_note || "-")}</span>` : ""}
    </div>
  `;
}

/** d is { shipment, items, proof_of_delivery, exceptions } from GET /logistics/shipments/:id. */
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

  let actions = "";
  if (s.status === "Pending") {
    // A Pending shipment with zero items is still just the cooperative's
    // plan — nothing for the carrier to do yet except wait for cargo to be
    // loaded, so "ออกเดินทาง" only makes sense once item_count > 0.
    actions = s.item_count > 0
      ? `
      <div class="action-row">
        <input type="text" class="reject-reason-input" data-dispatch-by-for="${s.shipment_id}" placeholder="ชื่อผู้ให้ออกเดินทาง (เช่น คนขับ)" />
        <button type="button" class="btn btn-approve btn-sm" data-dispatch-shipment="${s.shipment_id}">ออกเดินทาง</button>
      </div>
    `
      : `<div class="detail-line muted">รอสหกรณ์เพิ่มสินค้าเข้ารถก่อนจึงจะออกเดินทางได้</div>`;
  } else if (s.status === "InTransit" || s.status === "Delivered") {
    if (s.status === "InTransit") {
      actions += `
        <div class="action-row">
          <input type="text" class="reject-reason-input" data-pod-received-by-for="${s.shipment_id}" placeholder="ชื่อผู้รับสินค้าปลายทาง" />
          <input type="number" min="0" step="0.001" class="reject-reason-input" data-pod-qty-for="${s.shipment_id}" placeholder="ปริมาณที่ส่งมอบจริง (ตัน)" />
          <input type="text" class="reject-reason-input" data-pod-recorded-by-for="${s.shipment_id}" placeholder="ชื่อผู้บันทึก (เช่น คนขับ)" />
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
      <div class="detail-line muted">มอบหมายโดย: ${escapeHtml(s.coop_org_name || "-")} — ผ่านผู้ขนส่ง ${escapeHtml(s.carrier_name || "-")}${s.license_plate ? " · ทะเบียน " + escapeHtml(s.license_plate) : ""}${s.driver_name ? " · คนขับ " + escapeHtml(s.driver_name) : ""}</div>
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
  const status = document.getElementById("statusFilterSelect").value;
  el.innerHTML = `<div class="loading-line">กำลังโหลดรายการจัดส่ง…</div>`;
  try {
    const path = status ? `/logistics/shipments?status=${encodeURIComponent(status)}` : "/logistics/shipments";
    const shipments = await AgroLinkLogisticsAPI.get(path);
    if (shipments.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีงานขนส่งที่ได้รับมอบหมาย — เมื่อสหกรณ์ผูกบัญชีของท่านเป็นผู้ขนส่งและวางแผนจัดส่ง รายการจะปรากฏที่นี่</div>`;
      return;
    }
    const details = await Promise.all(shipments.map((s) => AgroLinkLogisticsAPI.get(`/logistics/shipments/${s.shipment_id}`)));
    el.innerHTML = details.map(shipmentCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการจัดส่งไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("statusFilterSelect").addEventListener("change", loadShipments);

document.getElementById("shipmentsSection").addEventListener("click", async (e) => {
  const dispatchBtn = e.target.closest("[data-dispatch-shipment]");
  const podBtn = e.target.closest("[data-record-pod]");
  const excBtn = e.target.closest("[data-report-exception]");

  if (dispatchBtn) {
    const shipmentId = dispatchBtn.dataset.dispatchShipment;
    const dispatchedBy = document.querySelector(`[data-dispatch-by-for="${shipmentId}"]`).value.trim();
    if (!dispatchedBy) {
      toast("กรุณากรอกชื่อผู้ให้ออกเดินทาง", true);
      return;
    }
    dispatchBtn.disabled = true;
    try {
      await AgroLinkLogisticsAPI.post(`/logistics/shipments/${shipmentId}/dispatch`, { dispatched_by: dispatchedBy });
      toast("บันทึกออกเดินทางเรียบร้อยแล้ว");
      await loadShipments();
    } catch (err) {
      toast("บันทึกออกเดินทางไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      dispatchBtn.disabled = false;
    }
    return;
  }

  if (podBtn) {
    const shipmentId = podBtn.dataset.recordPod;
    const receivedBy = document.querySelector(`[data-pod-received-by-for="${shipmentId}"]`).value.trim();
    const qty = document.querySelector(`[data-pod-qty-for="${shipmentId}"]`).value;
    const recordedBy = document.querySelector(`[data-pod-recorded-by-for="${shipmentId}"]`).value.trim();
    if (!receivedBy || qty === "" || !recordedBy) {
      toast("กรุณากรอกชื่อผู้รับสินค้า ปริมาณที่ส่งมอบจริง และชื่อผู้บันทึก", true);
      return;
    }
    podBtn.disabled = true;
    try {
      await AgroLinkLogisticsAPI.post(`/logistics/shipments/${shipmentId}/pod`, {
        received_by: receivedBy, received_quantity_ton: Number(qty), recorded_by: recordedBy,
      });
      toast("บันทึกหลักฐานการส่งมอบเรียบร้อยแล้ว");
      await loadShipments();
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
      await AgroLinkLogisticsAPI.post(`/logistics/shipments/${shipmentId}/exceptions`, {
        exception_type: excType, description: desc, reported_by: reportedBy,
      });
      toast("รายงานข้อยกเว้นเรียบร้อยแล้ว");
      await loadShipments();
    } catch (err) {
      toast("รายงานข้อยกเว้นไม่สำเร็จ: " + (err.body && err.body.detail ? err.body.detail : err.message), true);
      excBtn.disabled = false;
    }
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkLogisticsAPI.logout());

/**
 * GET /logistics/dashboard doubles as the KYB/role gate check here — same
 * pattern as every other portal's init().
 */
async function init() {
  const session = AgroLinkLogisticsAPI.requireSessionOrRedirect();
  if (!session) return;

  try {
    const d = await AgroLinkLogisticsAPI.get("/logistics/dashboard");
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

  loadShipments();
}

init();
