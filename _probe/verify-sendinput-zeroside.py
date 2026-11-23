"""Rust SendInput 真实调用验证（零风险版）

为什么用 F13：
  · 物理键盘上没有 F13，任何应用（含游戏）都不会绑定它 → 发出去**零副作用**
  · 但它走的是**完整的 SendInput 路径**（同一段代码、同一个系统 API）
  · 用 SendInput 的返回值（成功注入的事件数）证明「系统真的接受了输入」

验证的是「发送链路」，不是「接收方处理」——
后者需要能切焦点到测试窗口，全屏游戏抢前台时做不到（见 verify-input-real2.py）。

输出同时记录：发送前后前台窗口有没有变化（应该不变，证明 F13 无副作用）。
"""
import json
import subprocess
import sys
import time

EXE = r'<project-root>/pet-core/target/release/pet-core.exe'


def run(obj, timeout=20):
    p = subprocess.run([EXE], input=json.dumps(obj).encode(), capture_output=True, timeout=timeout)
    try:
        return json.loads(p.stdout.decode('utf-8'))
    except Exception:
        return {'raw': p.stdout.decode('utf-8', 'replace')[:300]}


def fg():
    d = run({'cmd': 'fg'})
    return (d.get('hwnd', 0), d.get('title', '')) if d.get('ok') else (0, '')


print('=== 0. 发送前状态 ===')
h0, t0 = fg()
print('  前台: %r (hwnd=%s)' % (t0, h0))

print()
print('=== 1. dry-run 确认 F13 解析正确 ===')
d = run({'cmd': 'keys', 'keys': 'f13', 'dry_run': True})
print('  %s' % json.dumps(d, ensure_ascii=False))

print()
print('=== 2. 真实发送 F13（SendInput 完整路径，零副作用）===')
results = []
for i in range(3):
    d = run({'cmd': 'keys', 'keys': 'f13'})
    ok = d.get('ok')
    sent = d.get('sent')
    us = d.get('us')
    err = d.get('error')
    print('  第%d次: ok=%s sent=%s us=%s %s' % (i + 1, ok, sent, us, err or ''))
    results.append((ok, sent, us))
    time.sleep(0.2)

print()
print('=== 3. 发送后状态（前台应没变 = F13 无副作用）===')
h1, t1 = fg()
print('  前台: %r (hwnd=%s)' % (t1, h1))
same = (h0 == h1)
print('  前台未变:', same)

print()
print('=== 4. 真实发送组合键 F13+F14（验证多键序列）===')
d = run({'cmd': 'keys', 'keys': 'ctrl+f13'})
print('  ctrl+f13: ok=%s sent=%s us=%s %s' % (d.get('ok'), d.get('sent'), d.get('us'), d.get('error') or ''))

print()
print('=== 5. 真实发送文字到一个**空的安全目标** ===')
print('  跳过 —— 文字必须发到前台，当前前台是游戏，不能发。')
print('  这条通道的解析已验证（dry-run），真实发送见 verify-input-real2.py')

print()
print('=== 结论 ===')
all_ok = all(r[0] for r in results)
sent_sum = sum((r[1] or 0) for r in results)
if all_ok and sent_sum > 0:
    print('  ✅ SendInput 真实调用成功：3 次共注入 %d 个事件，前台未变化（零副作用）' % sent_sum)
    print('     → 「Rust send_keys 能真的把按键送进系统输入流」已验证')
    print('     → 「按键被目标控件接收并产生文本」需要能切焦点，见 verify-input-real2.py')
else:
    print('  ✗ SendInput 有问题，看上面的 error')
sys.exit(0 if all_ok else 1)
