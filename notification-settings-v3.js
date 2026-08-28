/* أدوات إدارة واختبار إشعارات النظام من صفحة الإعدادات */
(function () {
  'use strict';

  const API_BASE = 'https://api.ibnalmukhtar.com';

  function authToken() {
    return localStorage.getItem('pos_token') || '';
  }

  function showMessage(message, type) {
    const output = document.getElementById('notificationTestOutput');
    if (!output) return;
    output.className = `notification-test-output ${type || 'info'}`;
    output.textContent = message;
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    button.disabled = busy;
    if (busy) {
      button.dataset.originalLabel = button.innerHTML;
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جارٍ التنفيذ...';
    } else if (button.dataset.originalLabel) {
      button.innerHTML = button.dataset.originalLabel;
    } else if (label) {
      button.innerHTML = label;
    }
  }

  async function loadNotificationStats() {
    const token = authToken();
    const status = document.getElementById('notificationTokensStatus');
    if (!token) {
      if (status) status.textContent = 'سجّل الدخول لعرض حالة التسجيل';
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/fcm-tokens`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const drivers = Array.isArray(data.driver_tokens) ? data.driver_tokens.length : 0;
      const admins = Array.isArray(data.admin_tokens) ? data.admin_tokens.length : 0;
      document.getElementById('notificationDriverTokens').textContent = drivers;
      document.getElementById('notificationAdminTokens').textContent = admins;
      if (status) status.textContent = `آخر تحديث: ${new Date().toLocaleTimeString('ar-YE')}`;
    } catch (error) {
      if (status) status.textContent = 'تعذر جلب إحصائيات التسجيل حاليًا';
    }
  }

  async function sendSettingsTestNotification() {
    const button = document.getElementById('sendSettingsNotification');
    const token = authToken();
    const type = document.getElementById('settingsNotificationType')?.value || 'admin';
    const title = document.getElementById('settingsNotificationTitle')?.value.trim() || 'إشعار تجريبي من النظام';
    const body = document.getElementById('settingsNotificationBody')?.value.trim() || 'هذا إشعار اختبار من إعدادات النظام';
    const link = document.getElementById('settingsNotificationLink')?.value.trim() || `${location.origin}/settings.html`;
    if (!token) {
      showMessage('لا توجد جلسة دخول صالحة. سجّل الدخول أولًا ثم أعد المحاولة.', 'error');
      return;
    }
    setBusy(button, true);
    try {
      const endpoint = type === 'driver' ? '/test-notification' : '/test-admin-notification';
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title, body, link }),
      });
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch (_) { data = raw; }
      if (!response.ok) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
      showMessage(`تم إرسال الإشعار بنجاح إلى ${type === 'driver' ? 'المندوبين' : 'المشرفين'}.`, 'success');
      loadNotificationStats();
    } catch (error) {
      showMessage(`تعذر إرسال الإشعار: ${error.message}`, 'error');
    } finally {
      setBusy(button, false);
    }
  }

  function init() {
    if (!document.getElementById('notificationSettingsCard')) return;
    document.getElementById('sendSettingsNotification')?.addEventListener('click', sendSettingsTestNotification);
    document.getElementById('refreshNotificationStats')?.addEventListener('click', loadNotificationStats);
    const enabled = localStorage.getItem('pos_notifications_enabled') !== 'false';
    const toggle = document.getElementById('settingsNotificationsEnabled');
    if (toggle) {
      toggle.checked = enabled;
      toggle.addEventListener('change', () => localStorage.setItem('pos_notifications_enabled', String(toggle.checked)));
    }
    loadNotificationStats();
  }

  window.loadNotificationStats = loadNotificationStats;
  window.sendSettingsTestNotification = sendSettingsTestNotification;
  document.addEventListener('DOMContentLoaded', init);
})();
