/**
 * AgroLink — Carbon Marketplace Buyer Widget — Phase 3 (see backend/db/
 * grant_carbon_module_marketplace.sql and backend/src/routes/buyercarbon.js
 * for the API this talks to).
 *
 * Self-contained (own inline <style>, no dependency on any page's existing
 * CSS) — same "one widget script, one <script> tag per page" convention as
 * js/carbon-module-widget.js (the seller-side equivalent) and js/group-
 * order-widget.js / js/support-widget.js. Renders into a page's own
 * <div id="carbonMarketplaceBuyerWidget"></div> placeholder; does nothing
 * if that element isn't present, or if no Buyer session is found in
 * localStorage (agrolink_buyer_session — see frontend/buyer/js/api.js).
 *
 * A Buyer here only creates/lists/cancels its own orders (how much credit
 * it wants, at what price) — it never sees or picks a specific seller's
 * listing directly. Matching an order to a seller's listing is done ONLY
 * by Platform Ops (see frontend/admin/js/dashboard.js's marketplace tab);
 * once matched, this widget shows the resulting match (project, matched
 * credit/price) read-only.
 */
(function () {
  const SESSION_KEY = 'agrolink_buyer_session';

  function getBuyerSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return (parsed && parsed.access_token) ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  const CMB_API_BASE = (['localhost', '127.0.0.1'].includes(window.location.hostname))
    ? 'http://localhost:4000'
    : 'https://agrolink-backend-vhv6.onrender.com';

  const ORDER_STATUS_LABEL_TH = {
    pending: 'รอจับคู่',
    matched: 'จับคู่แล้ว',
    completed: 'เสร็จสิ้น',
    cancelled: 'ยกเลิกแล้ว',
  };

  function cmbEscapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function cmbThaiDate(iso) {
    if (!iso) return '-';
    return new Date(iso).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function cmbNum(n) {
    const v = Number(n || 0);
    return v.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }

  function init() {
    const mount = document.getElementById('carbonMarketplaceBuyerWidget');
    if (!mount) return;

    const session = getBuyerSession();
    if (!session) return;
    const accessToken = session.access_token;

    async function cmbRequest(path, options) {
      const res = await fetch(`${CMB_API_BASE}/buyer-carbon${path}`, Object.assign({}, options, {
        headers: Object.assign(
          { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          (options && options.headers) || {},
        ),
      }));
      const isJson = (res.headers.get('content-type') || '').includes('application/json');
      const body = isJson ? await res.json().catch(() => null) : null;
      if (!res.ok) {
        const err = new Error((body && body.error) || `request_failed_${res.status}`);
        err.status = res.status;
        throw err;
      }
      return body;
    }
    const cmbGet = (path) => cmbRequest(path, { method: 'GET' });
    const cmbPost = (path, data) => cmbRequest(path, { method: 'POST', body: JSON.stringify(data || {}) });

    function cmbToast(message, isError) {
      let toastEl = document.getElementById('toast');
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.id = 'toast';
        toastEl.className = 'toast';
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = message;
      toastEl.classList.toggle('error', !!isError);
      toastEl.classList.add('show');
      setTimeout(() => toastEl.classList.remove('show'), 3200);
    }

    const style = document.createElement('style');
    style.textContent = `
      .cmb-panel { background: #fff; border-radius: var(--radius, 14px); box-shadow: var(--shadow, 0 2px 10px rgba(27,58,31,.08)); padding: 20px; margin-bottom: 16px; }
      .cmb-desc { font-size: 13px; color: var(--gray-500, #8a938a); margin: -10px 0 16px; }
      .cmb-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
      .cmb-btn { display: inline-flex; align-items: center; gap: 6px; border: none; border-radius: 9px; padding: 10px 16px; font-size: 14px; font-weight: 600; font-family: inherit; cursor: pointer; background: var(--green-700, #2e7d32); color: #fff; transition: background .15s ease; }
      .cmb-btn:hover { background: var(--green-900, #1b3a1f); }
      .cmb-btn.cmb-btn-secondary { background: var(--gray-200, #e7ebe7); color: var(--gray-800, #333); }
      .cmb-btn.cmb-btn-secondary:hover { background: var(--gray-300, #d6dcd6); }
      .cmb-btn.cmb-btn-danger { background: #c62828; }
      .cmb-btn.cmb-btn-danger:hover { background: #8e1c1c; }
      .cmb-btn:disabled { opacity: .5; cursor: not-allowed; }
      .cmb-form { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); align-items: end; margin-bottom: 14px; padding: 14px; border: 1px dashed var(--gray-300, #d6dcd6); border-radius: 10px; }
      .cmb-field { display: flex; flex-direction: column; gap: 4px; }
      .cmb-field label { font-size: 12.5px; font-weight: 600; color: var(--gray-700, #4a524a); }
      .cmb-field input, .cmb-field textarea { padding: 8px 10px; border: 1px solid var(--gray-300, #d6dcd6); border-radius: 8px; font-family: inherit; font-size: 13.5px; }
      .cmb-field-full { grid-column: 1 / -1; }
      .cmb-order-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--gray-100, #f0f2f0); flex-wrap: wrap; }
      .cmb-order-row:last-child { border-bottom: none; }
      .cmb-order-name { font-size: 14px; font-weight: 600; }
      .cmb-order-sub { font-size: 12px; color: var(--gray-500, #8a938a); }
      .cmb-empty { font-size: 13.5px; color: var(--gray-500, #8a938a); padding: 10px 0; }
    `;
    document.head.appendChild(style);

    let orders = [];
    let showCreateForm = false;

    async function loadOrders() {
      try {
        const data = await cmbGet('/orders');
        orders = data.orders || [];
      } catch (err) {
        cmbToast(`โหลดคำสั่งซื้อไม่สำเร็จ: ${err.message}`, true);
      }
    }

    function renderCreateForm() {
      if (!showCreateForm) {
        return `<div class="cmb-row"><div></div><button type="button" class="cmb-btn" id="cmbShowCreateBtn">＋ สร้างคำสั่งซื้อคาร์บอนเครดิตใหม่</button></div>`;
      }
      return `
        <form class="cmb-form" id="cmbCreateForm">
          <div class="cmb-field">
            <label for="cmbRequestedCredit">ปริมาณที่ต้องการซื้อ (tCO2e) *</label>
            <input type="number" id="cmbRequestedCredit" min="0.0001" step="0.0001" required />
          </div>
          <div class="cmb-field">
            <label for="cmbOfferedPrice">ราคาที่เสนอ (บาท/tCO2e) *</label>
            <input type="number" id="cmbOfferedPrice" min="0.01" step="0.01" required />
          </div>
          <div class="cmb-field cmb-field-full">
            <label for="cmbOrderNote">หมายเหตุ (ถ้ามี)</label>
            <textarea id="cmbOrderNote" rows="2"></textarea>
          </div>
          <div class="cmb-field-full" style="display:flex; gap:8px;">
            <button type="submit" class="cmb-btn">บันทึกคำสั่งซื้อ</button>
            <button type="button" class="cmb-btn cmb-btn-secondary" id="cmbCancelCreateBtn">ยกเลิก</button>
          </div>
        </form>
      `;
    }

    function renderOrderRow(o) {
      const isMatched = o.status === 'matched' || o.status === 'completed';
      return `
        <div class="cmb-order-row">
          <div>
            <div class="cmb-order-name">${cmbNum(o.requested_credit_tco2e)} tCO2e @ ${cmbNum(o.offered_price_per_tco2e)} บาท/tCO2e เสนอ</div>
            <div class="cmb-order-sub">
              สถานะ: ${ORDER_STATUS_LABEL_TH[o.status] || o.status}${o.note ? ` · ${cmbEscapeHtml(o.note)}` : ''} · สร้างเมื่อ ${cmbThaiDate(o.created_at)}
              ${isMatched ? `<br/>จับคู่แล้ว: ${cmbEscapeHtml(o.matched_project_name || '-')} — ${cmbNum(o.matched_credit_tco2e)} tCO2e @ ${cmbNum(o.matched_price_per_tco2e)} บาท/tCO2e` : ''}
            </div>
          </div>
          ${o.status === 'pending' ? `<button type="button" class="cmb-btn cmb-btn-danger" data-cancel-order-id="${cmbEscapeHtml(o.order_id)}">ยกเลิกคำสั่งซื้อ</button>` : ''}
        </div>
      `;
    }

    function render() {
      mount.innerHTML = `
        <div class="cmb-panel">
          <div style="font-size:14px; font-weight:700; color:var(--gray-800, #333); margin-bottom:8px;">🌱 ตลาดซื้อขายคาร์บอนเครดิต</div>
          <p class="cmb-desc">แจ้งความต้องการซื้อคาร์บอนเครดิต (ปริมาณ + ราคาที่เสนอ) — ฝ่ายปฏิบัติการของ AgroLink จะจับคู่คำสั่งซื้อของท่านกับประกาศขายจากผู้ขายที่เหมาะสมด้วยตนเอง แล้วผลการจับคู่จะปรากฏที่นี่</p>
          ${renderCreateForm()}
          ${orders.length === 0 ? '<div class="cmb-empty">ยังไม่มีคำสั่งซื้อ — เริ่มสร้างคำสั่งซื้อแรกได้ด้านบน</div>' : orders.map(renderOrderRow).join('')}
        </div>
      `;
      attachHandlers();
    }

    function attachHandlers() {
      const showBtn = document.getElementById('cmbShowCreateBtn');
      if (showBtn) showBtn.addEventListener('click', () => { showCreateForm = true; render(); });

      const cancelBtn = document.getElementById('cmbCancelCreateBtn');
      if (cancelBtn) cancelBtn.addEventListener('click', () => { showCreateForm = false; render(); });

      const createForm = document.getElementById('cmbCreateForm');
      if (createForm) {
        createForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const requestedCreditTco2e = parseFloat(document.getElementById('cmbRequestedCredit').value || '0');
          const offeredPricePerTco2e = parseFloat(document.getElementById('cmbOfferedPrice').value || '0');
          const note = document.getElementById('cmbOrderNote').value.trim();
          if (!(requestedCreditTco2e > 0) || !(offeredPricePerTco2e > 0)) {
            cmbToast('กรุณาระบุปริมาณและราคาที่มากกว่า 0', true);
            return;
          }
          try {
            await cmbPost('/orders', {
              requested_credit_tco2e: requestedCreditTco2e, offered_price_per_tco2e: offeredPricePerTco2e, note: note || null,
            });
            cmbToast('บันทึกคำสั่งซื้อเรียบร้อยแล้ว');
            showCreateForm = false;
            await loadOrders();
            render();
          } catch (err) {
            cmbToast(`บันทึกคำสั่งซื้อไม่สำเร็จ: ${err.message}`, true);
          }
        });
      }

      mount.querySelectorAll('[data-cancel-order-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const orderId = btn.dataset.cancelOrderId;
          try {
            await cmbPost(`/orders/${orderId}/cancel`, {});
            cmbToast('ยกเลิกคำสั่งซื้อแล้ว');
            await loadOrders();
            render();
          } catch (err) {
            cmbToast(`ยกเลิกไม่สำเร็จ: ${err.message}`, true);
          }
        });
      });
    }

    (async () => {
      mount.innerHTML = `<div class="cmb-panel"><div class="cmb-empty">กำลังโหลดข้อมูลตลาดซื้อขายคาร์บอนเครดิต...</div></div>`;
      await loadOrders();
      render();
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
