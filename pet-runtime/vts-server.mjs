/**
 * pet-runtime/vts-server.mjs —— **薄封装**（2026-11-17 六十五轮收敛）
 *
 * 为什么改成一行 re-export：
 *   这里原来是 326 行独立实现，与 `live-2d/petbridge/vts-server.mjs`（513 行）长期分叉：
 *   宿主编的那份加了 `/world`，standalone 没有；改 standalone 的功能，宿主又看不到。
 *   这类「两份实现」在架构总览里被列为风险 1（`docs/架构总览-2026-11-17.md`）。
 *   现在**只有一份实现**：独立 pet-runtime 宿主（electron-main.mjs / serve-dev.mjs）
 *   直接复用宿主那份。
 *
 * 为什么可以这样：宿主那份只依赖 `ws` + `./render-liveness.js` + `./dsh-dispatch.mjs`，
 *   都能在 live-2d/node_modules 与 petbridge/ 里解析，**不需要 Electron**。
 *
 * 失败模式（故意的）：如果哪天 `_incoming/my-neuro/live-2d` 被移走或不再存在，
 *   这里会**立即 import 报错** —— 比静默跑一份过期的旧实现好得多。
 *
 * 验收：`_probe/vts-server-single-source.mjs`（断言两边是同一个函数 + 能在备用端口真起来）
 */
export { startVtsServer } from '../_incoming/my-neuro/live-2d/petbridge/vts-server.mjs';
