/* نظام الصلاحيات المركزي للواجهة — يعمل مع جميع صفحات POS */
(function () {
  'use strict';

  const DEFAULT_ROLE_PERMISSIONS = {
    admin: ['*'],
    cashier: [
      'dashboard.view', 'sales.view', 'sales.create', 'products.view', 'products.create', 'products.update',
      'products.print_barcode', 'customers.view', 'customers.create', 'customers.update', 'suppliers.view',
      'purchases.view', 'purchases.create', 'expenses.view', 'expenses.create', 'currencies.view', 'wallets.view', 'vouchers.view', 'vouchers.create',
      'invoices.view', 'reports.view', 'online_orders.view', 'online_orders.create', 'online_orders.update', 'online_orders.cancel', 'orders.view',
      'online_reports.view', 'stock.view', 'notifications.test'
    ],
    driver: ['driver.orders.view', 'driver.orders.update', 'driver.returns.view', 'driver.returns.confirm']
  };

  const PAGE_PERMISSIONS = {
    'index.html': 'dashboard.view', 'add_order.html': 'online_orders.create', 'add_order_ph.html': 'online_orders.create|online_orders.update',
    'orders.html': 'orders.view', 'online-reports.html': 'online_reports.view', 'sale.html': 'sales.create',
    'products.html': 'products.view', 'site-integration.html': 'integration.view', 'stock-movements.html': 'stock.view',
    'inventory.html': 'inventory.adjust', 'customers.html': 'customers.view', 'suppliers.html': 'suppliers.view',
    'purchases.html': 'purchases.view', 'expenses.html': 'expenses.view', 'payments.html': 'vouchers.view',
    'cash-wallets.html': 'wallets.view|currencies.view|vouchers.view|cash.view', 'invoices.html': 'invoices.view', 'journal.html': 'accounting.view',
    'reports.html': 'reports.view', 'reports_central.html': 'reports.view', 'operations.html': 'operations.view', 'settings.html': 'settings.view', 'audit-logs.html': 'audit.view',
    'barcode-print.html': 'products.print_barcode', 'notification-test.html': 'notifications.test'
  };

  const ACTION_PERMISSIONS = {
    saveProduct: 'products.create', saveQuickProduct: 'products.create', addProductAsPending: 'products.create', editProduct: 'products.update', deleteProduct: 'products.delete',
    assignProductsToSupplier: 'catalog.supplier.assign', generateMissingSKU: 'products.update', saveAdjustment: 'inventory.adjust', confirmAddStock: 'inventory.adjust',
    saveSale: 'sales.create', quickSale: 'sales.create', confirmEditCartItem: 'sales.update', cancelSaleInvoice: 'sales.cancel', returnSaleItem: 'sales.return', returnInvoice: 'sales.return',
    savePurchase: 'purchases.create', cancelPurchaseInvoice: 'purchases.cancel', returnPurchaseItem: 'purchases.return',
    addCustomer: 'customers.create', updateCustomer: 'customers.update', addCustomerPayment: 'customers.payments', cancelCustomerPayment: 'customers.reverse',
    addSupplier: 'suppliers.create', updateSupplier: 'suppliers.update', deleteSupplier: 'suppliers.delete', addExpense: 'expenses.create', addCashOperation: 'cash.manage',
    addCashVoucher: 'vouchers.create', cancelVoucher: 'vouchers.cancel', executeTransfer: 'cash.manage', executeQuickPayment: 'cash.manage',
    addManualLine: 'accounting.journal.create', createManualJournalEntry: 'accounting.journal.create', closeAccountingYear: 'accounting.close', reopenAccounting: 'accounting.close', initializeSystemAutomatically: 'accounting.initialize',
    exportData: 'backup.export', importData: 'backup.restore', saveConfig: 'settings.manage', saveInvoiceNumbers: 'settings.invoice_numbers.manage',
    openDriverManager: 'delivery.drivers.view', openEditOrdersModal: 'online_orders.update', loadOrderForEdit: 'online_orders.update', submitOrder: 'online_orders.create|online_orders.update', openAssignOnlineDriver: 'delivery.orders.manage', submitAssignOnlineDriver: 'delivery.orders.manage', saveNewDriver: 'delivery.drivers.manage', deleteDriver: 'delivery.drivers.manage', confirmAssignDriver: 'delivery.orders.manage', updateOrderStatus: 'delivery.orders.manage', cancelOrder: 'online_orders.cancel',
    askAI: 'ai.use', exportAuditLogs: 'audit.export', loadAuditLogs: 'audit.view', linkProduct: 'integration.manage', unlinkProduct: 'integration.manage', printBarcodes: 'products.print_barcode', goToBarcodePrint: 'products.print_barcode'
  };

  const PERMISSION_CATALOG = [
    { group: 'لوحة التحكم', items: [['dashboard.view', 'عرض لوحة التحكم']] },
    { group: 'المبيعات', items: [['sales.view', 'عرض المبيعات'], ['sales.create', 'إنشاء فاتورة بيع'], ['sales.update', 'تعديل فاتورة بيع'], ['sales.return', 'إرجاع مبيعات'], ['sales.cancel', 'إلغاء فاتورة مبيعات'], ['sales.reverse', 'عكس عمليات المبيعات'], ['sales.view_cost', 'عرض تكلفة وربح المبيعات'], ['sales.export', 'تصدير المبيعات']] },
    { group: 'المنتجات والمخزون', items: [['products.view', 'عرض المنتجات'], ['products.create', 'إضافة منتج'], ['products.update', 'تعديل منتج'], ['products.delete', 'حذف منتج'], ['products.view_cost', 'عرض سعر التكلفة'], ['products.edit_cost', 'تعديل سعر التكلفة'], ['products.export_cost', 'تصدير التكلفة'], ['products.print_barcode', 'طباعة الباركود'], ['catalog.categories.manage', 'إدارة التصنيفات'], ['catalog.supplier.assign', 'إسناد المنتجات للموردين'], ['stock.view', 'عرض حركة المخزون'], ['inventory.adjust', 'تنفيذ جرد وتسوية المخزون']] },
    { group: 'المشتريات والموردون', items: [['purchases.view', 'عرض المشتريات'], ['purchases.create', 'إنشاء فاتورة شراء'], ['purchases.update', 'تعديل فاتورة شراء'], ['purchases.return', 'إرجاع مشتريات'], ['purchases.cancel', 'إلغاء فاتورة شراء'], ['purchases.reverse', 'عكس عمليات الشراء'], ['suppliers.view', 'عرض الموردين'], ['suppliers.create', 'إضافة مورد'], ['suppliers.update', 'تعديل مورد'], ['suppliers.delete', 'حذف مورد'], ['suppliers.finance.view', 'عرض أرصدة الموردين'], ['suppliers.stock.view', 'عرض مخزون الموردين']] },
    { group: 'العملاء والطلبات', items: [['customers.view', 'عرض العملاء'], ['customers.create', 'إضافة عميل'], ['customers.update', 'تعديل عميل'], ['customers.payments', 'تسجيل مدفوعات العملاء'], ['customers.reverse', 'عكس عمليات العملاء'], ['online_orders.view', 'عرض الطلبات الإلكترونية'], ['online_orders.create', 'إنشاء طلب إلكتروني'], ['online_orders.update', 'تعديل طلب إلكتروني معلق'], ['online_orders.cancel', 'إلغاء طلب إلكتروني'], ['orders.view', 'إدارة الطلبات والمندوبين'], ['delivery.orders.manage', 'تعديل حالات وإسناد الطلبات'], ['online_reports.view', 'تقارير الإنترنت']] },
    { group: 'المالية والمحاسبة', items: [['expenses.view', 'عرض المصروفات'], ['expenses.create', 'إضافة مصروف'], ['cash.view', 'عرض رصيد الصندوق وسجل الصندوق'], ['cash.manage', 'إدارة عمليات الصندوق'], ['currencies.view', 'عرض العملات وأسعار الصرف'], ['wallets.view', 'عرض أسماء المحافظ دون الأرصدة'], ['wallets.manage', 'إدارة المحافظ والتحويلات'], ['wallets.balance.view', 'عرض أرصدة المحافظ'], ['wallets.transactions.view', 'عرض سجل حركات المحافظ'], ['vouchers.view', 'عرض السندات'], ['vouchers.create', 'إنشاء سند قبض/صرف'], ['vouchers.cancel', 'إلغاء السندات'], ['accounting.view', 'عرض القيود والحسابات'], ['accounting.accounts.manage', 'إدارة الحسابات'], ['accounting.journal.create', 'إنشاء قيد يدوي'], ['accounting.reports.view', 'عرض التقارير المحاسبية'], ['accounting.initialize', 'قيد تأسيس النظام'], ['accounting.close', 'إقفال وإعادة فتح الفترة']] },
    { group: 'سجل النشاط', items: [['audit.view', 'عرض سجل نشاط المستخدمين'], ['audit.export', 'تصدير سجل النشاط']] },
    { group: 'التقارير والعمليات', items: [['reports.view', 'عرض التقارير'], ['reports.cost.view', 'عرض تقارير التكلفة والربح'], ['reports.export', 'تصدير التقارير'], ['invoices.view', 'عرض الفواتير'], ['operations.view', 'عرض العمليات'], ['operations.reverse', 'عكس العمليات'], ['notifications.test', 'اختبار الإشعارات']] },
    { group: 'الإدارة والتكاملات', items: [['delivery.drivers.view', 'عرض قائمة المندوبين'], ['settings.view', 'عرض الإعدادات'], ['settings.manage', 'تعديل الإعدادات'], ['settings.users.manage', 'إدارة المستخدمين'], ['settings.permissions.manage', 'إدارة الصلاحيات'], ['settings.invoice_numbers.manage', 'إدارة أرقام الفواتير'], ['settings.currencies.manage', 'إدارة العملات'], ['integration.view', 'عرض ربط الموقع'], ['integration.manage', 'إدارة ربط الموقع'], ['backup.export', 'تصدير النسخة الاحتياطية'], ['backup.restore', 'استعادة النسخة الاحتياطية'], ['delivery.drivers.manage', 'إدارة المندوبين'], ['ai.use', 'استخدام المساعد الذكي'] ] }
  ];

  function currentUser() {
    try { return JSON.parse(localStorage.getItem('pos_user') || '{}'); } catch (_) { return {}; }
  }
  function recordLogout() {
    const logoutToken = localStorage.getItem('pos_token');
    if (!logoutToken) return;
    try { fetch('https://api.ibnalmukhtar.com/auth/logout', { method: 'POST', keepalive: true, headers: { 'Authorization': `Bearer ${logoutToken}` } }).catch(() => {}); } catch (_) {}
  }
  function identityLabel(user) {
    const u = user || currentUser();
    return `${u.name || u.username || 'مستخدم'} · ${u.role === 'admin' ? 'مدير كامل' : u.role === 'driver' ? 'مندوب' : u.role === 'custom' ? 'مخصص' : 'كاشير'}`;
  }
  function installPageAuditHeader() {
    if (window.__posAuditFetchInstalled) return;
    window.__posAuditFetchInstalled = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const rawUrl = typeof input === 'string' ? input : input?.url || '';
      if (!rawUrl.includes('api.ibnalmukhtar.com')) return originalFetch(input, init);
      const options = init ? { ...init } : {};
      const headers = new Headers(options.headers || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
      if (!rawUrl.includes('/auth/login')) headers.set('X-Page-Name', location.pathname.split('/').pop() || 'index.html');
      options.headers = headers;
      return originalFetch(input, options);
    };
  }
  async function hydrateSession() {
    const token = localStorage.getItem('pos_token');
    if (!token) return;
    try {
      const response = await fetch('https://api.ibnalmukhtar.com/auth/me', { headers: { 'Authorization': `Bearer ${token}`, 'X-Page-Name': location.pathname.split('/').pop() || 'index.html' } });
      if (response.status === 401 || response.status === 403) {
        if (location.pathname.split('/').pop() !== 'index.html') {
          localStorage.removeItem('pos_token'); localStorage.removeItem('pos_user');
          location.href = 'index.html';
        }
        return;
      }
      if (!response.ok) { refresh(); return; }
      const data = await response.json();
      if (data.user) {
        localStorage.setItem('pos_user', JSON.stringify(data.user));
        refresh();
        window.refreshUnifiedNavigation?.();
      }
    } catch (_) {
      // انقطاع الشبكة ليس تسجيل خروج؛ نبقي token وpos_user ونستمر بالبيانات المحلية.
      refresh();
    }
  }
  function permissionsOf(user) {
    const u = user || currentUser();
    if (u.role === 'admin') return ['*'];
    const saved = Array.isArray(u.permissions) ? u.permissions : [];
    return saved.length ? saved : (DEFAULT_ROLE_PERMISSIONS[u.role] || []);
  }
  function can(permission, user) {
    const list = permissionsOf(user);
    return String(permission || '').split('|').map(value => value.trim()).filter(Boolean).some(required => list.includes('*') || list.includes(required) || list.some(p => p.endsWith('.*') && required.startsWith(p.slice(0, -1))));
  }
  function pagePermission(file) {
    return PAGE_PERMISSIONS[file || (location.pathname.split('/').pop() || 'index.html')] || null;
  }
  function canPage(file, user) {
    const permission = pagePermission(file);
    return !permission || can(permission, user);
  }
  function hide(el) {
    if (!el) return;
    el.setAttribute('aria-hidden', 'true');
    el.style.display = 'none';
  }
  function applyPermissionUI(root) {
    const host = root || document;
    host.querySelectorAll('[data-permission]').forEach(el => { if (!can(el.getAttribute('data-permission'))) hide(el); });
    host.querySelectorAll('[onclick]').forEach(el => {
      const source = el.getAttribute('onclick') || '';
      const action = Object.keys(ACTION_PERMISSIONS).find(name => new RegExp('\\b' + name + '\\s*\\(').test(source));
      if (action && !can(ACTION_PERMISSIONS[action])) hide(el);
    });
    host.querySelectorAll('[data-sensitive="cost"], [data-sensitive="profit"]').forEach(el => {
      const p = el.getAttribute('data-sensitive') === 'profit' ? 'reports.cost.view' : 'products.view_cost';
      if (!can(p) && !can('sales.view_cost')) hide(el);
    });
    host.querySelectorAll('input[data-permission-disabled], select[data-permission-disabled], textarea[data-permission-disabled]').forEach(el => {
      if (!can(el.getAttribute('data-permission-disabled'))) { el.disabled = true; el.readOnly = true; }
    });
    if (!can('products.view_cost') && !can('sales.view_cost') && !can('reports.cost.view')) {
      const labels = ['التكلفة', 'سعر التكلفة', 'إجمالي التكلفة', 'الربح المتوقع', 'الربح', 'سعر الشراء', 'شراء:'];
      host.querySelectorAll('*').forEach(el => {
        if (el.children.length > 0) return;
        const text = (el.textContent || '').trim();
        if (text && labels.some(label => text.includes(label))) {
          const target = el.closest('.form-group, .detail-row, .stat-card, .summary-card, th, td, .card, .field-wrapper') || el;
          hide(target);
        }
      });
    }
  }
  function guardPage() {
    const file = location.pathname.split('/').pop() || 'index.html';
    const needed = pagePermission(file);
    if (!needed || can(needed) || file === 'index.html') return;
    document.body.classList.add('permission-denied');
    document.querySelectorAll('body > *:not(#permission-denied-overlay)').forEach(el => { if (el.id !== 'permission-denied-overlay') el.style.display = 'none'; });
    const overlay = document.createElement('div');
    overlay.id = 'permission-denied-overlay';
    overlay.dir = 'rtl';
    overlay.innerHTML = '<div class="permission-denied-card"><i class="fas fa-lock"></i><h1>لا توجد صلاحية</h1><p>لا تملك الصلاحية اللازمة لفتح هذه الصفحة.</p><button type="button" onclick="location.href=\'index.html\'">العودة للرئيسية</button></div>';
    document.body.appendChild(overlay);
  }
  function refresh() { applyPermissionUI(document); guardPage(); }

  window.POSPermissions = { can, canPage, pagePermission, permissionsOf, currentUser, identityLabel, recordLogout, refresh, hydrateSession, catalog: PERMISSION_CATALOG, defaults: DEFAULT_ROLE_PERMISSIONS };
  window.POS_PERMISSION_CATALOG = PERMISSION_CATALOG;
  document.addEventListener('DOMContentLoaded', function () {
    const style = document.createElement('style');
    style.textContent = '.permission-denied{background:#f8fafc}.permission-denied-card{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;font-family:Cairo,Arial;color:#172033;background:#f8fafc;z-index:99999}.permission-denied-card i{font-size:48px;color:#dc3545}.permission-denied-card button{border:0;border-radius:8px;background:#1d4ed8;color:#fff;padding:11px 22px;cursor:pointer}';
    document.head.appendChild(style);
    refresh();
    installPageAuditHeader();
    hydrateSession();
    const observer = new MutationObserver(mutations => mutations.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) applyPermissionUI(n); })));
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();

