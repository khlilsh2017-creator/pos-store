from pathlib import Path
import re
import subprocess
import tempfile

for page, markers in {
    'reports.html': ['centralPrintTitle', 'printCentralStatement'],
    'customers.html': ['printCustomerStatement', 'customerName'],
    'suppliers.html': ['printStatement', 'supplierName'],
}.items():
    html = (Path(__file__).parent / page).read_text(encoding='utf-8')
    blocks = re.findall(r'<script(?:\s[^>]*)?>(.*?)</script>', html, flags=re.S)
    target = next((block for block in blocks if all(marker in block for marker in markers)), None)
    assert target is not None, f'{page}: inline print script not found'
    with tempfile.NamedTemporaryFile('w', suffix='.js', encoding='utf-8', delete=False) as handle:
        handle.write(target)
        temp = Path(handle.name)
    try:
        subprocess.run(['node', '--check', str(temp)], check=True, capture_output=True, text=True)
    finally:
        temp.unlink(missing_ok=True)
    print(f'PASS {page} inline print syntax')
print('ALL INLINE PRINT SYNTAX TESTS PASSED')
