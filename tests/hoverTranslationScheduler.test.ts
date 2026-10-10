import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import type {TranslationCandidate} from '@/src/core/translation/public';
import {HoverTranslationScheduler} from '@/src/features/full-page-translation/content/hoverScheduler';
import type {FullPageTranslationConfigSnapshot} from '@/src/features/full-page-translation/content/translationConfigSnapshot';

function fixture(guards: {isAvailable?: () => boolean; captureCommitGuard?: () => () => boolean} = {}) {
    const {document} = parseHTML('<html><body><p>First source.<strong>Second source.</strong></p><p>Another paragraph.</p></body></html>');
    const element = document.querySelector<HTMLElement>('p')!;
    const candidate: TranslationCandidate = {element, kind: 'content', reason: 'paragraph'};
    let current: TranslationCandidate | null = candidate;
    const snapshot: FullPageTranslationConfigSnapshot = {service: 'microsoft', model: '', thinking: false,
        sourceLanguage: 'en', targetLanguage: 'zh', useCache: true, enableAIContext: false,
        enableAIMultiSegment: false, displayMode: 'bilingual', style: 0};
    const ports = {currentScope: vi.fn(() => 'content' as const), resolveCandidate: vi.fn(() => current),
        captureConfig: vi.fn(() => snapshot), checkConfig: vi.fn(() => true), noteGesture: vi.fn(), translate: vi.fn(), ...guards};
    const scheduler = new HoverTranslationScheduler(ports);
    return {document, candidate, snapshot, ports, scheduler, setCurrent: (value: TranslationCandidate | null) => {current = value;}};
}

describe('悬浮候选停留调度', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();});

    it('零延迟保持下一任务派发，只在派发时解析一次当前坐标', async () => {
        const {ports, scheduler, candidate, snapshot} = fixture();
        scheduler.cancel();
        scheduler.handle(1, 2);
        expect(ports.resolveCandidate).not.toHaveBeenCalled();
        expect(ports.translate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(0);
        expect(ports.resolveCandidate).toHaveBeenCalledTimes(1);
        expect(ports.resolveCandidate).toHaveBeenCalledWith(1, 2, 'content');
        expect(ports.translate).toHaveBeenCalledTimes(1);
        expect(ports.translate).toHaveBeenCalledWith(candidate, snapshot, false);
        expect(ports.noteGesture).not.toHaveBeenCalled();
    });

    it('同段继续移动保留截止时间与配置快照，最终使用最新坐标', async () => {
        const {ports, scheduler, candidate, snapshot} = fixture();
        scheduler.handle(1, 2, {delayMs: 100, continuous: true});
        await vi.advanceTimersByTimeAsync(40);
        scheduler.handle(3, 4, {delayMs: 100, continuous: true});
        await vi.advanceTimersByTimeAsync(59);
        expect(ports.translate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(ports.captureConfig).toHaveBeenCalledTimes(1);
        expect(ports.noteGesture).toHaveBeenCalledTimes(2);
        expect(ports.resolveCandidate).toHaveBeenLastCalledWith(3, 4, 'content');
        expect(ports.translate).toHaveBeenCalledTimes(1);
        expect(ports.translate).toHaveBeenCalledWith(candidate, snapshot, true);
    });

    it('零延迟与停留模式切换分别替换旧工作，不共享未知候选身份', async () => {
        const {ports, scheduler} = fixture();
        scheduler.handle(1, 2);
        scheduler.handle(3, 4, {delayMs: 100, continuous: true});
        await vi.advanceTimersByTimeAsync(99);
        expect(ports.translate).not.toHaveBeenCalled();
        scheduler.handle(5, 6, {continuous: true});
        await vi.advanceTimersByTimeAsync(0);
        expect(ports.translate).toHaveBeenCalledTimes(1);
        expect(ports.resolveCandidate).toHaveBeenLastCalledWith(5, 6, 'content');
    });

    it.each([
        {scope: 'all' as const}, {continuous: false}, {delayMs: 200}, {profileId: 'new-profile'},
        {service: 'google'}, {model: 'model-b'}, {targetLanguage: 'ja'}, {displayMode: 'single' as const},
        {glossaryIds: ['technical']},
    ])('调用参数 %j 改变后重新等待', async (change) => {
        const {ports, scheduler} = fixture();
        scheduler.handle(1, 2, {delayMs: 100, continuous: true});
        await vi.advanceTimersByTimeAsync(50);
        scheduler.handle(1, 2, {delayMs: 100, continuous: true, ...change});
        await vi.advanceTimersByTimeAsync(50);
        expect(ports.translate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync((change.delayMs ?? 100) - 50);
        expect(ports.translate).toHaveBeenCalledTimes(1);
        expect(ports.captureConfig).toHaveBeenCalledTimes(2);
    });

    it('不可用配置不排定工作，空白区域退出和显式取消都撤销旧停留', async () => {
        const {ports, scheduler, candidate, setCurrent} = fixture();
        ports.checkConfig.mockReturnValueOnce(false);
        scheduler.handle(1, 2, {delayMs: 100});
        await vi.advanceTimersByTimeAsync(100);
        expect(ports.translate).not.toHaveBeenCalled();
        scheduler.handle(1, 2, {delayMs: 100});
        setCurrent(null);
        scheduler.handle(3, 4, {delayMs: 100});
        await vi.advanceTimersByTimeAsync(100);
        expect(ports.translate).not.toHaveBeenCalled();
        setCurrent(candidate);
        scheduler.handle(1, 2, {delayMs: 100});
        scheduler.cancel();
        await vi.advanceTimersByTimeAsync(100);
        expect(ports.translate).not.toHaveBeenCalled();
        scheduler.handle(1, 2);
        setCurrent(null);
        await vi.advanceTimersByTimeAsync(0);
        expect(ports.translate).not.toHaveBeenCalled();
    });

    const changes: Array<[string, (candidate: TranslationCandidate, document: Document) => TranslationCandidate]> = [
        ['宿主', (candidate, document) => ({...candidate, element: document.querySelectorAll<HTMLElement>('p')[1]!})],
        ['内联身份', candidate => ({...candidate, nodes: [candidate.element.lastChild!]})],
        ['候选种类', candidate => ({...candidate, kind: 'control'})],
        ['范围', candidate => ({...candidate, scope: 'all'})],
        ['解析依据', candidate => ({...candidate, reason: 'new-reason'})],
        ['站点适配', candidate => ({...candidate, adapterId: 'new-adapter'})],
        ['顶层边界', candidate => ({...candidate, allowTopLevelApplicationShell: true})],
        ['显式换行', candidate => ({...candidate, sourceLine: true})],
        ['物化片段', candidate => ({...candidate, manualChunk: true})],
        ['内联长度', candidate => ({...candidate, nodes: []})],
        ['新增视觉范围', candidate => ({...candidate, visualRange: {startContainer: candidate.element.firstChild as Text,
            startOffset: 0, endContainer: candidate.element.firstChild as Text, endOffset: 5}})],
    ];
    it.each(changes)('%s 变化时到期不派发旧目标', async (_name, change) => {
        const {ports, scheduler, candidate, document, setCurrent} = fixture();
        scheduler.handle(1, 2, {delayMs: 100});
        setCurrent(change(candidate, document));
        await vi.advanceTimersByTimeAsync(100);
        expect(ports.translate).not.toHaveBeenCalled();
    });

    it('内联段精确比较所有节点，而不是只比较首个候选 key', async () => {
        const {ports, scheduler, candidate, setCurrent} = fixture();
        const first = {...candidate, nodes: [candidate.element.firstChild!, candidate.element.lastChild!]};
        setCurrent(first);
        scheduler.handle(1, 2, {delayMs: 100});
        scheduler.handle(3, 4, {delayMs: 100});
        setCurrent({...first, nodes: [candidate.element.firstChild!, candidate.element.ownerDocument.createTextNode('Replacement source.')]});
        await vi.advanceTimersByTimeAsync(100);
        expect(ports.translate).not.toHaveBeenCalled();
    });

    it.each(['startContainer', 'startOffset', 'endContainer', 'endOffset', 'source', 'removed'] as const)(
        '视觉范围的 %s 改变时拒绝跨块派发', async (field) => {
            const {ports, scheduler, candidate, document, setCurrent} = fixture();
            const node = candidate.element.firstChild as Text;
            const visual: TranslationCandidate = {...candidate, visualRange: {startContainer: node,
                startOffset: 0, endContainer: node, endOffset: 5}, visualSourceText: 'First'};
            setCurrent(visual);
            scheduler.handle(1, 2, {delayMs: 100});
            const range = {...visual.visualRange!};
            if (field === 'startContainer' || field === 'endContainer') range[field] = document.createTextNode('Other');
            else if (field === 'startOffset' || field === 'endOffset') range[field] += 1;
            setCurrent({...visual, visualRange: field === 'removed' ? undefined : range,
                visualSourceText: field === 'source' ? 'Other' : visual.visualSourceText});
            await vi.advanceTimersByTimeAsync(100);
            expect(ports.translate).not.toHaveBeenCalled();
        });

    it('同视觉范围的新候选对象仍沿用首次停留', async () => {
        const {ports, scheduler, candidate, setCurrent} = fixture();
        const node = candidate.element.firstChild as Text;
        const visual: TranslationCandidate = {...candidate, visualRange: {startContainer: node,
            startOffset: 0, endContainer: node, endOffset: 5}, visualSourceText: 'First'};
        setCurrent(visual);
        scheduler.handle(1, 2, {delayMs: 100});
        setCurrent({...visual, visualRange: {...visual.visualRange!}});
        scheduler.handle(3, 4, {delayMs: 100});
        await vi.advanceTimersByTimeAsync(100);
        expect(ports.captureConfig).toHaveBeenCalledTimes(1);
        expect(ports.translate).toHaveBeenCalledTimes(1);
    });

    it('解析端口同步重入取消时，到期回调也不能继续派发', async () => {
        const {ports, scheduler, candidate} = fixture();
        scheduler.handle(1, 2, {delayMs: 100});
        ports.resolveCandidate.mockImplementationOnce(() => {scheduler.cancel(); return candidate;});
        await vi.advanceTimersByTimeAsync(100);
        expect(ports.translate).not.toHaveBeenCalled();
    });

    it('取消后已排入宿主任务队列的旧回调不能抢占新停留', () => {
        const callbacks: Array<() => void> = [];
        vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
            callbacks.push(callback);
            return callbacks.length;
        }) as typeof setTimeout);
        vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
        const {ports, scheduler} = fixture();
        scheduler.handle(1, 2, {delayMs: 100});
        scheduler.handle(3, 4, {delayMs: 200});
        callbacks[0]!();
        expect(ports.translate).not.toHaveBeenCalled();
        callbacks[1]!();
        expect(ports.translate).toHaveBeenCalledTimes(1);
    });

    it('不可用时撤回旧停留，不捕获配置或记录手势，恢复后新停留可正常派发', async () => {
        let available = true;
        const {ports, scheduler} = fixture({isAvailable: () => available});
        scheduler.handle(1, 2, {delayMs: 100, continuous: true});
        available = false;
        scheduler.handle(3, 4, {delayMs: 100, continuous: true});
        expect(vi.getTimerCount()).toBe(0);
        expect(ports.captureConfig).toHaveBeenCalledTimes(1);
        expect(ports.resolveCandidate).toHaveBeenCalledTimes(1);
        expect(ports.noteGesture).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(100);
        expect(ports.translate).not.toHaveBeenCalled();
        available = true;
        scheduler.handle(5, 6, {delayMs: 100, continuous: true});
        await vi.advanceTimersByTimeAsync(99);
        expect(ports.translate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(ports.translate).toHaveBeenCalledTimes(1);
    });

    it.each(['availability', 'commit-guard'] as const)('到期前 %s 失效时先撤回，不解析或派发迟到目标', async reason => {
        let available = true, canCommit = true;
        const captureCommitGuard = vi.fn(() => () => canCommit);
        const {ports, scheduler} = fixture({isAvailable: () => available, captureCommitGuard});
        scheduler.handle(1, 2, {delayMs: 100});
        if (reason === 'availability') available = false;
        else canCommit = false;
        await vi.advanceTimersByTimeAsync(100);
        expect(ports.resolveCandidate).toHaveBeenCalledTimes(1);
        expect(ports.translate).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        available = true; canCommit = true;
        scheduler.handle(3, 4, {delayMs: 100});
        await vi.advanceTimersByTimeAsync(100);
        expect(ports.translate).toHaveBeenCalledTimes(1);
        expect(captureCommitGuard).toHaveBeenCalledTimes(2);
    });

    it.each(['availability', 'commit-guard'] as const)('目标解析同步改变 %s 时复验门禁，不提交失效目标', async reason => {
        let available = true, canCommit = true;
        const {ports, scheduler, candidate} = fixture({isAvailable: () => available, captureCommitGuard: () => () => canCommit});
        scheduler.handle(1, 2, {delayMs: 100});
        ports.resolveCandidate.mockImplementationOnce(() => {
            if (reason === 'availability') available = false;
            else canCommit = false;
            return candidate;
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(ports.resolveCandidate).toHaveBeenCalledTimes(2);
        expect(ports.translate).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('同段移动保留首次捕获的提交代次，失效后只有新的停留可重新获得提交权', async () => {
        let generation = 0;
        const captureCommitGuard = vi.fn(() => {
            const captured = generation;
            return () => generation === captured;
        });
        const {ports, scheduler} = fixture({captureCommitGuard});
        scheduler.handle(1, 2, {delayMs: 100, continuous: true});
        await vi.advanceTimersByTimeAsync(40);
        generation += 1;
        scheduler.handle(3, 4, {delayMs: 100, continuous: true});
        expect(captureCommitGuard).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(60);
        expect(ports.translate).not.toHaveBeenCalled();
        scheduler.handle(5, 6, {delayMs: 100, continuous: true});
        await vi.advanceTimersByTimeAsync(100);
        expect(captureCommitGuard).toHaveBeenCalledTimes(2);
        expect(ports.translate).toHaveBeenCalledTimes(1);
    });
});
