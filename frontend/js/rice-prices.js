/**
 * AgroLink — เปรียบเทียบราคารับซื้อข้าวเปลือกประจำวัน (rice-prices.html).
 *
 * Backs GET /farmer/rice-prices. Reuses the Farmer Portal's own
 * AgroLinkAPI/session (agrolink_farmer_session) — this page lives at the
 * Farmer Portal's top level (same folder as dashboard.html), not its own
 * separate mini-app, since it's a farmer-only view with no login of its
 * own, just a "see what every Buyer is currently paying" reference page.
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

function gradeCard(grade) {
  if (grade.quotes.length === 0) {
    return `
      <div class="item-card">
        <div class="row"><span class="title">${escapeHtml(grade.name_th)}</span></div>
        <div class="empty-state" style="padding:16px 0;">ยังไม่มีผู้รับซื้อประกาศราคาสำหรับข้าวชนิดนี้</div>
      </div>
    `;
  }

  const rows = grade.quotes.map((q, i) => `
    <div class="detail-line" style="display:flex; justify-content:space-between; ${i === 0 ? "font-weight:700; color:var(--green-900);" : ""}">
      <span>${i === 0 ? "🏆 " : ""}${escapeHtml(q.org_name)}</span>
      <span>${Number(q.quoted_price).toLocaleString("th-TH", { minimumFractionDigits: 2 })} ${escapeHtml(q.price_unit)}</span>
    </div>
  `).join("");

  return `
    <div class="item-card">
      <div class="row"><span class="title">${escapeHtml(grade.name_th)}</span><span class="badge status-active">${grade.quotes.length} ผู้รับซื้อ</span></div>
      ${rows}
      <div class="detail-line muted" style="margin-top:6px;">อัปเดตล่าสุด: ${thaiDate(grade.quotes[0].updated_at)}</div>
    </div>
  `;
}

async function loadRicePrices() {
  const el = document.getElementById("ricePricesSection");
  try {
    const grades = await AgroLinkAPI.get("/farmer/rice-prices");
    el.innerHTML = `<div class="card-list">${grades.map(gradeCard).join("")}</div>`;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">โหลดราคารับซื้อไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
  }
}

loadRicePrices();
