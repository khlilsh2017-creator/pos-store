/* ============================================================
 * api-client.js — مكتبة Failover مركزية لكل التطبيقات
 * الإصدار: 1.0.0
 * 
 * الاستخدام: أضف في أي صفحة HTML:
 *   <script src="https://cdn.ibnalmukhtar.com/api-client.js"></script>
 *   (قبل أي سكريبت آخر)
 * 
 * بمجرد التحميل، كل طلبات fetch() إلى api.ibnalmukhtar.com
 * أو go3.ibnalmukhtar.com ستحصل على Failover تلقائي.
 * ============================================================ */

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════
    // 1. الإعدادات (عدّل هنا فقط، والباقي يعمل تلقائياً)
    // ═══════════════════════════════════════════════════════════
    const API_ENDPOINTS = [
        'https://go3.ibnalmukhtar.com',   // الأساسي (عبر الوسيط)
        'https://api.ibnalmukhtar.com'    // الاحتياطي (مباشر)
    ];

    // الدومينات التي ستُعترَض وتُبدَّل تلقائياً
    const PROTECTED_DOMAINS = [
        'api.ibnalmukhtar.com',
        'go3.ibnalmukhtar.com'
    ];

    // مهلة الطلب (بالمللي ثانية) قبل التبديل
    const REQUEST_TIMEOUT_MS = 7000;

    // فترة فحص رجوع النقطة الأساسية (بالمللي ثانية)
    const HEALTH_CHECK_INTERVAL_MS = 60000;

    // مفتاح localStorage لحفظ النقطة النشطة
    const STORAGE_KEY = '_apiEndpointIndex_v1';

    // ═══════════════════════════════════════════════════════════
    // 2. الحالة الداخلية
    // ═══════════════════════════════════════════════════════════
    let activeIndex = 0;
    let isInitialized = false;

    // استرجاع النقطة النشطة من جلسة سابقة
    try {
        const saved = parseInt(localStorage.getItem(STORAGE_KEY) || '0', 10);
        if (Number.isInteger(saved) && saved >= 0 && saved < API_ENDPOINTS.length) {
            activeIndex = saved;
        }
    } catch (_) { /* localStorage قد لا يكون متاحاً */ }

    // حفظ مرجع fetch الأصلي
    const originalFetch = window.fetch ? window.fetch.bind(window) : null;

    if (!originalFetch) {
        console.error('❌ api-client.js: fetch غير متاح في هذه البيئة');
        return;
    }

    // ═══════════════════════════════════════════════════════════
    // 3. دالة مساعدة: هل هذا الرابط يخص أحد الدومينات المحمية؟
    // ═══════════════════════════════════════════════════════════
    function findProtectedPath(urlString) {
        for (const domain of PROTECTED_DOMAINS) {
            const idx = urlString.indexOf(domain);
            if (idx !== -1) {
                const afterDomain = urlString.slice(idx + domain.length);
                // نتحقق أنه ليس مجرد تشابه نصي
                if (afterDomain === '' || afterDomain.startsWith('/') ||
                    afterDomain.startsWith('?') || afterDomain.startsWith('#')) {
                    return afterDomain || '/';
                }
            }
        }
        return null;
    }

    // ═══════════════════════════════════════════════════════════
    // 4. دالة fetch المحسّنة (Failover)
    // ═══════════════════════════════════════════════════════════
    async function fetchWithFailover(pathWithQuery, init = {}) {
        const errors = [];
        const startIndex = activeIndex;

        for (let attempt = 0; attempt < API_ENDPOINTS.length; attempt++) {
            const idx = (startIndex + attempt) % API_ENDPOINTS.length;
            const base = API_ENDPOINTS[idx];
            const targetUrl = base + pathWithQuery;

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

            // إذا كان init.signal موجوداً، نربطه مع controller الخاص بنا
            const finalInit = Object.assign({}, init, { signal: controller.signal });

            try {
                const res = await originalFetch(targetUrl, finalInit);
                clearTimeout(timeoutId);

                // نجاح — حدّث النقطة النشطة إن تغيّرت
                if (activeIndex !== idx) {
                    const previousBase = API_ENDPOINTS[activeIndex];
                    activeIndex = idx;
                    try { localStorage.setItem(STORAGE_KEY, String(idx)); } catch (_) {}
                    console.log(`🔄 [api-client] التبديل من ${previousBase} إلى ${base}`);
                    dispatchEvent(new CustomEvent('api-endpoint-changed', {
                        detail: { from: previousBase, to: base, index: idx }
                    }));
                }

                return res;
            } catch (err) {
                clearTimeout(timeoutId);
                const reason = err && err.name === 'AbortError' ? 'timeout' : (err && err.message) || 'unknown';
                errors.push(`${base}: ${reason}`);
                console.warn(`❌ [api-client] فشل ${base} (${reason}) — المتابعة للتالي`);
            }
        }

        const error = new Error(`فشلت جميع نقاط الاتصال (${errors.length}): ${errors.join(' | ')}`);
        error.name = 'AllEndpointsFailed';
        error.endpointErrors = errors;
        throw error;
    }

    // ═══════════════════════════════════════════════════════════
    // 5. اعتراض fetch العالمي
    // ═══════════════════════════════════════════════════════════
    window.fetch = async function (input, init = {}) {
        // استخرج الرابط كنص
        let urlString = '';
        if (typeof input === 'string') {
            urlString = input;
        } else if (input instanceof URL) {
            urlString = input.toString();
        } else if (input && typeof input.url === 'string') {
            urlString = input.url;
        } else if (input && typeof input === 'object') {
            // لا يمكن تحليل هذا النوع، مرّره للأصل
            return originalFetch(input, init);
        }

        // هل يخص أحد الدومينات المحمية؟
        const protectedPath = findProtectedPath(urlString);

        if (protectedPath === null) {
            // ليس ضمن نطاقنا — مرّره للأصل
            return originalFetch(input, init);
        }

        // إذا كان الطلب لـ Request object، نحتاج استخراج التفاصيل
        if (input instanceof Request && !init.method && !init.body) {
            try {
                init = {
                    method: input.method,
                    headers: Object.fromEntries(input.headers.entries()),
                    body: ['GET', 'HEAD'].includes(input.method) ? undefined : await input.clone().arrayBuffer(),
                    credentials: input.credentials,
                    mode: input.mode,
                    cache: input.cache,
                    redirect: input.redirect,
                    referrer: input.referrer,
                    referrerPolicy: input.referrerPolicy,
                    integrity: input.integrity,
                    keepalive: input.keepalive
                };
            } catch (_) { /* استخدم init كما هو */ }
        }

        return fetchWithFailover(protectedPath, init);
    };

    // ═══════════════════════════════════════════════════════════
    // 6. فحص دوري: إذا كنا على نقطة ثانوية، هل رجع الأساسي؟
    // ═══════════════════════════════════════════════════════════
    let healthCheckTimer = null;

    async function checkPrimaryHealth() {
        if (activeIndex === 0) return; // نحن على الأساسي أصلاً

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000);

            const res = await originalFetch(`${API_ENDPOINTS[0]}/currencies`, {
                method: 'HEAD',
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            // 401 يعني أن الخادم يستجيب (فقط يطلب توثيق)
            if (res.ok || res.status === 401 || res.status === 403) {
                console.log('✅ [api-client] النقطة الأساسية رجعت تعمل — العودة إليها');
                const previousBase = API_ENDPOINTS[activeIndex];
                activeIndex = 0;
                try { localStorage.setItem(STORAGE_KEY, '0'); } catch (_) {}
                dispatchEvent(new CustomEvent('api-endpoint-recovered', {
                    detail: { from: previousBase, to: API_ENDPOINTS[0] }
                }));
            }
        } catch (_) { /* الأساسي لا يزال معطلاً */ }
    }

    function startHealthMonitor() {
        if (healthCheckTimer) clearInterval(healthCheckTimer);
        healthCheckTimer = setInterval(checkPrimaryHealth, HEALTH_CHECK_INTERVAL_MS);
    }

    // ═══════════════════════════════════════════════════════════
    // 7. واجهة API عامة (يمكن استخدامها من أي صفحة)
    // ═══════════════════════════════════════════════════════════
    window.ApiClient = {
        endpoints: API_ENDPOINTS.slice(),
        getActive: () => API_ENDPOINTS[activeIndex],
        getActiveIndex: () => activeIndex,
        reset: () => {
            activeIndex = 0;
            try { localStorage.setItem(STORAGE_KEY, '0'); } catch (_) {}
        },
        fetch: (path, init) => fetchWithFailover(path, init),
        version: '1.0.0'
    };

    // ═══════════════════════════════════════════════════════════
    // 8. بدء التشغيل
    // ═══════════════════════════════════════════════════════════
    if (!isInitialized) {
        isInitialized = true;
        startHealthMonitor();
        console.log(`✅ [api-client v1.0.0] مُفعّل. النقطة النشطة: ${API_ENDPOINTS[activeIndex]}`);
    }
})();