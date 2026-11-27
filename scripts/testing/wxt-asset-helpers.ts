/**
 * @file scripts/testing/wxt-asset-helpers.ts
 * 文件职责：封装 WXT 扩展构建中的产物打包收尾、Unicode 非字符转义、体积预算计算与静态公共资源收集逻辑。
 * 主要内容：
 * - 提供 `finalizeExtensionZip` 校验 Chrome ZIP 固定身份并清理旧命名包；
 * - 提供 `escapeExtensionNoncharacters` 插件在 chunk 写出前将 U+FFFE/U+FFFF 转为 ASCII 转义；
 * - 提供 `resolveExtensionBuildBudget` 按浏览器与开发/生产模式计算精确磁盘体积预算；
 * - 提供 `collectStaticExtensionPublicAssets` 收集第三方许可、语言包、PDF.js/wllama/Tesseract 静态资产。
 * 模块边界：纯构建期产物校验与静态资产清单模块，不负责 ONNX WASM 变体拼接或浏览器运行时逻辑。
 */
import fs from 'node:fs';
import {resolve} from 'node:path';
import JSZip from 'jszip';
import {createExtensionMetadataLocaleFiles} from '../../src/core/i18n/bundles';
import {createExtensionUiLanguageBundleFiles} from '../i18n/extensionLanguageBundles';
import {packageTesseractWasm, packageTesseractWorker, resolveTesseractSources} from '../wasm/package-diagnostics';
import {dictionaryScriptAssets} from './dictionary-script-build';
import {hypothesisAssets} from './hypothesis-assets';
import {PDFJS_DECODER_FILES} from './pdfjs-assets.mjs';
import {resolveOnnxWasmVariant} from './wxt-manifest-helpers';

export type ExtensionPublicAsset =
    | {absoluteSrc: string; relativeDest: string}
    | {relativeDest: string; contents: string};

/** Chrome 只交付保留固定身份的原 ZIP；验证成功后清理同版本旧商店包。 */
export async function finalizeExtensionZip(browser: string, zipPath: string): Promise<void> {
    if (browser !== 'chrome') return;
    if (!zipPath.endsWith('.zip')) throw new Error('Chrome 安装包路径必须以 .zip 结尾');
    const archive = await JSZip.loadAsync(fs.readFileSync(zipPath), {checkCRC32: true});
    const entry = archive.file('manifest.json');
    if (!entry) throw new Error('Chrome 安装包缺少 manifest.json');
    const manifest = JSON.parse(await entry.async('string'));
    if (typeof manifest.key !== 'string' || !manifest.key.trim()) {
        throw new Error('Chrome 安装包缺少固定扩展 ID 的 key');
    }
    // 只删除本次产物的确切旧命名，不扫描历史版本、其他浏览器或证据目录。
    fs.rmSync(`${zipPath.slice(0, -4)}-store.zip`, {force: true});
}

/**
 * Edge 的扩展内容脚本加载器会拒绝产物中的 Unicode 非字符 U+FFFE/U+FFFF，
 * 并把它们误报成“不是 UTF-8 编码”。部分第三方解析器会把源码中的转义
 * 序列展开成这些字符，因此在最终 JavaScript chunk 中重新写成 ASCII 转义，
 * 保持运行时值不变，同时避免扩展加载失败。
 */
export function escapeExtensionNoncharacters() {
    const escapeActualNoncharacters = (code: string) => code.replace(/[\uFFFE\uFFFF]/g, (character) => {
        const codePoint = character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
        return `\\u${codePoint}`;
    });

    return {
        name: 'escape-extension-noncharacters',
        generateBundle(_options: unknown, bundle: Record<string, {type: string; code?: string}>) {
            // 部分构建阶段会在 renderChunk 之后再次序列化字符串，因此在
            // 写入扩展目录前再检查一次最终 chunk，覆盖后台脚本等产物。
            for (const chunk of Object.values(bundle)) {
                if (chunk.type !== 'chunk' || chunk.code === undefined) continue;
                if (!chunk.code.includes('\uFFFE') && !chunk.code.includes('\uFFFF')) continue;

                const escaped = escapeActualNoncharacters(chunk.code);
                if (escaped !== chunk.code) chunk.code = escaped;
            }
        },
    };
}

/** 按目标浏览器与开发/生产模式计算与原 wxt.config.ts 完全一致的磁盘产物总预算（单位：字节）。 */
export function resolveExtensionBuildBudget(
    browser: string,
    dev: boolean,
    devSourcemaps = process.env.FLUENTREAD_DEV_SOURCEMAPS === '1',
): number {
    if (dev) {
        return devSourcemaps ? 170_000_000 : 70_000_000;
    }

    const isChromium = browser === 'chrome' || browser === 'edge';
    const baseBudget = (isChromium ? 66_327_000 : 66_125_000)
        + (browser === 'safari' ? 9_000 : 3_000) // domRuntimeBudget
        + 5_000 // webDavPathBudget
        + (isChromium ? 1_000 : 0) // lightColorRecognitionBudget
        + (isChromium ? 2_000 : 0) // connectedColorRecognitionBudget
        + 105_500; // imageFontBudget

    // MR 1（前两层瘦身）与 MR 2（JSPI 原生栈切换变体）收紧门槛锁住瘦身成果；其余各项保持按功能独立记账。
    const featureAdjustments = [
        -9_000_000, // deepSlimLayer1Layer2Savings
        resolveOnnxWasmVariant(browser) === 'jspi' ? -9_000_000 : 0, // deepSlimLayer3WasmSavings
        isChromium ? 171_000 : 26_000, // courseCaptionBudget
        isChromium ? 1_988_000 : 1_956_000, // youtubeEmbedBudget
        18_000, // aiPlatformDefaultRemovalBudget
        42_000, // sharedWhisperBudget
        16_000, // floatingLearningBudget
        2_000, // githubPullListHeadingBudget
        isChromium ? 1_000 : 0, // legacyTranslationTextBudget
        browser === 'edge' ? 0 : 1_000, // boundaryEmojiBudget
        12_000, // siteRuleEditorBudget
        1_000, // epubCoveragePreviewBudget
        30_000, // requestEvidenceBudget
        55_000, // documentFormatsBudget
        20_000, // pdfReadingToolsBudget
        298_000, // hypothesisClientBudget
        1_090_000, // dictionaryWorkspaceBudget
        55_000, // htmlMediaSubtitleBudget
        browser === 'chrome' ? 4_000 : 0, // translationPipelineBudget
        12_000, // pageRuleDiagnosisBudget
        26_000, // webArticleBudget
        214_000, // courseSubtitleLearningBudget
        4_000, // courseraCaptionBudget
        16_000, // documentGlossaryCandidateBudget
        isChromium ? 5_000 : 0, // rotatedLabelBudget
        isChromium ? 11_000 : 8_000, // imageOcrLanguageBudget
        1_500, // imageDirectionalRepairBudget
        600, // imageTextLocaleBudget
        1_200, // imageBoundarySamplingBudget
        1_650, // imageClippedSpacingBudget
        700, // imageSegmentationRetryBudget
        8_100, // imageClippedGlyphBudget
        60_000, // designSystemAndEfficiencyBudget
        45_000, // settingsCenterRefactorAndI18nBudget
    ];

    return featureAdjustments.reduce((total, delta) => total + delta, baseBudget);
}

const READING_ANNOTATION_NOTICES: readonly [string, string][] = [
    ['@faanau/kuromoji/LICENSE-2.0.txt', 'kuromoji-Apache-2.0.txt'],
    ['@faanau/kuromoji/NOTICE.md', 'kuromoji-NOTICE.md'],
    ['kuroshiro/LICENSE', 'kuroshiro-MIT.txt'],
    ['pinyin-pro/LICENSE', 'pinyin-pro-MIT.txt'],
    ['thai-rtgs/LICENSE', 'thai-rtgs-MIT.txt'],
];

const THIRD_PARTY_NOTICES: readonly [string, string][] = [
    ['@wllama/wllama/LICENCE', 'wllama-MIT.txt'],
    ['@noble/hashes/LICENSE', 'noble-hashes-MIT.txt'],
    ['pdfjs-dist/LICENSE', 'pdfjs-bidi-Apache-2.0.txt'],
    ['pdfjs-dist/cmaps/LICENSE', 'pdfjs-cmaps-Apache-2.0.txt'],
    ['pdfjs-dist/standard_fonts/LICENSE_FOXIT', 'pdfjs-foxit-BSD.txt'],
    ['pdfjs-dist/standard_fonts/LICENSE_LIBERATION', 'pdfjs-liberation-OFL.txt'],
    ['bidi-js/LICENSE.txt', 'bidi-js-MIT.txt'],
    ['ppu-paddle-ocr/LICENSE', 'ppu-paddle-ocr-MIT.txt'],
];

/** 收集除 ONNX 变体与 Safari 后台页外的全部扩展公共静态资源与第三方许可文件。 */
export function collectStaticExtensionPublicAssets(projectRoot: string): ExtensionPublicAsset[] {
    const files: ExtensionPublicAsset[] = [
        ...hypothesisAssets(projectRoot),
        ...dictionaryScriptAssets(projectRoot),
        // 仅保留本地算法的许可；日语词典与印地语语言数据首次使用时下载校验并缓存。
        ...READING_ANNOTATION_NOTICES.map(([source, destination]) => ({
            absoluteSrc: resolve(projectRoot, 'node_modules', source),
            relativeDest: `third-party-notices/${destination}`,
        })),
        // 非中文界面文案：en-US 保持完整本地文件，其余五语按固定远程基线生成紧凑 delta-v1 增量包，运行时经国内外多镜像校验并缓存基线后无损合并。
        ...createExtensionUiLanguageBundleFiles(projectRoot),
        // 安装名称、功能说明和工具栏提示由浏览器按界面语言解析，复用七语资源。
        ...createExtensionMetadataLocaleFiles(),
        ...THIRD_PARTY_NOTICES.map(([source, destination]) => ({
            absoluteSrc: resolve(projectRoot, 'node_modules', source),
            relativeDest: `third-party-notices/${destination}`,
        })),
        ...PDFJS_DECODER_FILES.map((file) => ({
            absoluteSrc: resolve(projectRoot, 'node_modules/pdfjs-dist/wasm', file),
            relativeDest: `pdfjs/wasm/${file}`,
        })),
        {
            absoluteSrc: resolve(fs.realpathSync(resolve(projectRoot, 'node_modules/ppu-paddle-ocr')), '../ppu-ocv/LICENSE'),
            relativeDest: 'third-party-notices/ppu-ocv-MIT.txt',
        },
        {
            absoluteSrc: resolve(projectRoot, 'node_modules/@wllama/wllama/esm/wasm/wllama.wasm'),
            relativeDest: 'fluent-read-ai/wllama.wasm',
        },
    ];

    const ocrSources = resolveTesseractSources(projectRoot);
    const packagedOcr = packageTesseractWasm(projectRoot, ocrSources.glue);
    files.push(
        {absoluteSrc: packagedOcr.glue, relativeDest: 'fluent-read-ocr/core/tesseract-core-simd-lstm.wasm.js'},
        {absoluteSrc: packagedOcr.wasm, relativeDest: 'fluent-read-ocr/core/tesseract-core-simd-lstm.wasm'},
        {absoluteSrc: packageTesseractWorker(projectRoot, ocrSources.worker), relativeDest: 'fluent-read-ocr/worker/worker.min.js'},
        {absoluteSrc: resolve(projectRoot, 'node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt'), relativeDest: 'fluent-read-ocr/worker/worker.min.js.LICENSE.txt'},
        {absoluteSrc: resolve(projectRoot, 'node_modules/tesseract.js/LICENSE.md'), relativeDest: 'fluent-read-ocr/LICENSE.md'},
    );

    return files;
}
