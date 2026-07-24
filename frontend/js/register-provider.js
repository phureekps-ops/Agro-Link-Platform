/**
 * AgroLink — Service-Provider (Organization) Registration.
 *
 * Backs POST /auth/org-register. Unlike frontend/js/register.js (farmer
 * self-registration, which always lands the new farmer straight on their
 * own dashboard since a farmer's dashboard works regardless of KYC
 * status), a freshly-registered organization is NOT guaranteed anywhere
 * useful to go:
 *   - Lender / Buyer / InputSupplier / the five machinery org_types: DO
 *     have a dedicated portal, but that portal's own GET /.../dashboard
 *     now requires kyb_status = 'Verified' (see lender.js / buyer.js /
 *     machinery.js / inputsupplier.js) — a brand-new Pending org would
 *     just hit a "kyb_not_verified" state there. We still store the
 *     session under that portal's own localStorage key and redirect to
 *     its dashboard, which renders a "your application is under review"
 *     screen rather than erroring — see lender/js/dashboard.js /
 *     buyer/js/dashboard.js / machinery/js/dashboard.js /
 *     inputsupplier/js/dashboard.js.
 *   - Every other org_type (Logistics) has NO dedicated portal at all yet,
 *     so there's nowhere to redirect to — this page just shows a plain
 *     success confirmation instead. ('Cooperative' and 'Mill' were removed
 *     from the self-registration dropdown entirely on 2026-07-24, so this
 *     path is effectively just 'Logistics' now — see
 *     ORG_SELF_REGISTER_TYPES in backend/src/routes/auth.js.)
 */
const API_BASE = "http://localhost:4000";

const errorBox = document.getElementById("errorBox");
const registerForm = document.getElementById("registerForm");
const successBox = document.getElementById("successBox");
const successDetail = document.getElementById("successDetail");
const loginDivider = document.getElementById("loginDivider");
const loginLenderLink = document.getElementById("loginLenderLink");
const loginBuyerLink = document.getElementById("loginBuyerLink");
const loginMachineryLink = document.getElementById("loginMachineryLink");
const registerBtn = document.getElementById("registerBtn");

const ORG_TYPE_LABEL = {
  Lender: "ผู้ปล่อยกู้", Buyer: "ผู้รับซื้อผลผลิต", InputSupplier: "ผู้จำหน่ายปัจจัยการผลิต",
  Logistics: "โลจิสติกส์/ขนส่งทั่วไป",
  TractorService: "บริการรถไถ", DroneService: "บริการโดรน/ฉีดพ่นสารเคมี",
  HarvesterService: "บริการรถเกี่ยวข้าว", TruckService: "บริการรถบรรทุก",
  DryingYardService: "บริการลานตากข้าว",
};

// The five org_types that share the unified "เครื่องจักรกล/ลานตาก" portal
// — see src/routes/machinery.js's MACHINERY_ORG_TYPES for the backend side
// of this same list.
const MACHINERY_ORG_TYPES = ["TractorService", "DroneService", "HarvesterService", "TruckService", "DryingYardService"];

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

  const orgName = document.getElementById("orgNameInput").value.trim();
  const taxId = document.getElementById("taxIdInput").value.trim();
  const orgType = document.getElementById("orgTypeSelect").value;

  if (!orgName || !taxId || !orgType) {
    showError("กรุณากรอกข้อมูลให้ครบถ้วน");
    return;
  }
  if (!/^\d{13}$/.test(taxId)) {
    showError("เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก");
    return;
  }

  registerBtn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/auth/org-register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org_name: orgName, tax_id: taxId, org_type: orgType }),
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      const messages = {
        missing_required_fields: "กรุณากรอกข้อมูลให้ครบถ้วน",
        invalid_org_type: "ประเภทธุรกิจที่เลือกไม่ถูกต้อง",
        tax_id_already_registered: "เลขประจำตัวผู้เสียภาษีนี้ถูกใช้สมัครไปแล้ว",
      };
      showError(messages[body.error] || "สมัครไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
      registerBtn.disabled = false;
      return;
    }

    if (orgType === "Lender") {
      localStorage.setItem("agrolink_lender_session", JSON.stringify(body));
      window.location.href = "lender/dashboard.html";
      return;
    }
    if (orgType === "Buyer") {
      localStorage.setItem("agrolink_buyer_session", JSON.stringify(body));
      window.location.href = "buyer/dashboard.html";
      return;
    }
    if (orgType === "InputSupplier") {
      localStorage.setItem("agrolink_inputsupplier_session", JSON.stringify(body));
      window.location.href = "inputsupplier/dashboard.html";
      return;
    }
    if (MACHINERY_ORG_TYPES.includes(orgType)) {
      localStorage.setItem("agrolink_machinery_session", JSON.stringify(body));
      window.location.href = "machinery/dashboard.html";
      return;
    }

    // No dedicated portal yet for this org_type — show a plain confirmation.
    registerForm.style.display = "none";
    loginDivider.style.display = "none";
    loginLenderLink.style.display = "none";
    loginBuyerLink.style.display = "none";
    loginMachineryLink.style.display = "none";
    successDetail.textContent =
      `"${orgName}" (${ORG_TYPE_LABEL[orgType] || orgType}) อยู่ระหว่างการตรวจสอบ (KYB) ` +
      "เจ้าหน้าที่ผู้ดูแลระบบจะตรวจสอบและติดต่อกลับเมื่ออนุมัติแล้ว";
    successBox.style.display = "block";
  } catch (err) {
    showError("สมัครไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    registerBtn.disabled = false;
  }
});
