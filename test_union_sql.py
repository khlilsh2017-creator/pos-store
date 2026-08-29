import sqlite3

conn = sqlite3.connect(':memory:')
conn.executescript('CREATE TABLE sales(id INTEGER, customer_id INTEGER, created_at TEXT); CREATE TABLE customer_payments(id INTEGER, customer_id INTEGER, amount REAL, created_at TEXT); CREATE TABLE purchase_invoices(id INTEGER, supplier_id INTEGER, created_at TEXT, payment_method TEXT); CREATE TABLE supplier_payments(id INTEGER, supplier_id INTEGER, amount REAL, created_at TEXT, type TEXT); CREATE TABLE returned_purchases(id INTEGER, purchase_invoice_id INTEGER, amount REAL, created_at TEXT); CREATE TABLE currencies(id INTEGER, rate_to_base REAL, code TEXT, name TEXT); CREATE TABLE wallets(id INTEGER, name TEXT);')
conn.execute("INSERT INTO sales VALUES (1, 2, '2026-08-24 10:00:00')")
conn.execute("INSERT INTO customer_payments VALUES (2, 2, 5, '2026-08-24 11:00:00')")
customer_union = "SELECT s.id, NULL invoice_number, 0 total_amount, s.created_at, 'sale' as type, NULL as payment_method, NULL as note, NULL as wallet_name FROM sales s WHERE s.customer_id = ? UNION ALL SELECT cp.id, NULL as invoice_number, cp.amount as total_amount, cp.created_at, 'payment' as type, NULL as payment_method, NULL as note, NULL as wallet_name FROM customer_payments cp WHERE cp.customer_id = ?"
try:
    conn.execute(f"SELECT * FROM ({customer_union}) AS statement_rows ORDER BY created_at LIMIT ?", (2, 2, 20)).fetchall()
except sqlite3.Error as exc:
    raise SystemExit(f'customer union failed: {exc}')
print('PASS UNION SQL syntax')
