import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {parseHTML} from "linkedom";
import chinesePosts from './fixtures/chinese-language-posts.json';
import {isClearlyTargetLanguage} from '@/src/core/translation/text';
import type {TranslationSiteAdapter} from '@/src/core/translation/types';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import {compileSiteRulePack} from '@/src/core/site-adaptation/compiler';
import {collapseMutationRescanRoot, isOwnSyntheticSegmentMarkerMutation, mutationRootContains} from '@/src/features/full-page-translation/content/mutationObservation';

const runtime = vi.hoisted(() => ({
    realCore: null as TranslationCandidateCore | null,
    adapters: [] as TranslationSiteAdapter[],
    candidateEligible: vi.fn<(element: Element) => boolean>(() => true),
    ignoreMutation: vi.fn<(element: Element) => boolean>(() => false),
    candidates: [] as Array<{
        element: HTMLElement;
        kind: "content" | "control";
        reason: string;
        scope?: "content" | "all";
        nodes?: readonly Node[];
        adapterId?: string;
    }>,
    pointCandidate: null as {
        element: HTMLElement;
        kind: "content" | "control";
        reason: string;
        scope?: "content" | "all";
        nodes?: readonly Node[];
        adapterId?: string;
    } | null,
    requests: vi.fn<(origins: readonly string[]) => Promise<string[]>>(async (origins) =>
        origins.map((origin) => `译:${origin}`),
    ),
    requestOptions: [] as Array<Record<string, unknown>>,
    renderOptions: [] as Array<Record<string, unknown>>,
    parsedSlots: null as string[] | null,
    cancelQueue: vi.fn(),
    retryCallbacks: [] as Array<() => void>,
    config: {
        service: "microsoft",
        model: {microsoft: "microsoft-default", freeTranslation: "free-default"} as Record<string, string>,
        customModel: {} as Record<string, string>,
        modelThinking: {} as Record<string, Record<string, boolean>>,
        from: "en",
        to: "zh",
        useCache: true,
        enableAIContext: false,
        enableAIMultiSegment: false,
        display: 0,
        style: 0,
        fullPageTranslationMode: "viewport" as "viewport" | "all",
        translationScope: "content" as "content" | "all",
        maxConcurrentTranslations: 3,
    },
    ensureTranslationTruncationLayout: vi.fn(() => true),
    clearlyTargetLanguage: vi.fn<(value: string, targetLanguage: string) => boolean>(() => false),
}));

vi.mock("@/src/app/translation/check", () => ({checkConfig: () => true}));
vi.mock("@/src/core/config/catalog", () => ({
    services: {
        microsoft: "microsoft",
        freeTranslation: "freeTranslation",
        chromeTranslator: "chromeTranslator",
    },
    servicesType: {
        isUseAIContext: (service: string) => service === 'ai',
    },
    resolveConfiguredModel: (selected?: string, custom?: string) => selected === 'custom'
        ? custom || ''
        : selected || '',
}));
vi.mock("@/src/core/config/constants", () => ({
    styles: {singleTranslation: 0, bilingualTranslation: 1},
}));
vi.mock("@/src/services/config/store", () => ({
    config: runtime.config,
}));
vi.mock("@/src/core/language/detect", () => ({
    detectlang: () => "",
    shouldSkipTranslationForTarget: () => false,
}));
vi.mock("@/src/app/translation/client", () => ({
    translateText: async (origin: string, _context: string, options: Record<string, unknown>) => {
        runtime.requestOptions.push(options);
        return (await runtime.requests([origin]))[0];
    },
    translateTextBatch: (origins: readonly string[], _context: string, options: Record<string, unknown>) => {
        runtime.requestOptions.push(options);
        return runtime.requests(origins);
    },
}));
vi.mock("@/src/services/translation/queue", () => ({
    createTranslationQueueSession: () => ({}),
    cancelTranslationQueueSession: runtime.cancelQueue,
}));
vi.mock('@/src/features/full-page-translation/ui/translationIndicators', () => ({
    insertLoadingSpinner: (node: HTMLElement) => {
        const spinner = node.ownerDocument.createElement("span");
        spinner.className = "fluent-read-loading";
        spinner.setAttribute("data-fr-translation-owned", "true");
        node.appendChild(spinner);
        return spinner;
    },
    insertFailedTip: (node: HTMLElement, _message: string, onRetry: () => void) => {
        runtime.retryCallbacks.push(onRetry);
        return node.ownerDocument.createElement("span");
    },
}));
vi.mock("@/src/features/full-page-translation/content/renderer", () => ({
    appendSingleTranslationSlots: (
        node: HTMLElement,
        slots: readonly {node: Text; text: string}[],
        options: Record<string, unknown> = {},
    ) => slots.map((slot) => {
        const host = node.ownerDocument.createElement("span");
        host.className = "fluent-read-single-slot";
        host.setAttribute("data-fr-translation-owned", "true");
        host.setAttribute("translate", "no");
        host.setAttribute("aria-label", slot.text);
        host.lang = typeof options.targetLanguage === "string" ? options.targetLanguage : "";
        const shadow = host.attachShadow({mode: "open"});
        const translated = node.ownerDocument.createElement("span");
        translated.textContent = slot.text;
        shadow.appendChild(translated);
        slot.node.parentNode!.insertBefore(host, slot.node);
        host.appendChild(slot.node);
        return host;
    }),
    appendBilingualTranslation: (node: HTMLElement, text: string, options: Record<string, unknown> = {}) => {
        runtime.renderOptions.push(options);
        const wrapper = node.ownerDocument.createElement("span");
        wrapper.className = "fluent-read-bilingual-content";
        wrapper.setAttribute("data-fr-translation-owned", "true");
        wrapper.lang = typeof options.targetLanguage === 'string' ? options.targetLanguage : '';
        wrapper.textContent = text;
        node.appendChild(wrapper);
        return wrapper;
    },
    refreshBilingualTranslation: (
        _node: HTMLElement,
        wrapper: HTMLElement,
        text: string,
        options: Record<string, unknown> = {},
    ) => {
        runtime.renderOptions.push(options);
        wrapper.textContent = text;
        wrapper.lang = typeof options.targetLanguage === 'string' ? options.targetLanguage : '';
        return wrapper;
    },
}));
vi.mock("@/src/features/full-page-translation/content/layout", () => ({
    ensureTranslationTruncationLayout: runtime.ensureTranslationTruncationLayout,
}));
vi.mock("@/src/core/translation/public", () => {
    const protectedSelector = [
        "head", "script", "style", "noscript", "iframe", "input", "textarea", "select", "option",
        "math", "svg", "canvas", "audio", "video", "object", "template", "xmp", "pre", "code",
        "kbd", "samp", "var", "mjx-container", ".MathJax_Display", ".MathJax", ".MathJax_Preview",
        ".katex", ".notranslate", "[translate='no']", "[data-notranslate='true']", "[hidden]",
        "[inert]", "[aria-hidden='true']",
    ].join(",");
    const isProtected = (element: Element) => Boolean(element.closest(protectedSelector));
    const textSlots = (element: HTMLElement, keepOriginal?: (element: Element) => boolean) => {
        const isProtectedByAdapter = (element: Element) => {
            let current: Element | null = element;
            while (current) {
                if (keepOriginal?.(current)) return true;
                current = current.parentElement;
            }
            return false;
        };
        const slots: Array<{node: Text; prefix: string; source: string; suffix: string}> = [];
        const walker = element.ownerDocument.createTreeWalker(element, 4);
        let current = walker.nextNode();
        while (current) {
            const node = current as Text;
            const source = node.nodeValue ?? "";
            if (source.trim() && node.parentElement && !isProtected(node.parentElement) &&
                !isProtectedByAdapter(node.parentElement) && !node.parentElement.closest('[data-fr-translation-owned="true"]')) {
                slots.push({node, prefix: "", source, suffix: ""});
            }
            current = walker.nextNode();
        }
        return slots;
    };

    return {
        extractTranslationText: (element: HTMLElement, keepOriginal?: (element: Element) => boolean) =>
            textSlots(element, keepOriginal).map(({source}) => source).join(""),
        extractTranslationTextFromNodes: (nodes: readonly Node[]) =>
            nodes.map((node) => node.textContent ?? "").join(""),
        applyTranslationsToSnapshot: (_snapshot: unknown, translations: readonly string[]) => translations.join(""),
        collectLiveTranslationTextSlots: textSlots,
        createTranslationTextProtectionCache: () => new WeakMap<Element, {
            depth: number;
            protected: boolean;
        }>(),
        createTranslationSourceSnapshot: (element: HTMLElement, shouldStayOriginal?: (node: Element) => boolean) => ({
            slots: textSlots(element, shouldStayOriginal).map(({source}) => ({source})),
        }),
        evaluateHardGuard: (element: Element) => ({prune: isProtected(element)}),
        getComposedParent: (element: Element) => element.parentElement ??
            ((element.getRootNode?.() as {host?: Element})?.host ?? null),
        isProtectedDescendantElement: (element: Element) => element.matches(protectedSelector),
        isTranslationTextElementProtected: (element: Element) => isProtected(element),
        getCurrentTranslationCore: (scope = "content") => runtime.realCore ?? ({
            adapters: runtime.adapters,
            shouldStayOriginal: (element: Element) => (scope !== "all" && Boolean(element.closest("[data-content-excluded]"))) || runtime.adapters.some(adapter =>
                adapter.shouldStayOriginal?.(element, {url: new URL('https://example.com')})),
            shouldIgnoreMutation: runtime.ignoreMutation,
            inspect: (element: HTMLElement) => ({
                candidate: [...runtime.candidates].reverse().find((candidate) =>
                    (candidate.scope !== "all" || scope === "all") && candidate.element === element && !isProtected(candidate.element) && runtime.candidateEligible(element)),
            }),
            resolve: (start: Node | null | undefined) => [...runtime.candidates].reverse().find((candidate) => {
                if (!start || (candidate.scope === "all" && scope !== "all") || isProtected(candidate.element) || !runtime.candidateEligible(candidate.element)) return false;
                const key = candidate.nodes?.[0] ?? candidate.element;
                return key === start || candidate.element === start || candidate.element.contains(start);
            }),
            *discoverSteps() {
                for (const segment of document.querySelectorAll<HTMLElement>(
                    '[data-fr-translation-segment="true"]',
                )) {
                    yield {phase: "enter", element: segment};
                }
                for (const candidate of runtime.candidates) {
                    if (scope === "all") yield {phase: "enter", element: candidate.element};
                    if (candidate.scope === "all" && scope !== "all") continue;
                    if (isProtected(candidate.element) || !runtime.candidateEligible(candidate.element)) continue;
                    if (candidate.element.matches('[data-fr-translation-segment="true"]') ||
                        candidate.element.querySelector('[data-fr-translation-segment="true"]')) continue;
                    yield {
                        phase: "exit",
                        element: candidate.element,
                        candidate,
                    };
                }
            },
        }),
        getOpenShadowRoots: () => [],
        getTranslationCandidateKey: (candidate: {element: HTMLElement; nodes?: readonly Node[]}) =>
            candidate.nodes?.[0] ?? candidate.element,
        isClearlyTargetLanguage: (value: string, targetLanguage: string) =>
            runtime.clearlyTargetLanguage(value, targetLanguage),
        parseTranslationSlots: () => runtime.parsedSlots,
        resolveTranslationCandidate: (start: Node | null | undefined) =>
            [...runtime.candidates].reverse().find((candidate) => candidate.element === start),
        resolveTranslationCandidateAtPoint: (_x: number, _y: number, scope = 'content') => {
            const candidate = runtime.pointCandidate;
            if (!candidate || isProtected(candidate.element) || (candidate.scope === 'all' && scope !== 'all')) return null;
            return scope === 'all' ? {...candidate, scope: 'all'} : candidate;
        },
        selectPreferredTranslationCandidate: (
            existing: {element: HTMLElement; adapterId?: string},
            candidate: {element: HTMLElement; adapterId?: string},
        ) => candidate.adapterId ? candidate : existing,
        serializeTranslationSlots: (origins: readonly string[]) => ({
            payload: origins.map((origin, index) => [
                `___FLUENTREAD_test_${index}_BEGIN___`,
                origin,
                `___FLUENTREAD_test_${index}_END___`,
            ].join("\n")).join("\n"),
        }),
    };
});

import {
    autoTranslateEnglishPage,
    getFullPageTranslationFrameState,
    cancelPendingHoverTranslation,
    handleBilingualTranslation,
    handleTranslation,
    isFullPageTranslationActive,
    resetFullPageTranslationRouteState,
    restoreOriginalContent,
} from "@/src/features/full-page-translation/content/runtime";
import {getTranslationState} from "@/src/features/full-page-translation/content/state";
import {
    getFullPageTranslationProgress,
    subscribeFullPageTranslationProgress,
    type FullPageTranslationProgress,
} from '@/src/features/full-page-translation/progress';
import {
    captureFullPageTranslationConfig,
    clearFullPageTranslationRequestCache,
    getTranslationInvocationIdentity,
    translateTextSlots,
    type FullPageTranslationConfigSnapshot,
} from '@/src/features/full-page-translation/content/translationRequest';
import {
    createFullPageRequestSessionState,
    getHoverTranslationRequestSession,
    invalidateContextSensitiveRequestCache,
    invalidateFullPageRequestSessionCache,
    resetHoverTranslationRequestSession,
} from '@/src/features/full-page-translation/content/requestSession';
import type {TranslationQueueSession} from '@/src/services/translation/queue';

function singleTranslationText(owner: HTMLElement): string {
    return Array.from(owner.querySelectorAll<HTMLElement>('.fluent-read-single-slot'))
        .map((host) => host.getAttribute('aria-label') ?? '')
        .join('');
}

class TestIntersectionObserver {
    static instances: TestIntersectionObserver[] = [];

    readonly observed = new Set<Element>();
    readonly observe = vi.fn((target: Element) => this.observed.add(target));
    readonly unobserve = vi.fn((target: Element) => this.observed.delete(target));
    readonly disconnect = vi.fn(() => this.observed.clear());

    constructor(private readonly callback: IntersectionObserverCallback) {
        TestIntersectionObserver.instances.push(this);
    }

    emit(target: Element, isIntersecting: boolean): void {
        this.callback([{target, isIntersecting} as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
}

class TestMutationObserver {
    static instances: TestMutationObserver[] = [];

    readonly observe = vi.fn();
    readonly disconnect = vi.fn();
    readonly takeRecords = vi.fn(() => [] as MutationRecord[]);

    constructor(private readonly callback: MutationCallback) {
        TestMutationObserver.instances.push(this);
    }

    emit(records: MutationRecord[]): void {
        this.callback(records, this as unknown as MutationObserver);
    }
}

const replacedGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();

function replaceGlobal(name: PropertyKey, value: unknown): void {
    if (!replacedGlobals.has(name)) replacedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
}

function setLayoutBox(element: Element, width: number, height: number): void {
    const rect = {width, height, top: 0, right: width, bottom: height, left: 0, x: 0, y: 0};
    Object.defineProperty(element, "getClientRects", {
        configurable: true,
        value: () => width > 0 && height > 0
            ? Object.assign([rect], {item: (index: number) => index === 0 ? rect : null})
            : Object.assign([], {item: () => null}),
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, resolve, reject};
}

function translationSnapshot(
    overrides: Partial<FullPageTranslationConfigSnapshot> = {},
): FullPageTranslationConfigSnapshot {
    return {
        service: 'microsoft',
        model: 'microsoft-default',
        thinking: false,
        sourceLanguage: 'en',
        targetLanguage: 'zh',
        useCache: true,
        enableAIContext: false,
        enableAIMultiSegment: false,
        displayMode: 'bilingual',
        style: 0,
        ...overrides,
    };
}

async function finishScheduledWork(): Promise<void> {
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
}

async function waitForRequestCount(expected: number): Promise<void> {
    for (let attempt = 0; attempt < 20 && runtime.requests.mock.calls.length < expected; attempt += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1);
    }
    expect(runtime.requests).toHaveBeenCalledTimes(expected);
}

async function waitForObservedCandidateCount(
    observer: TestIntersectionObserver,
    expected: number,
): Promise<void> {
    for (let attempt = 0; attempt < 20 && observer.observed.size < expected; attempt += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(5);
    }
    expect(observer.observed.size).toBe(expected);
}

describe("全文翻译可见性锚点", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        runtime.candidates = [];
        runtime.pointCandidate = null;
        runtime.requests.mockReset();
        runtime.requests.mockImplementation(async (origins) => origins.map((origin) => `译:${origin}`));
        runtime.requestOptions = [];
        runtime.renderOptions = [];
        runtime.parsedSlots = null;
        runtime.cancelQueue.mockReset();
        runtime.retryCallbacks = [];
        runtime.config.service = "microsoft";
        runtime.config.model = {microsoft: "microsoft-default", freeTranslation: "free-default"};
        runtime.config.customModel = {};
        runtime.config.modelThinking = {};
        runtime.config.from = "en";
        runtime.config.to = "zh";
        runtime.config.useCache = true;
        runtime.config.enableAIContext = false;
        runtime.config.enableAIMultiSegment = false;
        runtime.config.display = 0;
        runtime.config.style = 0;
        runtime.config.fullPageTranslationMode = "viewport";
        runtime.config.translationScope = "content";
        runtime.config.maxConcurrentTranslations = 3;
        runtime.ensureTranslationTruncationLayout.mockClear();
        runtime.clearlyTargetLanguage.mockReset();
        runtime.clearlyTargetLanguage.mockReturnValue(false);
        TestIntersectionObserver.instances = [];
        TestMutationObserver.instances = [];
        runtime.adapters = [];
        runtime.realCore = null;
        runtime.candidateEligible.mockReset().mockReturnValue(true);
        runtime.ignoreMutation.mockReset().mockReturnValue(false);

        const {window, document} = parseHTML("<html><head><title>Fixture</title></head><body></body></html>");
        replaceGlobal("window", window);
        replaceGlobal("document", document);
        replaceGlobal("Node", window.Node);
        replaceGlobal("Element", window.Element);
        replaceGlobal("HTMLElement", window.HTMLElement);
        replaceGlobal("Text", window.Text);
        replaceGlobal("ShadowRoot", window.ShadowRoot);
        replaceGlobal("DOMParser", window.DOMParser);
        replaceGlobal("MutationObserver", TestMutationObserver);
        replaceGlobal("IntersectionObserver", TestIntersectionObserver);
        Object.defineProperty(window, "setTimeout", {configurable: true, value: globalThis.setTimeout});
        Object.defineProperty(window, "clearTimeout", {configurable: true, value: globalThis.clearTimeout});
    });

    afterEach(() => {
        restoreOriginalContent();
        vi.clearAllTimers();
        vi.useRealTimers();
        for (const [name, descriptor] of replacedGlobals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        replacedGlobals.clear();
    });

    it("Issue 422 保存识别范围后保留当前会话，恢复再翻译采用新范围且独立保留视口加载", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = '<p>Research paragraph.</p><nav><a href="/workflows">Workflows</a></nav>';
        const paragraph = document.querySelector<HTMLElement>('p')!;
        const link = document.querySelector<HTMLElement>('a')!;
        setLayoutBox(paragraph, 600, 90); setLayoutBox(link, 120, 30);
        runtime.candidates = [
            {element: paragraph, kind: 'content', reason: 'paragraph'},
            {element: link, kind: 'control', reason: 'menu', scope: 'all'},
        ];
        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        TestIntersectionObserver.instances[0]!.emit(paragraph, true);
        await finishScheduledWork();
        const wrapper = paragraph.querySelector('.fluent-read-bilingual-content');
        const originalSession = getFullPageTranslationFrameState();
        runtime.config.translationScope = 'all';
        runtime.config.to = 'ja';
        autoTranslateEnglishPage();
        await finishScheduledWork();
        expect(link.textContent).toBe('Workflows');
        expect(paragraph.querySelector('.fluent-read-bilingual-content')).toBe(wrapper);
        expect(getFullPageTranslationFrameState()).toMatchObject({
            scope: 'content', fullPageMode: 'viewport', sessionId: originalSession.sessionId,
            translationConfig: {targetLanguage: 'zh'},
        });
        restoreOriginalContent();
        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        expect(getFullPageTranslationFrameState()).toMatchObject({
            scope: 'all', fullPageMode: 'viewport', translationConfig: {targetLanguage: 'ja'},
        });
        expect(link.textContent).toBe('Workflows');
        TestIntersectionObserver.instances.at(-1)!.emit(link, true);
        await finishScheduledWork();
        expect(link.textContent).toBe('译:Workflows');
        expect(getTranslationState(link)?.scope).toBe('all');
        const translatedState = getTranslationState(link);
        link.setAttribute('class', 'host-navigation-link');
        TestMutationObserver.instances.at(-1)!.emit([{type: 'attributes', target: link,
            attributeName: 'class', oldValue: null, addedNodes: [], removedNodes: []} as unknown as MutationRecord]);
        await finishScheduledWork();
        expect(getTranslationState(link)).toBe(translatedState);
        expect(link.textContent).toBe('译:Workflows');
        expect(link.getAttribute('href')).toBe('/workflows');
        runtime.config.translationScope = 'content';
        autoTranslateEnglishPage();
        expect(link.textContent).toBe('译:Workflows');
        expect(getFullPageTranslationFrameState().scope).toBe('all');
        restoreOriginalContent();
        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        expect(getFullPageTranslationFrameState().scope).toBe('content');
        expect(TestIntersectionObserver.instances.at(-1)!.observed.has(link)).toBe(false);
        expect(link.textContent).toBe('Workflows');
    });

    it("Issue 422 保存全部节点后普通全文持续翻译动态菜单，并支持关闭后恢复和再次开启", async () => {
        runtime.config.translationScope = 'all';
        runtime.config.fullPageTranslationMode = 'all';
        document.body.innerHTML = '<nav><button>Open menu</button></nav>';
        const button = document.querySelector<HTMLElement>('button')!;
        const originalText = button.firstChild;
        setLayoutBox(button, 100, 30);
        runtime.candidates = [{element: button, kind: 'control', reason: 'menu', scope: 'all'}];
        autoTranslateEnglishPage();
        await finishScheduledWork();
        expect(button.textContent).toBe('译:Open menu');
        expect(button.firstChild).toBe(originalText);
        runtime.config.translationScope = 'content';
        const item = document.createElement('div'); item.setAttribute('role', 'menuitem'); item.textContent = 'Execute workflow';
        document.body.append(item); setLayoutBox(item, 200, 30);
        runtime.candidates.push({element: item, kind: 'control', reason: 'dynamic-menu', scope: 'all'});
        TestMutationObserver.instances.at(-1)!.emit([{
            type: 'childList', target: document.body, addedNodes: [item], removedNodes: [],
        } as unknown as MutationRecord]);
        await finishScheduledWork();
        expect(item.textContent).toBe('译:Execute workflow');
        restoreOriginalContent();
        expect(button.textContent).toBe('Open menu'); expect(item.textContent).toBe('Execute workflow');
        autoTranslateEnglishPage(); await finishScheduledWork();
        expect(button.textContent).toBe('Open menu'); expect(item.textContent).toBe('Execute workflow');
        restoreOriginalContent();
        runtime.config.translationScope = 'all';
        autoTranslateEnglishPage(); await finishScheduledWork();
        expect(button.textContent).toBe('译:Open menu'); expect(item.textContent).toBe('译:Execute workflow');
    });

    it("Issue 422 保存范围不取消在途请求，恢复后拒绝迟到的全部节点译文", async () => {
        runtime.config.display = 1;
        runtime.config.translationScope = 'all';
        runtime.config.fullPageTranslationMode = 'all';
        document.body.innerHTML = '<p>Pending paragraph.</p><button>Credentials</button>';
        const paragraph = document.querySelector<HTMLElement>('p')!;
        const button = document.querySelector<HTMLElement>('button')!;
        setLayoutBox(paragraph, 600, 90); setLayoutBox(button, 100, 30);
        runtime.candidates = [{element: paragraph, kind: 'content', reason: 'paragraph', scope: 'all'}, {element: button, kind: 'control', reason: 'menu', scope: 'all'}];
        const pendingParagraph = deferred<string[]>(); const pendingButton = deferred<string[]>();
        runtime.requests.mockReturnValueOnce(pendingParagraph.promise).mockReturnValueOnce(pendingButton.promise);
        autoTranslateEnglishPage(); await vi.advanceTimersByTimeAsync(50); await waitForRequestCount(2);
        const controller = getTranslationState(paragraph)!.controller;
        runtime.config.translationScope = 'content';
        autoTranslateEnglishPage();
        expect(controller.signal.aborted).toBe(false);
        pendingParagraph.resolve(['正文译文']); await vi.advanceTimersByTimeAsync(100);
        expect(paragraph.querySelector('.fluent-read-bilingual-content')?.textContent).toBe('正文译文');
        restoreOriginalContent(); pendingButton.resolve(['凭据']); await finishScheduledWork();
        expect(button.textContent).toBe('Credentials'); expect(paragraph.textContent).toBe('Pending paragraph.');
        expect(isFullPageTranslationActive()).toBe(false);
    });

    it("Issue 422 全部节点全文接管旧悬浮正文标签时改为原位控件，保留 Text 身份", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = '<div id="label">Research documents</div>';
        const label = document.querySelector<HTMLElement>('#label')!;
        const text = label.firstChild;
        setLayoutBox(label, 200, 30);
        runtime.candidates = [{element: label, kind: 'content', reason: 'generic-block'}];
        handleBilingualTranslation(label, false); await finishScheduledWork();
        expect(label.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
        runtime.candidates = [{element: label, kind: 'control', reason: 'application-label', scope: 'all'}];
        runtime.config.translationScope = 'all'; runtime.config.fullPageTranslationMode = 'all';
        autoTranslateEnglishPage(); await finishScheduledWork();
        expect(label.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(0);
        expect(label.textContent).toBe('译:Research documents');
        expect(label.firstChild).toBe(text);
        expect(getTranslationState(label)).toMatchObject({scope: 'all', kind: 'control'});
        restoreOriginalContent();
        expect(label.textContent).toBe('Research documents'); expect(label.firstChild).toBe(text);
    });

    it.each(['content', 'control'] as const)("Issue 422 全部节点全文扩大已有悬浮 %s 的可译槽，并保留旁边正文 owner", async (kind) => {
        runtime.config.display = 1;
        document.body.innerHTML = '<div id="target">Search <span data-content-excluded>Analysis completed</span></div><p id="prose">Stable paragraph.</p>';
        const target = document.querySelector<HTMLElement>('#target')!;
        const prose = document.querySelector<HTMLElement>('#prose')!;
        const label = target.querySelector('span')!;
        setLayoutBox(target, 250, 40); setLayoutBox(prose, 600, 90);
        runtime.candidates = [{element: target, kind, reason: 'adapter'}, {element: prose, kind: 'content', reason: 'paragraph'}];
        handleBilingualTranslation(target, false); handleBilingualTranslation(prose, false); await finishScheduledWork();
        expect(runtime.requests.mock.calls.flatMap(([sources]) => sources)).not.toContain('Analysis completed');
        const proseWrapper = prose.querySelector('.fluent-read-bilingual-content');
        runtime.candidates = [{element: target, kind, reason: 'expanded', scope: 'all'}, {element: prose, kind: 'content', reason: 'paragraph', scope: 'all'}];
        runtime.config.translationScope = 'all'; runtime.config.fullPageTranslationMode = 'all';
        autoTranslateEnglishPage(); await finishScheduledWork();
        expect(runtime.requests.mock.calls.flatMap(([sources]) => sources)).toContain('Analysis completed');
        expect(getTranslationState(target)?.scope).toBe('all');
        expect(prose.querySelector('.fluent-read-bilingual-content')).toBe(proseWrapper);
        if (kind === 'control') expect(label.textContent).toBe('译:Analysis completed');
        restoreOriginalContent();
        expect(target.textContent).toBe('Search Analysis completed'); expect(target.querySelector('span')).toBe(label);
    });

    it("Issue 422 全部节点全文保留已有悬浮正文，不为内部链接创建嵌套候选", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = '<p>Read <a href="/guide">the guide</a>.</p>';
        const paragraph = document.querySelector<HTMLElement>('p')!; const link = document.querySelector<HTMLElement>('a')!;
        setLayoutBox(paragraph, 600, 90); setLayoutBox(link, 100, 30);
        runtime.candidates = [{element: paragraph, kind: 'content', reason: 'paragraph'}, {element: link, kind: 'control', reason: 'inline link', scope: 'all'}];
        handleBilingualTranslation(paragraph, false); await finishScheduledWork();
        runtime.config.translationScope = 'all'; runtime.config.fullPageTranslationMode = 'all';
        autoTranslateEnglishPage(); await finishScheduledWork();
        expect(paragraph.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
        expect(link.textContent).toBe('the guide'); expect(getTranslationState(link)).toBeUndefined();
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it('Issue 422 延迟悬浮捕获触发时范围，关闭设置后下一手势恢复默认候选边界', async () => {
        document.body.innerHTML = '<button>Execute workflow</button>';
        const button = document.querySelector<HTMLElement>('button')!;
        const originalText = button.firstChild;
        setLayoutBox(button, 200, 30);
        runtime.pointCandidate = {element: button, kind: 'control', reason: 'button', scope: 'all'};
        runtime.candidates = [runtime.pointCandidate];
        handleTranslation(20, 20, {delayMs: 100});
        runtime.config.translationScope = 'all';
        await finishScheduledWork();
        expect(runtime.requests).not.toHaveBeenCalled();
        handleTranslation(20, 20, {delayMs: 100});
        runtime.config.translationScope = 'content';
        await finishScheduledWork();
        expect(button.textContent).toBe('译:Execute workflow');
        expect(getTranslationState(button)?.scope).toBe('all');
        restoreOriginalContent();
        expect(button.firstChild).toBe(originalText);
        handleTranslation(20, 20); await finishScheduledWork();
        expect(button.textContent).toBe('Execute workflow');
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        handleTranslation(20, 20, {scope: 'all'}); await finishScheduledWork();
        expect(button.textContent).toBe('译:Execute workflow');
    });

    it('Issue 422 全部节点设置仍保护输入内容，普通全文与悬浮只翻译旁边可见标签', async () => {
        runtime.config.translationScope = 'all'; runtime.config.fullPageTranslationMode = 'all';
        document.body.innerHTML = '<label>Search projects</label><input value="Private query"><textarea>Private draft</textarea><div translate="no">Private label</div>';
        const label = document.querySelector<HTMLElement>('label')!;
        const input = document.querySelector('input')!; const textarea = document.querySelector('textarea')!;
        const privateLabel = document.querySelector<HTMLElement>('div')!;
        for (const element of [label, input, textarea, privateLabel]) setLayoutBox(element, 200, 30);
        runtime.candidates = [label, input, textarea, privateLabel].map((element) => ({element, kind: 'control', reason: 'form label', scope: 'all'}));
        autoTranslateEnglishPage(); await finishScheduledWork();
        expect(label.textContent).toBe('译:Search projects');
        expect(input.value).toBe('Private query'); expect(textarea.value).toBe('Private draft'); expect(privateLabel.textContent).toBe('Private label');
        expect(runtime.requests.mock.calls.flatMap(([texts]) => texts)).toEqual(['Search projects']);
        restoreOriginalContent();
        for (const candidate of runtime.candidates.slice(1)) {
            runtime.pointCandidate = candidate; handleTranslation(20, 20); await finishScheduledWork();
        }
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it.each([['outside','loading'], ['segment','loading'], ['outside','translated'], ['segment','translated'], ['outside','error'], ['segment','error']] as const)(
        '全属性观察保持 %s 属性写入下的 %s mixed run 与邻居所有权', async (location, phase) => {
            // 广域重扫使用 performance 的冷却时钟；与本例 fake timers 一同推进。
            replaceGlobal('performance', {now: () => Date.now()});
            runtime.config.display = 1;
            runtime.config.fullPageTranslationMode = 'all';
            document.body.innerHTML = '<aside id="outside"></aside><section id="main"><div id="mixed">Readable inline prefix <strong id="emphasis">with emphasized prose.</strong><p id="nested">Independent block child with explanatory text.</p></div></section>';
            const host = document.querySelector<HTMLElement>('#mixed')!;
            const emphasis = document.querySelector<HTMLElement>('#emphasis')!;
            const nested = document.querySelector<HTMLElement>('#nested')!;
            const outside = document.querySelector<HTMLElement>('#outside')!;
            const sourceNodes = [host.firstChild as Text, emphasis];
            setLayoutBox(host, 640, 120);
            setLayoutBox(nested, 640, 50);
            runtime.adapters = [{id: 'broad-attribute-observer', matches: () => true,
                decide: () => ({kind:'pass'}), observedAttributes: null}];
            runtime.candidates = [
                {element:host, nodes:sourceNodes, kind:'content', reason:'inline-run'},
                {element:nested, kind:'content', reason:'independent-block'},
            ];
            const pending = deferred<string[]>();
            runtime.requests.mockImplementation(origins => pending.promise.then(() => origins.map(origin => `译:${origin}`)));
            autoTranslateEnglishPage();
            await vi.advanceTimersByTimeAsync(51);
            await waitForRequestCount(2);
            const segment = host.querySelector<HTMLElement>('[data-fr-translation-segment="true"]')!;
            const segmentState = getTranslationState(segment)!;
            const nestedState = getTranslationState(nested)!;
            expect(segmentState.syntheticSegment).toBe(true);
            if (phase === 'translated' || phase === 'error') {
                if (phase === 'translated') pending.resolve(['译文用于验证来源保持']);
                else pending.reject(new Error('fixture provider failure'));
                await finishScheduledWork();
            }
            expect(segmentState.phase).toBe(phase);
            const mutationTarget = location === 'outside' ? outside : segment;
            const attributeName = location === 'outside' ? 'data-unrelated-marker' : 'data-fr-translation-segment';
            mutationTarget.setAttribute(attributeName, 'true');
            TestMutationObserver.instances.at(-1)!.emit([{type:'attributes', target:mutationTarget, attributeName,
                oldValue:null, addedNodes:[], removedNodes:[]} as unknown as MutationRecord]);
            expect(segment.isConnected, 'intact synthetic source removed synchronously').toBe(true);
            expect(segmentState.controller.signal.aborted, 'unrelated attribute aborted exact mixed source').toBe(false);
            expect(nestedState.controller.signal.aborted, 'unrelated attribute aborted neighbor').toBe(false);
            expect(getTranslationState(segment)).toBe(segmentState);
            if (phase === 'loading') pending.resolve(['译文用于验证来源保持']);
            await finishScheduledWork();
            if (phase === 'error') {
                expect(getTranslationState(segment)?.phase).toBe('error');
                expect(getTranslationState(nested)?.phase).toBe('error');
            } else {
                expect(segment.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
                expect(nested.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
            }
            expect(runtime.requests).toHaveBeenCalledTimes(2);
        },
    );


    it.each(['protect', 'exclude', 'source-edit', 'forged-owner', 'removed-marker', 'moved-host', 'focus-boundary'] as const)(
        '全属性观察仍取消真实失效的 %s 来源，不放过同名标记伪装', async (change) => {
            // 广域重扫使用 performance 的冷却时钟；与本例 fake timers 一同推进。
            replaceGlobal('performance', {now: () => Date.now()});
            runtime.config.display = 1;
            runtime.config.fullPageTranslationMode = 'all';
            document.body.innerHTML = '<aside id="guard"><span id="flag"></span></aside><div id="mixed">Readable inline prefix <strong id="emphasis">with emphasized prose.</strong><p id="nested">Independent block explanation.</p></div><div id="other"></div>';
            const host = document.querySelector<HTMLElement>('#mixed')!;
            const emphasis = document.querySelector<HTMLElement>('#emphasis')!;
            const nested = document.querySelector<HTMLElement>('#nested')!;
            const flag = document.querySelector<HTMLElement>('#flag')!;
            const sourceNodes = [host.firstChild as Text, emphasis];
            setLayoutBox(host, 640, 120);
            setLayoutBox(nested, 640, 50);
            if (change === 'protect' || change === 'exclude') {
                runtime.adapters = compileSiteRulePack({version:1, rules:[{
                    id:'related-protection', name:'Related protection', match:{hosts:['example.com']},
                    mode:'augment', [change]:['#guard:has([data-block="yes"]) + #mixed'],
                }]});
                expect(runtime.adapters[0]!.observedAttributes).toBeNull();
            } else {
                runtime.adapters = [{id:'broad', matches:()=>true, decide:()=>({kind:'pass'}),
                    observedAttributes:null, genericCandidatePolicy:change === 'focus-boundary' ? 'targets-only' : 'allow'}];
            }
            runtime.candidates = change === 'forged-owner'
                ? [{element:nested, kind:'content', reason:'ordinary-paragraph'}]
                : [{element:host, nodes:sourceNodes, kind:'content', reason:'inline-run'},
                    {element:nested, kind:'content', reason:'nested-paragraph'}];
            const pending = deferred<void>();
            runtime.requests.mockImplementation(origins => pending.promise.then(() => origins.map(origin => `译:${origin}`)));
            autoTranslateEnglishPage();
            await vi.advanceTimersByTimeAsync(51);
            await waitForRequestCount(change === 'forged-owner' ? 1 : 2);
            const target = change === 'forged-owner' ? nested
                : host.querySelector<HTMLElement>('[data-fr-translation-segment="true"]')!;
            const previous = getTranslationState(target)!;
            expect(previous.phase).toBe('loading');
            let mutationTarget = target;
            let attributeName = 'data-fr-translation-segment';
            let oldValue: string | null = null;
            if (change === 'protect' || change === 'exclude') {
                flag.setAttribute('data-block','yes');
                expect(runtime.adapters[0]!.shouldStayOriginal!(host,{url:new URL('https://example.com')})).toBe(true);
                mutationTarget = flag; attributeName = 'data-block';
            } else if (change === 'source-edit') {
                sourceNodes[0]!.textContent = 'The host replaced this source text.';
            } else if (change === 'forged-owner') {
                target.setAttribute(attributeName,'true');
                expect(previous.syntheticSegment).toBe(false);
            } else if (change === 'removed-marker') {
                target.removeAttribute(attributeName); oldValue = 'true';
            } else if (change === 'moved-host') {
                document.querySelector('#other')!.appendChild(target);
            } else {
                mutationTarget = flag; attributeName = 'data-ready';
                flag.setAttribute(attributeName,'no');
                runtime.candidateEligible.mockReturnValue(false);
            }
            TestMutationObserver.instances.at(-1)!.emit([{type:'attributes', target:mutationTarget,
                attributeName, oldValue, addedNodes:[], removedNodes:[]} as unknown as MutationRecord]);
            expect(previous.controller.signal.aborted).toBe(true);
            expect(getTranslationState(target)).toBeUndefined();
            if (change !== 'forged-owner') expect(target.isConnected).toBe(false);
            pending.resolve();
            await finishScheduledWork();
            if (change !== 'forged-owner') expect(target.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(0);
        },
    );

    it('合成段标记判定先校验精确所有权，再延迟读取来源槽', () => {
        document.body.innerHTML = '<div id="host"><span id="segment" data-fr-translation-segment="true">Readable source.</span></div><div id="other"></div>';
        const host = document.querySelector<HTMLElement>('#host')!;
        const segment = document.querySelector<HTMLElement>('#segment')!;
        const other = document.querySelector<HTMLElement>('#other')!;
        const state = {syntheticSegment: true, syntheticHost: host};
        const mutation = {type: 'attributes', target: segment, attributeName: 'data-fr-translation-segment',
            oldValue: null} as unknown as MutationRecord;
        const sourceIsCurrent = vi.fn(() => true);
        for (const invalid of [
            {...mutation, type: 'childList'},
            {...mutation, attributeName: 'data-marker'},
            {...mutation, target: other},
            {...mutation, oldValue: 'false'},
        ]) expect(isOwnSyntheticSegmentMarkerMutation(invalid as MutationRecord, segment, state, sourceIsCurrent)).toBe(false);
        expect(isOwnSyntheticSegmentMarkerMutation(mutation, segment, {...state, syntheticSegment: false}, sourceIsCurrent)).toBe(false);
        expect(isOwnSyntheticSegmentMarkerMutation(mutation, segment, {...state, syntheticHost: other}, sourceIsCurrent)).toBe(false);
        segment.removeAttribute('data-fr-translation-segment');
        expect(isOwnSyntheticSegmentMarkerMutation(mutation, segment, state, sourceIsCurrent)).toBe(false);
        expect(sourceIsCurrent).not.toHaveBeenCalled();
        segment.setAttribute('data-fr-translation-segment', 'true');
        sourceIsCurrent.mockReturnValueOnce(false);
        expect(isOwnSyntheticSegmentMarkerMutation(mutation, segment, state, sourceIsCurrent)).toBe(false);
        expect(isOwnSyntheticSegmentMarkerMutation(mutation, segment, state, sourceIsCurrent)).toBe(true);
        expect(sourceIsCurrent).toHaveBeenCalledTimes(2);
    });

    it("全文会话集中发布启动和结束状态事件", () => {
        const states: string[] = [];
        document.addEventListener("fluentread-translation-started", () => states.push("started"));
        document.addEventListener("fluentread-translation-ended", () => states.push("ended"));

        autoTranslateEnglishPage();
        expect(isFullPageTranslationActive()).toBe(true);
        expect(states).toEqual(["started"]);

        restoreOriginalContent();
        expect(isFullPageTranslationActive()).toBe(false);
        expect(states).toEqual(["started", "ended"]);
    });

    it('脏根合并保留 document 与 ShadowRoot 边界，并对异常 contains 保守处理', () => {
        document.body.innerHTML = '<div id="root"><p>Paragraph.</p></div><div id="other"></div>';
        const root = document.querySelector('#root')!;
        const paragraph = root.querySelector('p')!;
        expect(mutationRootContains(root, root)).toBe(true);
        expect(mutationRootContains(root, paragraph)).toBe(true);
        expect(mutationRootContains(root, document.querySelector('#other')!)).toBe(false);
        expect(mutationRootContains({} as Node, paragraph)).toBe(false);
        expect(mutationRootContains({contains() { throw new Error('host contains unavailable'); }} as unknown as Node, paragraph)).toBe(false);
        expect(collapseMutationRescanRoot(paragraph)).toBe(document.documentElement);
        const shadow = root.attachShadow({mode: 'open'});
        shadow.innerHTML = '<p>Shadow paragraph.</p>';
        expect(collapseMutationRescanRoot(shadow.firstChild!)).toBe(shadow);
    });

    it("全文 observer 覆盖译文 wrapper 的完整外层属性快照", () => {
        autoTranslateEnglishPage();
        expect(TestMutationObserver.instances[0]!.observe).toHaveBeenCalledWith(
            document.documentElement,
            expect.objectContaining({
                attributes: true,
                attributeOldValue: true,
                attributeFilter: expect.arrayContaining([
                    "class", "style", "lang", "dir", "translate", "data-fr-translation-owned",
                ]),
            }),
        );
    });

    it('网站属性观察覆盖 id/data 属性，focus 目标失效后恢复已提交译文，即使进入 watchIgnore', async () => {
        runtime.config.fullPageTranslationMode = 'all';
        runtime.config.display = 1;
        document.body.innerHTML = '<article data-state="ready"><p id="published">Readable published sentence.</p></article>';
        const article = document.querySelector('article')!;
        const paragraph = document.querySelector<HTMLElement>('p')!;
        setLayoutBox(paragraph, 400, 50);
        runtime.adapters = [{id: 'site', matches: () => true, decide: () => ({kind: 'pass'}), observedAttributes: ['id', 'class', 'data-state']}];
        runtime.candidates = [{element: paragraph, kind: 'content', reason: 'site:content'}];
        runtime.candidateEligible.mockImplementation(() => article.getAttribute('data-state') === 'ready');
        runtime.ignoreMutation.mockImplementation((element) => element.getAttribute('data-state') === 'private');
        autoTranslateEnglishPage();
        await finishScheduledWork();
        const mutationObserver = TestMutationObserver.instances.at(-1)!;
        expect(mutationObserver.observe).toHaveBeenCalledWith(document.documentElement, expect.objectContaining({
            attributeFilter: expect.arrayContaining(['id', 'data-state']),
        }));
        const previous = getTranslationState(paragraph)!;
        expect(paragraph.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
        article.setAttribute('data-state', 'private');
        mutationObserver.emit([{
            type: 'attributes', target: article, attributeName: 'data-state', oldValue: 'ready',
            addedNodes: [] as unknown as NodeList, removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        expect(previous.controller.signal.aborted).toBe(true);
        expect(getTranslationState(paragraph)).toBeUndefined();
        expect(paragraph.textContent).toBe('Readable published sentence.');
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        article.setAttribute('data-state', 'ready');
        mutationObserver.emit([{
            type: 'attributes', target: article, attributeName: 'data-state', oldValue: 'private',
            addedNodes: [] as unknown as NodeList, removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await finishScheduledWork();
        expect(paragraph.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
    });

    it.each([
        ['augment', 'childList'], ['augment', 'attributes'],
        ['focus', 'childList'], ['focus', 'attributes'],
    ] as const)('真实 core 在 %s 规则的无关 %s 后保留已提交仅译文来源槽', async (mode, mutationType) => {
        runtime.config.fullPageTranslationMode = 'all';
        runtime.config.display = 0;
        document.body.innerHTML = '<main id="main"><div id="flag" data-ready="yes"></div><p id="prose">Readable commit message <strong>with emphasized English words.</strong></p></main>';
        const main = document.querySelector<HTMLElement>('#main')!;
        const flag = document.querySelector<HTMLElement>('#flag')!;
        const paragraph = document.querySelector<HTMLElement>('#prose')!;
        setLayoutBox(paragraph, 420, 60);
        runtime.realCore = new TranslationCandidateCore({url: new URL('https://example.com'), adapters: compileSiteRulePack({
            version: 1, rules: [{id: 'source-slots', name: 'Source slots', match: {hosts: ['example.com']}, mode,
                ...(mode === 'focus' ? {content: [{css: ['[data-ready="yes"] + p']}]} : {})}],
        })});
        autoTranslateEnglishPage();
        await finishScheduledWork();
        const state = getTranslationState(paragraph)!;
        expect(state.phase).toBe('translated');
        expect(state.singleTextSlotHosts).toHaveLength(2);
        // 普通发现必须继续跳过已有译文；只有状态复验可以使用真实来源 host。
        expect(runtime.realCore.inspect(paragraph).candidate).toBeNull();
        const observer = TestMutationObserver.instances.at(-1)!;
        for (let index = 0; index < 3; index += 1) {
            if (mutationType === 'childList') {
                const unrelated = document.createElement('i');
                main.appendChild(unrelated);
                observer.emit([{type: 'childList', target: main, addedNodes: [unrelated], removedNodes: []} as unknown as MutationRecord]);
            } else {
                const oldValue = flag.getAttribute('class');
                flag.className = `unrelated-${index}`;
                observer.emit([{type: 'attributes', target: flag, attributeName: 'class', oldValue,
                    addedNodes: [], removedNodes: []} as unknown as MutationRecord]);
            }
            expect(getTranslationState(paragraph)).toBe(state);
            await finishScheduledWork();
            expect(getTranslationState(paragraph)).toBe(state);
            expect(state.controller.signal.aborted).toBe(false);
            expect(paragraph.querySelectorAll('.fluent-read-single-slot')).toHaveLength(2);
        }
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        // 关系选择器和通用保护仍以当前宿主为准，不能靠原文相同绕过新的边界。
        const mutationTarget = mode === 'focus' ? flag : main;
        const attributeName = mode === 'focus' ? 'data-ready' : 'translate';
        const oldValue = mutationTarget.getAttribute(attributeName);
        mutationTarget.setAttribute(attributeName, 'no');
        observer.emit([{type: 'attributes', target: mutationTarget, attributeName, oldValue,
            addedNodes: [], removedNodes: []} as unknown as MutationRecord]);
        expect(getTranslationState(paragraph)).toBeUndefined();
        await finishScheduledWork();
        expect(paragraph.querySelectorAll('.fluent-read-single-slot')).toHaveLength(0);
        expect(paragraph.textContent).toBe('Readable commit message with emphasized English words.');
    });

    it.each(['hidden', 'notranslate', 'data-notranslate', 'source-edited', 'source-moved', 'extra-source'] as const)(
        '真实 core 的仅译文范围复验不信任 %s 来源槽', async (change) => {
            runtime.config.fullPageTranslationMode = 'all';
            runtime.config.display = 0;
            document.body.innerHTML = '<main><p>Readable commit message with enough English words.</p></main>';
            const main = document.querySelector<HTMLElement>('main')!;
            const paragraph = document.querySelector<HTMLElement>('p')!;
            setLayoutBox(paragraph, 420, 60);
            runtime.realCore = new TranslationCandidateCore({url: new URL('https://example.com'), adapters: compileSiteRulePack({
                version: 1, rules: [{id: 'source-slots', name: 'Source slots', match: {hosts: ['example.com']}, mode: 'augment'}],
            })});
            autoTranslateEnglishPage();
            await finishScheduledWork();
            const state = getTranslationState(paragraph)!;
            const {host, source} = state.singleTextSlotHosts![0]!;
            if (change === 'hidden') host.hidden = true;
            else if (change === 'notranslate') host.classList.add('notranslate');
            else if (change === 'data-notranslate') host.setAttribute('data-notranslate', 'true');
            else if (change === 'source-edited') source.data = 'A newly edited commit message.';
            else if (change === 'source-moved') {
                const replacement = host.cloneNode(false);
                host.replaceWith(replacement);
                replacement.appendChild(source);
            } else host.appendChild(document.createTextNode('Uncaptured additional source.'));
            const unrelated = document.createElement('i');
            main.appendChild(unrelated);
            TestMutationObserver.instances.at(-1)!.emit([{type: 'childList', target: main,
                addedNodes: [unrelated], removedNodes: []} as unknown as MutationRecord]);
            expect(state.controller.signal.aborted).toBe(true);
            expect(getTranslationState(paragraph)).toBeUndefined();
        },
    );

    it.each([[1, 'translated'], [1, 'loading'], [0, 'translated'], [0, 'loading']] as const)(
        'ShadowRoot 顶层兄弟属性变化会发现正文，并取消失去匹配的 display=%s %s 状态', async (display, phase) => {
            runtime.config.fullPageTranslationMode = 'all';
            runtime.config.display = display;
            document.body.innerHTML = '<div id="shadow-host"></div>';
            const host = document.querySelector('#shadow-host')!;
            const shadow = host.attachShadow({mode: 'open'});
            shadow.innerHTML = '<div id="flag" data-ready="no"></div><p id="shadow-prose">The shadow paragraph becomes readable when its sibling is ready.</p>';
            const flag = shadow.querySelector('#flag')!;
            const paragraph = shadow.querySelector<HTMLElement>('#shadow-prose')!;
            setLayoutBox(paragraph, 420, 60);
            runtime.realCore = new TranslationCandidateCore({url: new URL('https://example.com'), adapters: compileSiteRulePack({
                version: 1, rules: [{id: 'shadow-sibling', name: 'Shadow sibling', match: {hosts: ['example.com']},
                    mode: 'focus', content: [{css: ['[data-ready="yes"] + p']}]}],
            })});
            const request = deferred<string[]>();
            if (phase === 'loading') runtime.requests.mockReturnValueOnce(request.promise);
            autoTranslateEnglishPage();
            await finishScheduledWork();
            expect(runtime.requests).not.toHaveBeenCalled();
            const observer = TestMutationObserver.instances.at(-1)!;
            expect(observer.observe).toHaveBeenCalledWith(shadow, expect.objectContaining({
                attributeFilter: expect.arrayContaining(['data-ready']),
            }));
            const updateFlag = (value: string) => {
                const oldValue = flag.getAttribute('data-ready');
                flag.setAttribute('data-ready', value);
                observer.emit([{type: 'attributes', target: flag, attributeName: 'data-ready', oldValue,
                    addedNodes: [] as unknown as NodeList, removedNodes: [] as unknown as NodeList,
                } as unknown as MutationRecord]);
            };
            expect(flag.parentElement).toBeNull();
            updateFlag('yes');
            await vi.advanceTimersByTimeAsync(51);
            await waitForRequestCount(1);
            if (phase === 'translated') await finishScheduledWork();
            const state = getTranslationState(paragraph)!;
            expect(state.phase).toBe(phase);
            updateFlag('no');
            expect(state.controller.signal.aborted).toBe(true);
            expect(getTranslationState(paragraph)).toBeUndefined();
            if (phase === 'loading') request.resolve(['This stale result must never be rendered.']);
            await finishScheduledWork();
            expect(paragraph.textContent).toBe('The shadow paragraph becomes readable when its sibling is ready.');
            expect(paragraph.querySelectorAll('[data-fr-translation-owned="true"]')).toHaveLength(0);
            expect(runtime.requests).toHaveBeenCalledTimes(1);
        },
    );

    it.each([
        ['light', 'translated'], ['light', 'loading'], ['shadow', 'translated'], ['shadow', 'loading'],
    ] as const)('%s 树中删除选择器所需兄弟节点会取消 %s 正文，恢复兄弟后重新发现', async (tree, phase) => {
        runtime.config.fullPageTranslationMode = 'all';
        runtime.config.display = 1;
        document.body.innerHTML = '<div id="host"></div>';
        const host = document.querySelector<HTMLElement>('#host')!;
        const root = tree === 'shadow' ? host.attachShadow({mode: 'open'}) : host;
        root.innerHTML = '<div id="flag" data-ready="yes"></div><p id="prose">A paragraph is readable only while its preceding marker exists.</p>';
        const flag = root.querySelector('#flag')!;
        const paragraph = root.querySelector<HTMLElement>('#prose')!;
        setLayoutBox(paragraph, 420, 60);
        runtime.realCore = new TranslationCandidateCore({url: new URL('https://example.com'), adapters: compileSiteRulePack({
            version: 1, rules: [{id: 'structural-sibling', name: 'Structural sibling', match: {hosts: ['example.com']},
                mode: 'focus', content: [{css: ['[data-ready="yes"] + p']}]}],
        })});
        const request = deferred<string[]>();
        if (phase === 'loading') runtime.requests.mockReturnValueOnce(request.promise);
        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(51);
        await waitForRequestCount(1);
        if (phase === 'translated') await finishScheduledWork();
        const state = getTranslationState(paragraph)!;
        expect(state.phase).toBe(phase);
        const observer = TestMutationObserver.instances.at(-1)!;
        flag.remove();
        observer.emit([{type: 'childList', target: root, addedNodes: [] as unknown as NodeList,
            removedNodes: [flag] as unknown as NodeList} as unknown as MutationRecord]);
        expect(state.controller.signal.aborted).toBe(true);
        expect(getTranslationState(paragraph)).toBeUndefined();
        if (phase === 'loading') request.resolve(['A stale translation must not return.']);
        await finishScheduledWork();
        expect(paragraph.querySelectorAll('[data-fr-translation-owned="true"]')).toHaveLength(0);
        expect(paragraph.textContent).toBe('A paragraph is readable only while its preceding marker exists.');
        root.insertBefore(flag, paragraph);
        observer.emit([{type: 'childList', target: root, addedNodes: [flag] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList} as unknown as MutationRecord]);
        await finishScheduledWork();
        expect(getTranslationState(paragraph)?.phase).toBe('translated');
        expect(paragraph.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
    });

    it('自定义 id 属性改变会取消在途目标，迟到结果不能跨越新边界提交', async () => {
        runtime.config.fullPageTranslationMode = 'all';
        runtime.config.display = 1;
        document.body.innerHTML = '<p id="published">Pending published sentence.</p>';
        const paragraph = document.querySelector<HTMLElement>('p')!;
        setLayoutBox(paragraph, 400, 50);
        runtime.adapters = [{id: 'site', matches: () => true, decide: () => ({kind: 'pass'}), observedAttributes: ['id']}];
        runtime.candidates = [{element: paragraph, kind: 'content', reason: 'site:content'}];
        runtime.candidateEligible.mockImplementation((element) => element.id === 'published');
        const request = deferred<string[]>();
        runtime.requests.mockImplementationOnce(() => request.promise);
        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(51);
        await waitForRequestCount(1);
        const previous = getTranslationState(paragraph)!;
        expect(previous.phase).toBe('loading');
        paragraph.id = 'draft';
        TestMutationObserver.instances.at(-1)!.emit([{
            type: 'attributes', target: paragraph, attributeName: 'id', oldValue: 'published',
            addedNodes: [] as unknown as NodeList, removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        expect(previous.controller.signal.aborted).toBe(true);
        request.resolve(['迟到译文']);
        await finishScheduledWork();
        expect(getTranslationState(paragraph)).toBeUndefined();
        expect(paragraph.textContent).toBe('Pending published sentence.');
        expect(paragraph.querySelectorAll('[data-fr-translation-owned="true"]')).toHaveLength(0);
    });

    it('无法穷举选择器依赖时观察所有属性，并重新发现受兄弟状态影响的正文', async () => {
        // 广域重扫冷却与测试时钟必须同步，不能让假计时器等待真实时间流逝。
        replaceGlobal('performance', {now: () => Date.now()});
        runtime.config.fullPageTranslationMode = 'all';
        document.body.innerHTML = '<div id="trigger" data-switch="off"></div><section><p>Newly readable sentence.</p></section>';
        const trigger = document.querySelector('#trigger')!;
        const paragraph = document.querySelector<HTMLElement>('p')!;
        setLayoutBox(paragraph, 400, 50);
        runtime.adapters = [{id: 'complex', matches: () => true, decide: () => ({kind: 'pass'}), observedAttributes: null}];
        runtime.candidates = [{element: paragraph, kind: 'content', reason: 'site:content'}];
        runtime.candidateEligible.mockImplementation(() => trigger.getAttribute('data-switch') === 'on');
        runtime.ignoreMutation.mockReturnValue(true);
        autoTranslateEnglishPage();
        await finishScheduledWork();
        const mutationObserver = TestMutationObserver.instances.at(-1)!;
        expect(mutationObserver.observe.mock.calls[0]![1]).not.toHaveProperty('attributeFilter');
        expect(runtime.requests).not.toHaveBeenCalled();
        trigger.setAttribute('data-switch', 'on');
        mutationObserver.emit([{
            type: 'attributes', target: trigger, attributeName: 'data-switch', oldValue: 'off',
            addedNodes: [] as unknown as NodeList, removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(singleTranslationText(paragraph)).toBe('译:Newly readable sentence.');
    });

    it("控件翻译提交后的 spinner 记录不会取消刚完成的 generation", async () => {
        document.body.innerHTML = '<button id="save"><span aria-hidden="true">★</span><span>Save changes</span></button>';
        const button = document.querySelector<HTMLElement>('#save')!;
        const source = button.lastElementChild!.firstChild as Text;
        setLayoutBox(button, 160, 32);
        runtime.candidates = [{element: button, kind: 'control', reason: 'button'}];
        const pendingRequest = deferred<string[]>();
        runtime.requests.mockImplementationOnce(() => pendingRequest.promise);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        TestIntersectionObserver.instances[0]!.emit(button, true);
        await waitForRequestCount(1);

        const state = getTranslationState(button)!;
        const spinner = state.spinner!;
        expect(state.phase).toBe('loading');
        TestMutationObserver.instances.at(-1)!.emit([{
            type: 'childList', target: button,
            addedNodes: [spinner] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        expect(state.controller.signal.aborted).toBe(false);
        pendingRequest.resolve(['保存更改']);
        for (let attempt = 0; attempt < 20 && state.phase === 'loading'; attempt += 1) {
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(1);
        }
        expect(state.phase).toBe('translated');
        expect(state.spinner).toBeUndefined();
        expect(state.settledSpinner).toBe(spinner);
        expect(source.data).toBe('保存更改');

        TestMutationObserver.instances.at(-1)!.emit([
            {
                type: 'childList', target: button,
                addedNodes: [spinner] as unknown as NodeList,
                removedNodes: [] as unknown as NodeList,
            },
            {
                type: 'childList', target: button,
                addedNodes: [] as unknown as NodeList,
                removedNodes: [spinner] as unknown as NodeList,
            },
            {
                type: 'characterData', target: source,
                addedNodes: [] as unknown as NodeList,
                removedNodes: [] as unknown as NodeList,
            },
        ] as unknown as MutationRecord[]);
        await vi.advanceTimersByTimeAsync(600);

        expect(getTranslationState(button)).toBe(state);
        expect(state.controller.signal.aborted).toBe(false);
        expect(source.data).toBe('保存更改');
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it("仅译文内容提交后的延迟 spinner removal 不会失效 AI 上下文缓存", async () => {
        runtime.config.service = 'ai';
        runtime.config.model.ai = 'ai-model';
        runtime.config.enableAIContext = true;
        const sourceText = 'The same cached paragraph.';
        document.body.innerHTML = `<p id="first">${sourceText}</p><p id="second">${sourceText}</p>`;
        const first = document.querySelector<HTMLElement>('#first')!;
        const second = document.querySelector<HTMLElement>('#second')!;
        [first, second].forEach((node) => setLayoutBox(node, 500, 60));
        runtime.candidates = [first, second].map((element) => ({
            element,
            kind: 'content' as const,
            reason: 'paragraph',
        }));
        const pendingRequest = deferred<string[]>();
        runtime.requests.mockImplementationOnce(() => pendingRequest.promise);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const visibilityObserver = TestIntersectionObserver.instances[0]!;
        visibilityObserver.emit(first, true);
        await waitForRequestCount(1);

        const loadingState = getTranslationState(first)!;
        const loadingSpinner = loadingState.spinner!;
        TestMutationObserver.instances.at(-1)!.emit([{
            type: 'childList', target: first,
            addedNodes: [loadingSpinner] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        expect(loadingState.controller.signal.aborted).toBe(false);
        pendingRequest.resolve([`译:${sourceText}`]);
        await finishScheduledWork();

        const firstState = getTranslationState(first)!;
        const settledSpinner = firstState.settledSpinner!;
        expect(firstState).toMatchObject({phase: 'translated', mode: 'single'});
        expect(firstState.spinner).toBeUndefined();
        expect(settledSpinner.isConnected).toBe(false);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        TestMutationObserver.instances.at(-1)!.emit([{
            type: 'childList', target: first,
            addedNodes: [] as unknown as NodeList,
            removedNodes: [settledSpinner] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await vi.advanceTimersByTimeAsync(600);

        expect(getTranslationState(first)).toBe(firstState);
        visibilityObserver.emit(second, true);
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(singleTranslationText(second)).toBe(`译:${sourceText}`);
    });

    it('请求配置快照解析自定义模型并冻结单/双语展示模式', () => {
        runtime.config.model.microsoft = 'custom';
        runtime.config.customModel.microsoft = 'session-model';
        runtime.config.modelThinking.microsoft = {'session-model': true};
        runtime.config.display = 1;
        expect(captureFullPageTranslationConfig()).toMatchObject({
            service: 'microsoft',
            model: 'session-model',
            thinking: true,
            sourceLanguage: 'en',
            targetLanguage: 'zh',
            useCache: true,
            enableAIContext: false,
            enableAIMultiSegment: false,
            displayMode: 'bilingual',
        });
        runtime.config.display = 0;
        expect(captureFullPageTranslationConfig().displayMode).toBe('single');

        expect(captureFullPageTranslationConfig({
            service: 'freeTranslation',
            model: 'profile-model',
            targetLanguage: 'ja',
            displayMode: 'bilingual',
        })).toMatchObject({
            service: 'freeTranslation',
            model: 'profile-model',
            sourceLanguage: 'en',
            targetLanguage: 'ja',
            displayMode: 'bilingual',
        });
    });

    it('全文术语快照复制选库数组，版本或选择不同不能复用会话结果', async () => {
        const ids = ['technical'];
        const first = captureFullPageTranslationConfig({glossaryIds: ids});
        ids.push('later');
        expect(first.glossaryIds).toEqual(['technical']);
        expect(Object.isFrozen(first.glossaryIds)).toBe(true);
        const second = {...first, glossaryRevision: `glossary-v1:${'a'.repeat(64)}`};
        const disabled = {...second, glossaryIds: []};
        expect(getTranslationInvocationIdentity(first)).not.toBe(getTranslationInvocationIdentity(second));
        expect(getTranslationInvocationIdentity(second)).not.toBe(getTranslationInvocationIdentity(disabled));
        const session = {active: true, translationSlotCache: new Map(), translationRequestCache: new Map()};
        await translateTextSlots(['agent'], first, undefined, undefined, session);
        await translateTextSlots(['agent'], first, undefined, undefined, session);
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        await translateTextSlots(['agent'], second, undefined, undefined, session);
        await translateTextSlots(['agent'], disabled, undefined, undefined, session);
        expect(runtime.requests).toHaveBeenCalledTimes(3);
        expect(runtime.requestOptions.map(options => options.glossaryIds)).toEqual([['technical'], ['technical'], []]);
        clearFullPageTranslationRequestCache(session);
    });

    it('悬停快捷方案把独立服务、模型、语言和显示方式冻结到请求', async () => {
        document.body.innerHTML = '<p id="profile-target">Translate this with the selected profile.</p>';
        const paragraph = document.querySelector<HTMLElement>('#profile-target')!;
        const candidate = {element: paragraph, kind: 'content' as const, reason: 'paragraph'};
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;

        handleTranslation(20, 20, {
            profileId: 'hover-profile',
            service: 'freeTranslation',
            model: 'profile-model',
            targetLanguage: 'ja',
            displayMode: 'bilingual',
        });
        await finishScheduledWork();

        expect(runtime.requestOptions.at(-1)).toMatchObject({
            serviceOverride: 'freeTranslation',
            modelOverride: 'profile-model',
            sourceLanguage: 'en',
            targetLanguage: 'ja',
        });
        expect(paragraph.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
    });

    it('同一目标可由另一个快捷方案直接切换模型和显示方式', async () => {
        document.body.innerHTML = '<p id="profile-switch">Switch this translated paragraph.</p>';
        const paragraph = document.querySelector<HTMLElement>('#profile-switch')!;
        const candidate = {element: paragraph, kind: 'content' as const, reason: 'paragraph'};
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;

        handleTranslation(20, 20, {
            profileId: 'hover-a', service: 'freeTranslation', model: 'model-a',
            targetLanguage: 'ja', displayMode: 'bilingual',
        });
        await finishScheduledWork();
        handleTranslation(20, 20, {
            profileId: 'hover-b', service: 'freeTranslation', model: 'model-b',
            targetLanguage: 'fr', displayMode: 'single',
        });
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(2);
        expect(runtime.requestOptions.at(-1)).toMatchObject({
            serviceOverride: 'freeTranslation', modelOverride: 'model-b', targetLanguage: 'fr',
        });
        expect(getTranslationState(paragraph)).toMatchObject({phase: 'translated', mode: 'single'});
        expect(paragraph.querySelector('.fluent-read-bilingual-content')).toBeNull();
    });

    it('加载中的快捷方案可被另一方案抢占，旧请求晚到也不会覆盖新结果', async () => {
        document.body.innerHTML = '<p id="profile-race">Switch this request while it is still loading.</p>';
        const paragraph = document.querySelector<HTMLElement>('#profile-race')!;
        const candidate = {element: paragraph, kind: 'content' as const, reason: 'paragraph'};
        const firstRequest = deferred<string[]>();
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;
        runtime.requests.mockImplementationOnce(() => firstRequest.promise);

        handleTranslation(20, 20, {
            profileId: 'hover-loading-a', service: 'freeTranslation', model: 'model-a',
            targetLanguage: 'ja', displayMode: 'bilingual',
        });
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        const firstState = getTranslationState(paragraph)!;
        expect(firstState.phase).toBe('loading');

        handleTranslation(20, 20, {
            profileId: 'hover-loading-b', service: 'freeTranslation', model: 'model-b',
            targetLanguage: 'fr', displayMode: 'single',
        });
        await finishScheduledWork();

        expect(firstState.controller.signal.aborted).toBe(true);
        expect(runtime.requests).toHaveBeenCalledTimes(2);
        expect(runtime.requestOptions.at(-1)).toMatchObject({modelOverride: 'model-b', targetLanguage: 'fr'});
        expect(getTranslationState(paragraph)).toMatchObject({phase: 'translated', mode: 'single'});

        firstRequest.resolve(['旧方案译文']);
        await finishScheduledWork();
        expect(paragraph.textContent).not.toContain('旧方案译文');
        expect(getTranslationState(paragraph)).toMatchObject({phase: 'translated', mode: 'single'});
    });

    it('全文旧请求晚到不会注销快捷方案的新会话索引', async () => {
        runtime.config.fullPageTranslationMode = 'all';
        document.body.innerHTML = '<article id="ancestor"><p id="indexed-race">Keep the newest target indexed.</p></article>';
        const ancestor = document.querySelector<HTMLElement>('#ancestor')!;
        const paragraph = document.querySelector<HTMLElement>('#indexed-race')!;
        const candidate = {element: paragraph, kind: 'content' as const, reason: 'paragraph'};
        const firstRequest = deferred<string[]>();
        setLayoutBox(paragraph, 620, 96);
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;
        runtime.requests.mockImplementationOnce(() => firstRequest.promise);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(51);
        await Promise.resolve();
        const firstState = getTranslationState(paragraph)!;
        expect(firstState.phase).toBe('loading');

        handleTranslation(20, 20, {
            profileId: 'hover-index-owner', service: 'freeTranslation', model: 'model-b',
            targetLanguage: 'fr', displayMode: 'single',
        });
        await finishScheduledWork();
        expect(firstState.controller.signal.aborted).toBe(true);
        expect(getTranslationState(paragraph)).toMatchObject({phase: 'translated', mode: 'single'});

        firstRequest.resolve(['过期全文译文']);
        await finishScheduledWork();
        expect(paragraph.textContent).not.toContain('过期全文译文');
        expect(getTranslationState(paragraph)).toMatchObject({phase: 'translated', mode: 'single'});

        ancestor.setAttribute('translate', 'no');
        TestMutationObserver.instances.at(-1)!.emit([{
            type: 'attributes',
            target: ancestor,
            attributeName: 'translate',
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await finishScheduledWork();

        expect(getTranslationState(paragraph)).toBeUndefined();
        expect(paragraph.textContent).toBe('Keep the newest target indexed.');
    });

    it('仅译文 slot 遮住 core 候选时，同方案仍可恢复且不同方案可直接切换', async () => {
        document.body.innerHTML = '<p id="single-profile-switch">Restore or switch this translation.</p>';
        const paragraph = document.querySelector<HTMLElement>('#single-profile-switch')!;
        const candidate = {element: paragraph, kind: 'content' as const, reason: 'paragraph'};
        const firstInvocation = {
            profileId: 'hover-single-a', service: 'freeTranslation', model: 'model-a',
            targetLanguage: 'ja', displayMode: 'single' as const,
        };
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;

        handleTranslation(20, 20, firstInvocation);
        await finishScheduledWork();
        let slot = paragraph.querySelector<HTMLElement>('.fluent-read-single-slot')!;
        Object.defineProperty(document, 'elementsFromPoint', {configurable: true, value: () => [slot, paragraph]});
        runtime.pointCandidate = null;
        handleTranslation(20, 20, firstInvocation);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(getTranslationState(paragraph)).toBeUndefined();
        expect(paragraph.textContent).toBe('Restore or switch this translation.');

        runtime.pointCandidate = candidate;
        handleTranslation(20, 20, firstInvocation);
        await finishScheduledWork();
        slot = paragraph.querySelector<HTMLElement>('.fluent-read-single-slot')!;
        runtime.pointCandidate = null;
        handleTranslation(20, 20, {
            ...firstInvocation, profileId: 'hover-bilingual-b', model: 'model-b',
            targetLanguage: 'fr', displayMode: 'bilingual',
        });
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(3);
        expect(runtime.requestOptions.at(-1)).toMatchObject({modelOverride: 'model-b', targetLanguage: 'fr'});
        expect(getTranslationState(paragraph)).toMatchObject({phase: 'translated', mode: 'bilingual'});
    });

    it('文本槽请求覆盖空输入、非批量单槽、结构化解析和逐槽回退', async () => {
        const snapshot = translationSnapshot({service: 'custom-provider', model: ''});
        expect(await translateTextSlots([], snapshot)).toEqual([]);

        expect(await translateTextSlots(['Single'], snapshot)).toEqual(['译:Single']);
        expect(runtime.requestOptions.at(-1)).toMatchObject({
            serviceOverride: 'custom-provider',
            modelOverride: undefined,
            sourceLanguage: 'en',
            targetLanguage: 'zh',
        });

        runtime.parsedSlots = ['结构一', '结构二'];
        expect(await translateTextSlots(['One', 'Two'], snapshot)).toEqual(['结构一', '结构二']);

        runtime.parsedSlots = null;
        runtime.requests.mockClear();
        expect(await translateTextSlots(['One', undefined as never], snapshot)).toEqual(['译:One', '译:']);
        expect(runtime.requests).toHaveBeenCalledTimes(3);
        expect(await translateTextSlots([undefined as never], snapshot)).toEqual(['译:']);
    });

    it('调用身份区分 AI 上下文和跨段合批开关，但不受本地缓存开关影响', () => {
        const baseline = translationSnapshot();
        expect(getTranslationInvocationIdentity({...baseline, enableAIContext: true}))
            .not.toBe(getTranslationInvocationIdentity(baseline));
        expect(getTranslationInvocationIdentity({...baseline, enableAIMultiSegment: true}))
            .not.toBe(getTranslationInvocationIdentity(baseline));
        expect(getTranslationInvocationIdentity({...baseline, useCache: false}))
            .toBe(getTranslationInvocationIdentity(baseline));
    });

    it('Chrome auto 用纯文本槽检测源语言，但仍把带标记正文交给翻译器', async () => {
        const origins = ['Bonjour ', 'le monde.'];
        runtime.parsedSlots = ['你好，', '世界。'];

        await expect(translateTextSlots(origins, translationSnapshot({
            service: 'chromeTranslator',
            sourceLanguage: 'auto',
        }))).resolves.toEqual(['你好，', '世界。']);

        expect(runtime.requests).toHaveBeenCalledOnce();
        const translatedPayload = runtime.requests.mock.calls[0]?.[0]?.[0] ?? '';
        expect(translatedPayload).toContain('___FLUENTREAD_test_0_BEGIN___');
        expect(translatedPayload).toContain('___FLUENTREAD_test_1_END___');
        expect(runtime.requestOptions[0]).toMatchObject({
            serviceOverride: 'chromeTranslator',
            sourceLanguage: 'auto',
            skipLanguageDetection: true,
            sourceLanguageDetectionText: 'Bonjour \nle monde.',
        });

        runtime.requests.mockClear();
        runtime.requestOptions = [];
        await translateTextSlots(origins, translationSnapshot({
            service: 'chromeTranslator',
            sourceLanguage: 'fr',
        }));
        expect(runtime.requestOptions[0]).not.toHaveProperty('sourceLanguageDetectionText');

        runtime.requests.mockClear();
        runtime.requestOptions = [];
        await translateTextSlots(origins, translationSnapshot({
            service: 'custom-provider',
            sourceLanguage: 'auto',
        }));
        expect(runtime.requestOptions[0]).not.toHaveProperty('sourceLanguageDetectionText');
    });

    it('截图中文评论在真实语言判定下不进入批次，外语槽仍翻译且按原索引回填', async () => {
        runtime.clearlyTargetLanguage.mockImplementation(isClearlyTargetLanguage);
        const origins = [chinesePosts[0]!, 'English source', ...chinesePosts.slice(1), '這個軟體可以翻譯網頁。'];
        const snapshot = translationSnapshot({service: 'freeTranslation', targetLanguage: 'zh-Hans'});
        await expect(translateTextSlots(origins, snapshot)).resolves.toEqual(origins.map((text) =>
            chinesePosts.includes(text) ? text : `译:${text}`));
        expect(runtime.requests).toHaveBeenCalledOnce();
        expect(runtime.requests).toHaveBeenCalledWith(['English source', '這個軟體可以翻譯網頁。']);
        runtime.requests.mockClear();
        await expect(translateTextSlots(chinesePosts, snapshot)).resolves.toEqual(chinesePosts);
        expect(runtime.requests).not.toHaveBeenCalled();
    });

    it('文本槽在请求前保留目标语言与非文字内容，并按原索引回填译文', async () => {
        runtime.clearlyTargetLanguage.mockImplementation((value) =>
            value === '中文' || value === '≡' || value === '8');
        const snapshot = translationSnapshot({service: 'freeTranslation'});
        const session = {active: true, translationSlotCache: new Map()};

        await expect(translateTextSlots(
            ['English source', '中文', '≡', '8'],
            snapshot,
            undefined,
            undefined,
            session,
        )).resolves.toEqual(['译:English source', '中文', '≡', '8']);
        expect(runtime.requests).toHaveBeenCalledOnce();
        expect(runtime.requests).toHaveBeenCalledWith(['English source']);

        await expect(translateTextSlots(['中文', '≡', '8'], snapshot, undefined, undefined, session))
            .resolves.toEqual(['中文', '≡', '8']);
        expect(runtime.requests).toHaveBeenCalledOnce();

        runtime.requests.mockClear();
        await expect(translateTextSlots(
            [undefined as never, '中文'],
            snapshot,
            undefined,
            undefined,
            session,
        )).resolves.toEqual(['译:', '中文']);
        expect(runtime.requests).toHaveBeenCalledWith(['']);

        runtime.requests.mockResolvedValueOnce([]);
        await expect(translateTextSlots(
            ['Invalid batch', '中文'],
            snapshot,
            undefined,
            undefined,
            session,
        )).resolves.toEqual([]);

        runtime.requests.mockResolvedValueOnce([undefined as never]);
        await expect(translateTextSlots(
            ['Invalid item', '中文'],
            translationSnapshot({service: 'custom-provider'}),
        )).resolves.toEqual(['', '中文']);
    });

    it('AI 多段开关只在活跃全文会话中合并相邻候选，并遵守字符上限', async () => {
        const session = {active: true, translationSlotCache: new Map()};
        const enabled = translationSnapshot({
            service: 'ai',
            model: 'ai-model',
            enableAIMultiSegment: true,
        });

        const first = translateTextSlots(['First paragraph'], enabled, undefined, undefined, session);
        const second = translateTextSlots(['Second paragraph'], enabled, undefined, undefined, session);
        await expect(Promise.all([first, second])).resolves.toEqual([
            ['译:First paragraph'],
            ['译:Second paragraph'],
        ]);
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(runtime.requests).toHaveBeenLastCalledWith(['First paragraph', 'Second paragraph']);
        expect(runtime.requestOptions.at(-1)).toMatchObject({aiMultiSegment: true});

        runtime.requests.mockClear();
        const disabled = translationSnapshot({service: 'ai', model: 'ai-model'});
        await expect(Promise.all([
            translateTextSlots(['First paragraph'], disabled, undefined, undefined, session),
            translateTextSlots(['Second paragraph'], disabled, undefined, undefined, session),
        ])).resolves.toEqual([['译:First paragraph'], ['译:Second paragraph']]);
        expect(runtime.requests).toHaveBeenCalledTimes(2);

        runtime.requests.mockClear();
        const longFirst = 'A'.repeat(1_500);
        const longSecond = 'B'.repeat(600);
        await Promise.all([
            translateTextSlots([longFirst], enabled, undefined, undefined, session),
            translateTextSlots([longSecond], enabled, undefined, undefined, session),
        ]);
        expect(runtime.requests).toHaveBeenCalledTimes(2);
    });

    it('AI 多段按完整请求快照分批，并以四个文本槽为硬上限', async () => {
        const session = {active: true, translationSlotCache: new Map()};
        const firstModel = translationSnapshot({
            service: 'ai',
            model: 'first-model',
            enableAIMultiSegment: true,
        });
        const secondModel = translationSnapshot({
            service: 'ai',
            model: 'second-model',
            enableAIMultiSegment: true,
        });

        await expect(Promise.all([
            translateTextSlots(['First'], firstModel, undefined, undefined, session),
            translateTextSlots(['Second'], secondModel, undefined, undefined, session),
        ])).resolves.toEqual([['译:First'], ['译:Second']]);
        expect(runtime.requests).toHaveBeenCalledTimes(2);
        expect(runtime.requestOptions.map((options) => options.modelOverride)).toEqual([
            'first-model',
            'second-model',
        ]);

        runtime.requests.mockClear();
        runtime.requestOptions = [];
        const enabled = translationSnapshot({
            service: 'ai',
            model: 'ai-model',
            enableAIMultiSegment: true,
        });
        await expect(Promise.all([
            translateTextSlots(['A1', 'A2'], enabled, undefined, undefined, session),
            translateTextSlots(['B1', 'B2'], enabled, undefined, undefined, session),
            translateTextSlots(['C1'], enabled, undefined, undefined, session),
        ])).resolves.toEqual([
            ['译:A1', '译:A2'],
            ['译:B1', '译:B2'],
            ['译:C1'],
        ]);
        expect(runtime.requests.mock.calls.map(([origins]) => origins)).toEqual([
            ['A1', 'A2', 'B1', 'B2'],
            ['C1'],
        ]);
        expect(runtime.requestOptions[0]).toMatchObject({aiMultiSegment: true});
        expect(runtime.requestOptions[1]).not.toHaveProperty('aiMultiSegment');
    });

    it('AI 多段协议错误直接逐槽降级，且普通 provider 错误不放大请求', async () => {
        const session = {active: true, translationSlotCache: new Map()};
        const enabled = translationSnapshot({
            service: 'ai',
            model: 'ai-model',
            enableAIMultiSegment: true,
        });
        let requestCount = 0;
        runtime.requests.mockImplementation(async (origins) => {
            requestCount += 1;
            if (requestCount === 1) {
                throw {
                    kind: 'response',
                    code: 'AI_MULTI_SEGMENT_RESPONSE_INVALID',
                    message: 'localized message may change',
                };
            }
            return origins.map((origin) => `译:${origin}`);
        });

        await expect(Promise.all([
            translateTextSlots(['A1', 'A2'], enabled, undefined, undefined, session),
            translateTextSlots(['B1', 'B2'], enabled, undefined, undefined, session),
        ])).resolves.toEqual([
            ['译:A1', '译:A2'],
            ['译:B1', '译:B2'],
        ]);
        expect(runtime.requests).toHaveBeenCalledTimes(5);
        expect(runtime.requests.mock.calls[0]?.[0]).toEqual(['A1', 'A2', 'B1', 'B2']);
        expect(runtime.requests.mock.calls.slice(1).every(([origins]) => origins.length === 1)).toBe(true);

        runtime.requests.mockReset();
        runtime.requests.mockRejectedValue(new Error('provider unavailable'));
        const first = translateTextSlots(['First'], enabled, undefined, undefined, session);
        const second = translateTextSlots(['Second'], enabled, undefined, undefined, session);
        await expect(Promise.all([first, second])).rejects.toThrow('provider unavailable');
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it('AI 多段共享请求允许取消单个候选，剩余候选仍按原槽位取回结果', async () => {
        const session = {active: true, translationSlotCache: new Map()};
        const enabled = translationSnapshot({
            service: 'ai',
            model: 'ai-model',
            enableAIMultiSegment: true,
        });
        const provider = deferred<string[]>();
        runtime.requests.mockImplementation(() => provider.promise);
        const firstController = new AbortController();
        const secondController = new AbortController();
        const first = translateTextSlots(
            ['First'],
            enabled,
            firstController.signal,
            undefined,
            session,
        );
        const second = translateTextSlots(
            ['Second'],
            enabled,
            secondController.signal,
            undefined,
            session,
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        const sharedSignal = runtime.requestOptions[0]?.signal as AbortSignal;

        firstController.abort();
        await expect(first).rejects.toMatchObject({name: 'AbortError'});
        expect(sharedSignal.aborted).toBe(false);
        provider.resolve(['译:First', '译:Second']);
        await expect(second).resolves.toEqual(['译:Second']);
        expect(runtime.cancelQueue).not.toHaveBeenCalled();
    });

    it('AI 多段在 queueMicrotask 缺失时回退到 Promise 调度并转发单候选失败', async () => {
        replaceGlobal('queueMicrotask', undefined);
        const session = {active: true, translationSlotCache: new Map()};
        const enabled = translationSnapshot({
            service: 'ai',
            model: 'ai-model',
            enableAIMultiSegment: true,
        });
        runtime.requests.mockRejectedValueOnce(new Error('single candidate failed'));

        await expect(translateTextSlots(
            [undefined as never],
            enabled,
            undefined,
            undefined,
            session,
        )).rejects.toThrow('single candidate failed');
        expect(runtime.requests).toHaveBeenCalledWith(['']);
    });

    it('AI 多段刷新队列时丢弃已经取消的待处理任务', async () => {
        const session = {active: true, translationSlotCache: new Map()};
        const enabled = translationSnapshot({
            service: 'ai',
            model: 'ai-model',
            enableAIMultiSegment: true,
        });
        const controller = new AbortController();
        const result = translateTextSlots(
            ['Cancelled before flush'],
            enabled,
            controller.signal,
            undefined,
            session,
        );

        controller.abort();
        await expect(result).rejects.toMatchObject({name: 'AbortError'});
        await Promise.resolve();
        await Promise.resolve();
        expect(runtime.requests).not.toHaveBeenCalled();
    });

    it('AI 多段执行前再次检查信号并忽略已经取消的批次', async () => {
        const session = {active: true, translationSlotCache: new Map()};
        const enabled = translationSnapshot({
            service: 'ai',
            model: 'ai-model',
            enableAIMultiSegment: true,
        });
        let abortedReads = 0;
        let abortListener: (() => void) | undefined;
        const stagedSignal = {
            get aborted() {
                abortedReads += 1;
                return abortedReads >= 4;
            },
            addEventListener: (_type: string, listener: EventListener) => {
                abortListener = () => listener({type: 'abort'} as Event);
            },
            removeEventListener: vi.fn(),
        } as unknown as AbortSignal;

        const result = translateTextSlots(
            ['Cancelled before execution'],
            enabled,
            stagedSignal,
            undefined,
            session,
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(runtime.requests).not.toHaveBeenCalled();

        abortListener?.();
        await expect(result).rejects.toMatchObject({name: 'AbortError'});
    });

    it('AI 多段单候选执行读取调用方提交时的可变槽列表', async () => {
        const session = {active: true, translationSlotCache: new Map()};
        const enabled = translationSnapshot({
            service: 'ai',
            model: 'ai-model',
            enableAIMultiSegment: true,
        });
        const origins = ['Removed before execution'];
        const result = translateTextSlots(origins, enabled, undefined, undefined, session);

        origins.length = 0;
        await expect(result).resolves.toEqual([]);
        expect(runtime.requests).not.toHaveBeenCalled();
    });

    it('AI 多段共享请求在全部候选取消后终止底层批次', async () => {
        const session = {active: true, translationSlotCache: new Map()};
        const enabled = translationSnapshot({
            service: 'ai',
            model: 'ai-model',
            enableAIMultiSegment: true,
        });
        const provider = deferred<string[]>();
        runtime.requests.mockImplementation(() => provider.promise);
        const firstController = new AbortController();
        const secondController = new AbortController();
        const first = translateTextSlots(['First'], enabled, firstController.signal, undefined, session);
        const second = translateTextSlots(['Second'], enabled, secondController.signal, undefined, session);
        await Promise.resolve();
        await Promise.resolve();
        const sharedSignal = runtime.requestOptions[0]?.signal as AbortSignal;

        firstController.abort();
        secondController.abort();
        await expect(first).rejects.toMatchObject({name: 'AbortError'});
        await expect(second).rejects.toMatchObject({name: 'AbortError'});
        expect(sharedSignal.aborted).toBe(true);
        expect(runtime.cancelQueue).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({name: 'AbortError'}));

        const providerAbort = new Error('provider aborted');
        providerAbort.name = 'AbortError';
        provider.reject(providerAbort);
        await Promise.resolve();
    });

    it('AI 多段共享请求保留未取消候选的 AbortError 并跳过重复拒绝', async () => {
        const session = {active: true, translationSlotCache: new Map()};
        const enabled = translationSnapshot({
            service: 'ai',
            model: 'ai-model',
            enableAIMultiSegment: true,
        });
        const provider = deferred<string[]>();
        runtime.requests.mockImplementation(() => provider.promise);
        const firstController = new AbortController();
        const first = translateTextSlots(['First'], enabled, firstController.signal, undefined, session);
        const second = translateTextSlots(['Second'], enabled, undefined, undefined, session);
        await Promise.resolve();
        await Promise.resolve();

        firstController.abort();
        await expect(first).rejects.toMatchObject({name: 'AbortError'});
        const providerAbort = new Error('provider aborted');
        providerAbort.name = 'AbortError';
        provider.reject(providerAbort);
        await expect(second).rejects.toBe(providerAbort);
    });

    it('AI 多段共享请求将非对象 provider 失败原样传给所有候选', async () => {
        const session = {active: true, translationSlotCache: new Map()};
        const enabled = translationSnapshot({
            service: 'ai',
            model: 'ai-model',
            enableAIMultiSegment: true,
        });
        runtime.requests.mockRejectedValue('primitive provider failure');

        const first = translateTextSlots(['First'], enabled, undefined, undefined, session);
        const second = translateTextSlots(['Second'], enabled, undefined, undefined, session);
        await expect(first).rejects.toBe('primitive provider failure');
        await expect(second).rejects.toBe('primitive provider failure');
    });

    it('AI 多段协议回退隔离已取消候选并分别发布成功与失败结果', async () => {
        const session = {active: true, translationSlotCache: new Map()};
        const enabled = translationSnapshot({
            service: 'ai',
            model: 'ai-model',
            enableAIMultiSegment: true,
        });
        let abortedReads = 0;
        let abortListener: (() => void) | undefined;
        const stagedSignal = {
            get aborted() {
                abortedReads += 1;
                return abortedReads >= 5;
            },
            addEventListener: (_type: string, listener: EventListener) => {
                abortListener = () => listener({type: 'abort'} as Event);
            },
            removeEventListener: vi.fn(),
        } as unknown as AbortSignal;
        let requestCount = 0;
        runtime.requests.mockImplementation(async (origins) => {
            requestCount += 1;
            if (requestCount === 1) {
                throw {kind: 'response', code: 'AI_MULTI_SEGMENT_RESPONSE_INVALID'};
            }
            if (origins[0] === 'Broken') throw new Error('fallback slot failed');
            return origins.map((origin) => `译:${origin}`);
        });
        const nativeAllSettled = Promise.allSettled.bind(Promise);
        const allSettledSpy = vi.spyOn(Promise, 'allSettled').mockImplementation(async (values) => [
            ...await nativeAllSettled(values),
            {status: 'fulfilled', value: []},
        ] as never);

        try {
            const cancelled = translateTextSlots(['Cancelled'], enabled, stagedSignal, undefined, session);
            const broken = translateTextSlots(['Broken'], enabled, undefined, undefined, session);
            const healthy = translateTextSlots(['Healthy'], enabled, undefined, undefined, session);
            await expect(broken).rejects.toThrow('fallback slot failed');
            await expect(healthy).resolves.toEqual(['译:Healthy']);
            expect(runtime.requests).toHaveBeenCalledTimes(3);

            abortListener?.();
            await expect(cancelled).rejects.toMatchObject({name: 'AbortError'});
        } finally {
            allSettledSpy.mockRestore();
        }
    });

    it('逐槽回退在兄弟失败和调用方取消时终止整个队列', async () => {
        const snapshot = translationSnapshot({service: 'custom-provider'});
        const queueSession = {} as never;
        runtime.requests.mockImplementation(async (origins) => {
            if (origins[0] === 'Broken') throw new Error('slot failed');
            return origins.map((origin) => `译:${origin}`);
        });
        await expect(translateTextSlots(
            ['Broken', 'Healthy'],
            snapshot,
            undefined,
            queueSession,
        )).rejects.toThrow('slot failed');
        expect(runtime.cancelQueue).toHaveBeenCalledWith(queueSession, expect.any(Error));

        const alreadyAborted = new AbortController();
        alreadyAborted.abort();
        await expect(translateTextSlots(['Cancelled'], snapshot, alreadyAborted.signal))
            .rejects.toMatchObject({name: 'AbortError'});

        const controller = new AbortController();
        const slots = Array.from({length: 3}, () => deferred<string[]>());
        let requestIndex = 0;
        runtime.requests.mockImplementation(() => {
            requestIndex += 1;
            if (requestIndex === 1) return Promise.resolve(['combined packet']);
            return slots[requestIndex - 2]!.promise;
        });
        const cancelledFallback = translateTextSlots(
            ['One', 'Two', 'Three', 'Four'],
            snapshot,
            controller.signal,
            queueSession,
        );
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        controller.abort();
        slots.forEach((slot, index) => slot.resolve([`译:${index}`]));
        await expect(cancelledFallback).rejects.toMatchObject({name: 'AbortError'});

        replaceGlobal('DOMException', class ThrowingDomException {
            constructor() {
                throw new Error('DOMException unavailable');
            }
        } as unknown as typeof DOMException);
        await expect(translateTextSlots(['Cancelled'], snapshot, alreadyAborted.signal))
            .rejects.toMatchObject({name: 'AbortError'});
    });

    it('全文会话合并相同的在途请求，候选取消只停止自身等待', async () => {
        const snapshot = translationSnapshot({service: 'custom-provider', model: 'custom-model'});
        Object.defineProperty(document, 'location', {
            configurable: true,
            value: {href: 'https://example.test/first-route'},
        });
        const requestController = new AbortController();
        const session = {
            active: true,
            translationSlotCache: new Map(),
            translationRequestCache: new Map(),
            requestSignal: requestController.signal,
            requestQueueSessions: new Set<TranslationQueueSession>(),
            requestControllers: new Set<AbortController>(),
        };
        const provider = deferred<string[]>();
        runtime.requests.mockImplementation(() => provider.promise);
        const firstController = new AbortController();
        const secondController = new AbortController();

        const first = translateTextSlots(
            ['Remounted paragraph'],
            snapshot,
            firstController.signal,
            undefined,
            session,
        );
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        const providerSignal = runtime.requestOptions[0]?.signal as AbortSignal;
        expect(providerSignal).not.toBe(requestController.signal);
        expect([...session.requestControllers].map((controller) => controller.signal)).toContain(providerSignal);
        expect(session.requestQueueSessions.size).toBe(1);
        expect(runtime.requestOptions[0]?.queueSession).toBe([...session.requestQueueSessions][0]);

        firstController.abort();
        await expect(first).rejects.toMatchObject({name: 'AbortError'});
        expect(requestController.signal.aborted).toBe(false);

        // 框架重挂会短暂让 waiter 归零；宽限期内的新 owner 必须接管原请求。
        const second = translateTextSlots(
            ['Remounted paragraph'],
            snapshot,
            secondController.signal,
            undefined,
            session,
        );
        await vi.advanceTimersByTimeAsync(250);
        expect(providerSignal.aborted).toBe(false);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        provider.resolve(['重挂段落']);
        await expect(second).resolves.toEqual(['重挂段落']);
        expect(session.requestQueueSessions.size).toBe(0);
        await expect(translateTextSlots(
            ['Remounted paragraph'],
            snapshot,
            undefined,
            undefined,
            session,
        )).resolves.toEqual(['重挂段落']);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        // Thinking 会改变 provider 输出，必须进入会话级整请求缓存身份。
        await expect(translateTextSlots(
            ['Remounted paragraph'],
            {...snapshot, thinking: true},
            undefined,
            undefined,
            session,
        )).resolves.toEqual(['重挂段落']);
        expect(runtime.requests).toHaveBeenCalledTimes(2);

        // SPA 在相同标题下换路由时，页面上下文可能已经改变，不能复用上一 URL 的结果。
        document.location.href = 'https://example.test/second-route';
        await expect(translateTextSlots(
            ['Remounted paragraph'],
            snapshot,
            undefined,
            undefined,
            session,
        )).resolves.toEqual(['重挂段落']);
        expect(runtime.requests).toHaveBeenCalledTimes(3);
    });

    it('最后一个调用方离开且超过重挂宽限期后取消无消费者底层请求', async () => {
        const snapshot = translationSnapshot({service: 'custom-provider'});
        const sessionState = createFullPageRequestSessionState();
        const session = {active: true, translationSlotCache: new Map(), ...sessionState};
        const provider = deferred<string[]>();
        runtime.requests.mockImplementationOnce(() => provider.promise);
        const caller = new AbortController();

        const result = translateTextSlots(
            ['Removed before provider starts'],
            snapshot,
            caller.signal,
            undefined,
            session,
        );
        const providerSignal = runtime.requestOptions[0]?.signal as AbortSignal;
        expect(providerSignal.aborted).toBe(false);

        caller.abort();
        await expect(result).rejects.toMatchObject({name: 'AbortError'});
        await vi.advanceTimersByTimeAsync(249);
        expect(providerSignal.aborted).toBe(false);
        expect(runtime.cancelQueue).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(providerSignal.aborted).toBe(true);
        expect(runtime.cancelQueue).toHaveBeenCalledOnce();
        expect(session.translationRequestCache.size).toBe(0);

        const providerAbort = new Error('provider aborted');
        providerAbort.name = 'AbortError';
        provider.reject(providerAbort);
        await vi.waitFor(() => {
            expect(session.requestControllers.size).toBe(0);
            expect(session.requestQueueSessions.size).toBe(0);
        });
    });

    it('部分重叠批次不复用属于另一整请求取消域的未结算槽', async () => {
        const snapshot = translationSnapshot({service: 'microsoft'});
        const session = {
            active: true,
            translationSlotCache: new Map(),
            ...createFullPageRequestSessionState(),
        };
        const firstProvider = deferred<string[]>();
        const secondProvider = deferred<string[]>();
        runtime.requests
            .mockImplementationOnce(() => firstProvider.promise)
            .mockImplementationOnce(() => secondProvider.promise);
        const firstOwner = new AbortController();

        const first = translateTextSlots(
            ['Shared slot', 'First-only slot'],
            snapshot,
            firstOwner.signal,
            undefined,
            session,
        );
        const second = translateTextSlots(
            ['Shared slot', 'Second-only slot'],
            snapshot,
            undefined,
            undefined,
            session,
        );

        expect(runtime.requests).toHaveBeenNthCalledWith(1, ['Shared slot', 'First-only slot']);
        expect(runtime.requests).toHaveBeenNthCalledWith(2, ['Shared slot', 'Second-only slot']);
        const firstProviderSignal = runtime.requestOptions[0]?.signal as AbortSignal;
        const secondProviderSignal = runtime.requestOptions[1]?.signal as AbortSignal;

        firstOwner.abort();
        await expect(first).rejects.toMatchObject({name: 'AbortError'});
        await vi.advanceTimersByTimeAsync(250);
        expect(firstProviderSignal.aborted).toBe(true);
        expect(secondProviderSignal.aborted).toBe(false);

        const providerAbort = new Error('first provider aborted');
        providerAbort.name = 'AbortError';
        firstProvider.reject(providerAbort);
        secondProvider.resolve(['共享译文', '第二批译文']);
        await expect(second).resolves.toEqual(['共享译文', '第二批译文']);
    });

    it('已结束的全文会话信号在 provider 前中止请求并清除 AbortError 条目', async () => {
        const snapshot = translationSnapshot({service: 'custom-provider'});
        const requestController = new AbortController();
        requestController.abort();
        const session = {
            active: true,
            translationSlotCache: new Map(),
            translationRequestCache: new Map(),
            requestSignal: requestController.signal,
            requestQueueSessions: new Set<TranslationQueueSession>(),
            requestControllers: new Set<AbortController>(),
            pageContextGeneration: 0,
        };

        await expect(translateTextSlots(
            ['Must not reach provider'],
            snapshot,
            undefined,
            undefined,
            session,
        )).rejects.toMatchObject({name: 'AbortError'});
        expect(runtime.requests).not.toHaveBeenCalled();
        expect(session.translationRequestCache.size).toBe(0);
        expect(() => clearFullPageTranslationRequestCache({})).not.toThrow();
    });

    it('AI 页面上下文代次变化后不复用相同 URL 与原文的旧会话结果', async () => {
        const snapshot = translationSnapshot({
            service: 'ai',
            model: 'ai-model',
            enableAIContext: true,
        });
        const session = {
            active: true,
            translationSlotCache: new Map(),
            translationConfig: snapshot,
            ...createFullPageRequestSessionState(),
        };

        await expect(translateTextSlots(
            ['Context-sensitive paragraph'],
            snapshot,
            undefined,
            undefined,
            session,
        )).resolves.toEqual(['译:Context-sensitive paragraph']);
        await expect(translateTextSlots(
            ['Context-sensitive paragraph'],
            snapshot,
            undefined,
            undefined,
            session,
        )).resolves.toEqual(['译:Context-sensitive paragraph']);
        expect(runtime.requests).toHaveBeenCalledOnce();

        invalidateContextSensitiveRequestCache(session);
        expect(session.pageContextGeneration).toBe(1);
        expect(session.translationRequestCache.size).toBe(0);

        await expect(translateTextSlots(
            ['Context-sensitive paragraph'],
            snapshot,
            undefined,
            undefined,
            session,
        )).resolves.toEqual(['译:Context-sensitive paragraph']);
        expect(runtime.requests).toHaveBeenCalledTimes(2);
    });

    it('AI 页面上下文变化保留失败墓碑，只有显式清理才允许再次请求', async () => {
        const snapshot = translationSnapshot({
            service: 'ai',
            model: 'ai-model',
            enableAIContext: true,
        });
        const session = {
            active: true,
            translationSlotCache: new Map(),
            translationConfig: snapshot,
            ...createFullPageRequestSessionState(),
        };
        runtime.requests.mockRejectedValue(new Error('provider unavailable'));

        await expect(translateTextSlots(
            ['Failed context-sensitive paragraph'], snapshot, undefined, undefined, session,
        )).rejects.toThrow('provider unavailable');
        expect(runtime.requests).toHaveBeenCalledOnce();

        invalidateContextSensitiveRequestCache(session);
        await expect(translateTextSlots(
            ['Failed context-sensitive paragraph'], snapshot, undefined, undefined, session,
        )).rejects.toThrow('provider unavailable');
        expect(runtime.requests).toHaveBeenCalledOnce();

        invalidateFullPageRequestSessionCache(session);
        await expect(translateTextSlots(
            ['Failed context-sensitive paragraph'], snapshot, undefined, undefined, session,
        )).rejects.toThrow('provider unavailable');
        expect(runtime.requests).toHaveBeenCalledTimes(2);
    });

    it('用户清理缓存后旧在途结果可以返回当前 owner，但不会重新进入会话缓存', async () => {
        const snapshot = translationSnapshot({service: 'custom-provider'});
        const session = {
            active: true,
            translationSlotCache: new Map(),
            ...createFullPageRequestSessionState(),
        };
        const provider = deferred<string[]>();
        runtime.requests.mockImplementationOnce(() => provider.promise);

        const beforeClear = translateTextSlots(
            ['Pending during explicit cache clear'],
            snapshot,
            undefined,
            undefined,
            session,
        );
        expect(session.translationRequestCache.size).toBe(1);

        invalidateFullPageRequestSessionCache(session);
        expect(session.pageContextGeneration).toBe(1);
        expect(session.translationRequestCache.size).toBe(0);

        provider.resolve(['清理前已开始的结果']);
        await expect(beforeClear).resolves.toEqual(['清理前已开始的结果']);
        expect(session.translationRequestCache.size).toBe(0);

        await expect(translateTextSlots(
            ['Pending during explicit cache clear'],
            snapshot,
            undefined,
            undefined,
            session,
        )).resolves.toEqual(['译:Pending during explicit cache clear']);
        expect(runtime.requests).toHaveBeenCalledTimes(2);
    });

    it('全文请求缓存淘汰最旧请求，且过期失败不能删除同 key 的新条目', async () => {
        const snapshot = translationSnapshot({service: 'custom-provider'});
        const requestController = new AbortController();
        const session = {
            active: true,
            translationSlotCache: new Map(),
            translationRequestCache: new Map(),
            requestSignal: requestController.signal,
            requestQueueSessions: new Set<TranslationQueueSession>(),
            requestControllers: new Set<AbortController>(),
        };
        const stale = deferred<string[]>();
        runtime.requests.mockImplementationOnce(() => stale.promise);

        const staleResult = translateTextSlots(['Stale request'], snapshot, undefined, undefined, session);
        await Promise.all(Array.from({length: 512}, (_, index) =>
            translateTextSlots([`Fresh request ${index}`], snapshot, undefined, undefined, session)));

        expect(session.translationRequestCache.size).toBe(512);
        expect(runtime.requests).toHaveBeenCalledTimes(513);
        await expect(translateTextSlots(
            ['Stale request'],
            snapshot,
            undefined,
            undefined,
            session,
        )).resolves.toEqual(['译:Stale request']);
        expect(runtime.requests).toHaveBeenCalledTimes(514);

        stale.reject(new Error('stale request failed'));
        await expect(staleResult).rejects.toThrow('stale request failed');
        await expect(translateTextSlots(
            ['Stale request'],
            snapshot,
            undefined,
            undefined,
            session,
        )).resolves.toEqual(['译:Stale request']);
        expect(runtime.requests).toHaveBeenCalledTimes(514);

        runtime.requests.mockClear();
        runtime.requests.mockRejectedValueOnce(new Error('current request failed'));
        const failedSession = {
            active: true,
            translationSlotCache: new Map(),
            translationRequestCache: new Map(),
            requestSignal: new AbortController().signal,
            requestQueueSessions: new Set<TranslationQueueSession>(),
            requestControllers: new Set<AbortController>(),
        };
        await expect(translateTextSlots(
            ['Retry after failure'],
            snapshot,
            undefined,
            undefined,
            failedSession,
        )).rejects.toThrow('current request failed');
        expect(failedSession.translationRequestCache.size).toBe(1);

        await expect(translateTextSlots(
            ['Retry after failure'],
            snapshot,
            undefined,
            undefined,
            failedSession,
        )).rejects.toThrow('current request failed');
        expect(runtime.requests).toHaveBeenCalledOnce();

        await expect(translateTextSlots(
            ['Retry after failure'],
            snapshot,
            undefined,
            undefined,
            failedSession,
            true,
        )).resolves.toEqual(['译:Retry after failure']);
        expect(runtime.requests).toHaveBeenCalledTimes(2);
    });

    it('批量会话按配置去重、复用、校验异常响应并限制缓存容量', async () => {
        const snapshot = translationSnapshot({service: 'freeTranslation'});
        const session = {active: true, translationSlotCache: new Map()};
        expect(await translateTextSlots(['Same', 'Same'], snapshot, undefined, {} as never, session))
            .toEqual(['译:Same', '译:Same']);
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(session.translationSlotCache.size).toBe(1);
        expect(runtime.requestOptions.at(-1)).toMatchObject({useCache: true});

        await translateTextSlots(['Same'], snapshot, undefined, undefined, session);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        runtime.requests.mockResolvedValueOnce([]);
        expect(await translateTextSlots(['Invalid'], snapshot, undefined, undefined, session)).toEqual([]);
        expect(session.translationSlotCache.size).toBe(0);

        runtime.requests.mockResolvedValueOnce([42] as never);
        expect(await translateTextSlots(['Non-string'], snapshot, undefined, undefined, session)).toEqual([]);
        expect(session.translationSlotCache.size).toBe(0);

        runtime.requests.mockRejectedValueOnce(new Error('current request failed'));
        await expect(translateTextSlots(['Rejected'], snapshot, undefined, undefined, session))
            .rejects.toThrow('current request failed');
        expect(session.translationSlotCache.size).toBe(0);

        const manyOrigins = Array.from({length: 513}, (_, index) => `Slot ${index}`);
        runtime.requests.mockImplementationOnce(async (origins) => origins.map((origin) => `译:${origin}`));
        expect(await translateTextSlots(manyOrigins, snapshot, undefined, undefined, session)).toHaveLength(513);
        expect(session.translationSlotCache.size).toBe(512);

        const inactiveSession = {active: false, translationSlotCache: new Map()};
        await translateTextSlots(['Inactive'], snapshot, undefined, undefined, inactiveSession);
        expect(inactiveSession.translationSlotCache.size).toBe(0);
        expect(runtime.requestOptions.at(-1)).toMatchObject({useCache: false});
    });

    it('同一槽的并发请求只允许最新缓存条目改变 settled 或执行失败清理', async () => {
        const snapshot = translationSnapshot();
        const session = {active: true, translationSlotCache: new Map()};
        const oldRequest = deferred<string[]>();
        const newRequest = deferred<string[]>();
        runtime.requests.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
        const oldResult = translateTextSlots(['Concurrent'], snapshot, undefined, undefined, session);
        const newResult = translateTextSlots(['Concurrent'], snapshot, undefined, undefined, session);
        oldRequest.resolve(['旧结果']);
        await expect(oldResult).resolves.toEqual(['旧结果']);
        newRequest.resolve(['新结果']);
        await expect(newResult).resolves.toEqual(['新结果']);
        expect(session.translationSlotCache.size).toBe(1);

        const staleFailure = deferred<string[]>();
        const replacement = deferred<string[]>();
        runtime.requests.mockReturnValueOnce(staleFailure.promise).mockReturnValueOnce(replacement.promise);
        const rejected = translateTextSlots(['Retry'], snapshot, undefined, undefined, session);
        const accepted = translateTextSlots(['Retry'], snapshot, undefined, undefined, session);
        staleFailure.reject(new Error('stale request failed'));
        await expect(rejected).rejects.toThrow('stale request failed');
        replacement.resolve(['恢复结果']);
        await expect(accepted).resolves.toEqual(['恢复结果']);
        expect(session.translationSlotCache.size).toBe(2);
    });

    it.each([
        {label: "默认参数", invocation: undefined},
        {label: "显式 continuous=false", invocation: {delayMs: 40, continuous: false}},
    ] as const)("$label 的单次悬浮调用恢复全文中的当前段落，且不会被当前会话重新排队", async ({invocation}) => {
        runtime.config.display = 1;
        document.body.innerHTML = '<p id="prose">Restore only this paragraph.</p>';
        const paragraph = document.querySelector<HTMLElement>("#prose")!;
        const candidate = {element: paragraph, kind: "content" as const, reason: "paragraph"};
        setLayoutBox(paragraph, 640, 90);
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        TestIntersectionObserver.instances[0]!.emit(paragraph, true);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(paragraph.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);

        // 真实 Control 释放与显式 continuous=false 都是单次切换：
        // 恢复当前目标，但保持全文会话活跃。
        if (invocation) handleTranslation(20, 20, invocation);
        else handleTranslation(20, 20);
        await finishScheduledWork();

        expect(isFullPageTranslationActive()).toBe(true);
        expect(getTranslationState(paragraph)).toBeUndefined();
        expect(paragraph.textContent).toBe("Restore only this paragraph.");
        expect(paragraph.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(0);

        // 浏览器会把扩展恢复操作作为 mutation 送达；重扫必须记住显式取消，不能再次翻译。
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "childList",
            target: paragraph,
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(paragraph.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(0);

        // 取消只限定在当前会话；启动新的全文会话后仍允许再次翻译该段落。
        restoreOriginalContent();
        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        TestIntersectionObserver.instances.at(-1)!.emit(paragraph, true);
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(2);
    });

    it.each([
        {label: "0ms", delayMs: 0},
        {label: "120ms", delayMs: 120},
    ] as const)("$label continuous=true 连续悬浮重复命中已译句子时保持状态、译文节点和请求稳定", async ({delayMs}) => {
        runtime.config.display = 1;
        document.body.innerHTML = '<article data-testid="tweet"><div id="tweet-text" data-testid="tweetText">Hovering across this translated X post stays stable.</div></article>';
        const tweetText = document.querySelector<HTMLElement>("#tweet-text")!;
        const candidate = {element: tweetText, kind: "content" as const, reason: "x-post-text", adapterId: "x"};
        setLayoutBox(tweetText, 620, 96);
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        TestIntersectionObserver.instances[0]!.emit(tweetText, true);
        await finishScheduledWork();

        const wrapper = tweetText.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        const state = getTranslationState(tweetText)!;
        expect(state.phase).toBe("translated");
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        for (const y of [20, 34]) {
            handleTranslation(20, y, {delayMs, continuous: true});
            await finishScheduledWork();

            expect(isFullPageTranslationActive()).toBe(true);
            expect(getTranslationState(tweetText)).toBe(state);
            expect(wrapper.isConnected).toBe(true);
            expect(tweetText.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
            expect(tweetText.querySelector(".fluent-read-bilingual-content")).toBe(wrapper);
            expect(runtime.requests).toHaveBeenCalledTimes(1);
        }
    });

    it("超深候选的有界结构快照溢出后，连续悬浮仍保持同一译文且不重复请求", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = '<div id="deep-hover"></div>';
        const owner = document.querySelector<HTMLElement>('#deep-hover')!;
        let deepest = owner;
        for (let depth = 0; depth < 140; depth += 1) {
            const child = document.createElement('span');
            deepest.appendChild(child);
            deepest = child;
        }
        deepest.textContent = 'Deep hover source remains stable.';
        const candidate = {element: owner, kind: 'content' as const, reason: 'deep-prose'};
        setLayoutBox(owner, 620, 96);
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;

        handleTranslation(20, 20, {continuous: true});
        await finishScheduledWork();
        const state = getTranslationState(owner)!;
        const wrapper = owner.querySelector<HTMLElement>('.fluent-read-bilingual-content')!;
        expect(state.sourceStructureSignature).toBe('overflow');
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        for (const y of [24, 36, 48]) {
            handleTranslation(20, y, {continuous: true});
            await finishScheduledWork();
            expect(getTranslationState(owner)).toBe(state);
            expect(owner.querySelector('.fluent-read-bilingual-content')).toBe(wrapper);
            expect(runtime.requests).toHaveBeenCalledTimes(1);
        }
    });

    it.each([
        {label: "0ms", delayMs: 0},
        {label: "120ms", delayMs: 120},
    ] as const)("$label continuous=true 从原文开始时只翻译一次，后续命中保持同一译文", async ({delayMs}) => {
        runtime.config.display = 1;
        document.body.innerHTML = '<p id="prose">Continuous hover translates this source once.</p>';
        const paragraph = document.querySelector<HTMLElement>("#prose")!;
        const candidate = {element: paragraph, kind: "content" as const, reason: "paragraph"};
        setLayoutBox(paragraph, 620, 96);
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;

        handleTranslation(20, 20, {delayMs, continuous: true});
        if (delayMs > 0) {
            await vi.advanceTimersByTimeAsync(delayMs - 1);
            expect(runtime.requests).not.toHaveBeenCalled();
            expect(getTranslationState(paragraph)).toBeUndefined();
            await vi.advanceTimersByTimeAsync(1);
        }
        await finishScheduledWork();

        const state = getTranslationState(paragraph)!;
        const wrapper = paragraph.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        expect(state.phase).toBe("translated");
        expect(wrapper.isConnected).toBe(true);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        handleTranslation(20, 34, {delayMs, continuous: true});
        await finishScheduledWork();
        expect(getTranslationState(paragraph)).toBe(state);
        expect(paragraph.querySelector(".fluent-read-bilingual-content")).toBe(wrapper);
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it("仅悬停双语 owner 的 wrapper 被宿主删除后，continuous=true 立即修复译文且不重新请求", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = '<p id="hover-only-remount">Repair the missing hover translation in place.</p>';
        const paragraph = document.querySelector<HTMLElement>("#hover-only-remount")!;
        const source = paragraph.textContent!;
        const candidate = {element: paragraph, kind: "content" as const, reason: "paragraph"};
        setLayoutBox(paragraph, 620, 96);
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;

        handleTranslation(20, 20, {delayMs: 0, continuous: true});
        await finishScheduledWork();

        const firstState = getTranslationState(paragraph)!;
        const firstWrapper = paragraph.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        expect(firstState).toMatchObject({phase: "translated", mode: "bilingual", sourceText: source});
        expect(firstWrapper).toBeTruthy();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        // React/Preact 可能保留原 owner，但在 commit 时删除不属于其虚拟树的译文子节点。
        // 连续悬停再次命中该 owner 时，不能只因 WeakMap 里仍是 translated 就提前返回。
        firstWrapper.remove();
        expect(firstWrapper.isConnected).toBe(false);
        expect(getTranslationState(paragraph)).toBe(firstState);

        handleTranslation(20, 34, {delayMs: 0, continuous: true});
        await finishScheduledWork();

        expect(getTranslationState(paragraph)).toMatchObject({
            phase: "translated",
            mode: "bilingual",
            sourceText: source,
        });
        expect(paragraph.querySelectorAll(":scope > .fluent-read-bilingual-content")).toHaveLength(1);
        expect(paragraph.textContent).toContain(`译:${source}`);
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it("240Hz 级连续 pointer task 重挂 source-only owner 时始终保留译文", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = '<p id="hover-hostile">Host rejection must converge.</p>';
        const paragraph = document.querySelector<HTMLElement>("#hover-hostile")!;
        const candidate = {element: paragraph, kind: "content" as const, reason: "paragraph"};
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;

        handleTranslation(20, 20, {continuous: true});
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        for (let rejection = 0; rejection < 8; rejection += 1) {
            paragraph.querySelector(".fluent-read-bilingual-content")?.remove();
            await vi.advanceTimersByTimeAsync(4);
            handleTranslation(20, 20, {continuous: true});
            await finishScheduledWork();
            expect(paragraph.querySelectorAll(".fluent-read-bilingual-content"))
                .toHaveLength(1);
        }
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(getTranslationState(paragraph)?.phase).toBe('translated');
        expect(paragraph.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
    });

    it("纯 hover 请求未决时整块 owner 连续重挂复用同一 provider 请求并只在最新 owner 提交", async () => {
        runtime.config.display = 1;
        const source = "Pending hover translation follows the live owner.";
        document.body.innerHTML = `<p id="pending-hover">${source}</p>`;
        let current = document.querySelector<HTMLElement>("#pending-hover")!;
        setLayoutBox(current, 620, 96);
        runtime.pointCandidate = {element: current, kind: "content", reason: "paragraph"};
        runtime.candidates = [runtime.pointCandidate];
        const provider = deferred<string[]>();
        runtime.requests.mockImplementation(() => provider.promise);

        handleTranslation(20, 20, {delayMs: 0, continuous: true});
        await waitForRequestCount(1);
        expect(current.querySelectorAll('.fluent-read-loading')).toHaveLength(1);

        const previousOwners: HTMLElement[] = [];
        for (let remount = 1; remount <= 2; remount += 1) {
            const removed = current;
            previousOwners.push(removed);
            const replacement = document.createElement('p');
            replacement.id = `pending-hover-${remount}`;
            replacement.textContent = source;
            setLayoutBox(replacement, 620, 96);
            removed.replaceWith(replacement);
            current = replacement;
            runtime.pointCandidate = {element: current, kind: 'content', reason: 'paragraph'};
            runtime.candidates = [runtime.pointCandidate];

            handleTranslation(20, 20, {delayMs: 0, continuous: true});
            await vi.runOnlyPendingTimersAsync();
            await Promise.resolve();
            await Promise.resolve();
            expect(runtime.requests).toHaveBeenCalledTimes(1);
            expect(current.querySelectorAll('.fluent-read-loading')).toHaveLength(1);
        }

        provider.resolve([`译:${source}`]);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        previousOwners.forEach((owner) => expect(getTranslationState(owner)).toBeUndefined());
        expect(getTranslationState(current)?.phase).toBe('translated');
        expect(current.querySelectorAll('.fluent-read-loading')).toHaveLength(0);
        expect(current.querySelectorAll(':scope > .fluent-read-bilingual-content')).toHaveLength(1);
        expect(current.textContent).toContain(`译:${source}`);
    });

    it("全文会话 A 活跃时显式 hover 配置 B 的译文仍可跨 owner 重挂原子接管", async () => {
        runtime.config.display = 1;
        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);

        const source = 'Explicit hover profile survives an unrelated full-page session.';
        const previous = document.createElement('p');
        previous.textContent = source;
        document.body.appendChild(previous);
        setLayoutBox(previous, 620, 96);
        runtime.pointCandidate = {element: previous, kind: 'content', reason: 'paragraph'};
        runtime.candidates = [runtime.pointCandidate];
        const hoverInvocation = {
            continuous: true,
            profileId: 'hover-profile-b',
            service: 'freeTranslation',
            model: 'hover-model-b',
            targetLanguage: 'fr',
            displayMode: 'bilingual' as const,
        };

        handleTranslation(20, 20, hoverInvocation);
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(previous.querySelector('.fluent-read-bilingual-content')?.getAttribute('lang')).toBe('fr');

        const replacement = document.createElement('p');
        replacement.textContent = source;
        setLayoutBox(replacement, 620, 96);
        previous.replaceWith(replacement);
        runtime.candidates = [{element: replacement, kind: 'content', reason: 'paragraph'}];
        TestMutationObserver.instances[0]!.emit([{
            type: 'childList', target: document.body,
            addedNodes: [replacement] as unknown as NodeList,
            removedNodes: [previous] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(getTranslationState(previous)).toBeUndefined();
        expect(getTranslationState(replacement)?.phase).toBe('translated');
        expect(replacement.querySelectorAll(':scope > .fluent-read-bilingual-content')).toHaveLength(1);
        expect(replacement.querySelector('.fluent-read-bilingual-content')?.getAttribute('lang')).toBe('fr');
    });

    it("熔断墓碑随目标语言和样式配置换代，新配置可立即重新翻译", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = '<p id="route-slot">Same configuration slot source.</p>';
        const paragraph = document.querySelector<HTMLElement>('#route-slot')!;
        const candidate = {element: paragraph, kind: 'content' as const, reason: 'paragraph'};
        setLayoutBox(paragraph, 620, 96);
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        TestIntersectionObserver.instances[0]!.emit(paragraph, true);
        await finishScheduledWork();
        const mutationObserver = TestMutationObserver.instances.at(-1)!;
        for (let rejection = 0; rejection < 4; rejection += 1) {
            const wrapper = paragraph.querySelector<HTMLElement>('.fluent-read-bilingual-content')!;
            wrapper.remove();
            mutationObserver.emit([{
                type: 'childList', target: paragraph,
                addedNodes: [] as unknown as NodeList,
                removedNodes: [wrapper] as unknown as NodeList,
            } as unknown as MutationRecord]);
        }
        expect(getTranslationState(paragraph)).toBeUndefined();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        runtime.config.to = 'ja';
        runtime.config.style = 2;
        handleTranslation(20, 20, {continuous: true});
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(2);
        expect(getTranslationState(paragraph)?.phase).toBe('translated');
        expect(paragraph.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
        expect(runtime.renderOptions.at(-1)).toEqual({targetLanguage: 'ja', style: 2});
    });

    it("取消已排队的延迟悬浮后，计时器到期也不会晚到翻译", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = '<article data-testid="tweet"><div id="tweet-text" data-testid="tweetText">Cancelled hover work must stay cancelled.</div></article>';
        const tweetText = document.querySelector<HTMLElement>("#tweet-text")!;
        const candidate = {element: tweetText, kind: "content" as const, reason: "x-post-text", adapterId: "x"};
        setLayoutBox(tweetText, 620, 96);
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;

        handleTranslation(20, 20, {delayMs: 120, continuous: true});
        await vi.advanceTimersByTimeAsync(119);
        cancelPendingHoverTranslation();
        await vi.advanceTimersByTimeAsync(1);
        await finishScheduledWork();

        expect(runtime.requests).not.toHaveBeenCalled();
        expect(getTranslationState(tweetText)).toBeUndefined();
        expect(tweetText.classList.contains("fluent-read-bilingual")).toBe(false);
        expect(tweetText.querySelector(".fluent-read-bilingual-content")).toBeNull();
    });

    it("候选自身有布局盒时直接观察候选，不改用内部标签", async () => {
        document.body.innerHTML = '<h1 id="title"><span id="label">Visible heading</span></h1>';
        const title = document.querySelector<HTMLElement>("#title")!;
        const label = document.querySelector<HTMLElement>("#label")!;
        setLayoutBox(title, 320, 48);
        setLayoutBox(label, 200, 28);
        runtime.candidates = [{element: title, kind: "content", reason: "heading"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);

        const observer = TestIntersectionObserver.instances[0]!;
        expect(observer.observe).toHaveBeenCalledWith(title);
        expect(observer.observe).not.toHaveBeenCalledWith(label);
        expect(runtime.requests).not.toHaveBeenCalled();
    });

    it("立即翻译整页模式绕过可见性门禁并处理当前页面到底部", async () => {
        runtime.config.fullPageTranslationMode = "all";
        document.body.innerHTML = [
            '<p id="visible">Visible paragraph</p>',
            '<p id="below-fold">Paragraph near the page bottom</p>',
        ].join("");
        const visible = document.querySelector<HTMLElement>("#visible")!;
        const belowFold = document.querySelector<HTMLElement>("#below-fold")!;
        setLayoutBox(visible, 600, 80);
        setLayoutBox(belowFold, 600, 80);
        runtime.candidates = [
            {element: visible, kind: "content", reason: "paragraph"},
            {element: belowFold, kind: "content", reason: "paragraph"},
        ];

        autoTranslateEnglishPage();
        await finishScheduledWork();
        await finishScheduledWork();

        const observer = TestIntersectionObserver.instances[0]!;
        expect(observer.observe).not.toHaveBeenCalled();
        expect(runtime.requests).toHaveBeenCalledTimes(2);
        expect(runtime.requests).toHaveBeenCalledWith(["Visible paragraph"]);
        expect(runtime.requests).toHaveBeenCalledWith(["Paragraph near the page bottom"]);
        expect(singleTranslationText(visible)).toBe("译:Visible paragraph");
        expect(singleTranslationText(belowFold)).toBe("译:Paragraph near the page bottom");
    });

    it("立即翻译整页按任务调度配置限制候选并发，释放槽位后才启动下一项", async () => {
        runtime.config.fullPageTranslationMode = "all";
        runtime.config.maxConcurrentTranslations = 2;
        document.body.innerHTML = ["One", "Two", "Three", "Four"]
            .map((label, index) => `<p id="all-candidate-${index}">${label}</p>`)
            .join("");
        const candidates = Array.from(document.querySelectorAll<HTMLElement>("p"));
        candidates.forEach((candidate) => setLayoutBox(candidate, 400, 40));
        runtime.candidates = candidates.map((element) => ({
            element,
            kind: "content" as const,
            reason: "paragraph",
        }));
        const requests = candidates.map(() => deferred<string[]>());
        let nextRequest = 0;
        runtime.requests.mockImplementation(() => requests[nextRequest++]!.promise);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(51);
        await waitForRequestCount(2);

        requests[0]!.resolve(["译:One"]);
        await waitForRequestCount(3);

        requests[1]!.resolve(["译:Two"]);
        requests[2]!.resolve(["译:Three"]);
        requests[3]!.resolve(["译:Four"]);
        await finishScheduledWork();
        expect(candidates.map(singleTranslationText)).toEqual([
            "译:One", "译:Two", "译:Three", "译:Four",
        ]);
    });

    it("恢复整页翻译会清空未启动项，且在途结果不会重新写回页面", async () => {
        runtime.config.fullPageTranslationMode = "all";
        document.body.innerHTML = ["One", "Two", "Three", "Four"]
            .map((label, index) => `<p id="restore-candidate-${index}">${label}</p>`)
            .join("");
        const candidates = Array.from(document.querySelectorAll<HTMLElement>("p"));
        candidates.forEach((candidate) => setLayoutBox(candidate, 400, 40));
        runtime.candidates = candidates.map((element) => ({
            element,
            kind: "content" as const,
            reason: "paragraph",
        }));
        const requests = candidates.slice(0, 3).map(() => deferred<string[]>());
        let nextRequest = 0;
        runtime.requests.mockImplementation(() => requests[nextRequest++]!.promise);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(51);
        await Promise.resolve();
        expect(runtime.requests).toHaveBeenCalledTimes(3);

        restoreOriginalContent();
        requests[0]!.resolve(["旧译:One"]);
        requests[1]!.resolve(["旧译:Two"]);
        requests[2]!.resolve(["旧译:Three"]);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(3);
        expect(candidates.map((candidate) => candidate.textContent)).toEqual(["One", "Two", "Three", "Four"]);
        expect(document.querySelectorAll('[data-fr-translation-owned="true"]')).toHaveLength(0);
    });

    it("运行中的会话保留启动时模式，修改配置只影响下一次全文翻译", async () => {
        document.body.innerHTML = '<p id="prose">Mode changes apply to the next session.</p>';
        const paragraph = document.querySelector<HTMLElement>("#prose")!;
        setLayoutBox(paragraph, 600, 80);
        runtime.candidates = [{element: paragraph, kind: "content", reason: "paragraph"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        expect(TestIntersectionObserver.instances[0]!.observe).toHaveBeenCalledWith(paragraph);

        runtime.config.fullPageTranslationMode = "all";
        await finishScheduledWork();
        expect(runtime.requests).not.toHaveBeenCalled();

        restoreOriginalContent();
        autoTranslateEnglishPage();
        await finishScheduledWork();
        await finishScheduledWork();

        expect(TestIntersectionObserver.instances[1]!.observe).not.toHaveBeenCalled();
        expect(runtime.requests).toHaveBeenCalledWith(["Mode changes apply to the next session."]);
        expect(singleTranslationText(paragraph)).toBe("译:Mode changes apply to the next session.");
    });

    it("全文会话冻结服务、模型、语言、缓存、AI 上下文、显示模式和样式，配置热更新不会混入后续候选", async () => {
        runtime.config.enableAIContext = true;
        runtime.config.modelThinking.microsoft = {'microsoft-default': true};
        runtime.config.display = 1;
        runtime.config.style = 2;
        document.body.innerHTML = [
            '<p id="first">First paragraph uses the session snapshot.</p>',
            '<p id="second">Later paragraph must use the same snapshot.</p>',
        ].join('');
        const first = document.querySelector<HTMLElement>('#first')!;
        const second = document.querySelector<HTMLElement>('#second')!;
        [first, second].forEach((element) => setLayoutBox(element, 600, 80));
        runtime.candidates = [first, second].map((element) => ({
            element,
            kind: 'content' as const,
            reason: 'paragraph',
        }));
        const firstRequest = deferred<string[]>();
        runtime.requests.mockImplementationOnce(() => firstRequest.promise);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const observer = TestIntersectionObserver.instances[0]!;
        observer.emit(first, true);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        // 模拟 options 在首个请求尚未返回时同步了另一套翻译配置。
        runtime.config.service = 'freeTranslation';
        runtime.config.model.freeTranslation = 'new-model';
        runtime.config.modelThinking.microsoft['microsoft-default'] = false;
        runtime.config.from = 'zh';
        runtime.config.to = 'ja';
        runtime.config.useCache = false;
        runtime.config.enableAIContext = false;
        runtime.config.display = 0;
        runtime.config.style = 4;
        firstRequest.resolve(['译:First paragraph uses the session snapshot.']);
        await finishScheduledWork();

        observer.emit(second, true);
        await finishScheduledWork();

        expect(runtime.requestOptions).toHaveLength(2);
        runtime.requestOptions.forEach((options) => expect(options).toMatchObject({
            serviceOverride: 'microsoft',
            modelOverride: 'microsoft-default',
            thinkingOverride: true,
            sourceLanguage: 'en',
            targetLanguage: 'zh',
            useCache: true,
            enableAIContext: true,
        }));
        expect(runtime.renderOptions).toEqual([
            {targetLanguage: 'zh', style: 2},
            {targetLanguage: 'zh', style: 2},
        ]);
        expect(first.querySelector('.fluent-read-bilingual-content')?.getAttribute('lang')).toBe('zh');
        expect(second.querySelector('.fluent-read-bilingual-content')?.getAttribute('lang')).toBe('zh');
    });

    it("立即翻译整页模式也会直接处理会话中动态追加的内容", async () => {
        runtime.config.fullPageTranslationMode = "all";
        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);

        const paragraph = document.createElement("p");
        paragraph.textContent = "A paragraph appended by infinite scroll";
        setLayoutBox(paragraph, 600, 80);
        document.body.appendChild(paragraph);
        runtime.candidates = [{element: paragraph, kind: "content", reason: "paragraph"}];
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "childList",
            target: document.body,
            addedNodes: [paragraph] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);

        await finishScheduledWork();
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledWith(["A paragraph appended by infinite scroll"]);
        expect(singleTranslationText(paragraph)).toBe("译:A paragraph appended by infinite scroll");
        expect(TestIntersectionObserver.instances[0]!.observe).not.toHaveBeenCalled();
    });

    it("观察 display:contents H1 的首个真实布局后代，并在完成后解除该锚点", async () => {
        document.body.innerHTML = '<h1 id="title"><span id="label">Pull request title</span></h1>';
        const title = document.querySelector<HTMLElement>("#title")!;
        const label = document.querySelector<HTMLElement>("#label")!;
        setLayoutBox(title, 0, 0);
        setLayoutBox(label, 240, 36);
        runtime.candidates = [{element: title, kind: "content", reason: "heading"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);

        const observer = TestIntersectionObserver.instances[0]!;
        expect(observer.observe).toHaveBeenCalledWith(label);
        expect(observer.observe).not.toHaveBeenCalledWith(title);
        expect(runtime.requests).not.toHaveBeenCalled();

        observer.emit(label, true);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledWith(["Pull request title"]);
        expect(singleTranslationText(title)).toBe("译:Pull request title");
        expect(observer.unobserve).toHaveBeenCalledWith(label);
    });

    it("hydration 替换 display:contents 后代后刷新同候选 anchor，旧 IO 不会丢失或重复调度", async () => {
        document.body.innerHTML = '<h1 id="title"><span id="label-a">Hydrating title</span></h1>';
        const title = document.querySelector<HTMLElement>("#title")!;
        const labelA = document.querySelector<HTMLElement>("#label-a")!;
        setLayoutBox(title, 0, 0);
        setLayoutBox(labelA, 220, 36);
        runtime.candidates = [{element: title, kind: "content", reason: "heading"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);

        const observer = TestIntersectionObserver.instances[0]!;
        expect(observer.observe).toHaveBeenCalledWith(labelA);

        const labelB = document.createElement("span");
        labelB.id = "label-b";
        labelB.textContent = "Hydrated title";
        setLayoutBox(labelB, 240, 40);
        labelA.replaceWith(labelB);
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "childList",
            target: title,
            addedNodes: [labelB] as unknown as NodeList,
            removedNodes: [labelA] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await vi.advanceTimersByTimeAsync(50);

        expect(observer.unobserve).toHaveBeenCalledWith(labelA);
        expect(observer.observe).toHaveBeenCalledWith(labelB);
        expect(runtime.requests).not.toHaveBeenCalled();

        // 脱离文档目标的已排队回调无害；只有新的实时锚点能让稳定 H1 key 通过可见性门禁。
        observer.emit(labelA, true);
        await finishScheduledWork();
        expect(runtime.requests).not.toHaveBeenCalled();

        const request = deferred<string[]>();
        runtime.requests.mockImplementationOnce(() => request.promise);
        observer.emit(labelB, true);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        // 第一 generation 在途时再次收到 IO 通知，不得新建 provider 调用或取代该 generation。
        observer.emit(labelB, true);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        request.resolve(["译:Hydrated title"]);
        await finishScheduledWork();
        expect(singleTranslationText(title)).toBe("译:Hydrated title");
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it("X 多段原文以同源新节点 replaceChildren 时，mutation callback 内原子保住双语译文", async () => {
        runtime.config.display = 1;
        const firstLine = "Astra's browser agent is gonna be wild.";
        const secondLine = "OpenAI finally shipping something that is not just a chat wrapper.";
        document.body.innerHTML = `
            <article data-testid="tweet">
                <div id="multi-line-tweet" data-testid="tweetText"><span>${firstLine}</span><br><br><span>${secondLine}</span></div>
            </article>
        `;
        const tweet = document.querySelector<HTMLElement>("#multi-line-tweet")!;
        const source = `${firstLine}${secondLine}`;
        setLayoutBox(tweet, 620, 128);
        runtime.candidates = [{element: tweet, kind: "content", reason: "x-post-text", adapterId: "x"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const observer = TestIntersectionObserver.instances[0]!;
        observer.emit(tweet, true);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        const firstState = getTranslationState(tweet)!;
        const previousChildren = Array.from(tweet.childNodes);
        const previousSourceNodes = [...(firstState.sourceTextNodes ?? [])];
        const previousWrapper = tweet.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        const previousTranslation = previousWrapper.textContent;
        expect(firstState).toMatchObject({phase: "translated", mode: "bilingual", sourceText: source});
        expect(previousSourceNodes).toHaveLength(2);
        expect(previousWrapper).toBeTruthy();

        // 模拟 React 按虚拟树重建两段原文：语义完全相同，Text 身份全换，
        // 但虚拟树不包含 FluentRead wrapper。回调结束后不应出现原文窗口期。
        const replacementFirst = document.createElement("span");
        replacementFirst.textContent = firstLine;
        const firstBreak = document.createElement("br");
        const secondBreak = document.createElement("br");
        const replacementSecond = document.createElement("span");
        replacementSecond.textContent = secondLine;
        const replacementChildren = [replacementFirst, firstBreak, secondBreak, replacementSecond];
        tweet.replaceChildren(...replacementChildren);
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "childList",
            target: tweet,
            addedNodes: replacementChildren as unknown as NodeList,
            removedNodes: previousChildren as unknown as NodeList,
        } as unknown as MutationRecord]);

        const currentState = getTranslationState(tweet);
        expect(previousSourceNodes.every((node) => !node.isConnected)).toBe(true);
        // 同 owner 修复直接重挂可信 wrapper，保留译文 DOM identity。
        expect(previousWrapper.isConnected).toBe(true);
        expect(currentState).toMatchObject({phase: "translated", mode: "bilingual", sourceText: source});
        expect(currentState?.sourceTextNodes).toHaveLength(2);
        expect(currentState?.sourceTextNodes?.every((node, index) =>
            node !== previousSourceNodes[index] && node.isConnected)).toBe(true);
        expect(Array.from(tweet.children).filter((child) =>
            child.matches('.fluent-read-bilingual-content[data-fr-translation-owned="true"]')),
        ).toHaveLength(1);
        expect(previousWrapper.textContent).toBe(previousTranslation);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        // dirty-root 的 50ms 期限到达后仍应稳定；测试故意不补发 IO。
        await vi.advanceTimersByTimeAsync(50);
        expect(getTranslationState(tweet)?.phase).toBe("translated");
        expect(tweet.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it("X 双语 wrapper 仍在时，等价替换原文 Text 身份不得重启或删除译文", async () => {
        runtime.config.display = 1;
        const firstLine = "The first source span stays equivalent.";
        const secondLine = "The second source span stays equivalent too.";
        document.body.innerHTML = `
            <article data-testid="tweet">
                <div id="text-identity-tweet" data-testid="tweetText"><span id="first-source-span">${firstLine}</span><br><br><span>${secondLine}</span></div>
            </article>
        `;
        const tweet = document.querySelector<HTMLElement>("#text-identity-tweet")!;
        const firstSpan = document.querySelector<HTMLElement>("#first-source-span")!;
        const source = `${firstLine}${secondLine}`;
        setLayoutBox(tweet, 620, 128);
        runtime.candidates = [{element: tweet, kind: "content", reason: "x-post-text", adapterId: "x"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const observer = TestIntersectionObserver.instances[0]!;
        observer.emit(tweet, true);
        await finishScheduledWork();

        const firstState = getTranslationState(tweet)!;
        const previousText = firstSpan.firstChild as Text;
        const wrapper = tweet.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        expect(firstState.sourceTextNodes).toHaveLength(2);
        expect(wrapper).toBeTruthy();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        const replacementText = document.createTextNode(firstLine);
        firstSpan.replaceChildren(replacementText);
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "childList",
            target: firstSpan,
            addedNodes: [replacementText] as unknown as NodeList,
            removedNodes: [previousText] as unknown as NodeList,
        } as unknown as MutationRecord]);

        const currentState = getTranslationState(tweet);
        expect(previousText.isConnected).toBe(false);
        expect(replacementText.isConnected).toBe(true);
        expect(wrapper.isConnected).toBe(true);
        expect(tweet.querySelector(".fluent-read-bilingual-content")).toBe(wrapper);
        expect(currentState).toMatchObject({phase: "translated", mode: "bilingual", sourceText: source});
        expect(currentState?.sourceTextNodes?.[0]).toBe(replacementText);
        expect(tweet.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(50);
        expect(tweet.querySelector(".fluent-read-bilingual-content")).toBe(wrapper);
        expect(getTranslationState(tweet)?.phase).toBe("translated");
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it("整个 X tweetText 被同源 source-only React 重挂时，callback 内转移状态与译文且无 IO 依赖", async () => {
        runtime.config.display = 1;
        const source = "A remounted reply must never paint as source-only.";
        document.body.innerHTML = `
            <article id="remount-row" data-testid="tweet">
                <div id="remounted-tweet" data-testid="tweetText">${source}</div>
            </article>
        `;
        const row = document.querySelector<HTMLElement>("#remount-row")!;
        const firstTweet = document.querySelector<HTMLElement>("#remounted-tweet")!;
        setLayoutBox(firstTweet, 620, 96);
        runtime.candidates = [{element: firstTweet, kind: "content", reason: "x-post-text", adapterId: "x"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const observer = TestIntersectionObserver.instances[0]!;
        observer.emit(firstTweet, true);
        await finishScheduledWork();

        const firstSource = firstTweet.firstChild as Text;
        const firstWrapper = firstTweet.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        expect(getTranslationState(firstTweet)?.phase).toBe("translated");
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        const replacement = document.createElement("div");
        replacement.id = "remounted-tweet";
        replacement.setAttribute("data-testid", "tweetText");
        const replacementSource = document.createTextNode(source);
        replacement.appendChild(replacementSource);
        setLayoutBox(replacement, 620, 96);
        firstTweet.replaceWith(replacement);
        runtime.candidates = [{element: replacement, kind: "content", reason: "x-post-text", adapterId: "x"}];
        TestMutationObserver.instances.at(-1)!.emit([
            {
                type: "childList",
                target: row,
                addedNodes: [] as unknown as NodeList,
                removedNodes: [firstTweet] as unknown as NodeList,
            } as unknown as MutationRecord,
            {
                type: "childList",
                target: row,
                addedNodes: [replacement] as unknown as NodeList,
                removedNodes: [] as unknown as NodeList,
            } as unknown as MutationRecord,
        ]);

        expect(firstTweet.isConnected).toBe(false);
        expect(firstSource.isConnected).toBe(false);
        expect(firstWrapper.isConnected).toBe(false);
        expect(replacement.firstChild).toBe(replacementSource);
        expect(getTranslationState(firstTweet)).toBeUndefined();
        expect(getTranslationState(replacement)).toMatchObject({
            phase: "translated",
            mode: "bilingual",
            sourceText: source,
        });
        expect(replacement.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
        expect(replacement.textContent).toContain(`译:${source}`);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(50);
        expect(getTranslationState(replacement)?.phase).toBe("translated");
        expect(replacement.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it("宿主把 remove/add 拆记录并连续拒绝整块 wrapper 时，三次后稳定降级且不重译", async () => {
        runtime.config.display = 1;
        const source = "A hostile owner remount must stay bounded.";
        document.body.innerHTML = `<article id="hostile-row"><div data-testid="tweetText">${source}</div></article>`;
        const row = document.querySelector<HTMLElement>("#hostile-row")!;
        let current = row.querySelector<HTMLElement>('[data-testid="tweetText"]')!;
        setLayoutBox(current, 620, 96);
        runtime.candidates = [{element: current, kind: "content", reason: "x-post-text", adapterId: "x"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const intersectionObserver = TestIntersectionObserver.instances[0]!;
        const mutationObserver = TestMutationObserver.instances.at(-1)!;
        intersectionObserver.emit(current, true);
        await finishScheduledWork();
        runtime.pointCandidate = runtime.candidates[0]!;
        handleTranslation(20, 20, {continuous: true});
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        for (let remount = 0; remount < 4; remount += 1) {
            const previous = current;
            current = document.createElement('div');
            current.setAttribute('data-testid', 'tweetText');
            current.textContent = source;
            setLayoutBox(current, 620, 96);
            previous.replaceWith(current);
            runtime.candidates = [{element: current, kind: "content", reason: "x-post-text", adapterId: "x"}];
            mutationObserver.emit([
                {
                    type: 'childList',
                    target: row,
                    addedNodes: [] as unknown as NodeList,
                    removedNodes: [previous] as unknown as NodeList,
                } as unknown as MutationRecord,
                {
                    type: 'childList',
                    target: row,
                    addedNodes: [current] as unknown as NodeList,
                    removedNodes: [] as unknown as NodeList,
                } as unknown as MutationRecord,
            ]);

            if (remount < 3) {
                expect(getTranslationState(current)?.phase).toBe('translated');
                expect(current.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
            } else {
                expect(getTranslationState(current)).toBeUndefined();
                expect(current.querySelector('.fluent-read-bilingual-content')).toBeNull();
            }
        }

        // 第四次已对这个稳定父边界记录降级墓碑；后续 dirty-root/IO 不得再写 DOM 或调 provider。
        await vi.advanceTimersByTimeAsync(50);
        intersectionObserver.emit(current, true);
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(getTranslationState(current)).toBeUndefined();
        expect(current.textContent).toBe(source);

        // SPA 换页必须同时换代当前全文会话的墓碑；新路由可重新拥有同一位置。
        runtime.pointCandidate = runtime.candidates[0]!;
        resetFullPageTranslationRouteState();
        handleTranslation(20, 20, {continuous: true});
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(2);
        expect(getTranslationState(current)?.phase).toBe('translated');
        expect(current.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
    });

    it("删除 wrapper 的同时把原 Text 换到新 href，必须拒绝旧工件并用缓存重建", async () => {
        runtime.config.display = 1;
        const source = "Follow the stable link.";
        document.body.innerHTML = `<p id="linked-owner"><a href="/before">${source}</a></p>`;
        const owner = document.querySelector<HTMLElement>('#linked-owner')!;
        const before = owner.querySelector<HTMLAnchorElement>('a')!;
        const sourceText = before.firstChild as Text;
        setLayoutBox(owner, 620, 96);
        runtime.candidates = [{element: owner, kind: 'content', reason: 'linked-prose'}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const intersectionObserver = TestIntersectionObserver.instances[0]!;
        intersectionObserver.emit(owner, true);
        await finishScheduledWork();
        const wrapper = owner.querySelector<HTMLElement>('.fluent-read-bilingual-content')!;
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        wrapper.remove();
        const after = document.createElement('a');
        after.setAttribute('href', '/after');
        after.appendChild(sourceText);
        before.replaceWith(after);
        TestMutationObserver.instances.at(-1)!.emit([
            {
                type: 'childList',
                target: owner,
                addedNodes: [] as unknown as NodeList,
                removedNodes: [wrapper] as unknown as NodeList,
            } as unknown as MutationRecord,
            {
                type: 'childList',
                target: owner,
                addedNodes: [after] as unknown as NodeList,
                removedNodes: [before] as unknown as NodeList,
            } as unknown as MutationRecord,
        ]);

        expect(sourceText.isConnected).toBe(true);
        expect(getTranslationState(owner)).toBeUndefined();
        expect(owner.querySelector('.fluent-read-bilingual-content')).toBeNull();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(50);
        expect(intersectionObserver.observed.has(owner)).toBe(true);
        intersectionObserver.emit(owner, true);
        await finishScheduledWork();
        // 文本译文本身可复用会话缓存，但 DOM 必须根据新结构重建；不需要额外 provider IO。
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(getTranslationState(owner)).toMatchObject({phase: 'translated', sourceText: source});
        expect(owner.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
        expect(owner.querySelector('.fluent-read-bilingual-content')).not.toBe(wrapper);
    });

    it('全文会话中的 continuous hover 修复复用可信会话缓存，不发第二次 provider 请求', async () => {
        runtime.config.display = 1;
        const source = 'Hover repair inside a full-page session reuses its settled result.';
        document.body.innerHTML = `<p id="owner">${source}</p>`;
        const owner = document.querySelector<HTMLElement>('#owner')!;
        const candidate = {element: owner, kind: 'content' as const, reason: 'paragraph'};
        setLayoutBox(owner, 620, 96);
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        TestIntersectionObserver.instances[0]!.emit(owner, true);
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        owner.querySelector<HTMLElement>('.fluent-read-bilingual-content')!.textContent = 'host tamper';
        handleTranslation(20, 20, {continuous: true});
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(getTranslationState(owner)?.phase).toBe('translated');
        expect(owner.querySelectorAll(':scope > .fluent-read-bilingual-content')).toHaveLength(1);
        expect(owner.textContent).toContain(`译:${source}`);
        expect(owner.textContent).not.toContain('host tamper');
    });

    it("双语原文发生真实变化时不复用旧译文，只在新 IO 后请求一次", async () => {
        runtime.config.display = 1;
        const originalSource = "The original timeline reply.";
        const changedSource = "The timeline reply changed for real.";
        document.body.innerHTML = `<article><div id="changed-reply" data-testid="tweetText">${originalSource}</div></article>`;
        const reply = document.querySelector<HTMLElement>("#changed-reply")!;
        setLayoutBox(reply, 620, 96);
        runtime.candidates = [{element: reply, kind: "content", reason: "x-post-text", adapterId: "x"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const observer = TestIntersectionObserver.instances[0]!;
        observer.emit(reply, true);
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        const previousChildren = Array.from(reply.childNodes);
        const changedText = document.createTextNode(changedSource);
        reply.replaceChildren(changedText);
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "childList",
            target: reply,
            addedNodes: [changedText] as unknown as NodeList,
            removedNodes: previousChildren as unknown as NodeList,
        } as unknown as MutationRecord]);

        expect(getTranslationState(reply)).toBeUndefined();
        expect(reply.querySelector(".fluent-read-bilingual-content")).toBeNull();
        expect(reply.textContent).toBe(changedSource);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(50);
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(reply.querySelector(".fluent-read-bilingual-content")).toBeNull();

        observer.emit(reply, true);
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(2);
        expect(runtime.requests).toHaveBeenLastCalledWith([changedSource]);
        expect(getTranslationState(reply)).toMatchObject({
            phase: "translated",
            mode: "bilingual",
            sourceText: changedSource,
        });
        expect(reply.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
        expect(reply.textContent).toContain(`译:${changedSource}`);
        expect(reply.textContent).not.toContain(`译:${originalSource}`);
    });

    it("宿主连续克隆重挂已翻译 owner 时清理孤儿产物并始终只保留一个直属 wrapper", async () => {
        runtime.config.service = 'ai';
        runtime.config.model.ai = 'ai-model';
        runtime.config.enableAIContext = true;
        runtime.config.display = 1;
        const source = "The same paragraph survives a layout remount.";
        document.body.innerHTML = `<p id="prose">${source}</p>`;
        const firstParagraph = document.querySelector<HTMLElement>("#prose")!;
        setLayoutBox(firstParagraph, 620, 90);
        runtime.candidates = [{element: firstParagraph, kind: "content", reason: "paragraph"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const observer = TestIntersectionObserver.instances[0]!;
        observer.emit(firstParagraph, true);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        const firstWrapper = firstParagraph.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        expect(firstWrapper).toBeTruthy();
        expect(firstParagraph.classList.contains("fluent-read-bilingual")).toBe(false);

        let current = firstParagraph;
        for (let remount = 1; remount <= 2; remount += 1) {
            // React/Vue cloneNode(true) 会同时复制 FluentRead class 和已渲染 wrapper，
            // 但 WeakMap 状态仍只属于已经脱离文档的旧 owner。
            const replacement = current.cloneNode(true) as HTMLElement;
            replacement.id = `prose-remounted-${remount}`;
            setLayoutBox(replacement, 620, 90);
            const removed = current;
            removed.replaceWith(replacement);
            runtime.candidates = [{element: replacement, kind: "content", reason: "paragraph"}];
            TestMutationObserver.instances.at(-1)!.emit([{
                type: "childList",
                target: document.body,
                addedNodes: [replacement] as unknown as NodeList,
                removedNodes: [removed] as unknown as NodeList,
            } as unknown as MutationRecord]);
            await vi.advanceTimersByTimeAsync(50);

            observer.emit(replacement, true);
            await finishScheduledWork();

            const directWrappers = Array.from(replacement.children).filter((child) =>
                child.matches('.fluent-read-bilingual-content[data-fr-translation-owned="true"]'));
            expect(removed.isConnected).toBe(false);
            expect(directWrappers).toHaveLength(1);
            expect(replacement.textContent).toContain(`译:${source}`);
            expect(replacement.classList.contains("fluent-read-bilingual")).toBe(false);
            current = replacement;
        }

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(firstParagraph.isConnected).toBe(false);
        restoreOriginalContent();
        expect(current.querySelector(".fluent-read-bilingual-content")).toBeNull();
        expect(current.classList.contains("fluent-read-bilingual")).toBe(false);
        expect(current.textContent).toBe(source);
    });

    it("provider 未决时连续克隆重挂只保留一个 loading，并由最新 owner 提交一次结果", async () => {
        runtime.config.service = 'ai';
        runtime.config.model.ai = 'ai-model';
        runtime.config.enableAIContext = true;
        runtime.config.display = 1;
        const source = "The pending paragraph survives repeated framework remounts.";
        document.body.innerHTML = `<p id="pending-prose">${source}</p>`;
        const firstParagraph = document.querySelector<HTMLElement>("#pending-prose")!;
        setLayoutBox(firstParagraph, 620, 90);
        runtime.candidates = [{element: firstParagraph, kind: "content", reason: "paragraph"}];
        const provider = deferred<string[]>();
        runtime.requests.mockImplementation(() => provider.promise);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const observer = TestIntersectionObserver.instances[0]!;
        observer.emit(firstParagraph, true);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(firstParagraph.querySelectorAll('.fluent-read-loading')).toHaveLength(1);

        let current = firstParagraph;
        for (let remount = 1; remount <= 2; remount += 1) {
            const replacement = current.cloneNode(true) as HTMLElement;
            replacement.id = `pending-prose-remounted-${remount}`;
            setLayoutBox(replacement, 620, 90);
            const removed = current;
            removed.replaceWith(replacement);
            runtime.candidates = [{element: replacement, kind: "content", reason: "paragraph"}];
            TestMutationObserver.instances.at(-1)!.emit([{
                type: "childList",
                target: document.body,
                addedNodes: [replacement] as unknown as NodeList,
                removedNodes: [removed] as unknown as NodeList,
            } as unknown as MutationRecord]);
            await vi.advanceTimersByTimeAsync(50);
            observer.emit(replacement, true);
            await vi.advanceTimersByTimeAsync(1);
            await Promise.resolve();
            await Promise.resolve();

            const directLoading = Array.from(replacement.children).filter((child) =>
                child.matches('.fluent-read-loading[data-fr-translation-owned="true"]'));
            expect(removed.isConnected).toBe(false);
            expect(directLoading).toHaveLength(1);
            expect(replacement.querySelector('.fluent-read-bilingual-content')).toBeNull();
            expect(runtime.requests).toHaveBeenCalledTimes(1);
            current = replacement;
        }

        provider.resolve([`译:${source}`]);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(current.querySelectorAll('.fluent-read-loading')).toHaveLength(0);
        expect(Array.from(current.children).filter((child) =>
            child.matches('.fluent-read-bilingual-content[data-fr-translation-owned="true"]')),
        ).toHaveLength(1);
        expect(current.textContent).toContain(`译:${source}`);
    });

    it("仅译文 owner 连续克隆重挂时先解包 light DOM 原文，再恢复为一个可见译文槽", async () => {
        runtime.config.display = 0;
        const source = "Translation-only source survives repeated remounts.";
        document.body.innerHTML = `<p id="single-prose">${source}</p>`;
        const firstParagraph = document.querySelector<HTMLElement>("#single-prose")!;
        setLayoutBox(firstParagraph, 620, 90);
        runtime.candidates = [{element: firstParagraph, kind: "content", reason: "paragraph"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const observer = TestIntersectionObserver.instances[0]!;
        observer.emit(firstParagraph, true);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(firstParagraph.querySelectorAll(".fluent-read-single-slot")).toHaveLength(1);
        expect(singleTranslationText(firstParagraph)).toBe(`译:${source}`);

        let current = firstParagraph;
        for (let remount = 1; remount <= 2; remount += 1) {
            const replacement = current.cloneNode(true) as HTMLElement;
            replacement.id = `single-prose-remounted-${remount}`;
            setLayoutBox(replacement, 620, 90);
            const removed = current;
            removed.replaceWith(replacement);
            runtime.candidates = [{element: replacement, kind: "content", reason: "paragraph"}];
            TestMutationObserver.instances.at(-1)!.emit([{
                type: "childList",
                target: document.body,
                addedNodes: [replacement] as unknown as NodeList,
                removedNodes: [removed] as unknown as NodeList,
            } as unknown as MutationRecord]);
            await vi.advanceTimersByTimeAsync(50);

            // 候选发现前，孤儿 single-slot 已被解包为可重新翻译的宿主原文。
            expect(replacement.querySelector(".fluent-read-single-slot")).toBeNull();
            expect(replacement.textContent).toBe(source);

            observer.emit(replacement, true);
            await finishScheduledWork();

            expect(removed.isConnected).toBe(false);
            expect(replacement.querySelectorAll(".fluent-read-single-slot")).toHaveLength(1);
            expect(singleTranslationText(replacement)).toBe(`译:${source}`);
            expect(replacement.textContent).toBe(source);
            current = replacement;
        }

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        // 恢复可能早于下一轮 50ms discovery；此时克隆仍携带无状态 single-slot，
        // 通用 orphan 清理也必须先解包其中的 light DOM 原文。
        const restoreBeforeDiscovery = current.cloneNode(true) as HTMLElement;
        current.replaceWith(restoreBeforeDiscovery);
        current = restoreBeforeDiscovery;
        restoreOriginalContent();
        expect(current.querySelector(".fluent-read-single-slot")).toBeNull();
        expect(current.textContent).toBe(source);
    });

    it("没有任何布局锚点的 H1 仍直接进入受控翻译队列", async () => {
        document.body.innerHTML = '<h1 id="title">Text-only heading</h1>';
        const title = document.querySelector<HTMLElement>("#title")!;
        setLayoutBox(title, 0, 0);
        runtime.candidates = [{element: title, kind: "content", reason: "heading"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        await finishScheduledWork();

        const observer = TestIntersectionObserver.instances[0]!;
        expect(observer.observe).not.toHaveBeenCalled();
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(runtime.requests).toHaveBeenCalledWith(["Text-only heading"]);
        expect(singleTranslationText(title)).toBe("译:Text-only heading");
    });

    it("inFlightCandidates 是唯一并发计数，并在 settle 后释放下一候选", async () => {
        document.body.innerHTML = ["One", "Two", "Three", "Four"]
            .map((label, index) => `<p id="candidate-${index}">${label}</p>`)
            .join("");
        const candidates = Array.from(document.querySelectorAll<HTMLElement>("p"));
        candidates.forEach((candidate) => setLayoutBox(candidate, 400, 40));
        runtime.candidates = candidates.map((element) => ({
            element,
            kind: "content" as const,
            reason: "paragraph",
        }));
        const requests = candidates.map(() => deferred<string[]>());
        let nextRequest = 0;
        runtime.requests.mockImplementation(() => requests[nextRequest++]!.promise);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const observer = TestIntersectionObserver.instances[0]!;
        candidates.forEach((candidate) => observer.emit(candidate, true));
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();

        expect(runtime.requests).toHaveBeenCalledTimes(3);

        requests[0]!.resolve(["译:One"]);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
        await Promise.resolve();
        expect(runtime.requests).toHaveBeenCalledTimes(4);

        requests[1]!.resolve(["译:Two"]);
        requests[2]!.resolve(["译:Three"]);
        requests[3]!.resolve(["译:Four"]);
        await finishScheduledWork();
        expect(candidates.map(singleTranslationText)).toEqual([
            "译:One", "译:Two", "译:Three", "译:Four",
        ]);
    });

    it("全文进度只把预取窗口内的等待候选计入 queued，并保留离屏 remaining", async () => {
        document.body.innerHTML = ["One", "Two", "Three", "Four", "Five"]
            .map((label, index) => `<p id="progress-candidate-${index}">${label}</p>`)
            .join("");
        const candidates = Array.from(document.querySelectorAll<HTMLElement>("p"));
        candidates.forEach((candidate) => setLayoutBox(candidate, 400, 40));
        runtime.candidates = candidates.map((element) => ({
            element,
            kind: "content" as const,
            reason: "paragraph",
        }));
        const requests = candidates.map(() => deferred<string[]>());
        let nextRequest = 0;
        runtime.requests.mockImplementation(() => requests[nextRequest++]!.promise);

        const snapshots: FullPageTranslationProgress[] = [];
        const unsubscribe = subscribeFullPageTranslationProgress((progress) => {
            snapshots.push(progress);
        });
        const expectCurrentProgress = (expected: Pick<
            FullPageTranslationProgress,
            "active" | "running" | "remaining" | "queued" | "offscreen"
        >) => {
            expect(getFullPageTranslationProgress()).toMatchObject(expected);
            expect(snapshots.at(-1)).toMatchObject(expected);
        };

        try {
            autoTranslateEnglishPage();
            await vi.advanceTimersByTimeAsync(50);
            await Promise.resolve();
            const observer = TestIntersectionObserver.instances[0]!;
            await waitForObservedCandidateCount(observer, candidates.length);

            expectCurrentProgress({
                active: true,
                running: 0,
                remaining: 5,
                queued: 0,
                offscreen: 5,
            });

            candidates.slice(0, 4).forEach((candidate) => observer.emit(candidate, true));
            await vi.advanceTimersByTimeAsync(1);
            await Promise.resolve();
            await Promise.resolve();

            expect(runtime.requests).toHaveBeenCalledTimes(3);
            expectCurrentProgress({
                active: true,
                running: 3,
                remaining: 2,
                queued: 1,
                offscreen: 1,
            });

            requests[0]!.resolve(["译:One"]);
            await vi.advanceTimersByTimeAsync(1);
            await Promise.resolve();
            await Promise.resolve();

            expect(runtime.requests).toHaveBeenCalledTimes(4);
            expectCurrentProgress({
                active: true,
                running: 3,
                remaining: 1,
                queued: 0,
                offscreen: 1,
            });

            observer.emit(candidates[4]!, true);
            await vi.advanceTimersByTimeAsync(1);
            await Promise.resolve();

            expect(runtime.requests).toHaveBeenCalledTimes(4);
            expectCurrentProgress({
                active: true,
                running: 3,
                remaining: 1,
                queued: 1,
                offscreen: 0,
            });

            requests[1]!.resolve(["译:Two"]);
            await vi.advanceTimersByTimeAsync(1);
            await Promise.resolve();
            await Promise.resolve();
            expect(runtime.requests).toHaveBeenCalledTimes(5);

            requests[2]!.resolve(["译:Three"]);
            requests[3]!.resolve(["译:Four"]);
            requests[4]!.resolve(["译:Five"]);
            await finishScheduledWork();

            expect(candidates.map(singleTranslationText)).toEqual([
                "译:One", "译:Two", "译:Three", "译:Four", "译:Five",
            ]);
            expectCurrentProgress({
                active: true,
                running: 0,
                remaining: 0,
                queued: 0,
                offscreen: 0,
            });

            restoreOriginalContent();
            expectCurrentProgress({
                active: false,
                running: 0,
                remaining: 0,
                queued: 0,
                offscreen: 0,
            });
        } finally {
            unsubscribe();
        }
    });

    it("立即翻译整页时把所有未启动候选计入 queued，不产生离屏计数", async () => {
        runtime.config.fullPageTranslationMode = "all";
        document.body.innerHTML = ["One", "Two", "Three", "Four", "Five"]
            .map((label, index) => `<p id="all-progress-candidate-${index}">${label}</p>`)
            .join("");
        const candidates = Array.from(document.querySelectorAll<HTMLElement>("p"));
        candidates.forEach((candidate) => setLayoutBox(candidate, 400, 40));
        runtime.candidates = candidates.map((element) => ({
            element,
            kind: "content" as const,
            reason: "paragraph",
        }));
        const requests = candidates.map(() => deferred<string[]>());
        let nextRequest = 0;
        runtime.requests.mockImplementation(() => requests[nextRequest++]!.promise);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(51);
        await Promise.resolve();
        await Promise.resolve();

        expect(runtime.requests).toHaveBeenCalledTimes(3);
        expect(TestIntersectionObserver.instances[0]!.observe).not.toHaveBeenCalled();
        expect(getFullPageTranslationProgress()).toMatchObject({
            active: true,
            running: 3,
            remaining: 2,
            queued: 2,
            offscreen: 0,
        });

        restoreOriginalContent();
        requests.slice(0, 3).forEach((request, index) => request.resolve([`译:${candidates[index]!.textContent}`]));
        await finishScheduledWork();
        expect(getFullPageTranslationProgress()).toMatchObject({active: false});
    });

    it("不会把扩展生成的布局节点当成候选可见性锚点", async () => {
        document.body.innerHTML = `
            <h1 id="title">
                <span id="owned" data-fr-translation-owned="true">Loading</span>
                <span id="host-label">Host title</span>
            </h1>
        `;
        const title = document.querySelector<HTMLElement>("#title")!;
        const owned = document.querySelector<HTMLElement>("#owned")!;
        const hostLabel = document.querySelector<HTMLElement>("#host-label")!;
        setLayoutBox(title, 0, 0);
        setLayoutBox(owned, 100, 20);
        setLayoutBox(hostLabel, 180, 30);
        runtime.candidates = [{element: title, kind: "content", reason: "heading"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);

        const observer = TestIntersectionObserver.instances[0]!;
        expect(observer.observe).toHaveBeenCalledWith(hostLabel);
        expect(observer.observe).not.toHaveBeenCalledWith(owned);
        expect(runtime.requests).not.toHaveBeenCalled();
    });

    it("替换同 key 候选时解除旧 anchor、切换 owner，并在 stop 后不再调度", async () => {
        document.body.innerHTML = `
            <div id="generic"><h1 id="title"><span id="label">Exact title</span></h1></div>
        `;
        const generic = document.querySelector<HTMLElement>("#generic")!;
        const title = document.querySelector<HTMLElement>("#title")!;
        const label = document.querySelector<HTMLElement>("#label")!;
        setLayoutBox(generic, 640, 120);
        setLayoutBox(title, 0, 0);
        setLayoutBox(label, 220, 36);
        runtime.candidates = [
            {element: generic, nodes: [title], kind: "content", reason: "inline-run"},
            {element: title, kind: "content", reason: "site-title", adapterId: "site"},
        ];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);

        const observer = TestIntersectionObserver.instances[0]!;
        expect(observer.observe).toHaveBeenCalledWith(generic);
        expect(observer.unobserve).toHaveBeenCalledWith(generic);
        expect(observer.observe).toHaveBeenCalledWith(label);
        expect(isFullPageTranslationActive()).toBe(true);

        restoreOriginalContent();
        expect(observer.disconnect).toHaveBeenCalledTimes(1);
        expect(isFullPageTranslationActive()).toBe(false);

        observer.emit(label, true);
        await finishScheduledWork();
        expect(runtime.requests).not.toHaveBeenCalled();
    });

    it("旧 IntersectionObserver 的排队 callback 不会把新会话候选送入队列", async () => {
        document.body.innerHTML = '<h1 id="title">Shared title across sessions</h1>';
        const title = document.querySelector<HTMLElement>("#title")!;
        setLayoutBox(title, 320, 48);
        runtime.candidates = [{element: title, kind: "content", reason: "heading"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const oldObserver = TestIntersectionObserver.instances[0]!;
        expect(oldObserver.observe).toHaveBeenCalledWith(title);

        restoreOriginalContent();
        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const newObserver = TestIntersectionObserver.instances[1]!;
        expect(newObserver.observe).toHaveBeenCalledWith(title);

        // 浏览器事件送达可能与 disconnect() 竞争；即使已排队的旧回调携带新会话再次
        // 观察的目标，它仍属于已销毁会话，不得读取新 map。
        oldObserver.emit(title, true);
        await finishScheduledWork();
        expect(runtime.requests).not.toHaveBeenCalled();

        newObserver.emit(title, true);
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(runtime.requests).toHaveBeenCalledWith(["Shared title across sessions"]);
    });

    it("失败 UI 注入的重试回调会按点击时的当前显示模式重新解析候选", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = '<p id="prose">Retry with the latest display mode.</p>';
        const paragraph = document.querySelector<HTMLElement>("#prose")!;
        runtime.candidates = [{element: paragraph, kind: "content", reason: "paragraph"}];
        runtime.requests.mockRejectedValueOnce(new Error("provider unavailable"));

        handleBilingualTranslation(paragraph, false);
        await finishScheduledWork();

        expect(getTranslationState(paragraph)?.phase).toBe("error");
        expect(runtime.retryCallbacks).toHaveLength(1);

        runtime.config.display = 0;
        runtime.retryCallbacks[0]!();
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(2);
        expect(getTranslationState(paragraph)).toMatchObject({phase: "translated", mode: "single"});
        expect(paragraph.querySelector(".fluent-read-bilingual-content")).toBeNull();
        expect(singleTranslationText(paragraph)).toBe("译:Retry with the latest display mode.");
    });

    it('纯 hover 失败墓碑在连续移动时不重复请求，只响应明确重试', async () => {
        runtime.config.display = 1;
        document.body.innerHTML = '<p id="hover-failure">Do not hammer a failed provider.</p>';
        const paragraph = document.querySelector<HTMLElement>('#hover-failure')!;
        const candidate = {element: paragraph, kind: 'content' as const, reason: 'paragraph'};
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;
        runtime.requests.mockRejectedValueOnce(new Error('provider unavailable'));

        handleTranslation(20, 20, {continuous: true});
        await finishScheduledWork();
        expect(getTranslationState(paragraph)?.phase).toBe('error');
        expect(runtime.requests).toHaveBeenCalledOnce();

        for (let movement = 0; movement < 8; movement += 1) {
            handleTranslation(20, 20, {continuous: true});
            await finishScheduledWork();
        }
        expect(runtime.requests).toHaveBeenCalledOnce();
        expect(runtime.retryCallbacks).toHaveLength(1);

        runtime.retryCallbacks[0]!();
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(2);
        expect(getTranslationState(paragraph)?.phase).toBe('translated');
    });

    it("全文失败 owner 克隆重挂只复用错误墓碑，直到用户明确重试", async () => {
        runtime.config.service = 'ai';
        runtime.config.model.ai = 'ai-model';
        runtime.config.enableAIContext = true;
        runtime.config.display = 1;
        const source = "Failed translation survives a framework remount.";
        document.body.innerHTML = `<p id="failed-prose">${source}</p>`;
        const first = document.querySelector<HTMLElement>("#failed-prose")!;
        setLayoutBox(first, 620, 90);
        runtime.candidates = [{element: first, kind: "content", reason: "paragraph"}];
        runtime.requests.mockRejectedValueOnce(new Error("provider unavailable"));

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const observer = TestIntersectionObserver.instances[0]!;
        observer.emit(first, true);
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledOnce();
        expect(getTranslationState(first)?.phase).toBe("error");

        const replacement = first.cloneNode(true) as HTMLElement;
        replacement.id = "failed-prose-remounted";
        setLayoutBox(replacement, 620, 90);
        first.replaceWith(replacement);
        runtime.candidates = [{element: replacement, kind: "content", reason: "paragraph"}];
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "childList",
            target: document.body,
            addedNodes: [replacement] as unknown as NodeList,
            removedNodes: [first] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await vi.advanceTimersByTimeAsync(50);
        observer.emit(replacement, true);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledOnce();
        expect(getTranslationState(replacement)?.phase).toBe("error");
        expect(runtime.retryCallbacks).toHaveLength(2);

        runtime.retryCallbacks.at(-1)!();
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(2);
        expect(getTranslationState(replacement)?.phase).toBe("translated");
        expect(replacement.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
    });

    it('快捷方案失败后的重试继续使用原方案快照', async () => {
        document.body.innerHTML = '<p id="profile-retry">Retry with the original quick profile.</p>';
        const paragraph = document.querySelector<HTMLElement>('#profile-retry')!;
        const candidate = {element: paragraph, kind: 'content' as const, reason: 'paragraph'};
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;
        runtime.requests.mockRejectedValueOnce(new Error('profile unavailable'));

        handleTranslation(20, 20, {
            profileId: 'hover-retry', service: 'freeTranslation', model: 'profile-model',
            targetLanguage: 'ja', displayMode: 'bilingual',
        });
        await finishScheduledWork();
        runtime.config.service = 'microsoft';
        runtime.config.display = 0;
        runtime.config.to = 'zh';
        runtime.retryCallbacks[0]!();
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(2);
        expect(runtime.requestOptions.at(-1)).toMatchObject({
            serviceOverride: 'freeTranslation', modelOverride: 'profile-model', targetLanguage: 'ja',
        });
        expect(getTranslationState(paragraph)).toMatchObject({phase: 'translated', mode: 'bilingual'});
    });

    it("行内片段首次失败后会从原始候选恢复并完成手动重试", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = '<p id="prose">Inline retry source <strong>keeps structure</strong>.</p>';
        const paragraph = document.querySelector<HTMLElement>("#prose")!;
        const inlineSource = paragraph.firstChild as Text;
        runtime.candidates = [{
            element: paragraph,
            kind: "content",
            reason: "generic-inline-run",
            nodes: [inlineSource],
        }];
        runtime.requests.mockRejectedValueOnce(new Error("provider unavailable"));

        handleBilingualTranslation(paragraph, false);
        await finishScheduledWork();

        const failedSegment = paragraph.querySelector<HTMLElement>('[data-fr-translation-segment="true"]')!;
        expect(getTranslationState(failedSegment)?.phase).toBe("error");
        expect(runtime.retryCallbacks).toHaveLength(1);

        runtime.retryCallbacks[0]!();
        await finishScheduledWork();

        const translatedSegment = paragraph.querySelector<HTMLElement>('[data-fr-translation-segment="true"]')!;
        expect(runtime.requests).toHaveBeenCalledTimes(2);
        expect(failedSegment.isConnected).toBe(false);
        expect(getTranslationState(translatedSegment)?.phase).toBe("translated");
        expect(translatedSegment.querySelector(".fluent-read-bilingual-content")?.textContent)
            .toBe("译:Inline retry source ");
        expect(paragraph.querySelector("strong")?.textContent).toBe("keeps structure");
    });

    it.each(["translate-no", "hidden"] as const)(
        "全文会话登记启动前 hover 状态的祖先索引，新增 %s 会恢复且 stop 后不再响应",
        async (guard) => {
            runtime.config.display = 1;
            document.body.innerHTML = `
                <section id="ancestor">
                    <p id="prose">Hover translation exists before full-page discovery.</p>
                </section>
            `;
            const ancestor = document.querySelector<HTMLElement>("#ancestor")!;
            const paragraph = document.querySelector<HTMLElement>("#prose")!;
            setLayoutBox(paragraph, 620, 90);
            runtime.candidates = [{element: paragraph, kind: "content", reason: "paragraph"}];

            handleBilingualTranslation(paragraph, false);
            await finishScheduledWork();

            const hoverState = getTranslationState(paragraph)!;
            expect(hoverState.phase).toBe("translated");
            expect(paragraph.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
            expect(runtime.requests).toHaveBeenCalledTimes(1);

            autoTranslateEnglishPage();
            await vi.advanceTimersByTimeAsync(50);

            // 发现流程只能把现有悬浮状态登记到当前全文会话；权威祖先门禁变化前，
            // 不得替换该状态或再次请求。
            expect(getTranslationState(paragraph)).toBe(hoverState);
            expect(runtime.requests).toHaveBeenCalledTimes(1);
            const mutationObserver = TestMutationObserver.instances.at(-1)!;

            if (guard === "translate-no") ancestor.setAttribute("translate", "no");
            else ancestor.hidden = true;
            mutationObserver.emit([{
                type: "attributes",
                target: ancestor,
                attributeName: guard === "translate-no" ? "translate" : "hidden",
                addedNodes: [] as unknown as NodeList,
                removedNodes: [] as unknown as NodeList,
            } as unknown as MutationRecord]);
            await finishScheduledWork();

            expect(hoverState.controller.signal.aborted).toBe(true);
            expect(getTranslationState(paragraph)).toBeUndefined();
            expect(paragraph.textContent).toBe("Hover translation exists before full-page discovery.");
            expect(paragraph.querySelectorAll('[data-fr-translation-owned="true"]')).toHaveLength(0);
            expect(runtime.requests).toHaveBeenCalledTimes(1);

            restoreOriginalContent();
            expect(isFullPageTranslationActive()).toBe(false);
            if (guard === "translate-no") ancestor.removeAttribute("translate");
            else ancestor.hidden = false;
            mutationObserver.emit([{
                type: "attributes",
                target: ancestor,
                attributeName: guard === "translate-no" ? "translate" : "hidden",
                addedNodes: [] as unknown as NodeList,
                removedNodes: [] as unknown as NodeList,
            } as unknown as MutationRecord]);
            await finishScheduledWork();
            expect(runtime.requests).toHaveBeenCalledTimes(1);
        },
    );

    it("全文 discovery enter 会登记启动前已提交的 hover synthetic 状态", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = `
            <section id="ancestor">
                <div id="mixed">Readable inline prefix <strong id="emphasis">with emphasized prose.</strong>
                    <p>Independent block child.</p>
                </div>
            </section>
        `;
        const ancestor = document.querySelector<HTMLElement>("#ancestor")!;
        const host = document.querySelector<HTMLElement>("#mixed")!;
        const sourceNodes = [host.firstChild as Text, document.querySelector<HTMLElement>("#emphasis")!] as const;
        setLayoutBox(host, 640, 120);
        runtime.candidates = [{element: host, nodes: sourceNodes, kind: "content", reason: "inline-run"}];

        handleBilingualTranslation(host, false);
        await finishScheduledWork();

        const segment = host.querySelector<HTMLElement>('[data-fr-translation-segment="true"]')!;
        const hoverState = getTranslationState(segment)!;
        expect(hoverState.phase).toBe("translated");
        expect(segment.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        expect(getTranslationState(segment)).toBe(hoverState);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        ancestor.setAttribute("translate", "no");
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "attributes",
            target: ancestor,
            attributeName: "translate",
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await finishScheduledWork();

        expect(hoverState.controller.signal.aborted).toBe(true);
        expect(segment.isConnected).toBe(false);
        expect(ancestor.querySelectorAll(
            '[data-fr-translation-segment="true"], [data-fr-translation-owned="true"]',
        )).toHaveLength(0);
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it("全文 discovery enter 会登记启动前 in-flight hover synthetic 状态且旧结果不可覆盖", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = `
            <section id="ancestor">
                <div id="mixed">Readable inline prefix <strong id="emphasis">with emphasized prose.</strong>
                    <p>Independent block child.</p>
                </div>
            </section>
        `;
        const ancestor = document.querySelector<HTMLElement>("#ancestor")!;
        const host = document.querySelector<HTMLElement>("#mixed")!;
        const sourceNodes = [host.firstChild as Text, document.querySelector<HTMLElement>("#emphasis")!] as const;
        setLayoutBox(host, 640, 120);
        runtime.candidates = [{element: host, nodes: sourceNodes, kind: "content", reason: "inline-run"}];
        const pendingRequest = deferred<string[]>();
        runtime.requests.mockImplementationOnce(() => pendingRequest.promise);

        handleBilingualTranslation(host, false);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();

        const segment = host.querySelector<HTMLElement>('[data-fr-translation-segment="true"]')!;
        const hoverState = getTranslationState(segment)!;
        expect(hoverState.phase).toBe("loading");
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        expect(getTranslationState(segment)).toBe(hoverState);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        ancestor.hidden = true;
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "attributes",
            target: ancestor,
            attributeName: "hidden",
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);

        expect(hoverState.controller.signal.aborted).toBe(true);
        expect(segment.isConnected).toBe(false);
        pendingRequest.resolve(runtime.requests.mock.calls[0]![0].map((origin) => `旧译:${origin}`));
        await finishScheduledWork();

        expect(ancestor.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(0);
        expect(ancestor.querySelectorAll('[data-fr-translation-owned="true"]')).toHaveLength(0);
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it("共享 key 状态会按 candidate owner 到实际 keyedTarget 登记祖先索引", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = `
            <section id="ancestor">
                <div id="owner"><p id="prose">Exact hover target shares a later full-page key.</p></div>
            </section>
        `;
        const ancestor = document.querySelector<HTMLElement>("#ancestor")!;
        const owner = document.querySelector<HTMLElement>("#owner")!;
        const paragraph = document.querySelector<HTMLElement>("#prose")!;
        setLayoutBox(owner, 640, 120);
        setLayoutBox(paragraph, 600, 80);
        runtime.candidates = [{element: paragraph, kind: "content", reason: "exact-hover"}];

        handleBilingualTranslation(paragraph, false);
        await finishScheduledWork();
        const hoverState = getTranslationState(paragraph)!;
        expect(hoverState.phase).toBe("translated");
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        runtime.candidates = [{
            element: owner,
            nodes: [paragraph],
            kind: "content",
            reason: "shared-key-inline-run",
        }];
        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        expect(getTranslationState(paragraph)).toBe(hoverState);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        ancestor.setAttribute("translate", "no");
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "attributes",
            target: ancestor,
            attributeName: "translate",
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await finishScheduledWork();

        expect(hoverState.controller.signal.aborted).toBe(true);
        expect(getTranslationState(paragraph)).toBeUndefined();
        expect(paragraph.textContent).toBe("Exact hover target shares a later full-page key.");
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it("异步 nodes 候选只忽略 synthetic source 迁移与当前 spinner 的真实 childList 记录", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = `
            <div id="mixed">Readable inline prefix <strong id="emphasis">with emphasized prose.</strong>
                <p>Independent block child.</p>
            </div>
        `;
        const host = document.querySelector<HTMLElement>("#mixed")!;
        const sourceText = host.firstChild as Text;
        const emphasis = document.querySelector<HTMLElement>("#emphasis")!;
        const sourceNodes = [sourceText, emphasis] as const;
        setLayoutBox(host, 640, 120);
        runtime.candidates = [{element: host, nodes: sourceNodes, kind: "content", reason: "inline-run"}];
        const pendingRequest = deferred<string[]>();
        runtime.requests.mockImplementationOnce(() => pendingRequest.promise);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const visibilityObserver = TestIntersectionObserver.instances[0]!;
        visibilityObserver.emit(host, true);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        const segment = host.querySelector<HTMLElement>('[data-fr-translation-segment="true"]')!;
        const spinner = segment.querySelector<HTMLElement>('[data-fr-translation-owned="true"]')!;
        expect(Array.from(segment.childNodes).filter((node) => node !== spinner)).toEqual(sourceNodes);
        const nativeCloneNode = segment.cloneNode.bind(segment);
        let snapshotCloneCalls = 0;
        Object.defineProperty(segment, "cloneNode", {
            configurable: true,
            value: (deep?: boolean) => {
                snapshotCloneCalls += 1;
                return nativeCloneNode(deep);
            },
        });

        // 这些是 materialize 后真实的实时 Node 身份：宿主获得片段，来源节点移入片段，
        // 同一片段再接收唯一由状态拥有的 spinner。
        TestMutationObserver.instances.at(-1)!.emit([
            {
                type: "childList",
                target: host,
                addedNodes: [segment] as unknown as NodeList,
                removedNodes: [] as unknown as NodeList,
            },
            ...sourceNodes.map((node) => ({
                type: "childList",
                target: host,
                addedNodes: [] as unknown as NodeList,
                removedNodes: [node] as unknown as NodeList,
            })),
            ...Array.from({length: 64}, () => ({
                type: "childList",
                target: segment,
                addedNodes: [...sourceNodes, spinner] as unknown as NodeList,
                removedNodes: [] as unknown as NodeList,
            })),
        ] as unknown as MutationRecord[]);
        await vi.advanceTimersByTimeAsync(100);

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(snapshotCloneCalls).toBe(1);
        expect(segment.isConnected).toBe(true);
        pendingRequest.resolve(runtime.requests.mock.calls[0]![0].map((origin) => `译:${origin}`));
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(segment.isConnected).toBe(true);
        expect(segment.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
    });

    it("已译 synthetic inline-run 的祖先新增 translate=no 会 abort、unwrap，移除后复用会话结果", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = `
            <section id="ancestor">
                <div id="mixed">Readable inline prefix <strong id="emphasis">with emphasized prose.</strong>
                    <p>Independent block child.</p>
                </div>
            </section>
        `;
        const ancestor = document.querySelector<HTMLElement>("#ancestor")!;
        const host = document.querySelector<HTMLElement>("#mixed")!;
        const sourceNodes = [host.firstChild as Text, document.querySelector<HTMLElement>("#emphasis")!] as const;
        setLayoutBox(host, 640, 120);
        runtime.candidates = [{element: host, nodes: sourceNodes, kind: "content", reason: "inline-run"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const visibilityObserver = TestIntersectionObserver.instances[0]!;
        visibilityObserver.emit(host, true);
        await finishScheduledWork();

        const firstSegment = host.querySelector<HTMLElement>('[data-fr-translation-segment="true"]')!;
        const firstState = getTranslationState(firstSegment)!;
        expect(firstSegment.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
        expect(firstState.controller.signal.aborted).toBe(false);

        ancestor.setAttribute("translate", "no");
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "attributes",
            target: ancestor,
            attributeName: "translate",
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await finishScheduledWork();

        expect(firstState.controller.signal.aborted).toBe(true);
        expect(firstSegment.isConnected).toBe(false);
        expect(ancestor.querySelectorAll(
            '[data-fr-translation-segment="true"], [data-fr-translation-owned="true"]',
        )).toHaveLength(0);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        ancestor.removeAttribute("translate");
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "attributes",
            target: ancestor,
            attributeName: "translate",
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await vi.advanceTimersByTimeAsync(50);
        visibilityObserver.emit(host, true);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(host.querySelectorAll('[data-fr-translation-segment="true"]')).toHaveLength(1);
        expect(host.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
    });

    it("in-flight synthetic inline-run 隐藏时不提交，解除后由新 generation 复用结果", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = `
            <section id="ancestor">
                <div id="mixed">Readable inline prefix <strong id="emphasis">with emphasized prose.</strong>
                    <p>Independent block child.</p>
                </div>
            </section>
        `;
        const ancestor = document.querySelector<HTMLElement>("#ancestor")!;
        const host = document.querySelector<HTMLElement>("#mixed")!;
        const sourceNodes = [host.firstChild as Text, document.querySelector<HTMLElement>("#emphasis")!] as const;
        setLayoutBox(host, 640, 120);
        runtime.candidates = [{element: host, nodes: sourceNodes, kind: "content", reason: "inline-run"}];
        const firstRequest = deferred<string[]>();
        runtime.requests.mockImplementationOnce(() => firstRequest.promise);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const visibilityObserver = TestIntersectionObserver.instances[0]!;
        visibilityObserver.emit(host, true);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();

        const firstSegment = host.querySelector<HTMLElement>('[data-fr-translation-segment="true"]')!;
        const firstState = getTranslationState(firstSegment)!;
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(firstState.phase).toBe("loading");

        ancestor.hidden = true;
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "attributes",
            target: ancestor,
            attributeName: "hidden",
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);

        expect(firstState.controller.signal.aborted).toBe(true);
        expect(firstSegment.isConnected).toBe(false);
        expect(ancestor.querySelectorAll(
            '[data-fr-translation-segment="true"], [data-fr-translation-owned="true"]',
        )).toHaveLength(0);

        firstRequest.resolve(runtime.requests.mock.calls[0]![0].map((origin) => `旧译:${origin}`));
        await finishScheduledWork();
        expect(ancestor.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(0);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        ancestor.hidden = false;
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "attributes",
            target: ancestor,
            attributeName: "hidden",
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await vi.advanceTimersByTimeAsync(50);
        visibilityObserver.emit(host, true);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(host.querySelectorAll('[data-fr-translation-segment="true"]')).toHaveLength(1);
        expect(host.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
        expect(host.textContent).toContain("旧译:");
    });

    it("loading synthetic 内新增 lookalike owned artifact 后安全恢复并复用原请求", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = `
            <div id="mixed">Readable inline prefix <strong id="emphasis">with emphasized prose.</strong>
                <p>Independent block child.</p>
            </div>
        `;
        const host = document.querySelector<HTMLElement>("#mixed")!;
        const sourceText = host.firstChild as Text;
        const emphasis = document.querySelector<HTMLElement>("#emphasis")!;
        const sourceNodes = [sourceText, emphasis] as const;
        setLayoutBox(host, 640, 120);
        runtime.candidates = [{element: host, nodes: sourceNodes, kind: "content", reason: "inline-run"}];
        const firstRequest = deferred<string[]>();
        runtime.requests.mockImplementationOnce(() => firstRequest.promise);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const visibilityObserver = TestIntersectionObserver.instances[0]!;
        visibilityObserver.emit(host, true);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();

        const segment = host.querySelector<HTMLElement>('[data-fr-translation-segment="true"]')!;
        const spinner = segment.querySelector<HTMLElement>('[data-fr-translation-owned="true"]')!;
        const mutationObserver = TestMutationObserver.instances.at(-1)!;
        mutationObserver.emit([{
            type: "childList",
            target: segment,
            addedNodes: [...sourceNodes, spinner] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        expect(segment.isConnected).toBe(true);

        const lookalike = document.createElement("span");
        lookalike.setAttribute("data-fr-translation-owned", "true");
        lookalike.textContent = "Host inserted lookalike artifact";
        segment.appendChild(lookalike);
        mutationObserver.emit([{
            type: "childList",
            target: segment,
            addedNodes: [lookalike] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);

        expect(segment.isConnected).toBe(false);
        expect(lookalike.isConnected).toBe(false);
        firstRequest.resolve(runtime.requests.mock.calls[0]![0].map((origin) => `译:${origin}`));
        await finishScheduledWork();
        visibilityObserver.emit(host, true);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(host.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
    });

    it("AI 上下文请求在 attribute/owner 与下一代 source 依次失效后只提交最新 generation", async () => {
        runtime.config.service = "ai";
        runtime.config.model.ai = "ai-model";
        runtime.config.enableAIContext = true;
        document.body.innerHTML = `
            <article id="owner" data-layout="paragraph">
                <p id="math">A long perspective paragraph with an inline formula.</p>
            </article>
        `;
        const owner = document.querySelector<HTMLElement>("#owner")!;
        const paragraph = document.querySelector<HTMLElement>("#math")!;
        setLayoutBox(owner, 750, 180);
        setLayoutBox(paragraph, 750, 140);
        runtime.candidates = [{element: paragraph, kind: "content", reason: "paragraph"}];

        const firstRequest = deferred<string[]>();
        const secondRequest = deferred<string[]>();
        runtime.requests
            .mockImplementationOnce(() => firstRequest.promise)
            .mockImplementationOnce(() => secondRequest.promise);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const observer = TestIntersectionObserver.instances[0]!;
        observer.emit(paragraph, true);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(runtime.requests).toHaveBeenNthCalledWith(1, [
            "A long perspective paragraph with an inline formula.",
        ]);

        // 首先只使语义所有权失效，并刻意保持原文不变，以证明此路径依赖提交时复验候选，
        // 而不是仅依赖来源快照检查。
        owner.setAttribute("data-layout", "article");
        runtime.candidates = [{element: owner, kind: "content", reason: "article-prose"}];
        firstRequest.resolve(["译:A long perspective paragraph with an inline formula."]);

        await waitForRequestCount(2);
        expect(runtime.requests).toHaveBeenNthCalledWith(2, [
            "A long perspective paragraph with an inline formula.",
        ]);

        // 新 ARTICLE generation 进入在途状态后改变其原文并完成旧请求；生命周期重试
        // 必须按新来源签名重置，且只能提交第三 generation。
        paragraph.firstChild!.nodeValue = "The settled perspective paragraph keeps the inline formula intact.";
        secondRequest.resolve(["译:A long perspective paragraph with an inline formula."]);

        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(3);
        expect(runtime.requests).toHaveBeenNthCalledWith(3, [
            "The settled perspective paragraph keeps the inline formula intact.",
        ]);
        expect(singleTranslationText(paragraph)).toBe("译:The settled perspective paragraph keeps the inline formula intact.");

        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(3);
    });

    it("显式 unchanged 在同一全文会话形成 source 签名墓碑，普通 rescan 不重复请求", async () => {
        document.body.innerHTML = '<h1 id="brand">Microsoft</h1>';
        const brand = document.querySelector<HTMLElement>("#brand")!;
        setLayoutBox(brand, 300, 48);
        runtime.candidates = [{element: brand, kind: "content", reason: "heading"}];
        runtime.requests.mockImplementation(async (origins) => [...origins]);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        TestIntersectionObserver.instances[0]!.emit(brand, true);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(brand.textContent).toBe("Microsoft");

        brand.className = "layout-only-change";
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "attributes",
            target: brand,
            attributeName: "class",
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it.each([
        {display: 0, expectedLayoutChecks: 0, label: "single"},
        {display: 1, expectedLayoutChecks: 1, label: "bilingual"},
    ] as const)(
        "$label 已译内容发生纯布局 mutation 时只为双语 wrapper 续租 unclamp",
        async ({display, expectedLayoutChecks}) => {
            runtime.config.display = display;
            document.body.innerHTML = '<p id="prose">Stable source under a layout-only mutation.</p>';
            const paragraph = document.querySelector<HTMLElement>("#prose")!;
            setLayoutBox(paragraph, 620, 90);
            runtime.candidates = [{element: paragraph, kind: "content", reason: "paragraph"}];

            autoTranslateEnglishPage();
            await vi.advanceTimersByTimeAsync(50);
            TestIntersectionObserver.instances[0]!.emit(paragraph, true);
            await finishScheduledWork();
            expect(getTranslationState(paragraph)?.phase).toBe("translated");

            paragraph.classList.add("host-layout-update");
            TestMutationObserver.instances.at(-1)!.emit([{
                type: "attributes",
                target: paragraph,
                attributeName: "class",
                addedNodes: [] as unknown as NodeList,
                removedNodes: [] as unknown as NodeList,
            } as unknown as MutationRecord]);
            await finishScheduledWork();

            expect(runtime.ensureTranslationTruncationLayout)
                .toHaveBeenCalledTimes(expectedLayoutChecks);
            expect(runtime.requests).toHaveBeenCalledTimes(1);
        },
    );

    it("仅译文保留动态组件的原 Text，宿主一致性校验不再与重译循环争用", async () => {
        runtime.config.display = 0;
        runtime.config.fullPageTranslationMode = "all";
        document.body.innerHTML = '<relative-time id="time">12 hours ago</relative-time>';
        const time = document.querySelector<HTMLElement>("#time")!;
        const originalText = time.firstChild as Text;
        setLayoutBox(time, 120, 24);
        runtime.candidates = [{element: time, kind: "content", reason: "generic-text-container"}];

        autoTranslateEnglishPage();
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(runtime.requests).toHaveBeenCalledWith(["12 hours ago"]);
        expect(singleTranslationText(time)).toBe("译:12 hours ago");
        expect(time.textContent).toBe("12 hours ago");
        expect(time.querySelector('.fluent-read-single-slot')?.firstChild).toBe(originalText);

        // GitHub 这类组件会读取 textContent 并在值偏离时写回。旧实现每轮
        // 都会看到译文并写回英文；新实现中连续校验不产生任何 mutation。
        let hostCorrections = 0;
        for (let index = 0; index < 5; index += 1) {
            if (time.textContent !== "12 hours ago") {
                time.textContent = "12 hours ago";
                hostCorrections += 1;
            }
        }
        expect(hostCorrections).toBe(0);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        restoreOriginalContent();
        expect(time.textContent).toBe("12 hours ago");
        expect(time.querySelector('.fluent-read-single-slot')).toBeNull();
    });

    it("仅译文 slot 内部的 childList mutation 不应触发 GitHub 侧边栏翻译恢复循环", async () => {
        runtime.config.display = 0;
        runtime.config.fullPageTranslationMode = "all";
        document.body.innerHTML = '<relative-time id="sidebar-time">12 hours ago</relative-time>';
        const time = document.querySelector<HTMLElement>("#sidebar-time")!;
        setLayoutBox(time, 120, 24);
        runtime.candidates = [{element: time, kind: "content", reason: "generic-text-container"}];

        autoTranslateEnglishPage();
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        const slot = time.querySelector<HTMLElement>(".fluent-read-single-slot")!;
        const source = slot.firstChild!;
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "childList",
            target: slot,
            addedNodes: [source] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(getTranslationState(time)?.phase).toBe("translated");
        expect(singleTranslationText(time)).toBe("译:12 hours ago");

        source.nodeValue = "13 hours ago";
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "characterData",
            target: source,
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(2);
        expect(runtime.requests).toHaveBeenLastCalledWith(["13 hours ago"]);
    });

    it("X 虚拟列表在请求进行中重建相同原文时不应取消当前翻译请求", async () => {
        runtime.config.display = 1;
        runtime.config.fullPageTranslationMode = "all";
        const source = "The same X post survives a virtualized layout update.";
        document.body.innerHTML = `<article data-testid="tweet"><div id="tweet-text" data-testid="tweetText">${source}</div></article>`;
        const tweetText = document.querySelector<HTMLElement>("#tweet-text")!;
        setLayoutBox(tweetText, 620, 96);
        runtime.candidates = [{element: tweetText, kind: "content", reason: "x-post-text", adapterId: "x"}];

        const request = deferred<string[]>();
        runtime.requests.mockImplementationOnce(() => request.promise);

        autoTranslateEnglishPage();
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        const previousSource = tweetText.firstChild!;
        const spinner = tweetText.querySelector<HTMLElement>("[data-fr-translation-owned=\"true\"]")!;
        const replacementSource = document.createTextNode(source);
        tweetText.replaceChildren(replacementSource);
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "childList",
            target: tweetText,
            addedNodes: [replacementSource] as unknown as NodeList,
            removedNodes: [previousSource, spinner] as unknown as NodeList,
        } as unknown as MutationRecord]);

        expect(runtime.cancelQueue).not.toHaveBeenCalled();
        request.resolve([`译:${source}`]);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(tweetText.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
    });

    it("仅译文 X 文本在请求进行中重建相同原文时仍复用当前 generation", async () => {
        runtime.config.display = 0;
        runtime.config.fullPageTranslationMode = "all";
        const source = "The same X post stays readable in translation-only mode.";
        document.body.innerHTML = `<article data-testid="tweet"><div id="tweet-text" data-testid="tweetText">${source}</div></article>`;
        const tweetText = document.querySelector<HTMLElement>("#tweet-text")!;
        setLayoutBox(tweetText, 620, 96);
        runtime.candidates = [{element: tweetText, kind: "content", reason: "x-post-text", adapterId: "x"}];

        const request = deferred<string[]>();
        runtime.requests.mockImplementationOnce(() => request.promise);

        autoTranslateEnglishPage();
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        const previousSource = tweetText.firstChild!;
        const spinner = tweetText.querySelector<HTMLElement>("[data-fr-translation-owned=\"true\"]")!;
        const replacementSource = document.createTextNode(source);
        tweetText.replaceChildren(replacementSource);
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "childList",
            target: tweetText,
            addedNodes: [replacementSource] as unknown as NodeList,
            removedNodes: [previousSource, spinner] as unknown as NodeList,
        } as unknown as MutationRecord]);

        expect(runtime.cancelQueue).not.toHaveBeenCalled();
        request.resolve([`译:${source}`]);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(singleTranslationText(tweetText)).toBe(`译:${source}`);
    });

    it("全文滚动期间暂停新翻译，停止滚动后再继续排队", async () => {
        runtime.config.display = 1;
        runtime.config.fullPageTranslationMode = "all";
        runtime.config.maxConcurrentTranslations = 1;
        document.body.innerHTML = '<p id="first">First visible post.</p><p id="second">Second visible post.</p>';
        const candidates = Array.from(document.querySelectorAll<HTMLElement>("p"));
        candidates.forEach((candidate) => setLayoutBox(candidate, 620, 96));
        runtime.candidates = candidates.map((element) => ({
            element,
            kind: "content" as const,
            reason: "x-post-text",
            adapterId: "x",
        }));

        const firstRequest = deferred<string[]>();
        const secondRequest = deferred<string[]>();
        runtime.requests
            .mockImplementationOnce(() => firstRequest.promise)
            .mockImplementationOnce(() => secondRequest.promise);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(51);
        await Promise.resolve();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        document.dispatchEvent(new window.Event("scroll"));
        firstRequest.resolve(["译:First visible post."]);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(220);
        await Promise.resolve();
        expect(runtime.requests).toHaveBeenCalledTimes(2);
        secondRequest.resolve(["译:Second visible post."]);
        await finishScheduledWork();

        expect(candidates.map((candidate) => candidate.querySelectorAll(".fluent-read-bilingual-content").length))
            .toEqual([1, 1]);
    });

    it("插入全文译文时补偿视口锚点位移，避免页面跳动", async () => {
        runtime.config.display = 1;
        runtime.config.fullPageTranslationMode = "all";
        document.body.innerHTML = '<p id="target">A translated post changes layout.</p><p id="anchor">The reader anchor must stay still.</p>';
        const target = document.querySelector<HTMLElement>("#target")!;
        const anchor = document.querySelector<HTMLElement>("#anchor")!;
        setLayoutBox(target, 620, 96);
        let anchorRectReads = 0;
        Object.defineProperty(anchor, "getBoundingClientRect", {
            configurable: true,
            value: () => {
                anchorRectReads += 1;
                const top = anchorRectReads % 2 === 1 ? 420 : 452;
                return {width: 620, height: 96, top, right: 620, bottom: top + 96, left: 0, x: 0, y: top};
            },
        });
        Object.defineProperty(document, "elementFromPoint", {
            configurable: true,
            value: () => anchor,
        });
        const scrollBy = vi.fn();
        Object.defineProperty(window, "scrollBy", {configurable: true, value: scrollBy});
        runtime.candidates = [{element: target, kind: "content", reason: "x-post-text", adapterId: "x"}];

        autoTranslateEnglishPage();
        await finishScheduledWork();

        expect(target.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
        expect(scrollBy).toHaveBeenCalledWith(0, 32);
    });

    it("已译 prose 原子重放 MathJax/code 等输出骨架，外层 source 变化才重新请求", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = `
            <p id="prose">
                <span id="lead">Readable prose before protected renderers. </span>
                <span id="math-v2-root" class="MathJax_Display"><span id="math-v2">x + y</span></span>
                <mjx-container id="math-v3-root"><span id="math-v3">a = b</span></mjx-container>
                <span id="katex-root" class="katex"><span id="katex">c = d</span></span>
                <code id="code">const answer = 42;</code>
                <span id="translate-no" translate="no">Do not translate</span>
                <span id="notranslate" class="notranslate">Keep original</span>
                <span id="tail"> Readable prose after protected renderers.</span>
            </p>
        `;
        const paragraph = document.querySelector<HTMLElement>("#prose")!;
        const lead = document.querySelector<HTMLElement>("#lead")!;
        const protectedChurnHosts = [
            "#math-v2", "#math-v3", "#katex", "#code", "#translate-no", "#notranslate",
        ].map((selector) => document.querySelector<HTMLElement>(selector)!);
        const protectedAttributeRoots = [
            "#math-v2-root", "#math-v3-root", "#katex-root", "#code", "#translate-no", "#notranslate",
        ].map((selector) => document.querySelector<HTMLElement>(selector)!);
        setLayoutBox(paragraph, 700, 140);
        runtime.candidates = [{element: paragraph, kind: "content", reason: "paragraph"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const visibilityObserver = TestIntersectionObserver.instances[0]!;
        visibilityObserver.emit(paragraph, true);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        const firstWrapper = paragraph.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        expect(firstWrapper?.isConnected).toBe(true);
        expect(paragraph.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);

        const records: MutationRecord[] = [];
        for (const [index, host] of protectedChurnHosts.entries()) {
            const text = host.firstChild as Text;
            text.nodeValue = `host churn ${index}`;
            records.push({
                type: "characterData",
                target: text,
                addedNodes: [] as unknown as NodeList,
                removedNodes: [] as unknown as NodeList,
            } as unknown as MutationRecord);
            const renderedChild = document.createElement("span");
            renderedChild.textContent = `rendered ${index}`;
            host.appendChild(renderedChild);
            records.push({
                type: "childList",
                target: host,
                addedNodes: [renderedChild] as unknown as NodeList,
                removedNodes: [] as unknown as NodeList,
            } as unknown as MutationRecord);
        }
        for (const [index, root] of protectedAttributeRoots.entries()) {
            root.setAttribute("style", `--render-pass: ${index}`);
            records.push({
                type: "attributes",
                target: root,
                attributeName: "style",
                addedNodes: [] as unknown as NodeList,
                removedNodes: [] as unknown as NodeList,
            } as unknown as MutationRecord);
        }
        TestMutationObserver.instances.at(-1)!.emit(records);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(firstWrapper.isConnected).toBe(true);
        expect(paragraph.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);

        lead.firstChild!.nodeValue = "Updated readable prose before protected renderers. ";
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "characterData",
            target: lead.firstChild!,
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await vi.advanceTimersByTimeAsync(50);
        visibilityObserver.emit(paragraph, true);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(2);
        expect(firstWrapper.isConnected).toBe(false);
        expect(paragraph.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
    });

    it("离屏 MathJax 与同槽链接骨架原子刷新 wrapper，真实 prose 变化仍重启", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = `
            <p id="prose">
                <span id="lead">Perspective projection prose stays translatable. </span>
                <span id="preview" class="MathJax_Preview">FORMULA_PREVIEW_SECRET</span>
                <script id="tex" type="math/tex; mode=display">FORMULA_TEX_SECRET</script>
                <span id="tail"> The explanation continues around the equation.</span>
                <a id="reference" href="/before">Stable reference text</a>
            </p>
        `;
        const paragraph = document.querySelector<HTMLElement>("#prose")!;
        const lead = document.querySelector<HTMLElement>("#lead")!;
        const preview = document.querySelector<HTMLElement>("#preview")!;
        const reference = document.querySelector<HTMLAnchorElement>("#reference")!;
        setLayoutBox(paragraph, 750, 338);
        runtime.candidates = [{element: paragraph, kind: "content", reason: "paragraph"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const visibilityObserver = TestIntersectionObserver.instances[0]!;
        const mutationObserver = TestMutationObserver.instances.at(-1)!;
        visibilityObserver.emit(paragraph, true);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(runtime.requests.mock.calls[0]![0].join(" ")).not.toMatch(
            /FORMULA_PREVIEW_SECRET|FORMULA_TEX_SECRET/u,
        );
        const firstWrapper = paragraph.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        expect(firstWrapper.isConnected).toBe(true);

        // 候选已离开 IO。MathJax v2 会先在直属 P 边界插入未分类、脱离文档的 staging span，
        // 再替换为受保护的 Display/MathJax 树，同时保留 TeX 来源 script；不能依赖第二次
        // 正向 IO 事件修复丢失的 wrapper。
        visibilityObserver.emit(paragraph, false);
        const staging = document.createElement("span");
        preview.replaceWith(staging);
        const display = document.createElement("span");
        display.className = "MathJax_Display";
        const renderedMath = document.createElement("span");
        renderedMath.className = "MathJax";
        renderedMath.textContent = "FORMULA_RENDERED_SECRET";
        display.append(renderedMath);
        staging.replaceWith(display);
        mutationObserver.emit([
            {
                type: "childList",
                target: paragraph,
                addedNodes: [staging] as unknown as NodeList,
                removedNodes: [preview] as unknown as NodeList,
            } as unknown as MutationRecord,
            {
                type: "childList",
                target: paragraph,
                addedNodes: [display] as unknown as NodeList,
                removedNodes: [staging] as unknown as NodeList,
            } as unknown as MutationRecord,
            {
                type: "childList",
                target: display,
                addedNodes: [renderedMath] as unknown as NodeList,
                removedNodes: [] as unknown as NodeList,
            } as unknown as MutationRecord,
        ]);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(firstWrapper.isConnected).toBe(true);
        expect(paragraph.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);

        // 真实原文编辑沿用现有重启路径；惰性全文调度仍等待可见性，重新进入后只请求一次
        // 新 payload，并继续排除 renderer 内容。
        lead.firstChild!.nodeValue = "Updated perspective projection prose must be translated. ";
        mutationObserver.emit([{
            type: "characterData",
            target: lead.firstChild!,
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await finishScheduledWork();
        expect(firstWrapper.isConnected).toBe(false);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        visibilityObserver.emit(paragraph, true);
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(2);
        expect(runtime.requests.mock.calls[1]![0].join(" ")).toContain(
            "Updated perspective projection prose must be translated.",
        );
        expect(runtime.requests.mock.calls[1]![0].join(" ")).not.toMatch(
            /FORMULA_RENDERED_SECRET|FORMULA_TEX_SECRET/u,
        );

        // 用同文本替换行内链接会刷新安全输出骨架，但 provider 槽未变，因此保留
        // wrapper identity 且不出现 source-only 帧。
        const secondWrapper = paragraph.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        const secondState = getTranslationState(paragraph)!;
        const secondSignature = secondState.sourceStructureSignature;
        const replacementReference = document.createElement("a");
        replacementReference.id = "reference-next";
        replacementReference.href = "/after";
        replacementReference.textContent = reference.textContent;
        reference.replaceWith(replacementReference);
        mutationObserver.emit([{
            type: "childList",
            target: paragraph,
            addedNodes: [replacementReference] as unknown as NodeList,
            removedNodes: [reference] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await finishScheduledWork();

        expect(secondWrapper.isConnected).toBe(true);
        expect(getTranslationState(paragraph)).toBe(secondState);
        expect(secondState.sourceStructureSignature).not.toBe(secondSignature);
        expect(runtime.requests).toHaveBeenCalledTimes(2);
        visibilityObserver.emit(paragraph, true);
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(2);
    });

    it("宿主篡改译文 wrapper 后以会话缓存的可信结果恢复", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = '<p id="prose">Host prose remains authoritative.</p>';
        const paragraph = document.querySelector<HTMLElement>("#prose")!;
        setLayoutBox(paragraph, 620, 90);
        runtime.candidates = [{element: paragraph, kind: "content", reason: "paragraph"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const visibilityObserver = TestIntersectionObserver.instances[0]!;
        visibilityObserver.emit(paragraph, true);
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        const firstWrapper = paragraph.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        const translatedText = firstWrapper.firstChild as Text;
        translatedText.nodeValue = "Host overwrote the extension translation.";
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "characterData",
            target: translatedText,
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await vi.advanceTimersByTimeAsync(50);
        visibilityObserver.emit(paragraph, true);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(firstWrapper.isConnected).toBe(false);
        expect(paragraph.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
        expect(paragraph.textContent).toContain("译:Host prose remains authoritative.");
    });

    it("全文 childList 用篡改 clone 替换当前 wrapper 时 callback 内恢复可信译文", async () => {
        runtime.config.display = 1;
        const source = "A forged wrapper clone must never become the current translation.";
        document.body.innerHTML = `<p id="clone-tamper-owner">${source}</p>`;
        const owner = document.querySelector<HTMLElement>("#clone-tamper-owner")!;
        setLayoutBox(owner, 620, 90);
        runtime.candidates = [{element: owner, kind: "content", reason: "paragraph"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        TestIntersectionObserver.instances[0]!.emit(owner, true);
        await finishScheduledWork();

        const state = getTranslationState(owner)!;
        const wrapper = owner.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        const forged = wrapper.cloneNode(true) as HTMLElement;
        forged.textContent = "Host-forged translation.";
        wrapper.replaceWith(forged);
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "childList",
            target: owner,
            addedNodes: [forged] as unknown as NodeList,
            removedNodes: [wrapper] as unknown as NodeList,
        } as unknown as MutationRecord]);

        const current = owner.querySelector<HTMLElement>(".fluent-read-bilingual-content");
        expect(forged.isConnected).toBe(false);
        expect(owner.textContent).not.toContain("Host-forged translation.");
        expect(owner.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
        expect(current?.textContent).toBe(`译:${source}`);
        expect(getTranslationState(owner)).toBe(state);
        expect(state.bilingualContent).toBe(current);
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it.each(["class", "style", "lang", "dir", "translate"] as const)(
        "wrapper 的 %s 属性被宿主篡改后不会误判为当前工件",
        async (attributeName) => {
            runtime.config.display = 1;
            document.body.innerHTML = '<p id="attribute-owner">Wrapper attributes stay authoritative.</p>';
            const paragraph = document.querySelector<HTMLElement>("#attribute-owner")!;
            setLayoutBox(paragraph, 620, 90);
            runtime.candidates = [{element: paragraph, kind: "content", reason: "paragraph"}];

            autoTranslateEnglishPage();
            await vi.advanceTimersByTimeAsync(50);
            const visibilityObserver = TestIntersectionObserver.instances[0]!;
            visibilityObserver.emit(paragraph, true);
            await finishScheduledWork();
            const wrapper = paragraph.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;

            const values = {
                class: wrapper.className + " site-tampered",
                style: "opacity: 0.5",
                lang: "ja",
                dir: "rtl",
                translate: "yes",
            };
            wrapper.setAttribute(attributeName, values[attributeName]);
            TestMutationObserver.instances.at(-1)!.emit([{
                type: "attributes",
                target: wrapper,
                attributeName,
                addedNodes: [] as unknown as NodeList,
                removedNodes: [] as unknown as NodeList,
            } as unknown as MutationRecord]);
            await finishScheduledWork();
            visibilityObserver.emit(paragraph, true);
            await finishScheduledWork();

            expect(runtime.requests).toHaveBeenCalledTimes(1);
            expect(wrapper.isConnected).toBe(attributeName === "class");
            if (attributeName === "class") {
                expect(wrapper.classList.contains("site-tampered")).toBe(true);
            }
            expect(paragraph.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
            expect(getTranslationState(paragraph)?.phase).toBe("translated");
        },
    );

    it.each(["element", "text"] as const)(
        "宿主向译文 wrapper append %s 后以会话缓存的可信结果恢复",
        async (kind) => {
            runtime.config.display = 1;
            document.body.innerHTML = '<p id="prose">Host prose remains authoritative.</p>';
            const paragraph = document.querySelector<HTMLElement>("#prose")!;
            setLayoutBox(paragraph, 620, 90);
            runtime.candidates = [{element: paragraph, kind: "content", reason: "paragraph"}];

            autoTranslateEnglishPage();
            await vi.advanceTimersByTimeAsync(50);
            const visibilityObserver = TestIntersectionObserver.instances[0]!;
            visibilityObserver.emit(paragraph, true);
            await finishScheduledWork();
            expect(runtime.requests).toHaveBeenCalledTimes(1);

            const firstWrapper = paragraph.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
            const mutationObserver = TestMutationObserver.instances.at(-1)!;

            // MutationObserver 会异步送达扩展自身的 wrapper 插入；快照完整时必须保持 no-op。
            mutationObserver.emit([{
                type: "childList",
                target: paragraph,
                addedNodes: [firstWrapper] as unknown as NodeList,
                removedNodes: [] as unknown as NodeList,
            } as unknown as MutationRecord]);
            await finishScheduledWork();
            expect(runtime.requests).toHaveBeenCalledTimes(1);
            expect(firstWrapper.isConnected).toBe(true);

            const appended = kind === "element"
                ? document.createElement("span")
                : document.createTextNode("Host appended translation text.");
            if (appended.nodeType === 1) appended.textContent = "Host appended translation element.";
            firstWrapper.appendChild(appended);
            mutationObserver.emit([{
                type: "childList",
                target: firstWrapper,
                addedNodes: [appended] as unknown as NodeList,
                removedNodes: [] as unknown as NodeList,
            } as unknown as MutationRecord]);
            await vi.advanceTimersByTimeAsync(50);
            visibilityObserver.emit(paragraph, true);
            await finishScheduledWork();

            expect(runtime.requests).toHaveBeenCalledTimes(1);
            expect(firstWrapper.isConnected).toBe(false);
            expect(paragraph.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
        },
    );

    it("普通后代新增 translate=no 后复用未变文本槽并排除受保护文本", async () => {
        runtime.config.display = 1;
        document.body.innerHTML = `
            <p id="prose">
                <span>Readable prefix. </span>
                <span id="dynamic">This text becomes protected.</span>
                <span> Readable suffix.</span>
            </p>
        `;
        const paragraph = document.querySelector<HTMLElement>("#prose")!;
        const dynamic = document.querySelector<HTMLElement>("#dynamic")!;
        setLayoutBox(paragraph, 620, 90);
        runtime.candidates = [{element: paragraph, kind: "content", reason: "paragraph"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const visibilityObserver = TestIntersectionObserver.instances[0]!;
        visibilityObserver.emit(paragraph, true);
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(runtime.requests.mock.calls[0]![0].join(" ")).toContain("This text becomes protected.");

        const firstWrapper = paragraph.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        dynamic.setAttribute("translate", "no");
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "attributes",
            target: dynamic,
            attributeName: "translate",
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await vi.advanceTimersByTimeAsync(50);
        visibilityObserver.emit(paragraph, true);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(firstWrapper.isConnected).toBe(false);
        const refreshedWrapper = paragraph.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        expect(refreshedWrapper).toBeTruthy();
        expect(refreshedWrapper.textContent).toContain("译:Readable prefix.");
        expect(refreshedWrapper.textContent).not.toContain("译:This text becomes protected.");
    });

    it("provider 空结果的立即重排有上限，source 变化后才开启新 generation", async () => {
        document.body.innerHTML = '<p id="late">Initial prose before hydration.</p>';
        const paragraph = document.querySelector<HTMLElement>("#late")!;
        setLayoutBox(paragraph, 600, 80);
        runtime.candidates = [{element: paragraph, kind: "content", reason: "late-paragraph"}];
        const firstRequest = deferred<string[]>();
        runtime.requests
            .mockImplementationOnce(() => firstRequest.promise)
            .mockImplementation(async () => []);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        const observer = TestIntersectionObserver.instances[0]!;
        observer.emit(paragraph, true);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        // 此 key 在途时重新进入 IO 阈值只能保留一个 pending 唤醒；有界空结果重试完成前，
        // 不得创建会遗忘当前 generation 的 `owned` 任务。
        observer.emit(paragraph, true);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        firstRequest.resolve([]);
        await finishScheduledWork();

        // 初始请求加两次生命周期重试后，第三个可重试结果只保存封顶签名，不得安排第四次请求。
        expect(runtime.requests).toHaveBeenCalledTimes(3);

        paragraph.firstChild!.nodeValue = "Late prose became readable after hydration.";
        runtime.requests.mockImplementation(async (origins) => origins.map((origin) => `译:${origin}`));
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "characterData",
            target: paragraph.firstChild!,
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord]);
        await vi.advanceTimersByTimeAsync(50);
        expect(observer.observed.has(paragraph)).toBe(true);
        observer.emit(paragraph, true);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(4);
        expect(singleTranslationText(paragraph)).toBe("译:Late prose became readable after hydration.");
    });
});

describe("悬停重挂请求与 synthetic 提交回归", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        runtime.candidates = [];
        runtime.pointCandidate = null;
        runtime.requests.mockReset();
        runtime.requests.mockImplementation(async (origins) => origins.map((origin) => `译:${origin}`));
        runtime.requestOptions = [];
        runtime.renderOptions = [];
        runtime.parsedSlots = null;
        runtime.cancelQueue.mockReset();
        runtime.retryCallbacks = [];
        runtime.config.service = "microsoft";
        runtime.config.model = {microsoft: "microsoft-default", freeTranslation: "free-default"};
        runtime.config.customModel = {};
        runtime.config.modelThinking = {};
        runtime.config.from = "en";
        runtime.config.to = "zh";
        runtime.config.useCache = true;
        runtime.config.enableAIContext = false;
        runtime.config.enableAIMultiSegment = false;
        runtime.config.display = 1;
        runtime.config.style = 0;
        runtime.config.fullPageTranslationMode = "viewport";
        runtime.config.translationScope = "content";
        runtime.config.maxConcurrentTranslations = 3;
        runtime.ensureTranslationTruncationLayout.mockClear();
        runtime.clearlyTargetLanguage.mockReset();
        runtime.clearlyTargetLanguage.mockReturnValue(false);
        TestIntersectionObserver.instances = [];
        TestMutationObserver.instances = [];

        const {window, document} = parseHTML("<html><head><title>Lifecycle fixture</title></head><body></body></html>");
        replaceGlobal("window", window);
        replaceGlobal("document", document);
        replaceGlobal("Node", window.Node);
        replaceGlobal("Element", window.Element);
        replaceGlobal("HTMLElement", window.HTMLElement);
        replaceGlobal("Text", window.Text);
        replaceGlobal("ShadowRoot", window.ShadowRoot);
        replaceGlobal("DOMParser", window.DOMParser);
        replaceGlobal("MutationObserver", TestMutationObserver);
        replaceGlobal("IntersectionObserver", TestIntersectionObserver);
        Object.defineProperty(window, "setTimeout", {configurable: true, value: globalThis.setTimeout});
        Object.defineProperty(window, "clearTimeout", {configurable: true, value: globalThis.clearTimeout});
    });

    afterEach(() => {
        restoreOriginalContent();
        vi.clearAllTimers();
        vi.useRealTimers();
        for (const [name, descriptor] of replacedGlobals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        replacedGlobals.clear();
    });

    it("hover waiter 退出后刚结算的结果在固定 250ms 重挂窗口内复用，过期与 reset 后失效", async () => {
        const source = "A hover owner can disappear while its provider request settles.";
        const snapshot = translationSnapshot({service: "custom-provider", model: "hover-model"});
        const firstProvider = deferred<string[]>();
        runtime.requests
            .mockImplementationOnce(() => firstProvider.promise)
            .mockImplementation(async (origins) => origins.map((origin) => `新译:${origin}`));
        const session = getHoverTranslationRequestSession();
        const firstOwner = new AbortController();
        const first = translateTextSlots([source], snapshot, firstOwner.signal, undefined, session);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        firstOwner.abort();
        await expect(first).rejects.toMatchObject({name: "AbortError"});
        firstProvider.resolve([`旧译:${source}`]);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // replacement 可能直到 provider resolve 后的下一个 observer/macro task 才建立 waiter。
        await vi.advanceTimersByTimeAsync(0);
        await expect(translateTextSlots([source], snapshot, undefined, undefined, session))
            .resolves.toEqual([`旧译:${source}`]);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(249);
        await expect(translateTextSlots([source], snapshot, undefined, undefined, session))
            .resolves.toEqual([`旧译:${source}`]);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        await expect(translateTextSlots([source], snapshot, undefined, undefined, session))
            .resolves.toEqual([`新译:${source}`]);
        expect(runtime.requests).toHaveBeenCalledTimes(2);

        resetHoverTranslationRequestSession(new Error("route reset"));
        const resetSession = getHoverTranslationRequestSession();
        expect(session.active).toBe(false);
        expect(resetSession).not.toBe(session);
        await expect(translateTextSlots([source], snapshot, undefined, undefined, resetSession))
            .resolves.toEqual([`新译:${source}`]);
        expect(runtime.requests).toHaveBeenCalledTimes(3);
    });

    it("route reset 后纯 hover 在途结果不得提交，下一代请求仍可正常翻译", async () => {
        runtime.config.display = 1;
        const source = "A hover request from the previous route must not commit.";
        document.body.innerHTML = `<p id="route-hover">${source}</p>`;
        const owner = document.querySelector<HTMLElement>("#route-hover")!;
        const candidate = {element: owner, kind: "content" as const, reason: "paragraph"};
        setLayoutBox(owner, 620, 96);
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;
        const previousRoute = deferred<string[]>();
        runtime.requests
            .mockImplementationOnce(() => previousRoute.promise)
            .mockImplementation(async (origins) => origins.map((origin) => `新译:${origin}`));

        handleTranslation(20, 20, {continuous: true});
        await waitForRequestCount(1);
        expect(getTranslationState(owner)?.phase).toBe("loading");

        resetFullPageTranslationRouteState();
        previousRoute.resolve([`旧译:${source}`]);
        await finishScheduledWork();

        expect(owner.textContent).not.toContain(`旧译:${source}`);
        expect(owner.querySelector(".fluent-read-bilingual-content")).toBeNull();
        expect(owner.querySelector(".fluent-read-retry-wrapper")).toBeNull();

        handleTranslation(20, 20, {continuous: true});
        await finishScheduledWork();
        expect(runtime.requests).toHaveBeenCalledTimes(2);
        expect(getTranslationState(owner)?.phase).toBe("translated");
        expect(owner.textContent).toContain(`新译:${source}`);
    });

    it("route reset 后全文在途结果不得提交，同一候选可由新请求完成", async () => {
        runtime.config.display = 1;
        const source = "A full-page request from the previous route must not commit.";
        document.body.innerHTML = `<p id="route-full-page">${source}</p>`;
        const owner = document.querySelector<HTMLElement>("#route-full-page")!;
        const candidate = {element: owner, kind: "content" as const, reason: "paragraph"};
        setLayoutBox(owner, 620, 96);
        runtime.candidates = [candidate];
        runtime.pointCandidate = candidate;
        const previousRoute = deferred<string[]>();
        const currentRoute = deferred<string[]>();
        runtime.requests
            .mockImplementationOnce(() => previousRoute.promise)
            .mockImplementationOnce(() => currentRoute.promise);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        TestIntersectionObserver.instances[0]!.emit(owner, true);
        await waitForRequestCount(1);
        expect(getTranslationState(owner)?.phase).toBe("loading");

        resetFullPageTranslationRouteState();
        previousRoute.resolve([`旧译:${source}`]);
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();

        expect(owner.textContent).not.toContain(`旧译:${source}`);
        expect(owner.querySelector(".fluent-read-bilingual-content")).toBeNull();
        expect(owner.querySelector(".fluent-read-retry-wrapper")).toBeNull();

        handleTranslation(20, 20, {continuous: true});
        await waitForRequestCount(2);
        expect(runtime.requests).toHaveBeenCalledTimes(2);
        currentRoute.resolve([`新译:${source}`]);
        await finishScheduledWork();

        expect(getTranslationState(owner)?.phase).toBe("translated");
        expect(owner.textContent).toContain(`新译:${source}`);
        expect(owner.textContent).not.toContain(`旧译:${source}`);
    });

    it("AI 全文在途请求不因无关 class mutation 失效或二次请求", async () => {
        runtime.config.display = 1;
        runtime.config.service = "ai";
        runtime.config.model.ai = "context-model";
        runtime.config.enableAIContext = true;
        const source = "An unrelated decoration must not invalidate this active AI request.";
        document.body.innerHTML = `
            <p id="ai-owner">${source}</p>
            <aside id="unrelated">Live page decoration</aside>
        `;
        const owner = document.querySelector<HTMLElement>("#ai-owner")!;
        const unrelated = document.querySelector<HTMLElement>("#unrelated")!;
        setLayoutBox(owner, 620, 96);
        runtime.candidates = [{element: owner, kind: "content", reason: "paragraph"}];
        const provider = deferred<string[]>();
        runtime.requests.mockImplementation(() => provider.promise);

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        TestIntersectionObserver.instances[0]!.emit(owner, true);
        await waitForRequestCount(1);
        expect(getTranslationState(owner)?.phase).toBe("loading");

        unrelated.classList.add("host-hover-decoration");
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "attributes",
            target: unrelated,
            attributeName: "class",
            oldValue: null,
        } as unknown as MutationRecord]);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        provider.resolve([`译:${source}`]);
        await finishScheduledWork();

        expect(runtime.requests).toHaveBeenCalledTimes(1);
        expect(getTranslationState(owner)?.phase).toBe("translated");
        expect(owner.textContent).toContain(`译:${source}`);
        expect(owner.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
    });

    it("已提交 synthetic nodes 候选处理自身 spinner/wrapper 记录后跨两帧仍保持同一 generation", async () => {
        document.body.innerHTML = `
            <div id="mixed">Readable inline prefix <strong id="emphasis">with emphasized prose.</strong>
                <p>Independent block child.</p>
            </div>
        `;
        const host = document.querySelector<HTMLElement>("#mixed")!;
        const sourceNodes = [host.firstChild as Text, document.querySelector<HTMLElement>("#emphasis")!] as const;
        setLayoutBox(host, 640, 120);
        runtime.candidates = [{element: host, nodes: sourceNodes, kind: "content", reason: "generic-inline-run"}];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        TestIntersectionObserver.instances[0]!.emit(host, true);
        await finishScheduledWork();

        const segment = host.querySelector<HTMLElement>('[data-fr-translation-segment="true"]')!;
        const committedState = getTranslationState(segment)!;
        const wrapper = segment.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        const settledSpinner = committedState.settledSpinner!;
        expect(committedState).toMatchObject({phase: "translated", syntheticSegment: true});
        expect(wrapper.isConnected).toBe(true);

        TestMutationObserver.instances[0]!.emit([
            {
                type: "childList", target: segment,
                addedNodes: [] as unknown as NodeList,
                removedNodes: [settledSpinner] as unknown as NodeList,
            },
            {
                type: "childList", target: segment,
                addedNodes: [wrapper] as unknown as NodeList,
                removedNodes: [] as unknown as NodeList,
            },
        ] as unknown as MutationRecord[]);
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(34);
        await Promise.resolve();

        expect(getTranslationState(segment)).toBe(committedState);
        expect(committedState.controller.signal.aborted).toBe(false);
        expect(segment.isConnected).toBe(true);
        expect(segment.querySelector(".fluent-read-bilingual-content")).toBe(wrapper);
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it("candidate host source-only replaceChildren 在 callback 内复用 synthetic state 与译文", async () => {
        document.body.innerHTML = `
            <div id="mixed">Readable inline prefix <strong>with emphasized prose.</strong>
                <p>Independent block child.</p>
            </div>
        `;
        const host = document.querySelector<HTMLElement>("#mixed")!;
        const firstText = host.firstChild as Text;
        const firstStrong = host.querySelector<HTMLElement>("strong")!;
        setLayoutBox(host, 640, 120);
        runtime.candidates = [{
            element: host,
            nodes: [firstText, firstStrong],
            kind: "content",
            reason: "generic-inline-run",
        }];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        TestIntersectionObserver.instances[0]!.emit(host, true);
        await finishScheduledWork();

        const segment = host.querySelector<HTMLElement>('[data-fr-translation-segment="true"]')!;
        const state = getTranslationState(segment)!;
        const wrapper = segment.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        const replacementText = document.createTextNode("Readable inline prefix ");
        const replacementStrong = document.createElement("strong");
        replacementStrong.textContent = "with emphasized prose.";
        const replacementBlock = document.createElement("p");
        replacementBlock.textContent = "Independent block child.";
        const removed = Array.from(host.childNodes);
        host.replaceChildren(replacementText, replacementStrong, replacementBlock);
        runtime.candidates = [{
            element: host,
            nodes: [replacementText, replacementStrong],
            kind: "content",
            reason: "generic-inline-run",
        }];
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "childList",
            target: host,
            addedNodes: [replacementText, replacementStrong, replacementBlock] as unknown as NodeList,
            removedNodes: removed as unknown as NodeList,
        } as unknown as MutationRecord]);

        expect(host.querySelector('[data-fr-translation-segment="true"]')).toBe(segment);
        expect(getTranslationState(segment)).toBe(state);
        expect(state.controller.signal.aborted).toBe(false);
        expect(state.sourceTextNodes).toEqual([
            replacementText,
            replacementStrong.firstChild,
        ]);
        expect(state.syntheticSourceNodes).toEqual([replacementText, replacementStrong]);
        expect(segment.querySelector(".fluent-read-bilingual-content")).toBe(wrapper);
        expect(segment.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(50);
        await finishScheduledWork();
        expect(getTranslationState(segment)).toBe(state);
        expect(segment.querySelector(".fluent-read-bilingual-content")).toBe(wrapper);
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it("ancestor 分拆 remove/add 整组件 source-only clone 时原子迁移 synthetic 译文且不二次请求", async () => {
        const inlinePrefix = "Readable inline prefix ";
        const emphasized = "with emphasized prose.";
        document.body.innerHTML = `
            <section id="boundary">
                <article id="component">
                    <div id="mixed">${inlinePrefix}<strong>${emphasized}</strong>
                        <p>Independent block child.</p>
                    </div>
                </article>
            </section>
        `;
        const boundary = document.querySelector<HTMLElement>("#boundary")!;
        const component = document.querySelector<HTMLElement>("#component")!;
        const host = document.querySelector<HTMLElement>("#mixed")!;
        const sourceText = host.firstChild as Text;
        const sourceStrong = host.querySelector<HTMLElement>("strong")!;
        setLayoutBox(host, 640, 120);
        runtime.candidates = [{
            element: host,
            nodes: [sourceText, sourceStrong],
            kind: "content",
            reason: "generic-inline-run",
        }];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        TestIntersectionObserver.instances[0]!.emit(host, true);
        await finishScheduledWork();

        const segment = host.querySelector<HTMLElement>('[data-fr-translation-segment="true"]')!;
        const state = getTranslationState(segment)!;
        const wrapper = segment.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        const replacementComponent = document.createElement("article");
        replacementComponent.id = "component";
        replacementComponent.innerHTML = `
            <div id="mixed">${inlinePrefix}<strong>${emphasized}</strong>
                <p>Independent block child.</p>
            </div>
        `;
        const replacementHost = replacementComponent.querySelector<HTMLElement>("#mixed")!;
        const replacementText = replacementHost.firstChild as Text;
        const replacementStrong = replacementHost.querySelector<HTMLElement>("strong")!;
        setLayoutBox(replacementHost, 640, 120);
        component.remove();
        boundary.appendChild(replacementComponent);
        runtime.candidates = [{
            element: replacementHost,
            nodes: [replacementText, replacementStrong],
            kind: "content",
            reason: "generic-inline-run",
        }];
        TestMutationObserver.instances.at(-1)!.emit([
            {
                type: "childList",
                target: boundary,
                addedNodes: [] as unknown as NodeList,
                removedNodes: [component] as unknown as NodeList,
            } as unknown as MutationRecord,
            {
                type: "childList",
                target: boundary,
                addedNodes: [replacementComponent] as unknown as NodeList,
                removedNodes: [] as unknown as NodeList,
            } as unknown as MutationRecord,
        ]);

        expect(replacementHost.querySelector('[data-fr-translation-segment="true"]')).toBe(segment);
        expect(getTranslationState(segment)).toBe(state);
        expect(state.controller.signal.aborted).toBe(false);
        expect(segment.querySelector(".fluent-read-bilingual-content")).toBe(wrapper);
        expect(wrapper.isConnected).toBe(true);
        expect(wrapper.textContent).toContain(`译:${inlinePrefix.trim()}`);
        expect(wrapper.textContent).toContain(`译:${emphasized}`);
        expect(runtime.requests).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(50);
        await finishScheduledWork();
        expect(getTranslationState(segment)).toBe(state);
        expect(replacementHost.querySelector(".fluent-read-bilingual-content")).toBe(wrapper);
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["href", "/after", "Readable linked source."],
        ["source", "/before", "Changed linked source."],
    ] as const)("candidate host replaceChildren 改变 %s 时不收养旧 synthetic 译文", async (_kind, href, text) => {
        document.body.innerHTML = `
            <div id="mixed"><a href="/before">Readable linked source.</a><p>Independent block.</p></div>
        `;
        const host = document.querySelector<HTMLElement>("#mixed")!;
        const firstLink = host.querySelector<HTMLAnchorElement>("a")!;
        setLayoutBox(host, 640, 120);
        runtime.candidates = [{
            element: host,
            nodes: [firstLink],
            kind: "content",
            reason: "generic-inline-run",
        }];

        autoTranslateEnglishPage();
        await vi.advanceTimersByTimeAsync(50);
        TestIntersectionObserver.instances[0]!.emit(host, true);
        await finishScheduledWork();

        const segment = host.querySelector<HTMLElement>('[data-fr-translation-segment="true"]')!;
        const state = getTranslationState(segment)!;
        const wrapper = segment.querySelector<HTMLElement>(".fluent-read-bilingual-content")!;
        const replacementLink = document.createElement("a");
        replacementLink.setAttribute("href", href);
        replacementLink.textContent = text;
        const replacementBlock = document.createElement("p");
        replacementBlock.textContent = "Independent block.";
        const removed = Array.from(host.childNodes);
        host.replaceChildren(replacementLink, replacementBlock);
        runtime.candidates = [{
            element: host,
            nodes: [replacementLink],
            kind: "content",
            reason: "generic-inline-run",
        }];
        TestMutationObserver.instances.at(-1)!.emit([{
            type: "childList",
            target: host,
            addedNodes: [replacementLink, replacementBlock] as unknown as NodeList,
            removedNodes: removed as unknown as NodeList,
        } as unknown as MutationRecord]);

        expect(getTranslationState(segment)).toBeUndefined();
        expect(state.controller.signal.aborted).toBe(true);
        expect(segment.isConnected).toBe(false);
        expect(wrapper.isConnected).toBe(false);
        expect(host.querySelector('[data-fr-translation-segment="true"]')).toBeNull();
        expect(host.querySelector(".fluent-read-bilingual-content")).toBeNull();
        expect(replacementLink.getAttribute("href")).toBe(href);
        expect(replacementLink.textContent).toBe(text);
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it('控件同一 Text 节点的分槽语义改变时，迟到结果不能按相同拼接原文写回', async () => {
        document.body.innerHTML = '<button id="control"><span>Hello world</span><span> again</span></button>';
        const owner = document.querySelector<HTMLElement>('#control')!;
        const first = owner.children[0]!.firstChild as Text;
        const second = owner.children[1]!.firstChild as Text;
        runtime.candidates = [{element: owner, kind: 'control', reason: 'split-label'}];
        const request = deferred<string[]>();
        runtime.requests.mockReturnValueOnce(request.promise);
        handleBilingualTranslation(owner, false);
        await waitForRequestCount(1);
        const state = getTranslationState(owner)!;
        expect(state.sourceText).toBe('Hello world again');

        first.data = 'Hello';
        second.data = ' world again';
        expect(owner.textContent).toBe('Hello world again');
        request.resolve(['你好世界', '再次']);
        await finishScheduledWork();

        expect(getTranslationState(owner)).toBeUndefined();
        expect(state.controller.signal.aborted).toBe(true);
        expect(first.data).toBe('Hello');
        expect(second.data).toBe(' world again');
        expect(owner.querySelectorAll('[data-fr-translation-owned="true"]')).toHaveLength(0);
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])(
        '控件请求在途时同源 Text 重挂后，恢复使用实际提交节点且保留宿主后续写入=%s',
        async (hostEditsAfterCommit) => {
            document.body.innerHTML = '<button id="control"><span id="label">Save changes</span></button>';
            const owner = document.querySelector<HTMLElement>('#control')!;
            const label = document.querySelector<HTMLElement>('#label')!;
            const original = label.firstChild as Text;
            runtime.candidates = [{element: owner, kind: 'control', reason: 'control-label'}];
            const request = deferred<string[]>();
            runtime.requests.mockReturnValueOnce(request.promise);

            handleBilingualTranslation(owner, false);
            await waitForRequestCount(1);
            const state = getTranslationState(owner)!;
            const replacement = document.createTextNode('Save changes');
            label.replaceChildren(replacement);
            request.resolve(['保存更改']);
            await finishScheduledWork();

            expect(getTranslationState(owner)).toBe(state);
            expect(replacement.data).toBe('保存更改');
            expect(state.translatedTextValues?.get(replacement)).toBe('保存更改');
            expect(state.originalTextValues).toEqual([{node: replacement, value: 'Save changes'}]);
            if (hostEditsAfterCommit) replacement.data = 'Changes saved by host';
            restoreOriginalContent();
            expect(label.firstChild).toBe(replacement);
            expect(replacement.data).toBe(hostEditsAfterCommit ? 'Changes saved by host' : 'Save changes');
            expect(original.isConnected).toBe(false);
            expect(owner.querySelectorAll('[data-fr-translation-owned="true"]')).toHaveLength(0);
            expect(runtime.requests).toHaveBeenCalledTimes(1);
        },
    );

    it.each(['content', 'control'] as const)(
        '宿主悬停反复写入同值 title/lang 时 %s 译文不会被恢复或重挂',
        async (kind) => {
            runtime.config.display = 0;
            document.body.innerHTML = '<p id="stable" title="Reading help" lang="en">Stable translated source.</p>';
            const owner = document.querySelector<HTMLElement>('#stable')!;
            setLayoutBox(owner, 600, 90);
            runtime.candidates = [{element: owner, kind, reason: 'stable-attribute-owner'}];
            autoTranslateEnglishPage();
            await vi.advanceTimersByTimeAsync(50);
            TestIntersectionObserver.instances[0]!.emit(owner, true);
            await finishScheduledWork();

            const state = getTranslationState(owner)!;
            const originalTranslatedHTML = owner.innerHTML;
            const slot = owner.querySelector('.fluent-read-single-slot');
            expect(state.phase).toBe('translated');
            for (let frame = 0; frame < 8; frame += 1) {
                const records = ['title', 'lang'].map((attributeName) => {
                    const oldValue = owner.getAttribute(attributeName);
                    owner.setAttribute(attributeName, oldValue!);
                    return {type: 'attributes', target: owner, attributeName, oldValue,
                        addedNodes: [], removedNodes: []} as unknown as MutationRecord;
                });
                TestMutationObserver.instances[0]!.emit(records);
                // 在 observer 回调后立即断言，不能让缓存命中后的下一帧重挂掩盖闪回。
                expect(getTranslationState(owner)).toBe(state);
                expect(owner.innerHTML).toBe(originalTranslatedHTML);
                await vi.advanceTimersByTimeAsync(16);
            }
            await finishScheduledWork();
            expect(state.controller.signal.aborted).toBe(false);
            expect(owner.querySelector('.fluent-read-single-slot')).toBe(slot);
            expect(runtime.requests).toHaveBeenCalledTimes(1);
        },
    );

    it.each(['direct', 'nested'] as const)(
        '仅译文 %s 来源在同一 owner 内克隆重建时保留当前原文和宿主随后编辑',
        async (layout) => {
            runtime.config.display = 0;
            runtime.config.fullPageTranslationMode = 'all';
            let source = 'Preserve this source across an equivalent innerHTML rewrite.';
            document.body.innerHTML = layout === 'direct'
                ? `<p id="owner">${source}</p>`
                : `<p id="owner"><strong><em>${source}</em></strong></p>`;
            const owner = document.querySelector<HTMLElement>('#owner')!;
            setLayoutBox(owner, 600, 90);
            runtime.candidates = [{element: owner, kind: 'content', reason: 'same-owner-single-rewrite'}];
            autoTranslateEnglishPage();
            await finishScheduledWork();

            for (let rewrite = 0; rewrite < 2; rewrite += 1) {
                const removed = Array.from(owner.childNodes);
                owner.innerHTML = owner.innerHTML;
                const added = Array.from(owner.childNodes);
                const clonedSlot = owner.querySelector('.fluent-read-single-slot')!;
                const clonedSource = clonedSlot.firstChild as Text;
                expect(clonedSlot.shadowRoot).toBeNull();
                if (rewrite === 1) {
                    source = 'The host has replaced this source with a fresh value.';
                    clonedSource.data = source;
                }
                TestMutationObserver.instances[0]!.emit([{
                    type: 'childList', target: owner, addedNodes: added, removedNodes: removed,
                } as unknown as MutationRecord]);
                // 直接在回调后断言，不能用下一轮 discovery/cache 重渲染掩盖原文丢失。
                expect(owner.textContent).toBe(source);
                expect(owner.contains(clonedSource)).toBe(true);
                await finishScheduledWork();
                expect(owner.textContent).toBe(source);
                expect(singleTranslationText(owner)).toBe(`译:${source}`);
                expect(owner.querySelectorAll('.fluent-read-single-slot')).toHaveLength(1);
            }
            restoreOriginalContent();
            expect(owner.textContent).toBe(source);
            expect(owner.querySelector('.fluent-read-single-slot')).toBeNull();
            expect(runtime.requests).toHaveBeenCalledTimes(2);
        },
    );

    it('同一 owner 单译文槽克隆后立即恢复，先解包新槽而不等待 mutation discovery', async () => {
        runtime.config.display = 0;
        runtime.config.fullPageTranslationMode = 'all';
        const source = 'Restore this original before any mutation callback.';
        document.body.innerHTML = `<p id="owner">${source}</p>`;
        const owner = document.querySelector<HTMLElement>('#owner')!;
        setLayoutBox(owner, 600, 90);
        runtime.candidates = [{element: owner, kind: 'content', reason: 'restore-cloned-single'}];
        autoTranslateEnglishPage();
        await finishScheduledWork();
        owner.innerHTML = owner.innerHTML;
        const clonedSource = owner.querySelector('.fluent-read-single-slot')!.firstChild!;

        restoreOriginalContent();
        expect(owner.firstChild).toBe(clonedSource);
        expect(owner.textContent).toBe(source);
        expect(owner.querySelector('[data-fr-translation-owned="true"]')).toBeNull();
        expect(runtime.requests).toHaveBeenCalledTimes(1);
    });

    it.each(['class', 'hidden'] as const)(
        '仅译文已提交后，后代原文通过 %s 进入保护区会撤下对应译文槽',
        async (attributeName) => {
            runtime.config.display = 0;
            runtime.config.fullPageTranslationMode = 'all';
            document.body.innerHTML = '<p id="owner">Readable source <span id="protected">formerly readable suffix.</span></p>';
            const owner = document.querySelector<HTMLElement>('#owner')!;
            const descendant = document.querySelector<HTMLElement>('#protected')!;
            setLayoutBox(owner, 600, 90);
            runtime.candidates = [{element: owner, kind: 'content', reason: 'single-descendant-protection'}];
            autoTranslateEnglishPage();
            await finishScheduledWork();
            const state = getTranslationState(owner)!;
            const protectedSlot = descendant.querySelector('.fluent-read-single-slot')!;
            expect(state.phase).toBe('translated');
            expect(protectedSlot).not.toBeNull();

            descendant.setAttribute(attributeName, attributeName === 'class' ? 'notranslate' : '');
            TestMutationObserver.instances[0]!.emit([{
                type: 'attributes', target: descendant, attributeName, oldValue: null,
                addedNodes: [], removedNodes: [],
            } as unknown as MutationRecord]);
            await finishScheduledWork();

            expect(state.controller.signal.aborted).toBe(true);
            expect(protectedSlot.isConnected).toBe(false);
            expect(descendant.querySelector('.fluent-read-single-slot')).toBeNull();
            expect(descendant.textContent).toBe('formerly readable suffix.');
            expect(singleTranslationText(owner)).toBe('译:Readable source ');
            expect(runtime.requests).toHaveBeenCalledTimes(1);
        },
    );

    it.each(['loading', 'translated', 'error'] as const)(
        '%s owner 样式未变时，后代 notranslate class 变化仍会更新翻译来源',
        async (phase) => {
            runtime.config.display = 1;
            document.body.innerHTML = '<p id="owner">Readable source <span id="protected">formerly readable suffix.</span></p>';
            const owner = document.querySelector<HTMLElement>('#owner')!;
            const descendant = document.querySelector<HTMLElement>('#protected')!;
            setLayoutBox(owner, 600, 90);
            runtime.candidates = [{element: owner, kind: 'content', reason: 'descendant-class-owner'}];
            const request = deferred<string[]>();
            if (phase === 'loading') runtime.requests.mockReturnValueOnce(request.promise);
            if (phase === 'error') runtime.requests.mockRejectedValueOnce(new Error('Temporarily unavailable'));
            autoTranslateEnglishPage();
            await vi.advanceTimersByTimeAsync(50);
            TestIntersectionObserver.instances[0]!.emit(owner, true);
            if (phase === 'loading') await waitForRequestCount(1);
            else await finishScheduledWork();
            const state = getTranslationState(owner)!;
            expect(state.phase).toBe(phase);

            descendant.className = 'notranslate';
            TestMutationObserver.instances[0]!.emit([{
                type: 'attributes', target: descendant, attributeName: 'class', oldValue: null,
                addedNodes: [], removedNodes: [],
            } as unknown as MutationRecord]);
            await vi.advanceTimersByTimeAsync(501);

            expect(state.controller.signal.aborted).toBe(true);
            expect(getTranslationState(owner)).not.toBe(state);
            if (phase === 'loading') {
                request.resolve(['译:Readable source ', '译:formerly readable suffix.']);
            }
            await finishScheduledWork();
            TestIntersectionObserver.instances[0]!.emit(owner, true);
            await finishScheduledWork();
            expect(descendant.textContent).toBe('formerly readable suffix.');
            expect(owner.querySelector('.fluent-read-bilingual-content')?.textContent)
                .toBe('译:Readable source ');
        },
    );

});
