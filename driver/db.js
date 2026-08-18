// db.js - إدارة IndexedDB لجميع الكيانات مع دعم المزامنة

const DB_NAME = 'IbnMukhtarDB';
const DB_VERSION = 9; // رفع الإصدار لإضافة مكاتب جديدة

const STORES = {
  PRODUCTS: 'products',
  CUSTOMERS: 'customers',
  SUPPLIERS: 'suppliers',
  PURCHASES: 'purchases',
  EXPENSES: 'expenses',
  VOUCHERS: 'vouchers',
  WALLETS: 'wallets',
  SALES: 'sales',
  OPERATIONS: 'operations_log'  // لتتبع التغييرات غير المتزامنة
};

let db = null;

// ===== فتح قاعدة البيانات =====
function openDB() {
  return new Promise((resolve, reject) => {
    if (db) { resolve(db); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      // إنشاء المكاتب إذا لم توجد
      Object.values(STORES).forEach(storeName => {
        if (!db.objectStoreNames.contains(storeName)) {
          const store = db.createObjectStore(storeName, { keyPath: 'id' });
          if (storeName === STORES.OPERATIONS) {
            store.createIndex('synced', 'synced', { unique: false });
          }
          if (storeName === STORES.SALES) {
            store.createIndex('synced', 'synced', { unique: false });
          }
        }
      });
    };
    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

// ===== دوال عامة للقراءة والكتابة =====
async function getAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function getById(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function put(storeName, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.put(data);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function deleteById(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function clearStore(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ===== دوال العمليات (لمزامنة التغييرات) =====
async function addOperation(operation) {
  // operation: { store, type: 'add'|'update'|'delete', data, id }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.OPERATIONS, 'readwrite');
    const store = tx.objectStore(STORES.OPERATIONS);
    const entry = {
      ...operation,
      synced: false,
      created_at: new Date().toISOString()
    };
    const request = store.add(entry);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getPendingOperations() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.OPERATIONS, 'readonly');
    const store = tx.objectStore(STORES.OPERATIONS);
    const index = store.index('synced');
    const request = index.getAll(IDBKeyRange.only(false));
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function markOperationSynced(opId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.OPERATIONS, 'readwrite');
    const store = tx.objectStore(STORES.OPERATIONS);
    const request = store.get(opId);
    request.onsuccess = () => {
      const op = request.result;
      if (op) {
        op.synced = true;
        store.put(op);
        resolve();
      } else resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

async function deleteOperation(opId) {
  await deleteById(STORES.OPERATIONS, opId);
}

// ===== دوال خاصة بكل كيان (تستخدم الدوال العامة) =====
// المنتجات
async function getLocalProducts() { return await getAll(STORES.PRODUCTS); }
async function saveLocalProduct(product) { return await put(STORES.PRODUCTS, product); }
async function deleteLocalProduct(id) { return await deleteById(STORES.PRODUCTS, id); }

// العملاء
async function getLocalCustomers() { return await getAll(STORES.CUSTOMERS); }
async function saveLocalCustomer(customer) { return await put(STORES.CUSTOMERS, customer); }
async function deleteLocalCustomer(id) { return await deleteById(STORES.CUSTOMERS, id); }

// الموردين
async function getLocalSuppliers() { return await getAll(STORES.SUPPLIERS); }
async function saveLocalSupplier(supplier) { return await put(STORES.SUPPLIERS, supplier); }
async function deleteLocalSupplier(id) { return await deleteById(STORES.SUPPLIERS, id); }

// المشتريات
async function getLocalPurchases() { return await getAll(STORES.PURCHASES); }
async function saveLocalPurchase(purchase) { return await put(STORES.PURCHASES, purchase); }

// المصروفات
async function getLocalExpenses() { return await getAll(STORES.EXPENSES); }
async function saveLocalExpense(expense) { return await put(STORES.EXPENSES, expense); }

// السندات
async function getLocalVouchers() { return await getAll(STORES.VOUCHERS); }
async function saveLocalVoucher(voucher) { return await put(STORES.VOUCHERS, voucher); }

// المحافظ
async function getLocalWallets() { return await getAll(STORES.WALLETS); }
async function saveLocalWallet(wallet) { return await put(STORES.WALLETS, wallet); }

// فواتير المبيعات (المحفوظة محلياً)
async function getLocalSales() { return await getAll(STORES.SALES); }
async function saveLocalSale(sale) { return await put(STORES.SALES, sale); }
async function deleteLocalSale(id) { return await deleteById(STORES.SALES, id); }

// ===== تهيئة البيانات الأولية (عند تحميل الصفحة لأول مرة) =====
async function seedInitialData(apiUrl, token) {
  try {
    // جلب المنتجات
    const productsRes = await fetch(`${apiUrl}/products`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (productsRes.ok) {
      const data = await productsRes.json();
      for (const p of data.products) {
        await saveLocalProduct(p);
      }
    }

    // جلب العملاء
    const customersRes = await fetch(`${apiUrl}/customers`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (customersRes.ok) {
      const data = await customersRes.json();
      for (const c of data.customers) {
        await saveLocalCustomer(c);
      }
    }

    // جلب الموردين
    const suppliersRes = await fetch(`${apiUrl}/suppliers`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (suppliersRes.ok) {
      const data = await suppliersRes.json();
      for (const s of data.suppliers) {
        await saveLocalSupplier(s);
      }
    }

    // جلب المحافظ
    const walletsRes = await fetch(`${apiUrl}/wallets`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (walletsRes.ok) {
      const data = await walletsRes.json();
      for (const w of data.wallets) {
        await saveLocalWallet(w);
      }
    }
  } catch (err) {
    console.warn('فشل في تهيئة البيانات من الخادم', err);
  }
}

// ===== دالة المزامنة الشاملة =====
async function syncAllOperations(apiUrl, token) {
  const operations = await getPendingOperations();
  if (operations.length === 0) return;

  for (const op of operations) {
    try {
      const { store, type, data, id } = op;
      let endpoint = '';
      let method = '';
      let body = null;

      switch (store) {
        case STORES.PRODUCTS:
          endpoint = '/products';
          if (type === 'add' || type === 'update') {
            method = type === 'add' ? 'POST' : 'PUT';
            body = data;
            if (type === 'update') endpoint += `/${id}`;
          } else if (type === 'delete') {
            method = 'DELETE';
            endpoint += `/${id}`;
          }
          break;
        case STORES.CUSTOMERS:
          endpoint = '/customers';
          if (type === 'add' || type === 'update') {
            method = type === 'add' ? 'POST' : 'PUT';
            body = data;
            if (type === 'update') endpoint += `/${id}`;
          } else if (type === 'delete') {
            method = 'DELETE';
            endpoint += `/${id}`;
          }
          break;
        case STORES.SUPPLIERS:
          endpoint = '/suppliers';
          if (type === 'add' || type === 'update') {
            method = type === 'add' ? 'POST' : 'PUT';
            body = data;
            if (type === 'update') endpoint += `/${id}`;
          } else if (type === 'delete') {
            method = 'DELETE';
            endpoint += `/${id}`;
          }
          break;
        case STORES.PURCHASES:
          endpoint = '/purchases';
          if (type === 'add') {
            method = 'POST';
            body = data;
          }
          break;
        case STORES.EXPENSES:
          endpoint = '/expenses';
          if (type === 'add') {
            method = 'POST';
            body = data;
          }
          break;
        case STORES.VOUCHERS:
          endpoint = '/cash/voucher';
          if (type === 'add') {
            method = 'POST';
            body = data;
          }
          break;
        case STORES.SALES:
          endpoint = '/sales';
          if (type === 'add') {
            method = 'POST';
            body = data;
          }
          break;
        default:
          continue;
      }

      if (!endpoint || !method) continue;

      const response = await fetch(`${apiUrl}${endpoint}`, {
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: method !== 'DELETE' ? JSON.stringify(body) : undefined
      });

      if (response.ok) {
        await markOperationSynced(op.id);
        // إذا كانت العملية إضافة، يمكن تحديث المعرف المحلي بمعرف الخادم (اختياري)
        if (method === 'POST') {
          const result = await response.json();
          // يمكنك تحديث الكيان المحلي بالمعرف الجديد من الخادم
        }
      } else {
        console.warn(`فشلت مزامنة العملية ${op.id}`, await response.text());
      }
    } catch (err) {
      console.error(`خطأ في مزامنة العملية ${op.id}`, err);
    }
  }
}

// ===== دالة مراقبة الاتصال والمزامنة التلقائية =====
function initOfflineSystem(apiUrl, token) {
  // تسجيل Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/driver/sw_driver.js', {
      scope: '/driver/',
      updateViaCache: 'none'
    })
      .then(reg => console.log('✅ Driver Service Worker مسجل:', reg.scope))
      .catch(err => console.warn('❌ فشل تسجيل Driver SW', err));
  }

  // مزامنة فورية عند الاتصال
  if (navigator.onLine && token) {
    syncAllOperations(apiUrl, token).then(() => {
      // بعد المزامنة، تحديث البيانات المحلية من الخادم (للحصول على أي تغييرات خارجية)
      seedInitialData(apiUrl, token);
    });
  }

  // مراقبة تغيير حالة الاتصال
  window.addEventListener('online', () => {
    if (token) {
      syncAllOperations(apiUrl, token).then(() => {
        seedInitialData(apiUrl, token);
      });
    }
  });

  window.addEventListener('offline', () => {
    console.log('🔴 وضع غير متصل - جميع العمليات ستُحفظ محلياً');
  });
}

// ===== تصدير الدوال للاستخدام في الصفحات =====