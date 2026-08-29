import re
from pathlib import Path
text = Path('worker.js').read_text()
starts = list(re.finditer(r'^(?:async )?function\s+(\w+)\s*\(', text, re.M))
for i, match in enumerate(starts):
    start = match.start()
    end = starts[i+1].start() if i + 1 < len(starts) else len(text)
    body = text[start:end]
    calls = {name: len(re.findall(r'\b' + name + r'\s*\(', body)) for name in ('dbAll','dbFirst','dbRun','createJournalEntry','client.batch','tx.batch')}
    if sum(calls.values()) > 0:
        print(f"{match.group(1)}\t" + '\t'.join(f'{k}={v}' for k,v in calls.items()))
