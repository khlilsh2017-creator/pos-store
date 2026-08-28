/* مركز إشعارات النظام في الهيدر */
(function () {
  'use strict';

  const MAX_NOTIFICATIONS = 60;
  const STORAGE_PREFIX = 'pos_system_notifications:';
  let notifications = [];
  let storageKey = '';

  function currentScope() {
    try {
      const user = JSON.parse(localStorage.getItem('pos_user') || '{}');
      return String(user.id || user.username || user.name || 'current');
    } catch (_) {
      return 'current';
    }
  }

  function getStorageKey() {
    return `${STORAGE_PREFIX}${currentScope()}`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[char]);
  }

  function safeLink(link) {
    const value = String(link || '').trim();
    if (!value || value === '#') return '';
    if (/^(https?:|\/|\.\/|\.\.\/)/i.test(value)) return value;
    return '';
  }

  function normalize(item) {
    const raw = item || {};
    return {
      id: String(raw.id || `notification-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      title: String(raw.title || 'إشعار جديد').slice(0, 160),
      body: String(raw.body || raw.message || 'لديك تحديث جديد في النظام').slice(0, 500),
      link: safeLink(raw.link || raw.url),
      type: String(raw.type || 'system').slice(0, 40),
      createdAt: raw.createdAt || raw.created_at || new Date().toISOString(),
      read: Boolean(raw.read),
    };
  }

  function load() {
    storageKey = getStorageKey();
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
      notifications = Array.isArray(saved) ? saved.map(normalize).slice(0, MAX_NOTIFICATIONS) : [];
    } catch (_) {
      notifications = [];
    }
  }

  function save() {
    try { localStorage.setItem(storageKey || getStorageKey(), JSON.stringify(notifications)); } catch (_) {}
  }

  function unreadCount() {
    return notifications.filter((item) => !item.read).length;
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const diff = Math.max(0, Date.now() - date.getTime());
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return 'الآن';
    if (diff < hour) return `منذ ${Math.floor(diff / minute)} د`;
    if (diff < day) return `منذ ${Math.floor(diff / hour)} س`;
    if (diff < 7 * day) return `منذ ${Math.floor(diff / day)} يوم`;
    return date.toLocaleDateString('ar-YE', { day: 'numeric', month: 'short' });
  }

  function iconFor(type) {
    if (/طلب|order/i.test(type)) return 'fa-cart-arrow-down';
    if (/مخزون|stock|product/i.test(type)) return 'fa-boxes-stacked';
    if (/مال|فاتورة|payment|invoice/i.test(type)) return 'fa-file-invoice-dollar';
    if (/تنبيه|warning|error/i.test(type)) return 'fa-triangle-exclamation';
    return 'fa-bell';
  }

  function render() {
    const list = document.getElementById('notificationList');
    const badge = document.getElementById('notificationBadge');
    const countLabel = document.getElementById('notificationCountLabel');
    const markAllButton = document.getElementById('markAllNotificationsRead');
    if (!list || !badge) return;

    const count = unreadCount();
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('visible', count > 0);
    badge.setAttribute('aria-label', `${count} إشعار غير مقروء`);
    if (countLabel) countLabel.textContent = count ? `${count} غير مقروء` : 'كل الإشعارات مقروءة';
    if (markAllButton) markAllButton.disabled = count === 0;

    if (!notifications.length) {
      list.innerHTML = '<div class="notification-empty"><i class="fas fa-bell-slash"></i><strong>لا توجد إشعارات</strong><span>ستظهر هنا تنبيهات النظام والطلبات الجديدة.</span></div>';
      return;
    }

    list.innerHTML = notifications.map((item) => {
      const content = `<span class="notification-item-icon"><i class="fas ${iconFor(item.type)}"></i></span><span class="notification-item-content"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.body)}</span><small>${escapeHtml(formatDate(item.createdAt))}</small></span>${item.read ? '' : '<span class="notification-unread-dot"></span>'}`;
      return item.link
        ? `<a class="notification-item ${item.read ? 'read' : 'unread'}" href="${escapeHtml(item.link)}" data-notification-id="${escapeHtml(item.id)}">${content}</a>`
        : `<button type="button" class="notification-item ${item.read ? 'read' : 'unread'}" data-notification-id="${escapeHtml(item.id)}">${content}</button>`;
    }).join('');

    list.querySelectorAll('[data-notification-id]').forEach((element) => {
      element.addEventListener('click', () => markRead(element.dataset.notificationId));
    });
  }

  function add(item) {
    if (localStorage.getItem('pos_notifications_enabled') === 'false') return null;
    const incoming = normalize(item);
    notifications = [incoming, ...notifications.filter((entry) => entry.id !== incoming.id)].slice(0, MAX_NOTIFICATIONS);
    save();
    render();
    return incoming;
  }

  function markRead(id) {
    const item = notifications.find((entry) => entry.id === String(id));
    if (!item || item.read) return;
    item.read = true;
    save();
    render();
  }

  function markAllRead() {
    notifications = notifications.map((item) => ({ ...item, read: true }));
    save();
    render();
  }

  function clearAll() {
    notifications = [];
    save();
    render();
  }

  function bindPanel() {
    const button = document.getElementById('notificationButton');
    const panel = document.getElementById('notificationPanel');
    const markAll = document.getElementById('markAllNotificationsRead');
    const clear = document.getElementById('clearAllNotifications');
    if (!button || !panel || button.dataset.bound === 'true') return;

    button.dataset.bound = 'true';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      panel.classList.toggle('visible');
      button.setAttribute('aria-expanded', String(panel.classList.contains('visible')));
      if (panel.classList.contains('visible')) render();
    });
    panel.addEventListener('click', (event) => event.stopPropagation());
    document.addEventListener('click', () => {
      panel.classList.remove('visible');
      button.setAttribute('aria-expanded', 'false');
    });
    markAll?.addEventListener('click', markAllRead);
    clear?.addEventListener('click', clearAll);
  }

  function bindServiceWorkerMessages() {
    if (!navigator.serviceWorker) return;
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type !== 'NEW_NOTIFICATION') return;
      const payload = event.data.payload || {};
      add({ ...payload, type: payload.type || 'system' });
    });
  }

  function init() {
    load();
    bindPanel();
    bindServiceWorkerMessages();
    render();
    window.addEventListener('storage', (event) => {
      if (event.key === storageKey) { load(); render(); }
    });
  }

  window.POSNotificationCenter = {
    add,
    getAll: () => notifications.slice(),
    getUnreadCount: unreadCount,
    markRead,
    markAllRead,
    clearAll,
    refresh: () => { load(); render(); },
  };

  document.addEventListener('DOMContentLoaded', init);
})();
