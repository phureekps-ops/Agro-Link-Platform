/**
 * AgroLink Insurance Portal — DEMO login.
 *
 * Unlike the other provider portals (logistics/, buyer/, coop/, ...) this
 * portal is a frontend-only concept preview: there is no backend/src/routes
 * file, no org_type, and no database row behind it. This file intentionally
 * does NOT call any backend API — it simulates a session entirely in
 * localStorage so the rest of the dashboard can render as if logged in.
 * See frontend/insurance-portal.html for the real marketing/partner page.
 */
const AUTH_STORAGE_KEY = "agrolink_insurance_demo_session";

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

function getSession() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function setSession(orgName) {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ orgName, loginAt: Date.now() }));
}

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  hideError();
  const claim = claimInput.value.trim();
  if (!claim) {
    showError("กรุณากรอกชื่อหรือรหัสองค์กร");
    return;
  }
  loginBtn.disabled = true;
  loginBtn.textContent = "กำลังเข้าสู่ระบบ…";
  // Simulated delay so the demo feels like a real login round-trip.
  setTimeout(() => {
    setSession(claim);
    window.location.href = "dashboard.html";
  }, 450);
});

// If a demo session already exists, skip straight to the dashboard.
if (getSession()) {
  window.location.href = "dashboard.html";
}
