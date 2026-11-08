/**
 * @file scripts/testing/pdfjs-bidi-build.ts
 * 文件职责：构建时从锁定 PDF.js 原文件提取未改写的纯 bidi 模块，供隐藏搜索层做读回兼容性准入。
 * 不导入或启动 worker，不修改 node_modules，不生成字符串执行入口；升级上游必须重新复核全部摘要。
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Plugin} from 'vite';

export const PDF_READER_BIDI_ID = 'virtual:fluentread-pdfjs-bidi';
const RESOLVED_ID = `\0${PDF_READER_BIDI_ID}`;
const VERSION = '6.5.438';
const WORKER_SHA = '8336aabf764cb08c818555a2fd2545e4fed10837146de927564875c93b3c4f83';
const MODULE_SHA = '03f8324167fd1e03000c7214d4bacc673c56bff97169052f8ce42f450094fcc5';
const NOTICE_SHA = '93db28d6b86557c97d8320d1a317882c5a6f4f9862862412c6676e8a9ef76ca3';
const LICENSE_SHA = '0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594';
const START = ';// ./src/core/bidi.js\n';
const END = ';// ./src/core/font_substitutions.js';
const sha = (source: string) => createHash('sha256').update(source).digest('hex');

/** 原完整 Apache notice 与纯模块逐字保留；只追加受限输入的静态 ESM 导出。 */
export function createPdfReaderBidiModule(worker: string, version: string, license: string): string {
    if (version !== VERSION || sha(worker) !== WORKER_SHA || sha(license) !== LICENSE_SHA) {
        throw new Error('Unsupported PDF.js reader source: review bidi extraction before upgrading');
    }
    if (worker.split(START).length !== 2 || worker.split(END).length !== 2) {
        throw new Error('Missing or ambiguous PDF.js bidi module boundary');
    }
    const start = worker.indexOf(START), end = worker.indexOf(END);
    const original = worker.slice(start, end), notice = worker.slice(0, worker.indexOf('*/') + 2);
    if (end <= start || sha(original) !== MODULE_SHA || sha(notice) !== NOTICE_SHA) {
        throw new Error('Unsupported PDF.js bidi module or Apache notice');
    }
    // 受限的 ASCII/Hebrew 输入不会进入调用外部 warn() 的字形分类分支。
    return notice + '\n/* FluentRead: unchanged PDF.js 6.5.438 bidi kernel; static guarded export only. */\n'
        + original + '\nexport function projectPdfReaderBidi(text) {\n'
        + '  if (typeof text !== "string" || !text || text.length > 8192 || /[^\\x20-\\x7e\\u05d0-\\u05ea]/u.test(text)) return undefined;\n'
        + '  return bidi(text, -1, false);\n}\n';
}

/** 仅精确虚拟 ID 可加载；其余 SDK 导入、资源 URL 和第三方模块完全不变。 */
export function createPdfReaderBidiBuildPlugin(repositoryRoot: string) {
    return {
        name: 'fluentread-pinned-pdfjs-bidi',
        enforce: 'pre' as const,
        resolveId: (id: string) => id === PDF_READER_BIDI_ID ? RESOLVED_ID : null,
        load: (id: string) => {
            if (id !== RESOLVED_ID) return null;
            const packageRoot = resolve(repositoryRoot, 'node_modules/pdfjs-dist');
            const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {version?: string};
            return createPdfReaderBidiModule(readFileSync(resolve(packageRoot, 'legacy/build/pdf.worker.mjs'), 'utf8'),
                manifest.version ?? '', readFileSync(resolve(packageRoot, 'LICENSE'), 'utf8'));
        },
    } satisfies Plugin;
}
