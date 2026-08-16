importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: "AIzaSyDjMiUhBOF9h1arbea4ZAorD-GdtATQ3Fs",
  authDomain: "ibn-al-mukhtar-pos.firebaseapp.com",
  projectId: "ibn-al-mukhtar-pos",
  storageBucket: "ibn-al-mukhtar-pos.firebasestorage.app",
  messagingSenderId: "953096430757",
  appId: "1:953096430757:web:7c2b60bd719aa70964994c"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// تحديث الـ SW فوراً
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// عرض الإشعارات في الخلفية
messaging.onBackgroundMessage((payload) => {
  const notificationTitle = payload.notification?.title || '📦 إشعار جديد';
  const notificationOptions = {
    body: payload.notification?.body || '',
    icon: '/icon-512x512.png',
    badge: '/icon-512x512.png',
    data: payload.data || {},
  };
  self.registration.showNotification(notificationTitle, notificationOptions);
});

// معالجة النقر على الإشعار
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = event.notification.data?.url || 'https://pos.ibnalmukhtar.com/driver.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // إرسال رسالة للصفحة لتحديث البيانات فوراً
        clientList.forEach(client => {
          client.postMessage({
            type: 'NEW_NOTIFICATION',
            payload: event.notification.data || {}
          });
        });
        // تركيز النافذة المفتوحة أو فتح جديدة
        for (const client of clientList) {
          if (client.url.includes('ibnalmukhtar.com') && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});