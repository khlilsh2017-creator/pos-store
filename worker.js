// ==================== worker.js (المعدل بالكامل) ====================
import { createClient } from '@libsql/client/web';

// ==================== المتغيرات العامة والأمان ====================
let cachedClient = null;
let dbInitialized = false;
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Store-ID',
};
// ==================== كاش توكن Firebase ======================
let fcmTokenCache = {
  token: null,
  expiry: 0
};
// ==================== دوال الاستجابة ==============================
function jsonResponse(data, status = 200, headers = corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' }
  });
}

// ==================== الاتصال بقاعدة البيانات =====================
function getTursoClient(env) {
  if (cachedClient) return cachedClient;
  const url = env.TURSO_DATABASE_URL?.trim();
  const authToken = env.TURSO_AUTH_TOKEN?.trim();
  if (!url) throw new Error('TURSO_DATABASE_URL غير مضبوط');
  if (!authToken) throw new Error('TURSO_AUTH_TOKEN غير مضبوط');
  cachedClient = createClient({ url, authToken });
  return cachedClient;
}

// ==================== كاش الإعدادات ========================
// يبقى الكاش صالحًا طوال عمر الـ Worker، ولا يُعاد تحميله إلا بعد إبطال صريح.
let settingsCache = null;

function invalidateSettingsCache() {
  settingsCache = null;
}

async function getSettingsCached(conn) {
  if (settingsCache !== null) return settingsCache;
  const rows = await dbAll(conn, "SELECT key, value FROM settings");
  const settings = {};
  rows.forEach(row => settings[row.key] = row.value);
  settingsCache = settings;
  return settingsCache;
}

// ==================== دوال ترقيم الفواتير ========================
async function getNextInvoiceNumber(conn, type) {
  const key = `next_invoice_${type}`;
  const updateQuery = `
    UPDATE settings 
    SET value = CAST(COALESCE(value, '0') AS INTEGER) + 1 
    WHERE key = ? 
    RETURNING CAST(value AS INTEGER) - 1 as current_number
  `;
  let result = await dbExecute(conn, updateQuery, [key]);
  if (result.rows.length === 0) {
    await dbRun(conn, `INSERT OR IGNORE INTO settings (key, value) VALUES (?, '1')`, [key]);
    invalidateSettingsCache();
    result = await dbExecute(conn, updateQuery, [key]);
  }
  if (result.rows.length > 0) {
    invalidateSettingsCache();
    return parseInt(result.rows[0][0], 10);
  }
  throw new Error(`فشل في الحصول على رقم فاتورة جديد للنوع: ${type}`);
}
async function setInitialInvoiceNumber(conn, type, startNumber) {
  const key = `next_invoice_${type}`;
  await dbRun(conn, 
    `INSERT INTO settings (key, value) VALUES (?, ?) 
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, startNumber.toString()]
  );
  invalidateSettingsCache();
}
async function ensureInitialized(env) {
  if (dbInitialized) return;
  await initializeDatabase(env);
  dbInitialized = true;
}
// ==================== تهيئة قاعدة البيانات ========================
// ==================== تهيئة قاعدة البيانات (مُحسّنة لتجنب خطأ الـ 50 طلب) ========================
async function initializeDatabase(env) {
  const client = getTursoClient(env);

  // 1. تجميع كل أوامر إنشاء الجداول والفهارس والإعدادات في دفعة واحدة (Batch)
  const createBatch = [
    `CREATE TABLE IF NOT EXISTS daily_product_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, sale_date DATE NOT NULL,
      total_quantity REAL DEFAULT 0, total_revenue REAL DEFAULT 0, total_cost REAL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(product_id, sale_date)
    )`,
    `CREATE TABLE IF NOT EXISTS monthly_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT, year_month TEXT NOT NULL UNIQUE,
      total_sales REAL DEFAULT 0, total_cost REAL DEFAULT 0, total_profit REAL DEFAULT 0,
      invoice_count INTEGER DEFAULT 0, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS aging_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
      age_days INTEGER NOT NULL, total_balance REAL DEFAULT 0, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(entity_type, entity_id, age_days)
    )`,
    `CREATE TABLE IF NOT EXISTS accounting_closures (
      id INTEGER PRIMARY KEY AUTOINCREMENT, closing_date DATE NOT NULL, entry_id INTEGER NOT NULL,
      retained_earnings REAL DEFAULT 0, closed_by INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sales_created_status ON sales(created_at, status)`,
    `CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)`,
    `CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)`,
    `CREATE INDEX IF NOT EXISTS idx_online_orders_driver ON online_orders(assigned_driver_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_online_orders_date ON online_orders(order_date)`,
    `CREATE TABLE IF NOT EXISTS product_supplier_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL,
      quantity REAL NOT NULL DEFAULT 0, last_purchase_price REAL, total_purchased REAL DEFAULT 0,
      total_returned REAL DEFAULT 0, supplier_sku TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id), FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
      UNIQUE(product_id, supplier_id)
    )`,
    `CREATE TABLE IF NOT EXISTS online_order_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, reason TEXT,
      total_refund REAL NOT NULL DEFAULT 0, refund_method TEXT NOT NULL DEFAULT 'cash', wallet_id INTEGER,
      status TEXT DEFAULT 'pending', assigned_driver_id INTEGER, delivery_fee_return REAL DEFAULT 0,
      delivery_fee_type TEXT DEFAULT 'shop', cash_refund REAL DEFAULT 0, wallet_refund REAL DEFAULT 0,
      confirmed_at DATETIME, confirmed_by INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      return_fee REAL DEFAULT 0, return_fee_type TEXT DEFAULT 'customer',
      FOREIGN KEY (order_id) REFERENCES online_orders(id)
    )`,
    `CREATE TABLE IF NOT EXISTS online_order_return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, return_id INTEGER NOT NULL, order_item_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL, quantity REAL NOT NULL, unit_price REAL NOT NULL, line_total REAL NOT NULL,
      FOREIGN KEY (return_id) REFERENCES online_order_returns(id), FOREIGN KEY (order_item_id) REFERENCES online_order_items(id)
    )`,
    `CREATE TABLE IF NOT EXISTS fcm_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT, driver_id INTEGER, token TEXT NOT NULL UNIQUE,
      device_info TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (driver_id) REFERENCES drivers(id)
    )`,
    `CREATE TABLE IF NOT EXISTS admin_fcm_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, device_info TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, supplier_id INTEGER,
      quantity_change REAL NOT NULL, old_quantity REAL NOT NULL, new_quantity REAL NOT NULL,
      reference_type TEXT NOT NULL, reference_id INTEGER, note TEXT, created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (product_id) REFERENCES products(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stock_movements_date ON stock_movements(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_stock_movements_ref ON stock_movements(reference_type, reference_id)`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('next_product_code', '1')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('allow_below_cost', '0')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('allow_negative_stock', '0')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('allow_expired_negative_sales', '1')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('closed_until_date', '')`
  ];

  await client.batch(createBatch.map(sql => ({ sql, args: [] })), 'write');
  invalidateSettingsCache();

  // 2. فحص الأعمدة المفقودة في كل الجداول بطلب فرعي واحد فقط
  const tablesToCheck = [
    'products', 'suppliers', 'sale_items', 'online_orders', 
    'online_order_items', 'online_order_returns', 'driver_transactions', 'purchase_invoices'
  ];
  
  // دمج استعلامات PRAGMA باستخدام UNION ALL لتقليل عدد الطلبات
  const unionSql = tablesToCheck.map(t => `SELECT '${t}' as tbl, name FROM pragma_table_info('${t}')`).join(' UNION ALL ');
  
  const colsResult = await client.execute(unionSql);
  const existingCols = {};
  
  colsResult.rows.forEach(row => {
    if (!existingCols[row.tbl]) existingCols[row.tbl] = new Set();
    existingCols[row.tbl].add(row.name);
  });

  // 3. قائمة بكل الأعمدة المطلوبة
  const columnsToAdd = [
    { table: 'products', col: 'product_code', type: 'TEXT' },
    { table: 'products', col: 'unit_type', type: "TEXT DEFAULT 'piece'" },
    { table: 'products', col: 'unit_symbol', type: "TEXT DEFAULT 'قطعة'" },
    { table: 'products', col: 'is_decimal_allowed', type: 'INTEGER DEFAULT 0' },
    { table: 'products', col: 'weight_grams', type: 'REAL' },
    { table: 'products', col: 'expiry_date', type: 'DATE' },
    { table: 'suppliers', col: 'sku_prefix', type: 'TEXT' },
    { table: 'sale_items', col: 'supplier_id', type: 'INTEGER' },
    { table: 'sale_items', col: 'supplier_price', type: 'REAL' },
    { table: 'sale_items', col: 'discount', type: 'REAL DEFAULT 0' },
    { table: 'online_orders', col: 'actual_collected', type: 'REAL DEFAULT 0' },
    { table: 'online_orders', col: 'order_date', type: 'DATETIME' },
    { table: 'online_order_items', col: 'discount', type: 'REAL DEFAULT 0' },
    { table: 'online_order_returns', col: 'status', type: "TEXT DEFAULT 'pending'" },
    { table: 'online_order_returns', col: 'assigned_driver_id', type: 'INTEGER' },
    { table: 'online_order_returns', col: 'delivery_fee_return', type: 'REAL DEFAULT 0' },
    { table: 'online_order_returns', col: 'delivery_fee_type', type: "TEXT DEFAULT 'shop'" },
    { table: 'online_order_returns', col: 'cash_refund', type: 'REAL DEFAULT 0' },
    { table: 'online_order_returns', col: 'wallet_refund', type: 'REAL DEFAULT 0' },
    { table: 'online_order_returns', col: 'confirmed_at', type: 'DATETIME' },
    { table: 'online_order_returns', col: 'confirmed_by', type: 'INTEGER' },
    { table: 'online_order_returns', col: 'return_fee', type: 'REAL DEFAULT 0' },
    { table: 'online_order_returns', col: 'return_fee_type', type: "TEXT DEFAULT 'customer'" },
    { table: 'driver_transactions', col: 'payment_method', type: 'TEXT' },
    { table: 'driver_transactions', col: 'wallet_id', type: 'INTEGER' },
    { table: 'driver_transactions', col: 'cash_amount', type: 'REAL DEFAULT 0' },
    { table: 'driver_transactions', col: 'wallet_amount', type: 'REAL DEFAULT 0' },
    { table: 'purchase_invoices', col: 'cash_paid', type: 'REAL DEFAULT 0' },
    { table: 'purchase_invoices', col: 'wallet_paid', type: 'REAL DEFAULT 0' },
    { table: 'purchase_invoices', col: 'cash_currency_id', type: 'INTEGER' },
    { table: 'purchase_invoices', col: 'wallet_currency_id', type: 'INTEGER' }
  ];

  // 4. بناء دفعات (Batches) لتنفيذ أي أعمدة ناقصة
  const alterBatch = [];
  for (const c of columnsToAdd) {
    if (existingCols[c.table] && !existingCols[c.table].has(c.col)) {
      alterBatch.push({ sql: `ALTER TABLE ${c.table} ADD COLUMN ${c.col} ${c.type}`, args: [] });
    }
  }

  // إرسال الأعمدة الجديدة كدفعة واحدة (بحد أقصى 20 أمر لكل دفعة للأمان)
  if (alterBatch.length > 0) {
    for (let i = 0; i < alterBatch.length; i += 20) {
      await client.batch(alterBatch.slice(i, i + 20), 'write');
    }
  }
}
// ==================== دوال FCM (إشعارات) ====================
// ==================== دوال الإشعارات (FCM) ====================
async function getFirebaseAuthToken(env) {
  if (fcmTokenCache.token && Date.now() < fcmTokenCache.expiry) {
    return fcmTokenCache.token;
  }

   const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env.FIREBASE_PRIVATE_KEY;
  if (!clientEmail || !privateKey) {
    throw new Error('❌ FIREBASE_CLIENT_EMAIL أو FIREBASE_PRIVATE_KEY غير معرّفين');
  }

  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const base64url = (str) => btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const encodeText = (txt) => new TextEncoder().encode(txt);
  const unsignedToken = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  
  const pemContents = privateKey.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
  const binaryDerString = atob(pemContents);
  const binaryDer = new Uint8Array(binaryDerString.length);
  for (let i = 0; i < binaryDerString.length; i++) binaryDer[i] = binaryDerString.charCodeAt(i);

  const key = await crypto.subtle.importKey("pkcs8", binaryDer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encodeText(unsignedToken));
  const jwt = `${unsignedToken}.${base64url(String.fromCharCode(...new Uint8Array(signature)))}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  const data = await response.json();
  const accessToken = data.access_token;

  fcmTokenCache.token = accessToken;
  fcmTokenCache.expiry = Date.now() + 55 * 60 * 1000;
  return accessToken;
}

// إرسال إشعار للمندوبين
// 修改后的 sendFCMNotification 返回详细结果
// إرسال إشعار للمندوبين (معدلة لتدعم الإرسال لمندوب محدد)
async function sendFCMNotification(env, title, body, imageUrl = null, link = "https://pos.ibnalmukhtar.com/driver/", targetDriverId = null, orderId = null) {
  try {
    const accessToken = await getFirebaseAuthToken(env);
    const projectId = env.FIREBASE_PROJECT_ID;
    if (!projectId) throw new Error('❌ FIREBASE_PROJECT_ID غير معرّف');

    const client = getTursoClient(env);
    
    let query = "SELECT token FROM fcm_tokens";
    let params = [];
    if (targetDriverId) {
      query += " WHERE driver_id = ?";
      params.push(targetDriverId);
    }

    const tokens = await dbAll(client, query, params);
    if (!tokens || tokens.length === 0) {
      console.log(`ℹ️ لا توجد توكنات مسجلة ${targetDriverId ? 'لهذا المندوب' : 'للمندوبين'}`);
      return { success: false, message: 'لا توجد توكنات مسجلة', details: [] };
    }

    console.log(`🔍 جاري إرسال الإشعار إلى ${tokens.length} جهاز`);

    // -----------------------------------------------------------
    // 🔑 الإصلاح 1: استخراج order_id من الرابط إن لم يُمرر صراحة
    // -----------------------------------------------------------
    let explicitOrderId = orderId;
    if (!explicitOrderId) {
      try {
        const urlObj = new URL(link);
        explicitOrderId = urlObj.searchParams.get('order_id') || urlObj.searchParams.get('order');
      } catch {}
    }
    const orderIdStr = explicitOrderId ? String(explicitOrderId) : null;

    // -----------------------------------------------------------
    // 🔑 الإصلاح 2: بناء payload صالح 100% لـ FCM HTTP v1
    //    - جميع قيم data يجب أن تكون strings (null يسبب خطأ 400)
    //    - إضافة android.priority = high إلزامي لأندرويد
    //    - إضافة TTL للطبقتين (webpush + android)
    // -----------------------------------------------------------
    const notification = { title, body };
    if (imageUrl) notification.image = imageUrl;

    // حقل data: قيم strings فقط - لا null أبدًا
    const data = {
      title,
      body,
      link
    };
    if (orderIdStr) data.order_id = orderIdStr;

    const payload = {
      notification,
      data,
      webpush: {
        notification: {
          icon: "https://pos.ibnalmukhtar.com/icon-512x512.png"
        },
        headers: {
          "TTL": "86400"  // صلاحية الرسالة 24 ساعة
        },
        fcm_options: { link }
      },
      android: {
        priority: "high",     // 🔑 ضروري: بدونها تتأخر الرسائل أو تُحذف عند التطبيق مغلق
        ttl: "86400s",        // صلاحية الرسالة على أندرويد
        notification: {
          icon: "https://pos.ibnalmukhtar.com/icon-512x512.png"
        }
      }
    };

    const promises = tokens.map(row => {
      // 🔑 الإصلاح 3: حذف التوكنات الباطلة من قاعدة البيانات تلقائيًا
      // إذا رفض FCM التوكن (NotFound/InvalidArgument)
      const messagePayload = {
        token: row.token,
        ...payload
      };
      return fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: messagePayload })
      })
      .then(async res => {
        if (!res.ok) {
          const errText = await res.text();
          console.warn(`⚠️ FCM رفض التوكن ${row.token.slice(0, 20)}...: HTTP ${res.status} - ${errText.slice(0, 200)}`);
          // حذف التوكن الباطل تلقائيًا (NotFound أو InvalidArgument تعني توكن منتهي)
          if (res.status === 404 || res.status === 400) {
            dbRun(client, "DELETE FROM fcm_tokens WHERE token = ?", [row.token]).catch(() => {});
          }
          return { status: res.status, error: errText };
        }
        return { status: res.status, ok: true };
      })
      .catch(err => {
        console.error(`❌ خطأ في إرسال الإشعار:`, err);
        return { status: 0, error: String(err) };
      });
    });

    const resultsAll = await Promise.allSettled(promises);
    const failures = resultsAll
      .filter(r => r.status === 'fulfilled' && r.value && !r.value.ok)
      .map(r => r.value);
    const errors = resultsAll.filter(r => r.status === 'rejected');

    if (errors.length > 0) {
      console.error(`❌ فشل إرسال ${errors.length} إشعارات:`, errors.map(e => e.reason));
    }
    if (failures.length > 0) {
      console.warn(`⚠️ ${failures.length} إشعار رفضه FCM:`, failures.map(f => f.error).slice(0, 5));
    }

    return { 
      success: errors.length === 0 && failures.length === 0, 
      message: errors.length === 0 && failures.length === 0 
        ? `تم إرسال الإشعار إلى ${tokens.length} جهاز` 
        : `أرسل ${tokens.length - failures.length} من ${tokens.length} (فشل ${failures.length})`,
      details: resultsAll.map(r => r.status === 'fulfilled' ? r.value : r.reason)
    };
  } catch (e) {
    console.error('❌ خطأ في sendFCMNotification:', e);
    return { success: false, message: e.message, details: [] };
  }
}



// إرسال إشعار للمشرفين
async function sendAdminFCMNotification(env, title, body, link = "https://pos.ibnalmukhtar.com/orders.html") {
  try {
    const accessToken = await getFirebaseAuthToken(env);
    const projectId = env.FIREBASE_PROJECT_ID;
    if (!projectId) throw new Error('❌ FIREBASE_PROJECT_ID غير معرّف');

    const client = getTursoClient(env);
    const tokens = await dbAll(client, "SELECT token FROM admin_fcm_tokens");
    if (!tokens || tokens.length === 0) {
      console.warn('⚠️ لا توجد توكنات مشرفين مسجلة');
      return { success: false, error: 'No admin tokens' };
    }

    const notification = { title, body };

    const payload = {
      notification,
      webpush: {
        notification: { icon: "https://pos.ibnalmukhtar.com/icon-512x512.png" },
        headers: { "TTL": "86400" },
        fcm_options: { link }
      },
      android: {
        priority: "high",
        ttl: "86400s",
        notification: {
          icon: "https://pos.ibnalmukhtar.com/icon-512x512.png"
        }
      }
    };

    const results = await Promise.allSettled(tokens.map(row => {
      return fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: {
            token: row.token,
            ...payload
          }
        })
      })
      .then(async res => {
        if (!res.ok) {
          const errText = await res.text();
          if (res.status === 404 || res.status === 400) {
            dbRun(client, "DELETE FROM admin_fcm_tokens WHERE token = ?", [row.token]).catch(() => {});
          }
          return { ok: false, status: res.status };
        }
        return { ok: true, status: res.status };
      })
      .catch(err => {
        console.error('❌ خطأ في إرسال إشعار مشرف:', err);
        return { ok: false, status: 0 };
      });
    }));

    const failed = results.filter(r => r.status === 'fulfilled' && r.value && !r.value.ok);
    const successCount = results.filter(r => r.status === 'fulfilled' && r.value && r.value.ok).length;

    if (failed.length > 0) {
      console.error(`❌ فشل إرسال ${failed.length} إشعارات مشرفين`);
    }
    return { success: failed.length === 0, total: tokens.length, sent: successCount, failed: failed.length };
  } catch (e) {
    console.error('❌ خطأ في sendAdminFCMNotification:', e);
    return { success: false, error: e.message };
  }
}
// ==================== الملخص اليومي ==============================
async function sendDailySummary(env) {
  try {
    const client = getTursoClient(env);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Aden' });
    const salesData = await client.execute(
      `SELECT SUM(total_amount) as total_sales, COUNT(*) as invoices_count 
       FROM sales 
       WHERE date(created_at) = ? AND status = 'completed'`,
      [today]
    );
    const totalSales = Number(salesData.rows[0]?.total_sales) || 0;
    const invoicesCount = Number(salesData.rows[0]?.invoices_count) || 0;

    const paymentSplit = await client.execute(
      `SELECT payment_method, SUM(total_amount) as total 
       FROM sales 
       WHERE date(created_at) = ? AND status = 'completed' 
       GROUP BY payment_method`,
      [today]
    );
    let cashSales = 0, walletSales = 0, creditSales = 0;
    for (const row of paymentSplit.rows) {
      if (row.payment_method === 'cash') cashSales = Number(row.total) || 0;
      else if (row.payment_method === 'wallet') walletSales = Number(row.total) || 0;
      else if (row.payment_method === 'credit') creditSales = Number(row.total) || 0;
    }

    const cogsData = await client.execute(
      `SELECT SUM(si.cost_price * (si.quantity - COALESCE(rs.returned_qty, 0))) as total_cogs
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       LEFT JOIN (
         SELECT sale_id, product_id, SUM(quantity) as returned_qty
         FROM returned_sales
         GROUP BY sale_id, product_id
       ) rs ON rs.sale_id = si.sale_id AND rs.product_id = si.product_id
       WHERE date(s.created_at) = ? AND s.status = 'completed'`,
      [today]
    );
    const totalCogs = Number(cogsData.rows[0]?.total_cogs) || 0;
    const grossProfit = totalSales - totalCogs;

    const expData = await client.execute(
      `SELECT SUM(amount) as total_exp FROM expenses WHERE date(created_at) = ?`,
      [today]
    );
    const totalExpenses = Number(expData.rows[0]?.total_exp) || 0;
    const netProfit = grossProfit - totalExpenses;

    const message = `📊 *ملخص يومي - نظام ابن المختار* 📊\n`
                  + `📅 التاريخ: ${today}\n`
                  + `🧾 عدد الفواتير: ${invoicesCount}\n\n`
                  + `━━━━━━━━━━━━━━━━━━━\n`
                  + `💵 *إجمالي المبيعات*: ${totalSales.toFixed(2)} ريال\n`
                  + `   ├─ نقدي: ${cashSales.toFixed(2)} ريال\n`
                  + `   ├─ محفظة: ${walletSales.toFixed(2)} ريال\n`
                  + `   └─ آجل: ${creditSales.toFixed(2)} ريال\n`
                  + `━━━━━━━━━━━━━━━━━━━\n`
                  + `📦 *تكلفة البضاعة*: ${totalCogs.toFixed(2)} ريال\n`
                  + `💰 *الربح الإجمالي*: ${grossProfit.toFixed(2)} ريال\n`
                  + `📉 *إجمالي المصروفات*: ${totalExpenses.toFixed(2)} ريال\n`
                  + `━━━━━━━━━━━━━━━━━━━\n`
                  + `🏆 *صافي الربح*: ${netProfit.toFixed(2)} ريال\n\n`
                  + `نسأل الله لكم البركة والتوفيق 🌹`;

    const botToken = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    if (botToken && chatId) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' })
      });
    }
    const waRecipients = [
      //{ phone: "967773266534", apikey: "9236591" },
      { phone: "967772328326", apikey: "9582527" }
    ];
    for (const wa of waRecipients) {
      const waUrl = `https://api.callmebot.com/whatsapp.php?phone=${wa.phone}&text=${encodeURIComponent(message)}&apikey=${wa.apikey}`;
      await fetch(waUrl, { method: 'GET' }).catch(() => {});
    }
  } catch (error) {
    console.error("خطأ في sendDailySummary:", error.message);
  }
}

async function updateDailyProductStats(client, day = new Date(Date.now() - 86400000).toISOString().slice(0,10)) {
  await dbRun(client,'DELETE FROM daily_product_stats WHERE sale_date=?',[day]);
  await dbRun(client,`INSERT INTO daily_product_stats(product_id,sale_date,total_quantity,total_revenue,total_cost) SELECT si.product_id,?,SUM(si.quantity),SUM(si.total_price),SUM(COALESCE(si.cost_price,0)*si.quantity) FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status='completed' AND date(s.created_at)=? GROUP BY si.product_id`,[day,day]); reportCache.clear();
}
async function updateMonthlySummary(client, month = new Date().toISOString().slice(0,7)) {
  await dbRun(client, 'DELETE FROM monthly_summary WHERE year_month=?', [month]);
  await dbRun(client, `INSERT INTO monthly_summary(year_month,total_sales,total_cost,total_profit,invoice_count)
    SELECT ?,
      COALESCE((SELECT SUM(total_amount) FROM sales WHERE status='completed' AND strftime('%Y-%m',created_at)=?),0),
      COALESCE((SELECT SUM(COALESCE(si.cost_price,0)*si.quantity) FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status='completed' AND strftime('%Y-%m',s.created_at)=?),0),
      COALESCE((SELECT SUM(total_amount) FROM sales WHERE status='completed' AND strftime('%Y-%m',created_at)=?),0)-COALESCE((SELECT SUM(COALESCE(si.cost_price,0)*si.quantity) FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status='completed' AND strftime('%Y-%m',s.created_at)=?),0),
      (SELECT COUNT(*) FROM sales WHERE status='completed' AND strftime('%Y-%m',created_at)=?)`, [month,month,month,month,month,month]);
  reportCache.clear();
}
async function updateAgingSummary(client) { await dbRun(client,'DELETE FROM aging_summary'); const entities=[['customers','customers'],['suppliers','suppliers']]; for(const [type,table] of entities) await dbRun(client,`INSERT INTO aging_summary(entity_type,entity_id,age_days,total_balance) SELECT ?,id,CASE WHEN julianday('now')-julianday(COALESCE(created_at,'now'))<=30 THEN 30 WHEN julianday('now')-julianday(COALESCE(created_at,'now'))<=60 THEN 60 WHEN julianday('now')-julianday(COALESCE(created_at,'now'))<=90 THEN 90 ELSE 120 END,COALESCE(balance,0) FROM ${table} WHERE COALESCE(balance,0)<>0`,[type]); reportCache.clear(); }

// ==================== المجدول =====================================
async function scheduled(event, env, ctx) {
  console.log("⏰ تم تشغيل المجدول في:", new Date().toISOString());
  ctx.waitUntil((async () => {
    await sendDailySummary(env);
    try { const c = getTursoClient(env); await updateDailyProductStats(c); await updateMonthlySummary(c); await updateAgingSummary(c); } catch (e) { console.error('فشل تحديث الجداول الملخصة:', e.message); }
  })());
}

// ==================== دوال مساعدة عامة ============================
function rowsToObjects(result) {
  const columns = result.columns;
  return result.rows.map(row => {
    const obj = {};
    columns.forEach((col, idx) => { obj[col] = row[idx]; });
    return obj;
  });
}
async function dbExecute(conn, sql, args = []) {
  return await conn.execute({ sql, args });
}
async function dbAll(conn, sql, args = []) {
  const result = await dbExecute(conn, sql, args);
  return rowsToObjects(result);
}
async function dbFirst(conn, sql, args = []) {
  const result = await dbExecute(conn, sql, args);
  if (result.rows.length === 0) return null;
  return rowsToObjects(result)[0];
}
async function dbRun(conn, sql, args = []) {
  const result = await dbExecute(conn, sql, args);
  const id = result.lastInsertRowid !== undefined ? Number(result.lastInsertRowid) : 0;
  return { lastInsertRowid: id, changes: result.rowsAffected || 0 };
}

// ==================== دوال مساعدة للموردين ====================
async function deductSupplierStock(tx, productId, quantityToDeduct) {
  return { queries: [], deductions: [] };
}
async function restoreSupplierStock(tx, productId, supplierId, quantity, unitPrice = 0) {
  return [];
}

// ==================== تسجيل حركة المخزون (موحّد) ====================
// delta: موجب = دخول للمخزون، سالب = خروج من المخزون
// stockCache: object يُمرَّر من المستدعي، يُستخدم لتفادي قراءة نفس المنتج
//             أكثر من مرة عندما يتكرر نفس product_id عدة مرات ضمن نفس العملية
async function applyStockChange(tx, batchQueries, {
  productId,
  supplierId = null,
  delta,
  referenceType,
  referenceId = null,
  note = '',
  userId = null,
  stockCache = null
}) {
  let oldQty;
  if (stockCache && Object.prototype.hasOwnProperty.call(stockCache, productId)) {
    oldQty = stockCache[productId];
  } else {
    const row = await dbFirst(tx, "SELECT stock_quantity FROM products WHERE id = ?", [productId]);
    if (!row) throw new Error(`المنتج ${productId} غير موجود`);
    oldQty = parseFloat(row.stock_quantity) || 0;
  }
  const newQty = oldQty + delta;
  if (stockCache) stockCache[productId] = newQty;

  batchQueries.push({
    sql: "UPDATE products SET stock_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    args: [newQty, productId]
  });
  batchQueries.push({
    sql: `INSERT INTO stock_movements
          (product_id, supplier_id, quantity_change, old_quantity, new_quantity, reference_type, reference_id, note, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [productId, supplierId, delta, oldQty, newQty, referenceType, referenceId, note, userId]
  });
  return newQty;
}

// ==================== التشفير والمصادقة ===========================
async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
async function createJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = btoa(JSON.stringify(header)).replace(/=+$/, '');
  const encodedPayload = btoa(JSON.stringify(payload)).replace(/=+$/, '');
  const data = `${encodedHeader}.${encodedPayload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${data}.${encodedSignature}`;
}
async function verifyToken(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.split(' ')[1];
  if (token === env.STOCK_API_TOKEN) return true;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const data = `${encodedHeader}.${encodedPayload}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const binarySig = atob(encodedSignature.replace(/-/g, '+').replace(/_/g, '/'));
    const signature = Uint8Array.from(binarySig, c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(data));
    if (!valid) return false;
    const payload = JSON.parse(atob(encodedPayload));
    if (payload.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}
async function getCurrentUser(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.split(' ')[1];
  if (token === env.STOCK_API_TOKEN) return { role: 'admin' };
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    return { id: payload.userId, username: payload.username, role: payload.role };
  } catch {
    return null;
  }
}

// ==================== دوال محاسبية مساعدة =========================
const cache = {
  accounts: new Map(),
  baseCurrency: null,
  currencyRates: new Map()
};

function invalidateCurrencyCache() {
  cache.baseCurrency = null;
  cache.currencyRates.clear();
}

async function getCurrencyRate(conn, currencyId) {
  if (cache.currencyRates.has(currencyId)) return cache.currencyRates.get(currencyId);
  const row = await dbFirst(conn, "SELECT rate_to_base FROM currencies WHERE id = ?", [currencyId]);
  if (row) cache.currencyRates.set(currencyId, row.rate_to_base);
  return row ? row.rate_to_base : null;
}
async function getBaseCurrency(conn) {
  if (cache.baseCurrency) return cache.baseCurrency;
  const row = await dbFirst(conn, "SELECT id, rate_to_base FROM currencies WHERE is_base = 1");
  if (row) cache.baseCurrency = row;
  return row;
}
function convertToBase(amount, rate) { return amount * rate; }
function convertFromBase(amount, rate) { return amount / rate; }
async function getAccountId(conn, name) {
  if (cache.accounts.has(name)) return cache.accounts.get(name);
  const row = await dbFirst(conn, "SELECT id FROM accounts WHERE name = ?", [name]);
  if (!row) throw new Error(`الحساب "${name}" غير موجود`);
  cache.accounts.set(name, row.id);
  return row.id;
}
// ===== إصلاح #5: رفض القيم غير المنتظمة (NaN/Infinity) التي كانت تمر بصمت =====
function checkBalance(details) {
  for (const d of details) {
    if (!Number.isFinite(d.debit) || !Number.isFinite(d.credit)) {
      throw new Error('القيد يحتوي مبالغ غير صالحة (NaN/Infinity)');
    }
  }
  const balance = details.reduce((sum, d) => sum + (d.debit - d.credit), 0);
  if (Math.abs(balance) > 0.001) throw new Error("القيد غير متوازن");
}
async function createJournalEntry(conn, entryDate, description, details, referenceType = null, referenceId = null) {
  checkBalance(details);
  const entryResult = await dbRun(conn,
    `INSERT INTO journal_entries (entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?)`,
    [entryDate, description, referenceType, referenceId]
  );
  const entryId = entryResult.lastInsertRowid;
  if (details.length > 0) {
    const detailQueries = details.map(detail => ({
      sql: `INSERT INTO journal_entry_details (entry_id, account_id, debit, credit, notes) VALUES (?, ?, ?, ?, ?)`,
      args: [entryId, detail.account_id, detail.debit || 0, detail.credit || 0, detail.notes || '']
    }));
    // تقسيم الدفعة إلى أجزاء لا تتجاوز 40 استعلامًا لتجنب حد 50 استعلامًا في الطلب الواحد
    const BATCH_SIZE = 40;
    for (let i = 0; i < detailQueries.length; i += BATCH_SIZE) {
      await conn.batch(detailQueries.slice(i, i + BATCH_SIZE), 'write');
    }
  }
  return entryId;
}
function normalizePaymentMethod(paymentMethod) {
  if (!paymentMethod) return paymentMethod;
  const lower = paymentMethod.toLowerCase().trim();
  if (lower.includes('مختلط') || lower.includes('mixed')) return 'مختلط';
  if (lower.includes('مدفوع مسبق') || lower.includes('prepaid') || lower.includes('مدفوع مقدم')) return 'مدفوع مسبقاً';
  return paymentMethod;
}
function isPrepaidOrder(order) {
  if (!order || !order.payment_method) return false;
  const method = order.payment_method.toLowerCase().trim();
  return method.includes('مدفوع مسبق') || method.includes('prepaid') || method.includes('مدفوع مقدم');
}
// إصلاح #10: دالة مساعدة لتمييز الطلبات المختلطة (محفظة أصلًا + نقد عند الاستلام)
function isMixedOrder(order) {
  if (!order || !order.payment_method) return false;
  const method = order.payment_method.toLowerCase().trim();
  return method.includes('mixed') || method.includes('مختلط');
}
async function addColumnIfNotExists(conn, tableName, columnName, columnType) {
  const tableInfo = await dbAll(conn, `PRAGMA table_info(${tableName})`);
  const exists = tableInfo.some(col => col.name === columnName);
  if (!exists) {
    await dbExecute(conn, `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
}
async function getRemainingQty(conn, saleId, productId) {
  const returned = await dbFirst(conn,
    "SELECT SUM(quantity) as returned_qty FROM returned_sales WHERE sale_id = ? AND product_id = ?",
    [saleId, productId]
  );
  return returned?.returned_qty || 0;
}
async function getOrCreateAccount(conn, name, code, type, parent_id = null) {
  let account = await dbFirst(conn, "SELECT id FROM accounts WHERE name = ?", [name]);
  if (!account) {
    const result = await dbRun(conn,
      "INSERT INTO accounts (name, code, parent_id, type, is_active) VALUES (?, ?, ?, ?, 1)",
      [name, code, parent_id, type]
    );
    account = { id: result.lastInsertRowid };
  }
  return account.id;
}
async function getOrCreateFeeAccount(conn) {
  return await getOrCreateAccount(conn, 'رسوم التحويل', '6205', 'expense');
}
async function ensureWalletBalance(conn, walletId, currencyId) {
  const existing = await dbFirst(conn,
    "SELECT id FROM wallet_balances WHERE wallet_id = ? AND currency_id = ?",
    [walletId, currencyId]
  );
  if (!existing) {
    await dbRun(conn,
      "INSERT INTO wallet_balances (wallet_id, currency_id, balance) VALUES (?, ?, 0)",
      [walletId, currencyId]
    );
  }
}
async function updateWalletBalance(conn, walletId, currencyId, amount, operation = 'add') {
  await ensureWalletBalance(conn, walletId, currencyId);
  const sign = operation === 'add' ? 1 : -1;
  await dbRun(conn,
    `UPDATE wallet_balances SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP
     WHERE wallet_id = ? AND currency_id = ?`,
    [sign * amount, walletId, currencyId]
  );
  const newBalance = await dbFirst(conn,
    "SELECT balance FROM wallet_balances WHERE wallet_id = ? AND currency_id = ?",
    [walletId, currencyId]
  );
  if (newBalance && newBalance.balance < -0.001) {
    throw new Error(`رصيد غير كافٍ في المحفظة (العملة: ${currencyId})`);
  }
}

// ================================================================
// ==================== دوال API ==================================
// ================================================================

// ---- العملات ----
async function getCurrencies(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, "SELECT * FROM currencies ORDER BY code");
  return jsonResponse({ currencies: rows }, 200, headers);
}
async function createCurrency(request, env, headers) {
  const { code, name, rate_to_base, is_base } = await request.json();
  if (!code || !name || rate_to_base === undefined || rate_to_base <= 0) {
    return jsonResponse({ error: 'الرمز، الاسم وسعر الصرف الموجب مطلوبة' }, 400, headers);
  }
  const client = getTursoClient(env);
  if (is_base) await dbRun(client, "UPDATE currencies SET is_base = 0");
  const result = await dbRun(client,
    "INSERT INTO currencies (code, name, rate_to_base, is_base) VALUES (?, ?, ?, ?)",
    [code, name, rate_to_base, is_base ? 1 : 0]
  );
  invalidateCurrencyCache();
  return jsonResponse({ success: true, id: result.lastInsertRowid }, 200, headers);
}
async function updateCurrency(request, env, headers) {
  const id = parseInt(request.url.split('/').pop());
  const { rate_to_base, is_base } = await request.json();
  const client = getTursoClient(env);
  const curr = await dbFirst(client, "SELECT id FROM currencies WHERE id = ?", [id]);
  if (!curr) return jsonResponse({ error: 'العملة غير موجودة' }, 404, headers);
  if (is_base) await dbRun(client, "UPDATE currencies SET is_base = 0");
  await dbRun(client,
    "UPDATE currencies SET rate_to_base = ?, is_base = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [rate_to_base, is_base ? 1 : 0, id]
  );
  invalidateCurrencyCache();
  return jsonResponse({ success: true }, 200, headers);
}
async function deleteCurrency(request, env, headers) {
  const id = parseInt(request.url.split('/').pop());
  const client = getTursoClient(env);
  const curr = await dbFirst(client, "SELECT is_base FROM currencies WHERE id = ?", [id]);
  if (!curr) return jsonResponse({ error: 'العملة غير موجودة' }, 404, headers);
  if (curr.is_base) return jsonResponse({ error: 'لا يمكن حذف العملة الأساسية' }, 400, headers);
  await dbRun(client, "DELETE FROM currencies WHERE id = ?", [id]);
  invalidateCurrencyCache();
  return jsonResponse({ success: true }, 200, headers);
}

// ---- المستخدمين ----
async function handleLogin(request, env, headers) {
  try {
    const { username, password } = await request.json();
    console.log("Login attempt for:", username);
    if (!username || !password) return jsonResponse({ error: 'اسم المستخدم وكلمة المرور مطلوبة' }, 400, headers);
    const client = getTursoClient(env);
    let user = await dbFirst(client, "SELECT * FROM users WHERE username = ?", [username]);
    let role = user ? user.role : null;
    let userId = user ? user.id : null;
    if (!user) {
      const driver = await dbFirst(client, "SELECT * FROM drivers WHERE username = ? AND is_active = 1", [username]);
      if (driver) { user = driver; role = 'driver'; userId = driver.id; }
    }
    if (!user) return jsonResponse({ error: 'بيانات الدخول غير صحيحة' }, 401, headers);
    const hash = await hashPassword(password, user.salt);
    if (hash !== user.password_hash) return jsonResponse({ error: 'بيانات الدخول غير صحيحة' }, 401, headers);
    if (!env.JWT_SECRET) return jsonResponse({ error: 'إعدادات السيرفر غير مكتملة' }, 500, headers);
    const token = await createJWT({
      userId: userId,
      username: user.username,
      role: role,
      exp: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
    }, env.JWT_SECRET);
    return jsonResponse({
      success: true,
      token: token,
      user: { id: userId, username: user.username, role: role, name: user.name || user.username }
    }, 200, headers);
  } catch (error) {
    return jsonResponse({ error: 'حدث خطأ داخلي أثناء تسجيل الدخول' }, 500, headers);
  }
}
async function getUsers(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, "SELECT id, username, role, created_at FROM users ORDER BY id");
  return jsonResponse({ users: rows }, 200, headers);
}
async function createUser(request, env, headers) {
  const { username, password, role } = await request.json();
  if (!username || !password) return jsonResponse({ error: 'اسم المستخدم وكلمة المرور مطلوبة' }, 400, headers);
  const client = getTursoClient(env);
  const existing = await dbFirst(client, "SELECT id FROM users WHERE username = ?", [username]);
  if (existing) return jsonResponse({ error: 'اسم المستخدم موجود مسبقاً' }, 409, headers);
  const salt = crypto.randomUUID();
  const hash = await hashPassword(password, salt);
  const result = await dbRun(client,
    "INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)",
    [username, hash, salt, role || 'cashier']
  );
  return jsonResponse({ success: true, id: result.lastInsertRowid }, 200, headers);
}
async function updateUser(request, env, headers) {
  const id = parseInt(request.url.split('/').pop());
  const { password, role } = await request.json();
  const client = getTursoClient(env);
  const user = await dbFirst(client, "SELECT id FROM users WHERE id = ?", [id]);
  if (!user) return jsonResponse({ error: 'المستخدم غير موجود' }, 404, headers);
  const fields = [], values = [];
  if (password) {
    const salt = crypto.randomUUID();
    const hash = await hashPassword(password, salt);
    fields.push('password_hash = ?', 'salt = ?');
    values.push(hash, salt);
  }
  if (role) { fields.push('role = ?'); values.push(role); }
  if (fields.length === 0) return jsonResponse({ error: 'لا توجد بيانات للتحديث' }, 400, headers);
  values.push(id);
  await dbRun(client, `UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
  return jsonResponse({ success: true }, 200, headers);
}
async function deleteUser(request, env, headers) {
  const id = parseInt(request.url.split('/').pop());
  const client = getTursoClient(env);
  const user = await dbFirst(client, "SELECT id, role FROM users WHERE id = ?", [id]);
  if (!user) return jsonResponse({ error: 'المستخدم غير موجود' }, 404, headers);
  if (user.role === 'admin') {
    const adminCount = await dbFirst(client, "SELECT COUNT(*) as cnt FROM users WHERE role = 'admin'");
    if (adminCount.cnt <= 1) return jsonResponse({ error: 'لا يمكن حذف المدير الوحيد' }, 400, headers);
  }
  await dbRun(client, "DELETE FROM users WHERE id = ?", [id]);
  return jsonResponse({ success: true }, 200, headers);
}

// ---- التصنيفات ----
async function getCategories(request, env, headers) {
  const client = getTursoClient(env);
  const url = new URL(request.url);
  const flat = url.searchParams.get('flat');
  if (flat === '1') {
    const rows = await dbAll(client, "SELECT * FROM categories ORDER BY name");
    return jsonResponse({ categories: rows }, 200, headers);
  }
  const rows = await dbAll(client, `
    WITH RECURSIVE tree AS (
      SELECT id, name, parent_id, 0 AS level FROM categories WHERE parent_id IS NULL
      UNION ALL
      SELECT c.id, c.name, c.parent_id, t.level + 1
      FROM categories c JOIN tree t ON c.parent_id = t.id
    )
    SELECT * FROM tree ORDER BY level, name
  `);
  return jsonResponse({ categories: rows }, 200, headers);
}
async function createCategory(request, env, headers) {
  const { name, parent_id } = await request.json();
  if (!name) return jsonResponse({ error: 'اسم التصنيف مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const result = await dbRun(client, "INSERT INTO categories (name, parent_id) VALUES (?, ?)", [name, parent_id || null]);
  return jsonResponse({ success: true, id: result.lastInsertRowid }, 200, headers);
}
async function updateCategory(request, env, headers) {
  const id = parseInt(request.url.split('/').pop());
  const { name, parent_id } = await request.json();
  const client = getTursoClient(env);
  const cat = await dbFirst(client, "SELECT id FROM categories WHERE id = ?", [id]);
  if (!cat) return jsonResponse({ error: 'التصنيف غير موجود' }, 404, headers);
  await dbRun(client, "UPDATE categories SET name = ?, parent_id = ? WHERE id = ?", [name || cat.name, parent_id !== undefined ? parent_id : cat.parent_id, id]);
  return jsonResponse({ success: true }, 200, headers);
}
async function deleteCategory(request, env, headers) {
  const id = parseInt(request.url.split('/').pop());
  const client = getTursoClient(env);
  const productsCount = await dbFirst(client, "SELECT COUNT(*) as cnt FROM products WHERE category_id = ?", [id]);
  if (productsCount.cnt > 0) return jsonResponse({ error: 'لا يمكن حذف تصنيف يحتوي على منتجات' }, 400, headers);
  const children = await dbFirst(client, "SELECT COUNT(*) as cnt FROM categories WHERE parent_id = ?", [id]);
  if (children.cnt > 0) return jsonResponse({ error: 'لا يمكن حذف تصنيف يحتوي على تصنيفات فرعية' }, 400, headers);
  await dbRun(client, "DELETE FROM categories WHERE id = ?", [id]);
  return jsonResponse({ success: true }, 200, headers);
}

// ---- المنتجات ----
function isExpiredProductDate(expiryDate) {
  if (!expiryDate) return false;
  const parsed = new Date(String(expiryDate).length <= 10 ? `${expiryDate}T23:59:59` : expiryDate);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() < Date.now();
}

async function getProducts(request, env, headers) {
  const url = new URL(request.url);
  const search = url.searchParams.get('search') || '';
  const categoryId = url.searchParams.get('category_id');
  const sort = url.searchParams.get('sort') || 'name';
  const page = parseInt(url.searchParams.get('page')) || 1;
  const limit = parseInt(url.searchParams.get('limit')) || 100;
  const offset = (page - 1) * limit;
  const client = getTursoClient(env);

  let conditions = 'p.is_active = 1';
  const args = [];
  if (search) {
    conditions += ` AND (p.name LIKE ? OR p.barcode LIKE ? OR p.product_code LIKE ?)`;
    args.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (categoryId) {
    conditions += ` AND p.category_id = ?`;
    args.push(categoryId);
  }

  const mainSupplierSubquery = `
    (SELECT s.name FROM product_supplier_stock pss
     JOIN suppliers s ON s.id = pss.supplier_id
     WHERE pss.product_id = p.id
     ORDER BY pss.quantity DESC LIMIT 1) as main_supplier_name
  `;

  let orderBy = '';
  switch (sort) {
    case 'supplier':
      orderBy = `ORDER BY main_supplier_name, p.name`;
      break;
    case 'category':
      orderBy = `ORDER BY c.name, p.name`;
      break;
    case 'popularity':
      orderBy = `ORDER BY COALESCE(p.sales_count, 0) DESC, p.name`;
      break;
    case 'date':
      orderBy = `ORDER BY p.created_at DESC, p.name`;
      break;
    default:
      orderBy = `ORDER BY p.name`;
  }

  const sql = `
    SELECT p.*, c.name as category_name, ${mainSupplierSubquery}
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE ${conditions}
    ${orderBy}
    LIMIT ? OFFSET ?
  `;
  args.push(limit, offset);

  const countArgs = args.slice(0, -2);
  const countRow = await dbFirst(client, `SELECT COUNT(*) AS total FROM products p WHERE ${conditions}`, countArgs);
  const rows = await dbAll(client, sql, args);
  return jsonResponse({ products: rows, total: Number(countRow?.total || 0), page, limit }, 200, headers);
}

async function getProductSuppliers(request, env, headers) {
  const url = new URL(request.url);
  const productId = url.searchParams.get('product_id');
  if (!productId) {
    return jsonResponse({ error: 'معرف المنتج مطلوب' }, 400, headers);
  }
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT s.id, s.name, s.phone, s.address, 
           pss.supplier_sku, pss.quantity, pss.last_purchase_price
    FROM product_supplier_stock pss
    JOIN suppliers s ON s.id = pss.supplier_id
    WHERE pss.product_id = ?
    ORDER BY pss.quantity DESC
  `, [productId]);
  return jsonResponse({ suppliers: rows }, 200, headers);
}
async function getProductDetails(request, env, headers) {
  const id = parseInt(request.url.split('/').pop());
  const client = getTursoClient(env);
  const product = await dbFirst(client,
    `SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`,
    [id]
  );
  if (!product) return jsonResponse({ error: 'المنتج غير موجود' }, 404, headers);
  const sold = await dbFirst(client,
    `SELECT COALESCE(SUM(si.quantity - COALESCE(rs.returned_qty, 0)), 0) as sold
     FROM sale_items si
     LEFT JOIN (
       SELECT sale_id, product_id, SUM(quantity) as returned_qty
       FROM returned_sales
       GROUP BY sale_id, product_id
     ) rs ON rs.sale_id = si.sale_id AND rs.product_id = si.product_id
     WHERE si.product_id = ?`,
    [id]
  );
  product.sold_quantity = sold ? sold.sold : 0;
  return jsonResponse({ product }, 200, headers);
}
async function searchProducts(request, env, headers) {
  const url = new URL(request.url);
  const term = url.searchParams.get('term') || '';
  const client = getTursoClient(env);
  const rows = await dbAll(client,
    `SELECT id, name, barcode, product_code, price, cost, stock_quantity, category_id, unit_type, unit_symbol, is_decimal_allowed, weight_grams 
     FROM products 
     WHERE is_active = 1 AND (name LIKE ? OR barcode LIKE ? OR product_code LIKE ?) 
     LIMIT 20`,
    [`%${term}%`, `%${term}%`, `%${term}%`]
  );
  return jsonResponse({ results: rows }, 200, headers);
}
async function addProduct(request, env, headers) {
  const data = await request.json();
  if (!data.name) return jsonResponse({ error: 'اسم المنتج مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  
  // 1. توليد باركود فريد جداً إذا تركه المستخدم فارغاً
  let barcode = data.barcode;
  if (!barcode || barcode.toString().trim() === '') {
    // نستخدم الوقت بالملي ثانية + رقم عشوائي لضمان عدم التكرار
    barcode = new Date().getTime().toString().slice(-10) + Math.floor(Math.random() * 100).toString();
  }

  let categoryId = data.category_id || null;
  if (!categoryId && data.category) {
    let cat = await dbFirst(client, "SELECT id FROM categories WHERE name = ?", [data.category]);
    if (!cat) {
      const res = await dbRun(client, "INSERT INTO categories (name) VALUES (?)", [data.category]);
      cat = { id: res.lastInsertRowid };
    }
    categoryId = cat.id;
  }
  
  const tx = await client.transaction();
  try {
    // 2. 🌟 الحل الجذري لمشكلة 409 Conflict 🌟
    // جلب أعلى كود منتج موجود في قاعدة البيانات فعلياً، وتجاهل جدول الإعدادات
    const maxCodeRow = await dbFirst(tx, "SELECT MAX(CAST(product_code AS INTEGER)) as max_code FROM products WHERE product_code IS NOT NULL AND product_code != ''");
    
    let nextNum = 1;
    if (maxCodeRow && maxCodeRow.max_code) {
        nextNum = parseInt(maxCodeRow.max_code, 10) + 1;
    }
    const productCode = String(nextNum).padStart(4, '0');

    // 3. إدخال المنتج
    const result = await dbRun(tx,
      `INSERT INTO products (barcode, name, price, cost, stock_quantity, category, category_id, image_data, is_active, product_code, expiry_date, unit_type, unit_symbol, is_decimal_allowed, weight_grams)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      [barcode, data.name, data.price || 0, data.cost || 0, data.stock_quantity || 0, data.category || null, categoryId, data.image_data || null, productCode, data.expiry_date || null, data.unit_type || 'piece', data.unit_symbol || 'قطعة', data.is_decimal_allowed ? 1 : 0, data.weight_grams || null]
    );
    
    // 4. تحديث العداد في جدول الإعدادات للاحتياط فقط
    await dbRun(tx, "INSERT INTO settings (key, value) VALUES ('next_product_code', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [(nextNum + 1).toString()]);
    
    await tx.commit();
    invalidateSettingsCache();
    return jsonResponse({ success: true, id: result.lastInsertRowid, barcode, product_code: productCode }, 200, headers);
  } catch (e) {
    await tx.rollback();
    if (e.message && e.message.includes('UNIQUE constraint failed')) {
        return jsonResponse({ error: 'تعارض: الاسم أو الباركود مستخدم مسبقاً في النظام' }, 409, headers);
    }
    return jsonResponse({ error: e.message }, 500, headers);
  }
}
async function updateProduct(request, env, headers) {
  const url = new URL(request.url);
  const id = parseInt(url.pathname.split('/').pop());
  const data = await request.json();
  const client = getTursoClient(env);
  const product = await dbFirst(client, "SELECT id, category, category_id FROM products WHERE id = ? AND is_active = 1", [id]);
  if (!product) return jsonResponse({ error: 'المنتج غير موجود' }, 404, headers);
  const fields = [], values = [];
  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.price !== undefined) { fields.push('price = ?'); values.push(data.price); }
  if (data.cost !== undefined) { fields.push('cost = ?'); values.push(data.cost); }
  if (data.stock_quantity !== undefined) { fields.push('stock_quantity = ?'); values.push(data.stock_quantity); }
  if (data.category !== undefined) { fields.push('category = ?'); values.push(data.category); }
  if (data.category_id !== undefined) {
    fields.push('category_id = ?'); values.push(data.category_id);
    if (data.category === undefined && data.category_id) {
      const cat = await dbFirst(client, "SELECT name FROM categories WHERE id = ?", [data.category_id]);
      if (cat) { fields.push('category = ?'); values.push(cat.name); }
    }
  }
  if (data.image_data !== undefined) { fields.push('image_data = ?'); values.push(data.image_data); }
  if (data.expiry_date !== undefined) { fields.push('expiry_date = ?'); values.push(data.expiry_date || null); }
  if (data.unit_type !== undefined) { fields.push('unit_type = ?'); values.push(data.unit_type || 'piece'); }
  if (data.unit_symbol !== undefined) { fields.push('unit_symbol = ?'); values.push(data.unit_symbol || 'قطعة'); }
  if (data.is_decimal_allowed !== undefined) { fields.push('is_decimal_allowed = ?'); values.push(data.is_decimal_allowed ? 1 : 0); }
  if (data.weight_grams !== undefined) { fields.push('weight_grams = ?'); values.push(data.weight_grams || null); }
  if (data.is_active !== undefined) { fields.push('is_active = ?'); values.push(data.is_active); }
  fields.push('updated_at = CURRENT_TIMESTAMP');
  if (fields.length === 1) return jsonResponse({ error: 'لا توجد حقول للتحديث' }, 400, headers);
  values.push(id);
  await dbRun(client, `UPDATE products SET ${fields.join(', ')} WHERE id = ?`, values);
  return jsonResponse({ success: true }, 200, headers);
}
async function deleteProduct(request, env, headers) {
  const url = new URL(request.url);
  const id = parseInt(url.pathname.split('/').pop());
  const client = getTursoClient(env);
  const product = await dbFirst(client, "SELECT id FROM products WHERE id = ? AND is_active = 1", [id]);
  if (!product) return jsonResponse({ error: 'المنتج غير موجود' }, 404, headers);
  await dbRun(client, "UPDATE products SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
  return jsonResponse({ success: true }, 200, headers);
}
async function generateMissingSKU(request, env, headers) {
  const client = getTursoClient(env);

  const tableInfo = await client.execute(`PRAGMA table_info(products)`);
  const hasColumn = tableInfo.rows.some(row => row.name === 'product_code');
  if (!hasColumn) {
    await client.execute(`ALTER TABLE products ADD COLUMN product_code TEXT`);
  }

  const setting = await client.execute(`SELECT value FROM settings WHERE key = 'next_product_code'`);
  if (setting.rows.length === 0) {
    await client.execute(`INSERT INTO settings (key, value) VALUES ('next_product_code', '1')`);
    invalidateSettingsCache();
  }

  const products = await dbAll(client,
    "SELECT id FROM products WHERE product_code IS NULL OR product_code = ''"
  );

  if (products.length === 0) {
    const idxCheck = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_products_product_code'`
    );
    if (idxCheck.rows.length === 0) {
      await client.execute(`CREATE UNIQUE INDEX idx_products_product_code ON products(product_code)`);
    }
    return jsonResponse({ success: true, message: 'جميع المنتجات لها أرقام SKU' }, 200, headers);
  }

  let counter = await dbFirst(client, "SELECT value FROM settings WHERE key = 'next_product_code'");
  let nextNum = counter ? parseInt(counter.value, 10) : 1;
  const totalProducts = products.length;

  const updateSQL = `
    WITH numbered AS (
      SELECT 
        id,
        ROW_NUMBER() OVER (ORDER BY id) AS rn
      FROM products
      WHERE product_code IS NULL OR product_code = ''
    )
    UPDATE products
    SET product_code = printf('%04d', ? + (SELECT rn FROM numbered WHERE numbered.id = products.id) - 1)
    WHERE id IN (SELECT id FROM numbered)
  `;
  await client.execute(updateSQL, [nextNum]);

  const newCounter = nextNum + totalProducts;
  await client.execute(
    "UPDATE settings SET value = ? WHERE key = 'next_product_code'",
    [newCounter.toString()]
  );
  invalidateSettingsCache();

  const idxCheck = await client.execute(
    `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_products_product_code'`
  );
  if (idxCheck.rows.length === 0) {
    await client.execute(`CREATE UNIQUE INDEX idx_products_product_code ON products(product_code)`);
  }

  return jsonResponse({
    success: true,
    message: `تم تحديث ${totalProducts} منتج`
  }, 200, headers);
}

// ---- العملاء ----
async function getCustomers(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, "SELECT * FROM customers ORDER BY name");
  return jsonResponse({ customers: rows }, 200, headers);
}
async function createCustomer(request, env, headers) {
  const data = await request.json();
  if (!data.name) return jsonResponse({ error: 'الاسم مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  try {
    const result = await dbRun(client,
      "INSERT INTO customers (name, phone, address, notes, balance) VALUES (?, ?, ?, ?, ?)",
      [data.name, data.phone || null, data.address || null, data.notes || null, data.initial_balance || 0]
    );
    return jsonResponse({ success: true, id: result.lastInsertRowid }, 200, headers);
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE constraint failed')) return jsonResponse({ error: 'رقم الهاتف موجود مسبقاً' }, 409, headers);
    return jsonResponse({ error: e.message }, 500, headers);
  }
}
async function addCustomerPayment(request, env, headers) {
  const data = await request.json();
  const { customer_id, amount, payment_method, wallet_id, note, currency_id, cash_currency_id, wallet_currency_id, cash_amount, wallet_amount } = data;
  if (!customer_id || !amount || amount <= 0) return jsonResponse({ error: 'بيانات غير صالحة' }, 400, headers);
  const client = getTursoClient(env);
  await checkIfClosed(client, new Date().toISOString().slice(0, 10));
  const customer = await dbFirst(client, "SELECT * FROM customers WHERE id = ?", [customer_id]);
  if (!customer) return jsonResponse({ error: 'العميل غير موجود' }, 404, headers);
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) throw new Error('لا توجد عملة أساسية');
  const useCurrencyId = currency_id || baseCurrency.id;
  const useCashCurrencyId = cash_currency_id || useCurrencyId;
  const useWalletCurrencyId = wallet_currency_id || useCurrencyId;

  // ===== إصلاح #6: توفيق المبلغ المدفوع مع إجمالي الدفعة (نفس منطق addSupplierPayment) =====
  let finalCashPaid = parseFloat(cash_amount) || 0;
  let finalWalletPaid = parseFloat(wallet_amount) || 0;
  if (finalCashPaid === 0 && finalWalletPaid === 0) {
    if (payment_method === 'cash') finalCashPaid = amount;
    else if (payment_method === 'wallet') finalWalletPaid = amount;
    else if (payment_method === 'mixed') { finalCashPaid = amount / 2; finalWalletPaid = amount / 2; }
  } else {
    const totalPaid = finalCashPaid + finalWalletPaid;
    if (Math.abs(totalPaid - amount) > 0.001) {
      const ratio = amount / totalPaid;
      finalCashPaid *= ratio; finalWalletPaid *= ratio;
    }
  }
  finalCashPaid = Math.max(0, finalCashPaid);
  finalWalletPaid = Math.max(0, finalWalletPaid);

  const tx = await client.transaction();
  let committed = false;
  try {
    const cashAccountId = await getAccountId(tx, 'الصندوق');
    const walletAccountId = await getAccountId(tx, 'المحافظ');
    const customerAccountId = await getAccountId(tx, 'الذمم المدينة (عملاء)');
    const paymentResult = await dbRun(tx,
      "INSERT INTO customer_payments (customer_id, amount, payment_method, wallet_id, note) VALUES (?, ?, ?, ?, ?)",
      [customer_id, amount, payment_method, wallet_id || null, note || '']
    );
    const entryDate = new Date().toISOString().split('T')[0];
    const desc = `استلام من العميل ${customer.name}`;
    let totalBaseAmount = 0;
    const journalDetails = [];

    if (payment_method === 'cash' || payment_method === 'mixed') {
      let cashPaid = finalCashPaid;
      if (cashPaid > 0) {
        const rate = await getCurrencyRate(tx, useCashCurrencyId);
        if (!rate) throw new Error('سعر صرف غير متاح للعملة النقدية');
        const baseAmount = convertToBase(cashPaid, rate);
        totalBaseAmount += baseAmount;
        await dbRun(tx,
          "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES ('deposit', ?, ?, ?, ?)",
          [cashPaid, useCashCurrencyId, rate, desc]
        );
        journalDetails.push({ account_id: cashAccountId, debit: baseAmount, credit: 0 });
        journalDetails.push({ account_id: customerAccountId, debit: 0, credit: baseAmount });
      }
    }

    if (payment_method === 'wallet' || payment_method === 'mixed') {
      let walletPaid = finalWalletPaid;
      if (walletPaid > 0) {
        if (!wallet_id) throw new Error('اختر المحفظة');
        const rate = await getCurrencyRate(tx, useWalletCurrencyId);
        if (!rate) throw new Error('سعر صرف غير متاح لعملة المحفظة');
        const baseAmount = convertToBase(walletPaid, rate);
        totalBaseAmount += baseAmount;
        await ensureWalletBalance(tx, wallet_id, useWalletCurrencyId);
        await updateWalletBalance(tx, wallet_id, useWalletCurrencyId, walletPaid, 'add');
        await dbRun(tx,
          "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'deposit', ?, ?, ?, ?)",
          [wallet_id, walletPaid, useWalletCurrencyId, desc, paymentResult.lastInsertRowid]
        );
        journalDetails.push({ account_id: walletAccountId, debit: baseAmount, credit: 0 });
        journalDetails.push({ account_id: customerAccountId, debit: 0, credit: baseAmount });
      }
    }

    if (payment_method === 'cash' && journalDetails.length === 0) {
      const rate = await getCurrencyRate(tx, useCurrencyId);
      const baseAmount = convertToBase(amount, rate);
      totalBaseAmount += baseAmount;
      await dbRun(tx,
        "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES ('deposit', ?, ?, ?, ?)",
        [amount, useCurrencyId, rate, desc]
      );
      journalDetails.push({ account_id: cashAccountId, debit: baseAmount, credit: 0 });
      journalDetails.push({ account_id: customerAccountId, debit: 0, credit: baseAmount });
    }

    if (journalDetails.length > 0) {
      checkBalance(journalDetails);
      await createJournalEntry(tx, entryDate, desc, journalDetails, 'customer_payment', paymentResult.lastInsertRowid);
    }

    await dbRun(tx, "UPDATE customers SET balance = balance - ? WHERE id = ?", [totalBaseAmount, customer_id]);
    await tx.commit();
    committed = true;

    try {
      let walletName = null;
      if (wallet_id) {
        const w = await dbFirst(client, "SELECT name FROM wallets WHERE id = ?", [wallet_id]);
        walletName = w ? w.name : null;
      }
      return jsonResponse({ success: true, payment_id: paymentResult.lastInsertRowid, wallet_name: walletName }, 200, headers);
    } catch (postCommitError) {
      console.error('نجح حفظ دفعة العميل لكن تعذر جلب بيانات الرد:', postCommitError.message);
      return jsonResponse({ success: true, payment_id: paymentResult.lastInsertRowid, wallet_name: null,
        warning: 'تم حفظ الدفعة، لكن تعذر جلب اسم المحفظة' }, 200, headers);
    }
  } catch (error) {
    if (committed) {
      return jsonResponse({ success: true,
        warning: 'تم حفظ الدفعة، لكن حدث خطأ بعد commit' }, 200, headers);
    }
    try { await tx.rollback(); } catch (rollbackError) { console.error('فشل rollback:', rollbackError.message); }
    return jsonResponse({ error: error.message }, 400, headers);
  }
}
async function getCustomerStatement(request, env, headers) {
  const url = new URL(request.url);
  const customer_id = url.searchParams.get('customer_id');
  if (!customer_id) return jsonResponse({ error: 'معرف العميل مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const sales = await dbAll(client, "SELECT id, invoice_number, total_amount, created_at, 'sale' as type FROM sales WHERE customer_id = ?", [customer_id]);
  const payments = await dbAll(client,
    `SELECT cp.id, cp.amount, cp.payment_method, cp.note, cp.created_at, 'payment' as type, w.name as wallet_name
     FROM customer_payments cp LEFT JOIN wallets w ON w.id = cp.wallet_id WHERE cp.customer_id = ?`,
    [customer_id]
  );
  const statement = [...sales, ...payments].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return jsonResponse({ statement }, 200, headers);
}
async function getTotalCustomerDebt(request, env, headers) {
  const client = getTursoClient(env);
  const result = await dbFirst(client, "SELECT SUM(balance) as total_debt FROM customers WHERE balance > 0");
  return jsonResponse({ total_customer_debt: result?.total_debt || 0 }, 200, headers);
}
async function getCustomerPurchaseHistory(request, env, headers) {
  const url = new URL(request.url);
  const customer_id = url.searchParams.get('customer_id');
  if (!customer_id) return jsonResponse({ error: 'معرف العميل مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const rows = await dbAll(client, "SELECT id, invoice_number, total_amount, created_at FROM sales WHERE customer_id = ? ORDER BY created_at DESC", [customer_id]);
  return jsonResponse({ history: rows }, 200, headers);
}

// ==================== وظائف العملاء الإضافية ====================
async function getRecentCustomerPayments(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT cp.id, cp.customer_id, c.name AS customer_name, cp.amount,
           cp.payment_method, cp.note, cp.created_at, w.name AS wallet_name
    FROM customer_payments cp
    LEFT JOIN customers c ON c.id = cp.customer_id
    LEFT JOIN wallets w ON w.id = cp.wallet_id
    ORDER BY cp.created_at DESC
    LIMIT 100
  `);
  return jsonResponse({ payments: rows }, 200, headers);
}

async function getTodayCustomerPayments(request, env, headers) {
  const client = getTursoClient(env);
  const today = new Date().toISOString().split('T')[0];
  const row = await dbFirst(client, `
    SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
    FROM customer_payments
    WHERE DATE(created_at) = ?
  `, [today]);
  return jsonResponse({ date: today, total: Number(row?.total || 0), count: Number(row?.count || 0) }, 200, headers);
}

async function getCustomerPurchasesById(request, env, headers) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/customers\/(\d+)\/purchases\/?$/);
  const customerId = match ? parseInt(match[1], 10) : 0;
  if (!customerId) return jsonResponse({ error: 'معرف العميل غير صالح' }, 400, headers);
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT id, invoice_number, total_amount, payment_method, status, created_at
    FROM sales
    WHERE customer_id = ?
    ORDER BY created_at DESC
    LIMIT 200
  `, [customerId]);
  return jsonResponse({ purchases: rows }, 200, headers);
}

async function importDatabaseBackup(request, env, headers) {
  let backup;
  try { backup = await request.json(); } catch { return jsonResponse({ error: 'ملف JSON غير صالح' }, 400, headers); }
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    return jsonResponse({ error: 'بنية النسخة الاحتياطية غير صالحة' }, 400, headers);
  }
  const client = getTursoClient(env);
  const allowed = await dbAll(client, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'");
  const allowedTables = new Set(allowed.map(r => r.name));
  const tables = Object.keys(backup).filter(t => allowedTables.has(t) && Array.isArray(backup[t]));
  if (tables.length === 0) return jsonResponse({ error: 'لا توجد جداول صالحة للاستعادة' }, 400, headers);
  const tx = await client.transaction();
  try {
    for (const table of tables) {
      const rows = backup[table];
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]).filter(c => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c));
      if (!columns.length) continue;
      const placeholders = columns.map(() => '?').join(', ');
      const quotedTable = `"${table.replace(/"/g, '""')}"`;
      const quotedColumns = columns.map(c => `"${c.replace(/"/g, '""')}"`).join(', ');
      const statements = rows.slice(0, 10000).map(row => ({
        sql: `INSERT OR REPLACE INTO ${quotedTable} (${quotedColumns}) VALUES (${placeholders})`,
        args: columns.map(c => row[c] ?? null)
      }));
      for (let i = 0; i < statements.length; i += 40) await tx.batch(statements.slice(i, i + 40), 'write');
    }
    await tx.commit();
    invalidateSettingsCache();
    return jsonResponse({ success: true, restored_tables: tables }, 200, headers);
  } catch (e) {
    try { await tx.rollback(); } catch {}
    return jsonResponse({ error: 'فشلت الاستعادة: ' + e.message }, 500, headers);
  }
}

async function askAI(request, env, headers) {
  const { question } = await request.json();
  if (!question || typeof question !== 'string') return jsonResponse({ error: 'السؤال مطلوب' }, 400, headers);
  const endpoint = env.AI_API_URL;
  const apiToken = env.AI_API_TOKEN;
  if (!endpoint || !apiToken) return jsonResponse({ error: 'خدمة الذكاء الاصطناعي غير مهيأة في Worker' }, 503, headers);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return jsonResponse({ error: data.error || 'فشل مزود الذكاء الاصطناعي' }, response.status, headers);
  return jsonResponse({ answer: data.answer || data }, 200, headers);
}

// ---- الموردين ----
async function getSuppliers(request, env, headers) {
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page')) || 1;
  const limit = parseInt(url.searchParams.get('limit')) || 10;
  const offset = (page - 1) * limit;
  const search = url.searchParams.get('search') || '';
  const balanceFilter = url.searchParams.get('balance_filter') || 'all';
  const client = getTursoClient(env);
  let sql = "SELECT * FROM suppliers WHERE 1=1";
  const args = [];
  if (search) { sql += " AND (name LIKE ? OR phone LIKE ?)"; args.push(`%${search}%`, `%${search}%`); }
  if (balanceFilter === 'positive') sql += " AND balance > 0";
  else if (balanceFilter === 'negative') sql += " AND balance < 0";
  else if (balanceFilter === 'zero') sql += " AND balance = 0";
  const countResult = await dbFirst(client, `SELECT COUNT(*) as total FROM (${sql})`, args);
  const total = countResult.total;
  sql += " ORDER BY name LIMIT ? OFFSET ?";
  args.push(limit, offset);
  const rows = await dbAll(client, sql, args);
  const totalDebt = await dbFirst(client, "SELECT SUM(balance) as total_debt FROM suppliers WHERE balance > 0");
  return jsonResponse({ suppliers: rows, total, total_debt: totalDebt?.total_debt || 0 }, 200, headers);
}
async function getSupplierById(request, env, headers) {
  const id = parseInt(request.url.split('/').pop());
  const client = getTursoClient(env);
  const supplier = await dbFirst(client, "SELECT * FROM suppliers WHERE id = ?", [id]);
  if (!supplier) return jsonResponse({ error: 'المورد غير موجود' }, 404, headers);
  return jsonResponse({ supplier }, 200, headers);
}
async function createSupplier(request, env, headers) {
  const data = await request.json();
  if (!data.name) return jsonResponse({ error: 'الاسم مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const result = await dbRun(client,
    "INSERT INTO suppliers (name, phone, address, balance, sku_prefix) VALUES (?, ?, ?, ?, ?)",
    [data.name, data.phone || null, data.address || null, data.initial_balance || 0, data.sku_prefix || null]
  );
  return jsonResponse({ success: true, id: result.lastInsertRowid }, 200, headers);
}
async function updateSupplier(request, env, headers) {
  const id = parseInt(request.url.split('/').pop());
  const { name, phone, address, sku_prefix } = await request.json();
  if (!name) return jsonResponse({ error: 'الاسم مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const existing = await dbFirst(client, "SELECT id FROM suppliers WHERE id = ?", [id]);
  if (!existing) return jsonResponse({ error: 'المورد غير موجود' }, 404, headers);
  await dbRun(client,
    "UPDATE suppliers SET name = ?, phone = ?, address = ?, sku_prefix = ? WHERE id = ?",
    [name, phone || null, address || null, sku_prefix || null, id]
  );
  return jsonResponse({ success: true }, 200, headers);
}
async function deleteSupplier(request, env, headers) {
  const id = parseInt(request.url.split('/').pop());
  const client = getTursoClient(env);
  const purchases = await dbFirst(client, "SELECT COUNT(*) as cnt FROM purchase_invoices WHERE supplier_id = ? AND status != 'cancelled'", [id]);
  if (purchases.cnt > 0) return jsonResponse({ error: 'لا يمكن حذف المورد لوجود فواتير شراء معلقة' }, 400, headers);
  const payments = await dbFirst(client, "SELECT COUNT(*) as cnt FROM supplier_payments WHERE supplier_id = ?", [id]);
  if (payments.cnt > 0) return jsonResponse({ error: 'لا يمكن حذف المورد لوجود سندات صرف مسجلة' }, 400, headers);
  await dbRun(client, "DELETE FROM suppliers WHERE id = ?", [id]);
  return jsonResponse({ success: true }, 200, headers);
}
async function addSupplierPayment(request, env, headers) {
  const { supplier_id, amount, payment_method, wallet_id, note, type = 'payment',
    currency_id, exchange_rate: providedExchangeRate,
    cash_currency_id, wallet_currency_id, cash_amount, wallet_amount } = await request.json();
  if (!supplier_id || !amount || amount <= 0) return jsonResponse({ error: 'بيانات غير صالحة' }, 400, headers);
  const client = getTursoClient(env);
  await checkIfClosed(client, new Date().toISOString().slice(0, 10));
  const supplier = await dbFirst(client, "SELECT * FROM suppliers WHERE id = ?", [supplier_id]);
  if (!supplier) return jsonResponse({ error: 'المورد غير موجود' }, 404, headers);
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) throw new Error('لا توجد عملة أساسية');
  const useCurrencyId = currency_id || baseCurrency.id;
  let finalExchangeRate = providedExchangeRate;
  if (!finalExchangeRate || finalExchangeRate <= 0) {
    const rateFromDb = await getCurrencyRate(client, useCurrencyId);
    finalExchangeRate = rateFromDb || 1;
  }
  let normalizedMethod = payment_method?.toLowerCase().trim() || 'cash';
  if (normalizedMethod === 'نقدي' || normalizedMethod === 'cash') normalizedMethod = 'cash';
  else if (normalizedMethod === 'محفظة' || normalizedMethod === 'wallet') normalizedMethod = 'wallet';
  else if (normalizedMethod === 'مختلط' || normalizedMethod === 'mixed') normalizedMethod = 'mixed';
  else normalizedMethod = 'cash';
  const useCashCurrencyId = cash_currency_id || useCurrencyId;
  const useWalletCurrencyId = wallet_currency_id || useCurrencyId;
  let finalCashPaid = parseFloat(cash_amount) || 0;
  let finalWalletPaid = parseFloat(wallet_amount) || 0;
  if (finalCashPaid === 0 && finalWalletPaid === 0) {
    if (normalizedMethod === 'cash') finalCashPaid = amount;
    else if (normalizedMethod === 'wallet') finalWalletPaid = amount;
    else if (normalizedMethod === 'mixed') { finalCashPaid = amount / 2; finalWalletPaid = amount / 2; }
  } else {
    const totalPaid = finalCashPaid + finalWalletPaid;
    if (Math.abs(totalPaid - amount) > 0.001) {
      const ratio = amount / totalPaid;
      finalCashPaid *= ratio; finalWalletPaid *= ratio;
    }
  }
  finalCashPaid = Math.max(0, finalCashPaid);
  finalWalletPaid = Math.max(0, finalWalletPaid);
  const tx = await client.transaction();
  let committed = false;
  try {
    const cashAccountId = await getAccountId(tx, 'الصندوق');
    const walletAccountId = await getAccountId(tx, 'المحافظ');
    const supplierAccountId = await getAccountId(tx, 'الذمم الدائنة (موردين)');
    let totalBaseAmount = 0;
    const journalDetails = [];
    const paymentResult = await dbRun(tx,
      `INSERT INTO supplier_payments 
        (supplier_id, type, amount, payment_method, wallet_id, note, currency_id, exchange_rate) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [supplier_id, type, amount, normalizedMethod, wallet_id || null, note || '', useCurrencyId, finalExchangeRate]
    );
    const paymentId = paymentResult.lastInsertRowid;
    const isPayment = (type === 'payment');
    const cashRegisterType = isPayment ? 'withdraw' : 'deposit';
    const walletOperation = isPayment ? 'subtract' : 'add';
    const balanceSign = isPayment ? -1 : 1;
    if (normalizedMethod === 'cash' || normalizedMethod === 'mixed') {
      const cashPaid = finalCashPaid;
      if (cashPaid > 0) {
        const rate = await getCurrencyRate(tx, useCashCurrencyId);
        if (!rate) throw new Error('سعر الصرف غير متاح للعملة النقدية');
        const baseAmount = convertToBase(cashPaid, rate);
        totalBaseAmount += baseAmount;
        await dbRun(tx,
          "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES (?, ?, ?, ?, ?)",
          [cashRegisterType, cashPaid, useCashCurrencyId, rate, isPayment ? `سداد للمورد ${supplier.name}` : `استلام من المورد ${supplier.name}`]
        );
        if (isPayment) {
          journalDetails.push({ account_id: supplierAccountId, debit: baseAmount, credit: 0 });
          journalDetails.push({ account_id: cashAccountId, debit: 0, credit: baseAmount });
        } else {
          journalDetails.push({ account_id: cashAccountId, debit: baseAmount, credit: 0 });
          journalDetails.push({ account_id: supplierAccountId, debit: 0, credit: baseAmount });
        }
      }
    }
    if (normalizedMethod === 'wallet' || normalizedMethod === 'mixed') {
      const walletPaid = finalWalletPaid;
      if (walletPaid > 0) {
        if (!wallet_id) throw new Error('اختر المحفظة');
        const rate = await getCurrencyRate(tx, useWalletCurrencyId);
        if (!rate) throw new Error('سعر الصرف غير متاح لعملة المحفظة');
        const baseAmount = convertToBase(walletPaid, rate);
        totalBaseAmount += baseAmount;
        if (isPayment) {
          const bal = await dbFirst(tx,
            "SELECT balance FROM wallet_balances WHERE wallet_id = ? AND currency_id = ?",
            [wallet_id, useWalletCurrencyId]
          );
          if (!bal || bal.balance < walletPaid) throw new Error('رصيد غير كافٍ في المحفظة');
        }
        await updateWalletBalance(tx, wallet_id, useWalletCurrencyId, walletPaid, walletOperation);
        await dbRun(tx,
          "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, ?, ?, ?, ?, ?)",
          [wallet_id, isPayment ? 'withdraw' : 'deposit', walletPaid, useWalletCurrencyId,
           isPayment ? `سداد للمورد ${supplier.name}` : `استلام من المورد ${supplier.name}`, paymentId]
        );
        if (isPayment) {
          journalDetails.push({ account_id: supplierAccountId, debit: baseAmount, credit: 0 });
          journalDetails.push({ account_id: walletAccountId, debit: 0, credit: baseAmount });
        } else {
          journalDetails.push({ account_id: walletAccountId, debit: baseAmount, credit: 0 });
          journalDetails.push({ account_id: supplierAccountId, debit: 0, credit: baseAmount });
        }
      }
    }
    await dbRun(tx, "UPDATE suppliers SET balance = balance + ? WHERE id = ?", [balanceSign * totalBaseAmount, supplier_id]);
    const entryDate = new Date().toISOString().split('T')[0];
    const desc = isPayment ? `سداد للمورد ${supplier.name}` : `استلام من المورد ${supplier.name}`;
    if (journalDetails.length > 0) {
      checkBalance(journalDetails);
      await createJournalEntry(tx, entryDate, desc, journalDetails, 'supplier_payment', paymentId);
    }
    await tx.commit();
    committed = true;
    try {
      let walletName = null;
      if (wallet_id) { const w = await dbFirst(client, "SELECT name FROM wallets WHERE id = ?", [wallet_id]); walletName = w ? w.name : null; }
      return jsonResponse({ success: true, payment_id: paymentId, wallet_name: walletName, total_base_amount: totalBaseAmount, cash_paid: finalCashPaid, wallet_paid: finalWalletPaid }, 200, headers);
    } catch (postCommitError) {
      console.error('نجح حفظ دفعة المورد لكن تعذر جلب بيانات الرد:', postCommitError.message);
      return jsonResponse({ success: true, payment_id: paymentId, wallet_name: null,
        total_base_amount: totalBaseAmount, cash_paid: finalCashPaid, wallet_paid: finalWalletPaid,
        warning: 'تم حفظ الدفعة، لكن تعذر جلب اسم المحفظة' }, 200, headers);
    }
  } catch (error) {
    if (committed) {
      return jsonResponse({ success: true,
        warning: 'تم حفظ الدفعة، لكن حدث خطأ بعد commit' }, 200, headers);
    }
    try { await tx.rollback(); } catch (rollbackError) { console.error('فشل rollback:', rollbackError.message); }
    return jsonResponse({ error: error.message }, 400, headers);
  }
}
async function getSupplierStatement(request, env, headers) {
  const url = new URL(request.url);
  const supplier_id = url.searchParams.get('supplier_id');
  if (!supplier_id) return jsonResponse({ error: 'معرف المورد مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const invoices = await dbAll(client, `
    SELECT pi.id, pi.invoice_number, pi.total_amount as amount, pi.created_at, 'purchase' as type, pi.note,
      pi.currency_id, COALESCE(pi.exchange_rate, c.rate_to_base, 1) as exchange_rate, c.code as currency_code, c.name as currency_name
    FROM purchase_invoices pi LEFT JOIN currencies c ON c.id = pi.currency_id
    WHERE pi.supplier_id = ? AND pi.payment_method = 'credit'
  `, [supplier_id]);
  const payments = await dbAll(client, `
    SELECT sp.id, sp.amount, sp.payment_method, sp.note, sp.created_at, sp.type,
      COALESCE(sp.exchange_rate, c.rate_to_base, 1) as exchange_rate, sp.currency_id, c.code as currency_code, c.name as currency_name, w.name as wallet_name
    FROM supplier_payments sp LEFT JOIN currencies c ON c.id = sp.currency_id LEFT JOIN wallets w ON w.id = sp.wallet_id
    WHERE sp.supplier_id = ?
  `, [supplier_id]);
  const returns = await dbAll(client, `
    SELECT rp.id, rp.amount, rp.reason as note, rp.created_at, 'return' as type,
      pi.currency_id, COALESCE(pi.exchange_rate, c.rate_to_base, 1) as exchange_rate, c.code as currency_code, c.name as currency_name
    FROM returned_purchases rp JOIN purchase_invoices pi ON pi.id = rp.purchase_invoice_id LEFT JOIN currencies c ON c.id = pi.currency_id
    WHERE pi.supplier_id = ?
  `, [supplier_id]);
  const statement = [...invoices, ...payments, ...returns].sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
  return jsonResponse({ statement }, 200, headers);
}
async function getTotalSupplierDebt(request, env, headers) {
  const client = getTursoClient(env);
  const result = await dbFirst(client, "SELECT SUM(balance) as total_debt FROM suppliers WHERE balance > 0");
  return jsonResponse({ total_supplier_debt: result?.total_debt || 0 }, 200, headers);
}
async function getSupplierPurchaseInvoices(request, env, headers) {
  const url = new URL(request.url);
  const supplier_id = url.searchParams.get('supplier_id');
  const client = getTursoClient(env);
  let sql = `SELECT pi.*, s.name as supplier_name FROM purchase_invoices pi JOIN suppliers s ON s.id = pi.supplier_id`;
  const args = [];
  if (supplier_id) { sql += ` WHERE pi.supplier_id = ?`; args.push(supplier_id); }
  sql += ` ORDER BY pi.created_at DESC LIMIT 100`;
  const rows = await dbAll(client, sql, args);
  return jsonResponse({ invoices: rows }, 200, headers);
}
async function assignProductsToSupplier(request, env, headers) {
  const { supplier_id, products } = await request.json();
  if (!supplier_id) {
    return jsonResponse({ error: 'معرف المورد مطلوب' }, 400, headers);
  }
  if (!products || !Array.isArray(products) || products.length === 0) {
    return jsonResponse({ error: 'قائمة المنتجات مطلوبة' }, 400, headers);
  }

  const client = getTursoClient(env);
  const supplier = await dbFirst(client, "SELECT id, sku_prefix FROM suppliers WHERE id = ?", [supplier_id]);
  if (!supplier) {
    return jsonResponse({ error: 'المورد غير موجود' }, 404, headers);
  }

  const productIds = products.map(p => p.product_id).filter(id => id);
  if (productIds.length === 0) {
    return jsonResponse({ error: 'لا توجد معرفات منتجات صالحة' }, 400, headers);
  }

  const tx = await client.transaction();
  try {
    const existingRows = await dbAll(tx, `
      SELECT id, product_id, quantity, supplier_sku
      FROM product_supplier_stock
      WHERE supplier_id = ? AND product_id IN (${productIds.map(() => '?').join(',')})
    `, [supplier_id, ...productIds]);

    const existingMap = {};
    for (const row of existingRows) {
      existingMap[row.product_id] = row;
    }

    const prefix = supplier.sku_prefix?.trim() || 'SUP';
    const lastSku = await dbFirst(tx, `
      SELECT supplier_sku FROM product_supplier_stock
      WHERE supplier_id = ? AND supplier_sku LIKE ?
      ORDER BY supplier_sku DESC LIMIT 1
    `, [supplier_id, prefix + '%']);
    let nextSeq = 1;
    if (lastSku && lastSku.supplier_sku) {
      const numPart = lastSku.supplier_sku.replace(prefix, '');
      const parsed = parseInt(numPart, 10);
      if (!isNaN(parsed)) nextSeq = parsed + 1;
    }

    const batchQueries = [];
    let updatedCount = 0, insertedCount = 0, deletedCount = 0;

    for (const item of products) {
      const { product_id, quantity, unit_price, supplier_sku } = item;
      if (!product_id) continue;
      const qty = parseFloat(quantity) || 0;
      const price = parseFloat(unit_price) || 0;

      const existing = existingMap[product_id];
      if (existing) {
        if (qty <= 0) {
          batchQueries.push({
            sql: "DELETE FROM product_supplier_stock WHERE id = ?",
            args: [existing.id]
          });
          deletedCount++;
        } else {
          let finalSku = supplier_sku ? supplier_sku.trim() : null;
          if (!finalSku) {
            finalSku = existing.supplier_sku || (prefix + String(nextSeq).padStart(4, '0'));
            if (!existing.supplier_sku) nextSeq++;
          }
          batchQueries.push({
            sql: `UPDATE product_supplier_stock 
                   SET quantity = ?, 
                       last_purchase_price = ?, 
                       supplier_sku = COALESCE(?, supplier_sku),
                       updated_at = CURRENT_TIMESTAMP 
                   WHERE id = ?`,
            args: [qty, price, finalSku, existing.id]
          });
          updatedCount++;
        }
      } else {
        if (qty > 0) {
          let finalSku = supplier_sku ? supplier_sku.trim() : null;
          if (!finalSku) {
            finalSku = prefix + String(nextSeq).padStart(4, '0');
            nextSeq++;
          }
          batchQueries.push({
            sql: `INSERT INTO product_supplier_stock 
                    (product_id, supplier_id, quantity, last_purchase_price, supplier_sku) 
                  VALUES (?, ?, ?, ?, ?)`,
            args: [product_id, supplier_id, qty, price, finalSku]
          });
          insertedCount++;
        }
      }
    }

    if (batchQueries.length > 0) {
      await tx.batch(batchQueries, 'write');
    }

    await tx.commit();
    return jsonResponse({
      success: true,
      message: `تمت المعالجة: ${insertedCount} مضاف، ${updatedCount} محدث، ${deletedCount} محذوف`,
      inserted: insertedCount,
      updated: updatedCount,
      deleted: deletedCount
    }, 200, headers);

  } catch (error) {
    await tx.rollback();
    return jsonResponse({ error: error.message }, 500, headers);
  }
}
async function getSupplierRemainingStock(request, env, headers) {
  const url = new URL(request.url);
  const all = url.searchParams.get('all') === 'true';
  const supplier_id = url.searchParams.get('supplier_id');
  
  const client = getTursoClient(env);
  
  if (all) {
    const rows = await dbAll(client, `
      SELECT 
        pss.id,
        pss.product_id,
        p.name as product_name,
        pss.supplier_id,
        s.name as supplier_name,
        pss.quantity,
        pss.last_purchase_price,
        pss.supplier_sku
      FROM product_supplier_stock pss
      JOIN products p ON p.id = pss.product_id
      JOIN suppliers s ON s.id = pss.supplier_id
      ORDER BY s.name, p.name
    `);
    return jsonResponse({ stock: rows }, 200, headers);
  }
  
  if (!supplier_id) {
    return jsonResponse({ error: 'معرف المورد مطلوب' }, 400, headers);
  }
  const rows = await dbAll(client, `
    SELECT pss.product_id, p.name as product_name, pss.quantity, pss.last_purchase_price, pss.supplier_sku
    FROM product_supplier_stock pss JOIN products p ON p.id = pss.product_id
    WHERE pss.supplier_id = ? AND pss.quantity > 0
    ORDER BY p.name
  `, [supplier_id]);
  return jsonResponse({ stock: rows }, 200, headers);
}
async function getSupplierFinancialBalance(request, env, headers) {
  const url = new URL(request.url);
  const supplier_id = url.searchParams.get('supplier_id');
  if (!supplier_id) return jsonResponse({ error: 'معرف المورد مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const supplier = await dbFirst(client, "SELECT id, name, balance FROM suppliers WHERE id = ?", [supplier_id]);
  if (!supplier) return jsonResponse({ error: 'المورد غير موجود' }, 404, headers);
  return jsonResponse({ supplier }, 200, headers);
}

// ---- المحافظ ----
async function getWallets(request, env, headers) {
  const client = getTursoClient(env);
  const wallets = await dbAll(client, "SELECT * FROM wallets ORDER BY name");
  
  const baseCurrencies = await dbAll(client, "SELECT id, code, name, rate_to_base FROM currencies WHERE code IN ('YER','SAR','USD')");

  const allBalances = await dbAll(client, `
    SELECT wb.wallet_id, wb.balance, c.id as currency_id, c.code, c.name as currency_name, c.rate_to_base
    FROM wallet_balances wb JOIN currencies c ON c.id = wb.currency_id
    ORDER BY wb.wallet_id, c.code
  `);

  const balancesMap = {};
  for (const bal of allBalances) {
    if (!balancesMap[bal.wallet_id]) balancesMap[bal.wallet_id] = [];
    balancesMap[bal.wallet_id].push({
      balance: bal.balance,
      currency_id: bal.currency_id,
      code: bal.code,
      currency_name: bal.currency_name,
      rate_to_base: bal.rate_to_base
    });
  }

  const walletIds = wallets.map(w => w.id);
  const currencyIds = baseCurrencies.map(c => c.id);
  if (walletIds.length > 0 && currencyIds.length > 0) {
    const insertSql = `
      INSERT OR IGNORE INTO wallet_balances (wallet_id, currency_id, balance)
      SELECT w.id, c.id, 0
      FROM wallets w
      CROSS JOIN currencies c
      WHERE c.id IN (${currencyIds.join(',')})
        AND w.id IN (${walletIds.join(',')})
        AND NOT EXISTS (
          SELECT 1 FROM wallet_balances wb
          WHERE wb.wallet_id = w.id AND wb.currency_id = c.id
        )
    `;
    await client.execute(insertSql);
  }

  const updatedBalances = await dbAll(client, `
    SELECT wb.wallet_id, wb.balance, c.id as currency_id, c.code, c.name as currency_name, c.rate_to_base
    FROM wallet_balances wb JOIN currencies c ON c.id = wb.currency_id
    WHERE wb.wallet_id IN (${walletIds.join(',')})
    ORDER BY wb.wallet_id, c.code
  `);

  const updatedMap = {};
  for (const bal of updatedBalances) {
    if (!updatedMap[bal.wallet_id]) updatedMap[bal.wallet_id] = [];
    updatedMap[bal.wallet_id].push({
      balance: bal.balance,
      currency_id: bal.currency_id,
      code: bal.code,
      currency_name: bal.currency_name,
      rate_to_base: bal.rate_to_base
    });
  }

  const result = wallets.map(wallet => ({
    id: wallet.id,
    name: wallet.name,
    created_at: wallet.created_at,
    updated_at: wallet.updated_at,
    balances: (updatedMap[wallet.id] || []).sort((a, b) => a.code.localeCompare(b.code))
  }));

  return jsonResponse({ wallets: result }, 200, headers);
}
async function createWallet(request, env, headers) {
  const { name } = await request.json();
  if (!name) return jsonResponse({ error: 'اسم المحفظة مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const walletResult = await dbRun(client, "INSERT INTO wallets (name) VALUES (?)", [name]);
  const walletId = walletResult.lastInsertRowid;
  const currencies = await dbAll(client, "SELECT id FROM currencies WHERE code IN ('YER','SAR','USD')");
  if (currencies.length < 3) return jsonResponse({ error: 'العملات الأساسية غير موجودة، أضفها أولاً' }, 400, headers);
  for (const cur of currencies) {
    await dbRun(client, "INSERT INTO wallet_balances (wallet_id, currency_id, balance) VALUES (?, ?, 0)", [walletId, cur.id]);
  }
  return jsonResponse({ success: true, id: walletId }, 200, headers);
}
async function exchangeCurrency(request, env, headers) {
  const { wallet_id, from_currency_id, to_currency_id, amount, fee = 0 } = await request.json();
  if (!wallet_id || !from_currency_id || !to_currency_id || !amount || amount <= 0) {
    return jsonResponse({ error: 'بيانات غير صالحة' }, 400, headers);
  }
  if (from_currency_id === to_currency_id) return jsonResponse({ error: 'لا يمكن الصرف لنفس العملة' }, 400, headers);
  if (fee < 0) return jsonResponse({ error: 'الرسوم لا يمكن أن تكون سالبة' }, 400, headers);
  const client = getTursoClient(env);
  const tx = await client.transaction();
  try {
    const fromRate = await getCurrencyRate(tx, from_currency_id);
    const toRate = await getCurrencyRate(tx, to_currency_id);
    if (!fromRate || !toRate) throw new Error('سعر الصرف غير متاح');
    const amountInBase = convertToBase(amount, fromRate);
    const amountTo = convertFromBase(amountInBase, toRate);
    const totalFrom = amount + fee;
    const fromBalance = await dbFirst(tx,
      "SELECT balance FROM wallet_balances WHERE wallet_id = ? AND currency_id = ?",
      [wallet_id, from_currency_id]
    );
    if (!fromBalance || fromBalance.balance < totalFrom) throw new Error('رصيد غير كافٍ');
    await dbRun(tx,
      "UPDATE wallet_balances SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = ? AND currency_id = ?",
      [totalFrom, wallet_id, from_currency_id]
    );
    await ensureWalletBalance(tx, wallet_id, to_currency_id);
    await dbRun(tx,
      "UPDATE wallet_balances SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = ? AND currency_id = ?",
      [amountTo, wallet_id, to_currency_id]
    );
    await dbRun(tx,
      `INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description)
       VALUES (?, 'exchange_out', ?, ?, ?)`,
      [wallet_id, totalFrom, from_currency_id, `صرف من ${from_currency_id} إلى ${to_currency_id} (رسوم: ${fee})`]
    );
    await dbRun(tx,
      `INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description)
       VALUES (?, 'exchange_in', ?, ?, ?)`,
      [wallet_id, amountTo, to_currency_id, `استلام من صرف من ${from_currency_id}`]
    );
    if (fee > 0) {
      await dbRun(tx,
        `INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description)
         VALUES (?, 'fee', ?, ?, ?)`,
        [wallet_id, fee, from_currency_id, `رسوم صرف العملات`]
      );
    }
    const entryDate = new Date().toISOString().split('T')[0];
    const desc = `صرف عملة من ${from_currency_id} إلى ${to_currency_id} (رسوم: ${fee})`;
    const walletAccountId = await getAccountId(tx, 'المحافظ');
    const feeAccountId = await getOrCreateFeeAccount(tx);
    const totalFromBase = convertToBase(totalFrom, fromRate);
    const amountToBase = convertToBase(amountTo, toRate);
    const journalDetails = [
      { account_id: walletAccountId, debit: amountToBase, credit: 0 },
      { account_id: walletAccountId, debit: 0, credit: totalFromBase }
    ];
    if (fee > 0) {
      const feeBase = convertToBase(fee, fromRate);
      journalDetails.push({ account_id: feeAccountId, debit: feeBase, credit: 0 });
    }
    const diff = totalFromBase - amountToBase - (fee > 0 ? convertToBase(fee, fromRate) : 0);
    if (Math.abs(diff) > 0.001) {
      if (diff > 0) {
        const exchangeIncomeId = await getOrCreateAccount(tx, 'إيرادات صرف العملات', '4300', 'income');
        journalDetails.push({ account_id: exchangeIncomeId, debit: 0, credit: diff });
      } else {
        const exchangeLossId = await getOrCreateAccount(tx, 'خسائر صرف العملات', '6300', 'expense');
        journalDetails.push({ account_id: exchangeLossId, debit: -diff, credit: 0 });
      }
    }
    checkBalance(journalDetails);
    await createJournalEntry(tx, entryDate, desc, journalDetails, 'exchange', null);
    await tx.commit();
    return jsonResponse({ success: true, from_amount: amount, to_amount: amountTo, fee: fee }, 200, headers);
  } catch (error) {
    await tx.rollback();
    return jsonResponse({ error: error.message }, 400, headers);
  }
}
async function transferBetweenWallets(request, env, headers) {
  const { from_wallet_id, to_wallet_id, currency_id, amount, fee = 0 } = await request.json();
  if (!from_wallet_id || !to_wallet_id || !currency_id || !amount || amount <= 0) {
    return jsonResponse({ error: 'بيانات غير صالحة' }, 400, headers);
  }
  if (from_wallet_id === to_wallet_id) return jsonResponse({ error: 'لا يمكن التحويل لنفس المحفظة' }, 400, headers);
  if (fee < 0) return jsonResponse({ error: 'الرسوم لا يمكن أن تكون سالبة' }, 400, headers);
  const client = getTursoClient(env);
  const tx = await client.transaction();
  try {
    const rate = await getCurrencyRate(tx, currency_id);
    if (!rate) throw new Error('سعر الصرف غير متاح');
    const totalFrom = amount + fee;
    const fromBalance = await dbFirst(tx,
      "SELECT balance FROM wallet_balances WHERE wallet_id = ? AND currency_id = ?",
      [from_wallet_id, currency_id]
    );
    if (!fromBalance || fromBalance.balance < totalFrom) throw new Error('رصيد غير كافٍ');
    await dbRun(tx,
      "UPDATE wallet_balances SET balance = balance - ? WHERE wallet_id = ? AND currency_id = ?",
      [totalFrom, from_wallet_id, currency_id]
    );
    await ensureWalletBalance(tx, to_wallet_id, currency_id);
    await dbRun(tx,
      "UPDATE wallet_balances SET balance = balance + ? WHERE wallet_id = ? AND currency_id = ?",
      [amount, to_wallet_id, currency_id]
    );
    await dbRun(tx,
      `INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description)
       VALUES (?, 'transfer_out', ?, ?, ?)`,
      [from_wallet_id, totalFrom, currency_id, `تحويل إلى محفظة ${to_wallet_id} (رسوم: ${fee})`]
    );
    await dbRun(tx,
      `INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description)
       VALUES (?, 'transfer_in', ?, ?, ?)`,
      [to_wallet_id, amount, currency_id, `تحويل من محفظة ${from_wallet_id}`]
    );
    if (fee > 0) {
      await dbRun(tx,
        `INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description)
         VALUES (?, 'fee', ?, ?, ?)`,
        [from_wallet_id, fee, currency_id, `رسوم تحويل`]
      );
    }
    const entryDate = new Date().toISOString().split('T')[0];
    const desc = `تحويل بين المحافظ ${from_wallet_id} -> ${to_wallet_id} (رسوم: ${fee})`;
    const walletAccountId = await getAccountId(tx, 'المحافظ');
    const feeAccountId = await getOrCreateFeeAccount(tx);
    const totalFromBase = convertToBase(totalFrom, rate);
    const amountBase = convertToBase(amount, rate);
    const feeBase = convertToBase(fee, rate);
    const journalDetails = [
      { account_id: walletAccountId, debit: amountBase, credit: 0 },
      { account_id: walletAccountId, debit: 0, credit: totalFromBase }
    ];
    if (fee > 0) {
      journalDetails.push({ account_id: feeAccountId, debit: feeBase, credit: 0 });
    }
    checkBalance(journalDetails);
    await createJournalEntry(tx, entryDate, desc, journalDetails, 'transfer', null);
    await tx.commit();
    return jsonResponse({ success: true, from_amount: totalFrom, to_amount: amount, fee: fee }, 200, headers);
  } catch (error) {
    await tx.rollback();
    return jsonResponse({ error: error.message }, 400, headers);
  }
}
async function getWalletTransactions(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT wt.*, w.name as wallet_name, c.code as currency_code
    FROM wallet_transactions wt
    JOIN wallets w ON w.id = wt.wallet_id
    LEFT JOIN currencies c ON c.id = wt.currency_id
    ORDER BY wt.created_at DESC LIMIT 100
  `);
  return jsonResponse({ transactions: rows }, 200, headers);
}

// ---- الصندوق ----
async function getCashStatus(request, env, headers) {
  const client = getTursoClient(env);
  const history = await dbAll(client, `
    SELECT cr.*, c.code as currency_code, c.name as currency_name
    FROM cash_register cr JOIN currencies c ON c.id = cr.currency_id
    ORDER BY cr.created_at DESC LIMIT 1000
  `);
  const balances = {};
  let totalBase = 0;
  history.forEach(h => {
    const curId = h.currency_id;
    if (!balances[curId]) balances[curId] = { amount: 0, code: h.currency_code, name: h.currency_name, rate: h.exchange_rate };
    if (h.type === 'deposit' || h.type === 'open') { balances[curId].amount += h.amount; totalBase += convertToBase(h.amount, h.exchange_rate); }
    else if (h.type === 'withdraw' || h.type === 'close') { balances[curId].amount -= h.amount; totalBase -= convertToBase(h.amount, h.exchange_rate); }
  });
  const wallets = await dbAll(client, `
    SELECT w.id, w.name, wb.balance, c.id as currency_id, c.code, c.rate_to_base
    FROM wallets w JOIN wallet_balances wb ON wb.wallet_id = w.id JOIN currencies c ON c.id = wb.currency_id
  `);
  let totalWalletsBase = 0;
  const walletBalances = {};
  wallets.forEach(w => {
    const base = convertToBase(w.balance, w.rate_to_base);
    totalWalletsBase += base;
    if (!walletBalances[w.id]) walletBalances[w.id] = { name: w.name, balances: [] };
    walletBalances[w.id].balances.push({ currency_id: w.currency_id, code: w.code, balance: w.balance, balance_base: base });
  });
  return jsonResponse({
    history, cash_balances: balances, total_cash_base: totalBase,
    wallets: Object.values(walletBalances), total_wallets_base: totalWalletsBase,
    total_cash_and_wallets_base: totalBase + totalWalletsBase
  }, 200, headers);
}
async function addCashOperation(request, env, headers) {
  const { type, amount, currency_id, note } = await request.json();
  if (!['deposit', 'withdraw'].includes(type) || !amount || amount <= 0 || !currency_id) {
    return jsonResponse({ error: 'نوع غير صحيح أو مبلغ غير صالح أو العملة غير محددة' }, 400, headers);
  }
  const client = getTursoClient(env);
  await checkIfClosed(client, new Date().toISOString().slice(0, 10));
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) throw new Error('لا توجد عملة أساسية');
  const tx = await client.transaction();
  try {
    const rate = await getCurrencyRate(tx, currency_id);
    if (!rate) throw new Error('العملة غير موجودة');
    const baseAmount = convertToBase(amount, rate);
    await dbRun(tx,
      "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES (?, ?, ?, ?, ?)",
      [type, amount, currency_id, rate, note || 'عملية صندوق']
    );
    const cashAccountId = await getAccountId(tx, 'الصندوق');
    const entryDate = new Date().toISOString().split('T')[0];
    let journalDetails = [];
    let desc = note || (type === 'deposit' ? 'إيداع نقدي' : 'سحب نقدي');
    if (type === 'deposit') {
      const otherIncomeId = await getAccountId(tx, 'إيرادات أخرى');
      journalDetails = [
        { account_id: cashAccountId, debit: baseAmount, credit: 0 },
        { account_id: otherIncomeId, debit: 0, credit: baseAmount }
      ];
    } else {
      const expenseId = await getAccountId(tx, 'المصروفات');
      journalDetails = [
        { account_id: expenseId, debit: baseAmount, credit: 0 },
        { account_id: cashAccountId, debit: 0, credit: baseAmount }
      ];
    }
    checkBalance(journalDetails);
    await createJournalEntry(tx, entryDate, desc, journalDetails, 'cash_operation', null);
    await tx.commit();
    return jsonResponse({ success: true }, 200, headers);
  } catch (error) {
    await tx.rollback();
    return jsonResponse({ error: error.message }, 400, headers);
  }
}
async function getCashHistory(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT cr.*, c.code as currency_code, c.name as currency_name
    FROM cash_register cr JOIN currencies c ON c.id = cr.currency_id
    ORDER BY cr.created_at DESC LIMIT 100
  `);
  return jsonResponse({ history: rows }, 200, headers);
}
async function getCashBalance(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT currency_id,
      SUM(CASE WHEN type IN ('open','deposit') THEN amount ELSE -amount END) as balance,
      c.code, c.rate_to_base
    FROM cash_register cr JOIN currencies c ON c.id = cr.currency_id
    GROUP BY currency_id
  `);
  let totalBase = 0;
  const balances = rows.map(r => {
    const base = convertToBase(r.balance, r.rate_to_base);
    totalBase += base;
    return { currency_id: r.currency_id, code: r.code, balance: r.balance, balance_base: base };
  });
  return jsonResponse({ balances, total_base: totalBase }, 200, headers);
}

// ---- المصروفات ----
async function addExpense(request, env, headers) {
  const { name, amount, payment_method, wallet_id, note, currency_id, cash_amount, wallet_amount } = await request.json();
  if (!name || !amount || amount <= 0) return jsonResponse({ error: 'بيانات غير صالحة' }, 400, headers);
  
  if (!['cash', 'wallet', 'mixed'].includes(payment_method)) {
    return jsonResponse({ error: `طريقة الدفع "${payment_method}" غير مدعومة للمصروفات. الطرق المدعومة: cash, wallet, mixed` }, 400, headers);
  }
  
  const client = getTursoClient(env);
  await checkIfClosed(client, new Date().toISOString().slice(0, 10));
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) throw new Error('لا توجد عملة أساسية');
  const useCurrencyId = currency_id || baseCurrency.id;
  const tx = await client.transaction();
  try {
    const expenseAccountId = await getAccountId(tx, 'المصروفات');
    const cashAccountId = await getAccountId(tx, 'الصندوق');
    const walletAccountId = await getAccountId(tx, 'المحافظ');
    const expenseResult = await dbRun(tx,
      "INSERT INTO expenses (name, amount, payment_method, wallet_id, note) VALUES (?, ?, ?, ?, ?)",
      [name, amount, payment_method, wallet_id || null, note || '']
    );
    const entryDate = new Date().toISOString().split('T')[0];
    const desc = `مصروف: ${name}`;
    const rate = await getCurrencyRate(tx, useCurrencyId);
    if (!rate) throw new Error('سعر الصرف غير متاح');
    const baseAmount = convertToBase(amount, rate);
    
    if (payment_method === 'cash') {
      await dbRun(tx,
        "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES ('withdraw', ?, ?, ?, ?)",
        [amount, useCurrencyId, rate, desc]
      );
      await createJournalEntry(tx, entryDate, desc, [
        { account_id: expenseAccountId, debit: baseAmount, credit: 0 },
        { account_id: cashAccountId, debit: 0, credit: baseAmount }
      ], 'expense', expenseResult.lastInsertRowid);
    } 
    else if (payment_method === 'wallet') {
      if (!wallet_id) throw new Error('اختر المحفظة');
      const bal = await dbFirst(tx,
        "SELECT balance FROM wallet_balances WHERE wallet_id = ? AND currency_id = ?",
        [wallet_id, useCurrencyId]
      );
      if (!bal || bal.balance < amount) throw new Error('رصيد غير كافٍ');
      await updateWalletBalance(tx, wallet_id, useCurrencyId, amount, 'subtract');
      await dbRun(tx,
        "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'withdraw', ?, ?, ?, ?)",
        [wallet_id, amount, useCurrencyId, desc, expenseResult.lastInsertRowid]
      );
      await createJournalEntry(tx, entryDate, desc, [
        { account_id: expenseAccountId, debit: baseAmount, credit: 0 },
        { account_id: walletAccountId, debit: 0, credit: baseAmount }
      ], 'expense', expenseResult.lastInsertRowid);
    }
    else if (payment_method === 'mixed') {
      let cashPaid = parseFloat(cash_amount) || 0;
      let walletPaid = parseFloat(wallet_amount) || 0;
      if (cashPaid === 0 && walletPaid === 0) {
        cashPaid = amount / 2;
        walletPaid = amount / 2;
      }
      const totalPaid = cashPaid + walletPaid;
      if (Math.abs(totalPaid - amount) > 0.001) {
        const ratio = amount / totalPaid;
        cashPaid *= ratio;
        walletPaid *= ratio;
      }
      
      if (cashPaid > 0) {
        const cashRate = await getCurrencyRate(tx, useCurrencyId);
        if (!cashRate) throw new Error('سعر الصرف غير متاح للنقد');
        const cashBase = convertToBase(cashPaid, cashRate);
        await dbRun(tx,
          "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES ('withdraw', ?, ?, ?, ?)",
          [cashPaid, useCurrencyId, cashRate, `${desc} (نقدي)`]
        );
        await createJournalEntry(tx, entryDate, `${desc} (نقدي)`, [
          { account_id: expenseAccountId, debit: cashBase, credit: 0 },
          { account_id: cashAccountId, debit: 0, credit: cashBase }
        ], 'expense_cash', expenseResult.lastInsertRowid);
      }
      
      if (walletPaid > 0) {
        if (!wallet_id) throw new Error('اختر المحفظة للدفع المختلط');
        const walletRate = await getCurrencyRate(tx, useCurrencyId);
        if (!walletRate) throw new Error('سعر الصرف غير متاح للمحفظة');
        const walletBase = convertToBase(walletPaid, walletRate);
        const bal = await dbFirst(tx,
          "SELECT balance FROM wallet_balances WHERE wallet_id = ? AND currency_id = ?",
          [wallet_id, useCurrencyId]
        );
        if (!bal || bal.balance < walletPaid) throw new Error('رصيد غير كافٍ في المحفظة');
        await updateWalletBalance(tx, wallet_id, useCurrencyId, walletPaid, 'subtract');
        await dbRun(tx,
          "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'withdraw', ?, ?, ?, ?)",
          [wallet_id, walletPaid, useCurrencyId, `${desc} (محفظة)`, expenseResult.lastInsertRowid]
        );
        await createJournalEntry(tx, entryDate, `${desc} (محفظة)`, [
          { account_id: expenseAccountId, debit: walletBase, credit: 0 },
          { account_id: walletAccountId, debit: 0, credit: walletBase }
        ], 'expense_wallet', expenseResult.lastInsertRowid);
      }
    }
    
    await tx.commit();
    let walletName = null;
    if (wallet_id) { const w = await dbFirst(client, "SELECT name FROM wallets WHERE id = ?", [wallet_id]); walletName = w ? w.name : null; }
    return jsonResponse({ success: true, expense_id: expenseResult.lastInsertRowid, wallet_name: walletName }, 200, headers);
  } catch (error) {
    await tx.rollback();
    return jsonResponse({ error: error.message }, 400, headers);
  }
}
async function getExpenses(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT e.*, w.name as wallet_name
    FROM expenses e LEFT JOIN wallets w ON w.id = e.wallet_id
    ORDER BY e.created_at DESC LIMIT 2000
  `);
  return jsonResponse({ expenses: rows }, 200, headers);
}

// ==================== التصفية والكاش للتقارير ====================
const reportCache = new Map();
function buildFilters(url, allowedFilters = {}) {
  const params = url instanceof URL ? url.searchParams : new URL(url).searchParams;
  const conditions = [], args = [];
  for (const [key, cfg] of Object.entries(allowedFilters)) {
    const val = params.get(key);
    if (val === null || val === '') continue;
    const field = `${cfg.table ? cfg.table + '.' : ''}${cfg.field}`;
    const type = cfg.type || 'string';
    const op = cfg.operator || '=';
    if (type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(val)) { conditions.push(`${field} ${op} ?`); args.push(val); }
    else if (type === 'number' && Number.isFinite(Number(val))) { conditions.push(`${field} ${op} ?`); args.push(Number(val)); }
    else if (type === 'string' && (op === 'LIKE' || op === 'like')) { conditions.push(`${field} LIKE ?`); args.push(`%${val}%`); }
    else if (type === 'string') { conditions.push(`${field} = ?`); args.push(val); }
    else if (type === 'array') { const items = val.split(',').map(v => v.trim()).filter(Boolean); if (items.length) { conditions.push(`${field} IN (${items.map(() => '?').join(',')})`); args.push(...items); } }
  }
  return { conditions, args };
}
function cachedReport(key, ttlMs, producer) {
  const hit = reportCache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.data);
  return Promise.resolve(producer()).then(data => { reportCache.set(key, { data, expires: Date.now() + ttlMs }); return data; });
}
function invalidateReportCache() { reportCache.clear(); }
function reportDateRange(url, period = 'month') {
  const now = new Date(); const to = url.searchParams.get('to') || now.toISOString().slice(0, 10);
  const explicitFrom = url.searchParams.get('from'); if (explicitFrom) return { from: explicitFrom, to };
  const d = new Date(to); if (period === 'today') return { from: to, to };
  const days = period === 'week' ? 6 : period === 'year' ? 364 : 29; d.setDate(d.getDate() - days); return { from: d.toISOString().slice(0, 10), to };
}
async function checkIfClosed(client, operationDate) {
  const setting = await dbFirst(client, "SELECT value FROM settings WHERE key = 'closed_until_date'");
  const closed = setting?.value; if (closed && operationDate && String(operationDate).slice(0, 10) <= closed) throw new Error(`لا يمكن تعديل عمليات قبل تاريخ ${closed} (الفترة مغلقة محاسبياً)`);
}

// ==================== التقارير التحليلية المتقدمة ====================
async function getTopSellingProducts(request, env, headers) {
  const url = new URL(request.url), period = url.searchParams.get('period') || 'month';
  const { from, to } = reportDateRange(url, period); const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20'), 1), 50);
  const sortBy = url.searchParams.get('sort_by') === 'quantity' ? 'total_qty' : 'total_revenue';
  const key = `top-products:${url.search}`;
  const data = await cachedReport(key, 600000, async () => {
    const client = getTursoClient(env); const filters = ['s.status = \'completed\'', 'date(s.created_at) BETWEEN ? AND ?']; const args = [from, to];
    if (url.searchParams.get('category_id')) { filters.push('p.category_id = ?'); args.push(url.searchParams.get('category_id')); }
    if (url.searchParams.get('supplier_id')) { filters.push('si.supplier_id = ?'); args.push(url.searchParams.get('supplier_id')); }
    const rows = await dbAll(client, `SELECT p.id, p.name, p.barcode, COALESCE(p.unit_symbol, 'قطعة') unit_symbol,
      SUM(si.quantity) total_qty, SUM(si.total_price) total_revenue, SUM(COALESCE(si.cost_price, p.cost, 0) * si.quantity) total_cost,
      SUM(si.total_price - COALESCE(si.cost_price, p.cost, 0) * si.quantity) total_profit
      FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN products p ON p.id=si.product_id
      WHERE ${filters.join(' AND ')} GROUP BY p.id ORDER BY ${sortBy} DESC LIMIT ?`, [...args, limit]);
    return { period: { from, to }, products: rows };
  }); return jsonResponse(data, 200, headers);
}
async function getSalesByProduct(request, env, headers) {
  const url = new URL(request.url), { from, to } = reportDateRange(url, 'month'); const page = Math.max(parseInt(url.searchParams.get('page') || '1'), 1); const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50'), 1), 100); const offset = (page - 1) * limit;
  const key = `sales-by-product:${url.search}`; const data = await cachedReport(key, 300000, async () => { const client = getTursoClient(env); const f = buildFilters(url, { product_id:{field:'id',type:'number',table:'p'}, category_id:{field:'category_id',type:'number',table:'p'}, search:{field:'name',type:'string',operator:'LIKE',table:'p'} }); const where=['s.status=\'completed\'','date(s.created_at) BETWEEN ? AND ?',...f.conditions]; const args=[from,to,...f.args]; const rows=await dbAll(client,`SELECT p.id,p.name,p.barcode,COALESCE(p.unit_symbol,'قطعة') unit_symbol,SUM(si.quantity) total_qty,SUM(si.total_price) total_revenue,SUM(COALESCE(si.cost_price,p.cost,0)*si.quantity) total_cost FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN products p ON p.id=si.product_id WHERE ${where.join(' AND ')} GROUP BY p.id ORDER BY total_revenue DESC LIMIT ? OFFSET ?`,[...args,limit,offset]); const total=await dbFirst(client,`SELECT COUNT(*) total FROM (SELECT p.id FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN products p ON p.id=si.product_id WHERE ${where.join(' AND ')} GROUP BY p.id)`,args); return {from,to,page,limit,total:Number(total?.total||0),products:rows}; }); return jsonResponse(data,200,headers);
}
async function getTopCustomers(request, env, headers) { const url=new URL(request.url),{from,to}=reportDateRange(url,'year'),limit=Math.min(Math.max(parseInt(url.searchParams.get('limit')||'20'),1),100); const key=`top-customers:${url.search}`; const data=await cachedReport(key,1800000,async()=>{const c=getTursoClient(env); const f=['s.status=\'completed\'','date(s.created_at) BETWEEN ? AND ?']; const a=[from,to]; if(url.searchParams.get('customer_id')){f.push('c.id=?');a.push(url.searchParams.get('customer_id'));} if(url.searchParams.get('phone')){f.push('c.phone LIKE ?');a.push(`%${url.searchParams.get('phone')}%`);} if(url.searchParams.get('min_total')){f.push('1=1');} const rows=await dbAll(c,`SELECT COALESCE(c.id,0) customer_id,COALESCE(c.name,'عميل نقدي') customer_name,COALESCE(c.phone,'') phone,SUM(s.total_amount) total_spent,COUNT(*) invoice_count,AVG(s.total_amount) avg_invoice,MAX(s.created_at) last_purchase_date FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE ${f.join(' AND ')} GROUP BY c.id,c.name,c.phone HAVING SUM(s.total_amount)>=COALESCE(?,0) ORDER BY total_spent DESC LIMIT ?`,[...a,Number(url.searchParams.get('min_total')||0),limit]); return {from,to,customers:rows};}); return jsonResponse(data,200,headers); }
async function getMonthlyTrends(request, env, headers) {
  const url = new URL(request.url), year = parseInt(url.searchParams.get('year') || new Date().getFullYear());
  const key = `monthly-trends:${year}`;
  const data = await cachedReport(key, 3600000, async () => {
    const c = getTursoClient(env);
    const rows = await dbAll(c, `SELECT m.month, m.total_sales,
      COALESCE(k.total_cost,0) total_cost, m.total_sales-COALESCE(k.total_cost,0) total_profit, m.invoice_count
      FROM (SELECT strftime('%m',created_at) month, SUM(total_amount) total_sales, COUNT(*) invoice_count FROM sales WHERE status='completed' AND strftime('%Y',created_at)=? GROUP BY month) m
      LEFT JOIN (SELECT strftime('%m',s.created_at) month, SUM(COALESCE(si.cost_price,0)*si.quantity) total_cost FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.status='completed' AND strftime('%Y',s.created_at)=? GROUP BY month) k ON k.month=m.month ORDER BY m.month`, [String(year), String(year)]);
    const by = Object.fromEntries(rows.map(r => [r.month, r]));
    return {year, months:Array.from({length:12},(_,i)=>by[String(i+1).padStart(2,'0')]||{month:String(i+1).padStart(2,'0'),total_sales:0,total_cost:0,total_profit:0,invoice_count:0})};
  });
  return jsonResponse(data, 200, headers);
}
async function getDriverPerformance(request, env, headers) { const url=new URL(request.url),{from,to}=reportDateRange(url,'month'); const key=`driver-performance:${url.search}`; const data=await cachedReport(key,600000,async()=>{const c=getTursoClient(env); const f=['date(o.created_at) BETWEEN ? AND ?']; const a=[from,to]; if(url.searchParams.get('driver_id')){f.push('o.assigned_driver_id=?');a.push(url.searchParams.get('driver_id'));} if(url.searchParams.get('status')){f.push('o.status=?');a.push(url.searchParams.get('status'));} const rows=await dbAll(c,`SELECT d.id driver_id,d.name driver_name,COUNT(o.id) order_count,COALESCE(SUM(CASE WHEN o.status='تم التسليم' THEN o.actual_collected ELSE 0 END),0) total_collected,COALESCE(SUM(o.delivery_fee),0) total_fees,AVG(CASE WHEN o.status='تم التسليم' THEN julianday(o.updated_at)-julianday(o.created_at) END) avg_delivery_days FROM online_orders o JOIN drivers d ON d.id=o.assigned_driver_id WHERE ${f.join(' AND ')} GROUP BY d.id,d.name ORDER BY total_collected DESC`,a); return {from,to,drivers:rows};}); return jsonResponse(data,200,headers); }
async function getAgingReport(request, env, headers) { const url=new URL(request.url),type=url.searchParams.get('type')==='suppliers'?'suppliers':'customers'; const key=`aging:${type}:${url.search}`; const data=await cachedReport(key,1800000,async()=>{const c=getTursoClient(env); const table=type==='customers'?'customers':'suppliers'; const rows=await dbAll(c,`SELECT id,name,phone,COALESCE(balance,0) balance,CASE WHEN COALESCE(balance,0)<=0 THEN 0 ELSE CAST(julianday('now')-julianday(COALESCE(created_at,'now')) AS INTEGER) END age_days FROM ${table} ORDER BY balance DESC`); return {type,rows:rows.map(r=>({...r,current:r.age_days<=30?r.balance:0,days_31_60:r.age_days>30&&r.age_days<=60?r.balance:0,days_61_90:r.age_days>60&&r.age_days<=90?r.balance:0,over_90:r.age_days>90?r.balance:0}))};}); return jsonResponse(data,200,headers); }

// ==================== الإقفال المحاسبي ====================
async function closeAccountingYear(request, env, headers, userId) { const body=await request.json(); const closingDate=body.closing_date; if(!/^\d{4}-\d{2}-\d{2}$/.test(closingDate||'')) return jsonResponse({error:'closing_date بصيغة YYYY-MM-DD مطلوب'},400,headers); const c=getTursoClient(env); const settings=await getSettingsCached(c); if(settings.closed_until_date) return jsonResponse({error:`يوجد إقفال سابق حتى ${settings.closed_until_date}. نفّذ إعادة الفتح أولاً`},409,headers); const tx=await c.transaction(); try { const accounts=await dbAll(tx,"SELECT id,name,type FROM accounts WHERE type IN ('income','expense')"); const details=[]; let net=0; for(const a of accounts){const b=await dbFirst(tx,'SELECT COALESCE(SUM(debit-credit),0) balance FROM journal_entry_details WHERE account_id=?',[a.id]); const balance=Number(b?.balance||0); if(Math.abs(balance)<0.001)continue; if(a.type==='income'){details.push({account_id:a.id,debit:Math.max(0,-balance),credit:Math.max(0,balance),notes:'إقفال الإيراد'});net-=balance;}else{details.push({account_id:a.id,debit:Math.max(0,balance),credit:Math.max(0,-balance),notes:'إقفال المصروف'});net+=balance;}} const retained=await dbFirst(tx,"SELECT id FROM accounts WHERE name IN ('الأرباح المحتجزة','الأرباح المرحلة','Retained Earnings') LIMIT 1"); if(!retained)throw new Error('حساب الأرباح المحتجزة غير موجود'); if(net>0)details.push({account_id:retained.id,debit:0,credit:net,notes:'صافي نتيجة الإقفال'}); else if(net<0)details.push({account_id:retained.id,debit:-net,credit:0,notes:'صافي نتيجة الإقفال'}); const entryId=await createJournalEntry(tx,closingDate,'إقفال نهاية العام المالي',details,'closing_entry',null); await dbRun(tx,"INSERT INTO accounting_closures (closing_date,entry_id,retained_earnings,closed_by) VALUES (?,?,?,?)",[closingDate,entryId,net,userId||null]); await dbRun(tx,"INSERT INTO settings (key,value) VALUES ('closed_until_date',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[closingDate]); await tx.commit(); invalidateSettingsCache(); return jsonResponse({success:true,entry_id:entryId,retained_earnings:net},200,headers); }catch(e){await tx.rollback();return jsonResponse({error:e.message},400,headers);} }
async function reopenAccounting(request, env, headers, userId) { const c=getTursoClient(env); const tx=await c.transaction(); try { const closure=await dbFirst(tx,'SELECT * FROM accounting_closures ORDER BY id DESC LIMIT 1'); if(!closure)return jsonResponse({error:'لا يوجد إقفال سابق'},404,headers); await dbRun(tx,'DELETE FROM journal_entry_details WHERE entry_id=?',[closure.entry_id]); await dbRun(tx,'DELETE FROM journal_entries WHERE id=? AND reference_type=\'closing_entry\'',[closure.entry_id]); await dbRun(tx,'DELETE FROM accounting_closures WHERE id=?',[closure.id]); await dbRun(tx,"INSERT INTO settings (key,value) VALUES ('closed_until_date','') ON CONFLICT(key) DO UPDATE SET value=''",[]); await tx.commit(); invalidateSettingsCache(); return jsonResponse({success:true,message:'تم فتح السنة المالية'},200,headers); }catch(e){await tx.rollback();return jsonResponse({error:e.message},400,headers);} }

// ---- الحسابات والقيد ----
async function getAccounts(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, "SELECT * FROM accounts ORDER BY code");
  return jsonResponse({ accounts: rows }, 200, headers);
}
async function createAccount(request, env, headers) {
  const data = await request.json();
  const client = getTursoClient(env);
  const existing = await dbFirst(client, "SELECT id FROM accounts WHERE code = ?", [data.code]);
  if (existing) return jsonResponse({ error: 'الكود موجود مسبقاً' }, 409, headers);
  const result = await dbRun(client,
    "INSERT INTO accounts (name, code, parent_id, type, is_active) VALUES (?, ?, ?, ?, 1)",
    [data.name, data.code, data.parent_id || null, data.type]
  );
  return jsonResponse({ success: true, id: result.lastInsertRowid }, 200, headers);
}
async function getJournalEntries(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT je.*,
      (SELECT json_group_array(json_object('account_id', jed.account_id, 'debit', jed.debit, 'credit', jed.credit, 'notes', jed.notes))
       FROM journal_entry_details jed WHERE jed.entry_id = je.id) as details
    FROM journal_entries je ORDER BY je.entry_date DESC, je.created_at DESC LIMIT 100
  `);
  return jsonResponse({ entries: rows }, 200, headers);
}
async function createManualJournalEntry(request, env, headers) {
  const { entry_date, description, details } = await request.json();
  if (!entry_date || !description || !details || !Array.isArray(details) || details.length === 0) {
    return jsonResponse({ error: 'بيانات القيد غير مكتملة' }, 400, headers);
  }
  const client = getTursoClient(env);
  await checkIfClosed(client, entry_date);
  let totalDebit = 0, totalCredit = 0;
  for (const d of details) { totalDebit += d.debit || 0; totalCredit += d.credit || 0; }
  if (Math.abs(totalDebit - totalCredit) > 0.001) return jsonResponse({ error: 'القيد غير متوازن' }, 400, headers);
  const entryId = await createJournalEntry(client, entry_date, description, details, 'manual', null);
  return jsonResponse({ success: true, entry_id: entryId }, 200, headers);
}

// ---- التقارير الأساسية ----
async function getDailyReport(request, env, headers) {
  const client = getTursoClient(env);
  const today = new Date().toISOString().split('T')[0];
  const salesData = await dbFirst(client,
    "SELECT SUM(total_amount) as total_sales, COUNT(*) as invoices_count FROM sales WHERE DATE(created_at) = ? AND status='completed'",
    [today]
  );
  const totalSales = salesData?.total_sales || 0;
  const invoicesCount = salesData?.invoices_count || 0;
  const paymentSplit = await dbAll(client,
    "SELECT payment_method, SUM(total_amount) as total FROM sales WHERE DATE(created_at) = ? AND status='completed' GROUP BY payment_method",
    [today]
  );
  let cashSales = 0, walletSales = 0, creditSales = 0;
  paymentSplit.forEach(row => {
    if (row.payment_method === 'cash') cashSales = row.total;
    else if (row.payment_method === 'wallet') walletSales = row.total;
    else if (row.payment_method === 'credit') creditSales = row.total;
  });
  const costData = await dbFirst(client, `
    SELECT SUM(si.cost_price * (si.quantity - COALESCE(rs.returned_qty, 0))) as total_cost
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    LEFT JOIN (
      SELECT sale_id, product_id, SUM(quantity) as returned_qty
      FROM returned_sales
      GROUP BY sale_id, product_id
    ) rs ON rs.sale_id = si.sale_id AND rs.product_id = si.product_id
    WHERE DATE(s.created_at) = ? AND s.status='completed'
  `, [today]);
  const totalCost = costData?.total_cost || 0;
  const profitData = await dbFirst(client,
    "SELECT SUM(profit) as total_profit FROM sales WHERE DATE(created_at) = ? AND status='completed'",
    [today]
  );
  const grossProfit = profitData?.total_profit || 0;
  const expensesData = await dbFirst(client,
    "SELECT SUM(amount) as total_expenses FROM expenses WHERE DATE(created_at) = ?",
    [today]
  );
  const totalExpenses = expensesData?.total_expenses || 0;
  const netProfit = grossProfit - totalExpenses;
  const walletSummaries = await dbAll(client, `
    SELECT w.name, wb.currency_id, c.code, wb.balance
    FROM wallet_balances wb JOIN wallets w ON w.id = wb.wallet_id JOIN currencies c ON c.id = wb.currency_id
  `);
  const walletsGrouped = {};
  walletSummaries.forEach(ws => {
    if (!walletsGrouped[ws.name]) walletsGrouped[ws.name] = [];
    walletsGrouped[ws.name].push({ currency: ws.code, balance: ws.balance });
  });
  return jsonResponse({
    date: today, total_sales: totalSales, invoices_count: invoicesCount,
    cash_sales: cashSales, wallet_sales: walletSales, credit_sales: creditSales,
    total_cost: totalCost, gross_profit: grossProfit, total_expenses: totalExpenses,
    net_profit: netProfit,
    wallets: Object.keys(walletsGrouped).map(name => ({ name, balances: walletsGrouped[name] }))
  }, 200, headers);
}
async function getTrialBalance(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT a.id, a.name, a.code, a.type,
      COALESCE(SUM(jed.debit), 0) as total_debit,
      COALESCE(SUM(jed.credit), 0) as total_credit
    FROM accounts a
    LEFT JOIN journal_entry_details jed ON jed.account_id = a.id
    GROUP BY a.id ORDER BY a.code
  `);
  const trialBalance = rows.map(row => ({ ...row, balance: row.total_debit - row.total_credit, balance_type: row.total_debit > row.total_credit ? 'debit' : (row.total_credit > row.total_debit ? 'credit' : 'zero') }));
  return jsonResponse({ trial_balance: trialBalance }, 200, headers);
}
async function getIncomeStatement(request, env, headers) {
  const client = getTursoClient(env);
  const incomeAccounts = await dbAll(client, "SELECT id FROM accounts WHERE type = 'income'");
  const expenseAccounts = await dbAll(client, "SELECT id FROM accounts WHERE type = 'expense'");
  const incomeIds = incomeAccounts.map(r => r.id).join(',');
  const expenseIds = expenseAccounts.map(r => r.id).join(',');
  let totalRevenue = 0, totalExpenses = 0;
  if (incomeIds) {
    const rev = await dbFirst(client, `SELECT COALESCE(SUM(debit - credit), 0) as total FROM journal_entry_details WHERE account_id IN (${incomeIds})`);
    totalRevenue = Math.abs(rev?.total || 0);
  }
  if (expenseIds) {
    const exp = await dbFirst(client, `SELECT COALESCE(SUM(debit - credit), 0) as total FROM journal_entry_details WHERE account_id IN (${expenseIds})`);
    totalExpenses = exp?.total || 0;
  }
  const netIncome = totalRevenue - totalExpenses;
  return jsonResponse({ total_revenue: totalRevenue, total_expenses: totalExpenses, net_income: netIncome }, 200, headers);
}
async function getBalanceSheet(request, env, headers) {
  const client = getTursoClient(env);
  const assetAccounts = await dbAll(client, "SELECT id FROM accounts WHERE type = 'asset'");
  const liabilityAccounts = await dbAll(client, "SELECT id FROM accounts WHERE type = 'liability'");
  const equityAccounts = await dbAll(client, "SELECT id FROM accounts WHERE type = 'equity'");
  
  const getBalance = async (ids) => {
    if (!ids.length) return 0;
    const idList = ids.map(r => r.id).join(',');
    const result = await dbFirst(client, `SELECT COALESCE(SUM(debit - credit), 0) as total FROM journal_entry_details WHERE account_id IN (${idList})`);
    return result?.total || 0;
  };
  
  const totalAssets = await getBalance(assetAccounts);
  const totalLiabilities = await getBalance(liabilityAccounts);
  const totalEquity = await getBalance(equityAccounts);

  const incomeAccountsForNet = await dbAll(client, "SELECT id FROM accounts WHERE type = 'income'");
  const expenseAccountsForNet = await dbAll(client, "SELECT id FROM accounts WHERE type = 'expense'");
  const incomeNetIds = incomeAccountsForNet.map(r => r.id).join(',');
  const expenseNetIds = expenseAccountsForNet.map(r => r.id).join(',');
  const incomeNetRow = incomeNetIds ? await dbFirst(client, `SELECT COALESCE(SUM(debit - credit), 0) AS total FROM journal_entry_details WHERE account_id IN (${incomeNetIds})`) : { total: 0 };
  const expenseNetRow = expenseNetIds ? await dbFirst(client, `SELECT COALESCE(SUM(debit - credit), 0) AS total FROM journal_entry_details WHERE account_id IN (${expenseNetIds})`) : { total: 0 };
  const netIncome = Math.abs(incomeNetRow?.total || 0) - (expenseNetRow?.total || 0);

  const totalEquityWithNet = totalEquity + netIncome;

  const difference = totalAssets - (totalLiabilities + totalEquityWithNet);

  return jsonResponse({
    assets: totalAssets,
    liabilities: totalLiabilities,
    equity: totalEquityWithNet,
    difference: difference
  }, 200, headers);
}
async function exportReport(request, env, headers) {
  const url = new URL(request.url);
  const type = url.searchParams.get('type');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!type || !from || !to) return jsonResponse({ error: 'نوع التقرير والتاريخ مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  let results;
  if (type === 'sales') {
    results = await dbAll(client, `SELECT s.*, c.name as customer_name FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE DATE(s.created_at) BETWEEN ? AND ? AND s.status='completed'`, [from, to]);
  } else if (type === 'purchases') {
    results = await dbAll(client, `SELECT pi.*, su.name as supplier_name FROM purchase_invoices pi JOIN suppliers su ON su.id = pi.supplier_id WHERE DATE(pi.created_at) BETWEEN ? AND ? AND pi.status='completed'`, [from, to]);
  } else if (type === 'profits') {
    results = await dbAll(client, `SELECT DATE(created_at) as date, SUM(profit) as daily_profit FROM sales WHERE DATE(created_at) BETWEEN ? AND ? AND status='completed' GROUP BY DATE(created_at)`, [from, to]);
  } else if (type === 'expenses') {
    results = await dbAll(client, `SELECT * FROM expenses WHERE DATE(created_at) BETWEEN ? AND ?`, [from, to]);
  } else return jsonResponse({ error: 'نوع غير معروف' }, 400, headers);
  return jsonResponse({ report_type: type, from, to, data: results }, 200, headers);
}

// ---- الإعدادات ----
async function getSettings(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, "SELECT * FROM settings");
  const settings = {};
  rows.forEach(row => settings[row.key] = row.value);
  return jsonResponse({ settings }, 200, headers);
}
async function updateSettings(request, env, headers) {
  const data = await request.json();
  const client = getTursoClient(env);
  const statements = [];
  for (const [key, value] of Object.entries(data)) {
    statements.push({ sql: "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP", args: [key, value] });
  }
  if (statements.length > 0) {
    await client.batch(statements);
    invalidateSettingsCache();
  }
  return jsonResponse({ success: true }, 200, headers);
}

// ---- سندات القبض والصرف ----
async function addCashVoucher(request, env, headers) {
  const { type, amount, currency_id, reason } = await request.json();
  if (!['receipt', 'payment'].includes(type) || !amount || amount <= 0 || !currency_id) {
    return jsonResponse({ error: 'نوع غير صحيح أو مبلغ غير صالح أو العملة غير محددة' }, 400, headers);
  }
  const client = getTursoClient(env);
  await checkIfClosed(client, new Date().toISOString().slice(0, 10));
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) throw new Error('لا توجد عملة أساسية');
  const tx = await client.transaction();
  try {
    const rate = await getCurrencyRate(tx, currency_id);
    if (!rate) throw new Error('العملة غير موجودة');
    const baseAmount = convertToBase(amount, rate);
    const voucherResult = await dbRun(tx,
      "INSERT INTO cash_vouchers (type, amount, currency_id, exchange_rate, reason) VALUES (?, ?, ?, ?, ?)",
      [type, amount, currency_id, rate, reason || '']
    );
    const cashType = type === 'receipt' ? 'deposit' : 'withdraw';
    await dbRun(tx,
      "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES (?, ?, ?, ?, ?)",
      [cashType, amount, currency_id, rate, `سند ${type} - ${reason || ''}`]
    );
    const cashAccountId = await getAccountId(tx, 'الصندوق');
    const entryDate = new Date().toISOString().split('T')[0];
    let journalDetails = [];
    if (type === 'receipt') {
      const receiptAccountId = await getAccountId(tx, 'إيرادات أخرى');
      journalDetails = [
        { account_id: cashAccountId, debit: baseAmount, credit: 0 },
        { account_id: receiptAccountId, debit: 0, credit: baseAmount }
      ];
    } else {
      const paymentAccountId = await getAccountId(tx, 'المصروفات');
      journalDetails = [
        { account_id: paymentAccountId, debit: baseAmount, credit: 0 },
        { account_id: cashAccountId, debit: 0, credit: baseAmount }
      ];
    }
    checkBalance(journalDetails);
    await createJournalEntry(tx, entryDate, `سند ${type}: ${reason}`, journalDetails, 'cash_voucher', voucherResult.lastInsertRowid);
    await tx.commit();
    return jsonResponse({ success: true, voucher_id: voucherResult.lastInsertRowid }, 200, headers);
  } catch (error) {
    await tx.rollback();
    return jsonResponse({ error: error.message }, 400, headers);
  }
}
async function getCashVouchers(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT cv.*, c.code as currency_code, c.name as currency_name
    FROM cash_vouchers cv JOIN currencies c ON c.id = cv.currency_id
    ORDER BY cv.created_at DESC LIMIT 2000
  `);
  return jsonResponse({ vouchers: rows }, 200, headers);
}
async function cancelCashVoucher(request, env, headers) {
  const { voucher_id } = await request.json();
  if (!voucher_id) return jsonResponse({ error: 'معرف السند مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const tx = await client.transaction();
  try {
    const voucher = await dbFirst(tx, "SELECT * FROM cash_vouchers WHERE id = ?", [voucher_id]);
    if (!voucher) throw new Error('السند غير موجود');
    const cashType = voucher.type === 'receipt' ? 'withdraw' : 'deposit';
    await dbRun(tx,
      `INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note)
       VALUES (?, ?, ?, ?, ?)`,
      [cashType, voucher.amount, voucher.currency_id, voucher.exchange_rate, `إلغاء سند #${voucher_id}`]
    );
    await dbRun(tx, "DELETE FROM cash_vouchers WHERE id = ?", [voucher_id]);
    await tx.commit();
    return jsonResponse({ success: true }, 200, headers);
  } catch (error) {
    await tx.rollback();
    return jsonResponse({ error: error.message }, 400, headers);
  }
}

// ---- إلغاء السندات ----
async function cancelPayment(request, env, headers) {
  const { payment_type, payment_id } = await request.json();
  if (!payment_type || !payment_id) return jsonResponse({ error: 'بيانات غير صالحة' }, 400, headers);
  const client = getTursoClient(env);
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) throw new Error('لا توجد عملة أساسية');
  const tx = await client.transaction();
  try {
    const entryDate = new Date().toISOString().split('T')[0];
    if (payment_type === 'customer') {
      const payment = await dbFirst(tx, "SELECT * FROM customer_payments WHERE id = ?", [payment_id]);
      if (!payment) throw new Error('السند غير موجود');
      const amount = parseFloat(payment.amount);
      let currencyId = payment.currency_id || baseCurrency.id;
      let rate = payment.exchange_rate || await getCurrencyRate(tx, currencyId) || 1;
      if (payment.payment_method === 'cash') {
        await dbRun(tx,
          `INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note)
           VALUES ('withdraw', ?, ?, ?, ?)`,
          [amount, currencyId, rate, `إلغاء سند قبض من العميل #${payment_id}`]
        );
      } else if (payment.payment_method === 'wallet' && payment.wallet_id) {
        const walletTx = await dbFirst(tx,
          "SELECT currency_id FROM wallet_transactions WHERE reference_id = ? AND type = 'deposit' ORDER BY id LIMIT 1",
          [payment_id]
        );
        const walletCurrencyId = walletTx ? walletTx.currency_id : currencyId;
        await dbRun(tx,
          `INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id)
           VALUES (?, 'withdraw', ?, ?, ?, ?)`,
          [payment.wallet_id, amount, walletCurrencyId, `إلغاء سند قبض من العميل #${payment_id}`, payment_id]
        );
        await updateWalletBalance(tx, payment.wallet_id, walletCurrencyId, amount, 'subtract');
        const baseAmount = amount * (await getCurrencyRate(tx, walletCurrencyId) || 1);
        await dbRun(tx, "UPDATE customers SET balance = balance + ? WHERE id = ?", [baseAmount, payment.customer_id]);
      } else {
        const baseAmount = amount * rate;
        await dbRun(tx, "UPDATE customers SET balance = balance + ? WHERE id = ?", [baseAmount, payment.customer_id]);
      }
      const originalEntry = await dbFirst(tx,
        `SELECT je.id FROM journal_entries je WHERE je.reference_type = 'customer_payment' AND je.reference_id = ? ORDER BY je.id LIMIT 1`,
        [payment_id]
      );
      if (originalEntry) {
        const allDetails = await dbAll(tx,
          `SELECT account_id, debit, credit FROM journal_entry_details WHERE entry_id = ?`,
          [originalEntry.id]
        );
        const reversedJournal = allDetails.map(d => ({ account_id: d.account_id, debit: d.credit, credit: d.debit, notes: `عكس سند #${payment_id}` }));
        checkBalance(reversedJournal);
        await createJournalEntry(tx, entryDate, `إلغاء سند قبض عميل #${payment_id}`, reversedJournal, 'cancel_payment', payment_id);
      }
      await dbRun(tx, "DELETE FROM customer_payments WHERE id = ?", [payment_id]);
    } else if (payment_type === 'supplier') {
      const payment = await dbFirst(tx, "SELECT * FROM supplier_payments WHERE id = ?", [payment_id]);
      if (!payment) throw new Error('السند غير موجود');
      const amount = parseFloat(payment.amount);
      let currencyId = payment.currency_id || baseCurrency.id;
      let rate = payment.exchange_rate || await getCurrencyRate(tx, currencyId) || 1;
      const baseAmount = amount * rate;
      const delta = payment.type === 'receipt' ? -baseAmount : baseAmount;
      await dbRun(tx, "UPDATE suppliers SET balance = balance + ? WHERE id = ?", [delta, payment.supplier_id]);
      if (payment.payment_method === 'cash') {
        const cashType = payment.type === 'receipt' ? 'withdraw' : 'deposit';
        await dbRun(tx,
          `INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note)
           VALUES (?, ?, ?, ?, ?)`,
          [cashType, amount, currencyId, rate, `إلغاء سند #${payment_id}`]
        );
      } else if (payment.payment_method === 'wallet' && payment.wallet_id) {
        const walletTx = await dbFirst(tx,
          "SELECT currency_id FROM wallet_transactions WHERE reference_id = ? ORDER BY id LIMIT 1",
          [payment_id]
        );
        const walletCurrencyId = walletTx ? walletTx.currency_id : currencyId;
        const walletType = payment.type === 'receipt' ? 'withdraw' : 'deposit';
        await dbRun(tx,
          `INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [payment.wallet_id, walletType, amount, walletCurrencyId, `إلغاء سند #${payment_id}`, payment_id]
        );
        const walletDelta = payment.type === 'receipt' ? -amount : amount;
        await updateWalletBalance(tx, payment.wallet_id, walletCurrencyId, Math.abs(walletDelta), walletDelta > 0 ? 'add' : 'subtract');
      }
      const originalEntry = await dbFirst(tx,
        `SELECT je.id FROM journal_entries je WHERE je.reference_type = 'supplier_payment' AND je.reference_id = ? ORDER BY je.id LIMIT 1`,
        [payment_id]
      );
      if (originalEntry) {
        const allDetails = await dbAll(tx,
          `SELECT account_id, debit, credit FROM journal_entry_details WHERE entry_id = ?`,
          [originalEntry.id]
        );
        const reversedJournal = allDetails.map(d => ({ account_id: d.account_id, debit: d.credit, credit: d.debit, notes: `عكس سند #${payment_id}` }));
        checkBalance(reversedJournal);
        await createJournalEntry(tx, entryDate, `إلغاء سند #${payment_id}`, reversedJournal, 'cancel_payment', payment_id);
      }
      await dbRun(tx, "DELETE FROM supplier_payments WHERE id = ?", [payment_id]);
    } else throw new Error('نوع غير معروف');
    await tx.commit();
    return jsonResponse({ success: true }, 200, headers);
  } catch (error) {
    await tx.rollback();
    return jsonResponse({ error: error.message }, 400, headers);
  }
}

// ---- المزامنة والربط ----
async function getPendingProducts(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT pp.id as pending_id, p.id as product_id, p.name, p.price, p.description, p.category, p.barcode, p.stock_quantity, p.image_data, pp.created_at
    FROM pending_products pp JOIN products p ON p.id = pp.product_id
    WHERE pp.status = 'pending' ORDER BY pp.created_at DESC
  `);
  return jsonResponse({ products: rows }, 200, headers);
}
async function confirmProductPublish(request, env, headers) {
  const { pending_id, site_product_id } = await request.json();
  if (!pending_id || !site_product_id) return jsonResponse({ error: 'pending_id and site_product_id required' }, 400, headers);
  const client = getTursoClient(env);
  const pending = await dbFirst(client, "SELECT product_id FROM pending_products WHERE id = ? AND status = 'pending'", [pending_id]);
  if (!pending) return jsonResponse({ error: 'Pending record not found or already processed' }, 404, headers);
  await dbRun(client, "UPDATE pending_products SET status = 'synced', site_product_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [site_product_id, pending_id]);
  await dbRun(client, "UPDATE products SET site_product_id = ? WHERE id = ?", [site_product_id, pending.product_id]);
  return jsonResponse({ success: true }, 200, headers);
}
async function linkProduct(request, env, headers) {
  const { pos_product_id, site_product_id } = await request.json();
  if (!pos_product_id || !site_product_id) return jsonResponse({ error: 'pos_product_id and site_product_id required' }, 400, headers);
  const client = getTursoClient(env);
  const product = await dbFirst(client, "SELECT id, stock_quantity FROM products WHERE id = ? AND is_active = 1", [pos_product_id]);
  if (!product) return jsonResponse({ error: 'المنتج غير موجود' }, 404, headers);
  const existing = await dbFirst(client, "SELECT id FROM products WHERE site_product_id = ? AND id != ?", [site_product_id, pos_product_id]);
  if (existing) return jsonResponse({ error: 'هذا المعرف مستخدم لمنتج آخر' }, 400, headers);
  await dbRun(client, "UPDATE products SET site_product_id = ? WHERE id = ?", [site_product_id, pos_product_id]);
  return jsonResponse({ success: true }, 200, headers);
}
async function addPendingProduct(request, env, headers) {
  const { product_id } = await request.json();
  if (!product_id) return jsonResponse({ error: 'product_id مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const product = await dbFirst(client, "SELECT id, name FROM products WHERE id = ?", [product_id]);
  if (!product) return jsonResponse({ error: 'المنتج غير موجود' }, 404, headers);
  const existing = await dbFirst(client, "SELECT id FROM pending_products WHERE product_id = ? AND status = 'pending'", [product_id]);
  if (existing) return jsonResponse({ error: 'المنتج موجود بالفعل في قائمة الانتظار' }, 409, headers);
  const result = await dbRun(client, `INSERT INTO pending_products (product_id, status, created_at) VALUES (?, 'pending', CURRENT_TIMESTAMP)`, [product_id]);
  return jsonResponse({ success: true, message: `تم إضافة المنتج "${product.name}" إلى قائمة الانتظار`, pending_id: result.lastInsertRowid }, 200, headers);
}
async function skipPendingProduct(request, env, headers) {
  const { pending_id } = await request.json();
  if (!pending_id) return jsonResponse({ error: 'pending_id مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const pending = await dbFirst(client, "SELECT product_id FROM pending_products WHERE id = ? AND status = 'pending'", [pending_id]);
  if (!pending) return jsonResponse({ error: 'السجل غير موجود أو تمت معالجته مسبقاً' }, 404, headers);
  await dbRun(client, `UPDATE pending_products SET status = 'skipped', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [pending_id]);
  return jsonResponse({ success: true, message: 'تم تخطي المنتج بنجاح' }, 200, headers);
}
async function getUnlinkedProducts(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT id, name, barcode, stock_quantity, price, cost, category
    FROM products WHERE (site_product_id IS NULL OR site_product_id = 0) AND is_active = 1 ORDER BY name
  `);
  return jsonResponse({ products: rows }, 200, headers);
}
async function getLinkedProducts(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT id, name, barcode, stock_quantity, price, cost, category, site_product_id
    FROM products WHERE site_product_id IS NOT NULL AND site_product_id != 0 AND is_active = 1 ORDER BY name
  `);
  return jsonResponse({ products: rows }, 200, headers);
}
async function updateStock(request, env, headers) {
  const { product_id, quantity_change } = await request.json();
  if (!product_id || quantity_change === undefined) return jsonResponse({ error: 'product_id and quantity_change required' }, 400, headers);
  const client = getTursoClient(env);
  try {
    const product = await dbFirst(client, "SELECT id, site_product_id, stock_quantity, name FROM products WHERE id = ?", [product_id]);
    if (!product) return jsonResponse({ error: 'المنتج غير موجود' }, 404, headers);
    const newStock = Math.max(0, product.stock_quantity + quantity_change);
    await dbRun(client, `UPDATE products SET stock_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [newStock, product_id]);
    let synced = false;
    if (product.site_product_id) {
      try {
        const siteUrl = `${env.SITE_BASE_URL}/products/${product.site_product_id}`;
        const response = await fetch(siteUrl, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${env.STOCK_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ stock_quantity: newStock })
        });
        synced = response.ok;
      } catch (fetchError) { console.error('خطأ في الاتصال بالمتجر:', fetchError.message); }
    }
    return jsonResponse({ success: true, message: 'تم تحديث المخزون بنجاح', product_id, product_name: product.name, new_stock: newStock, synced_with_site: synced }, 200, headers);
  } catch (error) { return jsonResponse({ error: error.message }, 500, headers); }
}
async function unlinkProduct(request, env, headers) {
  const { pos_product_id } = await request.json();
  if (!pos_product_id) return jsonResponse({ error: 'pos_product_id required' }, 400, headers);
  const client = getTursoClient(env);
  const product = await dbFirst(client, "SELECT id, name, site_product_id FROM products WHERE id = ?", [pos_product_id]);
  if (!product) return jsonResponse({ error: 'المنتج غير موجود' }, 404, headers);
  if (!product.site_product_id) return jsonResponse({ error: 'المنتج غير مرتبط أصلاً' }, 400, headers);
  await dbRun(client, "UPDATE products SET site_product_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [pos_product_id]);
  return jsonResponse({ success: true, message: `تم إلغاء ربط المنتج "${product.name}"` }, 200, headers);
}

// ---- التقارير المتقدمة ----
async function getSalesByCategory(request, env, headers) {
  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const client = getTursoClient(env);
  let dateCondition = '';
  const args = [];
  if (from && to) { dateCondition = "AND DATE(s.created_at) BETWEEN ? AND ?"; args.push(from, to); }
  else if (from) { dateCondition = "AND DATE(s.created_at) >= ?"; args.push(from); }
  else if (to) { dateCondition = "AND DATE(s.created_at) <= ?"; args.push(to); }
  const rows = await dbAll(client, `
    SELECT cat.id, cat.name AS category_name,
      COUNT(DISTINCT s.id) AS invoices_count,
      SUM(si.quantity) AS items_sold,
      SUM(si.total_price) AS total_sales,
      SUM(si.cost_price * si.quantity) AS total_cost,
      SUM(si.total_price) - SUM(si.cost_price * si.quantity) AS profit
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN products p ON p.id = si.product_id
    JOIN categories cat ON cat.id = p.category_id
    WHERE s.status = 'completed' ${dateCondition}
    GROUP BY cat.id ORDER BY total_sales DESC
  `, args);
  return jsonResponse({ sales_by_category: rows }, 200, headers);
}
async function getProfitsByCategory(request, env, headers) {
  return await getSalesByCategory(request, env, headers);
}
async function getInventoryByCategory(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT cat.id, cat.name AS category_name,
      COUNT(p.id) AS product_count,
      SUM(p.stock_quantity) AS total_stock,
      SUM(p.stock_quantity * p.cost) AS inventory_value
    FROM products p JOIN categories cat ON cat.id = p.category_id
    WHERE p.is_active = 1
    GROUP BY cat.id ORDER BY inventory_value DESC
  `);
  return jsonResponse({ inventory_by_category: rows }, 200, headers);
}

// ---- المندوبين ----
async function getDrivers(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, "SELECT id, name, phone, vehicle_info, is_active, username FROM drivers");
  return jsonResponse({ drivers: rows }, 200, headers);
}
async function createDriver(request, env, headers) {
  const { name, phone, vehicle_info, username, password } = await request.json();
  if (!name) return jsonResponse({ error: 'الاسم مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  if (username && password) {
    const existing = await dbFirst(client, "SELECT id FROM drivers WHERE username = ?", [username]);
    if (existing) return jsonResponse({ error: 'اسم المستخدم موجود مسبقاً' }, 409, headers);
    const salt = crypto.randomUUID();
    const hash = await hashPassword(password, salt);
    const result = await dbRun(client,
      "INSERT INTO drivers (name, phone, vehicle_info, username, password_hash, salt) VALUES (?, ?, ?, ?, ?, ?)",
      [name, phone, vehicle_info, username, hash, salt]
    );
    await dbRun(client,
      "INSERT INTO driver_accounts (driver_id, balance, total_deliveries, total_collected, total_fees, total_paid_to_shop) VALUES (?, 0, 0, 0, 0, 0)",
      [result.lastInsertRowid]
    );
    return jsonResponse({ success: true, id: result.lastInsertRowid }, 200, headers);
  } else {
    const result = await dbRun(client,
      "INSERT INTO drivers (name, phone, vehicle_info) VALUES (?, ?, ?)",
      [name, phone, vehicle_info]
    );
    await dbRun(client,
      "INSERT INTO driver_accounts (driver_id, balance, total_deliveries, total_collected, total_fees, total_paid_to_shop) VALUES (?, 0, 0, 0, 0, 0)",
      [result.lastInsertRowid]
    );
    return jsonResponse({ success: true, id: result.lastInsertRowid }, 200, headers);
  }
}
async function updateDriver(request, env, headers) {
  const id = parseInt(request.url.split('/').pop());
  const { name, phone, vehicle_info, is_active, password } = await request.json();
  const client = getTursoClient(env);
  const driver = await dbFirst(client, "SELECT id FROM drivers WHERE id = ?", [id]);
  if (!driver) return jsonResponse({ error: 'المندوب غير موجود' }, 404, headers);
  const fields = [], values = [];
  if (name !== undefined) { fields.push('name = ?'); values.push(name); }
  if (phone !== undefined) { fields.push('phone = ?'); values.push(phone); }
  if (vehicle_info !== undefined) { fields.push('vehicle_info = ?'); values.push(vehicle_info); }
  if (is_active !== undefined) { fields.push('is_active = ?'); values.push(is_active ? 1 : 0); }
  if (password) {
    const salt = crypto.randomUUID();
    const hash = await hashPassword(password, salt);
    fields.push('password_hash = ?', 'salt = ?');
    values.push(hash, salt);
  }
  if (fields.length === 0) return jsonResponse({ error: 'لا توجد بيانات للتحديث' }, 400, headers);
  values.push(id);
  await dbRun(client, `UPDATE drivers SET ${fields.join(', ')} WHERE id = ?`, values);
  return jsonResponse({ success: true }, 200, headers);
}
async function deleteDriver(request, env, headers) {
  const id = parseInt(request.url.split('/').pop());
  const client = getTursoClient(env);
  const driver = await dbFirst(client, "SELECT id FROM drivers WHERE id = ?", [id]);
  if (!driver) return jsonResponse({ error: 'المندوب غير موجود' }, 404, headers);
  const account = await dbFirst(client, "SELECT balance FROM driver_accounts WHERE driver_id = ?", [id]);
  if (account && Math.abs(account.balance) > 0.001) {
    return jsonResponse({ error: 'لا يمكن حذف المندوب لأن رصيده غير صفري' }, 400, headers);
  }
  const pendingOrders = await dbFirst(client,
    "SELECT COUNT(*) as cnt FROM online_orders WHERE assigned_driver_id = ? AND status NOT IN ('تم التسليم', 'فشل التسليم', 'مرتجع')",
    [id]
  );
  if (pendingOrders && pendingOrders.cnt > 0) {
    return jsonResponse({ error: 'لا يمكن حذف المندوب لأنه لديه طلبات معلقة' }, 400, headers);
  }
  await dbRun(client, "DELETE FROM drivers WHERE id = ?", [id]);
  await dbRun(client, "DELETE FROM driver_accounts WHERE driver_id = ?", [id]);
  return jsonResponse({ success: true }, 200, headers);
}
async function getDriversSummary(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT d.id, d.name, d.phone,
      COALESCE(da.balance, 0) as balance,
      COALESCE(da.total_deliveries, 0) as total_deliveries,
      COALESCE(da.total_collected, 0) as total_collected,
      COALESCE(da.total_fees, 0) as total_fees,
      COALESCE(da.total_paid_to_shop, 0) as total_paid_to_shop,
      COALESCE(da.last_settlement_date, '') as last_settlement_date
    FROM drivers d LEFT JOIN driver_accounts da ON d.id = da.driver_id
    WHERE d.is_active = 1 ORDER BY d.name
  `);
  return jsonResponse({ drivers: rows }, 200, headers);
}
// ==================== جلب حركة المخزون لمنتج ====================
// ==================== جلب حركة المخزون لمنتج ====================
async function getProductStockMovements(request, env, headers) {
  const url = new URL(request.url);
  // استخراج رقم المنتج من المسار: /products/123/stock-movements
  const match = url.pathname.match(/\/products\/(\d+)\/stock-movements/);
  if (!match) {
    return jsonResponse({ error: 'معرف المنتج غير صالح' }, 400, headers);
  }
  const productId = parseInt(match[1], 10);
  if (isNaN(productId) || productId <= 0) {
    return jsonResponse({ error: 'معرف المنتج غير صالح' }, 400, headers);
  }

  const client = getTursoClient(env);
  // تحقق من وجود المنتج
  const product = await dbFirst(client, "SELECT id, name FROM products WHERE id = ? AND is_active = 1", [productId]);
  if (!product) {
    return jsonResponse({ error: 'المنتج غير موجود' }, 404, headers);
  }

  // جلب حركة المخزون مع معلومات المستخدم والمورد
  const movements = await dbAll(client, `
    SELECT 
      sm.id,
      sm.quantity_change,
      sm.old_quantity,
      sm.new_quantity,
      sm.reference_type,
      sm.reference_id,
      sm.note,
      sm.created_at,
      sm.supplier_id,
      u.username as created_by_name,
      s.name as supplier_name
    FROM stock_movements sm
    LEFT JOIN users u ON u.id = sm.created_by
    LEFT JOIN suppliers s ON s.id = sm.supplier_id
    WHERE sm.product_id = ?
    ORDER BY sm.created_at DESC
    LIMIT 1000
  `, [productId]);

  return jsonResponse({
    product_id: product.id,
    product_name: product.name,
    movements: movements
  }, 200, headers);
}
// ================================================================
//  دوال الإرجاع (نظام المرحلتين) =================================
// ================================================================

async function confirmReturn(returnId, confirmedBy, request, env, ctx, headers) {
  const client = getTursoClient(env);
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) {
    return jsonResponse({ error: 'لا توجد عملة أساسية' }, 400, headers);
  }

  const returnRec = await dbFirst(client, `
    SELECT * FROM online_order_returns WHERE id = ? AND status = 'pending'
  `, [returnId]);
  if (!returnRec) {
    return jsonResponse({ error: 'الإرجاع غير موجود أو ليس في حالة معلقة' }, 404, headers);
  }

  const order = await dbFirst(client, "SELECT * FROM online_orders WHERE id = ?", [returnRec.order_id]);
  if (!order) {
    return jsonResponse({ error: 'الطلب غير موجود' }, 404, headers);
  }

  let sale = null;
  if (order.accounting_invoice_id) {
    sale = await dbFirst(client, "SELECT * FROM sales WHERE id = ?", [order.accounting_invoice_id]);
    if (!sale) {
      return jsonResponse({ error: 'الفاتورة غير موجودة' }, 400, headers);
    }
  } else {
    return jsonResponse({ error: 'لا توجد فاتورة محاسبية' }, 400, headers);
  }

  const returnItems = await dbAll(client, `
    SELECT * FROM online_order_return_items WHERE return_id = ?
  `, [returnId]);
  if (returnItems.length === 0) {
    return jsonResponse({ error: 'لا توجد عناصر للإرجاع' }, 400, headers);
  }

  const orderItems = await dbAll(client, "SELECT * FROM online_order_items WHERE order_id = ?", [order.id]);
  const saleItems = await dbAll(client, "SELECT * FROM sale_items WHERE sale_id = ?", [sale.id]);

  let totalRefund = parseFloat(returnRec.total_refund) || 0;
  let totalRefundCost = 0;
  const productCostMap = {};

  const itemsToReturn = [];
  for (const rItem of returnItems) {
    const orderItem = orderItems.find(oi => oi.id === rItem.order_item_id);
    if (!orderItem) continue;
    if (!productCostMap[orderItem.product_id]) {
      const prod = await dbFirst(client, "SELECT cost FROM products WHERE id = ?", [orderItem.product_id]);
      productCostMap[orderItem.product_id] = prod ? prod.cost : 0;
    }
    const costPrice = productCostMap[orderItem.product_id] || 0;
    totalRefundCost += rItem.quantity * costPrice;
    const saleItem = saleItems.find(si => si.product_id === orderItem.product_id);
    itemsToReturn.push({
      order_item_id: rItem.order_item_id,
      product_id: orderItem.product_id,
      quantity: rItem.quantity,
      unit_price: orderItem.unit_price,
      line_total: rItem.line_total,
      cost_price: costPrice,
      supplier_id: (saleItem || {}).supplier_id || null,
      supplier_price: (saleItem || {}).supplier_price || costPrice
    });
  }

  const refundMethod = returnRec.refund_method || 'cash';
  let refundCash = parseFloat(returnRec.cash_refund) || 0;
  let refundWallet = parseFloat(returnRec.wallet_refund) || 0;
  if (refundMethod === 'cash' && refundCash === 0) refundCash = totalRefund;
  else if (refundMethod === 'wallet' && refundWallet === 0) refundWallet = totalRefund;
  else if (refundMethod === 'mixed' && refundCash === 0 && refundWallet === 0) {
    // إصلاح #10: الطلب المختلط — التوزيع الافتراضي بنسبة المدفوعات الأصلية من الفاتورة
    const orderForRefund = await dbFirst(client, "SELECT * FROM online_orders WHERE id = ?", [order.id]);
    if (isMixedOrder(orderForRefund) && sale) {
      const originalTotalPaid = (parseFloat(sale.cash_paid) || 0) + (parseFloat(sale.wallet_paid) || 0);
      if (originalTotalPaid > 0) {
        refundCash = totalRefund * (parseFloat(sale.cash_paid) / originalTotalPaid);
        refundWallet = totalRefund * (parseFloat(sale.wallet_paid) / originalTotalPaid);
      } else {
        refundCash = totalRefund;
      }
    } else {
      refundCash = totalRefund / 2;
      refundWallet = totalRefund / 2;
    }
  }
  if (Math.abs(refundCash + refundWallet - totalRefund) > 0.01) {
    const ratio = totalRefund / (refundCash + refundWallet);
    refundCash *= ratio;
    refundWallet *= ratio;
  }
  const walletId = returnRec.wallet_id;

  const deliveryFeeReturn = parseFloat(returnRec.return_fee) || 0;
  const deliveryFeeType = returnRec.return_fee_type || 'shop';

  let adjustedRefundCash = refundCash;
  let adjustedRefundWallet = refundWallet;
  let adjustedCustomerCredit = totalRefund;

  if (deliveryFeeReturn > 0.001 && deliveryFeeType !== 'free') {
    if (deliveryFeeType === 'customer') {
      const totalAfterDeduction = Math.max(0, totalRefund - deliveryFeeReturn);
      const totalCurrent = refundCash + refundWallet;
      if (totalCurrent > 0.001) {
        const ratio = totalAfterDeduction / totalCurrent;
        adjustedRefundCash = refundCash * ratio;
        adjustedRefundWallet = refundWallet * ratio;
      } else {
        adjustedRefundCash = 0;
        adjustedRefundWallet = 0;
      }
      adjustedCustomerCredit = totalAfterDeduction;
    }
  }

  const tx = await client.transaction();
  try {
    // ===== جلب كميات المخزون دفعة واحدة =====
    const productIds = itemsToReturn.map(item => item.product_id).filter(id => id);
    const stockCache = {};
    if (productIds.length) {
      const stockRows = await dbAll(tx,
        `SELECT id, stock_quantity FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`,
        productIds
      );
      stockRows.forEach(row => {
        stockCache[row.id] = parseFloat(row.stock_quantity) || 0;
      });
    }

    const batchQueries = [];

    // تحديث المخزون والموردين
    let bestSupplierMap = {};
    if (productIds.length > 0) {
      const bestSuppliers = await dbAll(tx, `
        SELECT product_id, supplier_id
        FROM product_supplier_stock
        WHERE product_id IN (${productIds.map(() => '?').join(',')}) AND quantity > 0
        ORDER BY product_id, quantity DESC
      `, productIds);
      for (const row of bestSuppliers) {
        if (!bestSupplierMap[row.product_id]) {
          bestSupplierMap[row.product_id] = row.supplier_id;
        }
      }
    }

    let existingStocks = [];
    if (productIds.length > 0) {
      existingStocks = await dbAll(tx, `
        SELECT product_id, id, supplier_id
        FROM product_supplier_stock
        WHERE product_id IN (${productIds.map(() => '?').join(',')})
      `, productIds);
    }
    const stockMap = {};
    for (const stock of existingStocks) {
      if (!stockMap[stock.product_id]) stockMap[stock.product_id] = [];
      stockMap[stock.product_id].push(stock);
    }

    for (const ri of itemsToReturn) {
      await applyStockChange(tx, batchQueries, {
        productId: ri.product_id,
        supplierId: ri.supplier_id || bestSupplierMap[ri.product_id] || null,
        delta: ri.quantity,
        referenceType: 'online_order_return',
        referenceId: returnId,
        note: `تأكيد إرجاع طلب #${order.id}`,
        userId: confirmedBy || null,
        stockCache
      });

      batchQueries.push({
        sql: "UPDATE online_order_items SET quantity = quantity - ? WHERE id = ? AND quantity >= ?",
        args: [ri.quantity, ri.order_item_id, ri.quantity]
      });
      batchQueries.push({
        sql: "DELETE FROM online_order_items WHERE id = ? AND quantity <= 0",
        args: [ri.order_item_id]
      });
    }

    // تحديث الفاتورة
    const newTotal = Math.max(0, sale.total_amount - totalRefund);
    const newTotalCost = Math.max(0, sale.total_cost - totalRefundCost);
    const newCashPaid = Math.max(0, (sale.cash_paid || 0) - adjustedRefundCash);
    const newWalletPaid = Math.max(0, (sale.wallet_paid || 0) - adjustedRefundWallet);
    const newPaidAmount = newCashPaid + newWalletPaid;
    const newProfit = newTotal - newTotalCost;

    batchQueries.push({
      sql: `UPDATE sales SET 
        total_amount = ?, total_cost = ?, profit = ?, 
        cash_paid = ?, wallet_paid = ?, paid_amount = ?
        WHERE id = ?`,
      args: [newTotal, newTotalCost, newProfit, newCashPaid, newWalletPaid, newPaidAmount, sale.id]
    });

    if (newTotal <= 0.01) {
      batchQueries.push({
        sql: "UPDATE sales SET status = 'fully_returned' WHERE id = ?",
        args: [sale.id]
      });
    }

    // تحديث حالة الطلب
    const totalOrderQty = await dbFirst(tx, "SELECT COALESCE(SUM(quantity), 0) as total FROM online_order_items WHERE order_id = ?", [order.id]);
    let newOrderStatus = (totalOrderQty.total <= 0) ? 'مرتجع كلي' : 'مرتجع جزئي';
    batchQueries.push({
      sql: "UPDATE online_orders SET status = ? WHERE id = ?",
      args: [newOrderStatus, order.id]
    });

    // القيد المحاسبي
    const entryDate = new Date().toISOString().split('T')[0];
    const desc = `تأكيد إرجاع طلب إنترنت #${order.id}`;

    const accounts = await dbAll(tx, "SELECT id, name FROM accounts");
    const accountsMap = Object.fromEntries(accounts.map(a => [a.name, a.id]));
    const getAccountId = (name) => {
      if (!accountsMap[name]) throw new Error(`الحساب "${name}" غير موجود`);
      return accountsMap[name];
    };

    let driverReceivableId;
    try {
      driverReceivableId = getAccountId('الذمم المدينة (مندوبين)');
    } catch (e) {
      const accResult = await dbRun(tx,
        "INSERT INTO accounts (name, code, parent_id, type, is_active) VALUES (?, ?, ?, ?, 1)",
        ['الذمم المدينة (مندوبين)', '1250', null, 'asset']
      );
      driverReceivableId = accResult.lastInsertRowid;
      accountsMap['الذمم المدينة (مندوبين)'] = driverReceivableId;
    }

    const saleAccountId = getAccountId('المبيعات');
    const cogsAccountId = getAccountId('تكلفة البضاعة المباعة');
    const inventoryAccountId = getAccountId('المخزون');
    const cashAccountId = getAccountId('الصندوق');
    const walletAccountId = getAccountId('المحافظ');
    const customerAccountId = getAccountId('الذمم المدينة (عملاء)');
    const deliveryFeeLiabilityId = getAccountId('رسوم التوصيل المستحقة');

    const journalDetails = [];

    let salesRefund = totalRefund;
    if (deliveryFeeType === 'customer' && deliveryFeeReturn > 0.001) {
      salesRefund = totalRefund - deliveryFeeReturn;
    }

    journalDetails.push({ account_id: saleAccountId, debit: salesRefund, credit: 0 });

    if (adjustedRefundCash > 0.001) {
      const cashRate = await getCurrencyRate(tx, baseCurrency.id) || 1;
      const baseRefundCash = convertToBase(adjustedRefundCash, cashRate);
      journalDetails.push({ account_id: cashAccountId, debit: 0, credit: baseRefundCash });
      batchQueries.push({
        sql: "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES ('withdraw', ?, ?, ?, ?)",
        args: [adjustedRefundCash, baseCurrency.id, cashRate, desc + ' (نقدي)']
      });
    }

    if (adjustedRefundWallet > 0.001) {
      if (!walletId) throw new Error('معرف المحفظة مطلوب للإرجاع عبر المحفظة');
      const walletRate = await getCurrencyRate(tx, baseCurrency.id) || 1;
      const baseRefundWallet = convertToBase(adjustedRefundWallet, walletRate);
      journalDetails.push({ account_id: walletAccountId, debit: 0, credit: baseRefundWallet });
      const bal = await dbFirst(tx,
        "SELECT balance FROM wallet_balances WHERE wallet_id = ? AND currency_id = ?",
        [walletId, baseCurrency.id]
      );
      if (!bal || bal.balance < adjustedRefundWallet) throw new Error('رصيد غير كافٍ في المحفظة');
      batchQueries.push({
        sql: "UPDATE wallet_balances SET balance = balance - ? WHERE wallet_id = ? AND currency_id = ?",
        args: [adjustedRefundWallet, walletId, baseCurrency.id]
      });
      batchQueries.push({
        sql: "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'withdraw', ?, ?, ?, ?)",
        args: [walletId, adjustedRefundWallet, baseCurrency.id, desc + ' (محفظة)', returnId]
      });
    }

    if (sale.payment_method === 'credit' && sale.customer_id) {
      journalDetails.push({ account_id: customerAccountId, debit: 0, credit: adjustedCustomerCredit });
      batchQueries.push({
        sql: "UPDATE customers SET balance = balance - ? WHERE id = ?",
        args: [adjustedCustomerCredit, sale.customer_id]
      });
    }

    if (totalRefundCost > 0.001) {
      journalDetails.push({ account_id: inventoryAccountId, debit: totalRefundCost, credit: 0 });
      journalDetails.push({ account_id: cogsAccountId, debit: 0, credit: totalRefundCost });
    }

    if (deliveryFeeReturn > 0.001 && deliveryFeeType !== 'free') {
      const driverId = returnRec.assigned_driver_id || order.assigned_driver_id;

      if (deliveryFeeType === 'customer') {
        journalDetails.push({
          account_id: deliveryFeeLiabilityId,
          debit: deliveryFeeReturn,
          credit: 0,
          notes: 'إلغاء رسوم توصيل مستردة من العميل'
        });
        journalDetails.push({
          account_id: driverReceivableId,
          debit: 0,
          credit: deliveryFeeReturn,
          notes: 'تحويل رسوم التوصيل لمستحقات المندوب (من العميل)'
        });

        if (driverId) {
          let driverAccount = await dbFirst(tx, "SELECT id, balance FROM driver_accounts WHERE driver_id = ?", [driverId]);
          if (!driverAccount) {
            await dbRun(tx,
              "INSERT INTO driver_accounts (driver_id, balance, total_deliveries, total_collected, total_fees, total_paid_to_shop) VALUES (?, 0, 0, 0, 0, 0)",
              [driverId]
            );
          }
          batchQueries.push({
            sql: "UPDATE driver_accounts SET balance = balance - ?, total_fees = total_fees + ? WHERE driver_id = ?",
            args: [deliveryFeeReturn, deliveryFeeReturn, driverId]
          });
          batchQueries.push({
            sql: "INSERT INTO driver_transactions (driver_id, order_id, type, amount, description) VALUES (?, ?, 'delivery_fee', ?, ?)",
            args: [driverId, order.id, deliveryFeeReturn, `أجرة توصيل للطلب #${order.id} (إرجاع - من العميل)`]
          });
        }

      } else if (deliveryFeeType === 'shop') {
        let expenseAccountId = await getOrCreateAccount(tx, 'مصروفات التوصيل', '6101', 'expense');

        journalDetails.push({
          account_id: deliveryFeeLiabilityId,
          debit: deliveryFeeReturn,
          credit: 0,
          notes: 'تسوية رسوم توصيل يتحملها المحل'
        });
        journalDetails.push({
          account_id: expenseAccountId,
          debit: 0,
          credit: deliveryFeeReturn,
          notes: 'تحميل رسوم التوصيل على المحل'
        });

        if (driverId) {
          let driverAccount = await dbFirst(tx, "SELECT id, balance FROM driver_accounts WHERE driver_id = ?", [driverId]);
          if (!driverAccount) {
            await dbRun(tx,
              "INSERT INTO driver_accounts (driver_id, balance, total_deliveries, total_collected, total_fees, total_paid_to_shop) VALUES (?, 0, 0, 0, 0, 0)",
              [driverId]
            );
          }
          batchQueries.push({
            sql: "UPDATE driver_accounts SET balance = balance - ?, total_fees = total_fees + ? WHERE driver_id = ?",
            args: [deliveryFeeReturn, deliveryFeeReturn, driverId]
          });
          batchQueries.push({
            sql: "INSERT INTO driver_transactions (driver_id, order_id, type, amount, description) VALUES (?, ?, 'delivery_fee', ?, ?)",
            args: [driverId, order.id, deliveryFeeReturn, `أجرة توصيل للطلب #${order.id} (إرجاع)`]
          });
        }
      }
    }

    if (journalDetails.length > 0) {
      checkBalance(journalDetails);
      const entryResult = await dbRun(tx,
        "INSERT INTO journal_entries (entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?)",
        [entryDate, desc, 'online_order_return', returnId]
      );
      const entryId = entryResult.lastInsertRowid;
      for (const detail of journalDetails) {
        batchQueries.push({
          sql: "INSERT INTO journal_entry_details (entry_id, account_id, debit, credit, notes) VALUES (?, ?, ?, ?, ?)",
          args: [entryId, detail.account_id, detail.debit || 0, detail.credit || 0, detail.notes || '']
        });
      }
    }

    batchQueries.push({
      sql: `UPDATE online_order_returns SET 
        status = 'completed', 
        confirmed_at = CURRENT_TIMESTAMP, 
        confirmed_by = ?
        WHERE id = ?`,
      args: [confirmedBy || 1, returnId]
    });

    batchQueries.push({
      sql: "INSERT INTO order_status_log (order_id, old_status, new_status, status, notes) VALUES (?, ?, ?, ?, ?)",
      args: [order.id, order.status, newOrderStatus, newOrderStatus, `تأكيد إرجاع #${returnId}`]
    });

    // ===== تنفيذ الدفعات على أجزاء =====
    const BATCH_SIZE = 40;
    for (let i = 0; i < batchQueries.length; i += BATCH_SIZE) {
      const chunk = batchQueries.slice(i, i + BATCH_SIZE);
      await tx.batch(chunk, 'write');
    }

    await tx.commit();

    if (order.assigned_driver_id) {
      ctx.waitUntil(sendAdminFCMNotification(
        env,
        '✅ تم تأكيد الإرجاع',
        `تم تأكيد إرجاع الطلب #${order.id}`
      ));
    }

    return jsonResponse({
      success: true,
      return_id: returnId,
      total_refund: totalRefund,
      new_order_status: newOrderStatus,
      message: 'تم تأكيد الإرجاع بنجاح'
    }, 200, headers);

  } catch (error) {
    await tx.rollback();
    console.error('خطأ في confirmReturn:', error);
    return jsonResponse({ error: 'فشل تأكيد الإرجاع: ' + error.message }, 500, headers);
  }
}

// ================================================================
//  دوال الإرجاع والإلغاء (استكمال) =================================
// ================================================================

async function cancelSaleInvoice(request, env, headers, userId) {
  try {
    const { sale_id } = await request.json();
    if (!sale_id) return jsonResponse({ error: 'معرف الفاتورة مطلوب' }, 400, headers);

    const client = getTursoClient(env);
    const baseCurrency = await getBaseCurrency(client);
    if (!baseCurrency) return jsonResponse({ error: 'لا توجد عملة أساسية' }, 400, headers);

    const sale = await dbFirst(client, "SELECT * FROM sales WHERE id = ?", [sale_id]);
    if (!sale) return jsonResponse({ error: 'الفاتورة غير موجودة' }, 404, headers);
    if (sale.status === 'cancelled') {
      return jsonResponse({ error: 'الفاتورة ملغاة بالفعل' }, 400, headers);
    }
    if (sale.status !== 'completed') {
      return jsonResponse({ error: 'لا يمكن إلغاء فاتورة غير مكتملة' }, 400, headers);
    }

    const saleItems = await dbAll(client, `
      SELECT si.*, p.cost AS product_cost
      FROM sale_items si JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = ?
    `, [sale_id]);

    if (saleItems.length === 0) {
      return jsonResponse({ error: 'الفاتورة لا تحتوي على عناصر' }, 400, headers);
    }

    const returnedData = await dbAll(client, `
      SELECT product_id, SUM(quantity) as returned_qty
      FROM returned_sales
      WHERE sale_id = ?
      GROUP BY product_id
    `, [sale_id]);
    const returnedMap = {};
    for (const r of returnedData) {
      returnedMap[r.product_id] = r.returned_qty;
    }

    if (returnedData.length > 0) {
      return jsonResponse({ error: 'لا يمكن إلغاء فاتورة تحتوي على إرجاعات سابقة؛ اعكس الإرجاعات أولاً أو استخدم الإرجاع الكامل' }, 400, headers);
    }

    const productIds = saleItems.map(item => Number(item.product_id)).filter(Number.isInteger);
    let supplierStocks = [];
    if (productIds.length > 0) {
      supplierStocks = await dbAll(client, `
        SELECT product_id, id, quantity, supplier_id
        FROM product_supplier_stock
        WHERE product_id IN (${productIds.join(',')})
      `);
    }
    const stockMap = {};
    for (const stock of supplierStocks) {
      if (!stockMap[stock.product_id]) stockMap[stock.product_id] = [];
      stockMap[stock.product_id].push(stock);
    }

    let bestSupplierMap = {};
    if (productIds.length > 0) {
      const bestSuppliers = await dbAll(client, `
        SELECT product_id, supplier_id
        FROM product_supplier_stock
        WHERE product_id IN (${productIds.join(',')}) AND quantity > 0
        ORDER BY product_id, quantity DESC
      `);
      for (const row of bestSuppliers) {
        if (!bestSupplierMap[row.product_id]) {
          bestSupplierMap[row.product_id] = row.supplier_id;
        }
      }
    }

    const cashInfo = await dbFirst(client,
      "SELECT currency_id, exchange_rate FROM cash_register WHERE note LIKE ? ORDER BY created_at DESC LIMIT 1",
      [`%${sale.invoice_number}%`]
    );
    const walletInfo = await dbFirst(client,
      "SELECT currency_id FROM wallet_transactions WHERE reference_id = ? AND type = 'deposit' LIMIT 1",
      [sale_id]
    );
    let walletRate = baseCurrency.rate_to_base;
    if (walletInfo) {
      const rateRow = await dbFirst(client, "SELECT rate_to_base FROM currencies WHERE id = ?", [walletInfo.currency_id]);
      if (rateRow) walletRate = rateRow.rate_to_base;
    }

    const refundCash = parseFloat(sale.cash_paid) || 0;
    const refundWallet = parseFloat(sale.wallet_paid) || 0;

    let baseRefundCash = 0, baseRefundWallet = 0;
    let cashCurrencyId = baseCurrency.id, cashRate = baseCurrency.rate_to_base;

    if (refundCash > 0.01) {
      if (cashInfo) {
        cashCurrencyId = cashInfo.currency_id;
        cashRate = cashInfo.exchange_rate || 1;
        baseRefundCash = convertToBase(refundCash, cashRate);
      } else {
        cashCurrencyId = baseCurrency.id;
        cashRate = 1;
        baseRefundCash = refundCash;
      }
    }

    if (refundWallet > 0.01 && sale.wallet_id) {
      const walletCurrencyId = walletInfo ? walletInfo.currency_id : baseCurrency.id;
      baseRefundWallet = convertToBase(refundWallet, walletRate);
    }

    const accounts = await dbAll(client, "SELECT id, name FROM accounts");
    const accountsMap = Object.fromEntries(accounts.map(a => [a.name, a.id]));
    const getAccountIdFast = (name) => {
      if (!accountsMap[name]) throw new Error(`الحساب "${name}" غير موجود`);
      return accountsMap[name];
    };

    const tx = await client.transaction();
    try {
      // ===== جلب كميات المخزون دفعة واحدة =====
      const stockCache = {};
      if (productIds.length) {
        const stockRows = await dbAll(tx,
          `SELECT id, stock_quantity FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`,
          productIds
        );
        stockRows.forEach(row => {
          stockCache[row.id] = parseFloat(row.stock_quantity) || 0;
        });
      }

      const batchQueries = [];
      let totalCost = 0;

      for (const item of saleItems) {
        const returnedQty = returnedMap[item.product_id] || 0;
        const remainingQty = item.quantity - returnedQty;
        if (remainingQty <= 0) continue;

        await applyStockChange(tx, batchQueries, {
          productId: item.product_id,
          supplierId: item.supplier_id || bestSupplierMap[item.product_id] || null,
          delta: remainingQty,
          referenceType: 'cancel_sale',
          referenceId: sale_id,
          note: `إلغاء فاتورة #${sale.invoice_number}`,
          userId,
          stockCache
        });
        totalCost += remainingQty * item.cost_price;
      }

      batchQueries.push({
        sql: "UPDATE sales SET status = 'cancelled', profit = 0 WHERE id = ?",
        args: [sale_id]
      });

      const entryDate = new Date().toISOString().split('T')[0];
      const desc = `إلغاء فاتورة مبيعات #${sale.invoice_number}`;

      const saleAccountId = getAccountIdFast('المبيعات');
      const cogsAccountId = getAccountIdFast('تكلفة البضاعة المباعة');
      const inventoryAccountId = getAccountIdFast('المخزون');
      const cashAccountId = getAccountIdFast('الصندوق');
      const walletAccountId = getAccountIdFast('المحافظ');
      const customerAccountId = getAccountIdFast('الذمم المدينة (عملاء)');

      const journalDetails = [];
      let totalDebit = 0, totalCredit = 0;

      journalDetails.push({ account_id: saleAccountId, debit: sale.total_amount, credit: 0 });
      totalDebit += sale.total_amount;

      if (refundCash > 0.01 && baseRefundCash > 0) {
        journalDetails.push({ account_id: cashAccountId, debit: 0, credit: baseRefundCash });
        totalCredit += baseRefundCash;
        batchQueries.push({
          sql: "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES ('withdraw', ?, ?, ?, ?)",
          args: [refundCash, cashCurrencyId, cashRate, `إلغاء فاتورة #${sale.invoice_number} (نقدي)`]
        });
      }

      if (refundWallet > 0.01 && sale.wallet_id && baseRefundWallet > 0) {
        const walletCurrencyId = walletInfo ? walletInfo.currency_id : baseCurrency.id;
        journalDetails.push({ account_id: walletAccountId, debit: 0, credit: baseRefundWallet });
        totalCredit += baseRefundWallet;
        batchQueries.push({
          sql: "UPDATE wallet_balances SET balance = balance - ? WHERE wallet_id = ? AND currency_id = ?",
          args: [refundWallet, sale.wallet_id, walletCurrencyId]
        });
        batchQueries.push({
          sql: "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'withdraw', ?, ?, ?, ?)",
          args: [sale.wallet_id, refundWallet, walletCurrencyId, `إلغاء فاتورة #${sale.invoice_number}`, sale_id]
        });
      }

      if (sale.payment_method === 'credit' && sale.customer_id) {
        journalDetails.push({ account_id: customerAccountId, debit: 0, credit: sale.total_amount });
        totalCredit += sale.total_amount;
        batchQueries.push({
          sql: "UPDATE customers SET balance = balance - ? WHERE id = ?",
          args: [sale.total_amount, sale.customer_id]
        });
      }

      if (totalCost > 0) {
        journalDetails.push({ account_id: inventoryAccountId, debit: totalCost, credit: 0 });
        totalDebit += totalCost;
        journalDetails.push({ account_id: cogsAccountId, debit: 0, credit: totalCost });
        totalCredit += totalCost;
      }

      if (Math.abs(totalDebit - totalCredit) > 0.001) {
        throw new Error(`القيد غير متوازن: مدين=${totalDebit}, دائن=${totalCredit}`);
      }

      if (journalDetails.length > 0) {
        checkBalance(journalDetails);
        await createJournalEntry(tx, entryDate, desc, journalDetails, 'cancel_sale', sale_id);
      }

      // ===== تنفيذ الدفعات على أجزاء =====
      const BATCH_SIZE = 40;
      for (let i = 0; i < batchQueries.length; i += BATCH_SIZE) {
        const chunk = batchQueries.slice(i, i + BATCH_SIZE);
        await tx.batch(chunk, 'write');
      }

      await tx.commit();

      return jsonResponse({
        success: true,
        message: 'تم إلغاء الفاتورة وعكس القيد المحاسبي بنجاح',
        refund_cash: refundCash,
        refund_wallet: refundWallet,
        total_cost: totalCost
      }, 200, headers);

    } catch (innerError) {
      await tx.rollback();
      throw innerError;
    }
  } catch (error) {
    return jsonResponse({ error: error.message || 'فشل إلغاء الفاتورة' }, 400, headers);
  }
}

async function returnSaleItem(request, env, headers, userId) {
  const { sale_id, product_id, quantity, reason } = await request.json();
  if (!sale_id || !product_id || !quantity || quantity <= 0) {
    return jsonResponse({ error: 'بيانات غير صالحة' }, 400, headers);
  }
  const client = getTursoClient(env);
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) return jsonResponse({ error: 'لا توجد عملة أساسية' }, 400, headers);
  
  const sale = await dbFirst(client, "SELECT * FROM sales WHERE id = ? AND status IN ('completed', 'partially_returned')", [sale_id]);
  if (!sale) return jsonResponse({ error: 'الفاتورة غير موجودة أو ملغاة' }, 404, headers);
  
  const saleItem = await dbFirst(client, "SELECT * FROM sale_items WHERE sale_id = ? AND product_id = ?", [sale_id, product_id]);
  if (!saleItem) return jsonResponse({ error: 'المنتج غير موجود في الفاتورة' }, 404, headers);
  
  const returnedQty = await getRemainingQty(client, sale_id, product_id);
  const maxReturnable = saleItem.quantity - returnedQty;
  if (quantity > maxReturnable) {
    return jsonResponse({ error: `الكمية المطلوبة للإرجاع (${quantity}) تتجاوز الكمية المتبقية (${maxReturnable})` }, 400, headers);
  }
  
  const refundAmount = saleItem.unit_price * quantity;
  const costAmount = saleItem.cost_price * quantity;
  
  const tx = await client.transaction();
  try {
    let targetSupplierId = saleItem.supplier_id;
    let supplierPrice = saleItem.supplier_price || saleItem.cost_price;
    
    if (!targetSupplierId) {
      const bestSupplierRow = await dbFirst(tx,
        "SELECT supplier_id FROM product_supplier_stock WHERE product_id = ? AND quantity > 0 ORDER BY quantity DESC LIMIT 1",
        [product_id]
      );
      if (bestSupplierRow) {
        targetSupplierId = bestSupplierRow.supplier_id;
      }
    }
    
    let targetStock = null;
    if (targetSupplierId) {
      targetStock = await dbFirst(tx,
        "SELECT id FROM product_supplier_stock WHERE product_id = ? AND supplier_id = ?",
        [product_id, targetSupplierId]
      );
    }
    
    const cashInfo = await dbFirst(tx,
      "SELECT currency_id, exchange_rate FROM cash_register WHERE note LIKE ? ORDER BY created_at DESC LIMIT 1",
      [`%${sale.invoice_number}%`]
    );
    const walletInfo = await dbFirst(tx,
      "SELECT currency_id FROM wallet_transactions WHERE reference_id = ? AND type = 'deposit' LIMIT 1",
      [sale_id]
    );
    let walletRate = baseCurrency.rate_to_base;
    if (walletInfo) {
      const rateRow = await dbFirst(tx, "SELECT rate_to_base FROM currencies WHERE id = ?", [walletInfo.currency_id]);
      if (rateRow) walletRate = rateRow.rate_to_base;
    }
    
    const accounts = await dbAll(tx, "SELECT id, name FROM accounts");
    const accountsMap = Object.fromEntries(accounts.map(a => [a.name, a.id]));
    const getAccountIdFast = (name) => {
      if (!accountsMap[name]) throw new Error(`الحساب "${name}" غير موجود`);
      return accountsMap[name];
    };
    const saleAccountId = getAccountIdFast('المبيعات');
    const cogsAccountId = getAccountIdFast('تكلفة البضاعة المباعة');
    const inventoryAccountId = getAccountIdFast('المخزون');
    const cashAccountId = getAccountIdFast('الصندوق');
    const walletAccountId = getAccountIdFast('المحافظ');
    const customerAccountId = getAccountIdFast('الذمم المدينة (عملاء)');
    
    const batchQueries = [];
    
    batchQueries.push({
      sql: "INSERT INTO returned_sales (sale_id, product_id, quantity, amount, reason) VALUES (?, ?, ?, ?, ?)",
      args: [sale_id, product_id, quantity, refundAmount, reason || '']
    });
    
    // استخدام applyStockChange لتحديث المخزون
    await applyStockChange(tx, batchQueries, {
      productId: product_id,
      supplierId: targetSupplierId,
      delta: quantity,
      referenceType: 'return_sale',
      referenceId: sale_id,
      note: `إرجاع من فاتورة #${sale.invoice_number}`,
      userId
    });
    
    // ===== إصلاح #1: توزيع المبلغ المعاد وفق طريقة الدفع الأصلية للفاتورة بدل النسبة من المدفوع =====
    const totalPaid = (sale.cash_paid || 0) + (sale.wallet_paid || 0);
    let refundCash = 0, refundWallet = 0, refundCredit = 0;
    if (sale.payment_method === 'credit') {
      // فاتورة آجلة بالكامل: استرداد كامل إلى دين العميل، لا نقدي ولا محفظة
      refundCredit = refundAmount;
    } else if (sale.payment_method === 'cash') {
      refundCash = refundAmount;
    } else if (sale.payment_method === 'wallet') {
      refundWallet = refundAmount;
    } else if (totalPaid > 0) {
      // مختلط: بنفس نسبة ما دفعه العميل فعليًا
      refundCash = ((sale.cash_paid || 0) / totalPaid) * refundAmount;
      refundWallet = ((sale.wallet_paid || 0) / totalPaid) * refundAmount;
    } else {
      // فاتورة مختلطة دون أي دفع مسجل: ارجع كاملًا إلى دين العميل
      refundCredit = refundAmount;
    }
    const totalRefundDistributed = refundCash + refundWallet + refundCredit;
    
    const newTotal = sale.total_amount - refundAmount;
    const newTotalCost = sale.total_cost - costAmount;
    const newCashPaid = Math.max(0, (parseFloat(sale.cash_paid) || 0) - refundCash);
    const newWalletPaid = Math.max(0, (parseFloat(sale.wallet_paid) || 0) - refundWallet);
    const newPaidAmount = newCashPaid + newWalletPaid;
    const newProfit = newTotal - newTotalCost;
    batchQueries.push({
      sql: "UPDATE sales SET total_amount = ?, total_cost = ?, profit = ?, cash_paid = ?, wallet_paid = ?, paid_amount = ? WHERE id = ?",
      args: [newTotal, newTotalCost, newProfit, newCashPaid, newWalletPaid, newPaidAmount, sale_id]
    });
    batchQueries.push({
      sql: "UPDATE sales SET status = CASE WHEN ? <= 0.01 THEN 'fully_returned' ELSE 'partially_returned' END WHERE id = ?",
      args: [newTotal, sale_id]
    });
    
    const entryDate = new Date().toISOString().split('T')[0];
    const desc = `إرجاع من فاتورة #${sale.invoice_number}`;
    const journalDetails = [];
    journalDetails.push({ account_id: saleAccountId, debit: totalRefundDistributed, credit: 0 });
    
    // ===== إصلاح #1: تنفيذ الاسترداد النقدي =====
    if (refundCash > 0.01) {
      const cashCurrencyId = cashInfo ? cashInfo.currency_id : baseCurrency.id;
      const cashRate = cashInfo ? cashInfo.exchange_rate : baseCurrency.rate_to_base;
      const baseAmount = convertToBase(refundCash, cashRate);
      journalDetails.push({ account_id: cashAccountId, debit: 0, credit: baseAmount });
      batchQueries.push({
        sql: "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES ('withdraw', ?, ?, ?, ?)",
        args: [refundCash, cashCurrencyId, cashRate, `إرجاع من فاتورة #${sale.invoice_number}`]
      });
    }
    
    // ===== إصلاح #1: تنفيذ الاسترداد عبر المحفظة =====
    if (refundWallet > 0.01) {
      const refundWalletId = sale.wallet_id;
      if (!refundWalletId) throw new Error('محفظة الفاتورة غير مسجلة ولا يمكن استرداد المبلغ للمحفظة');
      const walletCurrencyId = walletInfo ? walletInfo.currency_id : baseCurrency.id;
      await ensureWalletBalance(tx, refundWalletId, walletCurrencyId);
      await updateWalletBalance(tx, refundWalletId, walletCurrencyId, refundWallet, 'add');
      const baseAmount = convertToBase(refundWallet, walletRate);
      journalDetails.push({ account_id: walletAccountId, debit: 0, credit: baseAmount });
      batchQueries.push({
        sql: "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'deposit', ?, ?, ?, ?)",
        args: [refundWalletId, refundWallet, walletCurrencyId, `إرجاع من فاتورة #${sale.invoice_number}`, sale_id]
      });
    }
    
    // ===== إصلاح #1: تنفيذ الاسترداد لآجل (إرجاع مبلغ لعميل كان يدين به) =====
    if (refundCredit > 0.01) {
      if (!sale.customer_id) throw new Error('لا يوجد عميل مسجل للفاتورة الآجلة');
      journalDetails.push({ account_id: customerAccountId, debit: 0, credit: refundCredit });
      batchQueries.push({
        sql: "UPDATE customers SET balance = balance - ? WHERE id = ?",
        args: [refundCredit, sale.customer_id]
      });
    }
    
    if (costAmount > 0) {
      journalDetails.push({ account_id: inventoryAccountId, debit: costAmount, credit: 0 });
      journalDetails.push({ account_id: cogsAccountId, debit: 0, credit: costAmount });
    }
    
    if (journalDetails.length > 0) {
      checkBalance(journalDetails);
      await createJournalEntry(tx, entryDate, desc, journalDetails, 'return_sale', sale_id);
    }
    
    await tx.batch(batchQueries, 'write');
    await tx.commit();
    return jsonResponse({ success: true, refund_amount: refundAmount, message: 'تم الإرجاع بنجاح' }, 200, headers);
  } catch (error) {
    await tx.rollback();
    return jsonResponse({ error: error.message }, 400, headers);
  }
}

async function cancelPurchaseInvoice(request, env, headers, userId) {
  const { purchase_invoice_id } = await request.json();
  if (!purchase_invoice_id) return jsonResponse({ error: 'معرف الفاتورة مطلوب' }, 400, headers);

  const client = getTursoClient(env);
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) return jsonResponse({ error: 'لا توجد عملة أساسية' }, 400, headers);

  const invoice = await dbFirst(
    client,
    "SELECT * FROM purchase_invoices WHERE id = ? AND status = 'completed'",
    [purchase_invoice_id]
  );
  if (!invoice) return jsonResponse({ error: 'الفاتورة غير موجودة' }, 404, headers);

  const items = await dbAll(
    client,
    "SELECT * FROM purchase_invoice_items WHERE invoice_id = ?",
    [purchase_invoice_id]
  );
  if (items.length === 0) return jsonResponse({ error: 'لا توجد بنود في الفاتورة' }, 400, headers);

  const productIds = items.map(item => item.product_id);
  let productsMap = {};
  if (productIds.length) {
    const placeholders = productIds.map(() => '?').join(',');
    const products = await dbAll(
      client,
      `SELECT id, stock_quantity, cost FROM products WHERE id IN (${placeholders})`,
      productIds
    );
    productsMap = products.reduce((acc, p) => {
      acc[p.id] = {
        stock_quantity: parseFloat(p.stock_quantity) || 0,
        cost: parseFloat(p.cost) || 0
      };
      return acc;
    }, {});
  }

  let supplierStocksMap = {};
  if (productIds.length) {
    const placeholders = productIds.map(() => '?').join(',');
    const stocks = await dbAll(
      client,
      `SELECT product_id, id, quantity FROM product_supplier_stock
       WHERE product_id IN (${placeholders}) AND supplier_id = ?`,
      [...productIds, invoice.supplier_id]
    );
    supplierStocksMap = stocks.reduce((acc, s) => {
      if (!acc[s.product_id]) acc[s.product_id] = [];
      acc[s.product_id].push(s);
      return acc;
    }, {});
  }

  const tx = await client.transaction();
  try {
    const batchQueries = [];

    for (const item of items) {
      const product = productsMap[item.product_id];
      if (!product) throw new Error(`المنتج ${item.product_id} غير موجود`);

      const newStock = product.stock_quantity - item.quantity;
      if (newStock < 0) throw new Error(`الكمية غير كافية لعكس المشتريات للمنتج ${item.product_id}`);

      const newCost = newStock > 0 ? (product.stock_quantity * product.cost - item.quantity * item.unit_price) / newStock : 0;

      batchQueries.push({
        sql: "UPDATE products SET stock_quantity = ?, cost = ? WHERE id = ?",
        args: [newStock, newCost, item.product_id]
      });

      // إضافة سجل حركة المخزون (ليس عبر applyStockChange لأننا نحتاج cost)
      batchQueries.push({
        sql: `INSERT INTO stock_movements
              (product_id, supplier_id, quantity_change, old_quantity, new_quantity, reference_type, reference_id, note, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [item.product_id, invoice.supplier_id, -item.quantity, product.stock_quantity, newStock, 'cancel_purchase', purchase_invoice_id, `إلغاء فاتورة مشتريات #${invoice.invoice_number}`, userId]
      });

      const supplierStockList = supplierStocksMap[item.product_id] || [];
      const targetStock = supplierStockList.length > 0 ? supplierStockList[0] : null;
      if (targetStock) {
        const newQty = targetStock.quantity - item.quantity;
        if (newQty < 0) {
          throw new Error(`لا يمكن عكس فاتورة الشراء: مخزون المورد أقل من الكمية المطلوبة للمنتج ${item.product_id}`);
        } else {
          batchQueries.push({
            sql: "UPDATE product_supplier_stock SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            args: [newQty, targetStock.id]
          });
        }
      }
    }

    batchQueries.push({
      sql: "UPDATE purchase_invoices SET status = 'cancelled' WHERE id = ?",
      args: [purchase_invoice_id]
    });

    await tx.batch(batchQueries, 'write');

    const inventoryAccountId = await getAccountId(tx, 'المخزون');
    const cashAccountId = await getAccountId(tx, 'الصندوق');
    const walletAccountId = await getAccountId(tx, 'المحافظ');
    const supplierAccountId = await getAccountId(tx, 'الذمم الدائنة (موردين)');
    const entryDate = new Date().toISOString().split('T')[0];
    const desc = `إلغاء فاتورة مشتريات #${invoice.invoice_number}`;
    const journalDetails = [];

    const paymentMethod = invoice.payment_method;
    let cashPaid = parseFloat(invoice.cash_paid) || 0;
    let walletPaid = parseFloat(invoice.wallet_paid) || 0;
    let cashCurrencyId = invoice.cash_currency_id || baseCurrency.id;
    let walletCurrencyId = invoice.wallet_currency_id || baseCurrency.id;

    if (paymentMethod === 'cash' && cashPaid === 0) {
      cashPaid = invoice.total_amount;
      cashCurrencyId = invoice.currency_id || baseCurrency.id;
    }
    if (paymentMethod === 'wallet' && walletPaid === 0 && invoice.wallet_id) {
      walletPaid = invoice.total_amount;
      walletCurrencyId = invoice.currency_id || baseCurrency.id;
    }
    if (paymentMethod === 'mixed') {
      if (cashPaid === 0 && walletPaid === 0) {
        cashPaid = invoice.total_amount / 2;
        walletPaid = invoice.total_amount / 2;
        cashCurrencyId = invoice.currency_id || baseCurrency.id;
        walletCurrencyId = invoice.currency_id || baseCurrency.id;
      }
    }

    if (paymentMethod === 'cash' || paymentMethod === 'mixed') {
      if (cashPaid > 0) {
        const cashRate = await getCurrencyRate(tx, cashCurrencyId) || 1;
        const baseCashAmount = cashPaid * cashRate;
        await dbRun(
          tx,
          `INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note)
           VALUES ('deposit', ?, ?, ?, ?)`,
          [cashPaid, cashCurrencyId, cashRate, `إلغاء فاتورة مشتريات #${invoice.invoice_number} (نقدي)`]
        );
        journalDetails.push({ account_id: cashAccountId, debit: baseCashAmount, credit: 0 });
        journalDetails.push({ account_id: inventoryAccountId, debit: 0, credit: baseCashAmount });
      }
    }

    if (paymentMethod === 'wallet' || paymentMethod === 'mixed') {
      if (walletPaid > 0 && invoice.wallet_id) {
        const walletRate = await getCurrencyRate(tx, walletCurrencyId) || 1;
        const baseWalletAmount = walletPaid * walletRate;
        await updateWalletBalance(tx, invoice.wallet_id, walletCurrencyId, walletPaid, 'add');
        await dbRun(
          tx,
          `INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id)
           VALUES (?, 'deposit', ?, ?, ?, ?)`,
          [invoice.wallet_id, walletPaid, walletCurrencyId, `إلغاء فاتورة مشتريات #${invoice.invoice_number}`, purchase_invoice_id]
        );
        journalDetails.push({ account_id: walletAccountId, debit: baseWalletAmount, credit: 0 });
        journalDetails.push({ account_id: inventoryAccountId, debit: 0, credit: baseWalletAmount });
      }
    }

    if (paymentMethod === 'credit') {
      const totalAmount = invoice.total_amount;
      await dbRun(
        tx,
        "UPDATE suppliers SET balance = balance - ? WHERE id = ?",
        [totalAmount, invoice.supplier_id]
      );
      journalDetails.push({ account_id: supplierAccountId, debit: totalAmount, credit: 0 });
      journalDetails.push({ account_id: inventoryAccountId, debit: 0, credit: totalAmount });
    }

    if (journalDetails.length > 0) {
      checkBalance(journalDetails);
      await createJournalEntry(tx, entryDate, desc, journalDetails, 'cancel_purchase', purchase_invoice_id);
    }

    await tx.commit();
    return jsonResponse({ success: true, message: 'تم إلغاء فاتورة الشراء بنجاح' }, 200, headers);

  } catch (error) {
    await tx.rollback();
    return jsonResponse({ error: error.message }, 400, headers);
  }
}

async function returnPurchaseItem(request, env, headers, userId) {
  const { purchase_invoice_id, product_id, quantity, reason } = await request.json();
  if (!purchase_invoice_id || !product_id || !quantity || quantity <= 0) {
    return jsonResponse({ error: 'بيانات غير صالحة' }, 400, headers);
  }
  const client = getTursoClient(env);
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) return jsonResponse({ error: 'لا توجد عملة أساسية' }, 400, headers);
  const invoice = await dbFirst(client, "SELECT * FROM purchase_invoices WHERE id = ? AND status = 'completed'", [purchase_invoice_id]);
  if (!invoice) return jsonResponse({ error: 'الفاتورة غير موجودة' }, 404, headers);
  const purchaseItem = await dbFirst(client, "SELECT * FROM purchase_invoice_items WHERE invoice_id = ? AND product_id = ?", [purchase_invoice_id, product_id]);
  if (!purchaseItem) return jsonResponse({ error: 'المنتج غير موجود في الفاتورة' }, 404, headers);
  if (purchaseItem.quantity < quantity) {
    return jsonResponse({ error: 'الكمية المطلوبة للإرجاع أكبر من المشتراة' }, 400, headers);
  }
  const refundAmount = purchaseItem.unit_price * quantity;
  const exchangeRate = invoice.exchange_rate || 1;
  const baseRefundAmount = refundAmount * exchangeRate;
  const tx = await client.transaction();
  try {
    await dbRun(tx,
      "INSERT INTO returned_purchases (purchase_invoice_id, product_id, quantity, amount, reason) VALUES (?, ?, ?, ?, ?)",
      [purchase_invoice_id, product_id, quantity, refundAmount, reason || '']
    );
    const product = await dbFirst(tx, "SELECT stock_quantity, cost FROM products WHERE id = ?", [product_id]);
    if (!product) throw new Error(`المنتج ${product_id} غير موجود`);
    const newStock = product.stock_quantity - quantity;
    if (newStock < 0) throw new Error(`الكمية غير كافية للإرجاع`);
    const newCost = newStock > 0 ? (product.stock_quantity * product.cost - quantity * purchaseItem.unit_price) / newStock : 0;
    await dbRun(tx, "UPDATE products SET stock_quantity = ?, cost = ? WHERE id = ?", [newStock, newCost, product_id]);
    // إضافة سجل حركة المخزون
    await dbRun(tx,
      `INSERT INTO stock_movements
       (product_id, supplier_id, quantity_change, old_quantity, new_quantity, reference_type, reference_id, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [product_id, invoice.supplier_id, -quantity, product.stock_quantity, newStock, 'return_purchase', purchase_invoice_id, `إرجاع مشتريات من فاتورة #${invoice.invoice_number}`, userId]
    );
    const supplierStock = await dbFirst(tx,
      "SELECT id, quantity FROM product_supplier_stock WHERE product_id = ? AND supplier_id = ?",
      [product_id, invoice.supplier_id]
    );
    if (supplierStock) {
      const newQty = supplierStock.quantity - quantity;
      if (newQty < 0) {
        throw new Error('الكمية المرتجعة تتجاوز مخزون المورد المسجل');
      } else {
        await dbRun(tx,
          "UPDATE product_supplier_stock SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [newQty, supplierStock.id]
        );
      }
    }
    const entryDate = new Date().toISOString().split('T')[0];
    const desc = `إرجاع مشتريات من فاتورة #${invoice.invoice_number}`;
    const inventoryAccountId = await getAccountId(tx, 'المخزون');
    const cashAccountId = await getAccountId(tx, 'الصندوق');
    const walletAccountId = await getAccountId(tx, 'المحافظ');
    const supplierAccountId = await getAccountId(tx, 'الذمم الدائنة (موردين)');
    const journalDetails = [];
    const method = String(invoice.payment_method || '').toLowerCase();
    const cashRate = await getCurrencyRate(tx, invoice.cash_currency_id || invoice.currency_id || baseCurrency.id) || 1;
    const walletRate = await getCurrencyRate(tx, invoice.wallet_currency_id || invoice.currency_id || baseCurrency.id) || 1;
    const originalCashBase = (parseFloat(invoice.cash_paid) || 0) * cashRate;
    const originalWalletBase = (parseFloat(invoice.wallet_paid) || 0) * walletRate;
    const originalPaidBase = originalCashBase + originalWalletBase;
    let cashPartBase = 0, walletPartBase = 0, supplierPartBase = 0;
    if (method === 'cash') cashPartBase = baseRefundAmount;
    else if (method === 'wallet' && invoice.wallet_id) walletPartBase = baseRefundAmount;
    else if (method === 'mixed') {
      if (originalPaidBase <= 0.001) throw new Error('لا يوجد تفصيل موثوق للدفع المختلط');
      cashPartBase = baseRefundAmount * originalCashBase / originalPaidBase;
      walletPartBase = baseRefundAmount * originalWalletBase / originalPaidBase;
    } else supplierPartBase = baseRefundAmount;
    if (cashPartBase > 0.001) {
      const cashAmount = cashPartBase / cashRate;
      journalDetails.push({ account_id: cashAccountId, debit: cashPartBase, credit: 0 });
      await dbRun(tx, "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES ('deposit', ?, ?, ?, ?)", [cashAmount, invoice.cash_currency_id || invoice.currency_id || baseCurrency.id, cashRate, desc]);
    }
    if (walletPartBase > 0.001) {
      if (!invoice.wallet_id) throw new Error('لا توجد محفظة مرتبطة بالدفع الأصلي');
      const walletAmount = walletPartBase / walletRate;
      journalDetails.push({ account_id: walletAccountId, debit: walletPartBase, credit: 0 });
      await updateWalletBalance(tx, invoice.wallet_id, invoice.wallet_currency_id || invoice.currency_id || baseCurrency.id, walletAmount, 'add');
      await dbRun(tx, "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'deposit', ?, ?, ?, ?)", [invoice.wallet_id, walletAmount, invoice.wallet_currency_id || invoice.currency_id || baseCurrency.id, desc, purchase_invoice_id]);
    }
    if (supplierPartBase > 0.001) {
      journalDetails.push({ account_id: supplierAccountId, debit: supplierPartBase, credit: 0 });
      await dbRun(tx, "UPDATE suppliers SET balance = balance - ? WHERE id = ?", [supplierPartBase, invoice.supplier_id]);
    }
    journalDetails.push({ account_id: inventoryAccountId, debit: 0, credit: baseRefundAmount });
    if (journalDetails.length > 0) {
      checkBalance(journalDetails);
      await createJournalEntry(tx, entryDate, desc, journalDetails, 'return_purchase', purchase_invoice_id);
    }
    await tx.commit();
    return jsonResponse({ success: true, refund_amount: refundAmount, message: 'تم إرجاع المنتج بنجاح' }, 200, headers);
  } catch (error) {
    await tx.rollback();
    return jsonResponse({ error: error.message }, 400, headers);
  }
}

async function cancelOnlineOrder(request, env, headers, userId) {
  const { order_id } = await request.json();
  if (!order_id) return jsonResponse({ error: 'معرف الطلب مطلوب' }, 400, headers);

  const client = getTursoClient(env);
  await checkIfClosed(client, new Date().toISOString().slice(0, 10));
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) return jsonResponse({ error: 'لا توجد عملة أساسية' }, 400, headers);

  const order = await dbFirst(client, "SELECT * FROM online_orders WHERE id = ?", [order_id]);
  if (!order) return jsonResponse({ error: 'الطلب غير موجود' }, 404, headers);
  if (order.status === 'تم التسليم' || order.status === 'مرتجع كلي') {
    return jsonResponse({ error: 'لا يمكن إلغاء طلب تم تسليمه أو مرتجع كلياً' }, 400, headers);
  }
  if (order.status === 'ملغي') {
    return jsonResponse({ error: 'الطلب ملغي مسبقاً' }, 409, headers);
  }

  const items = await dbAll(client, "SELECT * FROM online_order_items WHERE order_id = ?", [order_id]);
  const productIds = items.map(item => item.product_id).filter(id => id);

  let bestSupplierMap = {};
  if (productIds.length > 0) {
    const bestSuppliers = await dbAll(client, `
      SELECT product_id, supplier_id
      FROM product_supplier_stock
      WHERE product_id IN (${productIds.join(',')}) AND quantity > 0
      ORDER BY product_id, quantity DESC
    `);
    for (const row of bestSuppliers) {
      if (!bestSupplierMap[row.product_id]) {
        bestSupplierMap[row.product_id] = row.supplier_id;
      }
    }
  }

  let existingStocks = [];
  if (productIds.length > 0) {
    existingStocks = await dbAll(client, `
      SELECT product_id, id, supplier_id
      FROM product_supplier_stock
      WHERE product_id IN (${productIds.join(',')})
    `);
  }
  const stockMap = {};
  for (const stock of existingStocks) {
    if (!stockMap[stock.product_id]) stockMap[stock.product_id] = [];
    stockMap[stock.product_id].push(stock);
  }

  let sale = null;
  if (order.accounting_invoice_id) {
    sale = await dbFirst(client, "SELECT * FROM sales WHERE id = ?", [order.accounting_invoice_id]);
  }

  const tx = await client.transaction();
  try {
    // ===== جلب كميات المخزون دفعة واحدة =====
    const stockCache = {};
    if (productIds.length) {
      const stockRows = await dbAll(tx,
        `SELECT id, stock_quantity FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`,
        productIds
      );
      stockRows.forEach(row => {
        stockCache[row.id] = parseFloat(row.stock_quantity) || 0;
      });
    }

    const batchQueries = [];

    for (const item of items) {
      if (item.product_id && item.quantity > 0) {
        await applyStockChange(tx, batchQueries, {
          productId: item.product_id,
          supplierId: bestSupplierMap[item.product_id] || null,
          delta: item.quantity,
          referenceType: 'cancel_online_order',
          referenceId: order_id,
          note: `إلغاء طلب #${order_id}`,
          userId,
          stockCache
        });
      }
    }

    const isPrepaid = isPrepaidOrder(order);
    const isMixed = isMixedOrder(order);
    const shouldCancelSale = Boolean(order.accounting_invoice_id && sale && sale.status !== 'cancelled');

    // استرداد الجزء المدفوع من المحفظة في الدفع المسبق أو المختلط.
    // نستخدم wallet_paid (عملة المحفظة) وليس paid_amount (قد يكون بعملة الفاتورة/الأساس).
    if (shouldCancelSale && (isPrepaid || isMixed)) {
      const walletPaidAmount = parseFloat(sale.wallet_paid) || 0;
      if (sale.wallet_id && walletPaidAmount > 0.01) {
        const walletTx = await dbFirst(tx,
          "SELECT currency_id FROM wallet_transactions WHERE reference_id = ? AND type = 'deposit' LIMIT 1",
          [sale.id]
        );
        const currId = walletTx ? walletTx.currency_id : baseCurrency.id;
        await updateWalletBalance(tx, sale.wallet_id, currId, walletPaidAmount, 'subtract');
        batchQueries.push({
          sql: "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'withdraw', ?, ?, ?, ?)",
          args: [sale.wallet_id, walletPaidAmount, currId, `استرداد محفظة إلغاء الطلب #${order_id}`, order_id]
        });
      }
    }

    // الطلب الملغى يجب ألا يترك فاتورته بحالة pending أو completed.
    if (shouldCancelSale) {
      batchQueries.push({
        sql: "UPDATE sales SET status = 'cancelled' WHERE id = ?",
        args: [sale.id]
      });
    }

    batchQueries.push({
      sql: "UPDATE online_orders SET status = 'ملغي' WHERE id = ?",
      args: [order_id]
    });
    batchQueries.push({
      sql: "INSERT INTO order_status_log (order_id, old_status, new_status, status, notes) VALUES (?, ?, ?, ?, ?)",
      args: [order_id, order.status, 'ملغي', 'ملغي', 'تم إلغاء الطلب']
    });

    if (shouldCancelSale) {
      const entryDate = new Date().toISOString().split('T')[0];
      const desc = `إلغاء طلب إنترنت #${order_id}`;

      // دعم القيود الجديدة والقديمة معًا، مع الاعتماد على sale.id للمرجع الموحد.
      const originalEntries = await dbAll(tx, `
        SELECT jed.account_id, jed.debit, jed.credit
        FROM journal_entry_details jed
        JOIN journal_entries je ON je.id = jed.entry_id
        WHERE (je.reference_type = 'sale' AND je.reference_id = ?)
           OR (je.reference_type = 'online_order' AND je.reference_id = ?)
      `, [sale.id, order_id]);
      if (originalEntries.length > 0) {
        const reversal = originalEntries.map(d => ({
          account_id: d.account_id,
          debit: d.credit || 0,
          credit: d.debit || 0,
          notes: `عكس القيد الأصلي للطلب #${order_id}`
        }));
        checkBalance(reversal);
        await createJournalEntry(tx, entryDate, desc, reversal, 'cancel_online_order', order_id);
      }

      // sale_cogs يستخدم sale.id، بينما delivery_cogs التاريخي يستخدم order_id.
      const originalCogs = await dbAll(tx, `
        SELECT jed.account_id, jed.debit, jed.credit
        FROM journal_entry_details jed
        JOIN journal_entries je ON je.id = jed.entry_id
        WHERE (je.reference_type = 'sale_cogs' AND je.reference_id = ?)
           OR (je.reference_type = 'delivery_cogs' AND je.reference_id = ?)
      `, [sale.id, order_id]);
      if (originalCogs.length > 0) {
        const reversalCogs = originalCogs.map(d => ({
          account_id: d.account_id,
          debit: d.credit || 0,
          credit: d.debit || 0,
          notes: `عكس تكلفة الطلب #${order_id}`
        }));
        checkBalance(reversalCogs);
        await createJournalEntry(tx, entryDate, `عكس تكلفة طلب #${order_id}`, reversalCogs, 'cancel_online_order_cogs', order_id);
      }
    }

    // ===== تنفيذ الدفعات على أجزاء =====
    const BATCH_SIZE = 40;
    for (let i = 0; i < batchQueries.length; i += BATCH_SIZE) {
      const chunk = batchQueries.slice(i, i + BATCH_SIZE);
      await tx.batch(chunk, 'write');
    }

    await tx.commit();
    return jsonResponse({ success: true, message: 'تم إلغاء الطلب بنجاح' }, 200, headers);

  } catch (error) {
    await tx.rollback();
    return jsonResponse({ error: error.message }, 400, headers);
  }
}

async function fullReturnSaleInvoice(request, env, headers, userId) {
  const { sale_id, reason } = await request.json();
  if (!sale_id) return jsonResponse({ error: 'معرف الفاتورة مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) return jsonResponse({ error: 'لا توجد عملة أساسية' }, 400, headers);

  const sale = await dbFirst(client, "SELECT * FROM sales WHERE id = ? AND status IN ('completed', 'partially_returned')", [sale_id]);
  if (!sale) return jsonResponse({ error: 'الفاتورة غير موجودة أو ملغاة' }, 404, headers);

  const saleItems = await dbAll(client, "SELECT * FROM sale_items WHERE sale_id = ?", [sale_id]);
  if (saleItems.length === 0) return jsonResponse({ error: 'الفاتورة لا تحتوي على عناصر' }, 400, headers);

  const returnedData = await dbAll(client, `
    SELECT product_id, SUM(quantity) as returned_qty
    FROM returned_sales
    WHERE sale_id = ?
    GROUP BY product_id
  `, [sale_id]);
  const returnedMap = {};
  for (const r of returnedData) {
    returnedMap[r.product_id] = r.returned_qty;
  }

  const productIds = saleItems.map(item => Number(item.product_id)).filter(Number.isInteger);

  let allStocks = [];
  if (productIds.length > 0) {
    allStocks = await dbAll(client, `
      SELECT product_id, id, supplier_id, quantity
      FROM product_supplier_stock
      WHERE product_id IN (${productIds.join(',')})
    `);
  }
  const stockMap = {};
  for (const stock of allStocks) {
    if (!stockMap[stock.product_id]) stockMap[stock.product_id] = [];
    stockMap[stock.product_id].push(stock);
  }

  let bestSupplierMap = {};
  if (productIds.length > 0) {
    const bestSuppliers = await dbAll(client, `
      SELECT product_id, supplier_id
      FROM product_supplier_stock
      WHERE product_id IN (${productIds.join(',')}) AND quantity > 0
      ORDER BY product_id, quantity DESC
    `);
    for (const row of bestSuppliers) {
      if (!bestSupplierMap[row.product_id]) {
        bestSupplierMap[row.product_id] = row.supplier_id;
      }
    }
  }

  const accounts = await dbAll(client, "SELECT id, name FROM accounts");
  const accountsMap = Object.fromEntries(accounts.map(a => [a.name, a.id]));
  const getAccountIdFast = (name) => {
    if (!accountsMap[name]) throw new Error(`الحساب "${name}" غير موجود`);
    return accountsMap[name];
  };
  const saleAccountId = getAccountIdFast('المبيعات');
  const cogsAccountId = getAccountIdFast('تكلفة البضاعة المباعة');
  const inventoryAccountId = getAccountIdFast('المخزون');
  const cashAccountId = getAccountIdFast('الصندوق');
  const walletAccountId = getAccountIdFast('المحافظ');
  const customerAccountId = getAccountIdFast('الذمم المدينة (عملاء)');

  const cashInfo = await dbFirst(client,
    "SELECT currency_id, exchange_rate FROM cash_register WHERE note LIKE ? ORDER BY created_at DESC LIMIT 1",
    [`%${sale.invoice_number}%`]
  );
  const walletInfo = await dbFirst(client,
    "SELECT currency_id FROM wallet_transactions WHERE reference_id = ? AND type = 'deposit' LIMIT 1",
    [sale_id]
  );
  let walletRate = baseCurrency.rate_to_base;
  if (walletInfo) {
    const rateRow = await dbFirst(client, "SELECT rate_to_base FROM currencies WHERE id = ?", [walletInfo.currency_id]);
    if (rateRow) walletRate = rateRow.rate_to_base;
  }

  const tx = await client.transaction();
  try {
    // ===== جلب كميات المخزون دفعة واحدة =====
    const stockCache = {};
    if (productIds.length) {
      const stockRows = await dbAll(tx,
        `SELECT id, stock_quantity FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`,
        productIds
      );
      stockRows.forEach(row => {
        stockCache[row.id] = parseFloat(row.stock_quantity) || 0;
      });
    }

    const batchQueries = [];
    let totalRefund = 0;
    let totalCost = 0;

    for (const item of saleItems) {
      const returnedQty = returnedMap[item.product_id] || 0;
      const remainingQty = item.quantity - returnedQty;
      if (remainingQty <= 0) continue;

      const refundAmount = item.unit_price * remainingQty;
      const costAmount = item.cost_price * remainingQty;
      totalRefund += refundAmount;
      totalCost += costAmount;

      batchQueries.push({
        sql: "INSERT INTO returned_sales (sale_id, product_id, quantity, amount, reason) VALUES (?, ?, ?, ?, ?)",
        args: [sale_id, item.product_id, remainingQty, refundAmount, reason || 'مرتجع كلي']
      });

      await applyStockChange(tx, batchQueries, {
        productId: item.product_id,
        supplierId: item.supplier_id || bestSupplierMap[item.product_id] || null,
        delta: remainingQty,
        referenceType: 'full_return_sale',
        referenceId: sale_id,
        note: `مرتجع كلي من فاتورة #${sale.invoice_number}`,
        userId,
        stockCache
      });
    }

    const totalPaid = (sale.cash_paid || 0) + (sale.wallet_paid || 0);
    let refundCash = 0, refundWallet = 0;
    if (totalPaid > 0) {
      refundCash = ((sale.cash_paid || 0) / totalPaid) * totalRefund;
      refundWallet = ((sale.wallet_paid || 0) / totalPaid) * totalRefund;
    } else {
      refundCash = totalRefund;
    }
    const newTotal = sale.total_amount - totalRefund;
    const newTotalCost = sale.total_cost - totalCost;
    const newCashPaid = Math.max(0, (sale.cash_paid || 0) - refundCash);
    const newWalletPaid = Math.max(0, (sale.wallet_paid || 0) - refundWallet);
    const newPaidAmount = newCashPaid + newWalletPaid;
    const newProfit = newTotal - newTotalCost;
    batchQueries.push({
      sql: "UPDATE sales SET total_amount = ?, total_cost = ?, profit = ?, cash_paid = ?, wallet_paid = ?, paid_amount = ? WHERE id = ?",
      args: [newTotal, newTotalCost, newProfit, newCashPaid, newWalletPaid, newPaidAmount, sale_id]
    });
    if (newTotal <= 0.01) {
      batchQueries.push({
        sql: "UPDATE sales SET status = 'fully_returned' WHERE id = ?",
        args: [sale_id]
      });
    }

    const entryDate = new Date().toISOString().split('T')[0];
    const desc = `مرتجع كلي من فاتورة #${sale.invoice_number}`;
    const journalDetails = [];
    journalDetails.push({ account_id: saleAccountId, debit: totalRefund, credit: 0 });

    if (refundCash > 0.01) {
      const cashCurrencyId = cashInfo ? cashInfo.currency_id : baseCurrency.id;
      const cashRate = cashInfo ? cashInfo.exchange_rate : (baseCurrency.rate_to_base || 1);
      const baseAmount = convertToBase(refundCash, cashRate);
      journalDetails.push({ account_id: cashAccountId, debit: 0, credit: baseAmount });
      batchQueries.push({
        sql: "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES ('withdraw', ?, ?, ?, ?)",
        args: [refundCash, cashCurrencyId, cashRate, desc]
      });
    }
    if (refundWallet > 0.01) {
      if (!sale.wallet_id) throw new Error('لا توجد محفظة مرتبطة بالفاتورة لاسترداد المبلغ');
      const walletCurrencyId = walletInfo ? walletInfo.currency_id : baseCurrency.id;
      const baseAmount = convertToBase(refundWallet, walletRate);
      const walletBalance = await dbFirst(tx, "SELECT balance FROM wallet_balances WHERE wallet_id = ? AND currency_id = ?", [sale.wallet_id, walletCurrencyId]);
      if (!walletBalance || parseFloat(walletBalance.balance) < refundWallet) throw new Error('رصيد المحفظة غير كافٍ لتنفيذ الإرجاع');
      journalDetails.push({ account_id: walletAccountId, debit: 0, credit: baseAmount });
      batchQueries.push({
        sql: "UPDATE wallet_balances SET balance = balance - ? WHERE wallet_id = ? AND currency_id = ?",
        args: [refundWallet, sale.wallet_id, walletCurrencyId]
      });
      batchQueries.push({
        sql: "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'withdraw', ?, ?, ?, ?)",
        args: [sale.wallet_id, refundWallet, walletCurrencyId, desc, sale_id]
      });
    }
    if (sale.payment_method === 'credit' && sale.customer_id && refundCash <= 0.01 && refundWallet <= 0.01) {
      journalDetails.push({ account_id: customerAccountId, debit: 0, credit: totalRefund });
      batchQueries.push({
        sql: "UPDATE customers SET balance = balance - ? WHERE id = ?",
        args: [totalRefund, sale.customer_id]
      });
    }

    if (totalCost > 0) {
      journalDetails.push({ account_id: inventoryAccountId, debit: totalCost, credit: 0 });
      journalDetails.push({ account_id: cogsAccountId, debit: 0, credit: totalCost });
    }

    if (journalDetails.length > 0) {
      checkBalance(journalDetails);
      await createJournalEntry(tx, entryDate, desc, journalDetails, 'full_return_sale', sale_id);
    }

    // ===== تنفيذ الدفعات على أجزاء =====
    const BATCH_SIZE = 40;
    for (let i = 0; i < batchQueries.length; i += BATCH_SIZE) {
      const chunk = batchQueries.slice(i, i + BATCH_SIZE);
      await tx.batch(chunk, 'write');
    }

    await tx.commit();
    return jsonResponse({ success: true, total_refund: totalRefund, message: 'تم إرجاع الفاتورة بالكامل' }, 200, headers);
  } catch (error) {
    await tx.rollback();
    return jsonResponse({ error: error.message }, 400, headers);
  }
}

async function undoCancelSaleInvoice(request, env, headers, userId) {
  const { sale_id } = await request.json();
  if (!sale_id) return jsonResponse({ error: 'معرف الفاتورة مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) return jsonResponse({ error: 'لا توجد عملة أساسية' }, 400, headers);
  const sale = await dbFirst(client, "SELECT * FROM sales WHERE id = ? AND status = 'cancelled'", [sale_id]);
  if (!sale) return jsonResponse({ error: 'الفاتورة غير موجودة أو ليست ملغاة' }, 404, headers);
  const returns = await dbFirst(client, "SELECT COUNT(*) as cnt FROM returned_sales WHERE sale_id = ?", [sale_id]);
  if (returns.cnt > 0) {
    return jsonResponse({ error: 'لا يمكن استرجاع فاتورة تم إرجاع بعض منتجاتها' }, 400, headers);
  }
  const tx = await client.transaction();
  try {
    const saleItems = await dbAll(tx, "SELECT * FROM sale_items WHERE sale_id = ?", [sale_id]);

    // ===== جلب كميات المخزون دفعة واحدة =====
    const productIds = saleItems.map(item => item.product_id);
    const stockCache = {};
    if (productIds.length) {
      const stockRows = await dbAll(tx,
        `SELECT id, stock_quantity FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`,
        productIds
      );
      stockRows.forEach(row => {
        stockCache[row.id] = parseFloat(row.stock_quantity) || 0;
      });
    }

    let totalCost = 0;
    const batchQueries = [];
    for (const item of saleItems) {
      await applyStockChange(tx, batchQueries, {
        productId: item.product_id,
        supplierId: item.supplier_id || null,
        delta: -item.quantity,
        referenceType: 'undo_cancel_sale',
        referenceId: sale_id,
        note: `عكس إلغاء فاتورة #${sale.invoice_number}`,
        userId,
        stockCache
      });
      totalCost += item.quantity * item.cost_price;
    }
    batchQueries.push({
      sql: "UPDATE sales SET status = 'completed' WHERE id = ?",
      args: [sale_id]
    });
    batchQueries.push({
      sql: "UPDATE sales SET profit = ? WHERE id = ?",
      args: [sale.total_amount - totalCost, sale_id]
    });

    // إعادة الأرصدة التشغيلية التي خُفّضت عند الإلغاء، مع الاحتفاظ بقيود العكس في دفتر الأستاذ.
    const undoCashInfo = await dbFirst(tx, "SELECT currency_id, exchange_rate, amount FROM cash_register WHERE type = 'withdraw' AND note LIKE ? ORDER BY created_at DESC LIMIT 1", [`%${sale.invoice_number}%`]);
    const undoCash = parseFloat(sale.cash_paid) || 0;
    if (undoCash > 0.01) {
      const undoCurrency = undoCashInfo?.currency_id || baseCurrency.id;
      const undoRate = undoCashInfo?.exchange_rate || (baseCurrency.rate_to_base || 1);
      batchQueries.push({ sql: "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES ('deposit', ?, ?, ?, ?)", args: [undoCash, undoCurrency, undoRate, `استرجاع إلغاء فاتورة #${sale.invoice_number}`] });
    }
    const undoWallet = parseFloat(sale.wallet_paid) || 0;
    if (undoWallet > 0.01 && sale.wallet_id) {
      const undoWalletInfo = await dbFirst(tx, "SELECT currency_id FROM wallet_transactions WHERE wallet_id = ? AND reference_id = ? AND type = 'withdraw' LIMIT 1", [sale.wallet_id, sale_id]);
      const undoCurrency = undoWalletInfo?.currency_id || baseCurrency.id;
      batchQueries.push({ sql: "INSERT OR IGNORE INTO wallet_balances (wallet_id, currency_id, balance) VALUES (?, ?, 0)", args: [sale.wallet_id, undoCurrency] });
      batchQueries.push({ sql: "UPDATE wallet_balances SET balance = balance + ? WHERE wallet_id = ? AND currency_id = ?", args: [undoWallet, sale.wallet_id, undoCurrency] });
      batchQueries.push({ sql: "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'deposit', ?, ?, ?, ?)", args: [sale.wallet_id, undoWallet, undoCurrency, `استرجاع إلغاء فاتورة #${sale.invoice_number}`, sale_id] });
    }
    if (sale.payment_method === 'credit' && sale.customer_id) {
      batchQueries.push({ sql: "UPDATE customers SET balance = balance + ? WHERE id = ?", args: [sale.total_amount, sale.customer_id] });
    }

    const cancelEntry = await dbFirst(tx,
      "SELECT id FROM journal_entries WHERE reference_type = 'cancel_sale' AND reference_id = ? ORDER BY id LIMIT 1",
      [sale_id]
    );
    if (cancelEntry) {
      const details = await dbAll(tx,
        "SELECT account_id, debit, credit FROM journal_entry_details WHERE entry_id = ?",
        [cancelEntry.id]
      );
      const reversedDetails = details.map(d => ({
        account_id: d.account_id,
        debit: d.credit,
        credit: d.debit,
        notes: `عكس إلغاء فاتورة #${sale.invoice_number}`
      }));
      const entryDate = new Date().toISOString().split('T')[0];
      await createJournalEntry(tx, entryDate, `استرجاع فاتورة #${sale.invoice_number}`, reversedDetails, 'undo_cancel_sale', sale_id);
    }
    const cogsEntry = await dbFirst(tx,
      "SELECT id FROM journal_entries WHERE reference_type = 'cancel_sale_cogs' AND reference_id = ? ORDER BY id LIMIT 1",
      [sale_id]
    );
    if (cogsEntry) {
      const details = await dbAll(tx,
        "SELECT account_id, debit, credit FROM journal_entry_details WHERE entry_id = ?",
        [cogsEntry.id]
      );
      const reversedDetails = details.map(d => ({
        account_id: d.account_id,
        debit: d.credit,
        credit: d.debit,
        notes: `عكس تكلفة إلغاء فاتورة #${sale.invoice_number}`
      }));
      const entryDate = new Date().toISOString().split('T')[0];
      await createJournalEntry(tx, entryDate, `استرجاع تكلفة فاتورة #${sale.invoice_number}`,
        reversedDetails, 'undo_cancel_sale_cogs', sale_id);
    }

    // ===== تنفيذ الدفعات على أجزاء =====
    const BATCH_SIZE = 40;
    for (let i = 0; i < batchQueries.length; i += BATCH_SIZE) {
      const chunk = batchQueries.slice(i, i + BATCH_SIZE);
      await tx.batch(chunk, 'write');
    }

    await tx.commit();
    return jsonResponse({ success: true, message: 'تم استرجاع الفاتورة الملغاة بنجاح' }, 200, headers);
  } catch (error) {
    await tx.rollback();
    return jsonResponse({ error: error.message }, 400, headers);
  }
}

async function undoReturnSaleItem(request, env, headers, userId) {
  const { return_id } = await request.json();
  if (!return_id) return jsonResponse({ error: 'معرف الإرجاع مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) return jsonResponse({ error: 'لا توجد عملة أساسية' }, 400, headers);
  const returnRecord = await dbFirst(client, "SELECT * FROM returned_sales WHERE id = ?", [return_id]);
  if (!returnRecord) return jsonResponse({ error: 'سجل الإرجاع غير موجود' }, 404, headers);
  const sale = await dbFirst(client, "SELECT * FROM sales WHERE id = ?", [returnRecord.sale_id]);
  if (!sale) return jsonResponse({ error: 'الفاتورة غير موجودة' }, 404, headers);
  if (sale.status === 'cancelled' || sale.status === 'fully_returned') {
    return jsonResponse({ error: 'لا يمكن عكس إرجاع على فاتورة ملغاة أو مرتجعة بالكامل' }, 400, headers);
  }
  const tx = await client.transaction();
  try {
    const saleItem = await dbFirst(tx, "SELECT * FROM sale_items WHERE sale_id = ? AND product_id = ?", [sale.id, returnRecord.product_id]);
    const batchQueries = [];
    await applyStockChange(tx, batchQueries, {
      productId: returnRecord.product_id,
      supplierId: saleItem ? saleItem.supplier_id : null,
      delta: -returnRecord.quantity,
      referenceType: 'undo_return_sale',
      referenceId: sale.id,
      note: `عكس إرجاع #${return_id}`,
      userId
    });
    const newTotal = sale.total_amount + returnRecord.amount;
    const newTotalCost = sale.total_cost + (returnRecord.quantity * (saleItem ? saleItem.cost_price : 0));
    const newPaidAmount = parseFloat(sale.cash_paid) + parseFloat(sale.wallet_paid);
    const newProfit = newTotal - newTotalCost;
    batchQueries.push({
      sql: "UPDATE sales SET total_amount = ?, total_cost = ?, profit = ?, paid_amount = ? WHERE id = ?",
      args: [newTotal, newTotalCost, newProfit, newPaidAmount, sale.id]
    });
    batchQueries.push({
      sql: "DELETE FROM returned_sales WHERE id = ?",
      args: [return_id]
    });

    const entryDate = new Date().toISOString().split('T')[0];
    const desc = `عكس إرجاع من فاتورة #${sale.invoice_number}`;
    const saleAccountId = await getAccountId(tx, 'المبيعات');
    const cogsAccountId = await getAccountId(tx, 'تكلفة البضاعة المباعة');
    const inventoryAccountId = await getAccountId(tx, 'المخزون');
    const returnEntry = await dbFirst(tx,
      "SELECT id FROM journal_entries WHERE reference_type = 'return_sale' AND reference_id = ? ORDER BY id DESC LIMIT 1",
      [sale.id]
    );
    let journalDetails = [];
    if (returnEntry) {
      const details = await dbAll(tx,
        "SELECT account_id, debit, credit FROM journal_entry_details WHERE entry_id = ?",
        [returnEntry.id]
      );
      journalDetails = details.map(d => ({
        account_id: d.account_id,
        debit: d.credit,
        credit: d.debit,
        notes: `عكس إرجاع فاتورة #${sale.invoice_number}`
      }));
    } else {
      throw new Error('لا يوجد قيد إرجاع أصلي يمكن عكسه؛ تم إيقاف العملية لحماية دفتر الأستاذ');
    }

    // ===== إصلاح #2: عكس العمليات التشغيلية للإرجاع الأصلي (نفس منطق undoCancelSaleInvoice) =====
    const undoCashInfo = await dbFirst(tx, "SELECT currency_id, exchange_rate, amount FROM cash_register WHERE type = 'withdraw' AND note LIKE ? ORDER BY id DESC LIMIT 1", [`إرجاع من فاتورة #${sale.invoice_number}%`]);
    const undoWalletInfo = await dbFirst(tx, "SELECT currency_id, amount FROM wallet_transactions WHERE wallet_id = ? AND reference_id = ? AND type = 'deposit' ORDER BY id DESC LIMIT 1", [sale.wallet_id, sale.id]);

    const paymentMethod = sale.payment_method || '';
    let undoCashAmount = 0, undoWalletAmount = 0, undoCreditAmount = 0;
    if (paymentMethod === 'credit') {
      undoCreditAmount = returnRecord.amount;
    } else if (paymentMethod === 'cash') {
      undoCashAmount = returnRecord.amount;
    } else if (paymentMethod === 'wallet') {
      undoWalletAmount = returnRecord.amount;
    } else {
      // مختلط: بنفس نسبة ما اُسترد في الإرجاع الأصلي (تطابق returnSaleItem بعد إصلاحه #1)
      const cashPaid = parseFloat(sale.cash_paid) || 0;
      const walletPaid = parseFloat(sale.wallet_paid) || 0;
      const refundCashRatio = (cashPaid + walletPaid) > 0 ? cashPaid / (cashPaid + walletPaid) : 0;
      undoCashAmount = returnRecord.amount * refundCashRatio;
      undoWalletAmount = returnRecord.amount * (1 - refundCashRatio);
    }

    if (undoCashAmount > 0.01) {
      const undoCurrency = undoCashInfo?.currency_id || baseCurrency.id;
      const undoRate = undoCashInfo?.exchange_rate || (baseCurrency.rate_to_base || 1);
      const cashBaseAmount = convertToBase(undoCashAmount, undoRate);
      journalDetails.push({ account_id: cashAccountId, debit: cashBaseAmount, credit: 0 });
      batchQueries.push({ sql: "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES ('deposit', ?, ?, ?, ?)", args: [undoCashAmount, undoCurrency, undoRate, `عكس إرجاع من فاتورة #${sale.invoice_number} (نقدي)`] });
    }
    if (undoWalletAmount > 0.01 && sale.wallet_id) {
      const undoCurrency = undoWalletInfo?.currency_id || baseCurrency.id;
      await ensureWalletBalance(tx, sale.wallet_id, undoCurrency);
      const walletBaseAmount = convertToBase(undoWalletAmount, undoCurrency === baseCurrency.id ? (baseCurrency.rate_to_base || 1) : await (async () => { const r = await dbFirst(tx, 'SELECT rate_to_base FROM currencies WHERE id = ?', [undoCurrency]); return r?.rate_to_base || 1; })());
      journalDetails.push({ account_id: walletAccountId, debit: walletBaseAmount, credit: 0 });
      batchQueries.push({ sql: "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'withdraw', ?, ?, ?, ?)", args: [sale.wallet_id, undoWalletAmount, undoCurrency, `عكس إرجاع من فاتورة #${sale.invoice_number}`, sale.id] });
      batchQueries.push({ sql: "UPDATE wallet_balances SET balance = balance - ? WHERE wallet_id = ? AND currency_id = ?", args: [undoWalletAmount, sale.wallet_id, undoCurrency] });
    }
    if (undoCreditAmount > 0.01 && sale.customer_id) {
      const customerBaseAmount = undoCreditAmount; // بالعملة الأساسية كما خُزن دين العميل
      journalDetails.push({ account_id: customerAccountId, debit: customerBaseAmount, credit: 0 });
      batchQueries.push({ sql: "UPDATE customers SET balance = balance + ? WHERE id = ?", args: [customerBaseAmount, sale.customer_id] });
    }

    await tx.batch(batchQueries, 'write');

    if (journalDetails.length > 0) {
      checkBalance(journalDetails);
      await createJournalEntry(tx, entryDate, desc, journalDetails, 'undo_return_sale', sale.id);
    }
    const cogsReturnEntry = await dbFirst(tx,
      "SELECT id FROM journal_entries WHERE reference_type = 'return_sale_cogs' AND reference_id = ? ORDER BY id DESC LIMIT 1",
      [sale.id]
    );
    if (cogsReturnEntry) {
      const details = await dbAll(tx,
        "SELECT account_id, debit, credit FROM journal_entry_details WHERE entry_id = ?",
        [cogsReturnEntry.id]
      );
      const reversedDetails = details.map(d => ({
        account_id: d.account_id,
        debit: d.credit,
        credit: d.debit,
        notes: `عكس تكلفة إرجاع فاتورة #${sale.invoice_number}`
      }));
      await createJournalEntry(tx, entryDate, `عكس تكلفة إرجاع فاتورة #${sale.invoice_number}`,
        reversedDetails, 'undo_return_sale_cogs', sale.id);
    }
    await tx.commit();
    return jsonResponse({ success: true, message: 'تم عكس الإرجاع بنجاح' }, 200, headers);
  } catch (error) {
    await tx.rollback();
    return jsonResponse({ error: error.message }, 400, headers);
  }
}

async function undoCancelPurchaseInvoice(request, env, headers, userId) {
  const { purchase_invoice_id } = await request.json();
  if (!purchase_invoice_id) return jsonResponse({ error: 'معرف الفاتورة مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) return jsonResponse({ error: 'لا توجد عملة أساسية' }, 400, headers);
  const invoice = await dbFirst(client, "SELECT * FROM purchase_invoices WHERE id = ? AND status = 'cancelled'", [purchase_invoice_id]);
  if (!invoice) return jsonResponse({ error: 'الفاتورة غير موجودة أو ليست ملغاة' }, 404, headers);
  const returns = await dbFirst(client, "SELECT COUNT(*) as cnt FROM returned_purchases WHERE purchase_invoice_id = ?", [purchase_invoice_id]);
  if (returns.cnt > 0) {
    return jsonResponse({ error: 'لا يمكن استرجاع فاتورة تم إرجاع بعض منتجاتها' }, 400, headers);
  }
  const tx = await client.transaction();
  try {
    const items = await dbAll(tx, "SELECT * FROM purchase_invoice_items WHERE invoice_id = ?", [purchase_invoice_id]);

    // ===== جلب المنتجات دفعة واحدة =====
    const productIds = items.map(item => item.product_id);
    let productsMap = {};
    if (productIds.length) {
      const productRows = await dbAll(tx, `SELECT id, stock_quantity, cost, expiry_date FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`, productIds);
      productsMap = productRows.reduce((acc, p) => {
        acc[p.id] = {
          stock_quantity: parseFloat(p.stock_quantity) || 0,
          cost: parseFloat(p.cost) || 0
        };
        return acc;
      }, {});
    }

    const batchQueries = [];
    for (const item of items) {
      const product = productsMap[item.product_id];
      if (!product) throw new Error(`المنتج ${item.product_id} غير موجود`);
      const newStock = product.stock_quantity + item.quantity;
      const newCost = (product.stock_quantity * product.cost + item.quantity * item.unit_price) / newStock;
      batchQueries.push({
        sql: "UPDATE products SET stock_quantity = ?, cost = ? WHERE id = ?",
        args: [newStock, newCost, item.product_id]
      });
      batchQueries.push({
        sql: `INSERT INTO stock_movements
              (product_id, supplier_id, quantity_change, old_quantity, new_quantity, reference_type, reference_id, note, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [item.product_id, invoice.supplier_id, item.quantity, product.stock_quantity, newStock, 'undo_cancel_purchase', purchase_invoice_id, `استرجاع فاتورة مشتريات #${invoice.invoice_number}`, userId]
      });
      const supplierStock = await dbFirst(tx,
        "SELECT id, quantity FROM product_supplier_stock WHERE product_id = ? AND supplier_id = ?",
        [item.product_id, invoice.supplier_id]
      );
      if (supplierStock) {
        batchQueries.push({
          sql: "UPDATE product_supplier_stock SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          args: [item.quantity, supplierStock.id]
        });
      } else {
        batchQueries.push({
          sql: "INSERT INTO product_supplier_stock (product_id, supplier_id, quantity, last_purchase_price, total_purchased) VALUES (?, ?, ?, ?, ?)",
          args: [item.product_id, invoice.supplier_id, item.quantity, item.unit_price, item.quantity]
        });
      }
    }
    batchQueries.push({
      sql: "UPDATE purchase_invoices SET status = 'completed' WHERE id = ?",
      args: [purchase_invoice_id]
    });

    // ===== إصلاح #3: عكس العمليات التشغيلية للإلغاء الأصلي (مثل cancelPurchaseInvoice سطور 3941-4004) =====
    const undoPaymentMethod = invoice.payment_method || '';
    let undoCash = parseFloat(invoice.cash_paid) || 0;
    let undoWallet = parseFloat(invoice.wallet_paid) || 0;
    const totalInvoice = parseFloat(invoice.total_amount) || 0;

    // تطبيق نفس منطق الـ fallback الخاص بالملغي
    if (undoPaymentMethod === 'cash' && undoCash === 0) undoCash = totalInvoice;
    if (undoPaymentMethod === 'wallet' && undoWallet === 0 && invoice.wallet_id) undoWallet = totalInvoice;
    if (undoPaymentMethod === 'mixed' && undoCash === 0 && undoWallet === 0) {
      undoCash = totalInvoice / 2; undoWallet = totalInvoice / 2;
    }

    // استرجاع معلومات العملات من حركات الملغي إن وُجدت
    const undoCashInfo = await dbFirst(tx, "SELECT currency_id, exchange_rate, amount FROM cash_register WHERE type = 'deposit' AND note LIKE ? ORDER BY id DESC LIMIT 1", [`إلغاء فاتورة مشتريات #${invoice.invoice_number}%`]);
    const undoWalletInfo = await dbFirst(tx, "SELECT currency_id, amount FROM wallet_transactions WHERE wallet_id = ? AND reference_id = ? AND type = 'deposit' ORDER BY id DESC LIMIT 1", [invoice.wallet_id, purchase_invoice_id]);

    let operationalReversalDetails = [];
    if ((undoPaymentMethod === 'cash' || undoPaymentMethod === 'mixed') && undoCash > 0.01) {
      const undoCurrency = undoCashInfo?.currency_id || invoice.currency_id || baseCurrency.id;
      const undoRate = undoCashInfo?.exchange_rate || (await getCurrencyRate(tx, undoCurrency)) || 1;
      const undoCashBase = convertToBase(undoCash, undoRate);
      const supplierAccountIdForUndo = await getAccountId(tx, 'الذمم الدائنة (موردين)');
      const cashAccountIdForUndo = await getAccountId(tx, 'الصندوق');
      batchQueries.push({ sql: "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES ('withdraw', ?, ?, ?, ?)", args: [undoCash, undoCurrency, undoRate, `استرجاع إلغاء فاتورة مشتريات #${invoice.invoice_number} (نقدي)`] });
      operationalReversalDetails.push({ account_id: supplierAccountIdForUndo, debit: undoCashBase, credit: 0 });
      operationalReversalDetails.push({ account_id: cashAccountIdForUndo, debit: 0, credit: undoCashBase });
    }
    if ((undoPaymentMethod === 'wallet' || undoPaymentMethod === 'mixed') && undoWallet > 0.01 && invoice.wallet_id) {
      const undoCurrency = undoWalletInfo?.currency_id || invoice.currency_id || baseCurrency.id;
      const bal = await dbFirst(tx, "SELECT balance FROM wallet_balances WHERE wallet_id = ? AND currency_id = ?", [invoice.wallet_id, undoCurrency]);
      if (!bal || parseFloat(bal.balance) < undoWallet) throw new Error('رصيد غير كافٍ في المحفظة لعكس الإلغاء');
      await updateWalletBalance(tx, invoice.wallet_id, undoCurrency, undoWallet, 'subtract');
      const undoWalletBase = convertToBase(undoWallet, undoCurrency === baseCurrency.id ? (baseCurrency.rate_to_base || 1) : await (async () => { const r = await dbFirst(tx, 'SELECT rate_to_base FROM currencies WHERE id = ?', [undoCurrency]); return r?.rate_to_base || 1; })());
      const supplierAccountIdForUndo = await getAccountId(tx, 'الذمم الدائنة (موردين)');
      const walletAccountIdForUndo = await getAccountId(tx, 'المحافظ');
      batchQueries.push({ sql: "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'withdraw', ?, ?, ?, ?)", args: [invoice.wallet_id, undoWallet, undoCurrency, `استرجاع إلغاء فاتورة مشتريات #${invoice.invoice_number}`, purchase_invoice_id] });
      operationalReversalDetails.push({ account_id: supplierAccountIdForUndo, debit: undoWalletBase, credit: 0 });
      operationalReversalDetails.push({ account_id: walletAccountIdForUndo, debit: 0, credit: undoWalletBase });
    }
    if (undoPaymentMethod === 'credit' && invoice.supplier_id) {
      batchQueries.push({ sql: "UPDATE suppliers SET balance = balance + ? WHERE id = ?", args: [totalInvoice, invoice.supplier_id] });
    }
    const undoEntryDate = new Date().toISOString().split('T')[0];
    if (operationalReversalDetails.length > 0) {
      checkBalance(operationalReversalDetails);
      await createJournalEntry(tx, undoEntryDate, `عكس العمليات التشغيلية لإلغاء فاتورة مشتريات #${invoice.invoice_number} (استرجاع النقدية/المحفظة/دين المورد)`, operationalReversalDetails, 'undo_cancel_purchase_operational', purchase_invoice_id);
    }

    const cancelEntry = await dbFirst(tx,
      "SELECT id FROM journal_entries WHERE reference_type = 'cancel_purchase' AND reference_id = ? ORDER BY id LIMIT 1",
      [purchase_invoice_id]
    );
    if (cancelEntry) {
      const details = await dbAll(tx,
        "SELECT account_id, debit, credit FROM journal_entry_details WHERE entry_id = ?",
        [cancelEntry.id]
      );
      const reversedDetails = details.map(d => ({
        account_id: d.account_id,
        debit: d.credit,
        credit: d.debit,
        notes: `عكس إلغاء فاتورة مشتريات #${invoice.invoice_number}`
      }));
      const entryDate = new Date().toISOString().split('T')[0];
      await createJournalEntry(tx, entryDate, `استرجاع فاتورة مشتريات #${invoice.invoice_number}`,
        reversedDetails, 'undo_cancel_purchase', purchase_invoice_id);
    }

    // ===== تنفيذ الدفعات على أجزاء =====
    const BATCH_SIZE = 40;
    for (let i = 0; i < batchQueries.length; i += BATCH_SIZE) {
      const chunk = batchQueries.slice(i, i + BATCH_SIZE);
      await tx.batch(chunk, 'write');
    }

    await tx.commit();
    return jsonResponse({ success: true, message: 'تم استرجاع فاتورة الشراء الملغاة بنجاح' }, 200, headers);
  } catch (error) {
    await tx.rollback();
    return jsonResponse({ error: error.message }, 400, headers);
  }
}

// ================================================================
//  دوال تحديث حالة التوصيل (معدلة لدعم الإرجاع المرحلي) =================================
// ================================================================

async function updateDeliveryStatus(request, env, ctx, headers, userId) {
  let {
    order_id,
    delivery_status,
    payment_method,
    cash_collected,
    wallet_collected,
    wallet_id,
    notes,
    return_items,
    cash_currency_id,
    wallet_currency_id
  } = await request.json();

  if (!order_id || !delivery_status) {
    return jsonResponse({ error: 'بيانات غير مكتملة' }, 400, headers);
  }

  // ===== عدّاد الطلبات الفرعية (لتشخيص مشكلة حد الـ subrequests في Cloudflare Workers) =====
  let subCount = 0;
  const qFirst = (conn, sql, args = []) => { subCount++; return dbFirst(conn, sql, args); };
  const qAll = (conn, sql, args = []) => { subCount++; return dbAll(conn, sql, args); };
  const qRun = (conn, sql, args = []) => { subCount++; return dbRun(conn, sql, args); };
  const qBatch = (conn, queries, mode = 'write') => { subCount++; return conn.batch(queries, mode); };
  const qJournal = async (...args) => { subCount += 2; return createJournalEntry(...args); };

  const client = getTursoClient(env);
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) {
    return jsonResponse({ error: 'لا توجد عملة أساسية' }, 400, headers);
  }
  const useCashCurrencyId = cash_currency_id || baseCurrency.id;
  const useWalletCurrencyId = wallet_currency_id || baseCurrency.id;

  const tx = await client.transaction();
  let committed = false;      // ===== علم يحدد هل تم الـ commit فعليًا =====
  let driverId = null;

  try {
    const order = await qFirst(tx, "SELECT * FROM online_orders WHERE id = ?", [order_id]);
    if (!order) throw new Error('الطلب غير موجود');

    // ===== تحميل كل الحسابات والعملات دفعة واحدة (بدل استعلام منفصل لكل حساب/عملة) =====
    const accountsRows = await qAll(tx, "SELECT id, name FROM accounts");
    const accountsMap = Object.fromEntries(accountsRows.map(a => [a.name, a.id]));
    const currenciesRows = await qAll(tx, "SELECT id, rate_to_base FROM currencies");
    const currenciesMap = Object.fromEntries(currenciesRows.map(c => [c.id, c.rate_to_base]));

    const getRateFast = (id) => {
      const rate = currenciesMap[id];
      if (rate === undefined) throw new Error(`العملة ${id} غير موجودة`);
      return rate;
    };
    const getAccountFast = async (name, code, type) => {
      if (accountsMap[name]) return accountsMap[name];
      const result = await qRun(tx,
        "INSERT INTO accounts (name, code, parent_id, type, is_active) VALUES (?, ?, ?, ?, 1)",
        [name, code, null, type]
      );
      accountsMap[name] = result.lastInsertRowid;
      return accountsMap[name];
    };

    let sale = null;
    if (order.accounting_invoice_id) {
      sale = await qFirst(tx, "SELECT * FROM sales WHERE id = ?", [order.accounting_invoice_id]);
    }
    if (!sale) {
      const invoiceNumber = `INV-DRV-${await getNextInvoiceNumber(tx, 'delivery_sales')}`;
      subCount += 2;
      const saleResult = await qRun(tx,
        `INSERT INTO sales (invoice_number, customer_id, total_amount, discount, payment_method, cash_paid, wallet_paid, wallet_id, paid_amount, status, note)
         VALUES (?, ?, ?, 0, 'pending', 0, 0, NULL, 0, 'pending', ?)`,
        [invoiceNumber, null, order.total_amount, `فاتورة توصيل #${order_id}`]
      );
      const saleId = saleResult.lastInsertRowid;
      await qRun(tx, "UPDATE online_orders SET accounting_invoice_id = ? WHERE id = ?", [saleId, order_id]);
      sale = { id: saleId, invoice_number: invoiceNumber, total_amount: order.total_amount, status: 'pending' };
    }

    if (return_items && Array.isArray(return_items) && return_items.length > 0) {
      throw new Error('يجب إجراء الإرجاع الجزئي عبر نظام الإرجاع (استخدم /driver/return-items)');
    }

    const orderItems = await qAll(tx, "SELECT * FROM online_order_items WHERE order_id = ?", [order_id]);
    const productIds = orderItems.map(item => item.product_id).filter(id => id);

    let productCostMap = {};
    if (productIds.length > 0) {
      const costs = await qAll(tx, `SELECT id, cost FROM products WHERE id IN (${productIds.join(',')})`);
      for (const row of costs) {
        productCostMap[row.id] = row.cost || 0;
      }
    }

    let totalCost = 0;
    for (const item of orderItems) {
      if (item.product_id) {
        totalCost += (productCostMap[item.product_id] || 0) * item.quantity;
      }
    }

    const deliveryFee = order.delivery_fee || 0;
    const deliveryFeePayment = order.delivery_fee_payment || 'مع الطلب';
    const productRevenue = deliveryFeePayment === 'مع الطلب' ? order.total_amount - deliveryFee : order.total_amount;
    const profit = productRevenue - totalCost;

    driverId = order.assigned_driver_id;

    if (delivery_status === 'تم التوصيل') {
      const isPrepaid = isPrepaidOrder(order);
      let actualCollected = 0, cashCollectedVal = 0, walletCollectedVal = 0;
      const batchQueries = [];

      if (sale) {
        batchQueries.push({
          sql: "UPDATE sales SET total_cost = ?, profit = ? WHERE id = ?",
          args: [totalCost, profit, sale.id]
        });
      }

      if (!isPrepaid) {
        let finalCashCollected = 0, finalWalletCollected = 0;
        let totalToCollect = 0;
        const isMixed = isMixedOrder(order);

        if (isMixed && payment_method !== 'مختلط') payment_method = 'مختلط';

        if (isMixed && sale) {
          totalToCollect = parseFloat(sale.cash_paid) || 0;
        } else {
          const oTotal = parseFloat(order.total_amount) || 0;
          totalToCollect = Math.max(0, oTotal);
        }

        if (deliveryFeePayment === 'عند الاستلام' && order.delivery_fee) {
          totalToCollect += parseFloat(order.delivery_fee) || 0;
        }

        const cashRate = getRateFast(useCashCurrencyId);
        const walletRate = getRateFast(useWalletCurrencyId);

        if (payment_method === 'نقدي') {
          finalCashCollected = convertFromBase(totalToCollect, cashRate);
          finalWalletCollected = 0;
        } else if (payment_method === 'محفظة') {
          finalWalletCollected = convertFromBase(totalToCollect, walletRate);
          finalCashCollected = 0;
        } else if (payment_method === 'مختلط') {
          const cashBase0 = convertToBase(cash_collected || 0, cashRate);
          const walletBase0 = convertToBase(wallet_collected || 0, walletRate);
          const totalPaidBase0 = cashBase0 + walletBase0;
          if (totalPaidBase0 === 0) throw new Error('المبلغ المحصل صفر');
          const ratio = totalToCollect / totalPaidBase0;
          finalCashCollected = (cash_collected || 0) * ratio;
          finalWalletCollected = (wallet_collected || 0) * ratio;
        }

        cashCollectedVal = finalCashCollected;
        walletCollectedVal = finalWalletCollected;
        actualCollected = isMixed && sale ? finalCashCollected : totalToCollect;

        if ((payment_method === 'محفظة' || payment_method === 'مختلط') && finalWalletCollected > 0) {
          if (!wallet_id) throw new Error('معرف المحفظة مطلوب للدفع عبر المحفظة');
          if (!currenciesMap[useWalletCurrencyId]) throw new Error(`العملة ${useWalletCurrencyId} غير موجودة`);
          const walletExists = await qFirst(tx, "SELECT id FROM wallets WHERE id = ?", [wallet_id]);
          if (!walletExists) throw new Error(`المحفظة ${wallet_id} غير موجودة`);

          await ensureWalletBalance(tx, wallet_id, useWalletCurrencyId);
          subCount += 2;
          await qRun(tx,
            "UPDATE wallet_balances SET balance = balance + ? WHERE wallet_id = ? AND currency_id = ?",
            [finalWalletCollected, wallet_id, useWalletCurrencyId]
          );
          await qRun(tx,
            "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'deposit', ?, ?, ?, ?)",
            [wallet_id, finalWalletCollected, useWalletCurrencyId, `تحصيل من طلب #${order_id}`, order_id]
          );
        }

        const cashBase = convertToBase(cashCollectedVal, cashRate);
        const walletBase = convertToBase(walletCollectedVal, walletRate);
        let totalBaseCollected = cashBase + walletBase;

        const baseRate = getRateFast(baseCurrency.id);
        const totalToCollectBase = convertToBase(totalToCollect, baseRate);

        const matchTolerance = 0.05;
        if (totalToCollectBase > 0.001 && Math.abs(totalBaseCollected - totalToCollectBase) > matchTolerance) {
          const mismatchError = `المبلغ المحصّل (${totalBaseCollected.toFixed(2)}) لا يساوي المبلغ المطلوب (${totalToCollectBase.toFixed(2)})`;
          console.error('⚠️ عدم تطابق المبالغ في update-delivery:', mismatchError, {
            order_id, payment_method, cash_collected, wallet_collected, totalToCollect, subrequest_count: subCount
          });
          await tx.rollback();
          return jsonResponse({
            success: false,
            error: mismatchError,
            debug: { expected: totalToCollectBase, received: totalBaseCollected, subrequest_count: subCount }
          }, 400, headers);
        }
        if (totalToCollectBase <= 0.001 && totalBaseCollected > 0.001) {
          totalBaseCollected = 0;
          cashCollectedVal = 0;
          walletCollectedVal = 0;
        }

        const feeBase = convertToBase(deliveryFee, baseRate);

        if (driverId) {
          if (cashBase > 0.001) {
            batchQueries.push({
              sql: "UPDATE driver_accounts SET total_collected = total_collected + ? WHERE driver_id = ?",
              args: [cashBase, driverId]
            });
            batchQueries.push({
              sql: "INSERT INTO driver_transactions (driver_id, order_id, type, amount, description, payment_method, wallet_id, cash_amount, wallet_amount) VALUES (?, ?, 'collection', ?, ?, ?, ?, ?, ?)",
              args: [driverId, order_id, cashBase, `تحصيل نقدي للطلب #${order_id}`, 'cash', null, cashBase, 0]
            });
          }
          if (feeBase > 0.001) {
            batchQueries.push({
              sql: "UPDATE driver_accounts SET total_fees = total_fees + ? WHERE driver_id = ?",
              args: [feeBase, driverId]
            });
            batchQueries.push({
              sql: "INSERT INTO driver_transactions (driver_id, order_id, type, amount, description, payment_method, wallet_id, cash_amount, wallet_amount) VALUES (?, ?, 'delivery_fee', ?, ?, ?, ?, ?, ?)",
              args: [driverId, order_id, feeBase, `أجرة توصيل للطلب #${order_id}`, 'cash', null, 0, 0]
            });
          }
          const balanceDelta = cashBase - feeBase;
          if (Math.abs(balanceDelta) > 0.001) {
            batchQueries.push({
              sql: "UPDATE driver_accounts SET balance = balance + ? WHERE driver_id = ?",
              args: [balanceDelta, driverId]
            });
          }
          batchQueries.push({
            sql: "UPDATE driver_accounts SET total_deliveries = total_deliveries + 1 WHERE driver_id = ?",
            args: [driverId]
          });
        }

        let salePaymentMethod = payment_method === 'نقدي' ? 'cash' : (payment_method === 'محفظة' ? 'wallet' : 'mixed');
        let totalPaidAmount = totalBaseCollected;
        if (isMixed && sale) {
          const saleWalletPaid = parseFloat(sale.wallet_paid) || 0;
          const walletRateForPaid = getRateFast(sale.wallet_currency_id || baseCurrency.id);
          const saleWalletPaidBase = convertToBase(saleWalletPaid, walletRateForPaid);
          totalPaidAmount = totalBaseCollected + saleWalletPaidBase;
        }
        const finalWalletPaidToSave = isMixed ? (parseFloat(sale.wallet_paid) || 0) : (walletCollectedVal || 0);
        const finalWalletIdToSave = isMixed ? sale.wallet_id : (wallet_id || null);

        batchQueries.push({
          sql: `UPDATE sales SET payment_method = ?, cash_paid = ?, wallet_paid = ?, wallet_id = ?, paid_amount = ?, status = 'completed' WHERE id = ?`,
          args: [salePaymentMethod, cashCollectedVal || 0, finalWalletPaidToSave, finalWalletIdToSave, totalPaidAmount, sale.id]
        });

        const entryDate = new Date().toISOString().split('T')[0];
        const desc = `تسليم طلب إنترنت #${order_id}`;
        const saleAccountId = await getAccountFast('المبيعات', '4000', 'income');
        const deliveryFeeLiabilityId = await getAccountFast('رسوم التوصيل المستحقة', '2105', 'liability');
        const cashAccountId = await getAccountFast('الصندوق', '1001', 'asset');
        const walletAccountId = await getAccountFast('المحافظ', '1002', 'asset');
        const driverReceivableId = await getAccountFast('الذمم المدينة (مندوبين)', '1102', 'asset');

        const journalRevenueBase = Math.max(0, totalBaseCollected - feeBase);
        const journalFeeCredit = feeBase;
        const journalDetails = [];

        if (payment_method === 'نقدي') {
          if (totalBaseCollected > 0.001) {
            journalDetails.push({ account_id: driverReceivableId, debit: totalBaseCollected, credit: 0 });
          }
        } else if (payment_method === 'محفظة') {
          if (totalBaseCollected > 0.001) {
            journalDetails.push({ account_id: walletAccountId, debit: totalBaseCollected, credit: 0 });
          }
        } else if (payment_method === 'مختلط') {
          if (cashBase > 0.001) {
            journalDetails.push({ account_id: driverReceivableId, debit: cashBase, credit: 0 });
          }
          if (sale && parseFloat(sale.wallet_paid) > 0) {
            const walletRateForJournal = getRateFast(sale.wallet_currency_id || baseCurrency.id);
            const saleWalletPaidBase = convertToBase(parseFloat(sale.wallet_paid), walletRateForJournal);
            if (saleWalletPaidBase > 0.001) {
              journalDetails.push({ account_id: walletAccountId, debit: saleWalletPaidBase, credit: 0 });
            }
          }
          const customerReceivableId = await getAccountFast('الذمم المدينة (عملاء)', '1101', 'asset');
          const totalDeliveryCredit = cashBase + (sale ? convertToBase(parseFloat(sale.wallet_paid) || 0, getRateFast(sale.wallet_currency_id || baseCurrency.id)) : 0);
          if (totalDeliveryCredit > 0.001) {
            journalDetails.push({ account_id: customerReceivableId, debit: 0, credit: totalDeliveryCredit });
          }
        }

        if (!isMixed) {
          if (journalRevenueBase > 0.001) {
            journalDetails.push({ account_id: saleAccountId, debit: 0, credit: journalRevenueBase });
          }
          if (journalFeeCredit > 0.001) {
            journalDetails.push({ account_id: deliveryFeeLiabilityId, debit: 0, credit: journalFeeCredit });
          }
        }

        if (journalDetails.length > 0) {
          checkBalance(journalDetails);
          await qJournal(tx, entryDate, desc, journalDetails, 'online_order_delivery', order_id);
        }

        if (totalCost > 0) {
          const cogsAccountId = await getAccountFast('تكلفة البضاعة المباعة', '5000', 'expense');
          const inventoryAccountId = await getAccountFast('المخزون', '1300', 'asset');
          const cogsEntryDate = new Date().toISOString().split('T')[0];
          const cogsDesc = `تكلفة تسليم طلب #${order_id}`;
          const totalCostBase = convertToBase(totalCost, baseRate);
          const cogsJournal = [
            { account_id: cogsAccountId, debit: totalCostBase, credit: 0 },
            { account_id: inventoryAccountId, debit: 0, credit: totalCostBase }
          ];
          checkBalance(cogsJournal);
          await qJournal(tx, cogsEntryDate, cogsDesc, cogsJournal, 'delivery_cogs', order_id);
        }

        if (batchQueries.length > 0) {
          await qBatch(tx, batchQueries, 'write');
        }

      } else {
        actualCollected = 0;
        const baseRate = getRateFast(baseCurrency.id);
        const feeBase = convertToBase(deliveryFee, baseRate);

        if (driverId) {
          batchQueries.push({
            sql: "UPDATE driver_accounts SET total_deliveries = total_deliveries + 1 WHERE driver_id = ?",
            args: [driverId]
          });

          if (deliveryFeePayment === 'مع الطلب') {
            if (feeBase > 0.001) {
              batchQueries.push({
                sql: "UPDATE driver_accounts SET total_fees = total_fees + ? WHERE driver_id = ?",
                args: [feeBase, driverId]
              });
              batchQueries.push({
                sql: "INSERT INTO driver_transactions (driver_id, order_id, type, amount, description, payment_method, wallet_id, cash_amount, wallet_amount) VALUES (?, ?, 'delivery_fee', ?, ?, ?, ?, ?, ?)",
                args: [driverId, order_id, feeBase, `أجرة توصيل للطلب #${order_id}`, 'cash', null, 0, 0]
              });
              batchQueries.push({
                sql: "UPDATE driver_accounts SET balance = balance - ? WHERE driver_id = ?",
                args: [feeBase, driverId]
              });
            }
          } else if (deliveryFeePayment === 'عند الاستلام') {
            if (feeBase > 0.001) {
              batchQueries.push({
                sql: "UPDATE driver_accounts SET total_collected = total_collected + ? WHERE driver_id = ?",
                args: [feeBase, driverId]
              });
              batchQueries.push({
                sql: "INSERT INTO driver_transactions (driver_id, order_id, type, amount, description, payment_method, wallet_id, cash_amount, wallet_amount) VALUES (?, ?, 'collection', ?, ?, ?, ?, ?, ?)",
                args: [driverId, order_id, feeBase, `تحصيل رسوم التوصيل من الزبون للطلب #${order_id}`, 'cash', null, feeBase, 0]
              });
              batchQueries.push({
                sql: "UPDATE driver_accounts SET total_fees = total_fees + ? WHERE driver_id = ?",
                args: [feeBase, driverId]
              });
              batchQueries.push({
                sql: "INSERT INTO driver_transactions (driver_id, order_id, type, amount, description, payment_method, wallet_id, cash_amount, wallet_amount) VALUES (?, ?, 'delivery_fee', ?, ?, ?, ?, ?, ?)",
                args: [driverId, order_id, feeBase, `أجرة توصيل للطلب #${order_id}`, 'cash', null, 0, 0]
              });
              batchQueries.push({
                sql: "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES ('deposit', ?, ?, ?, ?)",
                args: [deliveryFee, baseCurrency.id, 1, `تحصيل رسوم توصيل من الزبون للطلب #${order_id}`]
              });

              const entryDate = new Date().toISOString().split('T')[0];
              const desc = `تحصيل رسوم توصيل للطلب #${order_id}`;
              const cashAccountIdPrepaid = await getAccountFast('الصندوق', '1001', 'asset');
              const deliveryFeeLiabilityIdPrepaid = await getAccountFast('رسوم التوصيل المستحقة', '2105', 'liability');
              const journalDetails = [
                { account_id: cashAccountIdPrepaid, debit: feeBase, credit: 0 },
                { account_id: deliveryFeeLiabilityIdPrepaid, debit: 0, credit: feeBase }
              ];
              checkBalance(journalDetails);
              await qJournal(tx, entryDate, desc, journalDetails, 'delivery_fee_collection', order_id);
            }
          }
        }

        if (sale) {
          batchQueries.push({
            sql: "UPDATE sales SET status = 'completed' WHERE id = ?",
            args: [sale.id]
          });
        }

        if (batchQueries.length > 0) {
          await qBatch(tx, batchQueries, 'write');
        }
      }

      const finalBatchQueries = [];
      finalBatchQueries.push({
        sql: `UPDATE online_orders SET status = 'تم التسليم', actual_payment_method = ?, actual_payment_details = ?, actual_collected = ? WHERE id = ?`,
        args: [payment_method || order.payment_method, JSON.stringify({ cash: cashCollectedVal, wallet: walletCollectedVal, wallet_id: wallet_id || null }), actualCollected, order_id]
      });
      finalBatchQueries.push({
        sql: "INSERT INTO order_status_log (order_id, old_status, new_status, status, notes) VALUES (?, ?, ?, ?, ?)",
        args: [order_id, order.status, 'تم التسليم', 'تم التسليم', notes || 'تم التسليم بواسطة المندوب']
      });
      finalBatchQueries.push({
        sql: `UPDATE delivery_assignments SET delivery_status = 'تم التوصيل', payment_method = ?, cash_collected = ?, wallet_collected = ?, wallet_id = ?, collected_amount = ? WHERE order_id = ?`,
        args: [payment_method || 'نقدي', cashCollectedVal || 0, walletCollectedVal || 0, wallet_id || null, actualCollected, order_id]
      });

      if (finalBatchQueries.length > 0) {
        const __BATCH_SIZE = 40;
        for (let __i = 0; __i < finalBatchQueries.length; __i += __BATCH_SIZE) {
          await qBatch(tx, finalBatchQueries.slice(__i, __i + __BATCH_SIZE), 'write');
        }
      }

    } else if (delivery_status === 'قيد التوصيل') {
      await qRun(tx, "UPDATE online_orders SET status = 'قيد التوصيل' WHERE id = ?", [order_id]);
      await qRun(tx, "INSERT INTO order_status_log (order_id, old_status, new_status, status, notes) VALUES (?, ?, ?, ?, ?)",
        [order_id, order.status, 'قيد التوصيل', 'قيد التوصيل', notes || '']);

    } else if (delivery_status === 'فشل') {
      const productIdsFail = orderItems.map(item => item.product_id).filter(id => id);

      let bestSupplierMapFail = {};
      if (productIdsFail.length > 0) {
        const bestSuppliers = await qAll(tx, `
          SELECT product_id, supplier_id
          FROM product_supplier_stock
          WHERE product_id IN (${productIdsFail.join(',')}) AND quantity > 0
          ORDER BY product_id, quantity DESC
        `);
        for (const row of bestSuppliers) {
          if (!bestSupplierMapFail[row.product_id]) {
            bestSupplierMapFail[row.product_id] = row.supplier_id;
          }
        }
      }

      const deliveryFailStockCache = {};
      if (productIdsFail.length) {
        const stockRows = await qAll(tx,
          `SELECT id, stock_quantity FROM products WHERE id IN (${productIdsFail.map(() => '?').join(',')})`,
          productIdsFail
        );
        stockRows.forEach(row => {
          deliveryFailStockCache[row.id] = parseFloat(row.stock_quantity) || 0;
        });
      }

      const restoreQueriesFail = [];
      for (const item of orderItems) {
        if (item.product_id && item.quantity > 0) {
          await applyStockChange(tx, restoreQueriesFail, {
            productId: item.product_id,
            supplierId: bestSupplierMapFail[item.product_id] || null,
            delta: item.quantity,
            referenceType: 'delivery_failed',
            referenceId: order_id,
            note: `فشل توصيل طلب #${order_id}`,
            userId,
            stockCache: deliveryFailStockCache
          });
        }
      }

      if (restoreQueriesFail.length > 0) {
        await qBatch(tx, restoreQueriesFail);
      }

      if (isPrepaidOrder(order)) {
        const salePrepaid = await qFirst(tx, "SELECT * FROM sales WHERE id = ?", [order.accounting_invoice_id]);
        if (salePrepaid && salePrepaid.wallet_id && salePrepaid.paid_amount > 0) {
          const walletTx = await qFirst(tx,
            "SELECT currency_id FROM wallet_transactions WHERE reference_id = ? AND type = 'deposit' LIMIT 1",
            [order.accounting_invoice_id]
          );
          const currId = walletTx ? walletTx.currency_id : baseCurrency.id;

          const refundQueriesFail = [];
          refundQueriesFail.push({
            sql: "UPDATE wallet_balances SET balance = balance - ? WHERE wallet_id = ? AND currency_id = ?",
            args: [salePrepaid.paid_amount, salePrepaid.wallet_id, currId]
          });
          refundQueriesFail.push({
            sql: "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'withdraw', ?, ?, ?, ?)",
            args: [salePrepaid.wallet_id, salePrepaid.paid_amount, currId, `استرداد مبلغ طلب فاشل #${order_id}`, order_id]
          });
          refundQueriesFail.push({
            sql: "UPDATE sales SET status = 'cancelled' WHERE id = ?",
            args: [salePrepaid.id]
          });

          const saleAccountIdFail = await getAccountFast('المبيعات', '4000', 'income');
          const walletAccountIdFail = await getAccountFast('المحافظ', '1002', 'asset');
          const cogsAccountIdFail = await getAccountFast('تكلفة البضاعة المباعة', '5000', 'expense');
          const inventoryAccountIdFail = await getAccountFast('المخزون', '1300', 'asset');

          const entryDateFail = new Date().toISOString().split('T')[0];
          const descFail = `إلغاء طلب إنترنت #${order_id} (مدفوع مسبقاً)`;

          const journalDetailsFail = [
            { account_id: saleAccountIdFail, debit: salePrepaid.paid_amount, credit: 0 },
            { account_id: walletAccountIdFail, debit: 0, credit: salePrepaid.paid_amount }
          ];
          const totalCostFail = await qFirst(tx, "SELECT total_cost FROM sales WHERE id = ?", [salePrepaid.id]);
          if (totalCostFail && totalCostFail.total_cost > 0) {
            journalDetailsFail.push({ account_id: inventoryAccountIdFail, debit: totalCostFail.total_cost, credit: 0 });
            journalDetailsFail.push({ account_id: cogsAccountIdFail, debit: 0, credit: totalCostFail.total_cost });
          }
          if (journalDetailsFail.length > 0) {
            checkBalance(journalDetailsFail);
            await qJournal(tx, entryDateFail, descFail, journalDetailsFail, 'cancel_prepaid_order', order_id);
          }

          if (refundQueriesFail.length > 0) {
            await qBatch(tx, refundQueriesFail);
          }
        }
      }

      await qRun(tx, "UPDATE online_orders SET status = 'فشل التسليم' WHERE id = ?", [order_id]);
      await qRun(tx, "INSERT INTO order_status_log (order_id, old_status, new_status, status, notes) VALUES (?, ?, ?, ?, ?)",
        [order_id, order.status, 'فشل التسليم', 'فشل التسليم', notes || '']);

    } else {
      throw new Error('حالة غير معروفة');
    }

    // ===== نقطة الحسم: بمجرد نجاح هذا السطر، البيانات محفوظة نهائيًا ولا يجوز إرجاع خطأ بعده =====
    await tx.commit();
    committed = true;

    // ===== إشعارات الخلفية (لا تؤثر على نجاح العملية حتى لو فشلت) =====
    try {
      if (delivery_status === 'تم التوصيل' && driverId) {
        ctx.waitUntil(sendAdminFCMNotification(
          env, '✅ تم توصيل الطلب', `قام المندوب بتوصيل الطلب #${order_id}`,
          `https://pos.ibnalmukhtar.com/orders.html`
        ));
      } else if (delivery_status === 'قيد التوصيل' && order.assigned_driver_id) {
        ctx.waitUntil(sendAdminFCMNotification(
          env, '🚚 الطلب قيد التوصيل', `المندوب بدأ توصيل الطلب #${order_id}`
        ));
      } else if (delivery_status === 'فشل' && order.assigned_driver_id) {
        ctx.waitUntil(sendAdminFCMNotification(
          env, `❌ فشل توصيل الطلب #${order_id}`, `فشل توصيل الطلب، تم استرجاع المخزون`
        ));
      }
    } catch (notifyErr) {
      console.error('⚠️ فشل إرسال الإشعار (لا يؤثر على نجاح العملية):', notifyErr.message);
    }

    // ===== قراءات ما بعد الـ commit: مغلّفة بمعزل تام حتى لا يفسد فشلها الاستجابة =====
    try {
      const finalOrder = await dbFirst(client, "SELECT * FROM online_orders WHERE id = ?", [order_id]);
      const finalOrderItems = await dbAll(client, "SELECT * FROM online_order_items WHERE order_id = ?", [order_id]);
      let driverAccount = null;
      if (driverId) {
        driverAccount = await dbFirst(client, "SELECT balance, last_settlement_date FROM driver_accounts WHERE driver_id = ?", [driverId]);
      }

      console.log(`✅ updateDeliveryStatus نجحت للطلب #${order_id} — عدد الاستعلامات التقريبي: ${subCount}`);

      return jsonResponse({
        success: true,
        order: { ...finalOrder, items: finalOrderItems },
        account: driverAccount || { balance: 0, last_settlement_date: null },
        debug: { subrequest_count: subCount }
      }, 200, headers);

    } catch (postCommitError) {
      // ===== العملية نجحت فعليًا في قاعدة البيانات، فشل فقط جلب بيانات الرد =====
      console.error('⚠️ نجح الحفظ لكن فشل جلب بيانات الرد (لا يعني فشل العملية):', {
        order_id, message: postCommitError.message, subrequest_count: subCount
      });
      return jsonResponse({
        success: true,
        message: 'تم تحديث حالة الطلب بنجاح',
        warning: 'تعذر جلب النسخة الكاملة من البيانات بعد الحفظ',
        debug: { subrequest_count: subCount, post_commit_error: postCommitError.message }
      }, 200, headers);
    }

  } catch (error) {
    // ===== الحالة الحرجة: لو الخطأ صار بعد نجاح الـ commit، ما نرجّع خطأ أبدًا =====
    if (committed) {
      console.error('⚠️ خطأ بعد نجاح الحفظ فعليًا — يتم تجاهله وإرجاع نجاح:', {
        order_id, message: error.message, subrequest_count: subCount
      });
      return jsonResponse({
        success: true,
        message: 'تم تحديث حالة الطلب بنجاح',
        warning: 'حدث خطأ بسيط بعد الحفظ لا يؤثر على البيانات: ' + error.message,
        debug: { subrequest_count: subCount }
      }, 200, headers);
    }

    // ===== الخطأ صار قبل الـ commit → التراجع آمن ومنطقي =====
    try {
      await tx.rollback();
    } catch (rollbackErr) {
      console.error('⚠️ فشل التراجع (rollback):', rollbackErr.message);
    }

    console.error('❌ خطأ في updateDeliveryStatus (قبل الحفظ):', {
      order_id, delivery_status, payment_method,
      message: error.message,
      stack: error.stack,
      subrequest_count: subCount
    });
    return jsonResponse({
      error: error.message,
      debug: { order_id, delivery_status, payment_method, subrequest_count: subCount }
    }, 400, headers);
  }
}

// ================================================================
//  دوال الإرجاع (نقاط النهاية) =================================
// ================================================================

async function getReturnRequests(request, env, headers) {
  const url = new URL(request.url);
  const driverId = url.searchParams.get('driver_id');
  if (!driverId) return jsonResponse({ error: 'معرف المندوب مطلوب' }, 400, headers);

  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT r.*, o.customer_name, o.customer_phone, o.customer_address,
           r.return_fee, r.return_fee_type
    FROM online_order_returns r
    JOIN online_orders o ON o.id = r.order_id
    WHERE r.status = 'pending' AND r.assigned_driver_id = ?
    ORDER BY r.created_at DESC
  `, [driverId]);

  const returnIds = rows.map(r => r.id);
  let itemsMap = {};
  if (returnIds.length > 0) {
    const items = await dbAll(client, `
      SELECT * FROM online_order_return_items WHERE return_id IN (${returnIds.join(',')})
    `);
    for (const item of items) {
      if (!itemsMap[item.return_id]) itemsMap[item.return_id] = [];
      itemsMap[item.return_id].push(item);
    }
  }
  const returnsWithItems = rows.map(r => ({ ...r, items: itemsMap[r.id] || [] }));

  return jsonResponse({ return_requests: returnsWithItems }, 200, headers);
}

async function driverConfirmReturn(request, env, ctx, headers) {
  const { return_id } = await request.json();
  if (!return_id) return jsonResponse({ error: 'معرف الإرجاع مطلوب' }, 400, headers);
  const user = await getCurrentUser(request, env);
  const confirmedBy = user ? user.id : null;
  return await confirmReturn(return_id, confirmedBy, request, env, ctx, headers);
}

async function getReturns(request, env, headers) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || '';
  const driverId = url.searchParams.get('driver_id') || '';
  const page = parseInt(url.searchParams.get('page')) || 1;
  const limit = parseInt(url.searchParams.get('limit')) || 20;
  const offset = (page - 1) * limit;

  const client = getTursoClient(env);
  let sql = `
    SELECT r.*, o.customer_name, o.customer_phone, d.name as driver_name,
           r.return_fee, r.return_fee_type
    FROM online_order_returns r
    JOIN online_orders o ON o.id = r.order_id
    LEFT JOIN drivers d ON d.id = r.assigned_driver_id
    WHERE 1=1
  `;
  const args = [];
  if (status) { sql += " AND r.status = ?"; args.push(status); }
  if (driverId) { sql += " AND r.assigned_driver_id = ?"; args.push(driverId); }
  sql += " ORDER BY r.created_at DESC LIMIT ? OFFSET ?";
  args.push(limit, offset);

  const rows = await dbAll(client, sql, args);
  let countSql = "SELECT COUNT(*) as total FROM online_order_returns r WHERE 1=1";
  const countArgs = [];
  if (status) { countSql += " AND status = ?"; countArgs.push(status); }
  if (driverId) { countSql += " AND assigned_driver_id = ?"; countArgs.push(driverId); }
  const totalResult = await dbFirst(client, countSql, countArgs);
  const total = totalResult ? totalResult.total : 0;

  return jsonResponse({
    returns: rows,
    pagination: { current_page: page, page_size: limit, total_count: total, total_pages: Math.ceil(total / limit) }
  }, 200, headers);
}

async function getReturnDetails(request, env, headers) {
  const id = parseInt(request.url.split('/').pop());
  const client = getTursoClient(env);
  const returnRec = await dbFirst(client, `
    SELECT r.*, o.customer_name, o.customer_phone, d.name as driver_name,
           r.return_fee, r.return_fee_type
    FROM online_order_returns r
    JOIN online_orders o ON o.id = r.order_id
    LEFT JOIN drivers d ON d.id = r.assigned_driver_id
    WHERE r.id = ?
  `, [id]);
  if (!returnRec) return jsonResponse({ error: 'الإرجاع غير موجود' }, 404, headers);
  const items = await dbAll(client, "SELECT * FROM online_order_return_items WHERE return_id = ?", [id]);
  returnRec.items = items;
  return jsonResponse({ return: returnRec }, 200, headers);
}

async function adminConfirmReturn(request, env, ctx, headers) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const id = parseInt(parts[parts.length - 2], 10);
  const user = await getCurrentUser(request, env);
  const confirmedBy = user ? user.id : null;
  return await confirmReturn(id, confirmedBy, request, env, ctx, headers);
}

async function cancelReturn(request, env, headers) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const id = parseInt(parts[parts.length - 2], 10);
  const client = getTursoClient(env);
  const returnRec = await dbFirst(client, "SELECT id, status FROM online_order_returns WHERE id = ?", [id]);
  if (!returnRec) return jsonResponse({ error: 'الإرجاع غير موجود' }, 404, headers);
  if (returnRec.status !== 'pending') {
    return jsonResponse({ error: 'لا يمكن إلغاء إرجاع غير معلق' }, 400, headers);
  }
  await dbRun(client, "UPDATE online_order_returns SET status = 'cancelled' WHERE id = ?", [id]);
  return jsonResponse({ success: true, message: 'تم إلغاء طلب الإرجاع' }, 200, headers);
}

// ================================================================
//  دوال تسوية المندوب =================================
// ================================================================

async function recordDriverPayment(request, env, headers) {
  const {
    driver_id,
    amount,
    notes,
    currency_id,
    payment_method,
    wallet_id,
    cash_amount,
    wallet_amount
  } = await request.json();

  if (!driver_id || amount === undefined || amount === 0) {
    return jsonResponse({ error: 'بيانات غير صالحة' }, 400, headers);
  }

  const client = getTursoClient(env);
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) throw new Error('لا توجد عملة أساسية');

  const useCurrencyId = currency_id || baseCurrency.id;

  const accounts = await dbAll(client, "SELECT id, name FROM accounts");
  const accountsMap = Object.fromEntries(accounts.map(a => [a.name, a.id]));
  const getAccountIdFast = (name) => {
    if (!accountsMap[name]) throw new Error(`الحساب "${name}" غير موجود`);
    return accountsMap[name];
  };

  const currencies = await dbAll(client, "SELECT id, rate_to_base FROM currencies");
  const currenciesMap = Object.fromEntries(currencies.map(c => [c.id, c.rate_to_base]));
  const getCurrencyRateFast = (id) => {
    if (!currenciesMap[id]) throw new Error(`العملة ${id} غير موجودة`);
    return currenciesMap[id];
  };

  const absAmount = Math.abs(amount);
  const isDriverPaysShop = amount > 0;

  let finalCashAmount = 0, finalWalletAmount = 0;
  let finalWalletId = null;

  if (payment_method === 'cash') {
    finalCashAmount = absAmount;
    finalWalletAmount = 0;
  } else if (payment_method === 'wallet') {
    if (!wallet_id) return jsonResponse({ error: 'اختر المحفظة' }, 400, headers);
    finalCashAmount = 0;
    finalWalletAmount = absAmount;
    finalWalletId = wallet_id;
  } else if (payment_method === 'mixed') {
    finalCashAmount = parseFloat(cash_amount) || 0;
    finalWalletAmount = parseFloat(wallet_amount) || 0;
    if (finalCashAmount + finalWalletAmount === 0) {
      return jsonResponse({ error: 'المبلغ الإجمالي صفر في الدفع المختلط' }, 400, headers);
    }
    if (Math.abs(finalCashAmount + finalWalletAmount - absAmount) > 0.001) {
      const ratio = absAmount / (finalCashAmount + finalWalletAmount);
      finalCashAmount *= ratio;
      finalWalletAmount *= ratio;
    }
    if (finalWalletAmount > 0 && !wallet_id) {
      return jsonResponse({ error: 'اختر المحفظة للدفع المختلط' }, 400, headers);
    }
    finalWalletId = wallet_id || null;
  } else {
    finalCashAmount = absAmount;
  }

  const tx = await client.transaction();
  let committed = false;
  try {
    let account = await dbFirst(tx, "SELECT * FROM driver_accounts WHERE driver_id = ?", [driver_id]);
    if (!account) {
      await dbRun(tx,
        "INSERT INTO driver_accounts (driver_id, balance, total_deliveries, total_collected, total_fees, total_paid_to_shop) VALUES (?, 0, 0, 0, 0, 0)",
        [driver_id]
      );
    }

    const txResult = await dbRun(tx,
      `INSERT INTO driver_transactions (driver_id, type, amount, description, payment_method, wallet_id, cash_amount, wallet_amount)
       VALUES (?, 'settlement', ?, ?, ?, ?, ?, ?)`,
      [driver_id, amount, notes || `تسوية (${payment_method || 'cash'})`, payment_method || 'cash', finalWalletId, finalCashAmount, finalWalletAmount]
    );
    const transactionId = txResult.lastInsertRowid;

    await dbRun(tx,
      "UPDATE driver_accounts SET balance = balance - ?, last_settlement_date = CURRENT_TIMESTAMP WHERE driver_id = ?",
      [amount, driver_id]
    );

    const entryDate = new Date().toISOString().split('T')[0];
    const desc = `تسوية المندوب ${driver_id} (${isDriverPaysShop ? 'دفع' : 'استلام'})`;
    const cashAccountId = getAccountIdFast('الصندوق');
    const walletAccountId = getAccountIdFast('المحافظ');
    const driverReceivableId = getAccountIdFast('الذمم المدينة (مندوبين)');
    const driverExpenseAccountId = getAccountIdFast('أجور المندوبين');

    let journalDetails = [];

    if (finalCashAmount > 0.001) {
      const rate = getCurrencyRateFast(useCurrencyId);
      const baseAmount = finalCashAmount * rate;
      const cashType = isDriverPaysShop ? 'deposit' : 'withdraw';
      await dbRun(tx,
        "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES (?, ?, ?, ?, ?)",
        [cashType, finalCashAmount, useCurrencyId, rate, desc + ' (نقدي)']
      );
      if (isDriverPaysShop) {
        journalDetails.push({ account_id: cashAccountId, debit: baseAmount, credit: 0 });
        journalDetails.push({ account_id: driverReceivableId, debit: 0, credit: baseAmount });
      } else {
        journalDetails.push({ account_id: driverExpenseAccountId, debit: baseAmount, credit: 0 });
        journalDetails.push({ account_id: cashAccountId, debit: 0, credit: baseAmount });
      }
    }

    if (finalWalletAmount > 0.001 && finalWalletId) {
      const rate = getCurrencyRateFast(useCurrencyId);
      const baseAmount = finalWalletAmount * rate;

      if (isDriverPaysShop) {
        await dbRun(tx,
          "UPDATE wallet_balances SET balance = balance + ? WHERE wallet_id = ? AND currency_id = ?",
          [finalWalletAmount, finalWalletId, useCurrencyId]
        );
      } else {
        const bal = await dbFirst(tx,
          "SELECT balance FROM wallet_balances WHERE wallet_id = ? AND currency_id = ?",
          [finalWalletId, useCurrencyId]
        );
        if (!bal || bal.balance < finalWalletAmount) {
          throw new Error('رصيد غير كافٍ في المحفظة');
        }
        await dbRun(tx,
          "UPDATE wallet_balances SET balance = balance - ? WHERE wallet_id = ? AND currency_id = ?",
          [finalWalletAmount, finalWalletId, useCurrencyId]
        );
      }

      await dbRun(tx,
        `INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [finalWalletId, isDriverPaysShop ? 'deposit' : 'withdraw', finalWalletAmount, useCurrencyId, desc + ' (محفظة)', transactionId]
      );

      if (isDriverPaysShop) {
        journalDetails.push({ account_id: walletAccountId, debit: baseAmount, credit: 0 });
        journalDetails.push({ account_id: driverReceivableId, debit: 0, credit: baseAmount });
      } else {
        journalDetails.push({ account_id: driverExpenseAccountId, debit: baseAmount, credit: 0 });
        journalDetails.push({ account_id: walletAccountId, debit: 0, credit: baseAmount });
      }
    }

    if (journalDetails.length > 0) {
      checkBalance(journalDetails);
      await createJournalEntry(tx, entryDate, desc, journalDetails, 'driver_settlement', transactionId);
    }

    await tx.commit();
    committed = true;

    try {
      const updated = await dbFirst(client, "SELECT balance FROM driver_accounts WHERE driver_id = ?", [driver_id]);
      return jsonResponse({
        success: true,
        new_balance: updated ? updated.balance : 0,
        transaction_id: transactionId,
        cash_amount: finalCashAmount,
        wallet_amount: finalWalletAmount
      }, 200, headers);
    } catch (postCommitError) {
      console.error('نجحت تسوية المندوب لكن تعذر جلب الرصيد الجديد:', postCommitError.message);
      return jsonResponse({ success: true, transaction_id: transactionId,
        cash_amount: finalCashAmount, wallet_amount: finalWalletAmount,
        warning: 'تم حفظ التسوية، لكن تعذر جلب الرصيد الجديد' }, 200, headers);
    }

  } catch (error) {
    if (committed) {
      return jsonResponse({ success: true,
        warning: 'تم حفظ التسوية، لكن حدث خطأ بعد commit' }, 200, headers);
    }
    try { await tx.rollback(); } catch (rollbackError) { console.error('فشل rollback:', rollbackError.message); }
    return jsonResponse({ error: error.message }, 400, headers);
  }
}

// ================================================================
//  دوال المندوب (الإرجاع وإنشاء طلب إرجاع معلق) =====================
// ================================================================

async function driverReturnItems(request, env, headers) {
  try {
    const {
      order_id,
      items,
      refund_method,
      wallet_id,
      cash_refund,
      wallet_refund,
      return_fee = 0,
      return_fee_type = 'customer',
      return_driver_id = null
    } = await request.json();

    if (!order_id || !items || !Array.isArray(items) || items.length === 0) {
      return jsonResponse({ error: 'بيانات غير صالحة: يجب تحديد الطلب ومنتج واحد على الأقل' }, 400, headers);
    }
    for (const item of items) {
      if (!item.order_item_id || !item.quantity || item.quantity <= 0) {
        return jsonResponse({ error: 'بيانات العنصر غير صالحة' }, 400, headers);
      }
    }

    const client = getTursoClient(env);
    const baseCurrency = await getBaseCurrency(client);
    if (!baseCurrency) return jsonResponse({ error: 'لا توجد عملة أساسية' }, 400, headers);

    const order = await dbFirst(client, "SELECT * FROM online_orders WHERE id = ?", [order_id]);
    if (!order) return jsonResponse({ error: 'الطلب غير موجود' }, 404, headers);

    const allowedStatuses = ['تم التسليم', 'مرتجع جزئي'];
    if (!allowedStatuses.includes(order.status)) {
      return jsonResponse({ error: `لا يمكن إرجاع طلب بحالة "${order.status}"` }, 400, headers);
    }

    let sale = null;
    if (order.accounting_invoice_id) {
      sale = await dbFirst(client, "SELECT * FROM sales WHERE id = ?", [order.accounting_invoice_id]);
      if (!sale) return jsonResponse({ error: 'الفاتورة المحاسبية غير موجودة' }, 404, headers);
      if (sale.status === 'cancelled' || sale.status === 'fully_returned') {
        return jsonResponse({ error: 'لا يمكن الإرجاع على فاتورة ملغاة أو مرتجعة بالكامل' }, 400, headers);
      }
    } else {
      return jsonResponse({ error: 'لا توجد فاتورة محاسبية مرتبطة بالطلب' }, 400, headers);
    }

    const orderItems = await dbAll(client, "SELECT * FROM online_order_items WHERE order_id = ?", [order_id]);
    if (orderItems.length === 0) return jsonResponse({ error: 'الطلب لا يحتوي على منتجات' }, 400, headers);

    const previousReturns = await dbAll(client, `
      SELECT ori.order_item_id, SUM(ori.quantity) as returned_qty
      FROM online_order_return_items ori
      JOIN online_order_returns oret ON oret.id = ori.return_id
      WHERE oret.order_id = ? AND oret.status = 'completed'
      GROUP BY ori.order_item_id
    `, [order_id]);
    const returnedMap = {};
    for (const r of previousReturns) {
      returnedMap[r.order_item_id] = r.returned_qty;
    }

    const pendingReturns = await dbAll(client, `
      SELECT ori.order_item_id, SUM(ori.quantity) as pending_qty
      FROM online_order_return_items ori
      JOIN online_order_returns oret ON oret.id = ori.return_id
      WHERE oret.order_id = ? AND oret.status = 'pending'
      GROUP BY ori.order_item_id
    `, [order_id]);
    const pendingMap = {};
    for (const pr of pendingReturns) {
      pendingMap[pr.order_item_id] = pr.pending_qty;
    }

    const returnItemsData = [];
    let totalItemsPrice = 0;

    for (const reqItem of items) {
      const orderItem = orderItems.find(oi => oi.id === reqItem.order_item_id);
      if (!orderItem) {
        return jsonResponse({ error: `عنصر الطلب ${reqItem.order_item_id} غير موجود` }, 400, headers);
      }

      if (reqItem.quantity !== orderItem.quantity) {
        return jsonResponse({
          error: `الإرجاع مسموح فقط بالكمية الكاملة للمنتج "${orderItem.product_name}". الكمية المشتراة: ${orderItem.quantity}`
        }, 400, headers);
      }

      const alreadyReturned = (returnedMap[reqItem.order_item_id] || 0) + (pendingMap[reqItem.order_item_id] || 0);
      if (alreadyReturned > 0) {
        return jsonResponse({
          error: `تم إرجاع المنتج "${orderItem.product_name}" مسبقاً`
        }, 400, headers);
      }

      const lineTotal = reqItem.quantity * orderItem.unit_price;
      totalItemsPrice += lineTotal;
      returnItemsData.push({
        order_item_id: orderItem.id,
        product_id: orderItem.product_id,
        quantity: reqItem.quantity,
        unit_price: orderItem.unit_price,
        line_total: lineTotal
      });
    }

    if (returnItemsData.length === 0) {
      return jsonResponse({ error: 'لم يتم تحديد أي عناصر صالحة للإرجاع' }, 400, headers);
    }

    const actualRefundMethod = refund_method || 'cash';
    if (!['cash', 'wallet', 'mixed'].includes(actualRefundMethod)) {
      return jsonResponse({ error: 'طريقة الاسترداد غير مدعومة' }, 400, headers);
    }

    let netRefund = totalItemsPrice;
    if (return_fee_type === 'customer') {
      netRefund = Math.max(0, totalItemsPrice - return_fee);
    } else {
      netRefund = totalItemsPrice;
    }

    let refundCash = parseFloat(cash_refund) || 0;
    let refundWallet = parseFloat(wallet_refund) || 0;
    
    if (actualRefundMethod === 'cash') {
      refundCash = netRefund;
      refundWallet = 0;
    } else if (actualRefundMethod === 'wallet') {
      if (!wallet_id) return jsonResponse({ error: 'يجب تحديد المحفظة للإرجاع عبر المحفظة' }, 400, headers);
      const wallet = await dbFirst(client, "SELECT id FROM wallets WHERE id = ?", [wallet_id]);
      if (!wallet) return jsonResponse({ error: 'المحفظة غير موجودة' }, 400, headers);
      refundCash = 0;
      refundWallet = netRefund;
    } else if (actualRefundMethod === 'mixed') {
      if (refundCash === 0 && refundWallet === 0) {
        // إصلاح #10: الطلب المختلط — التوزيع الافتراضي بنسبة المدفوعات الأصلية من الفاتورة، لا مناصفة
        if (isMixedOrder(order) && sale) {
          const originalTotalPaid = (parseFloat(sale.cash_paid) || 0) + (parseFloat(sale.wallet_paid) || 0);
          if (originalTotalPaid > 0) {
            refundCash = netRefund * (parseFloat(sale.cash_paid) / originalTotalPaid);
            refundWallet = netRefund * (parseFloat(sale.wallet_paid) / originalTotalPaid);
          } else {
            refundCash = netRefund;
          }
        } else {
          refundCash = netRefund / 2;
          refundWallet = netRefund / 2;
        }
      }
      const totalPaid = refundCash + refundWallet;
      if (Math.abs(totalPaid - netRefund) > 0.001) {
        const ratio = netRefund / totalPaid;
        refundCash *= ratio;
        refundWallet *= ratio;
      }
      if (refundWallet > 0 && !wallet_id) {
        return jsonResponse({ error: 'يجب تحديد المحفظة للإرجاع المختلط' }, 400, headers);
      }
      if (refundWallet > 0) {
        const wallet = await dbFirst(client, "SELECT id FROM wallets WHERE id = ?", [wallet_id]);
        if (!wallet) return jsonResponse({ error: 'المحفظة غير موجودة' }, 400, headers);
      }
    }

    let assignedDriverId = return_driver_id ? parseInt(return_driver_id) : order.assigned_driver_id;
    if (assignedDriverId) {
      const driver = await dbFirst(client, "SELECT id FROM drivers WHERE id = ? AND is_active = 1", [assignedDriverId]);
      if (!driver) {
        return jsonResponse({ error: 'المندوب غير موجود أو غير نشط' }, 400, headers);
      }
    }

    const tx = await client.transaction();
    try {
      const returnResult = await dbRun(tx,
        `INSERT INTO online_order_returns 
          (order_id, reason, total_refund, refund_method, wallet_id, 
           status, assigned_driver_id, return_fee, return_fee_type,
           cash_refund, wallet_refund)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        [
          order_id,
          'إرجاع بواسطة المندوب (معلق)',
          netRefund,
          actualRefundMethod,
          (actualRefundMethod === 'wallet' || actualRefundMethod === 'mixed') ? wallet_id : null,
          assignedDriverId,
          return_fee,
          return_fee_type,
          refundCash,
          refundWallet
        ]
      );
      const returnId = returnResult.lastInsertRowid;

      const batchQueries = [];
      for (const ri of returnItemsData) {
        batchQueries.push({
          sql: `INSERT INTO online_order_return_items 
                (return_id, order_item_id, product_id, quantity, unit_price, line_total)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [returnId, ri.order_item_id, ri.product_id, ri.quantity, ri.unit_price, ri.line_total]
        });
      }

      if (order.status !== 'مرتجع جزئي') {
        batchQueries.push({
          sql: "UPDATE online_orders SET status = ? WHERE id = ?",
          args: ['مرتجع جزئي', order_id]
        });
      }

      batchQueries.push({
        sql: "INSERT INTO order_status_log (order_id, old_status, new_status, status, notes) VALUES (?, ?, ?, ?, ?)",
        args: [order_id, order.status, 'مرتجع جزئي (معلق)', 'مرتجع جزئي (معلق)', `طلب إرجاع #${returnId} في انتظار التأكيد`]
      });

      await tx.batch(batchQueries, 'write');
      await tx.commit();

      return jsonResponse({
        success: true,
        return_id: returnId,
        total_refund: netRefund,
        refund_cash: refundCash,
        refund_wallet: refundWallet,
        refund_method: actualRefundMethod,
        status: 'pending',
        message: 'تم إنشاء طلب الإرجاع بنجاح، في انتظار التأكيد.'
      }, 200, headers);

    } catch (error) {
      await tx.rollback();
      console.error('Transaction error in driverReturnItems:', error);
      throw error;
    }
  } catch (error) {
    console.error('خطأ في driverReturnItems:', error);
    return jsonResponse({ error: error.message || 'فشل إنشاء طلب الإرجاع' }, 400, headers);
  }
}

// ---- المبيعات (معدلة) ----
async function createSale(request, env, ctx, headers, userId) {
  const { customer_id, items, payment_method, wallet_id, discount = 0, discount_type = 'fixed',
    cash_amount = 0, cash_currency_id = null, wallet_amount = 0, wallet_currency_id = null, note = '' } = await request.json();
  if (!items || items.length === 0) return jsonResponse({ error: 'السلة فارغة' }, 400, headers); // قبل بدء المعاملة — آمن، لا تسريب

  const client = getTursoClient(env);
  await checkIfClosed(client, new Date().toISOString().slice(0, 10));
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) throw new Error('لا توجد عملة أساسية');

  const useCashCurrencyId = cash_currency_id || baseCurrency.id;
  const useWalletCurrencyId = wallet_currency_id || baseCurrency.id;

  const tx = await client.transaction();
  let committed = false;
  try {
    const settings = await getSettingsCached(tx);
    const allowBelowCost = settings.allow_below_cost === '1';
    const allowNegativeStock = settings.allow_negative_stock === '1';
    const allowExpiredNegativeSales = settings.allow_expired_negative_sales !== '0';

    const accounts = await dbAll(tx, "SELECT id, name FROM accounts");
    const accountsMap = Object.fromEntries(accounts.map(a => [a.name, a.id]));
    const currencies = await dbAll(tx, "SELECT id, rate_to_base FROM currencies");
    const currenciesMap = Object.fromEntries(currencies.map(c => [c.id, c.rate_to_base]));

    const getAccountIdFast = (name) => {
      if (!accountsMap[name]) throw new Error(`الحساب "${name}" غير موجود`);
      return accountsMap[name];
    };
    const getCurrencyRateFast = (id) => {
      if (!currenciesMap[id]) throw new Error(`العملة ${id} غير موجودة`);
      return currenciesMap[id];
    };

    const cashAccountId = getAccountIdFast('الصندوق');
    const walletAccountId = getAccountIdFast('المحافظ');
    const saleAccountId = getAccountIdFast('المبيعات');
    const cogsAccountId = getAccountIdFast('تكلفة البضاعة المباعة');
    const customerAccountId = getAccountIdFast('الذمم المدينة (عملاء)');
    const inventoryAccountId = getAccountIdFast('المخزون');

    let total = 0;
    const saleItemsData = items.map(item => {
      const price = item.unit_price || 0;
      const qty = item.quantity || 0;
      const itemTotal = price * qty;
      total += itemTotal;
      return { ...item, total_price: itemTotal };
    });

    let discountAmount = discount_type === 'percentage' ? total * (discount / 100) : discount;
    let totalAfterDiscount = total - discountAmount;
    if (totalAfterDiscount < 0) totalAfterDiscount = 0;

    let finalCashPaid = cash_amount || 0;
    let finalWalletPaid = wallet_amount || 0;

    if (payment_method === 'cash') {
      const cashRate = getCurrencyRateFast(useCashCurrencyId);
      finalCashPaid = convertFromBase(totalAfterDiscount, cashRate);
      finalWalletPaid = 0;
    } else if (payment_method === 'wallet') {
      const walletRate = getCurrencyRateFast(useWalletCurrencyId);
      finalWalletPaid = convertFromBase(totalAfterDiscount, walletRate);
      finalCashPaid = 0;
    } else if (payment_method === 'mixed') {
      const cashRate = getCurrencyRateFast(useCashCurrencyId);
      const walletRate = getCurrencyRateFast(useWalletCurrencyId);
      const validCashAmount = parseFloat(cash_amount) || 0;
      const validWalletAmount = parseFloat(wallet_amount) || 0;
      const cashBase = convertToBase(validCashAmount, cashRate);
      const walletBase = convertToBase(validWalletAmount, walletRate);
      const totalPaidBase = cashBase + walletBase;
      if (Math.abs(totalPaidBase - totalAfterDiscount) > 0.001) {
        if (totalPaidBase === 0) throw new Error('المبالغ المدفوعة صفر!');
        const ratio = totalAfterDiscount / totalPaidBase;
        finalCashPaid = validCashAmount * ratio;
        finalWalletPaid = validWalletAmount * ratio;
      } else { finalCashPaid = validCashAmount; finalWalletPaid = validWalletAmount; }
    }

    if (payment_method === 'wallet' && !wallet_id) throw new Error('اختر المحفظة');
    if (payment_method === 'credit' && !customer_id) throw new Error('يجب تحديد العميل للبيع الآجل');

    const productIds = saleItemsData.map(item => item.product_id).filter(id => id);
    let productsMap = {};
    if (productIds.length) {
      const productRows = await dbAll(tx, `SELECT id, stock_quantity, cost, expiry_date, unit_type, unit_symbol, is_decimal_allowed, weight_grams FROM products WHERE id IN (${productIds.join(',')})`);
      productsMap = productRows.reduce((acc, p) => { acc[p.id] = p; return acc; }, {});
    }

    let allSupplierStocks = [];
    if (productIds.length) {
      allSupplierStocks = await dbAll(tx, `
        SELECT product_id, id, quantity, supplier_id, last_purchase_price
        FROM product_supplier_stock
        WHERE product_id IN (${productIds.join(',')}) AND quantity > 0
        ORDER BY product_id, id ASC
      `);
    }

    const stockMap = {};
    for (const stock of allSupplierStocks) {
      if (!stockMap[stock.product_id]) stockMap[stock.product_id] = [];
      stockMap[stock.product_id].push(stock);
    }

    for (const item of saleItemsData) {
      const product = productsMap[item.product_id];
      if (!product) throw new Error(`المنتج رقم ${item.product_id} غير موجود`);
      // ===== إصلاح #7: رمي الخطأ بدل return مباشرة حتى يُنفَّذ tx.rollback() في catch =====
      if (!allowBelowCost && item.unit_price < product.cost) {
        throw new Error(`سعر البيع أقل من التكلفة للمنتج ${item.product_id}`);
      }
      const expiredNegativeAllowed = allowExpiredNegativeSales && isExpiredProductDate(product.expiry_date);
      if (!allowNegativeStock && !expiredNegativeAllowed && product.stock_quantity < item.quantity) {
        throw new Error(`الكمية غير كافية للمنتج ${item.product_id}`);
      }
    }

    const invoiceNumber = `INV-${await getNextInvoiceNumber(tx, 'sales')}`;
    const saleResult = await dbRun(tx,
      `INSERT INTO sales (invoice_number, customer_id, total_amount, discount, discount_type, payment_method, cash_paid, wallet_paid, wallet_id, paid_amount, status, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)`,
      [invoiceNumber, customer_id || null, totalAfterDiscount, discountAmount, discount_type, payment_method, finalCashPaid, finalWalletPaid, wallet_id || null, totalAfterDiscount, note]
    );
    const saleId = saleResult.lastInsertRowid;

    // ========== جلب كميات المخزون دفعة واحدة ==========
    const stockCache = {};
    if (productIds.length) {
      const stockRows = await dbAll(tx, 
        `SELECT id, stock_quantity FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`,
        productIds
      );
      stockRows.forEach(row => {
        stockCache[row.id] = parseFloat(row.stock_quantity) || 0;
      });
    }

    const batchQueries = [];
    let totalCost = 0;

    for (const item of saleItemsData) {
      const product = productsMap[item.product_id];
      if (!product) throw new Error(`المنتج غير موجود`);
      const costPrice = product.cost || 0;
      totalCost += costPrice * item.quantity;

      const stocks = stockMap[item.product_id] || [];
      let remaining = item.quantity;
      let supplierId = null;
      let supplierPrice = costPrice;
      const updateStockQueries = [];

      for (const stock of stocks) {
        if (remaining <= 0) break;
        const deductQty = Math.min(stock.quantity, remaining);
        updateStockQueries.push({
          sql: "UPDATE product_supplier_stock SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          args: [deductQty, stock.id]
        });
        if (!supplierId) {
          supplierId = stock.supplier_id;
          supplierPrice = stock.last_purchase_price || costPrice;
        }
        remaining -= deductQty;
      }

      if (remaining > 0 && !allowNegativeStock) {
        throw new Error(`الكمية غير كافية للمنتج ${item.product_id} في مخزون الموردين`);
      }

      batchQueries.push(...updateStockQueries);

      await applyStockChange(tx, batchQueries, {
        productId: item.product_id,
        supplierId,
        delta: -item.quantity,
        referenceType: 'sale',
        referenceId: saleId,
        note: `فاتورة مبيعات #${invoiceNumber}`,
        userId,
        stockCache
      });

      batchQueries.push({
        sql: `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total_price, cost_price, supplier_id, supplier_price)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [saleId, item.product_id, item.quantity, item.unit_price, item.total_price, costPrice, supplierId, supplierPrice]
      });
    }

    // ========== إضافة باقي الاستعلامات (المحاسبة، الصندوق، المحفظة، العملاء) ==========
    const entryDate = new Date().toISOString().split('T')[0];
    const desc = `فاتورة مبيعات #${invoiceNumber}`;
    const journalDetails = [];

    if (payment_method === 'cash' || payment_method === 'mixed') {
      let cashPaid = finalCashPaid;
      if (cashPaid > 0) {
        const rate = getCurrencyRateFast(useCashCurrencyId);
        const baseAmount = convertToBase(cashPaid, rate);
        batchQueries.push({
          sql: "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES ('deposit', ?, ?, ?, ?)",
          args: [cashPaid, useCashCurrencyId, rate, `إيراد ${invoiceNumber}`]
        });
        journalDetails.push({ account_id: cashAccountId, debit: baseAmount, credit: 0 });
      }
    }

    if (payment_method === 'wallet' || payment_method === 'mixed') {
      let walletPaid = finalWalletPaid;
      if (walletPaid > 0 && wallet_id) {
        const rate = getCurrencyRateFast(useWalletCurrencyId);
        const baseAmount = convertToBase(walletPaid, rate);
        batchQueries.push({
          sql: `UPDATE wallet_balances SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = ? AND currency_id = ?`,
          args: [walletPaid, wallet_id, useWalletCurrencyId]
        });
        batchQueries.push({
          sql: "INSERT OR IGNORE INTO wallet_balances (wallet_id, currency_id, balance) VALUES (?, ?, 0)",
          args: [wallet_id, useWalletCurrencyId]
        });
        batchQueries.push({
          sql: "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'deposit', ?, ?, ?, ?)",
          args: [wallet_id, walletPaid, useWalletCurrencyId, `إيداع ${invoiceNumber}`, saleId]
        });
        journalDetails.push({ account_id: walletAccountId, debit: baseAmount, credit: 0 });
      }
    }

    if (payment_method === 'credit') {
      batchQueries.push({
        sql: "UPDATE customers SET balance = balance + ? WHERE id = ?",
        args: [totalAfterDiscount, customer_id]
      });
      journalDetails.push({ account_id: customerAccountId, debit: totalAfterDiscount, credit: 0 });
    }

    journalDetails.push({ account_id: saleAccountId, debit: 0, credit: totalAfterDiscount });

    if (journalDetails.length > 0) {
      checkBalance(journalDetails);
      await createJournalEntry(tx, entryDate, desc, journalDetails, 'sale', saleId);
    }

    if (totalCost > 0) {
      const cogsDetails = [
        { account_id: cogsAccountId, debit: totalCost, credit: 0 },
        { account_id: inventoryAccountId, debit: 0, credit: totalCost }
      ];
      await createJournalEntry(tx, entryDate, `تكلفة ${desc}`, cogsDetails, 'sale_cogs', saleId);
    }

    const profit = totalAfterDiscount - totalCost;
    batchQueries.push({
      sql: "UPDATE sales SET profit = ?, total_cost = ? WHERE id = ?",
      args: [profit, totalCost, saleId]
    });

    // ========== تنفيذ الدفعات على أجزاء لتجنب تجاوز حد الطلبات الفرعية ==========
    // الحد الآمن: 40 استعلام لكل دفعة (لحسابات مجانية حد 50)
    const BATCH_SIZE = 40;
    for (let i = 0; i < batchQueries.length; i += BATCH_SIZE) {
      const chunk = batchQueries.slice(i, i + BATCH_SIZE);
      await tx.batch(chunk, 'write');
    }

    await tx.commit();
    committed = true;

    try {
      const saleData = await dbFirst(client, `
        SELECT s.*, c.name as customer_name
        FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?
      `, [saleId]);
      const itemsData = await dbAll(client, `
        SELECT si.*, p.name as product_name
        FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = ?
      `, [saleId]);
      let walletName = null;
      if (wallet_id) { const w = await dbFirst(client, "SELECT name FROM wallets WHERE id = ?", [wallet_id]); walletName = w ? w.name : null; }
      const invoiceResponse = {
        id: saleData.id, invoice_number: saleData.invoice_number, created_at: saleData.created_at,
        payment_method: saleData.payment_method, customer_name: saleData.customer_name || 'نقدي',
        total_amount: saleData.total_amount, discount: saleData.discount, discount_type: saleData.discount_type,
        cash_paid: saleData.cash_paid, wallet_paid: saleData.wallet_paid, wallet_id: saleData.wallet_id,
        wallet_name: walletName, profit: saleData.profit,
        items: itemsData.map(item => ({ product_id: item.product_id, product_name: item.product_name,
          quantity: item.quantity, unit_price: item.unit_price, total_price: item.total_price, cost_price: item.cost_price,
          supplier_id: item.supplier_id, supplier_price: item.supplier_price }))
      };
      return jsonResponse({ success: true, invoice: invoiceResponse }, 200, headers);
    } catch (postCommitError) {
      console.error('نجح حفظ البيع لكن تعذر جلب بيانات الفاتورة:', postCommitError.message);
      return jsonResponse({ success: true, sale_id: saleId, invoice: null,
        warning: 'تم حفظ البيع، لكن تعذر جلب بيانات الفاتورة' }, 200, headers);
    }
  } catch (error) {
    if (committed) {
      return jsonResponse({ success: true, invoice: null,
        warning: 'تم حفظ البيع، لكن حدث خطأ بعد commit' }, 200, headers);
    }
    try { await tx.rollback(); } catch (rollbackError) { console.error('فشل rollback:', rollbackError.message); }
    return jsonResponse({ error: error.message }, 400, headers);
  }
}

async function getSales(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT s.*, c.name as customer_name, w.name as wallet_name,
      (SELECT GROUP_CONCAT(p.product_code) FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = s.id) as product_codes,
      (SELECT SUM(total_price) FROM sale_items WHERE sale_id = s.id) as subtotal
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN wallets w ON w.id = s.wallet_id
    ORDER BY s.created_at DESC LIMIT 100
  `);
  return jsonResponse({ sales: rows }, 200, headers);
}
async function getSaleDetails(request, env, headers) {
  const id = parseInt(request.url.split('/').pop());
  const client = getTursoClient(env);
  const sale = await dbFirst(client,
    `SELECT s.*, c.name as customer_name, w.name as wallet_name
     FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN wallets w ON w.id = s.wallet_id
     WHERE s.id = ?`,
    [id]
  );
  if (!sale) return jsonResponse({ error: 'الفاتورة غير موجودة' }, 404, headers);
  const items = await dbAll(client,
    `SELECT si.*, p.name as product_name, p.product_code
     FROM sale_items si JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ?`,
    [id]
  );
  sale.items = items;
  return jsonResponse(sale, 200, headers);
}

async function updateSale(request, env, headers, userId) {
  const id = parseInt(request.url.split('/').pop());
  const { customer_id, items, payment_method, wallet_id, discount = 0, discount_type = 'fixed',
    cash_amount = 0, cash_currency_id = null, wallet_amount = 0, wallet_currency_id = null, note = '' } = await request.json();
  const client = getTursoClient(env);
  await checkIfClosed(client, new Date().toISOString().slice(0, 10));
  const oldSale = await dbFirst(client, "SELECT * FROM sales WHERE id = ? AND status = 'completed'", [id]);
  if (!oldSale) return jsonResponse({ error: 'الفاتورة غير موجودة أو ملغاة' }, 404, headers);
  if (!items || items.length === 0) return jsonResponse({ error: 'السلة فارغة' }, 400, headers);

  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) throw new Error('لا توجد عملة أساسية');
  const useCashCurrencyId = cash_currency_id || baseCurrency.id;
  const useWalletCurrencyId = wallet_currency_id || baseCurrency.id;

  const accounts = await dbAll(client, "SELECT id, name FROM accounts");
  const accountsMap = Object.fromEntries(accounts.map(a => [a.name, a.id]));
  const getAccountIdFast = (name) => {
    if (!accountsMap[name]) throw new Error(`الحساب "${name}" غير موجود`);
    return accountsMap[name];
  };
  const currencies = await dbAll(client, "SELECT id, rate_to_base FROM currencies");
  const currenciesMap = Object.fromEntries(currencies.map(c => [c.id, c.rate_to_base]));
  const getCurrencyRateFast = (id) => {
    if (!currenciesMap[id]) throw new Error(`العملة ${id} غير موجودة`);
    return currenciesMap[id];
  };

  const tx = await client.transaction();
  let committed = false;
  try {
    const settings = await getSettingsCached(tx);
    const allowBelowCost = settings.allow_below_cost === '1';
    const allowNegativeStock = settings.allow_negative_stock === '1';
    const allowExpiredNegativeSales = settings.allow_expired_negative_sales !== '0';

    // ===== 1. استرجاع المخزون القديم =====
    const oldItems = await dbAll(tx, "SELECT * FROM sale_items WHERE sale_id = ?", [id]);
    let oldTotalCost = 0;
    const oldProductIds = oldItems.map(item => item.product_id);
    
    // جلب كميات المخزون الحالية دفعة واحدة للاسترجاع
    const stockCacheRestore = {};
    if (oldProductIds.length) {
      const stockRows = await dbAll(tx,
        `SELECT id, stock_quantity FROM products WHERE id IN (${oldProductIds.map(() => '?').join(',')})`,
        oldProductIds
      );
      stockRows.forEach(row => {
        stockCacheRestore[row.id] = parseFloat(row.stock_quantity) || 0;
      });
    }

    const restoreQueries = [];
    for (const item of oldItems) {
      oldTotalCost += item.cost_price * item.quantity;
      await applyStockChange(tx, restoreQueries, {
        productId: item.product_id,
        supplierId: item.supplier_id || null,
        delta: item.quantity,
        referenceType: 'sale_update_revert',
        referenceId: id,
        note: `عكس فاتورة #${oldSale.invoice_number} قبل التعديل`,
        userId,
        stockCache: stockCacheRestore
      });
    }
    if (restoreQueries.length > 0) {
      await tx.batch(restoreQueries, 'write');
    }

    // ===== 2. حساب البيانات الجديدة =====
    let total = 0;
    const newItemsData = items.map(item => {
      const price = item.unit_price || 0;
      const qty = item.quantity || 0;
      const itemTotal = price * qty;
      total += itemTotal;
      return { ...item, total_price: itemTotal };
    });
    let discountAmount = discount_type === 'percentage' ? total * (discount / 100) : discount;
    let totalAfterDiscount = total - discountAmount;
    if (totalAfterDiscount < 0) totalAfterDiscount = 0;

    let finalCashPaid = cash_amount || 0;
    let finalWalletPaid = wallet_amount || 0;
    if (payment_method === 'cash') {
      const cashRate = getCurrencyRateFast(useCashCurrencyId);
      finalCashPaid = convertFromBase(totalAfterDiscount, cashRate);
      finalWalletPaid = 0;
    } else if (payment_method === 'wallet') {
      const walletRate = getCurrencyRateFast(useWalletCurrencyId);
      finalWalletPaid = convertFromBase(totalAfterDiscount, walletRate);
      finalCashPaid = 0;
    } else if (payment_method === 'mixed') {
      const cashRate = getCurrencyRateFast(useCashCurrencyId);
      const walletRate = getCurrencyRateFast(useWalletCurrencyId);
      const validCashAmount = parseFloat(cash_amount) || 0;
      const validWalletAmount = parseFloat(wallet_amount) || 0;
      const cashBase = convertToBase(validCashAmount, cashRate);
      const walletBase = convertToBase(validWalletAmount, walletRate);
      const totalPaidBase = cashBase + walletBase;
      if (Math.abs(totalPaidBase - totalAfterDiscount) > 0.001) {
        if (totalPaidBase === 0) throw new Error('المبالغ المدفوعة صفر!');
        const ratio = totalAfterDiscount / totalPaidBase;
        finalCashPaid = validCashAmount * ratio;
        finalWalletPaid = validWalletAmount * ratio;
      } else { finalCashPaid = validCashAmount; finalWalletPaid = validWalletAmount; }
    }
    if (payment_method === 'wallet' && !wallet_id) throw new Error('اختر المحفظة');
    if (payment_method === 'credit' && !customer_id) throw new Error('يجب تحديد العميل للبيع الآجل');

    // ===== 3. تجهيز البيانات الجديدة =====
    const newProductIds = newItemsData.map(item => item.product_id).filter(id => id);
    let productsMap = {};
    if (newProductIds.length) {
      const productRows = await dbAll(tx, `SELECT id, stock_quantity, cost, expiry_date FROM products WHERE id IN (${newProductIds.join(',')})`);
      productsMap = productRows.reduce((acc, p) => { acc[p.id] = p; return acc; }, {});
    }

    let newSupplierStocks = [];
    if (newProductIds.length) {
      newSupplierStocks = await dbAll(tx, `
        SELECT product_id, id, quantity, supplier_id, last_purchase_price
        FROM product_supplier_stock
        WHERE product_id IN (${newProductIds.join(',')}) AND quantity > 0
        ORDER BY product_id, id ASC
      `);
    }
    const newStockMap = {};
    for (const stock of newSupplierStocks) {
      if (!newStockMap[stock.product_id]) newStockMap[stock.product_id] = [];
      newStockMap[stock.product_id].push(stock);
    }

    for (const item of newItemsData) {
      const product = productsMap[item.product_id];
      if (!product) throw new Error(`المنتج ${item.product_id} غير موجود`);
      if (!allowBelowCost && item.unit_price < product.cost) {
        throw new Error(`سعر البيع أقل من التكلفة للمنتج ${item.product_id}`);
      }
      const expiredNegativeAllowed = allowExpiredNegativeSales && isExpiredProductDate(product.expiry_date);
      if (!allowNegativeStock && !expiredNegativeAllowed && product.stock_quantity < item.quantity) {
        throw new Error(`الكمية غير كافية للمنتج ${item.product_id}`);
      }
    }

    // ===== 4. جلب كميات المخزون دفعة واحدة للخصم الجديد =====
    const stockCacheNew = {};
    if (newProductIds.length) {
      const stockRows = await dbAll(tx,
        `SELECT id, stock_quantity FROM products WHERE id IN (${newProductIds.map(() => '?').join(',')})`,
        newProductIds
      );
      stockRows.forEach(row => {
        stockCacheNew[row.id] = parseFloat(row.stock_quantity) || 0;
      });
    }

    const newBatchQueries = [];
    let newTotalCost = 0;

    // ===== 5. حذف العناصر القديمة وإدراج الجديدة =====
    newBatchQueries.push({
      sql: "DELETE FROM sale_items WHERE sale_id = ?",
      args: [id]
    });

    for (const item of newItemsData) {
      const product = productsMap[item.product_id];
      const costPrice = product?.cost || 0;
      newTotalCost += costPrice * item.quantity;

      const stocks = newStockMap[item.product_id] || [];
      let remaining = item.quantity;
      let supplierId = null;
      let supplierPrice = costPrice;
      const updateStockQueries = [];

      for (const stock of stocks) {
        if (remaining <= 0) break;
        const deductQty = Math.min(stock.quantity, remaining);
        updateStockQueries.push({
          sql: "UPDATE product_supplier_stock SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          args: [deductQty, stock.id]
        });
        if (!supplierId) {
          supplierId = stock.supplier_id;
          supplierPrice = stock.last_purchase_price || costPrice;
        }
        remaining -= deductQty;
      }

      if (remaining > 0 && !allowNegativeStock) {
        throw new Error(`الكمية غير كافية للمنتج ${item.product_id}`);
      }

      newBatchQueries.push(...updateStockQueries);

      await applyStockChange(tx, newBatchQueries, {
        productId: item.product_id,
        supplierId,
        delta: -item.quantity,
        referenceType: 'sale_update',
        referenceId: id,
        note: `تحديث فاتورة #${oldSale.invoice_number}`,
        userId,
        stockCache: stockCacheNew
      });

      newBatchQueries.push({
        sql: "INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total_price, cost_price, supplier_id, supplier_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        args: [id, item.product_id, item.quantity, item.unit_price, item.total_price, costPrice, supplierId, supplierPrice]
      });
    }

    // ===== 6. معالجة المدفوعات القديمة =====
    const oldPaymentMethod = oldSale.payment_method;
    const oldTotal = oldSale.total_amount;
    let oldCashPaid = oldSale.cash_paid ?? 0;
    let oldWalletPaid = oldSale.wallet_paid ?? 0;
    if (oldPaymentMethod === 'cash' && oldCashPaid === 0) oldCashPaid = oldTotal;
    if (oldPaymentMethod === 'wallet' && oldWalletPaid === 0) oldWalletPaid = oldTotal;
    const oldWalletId = oldSale.wallet_id;
    const oldCustomerId = oldSale.customer_id;

    const oldCashEntry = await dbFirst(tx,
      "SELECT currency_id, exchange_rate FROM cash_register WHERE note LIKE ? ORDER BY created_at DESC LIMIT 1",
      [`%${oldSale.invoice_number}%`]
    );
    const oldWalletEntry = await dbFirst(tx,
      "SELECT currency_id FROM wallet_transactions WHERE reference_id = ? AND type = 'deposit' LIMIT 1",
      [id]
    );
    const oldCashCurrencyId = oldCashEntry ? oldCashEntry.currency_id : baseCurrency.id;
    const oldCashRate = oldCashEntry ? oldCashEntry.exchange_rate : baseCurrency.rate_to_base;
    const oldWalletCurrencyId = oldWalletEntry ? oldWalletEntry.currency_id : baseCurrency.id;

    if (oldCashPaid > 0) {
      newBatchQueries.push({
        sql: `INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note)
              VALUES ('withdraw', ?, ?, ?, ?)`,
        args: [oldCashPaid, oldCashCurrencyId, oldCashRate, `عكس فاتورة #${oldSale.invoice_number} (نقدي)`]
      });
    }
    if (oldWalletPaid > 0 && oldWalletId) {
      newBatchQueries.push({
        sql: `INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id)
              VALUES (?, 'withdraw', ?, ?, ?, ?)`,
        args: [oldWalletId, oldWalletPaid, oldWalletCurrencyId, `عكس فاتورة #${oldSale.invoice_number}`, id]
      });
      newBatchQueries.push({
        sql: "UPDATE wallet_balances SET balance = balance - ? WHERE wallet_id = ? AND currency_id = ?",
        args: [oldWalletPaid, oldWalletId, oldWalletCurrencyId]
      });
    }
    if (oldPaymentMethod === 'credit' && oldCustomerId) {
      newBatchQueries.push({
        sql: "UPDATE customers SET balance = balance - ? WHERE id = ?",
        args: [oldTotal, oldCustomerId]
      });
    }

    // ===== 7. تحديث الفاتورة =====
    const profit = totalAfterDiscount - newTotalCost;
    newBatchQueries.push({
      sql: `UPDATE sales SET 
        customer_id = ?, total_amount = ?, discount = ?, discount_type = ?, 
        payment_method = ?, cash_paid = ?, wallet_paid = ?, wallet_id = ?, 
        paid_amount = ?, profit = ?, total_cost = ?, note = ?
      WHERE id = ?`,
      args: [customer_id || null, totalAfterDiscount, discountAmount, discount_type,
        payment_method, finalCashPaid, finalWalletPaid, wallet_id || null,
        totalAfterDiscount, profit, newTotalCost, note || '', id]
    });

    // حذف القيود القديمة
    newBatchQueries.push({
      sql: "DELETE FROM journal_entry_details WHERE entry_id IN (SELECT id FROM journal_entries WHERE reference_type IN ('sale','sale_cogs') AND reference_id = ?)",
      args: [id]
    });
    newBatchQueries.push({
      sql: "DELETE FROM journal_entries WHERE reference_type IN ('sale','sale_cogs') AND reference_id = ?",
      args: [id]
    });

    // ===== 8. القيود المحاسبية الجديدة =====
    const entryDate = new Date().toISOString().split('T')[0];
    const desc = `تعديل فاتورة #${oldSale.invoice_number}`;
    const journalDetails = [];

    if (payment_method === 'cash' || payment_method === 'mixed') {
      let cashPaid = finalCashPaid;
      if (cashPaid > 0) {
        const rate = getCurrencyRateFast(useCashCurrencyId);
        const baseAmount = convertToBase(cashPaid, rate);
        newBatchQueries.push({
          sql: "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES ('deposit', ?, ?, ?, ?)",
          args: [cashPaid, useCashCurrencyId, rate, `إيراد ${oldSale.invoice_number}`]
        });
        journalDetails.push({ account_id: getAccountIdFast('الصندوق'), debit: baseAmount, credit: 0 });
      }
    }
    if (payment_method === 'wallet' || payment_method === 'mixed') {
      let walletPaid = finalWalletPaid;
      if (walletPaid > 0 && wallet_id) {
        const rate = getCurrencyRateFast(useWalletCurrencyId);
        const baseAmount = convertToBase(walletPaid, rate);
        newBatchQueries.push({
          sql: "INSERT OR IGNORE INTO wallet_balances (wallet_id, currency_id, balance) VALUES (?, ?, 0)",
          args: [wallet_id, useWalletCurrencyId]
        });
        newBatchQueries.push({
          sql: "UPDATE wallet_balances SET balance = balance + ? WHERE wallet_id = ? AND currency_id = ?",
          args: [walletPaid, wallet_id, useWalletCurrencyId]
        });
        newBatchQueries.push({
          sql: "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'deposit', ?, ?, ?, ?)",
          args: [wallet_id, walletPaid, useWalletCurrencyId, `إيداع ${oldSale.invoice_number}`, id]
        });
        journalDetails.push({ account_id: getAccountIdFast('المحافظ'), debit: baseAmount, credit: 0 });
      }
    }
    if (payment_method === 'credit') {
      if (!customer_id) throw new Error('العميل مطلوب للبيع الآجل');
      newBatchQueries.push({
        sql: "UPDATE customers SET balance = balance + ? WHERE id = ?",
        args: [totalAfterDiscount, customer_id]
      });
      journalDetails.push({ account_id: getAccountIdFast('الذمم المدينة (عملاء)'), debit: totalAfterDiscount, credit: 0 });
    }
    journalDetails.push({ account_id: getAccountIdFast('المبيعات'), debit: 0, credit: totalAfterDiscount });

    if (journalDetails.length > 0) {
      checkBalance(journalDetails);
      await createJournalEntry(tx, entryDate, desc, journalDetails, 'sale', id);
    }

    // قيد تكلفة البضاعة المباعة الجديد
    if (newTotalCost > 0) {
      const cogsDetails = [
        { account_id: getAccountIdFast('تكلفة البضاعة المباعة'), debit: newTotalCost, credit: 0 },
        { account_id: getAccountIdFast('المخزون'), debit: 0, credit: newTotalCost }
      ];
      await createJournalEntry(tx, entryDate, `تكلفة ${desc}`, cogsDetails, 'sale_cogs', id);
    }

    // ===== إصلاح #8: حُذفت كتلة تسوية فرق تكلفة المخزون (cost_adjustment على حساب 6900) =====
    // السبب: القيود القديمة حُذفت وأُعيد إنشاؤها بالتكلفة الجديدة (الخطوة 8 أعلاه) كاملة،
    // فكانت هذه الكتلة تحرّك حساب المخزون مرة ثانية بفارق التكلفة دون حدث اقتصادي يقابلها،
    // ويتراكم الخطأ مع كل تعديل فاتورة. التعديل الصحيح للتكلفة مغطى بالكامل بإعادة إنشاء القيود.

    // ===== 10. تنفيذ الدفعات =====
    const BATCH_SIZE = 40;
    for (let i = 0; i < newBatchQueries.length; i += BATCH_SIZE) {
      const chunk = newBatchQueries.slice(i, i + BATCH_SIZE);
      await tx.batch(chunk, 'write');
    }

    await tx.commit();
    committed = true;

    // ===== 11. جلب البيانات المحدثة بعد commit بمعزل آمن =====
    try {
      const updatedSale = await dbFirst(client, `
        SELECT s.*, c.name as customer_name
        FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?
      `, [id]);
      const updatedItems = await dbAll(client, `
        SELECT si.*, p.name as product_name
        FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = ?
      `, [id]);
      let walletName = null;
      if (wallet_id) { const w = await dbFirst(client, "SELECT name FROM wallets WHERE id = ?", [wallet_id]); walletName = w ? w.name : null; }
      const invoiceResponse = {
        id: updatedSale.id, invoice_number: updatedSale.invoice_number, created_at: updatedSale.created_at,
        payment_method: updatedSale.payment_method, customer_name: updatedSale.customer_name || 'نقدي',
        total_amount: updatedSale.total_amount, discount: updatedSale.discount, discount_type: updatedSale.discount_type,
        cash_paid: updatedSale.cash_paid, wallet_paid: updatedSale.wallet_paid, wallet_id: updatedSale.wallet_id,
        wallet_name: walletName, profit: updatedSale.profit,
        items: updatedItems.map(item => ({ product_id: item.product_id, product_name: item.product_name,
          quantity: item.quantity, unit_price: item.unit_price, total_price: item.total_price, cost_price: item.cost_price,
          supplier_id: item.supplier_id, supplier_price: item.supplier_price }))
      };
      return jsonResponse({ success: true, invoice: invoiceResponse }, 200, headers);
    } catch (postCommitError) {
      console.error('نجح تحديث البيع لكن تعذر جلب بيانات الفاتورة:', postCommitError.message);
      return jsonResponse({ success: true, sale_id: id, invoice: null,
        warning: 'تم تحديث البيع، لكن تعذر جلب بيانات الفاتورة' }, 200, headers);
    }
  } catch (error) {
    if (committed) {
      return jsonResponse({ success: true, sale_id: id, invoice: null,
        warning: 'تم تحديث البيع، لكن حدث خطأ بعد commit' }, 200, headers);
    }
    try { await tx.rollback(); } catch (rollbackError) { console.error('فشل rollback:', rollbackError.message); }
    return jsonResponse({ error: error.message }, 400, headers);
  }
}
async function getOnlineCustomerByPhone(request, env, headers) {
  const url = new URL(request.url);
  const phone = url.searchParams.get('phone');
  if (!phone) return jsonResponse({ error: 'رقم الهاتف مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const customer = await dbFirst(client,
    "SELECT * FROM online_customers WHERE id = (SELECT customer_id FROM online_customer_phones WHERE phone = ? LIMIT 1)",
    [phone]
  );
  if (!customer) return jsonResponse({ customer: null }, 200, headers);
  const phones = await dbAll(client, "SELECT phone FROM online_customer_phones WHERE customer_id = ?", [customer.id]);
  customer.phones = phones.map(p => p.phone);
  return jsonResponse({ customer }, 200, headers);
}

async function getDriverTransactions(request, env, headers) {
  const url = new URL(request.url);
  const driverId = url.searchParams.get('driver_id');
  if (!driverId) return jsonResponse({ error: 'معرف المندوب مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT dt.*, o.id as order_id, o.customer_name 
    FROM driver_transactions dt LEFT JOIN online_orders o ON o.id = dt.order_id
    WHERE dt.driver_id = ? ORDER BY dt.created_at DESC LIMIT 100
  `, [driverId]);
  return jsonResponse({ transactions: rows }, 200, headers);
}

// ================================================================
//  دوال المشتريات (createPurchase) =================================
// ================================================================

async function createPurchase(request, env, headers, userId) {
  const { supplier_id, items, payment_method, wallet_id, discount = 0, note = '',
    cash_amount = 0, cash_currency_id = null, wallet_amount = 0, wallet_currency_id = null,
    currency_id, exchange_rate: providedExchangeRate } = await request.json();
  if (!supplier_id || !items || items.length === 0) return jsonResponse({ error: 'المورد والمواد مطلوبان' }, 400, headers);

  const client = getTursoClient(env);
  await checkIfClosed(client, new Date().toISOString().slice(0, 10));
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) throw new Error('لا توجد عملة أساسية');

  

  const useCurrencyId = currency_id || baseCurrency.id;
  let finalExchangeRate = providedExchangeRate;
  if (!finalExchangeRate || finalExchangeRate <= 0) {
    const rateFromDb = await getCurrencyRate(client, useCurrencyId);
    finalExchangeRate = rateFromDb || 1;
  }
  const useCashCurrencyId = cash_currency_id || baseCurrency.id;
  const useWalletCurrencyId = wallet_currency_id || baseCurrency.id;

  const accounts = await dbAll(client, "SELECT id, name FROM accounts");
  const accountsMap = Object.fromEntries(accounts.map(a => [a.name, a.id]));
  const getAccountIdFast = (name) => {
    if (!accountsMap[name]) throw new Error(`الحساب "${name}" غير موجود`);
    return accountsMap[name];
  };
  const currencies = await dbAll(client, "SELECT id, rate_to_base FROM currencies");
  const currenciesMap = Object.fromEntries(currencies.map(c => [c.id, c.rate_to_base]));
  const getCurrencyRateFast = (id) => {
    if (!currenciesMap[id]) throw new Error(`العملة ${id} غير موجودة`);
    return currenciesMap[id];
  };

  let total = 0;
  const purchaseItemsData = items.map(item => {
    const price = parseFloat(item.unit_price) || 0;
    const qty = parseFloat(item.quantity) || 0;
    if (qty <= 0) throw new Error(`الكمية يجب أن تكون أكبر من صفر للمنتج ${item.name || 'غير معروف'}`);
    const itemTotal = price * qty;
    total += itemTotal;
    return { ...item, unit_price: price, quantity: qty, total_price: itemTotal };
  });
  const discountVal = parseFloat(discount) || 0;
  total -= discountVal;
  if (total < 0) total = 0;

  // ===== إصلاح #4: تحويل الإجمالي إلى الأساسية أولًا، ثم توزيعه على طرق الدفع بعملة الدفع =====
  // (قبل الإصلاح كان التوزيع يفترض أن total بالعملة الأساسية، فيخطأ كلما كانت عملة الفاتورة غير أساسية)
  const invoiceTotalBase = convertToBase(total, getCurrencyRateFast(useCurrencyId));
  let finalCashPaid = 0, finalWalletPaid = 0;
  if (payment_method === 'cash') {
    finalCashPaid = convertFromBase(invoiceTotalBase, getCurrencyRateFast(useCashCurrencyId));
  } else if (payment_method === 'wallet') {
    finalWalletPaid = convertFromBase(invoiceTotalBase, getCurrencyRateFast(useWalletCurrencyId));
  } else if (payment_method === 'mixed') {
    const validCashAmount = parseFloat(cash_amount) || 0;
    const validWalletAmount = parseFloat(wallet_amount) || 0;
    const cashBase = convertToBase(validCashAmount, getCurrencyRateFast(useCashCurrencyId));
    const walletBase = convertToBase(validWalletAmount, getCurrencyRateFast(useWalletCurrencyId));
    const totalPaidBase = cashBase + walletBase;
    if (totalPaidBase === 0) throw new Error('المبالغ المدفوعة صفر!');
    // النسب تُحسب من المبالغ الأساسية فتظل صحيحة مهما اختلفت عملة الفاتورة
    finalCashPaid = convertFromBase(invoiceTotalBase * (cashBase / totalPaidBase), getCurrencyRateFast(useCashCurrencyId));
    finalWalletPaid = convertFromBase(invoiceTotalBase * (walletBase / totalPaidBase), getCurrencyRateFast(useWalletCurrencyId));
  }
  finalCashPaid = isFinite(finalCashPaid) ? finalCashPaid : 0;
  finalWalletPaid = isFinite(finalWalletPaid) ? finalWalletPaid : 0;

  const existingProductIds = purchaseItemsData.map(item => item.product_id).filter(id => id);
  let productsMap = {};
  if (existingProductIds.length) {
    const productRows = await dbAll(client, `SELECT id, stock_quantity, cost FROM products WHERE id IN (${existingProductIds.join(',')})`);
    productsMap = productRows.reduce((acc, p) => { acc[p.id] = { id: p.id, stock_quantity: parseFloat(p.stock_quantity) || 0, cost: parseFloat(p.cost) || 0 }; return acc; }, {});
  }

  let supplierStocksMap = {};
  if (existingProductIds.length) {
    const stocks = await dbAll(client, `SELECT product_id, id, quantity, supplier_id, last_purchase_price FROM product_supplier_stock WHERE product_id IN (${existingProductIds.join(',')}) AND supplier_id = ?`, [supplier_id]);
    supplierStocksMap = stocks.reduce((acc, s) => { if (!acc[s.product_id]) acc[s.product_id] = []; acc[s.product_id].push(s); return acc; }, {});
  }

  let categoriesMap = {};
  const allCats = await dbAll(client, "SELECT id, name FROM categories");
  categoriesMap = allCats.reduce((acc, c) => { acc[c.name] = c.id; return acc; }, {});

  const supplier = await dbFirst(client, "SELECT sku_prefix FROM suppliers WHERE id = ?", [supplier_id]);
  const prefix = supplier?.sku_prefix?.trim() || 'SUP';
  let nextSeq = 1;
  const lastSku = await dbFirst(client, `SELECT supplier_sku FROM product_supplier_stock WHERE supplier_id = ? AND supplier_sku LIKE ? ORDER BY supplier_sku DESC LIMIT 1`, [supplier_id, prefix + '%']);
  if (lastSku && lastSku.supplier_sku) {
    const numPart = lastSku.supplier_sku.replace(prefix, '');
    const parsed = parseInt(numPart, 10);
    if (!isNaN(parsed)) nextSeq = parsed + 1;
  }

  const tx = await client.transaction();
  let committed = false;
  try {
    const inventoryAccountId = getAccountIdFast('المخزون');
    const cashAccountId = getAccountIdFast('الصندوق');
    const walletAccountId = getAccountIdFast('المحافظ');
    const supplierAccountId = getAccountIdFast('الذمم الدائنة (موردين)');

    const invoiceNumber = `PUR-${await getNextInvoiceNumber(tx, 'purchases')}`;
    const purchaseResult = await dbRun(tx,
      `INSERT INTO purchase_invoices (invoice_number, supplier_id, total_amount, discount, payment_method, wallet_id, status, note, cash_paid, wallet_paid, cash_currency_id, wallet_currency_id, currency_id, exchange_rate) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)`,
      [invoiceNumber, supplier_id, total, discountVal, payment_method, wallet_id || null, note, finalCashPaid, finalWalletPaid, useCashCurrencyId, useWalletCurrencyId, useCurrencyId, finalExchangeRate]
    );
    const purchaseId = purchaseResult.lastInsertRowid;

    const batchQueries = [];
    const categoriesToInsert = [];
    let seqCounter = nextSeq;

    for (const item of purchaseItemsData) {
      let productId = item.product_id;
      const quantity = parseFloat(item.quantity) || 0;
      const costPrice = (parseFloat(item.unit_price) || 0) * finalExchangeRate;
      const productName = item.name || 'منتج جديد';
      const sellingPrice = parseFloat(item.selling_price) || 0;

      let categoryId = item.category_id ? parseInt(item.category_id) : null;
      let categoryName = item.category || null;
      if (categoryName && !categoryId) {
        if (categoriesMap[categoryName]) {
          categoryId = categoriesMap[categoryName];
        } else {
          categoriesToInsert.push(categoryName);
          categoriesMap[categoryName] = 'temp';
        }
      }

      if (!productId) {
        const barcode = item.barcode || Math.floor(100000000000 + Math.random() * 900000000000).toString();
        const prodResult = await dbRun(tx,
          "INSERT INTO products (barcode, name, price, cost, stock_quantity, category, category_id) VALUES (?, ?, ?, ?, 0, ?, ?)",
          [barcode, productName, sellingPrice, costPrice, categoryName, categoryId]
        );
        productId = prodResult.lastInsertRowid;
        productsMap[productId] = { id: productId, stock_quantity: 0, cost: 0 };
      }

      const currentProduct = productsMap[productId];
      if (!currentProduct) throw new Error(`المنتج رقم ${productId} غير موجود`);
      
      const currentStock = parseFloat(currentProduct.stock_quantity) || 0;
      const currentCost = parseFloat(currentProduct.cost) || 0;
      const newStock = currentStock + quantity;
      let newCost = newStock > 0 ? (currentStock * currentCost + quantity * costPrice) / newStock : currentCost;
      if (!isFinite(newCost)) newCost = costPrice;

      batchQueries.push({
        sql: "UPDATE products SET stock_quantity = ?, cost = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        args: [newStock, newCost, productId]
      });

      // إضافة سجل حركة المخزون
      batchQueries.push({
        sql: `INSERT INTO stock_movements
              (product_id, supplier_id, quantity_change, old_quantity, new_quantity, reference_type, reference_id, note, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [productId, supplier_id, quantity, currentStock, newStock, 'purchase', purchaseId, `فاتورة مشتريات #${invoiceNumber}`, userId]
      });

      batchQueries.push({
        sql: "INSERT INTO purchase_invoice_items (invoice_id, product_id, quantity, unit_price, total_price, selling_price, category) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [purchaseId, productId, quantity, costPrice, item.total_price, sellingPrice, item.category || '']
      });

      let supplierSku = item.supplier_sku ? item.supplier_sku.trim() : null;
      if (!supplierSku) {
        supplierSku = prefix + String(seqCounter).padStart(4, '0');
        seqCounter++;
      }

      const existingStock = supplierStocksMap[productId] ? supplierStocksMap[productId][0] : null;
      if (existingStock) {
        batchQueries.push({
          sql: "UPDATE product_supplier_stock SET quantity = quantity + ?, last_purchase_price = ?, total_purchased = total_purchased + ?, supplier_sku = COALESCE(?, supplier_sku), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          args: [quantity, costPrice, quantity, supplierSku, existingStock.id]
        });
      } else {
        batchQueries.push({
          sql: "INSERT INTO product_supplier_stock (product_id, supplier_id, quantity, last_purchase_price, total_purchased, supplier_sku) VALUES (?, ?, ?, ?, ?, ?)",
          args: [productId, supplier_id, quantity, costPrice, quantity, supplierSku]
        });
      }
    }

    if (categoriesToInsert.length > 0) {
      for (const catName of categoriesToInsert) {
        const res = await dbRun(tx, "INSERT INTO categories (name) VALUES (?)", [catName]);
        categoriesMap[catName] = res.lastInsertRowid;
      }
    }

    const entryDate = new Date().toISOString().split('T')[0];
    const desc = `فاتورة مشتريات #${invoiceNumber}`;
    const journalDetails = [];
    const totalBase = convertToBase(total, finalExchangeRate);
    journalDetails.push({ account_id: inventoryAccountId, debit: totalBase, credit: 0 });

    if (payment_method === 'cash' || payment_method === 'mixed') {
      if (finalCashPaid > 0) {
        const rate = getCurrencyRateFast(useCashCurrencyId);
        const baseAmount = convertToBase(finalCashPaid, rate);
        batchQueries.push({
          sql: "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES ('withdraw', ?, ?, ?, ?)",
          args: [finalCashPaid, useCashCurrencyId, rate, `دفع ${invoiceNumber}`]
        });
        journalDetails.push({ account_id: cashAccountId, debit: 0, credit: baseAmount });
      }
    }
    if (payment_method === 'wallet' || payment_method === 'mixed') {
      if (finalWalletPaid > 0 && wallet_id) {
        const rate = getCurrencyRateFast(useWalletCurrencyId);
        const baseAmount = convertToBase(finalWalletPaid, rate);
        const bal = await dbFirst(tx, "SELECT balance FROM wallet_balances WHERE wallet_id = ? AND currency_id = ?", [wallet_id, useWalletCurrencyId]);
        if (!bal || parseFloat(bal.balance) < finalWalletPaid) throw new Error('رصيد غير كافٍ');
        batchQueries.push({
          sql: "UPDATE wallet_balances SET balance = balance - ? WHERE wallet_id = ? AND currency_id = ?",
          args: [finalWalletPaid, wallet_id, useWalletCurrencyId]
        });
        batchQueries.push({
          sql: "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'withdraw', ?, ?, ?, ?)",
          args: [wallet_id, finalWalletPaid, useWalletCurrencyId, `دفع ${invoiceNumber}`, purchaseId]
        });
        journalDetails.push({ account_id: walletAccountId, debit: 0, credit: baseAmount });
      }
    }
    if (payment_method === 'credit') {
      batchQueries.push({
        sql: "UPDATE suppliers SET balance = balance + ? WHERE id = ?",
        args: [totalBase, supplier_id]
      });
      journalDetails.push({ account_id: supplierAccountId, debit: 0, credit: totalBase });
    }

    if (journalDetails.length > 0) {
      checkBalance(journalDetails);
      const entryResult = await dbRun(tx,
        "INSERT INTO journal_entries (entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?)",
        [entryDate, desc, 'purchase', purchaseId]
      );
      const entryId = entryResult.lastInsertRowid;
      for (const detail of journalDetails) {
        batchQueries.push({
          sql: "INSERT INTO journal_entry_details (entry_id, account_id, debit, credit, notes) VALUES (?, ?, ?, ?, ?)",
          args: [entryId, detail.account_id, detail.debit || 0, detail.credit || 0, detail.notes || '']
        });
      }
    }

    if (batchQueries.length > 0) {
      await tx.batch(batchQueries, 'write');
    }
    await tx.commit();
    committed = true;

    try {
      let walletName = null;
      if (wallet_id) { const w = await dbFirst(client, "SELECT name FROM wallets WHERE id = ?", [wallet_id]); walletName = w ? w.name : null; }
      return jsonResponse({ success: true, invoice_number: invoiceNumber, total_amount: total, wallet_name: walletName }, 200, headers);
    } catch (postCommitError) {
      console.error('نجح حفظ فاتورة الشراء لكن تعذر جلب بيانات الرد:', postCommitError.message);
      return jsonResponse({ success: true, invoice_number: invoiceNumber, total_amount: total, wallet_name: null,
        warning: 'تم حفظ فاتورة الشراء، لكن تعذر جلب اسم المحفظة' }, 200, headers);
    }
  } catch (error) {
    if (committed) {
      return jsonResponse({ success: true,
        warning: 'تم حفظ فاتورة الشراء، لكن حدث خطأ بعد commit' }, 200, headers);
    }
    try { await tx.rollback(); } catch (rollbackError) { console.error('فشل rollback:', rollbackError.message); }
    return jsonResponse({ error: error.message }, 400, headers);
  }
}

// ================================================================
//  دوال إضافية =================================
// ================================================================

async function getPurchases(request, env, headers) {
  const client = getTursoClient(env);
  const rows = await dbAll(client, `
    SELECT pi.*, s.name as supplier_name, w.name as wallet_name
    FROM purchase_invoices pi JOIN suppliers s ON s.id = pi.supplier_id LEFT JOIN wallets w ON w.id = pi.wallet_id
    ORDER BY pi.created_at DESC LIMIT 100
  `);
  return jsonResponse({ purchases: rows }, 200, headers);
}

async function getPurchaseDetails(request, env, headers) {
  const id = parseInt(request.url.split('/').pop());
  const client = getTursoClient(env);
  const invoice = await dbFirst(client, `
    SELECT pi.*, s.name as supplier_name, w.name as wallet_name
    FROM purchase_invoices pi JOIN suppliers s ON s.id = pi.supplier_id LEFT JOIN wallets w ON w.id = pi.wallet_id
    WHERE pi.id = ?
  `, [id]);
  if (!invoice) return jsonResponse({ error: 'الفاتورة غير موجودة' }, 404, headers);
  const items = await dbAll(client, `
    SELECT pii.*, p.name as product_name, p.barcode as product_barcode, p.cost as current_cost, p.price as current_price, p.category as product_category
    FROM purchase_invoice_items pii JOIN products p ON p.id = pii.product_id WHERE pii.invoice_id = ?
  `, [id]);
  const returns = await dbAll(client, `
    SELECT rp.*, p.name as product_name
    FROM returned_purchases rp JOIN products p ON p.id = rp.product_id WHERE rp.purchase_invoice_id = ?
  `, [id]);
  invoice.items = items; invoice.returns = returns;
  return jsonResponse({ purchase: invoice }, 200, headers);
}

async function updatePurchaseInvoice(request, env, headers) {
  return jsonResponse({ error: 'تحديث فواتير المشتريات غير مدعوم حالياً' }, 400, headers);
}

// ================================================================
//  دوال واجهة المندوب (المتبقية) =================================
// ================================================================

async function getDriverOrders(request, env, headers) {
  const url = new URL(request.url);
  const driverId = url.searchParams.get('driver_id');
  if (!driverId) return jsonResponse({ error: 'معرف المندوب مطلوب' }, 400, headers);

  const status = url.searchParams.get('status') || '';
  const period = url.searchParams.get('period') || 'all';
  const page = parseInt(url.searchParams.get('page')) || 1;
  const limit = parseInt(url.searchParams.get('limit')) || 20;
  const offset = (page - 1) * limit;

  const client = getTursoClient(env);
  await checkIfClosed(client, new Date().toISOString().slice(0, 10));

  let whereConditions = 'o.assigned_driver_id = ?';
  const params = [driverId];

  if (status) {
    whereConditions += ' AND o.status = ?';
    params.push(status);
  }

  let startDate = null;
  if (period && period !== 'all') {
    const now = new Date();
    if (period === 'today') {
      startDate = now.toISOString().split('T')[0];
    } else if (period === 'last2days') {
      const start = new Date(now);
      start.setDate(now.getDate() - 2);
      startDate = start.toISOString().split('T')[0];
    } else if (period === 'week') {
      const start = new Date(now);
      start.setDate(now.getDate() - 7);
      startDate = start.toISOString().split('T')[0];
    } else if (period === 'month') {
      const start = new Date(now);
      start.setDate(now.getDate() - 30);
      startDate = start.toISOString().split('T')[0];
    }
    
    if (startDate) {
      whereConditions += ' AND DATE(o.order_date) >= ?';
      params.push(startDate);
    }
  }

  const statsSql = `
    SELECT
      COUNT(*) AS total_deliveries,
      COALESCE(SUM(o.delivery_fee), 0) AS total_fees,
      COALESCE(SUM(o.actual_collected), 0) AS total_collected,
      0 AS total_paid_to_shop
    FROM online_orders o
    WHERE ${whereConditions}
      AND o.status = 'تم التسليم'
  `;
  const stats = await dbFirst(client, statsSql, params);

  const account = await dbFirst(client, `
    SELECT balance, last_settlement_date
    FROM driver_accounts WHERE driver_id = ?
  `, [driverId]);

  const countSql = `
    SELECT COUNT(DISTINCT o.id) as total
    FROM online_orders o
    WHERE ${whereConditions}
  `;
  const countResult = await dbFirst(client, countSql, params);
  const totalCount = countResult ? countResult.total : 0;
  const totalPages = Math.ceil(totalCount / limit);

  // جلب الطلبات مع الخصم من sales
  const sql = `
    SELECT o.*, d.name as driver_name,
           s.discount, s.discount_type, s.cash_paid, s.wallet_paid,
           oi.id as item_id, oi.product_id as item_product_id, oi.product_name as item_product_name,
           oi.quantity as item_quantity, oi.unit_price as item_unit_price, oi.line_total as item_line_total,
           oi.note as item_note,
           p.name as product_name, p.barcode
    FROM online_orders o
    LEFT JOIN drivers d ON d.id = o.assigned_driver_id
    LEFT JOIN sales s ON s.id = o.accounting_invoice_id
    LEFT JOIN online_order_items oi ON oi.order_id = o.id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE ${whereConditions}
    ORDER BY o.order_date DESC, oi.id
    LIMIT ? OFFSET ?
  `;
  const rows = await dbAll(client, sql, [...params, limit, offset]);

  const ordersMap = {};
  for (const row of rows) {
    if (!ordersMap[row.id]) {
      ordersMap[row.id] = { ...row, items: [], is_prepaid: isPrepaidOrder(row) ? 1 : 0 };
    }
    if (row.item_id) {
      ordersMap[row.id].items.push({
        id: row.item_id,
        product_id: row.item_product_id,
        product_name: row.item_product_name || row.product_name,
        quantity: row.item_quantity,
        unit_price: row.item_unit_price,
        line_total: row.item_line_total,
        barcode: row.barcode,
        note: row.item_note
      });
    }
  }
  
  const ordersWithItems = Object.values(ordersMap).map(order => {
    // ===== حساب موحد للمبلغ النقدي المطلوب من المندوب =====
    // (total_amount يتضمن رسوم التوصيل من لحظة إنشاء الطلب، فلا نضيفها مجدداً)
    const orderTotalBase = parseFloat(order.total_amount) || 0;
    let expectedCash = 0;
    if (isMixedOrder(order)) {
        expectedCash = parseFloat(order.cash_paid) || 0;
    } else {
        // 🌟 إزالة طرح المحفظة: منع المبالغ الوهمية في wallet_paid للطلبات النقدية القديمة
        expectedCash = Math.max(0, orderTotalBase);
    }
    // إضافة رسوم التوصيل في حال كانت عند الاستلام — يُطبق على جميع الطلبات
    if (order.delivery_fee_payment === 'عند الاستلام' && order.delivery_fee) {
        expectedCash += parseFloat(order.delivery_fee) || 0;
    }
    order.expected_cash = expectedCash;
    delete order.item_id;
    delete order.item_product_id;
    delete order.item_product_name;
    delete order.item_quantity;
    delete order.item_unit_price;
    delete order.item_line_total;
    delete order.product_name;
    delete order.barcode;
    delete order.item_note;
    return order;
  });

  const filteredAccount = {
    balance: account ? account.balance : 0,
    total_deliveries: stats ? stats.total_deliveries : 0,
    total_fees: stats ? stats.total_fees : 0,
    total_collected: stats ? stats.total_collected : 0,
    total_paid_to_shop: stats ? stats.total_paid_to_shop : 0,
    last_settlement_date: account ? account.last_settlement_date : null
  };

  return jsonResponse({
    orders: ordersWithItems,
    account: filteredAccount,
    pagination: {
      current_page: page,
      total_pages: totalPages,
      total_count: totalCount,
      page_size: limit
    }
  }, 200, headers);
}

async function getDriverOrderItems(request, env, headers) {
  const url = new URL(request.url);
  const orderId = url.searchParams.get('order_id');
  if (!orderId) return jsonResponse({ error: 'معرف الطلب مطلوب' }, 400, headers);
  const client = getTursoClient(env);
  const items = await dbAll(client, `
    SELECT oi.*, p.name as product_name, p.barcode 
    FROM online_order_items oi LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `, [orderId]);
  return jsonResponse({ items }, 200, headers);
}

async function getDriverSummary(request, env, headers) {
  const url = new URL(request.url);
  const driverId = url.searchParams.get('driver_id');
  const period = url.searchParams.get('period') || 'week';
  if (!driverId) return jsonResponse({ error: 'معرف المندوب مطلوب' }, 400, headers);

  const client = getTursoClient(env);
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  let dateFrom = null;
  if (period === 'day') {
    dateFrom = today;
  } else if (period === 'last2days') {
    const start = new Date(now);
    start.setDate(now.getDate() - 2);
    dateFrom = start.toISOString().split('T')[0];
  } else if (period === 'week') {
    const start = new Date(now);
    start.setDate(now.getDate() - 7);
    dateFrom = start.toISOString().split('T')[0];
  } else if (period === 'month') {
    const start = new Date(now);
    start.setDate(now.getDate() - 30);
    dateFrom = start.toISOString().split('T')[0];
  }

  let dateCondition = '';
  const params = [driverId];
  if (dateFrom) {
    dateCondition = 'AND DATE(o.order_date) >= ?';
    params.push(dateFrom);
  }

  const result = await dbFirst(
    client,
    `
      SELECT COALESCE(SUM(o.delivery_fee), 0) as total_fees, COUNT(*) as orders_count
      FROM online_orders o
      WHERE o.assigned_driver_id = ? AND o.status = 'تم التسليم' ${dateCondition}
    `,
    params
  );

  const returnParams = [driverId];
  let returnDateCondition = '';
  if (dateFrom) {
    returnDateCondition = 'AND DATE(r.confirmed_at) >= ?';
    returnParams.push(dateFrom);
  }
  const returnResult = await dbFirst(
    client,
    `
      SELECT COALESCE(SUM(r.delivery_fee_return), 0) as return_fees
      FROM online_order_returns r
      WHERE r.assigned_driver_id = ? AND r.status = 'completed' ${returnDateCondition}
    `,
    returnParams
  );

  const collected = await dbFirst(
    client,
    `
      SELECT COALESCE(SUM(o.actual_collected), 0) as total_collected
      FROM online_orders o
      WHERE o.assigned_driver_id = ? AND o.status = 'تم التسليم' ${dateCondition}
    `,
    params
  );

  const totalFees = (result?.total_fees || 0) + (returnResult?.return_fees || 0);

  return jsonResponse({
    period,
    total_fees: totalFees,
    total_collected: collected?.total_collected || 0,
    orders_count: result?.orders_count || 0
  }, 200, headers);
}

// ================================================================
//  دوال طلبات الإنترنت (المتبقية) =================================
// ================================================================

async function getOnlineOrders(request, env, headers) {
  const client = getTursoClient(env);
  const url = new URL(request.url);
  
  const status = url.searchParams.get('status') || '';
  const driver_id = url.searchParams.get('driver_id') || '';
  const payment_method = url.searchParams.get('payment_method') || '';
  const search = url.searchParams.get('search') || '';
  const date_from = url.searchParams.get('date_from') || '';
  const date_to = url.searchParams.get('date_to') || '';
  const page = parseInt(url.searchParams.get('page')) || 1;
  const pageSize = parseInt(url.searchParams.get('page_size')) || 20;

  const offset = (page - 1) * pageSize;

  // إصلاح #10: إضافة cash_paid وwallet_paid من الفاتورة لحساب المبلغ النقدي المتوقع للطلبات المختلطة
  let sql = `SELECT o.*, d.name as driver_name, s.discount, s.discount_type, s.cash_paid, s.wallet_paid FROM online_orders o LEFT JOIN drivers d ON d.id = o.assigned_driver_id LEFT JOIN sales s ON s.id = o.accounting_invoice_id WHERE 1=1`;
  let countSql = `SELECT COUNT(*) as total FROM online_orders o WHERE 1=1`;
  const args = [];
  const countArgs = [];

  if (status) { 
    sql += " AND o.status = ?"; args.push(status);
    countSql += " AND status = ?"; countArgs.push(status);
  }
  if (driver_id) { 
    sql += " AND o.assigned_driver_id = ?"; args.push(driver_id);
    countSql += " AND assigned_driver_id = ?"; countArgs.push(driver_id);
  }
  if (payment_method) { 
    sql += " AND o.payment_method = ?"; args.push(payment_method);
    countSql += " AND payment_method = ?"; countArgs.push(payment_method);
  }
  if (search) { 
    sql += " AND (o.customer_name LIKE ? OR o.customer_phone LIKE ?)"; 
    args.push(`%${search}%`, `%${search}%`);
    countSql += " AND (customer_name LIKE ? OR customer_phone LIKE ?)"; 
    countArgs.push(`%${search}%`, `%${search}%`);
  }
  if (date_from && date_to) {
    sql += " AND DATE(o.order_date) BETWEEN ? AND ?";
    args.push(date_from, date_to);
    countSql += " AND DATE(order_date) BETWEEN ? AND ?";
    countArgs.push(date_from, date_to);
  } else if (date_from) {
    sql += " AND DATE(o.order_date) >= ?";
    args.push(date_from);
    countSql += " AND DATE(order_date) >= ?";
    countArgs.push(date_from);
  } else if (date_to) {
    sql += " AND DATE(o.order_date) <= ?";
    args.push(date_to);
    countSql += " AND DATE(order_date) <= ?";
    countArgs.push(date_to);
  }

  sql += " ORDER BY o.order_date DESC LIMIT ? OFFSET ?";
  args.push(pageSize, offset);

  const rows = await dbAll(client, sql, args);
  const totalResult = await dbFirst(client, countSql, countArgs);
  const totalCount = totalResult ? totalResult.total : 0;

  const orders = rows.map(o => {
    // ===== إصلاح #10: المبلغ النقدي المطلوب من المندوب — للطلب المختلط هو cash_paid من الفاتورة =====
    const oTotal = parseFloat(o.total_amount) || 0;
   let oExpectedCash = 0;
if (isMixedOrder(o)) {
    // المبلغ المطلوب مسجل جاهزاً من الفاتورة
    oExpectedCash = parseFloat(o.cash_paid) || 0;
} else {
    // 🌟 إزالة طرح المحفظة: منع المبالغ الوهمية في wallet_paid للطلبات النقدية القديمة
    oExpectedCash = Math.max(0, oTotal);
}
    // إضافة رسوم التوصيل في حال كانت عند الاستلام — يُطبق على جميع الطلبات
    if (o.delivery_fee_payment === 'عند الاستلام' && o.delivery_fee) {
        oExpectedCash += parseFloat(o.delivery_fee) || 0;
    }
    return { ...o, is_prepaid: isPrepaidOrder(o) ? 1 : 0, expected_cash: oExpectedCash };
  });
  
  return jsonResponse({ 
    orders, 
    pagination: { 
      current_page: page, 
      page_size: pageSize, 
      total_count: totalCount,
      total_pages: Math.ceil(totalCount / pageSize) 
    } 
  }, 200, headers);
}

async function getOnlineOrderDetails(request, env, headers) {
  const id = parseInt(request.url.split('/').pop());
  const client = getTursoClient(env);
  const order = await dbFirst(client, `
    SELECT o.*, d.name as driver_name, s.discount, s.discount_type FROM online_orders o LEFT JOIN drivers d ON d.id = o.assigned_driver_id LEFT JOIN sales s ON s.id = o.accounting_invoice_id WHERE o.id = ?
  `, [id]);
  if (!order) return jsonResponse({ error: 'الطلب غير موجود' }, 404, headers);
  const items = await dbAll(client, "SELECT * FROM online_order_items WHERE order_id = ?", [id]);
  order.items = items;
  const logs = await dbAll(client, "SELECT * FROM order_status_log WHERE order_id = ? ORDER BY change_date", [id]);
  order.status_log = logs;
  order.is_prepaid = isPrepaidOrder(order) ? 1 : 0;
  if (order.online_customer_id) {
    const phones = await dbAll(client, "SELECT phone FROM online_customer_phones WHERE customer_id = ?", [order.online_customer_id]);
    order.customer_phones = phones.map(p => p.phone);
  } else order.customer_phones = [order.customer_phone];
  const returnInfo = await dbFirst(client, `
    SELECT return_fee, return_fee_type FROM online_order_returns WHERE order_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1
  `, [id]);
  if (returnInfo) {
    order.return_fee = returnInfo.return_fee;
    order.return_fee_type = returnInfo.return_fee_type;
  }
  return jsonResponse({ order }, 200, headers);
}

async function assignDriverToOrder(request, env, ctx, headers) {
  const { order_id, driver_id } = await request.json();
  if (!order_id || !driver_id) {
    return jsonResponse({ error: 'بيانات غير مكتملة' }, 400, headers);
  }

  const client = getTursoClient(env);
  const order = await dbFirst(client, "SELECT id, status FROM online_orders WHERE id = ?", [order_id]);
  if (!order) {
    return jsonResponse({ error: 'الطلب غير موجود' }, 404, headers);
  }

  // تحديث الطلب
  await dbRun(client, "UPDATE online_orders SET assigned_driver_id = ?, status = 'مُسند لمندوب' WHERE id = ?", [driver_id, order_id]);
  await dbRun(client, "INSERT INTO delivery_assignments (order_id, driver_id, delivery_status) VALUES (?, ?, 'مُسند')", [order_id, driver_id]);
  await dbRun(client, "INSERT INTO order_status_log (order_id, old_status, new_status, status) VALUES (?, ?, ?, ?)", [order_id, order.status, 'مُسند لمندوب', 'مُسند لمندوب']);

  // إرسال إشعار للمندوب في الخلفية
  // إرسال إشعار للمندوب في الخلفية
  ctx.waitUntil(sendFCMNotification(
    env,
    '🚚 تم تعيين مندوب',
    `تم تعيينك لتوصيل الطلب #${order_id}`,
    null,
    `https://pos.ibnalmukhtar.com/driver/?order=${order_id}`,
    driver_id
));

  return jsonResponse({ success: true }, 200, headers);
}

async function updateOrderStatus(request, env, ctx, headers) {
  const { order_id, new_status, notes } = await request.json();
  if (!order_id || !new_status) {
    return jsonResponse({ error: 'بيانات غير مكتملة' }, 400, headers);
  }

  const client = getTursoClient(env);
  const order = await dbFirst(client, "SELECT * FROM online_orders WHERE id = ?", [order_id]);
  if (!order) {
    return jsonResponse({ error: 'الطلب غير موجود' }, 404, headers);
  }

  const old_status = order.status;

  // تحديث حالة الطلب
  await dbRun(client, "UPDATE online_orders SET status = ? WHERE id = ?", [new_status, order_id]);
  await dbRun(client, "INSERT INTO order_status_log (order_id, old_status, new_status, status, notes) VALUES (?, ?, ?, ?, ?)",
    [order_id, old_status, new_status, new_status, notes || '']);

 
  if (order.assigned_driver_id) {
    ctx.waitUntil(sendAdminFCMNotification(
      env,
      `🔄 تغيير حالة الطلب #${order_id}`,
      `الحالة الجديدة: ${new_status}`
    ));
  }

  return jsonResponse({ success: true }, 200, headers);
}

// ================================================================
//  دوال إنشاء وتحديث طلب إنترنت =================================
// ================================================================

async function createOnlineOrder(request, env, ctx, headers, userId) {
  const {
    customer_name,
    customer_phones,
    customer_address,
    governorate,
    delivery_type,
    payment_method,
    items,
    notes,
    prepaid_payment_method,
    prepaid_wallet_id,
    prepaid_cash_amount,
    prepaid_wallet_amount,
    driver_id,
    total_amount,
    delivery_fee = 0,
    delivery_fee_payment = 'مع الطلب',
    currency_id,
    cash_currency_id,
    wallet_currency_id,
    discount = 0,
    discount_amount = 0,
    discount_type = 'fixed',
    order_date
  } = await request.json();

  // --- التحقق من البيانات الأساسية ---
  if (!customer_phones || !Array.isArray(customer_phones) || customer_phones.length === 0) {
    return jsonResponse({ error: 'رقم هاتف واحد على الأقل مطلوب' }, 400, headers);
  }
  if (!customer_address) {
    return jsonResponse({ error: 'عنوان العميل مطلوب' }, 400, headers);
  }
  if (!items || items.length === 0) {
    return jsonResponse({ error: 'السلة فارغة' }, 400, headers);
  }

  const client = getTursoClient(env);
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) {
    return jsonResponse({ error: 'لا توجد عملة أساسية' }, 400, headers);
  }
  const useCurrencyId = currency_id || baseCurrency.id;

  // --- تحميل الحسابات والعملات ---
  const accounts = await dbAll(client, "SELECT id, name FROM accounts");
  const accountsMap = Object.fromEntries(accounts.map(a => [a.name, a.id]));
  const getAccountIdFast = (name) => {
    if (!accountsMap[name]) throw new Error(`الحساب "${name}" غير موجود`);
    return accountsMap[name];
  };
  const currencies = await dbAll(client, "SELECT id, rate_to_base FROM currencies");
  const currenciesMap = Object.fromEntries(currencies.map(c => [c.id, c.rate_to_base]));
  const getCurrencyRateFast = (id) => {
    if (!currenciesMap[id]) throw new Error(`العملة ${id} غير موجودة`);
    return currenciesMap[id];
  };

  let cashAccountId, walletAccountId, saleAccountId, cogsAccountId, inventoryAccountId, deliveryFeeAccountId;
  try {
    cashAccountId = getAccountIdFast('الصندوق');
    walletAccountId = getAccountIdFast('المحافظ');
    saleAccountId = getAccountIdFast('المبيعات');
    cogsAccountId = getAccountIdFast('تكلفة البضاعة المباعة');
    inventoryAccountId = getAccountIdFast('المخزون');
    deliveryFeeAccountId = getAccountIdFast('رسوم التوصيل المستحقة');
  } catch (e) {
    return jsonResponse({ error: 'خطأ في الحسابات المحاسبية: ' + e.message }, 500, headers);
  }

  // --- معالجة العميل (أونلاين) ---
  let onlineCustomerId = null;
  const allPhones = customer_phones.filter(p => p && p.trim());
  if (allPhones.length > 0) {
    const placeholders = allPhones.map(() => '?').join(',');
    const phoneRecords = await dbAll(client, `
      SELECT customer_id, phone
      FROM online_customer_phones
      WHERE phone IN (${placeholders})
    `, allPhones);
    const phoneMap = {};
    for (const rec of phoneRecords) {
      if (!phoneMap[rec.phone]) phoneMap[rec.phone] = rec.customer_id;
    }
    for (const phone of allPhones) {
      if (phoneMap[phone]) {
        onlineCustomerId = phoneMap[phone];
        break;
      }
    }
  }

  if (!onlineCustomerId) {
    const res = await dbRun(client,
      "INSERT INTO online_customers (name, default_address) VALUES (?, ?)",
      [customer_name || 'عميل', customer_address]
    );
    onlineCustomerId = res.lastInsertRowid;
    const phoneQueries = allPhones.map(phone => ({
      sql: "INSERT INTO online_customer_phones (customer_id, phone) VALUES (?, ?)",
      args: [onlineCustomerId, phone.trim()]
    }));
    if (phoneQueries.length > 0) {
      await client.batch(phoneQueries);
    }
  }

  // --- حساب الإجمالي ---
  let total = total_amount || 0;
  if (!total) {
    const subtotal = items.reduce((sum, item) => sum + (item.unit_price || 0) * (item.quantity || 0), 0);
    total = subtotal + delivery_fee;
  }

  // --- تطبيع طريقة الدفع وتحديد نوعها ---
  const normalizedPaymentMethod = normalizePaymentMethod(payment_method);
  const isPrepaid = normalizedPaymentMethod === 'مدفوع مسبقاً';
  // تعريف isMixed: ليس مدفوع مسبقاً، والنص يحتوي على 'مختلط' أو 'mixed'
  const isMixed = !isPrepaid && (normalizedPaymentMethod === 'مختلط' || (normalizedPaymentMethod || '').toLowerCase().includes('mixed'));

  // --- التحقق من صحة الدفع المسبق ---
  if (isPrepaid) {
    if (prepaid_payment_method !== 'wallet') {
      return jsonResponse({ error: 'الدفع المسبق مسموح فقط عبر المحفظة الإلكترونية.' }, 400, headers);
    }
    if (prepaid_cash_amount > 0) {
      return jsonResponse({ error: 'لا يمكن دفع مبلغ نقدي في الدفع المسبق.' }, 400, headers);
    }
    if (!prepaid_wallet_id) {
      return jsonResponse({ error: 'يجب اختيار محفظة للدفع المسبق.' }, 400, headers);
    }
  }

  // --- متغيرات الدفع ---
  let prepaidDetails = {};
  let cashPaid = 0, walletPaid = 0, walletId = null;
  let salePaymentMethod = 'pending';
  let saleStatus = 'pending';
  let paidAmount = 0;

  // --- حالة الدفع المسبق كامل (محفظة فقط) ---
  if (isPrepaid) {
    prepaidDetails = {
      original: payment_method,
      prepaid_method: prepaid_payment_method,
      wallet_id: prepaid_wallet_id,
      cash_amount: prepaid_cash_amount,
      wallet_amount: prepaid_wallet_amount,
      currency_id: useCurrencyId
    };
    saleStatus = 'completed';
    paidAmount = total;
    salePaymentMethod = 'wallet';
    const walletRate = getCurrencyRateFast(useCurrencyId);
    walletPaid = convertFromBase(total, walletRate);
    walletId = prepaid_wallet_id;
  }

  // --- حالة الدفع المختلط (جزء محفظة مسبقاً + باقي نقد عند الاستلام) ---
  if (isMixed) {
    if (!prepaid_wallet_id) {
      return jsonResponse({ error: 'معرف المحفظة مطلوب للدفع المختلط.' }, 400, headers);
    }
    if (!prepaid_wallet_amount || parseFloat(prepaid_wallet_amount) <= 0) {
      return jsonResponse({ error: 'مبلغ الدفع بالمحفظة مطلوب وموجب في الدفع المختلط.' }, 400, headers);
    }
    walletId = prepaid_wallet_id;
    walletPaid = parseFloat(prepaid_wallet_amount);
    const walletCurrencyId = wallet_currency_id || useCurrencyId;
    if (!currenciesMap[walletCurrencyId]) {
      return jsonResponse({ error: `عملة المحفظة ${walletCurrencyId} غير موجودة` }, 400, headers);
    }
    const walletRate = getCurrencyRateFast(walletCurrencyId);
    const cashRate = getCurrencyRateFast(useCurrencyId);
    const totalBase = convertToBase(total, cashRate);
    const walletPaidBase = convertToBase(walletPaid, walletRate);
    if (walletPaidBase >= totalBase - 0.01) {
      return jsonResponse({ error: 'مبلغ المحفظة لا يجب أن يغطي الإجمالي كاملًا؛ استخدم الدفع المسبق.' }, 400, headers);
    }
    if (walletPaidBase <= 0.01) {
      return jsonResponse({ error: 'مبلغ المحفظة صغير جدًا.' }, 400, headers);
    }
    const collectBase = totalBase - walletPaidBase;
    cashPaid = convertFromBase(collectBase, cashRate);
    salePaymentMethod = 'mixed';
    saleStatus = 'pending';
    paidAmount = walletPaidBase;
  }

  // --- حالة الدفع الآجل (credit) – حماية مستقبلية ---
  if (!isPrepaid && !isMixed && (normalizedPaymentMethod || '').toLowerCase().includes('credit')) {
    saleStatus = 'pending';
    salePaymentMethod = 'credit';
    paidAmount = 0;
  }

  // --- البحث عن عميل (عادي) باستخدام أول هاتف ---
  const mainPhone = allPhones[0];
  let customer = await dbFirst(client, "SELECT id FROM customers WHERE phone = ?", [mainPhone]);
  if (!customer) {
    const custRes = await dbRun(client, "INSERT INTO customers (name, phone, address) VALUES (?, ?, ?)", [customer_name || 'عميل', mainPhone, customer_address]);
    customer = { id: custRes.lastInsertRowid };
  }

  // --- بدء المعاملة ---
  const tx = await client.transaction();
  let committed = false;
  try {
    const settings = await getSettingsCached(tx);
    const allowBelowCost = settings.allow_below_cost === '1';
    const allowNegativeStock = settings.allow_negative_stock === '1';
    const allowExpiredNegativeSales = settings.allow_expired_negative_sales !== '0';

    // --- تحضير بيانات المنتجات والمخزون ---
    const productIds = items.map(item => item.product_id).filter(id => id);
    let productsMap = {};
    if (productIds.length) {
      const productRows = await dbAll(tx, `SELECT id, stock_quantity, cost, expiry_date FROM products WHERE id IN (${productIds.join(',')})`);
      productsMap = productRows.reduce((acc, p) => { acc[p.id] = p; return acc; }, {});
    }

    let allSupplierStocks = [];
    if (productIds.length) {
      allSupplierStocks = await dbAll(tx, `
        SELECT product_id, id, quantity, supplier_id, last_purchase_price
        FROM product_supplier_stock
        WHERE product_id IN (${productIds.join(',')}) AND quantity > 0
        ORDER BY product_id, id ASC
      `);
    }
    const stockMap = {};
    for (const stock of allSupplierStocks) {
      if (!stockMap[stock.product_id]) stockMap[stock.product_id] = [];
      stockMap[stock.product_id].push(stock);
    }

    // --- التحقق من صلاحية المنتجات (سعر أقل من التكلفة / مخزون) ---
    for (const item of items) {
      if (item.product_id) {
        const product = productsMap[item.product_id];
        if (!product) throw new Error(`المنتج ${item.product_id} غير موجود`);
        if (!product.is_decimal_allowed && !Number.isInteger(Number(item.quantity))) throw new Error(`المنتج ${item.product_id} لا يسمح بالكميات العشرية`);
        if (Number(item.quantity) <= 0) throw new Error(`الكمية يجب أن تكون أكبر من صفر للمنتج ${item.product_id}`);
        if (!allowBelowCost && item.unit_price < product.cost) {
          throw new Error(`سعر البيع أقل من التكلفة للمنتج ${item.product_name}`);
        }
        const expiredNegativeAllowed = allowExpiredNegativeSales && isExpiredProductDate(product.expiry_date);
        if (!allowNegativeStock && !expiredNegativeAllowed && product.stock_quantity < item.quantity) {
          throw new Error(`الكمية غير كافية للمنتج ${item.product_name}`);
        }
      }
    }

    // --- إنشاء الطلب والفاتورة ---
    const invoiceNumber = `INV-WEB-${await getNextInvoiceNumber(tx, 'online')}`;
    const orderResult = await dbRun(tx, `
      INSERT INTO online_orders 
        (customer_name, customer_phone, customer_address, governorate, delivery_type, 
         payment_method, total_amount, notes, created_by_user, delivery_fee, delivery_fee_payment,
         actual_payment_details, online_customer_id, order_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
     `, [customer_name, mainPhone, customer_address, governorate || null, delivery_type || null,
         normalizedPaymentMethod, total, notes || '', 1, delivery_fee, delivery_fee_payment,
         JSON.stringify(prepaidDetails), onlineCustomerId, order_date || null]);
    const orderId = orderResult.lastInsertRowid;

    const saleResult = await dbRun(tx, `
      INSERT INTO sales 
        (invoice_number, customer_id, total_amount, discount, discount_type, payment_method, 
         cash_paid, wallet_paid, wallet_id, paid_amount, status, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [invoiceNumber, customer.id, total, discount_amount, discount_type, salePaymentMethod, cashPaid, walletPaid, walletId, paidAmount, saleStatus, `طلب إنترنت #${orderId} ${isPrepaid ? '(مدفوع مسبقاً)' : (isMixed ? '(مختلط: محفظة + نقدي عند الاستلام)' : '(قيد التوصيل)')}`]);
    const saleId = saleResult.lastInsertRowid;
    await dbRun(tx, "UPDATE online_orders SET accounting_invoice_id = ? WHERE id = ?", [saleId, orderId]);

    // --- تحديث المخزون وتسجيل الحركات ---
    const stockCache = {};
    if (productIds.length) {
      const stockRows = await dbAll(tx, 
        `SELECT id, stock_quantity FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`,
        productIds
      );
      stockRows.forEach(row => {
        stockCache[row.id] = parseFloat(row.stock_quantity) || 0;
      });
    }

    const batchQueries = [];
    let totalCost = 0;

    // إدراج عناصر الطلب
    for (const item of items) {
      batchQueries.push({
        sql: "INSERT INTO online_order_items (order_id, product_id, product_name, quantity, unit_price, line_total, note, discount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        args: [orderId, item.product_id || null, item.product_name, item.quantity, item.unit_price, ((item.unit_price - (item.discount || 0)) * item.quantity), item.notes || item.note || item.product_note || '', item.discount || 0]
      });
    }

    // خصم المخزون وتسجيل الحركة
    for (const item of items) {
      const product = productsMap[item.product_id];
      if (!product) throw new Error(`المنتج ${item.product_id} غير موجود`);
      const costPrice = product.cost || 0;
      totalCost += costPrice * item.quantity;

      const stocks = stockMap[item.product_id] || [];
      let remaining = item.quantity;
      let supplierId = null;
      let supplierPrice = costPrice;
      const updateStockQueries = [];

      for (const stock of stocks) {
        if (remaining <= 0) break;
        const deductQty = Math.min(stock.quantity, remaining);
        updateStockQueries.push({
          sql: "UPDATE product_supplier_stock SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          args: [deductQty, stock.id]
        });
        if (!supplierId) {
          supplierId = stock.supplier_id;
          supplierPrice = stock.last_purchase_price || costPrice;
        }
        remaining -= deductQty;
      }

      if (remaining > 0 && !allowNegativeStock) {
        throw new Error(`الكمية غير كافية للمنتج ${item.product_name}`);
      }

      batchQueries.push(...updateStockQueries);

      await applyStockChange(tx, batchQueries, {
        productId: item.product_id,
        supplierId,
        delta: -item.quantity,
        referenceType: 'online_order',
        referenceId: orderId,
        note: `طلب إنترنت #${orderId}`,
        userId,
        stockCache
      });

      batchQueries.push({
        sql: `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total_price, cost_price, supplier_id, supplier_price, discount)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [saleId, item.product_id, item.quantity, item.unit_price, ((item.unit_price - (item.discount || 0)) * item.quantity), costPrice, supplierId, supplierPrice, item.discount || 0]
      });
    }

    const productRevenue = total - delivery_fee;
    const profit = productRevenue - totalCost;
    batchQueries.push({
      sql: "UPDATE sales SET profit = ?, total_cost = ? WHERE id = ?",
      args: [profit, totalCost, saleId]
    });

    // --- تعيين مندوب (إن وُجد) ---
    if (driver_id) {
      batchQueries.push({
        sql: "UPDATE online_orders SET assigned_driver_id = ?, status = 'مُسند لمندوب' WHERE id = ?",
        args: [driver_id, orderId]
      });
      batchQueries.push({
        sql: "INSERT INTO delivery_assignments (order_id, driver_id) VALUES (?, ?)",
        args: [orderId, driver_id]
      });
    }
    batchQueries.push({
      sql: "INSERT INTO order_status_log (order_id, new_status, status) VALUES (?, ?, ?)",
      args: [orderId, isPrepaid ? 'مدفوع مسبقاً' : 'جديد', isPrepaid ? 'مدفوع مسبقاً' : 'جديد']
    });

    // --- القيود المحاسبية ---
    const entryDate = new Date().toISOString().split('T')[0];
    if (isPrepaid && saleStatus === 'completed') {
      const desc = `فاتورة مبيعات ${invoiceNumber} (طلب إنترنت #${orderId}) مدفوع مسبقاً`;
      const journalDetails = [];
      const rate = getCurrencyRateFast(useCurrencyId);
      const baseAmount = convertToBase(walletPaid, rate);
      if (walletPaid > 0) {
        journalDetails.push({ account_id: walletAccountId, debit: baseAmount, credit: 0 });
        batchQueries.push({
          sql: "INSERT OR IGNORE INTO wallet_balances (wallet_id, currency_id, balance) VALUES (?, ?, 0)",
          args: [walletId, useCurrencyId]
        });
        batchQueries.push({
          sql: "UPDATE wallet_balances SET balance = balance + ? WHERE wallet_id = ? AND currency_id = ?",
          args: [walletPaid, walletId, useCurrencyId]
        });
        batchQueries.push({
          sql: "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'deposit', ?, ?, ?, ?)",
          args: [walletId, walletPaid, useCurrencyId, desc, saleId]
        });
      }
      if (productRevenue > 0) journalDetails.push({ account_id: saleAccountId, debit: 0, credit: productRevenue });
      if (delivery_fee > 0) journalDetails.push({ account_id: deliveryFeeAccountId, debit: 0, credit: delivery_fee });
      if (journalDetails.length > 0) {
        checkBalance(journalDetails);
        await createJournalEntry(tx, entryDate, desc, journalDetails, 'sale', saleId);
      }
      if (totalCost > 0) {
        const cogsDetails = [
          { account_id: cogsAccountId, debit: totalCost, credit: 0 },
          { account_id: inventoryAccountId, debit: 0, credit: totalCost }
        ];
        await createJournalEntry(tx, entryDate, `تكلفة طلب إنترنت #${orderId}`, cogsDetails, 'sale_cogs', saleId);
      }
    } else if (isMixed) {
      // قيد الدفع المختلط
      const customerReceivableId = getAccountIdFast('الذمم المدينة (عملاء)');
      const desc = `فاتورة مبيعات ${invoiceNumber} (طلب إنترنت #${orderId}) مختلط`;
      const walletRate = getCurrencyRateFast(wallet_currency_id || useCurrencyId);
      const cashRate = getCurrencyRateFast(useCurrencyId);
      const walletPaidBase = convertToBase(walletPaid, walletRate);
      const collectBase = convertToBase(cashPaid, cashRate);
      const journalDetails = [
        { account_id: walletAccountId, debit: walletPaidBase, credit: 0 },
        { account_id: customerReceivableId, debit: collectBase, credit: 0 }
      ];
      if (productRevenue > 0) journalDetails.push({ account_id: saleAccountId, debit: 0, credit: convertToBase(productRevenue, cashRate) });
      if (delivery_fee > 0) journalDetails.push({ account_id: deliveryFeeAccountId, debit: 0, credit: convertToBase(delivery_fee, cashRate) });
      checkBalance(journalDetails);
      await createJournalEntry(tx, entryDate, desc, journalDetails, 'sale', saleId);
      if (totalCost > 0) {
        const cogsDetails = [
          { account_id: cogsAccountId, debit: convertToBase(totalCost, cashRate), credit: 0 },
          { account_id: inventoryAccountId, debit: 0, credit: convertToBase(totalCost, cashRate) }
        ];
        await createJournalEntry(tx, entryDate, `تكلفة طلب إنترنت #${orderId}`, cogsDetails, 'sale_cogs', saleId);
      }
      // إضافة مبلغ المحفظة إلى رصيد المحفظة
      await ensureWalletBalance(tx, walletId, wallet_currency_id || useCurrencyId);
      batchQueries.push({
        sql: "UPDATE wallet_balances SET balance = balance + ? WHERE wallet_id = ? AND currency_id = ?",
        args: [walletPaid, walletId, wallet_currency_id || useCurrencyId]
      });
      batchQueries.push({
        sql: "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'deposit', ?, ?, ?, ?)",
        args: [walletId, walletPaid, wallet_currency_id || useCurrencyId, desc, saleId]
      });
    } else if (!isPrepaid && delivery_fee > 0) {
      // تسجيل رسوم التوصيل (للطلبات غير المدفوعة مسبقاً)
      const desc = `التزام رسوم توصيل للطلب #${orderId}`;
      const journalDetails = [];
      if (payment_method === 'credit') {
        const customerReceivableId = getAccountIdFast('الذمم المدينة (عملاء)');
        journalDetails.push({ account_id: customerReceivableId, debit: total, credit: 0 });
        const salesRevenue = total - delivery_fee;
        journalDetails.push({ account_id: saleAccountId, debit: 0, credit: salesRevenue });
      }
      journalDetails.push({ account_id: deliveryFeeAccountId, debit: 0, credit: delivery_fee });
      if (journalDetails.length > 1) {
        checkBalance(journalDetails);
        await createJournalEntry(tx, entryDate, desc, journalDetails, 'sale', saleId);
      }
    } else if (!isPrepaid && salePaymentMethod === 'credit') {
      // قيد للطلب الآجل (حتى بلا رسوم توصيل)
      const customerReceivableId = getAccountIdFast('الذمم المدينة (عملاء)');
      const desc = `فاتورة مبيعات ${invoiceNumber} (طلب إنترنت #${orderId}) آجل`;
      const rate = getCurrencyRateFast(useCurrencyId);
      const journalDetails = [
        { account_id: customerReceivableId, debit: convertToBase(total, rate), credit: 0 },
        { account_id: saleAccountId, debit: 0, credit: convertToBase(productRevenue, rate) }
      ];
      if (delivery_fee > 0) journalDetails.push({ account_id: deliveryFeeAccountId, debit: 0, credit: convertToBase(delivery_fee, rate) });
      checkBalance(journalDetails);
      await createJournalEntry(tx, entryDate, desc, journalDetails, 'sale', saleId);
      if (totalCost > 0) {
        const cogsDetails = [
          { account_id: cogsAccountId, debit: convertToBase(totalCost, rate), credit: 0 },
          { account_id: inventoryAccountId, debit: 0, credit: convertToBase(totalCost, rate) }
        ];
        await createJournalEntry(tx, entryDate, `تكلفة طلب إنترنت #${orderId}`, cogsDetails, 'sale_cogs', saleId);
      }
    }

    // --- تنفيذ الدفعات على أجزاء ---
    const BATCH_SIZE = 40;
    for (let i = 0; i < batchQueries.length; i += BATCH_SIZE) {
      const chunk = batchQueries.slice(i, i + BATCH_SIZE);
      await tx.batch(chunk, 'write');
    }

    await tx.commit();
    committed = true;

    // ما بعد commit (قراءة اسم المحفظة والإشعارات) لا يجوز أن يحول نجاح الحفظ إلى 500.
    try {
      let walletName = null;
      if (prepaid_wallet_id) {
        const w = await dbFirst(client, "SELECT name FROM wallets WHERE id = ?", [prepaid_wallet_id]);
        walletName = w ? w.name : null;
      }

      if (driver_id) {
        const itemCount = items.length;
        const currency = 'ريال';
        ctx.waitUntil(sendFCMNotification(
          env,
          `📦 طلب جديد #${orderId}`,
          `👤 العميل: ${customer_name}\n💰 المبلغ: ${total} ${currency}\n📦 عدد الأصناف: ${itemCount}\n💳 طريقة الدفع: ${normalizedPaymentMethod}\n📍 العنوان: ${customer_address.substring(0, 40)}...`,
          null,
          `https://pos.ibnalmukhtar.com/driver/?order=${orderId}`,
          driver_id
        ));
      } else {
        ctx.waitUntil(sendAdminFCMNotification(
          env,
          '📦 طلب جديد',
          `طلب #${orderId} من ${customer_name} في انتظار التعيين`
        ));
      }

      return jsonResponse({
        success: true,
        order_id: orderId,
        sale_id: saleId,
        wallet_name: walletName,
        message: isPrepaid ? 'تم إنشاء الطلب والفاتورة والدفع' : 'تم إنشاء الطلب وخصم المخزون، في انتظار التوصيل'
      }, 200, headers);
    } catch (postCommitError) {
      console.error('نجح حفظ الطلب لكن تعذر تنفيذ ما بعد commit:', postCommitError.message);
      return jsonResponse({ success: true, order_id: orderId, sale_id: saleId,
        wallet_name: null,
        message: isPrepaid ? 'تم إنشاء الطلب والفاتورة والدفع' : 'تم إنشاء الطلب وخصم المخزون، في انتظار التوصيل',
        warning: 'تم حفظ الطلب، لكن تعذر جلب بعض بيانات الرد أو إرسال الإشعار' }, 200, headers);
    }

  } catch (error) {
    if (committed) {
      return jsonResponse({ success: true,
        warning: 'تم حفظ الطلب، لكن حدث خطأ بعد commit' }, 200, headers);
    }
    try { await tx.rollback(); } catch (rollbackError) { console.error('فشل rollback:', rollbackError.message); }
    return jsonResponse({ error: 'فشل حفظ الطلب: ' + error.message }, 500, headers);
  }
}

async function updateOnlineOrder(request, env, ctx, headers, orderId, userId) {
  const {
    customer_name,
    customer_phones,
    customer_address,
    governorate,
    delivery_type,
    payment_method,
    items,
    notes,
    prepaid_payment_method,
    prepaid_wallet_id,
    prepaid_cash_amount,
    prepaid_wallet_amount,
    driver_id,
    total_amount,
    delivery_fee = 0,
    delivery_fee_payment = 'مع الطلب',
    currency_id,
    cash_currency_id,
    wallet_currency_id,
    discount = 0,           // <--- أضف هذا
    discount_amount = 0,    // <--- أضف هذا
    discount_type = 'fixed',
    order_date
  } = await request.json();

  if (!orderId) {
    return jsonResponse({ error: 'معرف الطلب مطلوب' }, 400, headers);
  }
  if (!items || items.length === 0) {
    return jsonResponse({ error: 'السلة فارغة' }, 400, headers);
  }

  const client = getTursoClient(env);
  await checkIfClosed(client, new Date().toISOString().slice(0, 10));
  const baseCurrency = await getBaseCurrency(client);
  if (!baseCurrency) {
    return jsonResponse({ error: 'لا توجد عملة أساسية' }, 400, headers);
  }
  const useCurrencyId = currency_id || baseCurrency.id;

  const accounts = await dbAll(client, "SELECT id, name FROM accounts");
  const accountsMap = Object.fromEntries(accounts.map(a => [a.name, a.id]));
  const getAccountIdFast = (name) => {
    if (!accountsMap[name]) throw new Error(`الحساب "${name}" غير موجود`);
    return accountsMap[name];
  };
  const currencies = await dbAll(client, "SELECT id, rate_to_base FROM currencies");
  const currenciesMap = Object.fromEntries(currencies.map(c => [c.id, c.rate_to_base]));
  const getCurrencyRateFast = (id) => {
    if (!currenciesMap[id]) throw new Error(`العملة ${id} غير موجودة`);
    return currenciesMap[id];
  };

  if (!currenciesMap[useCurrencyId]) {
    return jsonResponse({ error: `العملة ${useCurrencyId} غير موجودة في النظام` }, 400, headers);
  }

  let cashAccountId, walletAccountId, saleAccountId, cogsAccountId, inventoryAccountId, deliveryFeeAccountId;
  try {
    cashAccountId = getAccountIdFast('الصندوق');
    walletAccountId = getAccountIdFast('المحافظ');
    saleAccountId = getAccountIdFast('المبيعات');
    cogsAccountId = getAccountIdFast('تكلفة البضاعة المباعة');
    inventoryAccountId = getAccountIdFast('المخزون');
    deliveryFeeAccountId = getAccountIdFast('رسوم التوصيل المستحقة');
  } catch (e) {
    return jsonResponse({ error: 'خطأ في الحسابات المحاسبية: ' + e.message }, 500, headers);
  }

  const existingOrder = await dbFirst(client, "SELECT * FROM online_orders WHERE id = ?", [orderId]);
  if (!existingOrder) {
    return jsonResponse({ error: 'الطلب غير موجود' }, 400, headers);
  }

  const sale = await dbFirst(client, "SELECT * FROM sales WHERE id = ?", [existingOrder.accounting_invoice_id]);
  if (!sale) {
    return jsonResponse({ error: 'الفاتورة غير موجودة' }, 400, headers);
  }

  const allPhones = customer_phones.filter(p => p && p.trim());
  const mainPhone = allPhones[0] || '';

  const tx = await client.transaction();
  let committed = false;
  try {
    const settings = await getSettingsCached(tx);
    const allowBelowCost = settings.allow_below_cost === '1';
    const allowNegativeStock = settings.allow_negative_stock === '1';
    const allowExpiredNegativeSales = settings.allow_expired_negative_sales !== '0';

    // ===== إصلاح TDZ: تعريف المتغيرات في بداية النطاق قبل أي استخدام =====
    const total = total_amount || items.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0) + delivery_fee;
    const normalizedPaymentMethod = normalizePaymentMethod(payment_method);
    const isPrepaid = normalizedPaymentMethod === 'مدفوع مسبقاً';
    // تهيئة أولية لبقية المتغيرات حتى يمكن استخدامها في أي مكان لاحق داخل النطاق
    let walletPaid = 0, walletId = null, cashPaid = 0, paidAmount = 0;
    let saleStatus = isPrepaid ? 'completed' : 'pending';
    let salePaymentMethod = isPrepaid ? 'wallet' : 'pending';

    const newProductIds = items.map(item => item.product_id).filter(id => id);
    let productsMap = {};
    if (newProductIds.length) {
      const productRows = await dbAll(tx, `SELECT id, stock_quantity, cost, expiry_date FROM products WHERE id IN (${newProductIds.join(',')})`);
      productsMap = productRows.reduce((acc, p) => { acc[p.id] = p; return acc; }, {});
    }

    let allSupplierStocks = [];
    if (newProductIds.length) {
      allSupplierStocks = await dbAll(tx, `
        SELECT product_id, id, quantity, supplier_id, last_purchase_price
        FROM product_supplier_stock
        WHERE product_id IN (${newProductIds.join(',')}) AND quantity > 0
        ORDER BY product_id, id ASC
      `);
    }
    const stockMap = {};
    for (const stock of allSupplierStocks) {
      if (!stockMap[stock.product_id]) stockMap[stock.product_id] = [];
      stockMap[stock.product_id].push(stock);
    }

    for (const item of items) {
      if (item.product_id) {
        const product = productsMap[item.product_id];
        if (!product) throw new Error(`المنتج ${item.product_id} غير موجود`);
        if (!product.is_decimal_allowed && !Number.isInteger(Number(item.quantity))) throw new Error(`المنتج ${item.product_id} لا يسمح بالكميات العشرية`);
        if (Number(item.quantity) <= 0) throw new Error(`الكمية يجب أن تكون أكبر من صفر للمنتج ${item.product_id}`);
        if (!allowBelowCost && item.unit_price < product.cost) {
          throw new Error(`سعر البيع أقل من التكلفة للمنتج ${item.product_name}`);
        }
        const expiredNegativeAllowed = allowExpiredNegativeSales && isExpiredProductDate(product.expiry_date);
        if (!allowNegativeStock && !expiredNegativeAllowed && product.stock_quantity < item.quantity) {
          throw new Error(`الكمية غير كافية للمنتج ${item.product_name}`);
        }
      }
    }

    // ===== عكس العمليات السابقة (استرجاع المخزون) =====
    const oldItems = await dbAll(tx, "SELECT product_id, quantity FROM sale_items WHERE sale_id = ?", [sale.id]);
    // جلب كميات المخزون الحالية دفعة واحدة للاسترجاع
    const oldProductIds = oldItems.map(item => item.product_id).filter(id => id);
    const stockCacheRestore = {};
    if (oldProductIds.length) {
      const stockRows = await dbAll(tx,
        `SELECT id, stock_quantity FROM products WHERE id IN (${oldProductIds.map(() => '?').join(',')})`,
        oldProductIds
      );
      stockRows.forEach(row => {
        stockCacheRestore[row.id] = parseFloat(row.stock_quantity) || 0;
      });
    }

    const restoreQueries = [];
    for (const old of oldItems) {
      await applyStockChange(tx, restoreQueries, {
        productId: old.product_id,
        supplierId: null,
        delta: old.quantity,
        referenceType: 'update_online_order_revert',
        referenceId: orderId,
        note: `عكس خصم طلب #${orderId} قبل التعديل`,
        userId,
        stockCache: stockCacheRestore
      });
    }
    if (restoreQueries.length > 0) {
      await tx.batch(restoreQueries, 'write');
    }

    // ===== إلغاء المدفوعات القديمة (نقدي/محفظة) =====
    const oldIsPrepaid = isPrepaidOrder(existingOrder);
    const oldIsMixed = isMixedOrder(existingOrder);
    const oldWalletId = sale.wallet_id;
    const oldCashPaid = parseFloat(sale.cash_paid) || 0;
    const oldWalletPaid = parseFloat(sale.wallet_paid) || 0;
    const oldTotal = parseFloat(sale.total_amount) || 0;
    const oldPaymentMethod = sale.payment_method;

    if ((oldIsPrepaid || oldIsMixed) && oldWalletId && oldWalletPaid > 0.01) {
      const walletTxOld = await dbFirst(tx,
        "SELECT currency_id FROM wallet_transactions WHERE reference_id = ? AND type = 'deposit' LIMIT 1",
        [sale.id]
      );
      const walletCurrencyId = walletTxOld ? walletTxOld.currency_id : baseCurrency.id;
      let walletRate = await getCurrencyRate(tx, walletCurrencyId);
      if (!walletRate) walletRate = 1;
      await dbRun(tx,
        "UPDATE wallet_balances SET balance = balance - ? WHERE wallet_id = ? AND currency_id = ?",
        [oldWalletPaid, oldWalletId, walletCurrencyId]
      );
      await dbRun(tx,
        "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'withdraw', ?, ?, ?, ?)",
        [oldWalletId, oldWalletPaid, walletCurrencyId, `عكس دفع طلب #${orderId} (تعديل)`, sale.id]
      );
    }

    // في الدفع المختلط، cash_paid هو مبلغ سيُحصّل عند التسليم وليس مبلغًا مدفوعًا سابقًا.
    if (oldCashPaid > 0.01 && !oldIsMixed) {
      const cashOld = await dbFirst(tx,
        "SELECT currency_id, exchange_rate FROM cash_register WHERE note LIKE ? ORDER BY created_at DESC LIMIT 1",
        [`%${sale.invoice_number}%`]
      );
      const cashCurrencyId = cashOld ? cashOld.currency_id : baseCurrency.id;
      const cashRate = cashOld ? cashOld.exchange_rate : baseCurrency.rate_to_base;
      await dbRun(tx,
        "INSERT INTO cash_register (type, amount, currency_id, exchange_rate, note) VALUES ('withdraw', ?, ?, ?, ?)",
        [oldCashPaid, cashCurrencyId, cashRate, `عكس دفع طلب #${orderId} (نقدي)`]
      );
    }

    if (oldPaymentMethod === 'credit' && sale.customer_id) {
      await dbRun(tx,
        "UPDATE customers SET balance = balance - ? WHERE id = ?",
        [oldTotal, sale.customer_id]
      );
    }

    // حذف القيود القديمة
    await dbRun(tx, "DELETE FROM journal_entry_details WHERE entry_id IN (SELECT id FROM journal_entries WHERE reference_type IN ('sale','sale_cogs') AND reference_id = ?)", [sale.id]);
    await dbRun(tx, "DELETE FROM journal_entries WHERE reference_type IN ('sale','sale_cogs') AND reference_id = ?", [sale.id]);
    await dbRun(tx, "DELETE FROM journal_entry_details WHERE entry_id IN (SELECT id FROM journal_entries WHERE reference_type = 'online_order' AND reference_id = ?)", [orderId]);
    await dbRun(tx, "DELETE FROM journal_entries WHERE reference_type = 'online_order' AND reference_id = ?", [orderId]);

    // ===== إصلاح #9 (تعديل الطلب): حماية مستقبلية لمسار الدفع الآجل عند تعديل الطلب أونلاين =====
    if (!isPrepaid && (normalizedPaymentMethod || '').toLowerCase().includes('credit')) {
      salePaymentMethod = 'credit';
    }

    // ===== إصلاح #10 (تعديل الطلب): الدفع المختلط — المحفظة تُقضى أصلًا والباقي نقدي عند الاستلام =====
    // ===== إصلاح #10 (تعديل الطلب): الدفع المختلط — المحفظة تُقضى أصلًا والباقي نقدي عند الاستلام =====
// إصلاح: الشرط القديم كان يتحقق فقط من الكلمة الإنجليزية "mixed"، بينما normalizePaymentMethod
// يُرجع دائمًا القيمة العربية "مختلط" — فكانت حالة التعديل إلى مختلط لا تُكتشف أبدًا.
const isMixedUpdate = !isPrepaid && (normalizedPaymentMethod === 'مختلط' || (normalizedPaymentMethod || '').toLowerCase().includes('mixed'));
if (isMixedUpdate) {
      if (!prepaid_wallet_id) throw new Error('معرف المحفظة مطلوب للدفع المختلط');
      if (!prepaid_wallet_amount || parseFloat(prepaid_wallet_amount) <= 0) throw new Error('مبلغ الدفع بالمحفظة مطلوب وموجب في الدفع المختلط');
      const updWalletCurrencyId = wallet_currency_id || useCurrencyId;
      if (!currenciesMap[updWalletCurrencyId]) throw new Error(`عملة المحفظة ${updWalletCurrencyId} غير موجودة`);
      const updWalletRate = getCurrencyRateFast(updWalletCurrencyId);
      const updCashRate = getCurrencyRateFast(useCurrencyId);
      const updTotalBase = convertToBase(total, updCashRate);
      walletPaid = parseFloat(prepaid_wallet_amount);
      walletId = prepaid_wallet_id;
      const updWalletPaidBase = convertToBase(walletPaid, updWalletRate);
      if (updWalletPaidBase >= updTotalBase - 0.01) throw new Error('مبلغ المحفظة لا يجب أن يغطي الإجمالي كاملًا؛ استخدم الدفع المسبق');
      cashPaid = convertFromBase(updTotalBase - updWalletPaidBase, updCashRate);
      salePaymentMethod = 'mixed';
      saleStatus = 'pending';
      paidAmount = updWalletPaidBase;
      await ensureWalletBalance(tx, walletId, updWalletCurrencyId);
      await dbRun(tx, "UPDATE wallet_balances SET balance = balance + ? WHERE wallet_id = ? AND currency_id = ?", [walletPaid, walletId, updWalletCurrencyId]);
      await dbRun(tx, "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'deposit', ?, ?, ?, ?)",
        [walletId, walletPaid, updWalletCurrencyId, `تحديث طلب #${orderId} (مختلط)`, sale.id]);
    }

    // حذف عناصر الفاتورة القديمة
    await dbRun(tx, "DELETE FROM sale_items WHERE sale_id = ?", [sale.id]);
    await dbRun(tx, "DELETE FROM online_order_items WHERE order_id = ?", [orderId]);

    // ===== حساب المبالغ النهائية ===== (لا نمسح إعدادات الدفع المختلط المحسوبة أعلاه)
    if (!isMixedUpdate) {
      saleStatus = isPrepaid ? 'completed' : 'pending';
      salePaymentMethod = isPrepaid ? 'wallet' : 'pending';
    }

    if (isPrepaid) {
      const walletRate = getCurrencyRateFast(useCurrencyId);
      walletPaid = convertFromBase(total, walletRate);
      walletId = prepaid_wallet_id;
      if (!walletId) throw new Error('معرف المحفظة مطلوب للدفع المسبق');
      await dbRun(tx, "UPDATE wallet_balances SET balance = balance + ? WHERE wallet_id = ? AND currency_id = ?", [walletPaid, walletId, useCurrencyId]);
      await dbRun(tx, "INSERT INTO wallet_transactions (wallet_id, type, amount, currency_id, description, reference_id) VALUES (?, 'deposit', ?, ?, ?, ?)",
        [walletId, walletPaid, useCurrencyId, `تحديث طلب #${orderId}`, sale.id]);
    }

    await dbRun(tx, `UPDATE sales SET 
      total_amount = ?, payment_method = ?, cash_paid = ?, wallet_paid = ?, wallet_id = ?, 
      paid_amount = ?, status = ?, note = ?, discount = ?, discount_type = ? WHERE id = ?`,
      [total, salePaymentMethod, cashPaid, walletPaid, walletId, isPrepaid ? total : (isMixedUpdate ? paidAmount : 0), saleStatus, `طلب إنترنت #${orderId}`, discount_amount, discount_type, sale.id]);
    await dbRun(tx, `UPDATE online_orders SET 
      customer_name = ?, customer_phone = ?, customer_address = ?, governorate = ?, 
      delivery_type = ?, payment_method = ?, total_amount = ?, notes = ?, 
      delivery_fee = ?, delivery_fee_payment = ?, order_date = COALESCE(?, order_date) WHERE id = ?`,
      [customer_name, mainPhone, customer_address, governorate, delivery_type, normalizedPaymentMethod, total, notes, delivery_fee, delivery_fee_payment, order_date || null, orderId]);

    // ===== جلب كميات المخزون دفعة واحدة للخصم الجديد =====
    const stockCacheNew = {};
    if (newProductIds.length) {
      const stockRows = await dbAll(tx,
        `SELECT id, stock_quantity FROM products WHERE id IN (${newProductIds.map(() => '?').join(',')})`,
        newProductIds
      );
      stockRows.forEach(row => {
        stockCacheNew[row.id] = parseFloat(row.stock_quantity) || 0;
      });
    }

    const batchQueries = [];
    let totalCost = 0;

    // إدراج عناصر الطلب الجديدة
   // إدراج عناصر الطلب الجديدة
    for (const item of items) {
      batchQueries.push({
        sql: "INSERT INTO online_order_items (order_id, product_id, product_name, quantity, unit_price, line_total, note, discount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        args: [orderId, item.product_id, item.product_name, item.quantity, item.unit_price, ((item.unit_price - (item.discount || 0)) * item.quantity), item.notes || '', item.discount || 0]
      });
    }

    // خصم المخزون الجديد
    for (const item of items) {
      const product = productsMap[item.product_id];
      const costPrice = product ? product.cost : 0;
      totalCost += costPrice * item.quantity;

      const stocks = stockMap[item.product_id] || [];
      let remaining = item.quantity;
      let supplierId = null;
      let supplierPrice = costPrice;
      const updateStockQueries = [];

      for (const stock of stocks) {
        if (remaining <= 0) break;
        const deductQty = Math.min(stock.quantity, remaining);
        updateStockQueries.push({
          sql: "UPDATE product_supplier_stock SET quantity = quantity - ? WHERE id = ?",
          args: [deductQty, stock.id]
        });
        if (!supplierId) {
          supplierId = stock.supplier_id;
          supplierPrice = stock.last_purchase_price || costPrice;
        }
        remaining -= deductQty;
      }

      if (remaining > 0 && !allowNegativeStock) {
        throw new Error(`الكمية غير كافية للمنتج ${item.product_name}`);
      }

      batchQueries.push(...updateStockQueries);

      await applyStockChange(tx, batchQueries, {
        productId: item.product_id,
        supplierId,
        delta: -item.quantity,
        referenceType: 'update_online_order',
        referenceId: orderId,
        note: `تحديث طلب #${orderId}`,
        userId,
        stockCache: stockCacheNew
      });

      batchQueries.push({
        sql: `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total_price, cost_price, supplier_id, supplier_price, discount)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [sale.id, item.product_id, item.quantity, item.unit_price, ((item.unit_price - (item.discount || 0)) * item.quantity), costPrice, supplierId, supplierPrice, item.discount || 0]
      });
    }

    const productRevenue = total - delivery_fee;
    const profit = productRevenue - totalCost;
    batchQueries.push({
      sql: "UPDATE sales SET profit = ?, total_cost = ? WHERE id = ?",
      args: [profit, totalCost, sale.id]
    });

    const entryDate = new Date().toISOString().split('T')[0];
    if (isPrepaid && saleStatus === 'completed') {
      const desc = `فاتورة مبيعات ${sale.invoice_number} (طلب إنترنت #${orderId}) مدفوع مسبقاً`;
      const journalDetails = [];
      const rate = getCurrencyRateFast(useCurrencyId);
      const baseAmount = convertToBase(walletPaid, rate);
      if (walletPaid > 0) {
        journalDetails.push({ account_id: walletAccountId, debit: baseAmount, credit: 0 });
      }
      if (productRevenue > 0) journalDetails.push({ account_id: saleAccountId, debit: 0, credit: productRevenue });
      if (delivery_fee > 0) journalDetails.push({ account_id: deliveryFeeAccountId, debit: 0, credit: delivery_fee });
      if (journalDetails.length > 0) {
        checkBalance(journalDetails);
        await createJournalEntry(tx, entryDate, desc, journalDetails, 'sale', sale.id);
      }
      if (totalCost > 0) {
        const cogsDetails = [
          { account_id: cogsAccountId, debit: totalCost, credit: 0 },
          { account_id: inventoryAccountId, debit: 0, credit: totalCost }
        ];
        await createJournalEntry(tx, entryDate, `تكلفة طلب إنترنت #${orderId}`, cogsDetails, 'sale_cogs', sale.id);
      }
    } else if (isMixedUpdate) {
      // ===== إصلاح #10 (تعديل الطلب): قيد كامل للدفع المختلط =====
      const customerReceivableId = getAccountIdFast('الذمم المدينة (عملاء)');
      const desc = `فاتورة مبيعات ${sale.invoice_number} (طلب إنترنت #${orderId}) مختلط`;
      const mWalletRate = getCurrencyRateFast(wallet_currency_id || useCurrencyId);
      const mCashRate = getCurrencyRateFast(useCurrencyId);
      const mWalletPaidBase = convertToBase(walletPaid, mWalletRate);
      const mCollectBase = convertToBase(cashPaid, mCashRate);
      const journalDetails = [
        { account_id: walletAccountId, debit: mWalletPaidBase, credit: 0 },
        { account_id: customerReceivableId, debit: mCollectBase, credit: 0 }
      ];
      if (productRevenue > 0) journalDetails.push({ account_id: saleAccountId, debit: 0, credit: convertToBase(productRevenue, mCashRate) });
      if (delivery_fee > 0) journalDetails.push({ account_id: deliveryFeeAccountId, debit: 0, credit: convertToBase(delivery_fee, mCashRate) });
      checkBalance(journalDetails);
      await createJournalEntry(tx, entryDate, desc, journalDetails, 'sale', sale.id);
      if (totalCost > 0) {
        const cogsDetails = [
          { account_id: cogsAccountId, debit: convertToBase(totalCost, mCashRate), credit: 0 },
          { account_id: inventoryAccountId, debit: 0, credit: convertToBase(totalCost, mCashRate) }
        ];
        await createJournalEntry(tx, entryDate, `تكلفة طلب إنترنت #${orderId}`, cogsDetails, 'sale_cogs', sale.id);
      }
    } else if (!isPrepaid && delivery_fee > 0) {
      const desc = `التزام رسوم توصيل للطلب #${orderId}`;
      const journalDetails = [];
      if (payment_method === 'credit') {
        const customerReceivableId = getAccountIdFast('الذمم المدينة (عملاء)');
        journalDetails.push({ account_id: customerReceivableId, debit: total, credit: 0 });
        const salesRevenue = total - delivery_fee;
        journalDetails.push({ account_id: saleAccountId, debit: 0, credit: salesRevenue });
      }
      journalDetails.push({ account_id: deliveryFeeAccountId, debit: 0, credit: delivery_fee });
      if (journalDetails.length > 1) {
        checkBalance(journalDetails);
        await createJournalEntry(tx, entryDate, desc, journalDetails, 'sale', sale.id);
      }
    } else if (!isPrepaid && salePaymentMethod === 'credit') {
      // ===== إصلاح #9: قيد كامل للطلب الآجل أونلاين (حتى بلا رسوم توصيل) =====
      const customerReceivableId = getAccountIdFast('الذمم المدينة (عملاء)');
      const desc = `فاتورة مبيعات ${sale.invoice_number} (طلب إنترنت #${orderId}) آجل`;
      const rate = getCurrencyRateFast(useCurrencyId);
      const journalDetails = [
        { account_id: customerReceivableId, debit: convertToBase(total, rate), credit: 0 },
        { account_id: saleAccountId, debit: 0, credit: convertToBase(productRevenue, rate) }
      ];
      if (delivery_fee > 0) journalDetails.push({ account_id: deliveryFeeAccountId, debit: 0, credit: convertToBase(delivery_fee, rate) });
      checkBalance(journalDetails);
      await createJournalEntry(tx, entryDate, desc, journalDetails, 'sale', sale.id);
      if (totalCost > 0) {
        const cogsDetails = [
          { account_id: cogsAccountId, debit: convertToBase(totalCost, rate), credit: 0 },
          { account_id: inventoryAccountId, debit: 0, credit: convertToBase(totalCost, rate) }
        ];
        await createJournalEntry(tx, entryDate, `تكلفة طلب إنترنت #${orderId}`, cogsDetails, 'sale_cogs', saleId);
      }
    }

    // ========== تنفيذ الدفعات على أجزاء ==========
    const BATCH_SIZE = 40;
    for (let i = 0; i < batchQueries.length; i += BATCH_SIZE) {
      const chunk = batchQueries.slice(i, i + BATCH_SIZE);
      await tx.batch(chunk, 'write');
    }

    await tx.commit();
    committed = true;

    try {
      // 1. إرسال إشعار للإدارة دائماً عند تعديل أي طلب
      ctx.waitUntil(sendAdminFCMNotification(
        env,
        `✏️ تعديل الطلب #${orderId}`,
        `تم تعديل بيانات الطلب #${orderId}`
      ));

      // 2. إرسال إشعار للمندوب المسند إليه الطلب (إن وجد)
      const targetDriverId = driver_id || existingOrder.assigned_driver_id;
      if (targetDriverId) {
        ctx.waitUntil(sendFCMNotification(
          env,
          `✏️ تعديل الطلب #${orderId}`,
          `تم تعديل بيانات الطلب #${orderId}، يرجى مراجعة التفاصيل`,
          null,
          `https://pos.ibnalmukhtar.com/driver/?order=${orderId}`,
          targetDriverId
        ));
      }

      return jsonResponse({
        success: true,
        order_id: orderId,
        sale_id: sale.id,
        message: 'تم تحديث الطلب'
      }, 200, headers);
    } catch (postCommitError) {
      console.error('نجح تحديث الطلب لكن تعذر تنفيذ الإشعارات:', postCommitError.message);
      return jsonResponse({ success: true, order_id: orderId, sale_id: sale.id,
        warning: 'تم تحديث الطلب، لكن تعذر إرسال بعض الإشعارات' }, 200, headers);
    }

  } catch (error) {
    if (committed) {
      return jsonResponse({ success: true, order_id: orderId, sale_id: sale.id,
        warning: 'تم تحديث الطلب، لكن حدث خطأ بعد commit' }, 200, headers);
    }
    try { await tx.rollback(); } catch (rollbackError) { console.error('فشل rollback:', rollbackError.message); }
    return jsonResponse({ error: 'فشل تحديث الطلب: ' + error.message }, 500, headers);
  }
}

// ================================================================
// ==================== Router الرئيسي =============================
// ================================================================

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      await ensureInitialized(env);
    } catch (e) {
      console.error('فشل تهيئة قاعدة البيانات:', e);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ---- نقاط عامة بدون مصادقة ----
    if (path === '/auth/login' && method === 'POST') return await handleLogin(request, env, corsHeaders);

    if (path === '/export-data' && method === 'GET') {
      const auth = await verifyToken(request, env);
      if (!auth) return jsonResponse({ error: 'غير مصرح' }, 401, corsHeaders);
      try {
        const client = getTursoClient(env);
        const tablesResult = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'");
        const tables = tablesResult.rows.map(r => r.name);
        const dbBackup = {};
        for (const table of tables) {
          const data = await client.execute(`SELECT * FROM ${table}`);
          dbBackup[table] = data.rows;
        }
        return new Response(JSON.stringify(dbBackup), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="database_backup.json"' }
        });
      } catch (e) { return jsonResponse({ error: 'فشل التصدير: ' + e.message }, 500, corsHeaders); }
    }

    if (path === '/test-notification' && method === 'POST') {
      if (!(await verifyToken(request, env))) return jsonResponse({ error: 'غير مصرح' }, 401, corsHeaders);
      try {
        const { title, body, link } = await request.json();
        const result = await sendFCMNotification(env, title, body, null, link);
        return jsonResponse(result, result.success ? 200 : 500, corsHeaders);
      } catch (e) {
        return jsonResponse({ error: e.message, stack: e.stack }, 500, corsHeaders);
      }
    }

    if (path === '/test-admin-notification' && method === 'POST') {
      if (!(await verifyToken(request, env))) return jsonResponse({ error: 'غير مصرح' }, 401, corsHeaders);
      try {
        const { title, body, link } = await request.json();
        const result = await sendAdminFCMNotification(env, title, body, link);
        return jsonResponse(result, result.success ? 200 : 500, corsHeaders);
      } catch (e) {
        return jsonResponse({ error: e.message, stack: e.stack }, 500, corsHeaders);
      }
    }
    if (path === '/fcm-tokens' && method === 'GET') {
      if (!(await verifyToken(request, env))) return jsonResponse({ error: 'غير مصرح' }, 401, corsHeaders);
      const client = getTursoClient(env);
      const driverTokens = await dbAll(client, "SELECT id, driver_id, token, created_at FROM fcm_tokens");
      const adminTokens = await dbAll(client, "SELECT id, token, created_at FROM admin_fcm_tokens");
      return jsonResponse({ driver_tokens: driverTokens, admin_tokens: adminTokens }, 200, corsHeaders);
    }

    // ---- مصادقة باقي المسارات ----
    const auth = await verifyToken(request, env);
    if (!auth) return jsonResponse({ error: 'غير مصرح' }, 401, corsHeaders);
    const currentUser = await getCurrentUser(request, env);
    const isAdmin = currentUser?.role === 'admin';
    const isDriver = currentUser?.role === 'driver';

    try {
      if (path.match(/^\/products\/\d+\/stock-movements\/?$/) && method === 'GET') {
  return await getProductStockMovements(request, env, corsHeaders);
}
      // استعادة نسخة قاعدة البيانات — مدير فقط
      if (path === '/import-data' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await importDatabaseBackup(request, env, corsHeaders);
      }

      // واجهة الذكاء الاصطناعي: يجب ضبط AI_API_URL وAI_API_TOKEN في بيئة Worker.
      if (path === '/ask-gemini' && method === 'POST') {
        if (!isAdmin && currentUser?.role !== 'cashier') return jsonResponse({ error: 'غير مصرح' }, 403, corsHeaders);
        return await askAI(request, env, corsHeaders);
      }

      // ===== إدارة ترقيم الفواتير =====
      if (path === '/settings/invoice-numbers' && method === 'GET') {
        const client = getTursoClient(env);
        const types = ['sales', 'purchases', 'online'];
        const result = {};
        for (const type of types) {
          const key = `next_invoice_${type}`;
          const setting = await dbFirst(client, "SELECT value FROM settings WHERE key = ?", [key]);
          result[type] = setting ? parseInt(setting.value, 10) : 1;
        }
        return jsonResponse({ invoice_numbers: result }, 200, corsHeaders);
      }
      if (path === '/settings/invoice-numbers' && method === 'PUT') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        const { type, start_number } = await request.json();
        if (!['sales', 'purchases', 'online'].includes(type)) {
          return jsonResponse({ error: 'نوع غير صالح' }, 400, corsHeaders);
        }
        if (!start_number || start_number < 1) {
          return jsonResponse({ error: 'يجب أن يكون الرقم أكبر من صفر' }, 400, corsHeaders);
        }
        const client = getTursoClient(env);
        await setInitialInvoiceNumber(client, type, start_number);
        return jsonResponse({ success: true, message: `تم تعيين رقم البداية للـ ${type} إلى ${start_number}` }, 200, corsHeaders);
      }

      // ===== تحديث طلب إنترنت (مع ctx) =====
      if (path.match(/^\/online-orders\/\d+\/?$/) && method === 'PUT') {
        if (!isAdmin && currentUser?.role !== 'cashier') {
          return jsonResponse({ error: 'غير مصرح' }, 403, corsHeaders);
        }
        const orderId = parseInt(path.split('/').pop(), 10);
        const __routeUser = await getCurrentUser(request, env);
        const __userId = __routeUser ? __routeUser.id : null;
        return await updateOnlineOrder(request, env, ctx, corsHeaders, orderId, __userId);
      }

      // العملات
      if (path.match(/^\/currencies\/?$/) && method === 'GET') return await getCurrencies(request, env, corsHeaders);
      if (path.match(/^\/currencies\/?$/) && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await createCurrency(request, env, corsHeaders);
      }
      if (path.match(/^\/currencies\/\d+\/?$/) && method === 'PUT') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await updateCurrency(request, env, corsHeaders);
      }
      if (path.match(/^\/currencies\/\d+\/?$/) && method === 'DELETE') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await deleteCurrency(request, env, corsHeaders);
      }

      // المستخدمين
      if (path.match(/^\/users\/?$/) && method === 'GET') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await getUsers(request, env, corsHeaders);
      }
      if (path.match(/^\/users\/?$/) && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await createUser(request, env, corsHeaders);
      }
      if (path.match(/^\/users\/\d+\/?$/) && method === 'PUT') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await updateUser(request, env, corsHeaders);
      }
      if (path.match(/^\/users\/\d+\/?$/) && method === 'DELETE') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await deleteUser(request, env, corsHeaders);
      }
      if (path === '/product-supplier-stock' && method === 'GET') {
        const url = new URL(request.url);
        url.searchParams.set('all', 'true');
        const modifiedRequest = new Request(url.toString(), request);
        return await getSupplierRemainingStock(modifiedRequest, env, corsHeaders);
      }
      // التصنيفات
      if (path.match(/^\/categories\/?$/) && method === 'GET') return await getCategories(request, env, corsHeaders);
      if (path.match(/^\/categories\/?$/) && method === 'POST') return await createCategory(request, env, corsHeaders);
      if (path.match(/^\/categories\/\d+\/?$/) && method === 'PUT') return await updateCategory(request, env, corsHeaders);
      if (path.match(/^\/categories\/\d+\/?$/) && method === 'DELETE') return await deleteCategory(request, env, corsHeaders);

      // المنتجات
      if (path.match(/^\/products\/?$/) && method === 'GET') return await getProducts(request, env, corsHeaders);
      if (path.match(/^\/products\/?$/) && method === 'POST') return await addProduct(request, env, corsHeaders);
      if (path.match(/^\/products\/\d+\/?$/) && method === 'PUT') return await updateProduct(request, env, corsHeaders);
      if (path.match(/^\/products\/\d+\/?$/) && method === 'DELETE') return await deleteProduct(request, env, corsHeaders);
      if (path.match(/^\/products\/\d+\/?$/) && method === 'GET') return await getProductDetails(request, env, corsHeaders);
      if (path === '/products/search' && method === 'GET') return await searchProducts(request, env, corsHeaders);
      if (path === '/products/generate-sku' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await generateMissingSKU(request, env, corsHeaders);
      }
      if (path === '/products/suppliers' && method === 'GET') {
        return await getProductSuppliers(request, env, corsHeaders);
      }

      // وظائف العملاء الإضافية المستخدمة في لوحة العملاء
      if (path === '/customers/recent-payments' && method === 'GET') return await getRecentCustomerPayments(request, env, corsHeaders);
      if (path === '/customers/today-payments' && method === 'GET') return await getTodayCustomerPayments(request, env, corsHeaders);
      if (path.match(/^\/customers\/\d+\/purchases\/?$/) && method === 'GET') return await getCustomerPurchasesById(request, env, corsHeaders);

      // العملاء
      if (path === '/customers' && method === 'GET') return await getCustomers(request, env, corsHeaders);
      if (path === '/customers' && method === 'POST') return await createCustomer(request, env, corsHeaders);
      if (path === '/customers/payments' && method === 'POST') return await addCustomerPayment(request, env, corsHeaders);
      if (path === '/customers/statement' && method === 'GET') return await getCustomerStatement(request, env, corsHeaders);
      if (path === '/customers/total-debt' && method === 'GET') return await getTotalCustomerDebt(request, env, corsHeaders);
      if (path === '/customers/purchase-history' && method === 'GET') return await getCustomerPurchaseHistory(request, env, corsHeaders);

      // الموردين
      if (path === '/suppliers' && method === 'GET') return await getSuppliers(request, env, corsHeaders);
      if (path === '/suppliers' && method === 'POST') return await createSupplier(request, env, corsHeaders);
      if (path.match(/^\/suppliers\/\d+\/?$/) && method === 'GET') return await getSupplierById(request, env, corsHeaders);
      if (path.match(/^\/suppliers\/\d+\/?$/) && method === 'PUT') return await updateSupplier(request, env, corsHeaders);
      if (path.match(/^\/suppliers\/\d+\/?$/) && method === 'DELETE') return await deleteSupplier(request, env, corsHeaders);
      if (path === '/suppliers/payments' && method === 'POST') return await addSupplierPayment(request, env, corsHeaders);
      if (path === '/suppliers/statement' && method === 'GET') return await getSupplierStatement(request, env, corsHeaders);
      if (path === '/suppliers/total-debt' && method === 'GET') return await getTotalSupplierDebt(request, env, corsHeaders);
      if (path === '/suppliers/purchase-invoices' && method === 'GET') return await getSupplierPurchaseInvoices(request, env, corsHeaders);
      if (path === '/suppliers/assign-products' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await assignProductsToSupplier(request, env, corsHeaders);
      }
      if (path === '/suppliers/remaining-stock' && method === 'GET') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await getSupplierRemainingStock(request, env, corsHeaders);
      }
      if (path === '/suppliers/financial-balance' && method === 'GET') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await getSupplierFinancialBalance(request, env, corsHeaders);
      }

      // المبيعات (createSale يستخدم ctx)
      if (path === '/sales' && method === 'POST') {
        const __routeUser = await getCurrentUser(request, env);
        const __userId = __routeUser ? __routeUser.id : null;
        return await createSale(request, env, ctx, corsHeaders, __userId);
      }
      if (path === '/sales' && method === 'GET') return await getSales(request, env, corsHeaders);
      if (path.match(/^\/sales\/\d+\/?$/) && method === 'GET') return await getSaleDetails(request, env, corsHeaders);
      if (path.match(/^\/sales\/\d+\/?$/) && method === 'PUT') {
        const __routeUser = await getCurrentUser(request, env);
        const __userId = __routeUser ? __routeUser.id : null;
        return await updateSale(request, env, corsHeaders, __userId);
      }

      // المشتريات
      if (path === '/purchases' && method === 'POST') {
        const __routeUser = await getCurrentUser(request, env);
        const __userId = __routeUser ? __routeUser.id : null;
        return await createPurchase(request, env, corsHeaders, __userId);
      }
      if (path === '/purchases' && method === 'GET') return await getPurchases(request, env, corsHeaders);
      if (path.match(/^\/purchases\/\d+\/?$/) && method === 'GET') return await getPurchaseDetails(request, env, corsHeaders);
      if (path.match(/^\/purchases\/\d+\/?$/) && method === 'PUT') return await updatePurchaseInvoice(request, env, corsHeaders);

      // المصروفات
      if (path === '/expenses' && method === 'POST') return await addExpense(request, env, corsHeaders);
      if (path === '/expenses' && method === 'GET') return await getExpenses(request, env, corsHeaders);

      // الصندوق
      if (path === '/cash' && method === 'GET') return await getCashStatus(request, env, corsHeaders);
      if (path === '/cash' && method === 'POST') return await addCashOperation(request, env, corsHeaders);
      if (path === '/cash/history' && method === 'GET') return await getCashHistory(request, env, corsHeaders);
      if (path === '/cash/balance' && method === 'GET') return await getCashBalance(request, env, corsHeaders);

      // المحافظ
      if (path === '/wallets' && method === 'GET') return await getWallets(request, env, corsHeaders);
      if (path === '/wallets' && method === 'POST') return await createWallet(request, env, corsHeaders);
      if (path === '/wallets/exchange' && method === 'POST') return await exchangeCurrency(request, env, corsHeaders);
      if (path === '/wallets/transfer' && method === 'POST') return await transferBetweenWallets(request, env, corsHeaders);
      if (path === '/wallets/transactions' && method === 'GET') return await getWalletTransactions(request, env, corsHeaders);

      // الحسابات والقيد
      if (path === '/accounts' && method === 'GET') return await getAccounts(request, env, corsHeaders);
      if (path === '/accounts' && method === 'POST') return await createAccount(request, env, corsHeaders);
      if (path === '/journal-entries' && method === 'GET') return await getJournalEntries(request, env, corsHeaders);
      if (path === '/journal-entries/manual' && method === 'POST') return await createManualJournalEntry(request, env, corsHeaders);

      // التقارير الأساسية
      if (path === '/reports/daily' && method === 'GET') return await getDailyReport(request, env, corsHeaders);
      if (path === '/reports/trial-balance' && method === 'GET') return await getTrialBalance(request, env, corsHeaders);
      if (path === '/reports/income-statement' && method === 'GET') return await getIncomeStatement(request, env, corsHeaders);
      if (path === '/reports/balance-sheet' && method === 'GET') return await getBalanceSheet(request, env, corsHeaders);
      if (path === '/reports/export' && method === 'GET') return await exportReport(request, env, corsHeaders);

      if (path === '/reports/top-products' && method === 'GET') return await getTopSellingProducts(request, env, corsHeaders);
      if (path === '/reports/sales-by-product' && method === 'GET') return await getSalesByProduct(request, env, corsHeaders);
      if (path === '/reports/top-customers' && method === 'GET') return await getTopCustomers(request, env, corsHeaders);
      if (path === '/reports/monthly-trends' && method === 'GET') return await getMonthlyTrends(request, env, corsHeaders);
      if (path === '/reports/driver-performance' && method === 'GET') return await getDriverPerformance(request, env, corsHeaders);
      if (path === '/reports/aging' && method === 'GET') return await getAgingReport(request, env, corsHeaders);
      if (path === '/accounting/close-year' && method === 'POST') { if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders); const u = await getCurrentUser(request, env); return await closeAccountingYear(request, env, corsHeaders, u?.id); }
      if (path === '/accounting/reopen' && method === 'POST') { if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders); const u = await getCurrentUser(request, env); return await reopenAccounting(request, env, corsHeaders, u?.id); }
      // الإعدادات
      if (path === '/settings' && method === 'GET') return await getSettings(request, env, corsHeaders);
      if (path === '/settings' && method === 'POST') return await updateSettings(request, env, corsHeaders);

      // الإرجاع والإلغاء
      if (path === '/sales/return' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير لعكس الإرجاع' }, 403, corsHeaders);
        const __routeUser = await getCurrentUser(request, env);
        const __userId = __routeUser ? __routeUser.id : null;
        return await returnSaleItem(request, env, corsHeaders, __userId);
      }
      if (path === '/sales/cancel' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير لإلغاء الفاتورة' }, 403, corsHeaders);
        const __routeUser = await getCurrentUser(request, env);
        const __userId = __routeUser ? __routeUser.id : null;
        return await cancelSaleInvoice(request, env, corsHeaders, __userId);
      }
      if (path === '/purchases/return' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير لعكس الإرجاع' }, 403, corsHeaders);
        const __routeUser = await getCurrentUser(request, env);
        const __userId = __routeUser ? __routeUser.id : null;
        return await returnPurchaseItem(request, env, corsHeaders, __userId);
      }
      if (path === '/purchases/cancel' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير لإلغاء الفاتورة' }, 403, corsHeaders);
        const __routeUser = await getCurrentUser(request, env);
        const __userId = __routeUser ? __routeUser.id : null;
        return await cancelPurchaseInvoice(request, env, corsHeaders, __userId);
      }
      if (path === '/operations/cancel-payment' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await cancelPayment(request, env, corsHeaders);
      }
      if (path === '/sales/return/undo' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        const __routeUser = await getCurrentUser(request, env);
        const __userId = __routeUser ? __routeUser.id : null;
        return await undoReturnSaleItem(request, env, corsHeaders, __userId);
      }
      if (path === '/sales/cancel/undo' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        const __routeUser = await getCurrentUser(request, env);
        const __userId = __routeUser ? __routeUser.id : null;
        return await undoCancelSaleInvoice(request, env, corsHeaders, __userId);
      }
      if (path === '/sales/full-return' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        const __routeUser = await getCurrentUser(request, env);
        const __userId = __routeUser ? __routeUser.id : null;
        return await fullReturnSaleInvoice(request, env, corsHeaders, __userId);
      }
      if (path === '/purchases/cancel/undo' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        const __routeUser = await getCurrentUser(request, env);
        const __userId = __routeUser ? __routeUser.id : null;
        return await undoCancelPurchaseInvoice(request, env, corsHeaders, __userId);
      }
      if (path === '/online-orders/cancel' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        const __routeUser = await getCurrentUser(request, env);
        const __userId = __routeUser ? __routeUser.id : null;
        return await cancelOnlineOrder(request, env, corsHeaders, __userId);
      }

      // سندات القبض والصرف
      if (path === '/cash/voucher' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await addCashVoucher(request, env, corsHeaders);
      }
      if (path === '/cash/vouchers' && method === 'GET') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await getCashVouchers(request, env, corsHeaders);
      }
      if (path === '/cash/cancel-voucher' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await cancelCashVoucher(request, env, corsHeaders);
      }

      // المزامنة والربط
      if (path === '/api/pending-products' && method === 'GET') return await getPendingProducts(request, env, corsHeaders);
      if (path === '/api/confirm-product-publish' && method === 'POST') return await confirmProductPublish(request, env, corsHeaders);
      if (path === '/api/link-product' && method === 'POST') return await linkProduct(request, env, corsHeaders);
      if (path === '/api/add-pending-product' && method === 'POST') return await addPendingProduct(request, env, corsHeaders);
      if (path === '/api/skip-pending-product' && method === 'POST') return await skipPendingProduct(request, env, corsHeaders);
      if (path === '/api/pos-products-unlinked' && method === 'GET') return await getUnlinkedProducts(request, env, corsHeaders);
      if (path === '/api/pos-products-linked' && method === 'GET') return await getLinkedProducts(request, env, corsHeaders);
      if (path === '/api/update-stock' && method === 'POST') return await updateStock(request, env, corsHeaders);
      if (path === '/api/unlink-product' && method === 'POST') return await unlinkProduct(request, env, corsHeaders);

      // التقارير المتقدمة
      if (path === '/reports/sales-by-category' && method === 'GET') return await getSalesByCategory(request, env, corsHeaders);
      if (path === '/reports/profits-by-category' && method === 'GET') return await getProfitsByCategory(request, env, corsHeaders);
      if (path === '/reports/inventory-by-category' && method === 'GET') return await getInventoryByCategory(request, env, corsHeaders);

      // المندوبين
      if (path.match(/^\/drivers\/?$/) && method === 'GET') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await getDrivers(request, env, corsHeaders);
      }
      if (path.match(/^\/drivers\/?$/) && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await createDriver(request, env, corsHeaders);
      }
      if (path.match(/^\/drivers\/\d+\/?$/) && method === 'PUT') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await updateDriver(request, env, corsHeaders);
      }
      if (path.match(/^\/drivers\/\d+\/?$/) && method === 'DELETE') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await deleteDriver(request, env, corsHeaders);
      }
      if (path === '/drivers/summary' && method === 'GET') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await getDriversSummary(request, env, corsHeaders);
      }
      if (path === '/drivers/payment' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await recordDriverPayment(request, env, corsHeaders);
      }
      if (path === '/drivers/transactions' && method === 'GET') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await getDriverTransactions(request, env, corsHeaders);
      }

      // ===== طلبات الإنترنت (مع ctx) =====
      if (path === '/online-orders' && method === 'GET') return await getOnlineOrders(request, env, corsHeaders);
      if (path === '/online-orders' && method === 'POST') {
        const __routeUser = await getCurrentUser(request, env);
        const __userId = __routeUser ? __routeUser.id : null;
        return await createOnlineOrder(request, env, ctx, corsHeaders, __userId);
      }
      if (path.match(/^\/online-orders\/\d+\/?$/) && method === 'GET') return await getOnlineOrderDetails(request, env, corsHeaders);
      if (path === '/online-customers/by-phone' && method === 'GET') return await getOnlineCustomerByPhone(request, env, corsHeaders);
      if (path === '/online-orders/assign-driver' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await assignDriverToOrder(request, env, ctx, corsHeaders);
      }
      if (path === '/online-orders/update-status' && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await updateOrderStatus(request, env, ctx, corsHeaders);
      }

      // ===== واجهة المندوب (الإرجاع) =====
      if (path === '/driver/return-requests' && method === 'GET') {
        if (!isDriver && !isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مندوب' }, 403, corsHeaders);
        return await getReturnRequests(request, env, corsHeaders);
      }
      if (path === '/driver/confirm-return' && method === 'POST') {
        if (!isDriver && !isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مندوب' }, 403, corsHeaders);
        return await driverConfirmReturn(request, env, ctx, corsHeaders);
      }

      // ===== إدارة الإرجاع (لوحة التحكم) =====
      if (path === '/returns' && method === 'GET') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await getReturns(request, env, corsHeaders);
      }
      if (path.match(/^\/returns\/\d+\/?$/) && method === 'GET') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await getReturnDetails(request, env, corsHeaders);
      }
      if (path.match(/^\/returns\/\d+\/confirm\/?$/) && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await adminConfirmReturn(request, env, ctx, corsHeaders);
      }
      if (path.match(/^\/returns\/\d+\/cancel\/?$/) && method === 'POST') {
        if (!isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مدير' }, 403, corsHeaders);
        return await cancelReturn(request, env, corsHeaders);
      }
      

      // ===== واجهة المندوب (الإرجاع والنظام الحالي) =====
      if (path === '/driver/orders' && method === 'GET') {
        if (!isDriver && !isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مندوب' }, 403, corsHeaders);
        return await getDriverOrders(request, env, corsHeaders);
      }
      if (path === '/driver/order-items' && method === 'GET') {
        if (!isDriver && !isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مندوب' }, 403, corsHeaders);
        return await getDriverOrderItems(request, env, corsHeaders);
      }
      if (path === '/driver/return-items' && method === 'POST') {
        if (!isDriver && !isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مندوب' }, 403, corsHeaders);
        return await driverReturnItems(request, env, corsHeaders);
      }
      if (path === '/driver/update-delivery' && method === 'POST') {
        if (!isDriver && !isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مندوب' }, 403, corsHeaders);
        const __routeUser = await getCurrentUser(request, env);
        const __userId = __routeUser ? __routeUser.id : null;
        return await updateDeliveryStatus(request, env, ctx, corsHeaders, __userId);
      }
      if (path === '/driver/summary' && method === 'GET') {
        if (!isDriver && !isAdmin) return jsonResponse({ error: 'تتطلب صلاحية مندوب' }, 403, corsHeaders);
        return await getDriverSummary(request, env, corsHeaders);
      }

      // ===== تسجيل FCM =====
      if (path === '/api/register-fcm-token' && method === 'POST') {
        try {
          const { token, driver_id, device_info } = await request.json();
          if (!token) {
            return jsonResponse({ error: 'التوكن مطلوب' }, 400, corsHeaders);
          }

          const client = getTursoClient(env);
          const driverId = driver_id ? parseInt(driver_id, 10) : null;

          // 1. تحقق من وجود التوكن مسبقاً
          const existing = await dbFirst(client, "SELECT id FROM fcm_tokens WHERE token = ?", [token]);
          if (existing) {
            // تحديث السجل الموجود
            await dbRun(client,
              "UPDATE fcm_tokens SET driver_id = ?, device_info = ?, updated_at = CURRENT_TIMESTAMP WHERE token = ?",
              [driverId, device_info || null, token]
            );
          } else {
            // إدراج سجل جديد
            await dbRun(client,
              "INSERT INTO fcm_tokens (driver_id, token, device_info) VALUES (?, ?, ?)",
              [driverId, token, device_info || null]
            );
          }

          // 3. إرجاع استجابة نجاح واضحة
          return jsonResponse({
            success: true,
            message: 'تم تسجيل التوكن بنجاح'
          }, 200, corsHeaders);

        } catch (error) {
          console.error('❌ خطأ في تسجيل FCM:', error);
          return jsonResponse({
            error: error.message || 'فشل تسجيل التوكن',
            stack: error.stack
          }, 500, corsHeaders);
        }
      }

      if (path === '/api/register-admin-fcm-token' && method === 'POST') {
        const { token, device_info } = await request.json();
        if (!token) return jsonResponse({ error: 'التوكن مطلوب' }, 400, corsHeaders);
        const client = getTursoClient(env);
        await dbRun(client, "DELETE FROM admin_fcm_tokens WHERE token = ?", [token]);
        await dbRun(client,
          "INSERT INTO admin_fcm_tokens (token, device_info) VALUES (?, ?)",
          [token, device_info || null]
        );
        return jsonResponse({ success: true }, 200, corsHeaders);
      }

      return jsonResponse({ error: 'المسار غير موجود' }, 404, corsHeaders);
    } catch (error) {
      console.error('خطأ:', error);
      return jsonResponse({ error: error.message || 'خطأ داخلي في الخادم' }, 500, corsHeaders);
    }
  },

  async scheduled(event, env, ctx) {
    console.log("⏰ تم تشغيل المجدول في:", new Date().toISOString());
    ctx.waitUntil((async () => {
      await sendDailySummary(env);
      try { const c = getTursoClient(env); await updateDailyProductStats(c); await updateMonthlySummary(c); await updateAgingSummary(c); } catch (e) { console.error('فشل تحديث الجداول الملخصة:', e.message); }
    })());
  }
};