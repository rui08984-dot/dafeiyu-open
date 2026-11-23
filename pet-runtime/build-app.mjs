import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('./desktop/', import.meta.url));
await build({
  entryPoints: [join(root, 'app.mjs')],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2020',
  outfile: join(root, 'build', 'app.js'), sourcemap: true, legalComments: 'eof',
  loader: { '.ts': 'ts' }, logLevel: 'warning',
});
console.log('built desktop/build/app.js');
