import sqlite3


def setup_db():
    db = sqlite3.connect(':memory:')
    db.executescript('''
        CREATE TABLE products (
            id INTEGER PRIMARY KEY, name TEXT, price REAL NOT NULL DEFAULT 0,
            cost REAL NOT NULL DEFAULT 0, stock_quantity REAL NOT NULL DEFAULT 0,
            is_set INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE product_variants (
            id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, label TEXT NOT NULL,
            stock_quantity REAL NOT NULL DEFAULT 0, selling_price REAL, cost REAL,
            barcode TEXT NOT NULL UNIQUE, is_active INTEGER NOT NULL DEFAULT 1,
            UNIQUE(product_id, label)
        );
        CREATE TABLE sale_items (
            id INTEGER PRIMARY KEY, product_id INTEGER, variant_id INTEGER,
            variant_label TEXT, quantity REAL, unit_price REAL, cost_price REAL
        );
        CREATE TABLE purchase_invoice_items (
            id INTEGER PRIMARY KEY, product_id INTEGER, variant_id INTEGER,
            variant_label TEXT, quantity REAL, selling_price REAL
        );
    ''')
    db.execute("INSERT INTO products(id,name,price,cost,stock_quantity,is_set) VALUES(1,'طقم قدور',13500,10000,0,1)")
    sizes = [('القدر الكبير', 5000), ('القدر المتوسط', 4000), ('القدر الصغير', 3500), ('المقلاة', 3000), ('الغطاء', 2500)]
    db.executemany("INSERT INTO product_variants(id,product_id,label,stock_quantity,selling_price,cost,barcode) VALUES(?,?,?,?,?,?,?)", [
        (i + 11, 1, label, 0, price, 2000, f'3SIZE{i + 11:04d}') for i, (label, price) in enumerate(sizes)
    ])
    return db


def purchase_whole_set(db, product_id, quantity, full_cost, full_price):
    variants = db.execute('SELECT id FROM product_variants WHERE product_id=? AND is_active=1 ORDER BY id', (product_id,)).fetchall()
    assert variants
    db.execute('UPDATE products SET price=?, cost=?, stock_quantity=stock_quantity+? WHERE id=?',
               (full_price, full_cost, quantity * len(variants), product_id))
    per_size_cost = full_cost / len(variants)
    for (variant_id,) in variants:
        db.execute('UPDATE product_variants SET stock_quantity=stock_quantity+?, cost=? WHERE id=?',
                   (quantity, per_size_cost, variant_id))
    db.execute('INSERT INTO purchase_invoice_items(product_id,variant_id,variant_label,quantity,selling_price) VALUES(?,?,?,?,?)',
               (product_id, None, 'طقم كامل', quantity, full_price))


def sell_whole_set(db, product_id, quantity, price):
    product = db.execute('SELECT cost,price FROM products WHERE id=? AND is_set=1', (product_id,)).fetchone()
    variants = db.execute('SELECT id,label,stock_quantity,cost FROM product_variants WHERE product_id=? AND is_active=1 ORDER BY id', (product_id,)).fetchall()
    assert product and len(variants) == 5
    if any(row[2] < quantity for row in variants):
        raise ValueError('لا يوجد مقاس كافٍ لإكمال الطقم')
    if price < product[0]:
        raise ValueError('سعر البيع أقل من التكلفة')
    for variant_id, _, _, _ in variants:
        db.execute('UPDATE product_variants SET stock_quantity=stock_quantity-? WHERE id=?', (quantity, variant_id))
    db.execute('UPDATE products SET stock_quantity=stock_quantity-? WHERE id=?', (quantity * len(variants), product_id))
    db.execute('INSERT INTO sale_items(product_id,variant_id,variant_label,quantity,unit_price,cost_price) VALUES(?,?,?,?,?,?)',
               (product_id, None, 'طقم كامل', quantity, price, product[0]))


def sell_size(db, product_id, variant_id, quantity, price):
    product = db.execute('SELECT cost FROM products WHERE id=? AND is_set=1', (product_id,)).fetchone()
    variant = db.execute('SELECT label,stock_quantity,cost FROM product_variants WHERE id=? AND product_id=? AND is_active=1',
                         (variant_id, product_id)).fetchone()
    assert product and variant
    if variant[1] < quantity:
        raise ValueError('الكمية غير كافية للمقاس')
    if price < (variant[2] if variant[2] is not None else product[0]):
        raise ValueError('سعر البيع أقل من التكلفة')
    db.execute('UPDATE product_variants SET stock_quantity=stock_quantity-? WHERE id=?', (quantity, variant_id))
    db.execute('UPDATE products SET stock_quantity=stock_quantity-? WHERE id=?', (quantity, product_id))
    db.execute('INSERT INTO sale_items(product_id,variant_id,variant_label,quantity,unit_price,cost_price) VALUES(?,?,?,?,?,?)',
               (product_id, variant_id, variant[0], quantity, price, variant[2] or product[0]))


db = setup_db()
purchase_whole_set(db, 1, 1, 10000, 13500)
assert db.execute('SELECT price,cost,stock_quantity FROM products WHERE id=1').fetchone() == (13500.0, 10000.0, 5.0)
assert db.execute('SELECT COUNT(*) FROM product_variants WHERE stock_quantity=1 AND cost=2000').fetchone()[0] == 5
assert db.execute('SELECT COUNT(DISTINCT barcode) FROM product_variants').fetchone()[0] == 5
print('PASS whole-set purchase distributes 10000 cost as 2000 across five named sizes')

sell_size(db, 1, 11, 1, 5000)
assert db.execute('SELECT stock_quantity FROM product_variants WHERE id=11').fetchone()[0] == 0
assert db.execute('SELECT MIN(stock_quantity),MAX(stock_quantity) FROM product_variants WHERE id>11').fetchone() == (1.0, 1.0)
assert db.execute('SELECT stock_quantity FROM products WHERE id=1').fetchone()[0] == 4.0
assert db.execute('SELECT variant_label,unit_price FROM sale_items ORDER BY id DESC LIMIT 1').fetchone() == ('القدر الكبير', 5000.0)
print('PASS individual size sale decrements only selected size and keeps its price')

purchase_whole_set(db, 1, 1, 10000, 13500)
sell_whole_set(db, 1, 1, 13500)
assert db.execute('SELECT stock_quantity FROM product_variants WHERE id=11').fetchone()[0] == 0
assert db.execute('SELECT MIN(stock_quantity),MAX(stock_quantity) FROM product_variants WHERE id>11').fetchone() == (1.0, 1.0)
assert db.execute('SELECT stock_quantity FROM products WHERE id=1').fetchone()[0] == 4.0
assert db.execute('SELECT variant_label,unit_price FROM sale_items ORDER BY id DESC LIMIT 1').fetchone() == ('طقم كامل', 13500.0)
print('PASS whole-set sale atomically decrements all five sizes at full-set price')

try:
    sell_size(db, 1, 12, 1, 1999)
except ValueError as exc:
    assert 'أقل من التكلفة' in str(exc)
else:
    raise AssertionError('selling below size cost was accepted')
print('PASS sales below size cost are rejected')
print('ALL VARIANT SQLITE TESTS PASSED')
