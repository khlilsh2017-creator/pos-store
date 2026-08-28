from pathlib import Path

path = Path(__file__).parent / 'stock-movements.html'
text = path.read_text(encoding='utf-8')
start = text.index('<script>\n  const API_BASE')
end = text.index('</script>\n    <script src="document-utils.js"', start)
script = r'''<script>
  const API_BASE = 'https://api.ibnalmukhtar.com';
  const token = localStorage.getItem('pos_token') || '';
  if (!token) {
    document.body.innerHTML = '<div style="text-align:center;padding:50px;"><h2>الرجاء تسجيل الدخول أولاً</h2><button class="btn" onclick="window.location.href=\'index.html\'">تسجيل الدخول</button></div>';
  }

  let selectedProduct = null;
  let searchResults = [];
  let movementPage = 1;
  const movementLimit = 20;
  let movementMeta = { total: 0 };
  let lastMovementData = null;
  let searchTimer = null;
  const searchInput = document.getElementById('productSearchInput');
  const suggestions = document.getElementById('productSuggestions');

  function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function qty(value) { return Number(value || 0).toLocaleString('ar-YE', { maximumFractionDigits: 2 }); }
  function dateLabel(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('ar-YE'); }
  function refLabel(value) { return ({ sale:'بيع', cancel_sale:'إلغاء بيع', return_sale:'إرجاع بيع', full_return_sale:'مرتجع كلي', undo_cancel_sale:'عكس إلغاء بيع', undo_return_sale:'عكس إرجاع', purchase:'شراء', cancel_purchase:'إلغاء شراء', return_purchase:'إرجاع شراء', undo_cancel_purchase:'عكس إلغاء شراء', online_order:'طلب إنترنت', update_online_order:'تحديث طلب إنترنت', update_online_order_revert:'عكس تحديث طلب', cancel_online_order:'إلغاء طلب إنترنت', delivery_failed:'فشل توصيل', online_order_return:'إرجاع طلب إنترنت', sale_update:'تحديث فاتورة', sale_update_revert:'عكس تحديث فاتورة', inventory_adjust:'تسوية جرد', initialization:'تأسيس النظام' }[value] || value || 'غير معروف'); }
  function setSearchMessage(message) { document.getElementById('searchHint').textContent = message; }

  async function searchProducts() {
    const term = searchInput.value.trim();
    if (term.length < 2) { suggestions.hidden = true; setSearchMessage('اكتب حرفين على الأقل للبحث عن منتج.'); return; }
    setSearchMessage('جاري البحث عن المنتج...');
    try {
      const res = await fetch(`${API_BASE}/products/search?term=${encodeURIComponent(term)}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل البحث عن المنتج');
      searchResults = Array.isArray(data.results) ? data.results : [];
      suggestions.innerHTML = searchResults.length ? searchResults.map((p, index) => `<button type="button" class="product-suggestion" data-index="${index}"><span><strong>${escapeHtml(p.name)}</strong><small style="display:block;color:var(--muted)">${escapeHtml(p.barcode || p.product_code || 'بدون كود')}</small></span><span>الرصيد: ${qty(p.stock_quantity)}</span></button>`).join('') : '<div class="empty-state" style="padding:20px">لا يوجد منتج مطابق</div>';
      suggestions.hidden = false;
      suggestions.querySelectorAll('.product-suggestion').forEach(button => button.addEventListener('click', () => selectProduct(searchResults[Number(button.dataset.index)])));
      setSearchMessage(searchResults.length ? `تم العثور على ${searchResults.length} منتج؛ اختر منتجًا واحدًا لعرض حركاته.` : 'لم يتم العثور على منتج مطابق.');
    } catch (error) { suggestions.hidden = true; setSearchMessage(error.message); }
  }

  function selectProduct(product) {
    if (!product) return;
    selectedProduct = product;
    searchInput.value = product.name;
    suggestions.hidden = true;
    document.getElementById('selectedProductCard').hidden = false;
    document.getElementById('selectedProductName').textContent = product.name || '-';
    document.getElementById('selectedProductMeta').textContent = `الباركود: ${product.barcode || '-'} | كود المنتج: ${product.product_code || '-'}`;
    document.getElementById('printMovementBtn').disabled = false;
    movementPage = 1;
    loadSelectedMovements(1);
  }

  async function loadSelectedMovements(page = 1) {
    if (!selectedProduct) return;
    const card = document.getElementById('movementCard');
    const empty = document.getElementById('movementEmpty');
    card.hidden = false; empty.hidden = true;
    document.getElementById('movementTableBody').innerHTML = '<tr><td colspan="9" class="loading">جاري تحميل حركات المنتج...</td></tr>';
    try {
      const res = await fetch(`${API_BASE}/products/${selectedProduct.id}/stock-movements?limit=${movementLimit}&page=${page}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل جلب حركات المنتج');
      lastMovementData = data; movementPage = page; movementMeta = data.pagination || { total: (data.movements || []).length };
      document.getElementById('closingBalance').textContent = qty(data.closing_balance ?? data.current_stock);
      document.getElementById('latestOperationLabel').textContent = data.latest_operation ? `آخر عملية: ${dateLabel(data.latest_operation.created_at)}` : 'لا توجد عمليات مسجلة';
      document.getElementById('movementSummary').textContent = `إجمالي الحركات: ${Number(movementMeta.total || 0)} — العرض يبدأ من آخر عملية إلى الأقدم`;
      renderMovements(data.movements || [], (movementPage - 1) * movementLimit);
      renderMovementPager();
    } catch (error) {
      document.getElementById('movementTableBody').innerHTML = `<tr><td colspan="9" class="empty-state">${escapeHtml(error.message)}</td></tr>`;
      document.getElementById('movementPager').innerHTML = '';
    }
  }

  function renderMovements(movements, offset = 0) {
    const tbody = document.getElementById('movementTableBody');
    if (!movements.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty-state">لا توجد حركة مخزون لهذا المنتج</td></tr>'; return; }
    tbody.innerHTML = movements.map((m, index) => {
      const change = Number(m.quantity_change || 0);
      return `<tr><td>${offset + index + 1}</td><td>${dateLabel(m.created_at)}</td><td><strong>${escapeHtml(refLabel(m.reference_type))}</strong>${m.reference_id ? `<small style="display:block;color:var(--muted)">#${escapeHtml(m.reference_id)}</small>` : ''}</td><td>${qty(m.old_quantity)}</td><td class="${change >= 0 ? 'in' : 'out'}">${change > 0 ? '+' : ''}${qty(change)}</td><td><strong>${qty(m.new_quantity)}</strong></td><td>${escapeHtml(m.supplier_name || '-')}</td><td>${escapeHtml(m.created_by_name || '-')}</td><td>${escapeHtml(m.note || '-')}</td></tr>`;
    }).join('');
  }

  function renderMovementPager() {
    const totalPages = Math.max(1, Math.ceil(Number(movementMeta.total || 0) / movementLimit));
    document.getElementById('movementPager').innerHTML = `<button class="btn btn-outline btn-sm" ${movementPage <= 1 ? 'disabled' : ''} onclick="loadSelectedMovements(${movementPage - 1})">السابق</button><span style="padding:6px 10px">صفحة ${movementPage} من ${totalPages}</span><button class="btn btn-outline btn-sm" ${movementPage >= totalPages ? 'disabled' : ''} onclick="loadSelectedMovements(${movementPage + 1})">التالي</button>`;
  }

  function clearProductSelection() {
    selectedProduct = null; searchResults = []; lastMovementData = null; searchInput.value = ''; suggestions.hidden = true;
    document.getElementById('selectedProductCard').hidden = true; document.getElementById('movementCard').hidden = true; document.getElementById('movementEmpty').hidden = false; document.getElementById('printMovementBtn').disabled = true;
    setSearchMessage('لن يتم عرض المنتجات أو الحركات حتى تحدد منتجًا.');
  }

  async function printSelectedMovements() {
    if (!selectedProduct || !window.POSDocs) return alert('حدد منتجًا أولًا أو تحقق من محرك الطباعة');
    try {
      const all = []; let page = 1; let total = 0;
      do {
        const res = await fetch(`${API_BASE}/products/${selectedProduct.id}/stock-movements?limit=100&page=${page}`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json(); if (!res.ok) throw new Error(data.error || 'فشل تحميل الحركات للطباعة');
        all.push(...(data.movements || [])); total = Number(data.pagination?.total || all.length); if (!(data.movements || []).length) break; page += 1;
      } while (all.length < total);
      const sheet = document.createElement('section');
      sheet.innerHTML = `<h2>كشف حركة المنتج</h2><p><strong>المنتج:</strong> ${escapeHtml(selectedProduct.name)} | <strong>الرصيد النهائي:</strong> ${qty(lastMovementData?.closing_balance ?? selectedProduct.stock_quantity)}</p><table><thead><tr><th>#</th><th>التاريخ</th><th>النوع / المرجع</th><th>قبل</th><th>التغيير</th><th>بعد</th><th>المورد</th><th>المستخدم</th><th>الملاحظة</th></tr></thead><tbody>${all.map((m, i) => `<tr><td>${i + 1}</td><td>${dateLabel(m.created_at)}</td><td>${escapeHtml(refLabel(m.reference_type))} ${m.reference_id ? '#'+escapeHtml(m.reference_id) : ''}</td><td>${qty(m.old_quantity)}</td><td>${qty(m.quantity_change)}</td><td>${qty(m.new_quantity)}</td><td>${escapeHtml(m.supplier_name || '-')}</td><td>${escapeHtml(m.created_by_name || '-')}</td><td>${escapeHtml(m.note || '-')}</td></tr>`).join('')}</tbody></table>`;
      document.body.appendChild(sheet); await POSDocs.printReport(sheet, { title: `كشف حركة ${selectedProduct.name}` }); setTimeout(() => sheet.remove(), 1200);
    } catch (error) { alert(error.message); }
  }

  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(searchProducts, 350); });
  searchInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); clearTimeout(searchTimer); searchProducts(); } });
  document.addEventListener('click', event => { if (!event.target.closest('.lookup-wrap')) suggestions.hidden = true; });
</script>
'''
path.write_text(text[:start] + script + text[end:], encoding='utf-8')
print('stock script replaced')
