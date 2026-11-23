// param-commit.mjs —— 目标参数集合的「两段提交」（P1-6 的骨架，2026-11-12）
//
// 为什么必须分两段（影子比对实测得出，不是猜的）：
//   渲染器每帧会写 30 个参数，其中 11 个（ParamBreath / PositionX/Y/Z / AngleX/Y/Z /
//   ParamBodyAngleZ/X / LeanInput …）是 pet.physics3.json 的 **Input**，
//   写进去之后物理链会重算覆盖。实测意图值 -0.68 → 最终值 -0.03，差一个量级。
//   所以把它们和普通参数放同一个 map、一次提交，等于「身体指令被物理吞掉」→ 僵住或抽搐。
//
// 本模块只做纯粹的分区与顺序，不碰渲染器；渲染层接它之前先由单测把语义钉死。

/**
 * 从 physics3.json 里抽出「物理输入」参数名的集合。
 * @param {object} physics physics3 json（顶层 PhysicsSettings）
 * @returns {Set<string>}
 */
export function physicsInputsOf(physics) {
  const out = new Set();
  const settings = (physics && physics.PhysicsSettings) || [];
  for (const s of settings) {
    for (const i of s.Input || []) {
      const id = i && i.Source && i.Source.Id;
      if (id) out.add(String(id));
    }
  }
  return out;
}

/**
 * 从 physics3.json 抽出「物理输出」参数名（这些会被物理链每帧覆盖）。
 * 影子比对里那 11 个「意图值 vs 最终值」对不上的，就是它们——**不要写**，
 * 或者写了也不要期待它能留住（典型：ParamBodyAngleZ 写 -0.68 最终 -0.03）。
 * @param {object} physics
 * @returns {Set<string>}
 */
export function physicsOutputsOf(physics) {
  const out = new Set();
  const settings = (physics && physics.PhysicsSettings) || [];
  for (const s of settings) {
    for (const o of s.Output || []) {
      const id = o && o.Destination && o.Destination.Id;
      if (id) out.add(String(id));
    }
  }
  return out;
}

/**
 * 把目标参数分成「物理前提交」与「物理后提交」两批。
 * @param {Map<string, number>|object} target 目标参数
 * @param {Set<string>} physicsInputs 物理输入集合
 * @returns {{ before: Array<[string, number]>, after: Array<[string, number]> }}
 */
export function partitionTarget(target, physicsInputs) {
  const before = [];
  const after = [];
  const entries = target instanceof Map ? [...target.entries()] : Object.entries(target || {});
  for (const [id, value] of entries) {
    if (!Number.isFinite(Number(value))) continue;
    (physicsInputs && physicsInputs.has(id) ? before : after).push([id, Number(value)]);
  }
  return { before, after };
}

/**
 * 按「物理前 → 物理后」执行提交。
 * applyFn(id, value) 由渲染层提供（内部就是 setParameterValueByIndex）。
 * 返回实际提交的数量，便于调用方做一致性断言。
 *
 * @param {{before:Array, after:Array}} parts
 * @param {(id:string, value:number)=>void} applyBefore 物理前应用（一般就是写入模型）
 * @param {() => void} runPhysics 物理重算（Cubism 的 _model.update 内部那一步，或整帧 update）
 * @param {(id:string, value:number)=>void} applyAfter 物理后应用
 */
export function commitInOrder(parts, applyBefore, runPhysics, applyAfter) {
  let n = 0;
  for (const [id, v] of parts.before) { applyBefore(id, v); n += 1; }
  if (typeof runPhysics === 'function') runPhysics();
  for (const [id, v] of parts.after) { applyAfter(id, v); n += 1; }
  return n;
}

/**
 * 从目标参数里挑出「物理会覆盖的」那部分（classify 结果为 both/output）。
 *
 * 用途（2026-11-21 P1 browDown）：ParamBrowLAngle/RAngle 是 pet.physics3.json 的
 * **Output**（Setting 39/41 每帧重算覆盖，Setting 42/43 再把它们当输入算 Shock）。
 * 只写 defaults = 物理前喂，物理算完就没了（实测意图 -0.68 最终 -0.03 那一类）。
 * 所以在「物理前喂」之外，还要在物理之后把这些值重放一遍 —— 就是本函数的产出。
 *
 * 为什么不用「改写到物理输出参数」：物理输出参数（ShockR/ShockL）不是眉毛角度本身，
 * 写到它们只会把眉毛和 Shock 链解开，表现更不可控。两段提交才是语义正确的做法。
 *
 * @param {Map<string, number>|object} target
 * @param {(id:string)=>string} classify classifyParam('input'|'output'|'both'|'plain')
 * @returns {Array<[string, number]>}
 */
export function selectPhysicsOutputTargets(target, classify) {
  const out = [];
  if (typeof classify !== 'function') return out;
  const entries = target instanceof Map ? [...target.entries()] : Object.entries(target || {});
  for (const [id, value] of entries) {
    const v = Number(value);
    if (!Number.isFinite(v)) continue;
    const kind = classify(id);
    if (kind === 'both' || kind === 'output') out.push([id, v]);
  }
  return out;
}

/**
 * 一致性比对：意图值 vs 最终值。用于影子模式验证「重构前后输出是否等价」。
 * @param {Map<string,number>|object} target
 * @param {(id:string)=>number} readFinal
 * @param {number} [epsilon]
 * @returns {{same:number, diverge:Array<{id:string,want:number,got:number}>}}
 */
export function compareTarget(target, readFinal, epsilon = 1e-6) {
  const entries = target instanceof Map ? [...target.entries()] : Object.entries(target || {});
  let same = 0;
  const diverge = [];
  for (const [id, want0] of entries) {
    const want = Number(want0);
    const got = Number(readFinal(id));
    if (!Number.isFinite(got)) continue;
    if (Math.abs(got - want) <= epsilon) same += 1;
    else diverge.push({ id, want: Math.round(want * 1000) / 1000, got: Math.round(got * 1000) / 1000 });
  }
  return { same, diverge };
}
