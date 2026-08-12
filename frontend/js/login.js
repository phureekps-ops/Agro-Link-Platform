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

/**
 * Quick-login demo accounts — mirrors the farmers seeded by
 * backend/db/dev_sample_data.sql (COPY identity.farmer ...). These three
 * are the stable, always-present demo rows (auth_subject_id
 * 'oidc|farmer-001' / '-002' / '-003'); the other seeded farmer rows use
 * randomly-generated claims from ad-hoc testing and one is 'closed', so
 * they're deliberately left out of this list.
 */
const DEMO_FARMERS = [
  { name: "สมชาย ใจดี", claim: "oidc|farmer-001" },
  { name: "สมหญิง รักนา", claim: "oidc|farmer-002" },
  { name: "ประยุทธ นาดี", claim: "oidc|farmer-003" },
];

demoGrid.innerHTML = DEMO_FARMERS.map(
  (f) => `
    <button type="button" class="demo-btn" data-claim="${f.claim}">
      <span class="name">${f.name}</span>
      <span class="claim">${f.claim}</span>
    </button>
  `
).join("");

demoGrid.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-claim]");
  if (!btn) return;
  claimInput.value = btn.dataset.claim;
  doLogin(btn.dataset.claim);
});

const params = new URLSearchParams(window.location.search);
if (params.get("reason") === "session_expired") {
  showError("เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง");
}

// If already logged in, skip straight to the dashboard.
if (AgroLinkAPI.getSession()) {
  window.location.href = "dashboard.html";
}
