// ================================================================
//  1. CONFIG & HELPERS
// ================================================================
const API = 'https://api.ibnalmukhtar.com';
let token = localStorage.getItem('pos_token') || '';
if (!token) window.location.href = 'index.html';

let cart = [];
let productsCache = [];
let customersCache = [];
let selectedCustomerId = null;
let selectedCustomerName = '';
let selectedCustomerInModal = null;
let currentUser = null;
let isOnline = navigator.onLine;
let currentSort = 'name';
let selectedCategoryId = null;
let allCategories = [];
let currentSearch = '';
let editInvoiceId = null;
let currenciesCache = [];
let walletsCache = [];
let saleRules = { allowBelowCost: false, allowNegativeStock: false, allowExpiredNegativeSales: true };
let saleDraftTimer = null;

// ===== متغيرات لمنع الحلقات =====
let updatingDiscountFromPaid = false;
let updatingPaidFromDiscount = false;
let updatingMixedFromCash = false;
let updatingMixedFromWallet = false;

// ================================================================
//  2. INDEXEDDB
// ================================================================
const DB_NAME = 'IbnMukhtarPOS';
const DB_VERSION = 10;

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('products')) {
                db.createObjectStore('products', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('customers')) {
                db.createObjectStore('customers', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('pendingSales')) {
                const store = db.createObjectStore('pendingSales', { keyPath: 'id',
                    autoIncrement: true });
                store.createIndex('synced', 'synced', { unique: false });
            }
            if (!db.objectStoreNames.contains('wallets')) {
                db.createObjectStore('wallets', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('currencies')) {
                db.createObjectStore('currencies', { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function storeExists(db, name) {
    return db.objectStoreNames.contains(name);
}

async function saveProductsToLocal(products) {
    try {
        const db = await openDB();
        if (!storeExists(db, 'products')) return;
        const tx = db.transaction('products', 'readwrite');
        const store = tx.objectStore('products');
        await store.clear();
        products.forEach(p => store.put(p));
        await tx.complete;
    } catch (e) { console.warn('saveProductsToLocal', e); }
}

async function getLocalProducts() {
    try {
        const db = await openDB();
        if (!storeExists(db, 'products')) return [];
        return new Promise((resolve, reject) => {
            const tx = db.transaction('products', 'readonly');
            const store = tx.objectStore('products');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    } catch (e) { return []; }
}

async function saveCustomersToLocal(customers) {
    try {
        const db = await openDB();
        if (!storeExists(db, 'customers')) return;
        const tx = db.transaction('customers', 'readwrite');
        const store = tx.objectStore('customers');
        await store.clear();
        customers.forEach(c => store.put(c));
        await tx.complete;
    } catch (e) { console.warn('saveCustomersToLocal', e); }
}

async function getLocalCustomers() {
    try {
        const db = await openDB();
        if (!storeExists(db, 'customers')) return [];
        return new Promise((resolve, reject) => {
            const tx = db.transaction('customers', 'readonly');
            const store = tx.objectStore('customers');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    } catch (e) { return []; }
}

async function addPendingSale(saleData) {
    try {
        const db = await openDB();
        if (!storeExists(db, 'pendingSales')) {
            const db2 = await openDB();
            if (!storeExists(db2, 'pendingSales')) {
                throw new Error('pendingSales store غير موجود رغم الترقية');
            }
            return new Promise((resolve, reject) => {
                const tx = db2.transaction('pendingSales', 'readwrite');
                const store = tx.objectStore('pendingSales');
                const entry = { ...saleData, synced: 0, created_at: new Date().toISOString() };
                const request = store.add(entry);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        }
        return new Promise((resolve, reject) => {
            const tx = db.transaction('pendingSales', 'readwrite');
            const store = tx.objectStore('pendingSales');
            const entry = { ...saleData, synced: 0, created_at: new Date().toISOString() };
            const request = store.add(entry);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn('addPendingSale', e);
        throw e;
    }
}

async function getPendingSales() {
    try {
        const db = await openDB();
        if (!storeExists(db, 'pendingSales')) {
            return [];
        }
        return new Promise((resolve, reject) => {
            const tx = db.transaction('pendingSales', 'readonly');
            const store = tx.objectStore('pendingSales');
            const index = store.index('synced');
            const request = index.getAll(0);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn('getPendingSales', e);
        return [];
    }
}

async function markSaleSynced(id) {
    try {
        const db = await openDB();
        if (!storeExists(db, 'pendingSales')) return;
        return new Promise((resolve, reject) => {
            const tx = db.transaction('pendingSales', 'readwrite');
            const store = tx.objectStore('pendingSales');
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const data = getReq.result;
                if (data) { data.synced = 1;
                    store.put(data); }
                resolve();
            };
            getReq.onerror = () => reject(getReq.error);
        });
    } catch (e) { console.warn('markSaleSynced', e); }
}

async function syncPendingSales() {
    if (!navigator.onLine) return 0;
    try {
        const pending = await getPendingSales();
        if (pending.length === 0) return 0;
        let syncedCount = 0;
        for (const sale of pending) {
            try {
                const { id, synced, created_at, ...cleanData } = sale;
                const res = await fetch(`${API}/sales`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(cleanData)
                });
                if (res.ok) {
                    await markSaleSynced(id);
                    syncedCount++;
                }
            } catch (err) { console.error('فشل مزامنة الفاتورة', id, err); }
        }
        return syncedCount;
    } catch (e) { return 0; }
}

function isExpiredProduct(product) {
    if (!product?.expiry_date) return false;
    const value = String(product.expiry_date);
    const date = new Date(value.length <= 10 ? `${formatPosMoney(value)}T23:59:59` : value);
    return !Number.isNaN(date.getTime()) && date.getTime() < Date.now();
}

function canSellBeyondStock(product) {
    return Boolean(saleRules.allowNegativeStock || (saleRules.allowExpiredNegativeSales && isExpiredProduct(product)));
}

function updateSaleRulesSummary() {
    const el = document.getElementById('sale-rules-summary');
    if (!el) return;
    const below = saleRules.allowBelowCost ? 'البيع تحت التكلفة مسموح' : 'البيع تحت التكلفة يتطلب تأكيدًا';
    const negative = saleRules.allowNegativeStock ? 'السالب مسموح لكل المنتجات' : (saleRules.allowExpiredNegativeSales ? 'السالب مسموح للمنتهية فقط' : 'السالب غير مسموح');
    el.innerHTML = `<i class="fas fa-shield-alt"></i> ${below} · ${negative}`;
}

async function loadSaleRules() {
    try {
        const res = await fetch(`${API}/settings`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) throw new Error('settings');
        const data = await res.json();
        const s = data.settings || {};
        saleRules.allowBelowCost = String(s.allow_below_cost) === '1';
        saleRules.allowNegativeStock = String(s.allow_negative_stock) === '1';
        saleRules.allowExpiredNegativeSales = s.allow_expired_negative_sales === undefined || String(s.allow_expired_negative_sales) === '1';
    } catch (e) {
        saleRules.allowBelowCost = localStorage.getItem('allow_below_cost') === '1';
        saleRules.allowNegativeStock = localStorage.getItem('allow_negative_stock') === '1';
    }
    updateSaleRulesSummary();
}

function getCurrencyRate(currencyId) {
    if (!currencyId) return 1;
    const c = currenciesCache.find(cur => cur.id === currencyId);
    if (c && typeof c.rate_to_base === 'number' && isFinite(c.rate_to_base)) {
        return c.rate_to_base;
    }
    return 1;
}

function getCurrencyCode(currencyId) {
    const c = currenciesCache.find(cur => cur.id === currencyId);
    return c ? c.code : 'YER';
}

function convertFromBase(amount, currencyId) {
    if (!currencyId) return amount;
    const rate = getCurrencyRate(currencyId);
    if (!isFinite(rate) || rate <= 0) return amount;
    return amount / rate;
}

function convertToBase(amount, currencyId) {
    if (!currencyId) return amount;
    const rate = getCurrencyRate(currencyId);
    if (!isFinite(rate) || rate <= 0) return amount;
    return amount * rate;
}

async function loadCurrencies() {
    if (navigator.onLine) {
        try {
            const res = await fetch(`${API}/currencies`, { headers: { 'Authorization': `Bearer ${token}` } });
            const data = await res.json();
            currenciesCache = data.currencies || [];
            const db = await openDB();
            if (storeExists(db, 'currencies')) {
                const tx = db.transaction('currencies', 'readwrite');
                const store = tx.objectStore('currencies');
                await store.clear();
                currenciesCache.forEach(c => store.put(c));
                await tx.complete;
            }
            return;
        } catch (err) { console.warn('فشل تحميل العملات من الخادم', err); }
    }
    try {
        const db = await openDB();
        if (!storeExists(db, 'currencies')) { currenciesCache = []; return; }
        const tx = db.transaction('currencies', 'readonly');
        const store = tx.objectStore('currencies');
        const request = store.getAll();
        return new Promise((resolve) => {
            request.onsuccess = () => { currenciesCache = request.result || [];
                resolve(); };
            request.onerror = () => { currenciesCache = [];
                resolve(); };
        });
    } catch (e) { currenciesCache = []; }
}

async function loadWalletsFromServer() {
    if (!navigator.onLine) {
        try {
            const db = await openDB();
            if (!storeExists(db, 'wallets')) { walletsCache = []; return; }
            const tx = db.transaction('wallets', 'readonly');
            const store = tx.objectStore('wallets');
            const request = store.getAll();
            return new Promise((resolve) => {
                request.onsuccess = () => { walletsCache = request.result || [];
                    resolve(); };
                request.onerror = () => { walletsCache = [];
                    resolve(); };
            });
        } catch (e) { walletsCache = []; return; }
    }
    try {
        const res = await fetch(`${API}/wallets`, { headers: { 'Authorization': `Bearer ${token}` } });
        const data = await res.json();
        walletsCache = data.wallets || [];
        const db = await openDB();
        if (storeExists(db, 'wallets')) {
            const tx = db.transaction('wallets', 'readwrite');
            const store = tx.objectStore('wallets');
            await store.clear();
            walletsCache.forEach(w => store.put(w));
            await tx.complete;
        }
    } catch (err) {
        console.warn('فشل تحميل المحافظ من الخادم', err);
        try {
            const db = await openDB();
            if (!storeExists(db, 'wallets')) { walletsCache = []; return; }
            const tx = db.transaction('wallets', 'readonly');
            const store = tx.objectStore('wallets');
            const request = store.getAll();
            return new Promise((resolve) => {
                request.onsuccess = () => { walletsCache = request.result || [];
                    resolve(); };
                request.onerror = () => { walletsCache = [];
                    resolve(); };
            });
        } catch (e) { walletsCache = []; }
    }
}

// ================================================================
//  3. TOAST, LOGOUT, HELPERS
// ================================================================
function showToast(msg, type = 'info') {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', warning: 'fa-exclamation-triangle',
        info: 'fa-info-circle' };
    t.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${msg}`;
    c.appendChild(t);
    setTimeout(() => { t.style.opacity = '0';
        t.style.transform = 'translateX(40px)';
        setTimeout(() => t.remove(), 300); }, 4000);
}

function logout() {
    window.POSPermissions?.recordLogout?.();
    if (confirm('هل أنت متأكد من الخروج؟')) {
        localStorage.removeItem('pos_token');
        window.location.href = 'index.html';
    }
}

function escapeHTML(str) { const d = document.createElement('div');
    d.textContent = str; return d.innerHTML; }

function escapeJS(str) { return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"'); }

// ================================================================
//  4. USER INFO
// ================================================================
function loadCurrentUser() {
    try {
        const parts = token.split('.');
        if (parts.length === 3) {
            const payload = JSON.parse(atob(parts[1]));
            currentUser = { username: payload.username || 'مستخدم', role: payload.role || 'cashier' };
        } else {
            const stored = localStorage.getItem('user_info');
            currentUser = stored ? JSON.parse(stored) : { username: 'مستخدم', role: 'cashier' };
        }
    } catch (e) { currentUser = { username: 'مستخدم', role: 'cashier' }; }
    const avatar = document.getElementById('user-avatar');
    const nameEl = document.getElementById('user-name');
    const roleEl = document.getElementById('user-role');
    if (currentUser) {
        const displayName = currentUser.username || 'مستخدم';
        nameEl.textContent = displayName;
        avatar.textContent = displayName.charAt(0).toUpperCase();
        roleEl.textContent = currentUser.role === 'admin' ? 'مدير' : 'كاشير';
    }
}

// ================================================================
//  5. ONLINE STATUS
// ================================================================
function updateOnlineStatus() {
    isOnline = navigator.onLine;
    const indicator = document.getElementById('online-indicator');
    const label = document.getElementById('status-label');
    if (isOnline) {
        indicator.style.color = 'var(--success)';
        label.textContent = 'متصل';
    } else {
        indicator.style.color = 'var(--danger)';
        label.textContent = 'غير متصل (محلي)';
    }
}

// ================================================================
//  6. PRODUCTS
// ================================================================
async function loadProductsFromLocal() {
    const products = await getLocalProducts();
    if (products.length > 0) {
        productsCache = products;
        renderProductsTable(products);
        return true;
    }
    return false;
}

function sortProducts(products) {
    const sort = currentSort;
    const sorted = [...products];
    if (sort === 'name') {
        sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (sort === 'category') {
        sorted.sort((a, b) => (a.category || '').localeCompare(b.category || ''));
    } else if (sort === 'popularity') {
        sorted.sort((a, b) => (b.sales_count || 0) - (a.sales_count || 0));
    } else if (sort === 'date') {
        sorted.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    } else if (sort === 'supplier') {
        sorted.sort((a, b) => (a.main_supplier_name || '').localeCompare(b.main_supplier_name || ''));
    }
    return sorted;
}

function applyFilters() {
    currentSort = document.getElementById('sort-select').value;
    const search = document.getElementById('search-input').value.trim();
    currentSearch = search;
    fetchProducts(search, selectedCategoryId, currentSort);
}

async function fetchProducts(search = '', categoryId = null, sort = null) {
    if (search !== undefined) currentSearch = search;
    if (categoryId !== undefined) selectedCategoryId = categoryId;
    if (sort !== null) currentSort = sort;
    else sort = currentSort;

    const tbody = document.getElementById('products-table-body');
    const countLabel = document.getElementById('products-count-label');

    if (!navigator.onLine) {
        const localProducts = await getLocalProducts();
        productsCache = localProducts;
        let filtered = localProducts;
        if (currentSearch) {
            filtered = filtered.filter(p =>
                (p.name && p.name.toLowerCase().includes(currentSearch.toLowerCase())) ||
                (p.barcode && p.barcode.includes(currentSearch))
            );
        }
        if (selectedCategoryId) {
            filtered = filtered.filter(p => p.category_id == selectedCategoryId);
        }
        renderProductsTable(filtered);
        countLabel.textContent = `عدد المنتجات المعروضة: ${formatPosQuantity(filtered.length)}`;
        return;
    }

    tbody.innerHTML =
        `<tr><td colspan="5"><div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>جاري التحميل...</p></div></td></tr>`;
    try {
        let url = `${API}/products?limit=3000`;
        if (currentSearch) url += `&search=${encodeURIComponent(currentSearch)}`;
        if (selectedCategoryId) url += `&category_id=${selectedCategoryId}`;
        if (sort) url += `&sort=${encodeURIComponent(sort)}`;
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        const data = await res.json();
        productsCache = data.products || [];
        await saveProductsToLocal(productsCache);
        renderProductsTable(productsCache);
        countLabel.textContent = `عدد المنتجات المعروضة: ${formatPosQuantity(productsCache.length)}`;
    } catch (err) {
        const localProducts = await getLocalProducts();
        productsCache = localProducts;
        renderProductsTable(localProducts);
        countLabel.textContent = `عدد المنتجات المعروضة: ${formatPosQuantity(localProducts.length)} (محلي)`;
        showToast('فشل تحميل المنتجات من الخادم، عرض البيانات المحلية', 'warning');
    }
}

function renderProductsTable(products) {
    const sorted = sortProducts(products);
    const tbody = document.getElementById('products-table-body');
    const countLabel = document.getElementById('products-count-label');
    if (!sorted || sorted.length === 0) {
        tbody.innerHTML =
            `<tr><td colspan="5"><div class="empty-state"><i class="fas fa-box-open"></i><p>لا توجد منتجات</p></div></td></tr>`;
        countLabel.textContent = 'عدد المنتجات المعروضة: 0';
        return;
    }
    tbody.innerHTML = sorted.map(p => {
        const stock = p.stock_quantity || 0;
        let stockClass = 'in-stock',
            stockLabel = `${formatPosQuantity(stock)}`;
        if (stock === 0) { stockClass = 'out-stock';
            stockLabel = 'نفد'; } else if (stock < 5) { stockClass = 'low-stock';
            stockLabel = `${formatPosQuantity(stock)} ⚠️`; }
        const price = (p.price || 0).toFixed(2);
        const codeHtml = p.product_code ? `<span class="prod-code">| كود: ${escapeHTML(p.product_code)}</span>` : '';
        return `
                <tr onclick="quickAddToCart(${p.id})">
                    <td style="text-align:center;" onclick="event.stopPropagation();">
                        <button class="btn-info-row" onclick="event.stopPropagation();showProductDetails(${p.id})"><i class="fas fa-info-circle"></i></button>
                    </td>
                    <td class="col-name">
                        <span class="prod-name">${escapeHTML(p.name || 'بدون اسم')}</span>
                        <span class="prod-barcode">${p.barcode || '---'}</span>
                        <span class="prod-code">الوحدة: ${escapeHTML(p.unit_symbol || p.unit_type || 'قطعة')}${Number(p.is_set) === 1 ? ` • طقم ${p.set_piece_count || 1} قطع` : ''}</span>
                        ${codeHtml}
                    </td>
                    <td><span class="prod-price">${formatPosMoney(price)} ريال</span></td>
                    <td><span class="stock-badge ${stockClass}">${stockLabel}</span></td>
                    <td><button class="btn-add-row" onclick="event.stopPropagation();openAddToCartModal(${p.id})"><i class="fas fa-plus"></i></button></td>
                </tr>
            `;
    }).join('');
    countLabel.textContent = `عدد المنتجات المعروضة: ${formatPosQuantity(sorted.length)}`;
}

function quickAddToCart(productId) {
    const product = productsCache.find(p => p.id === productId);
    if (!product) return showToast('المنتج غير موجود', 'error');
    if (Number(product.is_set) === 1) return openAddToCartModal(productId);
    if ((product.stock_quantity || 0) <= 0 && !canSellBeyondStock(product)) return showToast('⚠️ المنتج غير متوفر', 'warning');
    addToCart(product.id, product.name || 'بدون اسم', product.price || 0, product.cost || 0, 1);
    showToast(`✅ تمت إضافة ${product.name}`, 'success');
}

// ================================================================
//  7. BARCODE SCANNER
// ================================================================
async function handleBarcodeScan() {
    const input = document.getElementById('barcode-input');
    const code = input.value.trim();
    if (!code) return showToast('أدخل الباركود أولاً', 'warning');

    const product = productsCache.find(p => p.barcode === code);
    if (product) {
        const stock = product.stock_quantity || 0;
        if (Number(product.is_set) !== 1 && stock <= 0 && !canSellBeyondStock(product)) {
            showToast('⚠️ المنتج غير متوفر', 'warning');
            input.value = '';
            input.focus();
            return;
        }
        if (Number(product.is_set) === 1) openAddToCartModal(product.id);
        else {
            addToCart(product.id, product.name || 'بدون اسم', product.price || 0, product.cost || 0, 1);
            showToast(`✅ تم إضافة ${product.name}`, 'success');
        }
        input.value = '';
        input.focus();
        document.getElementById('barcode-scanner').classList.add('scan-flash');
        setTimeout(() => document.getElementById('barcode-scanner').classList.remove('scan-flash'), 400);
        return;
    }

    for (const setProduct of productsCache.filter(p => Number(p.is_set) === 1)) {
        try {
            const res = await fetch(`${API}/products/${setProduct.id}/variants`, { headers: { 'Authorization': `Bearer ${token}` } });
            const data = await res.json();
            const variant = (data.variants || []).find(v => String(v.barcode || '') === code && v.id);
            if (variant) {
                if (Number(variant.stock_quantity) <= 0 && !canSellBeyondStock(setProduct)) return showToast('⚠️ المقاس غير متوفر', 'warning');
                openAddToCartModal(setProduct.id, variant.id);
                input.value = '';
                input.focus();
                return;
            }
        } catch (_) { /* نكمل البحث في بقية الأطقم */ }
    }

    const byName = productsCache.find(p => p.name && p.name.includes(code));
    if (byName) {
        if (Number(byName.is_set) === 1) openAddToCartModal(byName.id);
        else {
            addToCart(byName.id, byName.name || 'بدون اسم', byName.price || 0, byName.cost || 0, 1);
            showToast(`✅ تم إضافة ${byName.name}`, 'success');
        }
        input.value = '';
        input.focus();
    } else {
        showToast('❌ لم يتم العثور على منتج أو مقاس', 'error');
        input.select();
    }
}

document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('barcode-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault();
            handleBarcodeScan(); }
    });
    document.getElementById('barcode-input').focus();
});

// ================================================================
//  8. CUSTOMERS
// ================================================================
async function fetchCustomersList() {
    if (!navigator.onLine) {
        const local = await getLocalCustomers();
        customersCache = local;
        return;
    }
    try {
        const res = await fetch(`${API}/customers?limit=2000`, { headers: { 'Authorization': `Bearer ${token}` } });
        const data = await res.json();
        customersCache = data.customers || [];
        await saveCustomersToLocal(customersCache);
    } catch { /* ignore */ }
}

function openCustomerModal() {
    selectedCustomerInModal = selectedCustomerId;
    document.getElementById('customer-search-input').value = '';
    renderCustomerList(customersCache);
    updateCustomerModalConfirmButton();
    openModal('customer-modal');
    setTimeout(() => document.getElementById('customer-search-input').focus(), 200);
}

function searchCustomers(query) {
    const q = query.trim().toLowerCase();
    if (!q) return renderCustomerList(customersCache);
    const filtered = customersCache.filter(c =>
        (c.name && c.name.toLowerCase().includes(q)) || (c.phone && c.phone.includes(q))
    );
    renderCustomerList(filtered);
}

function renderCustomerList(list) {
    const container = document.getElementById('customer-search-list');
    if (!list || list.length === 0) {
        container.innerHTML =
            `<div class="empty-state"><i class="fas fa-users-slash"></i><p>لا يوجد عملاء</p></div>`;
        return;
    }
    container.innerHTML = list.map(c => {
        const isSelected = selectedCustomerInModal === c.id;
        return `
                <div class="cust-option ${formatPosNumber(isSelected ? 'selected' : '')}" onclick="selectCustomerInModal(${c.id}, '${escapeJS(c.name || 'بدون اسم')}')">
                    <span><i class="fas fa-user"></i> ${escapeHTML(c.name || 'بدون اسم')}</span>
                    <span class="cust-phone">${c.phone ? '📞 ' + escapeHTML(c.phone) : ''}</span>
                </div>
            `;
    }).join('');
}

function selectCustomerInModal(id, name) {
    selectedCustomerInModal = id;
    document.querySelectorAll('#customer-search-list .cust-option').forEach(el => el.classList.remove('selected'));
    document.querySelectorAll('#customer-search-list .cust-option').forEach(opt => {
        if (opt.textContent.includes(name)) opt.classList.add('selected');
    });
    updateCustomerModalConfirmButton();
}

function updateCustomerModalConfirmButton() {
    const btn = document.getElementById('confirm-customer-btn');
    btn.disabled = !selectedCustomerInModal;
    btn.textContent = selectedCustomerInModal ? '✅ تأكيد الاختيار' : 'اختر عميلاً';
}

function confirmCustomerSelection() {
    if (selectedCustomerInModal) {
        const customer = customersCache.find(c => c.id === selectedCustomerInModal);
        if (customer) { selectedCustomerId = customer.id;
            selectedCustomerName = customer.name || 'بدون اسم';
            updateCustomerButtonDisplay(); }
    }
    closeModal('customer-modal');
}

function clearCustomer() {
    selectedCustomerId = null;
    selectedCustomerName = '';
    selectedCustomerInModal = null;
    updateCustomerButtonDisplay();
    document.getElementById('confirm-customer-btn').disabled = true;
}

function updateCustomerButtonDisplay() {
    const btnRow = document.getElementById('customer-btn-row');
    const nameSpan = document.getElementById('customer-btn-name');
    if (selectedCustomerId && selectedCustomerName) {
        nameSpan.textContent = selectedCustomerName;
        nameSpan.classList.remove('empty');
        btnRow.classList.add('has-customer');
    } else {
        nameSpan.textContent = 'بدون عميل (اختياري)';
        nameSpan.classList.add('empty');
        btnRow.classList.remove('has-customer');
    }
}

async function quickAddCustomerFromModal() {
    const name = document.getElementById('modal-customer-name').value.trim();
    const phone = document.getElementById('modal-customer-phone').value.trim();
    const address = document.getElementById('modal-customer-address').value.trim();
    if (!name) return showToast('أدخل اسم العميل', 'warning');
    try {
        const res = await fetch(`${API}/customers`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, phone, address, initial_balance: 0 })
        });
        const data = await res.json();
        const newId = data.customer?.id || data.id;
        showToast('✅ تم إضافة العميل', 'success');
        document.getElementById('modal-customer-name').value = '';
        document.getElementById('modal-customer-phone').value = '';
        document.getElementById('modal-customer-address').value = '';
        await fetchCustomersList();
        if (newId) {
            selectedCustomerInModal = newId;
            selectedCustomerId = newId;
            selectedCustomerName = name;
            updateCustomerButtonDisplay();
            updateCustomerModalConfirmButton();
            renderCustomerList(customersCache);
        }
        closeModal('customer-modal');
    } catch (err) {
        showToast('خطأ في الإضافة', 'error');
    }
}

// ================================================================
//  9. MODALS
// ================================================================
function openModal(id) { document.getElementById(id).classList.add('active'); }

function closeModal(id) { document.getElementById(id).classList.remove('active'); }

document.querySelectorAll('.modal-overlay').forEach(el => {
    el.addEventListener('click', function(e) { if (e.target === this) closeModal(this.id); });
});

// ================================================================
//  10. PRODUCT DETAILS MODAL (معدل لعرض رقم التصنيف والموردين)
// ================================================================
async function showProductDetails(productId) {
    const modal = document.getElementById('product-details-modal');
    const content = document.getElementById('product-details-content');
    content.innerHTML = '<div class="text-center"><i class="fas fa-spinner fa-spin"></i> جاري التحميل...</div>';
    openModal('product-details-modal');

    try {
        const productRes = await fetch(`${API}/products/${productId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const productData = await productRes.json();
        const p = productData.product || {};

        const supplierRes = await fetch(`${API}/products/suppliers?product_id=${productId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const supplierData = await supplierRes.json();
        const suppliers = supplierData.suppliers || [];

        let suppliersHtml = '';
        if (suppliers.length === 0) {
            suppliersHtml = '<div class="detail-row"><span class="label">الموردون</span><span class="value">لا يوجد موردون مرتبطون</span></div>';
        } else {
            suppliersHtml = suppliers.map(s => `
                    <div class="detail-row">
                        <span class="label">${escapeHTML(s.name)}</span>
                        <span class="value">كود المورد: ${escapeHTML(s.supplier_sku || '-')} | الكمية: ${formatPosQuantity(s.quantity)} | آخر سعر شراء: ${formatPosMoney((s.last_purchase_price || 0))}</span>
                    </div>
                `).join('');
        }

        content.innerHTML = `
                <div class="detail-row"><span class="label">الاسم</span><span class="value">${escapeHTML(p.name || 'بدون اسم')}</span></div>
                <div class="detail-row"><span class="label">رقم التصنيف (SKU)</span><span class="value">${p.product_code || '---'}</span></div>
                <div class="detail-row"><span class="label">الباركود</span><span class="value">${p.barcode || '---'}</span></div>
                <div class="detail-row"><span class="label">وحدة القياس</span><span class="value">${escapeHTML(p.unit_symbol || p.unit_type || 'قطعة')}</span></div>
                ${Number(p.is_set) ? `<div class="detail-row"><span class="label">مقاسات الطقم</span><span class="value">${(p.variants && p.variants.length ? p.variants : parseSetDetails(p.set_details_json).map(d => ({label:d.label||d.size||d.name,stock_quantity:0}))).map(v => `${escapeHTML(v.label)} — المتاح ${formatPosQuantity(v.stock_quantity || 0)} — ${formatPosMoney(v.selling_price ?? p.price ?? 0)} ريال`).join('<br>')}</span></div>` : ''}
                <div class="detail-row"><span class="label">سعر البيع</span><span class="value">${formatPosMoney((p.price || 0))} ريال</span></div>
                <div class="detail-row"><span class="label">سعر التكلفة</span><span class="value">${formatPosMoney((p.cost || 0))} ريال</span></div>
                <div class="detail-row"><span class="label">المخزون</span><span class="value">${formatPosQuantity(p.stock_quantity || 0)}</span></div>
                <div style="border-top: 2px solid var(--border); padding-top: 8px; margin-top: 8px;">
                    <h4 style="font-size: 0.9rem; font-weight: 700; margin-bottom: 8px;"><i class="fas fa-truck"></i> الموردون</h4>
                    ${suppliersHtml}
                </div>
                <div class="modal-actions">
                    <button class="btn btn-outline" onclick="closeModal('product-details-modal')">إغلاق</button>
                    <button class="btn btn-success" onclick="closeModal('product-details-modal');openAddToCartModal(${p.id})">إضافة للسلة</button>
                </div>
            `;
    } catch (err) {
        content.innerHTML = `<p class="text-danger">فشل تحميل التفاصيل: ${err.message}</p>`;
    }
}

// ================================================================
//  11. ADD TO CART MODAL
// ================================================================
let currentProductForCart = null;

let currentSaleVariant = null;
let currentSaleMode = 'size';
async function openAddToCartModal(productId, preselectedVariantId = null) {
    const product = productsCache.find(p => p.id === productId);
    if (!product) return showToast('المنتج غير موجود', 'error');
    currentProductForCart = product;
    currentSaleVariant = null;
    currentSaleMode = Number(product.is_set) === 1 ? '' : 'single';
    const content = document.getElementById('add-to-cart-content');
    const cost = Number(product.cost) || 0;
    const name = product.name || 'بدون اسم';
    let variants = [];
    if (Number(product.is_set) === 1) {
        try {
            const res = await fetch(`${API}/products/${product.id}/variants`, { headers: { 'Authorization': `Bearer ${token}` } });
            const data = await res.json();
            variants = (data.variants || []).filter(v => v.id);
        } catch (_) { return showToast('تعذر تحميل مقاسات الطقم', 'error'); }
        if (!variants.length) return showToast('عرّف المقاسات ثم احفظ المنتج لتهيئة مخزون كل مقاس قبل البيع', 'warning');
    }
    window.currentSaleVariants = variants;
    const stock = Number(product.stock_quantity) || 0;
    const defaultPrice = Number(product.price) || 0;
    const modeHtml = Number(product.is_set) === 1 ? `<div class="form-group"><label>طريقة البيع</label><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;"><button type="button" id="sale-mode-full" class="btn btn-outline" onclick="selectSaleMode('full_set')">بيع الطقم كاملًا<br><strong>${formatPosMoney(defaultPrice)} ريال</strong></button><button type="button" id="sale-mode-size" class="btn btn-outline" onclick="selectSaleMode('size')">بيع مقاس واحد</button></div></div>` : '';
    const variantHtml = Number(product.is_set) === 1 ? `<div id="sale-variant-container" class="form-group" style="display:none;"><label>اختر المقاس</label><div id="sale-variant-options" style="display:grid;gap:6px;">${variants.map((v, i) => `<button type="button" class="btn btn-outline sale-variant-option" data-index="${i}" onclick="selectSaleVariant(${i})"><strong>${escapeHTML(v.label)}</strong> — مخزون ${formatPosQuantity(v.stock_quantity)} — ${formatPosMoney(v.selling_price ?? defaultPrice)} ريال</button>`).join('')}</div></div>` : '';
    content.innerHTML = `<div style="text-align:center;margin-bottom:10px;"><strong style="font-size:1.05rem;">${escapeHTML(name)}</strong><div style="font-size:0.8rem;color:var(--muted);">سعر التكلفة: <span id="modal-sale-cost">${formatPosMoney(cost)}</span> ريال</div></div>${Number(product.is_set) === 1 ? '' : `<div class="stock-info"><span>المخزون المتاح</span><span class="stock-value">${formatPosQuantity(stock)}${isExpiredProduct(product) ? ' · منتهي الصلاحية' : ''}</span></div>`}${modeHtml}${variantHtml}<div class="form-group"><label>سعر البيع (للفاتورة الحالية)</label><input type="number" id="modal-sale-price" class="input-field" step="0.01" value="${defaultPrice}" min="0" /><div id="price-warning" class="warning-text">⚠️ السعر أقل من سعر التكلفة</div></div><div class="form-group"><label>الكمية</label><input type="number" id="modal-quantity" class="input-field" step="${Number(product.is_decimal_allowed) === 1 ? '0.001' : '1'}" value="1" min="${Number(product.is_decimal_allowed) === 1 ? '0.001' : '1'}" max="${canSellBeyondStock(product) ? 999999 : Math.max(1, Number(product.is_set) === 1 ? 0 : stock)}" /></div><div class="modal-actions"><button class="btn btn-outline" onclick="closeModal('add-to-cart-modal')">إلغاء</button><button class="btn btn-success" onclick="confirmAddToCart()">إضافة</button></div>`;
    const priceInput = document.getElementById('modal-sale-price');
    const warning = document.getElementById('price-warning');
    priceInput.addEventListener('input', () => warning.classList.toggle('active', (parseFloat(priceInput.value) || 0) < (currentSaleVariant ? Number(currentSaleVariant.cost ?? cost) : cost)));
    if (Number(product.is_set) !== 1 && defaultPrice < cost) warning.classList.add('active');
    openModal('add-to-cart-modal');
    if (preselectedVariantId && variants.length) {
        const selectedIndex = variants.findIndex(v => Number(v.id) === Number(preselectedVariantId));
        if (selectedIndex >= 0) selectSaleVariant(selectedIndex);
    }
}

function selectSaleMode(mode) {
    const product = currentProductForCart;
    if (!product || Number(product.is_set) !== 1) return;
    currentSaleMode = mode;
    currentSaleVariant = null;
    document.getElementById('sale-mode-full')?.classList.toggle('btn-success', mode === 'full_set');
    document.getElementById('sale-mode-size')?.classList.toggle('btn-success', mode === 'size');
    const container = document.getElementById('sale-variant-container');
    if (container) container.style.display = mode === 'size' ? 'block' : 'none';
    const priceInput = document.getElementById('modal-sale-price');
    const cost = Number(product.cost) || 0;
    if (mode === 'full_set') {
        const available = Math.min(...(window.currentSaleVariants || []).map(v => Number(v.stock_quantity) || 0));
        priceInput.value = Number(product.price) || 0;
        document.getElementById('modal-sale-cost').textContent = formatPosMoney(cost);
        document.getElementById('modal-quantity').max = canSellBeyondStock(product) ? 999999 : Math.max(1, available);
        document.getElementById('price-warning').classList.toggle('active', Number(priceInput.value) < cost);
    } else {
        priceInput.value = Number(product.price) || 0;
        document.getElementById('modal-quantity').max = 1;
    }
}

function selectSaleVariant(index) {
    const product = currentProductForCart;
    const variant = (window.currentSaleVariants || [])[index];
    if (!product || !variant) return;
    currentSaleMode = 'size';
    currentSaleVariant = variant;
    document.getElementById('sale-mode-size')?.classList.add('btn-success');
    document.getElementById('sale-mode-full')?.classList.remove('btn-success');
    document.querySelectorAll('.sale-variant-option').forEach((button, i) => button.classList.toggle('btn-success', i === index));
    const cost = Number(variant.cost ?? product.cost) || 0;
    const price = Number(variant.selling_price ?? product.price) || 0;
    document.getElementById('modal-sale-price').value = price;
    document.getElementById('modal-sale-cost').textContent = formatPosMoney(cost);
    document.getElementById('modal-quantity').max = canSellBeyondStock(product) ? 999999 : Math.max(1, Number(variant.stock_quantity) || 0);
    document.getElementById('price-warning').classList.toggle('active', price < cost);
}

function confirmAddToCart() {
    const price = parseFloat(document.getElementById('modal-sale-price').value) || 0;
    const qty = parseFloat(document.getElementById('modal-quantity').value) || 1;
    const product = currentProductForCart;
    if (!product) return;
    const isSet = Number(product.is_set) === 1;
    const isWholeSet = isSet && currentSaleMode === 'full_set';
    const variant = isSet && !isWholeSet ? currentSaleVariant : null;
    if (isSet && !isWholeSet && !variant) return showToast('اختر مقاس الطقم أولاً', 'warning');
    if (isSet && !isWholeSet && currentSaleMode !== 'size') return showToast('اختر بيع الطقم كاملًا أو مقاسًا واحدًا', 'warning');
    const stock = isWholeSet ? Math.min(...(window.currentSaleVariants || []).map(v => Number(v.stock_quantity) || 0)) : (variant ? Number(variant.stock_quantity) || 0 : Number(product.stock_quantity) || 0);
    if (qty <= 0) return showToast('الكمية يجب أن تكون أكبر من صفر', 'warning');
    if (Number(product.is_decimal_allowed) !== 1 && !Number.isInteger(qty)) return showToast('هذا المنتج لا يسمح بالكمية العشرية', 'warning');
    if (qty > stock && !canSellBeyondStock(product)) return showToast(`الكمية المطلوبة (${formatPosQuantity(qty)}) أكبر من المخزون (${formatPosQuantity(stock)})`, 'warning');
    const cost = isWholeSet ? (Number(product.cost) || 0) : (Number(variant?.cost ?? product.cost) || 0);
    if (price < cost && !saleRules.allowBelowCost) return showToast('لا يمكن البيع بأقل من التكلفة', 'warning');
    addToCart(product.id, product.name || 'بدون اسم', price, cost, qty, variant?.id || null, isWholeSet ? 'طقم كامل' : (variant?.label || null), stock, isWholeSet ? 'full_set' : 'size');
    closeModal('add-to-cart-modal');
    showToast(`✅ تم إضافة ${product.name}${isWholeSet ? ' — طقم كامل' : ` — مقاس ${variant.label}`} (${formatPosQuantity(qty)})`, 'success');
}

// ================================================================
//  12. EDIT CART ITEM MODAL
// ================================================================
let editingCartIndex = -1;

function openEditCartItemModal(index) {
    const item = cart[index];
    if (!item) return;
    editingCartIndex = index;
    const product = productsCache.find(p => p.id === item.id);
    const stock = product ? product.stock_quantity || 0 : 999;
    const content = document.getElementById('edit-cart-item-content');
    content.innerHTML = `
                <div style="text-align:center;margin-bottom:10px;">
                    <strong style="font-size:1.05rem;">${escapeHTML(item.name || 'بدون اسم')}</strong>
                    <div style="font-size:0.8rem;color:var(--muted);">سعر التكلفة: ${formatPosMoney((item.cost || 0))} ريال</div>
                </div>
                <div class="stock-info"><span>المخزون المتاح</span><span class="stock-value">${formatPosQuantity(stock)}${isExpiredProduct(product) ? ' · منتهي الصلاحية' : ''}</span></div>
                <div class="form-group">
                    <label>سعر البيع</label>
                    <input type="number" id="edit-sale-price" class="input-field" step="0.01" value="${item.price}" min="0" />
                    <div id="edit-price-warning" class="warning-text">⚠️ السعر أقل من التكلفة (${formatPosMoney((item.cost || 0))} ريال)</div>
                </div>
                <div class="form-group">
                    <label>الكمية</label>
                    <input type="number" id="edit-quantity" class="input-field" step="${Number(product?.is_decimal_allowed) === 1 ? '0.001' : '1'}" value="${item.quantity}" min="${Number(product?.is_decimal_allowed) === 1 ? '0.001' : '1'}" max="${canSellBeyondStock(product) ? 999999 : Math.max(1, stock)}" />
                </div>
                <div class="form-group">
                    <label>خصم هذا المنتج</label>
                    <input type="number" id="edit-item-discount" class="input-field" step="0.01" value="${Number(item.discount || 0)}" min="0" />
                </div>
                <div class="form-group">
                    <label>ملاحظة المنتج</label>
                    <input type="text" id="edit-item-notes" class="input-field" value="${escapeHTML(item.notes || item.note || '')}" placeholder="ملاحظة تظهر في الفاتورة" />
                </div>
                <div class="modal-actions">
                    <button class="btn btn-outline" onclick="closeModal('edit-cart-item-modal')">إلغاء</button>
                    <button class="btn btn-primary" onclick="confirmEditCartItem()">تحديث</button>
                    <button class="btn btn-danger" onclick="removeItem(${index});closeModal('edit-cart-item-modal')">حذف</button>
                </div>
            `;
    const priceInput = document.getElementById('edit-sale-price');
    const warning = document.getElementById('edit-price-warning');
    const cost = item.cost || 0;
    priceInput.addEventListener('input', function() {
        const val = parseFloat(this.value) || 0;
        if (val < cost && val > 0) warning.classList.add('active');
        else warning.classList.remove('active');
    });
    if (item.price < cost) warning.classList.add('active');
    openModal('edit-cart-item-modal');
}

function confirmEditCartItem() {
    const priceInput = document.getElementById('edit-sale-price');
    const qtyInput = document.getElementById('edit-quantity');
    const discountInput = document.getElementById('edit-item-discount');
    const notesInput = document.getElementById('edit-item-notes');
    const price = parseFloat(priceInput.value) || 0;
    const qty = parseFloat(qtyInput.value) || 1;
    const discount = Math.max(0, parseFloat(discountInput?.value) || 0);
    const notes = notesInput?.value.trim() || '';
    const index = editingCartIndex;
    if (index < 0 || index >= cart.length) return showToast('خطأ في التعديل', 'error');
    const item = cart[index];
    const product = productsCache.find(p => p.id === item.id);
    const stock = product ? product.stock_quantity || 0 : 999;
    if (qty <= 0) return showToast('الكمية يجب أن تكون أكبر من صفر', 'warning');
    if (product && Number(product.is_decimal_allowed) !== 1 && !Number.isInteger(qty)) return showToast('هذا المنتج لا يسمح بالكمية العشرية', 'warning');
    if (qty > stock && !canSellBeyondStock(product)) return showToast(`الكمية المطلوبة (${formatPosQuantity(qty)}) أكبر من المخزون (${formatPosQuantity(stock)})`, 'warning');
    if (discount > price) return showToast('خصم المنتج لا يمكن أن يتجاوز سعر البيع', 'warning');
    const cost = item.cost || 0;
    if ((price - discount) < cost && !saleRules.allowBelowCost) {
        if (!confirm(`⚠️ السعر بعد الخصم (${formatPosMoney(price - discount)}) أقل من سعر التكلفة (${formatPosMoney(cost)}). هل تريد المتابعة؟`)) return;
    }
    cart[index].price = price;
    cart[index].quantity = qty;
    cart[index].discount = discount;
    cart[index].notes = notes;
    renderCart();
    closeModal('edit-cart-item-modal');
    showToast(`✅ تم تحديث ${item.name}`, 'success');
}

// ================================================================
//  13. CART
// ================================================================
function saveCartToLocal() {
    try { localStorage.setItem('pos_cart', JSON.stringify(cart)); } catch (e) { /* ignore */ }
    scheduleSaleDraftAutoSave();
}

function scheduleSaleDraftAutoSave() {
    if (!cart.length || editInvoiceId) return;
    clearTimeout(saleDraftTimer);
    saleDraftTimer = setTimeout(() => saveSaleDraft(true), 1000);
}

function getSaleDraftSnapshot() {
    return { cart: JSON.parse(JSON.stringify(cart)), customerId: selectedCustomerId, customerName: selectedCustomerName,
        discount: document.getElementById('cart-discount')?.value || 0, discountType: document.getElementById('discount-type')?.value || 'fixed',
        payment: document.getElementById('payment-method')?.value || 'cash', created_at: new Date().toISOString() };
}

function saveSaleDraft(isAuto = false) {
    if (!cart.length) return isAuto ? null : showToast('السلة فارغة، لا توجد مسودة للحفظ', 'warning');
    const drafts = JSON.parse(localStorage.getItem('pos_sale_drafts') || '[]');
    const existing = drafts.find(d => d.id === window.activeSaleDraftId);
    const draft = { id: existing?.id || Date.now(), ...getSaleDraftSnapshot() };
    const next = drafts.filter(d => d.id !== draft.id); next.unshift(draft);
    localStorage.setItem('pos_sale_drafts', JSON.stringify(next.slice(0, 30)));
    window.activeSaleDraftId = draft.id;
    if (!isAuto) showToast('تم حفظ مسودة البيع محليًا', 'success');
}

function openSaleDrafts() {
    const drafts = JSON.parse(localStorage.getItem('pos_sale_drafts') || '[]');
    if (!drafts.length) return showToast('لا توجد مسودات بيع', 'info');
    const list = drafts.map(d => `<div class="card" style="margin:8px 0;display:flex;justify-content:space-between;gap:8px;align-items:center;"><span>${posDateTime(d.created_at)} · ${formatPosQuantity(d.cart.length)} أصناف</span><button class="btn btn-sm btn-primary" onclick="loadSaleDraft(${d.id})">استرجاع</button></div>`).join('');
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay active'; overlay.id = 'saleDraftOverlay';
    overlay.innerHTML = `<div class="modal-box"><div class="modal-header"><h3>مسودات البيع</h3><button class="close-btn" onclick="this.closest('.modal-overlay').remove()">×</button></div>${list}</div>`;
    document.body.appendChild(overlay);
}

function loadSaleDraft(id) {
    const drafts = JSON.parse(localStorage.getItem('pos_sale_drafts') || '[]');
    const d = drafts.find(item => item.id === id); if (!d) return;
    cart = d.cart || []; selectedCustomerId = d.customerId || null; selectedCustomerName = d.customerName || '';
    document.getElementById('cart-discount').value = d.discount || 0; document.getElementById('discount-type').value = d.discountType || 'fixed';
    document.getElementById('payment-method').value = d.payment || 'cash';
    window.activeSaleDraftId = d.id; renderCart(); updateTotals(); document.getElementById('saleDraftOverlay')?.remove(); showToast('تم استرجاع مسودة البيع', 'success');
}

function printSaleReport() {
    const root = document.querySelector('.main-content') || document.querySelector('main');
    if (!root || !window.POSDocs) return showToast('تعذر تجهيز صفحة البيع للطباعة', 'error');
    POSDocs.printReport(root, { title: 'تقرير المبيعات' }).catch(e => showToast(e.message, 'error'));
}

async function exportSalesCSV() {
    try {
        const res = await fetch(`${API}/sales?limit=1000&sort=desc`, { headers: { 'Authorization': `Bearer ${token}` } });
        const data = await res.json(); const rows = data.sales || data.invoices || data;
        if (!Array.isArray(rows) || !rows.length) return showToast('لا توجد مبيعات للتصدير', 'warning');
        const keys = ['id','invoice_number','created_at','total_amount','payment_method','status'];
        const csv = '\ufeff' + [keys, ...rows.map(r => keys.map(k => r[k] ?? ''))].map(row => row.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\\n');
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8'})); a.download = `المبيعات-${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
        showToast('تم تصدير سجل المبيعات', 'success');
    } catch (e) { showToast('تعذر تصدير المبيعات', 'error'); }
}

function loadCartFromLocal() {
    try {
        const saved = localStorage.getItem('pos_cart');
        if (saved) {
            cart = JSON.parse(saved);
            cart = cart.filter(item => item.id && item.name && typeof item.price === 'number');
        }
    } catch (e) { cart = []; }
    renderCart();
}

function addToCart(id, name, price, cost, quantity = 1, variantId = null, variantLabel = null, variantStock = null, saleMode = 'size') {
    const existing = cart.find(i => i.id === id && Number(i.variant_id || 0) === Number(variantId || 0) && (i.sale_mode || 'size') === saleMode);
    const product = productsCache.find(p => p.id === id);
    if (product && price < (cost || 0) && !saleRules.allowBelowCost) {
        if (!confirm(`⚠️ السعر أقل من التكلفة للمنتج ${name}. هل تريد المتابعة؟`)) return;
    }
    if (existing && variantId && variantStock !== null && variantStock !== undefined && existing.quantity + quantity > Number(variantStock) && !canSellBeyondStock(product)) {
        return showToast(`الكمية المطلوبة للمقاس ${variantLabel || ''} أكبر من المخزون`, 'warning');
    }
    if (existing) { existing.quantity += quantity;
        existing.price = price;
        existing.cost = cost;
        existing.expiry_date = product?.expiry_date || existing.expiry_date || null;
        existing.unit_type = product?.unit_type || existing.unit_type || 'piece'; existing.unit_symbol = product?.unit_symbol || existing.unit_symbol || 'قطعة';
        existing.is_set = Number(product?.is_set) === 1; existing.set_piece_count = Number(product?.set_piece_count || existing.set_piece_count || 1); existing.set_details_json = product?.set_details_json || existing.set_details_json || '[]'; existing.variant_id = variantId || existing.variant_id || null; existing.variant_label = variantLabel || existing.variant_label || null; existing.variant_stock = variantStock ?? existing.variant_stock; existing.sale_mode = saleMode;
    } else { cart.push({ id, name, price, cost, quantity, variant_id: variantId || null, variant_label: variantLabel || null, variant_stock: variantStock, sale_mode: saleMode, expiry_date: product?.expiry_date || null, unit_type: product?.unit_type || 'piece', unit_symbol: product?.unit_symbol || 'قطعة', is_set: Number(product?.is_set) === 1, set_piece_count: Number(product?.set_piece_count || 1), set_details_json: product?.set_details_json || '[]' }); }
    saveCartToLocal();
    renderCart();
    document.getElementById('barcode-input').focus();
}

function changeQty(index, delta) {
    const item = cart[index];
    const product = productsCache.find(p => p.id === item.id);
    const stock = item.sale_mode === 'full_set' ? (Number(item.variant_stock) || 0) : (item.variant_id ? (Number(item.variant_stock) || 0) : (product ? product.stock_quantity || 0 : 999));
    const newQty = item.quantity + delta;
    if (newQty < 1) { cart.splice(index, 1);
        saveCartToLocal();
        renderCart(); return; }
    if (newQty > stock && !canSellBeyondStock(product)) return showToast(`الكمية المطلوبة (${formatPosQuantity(newQty)}) أكبر من المخزون (${formatPosQuantity(stock)})`, 'warning');
    item.quantity = newQty;
    saveCartToLocal();
    renderCart();
}

function removeItem(index) {
    cart.splice(index, 1);
    saveCartToLocal();
    renderCart();
}

function parseSetDetails(value) { try { const v = Array.isArray(value) ? value : JSON.parse(value || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
function renderCart() {
    const container = document.getElementById('cart-items');
    const countEl = document.getElementById('cart-count');
    if (cart.length === 0) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-shopping-bag"></i><p>السلة فارغة</p></div>`;
        countEl.textContent = '0';
        updateTotals();
        return;
    }
    countEl.textContent = cart.reduce((s, i) => s + i.quantity, 0);
    container.innerHTML = cart.map((item, i) => {
        const itemDiscount = Number(item.discount || 0);
        const effectivePrice = Math.max(0, (item.price || 0) - itemDiscount);
        const total = (effectivePrice * item.quantity).toFixed(2);
        const discountHtml = itemDiscount > 0 ? `<small style="display:block;color:var(--danger);">خصم: ${formatPosMoney(itemDiscount)}</small>` : '';
        const notesHtml = item.notes ? `<small style="display:block;color:var(--muted);">ملاحظة: ${escapeHTML(item.notes)}</small>` : '';
        return `
                <div class="cart-item" onclick="openEditCartItemModal(${i})">
                    <div class="item-info"><span class="item-name">${escapeHTML(item.name || 'بدون اسم')}</span>
                    <span class="item-price">${formatPosMoney(effectivePrice)} ريال · ${escapeHTML(item.unit_symbol || 'قطعة')} ${discountHtml}${notesHtml}</span>
                    ${Number(item.is_set) ? `<small class="set-summary">${item.sale_mode === 'full_set' ? 'طقم كامل' : `المقاس: <strong>${escapeHTML(item.variant_label || 'غير محدد')}</strong>`}${item.variant_stock !== null && item.variant_stock !== undefined ? ` · المخزون عند الإضافة: ${formatPosQuantity(item.variant_stock)}` : ''}</small>` : ''}</div>
                    <div class="qty-control" onclick="event.stopPropagation();">
                        <button onclick="changeQty(${i}, -1)">−</button>
                        <span class="qty-num">${formatPosQuantity(item.quantity)}</span>
                        <button onclick="changeQty(${i}, 1)">+</button>
                    </div>
                    <span class="item-total">${formatPosMoney(total)} ريال</span>
                    <button class="item-remove" onclick="event.stopPropagation();removeItem(${i})"><i class="fas fa-trash-alt"></i></button>
                </div>
            `;
    }).join('');
    updateTotals();
}

// ================================================================
//  13.1 TOTALS & PAYMENT LOGIC
// ================================================================
function updateTotals() {
    if (updatingDiscountFromPaid || updatingMixedFromCash || updatingMixedFromWallet) return;

    if (cart.length === 0) {
        document.getElementById('cart-total').innerHTML = '0.00 ريال';
        document.getElementById('cart-cost-total').innerText = '0.00 ريال';
        document.getElementById('cart-profit').innerText = '0.00 ريال';
        document.getElementById('paid-amount').value = '0';
        return;
    }

    const subtotal = cart.reduce((s, i) => s + (i.price || 0) * i.quantity, 0);
    const totalCost = cart.reduce((s, i) => s + (i.cost || 0) * i.quantity, 0);
    const discount = parseFloat(document.getElementById('cart-discount').value) || 0;
    const discountType = document.getElementById('discount-type').value;
    let discountAmount = discountType === 'percentage' ? subtotal * (discount / 100) : discount;
    const total = Math.max(0, subtotal - discountAmount);

    document.getElementById('cart-total').innerHTML = `${formatPosMoney(total)} ريال`;
    document.getElementById('cart-cost-total').innerText = formatPosMoney(totalCost, 2) + ' ريال';
    document.getElementById('cart-profit').innerText = formatPosMoney((total - totalCost), 2) + ' ريال';

    const paymentMethod = document.getElementById('payment-method').value;
    if (paymentMethod === 'cash' || paymentMethod === 'wallet') {
        const paidInput = document.getElementById('paid-amount');
        if (!updatingPaidFromDiscount) {
            const currencyId = paymentMethod === 'cash' ?
                parseInt(document.getElementById('cash-currency-select').value) :
                parseInt(document.getElementById('wallet-currency-select').value);
            if (currencyId) {
                const converted = convertFromBase(total, currencyId);
                if (isFinite(converted)) {
                    paidInput.value = converted.toFixed(2);
                } else {
                    paidInput.value = total.toFixed(2);
                }
            } else {
                paidInput.value = total.toFixed(2);
            }
            document.getElementById('paid-currency-label').textContent = currencyId ? getCurrencyCode(currencyId) :
                'ريال';
        }
    }
    updateRateDisplays();
    if (paymentMethod === 'mixed') {
        updateMixedDueAmounts();
    }
}

function updateTotalsFromPaid() {
    const paymentMethod = document.getElementById('payment-method').value;
    if (paymentMethod === 'mixed') return;

    const paidInput = document.getElementById('paid-amount');
    const paid = parseFloat(paidInput.value) || 0;
    if (!isFinite(paid)) return;

    const subtotal = cart.reduce((s, i) => s + (i.price || 0) * i.quantity, 0);
    const currencyId = paymentMethod === 'cash' ?
        parseInt(document.getElementById('cash-currency-select').value) :
        parseInt(document.getElementById('wallet-currency-select').value);
    let paidInBase = paid;
    if (currencyId) {
        paidInBase = convertToBase(paid, currencyId);
        if (!isFinite(paidInBase)) paidInBase = paid;
    }
    let newDiscount = subtotal - paidInBase;
    if (newDiscount < 0) newDiscount = 0;

    updatingDiscountFromPaid = true;
    document.getElementById('cart-discount').value = newDiscount.toFixed(2);
    updateTotals();
    updatingDiscountFromPaid = false;
    updatingPaidFromDiscount = false;
}

function updateTotalsFromPaidMixed() {
    if (updatingMixedFromCash || updatingMixedFromWallet) return;
    if (cart.length === 0) return;

    const cashInput = document.getElementById('cash-paid');
    const walletInput = document.getElementById('wallet-paid');
    let cashPaid = parseFloat(cashInput.value) || 0;
    let walletPaid = parseFloat(walletInput.value) || 0;

    if (!isFinite(cashPaid)) cashPaid = 0;
    if (!isFinite(walletPaid)) walletPaid = 0;

    const subtotal = cart.reduce((s, i) => s + (i.price || 0) * i.quantity, 0);
    const discount = parseFloat(document.getElementById('cart-discount').value) || 0;
    const discountType = document.getElementById('discount-type').value;
    let discountAmount = discountType === 'percentage' ? subtotal * (discount / 100) : discount;
    const totalDue = Math.max(0, subtotal - discountAmount);

    if (totalDue <= 0) return;

    const cashCurrencyId = parseInt(document.getElementById('mixed-cash-currency').value);
    const walletCurrencyId = parseInt(document.getElementById('mixed-wallet-currency').value);
    const cashRate = getCurrencyRate(cashCurrencyId);
    const walletRate = getCurrencyRate(walletCurrencyId);

    if (!isFinite(cashRate) || !isFinite(walletRate) || cashRate <= 0 || walletRate <= 0) {
        console.warn('أسعار صرف غير صالحة:', cashRate, walletRate);
        return;
    }

    let cashInBase = cashPaid * cashRate;
    let walletInBase = walletPaid * walletRate;
    let totalPaidInBase = cashInBase + walletInBase;

    const tolerance = 0.01;

    if (Math.abs(totalPaidInBase - totalDue) <= tolerance) {
        let newDiscount = subtotal - totalPaidInBase;
        if (newDiscount < 0) newDiscount = 0;
        updatingDiscountFromPaid = true;
        document.getElementById('cart-discount').value = newDiscount.toFixed(2);
        updateTotals();
        updatingDiscountFromPaid = false;
        return;
    }

    if (cashPaid === 0 && walletPaid === 0) return;

    if (cashPaid > 0 && Math.abs(totalPaidInBase - totalDue) > tolerance) {
        let remainingInBase = Math.max(0, totalDue - cashInBase);
        let newWalletPaid = remainingInBase / walletRate;
        if (isFinite(newWalletPaid) && newWalletPaid >= 0) {
            updatingMixedFromWallet = true;
            walletInput.value = newWalletPaid.toFixed(2);
            updatingMixedFromWallet = false;
            walletPaid = newWalletPaid;
            walletInBase = walletPaid * walletRate;
            totalPaidInBase = cashInBase + walletInBase;
        }
    } else if (walletPaid > 0 && Math.abs(totalPaidInBase - totalDue) > tolerance) {
        let remainingInBase = Math.max(0, totalDue - walletInBase);
        let newCashPaid = remainingInBase / cashRate;
        if (isFinite(newCashPaid) && newCashPaid >= 0) {
            updatingMixedFromCash = true;
            cashInput.value = newCashPaid.toFixed(2);
            updatingMixedFromCash = false;
            cashPaid = newCashPaid;
            cashInBase = cashPaid * cashRate;
            totalPaidInBase = cashInBase + walletInBase;
        }
    }

    if (totalPaidInBase > totalDue + tolerance) {
        let excessInBase = totalPaidInBase - totalDue;
        if (cashPaid > 0) {
            let newCashInBase = Math.max(0, cashInBase - excessInBase);
            let newCashPaid = newCashInBase / cashRate;
            if (isFinite(newCashPaid) && newCashPaid >= 0) {
                updatingMixedFromCash = true;
                cashInput.value = newCashPaid.toFixed(2);
                updatingMixedFromCash = false;
                cashPaid = newCashPaid;
                cashInBase = cashPaid * cashRate;
                totalPaidInBase = cashInBase + walletInBase;
            }
        } else if (walletPaid > 0) {
            let newWalletInBase = Math.max(0, walletInBase - excessInBase);
            let newWalletPaid = newWalletInBase / walletRate;
            if (isFinite(newWalletPaid) && newWalletPaid >= 0) {
                updatingMixedFromWallet = true;
                walletInput.value = newWalletPaid.toFixed(2);
                updatingMixedFromWallet = false;
                walletPaid = newWalletPaid;
                walletInBase = walletPaid * walletRate;
                totalPaidInBase = cashInBase + walletInBase;
            }
        }
    }

    let newDiscount = subtotal - totalPaidInBase;
    if (newDiscount < 0) newDiscount = 0;
    updatingDiscountFromPaid = true;
    document.getElementById('cart-discount').value = newDiscount.toFixed(2);
    updateTotals();
    updatingDiscountFromPaid = false;

    updateMixedDueAmounts();
}

function updateMixedDueAmounts() {
    const subtotal = cart.reduce((s, i) => s + (i.price || 0) * i.quantity, 0);
    const discount = parseFloat(document.getElementById('cart-discount').value) || 0;
    const discountType = document.getElementById('discount-type').value;
    let discountAmount = discountType === 'percentage' ? subtotal * (discount / 100) : discount;
    const totalDue = Math.max(0, subtotal - discountAmount);

    const cashCurrencyId = parseInt(document.getElementById('mixed-cash-currency').value);
    const walletCurrencyId = parseInt(document.getElementById('mixed-wallet-currency').value);
    const cashRate = getCurrencyRate(cashCurrencyId);
    const walletRate = getCurrencyRate(walletCurrencyId);

    const cashPaid = parseFloat(document.getElementById('cash-paid').value) || 0;
    const walletPaid = parseFloat(document.getElementById('wallet-paid').value) || 0;

    let cashDue = 0,
        walletDue = 0;

    if (cashPaid === 0 && walletPaid === 0) {
        cashDue = totalDue / cashRate;
        walletDue = 0;
    } else if (cashPaid === 0) {
        walletDue = totalDue / walletRate;
        cashDue = 0;
    } else if (walletPaid === 0) {
        cashDue = totalDue / cashRate;
        walletDue = 0;
    } else {
        let totalPaidInBase = (cashPaid * cashRate) + (walletPaid * walletRate);
        if (totalPaidInBase > 0) {
            let cashRatio = (cashPaid * cashRate) / totalPaidInBase;
            let walletRatio = (walletPaid * walletRate) / totalPaidInBase;
            cashDue = (totalDue * cashRatio) / cashRate;
            walletDue = (totalDue * walletRatio) / walletRate;
        } else {
            cashDue = totalDue / cashRate;
            walletDue = 0;
        }
    }

    document.getElementById('mixed-cash-due').textContent = formatPosMoney(cashDue, 2);
    document.getElementById('mixed-cash-due-currency').textContent = cashCurrencyId ? getCurrencyCode(
        cashCurrencyId) : 'ريال';
    document.getElementById('mixed-wallet-due').textContent = formatPosMoney(walletDue, 2);
    document.getElementById('mixed-wallet-due-currency').textContent = walletCurrencyId ? getCurrencyCode(
        walletCurrencyId) : 'ريال';
}

// ================================================================
//  14. PAYMENT METHOD
// ================================================================
function handlePaymentMethodChange() {
    const method = document.getElementById('payment-method').value;
    document.getElementById('wallet-selection').style.display = method === 'wallet' ? 'block' : 'none';
    document.getElementById('mixed-payment').style.display = method === 'mixed' ? 'block' : 'none';
    document.getElementById('cash-currency-group').style.display = (method === 'cash' || method === 'mixed') ?
        'block' : 'none';
    document.getElementById('paid-amount-row').style.display = (method === 'cash' || method === 'wallet') ? 'flex' :
        'none';

    if (method === 'wallet' || method === 'mixed') {
        loadWalletsFromServer().then(() => {
            populateWalletSelects();
        });
    }
    populateCurrencySelects();
    if (method === 'wallet') onWalletSelectChange();
    if (method === 'mixed') onMixedWalletChange();

    updateTotals();
}

// ================================================================
//  15. LOAD INVOICE FOR EDIT
// ================================================================
async function loadInvoiceForEdit(invoiceId) {
    try {
        const res = await fetch(`${API}/sales/${invoiceId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('الفاتورة غير موجودة أو لا يمكن الوصول إليها');
        const data = await res.json();

        editInvoiceId = invoiceId;
        document.getElementById('cancel-edit-btn').style.display = 'inline-flex';

        if (data.customer_id) {
            selectedCustomerId = data.customer_id;
            selectedCustomerName = data.customer_name || 'عميل';
            updateCustomerButtonDisplay();
        }

        cart = [];
        if (data.items && Array.isArray(data.items)) {
            data.items.forEach(item => {
                cart.push({
                    id: item.product_id,
                    name: item.product_name,
                    price: item.unit_price,
                    cost: item.cost_price || 0,
                    quantity: item.quantity,
                    discount: Number(item.discount || item.discount_amount || 0),
                    notes: item.note || item.notes || ''
                });
            });
            renderCart();
        } else {
            renderCart();
            showToast('الفاتورة لا تحتوي على منتجات', 'warning');
        }

        document.getElementById('cart-discount').value = data.discount || 0;
        document.getElementById('discount-type').value = data.discount_type || 'fixed';
        document.getElementById('payment-method').value = data.payment_method || 'cash';
        handlePaymentMethodChange();

        if (data.payment_method === 'mixed') {
            document.getElementById('cash-paid').value = data.cash_paid || 0;
            document.getElementById('wallet-paid').value = data.wallet_paid || 0;
            if (data.cash_currency_id) {
                document.getElementById('mixed-cash-currency').value = data.cash_currency_id;
            }
            if (data.wallet_currency_id) {
                document.getElementById('mixed-wallet-currency').value = data.wallet_currency_id;
            }
        } else {
            const total = data.total_amount || 0;
            const currencyId = data.payment_method === 'cash' ?
                (data.cash_currency_id || document.getElementById('cash-currency-select').value) :
                (data.wallet_currency_id || document.getElementById('wallet-currency-select').value);
            if (currencyId) {
                const converted = convertFromBase(total, parseInt(currencyId));
                if (isFinite(converted)) {
                    document.getElementById('paid-amount').value = converted.toFixed(2);
                } else {
                    document.getElementById('paid-amount').value = total.toFixed(2);
                }
            } else {
                document.getElementById('paid-amount').value = total.toFixed(2);
            }
        }

        if (data.wallet_id) {
            const walletSelect = document.getElementById('wallet-select');
            if (walletSelect) walletSelect.value = data.wallet_id;
        }

        updateTotals();
        document.getElementById('page-subtitle').innerText = `تعديل فاتورة #${data.invoice_number}`;
        const btnText = document.getElementById('submit-btn-text');
        const btnIcon = document.getElementById('submit-btn-icon');
        if (btnText) btnText.innerText = 'تعديل الفاتورة';
        if (btnIcon) btnIcon.className = 'fas fa-edit';

        showToast(`✅ تم تحميل الفاتورة #${data.invoice_number} للتعديل`, 'success');
    } catch (err) {
        showToast(`❌ فشل تحميل الفاتورة للتعديل: ${err.message}`, 'error');
        editInvoiceId = null;
        document.getElementById('cancel-edit-btn').style.display = 'none';
    }
}

// ================================================================
//  16. RESET SALE FORM
// ================================================================
function resetSaleForm() {
    cart = [];
    localStorage.removeItem('pos_cart');
    document.getElementById('cart-discount').value = 0;
    selectedCustomerId = null;
    selectedCustomerName = '';
    editInvoiceId = null;
    updateCustomerButtonDisplay();
    renderCart();
    document.getElementById('cash-paid').value = 0;
    document.getElementById('wallet-paid').value = 0;
    document.getElementById('paid-amount').value = 0;
    document.getElementById('page-subtitle').innerText = 'إنشاء فاتورة جديدة';
    const iconEl = document.getElementById('submit-btn-icon');
    const textEl = document.getElementById('submit-btn-text');
    if (iconEl) iconEl.className = 'fas fa-save';
    if (textEl) textEl.textContent = 'حفظ وبيع';
    document.getElementById('cancel-edit-btn').style.display = 'none';
    if (window.history && window.history.replaceState) {
        const url = new URL(window.location);
        url.searchParams.delete('edit');
        window.history.replaceState({}, document.title, url.toString());
    }
    handlePaymentMethodChange();
}

// ================================================================
//  17. CANCEL EDIT MODE
// ================================================================
function cancelEditMode() {
    if (confirm('هل تريد إلغاء التعديل والعودة إلى وضع الإنشاء الجديد؟')) {
        resetSaleForm();
        showToast('تم إلغاء التعديل والعودة إلى وضع الإنشاء', 'info');
    }
}

// ================================================================
//  18. QUICK SALE
// ================================================================
async function quickSale() {
    if (cart.length === 0) return showToast('⚠️ السلة فارغة', 'warning');

    const btn = document.querySelector('.btn-warning');
    const originalText = btn.textContent;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري...';
    btn.disabled = true;

    try {
        const discount = parseFloat(document.getElementById('cart-discount').value) || 0;
        const discountType = document.getElementById('discount-type').value;
        const payment = document.getElementById('payment-method').value;
        const customerId = selectedCustomerId || null;
        let walletId = null,
            cashPaid = 0,
            walletPaid = 0;
        let cashCurrencyId = null,
            walletCurrencyId = null;

        if (payment === 'cash') {
            cashCurrencyId = parseInt(document.getElementById('cash-currency-select').value);
            cashPaid = parseFloat(document.getElementById('paid-amount').value) || 0;
        } else if (payment === 'wallet') {
            walletId = document.getElementById('wallet-select').value;
            if (!walletId) { showToast('يرجى اختيار محفظة', 'warning');
                btn.innerHTML = originalText;
                btn.disabled = false; return; }
            walletCurrencyId = parseInt(document.getElementById('wallet-currency-select').value);
            walletPaid = parseFloat(document.getElementById('paid-amount').value) || 0;
        } else if (payment === 'mixed') {
            cashPaid = parseFloat(document.getElementById('cash-paid').value) || 0;
            walletPaid = parseFloat(document.getElementById('wallet-paid').value) || 0;
            walletId = document.getElementById('mixed-wallet').value;
            cashCurrencyId = parseInt(document.getElementById('mixed-cash-currency').value);
            walletCurrencyId = parseInt(document.getElementById('mixed-wallet-currency').value);
            if (!walletId && walletPaid > 0) { showToast('اختر المحفظة', 'warning');
                btn.innerHTML = originalText;
                btn.disabled = false; return; }
            if (cashPaid + walletPaid <= 0) { showToast('أدخل مبلغاً مدفوعاً', 'warning');
                btn.innerHTML = originalText;
                btn.disabled = false; return; }
        }

        const subtotal = cart.reduce((s, i) => s + (i.price || 0) * i.quantity, 0);
        let discountAmount = discountType === 'percentage' ? subtotal * (discount / 100) : discount;
        const total = Math.max(0, subtotal - discountAmount);

        if (payment === 'mixed') {
            let totalPaidInBase = 0;
            if (cashCurrencyId) totalPaidInBase += convertToBase(cashPaid, cashCurrencyId);
            else totalPaidInBase += cashPaid;
            if (walletCurrencyId) totalPaidInBase += convertToBase(walletPaid, walletCurrencyId);
            else totalPaidInBase += walletPaid;
            if (totalPaidInBase < total) {
                showToast(`⚠️ المبلغ المدفوع أقل من الإجمالي (${formatPosMoney(total)} ريال)`, 'warning');
                btn.innerHTML = originalText;
                btn.disabled = false;
                return;
            }
        }

        const body = {
            customer_id: customerId ? parseInt(customerId) : null,
            items: cart.map(i => ({ product_id: i.id, quantity: i.quantity, unit_price: i.price, discount: Number(i.discount || 0), note: i.notes || i.note || '', notes: i.notes || i.note || '', variant_id: i.variant_id || null, variant_label: i.variant_label || null, sale_mode: i.sale_mode || (i.variant_id ? 'size' : 'full_set') })),
            payment_method: payment,
            wallet_id: walletId ? parseInt(walletId) : null,
            discount: discount,
            discount_type: discountType,
            cash_amount: cashPaid,
            wallet_amount: walletPaid,
            cash_currency_id: cashCurrencyId !== null && !isNaN(cashCurrencyId) ? cashCurrencyId : null,
            wallet_currency_id: walletCurrencyId !== null && !isNaN(walletCurrencyId) ? walletCurrencyId : null,
            note: 'بيع سريع (بدون طباعة)'
        };
        let res;
        const isEditMode = !!editInvoiceId;
        if (isEditMode) {
            res = await fetch(`${API}/sales/${editInvoiceId}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        } else {
            res = await fetch(`${API}/sales`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        }

        const data = await res.json();
        if (res.ok) {
            const invoiceData = data.invoice || data;
            const walletName = invoiceData.wallet_name || (data.wallet_name || '');
            const msg =
                `✅ تم البيع السريع بنجاح (فاتورة ${invoiceData.invoice_number || 'غير معروف'})${walletName ? ` - المحفظة: ${formatPosMoney(walletName)}` : ''}`;
            showToast(msg, 'success');
            resetSaleForm();
            fetchProducts(currentSearch, selectedCategoryId);
            const synced = await syncPendingSales();
            if (synced > 0) showToast(`✅ تمت مزامنة ${synced} فاتورة معلقة`, 'success');
        } else {
            showToast(data.error || '⚠️ فشل البيع السريع', 'error');
        }
    } catch (err) {
        showToast(err.message || '⚠️ خطأ في الاتصال', 'error');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// ================================================================
//  19. SUBMIT SALE
// ================================================================
async function submitSale() {
    if (cart.length === 0) return showToast('⚠️ السلة فارغة', 'warning');

    const btn = document.querySelector('.btn-success');
    const iconEl = document.getElementById('submit-btn-icon');
    const textEl = document.getElementById('submit-btn-text');
    if (!btn || !iconEl || !textEl) {
        showToast('❌ خطأ في واجهة المستخدم، يرجى تحديث الصفحة', 'error');
        return;
    }

    const originalIcon = iconEl.className || 'fas fa-save';
    const originalText = textEl.textContent || 'حفظ وبيع';

    function restoreButton() {
        btn.innerHTML = `<i class="${originalIcon}"></i> ${originalText}`;
        btn.disabled = false;
    }

    // ====== وضع عدم الاتصال ======
    if (!navigator.onLine) {
        const discount = parseFloat(document.getElementById('cart-discount').value) || 0;
        const discountType = document.getElementById('discount-type').value;
        const payment = document.getElementById('payment-method').value;
        const customerId = selectedCustomerId || null;
        let walletId = null,
            cashPaid = 0,
            walletPaid = 0;
        let cashCurrencyId = null,
            walletCurrencyId = null;

        if (payment === 'cash') {
            cashCurrencyId = parseInt(document.getElementById('cash-currency-select').value);
            cashPaid = parseFloat(document.getElementById('paid-amount').value) || 0;
        } else if (payment === 'wallet') {
            walletId = document.getElementById('wallet-select').value;
            if (!walletId) return showToast('يرجى اختيار محفظة', 'warning');
            walletCurrencyId = parseInt(document.getElementById('wallet-currency-select').value);
            walletPaid = parseFloat(document.getElementById('paid-amount').value) || 0;
        } else if (payment === 'mixed') {
            cashPaid = parseFloat(document.getElementById('cash-paid').value) || 0;
            walletPaid = parseFloat(document.getElementById('wallet-paid').value) || 0;
            walletId = document.getElementById('mixed-wallet').value;
            cashCurrencyId = parseInt(document.getElementById('mixed-cash-currency').value);
            walletCurrencyId = parseInt(document.getElementById('mixed-wallet-currency').value);
            if (!walletId && walletPaid > 0) return showToast('اختر المحفظة', 'warning');
            if (cashPaid + walletPaid <= 0) return showToast('أدخل مبلغاً مدفوعاً', 'warning');
        }

        const subtotal = cart.reduce((s, i) => s + (i.price || 0) * i.quantity, 0);
        let discountAmount = discountType === 'percentage' ? subtotal * (discount / 100) : discount;
        const total = Math.max(0, subtotal - discountAmount);

        if (payment === 'mixed') {
            let totalPaidInBase = 0;
            if (cashCurrencyId) totalPaidInBase += convertToBase(cashPaid, cashCurrencyId);
            else totalPaidInBase += cashPaid;
            if (walletCurrencyId) totalPaidInBase += convertToBase(walletPaid, walletCurrencyId);
            else totalPaidInBase += walletPaid;
            if (totalPaidInBase < total) {
                return showToast(`⚠️ المبلغ المدفوع أقل من الإجمالي (${formatPosMoney(total)} ريال)`, 'warning');
            }
        }

        const saleData = {
            customer_id: customerId ? parseInt(customerId) : null,
            items: cart.map(i => ({ product_id: i.id, quantity: i.quantity, unit_price: i.price, discount: Number(i.discount || 0), note: i.notes || i.note || '', notes: i.notes || i.note || '', variant_id: i.variant_id || null, variant_label: i.variant_label || null, sale_mode: i.sale_mode || (i.variant_id ? 'size' : 'full_set') })),
            payment_method: payment,
            wallet_id: walletId ? parseInt(walletId) : undefined,
            discount: discount,
            discount_type: discountType,
            cash_amount: cashPaid,
            wallet_amount: walletPaid,
            cash_currency_id: cashCurrencyId || undefined,
            wallet_currency_id: walletCurrencyId || undefined,
            note: 'تم إنشاؤها دون اتصال',
            total_amount: total,
            status: 'pending'
        };

        try {
            await addPendingSale(saleData);
            showToast('✅ تم حفظ الفاتورة محلياً، ستُزامن تلقائياً عند الاتصال', 'success');
            resetSaleForm();
        } catch (err) {
            showToast('❌ فشل حفظ الفاتورة محلياً', 'error');
        }
        return;
    }

    // ====== وضع الاتصال ======
    const discount = parseFloat(document.getElementById('cart-discount').value) || 0;
    const discountType = document.getElementById('discount-type').value;
    const payment = document.getElementById('payment-method').value;
    const customerId = selectedCustomerId || null;
    let walletId = null,
        cashPaid = 0,
        walletPaid = 0;
    let cashCurrencyId = null,
        walletCurrencyId = null;

    if (payment === 'cash') {
        cashCurrencyId = parseInt(document.getElementById('cash-currency-select').value);
        cashPaid = parseFloat(document.getElementById('paid-amount').value) || 0;
    } else if (payment === 'wallet') {
        walletId = document.getElementById('wallet-select').value;
        if (!walletId) return showToast('يرجى اختيار محفظة', 'warning');
        walletCurrencyId = parseInt(document.getElementById('wallet-currency-select').value);
        walletPaid = parseFloat(document.getElementById('paid-amount').value) || 0;
    } else if (payment === 'mixed') {
        cashPaid = parseFloat(document.getElementById('cash-paid').value) || 0;
        walletPaid = parseFloat(document.getElementById('wallet-paid').value) || 0;
        walletId = document.getElementById('mixed-wallet').value;
        cashCurrencyId = parseInt(document.getElementById('mixed-cash-currency').value);
        walletCurrencyId = parseInt(document.getElementById('mixed-wallet-currency').value);
        if (!walletId && walletPaid > 0) return showToast('اختر المحفظة', 'warning');
        if (cashPaid + walletPaid <= 0) return showToast('أدخل مبلغاً مدفوعاً', 'warning');
    }

    const subtotal = cart.reduce((s, i) => s + (i.price || 0) * i.quantity, 0);
    let discountAmount = discountType === 'percentage' ? subtotal * (discount / 100) : discount;
    const total = Math.max(0, subtotal - discountAmount);

    if (payment === 'mixed') {
        let totalPaidInBase = 0;
        if (cashCurrencyId) totalPaidInBase += convertToBase(cashPaid, cashCurrencyId);
        else totalPaidInBase += cashPaid;
        if (walletCurrencyId) totalPaidInBase += convertToBase(walletPaid, walletCurrencyId);
        else totalPaidInBase += walletPaid;
        if (totalPaidInBase < total) {
            return showToast(`⚠️ المبلغ المدفوع أقل من الإجمالي (${formatPosMoney(total)} ريال)`, 'warning');
        }
    }

    const body = {
        customer_id: customerId ? parseInt(customerId) : null,
        items: cart.map(i => ({ product_id: i.id, quantity: i.quantity, unit_price: i.price, discount: Number(i.discount || 0), note: i.notes || i.note || '', notes: i.notes || i.note || '', variant_id: i.variant_id || null, variant_label: i.variant_label || null, sale_mode: i.sale_mode || (i.variant_id ? 'size' : 'full_set') })),
        payment_method: payment,
        wallet_id: walletId ? parseInt(walletId) : null,
        discount: discount,
        discount_type: discountType,
        cash_amount: cashPaid,
        wallet_amount: walletPaid,
        cash_currency_id: cashCurrencyId !== null && !isNaN(cashCurrencyId) ? cashCurrencyId : null,
        wallet_currency_id: walletCurrencyId !== null && !isNaN(walletCurrencyId) ? walletCurrencyId : null,
        note: ''
    };

    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري الحفظ...';
    btn.disabled = true;

    try {
        let res;
        const isEditMode = !!editInvoiceId;

        if (isEditMode) {
            res = await fetch(`${API}/sales/${editInvoiceId}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        } else {
            res = await fetch(`${API}/sales`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        }

        const data = await res.json();
        if (res.ok) {
            const invoiceData = data.invoice || data;
            const actionMsg = isEditMode ? 'تعديل' : 'إنشاء';
            const walletName = invoiceData.wallet_name || (data.wallet_name || '');
            const cashCurrencyName = cashCurrencyId ? getCurrencyCode(cashCurrencyId) : '';
            const walletCurrencyName = walletCurrencyId ? getCurrencyCode(walletCurrencyId) : '';
            const currencyInfo = cashCurrencyName ? ` (نقد: ${formatPosMoney(cashCurrencyName)})` : '';
            const walletInfo = walletCurrencyName ? ` (محفظة: ${formatPosMoney(walletCurrencyName)})` : '';
            const msg =
                `✅ تم ${actionMsg} الفاتورة رقم ${invoiceData.invoice_number || 'غير معروف'} بنجاح${walletName ? ` - ${formatPosMoney(walletName)}` : ''}${currencyInfo}${walletInfo}`;
            showToast(msg, 'success');

            // طباعة الفاتورة مع product_code
            printProfessionalInvoice(
                invoiceData,
                null,
                walletName,
                cashCurrencyName,
                walletCurrencyName,
                cashPaid,
                walletPaid
            );

            resetSaleForm();
            fetchProducts(currentSearch, selectedCategoryId);
            const synced = await syncPendingSales();
            if (synced > 0) showToast(`✅ تمت مزامنة ${synced} فاتورة معلقة`, 'success');
        } else {
            showToast(data.error || `⚠️ فشل ${formatPosNumber(isEditMode ? 'تعديل' : 'إنشاء')} الفاتورة`, 'error');
        }
    } catch (err) {
        showToast(err.message || '⚠️ خطأ في الاتصال بالخادم', 'error');
    } finally {
        restoreButton();
    }
}

// ================================================================
//  20. INVOICE PRINT (معدل لعرض رقم التصنيف)
// ================================================================
function printProfessionalInvoice(invoice, extraItems = null, walletName = null, cashCurrency = '',
    walletCurrency = '', cashAmount = 0, walletAmount = 0) {
    if (!invoice) return showToast('لا توجد بيانات للطباعة', 'error');
    const shopName = localStorage.getItem('shop_name') || 'ابن المختار للأدوات المنزلية';
    const shopPhone = localStorage.getItem('shop_phone') || '773266534';

    let items = [];
    if (invoice.items && Array.isArray(invoice.items) && invoice.items.length > 0) {
        items = invoice.items.map(item => {
            const product = productsCache.find(p => p.id === item.product_id);
            return {
                ...item,
                product_code: item.product_code || (product ? product.product_code : '')
            };
        });
    } else if (extraItems && Array.isArray(extraItems) && extraItems.length > 0) {
        items = extraItems.map(i => ({
            product_name: i.name || 'بدون اسم',
            quantity: i.quantity || 0,
            unit_price: i.price || 0,
            total_price: (i.price || 0) * (i.quantity || 0),
            product_code: i.product_code || ''
        }));
    } else if (cart.length > 0) {
        items = cart.map(i => {
            const product = productsCache.find(p => p.id === i.id);
            return {
                product_name: i.name || 'بدون اسم',
                quantity: i.quantity || 0,
                unit_price: i.price || 0,
                total_price: (i.price || 0) * (i.quantity || 0),
                product_code: product ? product.product_code : ''
            };
        });
    }

    const subtotal = invoice.subtotal || items.reduce((s, i) => s + (i.total_price || 0), 0);
    const discount = invoice.discount || 0;
                const total = Number(invoice.total_amount || (subtotal - discount));
    if (window.POSDocs) {
        const paidForPrint = Number(invoice.paid_amount ?? (cashAmount + walletAmount) ?? 0);
        POSDocs.printInvoiceData({ type:'sale', number:invoice.invoice_number || invoice.id, date:invoice.created_at ? posDateTime(invoice.created_at) : new Date().toLocaleString('ar-SA'), party:invoice.customer_name || 'عميل نقدي', payment_method:invoice.payment_method || 'نقدي', status:invoice.status || 'مكتملة', items, subtotal:Number(subtotal), discount:Number(discount), total, paid:paidForPrint, notes:invoice.note || '' }, {title:'فاتورة مبيعات'}).catch(error => showToast(error.message, 'error'));
        return;
    }
    let paymentDisplay = invoice.payment_method || 'N/A';
    if (walletName && (invoice.payment_method === 'wallet' || invoice.payment_method === 'mixed')) {
        paymentDisplay += ` (محفظة: ${formatPosMoney(walletName)})`;
    }
    if (cashCurrency && invoice.payment_method !== 'wallet') {
        paymentDisplay += ` (نقد: ${formatPosMoney(cashCurrency)})`;
    }
    if (walletCurrency && invoice.payment_method === 'wallet') {
        paymentDisplay += ` (عملة: ${formatPosMoney(walletCurrency)})`;
    }
    if (invoice.payment_method === 'mixed' && cashCurrency && walletCurrency) {
        paymentDisplay = `نقد: ${formatPosMoney(cashCurrency)} + محفظة: ${formatPosMoney(walletCurrency)} (${formatPosMoney(walletName || '')})`;
    }

    let extraPaymentInfo = '';
    if (invoice.payment_method === 'mixed' || invoice.payment_method === 'cash' || invoice.payment_method ===
        'wallet') {
        let cashPaidDisplay = cashAmount > 0 ? `${formatPosMoney(cashAmount)} ${formatPosMoney(cashCurrency || 'ريال')}` : '0.00';
        let walletPaidDisplay = walletAmount > 0 ? `${formatPosMoney(walletAmount)} ${formatPosMoney(walletCurrency || 'ريال')}` :
        '0.00';
        if (invoice.payment_method === 'mixed') {
            extraPaymentInfo = `
                    <div style="display:flex; justify-content:flex-end; gap:20px; padding:4px 0; font-size:0.9rem;">
                        <span>💵 المدفوع نقداً: ${formatPosMoney(cashPaidDisplay)}</span>
                        <span>💳 المدفوع بالمحفظة: ${formatPosMoney(walletPaidDisplay)}</span>
                    </div>
                `;
        } else if (invoice.payment_method === 'cash') {
            extraPaymentInfo = `
                    <div style="display:flex; justify-content:flex-end; gap:20px; padding:4px 0; font-size:0.9rem;">
                        <span>💵 المدفوع نقداً: ${formatPosMoney(cashPaidDisplay)}</span>
                    </div>
                `;
        } else if (invoice.payment_method === 'wallet') {
            extraPaymentInfo = `
                    <div style="display:flex; justify-content:flex-end; gap:20px; padding:4px 0; font-size:0.9rem;">
                        <span>💳 المدفوع بالمحفظة: ${formatPosMoney(walletPaidDisplay)}</span>
                    </div>
                `;
        }
    }

    const content = `
            <div class="invoice-print">
                <div class="header">
                    <div class="company">
                        <h2>🏠 ${escapeHTML(shopName)}</h2>
                        <p>📞 ${escapeHTML(shopPhone)}</p>
                    </div>
                    <div style="text-align:left;">
                        <h3>🧾 فاتورة رقم: ${invoice.invoice_number || 'N/A'}</h3>
                        <p>📅 ${posDateTime(invoice.created_at)}</p>
                    </div>
                </div>
                <div class="info">
                    <div><strong>👤 العميل:</strong> ${invoice.customer_name || 'نقدي'}</div>
                    <div><strong>💳 طريقة الدفع:</strong> ${formatPosMoney(paymentDisplay)}</div>
                </div>
                ${extraPaymentInfo}
                ${items.length === 0 ? '<p style="color:red;text-align:center;">⚠️ لا توجد منتجات في هذه الفاتورة</p>' : `
                <table>
                    <thead><tr><th>#</th><th>المنتج</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th></tr></thead>
                    <tbody>
                        ${items.map((item, idx) => `
                            <tr>
                                <td>${formatPosNumber(idx+1)}</td>
                                <td>${escapeHTML(item.product_name || 'بدون اسم')}${item.product_code ? ' (كود: '+escapeHTML(item.product_code)+')' : ''}</td>
                                <td>${formatPosQuantity(item.quantity || 0)}</td>
                                <td>${(item.unit_price || 0)}</td>
                                <td>${formatPosMoney((item.total_price || 0))}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
                `}
                <div class="totals">
                    <div><span>المجموع:</span><span>${formatPosMoney(subtotal)} ريال</span></div>
                    ${discount > 0 ? `<div><span>الخصم:</span><span>${formatPosMoney(discount)} ريال</span></div>` : ''}
                    <div class="grand-total"><span>الإجمالي:</span><span>${formatPosMoney(total)} ريال</span></div>
                </div>
                <div class="footer"><p>شكراً لتعاملكم معنا</p></div>
            </div>
        `;
    const win = window.open('', '_blank', 'width=800,height=700,scrollbars=yes');
    if (!win) return showToast('⚠️ يرجى السماح بالنوافذ المنبثقة', 'warning');
    win.document.write(
        `<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>معاينة فاتورة</title><style>${document.querySelector('style').innerHTML}</style><style>body{background:white;padding:20px}.invoice-print{max-width:800px;margin:0 auto;background:white}.pos-preview-toolbar{display:flex;align-items:center;gap:8px;padding:10px;margin:0 auto 12px;max-width:800px;background:#eef4ff;border:1px solid #cbd5e1;border-radius:8px;font-family:Arial,sans-serif}.pos-preview-toolbar span{flex:1}.pos-preview-toolbar button{border:1px solid #94a3b8;border-radius:6px;background:#fff;padding:7px 13px;cursor:pointer;font-weight:700}.pos-preview-toolbar button:first-of-type{background:#1d4ed8;color:#fff}@media print{body{padding:0}.pos-preview-toolbar{display:none!important}}</style></head><body><div class="pos-preview-toolbar"><strong>معاينة الفاتورة</strong><span></span><button type="button" onclick="window.print()">طباعة</button><button type="button" onclick="window.close()">إغلاق</button></div>${content}<script>window.onload=function(){window.focus()}<\/script></body></html>`
        );
    win.document.close();
}

// ================================================================
//  21. CATEGORY MANAGEMENT
// ================================================================
async function loadAllCategories() {
    if (!navigator.onLine) {
        showToast('غير متصل، لا يمكن تحميل التصنيفات', 'warning');
        return;
    }
    try {
        const res = await fetch(`${API}/categories?flat=1`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        allCategories = data.categories || [];
        populateMainCategories();
    } catch (err) {
        showToast('فشل تحميل التصنيفات', 'error');
        console.error(err);
    }
}

function populateMainCategories() {
    const mainSelect = document.getElementById('main-category');
    const mainCats = allCategories.filter(c => c.parent_id === null);
    mainSelect.innerHTML = '<option value="">📂 جميع الأقسام</option>';
    mainCats.forEach(cat => {
        mainSelect.innerHTML += `<option value="${cat.id}">${escapeHTML(cat.name)}</option>`;
    });
    if (selectedCategoryId) {
        const exists = mainCats.some(c => c.id == selectedCategoryId);
        if (exists) mainSelect.value = selectedCategoryId;
        else mainSelect.value = '';
    }
    onMainCategoryChange();
}

function onMainCategoryChange() {
    const mainSelect = document.getElementById('main-category');
    const subSelect = document.getElementById('sub-category');
    const mainId = mainSelect.value ? parseInt(mainSelect.value) : null;

    subSelect.style.display = 'none';
    subSelect.innerHTML = '<option value="">📂 اختر الفرع</option>';

    if (!mainId) {
        selectedCategoryId = null;
        fetchProducts(currentSearch, null);
        return;
    }

    const subCats = allCategories.filter(c => c.parent_id === mainId);
    if (subCats.length > 0) {
        subSelect.style.display = 'block';
        subCats.forEach(cat => {
            subSelect.innerHTML += `<option value="${cat.id}">${escapeHTML(cat.name)}</option>`;
        });
        if (selectedCategoryId && subCats.some(c => c.id == selectedCategoryId)) {
            subSelect.value = selectedCategoryId;
        } else {
            subSelect.value = '';
        }
        selectedCategoryId = mainId;
        fetchProducts(currentSearch, mainId);
    } else {
        selectedCategoryId = mainId;
        fetchProducts(currentSearch, mainId);
    }
}

function onSubCategoryChange() {
    const subSelect = document.getElementById('sub-category');
    const subId = subSelect.value ? parseInt(subSelect.value) : null;
    if (subId) {
        selectedCategoryId = subId;
        fetchProducts(currentSearch, subId);
    } else {
        const mainSelect = document.getElementById('main-category');
        const mainId = mainSelect.value ? parseInt(mainSelect.value) : null;
        if (mainId) {
            selectedCategoryId = mainId;
            fetchProducts(currentSearch, mainId);
        } else {
            selectedCategoryId = null;
            fetchProducts(currentSearch, null);
        }
    }
}

// ================================================================
//  22. RECENT INVOICES MODAL
// ================================================================
async function openRecentInvoicesModal() {
    const modal = document.getElementById('recent-invoices-modal');
    const list = document.getElementById('recent-invoices-list');
    list.innerHTML =
        '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>جاري التحميل...</p></div>';
    openModal('recent-invoices-modal');

    try {
        const res = await fetch(`${API}/sales?limit=10&sort=desc`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('فشل جلب الفواتير');
        const data = await res.json();
        const invoices = data.sales || data.invoices || [];

        if (invoices.length === 0) {
            list.innerHTML =
            '<div class="empty-state"><i class="fas fa-inbox"></i><p>لا توجد فواتير حتى الآن</p></div>';
            return;
        }

        list.innerHTML = invoices.map(inv => {
            const methodClass = inv.payment_method || 'cash';
            const methodLabel = {
                'cash': 'نقد',
                'wallet': 'محفظة',
                'credit': 'آجل',
                'mixed': 'مختلط'
            } [methodClass] || methodClass;

            return `
                    <div class="invoice-option" onclick="window.location.href='sale.html?edit=${inv.id}'">
                        <div>
                            <strong>#${inv.invoice_number || inv.id}</strong>
                            <span style="margin:0 8px;color:var(--muted);">|</span>
                            <span>${inv.customer_name || 'نقدي'}</span>
                            <span style="margin:0 8px;color:var(--muted);">|</span>
                            <span style="font-size:0.8rem;color:var(--muted);">${posDateTime(inv.created_at)}</span>
                        </div>
                        <div>
                            <span style="font-weight:700;color:var(--primary);">${formatPosMoney((inv.total_amount || 0))} ريال</span>
                            <span style="margin:0 8px;color:var(--muted);">|</span>
                            <span class="inv-method ${methodClass}">${methodLabel}</span>

                        </div>
                    </div>
                `;
        }).join('');
    } catch (err) {
        list.innerHTML =
            `<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>فشل تحميل الفواتير: ${err.message}</p></div>`;
        showToast('❌ فشل تحميل قائمة الفواتير', 'error');
    }
}

// ================================================================
//  23. CURRENCY & WALLET HELPERS
// ================================================================
function populateCurrencySelects() {
    const selects = [
        'cash-currency-select',
        'wallet-currency-select',
        'mixed-cash-currency',
        'mixed-wallet-currency'
    ];
    selects.forEach(id => {
        const sel = document.getElementById(id);
        if (sel) {
            sel.innerHTML = currenciesCache.map(c =>
                `<option value="${c.id}">${c.code} - ${c.name}</option>`
            ).join('');
        }
    });
    const base = currenciesCache.find(c => c.is_base);
    if (base) {
        selects.forEach(id => {
            const sel = document.getElementById(id);
            if (sel) sel.value = base.id;
        });
    }
    updateRateDisplays();
}

function updateRateDisplays() {
    const cashId = document.getElementById('cash-currency-select')?.value;
    const walletId = document.getElementById('wallet-currency-select')?.value;
    if (cashId) {
        const rate = getCurrencyRate(parseInt(cashId));
        document.getElementById('cash-rate-display').textContent =
            `سعر الصرف: 1 ${getCurrencyCode(parseInt(cashId))} = ${rate} ريال`;
    }
    if (walletId) {
        const rate = getCurrencyRate(parseInt(walletId));
        document.getElementById('wallet-rate-display').textContent =
            `سعر الصرف: 1 ${getCurrencyCode(parseInt(walletId))} = ${rate} ريال`;
    }
}

function populateWalletSelects() {
    const selects = ['wallet-select', 'mixed-wallet'];
    selects.forEach(id => {
        const sel = document.getElementById(id);
        if (sel) {
            sel.innerHTML = walletsCache.map(w =>
                `<option value="${w.id}">${w.name}</option>`
            ).join('');
        }
    });
    onWalletSelectChange();
    onMixedWalletChange();
}

function onWalletSelectChange() {
    const walletId = document.getElementById('wallet-select').value;
    if (!walletId) {
        document.getElementById('wallet-balance-display').textContent = 'أرصدة المحفظة: -';
        return;
    }
    const wallet = walletsCache.find(w => w.id == walletId);
    if (!wallet) {
        document.getElementById('wallet-balance-display').textContent = 'المحفظة غير موجودة';
        return;
    }
    const balances = wallet.balances || [];
    if (balances.length === 0) {
        document.getElementById('wallet-balance-display').textContent = 'لا توجد أرصدة لهذه المحفظة';
        return;
    }
    const display = balances.map(b =>
        `${b.code}: ${formatPosMoney(b.balance)}`
    ).join(' | ');
    document.getElementById('wallet-balance-display').textContent = `أرصدة المحفظة: ${display}`;
}

function onMixedWalletChange() {
    const walletId = document.getElementById('mixed-wallet').value;
    if (!walletId) {
        document.getElementById('mixed-wallet-balance').textContent = 'رصيد المحفظة: -';
        return;
    }
    const wallet = walletsCache.find(w => w.id == walletId);
    if (!wallet) {
        document.getElementById('mixed-wallet-balance').textContent = 'المحفظة غير موجودة';
        return;
    }
    const balances = wallet.balances || [];
    if (balances.length === 0) {
        document.getElementById('mixed-wallet-balance').textContent = 'لا توجد أرصدة';
        return;
    }
    const display = balances.map(b =>
        `${b.code}: ${formatPosMoney(b.balance)}`
    ).join(' | ');
    document.getElementById('mixed-wallet-balance').textContent = `رصيد المحفظة: ${display}`;
}

// ================================================================
//  24. INIT & EVENT LISTENERS (معدل للتهيئة العامة)
// ================================================================
function initSalePage() {
    loadCurrentUser();
    updateOnlineStatus();
    (async function() {
        await loadSaleRules();
        loadCartFromLocal();

        selectedCategoryId = null;
        currentSearch = '';
        document.getElementById('search-input').value = '';
        document.getElementById('main-category').value = '';
        document.getElementById('sub-category').style.display = 'none';
        document.getElementById('sub-category').innerHTML = '<option value="">📂 اختر الفرع</option>';

        const params = new URLSearchParams(window.location.search);
        const editId = params.get('edit');
        if (editId) {
            editInvoiceId = parseInt(editId);
            document.getElementById('page-subtitle').innerText = `جاري تحميل الفاتورة #${editId}...`;
            await loadInvoiceForEdit(editId);
        } else {
            document.getElementById('page-subtitle').innerText = 'إنشاء فاتورة جديدة';
            const btnText = document.getElementById('submit-btn-text');
            const btnIcon = document.getElementById('submit-btn-icon');
            if (btnText) btnText.innerText = 'حفظ وبيع';
            if (btnIcon) btnIcon.className = 'fas fa-save';
            editInvoiceId = null;
            document.getElementById('cancel-edit-btn').style.display = 'none';
        }

        await loadCurrencies();
        await loadWalletsFromServer();
        populateCurrencySelects();
        populateWalletSelects();

        const hasLocal = await loadProductsFromLocal();

        if (navigator.onLine) {
            await loadAllCategories();
            await fetchProducts();
            const count = await syncPendingSales();
            if (count > 0) showToast(`✅ تمت مزامنة ${formatPosQuantity(count)} فاتورة معلقة`, 'success');
        } else if (!hasLocal) {
            showToast('⚠️ لا توجد بيانات محلية، يرجى الاتصال بالإنترنت أول مرة', 'warning');
        }

        await fetchCustomersList();
        document.getElementById('barcode-input').focus();

        document.querySelectorAll('.currency-select').forEach(sel => {
            sel.addEventListener('change', function() {
                if (document.getElementById('payment-method').value === 'cash' ||
                    document.getElementById('payment-method').value === 'wallet') {
                    updateTotalsFromPaid();
                } else if (document.getElementById('payment-method').value === 'mixed') {
                    updateTotalsFromPaidMixed();
                }
            });
        });

        handlePaymentMethodChange();
        if (document.getElementById('payment-method').value === 'mixed') {
            updateMixedDueAmounts();
        }
    })();
}

// ===== تنفيذ التهيئة عند تحميل الصفحة عادياً =====
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSalePage);
} else {
    initSalePage();
}

// ===== جعل الدالة عامة ليستدعيها sidebar-config.js =====
window.initSalePage = initSalePage;

document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.key === 'f') { e.preventDefault();
        document.getElementById('search-input').focus(); }
    if (e.key === 'Escape') {
        const search = document.getElementById('search-input');
        if (document.activeElement === search) { search.value = '';
            fetchProducts();
            document.getElementById('barcode-input').focus(); }
        document.querySelectorAll('.modal-overlay.active').forEach(el => closeModal(el.id));
    }
});

console.log('🚀 نظام البيع – متكامل مع دعم العملات المتعددة والتعبئة التلقائية في الدفع المختلط وعرض المبالغ المستحقة');
console.log('📌 تم إضافة عرض رقم التصنيف (product_code) والموردين في تفاصيل المنتج، والفرز حسب المورد.');