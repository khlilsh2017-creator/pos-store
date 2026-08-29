from pathlib import Path

root = Path('/home/ubuntu/pos_project_mobile_accounting_audited')
worker = (root / 'worker.js').read_text(encoding='utf-8')
page = (root / 'cash-wallets.html').read_text(encoding='utf-8')

wallet_start = worker.index('async function getWalletTransactions')
wallet_end = worker.index('// ---- الصندوق ----', wallet_start)
wallet = worker[wallet_start:wallet_end]
assert "url.searchParams.get('wallet_id')" in wallet
assert "url.searchParams.get('type')" in wallet
assert "url.searchParams.get('detail')" in wallet
assert "appendDateRange(conditions, args, 'wt.created_at'" in wallet
assert 'operation_detail' in wallet
assert 'LIMIT ? OFFSET ?' in wallet
assert 'walletResponse(listResponse' in wallet

cash_start = worker.index('async function getCashTransactions')
cash_end = worker.index('async function getCashStatus', cash_start)
cash = worker[cash_start:cash_end]
assert "url.searchParams.get('type')" in cash
assert "url.searchParams.get('currency_id')" in cash
assert "url.searchParams.get('detail')" in cash
assert "appendDateRange(conditions, args, 'cr.created_at'" in cash
assert 'operation_detail' in cash
assert 'LIMIT ? OFFSET ?' in cash
assert "path === '/cash/transactions' && method === 'GET'" in worker
assert "path === '/wallets/transactions' && method === 'GET'" in worker

for key in ['cash-filter-type', 'cash-filter-currency', 'cash-filter-detail', 'wallet-filter-wallet', 'wallet-filter-type', 'wallet-filter-detail']:
    assert f'id="{key}"' in page, key
assert 'loadCashLedger' in page and 'loadWalletLedger' in page
assert 'printCashLedger' in page and 'printWalletLedger' in page
assert '/cash/transactions?' in page and '/wallets/transactions?' in page
assert 'operation_detail' in worker and 'description' in worker
print('PASS: wallet and cash detailed ledger API/UI contract.')
