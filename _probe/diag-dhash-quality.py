"""验证 Rust dHash 的两个关键性质（不是「屏幕稳不稳」，那是环境问题）：

1. 确定性：同一张图两次算 hash 必须完全一样
2. 速度：单次耗时

第 1 项用 Rust 自己的单元测试覆盖（dhash_is_stable），这里测的是**端到端**：
把屏幕抓两次，如果在同一毫秒内抓到同一帧，hash 应该一致。
"""
import json
import subprocess
import time

EXE = r'<project-root>/pet-core/target/release/pet-core.exe'
PY = r'py'
PY_SCRIPT = r'<project-root>/pet-runtime/tools/screen-hash.py'


def run(cmd_obj):
    p = subprocess.run([EXE], input=json.dumps(cmd_obj).encode(), capture_output=True)
    return json.loads(p.stdout.decode('utf-8'))


def hamming(a, b):
    if len(a) != len(b):
        return 64
    d = 0
    for i in range(len(a)):
        x = int(a[i], 16) ^ int(b[i], 16)
        while x:
            d += x & 1
            x >>= 1
    return d


print('=== 1. 速度：Rust 连跑 8 次 ===')
us_list = []
for _ in range(8):
    d = run({'cmd': 'screen_hash'})
    if 'us' in d:
        us_list.append(d['us'])
us_list.sort()
if us_list:
    print('  中位 %dus (%.0fms)  最快 %dus  最慢 %dus'
          % (us_list[len(us_list) // 2], us_list[len(us_list) // 2] / 1000,
             us_list[0], us_list[-1]))

print()
print('=== 2. Python 版对照（3 次）===')
py_ms = []
for _ in range(3):
    t0 = time.time()
    subprocess.run([PY, PY_SCRIPT], capture_output=True)
    py_ms.append((time.time() - t0) * 1000)
py_ms.sort()
print('  中位 %.0fms' % py_ms[len(py_ms) // 2])

print()
print('=== 3. Rust 连续 12 次的抖动分布（跳过首次，GDI 首次调用有初始化开销）===')
hs = []
for _ in range(12):
    d = run({'cmd': 'screen_hash'})
    hs.append(d.get('hash'))
    time.sleep(0.05)
hs = hs[1:]
ds = []
for i in range(len(hs)):
    for j in range(i + 1, len(hs)):
        ds.append(hamming(hs[i], hs[j]))
ds.sort()
print('  样本 %d，两两比较 %d 对' % (len(hs), len(ds)))
print('  抖动 hamming: min=%d  中位=%d  p90=%d  max=%d'
      % (ds[0], ds[len(ds) // 2], ds[int(len(ds) * 0.9)], ds[-1]))
print('  结论：阈值 5 时误报率 = %.0f%%（抖动 >5 的对数 / 总对数）'
      % (100.0 * sum(1 for x in ds if x > 5) / len(ds)))
print('  阈值 12 时误报率 = %.0f%%'
      % (100.0 * sum(1 for x in ds if x > 12) / len(ds)))
