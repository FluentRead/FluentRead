/**
 * @file src/features/image-translation/content/imageLoads.ts
 * 文件职责：为网页原图维护仅在同地址重载时递增的像素版本，让漫画会话与单图显示共享加载身份。
 * 主要内容：首次加载和新地址加载不重复使已完成结果失效；同地址重载必定换版本，捕获与目标监听共享同一个事件只记一次；查看器在捕获中建立状态时标记本次事件，弱引用和重置避免保留页面图片。
 * 模块边界：只记录传入图片和加载事件，不注册 DOM 监听、不读取像素、不保存译图；运行时负责生命周期和根据版本撤下旧结果。
 */
export function createImageLoadTracker() {
    let entries = new WeakMap<HTMLImageElement, {source?: string; revision: number}>();
    let handled = new WeakSet<Event>();
    return {
        revision(image: HTMLImageElement): number {
            let entry = entries.get(image);
            if (!entry) {
                entry = {revision: 0};
                if (image.complete && image.naturalWidth > 0) entry.source = image.currentSrc || image.src;
                entries.set(image,entry);
            }
            return entry.revision;
        },
        loaded(event: Event): void {
            const image = event.target as HTMLImageElement;
            const entry = entries.get(image);
            if (!entry || handled.has(event)) return;
            handled.add(event);
            const source = image.currentSrc || image.src;
            if (entry.source === source) entry.revision++;
            entry.source = source;
        },
        markHandled(event: Event): void { handled.add(event); },
        reset(): void { entries = new WeakMap(); handled = new WeakSet(); },
    };
}

export const imageLoadTracker = createImageLoadTracker();
