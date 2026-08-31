/*
 * document-utils.js
 * محرك موحّد للفواتير والسندات والكشوفات والتقارير.
 * يدعم: هوية المنشأة، الشعار، ألوان الهوية، A4، A5، 80mm، 58mm، PDF، Image، Excel والطباعة.
 */
(function (global) {
  'use strict';

  const PAPER_KEY = 'pos_document_paper';
  const IDENTITY_KEY = 'pos_brand_identity';
  const DEFAULT_API = 'https://api.ibnalmukhtar.com';

  // ==== مسارات المكتبات المحلية (عدّل حسب هيكل مشروعك) ====
  const LOCAL_LIBS = {
    html2pdf: '/libs/html2pdf.bundle.min.js',
    html2canvas: '/libs/html2canvas.min.js',
    xlsx: '/libs/xlsx.full.min.js'
  };

  const PAPERS = {
    a4: { label: 'A4', css: 'A4 portrait', width: '190mm', format: 'a4', margin: 10, fontSize: '12px' },
    a5: { label: 'A5', css: 'A5 portrait', width: '138mm', format: 'a5', margin: 8, fontSize: '11px' },
    '80mm': { label: 'إيصال 80mm', css: '80mm auto', width: '72mm', format: [80, 220], margin: 3, fontSize: '11px' },
    '58mm': { label: 'إيصال 58mm', css: '58mm auto', width: '50mm', format: [58, 220], margin: 2, fontSize: '10px' }
  };
  const state = { loading: {}, identity: null };

  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char] || char));

  function safeColor(value, fallback) {
    const color = String(value || '').trim();
    return /^(#[0-9a-f]{3,8}|rgb\(\s*[\d%]+\s*,\s*[\d%]+\s*,\s*[\d%]+\s*\)|rgba\(\s*[\d%]+\s*,\s*[\d%]+\s*,\s*[\d%]+\s*,\s*(0|1|0?\.\d+)\s*\))$/i.test(color) ? color : fallback;
  }

  const fmtMoney = (val, currency = '') => {
    const num = Number(val) || 0;
    const str = typeof global.formatPosMoney === 'function' ? global.formatPosMoney(num) : num.toFixed(2);
    return currency ? `${str} ${currency}` : str;
  };

  const fmtQty = (val) => {
    const num = Number(val) || 0;
    return typeof global.formatPosQuantity === 'function' ? global.formatPosQuantity(num) : num.toString();
  };

  function getIdentity() {
    const fallback = {
      shop_name: localStorage.getItem('shop_name') || 'ابن المختار للأدوات المنزلية',
      shop_phone: localStorage.getItem('shop_phone') || '',
      shop_address: localStorage.getItem('shop_address') || '',
      shop_logo: '',
      brand_primary: '#1d4ed8',
      brand_secondary: '#c9a227',
      brand_text: '#0f172a',
      invoice_footer: 'شكرًا لتعاملكم معنا'
    };
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(IDENTITY_KEY) || '{}') || {}; } catch (_) { stored = {}; }
    const merged = { ...fallback, ...stored, ...(state.identity || {}) };
    return {
      shop_name: String(merged.shop_name || fallback.shop_name),
      shop_phone: String(merged.shop_phone || ''),
      shop_address: String(merged.shop_address || ''),
      shop_logo: String(merged.shop_logo || ''),
      brand_primary: safeColor(merged.brand_primary, fallback.brand_primary),
      brand_secondary: safeColor(merged.brand_secondary, fallback.brand_secondary),
      brand_text: safeColor(merged.brand_text, fallback.brand_text),
      invoice_footer: String(merged.invoice_footer || fallback.invoice_footer)
    };
  }

  function setIdentity(identity = {}) {
    state.identity = { ...getIdentity(), ...identity };
    try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(state.identity)); } catch (_) { }
    localStorage.setItem('shop_name', state.identity.shop_name || '');
    localStorage.setItem('shop_phone', state.identity.shop_phone || '');
    if (state.identity.shop_address !== undefined) localStorage.setItem('shop_address', state.identity.shop_address || '');
    return getIdentity();
  }

  function getApiUrl() {
    return global.POS_API || document.querySelector('meta[name="pos-api"]')?.content || localStorage.getItem('pos_api') || DEFAULT_API;
  }

  async function loadIdentity(options = {}) {
    if (options.identity) return setIdentity(options.identity);
    const token = options.token || localStorage.getItem('pos_token') || '';
    if (!token || state.identity?.__loaded) return getIdentity();
    try {
      const response = await fetch(`${options.api || getApiUrl()}/settings`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) return getIdentity();
      const body = await response.json();
      const settings = body.settings || {};
      state.identity = { ...settings, __loaded: true };
      return setIdentity(settings);
    } catch (_) {
      return getIdentity();
    }
  }

  function paper() { return localStorage.getItem(PAPER_KEY) || 'a4'; }
  function setPaper(value) { if (PAPERS[value]) localStorage.setItem(PAPER_KEY, value); }
  function selectedPaper() { return PAPERS[paper()] || PAPERS.a4; }

  // ===== دالة تحميل مكتبة مع دعم المسار المحلي والـ CDN كاحتياطي =====
  function loadScript(cdnSrc, test, localPath) {
    if (test && test()) return Promise.resolve();
    const actualSrc = localPath || cdnSrc;
    if (state.loading[actualSrc]) return state.loading[actualSrc];
    state.loading[actualSrc] = new Promise((resolve, reject) => {
      const element = document.createElement('script');
      element.src = actualSrc;
      element.async = true;
      element.onload = () => resolve();
      element.onerror = () => {
        // إذا فشل المسار المحلي، حاول تحميل CDN كاحتياطي (إذا كان مختلفاً)
        if (actualSrc !== cdnSrc) {
          const fallbackElement = document.createElement('script');
          fallbackElement.src = cdnSrc;
          fallbackElement.async = true;
          fallbackElement.onload = () => resolve();
          fallbackElement.onerror = () => reject(new Error('تعذر تحميل المكتبة من المصدرين المحلي وCDN'));
          document.head.appendChild(fallbackElement);
        } else {
          reject(new Error('تعذر تحميل المكتبة؛ تحقق من اتصال الإنترنت'));
        }
      };
      document.head.appendChild(element);
    });
    return state.loading[actualSrc];
  }

  function cloneClean(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('.pos-doc-toolbar,.no-print,[data-no-print="true"],button,input,select,textarea').forEach(node => node.remove());
    clone.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    clone.querySelectorAll('img').forEach(image => {
      image.setAttribute('crossorigin', 'anonymous');
      image.setAttribute('referrerpolicy', 'no-referrer');
    });
    return clone;
  }

  function documentCss(p, identity = getIdentity()) {
    return `
      @page { size: ${p.css}; margin: ${p.margin}mm; }
      * { box-sizing: border-box; }
      html, body { margin:0; padding:0; background:#fff; color:${identity.brand_text}; font-family:Arial,"Cairo",sans-serif; }
      body { width:${p.width}; margin:0 auto; font-size:${p.fontSize}; direction:rtl; }
      .pos-doc { width:100%; background:#fff; padding:${p.format === 'a4' ? '8mm' : '2mm'}; overflow:hidden; }
      .pos-doc h1,.pos-doc h2,.pos-doc h3 { margin:0 0 8px; }
      .pos-doc table { width:100%; border-collapse:collapse; margin:8px 0; font-size:inherit; }
      .pos-doc th,.pos-doc td { border:1px solid #cbd5e1; padding:6px; text-align:right; vertical-align:top; }
      .pos-doc th { background:${identity.brand_primary}18; font-weight:700; }
      .pos-doc .no-print { display:none!important; }
      .pos-doc img { max-width:100%; }
      .pos-brand-primary { color:${identity.brand_primary}!important; }
      .pos-brand-secondary { color:${identity.brand_secondary}!important; }
      .pos-brand-border { border-color:${identity.brand_primary}!important; }
      @media print { .no-print,.pos-doc-toolbar { display:none!important; } }
    `;
  }

  // ==================== محركات التصدير (PDF, Image, Excel, Print) ====================

  function printElement(element, options = {}) {
    if (!element) return Promise.reject(new Error('لا توجد بيانات للطباعة'));
    const p = PAPERS[options.paper || paper()] || PAPERS.a4;
    const identity = getIdentity();
    const clone = cloneClean(element);
    clone.classList.add('pos-doc');
    const win = global.open('', '_blank', 'width=900,height=700');
    if (!win) return Promise.reject(new Error('الرجاء السماح بالنوافذ المنبثقة'));
    const toolbar = `<div class="pos-preview-toolbar" dir="rtl"><strong>معاينة ${esc(options.title || 'المستند')}</strong><span></span><button type="button" onclick="window.print()">طباعة</button><button type="button" onclick="window.close()">إغلاق</button></div>`;
    const previewCss = `.pos-preview-toolbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:8px;padding:10px;margin:0 0 10px;background:#eef4ff;border:1px solid #cbd5e1;border-radius:8px;font-family:Arial,sans-serif}.pos-preview-toolbar span{flex:1}.pos-preview-toolbar button{border:1px solid #94a3b8;border-radius:6px;background:#fff;padding:7px 13px;cursor:pointer;font-weight:700}.pos-preview-toolbar button:first-of-type{background:#1d4ed8;color:#fff;border-color:#1d4ed8}@media print{.pos-preview-toolbar{display:none!important}}`;
    win.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(options.title || 'مستند')}</title><style>${documentCss(p, identity)} ${unifiedCss()} ${previewCss}</style></head><body>${toolbar}${clone.outerHTML}<script>window.onload=function(){window.focus()}<\/script></body></html>`);
    win.document.close();
    return Promise.resolve({ window: win, preview: true });
  }

  async function exportPDF(element, options = {}) {
    if (!element) throw new Error('لا توجد بيانات لتصديرها');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js',
                     () => typeof global.html2pdf === 'function',
                     LOCAL_LIBS.html2pdf);
    const p = PAPERS[options.paper || paper()] || PAPERS.a4;
    const identity = getIdentity();
    
    const holder = document.createElement('div');
    holder.style.cssText = `position: fixed; left: 0; top: 0; width: ${p.width}; min-height: 20px; background: #fff; z-index: -1; opacity: 1; pointer-events: none;`;
    
    const clone = cloneClean(element);
    clone.classList.add('pos-doc');
    const exportStyle = document.createElement('style');
    exportStyle.textContent = documentCss(p, identity) + " " + unifiedCss();
    holder.appendChild(exportStyle);
    holder.appendChild(clone);
    document.body.appendChild(holder);
    
    const originalScroll = window.scrollY;
    window.scrollTo(0, 0);

    try {
      let fileName = options.filename || 'document.pdf';
      if (!fileName.endsWith('.pdf')) fileName += '.pdf';

      await global.html2pdf().set({
        margin: p.margin,
        filename: fileName,
        image: { type:'jpeg', quality: 1 },
        html2canvas: { scale: 2, useCORS: true, allowTaint: false, backgroundColor: '#ffffff', scrollY: 0, scrollX: 0 },
        jsPDF: { unit:'mm', format: p.format, orientation:'portrait' }
      }).from(holder).save();
    } finally {
      holder.remove();
      window.scrollTo(0, originalScroll);
    }
  }

  async function exportImage(element, options = {}) {
    if (!element) throw new Error('لا توجد بيانات لتصديرها');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
                     () => typeof global.html2canvas === 'function',
                     LOCAL_LIBS.html2canvas);
    
    const p = PAPERS[options.paper || paper()] || PAPERS.a4;
    const identity = getIdentity();
    
    const holder = document.createElement('div');
    holder.style.cssText = `position: fixed; left: 0; top: 0; width: ${p.width}; min-height: 20px; background: #fff; z-index: -1; opacity: 1; pointer-events: none;`;
    
    const clone = cloneClean(element);
    clone.classList.add('pos-doc');
    
    const exportStyle = document.createElement('style');
    exportStyle.textContent = documentCss(p, identity) + " " + unifiedCss();
    
    holder.appendChild(exportStyle);
    holder.appendChild(clone);
    document.body.appendChild(holder);

    try {
      const canvas = await global.html2canvas(holder, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
        logging: false
      });
      
      let fileName = (options.filename || 'document').replace(/\.pdf$/i, '');
      if (!fileName.endsWith('.png')) fileName += '.png';

      const link = document.createElement('a');
      link.download = fileName;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } finally {
      holder.remove();
    }
  }

  function tableRows(table) {
    const heads = [...table.querySelectorAll('thead th')].map(cell => cell.textContent.trim());
    return [...table.querySelectorAll('tbody tr')]
      .map(row => [...row.children].map(cell => cell.textContent.trim()))
      .filter(row => row.length && !row.join('').includes('جاري التحميل') && !row.join('').includes('لا توجد بيانات'))
      .map(row => Object.fromEntries(row.map((value, index) => [heads[index] || `العمود_${index + 1}`, value])));
  }

  async function exportRowsExcel(rows, options = {}) {
    if (!Array.isArray(rows) || !rows.length) throw new Error('لا توجد بيانات قابلة للتصدير');
    await loadScript('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
                     () => !!global.XLSX,
                     LOCAL_LIBS.xlsx);
    const workbook = global.XLSX.utils.book_new();
    const worksheet = global.XLSX.utils.json_to_sheet(rows);
    global.XLSX.utils.book_append_sheet(workbook, worksheet, options.sheetName || 'بيانات');
    global.XLSX.writeFile(workbook, options.filename || `بيانات_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  async function exportExcel(root, options = {}) {
    const tables = [...(root || document).querySelectorAll('table')];
    if (!tables.length) throw new Error('لا توجد جداول لتصديرها');
    await loadScript('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
                     () => !!global.XLSX,
                     LOCAL_LIBS.xlsx);
    const workbook = global.XLSX.utils.book_new();
    tables.forEach((table, index) => {
      const rows = tableRows(table);
      if (!rows.length) return;
      const worksheet = global.XLSX.utils.json_to_sheet(rows);
      global.XLSX.utils.book_append_sheet(workbook, worksheet, `بيانات${index + 1}`);
    });
    if (!workbook.SheetNames.length) throw new Error('لا توجد بيانات قابلة للتصدير');
    global.XLSX.writeFile(workbook, options.filename || `تقرير_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  function invoiceRows(data = {}) {
    return Array.isArray(data.items) ? data.items : [];
  }

  const PRINT_PREFS_KEY = 'pos_print_preferences';

  function getPrintPreferences() {
    const defaults = { showLogo: true, showHeader: true, headerText: '' };
    try { return { ...defaults, ...(JSON.parse(localStorage.getItem(PRINT_PREFS_KEY) || '{}') || {}) }; }
    catch (_) { return defaults; }
  }

  function setPrintPreferences(prefs = {}) {
    const next = { ...getPrintPreferences(), ...prefs };
    try { localStorage.setItem(PRINT_PREFS_KEY, JSON.stringify(next)); } catch (_) { }
    return next;
  }

  function renderBrandHeader(identity, title, data = {}, options = {}) {
    const prefs = { ...getPrintPreferences(), ...options };
    if (prefs.showHeader === false) return '';
    const logo = prefs.showLogo !== false && identity.shop_logo ? `<img class="pos-brand-logo" src="${esc(identity.shop_logo)}" alt="شعار المنشأة" crossorigin="anonymous" referrerpolicy="no-referrer">` : '';
    const docNo = (data.number || data.invoice_number || data.id) ? `<div class="pos-doc-number">الرقم: <strong dir="ltr">${esc(data.number || data.invoice_number || data.id)}</strong></div>` : '';
    const customHeader = prefs.headerText ? `<div class="pos-custom-header">${esc(prefs.headerText)}</div>` : '';
    const contact = [identity.shop_phone, identity.shop_address].filter(Boolean).map(value => `<div>${esc(value)}</div>`).join('');
    return `<header class="pos-invoice-header"><div class="pos-brand-block">${logo}<div class="pos-brand-info"><h1 class="pos-brand-primary">${esc(identity.shop_name)}</h1>${contact ? `<div class="pos-brand-contact">${contact}</div>` : ''}</div></div><div class="pos-invoice-title"><h2 class="pos-brand-primary">${esc(title)}</h2>${customHeader}${docNo}<div>التاريخ: <span dir="ltr">${esc(data.date || new Date().toLocaleString('ar-SA'))}</span></div></div></header>`;
  }

  // ==================== الفواتير ====================
  function renderInvoice(data = {}, options = {}) {
    const identity = getIdentity();
    const items = invoiceRows(data);
    const currency = data.currency_code || data.currency || 'ريال';
    
    const total = Number(data.total ?? data.total_amount ?? 0) || 0;
    const grossSubtotal = items.reduce((sum, item) => sum + ((Number(item.unit_price ?? item.price) || 0) * (Number(item.quantity) || 0)), 0);
    const itemDiscountTotal = items.reduce((sum, item) => sum + ((Number(item.discount || item.discount_amount) || 0) * (Number(item.quantity) || 0)), 0);
    const subtotal = Number(data.gross_subtotal ?? data.subtotal ?? grossSubtotal) || 0;
    const discount = Number(data.discount || data.discount_amount || 0) || 0;
    const tax = Number(data.tax || 0) || 0;
    const additional = Number(data.additional ?? data.delivery_fee ?? 0) || 0;
    const paid = Number(data.paid ?? data.paid_amount ?? 0) || 0;
    const due = Math.max(0, total - paid);
    
    const purchase = data.type === 'purchase';
    const isOnlineOrder = !purchase && Boolean(data.is_online_order || data.online_order_id || data.order_id || data.delivery_type);
    const partyLabel = purchase ? 'المورد' : 'العميل';
    const title = data.title || (purchase ? 'فاتورة مشتريات' : (isOnlineOrder ? 'فاتورة طلب إنترنت' : (data.is_draft ? 'فاتورة مبدئية (مسودة)' : 'فاتورة مبيعات')));
    
    const paymentDetails = data.payment_details_html ? `<br><span style="font-size:0.9em; color:var(--pos-brand-primary, #1d4ed8); font-weight:bold; display:inline-block; margin-top:4px;">${data.payment_details_html}</span>` : '';

    const rows = items.map((item, index) => {
      const qty = Number(item.quantity || 0);
      const price = Number(item.unit_price ?? item.price ?? 0) || 0;
      const itemDiscount = Math.max(0, Number(item.discount ?? item.discount_amount ?? 0) || 0);
      const effectivePrice = Math.max(0, price - itemDiscount);
      const line = Number(item.line_total ?? item.total_price ?? (effectivePrice * qty)) || 0;
      const itemNote = item.note || item.notes || item.product_note || '';
      const codeHtml = item.product_code ? `<br><small class="pos-brand-primary" style="font-size:0.85em; font-weight:bold;">كود: ${esc(item.product_code)}</small>` : '';
      const discountHtml = itemDiscount > 0 ? `<br><small class="pos-item-discount">خصم الوحدة: ${fmtMoney(itemDiscount, currency)} — إجمالي الخصم: ${fmtMoney(itemDiscount * qty, currency)}</small>` : '';
      const noteHtml = itemNote ? `<br><small class="pos-item-note">ملاحظة: ${esc(itemNote)}</small>` : '';
      
      return `<tr>
                <td>${index + 1}</td>
                <td>${esc(item.name || item.product_name || 'منتج')}${codeHtml}${discountHtml}${noteHtml}</td>
                <td>${fmtQty(qty)}</td>
                <td dir="ltr">${fmtMoney(effectivePrice)}</td>
                <td dir="ltr">${fmtMoney(line)}</td>
              </tr>`;
    }).join('');

    return `<div class="pos-unified-invoice pos-doc">
        ${renderBrandHeader(identity, title, data, options)}
        <section class="pos-invoice-meta">
            <div><strong>نوع المستند:</strong> ${purchase ? 'فاتورة شراء' : (isOnlineOrder ? 'طلب إنترنت' : 'بيع عادي')}</div>
            <div><strong>${partyLabel}:</strong> ${esc(data.party || data.customer_name || data.supplier_name || 'غير محدد')}</div>
            <div><strong>طريقة الدفع:</strong> ${esc(data.payment_method || 'غير محددة')}${paymentDetails}</div>
            <div><strong>الحالة:</strong> ${esc(data.status || (data.is_draft ? 'مسودة' : 'مكتملة'))}</div>
            ${isOnlineOrder && (data.order_number || data.online_order_id || data.order_id) ? `<div><strong>رقم طلب الإنترنت:</strong> <span dir="ltr">${esc(data.order_number || data.online_order_id || data.order_id)}</span></div>` : ''}
            ${isOnlineOrder && data.customer_phone ? `<div><strong>هاتف العميل:</strong> <span dir="ltr">${esc(data.customer_phone)}</span></div>` : ''}
            ${isOnlineOrder && data.governorate ? `<div><strong>المحافظة:</strong> ${esc(data.governorate)}</div>` : ''}
            ${isOnlineOrder && data.delivery_type ? `<div><strong>نوع التوصيل:</strong> ${esc(data.delivery_type)}</div>` : ''}
            ${isOnlineOrder && data.driver_name ? `<div><strong>المندوب:</strong> ${esc(data.driver_name)}</div>` : ''}
            ${isOnlineOrder && data.customer_address ? `<div class="pos-online-address"><strong>العنوان:</strong> ${esc(data.customer_address)}</div>` : ''}
        </section>
        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>المنتج</th>
                    <th>الكمية</th>
                    <th>السعر (${currency})</th>
                    <th>الإجمالي (${currency})</th>
                </tr>
            </thead>
            <tbody>
                ${rows || '<tr><td colspan="5" style="text-align:center;">لا توجد بنود</td></tr>'}
            </tbody>
        </table>
        <section class="pos-invoice-totals">
            <div>المجموع قبل الخصومات: <strong dir="ltr">${fmtMoney(subtotal, currency)}</strong></div>
            ${itemDiscountTotal ? `<div style="color:#dc2626;">خصم المنتجات: <strong dir="ltr">-${fmtMoney(itemDiscountTotal, currency)}</strong></div>` : ''}
            ${discount ? `<div style="color:#dc2626;">خصم الإجمالي: <strong dir="ltr">-${fmtMoney(discount, currency)}</strong></div>` : ''}
            ${tax ? `<div>الضريبة: <strong dir="ltr">${fmtMoney(tax, currency)}</strong></div>` : ''}
            ${additional ? `<div>رسوم التوصيل: <strong dir="ltr">${fmtMoney(additional, currency)}</strong></div>` : ''}
            <div class="grand">الإجمالي: <strong dir="ltr">${fmtMoney(total, currency)}</strong></div>
            ${paid > 0 && !data.is_draft ? `<div>المدفوع: <strong dir="ltr">${fmtMoney(paid, currency)}</strong></div>` : ''}
            ${due > 0 && !data.is_draft && paid > 0 ? `<div class="due">المتبقي: <strong dir="ltr">${fmtMoney(due, currency)}</strong></div>` : ''}
        </section>
        <footer>${esc(data.notes || identity.invoice_footer)}</footer>
    </div>`;
  }

  // ==================== السندات ====================
  function renderVoucher(data = {}, options = {}) {
    const identity = getIdentity();
    const receipt = data.type === 'receipt';
    const currency = data.currency || data.currency_code || data.currency_name || 'ريال';
    return `<div class="pos-unified-invoice pos-doc">
        ${renderBrandHeader(identity, receipt ? 'سند قبض' : 'سند صرف', data, options)}
        <section class="pos-invoice-meta">
            <div><strong>النوع:</strong> ${receipt ? 'قبض' : 'صرف'}</div>
            <div><strong>العملة:</strong> ${esc(currency)}</div>
            <div><strong>الحالة:</strong> ${esc(data.status || 'معتمد')}</div>
        </section>
        <div class="pos-voucher-reason">
            <strong>البيان:</strong><p>${esc(data.reason || data.note || '—')}</p>
        </div>
        <section class="pos-invoice-totals">
            <div class="grand">المبلغ: <strong dir="ltr">${fmtMoney(Number(data.amount) || 0, currency)}</strong></div>
        </section>
        <footer>${esc(identity.invoice_footer)}</footer>
    </div>`;
  }

  // ==================== كشوف الحساب ====================
  function renderStatement(data = {}, options = {}) {
    const identity = getIdentity();
    const currency = data.currency || data.currency_code || 'ريال';
    const items = Array.isArray(data.items) ? data.items : [];
    
    const title = data.title || 'كشف حساب';
    const partyLabel = data.party_type === 'supplier' ? 'المورد' : (data.party_type === 'driver' ? 'المندوب' : 'العميل');
    
    const rows = items.map((item, index) => {
      return `<tr>
                <td>${index + 1}</td>
                <td><span dir="ltr">${esc(item.date)}</span></td>
                <td>${esc(item.description || item.type || '—')}</td>
                <td dir="ltr" style="color:#1d4ed8;">${item.debit ? fmtMoney(item.debit) : '-'}</td>
                <td dir="ltr" style="color:#dc2626;">${item.credit ? fmtMoney(item.credit) : '-'}</td>
                <td dir="ltr" style="font-weight:bold;">${fmtMoney(item.balance)}</td>
              </tr>`;
    }).join('');

    return `<div class="pos-unified-invoice pos-doc">
        ${renderBrandHeader(identity, title, data, options)}
        <section class="pos-invoice-meta">
            <div><strong>${partyLabel}:</strong> ${esc(data.party || data.customer_name || data.supplier_name || 'غير محدد')}</div>
            <div><strong>من تاريخ:</strong> <span dir="ltr">${esc(data.date_from || '-')}</span></div>
            <div><strong>إلى تاريخ:</strong> <span dir="ltr">${esc(data.date_to || '-')}</span></div>
            <div><strong>الرصيد السابق قبل الفترة:</strong> <span dir="ltr">${fmtMoney(data.opening_balance || data.previous_balance || 0, currency)}</span></div>
        </section>
        
        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>التاريخ</th>
                    <th>البيان</th>
                    <th>مدين (${currency})</th>
                    <th>دائن (${currency})</th>
                    <th>الرصيد (${currency})</th>
                </tr>
            </thead>
            <tbody>
                ${rows || '<tr><td colspan="6" style="text-align:center;">لا توجد حركات مسجلة في هذه الفترة</td></tr>'}
            </tbody>
        </table>
        
        <div style="display:flex; justify-content:space-between; gap:10px; margin-top:15px;">
            <div style="flex:1; border:1px solid #cbd5e1; border-radius:8px; padding:10px; background:#f8fafc; text-align:center;">
                <div style="font-size:0.9em; color:#64748b; margin-bottom:5px;">الرصيد السابق</div>
                <strong dir="ltr" style="font-size:1.1em; color:#475569;">${fmtMoney(data.opening_balance || data.previous_balance || 0, currency)}</strong>
            </div>
            <div style="flex:1; border:1px solid #cbd5e1; border-radius:8px; padding:10px; background:#f8fafc; text-align:center;">
                <div style="font-size:0.9em; color:#64748b; margin-bottom:5px;">إجمالي المدين</div>
                <strong dir="ltr" style="font-size:1.1em; color:#1d4ed8;">${fmtMoney(data.total_debit || 0, currency)}</strong>
            </div>
            <div style="flex:1; border:1px solid #cbd5e1; border-radius:8px; padding:10px; background:#f8fafc; text-align:center;">
                <div style="font-size:0.9em; color:#64748b; margin-bottom:5px;">إجمالي الدائن</div>
                <strong dir="ltr" style="font-size:1.1em; color:#dc2626;">${fmtMoney(data.total_credit || 0, currency)}</strong>
            </div>
            <div style="flex:1; border:2px solid var(--pos-brand-primary,#1d4ed8); border-radius:8px; padding:10px; background:#fff; text-align:center;">
                <div style="font-size:0.9em; color:#64748b; margin-bottom:5px;">الرصيد النهائي</div>
                <strong dir="ltr" style="font-size:1.2em; color:var(--pos-brand-secondary,#c9a227);">${fmtMoney(data.final_balance || 0, currency)}</strong>
            </div>
        </div>
        
        <footer>${esc(data.notes || identity.invoice_footer)}</footer>
    </div>`;
  }

  // ==================== طباعة وتصدير دوال الاتصال ====================

  async function printInvoiceData(data, options = {}) {
    const holder = document.createElement('div');
    holder.innerHTML = renderInvoice(data, options);
    return printElement(holder.firstElementChild, { title: options.title || (data.type === 'purchase' ? 'فاتورة مشتريات' : 'فاتورة مبيعات'), paper: options.paper });
  }
  
  async function exportInvoicePDF(data, options = {}) {
    const holder = document.createElement('div');
    holder.innerHTML = renderInvoice(data);
    return exportPDF(holder.firstElementChild, { title: options.title, filename: options.filename, paper: options.paper });
  }

  async function exportInvoiceImage(data, options = {}) {
    const holder = document.createElement('div');
    holder.innerHTML = renderInvoice(data);
    return exportImage(holder.firstElementChild, { title: options.title, filename: options.filename, paper: options.paper });
  }
  
  async function printVoucherData(data, options = {}) {
    const holder = document.createElement('div');
    holder.innerHTML = renderVoucher(data, options);
    return printElement(holder.firstElementChild, { title: options.title || (data.type === 'receipt' ? 'سند قبض' : 'سند صرف'), paper: options.paper });
  }
  
  async function exportVoucherPDF(data, options = {}) {
    const holder = document.createElement('div');
    holder.innerHTML = renderVoucher(data);
    return exportPDF(holder.firstElementChild, { title: options.title, filename: options.filename, paper: options.paper });
  }

  async function exportVoucherImage(data, options = {}) {
    const holder = document.createElement('div');
    holder.innerHTML = renderVoucher(data);
    return exportImage(holder.firstElementChild, { title: options.title, filename: options.filename, paper: options.paper });
  }

  async function printStatementData(data, options = {}) {
    const holder = document.createElement('div');
    holder.innerHTML = renderStatement(data, options);
    return printElement(holder.firstElementChild, { title: options.title || 'كشف حساب', paper: 'a4' });
  }

  async function exportStatementPDF(data, options = {}) {
    const holder = document.createElement('div');
    holder.innerHTML = renderStatement(data);
    return exportPDF(holder.firstElementChild, { title: options.title || 'كشف حساب', filename: options.filename || 'كشف_حساب.pdf', paper: 'a4' });
  }

  async function exportStatementImage(data, options = {}) {
    const holder = document.createElement('div');
    holder.innerHTML = renderStatement(data);
    return exportImage(holder.firstElementChild, { title: options.title || 'كشف حساب', filename: options.filename || 'كشف_حساب.png', paper: 'a4' });
  }

  // ==================== التقارير العامة ====================
  function renderReport(element, options = {}) {
    if (!element) throw new Error('لا توجد بيانات التقرير');
    const identity = getIdentity();
    const source = cloneClean(element);
    source.classList.add('pos-report-source');
    const title = options.title || 'تقرير';
    const date = options.date || new Date().toLocaleString('ar-SA');
    return `<div class="pos-unified-report pos-doc">${renderBrandHeader(identity, title, { number: options.number || '', date }, options)}<section class="pos-report-content">${source.outerHTML}</section><footer>${esc(options.footer || identity.invoice_footer)}</footer></div>`;
  }

  function reportElement(element, options = {}) {
    const holder = document.createElement('div');
    holder.innerHTML = renderReport(element, options);
    return holder.firstElementChild;
  }

  function printReport(element, options = {}) {
    return printElement(reportElement(element, options), { title: options.title || 'تقرير', paper: 'a4' });
  }

  async function exportReportPDF(element, options = {}) {
    return exportPDF(reportElement(element, options), { title: options.title || 'تقرير', filename: options.filename || 'تقرير.pdf', paper: 'a4' });
  }

  async function exportReportImage(element, options = {}) {
    return exportImage(reportElement(element, options), { title: options.title || 'تقرير', filename: options.filename || 'تقرير.png', paper: 'a4' });
  }

  function unifiedCss() {
    return `.pos-unified-invoice,.pos-unified-report{direction:rtl;color:var(--pos-brand-text,#0f172a);background:#fff;font-family:'Cairo',Arial,sans-serif}.pos-unified-invoice{max-width:100%;overflow:hidden}.pos-invoice-header{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:14px;border-bottom:3px solid var(--pos-brand-primary,#1d4ed8);padding-bottom:10px;margin-bottom:12px}.pos-brand-block{display:flex;align-items:center;gap:10px;min-width:0}.pos-brand-info{min-width:0}.pos-brand-logo{width:30mm;max-width:105px;max-height:18mm;object-fit:contain}.pos-brand-block h1{margin:0 0 4px;font-size:19px;color:var(--pos-brand-primary,#1d4ed8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pos-brand-contact{display:flex;flex-wrap:wrap;gap:3px 12px;color:#475569;font-size:11px;line-height:1.45}.pos-invoice-title{text-align:left;white-space:nowrap;font-size:11px;color:#475569}.pos-invoice-title h2{margin:0 0 5px;font-size:17px;color:var(--pos-brand-primary,#1d4ed8)}.pos-doc-number{font-size:12px}.pos-invoice-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:9px 10px;margin-bottom:10px;font-size:12px;line-height:1.55}.pos-invoice-meta>div{min-width:0;overflow-wrap:anywhere}.pos-invoice-meta .pos-online-address{grid-column:1/-1}.pos-invoice-totals{margin-top:10px;margin-right:auto;width:min(330px,100%);border-top:2px solid var(--pos-brand-primary,#1d4ed8);padding-top:8px;display:grid;gap:5px}.pos-invoice-totals>div{display:flex;justify-content:space-between;gap:12px;font-size:13px}.pos-invoice-totals .grand{font-size:17px;border-top:1px solid #cbd5e1;padding-top:6px;color:var(--pos-brand-secondary,#9a7714);font-weight:bold}.pos-invoice-totals .due{color:#b91c1c}.pos-item-discount{color:#dc2626;font-size:.82em}.pos-item-note{display:block;color:#475569;font-size:.82em;background:#fffbeb;border-radius:4px;padding:1px 4px;margin-top:2px}.pos-voucher-reason{border:1px solid #cbd5e1;border-radius:8px;padding:18px;margin-top:18px}.pos-report-title{margin:0 0 12px;text-align:center;font-size:18px;color:#334155}.pos-report-content{margin-top:4px}.pos-report-source{width:100%!important;min-height:0!important;background:#fff!important;color:inherit!important}.pos-report-source .topbar,.pos-report-source .top-bar,.pos-report-source .page-title,.pos-report-source .actions,.pos-report-source .no-print,.pos-report-source button,.pos-report-source input,.pos-report-source select,.pos-report-source textarea{display:none!important}.pos-report-source .content,.pos-report-source main,.pos-report-source.content,.pos-report-source.main-content{padding:0!important;margin:0!important}.pos-report-source .panel,.pos-report-source .card,.pos-report-source .card-section,.pos-report-source .table-wrap,.pos-report-source .table-wrapper{box-shadow:none!important}.pos-report-source .table-wrap,.pos-report-source .table-wrapper{overflow:visible!important}.pos-report-source table{min-width:0!important;width:100%!important}.pos-report-source .toast-container,.pos-report-source .sidebar,.pos-report-source #sidebar-container,.pos-report-source .overlay{display:none!important}.pos-unified-invoice footer,.pos-unified-report footer{text-align:center;border-top:1px solid #e2e8f0;margin-top:16px;padding-top:8px;color:#64748b;font-size:11px}@media(max-width:600px){.pos-invoice-header,.pos-invoice-meta{display:block}.pos-invoice-title{text-align:right;margin-top:8px;white-space:normal}.pos-brand-logo{width:24mm}.pos-invoice-totals{width:100%}}`;
  }

  function target() {
    return document.querySelector('[data-pos-print-target]') || document.querySelector('main') || document.querySelector('.content') || document.querySelector('.main-content') || document.body;
  }

  function getPrintControlValues(control) {
    const box = control || document.querySelector('[data-pos-print-controls]');
    if (!box) return { from: '', to: '', search: '', showLogo: true, showHeader: true, headerText: '' };
    return {
      from: box.querySelector('[data-pos-filter-from]')?.value || '',
      to: box.querySelector('[data-pos-filter-to]')?.value || '',
      search: (box.querySelector('[data-pos-filter-search]')?.value || '').trim().toLowerCase(),
      showLogo: false,
      showHeader: false,
      headerText: ''
    };
  }

  function rowDate(row) {
    const explicit = row.dataset?.date || row.getAttribute?.('data-date');
    if (explicit) return String(explicit).slice(0, 10);
    const normalizeDigits = value => String(value).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
    const text = normalizeDigits(row.textContent || '');
    const iso = text.match(/(20\\d{2})[-/](\\d{1,2})[-/](\\d{1,2})/);
    if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
    const dmy = text.match(/(\\d{1,2})[-/](\\d{1,2})[-/](20\\d{2})/);
    if (dmy) return `${dmy[3]}-${String(dmy[2]).padStart(2, '0')}-${String(dmy[1]).padStart(2, '0')}`;
    return '';
  }

  function applyPrintFilter(root, values) {
    const rows = [...root.querySelectorAll('tbody tr, .statement-item, [data-pos-filter-row]')];
    rows.forEach(row => {
      if (row.closest('[data-pos-print-controls]')) return;
      const date = rowDate(row);
      const text = (row.textContent || '').toLowerCase();
      const dateOk = (!values.from || !date || date >= values.from) && (!values.to || !date || date <= values.to);
      const searchOk = !values.search || text.includes(values.search);
      row.hidden = !(dateOk && searchOk);
    });
    return rows.filter(row => !row.hidden).length;
  }

  function installPrintControls(rootOverride = null) {
    const root = rootOverride || target();
    if (!root || !root.querySelector) return null;
    const hasPrintableContent = root.querySelector('table, .statement-item, .invoice-wrapper, .report-output, .filters, .table-wrap, [data-pos-printable]');
    if (!hasPrintableContent || root.querySelector('[data-pos-print-controls]')) return null;

    const controls = document.createElement('section');
    controls.className = 'pos-print-controls no-print';
    controls.setAttribute('data-pos-print-controls', 'true');
    controls.innerHTML = `<div class="pos-print-controls-title"><strong>تصفية وتجهيز الطباعة</strong><small>حدد الفترة والكلمات ثم اطبع العرض الحالي</small></div><label>من <input type="date" data-pos-filter-from></label><label>إلى <input type="date" data-pos-filter-to></label><label class="pos-print-search">بحث <input type="search" data-pos-filter-search placeholder="اسم أو رقم أو بيان"></label><button type="button" class="btn btn-primary" data-pos-apply-filter>تطبيق</button><button type="button" class="btn btn-outline" data-pos-clear-filter>مسح</button><button type="button" class="btn btn-success" data-pos-print>طباعة</button>`;

    const host = root.querySelector('.topbar,.page-header,.header') || root.firstElementChild || root;
    host.parentNode.insertBefore(controls, host.nextSibling);
    if (!document.getElementById('pos-print-controls-style')) {
      const style = document.createElement('style');
      style.id = 'pos-print-controls-style';
      style.textContent = `.pos-print-controls{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px;margin:0 0 16px;direction:rtl;box-shadow:0 2px 8px rgba(15,23,42,.05)}.pos-print-controls-title{display:grid;gap:2px;min-width:180px}.pos-print-controls-title small{color:#64748b;font-size:11px}.pos-print-controls label{display:grid;gap:3px;font-size:11px;color:#475569;font-weight:700}.pos-print-controls input{border:1px solid #cbd5e1;border-radius:7px;padding:7px 8px;background:#fff;min-width:125px}.pos-print-controls .pos-print-search input{min-width:180px}.pos-print-controls .pos-print-check{display:flex;align-items:center;gap:4px;padding-bottom:7px;white-space:nowrap}.pos-print-controls .pos-print-check input{min-width:auto}.pos-print-controls .pos-print-header-text{min-width:180px}.pos-print-controls button{padding:8px 12px;border:1px solid #cbd5e1;border-radius:7px;cursor:pointer;font-weight:700}.pos-print-controls .btn-primary{background:#2563eb;color:#fff}.pos-print-controls .btn-success{background:#16a34a;color:#fff}.pos-print-controls .btn-outline{background:#fff;color:#334155}@media(max-width:700px){.pos-print-controls{align-items:stretch}.pos-print-controls>*{flex:1 1 140px}.pos-print-controls-title{flex-basis:100%}}`;
      document.head.appendChild(style);
    }

    const apply = () => {
      const values = getPrintControlValues(controls);
      applyPrintFilter(root, values);
    };
    controls.querySelector('[data-pos-apply-filter]').addEventListener('click', apply);
    controls.querySelector('[data-pos-clear-filter]').addEventListener('click', () => {
      controls.querySelectorAll('input[type="date"],input[type="search"]').forEach(input => input.value = '');
      applyPrintFilter(root, { from: '', to: '', search: '' });
    });
    controls.querySelector('[data-pos-print]').addEventListener('click', () => {
      apply();
      const values = getPrintControlValues(controls);
      const date = values.from || values.to ? `${values.from || '-'} إلى ${values.to || '-'}` : undefined;
      printReport(root, { title: document.title, date })
        .catch(error => global.alert?.(error.message));
    });
    return controls;
  }

  function installToolbar(root) {
    document.querySelectorAll('.pos-doc-toolbar').forEach(toolbar => toolbar.remove());
    return null;
  }

  const style = document.createElement('style');
  style.textContent = unifiedCss();
  document.head.appendChild(style);

  global.POSDocs = {
    PAPERS, paper, setPaper, selectedPaper, getIdentity, setIdentity, loadIdentity,
    printElement, exportPDF, exportImage, exportExcel, exportRowsExcel, installToolbar, target,
    renderInvoice, printInvoiceData, exportInvoicePDF, exportInvoiceImage,
    renderVoucher, printVoucherData, exportVoucherPDF, exportVoucherImage,
        renderStatement, printStatementData, exportStatementPDF, exportStatementImage,
    renderReport, reportElement, printReport, exportReportPDF, exportReportImage,
    getPrintPreferences, setPrintPreferences, installPrintControls

  };

  document.addEventListener('DOMContentLoaded', () => {
    loadIdentity();
    installToolbar();
  });
})(window);