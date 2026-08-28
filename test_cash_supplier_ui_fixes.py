from pathlib import Path

root = Path('/home/ubuntu/pos_project_mobile_accounting_audited')
cash = (root / 'cash-wallets.html').read_text(encoding='utf-8')
suppliers = (root / 'suppliers.html').read_text(encoding='utf-8')
filters = (root / 'filter-utils.js').read_text(encoding='utf-8')

assert 'function clean(value)' in suppliers
assert 'function loadCashHistory' not in cash
assert 'await loadCashLedger();' in cash
assert 'async function loadUnifiedLedgers()' in cash
assert "toggleLedgerFilter('cash')" in cash and "toggleLedgerFilter('wallet')" in cash
assert 'id="cash-ledger-filters"' in cash and 'id="wallet-ledger-filters"' in cash
assert 'id="ledger-unified-filter-host"' in cash
assert "'cash-wallets.html':" in filters
assert "endpoints: ['/cash/transactions', '/wallets/transactions']" in filters
assert "refresh: 'loadUnifiedLedgers'" in filters
assert "params.set('from', state.from)" in cash and "params.set('to', state.to)" in cash
print('PASS: cash/wallet ledgers auto-load, toggle filters, unified date filter, and supplier clean helper.')
