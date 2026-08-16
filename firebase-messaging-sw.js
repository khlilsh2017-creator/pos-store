// firebase-messaging-sw.js
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

// ========== استقبال الإشعارات في الخلفية ==========
messaging.onBackgroundMessage((payload) => {
  console.log('📩 إشعار في الخلفية:', payload);

  const notificationTitle = payload.notification?.title || '📦 ابن مختار';
  const notificationBody = payload.notification?.body || 'لديك إشعار جديد';
  const orderId = payload.data?.order_id || null; // إذا أرسل الخادم order_id

  const options = {
    body: notificationBody,
    icon: '/icon-192x192.png',
    badge: '/icon-192x192.png',
    vibrate: [200, 100, 200],
    data: {
      url: orderId ? `/driver.html?order_id=${orderId}` : '/driver.html',
      order_id: orderId
    },
    actions: [
      { action: 'open', title: '📂 فتح' },
      { action: 'close', title: '❌ إغلاق' }
    ]
  };

  self.registration.showNotification(notificationTitle, options);

  // إرسال رسالة للصفحات المفتوحة لتحديث الواجهة
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: 'NEW_NOTIFICATION',
        payload: {
          title: notificationTitle,
          body: notificationBody,
          order_id: orderId
        }
      });
    });
  });
});

// ========== معالج push مباشر (احتياطي) ==========
self.addEventListener('push', (event) => {
  console.log('📩 Push event received (direct handler)');
  let data = { title: '📦 ابن مختار', body: 'لديك إشعار جديد', link: '/driver.html' };
  try {
    if (event.data) {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
    }
  } catch (e) {
    data.body = event.data.text() || data.body;
  }

  const options = {
    body: data.body,
    icon: '/icon-192x192.png',
    badge: '/icon-192x192.png',
    vibrate: [200, 100, 200],
    data: {
      url: data.link || '/driver.html',
      order_id: data.order_id || null
    },
    actions: [
      { action: 'open', title: '📂 فتح' },
      { action: 'close', title: '❌ إغلاق' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
      .then(() => {
        // إرسال رسالة للصفحات المفتوحة أيضاً
        return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      })
      .then(clients => {
        clients.forEach(client => {
          client.postMessage({
            type: 'NEW_NOTIFICATION',
            payload: {
              title: data.title,
              body: data.body,
              order_id: data.order_id || null
            }
          });
        });
      })
  );
});

// ========== معالجة النقر على الإشعار ==========
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/driver.html';
  const orderId = event.notification.data?.order_id || null;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // إذا كان هناك نافذة مفتوحة بالفعل، ركز عليها وأرسل رسالة لتحديث الواجهة
        for (const client of clientList) {
          if (client.url.includes('ibnalmukhtar.com') && 'focus' in client) {
            client.focus();
            // أرسل رسالة للصفحة لعرض الطلب المحدد
            if (orderId) {
              client.postMessage({
                type: 'OPEN_ORDER',
                order_id: orderId
              });
            }
            return;
          }
        }
        // وإلا افتح نافذة جديدة
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});