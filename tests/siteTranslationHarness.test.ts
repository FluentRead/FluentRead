import {EventEmitter} from 'node:events';
import {mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';
import cases from './browser-translation-cases.json';
import establishedFixtures from '../scripts/site-translation/site-adaptation-established-fixtures.json';

const require = createRequire(import.meta.url);
const {inspectFixtureTranslationParts} = require('../scripts/site-translation/fixture-translation-parts.cjs');
const {
  COVERAGE_EXCLUDED_ANCESTORS,
  COVERAGE_PROTECTED_DESCENDANTS,
  COVERAGE_TRACKER_KEY,
  assertPageContract,
  assertFreshProductionExtension,
  assertCoverageReport,
  assertCoverageRestoration,
  capturePageContract,
  evaluateProductionBuildFreshness,
  installCoverageTracker,
  isNaturalLanguageText,
  normalizeCoverageRules,
  normalizeHoverTargets,
  normalizeInteractionScenarios,
  reconcileForbiddenContractState,
  findHoverTextPointInPage,
  toggleHover,
  resolveHoverTarget,
  resolveForbiddenMustExistSelectors,
  closeInteractionDialog,
  settleCoverageByReveal,
  validateCoverageRevealStatuses,
  validateCoverageRules,
  validateMutableForbiddenSelectors,
  waitForCoverageReady,
  waitForHostMathRendering,
  waitForStableTarget,
  withMandatoryHeadingCoverage,
} = {
  ...require('../scripts/run-site-translation-test.cjs'),
  ...require('../scripts/site-translation/case-config.cjs'),
} as {
  COVERAGE_EXCLUDED_ANCESTORS: string;
  COVERAGE_PROTECTED_DESCENDANTS: string;
  COVERAGE_TRACKER_KEY: string;
  assertFreshProductionExtension: (extensionDir: string, projectRoot: string) => unknown;
  waitForHostMathRendering: (page: unknown, timeout: number) => Promise<unknown>;
  waitForStableTarget: (page: unknown, selector: string, timeout: number) => Promise<void>;
  findHoverTextPointInPage: (target: {selector: string; index: number}) => {x: number; y: number; text: string} | null;
  toggleHover: (page: unknown, target: unknown, config: {selector: string; index: number}, count: number, timeout: number) => Promise<void>;
  assertPageContract: (
    page: {
      evaluate: (fn: (argument: unknown) => unknown, argument: unknown) => Promise<unknown>;
      url: () => string;
    },
    baseline: Record<string, unknown>,
    requiredSelectors: string[],
    expectedUrl: string,
    phase: string,
  ) => Promise<unknown>;
  assertCoverageReport: (rules: unknown[], report: unknown[], phase: string) => unknown;
  assertCoverageRestoration: (report: unknown[], phase: string) => unknown;
  capturePageContract: (
    page: {evaluate: (fn: (argument: unknown) => unknown, argument: unknown) => Promise<unknown>},
    requiredSelectors: string[],
    forbiddenSelectors: string[],
    interactionSelectors: string[],
    dynamicForbiddenSelectors: string[],
    optionalForbiddenSelectors: string[],
    mutableForbiddenSelectors?: string[],
  ) => Promise<{
    requiredState: Array<Record<string, unknown>>;
    forbiddenState: Array<Record<string, unknown> & {signatures: unknown[]}>;
    interactionState: Array<Record<string, unknown>>;
  }>;
  evaluateProductionBuildFreshness: (input: {
    extensionDir: string;
    manifestMtimeMs: number;
    latestSource: {path: string; mtimeMs: number} | null;
  }) => {ok: boolean; production: boolean};
  installCoverageTracker: (page: {
    evaluate: (fn: (argument: unknown) => unknown, argument: unknown) => Promise<unknown>;
  }, rules: unknown[]) => Promise<void>;
  isNaturalLanguageText: (value: unknown) => boolean;
  normalizeCoverageRules: (rules: unknown[]) => Array<{
    name: string;
    selector: string;
    kind: string;
    minInitial: number;
    minSeen: number;
    trackDynamic: boolean;
    requiresPhrase?: boolean;
    sourceIncludes: string[];
  }>;
  normalizeHoverTargets: (targets: unknown[], options?: string | {
    fallbackSelector?: string;
    coverageRules?: Array<{name: string; selector: string; sourceIncludes: string[]}>;
  }) => Array<{
    name: string;
    selector: string;
    index: number;
    sourceIncludes: string[];
  }>;
  normalizeInteractionScenarios: (scenarios: unknown[]) => Array<{
    name: string;
    triggerSelector: string;
    openKey: string;
    dialogSelector: string;
    comboboxSelector: string;
    listboxSelector: string;
    inputText: string;
    closeKey: string;
    closeAttempts: number;
  }>;
  reconcileForbiddenContractState: (
    initial: Record<string, unknown>,
    current: Record<string, unknown>,
  ) => string | null;
  resolveHoverTarget: (
    page: {
      evaluate: (fn: (argument: unknown) => unknown, argument: unknown) => Promise<unknown>;
      waitForFunction: (
        fn: (argument: unknown) => unknown,
        argument: unknown,
        options: {timeout: number},
      ) => Promise<unknown>;
    },
    target: {name: string; selector: string; index: number; sourceIncludes: string[]},
    timeout: number,
  ) => Promise<{rawIndex: number; sourceText: string}>;
  resolveForbiddenMustExistSelectors: (
    tier: string,
    forbidden: string[],
    configured?: string[],
    optional?: string[],
  ) => string[];
  closeInteractionDialog: (
    page: {
      keyboard: {press: (key: string) => Promise<void>};
      waitForSelector: (selector: string, options: {state: string; timeout: number}) => Promise<unknown>;
    },
    scenario: {name: string; dialogSelector: string; closeKey: string; closeAttempts: number},
    timeout: number,
    phase: string,
  ) => Promise<number>;
  settleCoverageByReveal: (
    page: {evaluate: (fn: (argument: unknown) => unknown, argument: unknown) => Promise<unknown>},
    timeout: number,
    phase: string,
  ) => Promise<unknown[]>;
  validateCoverageRevealStatuses: (statuses: Array<{
    token: string;
    rule: string;
    source: string;
    connected: boolean;
    eligible: boolean;
    translated: boolean;
    loading: boolean;
    retry: boolean;
    reason?: string;
  }>, phase: string) => void;
  validateCoverageRules: (
    caseName: string,
    rules: unknown[],
    options?: {requireExplicit?: boolean; explicitRules?: unknown[]},
  ) => string[];
  validateMutableForbiddenSelectors: (
    caseName: string,
    forbiddenSelectors: string[],
    dynamicForbiddenSelectors: string[],
    mutableForbiddenSelectors: string[],
  ) => void;
  waitForCoverageReady: (
    page: {
      evaluate: (fn: (argument: unknown) => unknown, argument: unknown) => Promise<unknown>;
      waitForFunction: (
        fn: (argument: unknown) => unknown,
        argument: unknown,
        options: {timeout: number},
      ) => Promise<unknown>;
    },
    rules: unknown[],
    timeout: number,
  ) => Promise<void>;
  withMandatoryHeadingCoverage: (rules: unknown[]) => Array<{
    name: string;
    selector: string;
    kind: string;
    minInitial: number;
    minSeen: number;
    trackDynamic: boolean;
    requiresPhrase?: boolean;
  }>;
};
const {
  MATRIX_REQUIREMENTS,
  computeJobTimeoutMs,
  runChildWithWatchdog,
  validateMatrix,
} = require('../scripts/run-site-translation-matrix.cjs') as {
  MATRIX_REQUIREMENTS: {
    total: number;
    required: number;
    requiredHosts: number;
    quarantine: number;
  };
  computeJobTimeoutMs: (pageTimeout: number, mode: string, override?: number) => number;
  runChildWithWatchdog: (
    command: string,
    values: string[],
    options: {
      timeoutMs: number;
      killGraceMs?: number;
      stdio?: string;
      spawnImpl?: (command: string, values: string[], options: unknown) => EventEmitter & {pid?: number};
      killProcessGroupImpl?: (child: EventEmitter & {pid?: number}, signal: string) => boolean;
    },
  ) => Promise<{ok: boolean; timedOut: boolean; signal: string | null}>;
  validateMatrix: (caseConfigs?: Record<string, unknown>) => {
    entries: Array<[string, unknown]>;
    required: Array<[string, unknown]>;
    quarantine: Array<[string, unknown]>;
    requiredHosts: Set<string>;
  };
};

describe('site translation coverage contract', () => {
  it('rejects selector unions that can pass after translating only one semantic region', () => {
    const rules = normalizeCoverageRules([{
      name: 'title-or-body',
      selector: 'main h1, .markdown-body p',
      kind: 'content',
      minInitial: 1,
    }]);

    expect(validateCoverageRules('union-case', rules)).toContain(
      'union-case.coverageRules[0] selector 不得包含逗号，请拆成独立覆盖规则',
    );
  });

  it('fails when one translated node hides untranslated siblings', () => {
    const rules = normalizeCoverageRules([{
      name: 'paragraphs',
      selector: '.markdown-body p',
      kind: 'content',
      minInitial: 4,
    }]);
    const report = [{
      name: 'paragraphs',
      seenCount: 4,
      translatedCount: 1,
      sourceSamples: ['one', 'two', 'three', 'four'],
      missedSamples: ['two', 'three', 'four'],
    }];

    expect(() => assertCoverageReport(rules, report, 'test')).toThrow('仅翻译 1/4 个节点');
  });

  it('fails when body content translates but the H1 is missed', () => {
    const rules = normalizeCoverageRules([
      {name: 'title', selector: 'main h1', kind: 'heading', minInitial: 1},
      {name: 'body', selector: '.markdown-body p', kind: 'content', minInitial: 2},
    ]);
    const report = [
      {name: 'title', seenCount: 1, translatedCount: 0, sourceSamples: ['Title'], missedSamples: ['Title']},
      {name: 'body', seenCount: 2, translatedCount: 2, sourceSamples: ['A', 'B'], missedSamples: []},
    ];

    expect(() => assertCoverageReport(rules, report, 'test')).toThrow('title 仅翻译 0/1 个节点');
  });

  it('adds a mandatory dynamic H1 invariant even when a site forgets to declare one', () => {
    const runtimeRules = withMandatoryHeadingCoverage(normalizeCoverageRules([{
      name: 'body',
      selector: 'main p',
      kind: 'content',
      minInitial: 1,
    }]));
    const mandatory = runtimeRules.find(({name}) => name === 'mandatory-visible-latin-h1');

    expect(mandatory).toMatchObject({
      selector: 'h1',
      kind: 'heading',
      minInitial: 0,
      minSeen: 0,
      trackDynamic: true,
      requiresPhrase: true,
    });
    expect(() => assertCoverageReport(runtimeRules, [
      {name: 'body', seenCount: 1, translatedCount: 1, sourceSamples: ['Body'], missedSamples: []},
      {
        name: 'mandatory-visible-latin-h1',
        seenCount: 1,
        translatedCount: 0,
        sourceSamples: ['Forgotten title'],
        missedSamples: ['Forgotten title'],
      },
    ], 'global heading')).toThrow('mandatory-visible-latin-h1 仅翻译 0/1 个节点');
  });

  it('does not count screen-reader-only headings as visible page headings', () => {
    expect(COVERAGE_EXCLUDED_ANCESTORS).toContain('.sr-only');
    expect(COVERAGE_EXCLUDED_ANCESTORS).toContain('.visually-hidden');
    expect(COVERAGE_EXCLUDED_ANCESTORS).toContain('.MathJax_Display');
    expect(COVERAGE_EXCLUDED_ANCESTORS).toContain('mjx-container');
    expect(COVERAGE_EXCLUDED_ANCESTORS).toContain('.katex');
    expect(COVERAGE_PROTECTED_DESCENDANTS).toContain('script');
    expect(COVERAGE_PROTECTED_DESCENDANTS).toContain('.MathJax_Display');
    expect(COVERAGE_PROTECTED_DESCENDANTS).toContain('mjx-container');
    expect(COVERAGE_PROTECTED_DESCENDANTS).toContain('.katex');
  });

  it('rejects code-shaped and technical identifiers without rejecting natural prose or headings', () => {
    expect(isNaturalLanguageText('#!/bin/sh')).toBe(false);
    expect(isNaturalLanguageText('#lang plai-typed')).toBe(false);
    expect(isNaturalLanguageText('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">')).toBe(false);
    expect(isNaturalLanguageText('select-stmt: hide')).toBe(false);
    expect(isNaturalLanguageText('select-stmt: 藏起来')).toBe(false);
    expect(isNaturalLanguageText('HTTPS')).toBe(false);
    expect(isNaturalLanguageText('Referer')).toBe(false);
    expect(isNaturalLanguageText('Introduction')).toBe(true);
    expect(isNaturalLanguageText('WHY')).toBe(true);
    expect(isNaturalLanguageText('The SELECT statement is used to query the database.')).toBe(true);
  });

  it('uses the same natural-language eligibility for readiness, tracking, and hover resolution', async () => {
    const {document, window} = parseHTML(`
      <html><body><main>
        <p>#!/bin/sh</p>
        <p>HTTPS</p>
        <p>The natural paragraph remains an eligible translation target.</p>
      </main></body></html>
    `);
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40}),
    });
    const globals = {
      window,
      document,
      Node: window.Node,
      HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement,
      MutationObserver: window.MutationObserver,
      getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    };
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }
    const page = {
      evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument),
      waitForFunction: async (
        fn: (argument: unknown) => unknown,
        argument: unknown,
        _options: {timeout: number},
      ) => {
        if (!fn(argument)) throw new Error('predicate did not become true');
      },
    };
    try {
      const rules = normalizeCoverageRules([{
        name: 'paragraphs',
        selector: 'main p',
        kind: 'content',
        minInitial: 1,
        sourceIncludes: ['The natural paragraph remains'],
      }]);
      await expect(waitForCoverageReady(page, rules, 100)).resolves.toBeUndefined();
      await installCoverageTracker(page, rules);
      const tracker = (window as unknown as Record<string, {
        report: () => Array<{name: string; seenCount: number; sourceSamples: string[]}>;
        stop: () => void;
      }>)[COVERAGE_TRACKER_KEY];
      expect(tracker.report()).toContainEqual(expect.objectContaining({
        name: 'paragraphs',
        seenCount: 1,
        sourceSamples: ['The natural paragraph remains an eligible translation target.'],
      }));
      await expect(resolveHoverTarget(page, {
        name: 'paragraph',
        selector: 'main p',
        index: 0,
        sourceIncludes: [],
      }, 100)).resolves.toMatchObject({
        rawIndex: 2,
        sourceText: 'The natural paragraph remains an eligible translation target.',
      });
      tracker.stop();
    } finally {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it('reveals each connected missing coverage leaf once and skips a disconnected dynamic record', async () => {
    const {document, window} = parseHTML(`
      <html><body><main>
        <p id="translated">The first natural paragraph already has a translation.</p>
        <p id="missing">The second natural paragraph must receive one visibility opportunity.</p>
        <p id="detached">A virtualized paragraph can leave before the convergence snapshot.</p>
      </main></body></html>
    `);
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40}),
    });
    const revealed: string[] = [];
    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: HTMLElement) {
        revealed.push(this.id);
      },
    });
    const globals = {
      window,
      document,
      Node: window.Node,
      HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement,
      MutationObserver: window.MutationObserver,
      getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    };
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }

    try {
      const translated = document.querySelector('#translated')!;
      const existingWrapper = document.createElement('span');
      existingWrapper.className = 'fluent-read-bilingual-content';
      existingWrapper.setAttribute('data-fr-translation-owned', 'true');
      existingWrapper.textContent = '已有译文';
      translated.append(existingWrapper);

      const page = {evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument)};
      const rules = normalizeCoverageRules([{
        name: 'dynamic-paragraphs',
        selector: 'main p',
        kind: 'content',
        minInitial: 3,
        trackDynamic: true,
      }]);
      await installCoverageTracker(page, rules);
      const tracker = (window as unknown as Record<string, {
        snapshotMissing: () => Array<{token: string; source: string}>;
        activateMissing: (token: string) => {found: boolean; reason?: string};
        missingStatuses: (tokens: string[]) => Array<{translated: boolean}>;
        stop: () => void;
      }>)[COVERAGE_TRACKER_KEY];

      document.querySelector('#detached')!.remove();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const batch = tracker.snapshotMissing();
      expect(batch).toHaveLength(1);
      expect(batch[0]?.source).toContain('second natural paragraph');

      const token = batch[0]!.token;
      expect(tracker.activateMissing(token)).toMatchObject({found: true});
      expect(revealed).toEqual(['missing']);
      expect(tracker.activateMissing(token)).toMatchObject({found: false, reason: 'already-activated'});

      const missing = document.querySelector('#missing')!;
      const wrapper = document.createElement('span');
      wrapper.className = 'fluent-read-bilingual-content';
      wrapper.setAttribute('data-fr-translation-owned', 'true');
      wrapper.textContent = '新的译文';
      missing.append(wrapper);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(tracker.snapshotMissing()).toEqual([]);
      expect(tracker.missingStatuses([token])).toEqual([
        expect.objectContaining({translated: true}),
      ]);
      missing.remove();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(tracker.missingStatuses([token])).toEqual([
        expect.objectContaining({connected: false, translated: true}),
      ]);
      tracker.stop();
    } finally {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it('keeps terminal retry, disconnect and untranslated outcomes strict after a reveal pass', () => {
    const base = {
      token: '0:1:0',
      rule: 'paragraphs',
      source: 'Natural prose remains untranslated.',
      connected: true,
      eligible: true,
      translated: false,
      loading: false,
      retry: false,
    };
    expect(() => validateCoverageRevealStatuses([{...base, retry: true}], 'coverage'))
      .toThrow(/terminal-retry/u);
    expect(() => validateCoverageRevealStatuses([{...base, connected: false}], 'coverage'))
      .toThrow(/disconnected|missing-wrapper/u);
    expect(() => validateCoverageRevealStatuses([{...base, translated: true}], 'coverage'))
      .not.toThrow();
  });

  it('does not let an old wrapper certify a new dynamic source generation', async () => {
    const {document, window} = parseHTML(`
      <html><body><main><p id="target">The original natural paragraph is translated.</p></main></body></html>
    `);
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40}),
    });
    let observer: {
      emit: (records: MutationRecord[]) => void;
      disconnect: () => void;
    } | undefined;
    class ControlledMutationObserver {
      constructor(private readonly callback: MutationCallback) {
        observer = this;
      }

      observe() {}
      disconnect() {}
      emit(records: MutationRecord[]) {
        this.callback(records, this as unknown as MutationObserver);
      }
    }
    const globals = {
      window,
      document,
      Node: window.Node,
      HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement,
      MutationObserver: ControlledMutationObserver,
      getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    };
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }

    try {
      const target = document.querySelector('#target')!;
      const oldWrapper = document.createElement('span');
      oldWrapper.className = 'fluent-read-bilingual-content';
      oldWrapper.setAttribute('data-fr-translation-owned', 'true');
      oldWrapper.textContent = '旧译文';
      target.append(oldWrapper);
      const page = {evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument)};
      const rules = normalizeCoverageRules([{
        name: 'dynamic-source',
        selector: 'main p',
        kind: 'content',
        minInitial: 1,
        trackDynamic: true,
      }]);
      await installCoverageTracker(page, rules);
      const tracker = (window as unknown as Record<string, {
        report: () => Array<{
          seenCount: number;
          dynamicSeenCount: number;
          translatedCount: number;
          missedSamples: string[];
        }>;
        snapshotMissing: () => Array<{source: string}>;
        stop: () => void;
      }>)[COVERAGE_TRACKER_KEY];
      expect(tracker.report()[0]).toMatchObject({seenCount: 1, dynamicSeenCount: 0, translatedCount: 1});

      const sourceNode = target.firstChild!;
      sourceNode.nodeValue = 'The replacement natural paragraph requires a fresh translation.';
      observer!.emit([{
        type: 'characterData',
        target: sourceNode,
        addedNodes: [] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord]);
      expect(tracker.report()[0]).toMatchObject({seenCount: 1, dynamicSeenCount: 1, translatedCount: 0});
      expect(tracker.snapshotMissing()).toEqual([
        expect.objectContaining({source: 'The replacement natural paragraph requires a fresh translation.'}),
      ]);

      oldWrapper.remove();
      const newWrapper = document.createElement('span');
      newWrapper.className = 'fluent-read-bilingual-content';
      newWrapper.setAttribute('data-fr-translation-owned', 'true');
      newWrapper.textContent = '新译文';
      target.append(newWrapper);
      observer!.emit([{
        type: 'childList',
        target,
        addedNodes: [newWrapper] as unknown as NodeList,
        removedNodes: [oldWrapper] as unknown as NodeList,
      } as unknown as MutationRecord]);
      expect(tracker.report()[0]).toMatchObject({
        seenCount: 1,
        dynamicSeenCount: 1,
        translatedCount: 1,
        missedSamples: [],
      });
      tracker.stop();
    } finally {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it('fails before an unbounded reveal loop when a page has too many missing leaves', async () => {
    const batch = Array.from({length: 129}, (_, index) => ({
      token: `0:${index}:0`,
      rule: 'paragraphs',
      source: `Natural paragraph ${index}`,
      connected: true,
      eligible: true,
      translated: false,
      loading: false,
      retry: false,
    }));
    const page = {
      evaluate: vi.fn(async () => batch),
    };
    await expect(settleCoverageByReveal(page, 60_000, 'coverage'))
      .rejects.toThrow(/有界唤醒上限/u);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it('normalizes only adjacent Text runs around protected MathJax roots', async () => {
    const {document, window} = parseHTML(`
      <html><body><main>
        <p id="math">Perspective prose appears before <span class="MathJax_Preview">x + y</span><script type="math/tex">x + y</script> and after the formula.</p>
        <p id="outer-structure">Outer prose <em>structure</em> must remain exactly as it started.<span class="MathJax_Preview">z</span><script type="math/tex">z</script></p>
        <p id="outer-text">Outer prose text must remain exactly as it started.</p>
      </main></body></html>
    `);
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40}),
    });
    let observer: {
      emit: (records: MutationRecord[]) => void;
      disconnect: () => void;
    } | undefined;
    class ControlledMutationObserver {
      constructor(private readonly callback: MutationCallback) {
        observer = this;
      }

      observe() {}
      disconnect() {}
      emit(records: MutationRecord[]) {
        this.callback(records, this as unknown as MutationObserver);
      }
    }
    const globals = {
      window,
      document,
      Node: window.Node,
      HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement,
      MutationObserver: ControlledMutationObserver,
      getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    };
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }

    try {
      const page = {evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument)};
      const rules = normalizeCoverageRules([{
        name: 'static-paragraphs',
        selector: 'main p',
        kind: 'content',
        minInitial: 3,
        trackDynamic: false,
      }]);
      await installCoverageTracker(page, rules);
      const tracker = (window as unknown as Record<string, {
        metrics: () => Record<string, number>;
        restorationReport: () => Array<{
          name: string;
          changedCount: number;
          changedSamples: Array<{source: string; current: string; initialStructure: string; currentStructure: string}>;
        }>;
        stop: () => void;
      }>)[COVERAGE_TRACKER_KEY];

      const math = document.querySelector('#math')!;
      const preview = math.querySelector('.MathJax_Preview')!;
      const oldScript = math.querySelector('script[type^="math/tex"]')!;
      preview.remove();
      oldScript.remove();
      // MathJax v2 在用最终 Display/script 对替换 Preview/script 根节点时，
      // 可能同时合并正文 Text 节点。
      math.normalize();
      const display = document.createElement('div');
      display.className = 'MathJax_Display';
      display.innerHTML = '<span class="MathJax">rendered formula</span>';
      const nextScript = document.createElement('script');
      nextScript.setAttribute('type', 'math/tex; mode=display');
      nextScript.textContent = 'x + y';
      math.append(display, nextScript);
      observer!.emit([{
        type: 'childList',
        target: math,
        addedNodes: [display, nextScript] as unknown as NodeList,
        removedNodes: [preview, oldScript] as unknown as NodeList,
      } as unknown as MutationRecord]);

      const afterMath = tracker.restorationReport()[0]!;
      expect(afterMath).toMatchObject({changedCount: 0});
      expect(tracker.metrics()).toMatchObject({
        ignoredProtectedMutationCount: 1,
        hostMutationCount: 0,
      });
      expect(() => assertCoverageRestoration([afterMath], 'MathJax restore')).not.toThrow();

      const outerStructure = document.querySelector('#outer-structure')!;
      const emphasized = outerStructure.querySelector('em')!;
      const strong = document.createElement('strong');
      strong.textContent = emphasized.textContent;
      emphasized.replaceWith(strong);
      const structurePreview = outerStructure.querySelector('.MathJax_Preview')!;
      const structureScript = outerStructure.querySelector('script[type^="math/tex"]')!;
      structurePreview.remove();
      structureScript.remove();
      outerStructure.normalize();
      const structureDisplay = document.createElement('div');
      structureDisplay.className = 'MathJax_Display';
      const nextStructureScript = document.createElement('script');
      nextStructureScript.setAttribute('type', 'math/tex; mode=display');
      nextStructureScript.textContent = 'z';
      outerStructure.append(structureDisplay, nextStructureScript);
      observer!.emit([{
        type: 'childList',
        target: outerStructure,
        addedNodes: [strong] as unknown as NodeList,
        removedNodes: [emphasized] as unknown as NodeList,
      } as unknown as MutationRecord, {
        type: 'childList',
        target: outerStructure,
        addedNodes: [structureDisplay, nextStructureScript] as unknown as NodeList,
        removedNodes: [structurePreview, structureScript] as unknown as NodeList,
      } as unknown as MutationRecord]);

      const outerText = document.querySelector('#outer-text')!;
      const outerTextNode = outerText.firstChild!;
      outerTextNode.nodeValue = 'Outer prose text changed outside every protected subtree.';
      observer!.emit([{
        type: 'characterData',
        target: outerTextNode,
        addedNodes: [] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord]);

      const strict = tracker.restorationReport()[0]!;
      expect(strict).toMatchObject({changedCount: 2});
      expect(strict.changedSamples).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'Outer prose structure must remain exactly as it started.',
          initialStructure: expect.stringContaining('"em"'),
          currentStructure: expect.stringContaining('"strong"'),
        }),
        expect.objectContaining({source: 'Outer prose text must remain exactly as it started.'}),
      ]));
      expect(tracker.metrics()).toMatchObject({
        ignoredProtectedMutationCount: 2,
        hostMutationCount: 2,
      });
      expect(() => assertCoverageRestoration([strict], 'outer prose restore'))
        .toThrow(/有 2 个节点未恢复/u);
      tracker.stop();
    } finally {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it('does not recompute large MathML topology for 150 extension artifact mutations', async () => {
    const {document, window} = parseHTML('<html><body><main></main></body></html>');
    const main = document.querySelector('main')!;
    for (let index = 0; index < 100; index += 1) {
      const paragraph = document.createElement('p');
      paragraph.append(`Natural language paragraph ${index} has enough words for coverage. `);
      const math = document.createElement('span');
      math.className = 'MathJax';
      for (let depth = 0; depth < 20; depth += 1) {
        const nested = document.createElement('span');
        nested.textContent = `formula-${index}-${depth}`;
        math.append(nested);
      }
      paragraph.append(math);
      main.append(paragraph);
    }

    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40}),
    });
    const style = () => ({display: 'block', visibility: 'visible'});
    const globals = {
      window,
      document,
      Node: window.Node,
      HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement,
      MutationObserver: window.MutationObserver,
      getComputedStyle: style,
    };
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }

    try {
      const page = {evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument)};
      const rules = normalizeCoverageRules([{
        name: 'large-math-paragraphs',
        selector: 'main p',
        kind: 'content',
        minInitial: 100,
        trackDynamic: true,
      }]);
      await installCoverageTracker(page, rules);
      const tracker = (window as unknown as Record<string, {
        metrics: () => Record<string, number>;
        report: () => Array<{name: string; seenCount: number; dynamicSeenCount: number}>;
        restorationReport: () => unknown;
        stop: () => void;
      }>)[COVERAGE_TRACKER_KEY];
      const initial = tracker.metrics();
      expect(initial.initialStructureSignatureCalls).toBe(100);
      expect(initial.structureSignatureCalls).toBe(100);

      const paragraphs = [...document.querySelectorAll('main p')];
      for (let index = 0; index < 150; index += 1) {
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '译文';
        paragraphs[index % paragraphs.length].append(wrapper);
        wrapper.remove();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));

      const afterArtifacts = tracker.metrics();
      expect(afterArtifacts.artifactMutationCount).toBeGreaterThanOrEqual(150);
      expect(afterArtifacts.dynamicStructureSignatureCalls).toBe(0);
      expect(afterArtifacts.structureSignatureCalls).toBe(100);

      const replacement = document.createElement('p');
      replacement.append('A newly rendered paragraph contains natural prose and an embedded formula. ');
      const replacementMath = document.createElement('span');
      replacementMath.className = 'MathJax';
      replacementMath.textContent = 'x + y';
      replacement.append(replacementMath);
      paragraphs[0].replaceWith(replacement);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const afterHostReplacement = tracker.metrics();
      expect(afterHostReplacement.dynamicStructureSignatureCalls).toBe(1);
      expect(tracker.report()).toContainEqual(expect.objectContaining({
        name: 'large-math-paragraphs',
        seenCount: 101,
        dynamicSeenCount: 1,
      }));

      tracker.restorationReport();
      const restored = tracker.metrics();
      expect(restored.restorationStructureSignatureCalls).toBe(100);
      expect(restored.structureSignatureCalls).toBe(201);
      tracker.stop();
    } finally {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it('tracks host prose mounted in the same childList record as an extension artifact', async () => {
    const {document, window} = parseHTML(`
      <html><body><main>
        <p id="initial">Initial natural language paragraph remains eligible.</p>
      </main></body></html>
    `);
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40}),
    });

    let observer: {
      emit: (records: MutationRecord[]) => void;
      disconnect: () => void;
    } | undefined;
    class ControlledMutationObserver {
      constructor(private readonly callback: MutationCallback) {
        observer = this;
      }

      observe() {}
      disconnect() {}
      emit(records: MutationRecord[]) {
        this.callback(records, this as unknown as MutationObserver);
      }
    }
    const globals = {
      window,
      document,
      Node: window.Node,
      HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement,
      MutationObserver: ControlledMutationObserver,
      getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    };
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }

    try {
      const page = {evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument)};
      const rules = normalizeCoverageRules([{
        name: 'dynamic-prose',
        selector: 'main p',
        kind: 'content',
        minInitial: 1,
        minSeen: 2,
        trackDynamic: true,
      }]);
      await installCoverageTracker(page, rules);
      const tracker = (window as unknown as Record<string, {
        metrics: () => Record<string, number>;
        report: () => Array<{name: string; seenCount: number; dynamicSeenCount: number}>;
        stop: () => void;
      }>)[COVERAGE_TRACKER_KEY];

      const main = document.querySelector('main')!;
      const artifact = document.createElement('span');
      artifact.className = 'fluent-read-bilingual-content';
      artifact.setAttribute('data-fr-translation-owned', 'true');
      artifact.textContent = '译文';
      const late = document.createElement('p');
      late.textContent = 'Late host paragraph must not hide behind an artifact mutation.';
      main.append(artifact, late);
      observer!.emit([{
        type: 'childList',
        target: main,
        addedNodes: [artifact, late] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord]);

      expect(tracker.metrics()).toMatchObject({hostMutationCount: 1, dynamicStructureSignatureCalls: 1});
      expect(tracker.report()).toContainEqual(expect.objectContaining({
        name: 'dynamic-prose',
        seenCount: 2,
        dynamicSeenCount: 1,
      }));
      tracker.stop();
    } finally {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it('rejects stale production output but does not apply the production mtime gate to dev output', () => {
    const latestSource = {path: '/repo/src/features/full-page-translation/content/runtime.ts', mtimeMs: 200};
    expect(evaluateProductionBuildFreshness({
      extensionDir: '/repo/.output/chrome-mv3',
      manifestMtimeMs: 100,
      latestSource,
    })).toMatchObject({ok: false, production: true});
    expect(evaluateProductionBuildFreshness({
      extensionDir: '/repo/.output/chrome-mv3-dev',
      manifestMtimeMs: 100,
      latestSource,
    })).toMatchObject({ok: true, production: false});
  });

  it('includes migrated src files in the actual production freshness scan', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'fluentread-freshness-test-'));
    const extensionDir = join(projectRoot, '.output', 'chrome-mv3');
    const sourceDir = join(projectRoot, 'src', 'features');
    try {
      mkdirSync(extensionDir, {recursive: true});
      mkdirSync(sourceDir, {recursive: true});
      const manifest = join(extensionDir, 'manifest.json');
      const source = join(sourceDir, 'runtime.ts');
      writeFileSync(manifest, '{}');
      writeFileSync(source, '// changed runtime');
      utimesSync(manifest, 100, 100);
      utimesSync(source, 200, 200);
      expect(() => assertFreshProductionExtension(extensionDir, projectRoot)).toThrow('拒绝测试旧 production extension');
      utimesSync(manifest, 300, 300);
      expect(() => assertFreshProductionExtension(extensionDir, projectRoot)).not.toThrow();
    } finally {
      rmSync(projectRoot, {recursive: true, force: true});
    }
  });

  it('reveals layout-preserving hidden entrance content before waiting for visibility', async () => {
    const {document} = parseHTML('<html><body><li hidden><p>Entrance content remains translatable.</p></li></body></html>');
    const paragraph = document.querySelector('p')!;
    Object.defineProperty(paragraph, 'getBoundingClientRect', {value: () => ({width: 400, height: 40})});
    vi.stubGlobal('document', document);
    vi.stubGlobal('getComputedStyle', () => ({display: 'block', visibility: 'visible'}));
    let revealed = false;
    const scroll = vi.fn(async () => {
      revealed = true;
      paragraph.parentElement!.removeAttribute('hidden');
    });
    const page = {
      waitForSelector: vi.fn(async () => undefined),
      evaluate: async (fn: (arg: string) => unknown, arg: string) => fn(arg),
      waitForFunction: async (fn: (arg: string) => boolean, arg: string) => {
        expect(revealed).toBe(true);
        expect(fn(arg)).toBe(true);
      },
      locator: () => ({nth: () => ({scrollIntoViewIfNeeded: scroll})}),
      waitForTimeout: vi.fn(async () => undefined),
    };
    try {
      await waitForStableTarget(page, 'p', 100);
      expect(scroll).toHaveBeenCalled();
      expect(document.querySelector('[hidden]')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('aims at original text instead of heading padding, permalink text, or appended translations', () => {
    const {document} = parseHTML('<html><body><h1><a href="#heading">¶</a><span>Everything you would expect</span><span data-fr-translation-owned="true">所有译文</span></h1></body></html>');
    const original = document.querySelector('h1 > span')!;
    const permalink = document.querySelector('a')!;
    let covered = false;
    Object.defineProperty(document, 'createRange', {value: () => {
      let parent: Node | null;
      return {
        selectNodeContents(node: Node) { parent = node.parentNode; },
        getClientRects: () => [{left: parent === permalink ? 500 : 20, right: parent === permalink ? 700 : 220,
          top: 140, bottom: 160, width: 200, height: 20}],
      };
    }});
    Object.defineProperty(document, 'elementFromPoint', {
      value: (x: number) => covered ? document.body : x > 400 ? permalink : original,
    });
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', {innerWidth: 1280, innerHeight: 900});
    vi.stubGlobal('getComputedStyle', () => ({display: 'inline', visibility: 'visible'}));
    try {
      expect(findHoverTextPointInPage({selector: 'h1', index: 0})).toMatchObject({
        x: 90, y: 150, text: 'Everything you would expect',
      });
      covered = true;
      expect(findHoverTextPointInPage({selector: 'h1', index: 0})).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('waits through post-restore movement and temporary occlusion before sending one trusted hotkey', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const point = (y: number) => ({
      x: 90, y, textIndex: 0, text: 'Everything you would expect',
      rect: {left: 20, top: y - 10, width: 200, height: 20},
    });
    const down = vi.fn(async () => { expect(Date.now()).toBeGreaterThanOrEqual(350); });
    const up = vi.fn(async () => undefined);
    const move = vi.fn(async () => undefined);
    const page = {
      evaluate: async () => Date.now() < 50 ? point(100) : Date.now() < 100 ? point(130) : Date.now() < 150 ? null : point(180),
      mouse: {move},
      keyboard: {down, up},
      waitForTimeout: async (ms: number) => { vi.advanceTimersByTime(ms); },
      waitForFunction: vi.fn(async () => undefined),
    };
    try {
      await toggleHover(page, {scrollIntoViewIfNeeded: async () => undefined}, {selector: 'h1', index: 0}, 1, 1000);
      expect(move.mock.calls).toEqual([[90, 100], [90, 130], [90, 180]]);
      expect(down.mock.calls).toEqual([['Control']]);
      expect(up.mock.calls).toEqual([['Control']]);
      expect(page.waitForFunction).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails without issuing a translation hotkey when original text never becomes hittable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const down = vi.fn();
    const page = {
      evaluate: async () => null,
      mouse: {move: vi.fn()},
      keyboard: {down, up: vi.fn()},
      waitForTimeout: async (ms: number) => { vi.advanceTimersByTime(ms); },
    };
    try {
      await expect(toggleHover(page, {scrollIntoViewIfNeeded: async () => undefined}, {selector: 'h1', index: 0}, 1, 200))
        .rejects.toThrow('悬浮原文没有稳定且可命中的位置');
      expect(down).not.toHaveBeenCalled();
      expect(page.mouse.move).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tracks newly revealed descendants when their ancestor loses its hidden attribute', async () => {
    const {document, window} = parseHTML('<html><body><section hidden><p>Newly revealed prose must be translated during the first pass.</p></section></body></html>');
    Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({width: 400, height: 40, top: 0, left: 0, right: 400, bottom: 40}),
    });
    for (const [key, value] of Object.entries({
      window, document, Node: window.Node, HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement, MutationObserver: window.MutationObserver,
      getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    })) vi.stubGlobal(key, value);
    let tracker: {report: () => unknown[]; stop: () => void} | undefined;
    try {
      const rules = normalizeCoverageRules([{name: 'prose', selector: 'section p', minInitial: 1, trackDynamic: true}]);
      await installCoverageTracker({evaluate: async (fn, argument) => fn(argument)}, rules);
      tracker = (window as unknown as Record<string, typeof tracker>)[COVERAGE_TRACKER_KEY]!;
      expect(tracker.report()).toContainEqual(expect.objectContaining({seenCount: 0}));
      document.querySelector('section')!.removeAttribute('hidden');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(tracker.report()).toContainEqual(expect.objectContaining({seenCount: 1, translatedCount: 0}));
      expect(() => assertCoverageReport(rules, tracker!.report(), 'revealed')).toThrow('仅翻译 0/1');
      const wrapper = document.createElement('span');
      wrapper.className = 'fluent-read-bilingual-content';
      wrapper.textContent = '新揭示正文的译文';
      document.querySelector('p')!.append(wrapper);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(() => assertCoverageReport(rules, tracker!.report(), 'revealed')).not.toThrow();
    } finally {
      tracker?.stop();
      vi.unstubAllGlobals();
    }
  });

  it('keeps SQLite prose selection stable when bilingual wrappers move syntax labels', () => {
    const {document} = parseHTML(`<html><body><div class="fancy">
      <p id="syntax"><b><a href="syntax/select-stmt.html">select-stmt</a>:</b></p>
      <p id="prose">The SELECT statement is used to query the database.</p>
      <p id="reference">The <a href="syntax/select-stmt.html">select-stmt</a> diagram explains the grammar.</p>
    </div></body></html>`);
    const selector = cases['sqlite-select-language'].hoverSelector;
    expect([...document.querySelectorAll(selector)].map((node) => node.id)).toEqual(['prose', 'reference']);
    document.querySelector('#syntax')!.innerHTML = '<span class="fluent-read-original-text"><b><span><a href="syntax/select-stmt.html">select-stmt</a>:</span></b></span><span class="fluent-read-bilingual-content">select-stmt：</span>';
    expect([...document.querySelectorAll(selector)].map((node) => node.id)).toEqual(['prose', 'reference']);
  });

  it('captures host MathJax errors only after its existing startup queue completes', async () => {
    const {document} = parseHTML('<html><body><p id="formula">Raw formula source</p></body></html>');
    let complete: (() => void) | undefined;
    const Queue = vi.fn((callback: () => void) => { complete = callback; });
    vi.stubGlobal('window', {MathJax: {version: '2.7', Hub: {Queue}}});
    vi.stubGlobal('document', document);
    const page = {evaluate: (fn: (timeout: number) => unknown, timeout: number) => fn(timeout)};
    try {
      const pending = waitForHostMathRendering(page, 1000);
      expect(Queue).toHaveBeenCalledTimes(1);
      document.querySelector('#formula')!.innerHTML = '<span class="MathJax_Error" id="math-error">[Math Processing Error]</span>';
      complete!();
      await expect(pending).resolves.toEqual({detected: true, version: '2.7', errors: [{id: 'math-error', text: '[Math Processing Error]'}]});
      expect(Queue.mock.calls[0]).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails boundedly when host MathJax never finishes and skips pages without its queue', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {MathJax: {Hub: {Queue: () => undefined}}});
    const page = {evaluate: (fn: (timeout: number) => unknown, timeout: number) => fn(timeout)};
    try {
      const pending = waitForHostMathRendering(page, 50);
      const failure = expect(pending).rejects.toThrow('宿主 MathJax 初始排版等待超时');
      await vi.advanceTimersByTimeAsync(50);
      await failure;
      vi.stubGlobal('window', {});
      await expect(waitForHostMathRendering(page, 50)).resolves.toEqual({detected: false, errors: []});
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('requires every non-optional forbidden selector to exist for required cases', () => {
    const forbidden = ['pre, code', 'svg'];
    expect(resolveForbiddenMustExistSelectors('required', forbidden, ['svg'])).toEqual(forbidden);
    expect(resolveForbiddenMustExistSelectors('required', forbidden, [], ['svg'])).toEqual(['pre, code']);
    expect(resolveForbiddenMustExistSelectors('quarantine', forbidden, ['svg'])).toEqual(['svg']);
    expect(resolveForbiddenMustExistSelectors('quarantine', forbidden, ['svg'], ['svg'])).toEqual([]);
  });

  it('adopts a clean late dynamic optional forbidden subtree and then enforces its baseline', () => {
    const optional = {
      selector: '.MathJax_Display',
      dynamic: true,
      optional: true,
      count: 0,
      translatedDescendants: 0,
      ownedDescendants: 0,
      signatures: [],
    };
    const appeared = {
      ...optional,
      count: 1,
      signatures: [{tagName: 'DIV', text: 'x + y', structure: '["div",["#text"]]'}],
    };

    expect(reconcileForbiddenContractState(optional, {...optional})).toBeNull();
    expect(reconcileForbiddenContractState(optional, appeared)).toBeNull();
    expect(optional).toEqual(appeared);
    expect(reconcileForbiddenContractState(optional, {...appeared})).toBeNull();
    expect(reconcileForbiddenContractState(optional, {
      ...appeared,
      signatures: [{tagName: 'DIV', text: 'changed', structure: '["div",["#text"]]'}],
    })).toContain('动态 forbidden DOM 基线丢失');
    expect(reconcileForbiddenContractState(optional, {...appeared, count: 0, signatures: []}))
      .toContain('动态 forbidden DOM 基线丢失');
  });

  it('rejects owned content and untracked late optional forbidden subtrees', () => {
    const optional = {
      selector: '.MathJax_Display',
      dynamic: true,
      optional: true,
      count: 0,
      translatedDescendants: 0,
      ownedDescendants: 0,
      signatures: [],
    };
    expect(reconcileForbiddenContractState({...optional}, {
      ...optional,
      count: 1,
      ownedDescendants: 1,
    })).toContain('forbidden DOM 出现译文');
    expect(reconcileForbiddenContractState({...optional, dynamic: false}, {
      ...optional,
      dynamic: false,
      count: 1,
    })).toContain('可选 forbidden DOM 在静态 contract 后出现');
  });

  it('allows only explicitly mutable dynamic forbidden roots to finish host rendering', () => {
    const mutable = {
      selector: '.MathJax_Display',
      dynamic: true,
      optional: true,
      mutable: true,
      count: 2,
      translatedDescendants: 0,
      ownedDescendants: 0,
      signatures: [{tagName: 'DIV', text: '', structure: '["div",[["span",[]]]]'}],
    };
    const typeset = {
      ...mutable,
      signatures: [{tagName: 'DIV', text: 'x + y', structure: '["div",[["span",["#text"]]]]'}],
    };

    expect(reconcileForbiddenContractState(mutable, typeset)).toBeNull();
    expect(reconcileForbiddenContractState(mutable, {...typeset, count: 3})).toBeNull();
    expect(mutable.count).toBe(3);
    expect(reconcileForbiddenContractState(mutable, {...typeset, count: 2}))
      .toContain('宿主可变 forbidden DOM 数量减少');
    expect(reconcileForbiddenContractState(mutable, {...typeset, ownedDescendants: 1}))
      .toContain('forbidden DOM 出现译文');
    expect(() => validateMutableForbiddenSelectors('invalid', ['.formula'], [], ['.formula']))
      .toThrow('必须同时是允许列表、dynamicForbiddenSelectors 与 forbiddenSelectors 的子集');
    expect(() => validateMutableForbiddenSelectors(
      'valid',
      ['.MathJax_Display'],
      ['.MathJax_Display'],
      ['.MathJax_Display'],
    )).not.toThrow();
    for (const protectedChrome of ['#nav', '#content pre, #content code', "script[type^='math/tex']"]) {
      expect(() => validateMutableForbiddenSelectors(
        'strict-protected',
        [protectedChrome],
        [protectedChrome],
        [protectedChrome],
      )).toThrow('必须同时是允许列表');
    }
  });

  it('keeps every forbidden signature and detects damage in the thirteenth node', async () => {
    const formulas = Array.from({length: 13}, (_, index) =>
      `<span class="formula">formula-${index + 1}</span>`).join('');
    const {document, window} = parseHTML(`<html><body><main>${formulas}</main></body></html>`);
    const url = 'https://example.test/forbidden-contract';
    const globals = {
      window,
      document,
      location: {href: url},
      Node: window.Node,
      HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement,
      getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
    };
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    }
    const page = {
      evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument),
      url: () => url,
    };

    try {
      const baseline = await capturePageContract(page, [], ['.formula'], [], [], []);
      expect(baseline.forbiddenState[0].signatures).toHaveLength(13);

      const first = document.querySelector('.formula')!;
      first.setAttribute('data-fr-translation-owned', 'true');
      const selfOwned = await capturePageContract(page, [], ['.formula'], [], [], []);
      expect(selfOwned.forbiddenState[0]).toMatchObject({ownedDescendants: 1});
      first.removeAttribute('data-fr-translation-owned');

      const thirteenth = document.querySelectorAll('.formula')[12];
      thirteenth.textContent = 'damaged formula';
      thirteenth.append(document.createElement('em'));

      const error = await assertPageContract(page, baseline, [], url, '第十三节点回归')
        .then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('forbidden DOM 被修改');
      expect((error as Error).message).toContain('"signatureCount":13');
      // 契约比较覆盖全部 13 个节点，但诊断刻意只保留前 12 个签名，控制失败输出规模。
      expect((error as Error).message).not.toContain('damaged formula');
    } finally {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it('retries a controlled dialog close until the second key press hides it', async () => {
    let visible = true;
    const pressed: string[] = [];
    const waitTimeouts: number[] = [];
    const [scenario] = normalizeInteractionScenarios([{
      name: 'two-stage-close',
      triggerSelector: '#trigger',
      openKey: 'click',
      dialogSelector: '#dialog',
      closeKey: 'Escape',
      closeAttempts: 2,
    }]);
    const page = {
      keyboard: {
        press: async (key: string) => {
          pressed.push(key);
          if (pressed.length === 2) visible = false;
        },
      },
      waitForSelector: async (_selector: string, options: {state: string; timeout: number}) => {
        waitTimeouts.push(options.timeout);
        expect(options.state).toBe('hidden');
        if (visible) throw new Error('dialog remains visible');
      },
    };

    await expect(closeInteractionDialog(page, scenario!, 60_000, 'baseline')).resolves.toBe(2);
    expect(pressed).toEqual(['Escape', 'Escape']);
    expect(waitTimeouts).toEqual([1500, 1500]);
  });

  it('fails strictly when every configured dialog close attempt leaves it visible', async () => {
    const pressed: string[] = [];
    const [scenario] = normalizeInteractionScenarios([{
      name: 'never-closes',
      triggerSelector: '#trigger',
      openKey: 'click',
      dialogSelector: '#dialog',
      closeKey: 'Escape',
      closeAttempts: 2,
    }]);
    const page = {
      keyboard: {press: async (key: string) => void pressed.push(key)},
      waitForSelector: async () => {
        throw new Error('dialog remains visible');
      },
    };

    await expect(closeInteractionDialog(page, scenario!, 60_000, 'first-translation'))
      .rejects.toThrow('first-translation/never-closes 对话框在 2 次 Escape 后仍未隐藏');
    expect(pressed).toEqual(['Escape', 'Escape']);
  });

  it('defaults dialog close attempts to one and rejects values outside the bounded range', () => {
    expect(normalizeInteractionScenarios([{
      name: 'default-close',
      triggerSelector: '#trigger',
      openKey: 'click',
      dialogSelector: '#dialog',
    }])[0]?.closeAttempts).toBe(1);
    for (const closeAttempts of [0, 4, 1.5]) {
      expect(() => normalizeInteractionScenarios([{
        name: 'invalid-close',
        triggerSelector: '#trigger',
        openKey: 'click',
        dialogSelector: '#dialog',
        closeAttempts,
      }])).toThrow('closeAttempts 必须是 1-3 的整数');
    }
  });

  it('adds one anchored hover target for every missing coverage selector', () => {
    const coverageRules = normalizeCoverageRules([
      {
        name: 'title',
        selector: 'main h1',
        kind: 'heading',
        sourceIncludes: ['Expected title', 'Second page sample'],
      },
      {name: 'body', selector: 'main p', kind: 'content'},
    ]);
    const targets = normalizeHoverTargets([{name: 'body', selector: 'main p'}], {
      fallbackSelector: 'main p',
      coverageRules,
    });
    expect(targets).toEqual([
      expect.objectContaining({name: 'body', selector: 'main p', sourceIncludes: []}),
      expect.objectContaining({
        name: 'coverage-title',
        selector: 'main h1',
        sourceIncludes: ['Expected title'],
      }),
    ]);

    expect(normalizeHoverTargets([{
      name: 'explicit-title',
      selector: 'main h1',
      sourceIncludes: ['Expected title', 'Second page sample'],
    }], {coverageRules})[0].sourceIncludes).toEqual(['Expected title', 'Second page sample']);
  });

  it('counts late dynamic nodes and fails if any observed node is untranslated', () => {
    const rules = normalizeCoverageRules([{
      name: 'dynamic-comments',
      selector: 'shreddit-comment p',
      kind: 'content',
      minInitial: 1,
      minSeen: 3,
      trackDynamic: true,
    }]);
    const report = [{
      name: 'dynamic-comments',
      seenCount: 3,
      dynamicSeenCount: 2,
      translatedCount: 2,
      sourceSamples: ['initial', 'late one', 'late two'],
      missedSamples: ['late two'],
    }];

    expect(() => assertCoverageReport(rules, report, 'test')).toThrow('仅翻译 2/3 个节点');
  });

  it('fails the old seven-wrapper PR 4038 baseline', () => {
    const pr = cases['github-project-pr'];
    const rules = normalizeCoverageRules(pr.coverageRules);
    const oldSevenWrapperBaseline = [
      {
        name: 'pull-request-title',
        seenCount: 1,
        translatedCount: 1,
        sourceSamples: ['fix(github): preserve quick search during translation'],
        missedSamples: [],
      },
      {
        name: 'body-headings',
        seenCount: 3,
        translatedCount: 0,
        sourceSamples: ['What changed', 'Why', 'Validation'],
        missedSamples: ['What changed', 'Why', 'Validation'],
      },
      {
        name: 'body-paragraphs',
        seenCount: 2,
        translatedCount: 0,
        sourceSamples: ['GitHub mounts its global search UI dynamically', 'Fixes #3997.'],
        missedSamples: ['GitHub mounts its global search UI dynamically', 'Fixes #3997.'],
      },
      {
        name: 'body-list-items',
        seenCount: 7,
        translatedCount: 6,
        sourceSamples: ["Exclude GitHub's global search trigger", 'Ran git diff --check.'],
        missedSamples: ['Ran git diff --check.'],
      },
    ];

    expect(() => assertCoverageReport(rules, oldSevenWrapperBaseline, 'PR4038')).toThrow(
      'PR4038 全文覆盖断言失败',
    );
  });

  it('requires source anchors so selector drift cannot silently pass', () => {
    const rules = normalizeCoverageRules([{
      name: 'title',
      selector: 'main h1',
      kind: 'heading',
      minInitial: 1,
      sourceIncludes: ['Expected title'],
    }]);
    const report = [{
      name: 'title',
      seenCount: 1,
      translatedCount: 1,
      sourceSamples: ['Wrong page title'],
      missedSamples: [],
    }];

    expect(() => assertCoverageReport(rules, report, 'test')).toThrow('未命中预期原文');
  });

  it('checks source anchors across the whole rule instead of only the 16 diagnostic samples', () => {
    const rules = normalizeCoverageRules([{
      name: 'long-document',
      selector: 'main p',
      kind: 'content',
      minInitial: 30,
      sourceIncludes: ['The SELECT statement is used to query the database.'],
    }]);
    const report = [{
      name: 'long-document',
      seenCount: 30,
      translatedCount: 30,
      sourceSamples: Array.from({length: 16}, (_, index) => `Earlier paragraph ${index}`),
      matchedSourceIncludes: ['The SELECT statement is used to query the database.'],
      missedSamples: [],
    }];

    expect(assertCoverageReport(rules, report, 'long document')).toBe(report);
  });

  it('fails restoration when extension nodes or changed source DOM remain', () => {
    expect(() => assertCoverageRestoration([{
      name: 'body',
      ownedCount: 1,
      changedCount: 1,
      missingStaticCount: 0,
      changedSamples: [{source: 'before', current: 'after'}],
    }], 'restore')).toThrow('恢复断言失败');
  });
});

describe('real-site translation matrix gates', () => {
  it('contains enough required real sites and validates every explicit coverage rule', () => {
    const matrix = validateMatrix();
    expect(matrix.entries.length).toBeGreaterThanOrEqual(MATRIX_REQUIREMENTS.total);
    expect(matrix.required.length).toBeGreaterThanOrEqual(MATRIX_REQUIREMENTS.required);
    expect(matrix.requiredHosts.size).toBeGreaterThanOrEqual(MATRIX_REQUIREMENTS.requiredHosts);
    expect(matrix.quarantine.length).toBeGreaterThanOrEqual(MATRIX_REQUIREMENTS.quarantine);
  });

  it('collects an invalid URL as a named matrix error instead of throwing during host aggregation', () => {
    expect(() => validateMatrix({
      'invalid-url': {
        url: 'not a valid url',
        tier: 'quarantine',
        quarantineReason: 'invalid fixture',
        selector: 'main p',
        requiredSelectors: ['main p'],
        forbiddenSelectors: ['pre, code'],
        optionalForbiddenSelectors: [''],
        interactionSelectors: ['main a[href]'],
        coverageRules: [{name: 'body', selector: 'main p', kind: 'content', minInitial: 1}],
        hoverTargets: [{name: 'body', selector: 'main p', index: 0}],
        modes: ['hover', 'full'],
      },
    })).toThrow(/invalid-url 的 url 无效：not a valid url[\s\S]*optionalForbiddenSelectors/u);
  });

  it('rejects an empty raw required selector instead of normalizing it away', () => {
    const invalidCases = structuredClone(cases) as unknown as Record<string, Record<string, unknown>>;
    const config = invalidCases['bambu-dual-nozzles'];
    config.requiredSelectors = [...config.requiredSelectors as string[], '   '];
    expect(() => validateMatrix(invalidCases)).toThrow(
      'bambu-dual-nozzles 必须配置 requiredSelectors 或旧版 selector',
    );
  });

  it('requires forbiddenSelectors to be a non-empty raw array', () => {
    const invalidCases = structuredClone(cases) as unknown as Record<string, Record<string, unknown>>;
    invalidCases['bambu-dual-nozzles'].forbiddenSelectors = 'header svg';
    expect(() => validateMatrix(invalidCases)).toThrow('bambu-dual-nozzles 缺少 forbiddenSelectors');
  });

  it('gives each browser child a bounded multi-stage budget and terminates a hung process', async () => {
    expect(computeJobTimeoutMs(60_000, 'hover')).toBe(5 * 60_000);
    expect(computeJobTimeoutMs(60_000, 'full')).toBe(30 * 60_000);
    expect(computeJobTimeoutMs(240_000, 'hover')).toBe(8 * 60_000);
    expect(computeJobTimeoutMs(240_000, 'full')).toBe(37 * 60_000);
    expect(computeJobTimeoutMs(60_000, 'full', 1234)).toBe(1234);

    const result = await runChildWithWatchdog(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ], {timeoutMs: 80, killGraceMs: 30, stdio: 'ignore'});
    expect(result).toMatchObject({ok: false, timedOut: true});
  });

  it('still SIGKILLs the process group when the direct child closes after SIGTERM', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {pid: 4242});
      const signals: string[] = [];
      const resultPromise = runChildWithWatchdog('fake-runner', [], {
        timeoutMs: 100,
        killGraceMs: 25,
        stdio: 'ignore',
        spawnImpl: () => child,
        killProcessGroupImpl: (_target, signal) => {
          signals.push(signal);
          if (signal === 'SIGTERM') {
            // runner 虽已退出，但脱离的浏览器孙进程仍留在进程组中，
            // 因此仍需向整个进程组发送 SIGKILL。
            queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
          }
          return true;
        },
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(signals).toEqual(['SIGTERM']);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(25);
      await expect(resultPromise).resolves.toMatchObject({ok: false, timedOut: true, signal: 'SIGTERM'});
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the watchdog without sending signals when the child exits normally', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {pid: 4343});
      const signals: string[] = [];
      const resultPromise = runChildWithWatchdog('fake-runner', [], {
        timeoutMs: 100,
        killGraceMs: 25,
        stdio: 'ignore',
        spawnImpl: () => child,
        killProcessGroupImpl: (_target, signal) => {
          signals.push(signal);
          return true;
        },
      });

      child.emit('close', 0, null);
      await expect(resultPromise).resolves.toMatchObject({ok: true, timedOut: false, signal: null});
      expect(signals).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(signals).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizes required hover coverage across every semantic rule', () => {
    for (const [name, rawConfig] of Object.entries(cases)) {
      const config = rawConfig as {
        tier?: string;
        hoverSelector?: string;
        selector?: string;
        hoverTargets?: unknown[];
        coverageRules: unknown[];
      };
      if ((config.tier || 'required') !== 'required') continue;
      const coverageRules = normalizeCoverageRules(config.coverageRules);
      const targets = normalizeHoverTargets(config.hoverTargets || [], {
        fallbackSelector: config.hoverSelector || config.selector,
        coverageRules,
      });
      const targetSelectors = new Set(targets.map(({selector}) => selector));
      expect(
        coverageRules.every(({selector}) => targetSelectors.has(selector)),
        `${name} hover/full candidate parity`,
      ).toBe(true);
    }
  });

  it('restores recovered pages to required while keeping challenged pages quarantined', () => {
    expect(cases['hacker-news-8863'].tier).toBe('required');
    expect(cases['ubuntu-apt-manpage'].tier).toBe('required');
    expect(cases['pubdev-provider'].tier).toBe('required');
    expect(cases['reddit-minimax-thread'].tier).toBe('quarantine');
    expect(cases['w3c-accessibility-introduction'].tier).toBe('quarantine');
    expect(cases['nginx-beginners-guide'].tier).toBe('required');
    expect(cases['curl-http-scripting'].tier).toBe('required');
    expect(cases['sqlite-select-language'].tier).toBe('required');
    expect(cases['git-book-version-control'].tier).toBe('required');
    expect(cases['github-project-pulls'].forbiddenSelectors).toEqual([
      "button[aria-haspopup='dialog'][aria-label*='search' i]",
    ]);
    expect(cases['brown-pl-introduction'].forbiddenSelectors).toEqual(['table.RktBlk']);
    expect(cases['sqlite-select-language'].hoverSelector).toBe(
      ".fancy > p:not(:has(b a[href^='syntax/']))",
    );
    expect(cases['sqlite-select-language'].coverageRules).toContainEqual(expect.objectContaining({
      name: 'reference-paragraphs',
      selector: ".fancy > p:not(:has(b a[href^='syntax/']))",
      sourceIncludes: ['The SELECT statement is used to query the database.'],
    }));
    expect(cases['learnopengl-coordinate-systems'].forbiddenSelectors).toEqual([
      '#content pre, #content code',
      '.MathJax_Display',
      "script[type^='math/tex']",
      '#nav',
    ]);
    expect(cases['learnopengl-coordinate-systems'].optionalForbiddenSelectors).toEqual([
      '.MathJax_Display',
    ]);
    expect(cases['learnopengl-coordinate-systems'].dynamicForbiddenSelectors).toEqual([
      '.MathJax_Display',
    ]);
    expect(cases['learnopengl-coordinate-systems'].mutableForbiddenSelectors).toEqual([
      '.MathJax_Display',
    ]);
    expect(resolveForbiddenMustExistSelectors(
      'required',
      cases['learnopengl-coordinate-systems'].forbiddenSelectors,
      [],
      cases['learnopengl-coordinate-systems'].optionalForbiddenSelectors,
    )).toEqual(['#content pre, #content code', "script[type^='math/tex']", '#nav']);
    expect(cases['learnopengl-coordinate-systems'].interactionSelectors).toEqual([
      '#content a[href], #nav a[href]',
    ]);
  });

  it('keeps modern manpage prose separate from mandatory command syntax and command labels', () => {
    const {document} = parseHTML('<main><div id="manpage-content"><h2 id="synopsis" class="Sh">SYNOPSIS</h2><section><p class="Pp HP"><b>apt</b> [<b>--help</b>]</p></section><h2 id="description" class="Sh">DESCRIPTION</h2><section><p class="Pp">The command provides a package management interface.</p><p class="Pp">Its manual explains the most common options.</p><p class="Pp"><b>update</b></p><div class="Bd-indent">Download package information from configured sources.</div></section></div></main>');
    const config = cases['ubuntu-apt-manpage'];
    expect([...document.querySelectorAll(config.hoverSelector)].map((node) => node.textContent)).toEqual([
      'The command provides a package management interface.',
      'Its manual explains the most common options.',
    ]);
    const protectedNodes = config.forbiddenMustExistSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
    expect(protectedNodes.map((node) => node.textContent)).toEqual(['apt [--help]', 'update']);
    expect(config.forbiddenMustExistSelectors.every((selector) => config.forbiddenSelectors.includes(selector))).toBe(true);
  });

  it('covers MDN body headings while preserving the sidebar table of contents', () => {
    const {document} = parseHTML('<main id="content" class="layout__content"><h1>Grammar and types</h1><aside class="layout__right-sidebar reference-layout__toc"><nav class="reference-toc"><h2>In this article</h2><a href="#basics">Basics</a></nav></aside><div class="layout__body reference-layout__body"><section class="content-section"><h2 id="basics">Basics</h2><p>The language distinguishes upper and lower case.</p><p>Statements have a defined structure.</p><p>Use <code>let</code> for a local binding.</p></section><section class="content-section"><h2>Comments</h2><p>Comments explain the surrounding source.</p><p>They are ignored during execution.</p><pre>let value = 1;</pre></section></div></main>');
    const config = cases['mdn-javascript-guide'];
    const rules = normalizeCoverageRules(config.coverageRules);
    const headings = rules.find(({name}) => name === 'guide-sections')!;
    expect([...document.querySelectorAll(headings.selector)].map((node) => node.textContent)).toEqual(['Basics', 'Comments']);
    expect(headings.minInitial).toBe(2);
    expect(rules.find(({name}) => name === 'guide-title')?.minInitial).toBe(1);
    const paragraphs = rules.find(({name}) => name === 'guide-paragraphs')!;
    expect(paragraphs.minInitial).toBe(5);
    expect(document.querySelectorAll(paragraphs.selector)).toHaveLength(5);
    const protectedNodes = resolveForbiddenMustExistSelectors('required', config.forbiddenSelectors, [])
      .flatMap((selector) => [...document.querySelectorAll(selector)]);
    expect(protectedNodes.some((node) => node.matches('nav.reference-toc'))).toBe(true);
    expect(protectedNodes.some((node) => node.matches('pre'))).toBe(true);
    expect(protectedNodes.some((node) => node.matches('code'))).toBe(true);
  });

  it('requires each mixed-manpage source part and does not accept only its nested paragraph translation', () => {
    const fixture = establishedFixtures.find(({id}) => id === 'ubuntu-manpage')!;
    const {document} = parseHTML(fixture.html);
    const parts = fixture.translationParts!;
    const child = document.querySelector('#body2')!;
    child.insertAdjacentHTML('beforeend', `<span class="fluent-read-bilingual-content">测试译文：${child.textContent}</span>`);
    const onlyChild = inspectFixtureTranslationParts({parts}, document);
    expect(onlyChild.map(({translated}: {translated: boolean}) => translated)).toEqual([false, true, false]);
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
    const mixed = document.querySelector('#mixed-command')!;
    const segment = document.createElement('span');
    segment.setAttribute('data-fr-translation-segment', 'true');
    while (mixed.firstChild !== child) segment.append(mixed.firstChild!);
    mixed.insertBefore(segment, child);
    segment.insertAdjacentHTML('beforeend', `<span class="fluent-read-bilingual-content">测试译文：${segment.textContent}</span>`);
    const second = document.querySelector('#second-command')!;
    second.insertAdjacentHTML('beforeend', `<span class="fluent-read-bilingual-content">测试译文：${second.innerHTML}</span>`);
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(true);
    const translatedCommand = second.querySelector('.fluent-read-bilingual-content b')!;
    const exactCommand = translatedCommand.textContent;
    translatedCommand.textContent = exactCommand!.replace(/\s+/gu, ' ');
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
    translatedCommand.textContent = exactCommand;
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(true);
    segment.querySelector('.fluent-read-bilingual-content')!.textContent = `测试译文：${parts[0].sourceIncludes}`;
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
    expect(fixture.restoreSelectors).toEqual(['#mixed-command', '#second-command']);
  });

  it('rejects X Chat metadata copied into the translated message or duplicate translated parts', () => {
    const fixture = establishedFixtures.find(({id}) => id === 'x-chat')!;
    const {document} = parseHTML(fixture.html);
    const parts = fixture.translationParts!;
    const owner = document.querySelector('#body1')!;
    const source = parts[0].sourceIncludes;
    owner.insertAdjacentHTML('beforeend', `<span class="fluent-read-bilingual-content">测试译文：${source}</span>`);
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(true);
    const translation = owner.querySelector('.fluent-read-bilingual-content')!;
    translation.textContent += ' Yesterday 10:30 Edited';
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
    translation.textContent = source;
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
    translation.textContent = `测试译文：${source}`;
    owner.appendChild(translation.cloneNode(true));
    expect(inspectFixtureTranslationParts({parts, requireAll: true}, document)).toBe(false);
  });

  it('targets visible package readme content while requiring both fenced and inline code protection', () => {
    const {document} = parseHTML('<main><div hidden><p class="detail-lead-text">A hidden responsive summary.</p></div><section class="detail-tab-readme-content"><p>Language navigation</p><p>A wrapper around <a href="https://api.flutter.dev/flutter/widgets/InheritedWidget-class.html">InheritedWidget</a> for reuse.</p><h2>Usage</h2><p>Read the <code>provider</code> state.</p><pre><code>final value = context.watch&lt;int&gt;();</code></pre></section></main>');
    const config = cases['pubdev-provider'];
    const targets = [...document.querySelectorAll(config.hoverSelector)];
    expect(targets).toHaveLength(1);
    expect(targets[0].textContent).toBe('A wrapper around InheritedWidget for reuse.');
    expect(targets[0].closest('[hidden]')).toBeNull();
    const protectedNodes = config.forbiddenMustExistSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
    expect(protectedNodes.some((node) => node.tagName === 'PRE')).toBe(true);
    expect(protectedNodes.some((node) => node.tagName === 'CODE' && node.parentElement?.tagName === 'P')).toBe(true);
  });

  it('keeps PR 4038 title, body headings, paragraphs and lists as separate requirements', () => {
    const rules = normalizeCoverageRules(cases['github-project-pr'].coverageRules);
    expect(rules.map(({selector}) => selector)).toEqual([
      'main h1',
      '.markdown-body h2',
      '.markdown-body p',
      '.markdown-body li',
    ]);
    expect(rules.every(({selector}) => !selector.includes(','))).toBe(true);
    expect(rules.every(({trackDynamic}) => trackDynamic)).toBe(true);
    const prHoverTargets = normalizeHoverTargets(cases['github-project-pr'].hoverTargets, {
      coverageRules: rules,
    });
    expect(prHoverTargets.map(({selector}) => selector)).toEqual([
      'main h1',
      '.markdown-body h2',
      '.markdown-body p',
      '.markdown-body li',
    ]);
    expect(prHoverTargets.find(({selector}) => selector === '.markdown-body h2')?.sourceIncludes).toEqual([
      '验证',
    ]);
    expect(prHoverTargets.find(({selector}) => selector === '.markdown-body li')?.sourceIncludes).toEqual([
      '已取消的快捷键手势',
    ]);
    expect(rules.find(({name}) => name === 'body-list-items')?.sourceIncludes).toEqual([
      '已取消的快捷键手势',
    ]);
    expect(cases['github-project-pr'].forbiddenMustExistSelectors).toEqual([
      "button[aria-haspopup='dialog'][aria-label*='search' i]",
    ]);
    expect(cases['github-project-pr'].interactionScenarios).toEqual([
      expect.objectContaining({
        triggerSelector: "button[aria-haspopup='dialog'][aria-label*='search' i]",
        openKey: 'click',
        dialogSelector: "[role='dialog'][aria-modal='true']",
        comboboxSelector: "[role='combobox']",
        listboxSelector: "[role='listbox']",
        inputText: 'issues',
        closeAttempts: 2,
      }),
    ]);
  });
});
