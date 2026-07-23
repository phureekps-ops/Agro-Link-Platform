/**
 * DEMO ACCOUNTS — hardcoded for this sandbox only, mirroring
 * identity.farmer.auth_subject_id for the three farmers seeded across
 * earlier layers of this project. This list exists purely to make manual
 * testing fast; a real deployment would not ship a claim list in the
 * frontend at all — the claim would come from a real OIDC login redirect.
 */
const DEMO_FARMERS = [
  { name: "สมชาย ใจดี", claim: "oidc|farmer-001" },
  { name: "สมหญิง รักนา", claim: "oidc|farmer-002" },
  { name: "ประยุทธ นาดี", claim: "oidc|farmer-003" },
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
    await AgroLinkAPI.login(claim);
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

DEMO_FARMERS.forEach((farmer) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "demo-btn";
  btn.innerHTML = `<span class="name">${farmer.name}</span><span class="claim">${farmer.claim}</span>`;
  btn.addEventListener("click", () => doLogin(farmer.claim));
  demoGrid.appendChild(btn);
});

// If we were bounced here because a session expired, say so.
const params = new URLSearchParams(window.location.search);
if (params.get("reason") === "session_expired") {
  showError("เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง");
}

// If already logged in, skip straight to the dashboard.
if (AgroLinkAPI.getSession()) {
  window.location.href = "dashboard.html";
}
