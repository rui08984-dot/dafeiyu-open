#!/usr/bin/env node
/**
 * _probe/test-see-image-pipeline.cjs —— `see image` 图片投递闭环（P0-1，2026-11-25 审计）
 *
 * 要防的回归（审计证据：runtime.log 单条 som_snapshot 回执 180,753 字节）：
 *   ① base64 以**文本**进 tool 消息，模型从来没见过图；
 *   ② 180KB 回执吃满上下文，还会被 12k 上限切成**非法 JSON**；
 *   ③ 图片作为 user 消息插入时打断「assistant.tool_calls → 连续 tool」序列；
 *   ④ 第二张图到来后历史里堆多张图（每张 ~180KB）；
 *   ⑤ 空/损坏 base64 或超 8MB 图把整轮对话打挂。
 *
 * 全部纯函数 / 假消息数组：不写真实记录室、不碰全局、不需要 Electron。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-see-image-'));
process.env.PET_DATA_ROOT = TMP_ROOT;

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const attach = require(path.join(LIVE, 'js', 'ai', 'tool-image-attach.js'));
const cap = require(path.join(LIVE, 'js', 'ai', 'tool-result-cap.js'));
const LH = require(path.join(LIVE, 'js', 'ai', 'llm-handler.js'));
const Dispatch = require(path.join(LIVE, 'plugins', 'community', 'dispatch', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const JPEG_HEAD = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL';
const PNG_HEAD = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg';

function b64(head, len) {
    const body = 'A'.repeat(Math.max(0, len - head.length));
    return head + body;
}

// 复刻 som_snapshot 的真实回执形状（game-control.js:4280-4298）
function somResult(image, extra) {
    return JSON.stringify(Object.assign({
        ok: true,
        verified: true,
        unverified: false,
        effect: 'readonly',
        tier: 'L1',
        action_sent: false,
        detail: '「记事本」已标注 3 个可点元素（源=uia）：#1[button]确定 #2[button]取消 #3[edit]正文　→ 用 som_click 传编号',
        elements: [
            { id: 1, type: 'button', name: '确定', x: 10, y: 20, w: 80, h: 30 },
            { id: 2, type: 'button', name: '取消', x: 100, y: 20, w: 80, h: 30 },
            { id: 3, type: 'edit', name: '正文', x: 10, y: 70, w: 300, h: 200 },
        ],
        snapshot_id: 12,
        snapshot_at: 1764000000000,
        window: { hwnd: 12345, title: '记事本' },
        image,
        imageIsBase64: true,
        source: 'uia',
        captured: { w: 800, h: 600 },
        delivered: { w: 800, h: 600 },
        scale: { x: 1, y: 1 },
        ruler: { step: 200, unit: 'screen_px' },
        note: '',
    }, extra || {}));
}

try {
    // ═══════════════════════════════════════════════════════════════
    // ① 剥离：tool 文本里绝不再有 base64，元素清单/尺寸/刻度尺全保留
    // ═══════════════════════════════════════════════════════════════
    const IMAGE = b64(JPEG_HEAD, 60000);   // 模拟 60k base64（真实 SoM ~180k）
    const raw = somResult(IMAGE);
    const r = attach.splitToolImageContent(raw);
    {
        ok('含图回执被识别（changed）', r.changed === true);
        ok('tool 文本不再包含 base64', !r.text.includes(IMAGE) && !/\/9j\/4AAQ/.test(r.text));
        ok('剥离后的文本是合法 JSON', (() => { try { JSON.parse(r.text); return true; } catch (e) { return false; } })());
        const o = JSON.parse(r.text);
        ok('回执保留 ok:true', o.ok === true);
        ok('回执标 imageAttached:true', o.imageAttached === true);
        ok('回执 note 说明图片已附加', o.note === attach.IMAGE_ATTACH_NOTE, o.note);
        ok('image 字段已移除', o.image === undefined);
        ok('imageIsBase64 标记已移除', o.imageIsBase64 === undefined);
        ok('elements 三条完整保留', Array.isArray(o.elements) && o.elements.length === 3
            && o.elements[0].name === '确定', JSON.stringify(o.elements && o.elements.length));
        ok('snapshot_id / 窗口 / scale / ruler 全保留',
            o.snapshot_id === 12 && o.window.hwnd === 12345
            && o.scale.x === 1 && o.ruler.step === 200 && o.captured.w === 800);
        ok('detail 原话保留（含编号说明）', /som_click/.test(o.detail) && /#1\[button\]/.test(o.detail));
        ok('提取出图片对象（jpeg）', !!r.image && r.image.mime === 'image/jpeg', r.image && r.image.mime);
        ok('图片 base64 与原始一致（未被截断/改写）', r.image.base64 === IMAGE, 'len=' + (r.image && r.image.base64.length));
        ok('文本体积显著下降（>= base64 长度）', raw.length - r.text.length >= IMAGE.length - 16,
            'before=' + raw.length + ' after=' + r.text.length + ' saved=' + (raw.length - r.text.length));
        ok('剥离结果是确定性的（同输入同输出）', attach.splitToolImageContent(raw).text === r.text);
    }

    // ═══════════════════════════════════════════════════════════════
    // ② mime / data URL / 阈值 / 损坏输入
    // ═══════════════════════════════════════════════════════════════
    {
        const png = b64(PNG_HEAD, 5000);
        const rp = attach.splitToolImageContent(somResult(png));
        ok('PNG magic → image/png', !!rp.image && rp.image.mime === 'image/png', rp.image && rp.image.mime);
        ok('detectMime 识别 WebP/GIF/BMP 前缀',
            attach.detectMime('UklGR' + 'A'.repeat(20)) === 'image/webp'
            && attach.detectMime('R0lGOD' + 'A'.repeat(20)) === 'image/gif'
            && attach.detectMime('Qk' + 'A'.repeat(200)) === 'image/bmp');

        const withPrefix = 'data:image/png;base64,' + png;
        const rr = attach.splitToolImageContent(somResult(withPrefix));
        ok('data URL 前缀被剥掉（url 里不会出现双前缀）', !!rr.image && /^data:image\/png;base64,iVBOR/.test(
            attach.buildToolImageMessage(rr.image).content[1].image_url.url), rr.image && rr.image.base64.slice(0, 8));

        const shortNoFlag = JSON.stringify({ ok: true, detail: '短', image: 'http://x/y.png' });
        const rs = attach.splitToolImageContent(shortNoFlag);
        ok('短 image 字段（URL）不当作图片、原样返回', rs.changed === false && rs.text === shortNoFlag && rs.image === null);

        const longNoFlag = JSON.stringify({ ok: true, detail: 'd', image: b64(JPEG_HEAD, 3000) });
        ok('无标记但 image > 2000 字 → 仍按图片处理', attach.splitToolImageContent(longNoFlag).changed === true);

        const empty = JSON.stringify({ ok: true, elements: [{ id: 1 }], image: '', imageIsBase64: true });
        let re = null;
        let threw = false;
        try { re = attach.splitToolImageContent(empty); } catch (e) { threw = true; }
        ok('空 base64 不抛异常', threw === false && !!re);
        ok('空 base64 → invalid，无图片，元素清单保留',
            re.invalid === true && re.image === null && JSON.parse(re.text).elements.length === 1);

        const broken = JSON.stringify({ ok: true, elements: [], image: '!!! not base64 !!!', imageIsBase64: true });
        ok('损坏 base64 → invalid 不抛，且文本可解析',
            !attach.splitToolImageContent(broken).image && (() => {
                try { JSON.parse(attach.splitToolImageContent(broken).text); return true; } catch (e) { return false; }
            })());

        const huge = JSON.stringify({ ok: true, elements: [{ id: 9 }], image: b64(JPEG_HEAD, attach.MAX_TOOL_IMAGE_BASE64 + 128), imageIsBase64: true });
        const rh = attach.splitToolImageContent(huge);
        ok('超过 8MB → 不给图片（imageTooLarge）', rh.image === null && rh.imageTooLarge === true);
        ok('超限回执仍带元素清单 + imageTooLarge 标记',
            JSON.parse(rh.text).imageTooLarge === true && JSON.parse(rh.text).elements[0].id === 9);

        ok('非 JSON 文本原样返回（旧工具不受影响）', (() => {
            const s = '纯文本回执';
            const x = attach.splitToolImageContent(s);
            return x.changed === false && x.text === s;
        })());
        ok('损坏 JSON 原样返回且不抛', (() => {
            const s = '{"ok":true,"detail":"被切了一半';
            const x = attach.splitToolImageContent(s);
            return x.changed === false && x.text === s;
        })());
    }

    // ═══════════════════════════════════════════════════════════════
    // ③ 追加顺序：tool 消息在前，user 图片消息在后（严格模式不 400）
    // ═══════════════════════════════════════════════════════════════
    {
        const messages = [
            { role: 'system', content: 'S' },
            { role: 'user', content: '看看记事本' },
            { role: 'assistant', content: null, tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'see', arguments: '{}' } },
                { id: 'c2', type: 'function', function: { name: 'app', arguments: '{}' } },
            ] },
        ];
        const res = attach.appendToolResults(messages, [
            { role: 'tool', name: 'see', tool_call_id: 'c1', content: somResult(IMAGE) },
            { role: 'tool', name: 'app', tool_call_id: 'c2', content: '{"ok":true,"detail":"小结果"}' },
        ]);
        ok('批量追加：两张 tool 都在图片消息之前', messages.length === 6
            && messages[3].role === 'tool' && messages[4].role === 'tool' && messages[5].role === 'user',
            messages.map((m) => m.role).join(','));
        ok('tool 消息里没有 base64', !JSON.stringify(messages[3]).includes(IMAGE.slice(0, 200)));
        ok('第二张 tool 回执保持原样（无图不改造）', messages[4].content === '{"ok":true,"detail":"小结果"}');
        const imageMsgs = messages.filter((m) => m.role === 'user' && Array.isArray(m.content)
            && m.content.some((p) => p && p.type === 'image_url'));
        ok('有且仅有一条 user 图片消息', imageMsgs.length === 1, 'count=' + imageMsgs.length);
        ok('图片消息带稳定文本标记', imageMsgs[0].content[0].text === attach.TOOL_IMAGE_TEXT);
        ok('image_url 是 data:image/jpeg;base64', /^data:image\/jpeg;base64,\/9j\//.test(imageMsgs[0].content[1].image_url.url));
        ok('append 返回值标 attached', res.attached === true && res.images === 1);
    }

    // ═══════════════════════════════════════════════════════════════
    // ④ 只保留最近 1 张：第二张图到来时旧的被剥成文字
    // ═══════════════════════════════════════════════════════════════
    {
        const messages = [
            { role: 'system', content: 'S' },
            { role: 'user', content: '看看' },
            { role: 'user', content: [{ type: 'text', text: '当前电脑屏幕内容:' },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64(JPEG_HEAD, 4000) } }] },
        ];
        const IMG1 = b64(JPEG_HEAD, 50000);
        const IMG2 = b64(PNG_HEAD, 50000);
        attach.appendToolResults(messages, [{ role: 'tool', name: 'see', tool_call_id: 'c1', content: somResult(IMG1) }]);
        attach.appendToolResults(messages, [{ role: 'tool', name: 'see', tool_call_id: 'c2', content: somResult(IMG2) }]);
        const withUrl = messages.filter((m) => Array.isArray(m.content)
            && m.content.some((p) => p && p.type === 'image_url'));
        const toolImgs = withUrl.filter((m) => attach.isToolImageMessage(m));
        ok('连续两次 see image 后只剩一张工具图', toolImgs.length === 1, 'count=' + toolImgs.length);
        ok('保留的是**最新**那张（png）', /^data:image\/png;base64,iVBOR/.test(toolImgs[0].content[1].image_url.url));
        ok('旧工具图被剥成标记文字（不再占 base64）',
            messages.some((m) => m.role === 'user' && m.content === attach.TOOL_IMAGE_TEXT));
        ok('用户本轮截图未被误伤（仍是数组 + image_url）',
            messages[2] && Array.isArray(messages[2].content)
            && messages[2].content.some((p) => p.type === 'image_url'));
        ok('isToolImageMessage 不把用户截图当工具图', attach.isToolImageMessage(messages[2]) === false);
    }

    // ═══════════════════════════════════════════════════════════════
    // ⑤ 模型不支持图片：剥图但不发图（元素清单继续）
    // ═══════════════════════════════════════════════════════════════
    {
        const messages = [];
        const res = attach.appendToolResults(messages, [
            { role: 'tool', name: 'see', tool_call_id: 'c1', content: somResult(IMAGE) },
        ], { attachImages: false });
        ok('attachImages:false 不追加图片消息', messages.length === 1
            && !JSON.stringify(messages).includes('image_url'));
        ok('但仍然把 base64 从文本里剥掉', !messages[0].content.includes(IMAGE) && res.suppressed === true);
        ok('元素清单仍在（回退文本模式可用）',
            JSON.parse(messages[0].content).elements.length === 3 && JSON.parse(messages[0].content).imageAttached === true);
    }

    // ═══════════════════════════════════════════════════════════════
    // ⑥ tool-result-cap：含图信封整段跳过，不计入累计、不切坏 JSON
    // ═══════════════════════════════════════════════════════════════
    {
        const env = somResult(IMAGE);
        const c1 = cap.capText(env, 12000);
        ok('capText 对含图回执 skip（reason=image）', c1.skipped === true && c1.skipReason === 'image');
        ok('capText 跳过时内容**逐字节不变**', c1.text === env && c1.capped === false);

        const messages = [
            { role: 'user', content: '本轮问题' },
            { role: 'tool', name: 'see', tool_call_id: 'c1', content: env },
            { role: 'tool', name: 'file', tool_call_id: 'c2', content: 'x'.repeat(15000) },
        ];
        const out = cap.enforceToolBudget(messages, 0, { perResultChars: 12000, perTurnChars: 32000 });
        ok('enforceToolBudget 记 cap.skip reason:image', out.skipped === 1 && out.skipReasons[0] === 'image',
            JSON.stringify({ skipped: out.skipped, reasons: out.skipReasons }));
        ok('含图回执在宿主里保持原字节', messages[1].content === env);
        ok('含图回执的 JSON 仍可解析', (() => { try { return JSON.parse(messages[1].content).elements.length === 3; } catch (e) { return false; } })());
        ok('正常超长回执照旧被截断（跳过不误伤别人）',
            out.capped >= 1 && messages[2].content.length < 15000, 'capped=' + out.capped);

        // 单轮累计：把上限压到极小，含图回执不能被省略、也不能把别人挤掉
        const messages2 = [
            { role: 'user', content: 'q' },
            { role: 'tool', name: 'see', tool_call_id: 'c1', content: env },
            { role: 'tool', name: 'x', tool_call_id: 'c2', content: 'y'.repeat(9000) },
            { role: 'tool', name: 'y', tool_call_id: 'c3', content: 'z'.repeat(9000) },
        ];
        const out2 = cap.enforceToolBudget(messages2, 0, { perResultChars: 12000, perTurnChars: 5000 });
        ok('含图回执不计入单轮总量（turnChars 不含它）',
            out2.turnChars < env.length, 'turnChars=' + out2.turnChars + ' imageLen=' + env.length);
        ok('含图回执永远不被换成省略标记', messages2[1].content === env);
        ok('同轮其它回执按原策略省略（保留最新一条）',
            out2.stubbed === 1 && out2.skipped === 1 && out2.turnChars <= 9100,
            JSON.stringify({ stubbed: out2.stubbed, skipped: out2.skipped, turnChars: out2.turnChars }));

        ok('isImageEnvelope 导出可判定', cap.isImageEnvelope(env) === true
            && cap.isImageEnvelope('{"ok":true,"detail":"普通"}') === false);
        ok('普通 JSON 信封（detail 超长）仍走 detail-only 截断（回归）', (() => {
            const normal = JSON.stringify({ ok: true, detail: 'D'.repeat(20000), next: { offset: 5 } });
            const x = cap.capText(normal, 4000);
            if (!x.capped) return false;
            try { const p = JSON.parse(x.text); return p.next.offset === 5; } catch (e) { return false; }
        })());
    }

    // ═══════════════════════════════════════════════════════════════
    // ⑦ llm-handler：请求体剥图不再误杀「本轮工具附图」
    // ═══════════════════════════════════════════════════════════════
    {
        const toolImg = attach.buildToolImageMessage({ mime: 'image/jpeg', base64: b64(JPEG_HEAD, 5000) });
        const msgs = [
            { role: 'system', content: 'S' },
            { role: 'user', content: [{ type: 'text', text: '旧截图' },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,OLD' } }] },
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'see', arguments: '{}' } }] },
            { role: 'tool', name: 'see', tool_call_id: 'c1', content: '{"ok":true,"imageAttached":true}' },
            JSON.parse(JSON.stringify(toolImg)),
        ];
        const n = LH.stripHistoryImagesForRequest(msgs, null, 1);
        ok('iteration>0：旧用户图被剥（1 条）', n === 1, 'stripped=' + n);
        ok('iteration>0：最新工具附图被保留（模型这轮要看它）',
            attach.isToolImageMessage(msgs[4]) === true);
        ok('被剥的消息变成纯文字', typeof msgs[1].content === 'string' && msgs[1].content === '旧截图');
        ok('没有新截图时历史工具图也只在最新一张保留（其余剥）', (() => {
            const m2 = JSON.parse(JSON.stringify(msgs));
            m2.splice(4, 0, JSON.parse(JSON.stringify(toolImg)));
            const stripped = LH.stripHistoryImagesForRequest(m2, null, 1);
            const remain = m2.filter((m) => attach.isToolImageMessage(m));
            return stripped >= 1 && remain.length === 1;
        })());
        ok('用户槽内保留最新一张（旧用户图剥成文字）', (() => {
            const img = (t) => ({ role: 'user', content: [{ type: 'text', text: t }, { type: 'image_url', image_url: { url: 'data:' + t } }] });
            const m = [{ role: 'system', content: 'S' }, img('旧1'), { role: 'assistant', content: '嗯' }, img('最新')];
            return LH.stripOldScreenshotImages(m) === 1 && Array.isArray(m[1].content) === false;
        })());
    }

    // ═══════════════════════════════════════════════════════════════
    // ⑦b 轮末清理按来源分槽：用户图槽 / 工具图槽各留 1 张，互不挤占
    // ═══════════════════════════════════════════════════════════════
    {
        const userImg = (t) => ({ role: 'user', content: [{ type: 'text', text: t },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + t } }] });

        // 用户图 ×2 + 工具图 ×2：每槽各留最新，旧的剥掉（旧实现会把用户图2也剥掉）
        const msgs = [
            { role: 'system', content: 'S' },
            userImg('USER1'),
            attach.buildToolImageMessage({ mime: 'image/jpeg', base64: b64(JPEG_HEAD, 4000) }),   // T1
            { role: 'assistant', content: '嗯' },
            userImg('USER2'),
            attach.buildToolImageMessage({ mime: 'image/png', base64: b64(PNG_HEAD, 4000) }),     // T2
        ];
        const n = LH.stripOldScreenshotImages(msgs);
        ok('分槽清理：只剥每个槽的旧图（2 条）', n === 2, 'stripped=' + n);
        ok('分槽：用户图与工具图**共存**（两槽各保留一张）',
            Array.isArray(msgs[4].content) && msgs[4].content.some((p) => p.type === 'image_url')
            && attach.isToolImageMessage(msgs[5]));
        ok('分槽：旧用户图（USER1）被剥成文字', typeof msgs[1].content === 'string' && msgs[1].content === 'USER1');
        ok('分槽：旧工具图（T1）被剥成标记文字', typeof msgs[2].content === 'string'
            && msgs[2].content === attach.TOOL_IMAGE_TEXT);
        ok('分槽：工具槽保留的是最新一张（T2 = png）',
            attach.isToolImageMessage(msgs[5])
            && /^data:image\/png;base64,iVBOR/.test(msgs[5].content[1].image_url.url));
        ok('分槽：用户槽保留的是最新一张（USER2）', Array.isArray(msgs[4].content)
            && /USER2/.test(msgs[4].content[0].text));

        // 第二张工具图到来：只替换工具槽，用户图原封不动
        const m2 = [userImg('USER0')];
        attach.appendToolResults(m2, [{ role: 'tool', name: 'see', tool_call_id: 'c1', content: somResult(b64(JPEG_HEAD, 30000)) }]);
        const userBefore = m2[0].content;
        attach.appendToolResults(m2, [{ role: 'tool', name: 'see', tool_call_id: 'c2', content: somResult(b64(PNG_HEAD, 30000)) }]);
        ok('第二张工具图：用户图引用/内容原封不动', m2[0].content === userBefore
            && m2[0].content.some((p) => p.type === 'image_url'));
        const toolImgs2 = m2.filter((m) => attach.isToolImageMessage(m));
        ok('第二张工具图：全历史只剩 1 张工具图（且是最新的）',
            toolImgs2.length === 1
            && /^data:image\/png;base64,iVBOR/.test(toolImgs2[0].content[1].image_url.url));
        ok('第二张工具图后：共 2 条带图消息（1 用户 + 1 工具）',
            m2.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')).length === 2);

        // 轮末清理后两槽共存仍然成立（用户图不是工具图的「旧图」）
        const m3 = [userImg('USER0')];
        attach.appendToolResults(m3, [{ role: 'tool', name: 'see', tool_call_id: 'c1', content: somResult(b64(JPEG_HEAD, 30000)) }]);
        LH.stripOldScreenshotImages(m3);
        ok('轮末清理不误伤：用户图 + 工具图同时保留',
            m3[0].role === 'user' && Array.isArray(m3[0].content)
            && m3[0].content.some((p) => p.type === 'image_url')
            && attach.isToolImageMessage(m3[2]));
    }

    // ═══════════════════════════════════════════════════════════════
    // ⑧ dispatch：8MB 上限（imageTooLarge），正常图补 imageIsBase64
    // ═══════════════════════════════════════════════════════════════
    {
        const small = Dispatch.capToolImageResult({ ok: true, elements: [1], image: b64(JPEG_HEAD, 1000) });
        ok('正常图：保留 image + imageIsBase64', typeof small.image === 'string' && small.imageIsBase64 === true);
        const big = Dispatch.capToolImageResult({
            ok: true, elements: [{ id: 1 }], image: b64(JPEG_HEAD, Dispatch.MAX_TOOL_IMAGE_BASE64 + 64), imageIsBase64: true,
        });
        ok('超 8MB：省略图片并标 imageTooLarge', big.image === undefined && big.imageTooLarge === true);
        ok('超限仍回元素清单 + 可读 note', big.elements.length === 1 && /8MB/.test(big.note));
        const noImg = Dispatch.capToolImageResult({ ok: true, detail: 'x' });
        ok('无图回执不新增字段（旧形状不变）', noImg.image === undefined && noImg.imageTooLarge === undefined
            && noImg.imageIsBase64 === undefined);
        ok('8MB 常量导出（测试/文档同一真源）', Dispatch.MAX_TOOL_IMAGE_BASE64 === 8 * 1024 * 1024);
    }
    // ── ⑨ 工具图跨轮清理（2026-11-25 对抗审计 P1-1）──────────────
    {
        ok('iteration 0（新回合第一次请求）不保留历史工具图',
            attach.keepToolImageForIteration(0) === false && attach.keepToolImageForIteration(undefined) === false);
        ok('iteration>0（本轮工具循环）保留最新工具图',
            attach.keepToolImageForIteration(1) === true && attach.keepToolImageForIteration(3) === true);
    }
} finally {
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
