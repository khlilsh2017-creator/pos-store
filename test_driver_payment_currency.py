from pathlib import Path

root = Path(__file__).parent
worker = (root / 'worker.js').read_text(encoding='utf-8')
driver = (root / 'driver' / 'index.html').read_text(encoding='utf-8')
assert "if (path.startsWith('/currencies')) return m === 'GET' ? 'currencies.view'" in worker
assert "if (path === '/wallets') return m === 'GET' ? 'wallets.view'" in worker
assert "return normalizePermissionList([...stored" in worker
assert "'currencies.view', 'wallets.view'" in worker
assert 'function getDeliveryFeeDue(order)' in worker
assert 'function getExpectedCashForOrder(order)' in worker
assert 'if (isPrepaidOrder(order)) return getDeliveryFeeDue(order);' in worker
assert 'expected_cash: getExpectedCashForOrder(o)' in worker
assert 'order.expected_cash = getExpectedCashForOrder(order);' in worker
assert 'function getDeliveryFeeDue(order)' in driver
assert 'if (isPrepaidOrder(order)) return getDeliveryFeeDue(order);' in driver
assert 'رسوم التوصيل المستحقة' in driver
assert 'fetchCurrencies' in driver and 'fetchWallets' in driver
print('PASS driver currency/wallet permissions and prepaid delivery-fee due coverage')
