/**
 * DEMO ACCOUNT — hardcoded for this sandbox only, mirroring
 * identity.organization.auth_subject_id for the one Lender org seeded
 * across earlier layers of this project (สหกรณ์สินเชื่อเกษตรยั่งยืน จำกัด).
 * Exists purely to make manual testing fast — a production build would not
 * ship a claim list in the frontend, same note as the Farmer Portal.
 */
const DEMO_LENDERS = [
  { name: "สหกรณ์สินเชื่อเกษตรยั่งยืน จำกัด", claim: "oidc|org-001" },
];

const errorBox = document.getElementById("errorBox");
const loginForm = document.getElementById("loginForm");
const claimInput = document.getElementById("claimInput");
const loginBtn = document.getElementById("loginBtn");
const demoGrid = document.getElementById("demoGrid");

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.add("show");
}
function hideError() {
  errorBox.classList.remove("show");
}

async function doLogin(claim) {
  hideError();
  loginBtn.disabled = true;
  try {
    await AgroLinkLenderAPI.login(claim);
    window.location.href = "dashboard.html";
  } catch (err) {
    const messages = {
      external_subject_claim_required: "กรุณากรอกรหัสยืนยันตัวตน",
      unrecognized_subject_claim: "ไม่พบบัญชีที่ตรงกับรหัสยืนยันตัวตนนี้ในระบบ",
    };
    showError(messages[err.message] || "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  } finally {
    loginBtn.disabled = false;
  }
}

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const claim = claimInput.value.trim();
  if (!claim) return;
  doLogin(claim);
});

DEMO_LENDERS.forEach((org) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "demo-btn";
  btn.innerHTML = `<span class="name">${org.name}</span><span class="claim">${org.claim}</span>`;
  btn.addEventListener("click", () => doLogin(org.claim));
  demoGrid.appendChild(btn);
});

const params = new URLSearchParams(window.location.search);
if (params.get("reason") === "session_expired") {
  showError("เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง");
} else if (params.get("reason") === "not_a_lender") {
  showError("บัญชีนี้ไม่ใช่บัญชีผู้ปล่อยกู้ กรุณาเข้าสู่ระบบด้วยบัญชีองค์กรผู้ปล่อยกู้");
}

// If already logged in, skip straight to the dashboard.
if (AgroLinkLenderAPI.getSession()) {
  window.location.href = "dashboard.html";
}
