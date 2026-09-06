/**
 * AgroLink — ประกาศรับซื้อด่วน (buy-campaigns.html).
 *
 * Backs GET /farmer/buy-campaigns, POST /farmer/buy-campaigns/:id/sell,
 * and GET /farmer/buy-campaigns/my-sales — see backend/src/routes/
 * farmer.js's own doc comment on this feature. Lives at the Farmer
 * Portal's top level (same folder as dashboard.html/rice-prices.html),
 * reusing its session (agrolink_farmer_session), same reasoning as
 * rice-prices.html: a farmer-only reference-and-action page, not its own
 * separate mini-app.
 *
 * Selling into a campaign here deducts from its remaining quantity
 * IMMEDIATELY (no buyer confirm step) — the buyer still has to run the
 * resulting delivery through the normal quality-confirm + settle steps
 * on their own dashboard, exactly like any other spot sale. This page
 * only locks in the price/quantity commitment; it does not itself track
 * physical handoff.
 */
const session = AgroLinkAPI.requireSessionOrRedirect();

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function thaiDate(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function thb(n) {
  return Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2 });
}

const toastEl = document.getElementById("toast");
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = "toast show" + (isError ? " error" : "");
  setTimeout(() => { toastEl.className = "toast"; }, 3200);
}

// Loaded once — this farmer's own active production units, for the "ขาย
// จากแปลงไหน" select inside each campaign card. Same source as the plot-
// registration page's own dropdown (GET /farmer/production-units).
let myUnits = [];
async function loadMyUnits() {
  try {
    myUnits = await AgroLinkAPI.get("/farmer/production-units");
  } catch (err) {
    myUnits = [];
  }
}

function unitOptions() {
  if (myUnits.length === 0) {
    return `<option value="">ยังไม่มีแปลง/หน่วยผลิตที่ลงทะเบียนไว้</option>`;
  }
  return `<option value="">-- เลือกแปลงที่จะขาย --</option>` +
    myUnits.map((u) => `<option value="${u.unit_id}">${escapeHtml(u.unit_type)} — ${escapeHtml(u.commodity_code)} (${Number(u.area_rai).toLocaleString("th-TH")} ไร่)</option>`).join("");
}

function campaignCard(c) {
  return `
    <div class="item-card" data-campaign-id="${c.campaign_id}">
      <div class="row">
        <span class="title">${escapeHtml(c.commodity_name)}</span>
        <span class="badge status-active">คงเหลือ ${thb(c.remaining_ton)} ตัน</span>
      </div>
      <div class="detail-line">ผู้รับซื้อ: ${escapeHtml(c.org_name)}</div>
      <div class="detail-line" style="font-weight:700; color:var(--green-900);">ราคา: ${thb(c.unit_price)} ${escapeHtml(c.price_unit)}</div>
      <div class="detail-line">รับซื้อไปแล้ว: ${thb(c.quantity_sold_ton)} / ${thb(c.quantity_limit_ton)} ตัน</div>
      ${c.note ? `<div class="detail-line muted">หมายเหตุจากผู้ซื้อ: ${escapeHtml(c.note)}</div>` : ""}
      <div class="detail-line muted">เปิดประกาศเมื่อ: ${thaiDate(c.created_at)}</div>

      <div class="form-grid" style="margin-top:10px;">
        <div class="field">
          <label>แปลงที่จะขาย</label>
          <select class="sell-unit-select">${unitOptions()}</select>
        </div>
        <div class="field">
          <label>จำนวนที่จะขาย (ตัน) — คงเหลือรับซื้อได้ ${thb(c.remaining_ton)} ตัน</label>
          <input type="number" class="sell-quantity-input" min="0.001" step="0.001" max="${c.remaining_ton}" placeholder="เช่น 2.5" />
        </div>
      </div>
      <button type="button" class="btn btn-primary btn-sm sell-btn" data-campaign-id="${c.campaign_id}" style="margin-top:6px;">ขายเข้าประกาศนี้ทันที</button>
    </div>
  `;
}

async function loadBuyCampaigns() {
  const el = document.getElementById("buyCampaignsSection");
  try {
    const campaigns = await AgroLinkAPI.get("/farmer/buy-campaigns");
    el.innerHTML = campaigns.length
      ? `<div class="card-list">${campaigns.map(campaignCard).join("")}</div>`
      : `<div class="empty-state">ยังไม่มีประกาศรับซื้อด่วนที่เปิดอยู่ในขณะนี้</div>`;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประกาศไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("buyCampaignsSection").addEventListener("click", async (e) => {
  const btn = e.target.closest(".sell-btn");
  if (!btn) return;

  const card = btn.closest(".item-card");
  const unitId = card.querySelector(".sell-unit-select").value;
  const quantityTon = Number(card.querySelector(".sell-quantity-input").value);

  if (!unitId) {
    toast("กรุณาเลือกแปลงที่จะขาย", true);
    return;
  }
  if (!Number.isFinite(quantityTon) || quantityTon <= 0) {
    toast("กรุณากรอกจำนวนที่มากกว่า 0", true);
    return;
  }

  const campaignId = btn.dataset.campaignId;
  btn.disabled = true;
  try {
    const result = await AgroLinkAPI.post(`/farmer/buy-campaigns/${campaignId}/sell`, {
      unit_id: unitId,
      quantity_ton: quantityTon,
    });
    toast(
      result.status === "sold_campaign_closed"
        ? "ขายสำเร็จ! ประกาศนี้รับซื้อครบจำนวนแล้วและปิดลง — รอผู้ซื้อตรวจคุณภาพและชำระเงินตามขั้นตอนปกติ"
        : "ขายสำเร็จ! รอผู้ซื้อตรวจคุณภาพและชำระเงินตามขั้นตอนปกติ",
    );
    await Promise.all([loadBuyCampaigns(), loadMySales()]);
  } catch (err) {
    const detail = err.body && (err.body.detail || err.body.error) ? (err.body.detail || err.body.error) : err.message;
    toast("ขายไม่สำเร็จ: " + detail, true);
    btn.disabled = false;
  }
});

const SALE_DELIVERY_STATUS_LABEL_TH = {
  delivered: "ส่งมอบแล้ว (รอผู้ซื้อตรวจคุณภาพ)",
  accepted: "ตรวจคุณภาพผ่านแล้ว (รอชำระเงิน)",
  rejected: "ไม่ผ่านการตรวจคุณภาพ",
  settled: "ชำระเงินแล้ว",
};
const SALE_DELIVERY_STATUS_BADGE_CLASS = {
  delivered: "status-pending",
  accepted: "status-approved",
  rejected: "status-declined",
  settled: "status-completed",
};

function mySaleCard(s) {
  const badgeClass = SALE_DELIVERY_STATUS_BADGE_CLASS[s.delivery_status] || "status-pending";
  const label = SALE_DELIVERY_STATUS_LABEL_TH[s.delivery_status] || s.delivery_status;
  return `
    <div class="item-card">
      <div class="row">
        <span class="title">${escapeHtml(s.commodity_name)} — ${escapeHtml(s.buyer_name)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(label)}</span>
      </div>
      <div class="detail-line">${thb(s.quantity_ton)} ตัน × ${thb(s.unit_price)} บาท = ${thb(s.total_amount)} บาท</div>
      <div class="detail-line muted">ขายเมื่อ: ${thaiDate(s.created_at)}${s.settled_at ? " · ชำระเงินเมื่อ " + thaiDate(s.settled_at) : ""}</div>
    </div>
  `;
}

async function loadMySales() {
  const el = document.getElementById("mySalesSection");
  try {
    const sales = await AgroLinkAPI.get("/farmer/buy-campaigns/my-sales");
    el.innerHTML = sales.length
      ? sales.map(mySaleCard).join("")
      : `<div class="empty-state">ยังไม่มีประวัติการขายเข้าประกาศรับซื้อด่วน</div>`;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดประวัติไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

async function init() {
  await loadMyUnits();
  await Promise.all([loadBuyCampaigns(), loadMySales()]);
}

init();
