// sidebar-config.js - ملف التكوين المركزي للشريط الجانبي

// قائمة الروابط (أضف أو احذف الصفحات من هنا)
const SIDEBAR_LINKS = [
  { icon: 'fa-th-large', label: 'لوحة التحكم', href: 'index.html' },
  { icon: 'fa-globe', label: 'طلب إنترنت', href: 'add_order.html' },
  { icon: 'fa-list-alt', label: 'إدارة الطلبات والمندوبين', href: 'orders.html' },
  { icon: 'fa-truck-moving', label: 'واجهة المندوب', href: 'driver/index.html' },
  { icon: 'fa-chart-line', label: 'تقارير الإنترنت', href: 'online-reports.html' },
  { icon: 'fa-cash-register', label: 'البيع', href: 'sale.html' },
  { icon: 'fa-boxes', label: 'المنتجات', href: 'products.html' },
  { icon: 'fa-history', label: 'حركة المخزون', href: 'stock-movements.html' },
  { icon: 'fa-users', label: 'العملاء', href: 'customers.html' },
  { icon: 'fa-truck', label: 'الموردين', href: 'suppliers.html' },
  { icon: 'fa-shopping-cart', label: 'المشتريات', href: 'purchases.html' },
  { icon: 'fa-receipt', label: 'المصروفات', href: 'expenses.html' },
  { icon: 'fa-hand-holding-usd', label: 'سندات', href: 'payments.html' },
  { icon: 'fa-wallet', label: 'المحافظ', href: 'cash-wallets.html' },
  { icon: 'fa-coins', label: 'الصندوق', href: 'cash-wallets.html' }, // نفس الصفحة للمحافظ والصندوق
  { icon: 'fa-file-invoice', label: 'الفواتير', href: 'invoices.html' },
  { icon: 'fa-book', label: 'القيود', href: 'journal.html' },
  { icon: 'fa-chart-pie', label: 'التقارير', href: 'reports.html' },
  { icon: 'fa-tools', label: 'عمليات', href: 'operations.html' },
  { icon: 'fa-cog', label: 'إعدادات', href: 'settings.html' },
  { icon: 'fa-print', label: 'طباعة باركود', href: 'barcode-print.html' },
  { icon: 'fa-bell', label: 'اختبار الإشعارات', href: 'notification-test.html' }
];

// دالة لإنشاء الشريط الجانبي وإدراجه في الصفحة
function renderSidebar(containerId = 'sidebar-container') {
  const container = document.getElementById(containerId);
  if (!container) {
    console.warn('لم يتم العثور على حاوية الشريط الجانبي');
    return;
  }

  // تحديد الصفحة الحالية
  const currentPath = window.location.pathname.split('/').pop() || 'index.html';

  // بناء هيكل الشريط
  let html = `
    <nav class="sidebar" id="mainSidebar">
      <div class="brand">
        <i class="fas fa-store-alt"></i>
        <span>ابن المختار</span>
        <small>نظام نقاط البيع</small>
      </div>
  `;

  SIDEBAR_LINKS.forEach(link => {
    const isActive = link.href === currentPath ? 'active' : '';
    html += `
      <a class="nav-link ${isActive}" href="${link.href}">
        <i class="fas ${link.icon}"></i>
        <span>${link.label}</span>
      </a>
    `;
  });

  // زر الخروج
  html += `
      <div class="logout-btn">
        <div class="nav-link" onclick="logout()" style="color:var(--danger);">
          <i class="fas fa-sign-out-alt"></i>
          <span>خروج</span>
        </div>
      </div>
    </nav>
  `;

  container.innerHTML = html;

  // إضافة زر toggle (سيتم وضعه خارج الشريط)
  addToggleButton(containerId);
}

// دالة لإضافة زر إظهار/إخفاء الشريط
function addToggleButton(containerId) {
  // التحقق من وجود الزر مسبقاً
  if (document.getElementById('sidebarToggleBtn')) return;

  const btn = document.createElement('button');
  btn.id = 'sidebarToggleBtn';
  btn.className = 'sidebar-toggle-btn';
  btn.innerHTML = '<i class="fas fa-bars"></i>';
  btn.setAttribute('aria-label', 'تبديل الشريط الجانبي');
  btn.title = 'إظهار/إخفاء القائمة';

  // إضافة الزر إلى أعلى الصفحة (بجوار المحتوى)
  const mainContent = document.querySelector('.main-content') || document.body;
  mainContent.prepend(btn);

  // استعادة حالة الإخفاء من localStorage
  const sidebarHidden = localStorage.getItem('sidebarHidden') === 'true';
  if (sidebarHidden) {
    toggleSidebar(true);
  }

  // حدث النقر
  btn.addEventListener('click', function() {
    const isHidden = document.getElementById('mainSidebar').classList.toggle('hidden');
    localStorage.setItem('sidebarHidden', isHidden);
    // إضافة أو إزالة كلاس للصفحة لضبط التباعد
    document.body.classList.toggle('sidebar-collapsed', isHidden);
  });
}

// دالة لإخفاء/إظهار الشريط برمجياً
function toggleSidebar(hide) {
  const sidebar = document.getElementById('mainSidebar');
  if (!sidebar) return;
  if (hide) {
    sidebar.classList.add('hidden');
    document.body.classList.add('sidebar-collapsed');
  } else {
    sidebar.classList.remove('hidden');
    document.body.classList.remove('sidebar-collapsed');
  }
}

// دالة تسجيل الخروج (موجودة أيضاً في الصفحات، لكن نضمن وجودها)
window.logout = function() {
  if (confirm('هل أنت متأكد من الخروج؟')) {
    localStorage.removeItem('pos_token');
    localStorage.removeItem('pos_user');
    window.location.href = 'index.html';
  }
};

// تحميل الشريط عند تحميل الصفحة (يمكن استدعاؤها يدوياً أيضاً)
document.addEventListener('DOMContentLoaded', function() {
  // إذا وجدت حاوية الشريط، قم بإنشائه
  if (document.getElementById('sidebar-container')) {
    renderSidebar('sidebar-container');
  }
});