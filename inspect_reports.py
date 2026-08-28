from pathlib import Path
p = Path(__file__).parent / 'reports.html'
s = p.read_text(encoding='utf-8')
for key in ['function loadAll', 'function loadDailyReport', 'function loadAdvancedReport', 'function printTimeReport', '__posFilterControllers', 'function centralParams', 'function loadCentralStatement']:
    pos = s.find(key)
    print(f'\n### {key} @ {pos}')
    if pos >= 0:
        print(s[pos:pos+2600])
