import {describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {createFullPageSessionState} from '@/src/features/full-page-translation/content/fullPageSession';
import {createTranslationQueueSession} from '@/src/services/translation/queue';
import type {FullPageTranslationConfigSnapshot} from '@/src/features/full-page-translation/content/translationConfigSnapshot';

vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: vi.fn(), id: 'fixture'}}}));
vi.mock('@/src/services/config/store', async () => {
    const {Config} = await import('@/src/core/config/model');
    return {config: new Config(), configReady: Promise.resolve(), requestConfigCountIncrement: vi.fn()};
});

function fixture() {
    const {document} = parseHTML('<html><body><p>Source</p></body></html>');
    const root = document.documentElement as unknown as HTMLElement;
    const observer = {root: null, rootMargin: '0px', scrollMargin: '0px', thresholds: [0.01],
        disconnect: vi.fn(), observe: vi.fn(), unobserve: vi.fn(), takeRecords: () => []};
    const mutationObserver = {disconnect: vi.fn(), observe: vi.fn(), takeRecords: () => []};
    const ports = {
        root, translationMode: 'viewport' as const, scope: 'content' as const,
        translationConfig: {service: 'google', model: '', thinking: false, sourceLanguage: 'en', targetLanguage: 'zh-Hans',
            useCache: true, enableAIContext: false, enableAIMultiSegment: false, displayMode: 'bilingual', style: 0} satisfies FullPageTranslationConfigSnapshot,
        progressSessionId: 7, observer, mutationObserver,
        scrollController: {isScrolling: false, note: vi.fn(), defer: vi.fn(() => true), dispose: vi.fn()},
        createAbortError: () => Object.assign(new Error('Restored'), {name: 'AbortError'}),
        clearTimeout: vi.fn(), clearModalPresentation: vi.fn(), releaseSourceStability: vi.fn(), finishProgress: vi.fn(),
    };
    return {ports, session: createFullPageSessionState(ports)};
}

describe('full page session resource ownership', () => {
    it('releases observers, requests, timers and retained candidates once, after revoking commit ownership', () => {
        const {ports, session} = fixture();
        const target = ports.root;
        const candidate = {element: target, kind: 'content' as const, reason: 'fixture'};
        const controller = new AbortController();
        session.requestControllers.add(controller);
        session.requestQueueSessions.add(createTranslationQueueSession());
        session.roots.add(target);
        session.pending.set(target, candidate);
        session.scheduled.set(target, candidate);
        session.inFlightCandidates.set(target, candidate);
        session.observedCandidates.set(target, new Map([[target, candidate]]));
        session.candidateOwnerKeys.set(target, new Set([target]));
        session.statefulTargetsByAncestor.set(target, new Set([target]));
        session.dirtyRoots.add(target);
        session.translationSlotCache.set('result', {promise: Promise.resolve('Kept translation'), settled: true});
        session.flushTimer = 1;
        session.mutationFlushTimer = 2;
        session.pruneTimer = 3;
        session.statefulAttributeTimers.set(target, {timer: 4, boundaryTimer: 5});
        const second = documentElement();
        session.statefulAttributeTimers.set(second, {timer: 6});
        session.unsubscribeOutcomeChanges = vi.fn(() => {expect(session.active).toBe(false);});
        session.dispose();
        expect(session.active).toBe(false);
        expect(session.requestSignal.aborted).toBe(true);
        expect(controller.signal.aborted).toBe(true);
        expect(session.shadowEventController.signal.aborted).toBe(true);
        expect(session.requestQueueSessions.size).toBe(0);
        expect(session.requestControllers.size).toBe(0);
        expect(ports.clearTimeout.mock.calls.map(([timer]) => timer)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(ports.observer.disconnect).toHaveBeenCalledOnce();
        expect(ports.mutationObserver.disconnect).toHaveBeenCalledOnce();
        expect(ports.scrollController.dispose).toHaveBeenCalledOnce();
        expect(ports.releaseSourceStability).toHaveBeenCalledWith(session);
        expect(ports.finishProgress).toHaveBeenCalledWith(7);
        for (const retained of [session.roots, session.pending, session.scheduled, session.inFlightCandidates,
            session.observedCandidates, session.candidateOwnerKeys, session.statefulTargetsByAncestor,
            session.dirtyRoots, session.translationSlotCache, session.statefulAttributeTimers]) expect(retained.size).toBe(0);
        expect(session.activeDiscovery).toBeNull();
        expect(session.pruneIterator).toBeNull();
        session.dispose();
        expect(session.unsubscribeOutcomeChanges).toHaveBeenCalledOnce();
        expect(ports.finishProgress).toHaveBeenCalledOnce();
        expect(ports.clearTimeout).toHaveBeenCalledTimes(6);
    });

    it('creates independent cancellation domains and disposing an old page leaves the next page active', () => {
        const first = fixture(), second = fixture();
        expect(first.session.translationRequestCache).not.toBe(second.session.translationRequestCache);
        expect(first.session.requestSignal).not.toBe(second.session.requestSignal);
        first.session.dispose();
        expect(second.session.active).toBe(true);
        expect(second.session.requestSignal.aborted).toBe(false);
        expect(second.ports.observer.disconnect).not.toHaveBeenCalled();
        expect(first.ports.clearTimeout).not.toHaveBeenCalled();
        second.session.dispose();
    });
});

function documentElement(): HTMLElement {
    return parseHTML('<div>Other source</div>').document.documentElement as unknown as HTMLElement;
}
