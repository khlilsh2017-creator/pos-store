from pathlib import Path

root = Path(__file__).parent
worker = (root / 'worker.js').read_text(encoding='utf-8')
desktop = (root / 'orders.html').read_text(encoding='utf-8')
phone = (root / 'phone' / 'orders.html').read_text(encoding='utf-8')

for marker in [
    'driver_order_receipts',
    "path === '/drivers/unreceived-orders'",
    "path === '/drivers/receive-orders'",
    'unreceived_order_count',
    'unreceived_order_total',
    'failed_order_count',
    "type, amount, description) VALUES (?, ?, 'order_receipt'",
    "action: 'driver.order_receipt'",
]:
    assert marker in worker, f'worker receipt marker missing: {marker}'

for marker in ['driverReceiptModal', 'openDriverReceiptModal', 'receiveOneDriverOrder', 'receiveAllDriverOrders', 'استلام (', 'unreceived_order_total']:
    assert marker in desktop, f'desktop receipt marker missing: {marker}'

for marker in ['receiptBackdrop', 'openMobileReceipt', 'receiveOneMobileOrder', 'receiveAllMobileOrders', 'استلام الطلبات', 'unreceived_order_total']:
    assert marker in phone, f'phone receipt marker missing: {marker}'

print('PASS driver order receipt settlement coverage')
