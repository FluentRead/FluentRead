import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import {createDeclarativeAdapter} from '@/src/core/translation/adapters/declarative';
import {compileSiteRulePack, getSiteAdapterAttributeFilter} from '@/src/core/site-adaptation/compiler';
import {createAttributeMutationBatch, type AttributeMutationBatchPorts} from '@/src/features/full-page-translation/content/attributeMutationBatch';
import type {TranslationState} from '@/src/features/full-page-translation/content/state';

// Only the transport, configuration and layout environment are controlled.
// Runtime, candidate core/selector adapter, state, source snapshot, renderer and failed UI are real.
const fixture = vi.hoisted(() => ({
    core: null as TranslationCandidateCore | null,
    requests: vi.fn<(origins: readonly string[]) => Promise<string[]>>(),
    cancelQueue: vi.fn(),
    config: {
        service: 'microsoft', hoverTranslationService: '',
        model: {microsoft: 'microsoft-default'}, customModel: {}, modelThinking: {},
        from: 'en', to: 'zh', excludedLanguages: [] as string[],
        useCache: true, enableAIContext: false, enableAIMultiSegment: false,
        display: 1, style: 0, longParagraphLineBreakEnabled: false,
        translationBeforeOriginal: false, fullPageTranslationMode: 'all',
        translationScope: 'content', eagerTranslationCharacters: 0,
        maxConcurrentTranslations: 3, pageTitleTranslationEnabled: false, uiLanguage: 'zh-CN',
    },
}));
vi.mock('@/src/app/translation/check', () => ({checkConfig: () => true}));
vi.mock('@/src/services/config/store', () => ({config: fixture.config}));
vi.mock('@/src/core/config/catalog', () => ({
    services: {microsoft: 'microsoft', freeTranslation: 'freeTranslation',
        chromeTranslator: 'chromeTranslator', localTranslation: 'localTranslation'},
    servicesType: {isUseAIContext: () => false},
    resolveConfiguredModel: (selected?: string, custom?: string) => selected === 'custom' ? custom || '' : selected || '',
    options: {services: [{value: 'microsoft', label: 'Fixture provider'}], styles: []},
}));
vi.mock('@/src/core/config/constants', () => ({styles: {singleTranslation: 0, bilingualTranslation: 1}}));
vi.mock('@/src/core/language/detect', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/src/core/language/detect')>(),
    detectlang: () => '', shouldSkipTranslationForTarget: () => false,
}));
vi.mock('@/src/app/translation/client', () => ({
    translateText: async (origin: string) => (await fixture.requests([origin]))[0],
    translateTextBatch: (origins: readonly string[]) => fixture.requests(origins),
}));
vi.mock('@/src/services/translation/queue', () => ({
    createTranslationQueueSession: () => ({}), cancelTranslationQueueSession: fixture.cancelQueue,
}));
vi.mock('@/src/core/translation/public', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/src/core/translation/public')>(),
    getCurrentTranslationCore: () => fixture.core!,
}));
vi.mock('@/src/features/full-page-translation/content/layout', () => ({
    ensureTranslationTruncationLayout: () => true,
    createTranslationTruncationLayoutBatch: () => () => true,
}));
vi.mock('@/src/features/full-page-translation/ui/modalProgressHint', () => ({syncModalTranslationHint: () => undefined}));
vi.mock('@/src/features/full-page-translation/content/titleTranslation', () => ({
    startFullPageTitleTranslation: () => undefined, stopFullPageTitleTranslation: () => undefined,
    isFullPageTitleTranslationActive: () => false,
}));
vi.mock('@/src/features/page-notice/public', () => ({showPageNotice: () => undefined}));
vi.mock('@/src/core/config/customOpenAI', () => ({getCustomOpenAIProviderLabel: () => 'Fixture provider'}));

import {autoTranslateEnglishPage, restoreOriginalContent} from '@/src/features/full-page-translation/content/runtime';
import {getTranslationState} from '@/src/features/full-page-translation/content/state';
import * as indicators from '@/src/features/full-page-translation/ui/translationIndicators';
import * as translationState from '@/src/features/full-page-translation/content/state';
import * as translationStability from '@/src/features/full-page-translation/content/translationStability';

class FixtureIntersectionObserver {
    readonly observe = vi.fn(); readonly unobserve = vi.fn(); readonly disconnect = vi.fn();
    constructor(_callback: IntersectionObserverCallback) {}
}
class FixtureMutationObserver {
    static instances: FixtureMutationObserver[] = [];
    readonly observe = vi.fn(); readonly disconnect = vi.fn();
    readonly takeRecords = vi.fn(() => [] as MutationRecord[]);
    constructor(private readonly callback: MutationCallback) { FixtureMutationObserver.instances.push(this); }
    emit(records: MutationRecord[]) { this.callback(records, this as unknown as MutationObserver); }
}
const globals = new Map<PropertyKey, PropertyDescriptor | undefined>();
function replaceGlobal(name: PropertyKey, value: unknown) {
    if (!globals.has(name)) globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
}
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}
const source = 'This eligible paragraph keeps exactly the same source across ancestor class mutations.';
function targetsOnlyFixture() {
    document.body.innerHTML = `<main id="host" class="eligible"><p id="owner">${source}</p></main>`;
    const host = document.querySelector<HTMLElement>('#host')!;
    const owner = document.querySelector<HTMLElement>('#owner')!;
    Object.defineProperty(owner, 'getClientRects', {configurable: true, value: () => [{width: 600, height: 60}]});
    const adapter = {...createDeclarativeAdapter({
        id: 'attribute-boundary-targets-only', hosts: ['example.com'], genericCandidatePolicy: 'targets-only',
        targets: [{selector: '.eligible p', reason: 'attribute-boundary-eligible-target', atomic: true}],
        // Intentionally no keepOriginal: loss of target eligibility must not make source equality fail.
    }), observedAttributes: ['class']};
    fixture.core = new TranslationCandidateCore({url: new URL('https://example.com'), adapters: [adapter]});
    expect(fixture.core.inspect(owner).candidate?.element).toBe(owner);
    expect(adapter.genericCandidatePolicy).toBe('targets-only');
    expect(getSiteAdapterAttributeFilter(fixture.core.adapters)).toContain('class');
    expect(adapter.shouldStayOriginal?.(owner, {url: new URL('https://example.com')})).toBe(false);
    const mutateClass = (next: string) => {
        const oldValue = host.getAttribute('class');
        host.setAttribute('class', next);
        FixtureMutationObserver.instances.at(-1)!.emit([{
            type: 'attributes', target: host, attributeName: 'class', oldValue,
            addedNodes: [], removedNodes: [],
        } as unknown as MutationRecord]);
    };
    return {host, owner, mutateClass};
}

// Use the same real core/compiler/source/renderer fixture as AB-R1/R2. These
// records are delivered synchronously, exactly once; no timer/rescan work is
// included in the operation-count window. Different elements AND attributes
// avoid testing the existing same-element/same-attribute record filter.
function epochAttribute(target: Element, attributeName: string, value: string): MutationRecord {
    const oldValue = target.getAttribute(attributeName);
    target.setAttribute(attributeName, value);
    return {type: 'attributes', target, attributeName, oldValue,
        addedNodes: [], removedNodes: []} as unknown as MutationRecord;
}
function epochFixture(markup: string, selectors: string[]) {
    document.body.innerHTML = markup;
    const owners = Array.from(document.querySelectorAll<HTMLElement>('p'));
    for (const owner of owners) Object.defineProperty(owner, 'getClientRects', {
        configurable: true, value: () => [{width: 600, height: 60}],
    });
    const core = new TranslationCandidateCore({url: new URL('https://example.com'), adapters: compileSiteRulePack({
        version: 1, rules: [{id: 'observer-epoch-real-boundary', name: 'Observer epoch boundary',
            match: {hosts: ['example.com']}, mode: 'focus',
            content: [{css: selectors, atomic: true}]}],
    })});
    fixture.core = core;
    expect(getSiteAdapterAttributeFilter(core.adapters), ':has requires the actual document-wide relation fallback').toBeNull();
    for (const owner of owners) expect(core.inspect(owner).candidate?.element).toBe(owner);
    const flags = Array.from(document.querySelectorAll<HTMLElement>('[data-epoch-flag]'));
    return {core, owners, flags};
}
function epochBurst(flags: HTMLElement[], serial: number): MutationRecord[] {
    expect(flags).toHaveLength(3);
    return ['data-layout', 'aria-expanded', 'data-theme'].map((attribute, index) =>
        epochAttribute(flags[index]!, attribute, `burst-${serial}-${index}`));
}
function spyEpochTextReads(text: Text) {
    // tinyspy only searches the immediate prototype. CharacterData's actual
    // getter is two levels above linkedom Text; spy on its real descriptor.
    let prototype = Object.getPrototypeOf(text);
    while (!Object.getOwnPropertyDescriptor(prototype, 'data')) prototype = Object.getPrototypeOf(prototype);
    return vi.spyOn(prototype as Text, 'data', 'get');
}
async function settleEpochOwners(owners: HTMLElement[]) {
    autoTranslateEnglishPage();
    await vi.advanceTimersByTimeAsync(1_000);
    const states = owners.map(owner => getTranslationState(owner)!);
    for (const state of states) expect(state).toMatchObject({phase: 'translated', syntheticSegment: false});
    return states;
}

describe('full page site attribute boundary lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers(); vi.setSystemTime(new Date(0));
        fixture.requests.mockReset().mockImplementation(async origins => origins.map(() => '真实渲染的有限 fixture 译文'));
        fixture.cancelQueue.mockReset(); FixtureMutationObserver.instances = [];
        const {window, document} = parseHTML('<html><head></head><body></body></html>');
        for (const [name, value] of Object.entries({window, document, Node: window.Node, Element: window.Element,
            HTMLElement: window.HTMLElement, Text: window.Text, ShadowRoot: window.ShadowRoot, DOMParser: window.DOMParser,
            MutationObserver: FixtureMutationObserver, IntersectionObserver: FixtureIntersectionObserver,
            performance: {now: () => Date.now()}})) replaceGlobal(name, value);
        Object.defineProperty(window, 'setTimeout', {configurable: true, value: globalThis.setTimeout});
        Object.defineProperty(window, 'clearTimeout', {configurable: true, value: globalThis.clearTimeout});
    });
    afterEach(() => {
        restoreOriginalContent(); fixture.core = null;
        vi.clearAllTimers(); vi.useRealTimers();
        for (const [name, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        globals.clear();
    });

    it('AB-R1 clears settled out-of-scope translation at the first 500ms despite genuine ancestor class changes every 200ms', async () => {
        const {owner, mutateClass} = targetsOnlyFixture();
        const initialFailure = vi.spyOn(indicators, 'insertFailedTip');
        autoTranslateEnglishPage(); await vi.advanceTimersByTimeAsync(60);
        const initialFailureMessages = initialFailure.mock.calls.map(([, message]) => message);
        initialFailure.mockRestore();
        const previous = getTranslationState(owner)!;
        expect(previous, `fixture startup failures: ${initialFailureMessages.join('; ')}`).toMatchObject({phase: 'translated', syntheticSegment: false});
        expect(previous.allowTopLevelApplicationShell).not.toBe(true);
        expect(owner.querySelector('.fluent-read-bilingual-content')).not.toBeNull();
        expect(fixture.requests).toHaveBeenCalledTimes(1);
        const firstBoundaryAt = Date.now();
        mutateClass('animation-0');
        expect(fixture.core!.inspect(owner).candidate).toBeNull();
        expect(fixture.core!.shouldStayOriginal(owner)).toBe(false);
        expect(getTranslationState(owner)).toBe(previous);
        for (const value of ['animation-1', 'animation-2']) {
            await vi.advanceTimersByTimeAsync(200); mutateClass(value);
        }
        await vi.advanceTimersByTimeAsync(99);
        expect(Date.now() - firstBoundaryAt).toBe(499);
        expect(getTranslationState(owner)).toBe(previous);
        await vi.advanceTimersByTimeAsync(1);
        expect(Date.now() - firstBoundaryAt).toBe(500);
        expect(getTranslationState(owner), 'first boundary due must survive layout trailing reschedules').toBeUndefined();
        expect(previous.controller.signal.aborted).toBe(true);
        expect(owner.querySelector('[data-fr-translation-owned="true"]')).toBeNull();
        expect(owner.textContent).toBe(source);
        await vi.advanceTimersByTimeAsync(100); mutateClass('animation-3');
        await vi.advanceTimersByTimeAsync(200); mutateClass('animation-4');
        await vi.advanceTimersByTimeAsync(200);
        expect(getTranslationState(owner)).toBeUndefined();
        expect(owner.querySelector('[data-fr-translation-owned="true"]')).toBeNull();
        expect(owner.textContent).toBe(source);
        expect(fixture.requests).toHaveBeenCalledTimes(1);
    });

    it('AB-R2 rejects a loading result 100ms after scope loss without ever appending the real retry UI', async () => {
        const {owner, mutateClass} = targetsOnlyFixture();
        const pending = deferred<string[]>(); fixture.requests.mockReturnValueOnce(pending.promise);
        autoTranslateEnglishPage(); await vi.advanceTimersByTimeAsync(60);
        const previous = getTranslationState(owner)!;
        expect(previous).toMatchObject({phase: 'loading', syntheticSegment: false});
        expect(previous.allowTopLevelApplicationShell).not.toBe(true);
        expect(fixture.requests).toHaveBeenCalledTimes(1);
        const append = vi.spyOn(owner, 'appendChild'); // Call-through: the actual indicator/renderer DOM is used.
        try {
            mutateClass('ineligible');
            expect(fixture.core!.inspect(owner).candidate).toBeNull();
            expect(fixture.core!.shouldStayOriginal(owner)).toBe(false);
            expect(previous.controller.signal.aborted).toBe(false);
            const boundaryAt = Date.now();
            await vi.advanceTimersByTimeAsync(100);
            pending.reject(new Error('Controlled provider rejection'));
            await Promise.resolve(); await vi.advanceTimersByTimeAsync(0);
            expect(Date.now() - boundaryAt).toBe(100);
            const retryAppends = append.mock.calls.filter(([node]) =>
                node.nodeType === 1 && (node as Element).matches('.fluent-read-retry-wrapper'));
            expect(retryAppends, 'failure candidate guard must run before actual failed-tip append').toHaveLength(0);
            expect(owner.querySelector('.fluent-read-retry-wrapper')).toBeNull();
            expect(getTranslationState(owner)).toBeUndefined();
            expect(previous.controller.signal.aborted).toBe(true);
            expect(owner.textContent).toBe(source);
            expect(fixture.requests).toHaveBeenCalledTimes(1);
        } finally { append.mockRestore(); pending.resolve(['unused']); }
    });

    it('OE-C1 same-state wide-root burst reads 57 actual owners once, then starts fresh in the next callback', async () => {
        fixture.config.display = 0;
        const {core, owners, flags} = epochFixture(
            '<main id="host"><i data-epoch-flag data-ready="yes"></i><i data-epoch-flag></i><i data-epoch-flag></i>'
            + Array.from({length: 57}, (_, index) => `<p id="owner-${index}">${source} Owner ${index}.</p>`).join('')
            + '</main>', ['main:has([data-ready="yes"]) > p'],
        );
        const previous = await settleEpochOwners(owners);
        expect(owners).toHaveLength(57);
        for (const owner of owners) expect(owner.querySelectorAll('.fluent-read-single-slot')).toHaveLength(1);
        const providerCalls = fixture.requests.mock.calls.length;
        // Both spies call through. In particular, no source guard is stubbed.
        const inspect = vi.spyOn(core, 'inspect');
        const texts = previous.map(state => state!.singleTextSlotHosts![0]!.source);
        const sourceReads = spyEpochTextReads(texts[0]!);
        const textReadCounts = () => texts.map(text => sourceReads.mock.contexts.filter(context => context === text).length);
        try {
            const observer = FixtureMutationObserver.instances.at(-1)!;
            observer.emit([epochAttribute(flags[0]!, 'data-baseline', 'one-record')]);
            expect(inspect.mock.calls.filter(([owner]) => owners.includes(owner as HTMLElement))).toHaveLength(57);
            const oneRecordReads = textReadCounts();
            for (const count of oneRecordReads) expect(count).toBeGreaterThan(0);
            console.info('OE-C1 one-record', JSON.stringify({inspect: 57, sourceDataGets: oneRecordReads.reduce((a, b) => a + b, 0)}));
            for (const serial of [1, 2]) {
                inspect.mockClear(); sourceReads.mockClear();
                observer.emit(epochBurst(flags, serial));
                const ownerSet = new Set(owners);
                const boundaryCalls = inspect.mock.calls.filter(([owner]) => ownerSet.has(owner as HTMLElement));
                const sourceDataGets = textReadCounts();
                console.info('OE-C1 burst', JSON.stringify({serial, records: 3, owners: 57, inspect: boundaryCalls.length, sourceDataGets: sourceDataGets.reduce((a, b) => a + b, 0)}));
                // Before the candidate: 3 records x 57 owners. The optimized
                // readonly epoch: 57 owners. Never include async scan/discovery.
                expect(boundaryCalls, `callback ${serial}: candidate-boundary reads`).toHaveLength(57);
                expect(new Set(boundaryCalls.map(([owner]) => owner)).size).toBe(57);
                // Observe actual Text reads, including lexical guard calls that
                // an export spy cannot intercept. Scope and source readers stay
                // independent: the burst must cost exactly one real record.
                expect(sourceDataGets, `callback ${serial}: actual source Text reads`).toEqual(oneRecordReads);
                for (let index = 0; index < owners.length; index += 1) {
                    const owner = owners[index]!;
                    expect(sourceDataGets[index]).toBeGreaterThan(0);
                    expect(getTranslationState(owner)).toBe(previous[index]);
                    expect(previous[index]!.controller.signal.aborted).toBe(false);
                    expect(owner.querySelectorAll('.fluent-read-single-slot')).toHaveLength(1);
                    expect(owner.textContent).toBe(`${source} Owner ${index}.`);
                }
                expect(fixture.requests).toHaveBeenCalledTimes(providerCalls);
            }
        } finally { inspect.mockRestore(); sourceReads.mockRestore(); fixture.config.display = 1; }
    });

    it.each([0, 1])('OE-S1 display=%s actual restoration invalidates a previously safe :has boundary inside one callback', async display => {
        fixture.config.display = display;
        const artifact = display === 0 ? '.fluent-read-single-slot' : '.fluent-read-bilingual-content';
        const {core, owners, flags} = epochFixture(
            `<main id="host" data-seed="yes"><i data-epoch-flag></i><i data-epoch-flag></i><i data-epoch-flag></i>`
            + `<p id="dependent">${source}</p><p id="trigger" data-ok="yes">A second actual owner controls the relation boundary.</p></main>`,
            ['#host[data-seed="yes"] > #dependent', `#host:has(#trigger ${artifact}) > #dependent`, '#trigger[data-ok="yes"]'],
        );
        const [dependent, trigger] = owners;
        const previous = await settleEpochOwners(owners);
        const providerCalls = fixture.requests.mock.calls.length;
        const host = document.querySelector<HTMLElement>('#host')!;
        host.removeAttribute('data-seed');
        trigger!.setAttribute('data-ok', 'no');
        expect(host.matches(`#host:has(#trigger ${artifact})`)).toBe(true);
        // Prove the dependent is safe at callback entry; the trigger is not.
        expect(translationStability.isTranslationCandidateCurrent({element: dependent!, kind: 'content',
            scope: 'content', reason: 'epoch-safe-entry'})).toBe(true);
        expect(translationStability.isTranslationCandidateCurrent({element: trigger!, kind: 'content',
            scope: 'content', reason: 'epoch-restore-trigger'})).toBe(false);
        const inspect = vi.spyOn(core, 'inspect');
        const restore = vi.spyOn(translationState, 'restoreTranslation');
        try {
            FixtureMutationObserver.instances.at(-1)!.emit([
                epochAttribute(flags[0]!, 'data-layout', 'safe-entry'),
                epochAttribute(flags[1]!, 'data-theme', 'after-real-restore'),
            ]);
            // The real restore removes the trigger artifact. A cached TRUE for
            // the dependent must not survive this DOM write in the same batch.
            expect(host.matches(`#host:has(#trigger ${artifact})`)).toBe(false);
            const dependentReads = inspect.mock.calls.flatMap(([owner], index) => owner === dependent
                ? [{order: inspect.mock.invocationCallOrder[index]!, candidate:
                    inspect.mock.results[index]!.value?.candidate?.element}] : []);
            const triggerRestore = restore.mock.calls.findIndex(([owner]) => owner === trigger);
            expect(triggerRestore).toBeGreaterThanOrEqual(0);
            const writeOrder = restore.mock.invocationCallOrder[triggerRestore]!;
            expect(dependentReads.some(read => read.order < writeOrder && read.candidate === dependent)).toBe(true);
            expect(dependentReads.some(read => read.order > writeOrder && !read.candidate)).toBe(true);
            for (let index = 0; index < owners.length; index += 1) {
                expect(getTranslationState(owners[index]!)).toBeUndefined();
                expect(previous[index]!.controller.signal.aborted).toBe(true);
                expect(owners[index]!.querySelector('[data-fr-translation-owned="true"]')).toBeNull();
            }
            expect(dependent!.textContent).toBe(source);
            expect(trigger!.textContent).toBe('A second actual owner controls the relation boundary.');
            expect(fixture.requests).toHaveBeenCalledTimes(providerCalls);
        } finally { inspect.mockRestore(); restore.mockRestore(); fixture.config.display = 1; }
    });

    it.each(['equivalent-text', 'edited-text'] as const)('OE-S2 %s replacement discards old Text/state and checks the next real generation afresh', async change => {
        fixture.config.display = 0;
        const {core, owners, flags} = epochFixture(
            `<main id="host"><i data-epoch-flag data-ready="yes"></i><i data-epoch-flag></i><i data-epoch-flag></i><p id="owner">${source}</p></main>`,
            ['main:has([data-ready="yes"]) > p'],
        );
        const owner = owners[0]!;
        const [previous] = await settleEpochOwners(owners);
        const oldText = previous!.singleTextSlotHosts![0]!.source;
        const oldSlot = previous!.singleTextSlotHosts![0]!.host;
        const nextSource = change === 'equivalent-text' ? source : 'The host supplied a different live source for the next translation generation.';
        const nextText = document.createTextNode(nextSource);
        const observer = FixtureMutationObserver.instances.at(-1)!;
        // Warm the earlier callback with a genuine successful read, rather
        // than merely constructing a state that has never been inspected.
        observer.emit(epochBurst(flags, 1));
        expect(getTranslationState(owner)).toBe(previous);
        owner.replaceChildren(nextText);
        observer.emit([{type: 'childList', target: owner, addedNodes: [nextText],
            removedNodes: [oldSlot]} as unknown as MutationRecord]);
        expect(oldText.isConnected).toBe(false);
        expect(previous!.controller.signal.aborted).toBe(true);
        expect(getTranslationState(owner)).toBeUndefined();
        expect(owner.firstChild).toBe(nextText);
        expect(owner.textContent).toBe(nextSource);
        await vi.advanceTimersByTimeAsync(3_000);
        const current = getTranslationState(owner)!;
        expect(current).toMatchObject({phase: 'translated', syntheticSegment: false, sourceText: nextSource});
        expect(current).not.toBe(previous);
        // Generation numbers are state-local; teardown increments the OLD
        // state's number. State identity and exact Text are the authority.
        expect(current.generation).toBeGreaterThan(0);
        expect(current.sourceTextNodes).toContain(nextText);
        expect(current.sourceTextNodes).not.toContain(oldText);
        expect(current.singleTextSlotHosts![0]!.source).toBe(nextText);
        expect(current.controller.signal.aborted).toBe(false);
        if (change === 'edited-text') expect(fixture.requests.mock.calls.some(([origins]) => origins.includes(nextSource))).toBe(true);
        const providerCalls = fixture.requests.mock.calls.length;
        const inspect = vi.spyOn(core, 'inspect');
        const nextSourceReads = spyEpochTextReads(nextText);
        try {
            observer.emit(epochBurst(flags, 2));
            expect(inspect.mock.calls.filter(([element]) => element === owner)).toHaveLength(1);
            expect(nextSourceReads.mock.contexts.filter(context => context === nextText).length).toBeGreaterThan(0);
            expect(getTranslationState(owner)).toBe(current);
            expect(owner.textContent).toBe(nextSource);
            expect(fixture.requests).toHaveBeenCalledTimes(providerCalls);
            // Even with unchanged text, a later callback's translate boundary
            // must be read again and remove this new generation's real slot.
            observer.emit([epochAttribute(document.querySelector('#host')!, 'translate', 'no')]);
            expect(getTranslationState(owner)).toBeUndefined();
            expect(current.controller.signal.aborted).toBe(true);
            expect(owner.querySelector('.fluent-read-single-slot')).toBeNull();
            expect(owner.firstChild).toBe(nextText);
            expect(owner.textContent).toBe(nextSource);
        } finally { inspect.mockRestore(); nextSourceReads.mockRestore(); fixture.config.display = 1; }
    });
});

describe('属性检查点排时与硬门禁的 ports 契约', () => {
    function batchFixture() {
        const {document} = parseHTML('<html><body><main><p>Readable source.</p><i></i></main></body></html>');
        const root = document.querySelector('main')!;
        const owner = document.querySelector<HTMLElement>('p')!;
        const flag = document.querySelector('i')!;
        const state = {syntheticSegment: false} as TranslationState;
        const states = new Map<HTMLElement, TranslationState>([[owner, state]]);
        const ports: AttributeMutationBatchPorts = {
            resolveTargets: vi.fn(element => element === root || element === owner ? [owner] : []),
            readState: vi.fn(target => states.get(target)),
            restoreOutsideScope: vi.fn(() => false),
            sourceIsCurrent: vi.fn(() => true),
            isArtifact: vi.fn(() => false),
            refreshSkeleton: vi.fn(() => false),
            restart: vi.fn(), rescan: vi.fn(), schedule: vi.fn(),
            isActive: vi.fn(() => true), hasTargetsOnlyAdapter: false,
        };
        const batch = createAttributeMutationBatch(ports);
        return {root, owner, flag, state, states, ports, batch};
    }

    it('不同目标的 class/style 只枚举一次影响根，合并边界意图且 flush 只消费一次', () => {
        const {root, owner, flag, state, ports, batch} = batchFixture();
        batch.process(root, flag, flag, 'class', true);
        batch.process(root, owner, owner, 'style', true);
        expect(ports.resolveTargets).toHaveBeenCalledTimes(1);
        expect(ports.schedule).not.toHaveBeenCalled();
        // 同根从站点规则变化降为普通布局变化仍须保留首次边界意图。
        batch.process(root, owner, owner, 'style', false);
        batch.process(root, flag, flag, 'class', false);
        expect(ports.resolveTargets).toHaveBeenCalledTimes(2);
        expect(ports.restoreOutsideScope).not.toHaveBeenCalled();
        batch.flush(); batch.flush();
        expect(ports.schedule).toHaveBeenCalledTimes(1);
        expect(ports.schedule).toHaveBeenCalledWith(owner, true);
        expect(ports.readState).toHaveReturnedWith(state);
    });

    it('无 owner 的根只做既有扫描，缓存空列表不额外扩展下一条兄弟的扫描边界', () => {
        const {root, owner, flag, ports, batch} = batchFixture();
        vi.mocked(ports.resolveTargets).mockReturnValue([]);
        batch.process(root, flag, flag, 'class', true);
        batch.process(root, owner, owner, 'style', true);
        expect(ports.rescan).toHaveBeenNthCalledWith(1, flag);
        expect(ports.rescan).toHaveBeenNthCalledWith(2, root);
        expect(ports.rescan).toHaveBeenNthCalledWith(3, root);
        batch.process(root, flag, flag, 'hidden', false);
        expect(ports.rescan).toHaveBeenLastCalledWith(flag);
        batch.flush();
        expect(ports.schedule).not.toHaveBeenCalled();
    });

    it('局部布局记录后出现站点规则变化时补上边界检查，新 state 不继承旧意图', () => {
        const {root, owner, flag, states, ports, batch} = batchFixture();
        batch.process(root, flag, flag, 'style', false);
        batch.process(root, flag, flag, 'class', true);
        batch.flush();
        expect(ports.schedule).toHaveBeenCalledTimes(1);
        expect(ports.schedule).toHaveBeenCalledWith(owner, true);
        vi.mocked(ports.schedule).mockClear();
        batch.invalidate(); batch.process(root, flag, flag, 'class', true);
        states.set(owner, {syntheticSegment: false} as TranslationState);
        batch.invalidate(); batch.process(root, flag, flag, 'style', false);
        batch.flush();
        expect(ports.schedule).toHaveBeenCalledTimes(1);
        expect(ports.schedule).toHaveBeenCalledWith(owner, false);
    });

    it.each(['synthetic', 'shell'] as const)('同根重复变化保留 %s owner 的逐记录即时门禁', kind => {
        const {root, owner, flag, state, ports, batch} = batchFixture();
        if (kind === 'synthetic') state.syntheticSegment = true;
        else state.allowTopLevelApplicationShell = true;
        batch.process(root, flag, flag, 'class', true);
        batch.process(root, flag, flag, 'style', true);
        expect(ports.restoreOutsideScope).toHaveBeenCalledTimes(2);
        expect(ports.resolveTargets).toHaveBeenCalledTimes(1);
        batch.flush();
        expect(ports.schedule).toHaveBeenCalledTimes(1);
        expect(ports.schedule).toHaveBeenCalledWith(owner, false);
    });

    it('即时恢复引发 invalidate 时不保存旧根快照，也不排时失效 owner', () => {
        const {root, owner, flag, state, states, ports, batch} = batchFixture();
        state.syntheticSegment = true;
        vi.mocked(ports.restoreOutsideScope).mockImplementation(() => {
            states.delete(owner); batch.invalidate(); return true;
        });
        batch.process(root, flag, flag, 'class', true);
        batch.process(root, flag, flag, 'style', true);
        expect(ports.resolveTargets).toHaveBeenCalledTimes(2);
        batch.flush();
        expect(ports.schedule).not.toHaveBeenCalled();
        expect(ports.restart).not.toHaveBeenCalled();
    });

    it('失去 state 的普通布局 owner 不产生延迟动作', () => {
        const {root, flag, states, ports, batch} = batchFixture();
        states.clear(); batch.process(root, flag, flag, 'style', false); batch.flush();
        expect(ports.schedule).not.toHaveBeenCalled();
        expect(ports.restoreOutsideScope).not.toHaveBeenCalled();
    });

    it.each(['inactive', 'detached', 'replaced-state'] as const)('%s 会在 flush 撤销当前回调的旧排时', change => {
        const {root, owner, flag, states, ports, batch} = batchFixture();
        batch.process(root, flag, flag, 'style', false);
        if (change === 'inactive') vi.mocked(ports.isActive).mockReturnValue(false);
        else if (change === 'detached') owner.remove();
        else states.set(owner, {syntheticSegment: false} as TranslationState);
        batch.flush();
        expect(ports.schedule).not.toHaveBeenCalled();
        vi.mocked(ports.isActive).mockReturnValue(true);
        batch.flush();
        expect(ports.schedule).not.toHaveBeenCalled();
    });

    it.each(['ordinary', 'synthetic'] as const)('非布局关系记录可保留来源稳定的间接 %s owner', kind => {
        const {root, flag, state, ports, batch} = batchFixture();
        state.syntheticSegment = kind === 'synthetic';
        batch.process(root, flag, flag, 'data-ready', true);
        expect(ports.restoreOutsideScope).toHaveBeenCalled();
        expect(ports.sourceIsCurrent).toHaveBeenCalled();
        expect(ports.restart).not.toHaveBeenCalled();
        expect(ports.refreshSkeleton).not.toHaveBeenCalled();
    });

    it('focus 模式不凭相同原文放过间接合成 owner 的资格变化', () => {
        const {root, owner, flag, state, ports, batch} = batchFixture();
        state.syntheticSegment = true; ports.hasTargetsOnlyAdapter = true;
        batch.process(root, flag, flag, 'data-ready', true);
        expect(ports.restart).toHaveBeenCalledTimes(1);
        expect(ports.restart).toHaveBeenCalledWith(owner);
        expect(ports.refreshSkeleton).not.toHaveBeenCalled();
    });

    it.each([true, false])('直属非布局来源变化先尝试骨架刷新（成功=%s）', success => {
        const {root, owner, ports, batch} = batchFixture();
        vi.mocked(ports.sourceIsCurrent).mockReturnValue(false);
        vi.mocked(ports.refreshSkeleton).mockReturnValue(success);
        batch.process(root, owner, owner, 'title', true);
        expect(ports.refreshSkeleton).toHaveBeenCalledTimes(1);
        expect(ports.restart).toHaveBeenCalledTimes(success ? 0 : 1);
    });

    it.each(['artifact', 'no-state', 'unchanged-direct'] as const)('非布局 %s 仍经即时重启路径处理', reason => {
        const {root, owner, states, ports, batch} = batchFixture();
        if (reason === 'artifact') vi.mocked(ports.isArtifact).mockReturnValue(true);
        else if (reason === 'no-state') states.clear();
        batch.process(root, owner, owner, null, false);
        expect(ports.refreshSkeleton).not.toHaveBeenCalled();
        expect(ports.restart).toHaveBeenCalledTimes(1);
        expect(ports.restart).toHaveBeenCalledWith(owner);
    });
});
