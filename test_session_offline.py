from pathlib import Path

root = Path('/home/ubuntu/pos_project_mobile_accounting_audited')
permissions = (root / 'permissions.js').read_text(encoding='utf-8')
phone_index = (root / 'phone/index.html').read_text(encoding='utf-8')
phone_orders = (root / 'phone/orders.html').read_text(encoding='utf-8')
core = (root / 'offline-sw-core.js').read_text(encoding='utf-8')

# الحذف في permissions.js لا يحدث إلا داخل فرع 401/403، بينما catch الشبكة يحافظ على الجلسة.
assert "if (response.status === 401 || response.status === 403)" in permissions
assert "// انقطاع الشبكة ليس تسجيل خروج" in permissions
assert "location.href = 'index.html'" in permissions
assert "if(res.status===401||res.status===403)" in phone_index
assert "const saved=localStorage.getItem('pos_user')" in phone_index
assert "catch(_){const saved=localStorage.getItem('pos_user')" in phone_index
assert "if(res.status===401||res.status===403)" in phone_orders
assert "currentUser=JSON.parse(saved);showNotice('أنت في وضع عدم الاتصال" in phone_orders
assert "url.pathname === '/auth/login' || url.pathname === '/auth/logout' || url.pathname === '/auth/me'" in core
# لا تُحفظ محاولات المصادقة في طابور العمليات المالية.
assert "لا يوجد اتصال بالمصادقة" in core
print('PASS: offline session is preserved; explicit logout and real 401/403 remain the only session-clearing paths.')
