/**
 * @file src/features/image-translation/content/mangaSession.ts
 * 文件职责：管理当前漫画章节的连续翻译会话，保证一次开启、逐页执行、原文暂停与异步任务所有权。
 * 主要内容：接收可见页和有界提前翻译窗口，当前页优先、串行处理；阅读器移动期间暂停新识别但立即复用已完成结果，短暂离屏不取消在途推理，停稳后未译当前页可取消远处旧任务，最近页面仅保留不抢占队列；隐藏时停止新任务，换图、换章和关闭取消旧任务；显式单页重试进入同一队列并清除旧错误，不循环请求或并发绕过会话；未启动的延后任务重新排队，卸载后不再发送迟到通知。
 * 模块边界：只依赖注入的页面翻译与恢复端口，图片和可读画布共用一个队列；不查询 DOM、保存配置或实现 OCR；位图缓存、宿主样式与语言包由图片运行时管理。
 */
import type {ImageTranslationStage} from '../progress';
export interface MangaTranslationStatus {
    available: boolean;
    active: boolean;
    pending: boolean;
    errors: number;
    pageCount?: number;
    areaFallback?: boolean;
    completed?: number;
    message?: string;
    progress?: number;
    stage?: ImageTranslationStage;
    prefetching?: boolean;
    ahead?: number;
}

export interface MangaPageSnapshot<T = HTMLImageElement> {
    image: T;
    identity: string;
    visible: boolean;
    prefetch?: boolean;
    retain?: boolean;
    ordinal?: number;
}

export interface MangaSnapshot<T = HTMLImageElement> {
    route: string;
    available: boolean;
    pages: MangaPageSnapshot<T>[];
    suspended?: boolean;
    deferNewWork?: boolean;
}

export function createMangaSession<T = HTMLImageElement>(ports: {
    translate: (image: T) => Promise<void | 'deferred'>;
    reuse?: (image: T) => boolean;
    restore: (image: T) => void;
    release: (image: T) => void;
    failed: (image: T) => boolean;
    changed: (status: MangaTranslationStatus) => void;
}) {
    let route = '';
    let available = false;
    let active = false;
    let disposed = false;
    let epoch = 0;
    type Page = {identity: string; ordinal?: number; attempted: boolean; failed: boolean; completed: boolean; visible: boolean; retained: boolean; scheduled: boolean; ahead: boolean};
    let running: {image: T; page: Page} | null = null;
    let suspended = false;
    let schedulingDeferred = false;
    const pages = new Map<T, Page>();

    const status = (): MangaTranslationStatus => ({
        available, active, pending: active && running !== null,
        errors: Array.from(pages.values()).filter(page => page.failed).length,
        completed: Array.from(pages.values()).filter(page => page.completed && !page.failed).length,
        prefetching: active && running !== null && !running.page.visible,
        ahead: Array.from(pages.values()).filter(page => page.retained && page.ahead && !page.visible && page.completed && !page.failed).length,
    });
    const notify = (final = false) => {if (!disposed || final) ports.changed(status());};

    function reset() {
        epoch++;
        active = false;
        pages.forEach((_page, image) => ports.release(image));
        pages.clear();
        notify();
    }

    function pump(): void {
        if (disposed || !active || suspended || schedulingDeferred || running) return;
        const candidates = Array.from(pages).filter(([, page]) => page.retained && page.scheduled && !page.attempted);
        const next = candidates.find(([, page]) => page.visible) ?? candidates[0];
        if (!next) return;
        const [image, page] = next;
        page.attempted = true;
        const owner = epoch;
        const task = running = {image, page};
        let started = false;
        let deferred = false;
        notify();
        // 同步抛错和 Promise 拒绝都归入该页失败；取消后的迟到结果不更新新会话。
        void Promise.resolve().then(() => {
            if (owner !== epoch || !active || pages.get(image) !== page) return;
            // scroll 可以在这个微任务前到达；尚未请求的页面回到队列，不能被当成已完成。
            if (suspended || schedulingDeferred || !page.scheduled) {page.attempted = false;return;}
            started = true;
            return ports.translate(image).then(result => {deferred = result === 'deferred';});
        }).catch(() => { if (owner === epoch && pages.get(image) === page) page.failed = true; })
            .finally(() => {
                if (started && owner === epoch && pages.get(image) === page) {
                    if (page.retained && deferred) page.attempted = false;
                    else if (page.retained) {page.failed ||= ports.failed(image);page.completed = true;}
                    else {ports.release(image);pages.delete(image);}
                }
                if (running === task) running = null;
                notify();
                pump();
            });
    }

    function refresh(snapshot: MangaSnapshot<T>): void {
        if (disposed) return;
        if (snapshot.route !== route) {
            reset();
            route = snapshot.route;
        }
        available = snapshot.available;
        suspended = snapshot.suspended === true;
        schedulingDeferred = snapshot.deferNewWork === true;
        if (!available) reset();
        const current = new Map(snapshot.pages.map(page => [page.image, page]));
        const selected = new Map(snapshot.pages.filter(page => page.visible || page.prefetch || page.retain).map(page => [page.image, page]));
        pages.forEach((page, image) => {
            const next = selected.get(image);
            if (next?.identity === page.identity) {page.ordinal=next.ordinal;page.visible = next.visible;page.retained = true;page.scheduled = next.visible || next.prefetch === true;page.ahead = next.prefetch === true;return;}
            if (active && running?.image === image && current.get(image)?.identity === page.identity) {
                page.visible = false;page.retained = false;return;
            }
            ports.release(image);
            pages.delete(image);
        });
        if (active) selected.forEach((page, image) => {
            if (!pages.has(image)) pages.set(image, {identity: page.identity, ordinal:page.ordinal, attempted: false, failed: false, completed: false, visible: page.visible, retained: true, scheduled: page.visible || page.prefetch === true, ahead: page.prefetch === true});
        });
        // 已解码结果的显示交接不能排在另一页的耗时 OCR 后面；这里只做同步复用，不启动推理。
        if (active && !suspended) pages.forEach((page, image) => {
            if (page.visible && !page.attempted && ports.reuse?.(image)) {
                page.attempted = true;page.completed = true;page.failed = false;
            }
        });
        // 停稳后的远距离跳页才取消无保留价值的旧识别；缓存返页不抢占，取消完成前仍占用串行槽。
        if (active && !suspended && !schedulingDeferred && running && !running.page.retained
            && pages.get(running.image) === running.page
            && Array.from(pages.values()).some(page => page.visible && page.scheduled && !page.attempted)) {
            ports.release(running.image);
            pages.delete(running.image);
        }
        notify();
        pump();
    }

    function toggle(): boolean {
        if (disposed || !available) return false;
        epoch++;
        schedulingDeferred = false;
        active = !active;
        pages.forEach((page, image) => {
            if (!active) ports.restore(image);
            else {
                const reused = !suspended && page.visible && ports.reuse?.(image) === true;
                page.attempted = reused;page.failed = false;page.completed = reused;
            }
        });
        notify();
        pump();
        return true;
    }

    return {
        status, refresh, toggle,
        /** 仅按用户请求复制保留页，超预算保留第 65 项供调用方明确拒绝。 */
        readingPages() {
            const result:Array<{image:T;identity:string;ordinal:number}>=[];
            if(disposed||!active||suspended)return result;
            for(const [image,page] of pages) {
                if(page.visible&&page.retained&&page.ordinal!==undefined)result.push({image,identity:page.identity,ordinal:page.ordinal});
                if(result.length>64)break;
            }
            return result.sort((a,b)=>a.ordinal-b.ordinal);
        },
        // 事件到达时同步关闸，防止上一页的 finally 在下一次布局测量前启动排队预译。
        deferScheduling() { if (!disposed) schedulingDeferred = true; },
        retry(image: T): boolean {
            if (disposed || !active || suspended) return false;
            const page = pages.get(image);
            if (!page?.retained || !page.scheduled || running?.image === image) return false;
            schedulingDeferred = false;
            page.attempted = false;page.failed = false;page.completed = false;
            notify();pump();return true;
        },
        dispose() { if (disposed) return; reset(); disposed = true; available = false; notify(true); },
    };
}
