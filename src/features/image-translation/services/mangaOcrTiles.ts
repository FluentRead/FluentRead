/**
 * @file src/features/image-translation/services/mangaOcrTiles.ts
 * 文件职责：为本地图片与漫画 OCR 规划原像素重叠瓦片，并把识别结果安全映回整图。
 * 主要内容：沿两轴均匀分配最长边 1536、至少 512 像素重叠的识别窗口；限制 8192 边长与 16MP 输入；合并重叠窗口中的同一物理行时优先保留未被内部边界裁切的完整结果，保留相邻独立文字。
 * 模块边界：纯几何与数据算法，不读取像素、不创建 Canvas、不运行模型，不推测或拼接未识别出的文字。
 */
import type {MangaOcrItem} from './mangaRegions';
import {numericProtection} from './mangaNumeric';

export interface MangaOcrTile {x: number; y: number; width: number; height: number}
export interface MangaOcrTileResult {tile: MangaOcrTile; results: MangaOcrItem[]; numericEvidence?: MangaOcrItem[]}
const TILE_SIDE = 1536;
const TILE_STRIDE = 1024;

/** 去重前收集数值物理证据，按瓦片可见边界映回整图；不改变正常识别结果的去重。 */
export function collectMangaOcrTileNumericEvidence(pages:MangaOcrTileResult[],width:number,height:number):MangaOcrItem[] {
    const output:MangaOcrItem[]=[],keys=new Set<string>();
    for(const {tile,results,numericEvidence} of pages)for(const item of numericEvidence??results){
        if(!numericProtection(item.text?.replace(/\s+/gu,' ').trim()??''))continue;
        const b=item.box;
        if(!b||![tile.x,tile.y,tile.width,tile.height,b.x,b.y,b.width,b.height].every(Number.isFinite)
            ||tile.width<=0||tile.height<=0||b.width<=0||b.height<=0)throw new Error('图片数字保护位置无效，已保留原图');
        const x=Math.max(0,tile.x,tile.x+b.x),y=Math.max(0,tile.y,tile.y+b.y);
        const right=Math.min(width,tile.x+tile.width,tile.x+b.x+b.width),bottom=Math.min(height,tile.y+tile.height,tile.y+b.y+b.height);
        if(right<=x||bottom<=y)continue;
        const key=[x,y,right,bottom].join(',');if(keys.has(key))continue;
        if(output.length>=4096)throw new Error('图片数字保护区域过于复杂，已保留原图');
        keys.add(key);output.push({...item,box:{x,y,width:right-x,height:bottom-y}});
    }
    return output;
}

/** 检测框可能退让边缘数像素；另一完整框跨越本窗口时，以其真实可见切片核对裁边证据。 */
function matchesVisibleSlice(candidate: {item: MangaOcrItem; tile: MangaOcrTile}, whole: MangaOcrItem['box']): boolean {
    const {tile, item: {box}} = candidate;
    const left = Math.max(whole.x, tile.x), top = Math.max(whole.y, tile.y);
    const right = Math.min(whole.x + whole.width, tile.x + tile.width);
    const bottom = Math.min(whole.y + whole.height, tile.y + tile.height);
    if (right <= left || bottom <= top) return false;
    const visibleArea = (right - left) * (bottom - top);
    if (visibleArea >= whole.width * whole.height) return false;
    const overlap = Math.max(0, Math.min(box.x + box.width, right) - Math.max(box.x, left))
        * Math.max(0, Math.min(box.y + box.height, bottom) - Math.max(box.y, top));
    return overlap >= Math.max(box.width * box.height, visibleArea) * 0.65;
}

/** 小图复用整图；大图各窗口保持原像素，避免最长边缩放让整条长图的小字消失。 */
export function planMangaOcrTiles(width: number, height: number): MangaOcrTile[] {
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192)
        || width * height > 16_777_216) throw new Error('图片尺寸超出本地识别范围');
    const positions = (length: number) => {
        const distance = Math.max(0, length - TILE_SIDE);
        const steps = Math.ceil(distance / TILE_STRIDE);
        return steps ? Array.from({length: steps + 1}, (_, index) => Math.round(index * distance / steps)) : [0];
    };
    return positions(height).flatMap(y => positions(width).map(x => ({
        x, y, width: Math.min(width, TILE_SIDE), height: Math.min(height, TILE_SIDE),
    })));
}

/** 只在不同瓦片间去重；高重叠行优先保留完整裁剪，不能用中心点分区丢弃跨边界文字。 */
export function mergeMangaOcrTiles(pages: MangaOcrTileResult[], width: number, height: number): MangaOcrItem[] {
    const candidates = pages.flatMap(({tile, results}, tileIndex) => results.flatMap(item => {
        const {box} = item;
        if (![box.x, box.y, box.width, box.height, item.confidence].every(Number.isFinite)
            || box.width <= 0 || box.height <= 0) return [];
        const x = Math.max(0, tile.x + box.x), y = Math.max(0, tile.y + box.y);
        const right = Math.min(width, tile.x + box.x + box.width);
        const bottom = Math.min(height, tile.y + box.y + box.height);
        if (right <= x || bottom <= y) return [];
        const clipped = (tile.x > 0 && box.x <= 2) || (tile.y > 0 && box.y <= 2)
            || (tile.x + tile.width < width && box.x + box.width >= tile.width - 2)
            || (tile.y + tile.height < height && box.y + box.height >= tile.height - 2);
        return [{item: {...item, box: {x, y, width: right - x, height: bottom - y}}, tileIndex, tile, edgeClipped: clipped, clipped}];
    }));
    for (const candidate of candidates) {
        candidate.clipped ||= candidates.some(other => other.tileIndex !== candidate.tileIndex
            && !other.edgeClipped && matchesVisibleSlice(candidate, other.item.box));
    }
    candidates.sort((a, b) => Number(a.clipped) - Number(b.clipped)
        || b.item.confidence - a.item.confidence
        || b.item.box.width * b.item.box.height - a.item.box.width * a.item.box.height);
    const selected: typeof candidates = [];
    for (const candidate of candidates) {
        const a = candidate.item.box;
        const duplicate = selected.some(previous => {
            if (previous.tileIndex === candidate.tileIndex) return false;
            const b = previous.item.box;
            // 按另一完整框在本瓦片内的可见切片确认同一物理行；无需猜测文字或依赖固定退边像素。
            if (candidate.clipped && !previous.clipped && matchesVisibleSlice(candidate, b)) return true;
            // 不把另一窗口偶然检测到的整块气泡当成其中每条文字的重复结果。
            const aThickness = Math.min(a.width, a.height), bThickness = Math.min(b.width, b.height);
            if (Math.max(aThickness, bThickness) > Math.min(aThickness, bThickness) * 1.8) return false;
            const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
                * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
            // 完整框之间必须双向覆盖，不能因长框包住独立短标签就删掉后者。
            // 只有完整框与裁边片段配对时，才允许用单向覆盖丢弃不完整片段。
            const area = previous.clipped !== candidate.clipped
                ? Math.min(a.width * a.height, b.width * b.height)
                : Math.max(a.width * a.height, b.width * b.height);
            return overlap >= area * 0.65;
        });
        if (!duplicate) selected.push(candidate);
    }
    return selected.map(candidate => candidate.item).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}
