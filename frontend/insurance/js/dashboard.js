/**
 * AgroLink Insurance Portal — DEMO dashboard.
 *
 * This whole portal is a frontend-only concept preview (see insurance/js/login.js
 * and frontend/insurance-portal.html). There is no backend/src/routes/insurance.js,
 * no insurance org_type, and no policies/claims tables anywhere in the real
 * database — those domains do not exist yet in AgroLink's schema. Every figure
 * rendered below comes from the MOCK_* constants in this file, loaded with a
 * short artificial delay so the page feels the same as the real, backend-wired
 * portals (logistics/, buyer/, coop/, ...). Nothing here calls fetch().
 */
const AUTH_STORAGE_KEY = "agrolink_insurance_demo_session";

function getSession() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

const session = getSession();
if (!session) {
  window.location.href = "index.html";
}

document.getElementById("orgName").textContent = session.orgName || "บริษัทประกันภัย (ตัวอย่าง)";
document.getElementById("logoutBtn").addEventListener("click", () => {
  localStorage.removeItem(AUTH_STORAGE_KEY);
  window.location.href = "index.html";
});

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
const toastEl = document.getElementById("toast");
let toastTimer = null;
function showToast(message, isError) {
  toastEl.textContent = message;
  toastEl.classList.toggle("error", !!isError);
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

// ---------------------------------------------------------------------------
// Sidebar page switching (same UI-only pattern as logistics/dashboard.html)
// ---------------------------------------------------------------------------
const navItems = document.querySelectorAll(".insurance-nav-item[data-page]");
const pages = document.querySelectorAll(".insurance-page[data-page-content]");
const breadcrumbCurrent = document.getElementById("insuranceBreadcrumbCurrent");
const pageLabels = {
  overview: "ภาพรวม",
  policies: "กรมธรรม์",
  claims: "คำร้องขอสินไหมทดแทน",
  risk: "ข้อมูลแปลงและความเสี่ยง",
  cooperatives: "สหกรณ์คู่สัญญา",
  api: "การเชื่อมต่อระบบ (API)",
};
navItems.forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.page;
    navItems.forEach((b) => b.classList.toggle("active", b === btn));
    pages.forEach((p) => {
      p.style.display = p.dataset.pageContent === target ? "" : "none";
    });
    breadcrumbCurrent.textContent = pageLabels[target] || target;
  });
});

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------
const MOCK_SUMMARY = [
  { label: "สหกรณ์คู่สัญญา", value: "12 แห่ง", sub: "+2 แห่งในไตรมาสนี้" },
  { label: "เกษตรกรในเครือข่าย", value: "1,480 ราย", sub: "ครอบคลุมพื้นที่ปลูกข้าว ~9,340 ไร่" },
  { label: "กรมธรรม์ที่ใช้งานอยู่", value: "612 ฉบับ", sub: "เบี้ยประกันสะสม ~3.68 ล้านบาท" },
  { label: "คำร้องสินไหมที่รอดำเนินการ", value: "8 รายการ", sub: "อยู่ระหว่างตรวจสอบข้อมูลดาวเทียม" },
];

const MOCK_POLICIES = [
  { no: "AGL-INS-2026-00412", coop: "สหกรณ์การเกษตรบางระกำ จำกัด", crop: "ข้าวนาปี 6 ไร่", status: "active", premium: "2,400 บาท", coverage: "60,000 บาท" },
  { no: "AGL-INS-2026-00413", coop: "สหกรณ์การเกษตรบางระกำ จำกัด", crop: "ข้าวนาปี 9 ไร่", status: "active", premium: "3,600 บาท", coverage: "90,000 บาท" },
  { no: "AGL-INS-2026-00418", coop: "สหกรณ์การเกษตรพรหมพิราม จำกัด", crop: "ข้าวนาปรัง 4 ไร่", status: "pending", premium: "1,600 บาท", coverage: "40,000 บาท" },
  { no: "AGL-INS-2026-00421", coop: "สหกรณ์การเกษตรเมืองพิษณุโลก จำกัด", crop: "ข้าวนาปี 11 ไร่", status: "active", premium: "4,400 บาท", coverage: "110,000 บาท" },
  { no: "AGL-INS-2025-00287", coop: "สหกรณ์การเกษตรวังทอง จำกัด", crop: "ข้าวนาปี 5 ไร่", status: "expired", premium: "2,000 บาท", coverage: "50,000 บาท" },
  { no: "AGL-INS-2026-00430", coop: "สหกรณ์การเกษตรบางกระทุ่ม จำกัด", crop: "ข้าวนาปรัง 7 ไร่", status: "pending", premium: "2,800 บาท", coverage: "70,000 บาท" },
];

const POLICY_STATUS_LABEL = { active: "ใช้งานอยู่", pending: "รออนุมัติ", expired: "หมดอายุ" };
const POLICY_STATUS_BADGE = { active: "status-active", pending: "status-pending", expired: "status-declined" };

const MOCK_CLAIMS = [
  { no: "CLM-2026-0091", policy: "AGL-INS-2026-00412", who: "นายสมชาย ใจดี (สหกรณ์บางระกำ)", date: "12 ต.ค. 2569", status: "manual_review", amount: "18,500 บาท", reason: "น้ำท่วมแปลงนา" },
  { no: "CLM-2026-0090", policy: "AGL-INS-2026-00421", who: "นางสาวพรทิพย์ แสงจันทร์ (สหกรณ์เมืองพิษณุโลก)", date: "9 ต.ค. 2569", status: "approved", amount: "32,000 บาท", reason: "ภัยแล้งต่อเนื่อง" },
  { no: "CLM-2026-0088", policy: "AGL-INS-2026-00413", who: "นายประยุทธ์ ทองดี (สหกรณ์บางระกำ)", date: "3 ต.ค. 2569", status: "pending", amount: "9,800 บาท", reason: "ศัตรูพืชระบาด" },
  { no: "CLM-2026-0082", policy: "AGL-INS-2025-00287", who: "นางมาลี ศรีสุข (สหกรณ์วังทอง)", date: "28 ก.ย. 2569", status: "declined", amount: "—", reason: "พ้นระยะเวลาคุ้มครอง" },
];

const CLAIM_STATUS_LABEL = {
  pending: "รอดำเนินการ",
  manual_review: "ตรวจสอบข้อมูลดาวเทียม",
  approved: "อนุมัติแล้ว",
  declined: "ไม่อนุมัติ",
};
const CLAIM_STATUS_BADGE = {
  pending: "status-pending",
  manual_review: "status-manual_review",
  approved: "status-approved",
  declined: "status-declined",
};

const MOCK_RISK = [
  {
    area: "สหกรณ์การเกษตรบางระกำ จำกัด — ต.บางระกำ จ.พิษณุโลก",
    factors: [
      { label: "ปริมาณน้ำฝนเทียบค่าเฉลี่ย 10 ปี", pct: 72 },
      { label: "ดัชนีความชื้นในดิน (จากภาพถ่ายดาวเทียม)", pct: 64 },
      { label: "ความเสี่ยงภัยแล้งสะสม (AI Risk Score)", pct: 38 },
    ],
  },
  {
    area: "สหกรณ์การเกษตรพรหมพิราม จำกัด — ต.พรหมพิราม จ.พิษณุโลก",
    factors: [
      { label: "ปริมาณน้ำฝนเทียบค่าเฉลี่ย 10 ปี", pct: 54 },
      { label: "ดัชนีความชื้นในดิน (จากภาพถ่ายดาวเทียม)", pct: 47 },
      { label: "ความเสี่ยงภัยแล้งสะสม (AI Risk Score)", pct: 61 },
    ],
  },
  {
    area: "สหกรณ์การเกษตรวังทอง จำกัด — ต.วังทอง จ.พิษณุโลก",
    factors: [
      { label: "ปริมาณน้ำฝนเทียบค่าเฉลี่ย 10 ปี", pct: 81 },
      { label: "ดัชนีความชื้นในดิน (จากภาพถ่ายดาวเทียม)", pct: 70 },
      { label: "ความเสี่ยงภัยแล้งสะสม (AI Risk Score)", pct: 24 },
    ],
  },
];

const MOCK_COOPS = [
  { name: "สหกรณ์การเกษตรบางระกำ จำกัด", province: "พิษณุโลก", farmers: 240, policies: 118, contact: "คุณสมหญิง (ผู้จัดการสหกรณ์)" },
  { name: "สหกรณ์การเกษตรพรหมพิราม จำกัด", province: "พิษณุโลก", farmers: 185, policies: 76, contact: "คุณวิชัย (ผู้จัดการสหกรณ์)" },
  { name: "สหกรณ์การเกษตรเมืองพิษณุโลก จำกัด", province: "พิษณุโลก", farmers: 310, policies: 154, contact: "คุณอรุณี (ผู้จัดการสหกรณ์)" },
  { name: "สหกรณ์การเกษตรวังทอง จำกัด", province: "พิษณุโลก", farmers: 162, policies: 69, contact: "คุณสุชาติ (ผู้จัดการสหกรณ์)" },
  { name: "สหกรณ์การเกษตรบางกระทุ่ม จำกัด", province: "พิษณุโลก", farmers: 141, policies: 58, contact: "คุณนภา (ผู้จัดการสหกรณ์)" },
];

const MOCK_API_KEY = "sk_demo_insurance_7f2a9c4e8b1d4f3a9c2e7b6d1a8f3c5e";

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renderSummary() {
  await delay(280);
  const el = document.getElementById("summarySection");
  el.innerHTML = MOCK_SUMMARY.map(
    (s) => `
    <div class="stat-card">
      <div class="label">${s.label}</div>
      <div class="value">${s.value}</div>
      <div class="sub">${s.sub}</div>
    </div>`
  ).join("");

  await delay(120);
  const pilot = document.getElementById("pilotPanel");
  pilot.innerHTML = `
    <div class="row" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
      <strong>AgroLink Digital Agricultural Insurance Pilot</strong>
      <span class="badge status-pending">กำลังดำเนินการ</span>
    </div>
    <div class="detail-line" style="color:var(--gray-700); font-size:13.5px;">
      เริ่มจาก 10 สหกรณ์การเกษตรและเกษตรกรผู้ปลูกข้าวประมาณ 1,000 ราย — ปัจจุบันอยู่ระหว่างเชื่อมต่อข้อมูลสหกรณ์และข้อมูลแปลง
      ดูรายละเอียดโครงการทั้งหมดได้ที่หน้า
      <a href="../agri-insurance-ecosystem.html" style="color:var(--green-700); font-weight:600;">ระบบนิเวศประกันภัยเกษตร (Agri-Insurance Ecosystem)</a>
    </div>
  `;
}

function policyCard(p) {
  return `
    <div class="item-card" data-status="${p.status}">
      <div class="row">
        <span class="title">${p.no}</span>
        <span class="badge ${POLICY_STATUS_BADGE[p.status]}">${POLICY_STATUS_LABEL[p.status]}</span>
      </div>
      <div class="detail-line">${p.coop}</div>
      <div class="detail-line">${p.crop}</div>
      <div class="detail-line muted">เบี้ยประกัน ${p.premium} · ความคุ้มครอง ${p.coverage}</div>
    </div>`;
}

async function renderPolicies(filter) {
  await delay(220);
  const el = document.getElementById("policiesSection");
  const list = MOCK_POLICIES.filter((p) => !filter || p.status === filter);
  el.innerHTML = list.length
    ? list.map(policyCard).join("")
    : `<div class="empty-state">ไม่พบกรมธรรม์ที่ตรงกับเงื่อนไขที่เลือก</div>`;
}

function claimCard(c) {
  return `
    <div class="item-card">
      <div class="row">
        <span class="title">${c.no}</span>
        <span class="badge ${CLAIM_STATUS_BADGE[c.status]}">${CLAIM_STATUS_LABEL[c.status]}</span>
      </div>
      <div class="detail-line">กรมธรรม์เลขที่ ${c.policy}</div>
      <div class="detail-line">${c.who}</div>
      <div class="detail-line">สาเหตุ: ${c.reason}</div>
      <div class="detail-line muted">แจ้งเมื่อ ${c.date} · จำนวนเงินเคลม ${c.amount}</div>
    </div>`;
}

async function renderClaims() {
  await delay(220);
  const el = document.getElementById("claimsSection");
  el.innerHTML = MOCK_CLAIMS.map(claimCard).join("");
}

function riskCard(r) {
  const bars = r.factors
    .map(
      (f) => `
      <div class="factor-row">
        <div class="factor-label"><span>${f.label}</span><span>${f.pct}%</span></div>
        <div class="factor-bar-track"><div class="factor-bar-fill" style="width:${f.pct}%;"></div></div>
      </div>`
    )
    .join("");
  return `
    <div class="item-card" style="grid-column: span 1; min-width: 300px;">
      <div class="title" style="margin-bottom:10px;">${r.area}</div>
      ${bars}
    </div>`;
}

async function renderRisk() {
  await delay(260);
  const el = document.getElementById("riskSection");
  el.innerHTML = MOCK_RISK.map(riskCard).join("");
}

function coopCard(c) {
  return `
    <div class="item-card">
      <div class="row">
        <span class="title">${c.name}</span>
      </div>
      <div class="detail-line">จังหวัด${c.province}</div>
      <div class="detail-line">เกษตรกรที่เข้าร่วม ${c.farmers} ราย · กรมธรรม์ที่ขายผ่านสหกรณ์นี้ ${c.policies} ฉบับ</div>
      <div class="detail-line muted">ผู้ประสานงาน: ${c.contact}</div>
    </div>`;
}

async function renderCooperatives() {
  await delay(220);
  const el = document.getElementById("cooperativesSection");
  el.innerHTML = MOCK_COOPS.map(coopCard).join("");
}

// ---------------------------------------------------------------------------
// Policies filter
// ---------------------------------------------------------------------------
document.getElementById("policyStatusFilter").addEventListener("change", (e) => {
  renderPolicies(e.target.value);
});

// ---------------------------------------------------------------------------
// API key reveal / copy
// ---------------------------------------------------------------------------
const apiKeyText = document.getElementById("apiKeyText");
const apiKeyToggleBtn = document.getElementById("apiKeyToggleBtn");
let apiKeyVisible = false;
apiKeyToggleBtn.addEventListener("click", () => {
  apiKeyVisible = !apiKeyVisible;
  apiKeyText.textContent = apiKeyVisible ? MOCK_API_KEY : "•".repeat(34);
  apiKeyToggleBtn.textContent = apiKeyVisible ? "ซ่อน" : "แสดง";
});
document.getElementById("apiKeyCopyBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(MOCK_API_KEY);
    showToast("คัดลอก API Key แล้ว");
  } catch (e) {
    showToast("ไม่สามารถคัดลอกได้ กรุณาคัดลอกด้วยตนเอง", true);
  }
});

// ---------------------------------------------------------------------------
// Initial load
// ---------------------------------------------------------------------------
renderSummary();
renderPolicies("");
renderClaims();
renderRisk();
renderCooperatives();
