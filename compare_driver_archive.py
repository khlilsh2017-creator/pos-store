from pathlib import Path
import hashlib
import subprocess
import tempfile

project = Path(__file__).parent
archive = Path('/home/ubuntu/upload/final_pos_negative_stock_report_ready.zip')
if not archive.exists():
    print('SKIP original archive unavailable')
    raise SystemExit(0)
with tempfile.TemporaryDirectory() as tmp:
    subprocess.run(['unzip', '-q', '-o', str(archive), '-d', tmp], check=True)
    roots = [Path(tmp) / 'final_pos', Path(tmp)]
    original_root = next((root for root in roots if (root / 'driver').is_dir()), None)
    if original_root is None:
        print('SKIP original driver directory unavailable')
        raise SystemExit(0)
    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()
    left = {str(p.relative_to(project / 'driver')): digest(p) for p in (project / 'driver').rglob('*') if p.is_file()}
    right = {str(p.relative_to(original_root / 'driver')): digest(p) for p in (original_root / 'driver').rglob('*') if p.is_file()}
    if left != right:
        print('FAIL driver files changed')
        print('Only current:', sorted(set(left) - set(right)))
        print('Only original:', sorted(set(right) - set(left)))
        for name in sorted(set(left) & set(right)):
            if left[name] != right[name]: print('Changed:', name)
        raise SystemExit(1)
    print(f'PASS driver unchanged: {len(left)} files')
