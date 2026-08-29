from pathlib import Path
import sys


def find_function_blocks(text, signature):
    starts=[]
    pos=0
    while True:
        start=text.find(signature,pos)
        if start<0: break
        brace=text.find('{',start)
        if brace<0: raise ValueError(f'لا توجد بداية جسم للدالة عند {start}')
        depth=0; quote=None; esc=False; line_comment=False; block_comment=False; i=brace
        while i<len(text):
            ch=text[i]; nxt=text[i+1] if i+1<len(text) else ''
            if line_comment:
                if ch=='\n': line_comment=False
            elif block_comment:
                if ch=='*' and nxt=='/': block_comment=False; i+=1
            elif quote:
                if esc: esc=False
                elif ch=='\\': esc=True
                elif ch==quote: quote=None
            else:
                if ch=='/' and nxt=='/': line_comment=True; i+=1
                elif ch=='/' and nxt=='*': block_comment=True; i+=1
                elif ch in "'\"`": quote=ch
                elif ch=='{': depth+=1
                elif ch=='}':
                    depth-=1
                    if depth==0:
                        starts.append((start,i+1)); break
            i+=1
        else: raise ValueError('لم يكتمل جسم الدالة')
        pos=starts[-1][1]
    return starts

path=Path(sys.argv[1] if len(sys.argv)>1 else 'worker.js')
s=path.read_text(encoding='utf-8')
sig='async function linkProductByCode(request, env, headers)'
blocks=find_function_blocks(s,sig)
if len(blocks)<=1:
    print(f'لا يوجد تكرار: {len(blocks)} تعريف')
else:
    # Keep the last definition, which is the most recently merged implementation.
    for start,end in reversed(blocks[:-1]):
        s=s[:start]+s[end:]
    path.write_text(s,encoding='utf-8')
    print(f'تم حذف {len(blocks)-1} تعريف مكرر والإبقاء على تعريف واحد')
remaining=len(find_function_blocks(s,sig))
if remaining!=1:
    raise SystemExit(f'فشل التحقق: عدد التعريفات بعد الإصلاح = {remaining}')
print('PASS linkProductByCode declarations = 1')
