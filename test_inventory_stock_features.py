from pathlib import Path

root = Path(__file__).parent
inventory = (root / 'inventory.html').read_text(encoding='utf-8')
stock = (root / 'stock-movements.html').read_text(encoding='utf-8')
worker = (root / 'worker.js').read_text(encoding='utf-8')

for marker in ['printManualInventorySheet', 'pageLimit = 100', 'allProducts', 'الكمية المعدودة', 'الرصيد بالنظام']:
    if marker not in inventory:
        raise SystemExit(f'inventory feature missing: {marker}')
if inventory.count('printManualInventorySheet') < 2:
    raise SystemExit('inventory print button/function is not wired')
for marker in ['productSearchInput', '/products/search?term=', 'selectedProductCard', 'movementTableBody', 'closingBalance', 'loadSelectedMovements', 'printSelectedMovements', 'الرصيد بعد العملية']:
    if marker not in stock:
        raise SystemExit(f'stock feature missing: {marker}')
if 'productsTableBody' in stock or 'loadProducts(' in stock or 'categoryFilter' in stock:
    raise SystemExit('old all-products listing logic remains in stock movements page')
for marker in ['COUNT(*) AS total FROM stock_movements', 'current_stock:', 'closing_balance:', 'latest_operation:']:
    if marker not in worker:
        raise SystemExit(f'worker movement summary missing: {marker}')
if any('printManualInventorySheet' in p.read_text(encoding='utf-8', errors='ignore') or 'productSearchInput' in p.read_text(encoding='utf-8', errors='ignore') for p in (root / 'driver').rglob('*') if p.is_file()):
    raise SystemExit('inventory/stock feature leaked into driver app')
print('PASS inventory print and single-product movement feature checks')
