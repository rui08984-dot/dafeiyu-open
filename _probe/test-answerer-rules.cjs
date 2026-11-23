// _probe/test-answerer-rules.cjs —— DSH 无人值守应答规则（2026-11-20 审计 P1-7）
//
// 被测对象在用户目录（插件不在仓库里）：
//   <user-home>/.dsh/profiles/pet/local-plugins/dsh-pet-answerer/rules.js
// 项目测试读外部绝对路径是刻意接受的做法：规则就是线上插件本体，抄一份副本测等于没测。
//
// 复现过的 bug：READ_RE 先命中就 ALLOW，且 WRITE_RE 缺「关闭/移动/重启/重置/清理/
// 终止/结束进程」等动词 → 「打开并清理」「查看后重启」「读取并关闭」全被判成读类允许。
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ANSWERER_DIR = '<user-home>/.dsh/profiles/pet/local-plugins/dsh-pet-answerer';
const RULES_PATH = path.join(ANSWERER_DIR, 'rules.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass++; return; }
    fail++;
    failures.push(name + (detail ? '：' + detail : ''));
}
function eq(name, actual, expected) {
    ok(name, actual === expected, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}

(async () => {
    if (!fs.existsSync(RULES_PATH)) {
        console.error('❌ 找不到 answerer rules.js：' + RULES_PATH +
            '（插件未安装时这条规则测试无法运行；请先确认 dsh --profile pet 的 local-plugins）');
        process.exit(1);
    }
    const rules = await import(pathToFileURL(RULES_PATH).href);
    const { decideOne, toAnswer, READ_RE, WRITE_RE, ALLOW_RE, DENY_RE } = rules;

    const opts = [{ label: '允许' }, { label: '拒绝' }];
    const q = (question, extra) => Object.assign({ id: 'q1', question, options: opts }, extra || {});
    const decision = (question, extra) => decideOne(q(question, extra));

    // ── ① 审计点名的 6 个混合句：读 + 破坏 必须拒绝 ─────────────────────────
    const MIXED = [
        '是否允许打开并清理临时目录？',
        '是否允许查看后重启服务？',
        '是否允许读取并关闭窗口？',
        '是否允许打开并重置设置？',
        '是否允许读取并移动文件？',
        '是否允许查看并结束进程？',
        '是否允许关闭记事本？',
        '是否允许退出应用？',
        '是否允许重命名文件？',
        '是否允许挂起进程？',
        '是否允许禁用插件？',
        '是否允许停止服务？',
        '是否允许卸载组件？',
        '是否允许执行命令？',
    ];
    for (const text of MIXED) {
        const d = decision(text);
        eq('混合/破坏句拒绝：' + text, d.label, '拒绝');
        ok('理由是写/危险类：' + text, /写\/危险/.test(d.why), d.why);
    }

    // ── ② 纯读类仍然允许 ────────────────────────────────────────────────────
    for (const text of ['是否允许读取文件？', '是否允许查看目录？', '是否允许列出任务？', '是否允许搜索日志？', '是否允许打开设置页？']) {
        eq('纯读允许：' + text, decision(text).label, '允许');
    }

    // ── ③ WRITE 优先级：同一句里读动词在前也不能覆盖写动词 ─────────────────
    {
        const d = decision('先读取配置，然后写入新值');
        eq('读+写混合 → 拒绝', d.label, '拒绝');
    }

    // ── ④ 英文整词：already/thread 不算 read，information 不算 format ──────
    ok('already 不命中 READ', READ_RE.test('already') === false);
    ok('thread 不命中 READ', READ_RE.test('thread') === false);
    ok('spread 不命中 READ', READ_RE.test('spread') === false);
    ok('information 不命中 WRITE', WRITE_RE.test('information') === false);
    ok('read 命中 READ', READ_RE.test('read') === true);
    ok('delete 命中 WRITE', WRITE_RE.test('delete') === true);
    eq('英文未识别句安全默认=拒绝', decision('Is the thread already done?').label, '拒绝');
    eq('英文读类允许', decision('May I read the log?').label, '允许');
    eq('英文写类拒绝', decision('May I delete the log?').label, '拒绝');

    // ── ⑤ 选项 label/description 也纳入判定 ─────────────────────────────────
    {
        const d = decideOne({
            id: 'q1', question: '如何处理这个文件？', options: [
                { label: '保留', description: '不修改磁盘' },
                { label: '清除', description: '删除临时文件' },
                { label: '取消', description: '什么都不做' },
            ],
        });
        eq('选项描述里的删除也判危险', d.label, '取消');
    }

    // ── ⑥ plan-review 一律不批 ─────────────────────────────────────────────
    {
        const d = decision('请审阅这个计划', { intent: { kind: 'plan-review' } });
        eq('plan-review 拒绝', d.label, '拒绝');
        ok('plan-review 理由', /plan-review/.test(d.why), d.why);
    }

    // ── ⑦ 没有拒绝标签时返回空 selected + custom（不误允许）──────────────
    {
        const answer = toAnswer({ questions: [{ id: 'q1', question: '是否允许删除？', options: [{ label: '继续' }, { label: '稍后' }] }] });
        eq('写类无拒绝标签 selected=[]', JSON.stringify(answer.answers[0].selected), '[]');
        ok('写类无拒绝标签带 custom 理由', /无人值守/.test(String(answer.answers[0].custom || '')));
    }

    // ── ⑧ toAnswer 形状（AskUserQuestionAnswer）───────────────────────────
    {
        const answer = toAnswer({ questions: [{ id: 'a', question: '是否允许读取？', options: [{ label: '允许' }, { label: '拒绝' }] }, { id: 'b', question: '是否允许删除？', options: [{ label: '允许' }, { label: '拒绝' }] }] });
        eq('toAnswer 两个问题', answer.answers.length, 2);
        eq('q1 允许', JSON.stringify(answer.answers[0].selected), JSON.stringify(['允许']));
        eq('q2 拒绝', JSON.stringify(answer.answers[1].selected), JSON.stringify(['拒绝']));
        eq('id 原样保留', answer.answers[1].id, 'b');
    }

    // ── ⑨ 插件入口仍然可加载，且引用 rules.js（不是内联旧规则）─────────────
    {
        const entry = await import(pathToFileURL(path.join(ANSWERER_DIR, 'index.js')).href);
        eq('index.js 导出 name', entry.name, 'dsh-pet-answerer');
        eq('index.js 导出 apply', typeof entry.apply, 'function');
        const src = fs.readFileSync(path.join(ANSWERER_DIR, 'index.js'), 'utf8');
        ok('index.js 从 rules.js 取规则', /from\s+['"]\.\/rules\.js['"]/.test(src));
        ok('index.js 不再内联 READ_RE', !/const\s+READ_RE/.test(src));
    }

    if (fail) {
        console.error('❌ answerer 规则：FAIL ' + fail + ' / PASS ' + pass);
        for (const f of failures) console.error('   - ' + f);
        process.exit(1);
    }
    console.log('  ✅ answerer 规则：PASS ' + pass + ' / FAIL 0');
})().catch((e) => {
    console.error('❌ answerer 规则测试异常：' + ((e && e.stack) || e));
    process.exit(1);
});
