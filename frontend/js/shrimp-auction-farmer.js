/**
 * AgroLink — Auction Place, farmer-facing page (shrimp-auction-farmer.html).
 * Backs GET/POST /aquaculture/* (see backend/src/routes/aquaculture.js and
 * SHRIMP_AUCTION_ARCHITECTURE.md). Phase 1a scope only — see that doc's
 * section 9 for what is deliberately not built yet.
 */
const session = AgroLinkAPI.requireSessionOrRedirect();

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
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function money(n) {
  return Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2 });
}

const SPECIES_LABEL_TH = {
  SHRIMP_VANNAMEI: "กุ้งขาวแวนนาไม",
  SHRIMP_BLACKTIGER: "กุ้งกุลาดำ",
  SHRIMP_OTHER: "กุ้งอื่นๆ",
};
const AUCTION_STATUS_LABEL_TH = {
  open: "เปิดรับราคา",
  closed: "ปิดรับราคาแล้ว — รอเลือกผู้ซื้อ",
  awarded: "เลือกผู้ซื้อแล้ว — รอสุ่มตรวจไซส์จริง",
  completed: "จบรายการแล้ว",
  cancelled: "ยกเลิกแล้ว",
};
const AUCTION_STATUS_BADGE_CLASS = {
  open: "status-active",
  closed: "status-pending",
  awarded: "status-pending",
  completed: "status-approved",
  cancelled: "status-declined",
};

let pondsCache = [];

// ============================================================
// Farm profile
// ============================================================
async function loadFarmProfile() {
  const profile = await AgroLinkAPI.get("/aquaculture/farm-profile");
  if (profile) {
    document.getElementById("farmNameInput").value = profile.farm_name || "";
    document.getElementById("farmProvinceInput").value = profile.province || "";
    document.getElementById("farmDistrictInput").value = profile.district || "";
    document.getElementById("farmPhoneInput").value = profile.phone || "";
  }
}

document.getElementById("farmProfileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("farmProfileSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkAPI.post("/aquaculture/farm-profile", {
      farm_name: document.getElementById("farmNameInput").value.trim(),
      province: document.getElementById("farmProvinceInput").value.trim(),
      district: document.getElementById("farmDistrictInput").value.trim() || null,
      phone: document.getElementById("farmPhoneInput").value.trim() || null,
    });
    toast("บันทึกข้อมูลฟาร์มแล้ว");
  } catch (err) {
    toast(err.message || "บันทึกไม่สำเร็จ", true);
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// Ponds
// ============================================================
function pondCard(p) {
  return `
    <div class="item-card">
      <div class="row">
        <span class="title">${escapeHtml(SPECIES_LABEL_TH[p.commodity_code] || p.commodity_code)}</span>
        <span class="badge status-active">${escapeHtml(p.status || "active")}</span>
      </div>
      <div class="detail-line">พื้นที่ ${escapeHtml(p.area_rai)} ไร่ · รอบเลี้ยง ${escapeHtml(p.season_id)}</div>
      <div class="detail-line muted">ลงทะเบียนเมื่อ ${thaiDate(p.registration_date)}</div>
    </div>
  `;
}

async function loadPonds() {
  const ponds = await AgroLinkAPI.get("/aquaculture/ponds");
  pondsCache = ponds;
  const section = document.getElementById("pondsSection");
  section.innerHTML = ponds.length
    ? ponds.map(pondCard).join("")
    : `<div class="empty-state">ยังไม่มีบ่อที่ลงทะเบียน</div>`;

  const pondOptions = ponds.map((p) => `<option value="${p.unit_id}">${escapeHtml(SPECIES_LABEL_TH[p.commodity_code] || p.commodity_code)} — ${escapeHtml(p.area_rai)} ไร่ (${escapeHtml(p.season_id)})</option>`).join("");
  document.getElementById("samplingPondSelect").innerHTML = pondOptions || `<option value="">— ยังไม่มีบ่อ —</option>`;
  document.getElementById("auctionPondSelect").innerHTML = pondOptions || `<option value="">— ยังไม่มีบ่อ —</option>`;
  if (ponds.length) await loadSamplingOptionsForPond(ponds[0].unit_id);
}

document.getElementById("pondForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("pondSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkAPI.post("/aquaculture/ponds", {
      species: document.getElementById("pondSpeciesSelect").value,
      area_rai: Number(document.getElementById("pondAreaInput").value),
      season_id: document.getElementById("pondSeasonInput").value.trim(),
      lat: Number(document.getElementById("pondLatInput").value),
      lng: Number(document.getElementById("pondLngInput").value),
    });
    toast("เพิ่มบ่อแล้ว");
    document.getElementById("pondForm").reset();
    await loadPonds();
  } catch (err) {
    toast(err.message || "เพิ่มบ่อไม่สำเร็จ", true);
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// Pre-auction sampling
// ============================================================
function samplingPointRowHtml(n) {
  return `
    <div class="form-grid sampling-point-row" data-point="${n}" style="margin-top:8px;">
      <div class="field">
        <label>จุดที่ ${n} — จำนวนตัว</label>
        <input type="number" min="1" step="1" class="sample-count-input" required />
      </div>
      <div class="field">
        <label>จุดที่ ${n} — น้ำหนัก (กก.)</label>
        <input type="number" min="0.001" step="0.001" class="sample-weight-input" required />
      </div>
    </div>
  `;
}

function resetSamplingPointRows() {
  const container = document.getElementById("samplingPointsContainer");
  container.innerHTML = "";
  for (let i = 1; i <= 5; i += 1) container.insertAdjacentHTML("beforeend", samplingPointRowHtml(i));
}
resetSamplingPointRows();

document.getElementById("addSamplingPointBtn").addEventListener("click", () => {
  const container = document.getElementById("samplingPointsContainer");
  const n = container.querySelectorAll(".sampling-point-row").length + 1;
  container.insertAdjacentHTML("beforeend", samplingPointRowHtml(n));
});

document.getElementById("samplingPondSelect").addEventListener("change", (e) => {
  if (e.target.value) loadSamplingOptionsForPond(e.target.value);
});

async function loadSamplingOptionsForPond(unitId) {
  document.getElementById("samplingPondSelect").value = unitId;
  const events = await AgroLinkAPI.get(`/aquaculture/ponds/${unitId}/sampling`);
  const preAuction = events.filter((ev) => ev.purpose === "pre_auction");
  const resultSection = document.getElementById("samplingResultSection");
  resultSection.innerHTML = preAuction.length
    ? preAuction.map((ev) => `
        <div class="item-card">
          <div class="row">
            <span class="title">ไซส์เฉลี่ย ${Number(ev.computed_size_per_kg).toFixed(1)} ตัว/กก.</span>
            <span class="badge status-active">ความเชื่อมั่น: ${escapeHtml(ev.confidence_score)}</span>
          </div>
          <div class="detail-line muted">สุ่ม ${ev.point_count} จุด เมื่อ ${thaiDate(ev.sampled_at)}</div>
        </div>
      `).join("")
    : `<div class="empty-state">ยังไม่มีผลสุ่มก่อนประมูลของบ่อนี้</div>`;

  const auctionPondSelect = document.getElementById("auctionPondSelect");
  if (auctionPondSelect.value === unitId || !auctionPondSelect.value) {
    document.getElementById("auctionSamplingSelect").innerHTML = preAuction.length
      ? preAuction.map((ev) => `<option value="${ev.sampling_id}">${Number(ev.computed_size_per_kg).toFixed(1)} ตัว/กก. (${escapeHtml(ev.confidence_score)}) — ${thaiDate(ev.sampled_at)}</option>`).join("")
      : `<option value="">— ยังไม่มีผลสุ่ม —</option>`;
  }
}

document.getElementById("auctionPondSelect").addEventListener("change", (e) => {
  if (e.target.value) loadSamplingOptionsForPond(e.target.value);
});

document.getElementById("samplingForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const unitId = document.getElementById("samplingPondSelect").value;
  if (!unitId) return toast("กรุณาเพิ่มบ่อก่อน", true);
  const rows = Array.from(document.querySelectorAll(".sampling-point-row"));
  const points = rows.map((row) => ({
    sample_count: Number(row.querySelector(".sample-count-input").value),
    sample_weight_kg: Number(row.querySelector(".sample-weight-input").value),
  }));
  if (points.length < 5) return toast("ต้องสุ่มอย่างน้อย 5 จุด", true);

  const btn = document.getElementById("samplingSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkAPI.post(`/aquaculture/ponds/${unitId}/sampling`, { points });
    toast("บันทึกผลสุ่มแล้ว");
    resetSamplingPointRows();
    await loadSamplingOptionsForPond(unitId);
  } catch (err) {
    toast(err.message || "บันทึกผลสุ่มไม่สำเร็จ", true);
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// Open auction
// ============================================================
document.getElementById("openAuctionForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const unitId = document.getElementById("auctionPondSelect").value;
  const samplingId = document.getElementById("auctionSamplingSelect").value;
  if (!unitId || !samplingId) return toast("กรุณาเลือกบ่อและผลสุ่มก่อนประมูล", true);
  const closesAtLocal = document.getElementById("auctionClosesAtInput").value;
  if (!closesAtLocal) return toast("กรุณาระบุวัน-เวลาปิดประมูล", true);

  const btn = document.getElementById("openAuctionSubmitBtn");
  btn.disabled = true;
  try {
    await AgroLinkAPI.post("/aquaculture/auctions", {
      unit_id: unitId,
      sampling_id: samplingId,
      closes_at: new Date(closesAtLocal).toISOString(),
      product_description: document.getElementById("auctionProductDescInput").value.trim() || null,
    });
    toast("เปิดประมูลแล้ว");
    document.getElementById("openAuctionForm").reset();
    await loadMyAuctions();
  } catch (err) {
    toast(err.message || "เปิดประมูลไม่สำเร็จ", true);
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// My auctions + detail management
// ============================================================
function myAuctionCard(a) {
  const badgeClass = AUCTION_STATUS_BADGE_CLASS[a.status] || "status-pending";
  return `
    <div class="item-card">
      <div class="row">
        <span class="title">${escapeHtml(a.title)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(AUCTION_STATUS_LABEL_TH[a.status] || a.status)}</span>
      </div>
      <div class="detail-line muted">ปิดประมูล ${thaiDate(a.closes_at)} · ${a.bidder_count || 0} รายเสนอราคาแล้ว</div>
      <div class="action-row" style="margin-top:8px;">
        <button type="button" class="btn btn-outline btn-sm" data-manage-auction="${a.auction_id}">จัดการ</button>
      </div>
    </div>
  `;
}

async function loadMyAuctions() {
  const auctions = await AgroLinkAPI.get("/aquaculture/auctions/mine");
  const section = document.getElementById("myAuctionsSection");
  section.innerHTML = auctions.length
    ? auctions.map(myAuctionCard).join("")
    : `<div class="empty-state">ยังไม่มีประมูลที่เปิดไว้</div>`;
}

document.getElementById("myAuctionsSection").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-manage-auction]");
  if (btn) renderAuctionDetail(btn.getAttribute("data-manage-auction"));
});

async function renderAuctionDetail(auctionId) {
  const detail = await AgroLinkAPI.get(`/aquaculture/auctions/${auctionId}`);
  const section = document.getElementById("auctionDetailSection");
  const a = detail.auction;
  const tiersHtml = detail.tiers.map((t) => `<span class="badge status-pending" style="margin:2px;">${escapeHtml(t.tier_label)}: ${t.size_per_kg_min}-${t.size_per_kg_max} ตัว/กก.</span>`).join("");

  let actionHtml = "";
  if (a.status === "closed") {
    actionHtml = `<div id="rankedBuyersContainer"><div class="loading-line">กำลังโหลดผู้เสนอราคา…</div></div>`;
  } else if (a.status === "awarded") {
    actionHtml = `
      <form id="finalSamplingForm" style="margin-top:10px;">
        <div style="font-weight:700; margin-bottom:8px;">🎯 สุ่มตรวจไซส์จริงวันจับ (ขั้นต่ำ 5 จุด)</div>
        <div id="finalSamplingPointsContainer"></div>
        <div style="display:flex; gap:10px; margin-top:8px;">
          <button type="button" class="btn btn-outline btn-sm" id="addFinalSamplingPointBtn">+ เพิ่มจุดสุ่ม</button>
          <button type="submit" class="btn btn-primary btn-sm">บันทึกผลสุ่มจริง + คำนวณราคา</button>
        </div>
      </form>
    `;
  } else if (a.status === "completed" || a.status === "awarded") {
    // handled above / below via settlement fetch
  }

  section.innerHTML = `
    <div class="panel">
      <div class="row">
        <span class="title">${escapeHtml(a.title)}</span>
        <span class="badge ${AUCTION_STATUS_BADGE_CLASS[a.status] || "status-pending"}">${escapeHtml(AUCTION_STATUS_LABEL_TH[a.status] || a.status)}</span>
      </div>
      <div class="detail-line" style="margin:8px 0;">${tiersHtml}</div>
      <div id="auctionDetailAction">${actionHtml}</div>
      <div id="settlementContainer"></div>
    </div>
  `;

  if (a.status === "closed") {
    const bids = await AgroLinkAPI.get(`/aquaculture/auctions/${auctionId}/ranked-buyers`);
    const container = document.getElementById("rankedBuyersContainer");
    container.innerHTML = bids.length
      ? bids.map((b) => `
          <div class="item-card">
            <div class="row">
              <span class="title">${escapeHtml(b.org_name)}</span>
              <span class="badge status-active">เฉลี่ย ${money(b.avg_price)} บาท/กก.</span>
            </div>
            <div class="detail-line">${b.prices.map((p) => `${escapeHtml(p.tier_label)}: ${money(p.price)}`).join(" · ")}</div>
            <div class="action-row" style="margin-top:8px;">
              <button type="button" class="btn btn-primary btn-sm" data-select-buyer="${b.bid_id}">เลือกผู้ซื้อรายนี้</button>
            </div>
          </div>
        `).join("")
      : `<div class="empty-state">ยังไม่มีผู้เสนอราคา</div>`;

    container.querySelectorAll("[data-select-buyer]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("ยืนยันเลือกผู้ซื้อรายนี้? การเลือกไม่สามารถเปลี่ยนได้ภายหลัง")) return;
        try {
          await AgroLinkAPI.post(`/aquaculture/auctions/${auctionId}/select-buyer`, { bid_id: btn.getAttribute("data-select-buyer") });
          toast("เลือกผู้ซื้อแล้ว");
          await renderAuctionDetail(auctionId);
          await loadMyAuctions();
        } catch (err) {
          toast(err.message || "เลือกผู้ซื้อไม่สำเร็จ", true);
        }
      });
    });
  }

  if (a.status === "awarded") {
    const finalContainer = document.getElementById("finalSamplingPointsContainer");
    finalContainer.innerHTML = "";
    for (let i = 1; i <= 5; i += 1) finalContainer.insertAdjacentHTML("beforeend", samplingPointRowHtml(i).replace(/sampling-point-row/g, "final-sampling-point-row").replace(/class="sample-count-input"/g, 'class="final-sample-count-input"').replace(/class="sample-weight-input"/g, 'class="final-sample-weight-input"'));

    document.getElementById("addFinalSamplingPointBtn").addEventListener("click", () => {
      const n = finalContainer.querySelectorAll(".final-sampling-point-row").length + 1;
      finalContainer.insertAdjacentHTML("beforeend", samplingPointRowHtml(n).replace(/sampling-point-row/g, "final-sampling-point-row").replace(/class="sample-count-input"/g, 'class="final-sample-count-input"').replace(/class="sample-weight-input"/g, 'class="final-sample-weight-input"'));
    });

    document.getElementById("finalSamplingForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const rows = Array.from(document.querySelectorAll(".final-sampling-point-row"));
      const points = rows.map((row) => ({
        sample_count: Number(row.querySelector(".final-sample-count-input").value),
        sample_weight_kg: Number(row.querySelector(".final-sample-weight-input").value),
      }));
      if (points.length < 5) return toast("ต้องสุ่มอย่างน้อย 5 จุด", true);
      try {
        const result = await AgroLinkAPI.post(`/aquaculture/auctions/${auctionId}/final-sampling`, { points });
        toast(`คำนวณราคาแล้ว: ไซส์จริง ${result.matchedTierLabel} — ${money(result.settlement.tier_price)} บาท/กก.${result.settlement.requires_renegotiation ? " (ไซส์ห่างจากที่ตกลงไว้มาก แนะนำให้เจรจาราคาใหม่)" : ""}`);
        await renderAuctionDetail(auctionId);
        await loadMyAuctions();
      } catch (err) {
        toast(err.message || "บันทึกผลสุ่มจริงไม่สำเร็จ", true);
      }
    });
  }

  // Settlement view (shown once final-sampling has produced one)
  try {
    const settlement = await AgroLinkAPI.get(`/aquaculture/auctions/${auctionId}/settlement`);
    const settlementContainer = document.getElementById("settlementContainer");
    settlementContainer.innerHTML = `
      <div class="panel" style="margin-top:14px;">
        <div style="font-weight:700; margin-bottom:8px;">💰 ผลการชำระเงิน</div>
        <div class="detail-line">ไซส์จริงที่จับได้: ${escapeHtml(settlement.tier_label)} (${Number(settlement.final_size_per_kg).toFixed(1)} ตัว/กก.) — ราคา ${money(settlement.tier_price)} บาท/กก.</div>
        ${settlement.requires_renegotiation ? '<div class="detail-line" style="color:#B00;">⚠ ไซส์จริงห่างจากตารางราคาที่ตกลงไว้มาก — แนะนำให้เจรจาราคากับผู้ซื้อใหม่นอกระบบก่อนยืนยันยอด</div>' : ""}
        ${settlement.actual_weight_kg
          ? `<div class="detail-line">น้ำหนักจริงที่ชั่งได้: ${escapeHtml(settlement.actual_weight_kg)} กก. — ยอดชำระ ${money(settlement.final_amount)} บาท</div>`
          : `<form id="weightForm" style="margin-top:10px;">
               <div class="field">
                 <label for="actualWeightInput">น้ำหนักจริงที่ชั่งได้ (กก.)</label>
                 <input type="number" id="actualWeightInput" min="0.01" step="0.01" required />
               </div>
               <button type="submit" class="btn btn-primary btn-sm">บันทึกน้ำหนักจริง</button>
             </form>`
        }
        <div class="detail-line" style="margin-top:8px;">สถานะการชำระเงิน: ${settlement.payment_status === "paid" ? "✅ ยืนยันรับเงินแล้ว" : "⏳ รอยืนยันรับเงิน (ชำระนอกระบบ)"}</div>
        ${settlement.payment_status !== "paid" && settlement.final_amount
          ? '<button type="button" class="btn btn-primary btn-sm" id="confirmPaymentBtn" style="margin-top:8px;">ยืนยันว่าได้รับเงินแล้ว</button>'
          : ""
        }
      </div>
    `;

    const weightForm = document.getElementById("weightForm");
    if (weightForm) {
      weightForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await AgroLinkAPI.post(`/aquaculture/auctions/${auctionId}/settlement/weight`, {
            actual_weight_kg: Number(document.getElementById("actualWeightInput").value),
          });
          toast("บันทึกน้ำหนักจริงแล้ว");
          await renderAuctionDetail(auctionId);
        } catch (err) {
          toast(err.message || "บันทึกไม่สำเร็จ", true);
        }
      });
    }
    const confirmBtn = document.getElementById("confirmPaymentBtn");
    if (confirmBtn) {
      confirmBtn.addEventListener("click", async () => {
        if (!confirm("ยืนยันว่าท่านได้รับเงินค่ากุ้งจากผู้ซื้อแล้วจริง?")) return;
        try {
          await AgroLinkAPI.post(`/aquaculture/auctions/${auctionId}/confirm-payment`, {});
          toast("ยืนยันรับเงินแล้ว — ปิดรายการ");
          await renderAuctionDetail(auctionId);
          await loadMyAuctions();
        } catch (err) {
          toast(err.message || "ยืนยันไม่สำเร็จ", true);
        }
      });
    }
  } catch (err) {
    // no settlement yet — nothing to show, not an error the user needs to see
  }
}

// ============================================================
// Init
// ============================================================
(async function init() {
  try {
    await loadFarmProfile();
  } catch (err) { /* no profile yet */ }
  try {
    await loadPonds();
  } catch (err) {
    toast(err.message || "โหลดข้อมูลบ่อไม่สำเร็จ", true);
  }
  try {
    await loadMyAuctions();
  } catch (err) {
    toast(err.message || "โหลดประมูลไม่สำเร็จ", true);
  }
})();
