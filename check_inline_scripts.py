import re
import subprocess
from pathlib import Path

root = Path('.')
errors = []
count = 0
for path in sorted(root.glob('**/*.html')):
    if 'node_modules' in path.parts:
        continue
    text = path.read_text(encoding='utf-8', errors='ignore')
    for idx, match in enumerate(re.finditer(r'<script(?:\s[^>]*)?>([\s\S]*?)</script>', text, re.I), 1):
        code = match.group(1)
        if not code.strip() or re.search(r'\bsrc\s*=', match.group(0), re.I):
            continue
        count += 1
        proc = subprocess.run(['node', '--check'], input=code, text=True, capture_output=True)
        if proc.returncode:
            errors.append(f'{path}:{idx}: {proc.stderr.strip()}')
print(f'checked_inline_blocks={count}')
if errors:
    print('\n'.join(errors))
    raise SystemExit(1)
print('PASS all inline scripts')
