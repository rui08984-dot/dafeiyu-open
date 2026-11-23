// import-lumenact.mjs —— 把 LumenAct 的表演曲线导入成我们的 FACS 片段（2026-11-17 六十二轮续）
//
// 为什么要这一步（调研结论见 docs/交接 §63）：
//   我们自己的「长表演」只有 15 段（88KB），表演「傻」的主因是素材少 + 选择不看上下文。
//   LumenAct（B站 Lumen_流明_）公开了 **97 段人工表演曲线**，表演数据按 **CC BY 4.0** 授权，
//   允许商用与修改 —— 正好补上「素材」这一环。
//
//   但**不能直接用他们的数据格式**：他们的 166 个通道是 VRM/VRC 的 blendshape 名字
//   （mouth_smile_1 / eyebrow_worry_L …），直接映射到我们的 Cubism 参数就绑死在某个模型上，
//   换皮套全废（这正是 facs.mjs 当初要解耦掉的东西）。
//   所以正确做法是：**LumenAct 通道 → 我们的 FACS 语义通道**（30 个），
//   再由既有的 profile.mjs 落到具体参数。模型无关、缺参数自动降级。
//
// 授权要求（必须遵守）：
//   - 表演数据 CC BY 4.0：保留作者署名、注明来源「LumenAct／流明表情工坊」、附许可链接、
//     说明是否修改（我们做了：通道→FACS 重映射、0–100 归一化、抽帧到 20fps）。
//   - 语义模型权重 Apache-2.0（本脚本不碰模型）。
//   - 参考脸 CC BY-NC 4.0（我们不用）。
//
// 用法：
//   node pet-runtime/tools/import-lumenact.mjs \
//     --catalog _research/lumenact/assets/catalog.json \
//     --curves  _research/lumenact/assets/curves.f32 \
//     --out     pet-runtime/data/facs-clips
//   node pet-runtime/tools/import-lumenact.mjs --report   # 只打印通道映射覆盖情况
//
// 退出码：0 = 成功；1 = 参数/文件错误或覆盖不全（有未映射通道时仍成功，但会打印提示）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIP_RANGES } from '../desktop/perf/facs-clip-player.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const SCHEMA = 'petbody.facs-clip.v1';
const OUT_FPS = 20;          // 输出采样率：FACS 层有低通惯性，20fps 足够；60fps 由播放器插值
const ROUND = 3;             // 保留 3 位小数（0.001 的精度远大于视觉分辨）
const FADE_MS = 240;         // 片段两端淡入淡出（进/出不要瞬跳）

/**
 * 通道映射表（**改这里等于改「她会怎么演」**，改前先看 coverage 报告）
 *
 * 字段：
 *   src       LumenAct 的通道属性名（去掉 `blendShape.` 前缀）
 *   facs      我们的 FACS 通道（facs.mjs 的 FACS_KEYS）
 *   gain      乘数。blendshape 源是 0–100，先 /100；muscle 源本身就是 -1..1（unit:'raw'）
 *   unit      'pct'（默认，0–100）| 'raw'（-1..1，不除 100）
 *   pair      'avg'（成对通道取平均，默认对 gaze 用）| 'max'（默认：同一 FACS 多来源取最强者）
 *   sign      1 / -1（方向；换模型/换语义约定时可能要翻）
 *   why       为什么这样映射（一句话，别删）
 */
export const CHANNEL_MAP = [
  // ── 眉毛 ───────────────────────────────────────────────────────────
  { src: 'eyebrow_up_L', facs: 'browUpL', gain: 1, why: '抬左眉' },
  { src: 'eyebrow_up_R', facs: 'browUpR', gain: 1, why: '抬右眉' },
  { src: 'eyebrow_smile_L', facs: 'browUpL', gain: 0.5, why: '笑眉是抬眉的弱化版' },
  { src: 'eyebrow_smile_R', facs: 'browUpR', gain: 0.5, why: '同上' },
  { src: 'eyebrow_down_L', facs: 'browDown', gain: 1, why: '压眉' },
  { src: 'eyebrow_down_R', facs: 'browDown', gain: 1, why: '压眉' },
  { src: 'eyebrow_angry_L', facs: 'browDown', gain: 1, why: '生气眉=压眉（配合 eye_angry）' },
  { src: 'eyebrow_angry_R', facs: 'browDown', gain: 1, why: '同上' },
  { src: 'eyebrow_serious_L', facs: 'browDown', gain: 0.7, why: '严肃比生气轻' },
  { src: 'eyebrow_serious_R', facs: 'browDown', gain: 0.7, why: '同上' },
  { src: 'eyebrow_worry_L', facs: 'browInnerUp', gain: 1, why: '担心=眉心上挑（FACS AU1）' },
  { src: 'eyebrow_worry_R', facs: 'browInnerUp', gain: 1, why: '同上' },
  { src: 'eyebrow_shy_L', facs: 'browInnerUp', gain: 0.6, why: '害羞是弱化版眉心上挑' },
  { src: 'eyebrow_shy_R', facs: 'browInnerUp', gain: 0.6, why: '同上' },
  { src: 'eyebrow_move _front_L', facs: 'browDown', gain: 0.4, why: '眉心前压（原通道名带空格，照抄）' },
  { src: 'eyebrow_move _front_R', facs: 'browDown', gain: 0.4, why: '同上' },

  // ── 眼睛 ───────────────────────────────────────────────────────────
  { src: 'eye_smile', facs: 'eyeSmile', gain: 1, why: '眼笑（AU6）' },
  { src: 'eye_zitome', facs: 'eyeSquint', gain: 1, why: '眯眼' },
  { src: 'eye_angry', facs: 'eyeSquint', gain: 0.8, why: '怒视=下眼睑收紧' },
  { src: 'eye_worry', facs: 'eyeSquint', gain: 0.6, why: '担忧的眯' },
  { src: 'eye_surprised', facs: 'eyeOpen', gain: 0.32, why: '惊讶睁大（我们 eyeOpen 上限 1.32）' },
  { src: 'eye_surprised_L', facs: 'eyeOpen', gain: 0.2, why: '单眼版，弱一点' },
  { src: 'eye_surprised_R', facs: 'eyeOpen', gain: 0.2, why: '同上' },
  { src: 'eye_big_L', facs: 'eyeOpen', gain: 0.2, why: '大眼（萌）' },
  { src: 'eye_big_R', facs: 'eyeOpen', gain: 0.2, why: '同上' },
  { src: 'eye_close', facs: 'eyeOpen', gain: -0.2, sign: 1, why: '闭一点（负向贡献；源最大只有 ~10.7）' },
  { src: 'eye_eyelid_up', facs: 'eyeOpen', gain: 0.15, why: '上眼睑抬（眼睛更亮更大）' },
  { src: 'eye_eyelid_up_L', facs: 'eyeOpen', gain: 0.15, why: '同上（单眼版）' },
  { src: 'eye_eyelid_up_R', facs: 'eyeOpen', gain: 0.15, why: '同上（单眼版）' },
  { src: 'eye_wink_1_L', facs: 'eyeBlinkL', gain: 1, why: '左眨眼' },
  { src: 'eye_wink_2_L', facs: 'eyeBlinkL', gain: 1, why: '左眨眼变体' },
  { src: 'eye_wink_1_R', facs: 'eyeBlinkR', gain: 1, why: '右眨眼' },
  { src: 'eye_wink_2_R', facs: 'eyeBlinkR', gain: 1, why: '右眨眼变体' },
  { src: 'eye_small_L', facs: 'eyeSquintL', gain: 1, why: '左眼变小' },
  { src: 'eye_small_R', facs: 'eyeSquintR', gain: 1, why: '右眼变小' },

  // ── 嘴（注意：说话时由播放器按 speechActive 屏蔽，避免和口型层打架）──
  { src: 'mouth_smile_1', facs: 'mouthSmile', gain: 1, why: '笑（主）' },
  { src: 'mouth_smile_2', facs: 'mouthSmile', gain: 0.8, why: '笑（次）' },
  { src: 'mouth_angry_1', facs: 'mouthFrown', gain: 1, why: '怒嘴=嘴角down' },
  { src: 'mouth_angry_2', facs: 'mouthFrown', gain: 0.8, why: '同上（次）' },
  { src: 'mouth_kiss', facs: 'mouthPucker', gain: 1, why: '撅嘴' },
  { src: 'mouth_circle', facs: 'mouthPucker', gain: 0.5, why: '圆嘴≈撅嘴的弱化' },
  { src: 'mouth_a', facs: 'mouthOpen', gain: 1, why: '张嘴（非说话时用它做表情）' },
  { src: 'mouth_a_2', facs: 'mouthOpen', gain: 1, why: '张嘴的第二个变体' },
  { src: 'mouth_wa', facs: 'mouthOpen', gain: 1, why: '「哇」张口（源最大只有 ~15）' },
  { src: 'mouth_o', facs: 'mouthOpen', gain: 0.8, why: 'O 嘴=较小的张口' },
  { src: 'mouth_w', facs: 'mouthPucker', gain: 1, why: 'W 型嘴=圆唇' },
  { src: 'mouth_triangle', facs: 'mouthFrown', gain: 0.6, why: '三角嘴＝动漫里的不满/喊叫形状' },
  { src: 'mouth_cheek_inflate', facs: 'cheekPuff', gain: 1, why: '鼓腮' },
  { src: 'mouth_panic', facs: 'mouthOpen', gain: 0.6, why: '慌张张嘴（弱化）' },

  // ── 特殊 ───────────────────────────────────────────────────────────
  { src: 'sp_tear_default', facs: 'tear', gain: 1, why: '泪（默认）' },
  { src: 'sp_tear_cool', facs: 'tear', gain: 1, why: '泪（cool 版）' },
  { src: 'sp_cheek', facs: 'cheekPuff', gain: 1, why: '腮' },

  // ── 头/眼肌（muscle 通道，源值域 -1..1，不除 100）────────────────
  { src: 'Head Nod Down-Up', facs: 'headX', gain: 1, unit: 'raw', why: '点头（pitch）' },
  { src: 'Head Turn Left-Right', facs: 'headY', gain: 1, unit: 'raw', why: '转头（yaw）' },
  { src: 'Head Tilt Left-Right', facs: 'headZ', gain: 1, unit: 'raw', why: '歪头（roll）' },
  { src: 'Left Eye Down-Up', facs: 'gazeY', gain: 1, unit: 'raw', pair: 'avg', why: '视线上下（双眼平均）' },
  { src: 'Right Eye Down-Up', facs: 'gazeY', gain: 1, unit: 'raw', pair: 'avg', why: '同上' },
];

/** 有意不映射的通道（写清楚原因，避免下次有人以为漏了） */
export const SKIP_BY_DESIGN = {
  'vrc.v_sil': '口型/viseme 归我们的口型层，表演曲线里它们本来就是 0',
  'vrc.v_pp': '同上', 'vrc.v_aa': '同上', 'vrc.v_oh': '同上', 'vrc.v_ou': '同上',
  'vrc.v_ih': '同上', 'vrc.v_th': '同上', 'vrc.v_nn': '同上', 'vrc.v_dd': '同上',
  'vrc.v_kk': '同上', 'vrc.v_ff': '同上', 'vrc.v_e': '同上', 'vrc.v_ch': '同上',
  'vrc.v_rr': '同上', 'vrc.v_ss': '同上',
  'vrc.eye_up': '常量 100（默认状态），不是动画',
  'vrc.eye_down': '同上（常量）',
  'vrc.eye_blink': '与 eye_blink 重复且恒 0',
  'sp_ear_elf': '模型专属形态（精灵耳），我们没有对应参数',
  'fronthair_change': '模型专属（刘海），不是表情',
  'eyeshighlight_move_L': '高光位移，我们参数表没有对应通道',
  'eyeshighlight_move_R': '同上',
  'eye_highlight_1_hide': '高光隐藏，纯美术层',
  'eye_highlight_2_hide': '同上', 'eye_highlight_3_hide': '同上',
  'eye_eyellashes_1_hide': '睫毛隐藏，纯美术层', 'eye_eyelashes_2_hide': '同上',
  'eye_doubleeyelid_1_hide': '双眼皮隐藏，纯美术层', 'eye_doubleeyelid_2_hide': '同上',
  'eye_star': '星星眼＝贴图/美术效果，FACS 没有对应语义（硬映射会变成「假笑」）',
  'eye_heart': '爱心眼同上',
  'eye_cool': '酷眼＝美术效果', 'eye_cool_L': '同上', 'eye_cool_R': '同上',
  'eye_change': '换眼型（美术），非表情通道',
  'eye_line': '眼线美术层',
  'eye_near': '近视/远视对焦 morph（美术效果），不是表情',
  'eye_far': '同上',
  'mouth_M': 'M 型唇（美术唇形），FACS 没有「抿嘴」通道',
  'mouth_line': '唇线美术变形', 'mouth_long': '唇长美术变形', 'mouth_short': '唇短美术变形',
  'eyebrow_long_L': '眉毛长短美术变形', 'eyebrow_long_R': '同上',
  'eyebrow_short_L': '同上', 'eyebrow_short_R': '同上',
  'eyebrow_big_1_L': '夸张眉（素材里恒 0）', 'eyebrow_big_1_R': '同上',
  'eyebrow_big_2_L': '同上', 'eyebrow_big_2_R': '同上',
  'sp_serious_2': '严肃（素材里恒 0；serious_1 已映射）',
  'sp_serious_1': '严肃（源最大只有 7.68，已并入 eyebrow_serious 语义，故不重复映射）',
  'mouth_i': '素材里恒 0', 'mouth_u': '素材里恒 0', 'mouth_e': '素材里恒 0',
  'mouth_dog': '素材里恒 0（犬齿嘴）', 'mouth_dogteeth': '素材里恒 0',
  'mouth_wa_teeth': '素材里恒 0',
  'eye_up': '素材里恒 0（方向 blendshape 未被用到；视线在 muscle 通道里）',
  'eye_down': '同上', 'eye_left': '同上', 'eye_right': '同上',
  'vrc.eye_blink': '素材里恒 0（眨眼由主工程的程序化眨眼负责，未随曲线公开）',
  'neck': '颈部肌肉在我们模型上不驱动（Head 已覆盖）',
  'Neck Nod Down-Up': '颈部通道在素材里恒 0，Head 已覆盖',
  'Neck Tilt Left-Right': '同上',
  'Neck Turn Left-Right': '同上',
  'Left Eye In-Out': '辐辏（斗鸡眼）语义，FACS 无对应；硬映射成左右扫视是错的',
  'Right Eye In-Out': '同上',
};

const DEFAULT_SKIP_PATTERNS = [
  [/^----------/, '分组占位通道'],
  [/^(Honoka|Nayu|Platinum)_/, '身体体型 morph（与表情无关）'],
  [/^(Body|UpperArm|LowerArm|Chest|Hips|UpperLeg|LowerLeg|Leg|Foot|heel)/, '身体体型 morph'],
  [/^(mouth_upperteeth|mouth_lowerteeth|mouth_teeth|mouth_tongue)/, '牙齿/舌头美术层'],
];

function parseArgs(argv) {
  const out = { catalog: null, curves: null, out: null, report: false, fps: OUT_FPS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--catalog') out.catalog = argv[++i];
    else if (a === '--curves') out.curves = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--fps') out.fps = Math.max(5, Math.min(60, Number(argv[++i]) || OUT_FPS));
    else if (a === '--report') out.report = true;
  }
  return out;
}

/** 通道属性名归一：`blendShape.mouth_smile_1` → `mouth_smile_1` */
const bareName = (property) => String(property || '').replace(/^blendShape\./, '');

/** 建映射索引：src → [{facs, gain, unit, pair, sign}] */
export function buildMappingIndex(map = CHANNEL_MAP) {
  const idx = new Map();
  for (const m of map) {
    if (!idx.has(m.src)) idx.set(m.src, []);
    idx.get(m.src).push({
      facs: m.facs,
      gain: Number.isFinite(Number(m.gain)) ? Number(m.gain) : 1,
      unit: m.unit === 'raw' ? 'raw' : 'pct',
      pair: m.pair === 'avg' ? 'avg' : 'max',
      sign: Number(m.sign) === -1 ? -1 : 1,
      why: m.why || '',
    });
  }
  return idx;
}

/**
 * 把一段曲线（[frame][channel]）转成 FACS 通道数组。
 * 纯函数：输入 Float32Array + 通道定义 + 映射索引，输出 {facsKey: number[]}。
 *
 * 聚合规则（同一 FACS 键可能被多个源通道驱动）：
 *   - pair:'avg' 的源（双眼视线这类成对通道）→ 取平均
 *   - 其余源（眉/嘴这类「谁更明显听谁的」）→ 取绝对值更大者
 */
export function convertSegment({ f32, channelCount, channels, offset, frames, outFrames, mapIndex }) {
  const step = frames / outFrames;              // 抽帧步长（原 30fps → 20fps ≈ 1.5）
  const sources = new Map();                    // facsKey -> [{values:number[], pair}]

  for (let ci = 0; ci < channelCount; ci += 1) {
    const def = channels[ci];
    if (!def) continue;
    const targets = mapIndex.get(bareName(def.property));
    if (!targets) continue;
    for (const t of targets) {
      const values = new Array(outFrames);
      for (let f = 0; f < outFrames; f += 1) {
        const srcFrame = Math.min(frames - 1, Math.round(f * step));
        const raw = f32[(offset + srcFrame) * channelCount + ci];
        // blendshape 源是 0–100；muscle 源是 -1..1
        const norm = t.unit === 'raw' ? raw : raw / 100;
        values[f] = Number.isFinite(norm) ? norm * t.gain * t.sign : 0;
      }
      if (!sources.has(t.facs)) sources.set(t.facs, []);
      sources.get(t.facs).push({ values, pair: t.pair });
    }
  }

  const out = {};
  for (const [facs, list] of sources) {
    const avgList = list.filter((x) => x.pair === 'avg');
    const maxList = list.filter((x) => x.pair !== 'avg');
    const arr = new Array(outFrames).fill(0);
    for (let f = 0; f < outFrames; f += 1) {
      let v = 0;
      if (avgList.length) {
        let sum = 0;
        for (const x of avgList) sum += x.values[f];
        v = sum / avgList.length;
      }
      for (const x of maxList) {
        if (Math.abs(x.values[f]) > Math.abs(v)) v = x.values[f];
      }
      arr[f] = v;
    }
    // 整段没有变化 = 没信息（例如素材里恒为 0 的通道），去掉省体积
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    if (Math.abs(max - min) < 1e-6) continue;
    // clamp 到该通道的语义值域：素材里有 -0.16 这类平滑噪声，
    // 存进片段会让「值域自检」和下游假设都不成立
    const range = CLIP_RANGES[facs];
    out[facs] = arr.map((v) => {
      const clamped = range ? Math.min(range[1], Math.max(range[0], v)) : v;
      return Math.round(clamped * 10 ** ROUND) / 10 ** ROUND;
    });
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalogPath = args.catalog || path.join(ROOT, '_research', 'lumenact', 'assets', 'catalog.json');
  const curvesPath = args.curves || path.join(ROOT, '_research', 'lumenact', 'assets', 'curves.f32');

  if (!fs.existsSync(catalogPath)) { console.error('缺 catalog.json：' + catalogPath); process.exit(1); }
  if (!fs.existsSync(curvesPath)) { console.error('缺 curves.f32：' + curvesPath); process.exit(1); }

  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  if (catalog.schema !== 'lumenact.curves.v1') { console.error('catalog schema 不是 lumenact.curves.v1：' + catalog.schema); process.exit(1); }

  const channels = catalog.channels || [];
  const channelCount = Number(catalog.channel_count);
  const styles = catalog.styles || [];
  const mapIndex = buildMappingIndex();

  // ── 覆盖报告（先算，report 模式直接打印退出）──────────────────────
  const mappedSrc = new Set();
  for (const [src] of mapIndex) mappedSrc.add(src);
  const presentSrc = new Set(channels.map((c) => bareName(c.property)));
  const unmapped = [...presentSrc].filter((s) => !mappedSrc.has(s) && !SKIP_BY_DESIGN[s] && !DEFAULT_SKIP_PATTERNS.some(([re]) => re.test(s)));
  const mappedButAbsent = [...mappedSrc].filter((s) => !presentSrc.has(s));

  console.log(`[import-lumenact] catalog: ${styles.length} 段 / ${channelCount} 通道 / fps ${catalog.fps}`);
  console.log(`  映射到 FACS 的源通道 ${mappedSrc.size} 个（其中 ${[...mappedSrc].filter((s) => presentSrc.has(s)).length} 个在素材里真实存在）`);
  if (mappedButAbsent.length) console.log('  ⚠ 映射表里有、但素材里没有的通道：' + mappedButAbsent.join(', '));
  if (unmapped.length) console.log('  ⚠ 未映射且不在「有意跳过」名单里的通道：' + unmapped.join(', '));
  else console.log('  ✅ 所有通道都有归属（映射 / 有意跳过）');

  if (args.report) {
    const byFacs = new Map();
    for (const m of CHANNEL_MAP) {
      if (!byFacs.has(m.facs)) byFacs.set(m.facs, []);
      byFacs.get(m.facs).push(m.src);
    }
    console.log('\n  FACS 通道 ← 源通道：');
    for (const [facs, srcs] of [...byFacs].sort()) console.log(`    ${facs.padEnd(14)} ← ${srcs.join(', ')}`);
    process.exit(unmapped.length ? 1 : 0);
  }

  // 文件尺寸自检：值个数必须正好等于 (最大 offset+frames) × 通道数
  const buf = fs.readFileSync(curvesPath);
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  const expectedFrames = styles.reduce((m, s) => Math.max(m, Number(s.offset) + Number(s.frames)), 0);
  if (expectedFrames > 0 && f32.length !== expectedFrames * channelCount) {
    console.error(`curves 值个数不符：文件 ${f32.length} / 期望 ${expectedFrames}×${channelCount}=${expectedFrames * channelCount}`);
    process.exit(1);
  }

  const outDir = args.out ? path.resolve(args.out) : path.join(ROOT, 'pet-runtime', 'data', 'facs-clips');
  fs.mkdirSync(outDir, { recursive: true });
  const clipsDir = path.join(outDir, 'clips');
  fs.mkdirSync(clipsDir, { recursive: true });

  const index = [];
  let totalBytes = 0;
  let totalFrames = 0;
  const usedFacs = new Set();

  for (const style of styles) {
    const srcFrames = Number(style.frames);
    const offset = Number(style.offset);
    if (!Number.isFinite(srcFrames) || !Number.isFinite(offset) || srcFrames <= 0) {
      console.error('片段字段异常，跳过：' + JSON.stringify(style));
      continue;
    }
    const outFrames = Math.max(2, Math.round((srcFrames / Number(catalog.fps || 30)) * args.fps));
    const facs = convertSegment({ f32, channelCount, channels, offset, frames: srcFrames, outFrames, mapIndex });
    const keys = Object.keys(facs);
    for (const k of keys) usedFacs.add(k);

    // 「可迁移强度」：本片段在我们映射通道上的幅度总和（单位≈百分点）。
    // 为什么要它：97 段里有强有弱（实测 19–761，中位 222），弱的段几乎只是微动。
    // 导演层按 energy 挑，才不会挑到「演了跟没演一样」的片段。
    const energy = Math.round(keys.reduce((sum, k) => {
      const arr = facs[k];
      return sum + (Math.max(...arr) - Math.min(...arr)) * 100;
    }, 0));

    const clip = {
      schema: SCHEMA,
      id: 'lumen-' + String(style.id),
      source: {
        project: 'LumenAct',
        author: 'B站 Lumen_流明_',
        license: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        url: 'https://github.com/AaBb-coder/LumenAct',
        clipId: String(style.id),
        modifications: '通道→FACS 重映射、0–100 归一化、抽帧到 ' + args.fps + 'fps',
      },
      label: style.label || '',
      emotion: style.emotion || '',
      subcategory: style.subcategory || '',
      environment: style.environment || '',
      pace: style.pace || '',
      fps: args.fps,
      frames: outFrames,
      durationMs: Math.round((outFrames / args.fps) * 1000),
      fadeMs: FADE_MS,
      energy,
      channels: facs,
    };
    const file = path.join(clipsDir, clip.id + '.json');
    const text = JSON.stringify(clip);
    fs.writeFileSync(file, text);
    totalBytes += Buffer.byteLength(text);
    totalFrames += outFrames;

    index.push({
      id: clip.id,
      label: clip.label,
      emotion: clip.emotion,
      subcategory: clip.subcategory,
      frames: clip.frames,
      durationMs: clip.durationMs,
      fps: clip.fps,
      energy,
      channelCount: keys.length,
      channels: keys,
    });
  }

  const indexDoc = {
    schema: SCHEMA + '.index',
    generatedAt: new Date().toISOString(),
    source: { project: 'LumenAct', author: 'B站 Lumen_流明_', license: 'CC BY 4.0', url: 'https://github.com/AaBb-coder/LumenAct' },
    fps: args.fps,
    clipCount: index.length,
    totalFrames,
    facsChannels: [...usedFacs].sort(),
    clips: index,
  };
  const indexText = JSON.stringify(indexDoc, null, 1);
  fs.writeFileSync(path.join(outDir, 'index.json'), indexText);

  // 授权声明随数据走（CC BY 4.0 要求）
  fs.writeFileSync(path.join(outDir, 'NOTICE.md'), [
    '# 表演数据来源与许可',
    '',
    '本目录的 FACS 片段由 **LumenAct**（作者：B站 Lumen_流明_）公开的表演曲线转换而来。',
    '',
    '- 原始项目：https://github.com/AaBb-coder/LumenAct',
    '- 表演数据许可：**Creative Commons Attribution 4.0 International (CC BY 4.0)**',
    '  https://creativecommons.org/licenses/by/4.0/',
    '- 转换脚本：`pet-runtime/tools/import-lumenact.mjs`',
    '- 我们做的修改：把 166 个 VRM/VRC blendshape 通道重映射到本项目的 FACS 语义通道、',
    '  数值由 0–100 归一化到 FACS 单位、按 ' + args.fps + 'fps 抽帧、去掉整段恒定的通道。',
    '',
    '原始表演曲线的 166 通道定义、片段标签（label/emotion/subcategory/environment/pace）均来自 LumenAct。',
    '本目录**不包含** LumenAct 的参考脸（其许可为 CC BY-NC 4.0），也不包含其语义模型权重（Apache-2.0）。',
    '',
    '> 表演数据来源：LumenAct／流明表情工坊',
  ].join('\n'));

  console.log(`\n  ✅ 转换完成：${index.length} 段 → ${path.relative(ROOT, clipsDir)}`);
  console.log(`     FACS 通道 ${usedFacs.size} 个：${[...usedFacs].sort().join(', ')}`);
  console.log(`     总帧 ${totalFrames} · clips ${(totalBytes / 1024).toFixed(0)}KB · index ${(Buffer.byteLength(indexText) / 1024).toFixed(0)}KB`);
  process.exit(unmapped.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
