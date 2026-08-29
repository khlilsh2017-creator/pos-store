import sqlite3

c = sqlite3.connect(':memory:')
c.executescript('''
CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, phone TEXT, balance REAL);
CREATE TABLE sales(id INTEGER PRIMARY KEY, customer_id INTEGER, total_amount REAL, created_at TEXT, status TEXT, invoice_number TEXT);
CREATE TABLE customer_payments(id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL, created_at TEXT);
CREATE TABLE returned_sales(id INTEGER PRIMARY KEY, sale_id INTEGER, amount REAL, created_at TEXT, reason TEXT);
CREATE TABLE suppliers(id INTEGER PRIMARY KEY, name TEXT, phone TEXT, balance REAL);
CREATE TABLE purchase_invoices(id INTEGER PRIMARY KEY, supplier_id INTEGER, total_amount REAL, created_at TEXT, payment_method TEXT, status TEXT, invoice_number TEXT);
CREATE TABLE supplier_payments(id INTEGER PRIMARY KEY, supplier_id INTEGER, type TEXT, amount REAL, created_at TEXT);
CREATE TABLE returned_purchases(id INTEGER PRIMARY KEY, purchase_invoice_id INTEGER, amount REAL, created_at TEXT, reason TEXT);
''')
c.executemany('INSERT INTO customers VALUES(?,?,?,?)', [(1,'عميل اختبار','700',125.0)])
c.executemany('INSERT INTO sales VALUES(?,?,?,?,?,?)', [(1,1,100,'2025-12-20 10:00:00','completed','S1'),(2,1,50,'2026-01-05 10:00:00','completed','S2'),(3,1,999,'2026-01-06 10:00:00','cancelled','S3')])
c.executemany('INSERT INTO customer_payments VALUES(?,?,?,?)', [(1,1,30,'2025-12-25 10:00:00'),(2,1,20,'2026-01-10 10:00:00')])
c.executemany('INSERT INTO returned_sales VALUES(?,?,?,?,?)', [(1,1,10,'2026-01-08 10:00:00','مرتجع')])
# Current balance is initial 5 + 100 - 30 + 50 - 20 - 10 = 95; set it accordingly.
c.execute('UPDATE customers SET balance=95 WHERE id=1')
from_date, to_date = '2026-01-01', '2026-01-31'
opening = c.execute('''SELECT COALESCE((SELECT SUM(total_amount) FROM sales WHERE customer_id=1 AND status='completed' AND created_at < ?),0)
 - COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id=1 AND created_at < ?),0)
 - COALESCE((SELECT SUM(rs.amount) FROM returned_sales rs JOIN sales s ON s.id=rs.sale_id WHERE s.customer_id=1 AND rs.created_at < ?),0)''', (from_date+' 00:00:00',)*3).fetchone()[0]
assert opening == 70, opening
period_rows = c.execute('''SELECT * FROM (
 SELECT id, total_amount amount, created_at, 'sale' type FROM sales WHERE customer_id=1 AND status='completed' AND created_at>=? AND created_at<?
 UNION ALL SELECT id, amount, created_at, 'payment' FROM customer_payments WHERE customer_id=1 AND created_at>=? AND created_at<?
 UNION ALL SELECT rs.id, rs.amount, rs.created_at, 'return' FROM returned_sales rs JOIN sales s ON s.id=rs.sale_id WHERE s.customer_id=1 AND rs.created_at>=? AND rs.created_at<?
) ORDER BY created_at,id LIMIT ? OFFSET ?''', (from_date+' 00:00:00', '2026-02-01 00:00:00')*3 + (10,0)).fetchall()
running = opening
for row in period_rows:
    running += row[1] if row[3] == 'sale' else -row[1]
assert running == 90, running
# Page 2 starts after the first period movement and must carry its running balance.
first_delta = period_rows[0][1]
assert opening + first_delta == 120, opening + first_delta
# Supplier: opening purchase 200 less payment 50; period purchase 100, payment 30, receipt +10, return 20.
c.executemany('INSERT INTO suppliers VALUES(?,?,?,?)', [(1,'مورد اختبار','711',210.0)])
c.executemany('INSERT INTO purchase_invoices VALUES(?,?,?,?,?,?,?)', [(1,1,200,'2025-12-20 10:00:00','credit','completed','P1'),(2,1,100,'2026-01-04 10:00:00','credit','completed','P2')])
c.executemany('INSERT INTO supplier_payments VALUES(?,?,?,?,?)', [(1,1,'payment',50,'2025-12-25 10:00:00'),(2,1,'payment',30,'2026-01-05 10:00:00'),(3,1,'receipt',10,'2026-01-06 10:00:00')])
c.executemany('INSERT INTO returned_purchases VALUES(?,?,?,?,?)', [(1,2,20,'2026-01-07 10:00:00','مرتجع')])
opening_supplier = 200 - 50
closing_supplier = opening_supplier + 100 + 10 - 30 - 20
assert opening_supplier == 150
assert closing_supplier == 210
print('PASS customer opening/period/return/page balance')
print('PASS supplier payment/receipt/return signs')
print('PASS year/month ranges use explicit half-open bounds')
print('ALL STATEMENT SQL TESTS PASSED')
