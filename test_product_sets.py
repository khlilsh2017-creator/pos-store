from pathlib import Path
import re
import subprocess
import tempfile

root = Path(__file__).parent
worker = (root / 'worker.js').read_text(encoding='utf-8')
products = (root / 'products.html').read_text(encoding='utf-8')
purchases = (root / 'purchases.html').read_text(encoding='utf-8')
sale = (root / 'sale.html').read_text(encoding='utf-8')
barcode = (root / 'barcode-print.html').read_text(encoding='utf-8')

checks = [
    ('is_set', worker, 'set migration/backend'),
    ('set_piece_count', worker, 'set piece count backend'),
    ('set_details_json', worker, 'set details backend'),
    ('CREATE TABLE IF NOT EXISTS product_variants', worker, 'per-size inventory table'),
    ('async function getProductVariants', worker, 'variants endpoint'),
    ('variant_id', worker, 'variant sale/purchase linkage'),
    ('generateUniqueVariantBarcode', worker, 'unique size barcode generation'),
    ('sale_mode === \'full_set\'', worker, 'whole-set sale backend'),
    ('const allocatedCost', worker, 'distributed set cost'),
    ('سعر المقاس «${variant.label}» أقل من تكلفته الموزعة', worker, 'size cost floor'),
    ('UPDATE product_variants SET stock_quantity', worker, 'selected-size stock decrement'),
    ('if (data.barcode !== undefined)', worker, 'barcode update backend'),
    ('async function generateUniqueProductBarcode', worker, 'unique automatic barcode generation'),
    ('pIsSet', products, 'products set form'),
    ('collectSetDetails', products, 'products set details'),
    ('set-detail-label', products, 'size-only product form'),
    ('set-detail-barcode', products, 'size barcode field'),
    ('السعر تلقائي', products, 'automatic size price'),
    ('الباركود اختياري', purchases, 'purchase optional barcode'),
    ('new-product-is-set', purchases, 'purchase set form'),
    ('toggleQuickSetFields', purchases, 'purchase set details'),
    ('updateItemField(${idx},\'name\'', purchases, 'editable purchase product name'),
    ('لا يمكن أن يكون سعر البيع أقل من التكلفة', purchases, 'purchase price floor'),
    ('الوحدة:', sale, 'sale unit display'),
    ('set-summary', sale, 'sale set cart display'),
    ('allBarcodeItems', barcode, 'barcode size catalog'),
    ('اختر المقاس', sale, 'sale size selector'),
    ('selectSaleVariant', sale, 'sale variant selection'),
    ('selectSaleMode', sale, 'whole-set or size sale mode'),
    ('بيع الطقم كاملًا', sale, 'whole-set sale button'),
    ('variant_label', sale, 'sale cart variant label'),
    ('v.barcode', sale, 'variant barcode scanner field'),
]
for needle, haystack, label in checks:
    assert needle in haystack, label
    print('PASS', label)

for page in ['products.html', 'purchases.html', 'sale.html', 'barcode-print.html']:
    html=(root/page).read_text(encoding='utf-8')
    blocks=re.findall(r'<script(?:\s[^>]*)?>(.*?)</script>', html, flags=re.S)
    for block in blocks:
        if any(x in block for x in ['set_piece_count','toggleQuickSetFields','set-summary','saveProduct','allBarcodeItems']):
            with tempfile.NamedTemporaryFile('w', suffix='.js', encoding='utf-8', delete=False) as f:
                f.write(block); temp=Path(f.name)
            try: subprocess.run(['node','--check',str(temp)],check=True,capture_output=True,text=True)
            finally: temp.unlink(missing_ok=True)
            print('PASS', page, 'inline JavaScript syntax')
            break
    else: raise AssertionError(f'{page}: relevant script not found')

assert "await generateUniqueProductBarcode(client)" in worker
assert "await generateUniqueProductBarcode(tx)" in worker
assert "sellingPrice < costPrice" in worker
assert "UPDATE products SET name = ?, price = ?" in worker
assert "variant_id: i.variant_id" in sale
print('PASS automatic barcode generation is used by product and purchase creation')
print('ALL PRODUCT SET TESTS PASSED')
