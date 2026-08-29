/*
 * نظام التنقل الموحد لنظام نقاط البيع.
 * مصدر الروابط الوحيد هو NAV_GROUPS، وتدعم الواجهة ثلاثة أنماط قابلة للتبديل.
 */

const NAV_GROUPS = [
  {
    id: 'sales', icon: 'fa-cash-register', label: 'المبيعات والطلبات',
    links: [
      { icon: 'fa-cash-register', label: 'نقطة البيع', href: 'sale.html', primary: true },
      { icon: 'fa-globe', label: 'طلب إنترنت', href: 'add_order.html' },
      { icon: 'fa-list-alt', label: 'إدارة الطلبات والمندوبين', href: 'orders.html' },
      { icon: 'fa-chart-line', label: 'تقارير الإنترنت', href: 'online-reports.html' },
      { icon: 'fa-link', label: 'ربط الموقع والمزامنة', href: 'site-integration.html' },
    ],
  },
  {
    id: 'purchases', icon: 'fa-shopping-basket', label: 'المشتريات والموردون',
    links: [
      { icon: 'fa-shopping-cart', label: 'المشتريات', href: 'purchases.html', primary: true },
      { icon: 'fa-truck', label: 'الموردون', href: 'suppliers.html' },
    ],
  },
  {
    id: 'inventory', icon: 'fa-boxes-stacked', label: 'المخزون والمنتجات',
    links: [
      { icon: 'fa-boxes', label: 'المنتجات', href: 'products.html', primary: true },
      { icon: 'fa-clipboard-check', label: 'جرد المخزون', href: 'inventory.html' },
      { icon: 'fa-history', label: 'حركة المخزون', href: 'stock-movements.html' },
      { icon: 'fa-barcode', label: 'طباعة الباركود', href: 'barcode-print.html' },
    ],
  },
  {
    id: 'contacts', icon: 'fa-address-book', label: 'العملاء',
    links: [{ icon: 'fa-users', label: 'العملاء', href: 'customers.html', primary: true }],
  },
  {
    id: 'accounting', icon: 'fa-calculator', label: 'المحاسبة والمالية',
    links: [
      { icon: 'fa-file-invoice', label: 'الفواتير', href: 'invoices.html', primary: true },
      { icon: 'fa-hand-holding-dollar', label: 'السندات والمدفوعات', href: 'payments.html' },
      { icon: 'fa-receipt', label: 'المصروفات', href: 'expenses.html' },
      { icon: 'fa-book', label: 'القيود اليومية', href: 'journal.html' },
      { icon: 'fa-wallet', label: 'الصندوق والمحافظ والعملات', href: 'cash-wallets.html' },
    ],
  },
  {
    id: 'reports', icon: 'fa-chart-pie', label: 'التقارير والتحليل',
    links: [
      { icon: 'fa-chart-pie', label: 'مركز التقارير المركزي الجديد', href: 'reports_central.html', target: '_blank', primary: true },
      { icon: 'fa-chart-line', label: 'مركز التقارير القديم', href: 'reports.html' },
    ],
  },
  {
    id: 'system', icon: 'fa-sliders', label: 'النظام والإعدادات',
    links: [
      { icon: 'fa-cog', label: 'الإعدادات', href: 'settings.html', primary: true },
      { icon: 'fa-tools', label: 'مركز العمليات', href: 'operations.html' },
      { icon: 'fa-shield-halved', label: 'سجل النشاط', href: 'audit-logs.html' },
    ],
  },
];

const HOME_LINK = { icon: 'fa-th-large', label: 'لوحة التحكم', href: 'index.html' };
const QUICK_ACTIONS = [
  { icon: 'fa-cash-register', label: 'فاتورة بيع جديدة', href: 'sale.html' },
  { icon: 'fa-file-circle-plus', label: 'طلب إنترنت جديد', href: 'add_order.html' },
  { icon: 'fa-box', label: 'إضافة منتج', href: 'products.html' },
  { icon: 'fa-user-plus', label: 'إضافة عميل', href: 'customers.html' },
];
const NAV_STYLES = Object.freeze(['sidebar', 'topbar-dropdown', 'app-launcher']);
const DEFAULT_NAV_STYLE = 'sidebar';

function isDriverPage() { return /(^|\/)driver(\/|$)/i.test(window.location.pathname); }
function resolveSidebarHref(href) { return isDriverPage() ? `../${href}` : href; }
function currentFileName() { return window.location.pathname.split('/').pop() || 'index.html'; }
function isActiveHref(href) { return currentFileName() === href; }
function normalizeNavStyle(value) { return NAV_STYLES.includes(String(value)) ? String(value) : DEFAULT_NAV_STYLE; }
function navStyleClass(style) { const normalized = normalizeNavStyle(style); return normalized === 'topbar-dropdown' ? 'nav-style-topbar' : normalized === 'app-launcher' ? 'nav-style-launcher' : 'nav-style-sidebar'; }
function getStoredNavStyle() { return normalizeNavStyle(localStorage.getItem('nav_style') || DEFAULT_NAV_STYLE); }
function visibleLink(link) {
  const permission = link.permission || window.POSPermissions?.pagePermission?.(link.href);
  return !permission || window.POSPermissions?.can?.(permission) !== false;
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}
function allNavigationLinks() { return [HOME_LINK, ...NAV_GROUPS.flatMap((group) => group.links)].filter(visibleLink); }
function getCurrentPageMeta() {
  const file = currentFileName();
  if (file === HOME_LINK.href) return { title: HOME_LINK.label, icon: HOME_LINK.icon, group: 'الرئيسية' };
  for (const group of NAV_GROUPS) {
    const link = group.links.find((item) => item.href === file);
    if (link) return { title: link.label, icon: link.icon, group: group.label };
  }
  return { title: document.title.split('|')[0].trim() || 'النظام المحاسبي', icon: 'fa-layer-group', group: 'النظام' };
}

function linkMarkup(link, className = '') {
  const active = isActiveHref(link.href);
  const target = link.target ? ` target="${escapeHtml(link.target)}" rel="noopener noreferrer"` : '';
  return `<a class="${className} ${active ? 'active' : ''}" href="${resolveSidebarHref(link.href)}"${target}${active ? ' aria-current="page"' : ''}>
    <i class="fas ${link.icon}" aria-hidden="true"></i><span>${escapeHtml(link.label)}</span>
  </a>`;
}

function renderSidebar(containerId = 'sidebar-container') {
  const container = document.getElementById(containerId);
  if (!container) return;
  const current = currentFileName();
  const groupsHtml = NAV_GROUPS.map((group) => {
    const links = group.links.filter(visibleLink);
    if (!links.length) return '';
    const hasActive = links.some((link) => link.href === current);
    const linksHtml = links.map((link) => linkMarkup(link, 'nav-sublink')).join('');
    return `<details class="nav-group" data-group="${group.id}" ${hasActive ? 'open' : ''}>
      <summary class="nav-group-title">
        <span class="nav-group-label"><i class="fas ${group.icon}" aria-hidden="true"></i><span>${escapeHtml(group.label)}</span></span>
        <i class="fas fa-chevron-down nav-chevron" aria-hidden="true"></i>
      </summary>
      <div class="nav-submenu">${linksHtml}</div>
    </details>`;
  }).join('');
  const userLabel = window.POSPermissions?.identityLabel?.() || 'مستخدم النظام';
  container.innerHTML = `<aside class="sidebar" id="mainSidebar" aria-label="القائمة الرئيسية">
    <div class="sidebar-brand"><div class="brand-mark"><i class="fas fa-store-alt" aria-hidden="true"></i></div><div class="brand-copy"><strong>ابن المختار</strong><small>نظام نقاط البيع والمحاسبة</small></div></div>
    <div class="sidebar-user"><span class="user-avatar"><i class="fas fa-user" aria-hidden="true"></i></span><span class="sidebar-user-copy"><strong>${escapeHtml(userLabel)}</strong><small>جلسة العمل الحالية</small></span><i class="fas fa-circle status-dot" aria-label="متصل"></i></div>
    <nav class="sidebar-nav">
      ${linkMarkup(HOME_LINK, 'nav-home')}
      <div class="nav-section-caption">الوحدات الرئيسية</div>${groupsHtml}
    </nav>
    <div class="sidebar-footer"><a class="nav-footer-link" href="${resolveSidebarHref('settings.html')}"><i class="fas fa-circle-question"></i><span>مركز المساعدة</span></a><button class="nav-footer-link logout-link" type="button" onclick="logout()"><i class="fas fa-right-from-bracket"></i><span>تسجيل الخروج</span></button></div>
  </aside><div class="sidebar-backdrop" id="sidebarBackdrop" aria-hidden="true"></div>`;
  addToggleButton();
  bindSidebarInteractions();
}

function renderTopbarDropdowns() {
  const groupsHtml = NAV_GROUPS.map((group) => {
    const links = group.links.filter(visibleLink);
    if (!links.length) return '';
    const hasActive = links.some((link) => isActiveHref(link.href));
    return `<div class="topbar-nav-group ${hasActive ? 'has-active' : ''}">
      <button class="topbar-nav-trigger ${hasActive ? 'active' : ''}" type="button" aria-expanded="false" aria-haspopup="true"><i class="fas ${group.icon}" aria-hidden="true"></i><span>${escapeHtml(group.label)}</span><i class="fas fa-chevron-down topbar-nav-chevron" aria-hidden="true"></i></button>
      <div class="topbar-dropdown-menu">${links.map((link) => linkMarkup(link, 'topbar-nav-link')).join('')}</div>
    </div>`;
  }).join('');
  return `<nav class="topbar-nav" aria-label="روابط النظام"><a class="topbar-nav-home ${isActiveHref(HOME_LINK.href) ? 'active' : ''}" href="${resolveSidebarHref(HOME_LINK.href)}"><i class="fas ${HOME_LINK.icon}" aria-hidden="true"></i><span>${HOME_LINK.label}</span></a>${groupsHtml}</nav>`;
}

function launcherMarkup() {
  const groupsHtml = NAV_GROUPS.map((group) => {
    const links = group.links.filter(visibleLink);
    if (!links.length) return '';
    return `<section class="launcher-group"><h2><i class="fas ${group.icon}" aria-hidden="true"></i>${escapeHtml(group.label)}</h2><div class="launcher-tiles">${links.map((link) => `<a class="launcher-tile ${isActiveHref(link.href) ? 'active' : ''}" href="${resolveSidebarHref(link.href)}"${link.target ? ` target="${escapeHtml(link.target)}" rel="noopener noreferrer"` : ''}${isActiveHref(link.href) ? ' aria-current="page"' : ''}><i class="fas ${link.icon}" aria-hidden="true"></i><span>${escapeHtml(link.label)}</span></a>`).join('')}</div></section>`;
  }).join('');
  return `<div class="launcher-overlay" id="navLauncherOverlay" aria-hidden="true" hidden><section class="launcher-dialog" role="dialog" aria-modal="true" aria-labelledby="launcherTitle"><div class="launcher-head"><div><span class="launcher-eyebrow">ابن المختار</span><h2 id="launcherTitle">لوحة التطبيقات</h2><p>اختر وحدة للانتقال إليها</p></div><button class="topbar-icon-btn launcher-close" id="launcherCloseBtn" type="button" aria-label="إغلاق لوحة التطبيقات"><i class="fas fa-xmark"></i></button></div><div class="launcher-home-tile">${linkMarkup(HOME_LINK, 'launcher-tile')}</div><div class="launcher-groups">${groupsHtml}</div></section></div>`;
}

function currentUserDetails() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem('pos_user') || '{}') || {}; } catch (_) {}
  const identity = String(window.POSPermissions?.identityLabel?.() || stored.name || stored.username || 'مستخدم النظام');
  const identityParts = identity.split('·').map(value => value.trim()).filter(Boolean);
  const roleNames = { admin: 'مدير', cashier: 'كاشير', driver: 'مندوب', manager: 'مدير' };
  return {
    name: stored.name || stored.full_name || stored.username || identityParts[0] || 'مستخدم النظام',
    role: roleNames[stored.role] || stored.role_name || identityParts[1] || 'مستخدم النظام',
  };
}

function pageHeaderMarkup() {
  const user = currentUserDetails();
  const page = getCurrentPageMeta();
  return `<header class="app-topbar" id="appTopbar"><div class="topbar-main"><button class="topbar-icon-btn sidebar-toggle-btn" id="sidebarToggleBtn" type="button" aria-label="فتح أو إغلاق القائمة" title="القائمة"><i class="fas fa-bars" aria-hidden="true"></i></button><div class="topbar-page-title"><span class="breadcrumb-label">${escapeHtml(page.group)}</span><h1><i class="fas ${page.icon}" aria-hidden="true"></i>${escapeHtml(page.title)}</h1></div></div><div id="topbarNavHost"></div><div class="topbar-tools"><div id="topbarModeActionHost"></div><div class="topbar-search" id="topbarSearch" role="search"><i class="fas fa-search" aria-hidden="true"></i><input id="globalNavSearch" type="search" autocomplete="off" placeholder="ابحث في الصفحات والإجراءات" aria-label="البحث في الصفحات والإجراءات" /><kbd>Ctrl K</kbd><div class="search-results" id="globalSearchResults" role="listbox"></div></div><div class="connection-pill" id="connectionPill"><i class="fas fa-wifi" aria-hidden="true"></i><span id="connectionLabel">جارٍ التحقق</span></div><div class="notification-menu"><button class="topbar-icon-btn topbar-notification" id="notificationButton" type="button" title="الإشعارات" aria-label="الإشعارات" aria-expanded="false" aria-controls="notificationPanel"><i class="fas fa-bell"></i><span class="notification-badge" id="notificationBadge">0</span></button><section class="notification-panel" id="notificationPanel" aria-label="إشعارات النظام"><div class="notification-panel-head"><div><strong>إشعارات النظام</strong><span id="notificationCountLabel">كل الإشعارات مقروءة</span></div><button id="markAllNotificationsRead" type="button">تحديد الكل كمقروء</button></div><div class="notification-list" id="notificationList"><div class="notification-empty"><i class="fas fa-bell-slash"></i><strong>لا توجد إشعارات</strong><span>ستظهر هنا تنبيهات النظام والطلبات الجديدة.</span></div></div><div class="notification-panel-foot"><a href="${resolveSidebarHref('settings.html')}#notificationSettingsCard">إعدادات الإشعارات</a><button id="clearAllNotifications" type="button">مسح السجل</button></div></section></div><div class="topbar-user-menu"><button class="topbar-icon-btn topbar-user-button" id="userMenuButton" type="button" title="الحساب" aria-label="عرض بيانات المستخدم" aria-expanded="false" aria-controls="userPanel"><span class="topbar-avatar"><i class="fas fa-user"></i></span><span class="topbar-user-name">${escapeHtml(user.name)} · ${escapeHtml(user.role)}</span><i class="fas fa-chevron-down user-menu-chevron" aria-hidden="true"></i></button><section class="user-panel" id="userPanel" aria-label="بيانات المستخدم"><div class="user-panel-head"><span class="user-panel-avatar"><i class="fas fa-user"></i></span><div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.role)}</small></div></div><div class="user-panel-details"><div><span>اسم المستخدم</span><strong>${escapeHtml(user.name)}</strong></div><div><span>الدور والصلاحية</span><strong>${escapeHtml(user.role)}</strong></div></div><div class="user-panel-actions"><a href="${resolveSidebarHref('settings.html')}"><i class="fas fa-gear"></i> الإعدادات</a><button id="userLogoutButton" type="button"><i class="fas fa-right-from-bracket"></i> تسجيل الخروج</button></div></section></div></div></header>`;
}

function ensureNavigationShell() {
  const existingSidebar = document.getElementById('sidebar-container');
  const existingMain = document.querySelector('.main-content, main, .content');
  if (existingSidebar && existingMain && existingSidebar.parentElement?.classList.contains('app-wrapper')) return;

  const sidebarHost = existingSidebar || document.createElement('div');
  sidebarHost.id = 'sidebar-container';

  const main = existingMain || document.createElement('main');
  main.classList.add('main-content');

  const shell = document.createElement('div');
  shell.className = 'app-wrapper unified-shell';

  // 1️⃣ نضيف sidebarHost و main إلى shell أولاً
  shell.appendChild(sidebarHost);
  shell.appendChild(main);

  // 2️⃣ ننقل عناصر body الأخرى إلى main
  const children = Array.from(document.body.children);
  for (const child of children) {
    if (child === shell || child === sidebarHost || child === main ||
        child.tagName === 'SCRIPT' || child.tagName === 'STYLE') {
      continue;
    }
    if (child.parentNode === document.body && child !== main) {
      main.appendChild(child);
    }
  }

  // 3️⃣ نضع shell في بداية body
  if (!document.body.contains(shell)) {
    document.body.insertBefore(shell, document.body.firstChild);
  }
}

function ensureTopbar() {
  if (document.getElementById('appTopbar')) return;
  const main = document.querySelector('.main-content, main, .content');
  if (main) { main.insertAdjacentHTML('afterbegin', pageHeaderMarkup()); main.classList.add('has-app-topbar'); }
  else { const fallback = document.createElement('div'); fallback.innerHTML = pageHeaderMarkup(); document.body.insertBefore(fallback.firstElementChild, document.body.firstChild); }
  document.body.classList.add('has-unified-navigation');
}

function renderNavigationMode(style = getStoredNavStyle()) {
  const normalized = normalizeNavStyle(style);
  const navHost = document.getElementById('topbarNavHost');
  const actionHost = document.getElementById('topbarModeActionHost');
  if (navHost) navHost.innerHTML = normalized === 'topbar-dropdown' ? renderTopbarDropdowns() : '';
  if (actionHost) actionHost.innerHTML = normalized === 'app-launcher' ? '<button class="topbar-icon-btn launcher-trigger" id="launcherTrigger" type="button" aria-label="فتح لوحة التطبيقات" aria-expanded="false" aria-controls="navLauncherOverlay" title="لوحة التطبيقات"><i class="fas fa-grip"></i></button>' : '';
  const existingOverlay = document.getElementById('navLauncherOverlay');
  if (normalized === 'app-launcher' && !existingOverlay) document.body.insertAdjacentHTML('beforeend', launcherMarkup());
  closeTopbarDropdowns();
  bindLauncherInteractions();
  applyNavStyle(normalized);
}

function applyNavStyle(style, persist = false) {
  const normalized = normalizeNavStyle(style);
  if (persist) localStorage.setItem('nav_style', normalized);
  document.body.classList.remove('nav-style-sidebar', 'nav-style-topbar', 'nav-style-launcher');
  document.body.classList.add(navStyleClass(normalized));
  document.body.dataset.navStyle = normalized;
  const sidebar = document.getElementById('mainSidebar');
  if (normalized === 'sidebar') { renderSidebar('sidebar-container'); }
  else if (sidebar) { sidebar.classList.remove('open'); document.body.classList.remove('sidebar-mobile-open', 'sidebar-collapsed'); }
  if (normalized !== 'app-launcher') setLauncherOpen(false);
  renderNavigationModeWithoutRecursion(normalized);
}

function renderNavigationModeWithoutRecursion(normalized) {
  const navHost = document.getElementById('topbarNavHost');
  const actionHost = document.getElementById('topbarModeActionHost');
  if (navHost) navHost.innerHTML = normalized === 'topbar-dropdown' ? renderTopbarDropdowns() : '';
  if (actionHost) actionHost.innerHTML = normalized === 'app-launcher' ? '<button class="topbar-icon-btn launcher-trigger" id="launcherTrigger" type="button" aria-label="فتح لوحة التطبيقات" aria-expanded="false" aria-controls="navLauncherOverlay" title="لوحة التطبيقات"><i class="fas fa-grip"></i></button>' : '';
  if (normalized === 'app-launcher' && !document.getElementById('navLauncherOverlay')) document.body.insertAdjacentHTML('beforeend', launcherMarkup());
  bindLauncherInteractions();
}

function addToggleButton() {
  const btn = document.getElementById('sidebarToggleBtn');
  if (!btn || btn.dataset.bound === 'true') return;
  btn.dataset.bound = 'true'; btn.addEventListener('click', () => toggleSidebar());
  if (localStorage.getItem('sidebarHidden') === 'true' && window.innerWidth > 768 && getStoredNavStyle() === 'sidebar') toggleSidebar(true);
}
function toggleSidebar(force) {
  if (getStoredNavStyle() !== 'sidebar') return;
  const sidebar = document.getElementById('mainSidebar'); if (!sidebar) return;
  const mobile = window.innerWidth <= 768;
  if (mobile) {
    const open = force === undefined ? !document.body.classList.contains('sidebar-mobile-open') : Boolean(force);
    sidebar.classList.remove('hidden'); document.body.classList.remove('sidebar-collapsed'); document.body.classList.toggle('sidebar-mobile-open', open); sidebar.classList.toggle('open', open); return;
  }
  const hidden = force === undefined ? !document.body.classList.contains('sidebar-collapsed') : Boolean(force);
  document.body.classList.toggle('sidebar-collapsed', hidden); sidebar.classList.toggle('hidden', hidden); localStorage.setItem('sidebarHidden', String(hidden));
}
function bindSidebarInteractions() {
  const backdrop = document.getElementById('sidebarBackdrop');
  if (backdrop && backdrop.dataset.bound !== 'true') { backdrop.dataset.bound = 'true'; backdrop.addEventListener('click', () => toggleSidebar(false)); }
  document.querySelectorAll('.nav-sublink').forEach((link) => { if (link.dataset.bound === 'true') return; link.dataset.bound = 'true'; link.addEventListener('click', () => { if (window.innerWidth <= 768) toggleSidebar(false); }); });
}

function updateConnectionStatus() {
  const pill = document.getElementById('connectionPill'); const label = document.getElementById('connectionLabel'); if (!pill || !label) return;
  const online = navigator.onLine; pill.classList.toggle('offline', !online); label.textContent = online ? 'متصل' : 'وضع عدم الاتصال'; pill.title = online ? 'الاتصال بالخادم متاح' : 'سيتم حفظ العمليات محليًا عند دعمها';
}
function setSearchOpen(open, focus = false) {
  const input = document.getElementById('globalNavSearch');
  if (open && focus) input?.focus();
  if (!open) document.getElementById('globalSearchResults')?.classList.remove('visible');
}
function bindSearchToggle() { /* البحث عاد إلى الحقل الكامل السابق، ولا يحتاج زر توسعة. */ }
function bindUserMenu() {
  if (document.body.dataset.navStyle !== 'topbar-dropdown') return;
  const wrapper = document.querySelector('.topbar-user-menu'); const button = document.getElementById('userMenuButton'); if (!wrapper || !button || button.dataset.bound === 'true') return;
  button.dataset.bound = 'true';
  const setOpen = (open) => { wrapper.classList.toggle('is-open', Boolean(open)); button.setAttribute('aria-expanded', String(Boolean(open))); };
  button.addEventListener('click', (event) => { event.stopPropagation(); setOpen(!wrapper.classList.contains('is-open')); });
  wrapper.addEventListener('click', (event) => event.stopPropagation());
  document.getElementById('userLogoutButton')?.addEventListener('click', () => window.logout());
  if (!document.body.dataset.userMenuDocumentBound) { document.body.dataset.userMenuDocumentBound = 'true'; document.addEventListener('click', (event) => { if (!event.target.closest('.topbar-user-menu')) document.querySelectorAll('.topbar-user-menu.is-open').forEach((menu) => { menu.classList.remove('is-open'); menu.querySelector('#userMenuButton')?.setAttribute('aria-expanded', 'false'); }); }); }
}
function bindGlobalSearch() {
  const input = document.getElementById('globalNavSearch'); const results = document.getElementById('globalSearchResults'); if (!input || !results || input.dataset.bound === 'true') return;
  input.dataset.bound = 'true';
  const renderResults = () => { const query = input.value.trim().toLowerCase(); const matches = allNavigationLinks().filter((link) => !query || link.label.toLowerCase().includes(query)).slice(0, 7); results.innerHTML = matches.length ? matches.map((link) => `<a href="${resolveSidebarHref(link.href)}" role="option"><i class="fas ${link.icon}"></i><span>${escapeHtml(link.label)}</span></a>`).join('') : '<div class="search-empty">لا توجد نتائج مطابقة</div>'; results.classList.add('visible'); };
  input.addEventListener('focus', () => { setSearchOpen(true); renderResults(); }); input.addEventListener('input', renderResults);
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { const first = results.querySelector('a'); if (first) window.location.href = first.href; } if (event.key === 'Escape') { setSearchOpen(false); input.blur(); } });
  if (!document.body.dataset.globalSearchDocumentBound) { document.body.dataset.globalSearchDocumentBound = 'true'; document.addEventListener('click', (event) => { if (!event.target.closest('.topbar-search')) document.querySelectorAll('.search-results').forEach((item) => item.classList.remove('visible')); }); }
}
function bindKeyboardShortcut() {
  if (document.body.dataset.navKeyboardBound === 'true') return;
  document.body.dataset.navKeyboardBound = 'true'; document.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); document.getElementById('globalNavSearch')?.focus(); } });
}
function resetTopbarDropdownPosition(menu) { if (!menu) return; menu.style.top = ''; menu.style.right = ''; menu.style.left = ''; }
function positionTopbarDropdown(group) {
  const trigger = group?.querySelector('.topbar-nav-trigger'); const menu = group?.querySelector('.topbar-dropdown-menu'); if (!trigger || !menu) return;
  const triggerRect = trigger.getBoundingClientRect(); const menuWidth = Math.min(menu.offsetWidth || 240, window.innerWidth - 16);
  const desiredRight = window.innerWidth - triggerRect.right; const right = Math.max(8, Math.min(desiredRight, window.innerWidth - menuWidth - 8));
  menu.style.top = `${Math.round(triggerRect.bottom + 8)}px`; menu.style.right = `${Math.round(right)}px`; menu.style.left = 'auto';
}
function repositionOpenTopbarDropdown() { const group = document.querySelector('.topbar-nav-group.is-open'); if (group) positionTopbarDropdown(group); }
function closeTopbarDropdowns() { document.querySelectorAll('.topbar-nav-group.is-open').forEach((group) => { group.classList.remove('is-open'); group.querySelector('.topbar-nav-trigger')?.setAttribute('aria-expanded', 'false'); resetTopbarDropdownPosition(group.querySelector('.topbar-dropdown-menu')); }); }
function bindTopbarDropdowns() {
  document.querySelectorAll('.topbar-nav-trigger').forEach((trigger) => {
    if (trigger.dataset.bound === 'true') return;
    trigger.dataset.bound = 'true';
    trigger.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      const group = trigger.closest('.topbar-nav-group'); const open = !group.classList.contains('is-open');
      closeTopbarDropdownsExcept(group); group.classList.toggle('is-open', open); trigger.setAttribute('aria-expanded', String(open));
      if (open) positionTopbarDropdown(group); else resetTopbarDropdownPosition(group.querySelector('.topbar-dropdown-menu'));
    });
  });
  if (document.body.dataset.topbarDropdownBound !== 'true') {
    document.body.dataset.topbarDropdownBound = 'true';
    document.addEventListener('click', (event) => { if (!event.target.closest('.topbar-nav-group')) closeTopbarDropdowns(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeTopbarDropdowns(); });
    window.addEventListener('resize', repositionOpenTopbarDropdown);
    window.addEventListener('scroll', repositionOpenTopbarDropdown, true);
  }
}
function closeTopbarDropdownsExcept(exception) { document.querySelectorAll('.topbar-nav-group.is-open').forEach((group) => { if (group !== exception) { group.classList.remove('is-open'); group.querySelector('.topbar-nav-trigger')?.setAttribute('aria-expanded', 'false'); resetTopbarDropdownPosition(group.querySelector('.topbar-dropdown-menu')); } }); }
function setLauncherOpen(open) {
  const overlay = document.getElementById('navLauncherOverlay'); const trigger = document.getElementById('launcherTrigger'); if (!overlay) return;
  overlay.hidden = !open; overlay.setAttribute('aria-hidden', String(!open)); trigger?.setAttribute('aria-expanded', String(open)); document.body.classList.toggle('launcher-open', open);
  if (open) overlay.querySelector('.launcher-close')?.focus();
}
function bindLauncherInteractions() {
  const trigger = document.getElementById('launcherTrigger');
  if (trigger && trigger.dataset.bound !== 'true') { trigger.dataset.bound = 'true'; trigger.addEventListener('click', () => setLauncherOpen(true)); }
  const close = document.getElementById('launcherCloseBtn');
  if (close && close.dataset.bound !== 'true') { close.dataset.bound = 'true'; close.addEventListener('click', () => setLauncherOpen(false)); }
  const overlay = document.getElementById('navLauncherOverlay');
  if (overlay && overlay.dataset.bound !== 'true') { overlay.dataset.bound = 'true'; overlay.addEventListener('click', (event) => { if (event.target === overlay) setLauncherOpen(false); }); }
  if (document.body.dataset.launcherKeyboardBound !== 'true') { document.body.dataset.launcherKeyboardBound = 'true'; document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setLauncherOpen(false); }); }
}

window.logout = function () { if (!confirm('هل أنت متأكد من الخروج؟')) return; window.POSPermissions?.recordLogout?.(); localStorage.removeItem('pos_token'); localStorage.removeItem('pos_user'); window.location.href = isDriverPage() ? '../index.html' : 'index.html'; };
window.NAV_GROUPS = NAV_GROUPS;
window.SIDEBAR_LINKS = allNavigationLinks();
window.renderSidebar = renderSidebar;
window.toggleSidebar = toggleSidebar;
window.applyNavigationStyle = (style, persist = true) => { applyNavStyle(style, persist); bindSearchToggle(); bindGlobalSearch(); bindUserMenu(); };
window.refreshUnifiedNavigation = () => { const style = getStoredNavStyle(); applyNavStyle(style); bindSearchToggle(); bindGlobalSearch(); bindUserMenu(); bindTopbarDropdowns(); updateConnectionStatus(); };

function initUnifiedNavigation() {
  const style = getStoredNavStyle();
  applyNavStyle(style);
  ensureNavigationShell();
  ensureTopbar();
  renderNavigationModeWithoutRecursion(style);
  if (style === 'sidebar') renderSidebar('sidebar-container');
  bindSearchToggle(); bindGlobalSearch(); bindUserMenu(); bindKeyboardShortcut(); bindTopbarDropdowns(); updateConnectionStatus();
  if (!document.body.dataset.navigationConnectionBound) { document.body.dataset.navigationConnectionBound = 'true'; window.addEventListener('online', updateConnectionStatus); window.addEventListener('offline', updateConnectionStatus); }
  window.POSNotificationCenter?.init?.();
}

/* يطبّق النمط قبل DOMContentLoaded لتقليل وميض التخطيط عند الانتقال بين الصفحات. */
if (document.body) { const initialStyle = getStoredNavStyle(); document.body.classList.add(navStyleClass(initialStyle)); document.body.dataset.navStyle = initialStyle; }
document.addEventListener('DOMContentLoaded', initUnifiedNavigation);
