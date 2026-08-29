import sqlite3

con = sqlite3.connect(':memory:')
con.executescript('''
CREATE TABLE categories(id INTEGER PRIMARY KEY, name TEXT NOT NULL, parent_id INTEGER);
CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT, category_id INTEGER, stock_quantity REAL, cost REAL, is_active INTEGER);
CREATE TABLE sales(id INTEGER PRIMARY KEY, status TEXT, created_at TEXT);
CREATE TABLE sale_items(id INTEGER PRIMARY KEY, sale_id INTEGER, product_id INTEGER, quantity REAL, total_price REAL, cost_price REAL);
INSERT INTO categories VALUES (1, 'الأغذية', NULL), (2, 'مشروبات', 1), (3, 'معلبات', 1), (4, 'غازيات', 2), (5, 'خدمات', NULL);
INSERT INTO products VALUES (1, 'ماء', 2, 10, 2, 1), (2, 'عصير', 4, 5, 3, 1), (3, 'تونة', 3, 7, 4, 1), (4, 'تركيب', 5, 2, 20, 1), (5, 'غير مصنف', NULL, 1, 5, 1);
INSERT INTO sales VALUES (1, 'completed', '2026-08-01'), (2, 'cancelled', '2026-08-01');
INSERT INTO sale_items VALUES (1, 1, 1, 2, 20, 10), (2, 1, 2, 3, 45, 30), (3, 1, 3, 1, 15, 10), (4, 1, 4, 1, 50, 20), (5, 2, 3, 9, 99, 50);
''')

sales_sql = '''
WITH RECURSIVE category_tree(category_id, root_id) AS (
  SELECT id, id FROM categories WHERE parent_id IS NULL
  UNION ALL
  SELECT child.id, tree.root_id
  FROM categories child JOIN category_tree tree ON child.parent_id = tree.category_id
)
SELECT COALESCE(root.id, 0) id, COALESCE(root.name, 'غير مصنف') category_name,
       SUM(si.quantity) items_sold, SUM(si.total_price) total_sales
FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
LEFT JOIN category_tree tree ON tree.category_id = p.category_id
LEFT JOIN categories root ON root.id = tree.root_id
WHERE s.status = 'completed'
GROUP BY root.id, root.name ORDER BY id
'''
rows = con.execute(sales_sql).fetchall()
by_name = {r[1]: r for r in rows}
assert by_name['الأغذية'][2] == 6, rows
assert by_name['الأغذية'][3] == 80, rows
assert by_name['خدمات'][2] == 1, rows
assert 'مشروبات' not in by_name and 'معلبات' not in by_name and 'غازيات' not in by_name, rows

inventory_sql = '''
WITH RECURSIVE category_tree(category_id, root_id) AS (
  SELECT id, id FROM categories WHERE parent_id IS NULL
  UNION ALL
  SELECT child.id, tree.root_id FROM categories child JOIN category_tree tree ON child.parent_id = tree.category_id
)
SELECT COALESCE(root.name, 'غير مصنف') category_name, SUM(p.stock_quantity) total_stock
FROM products p LEFT JOIN category_tree tree ON tree.category_id = p.category_id
LEFT JOIN categories root ON root.id = tree.root_id WHERE p.is_active = 1
GROUP BY root.id, root.name
'''
inv = {r[0]: r[1] for r in con.execute(inventory_sql)}
assert inv['الأغذية'] == 22, inv
assert inv['خدمات'] == 2, inv
assert inv['غير مصنف'] == 1, inv
print('PASS recursive child categories aggregate under parent')
print('PASS cancelled sales excluded from parent totals')
print('PASS inventory aggregates under parent')
print('ALL CATEGORY HIERARCHY TESTS PASSED')
