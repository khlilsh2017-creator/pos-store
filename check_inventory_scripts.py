from pathlib import Path
import re
import subprocess

root = Path(__file__).parent
for name in ['inventory.html', 'stock-movements.html']:
    text = (root / name).read_text(encoding='utf-8')
    scripts = re.findall(r'<script(?:\s[^>]*)?>(.*?)</script>', text, re.S)
    for index, script in enumerate(scripts):
        if script.strip():
            target = Path('/tmp') / f'{name}-{index}.js'
            target.write_text(script, encoding='utf-8')
            subprocess.run(['node', '--check', str(target)], check=True)
print('PASS inventory/stock inline script syntax')
