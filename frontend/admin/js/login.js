/**
 * Platform Ops (Admin) login — passcode-based, not claim-based (see the
 * hint text in index.html / the comment on AgroLinkAdminAPI.login() in
 * admin/js/api.js for why: no per-admin identity table in this sandbox,
 * just one shared ADMIN_PASSCODE).
 *
 * This file was missing entirely until now even though index.html has
 * always referenced it (<script src="js/login.js">) — the same class of
 * gap found and fixed for the Farmer Portal earlier in this project
 * (frontend/js/login.js / dashboard.js): a page that referenced a script
 * that was designed/wired in HTML but never actually written, leaving the
 * whole Platform Ops portal unreachable through the browser (the backend
 * endpoint POST /auth/admin-login worked fine — nothing could ever call
 * it from this page).
 */
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

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const passcode = passcodeInput.value;
  if (!passcode) return;

  hideError();
  loginBtn.disabled = true;
  try {
    await AgroLinkAdminAPI.login(passcode);
    window.location.href = "dashboard.html";
  } catch (err) {
    const messages = {
      invalid_passcode: "รหัสผ่านผู้ดูแลระบบไม่ถูกต้อง",
      passcode_required: "กรุณากรอกรหัสผ่านผู้ดูแลระบบ",
    };
    showError(messages[err.message] || "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  } finally {
    loginBtn.disabled = false;
  }
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
