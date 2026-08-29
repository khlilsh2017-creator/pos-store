from pathlib import Path
import re

root = Path(__file__).parent
pages = ['invoices.html','purchases.html','expenses.html','payments.html','journal.html','orders.html','online-reports.html','stock-movements.html','customers.html','suppliers.html','reports.html']
for name in pages:
    text = (root / name).read_text(encoding='utf-8')
    if 'filter-utils.js' not in text:
        raise SystemExit(f'{name}: filter-utils.js missing')
    if text.count('filter-utils.js') != 1:
        raise SystemExit(f'{name}: duplicate filter-utils.js reference')
    if name == 'expenses.html' and text.count('id="expense-filters"') != 1:
        raise SystemExit(f'{name}: filter host count is not one')
    if name != 'expenses.html' and 'pos-filter-toggle' not in text and 'pos-filter-toggle' not in (root / 'filter-utils.js').read_text(encoding='utf-8'):
        raise SystemExit(f'{name}: toggle implementation missing')

driver = root / 'driver'
if any('filter-utils.js' in p.read_text(encoding='utf-8', errors='ignore') for p in driver.rglob('*') if p.is_file()):
    raise SystemExit('driver: filter utility leaked into driver app')
print(f'PASS UI integration checks for {len(pages)} admin pages; driver excluded')
