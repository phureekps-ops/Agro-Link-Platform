/**
 * AgroLink — Auction Place, buyer-facing page (shrimp-auction.html).
 * Backs GET/POST /aquaculture/* (see backend/src/routes/aquaculture.js and
 * SHRIMP_AUCTION_ARCHITECTURE.md). Phase 1a scope only.
 */
const session = AgroLinkBuyerAPI.requireSessionOrRedirect();

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

const STATUS_LABEL_TH = {
  open: "เปิดรับราคา",
  closed: "ปิดรับราคาแล้ว",
  awarded: "มีผู้ชนะแล้ว",
  completed: "จบรายการแล้ว",
  cancelled: "ยกเลิกแล้ว",
};
const STATUS_BADGE_CLASS = {
  open: "status-active",
  closed: "status-pending",
  awarded: "status-pending",
  completed: "status-approved",
  cancelled: "status-declined",
};
const TIER_STATUS_ICON = { Winning: "🟢", Tied: "🟡", Losing: "🔴" };

function openAuctionCard(a) {
  return `
    <div class="item-card">
      <div class="row">
        <span class="title">${escapeHtml(a.title)}</span>
        <span class="badge status-active">${escapeHtml(a.province || "-")}</span>
      </div>
      <div class="detail-line">${escapeHtml(a.farm_name || "ฟาร์มไม่ระบุชื่อ")} · ไซส์เป้าหมายประมาณ ${a.target_size_per_kg ? Number(a.target_size_per_kg).toFixed(1) : "-"} ตัว/กก. (ความเชื่อมั่น: ${escapeHtml(a.sampling_confidence || "-")})</div>
      <div class="detail-line muted">ปิดรับราคา ${thaiDate(a.closes_at)} · ${a.bidder_count || 0} รายเสนอราคาแล้ว</div>
      <div class="action-row" style="margin-top:8px;">
        <button type="button" class="btn btn-primary btn-sm" data-view-auction="${a.auction_id}">ดู/เสนอราคา</button>
      </div>
    </div>
  `;
}

async function loadOpenAuctions() {
  const auctions = await AgroLinkBuyerAPI.get("/aquaculture/auctions?status=open");
  const section = document.getElementById("openAuctionsSection");
  section.innerHTML = auctions.length
    ? auctions.map(openAuctionCard).join("")
    : `<div class="empty-state">ยังไม่มีประมูลกุ้งที่เปิดอยู่ตอนนี้</div>`;
  section.querySelectorAll("[data-view-auction]").forEach((btn) => {
    btn.addEventListener("click", () => renderAuctionDetail(btn.getAttribute("data-view-auction")));
  });
}

function myAuctionCard(a) {
  const badgeClass = STATUS_BADGE_CLASS[a.status] || "status-pending";
  return `
    <div class="item-card">
      <div class="row">
        <span class="title">${escapeHtml(a.title)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(STATUS_LABEL_TH[a.status] || a.status)}${a.is_winner ? " · คุณเป็นผู้ชนะ" : ""}</span>
      </div>
      <div class="detail-line muted">ปิดรับราคา ${thaiDate(a.closes_at)}</div>
      <div class="action-row" style="margin-top:8px;">
        <button type="button" class="btn btn-outline btn-sm" data-view-auction="${a.auction_id}">ดูรายละเอียด</button>
      </div>
    </div>
  `;
}

async function loadMyAuctions() {
  const auctions = await AgroLinkBuyerAPI.get("/aquaculture/auctions/mine");
  const section = document.getElementById("myAuctionsSection");
  section.innerHTML = auctions.length
    ? auctions.map(myAuctionCard).join("")
    : `<div class="empty-state">ยังไม่เคยเสนอราคาประมูลกุ้ง</div>`;
  section.querySelectorAll("[data-view-auction]").forEach((btn) => {
    btn.addEventListener("click", () => renderAuctionDetail(btn.getAttribute("data-view-auction")));
  });
}

async function renderAuctionDetail(auctionId) {
  const detail = await AgroLinkBuyerAPI.get(`/aquaculture/auctions/${auctionId}`);
  const section = document.getElementById("auctionDetailSection");
  const a = detail.auction;

  const tierInputsHtml = detail.tiers.map((t) => {
    const existing = detail.myBid ? detail.myBid.prices[t.tier_id] : "";
    return `
      <div class="field">
        <label for="tierPrice_${t.tier_id}">${escapeHtml(t.tier_label)} (${t.size_per_kg_min}-${t.size_per_kg_max} ตัว/กก.)</label>
        <input type="number" min="0.01" step="0.01" id="tierPrice_${t.tier_id}" data-tier-id="${t.tier_id}" value="${existing || ""}" ${a.status === "open" ? "required" : "disabled"} />
      </div>
    `;
  }).join("");

  section.innerHTML = `
    <div class="panel">
      <div class="row">
        <span class="title">${escapeHtml(a.title)}</span>
        <span class="badge ${STATUS_BADGE_CLASS[a.status] || "status-pending"}">${escapeHtml(STATUS_LABEL_TH[a.status] || a.status)}</span>
      </div>
      <div class="detail-line">${escapeHtml(a.farm_name || "-")} · ${escapeHtml(a.province || "-")} ${escapeHtml(a.district || "")}</div>
      ${detail.preSampling ? `<div class="detail-line muted">ไซส์เป้าหมายก่อนประมูล: ${Number(detail.preSampling.computed_size_per_kg).toFixed(1)} ตัว/กก. (ความเชื่อมั่น ${escapeHtml(detail.preSampling.confidence_score)}, สุ่ม ${detail.preSampling.point_count} จุด)</div>` : ""}
      <form id="bidForm" class="form-grid" style="margin-top:14px;">
        ${tierInputsHtml}
      </form>
      ${a.status === "open" ? '<button type="button" class="btn btn-primary btn-sm" id="submitBidBtn" style="margin-top:10px;">ส่งราคาประมูล</button>' : ""}
      <div id="tierStatusRow" style="margin-top:10px;"></div>
    </div>
  `;

  const submitBtn = document.getElementById("submitBidBtn");
  if (submitBtn) {
    submitBtn.addEventListener("click", async () => {
      const inputs = Array.from(document.querySelectorAll("[data-tier-id]"));
      const prices = {};
      for (const input of inputs) {
        const v = Number(input.value);
        if (!Number.isFinite(v) || v <= 0) return toast("กรุณากรอกราคาให้ครบทุกไซส์", true);
        prices[input.getAttribute("data-tier-id")] = v;
      }
      submitBtn.disabled = true;
      try {
        const result = await AgroLinkBuyerAPI.post(`/aquaculture/auctions/${auctionId}/bids`, { prices });
        toast("ส่งราคาประมูลแล้ว");
        const statusRow = document.getElementById("tierStatusRow");
        statusRow.innerHTML = result.tierStatus.map((s) => `<span class="badge status-pending" style="margin:2px;">${TIER_STATUS_ICON[s.status] || ""} ${escapeHtml(s.status)}</span>`).join("");
        await loadMyAuctions();
      } catch (err) {
        toast(err.message || "ส่งราคาไม่สำเร็จ", true);
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  // If this org won, show the settlement once one exists.
  try {
    const settlement = await AgroLinkBuyerAPI.get(`/aquaculture/auctions/${auctionId}/settlement`);
    const settlementHtml = `
      <div class="panel" style="margin-top:14px;">
        <div style="font-weight:700; margin-bottom:8px;">💰 ผลการชำระเงิน</div>
        <div class="detail-line">ไซส์จริงที่จับได้: ${escapeHtml(settlement.tier_label)} (${Number(settlement.final_size_per_kg).toFixed(1)} ตัว/กก.) — ราคา ${money(settlement.tier_price)} บาท/กก.</div>
        ${settlement.actual_weight_kg ? `<div class="detail-line">น้ำหนักจริง: ${escapeHtml(settlement.actual_weight_kg)} กก. — ยอดชำระ ${money(settlement.final_amount)} บาท</div>` : '<div class="detail-line muted">รอฟาร์มบันทึกน้ำหนักจริง</div>'}
        <div class="detail-line" style="margin-top:6px;">สถานะการชำระเงิน: ${settlement.payment_status === "paid" ? "✅ ฟาร์มยืนยันรับเงินแล้ว" : "⏳ รอชำระ (ชำระตรงกับฟาร์มนอกระบบ)"}</div>
      </div>
    `;
    section.insertAdjacentHTML("beforeend", settlementHtml);
  } catch (err) {
    // no settlement yet
  }
}

(async function init() {
  try {
    await loadOpenAuctions();
  } catch (err) {
    toast(err.message || "โหลดประมูลไม่สำเร็จ", true);
  }
  try {
    await loadMyAuctions();
  } catch (err) {
    toast(err.message || "โหลดประมูลของฉันไม่สำเร็จ", true);
  }
})();
