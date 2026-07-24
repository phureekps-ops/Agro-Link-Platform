const errorBox = document.getElementById("errorBox");
const loginForm = document.getElementById("loginForm");
const claimInput = document.getElementById("claimInput");
const loginBtn = document.getElementById("loginBtn");

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
    await AgroLinkMachineryAPI.login(claim);
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

const params = new URLSearchParams(window.location.search);
if (params.get("reason") === "session_expired") {
  showError("เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง");
} else if (params.get("reason") === "not_a_machinery_org") {
  showError("บัญชีนี้ไม่ใช่บัญชีผู้ให้บริการเครื่องจักรกล/ลานตาก กรุณาเข้าสู่ระบบด้วยบัญชีที่ถูกต้อง");
}

// If already logged in, skip straight to the dashboard.
if (AgroLinkMachineryAPI.getSession()) {
  window.location.href = "dashboard.html";
}
