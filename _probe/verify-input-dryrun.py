"""验证 Rust keys/text 的参数解析链路（dry-run，不发送任何按键）

为什么不实测真实输入：当前 VALORANT 在前台全屏，发按键会让角色乱动。
所以把「解析正确性」和「发送有效性」拆开：
  · 解析 = 现在验（dry-run，零副作用）
  · 发送 = 安全窗口（记事本）验，需要用户不在游戏
"""
import json
import subprocess

EXE = r'<project-root>/pet-core/target/release/pet-core.exe'


def run(obj):
    p = subprocess.run([EXE], input=json.dumps(obj).encode(), capture_output=True)
    try:
        return json.loads(p.stdout.decode('utf-8'))
    except Exception:
        return {'raw': p.stdout.decode('utf-8', 'replace')[:200], 'err': p.stderr.decode('utf-8', 'replace')[:200]}


print('=== keys dry-run ===')
cases = [
    'w', 'enter', 'esc', 'space', 'tab', 'backspace', 'delete',
    'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
    'f1', 'f5', 'f12', 'ctrl', 'shift', 'alt', 'win',
    'ctrl+s', 'ctrl+shift+f5', 'alt+f4', 'ctrl+alt+delete',
    '-', '=', '[', ']', ';', ',', '.', '/', '\\\\', '`',
    'capslock', 'numlock', 'printscreen', 'pause',
    'numpad0', 'numpad9', 'numadd', 'numdiv', 'numenter',
]
ok = 0
bad = []
for c in cases:
    d = run({'cmd': 'keys', 'keys': c, 'dry_run': True})
    if d.get('ok'):
        ok += 1
    else:
        bad.append((c, d.get('error', '')[:60]))
print('  解析成功 %d/%d' % (ok, len(cases)))
for c, e in bad:
    print('    ✗ %-18s %s' % (c, e))

print()
print('=== 组合键的扫描码明细（验证扩展位正确）===')
for c in ['ctrl+shift+f5', 'alt+f4', 'up', 'w', 'numenter']:
    d = run({'cmd': 'keys', 'keys': c, 'dry_run': True})
    if d.get('ok'):
        parts = ['%s(sc=0x%02X%s)' % (k['key'], k['scancode'], ',EXT' if k['extended'] else '')
                 for k in d['keys']]
        print('  %-16s → %s' % (c, '  '.join(parts)))
    else:
        print('  %-16s → ERR %s' % (c, d.get('error')))

print()
print('=== 未知键应该被拒 ===')
for c in ['不存在的键', '', 'ctrl+xyz']:
    d = run({'cmd': 'keys', 'keys': c, 'dry_run': True})
    print('  %-14r → ok=%s  %s' % (c, d.get('ok'), str(d.get('error', ''))[:70]))

print()
print('=== text dry-run（中文 / 数字 / 换行）===')
for t in ['hello', '你好世界', 'abc123', 'a\nb']:
    d = run({'cmd': 'text', 'text': t, 'dry_run': True})
    if d.get('ok'):
        plan = ' '.join('%s(%s)' % (p['ch'], p['via'][:6]) for p in d['plan'])
        print('  %-10r count=%d → %s' % (t, d['count'], plan))
    else:
        print('  %-10r ERR %s' % (t, d.get('error')))
