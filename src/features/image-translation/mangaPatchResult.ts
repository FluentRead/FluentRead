/**
 * @file src/features/image-translation/mangaPatchResult.ts
 * 文件职责：定义漫画局部无损结果的消息边界和阅读会话内的轻量缓存。
 * 主要内容：共用清字蒙版余量，以逐框归约计算绘制边界，不将长页源框展开为函数参数，合并重叠绘制范围；校验坐标、尺寸和二进制预算，立即去除传输用 base64；缓存仅保存压缩图块及文字坐标，按真实字节与张数淘汰。
 * 模块边界：无 DOM、存储、模型与网络副作用；调用方负责来源身份、任务取消和画布合成。
 */
import type {OcrLine} from './core';
import type {MangaRegion} from './services/mangaRegions';
export interface MangaPatchRect {x: number; y: number; width: number; height: number}
export interface MangaPatchPacket {width: number; height: number; patches: Array<MangaPatchRect & {image: string}>}
export interface MangaCompressedPage {width: number; height: number; patches: Array<MangaPatchRect & {bytes: Uint8Array}>; lines: Array<OcrLine & {backgroundColor: string; sourceText?: string; renderSkipped?: true}>}
const MAX_PIXELS = 16_777_216;
export const MANGA_LIGHT_CACHE_BYTES = 16 * 1024 * 1024;
export const MANGA_LIGHT_CACHE_PAGES = 100;

export function mangaMaskBoxes(region: MangaRegion, width: number, height: number) {
    const margin = Math.max(2, Math.min(14, Math.ceil(region.fontSize * .2)));
    return (region.sourceBoxes || [region.bbox]).map(box => ({
        x0: Math.max(0, Math.floor(box.x0) - margin), y0: Math.max(0, Math.floor(box.y0) - margin),
        x1: Math.min(width, Math.ceil(box.x1) + margin), y1: Math.min(height, Math.ceil(box.y1) + margin),
    }));
}

/** 包含清字描边和整个译文区域；所有图块从最终画布截取，重叠区也不会重复擦字。 */
export function mangaPatchRects(regions: MangaRegion[], width: number, height: number): MangaPatchRect[] {
    const rects: MangaPatchRect[] = [];
    for (const region of regions) {
        let left = region.bbox.x0, top = region.bbox.y0;
        let x1 = Math.max(region.bbox.x1, Math.max(0, left) + 4);
        let y1 = Math.max(region.bbox.y1, Math.max(0, top) + 4);
        for (const box of mangaMaskBoxes(region, width, height)) {
            left = Math.min(left, box.x0); top = Math.min(top, box.y0);
            x1 = Math.max(x1, box.x1); y1 = Math.max(y1, box.y1);
        }
        const x = Math.max(0, Math.floor(left));
        const y = Math.max(0, Math.floor(top));
        const right = Math.min(width, Math.ceil(x1));
        const bottom = Math.min(height, Math.ceil(y1));
        if (right <= x || bottom <= y) continue;
        let rect = {x, y, width: right - x, height: bottom - y};
        // 密集长页也保留全部译文；达到消息图块上限时合并相邻绘制范围。
        if (rects.length === 256) {
            const previous = rects.pop()!;
            const left = Math.min(rect.x, previous.x), top = Math.min(rect.y, previous.y);
            rect = {x: left, y: top, width: Math.max(rect.x + rect.width, previous.x + previous.width) - left,
                height: Math.max(rect.y + rect.height, previous.y + previous.height) - top};
        }
        for (let index = 0; index < rects.length;) {
            const other = rects[index];
            if (rect.x < other.x + other.width && other.x < rect.x + rect.width && rect.y < other.y + other.height && other.y < rect.y + rect.height) {
                const left = Math.min(rect.x, other.x), top = Math.min(rect.y, other.y);
                rect = {x: left, y: top, width: Math.max(rect.x + rect.width, other.x + other.width) - left,
                    height: Math.max(rect.y + rect.height, other.y + other.height) - top};
                rects.splice(index, 1); index = 0;
            } else index++;
        }
        rects.push(rect);
    }
    return rects;
}

/** Chrome runtime 使用 JSON；消息中允许临时 base64，历史缓存中只留下紧凑二进制。 */
export function parseMangaPatchPacket(value: unknown): MangaPatchPacket {
    const packet = value as MangaPatchPacket | null;
    const invalid = () => new Error('漫画译图数据无效');
    if (!packet || ![packet.width, packet.height].every(v => Number.isSafeInteger(v) && v > 0 && v <= 8192)
        || packet.width * packet.height > MAX_PIXELS || !Array.isArray(packet.patches) || packet.patches.length > 256) throw invalid();
    let bytes = 0, pixels = 0;
    for (const patch of packet.patches) {
        if (!patch || ![patch.x, patch.y, patch.width, patch.height].every(Number.isSafeInteger)
            || patch.x < 0 || patch.y < 0 || patch.width <= 0 || patch.height <= 0
            || patch.x + patch.width > packet.width || patch.y + patch.height > packet.height
            || typeof patch.image !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(patch.image)) throw invalid();
        const base64 = patch.image.slice(22);
        if (base64.length % 4 !== 0) throw invalid();
        bytes += base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
        pixels += patch.width * patch.height;
        if (bytes > 64 * 1024 * 1024 || pixels > MAX_PIXELS) throw invalid();
    }
    return packet;
}

export function compressMangaPage(packet: MangaPatchPacket, lines: MangaCompressedPage['lines']): MangaCompressedPage {
    return {width: packet.width, height: packet.height, lines, patches: packet.patches.map(({image, ...rect}) => {
        const decoded = atob(image.slice(22));
        return {...rect, bytes: Uint8Array.from(decoded, char => char.charCodeAt(0))};
    })};
}

export function createMangaLightCache(maxPages = MANGA_LIGHT_CACHE_PAGES, maxBytes = MANGA_LIGHT_CACHE_BYTES, onEvict?: (key:string,page:MangaCompressedPage)=>void) {
    const entries = new Map<string, {page: MangaCompressedPage; bytes: number}>();
    let bytes = 0;
    function remove(key: string) {const entry = entries.get(key); if (entry) {bytes -= entry.bytes; entries.delete(key);}}
    return {
        get(key: string) {const entry = entries.get(key); if (!entry) return undefined; entries.delete(key); entries.set(key, entry); return entry.page;},
        put(key: string, page: MangaCompressedPage) {
            remove(key);
            const size = new TextEncoder().encode(JSON.stringify({key, width: page.width, height: page.height, lines: page.lines,
                patches: page.patches.map(({bytes: data, ...rect}) => ({...rect, bytes: data.byteLength}))})).byteLength
                + page.patches.reduce((sum, patch) => sum + patch.bytes.byteLength, 0);
            if (size > maxBytes || maxPages <= 0) return false;
            entries.set(key, {page, bytes: size}); bytes += size;
            while (entries.size > maxPages || bytes > maxBytes) {
                const oldest=entries.keys().next().value!,entry=entries.get(oldest)!;remove(oldest);
                try{onEvict?.(oldest,entry.page);}catch{/* 缓存上限不可被观察者阻断 */}
            }
            return true;
        },
        remove,
        clear() {entries.clear(); bytes = 0;},
        stats: () => ({pages: entries.size, bytes}),
    };
}
