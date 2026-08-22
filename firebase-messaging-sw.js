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
  console.log('📩 إشعار في الخلفية (onBackgroundMessage):', payload);

  // محاولة قراءة البيانات من عدة مصادر
  let title = '📦 ابن مختار';
  let body = 'لديك إشعار جديد';
  let link = '/driver/';
  let orderId = null;

  // 1️⃣ من payload.notification (إذا وجد)
  if (payload.notification) {
    title = payload.notification.title || title;
    body = payload.notification.body || body;
    if (payload.notification.link) link = payload.notification.link;
  }

  // 2️⃣ من payload.data (إذا وجد)
  if (payload.data) {
    if (payload.data.title) title = payload.data.title;
    if (payload.data.body) body = payload.data.body;
    if (payload.data.link) link = payload.data.link;
    if (payload.data.order_id) orderId = payload.data.order_id;
  }

  // 3️⃣ من الجذر مباشرة (إذا كان payload يحوي title/body)
  if (payload.title) title = payload.title;
  if (payload.body) body = payload.body;
  if (payload.link) link = payload.link;
  if (payload.order_id) orderId = payload.order_id;

  // إذا لم يوجد نص، لا نعرض الإشعار
  if (!body || body.trim() === '') {
    console.log('⚠️ لا يوجد محتوى للإشعار، تم الإلغاء.');
    return;
  }

  const options = {
    body: body,
    icon: '/icon-192x192.png',
    badge: '/icon-192x192.png',
    vibrate: [200, 100, 200],
    data: {
      url: orderId ? `/driver/?order_id=${orderId}` : link,
      order_id: orderId
    },
    actions: [
      { action: 'open', title: '📂 فتح' },
      { action: 'close', title: '❌ إغلاق' }
    ]
  };

  // عرض الإشعار
  self.registration.showNotification(title, options);

  // إرسال رسالة للصفحات المفتوحة لتحديث الواجهة فوراً
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: 'NEW_NOTIFICATION',
        payload: {
          title: title,
          body: body,
          order_id: orderId,
          link: link
        }
      });
    });
  });
});

// ========== معالج push مباشر (احتياطي، للإشعارات غير القادمة عبر Firebase) ==========
self.addEventListener('push', (event) => {
  console.log('📩 Push event received (direct handler)');
  let data = { title: '📦 ابن مختار', body: 'لديك إشعار جديد', link: '/driver/', order_id: null };
  try {
    if (event.data) {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
    }
  } catch (e) {
    data.body = event.data.text() || data.body;
  }

  // التأكد من أن body ليس فارغاً
  if (!data.body || data.body.trim() === '') {
    console.log('⚠️ لا يوجد محتوى للإشعار (push direct)، تم الإلغاء.');
    return;
  }

  const options = {
    body: data.body,
    icon: '/icon-192x192.png',
    badge: '/icon-192x192.png',
    vibrate: [200, 100, 200],
    data: {
      url: data.link || '/driver/',
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
        // إرسال رسالة للصفحات المفتوحة
        return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      })
      .then(clients => {
        clients.forEach(client => {
          client.postMessage({
            type: 'NEW_NOTIFICATION',
            payload: {
              title: data.title,
              body: data.body,
              order_id: data.order_id || null,
              link: data.link || '/driver/'
            }
          });
        });
      })
  );
});

// ========== معالجة النقر على الإشعار ==========
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/driver/';
  const orderId = event.notification.data?.order_id || null;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.includes('ibnalmukhtar.com') && 'focus' in client) {
            client.focus();
            if (orderId) {
              client.postMessage({
                type: 'OPEN_ORDER',
                order_id: orderId
              });
            }
            return;
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});