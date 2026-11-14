/**
 * @file tests/imageParagraphBoundary.test.ts
 * 文件职责：冻结双页原图与真实OCR输入，检查纸面归属观察在原预算内恢复两侧完整续行。
 * 主要内容：按原对象建立并消费私有证明，核对原字符、置信、物理框和源像素；漏识别的小字仍保留为独立限制。
 * 模块边界：本文件不运行OCR或在线翻译，期望合段来自首次识别前冻结的设计，不以去空格锚点替代完整段落。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { produceImageParagraphGapProofs, createImageParagraphGapConsumer, bindImageParagraphGapEvidence, getImageParagraphGapEvidence } from '@/src/features/image-translation/services/imageParagraphGapEvidence';
import { groupImageParagraphs, type ImageTextRegion } from '@/src/features/image-translation/paragraphs';
import type { MangaOcrPage } from '@/src/features/image-translation/services/mangaBubbles';
import type { MangaRegion } from '@/src/features/image-translation/services/mangaRegions';
import { imageMaskBoxes } from '@/src/features/image-translation/services/inpainting';
import { mangaMaskBoxes } from '@/src/features/image-translation/mangaPatchResult';
const digest = (data: Uint8Array | Uint8ClampedArray) => createHash('sha256').update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)).digest('hex');
describe('实际纸面边界和段落归属', () => {
    it('双页均在原观察预算内形成完整续行，原图和物理行不变', () => {
        const base = new URL('./fixtures/image-translation/paragraph-boundary/', import.meta.url);
        const manifest = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8'));
        for (const [file, sha] of [[manifest.source, manifest.sourceSha256], [manifest.manifest, manifest.manifestSha256]])
            expect(digest(readFileSync(new URL('../' + file, import.meta.url)))).toBe(sha);
        const compressed = readFileSync(new URL(manifest.file, base));
        expect(digest(compressed)).toBe(manifest.gzipSha256);
        const { width, height } = manifest, pixels = new Uint8ClampedArray(gunzipSync(compressed, { maxOutputLength: width * height * 4 }));
        expect(digest(pixels)).toBe(manifest.rgbaSha256);
        const page = structuredClone(manifest.page) as MangaOcrPage, original = JSON.stringify(page.results);
        page.imageParagraphGapProofs = produceImageParagraphGapProofs(page, width, height, pixels);
        expect(page.imageParagraphGapProofs.map(p => [p.previous.text, p.next.text])).toEqual([
            ['KEEP THE LEFT PAGE', 'OPEN BESIDE THE MAP'], ['THE STORY CONTINUES', 'ON THE OTHER SIDE'],
        ]);
        expect(page.imageParagraphGapProofs.reduce((sum, p) => sum + p.pixels, 0)).toBeLessThanOrEqual(1048576);
        const consumer = createImageParagraphGapConsumer(page, width, height), regions: ImageTextRegion[] = page.results.map(item => ({
            text: item.text, fontSize: item.box.height, bbox: { x0: item.box.x, y0: item.box.y, x1: item.box.x + item.box.width, y1: item.box.y + item.box.height },
        }));
        regions.forEach((region, index) => consumer.record(page.results[index], region));
        consumer.seal(regions);
        bindImageParagraphGapEvidence(regions, 'frozen-spread', width, height);
        const grouped = groupImageParagraphs(regions, getImageParagraphGapEvidence(regions, 'frozen-spread', width, height));
        expect(grouped.map(p => p.text)).toEqual(manifest.expectedParagraphs);
        for (const group of grouped)
            for (const box of group.sourceBoxes ?? [group.bbox])
                expect(regions.some(region => JSON.stringify(region.bbox) === JSON.stringify(box))).toBe(true);
        const sorted = (boxes: ImageTextRegion['bbox'][]) => boxes.map(box => JSON.stringify(box)).sort();
        expect(sorted(grouped.flatMap(region => imageMaskBoxes(region, width, height)))).toEqual(sorted(regions.flatMap(region => imageMaskBoxes(region, width, height))));
        expect(sorted(grouped.flatMap(region => mangaMaskBoxes(region as MangaRegion, width, height)))).toEqual(sorted(regions.flatMap(region => mangaMaskBoxes(region as MangaRegion, width, height))));
        expect(JSON.stringify(page.results)).toBe(original);
        expect(digest(pixels)).toBe(manifest.rgbaSha256);
        expect(page.results.some(item => item.text === manifest.knownMissingOcr)).toBe(false);
    });
});
