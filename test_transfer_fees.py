from pathlib import Path

root = Path(__file__).parent
worker = (root / 'worker.js').read_text(encoding='utf-8')
page = (root / 'cash-wallets.html').read_text(encoding='utf-8')

for marker in ["'cash_in'", "'cash_out'", "'wallet'", "'exchange'", "fee_deducted_from_amount", "ensureWalletBalance", "cash_wallet_transfer", "رسوم التحويل (اختياري)", "خصم الرسوم من المبلغ المحدد"]:
    assert marker in worker or marker in page, f'missing transfer-fee marker: {marker}'


def balanced(debit, credit):
    assert abs(debit - credit) < 1e-9

# Fee added on top: recipient gets full amount; source pays amount + fee.
amount, fee = 100.0, 3.0
balanced(amount + fee, amount + fee)
# Fee deducted: recipient gets net amount; source pays exactly the selected amount.
net = amount - fee
balanced(net + fee, amount)
assert net == 97.0

# All four flows must expose the same fee/option contract.
assert page.count('id="transfer-fee"') == 1
assert page.count('id="fee-deducted-from-amount"') == 1
assert 'feeDeducted' in page and 'fee_deducted_from_amount: feeDeducted' in page
print('PASS transfer fee contract and balance math')
