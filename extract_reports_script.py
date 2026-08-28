from pathlib import Path
import re

html = Path(__file__).with_name('reports.html').read_text(encoding='utf-8')
blocks = re.findall(r'<script(?:\s[^>]*)?>(.*?)</script>', html, flags=re.S)
for i, block in enumerate(blocks):
    if 'centralKind' in block or 'loadAdvancedReport' in block:
        Path('/tmp/reports_inline.js').write_text(block, encoding='utf-8')
        print(f'extracted script block {i} to /tmp/reports_inline.js')
        break
else:
    raise SystemExit('reports inline script not found')
