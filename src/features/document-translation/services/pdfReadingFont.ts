/**
 * @file src/features/document-translation/services/pdfReadingFont.ts
 * 文件职责：在首次导出可读 PDF 时按需取得开放字体，校验并缓存后嵌入可见文字及 Unicode 映射。
 * 主要内容：固定补充拉丁扩展、希腊文与数学符号后的字体版本、长度和 SHA-256，通过国内及全球数据源有界下载、超时回退与持久缓存；共享在途下载但独立处理各调用方取消。使用 pdf-lib 官方 fontkit 子集机制，提前拒绝仍未覆盖的字形；变体序列各用独立子集，避免与普通字符共用字形时覆盖 Unicode 映射。
 * 模块边界：属于文档二进制服务；远程仅下载无用户内容或凭据的字体数据，不执行远程 JS/WASM，不进入内容脚本字体或界面字体注册链路。不保存字体解析器或导出文档的全局引用。
 */
import type {PDFDocument, PDFFont, PDFPage, PDFPageDrawTextOptions} from 'pdf-lib';
import {isPdfReadingVariationSelector} from '../core/pdfTextLayout';
import {cancelUnreadResponseBody} from '@/src/platform/http/runtime';

export const PDF_READING_FONT_PATH = '/pdf-fonts/FluentReadNotoSansSC-Regular.woff2';
export const PDF_READING_FONT_BYTES = 5_112_688;
export const PDF_READING_FONT_SHA256 = '14703e46fadf7d61c61df0d476e3f9e7e8fadfdffec4188561d99142d0831cc0';
export const PDF_READING_FONT_REVISION = '59d3a2c9666b1a47afcf0fee762d36c7dae3b123';
export const PDF_READING_FONT_CACHE = 'fluentread-pdf-reading-font-v1';
export const PDF_READING_FONT_CACHE_KEY = `https://fluentread.app/__optional_assets__/pdf-font/${PDF_READING_FONT_SHA256}.woff2`;

/** 语言仅提供尝试顺序提示，不探测所在地；各来源必须返回同一固定版本的字体。 */
export function getPdfReadingFontSources(locale: string): string[] {
    const resource = `FluentRead/FluentRead@${PDF_READING_FONT_REVISION}/public${PDF_READING_FONT_PATH}`;
    const china = [`https://cdn.jsdmirror.com/gh/${resource}`, `https://jsd.onmicrosoft.cn/gh/${resource}`];
    const global = [`https://cdn.jsdelivr.net/gh/${resource}`,
        `https://raw.githubusercontent.com/FluentRead/FluentRead/${PDF_READING_FONT_REVISION}/public${PDF_READING_FONT_PATH}`];
    return /^zh(?:$|-CN|-Hans)/iu.test(locale) ? [...china, ...global] : [...global, ...china];
}

export interface PdfReadingFontLoaderDependencies {
    fetch: typeof fetch;
    openCache: () => Promise<Pick<Cache, 'match' | 'put' | 'delete'>>;
    digest: (data: ArrayBuffer) => Promise<ArrayBuffer>;
    locale: () => string;
    timeoutMs: number;
}

/** 不合作的网络、流或缓存端口也不能阻塞调用方取消。迟到结果只负责释放监听。 */
function withAbort<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return Promise.resolve().then(operation);
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, {once: true});
        void Promise.resolve().then(() => {signal.throwIfAborted(); return operation();})
            .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

export function createPdfReadingFontLoader(overrides: Partial<PdfReadingFontLoaderDependencies> = {}) {
    const deps: PdfReadingFontLoaderDependencies = {
        fetch: (...args) => globalThis.fetch(...args),
        openCache: () => caches.open(PDF_READING_FONT_CACHE),
        digest: data => crypto.subtle.digest('SHA-256', data),
        locale: () => typeof navigator === 'undefined' ? '' : navigator.language,
        timeoutMs: 25_000,
        ...overrides,
    };
    type Download = {controller: AbortController; subscribers: number; promise: Promise<Uint8Array>};
    let pending: Download | undefined;

    async function readVerified(response: Response, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
        if (!response.ok || !response.body || /text\/html/iu.test(response.headers.get('Content-Type') || '')) {
            cancelUnreadResponseBody(response);
            throw new Error('PDF 导出字体来源不可用');
        }
        if (!response.headers.get('Content-Encoding') && Number(response.headers.get('Content-Length')) > PDF_READING_FONT_BYTES) {
            cancelUnreadResponseBody(response);
            throw new Error('PDF 导出字体超过预期大小');
        }
        const reader = response.body.getReader();
        const bytes = new Uint8Array(PDF_READING_FONT_BYTES);
        let offset = 0;
        try {
            while (true) {
                const chunk = await withAbort(() => reader.read(), signal);
                if (chunk.done) break;
                if (offset + chunk.value.byteLength > bytes.byteLength) throw new Error('PDF 导出字体超过预期大小');
                bytes.set(chunk.value, offset);
                offset += chunk.value.byteLength;
            }
        } finally {void reader.cancel().catch(() => undefined); reader.releaseLock();}
        if (offset !== bytes.byteLength) throw new Error('PDF 导出字体不完整');
        const digest = await withAbort(() => deps.digest(bytes.buffer), signal);
        const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        if (hash !== PDF_READING_FONT_SHA256) throw new Error('PDF 导出字体完整性校验失败');
        signal.throwIfAborted();
        return bytes;
    }

    async function run(signal: AbortSignal): Promise<Uint8Array> {
        const cache = await withAbort(() => deps.openCache(), signal).catch(() => undefined);
        signal.throwIfAborted();
        if (cache) {
            try {
                const response = await withAbort(() => cache.match(PDF_READING_FONT_CACHE_KEY), signal);
                if (response) return await readVerified(response, signal);
            } catch {
                signal.throwIfAborted();
                await withAbort(() => cache.delete(PDF_READING_FONT_CACHE_KEY), signal).catch(() => undefined);
                signal.throwIfAborted();
            }
        }
        let failure: unknown;
        for (const source of getPdfReadingFontSources(deps.locale())) {
            signal.throwIfAborted();
            const controller = new AbortController();
            const abort = () => controller.abort(signal.reason);
            signal.addEventListener('abort', abort, {once: true});
            const timer = setTimeout(() => controller.abort(new DOMException('PDF 导出字体下载超时', 'TimeoutError')), deps.timeoutMs);
            try {
                const response = await withAbort(() => deps.fetch(source, {
                    signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
                }), controller.signal);
                const bytes = await readVerified(response, controller.signal);
                signal.throwIfAborted();
                if (cache) await withAbort(() => cache.put(PDF_READING_FONT_CACHE_KEY,
                    new Response(bytes, {headers: {'Content-Type': 'font/woff2'}})), signal).catch(() => undefined);
                signal.throwIfAborted();
                return bytes;
            } catch (error) {signal.throwIfAborted(); failure = error;}
            finally {clearTimeout(timer); controller.abort(); signal.removeEventListener('abort', abort);}
        }
        throw new Error('PDF 导出字体下载失败，请检查网络后重试', {cause: failure});
    }

    return async (signal?: AbortSignal): Promise<Uint8Array> => {
        signal?.throwIfAborted();
        if (!pending) {
            const controller = new AbortController();
            const download: Download = {controller, subscribers: 0,
                promise: Promise.resolve().then(() => run(controller.signal)).finally(() => {if (pending === download) pending = undefined;}),
            };
            // 最后一位订阅者可能在安装 await 之前退出，仍须接住后台任务的取消拒绝。
            void download.promise.catch(() => undefined);
            pending = download;
        }
        const download = pending;
        download.subscribers++;
        try {return await withAbort(() => download.promise, signal);}
        finally {
            download.subscribers--;
            if (download.subscribers === 0 && pending === download) {
                pending = undefined;
                download.controller.abort(new DOMException('PDF 导出字体下载已取消', 'AbortError'));
            }
        }
    };
}

export const loadPdfReadingFontBytes = createPdfReadingFontLoader();

export interface PdfReadingEmbeddedFont {
    font: PDFFont;
    assertSupported(text: string): void;
    prepareText(text: string): Promise<void>;
    measureText(text: string, size: number): number;
    drawText(page: PDFPage, text: string, options: Pick<PDFPageDrawTextOptions, 'color'> & {x: number; y: number; size: number}): void;
}

const VARIATION_SEQUENCE = /[^\uFE00-\uFE0F\u{E0100}-\u{E01EF}][\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;

export async function embedPdfReadingFont(pdf: PDFDocument, bytes: Uint8Array, signal?: AbortSignal): Promise<PdfReadingEmbeddedFont> {
    signal?.throwIfAborted();
    const {default: fontkit} = await import('@pdf-lib/fontkit');
    signal?.throwIfAborted();
    pdf.registerFontkit(fontkit);
    // 不依赖字体默认启用的拉丁连字；测量和输出都使用同一套可见字形。
    const font = await pdf.embedFont(bytes, {subset: true, features: {liga: false}});
    const supported = new Set(font.getCharacterSet());
    signal?.throwIfAborted();
    const variationFonts = new Map<string, PDFFont>();
    const assertSupported = (text: string) => {
        let previous = '';
        for (const character of text) {
            const code = character.codePointAt(0)!;
            if (isPdfReadingVariationSelector(character)) {
                if (!previous || /\s/u.test(previous) || isPdfReadingVariationSelector(previous)) {
                    throw new Error(`PDF 导出文字包含孤立变体选择符 (U+${code.toString(16).toUpperCase()})，请校订该字符后重试`);
                }
            } else if (!/^[\n\r\t]$/u.test(character) && !supported.has(code)) {
                throw new Error(`PDF 导出字体缺少字符 ${character} (U+${code.toString(16).toUpperCase()})，请校订该字符后重试；没有生成缺字的 PDF`);
            }
            previous = character;
        }
    };
    const runs = (text: string): {text: string; font: PDFFont}[] => {
        const result: {text: string; font: PDFFont}[] = [];
        let cursor = 0;
        for (const match of text.matchAll(VARIATION_SEQUENCE)) {
            if (match.index > cursor) result.push({text: text.slice(cursor, match.index), font});
            const variant = variationFonts.get(match[0]);
            if (!variant) throw new Error('PDF 变体字符尚未准备，请重新生成文件');
            result.push({text: match[0], font: variant});
            cursor = match.index + match[0].length;
        }
        if (cursor < text.length) result.push({text: text.slice(cursor), font});
        return result;
    };
    return {font, assertSupported, async prepareText(text) {
        signal?.throwIfAborted();
        assertSupported(text);
        for (const match of text.matchAll(VARIATION_SEQUENCE)) {
            if (variationFonts.has(match[0])) continue;
            // fontkit 与 pdf-lib 都按 glyph id 复用映射；一个序列一份子集，完整保留 base + VS 的复制身份。
            // 字体有对应变体时由 fontkit 选择；否则使用该字体的基础字形，不删除选择符。
            const variant = await pdf.embedFont(bytes, {subset: true, features: {liga: false}});
            signal?.throwIfAborted();
            variant.widthOfTextAtSize(match[0], 1);
            variationFonts.set(match[0], variant);
        }
    }, measureText(text, size) {
        return runs(text).reduce((width, run) => width + run.font.widthOfTextAtSize(run.text, size), 0);
    }, drawText(page, text, options) {
        let x = options.x;
        for (const run of runs(text)) {
            page.drawText(run.text, {...options, font: run.font, x});
            x += run.font.widthOfTextAtSize(run.text, options.size);
        }
    }};
}
