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
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}
function thaiDateTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("th-TH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const ASSESSMENT_STATUS_LABEL = {
  draft: "ร่าง (ยังไม่ส่งตรวจ)", pending_review: "รอ Platform Ops ตรวจสอบ", verified: "ผ่านการตรวจสอบแล้ว", rejected: "ถูกตีกลับ — แก้ไขและส่งใหม่ได้",
};
function assessmentStatusBadge(status) {
  if (!status) return `<span class="badge status-pending">ยังไม่มีข้อมูล</span>`;
  const cssClass = { draft: "status-pending", pending_review: "status-pending", verified: "status-active", rejected: "status-declined" }[status] || `status-${status}`;
  return `<span class="badge ${cssClass}">${escapeHtml(ASSESSMENT_STATUS_LABEL[status] || status)}</span>`;
}

const UNLOCKED_STATUSES = ["draft", "rejected", null, undefined];

let currentConfig = null;
let currentCycleId = null;

// ---------- เกณฑ์การประเมิน ----------
async function loadMethodology() {
  const el = document.getElementById("methodologyPanel");
  try {
    currentConfig = await AgroLinkAPI.get("/farmer/carbon/methodology");
    const c = currentConfig;
    el.innerHTML = `
      ต้องมี "รอบแห้งที่ผ่านเกณฑ์" อย่างน้อย <strong>${c.min_dry_events_required}</strong> รอบต่อฤดูปลูก
      แต่ละรอบต้องแห้งต่อเนื่องอย่างน้อย <strong>${c.min_dry_period_days}</strong> วัน
      และระดับน้ำต้องลดลงต่ำกว่าผิวดินอย่างน้อย <strong>${c.min_water_level_drop_cm}</strong> ซม.
      (หากไม่มีค่าระดับน้ำ ระบบจะใช้สถานะ "แห้ง" ที่ท่านรายงานตรงๆ) —
      หากเข้าเกณฑ์ทั้งฤดู จะประเมินเครดิตประมาณ <strong>${c.emission_factor_tco2e_per_rai}</strong> tCO2e ต่อไร่
      <div class="cap">อ้างอิงแนวทาง ${escapeHtml(c.methodology_ref)} — ค่าทั้งหมดเป็นค่าประมาณการ ปรับได้โดยผู้ดูแลระบบ ไม่ใช่ตัวเลขทางการของ อบก.</div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดเกณฑ์การประเมินไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- รายการรอบปลูก ----------
function cycleCard(c) {
  const est = c.assessment_status
    ? `${c.is_eligible ? "✅ เข้าเกณฑ์" : "ยังไม่เข้าเกณฑ์"} · ${c.qualifying_dry_events ?? 0}/${c.min_dry_events_required ?? "-"} รอบแห้ง · ประมาณ ${c.estimated_credit_tco2e ?? 0} tCO2e`
    : "ยังไม่มีข้อมูล — เริ่มบันทึกระดับน้ำได้เลย";
  return `
    <div class="item-card cycle-card" data-cycle-id="${c.cycle_id}" style="cursor:pointer;">
      <div class="row"><span class="title">${escapeHtml(c.commodity_name_th)} — แปลง ${c.unit_id.slice(0, 8)}</span>${assessmentStatusBadge(c.assessment_status)}</div>
      <div class="detail-line">ปลูก ${thaiDate(c.planned_start_date)} · สถานะรอบปลูก: ${escapeHtml(c.status)}</div>
      <div class="detail-line muted">${est}</div>
    </div>
  `;
}

async function loadCycles() {
  const el = document.getElementById("cyclesListSection");
  try {
    const cycles = await AgroLinkAPI.get("/farmer/carbon/cycles");
    if (cycles.length === 0) {
      el.innerHTML = `<div class="empty-state">ยังไม่มีรอบปลูกข้าว — เริ่มรอบปลูกใหม่ได้ที่หน้า "ปฏิทินแผนการผลิต" ก่อน แล้วกลับมาที่นี่เพื่อบันทึกข้อมูล AWD</div>`;
      return;
    }
    el.innerHTML = cycles.map(cycleCard).join("");
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดรอบปลูกไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("cyclesListSection").addEventListener("click", (e) => {
  const card = e.target.closest(".cycle-card");
  if (!card) return;
  openDetail(card.dataset.cycleId);
});

// ---------- รายละเอียดรอบปลูก ----------
function renderSummary(cycle, assessment) {
  const el = document.getElementById("detailSummaryPanel");
  const eligibleLine = assessment.qualifying_dry_events > 0 || assessment.status !== "draft"
    ? `<div>รอบแห้งที่ผ่านเกณฑ์: <strong>${assessment.qualifying_dry_events}</strong> / ${assessment.min_dry_events_required} รอบ (รวม ${assessment.total_dry_days} วัน)</div>
       <div>ประเมินคาร์บอนเครดิต: <span class="credit-figure">${assessment.estimated_credit_tco2e}</span> tCO2e ${assessment.is_eligible ? "" : "(ยังไม่เข้าเกณฑ์ขั้นต่ำ)"}</div>`
    : `<div class="detail-line muted">ยังไม่มีข้อมูลระดับน้ำ — เริ่มบันทึกด้านล่างได้เลย</div>`;
  el.innerHTML = `
    <div class="row"><span class="title">${escapeHtml(cycle.commodity_name_th)}</span>${assessmentStatusBadge(assessment.status)}</div>
    <div class="detail-line muted">เริ่มปลูก ${thaiDate(cycle.planned_start_date)} · เก็บเกี่ยว(แผน) ${thaiDate(cycle.planned_harvest_date)}</div>
    ${eligibleLine}
    ${assessment.review_note ? `<div class="detail-line" style="margin-top:8px;"><strong>ข้อความจาก Platform Ops:</strong> ${escapeHtml(assessment.review_note)}</div>` : ""}
  `;
}

function renderWaterLogHistory(logs) {
  const el = document.getElementById("waterLogHistorySection");
  if (logs.length === 0) {
    el.innerHTML = `<div class="empty-state">ยังไม่มีการบันทึกระดับน้ำ</div>`;
    return;
  }
  el.innerHTML = logs.map((l) => `
    <div class="water-log-row">
      <div>
        <span class="water-status-tag ${l.water_status}">${l.water_status === "flooded" ? "💧 ท่วม" : "☀️ แห้ง"}</span>
        ${l.water_level_cm !== null && l.water_level_cm !== undefined ? ` (${l.water_level_cm} ซม.)` : ""}
        ${l.note ? `<div class="detail-line muted">${escapeHtml(l.note)}</div>` : ""}
        ${l.photo_url ? `<div class="detail-line"><a href="${escapeHtml(l.photo_url)}" target="_blank" rel="noopener">ดูรูปถ่าย</a></div>` : ""}
      </div>
      <div class="detail-line muted">${thaiDateTime(l.recorded_at)}</div>
    </div>
  `).join("");
}

function renderSatellite(obs) {
  const el = document.getElementById("satelliteSection");
  if (obs.length === 0) {
    el.innerHTML = `<div class="empty-state">ยังไม่มีข้อมูลดาวเทียมสำหรับแปลงนี้ในช่วงรอบปลูกนี้</div>`;
    return;
  }
  const statusLabel = { flooded: "💧 ท่วม", dry: "☀️ แห้ง", uncertain: "❔ ไม่ชัดเจน" };
  el.innerHTML = obs.map((o) => `
    <div class="item-card">
      <div class="row"><span class="title">${thaiDate(o.observation_date)}</span><span class="badge status-pending">${statusLabel[o.inferred_water_status] || o.inferred_water_status}</span></div>
      <div class="detail-line muted">แหล่งข้อมูล: ${escapeHtml(o.source_provider)}${o.note ? " · " + escapeHtml(o.note) : ""}</div>
    </div>
  `).join("");
}

async function openDetail(cycleId) {
  currentCycleId = cycleId;
  const section = document.getElementById("detailSection");
  section.style.display = "block";
  section.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const data = await AgroLinkAPI.get(`/farmer/carbon/cycles/${cycleId}`);
    renderSummary(data.cycle, data.assessment);
    renderWaterLogHistory(data.water_log);
    renderSatellite(data.satellite_observations);

    const unlocked = UNLOCKED_STATUSES.includes(data.assessment.status);
    document.getElementById("waterLogForm").style.display = unlocked ? "block" : "none";
    document.getElementById("lockedNotice").style.display = unlocked ? "none" : "block";
    if (!unlocked) {
      document.getElementById("lockedNotice").textContent = data.assessment.status === "pending_review"
        ? "ข้อมูลถูกส่งตรวจแล้ว ไม่สามารถเพิ่มบันทึกได้จนกว่า Platform Ops จะตัดสิน"
        : "รอบปลูกนี้ผ่านการรับรองแล้ว ไม่สามารถแก้ไขข้อมูลย้อนหลังได้อีก";
    }
    const submitBtn = document.getElementById("submitAssessmentBtn");
    submitBtn.style.display = (unlocked && data.water_log.length > 0) ? "inline-block" : "none";
  } catch (err) {
    toast("โหลดรายละเอียดไม่สำเร็จ: " + err.message, true);
  }
}

// ---------- บันทึกระดับน้ำ ----------
document.getElementById("waterLogForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentCycleId) return;
  const btn = document.getElementById("waterLogSubmitBtn");
  btn.disabled = true;

  const waterLevelRaw = document.getElementById("waterLevelInput").value;
  const recordedAtRaw = document.getElementById("recordedAtInput").value;
  const body = {
    water_status: document.getElementById("waterStatusSelect").value,
    water_level_cm: waterLevelRaw === "" ? undefined : Number(waterLevelRaw),
    photo_url: document.getElementById("photoUrlInput").value.trim() || undefined,
    note: document.getElementById("waterNoteInput").value.trim() || undefined,
    recorded_at: recordedAtRaw ? new Date(recordedAtRaw).toISOString() : undefined,
  };

  try {
    await AgroLinkAPI.post(`/farmer/carbon/cycles/${currentCycleId}/water-log`, body);
    toast("บันทึกระดับน้ำเรียบร้อยแล้ว");
    document.getElementById("waterLogForm").reset();
    await openDetail(currentCycleId);
    await loadCycles();
  } catch (err) {
    toast("บันทึกไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- ส่งตรวจสอบ ----------
document.getElementById("submitAssessmentBtn").addEventListener("click", async () => {
  if (!currentCycleId) return;
  const btn = document.getElementById("submitAssessmentBtn");
  btn.disabled = true;
  try {
    await AgroLinkAPI.post(`/farmer/carbon/cycles/${currentCycleId}/submit`, {});
    toast("ส่งข้อมูลให้ Platform Ops ตรวจสอบเรียบร้อยแล้ว");
    await openDetail(currentCycleId);
    await loadCycles();
  } catch (err) {
    toast("ส่งไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

loadMethodology();
loadCycles();
