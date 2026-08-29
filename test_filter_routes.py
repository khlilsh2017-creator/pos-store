from pathlib import Path
from bs4 import BeautifulSoup

root = Path(__file__).parent
worker = (root / 'worker.js').read_text(encoding='utf-8')
filter_utils = (root / 'filter-utils.js').read_text(encoding='utf-8')
checks = {
    'invoices.html': ['filterDateFrom', 'filterDateTo', 'filterCustomer', 'filterPayment', 'filterStatus'],
    'purchases.html': ['log-search', 'log-filter-method'],
    'expenses.html': ['expense-filters'],
    'payments.html': ['filter-from', 'filter-to', 'filter-search', 'filter-type'],
    'journal.html': ['journal-from', 'journal-to', 'journal-search'],
    'orders.html': ['filterDateFrom', 'filterDateTo', 'filterSearch', 'filterStatus', 'filterDriver'],
    'online-reports.html': ['filterDateFrom', 'filterDateTo', 'filterStatus', 'filterPayment'],
    'stock-movements.html': ['productSearchInput'],
    'customers.html': ['search-customer'],
    'suppliers.html': ['searchInput', 'filterBalance'],
}
endpoints = ['/sales', '/purchases', '/expenses', '/cash/vouchers', '/journal-entries', '/online-orders', '/stock-movements', '/customers/statement', '/suppliers/statement', '/reports/daily']
for page, ids in checks.items():
    text = (root / page).read_text(encoding='utf-8')
    soup = BeautifulSoup(text, 'html.parser')
    if len(soup.select('script[src="filter-utils.js"]')) != 1:
        raise SystemExit(f'{page}: expected exactly one filter-utils script')
    for ident in ids:
        if len(soup.select(f'#{ident}')) != 1:
            raise SystemExit(f'{page}: expected exactly one #{ident}')
for endpoint in endpoints:
    if endpoint not in worker:
        raise SystemExit(f'worker route/helper missing endpoint marker: {endpoint}')
for marker in ['businessISODate', 'POS_SQL_UTC_SHIFT', 'parseListQuery', 'appendDateRange', 'datetime(${field})', 'datetime(o.order_date)']:
    if marker not in worker:
        raise SystemExit(f'worker missing local-day filter marker: {marker}')
for marker in ["fromParam: 'date_from'", "toParam: 'date_to'", "searchParams.delete(name)"]:
    if marker not in filter_utils:
        raise SystemExit(f'filter-utils missing date alias marker: {marker}')
for marker in ['localISODate', 'return { from: today, to: today }', "params.set(aliases.from || 'from'", "date_from"]:
    if marker not in filter_utils:
        raise SystemExit(f'filter-utils missing today/alias marker: {marker}')
suppliers_page = (root / 'suppliers.html').read_text(encoding='utf-8')
if "'suppliers.html': { key: 'suppliers'" not in filter_utils or "container: '.search-bar'" not in filter_utils:
    raise SystemExit('suppliers filter must mount on .search-bar, not supplier card/list')
if 'id="supplier-tbody"' not in suppliers_page:
    raise SystemExit('suppliers page table marker missing')
order_page = (root / 'phone' / 'add_order_ph.html').read_text(encoding='utf-8')
for marker in ['products/${product.id}/variants', 'order-set-mode', 'variant_id', 'sale_mode']:
    if marker not in order_page:
        raise SystemExit(f'phone/add_order_ph.html missing set-order marker: {marker}')
for page in ['invoices.html', 'orders.html', 'online-reports.html']:
    if 'variant_label' not in (root / page).read_text(encoding='utf-8'):
        raise SystemExit(f'{page}: missing variant label in invoice rendering')
for page in ['invoices.html', 'payments.html', 'journal.html', 'orders.html', 'online-reports.html', 'expenses.html']:
    soup = BeautifulSoup((root / page).read_text(encoding='utf-8'), 'html.parser')
    filter_buttons = [b for b in soup.select('button') if any(word in b.get_text(' ', strip=True) for word in ['تطبيق الفلترة', 'تطبيق الفترة', 'تصفير الفلاتر'])]
    if filter_buttons:
        raise SystemExit(f'{page}: legacy filter buttons remain: {[b.get_text(" ", strip=True) for b in filter_buttons]}')
print('PASS filter route/selector compatibility checks')
