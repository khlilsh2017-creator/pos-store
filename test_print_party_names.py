from pathlib import Path

root = Path(__file__).parent
checks = {
    'reports.html': [
        'function centralPrintTitle',
        'كشف حساب العميل:',
        'كشف حساب المورد:',
        'central-print-heading',
    ],
    'customers.html': [
        'كشف حساب العميل: ${customerName}',
        'window._customerStatementData.party',
        'customer_name: data.customer_name',
    ],
    'suppliers.html': [
        'كشف حساب المورد: ${clean(supplierName)}',
        'مرتجع المورد: ${supplierName}',
        'window._supplierStatementData?.party',
    ],
    'document-utils.js': [
        'data.party || data.customer_name || data.supplier_name',
        'الرصيد السابق قبل الفترة',
    ],
}
for name, needles in checks.items():
    text = (root / name).read_text(encoding='utf-8')
    for needle in needles:
        assert needle in text, f'{name}: missing {needle}'
        print(f'PASS {name}: {needle}')
print('ALL PARTY NAME PRINT TESTS PASSED')
