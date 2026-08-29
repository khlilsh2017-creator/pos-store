import sqlite3

con = sqlite3.connect(':memory:')
con.executescript('''
CREATE TABLE categories(id INTEGER PRIMARY KEY, name TEXT NOT NULL, parent_id INTEGER);
CREATE TABLE products(id INTEGER PRIMARY KEY, category_id INTEGER);
CREATE TABLE sales(id INTEGER PRIMARY KEY, status TEXT, created_at TEXT);
CREATE TABLE sale_items(id INTEGER PRIMARY KEY, sale_id INTEGER, product_id INTEGER, quantity REAL, total_price REAL, cost_price REAL);
CREATE TABLE expenses(id INTEGER PRIMARY KEY, name TEXT, amount REAL, expense_type TEXT, expense_scope TEXT, department_id INTEGER, created_at TEXT);
INSERT INTO categories VALUES (1, 'الأغذية', NULL), (2, 'مشروبات', 1), (3, 'الأدوات', NULL), (4, 'منظفات', 3);
INSERT INTO products VALUES (1, 2), (2, 4);
INSERT INTO sales VALUES (1, 'completed', '2026-08-01'), (2, 'cancelled', '2026-08-01');
INSERT INTO sale_items VALUES (1, 1, 1, 2, 100, 30), (2, 1, 2, 1, 80, 40), (3, 2, 1, 9, 999, 500);
INSERT INTO expenses VALUES
  (1, 'نقل الأغذية', 10, 'operating', 'specific', 1, '2026-08-02'),
  (2, 'استشارة الأدوات', 5, 'ga', 'specific', 3, '2026-08-02'),
  (3, 'إيجار', 20, 'operating', 'general', NULL, '2026-08-02'),
  (4, 'رسوم', 7, 'ga', 'general', NULL, '2026-08-02');
''')

sql = '''
WITH RECURSIVE category_tree(category_id, department_id) AS (
  SELECT id, id FROM categories WHERE parent_id IS NULL
  UNION ALL
  SELECT child.id, tree.department_id FROM categories child JOIN category_tree tree ON child.parent_id = tree.category_id
), sales_totals AS (
  SELECT tree.department_id, SUM(si.total_price) sales, SUM(COALESCE(si.cost_price, 0) * si.quantity) cost
  FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
  JOIN category_tree tree ON tree.category_id = p.category_id
  WHERE s.status = 'completed' AND DATE(s.created_at) >= '2026-08-01' AND DATE(s.created_at) <= '2026-08-31'
  GROUP BY tree.department_id
), specific_expenses AS (
  SELECT e.department_id,
    SUM(CASE WHEN COALESCE(e.expense_type, 'operating') = 'operating' THEN e.amount ELSE 0 END) operating_expenses,
    SUM(CASE WHEN COALESCE(e.expense_type, 'operating') = 'ga' THEN e.amount ELSE 0 END) ga_expenses,
    SUM(e.amount) total_expenses
  FROM expenses e
  WHERE COALESCE(e.expense_scope, 'general') = 'specific' AND e.department_id IS NOT NULL
    AND DATE(e.created_at) >= '2026-08-01' AND DATE(e.created_at) <= '2026-08-31'
  GROUP BY e.department_id
)
SELECT d.name, COALESCE(sales_totals.sales,0) total_sales, COALESCE(sales_totals.cost,0) cost_of_sales,
  COALESCE(sales_totals.sales,0)-COALESCE(sales_totals.cost,0) gross_profit,
  COALESCE(specific_expenses.total_expenses,0) specific_expenses,
  COALESCE(sales_totals.sales,0)-COALESCE(sales_totals.cost,0)-COALESCE(specific_expenses.total_expenses,0) operating_profit
FROM categories d LEFT JOIN sales_totals ON sales_totals.department_id=d.id
LEFT JOIN specific_expenses ON specific_expenses.department_id=d.id
WHERE d.parent_id IS NULL ORDER BY d.id
'''
rows = con.execute(sql).fetchall()
assert rows == [('الأغذية', 100.0, 60.0, 40.0, 10.0, 30.0), ('الأدوات', 80.0, 40.0, 40.0, 5.0, 35.0)], rows
assert sum(r[5] for r in rows) == 65
assert 65 - (20 + 7) == 38
print('PASS child sales and costs aggregate into parent departments')
print('PASS specific operating and G&A expenses reduce only their department')
print('PASS general operating and G&A expenses remain undistributed and reduce company net profit')
print('ALL DEPARTMENT P&L TESTS PASSED')
