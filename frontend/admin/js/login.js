const errorBox = document.getElementById("errorBox");
const loginForm = document.getElementById("loginForm");
const passcodeInput = document.getElementById("passcodeInput");
const loginBtn = document.getElementById("loginBtn");

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.add("show");
}
function hideError() {
  errorBox.classList.remove("show");
}

async function doLogin(passcode) {
  hideError();
  loginBtn.disabled = true;
  try {
    await AgroLinkAdminAPI.login(passcode);
    window.location.href = "dashboard.html";
  } catch (err) {
    const messages = {
      passcode_required: "กรุณากรอกรหัสผ่านผู้ดูแลระบบ",
      invalid_passcode: "รหัสผ่านไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง",
    };
    showError(messages[err.message] || "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  } finally {
    loginBtn.disabled = false;
  }
}

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const passcode = passcodeInput.value.trim();
  if (!passcode) return;
  doLogin(passcode);
});

const params = new URLSearchParams(window.location.search);
if (params.get("reason") === "session_expired") {
  showError("เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง");
} else if (params.get("reason") === "not_an_admin") {
  showError("บัญชีนี้ไม่ใช่บัญชีผู้ดูแลระบบ กรุณาเข้าสู่ระบบด้วยรหัสผ่านผู้ดูแลระบบ");
}

// If already logged in, skip straight to the dashboard.
if (AgroLinkAdminAPI.getSession()) {
  window.location.href = "dashboard.html";
}
