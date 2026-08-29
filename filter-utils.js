(function (global) {
  'use strict';

  const VERSION = 3;
  const DEFAULT_LIMIT = 20;
  const HIDE_AFTER_MS = 60 * 1000;
  const LIMITS = [20, 50, 100];
  const runtimeStates = new Map();

  const configs = {
    'invoices.html': { key: 'invoices', endpoints: ['/sales'], container: '.filter-bar', existing: { from: '#filterDateFrom', to: '#filterDateTo', search: '#filterCustomer', payment_method: '#filterPayment', status: '#filterStatus' }, refresh: 'refreshInvoices', preserve: [] },
    'purchases.html': { key: 'purchases', endpoints: ['/purchases'], container: '#log-search', containerMode: 'parent2', existing: { search: '#log-search', payment_method: '#log-filter-method' }, refresh: 'loadPurchasesHistory', preserve: ['button'] },
    'expenses.html': { key: 'expenses', endpoints: ['/expenses'], host: '#expense-filters', extraHtml: '<label>بحث<input class="input pos-extra-search" placeholder="اسم المصروف أو الملاحظة أو المحفظة"></label><label>طريقة الدفع<select class="input pos-extra-method"><option value="">الكل</option><option value="cash">نقدًا</option><option value="wallet">محفظة</option><option value="mixed">مختلط</option></select></label>', refresh: 'loadExpenses' },
    'payments.html': { key: 'payments', endpoints: ['/cash/vouchers'], container: '.filters', existing: { from: '#filter-from', to: '#filter-to', search: '#filter-search', type: '#filter-type' }, refresh: 'loadVouchers' },
    'journal.html': { key: 'journal', endpoints: ['/journal-entries'], container: '#journal-search', containerMode: 'parent2', existing: { from: '#journal-from', to: '#journal-to', search: '#journal-search' }, refresh: 'loadJournalEntries', preserve: ['button'] },
    'orders.html': { key: 'orders', endpoints: ['/online-orders'], container: '#filterStatus', containerMode: 'closestFilters', existing: { from: '#filterDateFrom', to: '#filterDateTo', search: '#filterSearch', status: '#filterStatus', driver_id: '#filterDriver' }, fromParam: 'date_from', toParam: 'date_to', refresh: 'fetchOrders', preserve: ['.filter-actions'] },
    'online-reports.html': { key: 'online-reports', endpoints: ['/online-orders'], container: '.filters-section', existing: { from: '#filterDateFrom', to: '#filterDateTo', status: '#filterStatus', payment_method: '#filterPayment' }, fromParam: 'date_from', toParam: 'date_to', refresh: 'fetchOrders' },
    'stock-movements.html': { key: 'stock-movements', endpoints: [], host: '#never-mount-stock-filter', refresh: '' },
    'customers.html': { key: 'customers', endpoints: ['/customers/statement', '/customers/recent-payments'], container: '#search-customer', containerMode: 'parent2', existing: { search: '#search-customer' }, refresh: 'loadCustomers' },
    'suppliers.html': { key: 'suppliers', endpoints: ['/suppliers/statement'], container: '.search-bar', existing: { search: '#searchInput', balance_filter: '#filterBalance' }, refresh: 'loadSuppliers', preserve: ['button'] },
    'reports.html': { key: 'reports', endpoints: ['/reports/daily', '/reports/trial-balance', '/reports/income-statement', '/reports/balance-sheet', '/reports/top-products', '/reports/sales-by-product', '/reports/top-customers', '/reports/monthly-trends', '/reports/driver-performance', '/reports/aging', '/reports/sales-by-category', '/reports/profits-by-category', '/reports/department-pnl', '/reports/inventory-by-category', '/reports/opening-movement-closing', '/reports/export'], host: '#reports-filter-host', refresh: 'loadAll' },
    'reports_central.html': { key: 'reportsCentral', endpoints: ['/reports/daily', '/reports/sales-by-product', '/reports/sales-by-category', '/reports/profits-by-category', '/reports/top-products', '/reports/top-customers', '/reports/monthly-trends', '/reports/driver-performance', '/reports/aging', '/reports/payment-mix', '/reports/online-order-status', '/reports/stock-alerts', '/drivers/summary', '/online-orders', '/cash/balance'], host: '#reports-central-filter-host', refresh: 'loadAll' },
    'cash-wallets.html': { key: 'cash-wallets', endpoints: ['/cash/transactions', '/wallets/transactions'], host: '#ledger-unified-filter-host', refresh: 'loadUnifiedLedgers' }
  };

  function pad(value) { return String(value).padStart(2, '0'); }
  function localISODate(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Aden', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }
  function parseDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    const [year, month, day] = String(value).split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
  }
  function periodRange(preset, from, to) {
    const today = localISODate();
    if (preset === 'month') { const date = new Date(); return { from: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-01`, to: today }; }
    if (preset === 'year') { const date = new Date(); return { from: `${date.getFullYear()}-01-01`, to: today }; }
    if (preset === 'custom') return { from: from || today, to: to || today };
    if (preset === 'all') return { from: '', to: '' };
    return { from: today, to: today };
  }
  function normalize(input, defaults = {}) {
    const preset = ['today', 'month', 'year', 'custom', 'all'].includes(input?.preset) ? input.preset : (defaults.preset || 'today');
    const range = periodRange(preset, input?.from || defaults.from, input?.to || defaults.to);
    const requestedLimit = Number(input?.limit || defaults.limit || DEFAULT_LIMIT);
    const limit = LIMITS.includes(requestedLimit) ? requestedLimit : DEFAULT_LIMIT;
    return { ...defaults, ...input, preset, from: range.from, to: range.to, limit, version: VERSION };
  }
  function storageKey(key) { return `pos_filters_${String(key || 'page').replace(/[^a-zA-Z0-9_-]/g, '_')}_v${VERSION}`; }
  function load(key, defaults = {}) {
    if (runtimeStates.has(key)) return { ...runtimeStates.get(key) };
    try { return normalize(JSON.parse(localStorage.getItem(storageKey(key)) || '{}'), defaults); } catch (_) { return normalize({}, defaults); }
  }
  function save(key, state) {
    const normalized = normalize(state, state); runtimeStates.set(key, normalized);
    try { localStorage.setItem(storageKey(key), JSON.stringify(normalized)); } catch (_) { /* التخزين المحلي اختياري */ }
    return normalized;
  }
  function clear(key, defaults = {}) {
    try { localStorage.removeItem(storageKey(key)); } catch (_) { /* لا نوقف الصفحة */ }
    const state = normalize({}, defaults); runtimeStates.set(key, state); return state;
  }
  function validate(state) {
    const normalized = normalize(state, state);
    if (normalized.preset === 'custom') {
      const from = parseDate(normalized.from), to = parseDate(normalized.to);
      if (!from || !to) return { ok: false, message: 'حدد تاريخ بداية ونهاية صحيحين' };
      if (from > to) return { ok: false, message: 'تاريخ البداية لا يمكن أن يتجاوز تاريخ النهاية' };
    }
    return { ok: true, state: normalized };
  }
  function queryString(state, aliases = {}) {
    const result = validate(state); if (!result.ok) throw new Error(result.message);
    const data = result.state, params = new URLSearchParams();
    if (data.from) params.set(aliases.from || 'from', data.from);
    if (data.to) params.set(aliases.to || 'to', data.to);
    params.set('page', String(Math.max(1, Number(data.page || 1))));
    params.set(aliases.limit || 'limit', String(data.limit));
    Object.entries(data).forEach(([key, value]) => { if (!['preset', 'from', 'to', 'page', 'limit', 'version'].includes(key) && value !== undefined && value !== null && String(value) !== '') params.set(key, String(value)); });
    return params;
  }
  function labels() { return { today: 'اليوم', month: 'من بداية الشهر', year: 'من بداية السنة', custom: 'فترة مخصصة', all: 'كل الفترات' }; }

  function findContainer(config) {
    if (config.host) return document.querySelector(config.host);
    if (config.insertBefore) {
      const target = document.querySelector(config.insertBefore);
      if (target) { const host = document.createElement('section'); target.parentNode.insertBefore(host, target); return host; }
    }
    if (!config.container) return null;
    const element = document.querySelector(config.container); if (!element) return null;
    if (config.containerMode === 'parent') return element.parentElement?.parentElement || element.parentElement;
    if (config.containerMode === 'parent2') return element.parentElement?.parentElement || element.parentElement;
    if (config.containerMode === 'closestFilters') return element.closest('.filters') || element.parentElement;
    return element;
  }

  function attach(container, options = {}) {
    const root = typeof container === 'string' ? document.querySelector(container) : container; if (!root) return null;
    const key = options.key || 'page', defaults = { preset: 'today', limit: DEFAULT_LIMIT, ...(options.defaults || {}) };
    let state = load(key, defaults);
    const existing = options.existing || {};
    (options.preserve || []).forEach(selector => root.querySelectorAll(selector).forEach(element => root.parentNode.insertBefore(element, root)));
    const hasFrom = existing.from && document.querySelector(existing.from);
    const hasTo = existing.to && document.querySelector(existing.to);
    const dateFields = hasFrom && hasTo ? '' : '<label class="pos-filter-from-wrap">من تاريخ<input class="pos-filter-from" type="date"></label><label class="pos-filter-to-wrap">إلى تاريخ<input class="pos-filter-to" type="date"></label>';
    const block = document.createElement('div');
    block.className = 'pos-filter-controls';
    block.innerHTML = `<label>الفترة<select class="pos-filter-preset"><option value="today">اليوم</option><option value="month">من بداية الشهر</option><option value="year">من بداية السنة</option><option value="custom">فترة مخصصة</option><option value="all">كل الفترات</option></select></label>${dateFields}<label>عدد الصفوف<select class="pos-filter-limit">${LIMITS.map(value => `<option value="${value}">${value}</option>`).join('')}</select></label>${options.extraHtml || ''}<button type="button" class="btn btn-primary pos-filter-apply">تطبيق الفترة</button><button type="button" class="btn btn-outline pos-filter-save">حفظ</button><button type="button" class="btn btn-outline pos-filter-reset">تصفير</button>`;
    const heading = document.createElement('div'); heading.className = 'pos-filter-heading'; heading.innerHTML = `<strong>${options.title || 'فترة العرض'}</strong><span class="pos-filter-period-label"></span>`;
    const panel = document.createElement('div'); panel.className = 'pos-filter-panel'; panel.dataset.filterKey = key; panel.append(heading, block);
    root.appendChild(panel);
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'btn btn-outline pos-filter-toggle'; toggle.innerHTML = '<span class="pos-filter-toggle-label">إظهار الفلاتر</span>';
    root.parentNode.insertBefore(toggle, root);
    const preset = block.querySelector('.pos-filter-preset'), from = hasFrom ? document.querySelector(existing.from) : block.querySelector('.pos-filter-from'), to = hasTo ? document.querySelector(existing.to) : block.querySelector('.pos-filter-to'), limit = block.querySelector('.pos-filter-limit'), label = heading.querySelector('.pos-filter-period-label'), customFields = block.querySelectorAll('.pos-filter-from-wrap,.pos-filter-to-wrap');
    let hideTimer;
    function showPanel() { root.style.display = ''; toggle.querySelector('.pos-filter-toggle-label').textContent = 'إخفاء الفلاتر'; clearTimeout(hideTimer); hideTimer = setTimeout(hidePanel, HIDE_AFTER_MS); }
    function hidePanel() { root.style.display = 'none'; toggle.querySelector('.pos-filter-toggle-label').textContent = 'إظهار الفلاتر'; }
    function sync(nextState = state) {
      state = normalize(nextState, defaults); runtimeStates.set(key, { ...state }); preset.value = state.preset; if (from) from.value = state.from || ''; if (to) to.value = state.to || ''; limit.value = String(state.limit);
      label.textContent = `${labels()[state.preset] || labels().today}${state.from && state.to ? ` — ${state.from} إلى ${state.to}` : ''}`;
      customFields.forEach(el => { el.style.display = state.preset === 'custom' && !hasFrom && !hasTo ? '' : 'none'; });
    }
    function read() { return normalize({ ...state, preset: preset.value, from: from?.value || '', to: to?.value || '', limit: Number(limit.value), page: 1 }, defaults); }
    toggle.addEventListener('click', () => { if (root.style.display === 'none') showPanel(); else hidePanel(); });
    [from, to].filter(Boolean).forEach(field => field.addEventListener('change', () => { state = normalize({ ...state, preset: 'custom', from: from.value, to: to.value }, defaults); runtimeStates.set(key, state); showPanel(); }));
    block.addEventListener('input', showPanel); block.addEventListener('click', showPanel);
    preset.addEventListener('change', () => sync({ ...state, preset: preset.value }));
    block.querySelector('.pos-filter-apply').addEventListener('click', () => { const valid = validate(read()); if (!valid.ok) return global.alert(valid.message); state = valid.state; runtimeStates.set(key, { ...state }); sync(state); if (typeof options.onApply === 'function') options.onApply({ ...state }); hidePanel(); });
    block.querySelector('.pos-filter-save').addEventListener('click', () => { const valid = validate(read()); if (!valid.ok) return global.alert(valid.message); state = save(key, valid.state); if (typeof options.onSave === 'function') options.onSave({ ...state }); sync(state); hidePanel(); });
    block.querySelector('.pos-filter-reset').addEventListener('click', () => { state = clear(key, defaults); sync(state); if (typeof options.onReset === 'function') options.onReset({ ...state }); if (typeof options.onApply === 'function') options.onApply({ ...state }); hidePanel(); });
    sync(state); hidePanel();
    return { getState: () => ({ ...state }), setState: next => sync(next), read, apply: () => block.querySelector('.pos-filter-apply').click(), query: aliases => queryString(read(), aliases), show: showPanel, hide: hidePanel };
  }

  function currentConfig() { return configs[location.pathname.split('/').pop() || 'index.html'] || null; }
  function extraValue(selector) { const el = document.querySelector(selector); return el && String(el.value || '').trim(); }
  function endpointMatches(path, endpoint) { return path === endpoint || path.endsWith(endpoint); }
  function installFetchBridge() {
    const config = currentConfig(); if (!config || global.__posFilterFetchBridge) return;
    const originalFetch = global.fetch.bind(global); global.__posFilterFetchBridge = true;
    global.fetch = function (input, init = {}) {
      const method = String(init.method || (input && input.method) || 'GET').toUpperCase(); if (method !== 'GET') return originalFetch(input, init);
      let url; try { url = new URL(typeof input === 'string' ? input : input.url, location.href); } catch (_) { return originalFetch(input, init); }
      if (!config.endpoints.some(endpoint => endpointMatches(url.pathname, endpoint)) || url.searchParams.has('no_filter')) return originalFetch(input, init);
      const state = runtimeStates.get(config.key) || load(config.key, { preset: 'today', limit: DEFAULT_LIMIT });
      // احذف أي حدود قديمة قبل وضع الحالة الحالية؛ كود بعض الصفحات يبني date_from/date_to بنفسه.
      ['from', 'date_from'].forEach(name => url.searchParams.delete(name));
      ['to', 'date_to'].forEach(name => url.searchParams.delete(name));
      if (state.from) url.searchParams.set(config.fromParam || 'from', state.from);
      if (state.to) url.searchParams.set(config.toParam || 'to', state.to);
      if (!url.searchParams.has('page')) url.searchParams.set('page', String(state.page || 1));
      if (!url.searchParams.has('limit') && !url.searchParams.has('page_size')) url.searchParams.set('limit', String(state.limit || DEFAULT_LIMIT));
      Object.entries(config.extras || {}).forEach(([name, selector]) => { const value = extraValue(selector); if (value && !url.searchParams.has(name)) url.searchParams.set(name, value); });
      return originalFetch(typeof input === 'string' || input instanceof URL ? url.toString() : new Request(url.toString(), input), init);
    };
  }
  function injectStyles() {
    if (document.getElementById('pos-filter-utils-style')) return;
    const style = document.createElement('style'); style.id = 'pos-filter-utils-style'; style.textContent = `.pos-filter-toggle{margin:0 0 8px;min-height:36px}.pos-filter-panel{display:flex;flex-direction:column;gap:9px;padding:10px 0;grid-column:1/-1;width:100%}.pos-filter-heading{display:flex;justify-content:space-between;gap:10px;align-items:center;color:#172033}.pos-filter-period-label{font-size:11px;color:#64748b}.pos-filter-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:end}.pos-filter-controls label{display:flex;flex-direction:column;gap:3px;min-width:125px;font-size:11px;color:#64748b;font-weight:700}.pos-filter-controls input,.pos-filter-controls select{min-height:34px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;font:inherit;color:#172033}.pos-filter-controls button{min-height:34px;padding:6px 11px}.pos-filter-controls .pos-filter-from-wrap,.pos-filter-controls .pos-filter-to-wrap{display:flex}@media(max-width:760px){.pos-filter-controls label{min-width:calc(50% - 4px)}.pos-filter-controls button{flex:1}}`; document.head.appendChild(style);
  }
  function callRefresh(config) {
    if (!config.refresh) return global.location.reload();
    const fn = global[config.refresh]; if (typeof fn !== 'function') return global.location.reload();
    if (config.refresh === 'fetchOrders' || config.refresh === 'loadSuppliers') return fn(1);
    return fn();
  }
  function autoMount() {
  const config = currentConfig();
  if (!config) return;

  // محاولة التثبيت فوراً
  tryMount();

  // إذا فشلت المحاولة الأولى (لأن الهيكل لم يكتمل)، أعد المحاولة بعد 100 مللي ثانية
  function tryMount() {
    if (document.querySelector(`[data-filter-key="${config.key}"]`)) return;
    const root = findContainer(config);
    if (!root) {
      // أعد المحاولة بعد 100 مللي ثانية (لمدة أقصاها 10 محاولات)
      let attempts = 0;
      const maxAttempts = 10;
      const interval = setInterval(() => {
        attempts++;
        const rootRetry = findContainer(config);
        if (rootRetry) {
          clearInterval(interval);
          const controller = attach(rootRetry, {
            key: config.key,
            title: 'فترة العرض',
            existing: config.existing,
            extraHtml: config.extraHtml,
            onApply: () => callRefresh(config),
            onSave: () => {
              if (typeof global.showToast === 'function') global.showToast('تم حفظ إعدادات الفلترة لهذه الصفحة', 'success');
              else if (typeof global.toast === 'function') global.toast('تم حفظ إعدادات الفلترة لهذه الصفحة', 'success');
            }
          });
          global.__posFilterControllers = global.__posFilterControllers || {};
          global.__posFilterControllers[config.key] = controller;
        } else if (attempts >= maxAttempts) {
          clearInterval(interval);
        }
      }, 100);
      return;
    }
    const controller = attach(root, {
      key: config.key,
      title: 'فترة العرض',
      existing: config.existing,
      extraHtml: config.extraHtml,
      onApply: () => callRefresh(config),
      onSave: () => {
        if (typeof global.showToast === 'function') global.showToast('تم حفظ إعدادات الفلترة لهذه الصفحة', 'success');
        else if (typeof global.toast === 'function') global.toast('تم حفظ إعدادات الفلترة لهذه الصفحة', 'success');
      }
    });
    global.__posFilterControllers = global.__posFilterControllers || {};
    global.__posFilterControllers[config.key] = controller;
  }
}

  injectStyles(); installFetchBridge();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount, { once: true }); else autoMount();
  global.POSFilters = { VERSION, LIMITS, localISODate, periodRange, normalize, load, save, clear, validate, queryString, attach };
})(window);
