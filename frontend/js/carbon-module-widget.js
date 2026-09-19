/**
 * AgroLink — Carbon Module Widget (โมดูลคาร์บอนเครดิตระดับองค์กร) —
 * Phase 1 + Phase 2 (see backend/db/grant_carbon_module_portal_
 * aggregation.sql + grant_carbon_module_mrv_evidence.sql and
 * backend/src/lib/carbonAggregation.js for the schema/API this talks to).
 * Phase 2 adds the MRV Data Room (evidence list/upload/remove per project)
 * and a client-side "export ชุดเอกสาร" manifest for staff to hand a VVB/
 * อบก.(TGO) by hand — there is no direct integration with either.
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
 * Evidence FILES go through the existing generic POST /storage/upload +
 * GET /storage/:id (backend/src/routes/storage.js) rather than a
 * carbon-specific upload endpoint — same fetch-with-Authorization-header
 * pattern frontend/coop/js/dashboard.js already uses for the cooperative's
 * registration document.
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

  const EVIDENCE_TYPE_LABEL_TH = {
    satellite_image: 'ภาพถ่ายดาวเทียม/ภาพถ่ายแปลง',
    gis_boundary: 'ขอบเขตแปลง (GIS)',
    certification_document: 'เอกสารรับรอง',
    other: 'อื่นๆ',
  };
  const EVIDENCE_EDITABLE_STATUSES = ['draft', 'mrv_prep'];

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

    async function cmFetchJson(url, options) {
      const res = await fetch(url, Object.assign({}, options, {
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
    const cmRequest = (path, options) => cmFetchJson(`${CM_API_BASE}${apiPrefix}${path}`, options);
    const cmGet = (path) => cmRequest(path, { method: 'GET' });
    const cmPost = (path, data) => cmRequest(path, { method: 'POST', body: JSON.stringify(data || {}) });

    // Evidence FILE upload/download goes through the shared '/storage'
    // prefix, not the portal's own carbon prefix — see this file's header.
    const cmStorageUpload = (payload) => cmFetchJson(`${CM_API_BASE}/storage/upload`, {
      method: 'POST', body: JSON.stringify(payload),
    });
    async function cmDownloadFile(fileId) {
      const res = await fetch(`${CM_API_BASE}/storage/${fileId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error(`download_failed_${res.status}`);
      return res.blob();
    }
    function cmFileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result); // data: URL — matches lib/storage.js's decodeBase64Payload
        reader.onerror = () => reject(reader.error || new Error('read_failed'));
        reader.readAsDataURL(file);
      });
    }

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
    let expandedEvidence = [];
    let showCreateForm = false;
    let showEvidenceForm = false;

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

    async function loadEvidence(projectId) {
      try {
        const data = await cmGet(`/projects/${projectId}/evidence`);
        expandedEvidence = data.evidence || [];
      } catch (err) {
        cmToast(`โหลดหลักฐาน MRV ไม่สำเร็จ: ${err.message}`, true);
        expandedEvidence = [];
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

    function renderEvidenceForm(projectId) {
      if (!showEvidenceForm) {
        return `<div style="margin-top:10px;"><button type="button" class="cm-btn cm-btn-secondary" id="cmShowEvidenceBtn">＋ เพิ่มหลักฐาน MRV</button></div>`;
      }
      const typeOptions = Object.keys(EVIDENCE_TYPE_LABEL_TH)
        .map((t) => `<option value="${t}">${EVIDENCE_TYPE_LABEL_TH[t]}</option>`).join('');
      return `
        <form class="cm-form" id="cmEvidenceForm" data-project-id="${cmEscapeHtml(projectId)}">
          <div class="cm-field">
            <label for="cmEvidenceType">ประเภทหลักฐาน</label>
            <select id="cmEvidenceType">${typeOptions}</select>
          </div>
          <div class="cm-field cm-field-full">
            <label for="cmEvidenceTitle">ชื่อ/หัวข้อหลักฐาน *</label>
            <input type="text" id="cmEvidenceTitle" placeholder="เช่น ภาพถ่ายดาวเทียมแปลงนา รอบเก็บเกี่ยว 2569" required />
          </div>
          <div class="cm-field cm-field-full" id="cmEvidenceFileWrap">
            <label for="cmEvidenceFile">ไฟล์ (jpg/png/pdf, ไม่เกิน 5MB)</label>
            <input type="file" id="cmEvidenceFile" accept="image/jpeg,image/png,image/webp,application/pdf" />
          </div>
          <div class="cm-field cm-field-full" id="cmEvidenceGeoWrap" style="display:none;">
            <label for="cmEvidenceGeoData">ข้อมูลขอบเขตแปลง (พิกัด/GeoJSON แบบข้อความ)</label>
            <textarea id="cmEvidenceGeoData" rows="3" placeholder="เช่น พิกัดมุมแปลง หรือ GeoJSON"></textarea>
          </div>
          <div class="cm-field cm-field-full">
            <label for="cmEvidenceNote">หมายเหตุ (ถ้ามี)</label>
            <textarea id="cmEvidenceNote" rows="2"></textarea>
          </div>
          <div class="cm-field-full" style="display:flex; gap:8px;">
            <button type="submit" class="cm-btn">บันทึกหลักฐาน</button>
            <button type="button" class="cm-btn cm-btn-secondary" id="cmCancelEvidenceBtn">ยกเลิก</button>
          </div>
        </form>
      `;
    }

    function renderEvidenceList(project) {
      const editable = EVIDENCE_EDITABLE_STATUSES.includes(project.status);
      const items = expandedEvidence.map((e) => {
        const typeLabel = EVIDENCE_TYPE_LABEL_TH[e.evidence_type] || e.evidence_type;
        const body = e.file_id
          ? `<button type="button" class="cm-btn cm-btn-secondary" data-view-evidence-file-id="${cmEscapeHtml(e.file_id)}">เปิดดูไฟล์ (${cmEscapeHtml(e.original_filename || '-')})</button>`
          : `<div class="cm-member-sub" style="white-space:pre-wrap;">${cmEscapeHtml(e.geo_data)}</div>`;
        return `
          <div class="cm-member-row">
            <div>
              <div class="cm-member-name">[${cmEscapeHtml(typeLabel)}] ${cmEscapeHtml(e.title)}</div>
              <div class="cm-member-sub">${e.note ? `${cmEscapeHtml(e.note)} · ` : ''}เพิ่มเมื่อ ${cmThaiDate(e.created_at)}</div>
              <div style="margin-top:6px;">${body}</div>
            </div>
            ${editable ? `<button type="button" class="cm-btn cm-btn-danger" data-remove-evidence-id="${cmEscapeHtml(e.evidence_id)}">ลบ</button>` : ''}
          </div>
        `;
      }).join('');
      return `
        <div class="cm-section-title">📁 หลักฐาน MRV (${expandedEvidence.length} รายการ)</div>
        ${expandedEvidence.length === 0 ? '<div class="cm-empty">ยังไม่มีหลักฐานแนบ</div>' : items}
        ${editable ? renderEvidenceForm(project.project_id) : '<div class="cm-empty">โครงการอยู่ระหว่างยื่น/ขึ้นทะเบียนแล้ว — ชุดหลักฐานถูกล็อกไม่ให้แก้ไข</div>'}
        <div style="margin-top:10px;">
          <button type="button" class="cm-btn cm-btn-secondary" id="cmExportBtn" data-project-id="${cmEscapeHtml(project.project_id)}">📤 ส่งออกชุดเอกสารสำหรับ VVB/TGO</button>
        </div>
      `;
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
          ${renderEvidenceList(p)}
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
            expandedEvidence = [];
            showEvidenceForm = false;
            render();
            return;
          }
          expandedProjectId = projectId;
          showEvidenceForm = false;
          await Promise.all([loadDetail(projectId), loadEligible(), loadEvidence(projectId)]);
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

      // ---------------- Phase 2 — MRV Data Room handlers ----------------
      const showEvidenceBtn = document.getElementById('cmShowEvidenceBtn');
      if (showEvidenceBtn) showEvidenceBtn.addEventListener('click', () => { showEvidenceForm = true; render(); });

      const cancelEvidenceBtn = document.getElementById('cmCancelEvidenceBtn');
      if (cancelEvidenceBtn) cancelEvidenceBtn.addEventListener('click', () => { showEvidenceForm = false; render(); });

      const evidenceTypeSelect = document.getElementById('cmEvidenceType');
      if (evidenceTypeSelect) {
        evidenceTypeSelect.addEventListener('change', () => {
          const isGeo = evidenceTypeSelect.value === 'gis_boundary';
          const fileWrap = document.getElementById('cmEvidenceFileWrap');
          const geoWrap = document.getElementById('cmEvidenceGeoWrap');
          if (fileWrap) fileWrap.style.display = isGeo ? 'none' : '';
          if (geoWrap) geoWrap.style.display = isGeo ? '' : 'none';
        });
      }

      const evidenceForm = document.getElementById('cmEvidenceForm');
      if (evidenceForm) {
        evidenceForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const projectId = evidenceForm.dataset.projectId;
          const evidenceType = document.getElementById('cmEvidenceType').value;
          const title = document.getElementById('cmEvidenceTitle').value.trim();
          const note = document.getElementById('cmEvidenceNote').value.trim();
          if (!title) {
            cmToast('กรุณาระบุชื่อ/หัวข้อหลักฐาน', true);
            return;
          }
          const submitBtn = evidenceForm.querySelector('button[type="submit"]');
          submitBtn.disabled = true;
          try {
            let fileId = null;
            let geoData = null;
            if (evidenceType === 'gis_boundary') {
              geoData = document.getElementById('cmEvidenceGeoData').value.trim();
              if (!geoData) {
                cmToast('กรุณาระบุข้อมูลขอบเขตแปลง', true);
                return;
              }
            } else {
              const fileInput = document.getElementById('cmEvidenceFile');
              const file = fileInput.files[0];
              if (!file) {
                cmToast('กรุณาเลือกไฟล์', true);
                return;
              }
              if (file.size > 5 * 1024 * 1024) {
                cmToast('ไฟล์มีขนาดใหญ่เกิน 5MB', true);
                return;
              }
              const dataUrl = await cmFileToBase64(file);
              const orgNameEl = document.getElementById('orgName');
              const uploadedBy = (orgNameEl && orgNameEl.textContent && orgNameEl.textContent.trim()) || 'เจ้าหน้าที่องค์กร';
              const uploadResult = await cmStorageUpload({
                purpose: 'carbon_vvb_evidence', filename: file.name, content_type: file.type, file_base64: dataUrl, uploaded_by: uploadedBy,
              });
              fileId = uploadResult.file_id;
            }
            await cmPost(`/projects/${projectId}/evidence`, {
              evidence_type: evidenceType, title, file_id: fileId, geo_data: geoData, note: note || null,
            });
            cmToast('เพิ่มหลักฐาน MRV เรียบร้อยแล้ว');
            showEvidenceForm = false;
            await Promise.all([loadEvidence(projectId), loadProjects()]);
            render();
          } catch (err) {
            cmToast(`เพิ่มหลักฐานไม่สำเร็จ: ${err.message}`, true);
          } finally {
            submitBtn.disabled = false;
          }
        });
      }

      mount.querySelectorAll('[data-remove-evidence-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const projectId = expandedProjectId;
          const evidenceId = btn.dataset.removeEvidenceId;
          try {
            await cmPost(`/projects/${projectId}/evidence/${evidenceId}/remove`, {});
            cmToast('ลบหลักฐานแล้ว');
            await Promise.all([loadEvidence(projectId), loadProjects()]);
            render();
          } catch (err) {
            cmToast(`ลบหลักฐานไม่สำเร็จ: ${err.message}`, true);
          }
        });
      });

      mount.querySelectorAll('[data-view-evidence-file-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const fileId = btn.dataset.viewEvidenceFileId;
          btn.disabled = true;
          try {
            const blob = await cmDownloadFile(fileId);
            window.open(URL.createObjectURL(blob), '_blank');
          } catch (err) {
            cmToast(`เปิดไฟล์ไม่สำเร็จ: ${err.message}`, true);
          } finally {
            btn.disabled = false;
          }
        });
      });

      const exportBtn = document.getElementById('cmExportBtn');
      if (exportBtn) {
        exportBtn.addEventListener('click', async () => {
          const projectId = exportBtn.dataset.projectId;
          exportBtn.disabled = true;
          try {
            const manifest = await cmGet(`/projects/${projectId}/export`);
            const text = cmBuildManifestText(manifest);
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `carbon-project-manifest-${projectId}.txt`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            cmToast('สร้างไฟล์สรุปโครงการแล้ว — เปิดไฟล์แนบแต่ละรายการด้านบนเพื่อดาวน์โหลดรวมส่งให้ผู้ทวนสอบ');
          } catch (err) {
            cmToast(`ส่งออกไม่สำเร็จ: ${err.message}`, true);
          } finally {
            exportBtn.disabled = false;
          }
        });
      }
    }

    /**
     * Plain-text manifest for staff to hand a VVB / อบก.(TGO) alongside the
     * evidence files they download individually via the "เปิดดูไฟล์" buttons
     * above — see this module's own Phase 2 scope note on why this isn't a
     * generated .zip (no archive library in this backend; adding one is a
     * new dependency + deploy step for a "manual submission anyway" flow).
     */
    function cmBuildManifestText(manifest) {
      const p = manifest.project;
      const activeMembers = manifest.members.filter((m) => m.status === 'active');
      const lines = [];
      lines.push(`เอกสารสรุปโครงการคาร์บอนเครดิต — ${p.project_name}`);
      lines.push(`สถานะ: ${PROJECT_STATUS_LABEL_TH[p.status] || p.status}`);
      lines.push(`Methodology: ${p.methodology_ref}`);
      lines.push(`ส่วนแบ่งเกษตรกร: ${cmNum(p.farmer_pool_pct)}% / ค่าธรรมเนียม AgroLink: ${cmNum(p.platform_fee_pct)}%`);
      lines.push(`สร้างเมื่อ: ${cmThaiDate(p.created_at)}`);
      lines.push('');
      lines.push(`สมาชิกในโครงการ (${activeMembers.length} คน):`);
      activeMembers.forEach((m, i) => {
        lines.push(`${i + 1}. ${m.farmer_name} (${m.farmer_code || '-'}) — ${cmNum(m.area_rai)} ไร่ — จัดสรร ${cmNum(m.allocated_credit_tco2e)} tCO2e`);
      });
      lines.push('');
      lines.push(`หลักฐาน MRV (${manifest.evidence.length} รายการ):`);
      manifest.evidence.forEach((e, i) => {
        const typeLabel = EVIDENCE_TYPE_LABEL_TH[e.evidence_type] || e.evidence_type;
        if (e.geo_data) {
          lines.push(`${i + 1}. [${typeLabel}] ${e.title}${e.note ? ` — ${e.note}` : ''}`);
          lines.push(`   ข้อมูลขอบเขตแปลง: ${e.geo_data}`);
        } else {
          lines.push(`${i + 1}. [${typeLabel}] ${e.title}${e.note ? ` — ${e.note}` : ''} — ไฟล์แนบ: ${e.original_filename || '-'} (ดาวน์โหลดแยกจากหน้าคาร์บอนเครดิตในระบบ)`);
        }
      });
      lines.push('');
      lines.push('หมายเหตุ: ไฟล์นี้เป็นเอกสารสรุปสำหรับเจ้าหน้าที่ใช้ประกอบการยื่นต่อผู้ทวนสอบภายนอก (VVB) / อบก. (TGO) ด้วยตนเอง — ระบบยังไม่เชื่อมต่อกับหน่วยงานดังกล่าวโดยตรง');
      return lines.join('\n');
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
