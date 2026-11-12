/**
 * @file tests/fullPageTitleTranslation.test.ts
 * 覆盖 issue #141：全文翻译时同步翻译页面标题。
 * 正文候选遍历把 <head> 整体硬裁剪，标题因此走独立通路，这里验证它的状态机：
 * 循环守卫、SPA 改写跟随、迟到结果丢弃，以及恢复时不覆盖页面新标题。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

const hooks = vi.hoisted(() => ({
    translateText: vi.fn<(origin: string, context: string, options: unknown) => Promise<string>>(),
    shouldSkip: vi.fn<(origin: string, target: string) => boolean>(() => false),
}));

vi.mock('@/src/services/translation/client', () => ({translateText: hooks.translateText}));
vi.mock('@/src/core/language/detect', () => ({
    shouldSkipTranslationForTarget: hooks.shouldSkip,
    shouldSkipChineseTargetParagraph: () => false,
}));
vi.mock('@/src/features/full-page-translation/content/translationRequest', () => ({
    createSnapshotTranslateOptions: (snapshot: unknown, options: unknown) => ({snapshot, ...(options as object)}),
}));

import {
    startFullPageTitleTranslation,
    stopFullPageTitleTranslation,
} from '@/src/features/full-page-translation/content/titleTranslation';

const snapshot = {targetLanguage: 'zh-Hans', service: 'openai'} as never;
const ORIGINAL = 'Breaking News Today';

let currentTitle: string;
/** 仍在观察中的回调。 */
let connected: Array<() => void>;
/** 曾经创建过的全部回调，disconnect 不会移除；用于模拟迟到的变更记录。 */
let allCallbacks: Array<() => void>;

/** 页面自身改写标题：走 setter 并触发观察者，与浏览器行为一致。 */
function pageSetsTitle(value: string): void {
    (globalThis.document as {title: string}).title = value;
}

beforeEach(() => {
    vi.useFakeTimers();
    currentTitle = ORIGINAL;
    connected = [];
    allCallbacks = [];

    vi.stubGlobal('document', {
        get title(): string { return currentTitle; },
        set title(value: string) {
            if (value === currentTitle) return;
            currentTitle = value;
            // 真实 MutationObserver 以微任务触发；这里同步触发是更严格的循环守卫测试。
            connected.forEach((callback) => callback());
        },
        head: {},
    });
    vi.stubGlobal('MutationObserver', class {
        constructor(private readonly callback: () => void) { allCallbacks.push(callback); }
        observe(): void { if (!connected.includes(this.callback)) connected.push(this.callback); }
        disconnect(): void {
            const index = connected.indexOf(this.callback);
            if (index >= 0) connected.splice(index, 1);
        }
    });
    // 让模块内的 window.setTimeout 落到被 fake timers 接管的全局实现上。
    vi.stubGlobal('window', {
        setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
        clearTimeout: (id: number) => globalThis.clearTimeout(id),
    });

    hooks.translateText.mockReset();
    hooks.shouldSkip.mockReset();
    hooks.shouldSkip.mockReturnValue(false);
});

afterEach(() => {
    stopFullPageTitleTranslation();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('全文翻译的页面标题', () => {
    it('整棵 head 被 SPA 替换后跟随新标题，且旧 head 的后续写入不再触发请求', async () => {
        const {document, MutationObserver} = parseHTML('<html><head><title>First Article</title></head><body></body></html>');
        vi.stubGlobal('document', document);
        vi.stubGlobal('MutationObserver', MutationObserver);
        hooks.translateText.mockImplementation(async text => `翻译：${text}`);
        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);
        const oldHead = document.head;
        const nextHead = document.createElement('head');
        nextHead.innerHTML = '<title>Second Article</title>';
        oldHead.replaceWith(nextHead);
        await vi.advanceTimersByTimeAsync(200);
        expect(document.title).toBe('翻译：Second Article');
        expect(hooks.translateText.mock.calls.map(([text]) => text)).toEqual(['First Article', 'Second Article']);
        oldHead.querySelector('title')!.textContent = 'Detached Article';
        await vi.advanceTimersByTimeAsync(200);
        expect(hooks.translateText).toHaveBeenCalledTimes(2);
        document.title = 'Third Article';
        await vi.advanceTimersByTimeAsync(200);
        expect(document.title).toBe('翻译：Third Article');
        stopFullPageTitleTranslation();
        expect(document.title).toBe('Third Article');
        document.title = 'After Stop';
        await vi.advanceTimersByTimeAsync(200);
        expect(hooks.translateText).toHaveBeenCalledTimes(3);
    });

    it('页面整体置换 html 后仍翻译新标题，并清理旧请求', async () => {
        const {document, MutationObserver} = parseHTML('<html><head><title>Previous Page</title></head><body></body></html>');
        vi.stubGlobal('document', document);
        vi.stubGlobal('MutationObserver', MutationObserver);
        let staleResolve!: (text: string) => void;
        let staleSignal!: AbortSignal;
        hooks.translateText.mockImplementationOnce((_text, _context, options) => new Promise(resolve => {
            staleResolve = resolve; staleSignal = (options as {signal: AbortSignal}).signal;
        })).mockResolvedValue('新页面');
        startFullPageTitleTranslation(snapshot);
        const root = document.createElement('html');
        root.innerHTML = '<head><title>Next Page</title></head><body><p>Text</p></body>';
        document.documentElement.replaceWith(root);
        await vi.advanceTimersByTimeAsync(200);
        expect(staleSignal.aborted).toBe(true);
        expect(document.title).toBe('新页面');
        staleResolve('旧页面');
        await vi.advanceTimersByTimeAsync(0);
        expect(document.title).toBe('新页面');
        stopFullPageTitleTranslation();
        expect(document.title).toBe('Next Page');
    });

    it('不存在 head 和 html 的文档仅观察根结构，停止后不再绑定', () => {
        currentTitle = '';
        Object.assign(document, {head: null, documentElement: null});
        const observe = vi.spyOn(MutationObserver.prototype, 'observe');
        startFullPageTitleTranslation(snapshot);
        expect(observe.mock.calls).toEqual([[document, {childList: true}]]);
        stopFullPageTitleTranslation();
        allCallbacks[0]!();
        expect(observe).toHaveBeenCalledOnce();
    });

    it('head 暂时不存在也可启动，并在页面补回 head 后翻译', async () => {
        const {document, MutationObserver} = parseHTML('<html><head></head><body></body></html>');
        document.head.remove();
        vi.stubGlobal('document', document);
        vi.stubGlobal('MutationObserver', MutationObserver);
        hooks.translateText.mockResolvedValue('新页面');
        expect(() => startFullPageTitleTranslation(snapshot)).not.toThrow();
        const head = document.createElement('head');
        head.innerHTML = '<title>New Page</title>';
        document.documentElement.prepend(head);
        await vi.advanceTimersByTimeAsync(200);
        expect(document.title).toBe('新页面');
        expect(hooks.translateText).toHaveBeenCalledOnce();
    });

    it('路由改写标题时立即取消旧请求，只为稳定标题创建新请求', async () => {
        const signals: AbortSignal[] = [];
        hooks.translateText.mockImplementation((_text, _context, options) => {
            signals.push((options as {signal: AbortSignal}).signal);
            return new Promise(() => {});
        });
        startFullPageTitleTranslation(snapshot);
        pageSetsTitle('Loading Next Page');
        expect(signals[0]!.aborted).toBe(true);
        pageSetsTitle('Next Page');
        await vi.advanceTimersByTimeAsync(150);
        expect(signals).toHaveLength(2);
        expect(signals[1]!.aborted).toBe(false);
        expect(hooks.translateText.mock.calls[1]![0]).toBe('Next Page');
        stopFullPageTitleTranslation();
        expect(signals[1]!.aborted).toBe(true);
    });

    it.each(['', '已经是中文的标题'])('新标题无需翻译时也取消旧请求：%s', async title => {
        let signal: AbortSignal | undefined;
        hooks.translateText.mockImplementation((_text, _context, options) => {
            signal = (options as {signal: AbortSignal}).signal;
            return new Promise(() => {});
        });
        startFullPageTitleTranslation(snapshot);
        hooks.shouldSkip.mockReturnValue(true);
        pageSetsTitle(title);
        expect(signal!.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(200);
        expect(hooks.translateText).toHaveBeenCalledTimes(1);
        expect(currentTitle).toBe(title);
    });

    it('标题已改变但观察者微任务尚未送达时，旧译文也不能覆盖宿主标题', async () => {
        let resolveFirst!: (value: string) => void;
        hooks.translateText.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
        startFullPageTitleTranslation(snapshot);
        currentTitle = 'Next Page';
        resolveFirst('迟到的旧标题');
        await Promise.resolve();
        expect(currentTitle).toBe('Next Page');
        hooks.translateText.mockResolvedValue('下一页');
        connected.forEach(callback => callback());
        await vi.advanceTimersByTimeAsync(200);
        expect(currentTitle).toBe('下一页');
        stopFullPageTitleTranslation();
        expect(currentTitle).toBe('Next Page');
    });

    it('会话启动后把标题替换为译文，恢复时写回原标题', async () => {
        hooks.translateText.mockResolvedValue('今日要闻');

        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);

        expect(hooks.translateText).toHaveBeenCalledTimes(1);
        expect(currentTitle).toBe('今日要闻');

        stopFullPageTitleTranslation();
        expect(currentTitle).toBe(ORIGINAL);
    });

    it('把标题本身作为上下文，避免再次翻译时把译文喂回模型', async () => {
        hooks.translateText.mockResolvedValue('今日要闻');

        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);

        expect(hooks.translateText.mock.calls[0]![0]).toBe(ORIGINAL);
        expect(hooks.translateText.mock.calls[0]![1]).toBe(ORIGINAL);
    });

    it('自身写入的译文不会被当作新标题再次翻译', async () => {
        hooks.translateText.mockResolvedValue('今日要闻');

        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(500);

        expect(hooks.translateText).toHaveBeenCalledTimes(1);
        expect(currentTitle).toBe('今日要闻');
    });

    it('标题判断读取同一会话的排除语言，命中后保留原标题', async () => {
        hooks.shouldSkip.mockReturnValue(true);
        startFullPageTitleTranslation({...snapshot as object, excludedLanguages: ['zh-Hant']} as never);
        await vi.advanceTimersByTimeAsync(500);
        expect(hooks.shouldSkip).toHaveBeenCalledWith(ORIGINAL, 'zh-Hans', ['zh-Hant']);
        expect(hooks.translateText).not.toHaveBeenCalled();
        expect(currentTitle).toBe(ORIGINAL);
    });

    it('标题已是目标语言时不发请求', async () => {
        hooks.shouldSkip.mockReturnValue(true);

        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);

        expect(hooks.translateText).not.toHaveBeenCalled();
        expect(currentTitle).toBe(ORIGINAL);
    });

    it('空标题不发请求', async () => {
        currentTitle = '   ';

        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);

        expect(hooks.translateText).not.toHaveBeenCalled();
    });

    it('页面改写标题后按新文本重新翻译，并合并连续抖动', async () => {
        hooks.translateText.mockResolvedValue('今日要闻');
        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);
        hooks.translateText.mockResolvedValue('第二页');

        // SPA 路由切换常连续改写多次，只应翻译稳定下来的最后一次。
        pageSetsTitle('Page Two Loading');
        pageSetsTitle('Page Two');
        await vi.advanceTimersByTimeAsync(200);

        expect(hooks.translateText).toHaveBeenCalledTimes(2);
        expect(hooks.translateText.mock.calls[1]![0]).toBe('Page Two');
        expect(currentTitle).toBe('第二页');
    });

    it('页面把标题改回原文时不重复翻译', async () => {
        hooks.translateText.mockResolvedValue('今日要闻');
        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);

        pageSetsTitle(ORIGINAL);
        await vi.advanceTimersByTimeAsync(500);

        expect(hooks.translateText).toHaveBeenCalledTimes(1);
    });

    it('恢复时若页面已自行改写标题，则保留页面的新值', async () => {
        hooks.translateText.mockResolvedValue('今日要闻');
        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);

        hooks.translateText.mockImplementation(() => new Promise(() => {}));
        pageSetsTitle('User Navigated Away');
        await vi.advanceTimersByTimeAsync(200);

        stopFullPageTitleTranslation();
        expect(currentTitle).toBe('User Navigated Away');
    });

    it('恢复时清掉尚未触发的合并定时器', async () => {
        hooks.translateText.mockResolvedValue('今日要闻');
        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);

        pageSetsTitle('Page Two');
        stopFullPageTitleTranslation();
        await vi.advanceTimersByTimeAsync(500);

        // 只有启动时那一次请求；被清掉的定时器不应再发出第二次。
        expect(hooks.translateText).toHaveBeenCalledTimes(1);
    });

    it('翻译失败时保留原标题', async () => {
        hooks.translateText.mockRejectedValue(new Error('network down'));

        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);

        expect(currentTitle).toBe(ORIGINAL);
    });

    it('译文为空白或与原文相同时不改写标题', async () => {
        hooks.translateText.mockResolvedValue('   ');
        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);
        expect(currentTitle).toBe(ORIGINAL);
        stopFullPageTitleTranslation();

        hooks.translateText.mockResolvedValue(ORIGINAL);
        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);
        expect(currentTitle).toBe(ORIGINAL);
    });

    it('会话结束后返回的译文不再改写标题', async () => {
        let resolveTranslation: ((value: string) => void) | undefined;
        hooks.translateText.mockImplementation(() => new Promise<string>((resolve) => {
            resolveTranslation = resolve;
        }));

        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);
        stopFullPageTitleTranslation();

        resolveTranslation?.('今日要闻');
        await vi.advanceTimersByTimeAsync(0);

        expect(currentTitle).toBe(ORIGINAL);
    });

    it('迟到的旧请求结果不会覆盖更新的标题', async () => {
        let resolveFirst: ((value: string) => void) | undefined;
        hooks.translateText.mockImplementationOnce(() => new Promise<string>((resolve) => {
            resolveFirst = resolve;
        }));

        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);

        hooks.translateText.mockResolvedValue('第二页');
        pageSetsTitle('Page Two');
        await vi.advanceTimersByTimeAsync(200);
        expect(currentTitle).toBe('第二页');

        // 第一次请求此时才返回：它对应的已经是过期的源标题。
        resolveFirst?.('今日要闻');
        await vi.advanceTimersByTimeAsync(0);

        expect(currentTitle).toBe('第二页');
    });

    it('停用后迟到的变更记录不得改写标题', async () => {
        hooks.translateText.mockResolvedValue('今日要闻');
        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);

        const lateCallback = allCallbacks[0]!;
        stopFullPageTitleTranslation();
        hooks.translateText.mockClear();

        currentTitle = 'Late Mutation';
        lateCallback();
        await vi.advanceTimersByTimeAsync(500);

        expect(hooks.translateText).not.toHaveBeenCalled();
    });

    it('未启动时调用恢复是安全的空操作', () => {
        expect(() => stopFullPageTitleTranslation()).not.toThrow();
        expect(currentTitle).toBe(ORIGINAL);
    });

    it('重复启动会先归还上一轮标题，再以当前标题为源', async () => {
        hooks.translateText.mockResolvedValue('今日要闻');
        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);
        expect(currentTitle).toBe('今日要闻');

        hooks.translateText.mockResolvedValue('再次翻译');
        startFullPageTitleTranslation(snapshot);
        await vi.advanceTimersByTimeAsync(0);

        expect(hooks.translateText.mock.calls[1]![0]).toBe(ORIGINAL);
        expect(currentTitle).toBe('再次翻译');

        stopFullPageTitleTranslation();
        expect(currentTitle).toBe(ORIGINAL);
    });
});
