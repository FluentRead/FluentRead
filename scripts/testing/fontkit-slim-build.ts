/**
 * @file scripts/testing/fontkit-slim-build.ts
 * 文件职责：在构建副本中裁剪锁定版本 @pdf-lib/fontkit 内嵌 iconv-lite 未使用的传统 DBCS/SBCS 代码页、UTF-7 编解码器与 Node 专用扩展，显著降低 PDF 导出块体积。
 * 主要内容：同时锁定原始 fontkit.es.js 与扩展 CSP 适配后副本的 SHA-256，保留 OpenType/WOFF2/TTF/OTF 解析、Brotli 解压、全部排版塑形器、子集编码以及 UTF-8/UTF-16/Latin1/Windows-1252/Mac 系列单字节编码，仅移除不会触发的旧式双字节 CJK 代码页表、罕见单字节代码页表、UTF-7 和 Node 运行时钩子。
 * 模块边界：纯构建期 Vite/Rolldown 插件，只转换 @pdf-lib/fontkit@1.1.1 的 fontkit.es.js；不修改 node_modules 原文件，不触碰 CSP 补丁逻辑，上游变更时必须显式报错。
 */
import {createHash} from 'node:crypto';
import type {Plugin} from 'vite';

/** @pdf-lib/fontkit@1.1.1 原始 dist/fontkit.es.js 的完整摘要（与 extension-csp-build.ts 保持一致）。 */
export const FONTKIT_RAW_SHA256 = '62ad9c769e6a7a9028b0c711504908f0a231955b39619aaabd56dd4eabe800be';
/** 经 extensionCspBuildPlugin() 处理后的 dist/fontkit.es.js 摘要，允许本插件串联在 CSP 插件之后。 */
export const FONTKIT_CSP_PATCHED_SHA256 = '989595a4cd3fe7ba495f970672d86ca37c22594d134ccada5562209c94ee312f';

const ACCEPTED_FONTKIT_SHA256 = new Set<string>([FONTKIT_RAW_SHA256, FONTKIT_CSP_PATCHED_SHA256]);

const MARKER_UTF7_START = 'var Buffer$3 = safer_1.Buffer; // UTF-7 codec, according to https://tools.ietf.org/html/rfc2152';
const MARKER_SBCS_START = 'var Buffer$4 = safer_1.Buffer; // Single-byte codec.';
const MARKER_SBCS_DATA_START = 'var sbcsData = {';
const MARKER_SBCS_GENERATED_START = 'var sbcsDataGenerated = {';
const MARKER_DBCS_START = 'var Buffer$5 = safer_1.Buffer; // Multibyte codec.';
const MARKER_ENCODINGS_START = 'var encodings = createCommonjsModule(function (module, exports) {';
const MARKER_STREAMS_START = 'var Buffer$6 = buffer.Buffer,\n    Transform$1 = Stream.Transform;';
const MARKER_LIB_START = 'var lib = createCommonjsModule(function (module) {';

const ORIGINAL_MODULES_ARRAY = 'var modules = [internal, utf16, utf7, sbcsCodec, sbcsData, sbcsDataGenerated, dbcsCodec, dbcsData];';
const SLIM_MODULES_ARRAY = 'var modules = [internal, utf16, sbcsCodec, sbcsData, sbcsDataGenerated];';

const ORIGINAL_NODE_EXTENSIONS = [
    "  var nodeVer = typeof process !== 'undefined' && process.versions && process.versions.node;",
    '',
    '  if (nodeVer) {',
    '    // Load streaming support in Node v0.10+',
    '    var nodeVerArr = nodeVer.split(".").map(Number);',
    '',
    '    if (nodeVerArr[0] > 0 || nodeVerArr[1] >= 10) {',
    '      streams(iconv);',
    '    } // Load Node primitive extensions.',
    '',
    '',
    '    extendNode(iconv);',
    '  }',
].join('\n');

/**
 * 保留 fontkit 自身 ENCODINGS 与 MAC_LANGUAGE_ENCODINGS 映射表引用的全部单字节编码，
 * 以及常见 Latin1 / Windows-1252 / ASCII 编码；字面表直接从锁定上游切片提取，保证零抄写偏差。
 */
const RETAINED_SBCS_GENERATED_NAMES = [
    'windows1252',
    'iso88591',
    'iso88596',
    'iso88598',
    'maccroatian',
    'maccyrillic',
    'macgreek',
    'maciceland',
    'macroman',
    'macromania',
    'macthai',
    'macturkish',
    'macintosh',
    'ascii',
] as const;

function indexOfUnique(source: string, marker: string, label: string): number {
    const first = source.indexOf(marker);
    if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
        throw new Error(`Missing or ambiguous fontkit slim marker: ${label}`);
    }
    return first;
}

function replaceOnce(source: string, before: string, after: string, label: string): string {
    const index = indexOfUnique(source, before, label);
    return source.slice(0, index) + after + source.slice(index + before.length);
}

function extractSbcsEntry(section: string, name: string): string {
    const pattern = new RegExp(`  "${name}": \\{\\n    "type": "_sbcs",\\n    "chars": "[^\\n]*"\\n  \\}`, 'gu');
    const matches = [...section.matchAll(pattern)];
    if (matches.length !== 1) {
        throw new Error(`Missing or ambiguous fontkit SBCS table entry: ${name}`);
    }
    return matches[0]![0];
}

/** 执行固定标记与单字节表提取裁剪；缺失或重复标记时显式抛错。 */
export function applyFontkitSlimTransforms(source: string): string {
    const utf7Start = indexOfUnique(source, MARKER_UTF7_START, 'utf7-start');
    const sbcsStart = indexOfUnique(source, MARKER_SBCS_START, 'sbcs-start');
    const sbcsDataStart = indexOfUnique(source, MARKER_SBCS_DATA_START, 'sbcs-data-start');
    const sbcsGeneratedStart = indexOfUnique(source, MARKER_SBCS_GENERATED_START, 'sbcs-generated-start');
    const dbcsStart = indexOfUnique(source, MARKER_DBCS_START, 'dbcs-start');
    const encodingsStart = indexOfUnique(source, MARKER_ENCODINGS_START, 'encodings-start');
    const streamsStart = indexOfUnique(source, MARKER_STREAMS_START, 'streams-start');
    const libStart = indexOfUnique(source, MARKER_LIB_START, 'lib-start');

    const sbcsDataSection = source.slice(sbcsDataStart, sbcsGeneratedStart);
    const sbcsGeneratedSection = source.slice(sbcsGeneratedStart, dbcsStart);

    const macCentEuroEntry = extractSbcsEntry(sbcsDataSection, 'maccenteuro');
    const retainedGeneratedEntries = RETAINED_SBCS_GENERATED_NAMES.map(name => extractSbcsEntry(sbcsGeneratedSection, name));

    const slimSbcsData = [
        'var sbcsData = {',
        '  "10029": "maccenteuro",',
        `${macCentEuroEntry},`,
        '  "ascii8bit": "ascii",',
        '  "usascii": "ascii",',
        '  "latin1": "iso88591",',
        '  "10000": "macroman",',
        '  "10006": "macgreek",',
        '  "10007": "maccyrillic",',
        '  "10079": "maciceland",',
        '  "10081": "macturkish",',
        '  "1252": "windows1252",',
        '  "win1252": "windows1252",',
        '  "cp1252": "windows1252",',
        '  "msansi": "windows1252",',
        '  "mac": "macintosh",',
        '  "csmacintosh": "macintosh"',
        '};',
        '',
    ].join('\n');

    const slimSbcsGenerated = [
        'var sbcsDataGenerated = {',
        retainedGeneratedEntries.join(',\n'),
        '};',
        '',
    ].join('\n');

    const encodingsSection = replaceOnce(
        source.slice(encodingsStart, streamsStart),
        ORIGINAL_MODULES_ARRAY,
        SLIM_MODULES_ARRAY,
        'encodings-modules',
    );
    const libTail = replaceOnce(
        source.slice(libStart),
        ORIGINAL_NODE_EXTENSIONS,
        '',
        'iconv-node-extensions',
    );

    return source.slice(0, utf7Start)
        + source.slice(sbcsStart, sbcsDataStart)
        + slimSbcsData
        + slimSbcsGenerated
        + encodingsSection
        + libTail;
}

/** 仅裁剪锁定版本 @pdf-lib/fontkit 内未使用的 iconv-lite 代码页与 Node 钩子。 */
export function slimFontkitSource(source: string): string {
    const sha256 = createHash('sha256').update(source).digest('hex');
    if (!ACCEPTED_FONTKIT_SHA256.has(sha256)) {
        throw new Error('Unsupported @pdf-lib/fontkit source: review fontkit slimming before upgrading');
    }
    return applyFontkitSlimTransforms(source);
}

/** WXT 生产构建插件：置于 extensionCspBuildPlugin 之后，仅转换 @pdf-lib/fontkit/dist/fontkit.es.js。 */
export function fontkitSlimBuildPlugin(): Plugin {
    return {
        name: 'fluentread-fontkit-slim',
        enforce: 'pre',
        apply: 'build',
        transform(source, id) {
            if (id.includes('\0') || id.includes('?')) return;
            const file = id.replace(/\\/gu, '/');
            if (!/(?:^|\/)@pdf-lib\/fontkit\/dist\/fontkit\.es\.js$/u.test(file)) return;
            return {code: slimFontkitSource(source), map: null};
        },
    };
}
