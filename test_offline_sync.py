from pathlib import Path

root = Path('/home/ubuntu/pos_project_mobile_accounting_audited')
worker = (root / 'worker.js').read_text(encoding='utf-8')
core = (root / 'offline-sw-core.js').read_text(encoding='utf-8')
client = (root / 'offline-sync.js').read_text(encoding='utf-8')
main_sw = (root / 'sw.js').read_text(encoding='utf-8')
phone_sw = (root / 'phone/sw_phone.js').read_text(encoding='utf-8')
driver_sw = (root / 'driver/sw_driver.js').read_text(encoding='utf-8')

pages = list(root.rglob('*.html'))
pages = [p for p in pages if 'node_modules' not in p.parts]
assert pages and all('src="/offline-sync.js"' in p.read_text(encoding='utf-8') for p in pages)
assert "indexedDB.open(OFFLINE_QUEUE_DB" in core
assert "createObjectStore(OFFLINE_REQUESTS" in core
assert "self.registration.sync.register(OFFLINE_SYNC_TAG)" in core
assert "event.tag === OFFLINE_SYNC_TAG" in core
assert "offlineQueueMutation(request)" in core
assert "offlineDeleteRequest(record.id)" in core
assert "OFFLINE_API_CACHE" in core
assert "OFFLINE_SET_TOKEN" in client and "OFFLINE_SYNC_NOW" in client
assert "navigator.serviceWorker.register(swUrl" in client
assert "setInterval(() => { if (navigator.onLine) syncNow(); }, 60 * 1000)" in client
assert "importScripts('/offline-sw-core.js')" in main_sw
assert "offlineHandleApiRequest(request)" in main_sw
assert "'/offline-sync.js'" in main_sw
assert "importScripts('/offline-sw-core.js')" in phone_sw
assert "offlineHandleApiRequest(request)" in phone_sw
assert "'/offline-sync.js'" in driver_sw
assert 'CREATE TABLE IF NOT EXISTS offline_idempotency' in worker
assert "X-Offline-Operation-Id" in worker
assert 'saveOfflineIdempotency(env, operationId, request, response)' in worker
assert 'offlineStoredResponse(stored)' in worker
print(f'PASS: offline-first and durable background sync contract for {len(pages)} HTML pages.')
