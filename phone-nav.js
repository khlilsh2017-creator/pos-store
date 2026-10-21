/**
 * phone-nav.js - القائمة الجانبية الموحدة لتطبيقات الجوال (ابن المختار)
 * يوفر شريط تنقل جانبي (Drawer) سلس وسريع وسهل اللمس للتنقل بين شاشات الجوال
 */
(function() {
  'use strict';

  const PhoneNav = {
    isOpen: false,

    getItems() {
      return [
        {
          section: 'الطلبات والمبيعات',
          items: [
            {
              id: 'add_order',
              title: 'إنشاء طلب إنترنت',
              sub: 'إضافة وتعديل الطلبات والصور',
              icon: 'fa-plus-circle',
              iconBg: '#eff6ff',
              iconColor: '#1d63c6',
              url: '/phone/add_order_ph.html'
            },
            {
              id: 'orders',
              title: 'إدارة طلبات الإنترنت',
              sub: 'متابعة الحالات والفواتير والطباعة',
              icon: 'fa-list-check',
              iconBg: '#f0fdf4',
              iconColor: '#16a34a',
              url: '/phone/orders.html'
            },
            {
              id: 'prep',
              title: 'تجهيز وتغليف الطلبات',
              sub: 'فحص الموديلات والقطع والتغليف',
              icon: 'fa-box-open',
              iconBg: '#fef3c7',
              iconColor: '#d97706',
              url: '/phone/prep.html'
            }
          ]
        },
        {
          section: 'التوصيل والمندوبين',
          items: [
            {
              id: 'drivers',
              title: 'إدارة المندوبين PWA',
              sub: 'تسوية العهد والكشوفات والحسابات',
              icon: 'fa-id-card-clip',
              iconBg: '#f5f3ff',
              iconColor: '#7c3aed',
              url: '/drivers'
            },
            {
              id: 'driver_app',
              title: 'تطبيق المندوب الميداني',
              sub: 'شاشة استلام وتسليم الطلبات',
              icon: 'fa-motorcycle',
              iconBg: '#ecfeff',
              iconColor: '#0891b2',
              url: '/driver/'
            }
          ]
        },
        {
          section: 'النظام والإعدادات',
          items: [
            {
              id: 'phone_home',
              title: 'بوابة تطبيقات الجوال',
              sub: 'شاشة البداية واختيار التطبيق',
              icon: 'fa-mobile-screen',
              iconBg: '#f1f5f9',
              iconColor: '#475569',
              url: '/phone/index.html'
            },
            {
              id: 'settings',
              title: 'إعدادات الخادم والشبكة',
              sub: 'التبديل بين السيرفر الأساسي والاحتياطي',
              icon: 'fa-gear',
              iconBg: '#fef2f2',
              iconColor: '#dc2626',
              action: 'settings'
            },
            {
              id: 'main_pos',
              title: 'النظام المحاسبي الرئيسي (POS)',
              sub: 'واجهة الكمبيوتر والمبيعات الشاملة',
              icon: 'fa-desktop',
              iconBg: '#f8fafc',
              iconColor: '#0f172a',
              url: '/index.html'
            }
          ]
        }
      ];
    },

    getCurrentId() {
      const p = (window.location.pathname || '').toLowerCase();
      if (p.includes('add_order_ph')) return 'add_order';
      if (p.includes('orders.html') || p.endsWith('/orders')) return 'orders';
      if (p.includes('prep.html') || p.endsWith('/prep')) return 'prep';
      if (p.includes('drivers') || p.includes('driver')) {
        if (p.includes('/driver/')) return 'driver_app';
        return 'drivers';
      }
      if (p.includes('/phone/index') || p.endsWith('/phone/')) return 'phone_home';
      return '';
    },

    getUserInfo() {
      try {
        const raw = localStorage.getItem('pos_user');
        if (raw) {
          const u = JSON.parse(raw);
          return {
            name: u.name || u.username || 'مستخدم POS',
            role: u.role || 'موظف النظام'
          };
        }
      } catch (e) {}
      return { name: 'مستخدم POS', role: 'متصل بالنظام' };
    },

    injectStyles() {
      if (document.getElementById('phone-nav-styles')) return;
      const css = `
        /* --- زر القائمة الجانبية الموحد --- */
        .phone-nav-btn {
          display: inline-flex !important;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
          border-radius: 10px;
          background: #f1f5f9;
          color: #1e293b;
          border: 1px solid #cbd5e1;
          cursor: pointer;
          font-size: 1.05rem;
          padding: 0;
          flex-shrink: 0;
          transition: all 0.15s ease;
          -webkit-tap-highlight-color: transparent;
          margin-inline-end: 6px;
          vertical-align: middle;
        }
        .phone-nav-btn:hover {
          background: #e2e8f0;
          color: #0f172a;
        }
        .phone-nav-btn:active {
          transform: scale(0.94);
        }
        [data-theme="dark"] .phone-nav-btn, .dark-mode .phone-nav-btn, body.dark .phone-nav-btn {
          background: #1e293b;
          color: #f8fafc;
          border-color: #334155;
        }

        /* --- خلفية التعتيم --- */
        .phone-nav-overlay {
          position: fixed;
          inset: 0;
          background: rgba(15, 23, 42, 0.55);
          backdrop-filter: blur(3px);
          -webkit-backdrop-filter: blur(3px);
          z-index: 99998;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.25s ease;
        }
        .phone-nav-overlay.open {
          opacity: 1;
          pointer-events: auto;
        }

        /* --- حاوية القائمة الجانبية (Drawer) --- */
        .phone-nav-drawer {
          position: fixed;
          top: 0;
          right: 0;
          bottom: 0;
          width: min(320px, 86vw);
          background: #ffffff;
          z-index: 99999;
          box-shadow: -8px 0 30px rgba(0, 0, 0, 0.18);
          display: flex;
          flex-direction: column;
          transform: translateX(105%);
          transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
          direction: rtl;
          font-family: 'Cairo', system-ui, -apple-system, sans-serif;
          user-select: none;
          -webkit-user-select: none;
        }
        .phone-nav-drawer.open {
          transform: translateX(0);
        }
        [data-theme="dark"] .phone-nav-drawer, .dark-mode .phone-nav-drawer, body.dark .phone-nav-drawer {
          background: #0f172a;
          color: #f8fafc;
        }

        /* --- رأس القائمة --- */
        .phone-nav-header {
          background: linear-gradient(135deg, #123b72 0%, #1d63c6 100%);
          color: #ffffff;
          padding: calc(16px + env(safe-area-inset-top, 0px)) 16px 16px 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          position: relative;
        }
        .phone-nav-brand-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .phone-nav-brand {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .phone-nav-logo {
          width: 38px;
          height: 38px;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.2);
          backdrop-filter: blur(4px);
          display: grid;
          place-items: center;
          font-size: 1.25rem;
          color: #ffffff;
        }
        .phone-nav-title {
          font-size: 1rem;
          font-weight: 800;
          line-height: 1.2;
          margin: 0;
        }
        .phone-nav-subtitle {
          font-size: 0.68rem;
          opacity: 0.85;
          margin: 0;
        }
        .phone-nav-close-btn {
          width: 34px;
          height: 34px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.16);
          border: none;
          color: #ffffff;
          font-size: 1rem;
          cursor: pointer;
          display: grid;
          place-items: center;
          transition: background 0.15s;
        }
        .phone-nav-close-btn:hover {
          background: rgba(255, 255, 255, 0.28);
        }

        .phone-nav-user-pill {
          background: rgba(0, 0, 0, 0.22);
          border-radius: 12px;
          padding: 8px 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          font-size: 0.76rem;
        }
        .phone-nav-user-name {
          font-weight: 700;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .phone-nav-user-role {
          font-size: 0.64rem;
          opacity: 0.85;
        }

        /* --- محتوى القائمة --- */
        .phone-nav-body {
          flex: 1;
          overflow-y: auto;
          padding: 12px 10px;
          -webkit-overflow-scrolling: touch;
        }
        .phone-nav-section-title {
          font-size: 0.68rem;
          font-weight: 800;
          color: #64748b;
          text-transform: uppercase;
          margin: 12px 8px 6px;
          letter-spacing: 0.5px;
        }
        [data-theme="dark"] .phone-nav-section-title, .dark-mode .phone-nav-section-title {
          color: #94a3b8;
        }

        .phone-nav-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 12px;
          border-radius: 12px;
          color: #1e293b;
          text-decoration: none;
          margin-bottom: 4px;
          transition: all 0.15s ease;
          cursor: pointer;
          border: 1px solid transparent;
        }
        .phone-nav-item:hover {
          background: #f8fafc;
        }
        .phone-nav-item.active {
          background: #eff6ff;
          border-color: #bfdbfe;
          color: #1d63c6;
        }
        [data-theme="dark"] .phone-nav-item, .dark-mode .phone-nav-item {
          color: #e2e8f0;
        }
        [data-theme="dark"] .phone-nav-item:hover, .dark-mode .phone-nav-item:hover {
          background: #1e293b;
        }
        [data-theme="dark"] .phone-nav-item.active, .dark-mode .phone-nav-item.active {
          background: #1e293b;
          border-color: #3b82f6;
          color: #60a5fa;
        }

        .phone-nav-item-icon {
          width: 36px;
          height: 36px;
          border-radius: 10px;
          display: grid;
          place-items: center;
          font-size: 1rem;
          flex-shrink: 0;
        }
        .phone-nav-item-text {
          flex: 1;
          min-width: 0;
        }
        .phone-nav-item-title {
          font-size: 0.84rem;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 2px;
        }
        .phone-nav-item-sub {
          font-size: 0.66rem;
          color: #64748b;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        [data-theme="dark"] .phone-nav-item-sub, .dark-mode .phone-nav-item-sub {
          color: #94a3b8;
        }
        .phone-nav-active-badge {
          background: #1d63c6;
          color: #fff;
          font-size: 0.6rem;
          padding: 1px 6px;
          border-radius: 6px;
          font-weight: 700;
        }

        /* --- تذييل القائمة --- */
        .phone-nav-footer {
          padding: 12px;
          border-top: 1px solid #e2e8f0;
          background: #f8fafc;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        [data-theme="dark"] .phone-nav-footer, .dark-mode .phone-nav-footer {
          border-color: #334155;
          background: #0b1120;
        }
        .phone-nav-logout-btn {
          width: 100%;
          padding: 10px;
          border-radius: 10px;
          background: #fee2e2;
          color: #dc2626;
          border: 1px solid #fca5a5;
          font-family: inherit;
          font-size: 0.78rem;
          font-weight: 700;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          transition: background 0.15s;
        }
        .phone-nav-logout-btn:hover {
          background: #fecaca;
        }
        [data-theme="dark"] .phone-nav-logout-btn, .dark-mode .phone-nav-logout-btn {
          background: #450a0a;
          color: #f87171;
          border-color: #7f1d1d;
        }
      `;
      const styleEl = document.createElement('style');
      styleEl.id = 'phone-nav-styles';
      styleEl.textContent = css;
      document.head.appendChild(styleEl);
    },

    buildDrawerHTML() {
      const user = this.getUserInfo();
      const currentId = this.getCurrentId();
      const sections = this.getItems();

      let sectionsHtml = '';
      sections.forEach(sec => {
        sectionsHtml += `<div class="phone-nav-section-title">${sec.section}</div>`;
        sec.items.forEach(item => {
          const isActive = item.id === currentId;
          const activeClass = isActive ? 'active' : '';
          const activeBadge = isActive ? '<span class="phone-nav-active-badge">الحالية</span>' : '';
          
          let clickHandler = '';
          if (item.action === 'settings') {
            clickHandler = `onclick="PhoneNav.openSettings()"`;
          } else {
            clickHandler = `onclick="PhoneNav.navigate('${item.url}')"`;
          }

          sectionsHtml += `
            <div class="phone-nav-item ${activeClass}" ${clickHandler}>
              <div class="phone-nav-item-icon" style="background:${item.iconBg}; color:${item.iconColor};">
                <i class="fas ${item.icon}"></i>
              </div>
              <div class="phone-nav-item-text">
                <div class="phone-nav-item-title">
                  <span>${item.title}</span>
                  ${activeBadge}
                </div>
                <div class="phone-nav-item-sub">${item.sub}</div>
              </div>
            </div>
          `;
        });
      });

      return `
        <div class="phone-nav-overlay" id="phoneNavOverlay" onclick="PhoneNav.close()"></div>
        <aside class="phone-nav-drawer" id="phoneNavDrawer" aria-label="القائمة الجانبية للجوال">
          <header class="phone-nav-header">
            <div class="phone-nav-brand-row">
              <div class="phone-nav-brand">
                <div class="phone-nav-logo">📦</div>
                <div>
                  <h3 class="phone-nav-title">ابن المختار</h3>
                  <p class="phone-nav-subtitle">تطبيقات الجوال السريعة</p>
                </div>
              </div>
              <button type="button" class="phone-nav-close-btn" onclick="PhoneNav.close()" aria-label="إغلاق القائمة">✕</button>
            </div>
            <div class="phone-nav-user-pill">
              <div class="phone-nav-user-name">
                <i class="fas fa-user-circle" style="font-size:0.9rem;"></i>
                <span>${user.name}</span>
              </div>
              <div class="phone-nav-user-role">${user.role}</div>
            </div>
          </header>
          <div class="phone-nav-body">
            ${sectionsHtml}
          </div>
          <footer class="phone-nav-footer">
            <button type="button" class="phone-nav-logout-btn" onclick="PhoneNav.logout()">
              <i class="fas fa-right-from-bracket"></i>
              <span>تسجيل الخروج من الجلسة</span>
            </button>
          </footer>
        </aside>
      `;
    },

    init() {
      this.injectStyles();
      
      // Inject drawer DOM if not already present
      if (!document.getElementById('phoneNavDrawer')) {
        const div = document.createElement('div');
        div.id = 'phoneNavContainer';
        div.innerHTML = this.buildDrawerHTML();
        document.body.appendChild(div);
      }

      // Add touch swipe-to-close gesture support
      this.bindGestures();

      // Ensure hamburger button exists in headers
      this.ensureHamburgerButton();
    },

    ensureHamburgerButton() {
      // Check if button already exists in page
      if (document.querySelector('.phone-nav-btn')) return;

      // Try finding main header
      const header = document.querySelector('.app-header, .topbar .topbar-row, .nav-header .nav-header-row, header');
      if (header) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'phone-nav-btn';
        btn.setAttribute('aria-label', 'القائمة الجانبية');
        btn.title = 'القائمة الجانبية';
        btn.innerHTML = '<i class="fas fa-bars"></i>';
        btn.onclick = () => PhoneNav.toggle();
        header.insertBefore(btn, header.firstChild);
      }
    },

    bindGestures() {
      let touchStartX = 0;
      let touchStartY = 0;

      document.addEventListener('touchstart', (e) => {
        if (!e.touches || e.touches.length === 0) return;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }, { passive: true });

      document.addEventListener('touchend', (e) => {
        if (!this.isOpen || !e.changedTouches || e.changedTouches.length === 0) return;
        const deltaX = e.changedTouches[0].clientX - touchStartX;
        const deltaY = e.changedTouches[0].clientY - touchStartY;
        // Swipe right (in RTL closes drawer)
        if (deltaX < -60 && Math.abs(deltaY) < 50) {
          this.close();
        }
      }, { passive: true });
    },

    open() {
      this.init();
      const overlay = document.getElementById('phoneNavOverlay');
      const drawer = document.getElementById('phoneNavDrawer');
      if (overlay) overlay.classList.add('open');
      if (drawer) drawer.classList.add('open');
      this.isOpen = true;
      document.body.style.overflow = 'hidden';
    },

    close() {
      const overlay = document.getElementById('phoneNavOverlay');
      const drawer = document.getElementById('phoneNavDrawer');
      if (overlay) overlay.classList.remove('open');
      if (drawer) drawer.classList.remove('open');
      this.isOpen = false;
      document.body.style.overflow = '';
    },

    toggle() {
      if (this.isOpen) this.close();
      else this.open();
    },

    navigate(url) {
      this.close();
      if (!url) return;
      if (window.location.pathname === url) return;
      window.location.href = url;
    },

    openSettings() {
      this.close();
      if (window.LoginHelper && typeof window.LoginHelper.openSettingsModal === 'function') {
        window.LoginHelper.openSettingsModal();
      } else {
        alert('إعدادات الخادم متاحة عبر زر الترس ⚙️ في الصفحة الرئيسية');
      }
    },

    logout() {
      this.close();
      if (confirm('هل أنت متأكد من رغبتك في تسجيل الخروج؟')) {
        localStorage.removeItem('pos_token');
        localStorage.removeItem('pos_user');
        window.location.href = '/phone/index.html';
      }
    }
  };

  // Expose globally
  window.PhoneNav = PhoneNav;

  // Auto-initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => PhoneNav.init());
  } else {
    PhoneNav.init();
  }
})();
