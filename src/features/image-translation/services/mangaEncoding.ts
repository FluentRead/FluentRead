/**
 * @file src/features/image-translation/services/mangaEncoding.ts
 * 文件职责：将普通图片及漫画局部译图异步编码成无损 PNG，避免同步压缩阻塞 Offscreen 的取消和进度消息。
 * 主要内容：沿用现有 data URL 消息协议与已翻译的错误文案；有界等待 Canvas 编码及 FileReader 转换，取消或失败时释放监听与读取器，丢弃迟到结果。
 * 模块边界：只处理调用方画布，不修改网页、图片内容、模型或消息入口；调用方负责最终释放 Canvas。
 */
export function encodeMangaCanvas(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let reader: FileReader | undefined;
        const timeout = setTimeout(() => finish(new Error('图片翻译超时')), 30_000);
        const abort = () => finish(new DOMException('图片翻译请求已取消', 'AbortError'));
        function finish(error?: Error, image?: string) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
            if (reader) {
                reader.onload = null;
                reader.onerror = null;
                if (reader.readyState === 1) reader.abort();
            }
            if (error) reject(error);
            else resolve(image!);
        }
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) {abort();return;}
        try {
            canvas.toBlob(blob => {
                if (settled) return;
                if (!blob) {finish(new Error('图片数据读取失败'));return;}
                try {
                    reader = new FileReader();
                    reader.onload = () => {
                        if (typeof reader!.result !== 'string') finish(new Error('图片数据读取失败'));
                        else finish(undefined, reader!.result);
                    };
                    reader.onerror = () => finish(new Error('图片数据读取失败'));
                    reader.readAsDataURL(blob);
                } catch (error) {finish(error as Error);}
            }, 'image/png');
        } catch (error) {finish(error as Error);}
    });
}
