import { startVtsServer } from './vts-server.mjs';
import { buildModelInfo } from './model-info.mjs';
const model = buildModelInfo();
console.log('[dev] params', model.parameters.length, 'expressions', model.expressions.length, 'hotkeys', model.hotkeys.length);
startVtsServer({ port: 8001, internalPort: 8102, model });
