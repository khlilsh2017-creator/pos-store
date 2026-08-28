/* واجهة المزامنة الدائمة للصفحات */
(function () {
  'use strict';
  const path = window.location.pathname;
  const isPhone = path.startsWith('/phone/');
  const isDriver = path === '/driver' || path.startsWith('/driver/');
  const swUrl = isPhone ? '/phone/sw_phone.js' : isDriver ? '/driver/sw_driver.js' : '/sw.js';
  const scope = isPhone ? '/phone/' : isDriver ? '/driver/' : '/';
  let registration = null;
  let status = navigator.onLine ? 'online' : 'offline';
  let pending = 0;

  function tokenValue() {
    return localStorage.getItem('pos_token') || localStorage.getItem('token') || localStorage.getItem('driver_token') || '';
  }
  function setIndicator(nextStatus, count = pending) {
    status = nextStatus || status; pending = Number(count || 0);
    const pill = document.getElementById('offline-sync-indicator');
    if (!pill) return;
    const labels = { online: 'متصل', offline: 'غير متصل', queued: 'معلّق للمزامنة', syncing: 'جارٍ التزامن', completed: 'تمت المزامنة', failed: 'مزامنة متعثرة', idle: 'لا توجد عمليات معلقة', token_saved: 'جلسة المزامنة جاهزة' };
    pill.textContent = `${labels[status] || status}${pending ? ` · ${pending}` : ''}`;
    pill.dataset.status = status;
    pill.title = 'المزامنة محفوظة محليًا ولا تختفي عند إغلاق المتصفح';
  }
  function createIndicator() {
    if (document.getElementById('offline-sync-indicator')) return;
    const pill = document.createElement('button');
    pill.id = 'offline-sync-indicator'; pill.type = 'button'; pill.className = 'offline-sync-indicator';
    pill.addEventListener('click', () => window.POSOffline?.syncNow?.());
    (document.body || document.documentElement).appendChild(pill);
    setIndicator(status, pending);
  }
  async function register() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      registration = await navigator.serviceWorker.register(swUrl, { scope });
      await navigator.serviceWorker.ready;
      const active = registration.active || navigator.serviceWorker.controller;
      const token = tokenValue();
      if (active) active.postMessage({ type: isDriver ? 'DRIVER_SET_SYNC_TOKEN' : 'OFFLINE_SET_TOKEN', token });
      if (!isDriver) active?.postMessage({ type: 'OFFLINE_QUEUE_STATUS' });
      return registration;
    } catch (error) { console.warn('تعذر تفعيل المزامنة المحلية:', error); return null; }
  }
  async function syncNowUnlocked() {
    const reg = registration || await register();
    if (!reg) return false;
    const active = reg.active || navigator.serviceWorker.controller;
    const token = tokenValue();
    if (active) active.postMessage({ type: isDriver ? 'DRIVER_SET_SYNC_TOKEN' : 'OFFLINE_SET_TOKEN', token });
    try {
      if (isDriver) active?.postMessage({ type: 'DRIVER_REGISTER_BACKGROUND_SYNC' });
      else if (reg.sync) await reg.sync.register('pos-offline-sync');
      else active?.postMessage({ type: 'OFFLINE_SYNC_NOW' });
      setIndicator('syncing', pending);
      return true;
    } catch (_) {
      active?.postMessage({ type: isDriver ? 'DRIVER_REGISTER_BACKGROUND_SYNC' : 'OFFLINE_SYNC_NOW' });
      return true;
    }
  }
  let syncInFlight = null;
  function syncNow() {
    if (syncInFlight) return syncInFlight;
    syncInFlight = syncNowUnlocked().finally(() => { syncInFlight = null; });
    return syncInFlight;
  }
  function installMutationOperationIds() {
    if (window.__POS_OFFLINE_FETCH_WRAPPED) return;
    const originalFetch = window.fetch.bind(window);
    window.fetch = function(input, init = {}) {
      let url;
      try { url = new URL(typeof input === 'string' ? input : input.url, location.href); } catch (_) { return originalFetch(input, init); }
      const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
      const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
      const isAuth = url.hostname === 'api.ibnalmukhtar.com' && /^\/auth\/(login|logout|me)$/.test(url.pathname);
      if (!isMutation || !url.hostname.endsWith('ibnalmukhtar.com') || isAuth) return originalFetch(input, init);
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value));
      if (!headers.has('X-Offline-Operation-Id')) {
        const id = globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
        headers.set('X-Offline-Operation-Id', id);
      }
      return originalFetch(input, { ...init, headers });
    };
    window.__POS_OFFLINE_FETCH_WRAPPED = true;
  }
  function install() {
    installMutationOperationIds();
    createIndicator();
    window.addEventListener('online', () => { setIndicator('online'); syncNow(); });
    window.addEventListener('offline', () => setIndicator('offline'));
    navigator.serviceWorker?.addEventListener('message', event => {
      const data = event.data || {};
      if (data.type === 'OFFLINE_SYNC_STATUS' || data.type === 'SYNC_STATUS') {
        setIndicator(data.status || 'idle', data.pending || 0);
        if (data.status === 'completed' && typeof window.refreshAfterOfflineSync === 'function') window.refreshAfterOfflineSync();
      }
    });
    window.POSOffline = { syncNow, status: () => ({ status, pending }), retryBlocked: async () => { const reg = registration || await register(); (reg?.active || navigator.serviceWorker.controller)?.postMessage({ type: 'OFFLINE_RETRY_BLOCKED' }); } };
    register().then(() => { if (navigator.onLine) syncNow(); });
    setInterval(() => { if (navigator.onLine) syncNow(); }, 60 * 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true }); else install();
})();
