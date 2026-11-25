const errorBox = document.getElementById("errorBox");
const loginForm = document.getElementById("loginForm");
const claimInput = document.getElementById("claimInput");
const loginBtn = document.getElementById("loginBtn");
function showError(m) { errorBox.textContent = m; errorBox.classList.add("show"); }
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const claim = claimInput.value.trim();
  if (!claim) return;
  errorBox.classList.remove("show");
  loginBtn.disabled = true;
  try {
    await AgroLinkSavingsCoopAPI.login(claim);
    window.location.href = "dashboard.html";
  } catch (err) {
    showError({ unrecognized_subject_claim: "ไม่พบบัญชีที่ตรงกับรหัสยืนยันตัวตนนี้ในระบบ" }[err.message] || "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  } finally {
    loginBtn.disabled = false;
  }
});
const reason = new URLSearchParams(window.location.search).get("reason");
if (reason === "session_expired") showError("เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง");
else if (reason) showError("บัญชีนี้ไม่ใช่บัญชีสหกรณ์ออมทรัพย์ หรือสิทธิ์ของเจ้าหน้าที่ไม่ครอบคลุมพอร์ทัลนี้");
else if (AgroLinkSavingsCoopAPI.getSession()) window.location.href = "dashboard.html";
