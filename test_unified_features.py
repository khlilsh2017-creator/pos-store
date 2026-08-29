from pathlib import Path
import re

root = Path('/home/ubuntu/pos_project_mobile_accounting_audited')
worker = (root / 'worker.js').read_text(encoding='utf-8')
payments = (root / 'payments.html').read_text(encoding='utf-8')
suppliers = (root / 'suppliers.html').read_text(encoding='utf-8')
number_utils = (root / 'number-utils.js').read_text(encoding='utf-8')

assert "{ table: 'customer_payments', col: 'type', type: \"TEXT DEFAULT 'receipt'\" }" in worker
assert "!['receipt', 'payment'].includes(type)" in worker
customer_start = worker.index('async function addCustomerPayment')
customer_end = worker.index('async function getCustomerStatement', customer_start)
customer = worker[customer_start:customer_end]
assert "[isPayment ? 'withdraw' : 'deposit'" in customer
assert "if (isPayment) { details.push({ account_id: customerAccountId, debit: base" in customer
assert "else { details.push({ account_id: cashAccountId, debit: base" in customer
assert "UPDATE customers SET balance = balance ${isPayment ? '+' : '-'}" in customer

unified_start = worker.index('async function getUnifiedVouchers')
unified_end = worker.index('async function cancelCashVoucher', unified_start)
unified = worker[unified_start:unified_end]
assert unified.count('UNION ALL') == 2
assert "'cash_voucher' source_type" in unified and "'customer_payment'" in unified and "'supplier_payment'" in unified
assert "COALESCE(status,'active') != 'cancelled'" in unified
assert "path === '/vouchers/all'" in worker

return_start = worker.index('async function getSupplierReturnDetail')
return_end = worker.index('async function getSupplierRemainingStock', return_start)
return_fn = worker[return_start:return_end]
assert 'purchase_invoice_id' in return_fn and 'product_code' in return_fn and 'unit_price' in return_fn
assert "path.match(/^\\/suppliers\\/returns\\/\\d+\\/?$/)" in worker
stock_start = worker.index('async function getSupplierRemainingStock')
stock_end = worker.index('async function getSupplierFinancialBalance', stock_start)
stock = worker[stock_start:stock_end]
assert 'remaining_value' in stock and 'summary: { total_value:' in stock

assert 'id="voucher-party-type"' in payments
assert '/vouchers/all?' in payments
assert 'async function loadVoucherParties' in payments
assert 'async function submitVoucher' in payments
assert 'printUnifiedVoucher' in payments
assert 'id="voucher-currency"' in payments
assert 'id="filter-party"' in payments

assert 'async function viewReturnDetail' in suppliers and '/suppliers/returns/${r.id}' in suppliers
assert 'function printSupplierStock' in suppliers and 'total_value' in suppliers and 'remaining_value' in suppliers
assert 'data-grouped-number' in number_utils
assert 'formatGroupedInput' in number_utils and 'stripGroupedValue' in number_utils

# Every HTML page that declares a numeric input must load the shared normalizer.
for page in root.rglob('*.html'):
    text = page.read_text(encoding='utf-8', errors='ignore')
    if re.search(r'type=["\']number["\']', text):
        assert 'number-utils.js' in text, f'missing number-utils.js: {page}'
print('PASS: unified voucher, supplier return/stock, customer accounting, and numeric UI contracts.')
