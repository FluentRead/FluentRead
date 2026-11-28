/**
 * @file src/features/image-translation/content/mangaCompositor.ts
 * 文件职责：将漫画的局部无损图块直接合成到原始图片或已捕获的可读画布，省去整页 PNG 编码与再解码。
 * 主要内容：整页绘制与解码共用十五秒预算，采用最多四路并发滑动窗口预解码位图并按确定顺序核对尺寸与绘制，以完整最终图块替换对应原像素，避免透明图块叠加旧字形或重复累积 alpha，及时关闭位图；取消、超时或解码失败释放画布并关闭全部已解码与迟到位图；完成前保留宿主原图可读。
 * 模块边界：只操作调用方图片和压缩结果，不访问模型、翻译服务、缓存或宿主样式。
 */
import type {MangaCompressedPage} from '../mangaPatchResult';

const DECODE_CONCURRENCY = 4;

export async function composeMangaPage(source: HTMLImageElement | HTMLCanvasElement, page: MangaCompressedPage, signal: AbortSignal): Promise<HTMLCanvasElement> {
    const deadline = performance.now() + 15_000;
    const canvas = document.createElement('canvas');
    const check = () => {
        if (signal.aborted) throw new DOMException('图片翻译已取消', 'AbortError');
        if (performance.now() >= deadline) throw new Error('译图加载超时');
    };
    const inflight = new Map<number, {promise: Promise<ImageBitmap>; bitmap?: ImageBitmap; cancel: () => void}>();
    const startDecode = (index: number) => {
        const patch = page.patches[index];
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let finish!: (error?: Error, value?: ImageBitmap) => void;
        const abort = () => finish(new DOMException('图片翻译已取消', 'AbortError'));
        const slot: {promise: Promise<ImageBitmap>; bitmap?: ImageBitmap; cancel: () => void} = {
            promise: new Promise<ImageBitmap>((resolve, reject) => {
                finish = (error?: Error, value?: ImageBitmap) => {
                    if (settled) {value?.close(); return;}
                    settled = true; clearTimeout(timeout); signal.removeEventListener('abort', abort);
                    if (error) reject(error);
                    else {slot.bitmap = value!; resolve(value!);}
                };
                timeout = setTimeout(() => finish(new Error('译图加载超时')), Math.max(0, deadline - performance.now()));
                signal.addEventListener('abort', abort, {once: true});
                try {
                    void createImageBitmap(new Blob([patch.bytes as BlobPart], {type: 'image/png'}))
                        .then(value => finish(undefined, value), error => finish(error));
                } catch (error) {finish(error as Error);}
            }),
            cancel: () => {
                if (slot.bitmap) {slot.bitmap.close(); slot.bitmap = undefined;}
                finish(new DOMException('图片翻译已取消', 'AbortError'));
            },
        };
        // 同窗内靠前块失败时会统一取消并清理其余槽位，避免产生未处理拒绝。
        void slot.promise.catch(() => undefined);
        inflight.set(index, slot);
    };
    try {
        check(); canvas.width = page.width; canvas.height = page.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('浏览器不支持图片处理');
        context.drawImage(source, 0, 0, page.width, page.height);
        const total = page.patches.length;
        let nextToStart = 0;
        const fillWindow = () => {
            while (nextToStart < total && inflight.size < DECODE_CONCURRENCY) {
                check();
                startDecode(nextToStart++);
            }
        };
        fillWindow();
        for (let index = 0; index < total; index++) {
            const patch = page.patches[index];
            const slot = inflight.get(index)!;
            const bitmap = await slot.promise;
            inflight.delete(index);
            try {
                check();
                if (bitmap.width !== patch.width || bitmap.height !== patch.height) throw new Error('漫画译图数据无效');
                context.clearRect(patch.x, patch.y, patch.width, patch.height);
                context.drawImage(bitmap, patch.x, patch.y);
            } finally {
                slot.bitmap = undefined;
                bitmap.close();
            }
            fillWindow();
        }
        check(); return canvas;
    } catch (error) {
        for (const slot of inflight.values()) slot.cancel();
        inflight.clear();
        canvas.width = 0; canvas.height = 0; throw error;
    }
}
