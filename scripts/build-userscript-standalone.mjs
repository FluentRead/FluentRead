import {resolve} from 'node:path';
import {build} from 'vite-userscript';

process.env.FLUENTREAD_USERSCRIPT_STANDALONE = '1';
await build({configFile: resolve('userscript/vite.config.ts')});
