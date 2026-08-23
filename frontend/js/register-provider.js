/**
 * AgroLink — Service-Provider (Organization) Registration.
 *
 * Backs POST /auth/org-register. Unlike frontend/js/register.js (farmer
 * self-registration, which always lands the new farmer straight on their
 * own dashboard since a farmer's dashboard works regardless of KYC
 * status), a freshly-registered organization is NOT guaranteed anywhere
 * useful to go:
 *   - Lender / Buyer / InputSupplier / VillageFund / the five machinery
 *     org_types: DO have a dedicated portal, but that portal's own GET
 *     /.../dashboard now requires kyb_status = 'Verified' (see lender.js /
 *     buyer.js / machinery.js / inputsupplier.js / villagefund.js) — a
 *     brand-new Pending org would just hit a "kyb_not_verified" state
 *     there. We still store the session under that portal's own
 *     localStorage key and redirect to its dashboard, which renders a
 *     "your application is under review" screen rather than erroring —
 *     see lender/js/dashboard.js / buyer/js/dashboard.js /
 *     machinery/js/dashboard.js / inputsupplier/js/dashboard.js /
 *     villagefund/js/dashboard.js.
 *   - Every other org_type (Logistics) has NO dedicated portal at all yet,
 *     so there's nowhere to redirect to — this page just shows a plain
 *     success confirmation instead. ('Cooperative' and 'Mill' were removed
 *     from the self-registration dropdown entirely on 2026-07-24, so this
 *     path is effectively just 'Logistics' now — see
 *     ORG_SELF_REGISTER_TYPES in backend/src/routes/auth.js. 'VillageFund'
 *     was ADDED to the dropdown on 2026-08-17 for the Farmer 360° View
 *     feature — see FARMER_360_ARCHITECTURE.md §6.)
 */
const API_BASE = (["localhost", "127.0.0.1"].includes(window.location.hostname))
  ? "http://localhost:4000"
  : "https://agrolink-backend-vhv6.onrender.com";
// Local dev talks to the backend on localhost:4000. Any other hostname
// (i.e. once this file is served from a Render Static Site) talks to the
// deployed backend instead. Render appends a random suffix to every
// *.onrender.com URL regardless of service name (e.g. "-vhv6" here) --
// if the backend gets redeployed under a new URL, update it above to
// match exactly what's shown on the service's page in the Render
// Dashboard, not just the service name.

const errorBox = document.getElementById("errorBox");
const registerForm = document.getElementById("registerForm");
const successBox = document.getElementById("successBox");
const successDetail = document.getElementById("successDetail");
const loginDivider = document.getElementById("loginDivider");
const loginLenderLink = document.getElementById("loginLenderLink");
const loginBuyerLink = document.getElementById("loginBuyerLink");
const loginMachineryLink = document.getElementById("loginMachineryLink");
const registerBtn = document.getElementById("registerBtn");
const claimValueEl = document.getElementById("claimValue");
const copyClaimBtn = document.getElementById("copyClaimBtn");
const continueBtn = document.getElementById("continueBtn");
const backHomeLink = document.getElementById("backHomeLink");

const ORG_TYPE_LABEL = {
  Lender: "ผู้ปล่อยกู้", Buyer: "ผู้รับซื้อผลผลิต", InputSupplier: "ผู้จำหน่ายปัจจัยการผลิต",
  VillageFund: "กองทุนหมู่บ้าน",
  Logistics: "โลจิสติกส์/ขนส่งทั่วไป",
  MachineryService: "ผู้ให้บริการเครื่องจักรกล (รถไถ/โดรน/รถเกี่ยว/รถบรรทุก)",
  DryingYardService: "บริการลานตากข้าว",
};

// The role_types that share the unified "เครื่องจักรกล/ลานตาก" portal —
// see src/routes/machinery.js's MACHINERY_ORG_TYPES for the backend side of
// this same list. 'MachineryService' (2026-08-17) is the only one offered
// on the dropdown below now — the four individual entries this used to
// list were consolidated into it (see that file's comment) but stay here
// too, harmlessly unreachable via this form since ORG_TYPE_SELECT no
// longer offers them, in case a future path ever resurrects one.
const MACHINERY_ORG_TYPES = ["MachineryService", "TractorService", "DroneService", "HarvesterService", "TruckService", "DryingYardService"];

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

    // Added 2026-08-23: which portal (if any) this org_type redirects to,
    // and under which localStorage key its session is stored — same
    // mapping as before, just no longer an immediate redirect. We now
    // ALWAYS stop here and show the claim first (see successBox below);
    // the org only moves on to their dashboard once they click "ไปที่
    // แดชบอร์ดของฉัน", by which point they've had a chance to copy the
    // sub claim that is their only way back in later (see
    // src/routes/auth.js's org-register comment for why this matters).
    const PORTAL_BY_ORG_TYPE = {
      Lender: { sessionKey: "agrolink_lender_session", dashboardUrl: "lender/dashboard.html" },
      Buyer: { sessionKey: "agrolink_buyer_session", dashboardUrl: "buyer/dashboard.html" },
      InputSupplier: { sessionKey: "agrolink_inputsupplier_session", dashboardUrl: "inputsupplier/dashboard.html" },
      VillageFund: { sessionKey: "agrolink_villagefund_session", dashboardUrl: "villagefund/dashboard.html" },
    };
    const portal = PORTAL_BY_ORG_TYPE[orgType] || (MACHINERY_ORG_TYPES.includes(orgType)
      ? { sessionKey: "agrolink_machinery_session", dashboardUrl: "machinery/dashboard.html" }
      : null);

    registerForm.style.display = "none";
    loginDivider.style.display = "none";
    loginLenderLink.style.display = "none";
    loginBuyerLink.style.display = "none";
    loginMachineryLink.style.display = "none";

    successDetail.textContent = portal
      ? `"${orgName}" (${ORG_TYPE_LABEL[orgType] || orgType}) อยู่ระหว่างการตรวจสอบ (KYB) — เมื่อเจ้าหน้าที่อนุมัติแล้ว ท่านจะเห็นข้อมูลเต็มรูปแบบในแดชบอร์ด`
      : `"${orgName}" (${ORG_TYPE_LABEL[orgType] || orgType}) อยู่ระหว่างการตรวจสอบ (KYB) ` +
        "เจ้าหน้าที่ผู้ดูแลระบบจะตรวจสอบและติดต่อกลับเมื่ออนุมัติแล้ว";

    claimValueEl.textContent = body.external_subject_claim || "(ไม่พบรหัส — กรุณาติดต่อผู้ดูแลระบบ)";

    if (portal) {
      localStorage.setItem(portal.sessionKey, JSON.stringify(body));
      continueBtn.style.display = "";
      backHomeLink.style.display = "none";
      continueBtn.onclick = () => { window.location.href = portal.dashboardUrl; };
    } else {
      continueBtn.style.display = "none";
      backHomeLink.style.display = "";
    }

    successBox.style.display = "block";
  } catch (err) {
    showError("สมัครไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    registerBtn.disabled = false;
  }
});

copyClaimBtn.addEventListener("click", async () => {
  const value = claimValueEl.textContent;
  try {
    await navigator.clipboard.writeText(value);
    copyClaimBtn.textContent = "คัดลอกแล้ว!";
  } catch (err) {
    // Clipboard API can be blocked (older browser, insecure context, denied
    // permission) — the code is already visible and selectable in the box
    // above, so fall back to just telling the org to select it manually
    // rather than failing silently.
    copyClaimBtn.textContent = "คัดลอกไม่ได้ — เลือกคัดลอกเอง";
  }
  setTimeout(() => { copyClaimBtn.textContent = "คัดลอก"; }, 2500);
});
