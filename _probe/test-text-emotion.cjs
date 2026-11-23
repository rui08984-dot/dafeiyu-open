// test-text-emotion.cjs —— 句子→表情推断的纯逻辑单测
// 跑法：node _probe/test-text-emotion.cjs
const path = require('path');
const { inferEmotion } = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d',
    'js', 'avatar', 'live2d', 'text-emotion.js'));

const CASES = [
    ['哈哈，你也太逗了吧', '开心'],
    ['嘿嘿，我就知道', '开心'],
    ['烦死了，又卡住了', '生气'],
    ['哼，凭什么让我等', '生气'],
    ['唉……算了，没意思', '难过'],
    ['真的假的？！不会吧', '惊讶'],
    ['哇，居然是这样', '惊讶'],
    ['不好意思，别说了', '害羞'],
    ['才不要呢，略略略', '俏皮'],
    ['你猜呀，我就不说', '俏皮'],
    // 中性：必须不表态，否则每句都抽一下脸
    ['我在写代码，写了两小时', null],
    ['好的，收到', null],
    ['文档在第三个文件夹里', null],
];

let pass = 0;
let fail = 0;
for (const [text, want] of CASES) {
    const got = inferEmotion(text);
    const emo = got ? got.emotion : null;
    const ok = emo === want;
    if (ok) pass += 1; else fail += 1;
    const score = got ? got.score.toFixed(2) : '-';
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(text)}  want=${want} got=${emo} (${score})`);
}
console.log(`\n汇总: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
