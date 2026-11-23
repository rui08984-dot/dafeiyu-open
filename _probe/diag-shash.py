import json
import subprocess

EXE = r'<project-root>/pet-core/target/release/pet-core.exe'

for i in range(3):
    p = subprocess.run([EXE], input=b'{"cmd":"gray_matrix"}', capture_output=True)
    d = json.loads(p.stdout.decode('utf-8'))
    m = d.get('m') or []
    print('第 %d 次  %sx%s' % (i + 1, d.get('w'), d.get('h')))
    if not m:
        print('  ', d)
        continue
    for r in range(8):
        print('    ' + ' '.join('%3d' % m[r * 9 + c] for c in range(9)))
    print()

print('=== 对比：Rust screen_hash 连跑 3 次 ===')
for i in range(3):
    p = subprocess.run([EXE], input=b'{"cmd":"screen_hash"}', capture_output=True)
    d = json.loads(p.stdout.decode('utf-8'))
    print('  %s  %sus' % (d.get('hash'), d.get('us')))
