#!/usr/bin/env node
'use strict';

// 生产悬浮翻译专项：真实 CDP 键鼠、临时后台 Edge、本地固定 transport。
// 覆盖高频移动、末点归属、快速重复触发、离开页面、DOM 换代与失败重试。
// --baseline 仅把行为差异记为 observations；基础注入、真实事件与清理仍严格断言。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {startTranslationFixtureServer, installTranslationFixtureOnWorker} = require('../run-full-page-translation-test.cjs');
const {guardBrowserClose} = require('./owned-browser-close.cjs');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-hover-reliability'));
const baseline = process.argv.includes('--baseline');
const allCases = ['pointer-performance', 'latest-point', 'repeat-loading', 'viewport-leave', 'hidden-tab', 'route-change', 'dom-replacement', 'failure-retry'];
const selectedCases = arg('cases', allCases.join(',')).split(',').filter(Boolean);
assert.ok(selectedCases.length && selectedCases.every(name => allCases.includes(name)), `--cases must use: ${allCases.join(',')}`);
const {chromium} = require(path.join(arg('playwright-root', path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules')), 'playwright'));
// 使用 Playwright 公开的 noDefaults CDP 选项保留浏览器原生 focus/visibility。
// 只代理本脚本的连接，不改变共享 helper 或 Playwright 的模块对象。
const nativeFocusChromium = {
  connectOverCDP: (endpoint, options) => chromium.connectOverCDP(endpoint, {...options, noDefaults: true}),
};
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(arg('focus-safe-helper', path.join(__dirname, 'focus-safe-browser.cjs')));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {
  baseline, extensionDir, selectedCases, profileMode: 'new-temporary-profile',
  cdpDefaultOverrides: 'disabled-for-native-visibility-and-focus',
  evidence: 'Production extension; trusted Playwright/CDP gestures; local deterministic Microsoft transport, no live provider claims',
  buildSha256: hash(path.join(extensionDir, 'content-scripts/content.js')),
  cases: [], consoleErrors: [], observations: [], unexpectedNetworkRequests: [],
};
fs.mkdirSync(artifactsDir, {recursive: true});
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-hover-reliability-'));
const source = {
  alpha: 'Alpha paragraph keeps the original reading context while the pointer settles and translation appears only once.',
  beta: 'Beta paragraph should stay unchanged when the reader is pointing at another paragraph nearby.',
  gamma: 'Gamma paragraph is the final reading target after a fast pointer move across several source paragraphs.',
};
const html = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Hover reliability fixture</title>' +
  '<style>body{font:16px/1.7 system-ui;margin:42px}main{max-width:780px}p{margin:25px 0}#probe{position:fixed;right:20px;top:20px;z-index:100000}#host-input{position:fixed;right:20px;top:62px;width:235px;z-index:100000}</style>' +
  '<button id="probe" translate="no">Host click</button><input id="host-input" aria-label="Host input" value="Original host input"><main>' +
  Object.entries(source).map(([id, value]) => `<p id="${id}">${id === 'beta' ? value.replace('nearby', '<a id="host-link" href="#host-link-destination">nearby</a>') : value}</p>`).join('') +
  '</main><script>window.probeClicks=0;document.querySelector("#probe").onclick=()=>window.probeClicks++;' +
  'window.hostEvents=[];for(const type of ["mouseleave","mouseout","pointerleave","blur","visibilitychange","keydown","keyup"])' +
  '(["blur","keydown","keyup"].includes(type)?window:document).addEventListener(type,event=>window.hostEvents.push({type,key:event.key,trusted:event.isTrusted,relatedNull:event.relatedTarget==null,visibility:document.visibilityState}),true);</script></html>';
const server = http.createServer((_request, response) => {
  response.writeHead(200, {'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store'});
  response.end(html);
});
let launched, provider, setup, context;
let launchAttempted = false, browserGuarded = false, sequence = 0;

function check(condition, message, result) {
  const observation = {case: result.id, passed: Boolean(condition), message};
  report.observations.push(observation);
  (result.checks ||= []).push(observation);
  if (!baseline) assert.ok(condition, `${result.id}: ${message}`);
}

async function patchConfig(patch) {
  await setup.evaluate(async ({patch, sequence}) => {
    const current = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
    const saved = await chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: patch,
      expected: Object.fromEntries(Object.keys(patch).map(key => [key, current.value[key]])),
      clientId: 'hover-reliability-fixture', sequence, baseRevision: current.value.__fluentConfigRevision || 0});
    if (!saved?.success) throw new Error('Fixture configuration failed');
  }, {patch, sequence: ++sequence});
}

async function pageFor(id, delay = 0) {
  await patchConfig({on: true, hotkey: 'Control', customHotkey: '', mouseHoverTranslationDelay: delay,
    selectionTranslatorMode: 'disabled', quickTranslationProfiles: [], useCache: false});
  const page = await newPageWithoutForeground(context);
  page.on('pageerror', error => report.consoleErrors.push({case: id, error: error.message}));
  await page.goto(`http://127.0.0.1:${server.address().port}/${id}`, {waitUntil: 'domcontentloaded'});
  await page.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
  await activateExtensionTabWithoutForeground(context, page);
  await page.waitForTimeout(250);
  return page;
}

async function sourcePoint(page, id) {
  return page.evaluate(id => {
    const owner = document.getElementById(id);
    const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement.closest('[data-fr-translation-owned="true"]') || node.length < 12) continue;
      const range = document.createRange(); range.setStart(node, 7); range.setEnd(node, 8);
      owner.scrollIntoView({block: 'center'});
      const rect = range.getBoundingClientRect();
      return {x: rect.left + Math.min(3, rect.width / 2), y: rect.top + Math.min(8, rect.height / 2)};
    }
    throw new Error(`No source point for ${id}`);
  }, id);
}

async function moveTo(page, id) {
  const point = await sourcePoint(page, id);
  await page.mouse.move(point.x, point.y);
  return point;
}

async function tap(page, id) {
  const point = await moveTo(page, id);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.down('Control'); await page.keyboard.up('Control');
}

async function wrappers(page) {
  return page.evaluate(() => Object.fromEntries(['alpha', 'beta', 'gamma'].map(id => [id,
    document.getElementById(id)?.querySelectorAll('.fluent-read-bilingual-content').length || 0])));
}

async function waitTranslation(page, id) {
  await page.locator(`#${id} .fluent-read-bilingual-content`).waitFor({state: 'attached', timeout: 15000});
  const value = await page.locator(`#${id} .fluent-read-bilingual-content`).innerText();
  assert.match(value, /[\u4e00-\u9fff]/, 'Deterministic translation includes Chinese text');
  return value;
}

async function waitRequests(count) {
  const deadline = Date.now() + 15000;
  while (provider.requestCount() < count) {
    if (Date.now() > deadline) throw new Error(`Expected ${count} upstream requests; saw ${provider.requestCount()}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function startPhase(page, name) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));
  await page.evaluate(name => {
    window.__hoverPhase = {name, started: performance.now(), tasks: [], ticks: []};
    window.__hoverObserver = new PerformanceObserver(list => window.__hoverPhase.tasks.push(...list.getEntries().map(entry => entry.duration)));
    window.__hoverObserver.observe({type: 'longtask', buffered: false});
    let previous = performance.now();
    window.__hoverTimer = setInterval(() => {const now = performance.now(); window.__hoverPhase.ticks.push(now - previous); previous = now;}, 20);
  }, name);
  return {cdp, before};
}

async function finishPhase(page, phase) {
  const result = await page.evaluate(() => {
    clearInterval(window.__hoverTimer); window.__hoverObserver.disconnect();
    const state = window.__hoverPhase, ticks = [...state.ticks].sort((a, b) => a - b);
    return {name: state.name, elapsedMs: performance.now() - state.started, longTasksMs: state.tasks,
      totalBlockingMs: state.tasks.reduce((sum, duration) => sum + Math.max(0, duration - 50), 0),
      maxHeartbeatGapMs: Math.max(0, ...ticks), p95HeartbeatGapMs: ticks[Math.floor(ticks.length * 0.95)] || 0};
  });
  const after = Object.fromEntries((await phase.cdp.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));
  result.metrics = Object.fromEntries(['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'].map(key => [key, after[key] - phase.before[key]]));
  await phase.cdp.detach(); return result;
}

async function savePage(page, result) {
  result.wrappers = await wrappers(page);
  result.hostEvents = await page.evaluate(() => window.hostEvents);
  result.url = page.url();
  result.originalSource = await page.evaluate(() => Object.fromEntries(['alpha', 'beta', 'gamma'].map(id => {
    const owner = document.getElementById(id)?.cloneNode(true);
    owner?.querySelectorAll('[data-fr-translation-owned="true"]').forEach(node => node.remove());
    return [id, owner?.textContent];
  })));
  result.nestedWrappers = await page.locator('.fluent-read-bilingual-content .fluent-read-bilingual-content').count();
  check(result.nestedWrappers === 0, 'No nested translation wrappers', result);
  check(Object.values(result.wrappers).every(count => count <= 1), 'At most one translation per owner', result);
  const expectedSource = {...source, ...(result.newSource ? {alpha: result.newSource} : {})};
  check(Object.entries(expectedSource).every(([id, value]) => result.originalSource[id] === value), 'Original source remains exact', result);
  await page.screenshot({path: path.join(artifactsDir, `${result.id}.png`)});
  fs.writeFileSync(path.join(artifactsDir, `${result.id}.html`), await page.content());
  const input = page.locator('#host-input');
  check(await input.inputValue() === 'Original host input', 'Hover translation preserves native input value', result);
  await input.click();
  const platform = await page.evaluate(() => navigator.platform);
  await page.keyboard.press(/Mac/.test(platform) ? 'Meta+a' : 'Control+a');
  await page.keyboard.type('Host input remains editable');
  check(await input.inputValue() === 'Host input remains editable', 'Native input remains editable with platform select-all', result);
  const requestCount = provider.requestCount();
  await page.keyboard.down('Control'); await page.keyboard.up('Control'); await page.waitForTimeout(80);
  check(provider.requestCount() === requestCount && await input.locator('.fluent-read-bilingual-content').count() === 0, 'Hover shortcut inside input creates no translation work', result);
  const link = page.locator('#host-link');
  check(await link.getAttribute('href') === '#host-link-destination', 'Source link keeps its original href', result);
  await link.click();
  await page.waitForURL('**#host-link-destination');
  result.hostLinkURLAfterClick = page.url();
  check(new URL(page.url()).hash === '#host-link-destination', 'Native source link click still navigates', result);
}

async function runCase(id) {
  const result = {id, requestsBefore: provider.requestCount()}; report.cases.push(result);
  const page = await pageFor(id, ['latest-point', 'viewport-leave', 'route-change'].includes(id) ? 350 : id === 'hidden-tab' ? 1200 : 0);
  try {
    if (id === 'pointer-performance') {
      const point = await moveTo(page, 'alpha');
      result.phases = [];
      for (const enabled of [false, true]) {
        await patchConfig({on: enabled}); await page.waitForTimeout(100);
        const phase = await startPhase(page, enabled ? 'idle-enabled' : 'idle-disabled');
        for (let index = 0; index < 320; index++) await page.mouse.move(point.x + (index % 5), point.y + (index % 2));
        result.phases.push(await finishPhase(page, phase));
      }
      await tap(page, 'alpha'); await waitTranslation(page, 'alpha');
      const before = provider.requestCount(), phase = await startPhase(page, 'continuous-translated');
      const translatedPoint = await moveTo(page, 'alpha');
      await page.keyboard.down('Control');
      try {for (let index = 0; index < 320; index++) await page.mouse.move(translatedPoint.x + (index % 5), translatedPoint.y + (index % 2));}
      finally {await page.keyboard.up('Control');}
      await page.locator('#probe').click(); await page.waitForTimeout(100);
      result.phases.push(await finishPhase(page, phase));
      result.extraContinuousRequests = provider.requestCount() - before;
      check(result.extraContinuousRequests === 0, 'Continuous same-owner movement reuses settled translation', result);
      check((await wrappers(page)).alpha === 1, 'Continuous movement keeps exactly one translation', result);
      check(await page.evaluate(() => window.probeClicks === 1), 'Host click remains responsive', result);
    } else if (id === 'latest-point') {
      await moveTo(page, 'alpha'); await page.keyboard.down('Control');
      try {
        for (const target of ['alpha', 'beta', 'gamma']) {
          const point = await moveTo(page, target);
          for (let step = 0; step < 4; step++) {await page.mouse.move(point.x + step, point.y); await page.waitForTimeout(25);}
        }
        await waitTranslation(page, 'gamma');
      } finally {await page.keyboard.up('Control');}
      result.counts = await wrappers(page);
      check(result.counts.alpha === 0 && result.counts.beta === 0 && result.counts.gamma === 1, 'Only final settled paragraph translates', result);
      check(provider.requestCount() - result.requestsBefore === 1, 'Only final settled paragraph reaches provider', result);
    } else if (id === 'repeat-loading') {
      await tap(page, 'alpha'); await waitRequests(result.requestsBefore + 1);
      await tap(page, 'alpha'); await tap(page, 'alpha');
      await waitTranslation(page, 'alpha'); await page.waitForTimeout(100);
      check(provider.requestCount() - result.requestsBefore === 1, 'Rapid repeat while loading sends one upstream request', result);
      check((await wrappers(page)).alpha === 1, 'Rapid repeat creates one translation', result);
      await tap(page, 'alpha');
      await page.waitForFunction(() => !document.querySelector('#alpha .fluent-read-bilingual-content'));
      await tap(page, 'alpha'); await waitTranslation(page, 'alpha');
      const requests = provider.requestCount() - result.requestsBefore;
      check(requests >= 1 && requests <= 2 && (await wrappers(page)).alpha === 1, 'Explicit restore and retranslate remains available without duplicate work', result);
    } else if (id === 'viewport-leave') {
      const point = await moveTo(page, 'alpha'); await page.keyboard.down('Control');
      await page.mouse.move(point.x + 1, point.y); await page.mouse.move(-20, -20);
      await page.keyboard.up('Control'); await page.waitForTimeout(650);
      result.leftViewport = await page.evaluate(() => window.hostEvents.some(event => event.trusted && event.relatedNull && ['mouseout', 'mouseleave', 'pointerleave'].includes(event.type)));
      assert.equal(result.leftViewport, true, 'CDP input really leaves the document');
      check(provider.requestCount() === result.requestsBefore, 'Leaving viewport cancels delayed hover', result);
      check(Object.values(await wrappers(page)).every(count => count === 0), 'No stale-coordinate translation after viewport leave', result);
      await tap(page, 'beta'); await waitTranslation(page, 'beta');
      check((await wrappers(page)).beta === 1, 'Fresh gesture works after pointer re-entry', result);
    } else if (id === 'hidden-tab') {
      const other = await newPageWithoutForeground(context);
      const focusSession = await context.newCDPSession(page);
      try {
        await other.goto(`http://127.0.0.1:${server.address().port}/hidden-tab-other`, {waitUntil: 'domcontentloaded'});
        // Playwright 默认的 focus emulation 会令后台标签仍报告 visible；关闭这层
        // CDP 覆盖才能观察浏览器真实 visibility/blur，不激活 macOS 应用。
        await focusSession.send('Emulation.setFocusEmulationEnabled', {enabled: false});
        result.tabPlacement = await setup.evaluate(async ({pageUrl, otherUrl}) => {
          const tabs = await chrome.tabs.query({});
          const owner = tabs.find(tab => tab.url === pageUrl), other = tabs.find(tab => tab.url === otherUrl);
          if (!owner?.id || !other?.id) throw new Error('Hidden-tab fixture tabs unavailable');
          if (owner.windowId !== other.windowId) await chrome.tabs.move(other.id, {windowId: owner.windowId, index: -1});
          return {windowId: owner.windowId, ownerTabId: owner.id, otherTabId: other.id};
        }, {pageUrl: page.url(), otherUrl: other.url()});
        await activateExtensionTabWithoutForeground(context, page);
        const point = await moveTo(page, 'alpha'); await page.keyboard.down('Control');
        await page.mouse.move(point.x + 1, point.y);
        await activateExtensionTabWithoutForeground(context, other);
        await page.waitForFunction(() => document.visibilityState === 'hidden', undefined, {timeout: 700}).catch(() => {});
        result.hidden = await page.evaluate(() => document.visibilityState === 'hidden');
        assert.equal(result.hidden, true, 'The isolated browser actually hides the pending tab');
        await page.waitForTimeout(1500); await page.keyboard.up('Control');
        check(provider.requestCount() === result.requestsBefore, 'Hidden tab cancels delayed hover without upstream work', result);
        await activateExtensionTabWithoutForeground(context, page); await tap(page, 'beta'); await waitTranslation(page, 'beta');
        check((await wrappers(page)).beta === 1, 'Fresh gesture works after returning to tab', result);
      } finally {
        await focusSession.detach(); await other.close();
      }
    } else if (id === 'route-change') {
      const point = await moveTo(page, 'alpha'); await page.keyboard.down('Control');
      await page.mouse.move(point.x + 1, point.y);
      await page.evaluate(() => history.pushState({}, '', '/route-change-new'));
      await page.keyboard.up('Control'); await page.waitForTimeout(650);
      check(provider.requestCount() === result.requestsBefore, 'SPA route change cancels old delayed hover', result);
      await tap(page, 'beta'); await waitTranslation(page, 'beta');
      check((await wrappers(page)).beta === 1, 'Fresh gesture works on new route', result);
    } else if (id === 'dom-replacement') {
      await tap(page, 'alpha'); await waitRequests(result.requestsBefore + 1);
      const newSource = 'Replacement paragraph belongs to the new host DOM and must never receive a stale translation of the removed source.';
      await page.evaluate(value => {document.getElementById('alpha').outerHTML = `<p id="alpha">${value}</p>`;}, newSource);
      await page.waitForTimeout(650);
      result.newSource = newSource;
      check((await wrappers(page)).alpha === 0, 'Removed owner response does not translate replacement DOM', result);
      await tap(page, 'alpha'); result.translation = await waitTranslation(page, 'alpha');
      check(result.translation.includes(newSource), 'Replacement DOM translates its own current source', result);
      check(!result.translation.includes(source.alpha), 'Removed owner translation never reappears', result);
    } else if (id === 'failure-retry') {
      const failureSource = 'This block link fails once while preserving the source and offering an explicit keyboard accessible retry action.';
      result.newSource = failureSource;
      await page.evaluate(value => {document.getElementById('alpha').textContent = value;}, failureSource);
      await tap(page, 'alpha');
      await page.locator('#alpha .fluent-read-retry-wrapper').waitFor({state: 'attached', timeout: 15000});
      result.failuresBeforeRetry = provider.failureActionAttempts();
      const point = await moveTo(page, 'alpha'); await page.keyboard.down('Control');
      try {for (let index = 0; index < 20; index++) await page.mouse.move(point.x + index % 2, point.y);}
      finally {await page.keyboard.up('Control');}
      await page.waitForTimeout(100);
      check(provider.failureActionAttempts() === result.failuresBeforeRetry, 'Continuous movement does not retry failed request automatically', result);
      const retry = page.locator('#alpha .fluent-read-retry');
      check(await retry.getAttribute('role') === 'button' && await retry.getAttribute('tabindex') === '0', 'Retry remains keyboard accessible', result);
      await retry.focus(); await page.keyboard.press('Enter');
      result.translation = await waitTranslation(page, 'alpha');
      check(provider.failureActionAttempts() === result.failuresBeforeRetry + 1, 'Explicit retry sends one new request', result);
      check(await page.locator('#alpha .fluent-read-retry-wrapper').count() === 0, 'Successful retry clears failure UI', result);
      check(result.translation.includes(failureSource), 'Retry preserves source ownership', result);
    }
    result.requests = provider.requestCount() - result.requestsBefore;
    await savePage(page, result);
  } catch (error) {
    result.failure = error?.stack || String(error);
    result.requestsAtFailure = provider.requestCount() - result.requestsBefore;
    result.hostEventsAtFailure = await page.evaluate(() => window.hostEvents).catch(() => []);
    await page.screenshot({path: path.join(artifactsDir, `${id}-failure.png`)}).catch(() => {});
    fs.writeFileSync(path.join(artifactsDir, `${id}-failure.html`), await page.content().catch(() => ''));
    if (baseline && error?.name === 'TimeoutError') {
      check(false, 'A required translation state did not arrive before the timeout', result);
      return;
    }
    throw error;
  } finally {await page.close();}
}

(async () => {
  try {
    await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
    provider = await startTranslationFixtureServer(report.unexpectedNetworkRequests, 180);
    launchAttempted = true;
    launched = await launchFocusSafePersistentContext({chromium: nativeFocusChromium, profileDir,
      browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      headless: false, background: true, displayTarget: arg('display', 'secondary'), viewport: {width: 1280, height: 900},
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    guardBrowserClose(launched, profileDir); browserGuarded = true; context = launched.context;
    report.launchMode = launched.launchMode; report.focusPolicy = launched.focusPolicy;
    report.windowPlacement = launched.windowPlacement;
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
    assert.equal(typeof manifest.key, 'string', 'Production fixture needs the manifest public identity key');
    const extensionId = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex')
      .slice(0, 32).replace(/[0-9a-f]/g, character => String.fromCharCode(97 + parseInt(character, 16)));
    setup = await newPageWithoutForeground(context);
    await setup.goto(`chrome-extension://${extensionId}/icon/128.png`);
    assert.equal(await setup.evaluate(() => chrome.runtime.getManifest().name), manifest.name, 'Exact built extension owns the fixture page');
    const workerReady = context.serviceWorkers().find(worker => new URL(worker.url()).host === extensionId)
      || context.waitForEvent('serviceworker', {predicate: worker => new URL(worker.url()).host === extensionId});
    const [worker] = await Promise.all([
      workerReady,
      setup.evaluate(async () => {await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});}),
    ]);
    assert.equal(new URL(worker.url()).host, extensionId, 'Exact built extension owns the transport worker');
    await installTranslationFixtureOnWorker(worker, {translationUrl: provider.translationUrl, blockedUrl: provider.blockedUrl});
    await patchConfig({on: true, service: 'microsoft', hoverTranslationService: 'microsoft', from: 'auto', to: 'zh-Hans', display: 1,
      translationScope: 'content', longParagraphLineBreak: false, uiLanguageSetupCompleted: true, uiLanguage: 'zh-CN'});
    for (const id of selectedCases) {
      await runCase(id);
      fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
      console.log(`${id}: ${report.cases.at(-1).checks?.filter(check => !check.passed).length || 0} failed observations`);
    }
    assert.deepEqual(report.consoleErrors, [], 'Fixture must not produce runtime errors');
    assert.deepEqual(report.unexpectedNetworkRequests, [], 'Fixture must not contact external providers');
    assert.equal(hash(path.join(extensionDir, 'content-scripts/content.js')), report.buildSha256, 'Build remained frozen during evidence');
    report.ok = true;
  } catch (error) {
    report.ok = false; report.failure = error?.stack || String(error); process.exitCode = 1; console.error(error);
  } finally {
    const cleanupErrors = [];
    const cleanup = async (resource, action) => {try {await action();} catch (error) {cleanupErrors.push({resource, error: String(error?.stack || error)}); process.exitCode = 1; report.ok = false;}};
    let browserClosed = false;
    await cleanup('browser', async () => {if (browserGuarded) {await launched.close(); browserClosed = true;}});
    await cleanup('provider', async () => {await provider?.close();});
    await cleanup('fixture', async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
    await cleanup('profile', () => {if (browserClosed || !launchAttempted) fs.rmSync(profileDir, {recursive: true, force: true}); else report.retainedProfile = profileDir;});
    if (cleanupErrors.length) report.cleanupErrors = cleanupErrors;
    report.failedObservations = report.observations.filter(observation => !observation.passed);
    fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ok: report.ok, baseline, cases: report.cases.length, failedObservations: report.failedObservations,
      launchMode: report.launchMode, focusPolicy: report.focusPolicy, windowPlacement: report.windowPlacement,
      artifactsDir, cleanupErrors: report.cleanupErrors}, null, 2));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
