from pathlib import Path

worker = Path('worker.js').read_text(encoding='utf-8')
assert 'async function updateSupplierStock(tx, productId, supplierId, delta, batchQueries)' in worker
assert 'Math.max(0, quantity + Math.min(0, currentStock))' in worker
assert 'ON CONFLICT(product_id, supplier_id) DO UPDATE SET' in worker
assert "quantity = MAX(0, product_supplier_stock.quantity + ?)" in worker
for function_name in (
    'cancelSaleInvoice', 'returnSaleItem', 'fullReturnSaleInvoice',
    'undoReturnSaleItem', 'undoCancelSaleInvoice', 'updateSale',
    'cancelOnlineOrder', 'updateDeliveryStatus', 'cancelPurchaseInvoice',
    'returnPurchaseItem'
):
    start = worker.find(f'async function {function_name}')
    assert start >= 0, function_name
    end = worker.find('\nasync function ', start + 1)
    body = worker[start:end if end >= 0 else None]
    assert 'updateSupplierStock' in body, f'missing supplier update in {function_name}'
print('PASS supplier stock consistency coverage')
