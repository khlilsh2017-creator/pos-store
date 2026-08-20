// ============================================================
// 🏢 Service Worker – ابن مختار (المندوب) v2026.08.18-007
// يجمع بين ميزات المندوب (المزامنة، العمليات) وتحسينات النظام العام
// ============================================================

const VERSION = 'driver-2026-08-22-016';
const CACHE_PREFIX = 'ibn-mukhtar-driver-';
const CACHE_NAME = `${CACHE_PREFIX}pos-${VERSION}`;
const STATIC_CACHE = `${CACHE_PREFIX}static-${VERSION}`;
const DYNAMIC_CACHE = `${CACHE_PREFIX}dynamic-${VERSION}`;
const DB_VERSION = 10;
const API_BASE = 'https://api.ibnalmukhtar.com';
const OPERATIONS_DB = 'DriverOrdersDB';
const OPERATIONS_STORE = 'operations';
const SYNC_META_DB = 'DriverSyncMetaDB';
const SYNC_META_STORE = 'auth';
const SYNC_TAG = 'driver-orders-pending-v1';

// --------------------------------------------
//  قائمة الأصول الثابتة (خاصة بالمندوب)
// --------------------------------------------
const STATIC_ASSETS = [
  
  '/driver/index.html',
  '/driver/',
  '/driver/manifest_pos.json',
  '/driver/icon-192x192.png',
  '/driver/icon-512x512.png',
  '/driver/db.js',
  
  // يمكن إضافة ملفات أخرى خاصة بالمندوب هنا
];

// --------------------------------------------
//  صفحة Offline محسّنة (من الكود العام)
// --------------------------------------------
const OFFLINE_PAGE = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>غير متصل - ابن مختار</title>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body {
            font-family: 'Cairo', sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
        }
        .offline-container {
            background: rgba(255,255,255,0.15);
            backdrop-filter: blur(10px);
            padding: 50px;
            border-radius: 30px;
            max-width: 500px;
            width: 100%;
            text-align: center;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        .offline-icon { font-size: 80px; margin-bottom: 20px; display: block; }
        .offline-title { font-size: 32px; font-weight: 800; margin-bottom: 10px; }
        .offline-subtitle { font-size: 18px; opacity: 0.9; margin-bottom: 10px; line-height: 1.6; }
        .offline-version { font-size: 14px; opacity: 0.6; margin-bottom: 30px; }
        .offline-actions { display: flex; gap: 15px; justify-content: center; flex-wrap: wrap; }
        .offline-btn {
            background: white;
            border: none;
            padding: 12px 30px;
            border-radius: 50px;
            font-size: 16px;
            font-weight: 700;
            color: #764ba2;
            cursor: pointer;
            transition: all 0.3s ease;
            font-family: 'Cairo', sans-serif;
        }
        .offline-btn:hover { transform: scale(1.05); box-shadow: 0 5px 20px rgba(0,0,0,0.2); }
        .offline-btn-secondary {
            background: rgba(255,255,255,0.2);
            color: white;
            border: 2px solid white;
        }
        .offline-btn-secondary:hover { background: white; color: #764ba2; }
        @media (max-width: 480px) {
            .offline-container { padding: 30px; }
            .offline-title { font-size: 24px; }
            .offline-icon { font-size: 60px; }
        }
    </style>
</head>
<body>
    <div class="offline-container">
        <span class="offline-icon">📡</span>
        <h1 class="offline-title">⚠️ غير متصل</h1>
        <p class="offline-subtitle">
            يرجى التحقق من اتصالك بالإنترنت<br>
            أو استخدم الإصدار المخزن في جهازك
        </p>
        <p class="offline-version">🔄 آخر تحديث للصفحة: ${new Date().toLocaleString('ar-EG')}</p>
        <div class="offline-actions">
            <button class="offline-btn" onclick="location.reload()">🔄 إعادة المحاولة</button>
            <button class="offline-btn offline-btn-secondary" onclick="window.location.href='/'">🏠 الصفحة الرئيسية</button>
        </div>
    </div>
</body>
</html>`;

// ============================================================
//  1️⃣ التثبيت – حذف الكاش القديم وتخزين الأصول الجديدة
// ============================================================
self.addEventListener('install', event => {
  console.log('[SW] 📦 تثبيت الإصدار:', VERSION);
  event.waitUntil(
    caches.keys()
      .then(keys => {
        return Promise.all(
          keys.map(key => {
            if (key.startsWith(CACHE_PREFIX) && key !== STATIC_CACHE && key !== DYNAMIC_CACHE) {
              console.log('[SW] 🗑️ حذف الكاش القديم:', key);
              return caches.delete(key);
            }
          })
        );
      })
      .then(() => caches.open(STATIC_CACHE))
      .then(cache => {
        console.log('[SW] 📦 تخزين الملفات الثابتة');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] ⚠️ فشل التخزين:', err))
  );
});

// ============================================================
//  2️⃣ التفعيل – السيطرة على الصفحات فوراً وإرسال رسالة إعادة تحميل
// ============================================================
self.addEventListener('activate', event => {
  console.log('[SW] 🚀 تفعيل الإصدار:', VERSION);
  event.waitUntil(
    caches.keys()
      .then(keys => {
        return Promise.all(
          keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== STATIC_CACHE && key !== DYNAMIC_CACHE)
              .map(key => {
                console.log('[SW] 🗑️ حذف الكاش القديم:', key);
                return caches.delete(key);
              })
        );
      })
      .then(() => self.clients.claim())
      .then(() => {
        // إعلام الصفحات المفتوحة بوجود تحديث
        self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => {
            client.postMessage({ action: 'reload', version: VERSION });
          });
        });
      })
  );
});

// ============================================================
//  3️⃣ استراتيجية الجلب (Fetch) – مدمجة من الكود العام مع تحسينات
// ============================================================
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // تجاهل طلبات API والمكتبات الخارجية والتحليلات
  if (url.pathname.includes('/api/') ||
      url.pathname.includes('analytics') ||
      url.pathname.includes('google-analytics') ||
      url.pathname.includes('doubleclick.net') ||
      url.origin !== self.location.origin && 
      !url.pathname.includes('fonts.googleapis.com') &&
      !url.pathname.includes('cdnjs.cloudflare.com') &&
      !url.pathname.includes('cdn.jsdelivr.net')) {
    return;
  }

  // تحديد ما إذا كان الطلب لصفحة HTML
  const isHtmlPage = request.headers.get('Accept')?.includes('text/html') ||
                     url.pathname.endsWith('.html') ||
                     request.mode === 'navigate';

  const isStaticAsset = STATIC_ASSETS.some(asset => url.pathname === asset || url.pathname + '/' === asset);
  const isExternalLib = url.origin !== self.location.origin &&
                        (url.pathname.includes('fonts.googleapis.com') ||
                         url.pathname.includes('cdnjs.cloudflare.com') ||
                         url.pathname.includes('cdn.jsdelivr.net'));

  // ----- استراتيجية صفحات HTML (Network First مع Fallback ذكي) -----
  if (isHtmlPage) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(DYNAMIC_CACHE)
              .then(cache => cache.put(request, clone))
              .catch(() => {});
          }
          return response;
        })
        .catch(() => {
          return caches.match(request, { ignoreSearch: true })
            .then(cached => {
              if (cached) return cached;
              // محاولة ذكية: إذا طلب صفحة بصيغة html ولم يجدها، يجرب بدونها والعكس
              const fallbackUrl = url.pathname.endsWith('.html')
                ? url.pathname.replace('.html', '')
                : url.pathname + '.html';
              return caches.match(fallbackUrl, { ignoreSearch: true });
            })
            .then(finalCached => finalCached || new Response(OFFLINE_PAGE, {
              status: 503,
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            }));
        })
    );
    return;
  }

  // ----- الموارد الثابتة والمكتبات (Cache First مع تحديث خلفي) -----
  if (isStaticAsset || isExternalLib) {
    event.respondWith(
      caches.match(request, { ignoreSearch: true })
        .then(cached => {
          if (cached) {
            // تحديث الخلفية
            fetch(request).then(response => {
              if (response && response.status === 200) {
                caches.open(STATIC_CACHE).then(cache => cache.put(request, response));
              }
            }).catch(() => {});
            return cached;
          }
          return fetch(request)
            .then(response => {
              if (response && response.status === 200) {
                const clone = response.clone();
                caches.open(STATIC_CACHE).then(cache => cache.put(request, clone));
              }
              return response;
            });
        })
    );
    return;
  }

  // ----- الطلبات الأخرى (صور، ملفات غير مدرجة) -----
  event.respondWith(
    caches.match(request, { ignoreSearch: true })
      .then(cached => {
        if (cached) return cached;
        return fetch(request)
          .then(response => {
            if (response && response.status === 200 && request.method === 'GET') {
              const clone = response.clone();
              caches.open(DYNAMIC_CACHE).then(cache => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => new Response('', { status: 404, statusText: 'Not Found' }));
      })
  );
});

// ============================================================
//  4️⃣ وظائف IndexedDB (خاصة بالمندوب)
// ============================================================

function openOperationsDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OPERATIONS_DB, DB_VERSION);
    request.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(OPERATIONS_STORE)) {
        db.createObjectStore(OPERATIONS_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB blocked, close other tabs'));
  });
}

function openMetaDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SYNC_META_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SYNC_META_STORE)) {
        request.result.createObjectStore(SYNC_META_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveToken(token) {
  const db = await openMetaDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SYNC_META_STORE, 'readwrite');
    tx.objectStore(SYNC_META_STORE).put({ key: 'token', value: token });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function readToken() {
  const db = await openMetaDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(SYNC_META_STORE).objectStore(SYNC_META_STORE).get('token');
    req.onsuccess = () => { db.close(); resolve(req.result?.value || null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function getPending() {
  const db = await openOperationsDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OPERATIONS_STORE, 'readonly');
    const req = tx.objectStore(OPERATIONS_STORE).getAll();
    req.onsuccess = () => { db.close(); resolve((req.result || []).filter(op => !op.synced)); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function markSynced(id) {
  const db = await openOperationsDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OPERATIONS_STORE, 'readwrite');
    const store = tx.objectStore(OPERATIONS_STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      if (req.result) {
        req.result.synced = true;
        req.result.synced_at = new Date().toISOString();
        store.put(req.result);
      }
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function notifyClients(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => client.postMessage(message));
}

// ============================================================
//  5️⃣ المزامنة الخلفية (خاصة بالمندوب)
// ============================================================

async function sendOperation(op, token) {
  const payload = {
    ...(op.data || {}),
    operation_id: op.data?.operation_id || op.operation_id,
    _local_id: op.id
  };
  const response = await fetch(`${API_BASE}/driver/update-delivery`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (response.ok) return true;
  if (response.status >= 400 && response.status < 500) return false;
  throw new Error(`HTTP ${response.status}`);
}

async function syncPending() {
  const token = await readToken();
  if (!token) {
    console.warn('[SW] لا يوجد رمز دخول للمزامنة');
    await notifyClients({ type: 'SYNC_STATUS', status: 'no_token', pending: 0 });
    throw new Error('لا يوجد رمز دخول للمزامنة الخلفية');
  }

  const operations = await getPending();
  if (!operations.length) {
    await notifyClients({ type: 'SYNC_STATUS', status: 'idle', pending: 0 });
    return;
  }

  console.log(`[SW] مزامنة ${operations.length} عملية معلقة`);
  await notifyClients({ type: 'SYNC_STATUS', status: 'syncing', pending: operations.length });

  let failed = 0;
  const maxRetries = 3;
  let delay = 1000;

  for (const op of operations) {
    let done = false;
    for (let attempt = 1; attempt <= maxRetries && !done; attempt++) {
      try {
        done = await sendOperation(op, token);
        if (!done) break;
      } catch (error) {
        console.warn(`[SW] محاولة ${attempt} للعملية ${op.id} فشلت:`, error);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
        }
      }
    }
    if (done) {
      await markSynced(op.id);
    } else {
      failed++;
    }
  }

  const pending = (await getPending()).length;
  const synced = operations.length - failed;
  await notifyClients({
    type: 'SYNC_STATUS',
    status: failed ? 'failed' : 'completed',
    pending,
    synced,
    failed
  });

  if (failed) {
    throw new Error(`${failed} عملية لا تزال معلقة`);
  }
}

self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    console.log('[SW] تشغيل المزامنة الخلفية');
    event.waitUntil(syncPending().catch(err => console.error('[SW] خطأ في المزامنة:', err)));
  }
});

// ============================================================
//  6️⃣ التعامل مع الرسائل من الصفحة
// ============================================================
self.addEventListener('message', event => {
  const data = event.data || {};

  if (data.type === 'DRIVER_SET_SYNC_TOKEN' && data.token) {
    event.waitUntil(saveToken(data.token).then(() => console.log('[SW] تم حفظ الرمز')));
  }

  if (data.type === 'DRIVER_REGISTER_BACKGROUND_SYNC') {
    event.waitUntil(syncPending().catch(err => console.error('[SW] فشلت المزامنة عند الطلب:', err)));
  }

  if (data.type === 'GET_PENDING_COUNT') {
    getPending().then(ops => {
      if (event.ports && event.ports[0]) {
        event.ports[0].postMessage({ pending: ops.length });
      }
    }).catch(() => {});
  }

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  // دعم إعادة التحميل من الكود العام
  if (data === 'skipWaiting') {
    self.skipWaiting();
  }
  if (data.action === 'reload') {
    event.source?.postMessage({ action: 'reload' });
  }
});

// ============================================================
//  7️⃣ إشعارات الدفع (Push) – النسخة المحسّنة من الكود العام
// ============================================================
self.addEventListener('push', event => {
  console.log('[SW] 📩 استقبال push');

  if (!event.data) {
    console.warn('[SW] لا توجد بيانات في الإشعار');
    return;
  }

  // القيم الافتراضية
  let notificationData = {
    title: '📦 ابن مختار – المندوب',
    body: 'لديك إشعار جديد',
    link: '/driver/',
    icon: '/driver/icon-192x192.png',
    badge: '/driver/icon-192x192.png',
    vibrate: [200, 100, 200],
    tag: 'default',
    requireInteraction: true,
    data: { link: '/driver/' }
  };
  let orderId = null;

  try {
    const payload = event.data.json();
    console.log('[SW] بيانات الإشعار:', payload);

    // استخراج البيانات من الحقول المختلفة
    if (payload.notification) {
      notificationData.title = payload.notification.title || notificationData.title;
      notificationData.body = payload.notification.body || notificationData.body;
      if (payload.notification.icon) notificationData.icon = payload.notification.icon;
      if (payload.notification.badge) notificationData.badge = payload.notification.badge;
    }

    if (payload.data) {
      if (payload.data.title) notificationData.title = payload.data.title;
      if (payload.data.body) notificationData.body = payload.data.body;
      if (payload.data.link) notificationData.link = payload.data.link;
      if (payload.data.order_id) {
        orderId = payload.data.order_id;
        notificationData.data.order_id = orderId;
      }
      // تخزين جميع البيانات المخصصة
      notificationData.data.notification_data = payload.data;
    }

    // قراءة مباشرة من الجذر
    if (payload.title) notificationData.title = payload.title;
    if (payload.body) notificationData.body = payload.body;
    if (payload.link) notificationData.link = payload.link;
    if (payload.click_action) notificationData.link = payload.click_action;
    if (payload.fcmOptions?.link) notificationData.link = payload.fcmOptions.link;

    // استخراج order_id من أي مكان
    if (!orderId) {
      if (payload.order_id) orderId = payload.order_id;
      else if (payload.data?.order_id) orderId = payload.data.order_id;
    }

    if (orderId) {
      notificationData.data.order_id = orderId;
      // تحديث الرابط ليشمل order_id
      if (!notificationData.link.includes('order_id=')) {
        notificationData.link += (notificationData.link.includes('?') ? '&' : '?') + 'order_id=' + orderId;
      }
    }

    if (!notificationData.body || notificationData.body.trim() === '') {
      console.log('[SW] تم إلغاء الإشعار لعدم وجود نص');
      return;
    }

  } catch (error) {
    console.warn('[SW] فشل تحليل JSON، استخدام النص كـ body:', error);
    const text = event.data.text();
    if (text) notificationData.body = text;
  }

  const options = {
    body: notificationData.body,
    icon: notificationData.icon,
    badge: notificationData.badge,
    vibrate: notificationData.vibrate,
    data: notificationData.data,
    tag: notificationData.tag,
    requireInteraction: notificationData.requireInteraction,
    actions: [
      { action: 'open', title: '📂 فتح التطبيق' },
      { action: 'close', title: '❌ إغلاق' },
      { action: 'done', title: '✅ تم التوصيل' } // إجراء خاص بالمندوب
    ]
  };

  event.waitUntil(
    self.registration.showNotification(notificationData.title, options)
      .then(() => {
        console.log('[SW] ✅ تم عرض الإشعار');
        return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      })
      .then(clients => {
        clients.forEach(client => {
          client.postMessage({
            type: 'NEW_NOTIFICATION',
            payload: {
              title: notificationData.title,
              body: notificationData.body,
              order_id: notificationData.data.order_id || null,
              link: notificationData.link
            }
          });
        });
      })
      .catch(err => console.error('[SW] ❌ فشل عرض الإشعار:', err))
  );
});

// ============================================================
//  8️⃣ التعامل مع نقر الإشعار – محسّن مع دعم الإجراءات
// ============================================================
self.addEventListener('notificationclick', event => {
  console.log('[SW] 🖱️ نقر على الإشعار');
  const notification = event.notification;
  notification.close();

  let link = '/driver/';
  let orderId = null;

  if (notification.data) {
    link = notification.data.link || link;
    orderId = notification.data.order_id || null;
  }

  if (orderId && !link.includes('order_id=')) {
    link += (link.includes('?') ? '&' : '?') + 'order_id=' + orderId;
  }

  // معالجة الإجراءات
  if (event.action === 'done' && orderId) {
    // إرسال رسالة للصفحات المفتوحة لتحديث حالة الطلب
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        clients.forEach(client => {
          client.postMessage({
            type: 'MARK_ORDER_DONE',
            order_id: orderId
          });
        });
      });
    // فتح التطبيق مع إشارة الإجراء
    event.waitUntil(
      clients.openWindow(link + (link.includes('?') ? '&' : '?') + 'action=done')
    );
    return;
  }

  // الإجراء الافتراضي (open) أو بدون إجراء
  if (event.action === 'open' || !event.action) {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(clientList => {
          // البحث عن نافذة مفتوحة بنفس الرابط
          for (const client of clientList) {
            if (client.url === link && 'focus' in client) {
              if (orderId) {
                client.postMessage({
                  type: 'OPEN_ORDER',
                  order_id: orderId
                });
              }
              return client.focus();
            }
          }
          // فتح نافذة جديدة
          return clients.openWindow(link)
            .then(newClient => {
              if (newClient && orderId) {
                newClient.postMessage({
                  type: 'OPEN_ORDER',
                  order_id: orderId
                });
              }
              return newClient;
            });
        })
        .catch(() => clients.openWindow(link))
    );
  }
});

// ============================================================
//  9️⃣ تسجيل الإصدار للتشخيص
// ============================================================
console.log(`[SW] النسخة النشطة: ${VERSION}`);