from pathlib import Path

root = Path(__file__).parent
date_utils = (root / 'date-utils.js').read_text(encoding='utf-8')
driver = (root / 'driver' / 'index.html').read_text(encoding='utf-8')
add_order_ph = (root / 'phone' / 'add_order_ph.html').read_text(encoding='utf-8')
assert "const TIME_ZONE = 'Asia/Aden'" in date_utils
assert 'function inputToUTC' in date_utils and 'function toLocalInput' in date_utils
assert "Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])" in date_utils
assert '<script src="../date-utils.js"></script>' in driver
assert 'POSDate.toDate(rawDate)' in driver and 'POSDate.localized(rawDate' in driver
assert 'POSDate.inputToUTC(value)' in add_order_ph and 'POSDate.toLocalInput(order.order_date)' in add_order_ph
for name in ['invoices.html', 'orders.html', 'purchases.html', 'sale.html', 'audit-logs.html', 'cash-wallets.html', 'payments.html', 'expenses.html', 'customers.html']:
    html = (root / name).read_text(encoding='utf-8')
    assert 'date-utils.js' in html, f'{name} does not load date-utils.js'
print('PASS Yemen timezone coverage: Asia/Aden conversion, order creation, driver display, and ledger pages')
