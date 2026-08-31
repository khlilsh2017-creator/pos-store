importScripts('/offline-sw-core.js');

const CACHE_NAME = 'pos-phone-shell-v11-no-html-intercept';

// قائمة الملفات الثابتة (باستثناء HTML)
const STATIC_FILES = [
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
      .then(cache => cache.addAll(STATIC_FILES))
      .then(() => self.skipWaiting())
      .catch(err => console.error('[SW] تثبيت فاشل:', err))
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

  // تجاهل طلبات HTML – نتركها للشبكة مباشرة
  if (url.pathname.endsWith('.html')) {
    // نمرر الطلب للشبكة بدون أي تدخل من الـ SW
    return;
  }

  // معالجة طلبات API (إن وجدت)
  if (typeof offlineIsApiRequest === 'function' && offlineIsApiRequest(url)) {
    event.respondWith(offlineHandleApiRequest(request));
    return;
  }

  // تجاهل الطلبات غير GET أو من خارج النطاق
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // للموارد الأخرى (صور، JS، CSS) – نستخدم الكاش أولاً ثم الشبكة
  event.respondWith(
    caches.match(request)
      .then(cached => cached || fetch(request, { redirect: 'follow' }))
      .catch(() => new Response('', { status: 503 }))
  );
});