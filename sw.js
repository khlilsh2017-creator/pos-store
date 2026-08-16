// ============================================================
// 🏢 Service Worker - نظام ابن مختار (النسخة المحسنة للإشعارات)
// ============================================================

const CACHE_NAME = 'ibn-mukhtar-pos-v16';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/sale.html',
    '/products.html',
    '/customers.html',
    '/suppliers.html',
    '/purchases.html',
    '/expenses.html',
    '/payments.html',
    '/cash-wallets.html',
    '/invoices.html',
    '/journal.html',
    '/reports.html',
    '/operations.html',
    '/settings.html',
    '/add_order.html',
    '/add_order_ph.html',
    '/barcode-print.html',
    '/driver.html',
    '/online-reports.html',
    '/orders.html',
    '/sales.html',
    '/db.js',
    '/sidebar-config.js',
    '/sidebar.css',
    '/manifest.json',
    '/manifest_pos_s.json',
    '/manifest_pos.json',
    '/icon-192x192.png',
    '/icon-512x512.png'
];

// --------------------------------------------
// 1️⃣ تثبيت Service Worker
// --------------------------------------------
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[SW] 📦 تخزين الملفات الأساسية');
                return cache.addAll(STATIC_ASSETS);
            })
            .catch(err => console.warn('[SW] ⚠️ فشل تخزين بعض الملفات:', err))
    );
    self.skipWaiting();
});

// --------------------------------------------
// 2️⃣ استقبال الإشعارات (Push) - المحور الرئيسي
// --------------------------------------------
self.addEventListener('push', event => {
    console.log('📩 تم استقبال حدث push!');
    
    // استخراج البيانات من الإشعار
    let notificationData = {
        title: '📦 طلب جديد',
        body: 'توجد طلبات جديدة',
        link: '/',
        icon: '/icon-192x192.png',
        badge: '/icon-192x192.png',
        vibrate: [200, 100, 200],
        tag: 'default',
        requireInteraction: true,
        data: { link: '/' }
    };

    try {
        if (event.data) {
            const payload = event.data.json();
            console.log('📨 بيانات الإشعار الخام:', payload);
            
            // إذا كان الإشعار من Firebase (يحتوي على notification و data)
            if (payload.notification) {
                notificationData.title = payload.notification.title || notificationData.title;
                notificationData.body = payload.notification.body || notificationData.body;
                notificationData.icon = payload.notification.icon || notificationData.icon;
                notificationData.badge = payload.notification.badge || notificationData.badge;
                
                // استخراج الرابط من data أو fcm_options
                if (payload.data) {
                    notificationData.link = payload.data.link || payload.data.click_action || '/';
                    notificationData.data.link = notificationData.link;
                }
                if (payload.fcmOptions) {
                    notificationData.link = payload.fcmOptions.link || notificationData.link;
                    notificationData.data.link = notificationData.link;
                }
            } 
            // إذا كان الإشعار مخصصاً (من الخادم مباشرة)
            else if (payload.title || payload.body) {
                notificationData.title = payload.title || notificationData.title;
                notificationData.body = payload.body || notificationData.body;
                notificationData.link = payload.link || payload.click_action || '/';
                notificationData.data.link = notificationData.link;
                notificationData.tag = payload.tag || notificationData.tag;
                notificationData.requireInteraction = payload.requireInteraction !== undefined ? payload.requireInteraction : true;
            }
            
            // إضافة أي بيانات إضافية
            if (payload.data) {
                notificationData.data = { ...notificationData.data, ...payload.data };
            }
        }
    } catch (error) {
        console.warn('⚠️ خطأ في معالجة بيانات الإشعار:', error);
        // محاولة قراءة النص العادي
        if (event.data) {
            const text = event.data.text();
            if (text) {
                try {
                    const parsed = JSON.parse(text);
                    notificationData.title = parsed.title || notificationData.title;
                    notificationData.body = parsed.body || notificationData.body;
                    notificationData.link = parsed.link || '/';
                } catch {
                    notificationData.body = text;
                }
            }
        }
    }

    console.log('📨 الإشعار النهائي:', notificationData);

    // خيارات الإشعار المتقدمة
    const options = {
        body: notificationData.body,
        icon: notificationData.icon,
        badge: notificationData.badge || notificationData.icon,
        vibrate: notificationData.vibrate || [200, 100, 200],
        data: notificationData.data || { link: notificationData.link },
        tag: notificationData.tag || 'default',
        requireInteraction: notificationData.requireInteraction !== undefined ? notificationData.requireInteraction : true,
        actions: [
            { action: 'open', title: '📂 فتح التطبيق' },
            { action: 'close', title: '❌ إغلاق' }
        ],
        // إضافة صورة كبيرة إن وجدت
        image: notificationData.image || null
    };

    // إضافة رابط مخصص في البيانات
    if (notificationData.link) {
        options.data.link = notificationData.link;
    }

    // عرض الإشعار
    event.waitUntil(
        self.registration.showNotification(notificationData.title, options)
            .then(() => console.log('✅ تم عرض الإشعار بنجاح'))
            .catch(err => console.error('❌ فشل عرض الإشعار:', err))
    );
});

// --------------------------------------------
// 3️⃣ التعامل مع النقر على الإشعار
// --------------------------------------------
self.addEventListener('notificationclick', event => {
    console.log('🖱️ تم النقر على الإشعار:', event.notification);
    event.notification.close();

    // تحديد الرابط المستهدف
    let link = '/';
    if (event.notification.data && event.notification.data.link) {
        link = event.notification.data.link;
    } else if (event.notification.data && event.notification.data.url) {
        link = event.notification.data.url;
    }

    // التعامل مع الأزرار
    if (event.action === 'open' || !event.action) {
        event.waitUntil(
            clients.matchAll({ 
                type: 'window', 
                includeUncontrolled: true 
            })
            .then(clientList => {
                // البحث عن نافذة مفتوحة لنفس الرابط
                for (const client of clientList) {
                    if (client.url === link && 'focus' in client) {
                        return client.focus();
                    }
                }
                // إذا لم توجد نافذة، افتح واحدة جديدة
                if (clients.openWindow) {
                    return clients.openWindow(link);
                }
            })
            .catch(() => {
                // محاولة بديلة
                clients.openWindow(link).catch(() => {});
            })
        );
    }
});

// --------------------------------------------
// 4️⃣ استراتيجية الجلب (Cache First)
// --------------------------------------------
self.addEventListener('fetch', event => {
    const { request } = event;

    // تجاهل طلبات التحليلات و API
    if (request.url.includes('google-analytics') ||
        request.url.includes('analytics') ||
        request.url.includes('doubleclick.net') ||
        request.url.includes('/api/')) {
        return;
    }

    event.respondWith(
        caches.match(request)
            .then(cachedResponse => {
                if (cachedResponse) {
                    // تحديث الكاش في الخلفية
                    fetch(request)
                        .then(fetchResponse => {
                            if (fetchResponse && fetchResponse.status === 200) {
                                caches.open(CACHE_NAME)
                                    .then(cache => cache.put(request, fetchResponse.clone()))
                                    .catch(() => {});
                            }
                        })
                        .catch(() => {});
                    return cachedResponse;
                }

                return fetch(request)
                    .then(fetchResponse => {
                        if (fetchResponse && fetchResponse.status === 200) {
                            const clone = fetchResponse.clone();
                            caches.open(CACHE_NAME)
                                .then(cache => cache.put(request, clone))
                                .catch(() => {});
                        }
                        return fetchResponse;
                    })
                    .catch(() => {
                        if (request.headers.get('Accept')?.includes('text/html')) {
                            return new Response(OFFLINE_PAGE, {
                                status: 503,
                                headers: { 'Content-Type': 'text/html; charset=utf-8' }
                            });
                        }
                        return new Response('⚠️ غير متصل بالإنترنت', {
                            status: 503,
                            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                        });
                    });
            })
    );
});

// --------------------------------------------
// 5️⃣ التفعيل وتنظيف الكاش
// --------------------------------------------
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => {
                return Promise.all(
                    keys.filter(key => key !== CACHE_NAME)
                        .map(key => {
                            console.log('[SW] 🗑️ حذف الكاش القديم:', key);
                            return caches.delete(key);
                        })
                );
            })
            .then(() => {
                console.log('[SW] 🚀 تم التفعيل، الإصدار:', CACHE_NAME);
                return self.clients.claim();
            })
    );
});

// --------------------------------------------
// 6️⃣ تحديث التطبيق عبر الرسائل
// --------------------------------------------
self.addEventListener('message', event => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});

// --------------------------------------------
// 7️⃣ صفحة Offline
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
        .offline-subtitle { font-size: 18px; opacity: 0.9; margin-bottom: 30px; line-height: 1.6; }
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
        <div class="offline-actions">
            <button class="offline-btn" onclick="location.reload()">🔄 إعادة المحاولة</button>
            <button class="offline-btn offline-btn-secondary" onclick="window.location.href='/'">🏠 الصفحة الرئيسية</button>
        </div>
    </div>
</body>
</html>`;