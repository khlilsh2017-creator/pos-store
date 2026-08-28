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
      .then(cache => Promise.all(PHONE_SHELL.map(asset => cache.add(asset).catch(error => console.warn('[PHONE SW] تعذر تخزين', asset, error)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('pos-phone-shell-') && key !== PHONE_CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (offlineIsApiRequest(url)) {
    event.respondWith(offlineHandleApiRequest(request));
    return;
  }
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.endsWith('.json') && !url.pathname.startsWith('/phone/')) return;
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(PHONE_CACHE).then(cache => cache.put(request, copy));
    }
    return response;
  }).catch(() => cached || new Response('غير متاح دون اتصال', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))));
});
