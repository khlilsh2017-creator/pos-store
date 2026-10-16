/* ============================================================
 * api-client.js — نظام Failover مركزي
 * الإصدار: 1.0.1
 * ============================================================ */
(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════
    // 1. الإعدادات
    // ═══════════════════════════════════════════════════════════
    const API_ENDPOINTS = [
        'https://api.ibnalmukhtar.com',   // الأساسي — مباشر
        'https://go3.ibnalmukhtar.com'    // الاحتياطي — عبر الوسيط
    ];

    const PROTECTED_DOMAINS = [
        'api.ibnalmukhtar.com',
        'go3.ibnalmukhtar.com'
    ];

    const REQUEST_TIMEOUT_MS = 8000;
    const WRITE_REQUEST_TIMEOUT_MS = 25000;
    const HEALTH_CHECK_INTERVAL_MS = 60000;
    const STORAGE_KEY = '_apiEndpointIndex_v3';  // ← مفتاح جديد

    // ═══════════════════════════════════════════════════════════
    // 2. الحالة الداخلية
    // ═══════════════════════════════════════════════════════════
    let activeIndex = 0;
    let isInitialized = false;

    try {
        const saved = parseInt(localStorage.getItem(STORAGE_KEY) || '0', 10);
        if (Number.isInteger(saved) && saved >= 0 && saved < API_ENDPOINTS.length) {
            activeIndex = saved;
        }
    } catch (_) {}

    const originalFetch = window.fetch ? window.fetch.bind(window) : null;
    if (!originalFetch) {
        console.error('❌ api-client.js: fetch غير متاح');
        return;
    }

    // ═══════════════════════════════════════════════════════════
    // 3. استخراج المسار من رابط محمي
    // ═══════════════════════════════════════════════════════════
    function findProtectedPath(urlString) {
        for (const domain of PROTECTED_DOMAINS) {
            const idx = urlString.indexOf(domain);
            if (idx !== -1) {
                const afterDomain = urlString.slice(idx + domain.length);
                if (afterDomain === '' || afterDomain.startsWith('/') ||
                    afterDomain.startsWith('?') || afterDomain.startsWith('#')) {
                    return afterDomain || '/';
                }
            }
        }
        return null;
    }

    // ═══════════════════════════════════════════════════════════
    // 4. fetch مع Failover
    // ═══════════════════════════════════════════════════════════
    async function fetchWithFailover(pathWithQuery, init = {}) {
        const errors = [];
        const startIndex = activeIndex;
        const method = String(init.method || 'GET').toUpperCase();
        const isWriteRequest = !['GET', 'HEAD', 'OPTIONS'].includes(method);
        const timeoutMs = isWriteRequest ? WRITE_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;

        for (let attempt = 0; attempt < API_ENDPOINTS.length; attempt++) {
            const idx = (startIndex + attempt) % API_ENDPOINTS.length;
            const base = API_ENDPOINTS[idx];
            const targetUrl = base + pathWithQuery;

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            const finalInit = Object.assign({}, init, { signal: controller.signal });

            try {
                const res = await originalFetch(targetUrl, finalInit);
                clearTimeout(timeoutId);

                // ═══ 5xx = فشل → المتابعة للتالي (لطلبات القراءة أو 502/503/504 قبل التنفيذ) ═══
                if (res.status >= 500 && res.status < 600) {
                    errors.push(`${base}: HTTP ${res.status}`);
                    if (isWriteRequest && res.status === 500) {
                        // خطأ 500 من داخل السيرفر في عملية كتابة لا ينبغي إعادته لنقطة اتصال ثانية لنفس قاعدة البيانات
                        return res;
                    }
                    console.warn(`❌ [api-client] ${base} → HTTP ${res.status} — المتابعة للتالي`);
                    continue;
                }

                // نجاح (2xx, 3xx, 4xx)
                if (activeIndex !== idx) {
                    const previousBase = API_ENDPOINTS[activeIndex];
                    activeIndex = idx;
                    try { localStorage.setItem(STORAGE_KEY, String(idx)); } catch (_) {}
                    console.log(`🔄 [api-client] التبديل من ${previousBase} إلى ${base}`);
                    try {
                        dispatchEvent(new CustomEvent('api-endpoint-changed', {
                            detail: { from: previousBase, to: base, index: idx }
                        }));
                    } catch (_) {}
                }

                return res;
            } catch (err) {
                clearTimeout(timeoutId);
                const isTimeout = err && err.name === 'AbortError';
                const reason = isTimeout ? 'timeout' : (err && err.message) || 'unknown';
                errors.push(`${base}: ${reason}`);
                if (isWriteRequest && isTimeout) {
                    console.warn(`⚠️ [api-client] انتهت مهلة عملية الكتابة على ${base} (${timeoutMs}ms) — إيقاف إعادة الإرسال المزدوج لنقطة احتياطية لمنع التكرار`);
                    break;
                }
                console.warn(`❌ [api-client] فشل ${base} (${reason}) — المتابعة للتالي`);
            }
        }

        const error = new Error(`فشلت جميع نقاط الاتصال: ${errors.join(' | ')}`);
        error.name = 'AllEndpointsFailed';
        error.endpointErrors = errors;
        throw error;
    }

    // ═══════════════════════════════════════════════════════════
    // 5. اعتراض fetch العالمي
    // ═══════════════════════════════════════════════════════════
    window.fetch = async function (input, init = {}) {
        let urlString = '';
        if (typeof input === 'string') {
            urlString = input;
        } else if (input instanceof URL) {
            urlString = input.toString();
        } else if (input && typeof input.url === 'string') {
            urlString = input.url;
        } else if (input && typeof input === 'object') {
            return originalFetch(input, init);
        }

        const protectedPath = findProtectedPath(urlString);
        if (protectedPath === null) {
            return originalFetch(input, init);
        }

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
            } catch (_) {}
        }

        return fetchWithFailover(protectedPath, init);
    };

    // ═══════════════════════════════════════════════════════════
    // 6. فحص دوري لرجوع النقطة الأساسية
    // ═══════════════════════════════════════════════════════════
    let healthCheckTimer = null;

    async function checkPrimaryHealth() {
        if (activeIndex === 0) return;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000);

            const res = await originalFetch(`${API_ENDPOINTS[0]}/currencies`, {
                method: 'HEAD',
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (res.ok || res.status === 401 || res.status === 403 || res.status === 405) {
                console.log('✅ [api-client] الأساسي رجع يعمل — العودة إليه');
                const previousBase = API_ENDPOINTS[activeIndex];
                activeIndex = 0;
                try { localStorage.setItem(STORAGE_KEY, '0'); } catch (_) {}
                dispatchEvent(new CustomEvent('api-endpoint-recovered', {
                    detail: { from: previousBase, to: API_ENDPOINTS[0] }
                }));
            }
        } catch (_) {}
    }

    function startHealthMonitor() {
        if (healthCheckTimer) clearInterval(healthCheckTimer);
        healthCheckTimer = setInterval(checkPrimaryHealth, HEALTH_CHECK_INTERVAL_MS);
    }

    // ═══════════════════════════════════════════════════════════
    // 7. واجهة API عامة
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
        version: '1.0.1'
    };

    // ═══════════════════════════════════════════════════════════
    // 8. بدء
    // ═══════════════════════════════════════════════════════════
    if (!isInitialized) {
        isInitialized = true;
        startHealthMonitor();
        console.log(`✅ [api-client v1.0.1] مُفعّل. النقطة النشطة: ${API_ENDPOINTS[activeIndex]}`);
        console.log(`📋 الترتيب: ${API_ENDPOINTS.join(' → ')}`);
    }
})();