from pathlib import Path
s=Path(__file__).parent.joinpath('reports.html').read_text(encoding='utf-8')
keys=['function centralEntityId','function centralStatementUrl','async function loadCentralStatement','async function printCentralStatement']
for key in keys:
    start=s.find(key); print(f'\n### {key} @ {start}')
    if start<0: continue
    brace=s.find('{',start); depth=0; quote=None; esc=False; end=brace
    for i in range(brace,len(s)):
        ch=s[i]
        if quote:
            if esc: esc=False
            elif ch=='\\': esc=True
            elif ch==quote: quote=None
        else:
            if ch in "'\"`": quote=ch
            elif ch=='{': depth+=1
            elif ch=='}':
                depth-=1
                if depth==0: end=i+1; break
    print(s[start:end])
