window.AGROLINK_I18N = Object.assign(window.AGROLINK_I18N || {}, {
  "production-cycle-template_1": {
    "th": " แนวคิดหลัก — เจาะลึก",
    "en": " Core Concept — In Depth"
  },
  "production-cycle-template_2": {
    "th": "แม่แบบวงจรการผลิตสากล",
    "en": "Universal Production Cycle Template"
  },
  "production-cycle-template_3": {
    "th": "โครงสร้างเดียวที่เชื่อมบัญชีหน่วยผลิต แผนงาน บริการ สินเชื่อ การเตือนภัย และการหักบัญชี เข้าเป็นวงจรเดียวกัน แล้วนำกลับมาใช้ซ้ำได้กับสินค้าเกษตรทุกชนิด — ตั้งแต่ข้าว ทุเรียน กุ้ง ไปจนถึงโคนม",
    "en": "A single structure that links the production unit account, planning, services, credit, risk alerts, and settlement into one unified cycle — reusable across every type of agricultural product, from rice and durian to shrimp and dairy."
  },
  "production-cycle-template_4": {
    "th": " บัญชีหน่วยผลิต",
    "en": " Production Unit Account"
  },
  "production-cycle-template_5": {
    "th": " ปฏิทินระยะ",
    "en": " Stage Calendar"
  },
  "production-cycle-template_6": {
    "th": " ตลาดบริการ",
    "en": " Service Marketplace"
  },
  "production-cycle-template_7": {
    "th": " สินเชื่อเป็นงวด",
    "en": " Installment Credit"
  },
  "production-cycle-template_8": {
    "th": " เตือนภัยร่วม",
    "en": " Shared Risk Alerts"
  },
  "production-cycle-template_9": {
    "th": " หักบัญชีอัตโนมัติ",
    "en": " Automatic Settlement"
  },
  "production-cycle-template_10": {
    "th": "ทำไมต้องมี \"แม่แบบ\"",
    "en": "Why a “Template” Is Needed"
  },
  "production-cycle-template_11": {
    "th": "เกษตรกรไทยผลิตสินค้าที่หลากหลายมาก แต่ปัญหาเชิงโครงสร้างที่ซ้ำกันในแทบทุกสินค้ามีอยู่สี่เรื่องหลัก: ไม่มีบัญชีหน่วยผลิตที่เป็นทางการไว้อ้างอิงสิทธิ์และประวัติ ขาดปฏิทินการผลิตที่ใช้วางแผนล่วงหน้าและตรวจสอบย้อนหลังได้ บริการแต่ละขั้นตอน เช่น เตรียมดิน พ่นยา เก็บเกี่ยว ขนส่ง แปรรูป กระจัดกระจายจนหาผู้ให้บริการที่เหมาะสมได้ยาก และการเข้าถึงแหล่งทุนมักมาในรูปเงินก้อนที่ตรวจสอบการใช้จริงไม่ได้ ทำให้มีความเสี่ยงทั้งฝั่งผู้ให้กู้และผู้กู้",
    "en": "Thai farmers produce an extremely diverse range of products, but four recurring structural problems appear across nearly every product: there is no formal production unit account to reference for rights and history; there is no production calendar that can be used for advance planning and retrospective verification; services for each stage — such as land preparation, spraying, harvesting, transport, and processing — are scattered, making it hard to find a suitable provider; and access to financing usually comes as a lump sum whose actual use can’t be verified, creating risk for both lender and borrower."
  },
  "production-cycle-template_12": {
    "th": "AgroLink จึงออกแบบ \"แม่แบบวงจรการผลิต\" ขึ้นมาหนึ่งชุด โดยแยกส่วนที่ \"เปลี่ยนตามชนิดสินค้า\" ออกจากส่วนที่ \"เหมือนกันทุกสินค้า\" อย่างชัดเจน สิ่งที่เปลี่ยนคือพารามิเตอร์ เช่น ระยะเวลาของแต่ละขั้นตอน ชนิดบริการที่ต้องใช้ในแต่ละระยะ และตัวชี้วัดเตือนภัยที่เกี่ยวข้อง ส่วนโครงสร้างข้อมูลและกระบวนการเบื้องหลังทั้งหมดเหมือนกัน ไม่ว่าจะเป็นนาข้าว สวนทุเรียน บ่อกุ้ง หรือฟาร์มโคนม ผลคือเมื่อจะเพิ่มสินค้าใหม่เข้าระบบ ทีมงานเพียงกำหนดชุดพารามิเตอร์ของสินค้านั้น โดยไม่ต้องพัฒนาระบบขึ้นใหม่ทั้งหมด",
    "en": "AgroLink has therefore designed a single “production cycle template,” clearly separating the parts that “change by product type” from the parts that are “identical across every product.” What changes are the parameters — such as the duration of each stage, the types of services needed at each stage, and the relevant risk-alert indicators. The underlying data structure and processes are entirely the same, whether for a rice field, a durian orchard, a shrimp pond, or a dairy farm. As a result, adding a new product to the system requires the team only to define that product’s parameter set, without having to build the system from scratch."
  },
  "production-cycle-template_13": {
    "th": " 6 องค์ประกอบของแม่แบบ",
    "en": " The 6 Components of the Template"
  },
  "production-cycle-template_14": {
    "th": "แต่ละองค์ประกอบทำหน้าที่อะไร และเชื่อมกันอย่างไร",
    "en": "What Each Component Does, and How They Connect"
  },
  "production-cycle-template_15": {
    "th": "แต่ละส่วนออกแบบให้ส่งต่อข้อมูลและเงื่อนไขให้กันเป็นทอด ๆ ครบหนึ่งรอบแล้ววนกลับไปเริ่มรอบใหม่ได้ทันที",
    "en": "Each part is designed to pass data and conditions on to the next in sequence; once a full cycle completes, it can loop right back into a new one."
  },
  "production-cycle-template_16": {
    "th": "บัญชีหน่วยผลิต",
    "en": "Production Unit Account"
  },
  "production-cycle-template_17": {
    "th": "คืออะไร",
    "en": "What It Is"
  },
  "production-cycle-template_18": {
    "th": "หนึ่งบัญชีต่อแปลงนา สวน คอก หรือบ่อ ต่อหนึ่งรอบการผลิต บันทึกพิกัดที่ตั้ง ขนาดพื้นที่หรือจำนวนสัตว์ ชนิดสินค้า และเชื่อมโยงประวัติของรอบก่อนหน้า เช่น ผลผลิตที่เคยได้ ปัญหาที่เคยเกิด และผู้ให้บริการที่เคยใช้งาน",
    "en": "One account per field, orchard, pen, or pond, per production cycle. It records location coordinates, area size or animal count, product type, and links to the history of previous cycles — such as past yields, past problems, and providers previously used."
  },
  "production-cycle-template_19": {
    "th": "ทำไมสำคัญ",
    "en": "Why It Matters"
  },
  "production-cycle-template_20": {
    "th": "เป็นกุญแจอ้างอิงเดียวที่ทุกส่วนของแม่แบบผูกเข้าด้วยกัน หากไม่มีบัญชีนี้ ข้อมูลแผนการผลิต การใช้บริการ สินเชื่อ และการหักบัญชี จะแยกกระจัดกระจายเหมือนระบบเดิมที่ตรวจสอบย้อนกลับไม่ได้",
    "en": "It is the single reference key that ties every part of the template together. Without this account, production plan data, service usage, credit, and settlement would be scattered apart, just like the old systems that couldn’t be traced back."
  },
  "production-cycle-template_21": {
    "th": "เชื่อมต่อขั้นถัดไป",
    "en": "Connects to the Next Step"
  },
  "production-cycle-template_22": {
    "th": "เมื่อเปิดบัญชีหน่วยผลิตใหม่สำหรับรอบการผลิตใหม่ ระบบจะดึงปฏิทินระยะที่เหมาะกับชนิดสินค้านั้นมาผูกให้อัตโนมัติ",
    "en": "When a new production unit account is opened for a new production cycle, the system automatically pulls in and attaches the stage calendar suited to that product type."
  },
  "production-cycle-template_23": {
    "th": "แผนการผลิต / ปฏิทินระยะ",
    "en": "Production Plan / Stage Calendar"
  },
  "production-cycle-template_24": {
    "th": "คืออะไร",
    "en": "What It Is"
  },
  "production-cycle-template_25": {
    "th": "ระบบกำหนดขั้นตอนและกรอบเวลาของสินค้าแต่ละชนิดให้โดยอัตโนมัติ เช่น ข้าว: เตรียมดิน → หว่าน/ดำ → ดูแลรักษา → เก็บเกี่ยว หรือกุ้ง: เตรียมบ่อ → ปล่อยลูกกุ้ง → ให้อาหาร → จับ แต่ละระยะมีเป้าหมาย ระยะเวลาโดยประมาณ และรายการบริการหรือปัจจัยการผลิตที่มักต้องใช้ในระยะนั้น",
    "en": "The system automatically defines the stages and timeframe for each product type — for example, rice: land preparation → sowing/transplanting → care and maintenance → harvest; or shrimp: pond preparation → stocking → feeding → harvest. Each stage has a goal, an estimated duration, and a list of services or inputs typically needed during that stage."
  },
  "production-cycle-template_26": {
    "th": "ทำไมสำคัญ",
    "en": "Why It Matters"
  },
  "production-cycle-template_27": {
    "th": "ทำให้ทุกฝ่ายที่เกี่ยวข้อง ไม่ว่าจะเป็นเกษตรกร ผู้ให้บริการ ผู้ให้สินเชื่อ หรือหน่วยงานภาครัฐ เห็นภาพเดียวกันว่าขณะนี้อยู่ระยะไหน ควรทำอะไรต่อ และคาดว่าจะเก็บเกี่ยวหรือจับได้เมื่อไร",
    "en": "It lets every party involved — farmers, service providers, lenders, or government agencies — see the same picture of what stage things are currently at, what should happen next, and when harvest is expected."
  },
  "production-cycle-template_28": {
    "th": "เชื่อมต่อขั้นถัดไป",
    "en": "Connects to the Next Step"
  },
  "production-cycle-template_29": {
    "th": "ปฏิทินระยะเป็นตัวกำหนดว่าจะเปิดตลาดบริการของขั้นตอนใดเมื่อไร และเป็นเงื่อนไขหลักที่ใช้ปลดล็อกสินเชื่อแต่ละงวด",
    "en": "The stage calendar determines when the service marketplace for each step opens, and serves as the primary condition for unlocking each credit installment."
  },
  "production-cycle-template_30": {
    "th": "ตลาดบริการเฉพาะขั้นตอน",
    "en": "Stage-Specific Service Marketplace"
  },
  "production-cycle-template_31": {
    "th": "คืออะไร",
    "en": "What It Is"
  },
  "production-cycle-template_32": {
    "th": "แทนที่เกษตรกรจะต้องหาแรงงาน เครื่องจักร หรือปัจจัยการผลิตเองแบบกระจัดกระจาย ระบบจับคู่ผู้ผลิตกับผู้ให้บริการที่ตรงกับระยะปัจจุบันของแปลงหรือบ่อ เช่น โดรนพ่นยา รถเกี่ยว รถขนส่ง หรือห้องเย็น ด้วยการจับคู่แบบ AI Matching โดยพิจารณาพื้นที่ใกล้เคียง คิวที่ว่าง และคะแนนความน่าเชื่อถือของผู้ให้บริการ",
    "en": "Instead of farmers having to find labor, machinery, or inputs on their own in a scattered way, the system matches producers with service providers suited to the plot’s or pond’s current stage — such as spraying drones, harvesters, transport trucks, or cold storage — through AI matching, which weighs proximity, available scheduling, and the provider’s trust score."
  },
  "production-cycle-template_33": {
    "th": "ทำไมสำคัญ",
    "en": "Why It Matters"
  },
  "production-cycle-template_34": {
    "th": "ลดเวลาค้นหา ลดการพึ่งพาคนกลางที่ไม่โปร่งใส และสร้างข้อมูลธุรกรรมที่ตรวจสอบได้ว่าใครทำงานอะไร เมื่อไร และในราคาเท่าไร",
    "en": "Reduces search time, reduces reliance on non-transparent middlemen, and creates a traceable transaction record of who did what work, when, and at what price."
  },
  "production-cycle-template_35": {
    "th": "เชื่อมต่อขั้นถัดไป",
    "en": "Connects to the Next Step"
  },
  "production-cycle-template_36": {
    "th": "การใช้บริการแต่ละครั้งถูกบันทึกเป็นหลักฐานว่า \"งานเสร็จจริงแล้ว\" ซึ่งใช้ปลดล็อกงวดสินเชื่อถัดไป และเก็บไว้เป็นข้อมูลประกอบการหักบัญชีเมื่อขายผลผลิต",
    "en": "Each service use is recorded as evidence that “the work has actually been completed,” which is used to unlock the next credit installment and is retained as supporting data for settlement when produce is sold."
  },
  "production-cycle-template_37": {
    "th": "สินเชื่อเป็นงวดตรวจสอบได้จริง",
    "en": "Verifiable Installment Credit"
  },
  "production-cycle-template_38": {
    "th": "คืออะไร",
    "en": "What It Is"
  },
  "production-cycle-template_39": {
    "th": "ผู้ให้สินเชื่อไม่ปล่อยเงินก้อนเดียวตั้งแต่ต้น แต่ปลดล็อกเป็นงวดตามระยะในปฏิทินการผลิต โดยเบิกใช้เป็นบริการหรือปัจจัยการผลิตผ่านตลาดบริการโดยตรง เช่น ค่าเช่ารถไถหรือค่าปุ๋ย มากกว่าจะโอนเป็นเงินสดเข้าบัญชี และปลดล็อกงวดถัดไปก็ต่อเมื่อมีหลักฐานว่างวดก่อนหน้าใช้จริงและถึงระยะที่กำหนดจริง",
    "en": "Lenders don’t disburse a single lump sum upfront; instead, funds are unlocked in installments according to the stages of the production calendar, drawn down as services or inputs directly through the service marketplace — such as tractor rental fees or fertilizer costs — rather than transferred as cash into an account. The next installment is unlocked only once there is evidence that the previous one was actually used and the required stage has genuinely been reached."
  },
  "production-cycle-template_40": {
    "th": "ทำไมสำคัญ",
    "en": "Why It Matters"
  },
  "production-cycle-template_41": {
    "th": "ลดความเสี่ยงที่เงินจะถูกใช้ผิดวัตถุประสงค์ ผู้ให้กู้เห็นความคืบหน้าจริงตลอดรอบการผลิต ส่วนเกษตรกรก็ได้ต้นทุนทางการเงินที่ต่ำลง เพราะความเสี่ยงของผู้ให้กู้ลดลงตามไปด้วย",
    "en": "Reduces the risk of funds being misused for other purposes. Lenders see genuine progress throughout the production cycle, while farmers benefit from lower financing costs, since the lender’s risk is reduced accordingly."
  },
  "production-cycle-template_42": {
    "th": "เชื่อมต่อขั้นถัดไป",
    "en": "Connects to the Next Step"
  },
  "production-cycle-template_43": {
    "th": "ทุกงวดที่เบิกใช้จะเชื่อมกับรายรับที่คาดว่าจะได้ตอนขายผลผลิต ซึ่งจะถูกหักคืนอัตโนมัติที่จุดขายในภายหลัง และหากเกิดเหตุการณ์เตือนภัย เงื่อนไขของงวดจะถูกทบทวนหรือปรับใหม่ตามความเหมาะสม",
    "en": "Every installment drawn down is linked to the expected income at the time of sale, which will later be automatically deducted and repaid at the point of sale — and if a risk alert event occurs, the installment’s terms are reviewed or adjusted as appropriate."
  },
  "production-cycle-template_44": {
    "th": "ระบบเตือนภัยร่วม",
    "en": "Shared Risk Alert System"
  },
  "production-cycle-template_45": {
    "th": "คืออะไร",
    "en": "What It Is"
  },
  "production-cycle-template_46": {
    "th": "เชื่อมข้อมูลภาครัฐและแหล่งข้อมูลสาธารณะที่เกี่ยวข้องกับสินค้านั้น ๆ เช่น สภาพอากาศ โรคระบาด ราคาตลาด หรือปริมาณน้ำ เข้ากับบัญชีหน่วยผลิตที่อยู่ในพื้นที่หรือช่วงเวลาที่มีความเสี่ยง แล้วแจ้งเตือนทุกฝ่ายที่เกี่ยวข้องพร้อมกันในเวลาเดียวกัน ทั้งเกษตรกร ผู้ให้บริการ และผู้ให้สินเชื่อ",
    "en": "Connects government data and relevant public data sources for that product — such as weather, disease outbreaks, market prices, or water levels — with production unit accounts located in areas or periods at risk, then notifies every relevant party simultaneously and at the same time, including farmers, service providers, and lenders."
  },
  "production-cycle-template_47": {
    "th": "ทำไมสำคัญ",
    "en": "Why It Matters"
  },
  "production-cycle-template_48": {
    "th": "ทำให้ทุกฝ่ายเห็นสถานการณ์เดียวกันแบบเรียลไทม์ ลดข้อพิพาทที่มักเกิดจากการ \"ไม่รู้ก่อน\" และช่วยให้ตัดสินใจร่วมกันได้เร็วขึ้น เช่น เลื่อนกำหนดเก็บเกี่ยว หรือปรับแผนสินเชื่อล่วงหน้า",
    "en": "Lets every party see the same situation in real time, reducing disputes that often arise from “not knowing in advance,” and enabling faster joint decisions — such as postponing a harvest date or adjusting a credit plan ahead of time."
  },
  "production-cycle-template_49": {
    "th": "เชื่อมต่อขั้นถัดไป",
    "en": "Connects to the Next Step"
  },
  "production-cycle-template_50": {
    "th": "เหตุการณ์เตือนภัยที่กระทบขั้นตอนใดขั้นตอนหนึ่งจะย้อนกลับไปปรับปฏิทินระยะและเงื่อนไขสินเชื่อโดยอัตโนมัติหรือกึ่งอัตโนมัติ เพื่อให้แผนยังสอดคล้องกับสถานการณ์จริง",
    "en": "A risk alert event affecting any particular stage feeds back automatically or semi-automatically to adjust the stage calendar and credit terms, so the plan stays aligned with real conditions."
  },
  "production-cycle-template_51": {
    "th": "หักบัญชีอัตโนมัติ",
    "en": "Automatic Settlement"
  },
  "production-cycle-template_52": {
    "th": "คืออะไร",
    "en": "What It Is"
  },
  "production-cycle-template_53": {
    "th": "เมื่อขายผลผลิตที่จุดขาย เช่น โรงสี ล้ง ตลาดกลาง หรือผู้รับซื้อ ระบบจะกระทบยอดหนี้คงค้างของบัญชีหน่วยผลิตนั้นโดยอัตโนมัติ หักคืนต้นทุนหรือสินเชื่อที่เบิกไปตามงวด แล้วโอนยอดสุทธิที่เหลือให้ผู้ผลิตทันที พร้อมประวัติการหักที่ตรวจสอบย้อนหลังได้ทุกรายการ (Audit Trail)",
    "en": "When produce is sold at a sales point — such as a rice mill, a seafood processing plant, a central market, or a buyer — the system automatically reconciles the outstanding balance of that production unit account, deducting and repaying costs or credit drawn down by installment, then immediately transfers the remaining net amount to the producer, along with a fully auditable deduction history for every transaction (audit trail)."
  },
  "production-cycle-template_54": {
    "th": "ทำไมสำคัญ",
    "en": "Why It Matters"
  },
  "production-cycle-template_55": {
    "th": "ปิดวงจรให้ครบโดยไม่ต้องให้เกษตรกรเดินไปจ่ายหนี้เองหลังขายแล้ว ลดปัญหาการเบี้ยวหนี้ และทำให้ผู้ให้สินเชื่อมั่นใจมากพอที่จะลดอัตราดอกเบี้ยลงได้ในระยะยาว",
    "en": "Closes the full cycle without requiring farmers to go pay off debt themselves after selling, reduces default problems, and gives lenders enough confidence to lower interest rates over the long term."
  },
  "production-cycle-template_56": {
    "th": "เชื่อมต่อขั้นถัดไป",
    "en": "Connects to the Next Step"
  },
  "production-cycle-template_57": {
    "th": "ยอดและประวัติจากขั้นตอนนี้จะกลายเป็นส่วนหนึ่งของประวัติบัญชีหน่วยผลิต ซึ่งใช้ประกอบการพิจารณาสินเชื่อและวางแผนในรอบการผลิตถัดไป ปิดวงจรที่หมุนต่อไปได้เรื่อย ๆ",
    "en": "The totals and history from this step become part of the production unit account’s record, used to support credit decisions and planning in the next production cycle — closing a cycle that can keep turning indefinitely."
  },
  "production-cycle-template_58": {
    "th": "ทำไมต้องเรียกว่า \"สากล\" (Universal)",
    "en": "Why It’s Called “Universal”"
  },
  "production-cycle-template_59": {
    "th": "เพราะโครงสร้างข้อมูลและกระบวนการทั้งหกส่วน คือ บัญชี แผน บริการ สินเชื่อ เตือนภัย และหักบัญชี เหมือนกันในทุกสินค้าเกษตร สิ่งที่เปลี่ยนไปตามชนิดสินค้ามีเพียงพารามิเตอร์ เช่น ระยะเวลาของแต่ละขั้น ชนิดบริการที่ต้องใช้ในแต่ละระยะ และตัวชี้วัดเตือนภัยที่เกี่ยวข้อง เมื่อ AgroLink จะขยายไปยังสินค้าใหม่ เช่น ปาล์มน้ำมัน โคเนื้อ หรือผลไม้ส่งออก ทีมงานจึงเพิ่มเฉพาะชุดพารามิเตอร์ของสินค้านั้นเข้าไปในแม่แบบเดิม แทนที่จะต้องพัฒนาระบบขึ้นใหม่ทั้งหมด ทำให้ขยายสินค้าใหม่ได้เร็ว และยังใช้งานได้กับผู้ใช้กลุ่มเดิมทั้งเกษตรกร สหกรณ์ ผู้ให้บริการ และผู้ให้สินเชื่อ โดยไม่ต้องเรียนรู้ระบบใหม่",
    "en": "Because the data structure and processes of all six parts — account, plan, services, credit, risk alerts, and settlement — are identical across every agricultural product. What changes by product type is only the parameter set, such as the duration of each stage, the types of services needed at each stage, and the relevant risk-alert indicators. When AgroLink expands to a new product — such as oil palm, beef cattle, or export fruit — the team only needs to add that product’s parameter set into the existing template, rather than building the system from scratch. This allows new products to be added quickly, and still works for the same group of users — farmers, cooperatives, service providers, and lenders — without having to learn a new system."
  },
  "production-cycle-template_60": {
    "th": "พร้อมเริ่มรอบการผลิตแรกของคุณแล้วหรือยัง",
    "en": "Ready to Start Your First Production Cycle?"
  },
  "production-cycle-template_61": {
    "th": "ดูว่าสินค้าใดใช้แม่แบบนี้แล้วบ้าง หรือเริ่มสมัครใช้งานเพื่อเปิดบัญชีหน่วยผลิตแรกของคุณ",
    "en": "See which products already use this template, or start signing up to open your first production unit account."
  },
  "production-cycle-template_62": {
    "th": "ดูแผนสินค้าที่รองรับ",
    "en": "View Supported Products"
  },
  "production-cycle-template_63": {
    "th": "สมัครใช้งาน",
    "en": "Sign Up"
  }
});
