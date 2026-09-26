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
    <div class="stat-card"><div class="label">รถในทะเบียน (ใช้งานอยู่)</div><div class="value">${d.active_vehicle_count || 0}</div></div>
    <div class="stat-card"><div class="label">รถเที่ยวเปล่าที่เปิดอยู่</div><div class="value">${d.open_empty_leg_count || 0}</div></div>
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

// =============================================================================
// ทะเบียนรถบรรทุก/รถพ่วง (grant_logistics_marketplace.sql's logistics.
// carrier_vehicle — this org's OWN self-declared fleet, separate from the
// cooperative-side logistics.vehicle used for the assigned-shipments
// section above).
// =============================================================================
const VEHICLE_TYPE_LABEL_TH = { Truck: "รถบรรทุก", Trailer: "รถพ่วง", Pickup: "รถกระบะ", Other: "อื่นๆ" };

let vehicleCache = [];

function vehicleCard(v) {
  const isActive = v.status === "active";
  return `
    <div class="item-card" data-vehicle-id="${v.carrier_vehicle_id}">
      <div class="row">
        <span class="title">${escapeHtml(VEHICLE_TYPE_LABEL_TH[v.vehicle_type] || v.vehicle_type)} — ${escapeHtml(v.license_plate)}</span>
        <span class="badge ${isActive ? "status-active" : "status-declined"}">${isActive ? "ใช้งานอยู่" : "ปิดใช้งาน"}</span>
      </div>
      ${v.capacity_ton ? `<div class="detail-line">น้ำหนักบรรทุก ${Number(v.capacity_ton).toLocaleString("th-TH")} ตัน</div>` : ""}
      <div class="action-row">
        <button type="button" class="btn btn-ghost btn-sm" data-vehicle-toggle-status="${v.carrier_vehicle_id}" data-current-status="${v.status}">
          ${isActive ? "ปิดใช้งานรถคันนี้" : "เปิดใช้งานอีกครั้ง"}
        </button>
      </div>
    </div>
  `;
}

function vehicleSelectOptionsHtml(vehicles) {
  return `<option value="">-- ไม่ระบุ --</option>` + vehicles
    .filter((v) => v.status === "active")
    .map((v) => `<option value="${v.carrier_vehicle_id}">${escapeHtml(VEHICLE_TYPE_LABEL_TH[v.vehicle_type] || v.vehicle_type)} — ${escapeHtml(v.license_plate)}</option>`)
    .join("");
}

async function loadVehicles() {
  const el = document.getElementById("vehicleListSection");
  try {
    const vehicles = await AgroLinkLogisticsAPI.get("/logistics/vehicles");
    vehicleCache = vehicles;
    el.innerHTML = vehicles.length === 0
      ? `<div class="empty-state">ยังไม่มีรถในทะเบียน — เพิ่มคันแรกได้ด้านบน</div>`
      : vehicles.map(vehicleCard).join("");
    const select = document.getElementById("emptyLegVehicleSelect");
    if (select) select.innerHTML = vehicleSelectOptionsHtml(vehicles);
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดทะเบียนรถไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("vehicleAddBtn").addEventListener("click", async () => {
  const plate = document.getElementById("vehiclePlateInput").value.trim();
  if (!plate) {
    toast("กรุณากรอกทะเบียนรถ", true);
    return;
  }
  const capacityRaw = document.getElementById("vehicleCapacityInput").value;
  const btn = document.getElementById("vehicleAddBtn");
  btn.disabled = true;
  try {
    await AgroLinkLogisticsAPI.post("/logistics/vehicles", {
      vehicle_type: document.getElementById("vehicleTypeSelect").value,
      license_plate: plate,
      capacity_ton: capacityRaw ? Number(capacityRaw) : null,
    });
    toast("เพิ่มรถในทะเบียนเรียบร้อยแล้ว");
    document.getElementById("vehiclePlateInput").value = "";
    document.getElementById("vehicleCapacityInput").value = "";
    await Promise.all([loadVehicles(), refreshLogisticsSummary()]);
  } catch (err) {
    toast("เพิ่มรถไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("vehicleListSection").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-vehicle-toggle-status]");
  if (!btn) return;
  const vehicleId = btn.dataset.vehicleToggleStatus;
  const newStatus = btn.dataset.currentStatus === "active" ? "inactive" : "active";
  btn.disabled = true;
  try {
    await AgroLinkLogisticsAPI.post(`/logistics/vehicles/${vehicleId}/status`, { status: newStatus });
    toast("อัปเดตสถานะรถเรียบร้อยแล้ว");
    await Promise.all([loadVehicles(), refreshLogisticsSummary()]);
  } catch (err) {
    toast("อัปเดตสถานะไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
    btn.disabled = false;
  }
});

async function refreshLogisticsSummary() {
  try {
    const d = await AgroLinkLogisticsAPI.get("/logistics/dashboard");
    renderSummary(d);
  } catch (err) {
    // ภาพรวมโหลดสำเร็จมาแล้วอย่างน้อยหนึ่งครั้งกว่าจะมาถึงจุดนี้ได้ — ความล้มเหลว
    // ชั่วคราวตอนรีเฟรชไม่คุ้มที่จะไปรบกวนผู้ใช้
  }
}

// =============================================================================
// พื้นที่ให้บริการ (จังหวัด/อำเภอ) — เหมือนกับ frontend/machinery/js/dashboard.js
// ทุกประการ เพียงแค่เปลี่ยนไปเรียก /logistics/service-area (ดูคอมเมนต์ของ route
// นั้นใน backend/src/routes/logistics.js — partner.vendor_profile.
// service_regions เป็นคอลัมน์กลางที่ทุกองค์กรมีอยู่แล้ว ไม่ใช่คอลัมน์เฉพาะพอร์ทัลเครื่องจักรกล)
// =============================================================================
function serviceRegionsCheckboxesHtml(selected) {
  const selectedSet = new Set(selected || []);
  const districtsByProvince = {};
  TH_DISTRICTS.forEach(([code, name, provinceCode]) => {
    if (!districtsByProvince[provinceCode]) districtsByProvince[provinceCode] = [];
    districtsByProvince[provinceCode].push([code, name]);
  });
  return TH_PROVINCES.map(([provinceCode, provinceName]) => {
    const districts = districtsByProvince[provinceCode] || [];
    const districtCheckboxesHtml = districts.map(([code, name]) => `
      <label style="display:inline-flex; align-items:center; gap:6px; width:45%; min-width:130px; margin:0 0 6px; font-size:12px; font-weight:400; vertical-align:top;">
        <input type="checkbox" value="${code}" ${selectedSet.has(code) ? "checked" : ""} />
        ${escapeHtml(name)}
      </label>
    `).join("");
    return `
      <details style="margin-bottom:4px; border-bottom:1px solid #eee; padding-bottom:4px;">
        <summary style="cursor:pointer; display:flex; align-items:center; gap:6px; font-size:13px; font-weight:600; padding:4px 0;">
          <input type="checkbox" value="${provinceCode}" ${selectedSet.has(provinceCode) ? "checked" : ""} onclick="event.stopPropagation()" />
          <span>${escapeHtml(provinceName)}</span>
          ${districts.length ? `<span style="font-weight:400; color:#888; font-size:11px;">(${districts.length} อำเภอ)</span>` : ""}
        </summary>
        ${districts.length ? `<div style="padding:4px 0 4px 24px;">${districtCheckboxesHtml}</div>` : ""}
      </details>
    `;
  }).join("");
}

async function loadServiceRegions() {
  const el = document.getElementById("serviceRegionsCheckboxes");
  try {
    const { service_regions: regions } = await AgroLinkLogisticsAPI.get("/logistics/service-area");
    el.innerHTML = serviceRegionsCheckboxesHtml(regions);
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดพื้นที่ให้บริการไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("serviceRegionsSaveBtn").addEventListener("click", async () => {
  const checked = Array.from(
    document.querySelectorAll('#serviceRegionsCheckboxes input[type="checkbox"]:checked'),
  ).map((cb) => cb.value);
  const btn = document.getElementById("serviceRegionsSaveBtn");
  btn.disabled = true;
  try {
    await AgroLinkLogisticsAPI.put("/logistics/service-area", { service_regions: checked });
    toast("บันทึกพื้นที่ให้บริการเรียบร้อยแล้ว");
  } catch (err) {
    toast("บันทึกไม่สำเร็จ: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// =============================================================================
// ประกาศงานขนส่ง / เสนอราคา — ใช้ตลาดกลาง RFQ ที่มีอยู่แล้วร่วมกับพอร์ทัลอื่น
// (backend/src/routes/procurement.js, หมวดหมู่ใหม่ 'logistics_transport' —
// ดู grant_logistics_marketplace.sql). ไม่มี origin/destination เป็นคอลัมน์
// แยกใน procurement.rfq จึงรวมไว้ในหัวข้อประกาศ (title) แทน เพื่อไม่ต้องแก้ไข
// schema ของตลาดกลางที่ใช้ร่วมกับพอร์ทัลอื่นๆ
// =============================================================================
const RFQ_STATUS_LABEL_TH = { open: "เปิดรับใบเสนอราคา", awarded: "ตกลงแล้ว (จองแล้ว)", cancelled: "ยกเลิกแล้ว", closed: "ปิดแล้ว" };
const RFQ_STATUS_BADGE_CLASS = { open: "status-active", awarded: "status-approved", cancelled: "status-declined", closed: "status-pending" };
const RFQ_QUOTE_STATUS_LABEL_TH = { submitted: "รอผลพิจารณา", accepted: "ได้รับเลือก (จองแล้ว)", rejected: "ไม่ได้รับเลือก", withdrawn: "ถอนแล้ว" };
const RFQ_QUOTE_STATUS_BADGE_CLASS = { submitted: "status-pending", accepted: "status-approved", rejected: "status-declined", withdrawn: "status-declined" };

function rfqMoney(n) { return Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2 }); }
function rfqDateOnly(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}
function rfqMetaLine(r) {
  const parts = [];
  if (r.quantity) parts.push(`น้ำหนัก ${rfqMoney(r.quantity)} ${escapeHtml(r.quantity_unit || "ตัน")}`);
  if (r.target_price) parts.push(`ราคาเป้าหมาย ${rfqMoney(r.target_price)} บาท`);
  if (r.delivery_location) parts.push(`ปลายทาง ${escapeHtml(r.delivery_location)}`);
  if (r.needed_by_date) parts.push(`ต้องการภายใน ${rfqDateOnly(r.needed_by_date)}`);
  return parts.join(" · ");
}

let rfqMineCache = [];

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
        ${rfqMoney(q.quoted_price)} ${escapeHtml(q.price_unit)}${q.quoted_quantity ? ` · น้ำหนัก ${rfqMoney(q.quoted_quantity)} ตัน` : ""}
      </div>
      ${q.message ? `<div class="detail-line muted">${escapeHtml(q.message)}</div>` : ""}
      <div class="detail-line muted">เสนอเมื่อ ${thaiDate(q.submitted_at)}</div>
      ${canAccept ? `
        <div class="action-row">
          <button type="button" class="btn btn-approve btn-sm" data-rfq-accept-quote="${q.quote_id}" data-rfq-accept-rfq="${rfqId}">ยอมรับ (ยืนยันการจอง)</button>
        </div>
      ` : ""}
    </div>
  `;
}

function rfqMineCard(r) {
  const badgeClass = RFQ_STATUS_BADGE_CLASS[r.status] || "status-pending";
  return `
    <div class="item-card" data-rfq-id="${r.rfq_id}">
      <div class="row"><span class="title">${escapeHtml(r.title)}</span><span class="badge ${badgeClass}">${escapeHtml(RFQ_STATUS_LABEL_TH[r.status] || r.status)}</span></div>
      ${r.description ? `<div class="detail-line muted">${escapeHtml(r.description)}</div>` : ""}
      <div class="detail-line muted">${rfqMetaLine(r)}</div>
      <div class="detail-line muted">ประกาศเมื่อ ${thaiDate(r.created_at)}</div>
      <div class="action-row">
        <button type="button" class="btn btn-ghost btn-sm" data-rfq-toggle-quotes="${r.rfq_id}">ดูใบเสนอราคา</button>
        ${r.status === "open" ? `<button type="button" class="btn btn-decline btn-sm" data-rfq-cancel="${r.rfq_id}">ยกเลิกประกาศ</button>` : ""}
      </div>
      <div data-rfq-quotes-container="${r.rfq_id}" style="display:none;"></div>
    </div>
  `;
}

async function loadRfqMine() {
  const el = document.getElementById("rfqMineSection");
  try {
    const list = await AgroLinkLogisticsAPI.get("/procurement/rfqs/mine?category=logistics_transport");
    // /rfqs/mine ไม่รองรับ query filter บนฝั่ง backend จึงกรองซ้ำฝั่งหน้าเว็บ
    // เผื่อองค์กรนี้เคยประกาศ RFQ หมวดอื่นผ่านหน้าอื่นมาก่อน
    const filtered = list.filter((r) => r.category === "logistics_transport");
    rfqMineCache = filtered;
    el.innerHTML = filtered.length === 0
      ? `<div class="empty-state">ยังไม่มีประกาศของท่าน — ประกาศงานขนส่งแรกได้ด้านบน</div>`
      : filtered.map(rfqMineCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประกาศของฉันไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("rfqMineSection").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-rfq-toggle-quotes]");
  const cancelBtn = e.target.closest("[data-rfq-cancel]");
  const acceptBtn = e.target.closest("[data-rfq-accept-quote]");

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
      const quotes = await AgroLinkLogisticsAPI.get(`/procurement/rfqs/${rfqId}/quotes`);
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
      await AgroLinkLogisticsAPI.post(`/procurement/rfqs/${rfqId}/cancel`, {});
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
    if (!confirm("ยืนยันยอมรับใบเสนอราคานี้? ถือเป็นการยืนยันการจองงานขนส่งนี้ ใบเสนอราคาอื่นจะถูกปฏิเสธโดยอัตโนมัติ")) return;
    acceptBtn.disabled = true;
    try {
      await AgroLinkLogisticsAPI.post(`/procurement/rfqs/${rfqId}/quotes/${quoteId}/accept`, {});
      toast("ยืนยันการจองเรียบร้อยแล้ว");
      await loadRfqMine();
    } catch (err) {
      toast("ยืนยันไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
      acceptBtn.disabled = false;
    }
  }
});

document.getElementById("rfqPostSubmitBtn").addEventListener("click", async () => {
  const origin = document.getElementById("rfqOriginInput").value.trim();
  const destination = document.getElementById("rfqDestinationInput").value.trim();
  if (!origin || !destination) {
    toast("กรุณากรอกต้นทางและปลายทาง", true);
    return;
  }
  const cargoType = document.getElementById("rfqCargoTypeSelect").value;
  const payload = {
    category: "logistics_transport",
    title: `ขนส่ง${cargoType} จาก ${origin} ไป ${destination}`,
    description: document.getElementById("rfqDescriptionInput").value.trim() || null,
    quantity: document.getElementById("rfqQuantityInput").value ? Number(document.getElementById("rfqQuantityInput").value) : null,
    quantity_unit: "ตัน",
    target_price: document.getElementById("rfqTargetPriceInput").value ? Number(document.getElementById("rfqTargetPriceInput").value) : null,
    delivery_location: destination,
    needed_by_date: document.getElementById("rfqNeededByInput").value || null,
  };
  const btn = document.getElementById("rfqPostSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkLogisticsAPI.post("/procurement/rfqs", payload);
    toast("ประกาศงานขนส่งเรียบร้อยแล้ว");
    document.getElementById("rfqOriginInput").value = "";
    document.getElementById("rfqDestinationInput").value = "";
    document.getElementById("rfqQuantityInput").value = "";
    document.getElementById("rfqTargetPriceInput").value = "";
    document.getElementById("rfqNeededByInput").value = "";
    document.getElementById("rfqDescriptionInput").value = "";
    await loadRfqMine();
  } catch (err) {
    toast("ประกาศไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
  } finally {
    btn.disabled = false;
  }
});

function rfqBrowseCard(r) {
  const badgeClass = RFQ_STATUS_BADGE_CLASS[r.status] || "status-pending";
  const showQuoteForm = r.status === "open";
  return `
    <div class="item-card" data-rfq-id="${r.rfq_id}">
      <div class="row"><span class="title">${escapeHtml(r.title)}</span><span class="badge ${badgeClass}">${escapeHtml(RFQ_STATUS_LABEL_TH[r.status] || r.status)}</span></div>
      <div class="detail-line muted">ประกาศโดย ${escapeHtml(r.requester_name || "-")}</div>
      ${r.description ? `<div class="detail-line muted">${escapeHtml(r.description)}</div>` : ""}
      <div class="detail-line muted">${rfqMetaLine(r)}</div>
      ${showQuoteForm ? `
        <div class="action-row">
          <button type="button" class="btn btn-ghost btn-sm" data-rfq-toggle-quote-form="${r.rfq_id}">เสนอราคา</button>
        </div>
        <div data-rfq-quote-form-container="${r.rfq_id}" style="display:none; margin-top:8px;">
          <div class="form-grid">
            <div class="field"><label>ราคาที่เสนอ (บาท)</label><input type="number" min="0.01" step="0.01" data-rfq-quote-price="${r.rfq_id}" /></div>
            <div class="field"><label>หน่วยราคา</label><input type="text" data-rfq-quote-unit="${r.rfq_id}" value="บาท/เที่ยว" /></div>
            <div class="field"><label>น้ำหนักที่รับได้ (ตัน, ถ้ามี)</label><input type="number" min="0.01" step="0.01" data-rfq-quote-qty="${r.rfq_id}" /></div>
            <div class="field full"><label>ข้อความเพิ่มเติม</label><input type="text" data-rfq-quote-message="${r.rfq_id}" /></div>
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
  el.innerHTML = `<div class="loading-line">กำลังโหลด…</div>`;
  try {
    const list = await AgroLinkLogisticsAPI.get("/procurement/rfqs?category=logistics_transport");
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ไม่มีงานขนส่งที่เปิดรับเสนอราคาในขณะนี้</div>`
      : list.map(rfqBrowseCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประกาศไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

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
    const unitInput = document.querySelector(`[data-rfq-quote-unit="${rfqId}"]`);
    const qtyInput = document.querySelector(`[data-rfq-quote-qty="${rfqId}"]`);
    const messageInput = document.querySelector(`[data-rfq-quote-message="${rfqId}"]`);
    const price = priceInput ? Number(priceInput.value) : NaN;
    if (!Number.isFinite(price) || price <= 0) {
      toast("กรุณากรอกราคาที่เสนอให้ถูกต้อง", true);
      return;
    }
    submitBtn.disabled = true;
    try {
      await AgroLinkLogisticsAPI.post(`/procurement/rfqs/${rfqId}/quotes`, {
        quoted_price: price,
        price_unit: (unitInput && unitInput.value.trim()) || "บาท/เที่ยว",
        quoted_quantity: qtyInput && qtyInput.value ? Number(qtyInput.value) : null,
        message: messageInput && messageInput.value.trim() ? messageInput.value.trim() : null,
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
      <div class="row"><span class="title">${escapeHtml(q.rfq_title)}</span><span class="badge ${badgeClass}">${escapeHtml(RFQ_QUOTE_STATUS_LABEL_TH[q.status] || q.status)}</span></div>
      <div class="detail-line muted">ผู้ประกาศ ${escapeHtml(q.rfq_requester_name || "-")}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">
        เสนอ ${rfqMoney(q.quoted_price)} ${escapeHtml(q.price_unit)}${q.quoted_quantity ? ` · น้ำหนัก ${rfqMoney(q.quoted_quantity)} ตัน` : ""}
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
  const el = document.getElementById("rfqMyQuotesSection");
  const status = document.getElementById("rfqMyQuotesStatusFilter").value;
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const list = await AgroLinkLogisticsAPI.get(`/procurement/quotes/mine${query}`);
    const filtered = list.filter((q) => q.rfq_category === "logistics_transport");
    el.innerHTML = filtered.length === 0
      ? `<div class="empty-state">ท่านยังไม่เคยเสนอราคางานขนส่ง</div>`
      : filtered.map(rfqMyQuoteCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดใบเสนอราคาไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("rfqMyQuotesStatusFilter").addEventListener("change", () => loadRfqMyQuotes());

document.getElementById("rfqMyQuotesSection").addEventListener("click", async (e) => {
  const withdrawBtn = e.target.closest("[data-rfq-withdraw-quote]");
  if (!withdrawBtn) return;
  const quoteId = withdrawBtn.dataset.rfqWithdrawQuote;
  if (!confirm("ยืนยันถอนใบเสนอราคานี้?")) return;
  withdrawBtn.disabled = true;
  try {
    await AgroLinkLogisticsAPI.post(`/procurement/quotes/${quoteId}/withdraw`, {});
    toast("ถอนใบเสนอราคาเรียบร้อยแล้ว");
    await loadRfqMyQuotes();
  } catch (err) {
    toast("ถอนไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
    withdrawBtn.disabled = false;
  }
});

// =============================================================================
// รถเที่ยวเปล่า (logistics.empty_leg) — ประกาศฝั่งท่านเอง + กระดานรวมของทุก
// ผู้ให้บริการ (ดู GET /logistics/empty-legs's own doc comment ใน
// backend/src/routes/logistics.js ว่าทำไม endpoint นี้เปิดให้ทุกองค์กรเรียกดูได้)
// =============================================================================
const EMPTY_LEG_STATUS_LABEL_TH = { Open: "เปิดอยู่", Booked: "จองแล้ว", Cancelled: "ยกเลิกแล้ว", Expired: "หมดอายุ" };
const EMPTY_LEG_STATUS_BADGE_CLASS = { Open: "status-active", Booked: "status-approved", Cancelled: "status-declined", Expired: "status-declined" };

function emptyLegMineCard(el) {
  const badgeClass = EMPTY_LEG_STATUS_BADGE_CLASS[el.status] || "status-pending";
  return `
    <div class="item-card" data-empty-leg-id="${el.empty_leg_id}">
      <div class="row"><span class="title">${escapeHtml(el.origin)} → ${escapeHtml(el.destination)}</span><span class="badge ${badgeClass}">${escapeHtml(EMPTY_LEG_STATUS_LABEL_TH[el.status] || el.status)}</span></div>
      <div class="detail-line">วันที่รถว่าง: ${rfqDateOnly(el.available_date)}${el.capacity_ton ? ` · รับได้ ${Number(el.capacity_ton).toLocaleString("th-TH")} ตัน` : ""}</div>
      ${el.note ? `<div class="detail-line muted">${escapeHtml(el.note)}</div>` : ""}
      ${el.status === "Open" ? `
        <div class="action-row">
          <button type="button" class="btn btn-approve btn-sm" data-empty-leg-status="${el.empty_leg_id}" data-set-status="Booked">มีผู้จองแล้ว</button>
          <button type="button" class="btn btn-decline btn-sm" data-empty-leg-status="${el.empty_leg_id}" data-set-status="Cancelled">ยกเลิกประกาศ</button>
        </div>
      ` : ""}
    </div>
  `;
}

async function loadEmptyLegMine() {
  const el = document.getElementById("emptyLegMineSection");
  try {
    const list = await AgroLinkLogisticsAPI.get("/logistics/empty-legs/mine");
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ยังไม่มีประกาศรถเที่ยวเปล่าของท่าน</div>`
      : list.map(emptyLegMineCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรายการไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("emptyLegMineSection").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-empty-leg-status]");
  if (!btn) return;
  const emptyLegId = btn.dataset.emptyLegStatus;
  const newStatus = btn.dataset.setStatus;
  btn.disabled = true;
  try {
    await AgroLinkLogisticsAPI.post(`/logistics/empty-legs/${emptyLegId}/status`, { status: newStatus });
    toast("อัปเดตสถานะเรียบร้อยแล้ว");
    await Promise.all([loadEmptyLegMine(), loadEmptyLegBoard(), refreshLogisticsSummary()]);
  } catch (err) {
    toast("อัปเดตไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
    btn.disabled = false;
  }
});

function emptyLegBoardCard(el) {
  return `
    <div class="item-card" data-empty-leg-id="${el.empty_leg_id}">
      <div class="row"><span class="title">${escapeHtml(el.origin)} → ${escapeHtml(el.destination)}</span></div>
      <div class="detail-line muted">ผู้ให้บริการ: ${escapeHtml(el.carrier_org_name || "-")}${el.license_plate ? " · ทะเบียน " + escapeHtml(el.license_plate) : ""}</div>
      <div class="detail-line">วันที่รถว่าง: ${rfqDateOnly(el.available_date)}${el.capacity_ton ? ` · รับได้ ${Number(el.capacity_ton).toLocaleString("th-TH")} ตัน` : ""}</div>
      ${el.note ? `<div class="detail-line muted">${escapeHtml(el.note)}</div>` : ""}
      ${el.contact_phone ? `<div class="detail-line muted">ติดต่อ: ${escapeHtml(el.contact_phone)}</div>` : `<div class="detail-line muted">ติดต่อผู้ให้บริการโดยตรงนอกระบบเพื่อจอง</div>`}
    </div>
  `;
}

async function loadEmptyLegBoard() {
  const el = document.getElementById("emptyLegBoardSection");
  try {
    const list = await AgroLinkLogisticsAPI.get("/logistics/empty-legs");
    el.innerHTML = list.length === 0
      ? `<div class="empty-state">ยังไม่มีรถเที่ยวเปล่าที่เปิดอยู่ในขณะนี้</div>`
      : list.map(emptyLegBoardCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดกระดานไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("emptyLegAddBtn").addEventListener("click", async () => {
  const origin = document.getElementById("emptyLegOriginInput").value.trim();
  const destination = document.getElementById("emptyLegDestinationInput").value.trim();
  const availableDate = document.getElementById("emptyLegDateInput").value;
  if (!origin || !destination || !availableDate) {
    toast("กรุณากรอกต้นทาง ปลายทาง และวันที่รถว่าง", true);
    return;
  }
  const capacityRaw = document.getElementById("emptyLegCapacityInput").value;
  const btn = document.getElementById("emptyLegAddBtn");
  btn.disabled = true;
  try {
    await AgroLinkLogisticsAPI.post("/logistics/empty-legs", {
      carrier_vehicle_id: document.getElementById("emptyLegVehicleSelect").value || null,
      origin, destination, available_date: availableDate,
      capacity_ton: capacityRaw ? Number(capacityRaw) : null,
      note: document.getElementById("emptyLegNoteInput").value.trim() || null,
      contact_phone: document.getElementById("emptyLegPhoneInput").value.trim() || null,
    });
    toast("ประกาศรถเที่ยวเปล่าเรียบร้อยแล้ว");
    document.getElementById("emptyLegOriginInput").value = "";
    document.getElementById("emptyLegDestinationInput").value = "";
    document.getElementById("emptyLegDateInput").value = "";
    document.getElementById("emptyLegCapacityInput").value = "";
    document.getElementById("emptyLegNoteInput").value = "";
    document.getElementById("emptyLegPhoneInput").value = "";
    await Promise.all([loadEmptyLegMine(), loadEmptyLegBoard(), refreshLogisticsSummary()]);
  } catch (err) {
    toast("ประกาศไม่สำเร็จ: " + ((err.body && err.body.error) || err.message), true);
  } finally {
    btn.disabled = false;
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
  loadVehicles();
  loadServiceRegions();
  loadRfqMine();
  loadRfqBrowse();
  loadRfqMyQuotes();
  loadEmptyLegMine();
  loadEmptyLegBoard();
}

init();
