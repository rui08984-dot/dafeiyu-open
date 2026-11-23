#!/usr/bin/env node
/**
 * _probe/test-ocr-dedup.cjs —— OCR 复读截断（B13，2026-11-23）
 *
 * 现场：`dedup_repeat()` 原来「只在后段找首行重复，且只有最后一行命中时从最后截」，
 * GLM-OCR 的围栏空行循环会输出同一段 7 次 → 只截到 3 次。修法：
 *   短输出把起点提前到第 2 行；只有末行像首行时，从**最早**一次重复处截。
 *
 * 纯离线：调用 ocr_read.dedup_repeat 的纯函数，不读图、不发请求。
 */
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PY = 'py';
const TOOLS = path.join(ROOT, 'pet-runtime', 'tools');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}

const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(TOOLS)})
import ocr_read
cases = {}
# ① 干净的两遍重复
lines = ['第一行标题', '第二行内容', '第三行内容', '第四行内容']
cases['two_clean'] = ocr_read.dedup_repeat('\\n'.join(lines + lines)).count('第一行标题')
# ② B13 现场：同一段 7 次，中间夹围栏空行
block = ['第一行标题', '第二行内容', '第三行内容', '']
rep7 = []
for i in range(7):
    rep7 += block + ['\\\`\\\`\\\`', '']
cases['seven_fences'] = ocr_read.dedup_repeat('\\n'.join(rep7)).count('第一行标题')
# ③ 正常文档：首行在末尾作为页脚重复一次（后面没有连续相同内容）→ 不该截正文
doc = ['标题'] + ['正文%d' % i for i in range(30)] + ['标题']
cases['footer_once'] = ocr_read.dedup_repeat('\\n'.join(doc)).count('正文')
# ④ 短输出从第 2 行起重复：应只留一份
short = ['A标题', '甲内容', '乙内容', 'A标题', '甲内容', '乙内容']
cases['short_two'] = ocr_read.dedup_repeat('\\n'.join(short)).count('A标题')
print(json.dumps(cases))
`;

let out = null;
try {
    out = JSON.parse(String(execFileSync(PY, ['-I', '-c', script], { encoding: 'utf8', timeout: 30000 })).trim());
} catch (e) {
    console.error('  ✗ Python 侧执行失败：' + ((e && e.stderr) || e && e.message || e));
    process.exit(1);
}

ok('两遍干净重复 → 只留一份', out.two_clean === 1, JSON.stringify(out));
ok('B13：7 遍 + 围栏 → 只留一份（原来留 3 份）', out.seven_fences === 1, JSON.stringify(out));
ok('正常文档的页脚重复不被误截', out.footer_once === 30, JSON.stringify(out));
ok('短输出第 2 行起重复 → 只留一份', out.short_two === 1, JSON.stringify(out));

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
