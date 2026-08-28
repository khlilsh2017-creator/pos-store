from pathlib import Path

path = Path(__file__).parent / 'reports.html'
text = path.read_text(encoding='utf-8')
start = text.index('function centralKind()')
end = text.index('async function loadAll()', start)
central = r'''function centralKind() {
  return document.getElementById('central-kind').value;
}
function centralParams(page = 1, limit) {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('limit', String(limit || document.getElementById('central-limit').value || 20));
  const from = document.getElementById('central-from').value;
  const to = document.getElementById('central-to').value;
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return params;
}
function centralSetStatus(value, type = '') {
  const el = document.getElementById('central-status');
  el.textContent = value;
  el.style.color = type === 'error' ? 'var(--danger)' : 'var(--muted)';
}
function centralUpdateMode() {
  const all = centralKind().startsWith('all-');
  document.getElementById('central-entity-field').style.display = all ? 'none' : '';
}
function centralOptionRows(items) {
  const select = document.getElementById('central-entity-select');
  const options = items.map(item => `<option value="${esc(item.id)}">${esc(item.name)}${item.barcode ? ` — ${esc(item.barcode)}` : ''}</option>`).join('');
  select.innerHTML = '<option value="">اختر الجهة</option>' + options;
  select.disabled = items.length === 0;
}
async function searchCentralEntities() {
  const kind = centralKind();
  const term = document.getElementById('central-entity-search').value.trim();
  if (term.length < 2) return toast('اكتب حرفين على الأقل للبحث', 'warning');
  const endpoint = kind === 'customer' ? '/customers' : (kind === 'supplier' ? '/suppliers' : '/products/search');
  const params = new URLSearchParams();
  params.set(kind === 'product' ? 'term' : 'search', term);
  params.set('limit', '50');
  params.set('page', '1');
  try {
    centralSetStatus('جاري البحث');
    const response = await fetch(`${API}${endpoint}?${params.toString()}`, { headers: auth() });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'فشل البحث');
    const rows = kind === 'product' ? (data.results || data.products || []) : (data.customers || data.suppliers || []);
    centralOptionRows(rows);
    centralSetStatus(rows.length ? `تم العثور على ${rows.length} نتيجة` : 'لا توجد نتائج');
  } catch (error) {
    centralSetStatus(error.message, 'error');
    toast(error.message, 'error');
  }
}
function centralEntityId() {
  return document.getElementById('central-entity-select').value;
}
function centralStatementUrl(kind, page = 1, limit = 20) {
  const params = centralParams(page, limit);
  if (kind === 'customer') {
    params.set('customer_id', centralEntityId());
    return `${API}/customers/statement?${params.toString()}`;
  }
  if (kind === 'supplier') {
    params.set('supplier_id', centralEntityId());
    return `${API}/suppliers/statement?${params.toString()}`;
  }
  return `${API}/products/${encodeURIComponent(centralEntityId())}/stock-movements?${params.toString()}`;
}
function centralTypeLabel(value) {
  const labels = { sale: 'بيع', payment: 'سداد', purchase: 'شراء', return: 'مرتجع', supplier_payment: 'سداد مورد' };
  return labels[value] || value || 'حركة';
}
function renderCentralRows(kind, rows) {
  if (!rows.length) return '<div class="empty">لا توجد بيانات خلال الفترة المحددة</div>';
  if (kind === 'product') {
    const body = rows.map((row, index) => `<tr><td>${index + 1}</td><td>${esc(row.created_at || '')}</td><td>${esc(centralTypeLabel(row.reference_type))}</td><td>${formatPosNumber(Number(row.old_quantity || 0))}</td><td>${formatPosNumber(Number(row.quantity_change || 0))}</td><td><strong>${formatPosNumber(Number(row.new_quantity || 0))}</strong></td><td>${row.reference_id ? '#' + esc(row.reference_id) : '-'}</td><td>${esc(row.note || '-')}</td></tr>`).join('');
    return `<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>التاريخ</th><th>العملية</th><th>الرصيد قبل</th><th>التغيير</th><th>الرصيد بعد / النهائي</th><th>المرجع</th><th>الملاحظة</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }
  if (kind === 'all') {
    const body = rows.map((row, index) => `<tr><td>${index + 1}</td><td><strong>${esc(row.name || '-')}</strong></td><td>${esc(row.phone || '-')}</td><td>${formatPosMoney(Number(row.balance || 0))}</td></tr>`).join('');
    return `<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>الجهة</th><th>الهاتف</th><th>الرصيد / المتبقي</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }
  let running = 0;
  const body = rows.map((row, index) => {
    const amount = Number(row.amount ?? row.total_amount ?? 0);
    const isDebit = (kind === 'customer' && row.type === 'sale') || (kind === 'supplier' && row.type === 'purchase');
    const debit = isDebit ? amount : 0;
    const credit = isDebit ? 0 : amount;
    running += debit - credit;
    return `<tr><td>${index + 1}</td><td>${esc(row.created_at || '')}</td><td>${esc(centralTypeLabel(row.type))}</td><td>${esc(row.invoice_number || '-')}</td><td>${formatPosMoney(debit)}</td><td>${formatPosMoney(credit)}</td><td><strong>${formatPosMoney(running)}</strong></td><td>${esc(row.note || row.wallet_name || '-')}</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>التاريخ</th><th>النوع</th><th>رقم المرجع</th><th>مدين / زيادة</th><th>دائن / تخفيض</th><th>الرصيد التراكمي</th><th>ملاحظة</th></tr></thead><tbody>${body}</tbody></table></div>`;
}
function renderCentralSummary(kind, data) {
  if (kind === 'product') return `<div class="metric"><div class="label">الرصيد النهائي الحالي</div><strong>${formatPosNumber(Number(data.closing_balance ?? data.current_stock ?? 0))}</strong></div><div class="metric"><div class="label">إجمالي الحركات</div><strong>${formatPosNumber(Number(data.pagination?.total || data.movements?.length || 0), 0)}</strong></div>`;
  const summary = data.summary || {};
  return `<div class="metric"><div class="label">إجمالي الزيادة / المدين</div><strong>${formatPosMoney(Number(summary.total_debit || 0))}</strong></div><div class="metric"><div class="label">إجمالي التخفيض / الدائن</div><strong>${formatPosMoney(Number(summary.total_credit || 0))}</strong></div><div class="metric"><div class="label">الرصيد النهائي / المتبقي</div><strong>${formatPosMoney(Number(summary.final_balance || 0))}</strong></div>`;
}
async function loadCentralStatement() {
  const kind = centralKind();
  if (!kind.startsWith('all-') && !centralEntityId()) return toast('ابحث واختر جهة أولًا', 'warning');
  const output = document.getElementById('central-output');
  output.innerHTML = '<div class="empty">جاري تحميل الكشف...</div>';
  centralSetStatus('جاري التحميل');
  try {
    if (kind === 'all-customers' || kind === 'all-suppliers') {
      const endpoint = kind === 'all-customers' ? '/customers' : '/suppliers';
      const response = await fetch(`${API}${endpoint}?limit=100&page=1`, { headers: auth() });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'فشل تحميل القائمة');
      const rows = data.customers || data.suppliers || [];
      document.getElementById('central-summary').innerHTML = `<div class="metric"><div class="label">عدد الجهات</div><strong>${rows.length}</strong></div><div class="metric"><div class="label">إجمالي الأرصدة</div><strong>${formatPosMoney(rows.reduce((sum, row) => sum + Number(row.balance || 0), 0))}</strong></div>`;
      output.innerHTML = renderCentralRows('all', rows);
      centralSetStatus('تم التحديث');
      return;
    }
    const response = await fetch(centralStatementUrl(kind, 1, document.getElementById('central-limit').value), { headers: auth() });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'فشل تحميل الكشف');
    const rows = data.statement || data.movements || [];
    document.getElementById('central-summary').innerHTML = renderCentralSummary(kind, data);
    output.innerHTML = renderCentralRows(kind, rows);
    centralSetStatus(`تم التحديث — ${rows.length} صف`);
  } catch (error) {
    output.innerHTML = `<div class="empty" style="color:var(--danger)">${esc(error.message)}</div>`;
    centralSetStatus(error.message, 'error');
  }
}
async function printCentralStatement() {
  if (!document.getElementById('central-output').querySelector('table')) await loadCentralStatement();
  const output = document.getElementById('central-output');
  if (!output.querySelector('table')) return toast('لا توجد بيانات للطباعة', 'warning');
  if (window.POSDocs) POSDocs.printReport(output, { title: 'كشف مخصص' }).catch(error => toast(error.message, 'error')); else window.print();
}
'''
path.write_text(text[:start] + central + text[end:], encoding='utf-8')
print('central functions replaced safely')
