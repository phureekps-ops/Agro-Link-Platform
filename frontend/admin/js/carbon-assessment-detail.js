const session = AgroLinkAdminAPI.requireSessionOrRedirect();

const toastEl = document.getElementById("toast");
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = "toast show" + (isError ? " error" : "");
  setTimeout(() => { toastEl.className = "toast"; }, 3200);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  draft: "ร่าง", pending_review: "รอตรวจสอบ", verified: "ผ่านการตรวจสอบแล้ว", rejected: "ถูกปฏิเสธ",
};

const params = new URLSearchParams(window.location.search);
const assessmentId = params.get("id");
if (!assessmentId) {
  document.getElementById("summaryPanel").innerHTML = `<div class="empty-state">ไม่พบรหัสรายการที่ต้องการดู (?id=...)</div>`;
  throw new Error("missing_id");
}

async function load() {
  try {
    const data = await AgroLinkAdminAPI.get(`/admin/carbon/assessments/${assessmentId}`);
    const a = data.assessment;

    document.getElementById("summaryPanel").innerHTML = `
      <div class="row"><span class="title">${escapeHtml(a.farmer_name)} — ${escapeHtml(a.commodity_code)}</span>
        <span class="badge ${a.status === "verified" ? "status-active" : a.status === "rejected" ? "status-declined" : "status-pending"}">${escapeHtml(ASSESSMENT_STATUS_LABEL[a.status] || a.status)}</span></div>
      <div class="detail-line">โทร ${escapeHtml(a.farmer_phone || "-")} · พื้นที่ ${escapeHtml(a.area_rai)} ไร่ · ปลูก ${thaiDate(a.planned_start_date)} ถึง ${thaiDate(a.planned_harvest_date)}</div>
      <div class="detail-line">รอบแห้งที่ผ่านเกณฑ์: <strong>${a.qualifying_dry_events}</strong>/${a.min_dry_events_required} รอบ (รวม ${a.total_dry_days} วัน) · ${a.is_eligible ? "✅ เข้าเกณฑ์" : "ยังไม่เข้าเกณฑ์"}</div>
      <div class="detail-line">ประเมินคาร์บอนเครดิต: <strong>${a.estimated_credit_tco2e}</strong> tCO2e (${escapeHtml(a.methodology_ref)}, ${a.emission_factor_tco2e_per_rai} tCO2e/ไร่)</div>
      <div class="detail-line muted">ส่งตรวจเมื่อ ${thaiDateTime(a.submitted_at)}</div>
      ${a.review_note ? `<div class="detail-line" style="margin-top:8px;"><strong>หมายเหตุการตรวจสอบก่อนหน้า:</strong> ${escapeHtml(a.review_note)}</div>` : ""}
    `;

    const logsEl = document.getElementById("waterLogSection");
    logsEl.innerHTML = data.water_log.length === 0
      ? `<div class="empty-state">ไม่มีข้อมูล</div>`
      : data.water_log.map((l) => `
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

    const satEl = document.getElementById("satelliteSection");
    const statusLabel = { flooded: "💧 ท่วม", dry: "☀️ แห้ง", uncertain: "❔ ไม่ชัดเจน" };
    satEl.innerHTML = data.satellite_observations.length === 0
      ? `<div class="empty-state">ยังไม่มีข้อมูลดาวเทียมสำหรับแปลงนี้ในช่วงรอบปลูกนี้</div>`
      : data.satellite_observations.map((o) => `
        <div class="item-card">
          <div class="row"><span class="title">${thaiDate(o.observation_date)}</span><span class="badge status-pending">${statusLabel[o.inferred_water_status] || o.inferred_water_status}</span></div>
          <div class="detail-line muted">แหล่งข้อมูล: ${escapeHtml(o.source_provider)}${o.note ? " · " + escapeHtml(o.note) : ""}</div>
        </div>
      `).join("");

    const actionPanel = document.getElementById("actionPanel");
    actionPanel.style.display = a.status === "pending_review" ? "block" : "none";
  } catch (err) {
    document.getElementById("summaryPanel").innerHTML = `<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("verifyBtn").addEventListener("click", async () => {
  const btn = document.getElementById("verifyBtn");
  btn.disabled = true;
  try {
    await AgroLinkAdminAPI.post(`/admin/carbon/assessments/${assessmentId}/verify`, {
      review_note: document.getElementById("reviewNoteInput").value.trim() || undefined,
    });
    toast("รับรองข้อมูลเรียบร้อยแล้ว");
    await load();
  } catch (err) {
    toast("ดำเนินการไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("rejectBtn").addEventListener("click", async () => {
  const note = document.getElementById("reviewNoteInput").value.trim();
  if (!note) {
    toast("กรุณากรอกหมายเหตุก่อนปฏิเสธ", true);
    return;
  }
  const btn = document.getElementById("rejectBtn");
  btn.disabled = true;
  try {
    await AgroLinkAdminAPI.post(`/admin/carbon/assessments/${assessmentId}/reject`, { review_note: note });
    toast("ปฏิเสธข้อมูลเรียบร้อยแล้ว");
    await load();
  } catch (err) {
    toast("ดำเนินการไม่สำเร็จ: " + (err.body && err.body.error ? err.body.error : err.message), true);
  } finally {
    btn.disabled = false;
  }
});

load();
