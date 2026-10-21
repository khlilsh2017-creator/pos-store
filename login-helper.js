/**
 * ============================================================
 * login-helper.js — المساعد الذكي الموحد لشاشات تسجيل الدخول
 * ============================================================
 * الميزات:
 * 1. ⚙️ زر إعدادات الخادم والاتصال ونافذة الفحص والتبديل (Server Settings Modal)
 * 2. ⚡ التبديل التلقائي الذكي عند فشل الاتصال (Smart Auto-Failover)
 * 3. 👥 حفظ أكثر من مستخدم عند تحديد "تذكرني" والتبديل السريع بينهم (Multi-User Switcher)
 * 4. 🚀 فحص سرعة الاستجابة (Ping Speed Test)
 * ============================================================
 */
(function (window, document) {
  'use strict';

  const PRIMARY_URL = 'https://api.ibnalmukhtar.com';
  const BACKUP_URL = 'https://api2.ibnalmukhtar.com';
  const STORAGE_KEY_IDX = '_apiEndpointIndex_v3';
  const STORAGE_KEY_BASE = 'posApiBase';

  // حقن الأنماط الجمالية (CSS) مرة واحدة فقط
  function injectStyles() {
    if (document.getElementById('login-helper-styles')) return;
    const style = document.createElement('style');
    style.id = 'login-helper-styles';
    style.textContent = `
      /* زر الإعدادات في طرف الصفحة */
      .lh-settings-btn {
        position: absolute;
        top: 14px;
        left: 14px;
        z-index: 1000;
        width: 42px;
        height: 42px;
        border-radius: 50%;
        background: #ffffff;
        border: 1px solid #d1d9e6;
        box-shadow: 0 4px 14px rgba(18, 59, 114, 0.12);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: #123b72;
        font-size: 1.15rem;
        transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
        padding: 0;
      }
      .lh-settings-btn:hover {
        transform: rotate(30deg) scale(1.06);
        box-shadow: 0 6px 18px rgba(18, 59, 114, 0.18);
        background: #f8fafc;
      }
      .lh-settings-btn:active {
        transform: scale(0.95);
      }
      .lh-status-dot {
        position: absolute;
        bottom: 2px;
        right: 2px;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #16a34a;
        border: 2px solid #ffffff;
        box-shadow: 0 0 0 1px rgba(0,0,0,0.1);
        transition: background 0.3s ease;
      }
      .lh-status-dot.backup { background: #1d63c6; }
      .lh-status-dot.offline { background: #dc2626; }

      /* نافذة إعدادات الخادم Modal */
      .lh-modal-backdrop {
        position: fixed !important;
        inset: 0 !important;
        z-index: 999999 !important;
        background: rgba(10, 27, 51, 0.65) !important;
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        display: none;
        align-items: center;
        justify-content: center;
        padding: 16px;
        direction: rtl;
        box-sizing: border-box !important;
        font-family: 'Cairo', system-ui, -apple-system, sans-serif;
        animation: lhFadeIn 0.2s ease;
      }
      .lh-modal-backdrop.open { display: flex !important; }
      .lh-modal-card {
        background: #ffffff !important;
        border-radius: 20px !important;
        width: 100% !important;
        max-width: 440px !important;
        max-height: 90vh !important;
        overflow-y: auto !important;
        box-shadow: 0 20px 50px rgba(10, 27, 51, 0.35) !important;
        border: 1px solid #e2e8f0 !important;
        padding: 22px 20px !important;
        position: relative !important;
        box-sizing: border-box !important;
        animation: lhPopIn 0.22s cubic-bezier(0.16, 1, 0.3, 1);
        text-align: right;
        color: #152238;
      }
      @keyframes lhFadeIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes lhPopIn { from { opacity: 0; transform: scale(0.94) translateY(12px); } to { opacity: 1; transform: scale(1) translateY(0); } }
      .lh-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid #eef2f7;
        padding-bottom: 12px;
        margin-bottom: 14px;
      }
      .lh-modal-title {
        font-size: 1.05rem;
        font-weight: 800;
        margin: 0;
        color: #123b72;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .lh-modal-close {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        border: none;
        background: #f1f5f9;
        color: #64748b;
        font-size: 1.1rem;
        cursor: pointer;
        display: grid;
        place-items: center;
        transition: 0.15s ease;
      }
      .lh-modal-close:hover { background: #e2e8f0; color: #0f172a; }

      .lh-server-status-box {
        background: #f8fafc;
        border: 1.5px solid #e2e8f0;
        border-radius: 14px;
        padding: 12px 14px;
        margin-bottom: 14px;
      }
      .lh-server-status-box.primary { border-color: #86efac; background: #f0fdf4; }
      .lh-server-status-box.backup { border-color: #93c5fd; background: #eff6ff; }
      .lh-server-badge-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 6px;
      }
      .lh-server-name {
        font-weight: 800;
        font-size: 0.95rem;
        color: #123b72;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .lh-server-url {
        font-size: 0.72rem;
        color: #64748b;
        font-family: monospace;
        direction: ltr;
        display: inline-block;
      }

      .lh-btn-switch {
        width: 100%;
        min-height: 44px;
        border-radius: 12px;
        border: none;
        background: linear-gradient(135deg, #1d63c6, #123b72);
        color: #ffffff;
        font-size: 0.88rem;
        font-weight: 700;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        transition: 0.2s ease;
        margin-bottom: 12px;
      }
      .lh-btn-switch:active { transform: scale(0.98); }

      .lh-feature-pill {
        display: flex;
        align-items: flex-start;
        gap: 9px;
        padding: 10px 12px;
        border-radius: 12px;
        background: #f0fdf4;
        border: 1px solid #bbf7d0;
        color: #166534;
        font-size: 0.74rem;
        line-height: 1.5;
        margin-bottom: 14px;
      }
      .lh-feature-pill svg { flex-shrink: 0; margin-top: 2px; }

      .lh-ping-section {
        background: #f8fafc;
        border-radius: 12px;
        padding: 10px 12px;
        border: 1px solid #eef2f7;
        margin-bottom: 14px;
      }
      .lh-ping-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 0.75rem;
        margin: 5px 0;
      }
      .lh-ping-badge {
        font-size: 0.68rem;
        font-weight: 700;
        padding: 2px 8px;
        border-radius: 6px;
        background: #e2e8f0;
        color: #334155;
      }
      .lh-ping-badge.fast { background: #dcfce7; color: #15803d; }
      .lh-ping-badge.medium { background: #fef3c7; color: #b45309; }
      .lh-ping-badge.slow { background: #fee2e2; color: #b91c1c; }

      .lh-btn-ping {
        width: 100%;
        min-height: 36px;
        border-radius: 10px;
        border: 1px solid #cbd5e1;
        background: #ffffff;
        color: #334155;
        font-size: 0.75rem;
        font-weight: 700;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        margin-top: 8px;
        transition: 0.15s ease;
      }
      .lh-btn-ping:hover { background: #f1f5f9; }

      /* قسم الحسابات المحفوظة Multi-Account Switcher */
      .lh-saved-accounts-wrap {
        margin: 10px 0 14px;
        text-align: right;
        direction: rtl;
        font-family: inherit;
      }
      .lh-saved-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 0.74rem;
        font-weight: 700;
        color: #475569;
        margin-bottom: 7px;
      }
      .lh-saved-list {
        display: flex;
        gap: 8px;
        overflow-x: auto;
        padding-bottom: 6px;
        scrollbar-width: thin;
      }
      .lh-saved-card {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 7px;
        background: #f8fafc;
        border: 1.5px solid #e2e8f0;
        border-radius: 12px;
        padding: 6px 10px;
        cursor: pointer;
        transition: all 0.18s ease;
        position: relative;
        max-width: 160px;
      }
      .lh-saved-card:hover {
        background: #f0f7ff;
        border-color: #93c5fd;
        transform: translateY(-1px);
      }
      .lh-saved-card.active {
        background: #eff6ff;
        border-color: #1d63c6;
        box-shadow: 0 0 0 2px rgba(29, 99, 198, 0.18);
      }
      .lh-avatar {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: linear-gradient(135deg, #123b72, #1d63c6);
        color: #ffffff;
        font-size: 0.75rem;
        font-weight: 800;
        display: grid;
        place-items: center;
        flex-shrink: 0;
      }
      .lh-acc-info {
        min-width: 0;
        flex: 1;
        text-align: right;
      }
      .lh-acc-name {
        font-size: 0.74rem;
        font-weight: 800;
        color: #1e293b;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: block;
      }
      .lh-acc-role {
        font-size: 0.62rem;
        color: #64748b;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: block;
      }
      .lh-btn-remove-acc {
        background: transparent;
        border: none;
        color: #94a3b8;
        font-size: 0.72rem;
        cursor: pointer;
        padding: 2px 4px;
        border-radius: 4px;
        transition: color 0.15s ease;
        line-height: 1;
      }
      .lh-btn-remove-acc:hover {
        color: #ef4444;
        background: #fee2e2;
      }
      .lh-btn-add-new-acc {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 5px;
        background: #ffffff;
        border: 1.5px dashed #cbd5e1;
        border-radius: 12px;
        padding: 6px 10px;
        cursor: pointer;
        font-size: 0.72rem;
        font-weight: 700;
        color: #475569;
        transition: 0.15s ease;
      }
      .lh-btn-add-new-acc:hover {
        border-color: #1d63c6;
        color: #1d63c6;
        background: #f8fafc;
      }

      /* صف خانة "تذكرني" Remember Me Row */
      .lh-remember-row {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 8px;
        margin: 10px 0 12px;
        font-size: 0.78rem;
        font-weight: 600;
        color: #334155;
        cursor: pointer;
        user-select: none;
        direction: rtl;
        text-align: right;
      }
      .lh-remember-checkbox {
        width: 18px;
        height: 18px;
        border-radius: 5px;
        accent-color: #1d63c6;
        cursor: pointer;
        margin: 0;
      }

      /* شريط الإشعار التلقائي Auto-Failover Notification Toast */
      .lh-toast {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%) translateY(30px);
        background: #0f172a;
        color: #ffffff;
        padding: 10px 18px;
        border-radius: 14px;
        font-size: 0.8rem;
        font-weight: 700;
        box-shadow: 0 10px 28px rgba(0,0,0,0.22);
        z-index: 10060;
        opacity: 0;
        transition: transform 0.25s ease, opacity 0.25s ease;
        pointer-events: none;
        direction: rtl;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .lh-toast.show {
        transform: translateX(-50%) translateY(0);
        opacity: 1;
      }
      .lh-toast.info { background: #1e3a8a; }
      .lh-toast.success { background: #14532d; }
      .lh-toast.warning { background: #78350f; }
    `;
    document.head.appendChild(style);
  }

  // ============================================================
  // 1. إدارة الخوادم والروابط
  // ============================================================
  function getActiveServerUrl() {
    if (window.apiClient?.baseUrl) {
      return window.apiClient.baseUrl.replace(/\/$/, '');
    }
    const savedBase = localStorage.getItem(STORAGE_KEY_BASE);
    if (savedBase) return savedBase.replace(/\/$/, '');
    const savedIdx = localStorage.getItem(STORAGE_KEY_IDX);
    if (savedIdx === '1') return BACKUP_URL;
    return (window.API_BASE_URL || PRIMARY_URL).replace(/\/$/, '');
  }

  function isBackupServerActive() {
    const url = getActiveServerUrl();
    return url.includes('api2') || localStorage.getItem(STORAGE_KEY_IDX) === '1';
  }

  function setActiveServer(isBackup) {
    const targetUrl = isBackup ? BACKUP_URL : PRIMARY_URL;
    const targetIdx = isBackup ? '1' : '0';
    try {
      localStorage.setItem(STORAGE_KEY_IDX, targetIdx);
      localStorage.setItem(STORAGE_KEY_BASE, targetUrl);
      if (window.apiClient && typeof window.apiClient.setActiveIndex === 'function') {
        window.apiClient.setActiveIndex(Number(targetIdx));
      } else if (window.ApiClient && typeof window.ApiClient.setActiveIndex === 'function') {
        window.ApiClient.setActiveIndex(Number(targetIdx));
      }
    } catch (_) {}
    updateAllBadges();
    return targetUrl;
  }

  function toggleServer() {
    const nowBackup = isBackupServerActive();
    return setActiveServer(!nowBackup);
  }

  // ============================================================
  // 2. إدارة الحسابات المحفوظة (Multi-Account)
  // ============================================================
  function getStorageKey(type) {
    return type === 'driver' ? 'driver_saved_accounts_v1' : 'pos_saved_accounts_v1';
  }

  function getSavedAccounts(type = 'pos') {
    try {
      const raw = localStorage.getItem(getStorageKey(type));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function saveAccount({ username, password, name, role }, type = 'pos') {
    if (!username) return;
    try {
      let list = getSavedAccounts(type);
      // إزالة الحساب إن وجد سابقاً لمنع التكرار
      list = list.filter(acc => acc.username.toLowerCase() !== username.toLowerCase());
      // إضافة الحساب في بداية القائمة مع توقيت الاستخدام
      list.unshift({
        username: username.trim(),
        password: password || '',
        name: name || username.trim(),
        role: role || (type === 'driver' ? 'مندوب توصيل' : 'مستخدم POS'),
        lastUsed: Date.now()
      });
      // حفظ بحد أقصى 10 حسابات حديثة
      list = list.slice(0, 10);
      localStorage.setItem(getStorageKey(type), JSON.stringify(list));
    } catch (e) {
      console.warn('تعذر حفظ بيانات الحساب:', e);
    }
  }

  function removeSavedAccount(username, type = 'pos') {
    if (!username) return;
    try {
      let list = getSavedAccounts(type);
      list = list.filter(acc => acc.username.toLowerCase() !== username.toLowerCase());
      localStorage.setItem(getStorageKey(type), JSON.stringify(list));
    } catch (_) {}
  }

  // ============================================================
  // 3. التبديل التلقائي الذكي أثناء تسجيل الدخول (Auto-Failover)
  // ============================================================
  async function loginWithFailover({ username, password, extraBody = {}, pageName = '' }) {
    const currentBase = getActiveServerUrl();
    const isCurrentlyBackup = isBackupServerActive();
    const otherBase = isCurrentlyBackup ? PRIMARY_URL : BACKUP_URL;

    let res = null;
    let data = null;
    let errorMsg = '';
    let usedAutoFailover = false;

    // المحاولة 1: على السيرفر النشط الحالي
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6500);
      res = await fetch(currentBase + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Page-Name': pageName || location.pathname },
        body: JSON.stringify({ username: username.trim(), password, ...extraBody }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      data = await res.json().catch(() => ({}));
    } catch (err) {
      errorMsg = err.message || 'فشل الاتصال';
      console.warn(`⚠️ [LoginHelper] تعذر الاتصال بـ ${currentBase}:`, errorMsg);
    }

    // إذا فشل الاتصال بالشبكة أو خطأ 5xx (500, 502, 503, 504) -> تشغيل التبديل التلقائي فوراً!
    const isNetworkOrServerError = !res || (res.status >= 500 && res.status < 600);
    if (isNetworkOrServerError) {
      console.log(`🔄 [LoginHelper] بدء التبديل التلقائي الذكي إلى الخادم البديل: ${otherBase}`);
      showToast('⚡ جاري التحويل تلقائياً للخادم البديل...', 'info', 3000);
      try {
        const controller2 = new AbortController();
        const timeoutId2 = setTimeout(() => controller2.abort(), 7500);
        const res2 = await fetch(otherBase + '/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Page-Name': pageName || location.pathname },
          body: JSON.stringify({ username: username.trim(), password, ...extraBody }),
          signal: controller2.signal
        });
        clearTimeout(timeoutId2);
        const data2 = await res2.json().catch(() => ({}));

        if (res2) {
          res = res2;
          data = data2;
          usedAutoFailover = true;
          // تثبيت السيرفر البديل فوراً في المتصفح
          setActiveServer(!isCurrentlyBackup);
          showToast(`⚡ تم التبديل تلقائياً بنجاح إلى: ${!isCurrentlyBackup ? 'الاحتياطي (api2)' : 'الأساسي (api)'}`, 'success', 4000);
        }
      } catch (err2) {
        console.warn(`⚠️ [LoginHelper] فشل الخادم البديل أيضاً:`, err2.message);
        errorMsg = err2.message || errorMsg;
      }
    }

    return {
      res,
      data: data || {},
      ok: Boolean(res && res.ok && data?.token),
      usedAutoFailover,
      activeServerUrl: getActiveServerUrl(),
      error: data?.error || (res && !res.ok ? 'خطأ في المصادقة' : 'تعذر الاتصال بجميع الخوادم المتاحة، تحقق من اتصال الإنترنت')
    };
  }

  // ============================================================
  // 4. نافذة الإعدادات وفحص سرعة الاتصال (Modal & Ping)
  // ============================================================
  let activeModalBackdrop = null;

  function ensureModal() {
    injectStyles();
    if (activeModalBackdrop) return activeModalBackdrop;
    const backdrop = document.createElement('div');
    backdrop.className = 'lh-modal-backdrop';
    backdrop.id = 'lhServerSettingsModal';
    backdrop.innerHTML = `
      <div class="lh-modal-card">
        <div class="lh-modal-header">
          <h3 class="lh-modal-title">⚙️ إعدادات الخادم والاتصال</h3>
          <button type="button" class="lh-modal-close" id="lhBtnCloseModal">&times;</button>
        </div>
        
        <div id="lhServerStatusBox" class="lh-server-status-box primary">
          <div class="lh-server-badge-row">
            <span class="lh-server-name" id="lhCurrentServerTitle">
              <span id="lhModalDot" style="width:10px;height:10px;border-radius:50%;background:#16a34a;display:inline-block;"></span>
              الخادم النشط: الأساسي (api)
            </span>
            <span style="font-size:0.68rem;padding:2px 8px;border-radius:6px;background:#dcfce7;color:#15803d;font-weight:700;" id="lhServerPill">مباشر</span>
          </div>
          <div class="lh-server-url" id="lhCurrentServerUrl">https://api.ibnalmukhtar.com</div>
        </div>

        <button type="button" class="lh-btn-switch" id="lhBtnSwitchServer">
          🔄 تبديل إلى الخادم الاحتياطي (api2)
        </button>

        <div class="lh-feature-pill">
          <svg width="18" height="18" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 1.944A11.954 11.954 0 012.166 5C2.056 5.649 2 6.319 2 7c0 5.225 3.34 9.67 8 11.317C14.66 16.67 18 12.225 18 7c0-.682-.057-1.35-.166-2.001A11.954 11.954 0 0110 1.944zM11 14a1 1 0 11-2 0 1 1 0 012 0zm0-7a1 1 0 10-2 0v3a1 1 0 102 0V7z" clip-rule="evenodd"></path></svg>
          <div>
            <strong>التبديل التلقائي مفعّل دائماً:</strong><br>
            إذا حدث انقطاع أو بطء على الخادم الحالي، يُحوّل النظام طلب الدخول والعمليات تلقائياً إلى الخادم الآخر فوراً دون توقف العمل.
          </div>
        </div>

        <div class="lh-ping-section">
          <div style="font-size:0.75rem;font-weight:700;color:#334155;margin-bottom:6px;">📊 قياس سرعة الاستجابة (Ping):</div>
          <div class="lh-ping-row">
            <span>الأساسي (api):</span>
            <span class="lh-ping-badge" id="lhPingPrimary">—</span>
          </div>
          <div class="lh-ping-row">
            <span>الاحتياطي (api2):</span>
            <span class="lh-ping-badge" id="lhPingBackup">—</span>
          </div>
          <button type="button" class="lh-btn-ping" id="lhBtnRunPing">⚡ فحص سرعة الاتصال بالخادمين</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    // ربط الأحداث
    backdrop.querySelector('#lhBtnCloseModal').addEventListener('click', closeModal);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal();
    });
    backdrop.querySelector('#lhBtnSwitchServer').addEventListener('click', () => {
      const nextUrl = toggleServer();
      updateModalUI();
      showToast(nextUrl.includes('api2') ? '🔄 تم التبديل إلى الخادم الاحتياطي (api2)' : '🔄 تم التبديل إلى الخادم الأساسي (api)', 'info');
    });
    backdrop.querySelector('#lhBtnRunPing').addEventListener('click', runPingTest);

    activeModalBackdrop = backdrop;
    return backdrop;
  }

  function updateModalUI() {
    if (!activeModalBackdrop) return;
    const isBackup = isBackupServerActive();
    const box = activeModalBackdrop.querySelector('#lhServerStatusBox');
    const title = activeModalBackdrop.querySelector('#lhCurrentServerTitle');
    const pill = activeModalBackdrop.querySelector('#lhServerPill');
    const url = activeModalBackdrop.querySelector('#lhCurrentServerUrl');
    const dot = activeModalBackdrop.querySelector('#lhModalDot');
    const switchBtn = activeModalBackdrop.querySelector('#lhBtnSwitchServer');

    if (isBackup) {
      box.className = 'lh-server-status-box backup';
      title.innerHTML = '<span id="lhModalDot" style="width:10px;height:10px;border-radius:50%;background:#1d63c6;display:inline-block;margin-left:6px;"></span> الخادم النشط: الاحتياطي (api2)';
      pill.textContent = 'سحابي متزامن';
      pill.style.background = '#dbeafe';
      pill.style.color = '#1e40af';
      url.textContent = BACKUP_URL;
      switchBtn.innerHTML = '🔄 تبديل إلى الخادم الأساسي (api)';
    } else {
      box.className = 'lh-server-status-box primary';
      title.innerHTML = '<span id="lhModalDot" style="width:10px;height:10px;border-radius:50%;background:#16a34a;display:inline-block;margin-left:6px;"></span> الخادم النشط: الأساسي (api)';
      pill.textContent = 'مباشر وسريع';
      pill.style.background = '#dcfce7';
      pill.style.color = '#15803d';
      url.textContent = PRIMARY_URL;
      switchBtn.innerHTML = '🔄 تبديل إلى الخادم الاحتياطي (api2)';
    }
  }

  async function runPingTest() {
    if (!activeModalBackdrop) return;
    const pBadge = activeModalBackdrop.querySelector('#lhPingPrimary');
    const bBadge = activeModalBackdrop.querySelector('#lhPingBackup');
    const btn = activeModalBackdrop.querySelector('#lhBtnRunPing');

    btn.disabled = true;
    btn.textContent = '⏳ جاري القياس...';
    pBadge.textContent = '...';
    pBadge.className = 'lh-ping-badge';
    bBadge.textContent = '...';
    bBadge.className = 'lh-ping-badge';

    async function pingOne(base) {
      const t0 = performance.now();
      try {
        const c = new AbortController();
        const tid = setTimeout(() => c.abort(), 4000);
        await fetch(base + '/currencies', { method: 'HEAD', signal: c.signal, cache: 'no-store' });
        clearTimeout(tid);
        return Math.round(performance.now() - t0);
      } catch (_) {
        return -1;
      }
    }

    const [pMs, bMs] = await Promise.all([pingOne(PRIMARY_URL), pingOne(BACKUP_URL)]);

    function renderBadge(badge, ms) {
      if (ms === -1) {
        badge.textContent = 'تعذر الاتصال ❌';
        badge.className = 'lh-ping-badge slow';
      } else {
        badge.textContent = `${ms} مللي ثانية`;
        if (ms < 200) badge.className = 'lh-ping-badge fast';
        else if (ms < 500) badge.className = 'lh-ping-badge medium';
        else badge.className = 'lh-ping-badge slow';
      }
    }

    renderBadge(pBadge, pMs);
    renderBadge(bBadge, bMs);

    btn.disabled = false;
    btn.textContent = '⚡ إعادة فحص سرعة الاتصال';
  }

  function openModal() {
    const backdrop = ensureModal();
    updateModalUI();
    backdrop.classList.add('open');
  }

  function closeModal() {
    if (activeModalBackdrop) {
      activeModalBackdrop.classList.remove('open');
    }
  }

  // ============================================================
  // 5. زر الإعدادات الطافي والتنبيهات
  // ============================================================
  function updateAllBadges() {
    const isBackup = isBackupServerActive();
    document.querySelectorAll('.lh-status-dot').forEach(dot => {
      dot.className = 'lh-status-dot' + (isBackup ? ' backup' : '');
    });
    // تحديث أي عناصر تقليدية قديمة تحمل serverNameLabel
    const label = document.getElementById('serverNameLabel');
    const dot = document.getElementById('serverDot');
    if (label) {
      label.textContent = isBackup ? 'الاحتياطي (api2)' : 'الأساسي (api)';
      label.style.color = isBackup ? '#1d63c6' : '#123b72';
    }
    if (dot) {
      dot.style.background = isBackup ? '#1d63c6' : '#16a34a';
    }
    updateModalUI();
  }

  let toastTimeout = null;
  function showToast(message, type = 'info', duration = 3500) {
    let toast = document.getElementById('lhToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'lhToast';
      toast.className = 'lh-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = `lh-toast show ${type}`;
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
    }, duration);
  }

  // ============================================================
  // 6. تهيئة الصفحة بالكامل (Main Init Function)
  // ============================================================
  function init({
    pageType = 'pos',
    usernameInputId = 'username',
    passwordInputId = 'password',
    rememberContainerId = null,
    savedAccountsContainerId = null,
    showSettingsButton = true,
    settingsButtonTarget = null,
    rememberCheckboxId = 'lhRememberMe'
  } = {}) {
    injectStyles();
    ensureModal();

    const usernameInput = document.getElementById(usernameInputId);
    const passwordInput = document.getElementById(passwordInputId);

    // 1. حقن زر الإعدادات في طرف الصفحة (إذا لم يكن هناك زر مسبقاً وكان الخيار مفعلاً)
    const targetParent = settingsButtonTarget 
      ? (typeof settingsButtonTarget === 'string' ? document.querySelector(settingsButtonTarget) : settingsButtonTarget) 
      : document.body;

    if (showSettingsButton && targetParent && !document.querySelector('.lh-settings-btn')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lh-settings-btn';
      btn.title = 'إعدادات الخادم والاتصال';
      btn.innerHTML = `
        <span style="font-size:1.15rem;display:inline-block;">⚙️</span>
        <span class="lh-status-dot ${isBackupServerActive() ? 'backup' : ''}"></span>
      `;
      btn.addEventListener('click', openModal);
      targetParent.appendChild(btn);
    }

    // 2. حقن خانة "تذكرني" إذا توفرت الحاوية
    if (rememberContainerId) {
      const remContainer = document.getElementById(rememberContainerId);
      if (remContainer && !document.getElementById(rememberCheckboxId)) {
        remContainer.innerHTML = `
          <label class="lh-remember-row" for="${rememberCheckboxId}">
            <input type="checkbox" id="${rememberCheckboxId}" class="lh-remember-checkbox" checked>
            <span>تذكر بيانات الدخول على هذا الجهاز</span>
          </label>
        `;
      }
    }

    // 3. عرض شريط الحسابات المحفوظة (Saved Accounts)
    function renderSavedAccounts() {
      if (!savedAccountsContainerId) return;
      const container = document.getElementById(savedAccountsContainerId);
      if (!container) return;

      const accounts = getSavedAccounts(pageType);
      if (accounts.length === 0) {
        container.innerHTML = '';
        container.style.display = 'none';
        return;
      }

      container.style.display = 'block';
      container.className = 'lh-saved-accounts-wrap';
      container.innerHTML = `
        <div class="lh-saved-header">
          <span>👥 الحسابات المحفوظة:</span>
          <span style="font-size:0.65rem;color:#64748b;">(انقر للتبديل السريع)</span>
        </div>
        <div class="lh-saved-list" id="lhSavedList"></div>
      `;

      const listEl = container.querySelector('#lhSavedList');

      accounts.forEach(acc => {
        const initial = (acc.name || acc.username || 'م').trim().charAt(0);
        const card = document.createElement('div');
        card.className = 'lh-saved-card';
        card.title = `دخول سريع باسم: ${acc.username}`;
        card.innerHTML = `
          <div class="lh-avatar">${initial}</div>
          <div class="lh-acc-info">
            <span class="lh-acc-name">${acc.name || acc.username}</span>
            <span class="lh-acc-role">${acc.role || acc.username}</span>
          </div>
          <button type="button" class="lh-btn-remove-acc" title="حذف الحساب من المحفوظات">&times;</button>
        `;

        // عند النقر على بطاقة الحساب -> تعبئة البيانات
        card.addEventListener('click', (e) => {
          if (e.target.classList.contains('lh-btn-remove-acc')) return;
          if (usernameInput) usernameInput.value = acc.username;
          if (passwordInput && acc.password) passwordInput.value = acc.password;
          
          listEl.querySelectorAll('.lh-saved-card').forEach(c => c.classList.remove('active'));
          card.classList.add('active');

          const remCb = document.getElementById(rememberCheckboxId);
          if (remCb) remCb.checked = true;

          if (passwordInput && !acc.password) passwordInput.focus();
        });

        // زر حذف الحساب
        card.querySelector('.lh-btn-remove-acc').addEventListener('click', (e) => {
          e.stopPropagation();
          removeSavedAccount(acc.username, pageType);
          renderSavedAccounts();
        });

        listEl.appendChild(card);
      });

      // زر "دخول بحساب جديد"
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'lh-btn-add-new-acc';
      addBtn.innerHTML = '<span>➕</span><span>حساب آخر</span>';
      addBtn.addEventListener('click', () => {
        if (usernameInput) usernameInput.value = '';
        if (passwordInput) passwordInput.value = '';
        listEl.querySelectorAll('.lh-saved-card').forEach(c => c.classList.remove('active'));
        if (usernameInput) usernameInput.focus();
      });
      listEl.appendChild(addBtn);

      // تحديد أول حساب تلقائياً إذا كانت الحقول فارغة
      if (accounts[0] && usernameInput && !usernameInput.value) {
        usernameInput.value = accounts[0].username;
        if (passwordInput && accounts[0].password) passwordInput.value = accounts[0].password;
        listEl.querySelector('.lh-saved-card')?.classList.add('active');
      }
    }

    renderSavedAccounts();
    updateAllBadges();

    // الاستماع لأي أحداث خارجية
    window.addEventListener('api-endpoint-changed', updateAllBadges);
    window.addEventListener('api-endpoint-recovered', updateAllBadges);

    return {
      renderSavedAccounts,
      saveAccount: (data) => saveAccount(data, pageType),
      removeSavedAccount: (user) => removeSavedAccount(user, pageType),
      getSavedAccounts: () => getSavedAccounts(pageType),
      isRememberChecked: () => {
        const cb = document.getElementById(rememberCheckboxId);
        return cb ? cb.checked : true;
      }
    };
  }

  // حقن الأنماط تلقائياً فور تحميل السكربت لضمان ظهور النوافذ بشكل صحيح
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectStyles);
    } else {
      injectStyles();
    }
  }

  // التصدير إلى window
  window.LoginHelper = {
    init,
    loginWithFailover,
    getActiveServerUrl,
    isBackupServerActive,
    setActiveServer,
    toggleServer,
    openSettingsModal: openModal,
    closeSettingsModal: closeModal,
    showToast,
    getSavedAccounts,
    saveAccount,
    removeSavedAccount
  };

})(window, document);
