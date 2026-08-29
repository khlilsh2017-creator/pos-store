from pathlib import Path
import re
import subprocess
import tempfile

html = Path('driver/index.html').read_text(encoding='utf-8')
scripts = re.findall(r'<script(?:\s[^>]*)?>(.*?)</script>', html, flags=re.I | re.S)
inline = '\n'.join(scripts)
with tempfile.NamedTemporaryFile('w', suffix='.js', encoding='utf-8', delete=False) as handle:
    handle.write(inline)
    temp_path = handle.name
result = subprocess.run(['node', '--check', temp_path], capture_output=True, text=True)
if result.returncode:
    raise SystemExit(result.stderr or result.stdout)
assert 'parseDriverAmount' in inline
assert 'POSNumberUtils?.toNumber' in inline
assert "dueText.match(/[-+]?[0-9٠-٩۰-۹][0-9٠-٩۰-۹٬,.\\s]*/);" in inline
assert "parseFloat(document.getElementById('modalCashCollected').value)" not in inline
assert "parseFloat(document.getElementById('modalWalletCollected').value)" not in inline
print('PASS driver inline JavaScript and amount parser checks')
