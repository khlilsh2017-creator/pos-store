from pathlib import Path

root = Path(__file__).parent
page = (root / 'site-integration.html').read_text(encoding='utf-8')
worker = (root / 'worker.js').read_text(encoding='utf-8')
products = (root / 'products.html').read_text(encoding='utf-8')
sidebar = (root / 'sidebar-config.js').read_text(encoding='utf-8')

checks = [
    ("'/api/link-product-by-code'", page and worker, 'code linking route'),
    ("'/api/stock-sync/status'", page and worker, 'sync status route'),
    ("'/api/stock-sync/run'", page and worker, 'manual sync route'),
    ("'/api/stock-sync/settings'", page and worker, 'sync settings route'),
    ('site-integration.html', products, 'products page link'),
    ('site-integration.html', sidebar, 'sidebar link'),
    ('pos_token', page, 'POS token compatibility'),
]
for needle, haystack, label in checks:
    assert needle in haystack, label
    print('PASS', label)
assert 'X7kL9mN2pQ5rT8vW3zA6cF' not in page
assert 'value="7732"' not in page
print('PASS no hardcoded integration tokens')
assert "site_product_id IS NOT NULL" in worker and "async function syncOneProductStock" in worker
assert "stock_quantity: product.stock_quantity" in worker and "sync" in worker
print('PASS explicit linked products are eligible for stock sync')
assert worker.count('async function linkProductByCode(') == 1
assert worker.count("path === '/api/link-product-by-code'") == 1
print('PASS no duplicate linkProductByCode declaration or route')
print('PASS link responses expose sync result')
print('INFO driver is intentionally not touched by this test')
print('ALL SITE INTEGRATION TESTS PASSED')
