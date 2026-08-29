from pathlib import Path
import re

root = Path(__file__).parent
worker = (root / 'worker.js').read_text(encoding='utf-8')
core = (root / 'offline-sw-core.js').read_text(encoding='utf-8')
sync = (root / 'offline-sync.js').read_text(encoding='utf-8')
main_sw = (root / 'sw.js').read_text(encoding='utf-8')
phone_sw = (root / 'phone/sw_phone.js').read_text(encoding='utf-8')
driver_sw = (root / 'driver/sw_driver.js').read_text(encoding='utf-8')
doc = (root / 'document-utils.js').read_text(encoding='utf-8')
index = (root / 'index.html').read_text(encoding='utf-8')
notification_test = (root / 'notification-test.html').read_text(encoding='utf-8')

pages = [p for p in root.rglob('*.html') if 'node_modules' not in p.parts]
assert len(pages) == 28
assert all('offline-sync.js' in p.read_text(encoding='utf-8', errors='ignore') for p in pages)
assert "let offlineSyncInFlight = null" in core and "function offlineSyncQueue()" in core
assert "let syncInFlight = null" in sync and "function syncNow()" in sync
assert "X-Offline-Operation-Id" in sync and "offline_idempotency" in worker
assert "importScripts('/offline-sw-core.js')" in phone_sw
assert "let driverSyncInFlight = null" in driver_sw and "X-Offline-Operation-Id" in driver_sw
assert 'onclick=\"window.print()\"' in doc and "window.onload=function(){window.focus()}" in doc
assert "setTimeout(function(){window.print()" not in doc
assert "pdf.autoPrint()" not in (root / 'phone/add_order_ph.html').read_text(encoding='utf-8')
assert "Notification.requestPermission()" in index
assert "!userInitiated" in index and "pos_admin_fcm_token:" in index
assert "pos_token" in notification_test and "setInterval(loadTokensStats" not in notification_test
assert "if (document.hidden || !navigator.onLine) return;" in (root / 'orders.html').read_text(encoding='utf-8')
print('PASS final offline, idempotency, session, notifications, database-polling, and non-blocking print contract')
