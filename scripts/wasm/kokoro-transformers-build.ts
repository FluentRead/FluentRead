/**
 * @file scripts/wasm/kokoro-transformers-build.ts
 * 文件职责：为本地 Kokoro TTS Worker 提供按需模块化的 `@huggingface/transformers-kokoro`（4.2.0）构建入口。
 * 主要内容：
 * - 将 `@huggingface/transformers-kokoro` 与 `@uzen/kokoro-js` 内部的 `@huggingface/transformers` 统一解析到同一虚拟入口，保证 `env` 单例一致；
 * - 直接从上游锁定版本 `src/` 装配 Kokoro 实际使用的 5 个导出（`StyleTextToSpeech2Model`、`AutoTokenizer`、`Tensor`、`RawAudio`、`env`），并注册 `StyleTextToSpeech2Model` 映射，避免把 200+ 个无关视觉/语音/LLM 架构与 `@huggingface/jinja` 模板引擎打进 `localTtsWorker.js`；
 * - 仅为 `@huggingface/transformers@4.2.0/src/` 内部提供与上游 `dist/transformers.web.js` 一致的 Node 内置与 `onnxruntime-node` 浏览器空桩。
 * 模块边界：纯构建期 Vite/Rolldown 插件，不影响 `@huggingface/transformers` v3.8.1（本地翻译/视频转写/智能高亮 Worker）或运行时缓存与推理逻辑。
 */
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Plugin} from 'vite';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const EXPECTED_VERSION = '4.2.0';

const VIRTUAL_ENTRY_ID = '\0fluentread-kokoro-transformers-runtime';
const VIRTUAL_STUB_EMPTY = '\0fluentread-kokoro-stub:empty';
const VIRTUAL_STUB_STREAM = '\0fluentread-kokoro-stub:node-stream';
const VIRTUAL_STUB_STREAM_PROMISES = '\0fluentread-kokoro-stub:node-stream-promises';
const VIRTUAL_STUB_JINJA = '\0fluentread-kokoro-stub:jinja';

const REQUIRED_SOURCE_FILES = [
    'env.js',
    'models/modeling_utils.js',
    'models/style_text_to_speech_2/modeling_style_text_to_speech_2.js',
    'models/auto/tokenization_auto.js',
    'utils/tensor.js',
    'utils/audio.js',
] as const;

const EMPTY_STUB_SPECIFIERS = new Set([
    'node:fs',
    'node:path',
    'node:url',
    'onnxruntime-node',
]);

function normalizePath(filePath: string): string {
    return filePath.split('?')[0]!.replace(/\\/g, '/');
}

function isKokoroJsImporter(importer: string | undefined): boolean {
    if (!importer) return false;
    const normalized = normalizePath(importer);
    return normalized.includes('/@uzen/kokoro-js/') || normalized.includes('/@uzen+kokoro-js@');
}

function resolveKokoroTransformersSrc(projectRoot: string): {
    readonly realSrcDir: string;
    readonly srcPrefixes: readonly string[];
} {
    const require = createRequire(resolve(projectRoot, 'package.json'));
    const entryPath = require.resolve('@huggingface/transformers-kokoro');
    const packageRoot = dirname(dirname(entryPath));
    const packageJsonPath = resolve(packageRoot, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {version?: unknown};
    if (packageJson.version !== EXPECTED_VERSION) {
        throw new Error(
            `Unsupported @huggingface/transformers-kokoro version ${String(packageJson.version)} (expected ${EXPECTED_VERSION}): review modular Kokoro build entry`,
        );
    }

    const srcDir = resolve(packageRoot, 'src');
    const realSrcDir = fs.realpathSync(srcDir);
    for (const rel of REQUIRED_SOURCE_FILES) {
        const target = resolve(realSrcDir, rel);
        if (!fs.existsSync(target)) {
            throw new Error(`Missing required @huggingface/transformers-kokoro source file: ${rel}`);
        }
    }

    const prefixes = new Set<string>([
        `${normalizePath(srcDir)}/`,
        `${normalizePath(realSrcDir)}/`,
    ]);
    return {realSrcDir, srcPrefixes: [...prefixes]};
}

function buildModularEntryCode(realSrcDir: string): string {
    const srcImport = (rel: string): string => JSON.stringify(normalizePath(resolve(realSrcDir, rel)));
    return [
        `import {env} from ${srcImport('env.js')};`,
        `import {`,
        `    MODEL_CLASS_TO_NAME_MAPPING,`,
        `    MODEL_NAME_TO_CLASS_MAPPING,`,
        `    MODEL_TYPE_MAPPING,`,
        `    MODEL_TYPES,`,
        `    PreTrainedModel,`,
        `    registerTaskMappings,`,
        `} from ${srcImport('models/modeling_utils.js')};`,
        `import {StyleTextToSpeech2Model} from ${srcImport('models/style_text_to_speech_2/modeling_style_text_to_speech_2.js')};`,
        `import {AutoTokenizer} from ${srcImport('models/auto/tokenization_auto.js')};`,
        `import {Tensor} from ${srcImport('utils/tensor.js')};`,
        `import {RawAudio} from ${srcImport('utils/audio.js')};`,
        ``,
        `const styleTtsMapping = new Map([['style_text_to_speech_2', 'StyleTextToSpeech2Model']]);`,
        `MODEL_TYPE_MAPPING.set('StyleTextToSpeech2Model', MODEL_TYPES.EncoderOnly);`,
        `MODEL_CLASS_TO_NAME_MAPPING.set(StyleTextToSpeech2Model, 'StyleTextToSpeech2Model');`,
        `MODEL_NAME_TO_CLASS_MAPPING.set('StyleTextToSpeech2Model', StyleTextToSpeech2Model);`,
        `MODEL_TYPE_MAPPING.set('PreTrainedModel', MODEL_TYPES.EncoderOnly);`,
        `MODEL_CLASS_TO_NAME_MAPPING.set(PreTrainedModel, 'PreTrainedModel');`,
        `registerTaskMappings({`,
        `    MODEL_MAPPING_NAMES_ENCODER_ONLY: styleTtsMapping,`,
        `    MODEL_FOR_CAUSAL_LM_MAPPING_NAMES: new Map(),`,
        `    MODEL_FOR_VISION_2_SEQ_MAPPING_NAMES: new Map(),`,
        `    MODEL_FOR_SEQ_TO_SEQ_CAUSAL_LM_MAPPING_NAMES: new Map(),`,
        `    MODEL_FOR_SPEECH_SEQ_2_SEQ_MAPPING_NAMES: new Map(),`,
        `});`,
        ``,
        `export {AutoTokenizer, RawAudio, StyleTextToSpeech2Model, Tensor, env};`,
        ``,
    ].join('\n');
}

/**
 * 为本地 Kokoro TTS 注入模块化 `@huggingface/transformers-kokoro` 入口，
 * 避免打入 200+ 个无关模型架构、图像/视频处理器与 Jinja 聊天模板引擎。
 */
export function kokoroTransformersBuildPlugin(projectRoot = PROJECT_ROOT): Plugin {
    const {realSrcDir, srcPrefixes} = resolveKokoroTransformersSrc(projectRoot);
    const entryCode = buildModularEntryCode(realSrcDir);
    const isInsideKokoroTransformersSrc = (importer: string | undefined): boolean => {
        if (!importer) return false;
        const normalized = normalizePath(importer);
        return srcPrefixes.some((prefix) => normalized.startsWith(prefix));
    };

    return {
        name: 'fluentread-kokoro-transformers',
        enforce: 'pre',
        resolveId(source, importer) {
            if (source === '@huggingface/transformers-kokoro') {
                return VIRTUAL_ENTRY_ID;
            }
            if (source === '@huggingface/transformers' && isKokoroJsImporter(importer)) {
                return VIRTUAL_ENTRY_ID;
            }
            if (!isInsideKokoroTransformersSrc(importer)) return null;
            if (EMPTY_STUB_SPECIFIERS.has(source)) return VIRTUAL_STUB_EMPTY;
            if (source === 'node:stream') return VIRTUAL_STUB_STREAM;
            if (source === 'node:stream/promises') return VIRTUAL_STUB_STREAM_PROMISES;
            if (source === '@huggingface/jinja') return VIRTUAL_STUB_JINJA;
            return null;
        },
        load(id) {
            if (id === VIRTUAL_ENTRY_ID) return entryCode;
            if (id === VIRTUAL_STUB_EMPTY) return 'export default {};\n';
            if (id === VIRTUAL_STUB_STREAM) {
                return 'const noop = () => {};\nexport const Readable = {fromWeb: noop};\nexport default {Readable};\n';
            }
            if (id === VIRTUAL_STUB_STREAM_PROMISES) {
                return 'const noop = () => {};\nexport const pipeline = noop;\nexport default {pipeline};\n';
            }
            if (id === VIRTUAL_STUB_JINJA) {
                return 'export class Template { constructor() { throw new Error("Chat templates are not bundled in the Kokoro TTS runtime."); } }\n';
            }
            return null;
        },
    };
}
