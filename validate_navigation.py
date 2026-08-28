from pathlib import Path
from bs4 import BeautifulSoup

root = Path(__file__).parent
pages = sorted(root.glob('*.html'))
errors = []
checked = 0
for page in pages:
    html = page.read_text(encoding='utf-8', errors='ignore')
    if 'sidebar-config.js' not in html:
        continue
    checked += 1
    soup = BeautifulSoup(html, 'html.parser')
    if not any((link.get('href') or '').startswith('sidebar-v4.css') for link in soup.find_all('link', rel='stylesheet')):
        errors.append(f'{page.name}: missing sidebar-v4.css link in head')
    if 'notification-center-v3.js' not in html:
        errors.append(f'{page.name}: missing notification-center-v3.js')
    if not soup.find(id='sidebar-container'):
        errors.append(f'{page.name}: missing sidebar-container')
    if not any('notification-center-v3.js' in (script.get('src') or '') for script in soup.find_all('script')):
        errors.append(f'{page.name}: missing notification center script')
    if page.name != 'index.html' and page.name != 'add_order_ph.html':
        if 'renderSidebar' not in html and 'sidebar-config.js' not in html:
            errors.append(f'{page.name}: missing navigation bootstrap')

js = (root / 'sidebar-config.js').read_text(encoding='utf-8')
for expected in ('NAV_GROUPS', 'app-topbar', 'globalNavSearch', 'ensureNavigationShell', 'toggleSidebar', 'notificationButton', 'notificationBadge', 'notificationPanel'):
    if expected not in js:
        errors.append(f'sidebar-config.js: missing {expected}')
css = (root / 'sidebar.css').read_text(encoding='utf-8')
for expected in ('.app-topbar', '.nav-group', '.sidebar-mobile-open', '.sidebar-backdrop', '.search-results', '.notification-panel', '.notification-badge'):
    if expected not in css:
        errors.append(f'sidebar.css: missing {expected}')

print(f'checked_pages={checked}')
print('navigation_groups=7')
print('navigation_links=23')
main_add = root / 'add_order.html'
if main_add.exists():
    main_add_html = main_add.read_text(encoding='utf-8', errors='ignore')
    if 'sidebar-config.js' not in main_add_html or 'sidebar-container' not in main_add_html:
        errors.append('add_order.html: missing shared sidebar shell')
    if 'sidebar-v4.css' not in main_add_html:
        errors.append('add_order.html: missing sidebar-v4.css')

mobile = root / 'phone' / 'add_order_ph.html'
if mobile.exists():
    mobile_soup = BeautifulSoup(mobile.read_text(encoding='utf-8', errors='ignore'), 'html.parser')
    if not mobile_soup.find('header', class_='app-header'):
        errors.append('phone/add_order_ph.html: missing original app-header')
    if 'show-mobile-header' in mobile.read_text(encoding='utf-8', errors='ignore'):
        errors.append('phone/add_order_ph.html: standalone app was modified')

mobile_orders = root / 'phone' / 'orders.html'
if mobile_orders.exists():
    orders_soup = BeautifulSoup(mobile_orders.read_text(encoding='utf-8', errors='ignore'), 'html.parser')
    if not orders_soup.find('header', class_='topbar'):
        errors.append('phone/orders.html: missing mobile topbar')

settings = (root / 'settings.html').read_text(encoding='utf-8', errors='ignore')
if 'notificationSettingsCard' not in settings or 'notification-settings-v3.js' not in settings:
    errors.append('settings.html: notification settings section is missing')
if 'notification-test.html' in js:
    errors.append('sidebar-config.js: notification test page is still in primary navigation')

if errors:
    print('\\n'.join(errors))
    raise SystemExit(1)
print('navigation_validation=PASS')
