try {
  importScripts('../offline-sw-core.js');
} catch (_) {
  try {
    importScripts('/offline-sw-core.js');
  } catch (__) {
    try {
      importScripts('offline-sw-core.js');
    } catch (___) {}
  }
}

const CACHE_NAME = 'pos-phone-shell-v16-failover-auth';

// قائمة الملفات الثابتة لضمان العمل بدون اتصال (تشمل صفحات الجوال)
const STATIC_FILES = [
  '/phone/orders.html',
  '/phone/add_order_ph.html',
  '/phone/index.html',
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
  '/html2canvas.min.js',
  '/html2pdf.bundle.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return Promise.all(
          STATIC_FILES.map(url => cache.add(url).catch(err => console.warn('[SW phone] تعذر تخزين مسبق:', url, err)))
        );
      })
      .then(() => self.skipWaiting())
      .catch(err => console.error('[SW phone] تثبيت فاشل:', err))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.startsWith('pos-phone-shell-') && k !== CACHE_NAME)
          .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  // 1. معالجة طلبات API للمزامنة والعمل بدون اتصال
  if (typeof offlineIsApiRequest === 'function' && offlineIsApiRequest(url)) {
    event.respondWith(offlineHandleApiRequest(request));
    return;
  }

  // 2. طلبات صفحات HTML (استراتيجية Network-First مع الرجوع للكاش فور انقطاع النت)
  const isHtmlPage = url.pathname.endsWith('.html') || 
                     request.mode === 'navigate' || 
                     request.headers.get('Accept')?.includes('text/html');

  if (isHtmlPage && request.method === 'GET') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone)).catch(() => {});
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request, { ignoreSearch: true });
          if (cached) return cached;
          const directMatch = await caches.match(url.pathname, { ignoreSearch: true });
          if (directMatch) return directMatch;
          return (await caches.match('/phone/orders.html', { ignoreSearch: true })) || 
                 (await caches.match('/phone/index.html', { ignoreSearch: true })) ||
                 new Response('<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>غير متصل</title><style>body{font-family:sans-serif;text-align:center;padding:50px;direction:rtl}</style></head><body><h2>⚠️ أنت في وضع عدم الاتصال</h2><p>يرجى فتح صفحة الطلبات من الشاشة الرئيسية أو عند توفر الاتصال.</p></body></html>', {
                   status: 503,
                   headers: { 'Content-Type': 'text/html; charset=utf-8' }
                 });
        })
    );
    return;
  }

  // 3. الموارد والخطوط الخارجية (Google Fonts و FontAwesome)
  const isExternalAsset = (url.hostname.includes('fonts.googleapis.com') ||
                           url.hostname.includes('fonts.gstatic.com') ||
                           url.hostname.includes('cdnjs.cloudflare.com'));
  if (isExternalAsset && request.method === 'GET') {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response && (response.status === 200 || response.type === 'opaque')) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone)).catch(() => {});
          }
          return response;
        }).catch(() => new Response('', { status: 408 }));
      })
    );
    return;
  }

  // تجاهل الطلبات غير GET أو غير الخاصة بالنظام
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // 4. الموارد الثابتة (صور، ملفات JS، CSS): Cache First مع تحديث بالخلفية
  event.respondWith(
    caches.match(request, { ignoreSearch: true })
      .then(cached => {
        if (cached) {
          fetch(request).then(response => {
            if (response && response.status === 200) {
              caches.open(CACHE_NAME).then(cache => cache.put(request, response)).catch(() => {});
            }
          }).catch(() => {});
          return cached;
        }
        return fetch(request, { redirect: 'follow' }).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone)).catch(() => {});
          }
          return response;
        });
      })
      .catch(() => new Response('', { status: 503 }))
  );
});