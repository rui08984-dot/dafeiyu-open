#!/usr/bin/env node
/**
 * 皮套 bundle：构建 + 部署一步到位。
 *
 * 为什么需要它（2026-11-08 血的教训）：
 *   build-petbody.mjs 输出到 pet-runtime/desktop/build/petbody.js，
 *   但运行时页面（_incoming/my-neuro/live-2d/index.html）加载的是
 *   live-2d/build/petbody.js —— 另一份副本。
 *   改了 desktop/ 下的源码、只跑 build-petbody，运行时永远吃旧包：
 *   表现就是「皮套/眼神/资产改了没反应」，查一整天都查不出原因。
 *
 * 用法：node build-and-deploy-petbody.mjs   （改完 desktop/** 必须跑这个）
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('./', import.meta.url));
const built = join(here, 'desktop', 'build', 'petbody.js');
const deployed = join(here, '..', '_incoming', 'my-neuro', 'live-2d', 'build', 'petbody.js');

console.log('[petbody] 构建…');
execFileSync(process.execPath, [join(here, 'build-petbody.mjs')], { stdio: 'inherit' });
if (!existsSync(built)) { console.error('[petbody] ✗ 构建产物不存在：' + built); process.exit(1); }

if (!existsSync(deployed)) { console.error('[petbody] ⚠ 运行时副本路径不存在：' + deployed); process.exit(1); }
copyFileSync(built, deployed);
const kb = (statSync(deployed).size / 1024).toFixed(0);
console.log('[petbody] ✓ 已部署到运行时：' + deployed + '（' + kb + ' KB）');
console.log('[petbody] 重启宿主后生效（皮套在渲染进程里，热重载不覆盖 bundle）');
