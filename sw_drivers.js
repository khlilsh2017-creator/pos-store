// ============================================================
// Service Worker for Standalone Driver Management PWA
// Application: إدارة المندوبين - ابن المختار (Scope: /drivers)
// ============================================================

const CACHE_NAME = 'drivers-pwa-v4-subdomain-root';

const STATIC_ASSETS = [
  '/',
  '/drivers',
  '/manifest_drivers.json',
  '/api-client.js',
  '/login-helper.js',
  '/date-utils.js',
  '/number-utils.js',
  '/permissions.js',
  '/document-utils.js',
  '/offline-sync.js',
  '/offline-sw-core.js',
  '/icon-192x192.png',
  '/icon-512x512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.all(
        STATIC_ASSETS.map(url => cache.add(url).catch(e => console.warn('[SW Drivers] Cache skip:', url, e)))
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k.startsWith('drivers-pwa-') && k !== CACHE_NAME).map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Skip cross-origin or non-GET or API endpoints
  if (req.method !== 'GET' || !url.origin.includes(self.location.origin) || url.pathname.includes('/api/') || url.pathname.includes('workers.dev')) {
    return;
  }

  // Navigation: Network first with cache fallback
  if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('/') || caches.match('/drivers')))
    );
    return;
  }

  // Static assets: Cache first with network update in background
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
