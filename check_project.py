from pathlib import Path
import re
import subprocess
import sys

root = Path(__file__).parent
files = [root / 'worker.js', root / 'filter-utils.js']
for path in files:
    result = subprocess.run(['node', '--check', str(path)], capture_output=True, text=True)
    if result.returncode:
        print(f'FAIL {path.name}\n{result.stderr}')
        sys.exit(1)

for path in sorted(root.glob('*.html')):
    text = path.read_text(encoding='utf-8')
    scripts = re.findall(r'<script(?:\s[^>]*)?>(.*?)</script>', text, re.S | re.I)
    for index, code in enumerate(scripts, 1):
        temp = root / f'.check-{path.name}-{index}.js'
        temp.write_text(code, encoding='utf-8')
        result = subprocess.run(['node', '--check', str(temp)], capture_output=True, text=True)
        temp.unlink(missing_ok=True)
        if result.returncode:
            print(f'FAIL {path.name} inline script {index}\n{result.stderr}')
            sys.exit(1)

print(f'PASS worker/filter-utils and {len(list(root.glob("*.html")))} root HTML pages')
