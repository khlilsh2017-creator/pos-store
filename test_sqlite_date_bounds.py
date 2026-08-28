import sqlite3

con = sqlite3.connect(':memory:')
rows = [
    ('2026-08-24 20:59:59',),
    ('2026-08-24 21:00:00',),
    ('2026-08-24 23:00:00',),
    ('2026-08-25 20:59:59',),
    ('2026-08-25 21:00:00',),
]
con.execute('create table sales(created_at text)')
con.executemany('insert into sales values (?)', rows)
start = con.execute("select datetime(?, '-03:00')", ('2026-08-25 00:00:00',)).fetchone()[0]
end = con.execute("select datetime(?, '-03:00')", ('2026-08-26 00:00:00',)).fetchone()[0]
matched = [r[0] for r in con.execute("select created_at from sales where created_at >= datetime(?, '-03:00') and created_at < datetime(?, '-03:00') order by created_at", ('2026-08-25 00:00:00', '2026-08-26 00:00:00'))]
print({'start': start, 'end': end, 'matched': matched})
assert start == '2026-08-24 21:00:00'
assert end == '2026-08-25 21:00:00'
assert matched == ['2026-08-24 21:00:00', '2026-08-24 23:00:00', '2026-08-25 20:59:59']
print('PASS SQLite Yemen day bounds')
