window.AGROLINK_I18N = Object.assign(window.AGROLINK_I18N || {}, {
  "carbon-module-guide_nav_1": {
    "th": "แนวคิดคาร์บอนเครดิต",
    "en": "Carbon Credit Concepts"
  },
  "carbon-module-guide_1": {
    "th": " เอกสารทางเทคนิค · สำหรับทีมงาน",
    "en": " Technical Documentation · For Internal Teams"
  },
  "carbon-module-guide_2": {
    "th": "กลไกการทำงานของ Carbon Module",
    "en": "How the Carbon Module Works"
  },
  "carbon-module-guide_3": {
    "th": "อธิบายว่าโมดูลคาร์บอนเครดิตของ AgroLink ทำงานจริงอย่างไร ตั้งแต่เกษตรกรบันทึกระดับน้ำในนา ไปจนถึงเงินที่ได้จากการขายคาร์บอนเครดิตถูกแบ่งกลับไปหาสมาชิกแต่ละคน — ครอบคลุมทั้ง 3 เฟสที่พัฒนาไว้แล้วในระบบจริง (ไม่ใช่แนวคิดการตลาด แต่เป็นกลไกจริงในโค้ด)",
    "en": "Explains how AgroLink's Carbon Credit module actually works in practice — from farmers recording field water levels to the payouts from carbon credit sales being distributed back to individual members — covering all three phases already built into the live system (not a marketing concept, but the actual mechanism in the code)"
  },
  "carbon-module-guide_4": {
    "th": "สารบัญ",
    "en": "Table of Contents"
  },
  "carbon-module-guide_5": {
    "th": "ภาพรวม 3 เฟส",
    "en": "Overview of the 3 Phases"
  },
  "carbon-module-guide_6": {
    "th": "เส้นทางข้อมูลแบบเต็ม (End-to-End)",
    "en": "Full End-to-End Data Flow"
  },
  "carbon-module-guide_7": {
    "th": "เฟส 1 — การประเมิน AWD ระดับเกษตรกร",
    "en": "Phase 1 — Farmer-Level AWD Assessment"
  },
  "carbon-module-guide_8": {
    "th": "เฟส 2 — การรวมกลุ่มระดับองค์กร + ห้องเก็บเอกสาร MRV",
    "en": "Phase 2 — Organization-Level Aggregation + MRV Data Room"
  },
  "carbon-module-guide_9": {
    "th": "เฟส 3 — ตลาดกลางและกลไกแบ่งรายได้",
    "en": "Phase 3 — Marketplace and Revenue-Sharing Mechanism"
  },
  "carbon-module-guide_10": {
    "th": "ใครทำอะไรที่ไหน",
    "en": "Who Does What, Where"
  },
  "carbon-module-guide_11": {
    "th": "ตารางข้อมูลหลัก (สำหรับทีมพัฒนา)",
    "en": "Core Data Tables (For the Development Team)"
  },
  "carbon-module-guide_12": {
    "th": "ข้อจำกัดและสิ่งที่ต้องระวัง",
    "en": "Limitations and Important Caveats"
  },
  "carbon-module-guide_13": {
    "th": "ภาพรวม 3 เฟส",
    "en": "Overview of the 3 Phases"
  },
  "carbon-module-guide_14": {
    "th": "Carbon Module ของ AgroLink พัฒนาเป็น 3 เฟสต่อเนื่องกัน แต่ละเฟสเพิ่ม \"ชั้น\" ใหม่บนของเดิมโดยไม่แก้ไขของเดิม:",
    "en": "AgroLink's Carbon Module was built in 3 sequential phases. Each phase adds a new \"layer\" on top of the previous one without modifying what came before:"
  },
  "carbon-module-guide_15": {
    "th": "เฟส 1 — MRV ระดับเกษตรกรรายเดียว:",
    "en": "Phase 1 — Individual Farmer-Level MRV:"
  },
  "carbon-module-guide_16": {
    "th": " เกษตรกรบันทึกระดับน้ำในนาแบบเปียกสลับแห้ง (AWD) ต่อรอบปลูก ระบบคำนวณประมาณการเครดิตอัตโนมัติ แล้ว Platform Ops ตรวจสอบ/รับรอง",
    "en": " Farmers record Alternate Wetting and Drying (AWD) field water levels for each growing cycle. The system automatically calculates an estimated credit, and Platform Ops then reviews and verifies it."
  },
  "carbon-module-guide_17": {
    "th": "เฟส 2 — การรวมกลุ่มระดับองค์กร:",
    "en": "Phase 2 — Organization-Level Aggregation:"
  },
  "carbon-module-guide_18": {
    "th": " สหกรณ์ / วิสาหกิจชุมชนด้านการเกษตร / กองทุนหมู่บ้าน รวบรวมผลที่รับรองแล้วของสมาชิกหลายคนเข้าเป็น \"โครงการคาร์บอน\" เดียว พร้อมห้องเก็บเอกสารหลักฐาน (MRV Data Room) เพื่อเตรียมยื่นขึ้นทะเบียนจริง",
    "en": " A Cooperative / Agricultural Community Enterprise / Village Fund consolidates the verified results of multiple members into a single \"carbon project,\" together with an evidence repository (MRV Data Room), in preparation for actual registration."
  },
  "carbon-module-guide_19": {
    "th": "เฟส 3 — ตลาดกลางและแบ่งรายได้:",
    "en": "Phase 3 — Marketplace and Revenue Sharing:"
  },
  "carbon-module-guide_20": {
    "th": " เมื่อโครงการขึ้นทะเบียนแล้ว องค์กรลงขายเครดิตในตลาด ผู้ซื้อ (Buyer) ยื่นคำสั่งซื้อ Platform Ops จับคู่ด้วยมือ ระบบคำนวณและแบ่งรายได้กลับไปหาองค์กรและเกษตรกรแต่ละคนโดยอัตโนมัติ",
    "en": " Once a project is registered, the organization lists credits for sale on the marketplace. Buyers submit purchase orders, Platform Ops matches them manually, and the system automatically calculates and distributes revenue back to the organization and each individual farmer."
  },
  "carbon-module-guide_21": {
    "th": "สิ่งที่ต้องเข้าใจให้ตรงกันตั้งแต่ต้น:",
    "en": "One thing to be clear on from the outset:"
  },
  "carbon-module-guide_22": {
    "th": " ทั้ง 3 เฟสนี้คือเครื่องมือ ",
    "en": " all three phases are "
  },
  "carbon-module-guide_23": {
    "th": "MRV และประเมินผลภายในแพลตฟอร์มเท่านั้น",
    "en": "MRV and internal assessment tools within the platform only"
  },
  "carbon-module-guide_24": {
    "th": " ไม่ใช่การขึ้นทะเบียนคาร์บอนเครดิตจริงกับหน่วยงานใด การจะได้เครดิตที่ซื้อขายได้จริงต้องยื่นเรื่องแยกต่างหากกับผู้รับรอง (เช่น อบก./TGO ภายใต้โครงการ T-VER) ซึ่งมีขั้นตอน baseline/project boundary/leakage/third-party validation ที่ซับซ้อนกว่านี้ ดูรายละเอียดเพิ่มเติมที่ ",
    "en": " this is not actual registration of carbon credits with any external body. Obtaining credits that can genuinely be traded requires a separate application to an accredited verifier (such as Thailand's TGO under the T-VER program), which involves a more complex process covering baseline setting, project boundaries, leakage, and third-party validation. See more details on the "
  },
  "carbon-module-guide_25": {
    "th": "หน้าแนวคิดคาร์บอนเครดิต",
    "en": "Carbon Credit Concepts page"
  },
  "carbon-module-guide_26": {
    "th": " ภาพรวมกระบวนการ",
    "en": " Process Overview"
  },
  "carbon-module-guide_27": {
    "th": "เส้นทางข้อมูลแบบเต็ม (End-to-End)",
    "en": "Full End-to-End Data Flow"
  },
  "carbon-module-guide_28": {
    "th": "ไล่ตามลำดับตั้งแต่เกษตรกรบันทึกข้อมูลจริง ไปจนถึงเงินเข้าบัญชี",
    "en": "Following the sequence from the farmer's actual data entry all the way through to money reaching the account"
  },
  "carbon-module-guide_29": {
    "th": "เกษตรกรบันทึกระดับน้ำในนาต่อรอบปลูก",
    "en": "Farmer records field water level for each growing cycle"
  },
  "carbon-module-guide_30": {
    "th": "ทุกครั้งที่ไปดูนา บันทึกว่าน้ำ \"ท่วม\" หรือ \"แห้ง\" (และระดับน้ำเป็น ซม. ถ้ามีท่อวัด) ผ่านหน้า carbon-credit.html — ข้อมูลนี้เป็น append-only แก้ไขย้อนหลังไม่ได้",
    "en": "Every time the farmer checks the field, they record whether the water is \"flooded\" or \"dry\" (and the water level in cm, if a measuring tube is available) through the carbon-credit.html page. This data is append-only and cannot be edited retroactively."
  },
  "carbon-module-guide_31": {
    "th": "เกษตรกร · frontend/carbon-credit.html",
    "en": "Farmer · frontend/carbon-credit.html"
  },
  "carbon-module-guide_32": {
    "th": "ระบบคำนวณ \"ร่างประเมิน\" ใหม่ทุกครั้งที่มีข้อมูลเพิ่ม",
    "en": "System recalculates the \"draft assessment\" every time new data is added"
  },
  "carbon-module-guide_33": {
    "th": "ไล่ดูบันทึกทั้งหมดตามลำดับเวลา จัดกลุ่มช่วงที่ \"แห้งตามเกณฑ์ AWD\" ต่อเนื่องกันเป็น \"รอบแห้ง\" นับว่ารอบปลูกนี้เข้าเกณฑ์หรือไม่ ตามจำนวนรอบแห้งที่ผ่านเกณฑ์",
    "en": "Walks through all records in chronological order, grouping consecutive periods that meet the \"AWD dry criteria\" into \"dry cycles,\" and determines whether this growing cycle qualifies based on the number of dry cycles that meet the threshold"
  },
  "carbon-module-guide_34": {
    "th": "อัตโนมัติ · backend/src/routes/carbon.js: recomputeAssessment()",
    "en": "Automatic · backend/src/routes/carbon.js: recomputeAssessment()"
  },
  "carbon-module-guide_35": {
    "th": "เกษตรกรส่งร่างประเมินเข้าคิวตรวจสอบ",
    "en": "Farmer submits draft assessment for review"
  },
  "carbon-module-guide_36": {
    "th": "เมื่อพอใจกับข้อมูลแล้ว กด \"ส่งตรวจ\" — สถานะเปลี่ยนจาก draft เป็น pending_review และ \"ล็อก\" ไม่ให้แก้ไขข้อมูลต่อจนกว่าจะมีผลตรวจ",
    "en": "Once satisfied with the data, the farmer clicks \"Submit for Review\" — the status changes from draft to pending_review and the record is \"locked,\" preventing further edits until a review decision is made"
  },
  "carbon-module-guide_37": {
    "th": "เกษตรกร · POST /farmer/carbon/cycles/:id/submit",
    "en": "Farmer · POST /farmer/carbon/cycles/:id/submit"
  },
  "carbon-module-guide_38": {
    "th": "Platform Ops ตรวจสอบและตัดสิน",
    "en": "Platform Ops reviews and decides"
  },
  "carbon-module-guide_39": {
    "th": "ดูบันทึกระดับน้ำทั้งหมด + ข้อมูลดาวเทียมเสริม (ถ้ามี) แล้วกด \"รับรอง\" (verified — ล็อกถาวร) หรือ \"ตีกลับ\" (rejected — พร้อมเหตุผล เกษตรกรแก้ไขแล้วส่งใหม่ได้)",
    "en": "Reviews all water-level records plus supplementary satellite data (if available), then clicks either \"Verify\" (verified — permanently locked) or \"Reject\" (rejected — with a reason; the farmer can then revise and resubmit)"
  },
  "carbon-module-guide_40": {
    "th": "Platform Ops · หน้าแอดมิน \"คาร์บอนเครดิต (AWD)\"",
    "en": "Platform Ops · Admin page \"Carbon Credit (AWD)\""
  },
  "carbon-module-guide_41": {
    "th": "องค์กรรวบรวมผลที่รับรองแล้วเข้าโครงการ",
    "en": "Organization aggregates verified results into a project"
  },
  "carbon-module-guide_42": {
    "th": "สหกรณ์/วิสาหกิจชุมชน/กองทุนหมู่บ้าน สร้าง \"โครงการคาร์บอน\" แล้วเลือกเฉพาะรอบปลูกของสมาชิกที่มีสถานะ verified แล้วเท่านั้นเข้าร่วม — 1 รอบปลูกอยู่ในโครงการที่กำลังใช้งานได้ทีละ 1 โครงการ",
    "en": "A Cooperative/Community Enterprise/Village Fund creates a \"carbon project\" and selects only member growing cycles that already have verified status to participate — one growing cycle can belong to only one active project at a time"
  },
  "carbon-module-guide_43": {
    "th": "สหกรณ์/วิสาหกิจชุมชน/กองทุนหมู่บ้าน · widget \"Carbon Module\"",
    "en": "Cooperative/Community Enterprise/Village Fund · \"Carbon Module\" widget"
  },
  "carbon-module-guide_44": {
    "th": "แนบหลักฐาน MRV และส่งออกชุดเอกสาร",
    "en": "Attach MRV evidence and export the documentation package"
  },
  "carbon-module-guide_45": {
    "th": "แนบภาพถ่าย/ภาพดาวเทียม/ขอบเขตแปลง (GIS)/เอกสารรับรอง เข้าโครงการ แล้วส่งออก manifest รวมทุกอย่างเพื่อนำไปยื่นกับผู้ตรวจสอบ (VVB) หรือ อบก./TGO ด้วยตนเองนอกระบบ",
    "en": "Attach photos, satellite imagery, plot boundaries (GIS), and certification documents to the project, then export a manifest that bundles everything together, for manual submission to a validation/verification body (VVB) or Thailand's TGO outside the system"
  },
  "carbon-module-guide_46": {
    "th": "สหกรณ์/วิสาหกิจชุมชน/กองทุนหมู่บ้าน · MRV Data Room",
    "en": "Cooperative/Community Enterprise/Village Fund · MRV Data Room"
  },
  "carbon-module-guide_47": {
    "th": "อัปเดตสถานะโครงการตามความคืบหน้าจริงนอกระบบ",
    "en": "Update project status to reflect actual real-world progress"
  },
  "carbon-module-guide_48": {
    "th": "องค์กรปรับสถานะโครงการเอง: draft → mrv_prep → submitted_to_tver → registered → credits_issued ตามความคืบหน้าจริงกับหน่วยงานภายนอก (ระบบไม่เชื่อมต่อกับ อบก./TGO โดยตรง)",
    "en": "The organization manually advances the project status: draft → mrv_prep → submitted_to_tver → registered → credits_issued, in line with actual progress with external bodies (the system has no direct integration with TGO)"
  },
  "carbon-module-guide_49": {
    "th": "สหกรณ์/วิสาหกิจชุมชน/กองทุนหมู่บ้าน",
    "en": "Cooperative/Community Enterprise/Village Fund"
  },
  "carbon-module-guide_50": {
    "th": "องค์กรลงขายเครดิต ผู้ซื้อยื่นคำสั่งซื้อ",
    "en": "Organization lists credits for sale; buyer submits a purchase order"
  },
  "carbon-module-guide_51": {
    "th": "เมื่อโครงการถึงสถานะ registered/credits_issued แล้วเท่านั้น จึงลงขาย (ระบุจำนวนตันคาร์บอนไดออกไซด์เทียบเท่า + ราคาที่ต้องการ) — ฝั่งผู้ซื้อสร้างคำสั่งซื้อคู่ขนาน (จำนวนที่ต้องการ + ราคาที่เสนอ) โดยยังไม่เห็นรายชื่อผู้ขายรายใดโดยตรง",
    "en": "Only once a project reaches registered/credits_issued status can it be listed for sale (specifying the quantity in tonnes of CO2 equivalent and the desired price). On the buyer side, a parallel purchase order is created (desired quantity + offered price), without the buyer seeing any seller's identity directly"
  },
  "carbon-module-guide_52": {
    "th": "ผู้ขาย: สหกรณ์ฯ · ผู้ซื้อ: พอร์ทัลผู้รับซื้อผลผลิตและชีวมวล (แท็บคาร์บอนเครดิต)",
    "en": "Seller: Cooperative, etc. · Buyer: Produce & Biomass Buyer Portal (Carbon Credit tab)"
  },
  "carbon-module-guide_53": {
    "th": "Platform Ops จับคู่ด้วยมือ ระบบคำนวณแบ่งรายได้อัตโนมัติ",
    "en": "Platform Ops matches manually; the system calculates the revenue split automatically"
  },
  "carbon-module-guide_54": {
    "th": "เลือกคำสั่งซื้อ 1 รายการจับคู่กับประกาศขาย 1 รายการ (ขายเต็มจำนวนเสมอ ไม่รองรับขายบางส่วน) กรอกต้นทุนโครงการ (ถ้ามี) แล้วระบบคำนวณส่วนแบ่งของทุกฝ่ายทันที ไม่ให้เจ้าหน้าที่กรอกตัวเลขเอง",
    "en": "Select one purchase order to match with one sale listing (always a full-quantity sale; partial sales are not supported). Enter the project cost, if any, and the system immediately calculates every party's share — staff never enter the split figures manually"
  },
  "carbon-module-guide_55": {
    "th": "Platform Ops · หน้าแอดมิน \"ตลาดคาร์บอนเครดิต\"",
    "en": "Platform Ops · Admin page \"Carbon Credit Marketplace\""
  },
  "carbon-module-guide_56": {
    "th": "องค์กรจ่ายเงินจริงนอกระบบ แล้วกดยืนยันในระบบ",
    "en": "Organization makes the actual payment outside the system, then confirms it in the system"
  },
  "carbon-module-guide_57": {
    "th": "ระบบยังไม่มีช่องทางโอนเงินจริง — องค์กรโอนเงินให้เกษตรกรแต่ละคนผ่านช่องทางเดิมที่มีอยู่ (พร้อมเพย์/โอนธนาคาร) เอง แล้วกลับมากด \"จ่ายแล้ว\" เพื่อเป็นหลักฐานตรวจสอบย้อนหลังเท่านั้น",
    "en": "The system does not yet have a real money-transfer channel. The organization transfers payment to each farmer itself through existing channels (PromptPay / bank transfer), then returns to click \"Paid\" purely to create an auditable record"
  },
  "carbon-module-guide_58": {
    "th": "สหกรณ์/วิสาหกิจชุมชน/กองทุนหมู่บ้าน",
    "en": "Cooperative/Community Enterprise/Village Fund"
  },
  "carbon-module-guide_59": {
    "th": " เฟส 1",
    "en": " Phase 1"
  },
  "carbon-module-guide_60": {
    "th": "การประเมิน AWD ระดับเกษตรกร",
    "en": "Farmer-Level AWD Assessment"
  },
  "carbon-module-guide_61": {
    "th": "เครื่องมือ MRV (Measurement, Reporting, Verification) ระดับรอบปลูกเดียว — จุดเริ่มต้นของทั้งโมดูล",
    "en": "A single-growing-cycle MRV (Measurement, Reporting, Verification) tool — the starting point of the entire module"
  },
  "carbon-module-guide_62": {
    "th": "ใช้ได้เฉพาะรอบปลูกที่เป็นข้าว (รหัสสินค้าขึ้นต้นด้วย ",
    "en": "Available only for rice-growing cycles (product codes beginning with "
  },
  "carbon-module-guide_63": {
    "th": ") เนื่องจากเทคนิคเปียกสลับแห้งเป็นเทคนิคเฉพาะนาข้าวที่มีการขังน้ำเท่านั้น ค่าคงที่ทั้งหมดที่ใช้คำนวณเก็บไว้ใน ",
    "en": ") since Alternate Wetting and Drying is a technique specific to flooded rice paddies only. All constants used in the calculation are stored in "
  },
  "carbon-module-guide_64": {
    "th": " และ Platform Ops ปรับได้โดยไม่กระทบผลประเมินเก่าที่คำนวณไปแล้ว (เก็บเป็นเวอร์ชัน ไม่ใช่การแก้ไขทับ):",
    "en": " and can be adjusted by Platform Ops without affecting previously calculated assessments (stored as versions, never overwritten):"
  },
  "carbon-module-guide_65": {
    "th": "📏 ค่าตั้งต้นของวิธีคำนวณ (ปรับได้)",
    "en": "📏 Default Calculation Parameters (Adjustable)"
  },
  "carbon-module-guide_66": {
    "th": "อัตราเครดิตต่อไร่:",
    "en": "Credit rate per rai:"
  },
  "carbon-module-guide_67": {
    "th": " 0.0800 tCO₂e ต่อไร่ ต่อ 1 รอบปลูกที่ผ่านเกณฑ์",
    "en": " 0.0800 tCO₂e per rai, per qualifying growing cycle"
  },
  "carbon-module-guide_68": {
    "th": "จำนวนรอบแห้งขั้นต่ำที่ต้องมี:",
    "en": "Minimum number of dry cycles required:"
  },
  "carbon-module-guide_69": {
    "th": " อย่างน้อย 3 รอบต่อฤดูปลูก",
    "en": " At least 3 cycles per growing season"
  },
  "carbon-module-guide_70": {
    "th": "ความยาวขั้นต่ำของ 1 รอบแห้ง:",
    "en": "Minimum length of one dry cycle:"
  },
  "carbon-module-guide_71": {
    "th": " อย่างน้อย 7 วันติดต่อกัน",
    "en": " At least 7 consecutive days"
  },
  "carbon-module-guide_72": {
    "th": "ระดับน้ำที่ถือว่า \"แห้งตามเกณฑ์\":",
    "en": "Water level counted as \"dry per criteria\":"
  },
  "carbon-module-guide_73": {
    "th": " ต่ำกว่าผิวดินอย่างน้อย 15 ซม.",
    "en": " At least 15 cm below the soil surface"
  },
  "carbon-module-guide_74": {
    "th": "🌾 กติกาการนับ \"รอบแห้ง\" ที่ผ่านเกณฑ์",
    "en": "🌾 Rules for Counting a Qualifying \"Dry Cycle\""
  },
  "carbon-module-guide_75": {
    "th": "ไล่บันทึกระดับน้ำตามลำดับเวลา นับว่า \"แห้งตามเกณฑ์\" เมื่อสถานะเป็น \"แห้ง\" และ (ระดับน้ำลดลงถึงเกณฑ์ หรือไม่ได้กรอกระดับน้ำเป็น ซม. ก็เชื่อตามสถานะที่รายงาน)",
    "en": "Water-level records are walked through in chronological order. A record counts as \"dry per criteria\" when the status is \"dry\" and either the recorded level has dropped to the threshold, or no cm level was entered, in which case the reported status is taken at face value"
  },
  "carbon-module-guide_76": {
    "th": "รวมบันทึกที่ต่อเนื่องกันเป็น \"รอบ\" หนึ่งรอบ นับว่าผ่านเกณฑ์ก็ต่อเมื่อช่วงเวลาของรอบนั้นยาวไม่น้อยกว่าเกณฑ์ขั้นต่ำ",
    "en": "Consecutive qualifying records are combined into a single \"cycle.\" A cycle counts as qualifying only when its duration is no shorter than the minimum threshold"
  },
  "carbon-module-guide_77": {
    "th": "เข้าเกณฑ์ทั้งรอบปลูกก็ต่อเมื่อมีรอบแห้งที่ผ่านเกณฑ์สะสมครบตามจำนวนขั้นต่ำ — ",
    "en": "The entire growing cycle qualifies only once the cumulative number of qualifying dry cycles reaches the required minimum — "
  },
  "carbon-module-guide_78": {
    "th": "ได้หรือไม่ได้เต็มจำนวนเท่านั้น ไม่มีเครดิตบางส่วน",
    "en": "it's all-or-nothing; there is no partial credit"
  },
  "carbon-module-guide_79": {
    "th": "สูตรคำนวณเครดิตประมาณการ",
    "en": "Estimated Credit Calculation Formula"
  },
  "carbon-module-guide_80": {
    "th": "// คำนวณใหม่ทุกครั้งที่มีการบันทึกระดับน้ำเพิ่ม จนกว่าจะถูกส่งตรวจ",
    "en": "// Recalculated every time a new water-level record is added, until submitted for review"
  },
  "carbon-module-guide_81": {
    "th": "is_eligible = (จำนวนรอบแห้งที่ผ่านเกณฑ์ ",
    "en": "is_eligible = (number of qualifying dry cycles "
  },
  "carbon-module-guide_82": {
    "th": " พื้นที่แปลง (ไร่) ",
    "en": " plot area (rai) "
  },
  "carbon-module-guide_83": {
    "th": " อัตราเครดิตต่อไร่",
    "en": " credit rate per rai"
  },
  "carbon-module-guide_84": {
    "th": "สถานะของ 1 รอบปลูก (carbon.awd_cycle_assessment)",
    "en": "Status of a Single Growing Cycle (carbon.awd_cycle_assessment)"
  },
  "carbon-module-guide_85": {
    "th": "draft (แก้ไขใหม่)",
    "en": "draft (editable)"
  },
  "carbon-module-guide_86": {
    "th": "ข้อมูลดาวเทียมเป็นข้อมูลเสริม ไม่ใช่แหล่งหลัก:",
    "en": "Satellite data is supplementary, not the primary source:"
  },
  "carbon-module-guide_87": {
    "th": " เพราะระบบยังไม่มีบัญชี/API ผู้ให้บริการภาพถ่ายดาวเทียมจริง (Sentinel Hub / Google Earth Engine / GISTDA ฯลฯ) วันนี้ Platform Ops จึงป้อนข้อมูลดาวเทียมเข้าเองด้วยมือ (",
    "en": " because the system does not yet have an account or API with an actual satellite imagery provider (Sentinel Hub / Google Earth Engine / GISTDA, etc.). Today, Platform Ops enters satellite data manually ("
  },
  "carbon-module-guide_88": {
    "th": ") เพื่อใช้ประกอบการพิจารณาตอนตรวจสอบเท่านั้น ไม่ได้ใช้ในสูตรคำนวณเครดิตโดยตรง\n    ",
    "en": ") purely as supporting context during review — it is not used directly in the credit calculation formula.\n    "
  },
  "carbon-module-guide_89": {
    "th": " เฟส 2",
    "en": " Phase 2"
  },
  "carbon-module-guide_90": {
    "th": "การรวมกลุ่มระดับองค์กร + ห้องเก็บเอกสาร MRV",
    "en": "Organization-Level Aggregation + MRV Data Room"
  },
  "carbon-module-guide_91": {
    "th": "เปลี่ยนจาก \"เครดิตของเกษตรกรรายเดียว\" ให้กลายเป็น \"โครงการคาร์บอน\" ระดับองค์กรที่ยื่นขอรับรอง/ขายได้จริง",
    "en": "Converts individual farmer credits into an organization-level \"carbon project\" that can actually be submitted for certification and sold"
  },
  "carbon-module-guide_92": {
    "th": "โครงการคาร์บอน 1 โครงการ = 1 องค์กร",
    "en": "One carbon project = one organization"
  },
  "carbon-module-guide_93": {
    "th": "สร้างได้โดย 3 ประเภทองค์กรเท่านั้น: ",
    "en": "Can only be created by 3 types of organizations: "
  },
  "carbon-module-guide_94": {
    "th": "สหกรณ์ (Cooperative)",
    "en": "Cooperative"
  },
  "carbon-module-guide_95": {
    "th": "วิสาหกิจชุมชนด้านการเกษตร (AgriCommunityEnterprise)",
    "en": "Agricultural Community Enterprise (AgriCommunityEnterprise)"
  },
  "carbon-module-guide_96": {
    "th": "กองทุนหมู่บ้าน (VillageFund)",
    "en": "Village Fund (VillageFund)"
  },
  "carbon-module-guide_97": {
    "th": "กำหนด \"สัดส่วนแบ่งให้กลุ่มเกษตรกร\" (farmer_pool_pct) และ \"ค่าธรรมเนียมแพลตฟอร์ม\" (platform_fee_pct) ได้เองต่อโครงการ ไม่ใช่ค่าคงที่ 80/20 ทั้งระบบ",
    "en": "The \"farmer pool share\" (farmer_pool_pct) and \"platform fee\" (platform_fee_pct) can be set per project — these are not a fixed 80/20 split system-wide"
  },
  "carbon-module-guide_98": {
    "th": "มีสถานะไล่ระดับ: draft → mrv_prep → submitted_to_tver → registered → credits_issued (องค์กรปรับเองตามความคืบหน้าจริงนอกระบบ)",
    "en": "Has a progressive status sequence: draft → mrv_prep → submitted_to_tver → registered → credits_issued (the organization advances it manually to reflect real-world progress)"
  },
  "carbon-module-guide_99": {
    "th": "สมาชิกของโครงการ = รอบปลูกที่ verified แล้ว",
    "en": "Project members = verified growing cycles"
  },
  "carbon-module-guide_100": {
    "th": "ดึงได้เฉพาะรอบปลูกของสมาชิกในองค์กรที่มีสถานะ AWD assessment เป็น ",
    "en": "Only growing cycles belonging to the organization's members whose AWD assessment status is "
  },
  "carbon-module-guide_101": {
    "th": " แล้วเท่านั้น (ดู \"รายชื่อที่มีสิทธิ์เข้าร่วม\" — eligible-assessments)",
    "en": " can be pulled in (see the \"eligible participant list\" — eligible-assessments)"
  },
  "carbon-module-guide_102": {
    "th": "1 รอบปลูก (assessment) เข้าร่วมโครงการที่ \"กำลังใช้งาน\" ได้ทีละ 1 โครงการเท่านั้นในแต่ละช่วงเวลา",
    "en": "One growing cycle (assessment) can belong to only one \"active\" project at any given time"
  },
  "carbon-module-guide_103": {
    "th": "ถอดสมาชิกออกได้ (ไม่ลบทิ้ง แค่เปลี่ยนสถานะเป็น removed) แล้วนำไปเพิ่มในโครงการอื่นทีหลังได้ — ประวัติยังอยู่ครบเพื่อการตรวจสอบ",
    "en": "Members can be removed (not deleted — only marked as removed) and later added to another project. The full history is preserved for auditing"
  },
  "carbon-module-guide_104": {
    "th": "สัดส่วนเครดิตของแต่ละคน (allocated_credit_tco2e) คือฐานที่ใช้แบ่งรายได้ในเฟส 3 ทีหลัง",
    "en": "Each member's allocated credit share (allocated_credit_tco2e) is the basis used for revenue sharing later, in Phase 3"
  },
  "carbon-module-guide_105": {
    "th": "ห้องเก็บเอกสาร MRV (MRV Data Room)",
    "en": "MRV Data Room"
  },
  "carbon-module-guide_106": {
    "th": "แต่ละโครงการมีที่เก็บ \"หลักฐาน\" 4 ประเภท ได้แก่ ภาพถ่ายดาวเทียม, ขอบเขตแปลง (GIS/GeoJSON), เอกสารรับรอง และอื่นๆ — ไฟล์จริง (ภาพ/PDF) ใช้ระบบอัปโหลดไฟล์กลางที่มีอยู่แล้วของแพลตฟอร์ม (ไม่ได้สร้างระบบเก็บไฟล์ใหม่) ส่วนขอบเขตแปลง (GIS) เก็บเป็นข้อความ/พิกัดตรงๆ เพราะไฟล์ประเภท .geojson/.kml/.shp ไม่อยู่ใน allowlist ของระบบอัปโหลดไฟล์ปัจจุบัน ลบออกได้เฉพาะตอนโครงการยังอยู่สถานะ draft/mrv_prep เท่านั้น (กันไม่ให้แก้ไขหลักฐานหลังยื่นไปแล้ว)",
    "en": "Each project stores 4 categories of \"evidence\": satellite imagery, plot boundaries (GIS/GeoJSON), certification documents, and other materials. Actual files (images/PDFs) use the platform's existing central file-upload system (no new file-storage system was built). Plot boundaries (GIS) are stored directly as text/coordinates, since .geojson/.kml/.shp file types are not on the current file-upload system's allowlist. Evidence can only be deleted while the project is still in draft/mrv_prep status, to prevent evidence from being altered after submission"
  },
  "carbon-module-guide_107": {
    "th": "เมื่อพร้อมแล้ว องค์กรกด \"ส่งออกชุดเอกสาร\" — ระบบรวมข้อมูลโครงการ + รายชื่อสมาชิก + หลักฐานทั้งหมดเป็นชุดเดียว (manifest) ให้เจ้าหน้าที่นำไปยื่นกับผู้ตรวจสอบ (VVB) หรือ อบก./TGO ด้วยตนเอง — ",
    "en": "When ready, the organization clicks \"Export Document Package\" — the system bundles the project data, member list, and all evidence into a single package (manifest) for staff to submit manually to a validation/verification body (VVB) or TGO. "
  },
  "carbon-module-guide_108": {
    "th": "ไม่มีการเชื่อมต่อ/ส่งข้อมูลอัตโนมัติไปยังหน่วยงานภายนอกใดๆ ทั้งสิ้น",
    "en": "There is no automatic integration or data submission to any external authority whatsoever."
  },
  "carbon-module-guide_109": {
    "th": "3 องค์กรใช้หน้าจอเดียวกัน:",
    "en": "All 3 organization types share the same screen:"
  },
  "carbon-module-guide_110": {
    "th": " พอร์ทัลของสหกรณ์ วิสาหกิจชุมชนด้านการเกษตร และกองทุนหมู่บ้าน ทั้ง 3 แบบใช้ widget เดียวกัน (",
    "en": " The Cooperative, Agricultural Community Enterprise, and Village Fund portals all use the same widget ("
  },
  "carbon-module-guide_111": {
    "th": ") ฝังในหน้า dashboard ของแต่ละพอร์ทัล — โค้ดหลังบ้านแยกเป็นคนละไฟล์ต่อประเภทองค์กร (",
    "en": ") embedded in each portal's dashboard page. The backend code is split into separate files per organization type ("
  },
  "carbon-module-guide_112": {
    "th": ") แต่ตรรกะเหมือนกันทุกประการ องค์กรเห็นและจัดการได้เฉพาะโครงการของตนเองเท่านั้น\n    ",
    "en": "), but the logic is identical across all of them. Each organization can only see and manage its own projects.\n    "
  },
  "carbon-module-guide_113": {
    "th": " เฟส 3",
    "en": " Phase 3"
  },
  "carbon-module-guide_114": {
    "th": "ตลาดกลางและกลไกแบ่งรายได้",
    "en": "Marketplace and Revenue-Sharing Mechanism"
  },
  "carbon-module-guide_115": {
    "th": "จับคู่ผู้ซื้อกับผู้ขาย คำนวณและแบ่งรายได้อัตโนมัติ — ระบบเดียวที่ทำให้ \"คาร์บอนเครดิต\" กลายเป็นเงินจริง",
    "en": "Matches buyers with sellers and automatically calculates and distributes revenue — the single mechanism that turns \"carbon credits\" into real money"
  },
  "carbon-module-guide_116": {
    "th": "🏷️ ประกาศขาย (ฝั่งองค์กร)",
    "en": "🏷️ Sale Listing (Organization Side)"
  },
  "carbon-module-guide_117": {
    "th": "ลงขายได้เฉพาะโครงการที่สถานะ ",
    "en": "Only projects with status "
  },
  "carbon-module-guide_118": {
    "th": " หรือ ",
    "en": " or "
  },
  "carbon-module-guide_119": {
    "th": " เท่านั้น — ระบุจำนวนเครดิต (tCO₂e) และราคาที่ต้องการต่อหน่วย",
    "en": " can be listed for sale — specifying the credit quantity (tCO₂e) and the desired price per unit"
  },
  "carbon-module-guide_120": {
    "th": "🛒 คำสั่งซื้อ (ฝั่งผู้ซื้อ)",
    "en": "🛒 Purchase Order (Buyer Side)"
  },
  "carbon-module-guide_121": {
    "th": "ผู้ซื้อ (Buyer) ระบุจำนวนที่ต้องการซื้อและราคาที่เสนอ — ยังไม่เห็นรายชื่อผู้ขายหรือประกาศขายใดๆ โดยตรง เป็นเพียง \"คำขอ\" เข้าคิว",
    "en": "The buyer specifies the desired purchase quantity and offered price — without seeing any seller's identity or sale listing directly. It is simply a \"request\" entering the queue"
  },
  "carbon-module-guide_122": {
    "th": "💰 ผลการแบ่งรายได้",
    "en": "💰 Revenue Split Result"
  },
  "carbon-module-guide_123": {
    "th": "หนึ่งแถวต่อผู้รับเงินหนึ่งราย (องค์กร 1 แถว + เกษตรกรที่ยัง active ในโครงการอีกคนละ 1 แถว) ต่อการจับคู่หนึ่งครั้ง",
    "en": "One row per recipient (1 row for the organization, plus 1 row for each farmer still active in the project), generated for each match"
  },
  "carbon-module-guide_124": {
    "th": "การจับคู่: ทำโดย Platform Ops เท่านั้น ไม่ใช่ระบบอัตโนมัติ",
    "en": "Matching: performed exclusively by Platform Ops, not by any automated system"
  },
  "carbon-module-guide_125": {
    "th": "เมื่อมีประกาศขายและคำสั่งซื้อพร้อมกัน Platform Ops เป็นผู้เลือกจับคู่เองผ่านหน้าแอดมิน \"ตลาดคาร์บอนเครดิต\" (ไม่ใช่ตลาดแบบเปิดให้ผู้ซื้อเลือกผู้ขายเอง) กติกาสำคัญ:",
    "en": "When a sale listing and a purchase order both exist, Platform Ops selects the match manually through the \"Carbon Credit Marketplace\" admin page (this is not an open market where buyers choose sellers themselves). Key rules:"
  },
  "carbon-module-guide_126": {
    "th": "ขายเต็มจำนวนเท่านั้น:",
    "en": "Full-quantity sales only:"
  },
  "carbon-module-guide_127": {
    "th": " จำนวนที่จับคู่ต้องเท่ากับจำนวนที่ประกาศขายพอดี ไม่รองรับขายบางส่วนหรือทบยอดคงเหลือไปขายต่อ",
    "en": " The matched quantity must exactly equal the listed quantity; partial sales or carrying over a remaining balance are not supported"
  },
  "carbon-module-guide_128": {
    "th": "จับคู่ได้ไม่เกินจำนวนที่ขอซื้อ:",
    "en": "Matched quantity cannot exceed the requested purchase quantity:"
  },
  "carbon-module-guide_129": {
    "th": " จำนวนที่จับคู่ต้องไม่เกินจำนวนที่คำสั่งซื้อนั้นระบุไว้",
    "en": " The matched quantity must not exceed what the purchase order specifies"
  },
  "carbon-module-guide_130": {
    "th": "ราคา/ต้นทุนกรอกจริงตอนจับคู่:",
    "en": "Actual price/cost is entered at match time:"
  },
  "carbon-module-guide_131": {
    "th": " ราคาที่ตกลงกันจริงและต้นทุนโครงการ (ถ้ามี) ให้ Platform Ops กรอกตอนจับคู่ อาจต่างจากราคาที่แต่ละฝ่ายเสนอไว้แต่แรกก็ได้",
    "en": " The actually agreed price and project cost (if any) are entered by Platform Ops at the time of matching, and may differ from the prices each party originally proposed"
  },
  "carbon-module-guide_132": {
    "th": "สูตรแบ่งรายได้ (คำนวณโดยระบบ 100% ไม่ให้เจ้าหน้าที่กรอกเอง)",
    "en": "Revenue-Split Formula (100% system-calculated; staff never enter it manually)"
  },
  "carbon-module-guide_133": {
    "th": "รายได้รวม (Gross)     = จำนวนเครดิตที่จับคู่ ",
    "en": "Gross Revenue           = matched credit quantity "
  },
  "carbon-module-guide_134": {
    "th": " ราคาต่อหน่วยที่ตกลงกัน",
    "en": " agreed price per unit"
  },
  "carbon-module-guide_135": {
    "th": "ค่าธรรมเนียม AgroLink = รายได้รวม ",
    "en": "AgroLink Fee            = Gross Revenue "
  },
  "carbon-module-guide_136": {
    "th": "// ของโครงการนี้",
    "en": "// for this project"
  },
  "carbon-module-guide_137": {
    "th": "รายได้สุทธิ (Net)     = รายได้รวม ",
    "en": "Net Revenue             = Gross Revenue "
  },
  "carbon-module-guide_138": {
    "th": " ต้นทุนโครงการ ",
    "en": " − project cost "
  },
  "carbon-module-guide_139": {
    "th": " ค่าธรรมเนียม",
    "en": " − fee"
  },
  "carbon-module-guide_140": {
    "th": "// ถ้ารายได้สุทธิติดลบ ระบบปฏิเสธการจับคู่ทันที",
    "en": "// If Net Revenue is negative, the system immediately rejects the match"
  },
  "carbon-module-guide_141": {
    "th": "ส่วนแบ่งกลุ่มเกษตรกร  = รายได้สุทธิ ",
    "en": "Farmer Pool Share       = Net Revenue "
  },
  "carbon-module-guide_142": {
    "th": "// ของโครงการนี้",
    "en": "// for this project"
  },
  "carbon-module-guide_143": {
    "th": "ส่วนแบ่งองค์กร        = รายได้สุทธิ ",
    "en": "Organization Share      = Net Revenue "
  },
  "carbon-module-guide_144": {
    "th": " ส่วนแบ่งกลุ่มเกษตรกร",
    "en": " − Farmer Pool Share"
  },
  "carbon-module-guide_145": {
    "th": "ส่วนของเกษตรกรแต่ละคน = ส่วนแบ่งกลุ่มเกษตรกร ",
    "en": "Each Farmer's Share     = Farmer Pool Share "
  },
  "carbon-module-guide_146": {
    "th": " (เครดิตของตน ÷ เครดิตรวมของสมาชิก active ทั้งหมด)",
    "en": " × (their own credit ÷ total credit of all active members)"
  },
  "carbon-module-guide_147": {
    "th": "ตัวอย่างจากเอกสารออกแบบ: รายได้รวม 30,000 บาท − ต้นทุนโครงการ 2,000 − ค่าธรรมเนียม 10% ของรายได้รวม (3,000) = รายได้สุทธิ 25,000 บาท → แบ่งกลุ่มเกษตรกร 80% (20,000 บาท ตามสัดส่วนเครดิตของแต่ละคน) และเข้าองค์กร 20% (5,000 บาท) การปัดเศษทำละเอียดถึงสตางค์ โดยให้สมาชิกคนสุดท้ายรับผลต่างจากการปัดเศษ เพื่อให้ผลรวมของทุกคนตรงกับยอดที่ปัดแล้วเป๊ะ ไม่คลาดเคลื่อนสะสม",
    "en": "Example from the design documentation: Gross revenue of 30,000 THB − project cost of 2,000 − a 10% fee on gross revenue (3,000) = net revenue of 25,000 THB → 80% (20,000 THB, split by each member's credit share) goes to the farmer pool, and 20% (5,000 THB) goes to the organization. Rounding is carried out to the satang, with the last member absorbing the rounding difference so that the sum of everyone's shares matches the rounded total exactly, with no cumulative discrepancy."
  },
  "carbon-module-guide_148": {
    "th": "ยังไม่มีระบบโอนเงินจริงในแพลตฟอร์ม:",
    "en": "No real money-transfer system in the platform yet:"
  },
  "carbon-module-guide_149": {
    "th": " ตาราง ",
    "en": " The "
  },
  "carbon-module-guide_150": {
    "th": " เก็บ \"ยอดที่ต้องจ่าย\" และสถานะ pending/paid ไว้เป็นหลักฐานตรวจสอบเท่านั้น — เงินจริงต้องโอนกันเองนอกระบบ (องค์กร → เกษตรกร) ผ่านช่องทางที่มีอยู่แล้ว แล้วผู้มีสิทธิ์ (ฝั่งองค์กร) กลับมากด \"จ่ายแล้ว\" ในระบบเพื่อบันทึกไว้เท่านั้น\n    ",
    "en": " table stores the \"amount due\" and pending/paid status purely as an auditable record — actual money must be transferred outside the system (organization → farmer) through existing channels, after which an authorized user on the organization side returns to click \"Paid\" in the system, solely to log it.\n    "
  },
  "carbon-module-guide_151": {
    "th": " สรุป",
    "en": " Summary"
  },
  "carbon-module-guide_152": {
    "th": "ใครทำอะไรที่ไหน",
    "en": "Who Does What, Where"
  },
  "carbon-module-guide_153": {
    "th": "บทบาท",
    "en": "Role"
  },
  "carbon-module-guide_154": {
    "th": "ทำอะไร",
    "en": "Does What"
  },
  "carbon-module-guide_155": {
    "th": "หน้า/พอร์ทัล",
    "en": "Page/Portal"
  },
  "carbon-module-guide_156": {
    "th": "เกษตรกร",
    "en": "Farmer"
  },
  "carbon-module-guide_157": {
    "th": "บันทึกระดับน้ำ AWD ต่อรอบปลูก, ส่งตรวจ, ดูสถานะและรายได้ที่ได้รับ",
    "en": "Records AWD water levels per growing cycle, submits for review, views status and revenue received"
  },
  "carbon-module-guide_158": {
    "th": "Platform Ops (แอดมิน)",
    "en": "Platform Ops (Admin)"
  },
  "carbon-module-guide_159": {
    "th": "ตรวจสอบ/รับรอง/ตีกลับผลประเมิน AWD, ปรับค่าคงที่วิธีคำนวณ, ป้อนข้อมูลดาวเทียมเสริม, จับคู่คำสั่งซื้อ-ขายในตลาดกลาง",
    "en": "Reviews, verifies, or rejects AWD assessments; adjusts calculation constants; enters supplementary satellite data; matches buy/sell orders in the marketplace"
  },
  "carbon-module-guide_160": {
    "th": "พอร์ทัลแอดมิน แท็บ \"คาร์บอนเครดิต (AWD)\"",
    "en": "Admin Portal, \"Carbon Credit (AWD)\" tab"
  },
  "carbon-module-guide_161": {
    "th": "สหกรณ์ / วิสาหกิจชุมชนด้านการเกษตร / กองทุนหมู่บ้าน",
    "en": "Cooperative / Agricultural Community Enterprise / Village Fund"
  },
  "carbon-module-guide_162": {
    "th": "สร้าง/จัดการโครงการคาร์บอน, เพิ่ม-ถอดสมาชิก, แนบหลักฐาน MRV, ส่งออกเอกสาร, ลงขายเครดิต, ยืนยันจ่ายเงินให้สมาชิก",
    "en": "Creates/manages carbon projects, adds/removes members, attaches MRV evidence, exports documentation, lists credits for sale, confirms payments to members"
  },
  "carbon-module-guide_163": {
    "th": "widget \"Carbon Module\" ในหน้า dashboard ของแต่ละพอร์ทัล",
    "en": "\"Carbon Module\" widget on each portal's dashboard"
  },
  "carbon-module-guide_164": {
    "th": "ผู้รับซื้อผลผลิตและชีวมวล (Buyer)",
    "en": "Produce & Biomass Buyer"
  },
  "carbon-module-guide_165": {
    "th": "สร้าง/ยกเลิกคำสั่งซื้อเครดิต ดูผลการจับคู่หลังมีการจับคู่แล้ว (ดูได้อย่างเดียว แก้ไขไม่ได้)",
    "en": "Creates/cancels credit purchase orders; views match results once matched (view-only, cannot edit)"
  },
  "carbon-module-guide_166": {
    "th": "พอร์ทัลผู้รับซื้อผลผลิตและชีวมวล แท็บ \"ตลาดคาร์บอนเครดิต\"",
    "en": "Produce & Biomass Buyer Portal, \"Carbon Credit Marketplace\" tab"
  },
  "carbon-module-guide_167": {
    "th": " อ้างอิงสำหรับทีมพัฒนา",
    "en": " Reference for the Development Team"
  },
  "carbon-module-guide_168": {
    "th": "ตารางข้อมูลหลัก",
    "en": "Core Data Tables"
  },
  "carbon-module-guide_169": {
    "th": "ทุกตารางอยู่ใน schema ",
    "en": "All tables live in the "
  },
  "carbon-module-guide_170": {
    "th": " — ไม่มี Row Level Security บนตารางเหล่านี้เลย ขอบเขตความปลอดภัยทั้งหมดคือเงื่อนไข WHERE ที่ backend เขียนไว้ชัดเจน (ดูคอมเมนต์ท้ายไฟล์ grant_carbon_awd.sql)",
    "en": " schema — none of these tables have Row Level Security. All security boundaries are enforced entirely through explicit WHERE conditions written in the backend (see the comments at the end of grant_carbon_awd.sql)"
  },
  "carbon-module-guide_171": {
    "th": "ตาราง",
    "en": "Table"
  },
  "carbon-module-guide_172": {
    "th": "เฟส",
    "en": "Phase"
  },
  "carbon-module-guide_173": {
    "th": "หน้าที่",
    "en": "Purpose"
  },
  "carbon-module-guide_174": {
    "th": "ค่าคงที่วิธีคำนวณ เก็บเป็นเวอร์ชัน (แถวใหม่ + ปิด active แถวเก่า)",
    "en": "Calculation constants, stored as versions (new row added + old row deactivated)"
  },
  "carbon-module-guide_175": {
    "th": "บันทึกระดับน้ำที่เกษตรกรรายงานเอง — append-only",
    "en": "Water-level records self-reported by farmers — append-only"
  },
  "carbon-module-guide_176": {
    "th": "ข้อมูลดาวเทียมเสริม ป้อนด้วยมือโดย Platform Ops วันนี้",
    "en": "Supplementary satellite data, currently entered manually by Platform Ops"
  },
  "carbon-module-guide_177": {
    "th": "ผลประเมิน 1 แถวต่อ 1 รอบปลูก (draft/pending_review/verified/rejected)",
    "en": "Assessment results, 1 row per growing cycle (draft/pending_review/verified/rejected)"
  },
  "carbon-module-guide_178": {
    "th": "โครงการคาร์บอนของ 1 องค์กร พร้อมสัดส่วนแบ่งรายได้ที่ตั้งเองได้",
    "en": "An organization's carbon project, with configurable revenue-split ratios"
  },
  "carbon-module-guide_179": {
    "th": "เชื่อมรอบปลูกที่ verified แล้วเข้ากับโครงการ",
    "en": "Links verified growing cycles to a project"
  },
  "carbon-module-guide_180": {
    "th": "หลักฐาน MRV ของโครงการ (ไฟล์/GIS/เอกสารรับรอง)",
    "en": "A project's MRV evidence (files/GIS/certification documents)"
  },
  "carbon-module-guide_181": {
    "th": "ประกาศขายเครดิตของโครงการที่ registered แล้ว",
    "en": "Credit sale listings for registered projects"
  },
  "carbon-module-guide_182": {
    "th": "คำสั่งซื้อของผู้ซื้อ + ผลการจับคู่",
    "en": "Buyer purchase orders + match results"
  },
  "carbon-module-guide_183": {
    "th": "ยอดเงินที่ต้องจ่ายต่อผู้รับหนึ่งราย + สถานะจ่ายแล้ว/รอจ่าย",
    "en": "Amount due per recipient + paid/pending status"
  },
  "carbon-module-guide_184": {
    "th": "ข้อจำกัดและสิ่งที่ต้องระวัง",
    "en": "Limitations and Important Caveats"
  },
  "carbon-module-guide_185": {
    "th": "ค่าคงที่ทุกตัวในสูตรคำนวณ (อัตราเครดิตต่อไร่, จำนวนรอบแห้งขั้นต่ำ, ฯลฯ) เป็นค่าประมาณการเบื้องต้นที่ได้แรงบันดาลใจจากแนวทาง AWD ของ T-VER เท่านั้น ต้องปรับให้ตรงกับตัวเลขจริงที่ อบก. ประกาศ ก่อนนำไปอ้างอิงเชิงพาณิชย์หรือยื่นขอเครดิตจริง",
    "en": "Every constant in the calculation formula (credit rate per rai, minimum number of dry cycles, etc.) is only a preliminary estimate inspired by T-VER's AWD methodology. These must be aligned with the actual figures published by TGO before being used for commercial reference or an actual credit application"
  },
  "carbon-module-guide_186": {
    "th": "ระบบทั้งหมดนี้ไม่ใช่การขึ้นทะเบียนคาร์บอนเครดิตจริง — เป็นเครื่องมือเตรียมข้อมูล/ประเมินภายในเท่านั้น การขึ้นทะเบียนจริงต้องผ่านผู้รับรอง (VVB) และหน่วยงานกำกับ (เช่น อบก./TGO) แยกต่างหาก",
    "en": "This entire system is not actual carbon credit registration — it is purely an internal data-preparation and assessment tool. Real registration must go through a validation/verification body (VVB) and a regulatory authority (such as TGO) separately"
  },
  "carbon-module-guide_187": {
    "th": "การจับคู่ผู้ซื้อ-ผู้ขายเป็นการทำงานด้วยมือของ Platform Ops ทั้งหมด ไม่มีอัลกอริทึมจับคู่อัตโนมัติ และรองรับเฉพาะการขาย/ซื้อเต็มจำนวนเท่านั้น (ไม่มีการขายบางส่วน)",
    "en": "Buyer-seller matching is entirely a manual Platform Ops task — there is no automated matching algorithm, and only full-quantity sales/purchases are supported (no partial sales)"
  },
  "carbon-module-guide_188": {
    "th": "ไม่มีระบบโอนเงินจริงเชื่อมต่ออยู่ — ทุกยอดเงินในระบบเป็นบันทึกทางบัญชี (audit trail) เท่านั้น การโอนเงินจริงเกิดขึ้นนอกระบบเสมอ",
    "en": "No real money-transfer system is integrated — every monetary figure in the system is purely an accounting record (audit trail). Actual money transfers always happen outside the system"
  },
  "carbon-module-guide_189": {
    "th": "ไม่มี Row Level Security ระดับฐานข้อมูลบนตาราง carbon.* — ความปลอดภัยทั้งหมดอยู่ที่เงื่อนไขการ query ในโค้ด backend",
    "en": "There is no database-level Row Level Security on the carbon.* tables — all security relies entirely on query conditions in the backend code"
  },
  "carbon-module-guide_190": {
    "th": "อยากดูภาพรวมแนวคิดคาร์บอนเครดิตด้วยหรือไม่?",
    "en": "Want to see the overview of carbon credit concepts as well?"
  },
  "carbon-module-guide_191": {
    "th": "หน้านี้อธิบาย \"กลไกภายในระบบ\" ส่วนหน้าแนวคิดคาร์บอนเครดิตอธิบายภาพรวมตลาดคาร์บอนไทยและเทคนิค AWD ในเชิงหลักการทั่วไป",
    "en": "This page explains the \"internal system mechanism,\" while the Carbon Credit Concepts page covers the overview of the Thai carbon market and the general principles behind the AWD technique"
  },
  "carbon-module-guide_192": {
    "th": "อ่านแนวคิดคาร์บอนเครดิต",
    "en": "Read Carbon Credit Concepts"
  },
  "carbon-module-guide_193": {
    "th": "กลับหน้าแรก",
    "en": "Back to Home"
  }
});
