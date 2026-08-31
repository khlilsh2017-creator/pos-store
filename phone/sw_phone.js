importScripts('/offline-sw-core.js');

// غيّر اسم الكاش لفرض تحديثه
const PHONE_CACHE = 'pos-phone-shell-v9-fixed-redirect';

// قائمة الملفات الأساسية (تأكد من صحة المسارات)
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
  '/icon-512x512.png',
  // أضف المكتبات المستخدمة في الجوال إن وجدت
  '/html2canvas.min.js',
  '/html2pdf.bundle.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(PHONE_CACHE)
      .then(cache => cache.addAll(PHONE_SHELL))
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
  if (typeof offlineIsApiRequest === 'function' && offlineIsApiRequest(url)) {
    event.respondWith(offlineHandleApiRequest(request));
    return;
  }

  // تجاهل الطلبات غير GET أو من أصول أخرى
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // تجاهل طلبات API و JSON
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.endsWith('.json') && !url.pathname.startsWith('/phone/')) return;

  // ========================================
  // معالجة صفحات HTML (المشكلة الرئيسية)
  // ========================================
  if (url.pathname.endsWith('.html')) {
    event.respondWith(
      // استراتيجية الشبكة أولاً مع متابعة إعادة التوجيه إجبارياً
      fetch(request, { redirect: 'follow' })
        .then(response => {
          // نخزن فقط الاستجابات الناجحة (كود 200) لتجنب تخزين إعادة التوجيه
          if (response.status === 200) {
            const clone = response.clone();
            caches.open(PHONE_CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // عند فشل الشبكة، نبحث في الكاش
          return caches.match(request, { ignoreSearch: true })
            .then(cached => {
              if (cached) return cached;
              // إذا لم تكن الصفحة في الكاش، نعيد صفحة الخطأ أو index.html
              return caches.match('/phone/index.html', { ignoreSearch: true });
            });
        })
    );
    return;
  }

  // ========================================
  // باقي الموارد (صور، ملفات JS، CSS)
  // ========================================
  event.respondWith(
    caches.match(request, { ignoreSearch: true })
      .then(cached => {
        if (cached) return cached;
        return fetch(request, { redirect: 'follow' })
          .then(response => {
            if (response.status === 200) {
              const clone = response.clone();
              caches.open(PHONE_CACHE).then(cache => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => {
            return new Response('غير متاح', {
              status: 503,
              headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
          });
      })
  );
});