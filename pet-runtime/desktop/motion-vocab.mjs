// motion-vocab.mjs —— 动作词典：英文动作标签 → Live2D 参数编舞
//
// 这一层只做两件事：
//   1. 把 "[wave right hand]" 这种标签解析成「动作名 + 修饰（左右手 / 力度 / 快慢）」；
//   2. 把动作展开成逐帧的「参数补偿量」，交给 cubism-renderer 叠加到
//      body-director / interaction-motion 已经算好的基础值上。
//
// 为什么是补偿量而不是绝对值：
//   基础层每帧都会重算呼吸 / 重心 / 髋摆 / 头部跟随。如果动作直接写绝对值，会把基础层顶掉；
//   而这套皮套有 131 组物理（ParamBreath 被 30 组引用、PositionY 22 组、BodyAngle 20 组），
//   输入参数的突变会让头发 / 裙摆 / 尾巴「抽」一下。补偿量只加动作自己那一份，
//   动作播完自然归零，不需要任何清理就能回待机。
//
// 参数范围、参数是否存在，全部由渲染器从模型读（这套 rig 的 LArm 是 -1..1，
// 头部角度是 -30..30，Movement1/2/3 是 0..1 开关，不能写死）。

export const FADE_IN = 0.12;   // 淡入 120ms
export const FADE_OUT = 0.2;   // 淡出 200ms
export const MAX_TAG_LENGTH = 120;

// Movement1/2/3 是模型自带的手势开关（狗尾草 / 抚胸 / 竖食指），三个互斥：
// 切手势时另外两个先置 0，避免上一个手势的残影叠在新手势上。
export const MOVEMENT_PARAMS = ['Movement1', 'Movement2', 'Movement3'];

// 这套 rig 的 physics3.json 有 131 组物理、292 个「物理输出参数」：
// AngleX/Y/Z、PositionX/Y/Z、LeanInput、ParamBreath、Movement1/2/3 是物理链的输入，
// 而 RArm/LArm/RForearm/…、ShoulderY/Z、HipAngle*、ParamBodyAngle*、ParamAngle* 都是
// 物理算完写回的**输出**（直接写会被物理覆盖）。所以补偿量按角色分两批贴：
//   pre  —— 物理之前贴，驱动整条链（头发/裙摆/尾巴跟着甩）
//   post —— 物理之后贴，盖住物理输出（手臂关节、躯干角度这类要立刻摆住的地方）
export const PHYSICS_INPUTS = new Set([
  'AngleX', 'AngleY', 'AngleZ', 'PositionX', 'PositionY', 'PositionZ', 'LeanInput',
  'ParamBreath', 'Movement1', 'Movement2', 'Movement3', 'Param38',
  'ParamEyeBallX', 'ParamEyeBallY', 'ParamMouthOpenY', 'ParamMouthForm',
  'ParamEyeLOpen', 'ParamEyeROpen', 'LControl', 'RControl',
]);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (t) => t * t * (3 - 2 * t);

// 关键帧插值：keys = [[时间秒, 补偿量], ...]，段内 smoothstep，首尾速度为 0，不会顿挫。
function sampleTrack(keys, t) {
  const first = keys[0];
  if (t <= first[0]) return first[1];
  for (let i = 1; i < keys.length; i++) {
    const [end, value] = keys[i];
    const [start, previous] = keys[i - 1];
    if (t <= end) return previous + (value - previous) * smooth(clamp((t - start) / Math.max(1e-6, end - start), 0, 1));
  }
  return keys[keys.length - 1][1];
}

// ── 频道标定（实测，见 _incoming/probe/b-channels.jsonl）────────────────────────
// 这套 rig 的 physics3.json 有 131 组物理、292 个「物理输出参数」。参数分两类：
//   物理输入：AngleX/Y/Z（头）、PositionX/Y/Z、LeanInput、ParamBreath、Movement1/2/3 ……
//   物理输出：ParamAngleX/Y/Z、ParamBodyAngle*、RArm/LArm/RForearm/…、ShoulderY/Z、HipAngle* ……
// 物理每帧都会把「输出参数」写回去，所以：写 AngleX/Y/Z 能带动整条链（头发/裙摆/尾巴跟着甩），
// 而写 ParamAngleX 或 RArm 会被物理覆盖 —— 这类必须贴到物理之后（post）。
//
// 实测每档幅度带来的画面变化（300x520 / framing=half，Δ = 变化像素占比）：
//   AngleY ±15 → 24%   AngleX 12 → 25%   AngleZ 10 → 27.5%
//   ParamBodyAngleRX 12 → 60%   ParamBodyAngleZ 8 → 53%   ParamBodyAngleY 10 → 41%
//   ShoulderY 4 → 7.7%   RArm/LArm 0.8 → 7.8%   Param38=1 → 3.6%
//   Movement2=1 → 4.2%   ParamEyeBallY .5 → 1.7%
// 所以编舞以「头 + 躯干角度」为主，手臂和 Movement 做点缀，物理链自然会跟着甩。
//
// 不碰的频道（免得和别的层打架）：
//   ParamBreath / PositionXYZ / HipAngle* —— body-director 的呼吸与重心输入，动作期间它要继续跑；
//   LeanInput —— 外观资产「前倾」占用的参数，会被 captureAppearance 每帧钉进 defaults；
//   Movement1 / Movement3 —— C 的手势资产（狗尾草 / 竖食指）会把它们钉进 defaults，
//     动作里只在需要"换手势"时把它们临时置 0，并在渲染层跳过对它们的 defaults 回写。
export const ACTIONS = {
  wave: {
    label: '挥手',
    tag: 'wave',
    duration: 2.1,
    tracks: {
      // 头微微转向抬手的一侧，同时向另一边歪一点，看起来是"打招呼"不是"抽搐"
      AngleX: [[0, 0], [0.28, 3.5], [1.85, 3.5], [2.1, 0]],
      AngleZ: [[0, 0], [0.3, -3], [1.85, -3], [2.1, 0]],
    },
    sides: {
      right: {
        RArm: [[0, 0], [0.26, 0.82], [1.8, 0.82], [2.05, 0]],
        RForearm: [[0, 0], [0.3, 0.42], [1.8, 0.42], [2.05, 0]],
        RWrist: [[0, 0], [0.36, 0.55], [0.5, -0.3], [0.64, 0.55], [0.78, -0.3], [0.92, 0.55], [1.06, -0.3], [1.2, 0.55], [1.34, 0.15], [1.45, 0], [2.05, 0]],
        RHand: [[0, 0], [0.32, 0.35], [1.8, 0.35], [2.05, 0]],
        ShoulderY: [[0, 0], [0.3, 1.2], [1.85, 1.2], [2.1, 0]],
        ParamBodyAngleRX: [[0, 0], [0.3, 4], [1.85, 4], [2.1, 0]],
      },
      left: {
        LArm: [[0, 0], [0.26, 0.82], [1.8, 0.82], [2.05, 0]],
        LForearm: [[0, 0], [0.3, 0.42], [1.8, 0.42], [2.05, 0]],
        LWrist: [[0, 0], [0.36, -0.55], [0.5, 0.3], [0.64, -0.55], [0.78, 0.3], [0.92, -0.55], [1.06, 0.3], [1.2, -0.55], [1.34, -0.15], [1.45, 0], [2.05, 0]],
        LHand: [[0, 0], [0.32, 0.35], [1.8, 0.35], [2.05, 0]],
        ShoulderY: [[0, 0], [0.3, 1.2], [1.85, 1.2], [2.1, 0]],
        ParamBodyAngleRX: [[0, 0], [0.3, -4], [1.85, -4], [2.1, 0]],
      },
    },
    defaultSide: 'right',
  },

  raise_your_hands: {
    label: '举双手',
    tag: 'raise your hands',
    duration: 1.7,
    tracks: {
      Param38: [[0, 0], [0.32, 1], [1.35, 1], [1.7, 0]],
      AngleY: [[0, 0], [0.35, 4.5], [1.3, 4.5], [1.7, 0]],
      ShoulderY: [[0, 0], [0.35, 2.4], [1.3, 2.4], [1.7, 0]],
      ShoulderZ: [[0, 0], [0.35, 1.6], [1.3, 1.6], [1.7, 0]],
      RArm: [[0, 0], [0.3, 0.85], [1.35, 0.85], [1.7, 0]],
      LArm: [[0, 0], [0.3, 0.85], [1.35, 0.85], [1.7, 0]],
      RForearm: [[0, 0], [0.34, 0.45], [1.35, 0.45], [1.7, 0]],
      LForearm: [[0, 0], [0.34, 0.45], [1.35, 0.45], [1.7, 0]],
      RWrist: [[0, 0], [0.42, 0.2], [0.62, -0.18], [0.82, 0.2], [1.02, -0.18], [1.2, 0], [1.7, 0]],
      LWrist: [[0, 0], [0.42, -0.2], [0.62, 0.18], [0.82, -0.2], [1.02, 0.18], [1.2, 0], [1.7, 0]],
      ParamBodyAngleRX: [[0, 0], [0.35, -3], [1.3, -3], [1.7, 0]],
    },
  },

  nod_head: {
    label: '点头',
    tag: 'nod head',
    duration: 0.95,
    tracks: {
      // 两下点头：低头 → 回正 → 再低头 → 回正（AngleY 负 = 低头）
      AngleY: [[0, 0], [0.16, -11], [0.32, -2], [0.48, -9], [0.64, -1], [0.82, -4], [0.95, 0]],
      AngleX: [[0, 0], [0.3, -1.5], [0.7, 1], [0.95, 0]],
      ParamBodyAngleRX: [[0, 0], [0.2, 0.8], [0.5, 0.2], [0.7, 0.8], [0.95, 0]],
    },
  },

  shake_head: {
    label: '摇头',
    tag: 'shake head',
    duration: 1.05,
    tracks: {
      // 左右摆头：AngleX 正 = 看观者左侧
      AngleX: [[0, 0], [0.15, 9], [0.34, -9], [0.53, 8], [0.71, -7], [0.88, 3], [1.05, 0]],
      AngleZ: [[0, 0], [0.15, 2], [0.34, -2], [0.53, 2], [0.71, -1.5], [1.05, 0]],
      ParamBodyAngleZ: [[0, 0], [0.15, 1], [0.34, -1], [0.53, 0.8], [0.71, -0.6], [1.05, 0]],
    },
  },

  tilt_head: {
    label: '歪头',
    tag: 'tilt head',
    duration: 1.15,
    tracks: {
      AngleX: [[0, 0], [0.3, 2], [0.85, 2], [1.15, 0]],
      AngleY: [[0, 0], [0.3, 1.5], [0.85, 1.5], [1.15, 0]],
      ParamBodyAngleRX: [[0, 0], [0.32, 1.5], [0.85, 1.5], [1.15, 0]],
    },
    sides: {
      // 默认歪向角色自己的右边 = 头倒向观者左侧 = AngleZ 正值
      right: { AngleZ: [[0, 0], [0.32, 9], [0.85, 9], [1.15, 0]] },
      left: { AngleZ: [[0, 0], [0.32, -9], [0.85, -9], [1.15, 0]] },
    },
    defaultSide: 'right',
  },

  bow: {
    label: '鞠躬',
    tag: 'bow',
    duration: 1.5,
    tracks: {
      AngleY: [[0, 0], [0.34, -17], [0.85, -17], [1.5, 0]],
      AngleX: [[0, 0], [0.34, -1.5], [0.85, -1.5], [1.5, 0]],
      ShoulderY: [[0, 0], [0.34, -2.4], [0.85, -2.4], [1.5, 0]],
      ShoulderZ: [[0, 0], [0.34, -1.4], [0.85, -1.4], [1.5, 0]],
      ParamBodyAngleRX: [[0, 0], [0.34, -6], [0.85, -6], [1.5, 0]],
      ParamBodyAngleZ: [[0, 0], [0.34, -1.5], [0.85, -1.5], [1.5, 0]],
    },
  },

  lean_forward: {
    label: '前倾',
    tag: 'lean forward',
    duration: 1.7,
    tracks: {
      AngleY: [[0, 0], [0.36, -5], [1.2, -5], [1.7, 0]],
      AngleX: [[0, 0], [0.4, -2], [1.2, -2], [1.7, 0]],
      ParamBodyAngleRX: [[0, 0], [0.36, -9], [1.2, -9], [1.7, 0]],
      ParamBodyAngleZ: [[0, 0], [0.36, -2], [1.2, -2], [1.7, 0]],
      ShoulderY: [[0, 0], [0.36, -1.6], [1.2, -1.6], [1.7, 0]],
      RArm: [[0, 0], [0.4, 0.16], [1.2, 0.16], [1.7, 0]],
      LArm: [[0, 0], [0.4, 0.16], [1.2, 0.16], [1.7, 0]],
    },
  },

  hands_on_chest: {
    label: '抚胸',
    tag: 'hands on chest',
    duration: 1.75,
    gesture: 'Movement2',
    tracks: {
      Movement2: [[0, 0], [0.34, 1], [1.35, 1], [1.75, 0]],
      RArm: [[0, 0], [0.32, 0.58], [1.35, 0.58], [1.75, 0]],
      RForearm: [[0, 0], [0.36, 0.52], [1.35, 0.52], [1.75, 0]],
      RHand: [[0, 0], [0.36, 0.3], [1.35, 0.3], [1.75, 0]],
      AngleY: [[0, 0], [0.36, -4], [1.35, -4], [1.75, 0]],
      AngleZ: [[0, 0], [0.4, 4], [1.35, 4], [1.75, 0]],
      ShoulderY: [[0, 0], [0.36, 1], [1.35, 1], [1.75, 0]],
      ParamBodyAngleRX: [[0, 0], [0.4, 2], [1.35, 2], [1.75, 0]],
    },
  },

  point: {
    label: '指',
    tag: 'point',
    duration: 1.35,
    gesture: 'Movement3',
    tracks: {
      Movement3: [[0, 0], [0.3, 1], [1.05, 1], [1.35, 0]],
      AngleX: [[0, 0], [0.32, 5], [1.05, 5], [1.35, 0]],
      AngleY: [[0, 0], [0.32, 2.5], [1.05, 2.5], [1.35, 0]],
      ParamBodyAngleRX: [[0, 0], [0.32, 3], [1.05, 3], [1.35, 0]],
    },
    sides: {
      right: {
        RArm: [[0, 0], [0.3, 0.7], [1.05, 0.7], [1.35, 0]],
        RForearm: [[0, 0], [0.34, 0.3], [1.05, 0.3], [1.35, 0]],
        RWrist: [[0, 0], [0.34, 0.25], [1.05, 0.25], [1.35, 0]],
        RHand: [[0, 0], [0.34, 0.45], [1.05, 0.45], [1.35, 0]],
      },
      left: {
        LArm: [[0, 0], [0.3, 0.7], [1.05, 0.7], [1.35, 0]],
        LForearm: [[0, 0], [0.34, 0.3], [1.05, 0.3], [1.35, 0]],
        LWrist: [[0, 0], [0.34, -0.25], [1.05, -0.25], [1.35, 0]],
        LHand: [[0, 0], [0.34, 0.45], [1.05, 0.45], [1.35, 0]],
      },
    },
    defaultSide: 'right',
  },

  shrug: {
    label: '耸肩',
    tag: 'shrug',
    duration: 1.3,
    tracks: {
      ShoulderY: [[0, 0], [0.3, 4], [0.95, 4], [1.3, 0]],
      ShoulderZ: [[0, 0], [0.3, -2], [0.95, -2], [1.3, 0]],
      RArm: [[0, 0], [0.3, 0.2], [0.95, 0.2], [1.3, 0]],
      LArm: [[0, 0], [0.3, 0.2], [0.95, 0.2], [1.3, 0]],
      AngleZ: [[0, 0], [0.3, 5], [0.95, 5], [1.3, 0]],
      AngleY: [[0, 0], [0.3, 1.5], [0.5, -1], [0.95, 0.5], [1.3, 0]],
      ParamBodyAngleZ: [[0, 0], [0.3, -1.2], [0.95, -1.2], [1.3, 0]],
    },
  },

  laugh: {
    label: '笑',
    tag: 'laugh',
    duration: 1.5,
    tracks: {
      // 身体抖着笑：头上下点 + 躯干小抖，频率快、幅度小
      AngleY: [[0, 0], [0.14, 3], [0.28, -4], [0.42, 3], [0.56, -4], [0.7, 2.5], [0.84, -2.5], [1, 1.5], [1.2, 0], [1.5, 0]],
      AngleZ: [[0, 0], [0.3, 2.5], [0.7, -2], [1.1, 1], [1.5, 0]],
      ParamBodyAngleZ: [[0, 0], [0.2, 1.2], [0.4, -1.2], [0.6, 1.2], [0.8, -1.2], [1, 0.8], [1.2, 0], [1.5, 0]],
      ShoulderY: [[0, 0], [0.3, 1], [0.6, -0.6], [0.9, 1], [1.2, 0], [1.5, 0]],
      RArm: [[0, 0], [0.3, 0.18], [0.6, 0.06], [0.9, 0.18], [1.2, 0], [1.5, 0]],
      LArm: [[0, 0], [0.3, 0.18], [0.6, 0.06], [0.9, 0.18], [1.2, 0], [1.5, 0]],
    },
  },

  angry: {
    label: '生气',
    tag: 'angry',
    duration: 1.4,
    tracks: {
      AngleY: [[0, 0], [0.18, -8], [1.05, -8], [1.4, 0]],
      AngleZ: [[0, 0], [0.2, -3], [0.5, 3], [0.8, -3], [1.05, 0], [1.4, 0]],
      ParamBodyAngleZ: [[0, 0], [0.16, 1.6], [0.32, -1.6], [0.48, 1.6], [0.64, -1.2], [0.8, 0.8], [1.05, 0], [1.4, 0]],
      ShoulderY: [[0, 0], [0.2, -2.2], [1.05, -2.2], [1.4, 0]],
      RArm: [[0, 0], [0.22, 0.35], [0.5, 0.42], [1.05, 0.35], [1.4, 0]],
      LArm: [[0, 0], [0.22, 0.35], [0.5, 0.42], [1.05, 0.35], [1.4, 0]],
      RForearm: [[0, 0], [0.24, 0.3], [1.05, 0.3], [1.4, 0]],
      LForearm: [[0, 0], [0.24, 0.3], [1.05, 0.3], [1.4, 0]],
    },
  },

  thinking: {
    label: '思考',
    tag: 'thinking',
    duration: 2.2,
    gesture: 'Movement3',
    tracks: {
      Movement3: [[0, 0], [0.4, 1], [1.7, 1], [2.2, 0]],
      AngleX: [[0, 0], [0.42, -4], [1.7, -4], [2.2, 0]],
      AngleY: [[0, 0], [0.42, 3], [1.7, 3], [2.2, 0]],
      AngleZ: [[0, 0], [0.45, -6], [1.25, -6], [1.7, -3], [2.2, 0]],
      ParamEyeBallX: [[0, 0], [0.45, -0.28], [1.7, -0.28], [2.2, 0]],
      ParamEyeBallY: [[0, 0], [0.45, 0.3], [1.7, 0.3], [2.2, 0]],
      RArm: [[0, 0], [0.42, 0.45], [1.7, 0.45], [2.2, 0]],
      RForearm: [[0, 0], [0.45, 0.35], [1.7, 0.35], [2.2, 0]],
    },
  },

  stretch: {
    label: '伸懒腰',
    tag: 'stretch',
    duration: 2.3,
    tracks: {
      AngleY: [[0, 0], [0.45, 8], [1.4, 8], [1.9, 2], [2.3, 0]],
      AngleZ: [[0, 0], [0.45, 3], [1.4, 3], [2.3, 0]],
      ParamBodyAngleRX: [[0, 0], [0.45, 2.5], [1.4, 2.5], [2.3, 0]],
      ShoulderY: [[0, 0], [0.45, 3.2], [1.4, 3.2], [2.3, 0]],
      ShoulderZ: [[0, 0], [0.45, 2], [1.4, 2], [2.3, 0]],
      RArm: [[0, 0], [0.42, 0.8], [1.35, 0.8], [1.75, 0.5], [2.3, 0]],
      LArm: [[0, 0], [0.42, 0.8], [1.35, 0.8], [1.75, 0.5], [2.3, 0]],
      RForearm: [[0, 0], [0.46, 0.3], [1.35, 0.3], [2.3, 0]],
      LForearm: [[0, 0], [0.46, 0.3], [1.35, 0.3], [2.3, 0]],
    },
  },

  clap: {
    label: '鼓掌',
    tag: 'clap',
    duration: 1.35,
    tracks: {
      Param38: [[0, 0], [0.28, 1], [1.1, 1], [1.35, 0]],
      // 双手往中间合：左右同时开合三次
      RArm: [[0, 0], [0.28, 0.45], [0.36, 0.6], [0.44, 0.45], [0.52, 0.6], [0.6, 0.45], [0.68, 0.6], [0.76, 0.45], [0.86, 0.45], [1.35, 0]],
      LArm: [[0, 0], [0.28, 0.45], [0.36, 0.6], [0.44, 0.45], [0.52, 0.6], [0.6, 0.45], [0.68, 0.6], [0.76, 0.45], [0.86, 0.45], [1.35, 0]],
      RForearm: [[0, 0], [0.3, 0.4], [1.35, 0]],
      LForearm: [[0, 0], [0.3, 0.4], [1.35, 0]],
      AngleY: [[0, 0], [0.3, -3], [0.62, -1], [0.92, -3], [1.35, 0]],
      ShoulderY: [[0, 0], [0.3, 1.2], [0.92, 1.2], [1.35, 0]],
      ParamBodyAngleZ: [[0, 0], [0.3, 0.7], [0.62, -0.4], [0.92, 0.7], [1.35, 0]],
    },
  },


  // ── 派活状态用的内部动作（不出现在 UI 动作清单里，由 setWorkState 驱动）──────────
  // thinking / busy 是**循环**动作：首尾关键帧特意写成同一个值，播到结尾无缝接回开头；
  // done 是一次性的收尾（2.5 秒），播完由播放器自动把状态收回 idle。
  // 注意：手放胸前用 Movement2（抚胸），它是模型自带的手势开关，不是 C 的资产参数。
  'work-thinking': {
    label: '思考中',
    tag: 'work thinking',
    internal: true,
    loop: true,
    duration: 6,
    work: 'thinking',
    tracks: {
      Movement2: [[0, 1], [0.6, 1], [5.4, 1], [6, 1]],            // 手一直放在胸前
      AngleX: [[0, 1.6], [3, 2.6], [6, 1.6]],                     // 头极慢地左右晃
      AngleY: [[0, -2.4], [2.1, -3.4], [4.2, -2.0], [6, -2.4]],   // 微微低头
      AngleZ: [[0, -3.6], [2.2, -5.0], [4.4, -2.8], [6, -3.6]],   // 歪着头
      ParamEyeBallX: [[0, -0.22], [3, -0.3], [6, -0.22]],         // 眼珠往斜上方（在回忆/推演）
      ParamEyeBallY: [[0, 0.28], [3, 0.36], [6, 0.28]],
      ParamBodyAngleRX: [[0, 1.2], [3, 2.2], [6, 1.2]],
      RArm: [[0, 0.28], [0.7, 0.36], [5.3, 0.3], [6, 0.28]],
      RForearm: [[0, 0.22], [0.7, 0.3], [5.3, 0.24], [6, 0.22]],
    },
  },

  'work-busy': {
    label: '干活中',
    tag: 'work busy',
    internal: true,
    loop: true,
    duration: 5,
    work: 'busy',
    tracks: {
      AngleX: [[0, 2.4], [2.5, 3.2], [5, 2.4]],                   // 头朝屏幕那一侧偏一点
      // 每 2 秒左右点一下头（-4.4° 的短促下压），表示"在处理"
      AngleY: [[0, -2.0], [0.95, -2.4], [1.15, -4.4], [1.4, -2.2], [2.6, -2.0], [3.1, -2.6], [3.3, -4.6], [3.55, -2.2], [5, -2.0]],
      AngleZ: [[0, -1.2], [2.5, -2.0], [5, -1.2]],
      ParamEyeBallX: [[0, 0.16], [1.7, 0.24], [3.2, 0.1], [5, 0.16]],
      ParamEyeBallY: [[0, -0.28], [2.4, -0.36], [5, -0.28]],      // 视线压在屏幕方向
      ParamBodyAngleRX: [[0, 1.6], [2.5, 2.4], [5, 1.6]],
      RArm: [[0, 0.1], [2.5, 0.16], [5, 0.1]],
      LArm: [[0, 0.08], [2.5, 0.14], [5, 0.08]],
    },
  },

  'work-done': {
    label: '搞定了',
    tag: 'work done',
    internal: true,
    duration: 2.5,
    work: 'done',
    tracks: {
      // 抬头 + 两下点头；小跳由 body-director 的 doneHop 负责（那是它管的 Position 通道）
      AngleY: [[0, 0], [0.18, 5], [0.42, -7], [0.66, 2], [0.88, -3], [1.2, 0], [2.5, 0]],
      AngleZ: [[0, 0], [0.3, 4], [0.75, -2], [1.2, 0], [2.5, 0]],
      ShoulderY: [[0, 0], [0.25, 2.4], [0.5, -1.2], [0.8, 1.6], [1.2, 0], [2.5, 0]],
      ShoulderZ: [[0, 0], [0.3, 1.4], [0.9, 0], [2.5, 0]],
      RArm: [[0, 0], [0.25, 0.4], [0.9, 0.25], [1.4, 0], [2.5, 0]],
      LArm: [[0, 0], [0.25, 0.4], [0.9, 0.25], [1.4, 0], [2.5, 0]],
      RForearm: [[0, 0], [0.3, 0.25], [1.2, 0], [2.5, 0]],
      LForearm: [[0, 0], [0.3, 0.25], [1.2, 0], [2.5, 0]],
      ParamBodyAngleRX: [[0, 0], [0.3, -2], [0.8, 0], [2.5, 0]],
    },
  },
};

/** 派活状态 → 内部动作 id */
export const WORK_ACTION_BY_STATE = { thinking: 'work-thinking', busy: 'work-busy', done: 'work-done' };
export const WORK_STATES = ['idle', 'thinking', 'busy', 'done'];

// ── 标签解析 ───────────────────────────────────────────────────────────────
// 同义词表：短语匹配（较长者优先），单词级歧义词只做「整串精确匹配」。
// 例如 "no" 只在标签就是 no 时才算摇头，不会把 "nod" 误判成摇头。
const PHRASES = [
  ['raise your hands', 'raise_your_hands'], ['raise both hands', 'raise_your_hands'],
  ['put your hands up', 'raise_your_hands'], ['raise your hand', 'raise_your_hands'],
  ['raise hands', 'raise_your_hands'], ['raise hand', 'raise_your_hands'],
  ['hands up', 'raise_your_hands'], ['hand up', 'raise_your_hands'], ['both hands up', 'raise_your_hands'],
  ['hands on your chest', 'hands_on_chest'], ['hands on chest', 'hands_on_chest'],
  ['hand on chest', 'hands_on_chest'], ['hands over heart', 'hands_on_chest'],
  ['hand over chest', 'hands_on_chest'], ['touch chest', 'hands_on_chest'], ['hands at chest', 'hands_on_chest'],
  ['nod your head', 'nod_head'], ['nod head', 'nod_head'], ['head nod', 'nod_head'], ['nodding', 'nod_head'],
  ['shake your head', 'shake_head'], ['shake head', 'shake_head'], ['head shake', 'shake_head'],
  ['tilt your head', 'tilt_head'], ['tilt head', 'tilt_head'], ['head tilt', 'tilt_head'], ['cock head', 'tilt_head'],
  ['take a bow', 'bow'], ['bow down', 'bow'], ['deep bow', 'bow'], ['bow your head', 'bow'],
  ['lean forward', 'lean_forward'], ['lean in', 'lean_forward'], ['lean closer', 'lean_forward'],
  ['forward lean', 'lean_forward'], ['lean toward', 'lean_forward'], ['lean towards', 'lean_forward'],
  ['point your finger', 'point'], ['point finger', 'point'], ['index finger', 'point'], ['point at', 'point'],
  ['shrug your shoulders', 'shrug'], ['shrug shoulders', 'shrug'],
  ['laugh out loud', 'laugh'], ['laughing', 'laugh'], ['giggle', 'laugh'], ['chuckle', 'laugh'],
  ['stretch your arms', 'stretch'], ['stretch arms', 'stretch'],
  ['clap your hands', 'clap'], ['clap hands', 'clap'], ['applause', 'clap'], ['clapping', 'clap'],
  ['wave your hand', 'wave'], ['wave hand', 'wave'], ['say hi', 'wave'], ['say hello', 'wave'],
  ['let me think', 'thinking'],
  // 单词
  ['wave', 'wave'], ['waving', 'wave'], ['hello', 'wave'], ['hi', 'wave'], ['greet', 'wave'], ['greeting', 'wave'],
  // 中文别名（UI 面板按钮、主进程消息可能会直接发中文标签）
  ['伸懒腰', 'stretch'], ['举双手', 'raise_your_hands'], ['高举双手', 'raise_your_hands'], ['举手', 'raise_your_hands'],
  ['抚胸', 'hands_on_chest'], ['手抚胸', 'hands_on_chest'], ['拍手', 'clap'], ['鼓掌', 'clap'],
  ['思考', 'thinking'], ['点头', 'nod_head'], ['摇头', 'shake_head'], ['歪头', 'tilt_head'],
  ['鞠躬', 'bow'], ['前倾', 'lean_forward'], ['耸肩', 'shrug'], ['生气', 'angry'], ['笑', 'laugh'],
  ['挥手', 'wave'], ['打招呼', 'wave'], ['指向', 'point'], ['指', 'point'],
  ['nod', 'nod_head'], ['shake', 'shake_head'], ['tilt', 'tilt_head'],
  ['bow', 'bow'], ['lean', 'lean_forward'], ['point', 'point'], ['pointing', 'point'],
  ['shrug', 'shrug'], ['laugh', 'laugh'], ['haha', 'laugh'],
  ['angry', 'angry'], ['mad', 'angry'], ['furious', 'angry'], ['grumpy', 'angry'], ['pout', 'angry'], ['cross', 'angry'],
  ['thinking', 'thinking'], ['think', 'thinking'], ['hmm', 'thinking'], ['ponder', 'thinking'], ['consider', 'thinking'],
  ['stretch', 'stretch'], ['yawn', 'stretch'],
  ['clap', 'clap'],
];
const EXACT_ALIASES = { no: 'shake_head', nope: 'shake_head', never: 'shake_head', yes: 'nod_head', yep: 'nod_head', sure: 'nod_head', ok: 'nod_head', okay: 'nod_head' };
// 渲染器的键名（wave / raise_your_hands ...）也要能直接当标签用
const CANONICAL = new Map(Object.entries(ACTIONS).map(([id, action]) => [action.tag, id]));

const PHRASE_TABLE = (() => {
  const rows = [...PHRASES];
  for (const [tag, id] of CANONICAL) rows.push([tag, id]);
  // 长短语优先，避免 'hi'/'wave' 抢走 'raise your hands' 这类长标签
  return rows.sort((a, b) => b[0].length - a[0].length);
})();

const CJK = /[㐀-鿿]/;
const SIDE_WORDS = { left: 'left', right: 'right' };
const STRONG_WORDS = ['strong', 'strongly', 'hard', 'big', 'excited', 'excitedly', 'energetic', 'energetically'];
const GENTLE_WORDS = ['gently', 'gentle', 'softly', 'slight', 'slightly', 'little', 'shy', 'shyly', 'timid', 'timidly'];
const FAST_WORDS = ['quickly', 'quick', 'fast', 'hurry', 'rapidly'];
const SLOW_WORDS = ['slowly', 'slow', 'lazily', 'relaxed'];

/** 去掉方括号 / 圆括号 / 引号 / 标点，压成小写单词串。单标签、英文、最多 120 字符。 */
export function normalizeTag(raw) {
  if (typeof raw !== 'string') return '';
  return raw.slice(0, MAX_TAG_LENGTH).toLowerCase()
    .replace(/[[\]【】()（）{}<>"'\u0060\u201c\u201d\u2018\u2019]/g, ' ')
    .replace(/[，,。.;；:：!！?？_\-—\/\\|+*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析一个动作标签。
 * 返回 { name, action, side, intensity, speed, phrase } 或 null。
 * "[wave right hand]" → { name:'wave', side:'right', ... }
 */
export function parseActionTag(raw) {
  const text = normalizeTag(raw);
  if (!text) return null;
  const words = text.split(' ');
  let name = EXACT_ALIASES[text] ?? '';
  let phrase = name ? text : '';
  if (!name) {
    for (const [candidate, id] of PHRASE_TABLE) {
      // 英文按单词边界匹配（避免 'hi' 命中 'this'、'no' 命中 'nod'）；中文直接子串匹配。
      const hit = CJK.test(candidate) ? text.indexOf(candidate) >= 0 : (' ' + text + ' ').indexOf(' ' + candidate + ' ') >= 0;
      if (hit) { phrase = candidate; name = id; break; }
    }
  }
  if (!name || !ACTIONS[name]) return null;
  let side = null;
  for (const word of words) if (SIDE_WORDS[word]) { side = SIDE_WORDS[word]; break; }
  let intensity = 1;
  if (words.some((w) => STRONG_WORDS.includes(w))) intensity = 1.3;
  else if (words.some((w) => GENTLE_WORDS.includes(w))) intensity = 0.65;
  let speed = 1;
  if (words.some((w) => FAST_WORDS.includes(w))) speed = 1.35;
  else if (words.some((w) => SLOW_WORDS.includes(w))) speed = 0.7;
  return { name, action: ACTIONS[name], side, intensity, speed, phrase };
}

/** 给 UI 用的动作清单（不含关键帧，也不含派活状态的内部动作）。 */
export function listActions() {
  return Object.entries(ACTIONS)
    .filter(([, action]) => !action.internal)
    .map(([id, action]) => ({ id, label: action.label, tag: action.tag, duration: action.duration, gesture: action.gesture ?? null }));
}

/** 判断某个标签是否被词典认识（UI 可以先校验再播）。 */
export function hasAction(raw) {
  return parseActionTag(raw) !== null;
}

// ── 播放器 ─────────────────────────────────────────────────────────────────
// 一帧只播一个动作；补偿量逐帧重算，动作结束自然归零，回待机不需要任何清理。
export class MotionDirector {
  constructor(options = {}) {
    this.timeScale = Number(options.timeScale) || 1;
    this.layer = { deltas: Object.create(null), post: Object.create(null), pinned: [] };
    this.action = null; this.name = ''; this.label = '';
    this.playhead = 0; this.envelope = 0; this.intensity = 1; this.side = null;
    // 这次动作正在驱动的参数集合：渲染层据此跳过 defaults 回写，
    // 免得动作里的瞬态手势值（Movement1/2/3…）被 captureAppearance 钉成新的「外观默认值」。
    this.claimedIds = new Set();
    // 派活状态（由渲染器 setWorkState 驱动）：idle / thinking / busy / done
    this.workState = 'idle';
    this.workStartAt = 0;
    // 状态变化回调：渲染器用它把 body-director 和 UI 一起切过去
    this.onWorkStateChange = null;
    this.serial = 1; this.lastTag = ''; this.lastError = '';
  }

  get playing() { return this.action !== null; }
  get progress() { return this.action ? clamp(this.playhead / this.action.duration, 0, 1) : 0; }

  /** 播一个动作（英文标签或规范名）。成功返回 true。 */
  play(tag, options = {}) {
    const parsed = parseActionTag(tag);
    if (!parsed) { this.lastError = '未知动作标签：' + String(tag).slice(0, MAX_TAG_LENGTH); return false; }
    this._begin(parsed.action, parsed.name, {
      side: parsed.side,
      intensity: parsed.intensity * (Number(options.intensity) || 1),
      speed: (Number(options.speed) || 1) * (parsed.speed || 1),
      tag,
    });
    return true;
  }

  // 真正把某个动作挂到播放头（play / 派活状态共用）。
  _begin(action, name, { side = null, intensity = 1, speed = 1, tag = '', internal = false } = {}) {
    this.action = action;
    this.name = name; this.label = action.label;
    this.side = side;
    this.intensity = clamp(intensity, 0.2, 1.6);
    this.timeScale = clamp(speed, 0.4, 2);
    this.playhead = 0; this.actionAge = 0; this.envelope = 0; this.stopAge = null; this.serial += 1;
    this.lastTag = normalizeTag(tag || action.tag); this.lastError = '';
    this.internal = !!internal || !!action.internal;
    const useSide = action.sides ? (side ?? action.defaultSide ?? 'right') : null;
    const claimed = new Set(Object.keys(action.tracks));
    if (useSide && action.sides?.[useSide]) for (const id of Object.keys(action.sides[useSide])) claimed.add(id);
    if (action.gesture) for (const id of MOVEMENT_PARAMS) claimed.add(id);
    this.claimedIds = claimed;
  }

  /**
   * 派活状态：idle | thinking | busy | done。
   * 主进程在 /dispatch 前后调：thinking（接活）→ busy（干活，可选）→ done（交差，2.5 秒后自动回 idle）。
   * thinking / busy 是循环动作；中途点 UI 动作会临时盖住，播完自动接回工作循环。
   */
  setWorkState(state) {
    const next = WORK_STATES.includes(state) ? state : 'idle';
    if (next === this.workState) return next;
    this.workState = next;
    this.workStartAt = this.clock || 0;
    if (next === 'idle') {
      // 收回工作循环：如果当前播的正是内部动作，走 200ms 淡出
      if (this.action && this.action.internal) this.stop(FADE_OUT);
    } else {
      this._startWorkAction(next);
    }
    if (typeof this.onWorkStateChange === 'function') this.onWorkStateChange(next);
    return next;
  }

  // 起一个派活循环动作（thinking / busy / done）
  _startWorkAction(state) {
    const id = WORK_ACTION_BY_STATE[state];
    const action = ACTIONS[id];
    if (!action) return false;
    this._begin(action, id, { tag: action.tag, internal: true });
    return true;
  }

  /** 提前收尾：一次性动作跳到淡出段起点；循环动作（派活状态）记一个收尾时刻，200ms 淡出后结束。 */
  stop(fade = FADE_OUT) {
    if (!this.action) return false;
    const tail = Math.max(0.05, fade);
    if (this.action.loop) { this.stopAge = this.actionAge; this.stopFade = tail; }
    else this.playhead = Math.max(this.playhead, this.action.duration - tail);
    return true;
  }

  /** 立刻清空（切场景 / 释放时用）。 */
  reset() {
    this.action = null; this.playhead = 0; this.envelope = 0; this.name = ''; this.label = ''; this.side = null;
    this.claimedIds = new Set(); this.internal = false;
    // 重置时把派活状态一起收回 idle，避免下一个人拿到一个"还在上班"的皮套
    if (this.workState !== 'idle') {
      this.workState = 'idle';
      if (typeof this.onWorkStateChange === 'function') this.onWorkStateChange('idle');
    }
    const layer = this.layer;
    for (const id in layer.deltas) delete layer.deltas[id];
    for (const id in layer.post) delete layer.post[id];
    layer.pinned.length = 0;
  }

  /**
   * 取这一帧的补偿量。
   * 返回的 layer 对象是复用的：
   *   { deltas: {物理输入参数: 补偿量}, post: {物理输出参数: 补偿量}, pinned: ['Movement1', ...] }
   */
  sample({ delta = 0.016 } = {}) {
    const layer = this.layer;
    for (const id in layer.deltas) delete layer.deltas[id];
    for (const id in layer.post) delete layer.post[id];
    layer.pinned.length = 0;
    const action = this.action;
    if (!action) { this.envelope = 0; return layer; }
    const step = clamp(delta, 0, 0.1);
    this.clock = (this.clock || 0) + step;
    this.playhead += step * this.timeScale;
    // 动作总时长（不随循环回绕）：淡入只做一次，循环动作才不会每圈闪一下
    this.actionAge = (this.actionAge || 0) + step * this.timeScale;
    const duration = action.duration;
    const loop = action.loop === true;
    if (this.playhead >= duration) {
      if (loop) {
        // 循环动作（派活状态）：回绕到开头。关键帧首尾写成同一个值，接缝是连续的。
        this.playhead -= duration * Math.floor(this.playhead / duration);
      } else {
        // 一次性动作播完：done 收尾回 idle；如果被 UI 动作临时盖住，这里把工作循环接回来。
        const finished = action;
        this.action = null; this.name = ''; this.label = ''; this.envelope = 0; this.claimedIds = new Set(); this.internal = !!finished.internal;
        if (finished.work === 'done') this.setWorkState('idle');
        else if (!finished.internal && this.workState !== 'idle') this._startWorkAction(this.workState);
        return layer;
      }
    }
    const t = this.playhead;
    // 120ms 淡入（按动作总时长算，循环动作只在最开始淡入一次）；
    // 一次性动作再加 200ms 淡出；循环动作没有淡出段（否则每一圈都会"闪"一下）。
    this.envelope = smooth(clamp(this.actionAge / FADE_IN, 0, 1)) * (loop ? 1 : smooth(clamp((duration - t) / FADE_OUT, 0, 1))) * this.intensity;
    // 循环动作被 stop() 时补一段淡出，避免手势硬切
    if (this.stopAge !== null) {
      const k = smooth(clamp(1 - (this.actionAge - this.stopAge) / Math.max(0.05, this.stopFade || FADE_OUT), 0, 1));
      this.envelope *= k;
      if (k <= 0.001) {
        this.action = null; this.name = ''; this.label = ''; this.envelope = 0;
        this.claimedIds = new Set(); this.internal = false; this.stopAge = null;
        return layer;
      }
    }
    const gain = this.envelope;
    // 手势互斥：先把手势开关里另外两个置 0，再叠本动作的增量
    if (action.gesture) for (const id of MOVEMENT_PARAMS) if (id !== action.gesture) layer.pinned.push(id);
    const add = (tracks) => {
      for (const id in tracks) {
        const value = sampleTrack(tracks[id], t) * gain;
        if (Math.abs(value) < 1e-4) continue;
        const target = PHYSICS_INPUTS.has(id) ? layer.deltas : layer.post;
        target[id] = (target[id] ?? 0) + value;
      }
    };
    add(action.tracks);
    if (action.sides) add(action.sides[this.side ?? action.defaultSide ?? 'right'] ?? {});
    return layer;
  }

  snapshot() {
    return { name: this.name, label: this.label, progress: +this.progress.toFixed(3), envelope: +this.envelope.toFixed(3), playing: this.playing, serial: this.serial };
  }
}