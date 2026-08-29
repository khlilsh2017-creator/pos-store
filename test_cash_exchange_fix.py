from pathlib import Path
import re

root = Path(__file__).parent
worker = (root / 'worker.js').read_text(encoding='utf-8')
page = (root / 'cash-wallets.html').read_text(encoding='utf-8')

# The deployed schema accepts only these two wallet movement types.
for forbidden in ["transfer_out", "transfer_in", "exchange_out", "exchange_in"]:
    assert not re.search(r"wallet_transactions[\\s\\S]{0,500}\\btype\\b[\\s\\S]{0,180}['\\\"]" + forbidden + r"['\\\"]", worker), f'disallowed wallet transaction type remains: {forbidden}'
for allowed in ["'deposit'", "'withdraw'"]:
    assert allowed in worker
# `fee` is a valid UI/detail classification and must not be treated as a wallet_transactions type.

assert "return await getOrCreateAccount(conn, 'خسائر صرف العملات', '6300', 'expense');" in worker
assert "type === 'cash_exchange'" in worker
assert "path === '/cash/exchange'" in worker
assert "from_currency_id" in page and "to_currency_id" in page
assert 'id="transfer-amount"' in page
assert 'id="transfer-amount-label"' in page
assert 'المبلغ المراد مصارفته من عملة المصدر' in page
assert 'value="cash_exchange"' in page
assert 'لا توجد رسوم تحويل في المصارفة الداخلية' in worker
assert 'transfer-fee-field' in page and 'fee-deducted-field' in page
print('PASS SQLite wallet types, exchange-loss account, and internal cash exchange contract')
