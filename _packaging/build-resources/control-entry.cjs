'use strict';
// control-entry.cjs —— 安装版入口分发（2026-11-26 安装包 A）
//
// 为什么需要：macOS/Windows 的 **packaged** Electron 固定加载 resources/app/package.json 的 main，
// 传一个脚本路径（electron control-main.js）在安装版里会被当成普通参数忽略 ——
// 实测：宿主调 openControlCenter() 后真的又起了一个桌宠实例（端口冲突 + 第二个皮套）。
//
// 所以安装版把 package.json.main 指向本文件：
//   · 带 --control-center → 只跑控制中心（control-main.js）
//   · 其它                → 正常宿主（main.js）
//
// 这个文件只在打包 staging 里存在（build-installer.ps1 写入）；源码树仍以 main.js 为入口，
// 开发时 electron . 与 openControlCenter() 的旧路径都不受影响。

if (process.argv.includes('--control-center')) {
    require('./control-main.js');
} else {
    require('./main.js');
}
