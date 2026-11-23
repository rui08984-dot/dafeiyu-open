import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('./desktop/', import.meta.url));
const out = process.env.PETBODY_OUT || join(root, 'build', 'petbody.js');
await build({
  entryPoints: [join(root, 'petbody-entry.mjs')],
  bundle: true, format: 'iife', globalName: 'PetBody', platform: 'browser', target: 'es2020',
  // 2026-11-17：FACS 片段（LumenAct）需要在运行时读 pet-runtime/data/facs-clips/*.json，
  // 走 Electron 渲染层的 require('fs')。这里把 node 内置模块标成 external —— 打包时
  // 保留 `require("fs")` 原样，运行时由宿主页的 node 环境提供；
  // 纯浏览器里没有 require，调用方会拿到 {available:false}（entry 里 try/catch 兜住）。
  // node:http/node:module 同理：语义客户端（lumen-semantic-client.cjs）在运行时发 HTTP
  external: ['fs', 'path', 'node:http', 'node:module', 'http', 'module'],
  outfile: out, legalComments: 'eof', loader: { '.ts': 'ts' }, logLevel: 'warning',
});
console.log('petbody bundle ->', out);
