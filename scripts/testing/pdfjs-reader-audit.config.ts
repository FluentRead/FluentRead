/** 既有 Node 语料审计通过 Vite 加载唯一真实兼容性插件，不依赖 Node 原生 TypeScript 支持。 */
import {resolve} from 'node:path';
import {createPdfReaderBidiBuildPlugin} from './pdfjs-bidi-build';
export default {plugins: [createPdfReaderBidiBuildPlugin(resolve(__dirname, '../..'))]};
