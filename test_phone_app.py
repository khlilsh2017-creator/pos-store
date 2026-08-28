from pathlib import Path
import json

root = Path(__file__).parent
main = root / 'add_order.html'
legacy = root / 'add_order_ph.html'
phone = root / 'phone' / 'add_order_ph.html'
phone_index = root / 'phone' / 'index.html'
manifest = root / 'phone' / 'manifest.json'
orders = root / 'phone' / 'orders.html'
sw = root / 'sw.js'
phone_sw = root / 'phone' / 'sw_phone.js'

assert main.exists() and main.stat().st_size > 100_000, 'add_order.html was not replaced with the full order page'
main_text = main.read_text(encoding='utf-8')
assert 'طلب إنترنت' in main_text and 'sidebar-config.js' in main_text, 'main order page markers are missing'
assert phone.exists() and phone.stat().st_size > 200_000, 'phone/add_order_ph.html is missing or incomplete'
phone_text = phone.read_text(encoding='utf-8')
for marker in ['../date-utils.js', '../number-utils.js', '../document-utils.js', 'manifest.json']:
    assert marker in phone_text, f'phone dependency marker missing: {marker}'
assert legacy.exists() and 'phone/add_order_ph.html' in legacy.read_text(encoding='utf-8'), 'legacy phone redirect is missing'
config = json.loads(manifest.read_text(encoding='utf-8'))
assert config['start_url'] == '/phone/index.html'
assert config['scope'] == '/phone/'
assert any(x.get('url') == '/phone/index.html?next=orders.html' for x in config.get('shortcuts', [])), 'phone manifest shortcut is missing'
assert phone_index.exists() and phone_index.stat().st_size > 4_000, 'phone/index.html is missing or incomplete'
index_text = phone_index.read_text(encoding='utf-8')
for marker in ['auth/login', 'openApp(\'add_order_ph.html\')', 'openApp(\'orders.html\')', 'pos_token']:
    assert marker in index_text, f'central phone login marker missing: {marker}'
assert orders.exists() and orders.stat().st_size > 20_000, 'phone/orders.html is missing or incomplete'
orders_text = orders.read_text(encoding='utf-8')
for marker in ['auth/login', 'localStorage.setItem(\'pos_token\'', 'online-orders?', 'online-orders/update-status', 'online-orders/assign-driver', 'drivers/summary', 'drivers/unreceived-orders', 'drivers/receive-orders', 'drivers/payment', 'drivers/transactions', 'returns?', "api('/returns/'+id+'/confirm'", "api('/returns/'+id+'/cancel'", 'POSDocs.printInvoiceData', 'POSDocs.printStatementData', 'استلام الطلبات', 'إدارة طلبات الإنترنت', "index.html?next=orders.html"]:
    assert marker in orders_text, f'phone orders marker missing: {marker}'
for marker in ["window.location.href='orders.html'", 'إدارة الطلبات']:
    assert marker in phone_text, f'add_order_ph mobile management marker missing: {marker}'
sw_text = sw.read_text(encoding='utf-8')
assert '/phone/index.html' in sw_text and '/phone/orders.html' in sw_text, 'service worker does not cache central phone login and orders'
assert 'tab-drivers' in orders_text and 'tab-returns' in orders_text and 'settlementBackdrop' in orders_text and 'statementSection' in orders_text and 'returnBackdrop' in orders_text, 'mobile driver and return management UI markers are missing'
for marker in ['unifiedFilters', 'filterFab', 'localStorage', 'unifiedFrom', 'unifiedTo', 'showLoading', 'globalLoading', 'POSDocs.printStatementData', 'statementPending', 'loadStatementData', 'حدد فترة كشف الحساب']:
    assert marker in orders_text, f'mobile filter/loading marker missing: {marker}'
assert 'settlementTotalWrap' in orders_text and 'settlementWalletAmountWrap' in orders_text and "method==='mixed'" in orders_text, 'mobile settlement fields are not grouped correctly'
assert phone_sw.exists() and phone_sw.stat().st_size > 1_000, 'phone/sw_phone.js is missing or incomplete'
phone_sw_text = phone_sw.read_text(encoding='utf-8')
assert "PHONE_CACHE" in phone_sw_text and '/phone/orders.html' in phone_sw_text and '/phone/add_order_ph.html' in phone_sw_text, 'phone service worker shell is incomplete'
assert '/phone/sw_phone.js' in sw_text, 'main service worker does not cache sw_phone.js'
worker_text = (root / 'worker.js').read_text(encoding='utf-8')
for marker in ['driver_order_receipts', '/drivers/unreceived-orders', '/drivers/receive-orders', 'unreceived_order_count', 'driver.order_receipt']:
    assert marker in worker_text, f'driver order receipt worker marker missing: {marker}'
print('PASS phone app structure, mobile orders UI, fallback login, and add_order replacement')
