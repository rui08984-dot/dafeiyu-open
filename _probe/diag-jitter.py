import json
import subprocess
import time

EXE = r'<project-root>/pet-core/target/release/pet-core.exe'
PY = r'py'
PY_SCRIPT = r'<project-root>/pet-runtime/tools/screen-hash.py'


def hamming(a, b):
    if len(a) != len(b):
        return 64
    diff = 0
    for i in range(len(a)):
        x = int(a[i], 16) ^ int(b[i], 16)
        while x:
            diff += x & 1
            x >>= 1
    return diff


def rust_hashes(n=10):
    out = []
    for _ in range(n):
        p = subprocess.run([EXE], input=b'{"cmd":"screen_hash"}', capture_output=True)
        try:
            out.append(json.loads(p.stdout.decode('utf-8'))['hash'])
        except Exception:
            pass
        time.sleep(0.15)
    return out


def py_hashes(n=5):
    out = []
    for _ in range(n):
        p = subprocess.run([PY, PY_SCRIPT], capture_output=True, text=True)
        h = (p.stdout or '').strip()
        if len(h) == 16:
            out.append(h)
        time.sleep(0.15)
    return out


def stats(name, hs):
    if len(hs) < 2:
        print('%s: 采样不足' % name)
        return
    ds = []
    for i in range(len(hs)):
        for j in range(i + 1, len(hs)):
            ds.append(hamming(hs[i], hs[j]))
    ds.sort()
    print('%s: n=%d  抖动 hamming  min=%d 中位=%d max=%d  全集=%s'
          % (name, len(hs), ds[0], ds[len(ds) // 2], ds[-1], ds if len(ds) <= 15 else '(略)'))
    print('   hashes:', ' '.join(hs[:6]))


print('=== Rust 版（10 次，静止画面下两两比较）===')
stats('Rust', rust_hashes(10))
print()
print('=== Python 版（5 次，慢，作对照）===')
stats('Python', py_hashes(5))
