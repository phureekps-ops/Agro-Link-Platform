/**
 * AgroLink — Support Chat Widget (added 2026-08-30).
 *
 * A floating "แชทกับทีมงาน" button + panel, self-contained (own inline
 * styles, no dependency on any page's existing CSS) so the SAME script
 * tag can be dropped into every portal's main dashboard.html unchanged.
 * Backs GET/POST /support/messages (backend/src/routes/support.js — see
 * grant_support_chat.sql for the feature's scope/history note).
 *
 * Deliberately NOT loaded on frontend/admin/dashboard.html — the admin is
 * the one READING and REPLYING to every conversation (see the new "💬
 * ข้อความสนับสนุน" section added to that dashboard instead), not another
 * sender of the same kind of message.
 *
 * Session lookup: every portal's own js/api.js declares its OWN
 * "AgroLinkXxxAPI" object and its OWN localStorage key (agrolink_farmer_
 * session, agrolink_buyer_session, agrolink_machinery_session, ...) —
 * see each api.js's own header comment for why (so two portal sessions in
 * the same browser never collide). Rather than hardcode which api.js
 * object is loaded on a given page (12 different names), this widget
 * reads the access_token directly out of whichever of those localStorage
 * keys is present — the page including this script only ever has ONE of
 * them populated (its own portal's session). Uses SUPPORT_ prefixed names
 * throughout to avoid colliding with each page's own already-declared
 * `API_BASE`/`session` etc.
 *
 * FAQ accordion (added 2026-10-27): a static, client-only "คำถามที่พบบ่อย"
 * list toggled from a new header button — no backend call, no relation to
 * the real support ticket thread below it. Lets a user self-serve common
 * questions about AgroLink before (or instead of) messaging staff.
 * FAQ_ITEMS content should be reviewed/updated by the AgroLink team
 * directly in this file when policies (pricing, security, etc.) change.
 */
(function () {
  const SUPPORT_SESSION_KEYS = [
    "agrolink_farmer_session",
    "agrolink_buyer_session",
    "agrolink_coop_session",
    "agrolink_fertilizermixing_session",
    "agrolink_gov_session",
    "agrolink_inputsupplier_session",
    "agrolink_lender_session",
    "agrolink_logistics_session",
    "agrolink_machinery_session",
    "agrolink_marketvenue_session",
    "agrolink_villagefund_session",
  ];

  function getSupportAccessToken() {
    for (const key of SUPPORT_SESSION_KEYS) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.access_token) return parsed.access_token;
      } catch (e) {
        // Not this key's session — keep checking the rest.
      }
    }
    return null;
  }

  const SUPPORT_API_BASE = (["localhost", "127.0.0.1"].includes(window.location.hostname))
    ? "http://localhost:4000"
    : "https://agrolink-backend-vhv6.onrender.com";

  const accessToken = getSupportAccessToken();
  if (!accessToken) {
    // No recognized session on this page (e.g. reached before login
    // finished) — don't render a widget that can't call any endpoint.
    return;
  }

  async function supportRequest(path, options) {
    const res = await fetch(`${SUPPORT_API_BASE}${path}`, Object.assign({}, options, {
      headers: Object.assign(
        { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        (options && options.headers) || {},
      ),
    }));
    const isJson = (res.headers.get("content-type") || "").includes("application/json");
    const body = isJson ? await res.json().catch(() => null) : null;
    if (!res.ok) {
      const err = new Error((body && body.error) || `request_failed_${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  function supportEscapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function supportThaiTime(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
  }

  // ---------- คำถามที่พบบ่อย (FAQ) — static content, client-side only ----------
  const FAQ_ITEMS = [
    {
      q: "AgroLink คืออะไร",
      a: "AgroLink คือแพลตฟอร์มดิจิทัลสำหรับภาคเกษตรกรรมไทย ที่เชื่อมโยงเกษตรกร ผู้รับซื้อผลผลิต สถาบันการเงิน หน่วยงานภาครัฐ และผู้ให้บริการต่างๆ ในซัพพลายเชนการเกษตรไว้บนระบบเดียว เพื่อให้การซื้อขาย การเข้าถึงแหล่งทุน และการบริหารจัดการผลผลิตเป็นไปอย่างโปร่งใสและมีประสิทธิภาพมากขึ้น",
    },
    {
      q: "AgroLink มีบริการอะไรบ้าง",
      a: "แพลตฟอร์มแบ่งเป็นพอร์ทัลตามกลุ่มผู้ใช้งาน เช่น พอร์ทัลเกษตรกร พอร์ทัลผู้รับซื้อผลผลิตการเกษตร พอร์ทัลผู้ปล่อยกู้และกองทุนหมู่บ้าน พอร์ทัลผู้ให้บริการเครื่องจักรกลและปัจจัยการผลิต พอร์ทัลสหกรณ์และวิสาหกิจชุมชน รวมถึงบริการเฉพาะทางอย่างตลาดชีวมวล ตลาดคาร์บอนเครดิต และตลาดประกันภัยทางการเกษตร",
    },
    {
      q: "ใครบ้างที่เป็นสมาชิกหรือใช้งาน AgroLink ได้",
      a: "ครอบคลุมทั้งเกษตรกรรายบุคคล สหกรณ์และวิสาหกิจชุมชน ผู้รับซื้อผลผลิตและโรงงานแปรรูป สถาบันการเงินและกองทุนหมู่บ้าน ผู้ให้บริการเครื่องจักรกลและปัจจัยการผลิต ผู้ให้บริการประกันภัย ตลอดจนหน่วยงานภาครัฐที่กำกับดูแลภาคเกษตร",
    },
    {
      q: "การลงทะเบียนเข้าใช้งานต้องทำอย่างไร",
      a: "องค์กรที่ต้องการเข้าใช้งานต้องสมัครและผ่านการตรวจสอบข้อมูลธุรกิจ (KYB) กับทีมงาน AgroLink ก่อน หลังผ่านการอนุมัติแล้วจึงจะสามารถเข้าสู่ระบบผ่านพอร์ทัลของบทบาทนั้นๆ ได้ และหากต้องการเพิ่มบทบาทธุรกิจอื่นในภายหลัง สามารถส่งคำขอได้จากหน้า \"จัดการบทบาทธุรกิจ\"",
    },
    {
      q: "AgroLink ใช้เทคโนโลยีอะไรบ้าง",
      a: "ระบบพัฒนาเป็นเว็บแอปพลิเคชันที่ทำงานบนคลาวด์ มีระบบยืนยันตัวตนและจัดการสิทธิ์การเข้าถึงแยกตามองค์กรและบทบาท นำเทคโนโลยี AI และ IoT มาใช้ในการวิเคราะห์และติดตามข้อมูลการเกษตร รวมถึงข้อมูลภาพถ่ายดาวเทียมเพื่อประเมินผลผลิตในบางฟีเจอร์",
    },
    {
      q: "การใช้งาน AgroLink มีค่าใช้จ่ายหรือไม่",
      a: "สมาชิกทุกประเภทเริ่มใช้บริการได้โดยไม่มีค่าใช้จ่าย และเมื่อมีกิจกรรมที่ต้องใช้บริการของแพลตฟอร์มซึ่งก่อให้เกิดค่าใช้จ่าย จึงจะมีอัตราค่าบริการเกิดขึ้น โดยมีรายละเอียดระบุไว้ในข้อตกลงการใช้งาน",
    },
    {
      q: "ข้อมูลของผู้ใช้งานบน AgroLink ปลอดภัยแค่ไหน",
      a: "ข้อมูลของสมาชิกทุกองค์กรได้รับการดูแลความปลอดภัยตามข้อบังคับและกฎหมายที่เกี่ยวข้องอย่างเคร่งครัด โดยจำกัดสิทธิ์การเข้าถึงข้อมูลไว้เฉพาะองค์กรเจ้าของข้อมูลและผู้ที่ได้รับอนุมัติบทบาทที่เกี่ยวข้องเท่านั้น",
    },
    {
      q: "บริการประกันภัยทางการเกษตรของ AgroLink ครอบคลุมอะไรบ้าง",
      a: "ตลาดประกันภัยของ AgroLink แบ่งตามประเภทความเสี่ยงหลัก ได้แก่ ประกันภัยพืชไร่ ผลไม้ สัตว์บก สัตว์น้ำ และโรงเรือน/สิ่งปลูกสร้าง เกษตรกรและผู้ประกอบการสามารถเข้าดูและเลือกแผนประกันที่เหมาะกับกิจการของตนได้จากพอร์ทัลประกันภัยโดยตรง",
    },
    {
      q: "ตลาดชีวมวลและผู้รับซื้อชีวมวลบน AgroLink ทำงานอย่างไร",
      a: "ผู้ผลิตวัสดุชีวมวล (เช่น ฟางข้าว ซังข้าวโพด ไม้ยูคา) และผู้รับซื้อชีวมวล (เช่น โรงไฟฟ้า โรงงานผลิตเชื้อเพลิง) สามารถลงทะเบียนความต้องการและสเปคสินค้าที่ต้องการบนพอร์ทัลของตนเอง เพื่อให้ทีมงาน AgroLink ช่วยจับคู่แหล่งชีวมวลกับผู้รับซื้อในเครือข่ายได้อย่างเหมาะสม",
    },
    {
      q: "หากต้องการสอบถามเพิ่มเติมหรือติดต่อทีมงาน AgroLink ทำอย่างไร",
      a: "สามารถกดปุ่ม \"ติดต่อทีมงาน\" หรือ \"ติดต่อ AgroLink\" จากหน้าใดก็ได้บนเว็บไซต์ ซึ่งจะนำไปยังหน้าติดต่อที่สามารถส่งข้อความหรืออีเมลถึงทีมงานได้โดยตรง หรือพิมพ์คำถามในช่องแชทนี้เพื่อพูดคุยกับทีมงานได้ทันที",
    },
  ];

  // ---------- Inject markup + styles ----------
  const style = document.createElement("style");
  style.textContent = `
    #agrolinkSupportToggle {
      position: fixed; bottom: 20px; right: 20px; z-index: 9999;
      width: 56px; height: 56px; border-radius: 50%; border: none;
      background: #2e7d32; color: #fff; font-size: 24px; cursor: pointer;
      box-shadow: 0 2px 10px rgba(0,0,0,0.25);
      display: flex; align-items: center; justify-content: center;
    }
    #agrolinkSupportToggle .agrolink-support-badge {
      position: absolute; top: -2px; right: -2px; background: #d32f2f;
      color: #fff; border-radius: 50%; width: 16px; height: 16px;
      font-size: 10px; display: flex; align-items: center; justify-content: center;
    }
    #agrolinkSupportPanel {
      position: fixed; bottom: 86px; right: 20px; z-index: 9999;
      width: 320px; max-width: calc(100vw - 40px); height: 420px; max-height: calc(100vh - 140px);
      background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.25);
      display: none; flex-direction: column; overflow: hidden;
      font-family: inherit; font-size: 13px;
    }
    #agrolinkSupportPanel.agrolink-support-open { display: flex; }
    #agrolinkSupportHeader {
      background: #2e7d32; color: #fff; padding: 10px 14px; font-weight: 700;
      display: flex; justify-content: space-between; align-items: center; flex: 0 0 auto;
    }
    #agrolinkSupportHeader button {
      background: none; border: none; color: #fff; font-size: 18px; cursor: pointer;
    }
    #agrolinkSupportHeaderActions { display: flex; align-items: center; gap: 10px; }
    #agrolinkSupportFaqBtn { font-size: 16px; }
    #agrolinkSupportFaqBtn.agrolink-support-faq-active { opacity: 0.7; }
    #agrolinkSupportFaqPanel {
      display: none; flex: 0 0 auto; max-height: 180px; overflow-y: auto;
      border-bottom: 1px solid #e2e2e2; background: #fafafa;
    }
    #agrolinkSupportFaqPanel.agrolink-support-faq-visible { display: block; }
    .agrolink-support-faq-hint { padding: 8px 10px 4px; font-size: 11px; color: #888; }
    .agrolink-support-faq-item {
      padding: 7px 10px; border-top: 1px solid #ececec; cursor: pointer;
    }
    .agrolink-support-faq-item:first-of-type { border-top: none; }
    .agrolink-support-faq-question {
      font-weight: 600; font-size: 12.5px; color: #2e7d32; line-height: 1.4;
    }
    .agrolink-support-faq-question::before { content: "▸ "; }
    .agrolink-support-faq-item.agrolink-support-faq-open .agrolink-support-faq-question::before { content: "▾ "; }
    .agrolink-support-faq-answer {
      display: none; font-size: 12px; color: #444; margin: 5px 0 2px 14px; line-height: 1.5;
    }
    .agrolink-support-faq-item.agrolink-support-faq-open .agrolink-support-faq-answer { display: block; }
    #agrolinkSupportMessages {
      flex: 1; overflow-y: auto; padding: 10px; background: #f7f7f7;
    }
    .agrolink-support-bubble-row { display: flex; margin-bottom: 8px; }
    .agrolink-support-bubble {
      max-width: 78%; padding: 7px 11px; border-radius: 10px; line-height: 1.4;
      word-wrap: break-word; white-space: pre-wrap;
    }
    .agrolink-support-bubble-user { background: #2e7d32; color: #fff; }
    .agrolink-support-bubble-admin { background: #e6e6e6; color: #222; }
    .agrolink-support-bubble-time { font-size: 10px; opacity: 0.7; margin-top: 3px; }
    #agrolinkSupportInputRow {
      display: flex; gap: 6px; padding: 8px; border-top: 1px solid #e2e2e2; background: #fff;
    }
    #agrolinkSupportInput {
      flex: 1; resize: none; border: 1px solid #ccc; border-radius: 8px;
      padding: 6px 8px; font-size: 13px; font-family: inherit; height: 36px;
    }
    #agrolinkSupportSendBtn {
      background: #2e7d32; color: #fff; border: none; border-radius: 8px;
      padding: 0 14px; cursor: pointer; font-size: 13px;
    }
    #agrolinkSupportSendBtn:disabled { opacity: 0.6; cursor: default; }
    .agrolink-support-empty { color: #888; text-align: center; margin-top: 30px; }
  `;
  document.head.appendChild(style);

  const toggleBtn = document.createElement("button");
  toggleBtn.id = "agrolinkSupportToggle";
  toggleBtn.type = "button";
  toggleBtn.title = "แชทกับทีมงาน AgroLink";
  toggleBtn.innerHTML = "💬";
  document.body.appendChild(toggleBtn);

  const panel = document.createElement("div");
  panel.id = "agrolinkSupportPanel";
  panel.innerHTML = `
    <div id="agrolinkSupportHeader">
      <span>💬 แชทกับทีมงาน AgroLink</span>
      <div id="agrolinkSupportHeaderActions">
        <button type="button" id="agrolinkSupportFaqBtn" aria-label="คำถามที่พบบ่อย" title="คำถามที่พบบ่อย">❓</button>
        <button type="button" id="agrolinkSupportCloseBtn" aria-label="ปิด">✕</button>
      </div>
    </div>
    <div id="agrolinkSupportFaqPanel">
      <div class="agrolink-support-faq-hint">คำถามที่พบบ่อย — แตะคำถามเพื่อดูคำตอบ</div>
      <div id="agrolinkSupportFaqList"></div>
    </div>
    <div id="agrolinkSupportMessages">
      <div class="agrolink-support-empty">กำลังโหลด…</div>
    </div>
    <div id="agrolinkSupportInputRow">
      <textarea id="agrolinkSupportInput" placeholder="พิมพ์ข้อความถึงทีมงาน…"></textarea>
      <button type="button" id="agrolinkSupportSendBtn">ส่ง</button>
    </div>
  `;
  document.body.appendChild(panel);

  function renderFaq() {
    const list = document.getElementById("agrolinkSupportFaqList");
    list.innerHTML = FAQ_ITEMS.map((item, idx) => `
      <div class="agrolink-support-faq-item" data-faq-index="${idx}">
        <div class="agrolink-support-faq-question">${supportEscapeHtml(item.q)}</div>
        <div class="agrolink-support-faq-answer">${supportEscapeHtml(item.a)}</div>
      </div>
    `).join("");
    list.querySelectorAll(".agrolink-support-faq-item").forEach((row) => {
      row.addEventListener("click", () => {
        row.classList.toggle("agrolink-support-faq-open");
      });
    });
  }
  renderFaq();

  let faqVisible = false;
  document.getElementById("agrolinkSupportFaqBtn").addEventListener("click", () => {
    faqVisible = !faqVisible;
    document.getElementById("agrolinkSupportFaqPanel").classList.toggle("agrolink-support-faq-visible", faqVisible);
    document.getElementById("agrolinkSupportFaqBtn").classList.toggle("agrolink-support-faq-active", faqVisible);
  });

  let isOpen = false;
  let hasUnseenReply = false;

  function renderBadge() {
    const existing = toggleBtn.querySelector(".agrolink-support-badge");
    if (hasUnseenReply && !isOpen) {
      if (!existing) {
        const badge = document.createElement("span");
        badge.className = "agrolink-support-badge";
        badge.textContent = "•";
        toggleBtn.appendChild(badge);
      }
    } else if (existing) {
      existing.remove();
    }
  }

  function renderMessages(messages) {
    const el = document.getElementById("agrolinkSupportMessages");
    if (!messages || messages.length === 0) {
      el.innerHTML = `<div class="agrolink-support-empty">เริ่มพิมพ์ข้อความเพื่อคุยกับทีมงาน AgroLink ได้เลย</div>`;
      return;
    }
    const wasAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    el.innerHTML = messages.map((m) => {
      const isAdmin = m.sender_role === "admin";
      return `
        <div class="agrolink-support-bubble-row" style="justify-content: ${isAdmin ? "flex-start" : "flex-end"};">
          <div class="agrolink-support-bubble ${isAdmin ? "agrolink-support-bubble-admin" : "agrolink-support-bubble-user"}">
            <div>${supportEscapeHtml(m.body)}</div>
            <div class="agrolink-support-bubble-time">${supportThaiTime(m.created_at)}</div>
          </div>
        </div>
      `;
    }).join("");
    if (wasAtBottom || messages.length <= 1) el.scrollTop = el.scrollHeight;
  }

  let lastMessageCount = 0;

  async function pollMessages(markRead) {
    try {
      const result = await supportRequest("/support/messages", { method: "GET" });
      const messages = result.messages || [];
      if (!markRead && messages.length > lastMessageCount) {
        const newest = messages[messages.length - 1];
        if (newest && newest.sender_role === "admin") hasUnseenReply = true;
      }
      lastMessageCount = messages.length;
      if (isOpen) renderMessages(messages);
      renderBadge();
    } catch (err) {
      // Silent — polling failure shouldn't interrupt whatever else the
      // user is doing on the page; the next poll tick will just retry.
    }
  }

  async function sendMessage() {
    const input = document.getElementById("agrolinkSupportInput");
    const body = input.value.trim();
    if (!body) return;
    const sendBtn = document.getElementById("agrolinkSupportSendBtn");
    sendBtn.disabled = true;
    try {
      await supportRequest("/support/messages", { method: "POST", body: JSON.stringify({ message: body }) });
      input.value = "";
      await pollMessages(true);
    } catch (err) {
      alert("ส่งข้อความไม่สำเร็จ: " + err.message);
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  toggleBtn.addEventListener("click", async () => {
    isOpen = !isOpen;
    panel.classList.toggle("agrolink-support-open", isOpen);
    if (isOpen) {
      hasUnseenReply = false;
      renderBadge();
      await pollMessages(true);
    }
  });
  document.getElementById("agrolinkSupportCloseBtn").addEventListener("click", () => {
    isOpen = false;
    panel.classList.remove("agrolink-support-open");
  });
  document.getElementById("agrolinkSupportSendBtn").addEventListener("click", sendMessage);
  document.getElementById("agrolinkSupportInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  pollMessages(false);
  setInterval(() => pollMessages(isOpen), 8000);
})();
