/**
 * @file src/features/image-translation/content/mangaSession.ts
 * 文件职责：管理当前漫画章节的连续翻译会话，保证一次开启、逐页执行、原文暂停与异步任务所有权。
 * 主要内容：接收可见页和有界提前翻译窗口，当前页优先、串行处理；短暂离屏不取消在途推理，已完成结果直接复用，最近页面仅保留不抢占队列；隐藏时停止新任务，换图、换章和关闭仍取消旧任务；失败页只在用户再次开启时重试。
 * 模块边界：只依赖注入的单图翻译与恢复端口，不查询 DOM、保存配置或实现 OCR；位图缓存、宿主样式与语言包由既有图片运行时管理。
 */
import type {ImageTranslationStage} from '../progress';
export interface MangaTranslationStatus {
    available: boolean;
    active: boolean;
    pending: boolean;
    errors: number;
    pageCount?: number;
    completed?: number;
    message?: string;
    progress?: number;
    stage?: ImageTranslationStage;
    prefetching?: boolean;
    ahead?: number;
}

export interface MangaPageSnapshot {
    image: HTMLImageElement;
    identity: string;
    visible: boolean;
    prefetch?: boolean;
    retain?: boolean;
}

export interface MangaSnapshot {
    route: string;
    available: boolean;
    pages: MangaPageSnapshot[];
    suspended?: boolean;
}

export function createMangaSession(ports: {
    translate: (image: HTMLImageElement) => Promise<void>;
    reuse?: (image: HTMLImageElement) => boolean;
    restore: (image: HTMLImageElement) => void;
    release: (image: HTMLImageElement) => void;
    failed: (image: HTMLImageElement) => boolean;
    changed: (status: MangaTranslationStatus) => void;
}) {
    let route = '';
    let available = false;
    let active = false;
    let disposed = false;
    let epoch = 0;
    type Page = {identity: string; attempted: boolean; failed: boolean; completed: boolean; visible: boolean; retained: boolean; scheduled: boolean; ahead: boolean};
    let running: {image: HTMLImageElement; page: Page} | null = null;
    let suspended = false;
    const pages = new Map<HTMLImageElement, Page>();

    const status = (): MangaTranslationStatus => ({
        available, active, pending: active && running !== null,
        errors: Array.from(pages.values()).filter(page => page.failed).length,
        completed: Array.from(pages.values()).filter(page => page.completed && !page.failed).length,
        prefetching: active && running !== null && !running.page.visible,
        ahead: Array.from(pages.values()).filter(page => page.retained && page.ahead && !page.visible && page.completed && !page.failed).length,
    });
    const notify = () => ports.changed(status());

    function reset() {
        epoch++;
        active = false;
        pages.forEach((_page, image) => ports.release(image));
        pages.clear();
        notify();
    }

    function pump(): void {
        if (disposed || !active || suspended || running) return;
        const candidates = Array.from(pages).filter(([, page]) => page.retained && page.scheduled && !page.attempted);
        const next = candidates.find(([, page]) => page.visible) ?? candidates[0];
        if (!next) return;
        const [image, page] = next;
        page.attempted = true;
        const task = running = {image, page};
        const owner = epoch;
        notify();
        // 同步抛错和 Promise 拒绝都归入该页失败；取消后的迟到结果不更新新会话。
        void Promise.resolve().then(() => {
            if (owner !== epoch || !active || pages.get(image) !== page) return;
            return ports.translate(image);
        }).catch(() => { if (owner === epoch && pages.get(image) === page) page.failed = true; })
            .finally(() => {
                if (owner === epoch && pages.get(image) === page) {
                    if (page.retained) {page.failed ||= ports.failed(image);page.completed = true;}
                    else {ports.release(image);pages.delete(image);}
                }
                if (running === task) running = null;
                notify();
                pump();
            });
    }

    function refresh(snapshot: MangaSnapshot): void {
        if (disposed) return;
        if (snapshot.route !== route) {
            reset();
            route = snapshot.route;
        }
        available = snapshot.available;
        suspended = snapshot.suspended === true;
        if (!available) reset();
        const current = new Map(snapshot.pages.map(page => [page.image, page]));
        const selected = new Map(snapshot.pages.filter(page => page.visible || page.prefetch || page.retain).map(page => [page.image, page]));
        pages.forEach((page, image) => {
            const next = selected.get(image);
            if (next?.identity === page.identity) {page.visible = next.visible;page.retained = true;page.scheduled = next.visible || next.prefetch === true;page.ahead = next.prefetch === true;return;}
            if (active && running?.image === image && current.get(image)?.identity === page.identity) {
                page.visible = false;page.retained = false;return;
            }
            ports.release(image);
            pages.delete(image);
        });
        if (active) selected.forEach((page, image) => {
            if (!pages.has(image)) pages.set(image, {identity: page.identity, attempted: false, failed: false, completed: false, visible: page.visible, retained: true, scheduled: page.visible || page.prefetch === true, ahead: page.prefetch === true});
        });
        // 已解码结果的显示交接不能排在另一页的耗时 OCR 后面；这里只做同步复用，不启动推理。
        if (active && !suspended) pages.forEach((page, image) => {
            if (page.visible && !page.attempted && ports.reuse?.(image)) {
                page.attempted = true;page.completed = true;page.failed = false;
            }
        });
        notify();
        pump();
    }

    function toggle(): boolean {
        if (disposed || !available) return false;
        epoch++;
        active = !active;
        pages.forEach((page, image) => {
            if (!active) ports.restore(image);
            else { page.attempted = false; page.failed = false;page.completed = false; }
        });
        notify();
        pump();
        return true;
    }

    return {
        status, refresh, toggle,
        dispose() { reset(); disposed = true; available = false; notify(); },
    };
}
