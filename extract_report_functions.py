from pathlib import Path
s = Path(__file__).parent.joinpath('reports.html').read_text(encoding='utf-8')
keys = ['async function loadDailyReport', 'async function loadAdvancedReport', 'async function printTimeReport', 'async function loadAll', 'function centralParams', 'async function searchCentralEntities', 'async function loadCentralStatement', 'function renderCentralSummary', 'function centralTypeLabel']
for key in keys:
    start = s.find(key)
    print(f'\n### {key} @ {start}')
    if start < 0:
        continue
    brace = s.find('{', start)
    depth = 0
    end = brace
    in_str = None
    escaped = False
    for i in range(brace, len(s)):
        ch = s[i]
        if in_str:
            if escaped:
                escaped = False
            elif ch == '\\':
                escaped = True
            elif ch == in_str:
                in_str = None
        else:
            if ch in "'\"`":
                in_str = ch
            elif ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
    print(s[start:end])
