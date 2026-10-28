import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseHTML} from 'linkedom';
import {isClearlyWrongLanguageResponse, isLikelyUntranslatedResponse} from '@/src/core/translation/resultValidation';
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {protectGlossaryText} from '@/src/core/glossary/protection';
import {createTranslationSourceSnapshot, applyTranslationsToSnapshot, buildWholeBlockTranslationSource} from '@/src/core/translation/serialization';
import {createTranslationCore} from './helpers/translationCore';
import websiteRules from '@/src/core/site-adaptation/catalog/websites.json';
import {appendBilingualTranslation} from '@/src/features/full-page-translation/content/renderer';
import {translateMicrosoftTextsWithTransport} from '@/src/providers/translation/microsoftTransport';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@/src/services/config/store', () => ({config: {style: 1, to: 'zh-Hans'}}));
vi.mock('@/src/core/config/catalog', () => ({options: {styles: []}}));
vi.mock('@/src/features/full-page-translation/content/layout', () => ({ensureTranslationTruncationLayout: vi.fn()}));

const require = createRequire(import.meta.url);
const {installStabilityProbeInPage, assertStableSnapshot, runStabilityProbes, runNativeCommentToggle} = require('../scripts/site-translation/stability-probes.cjs');
const {MarionetteClient, parseArgs: parseFirefoxArgs, assertPageSnapshot} = require('../scripts/testing/run-web-stability-firefox-test.cjs');
const {parseArgs: parseNativeFeedArgs, installNativeFeedTracker, assertNativeSnapshot} = require('../scripts/testing/run-web-native-feed-test.cjs');
const {encodeControlledTranslation, decodeControlledTranslationText, isControlledTranslationForSource, readControlledPageEvidenceInPage, assertControlledPageEvidence, captureSourcePartitions, assertSourcePartitions} = require('../scripts/site-translation/controlled-provider.cjs');
const key = '__testStabilityProbe';
const wrapper = '.fluent-read-bilingual-content';
const source = 'This paragraph is a complete source passage with a protected ';

describe('live page controlled stability probe evidence', () => {
  let document: Document;
  let window: Window & Record<string, any>;
  let output: string;
  const translate = (node: Element) => {
    const translation = document.createElement('span');
    translation.className = 'fluent-read-bilingual-content';
    translation.setAttribute('data-fr-translation-owned', 'true');
    translation.textContent = '完整测试译文';
    node.append(translation);
    return translation;
  };
  const flush = async () => {await Promise.resolve(); await Promise.resolve();};
  const install = () => installStabilityProbeInPage({key, selector: '#source'});
  const probe = () => window[key];

  beforeEach(() => {
    ({document, window} = parseHTML(`<html><body><article><p id="source">${source}<code>API</code> and <a href="/reference">reference link</a>.</p></article></body></html>`) as unknown as {document: Document; window: Window & Record<string, any>});
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    vi.stubGlobal('MutationObserver', window.MutationObserver);
    translate(document.querySelector('#source')!);
    output = mkdtempSync(join(tmpdir(), 'fluentread-stability-test-'));
  });
  afterEach(() => {
    for (const name of Object.keys(window)) if (name.startsWith('__fluentReadStability_') || name === key) window[name]?.dispose?.();
    vi.unstubAllGlobals();
    rmSync(output, {recursive: true, force: true});
  });

  it('records source HTML without owned markup and rejects missing translated owners', () => {
    const installed = install();
    expect(installed.sourceText).toBe(`${source}API and reference link.`);
    expect(installed.baselineHtml).not.toContain('fluent-read');
    expect(assertStableSnapshot(probe().snapshot(), {phase: 'initial'}).owner.wrappers).toHaveLength(1);
    probe().dispose();
    document.querySelector(wrapper)!.remove();
    expect(install).toThrow('No translated source owner');
  });

  it('prefers a paragraph and does not choose nested translation or protected code as the source', () => {
    const title = document.createElement('h1'); title.id = 'title'; title.textContent = 'A translated title';
    document.body.prepend(title); translate(title);
    const code = document.createElement('code'); code.textContent = 'protected English text';
    document.body.append(code); translate(code);
    installStabilityProbeInPage({key, selector: '#title,code'});
    expect(probe().owner.id).toBe('source');
    expect(probe().owner.localName).toBe('p');
  });

  it('changes only one source Text identity and keeps protected elements intact', async () => {
    install(); const owner = probe().owner;
    const oldText = owner.firstChild, oldCode = owner.querySelector('code'), oldLink = owner.querySelector('a');
    const before = probe().snapshot(); probe().reset();
    expect(probe().replaceSourceText()).toEqual({text: source, equivalent: true});
    await flush();
    expect(owner.firstChild).not.toBe(oldText);
    expect(owner.querySelector('code')).toBe(oldCode);
    expect(owner.querySelector('a')).toBe(oldLink);
    assertStableSnapshot(probe().snapshot(), {phase: 'same-text', previousWrapperIds: before.owner.wrappers.map((item: any) => item.id)});
  });

  it('does not accept a removal without an actual repaired wrapper, duplicate wrappers or nesting', async () => {
    install(); probe().removeTranslation(); await flush();
    expect(() => assertStableSnapshot(probe().snapshot(), {phase: 'repair'})).toThrow('unexpected translation count');
    translate(probe().owner); await flush();
    assertStableSnapshot(probe().snapshot(), {phase: 'repair'});
    translate(probe().owner);
    expect(() => assertStableSnapshot(probe().snapshot(), {phase: 'duplicate'})).toThrow('unexpected translation count');
    const current = probe().owner.querySelector(wrapper); translate(current);
    expect(() => assertStableSnapshot(probe().snapshot(), {phase: 'nested'})).toThrow('nested translation wrappers');
  });

  it('tracks added source independently, requires translation and deletes only test additions at cleanup', () => {
    install(); const original = probe().owner;
    probe().append('dynamic');
    const sibling = original.nextElementSibling;
    expect(sibling.id).toBe('');
    expect(sibling.querySelector(wrapper)).toBeNull();
    expect(() => assertStableSnapshot(probe().snapshot(), {phase: 'dynamic'})).toThrow('unexpected translation count');
    translate(sibling);
    assertStableSnapshot(probe().snapshot(), {phase: 'dynamic'});
    probe().dispose();
    expect(window[key]).toBeUndefined();
    expect(original.isConnected).toBe(true);
    expect(sibling.isConnected).toBe(false);
  });

  it('rejects translation inserted inside an added paragraph protected subtree even when clean source HTML matches', () => {
    install(); probe().append('dynamic');
    const addition = probe().owner.nextElementSibling;
    translate(addition);
    translate(addition.querySelector('code')!);
    const snapshot = probe().snapshot();
    expect(snapshot.protectedIntact).toBe(true);
    expect(snapshot.additions[0].sourceHtml).toBe(snapshot.additions[0].originalHtml);
    expect(snapshot.additions[0].wrappers).toHaveLength(1);
    expect(snapshot.additions[0].allWrappers).toBe(2);
    expect(() => assertStableSnapshot(snapshot, {phase: 'dynamic-protected'})).toThrow('dynamic: protected source subtree changed');
  });

  it('rejects equivalent replacement of added protected links and additional descendant translation owners', () => {
    install(); probe().append('dynamic');
    const addition = probe().owner.nextElementSibling;
    translate(addition);
    const originalLink = addition.querySelector('a')!;
    const replacementLink = originalLink.cloneNode(true) as Element;
    originalLink.replaceWith(replacementLink);
    let snapshot = probe().snapshot();
    expect(snapshot.additions[0].sourceHtml).toBe(snapshot.additions[0].originalHtml);
    expect(() => assertStableSnapshot(snapshot, {phase: 'dynamic-identity'})).toThrow('dynamic: protected source subtree changed');
    replacementLink.replaceWith(originalLink);
    // The source snapshot strips owned artifacts; count every descendant so that stripping cannot certify an extra owner.
    const extraOwner = document.createElement('span');
    extraOwner.setAttribute('data-fr-translation-owned', 'true');
    addition.append(extraOwner); translate(extraOwner);
    snapshot = probe().snapshot();
    expect(snapshot.additions[0].protectedIntact).toBe(true);
    expect(snapshot.additions[0].sourceHtml).toBe(snapshot.additions[0].originalHtml);
    expect(snapshot.additions[0].wrappers).toHaveLength(1);
    expect(() => assertStableSnapshot(snapshot, {phase: 'dynamic-duplicate'})).toThrow('unexpected descendant translation count');
  });

  it('rejects source corruption, protected link changes and incomplete restoration anywhere on the page', () => {
    install(); const originalText = probe().owner.firstChild;
    originalText.data += ' changed';
    expect(() => assertStableSnapshot(probe().snapshot(), {phase: 'corrupt'})).toThrow('source HTML changed');
    originalText.data = source;
    probe().owner.querySelector('a').setAttribute('href', '/changed');
    expect(probe().snapshot().protectedIntact).toBe(false);
    probe().owner.querySelector('a').setAttribute('href', '/reference');
    probe().owner.querySelector(wrapper).remove();
    const unrelated = document.createElement('p'); unrelated.textContent = 'An unrelated source paragraph';
    document.body.append(unrelated); translate(unrelated);
    expect(() => assertStableSnapshot(probe().snapshot(), {phase: 'restore', translated: false})).toThrow('page translation remains');
  });

  it('records translation writes during quiet periods rather than passing a final-state-only sample', async () => {
    // Linkedom reports the observed root as childList.target for descendants;
    // supply the browser's actual target shape to validate this observer contract.
    let deliver: (records: unknown[]) => void = () => undefined;
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: (records: unknown[]) => void) {deliver = callback;}
      observe() {}
      disconnect() {}
      takeRecords() {return [];}
    });
    install(); probe().reset();
    const translation = probe().owner.querySelector(wrapper);
    translation.textContent = '被重写的测试译文';
    deliver([{type: 'childList', target: translation, addedNodes: [...translation.childNodes], removedNodes: []}]);
    expect(() => assertStableSnapshot(probe().snapshot(), {phase: 'quiet', quiet: true})).toThrow('translation changed during a quiet observation');
    probe().reset(); await flush();
    assertStableSnapshot(probe().snapshot(), {phase: 'settled', quiet: true});
    deliver([{type: 'childList', target: probe().owner.parentElement, addedNodes: [probe().owner], removedNodes: [probe().owner]}]);
    expect(() => assertStableSnapshot(probe().snapshot(), {phase: 'remounted', quiet: true})).toThrow('translation changed during a quiet observation');
  });

  it.each(['class', 'style', 'hidden'])('rejects transient %s changes on translation artifacts during a quiet period', attributeName => {
    let deliver: (records: unknown[]) => void = () => undefined;
    const observe = vi.fn();
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: (records: unknown[]) => void) {deliver = callback;}
      observe = observe;
      disconnect() {}
      takeRecords() {return [];}
    });
    install(); probe().reset();
    expect(observe).toHaveBeenCalledWith(probe().owner.parentElement, expect.objectContaining({attributes: true}));
    const translation = probe().owner.querySelector(wrapper);
    const before = translation.getAttribute(attributeName);
    translation.setAttribute(attributeName, attributeName === 'class' ? 'fluent-read-bilingual-content temporary-class' : 'temporary');
    if (before === null) translation.removeAttribute(attributeName); else translation.setAttribute(attributeName, before);
    deliver([{type: 'attributes', target: translation, attributeName}]);
    expect(() => assertStableSnapshot(probe().snapshot(), {phase: 'attribute-flicker', quiet: true})).toThrow('translation changed during a quiet observation');
  });

  it('ignores unrelated host attributes but rejects attributes on an owned non-wrapper artifact', () => {
    let deliver: (records: unknown[]) => void = () => undefined;
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: (records: unknown[]) => void) {deliver = callback;}
      observe() {}
      disconnect() {}
      takeRecords() {return [];}
    });
    install(); probe().reset();
    const owner = probe().owner;
    owner.setAttribute('title', 'Host metadata');
    deliver([{type: 'attributes', target: owner, attributeName: 'title'}]);
    assertStableSnapshot(probe().snapshot(), {phase: 'host-metadata', quiet: true});
    const artifact = document.createElement('span');
    artifact.setAttribute('data-fr-translation-owned', 'true');
    owner.appendChild(artifact);
    probe().reset();
    artifact.style.opacity = '0';
    deliver([{type: 'attributes', target: artifact, attributeName: 'style'}]);
    expect(() => assertStableSnapshot(probe().snapshot(), {phase: 'owned-attribute', quiet: true})).toThrow('translation changed during a quiet observation');
  });

  const pageDouble = (repair = true) => {
    let active = true;
    const advance = async () => {
      // 这里只模拟待测驱动器的外部页面合同，绝不作为扩展产品行为证据。
      if (active && repair) for (const node of document.querySelectorAll('article > p')) if (!node.querySelector(wrapper)) translate(node);
      await flush();
    };
    return {
      page: {
        evaluate: async (fn: (arg: any) => any, arg: any) => fn(arg),
        waitForTimeout: advance,
        waitForFunction: async (fn: (arg: any) => any, arg: any) => {
          await advance();
          if (!fn(arg)) throw new Error('Test page wait failed');
        },
        screenshot: vi.fn(async () => undefined),
      },
      toggleFull: async () => {active = !active; if (!active) document.querySelectorAll(wrapper).forEach(node => node.remove()); await advance();},
    };
  };

  it('runs every required probe and writes truthful boundaries and cleanup in its persisted report', async () => {
    const {page, toggleFull} = pageDouble();
    const report = await runStabilityProbes({page, toggleFull, selector: '#source', artifactsDir: output, observeMs: 500});
    expect(report.ok).toBe(true);
    expect(report.probeResourcesReleased).toBe(true);
    expect(report.scope).toBe('controlled-host-mutations-on-live-page');
    expect(report.contractVersion).toBe(2);
    expect(report.steps.map((step: any) => step.name)).toEqual(['quiet', 'same-text-replacement', 'removed-wrapper-repaired',
      'repair-settled', 'dynamic-append', 'restore', 'retranslate', 'stopped-session']);
    expect(report.steps.every((step: any) => step.ok)).toBe(true);
    expect(document.querySelectorAll('article > p')).toHaveLength(1);
    expect(document.querySelector(wrapper)).toBeNull();
    expect(JSON.parse(readFileSync(join(output, 'stability-probes.json'), 'utf8'))).toEqual(report);
  });

  it('persists failed evidence and releases probe resources even when the page never repairs', async () => {
    const {page, toggleFull} = pageDouble(false);
    await expect(runStabilityProbes({page, toggleFull, selector: '#source', artifactsDir: output, observeMs: 500})).rejects.toThrow('Test page wait failed');
    const report = JSON.parse(readFileSync(join(output, 'stability-probes.json'), 'utf8'));
    expect(report.ok).toBe(false);
    expect(report.error).toContain('Test page wait failed');
    expect(report.failureSnapshot.owner.wrappers).toHaveLength(0);
    expect(report.probeResourcesReleased).toBe(true);
    expect(Object.keys(window).filter(name => name.startsWith('__fluentReadStability_'))).toEqual([]);
  });

  const nativeCommentPage = (trusted = true) => {
    document.body.innerHTML = '<table><tbody><tr class="comtr" id="9224"><td><a class="togg clicky" id="9224" n="3">[–]</a><div class="comment"><div class="commtext c00"><p>A complete native discussion paragraph.</p></div></div></td></tr></tbody></table>';
    translate(document.querySelector('.commtext p')!);
    vi.stubGlobal('location', {hostname: 'news.ycombinator.com'});
    vi.stubGlobal('CSS', {escape: (value: string) => value});
    vi.stubGlobal('getComputedStyle', (node: Element) => ({display: node.classList.contains('noshow') ? 'none' : 'block'}));
    return {
      evaluate: async (fn: (arg: any) => any, arg: any) => fn(arg),
      waitForTimeout: async () => undefined,
      waitForFunction: async (fn: (arg: any) => any, arg: any) => {if (!fn(arg)) throw new Error('Native wait failed');},
      locator: (selector: string) => ({
        scrollIntoViewIfNeeded: async () => undefined,
        click: async () => {
          const control = document.querySelector(selector)!;
          const event = new window.Event('click', {bubbles: true});
          Object.defineProperty(event, 'isTrusted', {value: trusted});
          control.dispatchEvent(event);
          const row = control.closest('tr')!;
          row.classList.toggle('coll');
          row.querySelector('.comment')!.classList.toggle('noshow');
          control.textContent = row.classList.contains('coll') ? '[3 more]' : '[–]';
        },
      }),
      screenshot: vi.fn(async () => undefined),
    };
  };

  it('checks the observed native HN collapse classes, trusted input, expansion and cleanup', async () => {
    const report = await runNativeCommentToggle({page: nativeCommentPage(), artifactsDir: output});
    expect(report.ok).toBe(true);
    expect(report.steps.map((step: any) => step.name)).toEqual(['collapsed', 'expanded']);
    expect(report.steps[0].snapshot.display).toBe('none');
    expect(report.steps[1].snapshot.wrapperCount).toBe(1);
    expect(report.probeResourcesReleased).toBe(true);
    expect(document.querySelector('.comtr')!.classList.contains('coll')).toBe(false);
    expect(Object.keys(window).filter(name => name.startsWith('__fluentReadNativeComment_'))).toEqual([]);
  });

  it('focus loss after collapse prevents later expansion and finally restore input', async () => {
    let reads = 0;
    const failure = Object.assign(new Error('focus lost'), {code: 'FOCUS_SAFETY_VIOLATION'});
    await expect(runNativeCommentToggle({page: nativeCommentPage(), artifactsDir: output,
      checkFocus: () => {if (++reads >= 3) throw failure;}})).rejects.toBe(failure);
    expect(document.querySelector('.comtr')!.classList.contains('coll')).toBe(true);
    expect(JSON.parse(readFileSync(join(output, 'native-comment-toggle.json'), 'utf8')).ok).toBe(false);
  });

  it('rejects synthetic comment clicks and restores the native expansion before releasing its listener', async () => {
    await expect(runNativeCommentToggle({page: nativeCommentPage(false), artifactsDir: output})).rejects.toThrow('not a trusted click');
    const report = JSON.parse(readFileSync(join(output, 'native-comment-toggle.json'), 'utf8'));
    expect(report.ok).toBe(false);
    expect(report.probeResourcesReleased).toBe(true);
    expect(document.querySelector('.comtr')!.classList.contains('coll')).toBe(false);
  });
});

describe('Firefox stability transport and acceptance contracts', () => {
  const socketDouble = () => {
    const socket = new EventEmitter() as EventEmitter & {write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>};
    socket.write = vi.fn((_value: string, callback: (error?: Error) => void) => callback());
    socket.destroy = vi.fn(() => socket.emit('close'));
    return socket;
  };
  const packet = (value: unknown) => {
    const json = JSON.stringify(value);
    return Buffer.from(`${Buffer.byteLength(json)}:${json}`);
  };

  it('pairs out-of-order Unicode responses and supports split and coalesced protocol frames', async () => {
    const socket = socketDouble(), client = new MarionetteClient(socket, 1000);
    const first = client.send('First'), second = client.send('Second');
    const response = Buffer.concat([packet({applicationType: 'gecko', marionetteProtocol: 3}), packet([1, 2, null, {value: '译文'}]), packet([1, 1, null, {value: 'first'}])]);
    socket.emit('data', response.subarray(0, 7)); socket.emit('data', response.subarray(7, response.length - 2));
    socket.emit('data', response.subarray(response.length - 2));
    await expect(first).resolves.toEqual({value: 'first'});
    await expect(second).resolves.toEqual({value: '译文'});
    expect(client.greeting.marionetteProtocol).toBe(3);
    expect(client.pending.size).toBe(0); client.close();
  });

  it('bounds unresponsive commands and clears all pending operations when the transport closes', async () => {
    const socket = socketDouble(), client = new MarionetteClient(socket, 10);
    await expect(client.send('NeverReplies')).rejects.toThrow('timed out: NeverReplies');
    expect(client.pending.size).toBe(0);
    const pending = client.send('InFlight');
    socket.emit('close');
    await expect(pending).rejects.toThrow('transport closed');
    expect(client.pending.size).toBe(0);
    await expect(client.send('AfterClose')).rejects.toThrow('transport is closed');
  });

  it('rejects malformed framing and retains the actual Firefox command error', async () => {
    const socket = socketDouble(), client = new MarionetteClient(socket, 1000);
    const failed = client.send('BadCommand');
    socket.emit('data', packet([1, 1, {error: 'invalid argument', message: 'wrong window'}, null]));
    await expect(failed).rejects.toThrow('BadCommand');
    const malformed = client.send('BadFrame'); socket.emit('data', Buffer.from('abc:invalid'));
    await expect(malformed).rejects.toThrow('Malformed Marionette frame');
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('refuses foreground/headless fallback and unbounded deadlines', () => {
    expect(() => parseFirefoxArgs(['--headed'])).toThrow('Only visible background');
    expect(() => parseFirefoxArgs(['--headless'])).toThrow('Only visible background');
    expect(() => parseFirefoxArgs(['--timeout', '0'])).toThrow('timeout must');
    expect(parseFirefoxArgs(['--extension-dir', '/tmp/build', '--artifacts-dir', '/tmp/evidence', '--live']).live).toBe(true);
  });

  it('requires per-source completion, exact restoration, protected content and trusted shortcuts', () => {
    const state = {blocks: Array.from({length: 3}, () => ({connected: true, original: 'source', current: 'source', translations: ['译文'], pending: 0})),
      protectedIntact: true, protectedCount: 1, nested: 0, duplicateParents: 0, pending: 0, wrappers: 3, keys: [{trusted: true}]};
    expect(() => assertPageSnapshot(state, true, 'translated')).not.toThrow();
    const missing = structuredClone(state); missing.blocks[1].translations = [];
    expect(() => assertPageSnapshot(missing, true, 'missing')).toThrow('exactly one translation');
    const untrusted = structuredClone(state); untrusted.keys[0].trusted = false;
    expect(() => assertPageSnapshot(untrusted, true, 'untrusted')).toThrow('trusted full-page shortcut');
    const restored = structuredClone(state); restored.blocks.forEach(block => {block.translations = [];}); restored.wrappers = 1;
    expect(() => assertPageSnapshot(restored, false, 'restore')).toThrow('page wrappers remain');
  });
});

describe('controlled provider attribution', () => {
  const {installControlledProvider} = require('../scripts/site-translation/controlled-provider.cjs');
  const transportGlobal = globalThis as typeof globalThis & {__frCompatibilityTransport?: {requests: number; texts: number; active: number}};
  const originalFetch = globalThis.fetch;
  afterEach(() => {globalThis.fetch = originalFetch; delete transportGlobal.__frCompatibilityTransport;});
  async function setup(initialOtherWorkers: Array<{url: () => string; evaluate: (fn: (value?: boolean) => unknown, value?: boolean) => unknown}> = []) {
    const worker = {url: () => 'chrome-extension://isolated/background.js', evaluate: async (fn: (value?: boolean) => unknown, value?: boolean) => fn(value)};
    let workers = [...initialOtherWorkers, worker];
    const context = Object.assign(new EventEmitter(), {serviceWorkers: () => workers});
    const popup = {goto: vi.fn(), evaluate: vi.fn().mockResolvedValue({success: true}), close: vi.fn()};
    const api = await installControlledProvider(context, async () => popup, 1000);
    return {api, context, worker, setWorkers: (next: typeof workers) => {workers = next;}};
  }
  it('requires actual completed controlled response evidence, leaving unrelated network reads alone', async () => {
    const fetchOther = vi.fn().mockResolvedValue(new Response('public page'));
    globalThis.fetch = fetchOther;
    const {api, context} = await setup();
    await expect(api.snapshot()).rejects.toThrow('no completed request evidence');
    const result = await fetch('https://edge.microsoft.com/translate/translatetext', {method: 'POST', body: JSON.stringify(['Reading source'])});
    expect(await result.json()).toEqual([{translations: [{text: encodeControlledTranslation('Reading source')}]}]);
    await expect(api.snapshot()).resolves.toMatchObject({mode: 'controlled-microsoft-response', workerCount: 1, requests: 1, texts: 1, active: 0});
    expect(await (await fetch('https://example.test/public')).text()).toBe('public page');
    expect(fetchOther).toHaveBeenCalledOnce();
    api.dispose(); expect(context.listenerCount('serviceworker')).toBe(0);
  });
  it('never injects website or other extension workers and attributes responses only to the selected extension', async () => {
    const website = {url: () => 'https://www.youtube.com/sw.js', evaluate: vi.fn()};
    const otherExtension = {url: () => 'chrome-extension://unrelated/background.js', evaluate: vi.fn()};
    const {api, context, worker, setWorkers} = await setup([website]);
    try {
      context.emit('serviceworker', website);
      context.emit('serviceworker', otherExtension);
      setWorkers([website, otherExtension, worker]);
      await fetch('https://edge.microsoft.com/translate/translatetext', {method: 'POST', body: JSON.stringify(['Reading source'])});
      await expect(api.snapshot()).resolves.toMatchObject({workerSelection: 'exact-extension-origin', workerCount: 1, requests: 1});
      expect(website.evaluate).not.toHaveBeenCalled();
      expect(otherExtension.evaluate).not.toHaveBeenCalled();
    } finally {api.dispose();}
    expect(context.listenerCount('serviceworker')).toBe(0);
  });
  it('continues to reject replacement workers of the same extension even if transport injection succeeds', async () => {
    const {api, context, worker, setWorkers} = await setup();
    try {
      await fetch('https://edge.microsoft.com/translate/translatetext', {method: 'POST', body: JSON.stringify(['Reading source'])});
      const replacement = {url: worker.url, evaluate: worker.evaluate};
      setWorkers([replacement]);
      context.emit('serviceworker', replacement);
      await expect(api.snapshot()).rejects.toThrow('changed or disappeared');
    } finally {api.dispose();}
  });
  it('passes the real Microsoft transport and language validator for long English prose without echoing the source', async () => {
    const source = 'The researchers discovered that modern translation systems require careful evaluation across different websites because unexpected changes in document structure can interrupt the reading experience and prevent readers from understanding important information.';
    expect(isClearlyWrongLanguageResponse(source, `测试译文：${source}`, 'zh-Hans')).toBe(true);
    const {api} = await setup();
    try {
      const [translated] = await translateMicrosoftTextsWithTransport(fetch, [source], 'en', 'zh-Hans');
      expect(isClearlyWrongLanguageResponse(source, translated!, 'zh-Hans')).toBe(false);
      expect(isLikelyUntranslatedResponse(source, translated!, 'zh-Hans')).toBe(false);
      expect(translated).not.toContain(source);
    } finally {api.dispose();}
  });
  it('round-trips Unicode and complete concatenated slots, rejecting echoes, missing slots, swapped sources and extra text', () => {
    for (const source of ['Reading source', 'Café researchers — 中文与 emoji 🦊', 'A complete source with 123 numeric values.']) {
      const encoded = encodeControlledTranslation(source);
      expect(decodeControlledTranslationText(encoded)).toBe(source);
      expect(isControlledTranslationForSource(encoded, source)).toBe(true);
      expect(isControlledTranslationForSource(`测试译文：${source}`, source)).toBe(false);
      expect(isControlledTranslationForSource(encoded, `${source} missing`)).toBe(false);
      expect(isControlledTranslationForSource(`${encoded} foreign residue`, source)).toBe(false);
      expect(isControlledTranslationForSource(encoded + encodeControlledTranslation('another source'), source)).toBe(false);
    }
    const parts = ['Public source ', 'and another paragraph'];
    const translated = parts.map(encodeControlledTranslation).join('');
    expect(isControlledTranslationForSource(translated, parts.join(''), parts)).toBe(true);
    expect(isControlledTranslationForSource(encodeControlledTranslation(parts[0]), parts.join(''), parts)).toBe(false);
    expect(isControlledTranslationForSource(parts.toReversed().map(encodeControlledTranslation).join(''), parts.join(''), parts)).toBe(false);
    expect(decodeControlledTranslationText('测试译文：仿')).toBeNull(); // Invalid standalone UTF-8 byte.
    expect(decodeControlledTranslationText('测试译文：')).toBeNull();
    expect(encodeControlledTranslation('  \n')).toBe('  \n');
    expect(() => encodeControlledTranslation(null)).toThrow('requires a string');
  });
  it('preserves inline slot delimiters and literal entities through the real Microsoft escaping boundary', async () => {
    const {api} = await setup();
    try {
      const source = 'A readable paragraph with &amp; &copy; &#169; &#xA9; "quoted text" & symbols <g1>inside text</g1> ___FLUENTREAD_test_0_BEGIN___another readable slot___FLUENTREAD_test_0_END___.';
      const [translated] = await translateMicrosoftTextsWithTransport(fetch, [source], 'en', 'zh-Hans');
      for (const token of ['&amp;', '&copy;', '&#169;', '&#xA9;', '___FLUENTREAD_test_0_BEGIN___', '___FLUENTREAD_test_0_END___']) {
        expect(translated!.split(token)).toHaveLength(2);
      }
      expect(translated).not.toContain('<g1>');
      expect(translated).not.toContain('</g1>');
      // The direct encoder still preserves structural tags; Microsoft receives
      // escaped plain text and encodes the literal tag-name characters instead.
      expect(encodeControlledTranslation('<g1>')).toBe('测试译文：<g1>');
      expect(translated).not.toContain('readable');
      expect(isClearlyWrongLanguageResponse(source, translated!, 'zh-Hans')).toBe(false);
      const [entityText] = await translateMicrosoftTextsWithTransport(fetch, ['Reading &copy; and & quotation "example"'], 'en', 'zh-Hans');
      expect(isControlledTranslationForSource(entityText, 'Reading &copy; and & quotation "example"')).toBe(true);
      const requested = new Request('https://edge.microsoft.com/translate/translatetext', {method: 'POST', body: JSON.stringify(['Request body'])});
      expect(await (await fetch(requested)).json()).toEqual([{translations: [{text: encodeControlledTranslation('Request body')}]}]);
      await expect(fetch('https://edge.microsoft.com/translate/translatetext', {method: 'POST', body: '{}'})).rejects.toThrow('text array');
      await expect(api.snapshot()).resolves.toMatchObject({protocol: 'utf8-han-v1', active: 0});
    } finally {api.dispose();}
  });
  it('encodes escaped literal angle-bracket text through Microsoft and preserves the protected code skeleton', async () => {
    const {api} = await setup();
    const {document, window} = parseHTML('<html><body><table><tr><td><code>Que coche de</code> &lt;insert-profane-word&gt;</td></tr></table></body></html>');
    vi.stubGlobal('document', document);vi.stubGlobal('Node', window.Node);
    try {
      const owner = document.querySelector('td')!;
      const snapshot = createTranslationSourceSnapshot(owner);
      const translations = await translateMicrosoftTextsWithTransport(fetch, snapshot.slots.map(slot => slot.source), 'en', 'zh-Hans');
      const wrapper = appendBilingualTranslation(owner, applyTranslationsToSnapshot(snapshot, translations), {sourceSkeleton: snapshot.clone});
      const evidence = readControlledPageEvidenceInPage();
      expect(assertControlledPageEvidence(evidence, 'learn-placeholder')).toMatchObject({owners: 1});
      expect(evidence[0].output).not.toContain('insert-profane-word');
      expect(decodeControlledTranslationText(evidence[0].output)).toBe(' <insert-profane-word>');
      const genuine = wrapper.innerHTML;
      wrapper.innerHTML = '<code>Que coche de</code> 测试译文：&lt;insert-profane-word&gt;';
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'unencoded-echo')).toThrow('complete source');
      wrapper.innerHTML = genuine;wrapper.querySelector('code')!.textContent = 'changed';
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'changed-code')).toThrow('complete source');
      wrapper.innerHTML = genuine;wrapper.append(' extra ordinary prose');
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'extra-prose')).toThrow('complete source');
    } finally {api.dispose();vi.unstubAllGlobals();}
  });
  it('encodes complete mixed literal text while preserving literal entities and rejecting changed or missing output', async () => {
    const {api} = await setup();
    try {
      for (const source of ['What a <insert-profane-word> car', '<profanity> <insert-profane-word> </profanity>', 'Read &lt; and &copy; literally.', 'Café 🦊 <insert-profane-word> 中文']) {
        const [output] = await translateMicrosoftTextsWithTransport(fetch, [source], 'en', 'zh-Hans');
        expect(isControlledTranslationForSource(output, source)).toBe(true);
        expect(isControlledTranslationForSource(`测试译文：${source}`, source)).toBe(false);
        expect(isControlledTranslationForSource(output, `${source} missing`)).toBe(false);
        expect(isControlledTranslationForSource(`${output} extra prose`, source)).toBe(false);
      }
      const source = 'First <alpha> then <beta>.';
      const [output] = await translateMicrosoftTextsWithTransport(fetch, [source], 'en', 'zh-Hans');
      const alpha = encodeControlledTranslation('alpha').replace('测试译文：', '');
      const beta = encodeControlledTranslation('beta').replace('测试译文：', '');
      expect(output).toContain(alpha);expect(output).toContain(beta);
      expect(isControlledTranslationForSource(output!.replace(alpha, ''), source)).toBe(false);
      expect(isControlledTranslationForSource(output!.replace(alpha, beta), source)).toBe(false);
      expect(isControlledTranslationForSource(output!.replace(alpha, '__SWAP__').replace(beta, alpha).replace('__SWAP__', beta), source)).toBe(false);
      const parts = ['First <alpha>', ' then <beta>.'];
      const outputs = await translateMicrosoftTextsWithTransport(fetch, parts, 'en', 'zh-Hans');
      expect(isControlledTranslationForSource(outputs.join(''), parts.join(''), parts)).toBe(true);
      expect(isControlledTranslationForSource(outputs[0], parts.join(''), parts)).toBe(false);
      expect(isControlledTranslationForSource(outputs.toReversed().join(''), parts.join(''), parts)).toBe(false);
    } finally {api.dispose();}
  });
  it('preserves real glossary and literal-symbol placeholders through Microsoft and restores them exactly once', async () => {
    const original = '© roadmap.sh Terms and Privacy. Read the complete documentation.';
    const packet = protectGlossaryText(original, [], 'controlled-site', [], undefined, [{start: 0, end: 1}]);
    expect(packet.tokens).toHaveLength(1);
    const {api} = await setup();
    try {
      const [translated] = await translateMicrosoftTextsWithTransport(fetch, [packet.text], 'en', 'zh-Hans');
      const restored = packet.restore(translated);
      expect(isControlledTranslationForSource(restored, original)).toBe(true);
      expect(isClearlyWrongLanguageResponse(original, restored, 'zh-Hans')).toBe(false);
      expect(() => packet.restore(translated!.replace(packet.tokens[0]!, ''))).toThrow('术语');
      expect(() => packet.restore(translated + packet.tokens[0]!)).toThrow('术语');
      expect(() => packet.restore(translated!.replace(packet.tokens[0]!, '__FRTERM_wrong_0__'))).toThrow('术语');
    } finally {api.dispose();}
  });
  it('checks real rendered formula skeletons using presentation text without double-counting nested MathML annotations', () => {
    const {document, window} = parseHTML('<html><body><p>Read the algorithm <math class="ltx_Math"><semantics><mrow><mn>1</mn><mo>−</mo><mi>b</mi><mi>i</mi><mi>t</mi></mrow><annotation encoding="application/x-tex">1-bit</annotation></semantics></math> and <span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span><span class="katex-html" aria-hidden="true"><span>x</span></span></span> carefully.</p></body></html>');
    vi.stubGlobal('document', document);vi.stubGlobal('Node', window.Node);
    try {
      const owner = document.querySelector('p')!;
      const snapshot = createTranslationSourceSnapshot(owner);
      const html = applyTranslationsToSnapshot(snapshot, snapshot.slots.map(slot => encodeControlledTranslation(slot.source)));
      const translation = appendBilingualTranslation(owner, html, {sourceSkeleton: snapshot.clone});
      expect(translation.querySelector('annotation,.katex-mathml')).toBeNull();
      const evidence = readControlledPageEvidenceInPage();
      expect(evidence[0].protectedMatches).toHaveLength(2);
      expect(assertControlledPageEvidence(evidence, 'real-formula')).toMatchObject({owners: 1});
      translation.querySelector('math mi')!.textContent = 'wrong';
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'changed-formula')).toThrow('complete source');
      translation.querySelector('math')!.remove();
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'missing-formula')).toThrow('complete source');
    } finally {vi.unstubAllGlobals();}
  });
  it('exempts only observed hidden decoration, keeping visible or unreadable-style omissions as failures', () => {
    const {document, window} = parseHTML('<html><body><h1>Energy-Efficient Naming in Beeping Networks<span class="journal-decoration">Volume: 178 Issue: 1</span></h1></body></html>');
    let hidden = true, unavailable = false;
    Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: (node: Element) => {
      if (unavailable) throw new Error('style unavailable');
      return {display: 'inline', visibility: node.classList.contains('journal-decoration') && hidden ? 'hidden' : 'visible', fontFamily: 'Arial'};
    }});
    vi.stubGlobal('document', document);vi.stubGlobal('Node', window.Node);
    try {
      const owner = document.querySelector('h1')!;
      const snapshot = createTranslationSourceSnapshot(owner);
      appendBilingualTranslation(owner, applyTranslationsToSnapshot(snapshot, snapshot.slots.map(slot => encodeControlledTranslation(slot.source))), {sourceSkeleton: snapshot.clone});
      const evidence = readControlledPageEvidenceInPage();
      expect(evidence[0].omittedParts).toContainEqual({tag: 'span', text: 'Volume: 178 Issue: 1', reason: 'computed-hidden'});
      expect(assertControlledPageEvidence(evidence, 'computed-hidden-decoration')).toMatchObject({owners: 1});
      hidden = false;
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'visible-decoration')).toThrow('complete source');
      hidden = true;unavailable = true;
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'missing-style-evidence')).toThrow('complete source');
    } finally {vi.unstubAllGlobals();}
  });
  it.each(['matching-rule', 'ordinary-span', 'other-site', 'other-page', 'other-container', 'missing-prose'] as const)(
    'matches the production Bing date omission without exempting other visible source: %s', variant => {
      const url = 'https://www.bing.com/search?q=machine+translation';
      const {document, window} = parseHTML('<html><body><ul id="b_results"><li class="b_algo"><div class="b_caption"><p><span class="news_dt">Nov 26, 2024</span>&nbsp;· Machine translation research explains how multilingual systems preserve useful reading context across different websites.</p></div></li></ul></body></html>');
      Object.defineProperty(document, 'baseURI', {value: url});
      vi.stubGlobal('document', document);vi.stubGlobal('Node', window.Node);
      vi.stubGlobal('location', {hostname: 'www.bing.com', pathname: '/search'});
      try {
        const rule = websiteRules.find(item => item.id === 'bing-search')!;
        expect(rule.match).toMatchObject({hosts: ['www.bing.com'], paths: ['/search']});
        expect(rule.omit).toContain('#b_results > .b_algo .b_caption .news_dt');
        const core = createTranslationCore({url: new URL(url)}), owner = document.querySelector('p')!;
        const snapshot = createTranslationSourceSnapshot(owner, core.shouldStayOriginal, undefined, undefined, core.shouldOmitFromTranslation);
        expect(snapshot.slots.map(slot => slot.source).join(' ')).not.toContain('Nov 26, 2024');
        expect(snapshot.slots.map(slot => slot.source).join(' ')).toContain('Machine translation research');
        const output = appendBilingualTranslation(owner, applyTranslationsToSnapshot(snapshot,
          snapshot.slots.map(slot => encodeControlledTranslation(slot.source))), {sourceSkeleton: snapshot.clone});
        expect(output.textContent).not.toContain('Nov 26, 2024');
        if (variant === 'ordinary-span') owner.querySelector('.news_dt')!.removeAttribute('class');
        if (variant === 'other-site') vi.stubGlobal('location', {hostname: 'ordinary.example', pathname: '/search'});
        if (variant === 'other-page') vi.stubGlobal('location', {hostname: 'www.bing.com', pathname: '/images/search'});
        if (variant === 'other-container') document.querySelector('.b_algo')!.className = 'b_ad';
        if (variant === 'missing-prose') output.textContent = encodeControlledTranslation('Machine translation research');
        const evidence = readControlledPageEvidenceInPage();
        if (variant === 'matching-rule') {
          expect(evidence[0].omittedParts).toContainEqual({tag: 'span', text: 'Nov 26, 2024', reason: 'site-rule-omission'});
          expect(assertControlledPageEvidence(evidence, 'bing-production-date-omission')).toMatchObject({owners: 1});
        } else expect(() => assertControlledPageEvidence(evidence, variant)).toThrow('complete source');
      } finally {vi.unstubAllGlobals();}
    });
  it.each([
    {clip: 'rect(0px, 0px, 0px, 0px)'},
    {clip: 'rect(1px 1px 1px 1px)'},
    {clip: 'auto', clipPath: 'inset(50%)'},
  ])('projects observed clipped accessibility boxes exactly as the real snapshot does: %j', clipping => {
    const {document, window} = parseHTML('<html><body><li><a href="#note"><span class="cite-accessibility-label">Jump up to: </span></a> U.S. nominal and PPP-adjusted GDP are the same.</li></body></html>');
    const hiddenStyle = {display: 'inline', visibility: 'visible', fontFamily: 'Arial', position: 'absolute', overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden', width: '1px', height: '1px', clipPath: 'none', ...clipping};
    let style: Record<string, string> = {...hiddenStyle}, unavailable = false;
    Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: (node: Element) => {
      if (unavailable) throw new Error('Style unavailable');
      return node.classList.contains('cite-accessibility-label') ? style : {display: 'block', visibility: 'visible', fontFamily: 'Arial'};
    }});
    vi.stubGlobal('document', document);vi.stubGlobal('Node', window.Node);
    try {
      const owner = document.querySelector('li')!, snapshot = createTranslationSourceSnapshot(owner);
      expect(snapshot.slots.map(slot => slot.source)).toEqual(['U.S. nominal and PPP-adjusted GDP are the same.']);
      appendBilingualTranslation(owner, applyTranslationsToSnapshot(snapshot, snapshot.slots.map(slot => encodeControlledTranslation(slot.source))), {sourceSkeleton: snapshot.clone});
      const evidence = readControlledPageEvidenceInPage();expect(evidence[0].omittedParts).toContainEqual({tag: 'span', text: 'Jump up to: ', reason: 'computed-clipped-accessibility'});
      expect(assertControlledPageEvidence(evidence, 'clipped-accessibility')).toMatchObject({owners: 1});
      for (const changed of [{position: 'static'}, {overflow: 'visible', overflowX: 'visible', overflowY: 'visible'}, {clip: 'auto', clipPath: 'none'}, {width: '200px'}, {height: '20px'}, {clip: 'rect(0px 10px 0px 10px)', clipPath: 'none'}]) {
        style = {...hiddenStyle, ...changed};
        expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'visible-or-partial-clip')).toThrow('complete source');
      }
      style = {...hiddenStyle};unavailable = true;
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'unobserved-clip')).toThrow('complete source');
    } finally {vi.unstubAllGlobals();}
  });
  it('requires exact unchanged link identifier text and href and never exempts ordinary linked prose', () => {
    const {document} = parseHTML('<html><body><p>Read more at <a href="https://hummingbot.org">hummingbot.org</a>.</p></body></html>');
    vi.stubGlobal('document', document);
    try {
      const owner = document.querySelector('p')!, link = owner.querySelector('a')!;
      const output = document.createElement('span');output.className = 'fluent-read-bilingual-content';
      output.innerHTML = encodeControlledTranslation('Read more at ') + link.outerHTML + encodeControlledTranslation('.');owner.append(output);
      expect(assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'identifier')).toMatchObject({owners: 1});
      output.querySelector('a')!.setAttribute('href', 'https://wrong.example');
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'wrong-href')).toThrow('complete source');
      output.querySelector('a')!.setAttribute('href', 'https://hummingbot.org');
      link.textContent = 'Read the full documentation';output.querySelector('a')!.textContent = link.textContent;
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'untranslated-prose-link')).toThrow('complete source');
    } finally {vi.unstubAllGlobals();}
  });
  it('attributes every rendered owner after removing paired protected skeletons, and rejects a missing or unrelated owner', () => {
    const {document} = parseHTML('<html><body><p>First readable <a href="/source">linked source</a> <code>protected()</code> and final text.<span hidden>Hidden source</span></p><p>Second complete paragraph</p></body></html>');
    vi.stubGlobal('document', document);
    try {
      const owners = document.querySelectorAll('p');
      const first = document.createElement('span'); first.className = 'fluent-read-bilingual-content';
      first.innerHTML = encodeControlledTranslation('First readable ') + '<a href="/source">' + encodeControlledTranslation('linked source') + '</a> <code>protected()</code> ' + encodeControlledTranslation('and final text.');
      owners[0]!.append(first);
      const second = document.createElement('span'); second.className = 'fluent-read-bilingual-content'; second.textContent = encodeControlledTranslation('Second complete paragraph'); owners[1]!.append(second);
      const evidence = readControlledPageEvidenceInPage();
      expect(assertControlledPageEvidence(evidence, 'complete')).toMatchObject({owners: 2, completeSourceMatched: true});
      expect(() => assertControlledPageEvidence([], 'missing')).toThrow('owners missing');
      second.textContent = encodeControlledTranslation('An unrelated paragraph');
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'wrong-source')).toThrow('complete source');
      second.textContent = encodeControlledTranslation('Second complete paragraph');
      first.querySelector('a')!.textContent = '';
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'missing-slot')).toThrow('complete source');
    } finally {vi.unstubAllGlobals();}
  });
  it('accepts an exact preserved time node only when the source DOM establishes its protected role', () => {
    const {document} = parseHTML('<html><body><p><a>Bistutu</a> opened <relative-time role="timer">Oct 23, 2026</relative-time></p></body></html>');
    vi.stubGlobal('document', document);
    try {
      const source = document.querySelector('p')!, time = source.querySelector('relative-time')!;
      const wrapper = document.createElement('span'); wrapper.className = 'fluent-read-bilingual-content';
      const date = document.createTextNode('Oct 23, 2026');
      wrapper.append(document.createTextNode(encodeControlledTranslation('Bistutu') + ' ' + encodeControlledTranslation('opened') + ' '), date);source.append(wrapper);
      expect(assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'protected-timer')).toMatchObject({owners: 1});
      time.removeAttribute('role');
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'ordinary-prose')).toThrow('complete source');
      time.setAttribute('role', 'timer');date.nodeValue = 'Oct 22, 2026';
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'wrong-time')).toThrow('complete source');
      date.nodeValue = 'Oct 23, 2026 extra untranslated prose';
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'time-prefix-only')).toThrow('complete source');
      date.remove();
      expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'missing-time')).toThrow('complete source');
    } finally {vi.unstubAllGlobals();}
  });
  it.each(['relative-time', 'time-ago', 'local-time'])('recognizes GitHub %s through the actual adapter, without exempting dates on ordinary sites', tag => {
    const {document, window} = parseHTML(`<html><body><p>reviewed <${tag} datetime="2026-08-15T00:00:00Z">Aug 15, 2026</${tag}></p></body></html>`);
    vi.stubGlobal('document', document);vi.stubGlobal('Node', window.Node);vi.stubGlobal('location', {hostname:'github.com'});
    try {
      const core = createTranslationCore({url:new URL('https://github.com/Bistutu/FluentRead/pull/999')});
      const owner = document.querySelector('p')!;
      const snapshot = createTranslationSourceSnapshot(owner, core.shouldStayOriginal, undefined, undefined, core.shouldOmitFromTranslation);
      expect(snapshot.slots.map(slot=>slot.source)).toEqual(['reviewed']);
      appendBilingualTranslation(owner, applyTranslationsToSnapshot(snapshot,snapshot.slots.map(slot=>encodeControlledTranslation(slot.source))), {sourceSkeleton:snapshot.clone});
      expect(assertControlledPageEvidence(readControlledPageEvidenceInPage(),'github-time')).toMatchObject({owners:1});
      vi.stubGlobal('location',{hostname:'ordinary.example'});
      expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'ordinary-site-time')).toThrow('complete source');
      vi.stubGlobal('location',{hostname:'github.com'});const original=owner.querySelector(tag)!;const prose=document.createElement('span');prose.textContent=original.textContent;original.replaceWith(prose);
      expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'ordinary-date-prose')).toThrow('complete source');
    } finally {vi.unstubAllGlobals();}
  });
  it('pairs an unwrapped GitHub time Text only within its original link target', () => {
    const url='https://github.com/Bistutu/FluentRead/pull/999';
    const {document,window}=parseHTML('<html><body><p>reviewed <span><a href="#pullrequestreview-4943999925"><relative-time datetime="2026-08-15T00:00:00Z">Aug 15, 2026</relative-time></a></span></p></body></html>');
    Object.defineProperty(document,'baseURI',{value:url});vi.stubGlobal('document',document);vi.stubGlobal('Node',window.Node);vi.stubGlobal('location',{hostname:'github.com'});
    try{
      const core=createTranslationCore({url:new URL(url)}),owner=document.querySelector('p')!;
      const snapshot=createTranslationSourceSnapshot(owner,core.shouldStayOriginal,undefined,undefined,core.shouldOmitFromTranslation);
      const output=appendBilingualTranslation(owner,applyTranslationsToSnapshot(snapshot,snapshot.slots.map(slot=>encodeControlledTranslation(slot.source))),{sourceSkeleton:snapshot.clone});
      expect(output.querySelector('relative-time')).toBeNull();expect(assertControlledPageEvidence(readControlledPageEvidenceInPage(),'linked-github-time')).toMatchObject({owners:1});
      const link=output.querySelector('a')!,href=link.getAttribute('href')!;
      link.setAttribute('href','#wrong-review');expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'changed-time-reference')).toThrow('complete source');
      link.removeAttribute('href');expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'missing-time-reference')).toThrow('complete source');
      link.setAttribute('href',href);link.textContent='Aug 14, 2026';expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'changed-linked-time')).toThrow('complete source');
      link.textContent='Aug 15, 2026 extra';expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'time-substring')).toThrow('complete source');
    }finally{vi.unstubAllGlobals()}
  });
  describe('CNN protected metadata literals', () => {
    const selectors = ['.byline__name', '.timestamp__time-since', 'figcaption.image_large-elevate__credit', 'figcaption.image-elevate__credit'];
    const literals = ['Author Alpha', 'Oct 25, 2026', 'Nova Image Archive', 'Survey Team Collection'];
    const path = '/2026/10/25/science/original-authored-fixture';
    function fixture(url: string) {
      const {document, window} = parseHTML(`<html><body>
        <div id="byline-owner">By <span class="byline__name">Author Alpha</span><span class="timestamp__time-since">Oct 25, 2026</span></div>
        <article><div id="caption-owner" class="image_large-elevate__metadata"><div itemprop="caption" class="image_large-elevate__caption">The blue cloud surrounds a small group of bright stars.</div><figcaption class="image_large-elevate__credit">Nova Image Archive</figcaption></div>
        <div id="related-caption-owner" class="image-elevate__metadata"><div itemprop="caption" class="image-elevate__caption">A related image shows a wider field around the cloud.</div><figcaption class="image-elevate__credit">Survey Team Collection</figcaption></div></article>
        </body></html>`);
      Object.defineProperty(document, 'baseURI', {value: url});
      vi.stubGlobal('document', document);vi.stubGlobal('Node', window.Node);vi.stubGlobal('location', new URL(url));
      const core = createTranslationCore({url: new URL(url)});
      const rendered = ['#byline-owner', '#caption-owner', '#related-caption-owner'].map(selector => {
        const owner = document.querySelector<HTMLElement>(selector)!;
        const snapshot = createTranslationSourceSnapshot(owner, core.shouldStayOriginal, undefined, undefined, core.shouldOmitFromTranslation);
        const output = appendBilingualTranslation(owner, applyTranslationsToSnapshot(snapshot,
          snapshot.slots.map(slot => encodeControlledTranslation(slot.source))), {sourceSkeleton: snapshot.clone});
        return {owner, snapshot, output};
      });
      return {document, core, rendered};
    }
    function literalNode(output: Element, text: string) {
      const walk = output.ownerDocument.createTreeWalker(output, 4);
      while (walk.nextNode()) if (walk.currentNode.nodeValue === text) return walk.currentNode as Text;
      throw new Error(`Missing expected literal Text node: ${text}`);
    }
    it.each(['https://www.cnn.com', 'http://www.cnn.com', 'https://edition.cnn.com', 'http://edition.cnn.com'])(
      'matches the actual CNN protection declaration and complete caption source at %s', origin => {
        try {
          const {document, core, rendered} = fixture(origin + path);
          const rule = websiteRules.find(item => item.id === 'cnn-news')!;
          expect(rule.match).toMatchObject({hosts: ['www.cnn.com', 'edition.cnn.com'], paths: ['/20*/*']});
          expect(rule.protect).toEqual(selectors);
          selectors.forEach(selector => expect(core.shouldStayOriginal(document.querySelector(selector)!), selector).toBe(true));
          const source = rendered.flatMap(item => item.snapshot.slots.map(slot => slot.source)).join(' ');
          expect(source).toContain('The blue cloud surrounds');
          expect(source).toContain('A related image shows');
          for (const literal of literals) expect(source).not.toContain(literal);
          const evidence = readControlledPageEvidenceInPage();
          expect(evidence.flatMap((row: any) => row.protectedMatches)).toEqual(literals.map(text =>
            expect.objectContaining({text, matched: true})));
          expect(evidence.flatMap((row: any) => row.omittedParts)).toEqual([]);
          expect(assertControlledPageEvidence(evidence, 'cnn-protected-literals')).toMatchObject({owners: 3});
        } finally {vi.unstubAllGlobals();}
      });
    it.each(['damaged-credit', 'missing-credit', 'ordinary-span', 'near-name-class', 'other-host', 'lookalike-host',
      'other-path', 'missing-path-separator', 'other-protocol', 'missing-caption'])(
      'keeps CNN complete-source validation strict for %s', variant => {
        try {
          const url = 'https://www.cnn.com' + path;
          const {document, rendered} = fixture(url);
          const caption = rendered[1]!;
          if (variant === 'damaged-credit') literalNode(caption.output, literals[2]!).nodeValue = 'Changed image archive';
          if (variant === 'missing-credit') literalNode(caption.output, literals[2]!).remove();
          if (variant === 'ordinary-span') {
            const original = caption.owner.querySelector('figcaption')!, plain = document.createElement('span');
            plain.textContent = original.textContent;original.replaceWith(plain);
          }
          if (variant === 'near-name-class') caption.owner.querySelector('figcaption')!.className = 'image_credit';
          if (variant === 'other-host') vi.stubGlobal('location', new URL('https://ordinary.example' + path));
          if (variant === 'lookalike-host') vi.stubGlobal('location', new URL('https://www.cnn.com.evil.example' + path));
          if (variant === 'other-path') vi.stubGlobal('location', new URL('https://www.cnn.com/style/article'));
          if (variant === 'missing-path-separator') vi.stubGlobal('location', new URL('https://www.cnn.com/2026'));
          if (variant === 'other-protocol') vi.stubGlobal('location', new URL('ftp://www.cnn.com' + path));
          if (variant === 'missing-caption') literalNode(caption.output,
            encodeControlledTranslation(caption.snapshot.slots[0]!.source)).remove();
          expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), variant)).toThrow('complete source');
        } finally {vi.unstubAllGlobals();}
      });
  });
  it('matches Ubuntu manpage command tokens using the actual site adapter and retains the surrounding linked prose', () => {
    const path='/manpages/noble/man8/apt.8.html';
    const {document,window}=parseHTML('<html><body><main id="manpage-content"><section class="Sh"><p class="Pp"><b>apt</b> provides a high-level commandline interface for the\n    package management system. It is intended for interactive usage compared to <a href="/manpages/noble/man8/apt-get.8.html"><b>apt-get</b>(8)</a> and\n    <a href="/manpages/noble/man8/apt-cache.8.html"><b>apt-cache</b>(8)</a>.</p></section></main></body></html>');
    Object.defineProperty(document,'baseURI',{value:'https://manpages.ubuntu.com'+path});
    vi.stubGlobal('document',document);vi.stubGlobal('Node',window.Node);vi.stubGlobal('location',{hostname:'manpages.ubuntu.com',pathname:path});
    try{
      const core=createTranslationCore({url:new URL('https://manpages.ubuntu.com'+path)}),owner=document.querySelector('p')!;
      const snapshot=createTranslationSourceSnapshot(owner,core.shouldStayOriginal,undefined,undefined,core.shouldOmitFromTranslation);
      expect(snapshot.slots.some(slot=>slot.source.includes('apt'))).toBe(false);
      const wrapper=appendBilingualTranslation(owner,applyTranslationsToSnapshot(snapshot,snapshot.slots.map(slot=>encodeControlledTranslation(slot.source))),{sourceSkeleton:snapshot.clone});
      const evidence=readControlledPageEvidenceInPage();expect(evidence[0].protectedMatches.map((part:any)=>part.text)).toEqual(['apt','apt-get','apt-cache']);
      expect(assertControlledPageEvidence(evidence,'ubuntu-commands')).toMatchObject({owners:1});
      const target=wrapper.querySelector('a')!;const href=target.getAttribute('href')!;target.setAttribute('href','/wrong-reference');expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'changed-command-link')).toThrow('complete source');target.setAttribute('href',href);
      wrapper.querySelector('b')!.textContent='wrong';expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'changed-command')).toThrow('complete source');wrapper.querySelector('b')!.textContent='apt';
      vi.stubGlobal('location',{hostname:'ordinary.example',pathname:path});expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'ordinary-bold')).toThrow('complete source');
      vi.stubGlobal('location',{hostname:'manpages.ubuntu.com',pathname:'/ordinary/article'});expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'ordinary-ubuntu-article')).toThrow('complete source');
      vi.stubGlobal('location',{hostname:'manpages.ubuntu.com',pathname:path});owner.querySelector('b')!.textContent='an ordinary bold sentence';wrapper.querySelector('b')!.textContent='an ordinary bold sentence';expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'untranslated-bold-prose')).toThrow('complete source');
    }finally{vi.unstubAllGlobals()}
  });
  it('proves SQLite document button protection through the actual adapter and rejects unrelated or changed prose', () => {
    const path = '/lang_select.html';const {document, window} = parseHTML('<html><body><p><b><a href="syntax/select-stmt.html">select-stmt:</a></b>\n<button>hide</button></p></body></html>');
    Object.defineProperty(document, 'baseURI', {value: 'https://www.sqlite.org'+path});
    vi.stubGlobal('document', document);vi.stubGlobal('Node', window.Node);vi.stubGlobal('location', {hostname: 'www.sqlite.org', pathname: path});
    try {
      const core = createTranslationCore({url: new URL('https://www.sqlite.org'+path)}), owner = document.querySelector('p')!;
      const snapshot = createTranslationSourceSnapshot(owner, core.shouldStayOriginal, undefined, undefined, core.shouldOmitFromTranslation);
      expect(snapshot.slots.map(slot => slot.source)).toEqual(['select-stmt:']);
      const translated = appendBilingualTranslation(owner, applyTranslationsToSnapshot(snapshot, snapshot.slots.map(slot => encodeControlledTranslation(slot.source))), {sourceSkeleton: snapshot.clone});
      expect(translated.querySelector('button')).toBeNull();expect(translated.textContent).toContain('hide');
      expect(assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'sqlite-button')).toMatchObject({owners: 1});
      const findHide = () => {const walk=document.createTreeWalker(translated,4);while(walk.nextNode()) if(walk.currentNode.nodeValue==='hide') return walk.currentNode;throw new Error('missing preserved button text');};
      const label = findHide();
      for (const wrong of ['show', 'hide extra', '']) {label.nodeValue=wrong;expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'changed-button')).toThrow('complete source');}
      label.nodeValue='hide';
      for (const location of [{hostname:'ordinary.test',pathname:path},{hostname:'www.sqlite.org',pathname:'/ordinary-article'}]) {
        vi.stubGlobal('location', location);expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'unregistered-button')).toThrow('complete source');
      }
      vi.stubGlobal('location',{hostname:'www.sqlite.org',pathname:path});
      const button=owner.querySelector('button')!, replacement=document.createElement('span');replacement.textContent='hide';button.replaceWith(replacement);
      expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'ordinary-text-not-button')).toThrow('complete source');replacement.replaceWith(button);
      const nearby=document.createTextNode(' Untranslated adjacent sentence.');owner.insertBefore(nearby,button);expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'missing-nearby-prose')).toThrow('complete source');
    } finally {vi.unstubAllGlobals();}
  });
  it.each([
    ['target-language slots', '<li>在 <code>unwrapManualChunk</code> 中，对 <code>querySelector</code> 使用非空断言（<code>!</code>）假设源 span 一定存在；建议更防御性地处理缺失的 <code>.fluent-read-translation-chunk-source</code>，以避免在 DOM 结构发生变化或被部分清理时出现运行时错误。</li>', 'li'],
    ['nested link identifier', '<a href="https://twitter.com/@squidfunk">Follow <strong>@squidfunk</strong> on <strong>Twitter</strong></a>', 'a'],
    ['standalone live number', '<p><span>+90k</span>every month</p>', 'p'],
  ])('attributes %s through actual snapshot and same-language policies while rejecting changed literals', (_name, html, selector) => {
    const {document,window}=parseHTML('<html><body>'+html+'</body></html>');
    Object.defineProperty(document,'baseURI',{value:'https://example.test/article'});
    vi.stubGlobal('document',document);vi.stubGlobal('Node',window.Node);
    try{
      const owner=document.querySelector<HTMLElement>(selector)!, snapshot=createTranslationSourceSnapshot(owner);
      const outputs=snapshot.slots.map(slot=>shouldSkipTranslationForTarget(slot.source,'zh-Hans')?slot.source:encodeControlledTranslation(slot.source));
      expect(outputs.some(value=>value.includes('测试译文：'))).toBe(true);
      const wrapper=appendBilingualTranslation(owner,applyTranslationsToSnapshot(snapshot,outputs),{sourceSkeleton:snapshot.clone});
      expect(assertControlledPageEvidence(readControlledPageEvidenceInPage(),'real-preserved-text')).toMatchObject({owners:1});
      const walk=document.createTreeWalker(wrapper,4);let changed=false;
      while(walk.nextNode())if(walk.currentNode.nodeValue?.trim()&&!walk.currentNode.nodeValue.includes('测试译文：')&&!walk.currentNode.parentElement?.closest('code')){walk.currentNode.nodeValue+=' extra';changed=true;break;}
      expect(changed).toBe(true);
      expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'changed-literal')).toThrow('complete source');
    }finally{vi.unstubAllGlobals()}
  });
  it('does not exempt ordinary English text, numeric prose, out-of-link handles, changed links or reordered literal slots', () => {
    const {document,window}=parseHTML('<html><body></body></html>');
    Object.defineProperty(document,'baseURI',{value:'https://example.test/article'});
    vi.stubGlobal('document',document);vi.stubGlobal('Node',window.Node);
    try{
      for(const [source,output] of [
        ['<span>untranslated English prose</span> every month','<span>untranslated English prose</span> '+encodeControlledTranslation('every month')],
        ['<span>+90k readers</span> every month','<span>+90k readers</span> '+encodeControlledTranslation('every month')],
        ['<strong>@squidfunk</strong> every month','<strong>@squidfunk</strong> '+encodeControlledTranslation('every month')],
        ['<a href="/right"><strong>@squidfunk</strong></a> every month','<a href="/wrong"><strong>@squidfunk</strong></a> '+encodeControlledTranslation('every month')],
        ['<span>+90k</span> every month <span>+80k</span>','<span>+80k</span> '+encodeControlledTranslation('every month')+' <span>+90k</span>'],
      ]){
        document.body.innerHTML='<p>'+source+'<span class="fluent-read-bilingual-content">'+output+'</span></p>';
        expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'unproven-literal')).toThrow('complete source');
      }
    }finally{vi.unstubAllGlobals()}
  });
  it('retains real BR boundaries in whole-block rendered translations without accepting lost spaces or removed lines', () => {
    const {document, window}=parseHTML('<html><body><p>\n  We want the camera to move.<br>\n  Because the system moves the entire scene. \n</p></body></html>');
    vi.stubGlobal('document',document);vi.stubGlobal('Node',window.Node);
    try {
      const owner=document.querySelector('p')!, snapshot=createTranslationSourceSnapshot(owner);
      const source=buildWholeBlockTranslationSource(snapshot)!;expect(source).toBe('We want the camera to move.\nBecause the system moves the entire scene.');
      const wrapper=appendBilingualTranslation(owner,applyTranslationsToSnapshot(snapshot,[encodeControlledTranslation(source),'']),{sourceSkeleton:snapshot.clone});
      expect(wrapper.querySelector('br')).not.toBeNull();
      expect(assertControlledPageEvidence(readControlledPageEvidenceInPage(),'whole-block-lines')).toMatchObject({owners:1});
      wrapper.querySelector('br')!.remove();
      expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'missing-line-boundary')).toThrow('complete source');
      wrapper.textContent=encodeControlledTranslation(source.replace('the camera','thecamera'));
      expect(()=>assertControlledPageEvidence(readControlledPageEvidenceInPage(),'missing-word-space')).toThrow('complete source');
    } finally {vi.unstubAllGlobals();}
  });
  it('fails closed if the instrumented worker is missing, its state is absent, or the worker restarts', async () => {
    const {api, context, worker, setWorkers} = await setup();
    setWorkers([]); await expect(api.snapshot()).rejects.toThrow('changed or disappeared');
    setWorkers([worker]); delete transportGlobal.__frCompatibilityTransport;
    await expect(api.snapshot()).rejects.toThrow('no completed request evidence');
    context.emit('serviceworker', {...worker}); await Promise.resolve();
    await expect(api.snapshot()).rejects.toThrow('changed or disappeared');
    api.dispose();
  });
});

describe('native public feed evidence negative controls', () => {
  const validState = () => ({sources: [{id: 1, visible: true, eligible: true, sourceText: 'Public source paragraph',
    firstObservedWrappers: 0, sourceIntact: true, protectedIntact: true, protectedCount: 1,
    translations: [encodeControlledTranslation('Public source paragraph')], pending: 0}], nested: 0, duplicateParents: 0, wrappers: 1, pending: 0});
  it('requires explicit network authorization and refuses foreground modes and unbounded scroll loops', () => {
    expect(() => parseNativeFeedArgs([])).toThrow('allow-network');
    expect(() => parseNativeFeedArgs(['--headed'])).toThrow('Unsupported argument');
    const required = ['--allow-network', '--extension-dir', '/tmp/extension', '--playwright-root', '/tmp/modules', '--artifacts-dir', '/tmp/evidence'];
    expect(() => parseNativeFeedArgs([...required, '--max-scrolls', '31'])).toThrow('max-scrolls');
    expect(parseNativeFeedArgs(required)).toMatchObject({allowNetwork: true, maxScrolls: 20});
  });
  it('accepts only the current per-source evidence and requires full-page restoration', () => {
    const state = validState();
    expect(assertNativeSnapshot(state, {translated: true, ids: [1], phase: 'valid'})).toBe(1);
    state.sources[0].translations = [];
    expect(() => assertNativeSnapshot(state, {translated: false, ids: [1], phase: 'restore'})).toThrow('page wrappers remain');
    state.wrappers = 0;
    expect(assertNativeSnapshot(state, {translated: false, ids: [1], phase: 'restored'})).toBe(1);
  });
  it('reads Mastodon explicit prose through its observed top-level shell while preserving local protected text', () => {
    const {document, window} = parseHTML('<html><body><div id="mastodon" class="notranslate app-holder"><article data-id="post-1"><div class="status__content__text"><p>Hello public prose with <a class="mention" href="/@sample">测试译文：@sample</a> and <span class="notranslate">private local text</span>.</p></div></article></div></body></html>');
    for (const element of document.querySelectorAll('*')) Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => ({left: 10, top: 20, right: 700, bottom: 300, width: 690, height: 280}), configurable: true,
    });
    Object.defineProperty(document, 'scrollingElement', {value: document.documentElement, configurable: true});
    vi.stubGlobal('document', document); vi.stubGlobal('window', window);
    vi.stubGlobal('MutationObserver', window.MutationObserver);
    vi.stubGlobal('getComputedStyle', () => ({display: 'block', visibility: 'visible', overflowX: 'visible', overflowY: 'visible'}));
    vi.stubGlobal('innerWidth', 1280); vi.stubGlobal('innerHeight', 816); vi.stubGlobal('scrollY', 0);
    vi.stubGlobal('location', {href: 'https://mastodon.social/@Mastodon'});
    const trackerKey = '__nativeFeedSourceTest';
    try {
      let state = installNativeFeedTracker(trackerKey);
      expect(state.sources).toHaveLength(1);
      expect(state.sources[0]).toMatchObject({eligible: true, sourceText: 'Hello public prose with and .', firstObservedWrappers: 0, protectedIntact: true});
      const wrapper = document.createElement('span'); wrapper.className = 'fluent-read-bilingual-content';
      wrapper.innerHTML = '<a href="/@sample">测试译文：@sample</a> ' + encodeControlledTranslation('Hello public prose with and .');
      document.querySelector('p')!.append(wrapper);
      state = (window as any)[trackerKey].snapshot();
      expect(state.sources[0].renderedTranslations[0]).toMatch(/^测试译文：@sample/);
      expect(assertNativeSnapshot(state, {translated: true, ids: [1], phase: 'protected-prefix'})).toBe(1);
      wrapper.innerHTML = '<a href="/@sample">测试译文：@sample</a> Unproven body response';
      state = (window as any)[trackerKey].snapshot();
      expect(() => assertNativeSnapshot(state, {translated: true, ids: [1], phase: 'prefix-only-in-protected-text'})).toThrow('controlled response not proven');
      wrapper.remove();
      (window as any)[trackerKey].dispose();
      document.querySelector('#mastodon')!.id = 'ordinary-protected-container';
      state = installNativeFeedTracker(trackerKey);
      expect(state.sources[0]).toMatchObject({eligible: false, sourceText: ''});
    } finally {
      (window as any)[trackerKey]?.dispose(); vi.unstubAllGlobals();
    }
  });
  it.each<[string, (state: ReturnType<typeof validState>) => void, RegExp]>([
    ['missing source', state => {state.sources = [];}, /no visible source/],
    ['late baseline', state => {state.sources[0].firstObservedWrappers = 1;}, /baseline was captured/],
    ['changed HTML', state => {state.sources[0].sourceIntact = false;}, /original HTML changed/],
    ['changed protected subtree', state => {state.sources[0].protectedIntact = false;}, /protected link\/code changed/],
    ['missing translation', state => {state.sources[0].translations = [];}, /wrong translation count/],
    ['pending translation', state => {state.sources[0].pending = 1;}, /pending or retry/],
    ['unproven response', state => {state.sources[0].translations = ['Unknown provider response'];}, /controlled response not proven/],
    ['prefix without matching source', state => {state.sources[0].translations = ['测试译文：An unrelated sentence'];}, /controlled response not proven/],
    ['old echoed source', state => {state.sources[0].translations = ['测试译文：Public source paragraph'];}, /controlled response not proven/],
    ['partial matching source', state => {state.sources[0].translations = [encodeControlledTranslation('Public source')];}, /controlled response not proven/],
    ['extra encoded source', state => {state.sources[0].translations[0] += encodeControlledTranslation('Extra paragraph');}, /controlled response not proven/],
    ['nested wrapper', state => {state.nested = 1;}, /nested wrappers/],
    ['duplicate parent', state => {state.duplicateParents = 1;}, /duplicate wrappers/],
    ['protected-only source translated', state => {state.sources.push({...state.sources[0], id: 2, eligible: false, sourceText: ''});}, /protected-only source received/],
  ])('rejects %s', (_label, change, reason) => {
    const state = validState(); change(state);
    expect(() => assertNativeSnapshot(state, {translated: true, ids: [1], phase: 'negative'})).toThrow(reason);
  });
});

describe('controlled native source partitions', () => {
  let document: Document;
  const page = {evaluate: async (fn: (value: unknown) => unknown, value: unknown) => fn(value)};
  const configs = [{name: 'inline-game-body', selector: '#body', sourcePartition: {excludeSelectors: ['h2']}}];
  const bodyText = 'Opening complete sentence.\nMiddle complete sentence.\nClosing complete sentence.';
  const addWrapper = (owner: Element, text: string) => {
    const wrapper = document.createElement('span');
    wrapper.className = 'fluent-read-bilingual-content';
    wrapper.setAttribute('data-fr-translation-owned', 'true');
    wrapper.textContent = encodeControlledTranslation(text);
    owner.append(wrapper);
    return wrapper;
  };
  const renderBody = (text = bodyText) => {
    const root = document.querySelector('#body')!;
    const segment = document.createElement('span');
    segment.setAttribute('data-fr-translation-segment', 'true');
    const sourceNodes = [...root.childNodes].filter(node => node !== root.querySelector('h2'));
    root.append(segment);
    sourceNodes.forEach(node => segment.append(node));
    return {segment, wrapper: addWrapper(segment, text)};
  };
  beforeEach(() => {
    ({document} = parseHTML('<html><body><div id="outside">Outside complete sentence.</div><div id="body"><h2>Excluded heading</h2><strong>Opening complete sentence.</strong><br>Middle complete sentence.<br><em>Closing complete sentence.</em></div></body></html>') as unknown as {document: Document});
    vi.stubGlobal('document', document);
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__fluentReadControlledSourcePartitionsV1;
    vi.unstubAllGlobals();
  });

  it('binds complete native Text and BR source before rendering through two passes and exact restoration', async () => {
    const ledger = await captureSourcePartitions(page, configs);
    expect(Object.keys(ledger)).toEqual([]);
    let rendered = renderBody();
    addWrapper(document.querySelector('h2')!, 'Excluded heading');
    expect(await assertSourcePartitions(page, ledger, 'first')).toEqual([{
      name: 'inline-game-body', selector: '#body', index: 0, sourcePartsCount: 5,
      expectedSource: bodyText, ownerCount: 1, completeSourceMatched: true, restored: false,
    }]);
    rendered.wrapper.remove();
    rendered.segment.replaceWith(...rendered.segment.childNodes);
    expect(await assertSourcePartitions(page, ledger, 'restored', {restored: true})).toMatchObject([{ownerCount: 0, restored: true}]);
    rendered = renderBody();
    expect(await assertSourcePartitions(page, ledger, 'second')).toMatchObject([{ownerCount: 1, completeSourceMatched: true}]);
    expect(JSON.stringify(await assertSourcePartitions(page, ledger, 'serializable'))).not.toContain('WeakRef');
  });

  it('does not let only a descendant heading or a correct wrapper outside the container prove the body', async () => {
    const ledger = await captureSourcePartitions(page, configs);
    addWrapper(document.querySelector('h2')!, 'Excluded heading');
    await expect(assertSourcePartitions(page, ledger, 'heading-only')).rejects.toThrow('owners missing');
    const outside = document.querySelector('#outside')!;
    outside.textContent = bodyText;
    addWrapper(outside, bodyText);
    expect(assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'old-owner-gate')).toMatchObject({owners: 2});
    await expect(assertSourcePartitions(page, ledger, 'wrong-container')).rejects.toThrow('owners missing');
  });

  it('rejects legitimate partial owners even when each existing wrapper matches all of its own source', async () => {
    const ledger = await captureSourcePartitions(page, configs);
    addWrapper(document.querySelector('strong')!, 'Opening complete sentence.');
    addWrapper(document.querySelector('em')!, 'Closing complete sentence.');
    expect(assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'partial-own-source')).toMatchObject({owners: 2});
    await expect(assertSourcePartitions(page, ledger, 'missing-middle')).rejects.toThrow('complete partition source');
  });

  it.each([
    ['partial response', 'Opening complete sentence.'],
    ['keywords without middle', 'Opening complete sentence.\nClosing complete sentence.'],
    ['reordered response', 'Closing complete sentence.\nMiddle complete sentence.\nOpening complete sentence.'],
    ['duplicated response', bodyText + '\n' + bodyText],
  ])('rejects %s rather than checking a keyword or prefix', async (_label, output) => {
    const ledger = await captureSourcePartitions(page, configs);
    renderBody(output);
    await expect(assertSourcePartitions(page, ledger, 'incomplete-or-reordered')).rejects.toThrow('complete source');
  });

  it('rejects duplicate complete owners and changed native source without accepting stale output', async () => {
    const ledger = await captureSourcePartitions(page, configs);
    const rendered = renderBody();
    const duplicate = addWrapper(rendered.segment, bodyText);
    expect(assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'duplicates-own-source')).toMatchObject({owners: 2});
    await expect(assertSourcePartitions(page, ledger, 'duplicate-owner')).rejects.toThrow('complete partition source');
    duplicate.remove();
    rendered.segment.querySelector('strong')!.textContent = 'A newly changed opening sentence.';
    await expect(assertSourcePartitions(page, ledger, 'changed-source')).rejects.toThrow('native partition source changed');
  });

  it('rejects restored wrappers, loading/retry markers and synthetic source containers', async () => {
    const ledger = await captureSourcePartitions(page, configs);
    const rendered = renderBody();
    await expect(assertSourcePartitions(page, ledger, 'residual-wrapper', {restored: true})).rejects.toThrow('translation artifacts');
    rendered.wrapper.remove();
    await expect(assertSourcePartitions(page, ledger, 'residual-segment', {restored: true})).rejects.toThrow('translation artifacts');
    rendered.segment.replaceWith(...rendered.segment.childNodes);
    for (const className of ['fluent-read-loading', 'fluent-read-retry-wrapper']) {
      const marker = document.createElement('span'); marker.className = className;
      document.querySelector('#body')!.append(marker);
      await expect(assertSourcePartitions(page, ledger, className, {restored: true})).rejects.toThrow('translation artifacts');
      marker.remove();
    }
  });

  it.each([
    ['class', 'fluent-read-bilingual-content'],
    ['class', 'fluent-read-loading'],
    ['class', 'fluent-read-retry-wrapper'],
    ['data-fr-translation-owned', 'true'],
    ['data-fr-translation-segment', 'true'],
  ])('rejects a partition root carrying %s=%s during capture or restoration', async (attribute, value) => {
    const root = document.querySelector('#body')!;
    root.setAttribute(attribute, value);
    await expect(captureSourcePartitions(page, configs)).rejects.toThrow('baseline already has translation artifacts');
    root.removeAttribute(attribute);
    const ledger = await captureSourcePartitions(page, configs);
    root.setAttribute(attribute, value);
    await expect(assertSourcePartitions(page, ledger, 'root-artifact', {restored: true})).rejects.toThrow('translation artifacts');
  });

  it('keeps protected literal failures in the existing complete-source gate', async () => {
    document.querySelector('#body')!.innerHTML = '<h2>Excluded heading</h2><span id="literal-owner">Readable text <code>KEEP_TOKEN</code> and final words.</span>';
    const ledger = await captureSourcePartitions(page, configs);
    const owner = document.querySelector('#literal-owner')!;
    const wrapper = addWrapper(owner, 'Readable text  and final words.');
    wrapper.innerHTML = encodeControlledTranslation('Readable text ') + '<code>KEEP_TOKEN</code>' + encodeControlledTranslation(' and final words.');
    expect(await assertSourcePartitions(page, ledger, 'protected')).toMatchObject([{completeSourceMatched: true}]);
    wrapper.querySelector('code')!.textContent = 'WRONG_TOKEN';
    await expect(assertSourcePartitions(page, ledger, 'changed-literal')).rejects.toThrow('complete source');
  });

  it('rejects late baselines, empty partitions, replaced containers and forged or cross-page ledgers', async () => {
    const ledger = await captureSourcePartitions(page, configs);
    await expect(assertSourcePartitions(page, {}, 'forged')).rejects.toThrow('does not belong');
    await expect(assertSourcePartitions({...page}, ledger, 'other-page')).rejects.toThrow('does not belong');
    const root = document.querySelector('#body')!;
    root.replaceWith(root.cloneNode(true));
    await expect(assertSourcePartitions(page, ledger, 'replaced')).rejects.toThrow('container changed');
    renderBody();
    await expect(captureSourcePartitions(page, configs)).rejects.toThrow('baseline already has translation artifacts');
    document.querySelector('#body')!.innerHTML = '<h2>Only an excluded heading</h2>';
    await expect(captureSourcePartitions(page, configs)).rejects.toThrow('not native source');
    await expect(captureSourcePartitions(page, [{selector: '#missing'}])).rejects.toThrow('container missing');
    await expect(captureSourcePartitions(page, [])).rejects.toThrow('require configurations');
  });
});
