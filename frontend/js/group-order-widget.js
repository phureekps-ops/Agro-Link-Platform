/**
 * AgroLink — Group Order Widget (รวมออเดอร์ซื้อสินค้าเกษตร) — added per
 * user request to let farmers, cooperatives, and village funds submit a
 * multi-product purchase request (custom-mixed fertilizer, rice seed,
 * feed corn seed, chemical fertilizer — each with its own qty/unit, plus
 * a free-text "additional details" field) so requests can eventually be
 * pooled together for a better price.
 *
 * UI PREVIEW ONLY, same "no backend yet" scope as js/support-widget.js's
 * sibling comment would suggest if it existed — there is deliberately no
 * new DB table or API route behind this yet (see the user's own explicit
 * choice: "แบบฟอร์ม UI ไว้ก่อน"). Submitting just shows a confirmation
 * toast and clears the form; nothing is persisted. When a real backend is
 * ready, this is the one file to rewire (swap the mock submit handler for
 * a real POST) rather than touching all three portals separately.
 *
 * Self-contained (own inline <style>, no dependency on any page's
 * existing CSS) so the SAME script tag can be dropped into every portal's
 * dashboard.html unchanged — same "one widget script, one <script> tag
 * per page" convention as js/support-widget.js. Renders into a page's
 * own <div id="groupOrderWidget"></div> placeholder; does nothing if that
 * element isn't present on the page.
 */
(function () {
  const PRODUCTS = [
    { key: "fertilizer_custom", name: "ปุ๋ยสั่งตัด", units: ["กระสอบ", "กก.", "ตัน"] },
    { key: "rice_seed", name: "เมล็ดพันธุ์ข้าว", units: ["กระสอบ", "กก."] },
    { key: "corn_seed", name: "เมล็ดพันธุ์ข้าวโพดเลี้ยงสัตว์", units: ["กระสอบ", "กก."] },
    { key: "chemical_fertilizer", name: "ปุ๋ยเคมี", units: ["กระสอบ", "กก.", "ตัน"] },
  ];

  function init() {
    const mount = document.getElementById("groupOrderWidget");
    if (!mount) return;

    const style = document.createElement("style");
    style.textContent = `
      .go-panel { background: #fff; border-radius: var(--radius, 14px); box-shadow: var(--shadow, 0 2px 10px rgba(27,58,31,.08)); padding: 20px; }
      .go-desc { font-size: 13px; color: var(--gray-500, #8a938a); margin: -10px 0 16px; }
      .go-product-list { display: flex; flex-direction: column; gap: 10px; }
      .go-product-row {
        display: flex; align-items: center; flex-wrap: wrap; gap: 10px;
        padding: 12px 14px; border: 1px solid var(--gray-300, #d6dcd6); border-radius: 10px;
        cursor: pointer; transition: border-color .15s ease, background .15s ease;
      }
      .go-product-row.go-selected { border-color: var(--green-600, #388e3c); background: var(--green-100, #e8f5e9); }
      .go-product-row .go-check { width: 18px; height: 18px; accent-color: var(--green-700, #2e7d32); flex: none; cursor: pointer; }
      .go-product-name { font-size: 14.5px; font-weight: 600; color: var(--gray-900, #262b26); flex: 1; min-width: 160px; }
      .go-qty-fields { display: flex; gap: 8px; opacity: .45; pointer-events: none; transition: opacity .15s ease; }
      .go-product-row.go-selected .go-qty-fields { opacity: 1; pointer-events: auto; }
      .go-qty-fields .go-qty {
        width: 90px; padding: 8px 10px; border: 1px solid var(--gray-300, #d6dcd6); border-radius: 8px;
        font-family: inherit; font-size: 13.5px;
      }
      .go-qty-fields .go-unit {
        padding: 8px 10px; border: 1px solid var(--gray-300, #d6dcd6); border-radius: 8px;
        font-family: inherit; font-size: 13.5px; background: #fff;
      }
      .go-details-field { margin-top: 16px; }
      .go-details-field label { display: block; font-size: 13px; font-weight: 600; color: var(--gray-700, #4a524a); margin-bottom: 6px; }
      .go-details-field textarea {
        width: 100%; padding: 11px 12px; border: 1px solid var(--gray-300, #d6dcd6); border-radius: 8px;
        font-size: 15px; font-family: inherit; background: var(--gray-50, #f7f8f6); resize: vertical;
      }
      .go-details-field textarea:focus { outline: none; border-color: var(--green-600, #388e3c); background: #fff; }
      .go-submit-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        border: none; border-radius: 9px; padding: 11px 18px; font-size: 15px; font-weight: 600;
        font-family: inherit; cursor: pointer; margin-top: 16px; width: 100%;
        background: var(--green-700, #2e7d32); color: #fff; transition: background .15s ease;
      }
      .go-submit-btn:hover { background: var(--green-900, #1b3a1f); }
      .go-note { font-size: 12px; color: var(--gray-500, #8a938a); margin-top: 10px; }
      @media (max-width: 480px) {
        .go-product-row { flex-direction: column; align-items: stretch; }
        .go-qty-fields { width: 100%; }
        .go-qty-fields .go-qty { flex: 1; width: auto; }
      }
    `;
    document.head.appendChild(style);

    const rowsHtml = PRODUCTS.map((p) => {
      const optionsHtml = p.units.map((u) => `<option value="${u}">${u}</option>`).join("");
      return `
        <label class="go-product-row" data-product-row="${p.key}">
          <input type="checkbox" class="go-check" data-product="${p.key}" />
          <span class="go-product-name">${p.name}</span>
          <span class="go-qty-fields">
            <input type="number" min="0" step="0.01" class="go-qty" placeholder="จำนวน" disabled />
            <select class="go-unit" disabled>${optionsHtml}</select>
          </span>
        </label>
      `;
    }).join("");

    mount.innerHTML = `
      <div class="section-title">🛒 รวมออเดอร์ซื้อสินค้าเกษตร</div>
      <p class="go-desc">เลือกสินค้าที่ต้องการสั่งซื้อได้มากกว่า 1 ชนิด ระบุจำนวนของแต่ละรายการ เพื่อรวมออเดอร์กับสาชิกรายอื่นและได้ราคาที่ดีขึ้น</p>
      <div class="go-panel">
        <div class="go-product-list">${rowsHtml}</div>
        <div class="go-details-field">
          <label for="goDetails">รายละเอียดสินค้าเพิ่มเติม (ถ้ามี)</label>
          <textarea id="goDetails" rows="3" placeholder="เช่น สูตรปุ๋ย, สายพันธุ์ข้าว, ยี่ห้อที่ต้องการ ฯลฯ"></textarea>
        </div>
        <button type="button" class="go-submit-btn" id="goSubmitBtn">ส่งคำขอรวมออเดอร์</button>
        <div class="go-note">* ขณะนี้เป็นฟีเจอร์ตัวอย่าง ระบบรวมออเดอร์จริงยังอยู่ระหว่างพัฒนา ทีมงานจะติดต่อกลับเมื่อพร้อมใช้งาน</div>
      </div>
    `;

    mount.querySelectorAll(".go-product-row").forEach((row) => {
      const checkbox = row.querySelector(".go-check");
      const qtyInput = row.querySelector(".go-qty");
      const unitSelect = row.querySelector(".go-unit");
      checkbox.addEventListener("change", () => {
        const checked = checkbox.checked;
        row.classList.toggle("go-selected", checked);
        qtyInput.disabled = !checked;
        unitSelect.disabled = !checked;
        if (!checked) qtyInput.value = "";
      });
    });

    function showToast(message, isError) {
      let toast = document.getElementById("toast");
      if (!toast) {
        toast = document.createElement("div");
        toast.id = "toast";
        toast.className = "toast";
        document.body.appendChild(toast);
      }
      toast.textContent = message;
      toast.classList.toggle("error", !!isError);
      toast.classList.add("show");
      setTimeout(() => toast.classList.remove("show"), 3200);
    }

    const submitBtn = mount.querySelector("#goSubmitBtn");
    submitBtn.addEventListener("click", () => {
      const selected = [];
      mount.querySelectorAll(".go-product-row").forEach((row) => {
        const checkbox = row.querySelector(".go-check");
        if (checkbox.checked) {
          selected.push({
            product: checkbox.dataset.product,
            qty: row.querySelector(".go-qty").value || null,
            unit: row.querySelector(".go-unit").value,
          });
        }
      });
      if (selected.length === 0) {
        showToast("กรุณาเลือกสินค้าอย่างน้อข 1 ชนิดค่ะ", true);
        return;
      }
      // UI preview only — nothing is sent to a server yet.
      mount.querySelectorAll(".go-check").forEach((cb) => {
        cb.checked = false;
        cb.dispatchEvent(new Event("change"));
      });
      const detailsField = mount.querySelector("#goDetails");
      if (detailsField) detailsField.value = "";
      showToast("ส่งคำขอรวมออเดอร์เรียบร้อยค่ะ ทีมงานจะติดต่อกลับเมื่อสามารถรวมออเดอร์กับสมาชิกรายอื่นได้");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
