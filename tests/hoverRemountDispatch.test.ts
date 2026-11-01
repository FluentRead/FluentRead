import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createHoverRemountDispatch} from '@/src/features/full-page-translation/content/hoverRemountDispatch';
import type {TranslationCandidate} from '@/src/core/translation/public';
import type {FullPageTranslationConfigSnapshot} from '@/src/features/full-page-translation/content/translationConfigSnapshot';

function setup() {
    const document = parseHTML('<html><body><p id="old">A sentence</p><p id="new">A sentence</p></body></html>').document;
    const old = {element: document.querySelector('#old')!, kind: 'content', reason: 'post', scope: 'content'} as unknown as TranslationCandidate;
    const replacement = {...old, element: document.querySelector('#new')!} as TranslationCandidate;
    const snapshot: FullPageTranslationConfigSnapshot = {service: 'microsoft', model: '', thinking: false,
        sourceLanguage: 'en', targetLanguage: 'zh', useCache: true, enableAIContext: false,
        enableAIMultiSegment: false, displayMode: 'bilingual', style: 0};
    let point: TranslationCandidate | null = old;
    let available = true, full = false, scope: 'content' | 'all' = 'content', commit = true;
    let live = snapshot;
    let current!: () => boolean;
    let finishRequest!: (value: {status: string; detachedHoverAttempt?: boolean}) => void;
    const request = new Promise<{status: string; detachedHoverAttempt?: boolean}>(resolve => {finishRequest = resolve;});
    const recoveries: Array<{cancel: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn>; waitForReplacement: ReturnType<typeof vi.fn>}> = [];
    const ports = {
        isAvailable: () => available,
        isFullPageActive: () => full,
        captureCommitGuard: () => () => commit,
        currentScope: () => scope,
        captureConfig: () => live,
        identity: (value: FullPageTranslationConfigSnapshot) => String(value.displayMode),
        checkConfig: () => true,
        noteGesture: vi.fn(),
        track: vi.fn((candidate: TranslationCandidate, _x: number, _y: number, check: () => boolean, onCancel: () => void) => {
            current = check;
            const recovery = {cancel: vi.fn(() => onCancel()), ownsOwner: (owner: Element) => owner === candidate.element,
                finish: vi.fn(() => replacement), waitForReplacement: vi.fn(async () => true)};
            recoveries.push(recovery);
            return recovery;
        }),
        translate: vi.fn().mockReturnValueOnce(request).mockResolvedValue({status: 'committed'}),
        resolve: vi.fn(() => point),
        hasState: vi.fn(() => false),
        waitForPaint: vi.fn(async () => {}),
        warn: vi.fn(),
    };
    const instance = createHoverRemountDispatch(ports);
    const launch = async () => {instance.scheduler.handle(1, 2, {inputSource: 'mouse-shortcut'}); await vi.advanceTimersByTimeAsync(0);};
    return {document, old, replacement, snapshot, ports, instance, recoveries, launch, finishRequest,
        current: () => current(), setPoint: (value: TranslationCandidate | null) => {point = value;},
        setAvailable: (value: boolean) => {available = value;}, setFull: (value: boolean) => {full = value;},
        setScope: (value: 'content' | 'all') => {scope = value;}, setCommit: (value: boolean) => {commit = value;},
        setLive: (value: FullPageTranslationConfigSnapshot) => {live = value;}};
}

afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});

describe('hover remount dispatch', () => {
    it('rechecks visibility, session, scope, generation, cache and invocation identity', async () => {
        vi.useFakeTimers(); const h = setup(); await h.launch();
        expect(h.current()).toBe(true);
        h.setAvailable(false); expect(h.current()).toBe(false); h.setAvailable(true);
        h.setFull(true); expect(h.current()).toBe(false); h.setFull(false);
        h.setScope('all'); expect(h.current()).toBe(false); h.setScope('content');
        h.setCommit(false); expect(h.current()).toBe(false); h.setCommit(true);
        h.setLive({...h.snapshot, useCache: false}); expect(h.current()).toBe(false);
        h.setLive({...h.snapshot, displayMode: 'single'}); expect(h.current()).toBe(false);
        h.setLive(h.snapshot); expect(h.current()).toBe(true);
        h.instance.scheduler.cancel(); h.finishRequest({status: 'stale', detachedHoverAttempt: true});
        await vi.advanceTimersByTimeAsync(0);
        expect(h.recoveries[0]!.cancel).toHaveBeenCalled();
        expect(h.ports.translate).toHaveBeenCalledOnce();
    });

    it('uses the injected paint boundary and retries exactly once with the frozen snapshot', async () => {
        vi.useFakeTimers(); const h = setup(); await h.launch();
        h.setPoint(h.replacement); h.finishRequest({status: 'stale', detachedHoverAttempt: true});
        await vi.advanceTimersByTimeAsync(0);
        expect(h.ports.waitForPaint).toHaveBeenCalledOnce();
        expect(h.recoveries[0]!.finish).toHaveBeenCalledWith(true);
        expect(h.ports.translate).toHaveBeenCalledTimes(2);
        expect(h.ports.translate).toHaveBeenLastCalledWith(h.replacement, h.snapshot, false);
    });

    it('honors user cancellation while waiting for paint and does not reuse a stale request', async () => {
        vi.useFakeTimers(); const h = setup(); let settle!: () => void;
        h.ports.waitForPaint.mockImplementationOnce(() => new Promise<void>(resolve => {settle = resolve;}));
        await h.launch(); h.setPoint(h.replacement); h.finishRequest({status: 'stale', detachedHoverAttempt: true});
        await vi.advanceTimersByTimeAsync(0); h.instance.cancelOwner(h.old.element); settle();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.recoveries[0]!.cancel).toHaveBeenCalled();
        expect(h.ports.translate).toHaveBeenCalledOnce();
    });

    it('does not retry if a cancelled replacement wait resolves late', async () => {
        vi.useFakeTimers(); const h = setup(); let settle!: (value: boolean) => void;
        await h.launch();
        h.recoveries[0]!.waitForReplacement.mockImplementationOnce(() => new Promise<boolean>(resolve => {settle = resolve;}));
        h.setPoint(h.replacement); h.finishRequest({status: 'stale', detachedHoverAttempt: true});
        await vi.advanceTimersByTimeAsync(0); h.instance.cancelOwner(h.old.element); settle(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.ports.translate).toHaveBeenCalledOnce();
        expect(h.recoveries[0]!.finish).not.toHaveBeenCalled();
    });

    it('a delayed old cancellation cannot delete the new tracker for the same owner', async () => {
        vi.useFakeTimers(); const h = setup();
        h.ports.translate.mockReset().mockImplementation(() => new Promise(() => {}));
        await h.launch(); await h.launch();
        expect(h.recoveries).toHaveLength(2);
        expect(h.recoveries[0]!.cancel).toHaveBeenCalledOnce();
        h.ports.track.mock.calls[0]![4]();
        h.instance.cancelOwner(h.old.element);
        expect(h.recoveries[1]!.cancel).toHaveBeenCalledOnce();
    });

    it('warns and releases tracked recovery when translation rejects', async () => {
        vi.useFakeTimers(); const h = setup(); const error = new Error('provider failed');
        h.ports.translate.mockReset().mockRejectedValueOnce(error); await h.launch();
        expect(h.recoveries[0]!.cancel).toHaveBeenCalledOnce();
        expect(h.ports.warn).toHaveBeenCalledWith(error);
    });

    it('reports a rejected retry after the replacement has been accepted', async () => {
        vi.useFakeTimers(); const h = setup(); const error = new Error('retry failed');
        h.ports.translate.mockRejectedValueOnce(error);
        await h.launch(); h.setPoint(h.replacement); h.finishRequest({status: 'stale', detachedHoverAttempt: true});
        await vi.advanceTimersByTimeAsync(0);
        expect(h.ports.translate).toHaveBeenCalledTimes(2);
        expect(h.ports.warn).toHaveBeenCalledOnce();
        expect(h.ports.warn).toHaveBeenCalledWith(error);
    });

    it('caps simultaneous tracked owners without preventing normal translation', async () => {
        vi.useFakeTimers(); const h = setup();
        h.ports.translate.mockReset().mockImplementation(() => new Promise(() => {}));
        for (let index = 0; index < 5; index++) {
            const element = h.document.createElement('p');
            h.setPoint({...h.old, element: element as unknown as HTMLElement}); await h.launch();
        }
        expect(h.ports.track).toHaveBeenCalledTimes(4);
        expect(h.ports.translate).toHaveBeenCalledTimes(5);
        h.instance.scheduler.cancel();
        expect(h.recoveries.every(recovery => recovery.cancel.mock.calls.length === 1)).toBe(true);
    });

    it('uses the bounded paint timer when no animation frame is delivered', async () => {
        vi.useFakeTimers(); const h = setup();
        const cancel = vi.fn(); vi.stubGlobal('window', {setTimeout});
        vi.stubGlobal('requestAnimationFrame', () => 17); vi.stubGlobal('cancelAnimationFrame', cancel);
        const {waitForPaint: _unused, ...ports} = h.ports;
        const instance = createHoverRemountDispatch(ports);
        instance.scheduler.handle(1, 2, {inputSource: 'mouse-shortcut'});
        await vi.advanceTimersByTimeAsync(0);
        h.setPoint(h.replacement); h.finishRequest({status: 'stale', detachedHoverAttempt: true});
        await vi.advanceTimersByTimeAsync(100);
        expect(cancel).toHaveBeenCalledWith(17);
        expect(ports.translate).toHaveBeenCalledTimes(2);
    });
});
