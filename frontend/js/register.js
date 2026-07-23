const errorBox = document.getElementById("errorBox");
const registerForm = document.getElementById("registerForm");
const registerBtn = document.getElementById("registerBtn");
const regionSelect = document.getElementById("regionSelect");

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.add("show");
}
function hideError() {
  errorBox.classList.remove("show");
}

// Populate the province dropdown from the shared TH_PROVINCES list.
regionSelect.innerHTML = TH_PROVINCES.map(([code, name]) => `<option value="${code}">${name}</option>`).join("");

// Seeded farmers in the database use phone numbers in +66XXXXXXXXX form;
// normalize a locally-typed "08xxxxxxxx" the same way so new registrations
// are consistent with existing data, without forcing the user to type "+66"
// themselves.
function normalizePhone(raw) {
  const digits = raw.trim().replace(/[\s-]/g, "");
  if (digits.startsWith("0")) return "+66" + digits.slice(1);
  if (digits.startsWith("+")) return digits;
  return digits;
}

const ERROR_MESSAGES = {
  missing_required_fields: "กรุณากรอกข้อมูลให้ครบทุกช่อง",
  phone_already_registered: "เบอร์โทรศัพท์นี้มีผู้ใช้งานในระบบแล้ว",
  national_id_already_registered: "เลขบัตรประจำตัวประชาชนนี้มีผู้ใช้งานในระบบแล้ว",
};

registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();

  const fullName = document.getElementById("fullNameInput").value.trim();
  const phone = normalizePhone(document.getElementById("phoneInput").value);
  const nationalId = document.getElementById("nationalIdInput").value.trim();
  const regionCode = regionSelect.value;

  if (!fullName || !phone || !nationalId || !regionCode) {
    showError("กรุณากรอกข้อมูลให้ครบทุกช่อง");
    return;
  }
  if (!/^\d{13}$/.test(nationalId)) {
    showError("เลขบัตรประจำตัวประชาชนต้องเป็นตัวเลข 13 หลัก");
    return;
  }

  registerBtn.disabled = true;
  try {
    await AgroLinkAPI.register({ fullName, phone, nationalId, regionCode });
    // Backend auto-issues a session token on successful registration —
    // go straight to the dashboard, same as a successful login.
    window.location.href = "dashboard.html";
  } catch (err) {
    showError(ERROR_MESSAGES[err.message] || "สมัครสมาชิกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  } finally {
    registerBtn.disabled = false;
  }
});

// Already logged in? No reason to register again.
if (AgroLinkAPI.getSession()) {
  window.location.href = "dashboard.html";
}
