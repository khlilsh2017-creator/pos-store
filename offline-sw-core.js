/* طبقة العمل دون اتصال والمزامنة الدائمة لنظام ابن مختار */
const OFFLINE_QUEUE_DB = 'IbnMukhtarOfflineQueueDB';
const OFFLINE_QUEUE_VERSION = 1;
const OFFLINE_REQUESTS = 'requests';
const OFFLINE_META = 'meta';
const OFFLINE_API_CACHE = 'ibn-mukhtar-api-offline-v1';
const OFFLINE_SYNC_TAG = 'pos-offline-sync';
const OFFLINE_API_HOST = 'api.ibnalmukhtar.com';

function offlineIsApiRequest(url) {
  return url.hostname === OFFLINE_API_HOST || url.hostname.endsWith('.' + OFFLINE_API_HOST);
}

function offlineOpenDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_QUEUE_DB, OFFLINE_QUEUE_VERSION);
    request.onupgradeneeded = event => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(OFFLINE_REQUESTS)) {
        const store = db.createObjectStore(OFFLINE_REQUESTS, { keyPath: 'id' });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('created_at', 'created_at', { unique: false });
      }
      if (!db.objectStoreNames.contains(OFFLINE_META)) db.createObjectStore(OFFLINE_META, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function offlineTransaction(storeName, mode, operation) {
  return offlineOpenDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try { result = operation(store); } catch (error) { db.close(); reject(error); return; }
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('تم إلغاء عملية التخزين المحلي')); };
  }));
}

function offlineReadMeta(key) {
  return offlineOpenDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_META, 'readonly');
    const req = tx.objectStore(OFFLINE_META).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result?.value || null); };
    req.onerror = () => { db.close(); reject(req.error); };
  }));
}

function offlineWriteMeta(key, value) {
  return offlineTransaction(OFFLINE_META, 'readwrite', store => store.put({ key, value }));
}

function offlineGetRequests() {
  return offlineOpenDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_REQUESTS, 'readonly');
    const req = tx.objectStore(OFFLINE_REQUESTS).getAll();
    req.onsuccess = () => { db.close(); resolve((req.result || []).sort((a, b) => a.created_at.localeCompare(b.created_at))); };
    req.onerror = () => { db.close(); reject(req.error); };
  }));
}

function offlinePutRequest(record) {
  return offlineTransaction(OFFLINE_REQUESTS, 'readwrite', store => store.put(record));
}

function offlineDeleteRequest(id) {
  return offlineTransaction(OFFLINE_REQUESTS, 'readwrite', store => store.delete(id));
}

function offlineHash(value) {
  let hash = 2166136261;
  for (let i = 0; i < String(value || '').length; i++) hash = Math.imul(hash ^ String(value).charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

function offlineCacheRequest(request) {
  const auth = request.headers.get('Authorization') || '';
  const url = new URL(request.url);
  url.searchParams.set('__offline_user', offlineHash(auth));
  return new Request(url.toString(), { method: 'GET', headers: { 'X-Offline-Cache-Key': '1' } });
}

async function offlineNotify(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => client.postMessage(message));
}

async function offlineRequestRecord(request) {
  const clone = request.clone();
  const body = await clone.text();
  const headers = {};
  clone.headers.forEach((value, key) => { headers[key] = value; });
  const operationId = headers['x-offline-operation-id'] || `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  headers['x-offline-operation-id'] = operationId;
  return {
    id: operationId,
    url: request.url,
    method: request.method,
    headers,
    body,
    status: 'pending',
    attempts: 0,
    created_at: new Date().toISOString(),
    next_attempt_at: 0,
    last_error: null
  };
}

function offlineResponse(payload, status = 202) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Offline-Queued': '1' } });
}

async function offlineQueueMutation(request) {
  const record = await offlineRequestRecord(request);
  const all = await offlineGetRequests();
  const existing = all.find(item => item.id === record.id);
  if (!existing) await offlinePutRequest(record);
  await offlineRegisterSync();
  await offlineNotify({ type: 'OFFLINE_SYNC_STATUS', status: 'queued', pending: all.filter(item => item.status !== 'completed').length + (existing ? 0 : 1), operationId: record.id });
  return offlineResponse({ success: true, offlineQueued: true, operationId: record.id, message: 'تم حفظ العملية محليًا وستتم مزامنتها عند عودة الاتصال' });
}

async function offlineToken() {
  try { return await offlineReadMeta('token'); } catch (_) { return null; }
}

async function offlineBuildRequest(record) {
  const headers = new Headers(record.headers || {});
  const token = await offlineToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return new Request(record.url, { method: record.method, headers, body: record.method === 'GET' || record.method === 'HEAD' ? undefined : record.body });
}

async function offlineSyncQueueUnlocked() {
  const records = await offlineGetRequests();
  const pending = records.filter(record => record.status !== 'completed' && record.status !== 'blocked' && Number(record.next_attempt_at || 0) <= Date.now());
  await offlineNotify({ type: 'OFFLINE_SYNC_STATUS', status: pending.length ? 'syncing' : 'idle', pending: records.filter(record => record.status !== 'completed').length });
  let synced = 0, failed = 0;
  for (const record of pending) {
    try {
      const request = await offlineBuildRequest(record);
      const response = await fetch(request);
      if (response.ok) {
        await offlineDeleteRequest(record.id);
        synced++;
        continue;
      }
      const text = await response.clone().text().catch(() => '');
      const attempts = Number(record.attempts || 0) + 1;
      const permanent = response.status >= 400 && response.status < 500 && ![408, 409, 425, 429].includes(response.status);
      await offlinePutRequest({ ...record, status: permanent ? 'blocked' : 'pending', attempts, next_attempt_at: permanent ? 0 : Date.now() + Math.min(15 * 60 * 1000, 1000 * 2 ** Math.min(attempts, 8)), last_error: `HTTP ${response.status}${text ? `: ${text.slice(0, 240)}` : ''}` });
      failed++;
    } catch (error) {
      const attempts = Number(record.attempts || 0) + 1;
      await offlinePutRequest({ ...record, status: 'pending', attempts, next_attempt_at: Date.now() + Math.min(15 * 60 * 1000, 1000 * 2 ** Math.min(attempts, 8)), last_error: error.message || 'انقطاع الاتصال' });
      failed++;
    }
  }
  const remaining = (await offlineGetRequests()).filter(record => record.status !== 'completed').length;
  await offlineNotify({ type: 'OFFLINE_SYNC_STATUS', status: failed ? 'failed' : 'completed', pending: remaining, synced, failed });
  return { remaining, synced, failed };
}

let offlineSyncInFlight = null;
function offlineSyncQueue() {
  if (offlineSyncInFlight) return offlineSyncInFlight;
  offlineSyncInFlight = offlineSyncQueueUnlocked().finally(() => { offlineSyncInFlight = null; });
  return offlineSyncInFlight;
}

async function offlineRegisterSync() {
  try { if (self.registration.sync) await self.registration.sync.register(OFFLINE_SYNC_TAG); } catch (_) { /* بعض المتصفحات لا تدعم Background Sync */ }
}

async function offlineHandleApiRequest(request) {
  const url = new URL(request.url);
  if (url.pathname === '/auth/login' || url.pathname === '/auth/logout' || url.pathname === '/auth/me') {
    try { return await fetch(request.clone()); } catch (_) { return new Response(JSON.stringify({ error: 'لا يوجد اتصال بالمصادقة' }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }); }
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    const cache = await caches.open(OFFLINE_API_CACHE);
    try {
      const response = await fetch(request);
      if (response && (response.ok || response.type === 'opaque')) await cache.put(offlineCacheRequest(request), response.clone());
      return response;
    } catch (_) {
      const cached = await cache.match(offlineCacheRequest(request));
      return cached || new Response(JSON.stringify({ error: 'لا يوجد اتصال ولا توجد نسخة محفوظة من البيانات' }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
  }
  try {
    return await fetch(request.clone());
  } catch (_) {
    return offlineQueueMutation(request);
  }
}

self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'OFFLINE_SET_TOKEN') {
    event.waitUntil(offlineWriteMeta('token', data.token || '').then(() => offlineNotify({ type: 'OFFLINE_SYNC_STATUS', status: 'token_saved' })));
  }
  if (data.type === 'OFFLINE_SYNC_NOW') event.waitUntil(offlineSyncQueue().catch(error => offlineNotify({ type: 'OFFLINE_SYNC_STATUS', status: 'failed', error: error.message })));
  if (data.type === 'OFFLINE_RETRY_BLOCKED') event.waitUntil(offlineGetRequests().then(records => Promise.all(records.filter(record => record.status === 'blocked').map(record => offlinePutRequest({ ...record, status: 'pending', attempts: 0, next_attempt_at: 0, last_error: null })))).then(() => offlineSyncQueue()));
  if (data.type === 'OFFLINE_QUEUE_STATUS') event.waitUntil(offlineGetRequests().then(records => offlineNotify({ type: 'OFFLINE_SYNC_STATUS', status: 'idle', pending: records.filter(record => record.status !== 'completed').length, blocked: records.filter(record => record.status === 'blocked').length })));
});

self.addEventListener('sync', event => {
  if (event.tag === OFFLINE_SYNC_TAG) event.waitUntil(offlineSyncQueue().catch(error => offlineNotify({ type: 'OFFLINE_SYNC_STATUS', status: 'failed', error: error.message })));
});
