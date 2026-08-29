from pathlib import Path
s = Path(__file__).parent.joinpath('reports.html').read_text(encoding='utf-8')
for marker in ['data-report="balance-sheet"', 'data-report', 'export-type', 'reports-filter-host', 'central-statements']:
    p=s.find(marker)
    print(f'\n### {marker} @ {p}\n{s[max(0,p-900):p+1800]}')
