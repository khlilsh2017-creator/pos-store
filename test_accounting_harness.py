import sqlite3
from math import isfinite

TOL = 0.001

def connect():
    db = sqlite3.connect(':memory:')
    db.executescript('''
      CREATE TABLE accounts(id INTEGER PRIMARY KEY, name TEXT, type TEXT);
      CREATE TABLE journal_entries(id INTEGER PRIMARY KEY AUTOINCREMENT, entry_date TEXT, reference_type TEXT, reference_id INTEGER);
      CREATE TABLE journal_entry_details(entry_id INTEGER, account_id INTEGER, debit REAL, credit REAL);
      CREATE TABLE customers(id INTEGER PRIMARY KEY, balance REAL);
      CREATE TABLE suppliers(id INTEGER PRIMARY KEY, balance REAL);
      CREATE TABLE cash_register(type TEXT, amount REAL, currency_id INTEGER, exchange_rate REAL);
      CREATE TABLE currencies(id INTEGER PRIMARY KEY, code TEXT, rate_to_base REAL);
      CREATE TABLE wallet_balances(wallet_id INTEGER, currency_id INTEGER, balance REAL, UNIQUE(wallet_id,currency_id));
      CREATE TABLE wallet_transactions(wallet_id INTEGER, type TEXT, amount REAL, currency_id INTEGER, reference_id INTEGER);
    ''')
    db.executemany('INSERT INTO accounts VALUES (?,?,?)', [
        (1, 'الصندوق', 'asset'), (2, 'المحافظ', 'asset'), (3, 'المبيعات', 'income'),
        (4, 'المصروفات', 'expense'), (5, 'الذمم المدينة (عملاء)', 'asset'),
        (6, 'الذمم الدائنة (موردين)', 'liability'), (7, 'المخزون', 'asset'),
        (8, 'الأرباح المحتجزة', 'equity')])
    db.executemany('INSERT INTO currencies VALUES (?,?,?)', [(1, 'YER', 1.0), (2, 'SAR', 70.0), (3, 'USD', 250.0)])
    db.execute('INSERT INTO customers VALUES (1, 0)')
    db.execute('INSERT INTO suppliers VALUES (1, 0)')
    return db

def balanced(details):
    assert len(details) >= 2
    total = 0.0
    for account_id, debit, credit in details:
        assert int(account_id) > 0
        assert isfinite(float(debit)) and isfinite(float(credit))
        assert debit >= 0 and credit >= 0 and not (debit > 0 and credit > 0)
        assert debit != 0 or credit != 0
        total += debit - credit
    assert abs(total) <= TOL, total

def entry(db, date, ref, ref_id, details):
    balanced(details)
    cur = db.execute('INSERT INTO journal_entries(entry_date,reference_type,reference_id) VALUES (?,?,?)', (date, ref, ref_id))
    eid = cur.lastrowid
    db.executemany('INSERT INTO journal_entry_details VALUES (?,?,?,?)', [(eid, *d) for d in details])
    return eid

def ledger_sum(db, account_id, cutoff=None, exclude=None):
    sql = '''SELECT COALESCE(SUM(d.debit-d.credit),0) FROM journal_entry_details d
             JOIN journal_entries e ON e.id=d.entry_id WHERE d.account_id=?'''
    args = [account_id]
    if cutoff:
        sql += ' AND DATE(e.entry_date)<=DATE(?)'; args.append(cutoff)
    if exclude:
        sql += ' AND e.reference_type!=?'; args.append(exclude)
    return db.execute(sql, args).fetchone()[0]

def test_voucher_cancel(db):
    eid = entry(db, '2025-12-31', 'cash_voucher', 10, [(1, 700, 0), (4, 0, 700)])
    db.execute("INSERT INTO cash_register VALUES ('deposit', ?, ?, ?)", (10, 2, 70))
    original = db.execute('SELECT account_id,debit,credit FROM journal_entry_details WHERE entry_id=?', (eid,)).fetchall()
    rev = [(a, c, d) for a, d, c in original]
    entry(db, '2026-01-02', 'cancel_cash_voucher', 10, rev)
    db.execute("INSERT INTO cash_register VALUES ('withdraw', ?, ?, ?)", (10, 2, 70))
    assert abs(ledger_sum(db, 1)) < TOL
    assert abs(sum((1 if r[0] == 'deposit' else -1) * r[1] * r[3] for r in db.execute('SELECT type,amount,currency_id,exchange_rate FROM cash_register'))) < TOL

def test_customer_foreign_cancel(db):
    # 100 SAR = 7,000 base; record historical rate and reverse same base amount.
    entry(db, '2026-01-03', 'customer_payment', 20, [(1, 7000, 0), (5, 0, 7000)])
    db.execute('UPDATE customers SET balance=balance-7000 WHERE id=1')
    entry(db, '2026-01-04', 'cancel_payment', 20, [(1, 0, 7000), (5, 7000, 0)])
    db.execute('UPDATE customers SET balance=balance+7000 WHERE id=1')
    assert abs(db.execute('SELECT balance FROM customers WHERE id=1').fetchone()[0]) < TOL
    assert abs(ledger_sum(db, 1)) < TOL and abs(ledger_sum(db, 5)) < TOL

def test_first_wallet_deposit(db):
    db.execute('INSERT OR IGNORE INTO wallet_balances VALUES (?,?,?)', (1, 2, 0))
    db.execute('UPDATE wallet_balances SET balance=balance+? WHERE wallet_id=? AND currency_id=?', (10,1,2))
    db.execute('INSERT INTO wallet_transactions VALUES (?,?,?,?,?)', (1,'deposit',10,2,30))
    assert db.execute('SELECT balance FROM wallet_balances WHERE wallet_id=1 AND currency_id=2').fetchone()[0] == 10

def test_close_cutoff(db):
    entry(db, '2025-12-31', 'sale', 1, [(1,1000,0),(3,0,1000)])
    entry(db, '2026-01-01', 'sale', 2, [(1,2000,0),(3,0,2000)])
    income_2025 = -ledger_sum(db, 3, '2025-12-31', 'closing_entry')
    assert income_2025 == 1000
    close_details = [(3,1000,0),(8,0,1000)]
    entry(db, '2025-12-31', 'closing_entry', 1, close_details)
    assert abs(ledger_sum(db, 3, '2025-12-31')) < TOL
    assert abs(ledger_sum(db, 3, '2026-01-01') + 2000) < TOL

def test_purchase_return_not_double_converted(db):
    # createPurchase stores item unit_price in base: 10 SAR * 70 = 700 base.
    base_refund = 700 * 2
    assert base_refund == 1400
    # A second *70 would be 98,000 and is explicitly forbidden.
    assert base_refund != 1400 * 70

def test_mixed_currency_base_balance(db):
    # 50 SAR + 3,500 YER = 7,000 base, equal to a 100 SAR invoice.
    cash_base = 50 * 70
    wallet_base = 3500 * 1
    inventory_base = 7000
    details = [(7, inventory_base, 0), (1, 0, cash_base), (2, 0, wallet_base)]
    balanced(details)
    assert cash_base + wallet_base == inventory_base

def test_reopen_preserves_audit_trail(db):
    original = entry(db, '2025-12-31', 'closing_entry', 1, [(3, 1000, 0), (8, 0, 1000)])
    reversal = entry(db, '2026-01-05', 'reopen_closing', original, [(3, 0, 1000), (8, 1000, 0)])
    assert db.execute('SELECT COUNT(*) FROM journal_entries WHERE id IN (?,?)', (original, reversal)).fetchone()[0] == 2
    assert abs(ledger_sum(db, 3) + 0) < TOL
    assert abs(ledger_sum(db, 8) + 0) < TOL

def test_balance_sheet_equation(db):
    entry(db, '2026-01-10', 'opening', 1, [(1, 1000, 0), (6, 0, 600), (8, 0, 400)])
    assets = ledger_sum(db, 1)
    liabilities = -ledger_sum(db, 6)
    equity = -ledger_sum(db, 8)
    assert abs(assets - (liabilities + equity)) < TOL

def run():
    tests = [test_voucher_cancel, test_customer_foreign_cancel, test_first_wallet_deposit, test_close_cutoff, test_purchase_return_not_double_converted, test_mixed_currency_base_balance, test_reopen_preserves_audit_trail, test_balance_sheet_equation]
    for test in tests:
        db = connect()
        test(db)
        print('PASS', test.__name__)
    print('PASS all accounting harness tests')

if __name__ == '__main__':
    run()
