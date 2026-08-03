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

function thaiDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

const UNIT_TYPE_LABEL = { Plot: "แปลงนา/ไร่", Pen: "คอกปศุสัตว์", Pond: "บ่อเลี้ยง", Orchard: "สวนผลไม้" };
const CYCLE_STATUS_LABEL = { planning: "วางแผน", active: "กำลังปลูก", completed: "เก็บเกี่ยวแล้ว", abandoned: "ยกเลิก" };
const STAGE_STATUS_LABEL = { pending: "ยังไม่เริ่ม", in_progress: "กำลังดำเนินการ", verified: "ยืนยันแล้ว", skipped: "ข้าม" };

document.getElementById("farmerName") && (document.getElementById("farmerName").textContent = "");
document.getElementById("logoutBtn").addEventListener("click", () => AgroLinkAPI.logout());

// ---------- แปลง/หน่วยผลิต ----------
let unitsCache = [];
let cropsCache = [];

function selectedUnitId() {
  return document.getElementById("unitSelect").value;
}

async function loadUnits() {
  const sel = document.getElementById("unitSelect");
  try {
    const units = await AgroLinkAPI.get("/farmer/production-units");
    unitsCache = units;
    if (units.length === 0) {
      sel.innerHTML = `<option value="">ยังไม่มีแปลง/หน่วยผลิต</option>`;
      return;
    }
    sel.innerHTML = units.map((u) =>
      `<option value="${u.unit_id}">${escapeHtml(UNIT_TYPE_LABEL[u.unit_type] || u.unit_type)} — ${escapeHtml(u.commodity_code)} (${u.area_rai} ไร่)</option>`
    ).join("");
  } catch (err) {
    sel.innerHTML = `<option value="">โหลดแปลงไม่สำเร็จ</option>`;
    toast("โหลดแปลงไม่สำเร็จ: " + err.message, true);
  }
}

async function loadCrops() {
  try {
    cropsCache = await AgroLinkAPI.get("/farmer/fertilizer-formula/crops");
  } catch (err) {
    cropsCache = [];
  }
}

document.getElementById("unitSelect").addEventListener("change", onUnitChanged);

async function onUnitChanged() {
  const unitId = selectedUnitId();
  document.getElementById("startCycleSection").innerHTML = "";
  document.getElementById("activeCycleSection").innerHTML = "";
  document.getElementById("cycleHistorySection").innerHTML = `<div class="empty-state">เลือกแปลงด้านบนเพื่อดูประวัติรอบปลูก</div>`;
  if (!unitId) return;
  await refreshUnitCycles(unitId);
}

async function refreshUnitCycles(unitId) {
  let cycles;
  try {
    cycles = await AgroLinkAPI.get(`/farmer/crop-cycles?unit_id=${encodeURIComponent(unitId)}`);
  } catch (err) {
    toast("โหลดรอบปลูกไม่สำเร็จ: " + err.message, true);
    return;
  }

  const activeCycle = cycles.find((c) => c.status === "planning" || c.status === "active");
  const pastCycles = cycles.filter((c) => c.status === "completed" || c.status === "abandoned");

  if (activeCycle) {
    document.getElementById("startCycleSection").innerHTML = "";
    await renderActiveCycle(activeCycle.cycle_id);
  } else {
    document.getElementById("activeCycleSection").innerHTML = "";
    renderStartCycleForm(unitId);
  }

  renderCycleHistory(pastCycles);
}

// ---------- เริ่มรอบปลูกใหม่ ----------
function renderStartCycleForm(unitId) {
  const el = document.getElementById("startCycleSection");
  const unit = unitsCache.find((u) => u.unit_id === unitId);
  const cropOptions = cropsCache.length > 0
    ? cropsCache.map((c) => `<option value="${escapeHtml(c.commodity_code)}" ${unit && unit.commodity_code === c.commodity_code ? "selected" : ""}>${escapeHtml(c.name_th)}</option>`).join("")
    : `<option value="">ยังไม่มีพืชที่รองรับ</option>`;

  el.innerHTML = `
    <div class="section-title">🌱 เริ่มรอบปลูกใหม่</div>
    <div class="panel">
      <form id="startCycleForm">
        <div class="form-grid">
          <div class="field">
            <label for="cycleCommoditySelect">ชนิดพืช</label>
            <select id="cycleCommoditySelect" required>${cropOptions}</select>
          </div>
          <div class="field">
            <label for="cyclePlannedStartInput">วันที่วางแผนเริ่มปลูก</label>
            <input type="date" id="cyclePlannedStartInput" required />
          </div>
        </div>
        <button type="submit" class="btn btn-primary" id="startCycleSubmitBtn" style="max-width:220px;">เริ่มรอบปลูกนี้</button>
      </form>
    </div>
  `;

  document.getElementById("startCycleForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("startCycleSubmitBtn");
    const payload = {
      unit_id: unitId,
      commodity_code: document.getElementById("cycleCommoditySelect").value,
      planned_start_date: document.getElementById("cyclePlannedStartInput").value,
    };
    if (!payload.commodity_code || !payload.planned_start_date) {
      toast("กรุณาเลือกชนิดพืชและวันที่เริ่มปลูก", true);
      return;
    }
    btn.disabled = true;
    try {
      await AgroLinkAPI.post("/farmer/crop-cycles", payload);
      toast("เริ่มรอบปลูกใหม่เรียบร้อยแล้ว");
      await refreshUnitCycles(unitId);
    } catch (err) {
      if (err.body && err.body.error === "unsupported_commodity") {
        toast("ยังไม่รองรับพืชชนิดนี้ในระบบปฏิทินแผนการผลิต", true);
      } else if (err.body && err.body.error === "cycle_already_active") {
        toast("แปลงนี้มีรอบปลูกที่ยังไม่เสร็จอยู่แล้ว", true);
      } else {
        toast("เริ่มรอบปลูกไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
      }
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- รอบปลูกที่กำลังดำเนินการ ----------
async function renderActiveCycle(cycleId) {
  const el = document.getElementById("activeCycleSection");
  el.innerHTML = `<div class="loading-line">กำลังโหลดปฏิทิน…</div>`;
  let cycle;
  try {
    cycle = await AgroLinkAPI.get(`/farmer/crop-cycles/${encodeURIComponent(cycleId)}`);
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดปฏิทินไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const firstUnfinishedIdx = cycle.stages.findIndex((s) => s.status !== "verified" && s.status !== "skipped");

  el.innerHTML = `
    <div class="section-title">🗓️ ปฏิทินแผนการผลิต — ${escapeHtml(cycle.commodity_name_th)}</div>
    <div class="panel">
      <div class="detail-line">สถานะรอบปลูก: <span class="badge status-active">${escapeHtml(CYCLE_STATUS_LABEL[cycle.status] || cycle.status)}</span></div>
      <div class="detail-line muted">เริ่ม ${thaiDate(cycle.planned_start_date)} · คาดเก็บเกี่ยว ${thaiDate(cycle.planned_harvest_date)}</div>
      <div style="margin-top:14px;">
        ${cycle.stages.map((s, idx) => stageRowHtml(s, idx === firstUnfinishedIdx, cycle.cycle_id)).join("")}
      </div>
    </div>
  `;

  cycle.stages.forEach((s, idx) => {
    if (idx !== firstUnfinishedIdx) return;
    const btn = document.getElementById(`confirmBtn_${s.stage_id}`);
    if (!btn) return;
    btn.addEventListener("click", () => confirmStage(cycle.cycle_id, s.stage_id, s));
  });
}

function stageRowHtml(stage, isNext, cycleId) {
  const done = stage.status === "verified" || stage.status === "skipped";
  const isFertilizerStage = stage.stage_key === "soil_test_fertilizer";
  const fertilizerBlocked = isFertilizerStage && stage.fertilizer_step_done === false && !done;

  let actionHtml = "";
  if (done) {
    actionHtml = `<span class="badge status-active">${escapeHtml(STAGE_STATUS_LABEL[stage.status] || stage.status)}</span>`;
  } else if (isNext && fertilizerBlocked) {
    actionHtml = `<a href="fertilizer-calculator.html" class="btn btn-sm btn-ghost" style="text-decoration:none;">ไปคำนวณสูตรปุ๋ยก่อน</a>`;
  } else if (isNext) {
    actionHtml = `<button class="btn btn-sm btn-primary" id="confirmBtn_${stage.stage_id}">ยืนยันขั้นตอนนี้เสร็จแล้ว</button>`;
  } else {
    actionHtml = `<span class="badge">${escapeHtml(STAGE_STATUS_LABEL[stage.status] || stage.status)}</span>`;
  }

  return `
    <div class="item-card" style="margin-bottom:8px;">
      <div class="row" style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
        <div>
          <div class="title">${stage.stage_seq}. ${escapeHtml(stage.stage_name)}</div>
          <div class="detail-line muted">
            แผน ${thaiDate(stage.planned_date)}${stage.actual_date ? " · ยืนยันจริง " + thaiDate(stage.actual_date) : ""}
          </div>
          ${fertilizerBlocked ? `<div class="detail-line muted">ต้องคำนวณสูตรปุ๋ยด้วย AI ปุ๋ยสั่งตัดอย่างน้อย 1 ครั้งก่อน จึงจะยืนยันขั้นนี้ได้</div>` : ""}
        </div>
        <div>${actionHtml}</div>
      </div>
    </div>
  `;
}

async function confirmStage(cycleId, stageId) {
  const btn = document.getElementById(`confirmBtn_${stageId}`);
  if (btn) btn.disabled = true;
  try {
    const result = await AgroLinkAPI.post(`/farmer/crop-cycles/${encodeURIComponent(cycleId)}/stages/${encodeURIComponent(stageId)}/confirm`, {});
    toast(result.cycle_completed ? "ยืนยันขั้นตอนสุดท้ายแล้ว — รอบปลูกนี้เก็บเกี่ยวเสร็จสมบูรณ์!" : "ยืนยันขั้นตอนเรียบร้อยแล้ว");
    await refreshUnitCycles(selectedUnitId());
  } catch (err) {
    if (err.body && err.body.error === "fertilizer_step_incomplete") {
      toast(err.body.message || "กรุณาคำนวณสูตรปุ๋ยก่อนยืนยันขั้นนี้", true);
    } else if (err.body && err.body.error === "previous_stage_not_done") {
      toast("ต้องยืนยันขั้นตอนก่อนหน้า (" + err.body.blocking_stage + ") ก่อน", true);
    } else {
      toast("ยืนยันขั้นตอนไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
    }
    if (btn) btn.disabled = false;
  }
}

// ---------- ประวัติรอบปลูก ----------
function cycleHistoryCard(c) {
  return `
    <div class="item-card">
      <div class="row"><span class="title">${escapeHtml(c.commodity_name_th)}</span> <span class="badge">${escapeHtml(CYCLE_STATUS_LABEL[c.status] || c.status)}</span></div>
      <div class="detail-line">เริ่ม ${thaiDate(c.planned_start_date)} · เก็บเกี่ยวจริง ${thaiDate(c.actual_harvest_date)}</div>
    </div>
  `;
}

function renderCycleHistory(pastCycles) {
  const el = document.getElementById("cycleHistorySection");
  if (pastCycles.length === 0) {
    el.innerHTML = `<div class="empty-state">ยังไม่มีประวัติรอบปลูกที่เสร็จสิ้นสำหรับแปลงนี้</div>`;
    return;
  }
  el.innerHTML = pastCycles.map(cycleHistoryCard).join("");
}

async function init() {
  await Promise.all([loadUnits(), loadCrops()]);
  onUnitChanged();
}

init();
