from pathlib import Path
from bs4 import BeautifulSoup

root = Path(__file__).parent
outputs = []
for relative in ('phone/add_order_ph.html', 'online-reports.html'):
    source = root / relative
    soup = BeautifulSoup(source.read_text(encoding='utf-8', errors='ignore'), 'html.parser')
    for index, script in enumerate(soup.find_all('script')):
        if script.get('src') or not script.string or not script.string.strip():
            continue
        output = root / f'.tmp_{source.stem}_{index}.js'
        output.write_text(script.string, encoding='utf-8')
        outputs.append(output)
print('\n'.join(str(path) for path in outputs))
