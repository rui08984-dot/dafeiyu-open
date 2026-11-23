"""检查 game-control.js 里每个 case 是否都返回契约形状（不裸 return ok:true）"""
import io
import re

p = r'<project-root>/_incoming/my-neuro/live-2d/plugins/community/dispatch/game-control.js'
src = io.open(p, encoding='utf-8').read()

# 找所有 case 分支
lines = src.split('\n')
cases = []
for i, ln in enumerate(lines):
    m = re.match(r"\s+case '([a-z_]+)':\s*\{", ln)
    if m:
        cases.append((m.group(1), i))

print('=== action 契约覆盖检查（%d 个 action）===' % len(cases))
bad = []
for idx, (name, start) in enumerate(cases):
    end = cases[idx + 1][1] if idx + 1 < len(cases) else len(lines)
    body = '\n'.join(lines[start:end])
    has_vc = bool(re.search(r'\bVC\.(confirmed|idempotent|failed|unverified|readonly|notSent|fromActAndVerify|result)\b', body))
    # 检查有没有裸 return { ok: true（不在 VC 里）
    naked = re.findall(r'return \{ ok: true', body)
    if not has_vc:
        bad.append((name, 'no VC call', len(naked)))
    elif naked:
        bad.append((name, 'has naked return', len(naked)))

if not bad:
    print('  ✓ 全部 %d 个 action 都走契约，零裸 return' % len(cases))
else:
    for name, why, n in bad:
        print('  ✗ %-22s %s (%d 处)' % (name, why, n))

print()
print('=== 契约字段覆盖（不应出现的缺失）===')
for field in ['detail:', 'nextIfFailed']:
    cnt = src.count(field)
    print('  %-14s 出现 %d 次' % (field, cnt))

print()
print('=== 关键函数存在性 ===')
for fn in ['baselineJitter', 'uiaTreeSignature', 'actAndVerifySmart', 'screenHash', 'hamming',
           '_coreBin', 'ensureUiaService', 'ensureSendInput', 'assertTargetFocused', 'windowRealRect']:
    ok = ('function %s' % fn) in src or ('async function %s' % fn) in src
    print('  %s %s' % ('✓' if ok else '✗', fn))
