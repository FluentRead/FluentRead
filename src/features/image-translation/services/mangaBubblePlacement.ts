/**
 * @file src/features/image-translation/services/mangaBubblePlacement.ts
 * 文件职责：为实际采用的漫画段落私有记录气泡位置提示，并按同一原图和未变区域收窄查询。
 * 主要内容：弱引用原区域身份，复制并冻结有界整数 owner，逐项拒绝稀疏源框并快照文字、字号、方向、保护标记及源框数值和引用；仅一次绑定原图，重复同源可复用，失效或转授后撤回提示。
 * 模块边界：不读取像素、DOM、OCR 或持久缓存；提示不证明空白、连通归属或可擦墨迹，调用方必须在同帧原像素上另行验证完整补绘位置，不能据此清除英文或图案。
 */
import type {MangaRegion} from './mangaRegions';

type Box = MangaRegion['bbox'];
type BoxSnapshot = {reference: Box; value: Box};
interface RegionSnapshot {
    text: string;
    fontSize: number;
    vertical: MangaRegion['vertical'];
    guardOnly: MangaRegion['guardOnly'];
    bbox: BoxSnapshot;
    sourceReference: MangaRegion['sourceBoxes'];
    sources: BoxSnapshot[];
}
interface Placement {
    owner: Readonly<Box>;
    width: number;
    height: number;
    snapshot: RegionSnapshot;
    image?: string;
}
const placements = new WeakMap<object, Placement | null>();
const MAX_SIDE = 8192, MAX_PAGE_PIXELS = 16_777_216, MAX_OBSERVATION_PIXELS = 65_536, MAX_SOURCE_BOXES = 4096;
const isObject = (value: unknown): value is object => !!value && typeof value === 'object' && !Array.isArray(value);
const copyBox = (box: Readonly<Box>): Box => ({x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1});
const sameBox = (a: Readonly<Box>, b: Readonly<Box>): boolean => a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
function validBox(box: Box, width: number, height: number): boolean {
    return isObject(box) && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)
        && box.x0 >= 0 && box.y0 >= 0 && box.x1 <= width && box.y1 <= height && box.x1 > box.x0 && box.y1 > box.y0;
}
function insideOwner(box: Box, owner: Readonly<Box>): boolean {
    const x = (box.x0 + box.x1) / 2, y = (box.y0 + box.y1) / 2;
    return x >= owner.x0 && x < owner.x1 && y >= owner.y0 && y < owner.y1;
}
function capture(region: MangaRegion, owner: Readonly<Box>, width: number, height: number): RegionSnapshot | undefined {
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= MAX_SIDE) || width * height > MAX_PAGE_PIXELS
        || !validBox(owner, width, height) || ![owner.x0, owner.y0, owner.x1, owner.y1].every(Number.isSafeInteger)
        || owner.x0 < 1 || owner.y0 < 1 || owner.x1 >= width || owner.y1 >= height
        || (owner.x1 - owner.x0 + 2) * (owner.y1 - owner.y0 + 2) > MAX_OBSERVATION_PIXELS) return;
    if (typeof region.text !== 'string' || !region.text.trim() || !Number.isFinite(region.fontSize) || region.fontSize <= 0
        || region.vertical !== undefined || region.guardOnly !== undefined || !validBox(region.bbox, width, height) || !insideOwner(region.bbox, owner)) return;
    const sources = region.sourceBoxes;
    const snapshots: BoxSnapshot[] = [];
    if (sources !== undefined) {
        if (!Array.isArray(sources) || sources.length > MAX_SOURCE_BOXES) return;
        for (let index = 0; index < sources.length; index++) {
            if (!Object.hasOwn(sources, index)) return;
            const box = sources[index];
            if (!validBox(box, width, height) || !insideOwner(box, owner)) return;
            snapshots.push({reference: box, value: copyBox(box)});
        }
    }
    return {text: region.text, fontSize: region.fontSize, vertical: region.vertical, guardOnly: region.guardOnly,
        bbox: {reference: region.bbox, value: copyBox(region.bbox)}, sourceReference: sources,
        sources: snapshots};
}
function unchanged(region: MangaRegion, snapshot: RegionSnapshot): boolean {
    const sources = region.sourceBoxes;
    return region.text === snapshot.text && region.fontSize === snapshot.fontSize && region.vertical === snapshot.vertical && region.guardOnly === snapshot.guardOnly
        && region.bbox === snapshot.bbox.reference && sameBox(region.bbox, snapshot.bbox.value)
        && sources === snapshot.sourceReference && (sources === undefined
            || (sources.length === snapshot.sources.length && snapshot.sources.every((saved, index) => Object.hasOwn(sources, index)
                && sources[index] === saved.reference && sameBox(sources[index], saved.value))));
}

/** 只记录实际分组得到的原对象；重复同一记录可复用，歧义或失效对象不能重新取得提示。 */
export function recordMangaBubblePlacement(region: MangaRegion, owner: Readonly<Box>, width: number, height: number): void {
    if (!isObject(region)) return;
    const previous = placements.get(region);
    if (previous === null) return;
    const snapshot = capture(region, owner, width, height);
    if (!snapshot) {placements.set(region, null);return;}
    if (previous) {
        if (previous.width !== width || previous.height !== height || !sameBox(previous.owner, owner) || !unchanged(region, previous.snapshot)) placements.set(region, null);
        return;
    }
    placements.set(region, {owner: Object.freeze(copyBox(owner)), width, height, snapshot});
}

/** 同一原对象仅绑定一次原图；错误绑定撤回，不能把旧提示转授给另一来源。 */
export function bindMangaBubblePlacements(regions: readonly MangaRegion[], image: string, width: number, height: number): void {
    for (const region of regions) {
        if (!isObject(region)) continue;
        const placement = placements.get(region);
        if (!placement) continue;
        if (typeof image !== 'string' || !image || placement.width !== width || placement.height !== height || !unchanged(region, placement.snapshot)
            || (placement.image !== undefined && placement.image !== image)) {placements.set(region, null);continue;}
        placement.image = image;
    }
}

/** 返回冻结的布局提示；clone、异源或变化的原区域均没有像素或绘制权限。 */
export function getMangaBubblePlacement(region: MangaRegion, image: string, width: number, height: number): Readonly<Box> | undefined {
    if (!isObject(region)) return;
    const placement = placements.get(region);
    if (!placement || placement.image === undefined || placement.image !== image || placement.width !== width || placement.height !== height) return;
    if (!unchanged(region, placement.snapshot)) {placements.set(region, null);return;}
    return placement.owner;
}
