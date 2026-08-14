// ============================================================
// 🏢 Service Worker - نظام ابن مختار (النسخة الموحدة v10)
// ============================================================

const CACHE_NAME = 'ibn-mukhtar-pos-v14';
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

const EXTERNAL_LIBS = [
    'https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;600;700;800&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
    'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js'
];

// --------------------------------------------
// 1️⃣ مرحلة التثبيت (Install)
// --------------------------------------------
self.addEventListener('push', event => {
    console.log('📩 تم استقبال حدث push!');
    console.log('📦 بيانات الإشعار:', event.data);

    let data = { title: '📦 طلب جديد', body: 'توجد طلبات جديدة', link: '/driver.html' };
    try {
        if (event.data) {
            const parsed = event.data.json();
            data = { ...data, ...parsed };
        }
    } catch (_) {
        data.body = event.data.text() || data.body;
    }

    console.log('📨 الإشعار النهائي:', data);

    const options = {
        body: data.body,
        icon: '/icon-192x192.png',
        badge: '/icon-192x192.png',
        vibrate: [200, 100, 200],
        data: { link: data.link || '/driver.html' },
        actions: [
            { action: 'open', title: '📂 فتح التطبيق' },
            { action: 'close', title: '❌ إلغاء' }
        ]
    };

    event.waitUntil(
        self.registration.showNotification(data.title || '🏢 ابن مختار', options)
    );
});

// --------------------------------------------
// 2️⃣ مرحلة التفعيل (Activate) + تنظيف الكاش القديم
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
                return self.clients.claim(); // السيطرة على الصفحات المفتوحة
            })
    );
});

// --------------------------------------------
// 3️⃣ استراتيجية الجلب (Fetch) - Cache First مع تحديث الخلفية
// --------------------------------------------
self.addEventListener('fetch', event => {
    const { request } = event;

    // تجاهل طلبات التحليلات والإحصائيات
    if (request.url.includes('google-analytics') ||
        request.url.includes('analytics') ||
        request.url.includes('doubleclick.net')) {
        return;
    }

    // تجاهل طلبات API (لو وجدت)
    if (request.url.includes('/api/')) {
        return fetch(request);
    }

    event.respondWith(
        caches.match(request)
            .then(cachedResponse => {
                if (cachedResponse) {
                    // تحديث الكاش في الخلفية (stale-while-revalidate)
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

                // لم يوجد في الكاش → جلب من الشبكة
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
                        // عرض صفحة Offline للمستندات HTML
                        if (request.headers.get('Accept')?.includes('text/html')) {
                            return new Response(OFFLINE_PAGE, {
                                status: 503,
                                headers: { 'Content-Type': 'text/html; charset=utf-8' }
                            });
                        }
                        // للموارد الأخرى (صور، CSS، JS)
                        return new Response('⚠️ غير متصل بالإنترنت', {
                            status: 503,
                            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                        });
                    });
            })
    );
});

// --------------------------------------------
// 4️⃣ دعم الإشعارات (Push Notifications)
// --------------------------------------------


// --------------------------------------------
// 5️⃣ التعامل مع النقر على الإشعار
// --------------------------------------------
self.addEventListener('notificationclick', event => {
    event.notification.close();

    if (event.action === 'open' || !event.action) {
        const link = event.notification.data?.link || '/';
        event.waitUntil(
            clients.matchAll({ type: 'window', includeUncontrolled: true })
                .then(clientList => {
                    if (clientList.length > 0) {
                        return clientList[0].focus();
                    }
                    return clients.openWindow(link);
                })
        );
    }
});

// --------------------------------------------
// 6️⃣ تحديث التطبيق عبر الرسائل (message)
// --------------------------------------------
self.addEventListener('message', event => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});

// --------------------------------------------
// 7️⃣ صفحة Offline المدمجة (HTML)
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