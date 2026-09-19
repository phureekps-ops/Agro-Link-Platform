/**
 * AgroLink — Carbon Module Widget (โมดูลคาร์บอนเครดิตระดับองค์กร) —
 * Phase 1 (see backend/db/grant_carbon_module_portal_aggregation.sql and
 * backend/src/lib/carbonAggregation.js for the schema/API this talks to).
 *
 * Self-contained (own inline <style>, no dependency on any page's existing
 * CSS) so the SAME script tag can be dropped into every portal's
 * dashboard.html unchanged — same "one widget script, one <script> tag per
 * page" convention as js/group-order-widget.js and js/support-widget.js.
 * Renders into a page's own <div id="carbonModuleWidget"></div>
 * placeholder; does nothing if that element isn't present on the page.
 *
 * Session lookup follows js/support-widget.js's own pattern rather than
 * depending on the page's own "AgroLinkXxxAPI" object: reads the
 * access_token directly out of whichever portal's own localStorage session
 * key is present, and derives the matching API prefix from THAT key — the
 * page including this script only ever has ONE of the three populated (its
 * own portal's session), so this doubles as portal detection without
 * hardcoding which dashboard.html loaded it.
 *
 * Every request here is GET/POST only, matching the backend's own GET/
 * POST-only route design (driven by frontend/communityenterprise/js/
 * api.js not exposing put/del — see coopcarbon.js's header comment).
 */
(function () {
  const SESSION_KEY_TO_PREFIX = {
    agrolink_coop_session: '/coop-carbon',
    agrolink_communityenterprise_session: '/communityenterprise-carbon',
    agrolink_villagefund_session: '/villagefund-carbon',
  };

  function getCarbonSession() {
    for (const key of Object.keys(SESSION_KEY_TO_PREFIX)) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.access_token) {
          return { accessToken: parsed.access_token, apiPrefix: SESSION_KEY_TO_PREFIX[key] };
        }
      } catch (e) {
        // Not this key's session — keep checking the rest.
      }
    }
    return null;
  }

  const CM_API_BASE = (['localhost', '127.0.0.1'].includes(window.location.hostname))
    ? 'http://localhost:4000'
    : 'https://agrolink-backend-vhv6.onrender.com';

  const PROJECT_STATUS_LABEL_TH = {
    draft: 'ร่าง',
    mrv_prep: 'เตรียมข้อมูล MRV',
    submitted_to_tver: 'ยื่น T-VER แล้ว',
    registered: 'ขึ้นทะเบียนแล้ว',
    credits_issued: 'ออกเครดิตแล้ว',
  };
  const PROJECT_STATUSES = Object.keys(PROJECT_STATUS_LABEL_TH);

  function cmEscapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function cmThaiDate(iso) {
    if (!iso) return '-';
    return new Date(iso).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function cmNum(n) {
    const v = Number(n || 0);
    return v.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }

  function init() {
    const mount = document.getElementById('carbonModuleWidget');
    if (!mount) return;

    const session = getCarbonSession();
    if (!session) {
      // No recognized session on this page yet (e.g. reached before login
      // finished) — don't render a widget that can't call any endpoint.
      return;
    }
    const { accessToken, apiPrefix } = session;

    async function cmRequest(path, options) {
      const res = await fetch(`${CM_API_BASE}${apiPrefix}${path}`, Object.assign({}, options, {
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
    const cmGet = (path) => cmRequest(path, { method: 'GET' });
    const cmPost = (path, data) => cmRequest(path, { method: 'POST', body: JSON.stringify(data || {}) });

    function cmToast(message, isError) {
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
      .cm-panel { background: #fff; border-radius: var(--radius, 14px); box-shadow: var(--shadow, 0 2px 10px rgba(27,58,31,.08)); padding: 20px; margin-bottom: 16px; }
      .cm-desc { font-size: 13px; color: var(--gray-500, #8a938a); margin: -10px 0 16px; }
      .cm-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
      .cm-btn { display: inline-flex; align-items: center; gap: 6px; border: none; border-radius: 9px; padding: 10px 16px; font-size: 14px; font-weight: 600; font-family: inherit; cursor: pointer; background: var(--green-700, #2e7d32); color: #fff; transition: background .15s ease; }
      .cm-btn:hover { background: var(--green-900, #1b3a1f); }
      .cm-btn.cm-btn-secondary { background: var(--gray-200, #e7ebe7); color: var(--gray-800, #333); }
      .cm-btn.cm-btn-secondary:hover { background: var(--gray-300, #d6dcd6); }
      .cm-btn.cm-btn-danger { background: #c62828; }
      .cm-btn.cm-btn-danger:hover { background: #8e1c1c; }
      .cm-btn:disabled { opacity: .5; cursor: not-allowed; }
      .cm-form { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); align-items: end; margin-bottom: 14px; padding: 14px; border: 1px dashed var(--gray-300, #d6dcd6); border-radius: 10px; }
      .cm-field { display: flex; flex-direction: column; gap: 4px; }
      .cm-field label { font-size: 12.5px; font-weight: 600; color: var(--gray-700, #4a524a); }
      .cm-field input, .cm-field select, .cm-field textarea { padding: 8px 10px; border: 1px solid var(--gray-300, #d6dcd6); border-radius: 8px; font-family: inherit; font-size: 13.5px; }
      .cm-field-full { grid-column: 1 / -1; }
      .cm-project-card { border: 1px solid var(--gray-300, #d6dcd6); border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; cursor: pointer; transition: border-color .15s ease; }
      .cm-project-card:hover { border-color: var(--green-600, #388e3c); }
      .cm-project-card.cm-expanded { border-color: var(--green-600, #388e3c); background: var(--green-50, #f3f9f3); cursor: default; }
      .cm-project-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
      .cm-project-name { font-size: 15.5px; font-weight: 700; color: var(--gray-900, #262b26); }
      .cm-badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--green-100, #e8f5e9); color: var(--green-800, #1b5e20); }
      .cm-badge.cm-badge-draft { background: var(--gray-200, #e7ebe7); color: var(--gray-700, #4a524a); }
      .cm-project-meta { font-size: 12.5px; color: var(--gray-500, #8a938a); margin-top: 4px; }
      .cm-detail { margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--gray-300, #d6dcd6); }
      .cm-member-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--gray-100, #f0f2f0); flex-wrap: wrap; }
      .cm-member-row:last-child { border-bottom: none; }
      .cm-member-name { font-size: 14px; font-weight: 600; }
      .cm-member-sub { font-size: 12px; color: var(--gray-500, #8a938a); }
      .cm-member-row.cm-removed { opacity: .5; }
      .cm-eligible-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--gray-100, #f0f2f0); }
      .cm-eligible-row:last-child { border-bottom: none; }
      .cm-check { width: 17px; height: 17px; accent-color: var(--green-700, #2e7d32); flex: none; }
      .cm-empty { font-size: 13.5px; color: var(--gray-500, #8a938a); padding: 10px 0; }
      .cm-section-title { font-size: 14px; font-weight: 700; color: var(--gray-800, #333); margin: 14px 0 8px; }
      @media (max-width: 480px) { .cm-project-head { flex-direction: column; align-items: flex-start; } }
    `;
    document.head.appendChild(style);

    let projects = [];
    let eligible = [];
    let expandedProjectId = null;
    let expandedDetail = null;
    let showCreateForm = false;

    async function loadProjects() {
      try {
        const data = await cmGet('/projects');
        projects = data.projects || [];
      } catch (err) {
        cmToast(`โหลดรายการโครงการไม่สำเร็จ: ${err.message}`, true);
      }
    }

    async function loadEligible() {
      try {
        const data = await cmGet('/eligible-assessments');
        eligible = data.assessments || [];
      } catch (err) {
        cmToast(`โหลดรายชื่อเกษตรกรที่พร้อมเข้าร่วมไม่สำเร็จ: ${err.message}`, true);
      }
    }

    async function loadDetail(projectId) {
      try {
        expandedDetail = await cmGet(`/projects/${projectId}`);
      } catch (err) {
        cmToast(`โหลดรายละเอียดโครงการไม่สำเร็จ: ${err.message}`, true);
        expandedDetail = null;
      }
    }

    function renderCreateForm() {
      if (!showCreateForm) {
        return `<div class="cm-row"><div></div><button type="button" class="cm-btn" id="cmShowCreateBtn">＋ สร้างโครงการคาร์บอนใหม่</button></div>`;
      }
      return `
        <form class="cm-form" id="cmCreateForm">
          <div class="cm-field cm-field-full">
            <label for="cmProjectName">ชื่อโครงการ *</label>
            <input type="text" id="cmProjectName" placeholder="เช่น โครงการคาร์บอนข้าว AWD รุ่นที่ 1" required />
          </div>
          <div class="cm-field">
            <label for="cmFarmerPoolPct">ส่วนแบ่งเกษตรกร (%)</label>
            <input type="number" id="cmFarmerPoolPct" min="0" max="100" step="0.01" value="80.00" />
          </div>
          <div class="cm-field">
            <label for="cmPlatformFeePct">ค่าธรรมเนียม AgroLink (%)</label>
            <input type="number" id="cmPlatformFeePct" min="0" max="100" step="0.01" value="10.00" />
          </div>
          <div class="cm-field cm-field-full">
            <label for="cmProjectNote">หมายเหตุ (ถ้ามี)</label>
            <textarea id="cmProjectNote" rows="2"></textarea>
          </div>
          <div class="cm-field-full" style="display:flex; gap:8px;">
            <button type="submit" class="cm-btn">บันทึกโครงการ</button>
            <button type="button" class="cm-btn cm-btn-secondary" id="cmCancelCreateBtn">ยกเลิก</button>
          </div>
        </form>
      `;
    }

    function renderEligibleList(projectId) {
      if (eligible.length === 0) {
        return `<div class="cm-empty">ไม่มีเกษตรกรสมาชิกที่ผ่านการยืนยัน (verified) และยังไม่ถูกเพิ่มเข้าโครงการใดในขณะนี้</div>`;
      }
      const rows = eligible.map((a) => `
        <label class="cm-eligible-row">
          <input type="checkbox" class="cm-check" data-assessment-id="${cmEscapeHtml(a.assessment_id)}" />
          <span class="cm-member-name">${cmEscapeHtml(a.farmer_name)} <span class="cm-member-sub">(${cmEscapeHtml(a.farmer_code || '-')})</span></span>
          <span class="cm-member-sub">${cmNum(a.area_rai)} ไร่ · ประมาณ ${cmNum(a.estimated_credit_tco2e)} tCO2e</span>
        </label>
      `).join('');
      return `
        <div class="cm-section-title">เกษตรกรสมาชิกที่พร้อมเข้าร่วม (verified แล้ว)</div>
        ${rows}
        <div style="margin-top:10px;">
          <button type="button" class="cm-btn" id="cmAddMembersBtn" data-project-id="${cmEscapeHtml(projectId)}">เพิ่มที่เลือกเข้าโครงการนี้</button>
        </div>
      `;
    }

    function renderMemberList(detail) {
      const activeMembers = detail.members.filter((m) => m.status === 'active');
      const removedMembers = detail.members.filter((m) => m.status !== 'active');
      if (activeMembers.length === 0 && removedMembers.length === 0) {
        return `<div class="cm-empty">ยังไม่มีสมาชิกในโครงการนี้</div>`;
      }
      const rowsHtml = (rows) => rows.map((m) => `
        <div class="cm-member-row ${m.status !== 'active' ? 'cm-removed' : ''}">
          <div>
            <div class="cm-member-name">${cmEscapeHtml(m.farmer_name)} <span class="cm-member-sub">(${cmEscapeHtml(m.farmer_code || '-')})</span></div>
            <div class="cm-member-sub">${cmNum(m.area_rai)} ไร่ · จัดสรร ${cmNum(m.allocated_credit_tco2e)} tCO2e · เพิ่มเมื่อ ${cmThaiDate(m.added_at)}</div>
          </div>
          ${m.status === 'active' ? `<button type="button" class="cm-btn cm-btn-danger" data-remove-member-id="${cmEscapeHtml(m.member_id)}">ถอดออก</button>` : `<span class="cm-member-sub">ถอดออกแล้ว</span>`}
        </div>
      `).join('');
      return `${rowsHtml(activeMembers)}${removedMembers.length ? `<div class="cm-section-title">ประวัติที่ถอดออกแล้ว</div>${rowsHtml(removedMembers)}` : ''}`;
    }

    function renderProjectDetail(detail) {
      const p = detail.project;
      const statusOptions = PROJECT_STATUSES.map((s) => `<option value="${s}" ${s === p.status ? 'selected' : ''}>${PROJECT_STATUS_LABEL_TH[s]}</option>`).join('');
      return `
        <div class="cm-detail">
          <form class="cm-form" id="cmSettingsForm" data-project-id="${cmEscapeHtml(p.project_id)}">
            <div class="cm-field">
              <label>สถานะโครงการ</label>
              <select id="cmStatus">${statusOptions}</select>
            </div>
            <div class="cm-field">
              <label>ส่วนแบ่งเกษตรกร (%)</label>
              <input type="number" id="cmEditFarmerPoolPct" min="0" max="100" step="0.01" value="${cmEscapeHtml(p.farmer_pool_pct)}" />
            </div>
            <div class="cm-field">
              <label>ค่าธรรมเนียม AgroLink (%)</label>
              <input type="number" id="cmEditPlatformFeePct" min="0" max="100" step="0.01" value="${cmEscapeHtml(p.platform_fee_pct)}" />
            </div>
            <div class="cm-field-full">
              <button type="submit" class="cm-btn cm-btn-secondary">บันทึกการตั้งค่าโครงการ</button>
            </div>
          </form>
          <div class="cm-section-title">สมาชิกในโครงการ (${detail.members.filter((m) => m.status === 'active').length} คน)</div>
          ${renderMemberList(detail)}
          ${renderEligibleList(p.project_id)}
        </div>
      `;
    }

    function renderProjectCard(p) {
      const isExpanded = expandedProjectId === p.project_id;
      const badgeClass = p.status === 'draft' ? 'cm-badge cm-badge-draft' : 'cm-badge';
      return `
        <div class="cm-project-card ${isExpanded ? 'cm-expanded' : ''}" data-project-id="${cmEscapeHtml(p.project_id)}">
          <div class="cm-project-head">
            <div>
              <span class="cm-project-name">${cmEscapeHtml(p.project_name)}</span>
              <span class="${badgeClass}">${PROJECT_STATUS_LABEL_TH[p.status] || p.status}</span>
            </div>
            <div class="cm-project-meta">${p.member_count} สมาชิก · รวม ${cmNum(p.total_allocated_tco2e)} tCO2e</div>
          </div>
          <div class="cm-project-meta">แบ่งเกษตรกร ${cmNum(p.farmer_pool_pct)}% / ค่าธรรมเนียม ${cmNum(p.platform_fee_pct)}% · สร้างเมื่อ ${cmThaiDate(p.created_at)}</div>
          ${isExpanded && expandedDetail ? renderProjectDetail(expandedDetail) : ''}
        </div>
      `;
    }

    function render() {
      mount.innerHTML = `
        <div class="cm-panel">
          <div class="cm-section-title" style="margin-top:0;">🌱 คาร์บอนเครดิต — รวมกลุ่มระดับองค์กร</div>
          <p class="cm-desc">รวบรวมผลประเมินคาร์บอนเครดิต (AWD) ของสมาชิกที่ผ่านการยืนยันแล้ว เข้าเป็นโครงการคาร์บอนเดียวขององค์กร เพื่อเตรียมยื่นขอรับรองและขายจริงต่อไป</p>
          ${renderCreateForm()}
          ${projects.length === 0 ? '<div class="cm-empty">ยังไม่มีโครงการคาร์บอน — เริ่มสร้างโครงการแรกได้ด้านบน</div>' : projects.map(renderProjectCard).join('')}
        </div>
      `;
      attachHandlers();
    }

    function attachHandlers() {
      const showBtn = document.getElementById('cmShowCreateBtn');
      if (showBtn) showBtn.addEventListener('click', () => { showCreateForm = true; render(); });

      const cancelBtn = document.getElementById('cmCancelCreateBtn');
      if (cancelBtn) cancelBtn.addEventListener('click', () => { showCreateForm = false; render(); });

      const createForm = document.getElementById('cmCreateForm');
      if (createForm) {
        createForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const projectName = document.getElementById('cmProjectName').value.trim();
          if (!projectName) return;
          const farmerPoolPct = parseFloat(document.getElementById('cmFarmerPoolPct').value || '80');
          const platformFeePct = parseFloat(document.getElementById('cmPlatformFeePct').value || '10');
          const note = document.getElementById('cmProjectNote').value.trim();
          try {
            await cmPost('/projects', {
              project_name: projectName, farmer_pool_pct: farmerPoolPct, platform_fee_pct: platformFeePct, note: note || null,
            });
            cmToast('สร้างโครงการเรียบร้อยแล้ว');
            showCreateForm = false;
            await loadProjects();
            render();
          } catch (err) {
            cmToast(`สร้างโครงการไม่สำเร็จ: ${err.message}`, true);
          }
        });
      }

      mount.querySelectorAll('.cm-project-card').forEach((card) => {
        card.addEventListener('click', async (e) => {
          if (e.target.closest('form') || e.target.closest('button') || e.target.closest('label')) return;
          const projectId = card.dataset.projectId;
          if (expandedProjectId === projectId) {
            expandedProjectId = null;
            expandedDetail = null;
            render();
            return;
          }
          expandedProjectId = projectId;
          await Promise.all([loadDetail(projectId), loadEligible()]);
          render();
        });
      });

      const settingsForm = document.getElementById('cmSettingsForm');
      if (settingsForm) {
        settingsForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const projectId = settingsForm.dataset.projectId;
          const status = document.getElementById('cmStatus').value;
          const farmerPoolPct = parseFloat(document.getElementById('cmEditFarmerPoolPct').value || '0');
          const platformFeePct = parseFloat(document.getElementById('cmEditPlatformFeePct').value || '0');
          try {
            await cmPost(`/projects/${projectId}/update`, {
              status, farmer_pool_pct: farmerPoolPct, platform_fee_pct: platformFeePct,
            });
            cmToast('บันทึกการตั้งค่าโครงการแล้ว');
            await Promise.all([loadProjects(), loadDetail(projectId)]);
            render();
          } catch (err) {
            cmToast(`บันทึกไม่สำเร็จ: ${err.message}`, true);
          }
        });
      }

      const addMembersBtn = document.getElementById('cmAddMembersBtn');
      if (addMembersBtn) {
        addMembersBtn.addEventListener('click', async () => {
          const projectId = addMembersBtn.dataset.projectId;
          const checked = Array.from(mount.querySelectorAll('.cm-check:checked')).map((cb) => cb.dataset.assessmentId);
          if (checked.length === 0) {
            cmToast('กรุณาเลือกเกษตรกรอย่างน้อย 1 คน', true);
            return;
          }
          try {
            const result = await cmPost(`/projects/${projectId}/members`, { assessment_ids: checked });
            if (result.failed && result.failed.length > 0) {
              cmToast(`เพิ่มสำเร็จ ${result.added.length} คน, ไม่สำเร็จ ${result.failed.length} คน`, result.added.length === 0);
            } else {
              cmToast(`เพิ่มสมาชิกเข้าโครงการสำเร็จ ${result.added.length} คน`);
            }
            await Promise.all([loadProjects(), loadDetail(projectId), loadEligible()]);
            render();
          } catch (err) {
            cmToast(`เพิ่มสมาชิกไม่สำเร็จ: ${err.message}`, true);
          }
        });
      }

      mount.querySelectorAll('[data-remove-member-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const projectId = expandedProjectId;
          const memberId = btn.dataset.removeMemberId;
          try {
            await cmPost(`/projects/${projectId}/members/${memberId}/remove`, {});
            cmToast('ถอดสมาชิกออกจากโครงการแล้ว');
            await Promise.all([loadProjects(), loadDetail(projectId), loadEligible()]);
            render();
          } catch (err) {
            cmToast(`ถอดสมาชิกไม่สำเร็จ: ${err.message}`, true);
          }
        });
      });
    }

    (async () => {
      mount.innerHTML = `<div class="cm-panel"><div class="cm-empty">กำลังโหลดข้อมูลคาร์บอนเครดิต...</div></div>`;
      await loadProjects();
      render();
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
