const errorBox = document.getElementById("errorBox");
const registerForm = document.getElementById("registerForm");
const fullNameInput = document.getElementById("fullNameInput");
const phoneInput = document.getElementById("phoneInput");
const nationalIdInput = document.getElementById("nationalIdInput");
const regionSelect = document.getElementById("regionSelect");
const registerBtn = document.getElementById("registerBtn");

// Same province list/lookup used by the venue-marketplace and org
// registration forms — see js/provinces.js.
regionSelect.innerHTML =
  `<option value="">-- เลือกจังหวัด --</option>` +
  TH_PROVINCES.map(([code, name]) => `<option value="${code}">${name}</option>`).join("");

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.add("show");
}
function hideError() {
  errorBox.classList.remove("show");
}

registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();

  const fullName = fullNameInput.value.trim();
  const phone = phoneInput.value.trim();
  const nationalId = nationalIdInput.value.trim();
  const regionCode = regionSelect.value;

  if (!fullName || !phone || !nationalId || !regionCode) {
    showError("กรุณากรอกข้อมูลให้ครบถ้วน");
    return;
  }
  if (!/^\d{13}$/.test(nationalId)) {
    showError("เลขประจำตัวประชาชนต้องเป็นตัวเลข 13 หลัก");
    return;
  }

  registerBtn.disabled = true;
  try {
    // Backend auto-issues a session token on success (same shape as login)
    // and stores it via AgroLinkAPI.register() itself — see js/api.js.
    await AgroLinkAPI.register({ fullName, phone, nationalId, regionCode });
    window.location.href = "dashboard.html";
  } catch (err) {
    const messages = {
      missing_required_fields: "กรุณากรอกข้อมูลให้ครบถ้วน",
      phone_already_registered: "เบอร์โทรศัพท์นี้ถูกใช้สมัครสมาชิกไปแล้ว",
      national_id_already_registered: "เลขประจำตัวประชาชนนี้ถูกใช้สมัครสมาชิกไปแล้ว",
      subject_claim_collision: "เกิดข้อผิดพลาดในการสมัครสมาชิก กรุณาลองใหม่อีกครั้ง",
    };
    showError(messages[err.message] || "สมัครสมาชิกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    registerBtn.disabled = false;
  }
});

// If already logged in, skip straight to the dashboard.
if (AgroLinkAPI.getSession()) {
  window.location.href = "dashboard.html";
}
