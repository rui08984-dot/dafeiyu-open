#!/usr/bin/env node
/**
 * 打包分发：产出一个「免安装便携目录」
 *
 * 设计原则：
 *   ① 只打运行时真正需要的，参考仓库/临时产物一律排除（_incoming 里 4.8GB 大部分是参考代码）
 *   ② 打包后必须能自检：跑 doctor 看关键项
 *   ③ 依赖不打包，写清单 + 说明（Electron/Python 装一次就好，不该复制进每个副本）
 *
 * 用法：node tools/package.mjs [--out <目录>] [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(ROOT, 'dist', '大肥鱼-便携版');

// 要打的东西（相对 ROOT）
const INCLUDE = [
  '大肥鱼.cmd',
  '使用手册.md',
  'pet-runtime/tools',
  'pet-runtime/desktop/build',
  'pet-runtime/desktop/assets',
  // desktop 的 v2 页面（换皮套调试用）依赖这些；漏了 index.html 加载就 404。
  'pet-runtime/desktop/index.html',
  'pet-runtime/desktop/ui',
  'pet-runtime/desktop/vendor',
  // ⚠ 2026-11-10 四十轮续：原来打的是 target/debug/pet-core.exe（Nov 8 的旧构建，
  //   连 mouse 命令都没有）。运行时的 _coreBin() 找的是 target/release ——
  //   打 debug 等于便携版永远少新能力，而且 debug 版更慢。
  'pet-core/target/release/pet-core.exe',
  // 2026-11-25 P3：表演数据以前整个漏打 —— 便携版没有 97 段 FACS 片段、
  // 没有 perf-sync.json（调度器退化 atomic）、没有节目单。只带运行必需的静态数据；
  // performance-log / dispatch-history 是个人运行记录，见 EXCLUDE_FILES。
  'pet-runtime/data/facs-clips',
  'pet-runtime/data/game-profiles',
  'pet-runtime/data/programs',
  'pet-runtime/data/perf-sync.json',
  'asr', 'edge-tts', 'audio-loop', 'audio_common',
  '_incoming/my-neuro/live-2d',
  // 记录室在 my-neuro 根下，不在 live-2d 里 —— 漏了它 doctor 会报「核心用户记忆.txt 不存在」。
  // 但只带上数据结构，不要把测试期产生的对话历史/心情/漂移记录一起发出去。
  '_incoming/my-neuro/data',
];

// 明确排除（体积大且运行不需要）
//
// ⚠️ 2026-11-09 审计发现：`libs` 曾被整体排除，但 live-2d/index.html 依赖
// 6 个 libs/*.js（pixi / live2d / cubism core …）——便携版发出去皮套根本起不来。
// 现在不排 libs，只排里面那个冗余的 v2 子目录（见 shouldSkip 的路径级判定）。
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', '.state',
  'shots', 'shots2', 'probe', 'tmp-verify', 'sdk5', 'sdk55', 'vendor2',
  '3D', '2D', 'renderer', 'docs', 'test', 'tests', '.cache',
]);
const EXCLUDE_FILES = [/\.log$/, /\.map$/, /thumbs\.db$/i,
  // 运行期个人数据：打包分发时不该带上别人的对话与情绪记录
  /^对话历史\.jsonl$/, /^心情\.json$/, /^人设漂移\.json$/, /^上次见面\.json$/, /^AI日记\.txt$/, /^活着感\.json$/,
  // ⚠️ 凭据文件绝不进包（2026-11-08 发现 dist 已泄漏真 key，已清）——用户凭运行环境.md 自己配
  /^config\.json$/, /^llm_providers\.json$/, /^config\.json\.bak/,
  // 个人运行记录不进包（2026-11-25 P3）
  /^performance-log\.jsonl$/, /^dispatch-history\.jsonl$/,
];

let totalBytes = 0, totalFiles = 0;
const skipped = [];

function shouldSkip(name, destRel) {
  // libs/v2 是旧版参考实现（体积大、运行时不引用），只排这一个具体路径
  if (/^_incoming[/\\]my-neuro[/\\]live-2d[/\\]libs[/\\]v2$/i.test(destRel)) return 'dir:libs/v2(冗余参考)';
  if (name === 'v2' && /libs$/i.test(path.basename(path.dirname(destRel)))) return 'dir:libs/v2(冗余参考)';
  if (EXCLUDE_DIRS.has(name)) return 'dir:' + name;
  if (EXCLUDE_FILES.some((re) => re.test(name))) return 'file:' + name;
  return null;
}

function walk(src, destRel) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(src)) {
      const full = path.join(src, name);
      const childRel = path.join(destRel, name);
      const why = shouldSkip(name, childRel);
      if (why) { skipped.push(path.join(destRel, name) + '  (' + why + ')'); continue; }
      walk(full, path.join(destRel, name));
    }
    return;
  }
  const why = shouldSkip(path.basename(src), destRel);
  if (why) { skipped.push(destRel + '  (' + why + ')'); return; }
  totalBytes += st.size;
  totalFiles += 1;
  if (!dry) {
    const dest = path.join(OUT, destRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    // 凭据脱敏（双保险）：插件运行配置也会藏 key（2026-11-08 实测 memos/minecraft 的
    // plugin_config.json 各藏一把）——所有 .json 落盘前把 api_key/token/secret 的值抹空
    if (dest.endsWith('.json')) {
      try {
        const orig = fs.readFileSync(dest, 'utf8');
        let txt = orig;
        // 插件配置的通用 value 字段也藏 key（type:"password" 的值）——按 key 形状抹
        txt = txt.replace(/("value"\s*:\s*)"(sk-[A-Za-z0-9_-]{8,}|user_[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9._-]{20,})"/g, '$1""');
        const clean = txt.replace(/("(?:api_?key|token|secret|password)"\s*:\s*)"[^"]*"/gi, '$1""');
        if (clean !== orig) fs.writeFileSync(dest, clean, 'utf8');
      } catch (e) {}
    }
  }
}

console.log('[打包] 目标：' + OUT);
const missing = [];
for (const rel of INCLUDE) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) { missing.push(rel); continue; }
  walk(src, rel);
}
console.log('[打包] ' + totalFiles + ' 个文件，共 ' + (totalBytes / 1024 / 1024).toFixed(0) + ' MB');
if (missing.length) console.log('[打包] 缺失：' + missing.join(', '));
console.log('[打包] 排除 ' + skipped.length + ' 项');

if (!dry) {
  const envDoc = fs.readFileSync(path.join(HERE, 'env-template.md'), 'utf8');
  fs.writeFileSync(path.join(OUT, '运行环境.md'), envDoc, 'utf8');

  // 体积清单：便于发现混进来的大文件
  const big = [];
  (function scan(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) scan(full);
      else if (st.size > 20 * 1024 * 1024) big.push([path.relative(OUT, full), st.size]);
    }
  })(OUT);
  big.sort((a, b) => b[1] - a[1]);
  fs.writeFileSync(path.join(OUT, '体积清单.txt'),
    big.map(([p, s]) => (s / 1024 / 1024).toFixed(1).padStart(8) + ' MB  ' + p).join('\n') || '(没有超过 20MB 的单个文件)',
    'utf8');

  console.log('[打包] 完成：' + OUT);
}