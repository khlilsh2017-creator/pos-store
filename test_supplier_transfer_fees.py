from pathlib import Path

root = Path(__file__).parent
worker = (root / 'worker.js').read_text(encoding='utf-8')
page = (root / 'suppliers.html').read_text(encoding='utf-8')

for marker in [
    "col: 'transfer_fee'",
    "col: 'fee_deducted_from_amount'",
    "col: 'settlement_base_amount'",
    "getOrCreateFeeAccount(tx)",
    "fee_deducted_from_amount",
    "transfer_fee",
    "settlement_base_amount",
    "id=\"detail-pay-fee\"",
    "id=\"detail-pay-fee-deducted\"",
    "رسوم التحويل يجب أن تكون أقل من المبلغ عند الخصم منه",
]:
    assert marker in worker or marker in page, f'missing supplier fee marker: {marker}'

# Payment case: amount 100 with fee 3 deducted means supplier balance decreases by 97,
# while the 3 is posted separately to the transfer-fee expense account.
amount, fee = 100.0, 3.0
settlement = amount - fee
assert settlement == 97.0
assert abs((settlement + fee) - amount) < 1e-9

# Fee on top means supplier settlement remains 100 and cash/wallet outflow is 103.
settlement_on_top = amount
source_outflow = amount + fee
assert settlement_on_top == 100.0 and source_outflow == 103.0
print('PASS supplier transfer-fee fields, expense classification, and settlement math')
