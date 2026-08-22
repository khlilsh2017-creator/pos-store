/* محرك المستندات الموحد للنظام المحاسبي */
(function (global) {
  'use strict';
  const PAPER_KEY = 'pos_document_paper';
  const PAPERS = {
    a4: { label: 'A4', css: 'A4 portrait', width: '190mm', format: 'a4', margin: 10 },
    a5: { label: 'A5', css: 'A5 portrait', width: '138mm', format: 'a5', margin: 8 },
    '80mm': { label: 'إيصال 80mm', css: '80mm auto', width: '72mm', format: [80, 220], margin: 3 },
    '58mm': { label: 'إيصال 58mm', css: '58mm auto', width: '50mm', format: [58, 220], margin: 2 }
  };
  const state = { loading: {} };
  const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c] || c));
  function paper() { return localStorage.getItem(PAPER_KEY) || 'a4'; }
  function setPaper(v) { if (PAPERS[v]) localStorage.setItem(PAPER_KEY, v); }
  function loadScript(src, test) {
    if (test && test()) return Promise.resolve();
    if (state.loading[src]) return state.loading[src];
    state.loading[src] = new Promise((resolve, reject) => {
      const el = document.createElement('script'); el.src = src; el.async = true;
      el.onload = () => resolve(); el.onerror = () => reject(new Error('تعذر تحميل مكتبة التصدير'));
      document.head.appendChild(el);
    });
    return state.loading[src];
  }
  function selectedPaper() { return PAPERS[paper()] || PAPERS.a4; }
  function cloneClean(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('.pos-doc-toolbar,.no-print,[data-no-print="true"],button,input,select,textarea').forEach(e => e.remove());
    clone.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
    return clone;
  }
  function documentCss(p) {
    return `@page{size:${p.css};margin:${p.margin}mm}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#111;font-family:Arial,"Cairo",sans-serif}body{width:${p.width};margin:0 auto;font-size:${p.format === 'a4' ? '11px' : '10px'};direction:rtl}.pos-doc{width:100%;background:#fff;padding:${p.format === 'a4' ? '8mm' : '2mm'};overflow:hidden}.pos-doc h1,.pos-doc h2,.pos-doc h3{margin:0 0 8px;text-align:center}.pos-doc table{width:100%;border-collapse:collapse;margin:8px 0;font-size:inherit}.pos-doc th,.pos-doc td{border:1px solid #cbd5e1;padding:5px;text-align:right;vertical-align:top}.pos-doc th{background:#f1f5f9;font-weight:700}.pos-doc .no-print{display:none!important}.pos-doc img{max-width:100%}@media print{.no-print,.pos-doc-toolbar{display:none!important}}`;
  }
  function printElement(element, options = {}) {
    if (!element) return Promise.reject(new Error('لا توجد بيانات للطباعة'));
    const p = PAPERS[options.paper || paper()] || PAPERS.a4;
    const clone = cloneClean(element); clone.classList.add('pos-doc');
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) return Promise.reject(new Error('الرجاء السماح بالنوافذ المنبثقة'));
    win.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(options.title || 'مستند')}</title><style>${documentCss(p)}</style></head><body>${clone.outerHTML}<script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script></body></html>`);
    win.document.close();
    return Promise.resolve();
  }
  async function exportPDF(element, options = {}) {
    if (!element) throw new Error('لا توجد بيانات لتصديرها');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js', () => typeof global.html2pdf === 'function');
    const p = PAPERS[options.paper || paper()] || PAPERS.a4;
    const holder = document.createElement('div'); holder.style.cssText = `position:fixed;left:-100000px;top:0;width:${p.width};background:#fff;z-index:-1;`;
    const clone = cloneClean(element); clone.classList.add('pos-doc'); holder.appendChild(clone); document.body.appendChild(holder);
    try {
      await global.html2pdf().set({ margin:p.margin, filename:options.filename || 'document.pdf', image:{type:'jpeg',quality:.98}, html2canvas:{scale:2,useCORS:true,backgroundColor:'#fff'}, jsPDF:{unit:'mm',format:p.format,orientation:'portrait'}}).from(clone).save();
    } finally { holder.remove(); }
  }
  function tableRows(table) {
    const heads = [...table.querySelectorAll('thead th')].map(x => x.textContent.trim());
    return [...table.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim())).filter(row => row.length && !row.join('').includes('جاري التحميل'))
      .map(row => Object.fromEntries(row.map((v,i) => [heads[i] || `العمود_${i+1}`, v])));
  }
  async function exportRowsExcel(rows, options = {}) {
    if (!Array.isArray(rows) || !rows.length) throw new Error('لا توجد بيانات قابلة للتصدير');
    await loadScript('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js', () => !!global.XLSX);
    const wb = global.XLSX.utils.book_new();
    const ws = global.XLSX.utils.json_to_sheet(rows);
    global.XLSX.utils.book_append_sheet(wb, ws, options.sheetName || 'بيانات');
    global.XLSX.writeFile(wb, options.filename || `بيانات_${new Date().toISOString().slice(0,10)}.xlsx`);
  }
  async function exportExcel(root, options = {}) {
    const tables = [...(root || document).querySelectorAll('table')];
    if (!tables.length) throw new Error('لا توجد جداول لتصديرها');
    await loadScript('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js', () => !!global.XLSX);
    const wb = global.XLSX.utils.book_new();
    tables.forEach((table, i) => { const rows = tableRows(table); if (!rows.length) return; const ws = global.XLSX.utils.json_to_sheet(rows); global.XLSX.utils.book_append_sheet(wb, ws, `بيانات${i+1}`); });
    if (!wb.SheetNames.length) throw new Error('لا توجد بيانات قابلة للتصدير');
    global.XLSX.writeFile(wb, options.filename || `تقرير_${new Date().toISOString().slice(0,10)}.xlsx`);
  }
  function target() { return document.querySelector('[data-pos-print-target]') || document.querySelector('main') || document.querySelector('.content') || document.querySelector('.main-content') || document.body; }
  function installToolbar(root) {
    root = root || target(); if (!root || document.querySelector('.pos-doc-toolbar')) return;
    const bar = document.createElement('div'); bar.className = 'pos-doc-toolbar no-print'; bar.setAttribute('data-no-print','true');
    bar.innerHTML = `<div class="pos-doc-toolbar-title"><i class="fas fa-file-invoice"></i> المستندات الموحدة</div><label>المقاس <select id="pos-paper-select"><option value="a4">A4</option><option value="a5">A5</option><option value="80mm">إيصال 80mm</option><option value="58mm">إيصال 58mm</option></select></label><button type="button" data-doc-action="print"><i class="fas fa-print"></i> طباعة</button><button type="button" data-doc-action="pdf"><i class="fas fa-file-pdf"></i> PDF</button><button type="button" data-doc-action="excel"><i class="fas fa-file-excel"></i> Excel</button><span class="pos-doc-status" aria-live="polite"></span>`;
    const style = document.createElement('style'); style.textContent = `.pos-doc-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:10px 12px;margin:0 0 14px;box-shadow:0 3px 12px rgba(15,23,42,.05);direction:rtl}.pos-doc-toolbar-title{font-weight:800;color:#1d4ed8;margin-left:auto}.pos-doc-toolbar label{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#64748b;font-weight:700}.pos-doc-toolbar select,.pos-doc-toolbar button{font:inherit;border:1px solid #cbd5e1;border-radius:8px;background:#fff;padding:7px 10px;cursor:pointer}.pos-doc-toolbar button:hover{border-color:#2563eb;color:#2563eb}.pos-doc-status{font-size:11px;color:#64748b}`; document.head.appendChild(style); root.prepend(bar);
    const select = bar.querySelector('#pos-paper-select'); select.value = paper(); select.onchange = () => setPaper(select.value);
    const status = bar.querySelector('.pos-doc-status'); const busy = t => { status.textContent=t; };
    bar.querySelector('[data-doc-action="print"]').onclick = () => printElement(target(), { title: document.title }).then(() => busy('تم تجهيز الطباعة')).catch(e => busy(e.message));
    bar.querySelector('[data-doc-action="pdf"]').onclick = () => exportPDF(target(), { title: document.title, filename:`${document.title.replace(/[\\/:*?"<>|]/g,'_')}_${paper()}.pdf` }).then(() => busy('تم تنزيل PDF')).catch(e => busy(e.message));
    bar.querySelector('[data-doc-action="excel"]').onclick = () => exportExcel(target(), { filename:`${document.title.replace(/[\\/:*?"<>|]/g,'_')}.xlsx` }).then(() => busy('تم تنزيل Excel')).catch(e => busy(e.message));
  }
  function renderInvoice(data = {}) {
    const items = Array.isArray(data.items) ? data.items : [];
    const total = Number(data.total ?? data.total_amount ?? 0) || 0;
    const subtotal = Number(data.subtotal ?? items.reduce((s, x) => s + (Number(x.line_total ?? x.total_price ?? 0) || ((Number(x.unit_price)||0) * (Number(x.quantity)||0))), 0)) || 0;
    const discount = Number(data.discount || 0) || 0;
    const tax = Number(data.tax || 0) || 0;
    const additional = Number(data.additional || 0) || 0;
    const paid = Number(data.paid || data.paid_amount || 0) || 0;
    const due = Math.max(0, total - paid);
    const partyLabel = data.type === 'purchase' ? 'المورد' : 'العميل';
    const rows = items.map((x, i) => {
      const qty = Number(x.quantity || 0), price = Number(x.unit_price ?? x.price ?? 0), line = Number(x.line_total ?? x.total_price ?? price * qty);
      return `<tr><td>${i+1}</td><td>${esc(x.name || x.product_name || 'منتج')}</td><td>${esc(qty)}</td><td>${price.toFixed(2)}</td><td>${line.toFixed(2)}</td></tr>`;
    }).join('');
    return `<div class="pos-unified-invoice pos-doc"><header class="pos-invoice-header"><div><h1>${esc(data.shopName || localStorage.getItem('shop_name') || 'ابن المختار')}</h1><div>${esc(data.shopPhone || localStorage.getItem('shop_phone') || '')}</div></div><div><h2>${data.type === 'purchase' ? 'فاتورة مشتريات' : 'فاتورة مبيعات'}</h2><div>رقم الفاتورة: <strong>${esc(data.number || data.invoice_number || data.id || '-')}</strong></div><div>التاريخ: ${esc(data.date || '')}</div></div></header><section class="pos-invoice-meta"><div><strong>${partyLabel}:</strong> ${esc(data.party || data.customer_name || data.supplier_name || 'غير محدد')}</div><div><strong>طريقة الدفع:</strong> ${esc(data.payment_method || 'غير محددة')}</div><div><strong>الحالة:</strong> ${esc(data.status || 'مكتملة')}</div></section><table><thead><tr><th>#</th><th>المنتج</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th></tr></thead><tbody>${rows || '<tr><td colspan="5">لا توجد بنود</td></tr>'}</tbody></table><section class="pos-invoice-totals"><div>الإجمالي قبل الخصم: <strong>${subtotal.toFixed(2)}</strong></div>${discount ? `<div>الخصم: <strong>-${discount.toFixed(2)}</strong></div>` : ''}${tax ? `<div>الضريبة: <strong>${tax.toFixed(2)}</strong></div>` : ''}${additional ? `<div>الإضافي: <strong>${additional.toFixed(2)}</strong></div>` : ''}<div class="grand">الصافي: <strong>${total.toFixed(2)}</strong></div>${paid ? `<div>المدفوع: <strong>${paid.toFixed(2)}</strong></div>` : ''}${due ? `<div class="due">المتبقي: <strong>${due.toFixed(2)}</strong></div>` : ''}</section>${data.notes ? `<footer>ملاحظات: ${esc(data.notes)}</footer>` : '<footer>شكرًا لتعاملكم معنا</footer>'}</div>`;
  }
  function renderVoucher(data = {}) {
    const isReceipt = data.type === 'receipt';
    return `<div class="pos-unified-invoice pos-doc"><header class="pos-invoice-header"><div><h1>${esc(data.shopName || localStorage.getItem('shop_name') || 'ابن المختار')}</h1><div>${esc(data.shopPhone || localStorage.getItem('shop_phone') || '')}</div></div><div><h2>${isReceipt ? 'سند قبض' : 'سند صرف'}</h2><div>رقم السند: <strong>${esc(data.id || '-')}</strong></div><div>التاريخ: ${esc(data.date || '')}</div></div></header><section class="pos-invoice-meta"><div><strong>النوع:</strong> ${isReceipt ? 'قبض' : 'صرف'}</div><div><strong>العملة:</strong> ${esc(data.currency || data.currency_code || data.currency_name || '-')}</div><div><strong>الحالة:</strong> ${esc(data.status || 'معتمد')}</div></section><div style="border:1px solid #cbd5e1;border-radius:8px;padding:18px;margin-top:18px"><strong>البيان:</strong><p>${esc(data.reason || data.note || '—')}</p></div><section class="pos-invoice-totals"><div class="grand">المبلغ: <strong>${(Number(data.amount)||0).toFixed(2)}</strong></div></section><footer>تم إنشاء المستند من النظام المحاسبي الموحد</footer></div>`;
  }
  async function printVoucherData(data, options = {}) { const holder=document.createElement('div'); holder.innerHTML=renderVoucher(data); return printElement(holder.firstElementChild,{title:options.title || (data.type==='receipt'?'سند قبض':'سند صرف'),paper:options.paper}); }
  async function exportVoucherPDF(data, options = {}) { const holder=document.createElement('div'); holder.innerHTML=renderVoucher(data); return exportPDF(holder.firstElementChild,{title:options.title,filename:options.filename,paper:options.paper}); }
  async function printInvoiceData(data, options = {}) {
    const holder = document.createElement('div'); holder.innerHTML = renderInvoice(data); const element = holder.firstElementChild;
    return printElement(element, { title: options.title || (data.type === 'purchase' ? 'فاتورة مشتريات' : 'فاتورة مبيعات'), paper: options.paper });
  }
  async function exportInvoicePDF(data, options = {}) {
    const holder = document.createElement('div'); holder.innerHTML = renderInvoice(data); return exportPDF(holder.firstElementChild, { title: options.title, filename: options.filename, paper: options.paper });
  }
  function unifiedCss() { return `.pos-unified-invoice{direction:rtl;color:#111;background:#fff}.pos-invoice-header{display:flex;justify-content:space-between;gap:18px;border-bottom:3px solid #1d4ed8;padding-bottom:12px;margin-bottom:14px}.pos-invoice-header h1{color:#1d4ed8;margin:0 0 5px;text-align:right}.pos-invoice-header h2{color:#1d4ed8;margin:0 0 6px;text-align:left}.pos-invoice-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px;margin-bottom:12px}.pos-invoice-totals{margin-top:12px;margin-right:auto;width:300px;border-top:2px solid #1d4ed8;padding-top:8px;display:grid;gap:5px}.pos-invoice-totals .grand{font-size:16px;border-top:1px solid #cbd5e1;padding-top:6px}.pos-invoice-totals .due{color:#b91c1c}.pos-unified-invoice footer{text-align:center;border-top:1px solid #e2e8f0;margin-top:20px;padding-top:10px;color:#64748b}@media(max-width:600px){.pos-invoice-header,.pos-invoice-meta{display:block}.pos-invoice-header>div{margin-bottom:8px}.pos-invoice-totals{width:100%}}`; }
  const style = document.createElement('style'); style.textContent = unifiedCss(); document.head.appendChild(style);
  global.POSDocs = { PAPERS, paper, setPaper, printElement, exportPDF, exportExcel, exportRowsExcel, installToolbar, target, renderInvoice, printInvoiceData, exportInvoicePDF, renderVoucher, printVoucherData, exportVoucherPDF };
  document.addEventListener('DOMContentLoaded', () => installToolbar());
})(window);
