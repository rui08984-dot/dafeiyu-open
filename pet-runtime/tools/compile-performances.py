#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把表演 plan（语义动作 IR）编译成参数轨道，供 petbody 运行时逐帧采样。

为什么是 Python 而不是 JS/Rust（2026-11-15 裁决，有实测数据）：
  - 编译是**离线一次性**：15 段共 200ms，单段 13ms。重写成 JS/Rust 收益为 0，
    而移植 294 行编译器（含物理输出拦截/冲突校验/范围钳制/11 种动作算法）会引入新 bug。
  - 运行时的**每帧采样**实测 0.0305ms（617 轨），留在渲染进程内 JS 即可；
    跨进程搬 Rust 反而是 1.5-3ms 往返，延迟放大 50-100 倍。
  - 所以：Python 负责「算得对」，JS 负责「传得快」。

编译器本体不复制到本仓库，直接复用 _research/jingyu/compiler.py（同源上游，只读引用）。
模型元数据（509 参数 / 292 物理输出）由 compiler 自己从 core-inventory.json +
大肥鱼.physics3.json 读取，所以产物里已经保证：
  - 不会出现物理输出参数（作者物理控制，写不进去）
  - 所有值已钳到模型 min/max
  - 同一动作槽内同一参数冲突会直接报错，不会静默叠加

用法（Windows 用完整路径的 python.exe）：
  <user-home>/AppData/Local/Programs/Python/Python313/python.exe \
      pet-runtime/tools/compile-performances.py

产物：pet-runtime/desktop/choreo-performances.json
"""

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]          # pet-runtime/
REPO = ROOT.parent                                   # 仓库根
JINGYU = REPO / '_research' / 'jingyu'
MODEL_DIR = REPO / '皮套-大肥鱼公皮' / 'model'
OUT = ROOT / 'desktop' / 'choreo-performances.mjs'

# ── 通道分类 ────────────────────────────────────────────────────────────────
# 物理输入：写进 view.choreo（加法偏置），物理链会跟着算，头发/耳朵/裙摆自然甩动。
# 但要承受物理惯性（动作有 lag）——这是"自然"的代价，由 A/B 开关决定要不要额外写 ParamAngle*。
ANGLE_INPUT = {'AngleX', 'AngleY', 'AngleZ', 'PositionX', 'PositionY', 'PositionZ', 'LeanInput'}

# 其余全部走 override（绝对值 + 权重混合）：眼/嘴/眉/换装开关这类归一化参数
# 写加法会错（眨眼乘到 0 后 +1 = 睁眼，闭眼动作被取消），必须覆盖式。
def channel_of(pid: str) -> str:
    return 'angle' if pid in ANGLE_INPUT else 'override'


def main() -> int:
    if not JINGYU.is_dir():
        print(f'[error] 找不到编译器源码目录：{JINGYU}', file=sys.stderr)
        return 2
    if not MODEL_DIR.is_dir():
        print(f'[error] 找不到模型目录：{MODEL_DIR}', file=sys.stderr)
        return 2

    plans_dir = JINGYU / 'performances'
    plans = sorted(plans_dir.glob('*.json'))
    if len(plans) != 15:
        print(f'[warn] 预期 15 段，实际 {len(plans)} 段', file=sys.stderr)

    # compiler 通过 model_profile 读 L2D_MODEL_DIR（cdi3/Exp3/Animation/physics3）
    import os
    os.environ['L2D_MODEL_DIR'] = str(MODEL_DIR)
    sys.path.insert(0, str(JINGYU))
    import compiler  # noqa: E402  —— 只有设好 L2D_MODEL_DIR 才能 import 成功

    out = {
        'meta': {
            'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
            'compiler': f'{JINGYU.name}/compiler.py',
            'modelDir': str(MODEL_DIR.relative_to(REPO)).replace('\\', '/'),
            'note': '离线编译产物，勿手改；重跑 pet-runtime/tools/compile-performances.py 生成',
        },
        'performances': {},
    }

    t0 = time.perf_counter()
    total_tracks = total_points = 0
    for plan_path in plans:
        key = plan_path.stem
        plan = json.loads(plan_path.read_text(encoding='utf-8-sig'))
        compiled = compiler.compile_plan(plan)

        # 只保留纯语义轨道（owner='semantic'）。另两类本体就在仓里，走原生通道更准：
        #   native-gesture（122 轨）：写的是 Param36/39-43/56-62、Movement1-3 ——
        #     这些是作者手势 motion 的关节通道。若同时写轨道，会和 playMotion 的原生
        #     动画抢同一批参数（裁决 #6）。改成只下发 playMotion(组,0/1)。
        #   expression（34 轨）：写的是 Clothes*/key*/LeanInput —— 就是 exp3 的内容。
        #     轨道是 compiler 按 Add/Multiply/Overwrite 近似算出来的目标值，不如让
        #     SDK 的 ExpressionManager 直接应用 exp3（裁决 #4，走 manualFace）。
        dropped = {'native-gesture': 0, 'expression': 0, 'other': 0}
        tracks = []
        for tr in compiled['tracks']:
            owner = tr.get('owner', 'semantic')
            if owner != 'semantic':
                dropped[owner if owner in dropped else 'other'] += 1
                continue
            tracks.append({
                'id': tr['id'],
                'channel': channel_of(tr['id']),
                'start': tr['start'],
                'duration': tr['duration'],
                'points': tr['points'],          # [[t, v], ...] 相对轨道起点的绝对参数值
                'owner': tr.get('owner', 'semantic'),
                'label': tr.get('label', ''),
                'action': tr.get('action', 0),
            })
        total_tracks += len(tracks)
        total_points += sum(len(t['points']) for t in tracks)

        # 三类"不是轨道"的步骤：表情要锁脸、手势要播原生 motion、其余纯算法已进轨道
        expression_steps = [
            {'start': s['start'], 'duration': s['duration'], 'label': s['label'], 'index': s['index']}
            for s in compiled['steps'] if s['kind'] == 'expression'
        ]
        gesture_steps = [
            {'start': s['start'], 'duration': s['duration'], 'label': s['label'], 'index': s['index']}
            for s in compiled['steps'] if s['kind'] == 'gesture'
        ]
        # 手势/表情的原始参数补回来（steps 里只有 label，播放器需要名字与时长）
        # 手势：把作者 motion 的真实时长也带上 —— 播放器要在「进入动作播完」时
        #       再下发退出动作，早了会硬切、晚了会手一直举着。
        from model_profile import GESTURES, MOTIONS  # noqa: E402  （L2D_MODEL_DIR 已设）
        for s in expression_steps + gesture_steps:
            act = compiled['sourcePlan']['actions'][s['index']]
            s['kind'] = act.get('kind')
            if act.get('name'):
                s['name'] = act['name']
            if act.get('layer'):
                s['layer'] = act['layer']
        for s in gesture_steps:
            g = GESTURES.get(s.get('name'))
            if g:
                enter_d = float(MOTIONS[g['enter']]['Meta']['Duration'])
                exit_d = float(MOTIONS[g['exit']]['Meta']['Duration'])
                s['enterDuration'] = round(enter_d, 3)
                s['exitDuration'] = round(exit_d, 3)
                # 退出动作的开始时刻：在手势窗口结束前 exitDuration 秒
                s['exitAt'] = round(max(s['start'] + enter_d, s['start'] + s['duration'] - exit_d), 3)

        out['performances'][key] = {
            'title': plan.get('title') or plan.get('intent') or key,
            'intent': plan.get('intent', ''),
            'summary': plan.get('summary', ''),
            'duration': compiled['duration'],
            'tracks': tracks,
            'steps': compiled['steps'],
            'expressionSteps': expression_steps,
            'gestureSteps': gesture_steps,
            'droppedTracks': dropped,
            'warnings': compiled['warnings'],
        }

    elapsed = (time.perf_counter() - t0) * 1000
    dropped_total = {'native-gesture': 0, 'expression': 0, 'other': 0}
    for v in out['performances'].values():
        for k, n in v['droppedTracks'].items():
            dropped_total[k] += n
    out['meta']['stats'] = {
        'performances': len(out['performances']),
        'tracks': total_tracks,
        'points': total_points,
        'droppedTracks': dropped_total,
        'compileMs': round(elapsed, 1),
    }
    # 产物用 .mjs 而不是 .json：Node 的 ESM 对 JSON 需要 import attribute，
    # 而 esbuild 打包进渲染进程时又不能带 attribute —— 导出成模块两边都直接吃。
    body = json.dumps(out, ensure_ascii=False, separators=(',', ':'))
    OUT.write_text(
        '// 自动生成，勿手改。生成器：pet-runtime/tools/compile-performances.py\n'
        '// 内容 = 15 段表演的语义轨迹（461 轨）+ 表情/手势的一次性步骤。\n'
        f'export const CHOREO_DATA = {body};\n'
        'export default CHOREO_DATA;\n',
        encoding='utf-8')

    size_kb = OUT.stat().st_size / 1024
    print(f'[ok] {len(out["performances"])} 段 → {OUT}')
    print(f'     轨道 {total_tracks} / 关键帧 {total_points} / 编译 {elapsed:.0f}ms / 产物 {size_kb:.0f}KB')
    print(f'     让给原生通道：手势 {dropped_total["native-gesture"]} 轨（playMotion） / '
          f'表情 {dropped_total["expression"]} 轨（exp3）')
    for k, v in out['performances'].items():
        ch = {}
        for t in v['tracks']:
            ch[t['channel']] = ch.get(t['channel'], 0) + 1
        print(f'     {k:26s} {v["duration"]:5.1f}s  轨{len(v["tracks"]):3d} '
              f'(角度{ch.get("angle", 0)}/覆盖{ch.get("override", 0)})  '
              f'表情{len(v["expressionSteps"])} 手势{len(v["gestureSteps"])} 警告{len(v["warnings"])}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
