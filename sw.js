// ============================================================
// 🏢 Service Worker - نظام ابن مختار (الإصدار النهائي v19)
// ============================================================

const CACHE_NAME = 'ibn-mukhtar-pos-v24';
const STATIC_CACHE = 'ibn-mukhtar-static-v24';
const DYNAMIC_CACHE = 'ibn-mukhtar-dynamic-v24';
const VERSION = '2025-02-18-015';

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
// 1️⃣ تثبيت SW (مع حذف الكاش القديم)
// --------------------------------------------
self.addEventListener('install', event => {
    console.log('[SW] 📦 تثبيت الإصدار:', VERSION);
    event.waitUntil(
        caches.keys()
            .then(keys => {
                return Promise.all(
                    keys.map(key => {
                        if (key.startsWith('ibn-mukhtar-')) {
                            console.log('[SW] 🗑️ حذف الكاش القديم:', key);
                            return caches.delete(key);
                        }
                    })
                );
            })
            .then(() => caches.open(STATIC_CACHE))
            .then(cache => {
                console.log('[SW] 📦 تخزين الملفات الثابتة');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => self.skipWaiting())
            .catch(err => console.warn('[SW] ⚠️ فشل التخزين:', err))
    );
});

// --------------------------------------------
// 2️⃣ تفعيل SW (مع السيطرة على الصفحات فوراً)
// --------------------------------------------
self.addEventListener('activate', event => {
    console.log('[SW] 🚀 تفعيل الإصدار:', VERSION);
    event.waitUntil(
        caches.keys()
            .then(keys => {
                return Promise.all(
                    keys.filter(key => key !== STATIC_CACHE && key !== DYNAMIC_CACHE)
                        .map(key => {
                            console.log('[SW] 🗑️ حذف الكاش القديم:', key);
                            return caches.delete(key);
                        })
                );
            })
            .then(() => self.clients.claim())
            .then(() => {
                self.clients.matchAll({ type: 'window' }).then(clients => {
                    clients.forEach(client => {
                        client.postMessage({ action: 'reload', version: VERSION });
                    });
                });
            })
    );
});

// --------------------------------------------
// 3️⃣ استراتيجية الجلب (Fetch)
// --------------------------------------------
self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);
    
    // تحسين التعرف على صفحات التنقل بشكل أدق
    const isHtmlPage = request.headers.get('Accept')?.includes('text/html') || 
                       url.pathname.endsWith('.html') || 
                       request.mode === 'navigate'; // 👈 التقاط جميع طلبات التنقل بين الصفحات

    const isStaticAsset = STATIC_ASSETS.some(asset => url.pathname === asset || url.pathname + '/' === asset);
    const isExternalLib = url.origin !== self.location.origin && 
                          (url.pathname.includes('fonts.googleapis.com') || 
                           url.pathname.includes('cdnjs.cloudflare.com') ||
                           url.pathname.includes('cdn.jsdelivr.net'));

    // تجاهل طلبات API والتحليلات ليتعامل معها المتصفح مباشرة
    if (url.pathname.includes('/api/') ||
        url.pathname.includes('analytics') ||
        url.pathname.includes('google-analytics') ||
        url.pathname.includes('doubleclick.net')) {
        return; 
    }

    // ===== استراتيجية صفحات HTML (Network First) =====
    if (isHtmlPage) {
        event.respondWith(
            fetch(request)
                .then(response => {
                    // 🟢 الحل الجذري: إرجاع الاستجابة دائماً للمتصفح سواء كانت 200 أو 304 (لم تتغير) أو 301
                    if (response && response.status === 200) {
                        const clone = response.clone();
                        caches.open(DYNAMIC_CACHE)
                            .then(cache => cache.put(request, clone))
                            .catch(() => {});
                    }
                    return response; // إرجاع الصفحة وعدم قطع الاتصال أبداً
                })
                .catch(() => {
                    // 🔴 لا ندخل هنا إلا في حالة انقطاع الإنترنت (Offline)
                    return caches.match(request, { ignoreSearch: true })
                        .then(cached => {
                            if (cached) return cached;
                            
                            // محاولة ذكية: إذا طلب صفحة بصيغة html ولم يجدها، يجرب بدونها والعكس
                            const fallbackUrl = url.pathname.endsWith('.html') 
                                ? url.pathname.replace('.html', '') 
                                : url.pathname + '.html';
                                
                            return caches.match(fallbackUrl, { ignoreSearch: true });
                        })
                        .then(finalCached => finalCached || new Response(OFFLINE_PAGE, {
                            status: 503,
                            headers: { 'Content-Type': 'text/html; charset=utf-8' }
                        }));
                })
        );
        return;
    }

    // ===== استراتيجية الموارد الثابتة (Cache First) =====
    if (isStaticAsset || isExternalLib) {
        event.respondWith(
            caches.match(request, { ignoreSearch: true })
                .then(cached => {
                    if (cached) {
                        fetch(request).then(response => {
                            if(response && response.status === 200) {
                                caches.open(STATIC_CACHE).then(cache => cache.put(request, response));
                            }
                        }).catch(() => {});
                        return cached;
                    }
                    return fetch(request)
                        .then(response => {
                            if (response && response.status === 200) {
                                const clone = response.clone();
                                caches.open(STATIC_CACHE).then(cache => cache.put(request, clone));
                            }
                            return response;
                        });
                })
        );
        return;
    }

    // ===== للطلبات الأخرى (صور، ملفات غير مدرجة، إلخ) =====
    event.respondWith(
        caches.match(request, { ignoreSearch: true })
            .then(cached => {
                if (cached) return cached;
                return fetch(request)
                    .then(response => {
                        if (response && response.status === 200 && request.method === 'GET') {
                            const clone = response.clone();
                            caches.open(DYNAMIC_CACHE).then(cache => cache.put(request, clone));
                        }
                        return response;
                    })
                    .catch(() => new Response('', { status: 404, statusText: 'Not Found' }));
            })
    );
});
// --------------------------------------------
// 4️⃣ استقبال الإشعارات (Push)
// --------------------------------------------
// --------------------------------------------
// 4️⃣ استقبال الإشعارات (Push)
// --------------------------------------------
// --------------------------------------------
// 4️⃣ استقبال الإشعارات (Push) - النسخة المحسنة
// --------------------------------------------
// --------------------------------------------
// 4️⃣ استقبال الإشعارات (Push) - النسخة المحسنة
// --------------------------------------------
self.addEventListener('push', event => {
    console.log('📩 تم استقبال حدث push!');

    if (!event.data) {
        console.log('⚠️ لا توجد بيانات في الإشعار.');
        return;
    }

    let notificationData = {
        title: '📦 ابن مختار',
        body: 'لديك إشعار جديد',
        link: '/driver.html',
        icon: '/icon-192x192.png',
        badge: '/icon-192x192.png',
        vibrate: [200, 100, 200],
        tag: 'default',
        requireInteraction: true,
        data: { link: '/driver.html' }
    };

    let orderId = null;

    try {
        const payload = event.data.json();
        console.log('📨 البيانات الخام:', payload);

        // ---- استخراج البيانات من الحقول المختلفة ----
        if (payload.notification) {
            notificationData.title = payload.notification.title || notificationData.title;
            notificationData.body = payload.notification.body || notificationData.body;
            if (payload.notification.icon) notificationData.icon = payload.notification.icon;
            if (payload.notification.badge) notificationData.badge = payload.notification.badge;
        }

        // بيانات مخصصة
        if (payload.data) {
            if (payload.data.title) notificationData.title = payload.data.title;
            if (payload.data.body) notificationData.body = payload.data.body;
            if (payload.data.link) notificationData.link = payload.data.link;
            if (payload.data.order_id) {
                orderId = payload.data.order_id;
                notificationData.data.order_id = orderId;
            }
            // تخزين جميع البيانات المخصصة
            notificationData.data.notification_data = payload.data;
        }

        // قراءة مباشرة من الجذر
        if (payload.title) notificationData.title = payload.title;
        if (payload.body) notificationData.body = payload.body;
        if (payload.link) notificationData.link = payload.link;
        if (payload.click_action) notificationData.link = payload.click_action;
        if (payload.fcmOptions?.link) notificationData.link = payload.fcmOptions.link;

        // استخراج order_id من أي مكان
        if (!orderId) {
            if (payload.order_id) orderId = payload.order_id;
            else if (payload.data?.order_id) orderId = payload.data.order_id;
        }

        if (orderId) {
            notificationData.data.order_id = orderId;
            // تحديث الرابط ليشمل order_id
            if (!notificationData.link.includes('order_id=')) {
                notificationData.link += (notificationData.link.includes('?') ? '&' : '?') + 'order_id=' + orderId;
            }
        }

        if (!notificationData.body || notificationData.body.trim() === '') {
            console.log('🚫 تم إلغاء الإشعار لعدم وجود نص (body).');
            return;
        }

    } catch (error) {
        console.warn('⚠️ فشل تحليل JSON، محاولة القراءة كنص عادي:', error);
        const text = event.data.text();
        if (text) notificationData.body = text;
    }

    const options = {
        body: notificationData.body,
        icon: notificationData.icon,
        badge: notificationData.badge,
        vibrate: notificationData.vibrate,
        data: notificationData.data,
        tag: notificationData.tag,
        requireInteraction: notificationData.requireInteraction,
        actions: [
            { action: 'open', title: '📂 فتح التطبيق' },
            { action: 'close', title: '❌ إغلاق' }
        ]
    };

    event.waitUntil(
        self.registration.showNotification(notificationData.title, options)
            .then(() => {
                console.log('✅ تم عرض الإشعار بنجاح');
                // إرسال رسالة للصفحات المفتوحة
                return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            })
            .then(clients => {
                clients.forEach(client => {
                    client.postMessage({
                        type: 'NEW_NOTIFICATION',
                        payload: {
                            title: notificationData.title,
                            body: notificationData.body,
                            order_id: notificationData.data.order_id || null,
                            link: notificationData.link
                        }
                    });
                });
            })
            .catch(err => console.error('❌ فشل عرض الإشعار:', err))
    );
});

// --------------------------------------------
// 5️⃣ التعامل مع النقر على الإشعار
// --------------------------------------------
// --------------------------------------------
// 5️⃣ التعامل مع النقر على الإشعار
// --------------------------------------------
self.addEventListener('notificationclick', event => {
    console.log('🖱️ تم النقر على الإشعار:', event.notification);
    event.notification.close();

    let link = '/driver.html';
    let orderId = null;

    // استخراج الرابط و order_id من بيانات الإشعار
    if (event.notification.data) {
        link = event.notification.data.link || link;
        orderId = event.notification.data.order_id || null;
    }

    // إذا كان هناك order_id، نضيفه للرابط إذا لم يكن موجوداً
    if (orderId && !link.includes('order_id=')) {
        link += (link.includes('?') ? '&' : '?') + 'order_id=' + orderId;
    }

    if (event.action === 'open' || !event.action) {
        event.waitUntil(
            clients.matchAll({ 
                type: 'window', 
                includeUncontrolled: true 
            })
            .then(clientList => {
                // حاول العثور على نافذة مفتوحة بنفس الرابط
                for (const client of clientList) {
                    if (client.url === link && 'focus' in client) {
                        // أرسل رسالة لفتح الطلب المحدد
                        if (orderId) {
                            client.postMessage({
                                type: 'OPEN_ORDER',
                                order_id: orderId
                            });
                        }
                        return client.focus();
                    }
                }
                // إذا لم توجد نافذة، افتح صفحة جديدة
                if (clients.openWindow) {
                    return clients.openWindow(link)
                        .then(newClient => {
                            // بعد فتح الصفحة، أرسل رسالة لفتح الطلب بعد تحميلها
                            if (newClient && orderId) {
                                newClient.postMessage({
                                    type: 'OPEN_ORDER',
                                    order_id: orderId
                                });
                            }
                            return newClient;
                        });
                }
            })
            .catch(() => {
                // فتح النافذة بشكل مباشر في حال فشل البحث
                clients.openWindow(link).catch(() => {});
            })
        );
    }
});

// --------------------------------------------
// 6️⃣ تحديث الصفحات عند استلام رسالة إعادة التحميل
// --------------------------------------------
self.addEventListener('message', event => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
    if (event.data && event.data.action === 'reload') {
        event.source?.postMessage({ action: 'reload' });
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
        .offline-subtitle { font-size: 18px; opacity: 0.9; margin-bottom: 10px; line-height: 1.6; }
        .offline-version { font-size: 14px; opacity: 0.6; margin-bottom: 30px; }
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
        <p class="offline-version">🔄 آخر تحديث للصفحة: ${new Date().toLocaleString('ar-EG')}</p>
        <div class="offline-actions">
            <button class="offline-btn" onclick="location.reload()">🔄 إعادة المحاولة</button>
            <button class="offline-btn offline-btn-secondary" onclick="window.location.href='/'">🏠 الصفحة الرئيسية</button>
        </div>
    </div>
</body>
</html>`;