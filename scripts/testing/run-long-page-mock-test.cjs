#!/usr/bin/env node
'use strict';
/**
 * Long-page rendering regression: deterministic discussion/article/HTML-paper fixtures,
 * production extension, real full-page shortcuts, and a new background-only Edge profile.
 * Rendering controls use the same translated DOM and a fixture-authored root CSS override.
 * They never edit wrapper properties/HTML or suppress the extension's mutation observer.
 * Their measurements exclude translation requests and do not establish Windows performance.
 * Run through scripts/testing/run-resource-safe.mjs; this script never builds the extension.
 * node scripts/testing/run-resource-safe.mjs -- node scripts/testing/run-long-page-mock-test.cjs
 *   --extension-dir .output/chrome-mv3 --playwright-root <packages> --artifacts-dir <evidence>
 * Optional: --case discussion|article|research --units 60 --samples 5 --provider-delay 40.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {guardBrowserClose} = require('./owned-browser-close.cjs');
const {controlledProviderRuntime} = require('../site-translation/controlled-provider.cjs');
const {buildLongPageFixture} = require('./long-page-mock-fixtures.cjs');
const {assertFreshProductionExtension, waitForTranslationIdle} = require('../run-site-translation-test.cjs');
const root = path.resolve(__dirname, '../..');
const owned = '.fluent-read-bilingual-content';

function parseArgs(argv) {
  const args = {focusSafeHelper: path.join(__dirname, 'focus-safe-browser.cjs'), units: 60, samples: 5, providerDelay: 40};
  const accepted = new Set(['extension-dir', 'production-root', 'playwright-root', 'focus-safe-helper', 'artifacts-dir', 'browser-path', 'case', 'units', 'samples', 'provider-delay']);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    assert.ok(flag.startsWith('--') && accepted.has(flag.slice(2)), `Unknown argument ${flag}`);
    assert.ok(argv[index + 1] && !argv[index + 1].startsWith('--'), `Missing value for ${flag}`);
    args[flag.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase())] = argv[++index];
  }
  for (const name of ['extensionDir', 'playwrightRoot', 'focusSafeHelper', 'artifactsDir']) {
    assert.ok(args[name], `Missing --${name.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`)}`);
    args[name] = path.resolve(args[name]);
  }
  for (const name of ['units', 'samples', 'providerDelay']) args[name] = Number(args[name]);
  assert.ok(Number.isInteger(args.units) && args.units >= 12 && args.units <= 160, '--units must be 12..160');
  assert.ok(Number.isInteger(args.samples) && args.samples >= 3 && args.samples <= 9, '--samples must be 3..9');
  assert.ok(Number.isInteger(args.providerDelay) && args.providerDelay >= 0 && args.providerDelay <= 500, '--provider-delay must be 0..500');
  if (args.case) assert.ok(['discussion', 'article', 'research'].includes(args.case), `Unknown case ${args.case}`);
  if (args.productionRoot) args.productionRoot = path.resolve(args.productionRoot);
  return args;
}

// Serialized into the isolated worker after the shared, source-bound codec is installed.
// Keep fixture markers readable while encoding prose instead of returning an English echo.
function installLongPageMockTransport(delay) {
  const translate = globalThis.fetch;
  globalThis.__longMockRequests = [];
  globalThis.__longMockStage = 'setup';
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input?.url || input));
    if (url.hostname !== 'edge.microsoft.com' || url.pathname !== '/translate/translatetext') throw Error(`Long-page mock forbids external provider ${url.origin}${url.pathname}`);
    const texts = JSON.parse(init?.body ?? await input.clone().text());
    const request = {stage: globalThis.__longMockStage, at: Date.now(), texts, characters: texts.reduce((total, text) => total + String(text).length, 0)};
    globalThis.__longMockRequests.push(request);
    await new Promise(resolve => setTimeout(resolve, delay));
    const response = await translate(input, init);
    const rows = await response.json();
    request.finishedAt = Date.now();
    rows.forEach((row, index) => {
      const token = texts[index].match(/LPM-[A-Z]+-\d{3}-(?:\d+|opening)/u)?.[0] || 'overview';
      row.translations[0].text = `长页译文 ${token}。${row.translations[0].text}`;
    });
    return new Response(JSON.stringify(rows), {status: response.status, headers: {'content-type': 'application/json'}});
  };
}

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((sorted.length - 1) * probability)];
}

// Revealing every offscreen block changes upstream estimates. Compare the
// target's own layout against its source, while retaining raw viewport positions.
function assertResizeGeometryEquivalent(measurement, label) {
  const {optimized, visibleControl} = measurement;
  const keys = ['height', 'wrapperWidth', 'left', 'top', 'sourceLeft', 'sourceTop'];
  for (const geometry of [optimized, visibleControl]) {
    assert.ok(geometry && keys.every(key => Number.isFinite(geometry[key])), `${label}: incomplete resize geometry`);
  }
  for (const [key, before, after] of [
    ['height', optimized.height, visibleControl.height],
    ['wrapperWidth', optimized.wrapperWidth, visibleControl.wrapperWidth],
    ['source-relative-left', optimized.left - optimized.sourceLeft, visibleControl.left - visibleControl.sourceLeft],
    ['source-relative-top', optimized.top - optimized.sourceTop, visibleControl.top - visibleControl.sourceTop],
  ]) {
    assert.ok(Math.abs(before - after) <= .5,
      `${label}: visible geometry retained an obsolete intrinsic size after resize/font change (${key})`);
  }
}

// Main-world observations neither import product internals nor introduce a runtime debug API.
function installHostObservation() {
  window.__longMock = {phase: 'load', observing: false, mutations: {}, frames: [], longTasks: [], autoEvents: [], guardAttributeChanges: [], installed: new WeakSet()};
  const state = window.__longMock;
  const attach = root => {
    const nodes = root instanceof Element ? [root, ...root.querySelectorAll('.fluent-read-bilingual-content')] : [];
    for (const node of nodes) if (node.matches('.fluent-read-bilingual-content') && !state.installed.has(node)) {
      state.installed.add(node);
      node.addEventListener('contentvisibilityautostatechange', event => state.autoEvents.push({
        phase: state.phase, at: performance.now(), skipped: event.skipped,
        source: node.closest('[data-long-source]')?.getAttribute('data-long-source') || '',
      }));
    }
  };
  new MutationObserver(records => {
    if (state.observing) for (const record of records) {
      const counters = state.mutations[state.phase] ||= {records: 0, addedNodes: 0, removedNodes: 0, attributes: 0, characterData: 0};
      counters.records++;
      counters.addedNodes += record.addedNodes.length;
      counters.removedNodes += record.removedNodes.length;
      if (record.type === 'attributes') counters.attributes++;
      if (record.type === 'characterData') counters.characterData++;
      if (record.type === 'attributes' && record.target.closest('[data-long-guard]')) state.guardAttributeChanges.push({
        phase: state.phase, tag: record.target.tagName, id: record.target.id,
        guard: record.target.closest('[data-long-guard]').id, attribute: record.attributeName,
        before: record.oldValue, after: record.target.getAttribute(record.attributeName),
      });
    }
    for (const record of records) for (const node of record.addedNodes) attach(node);
  }).observe(document, {subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true});
  try {
    new PerformanceObserver(list => {
      if (state.observing) for (const entry of list.getEntries()) state.longTasks.push({phase: state.phase, startTime: entry.startTime, duration: entry.duration});
    }).observe({type: 'longtask', buffered: true});
  } catch { state.longTaskSupported = false; }
  let previous;
  const frame = time => {
    if (state.observing && previous !== undefined) state.frames.push({phase: state.phase, time, duration: time - previous});
    previous = time;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function hostSnapshot() {
  const sourceOnly = element => {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('.fluent-read-bilingual-content,[data-fr-translation-owned="true"]').forEach(node => node.remove());
    return {id: element.id, text: clone.textContent, links: [...clone.querySelectorAll('a')].map(node => ({href: node.getAttribute('href'), text: node.textContent}))};
  };
  return {
    sources: [...document.querySelectorAll('[data-long-source]')].map(sourceOnly),
    guardHtml: [...document.querySelectorAll('[data-long-guard]')].map(node => ({id: node.id, html: node.outerHTML})),
    sourceHtml: [...document.querySelectorAll('[data-long-source]')].map(node => ({id: node.id, html: node.innerHTML})),
    containerHtml: [...document.querySelectorAll('[data-long-container]')].map((node, index) => ({index, html: node.innerHTML})),
    url: location.href,
  };
}

function wrapperSnapshot() {
  const wrappers = [...document.querySelectorAll('.fluent-read-bilingual-content')];
  return {
    wrapperCount: wrappers.length,
    nested: document.querySelectorAll('.fluent-read-bilingual-content .fluent-read-bilingual-content').length,
    requiredCoverage: [...document.querySelectorAll('[data-long-required]')].map(node => ({id: node.id,
      count: node.querySelectorAll('.fluent-read-bilingual-content').length,
      correctMarker: node.querySelector('.fluent-read-bilingual-content')?.textContent.includes(`长页译文 ${node.getAttribute('data-long-source')}`) || false})),
    openingCoverage: [...document.querySelectorAll('.commtext')].map((node, index) => {
      const wrappers = [...node.querySelectorAll('.fluent-read-bilingual-content')].filter(wrapper => !wrapper.closest('p,[data-long-guard]'));
      const expected = `长页译文 LPM-DISCUSSION-${String(index).padStart(3, '0')}-opening`;
      return {index, count: wrappers.length, correctMarker: wrappers[0]?.textContent.includes(expected) || false,
        directOwner: wrappers[0]?.parentElement?.parentElement === node || wrappers[0]?.parentElement === node};
    }),
    guardWrappers: [...document.querySelectorAll('[data-long-guard]')].map(node => ({id: node.id, count: node.querySelectorAll('.fluent-read-bilingual-content').length})),
    autoCount: wrappers.filter(node => getComputedStyle(node).contentVisibility === 'auto').length,
    containedCount: wrappers.filter(node => node.getAttribute('data-fr-rendering-contained') === 'true').length,
    skippedCount: wrappers.filter(node => typeof node.checkVisibility === 'function' && !node.checkVisibility({contentVisibilityAuto: true})).length,
    styles: wrappers.slice(0, 8).map(node => ({
      tag: node.tagName, display: getComputedStyle(node).display, contentVisibility: getComputedStyle(node).contentVisibility,
      intrinsicBlockSize: getComputedStyle(node).containIntrinsicBlockSize, inlineContentVisibility: node.style.contentVisibility,
    })),
    elementCount: document.querySelectorAll('*').length,
    height: document.documentElement.scrollHeight,
  };
}

async function main(args) {
  assertFreshProductionExtension(args.extensionDir, args.productionRoot || root);
  const helper = require(args.focusSafeHelper);
  const {chromium} = createRequire(path.join(args.playwrightRoot, 'long-page-test.cjs'))('playwright');
  const specs = (args.case ? [args.case] : ['discussion', 'article', 'research']).map(kind => buildLongPageFixture(kind, args.units));
  fs.mkdirSync(args.artifactsDir, {recursive: true});
  const report = {
    scope: 'mock-long-page-rendering', platform: process.platform, productionRoot: args.productionRoot || root,
    limitations: ['HTML research document, not PDF reader', 'CDP accessibility tree, not OS screen-reader acceptance', 'Print media/layout, not a physical printer', 'Same-DOM fixture-authored CSS override control, not an older extension or Windows performance', 'rAF wall time includes deliberate scroll pacing and automation; not translation latency', 'Other machine/global-queue jobs can affect durations; no isolated idle-machine claim'],
    machine: {architecture: process.arch, cpuCount: os.cpus().length, loadAverageAtStart: os.loadavg()},
    provider: {name: 'deterministic-microsoft', delayMs: args.providerDelay},
    contentSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(args.extensionDir, 'content-scripts/content.js'))).digest('hex'),
    profileMode: 'new-temporary-profile', cases: [], errors: [], unexpectedNetwork: [],
  };
  const save = () => fs.writeFileSync(path.join(args.artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-long-mock-'));
  let session, page, primaryError;
  const cdpSessions = new Set();
  let launchAttempted = false;
  try {
    launchAttempted = true;
    session = await helper.launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: args.browserPath || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      background: true, headless: false, displayTarget: 'secondary', viewport: {width: 1280, height: 900},
      browserArgs: [`--disable-extensions-except=${args.extensionDir}`, `--load-extension=${args.extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    guardBrowserClose(session, profileDir);
    const context = session.context;
    Object.assign(report, {browserVersion: context.browser().version(), launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
    assert.equal(session.launchMode, 'macos-background-cdp');
    assert.equal(session.focusPolicy, 'launchservices-no-foreground');
    assert.equal(session.windowPlacement.mode, 'background-visible-no-focus');
    assert.equal(session.windowPlacement.browserFrontmost, false);
    await context.route('**/*', route => {
      const url = route.request().url();
      const spec = specs.find(item => item.url === url);
      if (spec) return route.fulfill({status: 200, contentType: 'text/html; charset=utf-8', body: spec.html});
      if (/^(chrome-extension:|data:|about:)/u.test(url)) return route.continue();
      report.unexpectedNetwork.push({url, type: route.request().resourceType()});
      return route.abort('blockedbyclient');
    });
    await context.addInitScript(installHostObservation);
    const installedWorkers = new WeakMap();
    const installWorker = worker => {
      if (!installedWorkers.has(worker)) installedWorkers.set(worker,
        worker.evaluate(controlledProviderRuntime, true).then(() => worker.evaluate(installLongPageMockTransport, args.providerDelay)));
      return installedWorkers.get(worker);
    };
    context.on('serviceworker', worker => { void installWorker(worker).catch(error => report.errors.push(error.message)); });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await installWorker(worker);
    const popup = await helper.newPageWithoutForeground(context);
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await popup.waitForTimeout(600);
    const persisted = await popup.evaluate(async () => {
      const read = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      const config = typeof read.value === 'string' ? JSON.parse(read.value) : read.value;
      const updates = {on: true, service: 'microsoft', from: 'en', to: 'zh-Hans', display: 1, style: 1,
        hotkey: 'Control', floatingBallHotkey: 'Alt+T', mouseHoverTranslationDelay: 0,
        fullPageTranslationMode: 'all', useCache: false, autoTranslate: false,
        enableAIContext: false, enableAIMultiSegment: false, uiLanguageSetupCompleted: true};
      return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: updates,
        expected: Object.fromEntries(Object.keys(updates).map(key => [key, config[key]])),
        clientId: 'long-page-mock-test', sequence: 1, baseRevision: config.__fluentConfigRevision});
    });
    assert.equal(persisted.success, true, JSON.stringify(persisted));
    const readAppearance = () => popup.evaluate(async () => {
      const read = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      const config = typeof read.value === 'string' ? JSON.parse(read.value) : read.value;
      return config.translationAppearance;
    });
    const defaultAppearance = await readAppearance();
    report.initialAppearance = defaultAppearance;
    let configSequence = 1;
    const persistAppearance = async value => {
      const result = await popup.evaluate(async ({value, sequence}) => {
        const read = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
        const config = typeof read.value === 'string' ? JSON.parse(read.value) : read.value;
        return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: {translationAppearance: value},
          expected: {translationAppearance: config.translationAppearance}, clientId: 'long-page-mock-test', sequence,
          baseRevision: config.__fluentConfigRevision});
      }, {value, sequence: ++configSequence});
      assert.equal(result.success, true, JSON.stringify(result));
    };

    for (const spec of specs) {
      // Keep the first default unchanged; restore it between cases only when it differs.
      if (JSON.stringify(await readAppearance()) !== JSON.stringify(defaultAppearance)) await persistAppearance(defaultAppearance);
      const result = {id: spec.id, url: spec.url, units: spec.units, requiredCount: spec.requiredCount, phases: [], renderingSamples: [], pageErrors: []};
      report.cases.push(result);
      fs.writeFileSync(path.join(args.artifactsDir, `${spec.id}-fixture.html`), spec.html);
      page = await helper.newPageWithoutForeground(context);
      page.on('pageerror', error => result.pageErrors.push(String(error.stack || error)));
      const response = await page.goto(spec.url, {waitUntil: 'load', timeout: 30000});
      assert.equal(response.status(), 200);
      await page.waitForSelector('#fluent-read-page-styles', {state: 'attached'});
      await page.evaluate(() => document.fonts.ready);
      await helper.activateExtensionTabWithoutForeground(context, page);
      await page.waitForTimeout(300);
      const original = await page.evaluate(hostSnapshot);
      assert.equal(await page.locator('[data-long-required]').count(), spec.requiredCount);
      const cdp = await context.newCDPSession(page); cdpSessions.add(cdp);
      await cdp.send('Performance.enable');
      await cdp.send('Accessibility.enable');
      const beginPhase = async phase => {
        await worker.evaluate(stage => { globalThis.__longMockStage = stage; }, `${spec.id}:${phase}`);
        await page.evaluate(name => { __longMock.phase = name; __longMock.observing = true; }, phase);
      };
      const finishPhase = async phase => {
        const state = await page.evaluate(name => ({phase: name, snapshot: window.__longMock ? {
          mutations: __longMock.mutations[name] || {}, frames: __longMock.frames.filter(frame => frame.phase === name),
          longTasks: __longMock.longTasks.filter(task => task.phase === name), autoEvents: __longMock.autoEvents.filter(event => event.phase === name),
        } : null}), phase);
        Object.assign(state, await page.evaluate(wrapperSnapshot));
        const requests = await worker.evaluate(stage => __longMockRequests.filter(request => request.stage === stage), `${spec.id}:${phase}`);
        state.requestCount = requests.length;
        state.requestedCharacters = requests.reduce((sum, request) => sum + request.characters, 0);
        state.sourceMarkers = [...new Set(requests.flatMap(request => request.texts.flatMap(text => String(text).match(/LPM-[A-Z]+-\d{3}-(?:\d+|opening)/gu) || [])))];
        result.phases.push(state); save(); return state;
      };
      const assertSources = async restored => {
        const now = await page.evaluate(hostSnapshot);
        assert.deepEqual(now.sources, original.sources, `${spec.id}: original text/links changed`);
        assert.deepEqual(now.guardHtml, original.guardHtml, `${spec.id}: protected host content changed`);
        assert.equal(now.url, original.url);
        if (restored) {
          assert.deepEqual(now.sourceHtml, original.sourceHtml, `${spec.id}: restore did not recover source HTML`);
          assert.deepEqual(now.containerHtml, original.containerHtml, `${spec.id}: restore left a synthetic owner or changed container HTML`);
        }
      };
      const assertCoverage = snapshot => {
        assert.equal(snapshot.requiredCoverage.length, spec.requiredCount);
        for (const target of snapshot.requiredCoverage) {
          assert.equal(target.count, 1, `${spec.id}: ${target.id} requires exactly one translation`);
          assert.equal(target.correctMarker, true, `${spec.id}: ${target.id} received another paragraph's translation`);
        }
        if (spec.id === 'discussion') {
          assert.equal(snapshot.openingCoverage.length, spec.units);
          for (const opening of snapshot.openingCoverage) {
            assert.equal(opening.count, 1, `${spec.id}: opening ${opening.index} requires one direct translation`);
            assert.ok(opening.correctMarker && opening.directOwner, `${spec.id}: opening ${opening.index} has the wrong translation owner/marker`);
          }
        }
        for (const guard of snapshot.guardWrappers) assert.equal(guard.count, 0, `${spec.id}: protected ${guard.id} translated`);
        assert.equal(snapshot.nested, 0);
      };

      await beginPhase('translate');
      await page.keyboard.press('Alt+t');
      await page.waitForFunction(selector => [...document.querySelectorAll('[data-long-required]')].every(node => node.querySelectorAll(selector).length === 1), owned, {timeout: 90000});
      await waitForTranslationIdle(page, 10000, `${spec.id}-translate`, 10000);
      await page.waitForTimeout(250);
      const translated = await finishPhase('translate');
      assertCoverage(translated); await assertSources(false);
      assert.ok(translated.autoCount >= 10, `${spec.id}: no substantial owned content-visibility optimization observed`);
      assert.ok(translated.containedCount >= 10, `${spec.id}: contained ownership marker missing`);
      assert.ok(translated.skippedCount > 0 || translated.snapshot.autoEvents.some(event => event.skipped), `${spec.id}: native offscreen skip was not observed`);
      result.conservativeCases = await page.evaluate(async () => {
        const observations = [];
        for (const source of document.querySelectorAll('[data-long-special="overflow"]')) {
          source.scrollIntoView({block: 'center', behavior: 'instant'});
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const wrapper = source.querySelector('.fluent-read-bilingual-content');
          observations.push({kind: 'overflow', sourceId: source.id, contained: wrapper.getAttribute('data-fr-rendering-contained'),
            scrollWidth: wrapper.scrollWidth, clientWidth: wrapper.clientWidth, contentVisibility: getComputedStyle(wrapper).contentVisibility});
        }
        scrollTo({top: 0, behavior: 'instant'});
        return observations;
      });
      for (const observation of result.conservativeCases) {
        assert.ok(observation.scrollWidth > observation.clientWidth, 'Overflow fixture did not exercise overflow');
        assert.equal(observation.contained, null, 'Overflowing translation should conservatively retain normal rendering');
        assert.equal(observation.contentVisibility, 'visible');
      }
      // Playwright's default caret hiding writes input.style and can leave an empty style attr.
      await page.screenshot({path: path.join(args.artifactsDir, `${spec.id}-translated-top.png`), caret: 'initial'});

      // Observe the stable interval after two frames; this does not prove a jump-free first reveal.
      await beginPhase('scroll');
      result.scrollChecks = [];
      for (const index of [0, Math.floor(spec.requiredCount / 2), spec.requiredCount - 1, 0]) {
        const check = await page.evaluate(async targetIndex => {
          const source = document.querySelectorAll('[data-long-required]')[targetIndex];
          source.scrollIntoView({block: 'center', behavior: 'instant'});
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const wrapper = source.querySelector('.fluent-read-bilingual-content');
          const frames = [];
          const text = [...source.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
          const range = document.createRange(); range.selectNodeContents(text);
          const until = performance.now() + 220;
          do {
            await new Promise(resolve => requestAnimationFrame(resolve));
            frames.push({top: range.getBoundingClientRect().top, scrollY, wrapperHeight: wrapper.getBoundingClientRect().height,
              visible: wrapper.checkVisibility({contentVisibilityAuto: true})});
          } while (performance.now() < until);
          return {sourceId: source.id, scope: 'stable-window-after-two-frames', frames, drift: Math.max(...frames.map(frame => frame.top)) - Math.min(...frames.map(frame => frame.top))};
        }, index);
        assert.ok(check.frames.every(frame => frame.visible && frame.wrapperHeight > 0));
        assert.ok(check.drift <= 2, `${spec.id}/${check.sourceId}: reading anchor shifted ${check.drift}px after scroll`);
        result.scrollChecks.push(check);
      }

      // Find, selection and AX are inspected separately from timed rendering samples.
      await beginPhase('interactions');
      const farIndex = spec.requiredCount - 2;
      result.interactions = await page.evaluate(index => {
        scrollTo({top: 0, behavior: 'instant'});
        const sources = document.querySelectorAll('[data-long-required]');
        const target = sources[index].querySelector('.fluent-read-bilingual-content');
        const token = `长页译文 ${sources[index].getAttribute('data-long-source')}`;
        getSelection()?.removeAllRanges();
        const found = typeof window.find === 'function' && window.find(token, false, false, false, false, false, false);
        const rect = target.getBoundingClientRect();
        const find = {token, found, selection: getSelection()?.toString(), targetTop: rect.top, targetHeight: rect.height, viewportHeight: innerHeight,
          visible: target.checkVisibility({contentVisibilityAuto: true})};
        const first = sources[0].querySelector('.fluent-read-bilingual-content');
        const last = sources[sources.length - 1].querySelector('.fluent-read-bilingual-content');
        const range = document.createRange(); range.setStart(first, 0); range.setEnd(last, last.childNodes.length);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        const selected = selection.toString(); selection.removeAllRanges();
        const sourceLink = sources[index].querySelector('[data-long-link]');
        const before = sourceLink.getAttribute('href');
        sourceLink.focus({preventScroll: false});
        return {find, selection: {length: selected.length, includesFirst: selected.includes(`长页译文 ${sources[0].getAttribute('data-long-source')}`),
          includesLast: selected.includes(`长页译文 ${sources[sources.length - 1].getAttribute('data-long-source')}`)},
          sourceLink: {hrefBefore: before, hrefAfter: sourceLink.getAttribute('href'), focused: document.activeElement === sourceLink}};
      }, farIndex);
      assert.equal(result.interactions.find.found, true);
      assert.equal(result.interactions.find.selection, result.interactions.find.token);
      assert.ok(result.interactions.find.visible && result.interactions.find.targetHeight > 0
        && result.interactions.find.targetTop < result.interactions.find.viewportHeight
        && result.interactions.find.targetTop + result.interactions.find.targetHeight > 0);
      assert.ok(result.interactions.selection.includesFirst && result.interactions.selection.includesLast);
      assert.equal(result.interactions.sourceLink.hrefBefore, result.interactions.sourceLink.hrefAfter);
      assert.equal(result.interactions.sourceLink.focused, true);
      const translatedLink = page.locator('[data-long-required]').nth(farIndex).locator(`${owned} a`).first();
      result.interactions.translatedLink = {available: await translatedLink.count() > 0};
      assert.equal(result.interactions.translatedLink.available, true, `${spec.id}: inline-code skeleton fixture did not preserve a translated link`);
      if (result.interactions.translatedLink.available) {
        await page.evaluate(() => scrollTo({top: 0, behavior: 'instant'}));
        await page.waitForTimeout(120);
        result.interactions.translatedLink.beforeFocus = await translatedLink.evaluate(node => {
          const wrapper = node.closest('.fluent-read-bilingual-content'), rect = wrapper.getBoundingClientRect();
          return {offscreen: rect.top >= innerHeight || rect.bottom <= 0, contained: wrapper.getAttribute('data-fr-rendering-contained') === 'true',
            visible: wrapper.checkVisibility({contentVisibilityAuto: true})};
        });
        assert.ok(result.interactions.translatedLink.beforeFocus.offscreen && result.interactions.translatedLink.beforeFocus.contained);
        await translatedLink.evaluate(node => node.focus({preventScroll: false}));
        const hrefBefore = await translatedLink.getAttribute('href');
        const focus = await translatedLink.evaluate(node => {
          const wrapper = node.closest('.fluent-read-bilingual-content'), rect = wrapper.getBoundingClientRect();
          return {focused: document.activeElement === node, visible: wrapper.checkVisibility({contentVisibilityAuto: true}),
            inViewport: rect.top < innerHeight && rect.bottom > 0};
        });
        assert.ok(focus.focused && focus.visible && focus.inViewport);
        assert.equal(hrefBefore, result.interactions.sourceLink.hrefBefore);
        await page.keyboard.press('Tab');
        assert.equal(await translatedLink.getAttribute('href'), hrefBefore);
        Object.assign(result.interactions.translatedLink, focus, {href: hrefBefore,
          tabReachedAnotherElement: await translatedLink.evaluate(node => document.activeElement !== node)});
        assert.equal(result.interactions.translatedLink.tabReachedAnotherElement, true);
      }
      await page.evaluate(() => scrollTo({top: 0, behavior: 'instant'}));
      await page.waitForTimeout(100);
      const ax = await cdp.send('Accessibility.getFullAXTree');
      const names = ax.nodes.filter(node => !node.ignored).map(node => node.name?.value || '').join('\n');
      result.accessibility = {nodeCount: ax.nodes.length, offscreenToken: result.interactions.find.token, containsOffscreenTranslation: names.includes(result.interactions.find.token)};
      assert.equal(result.accessibility.containsOffscreenTranslation, true, `${spec.id}: AX tree lost offscreen translated text`);
      save(); await assertSources(false);

      result.resizeChecks = [];
      for (const changed of [false, true]) {
        await beginPhase(changed ? 'resize-large-font' : 'resize-original-font');
        await page.setViewportSize(changed ? {width: 850, height: 780} : {width: 1280, height: 900});
        await page.evaluate(large => { document.body.style.fontSize = large ? '23px' : '18px'; }, changed);
        await page.evaluate(index => document.querySelectorAll('[data-long-required]')[index].scrollIntoView({block: 'center', behavior: 'instant'}), farIndex);
        await page.waitForTimeout(250);
        const measurement = await page.evaluate(async index => {
          const source = document.querySelectorAll('[data-long-required]')[index];
          const wrapper = source.querySelector('.fluent-read-bilingual-content');
          const originalHtml = wrapper.outerHTML, originalInnerHtml = wrapper.innerHTML;
          const originalControl = document.documentElement.getAttribute('data-long-render-control');
          const read = () => {
            const rect = wrapper.getBoundingClientRect();
            const sourceRect = source.getBoundingClientRect();
            return {height: rect.height, wrapperWidth: rect.width, left: rect.left, top: rect.top,
              sourceLeft: sourceRect.left, sourceTop: sourceRect.top, scrollY, documentTop: rect.top + scrollY,
              visible: wrapper.checkVisibility({contentVisibilityAuto: true}), intrinsicBlockSize: getComputedStyle(wrapper).containIntrinsicBlockSize};
          };
          const optimized = read();
          document.documentElement.setAttribute('data-long-render-control', 'visible');
          const visibleControl = read();
          const sameNodeDuringControl = source.querySelector('.fluent-read-bilingual-content') === wrapper && wrapper.isConnected;
          const sameInnerHtmlDuringControl = wrapper.innerHTML === originalInnerHtml;
          if (originalControl === null) document.documentElement.removeAttribute('data-long-render-control');
          else document.documentElement.setAttribute('data-long-render-control', originalControl);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return {width: innerWidth, fontSize: getComputedStyle(document.body).fontSize, optimized, visibleControl,
            integrity: {sameNodeDuringControl, sameInnerHtmlDuringControl, exactOuterHtmlAfterRestore: wrapper.outerHTML === originalHtml}};
        }, farIndex);
        result.resizeChecks.push(measurement); save();
        assert.ok(measurement.optimized.visible && measurement.optimized.height > 0 && measurement.optimized.wrapperWidth > 0);
        assert.ok(Object.values(measurement.integrity).every(Boolean), `${spec.id}: resize control rebuilt or changed the translated DOM`);
        assertResizeGeometryEquivalent(measurement, spec.id);
        save(); await assertSources(false);
      }
      await page.setViewportSize({width: 1280, height: 900});
      await page.evaluate(() => { document.body.style.removeProperty('font-size'); scrollTo({top: 0, behavior: 'instant'}); });
      await page.waitForTimeout(200);

      await beginPhase('print');
      await page.emulateMedia({media: 'print'});
      result.print = await page.evaluate(() => ({
        media: matchMedia('print').matches,
        wrappers: [...document.querySelectorAll('[data-long-required] .fluent-read-bilingual-content')].map(node => ({
          height: node.getBoundingClientRect().height, contentVisibility: getComputedStyle(node).contentVisibility,
          textPresent: node.textContent.includes('长页译文'),
        })),
      }));
      assert.equal(result.print.media, true);
      assert.equal(result.print.wrappers.length, spec.requiredCount);
      assert.ok(result.print.wrappers.every(wrapper => wrapper.height > 0 && wrapper.textPresent && wrapper.contentVisibility === 'visible'), `${spec.id}: print did not expose all translated blocks`);
      await page.emulateMedia({media: 'screen'});
      save(); await assertSources(false);

      // The authored root flag changes computed CV/CIS, never wrapper inline attributes.
      await page.evaluate(() => {
        __longMock.renderControls = [...document.querySelectorAll('.fluent-read-bilingual-content')].map(node => ({node,
          originalHtml: node.outerHTML, originalInnerHtml: node.innerHTML}));
      });
      const beforeRequests = await worker.evaluate(() => __longMockRequests.length);
      const beforeText = await page.locator(owned).allTextContents();
      const measureFloatGeometry = async () => page.evaluate(async () => {
        const source = document.querySelector('[data-long-float-case] [data-long-required]');
        if (!source) return null;
        source.scrollIntoView({block: 'center', behavior: 'instant'});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const wrapper = source.querySelector('.fluent-read-bilingual-content');
        const wrapperRect = wrapper.getBoundingClientRect();
        const sourceRect = source.getBoundingClientRect();
        const text = [...source.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
        const range = document.createRange(); range.selectNodeContents(text);
        return {contentVisibility: getComputedStyle(wrapper).contentVisibility,
          wrapper: {width: wrapperRect.width, height: wrapperRect.height, left: wrapperRect.left - sourceRect.left, top: wrapperRect.top - sourceRect.top},
          sourceLines: [...range.getClientRects()].map(rect => ({width: rect.width, height: rect.height, left: rect.left - sourceRect.left, top: rect.top - sourceRect.top}))};
      });
      const floatAuto = await measureFloatGeometry();
      await page.evaluate(() => document.documentElement.setAttribute('data-long-render-control', 'visible'));
      const floatControl = await measureFloatGeometry();
      await page.evaluate(() => document.documentElement.removeAttribute('data-long-render-control'));
      if (floatAuto) {
        result.floatLayout = {auto: floatAuto, visibleControl: floatControl};
        assert.equal(floatAuto.sourceLines.length, floatControl.sourceLines.length, 'CV changed source line wrapping beside a float');
        for (const [index, line] of floatAuto.sourceLines.entries()) for (const key of ['width', 'height', 'left', 'top']) {
          assert.ok(Math.abs(line[key] - floatControl.sourceLines[index][key]) <= .5, `CV moved original float-adjacent text (${index}/${key})`);
        }
        for (const key of ['width', 'height', 'left', 'top']) assert.ok(Math.abs(floatAuto.wrapper[key] - floatControl.wrapper[key]) <= .5,
          `CV changed translated float-adjacent layout (${key}): ${floatAuto.wrapper[key]} vs ${floatControl.wrapper[key]}`);
      }
      const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));
      const renderingPass = async (control, sample) => {
        const phase = `render-${control}-${sample}`;
        await page.evaluate(enabled => {
          if (enabled) document.documentElement.removeAttribute('data-long-render-control');
          else document.documentElement.setAttribute('data-long-render-control', 'visible');
          scrollTo({top: 0, behavior: 'instant'});
        }, control === 'auto');
        await page.waitForTimeout(120);
        await beginPhase(phase);
        const before = await metrics();
        const traversal = await page.evaluate(async () => {
          const start = performance.now();
          const fractions = [0, .1, .2, .3, .4, .5, .6, .7, .8, .9, 1, .8, .6, .4, .2, 0];
          for (const fraction of fractions) {
            scrollTo({top: fraction * Math.max(0, document.documentElement.scrollHeight - innerHeight), behavior: 'instant'});
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          }
          return {durationMs: performance.now() - start, steps: fractions.length};
        });
        const after = await metrics();
        const state = await page.evaluate(name => ({
          frames: __longMock.frames.filter(frame => frame.phase === name).map(frame => frame.duration),
          longTasks: __longMock.longTasks.filter(task => task.phase === name),
          autoEvents: __longMock.autoEvents.filter(event => event.phase === name),
          integrity: {
            sameNodes: [...document.querySelectorAll('.fluent-read-bilingual-content')].length === __longMock.renderControls.length
              && [...document.querySelectorAll('.fluent-read-bilingual-content')].every((node, index) => node === __longMock.renderControls[index].node),
            exactOuterHtml: __longMock.renderControls.every(item => item.node.isConnected && item.node.outerHTML === item.originalHtml),
          },
        }), phase);
        assert.ok(Object.values(state.integrity).every(Boolean), 'Rendering control triggered a cached DOM repair');
        const item = {control, sample, ...traversal, frameCount: state.frames.length,
          rafMedianMs: quantile(state.frames, .5), rafP95Ms: quantile(state.frames, .95), rafMaxMs: Math.max(0, ...state.frames),
          longTasks: state.longTasks, skippedEvents: state.autoEvents.filter(event => event.skipped).length, integrity: state.integrity,
          metrics: Object.fromEntries(['LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'LayoutCount', 'RecalcStyleCount'].map(key => [key, (after[key] || 0) - (before[key] || 0)]))};
        return item;
      };
      // Warm both controls, then alternate order to limit warm-cache/order bias.
      await renderingPass('auto', -1); await renderingPass('visible-control', -1);
      for (let sample = 0; sample < args.samples; sample++) for (const control of sample % 2 ? ['visible-control', 'auto'] : ['auto', 'visible-control']) {
        result.renderingSamples.push(await renderingPass(control, sample)); save();
      }
      result.renderingIntegrity = await page.evaluate(() => {
        const wrappers = [...document.querySelectorAll('.fluent-read-bilingual-content')];
        const sameNodes = wrappers.length === __longMock.renderControls.length && wrappers.every((node, index) => node === __longMock.renderControls[index].node);
        const sameInnerHtml = __longMock.renderControls.every(item => item.node.innerHTML === item.originalInnerHtml);
        document.documentElement.removeAttribute('data-long-render-control');
        const exactOuterHtmlAfterRestore = __longMock.renderControls.every(item => item.node.isConnected && item.node.outerHTML === item.originalHtml);
        delete __longMock.renderControls;
        return {sameNodes, sameInnerHtml, exactOuterHtmlAfterRestore};
      });
      assert.ok(Object.values(result.renderingIntegrity).every(Boolean), 'Rendering control rebuilt or changed the translated DOM');
      assert.equal(await worker.evaluate(() => __longMockRequests.length), beforeRequests, 'Rendering control unexpectedly caused provider work');
      assert.deepEqual(await page.locator(owned).allTextContents(), beforeText, 'Rendering control changed translated content');
      result.renderingSummary = ['auto', 'visible-control'].map(control => {
        const samples = result.renderingSamples.filter(item => item.control === control);
        return {control, samples: samples.length, traversalMedianMs: quantile(samples.map(item => item.durationMs), .5),
          rafP95MedianMs: quantile(samples.map(item => item.rafP95Ms), .5), layoutMedianMs: quantile(samples.map(item => item.metrics.LayoutDuration * 1000), .5),
          styleMedianMs: quantile(samples.map(item => item.metrics.RecalcStyleDuration * 1000), .5), totalLongTasks: samples.flatMap(item => item.longTasks).length};
      });
      await assertSources(false);

      result.appearanceChecks = [];
      const appearanceCheck = async (name, value, expectClear) => {
        await beginPhase(name);
        const requestCountBefore = await worker.evaluate(() => __longMockRequests.length);
        const before = await page.evaluate(() => {
          __longMock.appearanceWrappers = [...document.querySelectorAll('.fluent-read-bilingual-content')];
          return {count: __longMock.appearanceWrappers.length,
            contained: __longMock.appearanceWrappers.filter(node => node.getAttribute('data-fr-rendering-contained') === 'true').length,
            texts: __longMock.appearanceWrappers.map(node => node.textContent)};
        });
        await persistAppearance(value);
        if (expectClear) await page.waitForFunction(() => !document.querySelector('.fluent-read-bilingual-content[data-fr-rendering-contained="true"]'), undefined, {timeout: 5000});
        await page.waitForTimeout(300);
        const after = await page.evaluate(() => {
          const wrappers = [...document.querySelectorAll('.fluent-read-bilingual-content')];
          return {count: wrappers.length, contained: wrappers.filter(node => node.getAttribute('data-fr-rendering-contained') === 'true').length,
            sameNodes: wrappers.length === __longMock.appearanceWrappers.length && wrappers.every((node, index) => node === __longMock.appearanceWrappers[index]),
            texts: wrappers.map(node => node.textContent)};
        });
        assert.equal(after.count, before.count);
        assert.equal(after.sameNodes, true, 'Appearance update replaced translated nodes');
        assert.deepEqual(after.texts, before.texts);
        assert.equal(after.contained, expectClear ? 0 : before.contained, 'Appearance containment invalidation mismatch');
        const newRequestCount = await worker.evaluate(() => __longMockRequests.length) - requestCountBefore;
        assert.equal(newRequestCount, 0, 'Appearance update unexpectedly translated text again');
        result.appearanceChecks.push({name, beforeContained: before.contained, afterContained: after.contained, wrapperCount: after.count, sameNodes: after.sameNodes, newRequestCount});
        save(); await assertSources(false);
      };
      await appearanceCheck('same-default-appearance', defaultAppearance, false);
      const changedAppearance = {...defaultAppearance, fontScale: 135, lineHeight: 1.7};
      await appearanceCheck('changed-appearance', changedAppearance, true);

      for (const phase of ['restore', 'retranslate']) {
        await page.evaluate(() => scrollTo({top: 0, behavior: 'instant'}));
        await beginPhase(phase);
        await page.keyboard.press('Alt+t');
        if (phase === 'restore') await page.waitForFunction(selector => !document.querySelector(selector), owned, {timeout: 20000});
        else await page.waitForFunction(selector => [...document.querySelectorAll('[data-long-required]')].every(node => node.querySelectorAll(selector).length === 1), owned, {timeout: 90000});
        await waitForTranslationIdle(page, 10000, `${spec.id}-${phase}`, 10000);
        const state = await finishPhase(phase);
        if (phase === 'restore') {
          assert.equal(state.wrapperCount, 0); assert.equal(state.requestCount, 0); await assertSources(true);
          for (const opening of state.openingCoverage) assert.equal(opening.count, 0);
        } else { assertCoverage(state); await assertSources(false); assert.ok(state.autoCount >= 10); }
      }
      await appearanceCheck('same-new-appearance', changedAppearance, false);
      result.toggleCounts = result.phases.filter(item => ['translate', 'restore', 'retranslate'].includes(item.phase)).map(item => item.requiredCoverage[0].count);
      assert.deepEqual(result.toggleCounts, [1, 0, 1]);
      await page.screenshot({path: path.join(args.artifactsDir, `${spec.id}-retranslated-top.png`), caret: 'initial'});
      result.requests = await worker.evaluate(prefix => __longMockRequests.filter(request => request.stage.startsWith(prefix)), `${spec.id}:`);
      assert.deepEqual(result.pageErrors, []);
      await page.evaluate(() => { __longMock.observing = false; });
      result.passed = true; save();
      await cdp.detach(); cdpSessions.delete(cdp);
      // Leave completed tabs in the owned session; closing its active tab can focus another window.
      page = null;
      console.log(JSON.stringify({case: spec.id, passed: true, requiredCount: spec.requiredCount, wrappers: translated.wrapperCount,
        autoCount: translated.autoCount, skippedCount: translated.skippedCount, toggleCounts: result.toggleCounts, rendering: result.renderingSummary}));
    }
    assert.deepEqual(report.errors, []);
    // Favicon requests are harmless blocked fixture traffic, never translated or fetched.
    assert.ok(report.unexpectedNetwork.every(item => /\/favicon\.ico$/u.test(item.url)), JSON.stringify(report.unexpectedNetwork));
    report.passed = true;
  } catch (error) {
    primaryError = error; report.passed = false; report.error = String(error.stack || error);
    if (page) {
      const last = report.cases.at(-1);
      if (last) last.guardAttributeChanges = await page.evaluate(() => window.__longMock?.guardAttributeChanges || []).catch(() => []);
      await page.screenshot({path: path.join(args.artifactsDir, 'failure.png'), caret: 'initial'}).catch(() => {});
      await page.content().then(html => fs.writeFileSync(path.join(args.artifactsDir, 'failure.html'), html)).catch(() => {});
      const worker = session?.context.serviceWorkers()[0];
      if (worker) report.requestsOnFailure = await worker.evaluate(() => globalThis.__longMockRequests || []).catch(() => []);
    }
    throw error;
  } finally {
    const cleanupErrors = [];
    const cleanup = async (resource, release) => {
      try { await release(); } catch (error) {
        cleanupErrors.push(error); (report.cleanupErrors ||= []).push({resource, error: String(error.stack || error)});
        report.passed = false; process.exitCode = 1; console.error(`Cleanup failed (${resource}):`, error);
      }
    };
    for (const cdp of cdpSessions) await cleanup('CDP session', () => cdp.detach());
    let browserClosed = false;
    await cleanup('browser', async () => { if (session) { await session.close(); browserClosed = true; } });
    await cleanup('profile', () => {
      if (browserClosed) fs.rmSync(profileDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
      else if (!launchAttempted) try { fs.rmdirSync(profileDir); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
      else report.retainedProfile = profileDir;
    });
    await cleanup('report', save);
    if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
  }
  return report;
}

module.exports = {buildLongPageFixture, parseArgs, quantile, installLongPageMockTransport, assertResizeGeometryEquivalent};
if (require.main === module) main(parseArgs(process.argv.slice(2))).catch(error => { console.error(error); process.exitCode = 1; });
