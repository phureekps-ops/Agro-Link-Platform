// ============================================================
// Sidebar navigation — same "UI-only show/hide" pattern as coop/js/
// dashboard.js's showCoopPage(). The 4 business-role tabs (loans/
// machinery/inputs/buyer) each hold a plain <iframe data-src="..."> that
// only gets its real `src` set the FIRST time that tab is opened, so a
// visit to "ภาพรวมองค์กร" alone never loads all 4 embedded portals.
// ============================================================
const HUB_PAGE_BREADCRUMB_TH = {
  overview: "ภาพรวมองค์กร",
  loans: "สินเชื่อ",
  machinery: "บริการเครื่องจักรกล",
  inputs: "ขายปัจจัยการผลิต",
  buyer: "รับซื้อผลผลิต",
  "group-order": "รวมออเดอร์ซื้อสินค้าเกษตร",
};

function showHubPage(pageKey) {
  document.querySelectorAll("[data-page-content]").forEach((el) => {
    el.style.display = el.dataset.pageContent === pageKey ? "" : "none";
  });
  document.querySelectorAll("[data-page]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === pageKey);
  });
  const crumb = document.getElementById("hubBreadcrumbCurrent");
  if (crumb) crumb.textContent = HUB_PAGE_BREADCRUMB_TH[pageKey] || pageKey;

  // Lazy-load the embedded portal iframe for this tab, if it has one.
  const activeContent = document.querySelector(`[data-page-content="${pageKey}"]`);
  const iframe = activeContent ? activeContent.querySelector("iframe[data-src]") : null;
  if (iframe && !iframe.getAttribute("src")) {
    iframe.setAttribute("src", iframe.dataset.src);
    // Best-effort auto-height once the embedded (same-origin) page loads,
    // so it doesn't sit inside its own separate inner scrollbar.
    iframe.addEventListener("load", () => {
      try {
        const doc = iframe.contentWindow.document;
        const height = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
        if (height > 0) iframe.style.height = `${height + 24}px`;
      } catch (e) {
        // Cross-origin or not-yet-ready — the CSS min-height fallback covers this.
      }
    });
  }

  window.scrollTo(0, 0);
}

document.querySelectorAll("[data-page]").forEach((btn) => {
  btn.addEventListener("click", () => showHubPage(btn.dataset.page));
});

const toastEl = document.getElementById("toast");
function toast(message, isError = false) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.toggle("error", !!isError);
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 3200);
}

const ROLE_LABEL_TH = {
  Lender: "สินเชื่อ",
  MachineryService: "บริการเครื่องจักรกล",
  InputSupplier: "ขายปัจจัยการผลิต",
  Buyer: "รับซื้อผลผลิต",
};
const ROLE_STATUS_LABEL_TH = { Verified: "เปิดใช้งานแล้ว", Pending: "รอการตรวจสอบ", Rejected: "ถูกปฏิเสธ" };
const KYB_STATUS_LABEL_TH = { Verified: "ผ่านการตรวจสอบแล้ว", Pending: "อยู่ระหว่างการตรวจสอบ (KYB)", Rejected: "ถูกปฏิเสธ" };

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

async function loadOverview() {
  const entitySection = document.getElementById("entityStatusSection");
  const roleSection = document.getElementById("roleStatusSection");
  try {
    const data = await AgroLinkCommunityEnterpriseAPI.get("/organization/roles");
    document.getElementById("orgName").textContent = data.org_name || "องค์กร";

    const kybLabel = KYB_STATUS_LABEL_TH[data.entity_kyb_status] || data.entity_kyb_status;
    entitySection.innerHTML = `
      <div class="row">
        <span class="title">${escapeHtml(data.org_name)}</span>
        <span class="hub-role-badge ${escapeHtml(data.entity_kyb_status)}">${escapeHtml(kybLabel)}</span>
      </div>
      ${data.entity_kyb_status !== "Verified"
        ? `<div class="detail-line">เมื่อเจ้าหน้าที่อนุมัติการตรวจสอบธุรกิจ (KYB) แล้ว ทั้ง 4 บทบาททางธุรกิจด้านล่างจะเปิดใช้งานให้ทันทีในคลิกเดียว</div>`
        : ""}
    `;

    const roleTypes = ["Lender", "MachineryService", "InputSupplier", "Buyer"];
    const heldByType = {};
    (data.roles || []).forEach((r) => { heldByType[r.role_type] = r; });

    roleSection.innerHTML = roleTypes.map((roleType) => {
      const held = heldByType[roleType];
      const status = held ? held.status : "Pending";
      const statusLabel = ROLE_STATUS_LABEL_TH[status] || status;
      return `
        <div class="hub-role-card">
          <div class="name">${escapeHtml(ROLE_LABEL_TH[roleType] || roleType)}</div>
          <span class="hub-role-badge ${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>
        </div>
      `;
    }).join("");
  } catch (err) {
    entitySection.innerHTML = `<div class="detail-line">โหลดสถานะองค์กรไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    roleSection.innerHTML = "";
  }
}

document.getElementById("logoutBtn").addEventListener("click", () => {
  AgroLinkCommunityEnterpriseAPI.logout();
});

(function init() {
  if (!AgroLinkCommunityEnterpriseAPI.requireSessionOrRedirect()) return;
  loadOverview();
})();
