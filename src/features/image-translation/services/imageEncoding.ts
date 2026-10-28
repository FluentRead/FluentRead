/**
 * @file src/features/image-translation/services/imageEncoding.ts
 * 文件职责：将网页图片读取、普通译图、漫画局部译图及圈选/OCR 预处理画布异步编码成无损 PNG，避免同步压缩阻塞网页或 Offscreen 的取消和进度消息。
 * 主要内容：沿用现有 data URL 消息协议；默认 30 秒等待预算，也可使用调用链路剩余预算及错误文案，调用开始时复制预算值；取消或失败时释放监听与读取器，丢弃迟到结果。
 * 模块边界：只处理调用方画布，不修改网页、图片内容、模型或消息入口；调用方负责最终释放 Canvas。
 */
export function encodeImageCanvas(
    canvas: HTMLCanvasElement,
    signal?: AbortSignal,
    budget: {readonly timeoutMs: number; readonly message: string; readonly onPhysicalSettled?: () => void} = {timeoutMs: 30_000, message: '图片翻译超时'},
): Promise<string> {
    const {timeoutMs, message} = budget;
    return new Promise((resolve, reject) => {
        let settled = false;
        let physicalSettled = false;
        const settlePhysical = () => {if(physicalSettled)return;physicalSettled=true;try{budget.onPhysicalSettled?.();}catch{/* 不影响编码 */}};
        let reader: FileReader | undefined;
        const timeout = setTimeout(() => finish(new Error(message)), timeoutMs);
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
        if (signal?.aborted) {settlePhysical();abort();return;}
        try {
            canvas.toBlob(blob => {
                // 取消 Promise 不会终止浏览器内的编码；仅回调到达才算物理编码结束。
                settlePhysical();
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
        } catch (error) {settlePhysical();finish(error as Error);}
    });
}

// 按需 Canvas 验证独占一个物理编码槽；永不回调时保持占用，重挂也不能绕过。
let readingEncoderBusy = false;
export function readingImageEncodingBusy():boolean {return readingEncoderBusy;}
export function encodeReadingImageCanvas(canvas:HTMLCanvasElement,signal:AbortSignal):Promise<string> {
    if(readingEncoderBusy)return Promise.reject(Object.assign(new Error('漫画阅读编码尚未结束'),{code:'READING_ENCODER_BUSY'}));
    readingEncoderBusy=true;
    return encodeImageCanvas(canvas,signal,{timeoutMs:30_000,message:'漫画阅读编码超时',onPhysicalSettled:()=>{readingEncoderBusy=false;}});
}
