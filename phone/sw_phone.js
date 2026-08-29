importScripts('/offline-sw-core.js');
const PHONE_CACHE = 'pos-phone-shell-v6-offline-sync';
const PHONE_SHELL = [
  '/phone/index.html',
  '/phone/orders.html',
  '/phone/add_order_ph.html',
  '/phone/manifest.json',
  '/phone/sw_phone.js',
  '/offline-sw-core.js',
  '/offline-sync.js',
  '/date-utils.js',
  '/number-utils.js',
  '/document-utils.js',
  '/permissions.js',
  '/sidebar-config.js',
  '/icon-192x192.png',
  '/icon-512x512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(PHONE_CACHE)
      .then(cache => cache.addAll(PHONE_SHELL))  // تضمين جميع الملفات أو فشل التثبيت
      .then(() => self.skipWaiting())
      .catch(error => console.error('[PHONE SW] فشل تثبيت الملفات:', error))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith('pos-phone-shell-') && key !== PHONE_CACHE)
          .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  // معالجة طلبات API (من الدوال المستوردة)
  if (offlineIsApiRequest(url)) {
    event.respondWith(offlineHandleApiRequest(request));
    return;
  }

  // تجاهل الطلبات غير GET أو من أصول أخرى
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // تجاهل طلبات API و JSON (ما عدا JSON في /phone/)
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.endsWith('.json') && !url.pathname.startsWith('/phone/')) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true })
      .then(cached => {
        if (cached) return cached;

        // محاولة جلب من الشبكة وتخزين النسخة
        return fetch(request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(PHONE_CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        }).catch(() => {
          // إذا كان الطلب لصفحة HTML، نعيد الصفحة الرئيسية بدلاً من رسالة الخطأ
          if (url.pathname.endsWith('.html')) {
            return caches.match('/phone/index.html', { ignoreSearch: true });
          }
          return new Response('غير متاح دون اتصال', { 
            status: 503, 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
          });
        });
      })
  );
});